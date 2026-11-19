import { normalizeMsisdn } from '../role-invites.js'
import { UNCLAIMED_ASSIGNEE } from '../case-store.js'
import { isAssignedTo as contactHoldsCase } from '../case-assignment.js'
import { parseReport, tagList } from '../timestamp.js'
import { RESERVED_TAG } from '../hooks/heuristics.js'
import { inSignOffQueue } from '../signoff-desk.js'
import { MANDATORY_MINIMUM_FIELDS, MANDATORY_MINIMUM_BLOCKED_STATUSES, missingMandatoryMinimum, fieldLabel, REPORT_ENTITY_LABEL, SIGNOFF_DIAGNOSIS_FIELDS, missingSignoffDiagnosis } from '../store/report-shape.js'

import { FIELD_ROLES, SPECIALIST_ROLE, LEAST_PRIVILEGED_FIELD_ROLE } from '../domain-roles.js'
import { caseyText } from '../deployment-text.js';

export const STAFF_ROLES = ['admin', 'operator', 'secretary']
export { FIELD_ROLES }
export const VIEWER_ROLES = ['viewer']
export const ACCOUNT_ROLES = [...STAFF_ROLES, ...FIELD_ROLES, ...VIEWER_ROLES]
export const LEAST_PRIVILEGED_ROLE = LEAST_PRIVILEGED_FIELD_ROLE

export function resolveRole(value) {
  return ACCOUNT_ROLES.includes(value) ? value : LEAST_PRIVILEGED_ROLE
}
export const roleOf = (acct) => resolveRole(acct?.role)
export const isStaffAccount = (acct) => STAFF_ROLES.includes(acct?.role)
export const isFieldAccount = (acct) => !isStaffAccount(acct)
export const isViewer = (acct) => VIEWER_ROLES.includes(acct?.role)
export const isSpecialist = (acct) => roleOf(acct) === SPECIALIST_ROLE

const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '')

export async function resolveContact(store, acct) {
  const msisdn = normalizeMsisdn(acct?.contact_phone)
  if (!msisdn) return null
  const [row] = await store.t.list('contact', { channel: 'whatsapp', external_id: msisdn }, { limit: 1 })
  return row || null
}

export function isAssignedTo(c, acct) {
  const a = String(c?.assignee || '').trim().toLowerCase()
  if (!a || a === UNCLAIMED_ASSIGNEE) return false
  if (a === String(acct?.username || '').trim().toLowerCase()) return true
  return contactHoldsCase(c, acct?._contact)
}

export function isOwnReport(c, acct) {
  const p = normalizeMsisdn(acct?.contact_phone)
  return !!p && digits(c?.external_id) === p
}

export const DONE_STATUSES = new Set(['resolved', 'closed', ...MANDATORY_MINIMUM_BLOCKED_STATUSES])
export const isDoneStatus = (s) => DONE_STATUSES.has(String(s || ''))

export function missingFor(c) {
  return missingMandatoryMinimum(parseReport(c))
}

export function missingDiagnosisFor(c, body) {
  const given = {}
  for (const k of SIGNOFF_DIAGNOSIS_FIELDS) if (typeof body?.[k] === 'string' && body[k].trim()) given[k] = body[k].trim()
  return missingSignoffDiagnosis({ ...parseReport(c), ...given })
}

export { inSignOffQueue }

export function caseAccess(c, acct, { unclaimedKey = 'agent' } = {}) {
  if (!c) return 'none'
  if (isStaffAccount(acct)) return 'write'
  if (c.channel === 'system') return 'none'
  if (isAssignedTo(c, acct)) return 'write'
  if (isOwnReport(c, acct)) return 'read'
  if (isSpecialist(acct) && inSignOffQueue(c, unclaimedKey)) return 'read'
  return 'none'
}

export const canSeeCase = (c, acct, o) => caseAccess(c, acct, o) !== 'none'

export function detailForAccess(detail, access) {
  if (access === 'write' || !detail) return detail
  const { external_id_formatted, ...rest } = detail
  return rest
}

const PATCH_KEYS_FIELD = new Set(['subject', 'summary', 'priority', 'tags', 'case_type', 'reason', 'expected', 'expected_ref'])

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
  ['POST', new RegExp(`^${CASE}/events/([^/]+)/translate$`), { access: 'write' }],
  ['POST', new RegExp(`^${CASE}/reply$`), { access: 'write' }],
  ['POST', new RegExp(`^${CASE}/location$`), { access: 'write' }],
  ['POST', new RegExp(`^${CASE}/transition$`), { access: 'write', transition: true }],
  ['POST', new RegExp(`^${CASE}/send-back$`), { access: 'signoff', tech: true }],
  ['POST', new RegExp(`^${CASE}/handoff$`), { access: 'write' }],
  ['POST', new RegExp(`^${CASE}/handoff/withdraw$`), { access: 'write' }],
  ['GET', /^\/api\/my-day$/, 'open'],
]

