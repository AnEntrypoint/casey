import fs from 'node:fs'
import path from 'node:path'
import { load as yamlLoadRaw, YAML11_SCHEMA } from 'js-yaml'
import { validPassphrase, validSsid, validRouterId as routerIdOk, SITE_MAX } from './portal-store.js'
import { caseyText } from '../deployment-text.js';

export const BUNDLE_FILE = 'router-bundle.yml'
export const UPLINK_PASSPHRASE_ENV = 'CASEY_UPLINK_PASSPHRASE'
export const UPLINKS = Object.freeze(['wifi', 'lte'])
const WG_KEY = /^[A-Za-z0-9+/]{43}=$/
const NAME_MAX = 120
const CERT_DIR = 'certs'
const MANIFEST_KEYS = Object.freeze(['scripts', 'apply_script', 'seed', 'tls_files', 'root_cert', 'config_script', 'config_globals', 'tls_mode', 'log_prefix', 'bootstrap_title', 'router_id_prefix', 'ota_scripts', 'admin_interface', 'admin_listen_port'])
const GLOBAL_KEYS = Object.freeze(['base', 'token', 'router_id', 'host', 'tls'])
const DEVICE_NAME = /^[A-Za-z0-9_-]+$/

export const rosString = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\n/g, '\\n')}"`

export function normaliseBundle(raw) {
  for (const key of MANIFEST_KEYS) if (raw[key] === undefined) throw new Error(`${BUNDLE_FILE} is missing ${key}`)
  if (!Array.isArray(raw.scripts) || !raw.scripts.every(name => typeof name === 'string')) throw new Error(`${BUNDLE_FILE} scripts must be a list of file names`)
  if (!raw.scripts.includes(raw.apply_script)) throw new Error(`${BUNDLE_FILE} apply_script must be one of scripts`)
  if (!Array.isArray(raw.tls_files) || !raw.tls_files.every(name => typeof name === 'string')) throw new Error(`${BUNDLE_FILE} tls_files must be a list of file names`)
  if (typeof raw.root_cert?.file !== 'string' || typeof raw.root_cert?.common_name !== 'string' || !/^[0-9a-f]{64}$/.test(raw.root_cert?.sha256 ?? '')) throw new Error(`${BUNDLE_FILE} root_cert needs file, common_name and a 64-hex sha256`)
  for (const key of GLOBAL_KEYS) if (typeof raw.config_globals?.[key] !== 'string') throw new Error(`${BUNDLE_FILE} config_globals.${key} is missing`)
  if (!raw.ota_scripts || typeof raw.ota_scripts !== 'object' || Array.isArray(raw.ota_scripts) || !Object.values(raw.ota_scripts).every(name => typeof name === 'string' && DEVICE_NAME.test(name))) throw new Error(`${BUNDLE_FILE} ota_scripts must map each role to a device script name`)
  if (typeof raw.admin_interface !== 'string' || !DEVICE_NAME.test(raw.admin_interface)) throw new Error(`${BUNDLE_FILE} admin_interface must be a device interface name`)
  if (!Number.isInteger(raw.admin_listen_port) || raw.admin_listen_port < 1 || raw.admin_listen_port > 65535) throw new Error(`${BUNDLE_FILE} admin_listen_port must be a port number`)
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
    ota_scripts: Object.freeze({ ...raw.ota_scripts }),
    admin_interface: raw.admin_interface,
    admin_listen_port: raw.admin_listen_port,
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
  if (!name) return { error: caseyText("src/portal/router-provisioning.js#w0"), field: 'name' }
  if (name.length > NAME_MAX) return { error: caseyText("src/portal/router-provisioning.js#w1", [NAME_MAX]), field: 'name' }
  const site = typeof body.site === 'string' ? body.site.trim() : ''
  if (!site) return { error: caseyText("src/portal/router-provisioning.js#w2"), field: 'site' }
  if (site.length > SITE_MAX) return { error: caseyText("src/portal/router-provisioning.js#w3", [SITE_MAX]), field: 'site' }
  const routerId = body.router_id === undefined || body.router_id === '' ? undefined : body.router_id
  if (routerId !== undefined && !validRouterId(routerId)) return { error: caseyText("src/portal/router-provisioning.js#w4"), field: 'router_id' }
  const uplink = body.uplink === undefined || body.uplink === '' ? 'wifi' : body.uplink
  if (!UPLINKS.includes(uplink)) return { error: caseyText("src/portal/router-provisioning.js#w5"), field: 'uplink' }
  const uplinkSsid = typeof body.uplink_ssid === 'string' ? body.uplink_ssid : ''
  if (uplink === 'wifi' && !validSsid(uplinkSsid)) return { error: caseyText("src/portal/router-provisioning.js#w6"), field: 'uplink_ssid' }
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
  return caseyText("src/portal/router-provisioning.js#w7", [bundle.config_script, bundle.config_script, source])
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
  const adminIf = bundle.admin_interface
  const station = uplink === 'wifi'
    ? [caseyText("src/portal/router-provisioning.js#w9", [rosString(uplinkSsid), rosString(uplinkPassphrase)])]
    : []
  return [
    caseyText("src/portal/router-provisioning.js#w10", [bundle.bootstrap_title, routerId]),
    ...station,
    caseyText("src/portal/router-provisioning.js#w11", [iface, iface]),
    caseyText("src/portal/router-provisioning.js#w12", [iface, iface]),
    caseyText("src/portal/router-provisioning.js#w13", [iface]),
    caseyText("src/portal/router-provisioning.js#w14", [iface, log, iface]),
    caseyText("src/portal/router-provisioning.js#w15", [adminIf, adminIf, bundle.admin_listen_port, adminIf]),
    caseyText("src/portal/router-provisioning.js#w16", [adminIf, rosString(wgPrivateKey)]),
    `/tool fetch url="${bundleUrl}${certFile}" dst-path=${certFile} check-certificate=no`,
    `/certificate import file-name=${certFile} passphrase=""`,
    `:if ([/certificate get [find common-name="${certName}"] fingerprint] != "${certSha}") do={ :error "${log}: ${certName} fingerprint mismatch" }`,
    `/certificate set [find common-name="${certName}"] trusted=yes`,
    caseyText("src/portal/router-provisioning.js#w21", [certFile]),
    ...[...bundle.scripts, bundle.seed].map(fetchBundle),
    caseyText("src/portal/router-provisioning.js#w22", [bundle.seed]),
    caseyText("src/portal/router-provisioning.js#w23", [bundle.seed]),
    caseyText("src/portal/router-provisioning.js#w24", [bundle.apply_script]),
    ...bundle.scripts.map((file) => caseyText("src/portal/router-provisioning.js#w25", [file])),
    caseyText("src/portal/router-provisioning.js#w26", [log]),
    '',
  ].join('\n')
}
