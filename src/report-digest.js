import { loadResolved, buildDiseaseReport, monthStartOf, monthEndOf, monthOf, previousPeriod, parseBound } from './dashboard/routes/reports-map.js'
import { MIN_AGGREGATE_CELL, SPARSE_BUCKET_KEY } from './privacy.js'

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/
const TOP_DISEASES = 5
const WEBHOOK_TIMEOUT_MS = 10000

const csvCell = (v) => {
  let s = v == null ? '' : String(v)
  if (/^\s*[=+\-@\t\r]/.test(s)) s = "'" + s
  if (s.includes(',') || s.includes('\n') || s.includes('\r') || s.includes('"')) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

export function lastCompletedMonth(nowSec = Math.floor(Date.now() / 1000)) {
  return monthOf(monthStartOf(nowSec) - 1)
}

export function monthWindow(month) {
  if (!MONTH_PATTERN.test(month)) throw new Error('--month must look like 2026-03')
  const start = monthStartOf(parseBound(month + '-01'))
  return { from: start, to: monthEndOf(start) }
}

export function digestCsv(rep) {
  const lines = [['view', 'disease', 'region', 'period', 'cases'].join(',')]
  const add = (view, list, cols) => { for (const c of list) lines.push([view, ...cols.map(k => csvCell(c[k] ?? 'all')), csvCell(c.count)].join(',')) }
  add('disease', rep.by_disease, ['disease', 'region', 'month'])
  add('disease_by_region', rep.by_disease_region, ['disease', 'region', 'month'])
  add('disease_by_period', rep.by_disease_month, ['disease', 'region', 'month'])
  add('disease_region_period', rep.cells, ['disease', 'region', 'month'])
  lines.push(...rep.by_district.map(c => ['district', 'all', csvCell(c.district), 'all', csvCell(c.count)].join(',')))
  lines.push(...rep.by_conclusion.map(c => ['conclusion', 'all', 'all', csvCell(c.conclusion), csvCell(c.count)].join(',')))
  lines.push(...rep.by_disease_conclusion.map(c => ['disease_conclusion', csvCell(c.disease), 'all', csvCell(c.conclusion), csvCell(c.count)].join(',')))
  const note = (text) => lines.push(['note', 'all', 'all', csvCell(text), ''].join(','))
  note(`Groups of fewer than ${MIN_AGGREGATE_CELL} cases are combined under ${SPARSE_BUCKET_KEY}. No case-level or personal data is included.`)
  if (rep.truncated) note('There are more reports than this export can load, so the figures leave some out.')
  return lines.join('\n') + '\n'
}

function trendLine(rep, month) {
  const before = previousPeriod(month)
  const diseases = rep.trend && rep.trend.period === month ? rep.trend.diseases : []
  if (!diseases.length) return `Trend against ${before}: not enough cases to compare.`
  const parts = diseases.slice(0, TOP_DISEASES).map(d => {
    if (d.change == null) return `${d.disease} (no comparable figure for ${before})`
    const sign = d.change > 0 ? '+' : ''
    return `${d.disease} ${sign}${d.change} (${d.previous} in ${before})`
  })
  return `Trend against ${before}: ${parts.join('; ')}.`
}

export function digestText(rep, month) {
  const lines = [`Casey monthly disease digest, ${month}`]
  if (!rep.total) {
    lines.push(`Fewer than ${MIN_AGGREGATE_CELL} resolved cases this month, so no figures are published.`)
  } else {
    lines.push(`Resolved cases: ${rep.total}`)
    const suspected = rep.by_status.find(x => x.status === 'suspected')
    if (suspected) lines.push(`Of which suspected, not confirmed: ${suspected.count}`)
    if (rep.ruled_out) lines.push(`Ruled out, not counted: ${rep.ruled_out}`)
    lines.push('Top diseases: ' + rep.by_disease.slice(0, TOP_DISEASES).map(d => `${d.disease} ${d.count}`).join(', '))
    lines.push('By district: ' + (rep.by_district.length ? rep.by_district.map(d => `${d.district} ${d.count}`).join(', ') : 'no district is large enough to show'))
    lines.push(trendLine(rep, month))
    lines.push('Advice given: ' + (rep.by_conclusion.length ? rep.by_conclusion.map(c => `${c.conclusion} ${c.count}`).join(', ') : 'no group is large enough to show'))
  }
  lines.push('Closed without a diagnosis: ' + (rep.closed_without_diagnosis ?? `fewer than ${MIN_AGGREGATE_CELL}`))
  if (rep.truncated) lines.push('Some reports could not be loaded, so figures leave some out.')
  lines.push(`Groups of fewer than ${MIN_AGGREGATE_CELL} cases are combined. No personal data is included.`)
  return lines.join('\n')
}

export async function buildDigest(store, month = lastCompletedMonth()) {
  const { from, to } = monthWindow(month)
  const wide = await loadResolved(store, { from: monthStartOf(from - 1), to })
  const inMonth = wide.filter(r => r.sec >= from)
  inMonth.truncated = wide.truncated
  const monthRows = await loadResolved(store, { from, to })
  inMonth.undiagnosed = monthRows.undiagnosed
  inMonth.ruledOut = monthRows.ruledOut
  const rep = buildDiseaseReport(inMonth)
  rep.trend = buildDiseaseReport(wide).trend
  return { month, rep, csv: digestCsv(rep), text: digestText(rep, month) }
}

export async function postDigest(webhookUrl, text) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`)
}
