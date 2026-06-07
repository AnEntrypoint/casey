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

const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, HELLO: 10, HEARTBEAT_ACK: 11 }
// GUILD_MESSAGES(1<<9) + MESSAGE_CONTENT(1<<15) + DIRECT_MESSAGES(1<<12)
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15)

// Attach a live gateway connection to an existing freddie DiscordAdapter.
// The adapter keeps its send(); we add receive. Returns a disconnect fn.
export function connectDiscordReceive(adapter, { token = adapter.token, log = console } = {}) {
  if (!token) throw new Error('connectDiscordReceive: DISCORD_BOT_TOKEN required')
  let ws, heartbeat, seq = null, acked = true, closed = false

  const identify = () => ws.send(JSON.stringify({
    op: OP.IDENTIFY,
    d: { token, intents: INTENTS, properties: { os: 'linux', browser: 'casey', device: 'casey' } },
  }))

  const startHeartbeat = (interval) => {
    heartbeat = setInterval(() => {
      if (!acked) { try { ws.terminate() } catch {} return }  // zombie connection
      acked = false
      ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: seq }))
    }, interval)
  }

  const open = async () => {
    // Adapter.start() populates adapter.gatewayUrl via the bot gateway lookup.
    if (!adapter.gatewayUrl) await adapter.start()
    ws = new WebSocket(adapter.gatewayUrl)

    ws.on('message', (raw) => {
      let p; try { p = JSON.parse(raw.toString()) } catch { return }
      if (p.s != null) seq = p.s
      switch (p.op) {
        case OP.HELLO:
          startHeartbeat(p.d.heartbeat_interval)
          identify()
          break
        case OP.HEARTBEAT_ACK:
          acked = true
          break
        case OP.DISPATCH:
          if (p.t === 'MESSAGE_CREATE') onMessageCreate(p.d)
          break
      }
    })
    ws.on('close', () => {
      clearInterval(heartbeat)
      if (!closed) { log.warn?.('[discord] gateway closed, reconnecting in 3s'); setTimeout(open, 3000) }
    })
    ws.on('error', (e) => log.error?.('[discord] ws error', e.message))
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

  open().catch((e) => log.error?.('[discord] connect failed', e.message))

  return () => { closed = true; clearInterval(heartbeat); try { ws?.close() } catch {} }
}
