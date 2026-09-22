// Discord gateway (WebSocket) + REST send adapter. Outbound gateway-websocket
// client: it owns no listening socket.
import { EventEmitter } from 'node:events'
import { DEFAULT_INTENTS, SEND_TIMEOUT_MS } from './discord-lib/constants.js'
import { fetchWithTimeout } from './webhook-platform-base.js'
import * as gateway from './discord-lib/gateway.js'
import * as rest from './discord-lib/rest.js'

export class DiscordAdapter extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.platform = 'discord'
    this.token = opts.token || process.env.DISCORD_BOT_TOKEN
    this.api = opts.api || 'https://discord.com/api/v10'
    this.intents = opts.intents ?? DEFAULT_INTENTS
    this.receive = opts.receive !== false   // open the gateway WS to receive messages
    this.log = opts.log || console
    this._ws = null
    this._heartbeat = null
    this._seq = null
    this._sessionId = null
    this._resumeUrl = null
    this._acked = true
    this._closed = false
    this._botUserId = null
    // Reconnect backoff/retry-budget state: a flat fixed-interval reconnect
    // loop with no retry ceiling hammers a genuinely-down gateway forever at
    // a fixed rate instead of backing off.
    this._retries = 0
    this._reconnecting = false
    this._reconnectTimeout = null
    this._invalidSessionTimeout = null
    // Cross-restart resume state. `sessionStore` persists the session id,
    // resume url and sequence so the NEXT process resumes rather than
    // re-identifying (see discord-lib/session-store.js for why a fresh
    // IDENTIFY silently forfeits everything Discord buffered). Absent, the
    // adapter behaves exactly as it did before: in-process reconnects still
    // resume, a restart still starts clean.
    this.sessionStore = opts.sessionStore || null
    // Called with a short reason string when a resume was attempted and Discord
    // refused it -- the one point where casey can know a disconnect window went
    // unreplayed. Wired to the dropped-intake counter by casey-adapters.js.
    this.onUnresumableGap = opts.onUnresumableGap || null
    this._resumeFromDisk = false
    this._resumeAttempted = false
    this._resumeStateSavedAt = null
    // Typing-indicator bookkeeping, per channel: { timer, lastSentAt }.
    this._typingTimers = new Map()
  }

  async start() {
    if (!this.token) throw new Error('DiscordAdapter: DISCORD_BOT_TOKEN required')
    // Bounded like every other call this adapter makes: scheduleReconnect's
    // last-resort retry calls start() again, and an unbounded lookup that
    // never settles takes its .catch with it -- no further reconnect is ever
    // scheduled and the bot stays deaf for the life of the process, with
    // nothing logged.
    const gw = await fetchWithTimeout(`${this.api}/gateway/bot`, { headers: { authorization: `Bot ${this.token}` } }, SEND_TIMEOUT_MS).then(r => r.json())
    if (!gw.url) throw new Error('DiscordAdapter: gateway lookup failed: ' + JSON.stringify(gw))
    this.gatewayUrl = gw.url + '/?v=10&encoding=json'
    // Open the gateway WebSocket so inbound messages are emitted as 'message'
    // events { from, text, raw, platform }. Without this the adapter can send
    // but never receives.
    if (this.receive) {
      this._closed = false
      this._retries = 0
      // Pick up the session the previous process left behind BEFORE opening the
      // socket, so the first connect of a restarted worker is a RESUME carrying
      // the last sequence that session saw. Discord then replays every dispatch
      // sent while casey was down; case-intake.js's msg_id dedup absorbs the
      // ones already recorded. Nothing here is fatal: with no stored session
      // (first boot, cleared state, aged out) this is a no-op and the connect
      // below is an ordinary IDENTIFY.
      const stored = this.sessionStore?.load?.()
      // A session with no stored identity is deliberately NOT resumed. Without
      // the bot user id a resumed connection cannot evaluate the guild mention
      // filter (every replayed message would be discarded as unaddressed) and
      // cannot apply the self-message guard, so the replay it buys is worth
      // nothing and the deafness it causes lasts the life of the process. A
      // fresh IDENTIFY forfeits the disconnect window but comes back with a
      // working identity, which is strictly the better of the two.
      if (stored && !stored.botUserId) {
        this.log?.warn?.('[discord] stored gateway session carries no bot identity; identifying fresh instead of resuming')
        this.sessionStore?.clear?.()
      } else if (stored) {
        this._sessionId = stored.sessionId
        this._resumeUrl = stored.resumeUrl
        this._seq = stored.seq
        // Restore the identity too, BEFORE the socket opens. A RESUME sends no
        // READY, so this is the only place a resumed process can learn its own
        // user id -- and the guild @mention filter one layer up fails closed
        // without it, which would discard the very replayed messages the resume
        // exists to recover.
        this._botUserId = stored.botUserId || null
        this._resumeStateSavedAt = stored.savedAt
        this._resumeFromDisk = true
        this.log?.info?.('[discord] resuming the previous process gateway session', { seq: stored.seq, botUserKnown: !!stored.botUserId, downMs: stored.savedAt ? Date.now() - stored.savedAt : null })
      }
      gateway.connect(this)
    }
  }

  // The bot's own user id, captured from READY -- used to filter out
  // self-replies and to build an @-mention filter upstream.
  get botUserId() { return this._botUserId }

  async stop() {
    this._closed = true
    clearInterval(this._heartbeat)
    clearTimeout(this._reconnectTimeout)
    clearTimeout(this._invalidSessionTimeout)
    for (const t of this._typingTimers.values()) clearInterval(t.timer)
    this._typingTimers.clear()
    // Write the last sequence through before the process goes away: this is the
    // supervisor's drain path, the exact moment the session is handed to the
    // next worker, and a debounced sequence still sitting in memory here is the
    // difference between a clean resume and a replayed gap.
    try { this.sessionStore?.flush?.() } catch { /* best effort on the way out */ }
    try { this._ws?.close?.() } catch {}
  }

  async send(reply) { return rest.send(this, reply) }

  startTyping(channelId) { return rest.startTyping(this, channelId) }

  stopTyping(channelId) { return rest.stopTyping(this, channelId) }
}
