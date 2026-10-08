

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')

export async function runVocabChecks(c) {
  const { check, evalJs, viewport, axeBoth, sleep, send, navigate, PORT, PW, ids: _ids } = c
  const PORT2 = PORT + 20
  const base2 = `http://127.0.0.1:${PORT2}`
  const work = mkdtempSync(path.join(os.tmpdir(), 'casey-gui-vocab-'))
  const cfg = path.join(work, 'config')
  const store = path.join(work, 'store')
  mkdirSync(store, { recursive: true })
  const callsFile = path.join(work, 'llm-calls.jsonl')
  writeFileSync(callsFile, '')
  const calls = () => readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

  const UHH = process.env.CASEY_CONFIG_DIR || path.join(ROOT, '..', '..', 'config')
  cpSync(UHH, cfg, { recursive: true })
  let vocab = readFileSync(path.join(cfg, 'vocabulary.yml'), 'utf8')
  vocab = vocab.replace(/^  waiting: "Waiting"/m, '  waiting: "On hold"').replace(/^ {2}other_diseases: .*\n/m, '')
  writeFileSync(path.join(cfg, 'vocabulary.yml'), vocab)
  let rf = readFileSync(path.join(cfg, 'report-fields.yml'), 'utf8')
  rf = rf.replace(/hidden_fields:\n(?: {4}.*\n)+/, `hidden_fields:
    all: []
    staff: [identifying_traits, herd_total, species]
    eco_ranger: [identifying_traits]
    animal_health_technician: [present_person, present_person_relation, owner_name, owner_contact, species]
`)
  writeFileSync(path.join(cfg, 'report-fields.yml'), rf)
  check(/staff: \[identifying_traits, herd_total, species\]/.test(rf) && /waiting: "On hold"/.test(vocab) && !/other_diseases/.test(vocab), 'setup: the test config hides fields per screen and edits one word and drops one key')

  const child = spawn(process.execPath, [path.join(HERE, 'gui-check-vocab-server.mjs'), String(PORT2), store, cfg, callsFile], { env: { ...process.env, GUI_PW: PW, CASEY_PUBLIC_URL: base2 }, stdio: ['ignore', 'pipe', 'pipe'] })
  let seedLine = '', childErr = ''
  child.stdout.on('data', (d) => { seedLine += d })
  child.stderr.on('data', (d) => { childErr += d })
  let seed = null
  for (let i = 0; i < 120 && !seed; i++) {
    await sleep(500)
    const m = /SEED (\{.*\})/.exec(seedLine)
    if (m) seed = JSON.parse(m[1])
    if (child.exitCode != null) break
  }
  check(!!seed, 'setup: the second dashboard (own store, own config) booted and seeded', seed ? 'ok' : childErr.slice(-300))
  if (!seed) { try { child.kill() } catch {  } return }

  try {

    const cookies = {}
    const apiAs = async (user, method, p, body, headers = {}) => {
      if (user && !cookies[user]) {
        const r = await fetch(base2 + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password: PW }) })
        cookies[user] = (r.headers.get('set-cookie') || '').split(';')[0]
      }
      const r = await fetch(base2 + p, { method, headers: { ...(user ? { cookie: cookies[user] } : {}), 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
      return { s: r.status, j: await r.json().catch(() => null), h: r.headers }
    }
    const login = async (user, hash = '', wait = 3500) => {
      await navigate(base2 + '/#x'); await sleep(700)
      await evalJs(`(async () => {
        localStorage.casey_onboarded = '1'; localStorage.casey_help_seen = '1';
        localStorage.setItem('casey_skills_' + ${JSON.stringify(user)}, JSON.stringify({ __dismissed: true }));
        for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
        for (const k of await caches.keys()) await caches.delete(k);
        await fetch('/api/logout', { method: 'POST' });
        return (await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ${JSON.stringify(user)}, password: ${JSON.stringify(PW)} }) })).status })()`)
      await navigate('about:blank')
      await navigate(base2 + '/' + hash)
      await sleep(wait)
    }
    const KEYS = { End: 35, Home: 36, ArrowUp: 38, ArrowDown: 40, Enter: 13, Tab: 9 }
    const pressKey = async (k) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: KEYS[k] }) }
    const body = () => evalJs('document.body.innerText')
    const click = (sel) => evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.focus(); e.click(); return true })()`)
    const clickBtn = (txt) => evalJs(`(() => { const e = [...document.querySelectorAll('button, [role=button]')].find((e) => e.offsetParent !== null && (e.innerText || e.getAttribute('aria-label') || '').trim().startsWith(${JSON.stringify(txt)})); if (!e) return false; e.focus(); e.click(); return true })()`)
    const setInput = (sel, v) => evalJs(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); if (!i) return false; const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set; set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
    const report = async (id) => JSON.parse((await apiAs('vadm', 'GET', '/api/cases/' + id)).j.case.report || '{}')
    const t1 = seed.t1

    console.log('\nvocabulary: one file, served with the shell, applied on screen')
    const html = await (await fetch(base2 + '/')).text()
    const m = /<script type="application\/json" id="casey-vocab">([\s\S]*?)<\/script>/.exec(html)
    const words = m ? JSON.parse(m[1]) : {}
    check(Object.keys(words).length >= 60, 'the served shell carries the vocabulary (no login needed)', String(Object.keys(words).length) + ' words')
    check(words['ui.offline_title'] === 'Offline -- no network', 'the offline bar says "network", the community\'s word', words['ui.offline_title'])
    const signalWords = Object.entries(words).filter(([k, v]) => k.startsWith('ui.') && /\bsignal\b/i.test(String(v)))
    check(signalWords.length === 0, 'no dashboard word says "signal" any more', signalWords.map((x) => x[0]).join(','))
    check(words['stages.waiting'] === 'On hold', 'an edit to vocabulary.yml reaches the served words', words['stages.waiting'])
    check(words['legend.other_diseases'] === 'Other diseases', 'a key removed from vocabulary.yml falls back to the built-in default, not blank', words['legend.other_diseases'])
    check(!/</.test(m ? m[1] : '<'), 'the words are escaped so none can close the script tag')

    await viewport('d')
    await login('vadm', '#home=cases&case=' + t1.id, 4500)
    const dom = JSON.parse(await evalJs(`(async () => {
      const st = await import('/src/state.js'); const fm = await import('/src/format.js'); const gl = await import('/src/glossary.js'); const mm = await import('/src/map-model.js'); const w = await import('/src/words.js');
      return JSON.stringify({ waiting: fm.stageLabel('waiting'), working: fm.stageLabel('in_progress'), gl: Object.keys(gl.glossary()).length, hand: gl.glossaryLookup('handoff'), queue: mm.queueName(), urg: mm.URGENCY_BAND_LABEL[3], other: w.word('legend.other_diseases'), unknown: w.word('ui.no_such_key') });
    })()`))
    check(dom.waiting === 'On hold' && dom.working === 'Working on it', 'stage names on screen come from the vocabulary (edited: On hold; unedited: Working on it)', JSON.stringify([dom.waiting, dom.working]))
    check(dom.gl === 22 && /Herd Health/.test(dom.hand) && !/\{brand\}|\{entity\}/.test(dom.hand), 'the glossary is read from the vocabulary with the product name and record word filled in', dom.hand.slice(0, 70))
    check(dom.queue === 'Needs a person' && dom.urg === 'needs a person now' && dom.other === 'Other diseases', 'legend words come from the vocabulary', JSON.stringify([dom.queue, dom.urg, dom.other]))
    check(dom.unknown === 'no such key', 'an unknown key shows as its own last part, visibly, not blank', dom.unknown)
    await evalJs(`(async () => { const st = await import('/src/state.js'); st.state.connLost = true; st.schedule(); return 1 })()`); await sleep(700)
    const off = await body()
    check(/Offline -- no network/.test(off) && !/no signal/i.test(off), 'the offline bar on screen says "no network"', (off.match(/Offline[^\n]*/) || [''])[0])
    await evalJs(`(async () => { const st = await import('/src/state.js'); st.state.connLost = false; st.schedule(); return 1 })()`); await sleep(400)

    const doc = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'casey.js'), 'doctor', '--no-network'], { cwd: store, env: { ...process.env, CASEY_CONFIG_DIR: cfg, CASEY_DOCTOR_OFFLINE: '1' }, encoding: 'utf8', timeout: 90000 })
    const dt = (doc.stdout || '') + (doc.stderr || '')
    check(/Vocabulary/.test(dt) && /1 word\(s\) missing from vocabulary\.yml[^\n]*legend\.other_diseases/.test(dt), '`casey doctor` has a Vocabulary row listing the missing key', (dt.match(/[^\n]*missing from vocabulary[^\n]*/) || ['no row: ' + dt.slice(-200)])[0].slice(0, 150))
    check(/dashboard_ui\.hidden_fields\.staff: "species" is part of the mandatory/.test(dt), '`casey doctor` says a field the system stands on cannot be hidden', (dt.match(/[^\n]*hidden_fields[^\n]*species[^\n]*/) || [''])[0].slice(0, 150))

    console.log('\nspecies: a dropdown ending in "Other (write it)", free text still possible')
    const staffCfg = (await apiAs('vadm', 'GET', '/api/config')).j
    check(JSON.stringify(staffCfg.field_options && staffCfg.field_options.species) === JSON.stringify(['goats', 'sheep', 'cattle', 'pigs', 'chickens', 'horses', 'donkeys', 'dogs']), 'the species list is served from report-fields.yml options', JSON.stringify(staffCfg.field_options))

    check(!staffCfg.hidden_fields.includes('species') && staffCfg.hidden_fields.includes('identifying_traits'), 'a mandatory field named in hidden_fields is ignored; the others are honoured', JSON.stringify(staffCfg.hidden_fields))
    const before = calls().length
    const sp = '[data-field=species] .casey-rep-editable'
    check(await click(sp), 'the species value opens for editing')
    await sleep(700)
    const opts = JSON.parse(await evalJs(`(() => { const s = document.querySelector('select[name=rf-species]'); return JSON.stringify(s ? { opts: [...s.options].map((o) => o.text), sel: s.options[s.selectedIndex].text, focus: document.activeElement === s } : null) })()`))
    check(!!opts && JSON.stringify(opts.opts) === JSON.stringify(['Choose one', 'Goats', 'Sheep', 'Cattle', 'Pigs', 'Chickens', 'Horses', 'Donkeys', 'Dogs', 'Other (write it)']), 'the editor is a dropdown: a prompt, the eight animals, then "Other (write it)"', opts && opts.opts.join(' | '))
    check(opts && opts.sel === 'Cattle' && opts.focus, 'it opens on the current animal with the keyboard focus already on it', JSON.stringify([opts && opts.sel, opts && opts.focus]))
    await axeBoth('species dropdown open in the report editor')
    await evalJs(`document.querySelector('select[name=rf-species]').focus()`)
    await pressKey('End'); await sleep(500)
    const other = JSON.parse(await evalJs(`(() => { const s = document.querySelector('select[name=rf-species]'); const o = document.querySelector('input[name=rf-species-other]'); return JSON.stringify({ sel: s.options[s.selectedIndex].text, box: !!o, label: o ? (o.labels && o.labels[0] ? o.labels[0].innerText : '') : '' }) })()`))
    check(other.sel === 'Other (write it)' && other.box && /Write it here/.test(other.label), 'End on the dropdown (keyboard only) chooses "Other (write it)" and opens a labelled box', JSON.stringify(other))
    await axeBoth('species Other box open')
    await setInput('input[name=rf-species-other]', 'ostrich')
    await clickBtn('Save'); await sleep(1800)
    check((await report(t1.id)).species === 'ostrich', 'an animal not on the list ("ostrich") is saved exactly as written', String((await report(t1.id)).species))
    check(calls().length === before, 'choosing from the list or writing an Other animal makes no model call', String(calls().length - before))
    await click(sp); await sleep(700)
    const reopen = JSON.parse(await evalJs(`(() => { const s = document.querySelector('select[name=rf-species]'); const o = document.querySelector('input[name=rf-species-other]'); return JSON.stringify({ sel: s.options[s.selectedIndex].text, val: o ? o.value : null }) })()`))
    check(reopen.sel === 'Other (write it)' && reopen.val === 'ostrich', 'reopening a value that is not on the list shows it under Other, nothing lost or re-mapped', JSON.stringify(reopen))
    await evalJs(`document.querySelector('select[name=rf-species]').focus()`)
    await pressKey('ArrowUp'); await sleep(500)
    const up = await evalJs(`(() => { const s = document.querySelector('select[name=rf-species]'); return s.options[s.selectedIndex].text + '|' + !!document.querySelector('input[name=rf-species-other]') })()`)
    check(up === 'Dogs|false', 'ArrowUp moves to "Dogs" and the write-it box goes away', up)
    await clickBtn('Save'); await sleep(1800)
    check((await report(t1.id)).species === 'dogs', 'a listed animal is stored as its list spelling', String((await report(t1.id)).species))

    const desc = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(path.join(ROOT, 'src/store/report-shape.js'))}); console.log(m.REPORT_FIELD_DEFS.find(f => f.key === 'species').description)`], { env: { ...process.env, CASEY_CONFIG_DIR: cfg }, encoding: 'utf8' }).stdout
    check(/Usual answers: goats, sheep, cattle/.test(desc) && /ostrich/.test(desc) && /never force it into this list/.test(desc), 'the bot is told the list and that any other animal is recorded as the person said it', desc.slice(-160).trim())

    const form = await (await fetch(base2 + '/report?ref=' + encodeURIComponent(t1.ref))).text()
    check(/<select id="f-species"/.test(form) && /Other \(write it\)/.test(form) && /name="species__other"/.test(form) && ['Goats', 'Sheep', 'Cattle', 'Pigs', 'Chickens', 'Horses', 'Donkeys', 'Dogs'].every((a) => form.includes('>' + a + '<')), 'the public form offers the animals as a dropdown with a write-it box (works with no script)')
    const post = (fields) => fetch(base2 + '/report', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ref: t1.ref, ...fields }).toString() })
    const p1 = await post({ species: '__other__', species__other: 'camel' })
    check(p1.status === 303 || p1.status === 302, 'the public form accepts "Other" with words', String(p1.status))
    check((await report(t1.id)).species === 'camel', 'the public form stores the written animal', String((await report(t1.id)).species))
    await post({ species: 'goats', species__other: 'leftover text' })
    check((await report(t1.id)).species === 'goats', 'a listed choice wins over stale text in the write-it box', String((await report(t1.id)).species))
    await post({ species: 'horses' })
    await navigate(base2 + '/report?ref=' + encodeURIComponent(t1.ref)); await sleep(1200)
    await axeBoth('the public form with the species dropdown')

    await viewport('p')
    await login('vrng', '#case=' + t1.id, 4000)
    const rf1 = JSON.parse(await evalJs(`(() => { const s = document.querySelector('select[name=fld-species]'); return JSON.stringify(s ? [...s.options].map((o) => o.text) : null) })()`))
    check(!!rf1 && rf1[rf1.length - 1] === 'Other (write it)' && rf1.length === 10, 'the ranger\'s record form also offers the animals as a dropdown ending in Other', rf1 && rf1.length + ' options')
    await evalJs(`(() => { const s = document.querySelector('select[name=fld-species]'); s.value = '__other__'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1 })()`); await sleep(600)
    await setInput('input[name=fld-species-other]', 'guinea fowl'); await sleep(300)
    await clickBtn('Save to'); await sleep(800)
    await evalJs(`(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find((x) => /Yes, this is/.test(x.innerText)); if (b) b.click(); return 1 })()`); await sleep(2200)
    check((await report(t1.id)).species === 'guinea fowl', 'a ranger can record an Other animal from the phone form', String((await report(t1.id)).species))
    await axeBoth('ranger record form with the species dropdown')

    console.log('\nhidden fields: honoured on the screen and on paper, data untouched')
    const cfgFor = async (u) => (await apiAs(u, 'GET', '/api/config')).j.hidden_fields
    check(JSON.stringify(await cfgFor('vrng')) === JSON.stringify(['identifying_traits']), 'a ranger\'s screen hides identifying_traits only', JSON.stringify(await cfgFor('vrng')))
    const ahtHidden = await cfgFor('vaht')
    check(!ahtHidden.includes('species') && ['present_person', 'owner_name', 'owner_contact', 'present_person_relation'].every((k) => ahtHidden.includes(k)), 'a technician\'s screen hides the "people on site" fields; species (mandatory) is refused', JSON.stringify(ahtHidden))
    await viewport('d')
    await login('vadm', '#home=cases&case=' + t1.id, 4500)
    const rows = JSON.parse(await evalJs(`JSON.stringify({ idt: !!document.querySelector('[data-field=identifying_traits]'), herd: !!document.querySelector('[data-field=herd_total]'), sp: !!document.querySelector('[data-field=species]'), pp: !!document.querySelector('[data-field=present_person]'), total: document.querySelectorAll('[data-field]').length })`))
    check(!rows.idt && !rows.herd && rows.sp && rows.pp, 'staff screen: identifying_traits and herd_total are gone; species (mandatory) and present_person stay', JSON.stringify(rows))
    check(!/Identifying the animals|Herd\/flock total/.test(await body()), 'staff screen: the hidden fields\' labels appear nowhere on the page')
    const stored = await report(t1.id)
    check(stored.identifying_traits === 'brown cow, ear tag 12' && stored.herd_total === '40', 'hiding deletes nothing: the values are still stored and served', JSON.stringify([stored.identifying_traits, stored.herd_total]))
    await send('Emulation.setEmulatedMedia', { media: 'print' }); await sleep(500)
    const pr = JSON.parse(await evalJs(`JSON.stringify({ text: document.body.innerText, rows: document.querySelectorAll('[data-field]').length, lines: [...document.querySelectorAll('.ds-fill-lines')].filter((e) => getComputedStyle(e).display !== 'none').length, sp: !!document.querySelector('[data-field=species]') })`))
    await send('Emulation.setEmulatedMedia', { media: '' }); await sleep(300)
    check(!/Identifying the animals|Herd\/flock total/.test(pr.text) && pr.sp && pr.rows === rows.total, 'printed page: hidden fields are absent, every other row is still there', JSON.stringify({ rows: pr.rows, of: rows.total }))
    check(pr.lines > 0, 'printed page: empty visible fields still print their writing lines (the form is not broken)', String(pr.lines) + ' ruled areas')
    const brief = await (await fetch(base2 + '/api/cases/' + t1.id + '/report.html', { headers: { cookie: cookies.vadm } })).text()
    check(!/Identifying the animals|Herd\/flock total/.test(brief) && />Animals</.test(brief) && />Signs</.test(brief), 'the printable field briefing drops the hidden rows and keeps the rest', 'hidden absent, Animals+Signs present')
    await login('vrng', '#case=' + t1.id, 4000)
    const rt = await body()
    check(!/Identifying the animals/.test(rt) && /Herd\/flock total/.test(rt), 'ranger screen: identifying_traits hidden, herd_total (hidden only for staff) still shown', 'role-specific')
    await login('vaht', '#case=' + seed.t5.id, 4000)
    const at = await body()
    check(!/Who is with the animals|Their link to the owner|Owner name|Owner contact/.test(at) && /Identifying the animals/.test(at) && /Animals/.test(at), 'technician screen: people-on-site fields hidden, identifying_traits (not hidden for them) and Animals shown', 'role-specific')
    await axeBoth('technician report with fields hidden')

    console.log('\nShow in English: one message, on request, paid once')
    await viewport('d')
    await login('vadm', '#home=cases&case=' + t1.id, 4500)
    const ui0 = JSON.parse(await evalJs(`JSON.stringify({ btns: [...document.querySelectorAll('.casey-translate-btn')].map((b) => b.innerText.trim()), rows: document.querySelectorAll('.ds-log-row[data-kind=inbound]').length, outBtn: !!document.querySelector('.ds-log-row[data-kind=outbound] .casey-translate-btn'), noteBtn: !!document.querySelector('.ds-log-row[data-kind=note] .casey-translate-btn'), chip: /Written in isiXhosa/.test(document.querySelector('.casey-timeline-head') ? document.querySelector('.casey-timeline-head').textContent : '') })`))
    check(ui0.btns.length === 2 && ui0.btns.every((t) => t === 'Show in English') && ui0.rows === 2, 'staff see "Show in English" on each message the reporter sent', JSON.stringify(ui0.btns))
    check(!ui0.outBtn && !ui0.noteBtn, 'no button on the assistant\'s replies or on notes', JSON.stringify([ui0.outBtn, ui0.noteBtn]))
    check(ui0.chip, 'the timeline heading carries the language the assistant recorded ("Written in isiXhosa")')

    const rangerFirst = await apiAs('vrng', 'POST', `/api/cases/${seed.t2.id}/events/${seed.t2.inbound}/translate`, { expected_ref: seed.t2.ref })
    check(rangerFirst.s === 200 && rangerFirst.j.cached === false && /^\[stub\]/.test(rangerFirst.j.english) && rangerFirst.j.language === 'isiZulu' && rangerFirst.j.label === 'machine translation (may be wrong)', 'a ranger translates a message on a report assigned to them (a STOP contact is still fine)', JSON.stringify(rangerFirst.j))
    const n0 = calls().length
    await clickBtn('Show in English'); await sleep(2200)
    const ui1 = JSON.parse(await evalJs(`JSON.stringify({ note: [...document.querySelectorAll('[data-translation-of]')].map((e) => e.textContent.replace(/\\s+/g, ' ')), text: document.body.innerText, remaining: document.querySelectorAll('.casey-translate-btn').length })`))
    check(ui1.note.length === 1 && /machine translation \(may be wrong\)/.test(ui1.note[0]) && /isiXhosa > English/.test(ui1.note[0]) && /\[stub\] Iinkomo zam/.test(ui1.note[0]), 'pressing it shows the English under the message, labelled as a machine translation', ui1.note[0])
    check(/Iinkomo zam ziyakhohlela kakhulu kwaye azityi\./.test(ui1.text), 'the original message stays on screen beside its translation')
    check(!/translation:/.test(ui1.text) && ui1.remaining === 1, 'the stored translation is not a row of its own on the timeline, and that message\'s button is gone', 'remaining buttons: ' + ui1.remaining)
    const made = calls().slice(n0)
    check(made.length === 1, 'exactly one model call was made for the click', String(made.length))
    const sent = JSON.stringify(made[0].messages)
    check(/deepseek[^,]*flash/i.test(made[0].model), 'the call names DeepSeek Flash and nothing else', String(made[0].model))
    check(sent.includes('Iinkomo zam ziyakhohlela') && !sent.includes(t1.ref) && !sent.includes('27800200001') && !sent.includes('Farmer Zola') && !sent.includes('Musina') && !sent.includes('Sipho'), 'only that message went out: no reference, number, name, place or other field', 'message text only')
    await axeBoth('timeline with a translation shown')

    await login('vadm', '#home=cases&case=' + t1.id, 4500)
    const ui2 = JSON.parse(await evalJs(`JSON.stringify({ notes: document.querySelectorAll('[data-translation-of]').length, btns: document.querySelectorAll('.casey-translate-btn').length })`))
    check(ui2.notes === 1 && ui2.btns === 1 && calls().length === n0 + 1, 'after a reload the paid translation is shown at once; no second call', JSON.stringify(ui2))
    const again = await apiAs('vadm', 'POST', `/api/cases/${t1.id}/events/${t1.inbound}/translate`, { expected_ref: t1.ref })
    check(again.s === 200 && again.j.cached === true && /^\[stub\] Iinkomo zam/.test(again.j.english) && calls().length === n0 + 1, 'asking again reads the stored translation (cached: true) and calls nothing', JSON.stringify([again.s, again.j && again.j.cached]))
    const evs = (await apiAs('vadm', 'GET', `/api/cases/${t1.id}/events`)).j.events
    const cacheRow = evs.find((e) => e.text === 'translation:' + t1.inbound)
    check(!!cacheRow && cacheRow.kind === 'observation' && cacheRow.actor === 'system', 'the translation is cached on the case as a system observation translation:<eventId>', cacheRow && `${cacheRow.kind}/${cacheRow.actor}`)
    const asAdmin2 = await apiAs('vadm', 'POST', `/api/cases/${seed.t2.id}/events/${seed.t2.inbound}/translate`, { expected_ref: seed.t2.ref })
    check(asAdmin2.s === 200 && asAdmin2.j.cached === true && calls().length === n0 + 1, 'what a ranger paid for, staff read for free', JSON.stringify(asAdmin2.j))

    const call0 = calls().length
    const T = (u, caseId, eventId, b = {}) => apiAs(u, 'POST', `/api/cases/${caseId}/events/${eventId}/translate`, b)
    const r = {
      out: await T('vadm', t1.id, t1.outbound), note: await T('vadm', t1.id, t1.note), none: await T('vadm', t1.id, 'no-such-event'),
      cross: await T('vadm', t1.id, seed.t3.inbound), long: await T('vadm', t1.id, t1.long), badRef: await T('vadm', seed.t3.id, seed.t3.inbound, { expected_ref: 'CASE-WRONG' }),
      viewer: await T('vvw', t1.id, t1.inbound), anon: await T(null, t1.id, t1.inbound), otherRanger: await T('vrng', seed.t3.id, seed.t3.inbound),
      sameRanger: await T('vrng2', seed.t3.id, seed.t3.inbound, { expected_ref: seed.t3.ref }), readOnlyTech: await T('vaht', seed.t6.id, seed.t6.inbound),
      tech: await T('vaht', seed.t5.id, seed.t5.inbound),
    }
    check(r.out.s === 400 && r.out.j.code === 'not_a_contact_message' && r.note.s === 400, 'the assistant\'s replies and staff notes are refused (400)', JSON.stringify([r.out.s, r.note.s]))
    check(r.none.s === 404 && r.cross.s === 404, 'an unknown message, or one that belongs to another report, is a 404', JSON.stringify([r.none.s, r.cross.s]))
    check(r.long.s === 413 && r.long.j.code === 'too_long', 'a message over 2000 characters is refused (413)', String(r.long.s))
    check(r.badRef.s === 409 && r.badRef.j.code === 'wrong_case', 'a stale tab naming another report is refused (409 expected_ref)', JSON.stringify([r.badRef.s, r.badRef.j && r.badRef.j.code]))
    check(r.viewer.s === 403 && r.anon.s === 401, 'a viewer is refused (403) and a signed-out caller is refused (401)', JSON.stringify([r.viewer.s, r.anon.s]))
    check(r.otherRanger.s === 404, 'a ranger cannot translate on a report assigned to someone else (404)', String(r.otherRanger.s))
    check(r.sameRanger.s === 200 && r.tech.s === 200, 'the holder of a report can translate (a ranger, and a technician on theirs)', JSON.stringify([r.sameRanger.s, r.tech.s]))
    check(r.readOnlyTech.s === 403 && r.readOnlyTech.j.code === 'not_assigned', 'a technician who can only LOOK at a sign-off desk report cannot translate on it (403)', JSON.stringify([r.readOnlyTech.s, r.readOnlyTech.j && r.readOnlyTech.j.code]))
    check(calls().length === call0 + 2, 'every refusal happened before any model call (only the two allowed fresh translations were sent)', String(calls().length - call0))

    const codes = []
    let retry = null
    for (const ev of seed.t4.inbound) { const x = await T('vadm', seed.t4.id, ev); codes.push(x.s); if (x.s === 429 && !retry) retry = x.h.get('retry-after') }
    check(codes.includes(429) && codes.filter((s) => s === 200).length <= 10 && Number(retry) > 0, 'one login is limited to 10 fresh translations a minute (429 with Retry-After)', codes.join(',') + ' retry-after=' + retry)

    const tr = await import(path.join(ROOT, 'src/dashboard/routes/translate.js'))
    check(tr.translateModel({ CASEY_LLM_MODEL: 'openrouter/anthropic/claude-sonnet-4' }) === null && tr.translateModel({ CASEY_LLM_MODEL: 'x/y,openrouter/deepseek/deepseek-v4.1-flash' }) === 'openrouter/deepseek/deepseek-v4.1-flash' && tr.translateModel({ CASEY_TRANSLATE_MODEL: 'openrouter/qwen/qwen3', CASEY_LLM_MODEL: 'openrouter/deepseek/deepseek-v4.1-flash' }) === null, 'only a DeepSeek Flash model is ever used; anything else is refused, not swapped in')
    const bridge = await import(path.join(ROOT, 'src/agent/acptoapi-bridge.js'))
    const acp = await import('acptoapi'); const acptoapi = acp.default && typeof acp.default === 'object' ? acp.default : acp
    const links = await bridge.resolveChainLinks(acptoapi, made[0].model)
    check(links.length === 1 && links[0].provider && links[0].provider.data_collection === 'deny', 'the request path (resolveChainLinks) puts provider.data_collection = deny on that model', JSON.stringify(links))

    await login('vaht', '#case=' + seed.t6.id, 4000)
    check(await evalJs(`document.querySelectorAll('.casey-translate-btn').length`) === 0 && /You can look at this one, not change it/.test(await body()), 'a read-only view (technician looking at the sign-off desk) shows no Show in English button')
    await login('vrng', '#case=' + t1.id, 4000)
    check(await evalJs(`document.querySelectorAll('.casey-translate-btn, [data-translation-of]').length`) >= 1, 'a ranger sees the button (or the stored translation) on a report assigned to them')
    await viewport('p')
    await login('vrng', '#case=' + t1.id, 4000)
    const small = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('.casey-translate-btn')].map((b) => Math.round(b.getBoundingClientRect().height)))`))
    check(small.length >= 1 && small.every((h) => h >= 43.5), 'phone: the button is at least 44px tall', JSON.stringify(small))
    await axeBoth('ranger phone report with a translation')
    check(!/(^|\n)(TypeError|ReferenceError)/.test(childErr), 'the second dashboard raised no server error', childErr.slice(-200))
  } finally {
    try { child.kill() } catch {  }
    try { rmSync(work, { recursive: true, force: true }) } catch {  }
  }
}
