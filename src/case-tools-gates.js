// case-tools-gates.js  --  the two wrappers every case_* tool passes through.
//
// These are cross-cutting decorators, not tools: gateByTier is the access-tier
// enforcement boundary (fail-closed to reporter), dedupeDuplicateCalls
// suppresses an exact repeat call within one turn. buildCaseToolset applies
// both, in this order, to every tool it builds.

import { boundCase } from './case-tools-shared.js'
import { atLeast, TIER_REPORTER, TIER_FIELD_WORKER, TIER_ANIMAL_HEALTH_TECHNICIAN, TIER_OPERATOR } from './contact-tiers.js'

// Tier gate: a 'reporter'-tier contact (casual/public, report-only per the
// operator-assignable access-tier design) can report an incident and use the
// two irreversible safety controls, but cannot agentically QUERY the case
// database -- case_list with a location filter, for instance, would let an
// anonymous public contact enumerate other reporters' case locations even
// through the PII-free projection. Only contacts at or above 'field_worker'
// tier (and the
// dashboard/CLI, which never go through this per-turn toolCtx path at all)
// reach the query/mutation tools. REPORT_ONLY_TOOLS are available at every
// tier: case_report (the whole point of a reporter existing), case_stop/
// case_handoff (opt-out/human-escalation, service controls not data access),
// case_new (opening a fresh case for a genuinely new situation -- the
// never-a-dead-end design principle applies to every reporter, not only
// field workers; without this, a reporter's second unrelated report has no
// tool to branch and silently overwrites the first via mergeReport's
// fill-if-empty semantics). case_split stays field_worker-only: it edits an
// EXISTING case's already-recorded history, a materially different risk
// than opening a brand new empty one.
export const REPORT_ONLY_TOOLS = new Set(['case_report', 'case_stop', 'case_handoff', 'case_new', 'case_feedback', 'case_speaker', 'case_consent', 'case_clarify'])

// The MINIMUM rung of every team tool (case-tools-team*.js). Any non-report tool
// not listed here needs field_worker, exactly as before. A RANK test through
// atLeast, so an unknown or missing tier resolves to the lowest rung and is
// refused: adding a tool means adding a row, and forgetting the row leaves it at
// field_worker, never wider. Sign-off is not a row: it stays case_transition's
// canSignOff equality, which no rank here can grant.
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
}

export function minTierOf(name) {
  if (REPORT_ONLY_TOOLS.has(name)) return TIER_REPORTER
  return TOOL_MIN_TIER[name] || TIER_FIELD_WORKER
}

// Does a contact at `tier` get to SEE (and call) this tool? The one predicate the
// call-time gate, the per-tier schema hiding and the allowlist derivation share.
export function toolVisibleToTier(name, tier) {
  return atLeast(tier, minTierOf(name))
}

export function gateByTier(tool) {
  if (REPORT_ONLY_TOOLS.has(tool.name)) return tool
  const handler = tool.handler
  return {
    ...tool,
    handler: async (args, ctx) => {
      // FAIL CLOSED: allow-list, not deny-list. A ctx built with no tier at all
      // (a missing/undefined value, not merely a wrong one) must NOT fall through
      // to full access -- only a tier that EXPLICITLY names a rung at or above
      // field_worker proceeds. An
      // `if (ctx?.tier && !canQueryCases(ctx.tier))` shape denies only when a
      // tier is present and wrong, and silently grants full access to any caller
      // whose ctx carries no tier property whatsoever; canQueryCases resolves an
      // unknown/absent value to the lowest rung first (contact-tiers.js), so the
      // fail-closed direction lives in one place rather than in this expression.
      //
      // A RANK test, not an equality test: animal_health_technician sits ABOVE
      // field_worker, so an equality comparison here would deny the system's
      // highest-privilege contact every query tool while granting them to the
      // rung below. See contact-tiers.js for the ladder.
      //
      // The result text is deliberately NOT an explanation of internal
      // permissions/tools/tiers -- a model that sees a tool-shaped "requires
      // field-worker access" string composes a reply that parrots that exact
      // internal language back to the contact ("I don't have the necessary
      // permissions to access the case list"), which the outbound jargon scrub
      // then holds as an unsent draft, leaving the contact with silence. This
      // tells the model plainly, in conversational terms, to drop the query and
      // keep going -- nothing here is safe or useful to relay to the person
      // messaging in.
      if (!toolVisibleToTier(tool.name, ctx?.tier)) {
        return { unavailable: true, note: 'This is not something you can look up for this person. Do not mention tools, permissions, or access -- just continue the conversation naturally: report their case, or answer using what you already know from this conversation.' }
      }
      return handler(args, ctx)
    },
  }
}

// Suppress an EXACT repeat tool call (same name, same args) within one turn.
// A model occasionally calls case_report/case_list twice in a row with
// identical arguments in a single runTurn loop -- with no defense this
// produces a duplicate event row (case_report) or a wasted query, silently.
// Keyed on toolCtx.dedupeCache, a plain Map the caller creates FRESH per turn
// (hooks/turn-attempts.js) -- never persisted across turns, so this can only ever
// suppress a repeat within the SAME turn's own tool-call sequence, never mask
// a genuine second call in a later turn. Applied to every tool (including
// REPORT_ONLY_TOOLS, which gateByTier passes through untouched) since
// case_report is exactly the tool this most needs to catch. Takes the same
// `store` closure buildCaseToolset's own tools use (storeOrNull || the
// runtime singleton) rather than calling getCaseStore() directly, so this
// works identically under buildCaseToolset(explicitStore) (any caller that
// wants the tools without the runtime singleton) and under the real
// plugin-loaded singleton path.
// A deterministic key for a tool call's arguments, stable under key order at
// EVERY nesting level. Must not be JSON.stringify's replacer-array form:
// `JSON.stringify(args, Object.keys(args).sort())` applies that allowlist
// recursively, so any nested object serializes as {} -- case_list's
// near:{lat,lon,radius_km} collapsed to near:{}, making two "cases near here"
// calls for DIFFERENT places share one key. The second caller then silently
// received the first location's results, recorded in the audit trail as a
// suppressed duplicate.
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
          } catch { /* best effort -- never block the cached result on a logging failure */ }
        }
        return cache.get(key)
      }
      const result = await handler(args, ctx)
      cache.set(key, result)
      return result
    },
  }
}
