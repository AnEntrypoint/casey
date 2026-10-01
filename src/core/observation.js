
import { isProvenanced, requireProvenance } from './provenance.js'

let _seq = 0
function nextLocalSeq() { return ++_seq }

export function mkObservationId(recordedAtMs, actorId) {
  return `obs-${recordedAtMs}-${actorId}-${nextLocalSeq()}`
}

const TIME_FIELDS = ['onsetAt', 'observedAt', 'reportedAt', 'syncedAt']

export function mkObservation({
  subjectId,
  observerId,
  observerRole,
  location,
  onsetAt,
  observedAt,
  reportedAt,
  syncedAt = null,
  findings,
  evidence = [],
  verificationTier = 'unverified',
  verifiedBy = null,
  escalatedTo = null,
  packId,
  packVersion,
  caseDefinitionVersion = null,
  correctsId = null,
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

export function withSyncedAt(observation, syncedAt) {
  requireObservation(observation)
  return Object.freeze({ ...observation, syncedAt })
}

