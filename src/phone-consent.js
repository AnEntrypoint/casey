// phone-consent.js -- has this phone number agreed, in conversation, to what we keep?
//
// Asked once per number, in the person's own words and language, by the model (the prompt
// section in hooks/prompt-sections.js `consentSection`), not appended to a reply as a block.
// The person's answer is recorded by the case_consent tool (case-tools-consent.js) as one
// observation on the case the answer arrived on; this module reads it back across every case
// of the contact, newest answer wins, so a returning number is never asked again and a number
// that declined and later agrees is honoured.
//
// The GATE: while a public number has not agreed, case_report refuses to write
// (case-tools-record-report.js). Nothing else is held: the conversation, STOP and HUMAN,
// the safety line and a hand-over to a person all work exactly as before, and a photo or
// voice note is still filed at ingress (hooks/media-intake.js), which happens before any
// model turn and cannot wait for an answer.
//
// Deployment data: `persona.consentText` (bot.consent in vocabulary.yml) is the plain facts the
// assistant must cover. Absent, there is no gate and nothing changes.

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

// 'agreed' | 'declined' | 'none'. `events` (the current case's) is used when given so the turn
// that just started does not re-read them.
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
