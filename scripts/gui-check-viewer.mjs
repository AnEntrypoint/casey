

import http from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const { resolveRole, ACCOUNT_ROLES, isViewer } = await import(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dashboard', 'roles.js'))
import { seedResolved } from './gui-seed-resolved.mjs'

const ALLOWED = [
  '/api/config', '/api/overview', '/api/whoami',
  '/api/reports/resolved-map', '/api/reports/diseases', '/api/reports/heat', '/api/reports/areas', '/api/reports/heat?advice=Vaccination', '/api/reports/export.csv',
  '/api/reports/resolved-map?region=Upper%20Lambasi', '/api/reports/diseases?grain=quarter', '/api/reports/heat?scope=all',
  '/api/reports/diseases?from=2026-01-01&to=2026-06-30',
  '/api/reports/diseases/print', '/api/reports/diseases/print?grain=quarter', '/api/reports/files',
]

async function forbiddenValues(store) {
  const out = new Set()
  const add = (v) => { const s = String(v == null ? '' : v).trim(); if (s.length >= 4) out.add(s) }
  for (const c of await store.listCases({}, { limit: 10000 })) {
    add(c.id); add(c.ref); add(c.external_id); add(c.subject); add(c.contact_id); add(c.assignee)
    const r = c.report ? JSON.parse(c.report) : {}
    add(r.location); add(r.owner_name); add(r.present_person)
  }
  for (const k of await store.listContacts({ limit: 5000 })) { add(k.display_name); add(k.external_id); add(k.notes) }
  for (const w of ['Seed Farmer', 'Farmer 0', 'GUI Ranger', 'GUI Technician', 'GUI Check', 'Public Pete', 'guicheck-rng', 'guicheck-aht', 'guicheck-rng2', 'guicheck-rng0', 'Seed report', 'Dlamini', '0821112222', 'clinic, call']) add(w)
  return [...out]
}

const PHONE = /(?<![\d.])(\+?27|0)[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{4}(?!\d)|\d{8,}/
function stringsOf(v, out = []) {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => stringsOf(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => stringsOf(x, out))
  return out
}

function rawRequest(port, method, path, cookie) {
  return new Promise((resolve) => {
    const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? '{}' : null
    const headers = { cookie, 'content-type': 'application/json', ...(body ? { 'content-length': String(body.length) } : {}) }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let b = ''; res.on('data', (d) => { b += d }); res.on('end', () => resolve({ status: res.statusCode, body: b }))
    })
    req.on('error', () => resolve({ status: 0, body: '' }))
    req.end(body || undefined)
  })
}

