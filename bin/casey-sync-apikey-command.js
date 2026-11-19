import { createCaseStore } from '../src/case-store.js'
import { createApiKey, listApiKeys, revokeApiKey } from '../src/sync/api-key-auth.js'
import { fmtTimeLocal } from '../src/format.js'
import { bold, dim, green, red, cyan, bad, say, closeAndExit } from './casey-cli-ui.js'
import { caseyText } from '../src/deployment-text.js';

const VALID_SCOPES = ['read:cases', 'read:links', 'write:links', 'import:records']

async function openStore() {
  const store = createCaseStore()
  await store.init()
  return store
}

function parseScopeFlag(raw) {
  if (raw === true || raw === undefined) return []
  return String(raw).split(',').map(s => s.trim()).filter(Boolean)
}

export async function cmdSyncApiKey({ flags, rest }) {
  const store = await openStore()
  const sub = rest[0]
  const positional = rest.slice(1).filter(a => !a.startsWith('--'))

  if (sub === 'create') {
    const label = flags.label
    if (!label || label === true) { say(bad(caseyText("bin/casey-sync-apikey-command.js#w0"))); await closeAndExit(store, 1) }
    const scopes = parseScopeFlag(flags.scope)
    if (!scopes.length) { say(bad(caseyText("bin/casey-sync-apikey-command.js#w1"))); say(dim(caseyText("bin/casey-sync-apikey-command.js#w2")) + VALID_SCOPES.map(cyan).join(', ')); await closeAndExit(store, 1) }
    const bad_scope = scopes.find(s => !VALID_SCOPES.includes(s))
    if (bad_scope) { say(bad(caseyText("bin/casey-sync-apikey-command.js#w3", [bad_scope]))); say(dim(caseyText("bin/casey-sync-apikey-command.js#w4")) + VALID_SCOPES.map(cyan).join(', ')); await closeAndExit(store, 1) }
    try {
      const { row, rawKey } = await createApiKey(store, { label, scopes })
      console.log(green(caseyText("bin/casey-sync-apikey-command.js#w5", [row.label, row.id])))
      console.log(dim('  scopes: ') + scopes.join(', '))
      console.log('')
      console.log(bold('  ' + rawKey))
      console.log('')
      console.log(red(caseyText("bin/casey-sync-apikey-command.js#w6")))
      console.log(red(caseyText("bin/casey-sync-apikey-command.js#w7")))
      await closeAndExit(store, 0)
    } catch (e) { say(bad(e.message)); await closeAndExit(store, 1) }
  }

  if (sub === 'list') {
    const keys = await listApiKeys(store)
    if (!keys.length) { console.log(caseyText("bin/casey-sync-apikey-command.js#w8")); console.log(dim('  run ' + cyan(caseyText("bin/casey-sync-apikey-command.js#w9")) + caseyText("bin/casey-sync-apikey-command.js#w10"))); await closeAndExit(store, 0) }
    for (const k of keys) {
      const status = k.disabled === '1' ? red('[revoked]') : green('[active]')
      const seen = k.last_used_at ? fmtTimeLocal(Math.floor(Date.parse(k.last_used_at) / 1000)) : null
      console.log(`${bold(k.label)}\t${k.id}\t${k.key_prefix}...\t${status}\t${k.scopes}\t${dim(seen || caseyText("bin/casey-sync-apikey-command.js#w11"))}`)
    }
    await closeAndExit(store, 0)
  }

  if (sub === 'revoke') {
    const id = positional[0]
    if (!id) { say(caseyText("bin/casey-sync-apikey-command.js#w12")); await closeAndExit(store, 1) }
    try {
      await revokeApiKey(store, id)
      console.log(green(caseyText("bin/casey-sync-apikey-command.js#w13", [id])))
      await closeAndExit(store, 0)
    } catch (e) { say(bad(e.message)); await closeAndExit(store, 1) }
  }

  if (sub) say(bad(caseyText("bin/casey-sync-apikey-command.js#w14", [sub])))
  say(caseyText("bin/casey-sync-apikey-command.js#w15"))
  await closeAndExit(store, 1)
}
