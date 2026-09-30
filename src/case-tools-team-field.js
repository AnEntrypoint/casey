// case-tools-team-field.js  --  the field-team surface over WhatsApp: what an
// Eco Ranger (field_worker) or a technician does with the cases an operator has
// ASSIGNED to them. Composed, in a pinned order, by case-tools-team.js.
//
// The real-world flow these serve: the public reporter talks to the bot, the bot
// gathers what it can, an operator assigns the case, and then this person
// finishes the triage -- usually from their OWN phone with the reporter, or by
// telling the bot on the reporter's behalf. So the tools here are:
//
//   case_pending         what is waiting for me (assignments, replies, dispatches)
//   case_claim/_release  take an unassigned case / hand one back (bot resumes)
//   case_dispatch_reply  accept or decline a dispatch suggestion
//   case_gaps            exactly what is still missing + a reminder to copy
//   case_contact         the reporter's number, ASSIGNED cases only, audited
//   case_edit            record facts / notes on the reporter's behalf, attributed
//   case_stage           move an assigned case through the NON-done stages
//   case_message         message the reporter through the bot (window-limited)
//
// Every write is gated by authorityOn (case-tools-team-shared.js): the operator
// rung, or an assignee on their own assigned case. Everything else gets the one
// plain NOT_ASSIGNED sentence. None of these can finish a record.

import { defTool, str, pick, isValidLatLon } from './case-tools-shared.js'
import { REPORT_KEYS } from './case-store.js'
import { parseReport, tagList } from './timestamp.js'
import { isOpenCase, fmtPhone27 } from './format.js'
import { canSignOff, isOperator, atLeast, TIER_ANIMAL_HEALTH_TECHNICIAN } from './contact-tiers.js'
import { assigneeKeyFor, isAssignedTo, isOwnConversation, publicAssignee } from './case-assignment.js'
import { normalizeLocation } from './location-normalize.js'
import { OPTED_OUT_TAG, RESERVED_TAG, mergeTag, dropTag } from './hooks/heuristics.js'
import { sendStaffMessage, releaseCase, staffLabel } from './hooks/staff-outbound.js'
import { staffNotices, pendingDispatchesFor } from './staff-notices.js'
import { evData } from './safe.js'
import { reporterSummary } from './phone-persons.js'
import { refsIn, writeGate, recordedOn, identifyingLine, proposeFocus, confirmFocus, setFocus, focusOf, clearFocusForCase } from './team-focus.js'
import {
  APPEND_FIELDS, CRITICAL_FIELDS, REPORT_FIELD_DEFS, SYSTEM_SET_FIELDS, REPORT_GEO_FIELD_DEFS, REPORT_ENTITY_LABEL,
  missingMandatoryMinimum, fieldLabel, SIGNOFF_DIAGNOSIS_FIELDS,
} from './store/report-shape.js'
import { UNCLAIMED_ASSIGNEE } from './case-store.js'
import { APPEND_FIELD_MAX_LEN } from './store/report-merge.js'
import { signOffCandidates } from './case-tools-team-review.js'
import {
  NOT_ASSIGNED, doneStages, findCase, authorityOn, deskAuthorityOn, storeUser, actorData, teamRow, cleanRelayed, reporterExtras,
} from './case-tools-team-shared.js'

const NO_SUCH = { error: 'No such record. Ask for the reference again.' }
const FINISHED = { error: 'That record is already finished, so it is not changed from here.' }
const empty = (v) => v == null || String(v).trim() === ''
// Tags the system owns. A team member records facts; they do not flip the
// machinery (opt-out, hand-off, draft and health flags are set by their own paths).
const staffOf = (ctx) => ({ ...(ctx?.contact || {}), tier: ctx?.tier })
const optedOut = (c) => tagList(c).includes(OPTED_OUT_TAG)
// Resolve a record for a team write. `gate` applies team-focus.js's writeGate to
// an assignee (an operator names the record explicitly and is not gated); every
// success carries recorded_on so the transcript shows what was touched.
const lookupTeamCase = async (store, ctx, ref, { gate = true } = {}) => {
  const c = await findCase(store(), ref)
  if (!c) return { fail: NO_SUCH }
  // deskAuthorityOn is authorityOn plus the technician's sign-off desk (unassigned and handed-over reports), so a technician can read and edit what is on their desk.
  const authority = deskAuthorityOn(ctx, c)
  if (!authority) return { fail: NOT_ASSIGNED }
  if (gate && authority === 'assigned') {
    const refused = writeGate(ctx, c)
    if (refused) return { fail: refused }
  }
  return { c, authority, on: await recordedOn(store(), c, ctx) }
}

