// webhook-failure-limit.js -- per-client brake on webhook requests that fail verification (bad signature, bad
// handshake token). A client that has failed MAX times inside the window is answered 429 before any HMAC is computed,
// until its window clears. In memory and per process on purpose: the host is one VM, a restart clears it, and the
// limit exists to blunt guessing and CPU burn, not to be an audit record (the counters are on adapter.webhookStats).
//
// The client address is the socket peer, except when that peer is this machine's own reverse proxy (loopback): then it
// is the LAST entry of X-Forwarded-For, which is the one the proxy itself appended (Caddy overwrites untrusted values).
const WINDOW_MS = Number(process.env.CASEY_WEBHOOK_FAIL_WINDOW_MS) || 60_000
const MAX = Number(process.env.CASEY_WEBHOOK_FAIL_MAX) || 30
const MAX_TRACKED = 5000

const fails = new Map()   // ip -> [timestamps]

const isLoopback = (a) => /^(::1|127\.|::ffff:127\.)/.test(String(a || ''))

export function clientIp(req) {
  const peer = req?.socket?.remoteAddress || req?.connection?.remoteAddress || req?.ip || ''
  if (isLoopback(peer)) {
    const xff = String((req.get ? req.get('x-forwarded-for') : req.headers?.['x-forwarded-for']) || '').split(',').map(s => s.trim()).filter(Boolean)
    if (xff.length) return xff[xff.length - 1].slice(0, 64)
  }
  return String(peer).slice(0, 64) || 'unknown'
}

const recent = (ip, now) => {
  const list = (fails.get(ip) || []).filter(t => now - t < WINDOW_MS)
  if (list.length) fails.set(ip, list); else fails.delete(ip)
  return list
}

export function webhookBlocked(ip, now = Date.now()) { return recent(ip, now).length >= MAX }

export function recordWebhookFailure(ip, now = Date.now()) {
  const list = recent(ip, now)
  list.push(now)
  fails.set(ip, list)
  if (fails.size > MAX_TRACKED) { const oldest = fails.keys().next().value; fails.delete(oldest) }
}

export const _resetWebhookFailures = () => fails.clear()
