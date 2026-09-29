#!/usr/bin/env node
// gui-check.mjs -- drives the REAL dashboard in REAL headless Chromium and
// asserts the layout, workflow and accessibility invariants this repo has
// already broken once each.
//
// This is not a test suite and adds no mocks: it boots the actual Express app
// against a real sqlite store and reads the actual rendered DOM, which is the
// verification style AGENTS.md mandates ("Verification is manual/live"). Same
// shape as deps/design's own scripts/a11y-audit.mjs. Run it by hand or from a
// preflight; it is not wired into `npm run lint`, which is deliberately
// dependency-free and must stay green in a bare clone with no browser.
//
// THE STORE IS ITS OWN. The store is cwd-bound, so this script moves into a
// throwaway directory BEFORE opening it and seeds every account, contact and
// report it asserts on. It never opens the live data/ directory (an earlier
// version did, created and deleted logins in it while the live bot was running,
// and asserted on whatever reports the live store happened to hold).
//
// Every assertion below is a regression that actually shipped:
//   - the map home rendered through the legacy stacked panel path
//   - the mobile "icon grid" resolved to ONE column
//   - a transformed ancestor broke the map's `position: fixed` geometry
//   - icon-only controls shipped with no accessible name
//   - axe: aria-selected on a listitem, a heading inside role=list, opacity-
//     dimmed pills at 3.15:1, a scroll region a keyboard cannot reach, white
//     text on the dark theme's light-red danger fill, a "New" pill in --sky
//   - field team: the browser Back button left the dashboard from a report;
//     a write after an operator unassigned the report said "not found"; the
//     checklist said Have/Needed only by colour on a phone; a signed-off report
//     still offered to be signed off
//   - a session that ended mid-action failed one request at a time
//   - past 50 reports the older ones could not be reached, and search only
//     looked at the 50 loaded
//   - the map legend said "In Progress" / "Needs A Person" while every other
//     surface says "Working on it" / "Needs a person"
//   - the nudge panel was unstyled and read "they last did something on it not recorded"
//
// Usage: node scripts/gui-check.mjs [--port 4791] [--keep-open]
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src')
const AXE = path.join(HERE, '..', 'deps', 'design', 'vendor', 'axe-core', 'axe.min.js')

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
const PW = 'g-' + Math.random().toString(36).slice(2, 12)
const USER = 'guicheck'

// Own the store: a scratch cwd, opened before any casey module is imported.
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'casey-gui-check-store-'))
process.chdir(SCRATCH)
// The field-team screens assert on the deployment's own mandatory minimum (species, symptoms, location), so
// the config is the deployment's: CASEY_CONFIG_DIR, else the uhh config this repo is checked out inside.
// A checkout on its own falls back to the bundled generic config, and those checks then report.
const UHH_CONFIG = path.join(HERE, '..', '..', '..', 'config')
if (!process.env.CASEY_CONFIG_DIR && existsSync(path.join(UHH_CONFIG, 'report-fields.yml'))) process.env.CASEY_CONFIG_DIR = UHH_CONFIG
if (!process.env.CASEY_CONFIG_DIR) copyFileSync(path.join(HERE, '..', 'thatcher.config.yml'), path.join(SCRATCH, 'thatcher.config.yml'))
process.env.CASEY_COOKIE_SECURE = '0'

const { createCaseStore } = await import(path.join(SRC, 'case-store.js'))
const { createAccount } = await import(path.join(SRC, 'dashboard/auth.js'))
const { createDashboard } = await import(path.join(SRC, 'dashboard/server.js'))
const { runViewerChecks } = await import('./gui-check-viewer.mjs')
const { runTeamChecks } = await import('./gui-check-team.mjs')
const { runPersonsChecks } = await import('./gui-check-persons.mjs')
const { runVocabChecks } = await import('./gui-check-vocab.mjs')

