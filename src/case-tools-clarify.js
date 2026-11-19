

import { defTool, boundCase, str } from './case-tools-shared.js'
import { returnState, recordClarified } from './return-clarify.js'
import { speakerState, addPerson, setSpeaker, MAX_NAME } from './phone-persons.js'
import { caseyText } from './deployment-text.js';

export function buildClarifyTools(store) {
  return [
    defTool('case_clarify', 'cases',
      caseyText("src/case-tools-clarify.js#0"),
      {
        type: 'object',
        properties: {
          same_report: { type: 'boolean', description: caseyText("src/case-tools-clarify.js#1") },
          name: str(caseyText("src/case-tools-clarify.js#2", [MAX_NAME])),
          same_person: { type: 'boolean', description: caseyText("src/case-tools-clarify.js#3") },
        },
        required: ['same_report'],
      },
      async ({ same_report, name, same_person } = {}, ctx) => {
        if (typeof same_report !== 'boolean') return { ok: false, note: caseyText("src/case-tools-clarify.js#4") }
        const bound = boundCase(ctx)
        const contactId = ctx?.contact?.id
        if (!bound.id || !contactId) return { ok: false, note: caseyText("src/case-tools-clarify.js#5") }
        const s = store()
        return s._withLock(`case_clarify|${bound.id}`, async () => {
          const caseRow = await s.getCase(bound.id)
          const st = await returnState(s, caseRow, ctx.contact)
          if (!st.owed) return { ok: true, already: true, note: caseyText("src/case-tools-clarify.js#6") }
          const state = await speakerState(s, contactId)
          let target = null
          let nameNote = ''
          if (typeof name === 'string' && name.trim()) {
            const r = await addPerson(s, contactId, { name, by: 'model' })
            if (r.ok) target = r.person
            else nameNote = r.reason === 'too_many'
              ? caseyText("src/case-tools-clarify.js#7")
              : caseyText("src/case-tools-clarify.js#8")
          } else if (same_person === true) {
            target = state.current || state.previous || state.people[0] || null
          }
          if (target) {
            const set = await setSpeaker(s, contactId, target.id, { by: 'model' })
            if (!set.ok) return { ok: false, note: caseyText("src/case-tools-clarify.js#9") }
          }
          await recordClarified(s, bound.id, same_report)
          const whoNote = target ? '' : caseyText("src/case-tools-clarify.js#10")
          return same_report
            ? { ok: true, note: caseyText("src/case-tools-clarify.js#11") + whoNote + nameNote }
            : { ok: true, note: caseyText("src/case-tools-clarify.js#12") + whoNote + nameNote }
        })
      },
    ),
  ]
}
