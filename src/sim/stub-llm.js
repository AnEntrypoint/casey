// stub-llm.js  --  a deterministic fake model for offline simulation and tests.
// NOT for production: `casey up` runs the real model via freddie's resolver
// (callLLM=null). This lets `casey sim` and the test suite exercise the full
// agent loop with no provider keys.
//
// Shape matches freddie's callLLM contract: ({messages,tools}) => {content, tool_calls}.
//
// The reply is deterministic but context-aware so the low-literacy scenario
// harness (src/sim/scenarios.js) can assert real behaviours: the reply is never
// blank, stays short and plain, always quotes the reference, and offers a real
// person whenever the contact asks for one or writes in another language.
export function stubLLM() {
  return async ({ messages }) => {
    const sys = messages.find(m => m.role === 'system')?.content || ''
    const caseId = (sys.match(/id=(\S+?)\)/) || [])[1]
    // The system prompt carries "CURRENT CASE <ref> (id=...)" -- quote the ref
    // back so a confused contact always has a handle on their request.
    const ref = (sys.match(/CURRENT CASE (\S+)/) || [])[1] || caseId || ''
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || ''
    const toolResults = messages.filter(m => m.role === 'tool').length

    // First turn: triage via tools (update + transition). Later turns: reply.
    if (caseId && toolResults === 0) {
      return {
        content: '',
        tool_calls: [
          { id: 't1', name: 'case_update', arguments: { id: caseId, summary: `Contact says: ${lastUser.slice(0, 80)}`, priority: 'high', tags: 'sim' } },
          { id: 't2', name: 'case_transition', arguments: { id: caseId, to: 'triaging', reason: 'auto-triage (stub)' } },
        ],
      }
    }
    return { content: composeReply(lastUser, ref), tool_calls: [] }
  }
}

// Deterministic, plain-language reply. Short sentences, no jargon. Always names
// the reference so the contact can quote it later; switches to a human-handoff
// message when the contact asks for a person, and to Spanish when the message
// looks Spanish (the simplest stand-in for "mirror the contact's language").
function composeReply(text, ref) {
  const t = (text || '').toLowerCase()
  const es = looksSpanish(t)
  const tag = ref ? (es ? ` Su referencia es ${ref}.` : ` Your reference is ${ref}.`) : ''
  if (wantsHuman(t)) {
    return es
      ? `Claro. Una persona de nuestro equipo le va a ayudar ahora. Le responde aqui.${tag}`
      : `Of course. I am asking a real person from our team to help you now. They will reply here.${tag}`
  }
  return es
    ? `Gracias. Guarde su mensaje y una persona le va a ayudar pronto.${tag}`
    : `Thank you. I have your message and a real person will help you soon.${tag}`
}

// Detect a request for a human across the plain phrasings a low-literacy or
// non-native contact is likely to use (English + Spanish cues).
function wantsHuman(t) {
  return /\b(human|person|someone|somebody|real|agent|operator|staff|manager|talk to|speak to|call me)\b/.test(t)
    || /\b(persona|alguien|hablar con|operador|humano)\b/.test(t)
}

// Cheap, deterministic Spanish detector: a handful of common words/letters.
// Good enough to make sim/test scenarios meaningful without a language model.
function looksSpanish(t) {
  if (/[ñ¿¡áéíóú]/.test(t)) return true
  return /\b(hola|gracias|por favor|ayuda|necesito|persona|quiero|hablar|donde|cuando|pedido|problema|cuenta|dinero|pago)\b/.test(t)
}
