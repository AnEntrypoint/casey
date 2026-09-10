// correlate-external.js -- proposes cross-system links between casey's own
// case/contact rows and normalized external records from another system
// (see EXTERNAL-SYNC.md). Pure scoring: never writes case/contact data,
// never confirms a link on its own. writeProposedLinks() is the one function
// that touches the store, and it only ever creates external_link rows with
// status='proposed' -- a human confirms via the dashboard (see
// src/sync/apply-link.js), which is the only path that ever mutates a real
// case/contact field.
//
// Normalized external record shape (what an adapter/manual-import produces):
//   {
//     system: 'meat_naturally',
//     kind: 'field_visit'|'farmer'|'association',
//     external_id: string,
//     external_ref: string,        // display-safe label, e.g. "Visit CASE-... 2026-08-12"
//     name: string|null,           // farmer/reporter name, for name matching
//     phone: string|null,          // farmer/reporter phone, for contact matching
//     location: string|null,       // community/association name, for location matching
//     date: string|null,           // ISO date, for temporal matching (visit_date)
//   }

const NAME_MATCH_WEIGHT = 0.4;
const PHONE_MATCH_WEIGHT = 0.4;
const LOCATION_MATCH_WEIGHT = 0.15;
const DATE_PROXIMITY_WEIGHT = 0.05;
const DATE_PROXIMITY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MIN_CONFIDENCE_TO_PROPOSE = 0.35;

function normPhone(p) {
  if (!p) return '';
  return String(p).replace(/[^\d]/g, '').replace(/^0/, '27').replace(/^27?27/, '27');
}

function normText(s) {
  if (!s) return '';
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

// Cheap token-overlap similarity, deliberately not a full edit-distance
// library: names/locations here are short (1-4 words), and this project's
// own conventions favor a smaller dependency-free implementation over a
// heavier NPM package for a few lines (see AGENTS.md "Kit consumption
// strategy" cost-tradeoff framing, applied here to a matching heuristic).
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

// Extracts the fields a local case/contact carries that are usable for
// matching -- report.owner_name/owner_contact/location for a case,
// display_name/external_id for a contact.
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
  // contact
  return {
    name: row.display_name || null,
    phone: row.channel === 'whatsapp' ? row.external_id : null,
    location: null,
    date: row.created_at || null,
  };
}

// scoreCandidate: pure function, one local row against one external record.
// Returns { confidence, match_basis } -- match_basis lists which signals fired.
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

// findCandidates: cross-product local rows x external records, keeping only
// scores at/above MIN_CONFIDENCE_TO_PROPOSE. O(n*m) -- fine at casey's real
// scale (hundreds of cases, tens of external records per sync pass); a
// bigger deployment would need a blocking/indexing pass first, out of scope
// for this speculative-prep seam.
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

// writeProposedLinks: the ONLY function in this module that touches the
// store. Writes each candidate as an external_link row with status
// 'proposed' -- never 'confirmed'. Skips a candidate that already has a
// non-rejected link for the same (local_entity, local_id, external_entity,
// external_id) tuple, so re-running a sync pass does not spam duplicate rows.
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
