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
import { LOCATION_STALE_MS } from '../hooks/prompt-context.js'

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
// same running agent rather than re-creating it. Each entry holds the WHOLE
// handle ctx.agents.create() resolves -- {agent, dispose} -- not just the
// agent. The disposer is the only thing that releases the agent from freddie's
// own registries: AgentRegistry.enter() (deps/freddie packages/core/agent)
// keeps its own id-keyed store entry, and the loop's dispose() is what cancels
// the machine, unwinds its scope, and detaches both the agent and its session.
// Dropping only casey's Map reference frees nothing (freddie still holds the
// agent) AND poisons the key: witnessed on a booted tree, a second
// ctx.agents.create() on a still-live session id fails with `session "<id>"
// already exists`.
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

// IDLE TTL, not a count cap, and the choice is a correctness one rather than a
// tuning preference. A count cap ("keep the newest N agents") evicts by
// pressure: which conversation loses its agent depends on how many OTHER
// contacts happen to be active, so the agent it tears down can be one whose
// contact is mid-exchange, halfway through answering the question the model
// just asked. Everything eviction depends on to stay lossless -- a persisted
// log to resume from, a clean disposal before the next turn arrives -- is then
// being exercised on a live conversation at an arbitrary moment nothing in
// that conversation signals, and any gap in it (persistence unconfigured, a
// backend error, a turn arriving during teardown) surfaces as a contact whose
// reply silently changed character. An idle TTL confines the whole mechanism
// to conversations that have already gone quiet for the full TTL window, where
// the next inbound is a fresh arrival rather than the other half of an
// exchange in progress.
//
// The default is LOCATION_STALE_MS (3h) and it is that value deliberately, not
// coincidentally. hooks/prompt-context.js's detectReturnedAfterGap uses the
// same constant to decide that a reporter has plausibly left the site and is
// returning fresh rather than continuing; at a gap past it, caseSystemPrompt
// already re-establishes the conversation from the stored case rather than
// assuming continuity. So a TTL equal to it evicts an agent only when casey's
// own next turn on that case was already going to treat itself as a return
// after a gap. Anything shorter evicts inside a window the prompt still treats
// as one continuous exchange; anything longer only costs memory.
//
// WHAT IS LOST ON EVICTION: nothing, and that is a measured claim rather than a
// hopeful one -- it is true only because getOrCreateAgent RESUMES below.
// freddie-base mounts freddie-session-persistence-jsonl, so every session casey
// opens is already being written to FREDDIE_HOME/sessions; resume() reads that
// log back and the re-created agent starts holding the whole prior transcript.
// Witnessed on a real booted tree: an agent with a 13-event session, disposed,
// then resumed, came back at 14 events and took its next turn normally.
// The alternative was witnessed too, and it is why this is not a free choice.
// A plain create() on an evicted key returns an agent with an EMPTY session (3
// bootstrap events), and its very next turn dies with `session "<id>" is
// already bound to a different live session in this backend (id collision)`
// -- so eviction-then-create does not merely forget the conversation, it
// breaks it. Any future change here that reaches for create() on a key that
// has been live before reintroduces exactly that.
// What eviction therefore costs is only residency: the next turn on an evicted
// case pays one persisted-log read before it starts.
export const AGENT_IDLE_TTL_MS = Number(process.env.CASEY_AGENT_IDLE_TTL_MS) || LOCATION_STALE_MS
// How often idleness is checked. Only bounds how far past the TTL an agent can
// linger, never whether it is evicted; a coarse sweep costs memory for at most
// one interval, a fine one costs a timer wakeup on an idle worker.
const IDLE_SWEEP_INTERVAL_MS = Number(process.env.CASEY_AGENT_IDLE_SWEEP_MS) || 5 * 60e3

// Same JSON-line shape as casey.js's own logger, reached without importing it
// (src/casey.js imports THIS module, so the arrow only goes one way).
function logAgentEvent(msg, fields) {
  console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', component: 'agent', msg, ...fields }))
}

let sweepTimer = null

