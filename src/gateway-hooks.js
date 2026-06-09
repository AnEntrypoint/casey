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
    `6. MIRROR THEIR EFFORT: if they wrote one word or an emoji, keep your reply to`,
    `   one or two short lines. Do not flood a worried person with text.`,
    `7. NO PROMISES YOU CANNOT KEEP: never give a specific time, date, or guaranteed`,
    `   outcome. Say a real person will follow up, not "by tomorrow" or "it is fixed".`,
    `8. ONE NEXT STEP: if you need something from them, ask for exactly one thing,`,
    `   in the simplest words (for example a name, an address, or a photo).`,
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

// Holding message in the contact's own language, for the worst-case path: the
// LLM turn errored, timed out, or returned nothing. A low-literacy contact who
// wrote in Spanish must NOT get an English wall of text back (P9 worst-case +
// P12 human value) -- the degraded reply mirrors their language too. Keyed by a
// lightweight cue detector over the languages casey already claims to support;
// when no cue matches we keep the plain-English default. `ref` is appended when
// known so even the fallback hands the contact their reference number.
const FALLBACK_BY_LANG = {
  es: 'Gracias por su mensaje. Ya lo tenemos guardado y una persona le va a ayudar pronto.',
  pt: 'Obrigado pela sua mensagem. Ja a registamos e uma pessoa vai ajuda-lo em breve.',
  fr: 'Merci pour votre message. Nous l avons bien recu et une personne va vous aider bientot.',
  af: 'Dankie vir u boodskap. Ons het dit ontvang en iemand sal u binnekort help.',
  zu: 'Siyabonga ngomlayezo wakho. Siwutholile futhi umuntu uzokusiza maduze.',
  ar: 'شكرا لرسالتك. لقد استلمناها وسيساعدك شخص ما قريبا.',
  hi: 'आपके संदेश के लिए धन्यवाद। हमने इसे दर्ज कर लिया है और जल्द ही कोई व्यक्ति आपकी मदद करेगा।',
}

// Cheap, accent-stripped cue match. A wrong guess that flips a contact's language
// is worse than defaulting to English (P6: make the wrong outcome hard), so cues
// are DISTINCTIVE -- tokens that one language uses and its neighbours do not. We
// score every language by how many of its distinctive cues appear and pick the
// clear winner; ties or no hits fall back to English. Shared tokens (pedido,
// por favor, ola/hola) are deliberately excluded because they collide es<->pt.
const LANG_CUES = {
  es: [' gracias ', ' necesito ', ' ayuda ', ' usted ', ' senor ', ' donde ', ' cuando ', ' mi pedido ', ' esta ', ' pero '],
  pt: [' obrigado ', ' preciso ', ' ajuda ', ' voce ', ' onde ', ' quando ', ' meu pedido ', ' nao ', ' esta a '],
  fr: [' bonjour ', ' merci ', ' commande ', ' aide ', ' besoin ', ' vous ', ' ou est ', ' je ', ' mais '],
  af: [' dankie ', ' asseblief ', ' hallo ', ' goeie ', ' bestelling ', ' het nie ', ' gekom ', ' ek '],
  zu: [' sawubona ', ' ngiyabonga ', ' usizo ', ' siza ', ' yami ', ' ngicela '],
}

function guessLang(text) {
  const t = ` ${normalizeIntentText(text)} `
  if (!t.trim()) return 'en'
  if (/[؀-ۿ]/.test(text || '')) return 'ar'
  if (/[ऀ-ॿ]/.test(text || '')) return 'hi'
  let best = 'en', bestScore = 0, tie = false
  for (const [lang, cues] of Object.entries(LANG_CUES)) {
    const score = cues.reduce((n, c) => n + (t.includes(c) ? 1 : 0), 0)
    if (score > bestScore) { best = lang; bestScore = score; tie = false }
    else if (score === bestScore && score > 0) tie = true
  }
  // A genuine tie between two non-English languages is ambiguous -> English is
  // the safe default (it never claims to speak a language it might have wrong).
  return tie ? 'en' : best
}

