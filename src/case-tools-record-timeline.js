

import { AGENT_USER } from './case-store.js'
import { diagnosisStatusChoices } from './choices.js'
import { defTool, str, ownsCase, OBSERVE_TEXT_MAX_LEN } from './case-tools-shared.js'
import { parseReport } from './timestamp.js'
import { canSignOff, canQueryCases } from './contact-tiers.js'
import { isAssignedTo } from './case-assignment.js'
import { doneStages, authorityOn, actorData, cleanRelayed } from './case-tools-team-shared.js'
import { isHandedOff } from './signoff-desk.js'
import { staffLabel } from './hooks/staff-outbound.js'
import { writeGate, recordedOn, clearFocusForCase } from './team-focus.js'
import { checkStale, recordWrote } from './stale-write-guard.js'
import {
  MANDATORY_MINIMUM_FIELDS, MANDATORY_MINIMUM_BLOCKED_STATUSES,
  missingMandatoryMinimum, fieldLabel, REPORT_TOOL_NAME, REPORT_ENTITY_LABEL,
  SIGNOFF_DIAGNOSIS_FIELDS, missingSignoffDiagnosis, REPORT_FIELD_DEFS,
  DIAGNOSIS_STATUS_KEY, DIAGNOSIS_STATUS_OPTIONS, normalizeDiagnosisStatus,
} from './store/report-shape.js'
import { APPEND_FIELD_MAX_LEN } from './store/report-merge.js'
import { caseyText } from './deployment-text.js';

function mandatoryMinimumDescriptionClause() {
  if (!MANDATORY_MINIMUM_FIELDS.length) return ''
  return caseyText("src/case-tools-record-timeline.js#0", [REPORT_ENTITY_LABEL, MANDATORY_MINIMUM_FIELDS.map(fieldLabel).join(', '), MANDATORY_MINIMUM_BLOCKED_STATUSES.join('/'), REPORT_TOOL_NAME])
}

function signOffAuthorityDescriptionClause() {
  if (!MANDATORY_MINIMUM_BLOCKED_STATUSES.length) return ''
  return caseyText("src/case-tools-record-timeline.js#1", [REPORT_ENTITY_LABEL, MANDATORY_MINIMUM_BLOCKED_STATUSES.join('/'), REPORT_ENTITY_LABEL])
}

function diagnosisDescriptionClause() {
  if (!SIGNOFF_DIAGNOSIS_FIELDS.length) return ''
  return caseyText("src/case-tools-record-timeline.js#2", [SIGNOFF_DIAGNOSIS_FIELDS.map(fieldLabel).join(', '), SIGNOFF_DIAGNOSIS_FIELDS.join(' and ')])
}

