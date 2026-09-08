// case-tools-triage.js  --  the tools that reason about a case's SHAPE rather
// than its content: what can it move to, is it a duplicate of another report,
// is it actually two reports, and is it going wrong over time.
//
// Split out of case-tools.js verbatim -- names, descriptions, parameter schemas
// and handler bodies are unchanged. correlate.js and case-health.js stay
// dynamically imported at call time exactly as before, so neither is loaded on
// a turn that never asks.

import { AGENT_USER } from './case-store.js'
import { tagList } from './timestamp.js'
import {
  defTool, str, ownsCase, slimCase, OBSERVE_TEXT_MAX_LEN,
} from './case-tools-shared.js'

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
        if (!ownsCase(c.external_id, author)) {
          return { error: `case ${id} does not belong to you -- cannot find matches for it` }
        }
        const { suggestLinks } = await import('./correlate.js')
        // Scope the scan to open cases at the query level via an allowlist (never
        // a $ne denylist -- see case-store.js's own note: busybase only
        // auto-filters soft-deleted rows when status is absent from the where, so
        // $ne:'closed' would leak them back in). Pushes the closed-case filter
        // into the where-clause so this call's cost tracks open-case volume, not
        // total case history.
        const openStatuses = typeof store().getOpenStatuses === 'function' ? store().getOpenStatuses() : undefined
        const pool = (await store().listCases(openStatuses ? { status: { $in: openStatuses } } : {}, { limit: 200 }))
          .filter(o => o.id !== id && o.status !== 'closed' && !tagList(o).includes('merged'))
        // Score against the raw case rows, not slimCase projections -- slimCase
        // drops external_id and created_at, which correlationScore needs for
        // its same-contact/fallback-number/time-proximity signals. suggestLinks
        // only ever returns {id, ref, score, reasons}, so no extra PII reaches
        // the caller even though the scoring inputs are the full rows.
        const suggestions = suggestLinks(c, pool).slice(0, limit)
        return { count: suggestions.length, suggestions }
      }),
    // case_merge is deliberately NOT exposed here. Folding two reports together
    // is a judgment about whether they describe the same real-world situation --
    // exactly the kind of call this system leaves to a human working from the
    // full picture, never to the agent acting on one conversation alone. The
    // dashboard's own merge endpoint (POST /api/cases/:id/merge) calls
    // store.mergeCases directly as the operator, entirely independent of this
    // toolset; case_link_suggestions above still lets the agent surface a
    // possible match for a human to review, it just never acts on it.
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
        if (!ownsCase(target.external_id, author)) {
          return { error: `case ${id} does not belong to you -- cannot split it` }
        }
        const res = await store().splitCase(id, event_ids, { subject, reason }, AGENT_USER)
        if (res.error === 'observe') return { error: 'case autonomy is "observe"; splitting is operator-only' }
        if (res.error) return { error: res.error }
        return { ok: true, movedEvents: res.movedEvents, newCase: slimCase(res.newCase) }
      }),
    defTool('case_health', 'cases',
      'Check whether a case is going wrong over time -- stale (no activity), stuck in a stage too long, an unanswered request for a person, an abandoned intake with on-site facts still missing, or resolved-but-never-closed. Returns the current guardrail breaches with how long each has been true. Use it to decide what needs attention.',
      { type: 'object', properties: { id: str('Case id') }, required: ['id'] },
      async ({ id }, ctx) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const author = ctx?.author || ctx?.principal?.id
        if (!ownsCase(c.external_id, author)) {
          return { error: `case ${id} does not belong to you` }
        }
        const { classifyCaseHealth } = await import('./case-health.js')
        const breaches = classifyCaseHealth(c, Date.now())
        return { id, status: c.status, healthy: breaches.length === 0, breaches }
      }),
  ]
}
