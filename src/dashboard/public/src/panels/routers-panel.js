import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { DetailRow } from '/design/src/components/content/row.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { Chip } from 'ds/components/shell.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { state, schedule } from '../state.js';
import { viewAsId } from '../api.js';
import { createPanelLoader } from './panel-load.js';
import { fetchRouters } from '../api-team.js';
import { fetchPortalHealth, deleteRouterRecord, rotateRouterToken } from '../api-portal.js';
import { toast, failMsg } from '../toasts.js';
import { fmtTime, rel, NO_TIME_TEXT } from '../format.js';
import { word } from '../words.js';
import { formatBytes, hoursAgoIso } from './portal-format.js';
import { RouterHealth } from './portal-router-health.js';
import { UsageSection, reloadUsage } from './portal-usage-section.js';
import { PortalConfigEditor } from './portal-config-panel.js';
import { RouterSetupSection } from './portal-router-setup-panel.js';

const h = webjsx.createElement;

const HEALTH_HISTORY_HOURS = 24;
const ONLINE_WITHIN_MS = 10 * 60 * 1000;
const QUIET_WITHIN_MS = 60 * 60 * 1000;
const STATUS_VIEW = {
  online: { tone: 'success', label: 'ui.routers_status_online' },
  quiet: { tone: 'sun', label: 'ui.routers_status_quiet' },
  offline: { tone: 'danger', label: 'ui.routers_status_offline' },
  never: { tone: 'dim', label: 'ui.routers_status_never' },
};
const rotated = {};

const TYPE_KEY = {
  login: 'ui.routers_panel_type_login',
  check_pass: 'ui.routers_panel_type_check_pass',
  cutoff: 'ui.routers_panel_type_cutoff',
  block: 'ui.routers_panel_type_block',
  heartbeat: 'ui.routers_panel_type_heartbeat',
};

let routers = [];
let histories = {};

function healthHistory(routerId) {
  return fetchPortalHealth({ router_id: routerId, since: hoursAgoIso(HEALTH_HISTORY_HOURS) })
    .then((j) => (j && j.rows) || [], () => null);
}

async function loadRoutersWithHistory() {
  const j = await fetchRouters();
  const list = (j && j.routers) || [];
  const rows = await Promise.all(list.map((r) => healthHistory(r.router_id)));
  return { routers: list, histories: Object.fromEntries(list.map((r, i) => [r.router_id, rows[i]])) };
}

const loader = createPanelLoader({
  what: () => word('ui.routers_panel_what'),
  label: () => word('ui.routers_panel_loading'),
  fetch: loadRoutersWithHistory,
  apply: (j) => { routers = j.routers; histories = j.histories; },
});

const when = (iso) => fmtTime(iso) || NO_TIME_TEXT;
const typeWord = (t) => word(TYPE_KEY[t] || 'ui.routers_panel_type_other');

function clientStatus(lastSeen, now) {
  const seen = lastSeen ? Date.parse(lastSeen) : NaN;
  if (!Number.isFinite(seen)) return 'never';
  const age = Math.max(0, now - seen);
  if (age <= ONLINE_WITHIN_MS) return 'online';
  if (age <= QUIET_WITHIN_MS) return 'quiet';
  return 'offline';
}

export function routerStatus(r, now = Date.now()) {
  const key = STATUS_VIEW[r.status] ? r.status : clientStatus(r.last_seen, now);
  return { key, tone: STATUS_VIEW[key].tone, label: word(STATUS_VIEW[key].label) };
}

function detailText(d) {
  if (!d || typeof d !== 'object') return '';
  return Object.entries(d)
    .filter(([, v]) => v != null && typeof v !== 'object')
    .slice(0, 4)
    .map(([k, v]) => k + ': ' + v)
    .join(', ');
}

function activeText(r, live) {
  if (r.active_clients == null) return word('ui.routers_panel_unknown_clients');
  if (!live) return word('ui.routers_panel_clients_last', { count: String(r.active_clients), time: when(r.active_clients_at) });
  const at = r.active_clients_at ? ' (' + word('ui.routers_panel_as_of', { time: when(r.active_clients_at) }) + ')' : '';
  return String(r.active_clients) + at;
}

function SummaryLine(list) {
  const now = Date.now();
  const live = list.filter((r) => routerStatus(r, now).key === 'online');
  const online = live.length;
  const clients = live.reduce((n, r) => n + (Number(r.active_clients) || 0), 0);
  return h('p', { key: 'summary', class: 'casey-hint' },
    word('ui.routers_summary', { online: String(online), total: String(list.length), clients: String(clients) }));
}

