// core/provenance.js -- the honesty floor's foundational type.
//
// Every value casey stores through the observation write path carries a
// provenance tag. This module is the ONLY sanctioned place a provenanced value
// is constructed: mkValue() is the single factory, and no other constructor for
// the shape exists in the codebase.
//
// What the runtime check below actually enforces, exactly: isProvenanced()
// tests `v.__provenanced === true` AND that `v.provenance` is one of
// PROVENANCE_KINDS. So an ordinary bare literal (one that merely happens to
// carry the same value/recordedAt/recordedBy keys) IS rejected -- it has no
// __provenanced marker. What is NOT checked is Object.freeze, and nothing stops
// a literal that deliberately sets `__provenanced: true` alongside a valid
// `provenance` string from passing. The marker is an entry-point discipline for
// this module's own callers, not an unforgeable capability, and it is not
// relied on as one: every writer reaches the shape through
// core/write-path.js's writeObservation, which is internal to casey and never
// takes a caller-supplied provenanced object off the wire. Code deserializing
// untrusted input (a synced payload, a pack-declared default) must therefore
// re-wrap through mkValue rather than trusting a shape that arrived already
// marked.
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

// The recognized marker of a properly-constructed value: the __provenanced flag
// mkValue stamps, plus a provenance string that is one of PROVENANCE_KINDS. A
// plain object that merely happens to carry the same keys fails this check
// because it has no marker. Object.freeze is NOT part of the test (mkValue does
// freeze, but nothing here verifies it), and a literal that deliberately sets
// __provenanced:true passes -- see this module's header for why that
// forgeability is acceptable and where the real boundary is.
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

// This subsystem carries no unreferenced scaffolding: a new export here is
// wired to a real caller in the same change, never left standing for a later
// audit to find (AGENTS.md, "Provenance subsystem").
