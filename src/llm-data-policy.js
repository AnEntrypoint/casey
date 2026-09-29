// llm-data-policy.js -- what may casey send to which outside processor, and the
// paper trail that says what was decided.
//
// CASEY_LLM_DATA_POLICY (default 'zdr'):
//   deny  OpenRouter requests carry provider.data_collection = 'deny': only
//         endpoints that do not store or train on prompts are eligible.
//   zdr   deny, plus provider.zdr = true: only Zero-Data-Retention endpoints.
//   allow the policy is off (the pre-policy behaviour). Recorded loudly.
// Any other value is treated as 'zdr' (fail closed).
//
// WHAT IS ENFORCED WHERE (measured against OpenRouter 2026-09-29, see
// docs/data-processors.md in the deployment):
//   - /chat/completions honours provider.data_collection and provider.zdr. A
//     free (:free) endpoint answers 404 "No endpoints found matching your data
//     policy", so such a link can never serve a turn and is dropped up front.
//   - /audio/transcriptions IGNORES the provider object (a nonexistent
//     provider.only still answered 200), so no policy can be enforced there;
//     hooks/media.js therefore transcribes through chat completions instead.
//   - A direct vendor API (anthropic/, openai/) takes no such field. Those are
//     admitted on the vendor's published API terms and labelled 'vendor-terms'.
//   - Everything else (free ACP wrappers, kilo/opencode, groq, nvidia, deepseek
//     direct, ...) has no no-training guarantee casey can check: dropped.
import fs from 'node:fs'
import path from 'node:path'

export const POLICY_MODES = ['deny', 'zdr', 'allow']

let warnedInvalid = false
export function dataPolicyMode(env = process.env) {
  const raw = String(env.CASEY_LLM_DATA_POLICY == null ? 'zdr' : env.CASEY_LLM_DATA_POLICY).trim().toLowerCase()
  if (raw === '') return 'zdr'
  if (POLICY_MODES.includes(raw)) return raw
  if (!warnedInvalid) { warnedInvalid = true; console.warn(`[casey] CASEY_LLM_DATA_POLICY="${raw}" is not one of ${POLICY_MODES.join('/')}; using 'deny'`) }
  return 'deny'
}

// The provider object OpenRouter takes, or null when the policy is off.
// Which host serves the model is OpenRouter's choice; sorting by latency picks the
// fastest of the hosts that already satisfy the data policy (same model, same
// weights), which measured 0.5-0.7s a call against 0.6-2.5s unsorted.
// CASEY_LLM_PROVIDER_SORT=none|latency|throughput|price (default latency).
function providerSort(env = process.env) {
  const v = String(env.CASEY_LLM_PROVIDER_SORT == null ? 'latency' : env.CASEY_LLM_PROVIDER_SORT).trim().toLowerCase()
  return ['latency', 'throughput', 'price'].includes(v) ? v : null
}

export function openrouterProviderField(mode = dataPolicyMode()) {
  const sort = providerSort()
  const withSort = (o) => (sort ? { ...o, sort } : o)
  if (mode === 'deny') return withSort({ data_collection: 'deny' })
  if (mode === 'zdr') return withSort({ data_collection: 'deny', zdr: true })
  return sort ? { sort } : null
}

// DeepSeek Flash is a thinking model. With thinking on, on average ~220 tokens of every
// answer go to hidden reasoning, and on 5-6 of 24 short calls the answer budget was
// consumed by the thinking and the reply came back EMPTY, which our chain then retried
// (measured 2026-09-29: empty 5-6/24 and 2.2-2.4s with thinking on; 0/24 and 1.2-1.4s off,
// same host, same policy). Casey's turn is tool-orchestration and short replies, so thinking is
// off by default. CASEY_LLM_REASONING=on to leave it to the model, or low|medium|high.
export function reasoningField(env = process.env) {
  const v = String(env.CASEY_LLM_REASONING == null ? 'off' : env.CASEY_LLM_REASONING).trim().toLowerCase()
  if (v === 'on' || v === 'default') return null
  if (['low', 'medium', 'high'].includes(v)) return { reasoning: { effort: v } }
  return { reasoning: { enabled: false } }
}

