// case-tools-shared.js  --  the vocabulary every case_* tool group is written in.
//
// Split out of case-tools.js, which used to hold all 18 tool definitions plus
// every helper they close over in one 711-line function. Nothing here changed
// behaviourally: the tool constructor, the enum-hint ladder, the ownership
// predicate, the PII projections and the small pure helpers are the SAME code,
// now importable by the per-surface tool modules (case-tools-lookup/-record/
// -triage/-worker/-binding/-control.js) instead of being scoped inside one
// giant closure. case-tools.js remains the single source of truth for which
// tools exist and in what order.

import { readThatcherFieldEnum } from './config-loader.js'
import { ENQUIRY_HEADLINE_FIELDS } from './store/report-shape.js'
import { parseReport } from './timestamp.js'

export const str = (description, extra = {}) => ({ type: 'string', description, ...extra })

// Constructor-shape dedup: every tool object below is { name, toolset, schema:
// { name, description, parameters }, handler }, with `name` repeated verbatim
// between the outer object and the inner schema. defTool takes it once and
// builds both. Purely structural -- does not touch handler logic, toolset
// values, description text, or parameters schemas.
export function defTool(name, toolset, description, parameters, handler) {
  return { name, toolset, schema: { name, description, parameters }, handler }
}
// LAST-RESORT literals for the tool-schema `enum` hints. Reached only when
// there is no live CaseStore AND thatcher.config.yml cannot be read -- see
// fieldEnumHint() below for the ladder. They are never the normal source of
// the hint, precisely because a literal goes stale the moment a deployment's
// config declares a different vocabulary (casey's own default config already
// moved domain once, which is what retired the previous hardcoded list).
export const FALLBACK_CASE_TYPE_VALUES = ['unset']
export const FALLBACK_PRIORITY_VALUES = ['low', 'normal', 'high', 'urgent']
export const FALLBACK_STAGE_VALUES = ['new', 'triaging', 'in_progress', 'waiting', 'resolved', 'closed']

// The enum hint shown to the model, resolved LAZILY at toolset-build time
// against the live store rather than eagerly at module load.
//
// Why this is not a second config parse any more: the hint has to equal what
// write-time enforcement (store.getFieldEnum, the real authority) will accept,
// or the model is shown options that are then rejected. config-loader.js's
// readThatcherFieldEnum() re-resolves thatcher.config.yml from
// CASEY_CONFIG_DIR-or-cwd, which is the CaseStore's DEFAULT but not its only
// input: createCaseStore({ config }) takes an explicit path (src/casey.js's
// init(), bin/casey-cli.mjs's doctor), and a second parse cannot see that
// override -- so the two could disagree with nothing to notice it.
//
// The store is reachable by the time it matters. casey.js init() sets the
// process singleton at step 1 ("case store up first so plugin handlers have
// it"), and freddie's tree -- which applies the case-tools plugin and calls
// buildCaseToolset() -- boots at step 4. The other callers ask only for tool
// NAMES (reporterTierExcludedToolNames, run-turn.js's allowlist, the
// self-check in case-tools.js), so they hit the fallback ladder and never look
// at a schema. getCaseStore() throws when unset and the name-only self-check
// passes a bare {}, hence the guard plus catch.
export function fieldEnumHint(store, entityDotField, fallback) {
  try {
    const s = store()
    if (s && typeof s.getFieldEnum === 'function') {
      const live = s.getFieldEnum(entityDotField, null)
      if (Array.isArray(live) && live.length) return live
    }
  } catch { /* no store yet -- a name-only caller, never a live turn */ }
  const [entity, field] = entityDotField.split('.')
  return readThatcherFieldEnum(entity, field) || fallback
}

// Same ladder for the workflow's stage list: the real authority is the store's
// own machine (getValidStatuses(), from thatcher.config.yml
// workflows.case_lifecycle), enforced wherever a transition is attempted.
export function stageHint(store) {
  try {
    const s = store()
    if (s && typeof s.getValidStatuses === 'function') {
      const live = s.getValidStatuses()
      if (Array.isArray(live) && live.length) return live
    }
  } catch { /* no store yet -- see fieldEnumHint */ }
  return FALLBACK_STAGE_VALUES
}
// case_observe/case_split write straight to appendEvent, which has no
// length guard of its own (unlike case_report's fields, capped in
// case-store.js's mergeReport at APPEND_FIELD_MAX_LEN=20000) -- an
// adversarial or malfunctioning model call could otherwise write an
// arbitrarily large blob into a single event row with no bound at all,
// per-call or cumulative. Same cap value as the store's own convention,
// enforced here at the tool boundary (the earliest point that still has
// the offending value in scope) rather than deep in appendEvent.
export const OBSERVE_TEXT_MAX_LEN = 20000

// external_id is 'container:author' (a multi-author channel) or the bare author
// (a 1:1 chat) -- a case is "owned" by an author when their id appears as one
// of the colon-separated parts. Single source of truth for case_get's ownership
// gate and mineRows' "my cases" filter so a fix to one (case-insensitive ids, a
// different separator) can never diverge from the other and reopen a PII leak.
export function ownsCase(externalId, author) {
  if (!author) return false
  const ext = String(externalId || '')
  const a = String(author)
  return ext === a || ext.split(':').includes(a) || ext.endsWith(':' + a)
}

