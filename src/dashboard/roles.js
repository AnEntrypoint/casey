// dashboard/roles.js -- the ONE place that decides what a dashboard login may do.
//
// operator_account.role is one of three families:
//   STAFF  admin | operator | secretary   -- the operator console, unchanged. 'secretary' is a
//          LEGACY alias of 'operator': still accepted so an existing login keeps working and is
//          shown as Operator, but no new account is created with it (auth.js createAccount).
//   FIELD  eco_ranger | animal_health_technician -- the field team's GUI: only
//          their own work, never the running of the team.
//   VIEWER viewer -- UCT and third parties: READ-ONLY, aggregate views only. It
//          reaches no case, contact, number, assignee, account or media at all;
//          its allowlist below is a handful of PII-free aggregate routes.
// resolveRole() is fail-closed: a missing, empty, corrupt or forged role value
// resolves to the LEAST privileged rung (eco_ranger), never to operator. The
// staff roles are matched by exact name, so a new rung added elsewhere can never
// inherit staff power by accident.
//
// Enforcement is a deny-by-default route table (roleGate) that runs after the
// session gate. A staff role passes through untouched (byte-compatible with the
// single-console behaviour); a field role reaches only the rows below, and a
// case-scoped row is checked against THIS account's relationship to THAT case:
//   write  -- the case is assigned to them (operators assign)
//   read   -- they reported it themselves (their linked phone), or, for the
//             technician, it is ready to sign off and nobody holds it
//   none   -- everything else (404, so a probe learns nothing)
import { normalizeMsisdn } from '../role-invites.js'
import { UNCLAIMED_ASSIGNEE } from '../case-store.js'
import { isAssignedTo as contactHoldsCase } from '../case-assignment.js'
import { parseReport, tagList } from '../timestamp.js'
import { RESERVED_TAG } from '../hooks/heuristics.js'
import { inSignOffQueue } from '../signoff-desk.js'
import { MANDATORY_MINIMUM_FIELDS, MANDATORY_MINIMUM_BLOCKED_STATUSES, missingMandatoryMinimum, fieldLabel, REPORT_ENTITY_LABEL, SIGNOFF_DIAGNOSIS_FIELDS, missingSignoffDiagnosis } from '../store/report-shape.js'

export const STAFF_ROLES = ['admin', 'operator', 'secretary']
export const FIELD_ROLES = ['eco_ranger', 'animal_health_technician']
export const VIEWER_ROLES = ['viewer']
export const ACCOUNT_ROLES = [...STAFF_ROLES, ...FIELD_ROLES, ...VIEWER_ROLES]
export const LEAST_PRIVILEGED_ROLE = 'eco_ranger'

export function resolveRole(value) {
  return ACCOUNT_ROLES.includes(value) ? value : LEAST_PRIVILEGED_ROLE
}
export const roleOf = (acct) => resolveRole(acct?.role)
export const isStaffAccount = (acct) => STAFF_ROLES.includes(acct?.role)
export const isFieldAccount = (acct) => !isStaffAccount(acct)
// Exact-name match, like the staff roles: nothing resolves to viewer by accident.
export const isViewer = (acct) => VIEWER_ROLES.includes(acct?.role)
export const isTechnician = (acct) => roleOf(acct) === 'animal_health_technician'

const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '')

// A field login is "assigned" a case two ways: the operator picked its username,
// or the operator picked the team member's WhatsApp contact (case-assignment.js's
// `contact:<id>` key) and this login is linked to that contact by contact_phone.
// resolveContact() runs once per request in roleGate and parks the contact on the
// account object; isAssignedTo() below stays synchronous.
export async function resolveContact(store, acct) {
  const msisdn = normalizeMsisdn(acct?.contact_phone)
  if (!msisdn) return null
  const [row] = await store.t.list('contact', { channel: 'whatsapp', external_id: msisdn }, { limit: 1 })
  return row || null
}

