// WhatsApp Cloud API webhook adapter. Inbound is HMAC-SHA256 verified -- see
// AGENTS.md's WhatsApp HMAC verification security invariant.
import { clientIp, webhookBlocked, recordWebhookFailure } from '../webhook-failure-limit.js'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { fetchWithTimeout, timingSafeEqualStr, verifiedSend, emitWithDetachedMedia, verifyWebhookOr401 } from './webhook-platform-base.js'

// Outbound send/media-upload bound: a bare, unbounded fetch() can leave a
// guaranteed-fallback reply composed and recorded but never actually delivered
// because the network call itself just hangs with no timeout.
const SEND_TIMEOUT_MS = 15000
const DISPLAY_TIMEOUT_MS = 4000
const DISPLAY_RETRY_MS = 5 * 60e3

// The largest webhook body casey will read or parse. Meta's real bodies are a few
// KB; the dashboard mount already caps its raw reader at 256kb, and this is the
// same number applied where BOTH mounts converge (and, via the exported const,
// to the freddie-side reader that used to buffer an unbounded stream BEFORE the
// signature was ever consulted).
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024
// Meta redelivers a webhook for at most seven days. A signed body older than that
// is a replay, not a retry: the HMAC carries no clock, so a captured body would
// otherwise verify forever, and once the case it belonged to has been erased or
// archived nothing would remember its wamid. Age is read off the message's own
// Meta-stamped `timestamp`. CASEY_WHATSAPP_MAX_AGE_HOURS=0 turns the check off.
const DEFAULT_MAX_MESSAGE_AGE_HOURS = 168