const FREE_ID = /(?::free\b|\/free\b|-free\b)/i
// Direct vendor APIs admitted on their published API terms (no training on API
// traffic by default). Not enforceable per request; recorded as such.
const VENDOR_TERMS = { anthropic: 'Anthropic API', openai: 'OpenAI API', bedrock: 'AWS Bedrock' }

// { model, processor, enforcement: 'request'|'vendor-terms'|'refused', reason }
export function classifyLink(model) {
  const id = String(model || '')
  const m = /^([a-z0-9-]+)\/(.+)$/.exec(id)
  const prefix = m ? m[1] : ''
  if (prefix === 'openrouter') {
    if (FREE_ID.test(id)) return { model: id, processor: 'OpenRouter (free tier)', enforcement: 'refused', reason: 'free-tier endpoint: OpenRouter answers 404 under data_collection=deny (free endpoints may log and train)' }
    return { model: id, processor: 'OpenRouter', enforcement: 'request', reason: '' }
  }
  if (VENDOR_TERMS[prefix]) {
    if (FREE_ID.test(id)) return { model: id, processor: VENDOR_TERMS[prefix], enforcement: 'refused', reason: 'free-tier model id' }
    return { model: id, processor: VENDOR_TERMS[prefix], enforcement: 'vendor-terms', reason: '' }
  }
  if (prefix === 'claude' || !prefix) return { model: id, processor: 'local ACP wrapper', enforcement: 'refused', reason: `"${id}" resolves to an ACP wrapper (localhost daemon), not a named processor with a checkable no-training policy; use openrouter/anthropic/<model> or anthropic/<model>` }
  return { model: id, processor: prefix, enforcement: 'refused', reason: `"${prefix}" has no no-training guarantee casey can enforce or verify` }
}

export function auditFile(env = process.env) {
  const v = env.CASEY_LLM_AUDIT_FILE
  if (v === '0' || v === 'off') return null
  return v ? path.resolve(v) : path.resolve(process.cwd(), 'data', 'llm-audit', 'llm-data-policy.jsonl')
}

const MAX_SEGMENT_BYTES = 2 * 1024 * 1024
const MAX_ARCHIVES = 5
// One JSON object per line; NEVER a prompt, reply, contact id or phone number.
// Rotation is by rename (atomic), oldest archive past MAX_ARCHIVES unlinked.
export function auditWrite(event, env = process.env) {
  const file = auditFile(env)
  if (!file) return false
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      if (fs.statSync(file).size >= MAX_SEGMENT_BYTES) {
        for (let i = MAX_ARCHIVES; i >= 1; i--) {
          const from = i === 1 ? file : `${file}.${i - 1}`
          if (!fs.existsSync(from)) continue
          if (i === MAX_ARCHIVES) { try { fs.unlinkSync(`${file}.${i}`) } catch { /* absent */ } }
          fs.renameSync(from, `${file}.${i}`)
        }
      }
    } catch { /* no file yet */ }
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n')
    return true
  } catch { return false }   // an audit failure never blocks a reply
}

const seenChains = new Set()

// links: array of model strings or {model,...}. Returns { links, dropped, mode }.
// mode 'allow' returns the input untouched. Throws when nothing survives, so a
// misconfigured chain fails loudly instead of quietly sending data somewhere
// the policy forbids.
export function applyDataPolicy(links, { env = process.env, requested = '' } = {}) {
  const mode = dataPolicyMode(env)
  const list = (Array.isArray(links) ? links : [links]).map(l => (typeof l === 'string' ? l : l?.model)).filter(Boolean)
  if (mode === 'allow') {
    const key = `allow|${list.join(',')}`
    if (!seenChains.has(key)) { seenChains.add(key); auditWrite({ event: 'chain_resolved', policy: 'allow', requested: requested || list.join(','), kept: list.map(m => ({ model: m, enforcement: 'none (policy off)' })), dropped: [] }, env) }
    return { links: links, dropped: [], mode }
  }
  const field = openrouterProviderField(mode)
  const kept = []
  const dropped = []
  const keptInfo = []
  for (const model of list) {
    const c = classifyLink(model)
    if (c.enforcement === 'refused') { dropped.push({ model, reason: c.reason }); continue }
    keptInfo.push({ model, processor: c.processor, enforcement: c.enforcement })
    kept.push(c.enforcement === 'request' ? { model, provider: field, ...(reasoningField(env) || {}) } : { model })
  }
  const key = `${mode}|${list.join(',')}`
  if (!seenChains.has(key)) {
    seenChains.add(key)
    auditWrite({ event: 'chain_resolved', policy: mode, provider_field: field, requested: requested || list.join(','), kept: keptInfo, dropped }, env)
    for (const d of dropped) console.warn(`[casey] LLM data policy '${mode}': dropped ${d.model} -- ${d.reason}`)
  }
  if (!kept.length) {
    throw new Error(`CASEY_LLM_DATA_POLICY=${mode} leaves no permitted model in [${list.join(', ')}]: ${dropped.map(d => `${d.model} (${d.reason})`).join('; ')}`)
  }
  return { links: kept, dropped, mode }
}

