import { parseReport } from '../../timestamp.js'
import { statedArea } from '../../areas.js'
import { isDone } from '../../signoff-desk.js'
import { SIGNOFF_DIAGNOSIS_FIELDS } from '../../store/report-shape.js'
import { MIN_AGGREGATE_CELL, SPARSE_BUCKET_KEY, UNSUPPRESSED_BUCKET_KEYS } from '../../privacy.js'
import { mountRoutes } from './register.js'

const POOL_CAP = 10000
const DISEASE_KEY = SIGNOFF_DIAGNOSIS_FIELDS[0] || 'identified_disease'
const RESOLUTION_KEY = SIGNOFF_DIAGNOSIS_FIELDS[1] || 'recommended_resolution'
export const NO_CONCLUSION = 'Not stated'
const RESOLUTION_KINDS = [
  ['Vaccination', /vaccin|inent|entstof|immuni[sz]/i],
  ['Quarantine or movement control', /quarantin|isolat|separat|movement|restrict|kwarantyn|isoleer/i],
  ['Culling or disposal', /\bcull|slaughter|destroy|dispos|bury|burn|doodmaak|slag/i],
  ['Treatment', /treat|medic|antibiotic|drug|dose|inject|\bdip(?:ping)?\b|dren[ck]|behandel/i],
  ['Referred to a vet or lab', /vet(?:erinar)?|refer|laborator|\blab\b|sample|state vet|verwys|monster/i],
  ['Monitoring', /monitor|watch|follow.?up|observ|review|revisit|volg|dophou/i],
]
export const OTHER_CONCLUSION = 'Other advice'

