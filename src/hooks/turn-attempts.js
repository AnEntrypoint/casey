

import { runTurn } from '../agent/run-turn.js'
import { observation, raiseOperatorItem } from './case-writes.js'
import { caseSystemPrompt } from './prompt.js'
import { speakerState } from '../phone-persons.js'
import { consentManaged, consentState } from '../phone-consent.js'
import { returnState } from '../return-clarify.js'
import { buildPromptContext } from './prompt-context.js'
import { fieldLabel } from '../store/report-shape.js'
import { judgeReply } from './reply-judge.js'
import { replyShape, strayContactDetails, singleAsk, jargonIn } from './plain-text.js'
import { loadDomainConfig } from '../config-loader.js'
import { stripThinkingBlock, OPTED_OUT_TAG, detectContactIntent } from './heuristics.js'
import { tagList, parseReport } from '../timestamp.js'
import { deskAuthorityOn } from '../case-tools-team-shared.js'
import { composeAdviceRefusal } from '../advice-refusal.js'
import { mutatingActions, hadSuccessfulWrite, refusedWrites, touchedRefs, controlRegistered } from './turn-results.js'
import { staffNoticeNote } from '../staff-notices.js'
import { confirmRecordChoices } from '../choices.js'
import { refsIn, setFocus, focusOf, proposeFocus, confusableHeldRefs, identifyingLine } from '../team-focus.js'
import { messageId } from './case-intake.js'
import { buildCaseToolset, hiddenToolNamesForTier } from '../case-tools.js'
import { resolveContactTier, canQueryCases, canSignOff, TIER } from '../contact-tiers.js'
import { FAILURE_REASONS } from '../degraded-turns.js'
import { TURN_HARD_DEADLINE_MS } from './turn-deadlines.js'
import { caseyText } from '../deployment-text.js';

export const MAX_TOOL_CHOICE_ATTEMPTS = 3

const SOFT_RETRIES = Math.max(0, Number(process.env.CASEY_SOFT_RETRIES ?? 1) || 0)

const REPEAT_ASK_RETRIES = Math.max(0, Number(process.env.CASEY_REPEAT_ASK_RETRIES ?? 1) || 0)

export const CASE_TOOL_NAMES = buildCaseToolset(null).map(t => t.name)

const MIN_ECHO_WORDS = 8
const normalizeEcho = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
export function systemPromptEchoRuns(candidate, systemPromptText) {

  const offered = loadDomainConfig().persona.adviceRefusalText
  const instructionOnly = String(systemPromptText || '').replace(/<<DATA>>[\s\S]*?<<END>>/g, ' ').split(offered || '\u0000').join(' ')
  const hay = normalizeEcho(candidate)
  if (!hay) return []
  const hits = []

  for (const piece of instructionOnly.split(/[.\n!?;:]+/)) {
    const norm = normalizeEcho(piece)
    const words = norm ? norm.split(' ') : []
    if (words.length < MIN_ECHO_WORDS) continue

    for (let i = 0; i + MIN_ECHO_WORDS <= words.length; i++) {
      const run = words.slice(i, i + MIN_ECHO_WORDS).join(' ')
      if (hay.includes(run)) { hits.push(run); break }
    }
  }
  return hits
}

export function resolveTier(contact) {
  return resolveContactTier(contact)
}

export function attemptTimeout({ isBackgroundRedrive, turnStartedAt }) {
  const configuredTimeoutMs = Number(process.env.CASEY_LLM_TURN_TIMEOUT_MS) || 120000
  if (isBackgroundRedrive) return configuredTimeoutMs
  const remainingMs = TURN_HARD_DEADLINE_MS - (Date.now() - turnStartedAt)
  return remainingMs <= 0 ? remainingMs : Math.min(configuredTimeoutMs, remainingMs)
}

export function classifyTurnError(message) {
  const m = message || ''
  if (m.includes('timeout') || m.includes('deadline')) return FAILURE_REASONS.TIMEOUT
  if (m.includes('provider') || m.includes('unreachable') || m.includes('404') || m.includes('503')) return FAILURE_REASONS.PROVIDER
  return FAILURE_REASONS.RETRY_EXHAUSTED
}

