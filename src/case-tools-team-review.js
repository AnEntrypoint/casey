

import { visibleToolName } from './config-loader.js'
import { defTool, str, slimCase } from './case-tools-shared.js'
import { parseReport, tagList } from './timestamp.js'
import { isOpenCase } from './format.js'
import { atLeast, TIER } from './contact-tiers.js'
import { publicAssignee } from './case-assignment.js'
import { OPTED_OUT_TAG } from './hooks/heuristics.js'
import { sendStaffMessage, staffLabel } from './hooks/staff-outbound.js'
import { AGENT_USER } from './case-store.js'
import { MANDATORY_MINIMUM_FIELDS, REPORT_ENTITY_LABEL, missingMandatoryMinimum, fieldLabel } from './store/report-shape.js'
import { evData } from './safe.js'
import { writeGate, recordedOn, setFocus } from './team-focus.js'
import { recordSeen } from './stale-write-guard.js'
import { NOT_ASSIGNED, doneStages, findCase, teamRow, actorData, stripSavedPaths, deskAuthorityOn, authorityOn, reporterExtras, maskNumberFields } from './case-tools-team-shared.js'
import { inSignOffQueue, withdrawHandoff, isHandedOff, sendBackToResponder } from './signoff-desk.js'
import { mergeTag } from './hooks/heuristics.js'
import { FIELD_NOTE, notesTagged } from './relay.js'
import { caseyText } from './deployment-text.js';

const NO_SUCH = { error: caseyText("src/case-tools-team-review.js#0") }
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
      caseyText("src/case-tools-team-review.js#1", [REPORT_ENTITY_LABEL, MANDATORY_MINIMUM_FIELDS.length ? '' : caseyText("src/case-tools-team-review.js#2")]),
      { type: 'object', properties: { limit: { type: 'number', default: 15 } } },
      async ({ limit = 15 }, ctx) => {
        const rows = await signOffCandidates(store(), ctx)
        rows.sort((a, b) => (Number(a.last_event_at) || 0) - (Number(b.last_event_at) || 0))
        const n = Math.min(Math.max(Number(limit) || 15, 1), 50)
        const { extra: who } = await reporterExtras(store(), rows.slice(0, n))
        const notes = new Map()
        for (const c of rows.slice(0, n)) notes.set(c.id, notesTagged(await store().listEvents(c.id), FIELD_NOTE))
        const noteOf = (c) => (notes.get(c.id).length ? { ranger_notes: notes.get(c.id).length, latest_ranger_note: notes.get(c.id)[0].text } : {})
        return { total: rows.length, shown: Math.min(rows.length, n), cases: rows.slice(0, n).map(c => teamRow(c, ctx, { reporter_asked_us_to_stop: tagList(c).includes(OPTED_OUT_TAG), ...who(c), ...noteOf(c) })) }
      }),
    defTool('case_review', 'cases',
      caseyText("src/case-tools-team-review.js#3"),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-team-review.js#s0")) }, required: ['case'] },
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
          ranger_notes: notesTagged(events, FIELD_NOTE),
          reporter_asked_us_to_stop: tagList(c).includes(OPTED_OUT_TAG),
          timeline: events.slice(-REVIEW_EVENT_CAP).map(e => ({ kind: e.kind, actor: e.actor, at: e.created_at, text: stripSavedPaths(e.text).slice(0, 600) })),
          timeline_total: events.length,
        }
      }),
    defTool('case_reopen', 'cases',
      caseyText("src/case-tools-team-review.js#4"),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-team-review.js#s1")), reason: str(caseyText("src/case-tools-team-review.js#s2")) }, required: ['case', 'reason'] },
      async ({ case: ref, reason }, ctx) => {
        const r = await lookup(store, ctx, ref, { gate: true }); if (r.fail) return r.fail
        const { c } = r
        if (!done(c)) return { error: caseyText("src/case-tools-team-review.js#5") }
        const by = staffLabel(ctx.contact)

        const user = AGENT_USER
        const steps = c.status === 'closed' ? ['resolved', 'in_progress'] : ['in_progress']
        try { for (const to of steps) await store().transition(c.id, to, { user, reason: `${by}: reopened -- ${String(reason).slice(0, 300)}` }) }
        catch (e) { return { error: caseyText("src/case-tools-team-review.js#s3", [e.message]) } }
        await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text: caseyText("src/case-tools-team-review.js#s4", [by, String(reason).slice(0, 500)]), data: actorData(ctx) })
        return { ok: true, recorded_on: r.on, ref: c.ref, reopened_to: 'in_progress' }
      }),
    defTool(visibleToolName('case_ask_specialist'), 'cases',
      caseyText("src/case-tools-team-review.js#6"),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-team-review.js#s5")), text: str(caseyText("src/case-tools-team-review.js#7")) }, required: ['case'] },
      async ({ case: ref, text }, ctx) => {
        const r = await lookup(store, ctx, ref, { gate: true }); if (r.fail) return r.fail
        const { c } = r
        let reporter = null
        try { reporter = c.contact_id ? await store().getContact(c.contact_id) : null } catch { reporter = null }
        if (!atLeast(reporter?.tier, TIER.field)) {

          if (isHandedOff(c)) {
            const back = await sendBackToResponder(store(), c.id, { by: staffLabel(ctx.contact), user: AGENT_USER, text: String(text || '').trim(), data: actorData(ctx) })
            return back.ok ? { ok: true, sent_back_to_the_ranger: true, delivered: false, recorded_on: r.on, taken_off_the_sign_off_desk: true } : { error: back.error }
          }
          return { error: caseyText("src/case-tools-team-review.js#8") }
        }
        const missing = missingMandatoryMinimum(parseReport(c)).map(fieldLabel)
        const body = String(text || '').trim() || (missing.length
          ? caseyText("src/case-tools-team-review.js#9", [REPORT_ENTITY_LABEL, c.ref, missing.join(', ')])
          : caseyText("src/case-tools-team-review.js#10", [REPORT_ENTITY_LABEL, c.ref]))
        const sent = await sendStaffMessage({
          store: store(), sendReply: ctx?.sendReply, canSend: ctx?.canSend, caseRow: c, text: body,
          staff: { ...(ctx.contact || {}), tier: ctx.tier }, claim: false, answers: false, extra: { asked_missing: true },
        })
        if (!sent.ok) return { ok: false, delivered: false, recorded_on: r.on, error: sent.error }

        const back = await withdrawHandoff(store(), c.id, { by: staffLabel(ctx.contact), user: AGENT_USER, reason: caseyText("src/case-tools-team-review.js#s6"), data: actorData(ctx) })
        if (back.was) { const fresh = await store().getCase(c.id); await store().updateCase(c.id, { tags: mergeTag(fresh.tags || '', 'sent-back') }, AGENT_USER) }
        return { ok: true, delivered: true, recorded_on: r.on, asked_for: missing, ...(back.was ? { taken_off_the_sign_off_desk: true } : {}) }
      }),
  ]
}
