// core/raw-log.js -- the append-only raw observation log: TIER 1 of the
// four-tier physical separation (raw / cases / aggregates / interpretations).
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
// Reads replay the file; this is intentionally simple -- correctness over
// cleverness for a log whose entire value proposition IS its simplicity.

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
  append(observation) {
    requireObservation(observation, 'RawLog.append')
    if (observation.syncedAt == null) {
      throw new Error('RawLog.append: observation must have syncedAt set before landing in the durable log (stamp via core/observation.js withSyncedAt in the write path)')
    }
    fs.appendFileSync(this.file, JSON.stringify(observation) + '\n', 'utf8')
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
          // skipped, never silently trusted as valid -- see
          // expansion-failure-drill-partial-sync-crash: a half-written
          // observation must never be readable as a real record. It is
          // reported via the returned corruptLines count so a caller can
          // surface it, not swallowed.
          map.__corruptLines = (map.__corruptLines || 0) + 1
        }
      }
    }
    this._cache = map
    return map
  }

  get(id) { return this._load().get(id) || null }

  // All observations for a given subject, in append order -- the trace-back
  // any aggregate must support (aggregation-drillable).
  bySubject(subjectId) {
    return [...this._load().values()].filter(o => o.subjectId === subjectId)
  }

  all() { return [...this._load().values()] }

  count() { return this._load().size }

  corruptLineCount() { return this._load().__corruptLines || 0 }

  // Force a fresh reload from disk (used by the failure-drill witness and
  // any caller that wrote to the file outside this instance).
  invalidateCache() { this._cache = null }
}
