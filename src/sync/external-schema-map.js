import { syncConfig } from './sync-config.js'

export const { EXTERNAL_SCHEMA, FIELD_CROSSWALK, NO_CASEY_COUNTERPART } = syncConfig()

export function mapExternalFieldsToReport(externalRecord, kind) {
  const report = {}
  for (const row of FIELD_CROSSWALK) {
    const [rowKind, field] = row.external.split('.')
    if (rowKind !== kind) continue
    if (!row.target.startsWith('report.')) continue
    const value = externalRecord?.[field]
    if (value == null || String(value).trim() === '') continue
    const reportKey = row.target.slice('report.'.length)
    if (row.combine === 'space') {
      report[reportKey] = [report[reportKey], value].filter(Boolean).join(' ').trim() || value
    } else if (row.combine === 'newline') {
      report[reportKey] = report[reportKey] ? `${report[reportKey]}\n${value}` : value
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
