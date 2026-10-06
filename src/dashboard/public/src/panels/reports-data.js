import { schedule } from '../state.js';
import { word } from '../words.js';
import { fetchResolvedMap, fetchDiseaseReport, fetchReportFiles } from '../api-reports.js';

export const PERIODS = [
  { id: 'all', label: 'All time', months: 0 },
  { id: '12', label: 'Last 12 months', months: 12 },
  { id: '6', label: 'Last 6 months', months: 6 },
  { id: '3', label: 'Last 3 months', months: 3 },
];
export const GRAINS = [{ id: 'month', label: 'By month' }, { id: 'quarter', label: 'By quarter' }, { id: 'year', label: 'By year' }];

export const rf = { region: '', period: 'all', grain: 'month' };
export const rd = { report: null, points: null, error: '', loading: false, loaded: false };
let generation = 0;

const isoDay = (d) => d.toISOString().slice(0, 10);
export function windowParams() {
  const p = PERIODS.find((x) => x.id === rf.period) || PERIODS[0];
  const out = {};
  if (p.months) { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - p.months); out.from = isoDay(d); }
  if (rf.region) out.region = rf.region;
  return out;
}

export function reloadReports() {
  const gen = ++generation;
  rd.loading = true; rd.error = '';
  const w = windowParams();
  Promise.all([fetchDiseaseReport({ ...w, grain: rf.grain }), fetchResolvedMap(w)])
    .then(([report, map]) => {
      if (gen !== generation) return;
      rd.report = report; rd.points = map; rd.error = '';
    })
    .catch(() => { if (gen === generation) { rd.error = word('ui.load_disease_reports_failed'); rd.report = null; rd.points = null; } })
    .finally(() => { if (gen === generation) { rd.loading = false; rd.loaded = true; schedule(); } });
}
export const rfiles = { list: null, error: false, requested: false };

export function loadReportFiles() {
  rfiles.requested = true;
  fetchReportFiles()
    .then((list) => { rfiles.list = list; rfiles.error = false; })
    .catch(() => { rfiles.list = null; rfiles.error = true; })
    .finally(schedule);
}

export function ensureReports() {
  if (!rfiles.requested) loadReportFiles();
  if (!rd.loaded && !rd.loading) reloadReports();
}
export function setRegion(v) { rf.region = v || ''; reloadReports(); schedule(); }
export function setPeriod(v) { rf.period = v; reloadReports(); schedule(); }
export function setGrain(v) { rf.grain = v; reloadReports(); schedule(); }

export const SPARSE = 'other/sparse';
export const nice = (v) => (v === SPARSE ? 'Small groups combined' : (v === 'unknown' ? 'Area not stated' : v));
