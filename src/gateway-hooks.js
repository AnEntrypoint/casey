// gateway-hooks.js -- casey's inbound handler for the freddie Gateway.
//
// freddie's built-in Gateway.handleInbound runs a context-free runTurn and
// sends the result. casey needs the agent turn to carry full case context and
// have the case_* tools, and needs every step on the thatcher timeline. So
// instead of layering hooks around freddie's turn (which would run a second,
// context-free turn), casey REPLACES handleInbound with makeCaseHandler():
//
//   inbound message
//     -> find/create case (thatcher)
//     -> log inbound event
//     -> agent turn with case context + case tools (runTurn)
//     -> log outbound event
//     -> send reply via the channel adapter
//
// All writes go through the CaseStore, so the dashboard observes everything and
// an operator can override case state at any time.

import { runTurn } from 'freddie'

const CHANNEL_DEFAULT = { whatsapp: 'whatsapp', discord: 'discord', sim: 'sim' }

// Build the system context the agent sees for a given case + recent timeline.
//
// The contact may be elderly, may not read well, and may not speak English as a
// first language. So the prompt does two jobs: it keeps a private structured
// record for the agent's own reasoning (status/priority/timeline, never shown to
// the contact), and it spells out plain-language REPLY rules -- mirror the
// contact's language, short warm sentences, one question, no jargon, greet+give
// the reference on first contact, and reassure when a human is requested.
function caseSystemPrompt(caseRow, events, contact) {
  const recent = events.slice(-20).map(e =>
    `- [${e.created_at}] ${e.kind}/${e.actor}: ${truncate(e.text, 280)}`).join('\n')
  const firstMessage = events.filter(e => e.kind === 'inbound').length <= 1
  return [
    // --- Private structured context (for the agent's reasoning ONLY) ---
    `You are casey, helping a person who messaged in on ${caseRow.channel}.`,
    `The block below is private background for your own reasoning. NEVER repeat it,`,
    `quote it, or use its words when you reply. The person must never see internal`,
    `terms like case, ticket, triage, workflow, autonomy, transition, status, or`,
    `priority. You may quietly keep records current with the case_* tools, but how`,
    `you handle records has nothing to do with how you talk to the person.`,
    `Respect the handling mode "${caseRow.autonomy}":`,
    `  - auto     -- act and move things along freely behind the scenes.`,
    `  - assisted -- act, but leave anything risky for a human to confirm.`,
    `  - observe  -- do not change records; only reply and note what you observe.`,
    ``,
    // The "CURRENT CASE <ref> (id=<id>)" token is parsed by tooling/tests; keep it.
    `CURRENT CASE ${caseRow.ref} (id=${caseRow.id})  [private -- do not mention to the person]`,
    `  status: ${caseRow.status}   priority: ${caseRow.priority}   assignee: ${caseRow.assignee}`,
    `  subject: ${caseRow.subject || '(none yet)'}`,
    `  contact: ${contact?.display_name || caseRow.external_id}`,
    `  summary: ${caseRow.summary || '(none yet)'}`,
    `  tags: ${caseRow.tags || '(none)'}`,
    `  first message from this person? ${firstMessage ? 'YES (brand new)' : 'no'}`,
    ``,
    `RECENT TIMELINE (private):`,
    recent || '  (no prior events)',
    ``,
    // --- How to actually REPLY to the person ---
    `HOW TO REPLY:`,
    `Write the way you would speak kindly to someone who is worried, may be elderly,`,
    `may not be a strong reader, and may not speak English as a first language.`,
    `1. LANGUAGE: Look at the words the person used and reply in that SAME language.`,
    `   If they wrote in Spanish, reply in Spanish; Afrikaans, reply in Afrikaans; etc.`,
    `   If you truly cannot tell, use simple English. Never switch languages on them.`,
    `2. KEEP IT SHORT: short, plain sentences. One idea per sentence. No big or`,
    `   technical words. No lists or forms. Just a few warm lines.`,
    `3. ONE QUESTION: ask at most ONE question per message, and only if you need it.`,
    `4. BE WARM: sound calm, friendly, reassuring. Thank them for reaching out. Let`,
    `   them know they are being helped and are not alone.`,
    `5. NO JARGON: never say case, ticket, triage, status, priority, workflow,`,
    `   escalate, transition, or autonomy. Speak like a helpful person, not a system.`,
    ``,
    firstMessage
      ? [`THIS IS THEIR FIRST MESSAGE. Greet them warmly and thank them for getting in`,
         `touch. In plain words, tell them you have their message and a real person will`,
         `follow up. Give them their reference simply, for example: "Thank you for`,
         `reaching out. A member of our team will get back to you soon. If you need to`,
         `remind us, your reference is ${caseRow.ref}." Then, if helpful, ask one gentle`,
         `question about how you can help.`].join('\n')
      : `Continue gently from the earlier messages above. Pick up where things left off.`,
    ``,
    `IF THEY ASK FOR A PERSON (in any language or phrasing -- "talk to someone", "I`,
    `want a person", "real human", "is anyone there"): do NOT argue or stall. Warmly`,
    `reassure them that a real person will help, and that their message has been`,
    `passed on. Stay kind and calm.`,
    ``,
    `Your final message is exactly what the person receives on ${caseRow.channel}, so`,
    `make sure it is only the warm, simple reply -- nothing else.`,
  ].join('\n')
}

