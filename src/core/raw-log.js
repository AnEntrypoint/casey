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
    this._cache = null
    this._writeChain = Promise.resolve()
    this._writeFailures = 0
    this._lastWriteError = null
  }

  _segments() {
    const archives = []
    for (const name of fs.readdirSync(this.dir)) {
      const m = ARCHIVE_RE.exec(name)
      if (m) archives.push({ stamp: Number(m[1]), file: path.join(this.dir, name) })
    }
    archives.sort((a, b) => a.stamp - b.stamp)
    return [...archives.map(a => a.file), this.file]
  }

  _rotateIfNeeded(incomingBytes = 0) {
    let size = 0
    try { size = fs.statSync(this.file).size } catch { return null }
    if (size === 0) return null
    if (size + incomingBytes <= this.maxSegmentBytes) return null
    let stamp = Date.now()
    let archive = path.join(this.dir, `observations.${stamp}.jsonl`)
    while (fs.existsSync(archive)) archive = path.join(this.dir, `observations.${++stamp}.jsonl`)
    fs.renameSync(this.file, archive)
    console.log(JSON.stringify({
      t: new Date().toISOString(), level: 'info', component: 'raw-log',
      msg: 'raw_log_rotated', archive: path.basename(archive), bytes: size,
    }))
    return archive
  }

  async append(observation) {
    requireObservation(observation, 'RawLog.append')
    if (observation.syncedAt == null) {
      throw new Error('RawLog.append: observation must have syncedAt set before landing in the durable log (stamp via core/observation.js withSyncedAt in the write path)')
    }
    const line = JSON.stringify(observation) + '\n'
    const run = this._writeChain.then(async () => {
      this._rotateIfNeeded(Buffer.byteLength(line, 'utf8'))
      await fs.promises.appendFile(this.file, line, 'utf8')
    })
    this._writeChain = run.catch(() => {})
    try {
      await run
    } catch (e) {
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
    for (const segment of this._segments()) {
      if (!fs.existsSync(segment)) continue
      const lines = fs.readFileSync(segment, 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const obs = JSON.parse(line)
          map.set(obs.id, obs)
        } catch (e) {
          map.__corruptLines = (map.__corruptLines || 0) + 1
        }
      }
    }
    this._cache = map
    return map
  }

  bySubject(subjectId) {
    return [...this._load().values()].filter(o => o.subjectId === subjectId)
  }

  corruptLineCount() { return this._load().__corruptLines || 0 }

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
