// Shared helpers for webhook/gateway-style platform adapters (discord, whatsapp).
// Ported from freddie's plugins/_shared/webhook-platform-base.js (freddie's
// messaging-transport surface was removed in a later upstream rewrite; casey
// now owns this code directly).

import crypto from 'node:crypto'

/**
 * Run `fetch(url, opts)` bounded by an AbortController timeout.
 * @param {string} url
 * @param {object} opts fetch() options; `signal` is set/overridden internally
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, opts, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: ac.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Constant-time string compare, tolerant of length mismatch (timingSafeEqual
 * throws on unequal-length buffers rather than returning false).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqualStr(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

/**
 * Generic "verify webhook signature, else reject" wrapper: on a signature
 * mismatch, sends a 401 and returns false so the caller can bail out before
 * doing any further work; on success, returns true so the caller proceeds.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {(req: import('express').Request) => boolean} verifyFn
 * @returns {boolean} true if verified and the caller should proceed
 */
export function verifyWebhookOr401(req, res, verifyFn) {
  if (verifyFn(req)) return true
  res.sendStatus(401)
  return false
}

/**
 * Run a provider send call and verify actual delivery, not just that fetch()
 * didn't throw: a non-2xx (or even a 2xx-shaped) API response that carries no
 * expected success marker (Discord: response body `.id`; WhatsApp:
 * `messages[0].id`) is treated as a failure, not swallowed as if the send
 * succeeded.
 * @param {() => Promise<Response>} sendFn performs the actual fetch() call
 * @param {(body: any) => any} extractMarker pulls the success marker out of the parsed body
 * @param {string} errLabel prefix for the thrown error message (e.g. 'DiscordAdapter')
 * @returns {Promise<any>} the parsed response body on success
 */
export async function verifiedSend(sendFn, extractMarker, errLabel) {
  const res = await sendFn()
  const body = await res.json().catch(() => ({}))
  const marker = extractMarker(body)
  if (!res.ok || !marker) {
    throw new Error(`${errLabel}: send failed (status ${res.status}): ${JSON.stringify(body)}`)
  }
  return body
}

/**
 * Emit a message event immediately when there is no media to resolve;
 * otherwise resolve media asynchronously, detached from the caller (never
 * awaited), and emit exactly once when it settles -- a slow or failed media
 * fetch never blocks or drops the message itself.
 *
 * `resolveMediaFn()` must itself never reject in a way the caller wants
 * surfaced as a dropped message -- pass a function that already catches and
 * folds a failure into its resolved media shape, or pass an `onError`
 * fallback to build a degraded media object on rejection.
 *
 * @param {(event: object) => void} emitFn typically `(event) => this.emit('message', event)`
 * @param {object} baseEvent the event to emit, without `media` set yet
 * @param {boolean} hasPending whether there is media to resolve for this event
 * @param {() => Promise<any>} resolveMediaFn resolves to the `media` value to attach
 * @param {(err: any) => any} [onError] builds a degraded `media` value if resolveMediaFn rejects; omit to let the rejection propagate unhandled
 */
export function emitWithDetachedMedia(emitFn, baseEvent, hasPending, resolveMediaFn, onError) {
  if (!hasPending) { emitFn(baseEvent); return }
  const p = resolveMediaFn().then((media) => { emitFn({ ...baseEvent, media }) })
  if (onError) {
    p.catch((err) => { emitFn({ ...baseEvent, media: onError(err) }) })
  }
}