export async function runViewerChecks(c) {
  const { check, evalJs, asUser, axeBoth, viewport, sleep, clickText, store, PORT, USER, PW, ids, archive, seenConsole, seenFailed, bodyText, send } = c

  const shot = async (name) => {
    if (!process.env.GUI_CHECK_SHOTS) return
    mkdirSync(process.env.GUI_CHECK_SHOTS, { recursive: true })
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path.join(process.env.GUI_CHECK_SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64'))
  }
  const seen0 = { c: seenConsole.length, f: seenFailed.length }
  console.log('\nviewer: seed 300 reports (diseases, species, areas, dates, stages)')
  const t0 = Date.now()
  const made = await seedResolved(store, { n: 300 })

  const { case: odd } = await store.findOrCreateCase({ channel: 'whatsapp', external_id: '27790009999', contact: { name: 'Odd Farmer', phone: '27790009999' }, subject: 'Odd report' })
  await store.mergeReport(odd.id, { species: 'cattle', symptoms: 'x', location: 'y', association: 'Upper Lambasi' }, { id: 'seed', role: 'agent' })
  await store.updateCase(odd.id, { lat: -31.55, lon: 29.35 }, { id: 'casey-system', role: 'admin' })
  await store.mergeReport(odd.id, { identified_disease: 'Anthrax 0821112222 Mr Dlamini', recommended_resolution: 'x' }, { id: 'aht', role: 'operator' }, { bypassObserve: true, autoAssign: false })
  for (const to of ['triaging', 'in_progress', 'resolved']) await store.transition(odd.id, to, { user: { id: 'casey-system', role: 'admin' }, reason: 'seed' })
  check(made.resolved > 100 && made.open > 50, 'seeded a spread of stages', `${JSON.stringify(made)} in ${Date.now() - t0}ms`)

  console.log('\nviewer: role x route matrix')
  check(resolveRole('viewer') === 'viewer' && ['wizard', 'Viewer', 'VIEWER', ' viewer', '', null, undefined, 'viewer,admin'].every((v) => resolveRole(v) === 'eco_ranger'), 'only the exact name viewer resolves to viewer; a forged, cased, blank or missing role resolves to least privilege (eco_ranger), never to viewer or staff', ACCOUNT_ROLES.join(','))
  check(isViewer({ role: 'viewer' }) && !isViewer({ role: 'Viewer' }) && !isViewer({ role: 'admin' }) && !isViewer(null), 'isViewer is an exact-name test')
  {
    const adm = (await fetch(`http://127.0.0.1:${PORT}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PW }) })).headers.get('set-cookie').split(';')[0]
    const mk = async (username, role) => { const r = await fetch(`http://127.0.0.1:${PORT}/api/accounts`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: adm }, body: JSON.stringify({ username, password: PW + 'x1', display_name: 'Made ' + username, role }) }); return [r.status, await r.json().catch(() => ({}))] }
    const okA = await mk('guicheck-vw2', 'viewer'), badA = await mk('guicheck-bad', 'viewer-admin')
    check(okA[0] < 300 && (okA[1].account || okA[1]).role === 'viewer', 'the admin account API creates a viewer login', okA[0] + ' ' + JSON.stringify(okA[1]).slice(0, 120))
    check(badA[0] === 400, 'the admin account API refuses an unknown role', badA[0] + ' ' + JSON.stringify(badA[1]).slice(0, 100))
  }
  await viewport('d')
  await asUser('-vw', '', 5000)
  const cookie = await (async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER + '-vw', password: PW }) })
    return (r.headers.get('set-cookie') || '').split(';')[0]
  })()
  const cid = ids.A
  const DENY = [
    ['GET', '/api/cases'], ['GET', '/api/cases?limit=5'], ['GET', '/api/cases/' + cid], ['GET', '/api/cases/' + cid + '/events'],
    ['GET', '/api/cases/export.csv'], ['POST', '/api/cases'], ['PATCH', '/api/cases/' + cid], ['POST', '/api/cases/' + cid + '/note'],
    ['POST', '/api/cases/' + cid + '/transition'], ['POST', '/api/cases/' + cid + '/reply'], ['POST', '/api/cases/bulk'],
    ['GET', '/api/contacts'], ['POST', '/api/contacts/register'], ['GET', '/api/role-invites'], ['POST', '/api/role-invites'],
    ['GET', '/api/accounts'], ['POST', '/api/accounts'], ['DELETE', '/api/accounts/x'], ['GET', '/api/operators'], ['GET', '/api/team-members'],
    ['GET', '/api/nudges'], ['GET', '/api/areas'], ['POST', '/api/areas'], ['GET', '/api/my-day'], ['GET', '/api/roles/roster'], ['POST', '/api/roles/import'],
    ['GET', '/api/map/cases'], ['GET', '/api/map/workers'], ['GET', '/api/map/last-reports'], ['GET', '/api/operators/identities'],
    ['GET', '/api/report.csv'], ['GET', '/api/report.json'], ['GET', '/api/report.html'], ['GET', '/api/audit.csv'],
    ['GET', '/api/stats'], ['GET', '/api/geo'], ['GET', '/api/clusters'], ['GET', '/api/distribution'], ['GET', '/api/fleet-health'],
    ['GET', '/api/thresholds'], ['POST', '/api/thresholds'], ['GET', '/api/health'], ['GET', '/api/handover'], ['GET', '/api/activity'],
    ['GET', '/api/attention'], ['GET', '/api/unreplied'], ['GET', '/api/flagged-replies'], ['GET', '/api/secretary/queue'], ['GET', '/api/field-values'],
    ['GET', '/api/external-links'], ['GET', '/api/feedback'], ['POST', '/api/feedback'], ['POST', '/api/sweep'], ['GET', '/api/runtime'],
    ['GET', '/API/cases'], ['GET', '/API/contacts'], ['GET', '/Api/accounts'], ['GET', '/API/report.csv'], ['GET', '/API/REPORTS/DISEASES'], ['GET', '/api/Reports/heat'],
    ['GET', '/api/reports/heat/'], ['GET', '/api/reports/'], ['GET', '/api/reports'], ['POST', '/api/reports/heat'], ['HEAD', '/api/cases'], ['OPTIONS', '/api/cases'],
    ['GET', '/api/reports/heat/../cases'], ['GET', '/api/reports/%2e%2e/cases'], ['GET', '/api//cases'], ['GET', '/api/%63ases'], ['GET', '/api/reports/heat%2f..%2fcases'],
  ]
  const MEDIA = [
    '/media/' + cid + '/x.jpg', '/MEDIA/' + cid + '/x.jpg', '/Media/' + cid + '/x.jpg', '/media/', '/media', '/media/%2e%2e/' + cid + '/x.jpg',
    '/media/' + cid + '/../' + ids.C + '/x.jpg', '/media/' + cid + '/%2e%2e/' + ids.C + '/x.jpg', '/media/..%2f' + ids.C + '/x.jpg', '/media/%252e%252e/' + cid + '/x',
  ]
  const wrong = []
  const seen = {}
  for (const [m, p] of DENY) {
    const r = await rawRequest(PORT, m, p, cookie)
    seen[m + ' ' + p] = r.status

    if (!(r.status === 403 || r.status === 404) || /"(ref|external_id|subject)"/.test(r.body)) wrong.push(`${m} ${p} -> ${r.status}`)
  }
  for (const p of MEDIA) {
    const r = await rawRequest(PORT, 'GET', p, cookie)
    seen['GET ' + p] = r.status
    if (r.status !== 404 && r.status !== 403) wrong.push(`GET ${p} -> ${r.status}`)
  }
  const n403 = Object.values(seen).filter((s) => s === 403).length, n404 = Object.values(seen).filter((s) => s === 404).length
  check(wrong.length === 0, `viewer is refused on all ${DENY.length + MEDIA.length} case/contact/account/team/map/export/media requests (${n403} x 403, ${n404} x 404)`, wrong.length ? wrong.slice(0, 4).join(' ; ') : 'none let through')
  const on403 = DENY.filter(([m, p]) => !/^\/api\/(%63|\/)/.test(p) && !/\.\./.test(p) && !/%2e/i.test(p) && seen[m + ' ' + p] !== 403).map(([m, p]) => `${m} ${p}=${seen[m + ' ' + p]}`)
  check(on403.length === 0, 'every ordinary /api spelling (incl. /API capitalisation, trailing slash, wrong method) answers exactly 403 role_forbidden', on403.slice(0, 3).join(' ; ') || 'all 403')
  const mediaNon404 = MEDIA.filter((p) => seen['GET ' + p] !== 404)
  check(mediaNon404.length === 0, 'every /media spelling (case, traversal, encoded dots) is 404 for a viewer', mediaNon404.join(' ; ') || 'all 404')
  const okRows = []
  for (const p of ALLOWED) { const r = await rawRequest(PORT, 'GET', p, cookie); okRows.push([p, r.status]) }
  check(okRows.every(([, s]) => s === 200), 'the aggregate routes answer 200 for a viewer', okRows.map(([p, s]) => s + ' ' + p.replace('/api/', '')).join(' | ').slice(0, 300))

  const who = JSON.parse((await rawRequest(PORT, 'GET', '/api/whoami', cookie)).body)
  check(who.role === 'viewer', 'whoami reports the role viewer', JSON.stringify(who))
  console.log('  matrix (method path -> status), witnessed:')
  for (const [k, v] of Object.entries(seen).slice(0, 200)) console.log('    ' + String(v).padEnd(4) + k.slice(0, 90))

  console.log('\nviewer: PII scan of every payload')
  const bad = [], sizes = []
  const forbidden = await forbiddenValues(store)
  const payloads = []
  const variants = [...ALLOWED, '/api/reports/resolved-map?region=unknown', '/api/reports/heat?scope=all&from=2026-01-01', '/api/reports/heat?disease=Anthrax', '/api/reports/diseases?region=Upper%20Lambasi&grain=year', '/api/overview?days=90', '/api/reports/diseases?from=x']
  for (const p of variants) {
    const r = await rawRequest(PORT, 'GET', p, cookie)
    payloads.push([p, r.body]); sizes.push(r.body.length)
    for (const f of forbidden) if (r.body.includes(f)) bad.push(`${p} contains "${f.slice(0, 30)}"`)
    if (p === '/api/reports/export.csv' || p.startsWith('/api/reports/diseases/print')) { if (PHONE.test(r.body)) bad.push(p + ' has a phone-like run') } else {
      let j = null; try { j = JSON.parse(r.body) } catch {  }
      if (j) for (const s of stringsOf(j)) if (PHONE.test(s)) bad.push(`${p} string "${s.slice(0, 30)}" is phone-like`)
    }
  }
  check(bad.length === 0, `no reference, id, name, subject, number, login or free-text marker in ${variants.length} viewer payloads (${forbidden.length} store values searched)`, bad.slice(0, 3).join(' ; ') || `${(sizes.reduce((a, b) => a + b, 0) / 1024).toFixed(0)} KB scanned, clean`)
  const map = JSON.parse(payloads.find(([p]) => p === '/api/reports/resolved-map')[1])
  const allowedKeys = new Set(['lat', 'lon', 'disease', 'species', 'status', 'advice', 'resolved_at'])
  const badKeys = map.points.filter((p) => Object.keys(p).some((k) => !allowedKeys.has(k)))
  check(map.points.length > 100 && badKeys.length === 0, 'each map point carries only lat, lon, disease, species, status, advice kind and week', `${map.points.length} points; first ${JSON.stringify(map.points[0])}`)
  check(map.points.every((p) => p.status === 'confirmed' || p.status === 'suspected'), 'a map point status is only confirmed or suspected, never ruled out')
      check(map.points.every((p) => Math.abs(p.lat * 100 - Math.round(p.lat * 100)) < 1e-6 && Math.abs(p.lon * 100 - Math.round(p.lon * 100)) < 1e-6), 'every point is rounded to 0.01 degree (about 1 km)')
  check(map.points.every((p) => new Date(p.resolved_at + 'T00:00:00Z').getUTCDay() === 1), 'every point carries only the Monday of the week signed off, never the day')
  check(!map.points.some((p) => /Dlamini|0821/.test(p.disease)) && map.points.some((p) => p.disease === 'Other (rare)'), 'a disease label with a name and number typed into it is stripped of the number and shown as "Other (rare)"', [...new Set(map.points.map((p) => p.disease))].join(', ').slice(0, 200))
  const cellsOf = new Map()
  for (const p of map.points) { const key = Math.floor(p.lat / 0.1) + ':' + Math.floor(p.lon / 0.1); cellsOf.set(key, (cellsOf.get(key) || 0) + 1) }
  check([...cellsOf.values()].every((n) => n >= map.k), 'no dot is released from a 0.1 degree cell holding fewer than the floor of cases', `${cellsOf.size} cells, ${map.withheld} withheld`)
  const dis = JSON.parse(payloads.find(([p]) => p === '/api/reports/diseases')[1])
  const cells = dis.cells.concat(dis.by_disease, dis.by_region, dis.by_month, dis.by_disease_month, dis.by_disease_region, dis.by_species, dis.by_conclusion, dis.by_disease_conclusion)

  const under = cells.filter((x) => x.count < dis.k)
  check(cells.length > 10 && under.every((x) => x.region === 'unknown' && Object.keys(x).length === 2), `every released group has at least ${dis.k} cases (only the by-area "area not stated" line may be smaller)`, `${cells.length} groups; under the floor: ${JSON.stringify(under)}`)
  const kinds = new Set(['Vaccination', 'Quarantine or movement control', 'Culling or disposal', 'Treatment', 'Referred to a vet or lab', 'Monitoring', 'Other advice', 'Not stated'])
  check(dis.by_conclusion.length > 2 && map.points.every((p) => p.advice.every((k) => kinds.has(k))) && dis.by_conclusion.every((x) => kinds.has(x.conclusion) || x.conclusion === 'other/sparse'), 'technician advice is released only as a fixed set of kinds, never the typed words', dis.by_conclusion.map((x) => x.conclusion + ':' + x.count).join(', '))
  const areasRes = JSON.parse(await (await fetch(`http://127.0.0.1:${PORT}/api/reports/areas`, { headers: { cookie } })).text())
  check(areasRes.areas.length > 2 && areasRes.areas.every((a) => a.count >= areasRes.k && Math.abs(a.lat * 10 - Math.round(a.lat * 10)) < 1e-6 && !/\d{5,}/.test(a.region)), 'the by-area map releases only named areas with enough cases, placed to about 10 km', areasRes.areas.map((a) => a.region + ':' + a.count).join(', '))
  const heat = JSON.parse(payloads.find(([p]) => p === '/api/reports/heat')[1])
  check(heat.cells.length > 3 && heat.cells.every((x) => x.count >= heat.k), 'every heat cell holds at least the floor of cases', `${heat.cells.length} cells`)
  const csv = payloads.find(([p]) => p === '/api/reports/export.csv')[1]
  check(/^view,disease,region,period,cases\n/.test(csv) && csv.split('\n').length > 10, 'the viewer export is the released rollups only', csv.split('\n').slice(0, 3).join(' / '))
  const signed = Number((await store.listCases({}, { limit: 10000 })).filter((x) => ['resolved', 'closed'].includes(x.status) && /identified_disease/.test(x.report || '')).length)
  const closedNoDx = (await store.listCases({}, { limit: 10000 })).filter((x) => x.status === 'closed' && !/identified_disease/.test(x.report || '')).length
  check(map.count + map.withheld + map.without_location === signed && closedNoDx > 0, 'the resolved map holds exactly the signed-off cases (closed-without-diagnosis and open ones are absent)', `${map.count} + ${map.without_location} no-location = ${signed} signed off; ${closedNoDx} closed without a diagnosis left off`)

  console.log('\nviewer: performance at ' + (await store.listCases({}, { limit: 10000 })).length + ' reports')
  for (const p of ['/api/reports/resolved-map', '/api/reports/diseases', '/api/reports/heat', '/api/reports/heat?scope=all', '/api/reports/export.csv']) {
    await rawRequest(PORT, 'GET', p, cookie)
    const runs = []
    for (let i = 0; i < 5; i++) { const t = Date.now(); await rawRequest(PORT, 'GET', p, cookie); runs.push(Date.now() - t) }
    const med = runs.sort((a, b) => a - b)[2]
    check(med <= 400, `${p} answers inside its budget (median of 5 <= 400 ms)`, med + ' ms')
  }

  console.log('\nviewer: home screen (desktop)')
  await asUser('-vw', '', 6000)
  await sleep(1500)
  const v = JSON.parse(await evalJs(`(async () => JSON.stringify({
    nav: [...document.querySelectorAll('nav a, nav button, aside a, aside button')].map((e) => e.innerText.trim()).filter(Boolean),
    console: !!document.querySelector('.app-two-pane-map'), canvas: !!document.getElementById('rm-canvas'),
    dots: document.querySelectorAll('#rm-canvas path.leaflet-interactive').length, cloud: document.querySelectorAll('.rep-cloud li').length,
    kpi: document.querySelectorAll('.ds-kpi, .kpi').length, bars: document.querySelectorAll('.ds-bar-chart, .bar-chart, [class*=bar-row], [class*=barchart]').length,
    title: (document.querySelector('h1') || {}).innerText, status: (document.querySelector('[aria-label="Status bar"]') || {}).innerText,
    mapBox: (() => { const r = document.getElementById('rm-canvas').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] })(),
    tiles: document.querySelectorAll('#rm-canvas img.leaflet-tile').length,
    slider: !!document.querySelector('.ds-slider-range'), play: !![...document.querySelectorAll('button')].find((b) => /Play time-lapse/.test(b.innerText)),
    csv: (document.querySelector('a[href^="/api/reports/export.csv"]') || {}).href || '',
    scrollW: document.documentElement.scrollWidth, innerW: innerWidth, text: document.body.innerText.slice(0, 4000),
  }))()`))
  check(v.nav.length === 3 && v.nav.join('|').includes('Resolved cases map'), 'viewer nav is only Overview, Resolved cases map and Disease reports', v.nav.join(' | '))
  check(!v.console && v.canvas, 'the viewer sees its own screen, not the operator console, and it has the map')
  check(v.mapBox[1] >= 280 && v.mapBox[0] >= 300, 'the map has a real size on the page (not a collapsed box with dots inside)', v.mapBox.join(' x '))
  const alt = JSON.parse(await evalJs(`JSON.stringify({ rows: document.querySelectorAll('.rep-table-alt tbody tr').length })`))
  check(alt.rows > 0, 'the map has a table of the same figures for anyone who cannot use colour or a pointer', alt.rows + ' rows')
  check(v.dots === map.count, 'the map draws one dot per signed-off case with a place', `${v.dots} dots for ${map.count} points`)
  check(v.cloud >= 3 && v.slider && v.play && /export\.csv/.test(v.csv), 'word cloud, time slider, play button and export link are on the screen', `cloud ${v.cloud}, csv ${v.csv.replace(/^https?:\/\/[^/]+/, '')}`)
  check(!/CASE-\d|Seed Farmer|GUI Ranger|0\d{9}|Dlamini/.test(v.text), 'no reference, name or number appears anywhere on the viewer screen')
  check(v.scrollW <= v.innerW, 'no horizontal overflow at desktop width', `${v.scrollW} vs ${v.innerW}`)
  const csvRes = await evalJs(`fetch('/api/reports/export.csv').then(async (r) => r.status + ' ' + r.headers.get('content-type') + ' ' + (await r.text()).split('\\n')[0])`)
  check(/^200 text\/csv/.test(csvRes), 'the export button target downloads a CSV', csvRes)
  await shot('viewer-home-dots-desktop')
  await axeBoth('viewer home (dots)')

  console.log('\nviewer: region filter, time-lapse, heat')
  const region = 'Upper Lambasi'
  const want = JSON.parse(await evalJs(`fetch('/api/reports/resolved-map?region=' + encodeURIComponent(${JSON.stringify(region)})).then((r) => r.json()).then((j) => JSON.stringify(j.count))`))
  await evalJs(`(() => { const s = [...document.querySelectorAll('select')].find((e) => [...e.options].some((o) => o.value === ${JSON.stringify(region)})); s.value = ${JSON.stringify(region)}; s.dispatchEvent(new Event('change', { bubbles: true })); return 1 })()`)
  await sleep(1800)
  const dotsR = await evalJs(`document.querySelectorAll('#rm-canvas path.leaflet-interactive').length`)
  check(want > 0 && want < map.count && dotsR === want, 'choosing an area redraws only that area\'s dots', `${dotsR} dots, server says ${want}`)
  await evalJs(`(() => { const s = [...document.querySelectorAll('select')].find((e) => [...e.options].some((o) => o.value === '')); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return 1 })()`)
  await sleep(1800)
  const before = JSON.parse(await evalJs(`JSON.stringify({ dots: document.querySelectorAll('#rm-canvas path.leaflet-interactive').length, val: document.querySelector('.ds-slider-range').value, max: document.querySelector('.ds-slider-range').max })`))
  await clickText('Play time-lapse'); await sleep(2600)
  const during = JSON.parse(await evalJs(`JSON.stringify({ dots: document.querySelectorAll('#rm-canvas path.leaflet-interactive').length, val: document.querySelector('.ds-slider-range').value, playing: /Pause/.test(document.body.innerText), label: (document.querySelector('.ds-slider label') || {}).innerText })`))
  check(before.dots === map.count && during.dots < before.dots && Number(during.val) < Number(before.max) && during.playing, 'Play rewinds to the first week and adds dots week by week (time-lapse)', `${before.dots} dots at rest -> ${during.dots} while playing, week ${during.val} of ${before.max}; "${during.label}"`)
  await clickText('Pause'); await sleep(400)
  const frozen = await evalJs(`document.querySelector('.ds-slider-range').value`)
  await sleep(1300)
  check(frozen === (await evalJs(`document.querySelector('.ds-slider-range').value`)), 'Pause stops the time-lapse')
  await evalJs(`(() => { const r = document.querySelector('.ds-slider-range'); r.value = ${JSON.stringify(String(Math.floor(Number(before.max) / 2)))}; r.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
  await sleep(600)
  const mid = await evalJs(`document.querySelectorAll('#rm-canvas path.leaflet-interactive').length`)
  check(mid > 0 && mid < map.count, 'dragging the slider shows only cases signed off up to that week', `${mid} of ${map.count}`)
  await clickText('Heat map of signed-off cases', true); await sleep(2200)
  const heatDom = JSON.parse(await evalJs(`JSON.stringify({ cells: document.querySelectorAll('#rm-canvas path.leaflet-interactive').length, summary: (document.getElementById('rm-summary') || {}).innerText })`))
  check(heatDom.cells > 0 && /Heat map/.test(heatDom.summary || ''), 'the heat view draws grid cells and says areas under 5 are not shown', `${heatDom.cells} cells; ${heatDom.summary}`)
  await shot('viewer-home-heat-desktop')
  await axeBoth('viewer home (heat)')
  await clickText('Heat map of all reports', true); await sleep(2200)
  const allDom = await evalJs(`document.querySelectorAll('#rm-canvas path.leaflet-interactive').length`)
  check(allDom > 0, 'the all-reports heat view draws grid cells', allDom + ' cells')

  console.log('\nviewer: disease reports view')
  await clickText('Disease reports', true); await sleep(1500)
  const dr = JSON.parse(await evalJs(`JSON.stringify({ h1: (document.querySelector('h1') || {}).innerText, cloud: document.querySelectorAll('.rep-cloud li').length, table: document.querySelectorAll('table').length, hint: /Small groups combined|fewer than 5/.test(document.body.innerText), csv: !!document.querySelector('a[href^="/api/reports/export.csv"]') })`))
  check(dr.h1 === 'Disease reports' && dr.cloud >= 3 && dr.table >= 1 && dr.csv, 'Disease reports shows the cloud, the table and the export', JSON.stringify(dr))
  await shot('viewer-disease-reports-desktop')
  await axeBoth('viewer disease reports')

  console.log('\nviewer: phone 390x844')
  await viewport('p')
  await asUser('-vw', '', 6000); await sleep(1500)
  const ph = JSON.parse(await evalJs(`JSON.stringify({ scrollW: document.documentElement.scrollWidth, innerW: innerWidth, dots: document.querySelectorAll('#rm-canvas path.leaflet-interactive').length,
    small: [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('.leaflet-container') && !e.classList.contains('app-status-toggle') && (r.height < 43.5 || r.width < 43.5) }).map((e) => e.tagName + '.' + String(e.className).split(' ')[0] + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height) + ' "' + String(e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 30) + '"') })`))
  check(ph.scrollW <= ph.innerW, 'phone: no horizontal overflow on the viewer home', `${ph.scrollW} vs ${ph.innerW}`)
  check(ph.dots === map.count, 'phone: the map still shows every dot', String(ph.dots))
  check(ph.small.length === 0, 'phone: every control is at least 44px', ph.small.slice(0, 4).join(' ; '))
  await shot('viewer-home-phone')
  await axeBoth('viewer home (phone)')
  await viewport('d')

  console.log('\nstaff: the same panels in the Overview section')
  for (const [hash, label] of [['#panel=resolved_map', 'Resolved cases map'], ['#panel=disease_reports', 'Disease reports']]) {
    await asUser('', hash, 5500); await sleep(1200)
    const s = JSON.parse(await evalJs(`JSON.stringify({ h1: (document.querySelector('h1') || {}).innerText, dots: document.querySelectorAll('#rm-canvas path.leaflet-interactive').length, cloud: document.querySelectorAll('.rep-cloud li').length, nav: [...document.querySelectorAll('nav a, aside a')].map((e) => e.innerText.trim()) })`))
    check(/Resolved map|Disease reports/.test(s.h1 || '') && (label.startsWith('Resolved') ? s.dots === map.count : s.cloud >= 3), `staff: ${label} opens as a panel`, JSON.stringify({ h1: s.h1, dots: s.dots, cloud: s.cloud }))
    check(s.nav.includes('Resolved map') && s.nav.includes('Disease reports'), 'staff: both are in the Reports & Admin nav group')
    await shot('staff-' + hash.slice(7))
    await axeBoth('staff ' + label)
  }
  archive()
  const consoleBad = seenConsole.slice(seen0.c).filter((m) => !/status of 404/.test(m) && !/<\/(api\/)?tiles?\//.test(m) && !/<\/api\/ready>/.test(m) && !/status of 403/.test(m))
  check(consoleBad.length === 0, 'viewer + staff report screens: browser console clean', consoleBad[0] || 'no errors or warnings')
  const failed403 = seenFailed.slice(seen0.f).filter((r) => /^403 /.test(r) && !/\/api\/(cases|contacts|accounts)/.test(r))
  check(failed403.length === 0, 'the viewer screen itself never asks for anything it is refused', failed403[0] || 'none refused')
}
