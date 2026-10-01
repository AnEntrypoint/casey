

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

function loadPatchFile(absPath) {
  const parsed = yaml.load(readFileSync(absPath, 'utf8'), { schema: entryListSchema })

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

function hmrScopePatch() {
  if (!existsSync(FREDDIE_PACKAGES_DIR)) return []

  const roots = [
    'freddie-bundle',
    ...findSrcDirs(FREDDIE_PACKAGES_DIR).map(dir => path.relative(CASEY_ROOT, dir).split(path.sep).join('/')),
  ]

  return [{ id: 'hmr', config: { base: pathToFileURL(CASEY_ROOT + path.sep).href, root: roots } }]
}

function installHmrEscalation(ctx, log) {
  const hmr = ctx.get('hmr')

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

export async function bootCasey(opts) {
  const basePatchPath = resolveBundlePatchPath('@freddie/freddie-base')
  const caseyPatchPath = path.join(__dirname, 'cordis.patch.yml')

  const composePatches = () => [
    ...loadPatchFile(basePatchPath),
    ...loadPatchFile(caseyPatchPath),
    ...(opts.extraPluginsDir ? [{ insert: extraPluginRows(opts.extraPluginsDir) }] : []),
    ...hmrScopePatch(),
  ]
  const rootConfigPath = path.join(__dirname, 'cordis.yml')

  const ctx = await boot('casey', rootConfigPath, composePatches(), async (hostCtx) => {

    hostCtx.provide('caseyBootOptions', opts)
  })

  installHmrEscalation(ctx, opts.log ?? console)

  try {
    await watchUserPatches(ctx, { binName: 'casey', filename: caseyPatchPath, compose: composePatches })
  } catch (e) {
    ;(opts.log ?? console).warn?.('[casey] could not watch the Cordis composition file -- edits to it will NOT reach this worker until it restarts', { file: caseyPatchPath, error: e.message })
  }
  return ctx
}
