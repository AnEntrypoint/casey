const ENDPOINT = '/api/client-log';
const FIELD_MAX = 200;
let currentView = '';
let lastView = null;
let installed = false;

function firstLine(value) {
  const text = String(value ?? '');
  let end = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029) { end = i; break; }
  }
  return text.slice(0, Math.min(end, FIELD_MAX));
}

function send(payload) {
  const body = JSON.stringify(payload);
  try {
    if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))) return;
  } catch {}
  try {
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'same-origin',
    }).catch(() => {});
  } catch {}
}

function report(level, event, message) {
  const detail = firstLine(message);
  if (!detail) return;
  send({ level, event, detail, route: currentView });
}

function textOf(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.message;
  return '';
}

export function forwardRoute(route) {
  const name = route.panel || (route.inbox ? 'inbox' : '') || (route.caseId ? 'case' : '') || route.home || 'home';
  if (name === lastView) return;
  lastView = name;
  currentView = name;
  send({ level: 'info', event: 'view', detail: '', route: name });
}

export function installClientLog() {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => report('error', 'window.error', e && e.message));
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e && e.reason;
    report('error', 'unhandledrejection', reason instanceof Error ? reason.message : (typeof reason === 'string' ? reason : ''));
  });
  for (const [method, level] of [['error', 'error'], ['warn', 'warn']]) {
    const original = console[method];
    console[method] = function (...args) {
      try {
        report(level, 'console.' + method, args.map(textOf).filter(Boolean).join(' '));
      } catch {}
      return original.apply(console, args);
    };
  }
}
