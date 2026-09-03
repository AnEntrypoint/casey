// core/escrow-export.js -- the data-escrow export: a full, open-format dump
// of every raw Observation plus the pack version(s) that captured them, in
// a shape a national veterinary authority could read without casey itself.
// This is the concrete implementation of the failure/exit-planning
// commitment documented in PROVENANCE.md's "Data escrow" section.
//
// The export format is plain JSON Lines (the SAME format the raw log
// already uses on disk, see core/raw-log.js) plus a manifest header --
// nothing proprietary, nothing requiring casey's own code to parse.

export function buildEscrowManifest({ exportedAt, packVersions, observationCount }) {
  return {
    format: 'casey-observation-escrow-v1',
    exportedAt,
    packVersions,   // [{packId, packVersion}, ...] -- every pack version present in this export
    observationCount,
    schemaNote: 'Each subsequent line is one JSON object: a core/observation.js Observation record (subjectId, observerId, findings keyed by pack field name each carrying {value, provenance, confidence, recordedAt, recordedBy}, evidence[], verificationTier, packId, packVersion, correctsId/correctionReason for corrections). No casey-specific code is required to parse this format.',
  }
}

// Produces the full escrow payload as an array of lines (manifest first,
// then one Observation per line) ready to be written to a single JSONL
// file. Pure function of the event log -- callable at any time, safe to
// run repeatedly, never mutates anything.
export function buildEscrowExport(eventLog, { nowIso } = {}) {
  const observations = eventLog.allEvents()
  const packVersionSet = new Map()
  for (const obs of observations) {
    packVersionSet.set(`${obs.packId}@${obs.packVersion}`, { packId: obs.packId, packVersion: obs.packVersion })
  }
  const manifest = buildEscrowManifest({
    exportedAt: nowIso || new Date().toISOString(),
    packVersions: [...packVersionSet.values()],
    observationCount: observations.length,
  })
  return [JSON.stringify(manifest), ...observations.map(o => JSON.stringify(o))]
}
