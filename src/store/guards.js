// store/guards.js  --  write-guard rules protecting derived and contact-authored
// fields from the wrong actor. Extracted from case-store.js (structural split
// only; behavior is byte-identical to the original inline definitions).

// Fields only casey's own system code may write (computed FROM other fields,
// never hand-typed or agent-composed) -- see thatcher.config.yml's matching
// comment. A contact-authored text field the structural-automation invariant
// protects in the OTHER direction (below).
export const DERIVED_ONLY_FIELDS = new Set(['normalized_location', 'geocell', 'cluster_id', 'dedupe_score', 'author_key'])
// Contact-authored free text a SYSTEM actor must never originate -- the sweep/
// notifier/other background system code may tag/observe/reclassify, but must
// never fabricate what a person supposedly said. Mirrors DERIVED_ONLY_FIELDS'
// protection in the opposite direction: one guard, two rules, same chokepoint.
export const SYSTEM_FORBIDDEN_FIELDS = new Set(['report', 'summary', 'subject'])

// One chokepoint both updateCase-family writers call before touching thatcher.
// Returns an error string on a violation, or null when the patch is clean.
export function writeGuardViolation(patch, user) {
  if (!patch || typeof patch !== 'object') return null
  const isSystemActor = user?.id === SYSTEM_USER_ID
  const keys = Object.keys(patch)
  if (!isSystemActor) {
    const derivedTouched = keys.filter(k => DERIVED_ONLY_FIELDS.has(k))
    if (derivedTouched.length) {
      return `writeGuard: only casey's own system code may write derived field(s): ${derivedTouched.join(', ')}`
    }
  } else {
    const forbiddenTouched = keys.filter(k => SYSTEM_FORBIDDEN_FIELDS.has(k))
    if (forbiddenTouched.length) {
      return `writeGuard: the system actor may never write contact-authored field(s): ${forbiddenTouched.join(', ')}`
    }
  }
  return null
}

// The system-actor id writeGuardViolation checks against. Kept as a local
// constant (rather than importing case-store.js's SYSTEM_USER, which would
// create a circular import) since only the id string is needed here.
const SYSTEM_USER_ID = 'casey-system'

// The WRITE side of the busybase digit-string trap.
//
// busybase binds every column as TEXT, which is why the read side of this
// codebase never trusts a numeric-looking column and goes through rowInt()/
// tsMs() instead. The write side had no matching guard, and it needed one:
// passing a JS number in a patch that also carries expectedVersion makes the
// optimistic-concurrency check fail every single time.
//
// Witnessed directly against a real store, same value both ways:
//   updateCaseChecked(id, { lat: -29.1, lon: 30.4 })   -> "update conflict
//     after 3 retries -- not applied", yet lat reads back -29.1 and _version
//     has gone 0 -> 4, because all four attempts DID write
//   updateCaseChecked(id, { lat: '-29.1', lon: '30.4' }) -> ok, _version 0 -> 1
// Text-typed columns (subject, assignee, location_source) are unaffected in
// both shapes, so it is the JS number itself, not the field or the column.
//
// The damage was never lost coordinates -- those were written, four times
// over -- but the false failure handed back to the caller. case_report bails
// out on that error, so a report carrying a location skipped its timeline
// event, its provenance observation, the contact's last_report_* propagation
// and the derived normalized_location, and told the agent the write failed.
//
// Numbers become their decimal string here so thatcher stores exactly what it
// would have stored anyway. null, undefined, booleans and strings pass through
// untouched: null is a real "clear this column" and must not become "null",
// and NaN/Infinity are left alone rather than silently written as text.
export function toStorable(patch) {
  if (!patch || typeof patch !== 'object') return patch
  const out = {}
  for (const [k, v] of Object.entries(patch)) {
    out[k] = (typeof v === 'number' && Number.isFinite(v)) ? String(v) : v
  }
  return out
}
