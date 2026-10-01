
import { mkObservation, withSyncedAt } from './observation.js'
import { canReplace, requireProvenance, mkValue } from './provenance.js'

const _locks = new Map()

const at = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? -Infinity : t }

async function withSubjectLock(subjectId, fn) {
  const prev = _locks.get(subjectId) || Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  _locks.set(subjectId, run)
  try { return await run }
  finally { if (_locks.get(subjectId) === run) _locks.delete(subjectId) }
}

export async function writeObservation(rawLog, params, { nowFn = () => Date.now() } = {}) {
  if (!rawLog || typeof rawLog.append !== 'function') throw new Error('writeObservation: rawLog (a RawLog instance) is required')
  const { subjectId } = params
  if (!subjectId) throw new Error('writeObservation: subjectId is required')

  return withSubjectLock(subjectId, async () => {
    const prior = rawLog.bySubject(subjectId)
    const latestByField = new Map()
    for (const obs of prior) {
      for (const [field, val] of Object.entries(obs.findings || {})) {
        const existing = latestByField.get(field)
        if (!existing || at(obs.reportedAt) >= at(existing.reportedAt)) {
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

export async function redactSubjectFields(rawLog, { subjectId, fields, redactedBy, reason, packId, packVersion, nowFn = () => Date.now() }) {
  if (!rawLog || typeof rawLog.append !== 'function') throw new Error('redactSubjectFields: rawLog (a RawLog instance) is required')
  if (!subjectId) throw new Error('redactSubjectFields: subjectId is required')
  if (!Array.isArray(fields) || !fields.length) throw new Error('redactSubjectFields: fields must be a non-empty array')
  if (!redactedBy) throw new Error('redactSubjectFields: redactedBy is required')

  return withSubjectLock(subjectId, async () => {
    const nowIso = new Date(nowFn()).toISOString()
    const prior = rawLog.bySubject(subjectId)
    if (!prior.length) return []
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
      if (!latest) continue
      if (latest.val.value === '[erased]' && latest.val.provenance === 'reported') continue
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
