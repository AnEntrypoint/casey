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

// Parse a whole event list's `data` fields in one pass, returning new
// shallow-cloned rows (never mutates the store's cached rows).
export function parseEventData(events) {
  return (events || []).map(e => ({ ...e, data: evData(e) }))
}

