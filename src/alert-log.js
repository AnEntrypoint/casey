// alert-log.js -- the alert delivery path that needs no URL.
//
// casey's only way to tell a human something has gone wrong is a webhook
// (CASEY_ALERT_WEBHOOK, falling back to CASEY_HANDOFF_WEBHOOK -- see
// hooks/notifiers.js's breachNotifier). With neither set, breachNotifier
// returns null and NOTHING pages anyone: `casey doctor` says so out loud, and
// that is where it used to end. This is what runs instead, and only instead --
// casey.js builds it exactly when breachNotifier() returned null, so a
// configured webhook is never replaced or duplicated by it.
//
// WHY A FILE. A webhook is one delivery channel, not the only one a human
// reads. On a headless box with no outbound network and no third-party
// service, what standard operations tooling can actually watch is a file, a
// stream and an exit code, so this delivers on all three:
//   - <dataDir>/alerts/alerts.jsonl -- one JSON object per line, `tail -f`
//     able, and greppable on the literal token CASEY-ALERT that every line
//     carries in its own `tag` field (a cron line can be
//     `grep -q CASEY-ALERT data/alerts/alerts.jsonl && ...` with no parser);
//   - stderr -- the same one-line summary, so journald, a docker log driver or
//     a cron wrapper's mail sees it without knowing this file exists;
//   - `casey alerts` (bin/casey-alerts-command.js) exits 1 while any condition
//     is standing and 0 when clear, so a monitor is `casey alerts --quiet ||
//     page-somehow` with no JSON parsing at all.
//
// BOUNDED, AND BOUNDED TWICE. This repo has just finished fixing three
// unbounded append-only files, so this one is bounded by construction:
//   (1) rotation is by RENAME, never truncation -- the shape core/raw-log.js
//       already chose here, for the same reason (a rename is atomic within the
//       directory, moves the bytes rather than dropping them, and a reader
//       listing the directory between the rename and the next append sees
//       every record exactly once);
//   (2) unlike raw-log.js, the OLDEST archive past `maxArchives` is unlinked.
//       That difference is deliberate and not a weakening: raw-log is the
//       system of record for provenance, so dropping a record there would
//       break the property the whole tier exists for. This log is a
//       NOTIFICATION channel -- every breach it reports is already recorded
//       durably on the case (an observation event plus a health:* tag, see
//       case-sweep.js) and every system condition is already readable live on
//       /api/ready. Nothing here is the only copy of anything, so a hard
//       ceiling on disk is worth more than an unbounded history.
//   The two together give a stated ceiling: DEFAULT_MAX_SEGMENT_BYTES *
//   (DEFAULT_MAX_ARCHIVES + 1), 5 MB, plus a fixed-size state.json.
//
// RISING EDGE, because a deaf channel that stays deaf for a day must not write
// 5,760 identical lines. The discipline is the one already in this repo:
// case-sweep.js appends exactly one observation when a breach is NEWLY entered
// and never re-spams it while it persists, and casey.js's _coverageGapActive
// pages once per rising edge and re-arms on the falling edge. AlertGate below
// is that same rule, made durable (the state survives a restart, so a
// crash-looping worker cannot re-raise a standing condition on every boot) and
// given a hold-down on the falling edge, so a condition that flaps cannot buy
// two lines per evaluation tick.
//
// NO CONTACT IDENTIFIER, EVER. AGENTS.md's aggregate rule and
// hooks/notifiers.js's own Discord notifier both state the reason: a case ref
// is enough for an operator to open the case, and this file is written to disk
// on a box and read by whatever tooling an operator points at it. An entry
// carries a ref, a condition token and a sentence -- never an external_id, a
// contact_id, a subject or any other contact-authored text.
import fs from 'node:fs'
import path from 'node:path'

// Every line carries this literal so a human or a monitor can grep for it
// without a JSON parser and without knowing casey's schema.
export const ALERT_TAG = 'CASEY-ALERT'

