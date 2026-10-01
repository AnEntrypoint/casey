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
    this.receive = opts.receive !== false
    this.log = opts.log || console
    this._ws = null
    this._heartbeat = null
    this._seq = null
    this._sessionId = null
    this._resumeUrl = null
    this._acked = true
    this._closed = false
    this._botUserId = null
    this._retries = 0
    this._reconnecting = false
    this._reconnectTimeout = null
    this._invalidSessionTimeout = null
    this.sessionStore = opts.sessionStore || null
    this.onUnresumableGap = opts.onUnresumableGap || null
    this._resumeFromDisk = false
    this._resumeAttempted = false
    this._resumeStateSavedAt = null
    this._typingTimers = new Map()
  }

  async start() {
    if (!this.token) throw new Error('DiscordAdapter: DISCORD_BOT_TOKEN required')
    const gw = await fetchWithTimeout(`${this.api}/gateway/bot`, { headers: { authorization: `Bot ${this.token}` } }, SEND_TIMEOUT_MS).then(r => r.json())
    if (!gw.url) throw new Error('DiscordAdapter: gateway lookup failed: ' + JSON.stringify(gw))
    this.gatewayUrl = gw.url + '/?v=10&encoding=json'
    if (this.receive) {
      this._closed = false
      this._retries = 0
      const stored = this.sessionStore?.load?.()
      if (stored && !stored.botUserId) {
        this.log?.warn?.('[discord] stored gateway session carries no bot identity; identifying fresh instead of resuming')
        this.sessionStore?.clear?.()
      } else if (stored) {
        this._sessionId = stored.sessionId
        this._resumeUrl = stored.resumeUrl
        this._seq = stored.seq
        this._botUserId = stored.botUserId || null
        this._resumeStateSavedAt = stored.savedAt
        this._resumeFromDisk = true
        this.log?.info?.('[discord] resuming the previous process gateway session', { seq: stored.seq, botUserKnown: !!stored.botUserId, downMs: stored.savedAt ? Date.now() - stored.savedAt : null })
      }
      gateway.connect(this)
    }
  }

  get botUserId() { return this._botUserId }

  async stop() {
    this._closed = true
    clearInterval(this._heartbeat)
    clearTimeout(this._reconnectTimeout)
    clearTimeout(this._invalidSessionTimeout)
    for (const t of this._typingTimers.values()) clearInterval(t.timer)
    this._typingTimers.clear()
    try { this.sessionStore?.flush?.() } catch {  }
    try { this._ws?.close?.() } catch {}
  }

  async send(reply) { return rest.send(this, reply) }

  startTyping(channelId) { return rest.startTyping(this, channelId) }

  stopTyping(channelId) { return rest.stopTyping(this, channelId) }
}
