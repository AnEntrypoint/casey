import { dataPolicyMode, applyDataPolicy, auditServed } from '../llm-data-policy.js'

const ACPTOAPI_TIMEOUT_MS = Number(process.env.ACPTOAPI_TIMEOUT_MS) || 240000
export const REACHABILITY_PROBE_TIMEOUT_MS = Number(process.env.ACPTOAPI_REACHABILITY_PROBE_TIMEOUT_MS) || 45000
const REACHABILITY_PROBE_CHAIN_LINK_CAP = 3

const LLM_CONCURRENCY = process.env.CASEY_LLM_CONCURRENCY != null ? Math.max(0, Number(process.env.CASEY_LLM_CONCURRENCY) || 0) : 4
const bareModel = (m) => String(m || '').replace(/^synthetic\//, '').trim().toLowerCase()
export const requiredModel = () => bareModel(process.env.CASEY_LLM_REQUIRE_MODEL)
function assertServedBy(r) {
  const want = requiredModel()
  if (!want || !r || typeof r !== 'object') return r
  const served = (Array.isArray(r.__chainAttempted) ? r.__chainAttempted.filter(a => a?.ok) : []).map(a => bareModel(a.model))
  if (served.length && served.every(m => m === want)) return r
  if (!served.length && !Array.isArray(r.__chainAttempted)) return r
  throw new Error(`model guard: CASEY_LLM_REQUIRE_MODEL=${want} but the reply was served by ${served.join(', ') || 'no successful link'}; refused`)
}
let _inFlight = 0
const _waiting = []
async function withSlot(fn) {
  if (_inFlight >= LLM_CONCURRENCY) await new Promise(resolve => _waiting.push(resolve))
  _inFlight++
  try { return await fn() } finally { _inFlight--; _waiting.shift()?.() }
}
function limitConcurrency(acptoapi) {
  if (!LLM_CONCURRENCY || acptoapi.__casey_limited) return
  for (const name of ['chat', 'chatChain']) {
    const orig = acptoapi[name]
    if (typeof orig !== 'function') continue
    try { acptoapi[name] = (...args) => withSlot(async () => assertServedBy(await orig.apply(acptoapi, args))) } catch {}
  }
  try { acptoapi.__casey_limited = true } catch {}
}
export const llmQueueStats = () => ({ inFlight: _inFlight, waiting: _waiting.length, ceiling: LLM_CONCURRENCY })

let _acptoapi = null
async function getAcptoapi() {
  if (!_acptoapi) {
    const mod = await import('acptoapi')
    _acptoapi = mod.default && typeof mod.default === 'object' ? mod.default : mod
    const brandsMod = await import('acptoapi/lib/openai-brands')
    const brands = brandsMod.default || brandsMod
    if (!brands.isBrand('synthetic')) brands.registerBrand('synthetic', { url: 'https://api.synthetic.new/openai/v1/chat/completions', envKey: 'SYNTHETIC_API_KEY' })
    limitConcurrency(_acptoapi)
  }
  return _acptoapi
}

export function getAcptoapiUrl() {
  return process.env.FREDDIE_LLM_URL || process.env.CASEY_LLM_URL || null
}

export function getAcptoapiModel(defaultModel = null) {
  return process.env.CASEY_LLM_MODEL || process.env.FREDDIE_LLM_MODEL || defaultModel || null
}

export function isConfiguredChainSyntax(model) {
  return typeof model === 'string' && (model.includes(',') || model.startsWith('queue/') || model.startsWith('chain/'))
}

export async function resolveChainLinks(acptoapi, useModel) {
  const want = requiredModel()
  if (want) {
    const only = bareModel(useModel)
    if (only !== want || String(useModel).includes(',')) throw new Error(`model guard: CASEY_LLM_REQUIRE_MODEL=${want} but CASEY_LLM_MODEL resolves to "${useModel}"; refusing to run on anything else`)
  }
  const mode = dataPolicyMode()
  if (mode !== 'allow' && typeof useModel === 'string' && (useModel.startsWith('queue/') || useModel.startsWith('chain/'))) {
    throw new Error(`CASEY_LLM_DATA_POLICY=${mode} cannot check the members of "${useModel}"; list the models explicitly in CASEY_LLM_MODEL`)
  }
  let base
  if (isConfiguredChainSyntax(useModel)) base = useModel
  else {
    const links = acptoapi.buildAutoChain(useModel)
    base = (Array.isArray(links) && links.length) ? links.map(l => l.model || l) : useModel
  }
  if (mode === 'allow') { applyDataPolicy(typeof base === 'string' ? base.split(',').map(s => s.trim()).filter(Boolean) : base, { requested: String(useModel) }); return base }
  const list = typeof base === 'string' ? base.split(',').map(s => s.trim()).filter(Boolean) : base
  return applyDataPolicy(list, { requested: String(useModel) }).links
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
  auditServed(json, Array.isArray(chainModel) ? chainModel.map(l => l.model || l).join(',') : chainModel)
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
