// retention.js  --  age-based data retention for the case store.
//
// WHAT THIS IS FOR. This deployment holds identifiable animal-health reports
// about real people's livelihoods, and its output dispatches vehicles. So the
// asymmetry that decides every line below is: keeping a case too long costs
// disk, while removing one an operator still needs costs a field visit that
// never happens. Four consequences, all structural rather than conventional:
//
//   1. RETENTION IS OFF UNLESS A POLICY IS CONFIGURED. resolveRetentionPolicy
//      returns null when CASEY_RETENTION_DAYS is unset, and every entry point
//      here returns an empty plan on a null policy. Nothing in this module is
//      wired into a timer, the sweep, the supervisor or `casey up` -- it runs
//      only when an operator types `casey retention`. "Default off" therefore
//      is not a flag that could be flipped by accident: with no policy there is
//      no scheduled caller to flip.
//   2. THE DEFAULT ACTION IS ARCHIVE, NEVER DELETE. src/core/raw-log.js already
//      took this decision for the provenance tier -- it rotates by rename and
//      has no delete in its surface at all -- and this follows it. `archive`
//      writes the whole case (row, contact, every event) to a JSON file and
//      then takes the case out of the live read paths; nothing about the
//      person's data is destroyed. `erase` is a separate action an operator
//      must name explicitly.
//   3. STILL-NEEDED CASES ARE EXCLUDED REGARDLESS OF AGE, and each exclusion
//      names its own reason so a dry-run explains itself. See KEEP_REASONS.
//   4. EVERY CHECK FAILS CLOSED. A case whose timestamps cannot be read is
//      kept, not expired: age is the whole basis for the decision, so an
//      unreadable age is not a decision this module is entitled to make.
//
// WHAT THIS DOES NOT DO, stated because a retention feature that overclaims is
// worse than none. busybase soft-deletes any entity carrying a `status` field
// (thatcher's remove() -> UPDATE status='deleted'), and `case`, `event` and
// `contact` all carry one. So NOTHING here frees bytes in data/db.sqlite: an
// archived case leaves every read path (thatcher's list() filters deleted rows
// out) while its bytes stay on disk until someone vacuums. And both actions
// leave a full copy in the archive directory by design. A deployment that must
// truly destroy data removes the archive directory and vacuums the database,
// and that is deliberately manual -- an automated irreversible destroy is the
// exact thing this module refuses to be.
//
// Erasure (src/case-store.js's eraseContact) stays a separate path and is not
// replaced here: retention is about AGE, erasure is about a PERSON ASKING. The
// `erase` action below reuses erasure's own field set and its session-transcript
// removal so the two agree on what "identifying" means, but the trigger, the
// scope and the audit trail stay distinct.

import fs from 'node:fs'
import path from 'node:path'
import { tsMs, tagList } from './timestamp.js'
import { eraseCaseSessions, findCaseSessionDirs } from './store/agent-sessions.js'

// The two actions, and the whole difference between them.
//  archive: export the case to a file, then take it out of the live read paths.
//           Reversible by hand from the exported JSON. Destroys nothing.
//  erase:   everything archive does, and then scrubs the identifying fields off
//           the live row and removes the stored conversation transcripts. The
//           export is written FIRST, so there is always a copy on disk before
//           anything irreversible runs.
export const RETENTION_ACTIONS = ['archive', 'erase']
export const DEFAULT_RETENTION_ACTION = 'archive'

// The identifying report fields, the same list eraseContact scrubs. Kept as its
// own exported constant rather than imported from case-store.js so this module
// stays free of the store's import graph (it is loaded by the CLI before a store
// exists, to answer "is a policy even configured").
export const RETENTION_PII_REPORT_FIELDS = [
  'owner_name', 'owner_contact', 'present_person', 'present_person_relation',
  'contact_fallback', 'photos', 'audio',
]

