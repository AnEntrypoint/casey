// casey-config-drift.js -- the `casey doctor` row that answers the one
// question nothing else in this repo asks: has the deployment's own config
// package fallen behind casey's base config?
//
// CASEY_CONFIG_DIR does not layer. `src/config-loader.js`'s resolveConfigDir()
// returns exactly ONE directory and loadDomainConfig() reads report-fields.yml
// + persona.cjs only from it; readThatcherFieldEnum() and case-store.js's
// CaseStore constructor each resolve thatcher.config.yml the same single-source
// way. There is no merge step and no base overlay anywhere in the chain, so a
// deployment config package is a whole-file FORK of casey's base by
// construction -- an entity, role, field or workflow stage added or renamed
// upstream here reaches that deployment only if a human copies it across.
// Nothing detected when that did not happen, and it has already gone wrong at
// least once: uhh's thatcher.config.yml sat at 28 case fields against casey's
// 29 for the life of the location_source addition, found by hand long after.
// This is the mechanism that would have said so on the next doctor run.
//
// It REPORTS, it never merges. A deployment's config is the authority for its
// own domain -- no upstream default may overwrite a deliberate local choice --
// so this compares SHAPE and names what is missing, leaving the decision (and
// the edit) to the deployer.
//
// What "shape" means differs per file, because the three files are not the
// same kind of artifact:
//
//   thatcher.config.yml  a SCHEMA. Both copies are expected to declare the
//                        same entities/roles/workflows; only leaf VALUES are
//                        domain vocabulary. So every key PATH is compared,
//                        values ignored. (uhh vs casey today: identical paths,
//                        three differing leaf values -- label, label_plural,
//                        case_type.options -- all deliberate.)
//   report-fields.yml    a VOCABULARY. fields[] is entirely domain-specific by
//                        design, so comparing it would be pure noise. The
//                        contract is the TOP-LEVEL key set that
//                        store/report-shape.js reads by name (entity_label,
//                        enquiry_headline_fields, tool_name, tool_description,
//                        fields, geo_fields, dashboard_ui).
//   persona.cjs          a NAMED-KEY contract. hooks/prompt.js reads each key
//                        by name, so the exported key set is the shape.
//
// Skipped entirely when CASEY_CONFIG_DIR is unset or points back at casey's
// own tree -- there is no second copy to have drifted.

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { load as yamlLoadRaw, YAML11_SCHEMA } from 'js-yaml'
import { ROOT, ok, bad, dim } from './casey-cli-ui.js'

// Same YAML 1.1 opt-in as src/config-loader.js: thatcher.config.yml's entity
// fields inject id/created_at/... via `<<: *system_fields`, and js-yaml v5's
// default schema no longer resolves merge keys, so without this every entity
// would appear to be missing those paths in BOTH copies at once.
const yamlLoad = (text) => yamlLoadRaw(text, { schema: YAML11_SCHEMA })
const require = createRequire(import.meta.url)

// Every leaf key path in a plain object tree. An array is a LEAF, never walked:
// case_type.options is domain vocabulary, and descending into it would report
// "casey has options.4 and you do not" for a deployment that simply names four
// case types instead of five.
function keyPaths(node, prefix, out) {
  out = out || []
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const k of Object.keys(node)) keyPaths(node[k], prefix ? `${prefix}.${k}` : k, out)
  } else if (prefix) {
    out.push(prefix)
  }
  return out
}

// One comparison, rendered. `missing` (in casey's base, absent from the
// deployment) is the drift this whole module exists for and counts as a
// problem; `extra` is a deliberate local addition and is reported dim, never
// as a fault -- a deployment is entitled to declare more than casey's demo does.
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

  // thatcher.config.yml. casey's base copy sits at the REPO ROOT, not in
  // config/default/ alongside its two siblings -- that is not tidiness, it is
  // the path case-store.js and config-loader.js's readThatcherFieldEnum both
  // fall back to (CASEY_CONFIG_DIR, else process.cwd()), which lands on the
  // repo root when casey is run from its own checkout. config/default/ is
  // therefore NOT a complete config dir: a deployer who copies it as a
  // template gets a directory casey boots against whose entity/workflow schema
  // silently comes from whatever cwd the process happens to have.
  problems += comparePair(
    'thatcher.config.yml',
    path.join(ROOT, 'thatcher.config.yml'),
    path.join(deployDir, 'thatcher.config.yml'),
    (p) => keyPaths(yamlLoad(readFileSync(p, 'utf8')), '', []),
    'copy the new schema key across, keeping this deployment\'s own leaf values',
  )

  // report-fields.yml -- top-level contract keys only (see header).
  problems += comparePair(
    'report-fields.yml',
    path.join(baseDefaultDir, 'report-fields.yml'),
    path.join(deployDir, 'report-fields.yml'),
    (p) => Object.keys(yamlLoad(readFileSync(p, 'utf8')) || {}),
    'store/report-shape.js reads these by name; an absent one silently derives as null/empty',
  )

  // persona.cjs -- the exported persona's own key set.
  problems += comparePair(
    'persona.cjs',
    path.join(baseDefaultDir, 'persona.cjs'),
    path.join(deployDir, 'persona.cjs'),
    (p) => { delete require.cache[require.resolve(p)]; return Object.keys(require(p).persona || {}) },
    'hooks/prompt.js reads these by name; an absent one drops that text from the system prompt',
  )

  return problems
}

// Read both sides through the same extractor and diff them. A missing or
// unreadable file degrades to one named dim line rather than throwing doctor
// over -- this row is a drift report, and a doctor that crashes reports nothing
// about the twenty checks after it.
function comparePair(label, basePath, deployPath, extract, hint) {
  if (!existsSync(basePath)) { console.log(dim(`  config drift: ${label} - casey has no base copy at ${basePath}, nothing to compare`)); return 0 }
  if (!existsSync(deployPath)) { console.log(dim(`  config drift: ${label} - deployment has no copy at ${deployPath}, nothing to compare`)); return 0 }
  let baseKeys, deployKeys
  try { baseKeys = extract(basePath) } catch (e) { console.log(dim(`  config drift: ${label} - could not read casey's base copy (${e.message})`)); return 0 }
  try { deployKeys = extract(deployPath) } catch (e) { console.log(dim(`  config drift: ${label} - could not read the deployment copy (${e.message})`)); return 0 }
  return reportShape(label, baseKeys, deployKeys, hint)
}
