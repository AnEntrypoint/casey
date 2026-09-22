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
import { boot, watchUserPatches } from '@freddie/freddie-app-boot'
import { WORKER_MSG, ipcSend } from '../src/supervisor-ipc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CASEY_ROOT = path.resolve(__dirname, '..')
const FREDDIE_PACKAGES_DIR = path.join(CASEY_ROOT, 'deps', 'freddie', 'packages')

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

// Every `src` directory under `root`, node_modules never entered. The explicit
// list is what makes Cordis-level HMR viable over freddie's tree at all: its
// packages/ nests 220+ separate node_modules, and a chokidar `ignored` glob
// still has to readdir into each one to test its children (freddie's own
// apps/cli/src/profile-boot.js measured that at 30s+ and still not ready,
// versus ~1s watching the real src/ directories directly).
function findSrcDirs(root) {
  const dirs = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const full = path.join(root, entry.name)
    if (entry.name === 'src') { dirs.push(full); continue }
    dirs.push(...findSrcDirs(full))
  }
  return dirs
}

// Scope the `hmr` row freddie-base's own patch already carries. Its shipped
// `root: ['.']` resolves against ctx.baseUrl -- this directory -- so untouched
// it hot-swaps only freddie-bundle's own three plugins and nothing of freddie's
// own ~216 plugin packages, which is the whole tree a freddie edit lands in.
//
// framework/ is deliberately NOT a root, and that boundary is the load-bearing
// part of this config. cordis, the loader, the include and HMR itself ARE the
// runtime the live tree is made of, and every mounted plugin holds
// framework/cordis's Context/Service classes by identity. Re-evaluating those
// modules under a running tree hands the reloaded plugins a SECOND class
// identity while the root context keeps the first -- a tree that reports a
// successful reload and is quietly broken. packages/boot/ (app-boot) and
// casey's own src/ are the other side of the same line for a different reason:
// they sit in bin/worker.js's static import graph, so HMR can clear their
// module cache but nothing re-imports them and the live references stay stale.
// All three stay with the supervisor's full drain-and-respawn restart
// (src/supervisor-reload-watch.js), the only mechanism that replaces them
// coherently. installHmrEscalation below is the net for every case HMR turns
// out not to cover.
function hmrScopePatch() {
  if (!existsSync(FREDDIE_PACKAGES_DIR)) return []
  // This whole directory, not just its src/: boot.js itself is one of the two
  // files a composition change lands in, and it is an external (bin/worker.js
  // imports it), so a save here cannot hot-swap -- but with the directory
  // watched it produces a zero-plugin reload that escalates to a real restart,
  // instead of the nothing-at-all it gets from a root that names only src/.
  const roots = [
    'freddie-bundle',
    ...findSrcDirs(FREDDIE_PACKAGES_DIR).map(dir => path.relative(CASEY_ROOT, dir).split(path.sep).join('/')),
  ]
  // `base` is read as `new URL(config.base, ctx.baseUrl)` inside the plugin, so
  // a bare filesystem path throws ERR_INVALID_URL_SCHEME -- it must be the
  // file:// form. `ignored` is left unset so the plugin's own schema default
  // (node_modules, dotfiles, cache, data) applies.
  return [{ id: 'hmr', config: { base: pathToFileURL(CASEY_ROOT + path.sep).href, root: roots } }]
}

