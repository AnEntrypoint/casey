import { TZ_LABEL } from './locale.js'
import fs from 'node:fs'
import path from 'node:path'
import { loadResolved, buildDiseaseReport, reportCsvLines, monthStartOf, monthEndOf, monthOf, previousPeriod, parseBound, periodLabel, printName } from './dashboard/routes/reports-map.js'
import { MIN_AGGREGATE_CELL, SPARSE_BUCKET_KEY } from './privacy.js'
import { fmtTimeLocal } from './format.js'
import { caseyText } from './deployment-text.js';

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
  if (!diseases.length) return caseyText("src/report-digest.js#w0", [before])
  const parts = diseases.slice(0, TOP_DISEASES).map(d => {
    if (d.change == null) return caseyText("src/report-digest.js#w1", [printName(d.disease), before])
    const sign = d.change > 0 ? '+' : ''
    return `${printName(d.disease)} ${sign}${d.change} (${d.previous} in ${before})`
  })
  return caseyText("src/report-digest.js#w2", [before, parts.join('; ')])
}

export function digestText(rep, month) {
  const lines = [
    caseyText("src/report-digest.js#w3", [month, rep.truncated ? ' (INCOMPLETE)' : '']),
    caseyText("src/report-digest.js#w4", [fmtTimeLocal(Date.now()), TZ_LABEL]),
  ]
  if (rep.month_cases < MIN_AGGREGATE_CELL) {
    lines.push(caseyText("src/report-digest.js#w5", [MIN_AGGREGATE_CELL]))
  } else if (!rep.total) {
    lines.push(caseyText("src/report-digest.js#w6", [MIN_AGGREGATE_CELL]))
  } else {
    lines.push(caseyText("src/report-digest.js#w7", [rep.total]))
    const suspected = rep.by_status.find(x => x.status === 'suspected')
    if (suspected) lines.push(caseyText("src/report-digest.js#w8", [suspected.count]))
    if (rep.ruled_out) lines.push(caseyText("src/report-digest.js#w9", [rep.ruled_out]))
    const named = rep.by_disease.filter(d => d.disease !== SPARSE_BUCKET_KEY).slice(0, TOP_DISEASES)
    lines.push(caseyText("src/report-digest.js#w10") + (named.length ? named.map(d => `${printName(d.disease)} ${d.count}`).join(', ') : caseyText("src/report-digest.js#w11")))
    lines.push(caseyText("src/report-digest.js#w12") + (rep.by_district.length ? rep.by_district.map(d => `${printName(d.district)} ${d.count}`).join(', ') : caseyText("src/report-digest.js#w13")))
    lines.push(trendLine(rep, month))
    lines.push(caseyText("src/report-digest.js#w14") + (rep.by_conclusion.length ? rep.by_conclusion.map(c => `${printName(c.conclusion)} ${c.count}`).join(', ') : caseyText("src/report-digest.js#w15")))
  }
  lines.push(caseyText("src/report-digest.js#w16") + (rep.total && rep.with_photo != null ? rep.with_photo + ' of ' + rep.total : caseyText("src/report-digest.js#w17", [MIN_AGGREGATE_CELL])))
  lines.push(caseyText("src/report-digest.js#w18") + (rep.closed_without_diagnosis ?? caseyText("src/report-digest.js#w19", [MIN_AGGREGATE_CELL])))
  if (rep.truncated) lines.push(caseyText("src/report-digest.js#w20"))
  lines.push(caseyText("src/report-digest.js#w21", [MIN_AGGREGATE_CELL]))
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
  rep.month_cases = inMonth.length + inMonth.undiagnosed
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
