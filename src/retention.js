

import fs from 'node:fs'
import path from 'node:path'
import { tsMs, tagList } from './timestamp.js'
import { eraseCaseSessions, findCaseSessionDirs } from './store/agent-sessions.js'
import { caseyText } from './deployment-text.js';

export const RETENTION_ACTIONS = ['archive', 'erase']
export const DEFAULT_RETENTION_ACTION = 'archive'

export const RETENTION_PII_REPORT_FIELDS = [
  'owner_name', 'owner_contact', 'present_person', 'present_person_relation',
  'contact_fallback', 'reported_by', 'photos', 'audio',
]

export const KEEP_REASONS = {
  system: caseyText("src/retention.js#w0"),
  open: caseyText("src/retention.js#w1"),
  health_breach: caseyText("src/retention.js#w2"),
  needs_human: caseyText("src/retention.js#w3"),
  draft_pending: caseyText("src/retention.js#w4"),
  recent_event: caseyText("src/retention.js#w5"),
  no_readable_timestamp: caseyText("src/retention.js#w6"),
}

export function resolveRetentionPolicy(env = process.env, overrides = {}) {
  const rawDays = overrides.days != null ? overrides.days : env.CASEY_RETENTION_DAYS
  if (rawDays == null || String(rawDays).trim() === '' || rawDays === true) return null
  const days = Number(rawDays)
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`retention: CASEY_RETENTION_DAYS must be a positive number of days, got "${rawDays}"`)
  }
  const rawAction = overrides.action != null ? overrides.action : (env.CASEY_RETENTION_ACTION || DEFAULT_RETENTION_ACTION)
  const action = String(rawAction).trim()
  if (!RETENTION_ACTIONS.includes(action)) {
    throw new Error(`retention: CASEY_RETENTION_ACTION must be one of ${RETENTION_ACTIONS.join(', ')}, got "${rawAction}"`)
  }
  const archiveDir = overrides.archiveDir || env.CASEY_RETENTION_ARCHIVE_DIR || null
  return { days, ageMs: days * 24 * 3600e3, action, archiveDir }
}

export function newestActivityMs(caseRow, events = []) {
  let best = NaN
  const consider = (raw) => {
    const t = tsMs(raw)
    if (Number.isNaN(t)) return
    if (Number.isNaN(best) || t > best) best = t
  }
  for (const e of events) consider(e?.created_at)
  consider(caseRow?.last_event_at)
  consider(caseRow?.created_at)
  return best
}

export function classifyCaseForRetention(caseRow, events, now, policy, openStatuses = []) {
  const keep = (reason, detail) => ({ eligible: false, reason, detail: detail || KEEP_REASONS[reason], idleMs: null })
  if (!caseRow || !policy) return keep('no_readable_timestamp', caseyText("src/retention.js#w7"))

  if (caseRow.channel === 'system') return keep('system')

  const open = new Set(openStatuses)
  if (open.has(caseRow.status)) return keep('open', caseyText("src/retention.js#w8", [caseRow.status]))
  if (caseRow.status !== 'closed') return keep('open', caseyText("src/retention.js#w9", [caseRow.status]))

  const tags = tagList(caseRow)
  const healthTags = tags.filter(t => t.startsWith('health:'))
  if (healthTags.length) return keep('health_breach', `unresolved: ${healthTags.join(', ')}`)
  if (tags.includes('needs-human')) return keep('needs_human')
  if (tags.includes('draft-pending')) return keep('draft_pending')

  const newest = newestActivityMs(caseRow, events)
  if (!Number.isFinite(newest)) return keep('no_readable_timestamp')
  const idleMs = now - newest
  if (idleMs < policy.ageMs) {
    return { eligible: false, reason: 'recent_event', detail: caseyText("src/retention.js#w10", [Math.floor(idleMs / 86400e3), policy.days]), idleMs }
  }
  return { eligible: true, reason: 'expired', detail: caseyText("src/retention.js#w11", [Math.floor(idleMs / 86400e3), policy.days]), idleMs }
}

