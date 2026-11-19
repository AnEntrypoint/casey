

import { REPORT_ENTITY_LABEL } from './store/report-shape.js'
import { parseReport, tagList } from './timestamp.js'
import {
  defTool, str, ownsCase, enquiryRow, boundCase, rebindActiveCase,
} from './case-tools-shared.js'
import { canQueryCases } from './contact-tiers.js'
import { stampReporter } from './phone-persons.js'
import { returnGate } from './return-clarify.js'
import { caseyText } from './deployment-text.js';

async function stampSpeaker(store, ctx, caseId) {
  if (!ctx?.contact?.id || canQueryCases(ctx?.tier)) return
  try { await stampReporter(store(), ctx.contact.id, caseId) } catch {  }
}

function hasReportContent(caseRow) {
  if (!caseRow) return false
  const rep = parseReport(caseRow)
  return Object.values(rep || {}).some(v => v != null && String(v).trim() !== '')
}

async function hasAgentRecordedAction(store, caseId) {
  try {
    const events = await store().listEvents(caseId, { limit: 200 })
    return (events || []).some(e => e?.kind === 'action' && e?.actor === 'agent')
  } catch { return true }
}

export function buildBindingTools(store) {
  return [

    defTool('case_new', 'cases',
      caseyText("src/case-tools-binding.js#0", [REPORT_ENTITY_LABEL, REPORT_ENTITY_LABEL]),
      { type: 'object', properties: { subject: str(caseyText("src/case-tools-binding.js#s0")) } },
      async ({ subject }, ctx) => {

        if (ctx?.contact?.id && !canQueryCases(ctx?.tier)) { const held = await returnGate(store(), ctx); if (held) return held }
        const author = ctx?.author || ctx?.principal?.id
        if (!store().createCase) return { error: caseyText("src/case-tools-binding.js#1") }

        const currentBound = boundCase(ctx).id
        const current = currentBound ? await store().getCase(currentBound) : null
        const channel = current?.channel || ctx?.channel || 'other'
        const external_id = current?.external_id
        if (!external_id) return { error: caseyText("src/case-tools-binding.js#2") }

        const currentIsFresh = current
          && (!hasReportContent(current) || !(await hasAgentRecordedAction(store, current.id)))

        if (currentIsFresh) {
          rebindActiveCase(ctx, current)
          await stampSpeaker(store, ctx, current.id)
          return {
            ok: true,
            activeCase: enquiryRow(current),
            reused_empty_active_case: true,

            note: caseyText("src/case-tools-binding.js#3", [REPORT_ENTITY_LABEL, REPORT_ENTITY_LABEL]),
          }
        }

        const inheritedIntakeTags = tagList(current).filter(t => t.startsWith('intake_mode:')).join(',')
        const c = await store().createCase({ channel, external_id, subject: subject || '', contact_id: current?.contact_id || '', tags: inheritedIntakeTags })
        await store().appendEvent(c.id, { kind: 'note', actor: 'system', text: caseyText("src/case-tools-binding.js#4", [author || 'unknown']) })

        rebindActiveCase(ctx, c)
        await stampSpeaker(store, ctx, c.id)
        return { ok: true, activeCase: enquiryRow(c) }
      }),

    defTool('case_switch', 'cases',
      caseyText("src/case-tools-binding.js#5"),
      { type: 'object', properties: { ref: str(caseyText("src/case-tools-binding.js#6")) }, required: ['ref'] },
      async ({ ref }, ctx) => {
        const author = ctx?.author || ctx?.principal?.id
        const team = canQueryCases(ctx?.tier)
        if (!author && !team) return { error: caseyText("src/case-tools-binding.js#7") }
        const target = typeof store().getCaseByRef === 'function'
          ? await store().getCaseByRef(ref)
          : (await store().listCases({}, { limit: 500 })).find(c => c.ref === ref)
        if (!target) return { error: caseyText("src/case-tools-binding.js#s1", [ref]) }
        if (target.channel === 'system') return { error: caseyText("src/case-tools-binding.js#s2", [ref]) }
        if (!ownsCase(target.external_id, author) && !team) {
          return { error: caseyText("src/case-tools-binding.js#8", [ref]) }
        }

        rebindActiveCase(ctx, target)

        return { ok: true, activeCase: enquiryRow(target), switchedToRef: target.ref }
      }),
  ]
}
