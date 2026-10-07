import fs from 'node:fs'
import path from 'node:path'
import { loadResolved, buildDiseaseReport, reportCsvLines, monthStartOf, monthEndOf, monthOf, previousPeriod, parseBound, periodLabel, printName } from './dashboard/routes/reports-map.js'
import { MIN_AGGREGATE_CELL } from './privacy.js'
import { fmtTimeSAST } from './format.js'

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/
const TOP_DISEASES = 5
const WEBHOOK_TIMEOUT_MS = 10000
export const DIGEST_STATUS_FILE = 'casey-digest-status.json'

export function recordDigestStatus(dir, month, entry) {
  const file = path.join(dir, DIGEST_STATUS_FILE)
  fs.mkdirSync(dir, { recursive: true })
  let all = {}
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  all[month] = { ...entry, ran_at: new Date().toISOString() }
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(all, null, 2) + '\n')
  fs.renameSync(temp, file)
}

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

export function digestCsv(rep, month) {
  return '\uFEFF' + reportCsvLines(rep, periodLabel(monthWindow(month)), csvCell).join('\r\n') + '\r\n'
}

function trendLine(rep, month) {
  const before = previousPeriod(month)
  const diseases = rep.trend && rep.trend.period === month ? rep.trend.diseases : []
  if (!diseases.length) return `Trend against ${before}: not enough cases to compare.`
  const parts = diseases.slice(0, TOP_DISEASES).map(d => {
    if (d.change == null) return `${printName(d.disease)} (no comparable figure for ${before})`
    const sign = d.change > 0 ? '+' : ''
    return `${printName(d.disease)} ${sign}${d.change} (${d.previous} in ${before})`
  })
  return `Trend against ${before}: ${parts.join('; ')}.`
}

export function digestText(rep, month) {
  const lines = [
    `Casey monthly disease digest, ${month}${rep.truncated ? ' (INCOMPLETE)' : ''}`,
    `Generated ${fmtTimeSAST(Date.now())}. Months are SAST calendar months.`,
  ]
  if (!rep.total) {
    lines.push(`Fewer than ${MIN_AGGREGATE_CELL} resolved cases this month, so no figures are published.`)
  } else {
    lines.push(`Signed-off cases with a diagnosis: ${rep.total}`)
    const suspected = rep.by_status.find(x => x.status === 'suspected')
    if (suspected) lines.push(`Of which suspected, not confirmed: ${suspected.count}`)
    if (rep.ruled_out) lines.push(`Ruled out, not counted: ${rep.ruled_out}`)
    lines.push('Top diseases: ' + rep.by_disease.slice(0, TOP_DISEASES).map(d => `${printName(d.disease)} ${d.count}`).join(', '))
    lines.push('By district: ' + (rep.by_district.length ? rep.by_district.map(d => `${printName(d.district)} ${d.count}`).join(', ') : 'no district is large enough to show'))
    lines.push(trendLine(rep, month))
    lines.push('Advice given (one case can count under more than one kind): ' + (rep.by_conclusion.length ? rep.by_conclusion.map(c => `${printName(c.conclusion)} ${c.count}`).join(', ') : 'no group is large enough to show'))
  }
  lines.push('With a photo: ' + (rep.total && rep.with_photo != null ? rep.with_photo + ' of ' + rep.total : `fewer than ${MIN_AGGREGATE_CELL} cases`))
  lines.push('Closed without a diagnosis: ' + (rep.closed_without_diagnosis ?? `fewer than ${MIN_AGGREGATE_CELL}`))
  if (rep.truncated) lines.push('INCOMPLETE: some reports could not be loaded, so figures leave some out.')
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
  rep.trend = buildDiseaseReport(wide, { to }).trend
  return { month, rep, csv: digestCsv(rep, month), text: digestText(rep, month) }
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
