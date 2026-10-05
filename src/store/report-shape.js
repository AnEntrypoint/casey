
import { loadDomainConfig } from '../config-loader.js'
import { TIER_ORDER, tierLabel } from '../contact-tiers.js'

export const DIAGNOSIS_STATUS_KEY = 'diagnosis_status'

export const DIAGNOSIS_STATUSES = ['confirmed', 'suspected', 'ruled_out']


export function deriveReportShape(reportFields) {
  if (!reportFields || !Array.isArray(reportFields.fields)) throw new Error('deriveReportShape: reportFields.fields[] required')

  const REPORT_KEYS = new Set(reportFields.fields.map(f => f.key))
  const REPORT_KEY_ORDER = reportFields.fields.map(f => f.key)

  const CRITICAL_FIELDS = reportFields.fields.filter(f => f.critical_for_visit).map(f => f.key)

  const SEVERITY_SIGNAL_FIELDS = reportFields.fields.filter(f => f.severity_signal).map(f => f.key)

  const mandatoryBlock = reportFields.mandatory_minimum || null
  let MANDATORY_MINIMUM_FIELDS = []
  let MANDATORY_MINIMUM_BLOCKED_STATUSES = []
  if (mandatoryBlock) {
    if (!Array.isArray(mandatoryBlock.fields) || !mandatoryBlock.fields.length) {
      throw new Error('deriveReportShape: mandatory_minimum declared but mandatory_minimum.fields[] is missing or empty -- declare the fields the agent may never conclude a record without, or remove the whole block')
    }
    const unknown = mandatoryBlock.fields.filter(k => !REPORT_KEYS.has(k))
    if (unknown.length) {
      throw new Error(`deriveReportShape: mandatory_minimum.fields names field(s) this config does not declare: ${unknown.join(', ')} -- a mandatory field the report has no key for can never be filled, so the gate would block every transition forever`)
    }
    if (!Array.isArray(mandatoryBlock.blocks_transition_to) || !mandatoryBlock.blocks_transition_to.length) {
      throw new Error('deriveReportShape: mandatory_minimum declared but mandatory_minimum.blocks_transition_to[] is missing or empty -- name the workflow stage(s) that mean "this record is considered done" (e.g. [resolved, closed]), or the gate enforces nothing')
    }
    MANDATORY_MINIMUM_FIELDS = mandatoryBlock.fields
    MANDATORY_MINIMUM_BLOCKED_STATUSES = mandatoryBlock.blocks_transition_to
  }

  const missingMandatoryMinimum = (reportObj) => {
    const rep = reportObj || {}
    return MANDATORY_MINIMUM_FIELDS.filter(k => rep[k] == null || String(rep[k]).trim() === '')
  }

  const diagBlock = reportFields.signoff_diagnosis || null
  let SIGNOFF_DIAGNOSIS_FIELDS = []
  if (diagBlock) {
    if (!Array.isArray(diagBlock.fields) || !diagBlock.fields.length) {
      throw new Error('deriveReportShape: signoff_diagnosis declared but signoff_diagnosis.fields[] is missing or empty -- name the fields a sign-off must record, or remove the whole block')
    }
    const unknownDx = diagBlock.fields.filter(k => !REPORT_KEYS.has(k))
    if (unknownDx.length) {
      throw new Error(`deriveReportShape: signoff_diagnosis.fields names field(s) this config does not declare: ${unknownDx.join(', ')}`)
    }
    SIGNOFF_DIAGNOSIS_FIELDS = diagBlock.fields
  }
  const missingSignoffDiagnosis = (reportObj) => {
    const rep = reportObj || {}
    return SIGNOFF_DIAGNOSIS_FIELDS.filter(k => rep[k] == null || String(rep[k]).trim() === '' || (k === DIAGNOSIS_STATUS_KEY && !normalizeDiagnosisStatus(rep[k])))
  }

  const AREA_FIELD = reportFields.area_field || null
  if (AREA_FIELD && !REPORT_KEYS.has(AREA_FIELD)) {
    throw new Error(`deriveReportShape: area_field names "${AREA_FIELD}", which this config does not declare as a field`)
  }

  const SYSTEM_SET_FIELDS = new Set(reportFields.fields.filter(f => f.system_set).map(f => f.key))

  const APPEND_FIELDS = new Set(reportFields.fields.filter(f => f.append).map(f => f.key))

  const NEVER_INFERRED_FIELDS = reportFields.fields.filter(f => f.never_inferred)

  const ENQUIRY_HEADLINE_FIELDS = reportFields.enquiry_headline_fields
    || reportFields.fields.filter(f => f.critical_for_visit).slice(0, 2).map(f => f.key)

  const FIELD_LABELS = Object.fromEntries(reportFields.fields.map(f => [f.key, f.display_label || f.key]))
  const fieldLabel = (key) => FIELD_LABELS[key] || key

  const REPORT_SECTIONS = (() => {
    const order = []
    const bySection = new Map()
    for (const f of reportFields.fields) {
      const section = f.section || 'Other'
      if (!bySection.has(section)) { bySection.set(section, []); order.push(section) }
      bySection.get(section).push([f.key, f.display_label || f.key, !!f.multiline])
    }
    return order.map(title => ({ title, keys: bySection.get(title) }))
  })()

  const DASHBOARD_UI = reportFields.dashboard_ui || null

  const TIER_LABELS = Object.fromEntries(
    TIER_ORDER.map(tier => [tier, tierLabel(tier, DASHBOARD_UI?.tier_labels || null)]),
  )

  const FIELD_OPTIONS = Object.fromEntries(reportFields.fields
    .filter(f => Array.isArray(f.options) && f.options.map(o => String(o).trim()).filter(Boolean).length)
    .map(f => [f.key, [...new Set(f.options.map(o => String(o).trim()).filter(Boolean))]]))
  const DIAGNOSIS_STATUS_OPTIONS = SIGNOFF_DIAGNOSIS_FIELDS.includes(DIAGNOSIS_STATUS_KEY) ? (FIELD_OPTIONS[DIAGNOSIS_STATUS_KEY] || []) : null
  if (DIAGNOSIS_STATUS_OPTIONS && (!DIAGNOSIS_STATUS_OPTIONS.length || DIAGNOSIS_STATUS_OPTIONS.some(o => !DIAGNOSIS_STATUSES.includes(o)))) {
    throw new Error(`deriveReportShape: ${DIAGNOSIS_STATUS_KEY} is a sign-off field, so it needs options drawn from ${DIAGNOSIS_STATUSES.join(', ')}`)
  }
  const normalizeDiagnosisStatus = (v) => {
    const s = String(v == null ? '' : v).trim().toLowerCase().replace(/[\s-]+/g, '_')
    return DIAGNOSIS_STATUS_OPTIONS && DIAGNOSIS_STATUS_OPTIONS.includes(s) ? s : null
  }
  const withOptionsNote = (f) => FIELD_OPTIONS[f.key]
    ? { ...f, description: `${f.description || ''} Usual answers: ${FIELD_OPTIONS[f.key].join(', ')}. If they clearly mean one of these, record it with exactly that spelling; if it is anything else (an ostrich, a camel), record their own word as they said it -- never force it into this list.`.trim() }
    : f

  const HIDE_GROUPS = ['all', 'staff', 'eco_ranger', 'animal_health_technician']
  const NEVER_HIDDEN = new Set([...MANDATORY_MINIMUM_FIELDS, ...SIGNOFF_DIAGNOSIS_FIELDS, ...CRITICAL_FIELDS, ...(AREA_FIELD ? [AREA_FIELD] : [])])
  const hiddenCfg = (DASHBOARD_UI && DASHBOARD_UI.hidden_fields && typeof DASHBOARD_UI.hidden_fields === 'object') ? DASHBOARD_UI.hidden_fields : {}
  const groupOf = (role) => (role === 'admin' || role === 'operator' || role === 'secretary') ? 'staff' : (HIDE_GROUPS.includes(role) ? role : null)
  const listOf = (g) => (Array.isArray(hiddenCfg[g]) ? hiddenCfg[g] : []).map(String)
  function hiddenFieldsFor(role) {
    const g = groupOf(role)
    const keys = new Set([...listOf('all'), ...(g ? listOf(g) : [])])
    return [...keys].filter(k => REPORT_KEYS.has(k) && !NEVER_HIDDEN.has(k))
  }
  function hiddenFieldsReport() {
    const rows = []
    for (const g of Object.keys(hiddenCfg)) {
      if (!HIDE_GROUPS.includes(g)) { rows.push({ level: 'warn', text: `dashboard_ui.hidden_fields: "${g}" is not a screen group (use ${HIDE_GROUPS.join(', ')}); ignored`, fix: 'rename or remove that entry in report-fields.yml' }); continue }
      for (const k of listOf(g)) {
        if (!REPORT_KEYS.has(k)) rows.push({ level: 'warn', text: `dashboard_ui.hidden_fields.${g}: "${k}" is not a report field; ignored`, fix: 'check the spelling against report-fields.yml' })
        else if (NEVER_HIDDEN.has(k)) rows.push({ level: 'warn', text: `dashboard_ui.hidden_fields.${g}: "${k}" is part of the mandatory / visit-critical / sign-off set and stays visible`, fix: 'remove it from hidden_fields' })
      }
    }
    const shown = HIDE_GROUPS.map(g => [g, hiddenFieldsFor(g)]).filter(([, ks]) => ks.length)
    rows.push({ level: 'ok', text: shown.length ? 'fields hidden on screens: ' + shown.map(([g, ks]) => `${g} [${ks.join(', ')}]`).join('; ') + ' (data untouched)' : 'no fields are hidden on any screen' })
    return rows
  }

  return {
    FIELD_OPTIONS, hiddenFieldsFor, hiddenFieldsReport, SYSTEM_SET_FIELDS,
    REPORT_KEYS, REPORT_KEY_ORDER, CRITICAL_FIELDS, APPEND_FIELDS, NEVER_INFERRED_FIELDS,
    SEVERITY_SIGNAL_FIELDS,
    MANDATORY_MINIMUM_FIELDS, MANDATORY_MINIMUM_BLOCKED_STATUSES, missingMandatoryMinimum,
    SIGNOFF_DIAGNOSIS_FIELDS, missingSignoffDiagnosis, AREA_FIELD,
    DIAGNOSIS_STATUS_OPTIONS, normalizeDiagnosisStatus,
    ENQUIRY_HEADLINE_FIELDS, FIELD_LABELS, fieldLabel, REPORT_SECTIONS,
    REPORT_ENTITY_LABEL: reportFields.entity_label || 'report',
    REPORT_TOOL_NAME: reportFields.tool_name || 'case_report',
    REPORT_TOOL_DESCRIPTION: reportFields.tool_description || '',
    REPORT_FIELD_DEFS: reportFields.fields.map(withOptionsNote),
    REPORT_GEO_FIELD_DEFS: reportFields.geo_fields || [],
    DASHBOARD_UI,
    TIER_LABELS,
  }
}

