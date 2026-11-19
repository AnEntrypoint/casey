

import { defTool, str, boundCase } from './case-tools-shared.js'
import { evData } from './safe.js'
import { REPORT_ENTITY_LABEL } from './store/report-shape.js'
import {
  speakerState, addPerson, setSpeaker, reporterOfCase, MAX_NAME, MAX_RELATION,
} from './phone-persons.js'
import { caseyText } from './deployment-text.js';

const REENABLE_WINDOW_MS = 15 * 60e3
const slim = (p) => (p ? { id: p.id, name: p.name, ...(p.relation ? { relation: p.relation } : {}) } : null)

async function attributeReenable(store, caseId, person) {
  if (!caseId || !person) return false
  let events = []
  try { events = await store.listEvents(caseId, { limit: 400 }) } catch { return false }
  const now = Date.now()
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    const d = evData(e)
    if (d.opt_back_in_by) return false
    if (d.opt_back_in === true) {
      const at = Number(e.created_at) * 1000
      if (!Number.isFinite(at) || now - at > REENABLE_WINDOW_MS) return false
      await store.appendEvent(caseId, { kind: 'observation', actor: 'system', text: caseyText("src/case-tools-speaker.js#0"), data: { opt_back_in_by: person.id }, touch: false })
      return true
    }
  }
  return false
}

export function buildSpeakerTools(store) {
  return [
    defTool('case_speaker', 'cases',
      caseyText("src/case-tools-speaker.js#1", [REPORT_ENTITY_LABEL]),
      {
        type: 'object',
        properties: {
          name: str(caseyText("src/case-tools-speaker.js#2", [MAX_NAME])),
          relation: str(caseyText("src/case-tools-speaker.js#3", [MAX_RELATION])),
          same_as_before: { type: 'boolean', description: caseyText("src/case-tools-speaker.js#4") },
          person_id: str(caseyText("src/case-tools-speaker.js#5")),
        },
      },
      async ({ name, relation, same_as_before, person_id } = {}, ctx) => {
        const s = store()
        const contactId = ctx?.contact?.id
        if (!contactId) return { ok: false, note: caseyText("src/case-tools-speaker.js#6") }
        const bound = boundCase(ctx)
        let state = await speakerState(s, contactId)
        let created = false
        let target = null
        if (person_id) {
          target = state.people.find(p => p.id === String(person_id)) || null
          if (!target) return { ok: false, note: caseyText("src/case-tools-speaker.js#7") }
        } else if (same_as_before === true) {
          target = state.current || state.previous || null
          if (!target) return { ok: false, note: caseyText("src/case-tools-speaker.js#8") }
        } else if (typeof name === 'string' && name.trim()) {
          const r = await addPerson(s, contactId, { name, relation: relation || '', by: 'model' })
          if (!r.ok) {
            return { ok: false, note: r.reason === 'too_many'
              ? caseyText("src/case-tools-speaker.js#9")
              : caseyText("src/case-tools-speaker.js#10") }
          }
          target = r.person; created = r.created
        }
        let attributed = false
        if (target) {
          const set = await setSpeaker(s, contactId, target.id, { by: 'model' })
          if (!set.ok) return { ok: false, note: caseyText("src/case-tools-speaker.js#11") }
          attributed = await attributeReenable(s, bound.id, target).catch(() => false)
        }
        state = await speakerState(s, contactId)

        let openReport = null
        if (bound.id) {
          const c = await s.getCase(bound.id).catch(() => null)
          if (c && c.channel !== 'system') {
            const by = await reporterOfCase(s, contactId, c.id)
            openReport = {
              reference: c.ref,
              given_by: by ? slim(by) : null,
              is_this_person: !state.current ? null : by ? by.id === state.current.id : null,
            }
          }
        }
        const others = state.people.filter(p => !state.current || p.id !== state.current.id)
        const cur = state.current
        const out = {
          ok: true,
          current: cur ? slim(cur) : null,
          others_on_this_phone: others.map(slim),
          people_on_this_phone: state.count,
          ...(created ? { newly_recorded: true } : {}),
          ...(attributed ? { restart_noted: true } : {}),
          ...(openReport ? { open_report: openReport } : {}),
        }
        out.note = target
          ? `Recorded${cur ? caseyText("src/case-tools-speaker.js#s0", [cur.name]) : ''}. `
            + (openReport && openReport.is_this_person === false
              ? caseyText("src/case-tools-speaker.js#12", [REPORT_ENTITY_LABEL, REPORT_ENTITY_LABEL])
              : '')
            + caseyText("src/case-tools-speaker.js#13", [REPORT_ENTITY_LABEL])
          : (state.count > 1
            ? caseyText("src/case-tools-speaker.js#14")
            : caseyText("src/case-tools-speaker.js#15"))
        return out
      }),
  ]
}
