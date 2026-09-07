// Casey's own in-process acptoapi bridge -- the same thin shim freddie used
// to provide (call acptoapi's real chat()/chatChain() in-process, no HTTP
// hop, no separate daemon), reimplemented directly since freddie's own
// bridge was removed in a later upstream rewrite. Deliberately minimal: just
// enough adapting to connect casey's {role, content, tool_calls} shape to
// acptoapi's OpenAI-compatible wire format -- chain resolution, provider
// selection, and reachability all delegate straight to acptoapi's own
// exports rather than reimplementing them.
const ACPTOAPI_TIMEOUT_MS = Number(process.env.ACPTOAPI_TIMEOUT_MS) || 240000
export const REACHABILITY_PROBE_TIMEOUT_MS = Number(process.env.ACPTOAPI_REACHABILITY_PROBE_TIMEOUT_MS) || 45000
const REACHABILITY_PROBE_CHAIN_LINK_CAP = 3

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

export function getAcptoapiUrl() {
  return process.env.FREDDIE_LLM_URL || process.env.CASEY_LLM_URL || null
}

export function getAcptoapiModel(defaultModel = null) {
  return process.env.CASEY_LLM_MODEL || process.env.FREDDIE_LLM_MODEL || defaultModel || null
}

// A bare 'provider/model' string resolves to exactly ONE provider with no
// fallback, unless it already uses acptoapi's own chain syntax (comma-list,
// queue/, chain/) or is the 'auto' sentinel -- those go straight to
// chat()/chatChain() unchanged. Only a genuinely bare single-model request
// gets wrapped in acptoapi's own buildAutoChain() for real fallback.
function isConfiguredChainSyntax(model) {
  return typeof model === 'string' && (model.includes(',') || model.startsWith('queue/') || model.startsWith('chain/'))
}

async function resolveChainLinks(acptoapi, useModel) {
  if (isConfiguredChainSyntax(useModel)) return useModel
  try {
    const links = acptoapi.buildAutoChain(useModel)
    return (Array.isArray(links) && links.length) ? links.map(l => l.model || l) : useModel
  } catch { return useModel }
}

function adaptMessage(m) {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }
  if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
    return {
      role: 'assistant',
      content: m.content || '',
      tool_calls: m.tool_calls.map(tc => ({
        id: tc.id || tc.tool_call_id,
        type: 'function',
        function: { name: tc.name || tc.function?.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || tc.function?.arguments || {}) },
      })),
    }
  }
  return { role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }
}

function adaptTool(t) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || t.input_schema || { type: 'object', properties: {} } } }
}

function adaptResponse(r) {
  const choice = r?.choices?.[0]?.message || {}
  const content = typeof choice.content === 'string' ? choice.content : ''
  const tool_calls = Array.isArray(choice.tool_calls)
    ? choice.tool_calls.map(tc => ({ id: tc.id, name: tc.function?.name, arguments: tryParseJson(tc.function?.arguments) }))
    : []
  return { content, tool_calls, raw: r }
}

function tryParseJson(s) { try { return typeof s === 'string' ? JSON.parse(s) : (s || {}) } catch { return {} } }

export async function callLLM({ messages, tools = [], model, tool_choice } = {}) {
  const acptoapi = await getAcptoapi()
  const useModel = model || getAcptoapiModel()
  const chainModel = await resolveChainLinks(acptoapi, useModel)
  const hasTools = Array.isArray(tools) && tools.length > 0
  const chatOpts = {
    messages: messages.map(adaptMessage),
    ...(hasTools ? { tools: tools.map(adaptTool) } : {}),
    ...(hasTools && tool_choice ? { tool_choice } : {}),
    max_tokens: 4096,
  }
  // acptoapi's chat() is a plain Promise with no AbortSignal support -- the
  // overall deadline here is enforced by racing a timeout.
  let _timeoutHandle
  const _timeout = new Promise((_, reject) => {
    _timeoutHandle = setTimeout(() => reject(new Error('acptoapi call timeout')), ACPTOAPI_TIMEOUT_MS)
  })
  let json
  try {
    json = await Promise.race([
      Array.isArray(chainModel) ? acptoapi.chatChain(chainModel, chatOpts) : acptoapi.chat({ model: chainModel, ...chatOpts }),
      _timeout,
    ])
  } finally { clearTimeout(_timeoutHandle) }
  return adaptResponse(json)
}

export async function isReachable(timeoutMs = REACHABILITY_PROBE_TIMEOUT_MS, model = null) {
  try {
    const acptoapi = await getAcptoapi()
    const useModel = model || getAcptoapiModel()
    if (!useModel) return false
    const chainModel = await resolveChainLinks(acptoapi, useModel)
    const probeChain = Array.isArray(chainModel) ? chainModel.slice(0, REACHABILITY_PROBE_CHAIN_LINK_CAP) : chainModel
    const probe = { messages: [{ role: 'user', content: 'ping' }], max_tokens: 32 }
    const result = await Promise.race([
      Array.isArray(probeChain) ? acptoapi.chatChain(probeChain, probe) : acptoapi.chat({ model: probeChain, ...probe }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('reachability probe timeout')), timeoutMs)),
    ])
    return !!(result && result.choices && result.choices.length)
  } catch { return false }
}