// Returns an async (platform, msg) handler suitable to assign to
// gateway.handleInbound. `store` is a CaseStore; opts.callLLM optional;
// opts.autoRespond=false to track-only (no agent turn / reply).
const FALLBACK_REPLY = "Thanks for your message. We've logged it and someone will follow up shortly."

export function makeCaseHandler(store, { callLLM = null, autoRespond = true, log = console } = {}) {
  return async function handleInbound(platform, msg) {
    const channel = CHANNEL_DEFAULT[platform] || platform || 'other'
    const external_id = conversationKey(msg)
    const adapter = this?.platforms?.get?.(platform)
    const msgId = messageId(msg)

    let caseRow, created
    try {
      ;({ case: caseRow, created } = await store.findOrCreateCase({
        channel, external_id,
        contact: { display_name: msg.raw?.author?.username, handle: msg.raw?.author?.username },
      }))
    } catch (e) {
      log.error?.('[casey] findOrCreateCase failed', { channel, external_id, error: e.message })
      return { to: msg.from, text: '', platform, error: e.message }
    }

    // Dedup: a redelivered platform message (webhook retry, gateway replay) is
    // recorded and answered exactly once.
    if (msgId && await store.hasInboundMessage(caseRow.id, msgId)) {
      log.info?.('[casey] duplicate inbound dropped', { caseId: caseRow.id, msgId })
      return { to: msg.from, text: '', platform, caseId: caseRow.id, duplicate: true }
    }

    const inboundText = (msg.text || '').trim()
    const media = describeMedia(msg)
    await store.appendEvent(caseRow.id, {
      kind: 'inbound', actor: 'contact', channel,
      text: inboundText || (media ? `[${media}]` : '[empty message]'),
      data: { from: msg.from, raw: msg.raw }, msg_id: msgId,
    })
    if (created) {
      if (!caseRow.subject) {
        const subj = truncate(inboundText || media || 'New conversation', 80)
        try { await store.updateCase(caseRow.id, { subject: subj }) } catch (e) { log.warn?.('[casey] seed subject failed', { error: e.message }) }
      }
      await store.appendEvent(caseRow.id, { kind: 'note', actor: 'system', text: `Case opened from ${channel}` })
    }

    if (!autoRespond) return { to: msg.from, text: '', platform, caseId: caseRow.id }

    const fresh = await store.getCase(caseRow.id)

    // observe-mode: the agent does not act or reply automatically; a human
    // drives the case. We still recorded the inbound above.
    if (fresh.autonomy === 'observe') {
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'autonomy=observe: awaiting operator (no auto-reply)' })
      return { to: msg.from, text: '', platform, caseId: fresh.id, observed: true }
    }

    // Deterministic intent shortcuts. For a few universal intents a low-literacy
    // contact is likely to send, a fixed, correct reply beats a generated one --
    // so we answer without an LLM turn. This runs only when auto-responding and
    // not in observe mode (handled above). Empty/media messages normalize to no
    // intent and fall through to the agent turn unchanged.
    const isFirstMessage = (await store.listEvents(fresh.id)).filter(e => e.kind === 'inbound').length <= 1
    const optedOut = (fresh.tags || '').split(',').map(s => s.trim()).includes('opted-out')
    let intent = detectContactIntent(inboundText)
    // A brand-new contact whose very first word is "help"/"?" still deserves the
    // warm greeting+reference from the agent, not a bare menu -- so on the first
    // message we let the agent handle 'help' (but still honor human/status/stop).
    if (intent === 'help' && isFirstMessage) intent = null
    // Respect a prior opt-out: once someone said STOP, do not auto-reply again
    // unless they explicitly ask for help or a human.
    if (optedOut && intent !== 'help' && intent !== 'human') {
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'contact previously opted out; no auto-reply' })
      return { to: msg.from, text: '', platform, caseId: fresh.id, optedOut: true }
    }
    if (intent) {
      if (intent === 'human') {
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'HANDOFF REQUESTED: contact asked for a human. Needs an operator.' })
        try {
          const patch = { tags: mergeTag(fresh.tags, 'needs-human') }
          if (fresh.priority === 'low' || fresh.priority === 'normal') patch.priority = 'high'
          await store.updateCase(fresh.id, patch)
        } catch (e) { log.warn?.('[casey] handoff flag failed', { caseId: fresh.id, error: e.message }) }
      } else if (intent === 'stop') {
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'OPT-OUT: contact asked to stop messaging.' })
        try { await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'opted-out') }) }
        catch (e) { log.warn?.('[casey] opt-out flag failed', { caseId: fresh.id, error: e.message }) }
      }
      const text = intentReply(intent, fresh)
      await store.appendEvent(fresh.id, {
        kind: 'outbound', actor: 'system', channel,
        text, data: { to: msg.from, intent, deterministic: true },
      })
      const reply = { to: msg.from, text, platform, caseId: fresh.id, intent }
      if (adapter?.send) {
        try { await adapter.send(reply) }
        catch (e) {
          log.error?.('[casey] adapter.send failed', { caseId: fresh.id, platform, error: e.message })
          await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `send failed on ${channel}: ${e.message}` })
        }
      }
      return reply
    }

    const contact = fresh.contact_id ? await store.getContact(fresh.contact_id).catch(() => null) : null
    const events = await store.listEvents(fresh.id)
    const prompt = inboundText || (media ? `The contact sent ${media} with no text. Acknowledge and ask how you can help.` : 'The contact sent an empty message. Acknowledge politely.')

    let result, errored = false
    try {
      result = await runTurn({
        prompt,
        messages: [{ role: 'system', content: caseSystemPrompt(fresh, events, contact) }],
        sessionKey: `case:${fresh.id}`,
        callLLM,
        enabledToolsets: ['cases', 'core'],
      })
    } catch (e) {
      errored = true
      log.error?.('[casey] agent turn failed', { caseId: fresh.id, error: e.message })
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `agent turn error: ${e.message}` })
      result = {}
    }

    // Never send a raw error string or an empty message to the contact. On
    // error/empty, send a safe fallback and keep the case recoverable.
    let text = (result?.result || '').toString().trim()
    if (!text) {
      if (!errored && result?.error) {
        log.warn?.('[casey] agent returned error result', { caseId: fresh.id, error: result.error })
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `agent result error: ${result.error}` })
      }
      text = FALLBACK_REPLY
    }

    await store.appendEvent(fresh.id, {
      kind: 'outbound', actor: 'agent', channel,
      text, data: { to: msg.from, fallback: text === FALLBACK_REPLY },
    })

    const reply = { to: msg.from, text, platform, caseId: fresh.id }
    if (adapter?.send) {
      try { await adapter.send(reply) }
      catch (e) {
        log.error?.('[casey] adapter.send failed', { caseId: fresh.id, platform, error: e.message })
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `send failed on ${channel}: ${e.message}` })
      }
    }
    return reply
  }
}

