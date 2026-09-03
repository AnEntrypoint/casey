// core/observation.js -- the Observation record: the invariant spine that
// never varies by domain (WHO observed / WHAT subject / WHERE / WHEN / WHAT
// was found / WITH WHAT EVIDENCE / AT WHAT PROVENANCE+CONFIDENCE / VERIFIED
// BY WHOM / ESCALATED TO WHOM).
//
// Domain-neutral naming applies ONLY to this new subsystem -- it does not
// rename or replace casey's existing case/report/contact vocabulary in
// case-tools.js/case-store.js/thatcher.config.yml. An Observation is built
// ALONGSIDE an existing thatcher case (see core/write-path.js), never
// instead of it.
//
// An Observation is immutable once constructed (Object.freeze) and is the
// unit the append-only raw log (core/raw-log.js) stores. Corrections are
// new Observations linked via `correctsId`, never a mutation of this one.

import { isProvenanced, requireProvenance } from './provenance.js'

let _seq = 0
// Deterministic-enough id generator that does not depend on Date.now()/
// Math.random() at import time inside a gm workflow script context; real
// runtime callers pass their own recordedAt, this only needs to be locally
// unique within a process lifetime alongside that timestamp.
function nextLocalSeq() { return ++_seq }

export function mkObservationId(recordedAtMs, actorId) {
  return `obs-${recordedAtMs}-${actorId}-${nextLocalSeq()}`
}

// Time semantics: four DISTINCT timestamps, never conflated (item 41/59).
// - onsetAt: when the condition/situation actually started (frequently
//   unknowable -- must be an explicit provenance-tagged value, see
//   expansion-time-semantics-missing-onset, never defaulted to observedAt).
// - observedAt: when the observer actually saw/found it.
// - reportedAt: when the observation was told to the system (a field worker
//   relaying something seen hours earlier).
// - syncedAt: when this record reached the durable log (set by the write
//   path, not the caller -- see core/write-path.js).
const TIME_FIELDS = ['onsetAt', 'observedAt', 'reportedAt', 'syncedAt']

export function mkObservation({
  subjectId,           // which Subject (case/herd/site) this is about
  observerId,          // WHO observed (contact/reporter/device id)
  observerRole,        // reporter | field_worker | operator | device
  location,            // provenanced value: {lat,lon} or free text, per pack
  onsetAt,             // provenanced value (may be unknown)
  observedAt,          // provenanced value (may be unknown, rarely)
  reportedAt,          // plain ISO/epoch -- always known, it is "now" at capture
  syncedAt = null,      // set by write path on persist, null until then
  findings,            // { [fieldKey]: provenancedValue } -- the pack-declared observation form fields
  evidence = [],        // [{ kind: 'photo'|'audio'|'video'|'test_result', present: bool, ref: string|null, provenance }]
  verificationTier = 'unverified',   // unverified | field_confirmed | lab_confirmed
  verifiedBy = null,     // actor id, when verificationTier !== 'unverified'
  escalatedTo = null,    // responder id/route, when triage escalates
  packId,               // which config pack authored the form this was captured against
  packVersion,          // pack version stamp (config-pack-versioning)
  caseDefinitionVersion = null,  // epistemics-case-definition-versioning
  correctsId = null,     // id of the Observation this corrects, or null if original
  correctionReason = null,
} = {}) {
  if (!subjectId) throw new Error('observation: subjectId is required')
  if (!observerId) throw new Error('observation: observerId is required')
  if (!reportedAt) throw new Error('observation: reportedAt is required')
  if (!packId || !packVersion) throw new Error('observation: packId/packVersion are required (schema-at-the-boundary: every observation is captured against a specific pack version)')
  if (!['unverified', 'field_confirmed', 'lab_confirmed'].includes(verificationTier)) {
    throw new Error(`observation: verificationTier must be unverified|field_confirmed|lab_confirmed, got "${verificationTier}"`)
  }
  if (verificationTier !== 'unverified' && !verifiedBy) {
    throw new Error('observation: a non-unverified tier requires verifiedBy')
  }
  for (const [k, v] of Object.entries({ onsetAt, observedAt, location })) {
    if (v != null) requireProvenance(v, k)
  }
  const findingsOut = {}
  for (const [k, v] of Object.entries(findings || {})) {
    requireProvenance(v, `findings.${k}`)
    findingsOut[k] = v
  }
  for (const e of evidence) {
    if (typeof e.present !== 'boolean') throw new Error(`observation: evidence entry for "${e.kind}" must set present explicitly (true/false), never omitted`)
  }
  if (correctsId && !correctionReason) {
    throw new Error('observation: a correction (correctsId set) requires correctionReason')
  }

  const recordedAtMs = typeof reportedAt === 'number' ? reportedAt : Date.parse(reportedAt)
  const id = mkObservationId(recordedAtMs, observerId)

  return Object.freeze({
    id,
    subjectId,
    observerId,
    observerRole: observerRole || 'reporter',
    location: location || null,
    onsetAt: onsetAt || null,
    observedAt: observedAt || null,
    reportedAt,
    syncedAt,
    findings: Object.freeze(findingsOut),
    evidence: Object.freeze(evidence.map(e => Object.freeze({ ...e }))),
    verificationTier,
    verifiedBy,
    escalatedTo,
    packId,
    packVersion,
    caseDefinitionVersion,
    correctsId,
    correctionReason,
    __observation: true,
  })
}

export function isObservation(o) {
  return !!o && typeof o === 'object' && o.__observation === true
}

export function requireObservation(o, ctx = 'observation') {
  if (!isObservation(o)) throw new Error(`observation: ${ctx} is not a real Observation (construct via mkObservation)`)
  return o
}

// Stamp syncedAt on an already-constructed Observation -- the ONE mutation
// path this module allows, and it produces a NEW frozen object rather than
// mutating the original (the original stays exactly as captured, satisfying
// sync-original-preservation). Called only by core/write-path.js at the
// moment a record actually lands in the durable raw log.
export function withSyncedAt(observation, syncedAt) {
  requireObservation(observation)
  return Object.freeze({ ...observation, syncedAt })
}

export { TIME_FIELDS }
