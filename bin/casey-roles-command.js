import { caseyText } from '../src/deployment-text.js'
import { createCaseStore } from '../src/case-store.js'
import { TIER_ORDER, resolveTierValue, atLeast, tierLabel, TIER } from '../src/contact-tiers.js'
import { createInvite, createInvites, listInvites, revokeInvite, normalizeMsisdn } from '../src/role-invites.js'
import { mapRole } from '../src/team-import.js'
import { fmtPhone27, fmtTimeLocal } from '../src/format.js'
import { TIER_LABELS } from '../src/store/report-shape.js'
import { bold, dim, green, red, cyan, bad, say, closeAndExit } from './casey-cli-ui.js'
import { cliText } from './casey-cli-text.js'
import { readFileSync } from 'node:fs'
import { runImport, MAX_IMPORT_ROWS, MAX_IMPORT_CHARS } from '../src/team-import.js'
import { rolloutTable, forgetRoster } from '../src/team-roster.js'

const CLI = { id: 'cli-operator', role: 'operator' }
const TEAM_TIERS = TIER_ORDER.filter(t => t !== TIER.reporter)

async function openStore() { const s = createCaseStore(); await s.init(); return s }

async function findWhatsappContact(store, needle) {
  const contacts = await store.listContacts({ limit: 5000 })
  const digits = normalizeMsisdn(needle)
  return contacts.find(c => c.id === needle)
    || (digits && contacts.find(c => c.channel === 'whatsapp' && String(c.external_id) === digits))
    || null
}

const usage = () => say(caseyText("bin/casey-roles-command.js#w0"))

