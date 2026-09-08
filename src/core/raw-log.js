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
// Persistence backing: a JSON-lines file under <dataDir>/raw-log/ so the
// log survives a process restart without requiring a new thatcher entity
// (which would entangle this additive tier with the existing CRM schema).
// Reads replay the file. Keep the format plain JSONL, one JSON object per
// line: a data-escrow export of this tier is "hand over the file".

import fs from 'node:fs'
import path from 'node:path'
import { requireObservation } from './observation.js'

export class RawLog {
  constructor({ dataDir } = {}) {
    if (!dataDir) throw new Error('RawLog: dataDir is required')
    this.dir = path.resolve(dataDir, 'raw-log')
    fs.mkdirSync(this.dir, { recursive: true })
    this.file = path.join(this.dir, 'observations.jsonl')
    this._cache = null   // lazily loaded id -> Observation map, rebuilt from disk
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
    await fs.promises.appendFile(this.file, JSON.stringify(observation) + '\n', 'utf8')
    if (this._cache) this._cache.set(observation.id, observation)
    return observation
  }

  _load() {
    if (this._cache) return this._cache
    const map = new Map()
    if (fs.existsSync(this.file)) {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
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
}
