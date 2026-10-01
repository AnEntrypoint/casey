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
