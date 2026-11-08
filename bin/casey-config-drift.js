import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { load as yamlLoadRaw, YAML11_SCHEMA } from 'js-yaml'
import { ROOT, ok, bad, dim } from './casey-cli-ui.js'

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
    console.log(bad(`config drift: ${label} is missing ${missing.length} key(s) casey's base declares: ${missing.join(', ')} - ${hint}`))
  } else {
    console.log(ok(`config drift: ${label} carries every key casey's base declares (${base.size} checked)`))
  }
  if (extra.length) console.log(dim(`    ${label}: ${extra.length} deployment-only key(s) (deliberate local additions, not drift): ${extra.join(', ')}`))
  return missing.length ? 1 : 0
}

export function checkConfigDrift() {
  if (!process.env.CASEY_CONFIG_DIR) {
    console.log(dim('  config drift: CASEY_CONFIG_DIR unset - casey is running on its own base config, nothing to compare'))
    return 0
  }
  const deployDir = path.resolve(process.env.CASEY_CONFIG_DIR)
  const baseDefaultDir = path.join(ROOT, 'config', 'default')
  if (deployDir === baseDefaultDir) {
    console.log(dim('  config drift: CASEY_CONFIG_DIR points at casey\'s own config/default - nothing to compare'))
    return 0
  }
  let problems = 0

  problems += comparePair(
    'thatcher.config.yml',
    path.join(ROOT, 'thatcher.config.yml'),
    path.join(deployDir, 'thatcher.config.yml'),
    (p) => keyPaths(yamlLoad(readFileSync(p, 'utf8')), '', []),
    'copy the new schema key across, keeping this deployment\'s own leaf values',
  )

  problems += comparePair(
    'report-fields.yml',
    path.join(baseDefaultDir, 'report-fields.yml'),
    path.join(deployDir, 'report-fields.yml'),
    (p) => Object.keys(yamlLoad(readFileSync(p, 'utf8')) || {}),
    'store/report-shape.js reads these by name; an absent one silently derives as null/empty',
  )

  problems += comparePair(
    'persona.cjs',
    path.join(baseDefaultDir, 'persona.cjs'),
    path.join(deployDir, 'persona.cjs'),
    (p) => { delete require.cache[require.resolve(p)]; return Object.keys(require(p).persona || {}) },
    'hooks/prompt.js reads these by name; an absent one drops that text from the system prompt',
  )

  return problems
}

function comparePair(label, basePath, deployPath, extract, hint) {
  if (!existsSync(basePath)) { console.log(dim(`  config drift: ${label} - casey has no base copy at ${basePath}, nothing to compare`)); return 0 }
  if (!existsSync(deployPath)) { console.log(dim(`  config drift: ${label} - deployment has no copy at ${deployPath}, nothing to compare`)); return 0 }
  let baseKeys, deployKeys
  try { baseKeys = extract(basePath) } catch (e) { console.log(dim(`  config drift: ${label} - could not read casey's base copy (${e.message})`)); return 0 }
  try { deployKeys = extract(deployPath) } catch (e) { console.log(dim(`  config drift: ${label} - could not read the deployment copy (${e.message})`)); return 0 }
  return reportShape(label, baseKeys, deployKeys, hint)
}
