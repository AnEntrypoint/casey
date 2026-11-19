import { loadDomainConfig } from './config-loader.js'

const NAMES = ['kind', 'signs', 'suspected_condition', 'total_count', 'identifying_detail', 'contact_available']
const { reportFields } = loadDomainConfig()
const fieldKeys = new Set((reportFields.fields || []).map((f) => f.key))
const declared = reportFields.concepts || {}
for (const name of Object.keys(declared)) {
  if (!NAMES.includes(name)) throw new Error(`report-fields.yml concepts.${name} is not a known concept`)
  if (typeof declared[name] !== 'string' || !fieldKeys.has(declared[name])) throw new Error(`report-fields.yml concepts.${name} names no report field`)
}
export const REPORT_CONCEPT = Object.freeze(Object.fromEntries(NAMES.map((n) => [n, declared[n] ?? null])))
