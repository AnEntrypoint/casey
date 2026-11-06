

import fs from 'node:fs'
import path from 'node:path'

export const ALERT_TAG = 'CASEY-ALERT'

export const DEFAULT_MAX_SEGMENT_BYTES = 1024 * 1024
export const DEFAULT_MAX_ARCHIVES = 4

export const DEFAULT_CLEAR_HOLD_MS = 15 * 60 * 1000

export const SYSTEM_CONDITIONS = Object.freeze({

  CHANNEL_DEAF: 'channel_deaf',

  PROVIDER_DOWN_BACKLOG: 'provider_down_backlog',

  SWEEP_STALLED: 'sweep_stalled',

  INBOUND_SILENT: 'inbound_silent',
})

const ARCHIVE_RE = /^alerts\.(\d+)\.jsonl$/

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

  _rotateIfNeeded(incomingBytes = 0) {
    let size = 0
    try { size = fs.statSync(this.file).size } catch { return null }
    if (size === 0) return null
    if (size + incomingBytes <= this.maxSegmentBytes) return null
    let stamp = Date.now()
    let archive = path.join(this.dir, `alerts.${stamp}.jsonl`)

    while (fs.existsSync(archive)) archive = path.join(this.dir, `alerts.${++stamp}.jsonl`)
    fs.renameSync(this.file, archive)
    this._pruneArchives()
    return archive
  }

  _pruneArchives() {
    const segments = this._segments()
    const archives = segments.slice(0, -1)
    const excess = archives.length - this.maxArchives
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(archives[i]) } catch {  }
    }
  }

  write(entry) {
    const now = Number.isFinite(entry?.at) ? entry.at : Date.now()
    const line = {
      tag: ALERT_TAG,
      t: new Date(now).toISOString(),
      at: now,
      event: entry?.event === 'cleared' ? 'cleared' : 'raised',
      condition: clip(entry?.condition, 64) || 'unknown',

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

      console.error(`${ALERT_TAG} write-failed ${this.file}: ${this.lastWriteError}`)
    }
    if (this.stderr) {

      console.error(`${ALERT_TAG} ${line.event} ${line.condition} ref=${line.ref} ${line.detail}`)
    }
    return line
  }

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

    const tmp = this.file + '.tmp'
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch {  }
  }

  evaluate(condition, active, now = Date.now()) {
    const st = this.state[condition] || { active: false }
    if (active) {
      if (st.falseSince) { delete st.falseSince; this.state[condition] = st; this._save() }
      if (st.active) return null
      this.state[condition] = { active: true, since: now }
      this._save()
      return { edge: 'raised', since: now, forMs: 0 }
    }
    if (!st.active) return null
    if (!st.falseSince) {
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

  snapshot() {
    const out = []
    for (const [condition, st] of Object.entries(this.state || {})) {
      if (st && st.active) out.push({ condition, since: Number.isFinite(st.since) ? st.since : null })
    }
    return out
  }
}

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

      log?.warn?.('[casey] alert log write failed', { condition: breach, error: e?.message || String(e) })
    }
  }
}
