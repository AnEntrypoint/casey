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
import { caseyText } from './deployment-text.js';
import { TOOL_ARG, treatedFields } from './tool-arguments.js'

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
  how: caseyText("src/case-tools-visit.js#0"),
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
      if (out.recorded.includes('lat')) parts.push(caseyText("src/case-tools-visit.js#s0"))
      if (out.noted) parts.push('a note')
      if (!parts.length) return out
      return { ...out, readback: `Saved: ${parts.join(', ')}` }
    },
  }
}

export function buildVisitTools(store, editTool) {
  const lookup = async (ctx, ref) => {
    const c = await findCase(store(), ref)
    if (!c) return { fail: { error: caseyText("src/case-tools-visit.js#1") } }
    if (authorityOn(ctx, c) !== 'assigned') return { fail: NOT_ASSIGNED }
    if (!isOpenCase(c)) return { fail: { error: caseyText("src/case-tools-visit.js#2") } }
    const refused = await writeGate(store(), ctx, c)
    if (refused) return { fail: refused }
    return { c }
  }

  return [
    defTool('case_visit', 'cases',
      caseyText("src/case-tools-visit.js#3"),
      {
        type: 'object',
        properties: {
          case: str(caseyText("src/case-tools-visit.js#s1")),
          action: str(caseyText("src/case-tools-visit.js#s2"), { enum: ['start', 'next', 'skip', 'finish'] }),
          answer: str(caseyText("src/case-tools-visit.js#4")),
        },
        required: ['case', 'action'],
      },
      async ({ case: ref, action, answer }, ctx) => {
        const r = await lookup(ctx, ref); if (r.fail) return r.fail
        const { c } = r
        const me = ctx?.contact?.id
        if (!me) return { error: caseyText("src/case-tools-visit.js#5") }
        if (action === 'start') {
          const queue = visitQueue(parseReport(c))
          if (!queue.length) return { ok: true, ref: c.ref, nothing_to_ask: true, note: caseyText("src/case-tools-visit.js#6") }
          await saveVisit(store(), me, newVisit(c.id, c.ref, queue))
          return { ok: true, ref: c.ref, total_questions: queue.length, ...question(queue[0], 1, queue.length) }
        }
        const v = await visitOf(store(), me, c.id)
        if (!v) return { error: caseyText("src/case-tools-visit.js#7", [c.ref, VISIT_IDLE_MS / 3600e3]) }
        const done0 = v.recorded.length + v.skipped.length
        if (action === 'finish') {
          const notReached = v.queue
          const labels = (ks) => (ks.length ? ks.map(fieldLabel).join(', ') : 'none')
          const by = staffLabel(ctx.contact)
          const text = caseyText("src/case-tools-visit.js#8", [by, labels(v.recorded), labels(v.skipped), labels(notReached)])
          await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text, data: actorData(ctx, { visit_summary: true, recorded: v.recorded, skipped: v.skipped, not_asked: notReached, started_at: new Date(v.startedAt).toISOString() }) })
          await endVisit(store(), me)
          const stillMissing = missingMandatoryMinimum(parseReport(await store().getCase(c.id))).map(fieldLabel)
          return {
            ok: true, ref: c.ref, finished: true,
            readback: caseyText("src/case-tools-visit.js#s3", [c.ref, labels(v.recorded), labels([...v.skipped, ...notReached])]),
            still_missing_required: stillMissing,
          }
        }
        if (!v.queue.length) return { error: caseyText("src/case-tools-visit.js#9") }
        const field = v.queue[0]
        let saved = null
        if (action === 'next') {
          const given = cleanRelayed(answer)
          if (empty(given)) return { error: caseyText("src/case-tools-visit.js#10"), current: question(field, done0 + 1, done0 + v.queue.length) }
          const out = await editTool.handler({ case: c.ref, [field]: given }, ctx)
          if (!out.ok) return out
          v.recorded.push(field)
          saved = out.readback
        } else if (action === 'skip') {
          v.skipped.push(field)
        } else {
          return { error: caseyText("src/case-tools-visit.js#11") }
        }
        v.queue.shift()
        const fresh = parseReport(await store().getCase(c.id))
        v.queue = v.queue.filter(k => empty(fresh[k]))
        await saveVisit(store(), me, v)
        const done = v.recorded.length + v.skipped.length
        return {
          ok: true, ref: c.ref,
          ...(saved ? { readback: saved } : { skipped: fieldLabel(field) }),
          ...(v.queue.length ? question(v.queue[0], done + 1, done + v.queue.length) : { all_asked: true, note: caseyText("src/case-tools-visit.js#12") }),
        }
      }),
    defTool('case_visit_log', 'cases',
      caseyText("src/case-tools-visit.js#13"),
      {
        type: 'object',
        properties: {
          case: str(caseyText("src/case-tools-visit.js#s4")),
          arrived_at: str(caseyText("src/case-tools-visit.js#14")),
          actions: { type: 'array', items: { type: 'string' }, description: caseyText("src/case-tools-visit.js#15") },
          samples: {
            type: 'array',
            description: caseyText("src/case-tools-visit.js#16"),
            items: { type: 'object', properties: { id: str(caseyText("src/case-tools-visit.js#17")), type: str(caseyText("src/case-tools-visit.js#18")) }, required: ['id'] },
          },
          [TOOL_ARG.treated_count]: str(caseyText("src/case-tools-visit.js#19")),
        },
        required: ['case'],
      },
      async (args, ctx) => {
        const { case: ref, arrived_at, actions, samples } = args
        const treatedInput = args[TOOL_ARG.treated_count]
        const r = await lookup(ctx, ref); if (r.fail) return r.fail
        const { c } = r
        const clean = (v, max = ITEM_MAX) => { return cleanRelayed(String(v ?? '')).replace(PHONE_SHAPE, 'a number').trim().slice(0, max) }
        const acts = (Array.isArray(actions) ? actions : []).map(a => clean(a)).filter(Boolean).slice(0, LIST_MAX)
        const smp = (Array.isArray(samples) ? samples : []).map(s => ({ id: clean(s?.id, 40), type: clean(s?.type, 40) })).filter(s => s.id).slice(0, LIST_MAX)
        const arrived = clean(arrived_at, 60)
        const treated = clean(treatedInput, 120)
        if (!arrived && !acts.length && !smp.length && !treated) return { error: caseyText("src/case-tools-visit.js#20") }
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
          treated ? caseyText("src/case-tools-visit.js#s5", [treated]) : '',
        ].filter(Boolean)
        await store().appendEvent(c.id, {
          kind: 'action', actor: 'operator',
          text: caseyText("src/case-tools-visit.js#s6", [by, bits.join('; ')]),
          data: actorData(ctx, { visit_log: true, on_behalf: true, relayed_by: by, ...(arrived ? { arrived_at: arrived } : {}), actions: acts, samples: smp, ...(treated ? treatedFields(treated, treatedCount) : {}) }),
        })
        return { ok: true, ref: c.ref, readback: caseyText("src/case-tools-visit.js#s7", [bits.map(b => spoken(b, 120)).join('; ')]) }
      }),
  ]
}
