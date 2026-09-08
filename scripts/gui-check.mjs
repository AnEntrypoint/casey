#!/usr/bin/env node
// gui-check.mjs -- drives the REAL dashboard in REAL headless Chromium and
// asserts the layout invariants this repo has already broken once each.
//
// This is not a test suite and adds no mocks: it boots the actual Express app
// against the actual sqlite store and reads the actual rendered DOM, which is
// the verification style AGENTS.md mandates ("Verification is manual/live").
// Same shape as deps/design's own scripts/a11y-audit.mjs. Run it by hand or
// from a preflight; it is not wired into `npm run lint`, which is deliberately
// dependency-free and must stay green in a bare clone with no browser.
//
// Every assertion below is a regression that actually shipped:
//   - the map home rendered through the legacy stacked panel path, so the
//     map-first layout was built and never reached (default_view called
//     openPanel('map'))
//   - the mobile "icon grid" resolved to ONE column, i.e. a vertical stack of
//     full-width rows that squeezed the map to 231px
//   - the desktop full-bleed map was not full-bleed, because a transformed
//     ancestor became the containing block for `position: fixed`
//   - icon-only controls shipped with no accessible name
//
// Usage: node scripts/gui-check.mjs [--port 4791] [--keep-open]
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src')

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d }
const PORT = Number(arg('--port', '4791'))
const CDP_PORT = PORT + 5000

const CHROME = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
  .find((p) => existsSync(p))
