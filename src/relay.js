import { evData } from './safe.js'
import { tsMs, tagList } from './timestamp.js'
import { isOpenCase } from './format.js'
import { dropTag } from './hooks/heuristics.js'
import { AGENT_USER } from './case-store.js'

export const RANGER_NOTE = 'ranger-note'
export const TECHNICIAN_NOTE = 'technician-note'
export const HANDOVER_TAG = 'handover-offer'
export const HANDOVER_TTL_MS = 48 * 3600e3
export const NOTE_MAX = 600

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g
const NUMBER_OR_REF = /(CASE-\d+-[a-z0-9]+)|(\+?\d[\d ()\-.]{5,}\d)/gi

export const scrubNumbers = (text) => String(text ?? '').replace(NUMBER_OR_REF, (m, ref) => (ref ? m : '(number not shown)'))

export const cleanNote = (text) => scrubNumbers(String(text ?? '').replace(CONTROL, '')).replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX)

export function notesTagged(events, tag) {
  return events
    .filter(e => evData(e).tag === tag)
    .map(e => ({ by: evData(e).by || 'a team member', at: e.created_at, text: scrubNumbers(evData(e).note ?? e.text) }))
    .reverse()
}

export function pendingOffer(events, now = Date.now()) {
  let at = -1
  events.forEach((e, i) => { if (evData(e).handover_offer) at = i })
  if (at < 0) return null
  const offer = events[at]
  if (events.slice(at + 1).some(e => evData(e).handover_answer_to === offer.id)) return null
  const d = evData(offer)
  const expiresAt = tsMs(offer.created_at) + HANDOVER_TTL_MS
  return { id: offer.id, by: d.by, from_key: d.from_key, to_contact_id: d.to_contact_id, to_name: d.to_name, expires_at: expiresAt, expired: now > expiresAt }
}

export const offerLine = (c, offer) => `${c.ref} offered by ${offer.by}: accept or decline`

export async function offersFor(store, contact, cases, { mark = false, now = Date.now() } = {}) {
  const out = []
  for (const c of cases) {
    if (!isOpenCase(c) || !tagList(c).includes(HANDOVER_TAG)) continue
    const offer = pendingOffer(await store.listEvents(c.id), now)
    const live = offer && !offer.expired && String(c.assignee || '').trim() === offer.from_key
    if (!live) {
      if (mark) await store.updateCase(c.id, { tags: dropTag(c.tags || '', HANDOVER_TAG) }, AGENT_USER)
      continue
    }
    if (offer.to_contact_id === contact?.id) out.push({ c, offer })
  }
  return out
}