export function buildTurnRequest({
  prompt, retryFeedback, completedActions, refusedActions, fresh, events, contact, turnCallLLM,
  resolvedTier, msg, external_id, channel, store, turnBinding, turnDedupeCache, timeoutMs,
  staffSend = null, inboundRefs = [], inboundText = '', speaker = null, consent = null, ret = null, turnId = '', confirmRefs = [],
}) {
  return {

    prompt: (retryFeedback ? prompt + retryFeedback : prompt)
      + (completedActions.length ? caseyText("src/hooks/turn-attempts.js#0", [completedActions.join('; ')]) : '')

      + (refusedActions?.length ? caseyText("src/hooks/turn-attempts.js#1", [refusedActions.join('; ')]) : ''),
    messages: [{ role: 'system', content: caseSystemPrompt(fresh, events, contact, speaker, consent, ret) }],
    sessionKey: `case:${fresh.id}`,
    callLLM: turnCallLLM,

    tool_choice: 'required',

    enabledToolsets: ['cases'],

    disabledToolsets: hiddenToolNamesForTier(resolvedTier),

    toolCtx: {
      author: msg.from || external_id,
      channel,

      role: 'worker',

      tier: resolvedTier,

      contact: contact ? { id: contact.id, display_name: contact.display_name, external_id: contact.external_id, channel: contact.channel, tier: contact.tier } : null,

      sendReply: staffSend?.sendReply || null,
      canSend: staffSend?.canSend || null,
      sendImage: staffSend?.sendImage || null,
      canSendImage: staffSend?.canSendImage || null,
      sendLocation: staffSend?.sendLocation || null,
      canSendLocation: staffSend?.canSendLocation || null,

      inboundRefs,
      turnId,
      confirmRefs,

      inboundText: String(inboundText || '').slice(0, 2000),
      store,
      principal: { id: msg.from || external_id, role: 'worker' },
      activeCaseRef: turnBinding.ref,
      activeCaseId: turnBinding.id,

      activeCaseBinding: turnBinding,

      dedupeCache: turnDedupeCache,
      now: Date.now(),
    },

    timeoutMs,
  }
}

export async function reportFactsForJudge(store, fallbackRow, events, caseId = fallbackRow?.id) {
  const fresh = await store.getCase(caseId).catch(() => null)

  const row = fresh || (caseId === fallbackRow?.id ? fallbackRow : null)
  if (!row) return { missingFacts: [], knownFacts: [] }

  let reportParsed = true
  if (row.report) { try { JSON.parse(row.report) } catch { reportParsed = false } }
  if (!reportParsed) return { missingFacts: [], knownFacts: [] }
  const { reportObj, missingCritical, missingMandatory } = buildPromptContext(row, events)

  const optedOut = tagList(row).includes(OPTED_OUT_TAG)
  return {
    missingFacts: optedOut ? [] : [
      ...missingMandatory,
      ...missingCritical.map(fieldLabel).filter(l => !missingMandatory.includes(l)),
    ],
    knownFacts: reportObj ? Object.keys(reportObj).filter(k => reportObj[k] != null).map(fieldLabel) : [],
  }
}

function upfrontNote({ consent, ret }) {
  if (consent === 'none') return caseyText("src/hooks/turn-attempts.js#2")
  if (ret?.owed) return caseyText("src/hooks/turn-attempts.js#3")
  return null
}

function jargonFeedback(words, ref) {

  return caseyText("src/hooks/turn-attempts.js#4", [words.join(', '), ref])
}