if (!CHROME) {
  console.warn('[gui-check] SKIPPED: no chromium/chrome binary found. This check needs a real browser.')
  process.exit(0)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const USER = 'guicheck-' + Math.random().toString(36).slice(2, 8)
const PW = 'g-' + Math.random().toString(36).slice(2, 12)

const { createCaseStore } = await import(path.join(SRC, 'case-store.js'))
const { createAccount, deleteAccount, listAccounts } = await import(path.join(SRC, 'dashboard/auth.js'))
const { createDashboard } = await import(path.join(SRC, 'dashboard/server.js'))

const failures = []
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail == null ? '' : '  -- ' + detail}`)
  if (!ok) failures.push(label)
}

const store = createCaseStore({})
await store.init()
let dash = null, chrome = null, ws = null

try {
  await createAccount(store, { username: USER, password: PW, displayName: 'GUI Check', role: 'admin', mustChangePassword: false })
  dash = await createDashboard(store, { port: PORT })

  chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--remote-debugging-port=${CDP_PORT}`, '--window-size=1440,900',
    `--user-data-dir=${path.join(process.env.TMPDIR || '/tmp', 'casey-gui-check-' + process.pid)}`,
    'about:blank',
  ], { stdio: 'ignore' })

  let ver = null
  for (let i = 0; i < 40 && !ver; i++) {
    await sleep(500)
    try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json() } catch { /* not up yet */ }
  }
  if (!ver) throw new Error('chromium did not expose a CDP endpoint')

  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

  let id = 0
  const pending = new Map()
  const consoleMsgs = []
  const failedReqs = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      consoleMsgs.push(`[${m.params.type}] ` + (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 160))
    }
    if (m.method === 'Log.entryAdded' && (m.params.entry.level === 'error' || m.params.entry.level === 'warning')) {
      consoleMsgs.push(`[${m.params.entry.level}] ` + String(m.params.entry.text).slice(0, 160))
    }
    if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
      failedReqs.push(`${m.params.response.status} ${m.params.response.url}`)
    }
  }
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.result?.value

  await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable'); await send('Page.enable')

  const base = `http://127.0.0.1:${PORT}`
  await send('Page.navigate', { url: base })
  await sleep(2000)
  await evalJs(`fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(USER)},password:${JSON.stringify(PW)}})}).then(r=>r.status)`)
  await send('Page.navigate', { url: base })
  await sleep(5000)

  console.log('\ndesktop 1440x900')
  const d = JSON.parse(await evalJs(`(() => {
    const c = document.querySelector('.leaflet-container');
    const r = c && c.getBoundingClientRect();
    const app = document.getElementById('app');
    return JSON.stringify({
      appChildren: app ? app.children.length : -1,
      font: getComputedStyle(document.body).fontFamily,
      mapMounted: !!c,
      mapRect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
      tiles: document.querySelectorAll('.leaflet-tile').length,
      legend: document.querySelectorAll('.ds-map-legend-item').length,
      innerW: window.innerWidth,
    });
  })()`))
  check(d.appChildren > 0, 'SPA mounted', `#app has ${d.appChildren} child(ren)`)
  check(d.mapMounted, 'map canvas present on the map home view')
  // full-bleed: the canvas must start at the viewport origin and span its width.
  check(d.mapRect && d.mapRect[0] === 0 && d.mapRect[1] === 0, 'map is full-bleed (origin 0,0)', d.mapRect && `rect ${d.mapRect}`)
  check(d.mapRect && d.mapRect[2] >= d.innerW - 20, 'map spans the viewport width', d.mapRect && `${d.mapRect[2]} vs ${d.innerW}`)
  check(d.tiles > 0, 'map tiles loaded', `${d.tiles} tiles`)
  check(d.legend > 0, 'map legend rendered', `${d.legend} items`)
  check(/Ubuntu/.test(d.font), 'Ubuntu font applied to body', d.font.slice(0, 40))

  console.log('\nmobile 390x844')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(2500)
  const m = JSON.parse(await evalJs(`(() => {
    const bar = document.querySelector('.ds-appbar');
    const bs = bar && getComputedStyle(bar);
    const cols = bs ? bs.gridTemplateColumns : null;
    return JSON.stringify({
      display: bs ? bs.display : null,
      cols,
      colCount: cols && cols !== 'none' ? cols.split(' ').length : 0,
      z: bs ? bs.zIndex : null,
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    });
  })()`))
  check(m.display === 'grid', 'mobile appbar is a grid', m.display)
  // The regression: auto-fit collapsed to ONE column and the "grid" was a stack.
  check(m.colCount >= 2, 'mobile icon grid has more than one column', `${m.colCount} cols (${m.cols})`)
  check(m.z !== 'auto' && Number(m.z) > 0, 'mobile appbar sits above the map', `z-index ${m.z}`)
  check(m.scrollW <= m.innerW, 'no horizontal overflow on mobile', `${m.scrollW} vs ${m.innerW}`)

  console.log('\naccessibility + console')
  const bad = JSON.parse(await evalJs(`(() => {
    const els = [...document.querySelectorAll('button, a, [role=button], input, select')];
    return JSON.stringify(els.filter(e => {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      return !((e.textContent||'').trim() || e.getAttribute('aria-label') || e.getAttribute('title')
        || e.getAttribute('aria-labelledby') || (e.tagName === 'INPUT' && e.getAttribute('placeholder')));
    }).map(e => e.tagName.toLowerCase() + '.' + String(e.className||'').split(' ')[0]));
  })()`))
  check(bad.length === 0, 'every visible control has an accessible name', bad.length ? bad.join(', ') : 'none unlabelled')
  check(consoleMsgs.length === 0, 'browser console clean', consoleMsgs.length ? consoleMsgs[0] : 'no errors or warnings')
  check(failedReqs.length === 0, 'no failed requests', failedReqs.length ? [...new Set(failedReqs)][0] : 'none')
} catch (e) {
  console.error('[gui-check] ERROR:', e.message)
  failures.push('harness: ' + e.message)
} finally {
  try { ws && ws.close() } catch { /* closing a dead socket is not a failure */ }
  try { chrome && chrome.kill() } catch { /* already gone */ }
  try { if (dash?.close) await dash.close() } catch { /* already closed */ }
  for (const a of await listAccounts(store).catch(() => [])) {
    if (a.username === USER) await deleteAccount(store, a.id).catch(() => {})
  }
}

console.log(failures.length ? `\n[gui-check] ${failures.length} FAILED: ${failures.join('; ')}` : '\n[gui-check] all checks passed')
process.exit(failures.length ? 1 : 0)
