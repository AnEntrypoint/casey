// Session, login, and the public contact report form. These routes -- plus the
// session-resolving and auth-gate MIDDLEWARE -- must register before every
// other route module, since later modules assume req.caseyAccount is already
// resolved and the auth gate has already run. registerAuth(app, deps) does
// both: registers the pre-auth session middleware + public routes, then the
// auth gate middleware + the static mounts (/design, /vendor, /media) that
// must sit between the gate and the rest of the API.
//
// Shape: module-level named middleware and handler factories plus the ROUTES
// table near the bottom, the same shape the other route modules use. Unlike
// them this module cannot be a route table ALONE, and the difference is
// structural rather than stylistic: registerAuth's ORDER is the security
// property (session resolve -> CSRF guard -> public routes -> auth gate ->
// static mounts), three of its five registrations are app.use middleware
// rather than routes, and the two /report routes carry a per-route rate-limit
// middleware that routes/register.js's mountRoutes has no argument for. So the
// six plain routes between the CSRF guard and the auth gate go through the
// table, and everything the table cannot express stays an explicit call in
// registerAuth, in the original order.
//
// deps: store, express, path, DESIGN_DIR, LEAFLET_DIR, MARKERCLUSTER_DIR,
//   COOKIE_NAME, parseCookies, sessionCookieHeader, clearCookieHeader,
//   issueSession, verifySession, findAccountByUsername, verifyPassword,
//   markLogin, getAccount, changePassword, esc, wrap
import { mergeTag } from '../../hooks/heuristics.js'
import { DASHBOARD_UI, REPORT_FIELD_DEFS } from '../../store/report-shape.js'
import { BRAND, TYPE_SCALE_CSS } from '../brand.js'
import { parseReport } from '../../timestamp.js'
import { mountRoutes } from './register.js'
import { RUNTIME_STATES } from './operations.js'

// Session gate: a valid casey_session cookie (see dashboard/auth.js) resolves
// to a real operator_account row. Middleware runs on every request BEFORE
// route handlers so actingOperator(req) below can stay a SYNCHRONOUS reader
// of the pre-resolved req.caseyAccount -- every existing call site
// (actingOperator(req) sprinkled through dozens of route handlers) keeps
// working unchanged rather than needing an await added at each site.
export function sessionMiddleware({ store, parseCookies, verifySession, COOKIE_NAME, getAccount }) {
  return async (req, res, next) => {
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
        // status !== 'deleted' is load-bearing, not defensive noise. thatcher
        // deletes are SOFT: the row stays with status='deleted'. listAccounts
        // uses t.list, which filters those out, but getAccount above is t.get,
        // which does NOT -- so without this clause a deleted operator kept a
        // fully valid session. Live-witnessed before the fix: after
        // deleteAccount, /api/login correctly returned 401 while the account's
        // existing cookie still returned whoami 200 with role admin. Deleting
        // an operator has to end their access now, not whenever their cookie
        // happens to expire.
        const liveEpoch = Number(acct?.session_epoch) || 0
        const live = acct && acct.status !== 'deleted' && acct.disabled !== '1'
        if (live && claim.epoch === liveEpoch) req.caseyAccount = acct
      }
    } catch { /* a broken/tampered cookie just means not-logged-in, never a crash */ }
    next()
  }
}

// CSRF guard: SameSite=Lax already blocks a cross-site POST/PUT/PATCH/DELETE
// form submission from carrying the session cookie, but a same-site-lax
// cookie still rides along on a cross-site GET navigation, and this app
// accepts state-changing requests over POST with no separate CSRF token.
// Belt-and-braces: reject a state-changing request from a logged-in session
// whose Origin (or, lacking that, Referer) does not match this deployment's
// own host -- cheap, no token to mint/store, and only engages once a real
// session exists (the public unauthenticated /report form is untouched).
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
export function csrfGuard() {
  return (req, res, next) => {
    if (!req.caseyAccount || !STATE_CHANGING.has(req.method)) return next()
    const origin = req.get('origin') || req.get('referer')
    if (!origin) return next()
    let originHost
    try { originHost = new URL(origin).host } catch { return res.status(403).json({ error: 'invalid origin' }) }
    if (originHost !== req.get('host')) return res.status(403).json({ error: 'cross-origin request rejected' })
    next()
  }
}

// What this deployment calls the thing a contact is filing: report-fields.yml's
// entity_label (uhh: "report"; casey's own bundled helpdesk demo: "ticket").
// BRAND carries it alongside the colours so a page has one import, not two.
const ENTITY = BRAND.entityLabel || 'report'

// Fields shown on the public contact form -- the deployment's OWN declared
// report vocabulary (report-fields.yml, via report-shape.js), never a second
// hand-written list.
//
// This used to be thirteen hardcoded animal-health keys (species, symptoms,
// suspected_disease, dead_count...) in a codebase whose whole point is that
// the domain comes from config, and which ships an IT-helpdesk demo by
// default. That was not merely off-domain wording: case-store.js's
// mergeReport rejects any key outside REPORT_KEYS, so under any config but
// one, a contact who filled this form in got "Something went wrong saving
// your details" and their report was silently not saved. The form could not
// work and could not be made to work by editing config -- the only surface a
// reporting contact ever reaches was hardcoded to one deployment.
//
// Two field classes are held back:
//  - `append` fields (photos/voice notes/extra sites) accumulate agent-written
//    notes ABOUT media that arrived over the messaging channel. This form has
//    no upload, so a text box for "Photos" would collect a description of a
//    photo nobody sent.
//  - `public: false` is the deployer's own opt-out for a field that is real
//    but not a question to put to a contact (an agent-recorded meta field
//    such as which language they wrote in). Absent, a field is shown --
//    defaulting to hiding would silently empty the form for every config that
//    has never heard of the flag.
// `public_label`/`public_hint` likewise let a deployer phrase a field as a
// question for a contact ("Which animals?") rather than reuse the operator
// column header ("Animals"); absent, the operator label is shown and no
// placeholder is rendered, which is honest rather than invented.
const PUBLIC_FIELDS = (() => {
  const shown = (REPORT_FIELD_DEFS || []).filter(f => f && f.key && !f.append && f.public !== false)
  const row = (f) => ({
    key: f.key,
    label: f.public_label || f.display_label || f.key,
    hint: f.public_hint || '',
    multiline: f.multiline === true,
    critical: f.critical_for_visit === true,
    section: String(f.section || '').trim(),
  })
  // Critical first, then the rest, each in declaration order. The criticals
  // have to be contiguous because they form the first contact-facing group,
  // and config declares fields in operator-section order, which interleaves
  // them. postReport reads this same flat list to decide which body keys it
  // will accept, so the ORDER is presentational but the MEMBERSHIP is a
  // write-side allowlist: keep it one list, not two.
  return [...shown.filter(f => f.critical_for_visit).map(row), ...shown.filter(f => !f.critical_for_visit).map(row)]
})()