export function isAssignedTo(c, acct) {
  const a = String(c?.assignee || '').trim().toLowerCase()
  // 'agent' is the UNCLAIMED marker, not a person: a login that happens to be named
  // that must never hold every unclaimed case.
  if (!a || a === UNCLAIMED_ASSIGNEE) return false
  if (a === String(acct?.username || '').trim().toLowerCase()) return true
  return contactHoldsCase(c, acct?._contact)
}

// The account's own report: the case's conversation key is the linked number.
export function isOwnReport(c, acct) {
  const p = normalizeMsisdn(acct?.contact_phone)
  return !!p && digits(c?.external_id) === p
}

export const DONE_STATUSES = new Set(['resolved', 'closed', ...MANDATORY_MINIMUM_BLOCKED_STATUSES])
export const isDoneStatus = (s) => DONE_STATUSES.has(String(s || ''))

export function missingFor(c) {
  return missingMandatoryMinimum(parseReport(c))
}

// The sign-off diagnosis still to record, counting what the request itself carries
// (the SPA sends identified_disease / recommended_resolution with the done-stage move).
export function missingDiagnosisFor(c, body) {
  const given = {}
  for (const k of SIGNOFF_DIAGNOSIS_FIELDS) if (typeof body?.[k] === 'string' && body[k].trim()) given[k] = body[k].trim()
  return missingSignoffDiagnosis({ ...parseReport(c), ...given })
}

// The sign-off desk's queue rule lives once in signoff-desk.js (handed over by its
// triage owner, or unheld and complete); this is the same predicate.
export { inSignOffQueue }

// 'write' | 'read' | 'none'
export function caseAccess(c, acct, { unclaimedKey = 'agent' } = {}) {
  if (!c) return 'none'
  if (isStaffAccount(acct)) return 'write'
  // The settings / invite / erasure singletons are stored as channel 'system' cases: never a report.
  if (c.channel === 'system') return 'none'
  if (isAssignedTo(c, acct)) return 'write'
  if (isOwnReport(c, acct)) return 'read'
  if (isTechnician(acct) && inSignOffQueue(c, unclaimedKey)) return 'read'
  return 'none'
}

export const canSeeCase = (c, acct, o) => caseAccess(c, acct, o) !== 'none'

// The reporter's number is shown only where the account is working the case.
export function detailForAccess(detail, access) {
  if (access === 'write' || !detail) return detail
  const { external_id_formatted, ...rest } = detail
  return rest
}

const PATCH_KEYS_FIELD = new Set(['subject', 'summary', 'priority', 'tags', 'case_type', 'reason', 'expected', 'expected_ref'])

// [method, pattern, rule]. rule: 'open' (no case), or { access: 'read'|'write'|'signoff', tech?: true }
const CASE = '/api/cases/([^/]+)'
const FIELD_ROUTES = [
  ['GET', /^\/api\/config$/, 'open'],
  ['GET', /^\/api\/operators$/, 'open'],
  ['POST', /^\/api\/logout-everywhere$/, 'open'],
  ['POST', /^\/api\/feedback$/, 'open'],
  ['GET', /^\/api\/cases$/, 'scoped-list'],
  ['POST', /^\/api\/cases$/, 'open'],
  ['GET', /^\/api\/map\/cases$/, 'scoped-list'],
  ['GET', new RegExp(`^${CASE}$`), { access: 'read' }],
  ['GET', new RegExp(`^${CASE}/events$`), { access: 'read' }],
  ['PATCH', new RegExp(`^${CASE}$`), { access: 'write', patch: true }],
  ['POST', new RegExp(`^${CASE}/intake$`), { access: 'write', intake: true }],
  ['POST', new RegExp(`^${CASE}/note$`), { access: 'write' }],
  // "Show in English" on one message the reporter sent (routes/translate.js): write access only, never read-only.
  ['POST', new RegExp(`^${CASE}/events/([^/]+)/translate$`), { access: 'write' }],
  ['POST', new RegExp(`^${CASE}/reply$`), { access: 'write' }],
  ['POST', new RegExp(`^${CASE}/remind$`), { access: 'write' }],
  ['POST', new RegExp(`^${CASE}/location$`), { access: 'write' }],
  ['POST', new RegExp(`^${CASE}/transition$`), { access: 'write', transition: true }],
  ['POST', new RegExp(`^${CASE}/send-back$`), { access: 'signoff', tech: true }],
  // Hand a full record to the sign-off desk: a write on a case assigned to the login.
  ['POST', new RegExp(`^${CASE}/handoff$`), { access: 'write' }],
  // The login's OWN day (routes/areas.js): identity comes from the session, never a parameter.
  ['GET', /^\/api\/my-day$/, 'open'],
]

