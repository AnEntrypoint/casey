

import { defTool, str, slimCase } from './case-tools-shared.js'
import { parseReport, tagList } from './timestamp.js'
import { isOpenCase } from './format.js'
import { atLeast, TIER_FIELD_WORKER } from './contact-tiers.js'
import { publicAssignee } from './case-assignment.js'
import { OPTED_OUT_TAG } from './hooks/heuristics.js'
import { sendStaffMessage, staffLabel } from './hooks/staff-outbound.js'
import { AGENT_USER } from './case-store.js'
import { MANDATORY_MINIMUM_FIELDS, REPORT_ENTITY_LABEL, missingMandatoryMinimum, fieldLabel } from './store/report-shape.js'
import { evData } from './safe.js'
import { writeGate, recordedOn, setFocus } from './team-focus.js'
import { recordSeen } from './stale-write-guard.js'
import { NOT_ASSIGNED, doneStages, findCase, teamRow, actorData, stripSavedPaths, deskAuthorityOn, authorityOn, reporterExtras, maskNumberFields } from './case-tools-team-shared.js'
import { inSignOffQueue, withdrawHandoff, isHandedOff, sendBackToRanger } from './signoff-desk.js'
import { mergeTag } from './hooks/heuristics.js'
import { RANGER_NOTE, notesTagged } from './relay.js'

const NO_SUCH = { error: 'No such record. Ask for the reference again.' }
const REVIEW_EVENT_CAP = 60

const done = (c) => doneStages().includes(c.status)
const isComplete = (c) => missingMandatoryMinimum(parseReport(c)).length === 0

export const visibleToSignOffDesk = deskAuthorityOn

export async function signOffCandidates(store, ctx, { limit = 200 } = {}) {
  const open = (await store.listCases({}, { limit: 10000, offset: 0 })).filter(c => c.channel !== 'system' && isOpenCase(c) && !done(c))
  return open.filter(c => isComplete(c) && visibleToSignOffDesk(ctx, c) && (inSignOffQueue(c) || authorityOn(ctx, c) === 'assigned')).slice(0, limit)
}

async function lookup(store, ctx, ref, { gate = false } = {}) {
  const c = await findCase(store(), ref)
  if (!c) return { fail: NO_SUCH }
  const authority = visibleToSignOffDesk(ctx, c)
  if (!authority) return { fail: NOT_ASSIGNED }
  if (gate && authority === 'assigned') { const refused = await writeGate(store(), ctx, c); if (refused) return { fail: refused } }
  return { c, authority, on: await recordedOn(store(), c, ctx) }
}

