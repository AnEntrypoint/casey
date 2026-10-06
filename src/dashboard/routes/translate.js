import { mountRoutes } from './register.js'
import { translateEvent, TranslateError, translateModel } from '../../translate.js'

export { translateModel }

const fail = (res, status, code, error, extra = {}) => res.status(status).json({ error, code, ...extra })

export function postTranslateEvent({ store, authed, actingOperator, callLLM }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const acct = req.caseyAccount
    if (acct && acct.role === 'viewer') return fail(res, 403, 'role_forbidden', 'This is not available for your login.')
    const c = await store.getCase(req.params.id)
    if (!c || c.channel === 'system') return res.status(404).json({ error: 'not found' })
    const ev = await store.t.get('event', req.params.eventId).catch(() => null)
    if (!ev || ev.case_id !== c.id) return res.status(404).json({ error: 'message not found on this report' })
    try {
      const out = await translateEvent({ store, caseRow: c, ev, callLLM, rateKey: acct?.id || acct?.username || 'anon', requestedBy: actingOperator ? actingOperator(req).id : null })
      res.json({ event_id: ev.id, english: out.text, language: out.language, cached: out.cached, label: out.label })
    } catch (e) {
      if (!(e instanceof TranslateError)) throw e
      if (e.extra.retry_after) res.setHeader('Retry-After', String(e.extra.retry_after))
      fail(res, e.status, e.code, e.message, e.extra)
    }
  }
}

const ROUTES = [
  ['post', '/api/cases/:id/events/:eventId/translate', postTranslateEvent],
]

export function registerTranslate(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
