import { LOCALE } from '../locale.js'


import { atLeast, resolveTierValue, TIER } from '../contact-tiers.js'
import { SAST_TZ } from '../format.js'
import { TIER_LABELS, DIAGNOSIS_STATUS_KEY, DIAGNOSIS_STATUS_OPTIONS } from '../store/report-shape.js'
import { caseyText } from '../deployment-text.js';


const certaintyClause = () => (DIAGNOSIS_STATUS_OPTIONS
  ? caseyText("src/hooks/prompt-roles.js#0", [DIAGNOSIS_STATUS_KEY, DIAGNOSIS_STATUS_OPTIONS.join(', ')])
  : '')

const todayLine = () => {
  const now = new Date()
  const day = new Intl.DateTimeFormat(LOCALE, { timeZone: SAST_TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(now)
  return caseyText("src/hooks/prompt-roles.js#1", [day, SAST_TZ])
}

function relayLines(thing, signsOff) {
  return [
    caseyText("src/hooks/prompt-roles.js#2", [signsOff ? caseyText("src/hooks/prompt-roles.js#3", [thing]) : caseyText("src/hooks/prompt-roles.js#4", [thing, thing]), thing]),
  ]
}

function fieldBlock(persona, label, { signsOff = false } = {}) {
  const thing = persona.entityLabel
  return [
    ``,
    caseyText("src/hooks/prompt-roles.js#5", [thing, thing, thing, thing]),
    caseyText("src/hooks/prompt-roles.js#6", [label, thing, thing]),
    todayLine(),
    caseyText("src/hooks/prompt-roles.js#7", [thing, thing, thing, thing]),
    caseyText("src/hooks/prompt-roles.js#8", [thing, thing, thing, thing, thing]),
    ...(signsOff ? [caseyText("src/hooks/prompt-roles.js#9", [thing, thing])] : [caseyText("src/hooks/prompt-roles.js#10", [thing, thing])]),
    ...(signsOff ? [] : [caseyText("src/hooks/prompt-roles.js#11", [thing, thing, thing, thing])]),
    caseyText("src/hooks/prompt-roles.js#12"),
    persona.visitModeText,
    caseyText("src/hooks/prompt-roles.js#13", [thing.toUpperCase(), thing, thing]),
    caseyText("src/hooks/prompt-roles.js#14", [thing]),
    ...relayLines(thing, signsOff),
    caseyText("src/hooks/prompt-roles.js#15", [thing]),
    caseyText("src/hooks/prompt-roles.js#16"),
    caseyText("src/hooks/prompt-roles.js#17"),
    caseyText("src/hooks/prompt-roles.js#18"),
  ]
}

function technicianBlock(persona, label) {
  const thing = persona.entityLabel
  return [
    ``,
    caseyText("src/hooks/prompt-roles.js#19", [label, thing, thing, thing, thing, certaintyClause(), thing, thing]),
  ]
}

function operatorBlock(persona, label) {
  const thing = persona.entityLabel
  return [
    ``,
    caseyText("src/hooks/prompt-roles.js#20", [label, thing, thing, thing]),
    caseyText("src/hooks/prompt-roles.js#21", [thing]),
    caseyText("src/hooks/prompt-roles.js#22", [thing, thing, thing, thing]),
    caseyText("src/hooks/prompt-roles.js#23", [thing]),
  ]
}

export function feedbackSection() {
  return [
    ``,
    caseyText("src/hooks/prompt-roles.js#24"),
  ]
}

export function roleSection(persona, caseRow, contact) {
  const tier = resolveTierValue(contact?.tier)
  if (!atLeast(tier, TIER.field)) return []

  const isTechnician = tier === TIER.specialist
  if (isTechnician) {
    return [
      ``,
      caseyText("src/hooks/prompt-roles.js#25", [persona.entityLabel, persona.entityLabel, persona.entityLabel, certaintyClause()]),
      ...technicianBlock(persona, TIER_LABELS[TIER.specialist]),
      ...fieldBlock(persona, TIER_LABELS[TIER.field], { signsOff: true }),
    ]
  }
  return [
    ...fieldBlock(persona, TIER_LABELS[TIER.field], { signsOff: false }),
    ...(atLeast(tier, TIER.specialist) ? technicianBlock(persona, TIER_LABELS[TIER.specialist]) : []),
    ...(atLeast(tier, TIER.operator) ? operatorBlock(persona, TIER_LABELS[TIER.operator]) : []),
  ]
}
