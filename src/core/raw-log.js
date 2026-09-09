// core/raw-log.js -- the append-only raw observation log: the raw tier,
// physically separate from the case tier it sits beside.
//
// This is an in-process store additive to casey's existing thatcher-backed
// case/event tables -- it does NOT replace them. Each Observation (see
// core/observation.js) lands here, keyed by its own id, write-once. There is
// no update/delete method on this module: a correction is a NEW Observation
// with correctsId set, appended like any other. That is the entire
// enforcement of "raw is append-only, write-once, never updated" -- the
// capability to mutate an existing entry simply does not exist in this
// module's surface.
//
// Persistence backing: JSON-lines files under <dataDir>/raw-log/ so the
// log survives a process restart without requiring a new thatcher entity
// (which would entangle this additive tier with the existing CRM schema).
// Reads replay every segment. Keep the format plain JSONL, one JSON object per
// line: a data-escrow export of this tier is "hand over the directory".
//
// ROTATION IS BY ARCHIVING, NEVER BY TRUNCATING, and every read replays the
// archives. This tier is the system of record for provenance, so a rotation
// that dropped or hid a record would break the property the whole tier exists
// for -- core/write-path.js's canReplace check derives "the current best-ranked
// value for this field" from bySubject(), so a 'measured' GPS reading sitting
// in an archive that reads no longer stops a later 'inferred' estimate from
// overwriting it. Archiving keeps every record readable; the only thing
// rotation bounds is how large any ONE file gets.
//
// SIZE, chosen from this deployment's own measured numbers rather than a round
// figure: a real observation built from the real case reports in this store
// serializes to 1737 bytes on average (8 reports, range 1200-2195), and the
// store's own history runs at 2.39 report-bearing actions per day over its
// 13.4-day span -- about 4.2 KB/day, 1.5 MB/year. The binding constraint is not
// disk, it is the READ path: _load() reads a whole segment with readFileSync
// into a single string, so an unbounded segment eventually becomes unreadable
// and takes the tier's derivations with it. 8 MB per segment holds ~4,800
// observations: this deployment would take about five years to fill one (it
// will never rotate in practice, which is correct -- it does not need to),
// while a hundred-fold provincial rollout rotates roughly every three weeks
// and every segment stays small enough to read, copy and hand over whole.
import fs from 'node:fs'
import path from 'node:path'
import { requireObservation } from './observation.js'

export const DEFAULT_MAX_SEGMENT_BYTES = 8 * 1024 * 1024
const ARCHIVE_RE = /^observations\.(\d+)\.jsonl$/

export class RawLog {
  constructor({ dataDir, maxSegmentBytes } = {}) {
    if (!dataDir) throw new Error('RawLog: dataDir is required')
    this.dir = path.resolve(dataDir, 'raw-log')
    fs.mkdirSync(this.dir, { recursive: true })
    this.file = path.join(this.dir, 'observations.jsonl')
    this.maxSegmentBytes = maxSegmentBytes
      || Number(process.env.CASEY_RAW_LOG_MAX_BYTES)
      || DEFAULT_MAX_SEGMENT_BYTES
    this._cache = null   // lazily loaded id -> Observation map, rebuilt from disk
    // Serializes rotate-then-append. append() is shared by every subject in the
    // process (write-path.js's lock is per-subject only), so two concurrent
    // appends could otherwise both decide to rotate and the second would rename
    // a file the first had already moved.
    this._writeChain = Promise.resolve()
    // Append failures that reached the caller. A full disk is the case that
    // matters: this tier is where "who said it, how, when" is recorded, so a
    // write that cannot land is a lost provenance record, and it must be
    // countable rather than only thrown once into whatever caught it.
    this._writeFailures = 0
    this._lastWriteError = null
  }

  // Every segment in replay order: archives oldest-first (their names carry the
  // rotation timestamp), then the live file. The single definition of "what
  // this log contains" -- rotation is invisible to every reader through here.
  _segments() {
    const archives = []
    for (const name of fs.readdirSync(this.dir)) {
      const m = ARCHIVE_RE.exec(name)
      if (m) archives.push({ stamp: Number(m[1]), file: path.join(this.dir, name) })
    }
    archives.sort((a, b) => a.stamp - b.stamp)
    return [...archives.map(a => a.file), this.file]
  }

