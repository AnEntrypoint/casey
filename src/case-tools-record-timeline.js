// case-tools-record-timeline.js  --  the two write tools that touch a case's
// TIMELINE rather than its stored fields: record an internal observation, and
// move the case through the workflow.
//
// Split out of case-tools-record.js verbatim -- names, descriptions, parameter
// schemas and handler bodies are unchanged. Composed back in order by
// case-tools-record.js's buildRecordTools.

import { AGENT_USER } from './case-store.js'
import { defTool, str, ownsCase, OBSERVE_TEXT_MAX_LEN } from './case-tools-shared.js'

export function buildCaseTimelineTools(store, { stageValues }) {
  return [
    defTool('case_observe', 'cases',
      'Record an observation or internal note on the case timeline WITHOUT replying to the contact. Use for triage reasoning, flags, or anything an operator should see.',
      {
        type: 'object',
        properties: { id: str('Case id'), text: str('The observation', { maxLength: OBSERVE_TEXT_MAX_LEN }) },
        required: ['id', 'text'],
      },
      async ({ id, text }, ctx) => {
        if (String(text).length > OBSERVE_TEXT_MAX_LEN) {
          return { error: `text too long (${String(text).length} chars, max ${OBSERVE_TEXT_MAX_LEN})` }
        }
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const author = ctx?.author || ctx?.principal?.id
        if (!ownsCase(c.external_id, author)) {
          return { error: `case ${id} does not belong to you -- cannot add an observation to it` }
        }
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text })
        return { ok: true }
      }),
    // (case_intent was deleted: it was a record-only stub whose INTENT-DECLARED
    // marker nothing read after the pure-LLM strip -- an enquiry declared through it
    // produced NOTHING. The prompt now directs the model straight to the real data
    // tools: case_today / case_mine / case_list / case_get.)
    defTool('case_transition', 'cases',
      'Move the case to a new workflow stage. Valid targets depend on current stage (new->triaging->in_progress->waiting->resolved->closed, with reopen paths). Call case_get first if unsure. Honour the case autonomy setting.',
      {
        type: 'object',
        properties: {
          id: str('Case id'),
          to: str('Target stage', { enum: stageValues }),
          reason: str('Why you are transitioning (recorded on the timeline)'),
        },
        required: ['id', 'to'],
      },
      async ({ id, to, reason = '' }, ctx) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const author = ctx?.author || ctx?.principal?.id
        if (!ownsCase(c.external_id, author)) {
          return { error: `case ${id} does not belong to you -- cannot transition it` }
        }
        if (c.autonomy === 'observe') return { error: 'case autonomy is "observe"; transitions are operator-only' }
        try {
          await store().transition(id, to, { user: AGENT_USER, reason })
          return { ok: true, from: c.status, to }
        } catch (e) {
          return { error: e.message }
        }
      }),
  ]
}
