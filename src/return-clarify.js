// return-clarify.js -- a person comes back to a report that is already complete.
//
// When a public number writes again after a gap (CASEY_RETURN_CLARIFY_MS, default one hour) and the report the turn is bound to
// already holds the whole mandatory minimum, the assistant must not guess: its reply asks, as its one question, whether this is
// MORE about that report or a NEW problem, and, because nobody on that number is a registered team member, who is writing.
// Until they answer, case_report and case_new write nothing (the same gate shape as phone-consent.js). The answer is recorded by
// case_clarify (case-tools-clarify.js), which also records who is writing, in the one call.
//
// State is two observations on the case: `return_pending` (written at ingress when a return is detected, deduplicated by the
// message id) and `return_clarified` (written by the tool); a return is owed while the newest pending has no clarified after it.
// A registered team member (field_worker and above) is never asked.

import { evData } from './safe.js'
import { parseReport, tsMs } from './timestamp.js'
import { MANDATORY_MINIMUM_FIELDS, missingMandatoryMinimum } from './store/report-shape.js'
import { isDone } from './signoff-desk.js'
import { resolveContactTier, atLeast, TIER_FIELD_WORKER } from './contact-tiers.js'
import { speakerState } from './phone-persons.js'

export const returnGapMs = () => Number(process.env.CASEY_RETURN_CLARIFY_MS) || 3600e3
export const returnManaged = () => MANDATORY_MINIMUM_FIELDS.length > 0

// A report is "filled" when every mandatory fact is recorded (and the deployment declares a minimum at all).
export function isFilled(caseRow) {
  if (!returnManaged()) return false
  const r = parseReport(caseRow)
  return !!r && Object.keys(r).length > 0 && missingMandatoryMinimum(r).length === 0
}

const isTeam = (contact) => atLeast(resolveContactTier(contact), TIER_FIELD_WORKER)

// Called at ingress for every public inbound: writes `return_pending` when this message comes after a gap on a filled, open report.
export async function noteReturn(store, { caseRow, events, contact, msgId }) {
  try {
    if (!returnManaged() || !caseRow || !contact || isTeam(contact) || isDone(caseRow) || !isFilled(caseRow)) return false
    const list = events || await store.listEvents(caseRow.id)
    if (msgId && list.some(e => e.kind === 'observation' && evData(e).return_pending === true && evData(e).return_msg === msgId)) return false
    const talk = list.filter(e => e.kind === 'inbound' || e.kind === 'outbound')
    const inbound = talk.filter(e => e.kind === 'inbound')
    const last = inbound[inbound.length - 1]
    if (!last) return false
    const lastMs = tsMs(last.created_at)
    const before = talk.filter(e => tsMs(e.created_at) < lastMs || (tsMs(e.created_at) === lastMs && e !== last && talk.indexOf(e) < talk.indexOf(last)))
    const prev = before[before.length - 1]
    if (!prev) return false
    if (lastMs - tsMs(prev.created_at) < returnGapMs()) return false
    await store.appendEvent(caseRow.id, {
      kind: 'observation', actor: 'system',
      text: 'RETURNED: this complete report was written to again after a gap; the person is asked whether it is about that report or a new one, and who is writing',
      data: { return_pending: true, return_msg: msgId || '' }, touch: false,
    })
    return true
  } catch { return false }
}

// { owed, species, location, person } for the turn's bound case. `owed` is false for a team member and for a finished report.
export async function returnState(store, caseRow, contact, { events = null } = {}) {
  const none = { owed: false }
  try {
    if (!returnManaged() || !caseRow || !contact || isTeam(contact) || isDone(caseRow)) return none
    const list = events || await store.listEvents(caseRow.id)
    let pendingAt = -1
    list.forEach((e, i) => { if (e.kind === 'observation' && evData(e).return_pending === true) pendingAt = i })
    if (pendingAt < 0) return none
    if (list.slice(pendingAt + 1).some(e => e.kind === 'observation' && evData(e).return_clarified)) return none
    const r = parseReport(caseRow) || {}
    const sp = await speakerState(store, contact.id).catch(() => null)
    const person = r.reported_by || sp?.current?.name || sp?.previous?.name || sp?.people?.[0]?.name || null
    return { owed: true, species: r.species || '', location: r.location || '', person }
  } catch { return none }
}

export async function recordClarified(store, caseId, sameReport) {
  await store.appendEvent(caseId, {
    kind: 'observation', actor: 'system',
    text: sameReport ? 'return: they said it is more about this report' : 'return: they said it is a new problem',
    data: { return_clarified: sameReport ? 'same' : 'new' }, touch: false,
  })
}

// The refusal a write tool hands back while a return is owed, or null. Public contacts only; `ctx` is the tool context.
export async function returnGate(store, ctx) {
  try {
    const boundId = ctx?.activeCaseBinding?.id || ctx?.activeCaseId
    if (!boundId || !ctx?.contact?.id) return null
    const st = await returnState(store, await store.getCase(boundId), ctx.contact)
    if (!st.owed) return null
    return { held: true, nothing_recorded: true, note: 'Nothing was recorded, so never say or imply that anything was noted. This person has come back to a report that is already complete. In THIS reply, as your one question, ask in their language whether it is more about that report or a new problem (name the report in a few words: the animals and the place), and who is writing' + (st.person ? ` (is it ${st.person}?)` : '') + '. When they answer, call case_clarify, then record.' }
  } catch { return null }
}
