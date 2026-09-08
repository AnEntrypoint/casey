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
    if (this.receive) { this._closed = false; this._retries = 0; gateway.connect(this) }
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
    try { this._ws?.close?.() } catch {}
  }

  async send(reply) { return rest.send(this, reply) }

  startTyping(channelId) { return rest.startTyping(this, channelId) }

  stopTyping(channelId) { return rest.stopTyping(this, channelId) }
}
