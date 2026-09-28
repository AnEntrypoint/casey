// casey-roles-command.js  --  `casey roles`: list, assign, invite and release the
// team model from a terminal.
//
// A THIN WRAPPER, on purpose. Every subcommand calls the same store methods the
// dashboard's routes call (registerContact / setContactTier / releaseCasesHeldBy,
// role-invites.js's createInvite / listInvites / revokeInvite,
// dashboard/auth.js's setAccountContactPhone), so the terminal is a real recovery
// and scripting path that cannot drift from the GUI. It adds no mechanism of its
// own and no rule the GUI does not have; the only difference is who is asking:
// whoever holds a shell on the box already holds the database, so this acts with
// admin authority (it may grant the operator rung) and records itself as
// `cli-operator`.
//
// Same trust boundary as the routes: it is a person at a terminal, never anything
// a contact's message can reach.

import { createCaseStore } from '../src/case-store.js'
import { TIER_ORDER, TIER_REPORTER, resolveTierValue, atLeast, TIER_FIELD_WORKER, tierLabel } from '../src/contact-tiers.js'
import { createInvite, listInvites, revokeInvite, normalizeMsisdn } from '../src/role-invites.js'
import { fmtPhone27, fmtTimeSAST } from '../src/format.js'
import { TIER_LABELS } from '../src/store/report-shape.js'
import { bold, dim, green, red, cyan, bad, say, closeAndExit } from './casey-cli-ui.js'

const CLI = { id: 'cli-operator', role: 'operator' }
const TEAM_TIERS = TIER_ORDER.filter(t => t !== TIER_REPORTER)

async function openStore() { const s = createCaseStore(); await s.init(); return s }

async function findWhatsappContact(store, needle) {
  const contacts = await store.listContacts({ limit: 5000 })
  const digits = normalizeMsisdn(needle)
  return contacts.find(c => c.id === needle)
    || (digits && contacts.find(c => c.channel === 'whatsapp' && String(c.external_id) === digits))
    || null
}

const usage = () => say('usage: casey roles <list|assign|demote|invite|invites|revoke|release|link> ...   (casey roles --help)')