export async function cmdRoles({ flags, rest }) {
  const store = await openStore()
  const sub = rest[0]
  const pos = rest.slice(1).filter(a => !a.startsWith('--'))
  const fail = async (msg, hint) => { say(bad(msg)); if (hint) say(dim('  ' + hint)); await closeAndExit(store, 1) }

  if (sub === 'list') {
    const contacts = (await store.listContacts({ limit: 5000 })).filter(c => atLeast(resolveTierValue(c.tier), TIER.field))
    const { listAccounts } = await import('../src/dashboard/auth.js')
    const accounts = await listAccounts(store)
    if (flags.json) {
      console.log(JSON.stringify({
        contacts: contacts.map(c => ({ id: c.id, name: c.display_name || '', tier: resolveTierValue(c.tier), phone: c.external_id })),
        logins: accounts.map(a => ({ username: a.username, role: a.role, disabled: a.disabled === '1', contact_phone: a.contact_phone || null })),
      }, null, 2))
      await closeAndExit(store, 0)
    }
    console.log(bold(caseyText("bin/casey-roles-command.js#w1")))
    if (!contacts.length) console.log(dim(caseyText("bin/casey-roles-command.js#w2")))
    for (const c of contacts.sort((a, b) => TIER_ORDER.indexOf(resolveTierValue(b.tier)) - TIER_ORDER.indexOf(resolveTierValue(a.tier)))) {
      console.log(`  ${bold(c.display_name || caseyText("bin/casey-roles-command.js#w3"))}\t${cyan(resolveTierValue(c.tier))}\t${dim(fmtPhone27(c.external_id))}\t${dim(c.id)}`)
    }
    console.log(bold(caseyText("bin/casey-roles-command.js#w4")))
    for (const a of accounts) {
      const link = a.contact_phone ? dim(caseyText("bin/casey-roles-command.js#w5", [fmtPhone27(a.contact_phone)])) : ''
      console.log(`  ${bold(a.username)}\t${a.role}\t${a.disabled === '1' ? red('[disabled]') : green('[active]')}${link}`)
    }
    await closeAndExit(store, 0)
  }

  if (sub === 'import') {
    const file = pos[0]
    if (!file) await fail(caseyText("bin/casey-roles-command.js#w6"), cliText('roles.import.hint') ?? caseyText("bin/casey-roles-command.js#w7"))
    let csv
    try { csv = readFileSync(file, 'utf8') } catch { await fail(caseyText("bin/casey-roles-command.js#w8", [file])) }
    if (csv.length > MAX_IMPORT_CHARS) await fail(caseyText("bin/casey-roles-command.js#w9", [MAX_IMPORT_CHARS, MAX_IMPORT_ROWS]))
    const apply = !!flags.yes && !flags['dry-run']
    let out
    try { out = await runImport(store, { csv }, { dryRun: !apply, isAdmin: true, by: 'cli-operator' }) } catch (e) { await fail(e.message) }
    if (flags.json) { console.log(JSON.stringify(out, null, 2)); await closeAndExit(store, 0) }
    const col = { create: green, update: cyan, skip: dim, error: red }
    for (const r of out.results) console.log(`  line ${String(r.line).padEnd(4)} ${(col[r.action] || dim)(r.action.padEnd(6))} ${bold(r.name || caseyText("bin/casey-roles-command.js#w10"))}${r.role ? dim('  ' + r.role) : ''}${r.area ? dim('  ' + r.area) : ''}${r.phone ? dim('  ' + r.phone) : ''}  ${dim(r.reason)}`)
    const s = out.summary
    console.log(caseyText("bin/casey-roles-command.js#w11", [s.create, s.update, s.skip, s.error]))
    if (apply) console.log(green('applied.') + dim(caseyText("bin/casey-roles-command.js#w12")))
    else console.log(dim(flags['dry-run'] ? caseyText("bin/casey-roles-command.js#w13") : caseyText("bin/casey-roles-command.js#w14")))
    await closeAndExit(store, s.error && apply ? 2 : 0)
  }

  if (sub === 'roster') {
    if (flags.forget) {
      const gone = await forgetRoster(store, typeof flags.forget === 'string' ? flags.forget : pos[0] || '', 'cli-operator')
      console.log(gone ? green(caseyText("bin/casey-roles-command.js#w15")) : dim(caseyText("bin/casey-roles-command.js#w16")))
      await closeAndExit(store, gone ? 0 : 1)
    }
    const t = await rolloutTable(store)
    if (flags.json) { console.log(JSON.stringify(t, null, 2)); await closeAndExit(store, 0) }
    if (!t.areas.length) console.log(dim(caseyText("bin/casey-roles-command.js#w17")))
    else {
      const w = Math.max(11, ...t.areas.map(a => a.area.length))
      console.log(bold('association'.padEnd(w)) + bold(caseyText("bin/casey-roles-command.js#w18")))
      for (const a of [...t.areas, { area: 'ALL', ...t.totals }]) console.log(`${a.area.padEnd(w)}  ${String(a.total).padStart(5)}  ${String(a.smartphones).padStart(11)}  ${String(a.registered).padStart(10)}  ${String(a.first_message).padStart(13)}  ${String(a.first_case).padStart(10)}`)
    }
    await closeAndExit(store, 0)
  }

  if (sub === 'assign') {
    const phone = pos[0]; let tier = pos[1]
    if (!phone || !tier) await fail(caseyText("bin/casey-roles-command.js#w19"), caseyText("bin/casey-roles-command.js#w20", [TEAM_TIERS.join(', ')]))
    if (!TIER_ORDER.includes(tier)) { const m = mapRole(tier); if (m.tier) tier = m.tier; else await fail(caseyText("bin/casey-roles-command.js#w21", [pos[1]]), caseyText("bin/casey-roles-command.js#w22", [TIER_ORDER.join(', ')])) }
    const external_id = normalizeMsisdn(phone)
    if (!external_id) await fail(caseyText("bin/casey-roles-command.js#w23", [phone]), caseyText("bin/casey-roles-command.js#phone-example"))
    try {
      const c = await store.registerContact({ channel: 'whatsapp', external_id, display_name: typeof flags.name === 'string' ? flags.name.slice(0, 80) : '', tier }, CLI)
      console.log(green(caseyText("bin/casey-roles-command.js#w24", [c.display_name && c.display_name !== c.external_id ? c.display_name : fmtPhone27(external_id), tier])) + dim(`  (${tierLabel(tier, TIER_LABELS)})`))
      console.log(dim(caseyText("bin/casey-roles-command.js#w25")))
      await closeAndExit(store, 0)
    } catch (e) { await fail(e.message) }
  }

  if (sub === 'demote') {
    const needle = pos[0]
    if (!needle) await fail(caseyText("bin/casey-roles-command.js#w26"))
    const c = await findWhatsappContact(store, needle)
    if (!c) await fail(caseyText("bin/casey-roles-command.js#w27", [needle]), caseyText("bin/casey-roles-command.js#w28"))
    await store.setContactTier(c.id, TIER.reporter, CLI)
    console.log(green(caseyText("bin/casey-roles-command.js#w29", [c.display_name || fmtPhone27(c.external_id), TIER.reporter])))
    await closeAndExit(store, 0)
  }

  if (sub === 'invite') {
    let tier = pos[0]
    if (tier && !TEAM_TIERS.includes(tier)) { const m = mapRole(tier); if (m.tier && TEAM_TIERS.includes(m.tier)) tier = m.tier }
    if (!tier || !TEAM_TIERS.includes(tier)) await fail(caseyText("bin/casey-roles-command.js#w30"), `tiers: ${TEAM_TIERS.join(', ')}`)
    try {
      const base = {
        tier, label: typeof flags.label === 'string' ? flags.label : '',
        ttlHours: flags['ttl-hours'] === true ? undefined : flags['ttl-hours'], maxUses: flags.uses === true ? undefined : flags.uses,
        by: 'cli-operator', grantableTiers: TEAM_TIERS,
      }
      const whole = (name, v, lo, hi) => { const n = Number(v); if (v === true || !Number.isInteger(n) || n < lo || n > hi) throw new Error(`--${name} must be a whole number from ${lo} to ${hi}`); return n }
      if (flags.uses !== undefined) base.maxUses = whole('uses', flags.uses, 1, 25)
      if (flags['ttl-hours'] !== undefined) base.ttlHours = whole('ttl-hours', flags['ttl-hours'], 1, 24 * 30)
      const outFile = typeof flags.out === 'string' ? flags.out : null
      if (flags.out !== undefined && !outFile) throw new Error('--out needs a file name')
      if (flags.count !== undefined || outFile) {
        const count = flags.count === undefined ? 1 : whole('count', flags.count, 1, 100)
        const { writeFileSync, chmodSync } = await import('node:fs')
        if (outFile) { writeFileSync(outFile, '', { mode: 0o600 }); chmodSync(outFile, 0o600) }
        const invs = await createInvites(store, { ...base, count })
        if (outFile) {
          writeFileSync(outFile, invs.map(i => `${i.code}\t${i.label}`).join('\n') + '\n', { mode: 0o600 })
          console.log(green(caseyText("bin/casey-roles-command.js#w31", [invs.length, invs.length === 1 ? '' : 's', tier, outFile])) + dim(caseyText("bin/casey-roles-command.js#w32")))
        } else {
          for (const i of invs) console.log(bold(i.code) + dim(`   ${i.label}`))
          console.log(green(caseyText("bin/casey-roles-command.js#w33", [invs.length, invs.length === 1 ? '' : 's', tier])) + dim(caseyText("bin/casey-roles-command.js#w34")))
        }
        console.log(dim(caseyText("bin/casey-roles-command.js#w35", [fmtTimeLocal(Math.floor(invs[0].expires_at / 1000)), invs[0].max_uses])))
        console.log(dim(caseyText("bin/casey-roles-command.js#w36")))
        await closeAndExit(store, 0)
      }
      const inv = await createInvite(store, base)
      console.log(green(caseyText("bin/casey-roles-command.js#w37", [tier])) + bold(inv.code) + dim(caseyText("bin/casey-roles-command.js#w38")))
      console.log(dim(`  expires ${fmtTimeLocal(Math.floor(inv.expires_at / 1000))}, ${inv.max_uses} use(s).`))
      console.log(dim(caseyText("bin/casey-roles-command.js#w39")))
      await closeAndExit(store, 0)
    } catch (e) { await fail(e.message) }
  }

  if (sub === 'invites') {
    const list = await listInvites(store)
    if (flags.json) { console.log(JSON.stringify(list, null, 2)); await closeAndExit(store, 0) }
    if (!list.length) console.log(dim(caseyText("bin/casey-roles-command.js#w40")))
    for (const i of list) console.log(`${bold(i.id)}\t${i.tier}\t${i.status === 'active' ? green(i.status) : dim(i.status)}\t${i.uses}/${i.max_uses}\t${dim(i.label || '')}\t${dim('by ' + i.created_by)}\t${dim('expires ' + fmtTimeLocal(Math.floor(i.expires_at / 1000)))}`)
    await closeAndExit(store, 0)
  }

  if (sub === 'revoke') {
    if (!pos[0]) await fail(caseyText("bin/casey-roles-command.js#w41"), caseyText("bin/casey-roles-command.js#w42"))
    try { await revokeInvite(store, pos[0], 'cli-operator'); console.log(green(caseyText("bin/casey-roles-command.js#w43", [pos[0]]))); await closeAndExit(store, 0) }
    catch (e) { await fail(e.message) }
  }

  if (sub === 'release') {
    const holder = pos[0]
    if (!holder) await fail(caseyText("bin/casey-roles-command.js#w44"), caseyText("bin/casey-roles-command.js#w45"))
    const c = await findWhatsappContact(store, holder)
    const key = c ? `contact:${c.id}` : holder
    const n = await store.releaseCasesHeldBy(key, caseyText("bin/casey-roles-command.js#w46"), CLI)
    console.log(green(caseyText("bin/casey-roles-command.js#w47", [n, c ? (c.display_name || fmtPhone27(c.external_id)) : holder])))
    await closeAndExit(store, 0)
  }

  if (sub === 'link') {
    const [username, phone] = pos
    if (!username || !phone) await fail(caseyText("bin/casey-roles-command.js#w48"), caseyText("bin/casey-roles-command.js#w49"))
    const { findAccountByUsername, setAccountContactPhone } = await import('../src/dashboard/auth.js')
    const acct = await findAccountByUsername(store, username)
    if (!acct) await fail(caseyText("bin/casey-roles-command.js#w50", [username]), caseyText("bin/casey-roles-command.js#w51"))
    try { await setAccountContactPhone(store, acct.id, phone); console.log(green(caseyText("bin/casey-roles-command.js#w52", [username, fmtPhone27(normalizeMsisdn(phone))]))); await closeAndExit(store, 0) }
    catch (e) { await fail(e.message) }
  }

  if (sub) say(bad(caseyText("bin/casey-roles-command.js#w53", [sub])))
  usage()
  await closeAndExit(store, 1)
}
