

import fs from 'node:fs'
import path from 'node:path'
import { caseyText } from './deployment-text.js';

export const POLICY_MODES = ['deny', 'zdr', 'allow']

let warnedInvalid = false
export function dataPolicyMode(env = process.env) {
  const raw = String(env.CASEY_LLM_DATA_POLICY == null ? 'zdr' : env.CASEY_LLM_DATA_POLICY).trim().toLowerCase()
  if (raw === '') return 'zdr'
  if (POLICY_MODES.includes(raw)) return raw
  if (!warnedInvalid) { warnedInvalid = true; console.warn(caseyText("src/llm-data-policy.js#w0", [raw, POLICY_MODES.join('/')])) }
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

const VENDOR_TERMS = { anthropic: caseyText("src/llm-data-policy.js#w1"), openai: caseyText("src/llm-data-policy.js#w2"), bedrock: caseyText("src/llm-data-policy.js#w3"), synthetic: 'Synthetic (synthetic.new) API' }

export function classifyLink(model) {
  const id = String(model || '')
  const m = /^([a-z0-9-]+)\/(.+)$/.exec(id)
  const prefix = m ? m[1] : ''
  if (prefix === 'openrouter') {
    if (FREE_ID.test(id)) return { model: id, processor: caseyText("src/llm-data-policy.js#w4"), enforcement: 'refused', reason: caseyText("src/llm-data-policy.js#w5") }
    return { model: id, processor: 'OpenRouter', enforcement: 'request', reason: '' }
  }
  if (VENDOR_TERMS[prefix]) {
    if (FREE_ID.test(id)) return { model: id, processor: VENDOR_TERMS[prefix], enforcement: 'refused', reason: caseyText("src/llm-data-policy.js#w6") }
    return { model: id, processor: VENDOR_TERMS[prefix], enforcement: 'vendor-terms', reason: '' }
  }
  if (prefix === 'claude' || !prefix) return { model: id, processor: caseyText("src/llm-data-policy.js#w7"), enforcement: 'refused', reason: `"${id}" resolves to an ACP wrapper (localhost daemon), not a named processor with a checkable no-training policy; use openrouter/anthropic/<model> or anthropic/<model>` }
  return { model: id, processor: prefix, enforcement: 'refused', reason: caseyText("src/llm-data-policy.js#w9", [prefix]) }
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
    if (!seenChains.has(key)) { seenChains.add(key); auditWrite({ event: 'chain_resolved', policy: 'allow', requested: requested || list.join(','), kept: list.map(m => ({ model: m, enforcement: caseyText("src/llm-data-policy.js#w10") })), dropped: [] }, env) }
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
    for (const d of dropped) console.warn(caseyText("src/llm-data-policy.js#w11", [mode, d.model, d.reason]))
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
    rows.push({ processor: caseyText("src/llm-data-policy.js#w12"), data: caseyText("src/llm-data-policy.js#w13"), policy: llmPolicy, state: caseyText("src/llm-data-policy.js#w14") })
  }
  for (const model of chain) {
    const c = classifyLink(model)
    const skipped = mode !== 'allow' && c.enforcement === 'refused'
    rows.push({
      processor: caseyText("src/llm-data-policy.js#w15", [model]), data: caseyText("src/llm-data-policy.js#w16"),
      policy: skipped ? 'REFUSED' : c.enforcement === 'request' ? llmPolicy : c.enforcement === 'vendor-terms' ? caseyText("src/llm-data-policy.js#w17", [c.processor]) : llmPolicy,
      state: skipped ? `dropped: ${c.reason}` : 'routable',
    })
  }
  const stt = mode === 'allow' ? caseyText("src/llm-data-policy.js#w18") : caseyText("src/llm-data-policy.js#w19")
  rows.push({ processor: caseyText("src/llm-data-policy.js#w20"), data: caseyText("src/llm-data-policy.js#w21"), policy: mode === 'allow' ? 'NONE' : llmPolicy, state: stt })
  if (env.CASEY_LOCAL_STT !== '0') rows.push({ processor: caseyText("src/llm-data-policy.js#w22"), data: caseyText("src/llm-data-policy.js#w23"), policy: caseyText("src/llm-data-policy.js#w24"), state: caseyText("src/llm-data-policy.js#w25") })
  if (env.CASEY_VOICE_REPLIES === 'google') rows.push({ processor: caseyText("src/llm-data-policy.js#w30"), data: caseyText("src/llm-data-policy.js#w31"), policy: caseyText("src/llm-data-policy.js#w32"), state: caseyText("src/llm-data-policy.js#w33") })
  if (env.OPENAI_API_KEY) rows.push({ processor: caseyText("src/llm-data-policy.js#w34"), data: caseyText("src/llm-data-policy.js#w35"), policy: caseyText("src/llm-data-policy.js#w36"), state: caseyText("src/llm-data-policy.js#w37") })
  if (env.CASEY_VOICE_REPLIES === '1' && env.ELEVENLABS_API_KEY) rows.push({ processor: caseyText("src/llm-data-policy.js#w38"), data: caseyText("src/llm-data-policy.js#w39"), policy: mode === 'allow' ? 'NONE' : 'REFUSED', state: mode === 'allow' ? 'active' : caseyText("src/llm-data-policy.js#w40") })
  rows.push({ processor: caseyText("src/llm-data-policy.js#w41"), data: caseyText("src/llm-data-policy.js#w42"), policy: caseyText("src/llm-data-policy.js#w43"), state: env.WHATSAPP_API_TOKEN ? 'configured' : caseyText("src/llm-data-policy.js#w44") })
  return { mode, rows }
}