// HMR decides per pass what it can actually swap, and two of its outcomes mean
// the edit did NOT reach the running process: `failed` (the re-import or the
// re-register threw, and it rolled the old plugins back) and a `reload` that
// names zero plugins (the changed module's cache was cleared but no plugin
// entry depends on it, so every live reference still holds the old code). Both
// are silent by construction -- the developer sees a save and no behaviour
// change. Escalate them to the supervisor's real restart, which always works,
// and log every decision either way: nothing else in casey's log says whether a
// save hot-swapped or did nothing.
function installHmrEscalation(ctx, log) {
  const hmr = ctx.get('hmr')
  // Cordis's own ctx.logger goes nowhere here: nothing in casey's composition
  // mounts framework/logger-console, which is exactly why HMR has been running
  // silently in this tree. console is the worker's own stdout, the same stream
  // casey's logger and the supervisor already write to.
  if (hmr === undefined) {
    log?.warn?.('[casey] Cordis HMR is not mounted -- freddie and freddie-bundle plugin edits will only reload via a full worker restart')
    return
  }
  ctx.on('hmr/journal', (row) => {
    const escalate = row.kind === 'failed' || (row.kind === 'reload' && (row.plugins?.length ?? 0) === 0)
    log?.info?.('[casey] hmr', { kind: row.kind, plugins: row.plugins?.length ?? 0, reason: row.reason ?? null, escalate })
    if (escalate) ipcSend(process, WORKER_MSG.RELOAD_REQUEST, { reason: `hmr ${row.kind}` })
  })
}

/**
 * Boot freddie's real Cordis tree for casey: @freddie/freddie-base's own
 * patch rows (LLM/agent-loop/session/tool plumbing), then casey's own
 * (freddie-bundle/cordis.patch.yml -- case-tools/llm-acptoapi/platform),
 * then any deployer extra-plugin rows, then the HMR scope over both trees.
 * @param {{channels: string[], handleInbound: (platform, msg) => Promise<any>, extraPluginsDir?: string, log?: object}} opts -- `log` defaults to console
 * @returns the root Cordis Context.
 */
export async function bootCasey(opts) {
  const basePatchPath = resolveBundlePatchPath('@freddie/freddie-base')
  const caseyPatchPath = path.join(__dirname, 'cordis.patch.yml')
  // Re-read on every call, never once into a shared array: the include pushes
  // `insert` rows into the mounted tree BY REFERENCE and later id-targeted
  // patches mutate those objects in place, so a reapply that reused parsed rows
  // would bake the previous generation's overrides into the bundle defaults.
  // Every row here is freshly constructed per call, which is what makes the
  // patch-file watcher below able to reapply the whole stack.
  const composePatches = () => [
    ...loadPatchFile(basePatchPath),
    ...loadPatchFile(caseyPatchPath),
    ...(opts.extraPluginsDir ? [{ insert: extraPluginRows(opts.extraPluginsDir) }] : []),
    ...hmrScopePatch(),
  ]
  const rootConfigPath = path.join(__dirname, 'cordis.yml')

  const ctx = await boot('casey', rootConfigPath, composePatches(), async (hostCtx) => {
    // Provide casey's own transport config before any plugin row activates,
    // so casey-platform's apply() reads it via ctx.get() at mount time. Called
    // unguarded: every adapter and both handler paths depend on it landing, so
    // a freddie that stopped offering provide() must fail here and name itself
    // rather than mount a tree whose transport quietly has no config.
    hostCtx.provide('caseyBootOptions', opts)
  })

  installHmrEscalation(ctx, opts.log ?? console)

  // The composition file itself. Editing cordis.patch.yml -- adding a plugin
  // row, flipping a config value, disabling a row -- changed nothing on a
  // running worker: the patch array is read once, right above, and neither the
  // supervisor's watch list (casey's src/ plus freddie's framework/) nor HMR's
  // module roots cover a .yml file. watchUserPatches is freddie's own mechanism
  // for exactly this (apps/cli/src/profile-boot.js uses it for the profile and
  // home patch layers): it registers an exact-path watch on HMR and reapplies
  // the whole recomposed patch stack to the live root Include transactionally.
  // A watcher that cannot arm is a lost dev convenience, not a bad deployment,
  // so it warns -- and says what the warning costs, because nothing else will.
  try {
    await watchUserPatches(ctx, { binName: 'casey', filename: caseyPatchPath, compose: composePatches })
  } catch (e) {
    ;(opts.log ?? console).warn?.('[casey] could not watch the Cordis composition file -- edits to it will NOT reach this worker until it restarts', { file: caseyPatchPath, error: e.message })
  }
  return ctx
}
