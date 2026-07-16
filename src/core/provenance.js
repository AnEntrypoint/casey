// core/provenance.js -- the honesty floor's foundational type.
//
// Every value casey stores through the observation write path carries a
// provenance tag. This module is the ONLY place a provenanced value may be
// constructed: mkValue() is the single factory, and the shape it returns has
// no other constructor anywhere in the codebase. A value built any other way
// (a bare object literal shaped like one) is not rejected by a runtime check
// -- it simply never entered through this module, which is what
// requireProvenance()/isProvenanced() below actually verify.
//
// PROVENANCE_KINDS is exhaustive and ordered worst-to-best for confidence
// comparisons (unknown carries no claim at all, inferred is the model's own
// guess, observed/measured/reported are what a human or a device actually
// witnessed). No pack, no caller, no future code path may invent a new kind
// outside this list -- if a real new source of truth appears (e.g. a lab
// instrument feed), it is added HERE, once, reviewed, not smuggled in as an
// ad hoc string at a call site.

export const PROVENANCE_KINDS = Object.freeze(['unknown', 'inferred', 'reported', 'observed', 'measured'])

// Rank for "does this value outrank that one" comparisons -- an inferred
// value must never overwrite an observed one; unknown never overwrites
// anything real.
const RANK = Object.freeze(Object.fromEntries(PROVENANCE_KINDS.map((k, i) => [k, i])))

export function provenanceRank(kind) {
  if (!Object.prototype.hasOwnProperty.call(RANK, kind)) throw new Error(`provenance: unknown kind "${kind}"`)
  return RANK[kind]
}

// The single factory. Every field-level value passing through the write path
// (core/write-path.js) is wrapped via this function before it is ever
// persisted. `value` is null for an explicit unknown answer -- that is not an
// error state, it is the whole point of making unknown first-class.
export function mkValue({ value = null, provenance, confidence = null, recordedAt, recordedBy, packVersion = null }) {
  if (!PROVENANCE_KINDS.includes(provenance)) {
    throw new Error(`provenance: mkValue requires one of ${PROVENANCE_KINDS.join('|')}, got "${provenance}"`)
  }
  if (provenance === 'unknown' && value !== null) {
    throw new Error('provenance: a value tagged unknown must carry value:null -- unknown means "no value", never a real value with a weak label')
  }
  if (provenance !== 'unknown' && value === null) {
    throw new Error(`provenance: a "${provenance}" value cannot be null -- use provenance:"unknown" for an absent answer`)
  }
  if (confidence != null && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
    throw new Error(`provenance: confidence must be a number in [0,1] or null, got ${confidence}`)
  }
  if (!recordedAt) throw new Error('provenance: recordedAt is required (ISO string or epoch ms)')
  if (!recordedBy) throw new Error('provenance: recordedBy is required (actor id: agent|contact id|operator id|device id)')
  return Object.freeze({
    value,
    provenance,
    confidence: provenance === 'inferred' ? (confidence ?? null) : confidence,
    recordedAt,
    recordedBy,
    packVersion,
    __provenanced: true,
  })
}

export function mkUnknown({ recordedAt, recordedBy, packVersion = null }) {
  return mkValue({ value: null, provenance: 'unknown', recordedAt, recordedBy, packVersion })
}

// The ONLY recognized marker of a properly-constructed value. A plain object
// that merely happens to have the same keys was not built by mkValue (no
// Object.freeze, no __provenanced) and fails this check -- so any code
// deserializing untrusted input (a synced payload, a pack-declared default)
// must re-wrap through mkValue rather than trusting the shape.
export function isProvenanced(v) {
  return !!v && typeof v === 'object' && v.__provenanced === true && PROVENANCE_KINDS.includes(v.provenance)
}

export function requireProvenance(v, ctx = 'value') {
  if (!isProvenanced(v)) {
    throw new Error(`provenance: ${ctx} is not a provenanced value (construct via mkValue/mkUnknown, never a bare literal)`)
  }
  return v
}

// True when `incoming` is allowed to replace `current` under the no-silent-
// inference rule: a lower-or-equal-rank value may never clobber a
// higher-rank one. Two values of the SAME rank (e.g. two independent
// "reported" answers) are allowed to replace each other -- that is an
// ordinary correction, not a provenance downgrade, and the caller is
// responsible for recording it as a new version (core/write-path.js).
export function canReplace(current, incoming) {
  requireProvenance(incoming, 'incoming')
  if (current == null) return true
  requireProvenance(current, 'current')
  if (current.provenance === 'unknown') return true
  return provenanceRank(incoming.provenance) >= provenanceRank(current.provenance)
}

export function isUnknown(v) {
  return isProvenanced(v) && v.provenance === 'unknown'
}
