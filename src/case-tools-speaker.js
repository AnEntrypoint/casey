// case-tools-speaker.js -- case_speaker: who is writing on this phone.
//
// Several people can share one WhatsApp number (a family, neighbours, a herd boy
// borrowing the phone), so the number names a chat, not a person. The MODEL reads what
// people write, in any language, and calls this when it learns who is writing: someone
// introduces themselves, says "this is my wife", "it is Nomsa now", or answers "who am
// I speaking with?". Nothing here reads a message or matches a word, and the tool
// never guesses a name: a name is stored exactly as the person said it, and a person
// nobody named is never invented.
//
// In REPORT_ONLY_TOOLS (case-tools-gates.js), so every tier has it. The result carries
// no phone number and no contact id: the person writing now, the others known on this
// phone (so the model can ask "is this Sipho or someone else?"), and who gave the open
// report (so it can start a new one when someone else is writing).
//
// Appended after case-tools-feedback.js in case-tools.js, so the pinned order of the
// earlier tools is untouched.

import { defTool, str, boundCase } from './case-tools-shared.js'
import { evData } from './safe.js'
import { REPORT_ENTITY_LABEL } from './store/report-shape.js'
import {
  speakerState, addPerson, setSpeaker, reporterOfCase, MAX_NAME, MAX_RELATION,
} from './phone-persons.js'

const REENABLE_WINDOW_MS = 15 * 60e3
const slim = (p) => (p ? { id: p.id, name: p.name, ...(p.relation ? { relation: p.relation } : {}) } : null)

// A HELP that switched a stopped phone back on was written before anyone was asked who wrote it. Once the
// model has learned who it was, say so on the timeline (the person who re-enabled the phone is recorded).
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
      await store.appendEvent(caseId, { kind: 'observation', actor: 'system', text: 'OPT-BACK-IN-BY: the person who asked for help after the phone had opted out was identified', data: { opt_back_in_by: person.id }, touch: false })
      return true
    }
  }
  return false
}

export function buildSpeakerTools(store) {
  return [
    defTool('case_speaker', 'cases',
      `Record WHO is writing right now on this phone. Several people can share one phone (a family, neighbours, someone borrowing it), so call this whenever you learn who is writing: they tell you their name, say who they are ("this is my wife", "it is Nomsa now", "the herd boy here"), say the writing has changed hands, or answer when you asked who you are speaking with. Pass the name EXACTLY as they wrote it and, if they said it, how they are related or who they are ("wife", "neighbour", "herd boy") in their own words. Never guess or invent a name, never take a name from anywhere except what this person wrote in this chat. Pass same_as_before true when they confirm they are the person who was writing before, or person_id (from an earlier result) for someone already known. Call it with no arguments to see who is known on this phone. The result lists the person writing now, the others known on this phone (so you can ask "is this <name> or someone else?"), and who gave the open ${REPORT_ENTITY_LABEL}. It never shows a phone number.`,
      {
        type: 'object',
        properties: {
          name: str(`Their name exactly as they said it (max ${MAX_NAME} characters)`),
          relation: str(`How they are related or who they are, in their own words, if they said it (max ${MAX_RELATION} characters)`),
          same_as_before: { type: 'boolean', description: 'True when they confirm they are the same person who was writing before' },
          person_id: str('The id of someone already known on this phone, from an earlier result'),
        },
      },
      async ({ name, relation, same_as_before, person_id } = {}, ctx) => {
        const s = store()
        const contactId = ctx?.contact?.id
        if (!contactId) return { ok: false, note: 'Nobody could be recorded from here. Carry on with the conversation.' }
        const bound = boundCase(ctx)
        let state = await speakerState(s, contactId)
        let created = false
        let target = null
        if (person_id) {
          target = state.people.find(p => p.id === String(person_id)) || null
          if (!target) return { ok: false, note: 'That person is not known on this phone. Ask who is writing, in your own words, and use the name they give.' }
        } else if (same_as_before === true) {
          target = state.current || state.previous || null
          if (!target) return { ok: false, note: 'Nobody has been recorded on this phone yet. Ask who is writing, in your own words, and use the name they give.' }
        } else if (typeof name === 'string' && name.trim()) {
          const r = await addPerson(s, contactId, { name, relation: relation || '', by: 'model' })
          if (!r.ok) {
            return { ok: false, note: r.reason === 'too_many'
              ? 'This phone already has as many people recorded as can be kept. Carry on with the conversation without recording another.'
              : 'That was not a name. Ask who is writing, in your own words, and use exactly the name they give.' }
          }
          target = r.person; created = r.created
        }
        let attributed = false
        if (target) {
          const set = await setSpeaker(s, contactId, target.id, { by: 'model' })
          if (!set.ok) return { ok: false, note: 'That could not be recorded. Carry on with the conversation.' }
          attributed = await attributeReenable(s, bound.id, target).catch(() => false)
        }
        state = await speakerState(s, contactId)
        // Who gave the open report, so the model can start a new one when someone else is writing. Nothing is
        // stamped here: a report is attributed when it is opened or written (case_new, case_report), so a person
        // named before any fact is recorded does not claim a report the next person then fills in.
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
          ? `Recorded${cur ? ` that ${cur.name} is writing` : ''}. `
            + (openReport && openReport.is_this_person === false
              ? `The open ${REPORT_ENTITY_LABEL} was given by someone else on this phone: if this person is describing different animals or a different place, start a new ${REPORT_ENTITY_LABEL}; only keep recording into it if they say it is the same animals. `
              : '')
            + `Never tell this person another person's name, what they said, or any contact detail. You may say that a ${REPORT_ENTITY_LABEL} exists, its reference, and which animals it is about. Continue in their language.`
          : (state.count > 1
            ? `More than one person is known on this phone and nobody is recorded as writing now. Ask ONCE, warmly, who you are speaking with (you may offer the names in others_on_this_phone as choices, and never say anything more about them). When they answer, call this again with their name.`
            : `Nobody is recorded as writing. If a person tells you who they are, record it.`)
        return out
      }),
  ]
}
