import * as webjsx from '/design/vendor/webjsx/index.js';
import { Section } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Select } from '/design/src/components/content/fields.js';
import { FilterPills } from '/design/src/components/content/feedback.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { createPanelLoader } from './panel-load.js';
import { fetchPortalUsage } from '../api-portal.js';
import { fmtPhone, fmtTime, NO_TIME_TEXT } from '../format.js';
import { word } from '../words.js';
import { formatBytes, hoursAgoIso } from './portal-format.js';
import { UsageChart, bucketTotals } from './portal-usage-chart.js';

const h = webjsx.createElement;

const RANGES = [
  { id: '24h', hours: 24, bucket: 'hour', labelKey: 'ui.portal_usage_range_24h' },
  { id: '7d', hours: 168, bucket: 'hour', labelKey: 'ui.portal_usage_range_7d' },
  { id: '30d', hours: 720, bucket: 'day', labelKey: 'ui.portal_usage_range_30d' },
];

let rangeId = RANGES[0].id;
let routerId = '';
let macFilter = '';
let usage = { series: [], devices: [] };

const activeRange = () => RANGES.find((r) => r.id === rangeId) || RANGES[0];
const totalOf = (device) => (device.up_bytes || 0) + (device.down_bytes || 0);
const sortedDevices = () => usage.devices.slice().sort((a, b) => totalOf(b) - totalOf(a));
const whenText = (iso) => fmtTime(iso) || NO_TIME_TEXT;

const loader = createPanelLoader({
  what: () => word('ui.portal_usage_what'),
  label: () => word('ui.portal_usage_loading'),
  fetch: () => {
    const range = activeRange();
    return fetchPortalUsage({ router_id: routerId, mac: macFilter, since: hoursAgoIso(range.hours), bucket: range.bucket });
  },
  apply: (j) => { usage = { series: j.series || [], devices: j.devices || [] }; },
});

function selectDevice(device) {
  macFilter = device.mac;
  loader.reload();
}

function clearDevice() {
  macFilter = '';
  loader.reload();
}

export function reloadUsage() {
  loader.reload();
}

function deviceRow(d) {
  return [
    d.mac,
    d.phone_e164 ? fmtPhone(d.phone_e164) : '-',
    whenText(d.first_seen),
    whenText(d.last_seen),
    formatBytes(d.up_bytes),
    formatBytes(d.down_bytes),
  ];
}

function Controls(routers) {
  return h('div', { class: 'portal-usage-controls' },
    h('div', { class: 'portal-range-pills' }, FilterPills({
      label: word('ui.portal_usage_range_label'),
      options: RANGES.map((r) => ({ id: r.id, label: word(r.labelKey) })),
      selected: rangeId,
      onSelect: (id) => { rangeId = id; loader.reload(); },
    })),
    Select({
      label: word('ui.portal_usage_router_label'),
      value: routerId,
      options: [{ value: '', label: word('ui.portal_usage_router_all') }, ...routers.map((r) => ({ value: r.router_id, label: r.name || r.router_id }))],
      onChange: (value) => { routerId = value; macFilter = ''; loader.reload(); },
    }));
}

function Body() {
  const range = activeRange();
  const devices = sortedDevices();
  const buckets = bucketTotals(usage.series, range.bucket);
  const down = devices.reduce((sum, d) => sum + (d.down_bytes || 0), 0);
  const up = devices.reduce((sum, d) => sum + (d.up_bytes || 0), 0);
  return h('div', { class: 'portal-usage-body' },
    macFilter ? h('div', { class: 'portal-usage-focus' },
      h('span', {}, word('ui.portal_usage_one_device', { mac: macFilter })),
      Btn({ variant: 'ghost', size: 'sm', children: word('ui.portal_usage_show_all'), onClick: clearDevice })) : null,
    UsageChart({ buckets, bucket: range.bucket }),
    h('p', { class: 'casey-hint' }, word('ui.portal_usage_totals', { down: formatBytes(down), up: formatBytes(up) })),
    Section({
      title: word('ui.portal_usage_devices'), headingLevel: 3, children: [
        h('p', { class: 'casey-hint' }, word('ui.portal_usage_click_hint')),
        h('div', { class: 'portal-device-table' }, Table({
          headers: [
            word('ui.routers_panel_h_mac'), word('ui.portal_usage_h_phone'), word('ui.portal_usage_h_first_seen'),
            word('ui.portal_usage_h_last_seen'), word('ui.portal_usage_h_up'), word('ui.portal_usage_h_down'),
          ],
          rows: devices.map(deviceRow),
          onRowClick: (i) => selectDevice(devices[i]),
          emptyText: word('ui.portal_usage_devices_empty'),
        })),
      ] }));
}

export function UsageSection({ routers }) {
  loader.ensureLoaded();
  return Section({
    title: word('ui.routers_panel_usage_title'), children: [
      Controls(routers),
      loader.slot(Body),
    ] });
}
