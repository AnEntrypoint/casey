// worker-channels.js  --  which channels this worker is actually allowed to
// serve, and the credential/secret gates that decide it.
//
// Split out of bin/worker.js verbatim. Every refusal here is deliberately loud
// and terminal rather than a silent drop of the serving surface, so a
// misconfigured deployment shows up as a supervised crash-budget stop instead of
// a process that looks alive and answers nobody.

import { WORKER_MSG, ipcSend } from '../src/supervisor-ipc.js'

// hasCreds mirrors bin/casey.js so a channel with no credentials is skipped
// rather than crashing the worker on boot (which the supervisor would read as a
// crash-loop). Kept local to avoid importing the whole CLI module.
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

// Security invariant (AGENTS.md): WhatsApp must NOT serve without
// WHATSAPP_APP_SECRET -- without it freddie cannot HMAC-verify inbound webhooks,
// so anyone reaching the webhook can forge farmer messages. Enforced here in the
// worker (the process that actually binds the channel), not just in doctor: if
// whatsapp has creds but no secret, refuse it. If whatsapp was EXPLICITLY
// requested, that is a fatal misconfiguration (loud, not a silent drop); if it
// came from the default channel list, drop it with a warning and serve the rest.
function gateWhatsappAppSecret(requested, flags, forked) {
  if (!hasCreds('whatsapp') || process.env.WHATSAPP_APP_SECRET) return
  const idx = requested.indexOf('whatsapp')
  if (idx !== -1 && flags.channels) {
    // operator named whatsapp explicitly -> fatal, do not run it unsigned
    refuse(forked,
      'WHATSAPP_APP_SECRET required to serve WhatsApp (verify inbound webhook signatures)',
      '[worker] WHATSAPP_APP_SECRET is required to enable WhatsApp - refusing to serve unsigned inbound')
  }
  if (idx !== -1) requested.splice(idx, 1)
  console.error('[worker] WhatsApp creds present but WHATSAPP_APP_SECRET unset - skipping WhatsApp (set the secret to enable it)')
}

// casey's own WhatsappAdapter (src/adapters/whatsapp.js) requires
// WHATSAPP_VERIFY_TOKEN and throws at start() when unset -- no silent
// guessable-default fallback. Refuse the same way WHATSAPP_APP_SECRET is refused
// above, rather than letting the adapter crash start() later.
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
    // No serving surface: fatal, not a silent idle. The supervisor treats a FATAL
    // boot as a crash for budget purposes, so a permanently-misconfigured worker
    // trips the crash-loop guard into 'degraded' instead of respawning forever.
    refuse(forked, 'no channels available', '[worker] no channels available - set discord/whatsapp credentials')
  }
  return channels
}
