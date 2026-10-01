
export const PROVENANCE_KINDS = Object.freeze(['unknown', 'inferred', 'reported', 'observed', 'measured'])

const RANK = Object.freeze(Object.fromEntries(PROVENANCE_KINDS.map((k, i) => [k, i])))

export function provenanceRank(kind) {
  if (!Object.prototype.hasOwnProperty.call(RANK, kind)) throw new Error(`provenance: unknown kind "${kind}"`)
  return RANK[kind]
}

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

export function isProvenanced(v) {
  return !!v && typeof v === 'object' && v.__provenanced === true && PROVENANCE_KINDS.includes(v.provenance)
}

export function requireProvenance(v, ctx = 'value') {
  if (!isProvenanced(v)) {
    throw new Error(`provenance: ${ctx} is not a provenanced value (construct via mkValue/mkUnknown, never a bare literal)`)
  }
  return v
}

export function canReplace(current, incoming) {
  requireProvenance(incoming, 'incoming')
  if (current == null) return true
  requireProvenance(current, 'current')
  if (current.provenance === 'unknown') return true
  return provenanceRank(incoming.provenance) >= provenanceRank(current.provenance)
}

