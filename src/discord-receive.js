// discord-receive.js  --  adds the missing RECEIVE side to freddie's Discord
// adapter. freddie's DiscordAdapter.start() only does the gateway *lookup* and
// can send(), but never opens the WebSocket, so it never emits inbound
// 'message' events. This wraps an adapter (or builds one) and connects to the
// Discord Gateway: IDENTIFY -> heartbeat loop -> MESSAGE_CREATE -> emit 'message'
// in the shape casey's gateway hooks expect: { from, text, raw, platform }.
//
// Real end-to-end Discord simulation: point a bot at a server, message it, and
// a case is tracked exactly as WhatsApp would be.

import WebSocket from 'ws'

const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 }
// GUILD_MESSAGES(1<<9) + MESSAGE_CONTENT(1<<15) + DIRECT_MESSAGES(1<<12)
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15)

// Attach a live gateway connection to an existing freddie DiscordAdapter.
// The adapter keeps its send(); we add receive. Returns a disconnect fn.
// onConnect(readyPayload|null) fires on the REAL READY/RESUMED dispatch events
// below -- casey.js previously wrapped freddie's adapter._dispatch
// (a._dispatch) expecting THAT to see READY/RESUMED, but this module owns the
// entire real WebSocket gateway connection itself (freddie's
// DiscordAdapter.start() never opens a socket at all, per this file's own
// header comment); a._dispatch is never called by anything in casey's real
// receive path and that wrapper was dead code -- TWO real, independent bugs
// riding the same dead wrapper: (1) receiveHealth.connectedAt was never
// stamped (GET /api/health reported Discord state:never-connected even though
// real inbound messages were being received and processed correctly --
// sinceInboundMs WAS populated, via the working adapter.emit('message',...)
// wrapper in onMessageCreate below, confirming connectedAt's stamping path
// specifically was the broken half, not receive as a whole); (2) the bot's own
// user id was never captured from READY (botUserId stayed null forever), so
// casey.js's mention-filter guard (only respond to a DM or an @-mention of
// THIS bot) silently degraded to "any @-mention of anyone" -- readyPayload is
// passed through here specifically so casey.js can fix both at their real
// source instead of a second dead wrapper. Called on READY (full payload,
// including .user.id) and on RESUMED (called with no payload -- a resume
// carries no fresh READY body, so there is nothing new to capture, only the
// connectedAt liveness stamp to refresh).
export function connectDiscordReceive(adapter, { token = adapter.token, log = console, onConnect = null } = {}) {
  if (!token) throw new Error('connectDiscordReceive: DISCORD_BOT_TOKEN required')
  let ws, heartbeat, seq = null, acked = true, closed = false
  let sessionId = null, resumeUrl = null
  // Reconnect backoff state: a dead gateway (auth failure, partition, outage)
  // would otherwise spin a tight 3s reconnect loop hammering the API (P9: no
  // tight failure loop, explicit degradation). We back off exponentially up to a
  // ceiling and give up after MAX_RETRIES, then stop loudly. A successful
  // connection (HELLO) resets the counter so transient drops recover instantly.
  const BASE_MS = 3000, MAX_MS = 30000, MAX_RETRIES = 8
  let retries = 0, reconnecting = false, reconnectTimeout = null, invalidSessionTimeout = null

  const identify = () => ws.send(JSON.stringify({
    op: OP.IDENTIFY,
    d: { token, intents: INTENTS, properties: { os: 'linux', browser: 'casey', device: 'casey' } },
  }))
  const resume = () => ws.send(JSON.stringify({
    op: OP.RESUME,
    d: { token, session_id: sessionId, seq },
  }))

  const startHeartbeat = (interval) => {
    if (heartbeat) clearInterval(heartbeat)   // never stack intervals across reconnects
    heartbeat = setInterval(() => {
      // A missed ack means the socket is a zombie: terminate it. The 'close'
      // handler then drives the (backed-off) reconnect, so we do NOT also loop here.
      if (!acked) { try { ws.terminate() } catch { /* already gone */ } return }
      acked = false
      ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: seq }))
    }, interval)
  }

  // Schedule the next reconnect with backoff, unless we are shutting down, have
  // exhausted retries, or already have one in flight (guards re-entry).
  const scheduleReconnect = () => {
    if (closed || reconnecting) return
    if (retries >= MAX_RETRIES) {
      log.error?.(`[discord] reconnect failed after ${MAX_RETRIES} attempts, retrying in 1 hour`)
      reconnecting = true
      // Clear the cached gateway URL: adapter.gatewayUrl is set once (freddie's
      // DiscordAdapter.start() never clears it) and open() only re-fetches it
      // `if (!adapter.gatewayUrl)`, so every reconnect after the first -- including
      // this 1-hour last-resort retry -- would otherwise reuse the SAME url
      // forever, even if a stale/rotated url was the actual cause of the outage.
      adapter.gatewayUrl = null
      reconnectTimeout = setTimeout(() => {
        reconnecting = false
        retries = 0
        open().catch((e) => { log.error?.('[discord] reconnect failed', e.message); scheduleReconnect() })
      }, 60 * 60 * 1000)
      return
    }
    reconnecting = true
    const delay = Math.min(BASE_MS * 2 ** retries, MAX_MS)
    retries++
    log.warn?.(`[discord] gateway closed, reconnecting in ${Math.round(delay / 1000)}s (attempt ${retries}/${MAX_RETRIES})`)
    reconnectTimeout = setTimeout(() => { reconnecting = false; open().catch((e) => { log.error?.('[discord] reconnect failed', e.message); scheduleReconnect() }) }, delay)
  }

  const open = async () => {
    // Adapter.start() populates adapter.gatewayUrl via the bot gateway lookup.
    if (!adapter.gatewayUrl) await adapter.start()
    // Drop the previous socket's listeners before replacing it so reconnects do
    // not accumulate orphaned 'message'/'close'/'error' handlers over time.
    if (ws) { try { ws.removeAllListeners(); ws.terminate() } catch { /* already gone */ } }
    // Use the resume_gateway_url from the last READY if we have one (Discord
    // may load-balance; reconnecting to the original URL loses session affinity).
    const url = (sessionId && resumeUrl) ? resumeUrl : adapter.gatewayUrl
    ws = new WebSocket(url)

    ws.on('message', (raw) => {
      let p; try { p = JSON.parse(raw.toString()) } catch { return }
      if (p.s != null) seq = p.s
      switch (p.op) {
        case OP.HELLO:
          retries = 0                                 // connected: reset backoff
          acked = true                                // clear stale state before heartbeat
          startHeartbeat(p.d.heartbeat_interval)
          // Use RESUME when we have a prior session so we replay missed events;
          // fall back to IDENTIFY on fresh start or after INVALID_SESSION.
          if (sessionId) resume(); else identify()
          break
        case OP.HEARTBEAT_ACK:
          acked = true
          break
        case OP.RECONNECT:
          // Server requests a reconnect; close gracefully so the close handler
          // triggers a RESUME with the current session_id.
          try { ws.close(4000, 'server requested reconnect') } catch { /* already gone */ }
          break
        case OP.INVALID_SESSION:
          // Session is not resumable; clear it and re-identify after a brief delay.
          sessionId = null; resumeUrl = null; seq = null
          clearTimeout(invalidSessionTimeout)
          invalidSessionTimeout = setTimeout(() => { if (!closed) identify() }, p.d ? 1000 : 5000)
          break
        case OP.DISPATCH:
          if (p.t === 'READY') {
            sessionId = p.d.session_id
            resumeUrl = p.d.resume_gateway_url || adapter.gatewayUrl
            try { onConnect?.(p.d) } catch (e) { log.warn?.('[discord] onConnect callback failed', e.message) }
          }
          if (p.t === 'MESSAGE_CREATE') onMessageCreate(p.d)
          if (p.t === 'RESUMED') {
            log.info?.('[discord] session resumed successfully')
            try { onConnect?.(null) } catch (e) { log.warn?.('[discord] onConnect callback failed', e.message) }
          }
          break
      }
    })
    ws.on('close', () => {
      clearInterval(heartbeat)
      scheduleReconnect()
    })
    // 'error' is not guaranteed to be followed by 'close' in every ws failure mode
    // (e.g. a handshake failure on an already-half-open socket) -- terminate()
    // forces the close path deterministically so the heartbeat is always cleared
    // and a reconnect is always scheduled, rather than leaving a zombied socket.
    ws.on('error', (e) => { log.error?.('[discord] ws error', e.message); try { ws.terminate() } catch { /* already gone */ } })
  }

  const onMessageCreate = (m) => {
    if (m.author?.bot) return                       // ignore bots (and ourselves)
    adapter.emit('message', {
      from: m.author?.id,
      text: m.content || '',
      raw: m,                                        // includes channel_id (our conversation key)
      platform: 'discord',
    })
  }

  // The INITIAL connect must retry like a reconnect does: without this, a gateway
  // that is down at startup leaves the socket dead forever, silently dropping
  // every inbound Discord message (P9 -- no silent catastrophe).
  open().catch((e) => { log.error?.('[discord] connect failed', e.message); scheduleReconnect() })

  return () => { closed = true; clearInterval(heartbeat); clearTimeout(reconnectTimeout); clearTimeout(invalidSessionTimeout); try { ws?.close() } catch {} }
}
