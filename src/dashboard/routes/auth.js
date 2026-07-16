// Session, login, and the public contact report form. These routes -- plus the
// session-resolving and auth-gate MIDDLEWARE -- must register before every
// other route module, since later modules assume req.caseyAccount is already
// resolved and the auth gate has already run. registerAuth(app, deps) does
// both: registers the pre-auth session middleware + public routes, then the
// auth gate middleware + the static mounts (/design, /vendor, /media) that
// must sit between the gate and the rest of the API.
//
// deps: store, express, path, DESIGN_DIR, LEAFLET_DIR, MARKERCLUSTER_DIR,
//   COOKIE_NAME, parseCookies, sessionCookieHeader, clearCookieHeader,
//   issueSession, verifySession, findAccountByUsername, verifyPassword,
//   markLogin, getAccount, changePassword, esc, wrap
export function registerAuth(app, deps) {
  const {
    store, express, path, DESIGN_DIR, LEAFLET_DIR, MARKERCLUSTER_DIR,
    COOKIE_NAME, parseCookies, sessionCookieHeader, clearCookieHeader,
    issueSession, verifySession, findAccountByUsername, verifyPassword,
    markLogin, getAccount, changePassword, esc, wrap,
  } = deps

  // Session gate: a valid casey_session cookie (see dashboard/auth.js) resolves
  // to a real operator_account row. Middleware runs on every request BEFORE
  // route handlers so actingOperator(req) below can stay a SYNCHRONOUS reader
  // of the pre-resolved req.caseyAccount -- every existing call site
  // (actingOperator(req) sprinkled through dozens of route handlers) keeps
  // working unchanged rather than needing an await added at each site.
  app.use(async (req, res, next) => {
    req.caseyAccount = null
    try {
      const cookies = parseCookies(req.get('cookie'))
      const claim = verifySession(cookies[COOKIE_NAME])
      if (claim) {
        const acct = await getAccount(store, claim.id)
        // session_epoch revocation: a token's own epoch must match the
        // account's LIVE current epoch. changePassword()/revokeAccountSessions()
        // bump the stored epoch, so an outstanding token issued before that
        // bump carries the OLD epoch and fails here -- "log out everywhere"
        // with zero session-table storage (see auth.js for the full design
        // rationale). A pre-epoch token (claim.epoch defaults to 0 when the
        // field was absent from an old cookie) still matches an account whose
        // session_epoch has never been bumped (also 0), so upgrading to this
        // code does not force-logout every already-logged-in operator.
        const liveEpoch = Number(acct?.session_epoch) || 0
        if (acct && acct.disabled !== '1' && claim.epoch === liveEpoch) req.caseyAccount = acct
      }
    } catch { /* a broken/tampered cookie just means not-logged-in, never a crash */ }
    next()
  })

  // Public contact-facing report form -- no token required.
  // The ref acts as the shared secret: contacts only know their own ref,
  // and report fields are non-sensitive (location, symptoms, contact info).
  // GET /report?ref=REF  -> HTML form for that case (or blank ref input)
  // POST /report         -> submit fields; redirect back with ?done=1 or ?err=...
  // Fields shown on the public contact form. [key, label, placeholder, isTextarea, isVisitCritical]
  const PUBLIC_FIELDS = [
    ['species', 'Which animals?', 'e.g. cattle, sheep, goats, pigs', false, true],
    ['symptoms', 'What signs are you seeing?', 'e.g. drooling, limping, not eating, sudden death', true, true],
    ['location', 'Where are the animals?', 'Farm name, nearest town, or GPS coordinates', false, true],
    ['how_to_find', 'How do we find the place?', 'Road name, landmark, or directions from the nearest town', true, true],
    ['farmer_available', 'Will the farmer be there?', 'e.g. yes, or phone first on 082...', false, true],
    ['contact_fallback', 'Any other contact person?', 'Name and phone number if different from this one', false, true],
    ['affected_count', 'How many are affected?', 'e.g. 5', false, false],
    ['dead_count', 'How many have died?', 'e.g. 2 (write 0 if none)', false, false],
    ['onset', 'When did it start?', 'e.g. yesterday morning, 3 days ago', false, false],
    ['suspected_disease', 'What do you think it might be?', 'e.g. foot-and-mouth, lumpy skin, not sure', false, false],
    ['recent_movement', 'Have the animals moved recently?', 'e.g. yes, bought from market last week', false, false],
    ['access_notes', 'Any access or travel notes?', 'e.g. gravel road, locked gate - call first', true, false],
    ['notes', 'Anything else to note?', 'Any extra information', true, false],
  ]

  function publicFormHtml({ ref = '', caseRow = null, done = false, err = '' } = {}) {
    let report = {}
    try { report = caseRow?.report ? JSON.parse(caseRow.report) : {} } catch { report = {} }
    const vcTotal = PUBLIC_FIELDS.filter(f => f[4]).length
    const vcFilled = PUBLIC_FIELDS.filter(([k,,,,vc]) => vc && report[k] != null && String(report[k]).trim() !== '').length
    const allFilled = vcFilled >= vcTotal
    const progressBar = caseRow ? `<div class="progress-wrap" aria-label="Essential fields: ${vcFilled} of ${vcTotal} filled">
      <div class="progress-label">${allFilled ? 'All essential details filled -- thank you!' : `Essential details: ${vcFilled} of ${vcTotal} filled`}</div>
      <div class="progress-track"><div class="progress-bar${allFilled ? ' done' : ''}" style="width:${Math.round(vcFilled/vcTotal*100)}%"></div></div>
    </div>` : ''
    let inEssential = false, inExtra = false
    const fieldRows = PUBLIC_FIELDS.map(([k, label, hint, isArea, isVC]) => {
      let section = ''
      if (isVC && !inEssential) { inEssential = true; section = '<div class="section-head">Essential details for a visit</div>' }
      if (!isVC && !inExtra) { inExtra = true; section = '<div class="section-head">Extra details (helpful but not required)</div>' }
      const val = esc(report[k] || '')
      const inp = isArea
        ? `<textarea name="${k}" rows="3" placeholder="${esc(hint)}" maxlength="4000">${val}</textarea>`
        : `<input type="text" name="${k}" placeholder="${esc(hint)}" value="${val}" maxlength="500">`
      const vcMark = isVC ? ' <span class="req" aria-label="essential">*</span>' : ''
      return `${section}<div class="field${isVC ? ' vc' : ''}"><label>${esc(label)}${vcMark}</label>${inp}</div>`
    }).join('')
    const banner = done
      ? `<div class="banner ok">Your details have been saved. Thank you -- the team will be in touch.</div>`
      : err ? `<div class="banner err">${esc(err)}</div>` : ''
    const caseInfo = caseRow
      ? `<div class="case-info"><strong>Reference: ${esc(caseRow.ref)}</strong> &ndash; ${esc(caseRow.subject || 'Field report')}
         <button type="button" class="copy-link-btn" data-ref="${esc(caseRow.ref)}">Share link</button></div>`
      : ''
    const refBlock = caseRow ? `<input type="hidden" name="ref" value="${esc(ref)}">` : `
      <div class="field"><label>Your reference number</label>
      <input type="text" name="ref" value="${esc(ref)}" placeholder="e.g. CASE-001" maxlength="50">
      <div class="hint">This was shared with you when you first reported. Check your messages. If you do not have one, enter your phone number below instead.</div></div>
      <div class="field"><label>Or your phone number</label>
      <input type="tel" name="phone" placeholder="+27 82 123 4567" maxlength="30">
      <div class="hint">South African number -- we use this to find your report.</div></div>`
    return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Animal report form</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,sans-serif;background:#f4f6f9;color:#1a1f29;min-height:100vh}
  .wrap{max-width:540px;margin:0 auto;padding:24px 16px 60px}
  h1{font-size:1.3em;margin:0 0 4px;color:#1a3a5c}
  .sub{font-size:14px;color:#5a6675;margin:0 0 20px}
  .case-info{background:#e8f0fa;border:1px solid #b8d0ee;border-radius:8px;padding:10px 14px;margin:0 0 16px;font-size:14px;color:#1a3a5c}
  .banner{border-radius:8px;padding:12px 14px;margin:0 0 20px;font-size:14px}
  .banner.ok{background:#e8f7ee;border:1px solid #9ed8b4;color:#1a5c35}
  .banner.err{background:#fdeaea;border:1px solid #f0a0a0;color:#5c1a1a}
  .progress-wrap{margin:0 0 20px}
  .progress-label{font-size:13px;color:#5a6675;margin-bottom:5px}
  .progress-track{background:#dce8f5;border-radius:4px;height:7px;overflow:hidden}
  .progress-bar{background:#f0a030;height:100%;border-radius:4px;transition:width .3s}
  .progress-bar.done{background:#2a9e5c}
  .field{margin:0 0 16px}
  .field.vc label{color:#1a3a5c}
  label{display:block;font-size:14px;font-weight:600;margin:0 0 5px}
  .req{color:#c06000;font-weight:700}
  input[type=text],textarea{width:100%;border:1px solid #c8d0da;border-radius:6px;
    padding:11px 12px;font-size:16px;font-family:inherit;background:#fff;color:#1a1f29;
    min-height:44px;-webkit-appearance:none}
  input:focus,textarea:focus{outline:2px solid #2f6fb0;border-color:#2f6fb0}
  textarea{resize:vertical;min-height:80px}
  .section-head{font-size:12px;font-weight:700;letter-spacing:.06em;color:#2f6fb0;
    text-transform:uppercase;margin:24px 0 10px;padding-bottom:4px;border-bottom:2px solid #dce8f5}
  button[type=submit]{width:100%;background:#2f6fb0;color:#fff;border:0;border-radius:8px;
    padding:15px;font-size:17px;font-weight:600;cursor:pointer;margin-top:10px;min-height:52px}
  button:disabled{opacity:.6;cursor:default}
  .req-note{font-size:12px;color:#7a8a9a;margin:0 0 8px}
  .copy-link-btn{background:none;border:1px solid #b8d0ee;border-radius:5px;color:#2f6fb0;font-size:12px;padding:3px 8px;cursor:pointer;margin-left:8px;vertical-align:middle}
  .copy-link-btn:hover{background:#dce8f5}
  .field-err{font-size:12px;color:#a00;margin-top:4px;display:none}
  .field-err.show{display:block}
  footer{text-align:center;font-size:12px;color:#9aa6b2;margin-top:24px}
</style></head><body>
<div class="wrap">
  <h1>Animal health report</h1>
  <p class="sub">Please fill in as many details as you can. Fields marked * are needed before a team can visit.</p>
  ${banner}${caseInfo}${progressBar}
  <form method="POST" action="/report">
    ${refBlock}
    ${fieldRows}
    <p class="req-note">* Essential for a field visit</p>
    <button type="submit">Send details</button>
  </form>
  <footer>Animal disease surveillance &ndash; South Africa</footer>
</div>
<script>
  const btn = document.querySelector('button[type=submit]')
  // Share-link copy button: reads the ref from a data attribute (plain HTML
  // escaping, no JS-string-literal splicing) rather than an inline onclick
  // that mixed HTML-entity escaping with JS-string context -- a quote in the
  // ref would have broken out of the JS string (latent, not currently
  // exploitable since ref is always server-generated, but fragile).
  const copyBtn = document.querySelector('.copy-link-btn')
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const u = location.href.split('?')[0] + '?ref=' + encodeURIComponent(copyBtn.dataset.ref)
      const done = () => { copyBtn.textContent = 'Copied!'; setTimeout(() => { copyBtn.textContent = 'Share link' }, 2000) }
      navigator.clipboard?.writeText(u).then(done).catch(() => prompt('Copy this link:', u))
    })
  }
  // Phone field normalization and inline validation
  const phoneEl = document.querySelector('input[name=phone]')
  if (phoneEl) {
    let errEl = document.createElement('div')
    errEl.className = 'field-err'
    errEl.id = 'phone-err'
    phoneEl.parentNode.appendChild(errEl)
    phoneEl.addEventListener('blur', () => {
      const v = phoneEl.value.trim()
      if (!v) { errEl.className = 'field-err'; return }
      const d = v.replace(/[^0-9+]/g, '')
      if (/^0[0-9]{9}$/.test(d)) { phoneEl.value = '+27' + d.slice(1); errEl.className = 'field-err'; return }
      if (/^27[0-9]{9}$/.test(d)) { phoneEl.value = '+' + d; errEl.className = 'field-err'; return }
      if (/^\\+27[0-9]{9}$/.test(d)) { errEl.className = 'field-err'; return }
      errEl.textContent = 'Please use a South African number: 0821234567 or +27821234567'
      errEl.className = 'field-err show'
    })
  }
  document.querySelector('form').addEventListener('submit', (e) => {
    // Block submit if phone has visible error
    const pe = document.getElementById('phone-err')
    if (pe && pe.classList.contains('show')) { e.preventDefault(); return }
    btn.disabled = true; btn.textContent = 'Sending...'
  })
</script>
</body></html>`
  }

  // The public /report form has no auth (the ref is the shared secret), so it
  // needs its own throttle: the 8-char ref and the SA phone-number space are
  // both brute-forceable in unlimited requests. Scoped to these two routes only
  // -- never touches the authed() /api surface. Sweeps stale buckets so the map
  // cannot grow unbounded under sustained traffic.
  const REPORT_RATE_LIMIT = 10
  const REPORT_RATE_WINDOW_MS = 60000
  const reportRateBuckets = new Map()
  setInterval(() => {
    const now = Date.now()
    for (const [ip, b] of reportRateBuckets) {
      if (now - b.windowStart > REPORT_RATE_WINDOW_MS) reportRateBuckets.delete(ip)
    }
  }, REPORT_RATE_WINDOW_MS).unref?.()
  function reportRateLimited(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown'
    const now = Date.now()
    let b = reportRateBuckets.get(ip)
    if (!b || now - b.windowStart > REPORT_RATE_WINDOW_MS) {
      b = { count: 0, windowStart: now }
      reportRateBuckets.set(ip, b)
    }
    b.count++
    if (b.count > REPORT_RATE_LIMIT) return res.status(429).type('html').send(publicFormHtml({ err: 'Too many requests. Please wait a moment and try again.' }))
    next()
  }

  app.get('/report', reportRateLimited, async (req, res) => {
    const ref = String(req.query.ref || '').slice(0, 50).trim()
    const done = req.query.done === '1'
    const err = String(req.query.err || '').slice(0, 200)
    if (!ref) return res.type('html').send(publicFormHtml({ done, err }))
    try {
      const found = await store.getCaseByRef(ref)
      if (!found) return res.type('html').send(publicFormHtml({ ref, err: err || `Reference "${ref}" was not found. Please check and try again.` }))
      res.type('html').send(publicFormHtml({ ref, caseRow: found, done, err }))
    } catch (e) { res.status(500).type('html').send(publicFormHtml({ ref, err: 'Something went wrong. Please try again in a moment.' })) }
  })

  app.post('/report', reportRateLimited, async (req, res) => {
    const ref = String(req.body.ref || '').slice(0, 50).trim()
    const phoneRaw = String(req.body.phone || '').replace(/[\s\-()]/g, '').slice(0, 30)
    if (!ref && !phoneRaw) return res.redirect('/report?err=' + encodeURIComponent('Please enter your reference number or phone number.'))
    try {
      let found = null
      if (ref) {
        found = await store.getCaseByRef(ref)
        if (!found) return res.redirect('/report?ref=' + encodeURIComponent(ref) + '&err=' + encodeURIComponent(`Reference "${ref}" was not found. Please check, or enter your phone number instead.`))
      } else {
        // Phone-based lookup: normalise to +27XXXXXXXXX, search by external_id
        const validPhone = /^0[0-9]{9}$/.test(phoneRaw) || /^\+27[0-9]{9}$/.test(phoneRaw)
        if (!validPhone) return res.redirect('/report?err=' + encodeURIComponent('Phone number not recognised. Please use a South African number like 0821234567 or +27821234567.'))
        const normPhone = phoneRaw.startsWith('0') ? '+27' + phoneRaw.slice(1) : phoneRaw
        // Try to find existing case by external_id (WhatsApp stores as 27XXXXXXXXX)
        const waPhone = normPhone.replace(/^\+/, '')
        const all = await store.listCases({}, { limit: 10000, offset: 0 })
        found = all.find(c => {
          const eid = String(c.external_id || '')
          return eid === normPhone || eid === waPhone || eid === phoneRaw
        }) || null
        if (!found) {
          // Create a new case from the phone number
          const { case: nc } = await store.findOrCreateCase({ channel: 'web', external_id: normPhone, contact: { phone: normPhone }, subject: 'Field report via web form' })
          found = nc
          // Tag as public form intake
          try {
            const tags = String(nc.tags || '').split(',').map(t => t.trim()).filter(Boolean)
            if (!tags.includes('intake_mode:public_form')) {
              await store.updateCase(nc.id, { tags: [...tags, 'intake_mode:public_form'].join(',') }, { id: 'contact', role: 'contact' })
            }
          } catch { /* best-effort */ }
          await store.appendEvent(nc.id, { kind: 'note', actor: 'system', text: 'Case created via public web form (phone number entry)' })
        }
      }
      const incoming = {}
      for (const [k] of PUBLIC_FIELDS) {
        const v = req.body[k]
        if (v == null || typeof v !== 'string') continue
        const trimmed = v.trim().slice(0, 4000)
        if (trimmed) incoming[k] = trimmed
      }
      if (Object.keys(incoming).length) {
        const mergeResult = await store.mergeReport(found.id, incoming, { id: 'contact', role: 'contact' })
        // Any error -- including 'observe' (the case is operator-frozen and not
        // accepting automatic writes) -- must NOT redirect to done=1: a farmer who
        // submitted the form deserves to know their details were not saved, not a
        // false success page. 'observe' gets its own plain message rather than the
        // generic error string, since nothing actually went wrong on casey's side.
        if (mergeResult.error === 'observe') {
          return res.redirect('/report?ref=' + encodeURIComponent(ref) + '&err=' + encodeURIComponent('This report is not currently accepting updates online. Please contact the team directly.'))
        }
        if (mergeResult.error) {
          return res.redirect('/report?ref=' + encodeURIComponent(ref) + '&err=' + encodeURIComponent('Something went wrong saving your details. Please try again.'))
        }
        await store.appendEvent(found.id, { kind: 'action', actor: 'contact', text: `contact updated report via web form: ${Object.keys(incoming).join(', ')}`, data: incoming })
        // Tag intake source (add public_form if not already present)
        try {
          const existingTags = String(found.tags || '').split(',').map(t => t.trim()).filter(Boolean)
          if (!existingTags.includes('intake_mode:public_form')) {
            await store.updateCase(found.id, { tags: [...existingTags, 'intake_mode:public_form'].join(',') }, { id: 'contact', role: 'contact' })
          }
        } catch { /* best-effort; form still submitted even if tag fails */ }
      }
      const foundRef = found?.ref || ref
      res.redirect('/report?ref=' + encodeURIComponent(foundRef) + '&done=1')
    } catch (e) { res.redirect('/report?ref=' + encodeURIComponent(ref) + '&err=' + encodeURIComponent('Something went wrong. Please try again.')) }
  })

  // Readiness probe for orchestrators/load balancers: is the system of record
  // actually reachable RIGHT NOW (a real store query succeeds), not merely "the
  // HTTP server booted"? Distinct from /api/health, which reports AI-helper and
  // gateway liveness; a process can serve HTTP with a wedged or unopened store and
  // /api/health would still answer. This exercises the store with the cheapest real
  // read (a count) and returns 200 {ready:true} or 503 {ready:false,error}. It is
  // UNGATED on purpose -- a k8s/LB probe has no dashboard token, and the response
  // leaks nothing sensitive (a boolean + a short error string, no case data). Placed
  // before the auth middleware so the token gate never 401s a readiness check.
  app.get('/api/ready', async (req, res) => {
    const started = Date.now()
    try {
      await store.countCases({})
      res.json({ ready: true, store: 'ok', took_ms: Date.now() - started })
    } catch (e) {
      // Bound the error so a hostile/huge store error cannot bloat the probe body.
      res.status(503).json({ ready: false, store: 'unreachable', error: String(e.message || e).slice(0, 200) })
    }
  })

  // Login: username + password against a real operator_account row (see
  // dashboard/auth.js). On success, sets an HttpOnly session cookie and
  // returns the operator's display info -- never the password hash/salt.
  // Rate-limiting/lockout is intentionally NOT added here: this is a
  // low-stakes field-team login (see the AUTH MODEL note at the top of this
  // file), and a lockout mechanism is itself a denial-of-service surface
  // against a teammate's account. scrypt's own cost already makes brute-force
  // impractical at any real request rate.
  app.post('/api/login', wrap(async (req, res) => {
    const { username, password } = req.body || {}
    const acct = await findAccountByUsername(store, username)
    if (!acct || acct.disabled === '1' || !verifyPassword(password, acct.password_salt, acct.password_hash)) {
      return res.status(401).json({ error: 'invalid username or password' })
    }
    const token = issueSession(acct.id, { epoch: Number(acct.session_epoch) || 0 })
    res.set('Set-Cookie', sessionCookieHeader(token))
    markLogin(store, acct.id).catch(() => {}) // best-effort, never blocks login
    res.json({ ok: true, username: acct.username, display_name: acct.display_name, role: acct.role })
  }))
  app.post('/api/logout', (req, res) => {
    res.set('Set-Cookie', clearCookieHeader())
    res.json({ ok: true })
  })
  // Who the current session belongs to, for the SPA to render "logged in as
  // X" / redirect to the login screen when there is no valid session. Safe to
  // leave ungated (it just echoes back req.caseyAccount, already resolved
  // from the cookie by the middleware above) -- no lookup happens for an
  // absent/invalid cookie.
  app.get('/api/whoami', (req, res) => {
    if (!req.caseyAccount) return res.json({ authed: false })
    const a = req.caseyAccount
    res.json({ authed: true, username: a.username, display_name: a.display_name, role: a.role, must_change_password: a.must_change_password === '1' })
  })
  // Forced password change: the ONE route a must_change_password account may
  // reach besides login/logout/whoami/change-password itself (gated below).
  // A printed bootstrap password (or any account an admin creates with the
  // flag set) can never be used as a standing credential past the first login.
  app.post('/api/change-password', async (req, res) => {
    if (!req.caseyAccount) return res.status(401).json({ error: 'unauthorized' })
    try {
      const { new_password } = req.body || {}
      await changePassword(store, req.caseyAccount.id, new_password)
      res.json({ ok: true })
    } catch (e) { res.status(400).json({ error: e.message }) }
  })

  app.use((req, res, next) => {
    if (req.path.startsWith('/design') || req.path.startsWith('/vendor')) return next()
    if (req.path === '/api/login' || req.path === '/api/logout' || req.path === '/api/whoami') return next()
    // The SPA shell itself (page markup + its own CSS/JS, moved to static
    // files under public/ this session) must load with no session, exactly
    // like the original inline PAGE constant's unconditional `app.get('/', ...)`
    // handler did -- the page's OWN client-side JS is what shows the login
    // screen and makes the gated /api/* calls; gating the shell itself would
    // 401 before a browser ever gets far enough to render a login form. The
    // PWA routes (icon/manifest/service-worker/offline page) were likewise
    // always unconditional in the original -- a service worker cannot even
    // register if fetching its own script requires an existing session.
    if (req.path === '/' || req.path === '/index.html' || req.path === '/app.js' || req.path === '/app.css') return next()
    if (req.path === '/icon.svg' || req.path === '/manifest.json' || req.path === '/sw.js' || req.path === '/offline.html') return next()
    if (!req.caseyAccount) return res.status(401).json({ error: 'unauthorized' })
    // A must_change_password account is authed but locked to ONLY the
    // change-password route until it clears the flag -- every other route
    // (including reading case data) is refused with a distinct, SPA-
    // detectable error code so the frontend can route straight to a
    // change-password screen instead of a generic login redirect.
    if (req.caseyAccount.must_change_password === '1' && req.path !== '/api/change-password') {
      return res.status(403).json({ error: 'must change password before continuing', code: 'must_change_password' })
    }
    next()
  })

  app.use('/design', express.static(DESIGN_DIR))
  app.use('/vendor/leaflet', express.static(LEAFLET_DIR))
  app.use('/vendor/leaflet.markercluster', express.static(MARKERCLUSTER_DIR))
  // Downloaded photo/voice-note bytes (case-store.js saveMedia), gated like every
  // other case-data route -- unlike /design and /vendor (static UI assets with no
  // case content) this serves real field-worker media, so it stays behind the
  // token middleware above (mounted after it, no exemption added).
  app.use('/media', express.static(path.join(store.dataDir, 'media')))
}
