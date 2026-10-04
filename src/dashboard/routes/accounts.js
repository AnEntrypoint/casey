import { mountRoutes } from './register.js'
import { FIELD_ROLES } from '../roles.js'

export const publicAccount = (a) => ({ id: a.id, username: a.username, display_name: a.display_name, role: a.role, contact_phone: a.contact_phone || null, disabled: a.disabled === '1', last_login_at: a.last_login_at || null })

export function getOperators({ authed, actingOperator, getRoster }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const roster = await getRoster()
    res.json({ operators: roster, current: actingOperator(req).id, attributed: roster.length > 0 })
  }
}

export function getAccounts({ store, authed, isAdmin, listAccounts }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    res.json({ accounts: (await listAccounts(store)).map(publicAccount) })
  }
}

export function postAccount({ store, authed, isAdmin, createAccount }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    try {
      const { username, password, display_name, role, contact_phone } = req.body || {}
      const acct = await createAccount(store, { username, password, displayName: display_name, role, contactPhone: contact_phone })
      res.status(201).json({ account: publicAccount(acct) })
    } catch (e) { res.status(400).json({ error: e.message }) }
  }
}

export function postAccountContactPhone({ store, authed, isAdmin, setAccountContactPhone }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    try { await setAccountContactPhone(store, req.params.id, (req.body || {}).contact_phone); res.json({ ok: true }) }
    catch (e) { res.status(400).json({ error: e.message }) }
  }
}

export function postAccountDisabled(disabled) {
  return ({ store, authed, isAdmin, setAccountDisabled }) => async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    try { await setAccountDisabled(store, req.params.id, disabled); res.json({ ok: true }) }
    catch (e) { res.status(400).json({ error: e.message }) }
  }
}

export function postRevokeSessions({ store, authed, isAdmin, revokeAccountSessions }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    try { await revokeAccountSessions(store, req.params.id); res.json({ ok: true }) }
    catch (e) { res.status(400).json({ error: e.message }) }
  }
}

export function postLogoutEverywhere({ store, authed, revokeAccountSessions, getAccount, issueSession, sessionCookieHeader }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    try {
      await revokeAccountSessions(store, req.caseyAccount.id)
      const fresh = await getAccount(store, req.caseyAccount.id)
      const token = issueSession(fresh.id, { epoch: Number(fresh.session_epoch) || 0 })
      res.set('Set-Cookie', sessionCookieHeader(token))
      res.json({ ok: true })
    } catch (e) { res.status(400).json({ error: e.message }) }
  }
}

export function deleteAccountRoute({ store, authed, isAdmin, deleteAccount, getAccount }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    try {
      const target = await getAccount(store, req.params.id)
      await deleteAccount(store, req.params.id)
      if (target && FIELD_ROLES.includes(target.role)) await store.releaseCasesHeldBy(target.username, 'the login holding it was deleted', { id: 'account-removal', role: 'system' })
      res.json({ ok: true })
    }
    catch (e) { res.status(400).json({ error: e.message }) }
  }
}

const ROUTES = [
  ['get', '/api/operators', getOperators],
  ['get', '/api/accounts', getAccounts],
  ['post', '/api/accounts', postAccount, { raw: true }],
  ['post', '/api/accounts/:id/disable', postAccountDisabled(true), { raw: true }],
  ['post', '/api/accounts/:id/enable', postAccountDisabled(false), { raw: true }],
  ['post', '/api/accounts/:id/contact-phone', postAccountContactPhone, { raw: true }],
  ['post', '/api/accounts/:id/revoke-sessions', postRevokeSessions, { raw: true }],
  ['post', '/api/logout-everywhere', postLogoutEverywhere, { raw: true }],
  ['delete', '/api/accounts/:id', deleteAccountRoute, { raw: true }],
]

export function registerAccounts(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
