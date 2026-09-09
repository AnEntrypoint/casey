// RESPONSIBILITY: every derivation over case data that the map and the rail
// would otherwise each compute for themselves -- the urgency ladder, the shared
// filter predicate, the filter vocabulary, and the counts both surfaces state.
//
// Why that is one module: before it, the two halves of the home view answered
// different questions off different data and visibly disagreed on screen. The
// map coloured pins by STATUS while the rail ranked rows by attn.js's
// worst-first SCORE, so an operator looking at a field of green dots had no
// way to tell which one was breaching. And the rail head's "Needs attention"
// count read the untruncated attention list while the list under it showed
// slice(0,5), so the same screen stated 14 and showed 5.
//
// Both failures have the same shape: two consumers each deriving their own
// answer. So the derivations live here once and every consumer imports them.
// None is allowed a local copy; that is the whole point.
//
// The line this module is on: nothing here touches the DOM, Leaflet or webjsx.
// It takes plain pin/row objects and returns plain answers, which is what lets
// the imperative map driver and the declarative chrome share it without either
// depending on the other.

import { state } from './state.js';

// ---- the queue's name ---------------------------------------------------
// The worst-first queue is ONE list and it has ONE name. It used to be called
// "Needs a person" on the map rail, "Needs a person now" on the case-list
// side, "Needs you now" in the glossary, the handover digest and the
// onboarding overlay, and "the inbox" in the snooze dialog -- five names for
// one thing, taught to an operator on their first shift. Every surface that
// names it imports this, for the same reason the urgency ladder below lives
// here rather than in each consumer.
export const QUEUE_NAME = 'Needs a person';

// ---- where a coordinate came from ---------------------------------------
// The provenance ladder a lat/lon arrives on. Three surfaces read it -- the
// case pin's border treatment, the worker pin's stroke, and the legend that
// documents both -- and they are on two different modules, so the vocabulary
// lives here for the same reason QUEUE_NAME does: one name for one thing.
//
// 'unset' (a row predating the field) is deliberately unlabelled: it says
// nothing rather than implying a false certainty either way.
export const LOCATION_SOURCE_VALUES = new Set(['gps', 'estimated', 'confirmed', 'unset']);
export const LOCATION_SOURCE_LABEL = { gps: 'exact GPS', estimated: 'estimated, unconfirmed', confirmed: 'estimated, confirmed by worker' };

// ---- urgency ------------------------------------------------------------
// attn.js's score, cut into three bands. These exact thresholds were already
// in map-panel.js's rail feed (the heat-1/2/3 ladder); they are lifted here
// unchanged so the pin and the row for the SAME case can never land in
// different bands.
// Three rungs of one urgency ladder. Band 1 used to read "in the queue",
// which named the LIST rather than the rung and made "the queue" a fifth
// name for it beside the four the UI already had. The list has one name
// (QUEUE_NAME); these three say how soon, not where.
export const URGENCY_BAND_LABEL = {
  3: 'needs a person now',
  2: 'needs a look today',
  1: 'can wait',
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

// ---- the filter's vocabulary --------------------------------------------
// The option lists the rail's Select controls offer, taken from the pins that
// actually loaded rather than from a fixed vocabulary -- a filter that offers a
// species no report has is a control that can only ever empty the map. It is a
// derivation over the same pin set the predicate above reads, which is why it
// sits beside it rather than in the Leaflet driver that happens to fetch them.
export function filterOptionsFrom(pins) {
  return {
    species: [...new Set(pins.map((p) => p.species).filter(Boolean))].sort(),
    types: [...new Set(pins.map((p) => p.case_type).filter((t) => t && t !== 'unset'))].sort(),
    statuses: [...new Set(pins.map((p) => p.status))].sort(),
  };
}

// ---- the counts, derived once -------------------------------------------
// Every number either surface states -- a rail chip, the map's spoken text
// equivalent, the state note, the debug snapshot -- is counted here, over the
// predicate and the urgency ladder above. The chips and the text equivalent are
// two renderings of the same screen for two different readers, so a second
// count for either is the same defect as a second copy of the predicate: the
// map and the words about it would be able to disagree.
//
// `bounds` is the map's RAW viewport (or null when no map is mounted). The
// extent NARROWING is applied only when the operator turned `inView` on, but
// the "in this view" count is stated whether or not it is on -- that number is
// what the chip offers, so it has to be knowable before the chip is pressed.
export function mapCounts(pins, bounds) {
  const f = state.mapFilter;
  const urgency = urgencyByCaseId();
  const visible = pins.filter((p) => pinMatches(p, f, urgency, f.inView ? bounds : null));
  let inView = null;
  if (bounds) {
    inView = pins.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && bounds.contains([p.lat, p.lon])).length;
  }
  // Band 0 is a real answer, not a gap: a pin absent from the attention list is
  // one nothing is chasing, so it is counted and named rather than silently
  // missing from the urgency breakdown.
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

// The rail's side of the same count: which attention rows survive the filter
// now in force. Same predicate, same urgency ladder, same extent rule as
// mapCounts above -- that is the point of them being neighbours.
export function queueRows(pins, bounds) {
  const f = state.mapFilter;
  const urgency = urgencyByCaseId();
  const byId = new Map();
  for (const p of pins) byId.set(p.id, p);
  const extent = f.inView ? bounds : null;
  return (state.attention || []).filter((c) => rowMatches(c, byId, f, urgency, extent));
}
