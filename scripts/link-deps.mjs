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
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

let linked = 0
let alreadyCorrect = 0

function linkOne(name, targetAbs) {
  const linkPath = join(repoRoot, 'node_modules', name)
  const relTarget = relative(dirname(linkPath), targetAbs)
  const st = lstatSync(linkPath, { throwIfNoEntry: false })
  if (st) {
    if (st.isSymbolicLink()) {
      // Junction targets are stored absolute; a plain symlink's target may be
      // relative -- resolve against the link's own directory either way (a
      // no-op for an already-absolute junction target) before comparing.
      const current = resolve(dirname(linkPath), readlinkSync(linkPath))
      if (current === targetAbs) { alreadyCorrect++; return }
    }
    rmSync(linkPath, { recursive: true, force: true })
  }
  mkdirSync(dirname(linkPath), { recursive: true })
  // 'junction' (not 'dir'): a plain directory symlink requires elevated
  // privileges/Developer Mode on Windows (EPERM otherwise); an NTFS junction
  // needs neither and Node's fs.symlinkSync supports it as a distinct type.
  // junction targets must be absolute (not relative) -- unlike a symlink.
  symlinkSync(targetAbs, linkPath, 'junction')
  console.log(`[link-deps] node_modules/${name} -> ${relTarget}`)
  linked++
}

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
  linkOne(name, targetAbs)
}

// Every individual @freddie/freddie-* package casey (or freddie-base's own
// patch rows) imports by bare specifier -- freddie's new architecture is a
// pnpm workspace of ~200+ tiny packages (packages/<group>/<name>/), each with
// its OWN pnpm-resolved node_modules already correctly linking its siblings
// (confirmed live: `pnpm install` inside deps/freddie resolves the whole
// workspace; casey never runs pnpm itself). A plain `npm install` cannot
// resolve these packages' own `workspace:^` cross-deps at all -- casey does
// not need it to, since each package already carries its own working
// node_modules from freddie's own `pnpm install`. This block only needs to
// make each package's bare NAME resolvable as a top-level import from
// CASEY's code (freddie-bundle/boot.js, the case-tools/llm-acptoapi/platform
// plugins) -- scan every packages/<group>/<name>/package.json under
// deps/freddie and symlink node_modules/@freddie/<pkg-name> straight at it.
// packages/<group>/<name>/, vendor/<name>/ (the vendored @freddie/cordis
// runtime + cordis-plugin-* + schemastery), and native/<name>/ (native
// addons apps/cli depends on) each hold their own real @freddie/* package.json
// at a different nesting depth -- walk each root to a bounded depth (3
// levels covers every real layout observed) rather than hardcoding one
// group/name shape.
function scanFreddiePackages(rootDir, maxDepth) {
  const found = []
  function walk(dir, depth) {
    if (depth > maxDepth) return
    const pkgJsonPath = join(dir, 'package.json')
    if (existsSync(pkgJsonPath)) {
      let pkgName
      try { pkgName = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).name } catch { pkgName = null }
      if (pkgName && pkgName.startsWith('@freddie/')) { found.push([pkgName, dir]); return }
    }
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      walk(join(dir, entry.name), depth + 1)
    }
  }
  walk(rootDir, 0)
  return found
}

const freddieRoot = resolve(repoRoot, 'deps/freddie')
if (existsSync(freddieRoot)) {
  let freddieLinked = 0
  for (const sub of ['packages', 'vendor', 'native']) {
    const subDir = join(freddieRoot, sub)
    if (!existsSync(subDir)) continue
    for (const [pkgName, pkgDir] of scanFreddiePackages(subDir, 3)) {
      linkOne(pkgName, pkgDir)
      freddieLinked++
    }
  }
  console.log(`[link-deps] ${freddieLinked} @freddie/* packages scanned from deps/freddie`)
} else {
  console.warn('[link-deps] skip @freddie/* packages: deps/freddie does not exist (submodule not checked out?)')
}

console.log(`[link-deps] ${linked} linked, ${alreadyCorrect} already correct`)