export async function evaluateCandidate({ store, log, fresh, candidate, attempt, result, lastOutboundText, inboundText, typedText = '', turnCallLLM, priorAttemptWrote = false, systemPromptText = null, factsForJudge = null, staffRefs = [], consentOn = false, returnOn = false, isStaff = false, isTechnician = false }) {

  const offerThing = isStaff ? caseyText("src/hooks/turn-attempts.js#5") : caseyText("src/hooks/turn-attempts.js#6")
  const note = async (text) => {
    try { await store.appendEvent(fresh.id, observation(text)) }
    catch (e) { log.warn?.('[casey] failed to record attempt observation', { caseId: fresh.id, error: e.message }) }
  }
  const canRetry = attempt < MAX_TOOL_CHOICE_ATTEMPTS
  const softCanRetry = canRetry && attempt <= SOFT_RETRIES
  if (!candidate) {
    log.warn?.('[casey] agent turn produced empty reply', { caseId: fresh.id, attempt })
    await note(caseyText("src/hooks/turn-attempts.js#s0", [attempt, canRetry ? '; retrying' : '']))
    return { done: false, retryFeedback: caseyText("src/hooks/turn-attempts.js#7") }
  }

  if (lastOutboundText) {
    const strip = (s) => String(s).toLowerCase().replace(/CASE-\d+-[a-z0-9]+/gi, '').replace(/\s+/g, ' ').trim()
    if (strip(candidate) === strip(lastOutboundText)) {
      await note(caseyText("src/hooks/turn-attempts.js#8", [attempt]))
      return { done: false, retryFeedback: caseyText("src/hooks/turn-attempts.js#9") }
    }
  }

  const echoRuns = systemPromptText ? systemPromptEchoRuns(candidate, systemPromptText) : []
  if (echoRuns.length) {
    if (canRetry) {
      log.warn?.('[casey] reply recites the system prompt verbatim; retrying turn with feedback', { caseId: fresh.id, attempt, runs: echoRuns.length })
      await note(caseyText("src/hooks/turn-attempts.js#10", [echoRuns.length, attempt]))
      return { done: false, retryFeedback: caseyText("src/hooks/turn-attempts.js#11") }
    }
    log.warn?.('[casey] reply recites the system prompt on a spent retry budget; holding for a human', { caseId: fresh.id, runs: echoRuns.length })
    return { done: true, text: candidate, jargonReasons: [caseyText("src/hooks/turn-attempts.js#12", [echoRuns.length, echoRuns[0].slice(0, 60)])] }
  }

  const leakedToolNames = CASE_TOOL_NAMES.filter(n => candidate.includes(n))
  if (leakedToolNames.length) {
    if (canRetry) {
      log.warn?.('[casey] reply names casey internal tools; retrying turn with feedback', { caseId: fresh.id, attempt, tools: leakedToolNames })
      await note(caseyText("src/hooks/turn-attempts.js#13", [leakedToolNames.join(', '), attempt]))
      return { done: false, retryFeedback: caseyText("src/hooks/turn-attempts.js#14")
        + leakedToolNames.join(', ')
        + caseyText("src/hooks/turn-attempts.js#15") + offerThing + '.]' }
    }
    log.warn?.('[casey] reply names casey internal tools on a spent retry budget; holding for a human', { caseId: fresh.id, tools: leakedToolNames })
    return { done: true, text: candidate, jargonReasons: [caseyText("src/hooks/turn-attempts.js#s1", [leakedToolNames.join(', ')])] }
  }

  const missingRefs = staffRefs.filter(r => !candidate.toLowerCase().includes(String(r).toLowerCase()))
  if (missingRefs.length) {
    if (canRetry) {
      await note(caseyText("src/hooks/turn-attempts.js#16", [missingRefs.join(', '), attempt]))
      return { done: false, retryFeedback: caseyText("src/hooks/turn-attempts.js#17", [missingRefs.join(' and ')]) }
    }
    await note(caseyText("src/hooks/turn-attempts.js#18", [missingRefs.join(', ')]))
    return { done: true, text: `${candidate} (${missingRefs.join(', ')})` }
  }

  const persona = loadDomainConfig().persona
  const stray = strayContactDetails(candidate, [inboundText, process.env.CASEY_PUBLIC_URL, fresh.ref])
  if (stray.length) {
    if (canRetry) {
      log.warn?.('[casey] reply carries a number or address nobody configured; retrying turn with feedback', { caseId: fresh.id, attempt, stray_count: stray.length })
      await note(caseyText("src/hooks/turn-attempts.js#19", [stray.join(', '), attempt]))
      return { done: false, retryFeedback: caseyText("src/hooks/turn-attempts.js#20", [stray.join(', ')]) }
    }
    await store.appendEvent(fresh.id, observation(caseyText("src/hooks/turn-attempts.js#21", [stray.join(', ')])))
  }

  const controlNoted = controlRegistered(result) || detectContactIntent(typedText) === 'stop'

  const wroteThisTurn = priorAttemptWrote || hadSuccessfulWrite(result) || controlNoted || controlRegistered(result, 'case_consent')
  const { missingFacts = [], knownFacts = [] } = factsForJudge ? await factsForJudge() : {}

  const consentNow = consentOn && fresh.contact_id ? await consentState(store, fresh.contact_id, { caseId: fresh.id }) : null
  const consentOwed = consentNow === 'none'
  const consentAgreed = consentNow === 'agreed'

  const clarifyOwed = returnOn && !consentOwed && !!fresh.id && (await returnState(store, await store.getCase(fresh.id).catch(() => null), { id: fresh.contact_id, tier: 'reporter' })).owed

  let recordedLanguage = ''
  try { recordedLanguage = String(parseReport(await store.getCase(fresh.id))?.language_detected || '') } catch {  }

  if (!isStaff && replyShape(candidate).questions >= 2) {
    const mended = singleAsk(candidate)
    await note(caseyText("src/hooks/turn-attempts.js#22", [replyShape(candidate).questions]))
    candidate = mended
  }
  const shape = replyShape(candidate)

  const jargon = isStaff ? [] : jargonIn(candidate)
  if (jargon.length && canRetry) {
    log.warn?.('[casey] reply carries internal words; retrying turn with feedback', { caseId: fresh.id, attempt, jargon })
    await note(caseyText("src/hooks/turn-attempts.js#23", [jargon.join(', '), attempt]))
    return { done: false, retryFeedback: jargonFeedback(jargon, fresh.ref) }
  }
  let verdict = await judgeReply(turnCallLLM, candidate, { lastOutboundText, hadSuccessfulWrite: wroteThisTurn, latestInbound: inboundText, missingFacts, knownFacts, shape, consentOwed, consentAgreed, clarifyOwed, recordedLanguage, adviceRefusal: persona.adviceRefusalText || null, controlNoted })
  if (verdict.fault) await raiseOperatorItem({ store, log, caseId: fresh.id, code: 'judge.fault', fields: { attempt, fault: verdict.fault } })

  if (isStaff && !verdict.clean && verdict.reasons?.length) {
    const rest = verdict.reasons.filter(r => !/jargon|multi.?ask|wall of text|repeat.?ask/i.test(r) && !(isTechnician && /advice.?given/i.test(r)))
    if (rest.length !== verdict.reasons.length) verdict = rest.length ? { ...verdict, reasons: rest, category: 'other' } : { clean: true, reasons: [], category: null }
  }

  if (!verdict.clean && verdict.reasons?.length && controlRegistered(result, 'case_stop')) {
    const rest = verdict.reasons.filter(r => !/promise.?made/i.test(r))
    if (rest.length !== verdict.reasons.length) verdict = rest.length ? { ...verdict, reasons: rest } : { clean: true, reasons: [], category: null }
  }

  if ((consentOwed || clarifyOwed) && !verdict.clean && verdict.reasons?.length) {
    const rest = verdict.reasons.filter(r => !/repeat.?ask/i.test(r))
    if (rest.length !== verdict.reasons.length) verdict = rest.length ? { ...verdict, reasons: rest } : { clean: true, reasons: [], category: null }
  }

  if (jargon.length) verdict = { clean: false, category: 'jargon', reasons: [caseyText("src/hooks/turn-attempts.js#s2", [jargon.join(', ')])] }
  else if (verdict.category === 'jargon' || verdict.reasons?.some(r => /jargon/i.test(r))) {
    const rest = (verdict.reasons || []).filter(r => !/jargon/i.test(r))
    verdict = rest.length ? { ...verdict, reasons: rest, category: 'other' } : { clean: true, reasons: [], category: null }
  }
  if (verdict.clean) return { done: true, text: candidate }

  if (verdict.category === 'jargon') {
    if (canRetry) {
      log.warn?.('[casey] reply judge flagged an internal jargon leak; retrying turn with feedback', { caseId: fresh.id, attempt, reasons: verdict.reasons })
      await note(caseyText("src/hooks/turn-attempts.js#24", [verdict.reasons.join('; '), attempt]))

      return { done: false, retryFeedback: jargonFeedback(jargon, fresh.ref) }
    }
    return { done: true, text: candidate, jargonReasons: verdict.reasons }
  }

  if (!wroteThisTurn && verdict.reasons?.some(r => /false.?confirm|claims?.*record|confirm.*record/i.test(r))) {

    const consentHint = (consentManaged() && fresh.contact_id && await consentState(store, fresh.contact_id, { caseId: fresh.id }) !== 'agreed')
      ? caseyText("src/hooks/turn-attempts.js#25")
      : ''
    if (canRetry) {
      log.warn?.('[casey] reply judge flagged a false confirmation; retrying turn with feedback', { caseId: fresh.id, attempt, reasons: verdict.reasons })
      await note(caseyText("src/hooks/turn-attempts.js#26", [verdict.reasons.join('; '), attempt]))
      return { done: false, retryFeedback: caseyText("src/hooks/turn-attempts.js#27") + consentHint + caseyText("src/hooks/turn-attempts.js#28") }
    }

    if (consentOwed) {
      log.warn?.('[casey] reply claimed a record the consent gate held, on a spent retry budget; sending anyway', { caseId: fresh.id, reasons: verdict.reasons })
      await store.appendEvent(fresh.id, observation(caseyText("src/hooks/turn-attempts.js#29", [verdict.reasons.join('; ')])))
      return { done: true, text: candidate }
    }
    return { done: true, text: candidate, falseConfirmReasons: verdict.reasons }
  }

  const faultRoutes = [
    [/advice.?given/i, caseyText("src/hooks/turn-attempts.js#30", [persona.adviceRefusalText || caseyText("src/hooks/turn-attempts.js#s3")])],
    [/promise.?made/i, caseyText("src/hooks/turn-attempts.js#31")],
    [/wrong.?language/i, caseyText("src/hooks/turn-attempts.js#32")],
    [/clarify.?not.?asked/i, caseyText("src/hooks/turn-attempts.js#33")],
    [/consent.?not.?asked/i, caseyText("src/hooks/turn-attempts.js#34")],
    [/consent.?reask/i, caseyText("src/hooks/turn-attempts.js#35")],
    [/not.?recorded/i, caseyText("src/hooks/turn-attempts.js#36")],
  ]
  const faults = faultRoutes.filter(([re]) => verdict.reasons?.some(r => re.test(r))).map(([, text]) => text)
  if (faults.length) {
    const alsoMulti = verdict.reasons?.some(r => /multi.?ask|wall of text/i.test(r)) ? caseyText("src/hooks/turn-attempts.js#37") : ''

    const hardFault = verdict.reasons?.some(r => /advice.?given|consent.?not.?asked|clarify.?not.?asked|consent.?reask|not.?recorded/i.test(r))
    if (hardFault ? canRetry : softCanRetry) {
      log.warn?.('[casey] reply judge flagged advice, a promise or the language; retrying turn with feedback', { caseId: fresh.id, attempt, reasons: verdict.reasons })
      await note(caseyText("src/hooks/turn-attempts.js#38", [verdict.reasons.join('; '), attempt]))
      return { done: false, retryFeedback: caseyText("src/hooks/turn-attempts.js#39", [faults.join('; and because '), alsoMulti]) }
    }

    if (faultRoutes[0][0].test(verdict.reasons.join(' '))) {

      const safe = await composeAdviceRefusal(turnCallLLM, { inboundText, language: recordedLanguage })
      if (safe) {
        log.warn?.('[casey] reply still gave advice on a spent retry budget; sent a composed no-advice reply instead', { caseId: fresh.id, reasons: verdict.reasons })
        await store.appendEvent(fresh.id, observation(caseyText("src/hooks/turn-attempts.js#40", [verdict.reasons.join('; '), String(candidate).replace(/\s+/g, ' ').slice(0, 300)])))
        return { done: true, text: safe }
      }
      log.warn?.('[casey] reply still gave advice on a spent retry budget; holding for a human', { caseId: fresh.id, reasons: verdict.reasons })
      return { done: true, text: candidate, adviceReasons: verdict.reasons }
    }
    log.warn?.('[casey] reply judge flagged a promise, the language or advice on a spent retry budget; sending anyway', { caseId: fresh.id, reasons: verdict.reasons })
    await store.appendEvent(fresh.id, observation(`REPLY-JUDGE-FLAGGED-BUT-SENT: ${verdict.reasons.join('; ')}`))
    return { done: true, text: candidate }
  }

  if (missingFacts.length && verdict.reasons?.some(r => /farewell.?gap/i.test(r))) {
    if (softCanRetry) {
      log.warn?.('[casey] reply said goodbye with on-site-critical facts still missing; retrying turn with feedback', { caseId: fresh.id, attempt, missing: missingFacts })
      await note(caseyText("src/hooks/turn-attempts.js#41", [missingFacts.join(', '), attempt]))
      return { done: false, retryFeedback: caseyText("src/hooks/turn-attempts.js#42")
        + caseyText("src/hooks/turn-attempts.js#43", [missingFacts.join(', '), missingFacts.length === 1 ? 'is' : 'are'])
        + caseyText("src/hooks/turn-attempts.js#44", [missingFacts[0]]) }
    }
    log.warn?.('[casey] reply said goodbye with facts still missing on a spent retry budget; sending anyway', { caseId: fresh.id, missing: missingFacts })
    await store.appendEvent(fresh.id, observation(caseyText("src/hooks/turn-attempts.js#45", [missingFacts.join(', ')])))
    return { done: true, text: candidate }
  }

  if (verdict.reasons?.some(r => /repeat.?ask/i.test(r))) {

    if (canRetry && attempt <= REPEAT_ASK_RETRIES) {
      log.warn?.('[casey] reply re-asked something already asked or already recorded; retrying turn with feedback', { caseId: fresh.id, attempt, reasons: verdict.reasons })
      await note(caseyText("src/hooks/turn-attempts.js#46", [verdict.reasons.join('; '), attempt]))
      return { done: false, retryFeedback: caseyText("src/hooks/turn-attempts.js#47")
        + (knownFacts.length ? caseyText("src/hooks/turn-attempts.js#s4", [knownFacts.join(', ')]) : '')
        + (missingFacts.length ? caseyText("src/hooks/turn-attempts.js#48", [missingFacts.slice(0, 3).join(', ')]) : caseyText("src/hooks/turn-attempts.js#49"))
        + caseyText("src/hooks/turn-attempts.js#50") }
    }
    log.warn?.('[casey] reply re-asked a known fact on a spent retry budget; sending anyway', { caseId: fresh.id, reasons: verdict.reasons })
    await store.appendEvent(fresh.id, observation(`REPEAT-ASK-BUT-SENT: ${verdict.reasons.join('; ')}`))
    return { done: true, text: candidate }
  }
  if (verdict.reasons?.some(r => /repeated|echo|stock|meta.?commentary|planning narration/i.test(r))) {

    if (canRetry) {
      log.warn?.('[casey] reply judge flagged the composed reply; retrying turn with feedback', { caseId: fresh.id, attempt, reasons: verdict.reasons })
      await note(caseyText("src/hooks/turn-attempts.js#51", [verdict.reasons.join('; '), attempt]))
      return { done: false, retryFeedback: caseyText("src/hooks/turn-attempts.js#52", [verdict.reasons.join('; ')]) }
    }
    log.warn?.('[casey] reply judge flagged the composed reply; blanking', { caseId: fresh.id, reasons: verdict.reasons })
    await store.appendEvent(fresh.id, observation(`REPLY-JUDGE-FLAGGED: ${verdict.reasons.join('; ')}; blanked`))
    return { done: true, text: '' }
  }

  if (verdict.reasons?.some(r => /multi.?ask|wall of text|too many questions/i.test(r))) {
    if (softCanRetry) {
      log.warn?.('[casey] reply judge flagged a multi-ask reply; retrying turn with feedback', { caseId: fresh.id, attempt, reasons: verdict.reasons })
      await note(caseyText("src/hooks/turn-attempts.js#53", [verdict.reasons.join('; '), attempt]))
      return { done: false, retryFeedback: caseyText("src/hooks/turn-attempts.js#54") }
    }
  }

  if (canRetry) {
    log.warn?.('[casey] reply judge flagged the composed reply; retrying turn with feedback', { caseId: fresh.id, attempt, reasons: verdict.reasons })
    await note(caseyText("src/hooks/turn-attempts.js#55", [verdict.reasons.join('; '), attempt]))
    return { done: false, retryFeedback: caseyText("src/hooks/turn-attempts.js#56")
      + verdict.reasons.join('; ')
      + caseyText("src/hooks/turn-attempts.js#57") + offerThing + '.]' }
  }
  log.warn?.('[casey] reply judge flagged the composed reply; sending anyway', { caseId: fresh.id, reasons: verdict.reasons })
  await store.appendEvent(fresh.id, observation(`REPLY-JUDGE-FLAGGED-BUT-SENT: ${verdict.reasons.join('; ')}`))
  return { done: true, text: candidate }
}