// Runs only while at least one agent is resident, so a dashboard-only process
// (which boots no freddie tree and creates no agent) never arms a timer at all.
// unref'd: an idle worker must still be able to exit.
function ensureSweepTimer() {
  if (sweepTimer) return
  sweepTimer = setInterval(() => { void sweepIdleAgents() }, IDLE_SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()
}

function stopSweepTimerIfEmpty() {
  if (sweepTimer && liveAgents.size === 0) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

// Evict one agent: drop casey's own references FIRST and synchronously (so no
// concurrent turn can pick up an agent that is being torn down, and so a
// failing disposer can never leave the key un-evictable), then release it in
// freddie. Never rejects -- every caller treats eviction as best-effort
// housekeeping, and an unhandled rejection here would take the worker down.
export async function evictAgent(sessionKey, reason) {
  const entry = liveAgents.get(sessionKey)
  if (!entry) return null
  liveAgents.delete(sessionKey)
  currentToolCtx.delete(sessionKey)
  stopSweepTimerIfEmpty()
  const idleMs = Date.now() - entry.lastUsedAt
  try {
    await entry.dispose?.()
    logAgentEvent('agent_evicted', { sessionKey, reason, idle_ms: idleMs, resident: liveAgents.size })
  } catch (e) {
    // A disposer that throws leaves freddie's registry entry behind, so the
    // next turn on this case would hit "already registered". Say so loudly
    // rather than logging a shrug: this is the one failure that turns an
    // eviction into a broken conversation.
    console.error(JSON.stringify({
      t: new Date().toISOString(), level: 'error', component: 'agent',
      msg: 'agent_dispose_failed', sessionKey, reason, error: e?.message || String(e),
    }))
  }
  return entry.agent
}

// The TTL enforcement itself. Evicts sequentially rather than in parallel: each
// dispose() awaits its agent's machine going quiescent, and a worker that has
// gone quiet for hours has no reason to tear down every conversation at once.
export async function sweepIdleAgents(nowMs = Date.now(), ttlMs = AGENT_IDLE_TTL_MS) {
  const stale = []
  for (const [sessionKey, entry] of liveAgents) {
    if (nowMs - entry.lastUsedAt >= ttlMs) stale.push(sessionKey)
  }
  for (const sessionKey of stale) await evictAgent(sessionKey, 'idle_ttl')
  return stale
}

// The runtime bound, readable without a heap dump: how many agents are resident
// right now, how idle the most idle one is, and what the policy actually is.
export function liveAgentStats(nowMs = Date.now()) {
  let oldestIdleMs = 0
  for (const entry of liveAgents.values()) {
    const idle = nowMs - entry.lastUsedAt
    if (idle > oldestIdleMs) oldestIdleMs = idle
  }
  return {
    resident: liveAgents.size,
    oldest_idle_ms: oldestIdleMs,
    idle_ttl_ms: AGENT_IDLE_TTL_MS,
    sweep_interval_ms: IDLE_SWEEP_INTERVAL_MS,
  }
}

async function getOrCreateAgent(sessionKey, provider, model, enabledToolNames) {
  const ctx = requireCtx()
  const existing = liveAgents.get(sessionKey)
  if (existing) {
    existing.lastUsedAt = Date.now()
    return existing.agent
  }
  const sessionId = SessionId(sessionKey)
  const agentOptions = { provider, model }
  // One setup for BOTH paths below. A resumed agent is published exactly like a
  // created one, so it needs the same allowlist install -- see the security
  // note on the create() call for what is being kept out. Omitting it on the
  // resume path would leave every returning conversation running against
  // freddie-base's own bash/write/credential tools.
  const setup = (agentCtx) => { installToolAllowlist(agentCtx, enabledToolNames) }
  // RESUME FIRST, create only for a session that has never existed. This is the
  // ordering the eviction policy above depends on: a case whose agent was
  // evicted still has its persisted log, and resume() is the only path that
  // reads it back -- create() on such a key yields an empty session whose next
  // turn fails outright with an id collision in the persistence backend.
  let handle = null
  try {
    handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
  } catch (e) {
    // "not found" is the ordinary cold path: this case has never conversed, so
    // there is nothing to resume and create() is correct. Anything else is a
    // real persistence fault -- still fall through to create(), because a turn
    // that cannot start is a contact who gets no reply, but say so at error
    // level rather than letting a broken backend look like a first message.
    const message = e?.message || String(e)
    if (!/not found/i.test(message)) {
      console.error(JSON.stringify({
        t: new Date().toISOString(), level: 'error', component: 'agent',
        msg: 'agent_resume_failed', sessionKey, error: message,
      }))
    }
  }
  if (handle) {
    liveAgents.set(sessionKey, { agent: handle.agent, dispose: handle.dispose, lastUsedAt: Date.now() })
    ensureSweepTimer()
    return handle.agent
  }
  handle = await ctx.agents.create({
    sessionId,
    agentOptions,
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
    setup,
  })
  liveAgents.set(sessionKey, { agent: handle.agent, dispose: handle.dispose, lastUsedAt: Date.now() })
  ensureSweepTimer()
  return handle.agent
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

  // Re-stamp AFTER the turn: idleness must be measured from when this agent
  // last finished work, not from when the turn started, or a turn that runs
  // close to the hard deadline would count its own duration as idle time.
  const entry = liveAgents.get(sessionKey)
  if (entry) entry.lastUsedAt = Date.now()

  if (timedOut) {
    return { result: null, error: 'timeout', messages: [], iterations: 0 }
  }
  return summarizeSince(agent, firstSeq)
}

// Lifecycle eviction: casey.js fires this on a transition to a non-open status.
// Delegates to evictAgent so the freddie-side release happens here too -- a
// case that closes and is later reopened takes a fresh agent, which only works
// because the disposer ran (see the liveAgents comment above). The Map delete
// inside evictAgent is synchronous and happens before the first await, so this
// stays safe to call without awaiting, as casey.js's transition hook does.
export function disposeAgent(sessionKey) {
  return evictAgent(sessionKey, 'case_closed')
}

// Read by case-tools/index.js's execute() wrapper at each tool dispatch. The
// live agent's own session id IS the sessionKey runTurn() was called with
// (SessionId() is an identity brand, not a transform), so exec.agent.id
// round-trips back to the same key currentToolCtx was set under.
export function getCurrentToolCtx(sessionKey) {
  return currentToolCtx.get(sessionKey) || {}
}
