import { loadDomainConfig } from './config-loader.js'

const { domain } = loadDomainConfig()

export const TIER = Object.freeze({ ...domain.tiers })

export const TIER_ORDER = Object.values(TIER)

const RANK = new Map(TIER_ORDER.map((tier, i) => [tier, i]))

export function resolveTierValue(value) {
  return RANK.has(value) ? value : TIER.reporter
}

export function resolveContactTier(contact) {
  return resolveTierValue(contact?.tier)
}

export function tierRank(value) {
  return RANK.get(resolveTierValue(value))
}

export function atLeast(value, min) {
  return tierRank(value) >= tierRank(min)
}

export function canQueryCases(value) {
  return atLeast(value, TIER.field)
}

export function isOperator(value) {
  return atLeast(value, TIER.operator)
}

export function canSignOff(value) {
  return resolveTierValue(value) === TIER.specialist
}

export const ADMIN_ONLY_TIERS = domain.admin_only_tiers.map(key => TIER[key])

export function grantableBy(isAdmin) {
  return TIER_ORDER.filter(t => t !== TIER.reporter && (isAdmin || !ADMIN_ONLY_TIERS.includes(t)))
}

export const DEFAULT_TIER_LABELS = Object.fromEntries(Object.entries(TIER).map(([key, id]) => [id, domain.tier_labels[key]]))

export function tierLabel(value, labels = null) {
  const tier = resolveTierValue(value)
  const declared = labels && typeof labels[tier] === 'string' ? labels[tier].trim() : ''
  return declared || DEFAULT_TIER_LABELS[tier]
}
