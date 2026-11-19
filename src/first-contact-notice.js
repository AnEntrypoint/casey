

import { loadDomainConfig } from './config-loader.js'
import { atLeast, resolveTierValue, TIER } from './contact-tiers.js'
import { tagList } from './timestamp.js'
import { evData } from './safe.js'
import { toPlainChat } from './hooks/plain-text.js'
import { consentManaged } from './phone-consent.js'
import { caseyText } from './deployment-text.js';

const { persona } = loadDomainConfig()
const MAX_OTHER_CASES = 25
const asText = (v) => (Array.isArray(v) ? v.join(' ') : String(v || '')).replace(/\s+/g, ' ').trim()

export function noticeSettings(tier) {
  const staff = atLeast(resolveTierValue(tier), TIER.field)
  const text = asText(staff ? persona.staffNoticeText : persona.noticeText)
  const anchor = staff ? asText(persona.staffNoticeAnchor) : asText(persona.noticeAnchor)
  return { kind: staff ? 'staff' : 'public', version: String(persona.noticeVersion || '1'), text, anchor }
}

const personOf = (speaker) => (speaker && speaker.current ? { id: speaker.current.id, first: speaker.people[0]?.id === speaker.current.id } : null)

const matches = (e, kind, version, who = null) => {
  const d = evData(e)
  if (!((d.notice_shown === true || d.notice_carried === true) && d.notice_kind === kind && String(d.notice_version) === version)) return false
  if (!who) return true
  return who.first ? (!d.notice_person || d.notice_person === who.id) : d.notice_person === who.id
}

export async function decideNotice(store, { fresh, events = [], contact, speaker = null }) {
  if (!contact?.id || !fresh || fresh.channel === 'system') return null
  const s = noticeSettings(contact.tier)
  if (!s.text) return null

  if (s.kind === 'public' && consentManaged()) return null
  const tags = tagList(fresh)
  if (tags.includes('opted-out') || tags.includes('needs-human')) return null
  const who = s.kind === 'public' ? personOf(speaker) : null
  if (who) {
    s.person_id = who.id
    if (!who.first) {
      const short = asText(persona.newPersonNoticeText)
      if (short) { s.text = short; s.short = true }
    }
  }
  if (events.some(e => matches(e, s.kind, s.version, who))) return null
  let others = []
  try {
    others = (await store.t.list('case', { contact_id: contact.id }, { limit: 200 }))
      .filter(c => c.id !== fresh.id && c.channel !== 'system')
      .sort((a, b) => String(b.last_event_at || '').localeCompare(String(a.last_event_at || '')))
      .slice(0, MAX_OTHER_CASES)
  } catch { others = [] }
  if (others.length) {
    const rows = await store.t.list('event', { case_id: { $in: others.map(c => c.id) }, kind: 'observation' }, { limit: 5000 }).catch(() => [])
    if (rows.some(e => matches(e, s.kind, s.version, who))) {
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: caseyText("src/first-contact-notice.js#w0", [s.kind, s.version]), data: { notice_carried: true, notice_kind: s.kind, notice_version: s.version, ...(who ? { notice_person: who.id } : {}) }, touch: false }).catch(() => {})
      return null
    }
  }
  return s
}

const MAX_NOTICE_CHARS = 1200

export async function composeNotice(callLLM, notice, { inboundText = '', language = '' } = {}) {
  if (typeof callLLM !== 'function' || !notice) return null
  const said = String(inboundText || '').replace(/<<(?:DATA|END)>>/g, '').slice(0, 400)
  const prompt = [
    caseyText("src/first-contact-notice.js#w1"),
    caseyText("src/first-contact-notice.js#w2", [notice.short ? 'three' : 'four']),
    caseyText("src/first-contact-notice.js#w3", [language ? caseyText("src/first-contact-notice.js#w4", [String(language).slice(0, 40)]) : '']),
    caseyText("src/first-contact-notice.js#w5", [notice.short
      ? caseyText("src/first-contact-notice.js#w6")
      : caseyText("src/first-contact-notice.js#w7")]),
    notice.anchor ? caseyText("src/first-contact-notice.js#w8", [notice.anchor]) : '',
    caseyText("src/first-contact-notice.js#w9"),
    `PERSON'S MESSAGE:`,
    `<<DATA>>`,
    said,
    `<<END>>`,
    caseyText("src/first-contact-notice.js#w10", [notice.text]),
  ].filter(Boolean).join('\n')
  for (let attempt = 0; attempt < 2; attempt++) {
    let out = ''
    try { out = String((await callLLM({ messages: [{ role: 'user', content: prompt }], tools: [] }))?.content || '').trim() }
    catch { return null }
    out = toPlainChat(out)
    if (out && out.length <= MAX_NOTICE_CHARS && (!notice.anchor || out.includes(notice.anchor))) return out
  }
  return null
}

export async function recordNoticeShown(store, caseId, notice) {
  await store.appendEvent(caseId, {
    kind: 'observation', actor: 'system', text: `notice_shown: ${notice.kind} v${notice.version}${notice.person_id ? caseyText("src/first-contact-notice.js#w11") : ''}`,
    data: { notice_shown: true, notice_kind: notice.kind, notice_version: notice.version, ...(notice.person_id ? { notice_person: notice.person_id, notice_short: notice.short === true } : {}) },
    touch: false,
  })
}