export async function runAgentTurn({
  store, log, callLLM, msg, fresh, events, contact, inboundText, typedText, prompt,
  channel, external_id, turnStartedAt, isBackgroundRedrive, staffSend = null, ingressRecorded = false,
}) {

  const turnCallLLM = msg.resume ? (req) => callLLM(req, { recordHealth: false }) : callLLM
  const resolvedTier = resolveTier(contact)

  if (canQueryCases(resolvedTier) && contact?.id) prompt += await staffNoticeNote(store, contact)
  const inboundRefs = refsIn(inboundText)
  const turnId = String(messageId(msg) || '')
  const confirmRefs = []
  let preChoices = null

  if (canQueryCases(resolvedTier) && contact?.id && inboundRefs.length === 1) {
    try {
      const named = await store.getCaseByRef(inboundRefs[0])
      if (named && named.channel !== 'system' && deskAuthorityOn({ contact, tier: resolvedTier }, named)) {
        const already = (await focusOf(store, contact.id))?.caseId === named.id
        const lookalikes = already ? [] : await confusableHeldRefs(store, contact, named.ref)
        if (lookalikes.length) {
          confirmRefs.push(String(named.ref).toUpperCase())
          await proposeFocus(store, contact.id, named, turnId)
          preChoices = confirmRecordChoices(named.ref)
          prompt += caseyText("src/hooks/turn-attempts.js#58", [named.ref, identifyingLine(named), lookalikes.join(', ')])
        } else await setFocus(store, contact.id, named)
      }
    } catch (e) { log.warn?.('[casey] typed-reference focus failed', { caseId: fresh.id, error: e.message }) }
  }

  const lastOutboundText = [...events].reverse().find(e => e.kind === 'outbound')?.text || null

  let systemPromptText = ''

  const turnBinding = { id: fresh.id, ref: fresh.ref }

  const speakerOn = resolvedTier === TIER.reporter && !!contact?.id
  const readSpeaker = async (touch) => {
    if (!speakerOn) return null
    try { return await speakerState(store, contact.id, { touch, caseId: turnBinding.id }) } catch { return null }
  }
  let speaker = await readSpeaker(true)
  const speakerAtStart = speaker

  const consentOn = consentManaged() && resolvedTier === TIER.reporter && !!contact?.id
  const readConsent = async () => (consentOn ? consentState(store, contact.id, { caseId: turnBinding.id }) : null)
  let consent = await readConsent()

  const returnOn = resolvedTier === TIER.reporter && !!contact?.id
  const readReturn = async () => (returnOn ? returnState(store, await store.getCase(turnBinding.id).catch(() => null), contact) : null)
  let ret = await readReturn()
  systemPromptText = caseSystemPrompt(fresh, events, contact, speaker, consent, ret)

  const turnDedupeCache = new Map()

  const completedActions = []

  const refusedActions = []

  let turnWroteSomething = false

  let result, text = '', errored = false, degradedReason = null

  let jargonReasons = null, falseConfirmReasons = null, adviceReasons = null, retryFeedback = upfrontNote({ consent, ret })

  for (let attempt = 1; attempt <= MAX_TOOL_CHOICE_ATTEMPTS; attempt++) {
    const timeoutMs = attemptTimeout({ isBackgroundRedrive, turnStartedAt })
    if (timeoutMs <= 0) {
      log.warn?.('[casey] turn hard deadline reached before this attempt could start; stopping retries', { caseId: fresh.id, attempt })
      if (!degradedReason) degradedReason = FAILURE_REASONS.TIMEOUT
      break
    }
    if (attempt > 1) { speaker = await readSpeaker(false); consent = await readConsent(); ret = await readReturn() }
    try {
      result = await runTurn(buildTurnRequest({
        prompt, retryFeedback, completedActions, refusedActions, fresh, events, contact, turnCallLLM,
        resolvedTier, msg, external_id, channel, store, turnBinding, turnDedupeCache, timeoutMs,
        staffSend, inboundRefs, inboundText, speaker, consent, ret, turnId, confirmRefs,
      }))
    } catch (e) {
      errored = true
      log.error?.('[casey] agent turn failed', { caseId: fresh.id, error: e.message })
      if (!degradedReason) degradedReason = classifyTurnError(e.message)

      try { await store.appendEvent(fresh.id, observation(caseyText("src/hooks/turn-attempts.js#s5", [e.message]))) }
      catch (e2) { log.error?.('[casey] failed to record agent-turn-error observation', { caseId: fresh.id, error: e2.message }) }
      result = {}
      break
    }

    const candidate = stripThinkingBlock((result?.result || '').toString().trim())

    for (const action of mutatingActions(result)) completedActions.push(action)
    const refusedThisAttempt = refusedWrites(result)
    for (const r of refusedThisAttempt) if (!refusedActions.includes(r)) refusedActions.push(r)

    if (hadSuccessfulWrite(result)) turnWroteSomething = true

    if (refusedThisAttempt.length && !turnWroteSomething && attempt < MAX_TOOL_CHOICE_ATTEMPTS) {
      try {
        await store.appendEvent(fresh.id, observation(caseyText("src/hooks/turn-attempts.js#59", [refusedThisAttempt.join('; '), attempt])))
      } catch (e) { log.warn?.('[casey] could not record write-refused observation', { caseId: fresh.id, error: e.message }) }

      retryFeedback = null
      continue
    }
    const verdict = await evaluateCandidate({
      store, log, fresh, candidate, attempt, result, lastOutboundText, inboundText, typedText, turnCallLLM,
      priorAttemptWrote: turnWroteSomething || ingressRecorded, systemPromptText,
      staffRefs: canQueryCases(resolvedTier) ? touchedRefs(result) : [],
      consentOn, returnOn, isStaff: canQueryCases(resolvedTier), isTechnician: canSignOff(resolvedTier),

      factsForJudge: () => reportFactsForJudge(store, fresh, events, turnBinding.id),
    })
    if (!verdict.done) { retryFeedback = verdict.retryFeedback; continue }
    text = verdict.text

    if (canQueryCases(resolvedTier) && (verdict.jargonReasons || verdict.falseConfirmReasons || verdict.adviceReasons)) {
      await store.appendEvent(fresh.id, observation(caseyText("src/hooks/turn-attempts.js#60", [(verdict.jargonReasons || verdict.falseConfirmReasons || verdict.adviceReasons).join('; ')]))).catch(() => {})
      verdict.jargonReasons = verdict.falseConfirmReasons = verdict.adviceReasons = null
    }
    jargonReasons = verdict.jargonReasons || null
    falseConfirmReasons = verdict.falseConfirmReasons || null
    adviceReasons = verdict.adviceReasons || null
    break
  }

  return { result, text, errored, jargonReasons, falseConfirmReasons, adviceReasons, degradedReason, activeCase: turnBinding, speakerAtStart, preChoices }
}