const failures = []
const ONLY_DONE = Symbol('only-done')
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail == null ? '' : '  -- ' + detail}`)
  if (!ok) failures.push(label)
}

const store = createCaseStore({})
await store.init()
let dash = null, chrome = null, ws = null
const ids = {}
const BULK = 130

async function seed() {
  const mk = (suffix, role, displayName, extra = {}) =>
    createAccount(store, { username: USER + suffix, password: PW, displayName, role, mustChangePassword: false, ...extra })
  await mk('', 'admin', 'GUI Check')
  await mk('-rng', 'eco_ranger', 'GUI Ranger', { contactPhone: '082 111 2222' })
  await mk('-aht', 'animal_health_technician', 'GUI Technician', { contactPhone: '083 333 4444' })
  await mk('-rng2', 'eco_ranger', 'GUI Ranger Two')
  await mk('-rng0', 'eco_ranger', 'GUI Nocases')
  await mk('-vw', 'viewer', 'GUI Viewer')
  await store.registerContact({ channel: 'whatsapp', external_id: '27821112222', display_name: 'GUI Ranger', tier: 'field_worker' })
  const ac = await store.registerContact({ channel: 'whatsapp', external_id: '27833334444', display_name: 'GUI Technician', tier: 'animal_health_technician' })
  await store.registerContact({ channel: 'whatsapp', external_id: '27790001111', display_name: 'Public Pete', tier: 'reporter' })
  const full = { species: 'cattle', symptoms: 'limping', location: 'Musina' }
  const mkcase = async (ext, subject, report, assignee, extra = {}) => {
    const { case: c } = await store.findOrCreateCase({ channel: 'whatsapp', external_id: ext, contact: { name: 'Farmer ' + ext.slice(-3), phone: ext }, subject })
    if (report) await store.mergeReport(c.id, report, { id: 'seed', role: 'agent' })
    if (assignee || extra.lat != null) await store.updateCase(c.id, { ...(assignee ? { assignee } : {}), ...extra }, { id: 'casey-system', role: 'admin' })
    return (await store.getCase(c.id)).id
  }
  const long = 'Very long subject line about a cow that has been limping near the river bend and the farmer says '.repeat(2).slice(0, 200)
  ids.A = await mkcase('27800000001', 'A ranger case', { species: 'goats' }, USER + '-rng', { lat: -22.3, lon: 30.0 })
  ids.L = await mkcase('27800000008', long, { species: 'cattle' }, USER + '-rng')
  ids.C = await mkcase('27800000003', 'C ready unassigned', full, '', { lat: -22.9, lon: 30.5 })
  ids.D = await mkcase('27800000004', 'D technician incomplete', { species: 'sheep' }, 'contact:' + ac.id)
  ids.G = await mkcase('27800000007', 'G technician ready', full, USER + '-aht', { lat: -22.5, lon: 30.2 })
  ids.U = await mkcase('27800000009', '\u0645\u0631\u064a\u0636 \u0628\u0642\u0631\u0629 caf\u00e9 \u725b\u75c5', full, USER + '-rng2')
  // Past one page (50) so the older reports have to be reachable.
  for (let i = 0; i < BULK; i++) await mkcase('2778' + String(100000 + i), 'Bulk case ' + i, { species: 'goats' }, '')
}

try {
  await seed()
  dash = await createDashboard(store, { port: PORT })

  chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--remote-debugging-port=${CDP_PORT}`, '--window-size=1440,900',
    `--user-data-dir=${path.join(SCRATCH, 'chrome-profile')}`,
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
      consoleMsgs.push(`[${m.params.entry.level}] ` + String(m.params.entry.text).slice(0, 160) + (m.params.entry.url ? ' <' + m.params.entry.url.replace(/^https?:\/\/[^/]+/, '') + '>' : ''))
    }
    if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
      failedReqs.push(`${m.params.response.status} ${m.params.response.url}`)
    }
  }
  // A dialog the page raises (beforeunload on unsaved input) would freeze every later call: accept it.
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }) })
  // A call that never answers is a failed check, not a hung run.
  const send = (method, params = {}, limit = 40000) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, res)
    const t = setTimeout(async () => {
      if (process.env.GUI_CHECK_DEBUG) {
        const t0 = Date.now()
        const srv = await Promise.race([fetch(base + '/api/ready').then((r) => r.status), sleep(5000).then(() => 'server silent for 5s')]).catch((e) => String(e))
        const tabs = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json().catch(() => [])
        console.log('  [debug] server /api/ready:', srv, (Date.now() - t0) + 'ms; tabs:', JSON.stringify(tabs.map((x) => [x.type, x.url.slice(0, 60), x.title.slice(0, 30)])))
      }
      pending.delete(i); rej(new Error('no answer from the browser to ' + method + ' ' + JSON.stringify(params).slice(0, 80) + ' within ' + Math.round(limit / 1000) + 's')) }, limit)
    pending.set(i, (m) => { clearTimeout(t); res(m) })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  // A navigation that never commits is retried once after stopping the load: it is intermittent and
  // the page, not the assertion, is what stalled.
  const navigate = async (url) => {
    try { await send('Page.navigate', { url }, 20000) } catch { await send('Page.stopLoading').catch(() => {}); await send('Page.navigate', { url }, 20000) }
  }
  const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.result?.value
  const key = async (k, mods = 0) => {
    const code = { Tab: 9, Escape: 27, Enter: 13 }[k]
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: code, modifiers: mods })
  }

  await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable'); await send('Page.enable')
  // The service worker answers navigations; one caught mid-install stalls Page.navigate intermittently.
  await send('Network.setBypassServiceWorker', { bypass: true })

  const base = `http://127.0.0.1:${PORT}`
  const VP = { d: [1440, 900, false], t: [768, 1024, true], p: [390, 844, true] }
  const viewport = async (k) => {
    const [width, height, mobile] = VP[k]
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile })
    // A phone is a coarse pointer: the kit's 44px touch floor only applies to one.
    await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 5 })
  }
  const theme = async (t) => {
    // Exactly what account-menu.js's applyTheme does.
    await evalJs(`(() => { const t = ${JSON.stringify(t)}; document.documentElement.dataset.caseyTheme = t; document.body.dataset.theme = t; const a = document.getElementById('app'); if (a) a.dataset.theme = t; return 1 })()`)
    await sleep(600)
  }
  // A real sign-in for a role, then a full navigation (a hash-only change would not reload the SPA).
  // What each page raised is judged once, at the console check: pages are archived as they are left, and what the
  // OLD page raises while its own session is being swapped out (a poll answered 401 after the logout) is dropped.
  const seenConsole = [], seenFailed = []
  const archive = () => { seenConsole.push(...consoleMsgs); seenFailed.push(...failedReqs); consoleMsgs.length = 0; failedReqs.length = 0 }
  const asUser = async (suffix, hash = '', wait = 3500) => {
    archive()
    await navigate(base + '/#x'); await sleep(700)
    await evalJs(`(async () => {
      localStorage.casey_onboarded = '1'; localStorage.casey_help_seen = '1';
      for (const k of ['casey_skills_', 'casey_skills_default']) localStorage.setItem(k, JSON.stringify({ __dismissed: true }));
      localStorage.setItem('casey_skills_' + ${JSON.stringify(USER + suffix)}, JSON.stringify({ __dismissed: true }));
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      for (const k of await caches.keys()) await caches.delete(k);
      await fetch('/api/logout', { method: 'POST' });
      return (await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ${JSON.stringify(USER + suffix)}, password: ${JSON.stringify(PW)} }) })).status })()`)
    await navigate('about:blank')
    consoleMsgs.length = 0; failedReqs.length = 0
    await navigate(base + '/' + hash)
    await sleep(wait)
  }
  const api = (method, p, body) => evalJs(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async (r) => JSON.stringify({ s: r.status, j: await r.json().catch(() => null) }))`).then((s) => JSON.parse(s))
  const clickText = (txt, exact = false) => evalJs(`(() => { const want = ${JSON.stringify(txt)}, exact = ${exact}; const e = [...document.querySelectorAll('button, a, [role=button], [role=menuitem]')].find((e) => { if (e.offsetParent === null) return false; const t = (e.innerText || e.getAttribute('aria-label') || '').trim(); return exact ? t === want : t.startsWith(want) }); if (!e) return false; e.focus(); e.click(); return true })()`)
  const setField = (sel, v) => evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  const bodyText = () => evalJs('document.body.innerText')
  const axe = async (label) => {
    await evalJs(readFileSync(AXE, 'utf8'))
    const r = JSON.parse(await evalJs(`axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }).then((r) => JSON.stringify(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id + ' x' + v.nodes.length + ' ' + v.nodes[0].target.join(' ') + ' :: ' + String(v.nodes[0].failureSummary || '').split('\\n')[1]))) `))
    check(r.length === 0, `axe: no serious or critical violation -- ${label}`, r.length ? r.slice(0, 2).join(' | ').slice(0, 260) : 'none')
  }
  // Every view a person can be on, in both themes, against axe.
  const axeBoth = async (label) => {
    for (const [t, n] of [['herd', 'light'], ['herd-ink', 'dark']]) { await theme(t); await axe(`${label} (${n})`) }
    await theme('herd')
  }

  // Counts every render the kit's schedule() actually queues (bootstrap.js coalesces
  // into one microtask per render). A self-rescheduling render loop locks a phone, so
  // the counter drops past 3000 to keep a regression a FAILED check, not a hung page.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const W = window; W.__renders = 0; const q = W.queueMicrotask.bind(W);
    W.queueMicrotask = (f) => { if (/schedule/.test((new Error().stack || '').split('\\n')[2] || '')) { if (++W.__renders > (W.__renderCap || 3000)) return } return q(f) };
  })()` })

  // The read-only viewer's checks (scripts/gui-check-viewer.mjs) seed 300 more reports, so they run last in a
  // full run; GUI_CHECK_ONLY=viewer runs just them, against the same scratch store and dashboard.
  const viewerCtx = () => ({ check, evalJs, asUser, axeBoth, viewport, sleep, clickText, store, PORT, USER, PW, ids, archive, seenConsole, seenFailed, bodyText, send })
  const teamCtx = () => ({ check, evalJs, asUser, axeBoth, viewport, sleep, clickText, setField, key, store, base, USER, PW, ids, archive, seenConsole, bodyText, createAccount, SRC })
  const personsCtx = () => ({ check, evalJs, asUser, axeBoth, viewport, sleep, clickText, setField, key, store, base, USER, PW, ids, archive, seenConsole, bodyText, SRC })
  const vocabCtx = () => ({ check, evalJs, axeBoth, viewport, sleep, send, navigate, PORT, PW, ids })
  if (process.env.GUI_CHECK_ONLY === 'vocab') { await runVocabChecks(vocabCtx()); throw ONLY_DONE }
  if (process.env.GUI_CHECK_ONLY === 'viewer') { await runViewerChecks(viewerCtx()); throw ONLY_DONE }
  if (process.env.GUI_CHECK_ONLY === 'team') { await runTeamChecks(teamCtx()); throw ONLY_DONE }
  if (process.env.GUI_CHECK_ONLY === 'persons') { await runPersonsChecks(personsCtx()); throw ONLY_DONE }

  await viewport('d')
  await asUser('', '', 5000)

  console.log('\ndesktop 1440x900 (map home)')
  const d = JSON.parse(await evalJs(`(() => {
    const R = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
    const app = document.getElementById('app');
    return JSON.stringify({
      appChildren: app ? app.children.length : -1,
      font: getComputedStyle(document.body).fontFamily,
      map: R('.leaflet-container'), pane: R('.app-two-pane-map'), rail: R('.app-two-pane-map > .case-detail-pane'),
      main: R('.app-main'), status: R('.app-status'),
      tiles: document.querySelectorAll('.leaflet-tile').length,
      legend: document.querySelectorAll('.ds-map-legend-item').length,
      innerW: window.innerWidth,
    });
  })()`))
  check(d.appChildren > 0, 'SPA mounted', `#app has ${d.appChildren} child(ren)`)
  check(!!d.map, 'map canvas present on the map home view')
  // DOCKED, not full-bleed (AGENTS.md "Dashboard structure"): the canvas fills its OWN pane -- the
  // region between the top bar and the status bar, right of the nav -- and the rail sits beside it,
  // never over it. A canvas at the viewport origin would mean the nav or the rail had been covered.
  // (The earlier "full-bleed at 0,0" check contradicted the documented design and failed on old code.)
  check(d.map && d.main && d.map[0] === d.main[0] && d.map[1] === d.main[1], 'map fills its pane from the pane origin (below the top bar, right of the nav)', d.map && `map ${d.map} pane origin ${d.main && d.main.slice(0, 2)}`)
  check(d.map && d.status && Math.abs(d.map[1] + d.map[3] - d.status[1]) <= 1, 'map runs down to the status bar', d.map && d.status && `map bottom ${d.map[1] + d.map[3]} vs status top ${d.status[1]}`)
  check(d.map && d.rail && d.map[0] + d.map[2] <= d.rail[0] + 1 && d.rail[2] >= 300 && d.rail[2] <= 480, 'rail is docked beside the map (not over it), 300-480px wide', d.rail && `map right ${d.map && d.map[0] + d.map[2]}, rail ${d.rail}`)
  check(d.map && d.map[2] >= d.innerW * 0.5, 'map takes at least half the viewport width', d.map && `${d.map[2]} of ${d.innerW}`)
  check(d.tiles > 0, 'map tiles loaded', `${d.tiles} tiles`)
  check(d.legend > 0, 'map legend rendered', `${d.legend} items`)
  check(/Ubuntu/.test(d.font), 'Ubuntu font applied to body', d.font.slice(0, 40))
  const legend = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('.ds-map-legend-item')].map((e) => e.innerText.trim()))`))
  check(legend.includes('Working on it') && legend.includes('Needs a person') && !legend.some((t) => /In Progress|Needs A Person/.test(t)), 'map legend uses the same words as the rest of the screen (Working on it, Needs a person)', legend.join(' | '))
  // The attention lead's "waiting" state (something needs a person) is a tinted red pill; the fixture may have
  // nothing waiting, so the state is applied to the real control rather than left to chance.
  await evalJs(`document.querySelector('.ds-attn-lead').classList.add('is-waiting'); 1`)
  await axeBoth('map home with the attention lead waiting')
  await evalJs(`document.querySelector('.ds-attn-lead').classList.remove('is-waiting'); 1`)
  await axeBoth('map home')

  console.log('\nmobile 390x844')
  await viewport('p')
  await sleep(2500)
  const m = JSON.parse(await evalJs(`(() => {
    const bar = document.querySelector('.ds-appbar');
    const bs = bar && getComputedStyle(bar);
    const cols = bs ? bs.gridTemplateColumns : null;
    const map = document.querySelector('.leaflet-container');
    return JSON.stringify({
      display: bs ? bs.display : null,
      cols,
      colCount: cols && cols !== 'none' ? cols.split(' ').length : 0,
      z: bs ? bs.zIndex : null,
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      mapW: map ? Math.round(map.getBoundingClientRect().width) : 0,
    });
  })()`))
  check(m.display === 'grid', 'mobile appbar is a grid', m.display)
  // The regression: auto-fit collapsed to ONE column and the "grid" was a stack.
  check(m.colCount >= 2, 'mobile icon grid has more than one column', `${m.colCount} cols (${m.cols})`)
  check(m.z !== 'auto' && Number(m.z) > 0, 'mobile appbar sits above the map', `z-index ${m.z}`)
  check(m.scrollW <= m.innerW, 'no horizontal overflow on mobile', `${m.scrollW} vs ${m.innerW}`)
  check(m.mapW >= m.innerW - 2, 'on a phone the map spans the full width', `${m.mapW} of ${m.innerW}`)

  console.log('\nrender budget + case heading (cases view, case detail)')
  const caseId = ids.A
  // Opening a case makes the best-effort per-run config request, which answers 404 on a
  // plain deployment by design (fetchRunConfig); it is not a defect of the later checks.
  const renders = () => evalJs('window.__renders')
  await viewport('d')
  await evalJs(`localStorage.casey_home_view = 'cases'; 1`)
  await navigate(base + '/#home=cases')
  await sleep(4000)
  const cold = await renders()
  await sleep(6000)
  const idle = (await renders()) - cold
  check(cold != null && cold <= 60, 'cases view cold open stays inside the render budget', `${cold} renders (budget 60)`)
  check(idle <= 5, 'cases view is quiet at idle (no render loop)', `${idle} renders in 6 s (budget 5)`)
  // The known-values filter bar asked for its list on EVERY render while the list was empty, and each
  // answer scheduled another render: an unbounded loop that only exists when a field has no recorded
  // value, which the seeded reports above never produce. So make it empty for real: answer the list
  // request with no values, drop the cache, kick one render, and count renders: fixed code settles in a
  // handful, the loop re-renders until the probe's cap (200).
  const emptyFrom = await renders()
  // A lower cap for this probe only: a loop then ends in a second or two as a failed check instead of a locked tab.
  await evalJs(`(() => { const W = window; W.__fvCalls = 0; W.__renderCap = W.__renders + 200; W.__fvFetch = W.fetch
    W.fetch = (u, ...a) => { if (String(u).includes('/api/field-values?')) { W.__fvCalls++; return Promise.resolve(new Response('{"values":[]}', { headers: { 'content-type': 'application/json' } })) } return W.__fvFetch(u, ...a) }
    return import('/src/known-values.js').then((m) => { m.invalidateKnownValues(); return import('/src/state.js') }).then((st) => { st.schedule(); return 1 }) })()`)
  await sleep(7500)
  const emptyIdle = (await renders()) - emptyFrom
  const fvCalls = await evalJs('window.__fvCalls')
  await evalJs(`(() => { window.__renderCap = 0; if (window.__fvFetch) window.fetch = window.__fvFetch; return import('/src/known-values.js').then((m) => { m.invalidateKnownValues(); return 1 }) })()`)
  check(fvCalls >= 1 && fvCalls <= 3, 'the empty-list probe reached the filter bar (its list was requested, not answered from a stale cache)', `${fvCalls} requests`)
  check(emptyIdle <= 12, 'an empty known-values list does not keep the page re-rendering', `${emptyIdle} renders in 7.5 s (budget 12; the loop spends its whole cap of 200)`)
  await evalJs(`location.hash = 'home=cases&case=' + ${JSON.stringify(caseId)}; 1`)
  await sleep(3000)
  const opened = await renders()
  await sleep(6000)
  const idleOpen = (await renders()) - opened
  check(idleOpen <= 5, 'an open case is quiet at idle (no render loop)', `${idleOpen} renders in 6 s (budget 5)`)
  const hd = JSON.parse(await evalJs(`JSON.stringify({ n: document.querySelectorAll('.casey-case-header-top h2').length, txt: (document.querySelector('.casey-case-header-top h2') || {}).textContent })`))
  check(hd.n === 1 && !!(hd.txt || '').trim(), 'case detail has exactly one h2 (the subject) in its header', `${hd.n} h2, "${(hd.txt || '').slice(0, 30)}"`)
  const cd = JSON.parse(await evalJs(`JSON.stringify({ claimed: (document.querySelector('.casey-claimed') || {}).innerText, gaps: [...document.querySelectorAll('.casey-detail-pane .ds-section')].map((e) => parseFloat(getComputedStyle(e).marginTop) + parseFloat(getComputedStyle(e).marginBottom)) })`))
  check(/^Claimed by GUI Ranger$/.test(cd.claimed || ''), 'the case header names the holder by their name, not their login', cd.claimed)
  check(cd.gaps.length > 0 && Math.max(...cd.gaps) === 0, 'sections inside a case carry no 96px page margins (the column gap sets the rhythm)', 'max ' + Math.max(0, ...cd.gaps) + 'px')
  await axeBoth('case detail (operator)')
  await evalJs(`localStorage.removeItem('casey_home_view'); 1`)

  console.log('\noperator: assign a report, no raw "agent" in the picker')
  await asUser('', '#home=cases&case=' + ids.C, 3500)
  const opts = JSON.parse(await evalJs(`(() => { const s = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => /Nobody yet/.test(o.text))); return JSON.stringify(s ? { opts: [...s.options].map((o) => o.value), cur: s.value } : null) })()`))
  check(!!opts && opts.cur === '' && !opts.opts.includes('agent'), 'a report held by the assistant reads "Nobody yet" in the Assigned-to picker, not the raw word agent', opts && `current "${opts.cur}"`)
  // A ranger who is BOTH a WhatsApp contact and a linked dashboard login is one person: the picker
  // lists them once and assigns with the contact key (which the login resolves through contact_phone).
  const rangerOpts = JSON.parse(await evalJs(`(() => { const s = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => /Nobody yet/.test(o.text))); return JSON.stringify([...s.options].filter((o) => /^GUI Ranger \\(/.test(o.text)).map((o) => o.value)) })()`))
  check(rangerOpts.length === 1 && rangerOpts[0].startsWith('contact:'), 'a ranger who is both a contact and a linked login is listed once, by the contact key', JSON.stringify(rangerOpts))
  await evalJs(`(() => { const s = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => /Nobody yet/.test(o.text))); s.value = ${JSON.stringify(rangerOpts[0] || '')}; s.dispatchEvent(new Event('change', { bubbles: true })); return 1 })()`)
  await sleep(300)
  await clickText('Save edits'); await sleep(1500)
  const assigned = await api('GET', '/api/cases/' + ids.C)
  check(assigned.j && assigned.j.case.assignee === rangerOpts[0], 'the operator assigned the report to a ranger through the picker', assigned.j && assigned.j.case.assignee)

  await asUser('', '#home=cases&case=does-not-exist', 3000)
  const gone = await evalJs(`(document.querySelector('.case-detail-pane') || {}).innerText`)
  check(/is not here any more/.test(gone || '') && !/^not found$/m.test(gone || ''), 'a link to a report that does not exist says so in words (not the raw "not found")', (gone || '').replace(/\n+/g, ' / ').slice(0, 90))

  console.log('\noperator: case list past one page')
  await asUser('', '#home=cases', 4000)
  const pg = JSON.parse(await evalJs(`(() => { const p = document.querySelector('.case-list-pane'); const more = [...p.querySelectorAll('button')].find((b) => /^Show \\d+ more/.test(b.innerText)); return JSON.stringify({ range: (p.querySelector('.ds-cl-range') || {}).innerText, more: more ? more.innerText : null }) })()`))
  check(/^Showing 50 of \d+ reports$/.test(pg.range || '') && !!pg.more, 'the list says how many of the total are shown and offers the rest', `${pg.range} / ${pg.more}`)
  const sw = JSON.parse(await evalJs(`(() => { const i = document.querySelector('.case-list-pane .ds-search-input'); const p = document.querySelector('.case-list-pane'); return JSON.stringify({ i: Math.round(i.getBoundingClientRect().width), p: Math.round(p.clientWidth) }) })()`))
  check(sw.i >= sw.p * 0.85, 'the search box fills its pane (its placeholder is not clipped)', `${sw.i}px of ${sw.p}px`)
  await clickText('Show'); await sleep(2000)
  const pg2 = await evalJs(`(document.querySelector('.case-list-pane .ds-cl-range') || {}).innerText`)
  check(/^All \d+ reports$/.test(pg2 || ''), 'Show more brings in the remaining reports', pg2)
  const domRows = await evalJs(`document.querySelectorAll('.case-row').length`)
  check(domRows > 0 && domRows < 80, 'with every report loaded the list draws only the rows in view (render budget: under 80 rows in the DOM)', domRows + ' rows for ' + pg2)
  // Bulk case 0 is the oldest: never in the first page, so only a search over every report finds it.
  await asUser('', '#home=cases', 4000)
  await setField('input[type=search]', 'Bulk case 0'); await sleep(1800)
  const hit = JSON.parse(await evalJs(`JSON.stringify({ rows: document.querySelectorAll('.case-row').length, text: [...document.querySelectorAll('.case-row')].map((r) => r.innerText).join(' ') })`))
  check(hit.rows >= 1 && /Bulk case 0\b/.test(hit.text), 'searching finds an old report the first page did not load', `${hit.rows} row(s)`)
  await axeBoth('case list')

  console.log('\nteam registration + invite codes (Reporters panel)')
  await asUser('', '#panel=contacts', 3500)
  await evalJs(`(() => { const e = document.querySelector('[name=invite-label]'); e.value = 'gui-check'; e.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
  await evalJs(`(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Make a code').click(); return 1 })()`)
  await sleep(1500)
  const t = JSON.parse(await evalJs(`(() => {
    const opts = (n) => { const s = document.querySelector('[name=' + n + ']'); return s ? [...s.options].map((o) => o.value) : null };
    const code = document.querySelector('.ds-invite-code');
    const page = (document.querySelector('.ds-people-page') || {}).innerText || '';
    return JSON.stringify({ reg: opts('team-role'), inv: opts('invite-role'), code: code ? code.dataset.inviteCode : null, page, filter: document.querySelectorAll('.ds-people-filter button').length });
  })()`))
  check(!!t.reg && !t.reg.includes('reporter') && t.reg.includes('operator'), 'register form offers the roles above the public rung, operator included for an admin', t.reg && t.reg.join(','))
  check(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(t.code || ''), 'creating an invite shows the one-time code in a copyable block', t.code)
  check(!/\b(tier|rung|hash)\b/i.test(t.page), 'the people/invite screens use no tier/rung/hash jargon')
  check(t.filter === 3 || t.filter === 0, 'team / public / everyone filter present when contacts exist', String(t.filter))
  const team = await api('GET', '/api/contacts?segment=team')
  check(team.j && team.j.counts && team.j.counts.team >= 2 && team.j.contacts.every((c) => c.tier !== 'reporter') && team.j.counts.public >= 1, 'the team segment is asked of the server over every contact (never cut off by the public reporters)', team.j && JSON.stringify(team.j.counts))
  await clickText('Cancel code'); await sleep(700)
  const dlgFocus = await evalJs(`(() => { const d = document.querySelector('[role=dialog]'); return d ? d.innerText.slice(0, 40) : 'none' })()`)
  check(/Cancel this invite code/.test(dlgFocus), 'cancelling a code asks first', dlgFocus)
  await axeBoth('reporters panel with the cancel-code dialog open (destructive button)')
  await clickText('Cancel the code'); await sleep(1200)
  const left = await evalJs(`[...document.querySelectorAll('.ds-invite tbody tr')].filter((r) => /gui-check/.test(r.innerText) && /Waiting to be used/i.test(r.innerText)).length`)
  check(left === 0, 'the test invite was cancelled again', String(left))
  await axeBoth('reporters panel')

  console.log('\noperator: who needs a nudge')
  await asUser('', '#panel=nudges', 3500)
  const n = JSON.parse(await evalJs(`(() => {
    const main = document.querySelector('main, .app-main');
    const links = [...main.querySelectorAll('a[href^="https://wa.me"]')];
    return JSON.stringify({
      text: main.innerText, rows: main.querySelectorAll('.row').length, panels: main.querySelectorAll('.panel').length,
      links: links.map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel, name: a.getAttribute('aria-label') || a.innerText })),
    });
  })()`))
  check(n.panels >= 2 && n.rows >= 3, 'the nudge panel is built from kit panels and rows (a block per person, a row per report)', `${n.panels} panels, ${n.rows} rows`)
  check(!/(on it|last wrote|update on it) (not recorded|never recorded)/.test(n.text), 'the nudge sentences never read "... on it not recorded" (a colon states a missing time instead)', (n.text.match(/Given to them: [^.]*\./) || [''])[0])
  check(n.links.length >= 2 && n.links.every((l) => /^https:\/\/wa\.me\/\d+\?text=[^\s"<>]+$/.test(l.href) && l.target === '_blank' && /noopener/.test(l.rel)), 'each WhatsApp nudge is an encoded wa.me link that opens in a new tab', n.links[0] && n.links[0].href.slice(0, 60))
  const decoded = n.links[0] ? decodeURIComponent(n.links[0].href.split('text=')[1]) : ''
  check(/^Hi GUI \w+/.test(decoded) && /assigned to you/.test(decoded), 'the drafted nudge reads as a person wrote it', decoded.slice(0, 70))
  check(n.links.every((l) => /Message on WhatsApp/.test(l.name)), 'the link name starts with its visible text', n.links[0] && n.links[0].name)
  await axeBoth('nudges panel')

  console.log('\nplain words on the operator panels')
  for (const [panel, banned, label] of [
    ['activity', /"tier"|"label"|\{"/, 'the activity feed never prints a raw JSON line (the invite log is bookkeeping, not activity)'],
    ['handover', /\bAGENT\b|Open handoffs/, 'the shift handover names people and situations, not the raw word AGENT or "handoffs"'],
    ['secretary', /\tagent\t|\bagent\b(?!\s+is)/i, 'the follow-up list shows "unassigned", not the raw word agent'],
    ['metrics', /\bp90\b|\bdwell\b|\bSLA\b/, 'the trends page uses no p90 / dwell / SLA'],
  ]) {
    await asUser('', '#panel=' + panel, 3200)
    const txt = await evalJs(`(document.querySelector('main, .app-main') || document.body).innerText`)
    check(!banned.test(txt || ''), label, (txt || '').match(banned) ? 'found "' + (txt.match(banned) || [''])[0].trim() + '"' : 'clean')
  }
  await asUser('', '#home=cases&case=' + ids.A, 3500)
  const tl = await evalJs(`document.body.innerText`)
  check(!/Guardrail check/.test(tl || ''), 'the case timeline calls automatic notes "Automatic note", not "Guardrail check"')

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

  // WCAG AA text contrast. Caught a real 3.27:1 failure on the alert count,
  // because casey coloured it with --danger (the brand red kept for FILLS)
  // rather than the --danger-ink companion the kit already expected but no
  // theme defined. On a surveillance dashboard the alert count is precisely the
  // text that must be readable outdoors on a phone.
  const CONTRAST_JS = `(() => {
    const lum = (c) => { const [r,g,b] = c.map(v => { v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4) }); return 0.2126*r + 0.7152*g + 0.0722*b };
    const parse = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { rgb: p.slice(0,3), a: p.length > 3 ? p[3] : 1 } };
    const bgOf = (el) => { let e = el; while (e && e !== document.documentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.5) return c.rgb; e = e.parentElement } return [255,255,255] };
    const ratio = (a,b) => { const l1 = lum(a), l2 = lum(b), hi = Math.max(l1,l2), lo = Math.min(l1,l2); return (hi+0.05)/(lo+0.05) };
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
      // Inside a closed <details> nothing is painted, and Chromium reports a stale box and colour for it.
      if (el.closest('details:not([open])') && !el.closest('summary')) continue;
      const txt = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim();
      if (!txt) continue;
      const fg = parse(cs.color);
      if (!fg || fg.a <= 0.5) continue;
      const size = parseFloat(cs.fontSize), weight = Number(cs.fontWeight) || 400;
      const need = (size >= 24 || (size >= 18.66 && weight >= 700)) ? 3 : 4.5;
      const cr = ratio(fg.rgb, bgOf(el));
      if (cr < need) out.push(Math.round(cr*100)/100 + ':1 (need ' + need + ') "' + txt.slice(0,30) + '"');
    }
    return JSON.stringify(out);
  })()`

  // BOTH themes. The dark preset had never been audited live and carried ten
  // failures, including a tier-3 surface that stayed light while its text
  // followed the theme (1.16:1) and map cluster counts at 2.03:1. Checking only
  // the theme that happens to be active is how that survived.
  for (const th of ['herd', 'herd-ink']) {
    await theme(th)
    const low = JSON.parse(await evalJs(CONTRAST_JS))
    check(low.length === 0, `all text meets WCAG AA contrast (${th})`, low.length ? `${low.length} failing, e.g. ${low[0]}` : 'no failures')
  }
  await theme('herd')
  // A 404 is judged below, by URL; a basemap tile the upstream provider would not serve is the internet's, not the app's; the /api/ready probe answers 503 while a write holds the
  // sqlite file (busy_timeout is 0 by design), which the connection banner already treats as a moment, not an outage.
  archive()
  const consoleBad = seenConsole.filter((m) => !/status of 404/.test(m) && !/<\/(api\/)?tiles?\//.test(m) && !/<\/api\/ready>/.test(m))
  check(consoleBad.length === 0, 'browser console clean', consoleBad.length ? consoleBad[0] : 'no errors or warnings')
  const unexpected = seenFailed.filter((r) => !/\/api\/runs\/[^/]+\/(config|notes)$/.test(r) && !/\/api\/cases\/does-not-exist$/.test(r) && !/\/api\/ready$/.test(r))
  check(unexpected.length === 0, 'no failed requests', unexpected.length ? [...new Set(unexpected)][0] : 'none')

  // ---- role-shaped screens: each field-team login gets its own narrow home, and
  // the server (not the screen) refuses everything outside it.
  for (const [suffix, homeLabel, label, expected] of [['-rng', 'My ', 'eco ranger', 3], ['-aht', 'Ready to sign off', 'animal health technician', 2]]) {
    console.log(`\nrole home: ${label}`)
    await viewport('d')
    await asUser(suffix, '', 4000)
    const r = JSON.parse(await evalJs(`(async () => {
      const nav = [...document.querySelectorAll('nav a, nav button, aside a, aside button')].map((e) => e.innerText.trim()).filter(Boolean);
      const code = async (p) => (await fetch(p)).status;
      const list = await (await fetch('/api/cases')).json();
      return JSON.stringify({
        nav, hasMapHomeShell: !!document.querySelector('.app-two-pane-map'),
        codes: { accounts: await code('/api/accounts'), thresholds: await code('/api/thresholds'), csv: await code('/api/report.csv'), contacts: await code('/api/contacts'), cases: await code('/api/cases') },
        listed: (list.cases || []).length, whoami: (await (await fetch('/api/whoami')).json()).role,
        scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
        rows: [...document.querySelectorAll('.row')].map((e) => e.querySelector('.title').getAttribute('title') || ''),
      });
    })()`))
    check(r.nav.length === 2 && r.nav[0].startsWith(homeLabel) && r.nav[1] === 'Map', `${label}: nav is only their home and the map`, r.nav.join(' | '))
    check(!r.hasMapHomeShell, `${label}: not the operator console`)
    check(r.codes.accounts === 403 && r.codes.thresholds === 403 && r.codes.csv === 403 && r.codes.contacts === 403, `${label}: accounts, thresholds, exports and contacts are refused by the server`, JSON.stringify(r.codes))
    check(r.codes.cases === 200 && r.listed === expected, `${label}: the case list answers, scoped to what they may see`, `${r.listed} listed (expected ${expected})`)
    check(r.scrollW <= r.innerW, `${label}: no horizontal overflow`, `${r.scrollW} vs ${r.innerW}`)
    check(r.rows.length > 0 && r.rows.every((t) => !/CASE-\d/.test(t)), `${label}: a row title is what the report is about, not a reference that wraps mid-id`, r.rows.slice(0, 2).join(' | '))
    await axeBoth(`${label} home`)
  }

  console.log('\neco ranger with nothing assigned')
  await asUser('-rng0', '', 3500)
  const zero = JSON.parse(await evalJs(`JSON.stringify({ text: document.body.innerText, map: !!document.querySelector('.leaflet-container'), status: (document.querySelector('.app-status') || {}).innerText })`))
  check(/No report is assigned to you right now/.test(zero.text), 'a ranger with nothing assigned is told so, and how a report will reach them')
  check(!zero.map, 'no empty country map is shown for a ranger who has nothing to place')
  check(/You have 0 reports/.test(zero.status || ''), 'the status bar reads as a sentence', (zero.status || '').replace(/\n/g, ' ').slice(0, 60))
  await axeBoth('eco ranger with nothing assigned')

  console.log('\neco ranger: one report, browser Back, stale tab, session end')
  await viewport('p')
  await asUser('-rng', '', 3500)
  const openA = await evalJs(`(() => { const r = [...document.querySelectorAll('.row')].find((r) => /goats/.test(r.innerText)); if (!r) return false; r.click(); return true })()`)
  await sleep(1500)
  const cl = JSON.parse(await evalJs(`(() => {
    const list = document.querySelector('[role=group][aria-label*="needs before"]');
    return JSON.stringify({ hash: location.hash, checklist: list ? list.innerText : null, wa: !!document.querySelector('a[href^="https://wa.me"]') });
  })()`))
  check(openA && /^#case=/.test(cl.hash), 'opening a report puts it in the address', cl.hash)
  check(!!cl.checklist && /Still needed/.test(cl.checklist) && /Recorded: goats/.test(cl.checklist), 'the checklist says in words what is recorded and what is still needed (not colour alone; the kit hides the code column on a phone)', cl.checklist && cl.checklist.replace(/\n+/g, ' / ').slice(0, 90))
  check(cl.wa, 'the reporter message link is present on a report assigned to them')
  await axeBoth('eco ranger report')
  await evalJs('history.back()'); await sleep(1300)
  const back = JSON.parse(await evalJs(`JSON.stringify({ hash: location.hash, home: /My reports/.test(document.body.innerText), pane: /Reach the reporter/.test(document.body.innerText) })`))
  check(back.home && !back.pane && back.hash === '', 'the browser Back button returns from a report to the list (a phone Back button must not leave the dashboard)', JSON.stringify(back))
  await evalJs('history.forward()'); await sleep(1300)
  check(/Reach the reporter/.test(await bodyText()), 'browser Forward reopens the report')
  // Record a note, double-click the confirm: exactly one note lands.
  await evalJs(`(() => { const t = [...document.querySelectorAll('textarea')].find((e) => /reporter told/i.test((e.labels && e.labels[0]) ? e.labels[0].innerText : '')); t.value = 'Farmer says 12 goats limping'; t.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
  await clickText('Save to'); await sleep(700)
  const conf = await evalJs(`(() => { const d = document.querySelector('[role=dialog]'); return d ? d.innerText.replace(/\\n+/g, ' / ').slice(0, 120) : 'none' })()`)
  check(/Record on CASE-/.test(conf), 'recording asks the ranger to confirm which report, by reference', conf)
  await evalJs(`(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find((x) => /Yes, this is/.test(x.innerText)); b.click(); b.click(); return 1 })()`)
  await sleep(2200)
  const evs = await api('GET', '/api/cases/' + ids.A)
  const notes = (evs.j.events || []).filter((e) => e.kind === 'note')
  check(notes.length === 1, 'a double-clicked confirm saves exactly one note', String(notes.length))
  const waAfter = await evalJs(`!!document.querySelector('a[href^="https://wa.me"]')`)
  check(waAfter, 'the reporter message link is still there after a save (the screen keeps the audited read, not the write response)')
  const focusBack = await evalJs(`(() => { const a = document.activeElement; return a ? (a.innerText || a.getAttribute('aria-label') || a.tagName).slice(0, 30) : 'none' })()`)
  check(/Sav/.test(focusBack), 'after the confirm dialog closes, focus returns to the control that opened it', focusBack)
  // Stale tab: an operator takes the report away while this one is open.
  await asUser('-rng', '#case=' + ids.A, 3500)
  // The operator takes the report away from a separate session, while this tab still has it open.
  const opLogin = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PW }) })
  const opCookie = (opLogin.headers.get('set-cookie') || '').split(';')[0]
  const took = await fetch(base + '/api/cases/' + ids.A, { method: 'PATCH', headers: { cookie: opCookie, 'content-type': 'application/json' }, body: JSON.stringify({ assignee: '' }) })
  check(took.status === 200, 'an operator can take the report off the ranger while the ranger has it open', String(took.status))
  await evalJs(`(() => { const t = [...document.querySelectorAll('textarea')].find((e) => /reporter told/i.test((e.labels && e.labels[0]) ? e.labels[0].innerText : '')); t.value = 'second note after it was taken away'; t.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
  await clickText('Save to'); await sleep(500)
  await evalJs(`(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find((x) => /Yes, this is/.test(x.innerText)); if (b) b.click(); return 1 })()`)
  await sleep(2500)
  const stale = JSON.parse(await evalJs(`JSON.stringify({ toast: [...document.querySelectorAll('#toasts .ds-toast-item')].map((e) => e.innerText).join(' | '), body: document.body.innerText })`))
  check(!/\bnot found\b/i.test(stale.toast) && /no longer available to you|no longer yours/.test(stale.toast + stale.body), 'a write to a report that was taken away says so in plain words (no "not found")', stale.toast.slice(0, 120))
  check(/This report is no longer yours/.test(stale.body) && /second note after it was taken away/.test(stale.body), 'the screen says the report is no longer theirs and keeps what they typed for copying')
  await fetch(base + '/api/cases/' + ids.A, { method: 'PATCH', headers: { cookie: opCookie, 'content-type': 'application/json' }, body: JSON.stringify({ assignee: USER + '-rng' }) })
  // Session end mid-action.
  await asUser('-rng', '#case=' + ids.L, 3500)
  await evalJs(`(() => { const t = [...document.querySelectorAll('textarea')].find((e) => /reporter told/i.test((e.labels && e.labels[0]) ? e.labels[0].innerText : '')); t.value = 'typed before the session ended'; t.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
  await evalJs(`fetch('/api/logout', { method: 'POST' }).then((r) => r.status)`)
  await clickText('Save to'); await sleep(500)
  await evalJs(`(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find((x) => /Yes, this is/.test(x.innerText)); if (b) b.click(); return 1 })()`)
  await sleep(2500)
  const gate = await bodyText()
  check(/Log in/.test(gate) && /signed out/i.test(gate), 'a session that ended mid-action shows the sign-in screen with a plain reason', gate.replace(/\n+/g, ' / ').slice(0, 140))

  console.log('\ntechnician: sign off, send back')
  await viewport('d')
  await asUser('-aht', '#case=' + ids.D, 3500)
  const inc = JSON.parse(await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((e) => /^Sign off/.test(e.innerText)); return JSON.stringify({ disabled: b && b.disabled, hint: /Sign off is unavailable until/.test(document.body.innerText) }) })()`))
  check(inc.disabled === true && inc.hint, 'an incomplete report cannot be signed off, and says what is missing', JSON.stringify(inc))
  await clickText('Send back to ranger'); await sleep(600)
  const sb = await evalJs(`(() => { const d = document.querySelector('[role=dialog]'); return d ? d.innerText.replace(/\\n+/g, ' / ').slice(0, 130) : 'none' })()`)
  check(/back/.test(sb) && /still needed/.test(sb), 'Send back names the report and what is missing', sb)
  await key('Escape'); await sleep(400)
  await asUser('-aht', '#case=' + ids.G, 3500)
  await clickText('Sign off CASE'); await sleep(600)
  await evalJs(`(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find((x) => /^Sign off/.test(x.innerText)); b.click(); return 1 })()`)
  // The sign-off then asks for the diagnosis: the disease identified, then the recommendation.
  const asked = []
  for (const answer of ['Foot-and-mouth disease suspected', 'Isolate the herd and call the state vet']) {
    await sleep(700)
    asked.push(await evalJs(`(() => { const d = document.querySelector('[role=dialog]'); if (!d) return 'none'; const i = d.querySelector('input, textarea'); if (i) { const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set; set.call(i, ${JSON.stringify(answer)}); i.dispatchEvent(new Event('input', { bubbles: true })) } const b = [...d.querySelectorAll('button')].find((x) => /^Continue/.test(x.innerText)); if (b) b.click(); return d.querySelector('h1,h2,[class*=title]') ? d.querySelector('h1,h2,[class*=title]').innerText : 'dialog' })()`))
  }
  check(asked.every((t) => /Disease identified|Recommended resolution/.test(t)), 'sign-off asks for the disease identified and the recommended resolution', JSON.stringify(asked))
  await sleep(2800)
  const so = await api('GET', '/api/cases/' + ids.G)
  check(so.j && so.j.case.status === 'resolved', 'a complete report is signed off (double click: one transition)', so.j && so.j.case.status)
  const after = JSON.parse(await evalJs(`JSON.stringify({ signed: /Signed off/.test(document.body.innerText), again: !![...document.querySelectorAll('button')].find((e) => /^Sign off CASE/.test(e.innerText)) })`))
  check(after.signed && !after.again, 'a signed-off report shows "Signed off" and no longer offers to be signed off again', JSON.stringify(after))
  await axeBoth('technician report (signed off)')
  await asUser('-aht', '#case=' + ids.D, 3500)
  await axeBoth('technician report (incomplete)')

  console.log('\nphone touch targets and high-contrast fields')
  const SMALL_JS = `JSON.stringify([...document.querySelectorAll('a[href], button, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea, summary, [role=button]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('.leaflet-container') && !e.classList.contains('app-status-toggle') && (r.height < 43.5 || r.width < 43.5) }).map((e) => e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0] + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height) + ' ' + (e.getAttribute('aria-label') || e.innerText || e.name || '').replace(/\\n/g, ' ').slice(0, 24)))`
  await viewport('p')
  for (const [suffix, hash, label] of [['-rng', '', 'ranger home'], ['-rng', '#case=' + ids.L, 'ranger report'], ['-aht', '#case=' + ids.D, 'technician report'], ['', '#home=cases&case=' + ids.A, 'operator report'], ['', '#panel=contacts', 'people panel'], ['', '#panel=nudges', 'nudge panel']]) {
    await asUser(suffix, hash, 3500)
    const small = JSON.parse(await evalJs(SMALL_JS))
    check(small.length === 0, `phone: every control is at least 44px on ${label} (buttons, links, fields, selects)`, small.slice(0, 3).join(' ; '))
    if (label === 'ranger home') {
      const icon = await evalJs(`(() => { const s = document.querySelector('[aria-label="toggle navigation"] svg'); return s ? Math.round(s.getBoundingClientRect().width) : -1 })()`)
      check(icon >= 14, 'phone: the navigation toggle still shows its icon (the kit\'s touch padding once squeezed it to 2px)', icon + 'px')
    }
  }
  await asUser('-rng', '#case=' + ids.L, 3500)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] }); await sleep(600)
  const fc = await evalJs(`(() => { const t = document.querySelector('textarea'); const cs = getComputedStyle(t); return matchMedia('(forced-colors: active)').matches && (parseFloat(cs.borderTopWidth) > 0 || cs.outlineStyle !== 'none') })()`)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'none' }] })
  check(fc === true, 'high contrast (forced colors): a text box still has a visible edge')

  console.log('\nfield-team account menu')
  await asUser('-rng', '', 3500)
  await clickText('GUI Ranger'); await sleep(600)
  await axeBoth('eco ranger account menu open (danger item)')

  if (process.env.GUI_CHECK_SKIP !== 'team') await runTeamChecks(teamCtx())
  await runPersonsChecks(personsCtx())
  await runViewerChecks(viewerCtx())
  await runVocabChecks(vocabCtx())
} catch (e) {
  if (e !== ONLY_DONE) {
    console.error('[gui-check] ERROR:', e.message)
    failures.push('harness: ' + e.message)
  }
} finally {
  try { ws && ws.close() } catch { /* closing a dead socket is not a failure */ }
  try { chrome && chrome.kill() } catch { /* already gone */ }
  try { if (dash?.close) await dash.close() } catch { /* already closed */ }
  process.chdir(os.tmpdir())
  try { rmSync(SCRATCH, { recursive: true, force: true }) } catch { /* the OS clears tmp */ }
}

console.log(failures.length ? `\n[gui-check] ${failures.length} FAILED: ${failures.join('; ')}` : '\n[gui-check] all checks passed')
process.exit(failures.length ? 1 : 0)
