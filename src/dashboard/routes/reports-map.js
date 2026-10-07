import { parseReport } from '../../timestamp.js'
import { statedArea, loadAreas, resolveArea } from '../../areas.js'
import { isDone } from '../../signoff-desk.js'
import { SIGNOFF_DIAGNOSIS_FIELDS, DIAGNOSIS_STATUS_KEY, normalizeDiagnosisStatus } from '../../store/report-shape.js'
import { MIN_AGGREGATE_CELL, SPARSE_BUCKET_KEY } from '../../privacy.js'
import { mountRoutes } from './register.js'

const POOL_CAP = 10000
const DISEASE_KEY = SIGNOFF_DIAGNOSIS_FIELDS[0] || 'identified_disease'
const RESOLUTION_KEY = SIGNOFF_DIAGNOSIS_FIELDS.find(k => k !== DISEASE_KEY && k !== DIAGNOSIS_STATUS_KEY) || 'recommended_resolution'

export const CONFIRMED = 'confirmed'

export const SUSPECTED = 'suspected'

export const RULED_OUT = 'ruled_out'

export const statusOf = (report) => normalizeDiagnosisStatus(report[DIAGNOSIS_STATUS_KEY]) || CONFIRMED
export const NO_CONCLUSION = 'Not stated'
const RESOLUTION_KINDS = [
  ['Vaccination', /vaccin|\binent|\binspuit|entstof|immuni[sz]/i],
  ['Quarantine or movement control', /quarantin|\bisolat(?:e\b|ion|ing)(?! sample)|\bseparat(?:e|ing) (?:the |sick |affected )?(?:animals|herd|sick)|movement|restrict|beweging|kwarantyn|isoleer/i],
  ['Culling or disposal', /\bcull|slaughter|destroy|dispos|\bbury|\bburn|doodmaak|\bbegrawe|\bverbrand|\bslagting\b|\bslag (?:die|al die|dit)\b/i],
  ['Treatment', /treat|medic|antibiotic|drug|dose|inject|\bdip(?:ping)?\b|dren[ck]|behandel/i],
  ['Referred to a vet or lab', /\bvet(?:erinar)?\b|veearts|monster|\brefer|laborator|\blab\b|sample|verwys/i],
  ['Monitoring', /monitor|watch|follow.?up|observ|\breview|revisit|\bvolg|\bopvolg|dophou/i],
]
export const OTHER_CONCLUSION = 'Other advice'

