import { fetchTeamMembers } from '../api-team.js';
import { word } from '../words.js';

let cache = null;
export function resetPeople() { cache = null; }
export async function loadPeople() {
  if (cache) return cache;
  const j = await fetchTeamMembers();
  const members = (j && j.members) || [];
  const canon = new Map();
  for (const m of members) canon.set(m.key, m.alias_of || m.key);
  const people = members.filter((m) => !m.alias_of);
  const nameOf = new Map(people.map((m) => [m.key, m.name]));
  cache = { people, canon, nameOf };
  return cache;
}
export const canonicalKey = (p, key) => (p && p.canon.get(key)) || key;
export const personName = (p, key) => (p && p.nameOf.get(canonicalKey(p, key))) || (p && p.nameOf.get(key)) || key;

const list = (names) => names.filter(Boolean).join(word('ui.area_common_and'));

export function placeOf(report) {
  const place = report && report.location != null ? String(report.location).trim() : '';
  return place;
}

export function wrongAreaSentences(w, report) {
  if (!w) return [];
  const place = placeOf(report);
  const placeText = place ? ' (' + place + ')' : '';
  const stated = report && report.association != null ? String(report.association).trim() : '';
  const out = [];
  for (const reason of w.reasons || []) {
    if (reason === 'location_elsewhere' && w.location_area) {
      const covers = list((w.assignee_areas || []).map((a) => a && a.name));
      out.push(word('ui.area_common_location_elsewhere', {
        place: placeText,
        area: w.location_area.name,
        covers: covers || word('ui.area_common_different_area'),
      }));
    } else if (reason === 'association_disagrees' && w.location_area && w.association_area) {
      const written = stated && stated !== w.association_area.name ? word('ui.area_common_written_as', { stated }) : '';
      out.push(word('ui.area_common_association_disagrees', {
        association: w.association_area.name,
        written,
        place: placeText,
        area: w.location_area.name,
      }));
    }
  }
  return out;
}

export function suggestedArea(w) {
  return (w && (w.location_area || w.association_area)) || null;
}
