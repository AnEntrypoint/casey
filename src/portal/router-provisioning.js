import fs from 'node:fs'
import path from 'node:path'
import { load as yamlLoadRaw, YAML11_SCHEMA } from 'js-yaml'
import { validPassphrase, validSsid, validRouterId as routerIdOk, SITE_MAX } from './portal-store.js'

export const BUNDLE_FILE = 'router-bundle.yml'
export const UPLINK_PASSPHRASE_ENV = 'CASEY_UPLINK_PASSPHRASE'
export const UPLINKS = Object.freeze(['wifi', 'lte'])
const WG_KEY = /^[A-Za-z0-9+/]{43}=$/
const NAME_MAX = 120
const CERT_DIR = 'certs'
const MANIFEST_KEYS = Object.freeze(['scripts', 'apply_script', 'seed', 'tls_files', 'root_cert', 'config_script', 'config_globals', 'tls_mode', 'log_prefix', 'bootstrap_title', 'router_id_prefix'])
const GLOBAL_KEYS = Object.freeze(['base', 'token', 'router_id', 'host', 'tls'])

export const rosString = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\n/g, '\\n')}"`

export function normaliseBundle(raw) {
  for (const key of MANIFEST_KEYS) if (raw[key] === undefined) throw new Error(`${BUNDLE_FILE} is missing ${key}`)
  if (!Array.isArray(raw.scripts) || !raw.scripts.every(name => typeof name === 'string')) throw new Error(`${BUNDLE_FILE} scripts must be a list of file names`)
  if (!raw.scripts.includes(raw.apply_script)) throw new Error(`${BUNDLE_FILE} apply_script must be one of scripts`)
  if (!Array.isArray(raw.tls_files) || !raw.tls_files.every(name => typeof name === 'string')) throw new Error(`${BUNDLE_FILE} tls_files must be a list of file names`)
  if (typeof raw.root_cert?.file !== 'string' || typeof raw.root_cert?.common_name !== 'string' || !/^[0-9a-f]{64}$/.test(raw.root_cert?.sha256 ?? '')) throw new Error(`${BUNDLE_FILE} root_cert needs file, common_name and a 64-hex sha256`)
  for (const key of GLOBAL_KEYS) if (typeof raw.config_globals?.[key] !== 'string') throw new Error(`${BUNDLE_FILE} config_globals.${key} is missing`)
  return Object.freeze({
    scripts: Object.freeze([...raw.scripts]),
    apply_script: raw.apply_script,
    seed: raw.seed,
    tls_files: Object.freeze([...raw.tls_files]),
    root_cert: Object.freeze({ file: raw.root_cert.file, common_name: raw.root_cert.common_name, sha256: raw.root_cert.sha256 }),
    config_script: raw.config_script,
    config_globals: Object.freeze({ ...raw.config_globals }),
    tls_mode: raw.tls_mode,
    log_prefix: raw.log_prefix,
    bootstrap_title: raw.bootstrap_title,
    router_id_prefix: raw.router_id_prefix,
  })
}

export function loadBundle(env = process.env) {
  const dir = env.CASEY_CONFIG_DIR ? path.resolve(env.CASEY_CONFIG_DIR) : null
  const file = dir ? path.join(dir, BUNDLE_FILE) : null
  if (!file || !fs.existsSync(file)) return null
  return normaliseBundle(yamlLoadRaw(fs.readFileSync(file, 'utf8'), { schema: YAML11_SCHEMA }) || {})
}

const routerDir = (env) => (env.CASEY_ROUTER_DIR ? path.resolve(env.CASEY_ROUTER_DIR) : null)

const routerFile = (base, name, certFile) => {
  const candidates = name === certFile
    ? [path.join(base, name), path.join(base, CERT_DIR, name)]
    : [path.join(base, name)]
  for (const file of candidates) if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
  return null
}

export function bundleText(name, { tlsDir, dir, env = process.env, bundle = loadBundle(env) } = {}) {
  if (!bundle) return null
  if (bundle.tls_files.includes(name)) {
    const file = tlsDir ? path.join(tlsDir, name) : null
    return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  }
  if (name !== bundle.root_cert.file && !bundle.scripts.includes(name)) return null
  const base = dir ? path.resolve(dir) : routerDir(env)
  return base ? routerFile(base, name, bundle.root_cert.file) : null
}

export function uplinkInterface(uplink) {
  return uplink === 'lte' ? 'lte1' : 'wifi1'
}