const NEGATED = /\b(?:no|not|without|never|don'?t|do not|geen|nie)[ \t]+(?:\w+[ \t]+){0,2}\w+/gi

export function conclusionKinds(text) {
  const raw = String(text == null ? '' : text)
  if (!raw.trim()) return [NO_CONCLUSION]
  const t = raw.replace(NEGATED, ' ')
  const hit = RESOLUTION_KINDS.filter(([, re]) => re.test(t)).map(([k]) => k)
  return hit.length ? hit : [OTHER_CONCLUSION]
}
const SAST_OFFSET_MS = 2 * 3600e3
const HEAT_CELL_DEG = 0.1
const POINT_ROUND = 100

export function cleanLabel(raw, max = 60) {
  return String(raw == null ? '' : raw)
    .replace(/[^\p{L}\s'()\-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim()
}

const labelKey = (label) => label.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[-&]/g, ' ').replace(/\band\b|\ben\b/g, ' ').replace(/\s+/g, ' ').trim()

export function parseBound(v, endOfDay = false) {
  if (v == null || v === '') return null
  const s = String(v).trim()
  if (/^\d{9,11}$/.test(s)) return Number(s)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = Date.parse(s + 'T00:00:00+02:00')
    return Number.isFinite(ms) ? Math.floor(ms / 1000) + (endOfDay ? 86399 : 0) : NaN
  }
  return NaN
}

const isoDate = (sec) => new Date(sec * 1000 + SAST_OFFSET_MS).toISOString().slice(0, 10)
export const monthOf = (sec) => isoDate(sec).slice(0, 7)
export function periodOf(sec, grain = 'month') {
  const m = monthOf(sec)
  if (grain === 'year') return m.slice(0, 4)
  if (grain === 'quarter') return m.slice(0, 4) + '-Q' + (Math.floor((Number(m.slice(5)) - 1) / 3) + 1)
  return m
}
export function weekStartOf(sec) {
  const d = new Date(sec * 1000 + SAST_OFFSET_MS)
  const back = (d.getUTCDay() + 6) % 7
  return new Date(d.getTime() - back * 86400e3).toISOString().slice(0, 10)
}

const round2 = (n) => Math.round(n * POINT_ROUND) / POINT_ROUND
function coords(c) {
  if (c.lat == null || c.lat === '' || c.lon == null || c.lon === '') return null
  const lat = Number(c.lat), lon = Number(c.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
}

async function resolvedSeconds(store, cases) {
  const at = new Map()
  const byCase = await store.listEventsByCase(cases.map(c => c.id)).catch(() => new Map())
  for (const c of cases) {
    let t = null
    for (const e of byCase.get(c.id) || []) {
      if (e.kind !== 'transition') continue
      let d = e.data
      if (typeof d === 'string') { try { d = JSON.parse(d) } catch { d = {} } }
      if (d && isDone({ status: d.to })) t = Number(e.created_at)
    }
    at.set(c.id, Number.isFinite(t) ? t : Number(c.updated_at || c.created_at) || 0)
  }
  return at
}

export const UNKNOWN_DISTRICT = 'unknown'

const districtOf = (areas, report) => {
  const hit = resolveArea(areas, { association: statedArea(report) })
  return cleanLabel(hit?.area.district, 60) || UNKNOWN_DISTRICT
}

export function resolvedRow(c, report, resolvedSec, areas = []) {
  const disease = cleanLabel(report[DISEASE_KEY])
  if (!disease) return null
  const species = cleanLabel(report.species, 40) || 'Not stated'
  const area = cleanLabel(statedArea(report), 60)
  const p = coords(c)
  return {
    disease, species, region: area || 'unknown', district: districtOf(areas, report), sec: resolvedSec, status: statusOf(report), photo: String(report.photos == null ? '' : report.photos).trim() !== '',
    conclusions: conclusionKinds(report[RESOLUTION_KEY]),
    ll: p ? { lat: round2(p.lat), lon: round2(p.lon) } : null,
  }
}

export const RARE_LABEL = 'Other (rare)'

const cacheMs = Number(process.env.CASEY_REPORT_CACHE_MS || 20000)
const BASE_TTL_MS = Number.isFinite(cacheMs) && cacheMs >= 0 ? cacheMs : 20000
const baseCache = new WeakMap()

function loadBase(store) {
  const hit = baseCache.get(store)
  if (hit && Date.now() - hit.at < BASE_TTL_MS) return hit.promise
  const promise = buildBase(store)
  baseCache.set(store, { at: Date.now(), promise })
  promise.catch(() => { if (baseCache.get(store)?.promise === promise) baseCache.delete(store) })
  return promise
}

async function buildBase(store) {
  const all = await store.listCases({}, { limit: POOL_CAP, offset: 0 })
  const areas = await loadAreas(store)
  const signedOff = all.filter(c => isDone(c) && c.channel !== 'system')
  const at = await resolvedSeconds(store, signedOff)
  const excluded = signedOff.filter(c => statusOf(parseReport(c)) === RULED_OUT)
  const ruledOut = excluded.map(c => ({ sec: at.get(c.id), region: cleanLabel(statedArea(parseReport(c)), 60) || 'unknown' }))
  const done = signedOff.filter(c => !excluded.includes(c))
  const withDx = done.filter(c => cleanLabel(parseReport(c)[DISEASE_KEY]))
  const undiagnosed = done.filter(c => !cleanLabel(parseReport(c)[DISEASE_KEY])).map(c => at.get(c.id))
  const raw = withDx.map(c => resolvedRow(c, parseReport(c), at.get(c.id), areas)).filter(Boolean)
  for (const field of ['disease', 'species', 'region', 'district']) {
    const spellings = new Map()
    for (const r of raw) {
      const m = spellings.get(labelKey(r[field])) || new Map()
      m.set(r[field], (m.get(r[field]) || 0) + 1); spellings.set(labelKey(r[field]), m)
    }
    const best = new Map([...spellings].map(([k, m]) => [k, [...m.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0]]))
    for (const r of raw) r[field] = best.get(labelKey(r[field]))
  }
  const held = new Map(), kinds = new Map()
  for (const r of raw) { held.set(labelKey(r.disease), (held.get(labelKey(r.disease)) || 0) + 1); kinds.set(labelKey(r.species), (kinds.get(labelKey(r.species)) || 0) + 1) }
  const rows = raw.map(r => ({
    ...r,
    disease: (held.get(labelKey(r.disease)) || 0) < MIN_AGGREGATE_CELL ? RARE_LABEL : r.disease,
    species: (kinds.get(labelKey(r.species)) || 0) < MIN_AGGREGATE_CELL ? RARE_LABEL : r.species,
  }))
  return { rows, undiagnosed, ruledOut, truncated: all.length >= POOL_CAP }
}

export async function loadResolved(store, { from = null, to = null } = {}) {
  const base = await loadBase(store)
  const rows = base.rows.filter(r => (from == null || r.sec >= from) && (to == null || r.sec <= to))
  rows.truncated = base.truncated
  rows.undiagnosed = base.undiagnosed.filter(t => (from == null || t >= from) && (to == null || t <= to)).length
  rows.ruledOut = base.ruledOut.filter(r => (from == null || r.sec >= from) && (to == null || r.sec <= to))
  return rows
}

export function rollup(rows, dims, k = MIN_AGGREGATE_CELL) {
  const groups = new Map()
  for (const r of rows) {
    const vals = dims.map(d => d(r))
    const key = JSON.stringify(vals)
    const g = groups.get(key)
    if (g) g.count++; else groups.set(key, { vals, count: 1 })
  }
  const out = []
  let sparse = 0
  for (const g of groups.values()) {
    if (g.count >= k) out.push(g); else sparse += g.count
  }
  if (sparse >= k) out.push({ vals: dims.map(() => SPARSE_BUCKET_KEY), count: sparse })
  return out.sort((a, b) => b.count - a.count || String(a.vals).localeCompare(String(b.vals)))
}

const named = (dimNames) => (g) => Object.fromEntries([...dimNames.map((n, i) => [n, g.vals[i]]), ['count', g.count]])

const floored = (n) => (n >= MIN_AGGREGATE_CELL ? n : null)

export function buildDiseaseReport(rows, { region = null, grain = 'month', to = null, trendRows = rows } = {}) {
  const inRegion = region ? rows.filter(r => labelKey(r.region) === labelKey(region)) : rows
  const dis = (r) => r.disease, reg = (r) => r.region, mon = (r) => periodOf(r.sec, grain)
  const cells = rollup(inRegion, [dis, reg, mon])
  const ruledOut = (rows.ruledOut || []).filter(r => !region || labelKey(r.region) === labelKey(region)).length
  const withDisease = rollup(inRegion, [dis])
  const rareCount = inRegion.filter(r => r.disease === RARE_LABEL).length
  const trendSource = trendRows.filter(r => (!region || labelKey(r.region) === labelKey(region)) && (to == null || r.sec <= to))
  return {
    k: MIN_AGGREGATE_CELL, grain, truncated: rows.truncated === true,
    total: floored(inRegion.length),
    by_disease: withDisease.filter(g => g.vals[0] !== RARE_LABEL).map(named(['disease'])),
    rare_diseases: floored(rareCount),
    by_status: rollup(inRegion, [(r) => r.status]).map(named(['status'])),
    ruled_out: floored(ruledOut),
    by_region: rollup(inRegion, [reg]).map(named(['region'])),
    by_district: rollup(inRegion, [(r) => r.district]).map(named(['district'])),
    by_month: rollup(inRegion, [mon]).map(named(['month'])),
    by_disease_month: rollup(inRegion, [dis, mon]).map(named(['disease', 'month'])),
    by_disease_region: rollup(inRegion, [dis, reg]).map(named(['disease', 'region'])),
    by_species: rollup(inRegion, [(r) => r.species]).map(named(['species'])),
    by_conclusion: rollup(inRegion.flatMap(r => r.conclusions.map(k => ({ k }))), [(r) => r.k]).map(named(['conclusion'])),
    by_disease_conclusion: rollup(inRegion.flatMap(r => r.conclusions.map(k => ({ d: r.disease, k }))), [(r) => r.d, (r) => r.k]).map(named(['disease', 'conclusion'])),
    with_photo: floored(inRegion.filter(r => r.photo).length),
    with_conclusion: floored(inRegion.filter(r => r.conclusions[0] !== NO_CONCLUSION).length),
    cells: cells.map(named(['disease', 'region', 'month'])),
    closed_without_diagnosis: !region && rows.undiagnosed >= MIN_AGGREGATE_CELL ? rows.undiagnosed : null,
    trend: buildTrend(trendSource, grain, MIN_AGGREGATE_CELL, to),
  }
}

function periodEndSec(sec, grain) {
  let t = sec
  while (periodOf(t, grain) === periodOf(sec, grain)) t = monthEndOf(t) + 1
  return t
}

export function previousPeriod(label, grain = 'month') {
  if (grain === 'year') return String(Number(label) - 1)
  if (grain === 'quarter') {
    const y = Number(label.slice(0, 4)), q = Number(label.slice(6))
    return q > 1 ? y + '-Q' + (q - 1) : (y - 1) + '-Q4'
  }
  const y = Number(label.slice(0, 4)), m = Number(label.slice(5))
  return m > 1 ? y + '-' + String(m - 1).padStart(2, '0') : (y - 1) + '-12'
}

export function buildTrend(rows, grain = 'month', k = MIN_AGGREGATE_CELL, anchor = null) {
  if (!rows.length) return null
  const latest = rows.reduce((m, r) => (r.sec > m ? r.sec : m), 0)
  const at = anchor ?? latest
  const period = periodOf(at, grain), before = previousPeriod(period, grain)
  const nowSec = Math.floor(Date.now() / 1000)
  const partial = nowSec < periodEndSec(at, grain) - 1
  const count = (label) => {
    const n = new Map()
    for (const r of rows) if (periodOf(r.sec, grain) === label) n.set(r.disease, (n.get(r.disease) || 0) + 1)
    return n
  }
  const current = count(period), prior = count(before)
  const diseases = [...current].filter(([disease, n]) => n >= k && disease !== RARE_LABEL).map(([disease, n]) => {
    const was = prior.get(disease) || 0
    return { disease, count: n, previous: was >= k ? was : null, change: !partial && was >= k ? n - was : null }
  }).sort((a, b) => b.count - a.count)
  return { period, previous_period: before, partial, diseases }
}

export function monthEndOf(sec) {
  const d = new Date(sec * 1000 + SAST_OFFSET_MS)
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - SAST_OFFSET_MS) / 1000) - 1
}

