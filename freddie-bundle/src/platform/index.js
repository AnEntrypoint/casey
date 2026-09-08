// Cordis plugin hosting casey's WhatsApp/Discord transport inside freddie's
// own tree, per the user directive that freddie's boot() assembles the WHOLE
// running app -- transport included, not just the agent loop.
//
// Real freddie primitive used: ctx.webServer.register({kind:'exact', path,
// handler}) for WhatsApp's inbound Cloud API webhook (see deps/freddie's
// packages/host/webserver -- the only standing listening-socket seam in the
// tree). That socket is freddie's own, on freddie-bundle/cordis.patch.yml's
// CASEY_WEBHOOK_PORT, and is NOT the dashboard's -- the dashboard is a
// separate Express app bin/worker.js binds for itself. Discord needs no
// listening socket at all: its own gateway connection is an OUTBOUND
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
import { dispatchWhatsappWebhookBody } from '../../../src/adapters/whatsapp.js'
import { verifyWebhookOr401 } from '../../../src/adapters/webhook-platform-base.js'

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

// Adapts the Cloud API webhook contract (GET verify challenge, POST
// signature-verified receive) to freddie's raw (req, res) webServer handler
// shape. Verification and parsing/emission both live on the adapter
// (src/adapters/whatsapp.js); this function is transport plumbing only --
// read the body, hand it over, ack.
async function webhookHandler(adapter, req, res) {
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost')
    const challenge = adapter.verifyChallenge(url.searchParams.get('hub.verify_token'), url.searchParams.get('hub.challenge'))
    if (challenge === null) { res.writeHead(403); res.end(); return }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(challenge)
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const rawBody = Buffer.concat(chunks)
  // verifyWebhookOr401 and _verifySignature both speak express's
  // req.get()/req.rawBody and res.sendStatus() shape, which freddie's raw
  // node req/res does not have -- adapt rather than fork the verifier.
  const asExpressReq = {
    get: (h) => req.headers[h.toLowerCase()],
    rawBody,
  }
  const asExpressRes = {
    sendStatus: (code) => { res.writeHead(code); res.end() },
    json: (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) },
  }
  // The HMAC is over rawBody, so nothing here needs the payload parsed to
  // decide whether to trust it. Parsing it up front, as part of building the
  // request shim, meant an anonymous POST of any non-JSON bytes threw out of
  // this handler with no status written at all, before the signature was ever
  // consulted -- live-witnessed: an unsigned "not json at all" body left the
  // socket unanswered where it should have read 401.
  if (!verifyWebhookOr401(asExpressReq, asExpressRes, (r) => adapter._verifySignature(r))) return
  let body
  try {
    body = JSON.parse(rawBody.toString('utf8') || '{}')
  } catch {
    // Signed by Meta and still unparseable: answer, do not hang the socket.
    asExpressRes.sendStatus(400)
    return
  }
  // Emission is detached inside dispatchWhatsappWebhookBody, so this returns
  // before any media download -- ack immediately, or Meta redelivers.
  dispatchWhatsappWebhookBody(adapter, body)
  asExpressRes.json({ ok: true })
}
