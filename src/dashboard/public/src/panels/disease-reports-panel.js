import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Alert, Skeleton } from '/design/src/components/content/feedback.js';
import { Kpi, BarChart } from '/design/src/components/content/charts.js';
import { Table } from '/design/src/components/content/table.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { Lede } from '/design/src/components/shell/atoms.js';
import { printDiseaseUrl, reportFileUrl } from '../api-reports.js';
import { rd, rfiles, ensureReports, reloadReports, nice, SPARSE, GRAINS, rf, windowParams } from './reports-data.js';
import { ReportFilters } from './reports-filters.js';
const h = webjsx.createElement;

const STATUS_LABELS = { confirmed: 'Confirmed', suspected: 'Suspected' };

const bars = (rows, labelKey) => rows.map((r) => ({ label: nice(r[labelKey]), value: r.count }));

export function WordCloud(rows) {
  const named = rows.filter((r) => r.disease !== SPARSE);
  if (!named.length) return null;
  const max = Math.max(...named.map((r) => r.count));
  return h('ul', { class: 'rep-cloud', 'aria-label': 'Diseases found, larger means more cases' },
    ...named.slice(0, 30).map((r) => {
      const step = 1 + Math.min(4, Math.floor((r.count / max) * 4.999));
      return h('li', { key: r.disease, class: 'rep-cloud-w rep-cloud-' + step, title: r.count + (r.count === 1 ? ' case' : ' cases') }, r.disease);
    }));
}

const FILE_KIND_LABELS = { csv: 'Spreadsheet (CSV)', text: 'Summary (text)' };


export function SavedMonthlyReports() {
  if (rfiles.error) return Section({ title: 'Saved monthly reports', children: Alert({ kind: 'warn', children: 'Could not load the saved monthly reports.' }) });
  if (!rfiles.list) return null;
  if (!rfiles.list.length) return Section({ title: 'Saved monthly reports', children: h('p', { class: 'casey-hint' }, 'Monthly reports appear here after the first of each month.') });
  const months = [...new Set(rfiles.list.map((f) => f.month))];
  return Section({ title: 'Saved monthly reports', children: h('ul', { class: 'rep-files' },
    ...months.map((m) => h('li', { key: m },
      h('strong', null, m + ': '),
      ...(() => {
        const files = rfiles.list.filter((f) => f.month === m && f.name);
        if (!files.length) return [h('span', { class: 'casey-hint' }, 'No saved file for this month.')];
        return files.map((f) => h('a', { key: f.name, href: reportFileUrl(f.name), class: 'ds-link', download: f.name, style: 'margin-right:1em' }, FILE_KIND_LABELS[f.kind] || f.kind));
      })())
    )) });
}


