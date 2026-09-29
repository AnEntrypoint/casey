// disease-reports-panel.js -- the disease / area / time reports: headline
// figures, a bar chart per disease, per area and per period, a word cloud of the
// diseases found, and the CSV export. Used as a staff panel and on the viewer's
// home. Every figure is a group the server released at or over the small-group
// floor (routes/reports-map.js); groups under it arrive folded as one line,
// which this panel words plainly rather than hiding.
//
// Kit primitives: Panel, Section, Kpi, BarChart, Table, Alert, Skeleton, Lede.
// The word cloud is the one bespoke shape (.rep-cloud in views/viewer.css): the
// kit has no cloud and Chip/Pill are fixed-size, so no primitive could scale a
// word by its count. Sizes are five classes on the kit's font-size tokens, never
// an inline style.
import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Alert, Skeleton } from '/design/src/components/content/feedback.js';
import { Kpi, BarChart } from '/design/src/components/content/charts.js';
import { Table } from '/design/src/components/content/table.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { Lede } from '/design/src/components/shell/atoms.js';
import { rd, ensureReports, reloadReports, nice, SPARSE, GRAINS, rf } from './reports-data.js';
import { ReportFilters } from './reports-filters.js';
const h = webjsx.createElement;

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

export function DiseaseReportsPanel() {
  ensureReports();
  if (!rd.loaded) return Panel({ title: 'Disease reports', children: Skeleton({ count: 5, height: '1.6em' }) });
  if (!rd.report) return Panel({ title: 'Disease reports', children: [ReportFilters({ grain: true }), Alert({ kind: 'warn', children: rd.error || 'Could not load the disease reports.' }), Btn({ children: 'Try again', onClick: reloadReports })] });
  const r = rd.report;
  const named = (list, key) => list.filter((x) => x[key] !== SPARSE);
  const diseases = named(r.by_disease, 'disease');
  const areas = named(r.by_region, 'region').filter((x) => x.region !== 'unknown');
  const top = diseases[0];
  const sparse = [r.by_disease, r.by_region, r.by_month].some((l) => l.some((x) => Object.values(x).includes(SPARSE)));
  const grainName = (GRAINS.find((g) => g.id === rf.grain) || GRAINS[0]).label.toLowerCase();
  const empty = !r.total && !diseases.length;

  return Panel({
    title: 'Disease reports',
    children: h('div', { class: 'rep-stack' },
      ReportFilters({ grain: true }),
      Lede({ children: 'Every figure counts reports that an animal health technician has looked at and signed off with the disease they identified. Groups of fewer than ' + r.k + ' are combined so that no single report can be picked out.' }),
      empty ? Alert({ kind: 'info', children: 'No signed-off cases in this period yet. Figures appear here as technicians sign reports off.' }) : null,
      Kpi({ items: [
        [String(r.total), 'Signed-off cases'],
        [String(diseases.length), 'Diseases found'],
        [top ? top.disease : '--', 'Most common'],
        [String(areas.length), 'Areas with enough cases to name'],
      ] }),
      diseases.length ? Section({ title: 'Diseases found', children: h('div', { class: 'rep-stack' }, WordCloud(diseases), BarChart({ items: bars(diseases.slice(0, 12), 'disease') })) }) : null,
      areas.length ? Section({ title: 'Where they were found', children: [BarChart({ items: bars(areas.slice(0, 12), 'region') })] }) : null,
      r.by_month.length ? Section({ title: 'When they were signed off ' + '(' + grainName + ')', children: [BarChart({ items: r.by_month.slice().sort((a, b) => String(a.month).localeCompare(String(b.month))).map((x) => ({ label: nice(x.month), value: x.count })) })] }) : null,
      r.by_disease_region.length ? Section({ title: 'Disease by area', children: [Table({ headers: ['Disease', 'Area', 'Cases'], rows: r.by_disease_region.slice(0, 25).map((x) => [nice(x.disease), nice(x.region), String(x.count)]), striped: true, compact: true, emptyText: 'Nothing to show yet' })] }) : null,
      sparse ? h('p', { class: 'casey-hint' }, '"Small groups combined" gathers every group of fewer than ' + r.k + ' cases into one line.') : null),
  });
}
