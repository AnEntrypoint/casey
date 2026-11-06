import { fetchOperatorNames } from '../api-team.js';
import { schedule } from '../state.js';

const RETRY_AFTER_MS = 30000;
let names = null;
let loading = false;
let retryAt = 0;
export function loadOperatorNames() {
  if (names || loading || Date.now() < retryAt) return;
  loading = true;
  fetchOperatorNames()
    .then((j) => { names = new Map(((j && j.operators) || []).map((o) => [o.id, o.name])); })
    .catch(() => {
      retryAt = Date.now() + RETRY_AFTER_MS;
      setTimeout(schedule, RETRY_AFTER_MS);
    })
    .then(() => { loading = false; schedule(); });
}

export function holderName(assignee) {
  loadOperatorNames();
  const s = String(assignee || '').trim();
  if (!s || s === 'agent') return '';
  if (names && names.has(s)) return names.get(s);
  return s.startsWith('contact:') ? 'a team member' : s;
}
