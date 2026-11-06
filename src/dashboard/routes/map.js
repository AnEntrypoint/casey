import { assigneeNamer } from '../assignee-names.js'
import { createHash } from 'node:crypto'
import { classifyWorkerCheckins, WORKER_CHECKIN_WINDOW_MS } from '../../case-health.js'
import { rowInt } from '../../safe.js'
import { tsMs, parseReport } from '../../timestamp.js'
import { mergeTag } from '../../hooks/heuristics.js'
import { mountRoutes } from './register.js'
import { isFieldAccount, caseAccess } from '../roles.js'
import { canQueryCases, resolveTierValue } from '../../contact-tiers.js'
import { TIER_LABELS } from '../../store/report-shape.js'

const MAP_CASE_CAP = 2000

export function mapCaseProjection(c, report, clusterIndex, name = (v) => v) {
  return {
    id: c.id, ref: c.ref, status: c.status, case_type: c.case_type || 'unset',
    species: report.species || null, location: report.location || null,
    symptoms: report.symptoms || null,
    affected_count: report.affected_count ?? null, dead_count: report.dead_count ?? null,
    onset: report.onset || null,
    assignee: c.assignee ? name(c.assignee) : null, priority: c.priority,
    cluster: clusterIndex,
    last_event_at: c.last_event_at,
    created_at: c.created_at,
    location_source: c.location_source || 'unset',
    location_confidence: Number.isFinite(Number(c.location_confidence)) && c.location_confidence != null ? Number(c.location_confidence) : null,
  }
}

export function workerPinProjection(c, { now, staleMs, checkinWindowMs, overdue }) {
  const at = tsMs(c.last_location_at)
  const ageMs = Number.isFinite(at) ? now - at : null
  return {
    id: c.id, display_name: c.display_name || null,
    lat: Number(c.last_location_lat), lon: Number(c.last_location_lon),
    location_source: c.last_location_source || 'unset',
    last_location_at: c.last_location_at, age_ms: ageMs,
    stale: ageMs == null || ageMs > staleMs,
    overdue_checkin: overdue,
    checkin_window_ms: checkinWindowMs,
  }
}

export function getOperatorIdentities({ store, authed, parseJsonArraySafe, getRoster }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const rows = await store.listOperatorIdentities()
    const byId = new Map(rows.map(r => [r.operator_id, r]))
    const identities = (await getRoster()).map(o => {
      const r = byId.get(o.id)
      return {
        id: o.id, name: o.name,
        areas: r ? parseJsonArraySafe(r.areas) : [],
        last_seen_at: r?.last_seen_at || null,
        case_count: rowInt(r?.case_count),
      }
    })
    res.json({ identities })
  }
}

let mapCasesMemo = null

function mapPoolFingerprint(days, rows) {
  const h = createHash('sha1')
  h.update('days:' + days + ':n:' + rows.length + '\n')
  for (const r of rows) h.update(r.id + ' ' + r._version + ' ' + r.updated_at + '\n')
  return h.digest('hex')
}

export function getMapCases({ store, authed, isOpenCase, UNCLAIMED_ASSIGNEE }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 0, 0), 365)
    const where = {}
    if (days > 0) where.created_at = { $gte: Math.floor(Date.now() / 1000) - days * 86400 }
    let all = await store.listCases(where, { limit: MAP_CASE_CAP + 1, offset: 0 })
    const scoped = isFieldAccount(req.caseyAccount)
    if (scoped) all = all.filter(c => caseAccess(c, req.caseyAccount, { unclaimedKey: UNCLAIMED_ASSIGNEE }) !== 'none')
    const fingerprint = mapPoolFingerprint(days, all)
    if (!scoped && mapCasesMemo && mapCasesMemo.fingerprint === fingerprint) return res.json(mapCasesMemo.payload)
    const truncated = all.length > MAP_CASE_CAP
    const pool = truncated ? all.slice(0, MAP_CASE_CAP) : all
    const { buildClusters } = await import('../../clusters.js')
    const clusters = buildClusters(pool.filter(isOpenCase))
    const clusterByRef = new Map()
    clusters.forEach((cl, i) => { for (const m of cl.members) clusterByRef.set(m.ref, i) })

    const named = await assigneeNamer(store, pool)
    const pins = [], unresolved = []
    for (const c of pool) {
      let report = parseReport(c)
      const lat = c.lat != null && c.lat !== '' ? Number(c.lat) : null
      const lon = c.lon != null && c.lon !== '' ? Number(c.lon) : null
      const row = mapCaseProjection(c, report, clusterByRef.has(c.ref) ? clusterByRef.get(c.ref) : null, named)
      if (lat != null && Number.isFinite(lat) && lon != null && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        pins.push({ ...row, lat, lon })
      } else {
        unresolved.push(row)
      }
    }
    const payload = {
      pins, unresolved, unresolved_count: unresolved.length,
      clusters: clusters.map((cl, i) => ({
        index: i, count: cl.count, location: cl.location,
        species: cl.species, symptoms: cl.symptoms, reported_disease_names: cl.reported_disease_names,
      })),
      truncated, cap: MAP_CASE_CAP, total_considered: all.length,
    }
    if (!scoped) mapCasesMemo = { fingerprint, payload }
    res.json(payload)
  }
}

