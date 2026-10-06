

import { boundCase } from './case-tools-shared.js'
import { atLeast, TIER_REPORTER, TIER_FIELD_WORKER, TIER_ANIMAL_HEALTH_TECHNICIAN, TIER_OPERATOR } from './contact-tiers.js'

export const REPORT_ONLY_TOOLS = new Set(['case_report', 'case_stop', 'case_handoff', 'case_new', 'case_feedback', 'case_speaker', 'case_consent', 'case_clarify'])

export const TOOL_MIN_TIER = {
  case_pending: TIER_FIELD_WORKER, case_claim: TIER_FIELD_WORKER, case_release: TIER_FIELD_WORKER,
  case_dispatch_reply: TIER_FIELD_WORKER, case_focus: TIER_FIELD_WORKER, case_gaps: TIER_FIELD_WORKER,
  case_contact: TIER_FIELD_WORKER, case_edit: TIER_FIELD_WORKER, case_stage: TIER_FIELD_WORKER,
  case_message: TIER_FIELD_WORKER,
  signoff_queue: TIER_ANIMAL_HEALTH_TECHNICIAN, case_review: TIER_ANIMAL_HEALTH_TECHNICIAN,
  case_reopen: TIER_ANIMAL_HEALTH_TECHNICIAN, case_ask_ranger: TIER_ANIMAL_HEALTH_TECHNICIAN,
  team_queue: TIER_OPERATOR, team_handover: TIER_OPERATOR, team_assign: TIER_OPERATOR,
  team_draft: TIER_OPERATOR, team_remind: TIER_OPERATOR, team_invite: TIER_OPERATOR,
  team_register: TIER_OPERATOR, team_roster: TIER_OPERATOR, team_quiet_staff: TIER_OPERATOR,
  team_nudge_staff: TIER_OPERATOR, team_feedback: TIER_OPERATOR,
  case_handoff_to_technician: TIER_FIELD_WORKER, case_my_day: TIER_FIELD_WORKER,
  team_ranger_day: TIER_OPERATOR, team_relocate_case: TIER_OPERATOR,
  case_visit: TIER_FIELD_WORKER, case_visit_log: TIER_FIELD_WORKER,
}

export function minTierOf(name) {
  if (REPORT_ONLY_TOOLS.has(name)) return TIER_REPORTER
  return TOOL_MIN_TIER[name] || TIER_FIELD_WORKER
}

export function toolVisibleToTier(name, tier) {
  return atLeast(tier, minTierOf(name))
}

export function gateByTier(tool) {
  if (REPORT_ONLY_TOOLS.has(tool.name)) return tool
  const handler = tool.handler
  return {
    ...tool,
    handler: async (args, ctx) => {

      if (!toolVisibleToTier(tool.name, ctx?.tier)) {
        return { unavailable: true, note: 'This is not something you can look up for this person. Do not mention tools, permissions, or access -- just continue the conversation naturally: report their case, or answer using what you already know from this conversation.' }
      }
      return handler(args, ctx)
    },
  }
}

function stableArgsKey(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableArgsKey).join(',')}]`
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableArgsKey(v[k])}`).join(',')}}`
}

export function dedupeDuplicateCalls(tool, store) {
  const handler = tool.handler
  return {
    ...tool,
    handler: async (args, ctx) => {
      const cache = ctx?.dedupeCache
      if (!(cache instanceof Map)) return handler(args, ctx)
      const dedupeLogTarget = boundCase(ctx).id
      const key = `${tool.name}:${dedupeLogTarget}:${stableArgsKey(args)}`
      if (cache.has(key)) {
        if (dedupeLogTarget) {
          try {
            await store().appendEvent(dedupeLogTarget, {
              kind: 'observation', actor: 'system',
              text: `duplicate tool call suppressed: ${tool.name}`,
              data: { duplicate_tool_call_suppressed: true, tool: tool.name },
            })
          } catch {  }
        }
        return cache.get(key)
      }
      const result = await handler(args, ctx)
      cache.set(key, result)
      return result
    },
  }
}
