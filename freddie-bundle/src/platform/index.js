// Cordis plugin hosting casey's WhatsApp/Discord transport inside freddie's
// own tree, per the user directive that freddie's boot() assembles the WHOLE
// running app -- transport included, not just the agent loop.
//
// Real freddie primitive used: ctx.webServer.register({kind:'exact', path,
// handler}) for WhatsApp's inbound Cloud API webhook (see deps/freddie's
// packages/host/webserver -- the only standing listening-socket seam in the
// tree). That socket is freddie's own, on freddie-bundle/cordis.patch.yml's
// CASEY_WEBHOOK_PORT, and is a DIFFERENT socket from the dashboard's, which is
// a separate Express app bin/worker.js binds for itself on --port. The SAME
// webhook path is also mounted on that dashboard app
// (src/dashboard/routes/whatsapp-webhook.js) off this same adapter instance, so
// a deployment whose reverse proxy forwards only one port can still be reached;
// both mounts call src/adapters/whatsapp.js's one serveWhatsappWebhook. Discord
// needs no listening socket at all: its own gateway connection is an OUTBOUND
// websocket CLIENT the adapter opens itself.
//
// Adapter CONSTRUCTION (including casey's own DM/mention filtering, the
// follow-up window, and receive-liveness tracking) lives in
// src/casey-adapters.js's makeDiscordAdapter, since that logic is tied to the
// live Casey instance (its store, its log, its receive-liveness stamps). This
// plugin receives the already-built adapters via
// ctx.get('caseyBootOptions').adapters and wires only the WhatsApp webhook
// route + the shared message->handleInbound dispatch -- purely transport glue,
// ignorant of casey's case-store/domain logic. Discord is built but not yet
// connected when this runs: src/casey.js opens its gateway later, in start().
import { setAgentContext } from '../../../src/agent/run-turn.js'
import { serveWhatsappWebhook } from '../../../src/adapters/whatsapp.js'

export const name = 'casey-platform'
// 'agents' alongside 'webServer': this plugin hands its own ctx to
// setAgentContext(), and src/agent/run-turn.js reaches ctx.agents.create() on
// it for every inbound turn. Cordis gates property access on the declared
// inject list, so without 'agents' here the FIRST live turn throws "cannot get
// property agents without inject" -- witnessed against a real booted tree.
// Declaring it also correctly defers this plugin's mount until the agents
// service is actually available.
export const inject = ['webServer', 'agents']

/**
 * @param ctx - Cordis context (ctx.webServer required)
 *
 * Reads { channels, handleInbound, adapters: {whatsapp?, discord?} } from
 * ctx.get('caseyBootOptions') -- provided by freddie-bundle/boot.js's
 * `prepare` callback before any plugin row activates.
 */
export async function apply(ctx) {
  setAgentContext(ctx)

  const opts = ctx.get('caseyBootOptions')
  if (!opts) throw new Error('casey-platform: ctx.get(\'caseyBootOptions\') is unset -- freddie-bundle/boot.js must provide it before the tree mounts')
  const handleInbound = opts.handleInbound
  const adapters = opts.adapters || {}

  const whatsapp = adapters.whatsapp
  if (whatsapp) {
    if (!whatsapp.token || !whatsapp.phoneId) throw new Error('WhatsappAdapter: WHATSAPP_API_TOKEN + WHATSAPP_PHONE_NUMBER_ID required')
    if (!whatsapp.verifyToken) throw new Error('WhatsappAdapter: WHATSAPP_VERIFY_TOKEN required')
    // The adapter owns no listening socket: its webhook verify/receive logic
    // is driven through ctx.webServer.register, on freddie's own socket.
    // adapter.send() (outbound REST) is unaffected. The path comes from the
    // adapter itself so there is one answer to "where does Meta POST", not a
    // second env read with its own default here.
    ctx.webServer.register({
      kind: 'exact',
      path: whatsapp.path,
      handler: (req, res) => webhookHandler(whatsapp, req, res),
    })
    whatsapp.on('message', (m) => {
      handleInbound('whatsapp', m).catch(e => console.error('[platform] whatsapp message handler error', e?.message || e))
    })
  }

  const discord = adapters.discord
  if (discord) {
    discord.on('message', (m) => {
      handleInbound('discord', m).catch(e => console.error('[platform] discord message handler error', e?.message || e))
    })
  }
}

// Adapts freddie's raw (req, res) webServer handler shape to the express-SHAPED
// pair serveWhatsappWebhook speaks, and nothing else. The whole webhook
// contract -- challenge comparison, HMAC verification, parse, dispatch, ack --
// lives once in src/adapters/whatsapp.js and is shared verbatim with the
// dashboard-side mount (src/dashboard/routes/whatsapp-webhook.js). This
// function is transport plumbing only: read the query and the raw bytes, hand
// them over, translate the three response verbs back onto node's writeHead/end.
async function webhookHandler(adapter, req, res) {
  const url = new URL(req.url, 'http://localhost')
  // Only a POST has a body to read. Draining a GET's (empty) stream is
  // pointless, and the verify handshake must answer before any await.
  let rawBody = Buffer.alloc(0)
  if (req.method !== 'GET') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    rawBody = Buffer.concat(chunks)
  }
  serveWhatsappWebhook(adapter, {
    method: req.method,
    query: Object.fromEntries(url.searchParams),
    rawBody,
    get: (h) => req.headers[h.toLowerCase()],
  }, {
    sendStatus: (code) => { res.writeHead(code); res.end() },
    sendText: (text) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(text) },
    json: (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) },
  })
}
