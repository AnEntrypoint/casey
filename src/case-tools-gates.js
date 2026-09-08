// case-tools-gates.js  --  the two wrappers every case_* tool passes through.
//
// Split out of case-tools.js unchanged. These are cross-cutting decorators, not
// tools: gateByTier is the access-tier enforcement boundary (fail-closed to
// reporter), dedupeDuplicateCalls suppresses an exact repeat call within one
// turn. buildCaseToolset applies both, in this order, to every tool it builds.

import { boundCase } from './case-tools-shared.js'

// Tier gate: a 'reporter'-tier contact (casual/public, report-only per the
// operator-assignable access-tier design) can report an incident and use the
// two irreversible safety controls, but cannot agentically QUERY the case
// database -- case_list with a location filter, for instance, would let an
// anonymous public contact enumerate other reporters' case locations even
// through the PII-free projection. Only 'field_worker'-tier contacts (and the
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
export const REPORT_ONLY_TOOLS = new Set(['case_report', 'case_stop', 'case_handoff', 'case_new'])

export function gateByTier(tool) {
  if (REPORT_ONLY_TOOLS.has(tool.name)) return tool
  const handler = tool.handler
  return {
    ...tool,
    handler: async (args, ctx) => {
      // FAIL CLOSED: allow-list, not deny-list. A ctx built with no tier at all
      // (a missing/undefined value, not merely a wrong one) must NOT fall through
      // to full access -- only an EXPLICIT 'field_worker' tier proceeds. The prior
      // `if (ctx?.tier && ctx.tier !== 'field_worker')` shape only denied when a
      // tier was present and wrong, silently granting full access to any caller
      // whose ctx carried no tier property whatsoever.
      //
      // The result text is deliberately NOT an explanation of internal
      // permissions/tools/tiers -- a model that sees a tool-shaped "requires
      // field-worker access" string has repeatedly composed a reply that
      // parrots that exact internal language back to the contact (witnessed:
      // "I don't have the necessary permissions to access the case list"),
      // which the outbound jargon scrub then holds as an unsent draft, leaving
      // the contact with silence. This tells the model plainly, in
      // conversational terms, to drop the query and keep going -- nothing here
      // is safe or useful to relay to the person messaging in.
      if (ctx?.tier !== 'field_worker') {
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
// (hooks/handler.js) -- never persisted across turns, so this can only ever
// suppress a repeat within the SAME turn's own tool-call sequence, never mask
// a genuine second call in a later turn. Applied to every tool (including
// REPORT_ONLY_TOOLS, which gateByTier passes through untouched) since
// case_report is exactly the tool this most needs to catch. Takes the same
// `store` closure buildCaseToolset's own tools use (storeOrNull || the
// runtime singleton) rather than calling getCaseStore() directly, so this
// works identically under buildCaseToolset(explicitStore) (tests, or any
// caller that wants the tools without the runtime singleton) and under the
// real plugin-loaded singleton path.
export function dedupeDuplicateCalls(tool, store) {
  const handler = tool.handler
  return {
    ...tool,
    handler: async (args, ctx) => {
      const cache = ctx?.dedupeCache
      if (!(cache instanceof Map)) return handler(args, ctx)
      const dedupeLogTarget = boundCase(ctx).id
      const key = `${tool.name}:${dedupeLogTarget}:${JSON.stringify(args, Object.keys(args || {}).sort())}`
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