const deny = (res, status, error, code) => res.status(status).json({ error, code })

// What ONLY an admin may do. An operator runs the day (cases, replies, assignments, the team's sign-ups); an admin also runs the
// system: who has a login, how the thresholds are set, which areas exist and who covers them, imports and syncs, the audit trail,
// the runtime, and erasing a person. Enforced here, ahead of the route (and several routes check isAdmin again for their own
// finer rules, e.g. who may be made an operator). Deny-by-default for operator and the legacy secretary alias; admin passes.
export const ADMIN_ONLY_ROUTES = [
  ['GET', /^\/api\/accounts$/], ['POST', /^\/api\/accounts(\/.*)?$/], ['DELETE', /^\/api\/accounts\/[^/]+$/],
  ['PUT', /^\/api\/thresholds$/], ['POST', /^\/api\/sweep$/],
  ['PUT', /^\/api\/areas$/], ['DELETE', /^\/api\/areas\/[^/]+$/],
  ['POST', /^\/api\/sync\/(import|external-links)$/],
  ['POST', /^\/api\/field-values\/canonicalize$/],
  ['GET', /^\/api\/audit\.csv$/], ['GET', /^\/api\/runtime$/], ['GET', /^\/api\/health\/provider$/], ['GET', /^\/api\/turns\/degraded$/],
  ['POST', /^\/api\/roles\/import$/], ['DELETE', /^\/api\/role-invites\/[^/]+$/],
  ['POST', /^\/api\/contacts\/[^/]+\/erase$/], ['POST', /^\/api\/contacts\/[^/]+\/persons\/erase$/],
]
export const isAdminOnlyRoute = (method, path) => ADMIN_ONLY_ROUTES.some(([m, re]) => m === method && re.test(path))
export const isAdminAccount = (acct) => acct?.role === 'admin'

// A preview ("view as", below) is read-only: the admin sees a login's screens and data and changes nothing as it.
const PREVIEW_OK = new Set(['/api/whoami', '/api/logout', '/api/logout-everywhere', '/api/login'])

// The viewer's whole reach. Deny by default: a viewer gets these exact method+path
// pairs and NOTHING else under /api or /media. Audited one by one (a route is here
// only when its payload is proven PII-free):
//   /api/config, /api/logout-everywhere   no case data (settings, labels; a self-only session action)
//   /api/overview                         counts by stage, per-day totals, medians: no row, no name
//   /api/reports/*                        reports-map.js: k-anonymised, allowlist-projected, no ref/id/name/number
// Refused on purpose (each carries a person or an identifiable small group):
//   /api/stats (intake-mode ops detail, not needed), /api/geo + /api/distribution (open-case place and
//   symptom rollups, not disease-signed-off and not k-folded by disease), /api/clusters (member refs),
//   /api/report.csv|json|html (operator names and workload), /api/cases/export.csv and everything
//   under /api/cases, /api/contacts, /api/accounts, /api/team-members, /api/map/*, /media.
const VIEWER_ROUTES = [
  ['GET', /^\/api\/config$/],
  ['GET', /^\/api\/overview$/],
  ['POST', /^\/api\/logout-everywhere$/],
  ['GET', /^\/api\/reports\/(resolved-map|diseases|heat|export\.csv)$/],
]

