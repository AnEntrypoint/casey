

const WINDOW_MS = Number(process.env.CASEY_WEBHOOK_FAIL_WINDOW_MS) || 60_000
const MAX = Number(process.env.CASEY_WEBHOOK_FAIL_MAX) || 30
const MAX_TRACKED = 5000

const fails = new Map()

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