export async function cmdRoles({ flags, rest }) {
  const store = await openStore()
  const sub = rest[0]
  const pos = rest.slice(1).filter(a => !a.startsWith('--'))
  const fail = async (msg, hint) => { say(bad(msg)); if (hint) say(dim('  ' + hint)); await closeAndExit(store, 1) }

  if (sub === 'list') {
    const contacts = (await store.listContacts({ limit: 5000 })).filter(c => atLeast(resolveTierValue(c.tier), TIER_FIELD_WORKER))
    const { listAccounts } = await import('../src/dashboard/auth.js')
    const accounts = await listAccounts(store)
    if (flags.json) {
      console.log(JSON.stringify({
        contacts: contacts.map(c => ({ id: c.id, name: c.display_name || '', tier: resolveTierValue(c.tier), phone: c.external_id })),
        logins: accounts.map(a => ({ username: a.username, role: a.role, disabled: a.disabled === '1', contact_phone: a.contact_phone || null })),
      }, null, 2))
      await closeAndExit(store, 0)
    }
    console.log(bold('WhatsApp team members'))
    if (!contacts.length) console.log(dim('  none yet -- casey roles assign <phone> <tier> --name "..." or casey roles invite <tier>'))
    for (const c of contacts.sort((a, b) => TIER_ORDER.indexOf(resolveTierValue(b.tier)) - TIER_ORDER.indexOf(resolveTierValue(a.tier)))) {
      console.log(`  ${bold(c.display_name || '(no name)')}\t${cyan(resolveTierValue(c.tier))}\t${dim(fmtPhone27(c.external_id))}\t${dim(c.id)}`)
    }
    console.log(bold('\nDashboard logins'))
    for (const a of accounts) {
      const link = a.contact_phone ? dim(` linked to ${fmtPhone27(a.contact_phone)}`) : ''
      console.log(`  ${bold(a.username)}\t${a.role}\t${a.disabled === '1' ? red('[disabled]') : green('[active]')}${link}`)
    }
    await closeAndExit(store, 0)
  }

  if (sub === 'assign') {
    const [phone, tier] = pos
    if (!phone || !tier) await fail('usage: casey roles assign <phone> <tier> [--name "..."]', `tiers: ${TEAM_TIERS.join(', ')} (or reporter to demote)`)
    if (!TIER_ORDER.includes(tier)) await fail(`there is no tier "${tier}".`, `one of: ${TIER_ORDER.join(', ')}`)
    const external_id = normalizeMsisdn(phone)
    if (!external_id) await fail(`"${phone}" is not a phone number casey can match.`, 'a South African number is 27 plus nine digits, e.g. "079 091 5297" or "+27 79 091 5297".')
    try {
      const c = await store.registerContact({ channel: 'whatsapp', external_id, display_name: typeof flags.name === 'string' ? flags.name.slice(0, 80) : '', tier }, CLI)
      console.log(green(`${c.display_name && c.display_name !== c.external_id ? c.display_name : fmtPhone27(external_id)} is now ${tier}`) + dim(`  (${tierLabel(tier, TIER_LABELS)})`))
      console.log(dim('  they take effect on their next WhatsApp message; nothing was sent to them.'))
      await closeAndExit(store, 0)
    } catch (e) { await fail(e.message) }
  }

  if (sub === 'demote') {
    const needle = pos[0]
    if (!needle) await fail('usage: casey roles demote <phone|contact-id>')
    const c = await findWhatsappContact(store, needle)
    if (!c) await fail(`no contact matches "${needle}".`, 'casey roles list shows the team; a person who never messaged has no contact row.')
    await store.setContactTier(c.id, TIER_REPORTER, CLI)
    console.log(green(`${c.display_name || fmtPhone27(c.external_id)} is now ${TIER_REPORTER}; every open report they held went back to the queue.`))
    await closeAndExit(store, 0)
  }

  if (sub === 'invite') {
    const tier = pos[0]
    if (!tier || !TEAM_TIERS.includes(tier)) await fail('usage: casey roles invite <tier> [--label "..."] [--ttl-hours 72] [--uses 1]', `tiers: ${TEAM_TIERS.join(', ')}`)
    try {
      const inv = await createInvite(store, {
        tier, label: typeof flags.label === 'string' ? flags.label : '',
        ttlHours: flags['ttl-hours'] === true ? undefined : flags['ttl-hours'], maxUses: flags.uses === true ? undefined : flags.uses,
        by: 'cli-operator', grantableTiers: TEAM_TIERS,
      })
      console.log(green(`one-time code for ${tier}: `) + bold(inv.code) + dim('   (shown once; only its hash is stored)'))
      console.log(dim(`  expires ${fmtTimeSAST(Math.floor(inv.expires_at / 1000))}, ${inv.max_uses} use(s).`))
      console.log(dim('  the person sends exactly that code, and nothing else, to the bot number on WhatsApp.'))
      await closeAndExit(store, 0)
    } catch (e) { await fail(e.message) }
  }

  if (sub === 'invites') {
    const list = await listInvites(store)
    if (flags.json) { console.log(JSON.stringify(list, null, 2)); await closeAndExit(store, 0) }
    if (!list.length) console.log(dim('no invites yet.'))
    for (const i of list) console.log(`${bold(i.id)}\t${i.tier}\t${i.status === 'active' ? green(i.status) : dim(i.status)}\t${i.uses}/${i.max_uses}\t${dim(i.label || '')}\t${dim('by ' + i.created_by)}\t${dim('expires ' + fmtTimeSAST(Math.floor(i.expires_at / 1000)))}`)
    await closeAndExit(store, 0)
  }

  if (sub === 'revoke') {
    if (!pos[0]) await fail('usage: casey roles revoke <invite-id>', 'ids are the first column of casey roles invites')
    try { await revokeInvite(store, pos[0], 'cli-operator'); console.log(green(`invite ${pos[0]} revoked`)); await closeAndExit(store, 0) }
    catch (e) { await fail(e.message) }
  }

  if (sub === 'release') {
    const holder = pos[0]
    if (!holder) await fail('usage: casey roles release <phone|contact-id|username>', 'sends every OPEN report they hold back to the queue (unassigned; the assistant resumes)')
    const c = await findWhatsappContact(store, holder)
    const key = c ? `contact:${c.id}` : holder
    const n = await store.releaseCasesHeldBy(key, 'released from the terminal', CLI)
    console.log(green(`${n} open report(s) released from ${c ? (c.display_name || fmtPhone27(c.external_id)) : holder}`))
    await closeAndExit(store, 0)
  }

  if (sub === 'link') {
    const [username, phone] = pos
    if (!username || !phone) await fail('usage: casey roles link <username> <phone>', 'links a dashboard login to its WhatsApp contact so "my reports" works for a ranger or technician')
    const { findAccountByUsername, setAccountContactPhone } = await import('../src/dashboard/auth.js')
    const acct = await findAccountByUsername(store, username)
    if (!acct) await fail(`no login "${username}".`, 'casey operators list')
    try { await setAccountContactPhone(store, acct.id, phone); console.log(green(`${username} is linked to ${fmtPhone27(normalizeMsisdn(phone))}`)); await closeAndExit(store, 0) }
    catch (e) { await fail(e.message) }
  }

  if (sub) say(bad(`casey roles has no "${sub}" subcommand.`))
  usage()
  await closeAndExit(store, 1)
}