// 1 MB per segment: an alert entry serializes to roughly 300 bytes, so a
// segment holds ~3,500 of them, and the whole retained window ~17,500. At the
// rising-edge write rate below (at worst two lines per condition per hold-down
// window) that is years of history for the three standing conditions, while
// any ONE file stays small enough to read, copy and hand over whole -- the
// same binding constraint raw-log.js documents, since read() below replays a
// segment into memory with readFileSync.
export const DEFAULT_MAX_SEGMENT_BYTES = 1024 * 1024
export const DEFAULT_MAX_ARCHIVES = 4
// How long a condition must be continuously false before its alert clears.
// Hysteresis, not politeness: without it a condition oscillating around its
// own threshold writes a raised/cleared pair on every evaluation tick.
export const DEFAULT_CLEAR_HOLD_MS = 15 * 60 * 1000

// The closed set of SYSTEM-level conditions the watch in casey.js evaluates.
// Per-case guardrail breaches and the team coverage gap arrive through the
// same notifier seam with their own breach names (case-health.js's
// ALL_HEALTH_TAGS, plus 'coverage_gap') and are not in this set: this set is
// specifically what the alert WATCH owns the rising edge for.
export const SYSTEM_CONDITIONS = Object.freeze({
  // casey is not hearing the field: a configured real-time channel has never
  // connected since start (casey.js receiveStatus 'never-connected'). The
  // process is up, the dashboard is green, and no report can reach it.
  CHANNEL_DEAF: 'channel_deaf',
  // The provider is down AND messages are actually piling up behind it. Both
  // halves matter: a provider outage with an empty queue costs nobody a reply
  // yet, and a queue with a healthy provider is draining on its own.
  PROVIDER_DOWN_BACKLOG: 'provider_down_backlog',
  // The guardrail sweep has stopped completing passes, so stale, stuck and
  // abandoned cases are no longer being detected at all -- the failure whose
  // whole symptom is that nothing else has a symptom.
  SWEEP_STALLED: 'sweep_stalled',
})

const ARCHIVE_RE = /^alerts\.(\d+)\.jsonl$/

// Bound every free-text field before it reaches disk. A detail string is built
// from casey's own state today, but this file is read by tooling that will
// treat one line as one record, so a runaway string must not be able to make a
// line unreadable or blow the segment bound on a single write.
const clip = (v, n) => (v == null ? null : String(v).replace(/[\r\n]+/g, ' ').slice(0, n))

export class AlertLog {
  constructor({ dataDir, maxSegmentBytes, maxArchives, stderr = true } = {}) {
    if (!dataDir) throw new Error('AlertLog: dataDir is required')
    this.dir = path.resolve(dataDir, 'alerts')
    fs.mkdirSync(this.dir, { recursive: true })
    this.file = path.join(this.dir, 'alerts.jsonl')
    this.maxSegmentBytes = maxSegmentBytes
      || Number(process.env.CASEY_ALERT_LOG_MAX_BYTES)
      || DEFAULT_MAX_SEGMENT_BYTES
    this.maxArchives = Number.isFinite(Number(maxArchives)) && Number(maxArchives) >= 0
      ? Number(maxArchives)
      : (Number(process.env.CASEY_ALERT_LOG_MAX_ARCHIVES) || DEFAULT_MAX_ARCHIVES)
    this.stderr = stderr
    this.writeFailures = 0
    this.lastWriteError = null
  }

  // Every segment in replay order: archives oldest-first (their names carry
  // the rotation timestamp), then the live file. The single definition of what
  // this log contains, so rotation is invisible to every reader.
  _segments() {
    const archives = []
    let names = []
    try { names = fs.readdirSync(this.dir) } catch { names = [] }
    for (const name of names) {
      const m = ARCHIVE_RE.exec(name)
      if (m) archives.push({ stamp: Number(m[1]), file: path.join(this.dir, name) })
    }
    archives.sort((a, b) => a.stamp - b.stamp)
    return [...archives.map(a => a.file), this.file]
  }

  // Rename the live file out of the way when the record about to be appended
  // would carry it past the segment size, deciding against the INCOMING line's
  // length so the bound is exact rather than one record loose (raw-log.js's
  // _rotateIfNeeded, same reasoning). Then drop the oldest archives past the
  // retention count -- see this file's header for why deleting here is correct
  // and deleting in raw-log.js would not be.
  _rotateIfNeeded(incomingBytes = 0) {
    let size = 0
    try { size = fs.statSync(this.file).size } catch { return null }
    if (size === 0) return null
    if (size + incomingBytes <= this.maxSegmentBytes) return null
    let stamp = Date.now()
    let archive = path.join(this.dir, `alerts.${stamp}.jsonl`)
    // Two rotations inside one millisecond would collide on the name; walk the
    // stamp forward rather than overwrite an archive that already holds lines.
    while (fs.existsSync(archive)) archive = path.join(this.dir, `alerts.${++stamp}.jsonl`)
    fs.renameSync(this.file, archive)
    this._pruneArchives()
    return archive
  }

