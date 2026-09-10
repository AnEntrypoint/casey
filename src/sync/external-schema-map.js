// external-schema-map.js -- best-effort field crosswalk between casey's own
// report vocabulary and the MEAT NATURALLY - AHT Field Tracker app's inferred
// schema.
//
// EXTERNAL_SCHEMA below is USER-SUPPLIED and UNCONFIRMED: synthesized from
// screenshots, terminal sessions, and meeting discussions, not a real API
// contract. Treat every field name and type here as a hypothesis until a live
// integration confirms it. This file makes no network call and mutates no
// casey data on its own -- it is read-only reference data plus a couple of
// pure mapping helpers, consumed by src/sync/correlate-external.js and
// src/sync/apply-link.js.
//
// ADDITIVE-ONLY GUARANTEE: nothing here adds a field to casey's own case,
// contact, or event entities. The only fields this module maps a value INTO
// are casey's existing report-fields.yml REPORT_KEYS and existing contact
// fields (display_name, external_id). A MEAT NATURALLY field with no casey
// counterpart is listed under NO_CASEY_COUNTERPART and is never imported.

export const EXTERNAL_SCHEMA = {
  association: {
    // community association a farmer/visit belongs to
    name: 'text',
    province: 'enum: Eastern Cape | KwaZulu-Natal | Free State',
    district_municipality: 'text',
  },
  farmer: {
    first_name: 'text',
    last_name: 'text',
    phone_number: 'text',
    cattle_count: 'integer',
    sheep_count: 'integer',
    goat_count: 'integer',
  },
  field_visit: {
    visit_date: 'date (YYYY-MM-DD)',
    purpose_of_visit: 'text',
    activities_conducted: 'text',
    outcome_notes: 'text',
    challenges_encountered: 'text',
    proposed_solutions: 'text',
    follow_up_required: 'boolean',
    photo_url: 'text',
    male_attendees: 'integer',
    female_attendees: 'integer',
  },
  follow_up: {
    status: "enum: Open | Action Taken | Resolved",
    issue_summary: 'text',
    resolution_notes: 'text',
  },
}

// Field-level crosswalk: external field path ("kind.field") -> casey target.
// `target` is either "report.<REPORT_KEY>" or "contact.<field>". A row with
// no target is intentionally excluded and belongs in NO_CASEY_COUNTERPART.
export const FIELD_CROSSWALK = [
  { external: 'association.name', target: 'report.location', note: 'best-effort place-name match, not a coordinate' },
  { external: 'farmer.first_name', target: 'report.owner_name', note: 'combine with last_name' },
  { external: 'farmer.last_name', target: 'report.owner_name', note: 'combine with first_name' },
  { external: 'farmer.phone_number', target: 'report.owner_contact' },
  { external: 'farmer.phone_number', target: 'contact.external_id', note: 'only when correlating to a whatsapp-identified contact, never overwrites a real channel id' },
  { external: 'field_visit.activities_conducted', target: 'report.notes' },
  { external: 'field_visit.outcome_notes', target: 'report.notes' },
  { external: 'field_visit.challenges_encountered', target: 'report.notes' },
  { external: 'field_visit.photo_url', target: 'report.photos' },
  { external: 'field_visit.visit_date', target: 'report.onset', note: 'weak signal only -- a visit date is not an onset date, use for temporal correlation, never a direct overwrite' },
  { external: 'follow_up.issue_summary', target: 'report.notes' },
]

// Every MEAT NATURALLY field explicitly NOT imported: no casey counterpart.
// Kept here so a future reader does not re-propose importing them.
export const NO_CASEY_COUNTERPART = [
  'vehicle_logbook.*', 'monthly_targets.*', 'monthly_reports.*',
  'daily_accountability.*', 'users.role', 'users.is_active',
  'document_vault.category', 'document_vault.file_size_bytes',
  'resource_library.*', 'analytics.*', 'annual_comparison.*',
]

// mapExternalFieldsToReport(externalRecord, kind)
// externalRecord: a flat object keyed by EXTERNAL_SCHEMA[kind]'s field names.
// kind: one of 'association' | 'farmer' | 'field_visit' | 'follow_up'.
// Returns a partial report-shape object using ONLY known REPORT_KEYS -- never
// invents a key outside FIELD_CROSSWALK's declared targets. Fill-if-empty
// semantics are the caller's job (see report-merge.js's fillIfEmptyReport);
// this function only maps, it never merges or overwrites.
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

// mapExternalFieldsToContact(externalRecord, kind)
// Same discipline, restricted to contact.external_id -- never touches
// display_name/tier/other contact fields, since those carry channel-identity
// and access-control meaning this crosswalk has no authority over.
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
