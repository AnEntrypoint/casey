// casey-sync-correlate-command.js -- `casey sync-correlate [--kind <kind>]`:
// the missing wire between `casey sync-import`/POST /api/sync/import and
// `src/sync/correlate-external.js`'s scoring engine. Before this command
// existed, a normalized-external-record file written to
// data/sync-import/<kind>.json (by either the CLI or the sync-api POST
// route) was never read back by anything -- findCandidatesFromManualImport
// and writeProposedLinks had exactly one caller each (each other's own
// module), so the correlation engine could score in isolation but never ran
// against real, live-imported data. EXTERNAL-SYNC.md's own "Wiring a real
// adapter later" step 4 ("Run the correlation engine ... against real
// fetched records") named an action with no command behind it.
//
// This command is that action: for each requested kind, load the cached
// sync-import file, score it against every real open case/contact via
// findCandidatesFromManualImport, and persist proposed links via
// writeProposedLinks -- so a human operator can then review them in the
// dashboard's cross-link panel (routes/external-links.js).
import path from 'node:path'
import { existsSync } from 'node:fs'
import { createCaseStore } from '../src/case-store.js'
import { findCandidatesFromManualImport, writeProposedLinks } from '../src/sync/correlate-external.js'
import { KINDS } from '../src/sync/adapters/base.js'
import { bold, dim, green, yellow, cyan, bad, say, closeAndExit } from './casey-cli-ui.js'

const SYSTEM = { id: 'casey-system', role: 'admin' }

function cacheFile(kind) {
  return path.join(process.cwd(), 'data', 'sync-import', `${kind}.json`)
}

export async function cmdSyncCorrelate({ flags }) {
  const kinds = flags.kind ? [String(flags.kind)] : KINDS
  const bad_kind = kinds.find(k => !KINDS.includes(k))
  if (bad_kind) { say(bad(`unknown --kind "${bad_kind}". one of: ${KINDS.join(', ')}`)); process.exit(2) }

  const store = createCaseStore()
  await store.init()

  console.log(bold('casey sync-correlate'))
  const cases = await store.listCases({}, { limit: 10000 })
  const contacts = await store.listContacts({ limit: 10000 })
  console.log(dim(`  scoring against ${cases.length} case(s) and ${contacts.length} contact(s)`))

  let totalCandidates = 0
  let totalWritten = 0
  for (const kind of kinds) {
    const file = cacheFile(kind)
    if (!existsSync(file)) {
      console.log(dim(`  ${kind}: no cached import (${file}) -- skipped`))
      continue
    }
    let candidates
    try {
      candidates = await findCandidatesFromManualImport({ file, kind, cases, contacts })
    } catch (e) {
      say(bad(`  ${kind}: ${e.message}`))
      continue
    }
    totalCandidates += candidates.length
    if (!candidates.length) {
      console.log(yellow(`  ${kind}: 0 candidate(s) at/above the confidence floor`))
      continue
    }
    const written = await writeProposedLinks(store, candidates, SYSTEM)
    totalWritten += written.length
    console.log(green(`  ${kind}: ${candidates.length} candidate(s), ${written.length} new proposed link(s)`))
    for (const c of candidates.slice(0, 5)) {
      console.log(cyan(`    ${c.local_entity}:${c.local_id} <-> ${c.external_ref} `) + dim(`(${c.match_basis}, confidence ${c.confidence})`))
    }
  }
  console.log(dim(`  total: ${totalCandidates} candidate(s), ${totalWritten} newly written proposed link(s)`))
  console.log(dim('  review proposed links in the dashboard cross-link panel before confirming any.'))
  await closeAndExit(store, 0)
}
