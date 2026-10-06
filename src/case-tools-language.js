import { defTool, str } from './case-tools-shared.js'
import { parseReport } from './timestamp.js'
import { focusOf } from './team-focus.js'
import { REPORT_ENTITY_LABEL } from './store/report-shape.js'
import { NOT_ASSIGNED, findCase, deskAuthorityOn } from './case-tools-team-shared.js'
import { translateEvent, TranslateError } from './translate.js'
import { scrubNumbers } from './relay.js'
import { firstTimeStaff, markOnboarded, helpFor } from './staff-help.js'

const NO_SUCH = { error: 'No such record. Ask for the reference again.' }

async function rangerLanguage(store, contact) {
  const own = await store.findOpenCase({ channel: contact.channel, external_id: contact.external_id })
  return String(parseReport(own).language_detected || '').trim()
}

async function targetEvent(store, c, which) {
  if (!which || String(which).toLowerCase() === 'last') {
    const events = await store.listEvents(c.id)
    return events.filter(e => e.kind === 'inbound' && e.actor === 'contact' && String(e.text || '').trim()).at(-1) || null
  }
  const ev = await store.t.get('event', which).catch(() => null)
  return ev && ev.case_id === c.id ? ev : null
}

export function buildLanguageTools(store, { callLLM } = {}) {
  return [
    defTool('case_translate', 'cases',
      `Translate what the reporter wrote on ONE ${REPORT_ENTITY_LABEL} this team member holds (or is on the desk for) into the language they ask for, so they can read it or answer in kind. Use when they ask what the farmer said or ask to hear it in another language ("say it in isiZulu"). By default it is the reporter's LATEST message and the team member's own language. The result is machine translation: tell them it may be wrong, and say which language the original was in. Only the reporter's own messages are translated; never anything the team wrote. Omit \`case\` to use the record they are on.`,
      { type: 'object', properties: { case: str('Record reference or id; omit for the record they are focused on'), event: str('"last" (default) or a message id from an earlier result'), to: str('Language to translate into, by name (e.g. isiZulu); omit for the language they are writing in') } },
      async ({ case: ref, event: which, to }, ctx) => {
        const me = ctx?.contact
        if (!me?.id) return { error: 'Could not tell who you are on this conversation.' }
        let c = null
        if (ref) { c = await findCase(store(), ref); if (!c) return NO_SUCH }
        else {
          const f = await focusOf(store(), me.id)
          c = f ? await findCase(store(), f.caseId) : null
          if (!c) return { error: 'Which record? Ask them for the reference.' }
        }
        if (!deskAuthorityOn(ctx, c)) return NOT_ASSIGNED
        const target = String(to || '').trim() || await rangerLanguage(store(), me)
        if (!target) return { error: 'Which language should it be translated into? Ask them.' }
        const ev = await targetEvent(store(), c, which)
        if (!ev) return { error: 'There is no message from the reporter on that record to translate.' }
        try {
          const out = await translateEvent({ store: store(), caseRow: c, ev, to: target, callLLM, rateKey: `contact:${me.id}`, requestedBy: me.id })
          return { ok: true, ref: c.ref, message_id: ev.id, translated_into: out.to, original_language: out.language || 'unknown', translation: scrubNumbers(out.text), label: out.label, cached: out.cached }
        } catch (e) {
          if (e instanceof TranslateError) return { ok: false, error: e.message, code: e.code }
          throw e
        }
      }),
    defTool('case_help', 'cases',
      'What this team member can say to you, as short example phrases for their role, and a first-time welcome. Call it when they ask for help, what you can do, how this works, or when a note says this is their first time. Give 3 to 5 of the examples that fit what they asked, in THEIR language (the examples are written in English; translate them). When first_time is true, also give the onboarding in a few short sentences. Nothing here is a list to read out whole.',
      { type: 'object', properties: {} },
      async (_args, ctx) => {
        const me = ctx?.contact
        if (!me?.id) return { error: 'Could not tell who you are on this conversation.' }
        const first = await firstTimeStaff(store(), me)
        const { examples, onboarding } = helpFor(ctx.tier)
        if (first) await markOnboarded(store(), me)
        return { first_time: first, ...(first && onboarding ? { onboarding } : {}), examples, note: 'Examples are in English: say them in the language the person is writing in.' }
      }),
  ]
}
