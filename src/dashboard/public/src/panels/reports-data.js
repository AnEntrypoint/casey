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
  if (p.months) {
    const now = new Date();
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - p.months, 1));
    const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    first.setUTCDate(Math.min(now.getUTCDate(), lastDay));
    out.from = isoDay(first);
  }
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
      rd.generatedAt = report.generated_at || null; rd.asOf = report.as_of || null;
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
export const RARE = 'Other (rare)';
export const nice = (v) => (v === SPARSE ? 'Small groups combined' : v === RARE ? 'Other diseases, each under ' + (rd.report && rd.report.k || 5) + ' cases' : (v === 'unknown' ? 'Not stated' : v));