export function buildTeamFieldTools(store, { priorityValues }) {
  return [
    defTool('case_pending', 'cases',
      'What is waiting for THIS team member: records assigned to them (with any that are newly assigned or where the reporter has answered since they last looked), dispatch suggestions to attend, and for each assigned record what facts are still missing. Call it when they ask what is new or what they should do, and whenever a note says something is waiting. Showing them marks the news as announced.',
      { type: 'object', properties: {} },
      async (_args, ctx) => {
        const n = await staffNotices(store(), ctx?.contact, { mark: true, tier: ctx?.tier })
        // On a shared phone each row says who gave the report and that the phone is shared (phone-persons.js).
        const { extra: who } = await reporterExtras(store(), [...n.handoffs, ...n.assigned, ...n.dispatches].map(x => x.c))
        return {
          counts: n.counts,
          ...(n.handoffs.length ? { handed_over_for_sign_off: n.handoffs.map(({ c }) => teamRow(c, ctx, { from_a_ranger: true, ...who(c) })) } : {}),
          assigned: n.assigned.map(({ c, flags }) => teamRow(c, ctx, {
            ...flags,
            still_missing: missingMandatoryMinimum(parseReport(c)).map(fieldLabel),
            reporter_asked_us_to_stop: optedOut(c),
            ...who(c),
          })),
          dispatches: n.dispatches.map(({ c, note }) => teamRow(c, ctx, { note, ...who(c) })),
        }
      }),
    defTool('case_claim', 'cases',
      'Take an unassigned open record for THIS team member (assign it to them) -- only one an operator has offered to them (see case_pending dispatches); anything else is refused, and they should ask an operator to assign it. Refuses one that is already with someone else.',
      { type: 'object', properties: { case: str('Record reference or id') }, required: ['case'] },
      async ({ case: ref }, ctx) => {
        const c0 = await findCase(store(), ref)
        if (!c0) return NO_SUCH
        if (!isOpenCase(c0)) return FINISHED
        const key = assigneeKeyFor(ctx?.contact)
        if (!key) return { error: 'Could not tell who you are on this conversation, so nothing was assigned.' }
        if (isOwnConversation(c0, ctx.contact)) return { error: 'That is this chat with the assistant, not a record to work on, so it is not assigned to you.' }
        // Two people taking the same unassigned record at the same moment must not both
        // be told yes: the read, the check and the write happen under one lock per record.
        return store()._withLock(`assign|${c0.id}`, async () => {
          const c = await store().getCase(c0.id)
          if (!c || !isOpenCase(c)) return FINISHED
          const current = String(c.assignee || '').trim()
          if (current === key) return { ok: true, ref: c.ref, note: 'Already assigned to you.' }
          if (current && current !== UNCLAIMED_ASSIGNEE) {
            return { error: 'That one is already with someone else. Ask an operator to move it if it should be yours.' }
          }
          // No self-service from the unassigned pool: a ranger or technician takes a record
          // only when an operator has offered it to THEM. An operator assigns freely.
          if (!isOperator(ctx.tier) && !(await pendingDispatchesFor(store(), ctx.contact, [c])).length) {
            return { error: 'That record has not been offered to you, so it is not yours to take. Ask an operator to assign it to you.' }
          }
          const by = staffLabel(ctx.contact)
          await store().updateCase(c.id, { assignee: key }, storeUser(ctx, isOperator(ctx.tier) ? 'operator' : 'assigned'))
          await store().appendEvent(c.id, { kind: 'action', actor: 'operator', text: `Claimed by ${by}`, data: actorData(ctx, { claimed_by: key, was: current || null }) })
          return { ok: true, ref: c.ref }
        })
      }),
    defTool('case_release', 'cases',
      'Hand an assigned record back: it becomes unassigned and the assistant resumes talking with the reporter on its own. Use when they cannot take it or are finished with it but the record stays open.',
      { type: 'object', properties: { case: str('Record reference or id'), reason: str('Why, in a few words') }, required: ['case'] },
      async ({ case: ref, reason = '' }, ctx) => {
        const r = await lookupTeamCase(store, ctx, ref); if (r.fail) return r.fail
        const { c, authority } = r
        const by = staffLabel(ctx.contact)
        const out = await releaseCase({ store: store(), caseRow: c, by, user: storeUser(ctx, authority) })
        if (reason) await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text: `HANDED BACK by ${by}: ${String(reason).slice(0, 500)}`, data: actorData(ctx) })
        clearFocusForCase(c.id)
        return { ok: true, recorded_on: r.on, ref: c.ref, assistant_resumed: out.resumed }
      }),
    defTool('case_dispatch_reply', 'cases',
      'Answer a dispatch suggestion an operator queued for THIS team member: accept (the record is assigned to them if it is unassigned) or decline. Use only after they clearly say which. Find the suggestions with case_pending.',
      {
        type: 'object',
        properties: {
          case: str('Record reference or id'),
          decision: str('accept or decline', { enum: ['accept', 'decline'] }),
          note: str('Optional short reason or when they can get there'),
        },
        required: ['case', 'decision'],
      },
      async ({ case: ref, decision, note = '' }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        const me = ctx?.contact
        const pending = me?.id ? await pendingDispatchesFor(store(), me, [c]) : []
        if (!pending.length) return { error: 'There is no open suggestion for you on that record.' }
        const by = staffLabel(me)
        const key = assigneeKeyFor(me)
        let claimed = false
        let current = String(c.assignee || '').trim()
        if (decision === 'accept') {
          if (isOwnConversation(c, me)) return { error: 'That is this chat with the assistant, not a record to attend.' }
          const taken = await store()._withLock(`assign|${c.id}`, async () => {
            const cur = String((await store().getCase(c.id))?.assignee || '').trim()
            current = cur
            if (cur && cur !== UNCLAIMED_ASSIGNEE && cur !== key) return { error: 'That record is already with someone else now, so it cannot be taken on from here.' }
            if (!cur || cur === UNCLAIMED_ASSIGNEE) { await store().updateCase(c.id, { assignee: key }, storeUser(ctx, 'assigned')); claimed = true }
            return null
          })
          if (taken) return taken
        }
        await store().appendEvent(c.id, {
          kind: 'action', actor: 'operator',
          text: `Dispatch ${decision === 'accept' ? 'accepted' : 'declined'} by ${by}${note ? ` -- ${String(note).slice(0, 300)}` : ''}`,
          data: actorData(ctx, { dispatch_response_by: me.id, decision, ...(claimed ? { claimed_by: key } : {}) }),
        })
        const events = await store().listEvents(c.id)
        const asked = new Set(events.filter(e => e.kind === 'action' && evData(e).dispatch_worker_id).map(e => evData(e).dispatch_worker_id))
        const answered = new Set(events.map(e => evData(e).dispatch_response_by).filter(Boolean))
        if (![...asked].some(w => !answered.has(w))) {
          await store().updateCase(c.id, { tags: dropTag(c.tags, 'dispatch-suggested') }, storeUser(ctx, 'assigned'))
        }
        return { ok: true, ref: c.ref, decision, assigned_to_you: decision === 'accept' && (claimed || current === key) }
      }),
    defTool('case_focus', 'cases',
      'Say which assigned record this team member is working on, or ask which one they are on now. With no arguments it answers "which record am I on" and lists their assigned records. With `case` (an exact reference, or a few words such as the animals and place) it PROPOSES one record: reply by naming it and asking if it is the right one, as the last thing you say. Only after they answer yes in their NEXT message call it again with that record and confirm true; no change to a record is accepted before that. Several matches or a near-miss reference are listed, never guessed.',
      { type: 'object', properties: { case: str('Exact reference, or a few words identifying the animals and place'), confirm: { type: 'boolean', description: 'True only after they replied yes in a later message.' } } },
      async ({ case: query, confirm = false }, ctx) => {
        const me = ctx?.contact
        const mine = async () => {
          const key = assigneeKeyFor(me)
          const own = key ? (await store().listCases({ assignee: key }, { limit: 200 })).filter(isOpenCase) : []
          // The sign-off desk also works the unassigned records that are ready.
          if (!atLeast(ctx?.tier, TIER_ANIMAL_HEALTH_TECHNICIAN) || isOperator(ctx?.tier)) return own
          const seen = new Set(own.map(c => c.id))
          return [...own, ...(await signOffCandidates(store(), ctx)).filter(c => !seen.has(c.id))]
        }
        const line = (c) => ({ ref: c.ref, what: identifyingLine(c) })
        if (!String(query || '').trim()) {
          const f = me?.id ? focusOf(me.id) : null
          const cur = f ? await store().getCase(f.caseId) : null
          const list = await mine()
          return { current: cur && isAssignedTo(cur, me) ? await recordedOn(store(), cur, ctx) : null, assigned: list.slice(0, 15).map(line) }
        }
        const q = String(query).trim()
        const exact = refsIn(q)[0]
        let target = null
        if (exact) {
          const c = await findCase(store(), exact)
          if (!c || !deskAuthorityOn(ctx, c)) {
            const near = (await mine()).filter(c2 => withinOneEdit(c2.ref.toUpperCase(), exact)).map(line)
            return near.length ? { error: `No assigned record has exactly that reference. Did they mean one of these? Ask, do not guess.`, candidates: near } : NOT_ASSIGNED
          }
          target = c
        } else {
          const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 2)
          const hits = (await mine()).filter(c => { const hay = `${identifyingLine(c)} ${c.subject || ''}`.toLowerCase(); return words.length && words.every(w => hay.includes(w)) })
          if (hits.length !== 1) {
            const list = hits.length ? hits : (await mine())
            return { error: hits.length ? 'More than one assigned record fits. Ask which one, listing them by reference and what they are.' : 'No assigned record fits that. Ask them for the reference, or which of these they mean.', candidates: list.slice(0, 15).map(line) }
          }
          target = hits[0]
        }
        const authority = deskAuthorityOn(ctx, target)
        // A finished record can be focused only by the sign-off desk, to reopen it.
        if (!isOpenCase(target) && !atLeast(ctx?.tier, TIER_ANIMAL_HEALTH_TECHNICIAN)) return FINISHED
        if (authority === 'operator') { setFocus(me?.id, target); return { ok: true, focused: true, recorded_on: await recordedOn(store(), target, ctx) } }
        if (!confirm) {
          proposeFocus(me?.id, target, ctx?.dedupeCache)
          return { proposed: true, recorded_on: await recordedOn(store(), target, ctx), note: 'Nothing is changed yet. Name this record to them and ask if it is the right one, as the last thing you say. Confirm only after their yes in their NEXT message.' }
        }
        const done = confirmFocus(me?.id, target, ctx?.dedupeCache)
        return done.ok ? { ok: true, focused: true, recorded_on: await recordedOn(store(), target, ctx) } : done
      }),
    defTool('case_gaps', 'cases',
      'For ONE assigned record: exactly which required facts are still missing, which further facts would help on site, and a short reminder text the team member can paste into their own WhatsApp chat with the reporter. Use before they contact the reporter or when they ask what is left.',
      { type: 'object', properties: { case: str('Record reference or id') }, required: ['case'] },
      async ({ case: ref }, ctx) => {
        const r = await lookupTeamCase(store, ctx, ref, { gate: false }); if (r.fail) return r.fail
        const { c } = r
        const report = parseReport(c)
        const missing = missingMandatoryMinimum(report)
        const helpful = CRITICAL_FIELDS.filter(k => empty(report[k]) && !missing.includes(k))
        const describe = (k) => ({ field: fieldLabel(k), ask_about: (REPORT_FIELD_DEFS.find(f => f.key === k)?.description || '').slice(0, 240) })
        const by = staffLabel(ctx.contact)
        const wanted = [...missing, ...helpful].map(fieldLabel)
        const reminder = `Hello, it is ${by} from the team, about the ${REPORT_ENTITY_LABEL} you reported (${c.ref}).`
          + (wanted.length ? ` Please message our WhatsApp assistant again, on the same number you first reported to, and tell it: ${wanted.join(', ')}.` : ' Please message our WhatsApp assistant again, on the same number you first reported to, with anything that has changed.')
          + ` Thank you.`
        return {
          recorded_on: r.on, ref: c.ref, status: c.status,
          required_missing: missing.map(describe),
          helpful_missing: helpful.map(describe),
          reminder_text: reminder,
          reporter_asked_us_to_stop: optedOut(c),
          ...(optedOut(c) ? { warning: 'This person asked us to stop contacting them. Do not message them.' } : {}),
        }
      }),
    defTool('case_contact', 'cases',
      'Give the team member the reporter\'s phone number for ONE record assigned to them, so they can reach the reporter from their own WhatsApp. Only for their assigned records; each look is written on the timeline. Withheld if the reporter asked us to stop contacting them.',
      { type: 'object', properties: { case: str('Record reference or id') }, required: ['case'] },
      async ({ case: ref }, ctx) => {
        const r = await lookupTeamCase(store, ctx, ref); if (r.fail) return r.fail
        const { c } = r
        if (optedOut(c)) return { ref: c.ref, withheld: true, reporter_asked_us_to_stop: true, note: 'This person asked us to stop contacting them, so no number is given and they are not to be messaged.' }
        if (c.channel !== 'whatsapp') return { error: 'There is no phone number on this record: the person reached us on another channel.' }
        await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text: `REPORTER NUMBER SHOWN to ${staffLabel(ctx.contact)}`, data: actorData(ctx, { number_revealed: true }) })
        // On a shared phone (src/phone-persons.js) say WHO gave the report and that the phone is shared, so the
        // team member asks for that person by name when they call. Nothing extra while nobody is recorded.
        const who = await reporterSummary(store(), c.contact_id, c.id).catch(() => null)
        const person = who && who.reported_by ? { reported_by: { name: who.reported_by.name, ...(who.reported_by.relation ? { relation: who.reported_by.relation } : {}) } } : {}
        const shared = who && who.people > 1 ? { shared_phone: `shared phone (${who.people} people)` } : {}
        return { recorded_on: r.on, ref: c.ref, phone: fmtPhone27(c.external_id), ...person, ...shared, note: 'Message them from your own WhatsApp; say who you are and quote the reference.' + (person.reported_by ? ` Ask for ${person.reported_by.name} by name${shared.shared_phone ? ': other people use this phone too, so do not discuss the report with anyone else who answers' : ''}.` : '') + ' If they would rather tell the assistant, they can reply on the number they first used.' }
      }),
    defTool('case_edit', 'cases',
      'Record what you learn on an ASSIGNED record, on the reporter\'s behalf: report facts, coordinates, subject/summary/priority, extra tags, or an internal note. Every entry is written down as relayed by this team member, never as the reporter\'s own words. A fact the reporter already gave is NOT overwritten unless `correct` is true because it is confirmed to have changed. Not for finishing a record.',
      {
        type: 'object',
        properties: {
          case: str('Record reference or id'),
          ...Object.fromEntries(REPORT_FIELD_DEFS.filter(f => f.key !== 'photos' && f.key !== 'audio' && !SYSTEM_SET_FIELDS.has(f.key)).map(f => [f.key, str(f.description)])),
          ...Object.fromEntries(REPORT_GEO_FIELD_DEFS.map(f => [f.key, { type: 'number', description: f.description }])),
          location_source: str('REQUIRED with lat/lon: "gps" only if exact coordinates were read out or seen; otherwise "estimated". "confirmed" only when the reporter agreed to it.', { enum: ['gps', 'estimated', 'confirmed'] }),
          subject: str('Short title'),
          summary: str('Rolling summary of where the record stands'),
          priority: str('Priority', { enum: priorityValues }),
          add_tags: str('Comma-separated tags to add'),
          note: str('Internal note for the team (not sent to the reporter)'),
          correct: { type: 'boolean', description: 'True only when overwriting a fact the reporter gave is confirmed correct.' },
        },
        required: ['case'],
      },
      async ({ case: ref, lat, lon, location_source, subject, summary, priority, add_tags, note, correct = false, ...fields }, ctx) => {
        subject = cleanRelayed(subject); summary = cleanRelayed(summary); add_tags = cleanRelayed(add_tags); note = cleanRelayed(note)
        for (const k of Object.keys(fields)) fields[k] = cleanRelayed(fields[k])
        // The diagnosis is recorded by the technician at sign-off, never relayed through the ranger's edit.
        const notDiagnosis = canSignOff(ctx?.tier) ? [] : SIGNOFF_DIAGNOSIS_FIELDS.filter(k => k in fields)
        for (const k of notDiagnosis) delete fields[k]
        const r = await lookupTeamCase(store, ctx, ref); if (r.fail) return r.fail
        const { c, authority } = r
        if (!isOpenCase(c)) return FINISHED
        const by = staffLabel(ctx.contact)
        const user = storeUser(ctx, authority)
        const incoming = pick(fields, [...REPORT_KEYS].filter(k => k !== 'photos' && k !== 'audio'))
        const tooLong = Object.keys(incoming).filter(k => String(incoming[k]).length > APPEND_FIELD_MAX_LEN)
        if (tooLong.length) return { error: `${tooLong.map(fieldLabel).join(', ')} is too long to record (over ${APPEND_FIELD_MAX_LEN} characters). Nothing was changed. Ask for a shorter version.` }
        const prior = parseReport(c)
        const held = Object.keys(incoming).filter(k => !APPEND_FIELDS.has(k) && !empty(prior[k]) && String(prior[k]).trim() !== String(incoming[k]).trim())
        if (held.length && !correct) {
          return { error: `The reporter already gave ${held.map(k => `${fieldLabel(k)}: "${String(prior[k]).slice(0, 120)}"`).join('; ')}. Nothing was changed. If it is confirmed that it has changed, call again with correct set to true.` }
        }
        for (const k of Object.keys(incoming)) {
          if (APPEND_FIELDS.has(k)) incoming[k] = `[relayed by ${by}] ${incoming[k]}`
        }
        const hasLatLon = typeof lat === 'number' && typeof lon === 'number'
        if ((lat != null || lon != null) && !(hasLatLon && isValidLatLon(lat, lon))) return { error: `lat/lon out of range or incomplete: lat=${lat}, lon=${lon}` }
        const columns = {}
        if (subject) columns.subject = String(subject).slice(0, 200)
        if (summary) {
          if (String(summary).length > APPEND_FIELD_MAX_LEN) return { error: `The summary is too long (over ${APPEND_FIELD_MAX_LEN} characters). Nothing was changed. Give a shorter one.` }
          columns.summary = String(summary)
        }
        if (priority) {
          if (!new Set(store().getFieldEnum('case.priority', priorityValues)).has(priority)) return { error: `invalid priority: ${priority}`, allowed: priorityValues }
          columns.priority = priority
        }
        const tagsToAdd = String(add_tags || '').split(',').map(t => t.trim()).filter(Boolean)
        if (tagsToAdd.some(t => RESERVED_TAG.test(t))) return { error: 'Those tags are set by the system itself and cannot be added by hand.' }
        if (!Object.keys(incoming).length && !hasLatLon && !Object.keys(columns).length && !tagsToAdd.length && !note) return { error: notDiagnosis.length ? 'The diagnosis is not recorded from here: the technician records it when signing off. Nothing was changed.' : 'Nothing to record was supplied.' }
        const recorded = []
        if (Object.keys(incoming).length) {
          const merged = await store().mergeReport(c.id, incoming, user, { bypassObserve: true })
          if (merged.error) return { error: merged.error }
          recorded.push(...Object.keys(incoming))
          if ('location' in incoming) {
            try { await store().systemUpdateDerived(c.id, { normalized_location: normalizeLocation(incoming.location) }) } catch { /* derived freshness only */ }
          }
          if (REPORT_KEYS.has("notes") && APPEND_FIELDS.has("notes")) {
            await store().appendReportField(c.id, 'notes', `[relayed by ${by} on the reporter's behalf: recorded ${Object.keys(incoming).map(fieldLabel).join(', ')}]`, user).catch(() => {})
          }
        }
        if (hasLatLon) {
          const source = location_source || 'estimated'
          const cur = await store().getCase(c.id)
          if (source === 'estimated' && (cur?.location_source === 'gps' || cur?.location_source === 'confirmed') && cur?.lat != null) {
            return { error: `This record already holds a ${cur.location_source} position; an estimate does not replace it.`, recorded }
          }
          columns.lat = lat; columns.lon = lon; columns.location_source = source
          recorded.push('lat', 'lon', 'location_source')
        }
        if (tagsToAdd.length) { columns.tags = tagsToAdd.reduce((t, tag) => mergeTag(t, tag), c.tags || ''); recorded.push('tags') }
        if (Object.keys(columns).length) {
          await store().updateCase(c.id, columns, user)
          recorded.push(...Object.keys(columns).filter(k => !['lat', 'lon', 'location_source', 'tags'].includes(k)))
        }
        const corrections = held.map(k => `${k} ${prior[k]} -> ${incoming[k]}`)
        if (recorded.length) {
          await store().appendEvent(c.id, {
            kind: 'action', actor: 'operator',
            text: `recorded on the reporter's behalf by ${by}: ${[...new Set(recorded)].join(', ')}${corrections.length ? `; changed: ${corrections.join(', ')}` : ''}`,
            data: actorData(ctx, { on_behalf: true, relayed_by: by, ...incoming, ...(hasLatLon ? { lat, lon } : {}), ...(corrections.length ? { corrections } : {}) }),
          })
        }
        if (note) await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text: `NOTE from ${by}: ${String(note).slice(0, 4000)}`, data: actorData(ctx) })
        return { ok: true, recorded_on: r.on, ref: c.ref, recorded: [...new Set(recorded)], ...(note ? { noted: true } : {}), ...(notDiagnosis.length ? { not_recorded: `${notDiagnosis.join(', ')}: the technician records these when signing off` } : {}) }
      }),
    defTool('case_stage', 'cases',
      'Move an ASSIGNED record to another working stage (not a finished one). Use when the team member says work has started, it is waiting on something, or it is back in progress. Never say the stage name to the reporter.',
      { type: 'object', properties: { case: str('Record reference or id'), to: str('Target stage'), reason: str('Why, in a few words') }, required: ['case', 'to'] },
      async ({ case: ref, to, reason = '' }, ctx) => {
        const r = await lookupTeamCase(store, ctx, ref); if (r.fail) return r.fail
        const { c, authority } = r
        if (doneStages().includes(to)) {
          // The same order case_transition uses: a blank required fact is something the
          // person on site can still fix, so it is named first; only a complete record
          // reaches the "not yours to finish" answer.
          const blank = missingMandatoryMinimum(parseReport(c))
          if (blank.length) return { error: `Not finished: ${blank.map(fieldLabel).join(', ')} ${blank.length === 1 ? 'is' : 'are'} still not recorded, and every one of those has to be known before anyone can finish it. Ask the reporter for ${blank.length === 1 ? 'it' : 'them'} (case_gaps has a reminder to send), record ${blank.length === 1 ? 'it' : 'them'} with case_edit, and leave the record open.` }
          return { error: canSignOff(ctx?.tier)
            ? 'Finishing a record is done with the sign-off, not here, and only once every required fact is recorded.'
            : 'Finishing a record is not done from here. Leave it as it is: the technician who signs these off will finish it.' }
        }
        if (!store().getValidStatuses().includes(to)) return { error: `Unknown stage.`, allowed: store().getValidStatuses().filter(s => !doneStages().includes(s)) }
        const user = storeUser(ctx, authority)
        const legal = store().availableTransitions(c, user)
        if (to !== c.status && !legal.includes(to)) return { error: `That move is not possible from the current stage.`, allowed: legal.filter(s => !doneStages().includes(s)) }
        await store().transition(c.id, to, { user, reason: `${staffLabel(ctx.contact)}: ${reason || 'team update'}` })
        return { ok: true, recorded_on: r.on, ref: c.ref, from: c.status, to }
      }),
    defTool('case_message', 'cases',
      'Send a WhatsApp message to the reporter of a record, through the assistant\'s number. Only for records assigned to this team member. It is refused, and says so, if the reporter asked us to stop or last wrote more than 24 hours ago (then give the team member the reporter\'s number with case_contact so they can reach them from their own phone). Write it as the team member speaking, plainly and briefly.',
      { type: 'object', properties: { case: str('Record reference or id'), text: str('The message, in the reporter\'s language') }, required: ['case', 'text'] },
      async ({ case: ref, text }, ctx) => {
        const r = await lookupTeamCase(store, ctx, ref); if (r.fail) return r.fail
        const { c } = r
        const sent = await sendStaffMessage({ store: store(), sendReply: ctx?.sendReply, canSend: ctx?.canSend, caseRow: c, text, staff: staffOf(ctx) })
        return sent.ok ? { ok: true, delivered: true, recorded_on: r.on, ref: c.ref, claimed: sent.claimed, assistant_paused: sent.took_over } : { ok: false, delivered: false, ref: c.ref, error: sent.error }
      }),
  ]
}

// True when two references differ by at most one substitution, insertion or
// deletion (a mistyped digit): used only to LIST near-misses for a person to pick.
function withinOneEdit(a, b) {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1)
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}
