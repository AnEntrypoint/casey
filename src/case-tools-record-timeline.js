// case-tools-record-timeline.js  --  the two write tools that touch a case's
// TIMELINE rather than its stored fields: record an internal observation, and
// move the case through the workflow.
//
// Split out of case-tools-record.js verbatim -- names, descriptions, parameter
// schemas and handler bodies are unchanged. Composed back in order by
// case-tools-record.js's buildRecordTools.

import { AGENT_USER } from './case-store.js'
import { defTool, str, ownsCase, OBSERVE_TEXT_MAX_LEN } from './case-tools-shared.js'
import { parseReport } from './timestamp.js'
import {
  MANDATORY_MINIMUM_FIELDS, MANDATORY_MINIMUM_BLOCKED_STATUSES,
  missingMandatoryMinimum, fieldLabel, REPORT_TOOL_NAME, REPORT_ENTITY_LABEL,
} from './store/report-shape.js'

// The mandatory-minimum sentence appended to case_transition's own description,
// so the requirement is SCHEMA-VISIBLE to the model before it ever attempts the
// call -- not only discovered by having the call refused. Empty string (nothing
// appended, byte-identical description) when the active config declares no
// mandatory minimum. Config-derived labels, never a hardcoded field list: see
// store/report-shape.js's mandatory_minimum block.
function mandatoryMinimumDescriptionClause() {
  if (!MANDATORY_MINIMUM_FIELDS.length) return ''
  return ` A ${REPORT_ENTITY_LABEL} is not finished until ${MANDATORY_MINIMUM_FIELDS.map(fieldLabel).join(', ')} are all recorded: this tool REFUSES a move to ${MANDATORY_MINIMUM_BLOCKED_STATUSES.join('/')} while any one of them is blank. Ask the person for the missing one and record it with ${REPORT_TOOL_NAME} first.`
}

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
      // The stage ladder has to be spelled out (it is the enum the model must
      // pick from), but four of these words -- triaging, status, transition,
      // workflow -- are on the never-say list the system prompt hands the same
      // model and hooks/reply-judge.js holds a reply for. Introducing the
      // vocabulary without saying it is internal is how it ends up in a reply
      // and the person gets silence instead. Say it where the words are handed
      // over.
      'Move the case to a new workflow stage. Valid targets depend on current stage (new->triaging->in_progress->waiting->resolved->closed, with reopen paths). Call case_get first if unsure. Honour the case autonomy setting. Every stage name here is internal bookkeeping: never say one to the person, and never describe what you just did in these words.'
      + mandatoryMinimumDescriptionClause(),
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
        // MANDATORY MINIMUM, enforced HERE rather than in the prompt alone.
        //
        // A prompt instruction is a suggestion a model may ignore, and the one it
        // ignores is the one that costs a real report: a record marked done with
        // no animal, no sign or no place in it describes nothing anybody can act
        // on, and nothing further happens to it on its own. So the refusal is a
        // real code-level check with a real tool-result error the model has to
        // resolve by asking and retrying -- never a silent no-op, and never a
        // partial write (this returns BEFORE store().transition, so the stage is
        // genuinely unchanged rather than moved-then-flagged).
        //
        // Scope, deliberately: this gates the AGENT's own tool surface only. An
        // operator on the dashboard or the CLI (`casey transition`) goes nowhere
        // near this handler and can still close a genuinely incomplete-but-real
        // report on their own judgement -- a human looking at the row is exactly
        // who should be able to. And it gates only the FORMAL move to done, never
        // the conversation: nothing in casey forces a case out of new/open, so a
        // blocked transition leaves the agent completely free to say goodbye
        // warmly (AGENTS.md's "a complete report is not a dead-end"). The case
        // simply stays open, which is the truthful state.
        const blockedBy = MANDATORY_MINIMUM_BLOCKED_STATUSES.includes(to)
          ? missingMandatoryMinimum(parseReport(c))
          : []
        if (blockedBy.length) {
          const labels = blockedBy.map(fieldLabel).join(', ')
          return { error: `this ${REPORT_ENTITY_LABEL} cannot be marked done yet: ${labels} ${blockedBy.length === 1 ? 'is' : 'are'} still blank, and ${blockedBy.length === 1 ? 'that fact is' : 'those facts are'} the minimum anyone needs to act on it. Say NOTHING about this to the person -- no stage, no tool, no refusal. Ask them once, warmly, for the missing one, record it with ${REPORT_TOOL_NAME}, then call this again. If they cannot or will not answer, leave it as it is and let them go kindly; it stays open and a person will look at it.` }
        }
        try {
          await store().transition(id, to, { user: AGENT_USER, reason })
          return { ok: true, from: c.status, to }
        } catch (e) {
          return { error: e.message }
        }
      }),
  ]
}
