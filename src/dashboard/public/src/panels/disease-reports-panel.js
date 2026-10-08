import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Alert, Skeleton } from '/design/src/components/content/feedback.js';
import { Kpi, BarChart } from '/design/src/components/content/charts.js';
import { Table } from '/design/src/components/content/table.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { Lede } from '/design/src/components/shell/atoms.js';
import { printDiseaseUrl, reportFileUrl } from '../api-reports.js';
import { fmtTime } from '../format.js';
import { rd, rfiles, ensureReports, reloadReports, nice, SPARSE, RARE, GRAINS, rf, windowParams } from './reports-data.js';
import { ReportFilters } from './reports-filters.js';
import { word } from '../words.js';
const h = webjsx.createElement;

const STATUS_LABELS = { confirmed: 'ui.disease_reports_panel_status_confirmed', suspected: 'ui.disease_reports_panel_status_suspected' };
const statusLabel = (s) => (STATUS_LABELS[s] ? word(STATUS_LABELS[s]) : nice(s));

const bars = (rows, labelKey) => rows.map((r) => ({ label: nice(r[labelKey]), value: r.count }));

export function WordCloud(rows) {
  const named = rows.filter((r) => r.disease !== SPARSE);
  if (!named.length) return null;
  const max = Math.max(...named.map((r) => r.count));
  return h('ul', { class: 'rep-cloud', 'aria-label': word('ui.disease_reports_panel_cloud_aria') },
    ...named.slice(0, 30).map((r) => {
      const step = 1 + Math.min(4, Math.floor((r.count / max) * 4.999));
      return h('li', { key: r.disease, class: 'rep-cloud-w rep-cloud-' + step, title: word(r.count === 1 ? 'ui.disease_reports_panel_case_one' : 'ui.disease_reports_panel_case_many', { count: r.count }) }, r.disease);
    }));
}

const FILE_KIND_KEYS = { csv: 'ui.disease_reports_panel_kind_csv', text: 'ui.disease_reports_panel_kind_text' };
const fileKindLabel = (kind) => (FILE_KIND_KEYS[kind] ? word(FILE_KIND_KEYS[kind]) : kind);


export function SavedMonthlyReports() {
  if (rfiles.error) return Section({ title: word('ui.disease_reports_panel_saved_title'), children: Alert({ kind: 'warn', children: word('ui.disease_reports_panel_saved_failed') }) });
  if (!rfiles.list) return null;
  if (!rfiles.list.length) return Section({ title: word('ui.disease_reports_panel_saved_title'), children: h('p', { class: 'casey-hint' }, word('ui.disease_reports_panel_saved_none')) });
  const months = [...new Set(rfiles.list.map((f) => f.month))];
  return Section({ title: word('ui.disease_reports_panel_saved_title'), children: h('ul', { class: 'rep-files' },
    ...months.map((m) => h('li', { key: m },
      h('strong', null, m + ': '),
      ...(() => {
        const files = rfiles.list.filter((f) => f.month === m && f.name);
        if (!files.length) return [h('span', { class: 'casey-hint' }, word('ui.disease_reports_panel_no_file_month'))];
        return files.map((f) => h('a', { key: f.name, href: reportFileUrl(f.name), class: 'ds-link', download: f.name, style: 'margin-right:1em' }, fileKindLabel(f.kind)));
      })())
    )) });
}


