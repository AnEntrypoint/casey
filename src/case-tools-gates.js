

import { visibleToolName } from './config-loader.js'
import { boundCase } from './case-tools-shared.js'
import { atLeast, TIER } from './contact-tiers.js'

export const REPORT_ONLY_TOOLS = new Set(['case_report', 'case_stop', 'case_handoff', 'case_new', 'case_feedback', 'case_speaker', 'case_consent', 'case_clarify'])

const GENERIC_TOOL_MIN_TIER = {
  case_search: TIER.field, case_pending: TIER.field, case_claim: TIER.field, case_release: TIER.field,
  case_dispatch_reply: TIER.field, case_focus: TIER.field, case_gaps: TIER.field,
  case_contact: TIER.field, case_edit: TIER.field, case_stage: TIER.field,
  case_message: TIER.field,
  signoff_queue: TIER.specialist, case_review: TIER.specialist,
  case_reopen: TIER.specialist, case_ask_specialist: TIER.specialist,
  team_queue: TIER.operator, team_handover: TIER.operator, team_assign: TIER.operator,
  team_draft: TIER.operator, team_invite: TIER.operator,
  team_register: TIER.operator, team_roster: TIER.operator, team_quiet_staff: TIER.operator,
  team_nudge_staff: TIER.operator, team_feedback: TIER.operator,
  case_handoff_to_specialist: TIER.field, case_my_day: TIER.field,
  team_specialist_day: TIER.operator, team_relocate_case: TIER.operator,
  case_visit: TIER.field, case_visit_log: TIER.field,
  case_note_to_specialist: TIER.specialist,
  case_withdraw_handoff: TIER.field,
  case_photos: TIER.field,
}

export const TOOL_MIN_TIER = Object.fromEntries(Object.entries(GENERIC_TOOL_MIN_TIER).map(([name, tier]) => [visibleToolName(name), tier]))

export function minTierOf(name) {
  if (REPORT_ONLY_TOOLS.has(name)) return TIER.reporter
  return TOOL_MIN_TIER[name] || TIER.field
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
