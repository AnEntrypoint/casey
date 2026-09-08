// Operator account management (admin-only CRUD) + the operator roster +
// session-revocation self-service. Adding/disabling/deleting a teammate's
// login is the "administration handles it" lever the AUTH MODEL note in
// server.js describes for a lost/compromised device.
//
// deps: store, wrap, actingOperator, authed, isAdmin, getRoster, listAccounts,
//   createAccount, setAccountDisabled, deleteAccount, revokeAccountSessions,
//   getAccount, issueSession, sessionCookieHeader
import { mountRoutes } from './register.js'

// Account rows carry password_hash/password_salt/session_epoch. This is the one
// allowlist through which one may reach JSON -- module-level and named, so the
// credential columns stay unemitted by construction rather than by each
// handler remembering.
export const publicAccount = (a) => ({ id: a.id, username: a.username, display_name: a.display_name, role: a.role, disabled: a.disabled === '1', last_login_at: a.last_login_at || null })

// The operator roster + who the server resolved THIS request to (from the
// logged-in session), so the SPA can label every action with a real name.
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
      const { username, password, display_name, role } = req.body || {}
      const acct = await createAccount(store, { username, password, displayName: display_name, role })
      res.status(201).json({ account: publicAccount(acct) })
    } catch (e) { res.status(400).json({ error: e.message }) }
  }
}

// An admin locking out their OWN only-admin account would be a self-lockout
// with no CLI recovery expectation set for the operator -- allowed (the CLI
// `casey operators` command is the documented break-glass path), but never
// silently -- the client shows a confirm on this action.
export function postAccountDisabled(disabled) {
  return ({ store, authed, isAdmin, setAccountDisabled }) => async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    try { await setAccountDisabled(store, req.params.id, disabled); res.json({ ok: true }) }
    catch (e) { res.status(400).json({ error: e.message }) }
  }
}

// Session revocation (session-auth-hardening-revocation PRD row): admin-forced
// revoke on ANY account (a leaked cookie, a departing team member) -- bumps
// session_epoch, every outstanding token for that account fails its next
// request. Same auth gate as disable/enable (admin only, matches "this is an
// account-management action" not a self-service one).
export function postRevokeSessions({ store, authed, isAdmin, revokeAccountSessions }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    try { await revokeAccountSessions(store, req.params.id); res.json({ ok: true }) }
    catch (e) { res.status(400).json({ error: e.message }) }
  }
}

// Self-service "log out everywhere" -- any authed operator (not admin-only:
// a leaked cookie or a lost/stolen device is every operator's own risk to
// clear, not something that should require asking an admin). Revokes the
// CALLER's own account only (req.caseyAccount.id, never req.params/body),
// then immediately re-issues a fresh cookie at the new epoch so the request
// that triggered this does not itself get logged out.
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

export function deleteAccountRoute({ store, authed, isAdmin, deleteAccount }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    try { await deleteAccount(store, req.params.id); res.json({ ok: true }) }
    catch (e) { res.status(400).json({ error: e.message }) }
  }
}

const ROUTES = [
  ['get', '/api/operators', getOperators],
  ['get', '/api/accounts', getAccounts],
  ['post', '/api/accounts', postAccount, { raw: true }],
  ['post', '/api/accounts/:id/disable', postAccountDisabled(true), { raw: true }],
  ['post', '/api/accounts/:id/enable', postAccountDisabled(false), { raw: true }],
  ['post', '/api/accounts/:id/revoke-sessions', postRevokeSessions, { raw: true }],
  ['post', '/api/logout-everywhere', postLogoutEverywhere, { raw: true }],
  ['delete', '/api/accounts/:id', deleteAccountRoute, { raw: true }],
]

export function registerAccounts(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