export function DiseaseReportsPanel() {
  ensureReports();
  if (!rd.loaded) return Panel({ title: word('ui.disease_reports_panel_title'), children: Skeleton({ count: 5, height: '1.6em' }) });
  if (!rd.report) return Panel({ title: word('ui.disease_reports_panel_title'), children: [ReportFilters({ grain: true }), Alert({ kind: 'warn', children: rd.error || word('ui.disease_reports_panel_load_failed') }), Btn({ children: word('ui.disease_reports_panel_try_again'), onClick: reloadReports }), SavedMonthlyReports()] });
  const r = rd.report;
  const named = (list, key) => list.filter((x) => x[key] !== SPARSE);
  const diseases = named(r.by_disease, 'disease');
  const areas = named(r.by_region, 'region');
  const namedAreas = areas.filter((x) => x.region !== 'unknown');
  const top = diseases[0];
  const districts = named(r.by_district || [], 'district');
  const orBelow = (v) => (v == null ? word('ui.disease_reports_panel_fewer', { k: r.k }) : String(v));
  const rareRow = r.rare_diseases == null ? [] : [{ disease: RARE, count: r.rare_diseases }];
  const sparse = [r.by_disease, r.by_region, r.by_district || [], r.by_month].some((l) => l.some((x) => Object.values(x).includes(SPARSE)));
  const grainName = (GRAINS.find((g) => g.id === rf.grain) || GRAINS[0]).label.toLowerCase();
  const empty = !r.total && !diseases.length;
  const conclusions = named(r.by_conclusion || [], 'conclusion');
  const statuses = named(r.by_status || [], 'status');
  const suspected = statuses.find((x) => x.status === 'suspected');
  const byDiseaseConclusion = named(r.by_disease_conclusion || [], 'disease').filter((x) => x.conclusion !== 'Not stated');

  return Panel({
    title: word('ui.disease_reports_panel_title'),
    children: h('div', { class: 'rep-stack' },
      ReportFilters({ grain: true }),
      h('p', { class: 'casey-hint' }, h('a', { href: printDiseaseUrl({ ...windowParams(), grain: rf.grain }), class: 'ds-link', target: '_blank', rel: 'noopener', 'aria-label': word('ui.disease_reports_panel_print_aria') }, word('ui.disease_reports_panel_print'))),
      rd.generatedAt ? h('p', { class: 'casey-hint' }, word('ui.disease_reports_panel_as_of', {
        asof: rd.asOf ? fmtTime(rd.asOf) : word('ui.disease_reports_panel_all_to_date'),
        generated: fmtTime(rd.generatedAt),
      })) : null,
      Lede({ children: word('ui.disease_reports_panel_lede', { k: r.k }) }),
      h('p', { class: 'casey-hint' }, word('ui.disease_reports_panel_groups_under', { k: r.k })),
      r.truncated ? Alert({ kind: 'warn', children: word('ui.disease_reports_panel_truncated') }) : null,
      rd.loading ? h('p', { class: 'casey-hint', 'aria-live': 'polite' }, word('ui.disease_reports_panel_updating')) : null,
      empty ? Alert({ kind: 'info', children: word('ui.disease_reports_panel_no_cases') }) : null,
      r.closed_without_diagnosis ? h('p', { class: 'casey-hint' }, word('ui.disease_reports_panel_closed_no_dx', { count: r.closed_without_diagnosis })) : null,
      r.total ? h('p', { class: 'casey-hint' }, word('ui.disease_reports_panel_photo', { with_photo: orBelow(r.with_photo), total: r.total })) : null,
      empty ? null : Kpi({ items: [
        [orBelow(r.total), word('ui.disease_reports_panel_kpi_signed_off')],
        ...(suspected && r.total != null ? [[String(r.total - suspected.count), word('ui.disease_reports_panel_kpi_confirmed_or_not')], [String(suspected.count), word('ui.disease_reports_panel_kpi_suspected_only')]] : []),
        [String(diseases.length), word('ui.disease_reports_panel_kpi_diseases_found')],
        [top ? top.disease : '--', word('ui.disease_reports_panel_kpi_most_common')],
        [String(namedAreas.length), word('ui.disease_reports_panel_kpi_areas_named')],
      ] }),
      r.ruled_out ? h('p', { class: 'casey-hint' }, word('ui.disease_reports_panel_ruled_out', { count: r.ruled_out })) : null,
      suspected ? Section({ title: word('ui.disease_reports_panel_certainty_title'), children: [BarChart({ items: statuses.map((x) => ({ label: statusLabel(x.status), value: x.count })) }), h('p', { class: 'casey-hint' }, word('ui.disease_reports_panel_certainty_note'))] }) : null,
      diseases.length ? Section({ title: word('ui.disease_reports_panel_found_title'), children: h('div', { class: 'rep-stack' }, WordCloud(diseases), BarChart({ items: bars([...diseases, ...rareRow].slice(0, 12), 'disease') })) }) : null,
      conclusions.length ? Section({ title: word('ui.disease_reports_panel_advice_title'), children: [BarChart({ items: bars(conclusions, 'conclusion') }), h('p', { class: 'casey-hint' }, word('ui.disease_reports_panel_advice_note', { with_conclusion: orBelow(r.with_conclusion), total: orBelow(r.total) }))] }) : null,
      areas.length ? Section({ title: word('ui.disease_reports_panel_where_title'), children: [BarChart({ items: bars(areas.slice(0, 12), 'region') })] }) : null,
      districts.length ? Section({ title: word('ui.disease_reports_panel_district_title'), children: [BarChart({ items: bars(districts.slice(0, 12), 'district') }), h('p', { class: 'casey-hint' }, word('ui.disease_reports_panel_district_note'))] }) : null,
      r.trend && (r.trend.diseases.length || r.trend.partial) ? Section({ title: word('ui.disease_reports_panel_trend_title', { previous: nice(r.trend.previous_period), period: nice(r.trend.period) }), children: [Table({ headers: [word('ui.disease_reports_panel_h_disease'), nice(r.trend.period), nice(r.trend.previous_period), word('ui.disease_reports_panel_h_change')], rows: r.trend.diseases.map((x) => [nice(x.disease), String(x.count), x.previous == null ? word('ui.disease_reports_panel_fewer', { k: r.k }) : String(x.previous), x.change == null ? '--' : word(x.change > 0 ? 'ui.disease_reports_panel_up' : x.change < 0 ? 'ui.disease_reports_panel_down' : 'ui.disease_reports_panel_no_change') + (x.change ? Math.abs(x.change) : '')]), striped: true, compact: true, emptyText: word('ui.disease_reports_panel_nothing_yet') }), h('p', { class: 'casey-hint' }, word('ui.disease_reports_panel_trend_note', { k: r.k })), r.trend.partial ? h('p', { class: 'casey-hint' }, word('ui.disease_reports_panel_partial', { period: nice(r.trend.period) })) : null] }) : null,
      r.by_month.length ? Section({ title: word('ui.disease_reports_panel_when_title', { grain: grainName }), children: [BarChart({ items: r.by_month.slice().sort((a, b) => String(a.month).localeCompare(String(b.month))).map((x) => ({ label: nice(x.month), value: x.count })) })] }) : null,
      r.by_disease_region.length ? Section({ title: word('ui.disease_reports_panel_by_area_title'), children: [Table({ headers: [word('ui.disease_reports_panel_h_disease'), word('ui.disease_reports_panel_h_area'), word('ui.disease_reports_panel_h_cases')], rows: r.by_disease_region.slice(0, 25).map((x) => [nice(x.disease), nice(x.region), String(x.count)]), striped: true, compact: true, emptyText: word('ui.disease_reports_panel_nothing_yet') })] }) : null,
      byDiseaseConclusion.length ? Section({ title: word('ui.disease_reports_panel_advice_by_disease'), children: [Table({ headers: [word('ui.disease_reports_panel_h_disease'), word('ui.disease_reports_panel_h_advice'), word('ui.disease_reports_panel_h_cases')], rows: byDiseaseConclusion.slice(0, 25).map((x) => [nice(x.disease), x.conclusion, String(x.count)]), striped: true, compact: true, emptyText: word('ui.disease_reports_panel_nothing_yet') })] }) : null,
      SavedMonthlyReports(),
          sparse ? h('p', { class: 'casey-hint' }, word('ui.disease_reports_panel_sparse', { k: r.k })) : null),
  });
}
