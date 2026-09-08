// Casey's runTurn, now a thin adapter driving freddie's REAL agent loop
// (packages/core/agent-loop's ReactLoopAgent, reached via ctx.agents) instead
// of a casey-owned tool loop -- freddie must be the agent for casey (user
// directive). This module keeps runTurn's existing call signature/return
// shape exactly (casey's guaranteed-delivery/rate-limit/dedup orchestration --
// hooks/handler.js plus the hooks/{inbound-turn,case-intake,turn-attempts,
// turn-outcome,delivery}.js phases it sequences -- is unchanged and still calls
// this function the same way, from hooks/turn-attempts.js's attempt loop), but
// the body now creates or resumes a freddie Agent per case,
// submits the message via agent.followup(), awaits agent.whenIdle(), and
// reads the reply back from the session's event log -- the exact pattern
// freddie's own packages/bundle/headless/src/index.js uses end to end.
//
// The live freddie Context is provided by freddie-bundle/src/platform's
// boot() call (see src/casey.js) via setAgentContext() below -- this module
// has no Cordis context of its own, since casey's process boots freddie's
// tree once and every inbound turn reaches into that same tree.
import { createUserMessage } from '@freddie/freddie-llm'
import { SessionId } from '@freddie/freddie-session'
import { installToolAllowlist } from '../../freddie-bundle/src/case-tools/tool-allowlist.js'

let _ctx = null
export function setAgentContext(ctx) {
  _ctx = ctx
}

function requireCtx() {
  if (!_ctx) throw new Error('runTurn: freddie agent context not set -- casey.js must call setAgentContext() during boot before any inbound turn')
  return _ctx
}

// One live agent per sessionKey (casey's `case:<id>`), so a conversation's
// context/tool-visibility setup happens once and every later turn reuses the
// same running agent rather than re-creating it. Cleared on dispose (process
// shutdown) only -- casey's own case lifecycle (open/closed) does not map to
// agent disposal, matching freddie's own session-per-conversation model.
//
// currentToolCtx is a per-sessionKey MUTABLE CELL, not a per-agent constant:
// casey's case_* tool handlers need the LIVE toolCtx (author/tier/store/
// activeCaseBinding/dedupeCache) for the turn currently in flight, which
// differs on every runTurn() call even though the agent itself is reused.
// case-tools/index.js's plugin reads this cell (via getToolCtx()) at EACH
// tool dispatch, not once at agent-creation time -- installToolAllowlist's
// own setup() only runs once per agent, so the allowlist itself is fixed at
// creation (tier changes would need a fresh agent, which casey does not
// currently do since tier is stable per-contact in practice).
const liveAgents = new Map()
const currentToolCtx = new Map()

async function getOrCreateAgent(sessionKey, provider, model, enabledToolNames) {
  const ctx = requireCtx()
  const existing = liveAgents.get(sessionKey)
  if (existing) return existing
  const { agent } = await ctx.agents.create({
    sessionId: SessionId(sessionKey),
    agentOptions: { provider, model },
    // SECURITY (AGENTS.md "pi tool surface"): freddie's own base bundle
    // registers real bash/write/edit/file/credential tools alongside
    // casey's case_* tools in the SAME global ctx.tools registry -- there
    // is no toolset-category filter at the freddie layer. installToolAllowlist
    // hooks both system-prompt/assemble (hides every non-allowlisted tool's
    // schema from the model) and tools/pre-execute (denies dispatch of any
    // non-allowlisted tool by name even if the model somehow names one) --
    // defense in depth, scoped to THIS agent's context only via setup().
    // setup()'s return value (if any) must be a {commit()} object or
    // undefined -- installToolAllowlist returns a disposer function, which
    // is neither, so it must not be returned here directly.
    setup: (agentCtx) => { installToolAllowlist(agentCtx, enabledToolNames) },
  })
  liveAgents.set(sessionKey, agent)
  return agent
}

