// role-health.js -- the role-setup rows of `casey doctor`: is the team model this
// deployment depends on actually in place, and is anything held by somebody who
// can no longer act on it?
//
// READ-ONLY, and it reads the sqlite file directly rather than booting a
// CaseStore: doctor is a preflight and must not create, migrate or lock anything
// to answer a question (the same rule its health-sweep row already follows). All
// questions are plain SELECTs over the four tables the role model lives in.
//
// The rows are { id, level: 'ok'|'fail'|'warn'|'info', text, fix? } so the CLI
// renders them and a driver can assert on them. No row carries a phone number;
// a person is named only by the display name or login the operator already sees.

import fs from 'node:fs'
import { TIER_ORDER, atLeast, TIER_FIELD_WORKER, resolveTierValue } from './contact-tiers.js'

const row = (id, level, text, fix) => ({ id, level, text, ...(fix ? { fix } : {}) })
const DAY = 86400e3
const STALE_DAYS = 3
export const UNCLAIMED = 'agent'

async function openReadOnly(dbFile) {
  const { createClient } = await import('@libsql/client')
  // libsql's `mode=ro` query parameter is not supported by this client, so the
  // guarantee is structural instead: this module issues SELECT and PRAGMA
  // table_info only.
  return createClient({ url: `file:${dbFile}` })
}

const q = async (db, sql, args = []) => (await db.execute({ sql, args })).rows
const tableCols = async (db, t) => new Set((await q(db, `PRAGMA table_info("${t}")`)).map(r => String(r.name)))
const ms = (v) => { const n = Number(v); if (Number.isFinite(n) && n > 0) return n < 1e11 ? n * 1000 : n; const d = Date.parse(String(v || '')); return Number.isFinite(d) ? d : 0 }

