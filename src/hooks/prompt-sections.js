

import { areaAskOwed } from '../area-ask.js'
import { tsMs } from '../timestamp.js'
import { LOCATION_STALE_MS, GENERAL_AREA_KEY, fenced } from './prompt-context.js'
import { canQueryCases } from '../contact-tiers.js'
import { stopPendingState } from './stop-pending.js'
import { fieldLabel } from '../store/report-shape.js'
import { consentText } from '../phone-consent.js'
import { caseyText } from '../deployment-text.js';

export function headerSection(persona, caseRow, contact) {
  const name = persona.agentName || 'casey'
  const isWorker = canQueryCases(contact?.tier)
  return [
    ...persona.domainIntro,
    ``,
    caseyText("src/hooks/prompt-sections.js#0"),
    caseyText("src/hooks/prompt-sections.js#1"),
    caseyText("src/hooks/prompt-sections.js#2", [name]),
    caseyText("src/hooks/prompt-sections.js#3"),
    caseyText("src/hooks/prompt-sections.js#4"),
    caseyText("src/hooks/prompt-sections.js#5"),
    caseyText("src/hooks/prompt-sections.js#6"),
    caseyText("src/hooks/prompt-sections.js#7", [name]),
    caseyText("src/hooks/prompt-sections.js#8"),
    caseyText("src/hooks/prompt-sections.js#9"),

    caseyText("src/hooks/prompt-sections.js#10"),
    caseyText("src/hooks/prompt-sections.js#11"),
    caseyText("src/hooks/prompt-sections.js#12", [persona.entityLabel]),
    caseyText("src/hooks/prompt-sections.js#s0", [caseRow.ref]),
    autonomyLine(persona, caseRow),


    ...(persona.boundaryText ? [persona.boundaryText] : []),
    ``,

    ...(isWorker ? [
      caseyText("src/hooks/prompt-sections.js#13"),
      caseyText("src/hooks/prompt-sections.js#14"),
      caseyText("src/hooks/prompt-sections.js#15"),
      caseyText("src/hooks/prompt-sections.js#16"),
    ] : [persona.casualReporterEnquiryBlockedText]),

    ...staleLocationLines(contact),
  ]
}

function autonomyLine(persona, caseRow) {
  const entity = persona.entityLabel || 'report'
  if (caseRow.autonomy === 'observe') return caseyText("src/hooks/prompt-sections.js#17", [entity])
  if (caseRow.autonomy === 'assisted') return caseyText("src/hooks/prompt-sections.js#18")
  return caseyText("src/hooks/prompt-sections.js#19")
}

function staleLocationLines(contact) {
  if (contact?.last_location_lat == null) return []
  const ageMs = Date.now() - tsMs(contact?.last_location_at)
  if (!Number.isFinite(ageMs) || ageMs > LOCATION_STALE_MS) {
    return [caseyText("src/hooks/prompt-sections.js#20")]
  }
  return [caseyText("src/hooks/prompt-sections.js#21", [contact.last_location_lat, contact.last_location_lon])]
}

const fencedField = (value, max) => (value ? fenced(value, max) : '(none)')

export function caseContextSection(caseRow, contact, { firstMessage, reportLine, recent }) {
  return [
    ``,
    caseyText("src/hooks/prompt-sections.js#s1", [caseRow.ref, caseRow.id]),

    `  status: ${caseRow.status}  priority: ${caseRow.priority}  assignee: ${fencedField(caseRow.assignee, 120)}`,
    `  subject: ${fencedField(caseRow.subject, 200)}  summary: ${fencedField(caseRow.summary, 2000)}`,
    caseyText("src/hooks/prompt-sections.js#s2", [fencedField(caseRow.tags, 400), firstMessage ? 'YES' : 'no']),
    caseyText("src/hooks/prompt-sections.js#s3", [reportLine]),
    ``,

    ...(canQueryCases(contact?.tier) ? [
      caseyText("src/hooks/prompt-sections.js#22"),
      caseyText("src/hooks/prompt-sections.js#23"),
      ``,
    ] : []),
    caseyText("src/hooks/prompt-sections.js#s4"),
    recent || caseyText("src/hooks/prompt-sections.js#s5"),
    ``,
  ]
}

