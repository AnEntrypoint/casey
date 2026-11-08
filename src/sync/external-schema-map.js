import { loadDomainConfig } from '../config-loader.js'

const externalSchema = loadDomainConfig().externalSchema
if (!externalSchema) throw new Error('external-schema.cjs not found in CASEY_CONFIG_DIR')
export const { EXTERNAL_SCHEMA, FIELD_CROSSWALK, NO_CASEY_COUNTERPART } = externalSchema

export function mapExternalFieldsToReport(externalRecord, kind) {
  const report = {}
  for (const row of FIELD_CROSSWALK) {
    const [rowKind, field] = row.external.split('.')
    if (rowKind !== kind) continue
    if (!row.target.startsWith('report.')) continue
    const value = externalRecord?.[field]
    if (value == null || String(value).trim() === '') continue
    const reportKey = row.target.slice('report.'.length)
    if (reportKey === 'owner_name') {
      report.owner_name = [report.owner_name, value].filter(Boolean).join(' ').trim() || value
    } else if (reportKey === 'notes') {
      report.notes = report.notes ? `${report.notes}\n${value}` : value
    } else if (!(reportKey in report)) {
      report[reportKey] = value
    }
  }
  return report
}

export function mapExternalFieldsToContact(externalRecord, kind) {
  const contact = {}
  for (const row of FIELD_CROSSWALK) {
    const [rowKind, field] = row.external.split('.')
    if (rowKind !== kind) continue
    if (row.target !== 'contact.external_id') continue
    const value = externalRecord?.[field]
    if (value != null && String(value).trim() !== '') contact.external_id = value
  }
  return contact
}