// After a successful call: which chain link served it and what the request
// carried. acptoapi's translation drops OpenRouter's own `provider` (the
// upstream host), so the served link and the policy field sent are the
// auditable facts; the upstream host is not recorded. Metadata only.
export function auditServed(raw, requestedModel, env = process.env) {
  const attempted = Array.isArray(raw?.__chainAttempted) ? raw.__chainAttempted : []
  const ok = attempted.filter(a => a && a.ok).pop()
  const mode = dataPolicyMode(env)
  return auditWrite({
    event: 'served', policy: mode,
    provider_field: openrouterProviderField(mode),
    requested: requestedModel || null,
    served_link: ok?.model || null,
    links_tried: attempted.map(a => ({ model: a.model, ok: !!a.ok, reason: a.reason || null })),
  }, env)
}

// Processor register rows for `casey doctor` and docs. Reads the live env.
export function describeProcessors(env = process.env) {
  const mode = dataPolicyMode(env)
  const field = openrouterProviderField(mode)
  const rows = []
  const chain = String(env.CASEY_LLM_MODEL || '').split(',').map(s => s.trim()).filter(Boolean)
  const llmPolicy = mode === 'allow' ? 'NONE (CASEY_LLM_DATA_POLICY=allow)' : `${mode}${field ? ` (provider=${JSON.stringify(field)})` : ''}`
  if (!chain.length) {
    rows.push({ processor: 'chat LLM', data: 'conversation text, extracted report facts', policy: llmPolicy, state: 'no CASEY_LLM_MODEL set (casey default claude/sonnet is an ACP wrapper: refused under deny)' })
  }
  for (const model of chain) {
    const c = classifyLink(model)
    const skipped = mode !== 'allow' && c.enforcement === 'refused'
    rows.push({
      processor: `chat LLM ${model}`, data: 'conversation text, extracted report facts',
      policy: skipped ? 'REFUSED' : c.enforcement === 'request' ? llmPolicy : c.enforcement === 'vendor-terms' ? `vendor terms (${c.processor}); not enforceable per request` : llmPolicy,
      state: skipped ? `dropped: ${c.reason}` : 'routable',
    })
  }
  const stt = mode === 'allow' ? 'dedicated /audio/transcriptions models' : 'chat-completions audio models (policy enforced)'
  rows.push({ processor: 'voice transcription (OpenRouter)', data: 'voice-note audio', policy: mode === 'allow' ? 'NONE' : llmPolicy, state: stt })
  if (env.OPENAI_API_KEY) rows.push({ processor: 'voice transcription / photo / tts (OpenAI direct)', data: 'audio, photos, reply text', policy: 'vendor terms (OpenAI API); not enforceable per request', state: 'key present' })
  if (env.CASEY_VOICE_REPLIES === '1' && env.ELEVENLABS_API_KEY) rows.push({ processor: 'voice replies (ElevenLabs)', data: 'reply text', policy: mode === 'allow' ? 'NONE' : 'REFUSED', state: mode === 'allow' ? 'active' : 'blocked by data policy (no verifiable no-training guarantee)' })
  rows.push({ processor: 'WhatsApp Cloud API (Meta Graph)', data: 'every message to and from contacts (the channel itself)', policy: 'Meta terms; not an LLM processor', state: env.WHATSAPP_API_TOKEN ? 'configured' : 'not configured' })
  return { mode, rows }
}
