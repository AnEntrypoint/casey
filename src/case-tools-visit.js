import { defTool, str } from './case-tools-shared.js'
import { parseReport } from './timestamp.js'
import { isOpenCase } from './format.js'
import { staffLabel } from './hooks/staff-outbound.js'
import { writeGate } from './team-focus.js'
import {
  CRITICAL_FIELDS, REPORT_FIELD_DEFS, SYSTEM_SET_FIELDS, missingMandatoryMinimum, fieldLabel,
} from './store/report-shape.js'
import { NOT_ASSIGNED, findCase, authorityOn, actorData, cleanRelayed } from './case-tools-team-shared.js'
import { visitOf, newVisit, saveVisit, endVisit, VISIT_IDLE_MS } from './visit-state.js'

const empty = (v) => v == null || String(v).trim() === ''
const NOT_EDITABLE = new Set(['photos', 'audio', ...SYSTEM_SET_FIELDS])
const PHONE_SHAPE = /\+?\d[\d\s()-]{6,}\d/g
const LIST_MAX = 20
const ITEM_MAX = 300

export const visitQueue = (report) => {
  const mandatory = missingMandatoryMinimum(report)
  return [...mandatory, ...CRITICAL_FIELDS.filter(k => empty(report[k]) && !mandatory.includes(k))]
    .filter(k => !NOT_EDITABLE.has(k))
}

const question = (k, position, total) => ({
  field: k,
  label: fieldLabel(k),
  ask_about: (REPORT_FIELD_DEFS.find(f => f.key === k)?.description || '').slice(0, 240),
  question_number: position,
  of: total,
  how: 'Ask ONLY this one question, in their language. Record only what they say in answer; if they cannot say, call skip and leave it empty. Never guess, never work out a count.',
})

export const statedCount = (text) => {
  const s = String(text || '')
  const digits = s.match(/\d+/g)
  if (!digits || digits.length !== 1 || /\d[.,]\d/.test(s)) return null
  return Number(digits[0])
}

const spoken = (v, max = 80) => String(v).replace(PHONE_SHAPE, 'a number').replace(/\s+/g, ' ').trim().slice(0, max)

export function withReadback(editTool) {
  return {
    ...editTool,
    handler: async (args, ctx) => {
      const out = await editTool.handler(args, ctx)
      if (!out || !out.ok || !out.recorded?.length) return out
      const parts = REPORT_FIELD_DEFS.filter(f => !empty(args[f.key]) && out.recorded.includes(f.key)).map(f => spoken(args[f.key]))
      if (out.recorded.includes('lat')) parts.push('a map position')
      if (out.noted) parts.push('a note')
      if (!parts.length) return out
      return { ...out, readback: `Saved: ${parts.join(', ')}` }
    },
  }
}

