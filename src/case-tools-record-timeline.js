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
import { canSignOff, canQueryCases } from './contact-tiers.js'
import { isAssignedTo } from './case-assignment.js'
import { doneStages, authorityOn } from './case-tools-team-shared.js'
import { writeGate, recordedOn, clearFocusForCase } from './team-focus.js'
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

// The SECOND condition on a move to a done stage, named in the same description
// for the same reason: so the model knows before it calls rather than by having
// the call refused. Separate clause, separate sentence, because the two
// conditions fail for unrelated reasons and a model that cannot tell them apart
// composes the wrong next move -- it keeps asking a person for facts that are
// already recorded, or it goes silent on a record it could have finished.
//
// Deliberately says what to DO instead (leave it open; a person will sign it
// off) rather than naming the tier, the authority, or the gate. Anything the
// model reads here it may paraphrase into a reply, and "you are not authorised"
// is exactly the internal-permissions language the outbound jargon scrub holds a
// reply for -- see gateByTier's own result text (case-tools-gates.js) for the
// same reasoning applied to the tier gate.
//
// Empty string (byte-identical description) when this config declares no
// mandatory minimum: with no declared done-stage list there is nothing for
// either condition to gate, so a deployment that has not opted in is unaffected
// by both.
function signOffAuthorityDescriptionClause() {
  if (!MANDATORY_MINIMUM_BLOCKED_STATUSES.length) return ''
  return ` Marking a ${REPORT_ENTITY_LABEL} ${MANDATORY_MINIMUM_BLOCKED_STATUSES.join('/')} is ALSO restricted to the animal health technician who signs it off, so this tool refuses that move for anyone else even when every fact is recorded. When it does, leave the ${REPORT_ENTITY_LABEL} as it is and say nothing about it: it stays open and the right person finishes it.`
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
      + mandatoryMinimumDescriptionClause()
      + signOffAuthorityDescriptionClause(),
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
        // SIGN-OFF DESK. The technician signs off records the public filed, so
        // ownership cannot be the test for THEM: a move to a done stage is also
        // allowed on a record assigned to this technician or assigned to nobody
        // (the signoff_queue set). Only the technician -- the canSignOff equality,
        // unchanged -- and only to a done stage; every other move on a record that
        // is not yours still needs ownership (case_stage covers assigned work).
        // That path is write-gated like the rest of the team family: the record
        // must be the confirmed focus, and the message must not name another.
        const unassigned = !String(c.assignee || '').trim() || String(c.assignee).trim() === 'agent'
        const signOffDesk = canSignOff(ctx?.tier) && doneStages().includes(to) && (isAssignedTo(c, ctx?.contact) || unassigned)
        const owns = ownsCase(c.external_id, author)
        // An assignee or an operator who asks for a FINISHED stage is answered by the
        // two checks below (which fact is missing / that finishing is not theirs), not
        // by "does not belong to you": it does belong to them, and a person told the
        // wrong reason goes looking for the wrong fix.
        const authority = owns ? null : authorityOn(ctx, c)
        if (!owns && !signOffDesk && !(authority && doneStages().includes(to))) {
          return { error: `case ${id} does not belong to you -- cannot transition it` }
        }
        if (!owns && authority !== 'operator') {
          const refused = writeGate(ctx, c)
          if (refused) return refused
        }
        // A person who has taken the conversation over drives it in 'observe'
        // (staff-outbound.js); that mode stops the ASSISTANT, not the assignee.
        if (c.autonomy === 'observe' && !isAssignedTo(c, ctx?.contact)) return { error: 'case autonomy is "observe"; transitions are operator-only' }
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
          // A team member who asked to finish a record is owed the plain reason; the
          // "say nothing" wording below is for a reporter who never asked.
          if (canQueryCases(ctx?.tier)) return { error: `this ${REPORT_ENTITY_LABEL} cannot be finished yet: ${labels} ${blockedBy.length === 1 ? 'is' : 'are'} still not recorded. Tell them exactly that, in one plain sentence, and that they can ask the reporter for ${blockedBy.length === 1 ? 'it' : 'them'} (case_gaps has a reminder text). Do not use stage names.` }
          return { error: `this ${REPORT_ENTITY_LABEL} cannot be marked done yet: ${labels} ${blockedBy.length === 1 ? 'is' : 'are'} still blank, and ${blockedBy.length === 1 ? 'that fact is' : 'those facts are'} the minimum anyone needs to act on it. Say NOTHING about this to the person -- no stage, no tool, no refusal. Ask them once, warmly, for the missing one, record it with ${REPORT_TOOL_NAME}, then call this again. If they cannot or will not answer, leave it as it is and let them go kindly; it stays open and a person will look at it.` }
        }
        // SIGN-OFF AUTHORITY, the second condition on the same move -- checked
        // here, AFTER the field-completeness gate above, and returning its own
        // textually distinct error.
        //
        // BOTH conditions must hold: every mandatory fact recorded AND the acting
        // contact holding sign-off authority. This does not replace the gate above
        // and does not weaken it; a record with a blank species is no more
        // finishable by an animal health technician than by anyone else.
        //
        // WHY THE FIELD CHECK GOES FIRST when both are unmet. The two refusals ask
        // completely different things of the model. A blank field is something it
        // can still act on -- ask once, warmly, record it, and the record moves
        // one step closer to being finishable by whoever does finish it. Missing
        // authority is something no amount of conversation changes. Checking
        // authority first would answer an eco ranger's incomplete record with "not
        // your call" and spend the one last-chance ask on nothing, losing the
        // facts while the person is still standing next to the animals -- which is
        // the exact harm the mandatory minimum exists to prevent. So the gathering
        // gate keeps precedence and the authority gate is what is left when there
        // is nothing further to gather.
        //
        // FAIL CLOSED. canSignOff (contact-tiers.js) resolves an absent, empty,
        // pre-migration or corrupt tier to the lowest rung before comparing, so a
        // toolCtx carrying no tier at all is never sign-off eligible -- the same
        // direction gateByTier fails in, and for the same reason: the value is
        // operator-assigned and never contact-self-service or LLM-settable, so a
        // turn that cannot prove the tier has no claim to it.
        if (MANDATORY_MINIMUM_BLOCKED_STATUSES.includes(to) && !canSignOff(ctx?.tier)) {
          if (canQueryCases(ctx?.tier)) return { error: `every required fact is recorded, but finishing a ${REPORT_ENTITY_LABEL} is not something they can do: only the animal health technician signs it off. Tell them so plainly in one sentence, and that it stays open until the technician finishes it. Do not use stage names.` }
          return { error: `this ${REPORT_ENTITY_LABEL} is complete but signing it off is not yours to do -- only the animal health technician marks one ${MANDATORY_MINIMUM_BLOCKED_STATUSES.join('/')}. Nothing is missing and nothing needs asking: every fact is already recorded. Say NOTHING about this to the person -- no stage, no tool, no permission, no refusal. Thank them warmly for what they gave you and let them go; it stays open, and the person who signs these off will finish it.` }
        }
        try {
          await store().transition(id, to, { user: AGENT_USER, reason })
          const on = owns ? null : await recordedOn(store(), c, ctx)
          if (doneStages().includes(to)) clearFocusForCase(c.id)
          return { ok: true, from: c.status, to, ...(on ? { recorded_on: on } : {}) }
        } catch (e) {
          return { error: e.message }
        }
      }),
  ]
}
