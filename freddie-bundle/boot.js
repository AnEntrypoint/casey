// casey's own freddie boot entry point. Composes freddie's real
// @freddie/freddie-base bundle (LLM/agent-loop/session/tools plumbing) with
// casey's own three plugins (case-tools, llm-acptoapi, platform) into one
// flattened patch array, then calls freddie's real boot() -- the same shape
// apps/cli's profile-boot.js uses (a hand-rolled minimal version, since
// casey has no --profile launcher/pnpm-managed profile directory need: one
// fixed deployment, not a user picking between profiles).
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@freddie/cordis-plugin-include'
import { boot } from '@freddie/freddie-app-boot'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// freddie's own patch/entry-list YAML dialect allows a `!!js <expr>` scalar
// tag (an embedded JS expression node, evaluated later against a live `ctx`
// by the Include plugin itself -- see deps/freddie's
// packages/boot/app-boot/src/index.js's own userPatchesSchema/entryListSchema
// usage, both of which are just this same exported schema). A plain
// `yaml.load()` with no schema throws YAMLException on any real freddie
// bundle patch file (confirmed live: @freddie/freddie-base's own
// cordis.patch.yml uses it for e.g. `root: !!js freddieHomePath('sessions')`).
function loadPatchFile(absPath) {
  const parsed = yaml.load(readFileSync(absPath, 'utf8'), { schema: entryListSchema })
  // A patch file that is not a row list is a broken bundle, not an empty one.
  // Returning [] for it dropped whichever bundle's rows failed to parse and
  // booted a tree missing that bundle's whole contribution, with nothing said.
  if (!Array.isArray(parsed)) throw new Error(`bootCasey: ${absPath} did not parse to a patch-row list`)
  return parsed
}

function resolveBundlePatchPath(packageName) {
  const pkgJsonUrl = import.meta.resolve(`${packageName}/package.json`)
  const pkgJson = JSON.parse(readFileSync(fileURLToPath(pkgJsonUrl), 'utf8'))
  const patchRel = pkgJson.freddie?.bundle?.patch
  if (!patchRel) throw new Error(`bootCasey: ${packageName} has no freddie.bundle.patch in its package.json`)
  return path.resolve(path.dirname(fileURLToPath(pkgJsonUrl)), patchRel)
}

// A deployer's extra plugin directory (CASEY_EXTRA_PLUGINS_DIR, validated
// eagerly by src/casey.js) is scanned for plugin.js files, each inserted as
// its own additional patch row -- same {name, inject, apply(ctx)} Cordis
// contract as casey's own three plugins, so a deployer's tools register into
// the same global ctx.tools registry and are discoverable by
// run-turn.js's allowlist derivation the same way casey's own are.
function extraPluginRows(extraPluginsDir) {
  if (!extraPluginsDir) return []
  const rows = []
  for (const entry of readdirSync(extraPluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pluginFile = path.join(extraPluginsDir, entry.name, 'plugin.js')
    if (!existsSync(pluginFile)) continue
    rows.push({ id: `casey-extra-${entry.name}`, name: pathToFileURL(pluginFile).href })
  }
  return rows
}

/**
 * Boot freddie's real Cordis tree for casey: @freddie/freddie-base's own
 * patch rows (LLM/agent-loop/session/tool plumbing), then casey's own
 * (freddie-bundle/cordis.patch.yml -- case-tools/llm-acptoapi/platform),
 * then any deployer extra-plugin rows.
 * @param {{channels: string[], handleInbound: (platform, msg) => Promise<any>, extraPluginsDir?: string}} opts
 * @returns the root Cordis Context.
 */
export async function bootCasey(opts) {
  const basePatchPath = resolveBundlePatchPath('@freddie/freddie-base')
  const caseyPatchPath = path.join(__dirname, 'cordis.patch.yml')
  const patches = [
    ...loadPatchFile(basePatchPath),
    ...loadPatchFile(caseyPatchPath),
    ...(opts.extraPluginsDir ? [{ insert: extraPluginRows(opts.extraPluginsDir) }] : []),
  ]
  const rootConfigPath = path.join(__dirname, 'cordis.yml')

  const ctx = await boot('casey', rootConfigPath, patches, async (hostCtx) => {
    // Provide casey's own transport config before any plugin row activates,
    // so casey-platform's apply() reads it via ctx.get() at mount time. Called
    // unguarded: every adapter and both handler paths depend on it landing, so
    // a freddie that stopped offering provide() must fail here and name itself
    // rather than mount a tree whose transport quietly has no config.
    hostCtx.provide('caseyBootOptions', opts)
  })
  return ctx
}
