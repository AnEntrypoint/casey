// Team-facing operator views: who can be assigned a case, and who needs a nudge.
// Staff-only by construction -- roleGate (roles.js) denies both to the field
// logins, since neither is in its allowlist.
//
// deps: store, wrap, authed, isOpenCase, UNCLAIMED_ASSIGNEE, listAccounts
import { mountRoutes } from './register.js'
import { tsMs } from '../../timestamp.js'
import { normalizeMsisdn } from '../../role-invites.js'
import { assigneeKeyFor, isContactAssignee, contactIdOfAssignee } from '../../case-assignment.js'
import { resolveContactTier, TIER_FIELD_WORKER, TIER_ANIMAL_HEALTH_TECHNICIAN } from '../../contact-tiers.js'
import { TIER_LABELS, fieldLabel } from '../../store/report-shape.js'
import { fmtPhone27 } from '../../format.js'
import { waLink } from '../wa-link.js'
import { missingFor, FIELD_ROLES } from '../roles.js'
import { parseReport } from '../../timestamp.js'
import { loadAreas, resolveArea, statedArea } from '../../areas.js'
import { buildTeamMetrics, DEFAULT_STUCK_HOURS } from '../../ranger-metrics.js'

const ROLE_LABEL = { eco_ranger: TIER_LABELS[TIER_FIELD_WORKER], animal_health_technician: TIER_LABELS[TIER_ANIMAL_HEALTH_TECHNICIAN] }
const NUDGE_CASE_CAP = 300
const HOUR = 3600e3

// The people a case can be assigned to: registered team members reached over
// WhatsApp (assigned by their contact key) and dashboard logins for the field
// roles (assigned by username). A login linked (contact_phone) to a listed
// WhatsApp team member is that same person: the picker assigns with the contact
// key (which the login also holds through roles.js's contact_phone resolution), so
// the login is carried as an ALIAS (`alias_of` = the contact key), not as a second
// choice. It stays in the payload so a report already held under the username still
// resolves to a name; the picker skips aliases. An unlinked login is listed as before.
export function getTeamMembers({ store, authed, listAccounts }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const members = []
    const contactKeyByPhone = new Map()
    const contacts = await store.listContacts({ limit: 500 })
    for (const c of contacts) {
      const tier = resolveContactTier(c)
      if (tier !== TIER_FIELD_WORKER && tier !== TIER_ANIMAL_HEALTH_TECHNICIAN) continue
      const key = assigneeKeyFor(c)
      if (!key) continue
      if (c.channel === 'whatsapp') contactKeyByPhone.set(normalizeMsisdn(c.external_id), key)
      members.push({ key, name: c.display_name && c.display_name !== c.external_id ? c.display_name : fmtPhone27(c.external_id), role: TIER_LABELS[tier], via: 'WhatsApp' })
    }
    for (const a of await listAccounts(store)) {
      if (a.disabled === '1' || !FIELD_ROLES.includes(a.role)) continue
      const alias_of = contactKeyByPhone.get(normalizeMsisdn(a.contact_phone)) || undefined
      members.push({ key: a.username, name: a.display_name || a.username, role: ROLE_LABEL[a.role], via: 'Dashboard login', ...(alias_of ? { alias_of } : {}) })
    }
    members.sort((x, y) => x.name.localeCompare(y.name))
    res.json({ members })
  }
}

const hoursSince = (ms, now) => (Number.isFinite(ms) ? Math.max(0, Math.round(((now - ms) / HOUR) * 10) / 10) : null)

