// store/report-shape.js  --  the report-field vocabulary a case's free-form
// report JSON is built from. Extracted from case-store.js (structural split
// only; values are byte-identical to the original inline definitions).

export const REPORT_KEYS = new Set(['species', 'symptoms', 'location', 'how_to_find', 'affected_count', 'dead_count', 'onset', 'suspected_disease', 'recent_movement', 'identifying_traits', 'access_notes', 'farmer_available', 'contact_fallback', 'photos', 'audio', 'notes',
  // People on site for a field-worker report: who the worker spoke to and their
  // link to the owner, plus the owner's identity/contact -- so an absent owner with
  // a relative present is still captured. Reported by the worker, model- or
  // pending-ask-captured (no deterministic extractor).
  'present_person', 'present_person_relation', 'owner_name', 'owner_contact', 'language_detected',
  // A SECOND distinct site/herd within the same visit (species/location/count
  // fields above stay the primary site) -- append-only, see mergeReport.
  'sites'])

// Same fields, ordered for stable display/fill-rate rendering (dashboard).
export const REPORT_KEY_ORDER = ['species', 'symptoms', 'affected_count', 'dead_count', 'onset',
  'suspected_disease', 'recent_movement', 'location', 'how_to_find', 'access_notes',
  'farmer_available', 'contact_fallback', 'identifying_traits', 'photos', 'audio', 'notes',
  'present_person', 'present_person_relation', 'owner_name', 'owner_contact', 'language_detected', 'sites']