async function removeRouter(r) {
  if (!window.confirm(word('ui.routers_panel_delete_confirm', { name: r.name || r.router_id }))) return;
  try {
    await deleteRouterRecord(r.router_id);
    delete rotated[r.router_id];
    toast(word('ui.routers_panel_deleted'), 'ok');
    loader.reload();
  } catch (e) {
    toast(await failMsg(e, word('ui.routers_panel_delete_failed')), 'err');
  }
}

async function rotateToken(r) {
  if (!window.confirm(word('ui.routers_panel_rotate_confirm', { name: r.name || r.router_id }))) return;
  try {
    const j = await rotateRouterToken(r.router_id);
    rotated[r.router_id] = j.token;
    schedule();
  } catch (e) {
    toast(await failMsg(e, word('ui.routers_panel_rotate_failed')), 'err');
  }
}

function RouterActions(r, status) {
  const buttons = [Btn({ key: 'rotate', variant: 'ghost', children: word('ui.routers_panel_rotate'), onClick: () => rotateToken(r) })];
  if (status.key === 'never' && !r.serial) buttons.push(Btn({ key: 'delete', variant: 'ghost', children: word('ui.routers_panel_delete'), onClick: () => removeRouter(r) }));
  const token = rotated[r.router_id];
  return h('div', { key: 'actions', class: 'ds-contact-actions' },
    ...buttons,
    token ? Alert({ kind: 'info', key: 'token', children: word('ui.routers_panel_rotated', { token }) }) : null);
}

function RouterCard(r) {
  const events = r.recent_events || [];
  const data = r.usage_24h || {};
  const status = routerStatus(r);
  const live = status.key === 'online';
  return Panel({
    key: r.router_id,
    title: r.name || r.router_id,
    children: [
      h('div', { key: 'status' }, Chip({ key: 'chip', tone: status.tone, size: 'sm', children: status.label })),
      h('div', { key: 'facts' },
        DetailRow({ key: 'seen', label: word('ui.routers_panel_last_seen'), value: r.last_seen ? rel(r.last_seen) + ' (' + when(r.last_seen) + ')' : NO_TIME_TEXT }),
        DetailRow({ key: 'site', label: word('ui.routers_panel_site'), value: r.site || NO_TIME_TEXT }),
        DetailRow({ key: 'serial', label: word('ui.routers_panel_serial'), value: r.serial || NO_TIME_TEXT }),
        DetailRow({ key: 'clients', label: word('ui.routers_panel_active_clients'), value: activeText(r, live) }),
        DetailRow({ key: 'cutoffs', label: word('ui.routers_panel_cutoffs'), value: String(r.cutoffs_24h || 0) }),
        DetailRow({ key: 'data', label: word('ui.routers_panel_data_24h'), value: word('ui.routers_panel_data_value', { down: formatBytes(data.down_bytes), up: formatBytes(data.up_bytes) }) }),
        DetailRow({ key: 'id', label: word('ui.routers_panel_router_id'), value: r.router_id })),
      RouterHealth({ key: 'health', router: r, history: histories[r.router_id], live }),
      RouterActions(r, status),
      Section({
        key: 'events',
        title: word('ui.routers_panel_events'),
        children: events.length
          ? Table({
            headers: [word('ui.routers_panel_h_time'), word('ui.routers_panel_h_type'), word('ui.routers_panel_h_mac'), word('ui.routers_panel_h_detail')],
            rows: events.map((e) => [when(e.ts), typeWord(e.type), e.mac || '-', detailText(e.detail)]),
          })
          : h('p', { class: 'casey-hint' }, word('ui.routers_panel_events_none')),
      }),
    ],
  });
}

export function RoutersPanel() {
  const isAdmin = state.currentUser && state.currentUser.role === 'admin' && !viewAsId();
  if (!isAdmin) return h('p', { class: 'casey-hint' }, word('ui.routers_panel_admin_only'));
  loader.ensureLoaded();
  return h('div', { class: 'ds-people-page' },
    h('p', { key: 'lede', class: 'casey-hint' }, word('ui.routers_panel_lede')),
    loader.slot(() => h('div', { key: 'routers' },
      routers.length
        ? [SummaryLine(routers), ...routers.map(RouterCard)]
        : h('p', { key: 'none', class: 'casey-hint' }, word('ui.routers_panel_none')))),
    UsageSection({ routers }),
    RouterSetupSection(),
    PortalConfigEditor(),
    h('div', { key: 'actions', class: 'ds-contact-actions' }, Btn({
      variant: 'ghost',
      children: word('ui.routers_panel_refresh'),
      onClick: () => { loader.reload(); reloadUsage(); },
    })));
}