export function fallbackReply(contactText, caseRow) {
  const lang = guessLang(contactText)
  const base = FALLBACK_BY_LANG[lang] || FALLBACK_REPLY
  const ref = caseRow?.ref
  if (!ref) return base
  // Localised "your reference is X" tail, kept short.
  const tail = {
    es: ` Su referencia es ${ref}.`, pt: ` A sua referencia e ${ref}.`,
    fr: ` Votre reference est ${ref}.`, af: ` U verwysing is ${ref}.`,
    zu: ` Inombolo yakho yereferensi ngu-${ref}.`,
    ar: ` رقمك المرجعي هو ${ref}.`, hi: ` आपका संदर्भ नंबर ${ref} है।`,
  }[lang] || ` Your reference is ${ref}.`
  return base + tail
}

export function makeCaseHandler(store, { callLLM = null, autoRespond = true, log = console, notifyHandoff = null } = {}) {
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

    // Dedup: a redelivered platform message (webhook retry, gateway replay, or
    // the same message duplicated in one tick) is recorded and answered exactly
    // once. recordInbound runs on the per-conversation lock so the dedup check
    // and the append are atomic -- duplicates are structurally unrepresentable,
    // not merely improbable.
    const inboundText = (msg.text || '').trim()
    const media = describeMedia(msg)
    const inboundEvent = await store.recordInbound(caseRow, {
      channel,
      text: inboundText || (media ? `[${media}]` : '[empty message]'),
      data: { from: msg.from, raw: msg.raw }, msg_id: msgId,
    })
    if (!inboundEvent) {
      log.info?.('[casey] duplicate inbound dropped', { caseId: caseRow.id, msgId })
      return { to: msg.from, text: '', platform, caseId: caseRow.id, duplicate: true }
    }
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
    // On a brand-new contact, greeting/help deserve the agent's warm intro +
    // reference, not a canned line -- so defer them to the agent on message one.
    // (status/human/stop/thanks still answered deterministically.)
    if (['help', 'greeting'].includes(intent) && isFirstMessage) intent = null
    // Respect a prior opt-out: once someone said STOP, do not auto-reply again
    // unless they explicitly ask for help or a human.
    if (optedOut && intent !== 'help' && intent !== 'human') {
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'contact previously opted out; no auto-reply' })
      return { to: msg.from, text: '', platform, caseId: fresh.id, optedOut: true }
    }
    if (intent) {
      if (intent === 'human') {
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'HANDOFF REQUESTED: contact asked for a human. Needs an operator.' })
        // detectContactIntent returns 'human' for EVERY message with a human
        // keyword, so the notify must fire only on the FIRST handoff for this
        // case -- otherwise a contact repeating "person?" re-pings every time.
        // mergeTag is idempotent; the notify is not.
        const alreadyFlagged = (fresh.tags || '').split(',').map(s => s.trim()).includes('needs-human')
        try {
          const patch = { tags: mergeTag(fresh.tags, 'needs-human') }
          if (fresh.priority === 'low' || fresh.priority === 'normal') patch.priority = 'high'
          await store.updateCase(fresh.id, patch)
          if (notifyHandoff && !alreadyFlagged) {
            try { await notifyHandoff({ case: fresh, channel, from: msg.from }) }
            catch (e) { log.warn?.('[casey] handoff notify failed', { caseId: fresh.id, error: e.message }) }
          }
        } catch (e) { log.warn?.('[casey] handoff flag failed', { caseId: fresh.id, error: e.message }) }
      } else if (intent === 'stop') {
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'OPT-OUT: contact asked to stop messaging.' })
        try { await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'opted-out') }) }
        catch (e) { log.warn?.('[casey] opt-out flag failed', { caseId: fresh.id, error: e.message }) }
      }
      const text = intentReply(intent, fresh, guessLang(inboundText))
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
        // freddie's runTurn defaults to 30s, which is too tight for a COLD first
        // turn (host boot + first provider probe) against the real bridge -- the
        // crucible run timed out there and the contact got a degraded reply. The
        // lead providers answer in well under a second once warm, so this bound
        // protects the cold start without abandoning a live contact for minutes.
        // CASEY_LLM_TURN_TIMEOUT_MS overrides for slow links / dead-provider walks.
        timeoutMs: Number(process.env.CASEY_LLM_TURN_TIMEOUT_MS) || 120000,
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
      text = fallbackReply(inboundText, fresh)
    }
    const isFallback = !((result?.result || '').toString().trim())

    await store.appendEvent(fresh.id, {
      kind: 'outbound', actor: 'agent', channel,
      text, data: { to: msg.from, fallback: isFallback },
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
  const words = t.split(' ')
  const wordSet = new Set(words)
  const padded = ` ${t} `

  // Forgiving match for the READ-ONLY intents (status/help/thanks/greeting):
  // a whole-word/phrase hit, OR a key that appears as a substring of a token so
  // inflected forms still match ("ayuda" inside "ayudame", "thank" inside
  // "thanks"). Safe here because these intents never mutate the case; the
  // irreversible STOP/HUMAN use the strict negation-guarded matcher below.
  // Very short keys (<=3 chars: "ty", "yo", "hi", "?") match as whole tokens
  // only, so they do not fire inside unrelated words ("ty" in "party"). Longer
  // single-word keys also match as a substring of a token to catch inflections.
  const hit = (keys) => keys.some(k =>
    k.includes(' ') ? padded.includes(` ${k} `)
      : k.length <= 3 ? wordSet.has(k)
      : (wordSet.has(k) || words.some(w => w.includes(k))))

  // A negator immediately before a key blanks that key, so "dont stop",
  // "no human", "not now" cannot trip the irreversible intents.
  const NEGATORS = new Set(['no', 'not', 'dont', 'never', 'nao', 'nicht', 'pas', 'cha'])
  const guarded = new Set()
  for (let i = 1; i < words.length; i++) if (NEGATORS.has(words[i - 1])) guarded.add(i)
  const liveWords = new Set(words.filter((_, i) => !guarded.has(i)))
  const live = (keys) => keys.some(k =>
    k.includes(' ') ? padded.includes(` ${k} `) : liveWords.has(k))

  // STOP / HUMAN drive irreversible actions (opt-out, handoff): negation-guarded,
  // and blocked by explicit exclude phrases ("no problem", "in person").
  if (live(STOP_KEYS)  && !STOP_EXCLUDE.some(p => padded.includes(` ${p} `)))  return 'stop'
  if (live(HUMAN_KEYS) && !HUMAN_EXCLUDE.some(p => padded.includes(` ${p} `))) return 'human'

  // STATUS / HELP are read-only replies, so the plain matcher is fine.
  if (hit(STATUS_KEYS)) return 'status'
  // A run of '?' ("?", "???", "????") from a confused contact is a help signal;
  // normalize collapses it to a single '?' token (see normalizeIntentText).
  if (hit(HELP_KEYS)) return 'help'

  // Short, content-free social turns get a warm canned nudge instead of an LLM
  // turn -- but ONLY greeting and thanks. We deliberately do NOT classify
  // yes/no or bare numbers: those are almost always answers to a question the
  // agent just asked, so they must fall through to the agent with full context.
  if (words.length <= 3) {
    if (hit(THANKS_KEYS))   return 'thanks'
    if (hit(GREETING_KEYS)) return 'greeting'
  }

  return null
}

// Keyword tables. Single-word keys match as whole tokens; multi-word keys as
// space-bounded phrases. Accent-stripped, lowercase (see normalizeIntentText).
// Languages: en, es, pt, it, fr, de, zu (Zulu), xh (Xhosa), ar (transliterated),
// hi (transliterated).
const STOP_KEYS = [
  'stop', 'unsubscribe', 'cancel', 'quit', 'leave me alone', 'go away',
  'no more', 'remove me', 'opt out', 'optout', 'enough',
  'basta', 'alto', 'pare', 'parar', 'detener', 'dejar',
  'arret', 'arreter', 'stopp', 'aufhoren', 'halt',
  'yeka', 'misa', 'hambani',
  'khalas', 'tawaqaf', 'kafi',
  'bas', 'band karo', 'mat bhejo',
]
const STOP_EXCLUDE = [
  'no stop', 'dont stop', 'do not stop', 'please dont stop', 'never stop',
  'bus stop',
]

const HUMAN_KEYS = [
  'human', 'person', 'someone', 'somebody', 'real person', 'operator',
  'representative', 'staff', 'manager', 'speak to', 'talk to', 'call me',
  'real human', 'agent',
  'humano', 'persona', 'agente', 'alguien', 'pessoa', 'atendente',
  'humain', 'personne', 'quelqu', 'mensch', 'jemand',
  'umuntu', 'umsebenzi',
  'insan', 'shakhs', 'muwazzaf',
  'insaan', 'aadmi', 'vyakti',
]
const HUMAN_EXCLUDE = [
  'a person told me', 'person told me', 'someone told me', 'another person',
  'in person', 'no person', 'wrong person',
]

const STATUS_KEYS = [
  'status', 'update', 'progress', 'how long', 'any news', 'news', 'eta',
  'whats happening', 'what is happening', 'still waiting', 'where is',
  'estado', 'estatus', 'actualizacion', 'novidade',
  'statut', 'nouvelle', 'stand',
  'isimo', 'kuphi',
  'halat', 'wein', 'akhbar',
  'sthiti', 'kahan', 'kya hua',
]

const HELP_KEYS = [
  'help', 'menu', 'options', 'what can', 'how do', 'confused', 'lost',
  'dont understand', 'do not understand', 'huh', '?',
  'ayuda', 'auxilio', 'socorro', 'ajuda',
  'aide', 'aidez', 'hilfe',
  'usizo', 'ncedo',
  'musaada', 'madad',
]

const THANKS_KEYS = [
  'thanks', 'thank you', 'thank', 'thx', 'ty', 'cheers', 'appreciate',
  'gracias', 'obrigado', 'obrigada', 'merci', 'danke', 'grazie',
  'ngiyabonga', 'enkosi',
  'shukran', 'dhanyavad', 'shukriya',
]

const GREETING_KEYS = [
  'hi', 'hello', 'hey', 'hallo', 'hiya', 'yo', 'good morning',
  'good afternoon', 'good evening', 'greetings',
  'hola', 'ola', 'bonjour', 'salut', 'guten tag', 'ciao',
  'sawubona', 'molo', 'salam', 'salaam', 'namaste', 'namaskar',
]

// Lowercase, strip diacritics/emoji/punctuation, COLLAPSE any run of '?' to a
// single '?' token (so "???" is a help signal, not an unmatchable "???" token),
// collapse whitespace.
function normalizeIntentText(text) {
  return (text || '')
    .toString()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9?\s]/g, ' ')
    .replace(/\?+/g, ' ? ')
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
const STATUS_STRINGS = {
  en: {
    new: 'We have it and will look at it very soon.', triaging: 'We are looking at it right now.',
    in_progress: 'Someone is working on it for you now.',
    waiting: 'We have started, and we are waiting on one step before we finish. We will keep you posted.',
    resolved: 'It is sorted. If anything is still not right, just tell us.',
    closed: 'It is all finished. Reply any time if you need more help.',
    _: 'We are looking into it for you.',
  },
  es: {
    new: 'Lo tenemos y lo revisaremos muy pronto.', triaging: 'Lo estamos revisando ahora mismo.',
    in_progress: 'Alguien lo esta atendiendo para usted ahora.',
    waiting: 'Ya empezamos y estamos esperando un paso antes de terminar. Le mantendremos al tanto.',
    resolved: 'Esta resuelto. Si algo aun no esta bien, solo diganos.',
    closed: 'Ya esta todo terminado. Responda cuando quiera si necesita mas ayuda.',
    _: 'Lo estamos revisando para usted.',
  },
  pt: {
    new: 'Ja temos e vamos ver muito em breve.', triaging: 'Estamos a ver agora mesmo.',
    in_progress: 'Alguem esta a tratar disso para si agora.',
    waiting: 'Ja comecamos e estamos a aguardar um passo antes de terminar. Manteremos voce informado.',
    resolved: 'Esta resolvido. Se algo ainda nao estiver bem, e so dizer.',
    closed: 'Esta tudo terminado. Responda quando quiser se precisar de mais ajuda.',
    _: 'Estamos a ver isso para si.',
  },
  fr: {
    new: 'Nous l avons et nous allons l examiner tres bientot.', triaging: 'Nous l examinons en ce moment.',
    in_progress: 'Quelqu un s en occupe pour vous maintenant.',
    waiting: 'Nous avons commence et nous attendons une etape avant de terminer. Nous vous tiendrons au courant.',
    resolved: 'C est regle. Si quelque chose ne va toujours pas, dites-le-nous.',
    closed: 'Tout est termine. Repondez a tout moment si vous avez besoin d aide.',
    _: 'Nous examinons cela pour vous.',
  },
  af: {
    new: 'Ons het dit en sal baie gou daarna kyk.', triaging: 'Ons kyk nou daarna.',
    in_progress: 'Iemand werk nou daaraan vir u.',
    waiting: 'Ons het begin en wag op een stap voordat ons klaarmaak. Ons sal u op hoogte hou.',
    resolved: 'Dit is reggemaak. As iets steeds verkeerd is, se net vir ons.',
    closed: 'Alles is klaar. Antwoord enige tyd as u meer hulp nodig het.',
    _: 'Ons kyk daarna vir u.',
  },
}

