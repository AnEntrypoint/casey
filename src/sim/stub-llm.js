// stub-llm.js  --  a deterministic fake model for offline simulation and tests.
// NOT for production: `casey up` runs the real model via freddie's resolver
// (callLLM=null, resolved to acptoapi). This lets `casey sim` and the test suite
// exercise the full agent loop with no provider keys.
//
// Shape matches freddie's callLLM contract: ({messages,tools}) => {content, tool_calls}.
import { extractFields } from '../extract.js'
//
// The reply is deterministic but context-aware so the disease-report scenario
// harness (src/sim/scenarios.js) can assert real behaviours: the reply is never
// blank, stays short, plain and calm, never diagnoses or alarms, always quotes
// the reference, offers a real person when asked, and -- on the first turn --
// records whatever report fields the message plainly contains, so the offline
// path also exercises case_report.
export function stubLLM() {
  return async ({ messages }) => {
    const sys = messages.find(m => m.role === 'system')?.content || ''
    const caseId = (sys.match(/id=(\S+?)\)/) || [])[1]
    const ref = (sys.match(/CURRENT CASE (\S+)/) || [])[1] || caseId || ''
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || ''
    const toolResults = messages.filter(m => m.role === 'tool').length

    // First turn: record what the message plainly says (a stand-in for the real
    // model's extraction) and gently move the case along. Later turns: just reply.
    if (caseId && toolResults === 0) {
      const fields = extractFields(lastUser)
      const calls = [
        { id: 't1', name: 'case_update', arguments: { id: caseId, summary: `Report: ${lastUser.slice(0, 80)}`, priority: 'high', tags: 'sim' } },
        { id: 't2', name: 'case_transition', arguments: { id: caseId, to: 'triaging', reason: 'logged for the team (stub)' } },
      ]
      if (Object.keys(fields).length) calls.push({ id: 't3', name: 'case_report', arguments: { id: caseId, ...fields } })
      return { content: '', tool_calls: calls }
    }
    return { content: composeReply(lastUser, ref), tool_calls: [] }
  }
}

// Deterministic, plain, calm reply. Always names the reference; switches to a
// human-handoff message when asked for a person; mirrors Afrikaans (the SA
// stand-in for "reply in the contact's language") when the message looks
// Afrikaans. Never diagnoses or promises -- "the team will look into it".
function composeReply(text, ref) {
  const t = (text || '').toLowerCase()
  const af = looksAfrikaans(t)
  const tag = ref ? (af ? ` U verwysing is ${ref}.` : ` Your reference is ${ref}.`) : ''
  if (wantsHuman(t)) {
    return af
      ? `Natuurlik. Iemand van die span sal u nou help. Hulle antwoord hier.${tag}`
      : `Of course. I am asking a person from the team to help you now. They will reply here.${tag}`
  }
  return af
    ? `Dankie dat u laat weet het. Ons het u boodskap en die span sal hierna kyk.${tag}`
    : `Thank you for letting us know. We have your message and the team will look into it.${tag}`
}

function wantsHuman(t) {
  return /\b(human|person|someone|somebody|real|agent|operator|staff|talk to|speak to|call me)\b/.test(t)
    || /\b(mens|persoon|iemand|umuntu|praat)\b/.test(t)
}

// Cheap, deterministic Afrikaans detector for the sim (the SA stand-in language).
function looksAfrikaans(t) {
  return /\b(dankie|asseblief|hallo|goeie|siek|beeste|diere|vrek|gevrek|my beeste|het nie)\b/.test(t)
}
