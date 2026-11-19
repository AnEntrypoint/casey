import { loadDomainConfig } from './config-loader.js'

const { domain } = loadDomainConfig()
const roles = domain.roles || {}
const tiers = domain.tiers || {}

const need = (ok, why) => { if (!ok) throw new Error(`domain.yml ${why}`) }
const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

const idList = (value, key) => {
  need(Array.isArray(value) && value.length > 0 && value.every(nonEmptyString), `roles.${key} must list one or more role ids`)
  return Object.freeze([...value])
}
const idWord = (value, key) => {
  need(nonEmptyString(value), `roles.${key} must name one role id`)
  return value
}

export const FIELD_ROLES = idList(roles.field, 'field')
export const SPECIALIST_ROLE = idWord(roles.specialist, 'specialist')
export const LEAST_PRIVILEGED_FIELD_ROLE = idWord(roles.least_privileged, 'least_privileged')
need(FIELD_ROLES.includes(LEAST_PRIVILEGED_FIELD_ROLE), 'roles.least_privileged must be one of roles.field')
need(FIELD_ROLES.includes(SPECIALIST_ROLE), 'roles.specialist must be one of roles.field')

const roleTiers = domain.role_tiers || {}
need(roleTiers && typeof roleTiers === 'object' && !Array.isArray(roleTiers), 'role_tiers must map role ids to tier keys')
for (const [role, tierKey] of Object.entries(roleTiers)) {
  need(FIELD_ROLES.includes(role), `role_tiers.${role} is not a field role`)
  need(Object.prototype.hasOwnProperty.call(tiers, tierKey), `role_tiers.${role} names an unknown tier key "${tierKey}"`)
}
export const ROLE_TIER_KEY = Object.freeze({ ...roleTiers })

const tags = domain.tags || {}
for (const k of ['field_note', 'specialist_note', 'handover_offer']) need(nonEmptyString(tags[k]), `tags.${k} must name a tag`)
export const NOTE_TAGS = Object.freeze({ field_note: tags.field_note, specialist_note: tags.specialist_note, handover_offer: tags.handover_offer })

const importWords = domain.team_import?.role_words || {}
for (const k of ['field', 'specialist', 'operator']) need(Array.isArray(importWords[k]) && importWords[k].every(nonEmptyString), `team_import.role_words.${k} must list words`)
export const TEAM_IMPORT_ROLE_WORDS = Object.freeze({ field: [...importWords.field], specialist: [...importWords.specialist], operator: [...importWords.operator] })

const importHeaders = domain.team_import?.headers || {}
const IMPORT_HEADER_KEYS = ['name', 'phone', 'role', 'area', 'smartphone']
for (const k of IMPORT_HEADER_KEYS) need(Array.isArray(importHeaders[k]) && importHeaders[k].every(nonEmptyString), `team_import.headers.${k} must list column names`)
export const TEAM_IMPORT_HEADERS = Object.freeze(Object.fromEntries(IMPORT_HEADER_KEYS.map(k => [k, Object.freeze([...importHeaders[k]])])))