export function monthStartOf(sec) {
  const d = new Date(sec * 1000 + SAST_OFFSET_MS)
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - SAST_OFFSET_MS) / 1000)
}

function windowOf(req, res) {
  const from = parseBound(req.query.from), to = parseBound(req.query.to, true)
  if (Number.isNaN(from) || Number.isNaN(to)) { res.status(400).json({ error: 'from and to must be a date like 2026-03-31 or unix seconds' }); return null }
  return { from, to }
}
const grainOf = (req) => (['month', 'quarter', 'year'].includes(req.query.grain) ? req.query.grain : 'month')
const statusAsked = (req) => normalizeDiagnosisStatus(req.query.status)

const asked = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null)

export function getResolvedMap({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const w = windowOf(req, res); if (!w) return
    const region = asked(req.query.region)
    const species = asked(req.query.species)
    const status = statusAsked(req)
    let rows = await loadResolved(store, w)
    if (status) rows = rows.filter(r => r.status === status)
    if (region) rows = rows.filter(r => labelKey(r.region) === labelKey(region))
    if (species) rows = rows.filter(r => labelKey(r.species) === labelKey(species))
    const placed = rows.filter(r => r.ll)
    const pointKey = (ll) => ll.lat + ':' + ll.lon
    const cellCount = new Map()
    for (const r of placed) { const key = pointKey(r.ll); cellCount.set(key, (cellCount.get(key) || 0) + 1) }
    const points = placed.filter(r => cellCount.get(pointKey(r.ll)) >= MIN_AGGREGATE_CELL).map(r => ({
      lat: r.ll.lat, lon: r.ll.lon, disease: r.disease, species: r.species, status: r.status, advice: r.conclusions, resolved_at: weekStartOf(r.sec),
    })).sort((a, b) => a.resolved_at < b.resolved_at ? -1 : a.resolved_at > b.resolved_at ? 1 : 0)
    res.json({ k: MIN_AGGREGATE_CELL, count: points.length, withheld: floored(placed.length - points.length), without_location: floored(rows.length - placed.length), precision_km: 1, truncated: rows.truncated === true, points })
  }
}

