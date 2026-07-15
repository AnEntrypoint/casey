// dashboard/server.js -- casey's observe + manual-edit UI.
//
// Serves a small single-page app styled with anentrypoint-design's CSS, backed
// by a JSON API over the CaseStore. This is the human surface of casey:
// - observe   read every case, open one, read its full timeline
// - edit      change subject/summary/priority/tags/assignee/autonomy
// - override  force any valid workflow transition as an operator
// - reply     send a message to the contact on their channel as a human
//
// Everything written here goes through the same CaseStore the agent uses, so
// agent and operator share one timeline. The API is the operator-override
// surface, gated by a per-operator login (see dashboard/auth.js).
//
// AUTH MODEL: username/password per operator, a real (if simple) login screen
// familiar to a not-necessarily-tech-literate field-organisation team -- no
// bearer token to copy/paste or lose. A fresh deployment auto-creates a single
// bootstrap admin account (printed once to the server log) so there is always
// a way in; that admin creates named accounts for the rest of the team from
// the dashboard's user-management panel (admin-only), or via `casey.js
// operators` on the CLI for break-glass recovery (lost admin password,
// scripted provisioning). Sessions are stateless HMAC-signed cookies (no
// server-side session table to keep in sync across the hot-reload supervisor's
// worker restarts -- AGENTS.md). X-Casey-Operator is retired: the logged-in
// session IS the acting operator now, not a self-attested header.

import express from 'express'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { VISIT_CRITICAL } from '../case-health.js'
import { REPORT_KEY_ORDER } from '../case-store.js'
import { rankAttention } from '../attn.js'
import { fmtTimeSAST, isOpenCase, SAST_TZ, fmtPhone27, toDate } from '../format.js'
import { getWebhookDeliveryStatus } from '../gateway-hooks.js'
import {
  COOKIE_NAME, parseCookies, sessionCookieHeader, clearCookieHeader,
  issueSession, verifySession, findAccountByUsername, verifyPassword, markLogin,
  getAccount, listAccounts, createAccount, setAccountDisabled, deleteAccount, changePassword,
  revokeAccountSessions,
} from './auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESIGN_DIR = path.resolve(__dirname, '..', '..', 'node_modules', 'anentrypoint-design')
const LEAFLET_DIR = path.resolve(__dirname, '..', '..', 'node_modules', 'leaflet', 'dist')
const MARKERCLUSTER_DIR = path.resolve(__dirname, '..', '..', 'node_modules', 'leaflet.markercluster', 'dist')

const OPERATOR = { id: 'dashboard-operator', role: 'operator' }
const PAGE_MAX = 200

// thatcher persists event.data as a JSON string and store.list* returns it unparsed.
// The SPA reads e.data.field/.by etc. as objects, so parse `data` to an object at the
// API boundary before sending -- a parsed object passes through, a string is parsed,
// anything malformed becomes {} (never throws). Returns a new array of shallow-cloned
// rows so the store's cached rows are not mutated.
function parseJsonArraySafe(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : [] }
  catch { return [] }
}

function parseEventData(events) {
  return (events || []).map(e => {
    if (e && typeof e.data === 'string') {
      let d = {}
      try { d = JSON.parse(e.data) || {} } catch { d = {} }
      return { ...e, data: d }
    }
    return e
  })
}

