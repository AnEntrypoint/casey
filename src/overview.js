// Management KPIs over the case + event history. Pure and deterministic: given
// the case rows, their events, and `now`, it returns aggregate-only numbers (no
// per-contact rows leak) for the dashboard Metrics tab and the management report.
// Lifted into its own module (like src/attn.js, src/format.js) so the same maths
// is testable in node and identical whether the web tab or a CSV export calls it.
//
// Times in stored events are unix SECONDS (integer). All durations returned are
// MILLISECONDS so the SAST formatters and the threshold config (also ms) agree.

const SEC = 1000

// thatcher persists event.data as a JSON string (case-store.appendEvent), and
// store.listEvents returns it unparsed. Read it as an object either way: an object
// passes through, a string is parsed, anything malformed is {} (never throws).
// Without this, reads like data.from/data.by silently miss (a string has no such
// key), mis-attributing dwell-per-stage and reply credit. Shared by workload.js.
export function evData(e) {
  const d = e?.data
  if (d == null) return {}
  if (typeof d === 'object') return d
  if (typeof d === 'string') { try { return JSON.parse(d) || {} } catch { return {} } }
  return {}
}

// created_at is unix seconds; -> ms, or null if missing/corrupt (never throws).
function evMs(e) {
  const v = e?.created_at
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n * SEC : null
}

// Median of a numeric array (ms). null for an empty set so a card can show "--"
// rather than a misleading 0.
function median(xs) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y)
  if (!a.length) return null
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2)
}

// p90 (nearest-rank). null for empty.
function p90(xs) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y)
  if (!a.length) return null
  const idx = Math.min(a.length - 1, Math.ceil(0.9 * a.length) - 1)
  return a[Math.max(0, idx)]
}

// First inbound -> first following outbound, per case, in ms. Cases with no
// inbound, or an inbound never answered, contribute nothing (not a 0).
function firstResponseMs(events) {
  const sorted = [...events].filter(e => evMs(e) != null).sort((a, b) => evMs(a) - evMs(b))
  const firstIn = sorted.find(e => e.kind === 'inbound')
  if (!firstIn) return null
  const reply = sorted.find(e => e.kind === 'outbound' && evMs(e) >= evMs(firstIn))
  if (!reply) return null
  const d = evMs(reply) - evMs(firstIn)
  return d >= 0 ? d : null
}

// Dwell per stage from transition events: time spent IN each `from` stage before
// moving to `to`. The opening stage's dwell is measured from case creation to the
// first transition. Returns { stage: [durationsMs...] } accumulated across cases.
function accumulateDwell(into, caseRow, events) {
  const trans = [...events].filter(e => e.kind === 'transition' && evMs(e) != null).sort((a, b) => evMs(a) - evMs(b))
  let prevMs = evMs({ created_at: caseRow?.created_at })
  let prevStage = trans.length ? (evData(trans[0]).from || caseRow?.status) : caseRow?.status
  for (const t of trans) {
    const from = evData(t).from || prevStage
    const at = evMs(t)
    if (prevMs != null && at != null && at >= prevMs) {
      (into[from] = into[from] || []).push(at - prevMs)
    }
    prevMs = at
    prevStage = evData(t).to || prevStage
  }
}

// Build the overview. `cases` are the rows; `eventsByCaseId` maps id -> events[].
// `windowMs` scopes the opened/closed-per-day counts (default 14 days).
export function buildOverview(cases, eventsByCaseId, now = Date.now(), windowMs = 14 * 24 * 3600 * SEC) {
  const since = now - windowMs
  const responseMs = []
  const dwell = {}
  const backlog = {}
  const openedByDay = {}
  const closedByDay = {}
  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10) // UTC day bucket; labels rendered SAST by caller
  let open = 0, closed = 0

  for (const c of cases || []) {
    const events = eventsByCaseId.get?.(c.id) || eventsByCaseId[c.id] || []
    const r = firstResponseMs(events)
    if (r != null) responseMs.push(r)
    accumulateDwell(dwell, c, events)

    const isClosed = c.status === 'resolved' || c.status === 'closed'
    if (isClosed) closed++; else { open++; backlog[c.status] = (backlog[c.status] || 0) + 1 }

    const createdMs = evMs({ created_at: c.created_at })
    if (createdMs != null && createdMs >= since) openedByDay[dayKey(createdMs)] = (openedByDay[dayKey(createdMs)] || 0) + 1
    if (isClosed) {
      // closed time approximated by the last transition INTO a terminal stage
      const lastClose = [...events].filter(e => e.kind === 'transition' && (evData(e).to === 'resolved' || evData(e).to === 'closed') && evMs(e) != null).sort((a, b) => evMs(a) - evMs(b)).pop()
      const cm = lastClose ? evMs(lastClose) : null
      if (cm != null && cm >= since) closedByDay[dayKey(cm)] = (closedByDay[dayKey(cm)] || 0) + 1
    }
  }

  const dwellMedian = {}
  for (const [stage, xs] of Object.entries(dwell)) dwellMedian[stage] = median(xs)

  return {
    window_ms: windowMs,
    cases: { open, closed, total: (cases || []).length },
    first_response_ms: { median: median(responseMs), p90: p90(responseMs), n: responseMs.length },
    dwell_ms_median: dwellMedian,
    backlog_by_stage: backlog,
    opened_by_day: openedByDay,
    closed_by_day: closedByDay,
  }
}

export { median, p90, firstResponseMs }
