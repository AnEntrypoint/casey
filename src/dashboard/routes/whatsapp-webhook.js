// The WhatsApp Cloud API webhook, mounted a SECOND time -- on the operator
// dashboard's own Express app, on the dashboard's own port (`--port`, default
// 4000), at the same `WHATSAPP_WEBHOOK_PATH` freddie's ctx.webServer serves it
// on (`CASEY_WEBHOOK_PORT`, default 4001).
//
// WHY A SECOND MOUNT EXISTS. casey listens on two sockets and an
// internet-facing deployment sits behind a reverse proxy it does not control.
// A proxy that forwards the public domain to ONE port forwards it to the
// dashboard's -- that is where the operator SPA and every `/api/*` route live,
// so it is the port a deployer publishes. Meta's calls then land on the
// dashboard app, which has no idea what they are: `routes/auth.js`'s
// `authGate()` answers `401 {"error":"unauthorized"}` and the messages never
// reach casey at all. Live-witnessed on a real deployment -- an empty webhook access
// log, no case in the store, and a public GET returning that exact 401 while
// the same path on 127.0.0.1:4001 correctly returned Meta's 403. This mount is
// the fix, and it is purely ADDITIVE: the freddie-side mount is untouched, so a
// deployment whose proxy already forwards both ports keeps working exactly as
// before and has two equivalent paths to the same handler.
//
// ONE ADAPTER, NOT TWO. `resolveWhatsappAdapter` hands back the LIVE
// `WhatsappAdapter` off `casey.js`'s `this.adapters` -- the same object
// `freddie-bundle/src/platform` wired `handleInbound` to, reached through the
// same `hooks/delivery.js::resolveAdapter` lookup the outbound send path uses.
// Constructing a second adapter here would give this route its own EventEmitter
// with no listener on the real turn pipeline: every signature would verify,
// every ack would be a 200, and no message would ever become a case. It is
// resolved once at mount rather than per request because `this.adapters` is
// assigned exactly once, in `casey.init()`, before the dashboard binds, and
// `casey.js` sits in the supervisor's full-restart watch (never Cordis HMR), so
// the object cannot be swapped under a running dashboard.
//
// THE HANDLER ITSELF IS NOT HERE. `src/adapters/whatsapp.js`'s
// `serveWhatsappWebhook` is the only implementation of the webhook contract and
// both mounts call it, so the HMAC check is the same code on both ports and
// this route is exactly as authenticated as the freddie-side one -- not weaker.
// This file is the express adaptation and nothing else.
import { serveWhatsappWebhook } from '../../adapters/whatsapp.js'

// Meta's largest webhook body is a few KB of JSON; express.raw's own 100KB
// default is already generous. Named rather than inherited so the bound on the
// one unauthenticated POST surface on this port is visible where it is set.
const WEBHOOK_BODY_LIMIT = '256kb'

/**
 * Register the webhook on the dashboard app. Returns the mounted path, or null
 * when this deployment serves no WhatsApp channel (nothing is mounted then --
 * an unauthenticated route that can never verify a signature is surface with no
 * purpose).
 *
 * MUST be called before `express.json()` and before `registerAuth` mounts the
 * session middleware, the CSRF guard and the auth gate: express matches in
 * registration order, so registering first is what exempts this one path from
 * all four. It is the same category as the public `/report` form -- ungated by
 * the session cookie because it carries its OWN authentication (Meta's
 * `X-Hub-Signature-256` HMAC over the raw bytes, not a browser session).
 *
 * @param app the real dashboard Express app
 * @param {{express: object, resolveWhatsappAdapter: (() => object|null)|null}} deps
 */
export function registerWhatsappWebhook(app, { express, resolveWhatsappAdapter }) {
  if (typeof resolveWhatsappAdapter !== 'function') return null
  const adapter = resolveWhatsappAdapter()
  if (!adapter) return null
  // One answer to "where does Meta POST": the path comes off the adapter, the
  // same property freddie's own mount registers, never a second env read with
  // its own default.
  const webhookPath = adapter.path

  const asShimRes = (res) => ({
    sendStatus: (code) => res.sendStatus(code),
    // The verify handshake must echo the challenge as a bare string -- Meta
    // compares the body literally, so no JSON wrapper and no HTML.
    sendText: (text) => res.type('text/plain').send(text),
    json: (obj) => res.json(obj),
  })

  app.get(webhookPath, (req, res) => serveWhatsappWebhook(adapter, {
    method: 'GET',
    query: req.query,
    rawBody: null,
    get: (h) => req.get(h),
  }, asShimRes(res)))

  // express.raw SCOPED TO THIS ONE ROUTE, never app-wide: the HMAC is computed
  // over the exact bytes Meta sent, and `express.json()` consumes the stream and
  // hands on a parsed object whose re-serialisation is not byte-identical (key
  // order, whitespace, unicode escaping), so a signature checked against it
  // fails on a legitimate call. `type: () => true` because the bytes must be
  // captured whatever content-type arrives -- a wrongly-typed or untyped POST
  // has to reach the signature check and be refused there, not fall through
  // with an empty body and be refused for the wrong reason.
  app.post(webhookPath, express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }), (req, res) => serveWhatsappWebhook(adapter, {
    method: 'POST',
    query: req.query,
    rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    get: (h) => req.get(h),
  }, asShimRes(res)))

  return webhookPath
}