function viewerGate(req, res, next) {
  const lp = req.path.toLowerCase()
  // Media is never a viewer's, whatever the spelling (Express matches '/MEDIA' too).
  if (lp.startsWith('/media')) return deny(res, 404, 'not found')
  if (!lp.startsWith('/api/') && lp !== '/api') return next()   // shell assets and tiles carry no case data
  if (req.path === '/api/whoami' || req.path === '/api/logout' || req.path === '/api/change-password' || req.path === '/api/login') return next()
  if (VIEWER_ROUTES.some(([m, re]) => m === req.method && re.test(req.path))) { req.caseyRole = 'viewer'; return next() }
  return deny(res, 403, 'This is not available for your login.', 'role_forbidden')
}

export function roleGate({ store, UNCLAIMED_ASSIGNEE }) {
  return async (req, res, next) => {
    try {
      const acct = req.caseyAccount
      if (!acct) return next()              // the session gate owns the 401
      if (req.caseyViewAs && req.method !== 'GET' && !PREVIEW_OK.has(req.path)) return deny(res, 403, 'You are previewing another login: this is read-only. Leave the preview to make changes.', 'preview_read_only')
      if (isStaffAccount(acct)) {
        if (!isAdminAccount(acct) && isAdminOnlyRoute(req.method, req.path)) return deny(res, 403, 'Only an admin can do this.', 'admin_only')
        return next()
      }
      if (isViewer(acct)) return viewerGate(req, res, next)
      req.caseyRole = roleOf(acct)
      acct._contact = await resolveContact(store, acct)
      const p = req.path
      // Photo and voice-note bytes: /media/<caseId>/<file>, scoped like the case.
      // Express matches routes case-insensitively, so '/API/contacts' reaches the
      // very handlers '/api/contacts' does: decide on the lower-cased prefix, and let
      // the exact-case route table below refuse every spelling it does not list.
      const lp = p.toLowerCase()
      if (lp.startsWith('/media/')) {
        // The file server resolves the DECODED path, so the case checked must be the one
        // that path lands in: exactly /media/<caseId>/<file>, decoded, with no dot segment,
        // separator or backslash left to walk out of <caseId> into another case's folder
        // ('/media/<mine>/../<theirs>/f' passed a check made on the raw second segment).
        let decoded = ''
        try { decoded = decodeURIComponent(p) } catch { return deny(res, 404, 'not found') }
        const m = /^\/media\/([^/\\]+)\/([^/\\]+)$/.exec(decoded)
        if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..' || decoded.includes('\0')) return deny(res, 404, 'not found')
        const c = await store.getCase(m[1])
        return caseAccess(c, acct, { unclaimedKey: UNCLAIMED_ASSIGNEE }) === 'none' ? deny(res, 404, 'not found') : next()
      }
      if (!lp.startsWith('/api/') && lp !== '/api') return next()   // shell assets carry no case data
      // Routes exempted from the session gate (login, sync) never reach here with
      // a field session that matters; whoami/logout/change-password are ungated
      // or self-only and must stay reachable.
      if (p === '/api/whoami' || p === '/api/logout' || p === '/api/change-password' || p === '/api/login') return next()
      let hit = null
      for (const [m, re, rule] of FIELD_ROUTES) {
        if (m !== req.method) continue
        const mm = re.exec(p)
        if (mm) { hit = { rule, id: mm[1] ? decodeURIComponent(mm[1]) : null }; break }
      }
      if (!hit) return deny(res, 403, 'This is not available for your login.', 'role_forbidden')
      const { rule, id } = hit
      if (rule === 'open') return next()
      if (rule === 'scoped-list') { req.caseyScoped = true; return next() }
      if (rule.tech && !isTechnician(acct)) return deny(res, 403, 'Only an animal health technician can do this.', 'role_forbidden')
      const c = await store.getCase(id)
      const access = caseAccess(c, acct, { unclaimedKey: UNCLAIMED_ASSIGNEE })
      if (access === 'none') return deny(res, 404, 'not found')
      req.caseyAccess = access
      const b = req.body || {}
      if (rule.access === 'write' && access !== 'write') {
        // A technician may also move a case that is waiting in the sign-off queue (done stages
        // are then gated below on the mandatory minimum).
        const signOffMove = rule.transition && isTechnician(acct) && inSignOffQueue(c, UNCLAIMED_ASSIGNEE)
        if (!signOffMove) return deny(res, 403, 'This case is not assigned to you, so you can look but not change it.', 'not_assigned')
      }
      if (rule.access === 'signoff' && access === 'read' && !(isTechnician(acct) && inSignOffQueue(c, UNCLAIMED_ASSIGNEE))) {
        return deny(res, 403, 'This case is not assigned to you, so you can look but not change it.', 'not_assigned')
      }
      // The diagnosis is the technician's, recorded with the sign-off: a ranger's intake
      // form does not carry it in.
      if (rule.intake && !isTechnician(acct) && SIGNOFF_DIAGNOSIS_FIELDS.some(k => k in b)) {
        return deny(res, 403, 'The animal health technician records the diagnosis, when signing the report off.', 'role_forbidden')
      }
      if (rule.patch) {
        const bad = Object.keys(b).filter(k => !PATCH_KEYS_FIELD.has(k))
        if (bad.length) return deny(res, 403, 'You cannot change who a case is assigned to or how it is handled.', 'role_forbidden')
        // The system's own tags (a STOP, a hand-off, a held draft) are not a field login's to add or drop.
        if ('tags' in b) {
          const sys = (list) => list.map(t => String(t).trim().toLowerCase()).filter(t => RESERVED_TAG.test(t)).sort().join('|')
          if (typeof b.tags !== 'string' || sys(tagList(c)) !== sys(String(b.tags).split(','))) return deny(res, 403, 'Those tags are set by the system itself and cannot be changed by hand.', 'role_forbidden')
        }
      }
      if (rule.transition && isDoneStatus(b.to) && b.to !== c.status) {
        if (!isTechnician(acct)) return deny(res, 403, 'Only an animal health technician can sign a case off.', 'signoff_forbidden')
        const missing = missingFor(c)
        if (missing.length) return deny(res, 400, `Cannot sign off yet: still missing ${missing.map(fieldLabel).join(', ')}.`, 'missing_minimum')
        // Third and separate: the diagnosis. Staff closing a case from the console are not
        // asked for it (they never reach this branch).
        const noDiagnosis = missingDiagnosisFor(c, b)
        if (noDiagnosis.length) return deny(res, 400, `Cannot sign off yet: ${noDiagnosis.map(fieldLabel).join(' and ')} ${noDiagnosis.length === 1 ? 'is' : 'are'} not recorded.`, 'missing_diagnosis')
      }
      next()
    } catch (e) {
      // Fail closed on any unexpected error while deciding.
      deny(res, 500, 'could not check access', 'gate_error')
    }
  }
}