export function conclusionKinds(text) {
  const t = String(text == null ? '' : text)
  if (!t.trim()) return [NO_CONCLUSION]
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

const labelKey = (label) => label.toLowerCase()

export function parseBound(v, endOfDay = false) {
  if (v == null || v === '') return null
  const s = String(v).trim()
  if (/^\d{9,11}$/.test(s)) return Number(s)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = Date.parse(s + 'T00:00:00Z')
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

export function resolvedRow(c, report, resolvedSec) {
  const disease = cleanLabel(report[DISEASE_KEY])
  if (!disease) return null
  const species = cleanLabel(report.species, 40) || 'Not stated'
  const area = cleanLabel(statedArea(report), 60)
  const p = coords(c)
  return {
    disease, species, region: area || 'unknown', sec: resolvedSec,
    conclusions: conclusionKinds(report[RESOLUTION_KEY]),
    ll: p ? { lat: round2(p.lat), lon: round2(p.lon) } : null,
  }
}

export const RARE_LABEL = 'Other (rare)'

export async function loadResolved(store, { from = null, to = null } = {}) {
  const all = await store.listCases({}, { limit: POOL_CAP, offset: 0 })
  const done = all.filter(c => isDone(c) && c.channel !== 'system')
  const withDx = done.filter(c => cleanLabel(parseReport(c)[DISEASE_KEY]))
  const at = await resolvedSeconds(store, withDx)
  const raw = withDx.map(c => resolvedRow(c, parseReport(c), at.get(c.id))).filter(Boolean)
  for (const field of ['disease', 'species', 'region']) {
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
  const rows = []
  for (const r of raw) {
    if (from != null && r.sec < from) continue
    if (to != null && r.sec > to) continue
    if ((held.get(labelKey(r.disease)) || 0) < MIN_AGGREGATE_CELL) r.disease = RARE_LABEL
    if ((kinds.get(labelKey(r.species)) || 0) < MIN_AGGREGATE_CELL) r.species = RARE_LABEL
    rows.push(r)
  }
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
    const exempt = dims.length === 1 && UNSUPPRESSED_BUCKET_KEYS.has(g.vals[0])
    if (g.count >= k || exempt) out.push(g); else sparse += g.count
  }
  if (sparse >= k) out.push({ vals: dims.map(() => SPARSE_BUCKET_KEY), count: sparse })
  return out.sort((a, b) => b.count - a.count || String(a.vals).localeCompare(String(b.vals)))
}

const named = (dimNames) => (g) => Object.fromEntries([...dimNames.map((n, i) => [n, g.vals[i]]), ['count', g.count]])

export function buildDiseaseReport(rows, { region = null, grain = 'month' } = {}) {
  const inRegion = region ? rows.filter(r => labelKey(r.region) === labelKey(region)) : rows
  const dis = (r) => r.disease, reg = (r) => r.region, mon = (r) => periodOf(r.sec, grain)
  const cells = rollup(inRegion, [dis, reg, mon])
  const total = cells.reduce((s, g) => s + g.count, 0)
  return {
    k: MIN_AGGREGATE_CELL, grain,
    total,
    by_disease: rollup(inRegion, [dis]).map(named(['disease'])),
    by_region: rollup(rows, [reg]).map(named(['region'])),
    by_month: rollup(inRegion, [mon]).map(named(['month'])),
    by_disease_month: rollup(inRegion, [dis, mon]).map(named(['disease', 'month'])),
    by_disease_region: rollup(rows, [dis, reg]).map(named(['disease', 'region'])),
    by_species: rollup(inRegion, [(r) => r.species]).map(named(['species'])),
    by_conclusion: rollup(inRegion.flatMap(r => r.conclusions.map(k => ({ k }))), [(r) => r.k]).map(named(['conclusion'])),
    by_disease_conclusion: rollup(inRegion.flatMap(r => r.conclusions.map(k => ({ d: r.disease, k }))), [(r) => r.d, (r) => r.k]).map(named(['disease', 'conclusion'])),
    with_conclusion: inRegion.filter(r => r.conclusions[0] !== NO_CONCLUSION).length,
    cells: cells.map(named(['disease', 'region', 'month'])),
  }
}

function windowOf(req, res) {
  const from = parseBound(req.query.from), to = parseBound(req.query.to, true)
  if (Number.isNaN(from) || Number.isNaN(to)) { res.status(400).json({ error: 'from and to must be a date like 2026-03-31 or unix seconds' }); return null }
  return { from, to }
}
const grainOf = (req) => (['month', 'quarter', 'year'].includes(req.query.grain) ? req.query.grain : 'month')
const asked = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null)

export function getResolvedMap({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const w = windowOf(req, res); if (!w) return
    const region = asked(req.query.region)
    let rows = await loadResolved(store, w)
    if (region) rows = rows.filter(r => labelKey(r.region) === labelKey(region))
    const points = rows.filter(r => r.ll).map(r => ({
      lat: r.ll.lat, lon: r.ll.lon, disease: r.disease, species: r.species, advice: r.conclusions, resolved_at: weekStartOf(r.sec),
    })).sort((a, b) => a.resolved_at < b.resolved_at ? -1 : a.resolved_at > b.resolved_at ? 1 : 0)
    res.json({ count: points.length, without_location: rows.length - points.length, precision_km: 1, points })
  }
}

export function getDiseases({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const w = windowOf(req, res); if (!w) return
    const rows = await loadResolved(store, w)
    res.json(buildDiseaseReport(rows, { region: asked(req.query.region), grain: grainOf(req) }))
  }
}

export function getHeat({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const w = windowOf(req, res); if (!w) return
    const scope = req.query.scope === 'all' ? 'all' : 'resolved'
    const disease = asked(req.query.disease) ? cleanLabel(req.query.disease) : null
    const advice = asked(req.query.advice)
    const pts = []
    if (scope === 'resolved') {
      for (const r of await loadResolved(store, w)) {
        if (r.ll && (!disease || labelKey(r.disease) === labelKey(disease)) && (!advice || r.conclusions.some(k => labelKey(k) === labelKey(advice)))) pts.push(r.ll)
      }
    } else {
      const all = await store.listCases({}, { limit: POOL_CAP, offset: 0 })
      for (const c of all) {
        if (c.channel === 'system') continue
        const t = Number(c.created_at)
        if (w.from != null && t < w.from) continue
        if (w.to != null && t > w.to) continue
        const p = coords(c)
        if (p) pts.push(p)
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
    res.json({ k: MIN_AGGREGATE_CELL, scope, cell_deg: HEAT_CELL_DEG, total: released.reduce((s, c) => s + c.count, 0), cells: released })
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
    const areas = areaBubbles(await loadResolved(store, w))
    res.json({ k: MIN_AGGREGATE_CELL, precision_km: 10, total: areas.reduce((s, a) => s + a.count, 0), areas })
  }
}

export function getReportsCsv({ store, authed, csvCell }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const w = windowOf(req, res); if (!w) return
    const rep = buildDiseaseReport(await loadResolved(store, w), { region: asked(req.query.region), grain: grainOf(req) })
    const lines = [['view', 'disease', 'region', 'period', 'cases'].join(',')]
    const add = (view, list, cols) => { for (const c of list) lines.push([view, ...cols.map(k => csvCell(c[k] ?? 'all')), csvCell(c.count)].join(',')) }
    add('disease', rep.by_disease, ['disease', 'region', 'month'])
    add('disease_by_region', rep.by_disease_region, ['disease', 'region', 'month'])
    add('disease_by_period', rep.by_disease_month, ['disease', 'region', 'month'])
    add('disease_region_period', rep.cells, ['disease', 'region', 'month'])
    lines.push(...rep.by_conclusion.map(c => ['conclusion', 'all', 'all', csvCell(c.conclusion), csvCell(c.count)].join(',')))
    lines.push(...rep.by_disease_conclusion.map(c => ['disease_conclusion', csvCell(c.disease), 'all', csvCell(c.conclusion), csvCell(c.count)].join(',')))
    lines.push(`# Groups of fewer than ${MIN_AGGREGATE_CELL} cases are combined under ${SPARSE_BUCKET_KEY}. No case-level or personal data is included.`)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="resolved-cases-by-disease.csv"')
    res.send(lines.join('\n'))
  }
}

const ROUTES = [
  ['get', '/api/reports/resolved-map', getResolvedMap],
  ['get', '/api/reports/diseases', getDiseases],
  ['get', '/api/reports/heat', getHeat],
  ['get', '/api/reports/areas', getAreas],
  ['get', '/api/reports/export.csv', getReportsCsv],
]

export function registerReportsMap(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
