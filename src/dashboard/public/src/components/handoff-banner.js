import * as webjsx from 'webjsx';
import { Alert } from 'ds/components/content.js';
import { Btn } from 'ds/components/shell.js';
import { state, setHandoffQueue } from '../state.js';
import { channelLabel } from '../format.js';
import { entityLabel } from '../vocabulary.js';
import { openCaseRoute } from '../route.js';
const h = webjsx.createElement;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let handoffSeen = (() => {
  try { return new Set(JSON.parse(localStorage.casey_handoff_seen || '[]')); }
  catch { return new Set(); }
})();
function rememberHandoff(id) {
  handoffSeen.add(id);
  try { localStorage.casey_handoff_seen = JSON.stringify([...handoffSeen].slice(-500)); } catch {  }
}

const hasHandoff = (c) => String(c.tags || '').split(',').map(s => s.trim()).includes('needs-human');

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
  try { if (navigator.setAppBadge) { inboxCount > 0 ? navigator.setAppBadge(inboxCount) : navigator.clearAppBadge(); } } catch {  }
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
    setTimeout(() => { try { ac.close(); } catch {  } }, 700);
  } catch {  }
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
    'aria-label': 'Open ' + entityLabel() + ' ' + (c.ref || '') + ' - someone needs a person',
    onclick: () => openCaseRoute(c.id),
    onkeydown: (ev) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); openCaseRoute(c.id); } },
  },
    Alert({
      kind: 'warn',
      title: 'Someone needs a person',
      children: [
        h('span', { key: 'm', dangerouslySetInnerHTML: { __html: esc(c.ref) + ' - ' + esc(c.subject || channelLabel(c.channel)) + esc(extra) + '. Click to open it.' } }),
      ],
    }),
    Btn({ size: 'sm', variant: 'ghost', class: 'ds-handoff-banner-hide', 'aria-label': 'Hide this message', onClick: (e) => { e.stopPropagation(); clearHandoffQueue(); }, children: 'Hide' })
  );
}
