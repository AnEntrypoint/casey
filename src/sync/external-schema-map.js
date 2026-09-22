// external-schema-map.js -- best-effort field crosswalk between casey's own
// report vocabulary and the MEAT NATURALLY - AHT Field Tracker app's inferred
// schema.
//
// EXTERNAL_SCHEMA below is USER-SUPPLIED and UNCONFIRMED: reconstructed from a
// live demo walkthrough of the other app plus screenshots, terminal sessions,
// and meeting discussion -- not a real API contract. Field NAMES here are this
// side's normalization, not the remote system's wire names, and every type is a
// hypothesis until a live integration confirms it. This file makes no network
// call and mutates no
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
  aht_user: {
    // the Animal Health Technician who logs a visit; a dropdown on their side
    aht_id: 'text',
    aht_name: 'text',
    role: 'text',
    is_active: 'boolean',
    allocated_associations: 'text (technician-to-community allocation mapping)',
  },
  association: {
    // community association a farmer/visit belongs to
    name: 'text',
    province: 'enum: Eastern Cape | KwaZulu-Natal | Free State',
    district_municipality: 'text',
    project_phase: 'text (their programme classification tier)',
    target_scope: 'text (admin level a performance target is set at)',
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
    aht_id: 'text (FK to aht_user)',
    visit_date: 'date (YYYY-MM-DD)',
    association_name: 'text (dropdown: association/community visited)',
    purpose_of_visit: 'text (categorized dropdown)',
    activities_conducted: 'text',
    male_attendees: 'integer',
    female_attendees: 'integer',
    outcome_notes: 'text',
    challenges_encountered: 'text',
    proposed_solutions: 'text',
    follow_up_required: 'boolean',
    photo_url: 'text (meeting photo / file attachment)',
    batch_visit_id: 'text (key grouping one multi-site batch submission)',
  },
  vehicle_trip_log: {
    trip_log_id: 'text',
    field_visit_id: 'text (FK to field_visit)',
    monthly_distance_km: 'number (per technician)',
  },
  daily_accountability: {
    aht_id: 'text (FK to aht_user)',
    log_date: 'date (YYYY-MM-DD)',
    field_visits_logged_count: 'integer',
    admin_days_logged_count: 'integer',
    submission_status: 'enum: Submitted | Missing | On Leave | Sick',
    compliance_percent: 'number (0-100)',
  },
  document_vault: {
    document_id: 'text',
    title: 'text',
    category: 'enum: Operational Template | Farmer Training Material | Meeting Register | Herd Health Plan | Production Plan',
    linked_visit_id: 'text (FK to field_visit)',
    uploader_user_id: 'text',
    uploader_name: 'text',
    uploaded_at: 'timestamp',
    file_url: 'text',
    file_size_bytes: 'integer',
  },
  follow_up: {
    follow_up_id: 'text',
    status: 'enum: Open | Action Taken | Resolved',
    issue_summary: 'text',
    resolution_notes: 'text',
    target_resolution_from: 'date (YYYY-MM-DD)',
    target_resolution_to: 'date (YYYY-MM-DD)',
    assigned_association: 'text (community/association the follow-up sits with)',
  },
  targets_analytics: {
    aht_id: 'text (FK to aht_user)',
    monthly_target_visits: 'integer',
    total_visits: 'integer',
    community_coverage_count: 'integer',
    open_follow_ups: 'integer',
    progress_vs_target_percent: 'number (0-100, leaderboard metric)',
  },
}

// Field-level crosswalk: external field path ("kind.field") -> casey target.
// `target` is either "report.<REPORT_KEY>" or "contact.<field>". A row with
// no target is intentionally excluded and belongs in NO_CASEY_COUNTERPART.
export const FIELD_CROSSWALK = [
  { external: 'aht_user.aht_name', target: 'report.present_person', note: 'the technician on site is the person present; their relation is always the same role, so present_person_relation is left to the casey-side intake rather than stamped from here' },
  { external: 'aht_user.aht_id', target: 'report.present_person', note: 'id fallback, used only when aht_name is absent (the aht_name row above is declared first and wins)' },
  { external: 'association.name', target: 'report.location', note: 'best-effort place-name match, not a coordinate' },
  { external: 'association.province', target: 'report.location', note: 'coarse fallback only -- fills location when no association/community name is present, never over a stated place (first row wins)' },
  { external: 'farmer.first_name', target: 'report.owner_name', note: 'combine with last_name' },
  { external: 'farmer.last_name', target: 'report.owner_name', note: 'combine with first_name' },
  { external: 'farmer.phone_number', target: 'report.owner_contact' },
  { external: 'farmer.phone_number', target: 'contact.external_id', note: 'only when correlating to a whatsapp-identified contact, never overwrites a real channel id' },
  { external: 'field_visit.aht_id', target: 'report.present_person', note: 'id fallback when aht_name is absent from the record' },
  { external: 'field_visit.association_name', target: 'report.location', note: 'the community visited, best-effort place-name match' },
  { external: 'field_visit.purpose_of_visit', target: 'report.notes', note: 'a categorized dropdown on their side; recorded as prose, never mapped onto the casey-side case_type enum' },
  { external: 'field_visit.activities_conducted', target: 'report.notes' },
  { external: 'field_visit.outcome_notes', target: 'report.notes' },
  { external: 'field_visit.challenges_encountered', target: 'report.notes' },
  { external: 'field_visit.proposed_solutions', target: 'report.notes' },
  { external: 'field_visit.photo_url', target: 'report.photos' },
  { external: 'field_visit.visit_date', target: 'report.onset', note: 'weak signal only -- a visit date is not an onset date, use for temporal correlation, never a direct overwrite' },
  { external: 'follow_up.issue_summary', target: 'report.notes' },
  { external: 'follow_up.resolution_notes', target: 'report.notes' },
  { external: 'follow_up.assigned_association', target: 'report.location', note: 'same best-effort place-name basis as association.name' },
]

