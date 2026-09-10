// casey-sync-apikey-command.js -- `casey sync-apikey create|list|revoke`:
// provisions machine credentials for the /api/sync/* surface (see
// src/dashboard/routes/sync-api.js, src/sync/api-key-auth.js,
// EXTERNAL-SYNC.md). Its own module rather than a case in
// casey-store-commands.js, same reason as casey-sync-import-command.js: a
// self-contained credential-lifecycle command, mirroring `casey operators`'s
// shape one file over rather than growing that file's already-large
// add/list/disable/enable block with an unrelated credential class.
import { createCaseStore } from '../src/case-store.js'
import { createApiKey, listApiKeys, revokeApiKey } from '../src/sync/api-key-auth.js'
import { fmtTimeSAST } from '../src/format.js'
import { bold, dim, green, red, cyan, bad, say, closeAndExit } from './casey-cli-ui.js'

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
    if (!label || label === true) { say(bad('usage: casey sync-apikey create --label <name> --scope read:cases,read:links,...')); await closeAndExit(store, 1) }
    const scopes = parseScopeFlag(flags.scope)
    if (!scopes.length) { say(bad('--scope needs at least one value.')); say(dim('  one of: ') + VALID_SCOPES.map(cyan).join(', ')); await closeAndExit(store, 1) }
    const bad_scope = scopes.find(s => !VALID_SCOPES.includes(s))
    if (bad_scope) { say(bad(`unknown scope "${bad_scope}".`)); say(dim('  one of: ') + VALID_SCOPES.map(cyan).join(', ')); await closeAndExit(store, 1) }
    try {
      const { row, rawKey } = await createApiKey(store, { label, scopes })
      console.log(green(`created sync API key "${row.label}" (id: ${row.id})`))
      console.log(dim('  scopes: ') + scopes.join(', '))
      console.log('')
      console.log(bold('  ' + rawKey))
      console.log('')
      console.log(red('  This is the only time the full key is shown. It is not stored anywhere retrievable --'))
      console.log(red('  record it now, or generate a fresh one with `casey sync-apikey revoke` + `create` again.'))
      await closeAndExit(store, 0)
    } catch (e) { say(bad(e.message)); await closeAndExit(store, 1) }
  }

  if (sub === 'list') {
    const keys = await listApiKeys(store)
    if (!keys.length) { console.log('no sync API keys yet.'); console.log(dim('  run ' + cyan('casey sync-apikey create --label <name> --scope ...') + ' to create one.')); await closeAndExit(store, 0) }
    for (const k of keys) {
      const status = k.disabled === '1' ? red('[revoked]') : green('[active]')
      const seen = k.last_used_at ? fmtTimeSAST(Math.floor(Date.parse(k.last_used_at) / 1000)) : null
      console.log(`${bold(k.label)}\t${k.id}\t${k.key_prefix}...\t${status}\t${k.scopes}\t${dim(seen || 'never used')}`)
    }
    await closeAndExit(store, 0)
  }

  if (sub === 'revoke') {
    const id = positional[0]
    if (!id) { say('usage: casey sync-apikey revoke <id>'); await closeAndExit(store, 1) }
    try {
      await revokeApiKey(store, id)
      console.log(green(`sync API key ${id} revoked.`))
      await closeAndExit(store, 0)
    } catch (e) { say(bad(e.message)); await closeAndExit(store, 1) }
  }

  if (sub) say(bad(`casey sync-apikey has no "${sub}" subcommand.`))
  say('usage: casey sync-apikey <create|list|revoke> ...')
  await closeAndExit(store, 1)
}
