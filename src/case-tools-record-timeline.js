

import { AGENT_USER } from './case-store.js'
import { defTool, str, ownsCase, OBSERVE_TEXT_MAX_LEN } from './case-tools-shared.js'
import { parseReport } from './timestamp.js'
import { canSignOff, canQueryCases } from './contact-tiers.js'
import { isAssignedTo } from './case-assignment.js'
import { doneStages, authorityOn, actorData, cleanRelayed } from './case-tools-team-shared.js'
import { isHandedOff } from './signoff-desk.js'
import { staffLabel } from './hooks/staff-outbound.js'
import { writeGate, recordedOn, clearFocusForCase } from './team-focus.js'
import {
  MANDATORY_MINIMUM_FIELDS, MANDATORY_MINIMUM_BLOCKED_STATUSES,
  missingMandatoryMinimum, fieldLabel, REPORT_TOOL_NAME, REPORT_ENTITY_LABEL,
  SIGNOFF_DIAGNOSIS_FIELDS, missingSignoffDiagnosis, REPORT_FIELD_DEFS,
} from './store/report-shape.js'
import { APPEND_FIELD_MAX_LEN } from './store/report-merge.js'

function mandatoryMinimumDescriptionClause() {
  if (!MANDATORY_MINIMUM_FIELDS.length) return ''
  return ` A ${REPORT_ENTITY_LABEL} is not finished until ${MANDATORY_MINIMUM_FIELDS.map(fieldLabel).join(', ')} are all recorded: this tool REFUSES a move to ${MANDATORY_MINIMUM_BLOCKED_STATUSES.join('/')} while any one of them is blank. Ask the person for the missing one and record it with ${REPORT_TOOL_NAME} first.`
}

function signOffAuthorityDescriptionClause() {
  if (!MANDATORY_MINIMUM_BLOCKED_STATUSES.length) return ''
  return ` Marking a ${REPORT_ENTITY_LABEL} ${MANDATORY_MINIMUM_BLOCKED_STATUSES.join('/')} is ALSO restricted to the animal health technician who signs it off, so this tool refuses that move for anyone else even when every fact is recorded. When it does, leave the ${REPORT_ENTITY_LABEL} as it is and say nothing about it: it stays open and the right person finishes it.`
}

