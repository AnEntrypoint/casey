import { REPORT_CONCEPT as K } from '../report-concepts.js'


import { loadDomainConfig } from '../config-loader.js'
import { MANDATORY_MINIMUM_FIELDS } from '../store/report-shape.js'
import { buildPromptContext } from './prompt-context.js'
import { consentManaged } from '../phone-consent.js'
import { headerSection, caseContextSection, gatherSection, replySection, speakerSection, consentSection, returnSection, stopConfirmSection } from './prompt-sections.js'
import { roleSection, feedbackSection } from './prompt-roles.js'
import { TIER } from '../contact-tiers.js'
import { caseyText, caseyChecksOn } from '../deployment-text.js';

const { persona } = loadDomainConfig()

export function caseSystemPrompt(caseRow, events, contact, speaker = null, consent = null, ret = null) {
  const ctx = buildPromptContext(caseRow, events)
  return [

    ...headerSection(persona, caseRow, contact),

    ...caseContextSection(caseRow, contact, ctx),

    ...gatherSection(persona, caseRow, contact, ctx),

    ...replySection(persona, caseRow, contact, { ...ctx, consent, ret }),

    ...roleSection(persona, caseRow, contact),

    ...feedbackSection(),

    ...speakerSection(persona, contact, speaker),

    ...consentSection(persona, contact, consent),

    ...returnSection(persona, contact, ret, consent),

    ...stopConfirmSection(persona, caseRow, events),
  ].join('\n')
}

