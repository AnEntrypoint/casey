import { createCaseStore } from '../src/case-store.js'
import { createRouter, listRouters, rotateRouterToken } from '../src/portal/portal-store.js'
import { fmtTimeSAST } from '../src/format.js'
import { bold, dim, green, red, cyan, bad, say, closeAndExit } from './casey-cli-ui.js'

async function openStore() {
  const store = createCaseStore()
  await store.init()
  return store
}

export async function cmdRouter({ flags, rest }) {
  const store = await openStore()
  const sub = rest[0]

  if (sub === 'create') {
    const name = typeof flags.name === 'string' ? flags.name.trim() : ''
    if (!name) { say(bad('usage: casey router create --name <label> [--id <router_id>]')); await closeAndExit(store, 1) }
    try {
      const routerId = typeof flags.id === 'string' ? flags.id : undefined
      const { row, token } = await createRouter(store, { name, routerId })
      console.log(green(`created router "${row.name}" (router_id: ${row.router_id})`))
      console.log('')
      console.log(bold('  ' + token))
      console.log('')
      console.log(red('  This is the only time the token is shown. Only its SHA-256 hash is stored.'))
      console.log(red('  Put it on the router now; a lost token means creating a new router.'))
      await closeAndExit(store, 0)
    } catch (e) { say(bad(e.message)); await closeAndExit(store, 1) }
  }

  if (sub === 'list') {
    const routers = await listRouters(store)
    if (!routers.length) { console.log('no routers yet.'); console.log(dim('  run ' + cyan('casey router create --name <label>') + ' to add one.')); await closeAndExit(store, 0) }
    for (const r of routers) {
      const seen = r.last_seen ? fmtTimeSAST(Math.floor(Date.parse(r.last_seen) / 1000)) : null
      console.log(`${bold(r.name)}\t${r.router_id}\t${dim(seen || 'never seen')}`)
    }
    await closeAndExit(store, 0)
  }

  if (sub === 'rotate-token') {
    const id = typeof flags.id === 'string' ? flags.id : ''
    if (!id) { say(bad('usage: casey router rotate-token --id <router_id>')); await closeAndExit(store, 1) }
    try {
      const { token } = await rotateRouterToken(store, id)
      console.log(green(`rotated the token for router_id: ${id}`))
      console.log('')
      console.log(bold('  ' + token))
      console.log('')
      console.log(red('  The previous token is refused from now on. This is the only time the new token is shown.'))
      console.log(red('  Write it to the router before the router next calls home, with the deployer provisioning tool.'))
      await closeAndExit(store, 0)
    } catch (e) { say(bad(e.message)); await closeAndExit(store, 1) }
  }

  if (sub) say(bad(`casey router has no "${sub}" subcommand.`))
  say('usage: casey router <create|list|rotate-token> ...')
  await closeAndExit(store, 1)
}
