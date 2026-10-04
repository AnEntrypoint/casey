import { serveWhatsappWebhook } from '../../adapters/whatsapp.js'

const WEBHOOK_BODY_LIMIT = '256kb'

export function registerWhatsappWebhook(app, { express, resolveWhatsappAdapter }) {
  if (typeof resolveWhatsappAdapter !== 'function') return null
  const adapter = resolveWhatsappAdapter()
  if (!adapter) return null
  const webhookPath = adapter.path

  const asShimRes = (res) => ({
    sendStatus: (code) => res.sendStatus(code),
    sendText: (text) => res.type('text/plain').send(text),
    json: (obj) => res.json(obj),
  })

  app.get(webhookPath, (req, res) => serveWhatsappWebhook(adapter, {
    method: 'GET',
    query: req.query,
    rawBody: null,
    get: (h) => req.get(h),
  }, asShimRes(res)))

  app.post(webhookPath, express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }), (req, res) => serveWhatsappWebhook(adapter, {
    method: 'POST',
    query: req.query,
    rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    get: (h) => req.get(h),
  }, asShimRes(res)))

  return webhookPath
}