  _pruneArchives() {
    const segments = this._segments()
    const archives = segments.slice(0, -1)   // everything but the live file, oldest first
    const excess = archives.length - this.maxArchives
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(archives[i]) } catch { /* already gone; retention is best-effort */ }
    }
  }

  // The only write method. Synchronous on purpose, unlike raw-log.js's async
  // append: that one sits on the inbound turn's hot path for every contact,
  // where a sync disk write would stall the whole event loop. This one fires
  // at most a couple of times an hour (rising edges only) and its whole reason
  // to exist is to survive the moment the process is in trouble -- a queued
  // async write that never flushes because the worker exited is exactly the
  // silence this file was added to end.
  write(entry) {
    const now = Number.isFinite(entry?.at) ? entry.at : Date.now()
    const line = {
      tag: ALERT_TAG,
      t: new Date(now).toISOString(),
      at: now,
      event: entry?.event === 'cleared' ? 'cleared' : 'raised',
      condition: clip(entry?.condition, 64) || 'unknown',
      // A case ref, never a contact identifier -- see this file's header.
      // 'SYSTEM' for the system-level watch, 'TEAM-COVERAGE' for the coverage
      // gap, a real CASE-... ref for a per-case guardrail breach.
      ref: clip(entry?.ref, 64) || 'SYSTEM',
      detail: clip(entry?.detail, 400) || '',
      since: Number.isFinite(entry?.since) ? entry.since : null,
      for_ms: Number.isFinite(entry?.forMs) ? entry.forMs : null,
    }
    const text = JSON.stringify(line) + '\n'
    try {
      this._rotateIfNeeded(Buffer.byteLength(text, 'utf8'))
      fs.appendFileSync(this.file, text, 'utf8')
    } catch (e) {
      this.writeFailures += 1
      this.lastWriteError = e?.message || String(e)
      // The file was the durable half; stderr below is the other half and does
      // not depend on the disk, so a full/read-only disk still reaches a human
      // watching the process output. Say that the file write failed rather
      // than swallowing it.
      console.error(`${ALERT_TAG} write-failed ${this.file}: ${this.lastWriteError}`)
    }
    if (this.stderr) {
      // One line, prefix-first, so `grep CASEY-ALERT` over a journal or a
      // container log finds it and a human reading the scrollback sees the
      // condition before the sentence.
      console.error(`${ALERT_TAG} ${line.event} ${line.condition} ref=${line.ref} ${line.detail}`)
    }
    return line
  }

  // Replay every segment, newest entry last. Corrupt lines (a partial write
  // from a crash mid-append) are counted and skipped, never trusted as a real
  // record -- the same discipline raw-log.js's corruptLineCount holds.
  read({ limit = 0 } = {}) {
    const entries = []
    let corrupt = 0
    for (const segment of this._segments()) {
      let raw
      try { raw = fs.readFileSync(segment, 'utf8') } catch { continue }
      for (const l of raw.split('\n')) {
        if (!l) continue
        try { entries.push(JSON.parse(l)) } catch { corrupt++ }
      }
    }
    const items = limit > 0 ? entries.slice(-limit) : entries
    return { items, total: entries.length, corrupt }
  }

  stats() {
    const segments = this._segments().map((file) => {
      let bytes = 0
      try { bytes = fs.statSync(file).size } catch { bytes = 0 }
      return { file: path.basename(file), bytes }
    })
    return {
      dir: this.dir,
      segments,
      archive_count: Math.max(0, segments.length - 1),
      total_bytes: segments.reduce((n, s) => n + s.bytes, 0),
      max_segment_bytes: this.maxSegmentBytes,
      max_archives: this.maxArchives,
      ceiling_bytes: this.maxSegmentBytes * (this.maxArchives + 1),
      write_failures: this.writeFailures,
      last_write_error: this.lastWriteError,
    }
  }
}

