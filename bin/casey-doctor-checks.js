// casey-doctor-checks.js -- the two doctor sections that look OUTSIDE the .env:
// what Meta and the public URL say about the WhatsApp channel, and whether the
// role model in the database is set up. Rendering only; the questions live in
// src/meta-probe.js and src/role-health.js, which return plain rows so they can
// be driven without a terminal.
//
// Both are read-only and both are counted like every other doctor row: a `fail`
// row is a problem (exit 1), a `warn` is printed and not counted, a `skip` is
// dim. Offline is a quiet single row, never a wall of red.

import path from 'node:path'
import { existsSync } from 'node:fs'
import { bold, dim, green, red, cyan, ok, bad, warn, hasCreds } from './casey-cli-ui.js'
import { createCaseStore } from '../src/case-store.js'

function render(rows) {
  let problems = 0
  for (const r of rows) {
    if (r.level === 'ok') console.log(ok(r.text))
    else if (r.level === 'fail') { console.log(bad(r.text)); problems++ }
    else if (r.level === 'warn') console.log(warn(r.text))
    else console.log(dim(`  ${r.text}`))
    if (r.fix && (r.level === 'fail' || r.level === 'warn')) console.log(dim(`      fix: ${r.fix}`))
  }
  return problems
}

// Meta + public callback. Skipped entirely when WhatsApp is not configured or
// --no-network / CASEY_DOCTOR_OFFLINE is set.
export async function runMetaChecks(flags = {}) {
  if (!hasCreds('whatsapp')) return 0
  if (flags['no-network'] || flags.offline || process.env.CASEY_DOCTOR_OFFLINE === '1') {
    console.log(dim('  Meta and public-URL checks skipped (--no-network)'))
    return 0
  }
  const { probeMeta } = await import('../src/meta-probe.js')
  console.log(bold('\nWhatsApp / Meta') + dim('  (read-only GETs; nothing is changed or sent)'))
  const res = await probeMeta({})
  if (res.skipped && !res.rows.length) return 0
  return render(res.rows)
}

// Role setup, read straight from the sqlite file with no store booted.
export async function runRoleChecks() {
  const dbFile = path.join(process.cwd(), 'data', 'db.sqlite')
  if (!existsSync(dbFile)) return 0
  const { checkRoleSetup } = await import('../src/role-health.js')
  let openStatuses = []
  try {
    const cfgFile = process.env.CASEY_CONFIG_DIR ? path.join(path.resolve(process.env.CASEY_CONFIG_DIR), 'thatcher.config.yml') : path.join(process.cwd(), 'thatcher.config.yml')
    const s = createCaseStore({ config: cfgFile }); s.validateConfig(); openStatuses = s.getOpenStatuses()
  } catch { /* the role checks fall back to "not closed" */ }
  console.log(bold('\nTeam and roles'))
  const { rows } = await checkRoleSetup(dbFile, { openStatuses })
  return render(rows)
}