// The conversation identity: prefer an explicit chat/channel id from the raw
// payload (Discord channel id, WhatsApp chat), else the sender.
function conversationKey(msg) {
  return msg.raw?.channel_id || msg.raw?.chatId || msg.chatId || msg.from || 'unknown'
}

// Platform message id for dedup: Discord/WhatsApp put it on raw.id; fall back to
// an explicit msg.id.
function messageId(msg) {
  return msg.raw?.id || msg.id || ''
}

// Short description of any non-text content so media-only messages are not lost.
function describeMedia(msg) {
  const r = msg.raw || {}
  if (Array.isArray(r.attachments) && r.attachments.length) return `${r.attachments.length} attachment(s)`
  if (r.type && r.type !== 'text') return `a ${r.type} message`
  if (r.image) return 'an image'
  if (r.audio) return 'an audio message'
  if (r.sticker_items) return 'a sticker'
  return ''
}

function truncate(s, n) { s = s || ''; return s.length > n ? s.slice(0, n - 1) + '...' : s }

// --- Contact intent detection ------------------------------------------------
//
// Low-literacy / multilingual contacts often send one word, an emoji, or a
// phrase in their own language. Before spending an LLM turn we check for a few
// universal intents and answer deterministically where a fixed, correct reply
// beats a generated one. Matching is forgiving: lowercased, accent-stripped,
// substring/keyword across several widely-spoken languages.
//
// Returns 'help' | 'status' | 'human' | 'stop' | null. Order matters: STOP and
// HUMAN win over STATUS/HELP when more than one could match.
export function detectContactIntent(text) {
  const t = normalizeIntentText(text)
  if (!t) return null
  const has = (words) => words.some(w => t === w || t.includes(w))

  if (has([
    'stop', 'unsubscribe', 'cancel', 'quit', 'leave me alone', 'go away',
    'no more', 'remove me', 'opt out', 'optout',
    'basta', 'alto', 'pare', 'parar', 'detener',           // es/pt/it
    'arret', 'arreter', 'stopp', 'aufhoren', 'halt',        // fr/de
  ])) return 'stop'

  if (has([
    'human', 'person', 'someone', 'somebody', 'real person', 'operator',
    'representative', 'staff', 'manager', 'speak to', 'talk to', 'call me',
    'real human', 'agent',
    'humano', 'persona', 'agente', 'alguien', 'pessoa', 'atendente',  // es/pt
    'humain', 'personne', 'quelqu', 'mensch', 'jemand',     // fr/de
  ])) return 'human'

  if (has([
    'status', 'update', 'progress', 'how long', 'any news', 'news', 'eta',
    'whats happening', 'what is happening', 'still waiting',
    'estado', 'estatus', 'actualizacion', 'novidade',       // es/pt
    'statut', 'nouvelle', 'stand',                          // fr/de
  ])) return 'status'

  if (has([
    'help', 'menu', 'options', 'what can', 'how do', 'confused', 'lost',
    'dont understand', 'huh', '?',
    'ayuda', 'auxilio', 'socorro',                          // es/pt
    'aide', 'aidez', 'hilfe',                               // fr/de
  ])) return 'help'

  return null
}

