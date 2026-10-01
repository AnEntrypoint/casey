

const SEC = 1000

export { evData } from './safe.js'
import { evData } from './safe.js'
import { isOpenCase } from './format.js'

function evMs(e) {
  const v = e?.created_at
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n * SEC : null
}

function median(xs) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y)
  if (!a.length) return null
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2)
}

function p90(xs) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y)
  if (!a.length) return null
  const idx = Math.min(a.length - 1, Math.ceil(0.9 * a.length) - 1)
  return a[Math.max(0, idx)]
}

function firstResponseMs(events) {
  const sorted = [...events].filter(e => evMs(e) != null).sort((a, b) => evMs(a) - evMs(b))
  const firstIn = sorted.find(e => e.kind === 'inbound')
  if (!firstIn) return null
  const reply = sorted.find(e => e.kind === 'outbound' && evMs(e) >= evMs(firstIn))
  if (!reply) return null
  const d = evMs(reply) - evMs(firstIn)
  return d >= 0 ? d : null
}

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

export function buildOverview(cases, eventsByCaseId, now = Date.now(), windowMs = 14 * 24 * 3600 * SEC) {
  const since = now - windowMs
  const responseMs = []
  const dwell = {}
  const backlog = {}
  const openedByDay = {}
  const closedByDay = {}
  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10)
  let open = 0, closed = 0

  for (const c of cases || []) {
    const events = eventsByCaseId.get?.(c.id) || eventsByCaseId[c.id] || []
    const r = firstResponseMs(events)
    if (r != null) responseMs.push(r)
    accumulateDwell(dwell, c, events)

    const isClosed = !isOpenCase(c)
    if (isClosed) closed++; else { open++; backlog[c.status] = (backlog[c.status] || 0) + 1 }

    const createdMs = evMs({ created_at: c.created_at })
    if (createdMs != null && createdMs >= since) openedByDay[dayKey(createdMs)] = (openedByDay[dayKey(createdMs)] || 0) + 1
    if (isClosed) {

      const lastClose = [...events].filter(e => e.kind === 'transition' && (evData(e).to === 'resolved' || evData(e).to === 'closed') && evMs(e) != null).sort((a, b) => evMs(a) - evMs(b)).pop()
      const cm = lastClose ? evMs(lastClose) : evMs({ created_at: c.updated_at })
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

export { median, firstResponseMs }
