// Cordis plugin hosting casey's WhatsApp/Discord transport inside freddie's
// own tree, per the user directive that freddie's boot() assembles the WHOLE
// running app -- transport included, not just the agent loop.
//
// Real freddie primitive used: ctx.webServer.register({kind:'exact', path,
// handler}) for WhatsApp's inbound Cloud API webhook, reusing freddie's own
// dashboard HTTP server on one port rather than a second listener (see
// deps/freddie's packages/host/webserver -- confirmed the only standing
// listening-socket seam in the tree). Discord needs no listening socket at
// all: its own gateway connection is an OUTBOUND websocket CLIENT the
// adapter opens itself.
//
// Adapter CONSTRUCTION (including casey's own DM/mention filtering, the
// follow-up window, and receive-liveness tracking -- src/casey.js's
// _makeDiscordAdapter) stays in src/casey.js, since that logic is tied to
// the live Casey instance (this.store, this.log, this._markConnected). This
// plugin receives the already-built, already-listening (for Discord)
// adapters via ctx.get('caseyBootOptions').adapters and wires only the
// WhatsApp webhook route + the shared message->handleInbound dispatch --
// purely transport glue, ignorant of casey's case-store/domain logic.
import { setAgentContext } from '../../../src/agent/run-turn.js'

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
    const path = process.env.WHATSAPP_WEBHOOK_PATH || '/webhooks/whatsapp'
    if (!whatsapp.token || !whatsapp.phoneId) throw new Error('WhatsappAdapter: WHATSAPP_API_TOKEN + WHATSAPP_PHONE_NUMBER_ID required')
    if (!whatsapp.verifyToken) throw new Error('WhatsappAdapter: WHATSAPP_VERIFY_TOKEN required')
    // WhatsappAdapter.start() normally opens its OWN express server+port
    // (src/adapters/whatsapp.js); it is never called here -- instead its
    // webhook verify/receive logic is driven directly through
    // ctx.webServer.register, reusing freddie's single dashboard port.
    // adapter.send() (outbound REST call) is unaffected either way.
    ctx.webServer.register({
      kind: 'exact',
      path,
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

// Adapts WhatsappAdapter's express-server-owned webhook logic (GET verify
// challenge, POST signature-verified receive) to freddie's own raw
// (req, res) webServer handler contract -- same verification/parsing
// behavior as src/adapters/whatsapp.js's start(), just not owning its own
// express app.
async function webhookHandler(adapter, req, res) {
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost')
    const verifyToken = url.searchParams.get('hub.verify_token') || ''
    const challenge = url.searchParams.get('hub.challenge') || ''
    const { timingSafeEqualStr } = await import('../../../src/adapters/webhook-platform-base.js')
    if (timingSafeEqualStr(verifyToken, adapter.verifyToken)) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(challenge)
    } else {
      res.writeHead(403)
      res.end()
    }
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const rawBody = Buffer.concat(chunks)
  const fakeReq = {
    get: (h) => req.headers[h.toLowerCase()],
    rawBody,
    body: JSON.parse(rawBody.toString('utf8') || '{}'),
  }
  const fakeRes = {
    sendStatus: (code) => { res.writeHead(code); res.end() },
    json: (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) },
  }
  const { verifyWebhookOr401 } = await import('../../../src/adapters/webhook-platform-base.js')
  if (!verifyWebhookOr401(fakeReq, fakeRes, (r) => adapter._verifySignature(r))) return
  // Reuse the adapter's own event-building/media-hydration logic verbatim by
  // calling its internal handler shape: adapter._verifySignature already ran
  // above, so build events the same way WhatsappAdapter's own POST route does.
  dispatchWhatsappEntries(adapter, fakeReq.body)
  fakeRes.json({ ok: true })
}

function dispatchWhatsappEntries(adapter, body) {
  const entries = body?.entry || []
  for (const e of entries) for (const c of (e.changes || [])) {
    const msgs = c.value?.messages || []
    for (const m of msgs) {
      const event = { from: m.from, text: m.text?.body || '', id: m.id, raw: { ...m, id: m.id, type: m.type } }
      const mediaObj = m.image || m.audio || m.document || m.video
      if (!mediaObj?.id) { adapter.emit('message', event); continue }
      const type = m.image ? 'image' : m.audio ? 'audio' : m.document ? 'document' : 'video'
      adapter._downloadMedia(mediaObj.id)
        .then(({ buffer, mimeType }) => adapter.emit('message', { ...event, media: { type, mimeType, buffer } }))
        .catch((err) => {
          console.error('WhatsappAdapter: media download failed', err)
          adapter.emit('message', { ...event, media: { type, mimeType: mediaObj.mime_type || '', buffer: null, error: String(err?.message || err) } })
        })
    }
  }
}
