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
import { canReplace, requireProvenance, mkValue } from './provenance.js'

const _locks = new Map()

async function withSubjectLock(subjectId, fn) {
  const prev = _locks.get(subjectId) || Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  _locks.set(subjectId, run)
  try { return await run }
  finally { if (_locks.get(subjectId) === run) _locks.delete(subjectId) }
}

// The chokepoint. `rawLog` is a core/raw-log.js RawLog instance (injected,
// not imported as a singleton, so each caller controls which log a write
// lands in). `nowFn` defaults to Date.now but is injectable for
// deterministic witnessing.
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
    // latestByField stores { val, reportedAt } wrapper objects -- a
    // provenanced value carries recordedAt, not reportedAt, so comparing
    // existing.reportedAt against a bare value would compare against
    // undefined forever after the first write to a field. Mirrors
    // redactSubjectFields's own wrapper shape below.
    const prior = rawLog.bySubject(subjectId)
    const latestByField = new Map()
    for (const obs of prior) {
      for (const [field, val] of Object.entries(obs.findings || {})) {
        const existing = latestByField.get(field)
        if (!existing || Date.parse(obs.reportedAt) >= Date.parse(existing.reportedAt)) {
          latestByField.set(field, { val, reportedAt: obs.reportedAt })
        }
      }
    }
    const rejectedFields = []
    const acceptedFindings = {}
    for (const [field, incoming] of Object.entries(params.findings || {})) {
      requireProvenance(incoming, `findings.${field}`)
      const currentTop = latestByField.get(field)?.val
      if (currentTop && !canReplace(currentTop, incoming)) {
        rejectedFields.push({ field, reason: `incoming provenance "${incoming.provenance}" cannot overwrite existing "${currentTop.provenance}"`, current: currentTop, incoming })
        continue
      }
      acceptedFindings[field] = incoming
    }

    const observation = mkObservation({ ...params, findings: acceptedFindings })
    const synced = withSyncedAt(observation, new Date(nowFn()).toISOString())
    await rawLog.append(synced)
    return { observation: synced, rejectedFields }
  })
}

// Right-to-erasure support for Tier 1: the raw log is structurally
// append-only (see raw-log.js's own header comment -- no update/delete
// method exists on that class), so "erase a PII field from the provenance
// subsystem" cannot mean deleting bytes. It means the documented correction
// mechanism (mkObservation's correctsId/correctionReason) applied against
// the field's CURRENT latest value (same latest-by-field derivation
// writeObservation uses above), never against every historical observation
// individually -- a field with N prior observations gets ONE redaction
// correction, not N. The correction replaces the field's value with an
// explicit marker (provenance:'reported', value:'[erased]' -- 'reported'
// because the redaction itself IS a real, human-actioned fact about this
// subject's record, not an unknown/inferred guess) and bypasses the normal
// canReplace rank check deliberately: an erasure is a legal override of the
// record, never an ordinary provenance-ranked correction, so a
// 'measured'-rank photo/audio finding must still be redactable by a
// 'reported'-rank erasure action. Idempotent: a field whose latest value is
// already the redaction marker is skipped, so a second call against an
// already-redacted subject appends nothing. Returns the list of newly-
// appended redaction Observations (empty if nothing needed redacting).
export async function redactSubjectFields(rawLog, { subjectId, fields, redactedBy, reason, packId, packVersion, nowFn = () => Date.now() }) {
  if (!rawLog || typeof rawLog.append !== 'function') throw new Error('redactSubjectFields: rawLog (a RawLog instance) is required')
  if (!subjectId) throw new Error('redactSubjectFields: subjectId is required')
  if (!Array.isArray(fields) || !fields.length) throw new Error('redactSubjectFields: fields must be a non-empty array')
  if (!redactedBy) throw new Error('redactSubjectFields: redactedBy is required')

  return withSubjectLock(subjectId, async () => {
    const nowIso = new Date(nowFn()).toISOString()
    const prior = rawLog.bySubject(subjectId)
    if (!prior.length) return []
    // Latest value per field across the WHOLE subject history, same
    // derivation writeObservation uses -- a redaction must act on the
    // field's current truth, not on every stale historical observation that
    // happened to once carry it.
    // mkObservation throws on a falsy reportedAt, so "missing" is structurally
    // impossible here -- but it only checks truthiness, so an unparseable
    // string ("banana") reaches this loop and Date.parse gives NaN. Every
    // NaN comparison is false, which would silently freeze whichever record
    // was seen first as "latest" forever. Sorting unparseable oldest makes a
    // corrupt row lose to any real one instead of winning by accident. This
    // replaces a `Date.parse(x || 0)` fallback that guarded the impossible
    // case and not the reachable one, and whose 0 parsed as 2000-01-01
    // rather than the oldest-possible instant it read as.
    const at = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? -Infinity : t }
    const latestByField = new Map()
    let latestPackId = null, latestPackVersion = null
    for (const obs of prior) {
      const obsAt = at(obs.reportedAt)
      for (const [field, val] of Object.entries(obs.findings || {})) {
        const existing = latestByField.get(field)
        if (!existing || obsAt >= at(existing.reportedAt)) {
          latestByField.set(field, { val, reportedAt: obs.reportedAt, obsId: obs.id })
        }
      }
      if (!latestPackId || obsAt >= at(latestPackId.reportedAt)) {
        latestPackId = { packId: obs.packId, reportedAt: obs.reportedAt }
        latestPackVersion = obs.packVersion
      }
    }
    const toRedact = {}
    let anchorObsId = null
    for (const field of fields) {
      const latest = latestByField.get(field)
      if (!latest) continue   // this subject never had this field -- nothing to redact
      if (latest.val.value === '[erased]' && latest.val.provenance === 'reported') continue   // already redacted
      toRedact[field] = mkValue({ value: '[erased]', provenance: 'reported', recordedAt: nowIso, recordedBy: redactedBy, packVersion: latest.val.packVersion })
      anchorObsId = anchorObsId || latest.obsId
    }
    if (!Object.keys(toRedact).length) return []
    const correction = mkObservation({
      subjectId, observerId: redactedBy, observerRole: 'operator',
      reportedAt: nowIso, findings: toRedact,
      packId: packId || latestPackId?.packId, packVersion: packVersion || latestPackVersion,
      correctsId: anchorObsId, correctionReason: reason || 'erasure',
    })
    const synced = withSyncedAt(correction, nowIso)
    await rawLog.append(synced)
    return [synced]
  })
}
