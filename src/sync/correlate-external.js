
const NAME_MATCH_WEIGHT = 0.4;
const PHONE_MATCH_WEIGHT = 0.4;
const LOCATION_MATCH_WEIGHT = 0.15;
const DATE_PROXIMITY_WEIGHT = 0.05;
const DATE_PROXIMITY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_CONFIDENCE_TO_PROPOSE = 0.35;

function normPhone(p) {
  if (!p) return '';
  return String(p).replace(/[^\d]/g, '').replace(/^0/, '27').replace(/^27?27/, '27');
}

function normText(s) {
  if (!s) return '';
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokenOverlap(a, b) {
  const ta = new Set(normText(a).split(' ').filter(Boolean));
  const tb = new Set(normText(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

function dateProximityScore(aIso, bIso) {
  if (!aIso || !bIso) return 0;
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const diff = Math.abs(a - b);
  if (diff > DATE_PROXIMITY_WINDOW_MS) return 0;
  return 1 - diff / DATE_PROXIMITY_WINDOW_MS;
}

function localFingerprint(entityKind, row) {
  if (entityKind === 'case') {
    let report = {};
    try { report = row.report ? JSON.parse(row.report) : {}; } catch { report = {}; }
    return {
      name: report.owner_name || report.present_person || null,
      phone: report.contact_fallback || null,
      location: report.location || null,
      date: row.created_at || null,
    };
  }
  return {
    name: row.display_name || null,
    phone: row.channel === 'whatsapp' ? row.external_id : null,
    location: null,
    date: row.created_at || null,
  };
}

export function scoreCandidate(localKind, localRow, externalRecord) {
  const fp = localFingerprint(localKind, localRow);
  const bases = [];
  let score = 0;

  const nameScore = tokenOverlap(fp.name, externalRecord.name);
  if (nameScore > 0) { score += nameScore * NAME_MATCH_WEIGHT; bases.push('name'); }

  const pa = normPhone(fp.phone), pb = normPhone(externalRecord.phone);
  if (pa && pb && pa === pb) { score += PHONE_MATCH_WEIGHT; bases.push('phone'); }

  const locScore = tokenOverlap(fp.location, externalRecord.location);
  if (locScore > 0) { score += locScore * LOCATION_MATCH_WEIGHT; bases.push('location'); }

  const dateScore = dateProximityScore(fp.date, externalRecord.date);
  if (dateScore > 0) { score += dateScore * DATE_PROXIMITY_WEIGHT; bases.push('date'); }

  return { confidence: Math.min(1, Math.round(score * 1000) / 1000), match_basis: bases.join('+') || 'none' };
}

function normalizeManualImportRecord(row, index) {
  return {
    system: 'meat_naturally',
    kind: row.kind,
    external_id: `manual-import-${row.kind}-${index}`,
    external_ref: row.farmer_name || row.association || `${row.kind} #${index}`,
    name: row.farmer_name || null,
    phone: row.farmer_phone || null,
    location: row.association || null,
    date: row.visit_date || null,
  };
}

export async function findCandidatesFromManualImport({ file, kind, cases = [], contacts = [] }) {
  const { loadManualImport } = await import('../../bin/casey-sync-import-command.js');
  const rows = loadManualImport(file, kind);
  const externalRecords = rows.map((row, i) => normalizeManualImportRecord(row, i));
  return findCandidates({ cases, contacts, externalRecords });
}

export function findCandidates({ cases = [], contacts = [], externalRecords = [] }) {
  const out = [];
  for (const rec of externalRecords) {
    for (const c of cases) {
      const { confidence, match_basis } = scoreCandidate('case', c, rec);
      if (confidence >= MIN_CONFIDENCE_TO_PROPOSE) {
        out.push({
          local_entity: 'case', local_id: c.id,
          external_entity: rec.kind, external_id: rec.external_id, external_ref: rec.external_ref || rec.external_id,
          system: rec.system, match_basis, confidence,
        });
      }
    }
    for (const ct of contacts) {
      const { confidence, match_basis } = scoreCandidate('contact', ct, rec);
      if (confidence >= MIN_CONFIDENCE_TO_PROPOSE) {
        out.push({
          local_entity: 'contact', local_id: ct.id,
          external_entity: rec.kind, external_id: rec.external_id, external_ref: rec.external_ref || rec.external_id,
          system: rec.system, match_basis, confidence,
        });
      }
    }
  }
  return out;
}

export async function writeProposedLinks(store, candidates, actingUser) {
  const written = [];
  for (const cand of candidates) {
    const existing = await store.t.list('external_link', {
      local_entity: cand.local_entity, local_id: cand.local_id,
      external_entity: cand.external_entity, external_id: cand.external_id,
    }, { limit: 5 });
    if (existing.some(l => l.status !== 'rejected')) continue;
    const row = await store.t.create('external_link', {
      system: cand.system, local_entity: cand.local_entity, local_id: cand.local_id,
      external_entity: cand.external_entity, external_id: cand.external_id,
      external_ref: cand.external_ref, match_basis: cand.match_basis,
      confidence: String(cand.confidence), status: 'proposed', notes: '',
    }, actingUser);
    written.push(row);
  }
  return written;
}
