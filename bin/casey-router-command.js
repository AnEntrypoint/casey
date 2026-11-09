import { createCaseStore } from '../src/case-store.js'
import { deleteRouter, listRouters, rotateRouterToken } from '../src/portal/portal-store.js'
import { provisionRouter } from '../src/portal/router-lifecycle.js'
import { loadBundle, checkRouterInput } from '../src/portal/router-provisioning.js'
import { publicBase } from '../src/portal/portal-config.js'
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
    const bundle = loadBundle()
    if (!bundle) { say(bad('router provisioning is not configured (config/router-bundle.yml).')); await closeAndExit(store, 1) }
    const checked = checkRouterInput({ name: flags.name, site: flags.site, router_id: flags.id, uplink_ssid: flags['uplink-ssid'] })
    if (checked.error) { say(bad(`usage: casey router create --name <label> --site <site> --uplink-ssid <ssid> [--id <router_id>] (${checked.error})`)); await closeAndExit(store, 1) }
    try {
      const made = await provisionRouter(store, checked.value, { bundle, base: publicBase() })
      console.log(green(`created router "${made.row.name}" (router_id: ${made.row.router_id}, site: ${made.row.site})`))
      console.log('')
      console.log(bold(made.bootstrap))
      console.log(red('  The script holds the token and the router WireGuard key. It is shown only now; paste it into the router terminal.'))
      await closeAndExit(store, 0)
    } catch (e) {
      say(bad(e.message))
      await closeAndExit(store, 1)
    }
  }

  if (sub === 'list') {
    const routers = await listRouters(store)
    if (!routers.length) { console.log('no routers yet.'); console.log(dim('  run ' + cyan('casey router create --name <label>') + ' to add one.')); await closeAndExit(store, 0) }
    for (const r of routers) {
      const seen = r.last_seen ? fmtTimeSAST(Math.floor(Date.parse(r.last_seen) / 1000)) : null
      console.log(`${bold(r.name)}\t${r.router_id}\t${dim(r.site || 'no site')}\t${dim(r.serial || 'no serial')}\t${dim(seen || 'never seen')}`)
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

  if (sub === 'delete') {
    const id = typeof flags.id === 'string' ? flags.id : ''
    if (!id) { say(bad('usage: casey router delete --id <router_id>')); await closeAndExit(store, 1) }
    try {
      const gone = await deleteRouter(store, id)
      console.log(green('deleted router "' + gone.name + '" (router_id: ' + gone.router_id + ')'))
      await closeAndExit(store, 0)
    } catch (e) { say(bad(e.message)); await closeAndExit(store, 1) }
  }

  if (sub) say(bad(`casey router has no "${sub}" subcommand.`))
  say('usage: casey router <create|list|rotate-token|delete> ...')
  await closeAndExit(store, 1)
}
