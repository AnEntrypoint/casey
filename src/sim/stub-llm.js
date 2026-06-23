// stub-llm.js  --  a deterministic fake model for offline simulation and tests.
// NOT for production: `casey up` runs the real model via freddie's resolver
// (callLLM=null, resolved to acptoapi). This lets `casey sim` and the test suite
// exercise the full agent loop with no provider keys.
//
// Shape matches freddie's callLLM contract: ({messages,tools}) => {content, tool_calls}.
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

// Pull the obvious report fields out of a plain message. Deterministic and
// shallow on purpose -- just enough that the offline path records SOMETHING and
// the case_report merge is exercised; the real model does the rich extraction.
function extractFields(text) {
  const t = (text || '').toLowerCase()
  const raw = text || ''
  const f = {}

  // Species -- English, Afrikaans (beeste=cattle, skape=sheep, varke=pigs),
  // isiZulu/isiXhosa (izinkomo/iinkomo=cattle, izimvu=sheep).
  const SPECIES = ['cattle', 'cow', 'cows', 'sheep', 'goat', 'goats', 'pig', 'pigs',
    'beeste', 'skape', 'varke', 'izinkomo', 'iinkomo', 'izimvu']
  const species = SPECIES.find(s => new RegExp(`\\b${s}\\b`).test(t))
  if (species) f.species = species

  // Symptoms -- include Afrikaans (kwyl=drool, kreupel=limp) and common phrases.
  const SYMPTOMS = ['drool', 'blister', 'limp', 'lame', 'died', 'dying', 'sick', 'siek',
    'gula', 'kwyl', 'kreupel', 'not eating', 'not eating', 'eet nie', 'amathe']
  const sym = SYMPTOMS.find(s => t.includes(s))
  if (sym) f.symptoms = sym

  // Counts -- numbers written as digits or common English words.
  const WORD_NUMS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
  let num = null
  const digitMatch = (t.match(/\b(\d+)\b/) || [])[1]
  if (digitMatch) {
    num = digitMatch
  } else {
    const wordMatch = Object.keys(WORD_NUMS).find(w => new RegExp(`\\b${w}\\b`).test(t))
    if (wordMatch) num = String(WORD_NUMS[wordMatch])
  }
  if (num && /\b(died|dead|dood|gevrek)\b/.test(t)) f.dead_count = num
  else if (num) f.affected_count = num
  if (/\b(died|dead|dood|gevrek)\b/.test(t)) f.dead_count = f.dead_count || 'some'

  // Location -- "near X", "farm X", "on the R\d+ road", "X area", "past X".
  const locPat = /\b(?:near|past|from|at|on the|in|by)\s+([A-Z][a-zA-Z\s\-]{2,30}?)(?:\s*,|\s*\.|$)/
  const locMatch = raw.match(locPat)
  if (locMatch) f.location = locMatch[1].trim()
  // Also capture "my farm near X" or "X farm"
  if (!f.location) {
    const farmMatch = raw.match(/\b([A-Z][a-zA-Z\s]{2,20})\s+(?:farm|area|dorp|plaas)\b/i)
    if (farmMatch) f.location = farmMatch[1].trim()
  }

  // Onset -- "started yesterday", "since Monday", "X days ago", "last week".
  const onsetPat = /\b(?:since|started|since last|from)\s+(yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|last\s+\w+|\d+\s+days?\s+ago)/i
  const onsetMatch = raw.match(onsetPat)
  if (onsetMatch) f.onset = onsetMatch[1].trim()
  else if (/\b(\d+)\s+days?\s+ago\b/i.test(raw)) {
    f.onset = (raw.match(/(\d+\s+days?\s+ago)/i) || [])[1]
  }
  else if (/\byesterday\b/.test(t)) f.onset = 'yesterday'

  // Contact name -- "my name is X", "I am X", "This is X".
  const namePat = /(?:my name is|i am|this is|naam is)\s+([A-Z][a-zA-Z]{1,20}(?:\s+[A-Z][a-zA-Z]{1,20})?)/i
  const nameMatch = raw.match(namePat)
  if (nameMatch) f.contact_name = nameMatch[1].trim()

  return f
}

function wantsHuman(t) {
  return /\b(human|person|someone|somebody|real|agent|operator|staff|talk to|speak to|call me)\b/.test(t)
    || /\b(mens|persoon|iemand|umuntu|praat)\b/.test(t)
}

// Cheap, deterministic Afrikaans detector for the sim (the SA stand-in language).
function looksAfrikaans(t) {
  return /\b(dankie|asseblief|hallo|goeie|siek|beeste|diere|vrek|gevrek|my beeste|het nie)\b/.test(t)
}
