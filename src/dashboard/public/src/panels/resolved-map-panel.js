import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Alert, Skeleton, FilterPills } from '/design/src/components/content/feedback.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { Slider } from '/design/src/components/slider.js';
import { Icon } from '/design/src/components/shell.js';
import { schedule } from '../state.js';
import { word } from '../words.js';
import { fetchHeat } from '../api-reports.js';
import { rd, rf, ensureReports, reloadReports, windowParams } from './reports-data.js';
import { ReportFilters } from './reports-filters.js';
import { mountResolvedMap, drawDots, drawHeat, fitOnce, cssColour } from './resolved-map-leaflet.js';
const h = webjsx.createElement;

const MODES = [
  { id: 'dots', label: 'Each signed-off case' },
  { id: 'heat', label: 'Heat map of signed-off cases' },
  { id: 'all', label: 'Heat map of all reports' },
];
const PAL = ['--sky', '--flame', '--purple-2', '--green', '--amber', '--danger'];
const OTHER = '--fg-3';
const PLAY_MS = 500;

const rm = { mode: 'dots', disease: '', idx: null, playing: false, drv: null, heat: null, heatBusy: false, seen: null, advice: '' };
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

function ensureHeat(untilIso) {
  const key = [rm.mode, untilIso, rf.region, rf.period, rm.disease, rm.advice].join('|');
  if (rm.heat && rm.heat.key === key) return;
  if (rm.heatBusy) return;
  rm.heatBusy = true;
  const w = windowParams();
  const p = { from: w.from, to: untilIso };
  if (rm.mode === 'all') p.scope = 'all'; else { p.scope = 'resolved'; if (rm.disease) p.disease = rm.disease; if (rm.advice) p.advice = rm.advice; }
  fetchHeat(p)
    .then((data) => { rm.heat = { key, data, error: '' }; })
    .catch(() => { rm.heat = { key, data: null, error: 'Could not load the heat map.' }; })
    .finally(() => { rm.heatBusy = false; schedule(); });
}

function paint(canvas, dots, weeks) {
  rm.drv = mountResolvedMap(canvas, rm.drv);
  if (!rm.drv) return;
  const fitKey = [rf.region, rf.period, rm.mode].join('|');
  const ranked = diseaseRank(rd.points.points);
  const colourFor = (d) => cssColour(canvas, ranked.indexOf(d) >= 0 && ranked.indexOf(d) < PAL.length ? PAL[ranked.indexOf(d)] : OTHER);
  if (rm.mode === 'dots') {
    drawDots(rm.drv, dots, colourFor);
    fitOnce(rm.drv, fitKey, rd.points.points);
  } else if (rm.heat && rm.heat.data) {
    drawHeat(rm.drv, rm.heat.data.cells, rm.heat.data.cell_deg, cssColour(canvas, '--flame'));
    fitOnce(rm.drv, fitKey, rm.heat.data.cells);
  } else rm.drv.layer.clearLayers();
}

function Legend(ranked) {
  if (rm.mode !== 'dots') return null;
  const shown = ranked.slice(0, PAL.length);
  return h('ul', { class: 'rep-legend', 'aria-label': word('legend.disease_colours') },
    ...shown.map((d, i) => h('li', { key: d, class: 'rep-legend-item' }, h('span', { class: 'rep-sw rep-sw-' + i, 'aria-hidden': 'true' }), d)),
    ranked.length > PAL.length ? h('li', { key: '_o', class: 'rep-legend-item' }, h('span', { class: 'rep-sw rep-sw-o', 'aria-hidden': 'true' }), word('legend.other_diseases')) : null);
}