function plainStatus(status, lang = 'en') {
  const S = STATUS_STRINGS[lang] || STATUS_STRINGS.en
  return S[status] || S._
}

// Proactive, contact-safe note sent when a request MOVES to a new stage on an
// OPERATOR's action. Warm, no jargon, no dashes-as-punctuation (reads as a bot).
// Internal stages (new, triaging) and closed return '' and are not sent:
//   - new/triaging are internal review steps the contact need not hear about.
//   - closed is silent because `resolved` already told them it is done; an
//     operator moving resolved->closed seconds later would otherwise double-send.
export function stageNote(status) {
  return ({
    in_progress: 'Good news. Someone is working on your request now.',
    waiting:     'A quick update: your request is in progress and we are waiting on one step. We will be in touch.',
    resolved:    'Good news. Your request is sorted. If anything is still not right, just reply here.',
  })[status] || ''
}

// Build a CaseStore onTransition hook that sends the contact a proactive,
// plain-language note when an OPERATOR moves their request to a stage worth
// announcing. Reuses the dashboard's sendReply(caseRow, text) adapter.
//
// Guards (all must pass to send):
//   - agent transitions  -- skipped; the agent already replies to the contact
//                           in its own warm, contextual message (no double-send).
//   - opted-out tag      -- the contact said STOP; stay silent.
//   - stageNote empty    -- nothing worth announcing for this stage.
//   - dedup              -- skip if the most recent outbound is this exact note.
// "Only on real stage change" is guaranteed by transition() skipping no-ops.
export function makeTransitionNotifier(store, sendReply, { log = console } = {}) {
  if (!sendReply) return null
  return async function onTransition({ caseRow, to, user }) {
    // Only operator-driven moves notify. Agent self-transitions during a turn
    // would otherwise send a canned note ON TOP of the agent's own reply.
    if (user?.role === 'agent') return
    const tags = (caseRow.tags || '').split(',').map(s => s.trim())
    if (tags.includes('opted-out')) return
    const text = stageNote(to)
    if (!text) return
    try {
      const recent = await store.listEventsPage(caseRow.id, { limit: 8, offset: 0 })
      const lastOut = recent.find(e => e.kind === 'outbound')
      if (lastOut && (lastOut.text || '').trim() === text) return
    } catch (e) { log.warn?.('[casey] transition-note dedup check failed', { caseId: caseRow.id, error: e.message }) }
    try {
      await sendReply(caseRow, text)
      await store.appendEvent(caseRow.id, {
        kind: 'outbound', actor: 'system', channel: caseRow.channel,
        text, data: { to: caseRow.external_id, proactive: 'stage-note', stage: to },
      })
    } catch (e) {
      log.error?.('[casey] transition note send failed', { caseId: caseRow.id, error: e.message })
      await store.appendEvent(caseRow.id, { kind: 'observation', actor: 'system', text: `proactive note send failed: ${e.message}` })
    }
  }
}

