import { WORKER_MSG, ipcSend } from '../src/supervisor-ipc.js'

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
      'WHATSAPP_APP_SECRET required to serve WhatsApp (verify inbound webhook signatures)',
      '[worker] WHATSAPP_APP_SECRET is required to enable WhatsApp - refusing to serve unsigned inbound')
  }
  if (idx !== -1) requested.splice(idx, 1)
  console.error('[worker] WhatsApp creds present but WHATSAPP_APP_SECRET unset - skipping WhatsApp (set the secret to enable it)')
}

function gateWhatsappVerifyToken(channels, flags, forked) {
  if (!channels.includes('whatsapp') || process.env.WHATSAPP_VERIFY_TOKEN) return
  const idx = channels.indexOf('whatsapp')
  if (idx !== -1 && flags.channels) {
    refuse(forked,
      'WHATSAPP_VERIFY_TOKEN required to serve WhatsApp',
      '[worker] WHATSAPP_VERIFY_TOKEN is required to enable WhatsApp - refusing to serve without it')
  }
  if (idx !== -1) channels.splice(idx, 1)
  console.error('[worker] WhatsApp creds present but WHATSAPP_VERIFY_TOKEN unset - skipping WhatsApp (set the token to enable it)')
}

export function resolveServingChannels(flags, forked) {
  const requested = (flags.channels || 'discord,whatsapp').split(',').map(s => s.trim()).filter(Boolean)
  gateWhatsappAppSecret(requested, flags, forked)
  const channels = requested.filter(ch => (ch === 'whatsapp' ? (hasCreds(ch) && !!process.env.WHATSAPP_APP_SECRET) : hasCreds(ch)))
  gateWhatsappVerifyToken(channels, flags, forked)
  if (!channels.length) {
    refuse(forked, 'no channels available', '[worker] no channels available - set discord/whatsapp credentials')
  }
  return channels
}
