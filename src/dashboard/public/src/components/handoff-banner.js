// Needs-human alert banner + sound + title-flash, per-case dismiss
// remembered in localStorage. Ported byte-for-byte in behavior from the old
// app.js's handoff machinery, restructured into state.js mutators + a
// webjsx render fn.

import * as webjsx from 'webjsx';
import { Alert } from 'ds/components/content.js';
import { Btn } from 'ds/components/shell.js';
import { state, setHandoffQueue } from '../state.js';
import { openCaseRoute } from '../route.js';
const h = webjsx.createElement;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let handoffSeen = (() => {
  try { return new Set(JSON.parse(localStorage.casey_handoff_seen || '[]')); }
  catch { return new Set(); }
})();
function rememberHandoff(id) {
  handoffSeen.add(id);
  try { localStorage.casey_handoff_seen = JSON.stringify([...handoffSeen].slice(-500)); } catch { /* storage unavailable */ }
}

const hasHandoff = (c) => String(c.tags || '').split(',').map(s => s.trim()).includes('needs-human');

// Captured once at module-eval time (page load) -- NOT a live read of
// document.title on every countTitle() call, since setInboxBadge/flashTitle
// themselves write document.title and would otherwise capture their own
// prior write as the new "base" on the next tick. setBaseTitle() is the
// deliberate, single update path: main.js's loadCaseyConfig() calls it once
// dashboard_ui.brand is known (config isn't available yet at this module's
// own eval time, only after an async fetch resolves), so a config-driven
// brand and this module's own inbox-count-badge/flash-title logic can
// coexist without one stomping the other.
let baseTitle = (typeof document !== 'undefined') ? document.title : 'casey';
export function setBaseTitle(title) {
  baseTitle = title;
  if (!titleTimer) document.title = countTitle();
}
let titleFlip = false, titleTimer = null, inboxCount = 0;
function countTitle() { return inboxCount > 0 ? '(' + inboxCount + ') ' + baseTitle : baseTitle; }
export function setInboxBadge(n) {
  inboxCount = n || 0;
  if (!titleTimer) document.title = countTitle();
  try { if (navigator.setAppBadge) { inboxCount > 0 ? navigator.setAppBadge(inboxCount) : navigator.clearAppBadge(); } } catch { /* unsupported */ }
}
function flashTitle(on) {
  if (on) {
    if (titleTimer) return;
    titleTimer = setInterval(() => {
      titleFlip = !titleFlip;
      document.title = titleFlip ? (state.handoffQueue.length + ' waiting for you') : countTitle();
    }, 1100);
  } else {
    clearInterval(titleTimer); titleTimer = null; document.title = countTitle();
  }
}

function handoffSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ac = new Ctx(); const t = ac.currentTime;
    [[880, t, t + 0.16], [1320, t + 0.18, t + 0.42]].forEach(([f, s, e]) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.2, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, e);
      o.connect(g); g.connect(ac.destination); o.start(s); o.stop(e + 0.02);
    });
    setTimeout(() => { try { ac.close(); } catch { /* already closed */ } }, 700);
  } catch { /* audio blocked until interaction -- silent fail is correct */ }
}

let firstLoad = true;
export function checkHandoffs(cases) {
  let queue = state.handoffQueue.slice();
  let sounded = false;
  for (const c of cases) {
    if (!hasHandoff(c)) continue;
    if (handoffSeen.has(c.id)) continue;
    rememberHandoff(c.id);
    if (queue.some(q => q.id === c.id)) continue;
    queue.push(c);
    if (!firstLoad) sounded = true;
  }
  queue = queue.map(q => cases.find(c => c.id === q.id) || q)
    .filter(q => q.status !== 'resolved' && q.status !== 'closed');
  firstLoad = false;
  setHandoffQueue(queue);
  if (sounded) handoffSound();
  flashTitle(queue.length > 0);
}

export function clearHandoffQueue() { setHandoffQueue([]); flashTitle(false); }

export function HandoffBanner() {
  const q = state.handoffQueue;
  if (!q.length) return null;
  const c = q[q.length - 1];
  const extra = q.length > 1 ? (' (and ' + (q.length - 1) + ' more)') : '';
  return h('div', {
    class: 'ds-handoff-banner', id: 'handoff', tabindex: '0', role: 'button',
    'aria-label': 'Open case ' + (c.ref || '') + ' - someone needs a person',
    onclick: () => openCaseRoute(c.id),
    onkeydown: (ev) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); openCaseRoute(c.id); } },
  },
    Alert({
      kind: 'warn',
      title: 'Someone needs a person',
      children: [
        h('span', { key: 'm', dangerouslySetInnerHTML: { __html: esc(c.ref) + ' - ' + esc(c.subject || c.external_id || c.channel) + esc(extra) + '. Click to open it.' } }),
      ],
    }),
    Btn({ size: 'sm', variant: 'ghost', class: 'ds-handoff-banner-hide', 'aria-label': 'Hide this message', onClick: (e) => { e.stopPropagation(); clearHandoffQueue(); }, children: 'Hide' })
  );
}
