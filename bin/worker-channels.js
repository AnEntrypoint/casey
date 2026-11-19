import { WORKER_MSG, ipcSend } from '../src/supervisor-ipc.js'
import { caseyText } from '../src/deployment-text.js';

export function hasCreds(ch) {
  if (ch === 'discord') return !!process.env.DISCORD_BOT_TOKEN
  if (ch === 'whatsapp') return !!(process.env.WHATSAPP_API_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
  return false
}

function refuse(forked, reason, message) {
  if (forked) ipcSend(process, WORKER_MSG.FATAL, { reason })
  console.error(message)
  process.exit(1)
}

function gateWhatsappAppSecret(requested, flags, forked) {
  if (!hasCreds('whatsapp') || process.env.WHATSAPP_APP_SECRET) return
  const idx = requested.indexOf('whatsapp')
  if (idx !== -1 && flags.channels) {
    refuse(forked,
      caseyText("bin/worker-channels.js#w0"),
      caseyText("bin/worker-channels.js#w1"))
  }
  if (idx !== -1) requested.splice(idx, 1)
  console.error(caseyText("bin/worker-channels.js#w2"))
}

function gateWhatsappVerifyToken(channels, flags, forked) {
  if (!channels.includes('whatsapp') || process.env.WHATSAPP_VERIFY_TOKEN) return
  const idx = channels.indexOf('whatsapp')
  if (idx !== -1 && flags.channels) {
    refuse(forked,
      caseyText("bin/worker-channels.js#w3"),
      caseyText("bin/worker-channels.js#w4"))
  }
  if (idx !== -1) channels.splice(idx, 1)
  console.error(caseyText("bin/worker-channels.js#w5"))
}

export function resolveServingChannels(flags, forked) {
  const requested = (flags.channels || 'discord,whatsapp').split(',').map(s => s.trim()).filter(Boolean)
  gateWhatsappAppSecret(requested, flags, forked)
  const channels = requested.filter(ch => (ch === 'whatsapp' ? (hasCreds(ch) && !!process.env.WHATSAPP_APP_SECRET) : hasCreds(ch)))
  gateWhatsappVerifyToken(channels, flags, forked)
  if (!channels.length) {
    refuse(forked, caseyText("bin/worker-channels.js#w6"), caseyText("bin/worker-channels.js#w7"))
  }
  return channels
}