export function buildCaseTimelineTools(store, { stageValues }) {
  return [
    defTool('case_observe', 'cases',
      caseyText("src/case-tools-record-timeline.js#3"),
      {
        type: 'object',
        properties: { id: str(caseyText("src/case-tools-record-timeline.js#s0")), text: str(caseyText("src/case-tools-record-timeline.js#s1"), { maxLength: OBSERVE_TEXT_MAX_LEN }) },
        required: ['id', 'text'],
      },
      async ({ id, text }, ctx) => {
        if (String(text).length > OBSERVE_TEXT_MAX_LEN) {
          return { error: caseyText("src/case-tools-record-timeline.js#s2", [String(text).length, OBSERVE_TEXT_MAX_LEN]) }
        }
        const c = await store().getCase(id)
        if (!c) return { error: caseyText("src/case-tools-record-timeline.js#s3", [id]) }
        const author = ctx?.author || ctx?.principal?.id
        if (!ownsCase(c.external_id, author) && !canQueryCases(ctx?.tier)) {
          return { error: caseyText("src/case-tools-record-timeline.js#4", [id]) }
        }
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text })
        return { ok: true }
      }),

    defTool('case_transition', 'cases',

      caseyText("src/case-tools-record-timeline.js#5")
      + mandatoryMinimumDescriptionClause()
      + signOffAuthorityDescriptionClause()
      + diagnosisDescriptionClause(),
      {
        type: 'object',
        properties: {
          id: str(caseyText("src/case-tools-record-timeline.js#s4")),
          to: str(caseyText("src/case-tools-record-timeline.js#s5"), { enum: stageValues }),
          reason: str(caseyText("src/case-tools-record-timeline.js#6")),
          ...Object.fromEntries(SIGNOFF_DIAGNOSIS_FIELDS.map(k => [k, str(REPORT_FIELD_DEFS.find(f => f.key === k)?.description || k, k === DIAGNOSIS_STATUS_KEY ? { enum: DIAGNOSIS_STATUS_OPTIONS } : {})])),
        },
        required: ['id', 'to'],
      },
      async ({ id, to, reason = '', ...diagnosisArgs }, ctx) => {
        const c = await store().getCase(id)
        if (!c) return { error: caseyText("src/case-tools-record-timeline.js#s6", [id]) }
        const author = ctx?.author || ctx?.principal?.id

        const unassigned = !String(c.assignee || '').trim() || String(c.assignee).trim() === 'agent'
        const signOffDesk = canSignOff(ctx?.tier) && doneStages().includes(to) && (isAssignedTo(c, ctx?.contact) || unassigned || isHandedOff(c))
        const owns = ownsCase(c.external_id, author)

        const team = canQueryCases(ctx?.tier)
        const toDone = doneStages().includes(to)
        const authority = owns ? null : authorityOn(ctx, c)
        if (!owns && !signOffDesk && !(authority && toDone) && !(team && !toDone)) {
          return { error: caseyText("src/case-tools-record-timeline.js#7", [id]) }
        }
        if (!owns && authority !== 'operator') {
          const refused = await writeGate(store(), ctx, c, { confirm: !team })
          if (refused) return refused
        }
        if (!owns && team && !toDone) {
          const stale = await checkStale(store(), ctx, c, ['col.status'])
          if (stale) return stale
        }

        if (c.autonomy === 'observe' && !isAssignedTo(c, ctx?.contact)) return { error: caseyText("src/case-tools-record-timeline.js#8") }

        const blockedBy = MANDATORY_MINIMUM_BLOCKED_STATUSES.includes(to)
          ? missingMandatoryMinimum(parseReport(c))
          : []
        if (blockedBy.length) {
          const labels = blockedBy.map(fieldLabel).join(', ')

          if (canQueryCases(ctx?.tier)) return { error: caseyText("src/case-tools-record-timeline.js#9", [REPORT_ENTITY_LABEL, labels, blockedBy.length === 1 ? 'is' : 'are', blockedBy.length === 1 ? 'it' : 'them']) }
          return { error: caseyText("src/case-tools-record-timeline.js#10", [REPORT_ENTITY_LABEL, labels, blockedBy.length === 1 ? 'is' : 'are', blockedBy.length === 1 ? caseyText("src/case-tools-record-timeline.js#s7") : caseyText("src/case-tools-record-timeline.js#s8"), REPORT_TOOL_NAME]) }
        }

        if (MANDATORY_MINIMUM_BLOCKED_STATUSES.includes(to) && !canSignOff(ctx?.tier)) {
          if (canQueryCases(ctx?.tier)) return { error: caseyText("src/case-tools-record-timeline.js#11", [REPORT_ENTITY_LABEL]) }
          return { error: caseyText("src/case-tools-record-timeline.js#12", [REPORT_ENTITY_LABEL, MANDATORY_MINIMUM_BLOCKED_STATUSES.join('/')]) }
        }

        if (MANDATORY_MINIMUM_BLOCKED_STATUSES.includes(to) && SIGNOFF_DIAGNOSIS_FIELDS.length) {
          const given = {}
          for (const k of SIGNOFF_DIAGNOSIS_FIELDS) {
            const v = cleanRelayed(diagnosisArgs[k])
            if (typeof v === 'string' && v.trim()) given[k] = v.trim()
          }
          if (DIAGNOSIS_STATUS_KEY in given) {
            const status = normalizeDiagnosisStatus(given[DIAGNOSIS_STATUS_KEY])
            if (!status) return { error: caseyText("src/case-tools-record-timeline.js#13", [fieldLabel(DIAGNOSIS_STATUS_KEY), DIAGNOSIS_STATUS_OPTIONS.join(', ')]), ...diagnosisStatusChoices(DIAGNOSIS_STATUS_OPTIONS) }
            given[DIAGNOSIS_STATUS_KEY] = status
          }
          const still = missingSignoffDiagnosis({ ...parseReport(c), ...given })
          if (still.length) return { error: caseyText("src/case-tools-record-timeline.js#14", [still.map(fieldLabel).join(' and '), still.length === 1 ? caseyText("src/case-tools-record-timeline.js#s9") : caseyText("src/case-tools-record-timeline.js#s10"), still.length === 1 ? 'it' : 'them', still.join(' and '), still.length === 1 ? 'one' : 'either']), ...(still.length === 1 && still[0] === DIAGNOSIS_STATUS_KEY && DIAGNOSIS_STATUS_OPTIONS ? diagnosisStatusChoices(DIAGNOSIS_STATUS_OPTIONS) : {}) }
          const tooLong = Object.keys(given).filter(k => given[k].length > APPEND_FIELD_MAX_LEN)
          if (tooLong.length) return { error: caseyText("src/case-tools-record-timeline.js#15", [tooLong.map(fieldLabel).join(', '), APPEND_FIELD_MAX_LEN]) }

          if (to !== c.status && !store().availableTransitions(c, AGENT_USER).includes(to)) return { error: caseyText("src/case-tools-record-timeline.js#s11", [c.status, to, store().availableTransitions(c, AGENT_USER).join(', ')]) }
          if (Object.keys(given).length) {
            const merged = await store().mergeReport(c.id, given, AGENT_USER, { bypassObserve: true, autoAssign: false })
            if (merged.error) return { error: merged.error }
            await store().appendEvent(c.id, { kind: 'action', actor: 'operator', text: caseyText("src/case-tools-record-timeline.js#s12", [staffLabel(ctx?.contact), Object.keys(given).map(fieldLabel).join(', ')]), data: actorData(ctx, { on_behalf: true, signoff: true, ...given }) })
          }
        }
        try {
          await store().transition(id, to, { user: AGENT_USER, reason })
          const on = owns ? null : await recordedOn(store(), c, ctx)
          if (doneStages().includes(to)) await clearFocusForCase(store(), c.id)
          else if (!owns && team) await recordWrote(store(), ctx?.contact?.id, await store().getCase(c.id), ['col.status'])
          return { ok: true, from: c.status, to, ...(on ? { recorded_on: on } : {}) }
        } catch (e) {
          return { error: e.message }
        }
      }),
  ]
}
