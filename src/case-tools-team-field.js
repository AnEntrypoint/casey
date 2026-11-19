

import { defTool, str, pick, isValidLatLon } from './case-tools-shared.js'
import { REPORT_KEYS } from './case-store.js'
import { parseReport, tagList } from './timestamp.js'
import { isOpenCase, fmtPhone27 } from './format.js'
import { canSignOff, isOperator, atLeast, TIER } from './contact-tiers.js'
import { assigneeKeyFor, isAssignedTo, isOwnConversation, publicAssignee } from './case-assignment.js'
import { normalizeLocation } from './location-normalize.js'
import { OPTED_OUT_TAG, RESERVED_TAG, mergeTag, dropTag } from './hooks/heuristics.js'
import { sendStaffMessage, releaseCase, staffLabel } from './hooks/staff-outbound.js'
import { staffNotices, pendingDispatchesFor } from './staff-notices.js'
import { evData } from './safe.js'
import { reporterSummary } from './phone-persons.js'
import { refsIn, writeGate, recordedOn, identifyingLine, proposeFocus, confirmFocus, setFocus, focusOf, clearFocusForCase, withinOneEdit } from './team-focus.js'
import { recordSeen, recordWrote, checkStale, reportKeysOf } from './stale-write-guard.js'
import {
  APPEND_FIELDS, CRITICAL_FIELDS, REPORT_FIELD_DEFS, SYSTEM_SET_FIELDS, REPORT_GEO_FIELD_DEFS, REPORT_ENTITY_LABEL,
  missingMandatoryMinimum, fieldLabel, SIGNOFF_DIAGNOSIS_FIELDS,
} from './store/report-shape.js'
import { UNCLAIMED_ASSIGNEE } from './case-store.js'
import { candidateChoices } from './choices.js'
import { APPEND_FIELD_MAX_LEN } from './store/report-merge.js'
import { signOffCandidates } from './case-tools-team-review.js'
import { pinConfidence } from './pin-confidence.js'
import {
  NOT_ASSIGNED, doneStages, findCase, authorityOn, deskAuthorityOn, storeUser, actorData, teamRow, cleanRelayed, reporterExtras,
} from './case-tools-team-shared.js'
import { caseyText } from './deployment-text.js';

const NO_SUCH = { error: caseyText("src/case-tools-team-field.js#0") }
const FINISHED = { error: caseyText("src/case-tools-team-field.js#1") }
const empty = (v) => v == null || String(v).trim() === ''

const staffOf = (ctx) => ({ ...(ctx?.contact || {}), tier: ctx?.tier })
const optedOut = (c) => tagList(c).includes(OPTED_OUT_TAG)

const lookupTeamCase = async (store, ctx, ref, { gate = true } = {}) => {
  const c = await findCase(store(), ref)
  if (!c) return { fail: NO_SUCH }

  const authority = deskAuthorityOn(ctx, c)
  if (!authority) return { fail: NOT_ASSIGNED }
  if (gate && authority === 'assigned') {
    const refused = await writeGate(store(), ctx, c)
    if (refused) return { fail: refused }
  }
  return { c, authority, on: await recordedOn(store(), c, ctx) }
}

