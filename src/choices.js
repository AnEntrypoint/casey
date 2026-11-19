import crypto from 'node:crypto'
import { vocabWord } from './config-loader.js'
import { caseyText } from './deployment-text.js';

export const KIND_BUTTONS = 'buttons'
export const KIND_LIST = 'list'
export const MODE_TEXT = 'text'
export const BUTTONS_MAX = 3
export const BUTTON_TITLE_MAX = 20
export const LIST_MAX = 10
export const ROW_TITLE_MAX = 24
export const ROW_DESCRIPTION_MAX = 72
export const LIST_BUTTON_MAX = 20
export const INTERACTIVE_BODY_MAX = 1024
export const CHOICE_TTL_MS = 10 * 60e3
const REMEMBER_CAP = 40
const ID_MAX = 200
const MEANING_MAX = 400

export function choiceLabel(key) {
  const word = vocabWord(`choice.${key}`)
  if (!word) throw new Error(`vocabulary.yml has no choice.${key}: add it under the choice section`)
  return word
}

const oneLine = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

export function fitChoices(offer) {
  const list = Array.isArray(offer?.choices) ? offer.choices : []
  if (!list.length) return null
  const seen = new Set()
  const items = list.map((c) => {
    const id = oneLine(c?.id, ID_MAX)
    const title = oneLine(c?.title, 200)
    if (!id || !title) throw new Error('choices: every choice needs an id and a title')
    if (seen.has(id)) throw new Error(`choices: duplicate choice id ${id}`)
    seen.add(id)
    return { id, title, description: oneLine(c.description, 200), meaning: oneLine(c.meaning || title, MEANING_MAX) }
  })
  if (items.length > LIST_MAX) return { mode: MODE_TEXT, items }
  const asButtons = offer.kind === KIND_BUTTONS && items.length <= BUTTONS_MAX
  const titleMax = asButtons ? BUTTON_TITLE_MAX : ROW_TITLE_MAX
  return {
    mode: asButtons ? KIND_BUTTONS : KIND_LIST,
    items: items.map(i => ({
      ...i,
      title: i.title.slice(0, titleMax),
      description: asButtons ? '' : i.description.slice(0, ROW_DESCRIPTION_MAX),
    })),
  }
}

const numbered = (items, withDescriptions) => items
  .map((i, n) => `${n + 1}. ${i.title}${withDescriptions && i.description ? ` - ${i.description}` : ''}`)
  .join('\n')

export function appendFallback(text, fit) {
  const withDescriptions = numbered(fit.items, true)
  const tooLong = fit.mode !== MODE_TEXT && `${text}\n\n${withDescriptions}`.length > INTERACTIVE_BODY_MAX
  const fallback = tooLong ? numbered(fit.items, false) : withDescriptions
  return { text: `${text}\n\n${fallback}`, fallback }
}

export function stampChoices(fit) {
  const set = crypto.randomBytes(3).toString('hex')
  return { ...fit, items: fit.items.map(i => ({ ...i, id: `${set}:${i.id}`.slice(0, ID_MAX) })) }
}

export async function rememberChoices(store, contactId, fit, now = Date.now()) {
  if (!contactId || fit.mode === MODE_TEXT) return
  const set = fit.items[0].id.split(':')[0]
  await store.mutateStaffState(contactId, (st) => {
    const live = Object.entries(st.choices || {}).filter(([, v]) => now - v.at <= CHOICE_TTL_MS)
    for (const i of fit.items) live.push([i.id, { title: i.title, meaning: i.meaning, at: now, set }])
    live.sort((a, b) => b[1].at - a[1].at)
    st.choices = Object.fromEntries(live.slice(0, REMEMBER_CAP))
  })
}

export function tappedChoice(msg) {
  const interactive = msg?.raw?.interactive
  const reply = interactive?.button_reply || interactive?.list_reply
  return reply && typeof reply.id === 'string' ? { id: reply.id, title: oneLine(reply.title, 60) } : null
}

const TAP_EXPIRED = caseyText("src/choices.js#w0")
const TAP_USED = (t) => caseyText("src/choices.js#w1", [t])
const TAP_FRESH = (t, meaning) => caseyText("src/choices.js#w2", [t, meaning])