  // Rename the live file out of the way when the record about to be appended
  // would carry it past the segment size. Deciding against the INCOMING line's
  // length, not against the size already on disk, is what makes the bound
  // exact: checking only what is already there lets the segment that triggers
  // the next rotation sit one whole record over the limit in the meantime.
  // Rename is the whole mechanism deliberately: it is atomic within the
  // directory, it moves the bytes rather than dropping them, and a reader that
  // lists the directory between the rename and the next append sees every
  // record exactly once. Nothing is ever unlinked here -- there is no delete in
  // this class.
  _rotateIfNeeded(incomingBytes = 0) {
    let size = 0
    try { size = fs.statSync(this.file).size } catch { return null }
    if (size === 0) return null
    if (size + incomingBytes <= this.maxSegmentBytes) return null
    let stamp = Date.now()
    let archive = path.join(this.dir, `observations.${stamp}.jsonl`)
    // Two rotations inside one millisecond would collide on the name; walk the
    // stamp forward rather than overwrite an archive that already holds records.
    while (fs.existsSync(archive)) archive = path.join(this.dir, `observations.${++stamp}.jsonl`)
    fs.renameSync(this.file, archive)
    console.log(JSON.stringify({
      t: new Date().toISOString(), level: 'info', component: 'raw-log',
      msg: 'raw_log_rotated', archive: path.basename(archive), bytes: size,
    }))
    return archive
  }

  // The ONLY write method. Append-only: no update, no delete exist on this
  // class. Returns the observation unchanged (for chaining).
  //
  // Async: write-path.js's per-subject lock serializes concurrent writers to
  // the SAME subject, but this file is shared across every subject in the
  // process -- a synchronous appendFileSync would stall the whole Node event
  // loop (every in-flight turn for every contact) for the duration of one
  // disk write, not just this subject's critical section.
  async append(observation) {
    requireObservation(observation, 'RawLog.append')
    if (observation.syncedAt == null) {
      throw new Error('RawLog.append: observation must have syncedAt set before landing in the durable log (stamp via core/observation.js withSyncedAt in the write path)')
    }
    const line = JSON.stringify(observation) + '\n'
    // Rotate-then-append as one serialized step (see _writeChain). The chain
    // is re-armed with a settled promise either way, so one failed write never
    // poisons every later one.
    const run = this._writeChain.then(async () => {
      this._rotateIfNeeded(Buffer.byteLength(line, 'utf8'))
      await fs.promises.appendFile(this.file, line, 'utf8')
    })
    this._writeChain = run.catch(() => {})
    try {
      await run
    } catch (e) {
      // A write that cannot land is a provenance record that does not exist.
      // ENOSPC is the case this guards: the throw already propagates, but
      // provenance-wire.js's caller treats this whole tier as best-effort and
      // swallows it, so without a count and a loud line the tier would go
      // silently write-dead while every dashboard still looked healthy.
      this._writeFailures += 1
      this._lastWriteError = e?.message || String(e)
      console.error(JSON.stringify({
        t: new Date().toISOString(), level: 'error', component: 'raw-log',
        msg: 'raw_log_append_failed', file: this.file, error: this._lastWriteError,
        write_failures: this._writeFailures,
      }))
      throw e
    }
    if (this._cache) this._cache.set(observation.id, observation)
    return observation
  }

  _load() {
    if (this._cache) return this._cache
    const map = new Map()
    // Every segment, archives included: see the rotation note in this file's
    // header. Reading only the live file would make a rotation behave exactly
    // like the truncation this design forbids.
    for (const segment of this._segments()) {
      if (!fs.existsSync(segment)) continue
      const lines = fs.readFileSync(segment, 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const obs = JSON.parse(line)
          map.set(obs.id, obs)
        } catch (e) {
          // A corrupt line (partial write from a crash mid-append) is
          // skipped, never silently trusted as valid: a half-written
          // observation must never be readable as a real record. It is
          // counted into __corruptLines so corruptLineCount() can surface
          // it, not swallowed.
          map.__corruptLines = (map.__corruptLines || 0) + 1
        }
      }
    }
    this._cache = map
    return map
  }

  // All observations for a given subject, in append order -- the per-subject
  // trace-back both of core/write-path.js's latest-value-per-field
  // derivations read, and the only drill-down path off this log.
  bySubject(subjectId) {
    return [...this._load().values()].filter(o => o.subjectId === subjectId)
  }

  // The ONLY way the skipped-corrupt-line count above can ever reach a human.
  // Its one caller is `casey doctor` (bin/casey-setup.js), which reads it and
  // goes red on a non-zero count. Removing either end makes the documented
  // "corruption is reported, not swallowed" property unimplementable: a
  // truncated JSONL line would still be skipped correctly and never surfaced.
  corruptLineCount() { return this._load().__corruptLines || 0 }

  // The rest of what a human needs to know about this log's health, in the same
  // read-only shape as corruptLineCount and read by the same caller. Segment
  // sizes make rotation visible (an operator can see the archives exist and
  // that the live file is bounded); write_failures is the ENOSPC surface --
  // non-zero means provenance records were lost, and it is the only place that
  // says so, since the caller above this tier swallows the throw.
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
      observations: this._load().size,
      corrupt_lines: this.corruptLineCount(),
      write_failures: this._writeFailures,
      last_write_error: this._lastWriteError,
    }
  }
}
