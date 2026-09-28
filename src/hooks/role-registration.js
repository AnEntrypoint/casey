// hooks/role-registration.js -- the deterministic pre-agent intercept that turns
// a one-time invite code (src/role-invites.js) into a role for the sender's own
// phone number.
//
// It runs in hooks/inbound-turn.js AFTER admission and BEFORE any case is opened
// or any agent turn starts, and it only ever fires for a message that is nothing
// but a code (extractCode is strict). So the model never sees a code, cannot
// decide the outcome, and cannot be argued into a promotion; a failed guess opens
// no case and leaves no report row behind. The reply is fixed text, sent through
// the adapter directly -- the same reason the guaranteed fallback is fixed text.
//
// Every outcome is audited on the role-invites singleton log (claim on success;
// a failed attempt is counted in memory and rate-limited, and noted).

import { extractCode, claimInvite, attemptsExhausted, noteFailedAttempt, withoutIssuedCodes, issuedLooseCode } from '../role-invites.js'
import { TIER_LABELS } from '../store/report-shape.js'
import { TIER_FIELD_WORKER, TIER_ANIMAL_HEALTH_TECHNICIAN, TIER_OPERATOR, tierLabel } from '../contact-tiers.js'

// What each role can now do, in plain words a first-time user can act on. Fixed
// text on purpose: this is the moment a person learns what their phone is for.
const WELCOME = {
  [TIER_FIELD_WORKER]: (label) => `You are registered as ${label}. Message me the way you already do: describe what you see (animal, how many, where, what is wrong) and send photos or a voice note. Ask "my cases" or "what is open near me" any time. I will also record where you are if you share a location pin.`,
  [TIER_ANIMAL_HEALTH_TECHNICIAN]: (label) => `You are registered as ${label}. You can see and update your cases here, and you are the one who signs a case off as resolved once help has been given -- tell me when a case is done and I will check the record is complete first. Ask "my cases" or "waiting for sign off" any time.`,
  [TIER_OPERATOR]: (label) => `You are registered as ${label}. You can work the queue from here: ask what needs attention, reply to a reporter, assign a case, or say "invite eco ranger" / "invite technician" to get a one-time code for a new team member. Signing a case off stays with the technician.`,
}

const REFUSAL = {
  unknown: 'That code was not recognised. Check it with the person who sent it and try again.',
  expired: 'That code has expired. Ask for a new one.',
  used: 'That code has already been used. Ask for a new one.',
  revoked: 'That code is no longer valid. Ask for a new one.',
  already: 'You already have this role (or a higher one), so nothing changed.',
  locked: 'Too many attempts. Please wait an hour and try again.',
  alone: 'That message has a registration code in it, so it was not used. To register, send the code on its own, with nothing else in the message.',
}

// Returns the handled-result object for runInboundTurn to return, or null when
// the message is not a code (the normal turn then proceeds untouched).
export async function tryRegisterByCode({ store, log, adapter, msg, channel, external_id, replyTo, platform, labels = TIER_LABELS }) {
  let code = extractCode(msg?.text)
  if (!code) { try { code = await issuedLooseCode(store, msg?.text) } catch { code = null } }
  const say = async (text) => {
    const reply = { to: replyTo, text, platform }
    try { await adapter?.send?.(reply) } catch (e) { log.error?.('[casey] role-registration reply failed', { channel, error: e.message }) }
    return { ...reply, registration: true }
  }
  if (!code) {
    // A live code inside a longer message registers nobody, and must not be kept:
    // the text would land on a public timeline and in front of the model. Strip it;
    // a short message that was only an attempt at registering gets one plain hint
    // instead of an agent turn that would answer as if it were a report.
    let stripped = null
    try { stripped = await withoutIssuedCodes(store, msg?.text) } catch (e) { log.error?.('[casey] code redaction failed', { channel, error: e.message }) }
    if (stripped == null) return null
    const original = String(msg.text || '')
    msg.text = stripped
    if (msg.raw?.text && typeof msg.raw.text.body === 'string') msg.raw.text.body = stripped
    if (original.length <= 100) return say(REFUSAL.alone)
    return null
  }
  const key = `${channel}|${external_id}`
  if (attemptsExhausted(key)) return say(REFUSAL.locked)
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
    return say(REFUSAL[outcome.reason] || REFUSAL.unknown)
  }
  log.info?.('[casey] role registered by code', { channel, tier: outcome.tier })
  const label = tierLabel(outcome.tier, labels)
  return say((WELCOME[outcome.tier] || WELCOME[TIER_FIELD_WORKER])(label))
}
