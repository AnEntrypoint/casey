// link-deps.mjs -- deterministically point every submodule-backed dependency's
// node_modules entry straight at its deps/<name> checkout, instead of trusting
// npm's own transitive-install/hoisting to place it correctly.
//
// Why this exists: a file:deps/<name> dependency spec (see package.json) tells
// npm to resolve that package from the local submodule checkout rather than the
// registry or a github: fetch -- but when this repo is ITSELF consumed as a
// file: dependency from a parent project (e.g. AnEntrypoint/uhh's
// "casey": "file:deps/casey"), a single `npm install` run from the parent's
// root has been observed to hoist a transitive file: dep (e.g. acptoapi) to the
// PARENT's top-level node_modules only, leaving this repo's own
// node_modules/<name> unpopulated until a second `npm install` is run directly
// inside this repo. Ordinary `require`/`import` resolution still finds the
// hoisted copy fine (Node's resolver walks up the directory tree), but any code
// here that builds a direct filesystem path against `node_modules/<name>`
// relative to this repo's own root (e.g. bin/casey-cli.mjs's timeout-coordination
// doctor check, which reads chain-machine.js's source directly rather than via
// require.resolve) misses the hoisted copy and silently degrades.
//
// This script removes the dependency on npm's hoisting decision entirely: for
// every `file:` dependency in package.json, it force-creates a direct symlink
// node_modules/<name> -> <that file: path>, unconditionally, so a single
// `npm install` (from here OR from a parent project two levels up) always
// leaves this repo internally self-resolving, no matter where the transitive
// install decided to hoist a shared copy.
//
// Run: node scripts/link-deps.mjs   (wired into postinstall)
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

let linked = 0
let alreadyCorrect = 0

for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
  const m = /^file:(.+)$/.exec(spec)
  if (!m) continue

  const targetAbs = resolve(repoRoot, m[1])
  if (!existsSync(targetAbs)) {
    // Submodule not checked out (bare clone, no `git submodule update --init`)
    // -- non-fatal, matches how doctor/lint already degrade to a skip.
    console.warn(`[link-deps] skip ${name}: ${targetAbs} does not exist (submodule not checked out?)`)
    continue
  }

  const linkPath = join(repoRoot, 'node_modules', name)
  const relTarget = relative(dirname(linkPath), targetAbs)

  const st = lstatSync(linkPath, { throwIfNoEntry: false })
  if (st) {
    if (st.isSymbolicLink()) {
      // readlink comparison, not realpath -- a stale relative link pointing at
      // the right absolute target under a different relative spelling is still
      // correct; only replace when it actually resolves elsewhere.
      const current = resolve(dirname(linkPath), readlinkSync(linkPath))
      if (current === targetAbs) { alreadyCorrect++; continue }
    }
    rmSync(linkPath, { recursive: true, force: true })
  }

  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(relTarget, linkPath, 'dir')
  console.log(`[link-deps] node_modules/${name} -> ${relTarget}`)
  linked++
}

console.log(`[link-deps] ${linked} linked, ${alreadyCorrect} already correct`)
