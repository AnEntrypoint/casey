

export const TIER_REPORTER = 'reporter'
export const TIER_FIELD_WORKER = 'field_worker'
export const TIER_ANIMAL_HEALTH_TECHNICIAN = 'animal_health_technician'
export const TIER_OPERATOR = 'operator'

export const TIER_ORDER = [TIER_REPORTER, TIER_FIELD_WORKER, TIER_ANIMAL_HEALTH_TECHNICIAN, TIER_OPERATOR]

const RANK = new Map(TIER_ORDER.map((tier, i) => [tier, i]))

export function resolveTierValue(value) {
  return RANK.has(value) ? value : TIER_REPORTER
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
  return atLeast(value, TIER_FIELD_WORKER)
}

export function isOperator(value) {
  return atLeast(value, TIER_OPERATOR)
}

export function canSignOff(value) {
  return resolveTierValue(value) === TIER_ANIMAL_HEALTH_TECHNICIAN
}

export const ADMIN_ONLY_TIERS = [TIER_ANIMAL_HEALTH_TECHNICIAN, TIER_OPERATOR]

export function grantableBy(isAdmin) {
  return TIER_ORDER.filter(t => t !== TIER_REPORTER && (isAdmin || !ADMIN_ONLY_TIERS.includes(t)))
}

export const DEFAULT_TIER_LABELS = {
  [TIER_REPORTER]: 'Reporter',
  [TIER_FIELD_WORKER]: 'Field worker',
  [TIER_ANIMAL_HEALTH_TECHNICIAN]: 'Animal health technician',
  [TIER_OPERATOR]: 'Operator',
}

export function tierLabel(value, labels = null) {
  const tier = resolveTierValue(value)
  const declared = labels && typeof labels[tier] === 'string' ? labels[tier].trim() : ''
  return declared || DEFAULT_TIER_LABELS[tier]
}
