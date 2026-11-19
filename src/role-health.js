

import fs from 'node:fs'
import { TIER_ORDER, atLeast, resolveTierValue, TIER } from './contact-tiers.js'
import { FIELD_ROLES, SPECIALIST_ROLE } from './domain-roles.js'
import { caseyText } from './deployment-text.js'

const row = (id, level, text, fix) => ({ id, level, text, ...(fix ? { fix } : {}) })
const DAY = 86400e3
const STALE_DAYS = 3
export const UNCLAIMED = 'agent'

async function openReadOnly(dbFile) {
  const { createClient } = await import('@libsql/client')

  return createClient({ url: `file:${dbFile}` })
}

const q = async (db, sql, args = []) => (await db.execute({ sql, args })).rows
const tableCols = async (db, t) => new Set((await q(db, caseyText("src/role-health.js#w0", [t]))).map(r => String(r.name)))
const ms = (v) => { const n = Number(v); if (Number.isFinite(n) && n > 0) return n < 1e11 ? n * 1000 : n; const d = Date.parse(String(v || '')); return Number.isFinite(d) ? d : 0 }

export async function checkRoleSetup(dbFile, { openStatuses = [], now = Date.now() } = {}) {
  const rows = []
  if (!fs.existsSync(dbFile)) return { rows: [row('roles-db', 'info', caseyText("src/role-health.js#w1"))] }
  let db
  try { db = await openReadOnly(dbFile) }
  catch (e) { return { rows: [row('roles-db', 'warn', caseyText("src/role-health.js#w2", [e.message]))] } }
  try {
    const tables = new Set((await q(db, caseyText("src/role-health.js#w3"))).map(r => String(r.name)))

    let accounts = []
    let acctCols = new Set()
    if (tables.has('operator_account')) {
      acctCols = await tableCols(db, 'operator_account')
      const sel = ['id', 'username', 'display_name', 'role', 'disabled', 'status', 'setup_email_status'].filter(c => acctCols.has(c))
      if (acctCols.has('contact_phone')) sel.push('contact_phone')
      accounts = (await q(db, caseyText("src/role-health.js#w4", [sel.join(', ')]))).filter(a => a.status !== 'deleted')
    }
    const live = accounts.filter(a => String(a.disabled) !== '1')
    const admins = live.filter(a => a.role === 'admin')
    if (!accounts.length) rows.push(row('admin', 'info', caseyText("src/role-health.js#w5")))
    else if (!admins.length) rows.push(row('admin', 'fail', caseyText("src/role-health.js#w6"), 'Create one from the terminal: casey operators add <name> --role admin (prints a generated password).'))
    else rows.push(row('admin', 'ok', caseyText("src/role-health.js#w8", [admins.length, live.length])))
    const unsent = accounts.filter(a => a.setup_email_status === 'not_sent')
    if (unsent.length) rows.push(row('account-setup', 'warn', caseyText("src/role-health.js#w9", [unsent.length]), 'Set CASEY_SMTP_HOST and CASEY_SMTP_FROM for the service (also CASEY_SMTP_PORT, CASEY_SMTP_USER and CASEY_SMTP_PASSWORD when the relay needs them), restart the service, then POST /api/accounts/<id>/resend-setup for each such login.'))

    let contacts = []
    if (tables.has('contact')) {
      const ccols = await tableCols(db, 'contact')
      if (ccols.has('tier')) contacts = (await q(db, caseyText("src/role-health.js#w11"))).filter(c => c.status !== 'deleted' && c.channel !== 'system')
    }
    const teamContacts = contacts.filter(c => atLeast(resolveTierValue(c.tier), TIER.field))
    const fieldLogins = live.filter(a => FIELD_ROLES.includes(a.role))
    const byTier = {}
    for (const c of teamContacts) byTier[resolveTierValue(c.tier)] = (byTier[resolveTierValue(c.tier)] || 0) + 1
    if (!teamContacts.length && !fieldLogins.length) {
      rows.push(row('team', 'warn', caseyText("src/role-health.js#o0"),
        'Register the first person: casey roles assign <phone> <tier> --name "..." , or casey roles invite <tier> for a one-time WhatsApp code. Tiers: ' + TIER_ORDER.filter(t => t !== 'reporter').join(', ') + '.'))
    } else {
      const parts = Object.entries(byTier).map(([t, n]) => `${n} ${t}`)
      rows.push(row('team', 'ok', caseyText("src/role-health.js#w13", [parts.join(', ') || caseyText("src/role-health.js#w14"), fieldLogins.length ? caseyText("src/role-health.js#w15", [fieldLogins.length]) : ''])))
      if (!byTier[TIER.specialist] && !live.some(a => a.role === SPECIALIST_ROLE)) {
        rows.push(row('team-signoff', 'warn', caseyText("src/role-health.js#w16", [TIER.specialist]), `casey roles assign <phone> ${TIER.specialist} --name "..."`))
      }
    }
    if (acctCols.size && !acctCols.has('contact_phone')) {
      rows.push(row('contact-phone', 'info', caseyText("src/role-health.js#w18")))
    } else if (acctCols.has('contact_phone')) {
      const unlinked = fieldLogins.filter(a => !String(a.contact_phone || '').trim())
      if (unlinked.length) rows.push(row('contact-phone', 'warn', caseyText("src/role-health.js#w19", [unlinked.length, unlinked.slice(0, 5).map(a => a.username).join(', ')]), caseyText("src/role-health.js#w20")))
      else rows.push(row('contact-phone', 'ok', caseyText("src/role-health.js#w21")))
    }

    if (tables.has('case') && tables.has('event')) {
      const inv = (await q(db, caseyText("src/role-health.js#w22")))[0]
      if (!inv) rows.push(row('invites', 'info', caseyText("src/role-health.js#w23")))
      else {
        const evs = await q(db, caseyText("src/role-health.js#w24"), [inv.id])
        let bad = 0
        const created = new Map(); const claimed = new Map(); const revoked = new Set()
        for (const e of evs) {
          try {
            const r = JSON.parse(String(e.text).slice('role-invite:'.length))
            if (!r?.id) { bad++; continue }
            if (r.op === 'create') created.set(r.id, r)
            else if (r.op === 'claim') claimed.set(r.id, (claimed.get(r.id) || 0) + 1)
            else if (r.op === 'revoke') revoked.add(r.id)
          } catch { bad++ }
        }
        let active = 0
        for (const [id, r] of created) if (!revoked.has(id) && (claimed.get(id) || 0) < (r.max || 1) && Number(r.exp) > now) active++
        if (bad) rows.push(row('invites', 'fail', caseyText("src/role-health.js#w25", [bad]), caseyText("src/role-health.js#w26")))
        else rows.push(row('invites', 'ok', caseyText("src/role-health.js#w27", [created.size, [...claimed.values()].reduce((a, b) => a + b, 0), active])))
      }
    }

    if (tables.has('case')) {
      const statuses = openStatuses.length ? openStatuses : null
      const where = statuses ? caseyText("src/role-health.js#w28", [statuses.map(() => '?').join(',')]) : caseyText("src/role-health.js#w29")
      const open = await q(db, caseyText("src/role-health.js#w30", [where]), [...(statuses || []), UNCLAIMED])
      const contactById = new Map(contacts.map(c => [String(c.id), c]))
      const loginByName = new Map(accounts.map(a => [String(a.username), a]))
      const orphans = []
      const stale = new Map()
      for (const c of open) {
        const a = String(c.assignee)
        let holder = null; let problem = ''
        if (a.startsWith('contact:')) {
          holder = contactById.get(a.slice(8))
          if (!holder) problem = caseyText("src/role-health.js#w31")
          else if (!atLeast(resolveTierValue(holder.tier), TIER.field)) problem = caseyText("src/role-health.js#w32", [holder.display_name || 'a contact'])
        } else {
          holder = loginByName.get(a)
          if (!holder) problem = caseyText("src/role-health.js#w33", [a])
          else if (String(holder.disabled) === '1') problem = caseyText("src/role-health.js#w34", [holder.display_name || holder.username])
        }
        if (problem) { orphans.push({ ref: c.ref, problem }); continue }
        const last = ms(c.last_event_at)
        if (last && now - last > STALE_DAYS * DAY) {
          const name = a.startsWith('contact:') ? (holder.display_name || caseyText("src/role-health.js#w35")) : (holder.display_name || holder.username)
          stale.set(name, (stale.get(name) || 0) + 1)
        }
      }
      if (orphans.length) {
        const byProblem = new Map()
        for (const o of orphans) byProblem.set(o.problem, [...(byProblem.get(o.problem) || []), o.ref])
        const sample = [...byProblem.entries()].slice(0, 3).map(([p, refs]) => caseyText("src/role-health.js#w36", [refs.length, p, refs.slice(0, 2).join(', '), refs.length > 2 ? ', ...' : ''])).join('; ')
        rows.push(row('orphans', 'warn', caseyText("src/role-health.js#w37", [orphans.length, sample]),
          'Reassign or release them: dashboard case editor -> Assignee, or casey roles release <holder>. Demoting a contact releases their reports automatically; a deleted or renamed login does not.'))
      } else rows.push(row('orphans', 'ok', caseyText("src/role-health.js#w39")))
      if (stale.size) {
        const list = [...stale.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, k]) => `${n} (${k})`).join(', ')
        rows.push(row('stale-assigned', 'warn', caseyText("src/role-health.js#w40", [[...stale.values()].reduce((a, b) => a + b, 0), STALE_DAYS, list]), caseyText("src/role-health.js#w41")))
      } else rows.push(row('stale-assigned', 'ok', caseyText("src/role-health.js#w42", [STALE_DAYS])))
    }

    if (tables.has('case')) {
      const n = Number((await q(db, caseyText("src/role-health.js#w43")))[0]?.n) || 0
      if (n) rows.push(row('undelivered', 'warn', caseyText("src/role-health.js#w44", [n]), caseyText("src/role-health.js#w45")))
    }
  } catch (e) {
    rows.push(row('roles-db', 'warn', caseyText("src/role-health.js#w46", [String(e.message).slice(0, 120)])))
  } finally { try { db.close?.() } catch {  } }
  return { rows }
}
