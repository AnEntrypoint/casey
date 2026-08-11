// timestamp.js -- one shared digit-string-aware timestamp parser, replacing
// what used to be near-identical copies independently maintained in attn.js
// (tsMs), case-health.js (ms), and case-sweep.js (tsMs). All three existed
// because thatcher persists case/event timestamps as unix-SECONDS (a number,
// or a STRING when busybase binds it as text -- "1782977388"), while events/
// ISO-formatted values parse directly through Date.parse. A bare digit
// string fed straight to Date.parse is NaN, so every reader needs the same
// coercion or it silently reads a real timestamp as "unknown" -- exactly the
// class of bug the CHANGELOG records happening once already (case-sweep.js's
// tsMs was missing this exact clause, causing a false TEAM-COVERAGE page
// while operators were in fact replying). One shared implementation means a
// future fix can never apply to only some call sites again.
//
// format.js's toDate() is DELIBERATELY NOT merged into this module: toDate
// treats every bare digit value as seconds unconditionally (thatcher's
// created_at/last_event_at convention), while tsMs additionally guesses
// ms-vs-seconds by magnitude (`n < 1e12 ? seconds : already-ms`) for values
// that may arrive already in milliseconds from a different source. The two
// have genuinely different semantics for a numeric input in the 1e9-1e12
// range and must not be silently unified -- format.js keeps its own toDate.

// Normalize a thatcher/ISO timestamp to epoch ms, or NaN when unknown/corrupt.
export function tsMs(raw) {
  if (raw == null || raw === '') return NaN
  const n = typeof raw === 'number' ? raw : (/^\d+$/.test(String(raw)) ? Number(raw) : NaN)
  if (!Number.isNaN(n)) return n < 1e12 ? n * 1000 : n   // seconds -> ms
  const t = Date.parse(raw)
  return Number.isNaN(t) ? NaN : t
}

// Shared comma-separated tag-list splitter (case.tags column) -- was
// independently reimplemented in attn.js, case-health.js, and inline in
// dashboard/server.js's client-side script (that last one stays: it runs in
// the browser, a separate bundle with no shared-module import path).
export function tagList(c) {
  return String(c?.tags || '').split(',').map(s => s.trim()).filter(Boolean)
}

// Shared best-effort report-JSON parse (case.report column) -- was
// independently reimplemented in case-health.js with this exact shape.
export function parseReport(c) {
  try { return c && c.report ? JSON.parse(c.report) : {} } catch { return {} }
}

// Variant tolerating an ALREADY-PARSED report object (e.g. case-tools.js's
// slimCase pre-parses report before handing a row to correlate.js's
// suggestLinks) -- was independently reimplemented identically in
// clusters.js, geo.js, and correlate.js. Deliberately kept distinct from
// parseReport() above rather than unified: a caller that always receives the
// raw JSON-string column (case-health.js's classifyCaseHealth) has no need
// for the extra typeof-object branch, and unifying could silently change
// behavior for a caller passing a plain object that HAPPENS to be falsy-ish
// in some edge shape neither variant was written to handle. Two clear, small
// functions beat one that quietly does two different things.
export function parseReportTolerant(c) {
  if (c && typeof c.report === 'object' && c.report) return c.report
  try { return c && c.report ? JSON.parse(c.report) : {} } catch { return {} }
}