// Build a clear, deterministic reply for a recognized intent. Every reply names
// the reference so a low-literacy contact always has a handle on their request.
// Deterministic intent replies, localised. A low-literacy contact who wrote
// "gracias" must get a Spanish acknowledgement, not an English one mid-Spanish
// conversation (P12 human value) -- so these mirror the contact's language just
// as the LLM path does. `lang` comes from guessLang(inboundText) at the call
// site; unknown languages fall through to English. status is composed from the
// localised plainStatus so the whole reply stays in one language.
const INTENT_STRINGS = {
  en: {
    help: 'We are here to help. Reply STATUS to check progress, HUMAN for a real person, or STOP to end messages. Or just tell us what you need.',
    stop: 'Okay, we will not message you again. Reply HELP any time if you change your mind.',
    human: 'Of course. We are asking a real person to help you now. They will reply right here as soon as they can.',
    thanks: "You're welcome, take care.",
    greeting: 'Hello! Good to hear from you. How can we help today?',
    statusTail: ' Reply HUMAN any time to talk to a person.', refLabel: (r) => ` Your reference is ${r}.`,
  },
  es: {
    help: 'Estamos aqui para ayudar. Responda ESTADO para ver el progreso, PERSONA para hablar con alguien, o PARAR para no recibir mas mensajes. O solo diganos que necesita.',
    stop: 'De acuerdo, no le enviaremos mas mensajes. Responda AYUDA cuando quiera si cambia de idea.',
    human: 'Por supuesto. Le estamos pidiendo a una persona real que le ayude ahora. Le responderan aqui mismo lo antes posible.',
    thanks: 'De nada, cuidese.',
    greeting: 'Hola! Que bueno saber de usted. Como podemos ayudarle hoy?',
    statusTail: ' Responda PERSONA cuando quiera para hablar con alguien.', refLabel: (r) => ` Su referencia es ${r}.`,
  },
  pt: {
    help: 'Estamos aqui para ajudar. Responda ESTADO para ver o progresso, PESSOA para falar com alguem, ou PARAR para nao receber mais mensagens. Ou apenas diga o que precisa.',
    stop: 'Tudo bem, nao enviaremos mais mensagens. Responda AJUDA quando quiser se mudar de ideia.',
    human: 'Claro. Estamos a pedir a uma pessoa real para o ajudar agora. Vao responder-lhe aqui mesmo assim que puderem.',
    thanks: 'De nada, cuide-se.',
    greeting: 'Ola! Que bom ter noticias suas. Como podemos ajudar hoje?',
    statusTail: ' Responda PESSOA quando quiser para falar com alguem.', refLabel: (r) => ` A sua referencia e ${r}.`,
  },
  fr: {
    help: 'Nous sommes la pour aider. Repondez STATUT pour voir l avancement, PERSONNE pour parler a quelqu un, ou STOP pour ne plus recevoir de messages. Ou dites-nous simplement ce qu il vous faut.',
    stop: 'D accord, nous ne vous enverrons plus de messages. Repondez AIDE a tout moment si vous changez d avis.',
    human: 'Bien sur. Nous demandons a une vraie personne de vous aider maintenant. Elle vous repondra ici des que possible.',
    thanks: 'Je vous en prie, prenez soin de vous.',
    greeting: 'Bonjour ! Content d avoir de vos nouvelles. Comment pouvons-nous vous aider aujourd hui ?',
    statusTail: ' Repondez PERSONNE a tout moment pour parler a quelqu un.', refLabel: (r) => ` Votre reference est ${r}.`,
  },
  af: {
    help: 'Ons is hier om te help. Antwoord STATUS vir vordering, MENS vir n regte persoon, of STOP om nie meer boodskappe te kry nie. Of se net vir ons wat u nodig het.',
    stop: 'Goed, ons sal u nie weer boodskap nie. Antwoord HELP enige tyd as u van plan verander.',
    human: 'Natuurlik. Ons vra nou n regte persoon om u te help. Hulle sal hier antwoord sodra hulle kan.',
    thanks: 'Plesier, sterkte.',
    greeting: 'Hallo! Lekker om van u te hoor. Hoe kan ons vandag help?',
    statusTail: ' Antwoord MENS enige tyd om met n persoon te praat.', refLabel: (r) => ` U verwysing is ${r}.`,
  },
}

export function intentReply(intent, caseRow, lang = 'en') {
  const L = INTENT_STRINGS[lang] || INTENT_STRINGS.en
  const ref = caseRow?.ref ? L.refLabel(caseRow.ref) : ''
  if (intent === 'status') return `${plainStatus(caseRow.status, lang)}${L.statusTail}${ref}`
  const body = L[intent]
  return body ? `${body}${ref}` : ''
}

// Posts a one-line operator alert to a Discord webhook. Returns null if no URL is
// configured, so handoff flagging works with or without Discord wired up.
// allowed_mentions.parse:[] blocks a contact injecting @everyone via the subject.
export function discordHandoffNotifier(webhookUrl = process.env.CASEY_HANDOFF_WEBHOOK) {
  if (!webhookUrl) return null
  return async ({ case: c, channel, from }) => {
    const content = `A person is needed - case ${c.ref} on ${channel} (${from})`
      + (c.subject ? ` - ${c.subject}` : '')
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    })
  }
}