export async function tapNote(store, contactId, msg, now = Date.now()) {
  const tap = tappedChoice(msg)
  if (!tap) return ''
  const msgId = String(msg.raw?.id || msg.id || '')
  const verdict = contactId
    ? await store.mutateStaffState(contactId, (st) => {
      const entry = st.choices?.[tap.id]
      if (!entry || now - entry.at > CHOICE_TTL_MS) return { state: 'expired' }
      if (entry.used && entry.used !== msgId) return { state: 'used' }
      for (const v of Object.values(st.choices)) if (v.set === entry.set) v.used = msgId
      return { state: 'fresh', meaning: entry.meaning }
    })
    : { state: 'expired' }
  const body = verdict.state === 'fresh' ? TAP_FRESH(tap.title, verdict.meaning)
    : verdict.state === 'used' ? TAP_USED(tap.title) : TAP_EXPIRED
  return caseyText("src/choices.js#w3", [body])
}

export function confirmRecordChoices(ref) {
  return {
    kind: KIND_BUTTONS,
    choices: [
      { id: `yes:${ref}`, title: choiceLabel('answer_yes'), meaning: caseyText("src/choices.js#w4", [ref, ref]) },
      { id: `no:${ref}`, title: choiceLabel('answer_no'), meaning: caseyText("src/choices.js#w5", [ref]) },
    ],
  }
}

export function candidateChoices(rows) {
  return {
    kind: KIND_LIST,
    choices: rows.slice(0, LIST_MAX).map(r => ({
      id: `pick:${r.ref}`, title: r.ref, description: r.what || '',
      meaning: caseyText("src/choices.js#w6", [r.ref, r.ref]),
    })),
  }
}

export function diagnosisStatusChoices(options) {
  return {
    kind: KIND_BUTTONS,
    choices: options.map(o => ({
      id: `status:${o}`, title: choiceLabel(o),
      meaning: caseyText("src/choices.js#w7", [o, o]),
    })),
  }
}

export function sameSituationChoices(a, b) {
  return {
    kind: KIND_BUTTONS,
    choices: [
      { id: `same:${a}:${b}`, title: choiceLabel('same'), meaning: caseyText("src/choices.js#w8", [a, b]) },
      { id: `notsame:${a}:${b}`, title: choiceLabel('not_same'), meaning: caseyText("src/choices.js#w9", [a, b]) },
    ],
  }
}

export function nearbyChoices(rows) {
  return {
    kind: KIND_LIST,
    choices: rows.slice(0, LIST_MAX).map(r => ({
      id: `near:${r.ref}`, title: r.ref, description: r.description,
      meaning: caseyText("src/choices.js#w10", [r.ref, r.ref]),
    })),
  }
}

const moreChoice = (parsed) => (typeof parsed?.next === 'string' && parsed.next
  ? { kind: KIND_BUTTONS, choices: [{ id: 'more', title: choiceLabel('more'), meaning: caseyText("src/choices.js#w11", [parsed.next]) }] }
  : null)

function offersFromPending(parsed) {
  const offers = Array.isArray(parsed?.handover_offers) ? parsed.handover_offers : []
  if (!offers.length) return null
  const answer = (o, accept, single) => {
    const word = choiceLabel(accept ? 'accept' : 'decline')
    return {
      id: `${accept ? 'accept' : 'decline'}:${o.ref}`,
      title: single ? word : `${word} ${o.ref}`,
      description: `from ${o.from}`,
      meaning: caseyText("src/choices.js#w12", [accept ? 'accept' : 'decline', o.ref, o.ref, accept]),
    }
  }
  if (offers.length === 1) return { kind: KIND_BUTTONS, choices: [answer(offers[0], true, true), answer(offers[0], false, true)] }
  return { kind: KIND_LIST, choices: offers.slice(0, LIST_MAX / 2).flatMap(o => [answer(o, true, false), answer(o, false, false)]) }
}

const DERIVED = { case_search: moreChoice, case_pending: offersFromPending }

export function offeredFromResult(name, parsed) {
  if (Array.isArray(parsed?.choices) && parsed.choices.length) return { kind: parsed.kind, choices: parsed.choices }
  return DERIVED[name]?.(parsed) || null
}