// The rising-edge rule, made durable. evaluate() is called on every watch tick
// with the condition's CURRENT truth and answers with the EDGE, never the
// level: 'raised' exactly once when it becomes true, 'cleared' exactly once
// after it has been continuously false for the hold-down, and null every other
// tick -- which is every tick, almost always.
//
// The state is persisted (a fixed-size JSON object, three keys, rewritten in
// place -- never appended to) because the in-memory version of this rule has a
// hole a headless deployment falls straight into: a worker that crash-loops
// under the supervisor re-raises every standing condition on every boot. The
// file makes "already told someone" survive the restart.
export class AlertGate {
  constructor({ dataDir, clearHoldMs } = {}) {
    if (!dataDir) throw new Error('AlertGate: dataDir is required')
    this.dir = path.resolve(dataDir, 'alerts')
    fs.mkdirSync(this.dir, { recursive: true })
    this.file = path.join(this.dir, 'state.json')
    this.clearHoldMs = Number.isFinite(Number(clearHoldMs)) && Number(clearHoldMs) >= 0
      ? Number(clearHoldMs)
      : (Number(process.env.CASEY_ALERT_CLEAR_HOLD_MS) || DEFAULT_CLEAR_HOLD_MS)
    this.state = this._load()
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch { return {} }
  }

  _save() {
    // Write-then-rename so a crash mid-write cannot leave a truncated
    // state.json that _load() would silently read as "nothing is active",
    // re-raising every standing condition on the next tick.
    const tmp = this.file + '.tmp'
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch { /* state is an optimisation over re-alerting, never a hard failure */ }
  }

  // 'raised' | 'cleared' | null, plus the timing the caller puts in the entry.
  evaluate(condition, active, now = Date.now()) {
    const st = this.state[condition] || { active: false }
    if (active) {
      if (st.falseSince) { delete st.falseSince; this.state[condition] = st; this._save() }
      if (st.active) return null                      // standing: say nothing
      this.state[condition] = { active: true, since: now }
      this._save()
      return { edge: 'raised', since: now, forMs: 0 }
    }
    if (!st.active) return null                       // was never true
    if (!st.falseSince) {                             // falling edge, start the hold-down
      st.falseSince = now
      this.state[condition] = st
      this._save()
      return null
    }
    if (now - st.falseSince < this.clearHoldMs) return null
    const since = Number.isFinite(st.since) ? st.since : now
    this.state[condition] = { active: false, since: null, clearedAt: now }
    this._save()
    return { edge: 'cleared', since, forMs: Math.max(0, now - since) }
  }

  // Which conditions are standing right now, for `casey alerts` and for the
  // exit code a monitor reads.
  snapshot() {
    const out = []
    for (const [condition, st] of Object.entries(this.state || {})) {
      if (st && st.active) out.push({ condition, since: Number.isFinite(st.since) ? st.since : null })
    }
    return out
  }
}

// A drop-in replacement for hooks/notifiers.js's breachNotifier, with the same
// (caseRow, breach, detail) call shape so casey.js's existing notifyBreach seam
// -- the per-case sweep alert, the team coverage gap and the system watch --
// reaches it unchanged. The 4th argument is additive and optional: the webhook
// notifier's own signature takes three and ignores it, so the two are
// interchangeable at every call site.
//
// Returns null with no log, so a caller that got null from breachNotifier AND
// null from here behaves exactly as it did before either existed.
export function fileAlertNotifier(alertLog, log = null) {
  if (!alertLog) return null
  return async (c, breach, detail, opts = {}) => {
    try {
      alertLog.write({
        event: opts.event === 'cleared' ? 'cleared' : 'raised',
        condition: breach,
        ref: c?.ref || 'SYSTEM',
        detail: detail || breach,
        since: opts.since,
        forMs: opts.forMs,
        at: opts.at,
      })
    } catch (e) {
      // Same degrade-not-throw contract as the webhook notifier: a failing
      // alert channel must never break the sweep or the turn that raised it.
      log?.warn?.('[casey] alert log write failed', { condition: breach, error: e?.message || String(e) })
    }
  }
}
