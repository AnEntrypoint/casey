// WhatsApp Cloud API webhook adapter. Ported from freddie's
// plugins/platform/platform-whatsapp (freddie's messaging-transport surface
// was removed in a later upstream rewrite; casey now owns this code
// directly -- see AGENTS.md's freddie-port PRD rows and the WhatsApp HMAC
// verification security invariant).
import express from 'express'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { fetchWithTimeout, timingSafeEqualStr, verifyWebhookOr401, verifiedSend, emitWithDetachedMedia } from './webhook-platform-base.js'

// Outbound send/media-upload bound: see DiscordAdapter.send's identical
// constant for the failure this closes -- a bare, unbounded fetch() can leave
// a guaranteed-fallback reply composed and recorded but never actually
// delivered because the network call itself just hangs with no timeout.
const SEND_TIMEOUT_MS = 15000

export class WhatsappAdapter extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.platform = 'whatsapp'
    this.token = opts.token || process.env.WHATSAPP_API_TOKEN
    this.phoneId = opts.phoneId || process.env.WHATSAPP_PHONE_NUMBER_ID
    this.verifyToken = opts.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN
    // App secret enables X-Hub-Signature-256 verification on inbound webhooks.
    // When set, unsigned or wrongly-signed requests are rejected. Required
    // (not optional) when WhatsApp credentials are configured -- see AGENTS.md
    // Security invariants.
    this.appSecret = opts.appSecret || process.env.WHATSAPP_APP_SECRET || ''
    this.port = opts.port ?? Number(process.env.WHATSAPP_WEBHOOK_PORT || 0)
    this.path = opts.path || process.env.WHATSAPP_WEBHOOK_PATH || '/webhook'
    this.api = opts.api || 'https://graph.facebook.com/v20.0'
    this._server = null
  }
  getRequiredEnv() { return ['WHATSAPP_API_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'] }

  // Verify Meta's HMAC-SHA256 signature over the raw request body.
  _verifySignature(req) {
    if (!this.appSecret) return true   // verification disabled when no secret
    const sig = req.get('x-hub-signature-256') || ''
    if (!sig.startsWith('sha256=')) return false
    const expected = 'sha256=' + crypto.createHmac('sha256', this.appSecret).update(req.rawBody || Buffer.alloc(0)).digest('hex')
    return timingSafeEqualStr(sig, expected)
  }

  // WhatsApp Cloud API media download is a two-step handshake: the webhook
  // payload only ever carries a media id, never a fetchable URL directly.
  // Step 1 resolves that id to a short-lived signed URL (also bearer-authed);
  // step 2 fetches the actual bytes from that URL, still with the same
  // bearer token. Each hop is bounded by an AbortController timeout so a
  // slow/hung Meta response can never wedge the webhook handler indefinitely.
  async _downloadMedia(mediaId, timeoutMs = 10000) {
    const authHeader = { authorization: `Bearer ${this.token}` }
    const withTimeout = (url) => fetchWithTimeout(url, { headers: authHeader }, timeoutMs)
    const meta = await withTimeout(`${this.api}/${mediaId}`).then(r => r.json())
    if (!meta?.url) throw new Error('WhatsappAdapter: media lookup returned no url: ' + JSON.stringify(meta))
    const res = await withTimeout(meta.url)
    if (!res.ok) throw new Error(`WhatsappAdapter: media fetch failed with status ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    return { buffer, mimeType: meta.mime_type || res.headers.get('content-type') || '' }
  }

  async start() {
    if (!this.token || !this.phoneId) throw new Error('WhatsappAdapter: WHATSAPP_API_TOKEN + WHATSAPP_PHONE_NUMBER_ID required')
    if (!this.verifyToken) throw new Error('WhatsappAdapter: WHATSAPP_VERIFY_TOKEN required')
    const app = express()
    // Capture the raw body so the signature can be verified over exact bytes.
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf } }))

    app.get(this.path, (req, res) => {
      if (timingSafeEqualStr(String(req.query['hub.verify_token'] || ''), this.verifyToken)) return res.send(req.query['hub.challenge'])
      res.sendStatus(403)
    })
    app.post(this.path, (req, res) => {
      if (!verifyWebhookOr401(req, res, (r) => this._verifySignature(r))) return
      // Ack BEFORE any media fetch, not after: Meta retries a webhook that
      // doesn't get a prompt 2xx, and a media download is a two-hop fetch
      // that can legitimately take up to ~20s (two 10s per-hop timeouts).
      // Building the plain-text events synchronously (cheap, no I/O) then
      // acking immediately, with the media hydration running detached
      // afterward, means a slow/hung Meta media response can never cause
      // Meta to see an unacked webhook and redeliver it.
      const entries = req.body?.entry || []
      const events = []
      for (const e of entries) for (const c of (e.changes || [])) {
        const msgs = c.value?.messages || []
        for (const m of msgs) {
          const event = {
            from: m.from,
            text: m.text?.body || '',
            // surface the platform message id for dedup, and the message type
            // so media-only messages are recognisable upstream.
            id: m.id,
            raw: { ...m, id: m.id, type: m.type },
          }
          const mediaObj = m.image || m.audio || m.document || m.video
          if (mediaObj?.id) {
            const type = m.image ? 'image' : m.audio ? 'audio' : m.document ? 'document' : 'video'
            event._pendingMedia = { mediaObj, type }
          }
          events.push(event)
        }
      }
      res.json({ ok: true })
      // Hydrate media and emit, detached from the ack above. A message with
      // no media emits immediately; one with media emits once the download
      // (or its failure) resolves, without gating res.json.
      for (const event of events) {
        const pending = event._pendingMedia
        delete event._pendingMedia
        emitWithDetachedMedia(
          (e) => this.emit('message', e),
          event,
          !!pending,
          async () => {
            const { buffer, mimeType } = await this._downloadMedia(pending.mediaObj.id)
            return { type: pending.type, mimeType, buffer }
          },
          (err) => {
            // Never let a failed/slow media fetch block the pipeline -- note
            // media as present-but-unfetched so it still proceeds.
            console.error('WhatsappAdapter: media download failed', err)
            return { type: pending.type, mimeType: pending.mediaObj.mime_type || '', buffer: null, error: String(err?.message || err) }
          },
        )
      }
    })
    await new Promise(r => { this._server = app.listen(this.port, () => r()) })
    this.port = this._server.address().port
  }
  async stop() { if (this._server) await new Promise(r => this._server.close(() => r())) }

  // Upload raw media bytes to the Cloud API and return the resulting media id.
  // WhatsApp will not send an audio/image message from bytes inline -- it must
  // first be POSTed to /{phoneId}/media as multipart, which yields a reusable
  // id referenced by the outbound message. Bearer-authed like every other hop.
  async _uploadMedia(buffer, mimeType) {
    const fd = new FormData()
    fd.append('messaging_product', 'whatsapp')
    fd.append('type', mimeType)
    fd.append('file', new Blob([buffer], { type: mimeType }), 'reply')
    const r = await fetchWithTimeout(`${this.api}/${this.phoneId}/media`, { method: 'POST', headers: { authorization: `Bearer ${this.token}` }, body: fd }, SEND_TIMEOUT_MS).then(x => x.json())
    if (!r?.id) throw new Error('WhatsappAdapter: media upload returned no id: ' + JSON.stringify(r))
    return r.id
  }

  async send(reply) {
    if (!this.token) throw new Error('WhatsappAdapter: token required')
    // Verify actual delivery, not just that fetch() itself didn't throw: a
    // non-2xx Graph API response (bad token, rate limit, invalid recipient)
    // returns a normal JSON body with no messages[0].id, which checking only
    // res.ok would swallow as if the send succeeded.
    const post = (payload) => verifiedSend(
      () => fetchWithTimeout(`${this.api}/${this.phoneId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: reply.to, ...payload }) }, SEND_TIMEOUT_MS),
      (body) => body?.messages?.[0]?.id,
      'WhatsappAdapter',
    )
    // Optional audio: an already-hosted link sends directly; raw bytes upload
    // first, then send by media id. The text (when present) is sent alongside
    // so the reporter still gets the words. A text-only reply is byte-identical
    // to the original single POST -- audio is purely additive.
    const a = reply.audio
    if (a && (a.link || a.data_base64)) {
      const audioMsg = a.link ? { link: a.link } : { id: await this._uploadMedia(Buffer.from(a.data_base64, 'base64'), a.mime || 'audio/ogg') }
      if (reply.text) await post({ text: { body: reply.text } })
      return post({ type: 'audio', audio: audioMsg })
    }
    return post({ text: { body: reply.text } })
  }
}