// Open cases held by a field team member, grouped by person, with the clocks an
// operator nudges on: since assignment, since the person last did anything on the
// case, since the reporter last wrote, and what is still missing.
export function getNudges({ store, authed, isOpenCase, UNCLAIMED_ASSIGNEE, listAccounts }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const now = Date.now()
    const all = await store.listCases({}, { limit: 5000, offset: 0 })
    const held = all.filter(c => isOpenCase(c) && String(c.assignee || '').trim() && c.assignee !== UNCLAIMED_ASSIGNEE)
    // Only field-team holders: an operator holding a case is not nudged by this view.
    const accounts = new Map((await listAccounts(store)).filter(a => FIELD_ROLES.includes(a.role)).map(a => [String(a.username).toLowerCase(), a]))
    const people = new Map()
    let capped = false
    for (const c of held) {
      const key = String(c.assignee).trim()
      let person = people.get(key)
      if (!person) {
        let name = key, role = null, digits = ''
        const acct = accounts.get(key.toLowerCase())
        if (acct) { name = acct.display_name || acct.username; role = ROLE_LABEL[acct.role]; digits = normalizeMsisdn(acct.contact_phone) }
        else if (isContactAssignee(key)) {
          const contact = await store.getContact(contactIdOfAssignee(key))
          if (!contact) continue
          name = contact.display_name && contact.display_name !== contact.external_id ? contact.display_name : fmtPhone27(contact.external_id)
          role = TIER_LABELS[resolveContactTier(contact)]
          digits = contact.channel === 'whatsapp' ? String(contact.external_id || '').replace(/\D/g, '') : ''
        } else continue
        person = { key, name, role, phone: digits ? fmtPhone27(digits) : null, digits, cases: [] }
        people.set(key, person)
      }
      if (person.cases.length >= NUDGE_CASE_CAP) { capped = true; continue }
      const events = await store.listEventsPage(c.id, { limit: 60, offset: 0 })
      let assigned = null, active = null, reporter = null
      for (const e of events) {
        const at = tsMs(e.created_at)
        let d = e.data
        if (typeof d === 'string') { try { d = JSON.parse(d) } catch { d = {} } }
        d = d || {}
        if (e.kind === 'inbound' && (reporter == null || at > reporter)) reporter = at
        if (assigned == null && (d.assignee === key || d.claimed_by === key)) assigned = at
        if (person.role && acct_by(d, key, accounts) && (active == null || at > active)) active = at
      }
      person.cases.push({
        id: c.id, ref: c.ref, subject: c.subject || c.ref,
        hours_assigned: hoursSince(assigned, now),
        hours_since_activity: hoursSince(active, now),
        hours_since_reporter: hoursSince(reporter, now),
        missing: missingFor(c).map(fieldLabel),
      })
    }
    // One person can appear twice: as a dashboard login and as their WhatsApp
    // contact (linked by phone number). Fold those into the one person.
    const byPhone = new Map()
    for (const p of [...people.values()]) {
      if (!p.digits) continue
      const first = byPhone.get(p.digits)
      if (!first) { byPhone.set(p.digits, p); continue }
      const keep = accounts.has(first.key.toLowerCase()) ? first : p
      const drop = keep === first ? p : first
      const seen = new Set(keep.cases.map(c => c.id))
      for (const c of drop.cases) if (!seen.has(c.id)) keep.cases.push(c)
      people.delete(drop.key); byPhone.set(p.digits, keep)
    }
    const out = [...people.values()].filter(p => p.cases.length).map(p => {
      const refs = p.cases.map(c => `${c.ref}${c.missing.length ? ` (still needed: ${c.missing.join(', ')})` : ''}`).join('; ')
      const text = `Hi ${p.name}, a quick check on the ${p.cases.length === 1 ? 'report' : 'reports'} assigned to you: ${refs}. Please send an update when you can. Thank you.`
      const { digits, ...rest } = p
      return { ...rest, wa_link: waLink(digits, text) }
    })
    // Longest quiet first: the person whose oldest silence is longest.
    const quiet = (p) => Math.max(...p.cases.map(c => c.hours_since_activity ?? c.hours_assigned ?? 0))
    out.sort((a, b) => quiet(b) - quiet(a))
    res.json({ people: out, capped })
  }
}

// Did this event's data name the login that holds the case? (Dashboard logins
// stamp `by: <username>` on everything they do.)
function acct_by(d, key, accounts) {
  return accounts.has(key.toLowerCase()) && String(d.by || '').toLowerCase() === key.toLowerCase()
}

// The field team as ranger-metrics.js wants it: one person per human, with every
// key they can be held under (WhatsApp contact key and/or dashboard username; a
// login linked by phone to a listed contact is folded into that contact) and the
// names and ids their timeline events carry. Names only -- never a phone or login
// in the payload built from this.
export async function teamPeople(store, listAccounts) {
  const people = []
  const byPhone = new Map()
  for (const c of await store.listContacts({ limit: 500 })) {
    const tier = resolveContactTier(c)
    if (tier !== TIER_FIELD_WORKER && tier !== TIER_ANIMAL_HEALTH_TECHNICIAN) continue
    const key = assigneeKeyFor(c)
    if (!key) continue
    const name = c.display_name && c.display_name !== c.external_id ? c.display_name : fmtPhone27(c.external_id)
    const p = { id: key, name, role: TIER_LABELS[tier], keys: [key], ids: [key, c.id, name] }
    people.push(p)
    if (c.channel === 'whatsapp') byPhone.set(normalizeMsisdn(c.external_id), p)
  }
  for (const a of await listAccounts(store)) {
    if (a.disabled === '1' || !FIELD_ROLES.includes(a.role)) continue
    const name = a.display_name || a.username
    const linked = byPhone.get(normalizeMsisdn(a.contact_phone))
    if (linked) { linked.keys.push(a.username); linked.ids.push(a.username, name); continue }
    people.push({ id: a.username, name, role: ROLE_LABEL[a.role], keys: [a.username], ids: [a.username, name] })
  }
  return people
}

// GET /api/metrics/team -- STAFF only (roles.js denies every other family by
// default; nothing is added to its field or viewer allowlists). See ranger-metrics.js
// for what each figure means. ?stuck_hours=N (default 48), ?since_days=N (default all).
export function getTeamMetrics({ store, authed, UNCLAIMED_ASSIGNEE, listAccounts }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const stuckHours = Math.min(24 * 365, Math.max(1, Number(req.query.stuck_hours) || DEFAULT_STUCK_HOURS))
    const sinceDays = Number(req.query.since_days)
    const now = Date.now()
    const cases = (await store.listCases({}, { limit: 5000, offset: 0 })).filter(c => c.channel !== 'system')
    const people = await teamPeople(store, listAccounts)
    const eventsByCase = await store.listEventsByCase(cases.map(c => c.id))
    const areas = await loadAreas(store).catch(() => [])
    const groupOf = (c) => {
      const report = parseReport(c)
      const stated = statedArea(report)
      const hit = resolveArea(areas, { association: stated, location: report.location })
      return hit ? hit.area.name : (stated || 'unknown')
    }
    const out = buildTeamMetrics({ cases, eventsByCase, people, groupOf, now, stuckHours, sinceMs: sinceDays > 0 ? now - sinceDays * 24 * HOUR : 0, unclaimed: UNCLAIMED_ASSIGNEE })
    res.json(out)
  }
}

const ROUTES = [
  ['get', '/api/team-members', getTeamMembers],
  ['get', '/api/nudges', getNudges],
  ['get', '/api/metrics/team', getTeamMetrics],
]

export function registerTeam(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