async function diseaseReportFor(store, w, { region, grain }) {
  const rows = await loadResolved(store, w)
  const trendRows = await loadResolved(store, { to: w.to })
  return buildDiseaseReport(rows, { region, grain, to: w.to, trendRows })
}

export function getDiseases({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const w = windowOf(req, res); if (!w) return
    res.json(await diseaseReportFor(store, w, { region: asked(req.query.region), grain: grainOf(req) }))
  }
}

const PRINT_NAMES = { [SPARSE_BUCKET_KEY]: 'Small groups combined', [RARE_LABEL]: `Other diseases, each under ${MIN_AGGREGATE_CELL} cases`, unknown: 'Not stated' }
const printName = (v) => PRINT_NAMES[v] || String(v)

const diseaseRows = (rep) => (rep.rare_diseases == null ? rep.by_disease : [...rep.by_disease, { disease: RARE_LABEL, count: rep.rare_diseases }])

export function diseaseReportBody(rep, { period, region, generated }, { esc, row, tbl }) {
  const orBelow = (v) => v ?? `fewer than ${rep.k}`
  const list = (head, items, key) => tbl([head, 'Cases'], items.map(x => row([printName(x[key]), x.count])))
  const trendNote = rep.trend?.partial ? `<p>The period ${esc(rep.trend.period)} is not finished, so no change is shown.</p>` : ''
  const trend = rep.trend && rep.trend.diseases.length
    ? trendNote + tbl(['Disease', rep.trend.period, rep.trend.previous_period, 'Change'], rep.trend.diseases.map(d => row([
      d.disease, d.count, orBelow(d.previous), d.change == null ? '-' : (d.change > 0 ? '+' : '') + d.change,
    ])))
    : trendNote + `<p>Not enough cases to compare with the period before.</p>`
  const byMonth = rep.by_month.slice().sort((a, b) => String(a.month).localeCompare(String(b.month)))
  const confirmedOrSuspected = rep.by_status.map(x => row([x.status, x.count])).join('') + (rep.ruled_out ? row(['ruled out, not counted above', rep.ruled_out]) : '')
  const totals = tbl(['Measure', 'Cases'], [
    row(['signed-off cases', orBelow(rep.total)]),
    row(['signed-off cases with advice recorded', orBelow(rep.with_conclusion)]),
    row(['signed-off cases with a photo', orBelow(rep.with_photo)]),
    row(['closed without a diagnosis', orBelow(rep.closed_without_diagnosis)]),
  ])
  return `<h1>Disease report</h1>`
    + `<p class="meta">Generated ${esc(generated)}. Period: ${esc(period)}. Area: ${esc(region || 'all areas')}. Grouped by ${esc(rep.grain)}.</p>`
    + `<h2>Totals</h2>${totals}`
    + `<h2>Confirmed and suspected</h2>` + (confirmedOrSuspected ? `<table>${confirmedOrSuspected}</table>` : `<p>none</p>`)
    + `<h2>By disease</h2>` + list('Disease', diseaseRows(rep), 'disease')
    + `<h2>By area</h2>` + list('Area', rep.by_region, 'region')
    + `<h2>By district</h2>` + list('District', rep.by_district, 'district')
    + `<h2>Compared with the period before</h2>` + trend
    + `<h2>Advice given at sign-off</h2>` + list('Advice', rep.by_conclusion, 'conclusion')
    + `<h2>By ${esc(rep.grain)}</h2>` + list('Period', byMonth, 'month')
    + `<p class="meta">Groups of fewer than ${rep.k} cases are combined under "${printName(SPARSE_BUCKET_KEY)}" so no single report can be picked out. No case-level or personal data is included.${rep.truncated ? ' There are more reports than could be loaded, so the figures leave some out.' : ''}</p>`
}