// opts.sendReply(caseRow, text) -> Promise; lets the operator reply on the channel.
export function createDashboard(store, { port = 4000, sendReply = null, llmStatus = null, runSweep = null, receiveStatus = null, runtimeStatus = null, queueStatus = null, alertWebhookUrl = null } = {}) {
  if (!store) throw new Error('createDashboard requires a store instance')
  const app = express()
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))

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
  // /api/login, /api/logout, and the public /report contact form are the only
  // routes reachable with no session -- every other /api route and the SPA
  // page itself require authed(req). isAdmin(req) additionally gates
  // account-management routes to the 'admin' role.
  const authed = (req) => !!req.caseyAccount
  const isAdmin = (req) => req.caseyAccount?.role === 'admin'
  const actingOperator = (req) => {
    const acct = req.caseyAccount
    if (!acct) return OPERATOR
    return { id: acct.username, name: acct.display_name || acct.username, role: 'operator' }
  }
  // Same {id, name} shape the old CASEY_OPERATORS roster returned, sourced
  // from real operator_account rows instead of an env var -- every existing
  // consumer (workload/report/identities/suggested-assignee) keeps working
  // unchanged. Excludes disabled accounts (a disabled operator is no longer
  // "on the team" for coverage/workload purposes, though their history stays).
  const getRoster = async () => {
    const accounts = await listAccounts(store)
    return accounts.filter(a => a.disabled !== '1').map(a => ({ id: a.username, name: a.display_name || a.username }))
  }
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
  const PUBLIC_FIELD_KEYS = new Set(PUBLIC_FIELDS.map(f => f[0]))

  function publicFormHtml({ ref = '', caseRow = null, done = false, err = '' } = {}) {
    // Uses the closure-level esc() (defined below in createDashboard, initialized
    // by the time this runs at request time) -- was a locally re-declared, byte-
    // identical copy, the same duplication removed elsewhere in this file.
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
  app.post('/api/login', async (req, res) => {
    try {
      const { username, password } = req.body || {}
      const acct = await findAccountByUsername(store, username)
      if (!acct || acct.disabled === '1' || !verifyPassword(password, acct.password_salt, acct.password_hash)) {
        return res.status(401).json({ error: 'invalid username or password' })
      }
      const token = issueSession(acct.id, { epoch: Number(acct.session_epoch) || 0 })
      res.set('Set-Cookie', sessionCookieHeader(token))
      markLogin(store, acct.id).catch(() => {}) // best-effort, never blocks login
      res.json({ ok: true, username: acct.username, display_name: acct.display_name, role: acct.role })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })
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
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
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

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const clampLimit = (v, d) => Math.min(PAGE_MAX, Math.max(1, parseInt(v, 10) || d))
  const offsetOf = (v) => Math.min(50000, Math.max(0, parseInt(v, 10) || 0))

  // Adversarial-Structural: reject malformed mutations with a clear 4xx before
  // thatcher is touched. No framework, no dependency. MAX_LEN is a product cap
  // on operator-entered text length (UTF-16 units), NOT a security boundary --
  // express.json()'s 100KB default already bounds the body.
  const MAX_LEN = 4000
  const AUTONOMY = new Set(['auto', 'assisted', 'observe'])
  // priority/case_type are config-declared enums: derive the accepted set from the
  // SAME live source /api/config and the case_* tools validate against
  // (store.getFieldEnum), never a hardcoded parallel copy -- otherwise a value
  // added to thatcher.config.yml is accepted by the store and shown in the editor
  // yet 400s here (the config-drift the stage list already avoids via
  // getOpenStatuses). The literal list is only the fallback when getFieldEnum is
  // absent (a pre-support store), matching the /api/config fallback shape.
  const enumSet = (field, fallback) => new Set(
    typeof store.getFieldEnum === 'function' && store.getFieldEnum(field, []).length
      ? store.getFieldEnum(field, [])
      : fallback)
  const PRIORITY = enumSet('case.priority', ['low', 'normal', 'high', 'urgent'])
  const CASE_TYPE = enumSet('case.case_type', ['unset', 'outbreak', 'follow_up', 'lab_sample', 'import_alert'])
  // Returns a validated string, or sends a 4xx and returns undefined so the
  // caller short-circuits: `const x = str(...); if (x === undefined) return`.
  const str = (res, body, field, { required = true } = {}) => {
    const v = body[field]
    if (v == null) {
      if (required) { res.status(400).json({ error: `${field} required` }); return undefined }
      return ''
    }
    if (typeof v !== 'string') { res.status(400).json({ error: `${field} must be a string` }); return undefined }
    if (v.length > MAX_LEN) { res.status(413).json({ error: `${field} too long (max ${MAX_LEN})` }); return undefined }
    return v
  }

  // Plain-words health for the operator: is the AI helper connected? Low-literacy
  // operators must know WHY auto-replies may be paused (acptoapi offline) without
  // reading logs. llmStatus is an object or a (sync/async) fn returning one; we
  // normalise to {source, model, url} and translate to a friendly label + tone.
  app.get('/api/health', async (req, res) => {
    try {
      let s = typeof llmStatus === 'function' ? await llmStatus() : llmStatus
      s = s || { source: 'unknown' }
      const map = {
        acptoapi: { ok: true, label: 'AI helper: online', detail: 'Auto-replies are on. Contacts get an instant answer.' },
        none: { ok: false, label: 'AI helper: offline', detail: 'Auto-replies are paused. No message is sent; messages queue and re-drive once the provider recovers.' },
        unknown: { ok: false, label: 'AI helper: unknown', detail: 'Cannot tell if the AI helper is connected.' },
      }
      let view = map[s.source] || map.unknown
      // Completion-path degradation: source resolved (acptoapi) but recent real
      // turns are slow/failing. Reachability is a false green here -- the brain
      // answers /v1/models but every turn hangs -- so override the online pill to
      // a degraded amber so the operator sees "answering, but slowly" not "fine".
      if (view.ok && s.degraded) {
        const secs = Number.isFinite(s.lastMs) ? Math.round(s.lastMs / 1000) : null
        view = {
          ok: false,
          label: 'AI helper: slow',
          detail: secs != null
            ? `Auto-replies are working but the AI helper is slow (last turn ${secs}s). Contacts may wait. Check the provider.`
            : 'Auto-replies are working but the AI helper is slow. Contacts may wait. Check the provider.',
        }
      }
      // Bound the externally-supplied model/url so a misconfigured or hostile
      // llmStatus cannot return a multi-megabyte string into the operator's UI.
      const model = s.model ? String(s.model).slice(0, 100) : null
      const url = s.url ? String(s.url).slice(0, 200) : null
      // Receive-liveness for real-time channels: a zombie gateway socket leaves
      // casey deaf while the LLM pill stays green. Surface it as `gateway` so the
      // operator can tell "online" from "online but answering nobody". A channel
      // configured yet never connected since start is the actionable red signal.
      let gateway = null
      try {
        const rs = typeof receiveStatus === 'function' ? await receiveStatus() : receiveStatus
        if (rs && rs.state && rs.state !== 'none') {
          const deaf = rs.state === 'never-connected'
          gateway = {
            ok: !deaf,
            state: rs.state,
            label: deaf ? 'Messages: not connected' : 'Messages: connected',
            detail: deaf
              ? 'A message channel is not receiving. Contacts may be sending with no reply. Restart casey or check the connection.'
              : 'casey is connected and listening for messages.',
            channels: rs.channels || {},
          }
        }
      } catch { gateway = null }   // receive status is best-effort; never break health
      // LLM-down queue depth (pending re-drives + dead-lettered) so an operator
      // sees not just "AI helper offline" but how much is actually backed up
      // behind that outage. Best-effort: a scan failure never breaks health.
      let queue = null
      try {
        const qs = typeof queueStatus === 'function' ? await queueStatus() : null
        if (qs) queue = { pending: qs.pending || 0, dead_lettered: qs.deadLettered || 0 }
      } catch { queue = null }
      // Alert-webhook delivery status: distinguishes "no breach has fired since
      // boot" (ds === null, nothing to report) from "the webhook itself is
      // failing" (ds.ok === false) -- previously a failed POST only ever logged
      // a console warning, invisible on a headless deployment. No URL/detail
      // ever leaks the webhook itself (a secret), only pass/fail + timing.
      let alertWebhook = null
      if (alertWebhookUrl) {
        const ds = getWebhookDeliveryStatus(alertWebhookUrl)
        alertWebhook = ds
          ? { configured: true, ok: ds.ok, last_attempt_at: ds.lastAttemptAt, last_error: ds.ok ? null : ds.lastError }
          : { configured: true, ok: null, last_attempt_at: null, last_error: null }
      } else {
        alertWebhook = { configured: false, ok: null, last_attempt_at: null, last_error: null }
      }
      res.json({ ...view, source: s.source, model, url, degraded: !!s.degraded, last_turn_ms: Number.isFinite(s.lastMs) ? s.lastMs : null, gateway, queue, alert_webhook: alertWebhook })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Runtime/supervisor state: the lifecycle the SUPERVISOR (parent process) drives
  // -- healthy/restarting/degraded, restart count, last reload/crash. The parent
  // pushes this snapshot down over IPC (PARENT_MSG.STATE) and the worker exposes it
  // here so the operator can tell "the runtime got bounced and why" rather than
  // seeing a silent gap. Token-gated like every other API. Null runtimeStatus (the
  // legacy single-process path with no supervisor) reports a benign 'standalone'
  // so the SPA pill never shows a false 'restarting'.
  app.get('/api/runtime', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    try {
      let s = typeof runtimeStatus === 'function' ? await runtimeStatus() : runtimeStatus
      if (!s) return res.json({ state: 'standalone', supervised: false, label: 'Runtime: running', ok: true })
      // Bound and whitelist the fields so a malformed snapshot cannot inject markup
      // or unbounded strings into the operator UI. No external_id ever appears here.
      const state = String(s.state || 'unknown').slice(0, 32)
      const okStates = new Set(['booting', 'healthy', 'restarting', 'degraded', 'stopping', 'stopped', 'standalone'])
      const safeState = okStates.has(state) ? state : 'unknown'
      const ok = safeState === 'healthy' || safeState === 'standalone'
      const labelMap = {
        booting: 'Runtime: starting', healthy: 'Runtime: healthy', restarting: 'Runtime: restarting',
        degraded: 'Runtime: degraded -- needs attention', stopping: 'Runtime: stopping', stopped: 'Runtime: stopped',
        standalone: 'Runtime: running', unknown: 'Runtime: unknown',
      }
      res.json({
        state: safeState, supervised: true, ok, label: labelMap[safeState],
        restarts: Number.isFinite(s.restarts) ? s.restarts : 0,
        lastReloadAt: s.lastReloadAt != null ? Number(s.lastReloadAt) : null,
        lastCrashReason: s.lastCrashReason ? String(s.lastCrashReason).slice(0, 300) : null,
        since: s.since != null ? Number(s.since) : null,
      })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Config-driven client bootstrap: the workflow stage list and the case_type/
  // priority enums are declared once in thatcher.config.yml (via CaseStore) --
  // this exposes them so the SPA can build its stage-select options, status
  // labels, and "notified on move" set from the LIVE config instead of a
  // hardcoded literal duplicated in several places in the client script. A
  // deployment that adds/renames a workflow stage or case_type value is
  // reflected in the dashboard with no client code change. PII-free (labels
  // and enum names only).
  app.get('/api/config', (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    try {
      res.json({
        stages: store.getValidStatuses(),
        open_stages: typeof store.getOpenStatuses === 'function' ? store.getOpenStatuses() : [],
        case_type: typeof store.getFieldEnum === 'function' ? store.getFieldEnum('case.case_type', []) : [],
        priority: typeof store.getFieldEnum === 'function' ? store.getFieldEnum('case.priority', []) : [],
        // Display-only locale knobs (CASEY_TZ/CASEY_TZ_LABEL/CASEY_COUNTRY_CODE,
        // see format.js) so the client's inlined fmtTime/fmtPhone track the same
        // deployment-configured timezone/country code as the CLI/server side,
        // instead of a hardcoded 'Africa/Johannesburg'/'27' baked into the SPA.
        tz: SAST_TZ,
        tz_label: process.env.CASEY_TZ_LABEL || (process.env.CASEY_TZ ? '' : 'SAST'),
        country_code: (process.env.CASEY_COUNTRY_CODE || '27').replace(/\D/g, '') || '27',
      })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Keys used by the report fields -- REPORT_KEY_ORDER is case-store.js's REPORT_KEYS,
  // ordered for display (observation fields first, then logistics, then contacts/media).
  const REPORT_KEY_LIST = REPORT_KEY_ORDER
  const REPORT_KEY_SET = new Set(REPORT_KEY_LIST)
  const VISIT_CRITICAL_SET = new Set(VISIT_CRITICAL)

  function computeFillRate(reportJson) {
    let r = {}
    try { r = reportJson ? JSON.parse(reportJson) : {} } catch { r = {} }
    const filled = REPORT_KEY_LIST.filter(k => r[k] != null && String(r[k]).trim() !== '').length
    const vcFilled = [...VISIT_CRITICAL_SET].filter(k => r[k] != null && String(r[k]).trim() !== '').length
    return { total_fields: REPORT_KEY_LIST.length, filled, visit_critical_filled: vcFilled, visit_critical_total: VISIT_CRITICAL_SET.size }
  }

  // Escape a cell value for CSV: neutralize a leading formula-trigger character
  // (=, +, -, @) so a contact-supplied value never auto-executes as a formula in
  // Excel/Sheets (CWE-1236), then wrap in quotes if it contains comma, newline, or quote.
  function csvCell(v) {
    let s = v == null ? '' : String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
    if (s.includes(',') || s.includes('\n') || s.includes('"')) return '"' + s.replace(/"/g, '""') + '"'
    return s
  }

  app.get('/api/cases', async (req, res) => {
    try {
      const where = {}
      if (req.query.status) {
        // Validate against the workflow's real statuses so an arbitrary
        // ?status=anything 400s here instead of silently reaching thatcher.
        const valid = store.getValidStatuses()
        if (!valid.includes(req.query.status)) {
          return res.status(400).json({ error: `invalid status: ${req.query.status}`, allowed: valid })
        }
        where.status = req.query.status
      }
      if (req.query.channel) where.channel = req.query.channel
      // ?ref= is a direct-lookup shortcut (used by shareable ref deep-links)
      if (req.query.ref) {
        const ref = String(req.query.ref).slice(0, 50)
        const found = await store.getCaseByRef(ref)
        const casesWithFill = found ? [{ ...found, fill_rate: computeFillRate(found.report) }] : []
        return res.json({ cases: casesWithFill, total: casesWithFill.length, limit: casesWithFill.length, offset: 0 })
      }
      const q = req.query.q ? String(req.query.q).slice(0, 200).toLowerCase() : ''
      const limit = clampLimit(req.query.limit, 50)
      const offset = offsetOf(req.query.offset)
      let cases, total
      if (q) {
        // Search across case fields + all report field values. Fetch the full set
        // (capped at 10000) then filter in Node so report JSON is reachable.
        const all = await store.listCases(where, { limit: 10000, offset: 0 })
        const filtered = all.filter(c => {
          const hay = [c.ref, c.subject, c.summary, c.external_id, c.channel].join(' ').toLowerCase()
          if (hay.includes(q)) return true
          let r = {}; try { r = c.report ? JSON.parse(c.report) : {} } catch { r = {} }
          return REPORT_KEY_LIST.some(k => r[k] != null && String(r[k]).toLowerCase().includes(q))
        })
        total = filtered.length
        cases = filtered.slice(offset, offset + limit)
      } else {
        cases = await store.listCases(where, { limit, offset })
        total = await store.countCases(where)
      }
      const casesWithFill = cases.map(c => ({ ...c, fill_rate: computeFillRate(c.report) }))
      res.json({ cases: casesWithFill, total, limit, offset })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Create a case manually from the dashboard (non-AI intake flow).
  // channel is forced to 'web'; external_id is synthesised from the contact phone
  // (or a timestamp if none given) so it does not collide with channel messages.
  app.post('/api/cases', async (req, res) => {
    try {
      const subject = str(res, req.body, 'subject', { required: false }); if (subject === undefined) return
      const name = str(res, req.body, 'name', { required: false }); if (name === undefined) return
      const phone = str(res, req.body, 'phone', { required: false }); if (phone === undefined) return
      // SA phone validation: 0XXXXXXXXX (10 digits) or +27XXXXXXXXX (11 digits after +)
      if (phone) {
        const digits = phone.replace(/[\s\-()]/g, '')
        const valid = /^0[0-9]{9}$/.test(digits) || /^\+27[0-9]{9}$/.test(digits)
        if (!valid) return res.status(400).json({ error: 'Phone must be a South African number: 0821234567 or +27821234567' })
      }
      // external_id must be stable for dedup; normalise phone digits (keep leading +)
      // then fall back to web-<ms> if normalisation yields empty (e.g. '+' only).
      const normPhone = phone ? phone.replace(/[\s\-()]/g, '') : ''
      const external_id = normPhone && /^[+0-9]/.test(normPhone) ? normPhone : `web-${Date.now()}`
      const contact = { name: name || 'operator', phone: phone || '' }
      const { case: c, created } = await store.findOrCreateCase({ channel: 'web', external_id, contact, subject: subject || 'Field report' })
      // If a case already exists for this phone, return 409 so the client can offer to open it
      if (!created) {
        return res.status(409).json({ error: 'A case already exists for this contact', existing_id: c.id, existing_ref: c.ref })
      }
      // Tag it as operator-initiated manual intake
      const op = actingOperator(req)
      const tags = String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean)
      if (!tags.includes('intake_mode:manual')) {
        const newTags = [...tags, 'intake_mode:manual'].join(',')
        await store.updateCase(c.id, { tags: newTags }, op)
      }
      await store.appendEvent(c.id, { kind: 'action', actor: 'operator', text: 'case created via dashboard manual intake', data: { by: op.id } })
      res.status(201).json(await store.getCase(c.id))
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // CSV export: GET before /:id so express does not capture 'export.csv' as an id.
  app.get('/api/cases/export.csv', async (req, res) => {
    try {
      const where = {}
      if (req.query.status) {
        const valid = store.getValidStatuses()
        if (!valid.includes(req.query.status)) return res.status(400).json({ error: `invalid status: ${req.query.status}` })
        where.status = req.query.status
      }
      if (req.query.channel) where.channel = req.query.channel
      const cases = await store.listCases(where, { limit: 10000, offset: 0 })
      const META = ['ref', 'subject', 'status', 'priority', 'channel', 'created_at']
      const headers = [...META, 'intake_source', ...REPORT_KEY_LIST]
      const rows = cases.map(c => {
        let r = {}
        try { r = c.report ? JSON.parse(c.report) : {} } catch { r = {} }
        const tagArr = String(c.tags || '').split(',').map(t => t.trim())
        const intakeSrc = tagArr.includes('intake_mode:manual') ? 'manual' : tagArr.includes('intake_mode:public_form') ? 'public_form' : tagArr.includes('intake_mode:channel') ? 'channel' : 'unknown'
        return [...META.map(k => csvCell(c[k])), csvCell(intakeSrc), ...REPORT_KEY_LIST.map(k => csvCell(r[k]))].join(',')
      })
      const csv = [headers.join(','), ...rows].join('\n')
      res.setHeader('Content-Type', 'text/csv')
      res.setHeader('Content-Disposition', 'attachment; filename="casey-cases.csv"')
      res.send(csv)
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/api/cases/:id', async (req, res) => {
    try {
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      const events_total = await store.countEvents(c.id)
      // newest window first by default; UI loads older via /events?offset=
      const limit = clampLimit(req.query.events_limit, 50)
      const events = parseEventData(await store.listEventsPage(c.id, { limit, offset: 0 }))
      const transitions = store.availableTransitions(c, OPERATOR)
      const report_fill_rate = computeFillRate(c.report)
      // A suggested (never forced) assignee for an unclaimed case: the learned
      // operator whose working-area history most overlaps this case's report
      // location. Purely advisory -- the operator still clicks Claim; casey never
      // auto-assigns. null when the case is already claimed or no operator's
      // learned areas overlap.
      let suggested_assignee = null
      const unclaimed = !c.assignee || c.assignee === 'agent'
      if (unclaimed) {
        let report = {}
        try { report = c.report ? JSON.parse(c.report) : {} } catch { report = {} }
        if (report.location) {
          const loc = String(report.location).toLowerCase()
          const identities = await store.listOperatorIdentities()
          let best = null
          for (const row of identities) {
            const areas = parseJsonArraySafe(row.areas)
            const hit = areas.find(a => loc.includes(a.token))
            if (hit && (!best || hit.count > best.count)) best = { operator_id: row.operator_id, token: hit.token, count: hit.count }
          }
          if (best) {
            const op = (await getRoster()).find(o => o.id === best.operator_id)
            suggested_assignee = { id: best.operator_id, name: op?.name || best.operator_id, matched_area: best.token }
          }
        }
      }
      res.json({ case: c, events, events_total, transitions, report_fill_rate, suggested_assignee })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Submit structured report fields for a case (non-AI intake or operator correction).
  // Merges into the existing report; blank incoming values never clobber filled ones.
  app.post('/api/cases/:id/intake', async (req, res) => {
    try {
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      const incoming = {}
      for (const k of REPORT_KEY_LIST) {
        if (!(k in req.body)) continue
        const v = str(res, req.body, k, { required: false }); if (v === undefined) return
        incoming[k] = v
      }
      // Reject unrecognised keys to avoid silent data loss
      const unknown = Object.keys(req.body).filter(k => !REPORT_KEY_SET.has(k))
      if (unknown.length) return res.status(400).json({ error: `unknown report fields: ${unknown.join(', ')}` })
      if (!Object.keys(incoming).length) return res.status(400).json({ error: 'no report fields provided' })
      const op = actingOperator(req)
      const result = await store.mergeReport(c.id, incoming, op)
      if (result.error) return res.status(400).json({ error: result.error })
      await store.appendEvent(c.id, { kind: 'action', actor: 'operator', text: `recorded report fields via dashboard: ${Object.keys(incoming).join(', ')}`, data: { ...incoming, by: op.id } })
      res.json({ report: result.report, report_fill_rate: computeFillRate(JSON.stringify(result.report)) })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/api/cases/:id/events', async (req, res) => {
    try {
      const limit = clampLimit(req.query.limit, 50)
      const offset = offsetOf(req.query.offset)
      const events = parseEventData(await store.listEventsPage(req.params.id, { limit, offset }))
      res.json({ events, offset, limit })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.patch('/api/cases/:id', async (req, res) => {
    try {
      const allowed = ['subject', 'summary', 'priority', 'tags', 'assignee', 'autonomy', 'case_type']
      const patch = {}
      for (const k of allowed) {
        if (!(k in req.body)) continue
        const v = str(res, req.body, k); if (v === undefined) return
        if (k === 'autonomy' && !AUTONOMY.has(v)) return res.status(400).json({ error: `invalid autonomy: ${v}` })
        if (k === 'priority' && !PRIORITY.has(v)) return res.status(400).json({ error: `invalid priority: ${v}` })
        if (k === 'case_type' && !CASE_TYPE.has(v)) return res.status(400).json({ error: `invalid case_type: ${v}` })
        patch[k] = v
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'no editable fields' })
      // Optional one-line reason carried alongside the patch (notably for autonomy
      // changes); not a stored field, so it is read off the body directly.
      const patchReason = str(res, req.body, 'reason', { required: false }); if (patchReason === undefined) return
      const prior = await store.getCase(req.params.id)
      if (Object.keys(patch).some(k => k !== 'autonomy')) {
        if (prior?.autonomy === 'observe') return res.status(400).json({ error: 'case autonomy is observe; only autonomy setting can be changed' })
      }
      const op = actingOperator(req)
      const updated = await store.updateCase(req.params.id, patch, op)
      if (!updated) return res.status(404).json({ error: 'not found' })
      // Best-effort operator-identity learning: an edit is a real working-area
      // signal. Not awaited on the response path -- learning must never slow or
      // fail an operator's actual edit.
      if (op.id && op.id !== OPERATOR.id) store.learnOperatorActivity(op.id, updated).catch(() => {})
      // An autonomy change is a first-class audited event carrying {from,to,by,reason}
      // so the timeline can render it as a distinct chip (like a transition), not a
      // generic edit that drops the prior value. Other field edits keep the action row.
      const autonomyChanged = 'autonomy' in patch && prior && prior.autonomy !== patch.autonomy
      if (autonomyChanged) {
        await store.appendEvent(req.params.id, {
          kind: 'autonomy_change', actor: 'operator',
          text: `autonomy ${prior.autonomy} -> ${patch.autonomy}`,
          data: { from: prior.autonomy, to: patch.autonomy, by: op.id, reason: patchReason || '' },
        })
      }
      // A case_type reclassification is audited as its own from/to action so every
      // per-type analytic can trace when (and by whom) a case changed category,
      // rather than a generic edit row that drops the prior value.
      const caseTypeChanged = 'case_type' in patch && prior && (prior.case_type || 'unset') !== patch.case_type
      if (caseTypeChanged) {
        await store.appendEvent(req.params.id, {
          kind: 'action', actor: 'operator',
          text: `case_type ${prior.case_type || 'unset'} -> ${patch.case_type}`,
          data: { from: prior.case_type || 'unset', to: patch.case_type, by: op.id, field: 'case_type' },
        })
      }
      const otherKeys = Object.keys(patch).filter(k => k !== 'autonomy' && k !== 'case_type')
      if (otherKeys.length) {
        const otherPatch = Object.fromEntries(otherKeys.map(k => [k, patch[k]]))
        await store.appendEvent(req.params.id, { kind: 'action', actor: 'operator', text: `edited ${otherKeys.join(', ')}`, data: { ...otherPatch, by: op.id } })
      }
      res.json(updated)
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.post('/api/cases/:id/transition', async (req, res) => {
    try {
      const to = str(res, req.body, 'to'); if (to === undefined) return
      const reason = str(res, req.body, 'reason', { required: false }); if (reason === undefined) return
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      // availableTransitions excludes the current stage; transition() itself
      // no-ops a same-stage move, so let it through rather than 400 a no-op.
      const legal = store.availableTransitions(c, OPERATOR)
      if (to !== c.status && !legal.includes(to)) {
        return res.status(400).json({ error: `cannot transition to '${to}'`, allowed: legal })
      }
      const op = actingOperator(req)
      await store.transition(req.params.id, to, { user: op, reason: reason || 'operator override' })
      const after = await store.getCase(req.params.id)
      if (op.id && op.id !== OPERATOR.id) store.learnOperatorActivity(op.id, after).catch(() => {})
      res.json(after)
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Bulk operator actions over many cases in one request: claim, transition, tag,
  // untag, or note a whole selection. Each case is processed INDEPENDENTLY through
  // the same single-case store ops the per-case endpoints use -- so one case's
  // failure (an illegal transition, a vanished id) is reported in its own result and
  // never aborts the batch. Returns a per-id outcome list plus ok/failed counts so
  // the SPA can show "claimed 7, 1 could not transition". Body:
  //   { ids: string[], action: 'claim'|'transition'|'tag'|'untag'|'note',
  //     to?, tag?, text? }
  // No new store privilege: it is a loop over audited single-case mutations, each
  // attributed to the acting operator exactly as the individual endpoints are.
  app.post('/api/cases/bulk', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : null
      if (!ids || !ids.length) return res.status(400).json({ error: 'ids must be a non-empty array' })
      if (ids.length > 500) return res.status(413).json({ error: 'too many ids (max 500 per bulk request)' })
      const action = String(req.body?.action || '')
      const ACTIONS = new Set(['claim', 'transition', 'tag', 'untag', 'note', 'draft_approve', 'draft_discard'])
      if (!ACTIONS.has(action)) return res.status(400).json({ error: `unknown action '${action}'`, allowed: [...ACTIONS] })
      const op = actingOperator(req)
      // Validate action-specific args ONCE up front so a malformed request fails fast
      // rather than half-applying across the selection.
      const to = action === 'transition' ? String(req.body?.to || '') : null
      if (action === 'transition' && !to) return res.status(400).json({ error: 'transition requires a "to" stage' })
      const tag = (action === 'tag' || action === 'untag') ? String(req.body?.tag || '').trim() : null
      if ((action === 'tag' || action === 'untag') && !tag) return res.status(400).json({ error: `${action} requires a "tag"` })
      if ((action === 'tag' || action === 'untag') && /[,]/.test(tag)) return res.status(400).json({ error: 'tag must not contain a comma' })
      const noteText = action === 'note' ? String(req.body?.text || '').trim() : null
      if (action === 'note' && !noteText) return res.status(400).json({ error: 'note requires non-empty "text"' })

      const results = []
      for (const id of ids) {
        try {
          const c = await store.getCase(id)
          if (!c) { results.push({ id, ok: false, error: 'not found' }); continue }
          if (action === 'claim') {
            const claimed = await store.updateCase(id, { assignee: op.id }, op)
            await store.appendEvent(id, { kind: 'action', actor: 'operator', text: `Claimed by ${op.name || op.id}`, data: { claimed_by: op.id, bulk: true } })
            if (op.id !== OPERATOR.id) store.learnOperatorActivity(op.id, claimed || c).catch(() => {})
          } else if (action === 'transition') {
            const legal = store.availableTransitions(c, OPERATOR)
            if (to !== c.status && !legal.includes(to)) { results.push({ id, ok: false, error: `cannot transition to '${to}'` }); continue }
            await store.transition(id, to, { user: op, reason: 'operator bulk action' })
            if (op.id !== OPERATOR.id) store.learnOperatorActivity(op.id, c).catch(() => {})
          } else if (action === 'tag') {
            const tags = String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean)
            if (!tags.includes(tag)) await store.updateCase(id, { tags: [...tags, tag].join(',') }, op)
          } else if (action === 'untag') {
            const tags = String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean)
            if (tags.includes(tag)) await store.updateCase(id, { tags: tags.filter(t => t !== tag).join(',') }, op)
          } else if (action === 'note') {
            await store.appendEvent(id, { kind: 'note', actor: 'operator', text: noteText, data: { by: op.id, bulk: true } })
          } else if (action === 'draft_approve') {
            // Bulk release sends each draft's ORIGINAL text verbatim -- per-case
            // editing before send is a single-case-only affordance (the operator
            // opened that one case to read and adjust it); a bulk release is for
            // drafts an operator has already judged fine to go out as composed.
            const draft = await pendingDraft(c)
            if (!draft) { results.push({ id, ok: false, error: 'no pending draft' }); continue }
            const text = draft.text || ''
            if (!text) { results.push({ id, ok: false, error: 'empty draft' }); continue }
            let delivered = false
            if (sendReply) {
              try { await sendReply(c, text); delivered = true }
              catch (e) { await store.appendEvent(id, { kind: 'observation', actor: 'system', text: `Failed to send approved draft on channel: ${e.message || 'unknown error'}` }) }
            }
            await store.appendEvent(id, { kind: 'outbound', actor: 'operator', channel: c.channel, text, data: { to: c.external_id, from_draft: true, by: op.id, bulk: true } })
            if (delivered) {
              const tags = String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean)
              await store.updateCase(id, { tags: tags.filter(t => t !== 'draft-pending' && t !== 'needs-human').join(',') }, op)
            } else {
              results.push({ id, ok: false, error: 'send failed' }); continue
            }
          } else if (action === 'draft_discard') {
            const draft = await pendingDraft(c)
            if (!draft) { results.push({ id, ok: false, error: 'no pending draft' }); continue }
            const tags = String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean)
            await store.updateCase(id, { tags: tags.filter(t => t !== 'draft-pending').join(',') }, op)
            await store.appendEvent(id, { kind: 'observation', actor: 'operator', text: 'DRAFT DISCARDED: operator bulk discard.', data: { by: op.id, bulk: true } })
          }
          results.push({ id, ok: true })
        } catch (e) { results.push({ id, ok: false, error: String(e.message || e).slice(0, 200) }) }
      }
      const okCount = results.filter(r => r.ok).length
      res.json({ action, total: ids.length, ok: okCount, failed: ids.length - okCount, results })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Snooze a case: an operator who has SEEN a case but cannot finish it now drops
  // it out of the attention inbox until a time, without losing it. The scorer in
  // attn.js already honours a 'snoozed-until:<epoch-ms>' tag (and never hides a
  // needs-human case, and un-snoozes on a newer inbound) -- this endpoint is the
  // write side: it sets/replaces that tag and records an audited action so the
  // snooze is observable, never a silent disappearance. Body: { minutes } (from now)
  // or { until } (epoch ms); minutes<=0 or until<=now CLEARS any snooze. The acting
  // operator is attributed. Snoozing is a soft inbox preference, not a workflow
  // transition -- the case status is untouched.
  app.post('/api/cases/:id/snooze', async (req, res) => {
    try {
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      const op = actingOperator(req)
      const now = Date.now()
      let until = null
      if (req.body && req.body.until != null) {
        const u = Number(req.body.until)
        if (!Number.isFinite(u)) return res.status(400).json({ error: '"until" must be an epoch-ms number' })
        until = u
      } else if (req.body && req.body.minutes != null) {
        const m = Number(req.body.minutes)
        if (!Number.isFinite(m)) return res.status(400).json({ error: '"minutes" must be a number' })
        // Bound so a fat-fingered value cannot snooze a case effectively forever.
        until = now + Math.min(Math.max(m, 0), 60 * 24 * 14) * 60000
      } else {
        return res.status(400).json({ error: 'snooze requires "minutes" or "until"' })
      }
      // Strip any existing snooze tag, then add the new one only if it is in the
      // future -- a past/zero target is a CLEAR.
      const tags = String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean).filter(t => !t.startsWith('snoozed-until:'))
      const cleared = !(until > now)
      if (!cleared) tags.push(`snoozed-until:${Math.floor(until)}`)
      await store.updateCase(c.id, { tags: tags.join(',') }, op)
      await store.appendEvent(c.id, {
        kind: 'action', actor: 'operator',
        text: cleared ? `Snooze cleared by ${op.name || op.id}` : `Snoozed by ${op.name || op.id} until ${new Date(Math.floor(until)).toISOString()}`,
        data: { by: op.id, snoozed_until: cleared ? null : Math.floor(until) },
      })
      res.json({ ok: true, snoozed_until: cleared ? null : Math.floor(until), cleared })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Undo the last reversible operator action on a case, within a recency window, by
  // appending a COMPENSATING event -- history is append-only and never mutated. The
  // 15s window is a client UX affordance; the server bounds undo at 120s so a late
  // request cannot silently rewrite an old decision. Iteration 1 covers the clean,
  // self-describing reversible actions whose reverse is fully recorded in the
  // original event's data:
  //   transition  -> reverse transition (to = data.from), reason 'undo'
  //   snooze      -> clear the snooze tag (compensating action event)
  //   claim       -> restore the prior assignee (data.was)
  // A sent reply is NOT reversible (the contact already saw it) -- undo of a reply
  // is the client-side 'disregard my last message' helper, out of scope here. The
  // acting operator is attributed; the compensating event carries undo_of so the
  // pair is observable on the timeline.
  app.post('/api/cases/:id/undo', async (req, res) => {
    try {
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      const op = actingOperator(req)
      // Shared event.data parser (the same one /audit.csv and overview use) --
      // one chokepoint for the "data is a JSON string at the read edge" rule,
      // never a re-inlined copy that can drift.
      const { evData } = await import('../overview.js')
      const WINDOW_MS = 120000
      const now = Date.now()
      const events = await store.listEvents(c.id)
      // Find the most recent UNDOABLE operator action that has not already been
      // undone, newest-first and within the window.
      const undoneIds = new Set()
      for (const e of events) { const d = evData(e); if (d.undo_of) undoneIds.add(String(d.undo_of)) }
      const isRecent = (e) => {
        // event.created_at is unix-SECONDS, often a numeric string -- bare
        // Date.parse yields NaN, which made every real event pass the window
        // (unparseable -> allow), so the 120s undo window was never enforced.
        // toDate is digit-string-aware (seconds -> ms) and returns null on junk.
        const d = e.created_at ? toDate(e.created_at) : null
        return d ? (now - d.getTime()) <= WINDOW_MS : true   // truly-unparseable -> allow (tests)
      }
      let target = null, kind = null
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (undoneIds.has(String(e.id))) continue
        if (!isRecent(e)) break   // older than the window: nothing undoable remains
        if (e.kind === 'transition' && e.actor === 'operator') {
          // A compensating reverse transition is itself reason 'undo' -- it is not a
          // fresh operator decision, so undoing it (which would re-apply the original
          // move) is wrong. Skip it and keep scanning for a real action to reverse.
          if (evData(e).reason === 'undo') continue
          target = e; kind = 'transition'; break
        }
        if (e.kind === 'action' && e.actor === 'operator') {
          const txt = String(e.text || '')
          if (/^Undo by/.test(txt)) continue   // the compensating action itself is not undoable
          if (/^Claimed by/.test(txt)) { target = e; kind = 'claim'; break }
          if (/^Snoozed by/.test(txt)) { target = e; kind = 'snooze'; break }
        }
      }
      if (!target) return res.status(409).json({ error: 'nothing to undo in the last 120s' })
      const d = evData(target)
      let summary = ''
      if (kind === 'transition') {
        const to = d.from
        if (!to) return res.status(409).json({ error: 'transition has no recorded prior stage' })
        await store.transition(c.id, to, { user: op, reason: 'undo' })
        summary = `undid transition: back to ${to}`
      } else if (kind === 'claim') {
        const prior = d.was || ''
        await store.updateCase(c.id, { assignee: prior }, op)
        summary = prior ? `undid claim: assignee back to ${prior}` : 'undid claim: assignee cleared'
      } else if (kind === 'snooze') {
        const tags = String((await store.getCase(c.id)).tags || '').split(',').map(t => t.trim()).filter(Boolean).filter(t => !t.startsWith('snoozed-until:'))
        await store.updateCase(c.id, { tags: tags.join(',') }, op)
        summary = 'undid snooze'
      }
      await store.appendEvent(c.id, {
        kind: 'action', actor: 'operator',
        text: `Undo by ${op.name || op.id}: ${summary}`,
        data: { by: op.id, undo_of: target.id, undo_kind: kind },
      })
      res.json({ ok: true, undone: kind, summary })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.post('/api/cases/:id/note', async (req, res) => {
    try {
      const text = str(res, req.body, 'text'); if (text === undefined) return
      if (!text.trim()) return res.status(400).json({ error: 'empty note' })
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      const field = req.body.field && REPORT_KEY_SET.has(req.body.field) ? req.body.field : null
      const op = actingOperator(req)
      await store.appendEvent(req.params.id, { kind: 'note', actor: 'operator', text, data: { ...(field ? { field } : {}), by: op.id } })
      res.json({ ok: true })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Cases the time-guardrails flagged as going wrong: stale, stuck, an unanswered
  // request for a person, an abandoned intake, or resolved-but-never-closed. Driven
  // by the health:* tags the sweep maintains, with the live breach detail recomputed
  // so the reason is current, not a stale snapshot.
  app.get('/api/attention', async (req, res) => {
    try {
      const { classifyCaseHealth } = await import('../case-health.js')
      const now = Date.now()
      // Use the LIVE operator-tuned thresholds, not the hard defaults. Passing no
      // thresholds here was a latent bug: a team that tightened handoffMs via
      // /api/thresholds still saw the inbox classify against the shipped default.
      const thresholds = await store.resolveThresholds()
      // Rank over ALL open cases with the SAME enum-weighted scorer the SPA used
      // to render (src/attn.js), so a high-urgency case outside the page window
      // the client fetched still reaches the inbox -- the ranking is no longer
      // capped by loadCases' 200-row limit.
      const open = (await store.listCases({}, { limit: 10000 })).filter(isOpenCase)
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500)
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0)
      const { total, items, atRisk, slaTargetMs } = rankAttention(open, now, { limit, offset })
      // Recompute the live breach detail per ranked case so the reason is current,
      // not a stale tag snapshot. classifyCaseHealth is the source of detail text.
      // waitMs is the live SLA clock -- ms the contact has waited on a human reply
      // (null when nobody owes a reply), so the row can show "waited 18m, target 30m"
      // without the SPA recomputing it. The header at_risk count is aggregate-only.
      const cases = items.map(({ c, score, reason, waitMs }) => ({
        id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel,
        status: c.status, updated_at: c.updated_at || c.created_at,
        assignee: c.assignee || '',
        wait_ms: waitMs == null ? null : waitMs,
        score, reason, breaches: classifyCaseHealth(c, now, thresholds)
      }))
      res.json({ count: cases.length, total, limit, offset, at_risk: atRisk, sla_target_ms: slaTargetMs, cases })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // How many open cases are waiting past the reply SLA, bucketed by case_type, so an
  // operator can attack the worst category first (e.g. "4 outbreaks past SLA vs 1
  // follow_up"). Reuses the live handoff threshold (resolveThresholds) and the same
  // atRiskCount the inbox header shows, run per case_type slice. Aggregate-only --
  // counts only, never a case ref or external_id.
  app.get('/api/sla-at-risk/by-type', async (req, res) => {
    try {
      const { atRiskCount } = await import('../attn.js')
      const now = Date.now()
      const thresholds = await store.resolveThresholds()
      const slaTargetMs = Number.isFinite(thresholds?.handoffMs) ? thresholds.handoffMs : 30 * 60 * 1000
      const open = (await store.listCases({}, { limit: 10000 })).filter(isOpenCase)
      const byType = {}
      const groups = new Map()
      for (const c of open) {
        const t = c.case_type || 'unset'
        if (!groups.has(t)) groups.set(t, [])
        groups.get(t).push(c)
      }
      for (const [t, slice] of groups) byType[t] = atRiskCount(slice, now, slaTargetMs)
      const total = atRiskCount(open, now, slaTargetMs)
      res.json({ by_type: byType, total, sla_target_ms: slaTargetMs })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Operator-tunable health thresholds. GET returns the live effective values
  // (persisted patch merged over defaults); PUT validates+clamps a partial patch
  // against the known keys, persists it as an audited observation, and returns the
  // new effective values plus which keys applied/were rejected. Both are gated by
  // the global auth middleware above. The PUT feeds BOTH the live sweep and the
  // /api/attention classifier, since both read store.resolveThresholds() at call
  // time -- a change here takes effect on the next sweep and the next inbox scan.
  app.get('/api/thresholds', async (req, res) => {
    try {
      const { mergeThresholds, THRESHOLD_KEYS } = await import('../thresholds.js')
      const patch = await store.getThresholdsPatch()
      const effective = patch ? mergeThresholds(patch).thresholds : (await import('../case-health.js')).DEFAULT_THRESHOLDS
      res.json({ thresholds: effective, customized: !!patch, keys: THRESHOLD_KEYS })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.put('/api/thresholds', async (req, res) => {
    try {
      const { mergeThresholds } = await import('../thresholds.js')
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const { thresholds, applied, rejected } = mergeThresholds(body)
      if (!applied.length) {
        return res.status(400).json({ error: 'no valid threshold keys in patch', rejected })
      }
      // Persist only the accepted, clamped values (not the raw body), so a replay
      // reproduces exactly what took effect.
      const accepted = {}
      for (const k of applied) {
        if (k.startsWith('stageMaxDwellMs.')) {
          const sk = k.slice('stageMaxDwellMs.'.length)
          accepted.stageMaxDwellMs = accepted.stageMaxDwellMs || {}
          accepted.stageMaxDwellMs[sk] = thresholds.stageMaxDwellMs[sk]
        } else {
          accepted[k] = thresholds[k]
        }
      }
      await store.setThresholdsPatch(accepted, actingOperator(req))
      const effective = await store.resolveThresholds()
      res.json({ ok: true, thresholds: effective, applied, rejected })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Trigger a health-guardrail sweep now (operator-initiated). Only available
  // when the casey instance passed a runSweep callback; returns 501 otherwise.
  app.post('/api/sweep', async (req, res) => {
    if (!runSweep) return res.status(501).json({ error: 'sweep not available in this mode' })
    try {
      const result = await runSweep()
      res.json({ ok: true, scanned: result?.scanned ?? null, flagged: result?.flagged ?? null, cleared: result?.cleared ?? null })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Aggregate stats comparing intake modes. Returns fill-rate breakdown by source.
  app.get('/api/stats', async (req, res) => {
    try {
      const cases = await store.listCases({}, { limit: 10000, offset: 0 })
      const byMode = { channel: [], manual: [], public_form: [], unknown: [] }
      for (const c of cases) {
        const tags = String(c.tags || '').split(',').map(t => t.trim())
        const hasChannel = tags.includes('intake_mode:channel')
        const hasManual = tags.includes('intake_mode:manual')
        const hasPublic = tags.includes('intake_mode:public_form')
        const fill = computeFillRate(c.report)
        if (hasChannel) byMode.channel.push(fill)
        if (hasManual) byMode.manual.push(fill)
        if (hasPublic) byMode.public_form.push(fill)
        if (!hasChannel && !hasManual && !hasPublic) byMode.unknown.push(fill)
      }
      const avg = (arr, key) => arr.length ? Math.round(arr.reduce((s, r) => s + r[key], 0) / arr.length * 10) / 10 : null
      const summary = {}
      for (const [mode, arr] of Object.entries(byMode)) {
        if (!arr.length) continue
        summary[mode] = {
          count: arr.length,
          avg_filled: avg(arr, 'filled'),
          avg_vc_filled: avg(arr, 'visit_critical_filled'),
          vc_complete: arr.filter(r => r.visit_critical_filled >= r.visit_critical_total).length,
          total_fields: arr[0]?.total_fields ?? 0,
          vc_total: arr[0]?.visit_critical_total ?? 0,
        }
      }
      res.json({ total: cases.length, by_mode: summary })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Fleet-health trend: the rolling log of SCHEDULED guardrail-sweep summaries
  // (persisted by casey.runSweepOnce as audited observations). Returns the latest
  // summary, the last N for a trend line, and a degraded flag (true when the
  // latest sweep hit errors). Read-only, store-backed -- no casey-instance handle
  // needed. ?n clamps the history depth (default 50, 1..500). The header pill
  // wiring is the client-side half (blocked on the browser surface).
  app.get('/api/fleet-health', async (req, res) => {
    try {
      const n = Math.min(Math.max(parseInt(req.query.n, 10) || 50, 1), 500)
      const fh = await store.getFleetHealth(n)
      res.json(fh)
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // The operator roster + who the server resolved THIS request to (from the
  // logged-in session), so the SPA can label every action with a real name.
  app.get('/api/operators', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const roster = await getRoster()
    res.json({ operators: roster, current: actingOperator(req).id, attributed: roster.length > 0 })
  })

  // Account management -- admin-only. Never returns password_hash/password_salt.
  // Adding/disabling/deleting a teammate's ability to log in is exactly the
  // "administration handles it" lever the AUTH MODEL note above describes for
  // a lost/compromised device: an admin disables that one account, everyone
  // else's login is untouched (unlike the old shared-token model where a
  // compromised token meant rotating one secret for the whole team).
  const publicAccount = (a) => ({ id: a.id, username: a.username, display_name: a.display_name, role: a.role, disabled: a.disabled === '1', last_login_at: a.last_login_at || null })
  app.get('/api/accounts', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    try { res.json({ accounts: (await listAccounts(store)).map(publicAccount) }) }
    catch (e) { res.status(500).json({ error: e.message }) }
  })
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

  // Contacts/Reporters panel -- the browse surface for the operator-assignable
  // access-tier design (see thatcher.config.yml contact.tier, gateway-hooks.js
  // toolCtx.tier). Internal-team-only (never on the public /report form): shows
  // who has reported, their current tier, and lets any authed operator promote/
  // demote (not admin-only -- unlike account management, tier assignment is an
  // everyday triage action, matching the low-friction field-team auth model
  // documented at the top of this file, not a security-sensitive one).
  const publicContact = (c) => ({
    id: c.id, channel: c.channel, external_id_masked: fmtPhone27(c.external_id),
    display_name: c.display_name || null, tier: c.tier === 'field_worker' ? 'field_worker' : 'reporter',
    last_location_lat: c.last_location_lat ?? null, last_location_lon: c.last_location_lon ?? null,
    last_location_at: c.last_location_at || null, created_at: c.created_at,
  })
  app.get('/api/contacts', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    try {
      const contacts = await store.listContacts({ limit: 1000 })
      res.json({ contacts: contacts.map(publicContact) })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })
  app.post('/api/contacts/:id/tier', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    try {
      const { tier } = req.body || {}
      if (tier !== 'reporter' && tier !== 'field_worker') return res.status(400).json({ error: 'tier must be "reporter" or "field_worker"' })
      await store.setContactTier(req.params.id, tier, { id: actingOperator(req).id, role: 'operator' })
      const updated = await store.getContact(req.params.id)
      res.json({ contact: publicContact(updated) })
    } catch (e) { res.status(400).json({ error: e.message }) }
  })

  // Learned operator identities -- the roster enriched with each operator's
  // working-area history (case-store.js learnOperatorActivity), for the map's
  // operator-coverage overlay and a "who covers where" panel. Internal-team data
  // (not contact PII), still gated by login like every other /api route --
  // never exposed on the unauthenticated /report surface.
  app.get('/api/operators/identities', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    try {
      const rows = await store.listOperatorIdentities()
      const byId = new Map(rows.map(r => [r.operator_id, r]))
      const identities = (await getRoster()).map(o => {
        const r = byId.get(o.id)
        return {
          id: o.id, name: o.name,
          areas: r ? parseJsonArraySafe(r.areas) : [],
          last_seen_at: r?.last_seen_at || null,
          case_count: r?.case_count || 0,
        }
      })
      res.json({ identities })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Map view: every open + recently-closed case with a resolvable point. lat/lon
  // come ONLY from the agent's own case_report call -- its own best-effort
  // estimate from the location the worker described, using the model's own world
  // knowledge (see caseSystemPrompt); casey never looks anything up server-side.
  // Aggregate/PII-free like every other dashboard rollup: no external_id, no
  // owner_name/contact_fallback/present_person -- only what a map pin needs
  // (species, case_type, status, assignee, cluster membership). Capped like every
  // other list endpoint (PAGE_MAX-scale window) so clustering never chokes on an
  // unbounded pull; excluded-count is reported, never silently dropped.
  const MAP_CASE_CAP = 2000
  app.get('/api/map/cases', async (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 0, 0), 365)
      const where = {}
      if (days > 0) where.created_at = { $gte: Math.floor(Date.now() / 1000) - days * 86400 }
      const all = await store.listCases(where, { limit: MAP_CASE_CAP + 1, offset: 0 })
      const truncated = all.length > MAP_CASE_CAP
      const pool = truncated ? all.slice(0, MAP_CASE_CAP) : all
      const { buildClusters } = await import('../clusters.js')
      const clusters = buildClusters(pool.filter(isOpenCase))
      const clusterByRef = new Map()
      clusters.forEach((cl, i) => { for (const m of cl.members) clusterByRef.set(m.ref, i) })

      const pins = [], unresolved = []
      for (const c of pool) {
        let report = {}
        try { report = c.report ? JSON.parse(c.report) : {} } catch { report = {} }
        const lat = c.lat != null && c.lat !== '' ? Number(c.lat) : null
        const lon = c.lon != null && c.lon !== '' ? Number(c.lon) : null
        const row = {
          id: c.id, ref: c.ref, status: c.status, case_type: c.case_type || 'unset',
          species: report.species || null, location: report.location || null,
          symptoms: report.symptoms || null,
          affected_count: report.affected_count ?? null, dead_count: report.dead_count ?? null,
          onset: report.onset || null,
          assignee: c.assignee || null, priority: c.priority,
          cluster: clusterByRef.has(c.ref) ? clusterByRef.get(c.ref) : null,
          last_event_at: c.last_event_at,
        }
        if (lat != null && Number.isFinite(lat) && lon != null && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
          pins.push({ ...row, lat, lon })
        } else {
          unresolved.push(row)
        }
      }
      res.json({
        pins, unresolved, unresolved_count: unresolved.length,
        clusters: clusters.map((cl, i) => ({
          index: i, count: cl.count, severity: cl.severity, location: cl.location,
          species: cl.species, symptoms: cl.symptoms, reported_disease_names: cl.reported_disease_names,
        })),
        truncated, cap: MAP_CASE_CAP, total_considered: all.length,
      })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Field-worker location layer: recent case_checkin self-reports, for the map's
  // dispatch/direction overlay. Distinct from /api/map/cases (case pins) and from
  // /api/operators/identities (a dashboard-operator's LEARNED historical coverage
  // area) -- this is a field_worker CONTACT's own LIVE self-reported position.
  // Staleness-filtered by the tunable workerLocationStaleMs threshold (default 3h)
  // so an hours-old ping does not read as "here right now". Internal-team-only,
  // same gate as every other dashboard route -- never on the public /report form.
  app.get('/api/map/workers', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    try {
      const th = (store.resolveThresholds ? await store.resolveThresholds() : null) || {}
      const staleMs = Number.isFinite(th.workerLocationStaleMs) ? th.workerLocationStaleMs : 3 * 3600e3
      const now = Date.now()
      const contacts = await store.listContacts({ limit: 1000 })
      const workers = contacts
        .filter(c => c.tier === 'field_worker' && c.last_location_lat != null && c.last_location_lon != null && c.last_location_at)
        .map(c => {
          const at = Date.parse(c.last_location_at)
          const ageMs = Number.isFinite(at) ? now - at : null
          return {
            id: c.id, display_name: c.display_name || null,
            lat: Number(c.last_location_lat), lon: Number(c.last_location_lon),
            last_location_at: c.last_location_at, age_ms: ageMs,
            stale: ageMs == null || ageMs > staleMs,
          }
        })
        .filter(w => Number.isFinite(w.lat) && Number.isFinite(w.lon) && Math.abs(w.lat) <= 90 && Math.abs(w.lon) <= 180)
      res.json({ workers, stale_ms: staleMs })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Management KPIs over the live case+event history: time-to-first-reply
  // (median/p90), median dwell per stage from transition events, opened-vs-closed
  // per day, open backlog by stage. Aggregate-only -- no per-contact rows or
  // external_id leak. On-demand (one scan), not a background poll. ?days scopes
  // the per-day window (default 14, clamped 1..90). buildOverview is the pure
  // aggregator shared with the CLI/CSV so the maths is identical everywhere.
  app.get('/api/overview', async (req, res) => {
    try {
      const { buildOverview } = await import('../overview.js')
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90)
      const cases = await store.listCases({}, { limit: 10000, offset: 0 })
      const eventsByCaseId = new Map()
      for (const c of cases) eventsByCaseId.set(c.id, await store.listEvents(c.id).catch(() => []))
      const overview = buildOverview(cases, eventsByCaseId, Date.now(), days * 24 * 3600 * 1000)
      res.json({ days, ...overview })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Per-operator workload + accountability: open cases each person holds, stale
  // claims (held but untouched too long), replies sent in the last 24h, median
  // first-reply on their cases, and their oldest-waiting case. Aggregate-only --
  // no per-contact rows, no external_id. On-demand single scan, never per-poll.
  // buildWorkload is the pure aggregator (like overview/attn) so the maths is one
  // place. The stale window reads the live operator-tuned thresholds when present.
  app.get('/api/operators/workload', async (req, res) => {
    try {
      const { buildWorkload } = await import('../workload.js')
      const cases = await store.listCases({}, { limit: 10000, offset: 0 })
      const eventsByCaseId = new Map()
      for (const c of cases) eventsByCaseId.set(c.id, await store.listEvents(c.id).catch(() => []))
      const th = (store.resolveThresholds ? await store.resolveThresholds() : null) || {}
      const staleMs = Number.isFinite(th.staleMs) ? th.staleMs : 24 * 3600 * 1000
      const out = buildWorkload(cases, eventsByCaseId, await getRoster(), Date.now(), staleMs)
      res.json(out)
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Fleet-wide outbreak view: connected components of the open/non-merged pool
  // under the same correlation scorer the per-case suggestions use. Surfaces
  // "these N cases look like one outbreak" so the team sees a spreading disease
  // without opening each case. On-demand (one O(n^2) scan over the bounded pool),
  // never per-poll; merge stays per-pair and human-confirmed.
  app.get('/api/clusters', async (req, res) => {
    try {
      const { buildClusters } = await import('../clusters.js')
      const pool = (await store.listCases({}, { limit: 500 }))
        .filter(c => isOpenCase(c)
          && !String(c.tags || '').split(',').map(s => s.trim()).includes('merged'))
      const clusters = buildClusters(pool)
      res.json({ pool: pool.length, count: clusters.length, clusters })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Hotspots by area: open cases grouped by their stored location token(s),
  // ranked by count, each with species mix and most-recent report time. Re-groups
  // stored location only (no new data); aggregate-only, on-demand.
  app.get('/api/geo', async (req, res) => {
    try {
      const { buildGeo } = await import('../geo.js')
      const open = (await store.listCases({}, { limit: 10000 })).filter(isOpenCase)
      res.json({ open: open.length, places: buildGeo(open) })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Cross-case activity/audit stream: every event newest-first, filterable by
  // kind/actor (validated against known enums) and a since-timestamp window, each
  // row deep-linking to its case. Read-only. Reuses the same per-case timeline
  // data, just merged across cases for review.
  app.get('/api/activity', async (req, res) => {
    try {
      const KINDS = new Set(['inbound', 'outbound', 'transition', 'observation', 'note', 'action', 'autonomy_change'])
      const ACTORS = new Set(['agent', 'operator', 'contact', 'system'])
      const kind = KINDS.has(req.query.kind) ? req.query.kind : null
      const actor = ACTORS.has(req.query.actor) ? req.query.actor : null
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500)
      const since = parseInt(req.query.since, 10) || 0
      let rows = await store.listAllEvents({ kind, actor }, { limit: limit + (since ? 500 : 0) })
      if (since) rows = rows.filter(e => Number(e.created_at) * 1000 >= since)
      const events = rows.slice(0, limit).map(e => ({
        id: e.id, case_id: e.case_id, kind: e.kind, actor: e.actor,
        text: e.text || '', created_at: e.created_at,
      }))
      res.json({ count: events.length, kind, actor, events })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Management briefing: one aggregate report (counts by stage + area, opened/
  // closed this period, median/p90 first-response, live breach counts) over a
  // ?days window. .csv for spreadsheets, .html for a print-friendly page; both
  // render the same buildReport numbers. Read-only, aggregate-only, SAST.
  async function gatherReport(days) {
    const { classifyCaseHealth } = await import('../case-health.js')
    const thresholds = await store.resolveThresholds()
    const now = Date.now()
    const cases = await store.listCases({}, { limit: 10000, offset: 0 })
    const eventsByCaseId = new Map()
    for (const c of cases) eventsByCaseId.set(c.id, await store.listEvents(c.id).catch(() => []))
    const breachRows = cases
      .filter(isOpenCase)
      .flatMap(c => classifyCaseHealth(c, now, thresholds))
    const staleMs = Number.isFinite(thresholds?.staleMs) ? thresholds.staleMs : 24 * 3600 * 1000
    const { buildReport } = await import('../report.js')
    return buildReport(cases, eventsByCaseId, breachRows, now, days, await getRoster(), staleMs)
  }
  const reportDays = (req) => Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90)
  const msToHrs = (ms) => ms == null ? '' : Math.round(ms / 3600000 * 10) / 10

  app.get('/api/report.csv', async (req, res) => {
    try {
      const r = await gatherReport(reportDays(req))
      const lines = []
      lines.push(['section', 'key', 'value'].join(','))
      lines.push(['totals', 'all', csvCell(r.totals.all)].join(','))
      lines.push(['totals', 'open', csvCell(r.totals.open)].join(','))
      lines.push(['totals', 'closed', csvCell(r.totals.closed)].join(','))
      lines.push(['period', 'days', csvCell(r.period_days)].join(','))
      lines.push(['period', 'opened_this_period', csvCell(r.opened_this_period)].join(','))
      lines.push(['period', 'closed_this_period', csvCell(r.closed_this_period)].join(','))
      lines.push(['response', 'median_first_response_hours', csvCell(msToHrs(r.median_first_response_ms))].join(','))
      lines.push(['response', 'p90_first_response_hours', csvCell(msToHrs(r.p90_first_response_ms))].join(','))
      for (const [stage, n] of Object.entries(r.by_stage)) lines.push(['by_stage', csvCell(stage), csvCell(n)].join(','))
      for (const a of r.by_area) lines.push(['by_area', csvCell(a.place), csvCell(a.count)].join(','))
      for (const [b, n] of Object.entries(r.breaches)) lines.push(['breach', csvCell(b), csvCell(n)].join(','))
      // Per-operator workload, one line per metric so the flat section/key/value
      // shape holds. Aggregate-only: operator name + counts, never a contact id.
      for (const o of r.by_operator) {
        const k = (m) => csvCell(o.name + ' ' + m)
        lines.push(['by_operator', k('open_assigned'), csvCell(o.open_assigned)].join(','))
        lines.push(['by_operator', k('stale_claims'), csvCell(o.stale_claims)].join(','))
        lines.push(['by_operator', k('replies_24h'), csvCell(o.replies_24h)].join(','))
        lines.push(['by_operator', k('first_reply_hours'), csvCell(msToHrs(o.first_reply_ms_median))].join(','))
        lines.push(['by_operator', k('oldest_waiting_hours'), csvCell(msToHrs(o.oldest_waiting_ms))].join(','))
      }
      res.setHeader('Content-Type', 'text/csv')
      res.setHeader('Content-Disposition', 'attachment; filename="casey-management-report.csv"')
      res.send(lines.join('\n'))
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Same management briefing as .csv/.html but as structured JSON for BI ingest,
  // plus three analytics the flat briefing does not carry: SLA compliance pass/
  // fail, period-over-period comparison, and per-intake-channel response speed.
  // Aggregate-only (no external_id); read-only. The SLA target is the live handoff
  // threshold (what "should have been answered by"), falling back to 30 minutes.
  app.get('/api/report.json', async (req, res) => {
    try {
      const days = reportDays(req)
      const r = await gatherReport(days)
      const { buildSLAReport, buildReportComparison, buildChannelMetrics, buildSLAReportByType, buildCaseTypeMetrics } = await import('../report-analytics.js')
      const thresholds = await store.resolveThresholds()
      const now = Date.now()
      const cases = await store.listCases({}, { limit: 10000, offset: 0 })
      const eventsByCaseId = new Map()
      for (const c of cases) eventsByCaseId.set(c.id, await store.listEvents(c.id).catch(() => []))
      const slaTargetMs = Number.isFinite(thresholds?.handoffMs) ? thresholds.handoffMs : 30 * 60 * 1000
      res.json({
        ...r,
        sla: buildSLAReport(cases, eventsByCaseId, slaTargetMs, now),
        sla_by_type: buildSLAReportByType(cases, eventsByCaseId, slaTargetMs, now),
        comparison: buildReportComparison(cases, eventsByCaseId, now, days * 24 * 3600 * 1000),
        by_channel: buildChannelMetrics(cases, eventsByCaseId),
        by_case_type: buildCaseTypeMetrics(cases, eventsByCaseId),
      })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Compliance audit trail: a flat CSV of every mutation over a ?days window,
  // one row per event, joined to its case ref. Built off the same append-only
  // event log the timeline uses, parsed via evData(). NEVER emits external_id or
  // any contact phone/handle -- the actor is the operator/agent/system id, and
  // the to/from fields are scrubbed of the case external_id so a delivered-reply
  // event cannot leak the contact number into a compliance export. Read-only.
  app.get('/api/audit.csv', async (req, res) => {
    try {
      const { evData } = await import('../overview.js')
      const days = reportDays(req)
      const sinceSec = Math.floor((Date.now() - days * 24 * 3600 * 1000) / 1000)
      const optActor = ['agent', 'operator', 'contact', 'system'].includes(req.query.actor) ? req.query.actor : null
      const cases = await store.listCases({}, { limit: 10000, offset: 0 })
      const refById = new Map(cases.map(c => [c.id, c.ref]))
      const extById = new Map(cases.map(c => [c.id, String(c.external_id || '')]))
      let rows = await store.listAllEvents(optActor ? { actor: optActor } : {}, { limit: 100000 })
      rows = rows.filter(e => Number(e.created_at) >= sinceSec)
      const lines = []
      lines.push(['case_ref', 'timestamp_sast', 'actor', 'action', 'field', 'old_value', 'new_value', 'reason'].join(','))
      for (const e of rows) {
        const d = evData(e)
        const ext = extById.get(e.case_id) || ''
        // scrub: drop any value equal to the case external_id (contact id/number)
        const scrub = (v) => (v != null && ext && String(v) === ext) ? '[contact]' : (v == null ? '' : String(v))
        const field = d.field || (d.from != null || d.to != null ? 'status' : (d.claimed_by != null ? 'assignee' : ''))
        const oldVal = d.from != null ? d.from : (d.was != null ? d.was : (d.old != null ? d.old : ''))
        const newVal = d.to != null ? scrub(d.to) : (d.claimed_by != null ? d.claimed_by : (d.new != null ? d.new : ''))
        const reason = d.reason || ''
        lines.push([
          csvCell(refById.get(e.case_id) || e.case_id),
          csvCell(fmtTimeSAST(Number(e.created_at))),
          csvCell(e.actor || ''),
          csvCell(e.kind || ''),
          csvCell(field),
          csvCell(scrub(oldVal)),
          csvCell(newVal),
          csvCell(reason),
        ].join(','))
      }
      res.setHeader('Content-Type', 'text/csv')
      res.setHeader('Content-Disposition', 'attachment; filename="casey-audit-trail.csv"')
      res.send(lines.join('\n'))
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/api/report.html', async (req, res) => {
    try {
      const r = await gatherReport(reportDays(req))
      const row = (k, v) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`
      const stageRows = Object.entries(r.by_stage).map(([s, n]) => row(s, n)).join('')
      const areaRows = r.by_area.slice(0, 20).map(a => row(a.place, a.count)).join('')
      const breachRows = Object.entries(r.breaches).map(([b, n]) => row(b, n)).join('') || row('none', 0)
      const opHead = `<tr><td>operator</td><td>open</td><td>stale claims</td><td>replies 24h</td><td>first reply (hrs)</td><td>oldest waiting (hrs)</td></tr>`
      const opRows = r.by_operator.map(o =>
        `<tr><td>${esc(o.name)}</td><td>${esc(o.open_assigned)}</td><td>${esc(o.stale_claims)}</td>`
        + `<td>${esc(o.replies_24h)}</td><td>${esc(msToHrs(o.first_reply_ms_median))}</td>`
        + `<td>${esc(msToHrs(o.oldest_waiting_ms))}</td></tr>`).join('')
        || `<tr><td>none</td><td>0</td><td>0</td><td>0</td><td></td><td></td></tr>`
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>casey management report</title>`
        + `<style>body{font:14px system-ui,sans-serif;margin:2rem;color:#1a1a1a}h1{font-size:1.3rem}h2{font-size:1rem;margin-top:1.5rem}table{border-collapse:collapse;margin:.3rem 0}td{border:1px solid #ccc;padding:.2rem .6rem}@media print{body{margin:0}}</style>`
        + `</head><body><h1>casey management report</h1>`
        + `<p>Generated ${esc(fmtTimeSAST(Math.floor(r.generated_at / 1000)))} -- last ${esc(r.period_days)} days</p>`
        + `<h2>Totals</h2><table>${row('all cases', r.totals.all)}${row('open', r.totals.open)}${row('closed', r.totals.closed)}${row('opened this period', r.opened_this_period)}${row('closed this period', r.closed_this_period)}</table>`
        + `<h2>Response time</h2><table>${row('median first reply (hours)', msToHrs(r.median_first_response_ms))}${row('p90 first reply (hours)', msToHrs(r.p90_first_response_ms))}</table>`
        + `<h2>By stage</h2><table>${stageRows}</table>`
        + `<h2>Hotspots by area</h2><table>${areaRows || row('none', 0)}</table>`
        + `<h2>Team workload</h2><table>${opHead}${opRows}</table>`
        + `<h2>Current health breaches</h2><table>${breachRows}</table>`
        + `</body></html>`
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.send(html)
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Shift handover: a printable digest of what the next person needs to pick up.
  // Built entirely from the event log + attention engine, scoped to "since the
  // last Start-of-shift marker" (or the full open pool when no shift was started).
  // No per-operator scoping -- a rotating field team shares one shift line.
  async function gatherHandover() {
    const now = Date.now()
    const marker = await store.getShiftMarker()
    const since = marker?.ts || 0
    const open = (await store.listCases({}, { limit: 10000 })).filter(isOpenCase)
    const tagsOf = (c) => String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean)
    // Cases still needing attention, ranked by the same scorer the inbox uses.
    const { items } = rankAttention(open, now, { limit: 50, offset: 0 })
    const attention = items.map(({ c, score, reason }) => ({
      id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel,
      status: c.status, assignee: c.assignee || '', score, reason,
    }))
    // Open handoffs not yet taken: a person was asked for and no operator owns it.
    const handoffs = open.filter(c => tagsOf(c).includes('needs-human'))
      .map(c => ({ id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel, assignee: c.assignee || '' }))
    // Unsent assisted drafts waiting for an operator to approve or discard.
    const drafts = open.filter(c => tagsOf(c).includes('draft-pending'))
      .map(c => ({ id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel }))
    // Cases touched since the shift began, with their last action, newest-first.
    const touched = []
    for (const c of open) {
      const at = c.last_event_at || c.updated_at || c.created_at || 0
      if (!since || at < since) continue
      const evs = await store.listEvents(c.id).catch(() => [])
      const last = evs.length ? evs[evs.length - 1] : null
      touched.push({
        id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel,
        at, last_kind: last?.kind || '', last_actor: last?.actor || '',
      })
    }
    touched.sort((a, b) => b.at - a.at)
    return { generated_at: now, since, since_by: marker?.by || null, attention, handoffs, drafts, touched: touched.slice(0, 50) }
  }

  app.get('/api/handover', async (req, res) => {
    try {
      const h = await gatherHandover()
      if (req.query.format !== 'html') return res.json(h)
      const secs = (ms) => Math.floor(ms / 1000)
      const row = (cells) => `<tr>${cells.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`
      const tbl = (head, rows) => rows.length
        ? `<table><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${rows.join('')}</table>`
        : `<p>none</p>`
      const sinceTxt = h.since ? fmtTimeSAST(secs(h.since)) + (h.since_by ? ` (by ${esc(h.since_by)})` : '') : 'start of records'
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>casey shift handover</title>`
        + `<style>body{font:14px system-ui,sans-serif;margin:2rem;color:#1a1a1a}h1{font-size:1.3rem}h2{font-size:1rem;margin-top:1.5rem}table{border-collapse:collapse;margin:.3rem 0}td,th{border:1px solid #ccc;padding:.2rem .6rem;text-align:left}@media print{body{margin:0}}</style>`
        + `</head><body><h1>casey shift handover</h1>`
        + `<p>Generated ${esc(fmtTimeSAST(secs(h.generated_at)))} -- since ${esc(sinceTxt)}</p>`
        + `<h2>Needs attention (${h.attention.length})</h2>`
        + tbl(['ref', 'subject', 'channel', 'owner', 'why'], h.attention.map(a => row([a.ref, a.subject, a.channel, a.assignee || '-', a.reason])))
        + `<h2>Open handoffs not yet taken (${h.handoffs.length})</h2>`
        + tbl(['ref', 'subject', 'channel', 'owner'], h.handoffs.map(a => row([a.ref, a.subject, a.channel, a.assignee || '-'])))
        + `<h2>Unsent drafts (${h.drafts.length})</h2>`
        + tbl(['ref', 'subject', 'channel'], h.drafts.map(a => row([a.ref, a.subject, a.channel])))
        + `<h2>Touched this shift (${h.touched.length})</h2>`
        + tbl(['when', 'ref', 'subject', 'last action'], h.touched.map(a => row([fmtTimeSAST(secs(a.at)), a.ref, a.subject, `${a.last_kind}${a.last_actor ? ' by ' + a.last_actor : ''}`])))
        + `</body></html>`
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.send(html)
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Stamp a new shift marker so the next handover digest scopes "since now".
  app.post('/api/handover/start-shift', async (req, res) => {
    try {
      const m = await store.startShift(actingOperator(req))
      res.json({ ok: true, ts: m.ts, by: m.by })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // AI-offline queue: open cases whose last agent turn FAILED (model error/timeout,
  // store/host fault) so a human could not trust the auto-reply was adequate. The
  // gateway tags such a case 'ai-offline' (cleared by the next operator reply or a
  // later successful agent turn), so this is a cheap tag scan over the open pool --
  // no per-case event read on the hot path. Newest-first by last activity so the
  // freshest outage sits on top of the operator's queue.
  app.get('/api/unreplied', async (req, res) => {
    try {
      const open = (await store.listCases({}, { limit: 10000, offset: 0 }))
        .filter(c => isOpenCase(c)
          && String(c.tags || '').split(',').map(t => t.trim()).includes('ai-offline'))
      open.sort((a, b) => (b.last_event_at || b.updated_at || 0) - (a.last_event_at || a.updated_at || 0))
      const items = open.map(c => ({
        id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel,
        status: c.status, assignee: c.assignee || '',
        last_event_at: c.last_event_at || c.updated_at || c.created_at || 0,
      }))
      res.json({ total: items.length, items })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Cases that look like the SAME real-world outbreak as this one -- the
  // operator's view of casey's grouping intelligence, with the reasons shown so
  // the suggestion is explainable, never an opaque score.
  app.get('/api/cases/:id/suggestions', async (req, res) => {
    try {
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      const { suggestLinks } = await import('../correlate.js')
      const pool = (await store.listCases({}, { limit: 200 }))
        .filter(o => o.id !== c.id && isOpenCase(o)
          && !String(o.tags || '').split(',').map(s => s.trim()).includes('merged'))
      const byId = new Map(pool.map(o => [o.id, o]))
      const suggestions = suggestLinks(c, pool).slice(0, 5)
        .map(s => ({ ...s, subject: byId.get(s.id)?.subject || '', status: byId.get(s.id)?.status || '' }))
      res.json({ count: suggestions.length, suggestions })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })
  // site-durable-entity-visit-history PRD row: a field worker does not OWN a
  // case (a different person may follow up from whoever reported it) -- what
  // an operator actually needs is "who has been to this SITE and when", across
  // every conversation (case) that turns out to be the same real place, not
  // just this one contact's own thread. Rather than a new site/place entity
  // (a schema migration + a second grouping mechanism competing with the
  // existing one), this reuses correlate.js's own location/species/symptom
  // scoring UNCHANGED -- the same signal that already powers "possibly the
  // same case" merge suggestions above -- but over the FULL case pool
  // (open AND closed/resolved: a visit history must include past visits, not
  // only currently-open threads) and returns each match's reporting contact
  // identity + timestamp rather than a merge action. PII discipline: no
  // external_id/contact_id -- "who" is the case ref + reported-by-channel only
  // (the same PII-free shape enquiryRow already uses elsewhere), an operator
  // can open the linked case itself for the real contact detail if needed.
  app.get('/api/cases/:id/site-history', async (req, res) => {
    try {
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      const { suggestLinks } = await import('../correlate.js')
      const pool = (await store.listCases({}, { limit: 500 }))
        .filter(o => o.id !== c.id
          && !String(o.tags || '').split(',').map(s => s.trim()).includes('merged'))
      const byId = new Map(pool.map(o => [o.id, o]))
      const visits = suggestLinks(c, pool, 0.2).slice(0, 20)
        .map(s => {
          const row = byId.get(s.id)
          return {
            id: s.id, ref: s.ref, score: s.score, reasons: s.reasons,
            channel: row?.channel || null,
            status: row?.status || null,
            reported_at: row?.created_at || null,
            last_activity_at: row?.last_event_at || null,
          }
        })
        .sort((a, b) => (Number(b.reported_at) || 0) - (Number(a.reported_at) || 0))
      res.json({ site_ref: c.ref, count: visits.length, visits })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Fold another case (source = req.body.into) INTO this one (target = :id). The
  // target stays canonical; lossless and idempotent in the store.
  app.post('/api/cases/:id/merge', async (req, res) => {
    try {
      const into = str(res, req.body, 'into'); if (into === undefined) return
      if (!into.trim()) return res.status(400).json({ error: 'no source case to merge' })
      const reason = str(res, req.body, 'reason', { required: false }); if (reason === undefined) return
      const res2 = await store.mergeCases(into, req.params.id, actingOperator(req), { reason: reason || 'operator merge' })
      if (res2.error) return res.status(400).json({ error: res2.error })
      res.json({ ok: true, movedEvents: res2.movedEvents, alreadyMerged: !!res2.alreadyMerged })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Split selected events out of this case into a NEW linked case.
  // Body: { event_ids: string[], subject?: string, reason?: string }
  app.post('/api/cases/:id/split', async (req, res) => {
    try {
      const { event_ids, subject, reason } = req.body
      if (!Array.isArray(event_ids) || !event_ids.length) return res.status(400).json({ error: 'event_ids must be a non-empty array' })
      const result = await store.splitCase(req.params.id, event_ids, { subject: subject || '', reason: reason || 'operator split' }, actingOperator(req))
      if (result.error) return res.status(400).json({ error: result.error })
      res.json({ ok: true, new_case_id: result.newCase?.id, new_case_ref: result.newCase?.ref, moved_events: result.movedEvents })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Operator takes over the conversation: send a message to the contact on
  // their channel and record it as an outbound event.
  app.post('/api/cases/:id/reply', async (req, res) => {
    try {
      const raw = str(res, req.body, 'text'); if (raw === undefined) return
      const text = raw.trim()
      if (!text) return res.status(400).json({ error: 'empty reply' })
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      // Try to deliver before claiming success: if the channel send throws, we
      // record the failure and do NOT clear needs-human, so a contact who never
      // got the reply stays pinned in triage rather than silently dropped (P10).
      const op = actingOperator(req)
      let delivered = false
      if (sendReply) {
        try { await sendReply(c, text); delivered = true }
        catch (e) {
          await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `Failed to send operator reply on channel: ${e.message || 'unknown error'}` })
        }
      }
      // Claim-on-reply: the operator who personally answered owns the case. Only
      // auto-claim an unowned case (unset or the default 'agent'); never silently
      // take a case another human already holds -- that stays a soft nudge, not a
      // hard steal. The claim is recorded BEFORE the outbound event so the reply
      // stays the latest event on the timeline, and is its own audited action so
      // the handover is observable.
      let claimed = false
      if (delivered) {
        const current = String(c.assignee || '').trim()
        if (!current || current === 'agent') {
          await store.updateCase(c.id, { assignee: op.id }, op)
          await store.appendEvent(c.id, { kind: 'action', actor: 'operator', text: `Claimed by ${op.name || op.id}`, data: { claimed_by: op.id, was: current || null } })
          claimed = true
        }
      }
      await store.appendEvent(c.id, { kind: 'outbound', actor: 'operator', channel: c.channel, text, data: { to: c.external_id, by: op.id } })
      // A personal reply is the strongest working-area signal casey has.
      if (op.id !== OPERATOR.id) store.learnOperatorActivity(op.id, c).catch(() => {})
      // The operator personally answered, so the "wants a human" flag is satisfied
      // -- but only once the message actually reached the contact. Clear it then,
      // or the triage inbox keeps this case pinned at the top forever.
      // Clearing needs-human (a person was asked for) and ai-offline (the agent turn
      // had failed and a human needed to verify the reply): a delivered operator
      // answer satisfies both, so drop them together rather than leaving the case
      // pinned in the triage inbox or the offline queue forever.
      if (delivered) {
        const tags = String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean)
        const keep = tags.filter(t => t !== 'needs-human' && t !== 'ai-offline')
        if (keep.length !== tags.length) {
          await store.updateCase(c.id, { tags: keep.join(',') }, op)
        }
      }
      res.json({ ok: true, sent: !!sendReply, delivered, claimed })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // The latest pending assisted-mode draft for a case, or null. A draft is
  // "pending" only while draft-pending is on the case (cleared on
  // approve/discard/supersede), so we read the most recent draft event and gate
  // on the tag rather than tracking draft state separately.
  async function pendingDraft(c) {
    const tags = String(c.tags || '').split(',').map(t => t.trim())
    if (!tags.includes('draft-pending')) return null
    const events = await store.listEvents(c.id)
    const drafts = events.filter(e => e.kind === 'draft')
    return drafts.length ? drafts[drafts.length - 1] : null
  }

  // Approve a held assisted draft: send the (possibly operator-edited) text to the
  // contact, record it as an operator outbound, and clear draft-pending +
  // needs-human only once it actually delivered -- mirroring the reply path so a
  // failed send leaves the case pinned rather than silently dropped.
  app.post('/api/cases/:id/draft/approve', async (req, res) => {
    try {
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      const draft = await pendingDraft(c)
      if (!draft) return res.status(409).json({ error: 'no pending draft' })
      // Operator may edit before approving; fall back to the drafted text.
      let text = draft.text || ''
      if (req.body && typeof req.body.text === 'string' && req.body.text.trim()) text = req.body.text.trim()
      if (!text) return res.status(400).json({ error: 'empty draft' })
      let delivered = false
      if (sendReply) {
        try { await sendReply(c, text); delivered = true }
        catch (e) { await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `Failed to send approved draft on channel: ${e.message || 'unknown error'}` }) }
      }
      const op = actingOperator(req)
      await store.appendEvent(c.id, { kind: 'outbound', actor: 'operator', channel: c.channel, text, data: { to: c.external_id, from_draft: true, by: op.id } })
      if (delivered) {
        const tags = String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean)
        await store.updateCase(c.id, { tags: tags.filter(t => t !== 'draft-pending' && t !== 'needs-human').join(',') }, op)
      }
      res.json({ ok: true, sent: !!sendReply, delivered })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Discard a held assisted draft without sending: clear draft-pending and record
  // the decision. needs-human stays -- a discarded draft still wants a human to
  // decide what (if anything) to say next.
  app.post('/api/cases/:id/draft/discard', async (req, res) => {
    try {
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      const draft = await pendingDraft(c)
      if (!draft) return res.status(409).json({ error: 'no pending draft' })
      const reason = (req.body && typeof req.body.reason === 'string' ? req.body.reason.trim() : '') || 'operator discarded'
      const op = actingOperator(req)
      const tags = String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean)
      await store.updateCase(c.id, { tags: tags.filter(t => t !== 'draft-pending').join(',') }, op)
      await store.appendEvent(c.id, { kind: 'observation', actor: 'operator', text: `DRAFT DISCARDED: ${reason}.`, data: { by: op.id } })
      res.json({ ok: true })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Printable case briefing for field teams. Plain HTML, no JS, print-friendly.
  // Uses the module-level esc() (line ~449) -- was a locally re-declared,
  // strictly weaker copy missing the apostrophe escape; consolidated.
  app.get('/api/cases/:id/report.html', async (req, res) => {
    try {
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).send('<p>Case not found.</p>')
      let r = {}
      try { r = c.report ? JSON.parse(c.report) : {} } catch { r = {} }
      const LABELS = { species: 'Animals', symptoms: 'Signs seen', affected_count: 'How many affected',
        dead_count: 'How many died', onset: 'When it started', suspected_disease: 'Suspected disease',
        recent_movement: 'Recent movement', location: 'Where', how_to_find: 'How to find the place',
        access_notes: 'Getting there', farmer_available: 'Farmer available?',
        contact_fallback: 'Other contact', identifying_traits: 'Identifying the animals',
        photos: 'Photos', audio: 'Voice notes', notes: 'Other notes' }
      // A saved media path looks like "...(saved: media/<caseId>/<file>)" (see
      // case-store.js saveMedia / gateway-hooks.js) -- surface it as a real link
      // to /media/<path> so a field-team briefing can actually open the photo/
      // voice note, not just read that one arrived.
      const mediaLinkRe = /\(saved: (media\/[^)]+)\)/g
      const rows = REPORT_KEY_LIST.map(k => {
        let val = '<em>not recorded</em>'
        if (r[k] != null && String(r[k]).trim()) {
          const raw = String(r[k])
          if (k === 'location') {
            const mapHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(raw)}`
            val = `${esc(raw)} <a href="${esc(mapHref)}" target="_blank" rel="noopener" style="font-size:12px">[map]</a>`
          } else if (k === 'photos' || k === 'audio') {
            val = esc(raw).replace(mediaLinkRe, (_m, p) => `(<a href="/${esc(p)}" target="_blank" rel="noopener">open</a>)`)
          } else {
            val = esc(raw)
          }
        }
        return `<tr><th>${esc(LABELS[k] || k)}</th><td>${val}</td></tr>`
      }).join('')
      // Maps link when location field is available
      const mapsUrl = r.location ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(r.location))}` : null
      // tel: link for the external_id if it looks like a phone
      const phone = c.external_id || ''
      const telLink = /^[+0-9]{7,}$/.test(phone.replace(/[\s\-()]/g, '')) ? `tel:${phone.replace(/[\s\-()]/g, '')}` : null
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Case ${esc(c.ref||c.id)} briefing</title>
<style>body{font-family:sans-serif;max-width:700px;margin:2em auto;color:#111}
h1{font-size:1.2em;margin-bottom:.5em}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:.4em .6em;border:1px solid #ccc;vertical-align:top}
th{width:40%;background:#f5f5f5;font-weight:600}
.act{display:flex;gap:12px;flex-wrap:wrap;margin:10px 0}
.act a{background:#2f6fb0;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600}
.act a:hover{background:#1a5592}
@media print{body{margin:0}.act{display:none}}</style></head>
<body><h1>Field briefing: ${esc(c.ref||c.id)}</h1>
<p><strong>Subject:</strong> ${esc(c.subject||'')}</p>
<p><strong>Status:</strong> ${esc(c.status||'')} &nbsp; <strong>Channel:</strong> ${esc(c.channel||'')}</p>
<div class="act">
  <a href="javascript:window.print()">Print this page</a>
  ${mapsUrl ? `<a href="${esc(mapsUrl)}" target="_blank" rel="noopener">Open in Maps</a>` : ''}
  ${telLink ? `<a href="${esc(telLink)}">Call contact</a>` : ''}
</div>
<table>${rows}</table></body></html>`
      res.type('html').send(html)
    } catch (e) { res.status(500).send('<p>Error: ' + esc(String(e.message || 'unknown error')) + '</p>') }
  })

  const PWA_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="32" fill="#3b6ea5"/><text x="96" y="136" font-family="system-ui,sans-serif" font-size="120" font-weight="700" fill="#fff" text-anchor="middle">C</text></svg>`
  app.get('/icon.svg', (_req, res) => res.type('image/svg+xml').send(PWA_ICON_SVG))
  app.get('/manifest.json', (_req, res) => res.json({
    name: 'casey', short_name: 'casey', start_url: '/', display: 'standalone',
    background_color: '#0f1115', theme_color: '#3b6ea5',
    description: 'Animal-disease surveillance case management',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  }))
  // Service worker: cache-first for app shell assets, network-first for API, offline.html fallback.
  app.get('/sw.js', (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(`
const CACHE='casey-v1'
const SHELL=['/offline.html','/icon.svg']
self.addEventListener('install',e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL))); self.skipWaiting() })
self.addEventListener('activate',e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))); self.clients.claim() })
self.addEventListener('fetch',e=>{
  const u=e.request.url
  if(u.includes('/api/')){ e.respondWith(fetch(e.request).catch(()=>new Response(JSON.stringify({error:'offline'}),{status:503,headers:{'content-type':'application/json'}}))); return }
  e.respondWith(fetch(e.request).catch(()=>caches.match('/offline.html')))
})
`)
  })
  app.get('/offline.html', (_req, res) => {
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>casey - offline</title>
<style>body{font-family:sans-serif;background:#0f1115;color:#cdd3de;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}
.card{max-width:360px}.card h1{font-size:1.4em;margin:0 0 8px}p{color:#8b95a6;line-height:1.5;margin:0 0 16px}
a{color:#3b6ea5;text-decoration:none;border:1px solid #3b6ea5;border-radius:6px;padding:8px 18px;display:inline-block}a:hover{background:#1e2a3a}</style>
</head><body><div class="card">
<h1>casey</h1>
<p>You are offline. Please check your connection and try again.</p>
<a href="/">Try again</a>
</div></body></html>`)
  })
  app.get('/', (_req, res) => res.type('html').send(PAGE))

  const server = app.listen(port)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => {
      resolve({ app, server, port, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r) }) })
    })
  })
}

// Self-contained page. Uses anentrypoint-design's CSS variables/typography for
// theming; the interactive shell is plain webjsx-flavoured DOM so it needs no
// build step. The API is the contract; this page is the operator's whole world,
// so it carries the friendliness affordances: live search + status filter,
// non-blocking toasts (no alert()), empty/loading/connection states, relative
// timestamps, keyboard nav, a light/dark toggle, attention indicators, a
// shareable case deep-link, and a poll that pauses while you type so it never
// clobbers an in-progress edit. Every contact-controlled value still flows
// through esc() before it touches innerHTML.
const PAGE = /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="casey">
<meta name="theme-color" content="#0f1115">
<link rel="manifest" href="/manifest.json">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<link rel="apple-touch-icon" href="/icon.svg">
<title>casey - cases</title>
<link rel="stylesheet" href="/design/colors_and_type.css">
<link rel="stylesheet" href="/design/app-shell.css">
<link rel="stylesheet" href="/design/editor-primitives.css">
<link rel="stylesheet" href="/vendor/leaflet/leaflet.css">
<link rel="stylesheet" href="/vendor/leaflet.markercluster/MarkerCluster.css">
<link rel="stylesheet" href="/vendor/leaflet.markercluster/MarkerCluster.Default.css">
<style>
  :root{--bg:#0f1115;--fg:#e6e6e6;--panel:#11141a;--border:#262a33;--border-soft:#20242c;
 --muted:#9aa6b2;--faint:#6b7685;--accent:#3b6ea5;--accent-soft:#1b2430;--hover:#171a21;--danger:#5a2230}
  html[data-theme=light]{--bg:#f6f7f9;--fg:#1a1f29;--panel:#fff;--border:#d6dbe2;--border-soft:#e4e8ee;
 --muted:#5a6675;--faint:#8a94a3;--accent:#2f6fb0;--accent-soft:#e7f0fa;--hover:#eef1f5;--danger:#c0392b}
  *{box-sizing:border-box}
  body{margin:0;font-family:var(--font-sans,system-ui);background:var(--bg);color:var(--fg)}
  .wrap{display:grid;grid-template-columns:360px 1fr;height:100vh}
  .list{border-right:1px solid var(--border);overflow:auto;display:flex;flex-direction:column;min-height:0}
  .detail{overflow:auto;padding:20px}
  .report{margin:0 0 16px;border:1px solid var(--border);border-radius:8px;overflow:hidden}
  .rep-head{padding:8px 12px;background:var(--panel);font-weight:600;font-size:13px;border-bottom:1px solid var(--border-soft)}
  .rep-row{display:flex;gap:10px;padding:6px 12px;border-bottom:1px solid var(--border-soft);font-size:13px}
  .rep-row:last-child{border-bottom:none}
  .rep-label{flex:0 0 42%;color:var(--muted)}
  .rep-val{flex:1 1 auto;word-break:break-word}
  .rep-missing{color:var(--muted);font-style:italic;opacity:.7}
  .rep-src-legend{font-size:11px;color:var(--muted);padding:4px 12px 4px;border-bottom:1px solid var(--border-soft)}
  .rep-ready{padding:7px 12px;font-size:12px;font-weight:600;border-bottom:1px solid var(--border-soft)}
  .rep-ready.ok{color:#1c8c44;background:rgba(34,160,80,.10)}
  .rep-ready.amber{color:#9a6a00;background:rgba(200,140,0,.10)}
  .topbar{padding:10px 14px;border-bottom:1px solid var(--border-soft);position:sticky;top:0;background:var(--bg);z-index:2}
  .topbar h1{font-size:14px;margin:0 0 8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .counts{font-size:11px;color:var(--muted);font-weight:400}
  .icon-btn{background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:6px;
        padding:3px 8px;cursor:pointer;margin:0;font-size:12px;line-height:1}
  .icon-btn:hover{background:var(--hover);color:var(--fg)}
  .icon-btn.active{background:var(--accent-soft);color:var(--fg);border-color:var(--accent)}
  .filters{display:flex;gap:6px;flex-wrap:wrap}
  .filters input{flex:2 1 120px}.filters select{flex:1 1 80px}
  .caselist{overflow:auto;flex:1;min-height:0}
  .case{padding:12px 14px;border-bottom:1px solid var(--border-soft);cursor:pointer}
  .case:hover{background:var(--hover)}
  .case.active{background:var(--accent-soft)}
  .case .top{display:flex;align-items:center;gap:6px}
  .ref{font-weight:600}
  .dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:0 0 auto}
  .dot.attn{background:#d8a000}
  .badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;background:var(--border);margin-left:2px}
  .badge.high,.badge.urgent{background:var(--danger);color:#fff}
  .sub{font-size:12px;color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .when{font-size:11px;color:var(--faint)}
  .ev{padding:8px 0 8px 10px;border-bottom:1px dashed var(--border-soft);font-size:13px;border-left:3px solid transparent}
  .ev.inbound{border-left-color:#3b6ea5}.ev.outbound{border-left-color:#2e8b57}
  .ev.note{border-left-color:#8a6d3b}.ev.action{border-left-color:#6a5acd}
  .ev.transition{border-left-color:#b07cc6}.ev.observation{border-left-color:#7a8290}
  .ev.autonomy_change{border-left-color:#d98a00;background:rgba(217,138,0,.07)}
  .tcase.heat-3{box-shadow:inset 4px 0 0 #c0392b}
  .tcase.heat-2{box-shadow:inset 4px 0 0 #d98a00}
  .tcase.heat-1{box-shadow:inset 4px 0 0 #b8b8b8}
  .tcase .waiting{font-size:11px;color:#c0392b;font-weight:600;margin-left:6px}
  .draft-banner{margin-top:14px;padding:10px 12px;border:1px solid #d98a00;background:rgba(217,138,0,.1);border-radius:8px}
  .draft-banner .draft-lab{font-size:13px;font-weight:600;color:#d98a00;margin-bottom:8px}
  .draft-banner .draft-acts{display:flex;gap:8px}
  .draft-banner .draft-ok{background:#1f7a3d}
  .draft-banner .draft-no{background:#2a3340}
  .set-row{margin-bottom:12px}
  .set-row label{display:block;font-size:13px;font-weight:600;margin-bottom:3px}
  .set-row .set-in{display:flex;align-items:center;gap:6px}
  .set-row .set-in input{width:90px}
  .set-row .set-in span{font-size:12px;color:var(--muted)}
  .set-state{margin-left:10px;font-size:12px;color:var(--muted)}
  .metric-trend{margin-top:10px;display:flex;gap:24px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
  .metric-trend b{color:var(--fg)}
  .cl-row{padding:8px 0;border-bottom:1px solid var(--border)}
  .cl-head{font-size:13px;margin-bottom:5px}
  .cl-sub{font-size:12px;color:var(--muted);margin-bottom:4px}
  .cl-chips{display:flex;flex-wrap:wrap;gap:4px}
  .cl-sev{display:inline-block;background:var(--danger,#b4432e);color:#fff;font-size:11px;font-weight:700;padding:1px 6px;border-radius:4px;margin-right:6px}
  .ref-chip{background:#2a3340;font-size:12px;padding:2px 8px}
  .bt-sec{margin-top:14px}
  .bt-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:4px}
  .bt-table th,.bt-table td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--border)}
  .bt-table th{color:var(--muted);font-weight:600}
  .bt-overall td{border-top:2px solid var(--border)}
  .risk-strip{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
  .risk-chip{background:#3a2a2a;border:1px solid var(--danger,#b4432e);font-size:12px;padding:2px 8px;border-radius:4px}
  .geo-list{display:flex;flex-direction:column}
  .geo-row{display:grid;grid-template-columns:1fr auto 2fr 2fr;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px}
  .geo-place{font-weight:600}
  .geo-count{font-weight:700;color:var(--danger)}
  .geo-mix,.geo-when{color:var(--muted);font-size:12px}
  .act-list{display:flex;flex-direction:column}
  .act-row{display:grid;grid-template-columns:auto auto auto 1fr;gap:10px;align-items:baseline;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px;cursor:pointer}
  .act-row:hover{background:var(--bg2)}
  .act-when{color:var(--muted);white-space:nowrap}
  .act-kind{font-weight:600;white-space:nowrap}
  .act-who{color:var(--muted);white-space:nowrap}
  .act-text{color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #op-picker{background:var(--bg2);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:4px 6px;font-size:12px}
  .owner-chip{display:inline-block;font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px;background:var(--bg2);color:var(--muted);border:1px solid var(--border);vertical-align:middle}
  .owner-chip.mine{background:var(--accent);color:#fff;border-color:var(--accent)}
  .tcase.claimed-other{opacity:.62}
  #offline-btn.has-queue{background:var(--danger);color:#fff}
  .off-badge{color:var(--danger);font-weight:700}
  .ho-since{font-size:11px;color:var(--muted);margin-bottom:6px}
  .ho-sec{margin-bottom:10px}
  .ho-h{font-size:12px;font-weight:700;color:var(--muted);margin-bottom:3px}
  .ho-h .n{color:var(--danger)}
  .ho-row{display:flex;gap:8px;align-items:baseline;padding:3px 0;border-bottom:1px solid var(--border);font-size:12px;flex-wrap:wrap}
  .ho-ref{font-weight:700;cursor:pointer;color:var(--accent)}
  .ho-sub{color:var(--fg)}
  .ho-why{color:var(--muted)}
  .bulk-bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 8px;border-bottom:1px solid var(--border);background:var(--bg2)}
  .bulk-bar .bulk-all{display:flex;align-items:center;gap:4px;font-size:12px;color:var(--muted);margin:0}
  .bulk-bar input[type=checkbox]{width:auto;margin:0}
  .bulk-bar select{width:auto;font-size:12px;padding:4px 6px;margin:0}
  .case{display:flex;align-items:flex-start;gap:6px}
  .case .case-body{flex:1;min-width:0;cursor:pointer}
  .case-cb{width:auto;margin:4px 0 0;flex:0 0 auto}
  .case.selected{background:var(--bg2);box-shadow:inset 3px 0 0 var(--accent)}
  .undo-toast{display:flex;align-items:center;gap:10px}
  .undo-toast .undo-btn{margin:0;padding:3px 10px;font-size:12px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.4)}
  .ev .k{display:inline-block;min-width:120px;color:#8aa0c0;font-size:11px}
  label{display:block;margin:8px 0 2px;font-size:12px;color:var(--muted)}
  .hint{font-size:11px;color:var(--faint);margin:2px 0 0}
  input,select,textarea{width:100%;background:var(--panel);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 8px;font-size:16px}
  button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:7px 12px;cursor:pointer;margin-top:8px}
  button:disabled{opacity:.55;cursor:default}
  .row{display:flex;gap:8px;flex-wrap:wrap}.row>*{flex:1}
  .empty{padding:20px 16px;color:var(--faint);font-size:13px;line-height:1.5}
  .conn{display:none;background:var(--danger);color:#fff;font-size:12px;padding:5px 14px;text-align:center}
  .conn.show{display:block}
  #toasts{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:50;max-width:340px}
  .toast{background:var(--panel);border:1px solid var(--border);border-left:4px solid var(--accent);
        border-radius:6px;padding:9px 12px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3);cursor:pointer}
  .toast.err{border-left-color:var(--danger)}.toast.ok{border-left-color:#2e8b57}
  .copy{background:transparent;color:var(--faint);border:0;cursor:pointer;padding:0 4px;margin:0;font-size:12px}
  .copy:hover{color:var(--fg)}
  @media(max-width:720px){
    .wrap{grid-template-columns:1fr}
    .wrap.detail-open .list{display:none}
    .wrap:not(.detail-open) .detail{display:none}
    .back{display:inline-block}
  }
  .back{display:none}
  /* plain-words help overlay + per-case "what to do now" hint */
  .help-ovl{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100;display:none;
        align-items:flex-start;justify-content:center;overflow:auto;padding:40px 16px}
  .help-ovl.show{display:flex}
  .help-card{background:var(--panel);border:1px solid var(--border);border-radius:10px;
        max-width:560px;width:100%;padding:22px 24px;box-shadow:0 8px 40px rgba(0,0,0,.45);font-size:14px;line-height:1.55}
  .help-card h2{margin:0 0 4px;font-size:18px}
  .help-card h3{margin:16px 0 4px;font-size:14px;color:var(--fg)}
  .help-card p{margin:6px 0;color:var(--muted)}
  .help-card .lead{color:var(--fg)}
  .help-card ul{margin:6px 0;padding-left:18px;color:var(--muted)}
  .help-card li{margin:4px 0}
  .help-card .swatch{display:inline-block;width:9px;height:9px;border-radius:50%;background:#d8a000;vertical-align:middle;margin-right:4px}
  .help-card .foot{font-size:12px;color:var(--faint);margin-top:10px}
  .skills-list{list-style:none;margin:10px 0;padding:0}
  .skills-list li{display:flex;align-items:flex-start;gap:8px;margin:8px 0;cursor:pointer;color:var(--fg)}
  .skills-list li .box{flex:0 0 auto;width:18px;height:18px;border:2px solid var(--border);border-radius:4px;text-align:center;line-height:15px;font-size:12px;color:transparent}
  .skills-list li.done .box{background:var(--accent,#2f6fb0);border-color:var(--accent,#2f6fb0);color:#fff}
  .skills-list li.done span.lbl{color:var(--muted);text-decoration:line-through}
  .icon-btn.active{background:var(--accent-soft);color:var(--fg);border-color:var(--accent)}
  .todo{background:var(--accent-soft);border:1px solid var(--border);border-left:3px solid var(--accent);
        border-radius:6px;padding:9px 12px;margin:10px 0 14px;font-size:13px;color:var(--fg);line-height:1.5}
  /* triage inbox (pinned top of list) + coaching buttons */
  .triage{border-bottom:1px solid var(--border);background:var(--accent-soft)}
  .triage h2{font-size:13px;margin:0;padding:10px 14px 6px;display:flex;align-items:center;gap:8px}
  .triage h2 .n{background:var(--danger);color:#fff;border-radius:10px;padding:1px 8px;font-size:12px}
  .triage .calm{padding:14px;color:var(--muted);font-size:13px;line-height:1.5}
  .tcase{padding:12px 14px;border-top:1px solid var(--border-soft);cursor:pointer}
  .tcase:hover{background:var(--hover)}
  .tcase.active{outline:2px solid var(--accent);outline-offset:-2px}
  .tcase .why{font-size:13px;color:var(--fg);font-weight:600;margin-bottom:3px}
  .tcase .meta{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* canned-reply coaching buttons: big touch targets, theme-aware (readable in light mode) */
  .canned{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 0}
  .canned button{margin:0;background:var(--panel);color:var(--fg);border:1px solid var(--border);
        border-radius:8px;padding:10px 14px;font-size:14px;min-height:44px;text-align:left;flex:0 1 auto}
  .canned button:hover{background:var(--hover);border-color:var(--accent)}
  .canned-lab{font-size:12px;color:var(--muted);margin:12px 0 0}
  /* intake form overlay (New Case + Edit Report) */
  .intake-ovl{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:200;display:none;
        align-items:flex-start;justify-content:center;overflow:auto;padding:30px 16px}
  .intake-ovl.show{display:flex}
  .intake-card{background:var(--panel);border:1px solid var(--border);border-radius:10px;
        max-width:600px;width:100%;padding:22px 24px;box-shadow:0 8px 40px rgba(0,0,0,.5);font-size:14px;max-height:calc(100dvh - 60px);overflow:auto}
  .intake-card h2{margin:0 0 12px;font-size:18px}
  .intake-card .field-hint{font-size:11px;color:var(--faint);margin:0 0 4px}
  .intake-card .fill-bar{display:flex;gap:6px;align-items:center;margin:0 0 14px;font-size:12px;color:var(--muted)}
  .intake-card .fill-bar .bar{flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden}
  .intake-card .fill-bar .bar .fill{height:100%;background:#2e8b57;transition:width .3s}
  .intake-section-head{font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin:10px 0 4px;padding:4px 0;border-bottom:1px solid var(--border-soft)}
  .intake-vc-note{font-weight:400;text-transform:none;letter-spacing:0;opacity:.8}
  .intake-req{color:var(--danger);font-size:13px;margin-left:2px}
  .intake-ovl textarea{resize:vertical;min-height:52px}
  .intake-step-bar{display:flex;align-items:center;gap:6px;margin:0 0 14px;font-size:12px;color:var(--muted)}
  .intake-step-bar .step-dot{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;background:var(--border);color:var(--muted);flex-shrink:0}
  .intake-step-bar .step-dot.active{background:var(--accent);color:#fff}
  .intake-step-bar .step-dot.done{background:var(--accent);color:#fff;opacity:.6}
  .intake-step-bar .step-line{flex:1;height:2px;background:var(--border);border-radius:1px}
  .intake-step-bar .step-line.done{background:var(--accent);opacity:.5}
  .intake-hint-btn{background:none;border:none;cursor:pointer;font-size:11px;color:var(--muted);padding:0 0 0 4px;vertical-align:middle;line-height:1}
  .intake-hint-btn:hover{color:var(--accent)}
  .intake-hint-box{display:none;font-size:12px;color:var(--muted);background:var(--surface,#f8f8f8);border:1px solid var(--border);border-radius:6px;padding:6px 10px;margin:2px 0 6px;line-height:1.4}
  .intake-hint-box.open{display:block}
  .intake-vc-fill{display:flex;align-items:center;gap:8px;margin:0 0 10px;font-size:12px;color:var(--muted)}
  .intake-vc-fill .bar{flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden}
  .intake-vc-fill .bar .fill{height:100%;background:var(--danger,#c00);transition:width .3s,background .3s}
  .fill-pill{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:var(--border);color:var(--muted);margin-left:6px;vertical-align:middle}
  .fill-pill.ok{background:rgba(34,160,80,.18);color:#1c8c44}
  .fill-pill.low{background:rgba(200,140,0,.18);color:#9a6a00}
  .src-tag{font-size:10px;font-weight:600;padding:1px 5px;border-radius:8px;margin-left:4px;vertical-align:middle}
  .src-ai{background:rgba(59,110,165,.18);color:#5a90cc}
  .src-manual{background:rgba(90,170,130,.18);color:#2e8b57}
  .src-both{background:rgba(160,100,180,.18);color:#9060b0}
  .intake-mode-badge{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:rgba(90,170,130,.18);color:#2e8b57;margin-left:6px;vertical-align:middle}
  .rep-editable{cursor:text;border-radius:3px;padding:1px 3px;transition:background .15s}
  .rep-editable:hover{background:var(--hover)}
  .rep-field-input{width:100%;background:var(--panel);border:1px solid var(--accent);color:var(--fg);border-radius:4px;padding:3px 6px;font-size:13px}
  .rep-saving{opacity:.6}
  .rep-note-btn{background:transparent;color:var(--faint);border:0;cursor:pointer;padding:0 0 0 6px;margin:0;font-size:10px;vertical-align:middle}
  .rep-note-btn:hover{color:var(--accent)}
  .rep-field-note{font-size:11px;color:var(--muted);background:var(--hover);border-radius:4px;padding:3px 7px;margin-top:3px;border-left:2px solid var(--border)}
  /* handoff alert banner: loud, sticky, dismiss-per-case */
  .handoff{display:none;background:var(--danger);color:#fff;padding:10px 14px;font-size:14px;
        line-height:1.4;align-items:center;gap:10px;cursor:pointer;border-bottom:1px solid rgba(0,0,0,.3)}
  .handoff.show{display:flex;animation:handoff-pulse 1.3s ease-in-out infinite}
  .handoff b{font-weight:700}
  .handoff .x{margin-left:auto;background:rgba(255,255,255,.15);border:0;color:#fff;border-radius:6px;
        padding:4px 10px;margin:0;cursor:pointer;font-size:13px}
  .handoff .x:hover{background:rgba(255,255,255,.3)}
  @keyframes handoff-pulse{0%,100%{opacity:1}50%{opacity:.72}}
  /* health breach chips */
  .health{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}
  .health-chip{display:inline-block;background:rgba(200,140,0,.18);color:#9a6a00;border:1px solid rgba(200,140,0,.3);border-radius:10px;padding:2px 10px;font-size:11px;font-weight:600}
  html[data-theme=light] .health-chip{background:rgba(180,120,0,.12);color:#7a5200}
  .breach-detail{font-size:11px;color:var(--muted);margin-left:4px}
  .intake-vc-box{background:rgba(200,100,0,.07);border:1px solid rgba(200,100,0,.2);border-radius:8px;padding:10px 12px;margin-bottom:4px}
  html[data-theme=light] .intake-vc-box{background:rgba(200,100,0,.05);border-color:rgba(200,100,0,.15)}
  /* reply character counter */
  .reply-counter{font-size:11px;color:var(--faint);text-align:right;margin-top:2px}
  .reply-counter.warn{color:#9a6a00}.reply-counter.over{color:var(--danger)}
  /* intake stats panel */
  .stats-panel{border-bottom:1px solid var(--border);background:var(--panel);padding:10px 14px;display:none}
  .stats-panel.show{display:block}
  .stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin-top:8px}
  .stats-card{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px}
  .stats-card .sc-mode{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:4px}
  .stats-card .sc-count{font-size:22px;font-weight:700;color:var(--fg)}
  .stats-card .sc-detail{font-size:11px;color:var(--muted);margin-top:2px}
  .stats-card .sc-vc{font-size:12px;color:var(--accent);font-weight:600;margin-top:4px}
  /* Focus / inbox mode: only the ranked attention list, chrome stripped, list poll quieted. */
  body.inbox-mode .filters,
  body.inbox-mode .stats-panel,
  body.inbox-mode #bulk-bar,
  body.inbox-mode #cases{display:none}
  body.inbox-mode #focus-btn{background:var(--accent);color:#fff;border-color:var(--accent)}
  body.inbox-mode .triage{margin-top:4px}
  .team-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
  .team-card{border:1px solid var(--border);border-radius:8px;padding:8px 10px}
  .team-stale{border-color:var(--danger,#c0392b)}
  .team-name{font-weight:700;margin-bottom:4px}
  .team-stat{display:flex;justify-content:space-between;align-items:baseline;font-size:12px;color:var(--muted)}
  .team-stat .n{font-weight:700;color:var(--fg,inherit)}
  .team-stat.team-warn .n{color:var(--danger,#c0392b)}
  .map-wrap{height:min(70vh,640px);border-radius:8px;overflow:hidden;border:1px solid var(--border)}
  .map-legend{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin:6px 0}
  .map-legend .sw{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:4px;vertical-align:middle}
  .map-filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
  .leaflet-popup-content{font-size:12px}
</style></head>
<body>
<script src="/vendor/leaflet/leaflet.js"></script>
<script src="/vendor/leaflet.markercluster/leaflet.markercluster.js"></script>
<div id="conn" class="conn">Connection lost - retrying...</div>
<div id="handoff" class="handoff" title="Click to open the person who needs help">
  <span id="handoff-msg"></span>
  <button class="x" id="handoff-dismiss" title="Hide this message">Hide</button>
</div>
<div class="wrap" id="wrap">
  <div class="list">
    <div class="topbar">
      <h1>casey <span class="counts" id="counts"></span>
        <span class="aihealth" id="aihealth" title="Is the AI helper connected?" style="margin-left:12px;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600"></span>
        <span class="aihealth" id="runtime-pill" title="Is the casey process healthy?" style="margin-left:6px;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600;display:none"></span>
        <span class="aihealth" id="guardrails-pill" title="Latest health-guardrail sweep" style="margin-left:6px;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600;display:none"></span>
        <button class="icon-btn" id="help" title="What does this screen mean?" style="margin-left:auto">?</button>
        <button class="icon-btn" id="new-case-btn" title="Add a case manually (no WhatsApp or Discord needed)">+ New</button>
        <button class="icon-btn" id="export-btn" title="Download all cases as a spreadsheet (CSV)">Export</button>
        <button class="icon-btn" id="sweep-btn" title="Run health-guardrail sweep now (re-evaluates all cases for time-based issues)">Sweep</button>
        <button class="icon-btn" id="stats-btn" title="Show fill-rate comparison by intake source">Stats</button>
        <button class="icon-btn" id="settings-btn" title="Tune how long casey waits before flagging a case">Settings</button>
        <button class="icon-btn" id="metrics-btn" title="Response times, backlog and trend">Metrics</button>
        <button class="icon-btn" id="clusters-btn" title="Cases that look like one outbreak">Outbreaks</button>
        <button class="icon-btn" id="geo-btn" title="Where reports are concentrating">Hotspots</button>
        <button class="icon-btn" id="map-btn" title="Every case pinned on a map: status, type, species, outbreak links, operator coverage">Map</button>
        <button class="icon-btn" id="activity-btn" title="Everything that has happened, newest first">Activity</button>
        <button class="icon-btn" id="handover-btn" title="Start-of-shift digest: what needs you, open handoffs, unsent drafts, what changed">Shift</button>
        <button class="icon-btn" id="offline-btn" title="Cases that came in while casey could not answer -- waiting for a person">AI offline</button>
        <button class="icon-btn" id="team-btn" title="Who is holding what: open cases per person, stale claims, replies today, response speed">Team</button>
        <button class="icon-btn" id="contacts-btn" title="Everyone who has reported: their access tier, and a promote/demote control">Reporters</button>
        <select id="op-picker" title="Who you are -- attributed on your actions" style="display:none"></select>
        <button class="icon-btn" id="focus-btn" title="Focus mode: show only the ranked Needs-you-now list, lighten background polling (good on a phone)">Focus</button>
        <button class="icon-btn" id="refresh" title="Refresh now">Refresh</button>
        <button class="icon-btn" id="theme" title="Toggle light/dark">dark</button>
        <button class="icon-btn" id="simple" title="Plain-language mode: show friendly stage names">Aa</button>
      </h1>
      <div class="filters">
        <input id="q" placeholder="Search ref, subject, contact... ( / )" autocomplete="off">
        <select id="statusf"><option value="">all stages</option></select>
        <select id="channelf" title="Filter by channel"><option value="">all channels</option></select>
        <select id="sourcef" title="Filter by intake source"><option value="">all sources</option><option value="manual">Manual (operator)</option><option value="channel">Channel (AI)</option><option value="public_form">Public form</option></select>
        <button class="icon-btn" id="mine-btn" title="Show only the cases you have claimed (pick who you are first, top-right)">Mine</button>
        <select id="viewsf" title="Saved views: a named bundle of your current filters. Pick one to apply, or Save view to keep the current set."><option value="">saved views</option></select>
        <button class="icon-btn" id="view-save" title="Save the current filters (search, stage, channel, source, Mine, Focus) as a named view you can return to or share by link">Save view</button>
      </div>
    </div>
    <div class="stats-panel" id="stats-panel">
      <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:4px">Fill-rate by intake source</div>
      <div class="stats-grid" id="stats-grid"><div class="empty" style="grid-column:1/-1;padding:8px 0">Loading...</div></div>
    </div>
    <div class="stats-panel" id="settings-panel">
      <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:4px">How long before casey flags a case</div>
      <div id="settings-body"><div class="empty" style="padding:8px 0">Loading...</div></div>
    </div>
    <div class="stats-panel" id="metrics-panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <div style="font-size:12px;font-weight:700;color:var(--muted)">How the team is doing (last 14 days)</div>
        <span><a id="report-csv" class="icon-btn" style="text-decoration:none" href="/api/report.csv?days=14" target="_blank">Export CSV</a>
        <a id="report-html" class="icon-btn" style="text-decoration:none;margin-left:4px" href="/api/report.html?days=14" target="_blank">Printable</a></span>
      </div>
      <div id="metrics-body"><div class="empty" style="padding:8px 0">Loading...</div></div>
    </div>
    <div class="stats-panel" id="clusters-panel">
      <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:4px">Possible outbreaks (cases that look related)</div>
      <div id="clusters-body"><div class="empty" style="padding:8px 0">Loading...</div></div>
    </div>
    <div class="stats-panel" id="geo-panel">
      <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:4px">Hotspots by area</div>
      <div id="geo-body"><div class="empty" style="padding:8px 0">Loading...</div></div>
    </div>
    <div class="stats-panel" id="map-panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;flex-wrap:wrap;gap:6px">
        <div style="font-size:12px;font-weight:700;color:var(--muted)">Case map</div>
        <div class="map-filters">
          <select id="map-species"><option value="">all species</option></select>
          <select id="map-type"><option value="">all types</option></select>
          <select id="map-status"><option value="">all stages</option></select>
          <select id="map-days"><option value="0">all time</option><option value="90">last 90 days</option><option value="30">last 30 days</option><option value="7">last 7 days</option></select>
          <button class="icon-btn" id="map-coverage-btn" title="Toggle operator working-area coverage overlay">Coverage</button>
          <button class="icon-btn" id="map-clusters-btn" title="Toggle outbreak-cluster links">Outbreak links</button>
          <button class="icon-btn" id="map-workers-btn" title="Toggle field-worker live location check-ins (for direction/dispatch)">Field workers</button>
        </div>
      </div>
      <div class="map-legend" id="map-legend"></div>
      <div class="map-wrap" id="map-canvas"><div class="empty" style="padding:8px 0">Loading...</div></div>
      <div id="map-unresolved" style="font-size:11px;color:var(--muted);margin-top:6px"></div>
      <div id="map-unresolved-list" style="font-size:12px;margin-top:4px"></div>
    </div>
    <div class="stats-panel" id="activity-panel">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
        <div style="font-size:12px;font-weight:700;color:var(--muted)">Activity (newest first)</div>
        <select id="act-kind"><option value="">All kinds</option><option value="inbound">Inbound</option><option value="outbound">Outbound</option><option value="transition">Stage change</option><option value="note">Note</option><option value="observation">Observation</option><option value="action">Action</option></select>
        <select id="act-actor"><option value="">Anyone</option><option value="agent">casey</option><option value="operator">Operator</option><option value="contact">Contact</option><option value="system">System</option></select>
      </div>
      <div id="activity-body"><div class="empty" style="padding:8px 0">Loading...</div></div>
    </div>
    <div class="stats-panel" id="handover-panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <div style="font-size:12px;font-weight:700;color:var(--muted)">Shift handover</div>
        <span><button id="start-shift-btn" class="icon-btn" title="Mark the start of your shift -- 'what changed' is measured from now">Start my shift</button>
        <a id="handover-print" class="icon-btn" style="text-decoration:none;margin-left:4px" href="/api/handover?format=html" target="_blank">Printable</a></span>
      </div>
      <div id="handover-body"><div class="empty" style="padding:8px 0">Loading...</div></div>
    </div>
    <div class="stats-panel" id="offline-panel">
      <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:4px">Came in while casey was offline (waiting for a person)</div>
      <div id="offline-body"><div class="empty" style="padding:8px 0">Loading...</div></div>
    </div>
    <div class="stats-panel" id="team-panel">
      <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:4px">Who is holding what (worst first)</div>
      <div id="team-body"><div class="empty" style="padding:8px 0">Loading...</div></div>
    </div>
    <div class="stats-panel" id="contacts-panel">
      <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:4px">Everyone who has reported -- promote a field worker to give them agentic case access and let them check in with their location</div>
      <div id="contacts-body"><div class="empty" style="padding:8px 0">Loading...</div></div>
    </div>
    <div class="triage" id="triage"></div>
    <div class="bulk-bar" id="bulk-bar" style="display:none">
      <label class="bulk-all"><input type="checkbox" id="bulk-all"> <span id="bulk-count">0 selected</span></label>
      <button class="icon-btn" id="bulk-claim">Claim</button>
      <select id="bulk-stage" title="Move selected to a stage"><option value="">Move to...</option></select>
      <button class="icon-btn" id="bulk-tag">Tag</button>
      <button class="icon-btn" id="bulk-untag">Untag</button>
      <button class="icon-btn" id="bulk-note">Note</button>
      <button class="icon-btn" id="bulk-draft-approve" title="Send each selected case's pending draft as composed">Send drafts</button>
      <button class="icon-btn" id="bulk-draft-discard" title="Discard each selected case's pending draft">Discard drafts</button>
      <button class="icon-btn" id="bulk-clear" title="Clear selection">Clear</button>
    </div>
    <div class="caselist" id="cases"><div class="empty">Loading cases...</div></div>
  </div>
  <div class="detail" id="detail"><p class="empty">Select a case to observe, edit, reply, or override its workflow stage.</p></div>
</div>
<div class="intake-ovl" id="intake-ovl" role="dialog" aria-modal="true" aria-labelledby="intake-title">
  <div class="intake-card">
    <h2 id="intake-title">New case</h2>
    <div id="intake-step-bar" class="intake-step-bar" style="display:none">
      <div id="step-dot-1" class="step-dot active">1</div>
      <div id="step-line-1" class="step-line"></div>
      <div id="step-dot-2" class="step-dot">2</div>
      <div id="step-line-2" class="step-line"></div>
      <div id="step-dot-3" class="step-dot">3</div>
      <span id="intake-step-label" style="margin-left:4px">Step 1 of 3: Contact details</span>
    </div>
    <div id="intake-fill-bar" class="fill-bar" style="display:none">
      <span id="intake-fill-label"></span>
      <div class="bar"><div class="fill" id="intake-fill-pct" style="width:0%"></div></div>
    </div>
    <div id="intake-contact-fields">
      <label>Contact name (optional)</label><input id="int-name" placeholder="e.g. Johannes">
      <label>Contact phone (optional)</label><input id="int-phone" placeholder="+27 82 123 4567">
      <label>Subject (what is the report about?)</label><input id="int-subject" placeholder="e.g. Sick cattle near Musina">
    </div>
    <div id="intake-report-fields"></div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button id="intake-next" style="display:none">Next</button>
      <button id="intake-submit">Save</button>
      <button id="intake-back" style="display:none;background:transparent;color:var(--muted);border:1px solid var(--border)">Back</button>
      <button id="intake-cancel" style="background:transparent;color:var(--muted);border:1px solid var(--border)">Cancel</button>
    </div>
    <p class="hint" id="intake-error" style="color:var(--danger);display:none"></p>
  </div>
</div>
<div class="help-ovl" id="help-ovl">
  <div class="help-card">
    <h2>Welcome to casey</h2>
    <p class="lead">casey watches your messages on WhatsApp and Discord and helps you answer them. Here is what this screen shows you, in plain words.</p>
    <h3>What is each row?</h3>
    <p>Each row on the left is one person who messaged you, and the whole story of what they need. Click a row to open it.</p>
    <h3>What is the yellow dot?</h3>
    <p><span class="swatch"></span> A yellow dot means this one is waiting for a person. casey will not answer it on its own. Open it, read it, and reply.</p>
    <h3>The buttons when you open one</h3>
    <ul>
      <li><b>How urgent</b> - mark how important it is, so you know what to do first.</li>
      <li><b>Who answers</b> - choose who replies to the person: casey on its own, casey writes a draft for you to send, or only you (casey just listens).</li>
      <li><b>Reply to contact</b> - type a message and send it to the person yourself.</li>
      <li><b>Change the stage</b> - move it along by hand, like marking it Done. The person is not told.</li>
    </ul>
    <h3>How do I answer someone?</h3>
    <p>Open the row. Scroll to <b>Reply to contact</b>, type your message, and press <b>Send reply</b>. The person gets it on WhatsApp or Discord.</p>
    <p class="hint">Tip: the <b>Aa</b> button at the top turns on plain-language labels everywhere.</p>
    <h3>Keyboard shortcuts (for fast triage)</h3>
    <ul class="keys">
      <li><b>j</b> / <b>k</b> - move down / up the list</li>
      <li><b>o</b> or <b>Enter</b> - open the highlighted case</li>
      <li><b>c</b> - claim the open case as yours</li>
      <li><b>e</b> - jump to the reply box</li>
      <li><b>/</b> - search &nbsp; <b>n</b> - new case &nbsp; <b>Esc</b> - back / close</li>
      <li><b>?</b> - show this help</li>
    </ul>
    <button id="onboard-again">Show me the quick start again</button>
    <button id="help-close">Got it</button>
    <p class="foot">You can open this help again any time with the <b>?</b> button at the top.</p>
  </div>
</div>
<div class="help-ovl" id="onboard-ovl">
  <div class="help-card">
    <h2>Quick start - three things</h2>
    <p class="lead">A new shift starts here. These three steps are all you need to begin.</p>
    <ol>
      <li><b>Pick who you are.</b> Use the name box at the top right so every reply and claim is recorded against you.</li>
      <li><b>The "Needs you now" list is your queue.</b> It puts the cases that cannot wait at the top. Work it from the top down.</li>
      <li><b>Claim a case before you reply.</b> Claiming tells the rest of the team you have it, so two people do not answer the same person.</li>
    </ol>
    <button id="onboard-close">Start working</button>
    <p class="foot">You can see this again from the <b>?</b> help, under "Show me the quick start again".</p>
  </div>
</div>
<div class="help-ovl" id="skills-ovl">
  <div class="help-card">
    <h2>Getting the hang of it</h2>
    <p class="lead">A short checklist of the three moves that make a shift fast. Tick each one as you learn it -- this is just for you, kept on this device, and it will not nag you again once you finish or close it.</p>
    <ul id="skills-list" class="skills-list"></ul>
    <button id="skills-close">Close</button>
    <p class="foot">Reopen this any time from the <b>?</b> help.</p>
  </div>
</div>
<div id="toasts"></div>
<script type="module">
const $ = (s,r=document)=>r.querySelector(s)
// Escape contact-supplied content before it enters innerHTML. Every value that
// originates from a message (subject/summary/tags/external_id/event text) is
// attacker-controlled, so it is escaped here, not trusted. Every render path
// below -- list, search results, timeline, deep-link restore -- goes through esc.
const esc = (s)=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
// --- handoff notification: a contact asked for a human (needs-human tag) ---
// Fires ONCE per case (tracked in handoffSeen, persisted to localStorage so a
// reload does not re-nag). Pure client-side off the existing 5s poll: the tag is
// set server-side in gateway-hooks (intent==='human').
const hasHandoff = (c)=>String(c.tags||'').split(',').map(s=>s.trim()).includes('needs-human')
let handoffSeen = (()=>{ try{ return new Set(JSON.parse(localStorage.casey_handoff_seen||'[]')) }catch{ return new Set() } })()
function rememberHandoff(id){ handoffSeen.add(id); try{ localStorage.casey_handoff_seen=JSON.stringify([...handoffSeen].slice(-500)) }catch{} }
let handoffQueue = []                         // cases needing a human, freshest last
const baseTitle = document.title              // one source of truth
let titleFlip = false, titleTimer = null
// Steady-state title carries the inbox count so an operator sees it in the tab
// even when no handoff flash is running. flashTitle falls back to this (not the
// bare baseTitle) so the count and the flash do not race-erase each other.
let inboxCount = 0
function countTitle(){ return inboxCount>0 ? '('+inboxCount+') '+baseTitle : baseTitle }
function setInboxBadge(n){
  inboxCount = n||0
  if(!titleTimer) document.title = countTitle()   // flash owns the title while active
  try{ if(navigator.setAppBadge){ inboxCount>0 ? navigator.setAppBadge(inboxCount) : navigator.clearAppBadge() } }catch{}
}
function flashTitle(on){
  if(on){ if(titleTimer) return
    titleTimer=setInterval(()=>{ titleFlip=!titleFlip
      document.title = titleFlip ? (handoffQueue.length+' waiting for you') : countTitle() }, 1100) }
  else { clearInterval(titleTimer); titleTimer=null; document.title=countTitle() }
}
// Two-tone chime via WebAudio so there is no asset/dependency. try/catch because
// browsers block audio until the operator interacts; that silent failure must
// never break the visual alert.
function handoffSound(){
  try{
    const Ctx=window.AudioContext||window.webkitAudioContext; if(!Ctx) return
    const ac=new Ctx(); const t=ac.currentTime
    ;[ [880,t,t+0.16], [1320,t+0.18,t+0.42] ].forEach(([f,s,e])=>{
      const o=ac.createOscillator(), g=ac.createGain()
      o.type='sine'; o.frequency.value=f
      g.gain.setValueAtTime(0.0001,s); g.gain.exponentialRampToValueAtTime(0.2,s+0.02)
      g.gain.exponentialRampToValueAtTime(0.0001,e)
      o.connect(g); g.connect(ac.destination); o.start(s); o.stop(e+0.02)
    })
    setTimeout(()=>{ try{ac.close()}catch{} }, 700)
  }catch{}
}
function renderHandoff(){
  const el=$('#handoff'); if(!el) return
  if(!handoffQueue.length){ el.classList.remove('show'); flashTitle(false); return }
  const c=handoffQueue[handoffQueue.length-1]
  const extra=handoffQueue.length>1 ? (' (and '+(handoffQueue.length-1)+' more)') : ''
  $('#handoff-msg').innerHTML='<b>Someone needs a person.</b> '+esc(c.ref)
    +' - '+esc(c.subject||c.external_id||c.channel)+esc(extra)+'. Click to open it.'
  el.classList.add('show'); flashTitle(true)
}
// Called from loadCases with the freshly polled cases.
function checkHandoffs(cases){
  for(const c of cases){
    if(!hasHandoff(c)) continue
    if(handoffSeen.has(c.id)) continue        // already alerted this case once
    rememberHandoff(c.id)
    if(handoffQueue.some(q=>q.id===c.id)) continue
    handoffQueue.push(c)
    if(!firstLoad){ handoffSound() }          // no chime for the backlog on first paint
  }
  // refresh subject text and drop resolved/closed handoffs
  handoffQueue = handoffQueue
    .map(q=>cases.find(c=>c.id===q.id)||q)
    .filter(q=>q.status!=='resolved' && q.status!=='closed')
  renderHandoff()
}
function clearHandoff(id){ handoffQueue=handoffQueue.filter(q=>q.id!==id); renderHandoff() }
// --- plain-language / simple mode ---
// Maps the workflow's technical stage names to friendly labels for low-literacy
// operators. simple mode is a view-only relabel: the real status value still
// flows through the API unchanged, so transitions/filters keep working. Reuse
// esc() on every label before it hits innerHTML, same as raw stage names.
let simple = false
const STAGE_LABEL = { new:'New', triaging:'Looking into it', in_progress:'Working on it',
  waiting:'Waiting', resolved:'Done', closed:'Closed' }
// stageLabel(s): friendly label in simple mode, raw stage name otherwise. A
// stage with no entry in STAGE_LABEL (e.g. a deployment-added workflow stage
// not in the shipped default set) degrades to its raw config name -- never
// hidden, just unlabeled.
function stageLabel(s){ return simple ? (STAGE_LABEL[s] || s) : s }
// Live workflow config, fetched once at boot from /api/config (see
// dashboard/server.js). Falls back to the shipped 6-stage default if the
// fetch fails (offline-first render) so the UI is never blank while waiting.
// This is what makes the bulk-move stage list and the "contact was notified"
// set track a deployment's actual thatcher.config.yml stages instead of a
// hardcoded literal that silently excludes an added/renamed stage.
let CASEY_STAGES = ['new','triaging','in_progress','waiting','resolved','closed']
let CASEY_NOTIFIED_STAGES = ['in_progress','waiting','resolved']
// case_type/priority enums are config-declared (thatcher.config.yml). The editor
// selects render from these live values (loaded from /api/config below), never a
// hardcoded literal -- so a deployment that adds a case_type/priority value gets
// it in the dropdown with no client change, matching the server-side accept set.
// The literals here are only the pre-load / no-config fallback.
let CASEY_CASE_TYPES = ['unset','outbreak','follow_up','lab_sample','import_alert']
let CASEY_PRIORITIES = ['low','normal','high','urgent']
// Locale defaults (South Africa) -- overridden from /api/config when the
// deployment sets CASEY_TZ/CASEY_TZ_LABEL/CASEY_COUNTRY_CODE server-side, so
// the SPA's own fmtTime/fmtPhone below track the same knobs as format.js
// instead of a second hardcoded 'Africa/Johannesburg'/'27'.
let CASEY_TZ = 'Africa/Johannesburg'
let CASEY_TZ_LABEL = 'SAST'
let CASEY_COUNTRY_CODE = '27'
async function loadCaseyConfig(){
  try{
    const r = await api('/api/config')
    if(!r.ok) return
    const j = await r.json()
    if(Array.isArray(j.stages) && j.stages.length) CASEY_STAGES = j.stages
    if(Array.isArray(j.case_type) && j.case_type.length) CASEY_CASE_TYPES = j.case_type
    if(Array.isArray(j.priority) && j.priority.length) CASEY_PRIORITIES = j.priority
    // Notified-on-move stays a UI convention (which moves are "worth telling the
    // contact about"), not itself config-declared -- keep the current default
    // set but intersected with the live stages so a removed/renamed stage name
    // can never linger in it.
    CASEY_NOTIFIED_STAGES = CASEY_NOTIFIED_STAGES.filter(s => CASEY_STAGES.includes(s))
    if(j.tz) CASEY_TZ = j.tz
    CASEY_TZ_LABEL = j.tz_label || ''
    if(j.country_code) CASEY_COUNTRY_CODE = j.country_code
  }catch{}
}
loadCaseyConfig()
// Auth is a session cookie now (HttpOnly, set by POST /api/login -- see
// dashboard/auth.js), not a bearer token in the URL/header. credentials:
// 'include' makes every fetch send it explicitly regardless of browser
// same-origin cookie defaults. currentUser is populated by checkSession()
// below and read by the login-gate at the bottom of this script.
let currentUser = null
const api = (url,opts={})=> fetch(url, Object.assign({ credentials: 'include' }, opts))
async function checkSession(){
  try{
    const r = await api('/api/whoami')
    const j = await r.json()
    currentUser = j.authed ? j : null
  }catch{ currentUser = null }
  return currentUser
}
async function doLogin(username, password){
  const r = await api('/api/login', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ username, password }) })
  if(!r.ok){ const j = await r.json().catch(()=>({})); throw new Error(j.error || 'login failed') }
  return checkSession()
}
async function doLogout(){
  try{ await api('/api/logout', { method:'POST' }) }catch{}
  currentUser = null
  location.reload()
}
// session-auth-hardening-revocation: self-service "log out everywhere" --
// revokes every OTHER outstanding session for the caller's own account (a
// lost/stolen device, a leaked cookie) via a session_epoch bump server-side,
// then reloads since the server already re-issued this tab's own cookie at
// the new epoch (see POST /api/logout-everywhere).
async function doLogoutEverywhere(){
  try{
    const r = await api('/api/logout-everywhere', { method:'POST' })
    if(!r.ok){ const j = await r.json().catch(()=>({})); throw new Error(j.error||'failed') }
  }catch(e){ toast('Could not log out other sessions: '+e.message, 'err'); return }
  toast('Logged out everywhere else. This device stays signed in.')
}
// Back-compat shim: every "who am I" check below (claim/mine/skills-key/owner-
// chip highlighting) was written against a self-picked selectedOperator
// variable from the old cooperative-attribution picker. It is now simply
// derived from the real logged-in session -- same read shape everywhere else
// in this script, zero call sites needed to change.
Object.defineProperty(window, 'selectedOperator', { get: () => currentUser ? currentUser.username : '' })
// --- toasts (replace alert): ok auto-dismisses, err persists until clicked ---
function toast(msg,kind='ok'){
  const el=document.createElement('div'); el.className='toast '+kind; el.textContent=msg
  el.onclick=()=>el.remove(); $('#toasts').appendChild(el)
  if(kind!=='err') setTimeout(()=>el.remove(),3500)
  return el
}
async function failMsg(r,fallback){ try{return (await r.json()).error||fallback}catch{return fallback} }
// ~15s actionable Undo toast after a reversible operator action (transition /
// claim / snooze). The server picks the most-recent undoable action itself, so the
// client only needs to POST /undo within the window; we do NOT track which action.
// A sent reply is NOT reversible -- replyUndoToast handles that separately.
function undoToast(id,label){
  const el=document.createElement('div'); el.className='toast ok undo-toast'
  const span=document.createElement('span'); span.textContent=label||'Done.'
  const btn=document.createElement('button'); btn.className='undo-btn'; btn.textContent='Undo'
  el.appendChild(span); el.appendChild(btn)
  $('#toasts').appendChild(el)
  let done=false
  const dismiss=()=>{ if(!el.parentNode) return; el.remove() }
  btn.onclick=async()=>{
    if(done) return; done=true; btn.disabled=true
    try{
      const r=await api('/api/cases/'+encodeURIComponent(id)+'/undo',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
      if(r.ok){ const j=await r.json().catch(()=>({})); toast(j.summary?('Undone -- '+j.summary):'Undone','ok'); lastCasesJson=''; await loadCases(); if(activeId===id) await openCase(id); refreshAttention() }
      else toast(await failMsg(r,'Nothing to undo (the window may have passed)'),'err')
    }catch(e){ toast('Undo error: '+e.message,'err') }
    dismiss()
  }
  setTimeout(dismiss,15000)
  return el
}
// A sent reply cannot be unsent (the contact already saw it). 'Undo' degrades to
// queuing a 'disregard my last message' correction and re-flagging needs-human so a
// person revisits it -- never a silent rewrite of what the contact received.
function replyUndoToast(id,channel){
  const el=document.createElement('div'); el.className='toast ok undo-toast'
  const span=document.createElement('span'); span.textContent='Reply sent.'
  const btn=document.createElement('button'); btn.className='undo-btn'; btn.textContent='Take it back'
  el.appendChild(span); el.appendChild(btn)
  $('#toasts').appendChild(el)
  let done=false
  btn.onclick=async()=>{
    if(done) return; done=true; btn.disabled=true
    const correction='Sorry, please disregard my last message.'
    try{
      const r=await api('/api/cases/'+encodeURIComponent(id)+'/reply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:correction})})
      if(r.ok){ await api('/api/cases/bulk',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:[id],action:'tag',tag:'needs-human'})}).catch(()=>{}); toast('Sent a correction and flagged this for a person -- a reply cannot be unsent.','ok'); lastCasesJson=''; await loadCases(); if(activeId===id) await openCase(id) }
      else toast(await failMsg(r,'Could not send the correction'),'err')
    }catch(e){ toast('Correction error: '+e.message,'err') }
    el.remove()
  }
  setTimeout(()=>el.remove(),15000)
  return el
}
// --- relative time, absolute on hover ---
function toDate(v){ if(v==null||v==='')return null
  const d=(typeof v==='number'||/^\\d+$/.test(String(v)))?new Date(Number(v)*1000):new Date(v); return isNaN(d)?null:d }
// Assisted-mode held draft surfacing. A case is holding a draft only while it
// carries the draft-pending tag; the text is the latest kind:'draft' event.
function caseHasDraft(c){ return String(c&&c.tags||'').split(',').map(t=>t.trim()).includes('draft-pending') }
function latestDraft(events){ const d=(events||[]).filter(e=>e.kind==='draft'); return d.length?d[d.length-1]:null }
function draftText(c,events){ if(!caseHasDraft(c))return ''; const d=latestDraft(events); return d&&d.text||'' }
function draftBanner(c,events){
  if(!caseHasDraft(c)) return ''
  return '<div class="draft-banner" id="draft-banner">'
    +'<div class="draft-lab">AI drafted a reply -- review before it sends.</div>'
    +'<div class="draft-acts"><button id="draft-approve" class="draft-ok">Approve &amp; send</button>'
    +'<button id="draft-discard" class="draft-no">Discard</button></div></div>'
}
function rel(v){ const d=toDate(v); if(!d)return ''
  const s=Math.round((Date.now()-d.getTime())/1000)
  if(s<45)return 'just now'; if(s<90)return '1m ago'
  const m=Math.round(s/60); if(m<45)return m+'m ago'
  const h=Math.round(m/60); if(h<36)return h+'h ago'
  return Math.round(h/24)+'d ago' }
// Elapsed duration from a since_ms span -> 'Xh Ym' / 'Xm' / 'Xd Yh', for the
// inbox waiting timer. Distinct from rel() (which is "time ago" off a timestamp).
function waitFmt(ms){ const s=Math.max(0,Math.round(ms/1000)); const m=Math.floor(s/60)
  if(m<60) return m+'m'
  const h=Math.floor(m/60), rm=m%60; if(h<24) return rm? h+'h '+rm+'m' : h+'h'
  const d=Math.floor(h/24), rh=h%24; return rh? d+'d '+rh+'h' : d+'d' }
// Absolute time is shown in the deployment's configured timezone (South
// African Standard Time, UTC+2, no DST, by default) so an operator anywhere
// reads the same local time the field team works in, regardless of the
// browser's own timezone. CASEY_TZ/CASEY_TZ_LABEL (loaded from /api/config,
// see loadCaseyConfig above) override the zone/suffix for a non-SA deployment.
function fmtTime(v){ const d=toDate(v); if(!d)return ''
  const suffix = CASEY_TZ_LABEL ? ' '+CASEY_TZ_LABEL : ''
  try{ return d.toLocaleString('en-ZA',{timeZone:CASEY_TZ})+suffix }
  catch{ return d.toLocaleString()+suffix } }

// Show a phone number the way an operator expects: a WhatsApp MSISDN like
// 27821234567 becomes +27 82 123 4567; a local 0821234567 stays 082 123 4567.
// Non-phone external_ids (discord/sim ids) pass through unchanged. Display only --
// the raw external_id stays the key. CASEY_COUNTRY_CODE (default '27', South
// Africa) overrides the country prefix matched/shown for a non-SA deployment.
function fmtPhone(v){ const s=String(v||''); const digits=s.replace(/[^0-9]/g,'')
  const cc=CASEY_COUNTRY_CODE
  if(new RegExp('^'+cc+'[0-9]{9}$').test(digits)){ const n=digits.slice(cc.length); return '+'+cc+' '+n.slice(0,2)+' '+n.slice(2,5)+' '+n.slice(5) }
  if(/^0[0-9]{9}$/.test(digits)){ return digits.slice(0,3)+' '+digits.slice(3,6)+' '+digits.slice(6) }
  return s }

// Plain-language labels for the structured report fields, in the order an
// organiser most wants to read them. Missing fields are shown as "not given yet"
// so the operator sees the WHOLE picture (what is known and what is still
// outstanding), never a silently blank gap.
const REPORT_FIELDS=[
  ['species','Animals'],['symptoms','Signs'],['affected_count','How many affected'],
  ['dead_count','How many died'],['onset','When it started'],['suspected_disease','Suspected disease'],
  ['recent_movement','Recent movement'],['location','Where'],['how_to_find','How to find the place'],
  ['access_notes','Access / travel'],['farmer_available','Farmer available?'],
  ['contact_fallback','Other contact'],['identifying_traits','Identifying the animals'],
  ['photos','Photos'],['audio','Voice notes'],['notes','Other notes'],
  ['present_person','Who is with the animals'],['present_person_relation','Their link to the owner'],
  ['owner_name','Owner name'],['owner_contact','Owner contact'],
  ['language_detected','Language detected'],['sites','Other sites in this visit'],
]
// Fields a field visit genuinely needs that CANNOT be recovered once the worker
// leaves the site -- this is the one-shot reality. The readiness line tells the
// operator at a glance whether they can act on the report or should try to reach
// the farmer NOW (while perhaps still reachable) for the missing on-site facts.
const VISIT_CRITICAL=[
  ['species','what animals'],['symptoms','the signs'],['location','where'],
  ['how_to_find','how to find the place'],['farmer_available','if the farmer will be there'],
  ['contact_fallback','another contact'],
]
const has=(r,k)=>r[k]!=null&&String(r[k]).trim()!==''
// Derive per-field source labels from the action event log.
// Events with actor=agent and text containing 'recorded report fields' carry
// the field names that came from the AI conversation. Events with actor=operator
// carry fields set via the manual intake form. Returns a map of key -> 'ai'|'manual'|'both'.
function fieldSources(events){
  const src={}
  for(const e of (events||[])){
    if(e.kind!=='action') continue
    const isAgent=e.actor==='agent'
    const isOp=e.actor==='operator'
    if(!isAgent&&!isOp) continue
    // The action event text lists fields like "recorded report fields: species, symptoms"
    // or "updated report fields: location"
    const m=(e.text||'').match(/(?:recorded|updated) report fields?(?:[^:]*)?:[ ]*(.+)/i)
    if(!m) continue
    const keys=m[1].split(',').map(s=>s.trim()).filter(Boolean)
    for(const k of keys){
      if(isAgent) src[k]=src[k]==='manual'?'both':'ai'
      else src[k]=src[k]==='ai'?'both':'manual'
    }
  }
  return src
}
function sourceTag(s){
  if(!s) return ''
  if(s==='ai') return ' <span class="src-tag src-ai">[AI]</span>'
  if(s==='manual') return ' <span class="src-tag src-manual">[Manual]</span>'
  if(s==='both') return ' <span class="src-tag src-both">[Both]</span>'
  return ''
}
function fillPill(rfr){
  if(!rfr) return ''
  const cls = rfr.filled===rfr.total_fields?'ok':(rfr.visit_critical_filled<rfr.visit_critical_total?'low':'')
  return \`<span class="fill-pill \${cls}" title="Essential fields: \${rfr.visit_critical_filled} of \${rfr.visit_critical_total}">\${rfr.filled}/\${rfr.total_fields} fields\${rfr.visit_critical_filled<rfr.visit_critical_total?' ('+rfr.visit_critical_filled+'/'+rfr.visit_critical_total+' essential)':''}</span>\`
}
// Build map of field -> [{text, created_at}] from note events with a field key
function fieldNotes(events){
  const notes={}
  for(const e of (events||[])){
    if(e.kind!=='note'||!e.data?.field) continue
    if(!notes[e.data.field]) notes[e.data.field]=[]
    notes[e.data.field].push({text:e.text,created_at:e.created_at})
  }
  return notes
}
function reportPanel(reportRaw, events){
  let r={}; try{ r=reportRaw?JSON.parse(reportRaw):{} }catch{ r={} }
  const src=fieldSources(events)
  const fnotes=fieldNotes(events)
  // If nothing has been gathered yet, a calm empty state -- not an empty box.
  const any=REPORT_FIELDS.some(([k])=>has(r,k))
  const missingVC=VISIT_CRITICAL.filter(([k])=>!has(r,k))
  const missing=missingVC.map(([,label])=>label)
  // Plain readiness line: green when a visit has what it needs, amber listing the
  // unrecoverable gaps. Clicking the amber banner opens the intake form.
  let ready=''
  if(any){
    ready = missing.length
      ? '<div class="rep-ready amber" id="vc-banner" title="Click to fill in the missing fields" style="cursor:pointer">Still missing for a visit: '+esc(missing.join(', '))+' - click to fill in</div>'
      : '<div class="rep-ready ok">Has what a field visit needs.</div>'
  }
  const rows=REPORT_FIELDS.map(([k,label])=>{
    const val=has(r,k)?esc(String(r[k]))+sourceTag(src[k]):'<span class="rep-missing">not given yet</span>'
    const noteList=(fnotes[k]||[]).map(n=>'<div class="rep-field-note">'+esc(n.text)+'</div>').join('')
    return '<div class="rep-row" data-field="'+esc(k)+'"><span class="rep-label">'+esc(label)+'</span><span class="rep-val"><span class="rep-editable" data-key="'+esc(k)+'" title="Click to edit">'+val+'</span><button class="rep-note-btn" data-key="'+esc(k)+'" title="Add a note to this field">note</button>'+noteList+'</span></div>'
  }).join('')
  // Source legend: only shown when at least one field has a src annotation
  const srcVals=Object.values(src)
  let srcLegend=''
  if(srcVals.length){
    const hasAI=srcVals.some(v=>v==='ai'||v==='both')
    const hasManual=srcVals.some(v=>v==='manual'||v==='both')
    const parts=[]
    if(hasAI) parts.push('<span class="src-tag src-ai">[AI]</span> collected by agent')
    if(hasManual) parts.push('<span class="src-tag src-manual">[Manual]</span> entered by operator')
    srcLegend='<div class="rep-src-legend">Fields from: '+parts.join('  ')+'</div>'
  }
  // Voice note banner: when report.audio is set, prompt operator to transcribe
  const audioVal=has(r,'audio')?String(r.audio).trim():''
  const audioBanner=audioVal&&audioVal.toLowerCase()!=='no'
    ?'<div class="rep-ready amber rep-audio-banner">Voice note on record: &ldquo;'+esc(audioVal)+'&rdquo; -- listen and update the fields below from what you hear.</div>'
    :''
  return '<div class="report"><div class="rep-head">Report from the field'
    +(any?'':' <span class="rep-missing">(nothing recorded yet)</span>')+'</div>'+srcLegend+ready+audioBanner+rows+'</div>'
}

let activeId = null, lastCasesJson = '', allCases = [], known = new Set()
let editing = false                         // pause polling while operator types
let connDown = false, firstLoad = true
const filt = { q:'', status:'' }

function attn(c){ return c.autonomy==='observe' || c.autonomy==='assisted'
  || String(c.tags||'').split(',').map(s=>s.trim()).includes('needs-human') }
// --- triage: which cases need a HUMAN now, and why, in plain words ---
// Scoring + reason live server-side in src/attn.js and reach the client ranked
// via GET /api/attention (over ALL open cases, not just the page window). The SPA
// no longer recomputes them -- renderTriage renders the server-ranked list, so the
// two surfaces cannot drift.
function tagList(c){ return String(c.tags||'').split(',').map(t=>t.trim()).filter(Boolean) }
// Light heuristic: does the contact's most recent inbound look like it is NOT
// plain English? We only flag the operator to mirror the contact's language --
// the agent already replies in-language; this is a nudge for HUMAN replies, where
// a low-literacy operator might default to English. Non-latin script or a few
// common non-English words trip it. False negatives are fine; this never blocks.
const NON_EN_WORDS = /\\b(dankie|asseblief|hallo|goeie|siek|beeste|ngiyabonga|siyabonga|sawubona|izinkomo|usizo|enkosi|molo|nceda|iinkomo|dumela|kea leboha|dikgomo)\\b/i
function contactMaybeNonEnglish(events){
  const lastIn = (events||[]).filter(e=>e.kind==='inbound').slice(-1)[0]
  const txt = lastIn && lastIn.text
  if(!txt) return false
  // Non-ASCII character (accented/non-latin script) or a common non-English word.
  for(let i=0;i<txt.length;i++){ if(txt.charCodeAt(i)>127) return true }
  return NON_EN_WORDS.test(txt)
}
function matches(c){
  if(filt.status && c.status!==filt.status) return false
  if(!filt.q) return true
  const hay=(c.ref+' '+(c.subject||'')+' '+(c.summary||'')+' '+(c.external_id||'')+' '+c.channel).toLowerCase()
  return hay.includes(filt.q.toLowerCase())
}
function renderCounts(){
  const by={}; for(const c of allCases) by[c.status]=(by[c.status]||0)+1
  const a=allCases.filter(attn).length
  $('#counts').textContent = allCases.length+' total'+(a?' - '+a+' need attention':'')
}

// The inbox is the server-ranked /api/attention list (scored over ALL open cases
// in src/attn.js), NOT a client recompute over the page window -- so a high-urgency
// case beyond the 200-row loadCases cap still shows. Each entry carries its own
// ref/channel/subject/updated_at/reason/breaches; renderTriage never reaches into
// allCases for triage, so the two surfaces cannot drift.
let attentionInbox = []
// Focus / inbox mode: render ONLY the ranked attention list, skip the full
// ~200-row case poll, and quiet the background polls. Driven by the #inbox hash
// so the mode survives a reload and is deep-linkable.
let inboxMode = /(^|&)inbox(&|$)/.test((location.hash||'').replace(/^#/,''))
function renderTriage(){
  const el=$('#triage'); if(!el) return
  // In focus mode the attention list is the whole screen, so show every ranked
  // case; otherwise keep the compact 12-row peek above the full list.
  const ranked = mineOnly ? attentionInbox.filter(isMine) : attentionInbox
  const inbox = inboxMode ? ranked : ranked.slice(0,12)
  setInboxBadge(ranked.length)
  if(!inbox.length){
    el.innerHTML='<h2>Needs you now</h2>'+
      '<div class="calm">All caught up. Nothing needs a person right now. '+
      'A new one will show up here the moment someone needs you.</div>'
    return
  }
  el.innerHTML='<h2>Needs you now <span class="n">'+attentionInbox.length+'</span></h2>'+
    inbox.map(e=>{
      const breaches = e.breaches||[]
      const breachDetail = breaches.length ? ' -- '+breaches.map(b=>b.detail||b.breach).join('; ') : ''
      const heat = e.score>=8 ? 'heat-3' : e.score>=4 ? 'heat-2' : e.score>0 ? 'heat-1' : ''
      const ho = breaches.find(b=>b.breach==='unanswered_handoff'||b.breach==='unanswered_handoff_escalated')
      const waiting = ho && ho.since_ms ? '<span class="waiting">waiting '+waitFmt(ho.since_ms)+'</span>' : ''
      const owner = e.assignee && e.assignee!=='agent' ? e.assignee : ''
      const mine = owner && owner===selectedOperator
      const ownerChip = owner ? '<span class="owner-chip'+(mine?' mine':'')+'">'+(mine?'you':esc(owner))+'</span>' : ''
      const otherClaim = owner && !mine ? ' claimed-other' : ''
      return \`
      <div class="tcase \${heat}\${otherClaim} \${e.id===activeId?'active':''}" data-id="\${esc(e.id)}">
        <div class="why">\${esc(e.reason||'This one is worth a look.')}\${waiting}\${ownerChip}\${breachDetail?'<span class="breach-detail"> '+esc(breachDetail)+'</span>':''}</div>
        <div class="meta">\${esc(e.ref)} - \${esc(e.channel)} - \${esc(e.subject||'(no subject)')} - \${esc(rel(e.updated_at))}</div>
      </div>\`
    }).join('')
  el.querySelectorAll('.tcase').forEach(d=>d.onclick=()=>openCase(d.dataset.id))
}
async function refreshAttention(){
  try{
    const j = await api('/api/attention').then(r=>r.ok?r.json():null)
    if(!j) return
    attentionInbox = j.cases||[]
    renderTriage()
  }catch{ /* best-effort; a stale inbox is better than a blank one */ }
}
function fillStatusFilter(){
  const cur=$('#statusf').value
  const stages=[...new Set(allCases.map(c=>c.status))].sort()
  const allLabel = simple ? 'all stages (everything)' : 'all stages'
  $('#statusf').innerHTML='<option value="">'+esc(allLabel)+'</option>'+stages.map(s=>\`<option value="\${esc(s)}"\${s===cur?' selected':''}>\${esc(stageLabel(s))}</option>\`).join('')
}
function setConn(down){
  if(down===connDown) return; connDown=down; $('#conn').classList.toggle('show',down)
}
async function loadCases(){
  if(editing) return                        // never clobber an in-progress edit
  let resp
  try{
    const params=new URLSearchParams({limit:'200'})
    if(filt.status) params.set('status',filt.status)
    if(filt.channel) params.set('channel',filt.channel)
    if(filt.q) params.set('q',filt.q)
    resp = await api('/api/cases?'+params.toString()).then(r=>{ if(!r.ok) throw new Error(r.status); return r.json() })
  }
  catch(e){ setConn(true); return }
  setConn(false)
  const cases = resp.cases || []
  const capEl=document.getElementById('cap-warn')
  if(resp.total>cases.length){
    if(!capEl){ const w=document.createElement('div'); w.id='cap-warn'
      w.style.cssText='background:rgba(200,140,0,.18);color:#9a6a00;font-size:12px;padding:5px 14px;text-align:center;border-bottom:1px solid rgba(200,140,0,.3)'
      w.textContent='Showing '+cases.length+' of '+resp.total+' cases. Use filters to find older ones.'
      document.getElementById('cases').before(w) }
  } else if(capEl){ capEl.remove() }
  const json = JSON.stringify(cases.map(c=>[c.id,c.ref,c.priority,c.channel,c.status,c.subject,c.autonomy,c.updated_at,c.fill_rate?.filled]))
  // notice genuinely-new cases (after first load) so an idle operator sees work
  if(!firstLoad){ const fresh=cases.filter(c=>!known.has(c.id)); if(fresh.length) toast(fresh.length+' new case'+(fresh.length>1?'s':'')) }
  checkHandoffs(cases)                         // detect needs-human, alert once per case
  for(const c of cases) known.add(c.id)
  firstLoad=false
  if(json===lastCasesJson){ // counts/rel-time may still drift; cheap refresh of relative labels
    document.querySelectorAll('.case .when').forEach(()=>{}); return }
  lastCasesJson = json; allCases = cases
  fillStatusFilter(); fillChannelFilter(); renderCounts(); renderListFull(); renderTriage()
}
function opt(val,cur){ return \`<option\${val===cur?' selected':''}>\${esc(val)}</option>\` }
const AUTONOMY_HELP = 'auto = agent replies on its own - assisted = agent drafts, human sends - observe = agent only logs, never replies'
// Plain-words "what to do now" line, picked from the case state. The first
// matching rule wins so the most action-needed state shows. Derives purely from
// enum-safe c.status / c.autonomy.
// Mirrors src/attn.js caseHints().todo policy -- same priority ladder and wording
// so the detail to-do line never diverges from the server. The client cannot
// import attn.js, so the ladder is inlined. ageHoursOf is a thin local helper.
function ageHoursOf(c){ const d=toDate(c.updated_at||c.created_at); return d?(Date.now()-d.getTime())/3600000:0 }
function todoHint(c){
  const tags=tagList(c)
  if(tags.includes('opted-out')) return 'This person asked to stop. Do not message them. Leave this one alone.'
  if(c.status==='closed') return 'This one is finished. Nothing to do.'
  if(tags.includes('needs-human')) return 'This person asked for a real person. Reply to them below.'
  if(tags.includes('draft-pending')) return 'casey drafted a reply -- review it before it sends. Approve or discard it below.'
  if(tags.includes('health:unanswered_handoff_escalated')) return 'A person was asked for a long time ago and still no one has replied. Step in below.'
  if(tags.includes('health:unanswered_handoff')) return 'A person was asked for and no one has replied. Reply below to take this one on.'
  if(tags.includes('health:incomplete_critical')) return 'The visit-critical facts are still missing and the case is active. Try to reach the farmer now -- once they leave the site some facts cannot be recovered.'
  if(tags.includes('health:abandoned_intake')) return 'On-site facts are still missing and the farmer may be gone. Check if they are still reachable and ask for the most important detail (location or how to find the place).'
  if(c.status==='waiting' && ageHoursOf(c)>=24) return 'No answer for over a day. A check-in may help -- reply below.'
  if(tags.includes('health:stuck')) return 'This case has been in the same stage for a while. Check if it needs a push or can be closed.'
  if(tags.includes('health:stale')) return 'No activity for a while. Check if anything needs following up.'
  if(c.autonomy==='observe') return 'This one is waiting for you. Read it and reply, or set Who answers to auto so casey can answer.'
  if(c.autonomy==='assisted') return 'casey can draft, but you send. Open it and check the draft.'
  if(c.status==='resolved') return 'This one is marked done. Close it if you are finished.'
  if(c.status==='waiting') return 'Waiting on the person to reply. Nothing to do until they answer.'
  if(c.status==='new'||c.status==='triaging') return 'A new message came in. casey is sorting it out.'
  return 'casey is handling this one on its own. Step in only if you need to.'
}
// 2-4 canned replies for this case. Plain, warm, short. Clicking fills (never sends).
// Returns [] for opted-out contacts so the UI never nudges the operator to message them.
function cannedReplies(c){
  if(tagList(c).includes('opted-out')) return []
  const tags=tagList(c)
  if(tags.includes('needs-human'))
    return ['Hi, this is a real person now. How can I help you?',
            'I am here to help. Can you tell me a bit more?',
            'Thank you for waiting. I am looking into this for you now.']
  if(c.status==='waiting')
    return ['Just checking in - are you still there? Reply when you can.',
            'No rush. I am still here whenever you are ready.']
  return ['Thanks for your message. I am looking into this now.',
          'Got it - I will get back to you shortly.',
          'Can you tell me a little more so I can help?']
}
async function openCase(id){
  activeId = id
  clearHandoff(id)                             // dismiss banner locally; DB tag clears only on reply
  // deep-link the open case in the hash only (auth is the login session cookie,
  // so there is no secret in the URL to leak); location.search is preserved by
  // replaceState's relative URL, keeping any benign filter params intact.
  const wantHash='#case='+encodeURIComponent(id)
  if(location.hash!==wantHash) history.replaceState(null,'',location.pathname+location.search+wantHash)
  if($('#wrap')) $('#wrap').classList.add('detail-open')
  let data
  try{ data = await api('/api/cases/'+encodeURIComponent(id)).then(r=>{ if(!r.ok) throw new Error(r.status); return r.json() }) }
  catch(e){ $('#detail').innerHTML='<p class="empty">Could not load this case.</p>'; return }
  const {case:c, events, transitions, events_total, report_fill_rate:rfr, suggested_assignee:sugg} = data
  const more = events_total!=null && events.length<events_total
  $('#detail').innerHTML = \`
    <button class="icon-btn back" id="back">&lt;- cases</button>
    <h2 style="margin:6px 0 4px">\${esc(c.ref)} <span class="badge" title="\${esc(c.status)}">\${esc(stageLabel(c.status))}</span>
      \${fillPill(rfr)}
      <button class="copy" data-copy="\${esc(c.ref)}" title="copy ref">copy</button>
      <button class="copy" data-copy="\${esc(location.origin+location.pathname+'#case='+encodeURIComponent(c.id))}" title="copy direct link to this case (no token in link)" style="margin-left:4px">link</button>
      <a href="/api/cases/\${encodeURIComponent(c.id)}/report.html" target="_blank" class="icon-btn" style="margin-left:4px;text-decoration:none;display:inline-block">Print</a>
      <button id="share-form-btn" class="icon-btn" style="margin-left:4px" title="Get a link to share with the contact so they can fill in their own details">Share form</button>
      \${(c.assignee&&c.assignee!=='agent')
        ? '<span class="owner-chip'+(c.assignee===selectedOperator?' mine':'')+'" style="margin-left:4px" title="Who is handling this">'+(c.assignee===selectedOperator?'yours':esc(c.assignee))+'</span>'
        : '<button id="claim-btn" class="icon-btn" style="margin-left:4px" title="Take this case as yours (recorded against you)">Claim</button>'}
      \${snoozedUntilTag(c.tags)
        ? '<button id="snooze-btn" class="icon-btn" style="margin-left:4px" data-clear="1" title="Snoozed until '+esc(fmtTime(snoozedUntilTag(c.tags)))+' -- click to clear">Snoozed</button>'
        : '<button id="snooze-btn" class="icon-btn" style="margin-left:4px" title="Hide from the inbox for a while without losing it -- a needs-human case is never hidden">Snooze</button>'}
      \${(sugg && (!c.assignee||c.assignee==='agent')) ? '<span class="hint" style="margin-left:6px" title="Based on '+esc(sugg.name)+'\\'s past work near '+esc(sugg.matched_area)+' -- a suggestion only, never automatic">suggested: '+esc(sugg.name)+'</span>' : ''}</h2>
    <div class="todo" id="todo-hint">\${esc(todoHint(c))}</div>
    \${healthBadges(c.tags)}\${intakeModeBadge(c.tags)}
    <div style="color:var(--muted);margin-bottom:12px">\${esc(c.channel)}/\${esc(fmtPhone(c.external_id))}
      <button class="copy" data-copy="\${esc(c.external_id)}" title="copy contact">copy</button></div>
    \${reportPanel(c.report, events)}
    <button id="edit-report-btn" class="icon-btn" style="margin-bottom:14px">Edit report fields</button>
    <div class="row">
      <div><label>Priority</label><select id="f-priority">\${CASEY_PRIORITIES.map(p=>opt(p,c.priority)).join('')}</select>\${simple?'<p class="hint">How urgent this is.</p>':''}</div>
      <div><label>Autonomy</label><select id="f-autonomy" title="\${esc(AUTONOMY_HELP)}">\${['auto','assisted','observe'].map(p=>opt(p,c.autonomy)).join('')}</select>\${simple?'<p class="hint">Who answers the contact: the robot, a draft for you, or nobody.</p>':''}</div>
      <div><label>Assignee</label><input id="f-assignee" value="\${esc(c.assignee||'')}"></div>
      <div><label>Case type</label><select id="f-case-type" title="Management lens: segments every report aggregate. Changing it records a case_type a -> b audit event.">\${CASEY_CASE_TYPES.map(p=>opt(p,c.case_type||'unset')).join('')}</select>\${simple?'<p class="hint">What kind of case this is, for the team\\'s reports.</p>':''}</div>
    </div>
    <p class="hint">\${esc(AUTONOMY_HELP)}</p>
    <label>Subject</label><input id="f-subject" value="\${esc(c.subject||'')}">
    <label>Tags</label><input id="f-tags" value="\${esc(c.tags||'')}">
    <label>Summary</label><textarea id="f-summary" rows="3">\${esc(c.summary||'')}</textarea>
    <button id="save">Save edits</button>
    <div style="margin-top:14px"><label>\${simple?'Change the stage':'Override workflow stage'}</label>
      \${simple?'<p class="hint">Move this case to a new stage. For some stages the contact gets a short automatic note; for internal stages they are not told.</p>':''}
      \${transitions.map(t=>\`<button class="trans" data-to="\${esc(t)}" title="\${esc(t)}" style="background:#2a3340">-&gt; \${esc(stageLabel(t))}</button>\`).join(' ')||'<span class="hint">no transitions available</span>'}
    </div>
    \${draftBanner(c,events)}
    <div style="margin-top:14px"><label>Reply to contact on \${esc(c.channel)}</label>
      <textarea id="f-reply" rows="2" placeholder="Send a message as a human operator... (Ctrl+Enter to send)" maxlength="4096">\${esc(draftText(c,events))}</textarea>
      <div class="reply-counter" id="reply-counter">0 / 4096</div>
      \${contactMaybeNonEnglish(events)?'<p class="canned-lab" style="color:var(--danger)">This person may not be writing in English. Please reply in their language.</p>':''}
      \${cannedReplies(c).length ? \`<p class="canned-lab">Or tap a ready-made reply to start with:</p>
      <div class="canned" id="canned">\${cannedReplies(c).map((t,i)=>
        \`<button type="button" data-i="\${i}">\${esc(t)}</button>\`).join('')}</div>\` : ''}
      <button id="send-reply">Send reply</button>
    </div>
    <div id="dup-panel"></div>
    <div id="site-history-panel"></div>
    <h3 style="margin:18px 0 6px">Timeline\${events_total!=null?\` (\${events.length}/\${events_total})\`:''}
      <button id="add-case-note" class="icon-btn" style="float:right;margin-top:-2px">+ Note</button>
      <button id="split-case-btn" class="icon-btn" style="float:right;margin-top:-2px;margin-right:4px">Split</button></h3>
    <input id="timeline-search" type="search" placeholder="Search timeline..." style="width:100%;margin-bottom:8px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg2);color:var(--fg);font-size:13px">
    <div id="timeline">\${renderEvents(events)}</div>
    \${more?'<button id="more-events" style="background:#2a3340">Load older events</button>':''}
  \`
  // Possibly-the-same-case panel: load casey's grouping suggestions and offer a
  // one-click merge. Best-effort and isolated -- a suggestions failure must never
  // break the case view, so it is loaded after the main render and swallows errors.
  loadDuplicateSuggestions(id)
  // Site visit history: who else has reported at this same place (any reporter,
  // any time -- a field worker does not own a case, a different person may
  // follow up from whoever first reported it). Same best-effort/isolated
  // loading discipline as loadDuplicateSuggestions above.
  loadSiteHistory(id)
  // pause polling while any field is focused so a refresh can't wipe the edit;
  // resume on blur. A blur fallback guarantees we never get stuck paused.
  $('#detail').querySelectorAll('input,select,textarea').forEach(el=>{
    el.addEventListener('focus',()=>{editing=true})
    el.addEventListener('blur',()=>{editing=false})
  })
  const back=$('#back'); if(back) back.onclick=()=>{ $('#wrap').classList.remove('detail-open') }
  const claimBtn=$('#claim-btn')
  if(claimBtn) claimBtn.onclick=async()=>{
    if(!selectedOperator){ toast('Pick who you are first (top-right) so the claim is recorded against you.','warn'); return }
    claimBtn.disabled=true
    try{
      const r=await api('/api/cases/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[id],action:'claim'})})
      if(r.ok){ undoToast(id,'Claimed -- this one is yours now'); openCase(id); refreshAttention() }
      else{ claimBtn.disabled=false; toast('Could not claim this case','warn') }
    }catch(e){ claimBtn.disabled=false; toast('Claim error: '+e.message,'warn') }
  }
  const snoozeBtn=$('#snooze-btn')
  if(snoozeBtn) snoozeBtn.onclick=async()=>{
    if(snoozeBtn.dataset.clear){
      snoozeBtn.disabled=true
      try{
        const r=await api('/api/cases/'+encodeURIComponent(id)+'/snooze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({minutes:0})})
        if(r.ok){ toast('Snooze cleared'); openCase(id); refreshAttention() }
        else{ snoozeBtn.disabled=false; toast('Could not clear snooze','warn') }
      }catch(e){ snoozeBtn.disabled=false; toast('Snooze error: '+e.message,'warn') }
      return
    }
    const dlg=await showDialog({title:'Snooze this case',message:'Hide it from the inbox for a while without losing it. A case where someone asked for a person is never hidden, even snoozed.',inputLabel:'Minutes from now (e.g. 60 for 1 hour, 1440 for a day)',inputPlaceholder:'240',confirmLabel:'Snooze'})
    if(!dlg||!dlg.value) return
    const minutes=parseInt(dlg.value,10)
    if(!Number.isFinite(minutes)||minutes<=0){ toast('Enter a positive number of minutes','warn'); return }
    snoozeBtn.disabled=true
    try{
      const r=await api('/api/cases/'+encodeURIComponent(id)+'/snooze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({minutes})})
      if(r.ok){ toast('Snoozed'); openCase(id); refreshAttention() }
      else{ snoozeBtn.disabled=false; toast('Could not snooze this case','warn') }
    }catch(e){ snoozeBtn.disabled=false; toast('Snooze error: '+e.message,'warn') }
  }
  const shareFormBtn=$('#share-form-btn')
  if(shareFormBtn) shareFormBtn.onclick=()=>{
    const url=location.origin+'/report?ref='+encodeURIComponent(c.ref)
    showDialog({title:'Share form with contact',message:'Send this link to the contact so they can fill in the details directly: '+url,confirmLabel:'Copy link',cancelLabel:'Close'}).then(dlg=>{
      if(dlg){ try{ navigator.clipboard.writeText(url); toast('Link copied') }catch{ prompt('Copy this link:',url) } }
    })
  }
  const tlSearch=$('#timeline-search')
  if(tlSearch) tlSearch.addEventListener('input',()=>{
    const q=tlSearch.value.toLowerCase().trim()
    $('#timeline').querySelectorAll('.ev').forEach(el=>{
      el.style.display=(!q||el.textContent.toLowerCase().includes(q))?'':'none'
    })
  })
  const editRptBtn=$('#edit-report-btn')
  if(editRptBtn) editRptBtn.onclick=()=>openIntakeForm(c)
  const vcBanner=$('#vc-banner')
  if(vcBanner) vcBanner.onclick=()=>openIntakeForm(c)
  // Inline per-field editing: click a field value -> edit in place -> Enter/blur saves.
  $('#detail').querySelectorAll('.rep-editable').forEach(span=>{
    span.onclick=async()=>{
      if(span.querySelector('input')) return   // already editing
      const k=span.dataset.key
      const cur=(c.report?JSON.parse(c.report):{})[k]||''
      span.classList.add('rep-saving')
      const inp=document.createElement('input')
      inp.className='rep-field-input'; inp.value=cur
      span.innerHTML=''; span.appendChild(inp)
      inp.focus(); span.classList.remove('rep-saving')
      const save=async()=>{
        const val=inp.value
        if(val===cur){span.textContent=cur||''; return}   // no change
        if(!val.trim()&&cur){ toast('To remove a field value, use the full Edit form','ok'); span.textContent=cur||''; return }
        span.classList.add('rep-saving')
        const r=await api('/api/cases/'+encodeURIComponent(c.id)+'/intake',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({[k]:val})})
        if(!r.ok){ toast(await failMsg(r,'save failed'),'err'); span.textContent=cur||''; return }
        toast('saved','ok'); span.classList.remove('rep-saving')
        lastCasesJson=''; await loadCases(); await openCase(c.id)
      }
      inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();save()} if(e.key==='Escape'){span.textContent=cur||''} })
      inp.addEventListener('blur',save)
    }
  })
  // Per-field note buttons: prompt for a note text, save as kind=note event with field key.
  $('#detail').querySelectorAll('.rep-note-btn').forEach(btn=>{
    btn.onclick=async()=>{
      const k=btn.dataset.key
      const fieldLabel=(REPORT_FIELDS.find(([f])=>f===k)||[k,k])[1]
      const dlg=await showDialog({title:'Add a note',inputLabel:'Note for: '+fieldLabel,inputPlaceholder:'Type your note here...',confirmLabel:'Save note'})
      const text=(dlg&&dlg.value||'').trim()
      if(!text) return
      const r=await api('/api/cases/'+encodeURIComponent(c.id)+'/note',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,field:k})})
      if(!r.ok){ toast(await failMsg(r,'note failed'),'err'); return }
      toast('note saved','ok'); lastCasesJson=''; await loadCases(); await openCase(c.id)
    }
  })
  $('#detail').querySelectorAll('.copy').forEach(b=>b.onclick=()=>{
    try{ navigator.clipboard.writeText(b.dataset.copy); toast('copied') }catch{ toast('copy failed','err') } })
  $('#save').onclick = async ()=>{
    const btn=$('#save'); btn.disabled=true
    const body = {subject:$('#f-subject').value, summary:$('#f-summary').value, priority:$('#f-priority').value, tags:$('#f-tags').value, assignee:$('#f-assignee').value, autonomy:$('#f-autonomy').value}
    const ctSel=$('#f-case-type'); if(ctSel && ctSel.value!==(c.case_type||'unset')) body.case_type=ctSel.value
    const r = await api('/api/cases/'+encodeURIComponent(id),{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
    btn.disabled=false; editing=false
    if(!r.ok){ toast(await failMsg(r,'save failed'),'err'); return }
    toast('saved','ok'); lastCasesJson=''; await loadCases(); await openCase(id)
  }
  const send = async ()=>{
    const ta=$('#f-reply'), text=ta.value.trim(); if(!text) return
    const btn=$('#send-reply'); btn.disabled=true
    const r = await api('/api/cases/'+encodeURIComponent(id)+'/reply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})})
    btn.disabled=false; editing=false
    if(!r.ok){ toast(await failMsg(r,'send failed'),'err'); return }
    const j=await r.json().catch(()=>({})); ta.value=''
    if(j.delivered) replyUndoToast(id,c.channel)
    else toast(j.sent?'reply sent but it did not reach the contact - check the timeline':'reply logged (channel not connected)','ok')
    await openCase(id)
  }
  $('#send-reply').onclick = send
  $('#f-reply').addEventListener('keydown',e=>{ if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){ e.preventDefault(); send() } })
  const draftOk=$('#draft-approve')
  if(draftOk) draftOk.onclick=async()=>{
    const text=$('#f-reply').value.trim(); draftOk.disabled=true
    const r=await api('/api/cases/'+encodeURIComponent(id)+'/draft/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})})
    draftOk.disabled=false
    if(!r.ok){ toast(await failMsg(r,'approve failed'),'err'); return }
    const j=await r.json().catch(()=>({}))
    toast(j.delivered?'draft sent':'draft logged (channel not connected)','ok'); lastCasesJson=''; await loadCases(); await openCase(id)
  }
  const draftNo=$('#draft-discard')
  if(draftNo) draftNo.onclick=async()=>{
    const dlg=await showDialog({title:'Discard this draft?',message:'The drafted reply will not be sent. The case stays flagged for a human.',confirmLabel:'Discard'})
    if(!dlg) return
    const r=await api('/api/cases/'+encodeURIComponent(id)+'/draft/discard',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})})
    if(!r.ok){ toast(await failMsg(r,'discard failed'),'err'); return }
    toast('draft discarded','ok'); lastCasesJson=''; await loadCases(); await openCase(id)
  }
  const replyCounter=$('#reply-counter')
  if(replyCounter){
    const updateCounter=()=>{ const n=$('#f-reply').value.length; replyCounter.textContent=n+' / 4096'
      replyCounter.className='reply-counter'+(n>3800?' warn':'')+(n>=4096?' over':'') }
    $('#f-reply').addEventListener('input',updateCounter)
  }
  const canEl = $('#canned')
  if(canEl){
    const cans = cannedReplies(c)
    canEl.querySelectorAll('button').forEach(b=>b.onclick=()=>{
      const ta=$('#f-reply'); ta.value=cans[+b.dataset.i]; ta.focus()
      ta.setSelectionRange(ta.value.length,ta.value.length)
    })
  }
  const addNoteBtn = $('#add-case-note')
  if(addNoteBtn) addNoteBtn.onclick = async ()=>{
    const dlg=await showDialog({title:'Add a note to this case',inputLabel:'Note',inputPlaceholder:'Type your observation or note here...',confirmLabel:'Save note'})
    const text=(dlg&&dlg.value||'').trim(); if(!text) return
    const r=await api('/api/cases/'+encodeURIComponent(id)+'/note',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})})
    if(!r.ok){ toast(await failMsg(r,'note failed'),'err'); return }
    toast('note saved','ok'); lastCasesJson=''; await loadCases(); await openCase(id)
  }
  const splitBtn = $('#split-case-btn')
  if(splitBtn) splitBtn.onclick = async ()=>{
    const allEvts = await api('/api/cases/'+encodeURIComponent(id)+'/events?limit=200').then(r=>r.json()).catch(()=>({events:[]}))
    const evList = (allEvts.events||[]).filter(e=>['inbound','outbound','note','observation'].includes(e.kind))
    if(!evList.length){ toast('no events to split off','err'); return }
    const result = await showSplitDialog(evList, c.ref)
    if(!result) return
    const r = await api('/api/cases/'+encodeURIComponent(id)+'/split',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event_ids:result.event_ids,subject:result.subject,reason:result.reason})})
    if(!r.ok){ toast(await failMsg(r,'split failed'),'err'); return }
    const sj = await r.json().catch(()=>({}))
    toast('split: new case '+sj.new_case_ref+' ('+sj.moved_events+' events moved)','ok')
    lastCasesJson=''; await loadCases(); await openCase(id)
  }
  const moreBtn = $('#more-events')
  if(moreBtn) moreBtn.onclick = async ()=>{
    const off = events.length
    const older = await api('/api/cases/'+encodeURIComponent(id)+'/events?offset='+off).then(r=>r.json())
    $('#timeline').insertAdjacentHTML('beforeend', renderEvents(older.events||[]))
    if(!older.events||!older.events.length||off+older.events.length>=events_total) moreBtn.remove()
  }
  document.querySelectorAll('.trans').forEach(b=>b.onclick=async()=>{
    const toLabel = stageLabel(b.dataset.to)
    const dlg=await showDialog({title:'Move to: '+toLabel,inputLabel:'Reason (optional)',inputPlaceholder:'e.g. operator contacted farmer directly',confirmLabel:'Move case'})
    if(dlg===null) return                   // operator cancelled
    const reason=dlg.value||''
    const r = await api('/api/cases/'+encodeURIComponent(id)+'/transition',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({to:b.dataset.to,reason:reason||undefined})})
    if(!r.ok){ toast(await failMsg(r,'transition failed'),'err'); return }
    const updated = await r.json().catch(()=>({}))
    undoToast(id,CASEY_NOTIFIED_STAGES.includes(updated.status)?'Moved to '+toLabel+'. A short note was queued to the contact.':'Moved to '+toLabel+'. The contact was not told.')
    lastCasesJson=''; await loadCases(); await openCase(id)
  })
  renderListFull(); renderTriage()              // reflect the new active row in both lists
}
// Load and render the "possibly the same case" suggestions for the open case.
// Isolated and best-effort: any failure leaves the panel empty rather than
// breaking the detail view. Each suggestion shows the plain-language reasons and
// a merge button that folds the OTHER case into the one being viewed.
async function loadDuplicateSuggestions(id){
  const panel=$('#dup-panel'); if(!panel) return
  let j
  try{ j = await api('/api/cases/'+encodeURIComponent(id)+'/suggestions').then(r=>r.ok?r.json():null) }catch{ return }
  if(!j||!j.suggestions||!j.suggestions.length){ panel.innerHTML=''; return }
  panel.innerHTML='<div class="dup"><h3 style="margin:14px 0 6px">Possibly the same case</h3>'
    + '<p class="hint">casey thinks these reports may be the same outbreak. Merge folds the other case into this one (you can review before confirming).</p>'
    + j.suggestions.map(s=>\`<div class="dup-row"><b>\${esc(s.ref)}</b> \${esc(s.subject||'')}
        <span class="when">\${esc(s.reasons.join(', '))}</span>
        <button class="merge-btn" data-into="\${esc(s.id)}" data-ref="\${esc(s.ref)}" style="background:#3a2a40">Merge \${esc(s.ref)} into this</button></div>\`).join('')
    + '</div>'
  panel.querySelectorAll('.merge-btn').forEach(b=>b.onclick=async()=>{
    const dlg=await showDialog({title:'Merge '+b.dataset.ref+' into this case?',message:'The other case becomes a redirect. This is lossless and can be reviewed on the timeline.',inputLabel:'Why are these the same outbreak? (optional)',inputPlaceholder:'e.g. same farm, same symptoms reported separately',confirmLabel:'Merge cases',danger:true})
    if(dlg===null) return
    const reason=dlg.value||''
    b.disabled=true
    const r = await api('/api/cases/'+encodeURIComponent(id)+'/merge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({into:b.dataset.into,reason:reason||undefined})})
    b.disabled=false
    if(!r.ok){ toast(await failMsg(r,'merge failed'),'err'); return }
    const res=await r.json().catch(()=>({}))
    toast(res.alreadyMerged?'already merged':'merged '+b.dataset.ref+' in ('+(res.movedEvents||0)+' events)','ok')
    lastCasesJson=''; await loadCases(); await openCase(id)
  })
}
// Load and render the "who has visited this site" history: every OTHER case
// (open or closed) casey thinks describes the same real place, reused from
// the same correlate.js scoring that powers the merge-suggestion panel above,
// but at a lower threshold and including closed cases -- a visit history is
// about the PLACE's past, not just currently-open threads. PII-free by
// construction (server only returns ref/channel/status/timestamps, never
// external_id) -- clicking a row opens that case for full detail the same
// way the case list already does. Isolated/best-effort like
// loadDuplicateSuggestions: a failure here must never break the case view.
async function loadSiteHistory(id){
  const panel=$('#site-history-panel'); if(!panel) return
  let j
  try{ j = await api('/api/cases/'+encodeURIComponent(id)+'/site-history').then(r=>r.ok?r.json():null) }catch{ return }
  if(!j||!j.visits||!j.visits.length){ panel.innerHTML=''; return }
  panel.innerHTML='<div class="dup"><h3 style="margin:14px 0 6px">Visit history for this site</h3>'
    + '<p class="hint">Other reports casey thinks are the same place, most recent first -- any reporter may have visited, not only whoever opened this case.</p>'
    + j.visits.map(v=>\`<div class="dup-row" data-open="\${esc(v.id)}" style="cursor:pointer">
        <b>\${esc(v.ref)}</b> <span class="when">\${esc(v.channel||'')} - \${esc(v.status||'')} - reported \${esc(rel(v.reported_at))}</span>
        <span class="hint" style="display:block">\${esc(v.reasons.join(', '))}</span></div>\`).join('')
    + '</div>'
  panel.querySelectorAll('[data-open]').forEach(row=>row.onclick=()=>openCase(row.dataset.open))
}
function renderEvents(events){
  return events.map(e=>\`<div class="ev \${esc(e.kind)}"><span class="k">\${esc(e.kind)}/\${esc(e.actor)}</span> \${esc(e.text||'')} <span class="when" title="\${esc(fmtTime(e.created_at))}">\${esc(rel(e.created_at))}</span></div>\`).join('')
}
// Parse a 'snoozed-until:<epoch-ms>' tag (see POST /api/cases/:id/snooze,
// attn.js's own reader) into the epoch, or null if not snoozed / expired. A
// PAST snooze target reads as not-snoozed here (matches attnScore's own
// now-vs-snooze comparison) so the button correctly offers "Snooze" again
// rather than a stale "Snoozed" once the window has simply elapsed.
function snoozedUntilTag(tags){
  for(const t of String(tags||'').split(',').map(s=>s.trim())){
    if(t.startsWith('snoozed-until:')){
      const v=parseInt(t.slice('snoozed-until:'.length),10)
      if(Number.isFinite(v)&&v>Date.now()) return v
    }
  }
  return null
}
// Plain-language warning chips for the time-guardrail health:* tags the sweep
// maintains, so an operator sees at a glance that a case is going wrong over time.
const HEALTH_LABEL={'health:stale':'Going cold (no recent activity)','health:stuck':'Stuck in this stage too long','health:unanswered_handoff':'A person was asked for and not yet answered','health:abandoned_intake':'Intake left with on-site facts missing','health:incomplete_critical':'Working but visit-critical facts still missing','health:never_closed':'Resolved but never closed','health:timestamp_corrupt':'Case time data looks wrong'}
function healthBadges(tags){
  const list=String(tags||'').split(',').map(s=>s.trim()).filter(t=>t.indexOf('health:')===0)
  if(!list.length) return ''
  return '<div class="health">'+list.map(t=>\`<span class="health-chip" title="\${esc(t)}">\${esc(HEALTH_LABEL[t]||t)}</span>\`).join('')+'</div>'
}
function intakeModeBadge(tags){
  const t=String(tags||'').split(',').map(s=>s.trim())
  const hasChannel=t.includes('intake_mode:channel')
  const hasManual=t.includes('intake_mode:manual')
  const hasPublic=t.includes('intake_mode:public_form')
  if(!hasChannel&&!hasManual&&!hasPublic) return ''
  const parts=[]
  if(hasChannel) parts.push('<span class="src-tag src-ai" style="font-size:11px;padding:2px 8px">AI channel</span>')
  if(hasManual) parts.push('<span class="src-tag src-manual" style="font-size:11px;padding:2px 8px">Operator entry</span>')
  if(hasPublic) parts.push('<span class="src-tag src-both" style="font-size:11px;padding:2px 8px">Public form</span>')
  return '<span class="intake-mode-badge" title="How this case was created" style="background:transparent;padding:0">' + parts.join(' ') + '</span>'
}
// --- theme ---
function applyTheme(t){ document.documentElement.dataset.theme=t; try{localStorage.casey_theme=t}catch{}
  $('#theme').textContent = t==='light'?'dark':'light' }
applyTheme((()=>{ try{return localStorage.casey_theme}catch{} })() || (matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'))
$('#theme').onclick=()=>applyTheme(document.documentElement.dataset.theme==='light'?'dark':'light')
// --- plain-language / simple mode toggle (persisted like the theme) ---
function applySimple(on){ simple=!!on; try{localStorage.casey_simple=on?'1':''}catch{}
  $('#simple').classList.toggle('active',simple)
  $('#simple').title = simple ? 'Plain-language mode ON - click for technical stage names' : 'Plain-language mode: show friendly stage names'
  fillStatusFilter(); renderListFull(); if(activeId) openCase(activeId) }
applySimple((()=>{ try{return localStorage.casey_simple}catch{} })()==='1')
$('#simple').onclick=()=>applySimple(!simple)
// --- first-run help overlay (remembered in localStorage; re-openable via ? ) ---
let helpOpen = false
function helpSeen(){ try{ return localStorage.casey_help_seen==='1' }catch{ return false } }
function showHelp(){ helpOpen=true; $('#help-ovl').classList.add('show') }
function hideHelp(){ helpOpen=false; $('#help-ovl').classList.remove('show'); try{ localStorage.casey_help_seen='1' }catch{} }
$('#help').onclick = showHelp
$('#help-close').onclick = hideHelp
$('#help-ovl').addEventListener('click', e=>{ if(e.target===$('#help-ovl')) hideHelp() })
// First-run onboarding: a focused 3-step card shown once per browser. The flag is
// set the moment it is dismissed, so it never nags a returning operator.
function onboarded(){ try{ return localStorage.casey_onboarded==='1' }catch{ return false } }
function showOnboard(){ $('#onboard-ovl').classList.add('show') }
function hideOnboard(){ $('#onboard-ovl').classList.remove('show'); try{ localStorage.casey_onboarded='1' }catch{} }
$('#onboard-close').onclick = hideOnboard
$('#onboard-ovl').addEventListener('click', e=>{ if(e.target===$('#onboard-ovl')) hideOnboard() })
// "Show me again" from inside the help card: close help, reopen the quick start.
const _onboardAgain=$('#onboard-again'); if(_onboardAgain) _onboardAgain.onclick=()=>{ hideHelp(); showOnboard() }
// --- per-operator skills checklist -------------------------------------------
// Distinct from the one-per-browser quick start: this tracks, PER OPERATOR, whether
// they have learned the three shift-speed moves. State is a localStorage map keyed
// by operator id (or a "default" bucket before anyone is picked) so a shared
// machine does not leak one person's progress onto the next. Dismissed or fully
// ticked, it does not reappear. ASCII only; client-only; no server state.
const SKILLS = [
  { id:'keys', label:'Keyboard triage: j and k move through the list, Enter opens, c claims, e jumps to the reply box.' },
  { id:'mine', label:'The Mine filter shows only the cases you have claimed -- pick who you are top-right, then press Mine.' },
  { id:'draft', label:'In assisted mode a reply waits as a draft until you approve it -- open the case and use Send draft or Discard.' },
]
function skillsKey(){ return 'casey_skills_'+(selectedOperator||'default') }
function loadSkills(){ try{ const o=JSON.parse(localStorage.getItem(skillsKey())||'{}'); return (o&&typeof o==='object')?o:{} }catch{ return {} } }
function saveSkills(o){ try{ localStorage.setItem(skillsKey(), JSON.stringify(o)) }catch{} }
function skillsDone(o){ return SKILLS.every(s=>o[s.id]) }
function skillsDismissed(){ return loadSkills().__dismissed===true }
function renderSkills(){
  const o=loadSkills(); const ul=$('#skills-list'); if(!ul) return
  ul.innerHTML=SKILLS.map(s=>'<li data-id="'+esc(s.id)+'"'+(o[s.id]?' class="done"':'')+'><span class="box">'+(o[s.id]?'x':'')+'</span><span class="lbl">'+esc(s.label)+'</span></li>').join('')
  ul.querySelectorAll('li').forEach(li=>li.onclick=()=>{
    const m=loadSkills(); const id=li.dataset.id; m[id]=!m[id]; saveSkills(m); renderSkills()
    if(skillsDone(loadSkills())) toast('Nice -- you have got the three core moves.','ok')
  })
}
function showSkills(){ renderSkills(); $('#skills-ovl').classList.add('show') }
function hideSkills(){ $('#skills-ovl').classList.remove('show'); const m=loadSkills(); m.__dismissed=true; saveSkills(m) }
const _skClose=$('#skills-close'); if(_skClose) _skClose.onclick=hideSkills
const _skOvl=$('#skills-ovl'); if(_skOvl) _skOvl.addEventListener('click', e=>{ if(e.target===_skOvl) hideSkills() })
// Surface for the witness harness.
window.__caseySkills = { SKILLS, skillsKey, loadSkills, saveSkills, skillsDone, skillsDismissed, renderSkills, showSkills, hideSkills }

// On a brand-new browser show the quick start; otherwise leave help to the ? button.
// Once the quick start is done, a fresh operator who has not finished or dismissed
// the skills checklist sees it next (never both at once).
if(!onboarded()){ showOnboard() }
else if(!skillsDismissed() && !skillsDone(loadSkills())){ showSkills() }
else if(!helpSeen()){ showHelp() }
// --- filters ---
let qTimer
$('#q').addEventListener('input',e=>{ clearTimeout(qTimer); qTimer=setTimeout(()=>{ filt.q=e.target.value; lastCasesJson=''; loadCases() },300) })
$('#statusf').addEventListener('change',e=>{ filt.status=e.target.value; lastCasesJson=''; loadCases() })
$('#refresh').onclick=()=>{ lastCasesJson=''; loadCases() }
// --- keyboard nav: / focus search, j/k move, enter open, esc clear/back ---
document.addEventListener('keydown',e=>{
  const typing=/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)
  if(e.key==='n' && !typing){ e.preventDefault(); openIntakeForm(null); return }
  if(e.key==='/' && !typing){ e.preventDefault(); $('#q').focus(); return }
  if(e.key==='Escape'){ const bk=$('#back'); if($('#onboard-ovl').classList.contains('show')){hideOnboard()} else if($('#skills-ovl').classList.contains('show')){hideSkills()} else if(helpOpen){hideHelp()} else if(typing){document.activeElement.blur()} else if(bk&&$('#wrap').classList.contains('detail-open')){bk.click()} else if($('#q').value){filt.q='';$('#q').value='';renderListFull()} return }
  if(e.key==='?' && !typing){ e.preventDefault(); helpOpen?hideHelp():showHelp(); return }
  if(typing) return
  if(e.key==='j'||e.key==='k'||e.key==='ArrowDown'||e.key==='ArrowUp'){
    const shown=allCases.filter(matchesFull); if(!shown.length)return
    let i=shown.findIndex(c=>c.id===activeId)
    i = (e.key==='j'||e.key==='ArrowDown') ? Math.min(shown.length-1,i+1) : Math.max(0,i<0?0:i-1)
    openCase(shown[i].id)
    const el=document.querySelector('.case.active'); if(el)el.scrollIntoView({block:'nearest'})
    return
  }
  // o / Enter open the highlighted case; if none is open yet, open the first shown.
  if(e.key==='o'||e.key==='Enter'){
    if(!activeId){ const shown=allCases.filter(matchesFull); if(shown.length){ e.preventDefault(); openCase(shown[0].id) } }
    return
  }
  // c claims the open case (same path as the Claim button); e jumps to the reply box.
  if(e.key==='c'){ const b=$('#claim-btn'); if(b){ e.preventDefault(); b.click() } return }
  if(e.key==='e'){ const ta=$('#f-reply'); if(ta){ e.preventDefault(); ta.focus() } return }
})
// --- deep-link restore + poll ---
function restoreFromHash(){ const m=/#case=([^&]+)/.exec(location.hash); if(m) return decodeURIComponent(m[1]) }
async function restoreRefFromHash(){
  const m=/#ref=([^&]+)/.exec(location.hash); if(!m) return
  const ref=decodeURIComponent(m[1])
  // pre-populate search and fetch the matching case
  filt.q=ref; $('#q').value=ref; lastCasesJson=''
  await loadCases()
  const found=allCases.find(c=>c.ref===ref); if(found) openCase(found.id)
}
// Handoff banner click handlers (attached here so openCase is defined).
$('#handoff').onclick=(e)=>{ if(e.target.id==='handoff-dismiss') return
  const c=handoffQueue[handoffQueue.length-1]; if(c) openCase(c.id) }
$('#handoff-dismiss').onclick=(e)=>{ e.stopPropagation(); handoffQueue=[]; renderHandoff() }
// Plain-words AI-helper health pill. Green when online, amber otherwise; the
// title carries the full plain sentence so an operator sees WHY auto-replies may
// be paused. Failure to fetch is itself "unknown" (amber) -- never a silent green.
let lastHealth=null
async function refreshHealth(){
  const el=$('#aihealth'); if(!el) return
  let h
  try{ h=await api('/api/health').then(r=>{ if(!r.ok) throw new Error(r.status); return r.json() }) }
  catch(e){ h={ ok:false, label:'AI helper: unknown', detail:'Cannot reach the server to check the AI helper.' } }
  lastHealth=h
  // A deaf receive channel (gateway not connected) is more urgent than the AI
  // helper's state: contacts may be messaging into silence. When the server
  // reports the gateway down, the pill shows THAT in red and overrides the
  // AI-helper line, so "online" can never hide "answering nobody".
  const gw=h.gateway
  if(gw && gw.ok===false){
    el.textContent=gw.label||'Messages: not connected'
    el.title=gw.detail||'A message channel is not receiving.'
    el.style.background='rgba(200,40,40,.20)'
    el.style.color='#b22222'
    return
  }
  el.textContent=h.label
  // Queue-alert-visibility: append LLM-down queue depth and alert-webhook
  // delivery status into the SAME pill's title (no new UI element needed --
  // an operator already hovers this pill to see why auto-replies may be
  // paused, so the backlog/webhook detail belongs right there). Silent when
  // there is nothing worth surfacing (no queue backlog, webhook never
  // attempted or unconfigured) so a healthy deployment's tooltip stays terse.
  let extra=''
  if(h.queue && (h.queue.pending>0 || h.queue.dead_lettered>0)){
    extra+=' - Queued messages waiting to retry: '+h.queue.pending
    if(h.queue.dead_lettered>0) extra+=' ('+h.queue.dead_lettered+' gave up after repeated failures)'
  }
  if(h.alert_webhook && h.alert_webhook.configured && h.alert_webhook.ok===false){
    extra+=' - Alert webhook is failing to send.'
  }
  el.title=h.detail+(h.model?(' ('+h.model+')'):'')+(gw&&gw.label?(' - '+gw.label):'')+extra
  el.style.background=h.ok?'rgba(34,160,80,.18)':'rgba(200,140,0,.20)'
  el.style.color=h.ok?'#1c8c44':'#9a6a00'
  refreshRuntimePill(); refreshGuardrailsPill()
}
// Tints a pill green/amber/red. ok=true->green, warn=true->amber, else red.
function pillTint(el, ok, warn){
  if(ok){ el.style.background='rgba(34,160,80,.18)'; el.style.color='#1c8c44' }
  else if(warn){ el.style.background='rgba(200,140,0,.20)'; el.style.color='#9a6a00' }
  else { el.style.background='rgba(200,40,40,.20)'; el.style.color='#b22222' }
}
// Runtime pill: only shown when the process is supervised (standalone hides it,
// since there is no supervisor state to report). Red on 'degraded'.
async function refreshRuntimePill(){
  const el=$('#runtime-pill'); if(!el) return
  let r; try{ r=await api('/api/runtime').then(x=>x.ok?x.json():null) }catch{ r=null }
  if(!r || r.supervised===false){ el.style.display='none'; return }
  el.style.display=''
  el.textContent=r.label||('Runtime: '+(r.state||'unknown'))
  el.title='Restarts since boot: '+(r.restarts||0)+(r.lastCrashReason?(' - last: '+r.lastCrashReason):'')
  pillTint(el, r.state==='healthy', r.state==='restarting'||r.state==='booting')
}
// Inline-SVG sparkline (no chart lib): scaled polyline over numeric series.
function sparkline(vals, w, h2){
  if(!vals||!vals.length) return ''
  const max=Math.max(1,...vals)
  const step=vals.length>1 ? w/(vals.length-1) : 0
  const pts=vals.map((v,i)=>i*step+','+(h2-(v/max)*h2)).join(' ')
  return '<svg width="'+w+'" height="'+h2+'" style="vertical-align:middle;margin-left:5px"><polyline points="'+esc(pts)+'" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>'
}
// Guardrails pill: green clean / amber flagged>0 / red degraded, with a sparkline
// of recent flagged counts. Hidden until at least one sweep has run.
async function refreshGuardrailsPill(){
  const el=$('#guardrails-pill'); if(!el) return
  let fh; try{ fh=await api('/api/fleet-health').then(x=>x.ok?x.json():null) }catch{ fh=null }
  if(!fh || !fh.latest){ el.style.display='none'; return }
  el.style.display=''
  const flagged=fh.latest.flagged||0
  const spark=sparkline((fh.history||[]).map(p=>(p.flagged!=null?p.flagged:(p.data&&p.data.flagged)||0)), 36, 12)
  el.innerHTML='Guardrails: '+(fh.degraded?'degraded':(flagged>0?(flagged+' flagged'):'clean'))+spark
  el.title='Last sweep scanned '+(fh.latest.scanned||0)+', flagged '+flagged
  pillTint(el, !fh.degraded && flagged===0, !fh.degraded && flagged>0)
}
// --- channel filter ---
function fillChannelFilter(){
  const cur=$('#channelf').value
  const channels=[...new Set(allCases.map(c=>c.channel).filter(Boolean))].sort()
  $('#channelf').innerHTML='<option value="">all channels</option>'+channels.map(ch=>\`<option value="\${esc(ch)}"\${ch===cur?' selected':''}>\${esc(ch)}</option>\`).join('')
  if(cur) $('#channelf').value=cur
}
$('#channelf').addEventListener('change',e=>{ filt.channel=e.target.value; lastCasesJson=''; loadCases() })
$('#sourcef').addEventListener('change',e=>{ filt.source=e.target.value; renderListFull(); renderTriage() })

// --- saved views: a named bundle of the current filter set ---------------------
// A "view" is just the operator's filters captured as plain data: search text,
// stage, channel, source, the Mine toggle, and Focus mode. We keep it client-only
// (no server state) and encode it two ways: a base64url 'view=' segment of the URL
// hash so a view is shareable by link (building on the existing #inbox/#case hash
// pattern; auth is the login session cookie, so a shared link carries no secret),
// and a small named-view map in localStorage so an operator's own views
// survive a reload. No external_id is ever part of a view -- only filter knobs.
function currentView(){ return { q: filt.q||'', status: filt.status||'', channel: filt.channel||'', source: filt.source||'', mine: !!mineOnly, focus: !!inboxMode } }
function encodeView(v){ try{ return btoa(unescape(encodeURIComponent(JSON.stringify(v)))).replace(/=+$/,'').replace(/\\+/g,'-').replace(/\\//g,'_') }catch{ return '' } }
function decodeView(s){ try{ const b=s.replace(/-/g,'+').replace(/_/g,'/'); const o=JSON.parse(decodeURIComponent(escape(atob(b)))); return (o&&typeof o==='object')?o:null }catch{ return null } }
// Apply a view object to the live filter state + controls, then reload the list.
function applyView(v){
  if(!v||typeof v!=='object') return
  filt.q=String(v.q||''); const qel=$('#q'); if(qel) qel.value=filt.q
  filt.status=String(v.status||''); const sel=$('#statusf'); if(sel) sel.value=filt.status
  filt.channel=String(v.channel||''); const cel=$('#channelf'); if(cel) cel.value=filt.channel
  filt.source=String(v.source||''); const oel=$('#sourcef'); if(oel) oel.value=filt.source
  setMineOnly(!!v.mine)
  setInboxMode(!!v.focus)
  lastCasesJson=''; loadCases()
}
// Write the active view into the hash (preserving any #case= deep-link segment).
function viewToHash(v){
  const enc=encodeView(v); if(!enc) return
  const parts=(location.hash||'').replace(/^#/,'').split('&').filter(p=>p&&!p.startsWith('view='))
  parts.unshift('view='+enc)
  const want='#'+parts.join('&')
  if(location.hash!==want) history.replaceState(null,'',location.pathname+location.search+want)
}
function viewFromHash(){ const m=/(?:^|[#&])view=([^&]+)/.exec(location.hash||''); return m?decodeView(m[1]):null }
// Named views persisted per browser. Map of name -> view object.
function loadNamedViews(){ try{ const o=JSON.parse(localStorage.casey_views||'{}'); return (o&&typeof o==='object')?o:{} }catch{ return {} } }
function saveNamedViews(m){ try{ localStorage.casey_views=JSON.stringify(m) }catch{} }
function refreshViewsDropdown(){
  const sel=$('#viewsf'); if(!sel) return
  const m=loadNamedViews(); const names=Object.keys(m).sort()
  sel.innerHTML='<option value="">saved views</option>'+names.map(n=>'<option value="'+esc(n)+'">'+esc(n)+'</option>').join('')+(names.length?'<option value="__del__">-- delete a view...</option>':'')
}
function saveCurrentView(){
  const name=(prompt('Name this view (e.g. "my urgent", "Musina handoffs"):')||'').trim()
  if(!name) return
  if(name.length>60){ toast('That name is too long.','err'); return }
  const m=loadNamedViews(); m[name]=currentView(); saveNamedViews(m); refreshViewsDropdown()
  const sel=$('#viewsf'); if(sel) sel.value=name
  viewToHash(currentView())
  toast('Saved view "'+name+'"','ok')
}
{
  const sel=$('#viewsf'); const btn=$('#view-save')
  if(btn) btn.onclick=saveCurrentView
  if(sel) sel.onchange=()=>{
    const v=sel.value
    if(v==='__del__'){
      const m=loadNamedViews(); const names=Object.keys(m).sort()
      const name=(prompt('Delete which view? '+names.join(', '))||'').trim()
      if(name&&m[name]){ delete m[name]; saveNamedViews(m); toast('Deleted view "'+name+'"','ok') }
      refreshViewsDropdown(); return
    }
    if(!v){ return }
    const m=loadNamedViews(); if(m[v]){ applyView(m[v]); viewToHash(m[v]) }
  }
  refreshViewsDropdown()
}
// Expose for the browser-witness harness: it asserts a hash-encoded view restores
// the full filter set after a reload.
window.__caseyViews = { currentView, encodeView, decodeView, applyView, viewToHash, viewFromHash }

let mineOnly = false
// True when the case is owned by the operator currently signed in (top-right
// picker). The agent/unclaimed pseudo-owner is never "mine".
function isMine(c){ return !!selectedOperator && c && c.assignee===selectedOperator }
function matchesFull(c){
  if(mineOnly && !isMine(c)) return false
  if(filt.channel && c.channel!==filt.channel) return false
  if(filt.source){
    const tags=tagList(c)
    if(filt.source==='manual' && !tags.includes('intake_mode:manual')) return false
    if(filt.source==='channel' && !tags.includes('intake_mode:channel')) return false
    if(filt.source==='public_form' && !tags.includes('intake_mode:public_form')) return false
  }
  return matches(c)
}
function renderListFull(){
  const shown = allCases.filter(matchesFull)
  if(!allCases.length){ $('#cases').innerHTML='<div class="empty">No cases yet.<br>Run <code>casey sim</code> or connect a channel to create one.</div>'; return }
  if(!shown.length){ $('#cases').innerHTML='<div class="empty">No cases match your filter.</div>'; return }
  $('#cases').innerHTML = shown.map(c=>\`
    <div class="case \${c.id===activeId?'active':''}\${selectedIds.has(c.id)?' selected':''}" data-id="\${esc(c.id)}">
      <input type="checkbox" class="case-cb" data-id="\${esc(c.id)}" title="Select for a bulk action"\${selectedIds.has(c.id)?' checked':''}>
      <div class="case-body">
      <div class="top">\${attn(c)?'<span class="dot attn" title="needs attention (autonomy: '+esc(c.autonomy)+')"></span>':''}
        <span class="ref">\${esc(c.ref)}</span><span class="badge \${esc(c.priority)}">\${esc(c.priority)}</span>
        \${c.assignee&&c.assignee!=='agent'?'<span class="owner-chip'+(c.assignee===selectedOperator?' mine':'')+'">'+(c.assignee===selectedOperator?'you':esc(c.assignee))+'</span>':''}
        <span class="when" style="margin-left:auto" title="\${esc(fmtTime(c.updated_at||c.created_at))}">\${esc(rel(c.updated_at||c.created_at))}</span></div>
      <div class="sub">\${(()=>{ const tg=tagList(c); if(tg.includes('intake_mode:manual')) return '<span class="src-tag src-manual" style="font-size:10px;padding:1px 6px">Manual</span> '; if(tg.includes('intake_mode:public_form')) return '<span class="src-tag src-both" style="font-size:10px;padding:1px 6px">Form</span> '; if(tg.includes('intake_mode:channel')) return '<span class="src-tag src-ai" style="font-size:10px;padding:1px 6px">AI</span> '; return '' })()\}\${esc(c.channel)} - \${esc(stageLabel(c.status))} - \${esc(c.subject||'(no subject)')}\${c.fill_rate?fillPill(c.fill_rate):''}</div>
      </div>
    </div>\`).join('')
  document.querySelectorAll('.case .case-body').forEach(el=>el.onclick=()=>openCase(el.parentNode.dataset.id))
  document.querySelectorAll('.case-cb').forEach(cb=>cb.onclick=e=>{ e.stopPropagation(); toggleSelect(cb.dataset.id,cb.checked) })
  syncBulkBar()
}
// --- bulk selection state + toolbar ---
const selectedIds=new Set()
function toggleSelect(id,on){ if(on) selectedIds.add(id); else selectedIds.delete(id); const row=document.querySelector('.case[data-id="'+(window.CSS&&CSS.escape?CSS.escape(id):id)+'"]'); if(row) row.classList.toggle('selected',on); syncBulkBar() }
function clearSelection(){ selectedIds.clear(); document.querySelectorAll('.case-cb').forEach(cb=>cb.checked=false); document.querySelectorAll('.case.selected').forEach(r=>r.classList.remove('selected')); syncBulkBar() }
function syncBulkBar(){
  const bar=$('#bulk-bar'); if(!bar) return
  const n=selectedIds.size
  bar.style.display = n>0 ? 'flex' : 'none'
  const cnt=$('#bulk-count'); if(cnt) cnt.textContent = n+' selected'
  const all=$('#bulk-all'); if(all){ const shownIds=allCases.filter(matchesFull).map(c=>c.id); all.checked = shownIds.length>0 && shownIds.every(id=>selectedIds.has(id)) }
}
async function bulkAction(action,extra){
  const ids=[...selectedIds]; if(!ids.length) return
  if(action==='claim' && !selectedOperator){ toast('Pick who you are first (top-right) so claims are recorded against you.','warn'); return }
  try{
    const r=await api('/api/cases/bulk',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({ids,action},extra||{}))})
    if(!r.ok){ toast(await failMsg(r,'bulk action failed'),'err'); return }
    const j=await r.json().catch(()=>({}))
    const verb={claim:'claimed',transition:'moved',tag:'tagged',untag:'untagged',note:'noted',draft_approve:'sent',draft_discard:'discarded'}[action]||action
    toast(verb+' '+(j.ok||0)+(j.failed?(', '+j.failed+' could not be '+verb):''), j.failed?'warn':'ok')
    clearSelection(); lastCasesJson=''; await loadCases(); refreshAttention()
  }catch(e){ toast('Bulk error: '+e.message,'err') }
}
filt.channel = ''
filt.source = ''

// --- intake form (New Case / Edit Report) ---
// Fields a field visit cannot recover once the worker leaves -- visit-critical
// fields come first and are marked required. textarea:true for long free-text.
const INTAKE_FIELDS=[
  // -- visit-critical (needed for a field visit) --
  ['species','Which animals?','e.g. cattle, sheep, goats, pigs',{required:true},'The type of animal matters for disease identification. Be specific: "cattle" is better than "livestock".'],
  ['symptoms','What signs are you seeing?','e.g. drooling, limping, not eating, sudden death',{required:true,textarea:true},'Describe what you can see or hear. Multiple symptoms? List them all. "Drooling and limping on front legs" is much more useful than just "sick".'],
  ['location','Where are the animals?','Farm name, nearest town, or GPS coordinates',{required:true},'The single most important field. Without WHERE, a field team cannot visit. Farm name + nearest town is the minimum. GPS coordinates from your phone are perfect.'],
  ['how_to_find','How do we find the place?','Road name, landmark, or directions from the nearest town',{required:true,textarea:true},'What would you tell a stranger driving from the nearest town? Include landmarks, turn directions, and any tricky spots. "Past the big baobab, second gate on the left."'],
  ['farmer_available','Will the farmer be there?','e.g. yes, or phone first on 082...',{required:true},'A field team needs someone on-site to show them the animals. If the farmer will not be there, who can meet them?'],
  ['contact_fallback','Any other contact person?','Name and phone number if different from this one',{required:true},'A second number to call if this contact is unreachable. Even a neighbour or family member is better than nothing.'],
  // -- additional details --
  ['affected_count','How many are affected?','e.g. 5','Total number showing symptoms. Even an estimate helps plan resources.'],
  ['dead_count','How many have died?','e.g. 2 (write 0 if none)','If animals have died, note how many and roughly when (today, yesterday, over the past week).'],
  ['onset','When did it start?','e.g. yesterday morning, 3 days ago','When did you first notice the problem? This helps identify the disease timeline.'],
  ['suspected_disease','Do you know what disease it might be?','e.g. FMD, lumpy skin - leave blank if unsure','Leave blank if unsure. Only fill if the farmer or vet has already suggested a name.'],
  ['recent_movement','Have the animals moved recently?','e.g. yes, bought from market last week','Movement in the past 2-4 weeks can spread disease. Note if animals were bought, sold, or moved between farms.'],
  ['access_notes','Any access or travel notes?','e.g. gravel road, locked gate - call first',{textarea:true},'Anything that could slow down or block a field visit: road conditions, security, locked gates, flooding, etc.'],
  ['identifying_traits','How do we identify the animals?','e.g. red tag in ear, black-and-white Friesians','Ear tag numbers, coat colour, breed, or any other way to identify the sick animals in a herd.'],
  ['photos','Are there photos?','yes / no, or a description of what they show','If photos were sent on WhatsApp/Discord, write "yes - sent via channel". Otherwise describe what the photo shows.'],
  ['audio','Are there voice notes?','yes / no'],
  ['notes','Anything else to note?','Any extra information',{textarea:true}],
]
const VC_KEYS = new Set(['species','symptoms','location','how_to_find','farmer_available','contact_fallback'])
let intakeCaseId = null    // set when editing existing case; null = new case
let intakeStep = 1         // 1, 2, or 3; only used for new-case wizard
// Build separate HTML strings for step2 (VC fields) and step3 (additional)
function buildFieldsHtml(existingReport){
  let step2='', step3=''
  for(const [k,label,hint,opts={},coaching=''] of INTAKE_FIELDS){
    const val=esc(existingReport[k]||'')
    const req=opts.required?' <span class="intake-req" title="Needed for a field visit">*</span>':''
    const hintId='hint-'+k
    const hintBtn=coaching?\`<button type="button" class="intake-hint-btn" aria-expanded="false" data-hint="\${hintId}" title="What to write here">(?)</button>\`:'';
    let fld=\`<label for="int-\${k}">\${esc(label)}\${req}\${hintBtn}</label>\`
    if(coaching) fld+=\`<div class="intake-hint-box" id="\${hintId}">\${esc(coaching)}</div>\`
    const ariaReq=opts.required?' aria-required="true"':''
    if(opts.textarea){ fld+=\`<textarea id="int-\${k}" name="\${k}" placeholder="\${esc(hint)}" rows="2" autocomplete="off"\${ariaReq}>\${val}</textarea>\` }
    else { fld+=\`<input id="int-\${k}" name="\${k}" placeholder="\${esc(hint)}" value="\${val}" autocomplete="off"\${ariaReq}>\` }
    if(VC_KEYS.has(k)) step2+=fld; else step3+=fld
  }
  return {step2, step3}
}
function getVcFillCount(valuesObj){
  return [...VC_KEYS].filter(k=>(valuesObj[k]||'').trim()!=='').length
}
function updateVcFillBar(){
  const barEl=document.getElementById('intake-vc-fill-bar')
  if(!barEl) return
  const vals={}
  for(const k of VC_KEYS){ const el=document.getElementById('int-'+k); if(el) vals[k]=el.value||'' }
  // also factor in saved step values from other step if in step3
  for(const [k,v] of Object.entries(window._intakeStep2Values||{})){ if(!vals[k]) vals[k]=v }
  const filled=getVcFillCount(vals)
  const total=[...VC_KEYS].length
  const pct=Math.round(filled/total*100)
  const fillEl=document.getElementById('intake-vc-fill-pct')
  const labelEl=document.getElementById('intake-vc-fill-label')
  if(fillEl){ fillEl.style.width=pct+'%'; fillEl.style.background=filled===total?'var(--accent)':'var(--danger,#c00)' }
  if(labelEl) labelEl.textContent=filled+'/'+total+' visit-critical fields filled'
}
function showIntakeStep(step){
  intakeStep=step
  const isNew=!intakeCaseId
  const {step2,step3}=buildFieldsHtml(window._intakeExistingReport||{})
  if(isNew){
    // step-bar and wizard only for new case
    $('#intake-step-bar').style.display='flex'
    document.getElementById('step-dot-1').className='step-dot'+(step===1?' active':' done')
    document.getElementById('step-dot-2').className='step-dot'+(step===2?' active':(step===3?' done':''))
    document.getElementById('step-dot-3').className='step-dot'+(step===3?' active':'')
    document.getElementById('step-line-1').className='step-line'+(step>1?' done':'')
    document.getElementById('step-line-2').className='step-line'+(step>2?' done':'')
    const labels=['','Contact details','Visit-critical fields','Additional details']
    $('#intake-step-label').textContent='Step '+step+' of 3: '+labels[step]
    if(step===1){
      $('#intake-contact-fields').style.display=''
      $('#intake-report-fields').innerHTML=''
      $('#intake-next').style.display=''; $('#intake-back').style.display='none'; $('#intake-submit').style.display='none'
    } else if(step===2){
      $('#intake-contact-fields').style.display='none'
      $('#intake-report-fields').innerHTML=
        '<div class="intake-vc-fill" id="intake-vc-fill-bar"><span id="intake-vc-fill-label">0/6 visit-critical fields filled</span><div class="bar"><div class="fill" id="intake-vc-fill-pct" style="width:0%"></div></div></div>'+
        '<div class="intake-section-head">Visit-critical fields <span class="intake-vc-note">(needed before a vet can visit)</span></div>'+step2
      $('#intake-next').style.display=''; $('#intake-back').style.display=''; $('#intake-submit').style.display='none'
      updateVcFillBar()
      // wire hint toggles
      document.querySelectorAll('.intake-hint-btn').forEach(btn=>{ btn.onclick=()=>{
        const box=document.getElementById(btn.dataset.hint); if(!box) return
        const open=box.classList.toggle('open'); btn.setAttribute('aria-expanded',open?'true':'false')
      }})
      // live fill bar update
      const rfEl=$('#intake-report-fields')
      if(rfEl._vcH) rfEl.removeEventListener('input',rfEl._vcH)
      rfEl._vcH=()=>updateVcFillBar(); rfEl.addEventListener('input',rfEl._vcH)
    } else {
      $('#intake-contact-fields').style.display='none'
      $('#intake-report-fields').innerHTML='<div class="intake-section-head">Additional details</div>'+step3
      $('#intake-next').style.display='none'; $('#intake-back').style.display=''; $('#intake-submit').style.display=''
      $('#intake-submit').textContent='Save'
    }
  } else {
    // Edit mode: single page with all fields
    $('#intake-step-bar').style.display='none'
    $('#intake-contact-fields').style.display='none'
    $('#intake-report-fields').innerHTML=
      '<div class="intake-vc-fill" id="intake-vc-fill-bar"><span id="intake-vc-fill-label">0/6 visit-critical fields filled</span><div class="bar"><div class="fill" id="intake-vc-fill-pct" style="width:0%"></div></div></div>'+
      '<div class="intake-section-head">Visit-critical fields <span class="intake-vc-note">(needed before a vet can visit)</span></div>'+step2+
      '<div class="intake-section-head" style="margin-top:14px">Additional details</div>'+step3
    $('#intake-next').style.display='none'; $('#intake-back').style.display='none'; $('#intake-submit').style.display=''; $('#intake-submit').textContent='Save'
    updateVcFillBar()
    document.querySelectorAll('.intake-hint-btn').forEach(btn=>{ btn.onclick=()=>{
      const box=document.getElementById(btn.dataset.hint); if(!box) return
      const open=box.classList.toggle('open'); btn.setAttribute('aria-expanded',open?'true':'false')
    }})
    const rfEl=$('#intake-report-fields')
    if(rfEl._vcH) rfEl.removeEventListener('input',rfEl._vcH)
    rfEl._vcH=()=>updateVcFillBar(); rfEl.addEventListener('input',rfEl._vcH)
  }
  $('#intake-error').style.display='none'
}
function openIntakeForm(caseRow){
  intakeCaseId = caseRow ? caseRow.id : null
  const isEdit = !!caseRow
  $('#intake-title').textContent = isEdit ? 'Edit report fields' : 'New case'
  let existingReport = {}
  if(caseRow && caseRow.report){ try{ existingReport=JSON.parse(caseRow.report) }catch{} }
  window._intakeExistingReport = existingReport
  // fill bar is rendered inline in step2/edit-mode via showIntakeStep; hide the old bar element
  const fillBar = $('#intake-fill-bar')
  if(fillBar) fillBar.style.display='none'
  showIntakeStep(1)
  if(!isEdit){
    const draft=restoreDraft()
    if(draft){
      const n=$('#int-name'); if(n&&draft.name) n.value=draft.name
      const p=$('#int-phone'); if(p&&draft.phone) p.value=draft.phone
      const s=$('#int-subject'); if(s&&draft.subject) s.value=draft.subject
      for(const [k] of INTAKE_FIELDS){ const el=document.getElementById('int-'+k); if(el&&draft[k]) el.value=draft[k] }
      setTimeout(()=>toast('Draft restored - fill in the rest and save','ok'),200)
    }
    // auto-save draft on any input change; remove any prior listener first
    const ovl=$('#intake-ovl')
    if(ovl._draftH) ovl.removeEventListener('input',ovl._draftH)
    const saveH=()=>saveDraft()
    ovl._draftH=saveH
    ovl.addEventListener('input',saveH)
  }
  $('#intake-ovl').classList.add('show')
  setTimeout(()=>{ if(isEdit) document.getElementById('int-species')?.focus()
    else document.getElementById('int-name')?.focus() }, 80)
}
function saveDraft(){
  if(intakeCaseId) return // only save drafts for new-case mode
  const d={}
  const n=$('#int-name'); if(n) d.name=n.value
  const p=$('#int-phone'); if(p) d.phone=p.value
  const s=$('#int-subject'); if(s) d.subject=s.value
  for(const [k] of INTAKE_FIELDS){ const el=document.getElementById('int-'+k); if(el) d[k]=el.value }
  // Fill gaps from saved step values (DOM wins; saved values fill fields not currently rendered)
  for(const [k,v] of Object.entries(window._intakeStep2Values||{})){ if(d[k]==null) d[k]=v }
  for(const [k,v] of Object.entries(window._intakeStep3Values||{})){ if(d[k]==null) d[k]=v }
  try{localStorage.casey_draft_case=JSON.stringify(d)}catch{}
}
function clearDraft(){ try{localStorage.removeItem('casey_draft_case')}catch{} }
function restoreDraft(){
  try{
    const raw=localStorage.casey_draft_case; if(!raw) return null
    return JSON.parse(raw)
  }catch{ return null }
}
function closeIntakeOvl(){ $('#intake-ovl').classList.remove('show'); intakeCaseId=null; window._intakeExistingReport={}; window._intakeStep2Values={}; window._intakeStep3Values={} }
$('#intake-next').onclick=()=>{
  const errEl=$('#intake-error')
  if(intakeStep===1){
    // step 1 -> step 2: no required fields, just advance
    errEl.style.display='none'
    showIntakeStep(2)
    // restore any draft VC values
    const draft2=restoreDraft()
    if(draft2){ for(const [k] of INTAKE_FIELDS.filter(([k])=>VC_KEYS.has(k))){ const el=document.getElementById('int-'+k); if(el&&draft2[k]&&!el.value) el.value=draft2[k] } }
    updateVcFillBar()
    document.getElementById('int-species')?.focus()
  } else if(intakeStep===2){
    // step 2 -> step 3: at least species required
    const species=(document.getElementById('int-species')||{}).value||''
    if(!species.trim()){ errEl.textContent='Please fill in at least the animal type (which animals?)'; errEl.style.display=''; return }
    errEl.style.display='none'
    // preserve step2 VC values
    window._intakeStep2Values={}
    for(const [k] of INTAKE_FIELDS.filter(([k])=>VC_KEYS.has(k))){
      window._intakeStep2Values[k]=(document.getElementById('int-'+k)||{}).value||''
    }
    showIntakeStep(3)
    // restore step3 draft values
    const draft3=restoreDraft()
    if(draft3){ for(const [k] of INTAKE_FIELDS.filter(([k])=>!VC_KEYS.has(k))){ const el=document.getElementById('int-'+k); if(el&&draft3[k]&&!el.value) el.value=draft3[k] } }
    document.getElementById('int-affected_count')?.focus()
  }
}
$('#intake-back').onclick=()=>{
  const errEl=$('#intake-error')
  errEl.style.display='none'
  if(intakeStep===2){
    showIntakeStep(1)
    document.getElementById('int-name')?.focus()
  } else if(intakeStep===3){
    // preserve step3 values before going back
    window._intakeStep3Values={}
    for(const [k] of INTAKE_FIELDS.filter(([k])=>!VC_KEYS.has(k))){
      window._intakeStep3Values[k]=(document.getElementById('int-'+k)||{}).value||''
    }
    showIntakeStep(2)
    // restore step2 VC values
    if(window._intakeStep2Values){ for(const [k,v] of Object.entries(window._intakeStep2Values)){ const el=document.getElementById('int-'+k); if(el) el.value=v } }
    updateVcFillBar()
    document.getElementById('int-species')?.focus()
  }
}
$('#intake-cancel').onclick=()=>{ clearDraft(); closeIntakeOvl() }
$('#intake-ovl').addEventListener('click',e=>{ if(e.target===$('#intake-ovl')) closeIntakeOvl() })
// Normalize SA phone number on blur: 0XXXXXXXXX -> +27XXXXXXXXX
const intPhoneEl=$('#int-phone')
if(intPhoneEl) intPhoneEl.addEventListener('blur',()=>{
  const v=intPhoneEl.value.trim()
  if(!v) return
  const d=v.replace(/[^0-9+]/g,'')
  if(/^0[0-9]{9}$/.test(d)){intPhoneEl.value='+27'+d.slice(1);intPhoneEl.style.borderColor='';return}
  if(/^27[0-9]{9}$/.test(d)){intPhoneEl.value='+'+d;intPhoneEl.style.borderColor='';return}
  if(/^[+]27[0-9]{9}$/.test(d)){intPhoneEl.style.borderColor='';return}
  intPhoneEl.style.borderColor='var(--danger,#c00)'
})
// Escape closes the overlay; Enter on input fields advances (Next) or submits (Save); Tab order is natural DOM order
document.addEventListener('keydown',e=>{
  if(!$('#intake-ovl').classList.contains('show')) return
  if(e.key==='Escape'){ e.preventDefault(); closeIntakeOvl(); return }
  if(e.key==='Enter'&&e.target.tagName==='INPUT'&&!e.defaultPrevented){
    e.preventDefault()
    const next=$('#intake-next'); const sub=$('#intake-submit')
    if(next&&next.style.display!=='none') next.click()
    else if(sub&&sub.style.display!=='none') sub.click()
  }
})
$('#intake-submit').onclick=async()=>{
  const btn=$('#intake-submit'); btn.disabled=true
  const errEl=$('#intake-error'); errEl.style.display='none'
  try{
    let caseId=intakeCaseId
    if(!caseId){
      const rawPhone=$('#int-phone').value.trim()
      if(rawPhone){
        const digits=rawPhone.replace(/[^0-9+]/g,'')
        if(!/^0[0-9]{9}$/.test(digits)&&!/^[+]27[0-9]{9}$/.test(digits)){
          errEl.textContent='Phone must be a South African number: 0821234567 or +27821234567'
          errEl.style.display=''; btn.disabled=false; return
        }
      }
      // create new case
      const body={
        name:$('#int-name').value.trim(),
        phone:rawPhone,
        subject:$('#int-subject').value.trim()||'Field report'
      }
      const r=await api('/api/cases',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      if(r.status===409){
        const e=await r.json().catch(()=>({}))
        btn.disabled=false
        const dlg=await showDialog({title:'Case already exists',message:(e.error||'A case already exists for this contact')+' ('+esc(e.existing_ref||'')+').',confirmLabel:'Open existing case',cancelLabel:'Cancel'})
        if(dlg){ $('#intake-ovl').classList.remove('show'); intakeCaseId=null; await openCase(e.existing_id) }
        return
      }
      if(!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(e.error||'Failed to create case') }
      const j=await r.json(); caseId=j.id
    }
    // gather report fields (skip blanks)
    // For new cases: VC fields in _intakeStep2Values, additional in DOM (step3); edit mode all in DOM.
    const report={}
    const step2Saved=window._intakeStep2Values||{}
    for(const [k] of INTAKE_FIELDS){
      const domEl=document.getElementById('int-'+k)
      const v=domEl ? domEl.value : (step2Saved[k]||'')
      if(v.trim()) report[k]=v.trim()
    }
    if(Object.keys(report).length){
      const r2=await api('/api/cases/'+encodeURIComponent(caseId)+'/intake',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(report)})
      if(!r2.ok){ const e=await r2.json().catch(()=>({})); throw new Error(e.error||'Failed to save report - your data is preserved, please try again') }
    }
    const wasEdit=!!intakeCaseId
    if(!wasEdit) clearDraft()
    $('#intake-ovl').classList.remove('show'); intakeCaseId=null
    toast(wasEdit?'Report updated':'Case created','ok')
    lastCasesJson=''; await loadCases(); await openCase(caseId)
  } catch(e){
    errEl.textContent=e.message
    errEl.style.display=''
    // ensure draft is saved so data is not lost on error
    saveDraft()
  }
  btn.disabled=false
}
$('#new-case-btn').onclick=()=>openIntakeForm(null)
// --- export CSV (fetch via api() so the login session cookie rides along, then save as blob) ---
// Note: the server CSV already has an intake_source column; if a source filter is
// active the filename suffix reminds the operator that the export is unfiltered.
$('#export-btn').onclick=async()=>{
  const params=new URLSearchParams()
  if(filt.status) params.set('status',filt.status)
  if(filt.channel) params.set('channel',filt.channel)
  if(filt.source) toast('Note: CSV export includes all sources; intake_source column lets you filter in your spreadsheet','ok')
  const url='/api/cases/export.csv'+(params.toString()?'?'+params.toString():'')
  try{
    const r=await api(url)
    if(!r.ok){ toast('Export failed: '+r.status,'err'); return }
    const blob=await r.blob()
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='casey-cases.csv'
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    setTimeout(()=>URL.revokeObjectURL(a.href),5000)
  }catch(e){ toast('Export failed: '+e.message,'err') }
}
const sweepBtn=$('#sweep-btn')
if(sweepBtn) sweepBtn.onclick=async()=>{
  sweepBtn.disabled=true
  const r=await api('/api/sweep',{method:'POST'})
  sweepBtn.disabled=false
  if(r.status===501){ toast('Sweep not available in dashboard-only mode','err'); return }
  if(!r.ok){ toast(await failMsg(r,'sweep failed'),'err'); return }
  const j=await r.json().catch(()=>({}))
  toast('Sweep done'+(j.scanned!=null?' -- '+j.scanned+' checked, '+j.flagged+' flagged, '+j.cleared+' cleared':''),'ok')
  lastCasesJson=''; await loadCases(); refreshAttention()
}
// --- intake stats panel ---
let statsOpen=false
const statsBtn=$('#stats-btn')
const statsPanel=$('#stats-panel')
async function loadStats(){
  const grid=$('#stats-grid'); if(!grid) return
  grid.innerHTML='<div class="empty" style="grid-column:1/-1;padding:8px 0">Loading...</div>'
  try{
    const j=await api('/api/stats').then(r=>r.ok?r.json():null)
    if(!j){ grid.innerHTML='<div class="empty" style="grid-column:1/-1">Could not load stats.</div>'; return }
    const MODE_LABEL={channel:'AI (channel)',manual:'Operator entry',public_form:'Public form',unknown:'Untagged'}
    if(!Object.keys(j.by_mode).length){ grid.innerHTML='<div class="empty" style="grid-column:1/-1">No data yet.</div>'; return }
    grid.innerHTML=Object.entries(j.by_mode).map(([mode,s])=>{
      const vcPct=s.vc_total?Math.round(s.vc_complete/s.count*100):0
      return \`<div class="stats-card">
        <div class="sc-mode">\${esc(MODE_LABEL[mode]||mode)}</div>
        <div class="sc-count">\${s.count}</div>
        <div class="sc-detail">avg \${s.avg_filled??'-'}/\${s.total_fields} fields filled</div>
        <div class="sc-vc">\${s.vc_complete}/\${s.count} visit-ready (\${vcPct}%)</div>
        <div class="sc-detail">avg \${s.avg_vc_filled??'-'}/\${s.vc_total} essential</div>
      </div>\`
    }).join('')
  }catch(e){ grid.innerHTML='<div class="empty" style="grid-column:1/-1">Stats error: '+esc(e.message)+'</div>' }
}
if(statsBtn) statsBtn.onclick=async()=>{
  statsOpen=!statsOpen
  statsPanel.classList.toggle('show',statsOpen)
  statsBtn.classList.toggle('active',statsOpen)
  if(statsOpen) await loadStats()
}
// --- tunable health thresholds (plain-language settings) ---
// Each scalar threshold is stored in ms; operators tune it in hours. The label
// and help text are plain words so a non-technical team can retune the windows.
const THRESH_META={
  handoffMs:['Wait after a contact asks for a person','How long to wait before flagging that nobody has stepped in yet.'],
  escalateHandoffMs:['Escalate an unanswered handoff','After this long with no human reply, the case is raised more urgently.'],
  staleMs:['No activity at all','How long a case can go quiet before it is flagged as going stale.'],
  abandonMs:['Half-finished intake left sitting','A case that started but never finished gathering details is flagged after this.'],
  incompleteCriticalMs:['Missing essential visit details','How long an actionable case may lack must-have fields before flagging.'],
  neverClosedMs:['Open far too long','A case still open past this is surfaced as overdue.'],
  unsentDraftMs:['Unsent AI draft waiting','How long an assisted draft can wait for an operator before it is flagged.'],
}
let settingsOpen=false
const settingsBtn=$('#settings-btn')
const settingsPanel=$('#settings-panel')
function hoursOf(ms){ return Math.round((ms/3600000)*10)/10 }
async function loadThresholds(){
  const body=$('#settings-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  try{
    const j=await api('/api/thresholds').then(r=>r.ok?r.json():null)
    if(!j){ body.innerHTML='<div class="empty">Could not load settings.</div>'; return }
    const t=j.thresholds||{}
    const rows=Object.keys(THRESH_META).filter(k=>t[k]!=null).map(k=>{
      const [lab,help]=THRESH_META[k]
      return '<div class="set-row"><label>'+esc(lab)+'</label>'
        +'<div class="set-in"><input type="number" min="0" step="0.5" data-key="'+esc(k)+'" value="'+hoursOf(t[k])+'"> <span>hours</span></div>'
        +'<p class="hint">'+esc(help)+'</p></div>'
    }).join('')
    body.innerHTML=rows+'<button id="settings-save">Save</button>'
      +'<span class="set-state">'+(j.customized?'Using your tuned values':'Using the shipped defaults')+'</span>'
    const save=$('#settings-save')
    if(save) save.onclick=async()=>{
      save.disabled=true
      const patch={}
      body.querySelectorAll('input[data-key]').forEach(inp=>{
        const v=parseFloat(inp.value); if(Number.isFinite(v)) patch[inp.dataset.key]=Math.round(v*3600000)
      })
      const r=await api('/api/thresholds',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(patch)})
      save.disabled=false
      if(!r.ok){ toast(await failMsg(r,'save failed'),'err'); return }
      toast('settings saved','ok'); await loadThresholds()
    }
  }catch(e){ body.innerHTML='<div class="empty">Settings error: '+esc(e.message)+'</div>' }
}
if(settingsBtn) settingsBtn.onclick=async()=>{
  settingsOpen=!settingsOpen
  settingsPanel.classList.toggle('show',settingsOpen)
  settingsBtn.classList.toggle('active',settingsOpen)
  if(settingsOpen) await loadThresholds()
}
// --- Metrics / Outbreaks / Hotspots panels ---
function fmtDur(ms){ if(ms==null) return '--'; const s=Math.round(ms/1000); const m=Math.round(s/60); if(m<60) return m+'m'; const h=Math.round(m/60); if(h<48) return h+'h'; return Math.round(h/24)+'d' }
const STAGE_LABELS_M={new:'New',triaging:'Triage',in_progress:'In progress',waiting:'Waiting',resolved:'Resolved',closed:'Closed'}
function loadMetricsHtml(j){
  const fr=j.first_response_ms||{}
  const dwell=j.dwell_ms_median||{}, backlog=j.backlog_by_stage||{}
  const card=(lab,val,sub)=>'<div class="stats-card"><div class="sc-mode">'+esc(lab)+'</div><div class="sc-count">'+esc(val)+'</div>'+(sub?'<div class="sc-detail">'+esc(sub)+'</div>':'')+'</div>'
  const dwellRows=Object.keys(dwell).map(s=>card(STAGE_LABELS_M[s]||s,fmtDur(dwell[s]),'median dwell')).join('')
  const backlogRows=Object.keys(backlog).map(s=>card(STAGE_LABELS_M[s]||s,backlog[s],'open now')).join('')
  // opened-vs-closed sparklines over the per-day buckets
  const days=Object.keys(Object.assign({},j.opened_by_day,j.closed_by_day)).sort()
  const opened=days.map(d=>j.opened_by_day[d]||0), closed=days.map(d=>j.closed_by_day[d]||0)
  const trend=days.length
    ? '<div class="metric-trend"><div>Opened per day '+sparkline(opened,160,28)+' <b>'+opened.reduce((a,b)=>a+b,0)+'</b></div>'
      +'<div>Closed per day '+sparkline(closed,160,28)+' <b>'+closed.reduce((a,b)=>a+b,0)+'</b></div></div>'
    : ''
  return '<div class="stats-grid">'
    +card('Median first reply',fmtDur(fr.median),'p90 '+fmtDur(fr.p90)+' ('+(fr.n||0)+' answered)')
    +card('Open',j.cases?j.cases.open:0,'cases')
    +card('Closed',j.cases?j.cases.closed:0,'cases')
    +dwellRows+backlogRows+'</div>'+trend
}
const CASE_TYPE_LABEL={unset:'Unclassified',outbreak:'Outbreak',follow_up:'Follow-up',lab_sample:'Lab sample',import_alert:'Import alert'}
function ctLabel(t){ return CASE_TYPE_LABEL[t]||t }
function slaMetPct(s){ return s&&s.considered?Math.round((s.met_count||0)/s.considered*100)+'%':'--' }
function slaRow(label,s,m,cls){
  const late=(s&&s.breached_by_reason&&s.breached_by_reason.answered_late)
  const never=(s&&s.breached_by_reason&&s.breached_by_reason.never_answered)
  return '<tr'+(cls?' class="'+cls+'"':'')+'><td>'+label+'</td><td>'+esc(s&&s.considered!=null?s.considered:'--')+'</td><td>'+esc(slaMetPct(s))
    +'</td><td>'+esc(late!=null?late:'--')+'</td><td>'+esc(never!=null?never:'--')
    +'</td><td>'+fmtDur(m?m.first_response_ms_median:null)+'</td><td>'+esc(m&&m.closed_pct!=null?m.closed_pct+'%':'--')+'</td></tr>'
}
function byTypeHtml(rep){
  const sbt=(rep&&rep.sla_by_type&&rep.sla_by_type.by_type)||{}
  const ov=(rep&&rep.sla_by_type&&rep.sla_by_type.overall)||null
  const met=(rep&&rep.by_case_type)||{}
  const types=Array.from(new Set([...Object.keys(sbt),...Object.keys(met)]))
  if(!types.length) return ''
  const rows=types.map(t=>slaRow(esc(ctLabel(t)),sbt[t],met[t])).join('')
  const ovRow=ov?slaRow('<b>Overall</b>',ov,null,'bt-overall'):''
  return '<div class="bt-sec"><div class="ho-h">By case type</div>'
    +'<table class="bt-table"><thead><tr><th>Type</th><th>Cases</th><th>SLA met</th><th>Late</th><th>Never</th><th>1st reply</th><th>Closed</th></tr></thead>'
    +'<tbody>'+rows+ovRow+'</tbody></table></div>'
}
function atRiskByTypeHtml(j){
  // /api/sla-at-risk/by-type returns by_type[t] as a plain count (atRiskCount).
  const bt=(j&&j.by_type)||{}
  const types=Object.keys(bt).filter(t=>(bt[t]||0)>0)
  if(!types.length) return ''
  const tgt=j.sla_target_ms!=null?fmtDur(j.sla_target_ms):''
  const chips=types.sort((a,b)=>(bt[b]||0)-(bt[a]||0)).map(t=>
    '<span class="risk-chip" title="open cases of this type within reach of the '+esc(tgt)+' reply target">'+esc(ctLabel(t))+' <b>'+esc(bt[t])+'</b></span>').join(' ')
  return '<div class="bt-sec"><div class="ho-h">At risk now (reply target '+esc(tgt)+')</div><div class="risk-strip">'+chips+'</div></div>'
}
async function loadMetrics(){
  const body=$('#metrics-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  try{ const j=await api('/api/overview?days=14').then(r=>r.ok?r.json():null)
    const rep=await api('/api/report.json?days=14').then(r=>r.ok?r.json():null).catch(()=>null)
    const risk=await api('/api/sla-at-risk/by-type').then(r=>r.ok?r.json():null).catch(()=>null)
    body.innerHTML=(j?loadMetricsHtml(j):'<div class="empty">Could not load metrics.</div>')
      +(risk?atRiskByTypeHtml(risk):'')+(rep?byTypeHtml(rep):'')
  }catch(e){ body.innerHTML='<div class="empty">Metrics error: '+esc(e.message)+'</div>' }
}
function clustersHtml(j){
  const cl=j.clusters||[]
  if(!cl.length) return '<div class="empty" style="padding:8px 0">No related-looking groups right now.</div>'
  return cl.map(c=>{
    const loc=(c.location||[]).join(', '), sp=(c.species||[]).join(', '), sym=(c.symptoms||[]).join(', ')
    const reported=(c.reported_disease_names||[]).join(', ')
    const chips=(c.members||[]).map(m=>'<button class="ref-chip" data-id="'+esc(m.id)+'" title="'+esc((m.case_type&&m.case_type!=='unset'?m.case_type+': ':'')+(m.subject||''))+'">'+esc(m.ref)+'</button>').join(' ')
    const sev=(c.severity!=null)?'<span class="cl-sev" title="Suspected-outbreak severity: member count scaled by case_type mix (outbreak>import_alert>lab_sample>follow_up)">severity '+esc(c.severity)+'</span> ':''
    // symptoms is what was actually seen/reported -- shown plainly. reported_disease_names
    // is only ever the farmer/worker's own unverified guess, so it is always qualified
    // "as reported" and never rendered as if it were a determined diagnosis.
    return '<div class="cl-row"><div class="cl-head">'+sev+'<b>'+c.count+' cases</b>'
      +(loc?' near '+esc(loc):'')+(sp?' -- '+esc(sp):'')+'</div>'
      +(sym?'<div class="cl-sub">symptoms: '+esc(sym)+'</div>':'')
      +(reported?'<div class="cl-sub" title="Named by the worker/farmer, not a lab result">as reported: '+esc(reported)+'</div>':'')
      +'<div class="cl-chips">'+chips+'</div></div>'
  }).join('')
}
async function loadClusters(){
  const body=$('#clusters-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  try{ const j=await api('/api/clusters').then(r=>r.ok?r.json():null)
    body.innerHTML=j?clustersHtml(j):'<div class="empty">Could not load outbreaks.</div>'
    body.querySelectorAll('.ref-chip').forEach(b=>b.onclick=()=>openCase(b.dataset.id))
  }catch(e){ body.innerHTML='<div class="empty">Outbreaks error: '+esc(e.message)+'</div>' }
}
function geoHtml(j){
  const places=j.places||[]
  if(!places.length) return '<div class="empty" style="padding:8px 0">No location data yet.</div>'
  return '<div class="geo-list">'+places.map(p=>{
    const mix=Object.entries(p.species||{}).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([s,n])=>esc(s)+' x'+n).join(', ')
    return '<div class="geo-row"><span class="geo-place">'+esc(p.place)+'</span>'
      +'<span class="geo-count">'+p.count+'</span>'
      +'<span class="geo-mix">'+(mix||'--')+'</span>'
      +'<span class="geo-when">'+esc(p.latest?fmtTime(p.latest):'')+'</span></div>'
  }).join('')+'</div>'
}
async function loadGeo(){
  const body=$('#geo-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  try{ const j=await api('/api/geo').then(r=>r.ok?r.json():null)
    body.innerHTML=j?geoHtml(j):'<div class="empty">Could not load hotspots.</div>'
  }catch(e){ body.innerHTML='<div class="empty">Hotspots error: '+esc(e.message)+'</div>' }
}
function panelToggle(btnId,panelId,loader){
  const btn=$(btnId), panel=$(panelId); let open=false
  if(btn) btn.onclick=async()=>{ open=!open; panel.classList.toggle('show',open); btn.classList.toggle('active',open); if(open) await loader() }
}
panelToggle('#metrics-btn','#metrics-panel',loadMetrics)
panelToggle('#clusters-btn','#clusters-panel',loadClusters)
panelToggle('#geo-btn','#geo-panel',loadGeo)
panelToggle('#map-btn','#map-panel',loadMap)

// --- Case map (Leaflet + OSM tiles, no API key) ---
const STATUS_COLOR={new:'#3b6ea5',triaging:'#a5843b',in_progress:'#3ba55d',waiting:'#9a6bd1',resolved:'#6b7685',closed:'#3d4148'}
let mapState=null   // { map, markerLayer, clusterLines, coverageLayer, pins, clusters, showCoverage, showClusters }
function mapMarkerIcon(color){
  return window.L.divIcon({className:'',html:'<div style="width:14px;height:14px;border-radius:50%;background:'+color+';border:2px solid rgba(255,255,255,.8);box-shadow:0 0 2px rgba(0,0,0,.5)"></div>',iconSize:[14,14]})
}
function mapPopupHtml(p){
  const counts=[p.affected_count!=null?p.affected_count+' affected':'',p.dead_count!=null?p.dead_count+' dead':''].filter(Boolean).join(', ')
  return '<div><b>'+esc(p.ref)+'</b> <span style="color:var(--muted)">'+esc(p.status)+'</span><br>'
    +(p.species?esc(p.species)+'<br>':'')
    +(p.case_type&&p.case_type!=='unset'?esc(p.case_type)+'<br>':'')
    +(p.location?esc(p.location)+'<br>':'')
    +(p.symptoms?'<span title="As reported/observed">symptoms: '+esc(p.symptoms)+'</span><br>':'')
    +(counts?esc(counts)+'<br>':'')
    +(p.onset?'onset: '+esc(p.onset)+'<br>':'')
    +(p.assignee&&p.assignee!=='agent'?'assigned: '+esc(p.assignee)+'<br>':'')
    +'<a href="#" data-open-ref="'+esc(p.id)+'">Open case</a></div>'
}
function applyMapFilters(pins){
  const sp=$('#map-species')?.value||'', ty=$('#map-type')?.value||'', st=$('#map-status')?.value||''
  return pins.filter(p=>
    (!sp||String(p.species||'').toLowerCase().includes(sp.toLowerCase()))
    && (!ty||p.case_type===ty)
    && (!st||p.status===st))
}
function renderMapMarkers(){
  if(!mapState) return
  const {map}=mapState
  if(mapState.markerLayer) map.removeLayer(mapState.markerLayer)
  if(mapState.clusterLines) map.removeLayer(mapState.clusterLines)
  const filtered=applyMapFilters(mapState.pins)
  const layer=window.L.markerClusterGroup({maxClusterRadius:40})
  for(const p of filtered){
    const m=window.L.marker([p.lat,p.lon],{icon:mapMarkerIcon(STATUS_COLOR[p.status]||'#6b7685')})
    m.bindPopup(mapPopupHtml(p))
    m.on('popupopen',()=>{
      const el=document.querySelector('[data-open-ref="'+p.id+'"]')
      if(el) el.onclick=(e)=>{e.preventDefault(); openCase(p.id)}
    })
    layer.addLayer(m)
  }
  map.addLayer(layer)
  mapState.markerLayer=layer
  if(mapState.showClusters){
    const lines=window.L.layerGroup()
    const byIdx=new Map()
    for(const p of filtered){ if(p.cluster==null) continue; if(!byIdx.has(p.cluster)) byIdx.set(p.cluster,[]); byIdx.get(p.cluster).push(p) }
    for(const [,members] of byIdx){
      if(members.length<2) continue
      for(let i=1;i<members.length;i++){
        window.L.polyline([[members[0].lat,members[0].lon],[members[i].lat,members[i].lon]],{color:'#c0392b',weight:1,opacity:.5,dashArray:'4,4'}).addTo(lines)
      }
    }
    lines.addTo(map)
    mapState.clusterLines=lines
  }
}
async function loadMap(){
  const canvas=$('#map-canvas'); if(!canvas) return
  try{
    const days=$('#map-days')?.value||'0'
    const j=await api('/api/map/cases?days='+encodeURIComponent(days)).then(r=>r.ok?r.json():null)
    if(!j){ canvas.innerHTML='<div class="empty">Could not load the map.</div>'; return }
    if(!mapState){
      canvas.innerHTML=''
      const map=window.L.map(canvas,{center:[-28.5,25],zoom:5})
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'(c) OpenStreetMap contributors'}).addTo(map)
      mapState={map,markerLayer:null,clusterLines:null,coverageLayer:null,workersLayer:null,pins:[],clusters:[],showCoverage:false,showClusters:false,showWorkers:false}
      $('#map-species').onchange=renderMapMarkers
      $('#map-type').onchange=renderMapMarkers
      $('#map-status').onchange=renderMapMarkers
      $('#map-days').onchange=loadMap
      $('#map-clusters-btn').onclick=()=>{ mapState.showClusters=!mapState.showClusters; $('#map-clusters-btn').classList.toggle('active',mapState.showClusters); renderMapMarkers() }
      $('#map-coverage-btn').onclick=async()=>{ mapState.showCoverage=!mapState.showCoverage; $('#map-coverage-btn').classList.toggle('active',mapState.showCoverage); await renderMapCoverage() }
      const workersBtn=$('#map-workers-btn')
      if(workersBtn) workersBtn.onclick=async()=>{ mapState.showWorkers=!mapState.showWorkers; workersBtn.classList.toggle('active',mapState.showWorkers); await renderMapWorkers() }
    }
    mapState.pins=j.pins||[]
    mapState.clusters=j.clusters||[]
    // Populate species/type/status filter options from the actual data, once.
    const spSel=$('#map-species'), tySel=$('#map-type'), stSel=$('#map-status')
    if(spSel && spSel.options.length<=1){
      const species=[...new Set(mapState.pins.map(p=>p.species).filter(Boolean))].sort()
      for(const s of species){ const o=document.createElement('option'); o.value=s; o.textContent=s; spSel.appendChild(o) }
    }
    if(tySel && tySel.options.length<=1){
      const types=[...new Set(mapState.pins.map(p=>p.case_type).filter(t=>t&&t!=='unset'))].sort()
      for(const t of types){ const o=document.createElement('option'); o.value=t; o.textContent=t; tySel.appendChild(o) }
    }
    if(stSel && stSel.options.length<=1){
      const statuses=[...new Set(mapState.pins.map(p=>p.status))].sort()
      for(const s of statuses){ const o=document.createElement('option'); o.value=s; o.textContent=s; stSel.appendChild(o) }
    }
    $('#map-legend').innerHTML=Object.entries(STATUS_COLOR).map(([k,c])=>
      '<span><span class="sw" style="background:'+c+'"></span>'+esc(k)+'</span>').join('')
    renderMapMarkers()
    const u=j.unresolved_count||0
    $('#map-unresolved').textContent = u
      ? u+' case(s) have no placeable location yet (no GPS, and location text did not match a known area) -- not shown on the map.'
      + (j.truncated ? ' Showing the most recent '+j.cap+' of '+j.total_considered+' considered.' : '')
      : (j.truncated ? 'Showing the most recent '+j.cap+' of '+j.total_considered+' considered.' : '')
    // The unresolved rows carry real report content (species/symptoms/location text)
    // even without a coordinate -- surface them as a list, not just a count, so an
    // operator can see WHAT each un-mapped report says rather than only how many exist.
    const listEl=$('#map-unresolved-list')
    if(listEl){
      listEl.innerHTML = (j.unresolved||[]).map(p=>
        '<div style="padding:3px 0;border-bottom:1px solid var(--border)">'
        +'<a href="#" data-open-ref="'+esc(p.id)+'"><b>'+esc(p.ref)+'</b></a> '
        +'<span style="color:var(--muted)">'+esc(p.status)+'</span>'
        +(p.species?' -- '+esc(p.species):'')
        +(p.location?' ('+esc(p.location)+')':'')
        +(p.symptoms?' -- '+esc(p.symptoms):'')
        +'</div>'
      ).join('')
      listEl.querySelectorAll('[data-open-ref]').forEach(a=>a.onclick=(e)=>{e.preventDefault(); openCase(a.dataset.openRef)})
    }
  }catch(e){ canvas.innerHTML='<div class="empty">Map error: '+esc(e.message)+'</div>' }
}
async function renderMapCoverage(){
  if(!mapState) return
  const {map}=mapState
  if(mapState.coverageLayer){ map.removeLayer(mapState.coverageLayer); mapState.coverageLayer=null }
  if(!mapState.showCoverage) return
  try{
    const j=await api('/api/operators/identities').then(r=>r.ok?r.json():null)
    if(!j) return
    const layer=window.L.layerGroup()
    // Approximate an operator's coverage centroid from the town-level tokens they
    // have acted on (matched back against the current map pins by location text) --
    // a soft circle per operator, radius scaled by how many distinct areas they cover.
    for(const idOp of (j.identities||[])){
      if(!idOp.areas || !idOp.areas.length) continue
      const matched=mapState.pins.filter(p=>p.location && idOp.areas.some(a=>String(p.location).toLowerCase().includes(a.token)))
      if(!matched.length) continue
      const lat=matched.reduce((s,p)=>s+p.lat,0)/matched.length
      const lon=matched.reduce((s,p)=>s+p.lon,0)/matched.length
      window.L.circle([lat,lon],{radius:25000,color:'#3b6ea5',weight:1,fillOpacity:.06})
        .bindTooltip(esc(idOp.name)+' -- '+idOp.case_count+' case action(s)')
        .addTo(layer)
    }
    layer.addTo(map)
    mapState.coverageLayer=layer
  }catch(e){ /* coverage overlay is a soft add-on -- a failure here must not break the map */ }
}
// Field-worker live-location layer (case_checkin self-reports, GET /api/map/workers).
// A fresh check-in renders solid; a stale one (past the tunable
// workerLocationStaleMs window) renders faded, so an operator can tell "here now"
// from "was here a while ago" at a glance rather than dispatching someone who has
// long since moved on.
async function renderMapWorkers(){
  if(!mapState) return
  const {map}=mapState
  if(mapState.workersLayer){ map.removeLayer(mapState.workersLayer); mapState.workersLayer=null }
  if(!mapState.showWorkers) return
  try{
    const j=await api('/api/map/workers').then(r=>r.ok?r.json():null)
    if(!j) return
    const layer=window.L.layerGroup()
    for(const w of (j.workers||[])){
      const label=esc(w.display_name||'field worker')+(w.stale?' (last seen '+esc(fmtTime(w.last_location_at))+')':' (here now)')
      window.L.circleMarker([w.lat,w.lon],{
        radius:8, color:'#e0a83b', weight:2, fillColor:'#e0a83b', fillOpacity:w.stale?0.15:0.7,
      }).bindTooltip(label).addTo(layer)
    }
    layer.addTo(map)
    mapState.workersLayer=layer
  }catch(e){ /* worker-location overlay is a soft add-on -- a failure here must not break the map */ }
}
// --- Activity / audit stream ---
const ACT_KIND_LABEL={inbound:'Inbound',outbound:'Reply',transition:'Stage change',note:'Note',observation:'Note',action:'Action',autonomy_change:'Autonomy'}
const ACT_ACTOR_LABEL={agent:'casey',operator:'Operator',contact:'Contact',system:'System'}
function activityHtml(j){
  const ev=j.events||[]
  if(!ev.length) return '<div class="empty" style="padding:8px 0">Nothing matches.</div>'
  return '<div class="act-list">'+ev.map(e=>
    '<div class="act-row" data-id="'+esc(e.case_id)+'">'
    +'<span class="act-when">'+esc(fmtTime(e.created_at))+'</span>'
    +'<span class="act-kind">'+esc(ACT_KIND_LABEL[e.kind]||e.kind)+'</span>'
    +'<span class="act-who">'+esc(ACT_ACTOR_LABEL[e.actor]||e.actor||'')+'</span>'
    +'<span class="act-text">'+esc((e.text||'').slice(0,160))+'</span></div>'
  ).join('')+'</div>'
}
async function loadActivity(){
  const body=$('#activity-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  const k=$('#act-kind')?$('#act-kind').value:'', a=$('#act-actor')?$('#act-actor').value:''
  const qs=new URLSearchParams(); if(k)qs.set('kind',k); if(a)qs.set('actor',a); qs.set('limit','100')
  try{ const j=await api('/api/activity?'+qs.toString()).then(r=>r.ok?r.json():null)
    body.innerHTML=j?activityHtml(j):'<div class="empty">Could not load activity.</div>'
    body.querySelectorAll('.act-row').forEach(r=>r.onclick=()=>{ if(r.dataset.id) openCase(r.dataset.id) })
  }catch(e){ body.innerHTML='<div class="empty">Activity error: '+esc(e.message)+'</div>' }
}
panelToggle('#activity-btn','#activity-panel',loadActivity)
if($('#act-kind')) $('#act-kind').onchange=loadActivity
if($('#act-actor')) $('#act-actor').onchange=loadActivity
// --- shift handover digest ---
function hoSection(title,rows,render){
  if(!rows||!rows.length) return '<div class="ho-sec"><div class="ho-h">'+esc(title)+'</div><div class="empty" style="padding:4px 0">None.</div></div>'
  return '<div class="ho-sec"><div class="ho-h">'+esc(title)+' <span class="n">'+rows.length+'</span></div>'+rows.map(render).join('')+'</div>'
}
function handoverHtml(j){
  const link=(ref,id)=>'<span class="ho-ref" data-id="'+esc(id||'')+'">'+esc(ref||'')+'</span>'
  const at=t=>t?esc(fmtTime(t)):''
  return '<div class="ho-since">Since '+(j.since?esc(fmtTime(j.since)):'the last day')+(j.since_by?' ('+esc(j.since_by)+')':'')+'</div>'
    +hoSection('Needs you now',j.attention,r=>'<div class="ho-row">'+link(r.ref,r.id)+' <span class="ho-sub">'+esc(r.subject||'(no subject)')+'</span> <span class="ho-why">'+esc(r.reason||'')+'</span>'+(r.assignee?' <span class="owner-chip">'+esc(r.assignee)+'</span>':'')+'</div>')
    +hoSection('Open handoffs',j.handoffs,r=>'<div class="ho-row">'+link(r.ref,r.id)+' <span class="ho-sub">'+esc(r.subject||'')+'</span> <span class="ho-why">'+esc(r.reason||'')+'</span></div>')
    +hoSection('Unsent drafts',j.drafts,r=>'<div class="ho-row">'+link(r.ref,r.id)+' <span class="ho-sub">'+esc(r.subject||'')+'</span> <span class="ho-why">'+esc((r.text||'').slice(0,120))+'</span></div>')
    +hoSection('Changed this shift',j.touched,r=>'<div class="ho-row">'+link(r.ref,r.id)+' <span class="ho-sub">'+esc(r.subject||'')+'</span> <span class="ho-why">'+esc(r.last_kind||'')+(r.last_actor?' by '+esc(r.last_actor):'')+'</span> <span class="act-when">'+at(r.at)+'</span></div>')
}
async function loadHandover(){
  const body=$('#handover-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  try{ const j=await api('/api/handover').then(r=>r.ok?r.json():null)
    body.innerHTML=j?handoverHtml(j):'<div class="empty">Could not load the handover digest.</div>'
    body.querySelectorAll('.ho-ref').forEach(r=>r.onclick=()=>{ if(r.dataset.id) openCase(r.dataset.id) })
  }catch(e){ body.innerHTML='<div class="empty">Handover error: '+esc(e.message)+'</div>' }
}
panelToggle('#handover-btn','#handover-panel',loadHandover)
const startShiftBtn=$('#start-shift-btn')
if(startShiftBtn) startShiftBtn.onclick=async()=>{
  startShiftBtn.disabled=true
  try{ const r=await api('/api/handover/start-shift',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
    if(r.ok){ toast('Shift started -- "changed this shift" counts from now','ok'); await loadHandover() }
    else toast('Could not start the shift','warn')
  }catch(e){ toast('Start-shift error: '+e.message,'warn') }
  startShiftBtn.disabled=false
}
// --- AI offline queue ---
function offlineHtml(j){
  const rows=j.items||[]
  if(!rows.length) return '<div class="empty" style="padding:8px 0">Nothing waiting -- casey is answering normally.</div>'
  return '<div class="act-list">'+rows.map(r=>
    '<div class="act-row off-row" data-id="'+esc(r.id)+'">'
    +'<span class="act-kind off-badge">AI offline</span>'
    +'<span class="ho-ref">'+esc(r.ref||'')+'</span>'
    +'<span class="act-text">'+esc(r.subject||'(no subject)')+'</span>'
    +'<span class="act-who">'+esc(r.channel||'')+'</span>'
    +(r.assignee&&r.assignee!=='agent'?'<span class="owner-chip">'+esc(r.assignee)+'</span>':'')
    +'<span class="act-when">'+esc(fmtTime(r.last_event_at))+'</span></div>'
  ).join('')+'</div>'
}
async function loadOffline(){
  const body=$('#offline-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  try{ const j=await api('/api/unreplied').then(r=>r.ok?r.json():null)
    body.innerHTML=j?offlineHtml(j):'<div class="empty">Could not load the offline queue.</div>'
    if($('#offline-btn')) $('#offline-btn').classList.toggle('has-queue',!!(j&&j.total))
    body.querySelectorAll('.off-row').forEach(r=>r.onclick=()=>{ if(r.dataset.id) openCase(r.dataset.id) })
  }catch(e){ body.innerHTML='<div class="empty">Offline-queue error: '+esc(e.message)+'</div>' }
}
panelToggle('#offline-btn','#offline-panel',loadOffline)
// --- team workload (who is holding what) ---
function teamHtml(j){
  const ops=(j&&j.operators)||[]
  if(!ops.length) return '<div class="empty" style="padding:8px 0">No operators configured -- set CASEY_OPERATORS to give people a name on their work.</div>'
  return '<div class="team-grid">'+ops.map(o=>
    '<div class="team-card'+(o.stale_claims>0?' team-stale':'')+'">'
    +'<div class="team-name">'+esc(o.name||o.id)+'</div>'
    +'<div class="team-stat"><span class="n">'+esc(String(o.open_assigned||0))+'</span> <span class="lbl">open</span></div>'
    +(o.stale_claims>0?'<div class="team-stat team-warn"><span class="n">'+esc(String(o.stale_claims))+'</span> <span class="lbl">sitting too long</span></div>':'')
    +'<div class="team-stat"><span class="n">'+esc(String(o.replies_24h||0))+'</span> <span class="lbl">replies today</span></div>'
    +'<div class="team-stat"><span class="n">'+esc(fmtDur(o.first_reply_ms_median))+'</span> <span class="lbl">usual first reply</span></div>'
    +'<div class="team-stat"><span class="n">'+esc(fmtDur(o.oldest_waiting_ms))+'</span> <span class="lbl">oldest waiting</span></div>'
    +'</div>'
  ).join('')+'</div>'
}
async function loadTeam(){
  const body=$('#team-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  try{ const j=await api('/api/operators/workload').then(r=>r.ok?r.json():null)
    body.innerHTML=j?teamHtml(j):'<div class="empty">Could not load the team view.</div>'
  }catch(e){ body.innerHTML='<div class="empty">Team-view error: '+esc(e.message)+'</div>' }
}
panelToggle('#team-btn','#team-panel',loadTeam)
// --- Contacts/Reporters panel: promote/demote the operator-assignable access tier ---
function contactsHtml(j){
  const contacts=(j&&j.contacts)||[]
  if(!contacts.length) return '<div class="empty" style="padding:8px 0">No one has reported yet.</div>'
  return '<table class="contacts-table" style="width:100%;font-size:13px"><thead><tr>'
    +'<th style="text-align:left">Who</th><th style="text-align:left">Channel</th><th style="text-align:left">Tier</th><th style="text-align:left">Last check-in</th><th></th>'
    +'</tr></thead><tbody>'+contacts.map(c=>{
      const isField=c.tier==='field_worker'
      const checkin=c.last_location_at?fmtTime(c.last_location_at):'never'
      return '<tr data-id="'+esc(c.id)+'">'
        +'<td>'+esc(c.display_name||c.external_id_masked)+'</td>'
        +'<td>'+esc(c.channel||'')+'</td>'
        +'<td>'+(isField?'<span class="owner-chip mine">field worker</span>':'<span class="owner-chip">reporter</span>')+'</td>'
        +'<td>'+esc(checkin)+'</td>'
        +'<td><button class="icon-btn contact-tier-toggle" data-id="'+esc(c.id)+'" data-to="'+(isField?'reporter':'field_worker')+'">'+(isField?'Demote':'Promote')+'</button></td>'
        +'</tr>'
    }).join('')+'</tbody></table>'
}
async function loadContacts(){
  const body=$('#contacts-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  try{
    const j=await api('/api/contacts').then(r=>r.ok?r.json():null)
    body.innerHTML=j?contactsHtml(j):'<div class="empty">Could not load reporters.</div>'
    body.querySelectorAll('.contact-tier-toggle').forEach(btn=>{
      btn.onclick=async()=>{
        const id=btn.dataset.id, to=btn.dataset.to
        btn.disabled=true
        try{
          const r=await api('/api/contacts/'+encodeURIComponent(id)+'/tier',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tier:to})})
          if(!r.ok){ const err=await r.json().catch(()=>({})); toast(err.error||'Could not change tier','err'); btn.disabled=false; return }
          toast(to==='field_worker'?'Promoted to field worker':'Demoted to reporter','ok')
          loadContacts()
        }catch(e){ toast('Could not change tier: '+e.message,'err'); btn.disabled=false }
      }
    })
  }catch(e){ body.innerHTML='<div class="empty">Reporters error: '+esc(e.message)+'</div>' }
}
panelToggle('#contacts-btn','#contacts-panel',loadContacts)
// --- bulk toolbar wiring ---
;(function wireBulk(){
  const stageSel=$('#bulk-stage')
  if(stageSel){ stageSel.innerHTML='<option value="">Move to...</option>'+CASEY_STAGES.map(s=>'<option value="'+s+'">'+esc(STAGE_LABEL[s]||s)+'</option>').join('') }
  const all=$('#bulk-all')
  if(all) all.onclick=()=>{ const shown=allCases.filter(matchesFull); if(all.checked) shown.forEach(c=>selectedIds.add(c.id)); else shown.forEach(c=>selectedIds.delete(c.id)); renderListFull() }
  const claim=$('#bulk-claim'); if(claim) claim.onclick=()=>bulkAction('claim')
  if(stageSel) stageSel.onchange=()=>{ const to=stageSel.value; if(!to) return; bulkAction('transition',{to}); stageSel.value='' }
  const tag=$('#bulk-tag'); if(tag) tag.onclick=async()=>{ const dlg=await showDialog({title:'Tag selected cases',inputLabel:'Tag to add',inputPlaceholder:'e.g. follow-up',confirmLabel:'Add tag'}); if(dlg&&dlg.value.trim()) bulkAction('tag',{tag:dlg.value.trim()}) }
  const untag=$('#bulk-untag'); if(untag) untag.onclick=async()=>{ const dlg=await showDialog({title:'Untag selected cases',inputLabel:'Tag to remove',inputPlaceholder:'e.g. follow-up',confirmLabel:'Remove tag'}); if(dlg&&dlg.value.trim()) bulkAction('untag',{tag:dlg.value.trim()}) }
  const note=$('#bulk-note'); if(note) note.onclick=async()=>{ const dlg=await showDialog({title:'Add a note to selected cases',inputLabel:'Note',inputPlaceholder:'Visible on each timeline',confirmLabel:'Add note'}); if(dlg&&dlg.value.trim()) bulkAction('note',{text:dlg.value.trim()}) }
  const draftApprove=$('#bulk-draft-approve'); if(draftApprove) draftApprove.onclick=async()=>{ const dlg=await showDialog({title:'Send selected drafts?',message:'Each selected case with a pending draft sends it to the contact exactly as composed. A case with no pending draft is skipped.',confirmLabel:'Send drafts',danger:true}); if(dlg) bulkAction('draft_approve') }
  const draftDiscard=$('#bulk-draft-discard'); if(draftDiscard) draftDiscard.onclick=async()=>{ const dlg=await showDialog({title:'Discard selected drafts?',message:'Each selected case with a pending draft has it discarded, unsent. A case with no pending draft is skipped.',confirmLabel:'Discard drafts',danger:true}); if(dlg) bulkAction('draft_discard') }
  const clr=$('#bulk-clear'); if(clr) clr.onclick=clearSelection
})()
// --- who-am-i badge (login replaces the old cooperative operator picker) ---
// selectedOperator used to be a self-picked dropdown value (cooperative
// attribution, anyone could claim to be anyone); it is now simply the logged-
// in account's own username -- a real identity from the session, not a guess.
function initWhoAmI(){
  const sel=$('#op-picker'); if(!sel || !currentUser) return
  sel.outerHTML='<span id="whoami-badge" style="margin-left:8px" title="Logged in">'
    +esc(currentUser.display_name||currentUser.username)
    +' <a href="#" id="logout-link" style="margin-left:6px">log out</a>'
    +' <a href="#" id="logout-everywhere-link" style="margin-left:6px" title="Sign out any other device or browser tab using this account">log out everywhere</a></span>'
  const lo=$('#logout-link'); if(lo) lo.onclick=(e)=>{ e.preventDefault(); doLogout() }
  const loe=$('#logout-everywhere-link'); if(loe) loe.onclick=(e)=>{ e.preventDefault(); doLogoutEverywhere() }
}
// Inline modal replacement for native prompt()/confirm() -- works on mobile/PWA.
// Uses DOM creation (not innerHTML) to avoid conflicts with the outer template literal.
// Returns a Promise resolving to {value, confirmed:true} or null if cancelled.
function showSplitDialog(evList, caseRef){
  return new Promise(function(resolve){
    function mk(tag, css, txt){ const el=document.createElement(tag); if(css) el.style.cssText=css; if(txt!=null) el.textContent=txt; return el }
    const overlay=mk('div','position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:500;display:flex;align-items:center;justify-content:center;padding:16px')
    overlay.setAttribute('role','dialog'); overlay.setAttribute('aria-modal','true')
    const card=mk('div','background:var(--panel);border:1px solid var(--border);border-radius:10px;max-width:520px;width:100%;padding:22px 24px;box-shadow:0 8px 40px rgba(0,0,0,.5);font-size:14px;max-height:80vh;overflow:auto')
    card.appendChild(mk('h3','margin:0 0 6px;font-size:16px','Split case '+caseRef))
    card.appendChild(mk('p','margin:0 0 10px;color:var(--muted);line-height:1.5','Select events to move into a new case. The rest stay here.'))
    const subLab=mk('label','display:block;margin:0 0 4px;font-size:12px;color:var(--muted)','Subject for new case (optional)')
    card.appendChild(subLab)
    const subInp=document.createElement('input'); subInp.type='text'; subInp.placeholder='e.g. sheep Upington outbreak'
    subInp.style.cssText='width:100%;background:var(--panel);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 8px;font-size:14px;box-sizing:border-box;margin-bottom:10px'
    card.appendChild(subInp)
    const evLab=mk('label','display:block;margin:0 0 6px;font-size:12px;color:var(--muted)','Events to move:')
    card.appendChild(evLab)
    const evBox=mk('div','border:1px solid var(--border);border-radius:6px;padding:6px;max-height:220px;overflow-y:auto;margin-bottom:10px')
    const checkboxes=[]
    evList.forEach(function(e){
      const row=mk('div','display:flex;align-items:flex-start;gap:6px;padding:4px 2px;border-bottom:1px solid var(--border)')
      const cb=document.createElement('input'); cb.type='checkbox'; cb.value=e.id; cb.style.cssText='margin-top:3px;flex-shrink:0'
      checkboxes.push(cb)
      const label=mk('span','font-size:12px;color:var(--fg);line-height:1.4','['+e.kind+'] '+(e.text||'').slice(0,120))
      row.appendChild(cb); row.appendChild(label); evBox.appendChild(row)
    })
    card.appendChild(evBox)
    const reasonLab=mk('label','display:block;margin:0 0 4px;font-size:12px;color:var(--muted)','Reason (optional)')
    card.appendChild(reasonLab)
    const reasonInp=document.createElement('textarea'); reasonInp.rows=2; reasonInp.placeholder='e.g. different species, separate location'
    reasonInp.style.cssText='width:100%;background:var(--panel);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 8px;font-size:14px;box-sizing:border-box;resize:vertical'
    card.appendChild(reasonInp)
    const row=mk('div','display:flex;gap:8px;margin-top:14px;justify-content:flex-end')
    const cancelBtn=mk('button','background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px;margin:0','Cancel')
    const okBtn=mk('button','background:var(--accent);color:#fff;border:0;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px;margin:0','Split case')
    row.appendChild(cancelBtn); row.appendChild(okBtn); card.appendChild(row)
    overlay.appendChild(card); document.body.appendChild(overlay)
    const close=function(confirmed){
      overlay.remove()
      if(!confirmed){ resolve(null); return }
      const event_ids=checkboxes.filter(cb=>cb.checked).map(cb=>cb.value)
      if(!event_ids.length){ resolve(null); return }
      resolve({event_ids,subject:subInp.value.trim(),reason:reasonInp.value.trim()})
    }
    okBtn.onclick=function(){ close(true) }
    cancelBtn.onclick=function(){ close(false) }
    overlay.addEventListener('keydown',function(e){ if(e.key==='Escape') close(false) })
    setTimeout(function(){ subInp.focus() }, 60)
  })
}
function showDialog(opts){
  const { title='', message='', inputLabel='', inputPlaceholder='', confirmLabel='OK', cancelLabel='Cancel', danger=false } = opts || {}
  return new Promise(function(resolve){
    function mk(tag, css, txt){ const el=document.createElement(tag); if(css) el.style.cssText=css; if(txt!=null) el.textContent=txt; return el }
    const overlay=mk('div','position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:500;display:flex;align-items:center;justify-content:center;padding:16px')
    overlay.setAttribute('role','dialog'); overlay.setAttribute('aria-modal','true')
    const card=mk('div','background:var(--panel);border:1px solid var(--border);border-radius:10px;max-width:420px;width:100%;padding:22px 24px;box-shadow:0 8px 40px rgba(0,0,0,.5);font-size:14px')
    if(title){ const h=mk('h3','margin:0 0 8px;font-size:16px',title); card.appendChild(h) }
    if(message){ const p=mk('p','margin:0 0 10px;color:var(--muted);line-height:1.5',message); card.appendChild(p) }
    let inp=null
    if(inputLabel){
      const lab=mk('label','display:block;margin:0 0 4px;font-size:12px;color:var(--muted)',inputLabel); card.appendChild(lab)
      inp=document.createElement('textarea'); inp.rows=2; inp.placeholder=inputPlaceholder
      inp.style.cssText='width:100%;background:var(--panel);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 8px;font-size:14px;box-sizing:border-box;resize:vertical'
      card.appendChild(inp)
    }
    const row=mk('div','display:flex;gap:8px;margin-top:14px;justify-content:flex-end')
    const cancelBtn=mk('button','background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px;margin:0',cancelLabel)
    const okBtn=mk('button','background:'+(danger?'var(--danger)':'var(--accent)')+';color:#fff;border:0;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px;margin:0',confirmLabel)
    row.appendChild(cancelBtn); row.appendChild(okBtn); card.appendChild(row)
    overlay.appendChild(card); document.body.appendChild(overlay)
    const close=function(confirmed, value){ overlay.remove(); resolve(confirmed?{value:value||'',confirmed:true}:null) }
    okBtn.onclick=function(){ close(true, inp?inp.value:'') }
    cancelBtn.onclick=function(){ close(false) }
    overlay.addEventListener('keydown',function(e){ if(e.key==='Escape') close(false); if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){ e.preventDefault(); close(true,inp?inp.value:'') } })
    setTimeout(function(){ if(inp) inp.focus(); else okBtn.focus() }, 60)
  })
}
// Apply the focus-mode body class and keep the #inbox hash in sync. Returns the
// effective mode so callers can branch their first paint.
function applyInboxMode(){
  document.body.classList.toggle('inbox-mode', inboxMode)
  return inboxMode
}
function setInboxMode(on){
  inboxMode = !!on
  // Preserve any deep-link hash already present (e.g. #case=...) by only
  // adding/removing the inbox token, never clobbering the rest.
  const rest = (location.hash||'').replace(/^#/,'').split('&').filter(p=>p&&p!=='inbox')
  if(inboxMode) rest.unshift('inbox')
  const want = rest.length ? '#'+rest.join('&') : location.pathname+location.search
  if(location.hash !== (rest.length?'#'+rest.join('&'):'')) history.replaceState(null,'',want)
  applyInboxMode()
  renderTriage()
  // Leaving focus mode needs the full list it skipped at boot.
  if(!inboxMode && !allCases.length) loadCases()
}
async function boot(){
  // A shared '#view=' link restores its full filter set before the first list
  // load, so the case list arrives already filtered (no flash of all-cases).
  const hv=viewFromHash()
  if(hv){
    filt.q=String(hv.q||''); const qel=$('#q'); if(qel) qel.value=filt.q
    filt.status=String(hv.status||''); filt.channel=String(hv.channel||''); filt.source=String(hv.source||'')
    mineOnly=!!hv.mine; const mb=$('#mine-btn'); if(mb) mb.classList.toggle('active',mineOnly)
    inboxMode=!!hv.focus
  }
  applyInboxMode()
  // In focus mode skip the heavy ~200-row case poll entirely; the ranked
  // attention list is the whole screen and comes from /api/attention.
  if(!inboxMode) await loadCases()
  await refreshHealth(); refreshAttention()
  const id=restoreFromHash(); if(id){ openCase(id); return }
  await restoreRefFromHash()
}
// Login gate: the app shell (search bar, list, inbox) stays in the DOM but
// hidden behind a full-screen login overlay until a session resolves. A
// not-tech-literate operator sees one simple form, types their username and
// password (set up for them by an admin), and the same dashboard they always
// used appears -- no token to find or paste.
function showLoginOverlay(){
  const app=document.body
  let ov=document.getElementById('login-overlay')
  if(!ov){
    ov=document.createElement('div')
    ov.id='login-overlay'
    ov.style.cssText='position:fixed;inset:0;background:var(--bg,#111);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px'
    ov.innerHTML='<form id="login-form" style="background:var(--panel,#1a1a1a);border:1px solid var(--border,#333);border-radius:10px;padding:28px 24px;max-width:340px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,.5)">'
      +'<h1 style="margin:0 0 18px;font-size:20px">casey</h1>'
      +'<label style="display:block;margin-bottom:10px;font-size:13px">Username<input id="login-username" autocomplete="username" style="display:block;width:100%;margin-top:4px;padding:8px;font-size:16px" required></label>'
      +'<label style="display:block;margin-bottom:16px;font-size:13px">Password<input id="login-password" type="password" autocomplete="current-password" style="display:block;width:100%;margin-top:4px;padding:8px;font-size:16px" required></label>'
      +'<div id="login-error" style="color:#e66;font-size:13px;margin-bottom:10px;display:none"></div>'
      +'<button type="submit" style="width:100%;padding:10px;font-size:15px">Log in</button>'
      +'</form>'
    app.appendChild(ov)
    ov.querySelector('#login-form').addEventListener('submit', async (e)=>{
      e.preventDefault()
      const u=ov.querySelector('#login-username').value.trim()
      const p=ov.querySelector('#login-password').value
      const err=ov.querySelector('#login-error')
      err.style.display='none'
      try{
        await doLogin(u,p)
        ov.remove()
        initWhoAmI()
        boot()
      }catch(e2){ err.textContent=e2.message||'Log in failed'; err.style.display='' }
    })
  }
}
;(async ()=>{
  await checkSession()
  if(!currentUser){ showLoginOverlay(); return }
  initWhoAmI()
  boot()
})()
// Background polls. The 5s full-list poll is the expensive one; in focus mode it
// is suppressed so a phone only runs the cheap 30s attention poll plus health.
const _casesIv = setInterval(() => { if(!inboxMode) loadCases() }, 5000)
const _healthIv = setInterval(refreshHealth, 15000)
const _attnIv = setInterval(refreshAttention, 30000)
const _focusBtn = $('#focus-btn'); if(_focusBtn) _focusBtn.onclick = () => setInboxMode(!inboxMode)
function setMineOnly(on){
  if(on && !selectedOperator){ toast('Pick who you are first (top-right) so "Mine" knows whose cases to show.','warn'); return }
  mineOnly=!!on
  const b=$('#mine-btn'); if(b) b.classList.toggle('active',mineOnly)
  renderListFull(); renderTriage()
}
const _mineBtn = $('#mine-btn'); if(_mineBtn) _mineBtn.onclick = () => setMineOnly(!mineOnly)
window.addEventListener('beforeunload', () => { clearInterval(_casesIv); clearInterval(_healthIv); clearInterval(_attnIv) })
window.__casey = { esc, rel, waitFmt, sparkline, draftBanner, draftText, caseHasDraft, latestDraft, loadThresholds, hoursOf, loadMetrics, loadMetricsHtml, loadClusters, clustersHtml, loadGeo, geoHtml, loadMap, get mapState(){return mapState}, fmtDur, loadActivity, activityHtml, initWhoAmI, get selectedOperator(){return selectedOperator}, get currentUser(){return currentUser}, checkSession, doLogin, doLogout, handoverHtml, loadHandover, offlineHtml, loadOffline, teamHtml, loadTeam, fieldNotes, fieldSources, isMine, setMineOnly, get mineOnly(){return mineOnly}, undoToast, replyUndoToast, toggleSelect, clearSelection, syncBulkBar, bulkAction, get selectedIds(){return selectedIds}, applyInboxMode, setInboxMode, get inboxMode(){return inboxMode}, toast, loadCases, openCase, applyTheme, refreshHealth, refreshAttention, refreshRuntimePill, refreshGuardrailsPill, renderTriage, countTitle, setInboxBadge, get inboxCount(){return inboxCount}, get lastHealth(){return lastHealth}, get attentionInbox(){return attentionInbox}, set attentionInbox(v){attentionInbox=v},
  applySimple, stageLabel, STAGE_LABEL,
  get activeId(){return activeId}, get allCases(){return allCases}, get filt(){return filt},
  get editing(){return editing}, get simple(){return simple},
  setFilter(q){filt.q=q;renderListFull()},
  renderList: renderListFull, renderListFull, matchesFull, openIntakeForm,
  // help overlay + per-case hint, exposed for browser-witness
  showHelp, hideHelp, helpSeen, todoHint, get helpOpen(){return helpOpen},
  showOnboard, hideOnboard, onboarded,
  // triage inbox + coaching + handoff, exposed for browser-witness
  cannedReplies, renderTriage,
  checkHandoffs, clearHandoff, hasHandoff, contactMaybeNonEnglish,
  INTAKE_FIELDS,
  get handoffQueue(){return handoffQueue}, get handoffSeen(){return handoffSeen},
  showDialog }   // exposed for browser-witness
</script>
<script>if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{})</script>
</body></html>`
