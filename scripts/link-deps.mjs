

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

      const current = resolve(dirname(linkPath), readlinkSync(linkPath))
      if (current === targetAbs) { alreadyCorrect++; return }
    }
    rmSync(linkPath, { recursive: true, force: true })
  }
  mkdirSync(dirname(linkPath), { recursive: true })

  symlinkSync(targetAbs, linkPath, 'junction')
  console.log(`[link-deps] node_modules/${name} -> ${relTarget}`)
  linked++
}

for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
  const m = /^file:(.+)$/.exec(spec)
  if (!m) continue

  const targetAbs = resolve(repoRoot, m[1])
  if (!existsSync(targetAbs)) {

    console.warn(`[link-deps] skip ${name}: ${targetAbs} does not exist (submodule not checked out?)`)
    continue
  }
  linkOne(name, targetAbs)
}

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
  for (const sub of ['packages', 'vendor', 'native', 'framework']) {
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
