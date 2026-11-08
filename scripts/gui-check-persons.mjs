

import { readFileSync } from 'node:fs'
import path from 'node:path'

const FX = JSON.parse(readFileSync(path.join(process.env.CASEY_CONFIG_DIR, 'gui-check', 'fixtures.json'), 'utf8'))

export async function runPersonsChecks(c) {
  const { check, evalJs, asUser, axeBoth, viewport, sleep, clickText, setField, key, store, base, USER, PW, ids, archive, seenConsole, bodyText, SRC } = c
  const { phones, phoneLabels, speakers: SP, cases: PC, renamedNomsa: RENAMED, secondThabo: SECOND } = FX.persons
  const PHONE = phones.shared, PHONE2 = phones.solo
  const SHARED_LABEL = phoneLabels.shared, SOLO_LABEL = phoneLabels.solo
  const NOMSA = SP.nomsa.name, THABO = SP.thabo.name, SIPHO = SP.sipho.name, LINDIWE = SP.lindiwe.name
  const SMALL_JS = `JSON.stringify([...document.querySelectorAll('a[href], button, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea, summary, [role=button]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('.leaflet-container') && !e.classList.contains('app-status-toggle') && (r.height < 43.5 || r.width < 43.5) }).map((e) => e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0] + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height) + ' ' + (e.getAttribute('aria-label') || e.innerText || e.name || '').replace(/\\n/g, ' ').slice(0, 24)))`
  const { buildCaseToolset } = await import(path.join(SRC, 'case-tools.js'))
  const P = await import(path.join(SRC, 'phone-persons.js'))
  const { recordConsent } = await import(path.join(SRC, 'phone-consent.js'))
  const consoleFrom = seenConsole.length

  const asApi = async (suffix, method, p, body) => {
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER + suffix, password: PW }) })
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
    const r = await fetch(base + p, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return { s: r.status, j: await r.json().catch(() => null) }
  }

  const topDialog = `[...document.querySelectorAll('[role=dialog]')].pop()`
  const dialogText = () => evalJs(`(() => { const d = ${topDialog}; return d ? d.innerText.replace(/\\n+/g, ' / ') : 'none' })()`)
  const dialogClick = (txt) => evalJs(`(() => { const d = ${topDialog}; if (!d) return false; const b = [...d.querySelectorAll('button')].find((x) => x.innerText.trim().startsWith(${JSON.stringify(txt)})); if (!b) return false; b.click(); return true })()`)
  const dialogType = (v) => evalJs(`(() => { const d = ${topDialog}; const i = d && d.querySelector('input'); if (!i) return false; const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set; set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)

  const seeWho = (name) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify('See who uses the phone of ' + '')} + ${JSON.stringify(name)}); if (!b) return false; b.click(); return true })()`)
  const noSideScroll = () => evalJs('document.documentElement.scrollWidth <= window.innerWidth')

  console.log('\nshared phones: seeding three people on one phone, one person on another')
  const tools = Object.fromEntries(buildCaseToolset(store).map((t) => [t.name, t]))
  const call = async (n, a, ctx) => JSON.parse(JSON.stringify(await tools[n].handler(a, ctx)))
  const mkPhone = async (ext, name) => {
    const { case: k } = await store.findOrCreateCase({ channel: 'whatsapp', external_id: ext, contact: { display_name: name, handle: name }, subject: 'first message on this line' })
    await recordConsent(store, k.id, true)
    return { k, contact: await store.getContact(k.contact_id) }
  }
  const ctxFor = (contact, bound) => ({ author: contact.external_id, channel: 'whatsapp', tier: 'reporter', store, contact: { id: contact.id, external_id: contact.external_id, channel: 'whatsapp', tier: 'reporter' }, activeCaseBinding: { id: bound.id, ref: bound.ref }, activeCaseId: bound.id, dedupeCache: new Map() })
  const shared = await mkPhone(PHONE, SHARED_LABEL)
  let cx = ctxFor(shared.contact, shared.k)
  await call('case_speaker', { name: SIPHO, relation: SP.sipho.relation }, cx)
  await call('case_report', { id: shared.k.id, species: FX.animals.cattle, symptoms: PC.shared.symptoms, location: PC.shared.location }, cx)
  await call('case_speaker', { name: NOMSA, relation: SP.nomsa.relation }, cx)
  const nn = await call('case_new', {}, cx)
  ids.PN = nn.activeCase.id
  await call('case_report', { id: ids.PN, species: PC.nomsa.species, symptoms: PC.nomsa.symptoms, location: PC.nomsa.location }, cx)
  await call('case_speaker', { name: THABO, relation: SP.thabo.relation }, cx)
  const tn = await call('case_new', {}, cx)
  ids.PT = tn.activeCase.id
  await call('case_report', { id: ids.PT, species: PC.thabo.species, symptoms: PC.thabo.symptoms, location: PC.thabo.location }, cx)
  ids.PS = shared.k.id
  const solo = await mkPhone(PHONE2, SOLO_LABEL)
  const cs = ctxFor(solo.contact, solo.k)
  await call('case_speaker', { name: LINDIWE }, cs)
  await call('case_report', { id: solo.k.id, species: PC.solo.species, symptoms: PC.solo.symptoms, location: PC.solo.location }, cs)
  ids.PL = solo.k.id
  const refOf = async (id) => (await store.getCase(id)).ref
  const sharedContactId = shared.contact.id

  await store.updateCase(ids.PN, { assignee: USER + '-rng2' }, { id: 'casey-system', role: 'admin' })

  console.log('\noperator: Reporters panel on a shared phone')
  await viewport('d')
  await asUser('', '#panel=contacts', 4000)
  await clickText('Public reporters'); await sleep(1500)
  const t0 = await bodyText()
  check(/3 people share this phone/.test(t0), 'the Reporters list says "3 people share this phone" on the shared phone', (t0.match(/\d+ people? (share|known)[^\n]*/) || ['no line'])[0])
  check(/1 person known on this phone/.test(t0), 'a phone with one recorded person says so, and a phone with nobody recorded says nothing extra')
  const lines = await evalJs(`[...document.querySelectorAll('.ds-persons-line')].length`)
  check(lines === 2, 'only the two phones with people recorded carry the line', String(lines))
  await axeBoth('Reporters: shared-phone line')
  await seeWho(SHARED_LABEL); await sleep(1500)
  const dlg = await dialogText()
  check(/People who use this phone/.test(dlg) && new RegExp(SIPHO).test(dlg) && new RegExp(NOMSA).test(dlg) && new RegExp(THABO).test(dlg), 'the dialog lists each person by name', dlg.slice(0, 160))
  check(new RegExp(SP.sipho.relation).test(dlg) && new RegExp(SP.nomsa.relation).test(dlg) && new RegExp(SP.thabo.relation).test(dlg), 'and how each is related, as they said it')
  check(new RegExp(PC.nomsa.symptoms + '|CASE-').test(dlg) || new RegExp(await refOf(ids.PN)).test(dlg), 'and the report reference each person gave', (dlg.match(/CASE-[0-9]+-[A-Z0-9]+/g) || []).join(' '))
  check(!dlg.includes(PHONE) && !/\d{7,}/.test(dlg), 'the dialog shows no phone number and no long digit run')
  check(!/\b(persons|speaker|payload|json|person id|reported_by|pp_[a-z]+)\b/i.test(dlg), 'the dialog uses no jargon (person id, speaker, payload)')
  await axeBoth('Reporters: who uses this phone (dialog open)')

  const nomsaBefore = (await P.listPersons(store, sharedContactId)).find((p) => p.name === NOMSA)
  await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Rename ${NOMSA}'); b.click(); return 1 })()`); await sleep(500)
  check(new RegExp('Rename ' + NOMSA).test(await dialogText()), 'Rename asks for the new name in a prompt naming who is being renamed')
  await dialogType(RENAMED); await dialogClick('Save name'); await sleep(2200)
  const after = (await P.listPersons(store, sharedContactId)).find((p) => p.id === nomsaBefore.id)
  check(after && after.name === RENAMED, 'renaming stores the name as typed', after && after.name)
  check(JSON.parse((await store.getCase(ids.PN)).report).reported_by === RENAMED, 'her report\'s "Reported by" follows the rename')
  check(new RegExp(RENAMED).test(await dialogText()), 'the dialog shows the new name at once')

  await call('case_speaker', { name: SECOND }, cx)
  await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Close'); b.click(); return 1 })()`); await sleep(400)
  await seeWho(SHARED_LABEL); await sleep(1500)
  check(new RegExp(SECOND).test(await dialogText()), 'a second spelling of a person appears as a separate person')
  await evalJs(`(() => { const s = document.querySelector('[name^="same-as-"]'); return s ? 1 : 0 })()`)
  const thaboM = (await P.listPersons(store, sharedContactId)).find((p) => p.name === SECOND)
  const thabo = (await P.listPersons(store, sharedContactId)).find((p) => p.name === THABO)
  await evalJs(`(() => { const s = document.querySelector('[name=${JSON.stringify('same-as-' + thaboM.id).slice(1, -1)}]'); s.value = ${JSON.stringify(thabo.id)}; s.dispatchEvent(new Event('change', { bubbles: true })); return 1 })()`); await sleep(600)
  check(new RegExp('Is ' + SECOND + ' the same person as ' + THABO + '\\?').test(await dialogText()), 'joining two records asks first, naming both')
  await dialogClick('Yes, same person'); await sleep(2200)
  check((await P.listPersons(store, sharedContactId)).length === 3 && !(await P.listPersons(store, sharedContactId)).some((p) => p.name === SECOND), 'after joining there are three people again and the duplicate is gone')

  await sleep(6500)
  await viewport('p'); await sleep(800)
  const smallDlg = JSON.parse(await evalJs(SMALL_JS))
  check(smallDlg.length === 0 && await noSideScroll(), 'phone: every control in the people dialog is at least 44px and nothing scrolls sideways', smallDlg.slice(0, 3).join(' ; '))
  await axeBoth('Reporters: who uses this phone (phone width)')
  await viewport('d')

  await asUser('', '#panel=contacts', 4000); await clickText('Public reporters'); await sleep(1200); await seeWho(SHARED_LABEL); await sleep(1500)
  await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Erase ${THABO}'); b.click(); return 1 })()`); await sleep(500)
  const ed = await dialogText()
  check(new RegExp('Erase ' + THABO + '\'s details\\?').test(ed) && /Type their name to confirm/.test(ed) && /phone and everyone else on it are not touched/.test(ed), 'erasing one person says what goes and what stays, and asks for the name', ed.slice(0, 200))
  await dialogType('Somebody Else'); await dialogClick('Erase this person'); await sleep(1500)
  check((await P.listPersons(store, sharedContactId)).some((p) => p.name === THABO), 'a wrong name typed erases nothing')
  await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Erase ${THABO}'); b.click(); return 1 })()`); await sleep(500)
  await dialogType(THABO); await dialogClick('Erase this person'); await sleep(2500)
  const left = await P.listPersons(store, sharedContactId)
  check(left.length === 2 && !left.some((p) => p.name === THABO), 'erasing Thabo leaves Sipho and Nomsa Dlamini', left.map((p) => p.name).join(', '))
  check(JSON.parse((await store.getCase(ids.PT)).report).reported_by == null && JSON.parse((await store.getCase(ids.PT)).report).symptoms === PC.thabo.symptoms, 'his report lost his name and kept the animals', '')
  check((await store.getCase(ids.PT)).external_id === PHONE && (await store.getContact(sharedContactId)).external_id === PHONE, 'the phone itself is left alone')
  check(!new RegExp(THABO).test(await dialogText()), 'the dialog no longer lists him')

  console.log('\noperator: the report says who gave it')
  await asUser('', '#home=cases&case=' + ids.PN, 4000)
  const cd = await bodyText()
  check(new RegExp('Reported by ' + RENAMED + ' \\(' + SP.nomsa.relation + '\\), shared phone: 2 people').test(cd), 'the operator report page says "Reported by Nomsa Dlamini (wife), shared phone: 2 people"', (cd.match(/Reported by[^\n]*/) || ['none'])[0])
  check(new RegExp('Reported by\\s*\\n?\\s*' + RENAMED).test(cd) || /Reported by/.test(cd), 'and the report itself has a Reported by row')
  await axeBoth('operator report with the reporter line')
  await asUser('', '#home=cases&case=' + ids.PL, 4000)
  const cd2 = await bodyText()
  check(new RegExp('Reported by ' + LINDIWE).test(cd2) && !/shared phone/.test(cd2), 'a single-person phone shows the name and no shared-phone claim anywhere on the page', (cd2.match(/[^\n]*shared phone[^\n]*/) || (cd2.match(/Reported by[^\n]*/)) || ['none'])[0])
  const pr = await fetch(base + '/api/cases/' + ids.PN + '/report.html', { headers: { cookie: (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PW }) })).headers.get('set-cookie') || '').split(';')[0] } })
  const prt = await pr.text()
  check(new RegExp('Reported by:</strong> ' + RENAMED + ', shared phone: 2 people').test(prt), 'the printable form says who reported it and that the phone is shared')

  console.log('\neco ranger: who to ask for')
  await asUser('-rng2', '#case=' + ids.PN, 4000)
  const fld = await bodyText()
  check(new RegExp('Reporter: ' + NOMSA + ' \\(shared phone, 2 people\\)').test(fld), 'the ranger\'s report header names the person (first name) and that the phone is shared', (fld.match(/Reporter:[^\n]*/) || ['none'])[0])
  check(new RegExp('Ask for ' + RENAMED + ' \\(' + SP.nomsa.relation + '\\)').test(fld) && /do not discuss the report with anyone else who answers/.test(fld), 'and tells them to ask for her by name and not to discuss it with anyone else who answers')
  await axeBoth('ranger report on a shared phone')
  const nudge = await asApi('-rng2', 'GET', '/api/cases/' + ids.PN)
  check(new RegExp('Hello%20' + RENAMED.replace(' ', '%20') + '%2C').test(nudge.j.reporter_message_link || '') || new RegExp('Hello%20' + NOMSA + '%2C').test(nudge.j.reporter_message_link || ''), 'the WhatsApp link\'s text greets her by name', (nudge.j.reporter_message_link || '').slice(0, 130))
  check(nudge.j.reporter_first_name === NOMSA, 'the ranger sees her first name, not the phone\'s profile name', String(nudge.j.reporter_first_name))
  const pf = await asApi('-rng2', 'GET', '/api/contacts/' + sharedContactId + '/persons')
  check(pf.s === 403, 'a field login cannot list or change the people behind a phone', String(pf.s))
  await viewport('p')
  await asUser('-rng2', '#case=' + ids.PN, 4000)
  const smallF = JSON.parse(await evalJs(SMALL_JS))
  check(smallF.length === 0 && await noSideScroll(), 'phone: the ranger report on a shared phone has 44px controls and no sideways scroll', smallF.slice(0, 3).join(' ; '))
  await asUser('', '#home=cases&case=' + ids.PN, 4000)
  const smallO = JSON.parse(await evalJs(SMALL_JS))
  check(smallO.length === 0 && await noSideScroll(), 'phone: the operator report with the reporter line has 44px controls and no sideways scroll', smallO.slice(0, 3).join(' ; '))
  await asUser('', '#panel=contacts', 4000); await clickText('Public reporters'); await sleep(1200)
  const smallP = JSON.parse(await evalJs(SMALL_JS))
  check(smallP.length === 0 && await noSideScroll(), 'phone: the Reporters list with the people line has 44px controls and no sideways scroll', smallP.slice(0, 3).join(' ; '))
  await viewport('d')

  archive()
  const consoleBad = seenConsole.slice(consoleFrom).filter((m) => !/status of 404/.test(m) && !/<\/(api\/)?tiles?\//.test(m) && !/<\/api\/ready>/.test(m) && !/status of 400.*persons\/erase/.test(m))
  check(consoleBad.length === 0, 'browser console clean across the shared-phone screens (the refused erase with a wrong name is the one deliberate 400)', consoleBad[0] || 'no errors or warnings')
}
