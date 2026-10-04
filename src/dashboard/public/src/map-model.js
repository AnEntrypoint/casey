import { state } from './state.js';
import { word } from './words.js';

export const queueName = () => word('legend.queue_name');

export const LOCATION_SOURCE_VALUES = new Set(['gps', 'estimated', 'confirmed', 'unset']);
export const LOCATION_SOURCE_LABEL = {
  get gps() { return word('legend.location_gps'); },
  get estimated() { return word('legend.location_estimated'); },
  get confirmed() { return word('legend.location_confirmed'); },
};

export const URGENCY_BAND_LABEL = {
  get 3() { return word('legend.urgency_3'); },
  get 2() { return word('legend.urgency_2'); },
  get 1() { return word('legend.urgency_1'); },
};

export function urgencyBand(score) {
  if (!Number.isFinite(score)) return 0;
  return score >= 80 ? 3 : score >= 40 ? 2 : 1;
}

export function urgencyByCaseId() {
  const out = new Map();
  for (const c of state.attention || []) {
    if (c && c.id != null) out.set(c.id, urgencyBand(Number(c.score)));
  }
  return out;
}

export function pinMatches(pin, filter, urgency, extent) {
  const f = filter || state.mapFilter;
  const sp = f.species || '', ty = f.type || '', st = f.status || '';
  if (sp && !String(pin.species || '').toLowerCase().includes(sp.toLowerCase())) return false;
  if (ty && pin.case_type !== ty) return false;
  if (st && pin.status !== st) return false;
  if (f.band === 'attention' && !(urgency && urgency.get(pin.id))) return false;
  if (f.band === 'today' && !isToday(pin.created_at)) return false;
  if (f.inView && extent && Number.isFinite(pin.lat) && Number.isFinite(pin.lon)) {
    if (!extent.contains([pin.lat, pin.lon])) return false;
  }
  return true;
}

export function rowMatches(row, pinsById, filter, urgency, extent) {
  const f = filter || state.mapFilter;
  const pin = pinsById.get(row.id);
  if (!pin) return bandOnly(row, f, urgency);
  return pinMatches(pin, f, urgency, extent);
}

function bandOnly(row, f, urgency) {
  if (f.band === 'attention' && !(urgency && urgency.get(row.id))) return false;
  if (f.band === 'today' && !isToday(row.created_at)) return false;
  return true;
}

export function isToday(ts) {
  if (ts == null) return false;
  const n = typeof ts === 'number' ? ts : (/^\d+$/.test(String(ts)) ? Number(ts) : NaN);
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(ts);
  if (Number.isNaN(d.getTime())) return false;
  return d.toDateString() === new Date().toDateString();
}

export function filterIsActive(f) {
  const x = f || state.mapFilter;
  return !!(x.species || x.type || x.status || x.band || x.inView);
}

export function filterOptionsFrom(pins) {
  return {
    species: [...new Set(pins.map((p) => p.species).filter(Boolean))].sort(),
    types: [...new Set(pins.map((p) => p.case_type).filter((t) => t && t !== 'unset'))].sort(),
    statuses: [...new Set(pins.map((p) => p.status))].sort(),
  };
}

export function mapCounts(pins, bounds) {
  const f = state.mapFilter;
  const urgency = urgencyByCaseId();
  const visible = pins.filter((p) => pinMatches(p, f, urgency, f.inView ? bounds : null));
  let inView = null;
  if (bounds) {
    inView = pins.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && bounds.contains([p.lat, p.lon])).length;
  }
  const bands = { 3: 0, 2: 0, 1: 0, 0: 0 };
  for (const p of visible) bands[urgency.get(p.id) || 0] += 1;
  return {
    plotted: pins.length,
    visible: visible.length,
    inView,
    bands,
    attention: (state.attention || []).length,
    today: pins.filter((p) => isToday(p.created_at)).length,
  };
}

export function queueRows(pins, bounds) {
  const f = state.mapFilter;
  const urgency = urgencyByCaseId();
  const byId = new Map();
  for (const p of pins) byId.set(p.id, p);
  const extent = f.inView ? bounds : null;
  return (state.attention || []).filter((c) => rowMatches(c, byId, f, urgency, extent));
}
