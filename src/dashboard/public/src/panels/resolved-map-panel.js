import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Alert, Skeleton, FilterPills } from '/design/src/components/content/feedback.js';
import { Table } from '/design/src/components/content/table.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { Slider } from '/design/src/components/slider.js';
import { Icon } from '/design/src/components/shell.js';
import { schedule, state } from '../state.js';
import { word } from '../words.js';
import { fetchHeat, fetchAreas } from '../api-reports.js';
import { rd, rf, ensureReports, reloadReports, windowParams } from './reports-data.js';
import { ReportFilters } from './reports-filters.js';
import { mountResolvedMap, drawDots, drawHeat, drawBubbles, fitOnce, cssColour, DISEASE_MARKS } from './resolved-map-leaflet.js';
const h = webjsx.createElement;

const MODES = [
  { id: 'dots', label: 'Each signed-off case' },
  { id: 'heat', label: 'Heat map of signed-off cases' },
  { id: 'all', label: 'Heat map of all reports (by date reported)' },
  { id: 'areas', label: 'Cases by area' },
];
const PAL = ['--sky', '--flame', '--purple-2', '--green', '--amber', '--danger'];
const OTHER = '--fg-3';
const PLAY_MS = 500;

const HEAT_CACHE_MAX = 12;
const rm = { mode: 'dots', disease: '', idx: null, playing: false, drv: null, heat: null, heatBusy: false, seen: null, advice: '', species: '', status: '', wantKey: '', heatCache: new Map(), paintKey: null, paintPts: null, paintEl: null };
let timer = null;