export function getDiseasesPrint(deps) {
  const { store, authed, esc, fmtTimeSAST, printableReportRow, printableReportTable, printableReport } = deps
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const w = windowOf(req, res); if (!w) return
    const region = asked(req.query.region)
    const rep = await diseaseReportFor(store, w, { region, grain: grainOf(req) })
    const period = w.from == null && w.to == null ? 'all time' : `${asked(req.query.from) || 'start'} to ${asked(req.query.to) || 'now'}`
    const body = diseaseReportBody(rep, { period, region, generated: fmtTimeSAST(Math.floor(Date.now() / 1000)) }, { esc, row: printableReportRow, tbl: printableReportTable })
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(printableReport('Disease report', body))
  }
}

export function getHeat({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const w = windowOf(req, res); if (!w) return
    const scope = req.query.scope === 'all' ? 'all' : 'resolved'
    const disease = asked(req.query.disease) ? cleanLabel(req.query.disease) : null
    const advice = asked(req.query.advice)
    const region = asked(req.query.region)
    const species = asked(req.query.species)
    const status = statusAsked(req)
    const pts = []
    let truncated = false
    if (scope === 'resolved') {
      const resolved = await loadResolved(store, w)
      truncated = resolved.truncated === true
      for (const r of resolved) {
        if (r.ll && (!region || labelKey(r.region) === labelKey(region)) && (!disease || labelKey(r.disease) === labelKey(disease)) && (!species || labelKey(r.species) === labelKey(species)) && (!status || r.status === status) && (!advice || r.conclusions.some(k => labelKey(k) === labelKey(advice)))) pts.push(r.ll)
      }
    } else {
      const all = await store.listCases({}, { limit: POOL_CAP, offset: 0 })
      truncated = all.length >= POOL_CAP
      for (const c of all) {
        if (c.channel === 'system') continue
        const t = Number(c.created_at)
        if (w.from != null && t < w.from) continue
        if (w.to != null && t > w.to) continue
        const p = coords(c)
        if (!p) continue
        const rep = parseReport(c)
        if (statusOf(rep) === RULED_OUT) continue
        if (region && labelKey(cleanLabel(statedArea(rep), 60) || 'unknown') !== labelKey(region)) continue
        if (disease && labelKey(cleanLabel(rep[DISEASE_KEY])) !== labelKey(disease)) continue
        if (species && labelKey(cleanLabel(rep.species, 40) || 'Not stated') !== labelKey(species)) continue
        if (status && (!cleanLabel(rep[DISEASE_KEY]) || statusOf(rep) !== status)) continue
        if (advice && !conclusionKinds(rep[RESOLUTION_KEY]).some(k => labelKey(k) === labelKey(advice))) continue
        pts.push(p)
      }
    }
    const cellOf = (n) => Math.floor(n / HEAT_CELL_DEG)
    const cells = new Map()
    for (const p of pts) {
      const key = cellOf(p.lat) + ':' + cellOf(p.lon)
      const g = cells.get(key)
      if (g) g.count++; else cells.set(key, { i: cellOf(p.lat), j: cellOf(p.lon), count: 1 })
    }
    const released = [...cells.values()].filter(g => g.count >= MIN_AGGREGATE_CELL).map(g => ({
      lat: Math.round((g.i + 0.5) * HEAT_CELL_DEG * 1000) / 1000,
      lon: Math.round((g.j + 0.5) * HEAT_CELL_DEG * 1000) / 1000,
      count: g.count,
    })).sort((a, b) => b.count - a.count)
    res.json({ k: MIN_AGGREGATE_CELL, scope, truncated, cell_deg: HEAT_CELL_DEG, total: released.reduce((s, c) => s + c.count, 0), cells: released })
  }
}

