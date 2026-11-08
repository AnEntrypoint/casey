
import { REPORT_KEYS, APPEND_FIELDS } from './report-shape.js'

export const APPEND_FIELD_MAX_LEN = 20000

export function parseReportJson(raw) {
  try { return { value: raw ? JSON.parse(raw) : {}, corrupted: false, error: null } }
  catch (e) { return { value: {}, corrupted: true, error: e } }
}

export function mergeReportFields(current, incoming) {
  const merged = { ...current }
  const cappedFields = []
  const APPEND_KEYS = APPEND_FIELDS
  for (const [k, v] of Object.entries(incoming)) {
    if (v == null || String(v).trim() === '') continue
    if (String(v).length > APPEND_FIELD_MAX_LEN) { cappedFields.push(k); continue }
    if (APPEND_KEYS.has(k) && merged[k] != null && String(merged[k]).trim() !== '' && String(merged[k]) !== String(v)) {
      const next = `${merged[k]}; ${v}`
      if (next.length > APPEND_FIELD_MAX_LEN) { cappedFields.push(k); continue }
      merged[k] = next
    } else {
      merged[k] = v
    }
  }
  return { merged, cappedFields }
}

export function fillIfEmptyReport(tgtReport, srcReport) {
  const mergedReport = { ...tgtReport }
  for (const [k, v] of Object.entries(srcReport)) {
    if (!REPORT_KEYS.has(k)) continue
    if (v == null || String(v).trim() === '') continue
    const have = tgtReport[k] != null && String(tgtReport[k]).trim() !== ''
    if (APPEND_FIELDS.has(k) && have && String(tgtReport[k]) !== String(v)) {
      mergedReport[k] = `${tgtReport[k]}; ${v}`
    } else if (!have) {
      mergedReport[k] = v
    }
  }
  return mergedReport
}
