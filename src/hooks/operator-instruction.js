import { runTurn } from '../agent/run-turn.js'
import { buildTurnRequest, resolveTier } from './turn-attempts.js'
import { flagNeedsHuman, observation } from './case-writes.js'
import { correctOutboundRef } from './turn-outcome.js'
import { stripThinkingBlock } from './heuristics.js'
import { isLlmDown } from './service-controls.js'
import { judgeReply } from './reply-judge.js'
import { caseyText } from '../deployment-text.js';

const TURN_TIMEOUT_MS = Number(process.env.CASEY_LLM_TURN_TIMEOUT_MS) || 120000

export function instructionPrompt(instruction, operatorLabel) {
  return caseyText("src/hooks/operator-instruction.js#0", [operatorLabel, instruction])
}

export async function draftFromInstruction({ store, log, llmStatus = null, callLLM = null, caseRow, instruction, operator, draftData = {} }) {
  const fail = async (why) => {
    await store.appendEvent(caseRow.id, observation(caseyText("src/hooks/operator-instruction.js#1", [why])))
    return { ok: false, error: why }
  }
  if (llmStatus && await isLlmDown(llmStatus)) return fail(caseyText("src/hooks/operator-instruction.js#s0"))

  const contact = caseRow.contact_id ? await store.getContact(caseRow.contact_id).catch(() => null) : null
  const events = await store.listEvents(caseRow.id)
  const req = buildTurnRequest({
    prompt: instructionPrompt(instruction, operator.name || operator.id || caseyText("src/hooks/operator-instruction.js#s1")),
    retryFeedback: null, completedActions: [], refusedActions: [],
    fresh: caseRow, events, contact, turnCallLLM: callLLM,
    resolvedTier: resolveTier(contact),
    msg: { from: caseRow.external_id }, external_id: caseRow.external_id, channel: caseRow.channel,
    store, turnBinding: { id: caseRow.id, ref: caseRow.ref }, turnDedupeCache: new Map(),
    timeoutMs: TURN_TIMEOUT_MS, staffSend: null, inboundText: instruction,
  })
  let result
  try { result = await runTurn({ ...req, enabledToolsets: [] }) }
  catch (e) { return fail(caseyText("src/hooks/operator-instruction.js#s2", [e.message])) }
  const text = stripThinkingBlock(String(result?.result || '').trim())
  if (result?.error || !text) return fail(caseyText("src/hooks/operator-instruction.js#s3", [result?.error || caseyText("src/hooks/operator-instruction.js#s4")]))
  const verdict = await judgeReply(callLLM, text, { latestInbound: instruction })
  if (!verdict.clean && verdict.reasons?.length) return fail(caseyText("src/hooks/operator-instruction.js#2", [verdict.reasons.join('; ')]))

  const drafted = await correctOutboundRef({ store, fresh: caseRow, text, result, inboundText: instruction, contact })
  await store.appendEvent(caseRow.id, {
    kind: 'draft', actor: 'agent', channel: caseRow.channel,
    text: drafted, data: { to: caseRow.external_id, fallback: false, draft: true, instruction: true, instructed_by: operator.id, ...draftData },
  })
  await flagNeedsHuman({ store, log, caseRow, notifyHandoff: null, channel: caseRow.channel, from: null, extraTags: ['draft-pending'], flagLabel: caseyText("src/hooks/operator-instruction.js#s5"), notifyLabel: caseyText("src/hooks/operator-instruction.js#s6") })
  return { ok: true, text: drafted }
}