export function buildVisitTools(store, editTool) {
  const lookup = async (ctx, ref) => {
    const c = await findCase(store(), ref)
    if (!c) return { fail: { error: 'No such record. Ask for the reference again.' } }
    if (authorityOn(ctx, c) !== 'assigned') return { fail: NOT_ASSIGNED }
    if (!isOpenCase(c)) return { fail: { error: 'That record is already finished, so it is not changed from here.' } }
    const refused = await writeGate(store(), ctx, c)
    if (refused) return { fail: refused }
    return { c }
  }

  return [
    defTool('case_visit', 'cases',
      'Guided field visit on ONE assigned record, one question at a time. action start: builds the list of facts still missing (required first, then the visit-critical ones) and returns the first question. action next: pass the ranger\'s answer to the current question as `answer`; it is recorded on the record as relayed by them and the next question comes back. action skip: they cannot or will not answer: the fact stays EMPTY and the next question comes back. action finish: writes one VISIT SUMMARY on the record listing what was recorded and what was skipped, and returns a short read-back. Ask only ONE question per message, in the language they write in. Record only what they actually said: never guess an answer, never work out a count, never fill a skipped fact. It lapses after 2 hours of quiet; start again if it says there is no visit.',
      {
        type: 'object',
        properties: {
          case: str('Record reference or id'),
          action: str('start, next, skip or finish', { enum: ['start', 'next', 'skip', 'finish'] }),
          answer: str('For next only: their answer to the current question, in their own words'),
        },
        required: ['case', 'action'],
      },
      async ({ case: ref, action, answer }, ctx) => {
        const r = await lookup(ctx, ref); if (r.fail) return r.fail
        const { c } = r
        const me = ctx?.contact?.id
        if (!me) return { error: 'Could not tell who you are on this conversation, so no visit was started.' }
        if (action === 'start') {
          const queue = visitQueue(parseReport(c))
          if (!queue.length) return { ok: true, ref: c.ref, nothing_to_ask: true, note: 'Every required and visit-critical fact is already recorded. Say so in one line; nothing to ask.' }
          await saveVisit(store(), me, newVisit(c.id, c.ref, queue))
          return { ok: true, ref: c.ref, total_questions: queue.length, ...question(queue[0], 1, queue.length) }
        }
        const v = await visitOf(store(), me, c.id)
        if (!v) return { error: `No visit is in progress on ${c.ref} (they lapse after ${VISIT_IDLE_MS / 3600e3} hours of quiet, or none was started). Start one with action start; whatever was recorded already stays recorded.` }
        const done0 = v.recorded.length + v.skipped.length
        if (action === 'finish') {
          const notReached = v.queue
          const labels = (ks) => (ks.length ? ks.map(fieldLabel).join(', ') : 'none')
          const by = staffLabel(ctx.contact)
          const text = `VISIT SUMMARY by ${by}: recorded: ${labels(v.recorded)}; skipped (left empty): ${labels(v.skipped)}; not asked: ${labels(notReached)}`
          await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text, data: actorData(ctx, { visit_summary: true, recorded: v.recorded, skipped: v.skipped, not_asked: notReached, started_at: new Date(v.startedAt).toISOString() }) })
          await endVisit(store(), me)
          const stillMissing = missingMandatoryMinimum(parseReport(await store().getCase(c.id))).map(fieldLabel)
          return {
            ok: true, ref: c.ref, finished: true,
            readback: `Visit on ${c.ref}: saved ${labels(v.recorded)}. Left empty: ${labels([...v.skipped, ...notReached])}.`,
            still_missing_required: stillMissing,
          }
        }
        if (!v.queue.length) return { error: 'Every question has been asked. Call action finish.' }
        const field = v.queue[0]
        let saved = null
        if (action === 'next') {
          const given = cleanRelayed(answer)
          if (empty(given)) return { error: 'next needs their answer to the current question. If they cannot answer, call skip instead.', current: question(field, done0 + 1, done0 + v.queue.length) }
          const out = await editTool.handler({ case: c.ref, [field]: given }, ctx)
          if (!out.ok) return out
          v.recorded.push(field)
          saved = out.readback
        } else if (action === 'skip') {
          v.skipped.push(field)
        } else {
          return { error: 'Unknown action: use start, next, skip or finish.' }
        }
        v.queue.shift()
        const fresh = parseReport(await store().getCase(c.id))
        v.queue = v.queue.filter(k => empty(fresh[k]))
        await saveVisit(store(), me, v)
        const done = v.recorded.length + v.skipped.length
        return {
          ok: true, ref: c.ref,
          ...(saved ? { readback: saved } : { skipped: fieldLabel(field) }),
          ...(v.queue.length ? question(v.queue[0], done + 1, done + v.queue.length) : { all_asked: true, note: 'That was the last question. Call action finish and read its read-back to them.' }),
        }
      }),
    defTool('case_visit_log', 'cases',
      'Record what was DONE on a visit to ONE assigned record, from what the ranger said: when they arrived, what they did, sample ids and types, how many animals were treated. Everything is copied as they said it: never infer a time, a number, a sample id or a type; never add up or work out a count; leave out whatever they did not say. Written to the timeline as relayed by them. Not for the animal facts of the report (use case_edit for those).',
      {
        type: 'object',
        properties: {
          case: str('Record reference or id'),
          arrived_at: str('When they arrived, exactly as they said it ("9am", "just before noon")'),
          actions: { type: 'array', items: { type: 'string' }, description: 'What was done, one short entry per action, in their own words ("vaccinated 40 cattle"). Numbers only as stated.' },
          samples: {
            type: 'array',
            description: 'Samples taken: only ids and types somebody actually stated',
            items: { type: 'object', properties: { id: str('Sample id exactly as stated, for example B-117'), type: str('Sample type exactly as stated, for example blood') }, required: ['id'] },
          },
          animals_treated: str('How many animals were treated, exactly as they said it ("40 cattle", "about thirty goats"); leave out if not said'),
        },
        required: ['case'],
      },
      async ({ case: ref, arrived_at, actions, samples, animals_treated }, ctx) => {
        const r = await lookup(ctx, ref); if (r.fail) return r.fail
        const { c } = r
        const clean = (v, max = ITEM_MAX) => { return cleanRelayed(String(v ?? '')).replace(PHONE_SHAPE, 'a number').trim().slice(0, max) }
        const acts = (Array.isArray(actions) ? actions : []).map(a => clean(a)).filter(Boolean).slice(0, LIST_MAX)
        const smp = (Array.isArray(samples) ? samples : []).map(s => ({ id: clean(s?.id, 40), type: clean(s?.type, 40) })).filter(s => s.id).slice(0, LIST_MAX)
        const arrived = clean(arrived_at, 60)
        const treated = clean(animals_treated, 120)
        if (!arrived && !acts.length && !smp.length && !treated) return { error: 'Nothing to record: they did not say when they arrived, what was done, any samples, or how many animals were treated.' }
        const treatedCount = treated ? statedCount(treated) : null
        if (smp.length) {
          const edited = await editTool.handler({ case: c.ref, samples: smp.map(s => (s.type ? `${s.id} (${s.type})` : s.id)).join('; ') }, ctx)
          if (!edited.ok) return edited
        }
        const by = staffLabel(ctx.contact)
        const bits = [
          arrived ? `arrived ${arrived}` : '',
          ...acts,
          smp.length ? `samples ${smp.map(s => (s.type ? `${s.id} (${s.type})` : s.id)).join(', ')}` : '',
          treated ? `animals treated: ${treated}` : '',
        ].filter(Boolean)
        await store().appendEvent(c.id, {
          kind: 'action', actor: 'operator',
          text: `VISIT LOG by ${by}: ${bits.join('; ')}`,
          data: actorData(ctx, { visit_log: true, on_behalf: true, relayed_by: by, ...(arrived ? { arrived_at: arrived } : {}), actions: acts, samples: smp, ...(treated ? { animals_treated: treated, animals_treated_count: treatedCount } : {}) }),
        })
        return { ok: true, ref: c.ref, readback: `Visit logged: ${bits.map(b => spoken(b, 120)).join('; ')}` }
      }),
  ]
}
