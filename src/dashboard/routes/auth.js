import { mergeTag } from '../../hooks/heuristics.js'
import { DASHBOARD_UI, REPORT_FIELD_DEFS, fieldLabel } from '../../store/report-shape.js'
import { vocabWord } from '../../config-loader.js'
import { BRAND, TYPE_SCALE_CSS } from '../brand.js'
import { parseReport } from '../../timestamp.js'
import { mountRoutes } from './register.js'
import { registerPublicSiteAssets } from './public-site.js'
import { RUNTIME_STATES } from './operations.js'
import { roleGate, roleOf, expectedRefGuard } from '../roles.js'

export function sessionMiddleware({ store, parseCookies, verifySession, COOKIE_NAME, getAccount }) {
  return async (req, res, next) => {
    req.caseyAccount = null
    try {
      const cookies = parseCookies(req.get('cookie'))
      const claim = verifySession(cookies[COOKIE_NAME])
      if (claim) {
        const acct = await getAccount(store, claim.id)
        const liveEpoch = Number(acct?.session_epoch) || 0
        const live = acct && acct.status !== 'deleted' && acct.disabled !== '1'
        if (live && claim.epoch === liveEpoch) req.caseyAccount = acct
        const viewAs = req.get('x-view-as')
        if (req.caseyAccount && viewAs && req.caseyAccount.role === 'admin' && viewAs !== req.caseyAccount.id) {
          const target = await getAccount(store, viewAs)
          if (target && target.status !== 'deleted' && target.disabled !== '1') {
            req.caseyViewAs = { by: req.caseyAccount.username, admin: req.caseyAccount }
            req.caseyAccount = target
          }
        }
      }
    } catch {  }
    next()
  }
}

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

const ENTITY = BRAND.entityLabel || 'report'

const FIELD_MAXLEN = 4000

const OTHER_CHOICE = '__other__'

const PUBLIC_FIELDS = (() => {
  const shown = (REPORT_FIELD_DEFS || []).filter(f => f && f.key && !f.append && f.public !== false)
  const row = (f) => ({
    key: f.key,
    label: f.public_label || f.display_label || f.key,
    hint: f.public_hint || '',
    multiline: f.multiline === true,
    critical: f.critical_for_visit === true,
    section: String(f.section || '').trim(),
    options: Array.isArray(f.options) ? f.options.map(String) : [],
  })
  return [...shown.filter(f => f.critical_for_visit).map(row), ...shown.filter(f => !f.critical_for_visit).map(row)]
})()

const CRITICAL_GROUP_TITLE = vocabWord('form.group_critical', 'Needed before a team can visit')
const UNSECTIONED_GROUP_TITLE = vocabWord('form.group_other', 'More detail')
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

const ERROR_SENTENCES = {
  need_ref_or_phone: () => 'Please enter your reference number, or your phone number.',
  ref_unknown: (ref, esc) => `We could not find the reference "${esc(ref)}". Please check it against your messages, or enter your phone number instead.`,
  phone_shape: () => 'That does not look like a South African phone number. Please write it as 0821234567 or +27821234567.',
  frozen: () => `This ${ENTITY} is not taking updates on this page at the moment. Reply on the same app you first reported from and the team will get it.`,
  save_failed: () => 'Your answers were not saved. They are still in the boxes below, so you can press Send details again. If it keeps failing, reply on the app you first reported from instead.',
  unexpected: () => `This page could not finish that. Your answers are still in the boxes below -- press Send details to try again. If it keeps failing, reply on the app you first reported from and your ${ENTITY} will still reach the team.`,
}
function errorSentence(code, ref, esc, retryAfter) {
  if (code === 'rate') {
    return `This connection has made too many requests in the last minute -- in some areas many phones share one connection. Please wait about ${retryAfter} seconds and try again.`
  }
  const fn = ERROR_SENTENCES[code]
  return fn ? fn(ref, esc) : ERROR_SENTENCES.unexpected()
}
export function errorCode(value) {
  const s = String(value || '')
  return (s === 'rate' || Object.prototype.hasOwnProperty.call(ERROR_SENTENCES, s)) ? s : ''
}

