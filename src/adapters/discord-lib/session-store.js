// Durable Discord gateway session state, so a worker restart RESUMEs instead of
// re-IDENTIFYing.
//
// WHY THIS FILE EXISTS. Discord replays every dispatch a client missed while its
// socket was down, but ONLY on a successful RESUME (op 6) carrying the session
// id and the last sequence number that session saw. A fresh IDENTIFY forfeits
// the whole backlog silently: no error, no gap marker, the connection just comes
// up empty and every message sent during the downtime is gone forever.
//
// casey's supervisor restarts the worker as a FULL drain-then-respawn
// (supervisor-restart.js) -- the old process exits before the new one starts --
// so session id and sequence, held only in DiscordAdapter instance memory, died
// with every reload. Live-reload is on by default and a source edit is enough to
// trigger one, so the exposure is the whole restart window (~1-3s each, longer
// when the drain deadline forces a SIGKILL), plus any operator-initiated stop.
//
// Persisting the three fields Discord needs is what turns that window from
// silent loss into replay. The replay itself is safe because case-intake.js's
// recordInbound dedups atomically on msg_id under the per-conversation lock and
// names "gateway replay" as one of the redeliveries it exists to absorb -- so
// at-least-once delivery from Discord becomes exactly-once recording in casey.
//
// The sequence is written debounced rather than on every dispatch: a SIGKILL
// between a dispatch and its flush costs at most a second of sequence, which
// Discord answers by replaying a few already-recorded messages that the msg_id
// dedup then drops. Losing a message is unrecoverable; replaying one is free.
import fs from 'node:fs'
import path from 'node:path'

// Discord does not document how long a disconnected session stays resumable and
// answers INVALID_SESSION when it no longer is, which is the real authority.
// This bound only stops casey from attempting a resume with state so old the
// attempt is pure latency (a box that was off overnight), and from reporting a
// months-old file as a "gap" an operator could act on.
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

  // Read whatever the previous process left behind. Returns null when there is
  // nothing to resume from -- a first boot, a cleared session, or state aged
  // past MAX_SESSION_AGE_MS -- so the caller can tell "no session existed" from
  // "a session existed and could not be resumed", which are different facts and
  // only the second one means messages were lost.
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

  // Record the session Discord just handed us on READY. Written through
  // immediately: this is the one field without which no resume is possible at
  // all, and a crash one tick later must not cost it.
  //
  // THE BOT USER ID IS PART OF THE SESSION, NOT AN EXTRA. A RESUME never sends
  // a READY dispatch -- Discord replays the missed events and then sends
  // RESUMED -- so the bot's own user id, which only READY carries, is never
  // re-delivered on a resumed connection. Without persisting it, a resumed
  // worker runs with a null identity and casey-adapters.js's guild
  // @mention filter correctly fails closed on EVERY guild message, replayed
  // ones first: the resume would deliver the very messages it was built to save
  // and the filter would throw them away one layer up. Witnessed live before
  // this field existed.
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

  // Record the latest sequence. Debounced -- see the header for why a lost
  // second of sequence is the cheap side of this trade.
  saveSeq(seq) {
    if (!this.file || !this._state) return
    this._state.seq = seq ?? null
    this._dirty = true
    if (this._timer) return
    this._timer = setTimeout(() => { this._timer = null; if (this._dirty) this._writeNow() }, FLUSH_DEBOUNCE_MS)
    this._timer.unref?.()
  }

  // Flush any debounced sequence right now. Called on a clean stop, which is the
  // supervisor's drain path -- the exact moment the session is about to be
  // handed to the next process.
  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    if (this._dirty) this._writeNow()
  }

  // Discord said the session is gone (INVALID_SESSION). Remove the file rather
  // than leaving stale state a later boot would waste a resume attempt on.
  clear() {
    this._state = null
    this._dirty = false
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    if (!this.file) return
    try { fs.rmSync(this.file, { force: true }) } catch { /* nothing to clear */ }
  }

  // Atomic: write a sibling temp file and rename onto the target. A torn session
  // file is worse than no session file -- it reads as "nothing to resume" on the
  // next boot, which is exactly the silent forfeit this module exists to stop.
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
      try { fs.rmSync(tmp, { force: true }) } catch { /* best effort */ }
      this.log?.warn?.('[discord] could not persist gateway session; a restart will not resume', { error: e.message })
    }
  }
}