export function checkRouterInput(body, validRouterId = routerIdOk) {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return { error: 'name is required', field: 'name' }
  if (name.length > NAME_MAX) return { error: `name must be at most ${NAME_MAX} characters`, field: 'name' }
  const site = typeof body.site === 'string' ? body.site.trim() : ''
  if (!site) return { error: 'site is required', field: 'site' }
  if (site.length > SITE_MAX) return { error: `site must be at most ${SITE_MAX} characters`, field: 'site' }
  const routerId = body.router_id === undefined || body.router_id === '' ? undefined : body.router_id
  if (routerId !== undefined && !validRouterId(routerId)) return { error: 'router_id may hold only letters, digits, - and _ (max 64)', field: 'router_id' }
  const uplink = body.uplink === undefined || body.uplink === '' ? 'wifi' : body.uplink
  if (!UPLINKS.includes(uplink)) return { error: 'uplink must be wifi or lte', field: 'uplink' }
  const uplinkSsid = typeof body.uplink_ssid === 'string' ? body.uplink_ssid : ''
  if (uplink === 'wifi' && !validSsid(uplinkSsid)) return { error: 'uplink_ssid must be 1 to 32 printable ASCII characters', field: 'uplink_ssid' }
  return { value: { name, site, routerId, uplink, uplinkSsid: uplink === 'wifi' ? uplinkSsid : '' } }
}

export function uplinkPassphraseFrom(env = process.env) {
  const value = env[UPLINK_PASSPHRASE_ENV]
  return validPassphrase(value) ? value : null
}

export function configSource({ bundle, base, token, routerId, host }) {
  const g = bundle.config_globals
  return [
    `:global ${g.base} ${rosString(base)}`,
    `:global ${g.token} ${rosString(token)}`,
    `:global ${g.router_id} ${rosString(routerId)}`,
    `:global ${g.host} ${rosString(host)}`,
    `:global ${g.tls} ${rosString(bundle.tls_mode)}`,
    '',
  ].join('\n')
}

export function seedScript({ bundle = loadBundle(), base, token, routerId }) {
  const url = new URL(base)
  const source = rosString(configSource({ bundle, base: url.origin, token, routerId, host: url.hostname }))
  return `:if ([:len [/system script find name=${bundle.config_script}]] = 0) do={ /system script add name=${bundle.config_script} owner=admin policy=ftp,read,write,policy,test,sensitive source=${source} }\n`
}

export function bootstrapScript({ bundle = loadBundle(), base, token, routerId, uplink = 'wifi', uplinkSsid = '', uplinkPassphrase = '', wgPrivateKey }) {
  if (!WG_KEY.test(String(wgPrivateKey))) throw new Error('bootstrapScript needs the router WireGuard private key')
  if (!UPLINKS.includes(uplink)) throw new Error(`bootstrapScript uplink must be one of ${UPLINKS.join(', ')}`)
  if (uplink === 'wifi' && (!validSsid(uplinkSsid) || !validPassphrase(uplinkPassphrase))) throw new Error('bootstrapScript needs the Wi-Fi uplink name and passphrase')
  const origin = new URL(base).origin
  const bundleUrl = `${origin}/api/router/bundle/`
  const auth = `http-header-field="Authorization: Bearer ${token}"`
  const fetchBundle = (file) => `/tool fetch url="${bundleUrl}${file}" dst-path=${file} check-certificate=${bundle.tls_mode} ${auth}`
  const { file: certFile, common_name: certName, sha256: certSha } = bundle.root_cert
  const log = bundle.log_prefix
  const iface = uplinkInterface(uplink)
  const station = uplink === 'wifi'
    ? [`/interface wifi set [find default-name=wifi1] configuration.mode=station configuration.ssid=${rosString(uplinkSsid)} security.authentication-types=wpa2-psk security.passphrase=${rosString(uplinkPassphrase)} disabled=no`]
    : []
  return [
    `# ${bundle.bootstrap_title} ${routerId}. Paste into the router terminal. Safe to run again.`,
    ...station,
    `:if ([:len [/interface bridge port find interface=${iface}]] > 0) do={ /interface bridge port remove [find interface=${iface}] }`,
    `:if ([:len [/ip dhcp-client find interface=${iface}]] = 0) do={ /ip dhcp-client add interface=${iface} disabled=no }`,
    `:local waited 0; :while ([:len [/ip address find interface=${iface}]] = 0 && $waited < 90) do={ :delay 1s; :set waited ($waited + 1) }`,
    `:if ([:len [/ip address find interface=${iface}]] = 0) do={ :error "${log}: no address on ${iface}, check the uplink" }`,
    `:if ([:len [/interface wireguard find name=uhh-admin]] = 0) do={ /interface wireguard add name=uhh-admin listen-port=13231 disabled=yes comment=uhh-admin }`,
    `/interface wireguard set [find name=uhh-admin] private-key=${rosString(wgPrivateKey)}`,
    `/tool fetch url="${bundleUrl}${certFile}" dst-path=${certFile} check-certificate=no`,
    `/certificate import file-name=${certFile} passphrase=""`,
    `:if ([/certificate get [find common-name="${certName}"] fingerprint] != "${certSha}") do={ :error "${log}: ${certName} fingerprint mismatch" }`,
    `/certificate set [find common-name="${certName}"] trusted=yes`,
    `/file remove [find name=${certFile}]`,
    ...[...bundle.scripts, bundle.seed].map(fetchBundle),
    `/import file-name=${bundle.seed}`,
    `/file remove [find name=${bundle.seed}]`,
    `/import file-name=${bundle.apply_script}`,
    ...bundle.scripts.map((file) => `/file remove [find name=${file}]`),
    `:log info "${log}: done"`,
    '',
  ].join('\n')
}
