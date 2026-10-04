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

export function holderName(assignee) {
  loadOperatorNames();
  const s = String(assignee || '').trim();
  if (!s || s === 'agent') return '';
  if (names && names.has(s)) return names.get(s);
  return s.startsWith('contact:') ? 'a team member' : s;
}
