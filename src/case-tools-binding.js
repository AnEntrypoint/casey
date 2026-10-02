

import { REPORT_ENTITY_LABEL } from './store/report-shape.js'
import { parseReport, tagList } from './timestamp.js'
import {
  defTool, str, ownsCase, enquiryRow, boundCase, rebindActiveCase,
} from './case-tools-shared.js'
import { canQueryCases } from './contact-tiers.js'
import { stampReporter } from './phone-persons.js'
import { returnGate } from './return-clarify.js'

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
      `Start a NEW ${REPORT_ENTITY_LABEL} for this person and record into that one from now on. Use ONLY when they are clearly starting a fresh ${REPORT_ENTITY_LABEL} (different animals, a different place, a different incident), never on your own initiative.`,
      { type: 'object', properties: { subject: str('Optional short subject') } },
      async ({ subject }, ctx) => {

        if (ctx?.contact?.id && !canQueryCases(ctx?.tier)) { const held = await returnGate(store(), ctx); if (held) return held }
        const author = ctx?.author || ctx?.principal?.id
        if (!store().createCase) return { error: 'store does not support explicit case creation' }

        const currentBound = boundCase(ctx).id
        const current = currentBound ? await store().getCase(currentBound) : null
        const channel = current?.channel || ctx?.channel || 'other'
        const external_id = current?.external_id
        if (!external_id) return { error: 'no conversation identity on this turn -- cannot bind a new case' }

        const currentIsFresh = current
          && (!hasReportContent(current) || !(await hasAgentRecordedAction(store, current.id)))

        if (currentIsFresh) {
          rebindActiveCase(ctx, current)
          await stampSpeaker(store, ctx, current.id)
          return {
            ok: true,
            activeCase: enquiryRow(current),
            reused_empty_active_case: true,

            note: `This ${REPORT_ENTITY_LABEL} is still empty, so it is the one to record into now and nothing new was needed. This is not a limit of one: if they have also told you about a SEPARATE situation, record the first one here, then start a new ${REPORT_ENTITY_LABEL} for the other -- that works normally once this one holds facts. Never tell the person any of this.`,
          }
        }

        const inheritedIntakeTags = tagList(current).filter(t => t.startsWith('intake_mode:')).join(',')
        const c = await store().createCase({ channel, external_id, subject: subject || '', contact_id: current?.contact_id || '', tags: inheritedIntakeTags })
        await store().appendEvent(c.id, { kind: 'note', actor: 'system', text: `case explicitly opened for a fresh report by ${author || 'unknown'}` })

        rebindActiveCase(ctx, c)
        await stampSpeaker(store, ctx, c.id)
        return { ok: true, activeCase: enquiryRow(c) }
      }),

    defTool('case_switch', 'cases',
      'Re-bind the conversation to a DIFFERENT open case by ref (e.g. "CASE-1042-K7M2NPQR"). A registered team member may continue ANY case, including one the public reported; anyone below that may switch only to a case of their own. Use when they name a case they want to continue, other than the one currently active. Tell them in your own words that you have moved to it.',
      { type: 'object', properties: { ref: str('The case ref to switch to, e.g. CASE-1042-K7M2NPQR') }, required: ['ref'] },
      async ({ ref }, ctx) => {
        const author = ctx?.author || ctx?.principal?.id
        const team = canQueryCases(ctx?.tier)
        if (!author && !team) return { error: 'no author on this turn -- cannot resolve ownership for a switch' }
        const target = typeof store().getCaseByRef === 'function'
          ? await store().getCaseByRef(ref)
          : (await store().listCases({}, { limit: 500 })).find(c => c.ref === ref)
        if (!target) return { error: `no case found with ref ${ref}` }
        if (target.channel === 'system') return { error: `no case found with ref ${ref}` }
        if (!ownsCase(target.external_id, author) && !team) {
          return { error: `case ${ref} does not belong to you -- cannot switch to it` }
        }

        rebindActiveCase(ctx, target)

        return { ok: true, activeCase: enquiryRow(target), switchedToRef: target.ref }
      }),
  ]
}