// Great-circle distance in km between two lat/lon points (haversine). Used by the
// proximity enquiry (case_list `near`) so "closest case" can be answered from the
// real tool result. Coordinates are model-estimated (the agent's own best guess
// for a described place), so the distance is best-effort, not surveyed exact.
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function slimCase(c) {
  if (!c) return null
  const { id, ref, channel, status, priority, subject, summary, report, tags, assignee, autonomy, last_event_at } = c
  // Parse the report so the agent reads it as structured fields (and knows which
  // it already has, so it never re-asks). Tolerate a malformed/empty report.
  let reportObj = null
  try { reportObj = report ? JSON.parse(report) : null } catch { reportObj = null }
  return { id, ref, channel, status, priority, subject, summary, report: reportObj, tags, assignee, autonomy, last_event_at }
}
// PII-FREE projection for a LIST row (an enquiry spanning cases the asker may not
// own). Keeps only ref/status/species/location -- NEVER the full report object, which
// carries owner_name/contact_fallback/present_person and other contact-supplied free
// text that must not reach the model context (and thence a reply) for a case the
// worker does not own. species/location are flattened out of the report so a place/
// species list still reads naturally without exposing the rest.
export function enquiryRow(c, distanceKm) {
  if (!c) return null
  let report = parseReport(c)
  const headline = Object.fromEntries(ENQUIRY_HEADLINE_FIELDS.map(k => [k, report[k] || null]))
  return {
    id: c.id, ref: c.ref, status: c.status, priority: c.priority,
    ...headline,
    assignee: c.assignee || null, last_event_at: c.last_event_at,
    ...(typeof distanceKm === 'number' ? { distance_km: distanceKm } : {}),
  }
}
// The turn's active-case binding, read through the SHARED binding object
// (handler.js's turnBinding, passed as toolCtx.activeCaseBinding). That one
// object reference survives freddie's per-dispatch shallow copy of ctx
// (host_helpers.js spreads ctx into ctxWithProgress), so a case_new/
// case_switch rebind mid-attempt is visible to every later tool call in the
// turn -- the flat ctx.activeCaseId/activeCaseRef copies are only the
// fallback for callers that predate the binding object.
export function boundCase(ctx) {
  return {
    id: ctx?.activeCaseBinding?.id || ctx?.activeCaseId || null,
    ref: ctx?.activeCaseBinding?.ref || ctx?.activeCaseRef || null,
  }
}
// A case_new/case_switch rebind must update every view of the binding: the
// shared object (all later calls this turn, plus the handler's next retry
// attempt) and the flat per-copy fields (this call's own ctx).
export function rebindActiveCase(ctx, c) {
  if (!ctx || !c) return
  if (ctx.activeCaseBinding) { ctx.activeCaseBinding.id = c.id; ctx.activeCaseBinding.ref = c.ref }
  ctx.activeCaseId = c.id
  ctx.activeCaseRef = c.ref
}
export function slimEvent(e) {
  return { kind: e.kind, actor: e.actor, text: e.text, at: e.created_at }
}
// The asking worker's OWN open cases: reporter-scoped. The per-contact case
// external_id is 'container:author' (a multi-author channel) or the bare author
// (a 1:1 chat), so a worker's own cases are those whose external_id CONTAINS their
// author id. We pull the open set and JS-filter (external_id is not always a clean
// equality key across channels), most-recently-active first, capped.
export async function mineRows(store, ctx, limit) {
  const author = ctx?.author || ctx?.principal?.id
  // Fail CLOSED like case_get already does: no author on ctx means we cannot
  // prove which cases are "mine", so return nothing rather than defaulting to
  // everyone's open cases (a prior shape here silently handed back the whole
  // open set -- a cross-contact leak of case existence/species/location -- to
  // any caller whose ctx happened to carry no author).
  if (!author) return { error: 'no author on this turn -- cannot resolve "my cases"' }
  // Read the live config-declared open-stage set (case-sweep.js's own pattern)
  // rather than a hardcoded literal list, so a custom/renamed workflow stage in
  // thatcher.config.yml is picked up with no code edit -- a hardcoded list here
  // silently hides a worker's own claimed case from "my cases" on such a deployment.
  const openStatuses = typeof store.getOpenStatuses === 'function'
    ? store.getOpenStatuses()
    : ['new', 'triaging', 'in_progress', 'waiting']
  // Real query-level owner scoping: case.author_key (case-store.js
  // deriveAuthorKey) is the flattened, exact-match-friendly author token set at
  // case-creation time, so thatcher's real equality operator-where can scope
  // "my cases" directly at the store instead of pulling a system-wide scan
  // window and JS-filtering by ownsCase() -- the old CASEY_MINE_SCAN_LIMIT
  // mitigation (a case falling outside a bounded recency scan silently missing
  // from "my cases" on a high-traffic deployment) no longer applies to any case
  // created after this field existed.
  const scoped = await store.listCases({ status: { $in: openStatuses }, author_key: author }, { limit: Math.max(limit * 4, 100) })
  // Legacy fallback: a case created before author_key existed has it blank, so
  // the equality query above cannot find it. Widen to the old bounded scan +
  // ownsCase() JS-filter ONLY for those legacy rows, capped by
  // CASEY_MINE_SCAN_LIMIT exactly as before -- a deployment ages out of this
  // fallback entirely as its pre-migration open cases close.
  if (scoped.length >= limit) return scoped.slice(0, limit)
  const mineScanLimit = Number(process.env.CASEY_MINE_SCAN_LIMIT) || 1000
  const legacyPool = await store.listCases({ status: { $in: openStatuses }, author_key: '' }, { limit: Math.max(limit * 10, mineScanLimit) })
  const legacyMine = legacyPool.filter(c => ownsCase(c.external_id, author))
  const seen = new Set(scoped.map(c => c.id))
  const merged = [...scoped, ...legacyMine.filter(c => !seen.has(c.id))]
  return merged.slice(0, limit)
}
export function pick(obj, keys) {
  const out = {}
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== '' && String(obj[k]).trim() !== '') out[k] = obj[k]
  return out
}
export function isValidLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
}
