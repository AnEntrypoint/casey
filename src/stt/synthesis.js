import { caseyText } from '../deployment-text.js';

const REASON_CHARS = 300
const VERDICT_HEARD = 'heard'
const VERDICT_UNHEARD = 'unheard'

function engineLine(e) {
  return e.text ? `[${e.id}] ${e.text}` : caseyText("src/stt/synthesis.js#s0", [e.id, e.error || 'empty'])
}

function synthesisPrompt(engines, caseLanguage) {
  return [
    caseyText("src/stt/synthesis.js#0"),
    caseLanguage ? caseyText("src/stt/synthesis.js#1", [caseLanguage]) : caseyText("src/stt/synthesis.js#s1"),
    caseyText("src/stt/synthesis.js#s2"),
    ...engines.map(engineLine),
    caseyText("src/stt/synthesis.js#2"),
    caseyText("src/stt/synthesis.js#3"),
    caseyText("src/stt/synthesis.js#4"),
  ].join('\n')
}

export function parseSynthesisReply(raw, engineIds) {
  const m = /\{[\s\S]*\}/.exec(String(raw || ''))
  if (!m) return { ok: false, why: caseyText("src/stt/synthesis.js#s3") }
  let j
  try { j = JSON.parse(m[0]) } catch { return { ok: false, why: caseyText("src/stt/synthesis.js#s4") } }
  const verdict = j.verdict
  if (verdict !== VERDICT_HEARD && verdict !== VERDICT_UNHEARD) return { ok: false, why: caseyText("src/stt/synthesis.js#5") }
  const transcript = typeof j.transcript === 'string' ? j.transcript.replace(/\s+/g, ' ').trim() : ''
  if (verdict === VERDICT_HEARD && !transcript) return { ok: false, why: caseyText("src/stt/synthesis.js#s6") }
  const reason = String(j.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, REASON_CHARS)
  if (!reason) return { ok: false, why: caseyText("src/stt/synthesis.js#s7") }
  const named = Array.isArray(j.agreed) ? j.agreed.map((x) => String(x).trim()) : []
  const agreed = [...new Set(named.filter((id) => engineIds.includes(id)))]
  return { ok: true, verdict, transcript: verdict === VERDICT_HEARD ? transcript : '', agreed, reason }
}

export async function synthesizeVoiceNote(engines, { callLLM = null, caseLanguage = null, now = () => new Date() } = {}) {
  const decided_at = now().toISOString()
  const engineIds = engines.map((e) => e.id)
  const unheard = (error) => ({ verdict: VERDICT_UNHEARD, transcript: '', agreed: [], reason: null, llm_model: null, decided_at, error })
  if (typeof callLLM !== 'function') return unheard(caseyText("src/stt/synthesis.js#6"))
  try {
    const reply = await callLLM({ messages: [{ role: 'user', content: synthesisPrompt(engines, caseLanguage) }], tools: [] })
    const parsed = parseSynthesisReply(reply?.content, engineIds)
    if (!parsed.ok) return unheard(caseyText("src/stt/synthesis.js#s8", [parsed.why]))
    return {
      verdict: parsed.verdict, transcript: parsed.transcript, agreed: parsed.agreed, reason: parsed.reason,
      llm_model: reply?.raw?.model || process.env.CASEY_LLM_MODEL || null, decided_at, error: '',
    }
  } catch (e) {
    return unheard(caseyText("src/stt/synthesis.js#s9", [String(e?.message || e).slice(0, 160)]))
  }
}
