import { defTool, str } from './case-tools-shared.js'
import { parseReport } from './timestamp.js'
import { focusOf } from './team-focus.js'
import { REPORT_ENTITY_LABEL } from './store/report-shape.js'
import { NOT_ASSIGNED, findCase, deskAuthorityOn } from './case-tools-team-shared.js'
import { translateEvent, TranslateError } from './translate.js'
import { scrubNumbers } from './relay.js'
import { firstTimeStaff, markOnboarded, helpFor } from './staff-help.js'
import { caseyText } from './deployment-text.js';

const NO_SUCH = { error: caseyText("src/case-tools-language.js#0") }

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
      caseyText("src/case-tools-language.js#1", [REPORT_ENTITY_LABEL]),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-language.js#2")), event: str(caseyText("src/case-tools-language.js#3")), to: str(caseyText("src/case-tools-language.js#4")) } },
      async ({ case: ref, event: which, to }, ctx) => {
        const me = ctx?.contact
        if (!me?.id) return { error: caseyText("src/case-tools-language.js#5") }
        let c = null
        if (ref) { c = await findCase(store(), ref); if (!c) return NO_SUCH }
        else {
          const f = await focusOf(store(), me.id)
          c = f ? await findCase(store(), f.caseId) : null
          if (!c) return { error: caseyText("src/case-tools-language.js#6") }
        }
        if (!deskAuthorityOn(ctx, c)) return NOT_ASSIGNED
        const target = String(to || '').trim() || await rangerLanguage(store(), me)
        if (!target) return { error: caseyText("src/case-tools-language.js#7") }
        const ev = await targetEvent(store(), c, which)
        if (!ev) return { error: caseyText("src/case-tools-language.js#8") }
        try {
          const out = await translateEvent({ store: store(), caseRow: c, ev, to: target, callLLM, rateKey: `contact:${me.id}`, requestedBy: me.id })
          return { ok: true, ref: c.ref, message_id: ev.id, translated_into: out.to, original_language: out.language || 'unknown', translation: scrubNumbers(out.text), label: out.label, cached: out.cached }
        } catch (e) {
          if (e instanceof TranslateError) return { ok: false, error: e.message, code: e.code }
          throw e
        }
      }),
    defTool('case_help', 'cases',
      caseyText("src/case-tools-language.js#9"),
      { type: 'object', properties: {} },
      async (_args, ctx) => {
        const me = ctx?.contact
        if (!me?.id) return { error: caseyText("src/case-tools-language.js#10") }
        const first = await firstTimeStaff(store(), me)
        const { examples, onboarding } = helpFor(ctx.tier)
        if (first) await markOnboarded(store(), me)
        return { first_time: first, ...(first && onboarding ? { onboarding } : {}), examples, note: caseyText("src/case-tools-language.js#11") }
      }),
  ]
}
