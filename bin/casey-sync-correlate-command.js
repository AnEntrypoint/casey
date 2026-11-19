import path from 'node:path'
import { existsSync } from 'node:fs'
import { createCaseStore } from '../src/case-store.js'
import { findCandidatesFromManualImport, writeProposedLinks } from '../src/sync/correlate-external.js'
import { KINDS } from '../src/sync/adapters/base.js'
import { bold, dim, green, yellow, cyan, bad, say, closeAndExit } from './casey-cli-ui.js'
import { caseyText } from '../src/deployment-text.js';

const SYSTEM = { id: 'casey-system', role: 'admin' }

function cacheFile(kind) {
  return path.join(process.cwd(), 'data', 'sync-import', `${kind}.json`)
}

export async function cmdSyncCorrelate({ flags }) {
  const kinds = flags.kind ? [String(flags.kind)] : KINDS
  const bad_kind = kinds.find(k => !KINDS.includes(k))
  if (bad_kind) { say(bad(caseyText("bin/casey-sync-correlate-command.js#w0", [bad_kind, KINDS.join(', ')]))); process.exit(2) }

  const store = createCaseStore()
  await store.init()

  console.log(bold(caseyText("bin/casey-sync-correlate-command.js#w1")))
  const cases = await store.listCases({}, { limit: 10000 })
  const contacts = await store.listContacts({ limit: 10000 })
  console.log(dim(caseyText("bin/casey-sync-correlate-command.js#w2", [cases.length, contacts.length])))

  let totalCandidates = 0
  let totalWritten = 0
  for (const kind of kinds) {
    const file = cacheFile(kind)
    if (!existsSync(file)) {
      console.log(dim(caseyText("bin/casey-sync-correlate-command.js#w3", [kind, file])))
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
      console.log(yellow(caseyText("bin/casey-sync-correlate-command.js#w4", [kind])))
      continue
    }
    const written = await writeProposedLinks(store, candidates, SYSTEM)
    totalWritten += written.length
    console.log(green(caseyText("bin/casey-sync-correlate-command.js#w5", [kind, candidates.length, written.length])))
    for (const c of candidates.slice(0, 5)) {
      console.log(cyan(`    ${c.local_entity}:${c.local_id} <-> ${c.external_ref} `) + dim(`(${c.match_basis}, confidence ${c.confidence})`))
    }
  }
  console.log(dim(caseyText("bin/casey-sync-correlate-command.js#w6", [totalCandidates, totalWritten])))
  console.log(dim(caseyText("bin/casey-sync-correlate-command.js#w7")))
  await closeAndExit(store, 0)
}
