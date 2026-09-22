// hooks/operator-reminder.js  --  the OPERATOR-INITIATED nudge: one real
// outbound message asking a specific contact who has gone quiet to come back and
// say what happened.
//
// WHAT ALREADY EXISTED AND WHY THIS IS NOT IT. casey already NOTICES silence:
// case-health.js raises `stale`, `unanswered_handoff` and
// `unanswered_handoff_escalated`, case-sweep.js tags the case, attn.js ranks it,
// and the coverage-gap detector pages the team when nobody is covering. Every one
// of those is PASSIVE and OPERATOR-FACING -- it tells the team a report has gone
// quiet, and then waits for a human. Nothing in casey ever reached back out to
// the person who went quiet. That is the gap this fills, and it is the operator's
// own half of the three-role model: the operator keeps in touch with the animal
// health side and reminds the eco rangers, the technicians and the public to
// report back when communication drops.
//
// WHAT IT IS NOT. It is not an automatic chase, and nothing here runs on a timer:
// every send is one operator pressing one button on one report they have looked
// at, attributed to them by name in the audit trail. A sweep that nudged people
// on its own would be casey originating contact on its own judgement, which no
// other path in this system does.
//
// THE SEND IS THE EXISTING SEND. It goes through the same
// `sendReply(caseRow, text)` seam the dashboard's operator reply and
// draft-approve already use, which resolves the real channel adapter through
// hooks/delivery.js's resolveAdapter. There is deliberately no second outbound
// mechanism: a reminder that could reach a contact by a route the reply path
// cannot is a reminder whose delivery failures look different from every other
// outbound in the timeline.

import { tagList, tsMs } from '../timestamp.js'
import { OPTED_OUT_TAG } from './heuristics.js'
import { withinSessionWindow, sessionWindowHours } from './notifiers.js'
import { BREACH_LABEL } from '../case-health.js'
import { evData } from '../safe.js'
import { REPORT_ENTITY_LABEL } from '../store/report-shape.js'

// Same product-level cap the sibling text routes in dashboard/routes/cases.js
// enforce on an operator-supplied string.
export const REMINDER_MAX_LEN = 4000

// The machine flag on the outbound event's `data`. The audit trail has to be able
// to answer "was this the agent talking or a person pressing a button", and
// `actor: 'operator'` alone does not distinguish a reminder from an operator's
// own typed reply -- both are operator outbounds. This flag is what separates
// them, and it is why the timeline can say "reminder sent by <operator>" rather
// than presenting a system-composed sentence as something a human wrote.
export const OPERATOR_REMINDER_FLAG = 'operator_reminder'

function hoursSince(ms) {
  const h = ms / 3600e3
  if (h < 1) return `${Math.round(ms / 60e3)} minutes`
  if (h < 48) return `${Math.round(h)} hours`
  return `${Math.round(h / 24)} days`
}

// Below this, the message simply does not mention how long it has been.
//
// Live-witnessed: a reminder sent moments after the contact's own message read
// "We have not heard from you in about 0 minutes", which is arithmetically true
// and reads as a machine talking. The clause exists to be HONEST about a real
// silence; there is no real silence to be honest about yet, so the honest move is
// to leave it out rather than to round it into a number. An operator may still
// legitimately send the message then -- the ask itself still makes sense -- so
// this suppresses the clause, never the send.
const QUIET_WORTH_MENTIONING_MS = 15 * 60e3

// The last thing the contact themselves said, and when. `recent` is the newest-
// first event page the caller already loaded, so this costs no extra read.
function lastInbound(recent) {
  return (recent || []).find(e => e.kind === 'inbound') || null
}

function priorReminder(recent) {
  return (recent || []).find(e => e.kind === 'outbound' && !!evData(e)[OPERATOR_REMINDER_FLAG]) || null
}