export function buildTeamFieldTools(store, { priorityValues }) {
  return [
    defTool('case_pending', 'cases',
      caseyText("src/case-tools-team-field.js#2"),
      { type: 'object', properties: {} },
      async (_args, ctx) => {
        const n = await staffNotices(store(), ctx?.contact, { mark: true, tier: ctx?.tier })

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
          ...(n.offers.length ? { handover_offers: n.offers.map(({ c, offer, line }) => ({ ref: c.ref, from: offer.by, tell_them: line })) } : {}),
        }
      }),
    defTool('case_claim', 'cases',
      caseyText("src/case-tools-team-field.js#3"),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-team-field.js#s0")) }, required: ['case'] },
      async ({ case: ref }, ctx) => {
        const c0 = await findCase(store(), ref)
        if (!c0) return NO_SUCH
        if (!isOpenCase(c0)) return FINISHED
        const key = assigneeKeyFor(ctx?.contact)
        if (!key) return { error: caseyText("src/case-tools-team-field.js#4") }
        if (isOwnConversation(c0, ctx.contact)) return { error: caseyText("src/case-tools-team-field.js#5") }

        return store()._withLock(`assign|${c0.id}`, async () => {
          const c = await store().getCase(c0.id)
          if (!c || !isOpenCase(c)) return FINISHED
          const current = String(c.assignee || '').trim()
          if (current === key) return { ok: true, ref: c.ref, note: caseyText("src/case-tools-team-field.js#s1") }
          if (current && current !== UNCLAIMED_ASSIGNEE) {
            return { error: caseyText("src/case-tools-team-field.js#6") }
          }

          if (!isOperator(ctx.tier) && !(await pendingDispatchesFor(store(), ctx.contact, [c])).length) {
            return { error: caseyText("src/case-tools-team-field.js#7") }
          }
          const by = staffLabel(ctx.contact)
          await store().updateCase(c.id, { assignee: key }, storeUser(ctx, isOperator(ctx.tier) ? 'operator' : 'assigned'))
          await store().appendEvent(c.id, { kind: 'action', actor: 'operator', text: caseyText("src/case-tools-team-field.js#s2", [by]), data: actorData(ctx, { claimed_by: key, was: current || null }) })
          return { ok: true, ref: c.ref }
        })
      }),
    defTool('case_release', 'cases',
      caseyText("src/case-tools-team-field.js#8"),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-team-field.js#s3")), reason: str(caseyText("src/case-tools-team-field.js#s4")) }, required: ['case'] },
      async ({ case: ref, reason = '' }, ctx) => {
        const r = await lookupTeamCase(store, ctx, ref); if (r.fail) return r.fail
        const { c, authority } = r
        const by = staffLabel(ctx.contact)
        const out = await releaseCase({ store: store(), caseRow: c, by, user: storeUser(ctx, authority) })
        if (reason) await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text: caseyText("src/case-tools-team-field.js#s5", [by, String(reason).slice(0, 500)]), data: actorData(ctx) })
        await clearFocusForCase(store(), c.id)
        return { ok: true, recorded_on: r.on, ref: c.ref, assistant_resumed: out.resumed }
      }),
    defTool('case_dispatch_reply', 'cases',
      caseyText("src/case-tools-team-field.js#9"),
      {
        type: 'object',
        properties: {
          case: str(caseyText("src/case-tools-team-field.js#s6")),
          decision: str(caseyText("src/case-tools-team-field.js#s7"), { enum: ['accept', 'decline'] }),
          note: str(caseyText("src/case-tools-team-field.js#10")),
        },
        required: ['case', 'decision'],
      },
      async ({ case: ref, decision, note = '' }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        const me = ctx?.contact
        const pending = me?.id ? await pendingDispatchesFor(store(), me, [c]) : []
        if (!pending.length) return { error: caseyText("src/case-tools-team-field.js#11") }
        const by = staffLabel(me)
        const key = assigneeKeyFor(me)
        let claimed = false
        let current = String(c.assignee || '').trim()
        if (decision === 'accept') {
          if (isOwnConversation(c, me)) return { error: caseyText("src/case-tools-team-field.js#12") }
          const taken = await store()._withLock(`assign|${c.id}`, async () => {
            const cur = String((await store().getCase(c.id))?.assignee || '').trim()
            current = cur
            if (cur && cur !== UNCLAIMED_ASSIGNEE && cur !== key) return { error: caseyText("src/case-tools-team-field.js#13") }
            if (!cur || cur === UNCLAIMED_ASSIGNEE) { await store().updateCase(c.id, { assignee: key }, storeUser(ctx, 'assigned')); claimed = true }
            return null
          })
          if (taken) return taken
        }
        await store().appendEvent(c.id, {
          kind: 'action', actor: 'operator',
          text: caseyText("src/case-tools-team-field.js#s8", [decision === 'accept' ? 'accepted' : 'declined', by, note ? ` -- ${String(note).slice(0, 300)}` : '']),
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
      caseyText("src/case-tools-team-field.js#14"),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-team-field.js#15")), confirm: { type: 'boolean', description: caseyText("src/case-tools-team-field.js#16") } } },
      async ({ case: query, confirm = false }, ctx) => {
        const me = ctx?.contact
        const mine = async () => {
          const key = assigneeKeyFor(me)
          const own = key ? (await store().listCases({ assignee: key }, { limit: 200 })).filter(c => isOpenCase(c) && !isOwnConversation(c, me)) : []

          if (!atLeast(ctx?.tier, TIER.specialist) || isOperator(ctx?.tier)) return own
          const seen = new Set(own.map(c => c.id))
          return [...own, ...(await signOffCandidates(store(), ctx)).filter(c => !seen.has(c.id))]
        }
        const line = (c) => ({ ref: c.ref, what: identifyingLine(c) })
        if (!String(query || '').trim()) {
          const f = me?.id ? await focusOf(store(), me.id) : null
          const cur = f ? await store().getCase(f.caseId) : null
          const list = await mine()
          return { current: cur && isAssignedTo(cur, me) ? await recordedOn(store(), cur, ctx) : null, assigned: list.slice(0, 15).map(line), ...(list.length > 1 ? candidateChoices(list.map(line)) : {}) }
        }
        const q = String(query).trim()
        const exact = refsIn(q)[0]
        let target = null
        if (exact) {
          const c = await findCase(store(), exact)
          if (!c || !deskAuthorityOn(ctx, c)) {
            const near = (await mine()).filter(c2 => withinOneEdit(c2.ref.toUpperCase(), exact)).map(line)
            return near.length ? { error: caseyText("src/case-tools-team-field.js#17"), candidates: near, ...candidateChoices(near) } : NOT_ASSIGNED
          }
          target = c
        } else {
          const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 2)
          const hits = (await mine()).filter(c => { const hay = `${identifyingLine(c)} ${c.subject || ''}`.toLowerCase(); return words.length && words.every(w => hay.includes(w)) })
          if (hits.length !== 1) {
            const list = hits.length ? hits : (await mine())
            return { error: hits.length ? caseyText("src/case-tools-team-field.js#18") : caseyText("src/case-tools-team-field.js#19"), candidates: list.slice(0, 15).map(line), ...(list.length > 1 ? candidateChoices(list.map(line)) : {}) }
          }
          target = hits[0]
        }
        const authority = deskAuthorityOn(ctx, target)

        if (!isOpenCase(target) && !atLeast(ctx?.tier, TIER.specialist)) return FINISHED
        if (authority === 'operator') { await setFocus(store(), me?.id, target); await recordSeen(store(), me?.id, target); return { ok: true, focused: true, recorded_on: await recordedOn(store(), target, ctx) } }
        if (!confirm) {
          await proposeFocus(store(), me?.id, target, ctx?.turnId)
          return { proposed: true, recorded_on: await recordedOn(store(), target, ctx), note: caseyText("src/case-tools-team-field.js#20") }
        }
        const done = await confirmFocus(store(), me?.id, target, ctx?.turnId)
        if (!done.ok) return done
        await recordSeen(store(), me?.id, target)
        return { ok: true, focused: true, recorded_on: await recordedOn(store(), target, ctx) }
      }),
    defTool('case_gaps', 'cases',
      caseyText("src/case-tools-team-field.js#21"),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-team-field.js#s9")) }, required: ['case'] },
      async ({ case: ref }, ctx) => {
        const r = await lookupTeamCase(store, ctx, ref, { gate: false }); if (r.fail) return r.fail
        const { c } = r
        await recordSeen(store(), ctx?.contact?.id, c)
        const report = parseReport(c)
        const missing = missingMandatoryMinimum(report)
        const helpful = CRITICAL_FIELDS.filter(k => empty(report[k]) && !missing.includes(k))
        const describe = (k) => ({ field: fieldLabel(k), ask_about: (REPORT_FIELD_DEFS.find(f => f.key === k)?.description || '').slice(0, 240) })
        const by = staffLabel(ctx.contact)
        const wanted = [...missing, ...helpful].map(fieldLabel)
        const reminder = caseyText("src/case-tools-team-field.js#22", [by, REPORT_ENTITY_LABEL, c.ref])
          + (wanted.length ? caseyText("src/case-tools-team-field.js#23", [wanted.join(', ')]) : caseyText("src/case-tools-team-field.js#24"))
          + caseyText("src/case-tools-team-field.js#s10")
        return {
          recorded_on: r.on, ref: c.ref, status: c.status,
          required_missing: missing.map(describe),
          helpful_missing: helpful.map(describe),
          reminder_text: reminder,
          reporter_asked_us_to_stop: optedOut(c),
          ...(optedOut(c) ? { warning: caseyText("src/case-tools-team-field.js#25") } : {}),
        }
      }),
    defTool('case_contact', 'cases',
      caseyText("src/case-tools-team-field.js#26"),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-team-field.js#s11")) }, required: ['case'] },
      async ({ case: ref }, ctx) => {
        const r = await lookupTeamCase(store, ctx, ref); if (r.fail) return r.fail
        const { c } = r
        if (optedOut(c)) return { ref: c.ref, withheld: true, reporter_asked_us_to_stop: true, note: caseyText("src/case-tools-team-field.js#27") }
        if (c.channel !== 'whatsapp') return { error: caseyText("src/case-tools-team-field.js#28") }
        await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text: caseyText("src/case-tools-team-field.js#s12", [staffLabel(ctx.contact)]), data: actorData(ctx, { number_revealed: true }) })

        const who = await reporterSummary(store(), c.contact_id, c.id).catch(() => null)
        const person = who && who.reported_by ? { reported_by: { name: who.reported_by.name, ...(who.reported_by.relation ? { relation: who.reported_by.relation } : {}) } } : {}
        const shared = who && who.people > 1 ? { shared_phone: caseyText("src/case-tools-team-field.js#s13", [who.people]) } : {}
        return { recorded_on: r.on, ref: c.ref, phone: fmtPhone27(c.external_id), ...person, ...shared, note: caseyText("src/case-tools-team-field.js#29") + (person.reported_by ? caseyText("src/case-tools-team-field.js#s14", [person.reported_by.name, shared.shared_phone ? caseyText("src/case-tools-team-field.js#30") : '']) : '') + caseyText("src/case-tools-team-field.js#31") }
      }),
    defTool('case_edit', 'cases',
      caseyText("src/case-tools-team-field.js#32"),
      {
        type: 'object',
        properties: {
          case: str(caseyText("src/case-tools-team-field.js#s15")),
          ...Object.fromEntries(REPORT_FIELD_DEFS.filter(f => f.key !== 'photos' && f.key !== 'audio' && !SYSTEM_SET_FIELDS.has(f.key)).map(f => [f.key, str(f.description)])),
          ...Object.fromEntries(REPORT_GEO_FIELD_DEFS.map(f => [f.key, { type: 'number', description: f.description }])),
          location_source: str(caseyText("src/case-tools-team-field.js#33"), { enum: ['gps', 'estimated', 'confirmed'] }),
          subject: str(caseyText("src/case-tools-team-field.js#s16")),
          summary: str(caseyText("src/case-tools-team-field.js#34")),
          priority: str('Priority', { enum: priorityValues }),
          add_tags: str(caseyText("src/case-tools-team-field.js#s17")),
          note: str(caseyText("src/case-tools-team-field.js#35")),
          correct: { type: 'boolean', description: caseyText("src/case-tools-team-field.js#36") },
        },
        required: ['case'],
      },
      async ({ case: ref, lat, lon, location_source, location_confidence, subject, summary, priority, add_tags, note, correct = false, ...fields }, ctx) => {
        subject = cleanRelayed(subject); summary = cleanRelayed(summary); add_tags = cleanRelayed(add_tags); note = cleanRelayed(note)
        for (const k of Object.keys(fields)) fields[k] = cleanRelayed(fields[k])

        const notDiagnosis = canSignOff(ctx?.tier) ? [] : SIGNOFF_DIAGNOSIS_FIELDS.filter(k => k in fields)
        for (const k of notDiagnosis) delete fields[k]
        const r = await lookupTeamCase(store, ctx, ref); if (r.fail) return r.fail
        const { c, authority } = r
        if (!isOpenCase(c)) return FINISHED
        const by = staffLabel(ctx.contact)
        const user = storeUser(ctx, authority)
        const incoming = pick(fields, [...REPORT_KEYS].filter(k => k !== 'photos' && k !== 'audio'))
        const tooLong = Object.keys(incoming).filter(k => String(incoming[k]).length > APPEND_FIELD_MAX_LEN)
        if (tooLong.length) return { error: caseyText("src/case-tools-team-field.js#37", [tooLong.map(fieldLabel).join(', '), APPEND_FIELD_MAX_LEN]) }
        const touched = [...reportKeysOf(Object.keys(incoming)), ...(subject ? ['col.subject'] : []), ...(summary ? ['col.summary'] : []), ...(priority ? ['col.priority'] : []), ...(lat != null || lon != null ? ['col.position'] : [])]
        const stale = await checkStale(store(), ctx, c, touched)
        if (stale) return stale
        const prior = parseReport(c)
        const held = Object.keys(incoming).filter(k => !APPEND_FIELDS.has(k) && !empty(prior[k]) && String(prior[k]).trim() !== String(incoming[k]).trim())
        if (held.length && !correct) {
          return { error: caseyText("src/case-tools-team-field.js#38", [held.map(k => `${fieldLabel(k)}: "${String(prior[k]).slice(0, 120)}"`).join('; ')]) }
        }
        for (const k of Object.keys(incoming)) {
          if (APPEND_FIELDS.has(k)) incoming[k] = caseyText("src/case-tools-team-field.js#s18", [by, incoming[k]])
        }
        const hasLatLon = typeof lat === 'number' && typeof lon === 'number'
        if ((lat != null || lon != null) && !(hasLatLon && isValidLatLon(lat, lon))) return { error: caseyText("src/case-tools-team-field.js#39", [lat, lon]) }
        const columns = {}
        if (subject) columns.subject = String(subject).slice(0, 200)
        if (summary) {
          if (String(summary).length > APPEND_FIELD_MAX_LEN) return { error: caseyText("src/case-tools-team-field.js#40", [APPEND_FIELD_MAX_LEN]) }
          columns.summary = String(summary)
        }
        if (priority) {
          if (!new Set(store().getFieldEnum('case.priority', priorityValues)).has(priority)) return { error: caseyText("src/case-tools-team-field.js#s19", [priority]), allowed: priorityValues }
          columns.priority = priority
        }
        const tagsToAdd = String(add_tags || '').split(',').map(t => t.trim()).filter(Boolean)
        if (tagsToAdd.some(t => RESERVED_TAG.test(t))) return { error: caseyText("src/case-tools-team-field.js#41") }
        if (!Object.keys(incoming).length && !hasLatLon && !Object.keys(columns).length && !tagsToAdd.length && !note) return { error: notDiagnosis.length ? caseyText("src/case-tools-team-field.js#42") : caseyText("src/case-tools-team-field.js#s20") }
        const recorded = []
        if (Object.keys(incoming).length) {
          const merged = await store().mergeReport(c.id, incoming, user, { bypassObserve: true })
          if (merged.error) return { error: merged.error }
          recorded.push(...Object.keys(incoming))
          if ('location' in incoming) {
            try { await store().systemUpdateDerived(c.id, { normalized_location: normalizeLocation(incoming.location) }) } catch {  }
          }
          if (REPORT_KEYS.has("notes") && APPEND_FIELDS.has("notes")) {
            await store().appendReportField(c.id, 'notes', caseyText("src/case-tools-team-field.js#43", [by, Object.keys(incoming).map(fieldLabel).join(', ')]), user).catch(() => {})
          }
        }
        if (hasLatLon) {
          const source = location_source || 'estimated'
          const cur = await store().getCase(c.id)
          if (source === 'estimated' && (cur?.location_source === 'gps' || cur?.location_source === 'confirmed') && cur?.lat != null) {
            return { error: caseyText("src/case-tools-team-field.js#44", [cur.location_source]), recorded }
          }
          columns.lat = lat; columns.lon = lon; columns.location_source = source; columns.location_confidence = pinConfidence(source, location_confidence)
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
            text: caseyText("src/case-tools-team-field.js#s21", [by, [...new Set(recorded)].join(', '), corrections.length ? `; changed: ${corrections.join(', ')}` : '']),
            data: actorData(ctx, { on_behalf: true, relayed_by: by, ...incoming, ...(hasLatLon ? { lat, lon } : {}), ...(corrections.length ? { corrections } : {}) }),
          })
        }
        if (note) await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text: caseyText("src/case-tools-team-field.js#s22", [by, String(note).slice(0, 4000)]), data: actorData(ctx) })
        await recordWrote(store(), ctx?.contact?.id, await store().getCase(c.id), [...touched, 'report.notes'])
        return { ok: true, recorded_on: r.on, ref: c.ref, recorded: [...new Set(recorded)], ...(note ? { noted: true } : {}), ...(notDiagnosis.length ? { not_recorded: caseyText("src/case-tools-team-field.js#45", [notDiagnosis.join(', ')]) } : {}) }
      }),
    defTool('case_stage', 'cases',
      caseyText("src/case-tools-team-field.js#46"),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-team-field.js#s23")), to: str(caseyText("src/case-tools-team-field.js#s24")), reason: str(caseyText("src/case-tools-team-field.js#s25")) }, required: ['case', 'to'] },
      async ({ case: ref, to, reason = '' }, ctx) => {
        const r = await lookupTeamCase(store, ctx, ref); if (r.fail) return r.fail
        const { c, authority } = r
        if (doneStages().includes(to)) {

          const blank = missingMandatoryMinimum(parseReport(c))
          if (blank.length) return { error: caseyText("src/case-tools-team-field.js#47", [blank.map(fieldLabel).join(', '), blank.length === 1 ? 'is' : 'are', blank.length === 1 ? 'it' : 'them', blank.length === 1 ? 'it' : 'them']) }
          return { error: canSignOff(ctx?.tier)
            ? caseyText("src/case-tools-team-field.js#48")
            : caseyText("src/case-tools-team-field.js#49") }
        }
        if (!store().getValidStatuses().includes(to)) return { error: caseyText("src/case-tools-team-field.js#s26"), allowed: store().getValidStatuses().filter(s => !doneStages().includes(s)) }
        const user = storeUser(ctx, authority)
        const legal = store().availableTransitions(c, user)
        if (to !== c.status && !legal.includes(to)) return { error: caseyText("src/case-tools-team-field.js#50"), allowed: legal.filter(s => !doneStages().includes(s)) }
        const stale = await checkStale(store(), ctx, c, ['col.status'])
        if (stale) return stale
        await store().transition(c.id, to, { user, reason: `${staffLabel(ctx.contact)}: ${reason || caseyText("src/case-tools-team-field.js#s27")}` })
        await recordWrote(store(), ctx?.contact?.id, await store().getCase(c.id), ['col.status'])
        return { ok: true, recorded_on: r.on, ref: c.ref, from: c.status, to }
      }),
    defTool('case_message', 'cases',
      caseyText("src/case-tools-team-field.js#51"),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-team-field.js#s28")), text: str(caseyText("src/case-tools-team-field.js#s29")) }, required: ['case', 'text'] },
      async ({ case: ref, text }, ctx) => {
        const r = await lookupTeamCase(store, ctx, ref); if (r.fail) return r.fail
        const { c } = r
        const sent = await sendStaffMessage({ store: store(), sendReply: ctx?.sendReply, canSend: ctx?.canSend, caseRow: c, text, staff: staffOf(ctx) })
        return sent.ok ? { ok: true, delivered: true, recorded_on: r.on, ref: c.ref, claimed: sent.claimed, assistant_paused: sent.took_over } : { ok: false, delivered: false, ref: c.ref, error: sent.error }
      }),
  ]
}
