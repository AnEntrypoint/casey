// store/report-merge.js  --  the field-level rules for casey's report JSON blob.
//
// Three different writers need these rules and each one wraps them in its own
// locking/optimistic-concurrency machinery (mergeReport's retry loop,
// appendReportField's, mergeCases' two-key lock). The rules themselves are pure
// -- an object in, an object out -- so they live here and the retry machinery
// stays in case-store.js where the store instance it needs already is.

import { REPORT_KEYS, APPEND_FIELDS } from './report-shape.js'

// Ceiling on the accumulated photos/audio/sites field: each arrival APPENDS
// (see mergeReportFields below and case-store.js's appendReportField), so a
// long-running conversation or a malfunctioning agent loop could otherwise grow
// that field without bound. Generous enough for a genuinely long site visit
// (dozens of photo/voice-note notes) while still bounding the worst case --
// a further append past this cap is rejected loudly rather than silently
// truncated, so no worker-volunteered fact is ever silently discarded.
export const APPEND_FIELD_MAX_LEN = 20000

// Single chokepoint for the report-JSON safe-parse-with-fallback pattern, so
// fallback behavior cannot drift between call sites.
// Returns { value, corrupted }: corrupted:true means the stored report JSON
// failed to parse, so `value` is a fallback EMPTY object standing in for
// unrecoverable data, not a genuinely-empty report. A caller that merges on
// top of this MUST distinguish "the case really had no report yet"
// (corrupted:false, value:{}) from "every previously-recorded field was just
// discarded" (corrupted:true) -- without the flag a corruption event is
// indistinguishable from a normal successful merge, so nobody is warned and
// the loss is persisted. The parse ERROR is returned rather than logged here so
// the caller can attribute it to a case id (case-store.js's _parseReport).
export function parseReportJson(raw) {
  try { return { value: raw ? JSON.parse(raw) : {}, corrupted: false, error: null } }
  catch (e) { return { value: {}, corrupted: true, error: e } }
}

// Builds the merged report object from current+incoming, for a SINGLE case's
// own successive turns: a later message REFINES an earlier one, so a non-empty
// incoming value overwrites. Kept separate from the retry loop so mergeReport
// can re-run the merge against a freshly re-read row on a version conflict
// without duplicating the field-merge rules. Returns { merged, cappedFields }
// -- cappedFields lists any photos/audio/sites field whose append was rejected
// for exceeding APPEND_FIELD_MAX_LEN (the field is left at its pre-call value,
// never silently truncated).
export function mergeReportFields(current, incoming) {
  const merged = { ...current }
  const cappedFields = []
  const APPEND_KEYS = APPEND_FIELDS
  for (const [k, v] of Object.entries(incoming)) {
    if (v == null || String(v).trim() === '') continue
    // Bounded worst-case for the append-prone fields, applied to EVERY
    // write regardless of branch -- a single call carrying an oversized
    // value (an adversarial or malfunctioning agent passing a huge string
    // in one shot) must be rejected exactly like an append that grows past
    // the cap over many turns; capping only the append branch left the
    // first-write/same-value-overwrite paths open to an unbounded single
    // write. Reject, never truncate silently, so the caller can surface
    // that a note did not attach rather than a fact quietly vanishing.
    if (APPEND_KEYS.has(k) && String(v).length > APPEND_FIELD_MAX_LEN) { cappedFields.push(k); continue }
    // photos/audio/sites: a worker can give MULTIPLE across one
    // conversation (more than one photo, more than one distinct site
    // within the same visit) -- overwrite would silently discard every
    // one after the first. Every other field is a single fact that
    // genuinely replaces/refines its prior value, so overwrite stays
    // correct there.
    if (APPEND_KEYS.has(k) && merged[k] != null && String(merged[k]).trim() !== '' && String(merged[k]) !== String(v)) {
      const next = `${merged[k]}; ${v}`
      if (next.length > APPEND_FIELD_MAX_LEN) { cappedFields.push(k); continue }
      merged[k] = next
    } else {
      merged[k] = v
    }
  }
  return { merged, cappedFields }
}

// The OTHER report-merge contract: folding a source case into a canonical
// target (mergeCases). Fill-if-empty -- the target value wins and is NEVER
// overwritten by the source, unlike mergeReportFields' overwrite-on-refinement
// contract above -- for every field EXCEPT photos/audio/sites, which are
// append-only everywhere else in this codebase (mergeReportFields,
// appendReportField, and case_report's own promise that a photo note is never
// overwritten): treating those three like any other field silently DROPS the
// source's note whenever source and target both already hold a non-empty one --
// the realistic duplicate-report merge -- contradicting the append-only
// guarantee.
//
// NOTE: mergeReportFields is NOT reused here despite implementing the
// correct join-with-'; ' shape for these three keys -- it OVERWRITES
// every other field with the incoming value whenever incoming is
// non-empty, which would silently violate mergeCases' own "target value wins"
// contract for every ordinary field. Kept as an explicit fill-if-empty loop
// with only photos/audio/sites special-cased to append, so the target's
// canonical values for every OTHER field are never at risk from a source
// case's stale/conflicting data.
export function fillIfEmptyReport(tgtReport, srcReport) {
  const mergedReport = { ...tgtReport }
  for (const [k, v] of Object.entries(srcReport)) {
    if (!REPORT_KEYS.has(k)) continue
    if (v == null || String(v).trim() === '') continue
    const have = tgtReport[k] != null && String(tgtReport[k]).trim() !== ''
    if (APPEND_FIELDS.has(k) && have && String(tgtReport[k]) !== String(v)) {
      mergedReport[k] = `${tgtReport[k]}; ${v}`
    } else if (!have) {
      mergedReport[k] = v
    }
  }
  return mergedReport
}
