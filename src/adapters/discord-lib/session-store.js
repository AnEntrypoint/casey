import fs from 'node:fs'
import path from 'node:path'

const MAX_SESSION_AGE_MS = Number(process.env.CASEY_DISCORD_SESSION_MAX_AGE_MS) || 60 * 60 * 1000
const FLUSH_DEBOUNCE_MS = 1000

export class DiscordSessionStore {
  constructor({ dataDir, log = console } = {}) {
    this.file = dataDir ? path.join(dataDir, 'discord-gateway-session.json') : null
    this.log = log
    this._dirty = false
    this._timer = null
    this._state = null
  }

  load() {
    if (!this.file) return null
    let raw
    try { raw = fs.readFileSync(this.file, 'utf8') } catch { return null }
    let s
    try { s = JSON.parse(raw) } catch {
      this.log?.warn?.('[discord] gateway session file unreadable; starting a fresh session', { file: this.file })
      return null
    }
    if (!s || !s.session_id || !s.resume_gateway_url) return null
    const age = Date.now() - (Number(s.saved_at) || 0)
    if (!Number.isFinite(age) || age > MAX_SESSION_AGE_MS) return null
    return { sessionId: s.session_id, resumeUrl: s.resume_gateway_url, seq: s.seq ?? null, botUserId: s.bot_user_id || null, savedAt: Number(s.saved_at) || 0 }
  }

  save({ sessionId, resumeUrl, seq, botUserId }) {
    if (!this.file) return
    this._state = {
      session_id: sessionId,
      resume_gateway_url: resumeUrl,
      seq: seq ?? null,
      bot_user_id: botUserId ?? this._state?.bot_user_id ?? null,
    }
    this._writeNow()
  }

  saveSeq(seq) {
    if (!this.file || !this._state) return
    this._state.seq = seq ?? null
    this._dirty = true
    if (this._timer) return
    this._timer = setTimeout(() => { this._timer = null; if (this._dirty) this._writeNow() }, FLUSH_DEBOUNCE_MS)
    this._timer.unref?.()
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    if (this._dirty) this._writeNow()
  }

  clear() {
    this._state = null
    this._dirty = false
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    if (!this.file) return
    try { fs.rmSync(this.file, { force: true }) } catch {  }
  }

  _writeNow() {
    if (!this.file || !this._state) return
    this._dirty = false
    const body = JSON.stringify({ ...this._state, saved_at: Date.now() })
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, body)
      fs.renameSync(tmp, this.file)
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }) } catch {  }
      this.log?.warn?.('[discord] could not persist gateway session; a restart will not resume', { error: e.message })
    }
  }
}
