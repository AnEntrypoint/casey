

import { extractCode, claimInvite, attemptsExhausted, noteFailedAttempt, withoutIssuedCodes, issuedLooseCode, ATTEMPT_WINDOW_MS } from '../role-invites.js'
import { TIER_LABELS } from '../store/report-shape.js'
import { tierLabel, TIER } from '../contact-tiers.js'
import { vocabText } from '../config-loader.js'
import { caseyText } from '../deployment-text.js';

const WELCOME = {
  [TIER.field]: (label) => vocabText('ui.role_welcome_field_worker', caseyText("src/hooks/role-registration.js#0"), { label }),
  [TIER.specialist]: (label) => vocabText('ui.role_welcome_technician', caseyText("src/hooks/role-registration.js#1"), { label }),
  [TIER.operator]: (label) => vocabText('ui.role_welcome_operator', caseyText("src/hooks/role-registration.js#2"), { label }),
}

const REFUSAL_DEFAULTS = {
  unknown: ['ui.role_refusal_unknown', caseyText("src/hooks/role-registration.js#3")],
  expired: ['ui.role_refusal_expired', caseyText("src/hooks/role-registration.js#4")],
  used: ['ui.role_refusal_used', caseyText("src/hooks/role-registration.js#5")],
  revoked: ['ui.role_refusal_revoked', caseyText("src/hooks/role-registration.js#6")],
  already: ['ui.role_refusal_already', caseyText("src/hooks/role-registration.js#7")],
  locked: ['ui.role_refusal_locked', caseyText("src/hooks/role-registration.js#8")],
  alone: ['ui.role_refusal_alone', caseyText("src/hooks/role-registration.js#9")],
}

function lockoutWait() {
  const hours = Math.round(ATTEMPT_WINDOW_MS / 3600e3)
  return hours === 1
    ? vocabText('ui.role_wait_one_hour', caseyText("src/hooks/role-registration.js#s0"))
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
    return say(caseyText("src/hooks/role-registration.js#10"))
  }
  if (!outcome.ok) {
    if (outcome.reason === 'unknown') noteFailedAttempt(key)
    log.info?.('[casey] role code refused', { channel, reason: outcome.reason })
    return say(refusal(outcome.reason))
  }
  log.info?.('[casey] role registered by code', { channel, tier: outcome.tier })
  const label = tierLabel(outcome.tier, labels)
  return say((WELCOME[outcome.tier] || WELCOME[TIER.field])(label))
}