// Delivery-status ladder. sent < delivered < read; `failed` is separate.
export const STATUS_RANK = Object.freeze({ sent: 1, delivered: 2, read: 3 })

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
    // The webhook path, registered on BOTH sockets casey listens on: freddie's
    // own ctx.webServer (freddie-bundle/src/platform, CASEY_WEBHOOK_PORT) and
    // the operator dashboard's Express app (src/dashboard/routes/
    // whatsapp-webhook.js, --port). This adapter owns no listening socket of
    // its own -- both mounts are handed this same live instance and both call
    // serveWhatsappWebhook below, so there is one path, one verifier and one
    // event emitter regardless of which socket Meta reaches. There is no
    // WHATSAPP_WEBHOOK_PORT of its own.
    this.path = opts.path || process.env.WHATSAPP_WEBHOOK_PATH || '/webhooks/whatsapp'
    this.api = opts.api || (process.env.WHATSAPP_GRAPH_API || `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || 'v20.0'}`).replace(/\/+$/, '')
    // The bot's own number as WhatsApp displays it (digits/format Meta returns),
    // read once from the Graph API so the dashboard can tell a team member which
    // number to message. Best-effort: never awaited by boot, never throws, cached
    // in memory; a failure is retried at most every DISPLAY_RETRY_MS on a later read.
    this._displayNumber = ''
    this._displayTriedAt = 0
    this._displayInflight = null
    // In-memory webhook counters, read by /api/health via casey.js. Since start,
    // aggregate, never a contact identifier.
    // The last few hundred sends by wamid (recipient, text, time), so a status can
    // be matched to an outbound event whose wamid no caller persisted. Bounded.
    this.recentSends = new Map()
    // Shutdown: once draining, the webhook answers 503 so Meta redelivers the
    // message to the next worker instead of an ack going to a process about to
    // close its store; media hydrations already in flight are awaited by
    // drainMedia() so a downloaded photo still becomes its message.
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
    // The emit for a settled hydration runs on the next microtask.
    await new Promise(r => setImmediate(r))
  }

  // GET /{phone_id}?fields=display_phone_number, bearer token, short timeout.
  // A read only: nothing is sent to anyone. The token is never logged.
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

  // The cached display number ('' until known). Synchronous; a stale miss kicks
  // a background retry rather than making the caller wait.
  displayNumber() {
    if (!this._displayNumber && this.token && this.phoneId && Date.now() - this._displayTriedAt > DISPLAY_RETRY_MS) this.refreshDisplayNumber()
    return this._displayNumber
  }

  // Verify Meta's HMAC-SHA256 signature over the raw request body.
  _verifySignature(req) {
    // FAIL CLOSED: with no app secret nothing can be verified, so nothing is accepted. Unsigned delivery is allowed only when
    // CASEY_ALLOW_UNSIGNED_WEBHOOK=1 is set on purpose (a local development bot with no Meta app behind it).
    if (!this.appSecret) return process.env.CASEY_ALLOW_UNSIGNED_WEBHOOK === '1'
    const sig = req.get('x-hub-signature-256') || ''
    if (!sig.startsWith('sha256=')) return false
    if (!(req.rawBody?.length > 0)) return false   // Meta never signs an empty body
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
    const meta = await withTimeout(`${this.api}/${encodeURIComponent(String(mediaId))}`).then(r => r.json())
    if (!meta?.url) throw new Error('WhatsappAdapter: media lookup returned no url')
    // The bearer token rides to whatever host that url names: only https, never a cleartext or odd scheme.
    if (!/^https:\/\//i.test(String(meta.url))) throw new Error('WhatsappAdapter: media url is not https')
    const res = await withTimeout(meta.url)
    if (!res.ok) throw new Error(`WhatsappAdapter: media fetch failed with status ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    return { buffer, mimeType: meta.mime_type || res.headers.get('content-type') || '' }
  }

  // Meta's GET verification handshake. Returns the challenge string to echo
  // back, or null when the token does not match (the caller answers 403).
  verifyChallenge(verifyToken, challenge) {
    if (!this.verifyToken || !verifyToken) return null   // no token configured, or none offered: never a match
    return timingSafeEqualStr(String(verifyToken), String(this.verifyToken)) ? String(challenge || '') : null
  }

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

  // Remember the newest inbound message id per sender, so the typing indicator can answer it.
  _noteInbound(from, wamid) {
    if (!this._lastInbound) this._lastInbound = new Map()
    this._lastInbound.set(String(from), { id: String(wamid), at: Date.now(), typed: false })
    if (this._lastInbound.size > 500) this._lastInbound.delete(this._lastInbound.keys().next().value)
  }

  // Read tick plus "typing..." (Meta Cloud API): while the bot works, the person sees that the message
  // arrived instead of silence for 5-35 seconds. Shown by WhatsApp for up to 25s or until our reply.
  // Sent once per inbound message, only to a person who has just written to us, best-effort (a failure is
  // ignored: it is a courtesy, never load-bearing). CASEY_WHATSAPP_TYPING=0 turns it off.
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
    // Verify actual delivery, not just that fetch() itself didn't throw: a
    // non-2xx Graph API response (bad token, rate limit, invalid recipient)
    // returns a normal JSON body with no messages[0].id, which checking only
    // res.ok would swallow as if the send succeeded.
    // The wamid Meta returns for each accepted send is collected on the result
    // (`wamids`, first = the text). Delivery-status webhooks name a message ONLY
    // by that id, so it is what lets a later `failed` (131047, window closed)
    // find the outbound event it belongs to.
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
    // Optional audio: an already-hosted link sends directly; raw bytes upload
    // first, then send by media id. The text (when present) is sent alongside
    // so the reporter still gets the words.
    const a = reply.audio
    if (a && (a.link || a.data_base64)) {
      const audioMsg = a.link ? { link: a.link } : { id: await this._uploadMedia(Buffer.from(a.data_base64, 'base64'), a.mime || 'audio/ogg') }
      if (reply.text) await post({ text: { body: reply.text } })
      return post({ type: 'audio', audio: audioMsg })
    }
    return post({ text: { body: reply.text } })
  }
}

// Parse one verified webhook POST body into events and emit them.
//
// SYNCHRONOUS on purpose, and the caller must ack (200) as soon as this
// RETURNS, not once the emitted work settles: Meta redelivers a webhook that
// does not get a prompt 2xx, and a media download is a two-hop fetch that can
// legitimately take ~20s (two 10s per-hop timeouts). Building the plain-text
// events here is cheap and does no I/O; media hydration runs detached via
// emitWithDetachedMedia, so a slow or hung Meta media response can never make
// Meta see an unacked webhook and redeliver it.
//
// This parsing lives here, beside the adapter that owns _downloadMedia and the
// media field vocabulary, and NOT in the freddie-bundle platform plugin that
// calls it. Do not grow a second copy there: a duplicate on the live path
// drifts off emitWithDetachedMedia and stops detaching media hydration.
// Meta nests every inbound message's payload under `m.<type>`, one documented
// shape per type, and THREE of those shapes carry the words a person typed
// alongside the file they sent: `image.caption`, `video.caption` and
// `document.caption`. None of them is on `m.text`, so reading `m.text?.body`
// alone downloads a photo's bytes perfectly and silently discards the sentence
// describing what the photo shows -- on a disease report, the half a vet reads
// first. `audio` and `sticker` have no caption field at all (audio carries
// `voice`, sticker carries `animated`), so there is nothing to read there.
// A `reaction`'s only content IS its emoji, which likewise reached the turn as
// empty text with no branch for it.
function inboundMessageText(m) {
  return m.text?.body
    || m.image?.caption || m.video?.caption || m.document?.caption
    || m.reaction?.emoji
    || ''
}

// A shared location pin arrives COMPLETE in the webhook body -- Meta's
// documented shape is `{type:'location', location:{latitude, longitude, name,
// address, url}}` with latitude/longitude as JSON numbers, not a media id. So
// it must never enter the media path: there is nothing to fetch, and
// `mediaObj?.id` is undefined on it, which is exactly why an unhandled pin used
// to reach the turn as a no-text no-media event with the coordinates thrown
// away. Normalised here, beside the rest of this adapter's field vocabulary, so
// the deterministic ingress capture (hooks/media-intake.js) reads ONE shape
// instead of Meta's raw message. Numbers are coerced (not trusted) and a
// non-numeric pair yields null rather than a NaN coordinate that would read as
// a real position downstream; range validation belongs with the write, in
// media-intake.js, alongside every other case-layer coordinate check.
function inboundLocation(m) {
  const l = m.location
  if (!l) return null
  const lat = Number(l.latitude)
  const lon = Number(l.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { lat, lon, name: String(l.name || ''), address: String(l.address || ''), url: String(l.url || '') }
}

// The sender's own WhatsApp profile name. It is NOT on the message -- Meta puts
// it once per change, in `value.contacts[]` keyed by `wa_id`, as a sibling of
// `value.messages[]`. hooks/case-intake.js seeds the contact row's display_name
// from the event, and its only reader was Discord's `raw.author.username`, so
// every WhatsApp contact fell back to display_name = the phone number: the
// contacts panel showed them as unnamed, the map called them "a field worker",
// and an operator ringing back about a dying herd had a number and no name Meta
// had already sent.
// Matched by wa_id rather than taken positionally, since one change may carry
// several senders' messages; the single-contact case is the fallback because
// wa_id and `from` can differ for a number whose display form Meta rewrote.
function profileNameFor(value, from) {
  const list = value?.contacts || []
  if (!list.length) return ''
  const hit = list.find(c => c?.wa_id === from) || (list.length === 1 ? list[0] : null)
  return String(hit?.profile?.name || '')
}

// One Meta `statuses[]` entry, normalised. Statuses ride the SAME webhook as
// messages (`value.statuses[]`, a sibling of `value.messages[]`) and are never a
// message: they must not open a case, reach a turn or count as inbound liveness.
// Meta names the outbound only by its wamid (`id`); `errors[]` carries the
// reason for a `failed` (131047 = the 24h re-engagement window is closed,
// 131026 = the number cannot receive WhatsApp, 131049 = Meta withheld it for
// ecosystem health, 130472 = experiment holdout, ...). Only `code`, `title`,
// `message` and `details` are kept -- bounded, and nothing else off the payload.
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

// Message age off Meta's own unix-seconds `timestamp`. Unknown -> not stale.
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
      // A message with no sender or no wamid can never be deduplicated (the
      // dedup key IS the wamid) and would open a case keyed 'unknown' on every
      // redelivery. Meta never sends one; refuse it and say so on the counters.
      if (typeof m.from !== 'string' || !m.from || typeof m.id !== 'string' || !m.id) { bump('malformed_messages'); continue }
      if (messageTooOld(m, now)) { bump('stale_dropped'); continue }
      const location = inboundLocation(m)
      const profileName = profileNameFor(c.value, m.from)
      const event = {
        from: m.from,
        ...(profileName ? { profileName } : {}),
        // `id` is lifted out for dedup upstream; `raw` is Meta's own message
        // object as it arrived, which already carries id and type.
        text: inboundMessageText(m),
        id: m.id,
        raw: m,
        ...(location ? { location } : {}),
      }
      adapter._noteInbound?.(m.from, m.id)
      // `sticker` is deliberately NOT in this list. It is image/webp and would
      // download like a photo, but hooks/media-intake.js records a photo only
      // for a real image, so the bytes would be fetched on every sticker and
      // then dropped -- two Graph API hops and a Meta rate-limit slot spent on
      // nothing. A sticker still reaches the turn: describeMedia() names it
      // from `raw.type`, which is the whole of what a sticker tells us.
      const mediaObj = m.image || m.audio || m.document || m.video
      const type = m.image ? 'image' : m.audio ? 'audio' : m.document ? 'document' : m.video ? 'video' : null
      events.push({ event, pending: mediaObj?.id ? { mediaObj, type } : null })
    }
  }
  if (events.length) { bump('messages', events.length); stats.last_message_at = now }
  if (statuses.length) { bump('statuses', statuses.length); stats.last_status_at = now }
  // Delivery statuses go out on their own event. A throwing listener must not
  // turn a 200-worthy webhook into a 500 (Meta would redeliver the whole body,
  // messages included), so it is contained here.
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
        // Tracked for shutdown (drainMedia); the settled copy is what is kept so
        // a rejection here is still handled by onError below, not by the set.
        if (adapter._pendingMedia) {
          const settled = p.then(() => {}, () => {}).finally(() => adapter._pendingMedia.delete(settled))
          adapter._pendingMedia.add(settled)
        }
        return p
      },
      (err) => {
        // Never let a failed/slow media fetch block the pipeline -- note
        // media as present-but-unfetched so it still proceeds.
        console.error('WhatsappAdapter: media download failed', err)
        return { type: pending.type, mimeType: pending.mediaObj.mime_type || '', buffer: null, error: String(err?.message || err) }
      },
    )
  }
  return events.length
}

