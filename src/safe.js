// safe.js -- casey's small collection of defensive parsing helpers, used
// wherever a value crosses a trust boundary (thatcher row data, an env var,
// contact-supplied text) and a malformed input must degrade rather than throw.

// Parse a JSON array, tolerating anything malformed as an empty array (never
// throws). Used for report fields (photos/audio/sites) that append as a JSON
// array string on the thatcher row.
export function parseJsonArraySafe(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : [] }
  catch { return [] }
}

// Parse a single event's `data` field, which thatcher returns as a JSON
// string. `null`/already-an-object/malformed all degrade to {} rather than
// throwing -- see AGENTS.md "Event `data` is parsed at the read edge".
export function evData(e) {
  const d = e?.data
  if (d == null) return {}
  if (typeof d === 'object') return d
  if (typeof d === 'string') { try { return JSON.parse(d) || {} } catch { return {} } }
  return {}
}

// Coerce a thatcher/busybase integer column to a real number. busybase reads
// integer columns back as DIGIT STRINGS (e.g. "1", "1788821199" -- see AGENTS.md
// "thatcher / busybase chain"), which makes bare arithmetic on a row value
// CONCATENATE instead of add: `"1" + 1` is `"11"`. That bug shipped once, in
// case-store.js's learnOperatorActivity, where nine operator actions accumulated
// case_count "111111111" and the map's coverage tooltip rendered it verbatim.
// Anything non-numeric (null, "", a corrupt legacy run of 1s beyond the safe
// integer range) degrades to `fallback` rather than propagating NaN.
export function rowInt(v, fallback = 0) {
  if (v == null || v === '') return fallback
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : fallback
}

// Parse a whole event list's `data` fields in one pass, returning new
// shallow-cloned rows (never mutates the store's cached rows).
export function parseEventData(events) {
  return (events || []).map(e => ({ ...e, data: evData(e) }))
}

