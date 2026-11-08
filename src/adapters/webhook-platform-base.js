
import crypto from 'node:crypto'

export async function fetchWithTimeout(url, opts, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: ac.signal })
  } finally {
    clearTimeout(timer)
  }
}

export function timingSafeEqualStr(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

export function verifyWebhookOr401(req, res, verifyFn) {
  if (verifyFn(req)) return true
  res.sendStatus(401)
  return false
}

export async function verifiedSend(sendFn, extractMarker, errLabel) {
  const res = await sendFn()
  const body = await res.json().catch(() => ({}))
  const marker = extractMarker(body)
  if (!res.ok || !marker) {
    throw new Error(`${errLabel}: send failed (status ${res.status}): ${JSON.stringify(body)}`)
  }
  return body
}

export function emitWithDetachedMedia(emitFn, baseEvent, hasPending, resolveMediaFn, onError) {
  if (!hasPending) { emitFn(baseEvent); return }
  const resolved = onError ? resolveMediaFn().catch(onError) : resolveMediaFn()
  resolved.then((media) => {
    try { emitFn({ ...baseEvent, media }) }
    catch (err) { console.error('emitWithDetachedMedia: a message listener threw; the message was delivered once and is not retried', err) }
  })
}