export function getMapWorkers({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const th = (store.resolveThresholds ? await store.resolveThresholds() : null) || {}
    const staleMs = Number.isFinite(th.workerLocationStaleMs) ? th.workerLocationStaleMs : 3 * 3600e3
    const checkinWindowMs = Number.isFinite(th.workerCheckinWindowMs) ? th.workerCheckinWindowMs : WORKER_CHECKIN_WINDOW_MS
    const now = Date.now()
    const contacts = await store.listContacts({ limit: 1000 })
    const overdueById = new Set(classifyWorkerCheckins(contacts, now, checkinWindowMs).map(w => w.contact_id))
    const workers = contacts
      .filter(c => canQueryCases(c.tier) && c.last_location_lat != null && c.last_location_lon != null && c.last_location_at)
      .map(c => workerPinProjection(c, { now, staleMs, checkinWindowMs, overdue: overdueById.has(c.id) }))
      .filter(w => Number.isFinite(w.lat) && Number.isFinite(w.lon) && Math.abs(w.lat) <= 90 && Math.abs(w.lon) <= 180)
    res.json({ workers, stale_ms: staleMs, checkin_window_ms: checkinWindowMs })
  }
}

export function getMapLastReports({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const contacts = await store.listContacts({ limit: 2000 })
    const reports = []
    for (const c of contacts) {
      if (c.last_report_lat == null || c.last_report_lon == null) continue
      const lat = Number(c.last_report_lat), lon = Number(c.last_report_lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue
      reports.push({
        contact_id: c.id,
        display_name: c.display_name || null,
        lat, lon,
        last_report_at: c.last_report_at || null,
        case_id: c.last_report_case_id || null,
      })
    }
    res.json({ reports })
  }
}

export function postCaseDispatch({ store, authed, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const workerId = String(req.body?.worker_id || '').trim()
    if (!workerId) return res.status(400).json({ error: 'worker_id is required' })
    const worker = store.getContact ? await store.getContact(workerId).catch(() => null) : null
    if (!worker) return res.status(404).json({ error: 'worker not found' })
    if (!canQueryCases(worker.tier)) return res.status(400).json({ error: `selected contact is a ${TIER_LABELS[resolveTierValue(worker.tier)]} and cannot be dispatched to` })
    const op = actingOperator(req)
    const note = String(req.body?.note || '').trim().slice(0, 500)
    const label = worker.display_name || 'a field worker'
    await store.updateCase(c.id, { tags: mergeTag(c.tags, 'dispatch-suggested') }, op)
    await store.appendEvent(c.id, {
      kind: 'action', actor: 'operator',
      text: `Dispatch suggested: ${label}${note ? ` -- ${note}` : ''}`,
      data: { dispatch_worker_id: worker.id, by: op.id, note: note || null },
    })
    res.json({ ok: true })
  }
}

const ROUTES = [
  ['get', '/api/operators/identities', getOperatorIdentities],
  ['get', '/api/map/cases', getMapCases],
  ['get', '/api/map/workers', getMapWorkers],
  ['get', '/api/map/last-reports', getMapLastReports],
  ['post', '/api/cases/:id/dispatch', postCaseDispatch],
]

export function registerMap(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
