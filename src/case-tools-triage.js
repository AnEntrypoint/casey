

import { AGENT_USER } from './case-store.js'
import { tagList } from './timestamp.js'
import {
  defTool, str, ownsCase, slimCase, OBSERVE_TEXT_MAX_LEN,
} from './case-tools-shared.js'
import { canQueryCases } from './contact-tiers.js'
import { sameSituationChoices } from './choices.js'

export function buildTriageTools(store) {
  return [
    defTool('case_transitions_available', 'cases',
      'List the workflow stages you are allowed to move this case to right now.',
      { type: 'object', properties: { id: str('Case id') }, required: ['id'] },
      async ({ id }) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const avail = store().availableTransitions(c, AGENT_USER)
        return { current: c.status, available: avail }
      }),
    defTool('case_link_suggestions', 'cases',
      'Find OTHER open cases that look like they may describe the same real-world situation as this one -- same place, same animals, a shared contact or fallback number, reported around the same time. Returns ranked candidates with the reasons for each, strongest first, for a human to review -- this never merges anything itself; only an operator decides whether two reports should become one case.',
      { type: 'object', properties: { id: str('Case id to find matches for'), limit: { type: 'number', default: 5 } }, required: ['id'] },
      async ({ id, limit = 5 }, ctx) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const author = ctx?.author || ctx?.principal?.id
        if (!ownsCase(c.external_id, author) && !canQueryCases(ctx?.tier)) {
          return { error: `case ${id} does not belong to you -- cannot find matches for it` }
        }
        const { suggestLinks } = await import('./correlate.js')

        const openStatuses = typeof store().getOpenStatuses === 'function' ? store().getOpenStatuses() : undefined
        const pool = (await store().listCases(openStatuses ? { status: { $in: openStatuses } } : {}, { limit: 200 }))
          .filter(o => o.id !== id && o.status !== 'closed' && !tagList(o).includes('merged'))

        const suggestions = suggestLinks(c, pool).slice(0, limit)
        return { count: suggestions.length, suggestions, ...(suggestions[0]?.ref && canQueryCases(ctx?.tier) ? sameSituationChoices(c.ref, suggestions[0].ref) : {}) }
      }),

    defTool('case_split', 'cases',
      'Carve a set of timeline events out of a case into a NEW case, when one thread actually holds TWO separate outbreaks (e.g. a contact reported a second, unrelated sick herd). The named events move to the new case; both are linked. Get event ids from case_get.',
      {
        type: 'object',
        properties: {
          id: str('Case id to split FROM'),
          event_ids: { type: 'array', items: { type: 'string' }, maxItems: 500, description: 'Ids of the events to move into the new case' },
          subject: str('Short title for the new case', { maxLength: OBSERVE_TEXT_MAX_LEN }),
          reason: str('Why these belong to a separate outbreak (recorded on both timelines)', { maxLength: OBSERVE_TEXT_MAX_LEN }),
        },
        required: ['id', 'event_ids'],
      },
      async ({ id, event_ids, subject = '', reason = '' }, ctx) => {
        if (String(subject).length > OBSERVE_TEXT_MAX_LEN || String(reason).length > OBSERVE_TEXT_MAX_LEN) {
          return { error: `subject/reason too long (max ${OBSERVE_TEXT_MAX_LEN} chars)` }
        }
        const target = await store().getCase(id)
        if (!target) return { error: `no case ${id}` }
        const author = ctx?.author || ctx?.principal?.id
        if (!ownsCase(target.external_id, author) && !canQueryCases(ctx?.tier)) {
          return { error: `case ${id} does not belong to you -- cannot split it` }
        }
        const res = await store().splitCase(id, event_ids, { subject, reason }, AGENT_USER)
        if (res.error === 'observe') return { error: 'case autonomy is "observe"; splitting is operator-only' }
        if (res.error) return { error: res.error }
        return { ok: true, movedEvents: res.movedEvents, newCase: slimCase(res.newCase) }
      }),
    defTool('case_health', 'cases',

      'Check whether a case is going wrong over time -- stale (no activity), stuck in a stage too long, an unanswered request for a person, an abandoned intake with on-site facts still missing, or resolved-but-never-closed. Returns the current guardrail breaches with how long each has been true. Use it to decide what needs attention. These breach names are internal: never repeat one to the person, and never tell them their report is stale, stuck or abandoned.',
      { type: 'object', properties: { id: str('Case id') }, required: ['id'] },
      async ({ id }, ctx) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const author = ctx?.author || ctx?.principal?.id
        if (!ownsCase(c.external_id, author) && !canQueryCases(ctx?.tier)) {
          return { error: `case ${id} does not belong to you` }
        }
        const { classifyCaseHealth } = await import('./case-health.js')
        const breaches = classifyCaseHealth(c, Date.now())
        return { id, status: c.status, healthy: breaches.length === 0, breaches }
      }),
  ]
}
