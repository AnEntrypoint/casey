

import { setAgentContext } from '../../../src/agent/run-turn.js'
import { serveWhatsappWebhook, WEBHOOK_MAX_BODY_BYTES } from '../../../src/adapters/whatsapp.js'

export const name = 'casey-platform'

export const inject = ['webServer', 'agents']

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

async function webhookHandler(adapter, req, res) {
  const url = new URL(req.url, 'http://localhost')

  let rawBody = Buffer.alloc(0)
  if (req.method !== 'GET') {

    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > WEBHOOK_MAX_BODY_BYTES) {
        res.writeHead(413, { connection: 'close' })
        res.end(() => req.destroy?.())
        return
      }
      chunks.push(chunk)
    }
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