function diagnosisDescriptionClause() {
  if (!SIGNOFF_DIAGNOSIS_FIELDS.length) return ''
  return ` A sign-off also records ${SIGNOFF_DIAGNOSIS_FIELDS.map(fieldLabel).join(' and ')}: pass ${SIGNOFF_DIAGNOSIS_FIELDS.join(' and ')} here, exactly as the technician stated them, and this tool REFUSES the move while either is blank. Never suggest or work out either one yourself.`
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
        if (!ownsCase(c.external_id, author) && !canQueryCases(ctx?.tier)) {
          return { error: `case ${id} does not belong to you -- cannot add an observation to it` }
        }
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text })
        return { ok: true }
      }),

    defTool('case_transition', 'cases',

      'Move the case to a new workflow stage. Valid targets depend on current stage (new->triaging->in_progress->waiting->resolved->closed, with reopen paths). Call case_get first if unsure. Honour the case autonomy setting. Every stage name here is internal bookkeeping: never say one to the person, and never describe what you just did in these words.'
      + mandatoryMinimumDescriptionClause()
      + signOffAuthorityDescriptionClause()
      + diagnosisDescriptionClause(),
      {
        type: 'object',
        properties: {
          id: str('Case id'),
          to: str('Target stage', { enum: stageValues }),
          reason: str('Why you are transitioning (recorded on the timeline)'),
          ...Object.fromEntries(SIGNOFF_DIAGNOSIS_FIELDS.map(k => [k, str(REPORT_FIELD_DEFS.find(f => f.key === k)?.description || k)])),
        },
        required: ['id', 'to'],
      },
      async ({ id, to, reason = '', ...diagnosisArgs }, ctx) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const author = ctx?.author || ctx?.principal?.id

        const unassigned = !String(c.assignee || '').trim() || String(c.assignee).trim() === 'agent'
        const signOffDesk = canSignOff(ctx?.tier) && doneStages().includes(to) && (isAssignedTo(c, ctx?.contact) || unassigned || isHandedOff(c))
        const owns = ownsCase(c.external_id, author)

        const team = canQueryCases(ctx?.tier)
        const toDone = doneStages().includes(to)
        const authority = owns ? null : authorityOn(ctx, c)
        if (!owns && !signOffDesk && !(authority && toDone) && !(team && !toDone)) {
          return { error: `case ${id} does not belong to you -- cannot transition it` }
        }
        if (!owns && authority !== 'operator') {
          const refused = writeGate(ctx, c, { confirm: !team })
          if (refused) return refused
        }

        if (c.autonomy === 'observe' && !isAssignedTo(c, ctx?.contact)) return { error: 'case autonomy is "observe"; transitions are operator-only' }

        const blockedBy = MANDATORY_MINIMUM_BLOCKED_STATUSES.includes(to)
          ? missingMandatoryMinimum(parseReport(c))
          : []
        if (blockedBy.length) {
          const labels = blockedBy.map(fieldLabel).join(', ')

          if (canQueryCases(ctx?.tier)) return { error: `this ${REPORT_ENTITY_LABEL} cannot be finished yet: ${labels} ${blockedBy.length === 1 ? 'is' : 'are'} still not recorded. Tell them exactly that, in one plain sentence, and that they can ask the reporter for ${blockedBy.length === 1 ? 'it' : 'them'} (case_gaps has a reminder text). Do not use stage names.` }
          return { error: `this ${REPORT_ENTITY_LABEL} cannot be marked done yet: ${labels} ${blockedBy.length === 1 ? 'is' : 'are'} still blank, and ${blockedBy.length === 1 ? 'that fact is' : 'those facts are'} the minimum anyone needs to act on it. Say NOTHING about this to the person -- no stage, no tool, no refusal. Ask them once, warmly, for the missing one, record it with ${REPORT_TOOL_NAME}, then call this again. If they cannot or will not answer, leave it as it is and let them go kindly; it stays open and a person will look at it.` }
        }

        if (MANDATORY_MINIMUM_BLOCKED_STATUSES.includes(to) && !canSignOff(ctx?.tier)) {
          if (canQueryCases(ctx?.tier)) return { error: `every required fact is recorded, but finishing a ${REPORT_ENTITY_LABEL} is not something they can do: only the animal health technician signs it off. Tell them so plainly in one sentence, and that it stays open until the technician finishes it. Do not use stage names.` }
          return { error: `this ${REPORT_ENTITY_LABEL} is complete but signing it off is not yours to do -- only the animal health technician marks one ${MANDATORY_MINIMUM_BLOCKED_STATUSES.join('/')}. Nothing is missing and nothing needs asking: every fact is already recorded. Say NOTHING about this to the person -- no stage, no tool, no permission, no refusal. Thank them warmly for what they gave you and let them go; it stays open, and the person who signs these off will finish it.` }
        }

        if (MANDATORY_MINIMUM_BLOCKED_STATUSES.includes(to) && SIGNOFF_DIAGNOSIS_FIELDS.length) {
          const given = {}
          for (const k of SIGNOFF_DIAGNOSIS_FIELDS) {
            const v = cleanRelayed(diagnosisArgs[k])
            if (typeof v === 'string' && v.trim()) given[k] = v.trim()
          }
          const still = missingSignoffDiagnosis({ ...parseReport(c), ...given })
          if (still.length) return { error: `every required fact is recorded and it is the technician's to finish, but the sign-off also needs ${still.map(fieldLabel).join(' and ')}, and ${still.length === 1 ? 'that is' : 'those are'} not recorded. Ask them for ${still.length === 1 ? 'it' : 'them'} in one plain sentence, then call this again with ${still.join(' and ')} set to exactly what they said. Do not suggest ${still.length === 1 ? 'one' : 'either'} yourself and do not use stage names.` }
          const tooLong = Object.keys(given).filter(k => given[k].length > APPEND_FIELD_MAX_LEN)
          if (tooLong.length) return { error: `${tooLong.map(fieldLabel).join(', ')} is too long to record (over ${APPEND_FIELD_MAX_LEN} characters). Nothing was changed. Ask for a shorter version.` }

          if (to !== c.status && !store().availableTransitions(c, AGENT_USER).includes(to)) return { error: `cannot move ${c.status} -> ${to}; allowed: ${store().availableTransitions(c, AGENT_USER).join(', ')}` }
          if (Object.keys(given).length) {
            const merged = await store().mergeReport(c.id, given, AGENT_USER, { bypassObserve: true, autoAssign: false })
            if (merged.error) return { error: merged.error }
            await store().appendEvent(c.id, { kind: 'action', actor: 'operator', text: `diagnosis recorded at sign-off by ${staffLabel(ctx?.contact)}: ${Object.keys(given).map(fieldLabel).join(', ')}`, data: actorData(ctx, { on_behalf: true, signoff: true, ...given }) })
          }
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
