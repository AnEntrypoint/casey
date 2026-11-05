import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLE_DIR = fileURLToPath(new URL('./router-bundle/', import.meta.url))
export const ROUTER_SCRIPTS = Object.freeze(['apply.rsc', 'uhh-sync.rsc', 'uhh-gate.rsc', 'uhh-usage.rsc', 'uhh-wa-refresh.rsc', 'uhh-tls.rsc', 'uhh-register.rsc', 'uhh-admin.rsc'])
export const TLS_FILES = Object.freeze(['portal-cert.pem', 'portal-key.pem'])
export const ISRG_CERT = 'isrg-root-x2.pem'
export const SEED = 'seed.rsc'
export const ISRG_ROOT_X2_SHA256 = '69729b8e15a86efc177a57afb7171dfc64add28c2fca8cf1507e34453ccb1470'
const SSID = /^[\x20-\x7e]{1,32}$/
const PASSPHRASE = /^[\x20-\x7e]{8,63}$/
const NAME_MAX = 120
const TLS_MODE = 'yes-without-crl'

export const rosString = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\n/g, '\\n')}"`

export function bundleText(name, { tlsDir } = {}) {
  if (TLS_FILES.includes(name)) {
    const file = tlsDir ? path.join(tlsDir, name) : null
    return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  }
  if (name !== ISRG_CERT && !ROUTER_SCRIPTS.includes(name)) return null
  return fs.readFileSync(path.join(BUNDLE_DIR, name), 'utf8')
}

export function checkRouterInput(body, validRouterId) {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return { error: 'name is required', field: 'name' }
  if (name.length > NAME_MAX) return { error: `name must be at most ${NAME_MAX} characters`, field: 'name' }
  const routerId = body.router_id === undefined || body.router_id === '' ? undefined : body.router_id
  if (routerId !== undefined && !validRouterId(routerId)) return { error: 'router_id may hold only letters, digits, - and _ (max 64)', field: 'router_id' }
  const uplinkSsid = typeof body.uplink_ssid === 'string' ? body.uplink_ssid : ''
  if (!SSID.test(uplinkSsid)) return { error: 'uplink_ssid must be 1 to 32 printable ASCII characters', field: 'uplink_ssid' }
  const uplinkPassphrase = typeof body.uplink_passphrase === 'string' ? body.uplink_passphrase : ''
  if (!PASSPHRASE.test(uplinkPassphrase)) return { error: 'uplink_passphrase must be 8 to 63 printable ASCII characters', field: 'uplink_passphrase' }
  return { value: { name, routerId, uplinkSsid, uplinkPassphrase } }
}

export function configSource({ base, token, routerId, host }) {
  return [
    `:global uhhBase ${rosString(base)}`,
    `:global uhhToken ${rosString(token)}`,
    `:global uhhRouterId ${rosString(routerId)}`,
    `:global uhhHost ${rosString(host)}`,
    `:global uhhTls ${rosString(TLS_MODE)}`,
    '',
  ].join('\n')
}

export function seedScript({ base, token, routerId }) {
  const url = new URL(base)
  const source = rosString(configSource({ base: url.origin, token, routerId, host: url.hostname }))
  return `:if ([:len [/system script find name=uhh-config]] = 0) do={ /system script add name=uhh-config owner=admin policy=ftp,read,write,policy,test,sensitive source=${source} }\n`
}

export function bootstrapScript({ base, token, routerId, uplinkSsid, uplinkPassphrase }) {
  const origin = new URL(base).origin
  const bundle = `${origin}/api/router/bundle/`
  const auth = `http-header-field="Authorization: Bearer ${token}"`
  const fetchBundle = (file) => `/tool fetch url="${bundle}${file}" dst-path=${file} check-certificate=${TLS_MODE} ${auth}`
  return [
    `# Ubuntu Herd Health router ${routerId}. Paste into the router terminal. Safe to run again.`,
    `/interface wifi set [find default-name=wifi1] configuration.mode=station configuration.ssid=${rosString(uplinkSsid)} security.authentication-types=wpa2-psk security.passphrase=${rosString(uplinkPassphrase)} disabled=no`,
    `:if ([:len [/interface bridge port find interface=wifi1]] > 0) do={ /interface bridge port remove [find interface=wifi1] }`,
    `:if ([:len [/ip dhcp-client find interface=wifi1]] = 0) do={ /ip dhcp-client add interface=wifi1 disabled=no }`,
    `:local waited 0; :while ([:len [/ip address find interface=wifi1]] = 0 && $waited < 90) do={ :delay 1s; :set waited ($waited + 1) }`,
    `:if ([:len [/ip address find interface=wifi1]] = 0) do={ :error "uhh-bootstrap: no address on wifi1, check the uplink" }`,
    `/tool fetch url="${bundle}${ISRG_CERT}" dst-path=${ISRG_CERT} check-certificate=no`,
    `/certificate import file-name=${ISRG_CERT} passphrase=""`,
    `:if ([/certificate get [find common-name="ISRG Root X2"] fingerprint] != "${ISRG_ROOT_X2_SHA256}") do={ :error "uhh-bootstrap: ISRG Root X2 fingerprint mismatch" }`,
    `/certificate set [find common-name="ISRG Root X2"] trusted=yes`,
    `/file remove [find name=${ISRG_CERT}]`,
    ...[...ROUTER_SCRIPTS, SEED].map(fetchBundle),
    `/import file-name=${SEED}`,
    `/file remove [find name=${SEED}]`,
    `/import file-name=apply.rsc`,
    ...ROUTER_SCRIPTS.map((file) => `/file remove [find name=${file}]`),
    `:log info "uhh-bootstrap: done"`,
    '',
  ].join('\n')
}