// The form's contact-facing groups, in render order.
//
// This page asks 24 questions under uhh's config and measured 2845px of
// unbroken scroll, which is the shape of a form people abandon: no sense of
// how much is left, and no way to tell a question that matters from one that
// does not. It had two text separators, which is not sectioning -- nothing
// bounded a group, and the second one held eighteen fields.
//
// The grouping is NOT invented here. report-fields.yml already declares a
// `section` per field (report-shape.js passes it straight through, and the
// dashboard's own ReportSections renders by it), so the deployer has already
// said how their vocabulary divides up: under uhh, "Animal & symptoms",
// "People on site", "Notes & media". Reusing that is the same discipline the
// field list itself follows -- the domain comes from config, never from a
// second hand-written list in here.
//
// The criticals are the one group this file names itself, because their
// grouping is a PROPERTY (critical_for_visit) rather than a section, and
// because the deployer's own label for them is written for an operator
// reading a case ("Visit critical"), not for a farmer answering questions.
// A section a deployer has not named at all falls back to one plain bucket
// rather than rendering an empty heading.
const CRITICAL_GROUP_TITLE = 'Needed before a team can visit'
const UNSECTIONED_GROUP_TITLE = 'More detail'
const PUBLIC_GROUPS = (() => {
  const groups = []
  const critical = PUBLIC_FIELDS.filter(f => f.critical)
  if (critical.length) groups.push({ title: CRITICAL_GROUP_TITLE, critical: true, fields: critical })
  const byTitle = new Map()
  for (const f of PUBLIC_FIELDS) {
    if (f.critical) continue
    const title = f.section || UNSECTIONED_GROUP_TITLE
    if (!byTitle.has(title)) byTitle.set(title, { title, critical: false, fields: [] })
    byTitle.get(title).fields.push(f)
  }
  return [...groups, ...byTitle.values()]
})()