export function buildTeamReviewTools(store) {
  return [
    defTool('signoff_queue', 'cases',
      `The sign-off queue: open ${REPORT_ENTITY_LABEL}s that already hold every required fact${MANDATORY_MINIMUM_FIELDS.length ? '' : ' (no required-fact list is configured, so every open one counts)'} and are not yet finished, that a ranger has handed over, that nobody holds, or that are assigned to this person. Call it when they ask what is ready to finish or what needs their sign-off. Listing a record does not finish it.`,
      { type: 'object', properties: { limit: { type: 'number', default: 15 } } },
      async ({ limit = 15 }, ctx) => {
        const rows = await signOffCandidates(store(), ctx)
        rows.sort((a, b) => (Number(a.last_event_at) || 0) - (Number(b.last_event_at) || 0))
        const n = Math.min(Math.max(Number(limit) || 15, 1), 50)
        const { extra: who } = await reporterExtras(store(), rows.slice(0, n))
        const notes = new Map()
        for (const c of rows.slice(0, n)) notes.set(c.id, notesTagged(await store().listEvents(c.id), RANGER_NOTE))
        const noteOf = (c) => (notes.get(c.id).length ? { ranger_notes: notes.get(c.id).length, latest_ranger_note: notes.get(c.id)[0].text } : {})
        return { total: rows.length, shown: Math.min(rows.length, n), cases: rows.slice(0, n).map(c => teamRow(c, ctx, { reporter_asked_us_to_stop: tagList(c).includes(OPTED_OUT_TAG), ...who(c), ...noteOf(c) })) }
      }),
    defTool('case_review', 'cases',
      'Review ONE record in full before acting on it: every recorded fact, which required ones are missing, the timeline, and the photo and voice-note entries (with the voice-note transcripts). The photo entries here are notes only; to show the actual photos use case_photos. For records assigned to this person or unassigned.',
      { type: 'object', properties: { case: str('Record reference or id') }, required: ['case'] },
      async ({ case: ref }, ctx) => {
        const r = await lookup(store, ctx, ref); if (r.fail) return r.fail
        const { c } = r

        if (ctx?.contact?.id && (ctx.inboundRefs || []).length === 1 && ctx.inboundRefs[0] === String(c.ref).toUpperCase()) await setFocus(store(), ctx.contact.id, c)
        await recordSeen(store(), ctx?.contact?.id, c)
        const events = (await store().listEvents(c.id)).filter(e => !(e.kind === 'observation' && evData(e).announced_to))
        const slim = slimCase(c)
        if (slim.report) {
          slim.report = maskNumberFields(slim.report)
          for (const k of ['photos', 'audio']) if (slim.report[k]) slim.report[k] = stripSavedPaths(slim.report[k])
        }
        slim.assignee = publicAssignee(c.assignee, ctx.contact) || null
        return {
          recorded_on: r.on,
          case: slim,
          required_missing: missingMandatoryMinimum(parseReport(c)).map(fieldLabel),
          ready_for_signoff: isComplete(c) && !done(c),
          ranger_notes: notesTagged(events, RANGER_NOTE),
          reporter_asked_us_to_stop: tagList(c).includes(OPTED_OUT_TAG),
          timeline: events.slice(-REVIEW_EVENT_CAP).map(e => ({ kind: e.kind, actor: e.actor, at: e.created_at, text: stripSavedPaths(e.text).slice(0, 600) })),
          timeline_total: events.length,
        }
      }),
    defTool('case_reopen', 'cases',
      'Reopen a FINISHED record so work can continue (it goes back to in progress). Use when new information arrives after sign-off or it was finished by mistake. Give the reason.',
      { type: 'object', properties: { case: str('Record reference or id'), reason: str('Why it is being reopened') }, required: ['case', 'reason'] },
      async ({ case: ref, reason }, ctx) => {
        const r = await lookup(store, ctx, ref, { gate: true }); if (r.fail) return r.fail
        const { c } = r
        if (!done(c)) return { error: 'That record is not finished, so there is nothing to reopen.' }
        const by = staffLabel(ctx.contact)

        const user = AGENT_USER
        const steps = c.status === 'closed' ? ['resolved', 'in_progress'] : ['in_progress']
        try { for (const to of steps) await store().transition(c.id, to, { user, reason: `${by}: reopened -- ${String(reason).slice(0, 300)}` }) }
        catch (e) { return { error: `Could not reopen it: ${e.message}` } }
        await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text: `REOPENED by ${by}: ${String(reason).slice(0, 500)}`, data: actorData(ctx) })
        return { ok: true, recorded_on: r.on, ref: c.ref, reopened_to: 'in_progress' }
      }),
    defTool('case_ask_ranger', 'cases',
      'Ask the field worker who filed a record for a missing fact, by WhatsApp through the assistant\'s number. Only when the person who filed it is a field worker; a member of the public is asked by the assistant itself, so for a record a ranger handed over this instead sends it back to that ranger with your text as the question (nothing is sent to anyone). Omit `text` and the missing required facts are asked for. Refused, and says so, if they asked us to stop or last wrote more than 24 hours ago.',
      { type: 'object', properties: { case: str('Record reference or id'), text: str('Optional: what to ask, in their language') }, required: ['case'] },
      async ({ case: ref, text }, ctx) => {
        const r = await lookup(store, ctx, ref, { gate: true }); if (r.fail) return r.fail
        const { c } = r
        let reporter = null
        try { reporter = c.contact_id ? await store().getContact(c.contact_id) : null } catch { reporter = null }
        if (!atLeast(reporter?.tier, TIER_FIELD_WORKER)) {

          if (isHandedOff(c)) {
            const back = await sendBackToRanger(store(), c.id, { by: staffLabel(ctx.contact), user: AGENT_USER, text: String(text || '').trim(), data: actorData(ctx) })
            return back.ok ? { ok: true, sent_back_to_the_ranger: true, delivered: false, recorded_on: r.on, taken_off_the_sign_off_desk: true } : { error: back.error }
          }
          return { error: 'The person who filed this is a member of the public, not a field worker, so the assistant asks them itself. Do not message them from here.' }
        }
        const missing = missingMandatoryMinimum(parseReport(c)).map(fieldLabel)
        const body = String(text || '').trim() || (missing.length
          ? `Hello -- about the ${REPORT_ENTITY_LABEL} ${c.ref}: could you tell us ${missing.join(', ')}? Thank you.`
          : `Hello -- about the ${REPORT_ENTITY_LABEL} ${c.ref}: is there anything more you can add? Thank you.`)
        const sent = await sendStaffMessage({
          store: store(), sendReply: ctx?.sendReply, canSend: ctx?.canSend, caseRow: c, text: body,
          staff: { ...(ctx.contact || {}), tier: ctx.tier }, claim: false, answers: false, extra: { asked_missing: true },
        })
        if (!sent.ok) return { ok: false, delivered: false, recorded_on: r.on, error: sent.error }

        const back = await withdrawHandoff(store(), c.id, { by: staffLabel(ctx.contact), user: AGENT_USER, reason: 'more information asked for', data: actorData(ctx) })
        if (back.was) { const fresh = await store().getCase(c.id); await store().updateCase(c.id, { tags: mergeTag(fresh.tags || '', 'sent-back') }, AGENT_USER) }
        return { ok: true, delivered: true, recorded_on: r.on, asked_for: missing, ...(back.was ? { taken_off_the_sign_off_desk: true } : {}) }
      }),
  ]
}
