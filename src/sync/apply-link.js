// apply-link.js -- the ONLY place a confirmed cross-system link is allowed to
// touch real case/contact data. Confirmation itself is a human dashboard
// action (routes/external-links.js); this module runs the fill-if-empty
// consolidation once that confirmation lands, and never overwrites a
// human-entered value (report-merge.js's fillIfEmptyReport already
// guarantees that -- see its own header comment).
//
// externalRecordToReportPatch is a deliberately minimal inline mapping using
// only casey's own REPORT_KEYS (report-fields.yml's declared vocabulary --
// see AGENTS.md "we don't want to add fields that don't relate to our app").
// Swap this for src/sync/external-schema-map.js's shared crosswalk once that
// module exists; this file's own mapping must never diverge from that one on
// the fields both touch.
import { REPORT_KEYS } from '../store/report-shape.js';
import { fillIfEmptyReport } from '../store/report-merge.js';

const FIELD_MAP = {
  location: 'location',
  name: 'owner_name',
  phone: 'contact_fallback',
  photo_url: 'photos',
  species: 'species',
  notes: 'notes',
};

export function externalRecordToReportPatch(externalRecord) {
  const patch = {};
  for (const [srcKey, reportKey] of Object.entries(FIELD_MAP)) {
    if (!REPORT_KEYS.has(reportKey)) continue;
    const v = externalRecord[srcKey];
    if (v != null && String(v).trim() !== '') patch[reportKey] = v;
  }
  return patch;
}

// applyConfirmedLink: given a link row already flipped to status='confirmed'
// and the external record it points at, fills any EMPTY case.report fields
// from the mapped external values. Status stays 'confirmed' (the entity's
// enum is proposed/confirmed/rejected only, see external_link's field
// contract) -- re-running this on an already-applied link is safe because
// fillIfEmptyReport is itself idempotent: a field already filled from the
// first apply is already non-empty, so a second pass changes nothing.
// Only handles local_entity === 'case' -- a confirmed contact link has no
// report to fill into and is left for a future PRD row if a real use emerges.
export async function applyConfirmedLink(link, externalRecord, store, actingUser) {
  if (link.status !== 'confirmed') throw new Error('applyConfirmedLink requires a confirmed link, got status=' + link.status);
  if (link.local_entity !== 'case') {
    return { applied: false, reason: 'local_entity is not case; nothing to fill' };
  }

  const caseRow = await store.t.get('case', link.local_id);
  if (!caseRow) throw new Error('applyConfirmedLink: local case ' + link.local_id + ' not found');

  let currentReport = {};
  try { currentReport = caseRow.report ? JSON.parse(caseRow.report) : {}; } catch { currentReport = {}; }

  const patch = externalRecordToReportPatch(externalRecord);
  const merged = fillIfEmptyReport(currentReport, patch);

  const changed = Object.keys(merged).some(k => JSON.stringify(merged[k]) !== JSON.stringify(currentReport[k]));
  if (changed) {
    await store.t.update('case', caseRow.id, { report: JSON.stringify(merged) }, actingUser, { expectedVersion: caseRow._version });
  }
  return { applied: changed, filledFields: Object.keys(merged).filter(k => JSON.stringify(merged[k]) !== JSON.stringify(currentReport[k])) };
}