// This page is reached with no session, and its CSS is inline and
// dependency-free. Not, as this comment used to claim, "by necessity" -- the
// /design static mount is exempted by authGate below, so the kit bundle is in
// fact fetchable here without a cookie. It is a choice, made for the reasons
// set out in brand.js: the kit scopes its tokens to a .ds-247420 ancestor
// rather than :root, so a bare <link> would resolve nothing anyway, and the
// bundle is 874,759 bytes against roughly fourteen for this whole page.
// What this page must not ALSO be is a
// separate palette: every brand-carrying value in the <style> block below
// comes from dashboard/brand.js, the same resolution manifest.json, the
// generated icon and offline.html already read. It used to be a stock blue
// (#2f6fb0 buttons and focus rings, #1a3a5c headings, #dce8f5 rules) with a
// progress bar at #f0a030 -- a near-miss of this deployment's real brand
// orange #E88427 rather than the brand orange itself -- on the one surface a
// reporting contact ever sees.
//
// Semantic colours (the ok/error banners, the completed-bar green) stay fixed
// on purpose: those encode meaning, not identity, and re-tinting them to a
// brand is how "saved" and "failed" stop being distinguishable at a glance.
//
// This rationale is a JS comment rather than an HTML one deliberately. Every
// byte of this page crosses a rural, metered link to a contact who may be on
// a feature phone; an explanatory comment about our own colour history is not
// something they should have to download, and it named internal decisions to
// the public besides.
//
// SIZES COME FROM brand.js's TYPE_SCALE_CSS, which carries the design kit's
// own ladder verbatim (see that file for why the kit stylesheet is not linked
// here: it is 874,759 bytes against this page's three). Six rungs do the whole
// page, each with exactly one job: --fs-xl page title, --fs-lg section title
// and brand mark, --fs-body the inputs and the send button, --fs-xs the field
// labels and banners, --fs-tiny the hints, --fs-micro the fine print. Before
// this the page mixed 1.3em, 17px, 16px, 14px, 13px and 12px with no rule
// about which meant what, and rendered SEVEN distinct sizes in a real browser
// -- the seventh being an accident, see the input selector below.
//
// THE PAGE STAYS LIGHT IN A DARK DEPLOYMENT, and that is a decision, not an
// oversight. brand.js derives `accent` by darkening the brand ground one
// percent at a time until it MEASURES 4.5:1 against `soft` -- a light wash.
// Every colour on this page is picked against a light ground by that
// derivation, so inverting the page would not be a restyle, it would silently
// invalidate the one contrast guarantee this surface has. A form filled in
// outdoors in daylight also reads better light than dark. Consistency with
// the rest of the product is carried instead by the brand bar at the top, the
// same ground and ink the app chrome and the generated icon already use, and
// by the shared type ladder.
//
// `esc` is a parameter rather than a closure binding because this is now a
// module-level function: it is the same server.js escapeHtml every route
// module receives through deps, just passed explicitly.
export function publicFormHtml(esc, { ref = '', caseRow = null, done = false, err = '' } = {}) {
  let report = parseReport(caseRow)
  const vcTotal = PUBLIC_FIELDS.filter(f => f.critical).length
  const vcFilled = PUBLIC_FIELDS.filter(f => f.critical && report[f.key] != null && String(report[f.key]).trim() !== '').length
  const allFilled = vcTotal === 0 || vcFilled >= vcTotal
  // A config declaring no critical_for_visit field at all would divide by zero
  // here, so the bar is simply not drawn -- there is no "essential progress"
  // to report when the deployment has not named anything essential.
  const progressBar = (caseRow && vcTotal > 0) ? `<div class="progress-wrap" aria-label="Essential fields: ${vcFilled} of ${vcTotal} filled">
      <div class="progress-label">${allFilled ? 'All essential details filled. Thank you.' : `Essential details: ${vcFilled} of ${vcTotal} filled`}</div>
      <div class="progress-track"><div class="progress-bar${allFilled ? ' done' : ''}" style="width:${Math.round(vcFilled/vcTotal*100)}%"></div></div>
    </div>` : ''
  // One field. Unchanged in every respect that matters: the value is still
  // esc()'d before it reaches a value attribute or a textarea body, and the
  // hint is still esc()'d before it reaches a placeholder attribute.
  const fieldHtml = ({ key, label, hint, multiline, critical }) => {
    const val = esc(report[key] || '')
    const placeholder = hint ? ` placeholder="${esc(hint)}"` : ''
    const inp = multiline
      ? `<textarea name="${esc(key)}" rows="3"${placeholder} maxlength="4000">${val}</textarea>`
      : `<input type="text" name="${esc(key)}"${placeholder} value="${val}" maxlength="500">`
    const vcMark = critical ? ' <span class="req" aria-label="essential">*</span>' : ''
    return `<div class="field${critical ? ' vc' : ''}"><label>${esc(label)}${vcMark}</label>${inp}</div>`
  }
  // Each declared group becomes a bounded card with a numbered step and its
  // own question count, so a long form reads as "four things to do" rather
  // than one undifferentiated column. The count is the honest number, not a
  // rounded one: someone deciding whether to start deserves to know.
  // Without a known case the form opens with its own "find your report" card,
  // which is step 1; the declared groups then start at 2. With a ref in hand
  // that card collapses to a hidden input and the groups start at 1. The
  // numbers have to agree with what is actually on the page or they are worse
  // than no numbers at all.
  const stepOffset = caseRow ? 0 : 1
  const groupCards = PUBLIC_GROUPS.map((g, i) => {
    const n = i + 1 + stepOffset
    const count = `${g.fields.length} question${g.fields.length === 1 ? '' : 's'}`
    return `<section class="grp${g.critical ? ' vc' : ''}">
      <h2 class="grp-head"><span class="grp-n" aria-hidden="true">${n}</span><span class="grp-title">${esc(g.title)}</span><span class="grp-count">${count}</span></h2>
      ${g.fields.map(fieldHtml).join('')}
    </section>`
  }).join('')
  const banner = done
    ? `<div class="banner ok">Your details have been saved. The team will be in touch.</div>`
    : err ? `<div class="banner err">${esc(err)}</div>` : ''
  const caseInfo = caseRow
    ? `<div class="case-info"><strong>Reference: ${esc(caseRow.ref)}</strong> &ndash; ${esc(caseRow.subject || `Field ${ENTITY}`)}
         <button type="button" class="copy-link-btn" data-ref="${esc(caseRow.ref)}">Share link</button></div>`
    : ''
  const refBlock = caseRow ? `<input type="hidden" name="ref" value="${esc(ref)}">` : `
      <section class="grp vc">
      <h2 class="grp-head"><span class="grp-n" aria-hidden="true">1</span><span class="grp-title">Find your ${esc(ENTITY)}</span><span class="grp-count">2 questions</span></h2>
      <div class="field"><label>Your reference number</label>
      <input type="text" name="ref" value="${esc(ref)}" placeholder="e.g. CASE-001" maxlength="50">
      <div class="hint">This was shared with you when you first reported. Check your messages. If you do not have one, enter your phone number below instead.</div></div>
      <div class="field"><label>Or your phone number</label>
      <input type="tel" name="phone" placeholder="+27 82 123 4567" maxlength="30">
      <div class="hint">A South African number. We use this to find your ${esc(ENTITY)}.</div></div>
      </section>`
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="${esc(BRAND.ground)}">
<title>${esc(BRAND.name)} - ${esc(ENTITY)} form</title>
<style>
  ${TYPE_SCALE_CSS}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,sans-serif;font-size:var(--fs-body);line-height:var(--lh-base);
    background:#f4f6f9;color:#1a1f29;min-height:100vh}
  .topbar{background:${BRAND.ground};color:${BRAND.ink}}
  .topbar-in{max-width:540px;margin:0 auto;padding:var(--space-2-75) var(--space-3);
    font-size:var(--fs-lg);font-weight:700;line-height:var(--lh-snug)}
  .wrap{max-width:540px;margin:0 auto;padding:var(--space-4) var(--space-3) var(--space-6)}
  h1{font-size:var(--fs-xl);line-height:var(--lh-snug);margin:0 0 var(--space-1);color:${BRAND.accent}}
  .sub{font-size:var(--fs-xs);color:#495662;margin:0 0 var(--space-3-5)}
  .case-info{background:${BRAND.soft};border:1px solid ${BRAND.edge};border-radius:8px;
    padding:var(--space-2-5) var(--space-3);margin:0 0 var(--space-3);font-size:var(--fs-xs);color:#1a1f29}
  .banner{border-radius:8px;padding:var(--space-2-75) var(--space-3);margin:0 0 var(--space-3-5);font-size:var(--fs-xs)}
  .banner.ok{background:#e8f7ee;border:1px solid #9ed8b4;color:#1a5c35}
  .banner.err{background:#fdeaea;border:1px solid #f0a0a0;color:#5c1a1a}
  .progress-wrap{margin:0 0 var(--space-3-5)}
  .progress-label{font-size:var(--fs-tiny);color:#495662;margin-bottom:var(--space-1-5)}
  .progress-track{background:${BRAND.edge};border-radius:4px;height:7px;overflow:hidden}
  .progress-bar{background:${BRAND.ground};height:100%;border-radius:4px;transition:width .3s}
  .progress-bar.done{background:#2a9e5c}
  .grp{background:#fff;border:1px solid #dde3ea;border-radius:10px;
    padding:var(--space-3) var(--space-3) var(--space-1);margin:0 0 var(--space-3-5)}
  .grp.vc{background:${BRAND.soft};border-color:${BRAND.edge}}
  .grp-head{display:flex;align-items:center;gap:var(--space-2);margin:0 0 var(--space-3);
    font-size:var(--fs-lg);line-height:var(--lh-snug);font-weight:700;color:${BRAND.accent}}
  .grp-n{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;
    width:24px;height:24px;border-radius:50%;background:${BRAND.ground};color:${BRAND.ink};
    font-size:var(--fs-micro);font-weight:700;line-height:1}
  .grp-title{flex:1 1 auto}
  .grp-count{flex:0 0 auto;font-size:var(--fs-micro);font-weight:400;color:#5a6674}
  .field{margin:0 0 var(--space-3)}
  .field.vc label{color:${BRAND.accent}}
  /* A label is one short line, so it takes the tight leading; --lh-base is
     for the running prose around it (the intro, the hints, the banners). Set
     on body alone it added about 6px to each of twenty-four labels for no
     legibility gain, on the surface whose main problem is its length. */
  label{display:block;font-size:var(--fs-xs);line-height:var(--lh-snug);font-weight:600;margin:0 0 var(--space-1)}
  .hint{font-size:var(--fs-tiny);color:#5a6674;margin-top:var(--space-1)}
  .req{color:${BRAND.accent};font-weight:700}
  /* input[type=tel] is named explicitly. It used to fall outside this
     selector, so the phone field alone rendered at the browser's own default
     (13.33px measured in Chrome) -- visibly smaller than every other field,
     and under the 16px floor below which iOS Safari zooms the page on focus,
     which on a narrow phone throws the rest of the form off screen. The
     16px here is that floor, not a taste. */
  input[type=text],input[type=tel],textarea{width:100%;border:1px solid #c8d0da;border-radius:6px;
    padding:var(--space-2-75) var(--space-2-75);font-size:var(--fs-body);font-family:inherit;
    background:#fff;color:#1a1f29;min-height:44px;-webkit-appearance:none}
  input:focus,textarea:focus{outline:2px solid ${BRAND.ground};border-color:${BRAND.ground}}
  textarea{resize:vertical;min-height:80px;line-height:var(--lh-base)}
  button[type=submit]{width:100%;background:${BRAND.ground};color:${BRAND.ink};border:0;border-radius:8px;
    padding:var(--space-2-75);font-size:var(--fs-body);font-weight:600;cursor:pointer;
    margin-top:var(--space-2);min-height:52px}
  button[type=submit]:hover{background:${BRAND.hover}}
  button:disabled{opacity:.6;cursor:default}
  .req-note{font-size:var(--fs-micro);color:#495662;margin:0 0 var(--space-2)}
  .copy-link-btn{background:none;border:1px solid ${BRAND.edge};border-radius:5px;color:${BRAND.accent};
    font-size:var(--fs-micro);padding:var(--space-half) var(--space-2);cursor:pointer;
    margin-left:var(--space-2);vertical-align:middle}
  .copy-link-btn:hover{background:#fff}
  .field-err{font-size:var(--fs-micro);color:#a00;margin-top:var(--space-1);display:none}
  .field-err.show{display:block}
  .draft-note{font-size:var(--fs-micro);color:#5a6674;margin:0 0 var(--space-2);display:none}
  .draft-note.show{display:block}
  .draft-clear{background:none;border:0;padding:0;margin-left:var(--space-1);color:${BRAND.accent};
    font-size:var(--fs-micro);font-family:inherit;text-decoration:underline;cursor:pointer}
  footer{text-align:center;font-size:var(--fs-micro);color:#495662;margin-top:var(--space-4)}
</style></head><body>
<header class="topbar"><div class="topbar-in">${esc(BRAND.name)}</div></header>
<div class="wrap">
  <h1>Your ${esc(ENTITY)} details</h1>
  <p class="sub">Please fill in as many details as you can. Fields marked * are needed before a team can visit. You can leave anything you do not know blank.</p>
  ${banner}${caseInfo}${progressBar}
  <form method="POST" action="/report">
    ${refBlock}
    ${groupCards}
    <p class="req-note">* Essential for a field visit</p>
    <p class="draft-note" id="draft-note" aria-live="polite">Your answers are kept in this tab until you send them. </p>
    <button type="submit">Send details</button>
  </form>
  <footer>${esc(BRAND.description || BRAND.name)}</footer>
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
    errEl.setAttribute('aria-live', 'polite')
    phoneEl.setAttribute('aria-describedby', 'phone-err')
    phoneEl.parentNode.appendChild(errEl)
    phoneEl.addEventListener('blur', () => {
      const v = phoneEl.value.trim()
      if (!v) { errEl.className = 'field-err'; phoneEl.removeAttribute('aria-invalid'); return }
      const d = v.replace(/[^0-9+]/g, '')
      if (/^0[0-9]{9}$/.test(d)) { phoneEl.value = '+27' + d.slice(1); errEl.className = 'field-err'; phoneEl.removeAttribute('aria-invalid'); return }
      if (/^27[0-9]{9}$/.test(d)) { phoneEl.value = '+' + d; errEl.className = 'field-err'; phoneEl.removeAttribute('aria-invalid'); return }
      if (/^\\+27[0-9]{9}$/.test(d)) { errEl.className = 'field-err'; phoneEl.removeAttribute('aria-invalid'); return }
      errEl.textContent = 'Please use a South African number: 0821234567 or +27821234567'
      errEl.className = 'field-err show'
      phoneEl.setAttribute('aria-invalid', 'true')
    })
  }
  // Answer retention across a bounced submit.
  //
  // The loss this fixes is specific and was reachable on every error path: a
  // failed POST redirects to /report?ref=...&err=..., and that redirect
  // carries the reference and the message but NOT the answers, so somebody who
  // filled in twenty-four questions on a bad link got the form back empty with
  // an apology on top. Same on an accidental back-navigation.
  //
  // sessionStorage, deliberately NOT localStorage. This form collects a farm
  // location, an owner's name and an owner's phone number, and it is filled in
  // on rural phones that get lent and shared. localStorage would leave one
  // person's report readable on that handset indefinitely, to anyone who
  // opened the page next; sessionStorage is scoped to the tab, which covers
  // the reload and the bounced submit without leaving a resident copy of
  // someone else's report behind. It is cleared outright once the server
  // confirms the save.
  //
  // Do not overstate what tab scope buys: mobile Chrome restores sessionStorage
  // into restored tabs across an app restart, so a lent phone with this tab
  // still open still holds the draft. That is exactly why the note below is
  // visible and carries its own clear control, rather than the page quietly
  // holding someone's answers with no way to say otherwise.
  const form = document.querySelector('form')
  const DRAFT_KEY = 'casey.report.draft.' + (new URLSearchParams(location.search).get('ref') || 'new')
  const draftNote = document.getElementById('draft-note')
  const fields = () => [...form.querySelectorAll('input[type=text],input[type=tel],textarea')]
  const saveDraft = () => {
    try {
      const d = {}
      for (const el of fields()) if (el.value.trim()) d[el.name] = el.value
      if (Object.keys(d).length) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d))
      else sessionStorage.removeItem(DRAFT_KEY)
    } catch (_) { /* private mode or a full quota: the form still works */ }
  }
  const clearDraft = () => { try { sessionStorage.removeItem(DRAFT_KEY) } catch (_) {} }
  if (document.querySelector('.banner.ok')) clearDraft()
  else {
    try {
      const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '{}')
      let restored = 0
      for (const el of fields()) {
        if (!el.value && typeof saved[el.name] === 'string') { el.value = saved[el.name]; restored++ }
      }
      if (restored) {
        draftNote.textContent = 'We brought back ' + restored + ' answer' + (restored === 1 ? '' : 's') + ' you had already typed. '
      }
      const clearBtn = document.createElement('button')
      clearBtn.type = 'button'
      clearBtn.className = 'draft-clear'
      clearBtn.textContent = 'Clear my answers'
      clearBtn.addEventListener('click', () => {
        clearDraft()
        for (const el of fields()) el.value = ''
        draftNote.textContent = 'Cleared. Nothing you typed is kept on this phone. '
        draftNote.appendChild(clearBtn)
      })
      draftNote.appendChild(clearBtn)
      draftNote.classList.add('show')
    } catch (_) { /* nothing to restore */ }
    form.addEventListener('input', saveDraft)
  }
  form.addEventListener('submit', (e) => {
    // Block submit if phone has visible error
    const pe = document.getElementById('phone-err')
    if (pe && pe.classList.contains('show')) { e.preventDefault(); return }
    saveDraft()
    btn.disabled = true; btn.textContent = 'Sending...'
  })
</script>
</body></html>`
}

// The public /report form has no auth (the ref is the shared secret), so it
// needs its own throttle. What that throttle is actually FOR is worth stating
// accurately, because the two reasons this comment used to give have both
// stopped being true and someone reading it could reasonably conclude the
// limiter no longer earns its keep:
//  - The ref is not brute-forceable. _nextRef mints CASE-<seq>-<8 chars of a
//    32-symbol alphabet> from crypto.randomBytes, so the suffix alone is ~40
//    bits; ten guesses a minute is not a threat to it.
//  - The SA phone-number space no longer reaches anybody else's case. The
//    phone branch of postReport below is scoped to channel 'web' and cannot
//    bind to an agent-gathered conversation at all.
// The reason it still matters is VOLUME, not guessing: every permitted request
// can open a real case in a queue that human responders work, and burying the
// genuine reports is the highest-impact attack on a surveillance system. That
// bound is per-IP only -- there is no global cap here, unlike the messaging
// path's CASEY_GLOBAL_RATE_LIMIT_MSGS -- and a tighter one is NOT a free win:
// SA mobile carriers CGNAT heavily and CASEY_TRUST_PROXY_HOPS defaults unset,
// so a whole district can share one req.ip and a narrow cap would mute real
// reporters mid-outbreak. Scoped to these two routes only -- never touches the
// authed() /api surface. Sweeps stale buckets so the map cannot grow unbounded
// under sustained traffic.
//
// A factory rather than module-level state on purpose: the bucket map and the
// sweep interval belong to one registerAuth call, exactly as they did when
// they were closure bindings, so two dashboards in one process do not share a
// limiter (or leak a second uncleared interval).
const REPORT_RATE_LIMIT = 10
const REPORT_RATE_WINDOW_MS = 60000
export function makeReportRateLimiter(esc) {
  const reportRateBuckets = new Map()
  setInterval(() => {
    const now = Date.now()
    for (const [ip, b] of reportRateBuckets) {
      if (now - b.windowStart > REPORT_RATE_WINDOW_MS) reportRateBuckets.delete(ip)
    }
  }, REPORT_RATE_WINDOW_MS).unref?.()
  return function reportRateLimited(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown'
    const now = Date.now()
    let b = reportRateBuckets.get(ip)
    if (!b || now - b.windowStart > REPORT_RATE_WINDOW_MS) {
      b = { count: 0, windowStart: now }
      reportRateBuckets.set(ip, b)
    }
    b.count++
    if (b.count > REPORT_RATE_LIMIT) return res.status(429).type('html').send(publicFormHtml(esc, { err: 'Too many requests. Please wait a moment and try again.' }))
    next()
  }
}

// Public contact-facing report form -- no token required.
// The ref acts as the shared secret: contacts only know their own ref,
// and report fields are non-sensitive (location, symptoms, contact info).
// GET /report?ref=REF  -> HTML form for that case (or blank ref input)
// POST /report         -> submit fields; redirect back with ?done=1 or ?err=...
export function getReport({ store, esc }) {
  return async (req, res) => {
    const ref = String(req.query.ref || '').slice(0, 50).trim()
    const done = req.query.done === '1'
    const err = String(req.query.err || '').slice(0, 200)
    if (!ref) return res.type('html').send(publicFormHtml(esc, { done, err }))
    try {
      const found = await store.getCaseByRef(ref)
      if (!found) return res.type('html').send(publicFormHtml(esc, { ref, err: err || `Reference "${ref}" was not found. Please check and try again.` }))
      res.type('html').send(publicFormHtml(esc, { ref, caseRow: found, done, err }))
    } catch (e) { res.status(500).type('html').send(publicFormHtml(esc, { ref, err: 'Something went wrong. Please try again in a moment.' })) }
  }
}

export function postReport({ store }) {
  return async (req, res) => {
    const ref = String(req.body.ref || '').slice(0, 50).trim()
    const phoneRaw = String(req.body.phone || '').replace(/[\s\-()]/g, '').slice(0, 30)
    if (!ref && !phoneRaw) return res.redirect('/report?err=' + encodeURIComponent('Please enter your reference number or phone number.'))
    try {
      let found = null
      // Whether THIS request opened the case it is about to write to. A
      // submitter who supplied the ref, or who just caused the case to exist,
      // has a claim on it; a bare phone number is not a claim (see below).
      let openedHere = false
      if (ref) {
        found = await store.getCaseByRef(ref)
        if (!found) return res.redirect('/report?ref=' + encodeURIComponent(ref) + '&err=' + encodeURIComponent(`Reference "${ref}" was not found. Please check, or enter your phone number instead.`))
      } else {
        // Phone-based entry: normalise to +27XXXXXXXXX.
        const validPhone = /^0[0-9]{9}$/.test(phoneRaw) || /^\+27[0-9]{9}$/.test(phoneRaw)
        if (!validPhone) return res.redirect('/report?err=' + encodeURIComponent('Phone number not recognised. Please use a South African number like 0821234567 or +27821234567.'))
        const normPhone = phoneRaw.startsWith('0') ? '+27' + phoneRaw.slice(1) : phoneRaw
        // A PHONE NUMBER IS NOT A SECRET, so it may only ever reach a case this
        // same form opened for that number -- never an agent-gathered
        // conversation on another channel. This used to scan for any case with
        // a matching external_id across every channel, which made the header's
        // "the ref acts as the shared secret" untrue: witnessed live against a
        // running dashboard, POSTing one seeded contact's number returned that
        // contact's WhatsApp case ref in the redirect, the next GET rendered
        // its whole report (a second person's phone number, the owner's name,
        // directions to the kraal), and a following POST overwrote species,
        // location and dead_count on a live outbreak record. findOpenCase
        // (inside findOrCreateCase) is scoped to channel+external_id, so the
        // reachable set is now exactly "the open web-form case for this
        // number", and a first-time reporter with no reference still files a
        // complete report exactly as before.
        const { case: nc, created } = await store.findOrCreateCase({ channel: 'web', external_id: normPhone, contact: { phone: normPhone }, subject: `Field ${ENTITY} via web form` })
        found = nc
        openedHere = created === true
        if (openedHere) {
          // Tag as public form intake
          try {
            await store.updateCase(nc.id, { tags: mergeTag(nc.tags, 'intake_mode:public_form') }, { id: 'contact', role: 'contact' })
          } catch { /* best-effort */ }
          await store.appendEvent(nc.id, { kind: 'note', actor: 'system', text: 'Case created via public web form (phone number entry)' })
        }
      }
      const incoming = {}
      for (const { key } of PUBLIC_FIELDS) {
        const v = req.body[key]
        if (v == null || typeof v !== 'string') continue
        const trimmed = v.trim().slice(0, 4000)
        if (trimmed) incoming[key] = trimmed
      }
      // Someone who typed only a phone number, into a case they did not open,
      // may ADD facts that are missing but never REPLACE one already recorded
      // -- store.mergeReport overwrites non-append fields by design, which on
      // this unauthenticated path meant a stranger could rewrite a live
      // report's species or death count. Nothing is refused and nothing is
      // silently dropped from a genuine reporter's point of view: every field
      // they fill that the record does not already hold is still saved, and a
      // reporter holding their reference keeps full correction rights.
      if (!ref && !openedHere) {
        const already = parseReport(found)
        for (const k of Object.keys(incoming)) {
          if (already[k] != null && String(already[k]).trim() !== '') delete incoming[k]
        }
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
          await store.updateCase(found.id, { tags: mergeTag(found.tags, 'intake_mode:public_form') }, { id: 'contact', role: 'contact' })
        } catch { /* best-effort; form still submitted even if tag fails */ }
      }
      // The ref is the whole access control on this surface, so it is only ever
      // echoed back to someone who already held it or who just opened the case
      // here. Handing it to a bare phone-number entry that landed on a case
      // somebody else opened is what turned a non-secret phone number into a
      // read key for that case's full report on the following GET.
      const showRef = ref || (openedHere ? (found?.ref || '') : '')
      res.redirect(showRef ? '/report?ref=' + encodeURIComponent(showRef) + '&done=1' : '/report?done=1')
    } catch (e) { res.redirect('/report?ref=' + encodeURIComponent(ref) + '&err=' + encodeURIComponent('Something went wrong. Please try again.')) }
  }
}

// Readiness probe for orchestrators/load balancers: is the system of record
// actually reachable RIGHT NOW (a real store query succeeds), not merely "the
// HTTP server booted"? This exercises the store with the cheapest real read (a
// count) and returns 200 {ready:true} or 503 {ready:false,error}. It is UNGATED
// on purpose -- a k8s/LB probe has no dashboard token. Placed before the auth
// middleware so the session gate never 401s a readiness check. Mounted
// { raw: true }: it owns the try/catch that turns a store failure into its own
// 503 shape, which deps.wrap's 500 envelope would replace.
//
// WHY IT REPORTS MORE THAN THE STORE. A sqlite answer is the ONE thing this
// probe used to check, so an instance whose LLM backend was genuinely
// unreachable still answered {"ready":true,"store":"ok"} -- alive, looking
// fine, answering nobody. Every signal that distinguishes "processing" from
// "answering nobody" (/api/health, /api/health/provider, /api/turns/degraded,
// /api/runtime) sits behind the operator session and is unreachable to a
// monitor or a load balancer, so the one endpoint a monitor CAN poll was the
// one that could not fail for the reasons that matter.
//
// WHAT IT MAY SAY. This route stays PII-free (AGENTS.md's "only ungated
// routes" list is absolute): booleans, counts and a fixed vocabulary of state
// words, never case content, never a ref, never a contact identifier, and
// never the provider model/url (a url can carry a key). `degraded_reasons` is
// a closed set of machine tokens; `checks` is a closed set of state words.
//
// WHY DEGRADED IS STILL 200. `ready` answers "may this instance take traffic",
// and a casey whose provider is down is still the instance that accepts the
// inbound, queues the turn and re-drives it on recovery -- pulling it from the
// pool makes the outage worse, and a dashboard-only console has no provider by
// design. So degradation is reported IN the body, and only an unreachable
// store is a 503. A monitor alerts on `degraded`; a load balancer reads the
// status code. `capabilities` says which signals this process can produce at
// all, so an absent one reads as a MODE rather than as a fault: a
// `casey dashboard` console with nothing wired is NOT degraded, it is a
// different shape, and every capability reads false to say so.
//
// `degraded` here is the UNION of every signal this process can see, and is a
// wider word than /api/health's own `degraded` (which is only llm.js's
// slow-turn rolling window, and deliberately never flips on one failed turn).
// A provider that is flatly offline shows degraded:false on /api/health's
// window and degraded:true here, which is the whole point of this route.
const READY_PROBE_TIMEOUT_MS = 1500
const READY_CACHE_MS = 2000
const readyResolve = async (v) => (typeof v === 'function' ? await v() : v)
// A probe that hangs must never make the readiness probe itself hang: an
// orchestrator reads a timed-out probe as a dead instance. Undefined is
// "did not answer", which the callers below report as such.
function readyProbe(v) {
  if (v == null) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), READY_PROBE_TIMEOUT_MS)
    t.unref?.()
    Promise.resolve().then(() => readyResolve(v)).then(
      (r) => { clearTimeout(t); resolve(r) },
      () => { clearTimeout(t); resolve(undefined) })
  })
}
const readyInt = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.trunc(Number(n))) : 0)

export function getReady({ store, llmStatus, receiveStatus, queueStatus, runSweep, sendReply, runtimeStatus }) {
  // Which signals this process was GIVEN a way to produce. Fixed at
  // createDashboard time, so it is computed once rather than per request.
  const capabilities = {
    llm: llmStatus != null,
    receive: receiveStatus != null,
    queue: queueStatus != null,
    sweep: runSweep != null,
    reply: sendReply != null,
    runtime: runtimeStatus != null,
  }
  // A liveness probe can be polled every second by several watchers at once.
  // The store count is the cheap part; the four status probes are not, so one
  // snapshot is shared for a couple of seconds rather than fanned out per
  // request. Per-closure (one createDashboard call), the same discipline
  // makeReportRateLimiter uses for its buckets.
  let cached = null
  async function degradationSnapshot() {
    if (cached && Date.now() - cached.at < READY_CACHE_MS) return cached.value
    const checks = { store: 'ok', llm: 'not_wired', gateway: 'not_wired', runtime: 'not_wired', queue: null }
    const reasons = []
    const [s, rs, qs, rt] = await Promise.all([
      capabilities.llm ? readyProbe(llmStatus) : undefined,
      capabilities.receive ? readyProbe(receiveStatus) : undefined,
      capabilities.queue ? readyProbe(queueStatus) : undefined,
      capabilities.runtime ? readyProbe(runtimeStatus) : undefined,
    ])
    if (capabilities.llm) {
      if (!s || !s.source) { checks.llm = 'no_answer'; reasons.push('llm_no_answer') }
      else if (s.source === 'acptoapi') { checks.llm = s.degraded ? 'degraded' : 'ok'; if (s.degraded) reasons.push('llm_degraded') }
      else if (s.source === 'none') { checks.llm = 'offline'; reasons.push('llm_offline') }
      else { checks.llm = 'unknown'; reasons.push('llm_unknown') }
    }
    if (capabilities.receive) {
      const state = rs && typeof rs.state === 'string' ? rs.state : ''
      if (!state) checks.gateway = 'no_answer'
      else if (state === 'none') checks.gateway = 'none'
      else if (state === 'never-connected') { checks.gateway = 'not_receiving'; reasons.push('gateway_not_receiving') }
      else checks.gateway = 'ok'
    }
    if (capabilities.queue) {
      if (!qs) checks.queue = null
      else {
        checks.queue = { pending: readyInt(qs.pending), dead_lettered: readyInt(qs.deadLettered) }
        if (checks.queue.dead_lettered > 0) reasons.push('queue_dead_lettered')
        if (checks.queue.pending > 0) reasons.push('queue_backlog')
      }
    }
    if (capabilities.runtime) {
      const state = rt && typeof rt.state === 'string' ? rt.state.slice(0, 32) : ''
      // Same whitelist getRuntime enforces, imported rather than copied so the
      // two can never drift into disagreeing about what a runtime state is.
      const safe = RUNTIME_STATES.has(state) ? state : ''
      if (!safe) { checks.runtime = 'no_answer' }
      else if (safe === 'healthy' || safe === 'standalone') { checks.runtime = 'ok' }
      else { checks.runtime = safe; if (safe === 'degraded' || safe === 'stopped') reasons.push('runtime_' + safe) }
    }
    const value = { degraded: reasons.length > 0, degraded_reasons: reasons, checks }
    cached = { at: Date.now(), value }
    return value
  }
  return async (req, res) => {
    const started = Date.now()
    try {
      await store.countCases({})
    } catch (e) {
      // Bound the error so a hostile/huge store error cannot bloat the probe body.
      return res.status(503).json({
        ready: false, store: 'unreachable', degraded: true, degraded_reasons: ['store_unreachable'],
        error: String(e.message || e).slice(0, 200),
      })
    }
    const took_ms = Date.now() - started
    let snapshot
    // A failure to READ the degradation signals is itself a reportable state,
    // never a 500 out of a liveness probe: the store answered, so the instance
    // is ready, and the body says the extra signals could not be gathered.
    try { snapshot = await degradationSnapshot() }
    catch { snapshot = { degraded: true, degraded_reasons: ['checks_unavailable'], checks: { store: 'ok', llm: 'no_answer', gateway: 'no_answer', runtime: 'no_answer', queue: null } } }
    res.json({ ready: true, store: 'ok', took_ms, ...snapshot, capabilities })
  }
}

// Login: username + password against a real operator_account row (see
// dashboard/auth.js). On success, sets an HttpOnly session cookie and
// returns the operator's display info -- never the password hash/salt.
// Rate-limiting/lockout is intentionally NOT added here: this is a
// low-stakes field-team login (see the AUTH MODEL note at the top of this
// file), and a lockout mechanism is itself a denial-of-service surface
// against a teammate's account. scrypt's own cost already makes brute-force
// impractical at any real request rate.
export function postLogin({ store, findAccountByUsername, verifyPassword, issueSession, sessionCookieHeader, markLogin }) {
  return async (req, res) => {
    const { username, password } = req.body || {}
    const acct = await findAccountByUsername(store, username)
    if (!acct || acct.disabled === '1' || !verifyPassword(password, acct.password_salt, acct.password_hash)) {
      return res.status(401).json({ error: 'invalid username or password' })
    }
    const token = issueSession(acct.id, { epoch: Number(acct.session_epoch) || 0 })
    res.set('Set-Cookie', sessionCookieHeader(token))
    markLogin(store, acct.id).catch(() => {}) // best-effort, never blocks login
    res.json({ ok: true, username: acct.username, display_name: acct.display_name, role: acct.role })
  }
}

export function postLogout({ clearCookieHeader }) {
  return (req, res) => {
    res.set('Set-Cookie', clearCookieHeader())
    res.json({ ok: true })
  }
}

// Who the current session belongs to, for the SPA to render "logged in as
// X" / redirect to the login screen when there is no valid session. Safe to
// leave ungated (it just echoes back req.caseyAccount, already resolved
// from the cookie by the middleware above) -- no lookup happens for an
// absent/invalid cookie.
export function getWhoami() {
  return (req, res) => {
    if (!req.caseyAccount) return res.json({ authed: false })
    const a = req.caseyAccount
    res.json({ authed: true, username: a.username, display_name: a.display_name, role: a.role, must_change_password: a.must_change_password === '1' })
  }
}

// Deliberately ungated, same reasoning as /api/whoami above: the login
// screen (login-gate.js) renders before any session exists, so a herd-
// health/rebranded deployment's "casey" -> "Herd Health" shell branding
// (DASHBOARD_UI.brand/leaf, see report-shape.js) never reached it before
// this route existed -- /api/config carries the full shape but is
// correctly gated (workflow stages/enums), so this exposes ONLY the two
// non-sensitive display strings a deployer already renders in the page
// title (server.js's PWA_BRAND) and the post-login topbar. Absent
// dashboard_ui (casey's own default, uhh) -- both fields are null and
// login-gate.js's own 'casey' fallback applies, unchanged.
export function getBranding() {
  return (req, res) => {
    res.json({ brand: DASHBOARD_UI?.brand || null, leaf: DASHBOARD_UI?.leaf || null })
  }
}

// Forced password change: the ONE route a must_change_password account may
// reach besides login/logout/whoami/change-password itself (gated below).
// A printed bootstrap password (or any account an admin creates with the
// flag set) can never be used as a standing credential past the first login.
// Mounted { raw: true }: its own catch answers 400 with the thrown message
// (a rejected weak/short password), not deps.wrap's 500.
export function postChangePassword({ store, verifyPassword, changePassword }) {
  return async (req, res) => {
    if (!req.caseyAccount) return res.status(401).json({ error: 'unauthorized' })
    try {
      const { current_password, new_password } = req.body || {}
      // A session cookie alone must never be sufficient to rotate the
      // account's own credential -- otherwise a stolen/XSS'd/shared-device
      // session escalates straight to a full, silent account takeover (the
      // new password is only known to the attacker, and changePassword also
      // bumps session_epoch, so the legitimate owner's other sessions die in
      // the same call). Re-verify the CURRENT password first, same
      // timing-safe check the login route uses.
      if (!verifyPassword(current_password, req.caseyAccount.password_salt, req.caseyAccount.password_hash)) {
        return res.status(401).json({ error: 'current password is incorrect' })
      }
      await changePassword(store, req.caseyAccount.id, new_password)
      res.json({ ok: true })
    } catch (e) { res.status(400).json({ error: e.message }) }
  }
}

// The auth gate itself. Everything registered AFTER this in registerAuth --
// and every other route module, since auth.js registers first -- sits behind
// it. The exemption list is the whole of AGENTS.md's "only ungated routes"
// invariant; do not add to it without re-reading that section.
export function authGate() {
  return (req, res, next) => {
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
    // The AppShell rewrite's module tree (main.js + every view/component under
    // it) replaces the old single app.js file -- same "shell code, no case
    // data" exemption as app.js above, just spread across real ES module
    // files under /src/ instead of one bundle. Path-prefix (not exact-match)
    // since the tree is 50+ files and grows as other builders land views.
    if (req.path.startsWith('/src/')) return next()
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
  }
}

// The pre-gate routes that mountRoutes CAN express. GET/POST /report are not
// here because they take the rate-limit middleware as a second argument, which
// the table has no slot for -- they are registered by hand in registerAuth,
// immediately above this block, exactly where they used to be.
const ROUTES = [
  ['get', '/api/ready', getReady, { raw: true }],
  ['post', '/api/login', postLogin],
  ['post', '/api/logout', postLogout, { raw: true }],
  ['get', '/api/whoami', getWhoami, { raw: true }],
  ['get', '/api/branding', getBranding, { raw: true }],
  ['post', '/api/change-password', postChangePassword, { raw: true }],
]

export function registerAuth(app, deps) {
  const { store, express, path, DESIGN_DIR, LEAFLET_DIR, MARKERCLUSTER_DIR, esc } = deps

  app.use(sessionMiddleware(deps))
  app.use(csrfGuard())

  // The public form is served only where it is actually an entrypoint.
  // CASEY_PUBLIC_URL is what hooks/prompt.js checks before ever offering a
  // reporter the /report link, so a deployment that leaves it unset never
  // advertises the form -- serving it anyway is unauthenticated write surface
  // reachable by anyone who finds the host, earning nothing. Deployments whose
  // only intake is a messaging channel are the common case, not the exception.
  // Set CASEY_PUBLIC_URL to serve it; the flow is unchanged when set.
  if (process.env.CASEY_PUBLIC_URL) {
    const reportRateLimited = makeReportRateLimiter(esc)
    app.get('/report', reportRateLimited, getReport(deps))
    app.post('/report', reportRateLimited, postReport(deps))
  }

  mountRoutes(app, deps, ROUTES)

  app.use(authGate())

  app.use('/design', express.static(DESIGN_DIR))
  app.use('/vendor/leaflet', express.static(LEAFLET_DIR))
  app.use('/vendor/leaflet.markercluster', express.static(MARKERCLUSTER_DIR))
  // Downloaded photo/voice-note bytes (case-store.js saveMedia), gated like every
  // other case-data route -- unlike /design and /vendor (static UI assets with no
  // case content) this serves real field-worker media, so it stays behind the
  // token middleware above (mounted after it, no exemption added).
  app.use('/media', express.static(path.join(store.dataDir, 'media')))
}
