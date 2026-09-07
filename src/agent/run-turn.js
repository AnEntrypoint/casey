// Casey's own turn-execution loop, replacing freddie's runTurn (freddie's
// agent-loop surface was removed in a later upstream rewrite -- see
// AGENTS.md's freddie-port PRD rows). Deliberately minimal: only the subset
// of freddie's real machine_builder.js/turn_driver.js behavior casey's own
// call sites (hooks/handler.js, hooks/reply-judge.js) actually exercise --
// no approval gating, no compaction, no per-tool budgets, no classifier, no
// crash-resume step journaling. Every casey call site passes toolCtx with no
// approvalMode, so that whole subsystem is dead weight for this consumer.
import { getEnabledToolSchemas, dispatchTool } from './tool-registry.js'

const DEFAULT_MAX_ITERATIONS = 90
const DEFAULT_TIMEOUT_MS = 30000

/**
 * runTurn({prompt, messages, sessionKey, callLLM, tool_choice, enabledToolsets,
 *          disabledToolsets, toolCtx, timeoutMs, maxIterations})
 * -> {result, error, messages, iterations}
 *
 * Loop: call callLLM({messages, tools, tool_choice}) -> if tool_calls present,
 * dispatch each via dispatchTool(name, args, toolCtx), append
 * {role:'assistant', tool_calls} then one {role:'tool', tool_call_id, content}
 * per call, loop back to the LLM -> stop on no tool_calls, iteration budget,
 * or wall-clock timeout. tool_choice applies on iteration 0 only, exactly
 * matching freddie's documented behavior (a fixed forced tool_choice on every
 * iteration makes the "stop on no tool_calls" transition unreachable).
 */
export async function runTurn({
  prompt,
  messages = [],
  callLLM,
  tool_choice,
  enabledToolsets = [],
  disabledToolsets = [],
  toolCtx = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxIterations = DEFAULT_MAX_ITERATIONS,
} = {}) {
  if (typeof callLLM !== 'function') throw new Error('runTurn: callLLM function required')

  const deadline = Date.now() + timeoutMs
  let transcript = [...messages, { role: 'user', content: prompt }]
  let iterations = 0
  let result = null
  let error = null

  const schemas = getEnabledToolSchemas({ enabledToolsets, disabledToolsets })

  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      error = 'timeout'
      transcript = pairDanglingToolCalls(transcript, 'timeout: tool_call not dispatched')
      break
    }
    if (iterations >= maxIterations) {
      error = 'iteration budget exhausted'
      transcript = pairDanglingToolCalls(transcript, 'iteration budget exhausted: tool_call not dispatched')
      break
    }

    const tc = iterations === 0 ? tool_choice : undefined
    let out
    try {
      out = await withTimeout(
        callLLM({ messages: transcript, tools: schemas, tool_choice: tc }),
        remaining,
      )
    } catch (e) {
      error = String(e?.message || e)
      break
    }

    const toolCalls = Array.isArray(out?.tool_calls) ? out.tool_calls : []
    if (toolCalls.length === 0) {
      result = out?.content || ''
      transcript = [...transcript, { role: 'assistant', content: out?.content || '' }]
      break
    }

    transcript = [...transcript, { role: 'assistant', content: out?.content || '', tool_calls: toolCalls }]

    for (const call of toolCalls) {
      const tname = call.name || call.function?.name
      const targs = call.arguments || call.function?.arguments || {}
      const tcid = call.id || call.tool_call_id
      const raw = await dispatchTool(tname, targs, toolCtx || {})
      // A tool handler's return value is JSON-stringified here (the handler
      // itself never stringifies its own return) -- matches freddie's
      // documented contract and casey's own hooks/handler.js, which parses
      // every tool-role message's content back out with JSON.parse.
      const content = typeof raw === 'string' ? raw : JSON.stringify(raw)
      transcript.push({ role: 'tool', tool_call_id: tcid, content })
    }

    iterations += 1
  }

  return { result, error, messages: transcript, iterations }
}

async function withTimeout(promise, ms) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('llm call timeout')), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// A turn that ends (timeout/budget) with a dangling assistant tool_calls
// message and no paired tool-role result leaves a transcript a later LLM
// replay would reject. Pair every undispatched call with a synthetic error
// result, matching freddie's own pairDanglingToolCalls behavior.
function pairDanglingToolCalls(transcript, reason) {
  const last = transcript[transcript.length - 1]
  if (!last || last.role !== 'assistant' || !Array.isArray(last.tool_calls) || !last.tool_calls.length) return transcript
  const dispatched = new Set()
  for (const m of transcript) {
    if (m.role === 'tool' && m.tool_call_id) dispatched.add(m.tool_call_id)
  }
  const extra = []
  for (const call of last.tool_calls) {
    const tcid = call.id || call.tool_call_id
    if (tcid && !dispatched.has(tcid)) {
      extra.push({ role: 'tool', tool_call_id: tcid, content: JSON.stringify({ error: reason }) })
    }
  }
  return extra.length ? [...transcript, ...extra] : transcript
}
