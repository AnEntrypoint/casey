// Bulk team registration and the training-roster rollout table. STAFF only:
// roles.js's roleGate is deny-by-default for a field login and neither path is on
// its allowlist, so an eco ranger or technician login gets 403 here.
//
//   POST /api/roles/import   { csv: "<text>" | rows: [{name,phone,role,association,smartphone}], dry_run?: bool }
//        dry_run defaults to TRUE: nothing is written unless the caller sends
//        dry_run:false. An operator may import eco rangers; a row for a
//        technician or operator needs an admin (contact-tiers.js grantableBy),
//        and is reported as an error row for anyone else, not applied.
//   GET  /api/roles/roster   the rollout table per association
//
// deps: store, authed, isAdmin, actingOperator
import { mountRoutes } from './register.js'
import { runImport, MAX_IMPORT_ROWS, MAX_IMPORT_CHARS } from '../../team-import.js'
import { rolloutTable } from '../../team-roster.js'

export function postRolesImport({ store, authed, isAdmin, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const b = req.body || {}
    try {
      const out = await runImport(store, { csv: b.csv, rows: b.rows }, { dryRun: b.dry_run !== false, isAdmin: isAdmin(req), by: actingOperator(req).id })
      res.json({ ok: true, ...out, limits: { max_rows: MAX_IMPORT_ROWS, max_chars: MAX_IMPORT_CHARS } })
    } catch (e) { res.status(400).json({ error: e.message }) }
  }
}

export function getRolesRoster({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    res.json(await rolloutTable(store))
  }
}

const ROUTES = [
  ['post', '/api/roles/import', postRolesImport, { raw: true }],
  ['get', '/api/roles/roster', getRolesRoster],
]

export function registerTeamImport(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
