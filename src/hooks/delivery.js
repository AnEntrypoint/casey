

import { observation } from './case-writes.js'
import { attachWamids } from '../delivery-status.js'
import { synthesizeVoice } from './media.js'
import { fitChoices, appendFallback, stampChoices, rememberChoices } from '../choices.js'
import { TURN_SOFT_DEADLINE_MS, STILL_WORKING_TEXT, TURN_TIMEOUT_TEXT } from './turn-deadlines.js'

export function resolveAdapter(receiver, platform) {
  return receiver?.adapters?.[platform] || null
}

export async function sendGuaranteedFallback({
  store, log, adapter, fresh, channel, replyTo, platform,
  turnStartedAt, stopTyping,
}) {

  const elapsedMs = Date.now() - turnStartedAt
  const fallbackText = elapsedMs >= TURN_SOFT_DEADLINE_MS ? TURN_TIMEOUT_TEXT : STILL_WORKING_TEXT
  const fallbackEvent = await store.appendEvent(fresh.id, {
    kind: 'outbound', actor: 'system', channel,
    text: fallbackText, data: { to: replyTo, fallback: true, guaranteedFallback: true },
  })
  stopTyping?.()
  const fallbackReply = { to: replyTo, text: fallbackText, platform, caseId: fresh.id, degraded: true, guaranteedFallback: true }

  let fallbackDelivered = false
  try {
    if (typeof adapter?.send === 'function') {
      fallbackDelivered = true

      await attachWamids(store, fallbackEvent, await adapter.send(fallbackReply), { log, recentSends: adapter.recentSends })
    }
  } catch (e) {
    fallbackDelivered = false
    log.error?.('[casey] guaranteed-fallback send failed', { caseId: fresh.id, error: e.message })

    await store.appendEvent(fresh.id, observation(`fallback send failed on ${channel}: ${e.message}`))
  }
  fallbackReply.delivered = fallbackDelivered
  return fallbackReply
}

async function markOutboundUndelivered(store, ev, replyTo, isFallback, error, log) {
  if (!ev?.id) return
  try {
    await store.t.update('event', ev.id, {
      data: JSON.stringify({ to: replyTo, fallback: isFallback, delivered: false, send_error: String(error || '').slice(0, 300) }),
    }, { id: 'system', role: 'system' })
  } catch (e) { log?.warn?.('[casey] could not mark outbound as undelivered', { error: e.message }) }
}

async function presentChoices({ store, log, fresh, text, offered }) {
  if (!offered) return { text }
  try {
    const fit = fitChoices(offered)
    if (!fit) return { text }
    const stamped = stampChoices(fit)
    const { text: withFallback, fallback } = appendFallback(text, stamped)
    await rememberChoices(store, fresh.contact_id, stamped)
    return { text: withFallback, choices: { mode: stamped.mode, items: stamped.items, fallback } }
  } catch (e) {
    log.error?.('[casey] choices could not be presented; the reply goes out as plain text', { caseId: fresh.id, error: e.message })
    return { text }
  }
}


export async function sendAgentReply({
  store, log, adapter, fresh, channel, replyTo, platform, text: plainText, isFallback, degraded, offered = null,
}) {
  const { text, choices } = await presentChoices({ store, log, fresh, text: plainText, offered })

  const outboundEvent = await store.appendEvent(fresh.id, {
    kind: 'outbound', actor: 'agent', channel,
    text, data: { to: replyTo, fallback: isFallback },
  })
  const reply = { to: replyTo, text, platform, caseId: fresh.id, ...(degraded ? { degraded: true } : {}), ...(choices ? { choices } : {}) }

  const audio = await synthesizeVoice(plainText, { caseRow: fresh, log })
  if (audio) reply.audio = audio

  let delivered = false
  if (adapter?.send) {
    delivered = true
    try { await attachWamids(store, outboundEvent, await adapter.send(reply), { log, recentSends: adapter.recentSends }) }
    catch (e) {
      delivered = false
      log.error?.('[casey] adapter.send failed', { caseId: fresh.id, platform, error: e.message })
      await store.appendEvent(fresh.id, observation(`send failed on ${channel}: ${e.message}`))

      await markOutboundUndelivered(store, outboundEvent, replyTo, isFallback, e.message, log)
    }
  } else {

    await markOutboundUndelivered(store, outboundEvent, replyTo, isFallback,
      `no adapter for channel "${channel}" -- nothing was sent`, log)
    await store.appendEvent(fresh.id, observation(`reply not sent: no adapter for channel "${channel}"`))
  }

  return { reply, delivered }
}