// Why a case was kept. The dry-run prints these verbatim, so an operator reading
// the report never has to guess which rule spared a case.
export const KEEP_REASONS = {
  system: 'a system settings/runtime row, not a person report -- never eligible',
  open: 'still open in the workflow',
  health_breach: 'carries an unresolved health guardrail breach',
  needs_human: 'someone asked for a person and the case still carries the tag',
  draft_pending: 'a drafted reply is still waiting to be released',
  recent_event: 'something happened on it inside the retention window',
  no_readable_timestamp: 'its timestamps cannot be read, so its age is unknown',
}

// A policy, or null for OFF. Null is the default and the only thing an unset
// environment can produce -- there is no implicit number anywhere in this file.
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

// The newest moment anything is known to have happened on this case: the real
// event rows first (the authority), then the case's own columns. Returns NaN
// when nothing on the case carries a readable timestamp, which is a KEEP.
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

// Pure: no clock, no I/O, no store. Returns { eligible, reason, detail, idleMs }.
// `reason` is a KEEP_REASONS key when eligible is false, and 'expired' when true.
//
// The order is fail-closed: every keep rule runs before the age comparison, so a
// case can never be expired by an age check that a still-needed rule would have
// vetoed anyway.
export function classifyCaseForRetention(caseRow, events, now, policy, openStatuses = []) {
  const keep = (reason, detail) => ({ eligible: false, reason, detail: detail || KEEP_REASONS[reason], idleMs: null })
  if (!caseRow || !policy) return keep('no_readable_timestamp', 'no case row or no policy')

  // Settings singletons (settings:thresholds / fleet-health / shift), the
  // runtime lifecycle case and the dropped-intake audit case all live on
  // channel 'system'. They are audit-log carriers with no person behind them,
  // and expiring one silently discards operator threshold history or the
  // record of a crash loop. Never eligible, at any age.
  if (caseRow.channel === 'system') return keep('system')

  // Open means open in the WORKFLOW, read from the live store rather than a
  // literal list here, so a config that renames or adds a stage is honoured
  // with no code change. A case in a busybase record status ('deleted',
  // 'archived') is already out of every read path and is not re-processed.
  const open = new Set(openStatuses)
  if (open.has(caseRow.status)) return keep('open', `still in stage '${caseRow.status}'`)
  if (caseRow.status !== 'closed') return keep('open', `in stage '${caseRow.status}', which this workflow does not call closed`)

  const tags = tagList(caseRow)
  const healthTags = tags.filter(t => t.startsWith('health:'))
  if (healthTags.length) return keep('health_breach', `unresolved: ${healthTags.join(', ')}`)
  if (tags.includes('needs-human')) return keep('needs_human')
  if (tags.includes('draft-pending')) return keep('draft_pending')

  const newest = newestActivityMs(caseRow, events)
  if (!Number.isFinite(newest)) return keep('no_readable_timestamp')
  const idleMs = now - newest
  if (idleMs < policy.ageMs) {
    return { eligible: false, reason: 'recent_event', detail: `last activity ${Math.floor(idleMs / 86400e3)}d ago, inside the ${policy.days}d window`, idleMs }
  }
  return { eligible: true, reason: 'expired', detail: `no activity for ${Math.floor(idleMs / 86400e3)}d, past the ${policy.days}d window`, idleMs }
}