function selfCheckLoadBearingPromptContent() {
  const now = Date.now()
  const oldTs = new Date(now - 5 * 3600e3).toISOString()
  const recentTs = new Date(now).toISOString()
  const staleContact = { last_location_lat: -1, last_location_lon: 1, last_location_at: String(Math.floor((now - 10 * 3600e3) / 1000)) }
  const events = [
    { kind: 'inbound', actor: 'contact', text: 'x', created_at: oldTs },
    { kind: 'inbound', actor: 'contact', text: 'y', created_at: recentTs },
  ]
  const caseRow = { ref: 'SELFCHECK', id: 'selfcheck', status: 'triaging', priority: 'normal', assignee: null, subject: null, summary: null, tags: null, report: null, autonomy: 'auto' }
  const text = caseSystemPrompt(caseRow, events, staleContact)

  const workerText = caseSystemPrompt(caseRow, events, { ...staleContact, tier: TIER.field })

  const signOffText = caseSystemPrompt(caseRow, events, { ...staleContact, tier: TIER.specialist })

  const operatorText = caseSystemPrompt(caseRow, events, { ...staleContact, tier: TIER.operator })
  const roleBlocks = [
    { name: caseyText("src/hooks/prompt.js#0"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re0")), from: TIER.field },
    { name: caseyText("src/hooks/prompt.js#1"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re1")), from: TIER.field, exact: [TIER.field, TIER.operator] },

    { name: caseyText("src/hooks/prompt.js#2"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re2")), from: TIER.specialist, exact: [TIER.specialist] },
    { name: caseyText("src/hooks/prompt.js#s0"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re3")), from: TIER.specialist },
    { name: caseyText("src/hooks/prompt.js#s1"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re4")), from: TIER.specialist },
    { name: caseyText("src/hooks/prompt.js#s2"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re5")), from: TIER.operator },
    { name: caseyText("src/hooks/prompt.js#s3"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re6")), from: TIER.operator },
    { name: caseyText("src/hooks/prompt.js#s4"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re7")), from: TIER.field },
    { name: caseyText("src/hooks/prompt.js#3"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re8")), from: TIER.operator },
    { name: caseyText("src/hooks/prompt.js#s5"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re9")), from: TIER.field },
    { name: caseyText("src/hooks/prompt.js#s6"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re10")), from: TIER.field },
  ]
  const composed = { reporter: text, [TIER.field]: workerText, [TIER.specialist]: signOffText, [TIER.operator]: operatorText }
  const rungs = [TIER.field, TIER.specialist, TIER.operator]
  for (const { name, pattern, from, exact } of roleBlocks) {
    if (pattern.test(text)) throw new Error(`caseSystemPrompt regression: role block leaked to the reporter tier (${name}).`)
    for (const rung of rungs) {
      const want = exact ? exact.includes(rung) : rungs.indexOf(rung) >= rungs.indexOf(from)
      if (pattern.test(composed[rung]) !== want) {
        throw new Error(`caseSystemPrompt regression: role block ${want ? caseyText("src/hooks/prompt.js#s7") : caseyText("src/hooks/prompt.js#s8")} the ${rung} tier (${name}). Each rung gets its own block and every rung above it -- see hooks/prompt-roles.js.`)
      }
    }
  }
  const required = [
    { name: caseyText("src/hooks/prompt.js#s9"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re11")) },
    { name: caseyText("src/hooks/prompt.js#4"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re12")) },
    { name: caseyText("src/hooks/prompt.js#s10"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re13")) },
    { name: caseyText("src/hooks/prompt.js#s11"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re14")) },
    { name: caseyText("src/hooks/prompt.js#5"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re15")) },

    { name: caseyText("src/hooks/prompt.js#s12"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re16")) },

    { name: caseyText("src/hooks/prompt.js#s13"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re17")) },

    { name: caseyText("src/hooks/prompt.js#s14"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re18")) },

    { name: caseyText("src/hooks/prompt.js#s15"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re19")) },

    { name: caseyText("src/hooks/prompt.js#s16"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re20")) },

    ...(MANDATORY_MINIMUM_FIELDS.length ? [{ name: caseyText("src/hooks/prompt.js#6"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re21")) }] : []),
    { name: caseyText("src/hooks/prompt.js#s17"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re22")) },
    { name: caseyText("src/hooks/prompt.js#7"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re23")) },
    { name: caseyText("src/hooks/prompt.js#8"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re24")) },

    { name: caseyText("src/hooks/prompt.js#s18"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re25")) },

    { name: caseyText("src/hooks/prompt.js#9"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re26")) },
  ]

  const person = (id, name, relation = '') => ({ id, name, relation, first_seen: 1, last_seen: 1, reports: 0 })
  const two = [person('pp_a', 'Sipho', 'husband'), person('pp_b', 'Nomsa', 'wife')]
  const base = { count: 2, people: two, current: null, previous: null, stale: false, awaiting: false, needs_ask: true, open_report_by: null }
  const askText = caseSystemPrompt(caseRow, events, staleContact, base)
  const knownText = caseSystemPrompt(caseRow, events, staleContact, { ...base, current: two[1], needs_ask: false, open_report_by: two[0] })
  const oneText = caseSystemPrompt(caseRow, events, staleContact, { ...base, count: 1, people: [two[0]], current: two[0], needs_ask: false })
  const sharedRules = [
    { name: caseyText("src/hooks/prompt.js#10"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re27")), all: [text, askText, knownText, oneText] },
    { name: caseyText("src/hooks/prompt.js#11"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re28")), all: [askText] },
    { name: caseyText("src/hooks/prompt.js#s19"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re29")), all: [knownText] },
    { name: caseyText("src/hooks/prompt.js#s20"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re30")), all: [askText, knownText] },
  ]
  for (const { name, pattern, all } of sharedRules) {
    for (const t of all) if (!pattern.test(t)) throw new Error(`caseSystemPrompt regression: shared-phone instruction missing (${name}). See hooks/prompt-sections.js speakerSection and AGENTS.md "Several people on one phone".`)
  }
  for (const t of [text, oneText]) {
    if (new RegExp(caseyText("src/hooks/prompt.js#re31")).test(t)) throw new Error('caseSystemPrompt regression: the several-people block is rendered for a phone with at most one known person, which must get no extra question.')
  }
  {
    const ret = { owed: true, [K.kind]: 'kind-a', location: 'place-a', person: 'person-a' }
    const asks = caseSystemPrompt(caseRow, events, staleContact, null, 'agreed', ret)
    const quiet = caseSystemPrompt(caseRow, events, staleContact, null, 'agreed', { owed: false })
    const team = caseSystemPrompt(caseRow, events, { ...staleContact, tier: TIER.field }, null, null, ret)
    if (!new RegExp(caseyText("src/hooks/prompt.js#re32")).test(asks + caseSystemPrompt(caseRow, events, staleContact, null, 'agreed', ret))) throw new Error('caseSystemPrompt regression: the return-to-a-complete-report question is missing. See hooks/prompt-sections.js returnSection and return-clarify.js.')
    if (new RegExp(caseyText("src/hooks/prompt.js#re33")).test(quiet)) throw new Error('caseSystemPrompt regression: the return question is rendered when none is owed.')
    if (new RegExp(caseyText("src/hooks/prompt.js#re34")).test(team)) throw new Error('caseSystemPrompt regression: the return question is rendered for a team member.')
  }
  if (consentManaged()) {
    const askConsent = caseSystemPrompt(caseRow, events, staleContact, null, 'none')
    const agreedText = caseSystemPrompt(caseRow, events, staleContact, null, 'agreed')
    const teamText = caseSystemPrompt(caseRow, events, { ...staleContact, tier: TIER.field }, null, 'none')
    if (!new RegExp(caseyText("src/hooks/prompt.js#re35")).test(askConsent)) throw new Error('caseSystemPrompt regression: the once-per-number consent question is missing. See hooks/prompt-sections.js consentSection and phone-consent.js.')
    for (const [t, why] of [[agreedText, caseyText("src/hooks/prompt.js#s21")], [teamText, caseyText("src/hooks/prompt.js#s22")]]) {
      if (new RegExp(caseyText("src/hooks/prompt.js#re36")).test(t)) throw new Error(`caseSystemPrompt regression: the consent question is rendered for ${why}.`)
    }
  }
  for (const t of [workerText, signOffText, operatorText]) {
    if (new RegExp(caseyText("src/hooks/prompt.js#re37")).test(t)) throw new Error('caseSystemPrompt regression: the shared-phone rule leaked to a team member (public contacts only).')
  }
  for (const { name, pattern } of required) {
    if (!pattern.test(text)) {
      throw new Error(`caseSystemPrompt regression: required phrase missing (${name}). A prompt rewrite silently dropped a load-bearing behavioral instruction -- see AGENTS.md's prompt-steering notes.`)
    }
  }

  const workerOnly = [
    { name: caseyText("src/hooks/prompt.js#s23"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re38")) },
    { name: caseyText("src/hooks/prompt.js#s24"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re39")) },
    { name: caseyText("src/hooks/prompt.js#s25"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re40")) },
    { name: caseyText("src/hooks/prompt.js#s26"), pattern: new RegExp(caseyText("src/hooks/prompt.js#re41")) },
  ]
  for (const { name, pattern } of workerOnly) {
    if (!pattern.test(workerText)) {
      throw new Error(`caseSystemPrompt regression: field_worker-tier instruction missing (${name}). A prompt rewrite dropped it from the tier that CAN call the tool.`)
    }
    if (pattern.test(text)) {
      throw new Error(`caseSystemPrompt regression: field_worker-only instruction leaked to reporter tier (${name}). That tier cannot see or dispatch the tool this names -- see case-tools-gates.js REPORT_ONLY_TOOLS.`)
    }
    if (!pattern.test(signOffText)) {
      throw new Error(`caseSystemPrompt regression: elevated instruction missing at the ${TIER.specialist} tier (${name}). A tier branch was rewritten as a field_worker EQUALITY comparison, so the HIGHEST rung is composing the report-only prompt while gateByTier still grants it every tool -- use canQueryCases (contact-tiers.js), never ===.`)
    }
  }
  selfCheckFenceIntegrity()
}

function selfCheckFenceIntegrity() {
  const payload = caseyText("src/hooks/prompt.js#12")
  const caseRow = {
    ref: 'SELFCHECK', id: 'selfcheck', status: 'triaging', priority: 'normal', autonomy: 'auto',
    assignee: payload, subject: payload, summary: payload, tags: payload,
    report: JSON.stringify({ notes: payload }),
  }
  const events = [{ kind: 'inbound', actor: 'contact', text: payload, created_at: new Date().toISOString() }]
  const evil = { id: 'pp_x', name: payload, relation: payload, first_seen: 1, last_seen: 1, reports: 0 }
  const text = caseSystemPrompt(caseRow, events, {}, { count: 2, people: [evil, { ...evil, id: 'pp_y' }], current: evil, previous: null, stale: false, awaiting: false, needs_ask: false, open_report_by: { ...evil, id: 'pp_y' } })
  const markers = text.match(/<<(?:DATA|END)>>/g) || []
  if (!markers.length) {
    throw new Error('caseSystemPrompt regression: the <<DATA>>/<<END>> untrusted-data fence emitted no markers at all. Contact-supplied text is now reaching the prompt with no boundary -- see hooks/prompt-context.js fenced().')
  }
  for (let i = 0; i < markers.length; i++) {
    const want = i % 2 === 0 ? '<<DATA>>' : '<<END>>'
    if (markers[i] !== want) {
      throw new Error(`caseSystemPrompt regression: untrusted-data fence broken at marker ${i + 1} (expected ${want}, got ${markers[i]}). Some contact-reachable value is interpolated into the prompt WITHOUT fenced() and its own literal marker closed the fence early -- wrap it with fenced() (hooks/prompt-context.js).`)
    }
  }
  if (markers.length % 2 !== 0) {
    throw new Error('caseSystemPrompt regression: untrusted-data fence has an unclosed <<DATA>> -- an interpolated value is emitting a marker of its own.')
  }
  for (const label of ['assignee', 'subject', 'summary', 'tags']) {
    if (!text.includes(`${label}: <<DATA>>`)) {
      throw new Error(`caseSystemPrompt regression: caseRow.${label} is rendered into the prompt UNFENCED. It is free-text, contact-reachable (subject is seeded verbatim from the contact's first message; subject/summary/assignee are case_update-writable) and must go through fenced() -- see prompt-sections.js caseContextSection.`)
    }
  }
}
if (caseyChecksOn()) selfCheckLoadBearingPromptContent()
