import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { DetailRow } from '/design/src/components/content/row.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { state } from '../state.js';
import { viewAsId } from '../api.js';
import { createPanelLoader } from './panel-load.js';
import { fetchRouters } from '../api-team.js';
import { fetchPortalHealth } from '../api-portal.js';
import { fmtTime, NO_TIME_TEXT } from '../format.js';
import { word } from '../words.js';
import { formatBytes, hoursAgoIso } from './portal-format.js';
import { RouterHealth } from './portal-router-health.js';
import { UsageSection, reloadUsage } from './portal-usage-section.js';
import { PortalConfigEditor } from './portal-config-panel.js';
import { RouterSetupSection } from './portal-router-setup-panel.js';

const h = webjsx.createElement;

const HEALTH_HISTORY_HOURS = 24;

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

function detailText(d) {
  if (!d || typeof d !== 'object') return '';
  return Object.entries(d)
    .filter(([, v]) => v != null && typeof v !== 'object')
    .slice(0, 4)
    .map(([k, v]) => k + ': ' + v)
    .join(', ');
}

function activeText(r) {
  if (r.active_clients == null) return word('ui.routers_panel_unknown_clients');
  const at = r.active_clients_at ? ' (' + word('ui.routers_panel_as_of', { time: when(r.active_clients_at) }) + ')' : '';
  return String(r.active_clients) + at;
}

function RouterCard(r) {
  const events = r.recent_events || [];
  const data = r.usage_24h || {};
  return Panel({
    key: r.router_id,
    title: r.name || r.router_id,
    children: [
      h('div', { key: 'facts' },
        DetailRow({ key: 'id', label: word('ui.routers_panel_router_id'), value: r.router_id }),
        DetailRow({ key: 'seen', label: word('ui.routers_panel_last_seen'), value: when(r.last_seen) }),
        DetailRow({ key: 'clients', label: word('ui.routers_panel_active_clients'), value: activeText(r) }),
        DetailRow({ key: 'cutoffs', label: word('ui.routers_panel_cutoffs'), value: String(r.cutoffs_24h || 0) }),
        DetailRow({ key: 'data', label: word('ui.routers_panel_data_24h'), value: word('ui.routers_panel_data_value', { down: formatBytes(data.down_bytes), up: formatBytes(data.up_bytes) }) })),
      RouterHealth({ key: 'health', router: r, history: histories[r.router_id] }),
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
      routers.length ? routers.map(RouterCard) : h('p', { key: 'none', class: 'casey-hint' }, word('ui.routers_panel_none')))),
    UsageSection({ routers }),
    RouterSetupSection(),
    PortalConfigEditor(),
    h('div', { key: 'actions', class: 'ds-contact-actions' }, Btn({
      variant: 'ghost',
      children: word('ui.routers_panel_refresh'),
      onClick: () => { loader.reload(); reloadUsage(); },
    })));
}