const _default = deriveReportShape(loadDomainConfig().reportFields)

export const REPORT_KEYS = _default.REPORT_KEYS
export const REPORT_KEY_ORDER = _default.REPORT_KEY_ORDER
export const CRITICAL_FIELDS = _default.CRITICAL_FIELDS
export const APPEND_FIELDS = _default.APPEND_FIELDS
export const SYSTEM_SET_FIELDS = _default.SYSTEM_SET_FIELDS
export const NEVER_INFERRED_FIELDS = _default.NEVER_INFERRED_FIELDS
export const SEVERITY_SIGNAL_FIELDS = _default.SEVERITY_SIGNAL_FIELDS
export const MANDATORY_MINIMUM_FIELDS = _default.MANDATORY_MINIMUM_FIELDS
export const MANDATORY_MINIMUM_BLOCKED_STATUSES = _default.MANDATORY_MINIMUM_BLOCKED_STATUSES
export const missingMandatoryMinimum = _default.missingMandatoryMinimum
export const SIGNOFF_DIAGNOSIS_FIELDS = _default.SIGNOFF_DIAGNOSIS_FIELDS
export const missingSignoffDiagnosis = _default.missingSignoffDiagnosis

export const DIAGNOSIS_STATUS_OPTIONS = _default.DIAGNOSIS_STATUS_OPTIONS

export const normalizeDiagnosisStatus = _default.normalizeDiagnosisStatus
export const AREA_FIELD = _default.AREA_FIELD
export const ENQUIRY_HEADLINE_FIELDS = _default.ENQUIRY_HEADLINE_FIELDS
export const FIELD_LABELS = _default.FIELD_LABELS
export const fieldLabel = _default.fieldLabel
export const REPORT_SECTIONS = _default.REPORT_SECTIONS
export const REPORT_ENTITY_LABEL = _default.REPORT_ENTITY_LABEL
export const REPORT_TOOL_NAME = _default.REPORT_TOOL_NAME
export const REPORT_TOOL_DESCRIPTION = _default.REPORT_TOOL_DESCRIPTION
export const REPORT_FIELD_DEFS = _default.REPORT_FIELD_DEFS
export const REPORT_GEO_FIELD_DEFS = _default.REPORT_GEO_FIELD_DEFS
export const DASHBOARD_UI = _default.DASHBOARD_UI
export const FIELD_OPTIONS = _default.FIELD_OPTIONS
export const hiddenFieldsFor = _default.hiddenFieldsFor
export const hiddenFieldsReport = _default.hiddenFieldsReport
export const TIER_LABELS = _default.TIER_LABELS