export function areaBubbles(rows, k = MIN_AGGREGATE_CELL) {
  const groups = new Map()
  for (const r of rows) {
    if (!r.ll || r.region === 'unknown') continue
    const g = groups.get(labelKey(r.region)) || { region: r.region, count: 0, lat: 0, lon: 0, diseases: new Map() }
    g.count++; g.lat += r.ll.lat; g.lon += r.ll.lon
    g.diseases.set(r.disease, (g.diseases.get(r.disease) || 0) + 1)
    groups.set(labelKey(r.region), g)
  }
  return [...groups.values()].filter(g => g.count >= k).map(g => ({
    region: g.region, count: g.count,
    lat: Math.round(g.lat / g.count * 10) / 10, lon: Math.round(g.lon / g.count * 10) / 10,
    top_disease: [...g.diseases.entries()].filter(([, n]) => n >= k).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
  })).sort((a, b) => b.count - a.count)
}

export function getAreas({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const w = windowOf(req, res); if (!w) return
    const region = asked(req.query.region)
    const species = asked(req.query.species)
    const status = statusAsked(req)
    const rows = (await loadResolved(store, w)).filter(r => (!species || labelKey(r.species) === labelKey(species)) && (!status || r.status === status))
    const areas = areaBubbles(region ? rows.filter(r => labelKey(r.region) === labelKey(region)) : rows)
    res.json({ k: MIN_AGGREGATE_CELL, precision_km: 10, truncated: rows.truncated === true, total: areas.reduce((s, a) => s + a.count, 0), areas })
  }
}

