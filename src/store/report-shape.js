// store/report-shape.js  --  the report-field vocabulary a case's free-form
// report JSON is built from. Config-driven: the actual field list, order, and
// per-field metadata (critical_for_visit / append / never_inferred /
// severity_signal / display_label / section / multiline) come from the
// deployer-selected config package's report-fields.yml (see
// src/config-loader.js), not a hardcoded literal -- this is what makes casey's
// report vocabulary swappable per deployment (AGENTS.md's "configurable like
// thatcher" goal) instead of pinned to the animal-health domain.

import { loadDomainConfig } from '../config-loader.js'

// Pure transform from a report-fields.yml-shaped object into every derived
// shape its importers consume (attn.js, case-health.js, case-store.js,
// case-tools.js and its -record/-shared modules, and the dashboard's
// brand.js/routes/auth.js/routes/cases.js/routes/operations.js). Kept as a
// standalone function, not inlined below, so a deployer whose domain needs
// MULTIPLE schemas coexisting in one running process -- a different field
// vocabulary per record, not one fixed vocabulary per process -- can call it
// directly with a per-record reportFields object instead of the module-level
// one baked in at process start. The module-level exports below remain casey's
// own one-schema-per-process default (CASEY_CONFIG_DIR, resolved once at boot);
// this function must stay purely additive over that path.
export function deriveReportShape(reportFields) {
  if (!reportFields || !Array.isArray(reportFields.fields)) throw new Error('deriveReportShape: reportFields.fields[] required')

  // Same field set the config declares, in declaration order -- REPORT_KEYS is
  // the membership check (pick/filter callers), REPORT_KEY_ORDER is the same
  // set ordered for stable display/fill-rate rendering (dashboard). A single
  // ordered YAML array gives both without a second, driftable ordering to
  // maintain by hand.
  const REPORT_KEYS = new Set(reportFields.fields.map(f => f.key))
  const REPORT_KEY_ORDER = reportFields.fields.map(f => f.key)

  // Fields whose absence blocks the on-site-visit-critical health guardrail
  // (case-health.js VISIT_CRITICAL). Per-field config flag, so a deployer
  // adding/removing a critical field only ever touches report-fields.yml,
  // never case-health.js.
  const CRITICAL_FIELDS = reportFields.fields.filter(f => f.critical_for_visit).map(f => f.key)

  // Fields whose PRESENCE (a non-empty value the reporter already gave --
  // never an LLM inference about severity) nudges a case's attnScore
  // (attn.js) so it surfaces sooner in the operator inbox. Deliberately the
  // same shape as CRITICAL_FIELDS/NEVER_INFERRED_FIELDS: a per-field config
  // flag, never a hardcoded domain literal, so this stays meaningful under
  // any deployed report-fields.yml (e.g. a deployer's dead_count/affected_count
  // for an animal-health domain, or a blocking_work-style field for an
  // IT-helpdesk one) and is a no-op (empty array) when no field opts in, as
  // casey's own generic default does. This is presenting an already-stated
  // fact back to a human, never an assertion about what it means -- attn.js
  // reads only whether the field is present/non-empty, never its content.
  const SEVERITY_SIGNAL_FIELDS = reportFields.fields.filter(f => f.severity_signal).map(f => f.key)

  // Fields that APPEND on every write rather than overwrite.
  const APPEND_FIELDS = new Set(reportFields.fields.filter(f => f.append).map(f => f.key))

  // Fields carrying a structural "must be agent-STATED, never inferred" bound.
  const NEVER_INFERRED_FIELDS = reportFields.fields.filter(f => f.never_inferred)

  // The report fields safe to show in a cross-worker PII-free enquiry list.
  // A config-declared enquiry_headline_fields wins verbatim and is NOT capped
  // here; only the fallback (the first two critical_for_visit fields) is.
  // Keep a declared list to two: it renders as one headline line per row.
  const ENQUIRY_HEADLINE_FIELDS = reportFields.enquiry_headline_fields
    || reportFields.fields.filter(f => f.critical_for_visit).slice(0, 2).map(f => f.key)

  // Plain-language display label per field.
  const FIELD_LABELS = Object.fromEntries(reportFields.fields.map(f => [f.key, f.display_label || f.key]))
  const fieldLabel = (key) => FIELD_LABELS[key] || key

  // Fields grouped into named display sections (config-declared `section`,
  // default 'Other') in field-declaration order, dedup'd.
  const REPORT_SECTIONS = (() => {
    const order = []
    const bySection = new Map()
    for (const f of reportFields.fields) {
      const section = f.section || 'Other'
      if (!bySection.has(section)) { bySection.set(section, []); order.push(section) }
      // Third element is the config's own `multiline` flag. It reaches the
      // client so a PRINTED blank field can be ruled with writing space
      // proportional to the answer expected: one line for a species or a
      // count, several for symptoms or directions to the place. Appended
      // rather than reshaped into an object because both readers destructure
      // a prefix ([k] and [k, label]) and are unaffected by a third slot.
      bySection.get(section).push([f.key, f.display_label || f.key, !!f.multiline])
    }
    return order.map(title => ({ title, keys: bySection.get(title) }))
  })()

  // Dashboard shell shape (brand name + which sidebar nav items to keep/
  // relabel), config-driven for the SAME reason report-field vocabulary is:
  // a deployer whose domain has no "Map"/"Hotspots"/"Reporters" concept
  // (e.g. serpent's research-run tracking) can drop or relabel those nav
  // items via config instead of casey's SPA staying hardcoded to one
  // domain's field-ops vocabulary forever. Absent entirely in casey's own
  // bundled config/default, in which case DASHBOARD_UI is null and every
  // consumer -- brand.js and routes/auth.js and routes/operations.js here,
  // plus every SPA reader of the dashboard_ui it serves -- must fall back to
  // its own hardcoded label/full item set, so this stays purely additive.
  const DASHBOARD_UI = reportFields.dashboard_ui || null

  return {
    REPORT_KEYS, REPORT_KEY_ORDER, CRITICAL_FIELDS, APPEND_FIELDS, NEVER_INFERRED_FIELDS,
    SEVERITY_SIGNAL_FIELDS,
    ENQUIRY_HEADLINE_FIELDS, FIELD_LABELS, fieldLabel, REPORT_SECTIONS,
    REPORT_ENTITY_LABEL: reportFields.entity_label || 'report',
    REPORT_TOOL_NAME: reportFields.tool_name || 'case_report',
    REPORT_TOOL_DESCRIPTION: reportFields.tool_description || '',
    REPORT_FIELD_DEFS: reportFields.fields,
    REPORT_GEO_FIELD_DEFS: reportFields.geo_fields || [],
    DASHBOARD_UI,
  }
}

const _default = deriveReportShape(loadDomainConfig().reportFields)

export const REPORT_KEYS = _default.REPORT_KEYS
export const REPORT_KEY_ORDER = _default.REPORT_KEY_ORDER
export const CRITICAL_FIELDS = _default.CRITICAL_FIELDS
export const APPEND_FIELDS = _default.APPEND_FIELDS
export const NEVER_INFERRED_FIELDS = _default.NEVER_INFERRED_FIELDS
export const SEVERITY_SIGNAL_FIELDS = _default.SEVERITY_SIGNAL_FIELDS
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
