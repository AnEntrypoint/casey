// Operator account management (admin-only CRUD) + the operator roster +
// session-revocation self-service. Adding/disabling/deleting a teammate's
// login is the "administration handles it" lever the AUTH MODEL note in
// server.js describes for a lost/compromised device.
//
// deps: store, wrap, actingOperator, authed, isAdmin, getRoster, listAccounts,
//   createAccount, setAccountDisabled, deleteAccount, revokeAccountSessions,
//   getAccount, issueSession, sessionCookieHeader
export function registerAccounts(app, deps) {
  const {
    store, wrap, actingOperator, authed, isAdmin, getRoster, listAccounts,
    createAccount, setAccountDisabled, deleteAccount, revokeAccountSessions,
    getAccount, issueSession, sessionCookieHeader,
  } = deps

  // The operator roster + who the server resolved THIS request to (from the
  // logged-in session), so the SPA can label every action with a real name.
  app.get('/api/operators', wrap(async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const roster = await getRoster()
    res.json({ operators: roster, current: actingOperator(req).id, attributed: roster.length > 0 })
  }))

  // Account management -- admin-only. Never returns password_hash/password_salt.
  const publicAccount = (a) => ({ id: a.id, username: a.username, display_name: a.display_name, role: a.role, disabled: a.disabled === '1', last_login_at: a.last_login_at || null })
  app.get('/api/accounts', wrap(async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    res.json({ accounts: (await listAccounts(store)).map(publicAccount) })
  }))
  app.post('/api/accounts', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    try {
      const { username, password, display_name, role } = req.body || {}
      const acct = await createAccount(store, { username, password, displayName: display_name, role })
      res.status(201).json({ account: publicAccount(acct) })
    } catch (e) { res.status(400).json({ error: e.message }) }
  })
  app.post('/api/accounts/:id/disable', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    // An admin locking out their OWN only-admin account would be a self-lockout
    // with no CLI recovery expectation set for the operator -- allowed (the CLI
    // `casey operators` command is the documented break-glass path), but never
    // silently -- the client shows a confirm on this action.
    try { await setAccountDisabled(store, req.params.id, true); res.json({ ok: true }) }
    catch (e) { res.status(400).json({ error: e.message }) }
  })
  app.post('/api/accounts/:id/enable', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    try { await setAccountDisabled(store, req.params.id, false); res.json({ ok: true }) }
    catch (e) { res.status(400).json({ error: e.message }) }
  })
  // Session revocation (session-auth-hardening-revocation PRD row): admin-forced
  // revoke on ANY account (a leaked cookie, a departing team member) -- bumps
  // session_epoch, every outstanding token for that account fails its next
  // request. Same auth gate as disable/enable (admin only, matches "this is an
  // account-management action" not a self-service one).
  app.post('/api/accounts/:id/revoke-sessions', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    try { await revokeAccountSessions(store, req.params.id); res.json({ ok: true }) }
    catch (e) { res.status(400).json({ error: e.message }) }
  })
  // Self-service "log out everywhere" -- any authed operator (not admin-only:
  // a leaked cookie or a lost/stolen device is every operator's own risk to
  // clear, not something that should require asking an admin). Revokes the
  // CALLER's own account only (req.caseyAccount.id, never req.params/body),
  // then immediately re-issues a fresh cookie at the new epoch so the request
  // that triggered this does not itself get logged out.
  app.post('/api/logout-everywhere', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    try {
      await revokeAccountSessions(store, req.caseyAccount.id)
      const fresh = await getAccount(store, req.caseyAccount.id)
      const token = issueSession(fresh.id, { epoch: Number(fresh.session_epoch) || 0 })
      res.set('Set-Cookie', sessionCookieHeader(token))
      res.json({ ok: true })
    } catch (e) { res.status(400).json({ error: e.message }) }
  })
  app.delete('/api/accounts/:id', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    try { await deleteAccount(store, req.params.id); res.json({ ok: true }) }
    catch (e) { res.status(400).json({ error: e.message }) }
  })
}
