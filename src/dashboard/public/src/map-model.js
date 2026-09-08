// The one model the map and the rail both read.
//
// Why this module exists: before it, the two halves of the home view answered
// different questions off different data and visibly disagreed on screen. The
// map coloured pins by STATUS while the rail ranked rows by attn.js's
// worst-first SCORE, so an operator looking at a field of green dots had no
// way to tell which one was breaching. And the rail head's "Needs attention"
// count read the untruncated attention list while the list under it showed
// slice(0,5), so the same screen stated 14 and showed 5.
//
// Both failures have the same shape: two consumers each deriving their own
// answer. So the derivations live here once -- the urgency ladder, and the
// filter predicate -- and map-leaflet.js and map-panel.js both import them.
// Neither is allowed a local copy; that is the whole point.

import { state } from './state.js';

// ---- urgency ------------------------------------------------------------
// attn.js's score, cut into three bands. These exact thresholds were already
// in map-panel.js's rail feed (the heat-1/2/3 ladder); they are lifted here
// unchanged so the pin and the row for the SAME case can never land in
// different bands.
export const URGENCY_BAND_LABEL = {
  3: 'needs a person now',
  2: 'needs a look today',
  1: 'in the queue',
};

export function urgencyBand(score) {
  if (!Number.isFinite(score)) return 0;
  return score >= 80 ? 3 : score >= 40 ? 2 : 1;
}

// id -> band, built once per render pass from the live attention list. A case
// absent from that list has no band (0) and renders at its base size -- absent
// is a real answer here ("nothing is chasing this one"), never a hidden pin.
export function urgencyByCaseId() {
  const out = new Map();
  for (const c of state.attention || []) {
    if (c && c.id != null) out.set(c.id, urgencyBand(Number(c.score)));
  }
  return out;
}

// ---- the shared filter --------------------------------------------------
// state.mapFilter is the single filter object. `days` is the only field that
// changes what the SERVER returns (fetchMapCases({days})); every other field
// narrows what is already loaded, on both surfaces at once.
//
// The filter's DEFAULT SHAPE is state.js's defaultMapFilter(), not a second
// copy here. A duplicate of it used to live in this file, exported and
// imported by nobody, while state.js built the same object inline -- two
// definitions of one thing, in the module whose entire purpose is that there
// is only ever one. It is defined next to the state it initialises because
// this module already imports `state`, so defining it here and importing it
// there would close an import cycle.

// A pin (from /api/map/cases) and an attention row describe the same case with
// different field sets, so the predicate takes what it needs explicitly rather
// than guessing which shape it was handed.
export function pinMatches(pin, filter, urgency, extent) {
  const f = filter || state.mapFilter;
  const sp = f.species || '', ty = f.type || '', st = f.status || '';
  if (sp && !String(pin.species || '').toLowerCase().includes(sp.toLowerCase())) return false;
  if (ty && pin.case_type !== ty) return false;
  if (st && pin.status !== st) return false;
  if (f.band === 'attention' && !(urgency && urgency.get(pin.id))) return false;
  if (f.band === 'today' && !isToday(pin.created_at)) return false;
  // Extent narrowing applies ONLY when the operator turned it on, and only to
  // things that have a position to test. A case with no coordinate is not
  // "outside the view" -- it is nowhere, and it stays in the no-location
  // disclosure rather than being silently dropped by a spatial filter.
  if (f.inView && extent && Number.isFinite(pin.lat) && Number.isFinite(pin.lon)) {
    if (!extent.contains([pin.lat, pin.lon])) return false;
  }
  return true;
}

// The rail's rows come from state.attention, which carries no species/type/
// coordinates -- so the rail resolves each row against the loaded pin set and
// applies the SAME predicate. A row whose case never made it onto the map
// (no coordinate) is kept: it still needs a person, and hiding it because it
// cannot be plotted is exactly the blind spot this dashboard exists to avoid.
export function rowMatches(row, pinsById, filter, urgency, extent) {
  const f = filter || state.mapFilter;
  const pin = pinsById.get(row.id);
  // No pin means no coordinate, so the extent is not applicable and `extent`
  // is deliberately not passed on: a case with no position is not "outside the
  // viewport", it is nowhere, and a spatial filter must never be what makes it
  // disappear. Only the band filters, which are spatial in no sense, still
  // apply. This used to read `!f.inView && !f.band ? true : bandOnly(...)`,
  // which evaluates to exactly bandOnly() -- bandOnly's two checks are both
  // gated on f.band, so it already returns true when no band is set -- but the
  // dead guard in front of it read as though inView were being handled here,
  // which is the one thing this line must not be ambiguous about.
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
  // Timestamps arrive as ms, as seconds, or as a digit STRING -- busybase
  // returns numeric-seconds strings (see AGENTS.md's thatcher/busybase note),
  // and a bare Date.parse on those yields Invalid Date, which would silently
  // make "New today" always zero.
  const n = typeof ts === 'number' ? ts : (/^\d+$/.test(String(ts)) ? Number(ts) : NaN);
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(ts);
  if (Number.isNaN(d.getTime())) return false;
  return d.toDateString() === new Date().toDateString();
}

export function filterIsActive(f) {
  const x = f || state.mapFilter;
  return !!(x.species || x.type || x.status || x.band || x.inView);
}