const deny = (res, status, error, code) => res.status(status).json({ error, code })

export const ADMIN_ONLY_ROUTES = [
  ['GET', /^\/api\/accounts$/], ['POST', /^\/api\/accounts(\/.*)?$/], ['DELETE', /^\/api\/accounts\/[^/]+$/],
  ['PUT', /^\/api\/thresholds$/], ['POST', /^\/api\/sweep$/],
  ['PUT', /^\/api\/areas$/], ['DELETE', /^\/api\/areas\/[^/]+$/],
  ['POST', /^\/api\/sync\/(import|external-links)$/],
  ['POST', /^\/api\/field-values\/canonicalize$/],
  ['GET', /^\/api\/routers$/],
  ['GET', /^\/api\/audit\.csv$/], ['GET', /^\/api\/runtime$/], ['GET', /^\/api\/health\/provider$/], ['GET', /^\/api\/turns\/degraded$/],
  ['POST', /^\/api\/roles\/import$/], ['DELETE', /^\/api\/role-invites\/[^/]+$/],
  ['POST', /^\/api\/contacts\/[^/]+\/erase$/], ['POST', /^\/api\/contacts\/[^/]+\/persons\/erase$/],
]
export const isAdminOnlyRoute = (method, path) => ADMIN_ONLY_ROUTES.some(([m, re]) => m === method && re.test(path))
export const isAdminAccount = (acct) => acct?.role === 'admin'

const PREVIEW_OK = new Set(['/api/whoami', '/api/logout', '/api/logout-everywhere', '/api/login'])

const VIEWER_ROUTES = [
  ['GET', /^\/api\/config$/],
  ['GET', /^\/api\/overview$/],
  ['POST', /^\/api\/logout-everywhere$/],
  ['GET', /^\/api\/reports\/(resolved-map|diseases|diseases\/print|heat|areas|export\.csv|files)$/],
  ['GET', /^\/api\/reports\/files\/[^/]+$/],
]

function viewerGate(req, res, next) {
  const lp = req.path.toLowerCase()
  if (lp.startsWith('/media')) return deny(res, 404, caseyText("src/dashboard/roles.js#w0"))
  if (!lp.startsWith('/api/') && lp !== '/api') return next()
  if (req.path === '/api/whoami' || req.path === '/api/logout' || req.path === '/api/change-password' || req.path === '/api/login') return next()
  if (VIEWER_ROUTES.some(([m, re]) => m === req.method && re.test(req.path))) { req.caseyRole = 'viewer'; return next() }
  return deny(res, 403, caseyText("src/dashboard/roles.js#w1"), 'role_forbidden')
}

