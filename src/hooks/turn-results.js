

import { CASE_REF_RE } from './heuristics.js'

const MUTATING_TOOLS = new Set(['case_new', 'case_report', 'case_update', 'case_transition', 'case_switch', 'case_speaker'])

const TEAM_WRITE_TOOLS = ['case_edit', 'case_stage', 'case_message', 'case_claim', 'case_release', 'case_dispatch_reply', 'case_reopen', 'case_ask_ranger', 'team_assign', 'team_draft', 'team_remind', 'team_register', 'team_invite', 'team_nudge_staff']
const WRITE_TOOLS = new Set(['case_report', 'case_update', 'case_new', ...TEAM_WRITE_TOOLS])

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

export function hadSuccessfulWrite(result) {
  for (const { name, parsed } of toolResults(result)) {
    if (WRITE_TOOLS.has(name) && parsed?.ok === true) return true
  }
  return false
}

export function controlRegistered(result, only = null) {
  for (const { name, parsed } of toolResults(result)) {
    if ((only ? name === only : (name === 'case_stop' || name === 'case_handoff')) && parsed?.ok === true) return true
  }
  return false
}

export function refusedWrites(result) {
  const refused = []
  for (const { name, parsed } of toolResults(result)) {
    if (!MUTATING_TOOLS.has(name)) continue
    const err = typeof parsed?.error === 'string' ? parsed.error : null
    if (err) refused.push(`${name}: ${err}`)
  }
  return refused
}

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

export function touchedRefs(result) {
  const refs = []
  for (const { parsed } of toolResults(result)) {
    const ref = parsed?.ok === true ? parsed?.recorded_on?.ref : null
    if (typeof ref === 'string' && !refs.includes(ref)) refs.push(ref)
  }
  return refs
}