// Every MEAT NATURALLY field explicitly NOT imported: no casey counterpart.
// Kept here so a future reader does not re-propose importing them. A one-line
// reason per row, because "no counterpart" is a judgement and the next reader
// deserves the argument rather than the verdict.
export const NO_CASEY_COUNTERPART = [
  // -- Field visit & batch logging
  { external: 'field_visit.male_attendees', why: 'a meeting headcount of people, not animals -- mapping it onto affected_count/herd_total would put human attendance into an animal-count field feeding the attention ranking' },
  { external: 'field_visit.female_attendees', why: 'same as male_attendees: people at a meeting, never an animal count' },
  { external: 'field_visit.follow_up_required', why: 'their workflow flag; the casey-side case lifecycle is its own xstate machine and is never driven by a remote boolean' },
  { external: 'field_visit.batch_visit_id', why: 'their submission-grouping key -- correlation metadata, belongs in external_link.match_basis/external_ref, never in a report field. Not report.sites either: sites describes a second place a worker actually saw, not how a form was batched' },
  // -- Travel & vehicle logging
  { external: 'vehicle_trip_log.*', why: 'logistics and expense accounting (trip ids, per-technician monthly kilometres) with no animal-health meaning; the FK to field_visit is correlation metadata external_link already carries' },
  // -- Geographical & organizational hierarchy
  { external: 'association.district_municipality', why: 'an administrative tier with no report field of its own; place understanding in casey is the words of the reporter plus a model-estimated coordinate, never a gazetteer join' },
  { external: 'association.project_phase', why: 'their programme classification tier -- describes their rollout, not the animals or the place' },
  { external: 'association.target_scope', why: 'the admin level a performance target is set at; a target-setting parameter, not an observation' },
  { external: 'aht_user.allocated_associations', why: 'their staffing roster (technician-to-community allocation); the casey-side coverage/operator model is learned from its own authenticated sessions, never asserted from another system' },
  { external: 'aht_user.role', why: 'their access-control vocabulary; the casey-side contact tier is operator-assigned and fails closed, so it is never settable from outside' },
  { external: 'aht_user.is_active', why: 'their account state, same reason as role' },
  // -- Daily accountability & officer status
  { external: 'daily_accountability.*', why: 'per-officer daily compliance internals (visits logged, admin days, Submitted/Missing/On Leave/Sick, compliance percent) -- a management-performance surface about their staff, not a fact about a case' },
  // -- Document vault & resource metadata
  { external: 'document_vault.*', why: 'operational templates, training material, registers and herd/production plans plus their upload metadata. Deliberately NOT report.photos: a vault document is an office artefact, not a field photo of an affected animal, and importing one would put a template into a case evidence field' },
  // -- Issue & follow-up tracker
  { external: 'follow_up.follow_up_id', why: 'their record id -- correlation metadata for external_link.external_id, not a report value' },
  { external: 'follow_up.status', why: 'their Open/Action Taken/Resolved flag; the casey-side case status comes from its lifecycle machine and an operator transition, never a remote write' },
  { external: 'follow_up.target_resolution_from', why: 'their SLA window; the casey-side SLA clock is attn.js own and must not be reset by a remote schedule' },
  { external: 'follow_up.target_resolution_to', why: 'same as target_resolution_from' },
  // -- Farmer production census
  { external: 'farmer.cattle_count', why: 'a production census of the whole holding of a farmer, not herd_total at the visited location -- and inferring species from a nonzero count is exactly the guess report-fields.yml forbids' },
  { external: 'farmer.sheep_count', why: 'same as cattle_count' },
  { external: 'farmer.goat_count', why: 'same as cattle_count' },
  // -- System targets & analytics
  { external: 'targets_analytics.*', why: 'quotas, totals, coverage counts and leaderboard/progress metrics -- derived management analytics, and the casey-side aggregates are computed from its own event log so importing a remote total would double-count' },
]

// mapExternalFieldsToReport(externalRecord, kind)
// externalRecord: a flat object keyed by EXTERNAL_SCHEMA[kind]'s field names.
// kind: one of EXTERNAL_SCHEMA's own keys (aht_user | association | farmer |
//   field_visit | vehicle_trip_log | daily_accountability | document_vault |
//   follow_up | targets_analytics). Kinds with no FIELD_CROSSWALK row of their
//   own map to {} by construction -- see NO_CASEY_COUNTERPART.
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