export function roleGate({ store, UNCLAIMED_ASSIGNEE }) {
  return async (req, res, next) => {
    try {
      const acct = req.caseyAccount
      if (!acct) return next()
      if (req.caseyViewAs && req.method !== 'GET' && !PREVIEW_OK.has(req.path)) return deny(res, 403, caseyText("src/dashboard/roles.js#w2"), 'preview_read_only')
      if (isStaffAccount(acct)) {
        if (!isAdminAccount(acct) && isAdminOnlyRoute(req.method, req.path)) return deny(res, 403, caseyText("src/dashboard/roles.js#w3"), 'admin_only')
        return next()
      }
      if (isViewer(acct)) return viewerGate(req, res, next)
      req.caseyRole = roleOf(acct)
      acct._contact = await resolveContact(store, acct)
      const p = req.path
      const lp = p.toLowerCase()
      if (lp.startsWith('/media/')) {
        let decoded = ''
        try { decoded = decodeURIComponent(p) } catch { return deny(res, 404, caseyText("src/dashboard/roles.js#w4")) }
        const m = /^\/media\/([^/\\]+)\/([^/\\]+)$/.exec(decoded)
        if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..' || decoded.includes('\0')) return deny(res, 404, caseyText("src/dashboard/roles.js#w5"))
        const c = await store.getCase(m[1])
        return caseAccess(c, acct, { unclaimedKey: UNCLAIMED_ASSIGNEE }) === 'none' ? deny(res, 404, caseyText("src/dashboard/roles.js#w6")) : next()
      }
      if (!lp.startsWith('/api/') && lp !== '/api') return next()
      if (p === '/api/whoami' || p === '/api/logout' || p === '/api/change-password' || p === '/api/login') return next()
      let hit = null
      for (const [m, re, rule] of FIELD_ROUTES) {
        if (m !== req.method) continue
        const mm = re.exec(p)
        if (mm) { hit = { rule, id: mm[1] ? decodeURIComponent(mm[1]) : null }; break }
      }
      if (!hit) return deny(res, 403, caseyText("src/dashboard/roles.js#w7"), 'role_forbidden')
      const { rule, id } = hit
      if (rule === 'open') return next()
      if (rule === 'scoped-list') { req.caseyScoped = true; return next() }
      if (rule.tech && !isSpecialist(acct)) return deny(res, 403, caseyText("src/dashboard/roles.js#w8"), 'role_forbidden')
      const c = await store.getCase(id)
      const access = caseAccess(c, acct, { unclaimedKey: UNCLAIMED_ASSIGNEE })
      if (access === 'none') return deny(res, 404, caseyText("src/dashboard/roles.js#w9"))
      req.caseyAccess = access
      const b = req.body || {}
      if (rule.access === 'write' && access !== 'write') {
        const signOffMove = rule.transition && isSpecialist(acct) && inSignOffQueue(c, UNCLAIMED_ASSIGNEE)
        if (!signOffMove) return deny(res, 403, caseyText("src/dashboard/roles.js#w10"), 'not_assigned')
      }
      if (rule.access === 'signoff' && access === 'read' && !(isSpecialist(acct) && inSignOffQueue(c, UNCLAIMED_ASSIGNEE))) {
        return deny(res, 403, caseyText("src/dashboard/roles.js#w11"), 'not_assigned')
      }
      if (rule.intake && !isSpecialist(acct) && SIGNOFF_DIAGNOSIS_FIELDS.some(k => k in b)) {
        return deny(res, 403, caseyText("src/dashboard/roles.js#w12"), 'role_forbidden')
      }
      if (rule.patch) {
        const bad = Object.keys(b).filter(k => !PATCH_KEYS_FIELD.has(k))
        if (bad.length) return deny(res, 403, caseyText("src/dashboard/roles.js#w13"), 'role_forbidden')
        if ('tags' in b) {
          const sys = (list) => list.map(t => String(t).trim().toLowerCase()).filter(t => RESERVED_TAG.test(t)).sort().join('|')
          if (typeof b.tags !== 'string' || sys(tagList(c)) !== sys(String(b.tags).split(','))) return deny(res, 403, caseyText("src/dashboard/roles.js#w14"), 'role_forbidden')
        }
      }
      if (rule.transition && isDoneStatus(b.to) && b.to !== c.status) {
        if (!isSpecialist(acct)) return deny(res, 403, caseyText("src/dashboard/roles.js#w15"), 'signoff_forbidden')
        const missing = missingFor(c)
        if (missing.length) return deny(res, 400, caseyText("src/dashboard/roles.js#w16", [missing.map(fieldLabel).join(', ')]), 'missing_minimum')
        const noDiagnosis = missingDiagnosisFor(c, b)
        if (noDiagnosis.length) return deny(res, 400, caseyText("src/dashboard/roles.js#w17", [noDiagnosis.map(fieldLabel).join(' and '), noDiagnosis.length === 1 ? 'is' : 'are']), 'missing_diagnosis')
      }
      next()
    } catch (e) {
      deny(res, 500, caseyText("src/dashboard/roles.js#w18"), 'gate_error')
    }
  }
}

const REF_GUARDED = /^\/api\/cases\/([^/]+)\/(intake|note|transition|reply|location|send-back|relocate|handoff|handoff\/withdraw)$|^\/api\/cases\/([^/]+)$|^\/api\/cases\/([^/]+)\/events\/[^/]+\/translate$/
export function expectedRefGuard({ store }) {
  return async (req, res, next) => {
    try {
      const want = req.body && req.body.expected_ref
      if (want == null || !(req.method === 'POST' || req.method === 'PATCH')) return next()
      const m = REF_GUARDED.exec(req.path)
      if (!m || (m[3] && req.method !== 'PATCH')) return next()
      const c = await store.getCase(decodeURIComponent(m[1] || m[3] || m[4]))
      if (!c) return next()
      if (typeof want !== 'string' || want.trim() !== String(c.ref)) {
        return res.status(409).json({ error: caseyText("src/dashboard/roles.js#w19", [REPORT_ENTITY_LABEL, String(want).slice(0, 40), c.ref]), code: 'wrong_case' })
      }
      next()
    } catch (e) { res.status(500).json({ error: caseyText("src/dashboard/roles.js#w20"), code: 'gate_error' }) }
  }
}

export { MANDATORY_MINIMUM_FIELDS }
export const isTechnician = isSpecialist;
