

import { extractCode, claimInvite, attemptsExhausted, noteFailedAttempt, withoutIssuedCodes, issuedLooseCode, ATTEMPT_WINDOW_MS } from '../role-invites.js'
import { TIER_LABELS } from '../store/report-shape.js'
import { TIER_FIELD_WORKER, TIER_ANIMAL_HEALTH_TECHNICIAN, TIER_OPERATOR, tierLabel } from '../contact-tiers.js'
import { vocabText } from '../config-loader.js'

const WELCOME = {
  [TIER_FIELD_WORKER]: (label) => vocabText('ui.role_welcome_field_worker', 'You are registered as {label}. Message me the way you already do: describe what you see (animal, how many, where, what is wrong) and send photos or a voice note. Ask "my cases" or "what is open near me" any time. I will also record where you are if you share a location pin.', { label }),
  [TIER_ANIMAL_HEALTH_TECHNICIAN]: (label) => vocabText('ui.role_welcome_technician', 'You are registered as {label}. You can see and update your cases here, and you are the one who signs a case off as resolved once help has been given -- tell me when a case is done and I will check the record is complete first. Ask "my cases" or "waiting for sign off" any time.', { label }),
  [TIER_OPERATOR]: (label) => vocabText('ui.role_welcome_operator', 'You are registered as {label}. You can work the queue from here: ask what needs attention, reply to a reporter, assign a case, or say "invite eco ranger" / "invite technician" to get a one-time code for a new team member. Signing a case off stays with the technician.', { label }),
}

const REFUSAL_DEFAULTS = {
  unknown: ['ui.role_refusal_unknown', 'That code was not recognised. Check it with the person who sent it and try again.'],
  expired: ['ui.role_refusal_expired', 'That code has expired. Ask for a new one.'],
  used: ['ui.role_refusal_used', 'That code has already been used. Ask for a new one.'],
  revoked: ['ui.role_refusal_revoked', 'That code is no longer valid. Ask for a new one.'],
  already: ['ui.role_refusal_already', 'You already have this role (or a higher one), so nothing changed.'],
  locked: ['ui.role_refusal_locked', 'Too many attempts. Please wait {wait} and try again.'],
  alone: ['ui.role_refusal_alone', 'That message has a registration code in it, so it was not used. To register, send the code on its own, with nothing else in the message.'],
}

function lockoutWait() {
  const hours = Math.round(ATTEMPT_WINDOW_MS / 3600e3)
  return hours === 1
    ? vocabText('ui.role_wait_one_hour', 'an hour')
    : vocabText('ui.role_wait_hours', '{hours} hours', { hours })
}

function refusal(reason) {
  const [key, fallback] = REFUSAL_DEFAULTS[reason] ? REFUSAL_DEFAULTS[reason] : REFUSAL_DEFAULTS.unknown
  return vocabText(key, fallback, { wait: lockoutWait() })
}

export async function tryRegisterByCode({ store, log, adapter, msg, channel, external_id, replyTo, platform, labels = TIER_LABELS }) {
  let code = extractCode(msg?.text)
  if (!code) { try { code = await issuedLooseCode(store, msg?.text) } catch { code = null } }
  const say = async (text) => {
    const reply = { to: replyTo, text, platform }
    try { await adapter?.send?.(reply) } catch (e) { log.error?.('[casey] role-registration reply failed', { channel, error: e.message }) }
    return { ...reply, registration: true }
  }
  if (!code) {

    let stripped = null
    try { stripped = await withoutIssuedCodes(store, msg?.text) } catch (e) { log.error?.('[casey] code redaction failed', { channel, error: e.message }) }
    if (stripped == null) return null
    const original = String(msg.text || '')
    msg.text = stripped
    if (msg.raw?.text && typeof msg.raw.text.body === 'string') msg.raw.text.body = stripped
    if (original.length <= 100) return say(refusal('alone'))
    return null
  }
  const key = `${channel}|${external_id}`
  if (attemptsExhausted(key)) return say(refusal('locked'))
  let outcome
  try {
    const contact = await store.findOrCreateContactLocked({
      channel, external_id, display_name: msg.profileName || msg.raw?.author?.username, handle: '',
    })
    outcome = await claimInvite(store, code, contact)
  } catch (e) {
    log.error?.('[casey] role-registration failed', { channel, error: e.message })
    return say('Sorry, I could not process that just now. Please send the code again in a minute.')
  }
  if (!outcome.ok) {
    if (outcome.reason === 'unknown') noteFailedAttempt(key)
    log.info?.('[casey] role code refused', { channel, reason: outcome.reason })
    return say(refusal(outcome.reason))
  }
  log.info?.('[casey] role registered by code', { channel, tier: outcome.tier })
  const label = tierLabel(outcome.tier, labels)
  return say((WELCOME[outcome.tier] || WELCOME[TIER_FIELD_WORKER])(label))
}
