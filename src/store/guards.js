
export const DERIVED_ONLY_FIELDS = new Set(['normalized_location', 'geocell', 'cluster_id', 'dedupe_score', 'author_key'])
export const SYSTEM_FORBIDDEN_FIELDS = new Set(['report', 'summary', 'subject'])

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

const SYSTEM_USER_ID = 'casey-system'

export function toStorable(patch) {
  if (!patch || typeof patch !== 'object') return patch
  const out = {}
  for (const [k, v] of Object.entries(patch)) {
    out[k] = (typeof v === 'number' && Number.isFinite(v)) ? String(v) : v
  }
  return out
}

export function versionGuardViolation(patch, opts) {
  if (!opts || opts.expectedVersion == null) return null
  if (!patch || typeof patch !== 'object') return null
  const rawNumbers = Object.entries(patch)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
    .map(([k]) => k)
  if (!rawNumbers.length) return null
  return `versionGuard: a raw JS number in a patch carrying expectedVersion makes thatcher's optimistic-concurrency check fail on every attempt WHILE THE WRITE STILL LANDS, so the caller is told it conflicted and skips everything downstream. Offending field(s): ${rawNumbers.join(', ')}. Pass the patch through store/guards.js toStorable() first.`
}

const GUARDED_UPDATE = 'update'
export function installVersionGuard(target) {
  return new Proxy(target, {
    get(obj, prop, recv) {
      const orig = Reflect.get(obj, prop, recv)
      if (prop !== GUARDED_UPDATE || typeof orig !== 'function') return orig
      return function guardedUpdate(entity, id, patch, user, opts) {
        const violation = versionGuardViolation(patch, opts)
        if (violation) throw new Error(`${violation} (entity=${entity}, id=${id})`)
        return orig.call(obj, entity, id, patch, user, opts)
      }
    },
  })
}

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