// THE REMINDER TEXT.
//
// Warm, honest, short, and it names only things that are actually true: their
// own reference, how long it has genuinely been since they last wrote, and one
// plain invitation to say what has happened since. It invents no context about
// the animals, claims no progress on casey's side, and asks for nothing
// specific -- an operator nudging a silent contact does not know which fact is
// missing, and guessing one would put words in the team's mouth.
//
// It carries none of the internal vocabulary the system prompt forbids the agent
// (case, ticket, triage, status, priority, workflow, escalate, transition,
// autonomy -- prompt-sections.js's list, kept equal to reply-judge.js's): this
// text reaches a contact through the same channel the agent's replies do, and a
// person reading "your case status" learns nothing and is told they are a ticket.
// The plain word for the thing comes from the deployment's own
// `entity_label` (report-fields.yml), never hardcoded here.
//
// ENGLISH ONLY, and this is a real limitation rather than an oversight: AGENTS.md
// forbids a hardcoded per-language template anywhere in casey, and the honest way
// to reach a contact in their own language is the real agent turn, which this
// path deliberately does not run (an operator pressing a button must know exactly
// what is about to be sent). stageNote in heuristics.js carries the same
// limitation for the same reason. An operator who knows the contact writes in
// isiXhosa passes their own text instead -- which is what the override exists for.
export function composeReminderText(caseRow, { quietForMs = null, breaches = [] } = {}) {
  const ref = caseRow?.ref ? ` (${caseRow.ref})` : ''
  const quiet = Number.isFinite(quietForMs) && quietForMs >= QUIET_WORTH_MENTIONING_MS
    ? ` We have not heard from you in about ${hoursSince(quietForMs)}.`
    : ''
  // The plain-language reason, taken from case-health.js's own operator-facing
  // phrasing rather than a second table -- but only when the breach genuinely
  // describes the SILENCE. A reminder that told somebody their report "has
  // visit-critical facts still missing" would be naming casey's own internal
  // completeness bookkeeping at a person who cannot see it.
  const silence = breaches.find(b => b === 'stale' || b === 'unanswered_handoff' || b === 'unanswered_handoff_escalated')
  const because = silence && !quiet ? ` This ${REPORT_ENTITY_LABEL} ${BREACH_LABEL[silence]}.` : ''
  // No self-identification beyond "us": this arrives on the same thread the
  // person has already been talking on, so they know who is writing, and naming
  // a team here would mean hardcoding one deployment's domain vocabulary into
  // casey's source -- exactly what report-fields.yml's entity_label exists to
  // avoid. The one domain word in this sentence comes from config.
  return `Hello -- this is about the ${REPORT_ENTITY_LABEL} you sent us${ref}.${quiet}${because}`
    + ` If anything has changed, or if there is anything more you can tell us, please reply here and let us know.`
    + ` If there is nothing to add, that is also worth knowing -- just say so.`
}

// May casey originate a message to this contact right now, and what would it say.
//
// Returns `{ ok: true, text, quietForMs, breaches }` or
// `{ ok: false, status, error }` -- an HTTP status and a sentence the operator
// reads, never a silent no-op. Every refusal here is a decision an operator
// should see the reason for: they are about to contact a real person and the
// reasons not to (this one asked to be left alone; this channel will reject the
// send; you already nudged them) are exactly the ones a button cannot know.
//
// `overrideText` is the operator's own words when they supplied them. It skips
// composition but NOT the guards: opting out and the platform's reply window are
// properties of the contact and the channel, not of who wrote the sentence.
export async function prepareReminder({ store, caseRow, overrideText = null, now = Date.now() }) {
  if (!caseRow) return { ok: false, status: 404, error: 'not found' }
  // A report that is already finished has nothing to report back about, and a
  // nudge on one reads to the contact as though the team has lost track of it.
  if (caseRow.status === 'resolved' || caseRow.status === 'closed') {
    return { ok: false, status: 409, error: `this ${REPORT_ENTITY_LABEL} is already finished -- reopen it first if you need to ask them something` }
  }
  // STOP means stop. The contact asked not to be contacted, and an
  // operator-initiated nudge is exactly the thing they asked not to receive --
  // the same guard makeTransitionNotifier holds, for the same reason.
  if (tagList(caseRow).includes(OPTED_OUT_TAG)) {
    return { ok: false, status: 409, error: 'this person asked us not to message them again, so nothing was sent' }
  }
  let recent = []
  try {
    recent = await store.listEventsPage(caseRow.id, { limit: 25, offset: 0 })
  } catch (e) {
    // The guards below are the whole point of this function, so a failed read is
    // a refusal rather than a permission: sending blind would mean sending
    // without knowing whether they were nudged an hour ago.
    return { ok: false, status: 503, error: `could not read this ${REPORT_ENTITY_LABEL}'s history, so nothing was sent: ${e.message}` }
  }
  if (!withinSessionWindow(caseRow, recent, now)) {
    return {
      ok: false, status: 409,
      error: `this person last wrote more than ${sessionWindowHours()}h ago, outside WhatsApp's free reply window -- the message would be rejected rather than delivered. Reach them another way if it cannot wait.`,
    }
  }
  // ONE NUDGE PER SILENCE. Without this an operator double-clicking, or two
  // operators looking at the same queue, sends two or three real messages to
  // somebody whose animals are dying. The test is "has the contact said anything
  // since the last reminder" rather than a cooldown clock, because that is the
  // actual question: a person who has answered may be nudged again about the new
  // silence, and a person who has not has already been asked.
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
    : composeReminderText(caseRow, { quietForMs, breaches })
  if (text.length > REMINDER_MAX_LEN) return { ok: false, status: 413, error: `text too long (max ${REMINDER_MAX_LEN})` }
  return { ok: true, text, quietForMs, breaches, operator_authored: !!(overrideText && String(overrideText).trim()) }
}
