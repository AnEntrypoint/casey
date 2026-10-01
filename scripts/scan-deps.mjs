#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, lstatSync, realpathSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { filterGitignored } from './lib/git-ignored.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NODE_MODULES = join(ROOT, 'node_modules')

function walkSource(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'deps' || name.startsWith('.')) continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walkSource(p, out)
    else if (['.js', '.mjs', '.cjs'].includes(extname(p))) out.push(p)
  }
  return out
}

const SIZE_RATIO_THRESHOLD = 300

function findSuspiciousEscapes(text) {
  const hits = []
  const re = /(?:\\u[0-9a-fA-F]{4}){4,}/g
  let m
  while ((m = re.exec(text))) {
    const decoded = m[0].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    if (/^[A-Za-z][A-Za-z0-9_]{2,}$/.test(decoded)) hits.push(decoded)
  }
  return hits
}

const HIDDEN_SPAWN_PAIR = /spawn\(\s*["']node["']\s*,\s*\[\s*["']-e["']/
const XOR_DECODE_SHAPE = /\[t\]\s*\^=\s*k\.charCodeAt|charCodeAt\(t%.{0,10}\)\s*;?\s*return\s+\w+\.toString\(/

const MAX_FILES = 60000

function walk(dir, out = [], visited = new Set()) {
  if (out.length >= MAX_FILES) return out
  let real
  try { real = realpathSync(dir) } catch { return out }
  if (visited.has(real)) return out
  visited.add(real)
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (out.length >= MAX_FILES) break
    if (name === '.bin') continue
    const p = join(dir, name)

    let link
    try { link = lstatSync(p) } catch { continue }
    if (link.isSymbolicLink()) continue
    if (link.isDirectory()) walk(p, out, visited)
    else if (['.js', '.mjs', '.cjs'].includes(extname(p))) out.push(p)
  }
  return out
}

const PATH_ARTIFACT_CODES = new Set(['ENAMETOOLONG', 'ELOOP', 'ENOENT'])

function scanFile(path) {
  let text
  try { text = readFileSync(path, 'utf8') } catch (e) {
    if (PATH_ARTIFACT_CODES.has(e.code)) return { path, unreadable: true, reason: e.code }
    return { path, blocked: true, reason: e.message }
  }
  const lines = text.split('\n').length
  const bytes = Buffer.byteLength(text, 'utf8')
  const ratio = lines > 0 ? Math.round(bytes / lines) : 0
  const oversized = ratio > SIZE_RATIO_THRESHOLD
  const escapeHits = findSuspiciousEscapes(text)
  const hasHiddenSpawn = HIDDEN_SPAWN_PAIR.test(text)
  const hasXorDecode = XOR_DECODE_SHAPE.test(text)
  if (!oversized && !escapeHits.length) return null

  const severity = escapeHits.length ? 'fail' : 'warn'
  return {
    path, blocked: false, severity,
    signals: { oversized, ratio, escapeHits: escapeHits.slice(0, 5), hasHiddenSpawn, hasXorDecode },
  }
}

function walkFreddieSource(freddieRoot) {
  if (!existsSync(freddieRoot)) return []

  return filterGitignored(walkSource(freddieRoot), freddieRoot)
}

function main() {
  const sourceFiles = filterGitignored(walkSource(ROOT), ROOT)
  const freddieSourceFiles = walkFreddieSource(join(ROOT, 'deps', 'freddie'))
  const depFiles = existsSync(NODE_MODULES) ? walk(NODE_MODULES) : []
  const nodeModulesTruncated = depFiles.length >= MAX_FILES
  if (nodeModulesTruncated) {
    console.log(`scan-deps: node_modules walk hit its ${MAX_FILES}-file bound -- some content was not scanned (disclosed, not silent; see MAX_FILES in scripts/scan-deps.mjs)`)
  }
  if (!sourceFiles.length && !depFiles.length) {
    console.log('scan-deps: no node_modules present and no git-tracked source found -- nothing to scan (run npm install first)')
    return 0
  }
  const files = [...sourceFiles, ...freddieSourceFiles, ...depFiles]
  const findings = []
  const blocked = []
  const unreadable = []
  for (const f of files) {
    const r = scanFile(f)
    if (!r) continue
    if (r.unreadable) unreadable.push(r)
    else if (r.blocked) blocked.push(r)
    else findings.push(r)
  }
  const failing = findings.filter(f => f.severity === 'fail')
  const warnings = findings.filter(f => f.severity === 'warn')
  if (unreadable.length) {
    console.log(`scan-deps: ${unreadable.length} path(s) could not be opened for filesystem reasons (path length or a symlink loop, NOT a block) -- reported, not treated as a finding:`)
    for (const u of unreadable) console.log(`  UNREADABLE  ${u.reason}  ${u.path.length} chars  ${u.path.replace(ROOT, '').slice(0, 120)}...`)
  }
  if (!findings.length && !blocked.length) {
    console.log(`scan-deps OK: ${files.length} files scanned (${sourceFiles.length} own source + ${freddieSourceFiles.length} deps/freddie source + ${depFiles.length} in node_modules), no HiddenSpawn-pattern matches${unreadable.length ? ` (${unreadable.length} path artifact(s) skipped, listed above)` : ''}`)
    return 0
  }
  if (blocked.length) {
    console.log(`scan-deps: ${blocked.length} file(s) could not be read (a file your OS/AV already blocked reading is itself a strong signal -- treat as a finding, not a skip):`)
    for (const b of blocked) console.log(`  BLOCKED  ${b.path.replace(ROOT, '')}  (${b.reason})`)
  }
  if (failing.length) {
    console.log(`scan-deps: ${failing.length} file(s) matched the HiddenSpawn obfuscation signature (dense \\uXXXX-escaped ASCII -- high confidence, not expected in any legitimate file):`)
    for (const f of failing) console.log(`  FAIL  ${f.path.replace(ROOT, '')}  ${JSON.stringify(f.signals)}`)
  }
  if (warnings.length) {
    console.log(`scan-deps: ${warnings.length} file(s) are size/line-disproportionate but carry no escape-obfuscation signal -- likely legitimate minified/bundled files, listed for spot-check, not blocking:`)
    for (const w of warnings) console.log(`  WARN  ${w.path.replace(ROOT, '')}  ratio=${w.signals.ratio}`)
  }
  if (failing.length || blocked.length) {
    console.log('\nDo not run `npm install`/`casey up` again until every FAIL/BLOCKED above is confirmed malicious or a real false positive -- see AGENTS.md\'s "thatcher / busybase chain" section for the 2026-08-09 incident this guards against.')
    return 1
  }
  return 0
}

process.exit(main())