export function gatherSection(persona, caseRow, contact, { returnedAfterGap, reportObj }) {
  return [

    caseyText("src/hooks/prompt-sections.js#24"),
    caseyText("src/hooks/prompt-sections.js#25"),
    caseyText("src/hooks/prompt-sections.js#26"),
    caseyText("src/hooks/prompt-sections.js#27"),
    caseyText("src/hooks/prompt-sections.js#28"),
    caseyText("src/hooks/prompt-sections.js#29"),

    caseyText("src/hooks/prompt-sections.js#30"),
    caseyText("src/hooks/prompt-sections.js#31"),
    caseyText("src/hooks/prompt-sections.js#32"),
    caseyText("src/hooks/prompt-sections.js#33"),
    caseyText("src/hooks/prompt-sections.js#34"),
    caseyText("src/hooks/prompt-sections.js#35"),
    caseyText("src/hooks/prompt-sections.js#s6"),
    caseyText("src/hooks/prompt-sections.js#36"),
    caseyText("src/hooks/prompt-sections.js#37"),

    caseyText("src/hooks/prompt-sections.js#38"),
    caseyText("src/hooks/prompt-sections.js#39"),
    caseyText("src/hooks/prompt-sections.js#40"),
    caseyText("src/hooks/prompt-sections.js#41"),
    caseyText("src/hooks/prompt-sections.js#42"),
    caseyText("src/hooks/prompt-sections.js#43"),
    caseyText("src/hooks/prompt-sections.js#44"),
    ...persona.gatherLeadText,

    caseyText("src/hooks/prompt-sections.js#s7", [canQueryCases(contact?.tier) ? caseyText("src/hooks/prompt-sections.js#s8") : '']),
    caseyText("src/hooks/prompt-sections.js#45"),
    caseyText("src/hooks/prompt-sections.js#46"),
    ...(canQueryCases(contact?.tier) ? [] : (persona.voiceRules || [])),

    ...(canQueryCases(contact?.tier) ? [] : [
    `${returnedAfterGap ? caseyText("src/hooks/prompt-sections.js#s9", [persona.returnedAfterGapText]) : ''}`,
    ``,
    caseyText("src/hooks/prompt-sections.js#47", [persona.gatherPriorityOrder.map((p, i) => `(${i + 1}) ${p.label}${p.hint ? ' -- ' + p.hint : ''}`).join('; ')]),
    caseyText("src/hooks/prompt-sections.js#48"),
    caseyText("src/hooks/prompt-sections.js#49"),
    caseyText("src/hooks/prompt-sections.js#50"),
    caseyText("src/hooks/prompt-sections.js#51"),
    caseyText("src/hooks/prompt-sections.js#52"),
    caseyText("src/hooks/prompt-sections.js#53"),
    caseyText("src/hooks/prompt-sections.js#54"),
    caseyText("src/hooks/prompt-sections.js#55"),
    caseyText("src/hooks/prompt-sections.js#56"),
    caseyText("src/hooks/prompt-sections.js#57"),
    caseyText("src/hooks/prompt-sections.js#58"),
    ...photoNudgeLines(persona, reportObj),

    caseyText("src/hooks/prompt-sections.js#59"),
    caseyText("src/hooks/prompt-sections.js#60"),
    caseyText("src/hooks/prompt-sections.js#61"),
    caseyText("src/hooks/prompt-sections.js#62"),
    caseyText("src/hooks/prompt-sections.js#63"),
    caseyText("src/hooks/prompt-sections.js#s10"),
    ]),
  ]
}

export function stopConfirmSection(persona, caseRow, events) {
  const pending = stopPendingState(caseRow, events)
  return pending?.valid && pending.sameTurn ? ['', persona.stopConfirmText] : []
}


function photoNudgeLines(persona, reportObj) {
  if (!reportObj) return []
  const { coreFields, text } = persona.photoNudge
  if (coreFields.every(k => reportObj[k] != null) && !reportObj.photos) return [text]
  return []
}

