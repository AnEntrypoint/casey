

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

export function reasoningField(env = process.env) {
  const v = String(env.CASEY_LLM_REASONING == null ? 'off' : env.CASEY_LLM_REASONING).trim().toLowerCase()
  if (v === 'on' || v === 'default') return null
  if (['low', 'medium', 'high'].includes(v)) return { reasoning: { effort: v } }
  return { reasoning: { enabled: false } }
}

export function syntheticReasoningField(env = process.env) {
  const v = String(env.CASEY_LLM_REASONING == null ? 'off' : env.CASEY_LLM_REASONING).trim().toLowerCase()
  if (v === 'on' || v === 'default') return null
  if (['low', 'medium', 'high'].includes(v)) return { reasoning_effort: v }
  return { reasoning_effort: 'none' }
}

const FREE_ID = /(?::free\b|\/free\b|-free\b)/i

const VENDOR_TERMS = { anthropic: 'Anthropic API', openai: 'OpenAI API', bedrock: 'AWS Bedrock', synthetic: 'Synthetic (synthetic.new) API' }

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
          if (i === MAX_ARCHIVES) { try { fs.unlinkSync(`${file}.${i}`) } catch {  } }
          fs.renameSync(from, `${file}.${i}`)
        }
      }
    } catch {  }
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n')
    return true
  } catch { return false }
}

const seenChains = new Set()

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
    if (c.enforcement === 'request') kept.push({ model, provider: field, ...(reasoningField(env) || {}) })
    else if (model.startsWith('synthetic/')) kept.push({ model, ...(syntheticReasoningField(env) || {}) })
    else kept.push({ model })
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
  if (env.CASEY_LOCAL_STT !== '0') rows.push({ processor: 'voice transcription (local whisper)', data: 'voice-note audio stays on this machine', policy: 'not applicable: no third party', state: 'offline fallback when OpenRouter has no key or returns nothing; needs scripts/setup-local-stt.sh' })
  if (String(env.CASEY_STT_ENGINE || '').toLowerCase() === 'google') rows.push({ processor: 'voice transcription (Google Cloud Speech-to-Text)', data: 'voice-note audio', policy: 'Google Cloud terms under this project; no data-logging opt-in is used; not an OpenRouter route', state: `primary engine (${env.CASEY_STT_GOOGLE_MODEL || 'chirp_3'} in ${env.CASEY_STT_GOOGLE_LOCATION || 'us'})` })
  if (env.CASEY_VOICE_REPLIES === 'google') rows.push({ processor: 'voice replies (Google Cloud Text-to-Speech)', data: 'short non-sensitive reply text', policy: 'Google Cloud terms under this project', state: 'opt-in per case (tag voice-replies)' })
  if (env.OPENAI_API_KEY) rows.push({ processor: 'voice transcription / photo / tts (OpenAI direct)', data: 'audio, photos, reply text', policy: 'vendor terms (OpenAI API); not enforceable per request', state: 'key present' })
  if (env.CASEY_VOICE_REPLIES === '1' && env.ELEVENLABS_API_KEY) rows.push({ processor: 'voice replies (ElevenLabs)', data: 'reply text', policy: mode === 'allow' ? 'NONE' : 'REFUSED', state: mode === 'allow' ? 'active' : 'blocked by data policy (no verifiable no-training guarantee)' })
  rows.push({ processor: 'WhatsApp Cloud API (Meta Graph)', data: 'every message to and from contacts (the channel itself)', policy: 'Meta terms; not an LLM processor', state: env.WHATSAPP_API_TOKEN ? 'configured' : 'not configured' })
  return { mode, rows }
}
