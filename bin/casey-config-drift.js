import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { load as yamlLoadRaw, YAML11_SCHEMA } from 'js-yaml'
import { ROOT, ok, bad, dim } from './casey-cli-ui.js'
import { caseyText } from '../src/deployment-text.js';

const yamlLoad = (text) => yamlLoadRaw(text, { schema: YAML11_SCHEMA })
const require = createRequire(import.meta.url)

function keyPaths(node, prefix, out) {
  out = out || []
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const k of Object.keys(node)) keyPaths(node[k], prefix ? `${prefix}.${k}` : k, out)
  } else if (prefix) {
    out.push(prefix)
  }
  return out
}

function reportShape(label, baseKeys, deployKeys, hint) {
  const base = new Set(baseKeys), deploy = new Set(deployKeys)
  const missing = [...base].filter((k) => !deploy.has(k)).sort()
  const extra = [...deploy].filter((k) => !base.has(k)).sort()
  if (missing.length) {
    console.log(bad(caseyText("bin/casey-config-drift.js#w0", [label, missing.length, missing.join(', '), hint])))
  } else {
    console.log(ok(caseyText("bin/casey-config-drift.js#w1", [label, base.size])))
  }
  if (extra.length) console.log(dim(caseyText("bin/casey-config-drift.js#w2", [label, extra.length, extra.join(', ')])))
  return missing.length ? 1 : 0
}

export function checkConfigDrift() {
  if (!process.env.CASEY_CONFIG_DIR) {
    console.log(dim(caseyText("bin/casey-config-drift.js#w3")))
    return 0
  }
  const deployDir = path.resolve(process.env.CASEY_CONFIG_DIR)
  const baseDefaultDir = path.join(ROOT, 'config', 'default')
  if (deployDir === baseDefaultDir) {
    console.log(dim(caseyText("bin/casey-config-drift.js#w4")))
    return 0
  }
  let problems = 0

  problems += comparePair(
    'thatcher.config.yml',
    path.join(ROOT, 'thatcher.config.yml'),
    path.join(deployDir, 'thatcher.config.yml'),
    (p) => keyPaths(yamlLoad(readFileSync(p, 'utf8')), '', []),
    caseyText("bin/casey-config-drift.js#w5"),
  )

  problems += comparePair(
    'report-fields.yml',
    path.join(baseDefaultDir, 'report-fields.yml'),
    path.join(deployDir, 'report-fields.yml'),
    (p) => Object.keys(yamlLoad(readFileSync(p, 'utf8')) || {}),
    caseyText("bin/casey-config-drift.js#w6"),
  )

  problems += comparePair(
    'persona.cjs',
    path.join(baseDefaultDir, 'persona.cjs'),
    path.join(deployDir, 'persona.cjs'),
    (p) => { delete require.cache[require.resolve(p)]; return Object.keys(require(p).persona || {}) },
    caseyText("bin/casey-config-drift.js#w7"),
  )

  return problems
}

function comparePair(label, basePath, deployPath, extract, hint) {
  if (!existsSync(basePath)) { console.log(dim(caseyText("bin/casey-config-drift.js#w8", [label, basePath]))); return 0 }
  if (!existsSync(deployPath)) { console.log(dim(caseyText("bin/casey-config-drift.js#w9", [label, deployPath]))); return 0 }
  let baseKeys, deployKeys
  try { baseKeys = extract(basePath) } catch (e) { console.log(dim(caseyText("bin/casey-config-drift.js#w10", [label, e.message]))); return 0 }
  try { deployKeys = extract(deployPath) } catch (e) { console.log(dim(caseyText("bin/casey-config-drift.js#w11", [label, e.message]))); return 0 }
  return reportShape(label, baseKeys, deployKeys, hint)
}
