// provenance-wire.js -- the ADDITIVE bridge from the live agent conversation
// into the new provenance/ground-truth subsystem (src/core/, src/packs/).
//
// AGENTS.md's Provenance subsystem section explicitly names this as not yet
// done: case_report continues writing directly to thatcher's case.report
// JSON blob (case-tools.js/case-store.js, UNCHANGED by this file), and this
// wires the SAME agent-recorded fields into a provenance-tagged Observation
// via writeObservation() alongside that existing write -- never instead of
// it. A failure here must never block or alter the real case_report write,
// which already landed by the time this runs.
//
// Provenance choice: every value case_report records came from the AGENT's
// own free-form extraction of what the contact said (never a device
// reading, never a worker's own structured form field) -- 'reported' is the
// correct tag per core/provenance.js's PROVENANCE_KINDS (a human told the
// system, as opposed to 'observed'/'measured' which imply a direct
// witness/device, or 'inferred' which implies the AGENT guessed rather than
// relayed). lat/lon are the one exception: casey's own doc (case-tools.js's
// case_report schema) says lat/lon may be the model's OWN best-effort
// estimate for a named place OR the worker's exact GPS -- there is no signal
// on this call telling us which, so 'reported' is still the conservative,
// honest choice (the agent is relaying what it understood, not measuring
// anything itself); a future enhancement could thread an explicit
// GPS-vs-estimate flag through case_report's own schema to upgrade this.

import { animalHealthPack } from './packs/animal-health.js'
import { mkValue } from './core/provenance.js'
import { writeObservation } from './core/write-path.js'
import { RawLog } from './core/raw-log.js'

const PACK_FIELD_MAP = animalHealthPack.observationForms.sick_or_dead_animal.fields

let _rawLog = null
function getRawLog(dataDir) {
  if (!_rawLog) _rawLog = new RawLog({ dataDir })
  return _rawLog
}

// Reset the module-level RawLog singleton -- test isolation only (mirrors
// case-runtime.js's resetCaseStore pattern), never called by production code.
export function _resetRawLogForTests() { _rawLog = null }

// incoming: the same { species, symptoms, ... } object case_report's handler
// already merged into thatcher (REPORT_KEYS-scoped). Only fields the pack
// actually declares (PACK_FIELD_MAP) are wired through -- REPORT_KEYS carries
// several casey-specific fields (present_person, owner_contact, notes, ...)
// the pack does not yet model; those stay thatcher-only until the pack is
// extended, exactly as documented ("the enumerated migration targets a
// future session should wire through"). Never throws: any failure is
// swallowed by the caller (case-tools.js case_report), matching every other
// best-effort side-write in that handler (systemUpdateDerived, contact
// last_report_* propagation).
export async function recordProvenanceObservation({ dataDir, caseId, author, incoming, hasLatLon, lat, lon, recordedAtMs = Date.now() }) {
  const findings = {}
  const mk = (value) => mkValue({ value, provenance: 'reported', recordedAt: recordedAtMs, recordedBy: author || 'unknown', packVersion: animalHealthPack.version })
  for (const [field, value] of Object.entries(incoming || {})) {
    if (value == null || String(value).trim() === '') continue
    // incoming.location is the free-text place description (case_report's `location`
    // report field), NOT the same value as the lat/lon geo pair below -- routed to the
    // pack's distinct location_text field so a described place is never silently
    // dropped when a coordinate pair is also present on the same call (both target
    // different findings keys, so neither can overwrite the other).
    const packField = field === 'location' ? 'location_text' : field
    if (!(packField in PACK_FIELD_MAP)) continue   // not a pack-declared field yet -- thatcher-only for now
    findings[packField] = mk(value)
  }
  if (hasLatLon) {
    findings.location = mk({ lat, lon })
  }
  if (!Object.keys(findings).length) return null   // nothing pack-recognized in this call -- no observation to write

  const rawLog = getRawLog(dataDir)
  return writeObservation(rawLog, {
    subjectId: caseId,
    observerId: author || 'unknown',
    observerRole: 'reporter',
    reportedAt: new Date(recordedAtMs).toISOString(),
    findings,
    packId: animalHealthPack.id,
    packVersion: animalHealthPack.version,
  })
}
