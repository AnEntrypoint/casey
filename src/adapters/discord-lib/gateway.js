import WebSocket from 'ws'
import { emitWithDetachedMedia } from '../webhook-platform-base.js'
import { OP, RECONNECT_MAX_RETRIES, RECONNECT_GIVEUP_RETRY_MS, RECONNECT_BASE_MS, RECONNECT_MAX_MS } from './constants.js'
import { fetchAttachment } from './attachments.js'

export function connect(self, resume = false) {
  const canResume = (resume || self._resumeFromDisk) && !!self._sessionId && !!self._resumeUrl
  const url = canResume ? self._resumeUrl + '/?v=10&encoding=json' : self.gatewayUrl
  if (self._ws) { try { self._ws.removeAllListeners(); self._ws.terminate() } catch {  } }
  const ws = self._ws = new WebSocket(url)
  ws.on('message', (raw) => {
    let p; try { p = JSON.parse(raw.toString()) } catch { return }
    if (p.s != null) { self._seq = p.s; self.sessionStore?.saveSeq?.(p.s) }
    switch (p.op) {
      case OP.HELLO:
        self._retries = 0
        self._acked = true
        startHeartbeat(self, p.d.heartbeat_interval)
        if (canResume) { self._resumeAttempted = true; send(self, { op: OP.RESUME, d: { token: self.token, session_id: self._sessionId, seq: self._seq } }) }
        else identify(self)
        break
      case OP.HEARTBEAT: send(self, { op: OP.HEARTBEAT, d: self._seq }); break
      case OP.HEARTBEAT_ACK: self._acked = true; break
      case OP.RECONNECT:
        try { ws.close(4000, 'server requested reconnect') } catch {  }
        break
      case OP.INVALID_SESSION:
        if (self._resumeAttempted) reportUnresumableGap(self)
        self._resumeAttempted = false
        self._resumeFromDisk = false
        self.sessionStore?.clear?.()
        self._sessionId = null; self._resumeUrl = null; self._seq = null
        clearTimeout(self._invalidSessionTimeout)
        self._invalidSessionTimeout = setTimeout(() => { if (!self._closed) identify(self) }, p.d ? 1000 : 5000)
        break
      case OP.DISPATCH: dispatch(self, p); break
    }
  })
  ws.on('close', () => {
    clearInterval(self._heartbeat)
    scheduleReconnect(self)
  })
  ws.on('error', (e) => { self.log?.error?.('[discord] ws error', e.message); try { ws.terminate() } catch {  } })
}

export function scheduleReconnect(self) {
  if (self._closed || self._reconnecting) return
  if (self._retries >= RECONNECT_MAX_RETRIES) {
    self.log?.error?.(`[discord] reconnect failed after ${RECONNECT_MAX_RETRIES} attempts, retrying in 1 hour`)
    self._reconnecting = true
    self.gatewayUrl = null
    self._reconnectTimeout = setTimeout(() => {
      self._reconnecting = false
      self._retries = 0
      self.start().catch((e) => { self.log?.error?.('[discord] reconnect failed', e.message); scheduleReconnect(self) })
    }, RECONNECT_GIVEUP_RETRY_MS)
    return
  }
  self._reconnecting = true
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** self._retries, RECONNECT_MAX_MS)
  self._retries++
  self.log?.warn?.(`[discord] gateway closed, reconnecting in ${Math.round(delay / 1000)}s (attempt ${self._retries}/${RECONNECT_MAX_RETRIES})`)
  self._reconnectTimeout = setTimeout(() => { self._reconnecting = false; connect(self, true) }, delay)
}

function reportUnresumableGap(self) {
  const downMs = self._resumeStateSavedAt ? Date.now() - self._resumeStateSavedAt : null
  self._resumeStateSavedAt = null
  const note = downMs != null ? `gateway was unresumable after ~${Math.round(downMs / 1000)}s disconnected` : 'gateway session was refused on resume'
  self.log?.warn?.('[discord] RESUME refused; messages sent during the disconnect are not replayable', { downMs })
  try { self.onUnresumableGap?.(note) } catch {  }
}

export function dispatch(self, p) {
  if (p.t === 'READY') {
    if (self._resumeAttempted) reportUnresumableGap(self)
    self._resumeAttempted = false
    self._resumeFromDisk = false
    self._sessionId = p.d?.session_id
    self._resumeUrl = p.d?.resume_gateway_url
    self._botUserId = p.d?.user?.id || null
    self._seq = p.s ?? self._seq
    self.sessionStore?.save?.({ sessionId: self._sessionId, resumeUrl: self._resumeUrl, seq: self._seq, botUserId: self._botUserId })
    self.log?.info?.('[discord] gateway READY', { botUser: p.d?.user?.username || null })
    self.emit('ready', p.d)
    return
  }
  if (p.t === 'RESUMED') {
    self._resumeAttempted = false
    self._resumeFromDisk = false
    self._resumeStateSavedAt = null
    self.sessionStore?.save?.({ sessionId: self._sessionId, resumeUrl: self._resumeUrl, seq: self._seq, botUserId: self._botUserId })
    self.log?.info?.('[discord] session resumed successfully', { botUser: self._botUserId ? 'restored' : 'UNKNOWN' })
    self.emit('ready', null)
    return
  }
  if (p.t === 'MESSAGE_CREATE') {
    const m = p.d
    if (m.author?.bot) {
      const allowedIds = (typeof process !== 'undefined' && process.env && process.env.DISCORD_ALLOWED_BOT_AUTHOR_IDS || '')
        .split(',').map(s => s.trim()).filter(Boolean)
      if (!allowedIds.includes(m.author?.id)) return
    }
    if (m.author?.id && self._botUserId && m.author.id === self._botUserId) return
    const base = { from: m.author?.id, text: m.content || '', id: m.id, raw: m, platform: 'discord' }
    emitWithDetachedMedia(
      (e) => self.emit('message', e),
      base,
      !!m.attachments?.length,
      () => resolveAttachments(self, m.attachments),
    )
    return
  }
}

export async function resolveAttachments(self, attachments) {
  const results = await Promise.allSettled(attachments.map(a => fetchAttachment(self, a)))
  return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value)
}

export function identify(self) {
  send(self, { op: OP.IDENTIFY, d: { token: self.token, intents: self.intents, properties: { os: 'linux', browser: 'casey', device: 'casey' } } })
}

export function startHeartbeat(self, interval) {
  clearInterval(self._heartbeat)
  self._acked = true
  self._heartbeat = setInterval(() => {
    if (!self._acked) { try { self._ws.terminate() } catch {  } return }
    self._acked = false
    send(self, { op: OP.HEARTBEAT, d: self._seq })
  }, interval)
}

export function send(self, obj) { try { self._ws?.send(JSON.stringify(obj)) } catch {} }

