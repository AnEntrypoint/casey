// case-tools.js  --  the agent's hands on the case system of record.
//
// These are freddie tools ({ name, toolset, schema, handler }). They give the
// agent full autonomous control over a case while keeping every action on the
// append-only timeline, so a human can observe and override. The handlers close
// over a CaseStore (resolved lazily from case-runtime so the freddie plugin
// loader can import this without the store existing yet).
//
// This file is still the single source of truth AGENTS.md describes -- which
// tools exist, in what order, and what wraps them -- but the 18 definitions no
// longer live inside one 711-line function. They are grouped by the surface
// they serve, one module each, and composed below in the SAME order they were
// always emitted (the order is pinned deliberately: it is the order freddie
// serializes the tool schemas into every request, so it is prompt-visible text
// like the descriptions themselves):
//
//   case-tools-lookup.js    case_get, case_list
//   case-tools-record.js    case_update, case_report, case_observe, case_transition
//   case-tools-triage.js    case_transitions_available, case_link_suggestions,
//                           case_split, case_health
//   case-tools-worker.js    case_mine, case_today, case_checkin, case_idle
//   case-tools-binding.js   case_new, case_switch
//   case-tools-control.js   case_stop, case_handoff
//   case-tools-shared.js    defTool, the enum-hint ladder, ownsCase, the
//                           PII projections, the small pure helpers
//   case-tools-gates.js     REPORT_ONLY_TOOLS, gateByTier, dedupeDuplicateCalls
//
// Tool names, descriptions and parameter schemas moved verbatim: they are
// prompt-visible text the model's behaviour depends on, and
// selfCheckLoadBearingToolDescriptions below is the module-load guard that
// keeps a future edit from silently dropping a load-bearing phrase from one.

import { getCaseStore } from './case-runtime.js'
import { REPORT_TOOL_NAME, NEVER_INFERRED_FIELDS } from './store/report-shape.js'
import {
  fieldEnumHint, stageHint,
  FALLBACK_CASE_TYPE_VALUES, FALLBACK_PRIORITY_VALUES,
} from './case-tools-shared.js'
import { REPORT_ONLY_TOOLS, gateByTier, dedupeDuplicateCalls } from './case-tools-gates.js'
import { buildLookupTools } from './case-tools-lookup.js'
import { buildRecordTools } from './case-tools-record.js'
import { buildTriageTools } from './case-tools-triage.js'
import { buildWorkerTools } from './case-tools-worker.js'
import { buildBindingTools } from './case-tools-binding.js'
import { buildControlTools } from './case-tools-control.js'

// Build the array of tool objects bound to an explicit store (used by anywhere
// that wants the tools without the runtime singleton).
export function buildCaseToolset(storeOrNull) {
  const store = () => storeOrNull || getCaseStore()

  // Resolved once per toolset build, from the live store where one exists.
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
  ]
  return tools.map(gateByTier).map(t => dedupeDuplicateCalls(t, store))
}

// Structural regression guard, not a test file -- same discipline and same
// failure mode as hooks/prompt.js's selfCheckLoadBearingPromptContent(): a
// tool-description rewrite (a token-budget squeeze, a copy edit) can silently
// drop a load-bearing "report, don't assert" boundary phrase without ever
// failing lint or syntax checks, since a tool description is just string
// content to every other tool in the pipeline. Runs once per process boot,
// fails loud (throws, uncaught, crashes boot) the moment case_type's or
// suspected_disease's description silently regresses back to instructing the
// agent to infer/classify rather than record only what was directly stated.
function selfCheckLoadBearingToolDescriptions() {
  const tools = buildCaseToolset({})
  const byName = Object.fromEntries(tools.map(t => [t.name, t]))
  const required = [
    { tool: 'case_update', field: 'case_type', pattern: /directly and explicitly stated/, name: 'case_type must be agent-stated-only, never inferred' },
    { tool: REPORT_TOOL_NAME, field: 'location_source', pattern: /Never guess "confirmed"/, name: 'location_source "confirmed" must require the contact actually agreeing, never be guessed' },
    // Config-driven: every report field the active config's report-fields.yml
    // flags never_inferred:true carries its own never_inferred_guard_pattern
    // (a literal substring of that field's own description) that must survive
    // any future tool-description rewrite -- generalizes the single hardcoded
    // suspected_disease check to whatever the active domain declares.
    ...NEVER_INFERRED_FIELDS.map(f => ({
      tool: REPORT_TOOL_NAME, field: f.key,
      pattern: new RegExp(f.never_inferred_guard_pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      name: `${f.key} must be agent-stated-only, never inferred`,
    })),
  ]
  for (const { tool, field, pattern, name } of required) {
    const desc = byName[tool]?.schema?.parameters?.properties?.[field]?.description
      || byName[tool]?.schema?.description || ''
    if (!pattern.test(desc)) {
      throw new Error(`case-tools regression: required phrase missing (${name}, tool=${tool}, field=${field}). A tool-description rewrite silently dropped a load-bearing report-not-assert boundary -- see AGENTS.md's prompt-steering notes.`)
    }
  }
}

// Every tool NOT in REPORT_ONLY_TOOLS is already runtime-gated to field_worker
// tier by gateByTier (case-tools-gates.js) -- but freddie's runTurn still
// serializes ALL 18 tools' full JSON-schema descriptions into every single
// request regardless of tier, since enabledToolsets operates at the
// toolset-category level ('cases' as a whole), not per-tool. For the
// far-more-common reporter tier (the default per AGENTS.md's contact.tier
// design), 14 of those 18 tool schemas
// are pure dead weight on
// every request -- they will only ever return the same
// {unavailable:true,...} rejection at call time. freddie's own
// getEnabledToolSchemas (toolsets.js) filters `disabledToolsets` by TOOL NAME
// (despite the parameter's plural-toolset-sounding name), so passing this list
// there excludes them from the request payload entirely rather than merely
// rejecting them after the model already spent tokens reading their schemas
// and (for a weak model) sometimes attempting to call them anyway. Derived
// from the live toolset rather than hand-duplicated, so a newly added
// query/mutation tool is automatically tier-gated at the request-size layer
// the same way it already is at the handler layer, with nothing to keep in
// sync by hand.
export function reporterTierExcludedToolNames() {
  return buildCaseToolset(null).map(t => t.name).filter(name => !REPORT_ONLY_TOOLS.has(name))
}

selfCheckLoadBearingToolDescriptions()