export function replySection(persona, caseRow, contact, { firstMessage, missingCritical = [], missingMandatory = [], consent = null, ret = null }) {

  const areaLabel = fieldLabel(GENERAL_AREA_KEY)
  const stillNeeded = [...new Set([...missingMandatory, ...missingCritical.map(fieldLabel)])].filter(label => label !== areaLabel)
  const consentOwed = (consent === 'none' || consent === 'declined') && !canQueryCases(contact?.tier)

  const returnOwed = !!ret?.owed && !consentOwed && !canQueryCases(contact?.tier)
  return [
    ``,
    caseyText("src/hooks/prompt-sections.js#64"),
    caseyText("src/hooks/prompt-sections.js#65"),
    caseyText("src/hooks/prompt-sections.js#66"),
    caseyText("src/hooks/prompt-sections.js#67"),
    caseyText("src/hooks/prompt-sections.js#s11"),
    ``,

    caseyText("src/hooks/prompt-sections.js#68"),
    caseyText("src/hooks/prompt-sections.js#69"),
    caseyText("src/hooks/prompt-sections.js#70"),
    caseyText("src/hooks/prompt-sections.js#71"),
    ...persona.replyStyleRules,

    caseyText("src/hooks/prompt-sections.js#72"),
    caseyText("src/hooks/prompt-sections.js#73"),
    caseyText("src/hooks/prompt-sections.js#74"),
    caseyText("src/hooks/prompt-sections.js#75"),
    ``,

    caseyText("src/hooks/prompt-sections.js#76"),
    caseyText("src/hooks/prompt-sections.js#77"),
    ``,

    ...(canQueryCases(contact?.tier) ? [] : returnOwed
      ? [caseyText("src/hooks/prompt-sections.js#78"), ``]
      : consentOwed
      ? [caseyText("src/hooks/prompt-sections.js#79", [persona.entitySubjectPlural]), ``]
      : stillNeeded.length
        ? [caseyText("src/hooks/prompt-sections.js#80", [stillNeeded[0], stillNeeded[1] ? caseyText("src/hooks/prompt-sections.js#81", [stillNeeded[1]]) : '']), ``]
        : areaAskOwed(caseRow)
        ? [caseyText("src/hooks/prompt-sections.js#82", [persona.areaQuestion]), ``]
        : [caseyText("src/hooks/prompt-sections.js#83"), ``]),

    canQueryCases(contact?.tier)
      ? caseyText("src/hooks/prompt-sections.js#84")
      : caseyText("src/hooks/prompt-sections.js#85"),
    ``,

    firstMessage

      ? [caseyText("src/hooks/prompt-sections.js#s12", [canQueryCases(contact?.tier) ? caseyText("src/hooks/prompt-sections.js#s13") : '']),
         caseyText("src/hooks/prompt-sections.js#86", [persona.entitySubjectPlural]),
         caseyText("src/hooks/prompt-sections.js#87", [caseRow.ref]),
         ...(consentOwed || returnOwed ? [caseyText("src/hooks/prompt-sections.js#88")] : [caseyText("src/hooks/prompt-sections.js#89")]),

         ...(process.env.CASEY_PUBLIC_URL ? [caseyText("src/hooks/prompt-sections.js#90", [process.env.CASEY_PUBLIC_URL, caseRow.ref])] : [])].join('\n')
      : caseyText("src/hooks/prompt-sections.js#s14"),

    ...(canQueryCases(contact?.tier) ? [persona.workerCatchUpText] : []),
    ``,

    missingCritical.length
      ? caseyText("src/hooks/prompt-sections.js#91", [missingCritical.map(fieldLabel).join(', ')])
      : caseyText("src/hooks/prompt-sections.js#92"),

    ...(missingMandatory.length ? [
      caseyText("src/hooks/prompt-sections.js#93", [missingMandatory.join(', '), missingMandatory.length === 1 ? caseyText("src/hooks/prompt-sections.js#s15") : caseyText("src/hooks/prompt-sections.js#s16"), persona.entityLabel, missingMandatory.length === 1 ? caseyText("src/hooks/prompt-sections.js#s17") : caseyText("src/hooks/prompt-sections.js#s18")]),
    ] : []),

    caseyText("src/hooks/prompt-sections.js#94", [persona.entityLabel]),
    caseyText("src/hooks/prompt-sections.js#95"),
    caseyText("src/hooks/prompt-sections.js#s19", [persona.entityLabel, persona.entitySubjectPlural]),
    caseyText("src/hooks/prompt-sections.js#96"),

    ...(canQueryCases(contact?.tier) ? [
      ``,
      caseyText("src/hooks/prompt-sections.js#97"),
      caseyText("src/hooks/prompt-sections.js#98"),
      caseyText("src/hooks/prompt-sections.js#99"),
    ] : []),
    ``,
    caseyText("src/hooks/prompt-sections.js#100"),
    caseyText("src/hooks/prompt-sections.js#101"),
    caseyText("src/hooks/prompt-sections.js#102"),
    caseyText("src/hooks/prompt-sections.js#103"),
    caseyText("src/hooks/prompt-sections.js#104"),
    caseyText("src/hooks/prompt-sections.js#105"),
    caseyText("src/hooks/prompt-sections.js#106"),
    caseyText("src/hooks/prompt-sections.js#107"),
    ``,
    caseyText("src/hooks/prompt-sections.js#108"),
    caseyText("src/hooks/prompt-sections.js#109"),
    caseyText("src/hooks/prompt-sections.js#110"),
    caseyText("src/hooks/prompt-sections.js#111"),
    caseyText("src/hooks/prompt-sections.js#112"),
    caseyText("src/hooks/prompt-sections.js#113"),
    caseyText("src/hooks/prompt-sections.js#114"),
    caseyText("src/hooks/prompt-sections.js#115"),
    caseyText("src/hooks/prompt-sections.js#116"),
    ...(canQueryCases(contact?.tier) ? [
      caseyText("src/hooks/prompt-sections.js#117"),
      caseyText("src/hooks/prompt-sections.js#118"),
      `"stop".`,
    ] : []),
    ``,
    caseyText("src/hooks/prompt-sections.js#119", [caseRow.channel]),
  ]
}

