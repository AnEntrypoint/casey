import { createRouter, RouterRefusal } from './portal-store.js'
import { newWgKeyPair, allocateTunnelIp } from './portal-admin.js'
import { bootstrapScript, uplinkPassphraseFrom, UPLINK_PASSPHRASE_ENV } from './router-provisioning.js'

export async function provisionRouter(store, input, { bundle, base, env = process.env }) {
  const lte = input.uplink === 'lte'
  const uplinkPassphrase = lte ? '' : uplinkPassphraseFrom(env)
  if (!lte && !uplinkPassphrase) throw new RouterRefusal(`uplink passphrase is not configured: the ${UPLINK_PASSPHRASE_ENV} secret is missing or not 8 to 63 printable characters`, 503)
  const keys = newWgKeyPair()
  const tunnelIp = await allocateTunnelIp(store)
  const { row, token } = await createRouter(store, {
    name: input.name,
    routerId: input.routerId,
    routerIdPrefix: bundle.router_id_prefix,
    site: input.site,
    uplinkSsid: input.uplinkSsid,
    wgPublicKey: keys.pub,
    tunnelIp,
  })
  const bootstrap = bootstrapScript({
    bundle,
    base,
    token,
    routerId: row.router_id,
    uplink: lte ? 'lte' : 'wifi',
    uplinkSsid: input.uplinkSsid,
    uplinkPassphrase,
    wgPrivateKey: keys.priv,
  })
  return { row, token, bootstrap }
}