// Lowercase, strip diacritics/emoji/punctuation (keep '?' as a help signal),
// collapse whitespace, so "AYUDAME!!", "ayudame" and "  Ayuda  " all match.
function normalizeIntentText(text) {
  return (text || '')
    .toString()
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9?\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Add a tag to a comma-separated tag string without duplicating it.
export function mergeTag(tags, tag) {
  const list = (tags || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!list.includes(tag)) list.push(tag)
  return list.join(',')
}

// Plain-language, contact-safe description of where a request stands. Never
// exposes the internal stage name.
function plainStatus(status) {
  return ({
    new:         'We have it and will look at it very soon.',
    triaging:    'We are reviewing it now.',
    in_progress: 'Someone is working on it.',
    waiting:     'We are waiting on something to continue.',
    resolved:    'It is sorted. Tell us if anything is still wrong.',
    closed:      'It is finished. Reply if you need more help.',
  })[status] || 'We are looking into it.'
}

// Build a clear, deterministic reply for a recognized intent. Every reply names
// the reference so a low-literacy contact always has a handle on their request.
export function intentReply(intent, caseRow) {
  const ref = caseRow?.ref ? ` Your reference is ${caseRow.ref}.` : ''
  if (intent === 'help') {
    return `Hi! Reply with a word: STATUS to check progress, HUMAN to talk to a person, or STOP to stop messages. Or just tell us what you need.${ref}`
  }
  if (intent === 'status') {
    return `${plainStatus(caseRow.status)} Reply HUMAN any time to talk to a person.${ref}`
  }
  if (intent === 'stop') {
    return `Okay, we will stop messaging you. Reply HELP any time if you change your mind.${ref}`
  }
  if (intent === 'human') {
    return `No problem. I am asking a real person to help you now. They will reply here as soon as they can.${ref}`
  }
  return ''
}
