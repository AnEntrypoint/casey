// store/guards.js  --  write-guard rules protecting derived and contact-authored
// fields from the wrong actor.

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
// tsMs() instead. The write side needs the matching guard: passing a JS number
// in a patch that also carries expectedVersion makes the optimistic-concurrency
// check fail every single time, while the write still lands, once per retry:
//   updateCaseChecked(id, { lat: -29.1, lon: 30.4 })   -> "update conflict
//     after 3 retries -- not applied", yet lat reads back -29.1 and _version
//     has gone 0 -> 4, because all four attempts DID write
//   updateCaseChecked(id, { lat: '-29.1', lon: '30.4' }) -> ok, _version 0 -> 1
// Text-typed columns (subject, assignee, location_source) are unaffected in
// both shapes, so it is the JS number itself, not the field or the column.
//
// The damage is not lost coordinates -- those are written, four times over --
// but the false failure handed back to the caller. case_report bails out on
// that error, so a report carrying a location skips its timeline event, its
// provenance observation, the contact's last_report_* propagation and the
// derived normalized_location, and tells the agent the write failed.
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

// The STRUCTURAL half of the trap above. toStorable() only helps a caller who
// remembers to call it, and until now every version-guarded write reached
// thatcher through updateCase/updateCaseQuiet, which do. That is convention,
// not enforcement: nothing stopped the next direct
// `store.t.update(entity, id, {n: 1}, user, {expectedVersion})` from
// reintroducing the exact failure -- a write that LANDS while the caller is
// told it conflicted, so every downstream step is skipped.
//
// Returns an error string when a patch that rides an expectedVersion carries a
// raw JS number, or null when it is clean. Only finite numbers are named: NaN
// and Infinity are left to toStorable's own pass-through rule, and a
// null/undefined/boolean/string value has never been able to trip the
// concurrency check.
export function versionGuardViolation(patch, opts) {
  if (!opts || opts.expectedVersion == null) return null
  if (!patch || typeof patch !== 'object') return null
  const rawNumbers = Object.entries(patch)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
    .map(([k]) => k)
  if (!rawNumbers.length) return null
  return `versionGuard: a raw JS number in a patch carrying expectedVersion makes thatcher's optimistic-concurrency check fail on every attempt WHILE THE WRITE STILL LANDS, so the caller is told it conflicted and skips everything downstream. Offending field(s): ${rawNumbers.join(', ')}. Pass the patch through store/guards.js toStorable() first.`
}

// Wrap a live thatcher instance (or a proxy over one) so no update() can carry
// a raw number under an expectedVersion, whoever the caller is. Installed once,
// in case-store.js's `get t()` -- the single accessor every internal `this.t.*`
// AND every external `store.t.*` call site already goes through, so this is a
// real chokepoint rather than a rule each new caller has to be told about.
// Throws BEFORE the write, which is the whole point: the reproduced failure
// mode is a write that lands and reports failure, and the only outcome worse
// than a loud refusal is a silent divergence between what the store holds and
// what the caller believes.
const GUARDED_UPDATE = 'update'
export function installVersionGuard(target) {
  return new Proxy(target, {
    get(obj, prop, recv) {
      const orig = Reflect.get(obj, prop, recv)
      if (prop !== GUARDED_UPDATE || typeof orig !== 'function') return orig
      // thatcher's signature: update(entity, id, patch, user, opts)
      return function guardedUpdate(entity, id, patch, user, opts) {
        const violation = versionGuardViolation(patch, opts)
        if (violation) throw new Error(`${violation} (entity=${entity}, id=${id})`)
        return orig.call(obj, entity, id, patch, user, opts)
      }
    },
  })
}

// Load-bearing-contract self-check, the same throw-at-import discipline as
// hooks/prompt.js's selfCheckLoadBearingPromptContent, case-tools.js's
// selfCheckLoadBearingToolDescriptions and provenance-wire.js's loadPack call.
// The guard above is only sound while toStorable keeps its exact contract, and
// that contract has two halves a future edit could plausibly break in opposite
// directions: stop coercing finite numbers (the trap comes back, now past a
// guard that trusts the coercion), or start coercing what must pass through
// untouched (null is a real column clear and must never become the string
// "null"). Checked at module load with real values so a broken coercion fails
// at boot with the field named, rather than in a live write months later.
function selfCheckStorableCoercionContract() {
  const probe = toStorable({ n: -29.1234, i: 7, s: '-29.1234', b: true, z: null, u: undefined, nan: NaN, inf: Infinity })
  const problems = []
  if (probe.n !== '-29.1234') problems.push('a finite float must become its decimal string')
  if (probe.i !== '7') problems.push('a finite integer must become its decimal string')
  if (probe.s !== '-29.1234') problems.push('a string must pass through untouched')
  if (probe.b !== true) problems.push('a boolean must pass through untouched')
  if (!('z' in probe) || probe.z !== null) problems.push('null must pass through untouched -- it is a real column clear and must never become the string "null"')
  if (!('u' in probe) || probe.u !== undefined) problems.push('undefined must pass through untouched')
  if (!Number.isNaN(probe.nan)) problems.push('NaN must pass through untouched')
  if (probe.inf !== Infinity) problems.push('Infinity must pass through untouched')
  if (problems.length) {
    throw new Error(`store/guards.js: toStorable() no longer satisfies the contract installVersionGuard depends on: ${problems.join('; ')}`)
  }
}
selfCheckStorableCoercionContract()
