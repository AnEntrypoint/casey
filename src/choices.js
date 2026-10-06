import crypto from 'node:crypto'
import { vocabWord } from './config-loader.js'

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

const TAP_EXPIRED = 'they tapped a choice button that has expired or is not one you offered. Nothing was done. Tell them truthfully that the button is no longer valid and ask what they want to do.'
const TAP_USED = (t) => `they tapped "${t}" on a choice that was already answered, so nothing new was done. Do not repeat the earlier action. Tell them briefly that it is already handled and ask if they want something else.`
const TAP_FRESH = (t, meaning) => `they tapped the choice "${t}" that you offered. It means: ${meaning} Treat it as their answer to your last question. Nothing is recorded or changed by the tap itself: every usual check still applies to whatever you do next.`

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
  return `\n\n[System note: ${body}]`
}

export function confirmRecordChoices(ref) {
  return {
    kind: KIND_BUTTONS,
    choices: [
      { id: `yes:${ref}`, title: choiceLabel('answer_yes'), meaning: `Yes, ${ref} is the record they mean. Call case_focus with ${ref} and confirm true, then do what they asked on it.` },
      { id: `no:${ref}`, title: choiceLabel('answer_no'), meaning: `No, ${ref} is not the record they mean. Record nothing; ask which record they mean.` },
    ],
  }
}

export function candidateChoices(rows) {
  return {
    kind: KIND_LIST,
    choices: rows.slice(0, LIST_MAX).map(r => ({
      id: `pick:${r.ref}`, title: r.ref, description: r.what || '',
      meaning: `They picked ${r.ref}. Call case_focus with ${r.ref}.`,
    })),
  }
}

export function diagnosisStatusChoices(options) {
  return {
    kind: KIND_BUTTONS,
    choices: options.map(o => ({
      id: `status:${o}`, title: choiceLabel(o),
      meaning: `The diagnosis certainty is ${o}. Pass diagnosis_status ${o} with the sign-off.`,
    })),
  }
}

export function sameSituationChoices(a, b) {
  return {
    kind: KIND_BUTTONS,
    choices: [
      { id: `same:${a}:${b}`, title: choiceLabel('same'), meaning: `They say ${a} and ${b} are the same situation. Nothing is merged from here: an operator decides merges. Say so and ask if they want a note left on the record.` },
      { id: `notsame:${a}:${b}`, title: choiceLabel('not_same'), meaning: `They say ${a} and ${b} are different situations. Nothing changes; carry on.` },
    ],
  }
}

export function nearbyChoices(rows) {
  return {
    kind: KIND_LIST,
    choices: rows.slice(0, LIST_MAX).map(r => ({
      id: `near:${r.ref}`, title: r.ref, description: r.description,
      meaning: `They picked ${r.ref} from the records near their pin. Call case_focus with ${r.ref}.`,
    })),
  }
}

const moreChoice = (parsed) => (typeof parsed?.next === 'string' && parsed.next
  ? { kind: KIND_BUTTONS, choices: [{ id: 'more', title: choiceLabel('more'), meaning: `They want the next page: call case_search again with the same filters and after set to "${parsed.next}".` }] }
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
      meaning: `They ${accept ? 'accept' : 'decline'} the hand-over of ${o.ref}. Call case_handover_answer with case ${o.ref} and accept ${accept}.`,
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
