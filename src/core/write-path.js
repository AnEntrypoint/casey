// core/write-path.js -- THE single physical write-path chokepoint.
//
// Every observation write in casey's new provenance subsystem passes through
// writeObservation() below, once. There is no second entrance: the field
// worker's agent turn, a dashboard operator's correction, and a future sync
// reconciler all call this same function. Concurrency is handled here (an
// async mutex per subject, mirroring case-store.js's own `_withLock`
// pattern) so two writers racing the same subject never interleave badly --
// see expansion-concurrent-write-path-race.
//
// This module does NOT replace casey's existing thatcher-backed
// case_report/mergeReport path (src/case-store.js, src/case-tools.js) --
// those keep writing the case.report JSON blob exactly as they do today.
// This is an ADDITIVE second write: every call into this chokepoint also
// produces a durable, provenance-tagged Observation in the raw log,
// independent of and never overwriting the existing thatcher case row.

import { mkObservation, withSyncedAt } from './observation.js'
import { canReplace, requireProvenance } from './provenance.js'

const _locks = new Map()

async function withSubjectLock(subjectId, fn) {
  const prev = _locks.get(subjectId) || Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  _locks.set(subjectId, run)
  try { return await run }
  finally { if (_locks.get(subjectId) === run) _locks.delete(subjectId) }
}

// The chokepoint. `rawLog` is a core/raw-log.js RawLog instance (injected,
// not imported as a singleton, so callers control which log -- production
// vs. a test harness -- a write lands in). `nowFn` defaults to Date.now but
// is injectable for deterministic witnessing.
export async function writeObservation(rawLog, params, { nowFn = () => Date.now() } = {}) {
  if (!rawLog || typeof rawLog.append !== 'function') throw new Error('writeObservation: rawLog (a RawLog instance) is required')
  const { subjectId } = params
  if (!subjectId) throw new Error('writeObservation: subjectId is required')

  return withSubjectLock(subjectId, async () => {
    // Enforce no-silent-inference at the chokepoint itself: for every
    // finding whose field already has a prior observation on this subject
    // with a HIGHER provenance rank, an incoming lower-rank value is
    // rejected rather than silently accepted and later shadowing the truth
    // in a dashboard that reads "most recent wins" naively. The caller gets
    // the rejected fields back so it can decide (e.g. keep asking the
    // worker, or record the new value as a disputed correction with an
    // explicit correctsId + reason instead).
    const prior = rawLog.bySubject(subjectId)
    const latestByField = new Map()
    for (const obs of prior) {
      for (const [field, val] of Object.entries(obs.findings || {})) {
        const existing = latestByField.get(field)
        if (!existing || Date.parse(obs.reportedAt) >= Date.parse(existing.reportedAt)) {
          latestByField.set(field, val)
        }
      }
    }
    const rejectedFields = []
    const acceptedFindings = {}
    for (const [field, incoming] of Object.entries(params.findings || {})) {
      requireProvenance(incoming, `findings.${field}`)
      const currentTop = latestByField.get(field)
      if (currentTop && !canReplace(currentTop, incoming)) {
        rejectedFields.push({ field, reason: `incoming provenance "${incoming.provenance}" cannot overwrite existing "${currentTop.provenance}"`, current: currentTop, incoming })
        continue
      }
      acceptedFindings[field] = incoming
    }

    const observation = mkObservation({ ...params, findings: acceptedFindings })
    const synced = withSyncedAt(observation, new Date(nowFn()).toISOString())
    rawLog.append(synced)
    return { observation: synced, rejectedFields }
  })
}