export function publicFormHtml(esc, { ref = '', phone = '', caseRow = null, done = false, err = '', values = null, held = 0, cut = 0, none = false, retryAfter = 0 } = {}) {
  let report = parseReport(caseRow)
  if (values) report = { ...report, ...values }
  const vcTotal = PUBLIC_FIELDS.filter(f => f.critical).length
  const vcFilled = PUBLIC_FIELDS.filter(f => f.critical && report[f.key] != null && String(report[f.key]).trim() !== '').length
  const allFilled = vcTotal === 0 || vcFilled >= vcTotal
  const progressBar = (caseRow && vcTotal > 0) ? `<div class="progress-wrap">
      <div class="progress-label">${allFilled ? 'All essential details filled. Thank you.' : `Essential details: ${vcFilled} of ${vcTotal} filled`}</div>
      <div class="progress-track" aria-hidden="true"><div class="progress-bar${allFilled ? ' done' : ''}" style="width:${Math.round(vcFilled/vcTotal*100)}%"></div></div>
    </div>` : ''
  const fieldHtml = ({ key, label, hint, multiline, critical, options = [] }) => {
    const id = 'f-' + esc(key)
    const hintId = hint ? id + '-hint' : ''
    const val = esc(report[key] || '')
    const placeholder = hint ? ` placeholder="${esc(hint)}"` : ''
    const describedBy = hintId ? ` aria-describedby="${hintId}"` : ''
    const listed = options.find(o => o.toLowerCase() === String(report[key] || '').trim().toLowerCase())
    const otherOn = !!String(report[key] || '').trim() && !listed
    const inp = options.length
      ? `<select id="${id}" name="${esc(key)}"${describedBy}><option value="">${esc(vocabWord('ui.pick_one', 'Choose one'))}</option>${options.map(o => `<option value="${esc(o)}"${listed === o ? ' selected' : ''}>${esc(o.charAt(0).toUpperCase() + o.slice(1))}</option>`).join('')}<option value="${OTHER_CHOICE}"${otherOn ? ' selected' : ''}>${esc(vocabWord('ui.other_write_it', 'Other (write it)'))}</option></select>`
        + `<label class="other-lab" for="${id}-other">${esc(vocabWord('form.other_write_label', 'If Other, write it here'))}</label><input id="${id}-other" type="text" name="${esc(key)}__other" value="${otherOn ? val : ''}" maxlength="500">`
      : multiline
      ? `<textarea id="${id}" name="${esc(key)}" rows="3"${placeholder}${describedBy} maxlength="${FIELD_MAXLEN}">${val}</textarea>`
      : `<input id="${id}" type="text" name="${esc(key)}"${placeholder}${describedBy} value="${val}" maxlength="500">`
    const vcMark = critical ? ' <span class="req" aria-hidden="true">*</span><span class="vh"> (essential)</span>' : ''
    const hintHtml = hint ? `<span class="vh" id="${hintId}">${esc(hint)}</span>` : ''
    return `<div class="field${critical ? ' vc' : ''}"><label for="${id}">${esc(label)}${vcMark}</label>${inp}${hintHtml}</div>`
  }
  const stepOffset = caseRow ? 0 : 1
  const groupCards = PUBLIC_GROUPS.map((g, i) => {
    const n = i + 1 + stepOffset
    const count = `${g.fields.length} question${g.fields.length === 1 ? '' : 's'}`
    return `<section class="grp${g.critical ? ' vc' : ''}">
      <h2 class="grp-head"><span class="grp-n" aria-hidden="true">${n}</span><span class="grp-title">${esc(g.title)}</span> <span class="grp-count">${count}</span></h2>
      ${g.fields.map(fieldHtml).join('')}
    </section>`
  }).join('')
  const heldNote = held > 0
    ? (held === 1
      ? ' One of your answers was for a question we already have an answer to. An update sent without a reference number can add what is missing but cannot change what is already recorded, so if that answer is wrong, reply on the app you first reported from and say so.'
      : ` ${held} of your answers were for questions we already have answers to. An update sent without a reference number can add what is missing but cannot change what is already recorded, so if any of them are wrong, reply on the app you first reported from and say so.`)
    : ''
  const cutNote = cut > 0
    ? ` ${cut} of your answers ${cut === 1 ? 'was' : 'were'} longer than the ${FIELD_MAXLEN} characters a field holds, so the end ${cut === 1 ? 'was' : 'were'} cut off. Send anything that is missing as a message on the app you first reported from.`
    : ''
  const banner = done
    ? (none
      ? `<div class="banner ok" role="status">We found your ${esc(ENTITY)}. You did not fill in any answers this time, so nothing on it has changed.</div>`
      : `<div class="banner ok" role="status">Your answers are saved on ${esc(ENTITY === 'report' ? 'your report' : `your ${ENTITY}`)}. Keep your reference -- you can come back to this page and add more at any time.${heldNote}${cutNote}</div>`)
    : err ? `<div class="banner err" role="alert">${errorSentence(err, ref, esc, retryAfter)}</div>` : ''
  const caseInfo = caseRow
    ? `<div class="case-info"><strong>Reference: ${esc(caseRow.ref)}</strong> &ndash; ${esc(caseRow.subject || `Field ${ENTITY}`)}
         <button type="button" class="copy-link-btn" data-ref="${esc(caseRow.ref)}">Share link</button></div>`
    : ''
  const refBlock = caseRow ? `<input type="hidden" name="ref" value="${esc(ref)}">` : `
      <section class="grp vc">
      <h2 class="grp-head"><span class="grp-n" aria-hidden="true">1</span><span class="grp-title">Find your ${esc(ENTITY)}</span> <span class="grp-count">2 questions</span></h2>
      <div class="field"><label for="f-find-ref">Your reference number</label>
      <input id="f-find-ref" type="text" name="ref" value="${esc(ref)}" maxlength="50" aria-describedby="f-find-ref-hint">
      <div class="hint" id="f-find-ref-hint">Copy it from the message you were sent when you first reported. If you do not have it, enter your phone number below instead.</div></div>
      <div class="field"><label for="f-find-phone">Or your phone number</label>
      <input id="f-find-phone" type="tel" name="phone" value="${esc(phone)}" placeholder="0821234567" maxlength="30" autocomplete="tel" aria-describedby="f-find-phone-hint">
      <div class="hint" id="f-find-phone-hint">A South African number. We use this to find your ${esc(ENTITY)}.</div></div>
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
  .other-lab{margin-top:var(--space-2);font-weight:400}
  .req{color:${BRAND.accent};font-weight:700}
  /* input[type=tel] is named explicitly. It used to fall outside this
     selector, so the phone field alone rendered at the browser's own default
     (13.33px measured in Chrome) -- visibly smaller than every other field,
     and under the 16px floor below which iOS Safari zooms the page on focus,
     which on a narrow phone throws the rest of the form off screen. The
     16px here is that floor, not a taste. */
  input[type=text],input[type=tel],textarea,select{width:100%;border:1px solid #c8d0da;border-radius:6px;
    padding:var(--space-2-75) var(--space-2-75);font-size:var(--fs-body);font-family:inherit;
    background:#fff;color:#1a1f29;min-height:44px;-webkit-appearance:none}
  input:focus,textarea:focus,select:focus{outline:2px solid ${BRAND.ground};border-color:${BRAND.ground}}
  textarea{resize:vertical;min-height:80px;line-height:var(--lh-base)}
  button[type=submit]{width:100%;background:${BRAND.ground};color:${BRAND.ink};border:0;border-radius:8px;
    padding:var(--space-2-75);font-size:var(--fs-body);font-weight:600;cursor:pointer;
    margin-top:var(--space-2);min-height:52px}
  button[type=submit]:hover{background:${BRAND.hover}}
  button:disabled{opacity:.6;cursor:default}
  .req-note{font-size:var(--fs-micro);color:#495662;margin:0 0 var(--space-2)}
  /* WHAT SENDING ACTUALLY DOES, under the control that does it. The page
     asked twenty-six questions and then offered a button, with the only
     statement of what happens next living on the page AFTER the answer had
     already gone. Somebody deciding whether a long form is worth starting
     needs that before they start, and this deliberately promises no time, no
     visit and no named person -- none of which this system can commit to. */
  .next{font-size:var(--fs-tiny);color:#495662;line-height:var(--lh-base);margin:var(--space-2-5) 0 0}
  .copy-link-btn{background:none;border:1px solid ${BRAND.edge};border-radius:5px;color:${BRAND.accent};
    font-size:var(--fs-micro);padding:var(--space-half) var(--space-2);cursor:pointer;
    margin-left:var(--space-2);vertical-align:middle}
  .copy-link-btn:hover{background:#fff}
  .field-err{font-size:var(--fs-micro);color:#a00;margin-top:var(--space-1);display:none}
  .field-err.show{display:block}
  .draft-note{font-size:var(--fs-micro);color:#5a6674;margin:0 0 var(--space-2);display:none}
  .draft-note.show{display:block}
  /* A control that clears twenty-four answers has to be reachable by a thumb
     without hitting it by accident. It was 16px tall, inline in a sentence;
     the padding takes the touch target to the 44px floor while the underlined
     text still reads as part of the note it sits in. */
  .draft-clear{background:none;border:0;padding:var(--space-2-5) var(--space-2);margin-left:var(--space-1);
    min-height:44px;color:${BRAND.accent};
    font-size:var(--fs-micro);font-family:inherit;text-decoration:underline;cursor:pointer}
  /* Read by a screen reader, occupies nothing on screen. Carries the word
     "essential" behind each asterisk and the per-field hint that is otherwise
     only a placeholder. clip-path rather than display:none or visibility, both
     of which take a node out of the accessibility tree entirely. */
  .vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
    clip-path:inset(50%);white-space:nowrap;border:0}
  footer{text-align:center;font-size:var(--fs-micro);color:#495662;margin-top:var(--space-4)}
</style></head><body>
<header class="topbar"><div class="topbar-in">${esc(BRAND.name)}</div></header>
<div class="wrap">
  <!-- A real <main> landmark, so the page has one. The header above it is a
       banner and the footer below it a contentinfo, but the twenty-six
       questions between them were in an unnamed div: a screen reader's
       landmark list offered no way to jump to the form, and there is no skip
       link on this page either. <main> is a block element with no styling of
       its own here, so the layout is unchanged; the footer stays OUTSIDE it,
       since a <footer> nested in <main> stops being a contentinfo landmark. -->
  <main>
  <h1>Your ${esc(ENTITY)} details</h1>
  <p class="sub">Please fill in as many details as you can. Fields marked * are needed before a team can visit. You can leave anything you do not know blank.</p>
  ${banner}${caseInfo}${progressBar}
  <form method="POST" action="/report">
    ${refBlock}
    ${groupCards}
    <p class="req-note">* Essential for a field visit</p>
    <p class="draft-note" id="draft-note" aria-live="polite">Your answers are kept in this tab until you send them. </p>
    <button type="submit">Send details</button>
    <p class="next">Your answers go onto your ${esc(ENTITY)} for the team who work these. If they need to ask you something they will use the phone number on it. You can open this page again with your reference number and add more whenever you find something out.</p>
  </form>
  </main>
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
    // Appended, never assigned: the field already points at its own hint, and
    // overwriting that attribute would trade one description for the other.
    phoneEl.setAttribute('aria-describedby', ((phoneEl.getAttribute('aria-describedby') || '') + ' phone-err').trim())
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
  const fields = () => [...form.querySelectorAll('input[type=text],input[type=tel],textarea,select')]
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

const REPORT_WRITE_LIMIT = 10
const REPORT_READ_LIMIT = 40
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
      b = { reads: 0, writes: 0, windowStart: now }
      reportRateBuckets.set(ip, b)
    }
    const writing = req.method === 'POST'
    if (writing) b.writes++
    else b.reads++
    if (writing ? b.writes > REPORT_WRITE_LIMIT : b.reads > REPORT_READ_LIMIT) {
      const retryAfter = Math.max(1, Math.ceil((REPORT_RATE_WINDOW_MS - (now - b.windowStart)) / 1000))
      res.set('Retry-After', String(retryAfter))
      const ref = String((req.body && req.body.ref) || req.query.ref || '').slice(0, 50).trim()
      return res.status(429).type('html').send(publicFormHtml(esc, { ref, err: 'rate', retryAfter }))
    }
    next()
  }
}

export function getReport({ store, esc }) {
  return async (req, res) => {
    const ref = String(req.query.ref || '').slice(0, 50).trim()
    const done = req.query.done === '1'
    const err = errorCode(req.query.err)
    const countParam = (v) => Math.min(99, Math.max(0, parseInt(v, 10) || 0))
    const held = countParam(req.query.held)
    const cut = countParam(req.query.cut)
    const none = req.query.none === '1'
    if (!ref) return res.type('html').send(publicFormHtml(esc, { done, err, held, cut, none }))
    try {
      const found = await store.getCaseByRef(ref)
      if (!found) return res.type('html').send(publicFormHtml(esc, { ref, err: err || 'ref_unknown' }))
      res.type('html').send(publicFormHtml(esc, { ref, caseRow: found, done, err, held, cut, none }))
    } catch (e) { res.status(500).type('html').send(publicFormHtml(esc, { ref, err: 'unexpected' })) }
  }
}

export function postReport({ store, esc }) {
  return async (req, res) => {
    const ref = String(req.body.ref || '').slice(0, 50).trim()
    const phoneRaw = String(req.body.phone || '').replace(/[\s\-()]/g, '').slice(0, 30)
    const submitted = {}
    for (const { key, options } of PUBLIC_FIELDS) {
      let v = req.body[key]
      if (options.length && v === OTHER_CHOICE) v = req.body[key + '__other']
      if (v == null || typeof v !== 'string') continue
      const trimmed = v.trim()
      if (trimmed) submitted[key] = trimmed
    }
    const rejected = (err, { caseRow = null, showRef = ref, status = 400 } = {}) => res.status(status).type('html')
      .send(publicFormHtml(esc, { ref: showRef, phone: String(req.body.phone || '').slice(0, 30), caseRow, err, values: submitted }))
    if (!ref && !phoneRaw) return rejected('need_ref_or_phone')
    try {
      let found = null
      let openedHere = false
      if (ref) {
        found = await store.getCaseByRef(ref)
        if (!found) return rejected('ref_unknown')
      } else {
        const validPhone = /^0[0-9]{9}$/.test(phoneRaw) || /^\+27[0-9]{9}$/.test(phoneRaw)
        if (!validPhone) return rejected('phone_shape')
        const normPhone = phoneRaw.startsWith('0') ? '+27' + phoneRaw.slice(1) : phoneRaw
        const { case: nc, created } = await store.findOrCreateCase({ channel: 'web', external_id: normPhone, contact: { phone: normPhone }, subject: `Field ${ENTITY} via web form` })
        found = nc
        openedHere = created === true
        if (openedHere) {
          try {
            await store.updateCase(nc.id, { tags: mergeTag(nc.tags, 'intake_mode:public_form') }, { id: 'contact', role: 'contact' })
          } catch {  }
          await store.appendEvent(nc.id, { kind: 'note', actor: 'system', text: 'Case created via public web form (phone number entry)' })
        }
      }
      let cut = 0
      const incoming = {}
      for (const [key, value] of Object.entries(submitted)) {
        if (value.length > FIELD_MAXLEN) cut++
        incoming[key] = value.slice(0, FIELD_MAXLEN)
      }
      let held = 0
      if (!ref && !openedHere) {
        const already = parseReport(found)
        for (const k of Object.keys(incoming)) {
          if (already[k] != null && String(already[k]).trim() !== '') { delete incoming[k]; held++ }
        }
      }
      if (Object.keys(incoming).length) {
        const mergeResult = await store.mergeReport(found.id, incoming, { id: 'contact', role: 'contact' })
        const ownRef = ref || (openedHere ? (found?.ref || '') : '')
        const ownRow = ownRef ? found : null
        if (mergeResult.error === 'observe') return rejected('frozen', { caseRow: ownRow, showRef: ownRef })
        if (mergeResult.error) return rejected('save_failed', { caseRow: ownRow, showRef: ownRef })
        const changedFields = Object.keys(incoming).map((k) => fieldLabel(k) || k).join(', ')
        await store.appendEvent(found.id, { kind: 'action', actor: 'contact', text: `contact updated ${ENTITY} via web form: ${changedFields}`, data: incoming })
        try {
          await store.updateCase(found.id, { tags: mergeTag(found.tags, 'intake_mode:public_form') }, { id: 'contact', role: 'contact' })
        } catch {  }
      }
      const showRef = ref || (openedHere ? (found?.ref || '') : '')
      const notes = (held ? '&held=' + held : '') + (cut ? '&cut=' + cut : '')
        + (Object.keys(submitted).length ? '' : '&none=1')
      res.redirect((showRef ? '/report?ref=' + encodeURIComponent(showRef) + '&done=1' : '/report?done=1') + notes)
    } catch (e) { rejected('unexpected', { status: 500 }) }
  }
}

const READY_PROBE_TIMEOUT_MS = 1500
const READY_CACHE_MS = 2000
const readyResolve = async (v) => (typeof v === 'function' ? await v() : v)
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
  const capabilities = {
    llm: llmStatus != null,
    receive: receiveStatus != null,
    queue: queueStatus != null,
    sweep: runSweep != null,
    reply: sendReply != null,
    runtime: runtimeStatus != null,
  }
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
    const isBusy = (e) => /SQLITE_BUSY|database is locked|database table is locked/i.test(String(e?.message || e))
    let storeState = 'ok'
    try {
      try { await store.countCases({}) }
      catch (e) {
        if (!isBusy(e)) throw e
        await new Promise(r => setTimeout(r, 75))
        try { await store.countCases({}) }
        catch (e2) { if (!isBusy(e2)) throw e2; storeState = 'busy' }
      }
    } catch (e) {
      return res.status(503).json({
        ready: false, store: 'unreachable', degraded: true, degraded_reasons: ['store_unreachable'],
        error: String(e.message || e).slice(0, 200),
      })
    }
    const took_ms = Date.now() - started
    let snapshot
    try { snapshot = await degradationSnapshot() }
    catch { snapshot = { degraded: true, degraded_reasons: ['checks_unavailable'], checks: { store: 'ok', llm: 'no_answer', gateway: 'no_answer', runtime: 'no_answer', queue: null } } }
    res.json({ ready: true, store: storeState, took_ms, ...snapshot, capabilities })
  }
}

const LOGIN_FAILS = new Map()
const LOGIN_WINDOW_MS = 15 * 60e3
const loginFails = (k, now) => { const l = (LOGIN_FAILS.get(k) || []).filter(t => now - t < LOGIN_WINDOW_MS); if (l.length) LOGIN_FAILS.set(k, l); else LOGIN_FAILS.delete(k); return l }
const DECOY = { salt: 'decoy-salt-0000000000000000000000', hash: '00'.repeat(64) }

export function postLogin({ store, findAccountByUsername, verifyPassword, issueSession, sessionCookieHeader, markLogin }) {
  return async (req, res) => {
    const { username, password } = req.body || {}
    const now = Date.now()
    const pairKey = `${String(username || '').trim().toLowerCase().slice(0, 60)}|${req.ip}`
    const ipKey = `ip|${req.ip}`
    if (loginFails(pairKey, now).length >= 10 || loginFails(ipKey, now).length >= 60) {
      return res.status(429).json({ error: 'too many attempts; wait a few minutes and try again' })
    }
    const acct = await findAccountByUsername(store, username)
    const ok = acct ? verifyPassword(password, acct.password_salt, acct.password_hash) : (verifyPassword(password, DECOY.salt, DECOY.hash), false)
    if (!acct || acct.disabled === '1' || !ok) {
      for (const k of [pairKey, ipKey]) LOGIN_FAILS.set(k, [...loginFails(k, now), now])
      if (LOGIN_FAILS.size > 5000) for (const k of LOGIN_FAILS.keys()) loginFails(k, now)
      return res.status(401).json({ error: 'invalid username or password' })
    }
    LOGIN_FAILS.delete(pairKey)
    const token = issueSession(acct.id, { epoch: Number(acct.session_epoch) || 0 })
    res.set('Set-Cookie', sessionCookieHeader(token))
    markLogin(store, acct.id).catch(() => {})
    res.json({ ok: true, username: acct.username, display_name: acct.display_name, role: roleOf(acct) })
  }
}

export function postLogout({ clearCookieHeader }) {
  return (req, res) => {
    res.set('Set-Cookie', clearCookieHeader())
    res.json({ ok: true })
  }
}

export function getWhoami() {
  return (req, res) => {
    if (!req.caseyAccount) return res.json({ authed: false })
    const a = req.caseyAccount
    res.json({ authed: true, ...(req.caseyViewAs ? { view_as: { by: req.caseyViewAs.by } } : {}), username: a.username, display_name: a.display_name, role: roleOf(a), contact_linked: !!String(a.contact_phone || '').trim(), must_change_password: a.must_change_password === '1' })
  }
}

export function getBranding() {
  return (req, res) => {
    res.json({ brand: DASHBOARD_UI?.brand || null, leaf: DASHBOARD_UI?.leaf || null })
  }
}

export function postChangePassword({ store, verifyPassword, changePassword, issueSession, sessionCookieHeader }) {
  return async (req, res) => {
    if (!req.caseyAccount) return res.status(401).json({ error: 'unauthorized' })
    try {
      const { current_password, new_password } = req.body || {}
      if (!verifyPassword(current_password, req.caseyAccount.password_salt, req.caseyAccount.password_hash)) {
        return res.status(401).json({ error: 'current password is incorrect' })
      }
      const { epoch } = await changePassword(store, req.caseyAccount.id, new_password)
      res.set('Set-Cookie', sessionCookieHeader(issueSession(req.caseyAccount.id, { epoch })))
      res.json({ ok: true })
    } catch (e) { res.status(400).json({ error: e.message }) }
  }
}

export function authGate() {
  return (req, res, next) => {
    if (req.path.startsWith('/design') || req.path.startsWith('/vendor')) return next()
    if (req.path === '/api/login' || req.path === '/api/logout' || req.path === '/api/whoami') return next()
    if (req.path === '/' || req.path === '/app' || req.path === '/index.html' || req.path === '/app.js' || req.path === '/app.css') return next()
    if (req.path.startsWith('/src/')) return next()
    if (req.path === '/icon.svg' || req.path === '/manifest.json' || req.path === '/sw.js' || req.path === '/offline.html') return next()
    if (req.path.startsWith('/api/sync/')) return next()
    if (!req.caseyAccount) return res.status(401).json({ error: 'unauthorized' })
    if (req.caseyAccount.must_change_password === '1' && req.path !== '/api/change-password') {
      return res.status(403).json({ error: 'must change password before continuing', code: 'must_change_password' })
    }
    next()
  }
}

const ROUTES = [
  ['get', '/api/ready', getReady, { raw: true }],
  ['post', '/api/login', postLogin],
  ['post', '/api/logout', postLogout, { raw: true }],
  ['get', '/api/whoami', getWhoami, { raw: true }],
  ['get', '/api/branding', getBranding, { raw: true }],
  ['post', '/api/change-password', postChangePassword, { raw: true }],
]

export function registerAuth(app, deps) {
  const { store, express, path, DESIGN_DIR, LEAFLET_DIR, MARKERCLUSTER_DIR, esc, PUBLIC_SITE_ROOT } = deps

  app.use(sessionMiddleware(deps))
  app.use(csrfGuard())

  if (process.env.CASEY_PUBLIC_URL) {
    const reportRateLimited = makeReportRateLimiter(esc)
    app.get('/report', reportRateLimited, getReport(deps))
    app.post('/report', reportRateLimited, postReport(deps))
  }

  if (PUBLIC_SITE_ROOT) registerPublicSiteAssets(app, PUBLIC_SITE_ROOT)

  mountRoutes(app, deps, ROUTES)

  app.use(authGate())
  app.use(roleGate(deps))
  app.use(expectedRefGuard(deps))

  app.use('/design', express.static(DESIGN_DIR))
  app.use('/vendor/leaflet', express.static(LEAFLET_DIR))
  app.use('/vendor/leaflet.markercluster', express.static(MARKERCLUSTER_DIR))
  app.use('/media', express.static(path.join(store.dataDir, 'media'), {
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Disposition', 'attachment')
    },
  }))
}
