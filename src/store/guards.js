// store/guards.js  --  write-guard rules protecting derived and contact-authored
// fields from the wrong actor. Extracted from case-store.js (structural split
// only; behavior is byte-identical to the original inline definitions).

// Fields only casey's own system code may write (computed FROM other fields,
// never hand-typed or agent-composed) -- see thatcher.config.yml's matching
// comment. A contact-authored text field the structural-automation invariant
// protects in the OTHER direction (below).
export const DERIVED_ONLY_FIELDS = new Set(['normalized_location', 'geocell', 'cluster_id', 'dedupe_score'])
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