export function DiseaseReportsPanel() {
  ensureReports();
  if (!rd.loaded) return Panel({ title: 'Disease reports', children: Skeleton({ count: 5, height: '1.6em' }) });
  if (!rd.report) return Panel({ title: 'Disease reports', children: [ReportFilters({ grain: true }), Alert({ kind: 'warn', children: rd.error || 'Could not load the disease reports.' }), Btn({ children: 'Try again', onClick: reloadReports }), SavedMonthlyReports()] });
  const r = rd.report;
  const named = (list, key) => list.filter((x) => x[key] !== SPARSE);
  const diseases = named(r.by_disease, 'disease');
  const areas = named(r.by_region, 'region').filter((x) => x.region !== 'unknown');
  const top = diseases[0];
  const districts = named(r.by_district || [], 'district').filter((x) => x.district !== 'unknown');
  const sparse = [r.by_disease, r.by_region, r.by_district || [], r.by_month].some((l) => l.some((x) => Object.values(x).includes(SPARSE)));
  const grainName = (GRAINS.find((g) => g.id === rf.grain) || GRAINS[0]).label.toLowerCase();
  const empty = !r.total && !diseases.length;
  const conclusions = named(r.by_conclusion || [], 'conclusion');
  const statuses = named(r.by_status || [], 'status');
  const suspected = statuses.find((x) => x.status === 'suspected');
  const byDiseaseConclusion = named(r.by_disease_conclusion || [], 'disease').filter((x) => x.conclusion !== 'Not stated');

  return Panel({
    title: 'Disease reports',
    children: h('div', { class: 'rep-stack' },
      ReportFilters({ grain: true }),
      h('p', { class: 'casey-hint' }, h('a', { href: printDiseaseUrl({ ...windowParams(), grain: rf.grain }), class: 'ds-link', target: '_blank', rel: 'noopener', 'aria-label': 'Print this report with the current filters (opens in a new tab)' }, 'Print this report')),
      Lede({ children: 'Every figure counts reports that an animal health technician has looked at and signed off with the disease they identified. Groups of fewer than ' + r.k + ' are combined so that no single report can be picked out.' }),
      r.truncated ? Alert({ kind: 'warn', children: 'There are more reports than this page can load, so the figures leave some out.' }) : null,
      rd.loading ? h('p', { class: 'casey-hint', 'aria-live': 'polite' }, 'Updating the figures...') : null,
      empty ? Alert({ kind: 'info', children: 'No signed-off cases in this period yet. Figures appear here as technicians sign reports off.' }) : null,
      r.closed_without_diagnosis ? h('p', { class: 'casey-hint' }, r.closed_without_diagnosis + ' more cases were closed without a disease being recorded, so they are not counted in these figures.') : null,
      r.total ? h('p', { class: 'casey-hint' }, r.with_photo + ' of ' + r.total + ' signed-off cases came with a photo.') : null,
      Kpi({ items: [
        [String(r.total), 'Signed-off cases'],
        ...(suspected ? [[String(r.total - suspected.count), 'Confirmed or not stated'], [String(suspected.count), 'Suspected only']] : []),
        [String(diseases.length), 'Diseases found'],
        [top ? top.disease : '--', 'Most common'],
        [String(areas.length), 'Areas with enough cases to name'],
      ] }),
      r.ruled_out ? h('p', { class: 'casey-hint' }, r.ruled_out + ' signed-off cases had the disease ruled out, so they are not counted in these figures.') : null,
      suspected ? Section({ title: 'How certain the diagnoses are', children: [BarChart({ items: statuses.map((x) => ({ label: STATUS_LABELS[x.status] || nice(x.status), value: x.count })) }), h('p', { class: 'casey-hint' }, 'Suspected means the technician signed off on a working diagnosis that is not yet proven. A signed-off case with no certainty recorded counts as confirmed.')] }) : null,
      diseases.length ? Section({ title: 'Diseases found', children: h('div', { class: 'rep-stack' }, WordCloud(diseases), BarChart({ items: bars(diseases.slice(0, 12), 'disease') })) }) : null,
      conclusions.length ? Section({ title: 'What technicians advised at sign-off', children: [BarChart({ items: bars(conclusions, 'conclusion') }), h('p', { class: 'casey-hint' }, r.with_conclusion + ' of ' + r.total + ' signed-off cases recorded advice. Advice is grouped by the words the technician used, so one case can count under more than one heading.')] }) : null,
      areas.length ? Section({ title: 'Where they were found', children: [BarChart({ items: bars(areas.slice(0, 12), 'region') })] }) : null,
      districts.length ? Section({ title: 'By district', children: [BarChart({ items: bars(districts.slice(0, 12), 'district') }), h('p', { class: 'casey-hint' }, 'Each district adds up the areas the team has placed in it.')] }) : null,
      r.trend && r.trend.diseases.length ? Section({ title: 'Compared with the period before (' + nice(r.trend.previous_period) + ' to ' + nice(r.trend.period) + ')', children: [Table({ headers: ['Disease', nice(r.trend.period), nice(r.trend.previous_period), 'Change'], rows: r.trend.diseases.map((x) => [nice(x.disease), String(x.count), x.previous == null ? 'fewer than ' + r.k : String(x.previous), x.change == null ? '--' : (x.change > 0 ? 'up ' : x.change < 0 ? 'down ' : 'no change ') + (x.change ? Math.abs(x.change) : '')]), striped: true, compact: true, emptyText: 'Nothing to show yet' }), h('p', { class: 'casey-hint' }, 'Only diseases with at least ' + r.k + ' cases in the latest period are listed. The earlier period is hidden when it had fewer than ' + r.k + '.')] }) : null,
      r.by_month.length ? Section({ title: 'When they were signed off ' + '(' + grainName + ')', children: [BarChart({ items: r.by_month.slice().sort((a, b) => String(a.month).localeCompare(String(b.month))).map((x) => ({ label: nice(x.month), value: x.count })) })] }) : null,
      r.by_disease_region.length ? Section({ title: 'Disease by area', children: [Table({ headers: ['Disease', 'Area', 'Cases'], rows: r.by_disease_region.slice(0, 25).map((x) => [nice(x.disease), nice(x.region), String(x.count)]), striped: true, compact: true, emptyText: 'Nothing to show yet' })] }) : null,
      byDiseaseConclusion.length ? Section({ title: 'Advice by disease', children: [Table({ headers: ['Disease', 'Advice', 'Cases'], rows: byDiseaseConclusion.slice(0, 25).map((x) => [nice(x.disease), x.conclusion, String(x.count)]), striped: true, compact: true, emptyText: 'Nothing to show yet' })] }) : null,
      SavedMonthlyReports(),
          sparse ? h('p', { class: 'casey-hint' }, '"Small groups combined" gathers every group of fewer than ' + r.k + ' cases into one line.') : null),
  });
}
