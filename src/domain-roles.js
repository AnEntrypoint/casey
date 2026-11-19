import { loadDomainConfig } from './config-loader.js'
import { caseyText } from './deployment-text.js';

const { domain } = loadDomainConfig()
const roles = domain.roles || {}
const tiers = domain.tiers || {}

const need = (ok, why) => { if (!ok) throw new Error(`domain.yml ${why}`) }
const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

const idList = (value, key) => {
  need(Array.isArray(value) && value.length > 0 && value.every(nonEmptyString), caseyText("src/domain-roles.js#w0", [key]))
  return Object.freeze([...value])
}
const idWord = (value, key) => {
  need(nonEmptyString(value), caseyText("src/domain-roles.js#w1", [key]))
  return value
}

export const FIELD_ROLES = idList(roles.field, 'field')
export const SPECIALIST_ROLE = idWord(roles.specialist, 'specialist')
export const LEAST_PRIVILEGED_FIELD_ROLE = idWord(roles.least_privileged, 'least_privileged')
need(FIELD_ROLES.includes(LEAST_PRIVILEGED_FIELD_ROLE), caseyText("src/domain-roles.js#w2"))
need(FIELD_ROLES.includes(SPECIALIST_ROLE), caseyText("src/domain-roles.js#w3"))

const roleTiers = domain.role_tiers || {}
need(roleTiers && typeof roleTiers === 'object' && !Array.isArray(roleTiers), caseyText("src/domain-roles.js#w4"))
for (const [role, tierKey] of Object.entries(roleTiers)) {
  need(FIELD_ROLES.includes(role), caseyText("src/domain-roles.js#w5", [role]))
  need(Object.prototype.hasOwnProperty.call(tiers, tierKey), caseyText("src/domain-roles.js#w6", [role, tierKey]))
}
export const ROLE_TIER_KEY = Object.freeze({ ...roleTiers })

const tags = domain.tags || {}
for (const k of ['field_note', 'specialist_note', 'handover_offer']) need(nonEmptyString(tags[k]), caseyText("src/domain-roles.js#w7", [k]))
export const NOTE_TAGS = Object.freeze({ field_note: tags.field_note, specialist_note: tags.specialist_note, handover_offer: tags.handover_offer })

const importWords = domain.team_import?.role_words || {}
for (const k of ['field', 'specialist', 'operator']) need(Array.isArray(importWords[k]) && importWords[k].every(nonEmptyString), caseyText("src/domain-roles.js#w8", [k]))
export const TEAM_IMPORT_ROLE_WORDS = Object.freeze({ field: [...importWords.field], specialist: [...importWords.specialist], operator: [...importWords.operator] })

const importHeaders = domain.team_import?.headers || {}
const IMPORT_HEADER_KEYS = ['name', 'phone', 'role', 'area', 'smartphone']
for (const k of IMPORT_HEADER_KEYS) need(Array.isArray(importHeaders[k]) && importHeaders[k].every(nonEmptyString), caseyText("src/domain-roles.js#w9", [k]))
export const TEAM_IMPORT_HEADERS = Object.freeze(Object.fromEntries(IMPORT_HEADER_KEYS.map(k => [k, Object.freeze([...importHeaders[k]])])))