// Extract the assistant's final reply text plus every tool_calls/tool-result
// pair since `firstSeq`, in casey's own {role, content, tool_calls}/{role,
// tool_call_id, content} shape -- hooks/turn-results.js's mutatingActions/
// hadSuccessfulWrite/toolCaseRefs scan `result.messages` for exactly this shape.
function summarizeSince(agent, firstSeq) {
  const messages = []
  let result = ''
  let sawTurnEnd = false
  let errorReason = null
  for (const event of agent.session.events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'assistant/message') {
      const blocks = event.data.message.content
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
      const toolCalls = blocks
        .filter(b => b.type === 'tool-call')
        .map(b => ({ id: b.id, name: b.name, arguments: (() => { try { return JSON.parse(b.arguments) } catch { return {} } })() }))
      if (text) result = text
      messages.push({ role: 'assistant', content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) })
      continue
    }
    if (event.type === 'user/message' && event.data?.source?.kind === 'tool') {
      const block = event.data.content?.[0]
      if (block?.type === 'tool-result') {
        messages.push({ role: 'tool', tool_call_id: block.toolCallId, content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) })
      }
      continue
    }
    if (event.type === 'turn/end') {
      sawTurnEnd = true
      if (event.data?.reason?.kind === 'error') errorReason = event.data.reason.error?.message || 'agent turn error'
      if (event.data?.reason?.kind === 'aborted') errorReason = 'agent turn aborted'
    }
  }
  return { result, messages, error: sawTurnEnd ? errorReason : 'turn did not complete', iterations: messages.filter(m => m.role === 'assistant').length }
}

/**
 * runTurn({prompt, messages, sessionKey, tool_choice, enabledToolsets,
 *          disabledToolsets, toolCtx, timeoutMs}) -> {result, error, messages, iterations}
 *
 * `messages`/`callLLM`/`tool_choice` from the old casey-owned loop no longer
 * apply here (freddie's own agent-loop owns message history and the
 * tool_choice/iteration policy internally) -- kept as accepted-but-unused
 * params so hooks/turn-attempts.js's call site needs no change. `enabledToolsets`/
 * `disabledToolsets` are translated into an explicit tool NAME allowlist
 * (freddie has no toolset-category concept of its own).
 */
export async function runTurn({
  prompt,
  sessionKey,
  enabledToolsets = [],
  disabledToolsets = [],
  toolCtx = null,
  timeoutMs = 30000,
  provider = 'acptoapi',
  // Default from the same env the acptoapi adapter itself falls back to
  // (freddie-bundle/src/llm-acptoapi/adapter.js's getModel). hooks/turn-attempts.js
  // does not pass a model -- it never had to, since the old casey-owned loop
  // resolved it inside callLLM -- so leaving this undefined made freddie's
  // agent layer reject EVERY turn with "agent has no provider/model" before
  // the adapter was ever consulted (witnessed live against a booted tree).
  // Resolving it here keeps that single knob (CASEY_LLM_MODEL) authoritative
  // and lets a comma-separated fallback chain through untouched -- the
  // adapter, not the agent layer, is what understands chain syntax.
  model = process.env.CASEY_LLM_MODEL || process.env.FREDDIE_LLM_MODEL || null,
} = {}) {
  // Resolve enabledToolsets/disabledToolsets into a real tool-name allowlist.
  // enabledToolsets:['cases'] means every case_* tool name; disabledToolsets
  // further excludes specific names (reporter-tier field_worker-gated tools) --
  // matches the exact semantics hooks/turn-attempts.js's call site already assumes.
  const { buildCaseToolset } = await import('../case-tools.js')
  const allNames = buildCaseToolset(null).map(t => t.name)
  const disabledSet = new Set(disabledToolsets)
  const enabledToolNames = enabledToolsets.includes('cases')
    ? allNames.filter(n => !disabledSet.has(n))
    : []

  const agent = await getOrCreateAgent(sessionKey, provider, model, enabledToolNames)
  // Publish this turn's toolCtx BEFORE followup() so case-tools/index.js's
  // getToolCtx() thunk (read at each tool dispatch during this turn) sees
  // the current call's author/tier/store/activeCaseBinding, not a stale one
  // from a prior turn on the same reused agent.
  currentToolCtx.set(sessionKey, toolCtx || {})
  await agent.whenIdle()
  const firstSeq = agent.session.seq

  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))

  let timedOut = false
  await Promise.race([
    agent.whenIdle(),
    new Promise((resolve) => setTimeout(() => { timedOut = true; resolve() }, timeoutMs)),
  ])

  if (timedOut) {
    return { result: null, error: 'timeout', messages: [], iterations: 0 }
  }
  return summarizeSince(agent, firstSeq)
}

export function disposeAgent(sessionKey) {
  const agent = liveAgents.get(sessionKey)
  liveAgents.delete(sessionKey)
  currentToolCtx.delete(sessionKey)
  return agent
}

// Read by case-tools/index.js's execute() wrapper at each tool dispatch. The
// live agent's own session id IS the sessionKey runTurn() was called with
// (SessionId() is an identity brand, not a transform), so exec.agent.id
// round-trips back to the same key currentToolCtx was set under.
export function getCurrentToolCtx(sessionKey) {
  return currentToolCtx.get(sessionKey) || {}
}