export function speakerSection(persona, contact, speaker) {
  if (canQueryCases(contact?.tier)) return []
  const entity = persona.entityLabel || 'report'
  const many = speaker && speaker.count >= 2
  const names = (list) => list.map(p => `${fenced(p.name, 60)}${p.relation ? ` (${fenced(p.relation, 40)})` : ''}`).join(', ')
  const out = [
    ``,
    caseyText("src/hooks/prompt-sections.js#120"),
  ]
  if (!many) return out
  const others = speaker.people.filter(p => !speaker.current || p.id !== speaker.current.id)
  out.push(
    caseyText("src/hooks/prompt-sections.js#121", [names(speaker.people)]),
    speaker.current
      ? caseyText("src/hooks/prompt-sections.js#122", [fenced(speaker.current.name, 60)])
      : speaker.awaiting
        ? caseyText("src/hooks/prompt-sections.js#123")
        : caseyText("src/hooks/prompt-sections.js#124", [speaker.stale && speaker.previous ? caseyText("src/hooks/prompt-sections.js#125", [fenced(speaker.previous.name, 60)]) : '', others.length ? caseyText("src/hooks/prompt-sections.js#s20", [names(others)]) : caseyText("src/hooks/prompt-sections.js#s21")]),
    speaker.open_report_by && speaker.current && speaker.open_report_by.id !== speaker.current.id
      ? caseyText("src/hooks/prompt-sections.js#126", [entity, fenced(speaker.open_report_by.name, 60), entity])
      : caseyText("src/hooks/prompt-sections.js#127", [entity, entity]),
    caseyText("src/hooks/prompt-sections.js#128", [entity]),
  )
  return out
}

export function consentSection(persona, contact, consent) {
  const facts = consentText()
  if (!facts || !consent || consent === 'agreed' || canQueryCases(contact?.tier)) return []
  const entity = persona.entityLabel || 'report'
  if (consent === 'declined') {
    return [
      ``,
      caseyText("src/hooks/prompt-sections.js#129"),
    ]
  }
  return [
    ``,
    caseyText("src/hooks/prompt-sections.js#130", [facts]),
    caseyText("src/hooks/prompt-sections.js#131", [entity]),
  ]
}

export function returnSection(persona, contact, ret, consent) {
  if (!ret?.owed || canQueryCases(contact?.tier) || consent === 'none' || consent === 'declined') return []
  const entity = persona.entityLabel || 'report'
  const what = [fenced(ret.species, 40), fenced(ret.location, 60)].filter(Boolean).join(' at ')
  const who = ret.person
    ? caseyText("src/hooks/prompt-sections.js#132", [fenced(ret.person, 60)])
    : caseyText("src/hooks/prompt-sections.js#133")
  return [
    ``,
    caseyText("src/hooks/prompt-sections.js#134", [entity, what ? ` (${what})` : '', entity, entity, who]),
    caseyText("src/hooks/prompt-sections.js#135", [entity]),
  ]
}
