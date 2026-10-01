

import { tagList, tsMs } from '../timestamp.js'
import { OPTED_OUT_TAG } from './heuristics.js'
import { withinSessionWindow, sessionWindowHours } from './notifiers.js'
import { BREACH_LABEL } from '../case-health.js'
import { evData } from '../safe.js'
import { REPORT_ENTITY_LABEL } from '../store/report-shape.js'
import { proactiveRefusal } from '../proactive-sends.js'
import { reporterFirstName } from '../phone-persons.js'

export const REMINDER_MAX_LEN = 4000

export const OPERATOR_REMINDER_FLAG = 'operator_reminder'

function hoursSince(ms) {
  const h = ms / 3600e3
  if (h < 1) return `${Math.round(ms / 60e3)} minutes`
  if (h < 48) return `${Math.round(h)} hours`
  return `${Math.round(h / 24)} days`
}

const QUIET_WORTH_MENTIONING_MS = 15 * 60e3

function lastInbound(recent) {
  return (recent || []).find(e => e.kind === 'inbound') || null
}

function priorReminder(recent) {
  return (recent || []).find(e => e.kind === 'outbound' && !!evData(e)[OPERATOR_REMINDER_FLAG]) || null
}

export function composeReminderText(caseRow, { quietForMs = null, breaches = [], name = '' } = {}) {
  const ref = caseRow?.ref ? ` (${caseRow.ref})` : ''
  const quiet = Number.isFinite(quietForMs) && quietForMs >= QUIET_WORTH_MENTIONING_MS
    ? ` We have not heard from you in about ${hoursSince(quietForMs)}.`
    : ''

  const silence = breaches.find(b => b === 'stale' || b === 'unanswered_handoff' || b === 'unanswered_handoff_escalated')
  const because = silence && !quiet ? ` This ${REPORT_ENTITY_LABEL} ${BREACH_LABEL[silence]}.` : ''

  return `Hello${name ? ` ${name}` : ''} -- this is about the ${REPORT_ENTITY_LABEL} you sent us${ref}.${quiet}${because}`
    + ` If anything has changed, or if there is anything more you can tell us, please reply here and let us know.`
    + ` If there is nothing to add, that is also worth knowing -- just say so.`
}

export async function prepareReminder({ store, caseRow, overrideText = null, now = Date.now() }) {
  if (!caseRow) return { ok: false, status: 404, error: 'not found' }
  const noStart = proactiveRefusal({ kind: 'message' })
  if (noStart) return { ok: false, status: 409, error: noStart }

  if (caseRow.status === 'resolved' || caseRow.status === 'closed') {
    return { ok: false, status: 409, error: `this ${REPORT_ENTITY_LABEL} is already finished -- reopen it first if you need to ask them something` }
  }

  if (tagList(caseRow).includes(OPTED_OUT_TAG)) {
    return { ok: false, status: 409, error: 'this person asked us not to message them again, so nothing was sent' }
  }
  let recent = []
  try {
    recent = await store.listEventsPage(caseRow.id, { limit: 25, offset: 0 })
  } catch (e) {

    return { ok: false, status: 503, error: `could not read this ${REPORT_ENTITY_LABEL}'s history, so nothing was sent: ${e.message}` }
  }
  if (!withinSessionWindow(caseRow, recent, now)) {
    return {
      ok: false, status: 409,
      error: `this person last wrote more than ${sessionWindowHours()}h ago, outside WhatsApp's free reply window -- the message would be rejected rather than delivered. Reach them another way if it cannot wait.`,
    }
  }

  const prior = priorReminder(recent)
  if (prior) {
    const priorAt = tsMs(prior.created_at)
    const inbound = lastInbound(recent)
    const inboundAt = inbound ? tsMs(inbound.created_at) : null
    const answered = Number.isFinite(priorAt) && Number.isFinite(inboundAt) && inboundAt > priorAt
    if (!answered) {
      return {
        ok: false, status: 409,
        error: 'they have already been reminded and have not written back since, so nothing was sent again',
        reminded_at: prior.created_at,
      }
    }
  }
  const inbound = lastInbound(recent)
  const inboundAt = inbound ? tsMs(inbound.created_at) : null
  const quietForMs = Number.isFinite(inboundAt) ? Math.max(0, now - inboundAt) : null
  const breaches = tagList(caseRow).filter(t => t.startsWith('health:')).map(t => t.slice('health:'.length))
  const text = overrideText != null && String(overrideText).trim()
    ? String(overrideText).trim()
    : composeReminderText(caseRow, { quietForMs, breaches, name: await reporterFirstName(store, caseRow) })
  if (text.length > REMINDER_MAX_LEN) return { ok: false, status: 413, error: `text too long (max ${REMINDER_MAX_LEN})` }
  return { ok: true, text, quietForMs, breaches, operator_authored: !!(overrideText && String(overrideText).trim()) }
}
