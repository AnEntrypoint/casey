import { runTurn } from '../agent/run-turn.js'
import { buildTurnRequest, resolveTier } from './turn-attempts.js'
import { flagNeedsHuman, observation } from './case-writes.js'
import { correctOutboundRef } from './turn-outcome.js'
import { stripThinkingBlock } from './heuristics.js'
import { isLlmDown } from './service-controls.js'

const TURN_TIMEOUT_MS = Number(process.env.CASEY_LLM_TURN_TIMEOUT_MS) || 120000

export function instructionPrompt(instruction, operatorLabel) {
  return `[Team member instruction from ${operatorLabel}, typed at the console. It is NOT something the contact said. Write the message to send to the contact now, in the language they have been using, in plain words and short. Use only facts already on this record or stated in the instruction. Output only the message text. Do not call any tool.]\n\nInstruction: ${instruction}`
}

export async function draftFromInstruction({ store, log, llmStatus = null, callLLM = null, caseRow, instruction, operator }) {
  const fail = async (why) => {
    await store.appendEvent(caseRow.id, observation(`INSTRUCTION-NOT-DRAFTED: ${why}; nothing was drafted or sent`))
    return { ok: false, error: why }
  }
  if (llmStatus && await isLlmDown(llmStatus)) return fail('the assistant is offline')

  const contact = caseRow.contact_id ? await store.getContact(caseRow.contact_id).catch(() => null) : null
  const events = await store.listEvents(caseRow.id)
  const req = buildTurnRequest({
    prompt: instructionPrompt(instruction, operator.name || operator.id || 'a team member'),
    retryFeedback: null, completedActions: [], refusedActions: [],
    fresh: caseRow, events, contact, turnCallLLM: callLLM,
    resolvedTier: resolveTier(contact),
    msg: { from: caseRow.external_id }, external_id: caseRow.external_id, channel: caseRow.channel,
    store, turnBinding: { id: caseRow.id, ref: caseRow.ref }, turnDedupeCache: new Map(),
    timeoutMs: TURN_TIMEOUT_MS, staffSend: null, inboundText: instruction,
  })
  let result
  try { result = await runTurn({ ...req, enabledToolsets: [] }) }
  catch (e) { return fail(`the assistant turn failed (${e.message})`) }
  const text = stripThinkingBlock(String(result?.result || '').trim())
  if (result?.error || !text) return fail(`the assistant gave no reply (${result?.error || 'empty reply'})`)

  const drafted = await correctOutboundRef({ store, fresh: caseRow, text, result, inboundText: instruction, contact })
  await store.appendEvent(caseRow.id, {
    kind: 'draft', actor: 'agent', channel: caseRow.channel,
    text: drafted, data: { to: caseRow.external_id, fallback: false, draft: true, instruction: true, instructed_by: operator.id },
  })
  await flagNeedsHuman({ store, log, caseRow, notifyHandoff: null, channel: caseRow.channel, from: null, extraTags: ['draft-pending'], flagLabel: 'instruct draft', notifyLabel: 'instruct draft' })
  return { ok: true, text: drafted }
}
