import { state } from './state.js';

export function activeConfig() { return state.runConfig || state.config; }

export function botNumber() { return state.config?.whatsapp_number || ''; }
export function brandName() { return activeConfig()?.dashboard_ui?.brand || state.config?.dashboard_ui?.brand || 'casey'; }

export function entityLabel() { return activeConfig()?.entity_label || 'report'; }

export function EntityLabel() {
  const s = entityLabel();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function entityLabelPlural() { return entityLabel() + 's'; }

export function EntityLabelPlural() { return EntityLabel() + 's'; }

export function countOf(n, one, many) {
  const k = Number(n) || 0;
  const s = one || entityLabel();
  return k === 1 ? `${k} ${s}` : `${k} ${many || (s + 's')}`;
}

export const TIER_ORDER = ['reporter', 'field_worker', 'animal_health_technician', 'operator'];

export function tierValue(tier) {
  return TIER_ORDER.includes(tier) ? tier : TIER_ORDER[0];
}

export function tierLabel(tier) {
  const t = tierValue(tier);
  const labels = activeConfig()?.tier_labels || state.config?.tier_labels || null;
  if (labels && typeof labels[t] === 'string' && labels[t].trim()) return labels[t].trim();
  return t.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase());
}

export function tierAbove(tier) {
  const i = TIER_ORDER.indexOf(tierValue(tier));
  return i >= 0 && i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : null;
}

export function tierBelow(tier) {
  const i = TIER_ORDER.indexOf(tierValue(tier));
  return i > 0 ? TIER_ORDER[i - 1] : null;
}