export async function checkRoleSetup(dbFile, { openStatuses = [], now = Date.now() } = {}) {
  const rows = []
  if (!fs.existsSync(dbFile)) return { rows: [row('roles-db', 'info', 'no case data yet: role checks will run once there is a database')] }
  let db
  try { db = await openReadOnly(dbFile) }
  catch (e) { return { rows: [row('roles-db', 'warn', `role checks could not open the database read-only (${e.message})`)] } }
  try {
    const tables = new Set((await q(db, `SELECT name FROM sqlite_master WHERE type='table'`)).map(r => String(r.name)))
    // ---- logins: at least one enabled admin -------------------------------------
    let accounts = []
    let acctCols = new Set()
    if (tables.has('operator_account')) {
      acctCols = await tableCols(db, 'operator_account')
      const sel = ['id', 'username', 'display_name', 'role', 'disabled', 'status'].filter(c => acctCols.has(c))
      if (acctCols.has('contact_phone')) sel.push('contact_phone')
      accounts = (await q(db, `SELECT ${sel.join(', ')} FROM operator_account`)).filter(a => a.status !== 'deleted')
    }
    const live = accounts.filter(a => String(a.disabled) !== '1')
    const admins = live.filter(a => a.role === 'admin')
    if (!accounts.length) rows.push(row('admin', 'info', 'no dashboard logins yet: a bootstrap admin is created on first boot'))
    else if (!admins.length) rows.push(row('admin', 'fail', 'there is NO enabled admin login: nobody can create logins, grant the operator rung or unlock accounts', 'Create one from the terminal: casey operators add <name> --role admin (prints a generated password).'))
    else rows.push(row('admin', 'ok', `${admins.length} enabled admin login(s), ${live.length} enabled login(s) in all`))

    // ---- the field team ----------------------------------------------------------
    let contacts = []
    if (tables.has('contact')) {
      const ccols = await tableCols(db, 'contact')
      if (ccols.has('tier')) contacts = (await q(db, `SELECT id, external_id, display_name, tier, status, channel FROM contact`)).filter(c => c.status !== 'deleted' && c.channel !== 'system')
    }
    const teamContacts = contacts.filter(c => atLeast(resolveTierValue(c.tier), TIER_FIELD_WORKER))
    const fieldLogins = live.filter(a => a.role === 'eco_ranger' || a.role === 'animal_health_technician')
    const byTier = {}
    for (const c of teamContacts) byTier[resolveTierValue(c.tier)] = (byTier[resolveTierValue(c.tier)] || 0) + 1
    if (!teamContacts.length && !fieldLogins.length) {
      rows.push(row('team', 'warn', 'nobody is registered as a ranger, technician or operator: no case can be assigned and the field roles are unused',
        'Register the first person: casey roles assign <phone> <tier> --name "..." , or casey roles invite <tier> for a one-time WhatsApp code. Tiers: ' + TIER_ORDER.filter(t => t !== 'reporter').join(', ') + '.'))
    } else {
      const parts = Object.entries(byTier).map(([t, n]) => `${n} ${t}`)
      rows.push(row('team', 'ok', `registered team: ${parts.join(', ') || 'no WhatsApp contacts'}${fieldLogins.length ? `; ${fieldLogins.length} field login(s)` : ''}`))
      if (!byTier.animal_health_technician && !live.some(a => a.role === 'animal_health_technician')) {
        rows.push(row('team-signoff', 'warn', 'nobody holds the animal_health_technician rung, and only that rung may sign a report off over WhatsApp', 'casey roles assign <phone> animal_health_technician --name "..."'))
      }
    }
    if (acctCols.size && !acctCols.has('contact_phone')) {
      rows.push(row('contact-phone', 'info', 'operator_account has no contact_phone column yet: it is added automatically the first time a login is linked to a number (older rows read as unlinked)'))
    } else if (acctCols.has('contact_phone')) {
      const unlinked = fieldLogins.filter(a => !String(a.contact_phone || '').trim())
      if (unlinked.length) rows.push(row('contact-phone', 'warn', `${unlinked.length} field login(s) have no contact_phone (${unlinked.slice(0, 5).map(a => a.username).join(', ')}): "my cases" is empty for them because nothing links the login to a WhatsApp contact`, 'Admin: set the number on the login (dashboard -> team -> the login, or POST /api/accounts/:id/contact-phone).'))
      else rows.push(row('contact-phone', 'ok', 'contact_phone column present; every field login is linked to a number'))
    }

    // ---- the invite log ----------------------------------------------------------
    if (tables.has('case') && tables.has('event')) {
      const inv = (await q(db, `SELECT id FROM "case" WHERE channel='system' AND external_id='settings:role-invites' AND (status IS NULL OR status != 'deleted') LIMIT 1`))[0]
      if (!inv) rows.push(row('invites', 'info', 'no role-invite log yet (created on the first invite)'))
      else {
        const evs = await q(db, `SELECT text FROM event WHERE case_id=? AND kind='observation' AND text LIKE 'role-invite:%'`, [inv.id])
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
        if (bad) rows.push(row('invites', 'fail', `the role-invite log holds ${bad} unreadable record(s): invites replayed from it may be wrong`, 'Inspect the events on the system case settings:role-invites; do not edit them, revoke and re-issue instead.'))
        else rows.push(row('invites', 'ok', `role-invite log readable: ${created.size} issued, ${[...claimed.values()].reduce((a, b) => a + b, 0)} claimed, ${active} unused and unexpired`))
      }
    }

    // ---- who holds what ----------------------------------------------------------
    if (tables.has('case')) {
      const statuses = openStatuses.length ? openStatuses : null
      const where = statuses ? `status IN (${statuses.map(() => '?').join(',')})` : `status NOT IN ('closed','deleted')`
      const open = await q(db, `SELECT ref, assignee, last_event_at, status FROM "case" WHERE ${where} AND channel != 'system' AND assignee IS NOT NULL AND assignee != '' AND assignee != ?`, [...(statuses || []), UNCLAIMED])
      const contactById = new Map(contacts.map(c => [String(c.id), c]))
      const loginByName = new Map(accounts.map(a => [String(a.username), a]))
      const orphans = []
      const stale = new Map()
      for (const c of open) {
        const a = String(c.assignee)
        let holder = null; let problem = ''
        if (a.startsWith('contact:')) {
          holder = contactById.get(a.slice(8))
          if (!holder) problem = 'a contact that no longer exists'
          else if (!atLeast(resolveTierValue(holder.tier), TIER_FIELD_WORKER)) problem = `${holder.display_name || 'a contact'}, who no longer holds a team rung`
        } else {
          holder = loginByName.get(a)
          if (!holder) problem = `"${a}", who is not a login or a team contact`
          else if (String(holder.disabled) === '1') problem = `${holder.display_name || holder.username}, whose login is disabled`
        }
        if (problem) { orphans.push({ ref: c.ref, problem }); continue }
        const last = ms(c.last_event_at)
        if (last && now - last > STALE_DAYS * DAY) {
          const name = a.startsWith('contact:') ? (holder.display_name || 'a team member') : (holder.display_name || holder.username)
          stale.set(name, (stale.get(name) || 0) + 1)
        }
      }
      if (orphans.length) {
        const byProblem = new Map()
        for (const o of orphans) byProblem.set(o.problem, [...(byProblem.get(o.problem) || []), o.ref])
        const sample = [...byProblem.entries()].slice(0, 3).map(([p, refs]) => `${refs.length} held by ${p} (${refs.slice(0, 2).join(', ')}${refs.length > 2 ? ', ...' : ''})`).join('; ')
        rows.push(row('orphans', 'warn', `${orphans.length} open report(s) are assigned to somebody who cannot act on them: ${sample}`,
          'Reassign or release them: dashboard case editor -> Assignee, or casey roles release <holder>. Demoting a contact releases their reports automatically; a deleted or renamed login does not.'))
      } else rows.push(row('orphans', 'ok', 'no open report is assigned to a demoted, deleted or unknown holder'))
      if (stale.size) {
        const list = [...stale.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, k]) => `${n} (${k})`).join(', ')
        rows.push(row('stale-assigned', 'warn', `${[...stale.values()].reduce((a, b) => a + b, 0)} assigned report(s) have had no activity for over ${STALE_DAYS} days: ${list}`, 'Nudge them (dashboard -> Who needs a nudge) or reassign.'))
      } else rows.push(row('stale-assigned', 'ok', `no assigned report has been silent for more than ${STALE_DAYS} days`))
    }

    // ---- undelivered replies awaiting attention ------------------------------------
    if (tables.has('case')) {
      const n = Number((await q(db, `SELECT COUNT(*) n FROM "case" WHERE tags LIKE '%delivery-failed%' AND status NOT IN ('closed','deleted')`))[0]?.n) || 0
      if (n) rows.push(row('undelivered', 'warn', `${n} open report(s) carry the delivery-failed tag: a reply was refused by WhatsApp (usually the 24-hour window)`, 'Open them in the inbox (tag delivery-failed); phone the reporter, or wait for them to message first.'))
    }
  } catch (e) {
    rows.push(row('roles-db', 'warn', `role checks could not finish (${String(e.message).slice(0, 120)})`))
  } finally { try { db.close?.() } catch { /* ignore */ } }
  return { rows }
}
