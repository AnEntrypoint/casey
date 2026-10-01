

import { animalHealthPack } from './packs/animal-health.js'
import { loadPack } from './core/pack-schema.js'
import { mkValue } from './core/provenance.js'
import { writeObservation } from './core/write-path.js'
import { RawLog } from './core/raw-log.js'

const PACK = loadPack(animalHealthPack)

const PACK_FIELD_MAP = PACK.observationForms.sick_or_dead_animal.fields

let _rawLog = null
function getRawLog(dataDir) {
  if (!_rawLog) _rawLog = new RawLog({ dataDir })
  return _rawLog
}

export async function recordProvenanceObservation({ dataDir, caseId, author, incoming, hasLatLon, lat, lon, recordedAtMs = Date.now() }) {
  const findings = {}
  const mk = (value) => mkValue({ value, provenance: 'reported', recordedAt: recordedAtMs, recordedBy: author || 'unknown', packVersion: PACK.version })
  for (const [field, value] of Object.entries(incoming || {})) {
    if (value == null || String(value).trim() === '') continue

    const packField = field === 'location' ? 'location_text' : field
    if (!(packField in PACK_FIELD_MAP)) continue
    findings[packField] = mk(value)
  }
  if (hasLatLon) {
    findings.location = mk({ lat, lon })
  }
  if (!Object.keys(findings).length) return null

  const rawLog = getRawLog(dataDir)
  return writeObservation(rawLog, {
    subjectId: caseId,
    observerId: author || 'unknown',
    observerRole: 'reporter',
    reportedAt: new Date(recordedAtMs).toISOString(),
    findings,
    packId: PACK.id,
    packVersion: PACK.version,
  })
}
