// Cordis LlmAdapter subclass wrapping acptoapi directly (in-process, no HTTP
// hop) -- casey's own Service Provider for freddie's LLM seam (Service
// Definition: deps/freddie's packages/llm/llm's LlmRuntime/LlmAdapter; real
// reference Provider: packages/llm/llm-deepseek's DeepSeekAdapter, whose
// shape this mirrors). stream() is the only required method: acptoapi's
// chat()/chatChain() is non-streaming, so a complete response is synthesized
// into freddie's chunk protocol (block-start/text-delta/tool-call-delta/
// block-end/usage/finish) in one shot.
import { LlmAdapter } from '@freddie/freddie-llm'
import { resolveChainLinks } from '../../../src/agent/acptoapi-bridge.js'

let _acptoapi = null
async function getAcptoapi() {
  if (!_acptoapi) {
    const mod = await import('acptoapi')
    // acptoapi is a CJS package; Node's CJS-to-ESM interop only statically
    // detects a SUBSET of module.exports keys as named exports -- read
    // through `.default` (the full CJS exports object) so every export is
    // reachable regardless of which subset the interop happened to pick up.
    _acptoapi = mod.default && typeof mod.default === 'object' ? mod.default : mod
  }
  return _acptoapi
}

// resolveChainLinks and isConfiguredChainSyntax live in casey's own agent
// bridge and are imported, not copied. They were copied, and the copies
// drifted: this one was fixed to stop swallowing a buildAutoChain throw and
// the other was not, so one process held two different failure behaviours for
// the same call. Same import direction as this bundle's platform plugin,
// which already reaches into src/adapters for the webhook verifier.
// freddie's message content is an array of typed ContentBlocks
// ({type:'text'|'tool-call'|'tool-result'|'reasoning'}), not a flat string --
// flatten to OpenAI-compatible {role, content, tool_calls}/{role, tool_call_id,
// content} for acptoapi's chat-completions call shape.
function toOpenAiMessages(messages) {
  const out = []
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }]
    const toolResults = blocks.filter(b => b.type === 'tool-result')
    if (toolResults.length) {
      for (const tr of toolResults) {
        out.push({ role: 'tool', tool_call_id: tr.toolCallId, content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content) })
      }
      continue
    }
    const toolCalls = blocks.filter(b => b.type === 'tool-call')
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
    if (toolCalls.length) {
      out.push({
        role: m.role,
        content: text,
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}) },
        })),
      })
      continue
    }
    out.push({ role: m.role, content: text })
  }
  return out
}

function toOpenAiTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return []
  return tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } } }))
}

export class AcptoapiAdapter extends LlmAdapter {
  constructor({ getModel } = {}) {
    super()
    this.getModel = getModel || (() => process.env.CASEY_LLM_MODEL || process.env.FREDDIE_LLM_MODEL || null)
  }

  providerInfo(provider) {
    return { id: provider, name: 'acptoapi' }
  }

  async * stream(options) {
    const acptoapi = await getAcptoapi()
    const useModel = options.model || this.getModel()
    const chainModel = await resolveChainLinks(acptoapi, useModel)
    const tools = toOpenAiTools(options.tools)
    const hasTools = tools.length > 0
    const chatOpts = {
      messages: toOpenAiMessages(options.messages),
      ...(options.system ? { system: options.system } : {}),
      ...(hasTools ? { tools } : {}),
      ...(hasTools && options.toolChoice ? { tool_choice: options.toolChoice } : {}),
      max_tokens: 4096,
    }
    const json = await (Array.isArray(chainModel) ? acptoapi.chatChain(chainModel, chatOpts) : acptoapi.chat({ model: chainModel, ...chatOpts }))
    options.signal?.throwIfAborted?.()

    const choice = json?.choices?.[0]?.message || {}
    const content = typeof choice.content === 'string' ? choice.content : ''
    const toolCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : []

    let index = 0
    if (content) {
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text: content }
      yield { type: 'block-end', index, block: { type: 'text', text: content } }
      index++
    }
    for (const tc of toolCalls) {
      const args = tc.function?.arguments ?? ''
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id: tc.id, name: tc.function?.name, argumentsDelta: typeof args === 'string' ? args : JSON.stringify(args) }
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id: tc.id, name: tc.function?.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
      }
      index++
    }
    if (json?.usage) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: json.usage.prompt_tokens ?? 0,
          outputTokens: json.usage.completion_tokens ?? 0,
        },
      }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
