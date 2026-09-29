// area-common.js -- what the Areas panel and the case detail's area note share:
// the list of people an area can be given to, and the plain-language wording of
// the "may be in the wrong area" flag. The server derives the flag
// (areas.js possiblyWrongArea); this file only says it in words.
import { fetchTeamMembers } from '../api-team.js';

// people: the choosable rangers, one entry per person. A person with both a WhatsApp
// number and a dashboard login comes back from the server as two entries; the login
// carries `alias_of` and is folded into the WhatsApp one, so the picker lists
// them once and an area that was saved under the login name still shows that person.
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

const list = (names) => names.filter(Boolean).join(' and ');

/** The report's own words for where it is. */
export function placeOf(report) {
  const place = report && report.location != null ? String(report.location).trim() : '';
  return place;
}

/** @returns {string[]} one plain sentence per reason the server gave. */
export function wrongAreaSentences(w, report) {
  if (!w) return [];
  const place = placeOf(report);
  const stated = report && report.association != null ? String(report.association).trim() : '';
  const out = [];
  for (const reason of w.reasons || []) {
    if (reason === 'location_elsewhere' && w.location_area) {
      const covers = list((w.assignee_areas || []).map((a) => a && a.name));
      out.push('The place on the report' + (place ? ' (' + place + ')' : '') + ' is in ' + w.location_area.name + ', but the person holding it covers ' + (covers || 'a different area') + '.');
    } else if (reason === 'association_disagrees' && w.location_area && w.association_area) {
      out.push('The report says the area is ' + w.association_area.name + (stated && stated !== w.association_area.name ? ' (written as "' + stated + '")' : '') + ', but the place' + (place ? ' (' + place + ')' : '') + ' is in ' + w.location_area.name + '.');
    }
  }
  return out;
}

/** The area the flag points at first: where the place is, else where the report says it is. */
export function suggestedArea(w) {
  return (w && (w.location_area || w.association_area)) || null;
}
