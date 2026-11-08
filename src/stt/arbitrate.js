import { STT_FAILURE } from './errors.js'

const ARBITER_TIMEOUT_MS = Math.max(1000, Number(process.env.CASEY_STT_ARBITER_TIMEOUT_MS) || 30000)
const GOOGLE_ID = 'google'
const REASON_CHARS = 300

function withTimeout(promise, ms) {
  let handle
  const limit = new Promise((_, reject) => { handle = setTimeout(() => reject(new Error(`arbiter timed out after ${ms}ms`)), ms) })
  return Promise.race([promise, limit]).finally(() => clearTimeout(handle))
}

function arbiterPrompt(candidates, caseLanguage) {
  const lines = candidates.map(c => (c.text ? `[${c.id}] ${c.text}` : `[${c.id}] (no transcript: ${c.error || 'empty'})`))
  return [
    'Four automatic speech recognisers transcribed the same voice note from a farmer in South Africa who is reporting an animal-health problem. Each transcript is a machine guess and each can be wrong in different places.',
    caseLanguage ? `The language Google detected for this note is ${caseLanguage}.` : 'The language of this note is not known.',
    'Candidates (the id is in brackets):',
    ...lines,
    'Pick the candidate whose wording most likely captured what the sender intended. Choose ONLY one of the listed ids that has a transcript, or "none" if no candidate is trustworthy.',
    'Never write, repair or combine a transcript. Do not add any fact that no candidate states. If the candidates disagree about a number, a species, a place or a disease, say so in the reason.',
    'Respond with ONLY JSON: {"chosen": "<one id or none>", "confidence": <number from 0 to 1>, "reason": "<one short sentence>"}',
  ].join('\n')
}

export function parseArbiterReply(raw, validIds) {
  const m = /\{[\s\S]*\}/.exec(String(raw || ''))
  if (!m) return { ok: false, why: 'the reply held no JSON object' }
  let j
  try { j = JSON.parse(m[0]) } catch { return { ok: false, why: 'the reply JSON did not parse' } }
  const chosen = typeof j.chosen === 'string' ? j.chosen.trim() : ''
  if (chosen !== 'none' && !validIds.includes(chosen)) return { ok: false, why: `chosen "${chosen.slice(0, 40)}" is not a candidate with a transcript` }
  const confidence = typeof j.confidence === 'number' ? j.confidence : Number(j.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { ok: false, why: 'confidence is not a number from 0 to 1' }
  const reason = String(j.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, REASON_CHARS)
  if (!reason) return { ok: false, why: 'the reply gave no reason' }
  return { ok: true, chosen, confidence: Math.round(confidence * 100) / 100, reason }
}

export async function arbitrateCandidates({ candidates, caseLanguage = null, callLLM = null, note = null, now = () => new Date() }) {
  const decided_at = now().toISOString()
  const withText = candidates.filter(c => c.text)
  const fallbackTo = (why) => ({
    chosen: GOOGLE_ID, source: 'fallback', confidence: null, reason: null, llm_model: null, decided_at, fallback: why, note,
  })
  if (!withText.length) {
    return { chosen: 'none', source: 'no_text', confidence: null, reason: null, llm_model: null, decided_at, fallback: null, note }
  }
  if (candidates.length === 1) {
    return { chosen: candidates[0].id, source: 'single_candidate', confidence: null, reason: 'only one candidate was available', llm_model: null, decided_at, fallback: null, note }
  }
  if (typeof callLLM !== 'function') return fallbackTo('no LLM handle was passed to the speech intake')
  try {
    const reply = await withTimeout(callLLM({ messages: [{ role: 'user', content: arbiterPrompt(candidates, caseLanguage) }], tools: [] }), ARBITER_TIMEOUT_MS)
    const parsed = parseArbiterReply(reply?.content, withText.map(c => c.id))
    if (!parsed.ok) return fallbackTo(`unusable arbiter reply: ${parsed.why}`)
    return {
      chosen: parsed.chosen, source: 'llm', confidence: parsed.confidence, reason: parsed.reason,
      llm_model: reply?.raw?.model || process.env.CASEY_LLM_MODEL || null, decided_at, fallback: null, note,
    }
  } catch (e) {
    return fallbackTo(`arbiter call failed: ${String(e?.message || e).slice(0, 160)}`)
  }
}

export function applyChoice(tr, choice) {
  const out = { ...tr, stt_choice: choice }
  if (choice.source === 'no_text') return out
  if (choice.chosen === 'none') {
    return { ...out, text: '', error: 'no candidate judged trustworthy', failureKind: STT_FAILURE.LOW_CONFIDENCE }
  }
  if (choice.chosen === GOOGLE_ID) return out
  const cand = tr.candidates.find(c => c.id === choice.chosen)
  if (!cand?.text) return out
  const chosenTr = {
    ...out, text: cand.text, engine: 'specialist', provider: cand.provider, model: null, specialist_language: cand.id,
    error: '', failureKind: '',
  }
  delete chosenTr.confidence
  return chosenTr
}

export async function arbitrateVoiceNote(tr, { callLLM = null, caseLanguage = null } = {}) {
  if (!Array.isArray(tr?.candidates)) return tr
  const choice = await arbitrateCandidates({
    candidates: tr.candidates, caseLanguage, callLLM, note: tr.specialists_skipped || null,
  })
  return applyChoice(tr, choice)
}
