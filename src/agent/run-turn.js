import { createUserMessage } from '@freddie/freddie-llm'
import { SessionId } from '@freddie/freddie-session'
import { installToolAllowlist } from '../../freddie-bundle/src/case-tools/tool-allowlist.js'
import { installCasePrompt } from '../../freddie-bundle/src/case-tools/case-prompt.js'
import { LOCATION_STALE_MS } from '../hooks/prompt-context.js'
import { resolveTierValue } from '../contact-tiers.js'
import { eraseCaseSessions, agentKeyFor } from '../store/agent-sessions.js'

let _ctx = null
export function setAgentContext(ctx) {
  _ctx = ctx
}

function requireCtx() {
  if (!_ctx) throw new Error('runTurn: freddie agent context not set -- casey.js must call setAgentContext() during boot before any inbound turn')
  return _ctx
}

const liveAgents = new Map()
const currentToolCtx = new Map()

const currentSystemPrompt = new Map()

const currentAllowedNames = new Map()

export const AGENT_IDLE_TTL_MS = Number(process.env.CASEY_AGENT_IDLE_TTL_MS) || LOCATION_STALE_MS
const IDLE_SWEEP_INTERVAL_MS = Number(process.env.CASEY_AGENT_IDLE_SWEEP_MS) || 5 * 60e3

function logAgentEvent(msg, fields) {
  console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', component: 'agent', msg, ...fields }))
}

let sweepTimer = null

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

export async function evictAgent(sessionKey, reason) {
  const entry = liveAgents.get(sessionKey)
  if (!entry) return null
  liveAgents.delete(sessionKey)
  const akey = entry.akey || sessionKey
  currentToolCtx.delete(akey)
  currentSystemPrompt.delete(akey)
  currentAllowedNames.delete(akey)
  stopSweepTimerIfEmpty()
  const idleMs = Date.now() - entry.lastUsedAt
  try {
    await entry.dispose?.()
    logAgentEvent('agent_evicted', { sessionKey, reason, idle_ms: idleMs, resident: liveAgents.size })
  } catch (e) {
    console.error(JSON.stringify({
      t: new Date().toISOString(), level: 'error', component: 'agent',
      msg: 'agent_dispose_failed', sessionKey, reason, error: e?.message || String(e),
    }))
  }
  return entry.agent
}

export async function sweepIdleAgents(nowMs = Date.now(), ttlMs = AGENT_IDLE_TTL_MS) {
  const stale = []
  for (const [sessionKey, entry] of liveAgents) {
    if (nowMs - entry.lastUsedAt >= ttlMs) stale.push(sessionKey)
  }
  for (const sessionKey of stale) await evictAgent(sessionKey, 'idle_ttl')
  return stale
}

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

async function getOrCreateAgent(sessionKey, akey, provider, model, enabledToolNames, tier) {
  const ctx = requireCtx()
  const existing = liveAgents.get(sessionKey)
  if (existing) {
    existing.lastUsedAt = Date.now()
    return existing.agent
  }
  const sessionId = SessionId(akey)
  const agentOptions = { provider, model }
  const setup = (agentCtx) => {
    installToolAllowlist(agentCtx, () => currentAllowedNames.get(akey) || enabledToolNames)
    installCasePrompt(agentCtx, () => currentSystemPrompt.get(akey) || '', () => currentAllowedNames.get(akey) || enabledToolNames)
  }
  let handle = null
  try {
    handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
  } catch (e) {
    const message = e?.message || String(e)
    if (!/not found/i.test(message)) {
      console.error(JSON.stringify({
        t: new Date().toISOString(), level: 'error', component: 'agent',
        msg: 'agent_resume_failed', sessionKey, error: message,
      }))
    }
  }
  if (handle) {
    liveAgents.set(sessionKey, { agent: handle.agent, dispose: handle.dispose, lastUsedAt: Date.now(), tier, akey })
    ensureSweepTimer()
    return handle.agent
  }
  handle = await ctx.agents.create({
    sessionId,
    agentOptions,
    setup,
  })
  liveAgents.set(sessionKey, { agent: handle.agent, dispose: handle.dispose, lastUsedAt: Date.now(), tier, akey })
  ensureSweepTimer()
  return handle.agent
}

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
    if (event.type === 'tool/result') {
      for (const block of event.data?.message?.content || []) {
        if (block?.type !== 'tool-result') continue
        const text = Array.isArray(block.content)
          ? block.content.filter(b => b?.type === 'text').map(b => b.text).join('')
          : (typeof block.content === 'string' ? block.content : JSON.stringify(block.content))
        messages.push({ role: 'tool', tool_call_id: block.toolCallId, content: text })
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

export async function runTurn({
  prompt,
  systemPrompt = null,
  messages = [],
  sessionKey,
  enabledToolsets = [],
  disabledToolsets = [],
  toolCtx = null,
  timeoutMs = 30000,
  provider = 'acptoapi',
  model = process.env.CASEY_LLM_MODEL || process.env.FREDDIE_LLM_MODEL || null,
} = {}) {
  const turnTier = resolveTierValue(toolCtx?.tier)
  const liveEntry = liveAgents.get(sessionKey)
  if (liveEntry && liveEntry.tier !== turnTier) {
    await evictAgent(sessionKey, 'tier_changed')
    eraseCaseSessions([String(sessionKey).replace(/^case:/, '')])
  }
  const akey = agentKeyFor(sessionKey)

  const { buildCaseToolset } = await import('../case-tools.js')
  const allNames = buildCaseToolset(null).map(t => t.name)
  const disabledSet = new Set(disabledToolsets)
  const enabledToolNames = enabledToolsets.includes('cases')
    ? allNames.filter(n => !disabledSet.has(n))
    : []

  const composedSystemPrompt = systemPrompt
    || messages.find(m => m?.role === 'system')?.content
    || ''
  if (composedSystemPrompt) currentSystemPrompt.set(akey, composedSystemPrompt)
  else console.error(JSON.stringify({
    t: new Date().toISOString(), level: 'error', component: 'agent',
    msg: 'agent_turn_without_case_system_prompt', sessionKey,
  }))

  currentAllowedNames.set(akey, enabledToolNames)
  const agent = await getOrCreateAgent(sessionKey, akey, provider, model, enabledToolNames, turnTier)
  currentToolCtx.set(akey, toolCtx || {})
  await agent.whenIdle()
  const firstSeq = agent.session.seq

  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))

  let timedOut = false
  await Promise.race([
    agent.whenIdle(),
    new Promise((resolve) => setTimeout(() => { timedOut = true; resolve() }, timeoutMs)),
  ])

  const entry = liveAgents.get(sessionKey)
  if (entry) entry.lastUsedAt = Date.now()

  if (timedOut) {
    return { result: null, error: 'timeout', messages: [], iterations: 0 }
  }
  return summarizeSince(agent, firstSeq)
}

export function disposeAgent(sessionKey) {
  return evictAgent(sessionKey, 'case_closed')
}

export function getCurrentToolCtx(sessionKey) {
  return currentToolCtx.get(sessionKey) || {}
}
