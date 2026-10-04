import { mountRoutes } from './register.js'
import { addFeedback, listFeedback, MAX_TEXT } from '../../feedback.js'
import { roleOf } from '../roles.js'

export function postFeedback({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const b = req.body || {}
    const text = typeof b.text === 'string' ? b.text : ''
    if (!text.trim()) return res.status(400).json({ error: 'write a few words first' })
    const acct = req.caseyAccount
    const out = await addFeedback(store, { from: `login:${acct.username}`, tier: roleOf(acct), lang: typeof b.language === 'string' ? b.language : '', text, source: 'gui' })
    if (!out.ok) return res.status(out.reason === 'limit' ? 429 : 400).json({ error: out.reason === 'limit' ? 'that is a lot of feedback for one day; thank you, please try again tomorrow' : 'write a few words first' })
    res.json({ ok: true, max_chars: MAX_TEXT })
  }
}

export function getFeedback({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const names = new Map()
    let logins = null
    const nameOf = async (from) => {
      if (String(from).startsWith('login:')) {
        const user = String(from).slice(6)
        if (!logins) logins = new Map((await store.t.list('operator_account', {}, { limit: 500 }).catch(() => [])).map(a => [a.username, String(a.display_name || '').trim()]))
        return logins.get(user) || '(no name)'
      }
      if (!names.has(from)) { const c = await store.getContact(from).catch(() => null); const n = String(c?.display_name || '').trim(); names.set(from, n && !/^\+?[\d\s()-]{6,}$/.test(n) ? n : '(no name)') }
      return names.get(from)
    }
    res.json(await listFeedback(store, { limit: req.query.limit, nameOf }))
  }
}

const ROUTES = [
  ['post', '/api/feedback', postFeedback],
  ['get', '/api/feedback', getFeedback],
]

export function registerFeedback(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