// Build the whole plan without touching anything. This is what `casey retention`
// prints with no flags, and it is the same function the executing path calls --
// there is no second, differently-derived list that execution could disagree with.
export async function planRetention(store, now, policy) {
  if (!policy) return { policy: null, now, eligible: [], kept: [], scanned: 0 }
  // includeSystem so the system rows are SEEN and reported as excluded rather
  // than invisibly filtered: a dry-run that silently omits a row cannot be read
  // as a complete account of what the policy would do.
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

// Write one case's complete content to the archive as a single JSON file. This
// is the ONLY thing that runs before any mutation, for both actions: a copy on
// disk precedes anything that changes the live store, always.
async function writeArchiveRecord(store, dir, caseRow, events, now, policy, sessionsRoot) {
  let contact = null
  try { contact = caseRow.contact_id ? await store.getContact(caseRow.contact_id) : null } catch { contact = null }
  const sessionDirs = findCaseSessionDirs([caseRow.id], ...(sessionsRoot ? [sessionsRoot] : []))
  const record = {
    archived_at: now,
    archived_by: 'casey retention',
    policy: { days: policy.days, action: policy.action },
    // Verbatim rows, no projection: an archive that dropped a column would be a
    // silently lossy export, and this file is the only remaining copy of the
    // case once the live row leaves the read paths.
    case: caseRow,
    contact,
    events,
    // Named, never copied: the transcripts are large and live outside data/, so
    // the archive records WHERE they are rather than duplicating them. `casey
    // backup` is what copies them.
    session_dirs: sessionDirs,
  }
  const safeRef = String(caseRow.ref || caseRow.id).replace(/[^A-Za-z0-9._-]/g, '_')
  const file = path.join(dir, `${safeRef}.json`)
  fs.writeFileSync(file, JSON.stringify(record, null, 2))
  return { file, bytes: fs.statSync(file).size, sessionDirs }
}

// Execute the plan. Callers must have obtained an explicit operator confirmation
// first -- this function does not prompt and does not check a flag, because the
// CLI is not the only possible caller and a confirmation belongs at the surface
// the human is actually looking at.
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
      // Re-read INSIDE the loop. The plan was built from a snapshot; a case that
      // has received an inbound since then is no longer expired, and archiving
      // it would be exactly the "removed a case someone still needed" failure
      // this module exists to prevent. Re-classifying is cheap and it is the
      // only thing standing between a stale plan and a live case.
      const fresh = await store.getCase(item.id)
      if (!fresh) { failed.push({ ...item, error: 'case vanished between plan and execution' }); continue }
      const events = await store.listEvents(item.id).catch(() => [])
      const recheck = classifyCaseForRetention(fresh, events, Date.now(), policy, store.getOpenStatuses())
      if (!recheck.eligible) {
        failed.push({ ...item, skipped: true, error: `no longer eligible at execution time: ${recheck.detail}` })
        continue
      }

      const written = await writeArchiveRecord(store, dir, fresh, events, now, policy, sessionsRoot)

      if (policy.action === 'erase') {
        // Route through the store's own erasure primitive so retention and a
        // right-to-erasure request cannot disagree about what "identifying"
        // means. It scrubs the report fields, the routing key and the delivered-
        // reply destinations, and appends its own audited tombstone.
        await store.retentionEraseCase(fresh.id, { reason: `retention: no activity for ${policy.days}d`, operator })
        const s = eraseCaseSessions([fresh.id], { log: log || console, ...(sessionsRoot ? { root: sessionsRoot } : {}) })
        sessionsRemoved += s.removed.length
        for (const f of s.failed) sessionsFailed.push(f)
      }

      // Out of the live read paths. thatcher soft-deletes a row carrying a
      // status column, so this is a hide, not a destroy -- see this file's
      // header. The event rows stay attached to the hidden case and become
      // unreachable with it; they are not separately deleted, which keeps the
      // number of writes (and therefore the crash window) as small as the job
      // allows.
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
    // The full keep list, with reasons, lands in the manifest as well as on
    // screen: what a retention run did NOT touch is as much a part of the audit
    // record as what it did.
    kept_detail: plan.kept.map(k => ({ ref: k.ref, reason: k.reason, detail: k.detail })),
    cases: archived,
    failures: failed,
    sessions_erased: sessionsRemoved,
    sessions_failed: sessionsFailed,
    // Said in the artifact, not only in the terminal, because an operator
    // reading this directory a year later needs it as much as the one who ran it.
    note: 'busybase soft-deletes rows carrying a status column, so the archived cases are hidden from every read path but their bytes remain in data/db.sqlite until it is vacuumed. This directory holds the only complete copy of each archived case.',
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { policy, archiveDir: dir, archived, failed, manifest, sessionsRemoved, sessionsFailed }
}
