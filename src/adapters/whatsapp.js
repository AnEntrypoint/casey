import { clientIp, webhookBlocked, recordWebhookFailure } from '../webhook-failure-limit.js'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { fetchWithTimeout, timingSafeEqualStr, verifiedSend, emitWithDetachedMedia, verifyWebhookOr401 } from './webhook-platform-base.js'

const SEND_TIMEOUT_MS = 15000
const DISPLAY_TIMEOUT_MS = 4000
const DISPLAY_RETRY_MS = 5 * 60e3

export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024
const DEFAULT_MAX_MESSAGE_AGE_HOURS = 168

export const STATUS_RANK = Object.freeze({ sent: 1, delivered: 2, read: 3 })

export class WhatsappAdapter extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.platform = 'whatsapp'
    this.token = opts.token || process.env.WHATSAPP_API_TOKEN
    this.phoneId = opts.phoneId || process.env.WHATSAPP_PHONE_NUMBER_ID
    this.verifyToken = opts.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN
    this.appSecret = opts.appSecret || process.env.WHATSAPP_APP_SECRET || ''
    this.path = opts.path || process.env.WHATSAPP_WEBHOOK_PATH || '/webhooks/whatsapp'
    this.api = opts.api || (process.env.WHATSAPP_GRAPH_API || `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || 'v20.0'}`).replace(/\/+$/, '')
    this._displayNumber = ''
    this._displayTriedAt = 0
    this._displayInflight = null
    this.recentSends = new Map()
    this.draining = false
    this._pendingMedia = new Set()
    this.webhookStats = { posts: 0, messages: 0, statuses: 0, stale_dropped: 0, rejected_signature: 0, rejected_oversize: 0, rejected_malformed: 0, rejected_draining: 0, malformed_messages: 0, last_post_at: null, last_message_at: null, last_status_at: null }
    if (this.token && this.phoneId) setImmediate(() => this.refreshDisplayNumber())
  }

  beginDrain() { this.draining = true }

  async drainMedia(timeoutMs = 15000) {
    if (!this._pendingMedia.size) return
    let timer
    await Promise.race([
      Promise.allSettled([...this._pendingMedia]),
      new Promise(r => { timer = setTimeout(r, timeoutMs) }),
    ])
    clearTimeout(timer)
    await new Promise(r => setImmediate(r))
  }

  refreshDisplayNumber() {
    if (this._displayInflight) return this._displayInflight
    if (!this.token || !this.phoneId) return Promise.resolve('')
    this._displayTriedAt = Date.now()
    this._displayInflight = (async () => {
      try {
        const r = await fetchWithTimeout(`${this.api}/${encodeURIComponent(this.phoneId)}?fields=display_phone_number`, { headers: { authorization: `Bearer ${this.token}` } }, DISPLAY_TIMEOUT_MS)
        if (!r.ok) throw new Error(`status ${r.status}`)
        const j = await r.json()
        const n = String(j?.display_phone_number || '').replace(/[^\d+()\s-]/g, '').trim().slice(0, 32)
        if (n) this._displayNumber = n
      } catch (e) {
        console.warn('[whatsapp] could not read the display phone number:', e?.message || 'failed')
      } finally { this._displayInflight = null }
      return this._displayNumber
    })()
    return this._displayInflight
  }

  displayNumber() {
    if (!this._displayNumber && this.token && this.phoneId && Date.now() - this._displayTriedAt > DISPLAY_RETRY_MS) this.refreshDisplayNumber()
    return this._displayNumber
  }

  _verifySignature(req) {
    if (!this.appSecret) return process.env.CASEY_ALLOW_UNSIGNED_WEBHOOK === '1'
    const sig = req.get('x-hub-signature-256') || ''
    if (!sig.startsWith('sha256=')) return false
    if (!(req.rawBody?.length > 0)) return false
    const expected = 'sha256=' + crypto.createHmac('sha256', this.appSecret).update(req.rawBody || Buffer.alloc(0)).digest('hex')
    return timingSafeEqualStr(sig, expected)
  }

  async _downloadMedia(mediaId, timeoutMs = 10000) {
    const authHeader = { authorization: `Bearer ${this.token}` }
    const withTimeout = (url) => fetchWithTimeout(url, { headers: authHeader }, timeoutMs)
    const meta = await withTimeout(`${this.api}/${encodeURIComponent(String(mediaId))}`).then(r => r.json())
    if (!meta?.url) throw new Error('WhatsappAdapter: media lookup returned no url')
    if (!/^https:\/\//i.test(String(meta.url))) throw new Error('WhatsappAdapter: media url is not https')
    const res = await withTimeout(meta.url)
    if (!res.ok) throw new Error(`WhatsappAdapter: media fetch failed with status ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    return { buffer, mimeType: meta.mime_type || res.headers.get('content-type') || '' }
  }

  verifyChallenge(verifyToken, challenge) {
    if (!this.verifyToken || !verifyToken) return null
    return timingSafeEqualStr(String(verifyToken), String(this.verifyToken)) ? String(challenge || '') : null
  }

  async _uploadMedia(buffer, mimeType) {
    const fd = new FormData()
    fd.append('messaging_product', 'whatsapp')
    fd.append('type', mimeType)
    fd.append('file', new Blob([buffer], { type: mimeType }), 'reply')
    const r = await fetchWithTimeout(`${this.api}/${this.phoneId}/media`, { method: 'POST', headers: { authorization: `Bearer ${this.token}` }, body: fd }, SEND_TIMEOUT_MS).then(x => x.json())
    if (!r?.id) throw new Error('WhatsappAdapter: media upload returned no id: ' + JSON.stringify(r))
    return r.id
  }

  _noteInbound(from, wamid) {
    if (!this._lastInbound) this._lastInbound = new Map()
    this._lastInbound.set(String(from), { id: String(wamid), at: Date.now(), typed: false })
    if (this._lastInbound.size > 500) this._lastInbound.delete(this._lastInbound.keys().next().value)
  }

  startTyping(to) {
    if (String(process.env.CASEY_WHATSAPP_TYPING ?? '1') === '0' || !this.token || !this.phoneId) return
    const rec = this._lastInbound?.get(String(to))
    if (!rec || rec.typed || Date.now() - rec.at > 120000) return
    rec.typed = true
    fetchWithTimeout(`${this.api}/${encodeURIComponent(this.phoneId)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: rec.id, typing_indicator: { type: 'text' } }),
    }, 5000).catch(() => {})
  }

  stopTyping() {}

  async send(reply) {
    if (!this.token) throw new Error('WhatsappAdapter: token required')
    const wamids = []
    const post = async (payload) => {
      const body = await verifiedSend(
        () => fetchWithTimeout(`${this.api}/${this.phoneId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: reply.to, ...payload }) }, SEND_TIMEOUT_MS),
        (b) => b?.messages?.[0]?.id,
        'WhatsappAdapter',
      )
      const id = body.messages[0].id
      wamids.push(id)
      this.recentSends.set(id, { to: reply.to, text: payload.text?.body || '', at: Date.now() })
      if (this.recentSends.size > 500) this.recentSends.delete(this.recentSends.keys().next().value)
      return { ...body, wamids }
    }
    const a = reply.audio
    if (a && (a.link || a.data_base64)) {
      const audioMsg = a.link ? { link: a.link } : { id: await this._uploadMedia(Buffer.from(a.data_base64, 'base64'), a.mime || 'audio/ogg') }
      if (reply.text) await post({ text: { body: reply.text } })
      return post({ type: 'audio', audio: audioMsg })
    }
    return post({ text: { body: reply.text } })
  }
}

function inboundMessageText(m) {
  return m.text?.body
    || m.image?.caption || m.video?.caption || m.document?.caption
    || m.reaction?.emoji
    || ''
}

function inboundLocation(m) {
  const l = m.location
  if (!l) return null
  const lat = Number(l.latitude)
  const lon = Number(l.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { lat, lon, name: String(l.name || ''), address: String(l.address || ''), url: String(l.url || '') }
}

function profileNameFor(value, from) {
  const list = value?.contacts || []
  if (!list.length) return ''
  const hit = list.find(c => c?.wa_id === from) || (list.length === 1 ? list[0] : null)
  return String(hit?.profile?.name || '')
}

const clipText = (v, n) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').slice(0, n)
function normaliseStatus(st) {
  if (!st || typeof st !== 'object') return null
  const id = typeof st.id === 'string' ? st.id : ''
  const status = typeof st.status === 'string' ? st.status.toLowerCase() : ''
  if (!id || !status) return null
  const ts = Number(st.timestamp)
  const errors = (Array.isArray(st.errors) ? st.errors : []).slice(0, 3).map(e => ({
    code: Number.isFinite(Number(e?.code)) ? Number(e.code) : null,
    title: clipText(e?.title, 120),
    message: clipText(e?.message, 240),
    details: clipText(e?.error_data?.details, 240),
  }))
  return { id: clipText(id, 200), status: clipText(status, 24), recipient: clipText(st.recipient_id, 32), at: Number.isFinite(ts) && ts > 0 ? ts * 1000 : null, errors }
}

function messageTooOld(m, now) {
  const hours = process.env.CASEY_WHATSAPP_MAX_AGE_HOURS === undefined ? DEFAULT_MAX_MESSAGE_AGE_HOURS : Number(process.env.CASEY_WHATSAPP_MAX_AGE_HOURS)
  if (!(hours > 0)) return false
  const ts = Number(m?.timestamp)
  if (!Number.isFinite(ts) || ts <= 0) return false
  return now - ts * 1000 > hours * 3600e3
}

export function dispatchWhatsappWebhookBody(adapter, body, now = Date.now()) {
  const events = []
  const statuses = []
  const stats = adapter.webhookStats || (adapter.webhookStats = {})
  const bump = (k, n = 1) => { stats[k] = (stats[k] || 0) + n }
  const arr = (v) => (Array.isArray(v) ? v : [])
  for (const e of arr(body?.entry)) for (const c of arr(e?.changes)) {
    for (const st of arr(c?.value?.statuses)) {
      const n = normaliseStatus(st)
      if (n) statuses.push(n)
    }
    for (const m of arr(c?.value?.messages)) {
      if (!m || typeof m !== 'object') continue
      if (typeof m.from !== 'string' || !m.from || typeof m.id !== 'string' || !m.id) { bump('malformed_messages'); continue }
      if (messageTooOld(m, now)) { bump('stale_dropped'); continue }
      const location = inboundLocation(m)
      const profileName = profileNameFor(c.value, m.from)
      const event = {
        from: m.from,
        ...(profileName ? { profileName } : {}),
        text: inboundMessageText(m),
        id: m.id,
        raw: m,
        ...(location ? { location } : {}),
      }
      adapter._noteInbound?.(m.from, m.id)
      const mediaObj = m.image || m.audio || m.document || m.video
      const type = m.image ? 'image' : m.audio ? 'audio' : m.document ? 'document' : m.video ? 'video' : null
      events.push({ event, pending: mediaObj?.id ? { mediaObj, type } : null })
    }
  }
  if (events.length) { bump('messages', events.length); stats.last_message_at = now }
  if (statuses.length) { bump('statuses', statuses.length); stats.last_status_at = now }
  for (const st of statuses) {
    try { adapter.emit('status', st) }
    catch (err) { console.error('WhatsappAdapter: a status listener threw; the status was delivered once and is not retried', err) }
  }
  for (const { event, pending } of events) {
    emitWithDetachedMedia(
      (ev) => adapter.emit('message', ev),
      event,
      !!pending,
      () => {
        const p = (async () => {
          const { buffer, mimeType } = await adapter._downloadMedia(pending.mediaObj.id)
          return { type: pending.type, mimeType, buffer }
        })()
        if (adapter._pendingMedia) {
          const settled = p.then(() => {}, () => {}).finally(() => adapter._pendingMedia.delete(settled))
          adapter._pendingMedia.add(settled)
        }
        return p
      },
      (err) => {
        console.error('WhatsappAdapter: media download failed', err)
        return { type: pending.type, mimeType: pending.mediaObj.mime_type || '', buffer: null, error: String(err?.message || err) }
      },
    )
  }
  return events.length
}

export function serveWhatsappWebhook(adapter, req, res) {
  const ip = clientIp(req)
  if (webhookBlocked(ip)) { res.sendStatus(429); return }
  if (req.method === 'GET') {
    const challenge = adapter.verifyChallenge(req.query?.['hub.verify_token'], req.query?.['hub.challenge'])
    if (challenge === null) { recordWebhookFailure(ip); res.sendStatus(403); return }
    res.sendText(challenge)
    return
  }
  const stats = adapter.webhookStats || (adapter.webhookStats = {})
  const bump = (k) => { stats[k] = (stats[k] || 0) + 1 }
  stats.last_post_at = Date.now()
  if ((req.rawBody?.length || 0) > WEBHOOK_MAX_BODY_BYTES) { bump('rejected_oversize'); res.sendStatus(413); return }
  if (!verifyWebhookOr401(req, res, (r) => adapter._verifySignature(r))) { bump('rejected_signature'); recordWebhookFailure(ip); return }
  if (adapter.draining) { bump('rejected_draining'); res.sendStatus(503); return }
  let body
  try {
    body = JSON.parse((req.rawBody || Buffer.alloc(0)).toString('utf8') || '{}')
  } catch {
    bump('rejected_malformed')
    res.sendStatus(400)
    return
  }
  bump('posts')
  try { dispatchWhatsappWebhookBody(adapter, body) }
  catch (err) {
    console.error('WhatsappAdapter: webhook body could not be fully dispatched (answering 500 so Meta redelivers)', err?.message || err)
    res.sendStatus(500)
    return
  }
  res.json({ ok: true })
}
