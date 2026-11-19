import { createCaseStore } from '../src/case-store.js'
import { deleteRouter, listRouters, rotateRouterToken } from '../src/portal/portal-store.js'
import { provisionRouter } from '../src/portal/router-lifecycle.js'
import { loadBundle, checkRouterInput } from '../src/portal/router-provisioning.js'
import { publicBase } from '../src/portal/portal-config.js'
import { fmtTimeLocal } from '../src/format.js'
import { bold, dim, green, red, cyan, bad, say, closeAndExit } from './casey-cli-ui.js'
import { caseyText } from '../src/deployment-text.js';

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
    if (!bundle) { say(bad(caseyText("bin/casey-router-command.js#w0"))); await closeAndExit(store, 1) }
    const checked = checkRouterInput({ name: flags.name, site: flags.site, router_id: flags.id, uplink: flags.uplink, uplink_ssid: flags['uplink-ssid'] })
    if (checked.error) { say(bad(caseyText("bin/casey-router-command.js#w1", [checked.error]))); await closeAndExit(store, 1) }
    try {
      const made = await provisionRouter(store, checked.value, { bundle, base: publicBase() })
      console.log(green(caseyText("bin/casey-router-command.js#w2", [made.row.name, made.row.router_id, made.row.site])))
      console.log('')
      console.log(bold(made.bootstrap))
      console.log(red(caseyText("bin/casey-router-command.js#w3")))
      await closeAndExit(store, 0)
    } catch (e) {
      say(bad(e.message))
      await closeAndExit(store, 1)
    }
  }

  if (sub === 'list') {
    const routers = await listRouters(store)
    if (!routers.length) { console.log(caseyText("bin/casey-router-command.js#w4")); console.log(dim('  run ' + cyan(caseyText("bin/casey-router-command.js#w5")) + caseyText("bin/casey-router-command.js#w6"))); await closeAndExit(store, 0) }
    for (const r of routers) {
      const seen = r.last_seen ? fmtTimeLocal(Math.floor(Date.parse(r.last_seen) / 1000)) : null
      console.log(`${bold(r.name)}\t${r.router_id}\t${dim(r.site || caseyText("bin/casey-router-command.js#w7"))}\t${dim(r.serial || caseyText("bin/casey-router-command.js#w8"))}\t${dim(seen || caseyText("bin/casey-router-command.js#w9"))}`)
    }
    await closeAndExit(store, 0)
  }

  if (sub === 'rotate-token') {
    const id = typeof flags.id === 'string' ? flags.id : ''
    if (!id) { say(bad(caseyText("bin/casey-router-command.js#w10"))); await closeAndExit(store, 1) }
    try {
      const { token } = await rotateRouterToken(store, id)
      console.log(green(caseyText("bin/casey-router-command.js#w11", [id])))
      console.log('')
      console.log(bold('  ' + token))
      console.log('')
      console.log(red(caseyText("bin/casey-router-command.js#w12")))
      console.log(red(caseyText("bin/casey-router-command.js#w13")))
      await closeAndExit(store, 0)
    } catch (e) { say(bad(e.message)); await closeAndExit(store, 1) }
  }

  if (sub === 'delete') {
    const id = typeof flags.id === 'string' ? flags.id : ''
    if (!id) { say(bad(caseyText("bin/casey-router-command.js#w14"))); await closeAndExit(store, 1) }
    try {
      const gone = await deleteRouter(store, id)
      console.log(green(caseyText("bin/casey-router-command.js#w15") + gone.name + '" (router_id: ' + gone.router_id + ')'))
      await closeAndExit(store, 0)
    } catch (e) { say(bad(e.message)); await closeAndExit(store, 1) }
  }

  if (sub) say(bad(caseyText("bin/casey-router-command.js#w16", [sub])))
  say(caseyText("bin/casey-router-command.js#w17"))
  await closeAndExit(store, 1)
}