// THE webhook request handler -- the whole Cloud API contract (GET verify
// challenge, POST signature-verified receive) in one place, called by BOTH
// mount points: freddie's ctx.webServer route (freddie-bundle/src/platform, on
// CASEY_WEBHOOK_PORT) and the dashboard's Express route
// (src/dashboard/routes/whatsapp-webhook.js, on --port). Neither owns a second
// copy of this logic and neither builds a second WhatsappAdapter: both are
// handed the SAME live instance off casey.js's this.adapters, so the signature
// check, the challenge comparison and the 'message' emitter that feeds the real
// turn pipeline are identical whichever socket Meta reached.
//
// `req`/`res` are an express-SHAPED pair, never necessarily a real express
// request -- req.method, req.query, req.rawBody and req.get(name); res
// .sendStatus(code), .sendText(text) and .json(obj). The dashboard route wraps
// a real express req/res in that shape; the platform plugin wraps freddie's raw
// node req/res in it. Adapting at each call site rather than forking the
// handler is what keeps this the only implementation.
//
// Two ordering rules the shape below encodes, both live-witnessed:
//  - the HMAC is over the raw bytes, so NOTHING is parsed before the signature
//    is consulted. Parsing first meant an unsigned POST of non-JSON bytes threw
//    out of the handler with no status written at all, leaving the socket
//    unanswered where it should have read 401.
//  - dispatchWhatsappWebhookBody is synchronous and detaches media hydration,
//    so the ack goes out the instant it returns. Awaiting the emitted work
//    would let a two-hop Meta media fetch (~20s) outlast Meta's own patience
//    and earn a redelivery.
export function serveWhatsappWebhook(adapter, req, res) {
  // A client that keeps failing verification is turned away before any HMAC work (webhook-failure-limit.js).
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
  // Size first: cheaper than an HMAC over a hostile megabyte, and answered 413 so
  // a proxy or a human reading its log sees WHY. Both mounts already bound their
  // own reader; this is the one place that bound is stated for the shared handler.
  if ((req.rawBody?.length || 0) > WEBHOOK_MAX_BODY_BYTES) { bump('rejected_oversize'); res.sendStatus(413); return }
  if (!verifyWebhookOr401(req, res, (r) => adapter._verifySignature(r))) { bump('rejected_signature'); recordWebhookFailure(ip); return }
  // Draining for shutdown: a 5xx makes Meta redeliver to the restarted worker.
  // After the signature so an unauthenticated caller learns nothing about state.
  if (adapter.draining) { bump('rejected_draining'); res.sendStatus(503); return }
  let body
  try {
    body = JSON.parse((req.rawBody || Buffer.alloc(0)).toString('utf8') || '{}')
  } catch {
    // Signed by Meta and still unparseable: answer, do not hang the socket.
    bump('rejected_malformed')
    res.sendStatus(400)
    return
  }
  bump('posts')
  // The ack must never depend on the shape of a body that verified: a valid
  // signature only proves who sent it, and a JSON `null`, `[]` or a number where
  // an array belongs must not throw out of a handler whose caller (freddie's
  // ctx.webServer) has no catch around it.
  // What CAN still throw is a message listener. That is answered 500 so Meta
  // redelivers the whole body: safe, because every message is deduplicated on its
  // wamid and every status on its recorded state, so the retry only completes
  // what the throw cut short.
  try { dispatchWhatsappWebhookBody(adapter, body) }
  catch (err) {
    console.error('WhatsappAdapter: webhook body could not be fully dispatched (answering 500 so Meta redelivers)', err?.message || err)
    res.sendStatus(500)
    return
  }
  res.json({ ok: true })
}
