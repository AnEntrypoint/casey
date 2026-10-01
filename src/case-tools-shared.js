

import { readThatcherFieldEnum } from './config-loader.js'
import { ENQUIRY_HEADLINE_FIELDS } from './store/report-shape.js'
import { parseReport } from './timestamp.js'
import { publicAssignee } from './case-assignment.js'

export const str = (description, extra = {}) => ({ type: 'string', description, ...extra })

export function defTool(name, toolset, description, parameters, handler) {
  return { name, toolset, schema: { name, description, parameters }, handler }
}

export const FALLBACK_CASE_TYPE_VALUES = ['unset']
export const FALLBACK_PRIORITY_VALUES = ['low', 'normal', 'high', 'urgent']
export const FALLBACK_STAGE_VALUES = ['new', 'triaging', 'in_progress', 'waiting', 'resolved', 'closed']

export function fieldEnumHint(store, entityDotField, fallback) {
  try {
    const s = store()
    if (s && typeof s.getFieldEnum === 'function') {
      const live = s.getFieldEnum(entityDotField, null)
      if (Array.isArray(live) && live.length) return live
    }
  } catch {  }
  const [entity, field] = entityDotField.split('.')
  return readThatcherFieldEnum(entity, field) || fallback
}

export function stageHint(store) {
  try {
    const s = store()
    if (s && typeof s.getValidStatuses === 'function') {
      const live = s.getValidStatuses()
      if (Array.isArray(live) && live.length) return live
    }
  } catch {  }
  return FALLBACK_STAGE_VALUES
}

export const OBSERVE_TEXT_MAX_LEN = 20000

export function ownsCase(externalId, author) {
  if (!author) return false
  const ext = String(externalId || '')
  const a = String(author)
  return ext === a || ext.split(':').includes(a) || ext.endsWith(':' + a)
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function slimCase(c) {
  if (!c) return null
  const { id, ref, channel, status, priority, subject, summary, report, tags, assignee, autonomy, last_event_at } = c

  let reportObj = null
  try { reportObj = report ? JSON.parse(report) : null } catch { reportObj = null }
  return { id, ref, channel, status, priority, subject, summary, report: reportObj, tags, assignee: publicAssignee(assignee), autonomy, last_event_at }
}

export function enquiryRow(c, distanceKm) {
  if (!c) return null
  let report = parseReport(c)
  const headline = Object.fromEntries(ENQUIRY_HEADLINE_FIELDS.map(k => [k, report[k] || null]))
  return {
    id: c.id, ref: c.ref, status: c.status, priority: c.priority,
    ...headline,
    assignee: publicAssignee(c.assignee) || null, last_event_at: c.last_event_at,
    ...(typeof distanceKm === 'number' ? { distance_km: distanceKm } : {}),
  }
}

export function boundCase(ctx) {
  return {
    id: ctx?.activeCaseBinding?.id || ctx?.activeCaseId || null,
    ref: ctx?.activeCaseBinding?.ref || ctx?.activeCaseRef || null,
  }
}

export function rebindActiveCase(ctx, c) {
  if (!ctx || !c) return
  if (ctx.activeCaseBinding) {

    const b = ctx.activeCaseBinding
    if (b.id && b.id !== c.id) (b.left ||= new Set()).add(b.id).add(b.ref)
    b.id = c.id; b.ref = c.ref
  }
  ctx.activeCaseId = c.id
  ctx.activeCaseRef = c.ref
}
export function slimEvent(e) {
  return { kind: e.kind, actor: e.actor, text: e.text, at: e.created_at }
}

export async function mineRows(store, ctx, limit) {
  const author = ctx?.author || ctx?.principal?.id

  if (!author) return { error: 'no author on this turn -- cannot resolve "my cases"' }

  const openStatuses = typeof store.getOpenStatuses === 'function'
    ? store.getOpenStatuses()
    : ['new', 'triaging', 'in_progress', 'waiting']

  const scoped = await store.listCases({ status: { $in: openStatuses }, author_key: author }, { limit: Math.max(limit * 4, 100) })

  if (scoped.length >= limit) return scoped.slice(0, limit)
  const mineScanLimit = Number(process.env.CASEY_MINE_SCAN_LIMIT) || 1000
  const legacyPool = await store.listCases({ status: { $in: openStatuses }, author_key: '' }, { limit: Math.max(limit * 10, mineScanLimit) })
  const legacyMine = legacyPool.filter(c => ownsCase(c.external_id, author))
  const seen = new Set(scoped.map(c => c.id))
  const merged = [...scoped, ...legacyMine.filter(c => !seen.has(c.id))]
  return merged.slice(0, limit)
}
export function pick(obj, keys) {
  const out = {}
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== '' && String(obj[k]).trim() !== '') out[k] = obj[k]
  return out
}
export function isValidLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
}