export function ResolvedMapPanel() {
  ensureReports();
  if (!rd.loaded) return Panel({ title: 'Resolved cases map', children: Skeleton({ count: 4, height: '1.6em' }) });
  if (rd.error && !rd.points) return Panel({ title: 'Resolved cases map', children: [ReportFilters(), Alert({ kind: 'warn', children: rd.error }), Btn({ children: 'Try again', onClick: reloadReports })] });
  const all = rd.points.points;
  const weeks = weeksOf(all);
  if (rm.seen !== rd.points) { rm.seen = rd.points; rm.idx = null; rm.heat = null; stop(); }
  if (rm.idx == null || rm.idx > weeks.length - 1) rm.idx = Math.max(weeks.length - 1, 0);
  const until = weeks[rm.idx] || null;
  const untilEnd = until ? addDays(until, 6) : null;
  const adviceKinds = [...new Set(all.flatMap((p) => p.advice || []))].filter((k) => k !== 'Not stated').sort();
  const pool = all.filter((p) => (!rm.disease || p.disease === rm.disease) && (!rm.advice || (p.advice || []).includes(rm.advice)));
  const dots = until ? pool.filter((p) => p.resolved_at <= until) : [];
  const ranked = diseaseRank(all);
  if (rm.mode !== 'dots' && untilEnd) ensureHeat(untilEnd);

  const canvas = h('div', { id: 'rm-canvas', key: 'rm-canvas', class: 'ds-map-canvas rep-map', role: 'region', 'aria-label': 'Map of signed-off cases', 'aria-describedby': 'rm-summary' });
  queueMicrotask(() => { const c = document.getElementById('rm-canvas'); if (c) paint(c, dots, weeks); });

  const heatNote = rm.mode !== 'dots' && rm.heat && rm.heat.error ? Alert({ kind: 'warn', children: rm.heat.error }) : null;
  const total = rm.mode === 'dots' ? dots.length : (rm.heat && rm.heat.data ? rm.heat.data.total : 0);
  const summary = rm.mode === 'dots'
    ? `${dots.length} signed-off ${dots.length === 1 ? 'case' : 'cases'} shown${until ? ', up to the week of ' + say(until) : ''}. Each dot is placed only to about 1 km.`
    : `Heat map: ${total} ${rm.mode === 'all' ? 'reports' : 'signed-off cases'} in areas with at least 5, up to ${untilEnd ? say(untilEnd) : 'now'}. Areas with fewer than 5 are not shown.`;
  const noDots = !all.length ? Alert({ kind: 'info', children: 'No signed-off case with a place on the map yet in this period. A case appears here once an animal health technician has signed it off with the disease they identified.' }) : null;

  return Panel({
    title: 'Resolved cases map',
    children: h('div', { class: 'rep-stack' },
      ReportFilters(),
      FilterPills({ label: 'What the map shows', options: MODES, selected: rm.mode, onSelect: (v) => { rm.mode = v; rm.heat = null; schedule(); } }),
      rm.mode === 'heat' || rm.mode === 'dots' ? FilterPills({ label: 'Disease', options: [{ id: '', label: 'Every disease' }, ...ranked.slice(0, 8).map((d) => ({ id: d, label: d }))], selected: rm.disease, onSelect: (v) => { rm.disease = v; rm.heat = null; schedule(); } }) : null,
      rm.mode !== 'all' && adviceKinds.length ? FilterPills({ label: 'Technician advice', options: [{ id: '', label: 'Any advice' }, ...adviceKinds.map((k) => ({ id: k, label: k }))], selected: rm.advice, onSelect: (v) => { rm.advice = v; rm.heat = null; schedule(); } }) : null,
      noDots,
      heatNote,
      canvas,
      Legend(ranked),
      weeks.length > 1 ? h('div', { class: 'rep-slider' },
        Btn({ key: 'play', variant: rm.playing ? 'primary' : 'default', children: [Icon(rm.playing ? 'pause' : 'play', { size: 15 }), rm.playing ? ' Pause' : ' Play time-lapse'], onClick: () => togglePlay(weeks), 'aria-label': rm.playing ? 'Pause the time-lapse' : 'Play the time-lapse from the first week' }),
        Slider({ key: 'sl', label: 'Show cases signed off up to ' + (until ? say(until) : 'now'), min: 0, max: weeks.length - 1, step: 1, value: rm.idx, onChange: (v) => { stop(); rm.idx = Math.round(v); schedule(); } })) : null,
      h('p', { id: 'rm-summary', class: 'casey-hint' }, summary)),
  });
}
