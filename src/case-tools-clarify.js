

import { defTool, boundCase, str } from './case-tools-shared.js'
import { returnState, recordClarified } from './return-clarify.js'
import { speakerState, addPerson, setSpeaker, MAX_NAME } from './phone-persons.js'

export function buildClarifyTools(store) {
  return [
    defTool('case_clarify', 'cases',
      `Record the person's answer after they came back to a report that is already complete. You asked them, in one question, whether this is MORE about that report or a NEW problem, and who is writing. Call it ONLY once they have answered: same_report true when it is more about the same report, false when it is a new problem; and who is writing, either name (exactly as they said it) or same_person true when they confirm they are the person already on file. If they have plainly answered the same-or-new part (a different place, or a new sick animal) but have not said who is writing, call it anyway with same_report: the who-is-writing answer is not required to record it, and the new report opens either way. Never call it on a guess or before they answered. Until it has been called, case_report and case_new write nothing.`,
      {
        type: 'object',
        properties: {
          same_report: { type: 'boolean', description: 'True if it is more about the same report, false if it is a new problem' },
          name: str(`Who is writing, exactly as they said it (max ${MAX_NAME} characters), when they gave a name`),
          same_person: { type: 'boolean', description: 'True when they confirm they are the person already on file for this report' },
        },
        required: ['same_report'],
      },
      async ({ same_report, name, same_person } = {}, ctx) => {
        if (typeof same_report !== 'boolean') return { ok: false, note: 'Say whether it is the same report or a new problem, and only after they have answered.' }
        const bound = boundCase(ctx)
        const contactId = ctx?.contact?.id
        if (!bound.id || !contactId) return { ok: false, note: 'Nothing could be recorded from here. Carry on with the conversation.' }
        const s = store()
        const caseRow = await s.getCase(bound.id)
        const st = await returnState(s, caseRow, ctx.contact)
        if (!st.owed) return { ok: true, already: true, note: 'Nothing is waiting to be clarified. Carry on.' }
        const state = await speakerState(s, contactId)
        let target = null
        let nameNote = ''
        if (typeof name === 'string' && name.trim()) {
          const r = await addPerson(s, contactId, { name, by: 'model' })
          if (r.ok) target = r.person
          else nameNote = r.reason === 'too_many'
            ? ' This phone already has as many people recorded as can be kept; ask who is writing again and use a name already on file, or same_person true when they confirm the person on file.'
            : ' That was not a name; ask who is writing again, in your own words, and use exactly the name they give.'
        } else if (same_person === true) {
          target = state.current || state.previous || state.people[0] || null
        }
        if (target) {
          const set = await setSpeaker(s, contactId, target.id, { by: 'model' })
          if (!set.ok) return { ok: false, note: 'That could not be recorded. Carry on with the conversation.' }
        }
        await recordClarified(s, bound.id, same_report)
        const whoNote = target ? '' : ' You still do not know who is writing: ask that once, in your own words, as part of your reply.'
        return same_report
          ? { ok: true, note: 'Recorded. It is more about the same report: record what they add on it with case_report, then answer them as usual. Do not ask again whether it is the same or new.' + whoNote + nameNote }
          : { ok: true, note: 'Recorded. It is a NEW problem: call case_new now, then record what they tell you on that new report. Do not ask again whether it is the same or new.' + whoNote + nameNote }
      },
    ),
  ]
}