const weeksOf = (pts) => [...new Set(pts.map((p) => p.resolved_at))].sort();
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
const say = (iso) => { try { return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch { return iso; } };

function diseaseRank(pts) {
  const n = new Map();
  for (const p of pts) n.set(p.disease, (n.get(p.disease) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
}

function stop() { rm.playing = false; if (timer) { clearInterval(timer); timer = null; } }
function togglePlay(weeks) {
  if (rm.playing) { stop(); schedule(); return; }
  if (!weeks.length) return;
  if (rm.idx == null || rm.idx >= weeks.length - 1) rm.idx = 0;
  rm.playing = true;
  timer = setInterval(() => {
    const canvas = document.getElementById('rm-canvas');
    if (!canvas || !rm.playing) { stop(); return; }
    if (rm.heatBusy) return;
    if (rm.idx >= weeks.length - 1) { stop(); schedule(); return; }
    rm.idx += 1; schedule();
  }, PLAY_MS);
  schedule();
}

function rememberHeat(entry) {
  rm.heatCache.delete(entry.key);
  rm.heatCache.set(entry.key, entry);
  if (rm.heatCache.size > HEAT_CACHE_MAX) rm.heatCache.delete(rm.heatCache.keys().next().value);
}

function ensureHeat(untilIso) {
  const key = [rm.mode, untilIso, rf.region, rf.period, rm.disease, rm.advice, rm.species, rm.status].join('|');
  rm.wantKey = key;
  if (rm.heat && rm.heat.key === key) return;
  const cached = rm.heatCache.get(key);
  if (cached) { rememberHeat(cached); rm.heat = cached; return; }
  if (rm.heatBusy) return;
  rm.heatBusy = true;
  const w = windowParams();
  const p = { from: w.from, to: untilIso, region: rf.region, species: rm.species, status: rm.status };
  if (rm.mode === 'all') p.scope = 'all'; else { p.scope = 'resolved'; if (rm.disease) p.disease = rm.disease; if (rm.advice) p.advice = rm.advice; }
  (rm.mode === 'areas' ? fetchAreas({ from: w.from, to: untilIso, region: rf.region, species: rm.species, status: rm.status }) : fetchHeat(p))
    .then((data) => { rm.heat = { key, data, error: '' }; rememberHeat(rm.heat); })
    .catch(() => { rm.heat = { key, data: null, error: 'Could not load the heat map.' }; })
    .finally(() => { rm.heatBusy = false; schedule(); });
}

const liveHeat = () => (rm.heat && rm.heat.key === rm.wantKey ? rm.heat : null);

function paint(canvas, dots, weeks) {
  rm.drv = mountResolvedMap(canvas, rm.drv);
  if (!rm.drv) return false;
  const fitKey = [rf.region, rf.period, rm.mode].join('|');
  const ranked = diseaseRank(rd.points.points);
  const styleFor = (d) => {
    const i = ranked.indexOf(d);
    const known = i >= 0 && i < PAL.length;
    return { colour: cssColour(canvas, known ? PAL[i] : OTHER), mark: known ? DISEASE_MARKS[i] : DISEASE_MARKS[0] };
  };
  if (rm.mode === 'dots') {
    drawDots(rm.drv, dots, styleFor);
    fitOnce(rm.drv, fitKey, rd.points.points);
  } else if (rm.mode === 'areas' && liveHeat() && liveHeat().data) {
    drawBubbles(rm.drv, liveHeat().data.areas, cssColour(canvas, '--sky'));
    fitOnce(rm.drv, fitKey, liveHeat().data.areas);
  } else if (liveHeat() && liveHeat().data) {
    drawHeat(rm.drv, liveHeat().data.cells, liveHeat().data.cell_deg, cssColour(canvas, '--flame'));
    fitOnce(rm.drv, fitKey, liveHeat().data.cells);
  } else rm.drv.layer.clearLayers();
  return true;
}

function tableAlternative(dots) {
  const heat = liveHeat() && liveHeat().data;
  let headers, rows;
  if (rm.mode === 'dots') {
    const n = new Map();
    for (const p of dots) n.set(p.disease + '\u0000' + p.species, (n.get(p.disease + '\u0000' + p.species) || 0) + 1);
    headers = ['Disease', 'Animal', 'Cases shown'];
    rows = [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, c]) => [...k.split('\u0000'), String(c)]);
  } else if (rm.mode === 'areas' && heat) {
    headers = ['Area', 'Cases', 'Most common disease'];
    rows = heat.areas.map((a) => [a.region, String(a.count), a.top_disease || '--']);
  } else if (heat) {
    headers = ['Near (latitude, longitude)', 'Reports'];
    rows = heat.cells.slice(0, 40).map((c) => [c.lat.toFixed(2) + ', ' + c.lon.toFixed(2), String(c.count)]);
  } else return null;
  return h('details', { class: 'rep-table-alt' },
    h('summary', null, 'Show these figures as a table'),
    Table({ headers, rows, striped: true, compact: true, emptyText: 'Nothing to show yet.' }));
}


function mark(i) {
  const c = cssColour(document.documentElement, PAL[i]);
  const m = DISEASE_MARKS[i];
  return h('svg', { class: 'rep-mark', width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': 'true' },
    h('circle', { cx: 7, cy: 7, r: 5, fill: m.fill ? c : 'none', 'fill-opacity': 0.75, stroke: c, 'stroke-width': m.fill ? 1 : 3, 'stroke-dasharray': m.dash || 'none' }));
}

function heatRamp(max, rgb) {
  const colour = cssColour(document.documentElement, rgb);
  const steps = [0.2, 0.4, 0.6, 0.8, 1];
  return h('ul', { class: 'rep-legend rep-ramp', 'aria-label': 'Colour scale' },
    ...steps.map((f) => h('li', { key: String(f), class: 'rep-legend-item' },
      h('svg', { class: 'rep-mark', width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': 'true' },
        h('rect', { x: 0, y: 0, width: 14, height: 14, fill: colour, 'fill-opacity': 0.15 + 0.7 * f })),
      'up to ' + Math.ceil(max * f))));
}

function Legend(ranked) {
  const data = liveHeat() && liveHeat().data;
  if (rm.mode === 'heat' || rm.mode === 'all') {
    const max = data && data.cells.length ? Math.max(...data.cells.map((c) => c.count)) : 0;
    return max ? h('div', { class: 'rep-stack' },
      h('p', { class: 'casey-hint' }, `Darker squares have more ${rm.mode === 'all' ? 'reports' : 'signed-off cases'}: from ${data.cells.reduce((m, c) => Math.min(m, c.count), max)} in the lightest to ${max} in the darkest. Each square is about 11 km across.`),
      heatRamp(max, '--flame')) : null;
  }
  if (rm.mode === 'areas') {
    const max = data && data.areas.length ? Math.max(...data.areas.map((a) => a.count)) : 0;
    return max ? h('p', { class: 'casey-hint' }, `Bigger bubbles have more signed-off cases: the largest area has ${max}.`) : null;
  }
  if (rm.mode !== 'dots') return null;
  const shown = ranked.slice(0, PAL.length);
  return h('ul', { class: 'rep-legend', 'aria-label': word('legend.disease_colours') },
    ...shown.map((d, i) => h('li', { key: d, class: 'rep-legend-item' }, mark(i), d)),
    ranked.length > PAL.length ? h('li', { key: '_o', class: 'rep-legend-item' }, h('span', { class: 'rep-sw rep-sw-o', 'aria-hidden': 'true' }), word('legend.other_diseases')) : null);
}

export function ResolvedMapPanel() {
  ensureReports();
  if (!rd.loaded) return Panel({ title: 'Resolved cases map', children: Skeleton({ count: 4, height: '1.6em' }) });
  if (rd.error && !rd.points) return Panel({ title: 'Resolved cases map', children: [ReportFilters(), Alert({ kind: 'warn', children: rd.error }), Btn({ children: 'Try again', onClick: reloadReports })] });
  const all = rd.points.points;
  const weeks = weeksOf(all);
  if (rm.seen !== rd.points) { rm.seen = rd.points; rm.idx = null; rm.heat = null; rm.heatCache.clear(); stop(); }
  const knownDiseases = diseaseRank(rd.points.points).slice(0, 8);
  if (rm.disease && !knownDiseases.includes(rm.disease)) rm.disease = '';
  if (rm.advice && !rd.points.points.some((p) => (p.advice || []).includes(rm.advice))) rm.advice = '';
  if (rm.idx == null || rm.idx > weeks.length - 1) rm.idx = Math.max(weeks.length - 1, 0);
  const until = weeks[rm.idx] || null;
  const untilEnd = until ? addDays(until, 6) : null;
  const speciesKinds = [...new Set(all.map((p) => p.species))].sort();
  if (rm.species && !speciesKinds.includes(rm.species)) rm.species = '';
  if (rm.status && !all.some((p) => p.status === rm.status)) rm.status = '';
  const statusKinds = [...new Set(all.map((p) => p.status))].sort();
  const adviceKinds = [...new Set(all.flatMap((p) => p.advice || []))].filter((k) => k !== 'Not stated').sort();
  const pool = all.filter((p) => (!rm.disease || p.disease === rm.disease) && (!rm.species || p.species === rm.species) && (!rm.status || p.status === rm.status) && (!rm.advice || (p.advice || []).includes(rm.advice)));
  const dots = until ? pool.filter((p) => p.resolved_at <= until) : [];
  const ranked = diseaseRank(all);
  if (rm.mode !== 'dots' && untilEnd) ensureHeat(untilEnd);

  const canvas = h('div', { id: 'rm-canvas', key: 'rm-canvas', class: 'ds-map-canvas rep-map', role: 'region', 'aria-label': 'Map of signed-off cases', 'aria-describedby': 'rm-summary' });
  const paintKey = [rm.mode, until, rm.disease, rm.species, rm.status, rm.advice, rf.region, rf.period, state.theme, liveHeat() ? rm.wantKey : ''].join('|');
  const pts = rd.points;
  queueMicrotask(() => {
    const c = document.getElementById('rm-canvas');
    if (!c || (rm.paintEl === c && rm.paintPts === pts && rm.paintKey === paintKey)) return;
    if (!paint(c, dots, weeks)) return;
    rm.paintEl = c; rm.paintPts = pts; rm.paintKey = paintKey;
  });

  const heatNote = rm.mode !== 'dots' && liveHeat() && liveHeat().error ? Alert({ kind: 'warn', children: [liveHeat().error, ' ', Btn({ children: 'Try again', onClick: () => { rm.heat = null; schedule(); } })] }) : null;
  const tileNote = rm.drv && rm.drv.tilesFailing ? Alert({ kind: 'warn', children: 'The map background is not loading. The dots, areas and figures come from this dashboard and are unaffected -- only the picture behind them is missing.' }) : null;
  const total = rm.mode === 'dots' ? dots.length : (liveHeat() && liveHeat().data ? liveHeat().data.total : 0);
  const summary = rm.mode === 'dots'
    ? `${dots.length} signed-off ${dots.length === 1 ? 'case' : 'cases'} shown${until ? ', up to the week of ' + say(until) : ''}. Each dot is placed only to about 1 km, and only where at least 5 signed-off cases share a map square.`
    : rm.mode === 'areas'
      ? `${total} signed-off cases in ${liveHeat() && liveHeat().data ? liveHeat().data.areas.length : 0} named areas with at least 5, up to ${untilEnd ? say(untilEnd) : 'now'}. A bubble sits near the middle of an area's cases, rounded to about 10 km, and its size shows how many.`
      : `Heat map${rm.mode === 'all' ? ', by date reported' : ', by date signed off'}: ${total} ${rm.mode === 'all' ? 'reports' : 'signed-off cases'} in map squares with at least 5, up to ${until ? 'the end of the week of ' + say(until) : 'now'}. Squares with fewer than 5 are not shown.`;
  const truncatedNote = rd.points.truncated || (liveHeat() && liveHeat().data && liveHeat().data.truncated) ? Alert({ kind: 'warn', children: 'There are more reports than this map can load, so the figures leave some out.' }) : null;
  const noDots = !all.length ? Alert({ kind: 'info', children: 'No signed-off case with a place on the map yet in this period. A case appears here once an animal health technician has signed it off with the disease they identified.' }) : null;

  return Panel({
    title: 'Resolved cases map',
    children: h('div', { class: 'rep-stack' },
      ReportFilters(),
      rd.loading ? h('p', { class: 'casey-hint', 'aria-live': 'polite' }, 'Updating the map...') : null,
      FilterPills({ label: 'What the map shows', options: MODES, selected: rm.mode, onSelect: (v) => { rm.mode = v; rm.heat = null; schedule(); } }),
      rm.mode !== 'all' && speciesKinds.length > 1 ? FilterPills({ label: 'Animal', options: [{ id: '', label: 'Every animal' }, ...speciesKinds.map((k) => ({ id: k, label: k }))], selected: rm.species, onSelect: (v) => { rm.species = v; rm.heat = null; schedule(); } }) : null,
      rm.mode !== 'all' && statusKinds.length > 1 ? FilterPills({ label: 'Diagnosis', options: [{ id: '', label: 'Confirmed and suspected' }, ...statusKinds.map((k) => ({ id: k, label: k === 'suspected' ? 'Suspected only' : 'Confirmed only' }))], selected: rm.status, onSelect: (v) => { rm.status = v; rm.heat = null; schedule(); } }) : null,
      rm.mode === 'heat' || rm.mode === 'dots' ? FilterPills({ label: 'Disease', options: [{ id: '', label: 'Every disease' }, ...ranked.slice(0, 8).map((d) => ({ id: d, label: d }))], selected: rm.disease, onSelect: (v) => { rm.disease = v; rm.heat = null; schedule(); } }) : null,
      (rm.mode === 'dots' || rm.mode === 'heat') && adviceKinds.length ? FilterPills({ label: 'Technician advice', options: [{ id: '', label: 'Any advice' }, ...adviceKinds.map((k) => ({ id: k, label: k }))], selected: rm.advice, onSelect: (v) => { rm.advice = v; rm.heat = null; schedule(); } }) : null,
      noDots,
      heatNote,
      tileNote,
      canvas,
      Legend(ranked),
      tableAlternative(dots),
      weeks.length > 1 ? h('div', { class: 'rep-slider' },
        Btn({ key: 'play', variant: rm.playing ? 'primary' : 'default', children: [Icon(rm.playing ? 'pause' : 'play', { size: 15 }), rm.playing ? ' Pause' : ' Play time-lapse'], onClick: () => togglePlay(weeks), 'aria-label': rm.playing ? 'Pause the time-lapse' : 'Play the time-lapse from the first week' }),
        Slider({ key: 'sl', label: 'Show cases signed off up to ' + (until ? say(until) : 'now'), min: 0, max: weeks.length - 1, step: 1, value: rm.idx, onChange: (v) => { stop(); rm.idx = Math.round(v); schedule(); } })) : null,
      truncatedNote,
          h('p', { id: 'rm-summary', class: 'casey-hint', 'aria-live': rm.playing ? 'off' : 'polite' }, summary + (rd.points.withheld ? ` ${rd.points.withheld} more are held back because fewer than ${rd.points.k} signed-off cases share their map square.` : ''))),
  });
}
