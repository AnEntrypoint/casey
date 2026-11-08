

import { loadDomainConfig } from './config-loader.js'
import { evData } from './safe.js'

const { persona } = loadDomainConfig()
const MAX_OTHER_CASES = 25

export const consentText = () => (Array.isArray(persona.consentText) ? persona.consentText.join(' ') : String(persona.consentText || '')).replace(/\s+/g, ' ').trim()
export const consentVersion = () => String(persona.consentVersion || persona.noticeVersion || '1')
export const consentManaged = () => consentText() !== ''

const answerOf = (e) => {
  const d = evData(e)
  if (d.phone_consent !== 'agreed' && d.phone_consent !== 'declined') return null
  if (String(d.consent_version) !== consentVersion()) return null
  return { answer: d.phone_consent, at: Number(e.created_at) || 0 }
}

const newest = (rows) => rows.map(answerOf).filter(Boolean).sort((a, b) => b.at - a.at)[0] || null

export async function consentState(store, contactId, { caseId = null, events = null } = {}) {
  if (!contactId) return 'none'
  try {
    const here = events || (caseId ? await store.listEvents(caseId) : [])
    const mine = newest(here.filter(e => e.kind === 'observation'))
    if (mine) return mine.answer
    const others = (await store.t.list('case', { contact_id: contactId }, { limit: 200 }))
      .filter(c => c.id !== caseId && c.channel !== 'system')
      .sort((a, b) => String(b.last_event_at || '').localeCompare(String(a.last_event_at || '')))
      .slice(0, MAX_OTHER_CASES)
    if (!others.length) return 'none'
    const rows = await store.t.list('event', { case_id: { $in: others.map(c => c.id) }, kind: 'observation' }, { limit: 5000 })
    return newest(rows)?.answer || 'none'
  } catch { return 'none' }
}

export async function recordConsent(store, caseId, agreed) {
  await store.appendEvent(caseId, {
    kind: 'observation', actor: 'system',
    text: agreed ? 'consent: this number agreed, in conversation, to what is kept' : 'consent: this number declined; nothing is recorded',
    data: { phone_consent: agreed ? 'agreed' : 'declined', consent_version: consentVersion() },
    touch: false,
  })
}

export async function repliedBefore(store, contactId, { caseId = null, events = null } = {}) {
  if (!contactId) return true
  try {
    const here = events || (caseId ? await store.listEvents(caseId) : [])
    if (here.some(e => e.kind === 'outbound')) return true
    const others = (await store.t.list('case', { contact_id: contactId }, { limit: 200 }))
      .filter(c => c.id !== caseId && c.channel !== 'system')
      .slice(0, MAX_OTHER_CASES)
    if (!others.length) return false
    const rows = await store.t.list('event', { case_id: { $in: others.map(c => c.id) }, kind: 'outbound' }, { limit: 1 })
    return rows.length > 0
  } catch { return true }
}
