import { createHash } from 'node:crypto'
import { bundleText } from './router-provisioning.js'

export const OTA_SCRIPTS = Object.freeze([
  'uhh-usage',
  'uhh-register',
  'uhh-gate',
  'uhh-tls',
  'uhh-wa-refresh',
  'uhh-sync',
])

export const md5Hex = (text) => createHash('md5').update(text).digest('hex')

export function otaManifest({ bundle, tlsDir } = {}) {
  if (!bundle) return {}
  const manifest = {}
  for (const name of OTA_SCRIPTS) {
    const file = `${name}.rsc`
    if (file === bundle.apply_script || !bundle.scripts.includes(file)) continue
    const text = bundleText(file, { tlsDir, bundle })
    if (text === null) continue
    manifest[name] = md5Hex(text)
  }
  return manifest
}
