

import { getCaseStore } from './case-runtime.js'
import { REPORT_TOOL_NAME, NEVER_INFERRED_FIELDS, MANDATORY_MINIMUM_FIELDS } from './store/report-shape.js'
import {
  fieldEnumHint, stageHint,
  FALLBACK_CASE_TYPE_VALUES, FALLBACK_PRIORITY_VALUES,
} from './case-tools-shared.js'
import { REPORT_ONLY_TOOLS, gateByTier, dedupeDuplicateCalls, toolVisibleToTier } from './case-tools-gates.js'
import { buildLookupTools } from './case-tools-lookup.js'
import { buildRecordTools } from './case-tools-record.js'
import { buildTriageTools } from './case-tools-triage.js'
import { buildWorkerTools } from './case-tools-worker.js'
import { buildBindingTools } from './case-tools-binding.js'
import { buildControlTools } from './case-tools-control.js'
import { buildTeamTools } from './case-tools-team.js'
import { buildFeedbackTools } from './case-tools-feedback.js'
import { buildSpeakerTools } from './case-tools-speaker.js'
import { buildConsentTools } from './case-tools-consent.js'
import { buildClarifyTools } from './case-tools-clarify.js'

export function buildCaseToolset(storeOrNull) {
  const store = () => storeOrNull || getCaseStore()

  const enums = {
    caseTypeValues: fieldEnumHint(store, 'case.case_type', FALLBACK_CASE_TYPE_VALUES),
    priorityValues: fieldEnumHint(store, 'case.priority', FALLBACK_PRIORITY_VALUES),
    stageValues: stageHint(store),
  }

  const tools = [
    ...buildLookupTools(store, enums),
    ...buildRecordTools(store, enums),
    ...buildTriageTools(store),
    ...buildWorkerTools(store),
    ...buildBindingTools(store),
    ...buildControlTools(store),

    ...buildTeamTools(store, enums),
    ...buildFeedbackTools(store),
    ...buildSpeakerTools(store),
    ...buildConsentTools(store),
    ...buildClarifyTools(store),
  ]
  return tools.map(gateByTier).map(t => dedupeDuplicateCalls(t, store))
}

function selfCheckLoadBearingToolDescriptions() {
  const tools = buildCaseToolset({})
  const byName = Object.fromEntries(tools.map(t => [t.name, t]))
  const required = [
    { tool: 'case_update', field: 'case_type', pattern: /directly and explicitly stated/, name: 'case_type must be agent-stated-only, never inferred' },
    { tool: 'case_speaker', field: null, pattern: /Never guess or invent a name/, name: 'case_speaker must record a name only as a person said it, never a guess' },
    { tool: REPORT_TOOL_NAME, field: 'location_source', pattern: /Never guess "confirmed"/, name: 'location_source "confirmed" must require the contact actually agreeing, never be guessed' },

    ...NEVER_INFERRED_FIELDS.map(f => ({
      tool: REPORT_TOOL_NAME, field: f.key,
      pattern: new RegExp(f.never_inferred_guard_pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      name: `${f.key} must be agent-stated-only, never inferred`,
    })),

    ...(MANDATORY_MINIMUM_FIELDS.length ? [{
      tool: 'case_transition', field: null,
      pattern: /this tool REFUSES a move to/,
      name: 'case_transition must name the mandatory-minimum refusal in its own description',
    }, {

      tool: 'case_transition', field: null,
      pattern: /restricted to the animal health technician who signs it off/,
      name: 'case_transition must name the sign-off-authority refusal in its own description',
    }] : []),
  ]
  for (const { tool, field, pattern, name } of required) {
    const desc = byName[tool]?.schema?.parameters?.properties?.[field]?.description
      || byName[tool]?.schema?.description || ''
    if (!pattern.test(desc)) {
      throw new Error(`case-tools regression: required phrase missing (${name}, tool=${tool}, field=${field}). A tool-description rewrite silently dropped a load-bearing report-not-assert boundary -- see AGENTS.md's prompt-steering notes.`)
    }
  }
}

export function reporterTierExcludedToolNames() {
  return hiddenToolNamesForTier('reporter')
}

export function hiddenToolNamesForTier(tier) {
  return buildCaseToolset(null).map(t => t.name).filter(name => !toolVisibleToTier(name, tier))
}

selfCheckLoadBearingToolDescriptions()
