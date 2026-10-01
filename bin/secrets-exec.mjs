#!/usr/bin/env node
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { loadSecrets, SecretsError } from '../src/secrets/loader.js'
import { installLogScrub } from '../src/log-scrub.js'

const argv = process.argv.slice(2)
const dd = argv.indexOf('--')
const flags = dd === -1 ? argv : argv.slice(0, dd)
const cmd = dd === -1 ? [] : argv.slice(dd + 1)
const mi = flags.indexOf('--manifest')
const manifestPath = mi !== -1 ? flags[mi + 1] : process.env.UHH_SECRETS_MANIFEST
if (!manifestPath || !cmd.length) { console.error('usage: secrets-exec.mjs --manifest <file> -- <command> [args...]'); process.exit(64) }

installLogScrub()
let manifest
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) }
catch { console.error('secrets-exec: cannot read the manifest file'); process.exit(78) }

let loaded
try { loaded = await loadSecrets(manifest, { allowLatest: process.env.UHH_ALLOW_LATEST_SECRET === '1' }) }
catch (e) {
  console.error(`secrets-exec: ${e instanceof SecretsError ? e.message : 'secret loading failed'}; the command was not started`)
  process.exit(78)
}

const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env: { ...process.env, ...loaded.env } })
loaded = null
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)))
child.on('error', () => { console.error('secrets-exec: could not start the command'); process.exit(127) })
