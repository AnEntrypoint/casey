import { createHash } from 'node:crypto'
import { mountRoutes } from './register.js'
import { operatorFields } from '../gui-action-log.js'
import { withSeverity } from '../../core/log-severity.js'

const LEVELS = new Set(['error', 'warn', 'info'])
const BODY_KEYS = new Set(['level', 'event', 'detail', 'route'])
const FIELD_MAX = 200
const RATE_MAX = 30
const RATE_WINDOW_MS = 60_000
const RATE_PRUNE_AT = 1000
const windows = new Map()

function isControl(code) {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
}

export function cleanField(value) {
  return Array.from(String(value ?? ''))
    .filter(ch => !isControl(ch.codePointAt(0)))
    .slice(0, FIELD_MAX)
    .join('')
}

function admit(key, now) {
  if (windows.size > RATE_PRUNE_AT) {
    for (const [k, w] of windows) if (now - w.start >= RATE_WINDOW_MS) windows.delete(k)
  }
  const w = windows.get(key)
  if (!w || now - w.start >= RATE_WINDOW_MS) {
    windows.set(key, { start: now, count: 1 })
    return true
  }
  if (w.count >= RATE_MAX) return false
  w.count++
  return true
}

export function postClientLog({ authed, parseCookies, COOKIE_NAME }) {
  return (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const b = req.body
    if (!b || typeof b !== 'object' || Array.isArray(b)) return res.status(400).json({ error: 'body must be a JSON object' })
    if (Object.keys(b).some(k => !BODY_KEYS.has(k))) return res.status(400).json({ error: 'unknown field' })
    if (!LEVELS.has(b.level)) return res.status(400).json({ error: 'level must be error, warn or info' })
    if (typeof b.event !== 'string' || !b.event.trim()) return res.status(400).json({ error: 'event required' })
    if (b.detail !== undefined && typeof b.detail !== 'string') return res.status(400).json({ error: 'detail must be a string' })
    if (b.route !== undefined && typeof b.route !== 'string') return res.status(400).json({ error: 'route must be a string' })
    const session = String(parseCookies(req.get('cookie'))[COOKIE_NAME] || '')
    const key = createHash('sha256').update(session).digest('hex')
    if (!admit(key, Date.now())) return res.status(204).end()
    console.log(JSON.stringify(withSeverity({
      t: new Date().toISOString(), level: b.level, component: 'gui', msg: 'gui_client',
      event: cleanField(b.event),
      detail: cleanField(b.detail),
      route: cleanField(b.route),
      operator: operatorFields(req).operator,
    })))
    res.status(204).end()
  }
}

const ROUTES = [
  ['post', '/api/client-log', postClientLog],
]

export function registerClientLog(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
