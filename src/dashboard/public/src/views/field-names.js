// field-names.js -- turns the login name on a field list row into the person's own
// name. A field login may not read the team roster, but it may read the dashboard
// logins by name (GET /api/operators), which is enough to say "sent by Anna" for a
// ranger who works from the dashboard. A WhatsApp team member is already named by
// the server on every list.
import { fetchOperatorNames } from '../api-team.js';
import { schedule } from '../state.js';

let names = null;
let loading = false;
export function loadOperatorNames() {
  if (names || loading) return;
  loading = true;
  fetchOperatorNames()
    .then((j) => { names = new Map(((j && j.operators) || []).map((o) => [o.id, o.name])); })
    .catch(() => { names = new Map(); })
    .then(() => { loading = false; schedule(); });
}

/** @returns {string} the holder's own name, or '' when nobody holds the report. */
export function holderName(assignee) {
  loadOperatorNames();
  const s = String(assignee || '').trim();
  if (!s || s === 'agent') return '';
  if (names && names.has(s)) return names.get(s);
  return s.startsWith('contact:') ? 'a team member' : s;
}
