

import { AGENT_USER } from './case-store.js'
import { tagList } from './timestamp.js'
import {
  defTool, str, ownsCase, slimCase, OBSERVE_TEXT_MAX_LEN,
} from './case-tools-shared.js'
import { canQueryCases } from './contact-tiers.js'
import { sameSituationChoices } from './choices.js'
import { caseyText } from './deployment-text.js';

export function buildTriageTools(store) {
  return [
    defTool('case_transitions_available', 'cases',
      caseyText("src/case-tools-triage.js#0"),
      { type: 'object', properties: { id: str(caseyText("src/case-tools-triage.js#s0")) }, required: ['id'] },
      async ({ id }) => {
        const c = await store().getCase(id)
        if (!c) return { error: caseyText("src/case-tools-triage.js#s1", [id]) }
        const avail = store().availableTransitions(c, AGENT_USER)
        return { current: c.status, available: avail }
      }),
    defTool('case_link_suggestions', 'cases',
      caseyText("src/case-tools-triage.js#1"),
      { type: 'object', properties: { id: str(caseyText("src/case-tools-triage.js#s2")), limit: { type: 'number', default: 5 } }, required: ['id'] },
      async ({ id, limit = 5 }, ctx) => {
        const c = await store().getCase(id)
        if (!c) return { error: caseyText("src/case-tools-triage.js#s3", [id]) }
        const author = ctx?.author || ctx?.principal?.id
        if (!ownsCase(c.external_id, author) && !canQueryCases(ctx?.tier)) {
          return { error: caseyText("src/case-tools-triage.js#2", [id]) }
        }
        const { suggestLinks } = await import('./correlate.js')

        const openStatuses = typeof store().getOpenStatuses === 'function' ? store().getOpenStatuses() : undefined
        const pool = (await store().listCases(openStatuses ? { status: { $in: openStatuses } } : {}, { limit: 200 }))
          .filter(o => o.id !== id && o.status !== 'closed' && !tagList(o).includes('merged'))

        const suggestions = suggestLinks(c, pool).slice(0, limit)
        return { count: suggestions.length, suggestions, ...(suggestions[0]?.ref && canQueryCases(ctx?.tier) ? sameSituationChoices(c.ref, suggestions[0].ref) : {}) }
      }),

    defTool('case_split', 'cases',
      caseyText("src/case-tools-triage.js#3"),
      {
        type: 'object',
        properties: {
          id: str(caseyText("src/case-tools-triage.js#s4")),
          event_ids: { type: 'array', items: { type: 'string' }, maxItems: 500, description: caseyText("src/case-tools-triage.js#4") },
          subject: str(caseyText("src/case-tools-triage.js#s5"), { maxLength: OBSERVE_TEXT_MAX_LEN }),
          reason: str(caseyText("src/case-tools-triage.js#5"), { maxLength: OBSERVE_TEXT_MAX_LEN }),
        },
        required: ['id', 'event_ids'],
      },
      async ({ id, event_ids, subject = '', reason = '' }, ctx) => {
        if (String(subject).length > OBSERVE_TEXT_MAX_LEN || String(reason).length > OBSERVE_TEXT_MAX_LEN) {
          return { error: caseyText("src/case-tools-triage.js#s6", [OBSERVE_TEXT_MAX_LEN]) }
        }
        const target = await store().getCase(id)
        if (!target) return { error: caseyText("src/case-tools-triage.js#s7", [id]) }
        const author = ctx?.author || ctx?.principal?.id
        if (!ownsCase(target.external_id, author) && !canQueryCases(ctx?.tier)) {
          return { error: caseyText("src/case-tools-triage.js#6", [id]) }
        }
        const res = await store().splitCase(id, event_ids, { subject, reason }, AGENT_USER)
        if (res.error === 'observe') return { error: caseyText("src/case-tools-triage.js#7") }
        if (res.error) return { error: res.error }
        return { ok: true, movedEvents: res.movedEvents, newCase: slimCase(res.newCase) }
      }),
    defTool('case_health', 'cases',

      caseyText("src/case-tools-triage.js#8"),
      { type: 'object', properties: { id: str(caseyText("src/case-tools-triage.js#s8")) }, required: ['id'] },
      async ({ id }, ctx) => {
        const c = await store().getCase(id)
        if (!c) return { error: caseyText("src/case-tools-triage.js#s9", [id]) }
        const author = ctx?.author || ctx?.principal?.id
        if (!ownsCase(c.external_id, author) && !canQueryCases(ctx?.tier)) {
          return { error: caseyText("src/case-tools-triage.js#s10", [id]) }
        }
        const { classifyCaseHealth } = await import('./case-health.js')
        const breaches = classifyCaseHealth(c, Date.now())
        return { id, status: c.status, healthy: breaches.length === 0, breaches }
      }),
  ]
}
