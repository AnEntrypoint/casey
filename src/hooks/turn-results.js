// hooks/turn-results.js -- pure readers over ONE runTurn() result.
//
// Everything here answers "what did this attempt actually DO?" by reading the
// real tool-call results freddie returned, never by classifying text. Each is a
// function of `result` alone and closes over nothing.
//
// Shared premise for all of them: a tool-role message carries `tool_call_id`
// but never a `name` -- agent/run-turn.js's summarizeSince() builds them as
// {role:'tool', tool_call_id, content} -- so the tool's NAME lives on the
// preceding assistant message's tool_calls[].name. In mutatingActions and
// hadSuccessfulWrite any parse failure or non-matching content counts as "no,
// it did not happen", never a false positive; toolCaseRefs is deliberately the
// opposite (see its own note).

import { CASE_REF_RE } from './heuristics.js'

// Mutating tools whose success is worth telling a RETRY attempt about, so it
// does not blindly repeat the call: a retry is a fresh runTurn and cannot see
// the prior attempt's tool results, so without this note it re-opens the case
// it already opened.
const MUTATING_TOOLS = new Set(['case_new', 'case_report', 'case_update', 'case_transition', 'case_switch'])
// The narrower set that counts as "a report field was actually WRITTEN this
// turn" -- ground truth for reply-judge.js's FALSE CONFIRMATION shape (the
// judge decides whether the reply's WORDS claim a write; this decides whether
// one really happened).
const WRITE_TOOLS = new Set(['case_report', 'case_update', 'case_new'])

// tool_call_id -> tool name, read off this turn's assistant messages.
function toolNamesById(result) {
  const nameById = new Map()
  if (!Array.isArray(result?.messages)) return nameById
  for (const m of result.messages) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) nameById.set(tc.id || tc.tool_call_id, tc.name || tc.function?.name)
    }
  }
  return nameById
}

// Every tool-role message's (name, parsed-content) pair, skipping anything that
// is not a recognized JSON tool result.
function* toolResults(result) {
  if (!Array.isArray(result?.messages)) return
  const nameById = toolNamesById(result)
  for (const m of result.messages) {
    if (m?.role !== 'tool' || !m.content) continue
    const name = nameById.get(m.tool_call_id)
    if (!name) continue
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    let parsed
    try { parsed = JSON.parse(content) } catch { continue }
    yield { name, parsed }
  }
}

// Human-readable record of the MUTATING tool calls that succeeded in this
// attempt, for the cross-attempt "already DONE -- do not repeat" retry note.
export function mutatingActions(result) {
  const done = []
  for (const { name, parsed } of toolResults(result)) {
    if (!MUTATING_TOOLS.has(name) || parsed?.ok !== true) continue
    const detail = parsed.activeCase?.ref ? ` (${parsed.activeCase.ref})`
      : parsed.fields ? ` (${Object.keys(parsed.fields).join(', ')})` : ''
    done.push(`${name}${detail}`)
  }
  return done
}

// Did case_report/case_update/case_new actually write something this turn?
export function hadSuccessfulWrite(result) {
  for (const { name, parsed } of toolResults(result)) {
    if (WRITE_TOOLS.has(name) && parsed?.ok === true) return true
  }
  return false
}

// Every case-ref-shaped token that came BACK from a tool call this turn. An
// enquiry turn legitimately cites other cases' real refs, so these must survive
// the outbound ref sanitizer untouched -- only a ref the model invented gets
// rewritten. Scans the raw stringified tool content rather than parsing each
// tool's own result shape: a superset is safe here, since the only token at
// risk is one this same regex would ALSO have stripped out of the reply.
export function toolCaseRefs(result) {
  const refs = []
  if (!Array.isArray(result?.messages)) return refs
  for (const m of result.messages) {
    if (m?.role !== 'tool' || !m.content) continue
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    const found = content.match(CASE_REF_RE)
    if (found) refs.push(...found)
  }
  return refs
}
