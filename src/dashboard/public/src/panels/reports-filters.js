import * as webjsx from '/design/vendor/webjsx/index.js';
import { Select } from '/design/src/components/content/fields.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { Icon } from '/design/src/components/shell.js';
import { exportCsvUrl } from '../api-reports.js';
import { rf, rd, PERIODS, GRAINS, setRegion, setPeriod, setGrain, windowParams } from './reports-data.js';
const h = webjsx.createElement;

export function regionOptions() {
  const rows = (rd.report && rd.report.by_region) || [];
  const names = rows.map((r) => r.region).filter((r) => r !== 'other/sparse');
  const opts = [{ value: '', label: 'All areas' }, ...names.map((n) => ({ value: n, label: n === 'unknown' ? 'Area not stated' : n }))];
  if (rf.region && !names.includes(rf.region)) opts.push({ value: rf.region, label: rf.region });
  return opts;
}

export function ReportFilters({ grain = false } = {}) {
  return h('div', { class: 'casey-timeline-actions rep-filters' },
    Select({ key: 'region', label: 'Area', value: rf.region, options: regionOptions(), onChange: setRegion }),
    Select({ key: 'period', label: 'Period', value: rf.period, options: PERIODS.map((p) => ({ value: p.id, label: p.label })), onChange: setPeriod }),
    grain ? Select({ key: 'grain', label: 'Group by', value: rf.grain, options: GRAINS.map((g) => ({ value: g.id, label: g.label })), onChange: setGrain }) : null,
    Btn({ key: 'csv', variant: 'default', href: exportCsvUrl({ ...windowParams(), grain: rf.grain }), children: [Icon('download', { size: 15 }), ' Download as spreadsheet'], 'aria-label': 'Download these figures as a spreadsheet (CSV)' }));
}