export function getReportsCsv({ store, authed, csvCell }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const w = windowOf(req, res); if (!w) return
    const rep = await diseaseReportFor(store, w, { region: asked(req.query.region), grain: grainOf(req) })
    const columns = ['view', 'disease', 'region', 'district', 'period', 'status', 'conclusion', 'note', 'cases']
    const lines = [columns.map(c => (c === 'period' ? `period_${rep.grain}` : c)).join(',')]
    const cell = (v) => csvCell(printName(v ?? 'all'))
    const emit = (view, f) => lines.push(columns.map(col => (
      col === 'view' ? view : col === 'cases' ? csvCell(f.count ?? '') : col === 'note' ? csvCell(f.note ?? '') : cell(f[col])
    )).join(','))
    for (const c of diseaseRows(rep)) emit('disease', c)
    for (const c of rep.by_disease_region) emit('disease_by_region', c)
    for (const c of rep.by_disease_month) emit('disease_by_period', { ...c, period: c.month })
    for (const c of rep.cells) emit('disease_region_period', { ...c, period: c.month })
    if (rep.trend) for (const d of rep.trend.diseases) emit('trend', { disease: d.disease, period: rep.trend.period, count: d.count })
    for (const c of rep.by_status) emit('status', { status: c.status, count: c.count })
    if (rep.ruled_out) emit('status', { status: RULED_OUT, count: rep.ruled_out })
    for (const c of rep.by_district) emit('district', { district: c.district, count: c.count })
    for (const c of rep.by_conclusion) emit('conclusion', { conclusion: c.conclusion, count: c.count })
    for (const c of rep.by_disease_conclusion) emit('disease_conclusion', { disease: c.disease, conclusion: c.conclusion, count: c.count })
    const note = (text) => emit('note', { note: text })
    note(`Groups of fewer than ${MIN_AGGREGATE_CELL} cases are combined under "${printName(SPARSE_BUCKET_KEY)}". No case-level or personal data is included.`)
    if (rep.truncated) { note('There are more reports than this export can load, so the figures leave some out.'); res.setHeader('X-Report-Truncated', '1') }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="resolved-cases-by-disease.csv"')
    res.send('\uFEFF' + lines.join('\r\n'))
  }
}

const ROUTES = [
  ['get', '/api/reports/resolved-map', getResolvedMap],
  ['get', '/api/reports/diseases', getDiseases],
  ['get', '/api/reports/diseases/print', getDiseasesPrint],
  ['get', '/api/reports/heat', getHeat],
  ['get', '/api/reports/areas', getAreas],
  ['get', '/api/reports/export.csv', getReportsCsv],
]

export function registerReportsMap(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
