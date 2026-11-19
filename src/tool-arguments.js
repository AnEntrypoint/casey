import { loadDomainConfig } from './config-loader.js'

const NEUTRAL = Object.freeze({ treated_count: 'treated_count', condition: 'condition' })

const configured = loadDomainConfig().domain.tool_arguments || {}
for (const k of Object.keys(configured)) {
  if (!Object.prototype.hasOwnProperty.call(NEUTRAL, k)) throw new Error(`domain.yml tool_arguments.${k} is not a known tool argument`)
  if (typeof configured[k] !== 'string' || configured[k].trim() === '') throw new Error(`domain.yml tool_arguments.${k} must name the argument`)
}

export const TOOL_ARG = Object.freeze(Object.fromEntries(Object.keys(NEUTRAL).map((k) => [k, configured[k] ?? NEUTRAL[k]])))

export function treatedFields(treated, treatedCount) {
  return { [TOOL_ARG.treated_count]: treated, [`${TOOL_ARG.treated_count}_count`]: treatedCount }
}