export async function planRetention(store, now, policy) {
  if (!policy) return { policy: null, now, eligible: [], kept: [], scanned: 0 }

  const cases = await store.listCases({}, { limit: 100000, includeSystem: true })
  const openStatuses = store.getOpenStatuses()
  const eligible = []
  const kept = []
  for (const c of cases) {
    let events = []
    try { events = await store.listEvents(c.id) } catch { events = [] }
    const verdict = classifyCaseForRetention(c, events, now, policy, openStatuses)
    const row = { id: c.id, ref: c.ref, status: c.status, channel: c.channel, created_at: c.created_at, ...verdict, eventCount: events.length }
    if (verdict.eligible) eligible.push(row)
    else kept.push(row)
  }
  return { policy, now, eligible, kept, scanned: cases.length }
}

function stampDir(archiveRoot, now) {
  const iso = new Date(now).toISOString().replace(/[:.]/g, '-')
  return path.join(archiveRoot, iso)
}

export function resolveArchiveRoot(store, policy) {
  return policy?.archiveDir
    ? path.resolve(policy.archiveDir)
    : path.resolve(store.dataDir, 'archive')
}

async function writeArchiveRecord(store, dir, caseRow, events, now, policy, sessionsRoot) {
  let contact = null
  try { contact = caseRow.contact_id ? await store.getContact(caseRow.contact_id) : null } catch { contact = null }
  const sessionDirs = findCaseSessionDirs([caseRow.id], ...(sessionsRoot ? [sessionsRoot] : []))
  const record = {
    archived_at: now,
    archived_by: caseyText("src/retention.js#w12"),
    policy: { days: policy.days, action: policy.action },

    case: caseRow,
    contact,
    events,

    session_dirs: sessionDirs,
  }
  const safeRef = String(caseRow.ref || caseRow.id).replace(/[^A-Za-z0-9._-]/g, '_')
  const file = path.join(dir, `${safeRef}.json`)
  fs.writeFileSync(file, JSON.stringify(record, null, 2))
  return { file, bytes: fs.statSync(file).size, sessionDirs }
}

export async function executeRetention(store, plan, { operator = 'cli-operator', sessionsRoot = null, log = null } = {}) {
  const { policy, now } = plan
  if (!policy) return { policy: null, archived: [], failed: [], archiveDir: null }
  const archiveRoot = resolveArchiveRoot(store, policy)
  const dir = stampDir(archiveRoot, now)
  fs.mkdirSync(dir, { recursive: true })

  const archived = []
  const failed = []
  let sessionsRemoved = 0
  const sessionsFailed = []

  for (const item of plan.eligible) {
    try {

      const fresh = await store.getCase(item.id)
      if (!fresh) { failed.push({ ...item, error: caseyText("src/retention.js#w13") }); continue }
      const events = await store.listEvents(item.id).catch(() => [])
      const recheck = classifyCaseForRetention(fresh, events, Date.now(), policy, store.getOpenStatuses())
      if (!recheck.eligible) {
        failed.push({ ...item, skipped: true, error: caseyText("src/retention.js#w14", [recheck.detail]) })
        continue
      }

      const written = await writeArchiveRecord(store, dir, fresh, events, now, policy, sessionsRoot)

      if (policy.action === 'erase') {

        await store.retentionEraseCase(fresh.id, { reason: caseyText("src/retention.js#w15", [policy.days]), operator })
        const s = eraseCaseSessions([fresh.id], { log: log || console, ...(sessionsRoot ? { root: sessionsRoot } : {}) })
        sessionsRemoved += s.removed.length
        for (const f of s.failed) sessionsFailed.push(f)
      }

      await store.t.delete('case', fresh.id)

      archived.push({ id: fresh.id, ref: fresh.ref, file: written.file, bytes: written.bytes, events: events.length, action: policy.action })
    } catch (e) {
      failed.push({ ...item, error: e?.message || String(e) })
    }
  }

  const manifest = {
    generated_at: now,
    policy: { days: policy.days, action: policy.action },
    archive_dir: dir,
    scanned: plan.scanned,
    archived: archived.length,
    kept: plan.kept.length,
    failed: failed.length,

    kept_detail: plan.kept.map(k => ({ ref: k.ref, reason: k.reason, detail: k.detail })),
    cases: archived,
    failures: failed,
    sessions_erased: sessionsRemoved,
    sessions_failed: sessionsFailed,

    note: caseyText("src/retention.js#w16"),
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { policy, archiveDir: dir, archived, failed, manifest, sessionsRemoved, sessionsFailed }
}
