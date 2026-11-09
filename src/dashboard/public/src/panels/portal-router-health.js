import * as webjsx from '/design/vendor/webjsx/index.js';
import { Section } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { DetailRow } from '/design/src/components/content/row.js';
import { word } from '../words.js';
import { formatBytes, formatUptime } from './portal-format.js';
import { fmtTime, NO_TIME_TEXT } from '../format.js';
import { Sparkline } from './portal-sparkline.js';

const h = webjsx.createElement;

const valueOrDash = (v) => (v == null || v === '' ? '-' : String(v));
const numberOrNull = (v) => (Number.isFinite(v) ? v : null);
const stateWord = (up) => (up == null ? '-' : word(up ? 'ui.routers_panel_link_up' : 'ui.routers_panel_link_down'));

function Card(title, body) {
  return h('div', { class: 'portal-card' }, h('h4', { class: 'portal-card-title' }, title), body);
}

function HealthFacts(health) {
  const wan = health.wan || {};
  const wanText = [wan.interface, wan.address, stateWord(wan.up)].filter((v) => v && v !== '-').join(', ') || '-';
  return h('div', {},
    DetailRow({ key: 'uptime', label: word('ui.routers_panel_health_uptime'), value: formatUptime(health.uptime_s) }),
    DetailRow({ key: 'software', label: word('ui.routers_panel_health_software'), value: [health.version, health.board].filter(Boolean).join(', ') || '-' }),
    DetailRow({ key: 'cpu', label: word('ui.routers_panel_health_cpu'), value: health.cpu_load_pct == null ? '-' : health.cpu_load_pct + '%' }),
    DetailRow({ key: 'memory', label: word('ui.routers_panel_health_memory'), value: word('ui.routers_panel_memory_value', { free: formatBytes(health.free_mem_bytes), total: formatBytes(health.total_mem_bytes) }) }),
    DetailRow({ key: 'temperature', label: word('ui.routers_panel_health_temperature'), value: valueOrDash(health.temperature_c) }),
    DetailRow({ key: 'registered', label: word('ui.routers_panel_health_registered'), value: valueOrDash(health.registered_devices) }),
    DetailRow({ key: 'bypassed', label: word('ui.routers_panel_health_bypassed'), value: valueOrDash(health.bypassed_devices) }),
    DetailRow({ key: 'leases', label: word('ui.routers_panel_health_leases'), value: valueOrDash(health.dhcp_leases) }),
    DetailRow({ key: 'wan', label: word('ui.routers_panel_health_wan'), value: wanText }),
    DetailRow({ key: 'config', label: word('ui.routers_panel_health_config_version'), value: valueOrDash(health.config_version) }));
}

function LinkTable(health) {
  const wifi = (health.wifi || []).map((w) => [valueOrDash(w.name), stateWord(w.running), word('ui.routers_panel_link_clients', { count: valueOrDash(w.clients) })]);
  const ether = (health.ether || []).map((e) => [valueOrDash(e.name), stateWord(e.running), valueOrDash(e.rate)]);
  const lte = health.lte ? [['LTE', stateWord(health.lte.running), word('ui.routers_panel_lte_detail', { sim: valueOrDash(health.lte.sim), rssi: valueOrDash(health.lte.rssi), operator: valueOrDash(health.lte.operator) })]] : [];
  return Table({
    headers: [word('ui.routers_panel_h_link'), word('ui.routers_panel_h_state'), word('ui.routers_panel_h_detail')],
    rows: [...wifi, ...ether, ...lte],
    emptyText: word('ui.routers_panel_links_none'),
  });
}

function LogErrors(health) {
  const lines = health.log_errors || [];
  return lines.length
    ? h('ul', { class: 'portal-log-list' }, ...lines.map((line, i) => h('li', { key: 'log' + i }, String(line))))
    : h('p', { class: 'casey-hint' }, word('ui.routers_panel_log_errors_none'));
}

function summarize(values) {
  const present = values.filter((v) => v != null);
  if (!present.length) return null;
  return { last: present[present.length - 1], low: Math.min(...present), high: Math.max(...present) };
}

function HistoryMetric(rows, metric, label) {
  const values = rows.slice().reverse().map((row) => numberOrNull(row && row.health ? row.health[metric] : null));
  const summary = summarize(values);
  if (!summary) return h('p', { key: metric, class: 'casey-hint' }, word('ui.routers_panel_history_none'));
  const text = word('ui.routers_panel_history_summary', { metric: label, last: summary.last, min: summary.low, max: summary.high });
  return h('div', { key: metric, class: 'portal-history' },
    h('p', { class: 'casey-hint' }, text),
    Sparkline({ values, label: text }));
}

function HistoryBody(history) {
  return history == null
    ? h('p', { class: 'casey-hint' }, word('ui.routers_panel_history_failed'))
    : [
      HistoryMetric(history, 'cpu_load_pct', word('ui.routers_panel_history_cpu')),
      HistoryMetric(history, 'active_clients', word('ui.routers_panel_active_clients')),
    ];
}

export function RouterHealth({ router, history, live }) {
  const health = router.last_health;
  const staleNote = health && !live
    ? [h('p', { key: 'stale', class: 'casey-hint' }, word('ui.routers_panel_health_stale', { time: fmtTime(router.last_health_at) || NO_TIME_TEXT }))]
    : [];
  const healthCards = health
    ? [
      Card(word('ui.routers_panel_health_status'), HealthFacts(health)),
      Card(word('ui.routers_panel_health_links'), LinkTable(health)),
      Card(word('ui.routers_panel_log_errors'), LogErrors(health)),
    ]
    : [h('p', { class: 'casey-hint' }, word('ui.routers_panel_no_health'))];
  return Section({
    title: word('ui.routers_panel_health_title'), headingLevel: 3, children: [
      ...staleNote,
      h('div', { class: 'portal-health-grid' },
        ...healthCards,
        Card(word('ui.routers_panel_history_title'), HistoryBody(history))),
    ] });
}
