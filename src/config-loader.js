// config-loader.js -- resolves and loads casey's domain config package.
//
// CASEY_CONFIG_DIR (set by a deployer, e.g. the uhh package's bin script)
// points at a directory holding report-fields.yml, persona.js, and
// dashboard.yml. Absent, casey falls back to its own bundled generic-demo
// config under config/default/ -- so a bare `casey up` with no external
// config package always boots into a real, working (if generic) persona
// rather than failing closed.
//
// Deployer-controlled only: CASEY_CONFIG_DIR is an environment variable set
// by whoever starts the process, never a value a contact/end-user can
// influence through the conversation -- there is no contact-facing tool or
// code path that reads or writes this variable.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { load as yamlLoadRaw, YAML11_SCHEMA } from 'js-yaml'
// js-yaml v5 dropped YAML 1.1 merge-key (<<) resolution from its default
// schema -- thatcher.config.yml's entity fields rely on <<: *system_fields
// to inject id/created_at/created_by/updated_at, so every config load must
// opt back into YAML11_SCHEMA or those fields silently vanish.
const yamlLoad = (text) => yamlLoadRaw(text, { schema: YAML11_SCHEMA })

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_CONFIG_DIR = path.resolve(__dirname, '..', 'config', 'default')
// persona.cjs is loaded via createRequire (CJS-style synchronous require) so
// this whole loader can stay synchronous -- REPORT_KEYS/REPORT_KEY_ORDER in
// store/report-shape.js are consumed as module-level constants at import
// time by 6 other files, and a real dynamic `import()` cannot be awaited at
// that point without turning every one of those 6 files' own imports async.
// The .cjs extension (not .js) is required: this project's package.json sets
// "type": "module", so a bare .js file in a config dir with no package.json
// of its own would be parsed as ESM and createRequire's synchronous require
// would fail on the `export` syntax.
const require = createRequire(import.meta.url)

function resolveConfigDir() {
  const dir = process.env.CASEY_CONFIG_DIR
    ? path.resolve(process.env.CASEY_CONFIG_DIR)
    : DEFAULT_CONFIG_DIR
  if (!fs.existsSync(dir)) throw new Error(`casey config dir not found: ${dir}`)
  return dir
}

let cached = null

// Loads report-fields.yml + persona.js from the resolved config dir. Cached
// per-process (module-level singleton) -- config is deployer-set at process
// start, never changes mid-run, matching every other module-level env-derived
// constant in this codebase (see hooks/prompt.js's LOCATION_STALE_MS).
export function loadDomainConfig() {
  if (cached) return cached
  const dir = resolveConfigDir()

  const reportFieldsPath = path.join(dir, 'report-fields.yml')
  if (!fs.existsSync(reportFieldsPath)) throw new Error(`report-fields.yml not found in config dir: ${dir}`)
  const reportFields = yamlLoad(fs.readFileSync(reportFieldsPath, 'utf8'))
  if (!reportFields || !Array.isArray(reportFields.fields)) throw new Error(`report-fields.yml malformed: missing fields[] array (${reportFieldsPath})`)

  const personaPath = path.join(dir, 'persona.cjs')
  if (!fs.existsSync(personaPath)) throw new Error(`persona.cjs not found in config dir: ${dir}`)
  delete require.cache[require.resolve(personaPath)]
  const personaMod = require(personaPath)
  if (!personaMod.persona) throw new Error(`persona.cjs must export persona via module.exports (${personaPath})`)

  cached = { dir, reportFields, persona: personaMod.persona }
  return cached
}

// Test/reload hook -- clears the module-level cache. Not called in normal
// operation (config is process-lifetime-fixed by design); exists so a
// doctor-style revalidation can force a fresh read without a process restart.
export function _resetConfigCache() { cached = null }

export function configDirInUse() {
  return process.env.CASEY_CONFIG_DIR ? path.resolve(process.env.CASEY_CONFIG_DIR) : DEFAULT_CONFIG_DIR
}

let thatcherEnumCache = null

// Reads a thatcher.config.yml entity.field enum's options[] -- used to seed
// case-tools.js's tool-schema `enum` hints (case_type, priority) so the
// model is shown the ACTIVE domain's real values instead of a hardcoded
// literal that only matched one prior domain. Same CASEY_CONFIG_DIR > cwd
// precedence as case-store.js's own CaseStore constructor default (see
// there for why) -- this must resolve the SAME thatcher.config.yml the live
// store will load, or the tool-schema hint and the write-time enforcement
// (store().getFieldEnum(), the actual authority) would silently diverge.
// Best-effort: returns null on any read/parse failure so a caller can fall
// back to its own hardcoded default rather than crashing plugin load.
export function readThatcherFieldEnum(entity, field) {
  if (!thatcherEnumCache) {
    try {
      const dir = process.env.CASEY_CONFIG_DIR ? path.resolve(process.env.CASEY_CONFIG_DIR) : process.cwd()
      const cfgPath = path.join(dir, 'thatcher.config.yml')
      thatcherEnumCache = fs.existsSync(cfgPath) ? yamlLoad(fs.readFileSync(cfgPath, 'utf8')) : {}
    } catch { thatcherEnumCache = {} }
  }
  const options = thatcherEnumCache?.entities?.[entity]?.fields?.[field]?.options
  return Array.isArray(options) ? options : null
}
