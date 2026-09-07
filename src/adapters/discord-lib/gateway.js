// Gateway WebSocket connect/heartbeat/reconnect/dispatch internals for
// DiscordAdapter. Each export takes the adapter instance (`self`) as first
// argument and is called from discord.js as `gateway.fnName(this, ...)`.
import WebSocket from 'ws'
import { emitWithDetachedMedia } from '../webhook-platform-base.js'
import { OP, RECONNECT_MAX_RETRIES, RECONNECT_GIVEUP_RETRY_MS, RECONNECT_BASE_MS, RECONNECT_MAX_MS } from './constants.js'
import { fetchAttachment } from './attachments.js'

export function connect(self, resume = false) {
  const url = resume && self._resumeUrl ? self._resumeUrl + '/?v=10&encoding=json' : self.gatewayUrl
  // Drop the previous socket's listeners before replacing it so reconnects
  // do not accumulate orphaned 'message'/'close'/'error' handlers over time.
  if (self._ws) { try { self._ws.removeAllListeners(); self._ws.terminate() } catch { /* already gone */ } }
  const ws = self._ws = new WebSocket(url)
  ws.on('message', (raw) => {
    let p; try { p = JSON.parse(raw.toString()) } catch { return }
    if (p.s != null) self._seq = p.s
    switch (p.op) {
      case OP.HELLO:
        self._retries = 0                     // connected: reset backoff
        self._acked = true                     // clear stale state before heartbeat
        startHeartbeat(self, p.d.heartbeat_interval)
        if (resume && self._sessionId) send(self, { op: OP.RESUME, d: { token: self.token, session_id: self._sessionId, seq: self._seq } })
        else identify(self)
        break
      case OP.HEARTBEAT: send(self, { op: OP.HEARTBEAT, d: self._seq }); break
      case OP.HEARTBEAT_ACK: self._acked = true; break
      case OP.RECONNECT:
        // Server requests a reconnect; close gracefully so the close
        // handler triggers a resumed reconnect with the current session.
        try { ws.close(4000, 'server requested reconnect') } catch { /* already gone */ }
        break
      case OP.INVALID_SESSION:
        // Session is not resumable; clear it and re-identify after a
        // brief delay (Discord sends d:true when a quick retry is safe).
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
  // 'error' is not guaranteed to be followed by 'close' in every ws failure
  // mode (e.g. a handshake failure on an already-half-open socket) --
  // terminate() forces the close path deterministically so the heartbeat is
  // always cleared and a reconnect is always scheduled, rather than leaving
  // a zombied socket.
  ws.on('error', (e) => { self.log?.error?.('[discord] ws error', e.message); try { ws.terminate() } catch { /* already gone */ } })
}

// Schedule the next reconnect with backoff, unless shutting down, retries
// are exhausted, or one is already in flight (guards re-entry).
export function scheduleReconnect(self) {
  if (self._closed || self._reconnecting) return
  if (self._retries >= RECONNECT_MAX_RETRIES) {
    self.log?.error?.(`[discord] reconnect failed after ${RECONNECT_MAX_RETRIES} attempts, retrying in 1 hour`)
    self._reconnecting = true
    // Clear the cached gateway URL: it is fetched once and start() only
    // re-derives it from this.gatewayUrl, so every reconnect after the
    // first -- including this 1-hour last-resort retry -- would otherwise
    // reuse the SAME url forever, even if a stale/rotated url caused the
    // outage. start() re-fetches a fresh one.
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

export function dispatch(self, p) {
  if (p.t === 'READY') {
    self._sessionId = p.d?.session_id
    self._resumeUrl = p.d?.resume_gateway_url
    self._botUserId = p.d?.user?.id || null
    self.log?.info?.('[discord] gateway READY', { botUser: p.d?.user?.username || null })
    self.emit('ready', p.d)
    return
  }
  if (p.t === 'RESUMED') {
    self.log?.info?.('[discord] session resumed successfully')
    self.emit('ready', null)
    return
  }
  if (p.t === 'MESSAGE_CREATE') {
    const m = p.d
    // Blanket bot-ignore is a deliberate anti-loop safeguard -- two bots
    // replying to each other's messages is an unbounded reply storm with no
    // natural end. DISCORD_ALLOWED_BOT_AUTHOR_IDS (comma-separated user ids,
    // unset by default) lets an operator explicitly allowlist specific bot
    // accounts for scripted test traffic; unset behavior is byte-identical
    // to an unconditional bot-author skip. An allowlisted id still never
    // bypasses the self-message guard below.
    if (m.author?.bot) {
      const allowedIds = (typeof process !== 'undefined' && process.env && process.env.DISCORD_ALLOWED_BOT_AUTHOR_IDS || '')
        .split(',').map(s => s.trim()).filter(Boolean)
      if (!allowedIds.includes(m.author?.id)) return
    }
    if (m.author?.id && self._botUserId && m.author.id === self._botUserId) return   // never reply to our own messages
    const base = { from: m.author?.id, text: m.content || '', id: m.id, raw: m, platform: 'discord' }
    // ws.on('message', ...) above is a sync callback and can't await this,
    // so the fetch-and-emit path runs as a detached async task: the
    // message still emits exactly once, after attachment fetches settle,
    // and one attachment's failure (via allSettled) never blocks the
    // others or drops the message itself.
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
  clearInterval(self._heartbeat)   // never stack intervals across reconnects
  self._acked = true
  self._heartbeat = setInterval(() => {
    // A missed ack means the socket is a zombie: terminate it. The
    // 'close' handler then drives the (backed-off) reconnect, so we do
    // NOT also loop or reconnect here.
    if (!self._acked) { try { self._ws.terminate() } catch { /* already gone */ } return }
    self._acked = false
    send(self, { op: OP.HEARTBEAT, d: self._seq })
  }, interval)
}

export function send(self, obj) { try { self._ws?.send(JSON.stringify(obj)) } catch {} }