// A write that names the case it believes it is writing to (`expected_ref`) is
// refused with 409 when that is not the reference of the case id in the URL, so
// a stale tab or a wrong-case click can never land on a different case. Optional:
// a caller that sends none behaves exactly as before. Applies to every role.
const REF_GUARDED = /^\/api\/cases\/([^/]+)\/(intake|note|transition|reply|remind|location|send-back|relocate|handoff)$|^\/api\/cases\/([^/]+)$|^\/api\/cases\/([^/]+)\/events\/[^/]+\/translate$/
export function expectedRefGuard({ store }) {
  return async (req, res, next) => {
    try {
      const want = req.body && req.body.expected_ref
      if (want == null || !(req.method === 'POST' || req.method === 'PATCH')) return next()
      const m = REF_GUARDED.exec(req.path)
      if (!m || (m[3] && req.method !== 'PATCH')) return next()
      const c = await store.getCase(decodeURIComponent(m[1] || m[3] || m[4]))
      if (!c) return next()   // the route answers its own 404
      if (typeof want !== 'string' || want.trim() !== String(c.ref)) {
        return res.status(409).json({ error: `This screen is showing a different ${REPORT_ENTITY_LABEL} from the one being changed (expected ${String(want).slice(0, 40)}, this is ${c.ref}). Nothing was saved -- reload and open the right one.`, code: 'wrong_case' })
      }
      next()
    } catch (e) { res.status(500).json({ error: 'could not check which case this is', code: 'gate_error' }) }
  }
}

export { MANDATORY_MINIMUM_FIELDS }
