#!/usr/bin/env node
// scan-deps.mjs -- supply-chain scan for the "HiddenSpawn"-class obfuscated
// dropper first found in thatcher's compromised commit 724e8bce (2026-08-09)
// and confirmed across 17+ separately-compromised repos in a follow-up
// org-wide sweep, each with a DIFFERENT C2 IP/wallet/decode routine but the
// SAME two structural properties. This scanner checks those two durable
// properties, not any one incident's specific literal values (which are
// trivial for an attacker to rotate and are intentionally NOT hardcoded
// here as the primary detector):
//
//   1. SIZE_RATIO -- a file whose byte size is wildly disproportionate to
//      its line count. The payload is appended as one extremely long line,
//      often preceded by whitespace padding to push it off-screen in a
//      normal editor/diff view; this survives any change to the payload's
//      own content because it is a property of HOW it hides.
//   2. ESCAPE_DENSITY -- a dense run (4+ in a row) of \uXXXX escapes that
//      decode to plain printable ASCII. Real code contains at most one or
//      two Unicode escapes in a row (a genuine non-ASCII literal); an
//      obfuscated identifier like require/spawn/child_process written this
//      way has no legitimate reason to exist. This generalizes across a
//      payload changing its target module names or its whole C2 mechanism,
//      as long as it still uses this specific evasion trick to dodge a
//      plain-text grep.
//
// A known-signature check (spawn('node','-e',...), an XOR-decode loop
// shape) is kept below as a fast bonus first pass against already-known
// variants -- it catches nothing new on its own, so it is scored as a
// SUPPLEMENT to (1)/(2), never a substitute for either. Windows Defender
// names the first confirmed variant Trojan:NPM/HiddenSpawn.IAF!MTB. Run via
// `npm run scan-deps` or as part of `casey doctor` -- unlike lint.mjs (which
// is deliberately dependency-free and skips node_modules/deps entirely), this
// walks node_modules on purpose: it exists specifically to inspect installed
// dependency content, the one thing lint.mjs's dependency-free design cannot
// see. See AGENTS.md's "thatcher / busybase chain" section for the incident.

import { readFileSync, readdirSync, statSync, lstatSync, realpathSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { filterGitignored } from './lib/git-ignored.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NODE_MODULES = join(ROOT, 'node_modules')

// 2026-08-14 incident: this same payload shape was found live on casey's own
// main branch in plugins/case-tools/plugin.js (commit c266c4e), a git-tracked
// source file -- not a dependency. The node_modules-only walk below caught
// nothing because it never looked at casey's own source tree. deps/ is
// excluded (separate submodule repos, own lint policy, per AGENTS.md);
// node_modules is walked separately by walk(NODE_MODULES) below, so it is
// excluded here too to avoid a redundant double-walk.
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

// Bytes-per-line above this on an ordinary hand-written JS/config file is
// suspicious. Legitimate minified/bundled/generated files are the known
// exception (a dist/ bundle is expected to be dense) -- this scanner cannot
// tell the difference on its own, so a hit here is a flag for human review,
// not an automatic verdict.
const SIZE_RATIO_THRESHOLD = 300

// 4+ consecutive \uXXXX escapes that decode to what looks like an
// identifier (letters/digits/underscore, mostly alphabetic) -- an
// obfuscated module name (require/spawn/child_process/http/etc) is always
// identifier-shaped. Requiring identifier shape, not merely "printable
// ASCII", is deliberate: a plain "printable ASCII" test also matched a real
// false positive (a CSS-selector-escape string like ",./:" in a legitimate
// tailwindcss file) that carries no obfuscated code, live-witnessed while
// verifying this scanner -- identifier-shape is the tighter, still-general
// condition that survives that class of false positive while still
// generalizing past any one incident's specific target names.
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

// Known-signature bonus check against the specific variants confirmed so
// far -- a fast first pass, never the only check (see header comment).
const HIDDEN_SPAWN_PAIR = /spawn\(\s*["']node["']\s*,\s*\[\s*["']-e["']/
const XOR_DECODE_SHAPE = /\[t\]\s*\^=\s*k\.charCodeAt|charCodeAt\(t%.{0,10}\)\s*;?\s*return\s+\w+\.toString\(/

// Hard bound: casey's node_modules now junctions in freddie's own ~220-package
// pnpm workspace (each with its OWN independently-resolved node_modules, per
// pnpm's isolated per-package linking strategy -- see scripts/link-deps.mjs),
// which can blow up file counts by orders of magnitude versus a flat npm
// install. visited (by REALPATH, not raw path) collapses the many junction/
// symlink paths pnpm's content-addressed .pnpm store creates that all point
// at the SAME physical directory, so that shared content is scanned once, not
// once per package that depends on it. MAX_FILES is a last-resort safety
// valve so a genuinely pathological tree still terminates in bounded time
// rather than hanging casey doctor / postinstall indefinitely; hitting it is
// reported (see the caller below), never silent.
const MAX_FILES = 60000
// node_modules/@freddie/* and node_modules/{acptoapi,thatcher,anentrypoint-design}
// are junctions straight into their own deps/<name> submodule checkouts
// (scripts/link-deps.mjs), never a real npm-managed install under casey's
// own node_modules -- each is a SEPARATE git repo with its own supply-chain
// scan responsibility (AGENTS.md: "deps/ excluded... separate submodule
// repos, own lint policy"). freddie's own deps/freddie is additionally a
// ~220-package pnpm workspace whose OWN node_modules (isolated per-package
// linking, not npm's flat hoisting) is orders of magnitude larger than a
// normal install and prohibitively slow to walk through Windows junction
// indirection -- confirmed live: an unbounded walk here did not finish in
// 90+ seconds. Skip every junction/symlink entry point under node_modules
// entirely rather than descending into a foreign repo's own dependency tree.
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
    // A junction/symlink at this level means "another repo's dependency
    // tree" (see header comment) -- do not descend past the link itself.
    let link
    try { link = lstatSync(p) } catch { continue }
    if (link.isSymbolicLink()) continue
    if (link.isDirectory()) walk(p, out, visited)
    else if (['.js', '.mjs', '.cjs'].includes(extname(p))) out.push(p)
  }
  return out
}

// A read can fail for two completely different reasons, and only one of them
// is evidence. Windows Defender refusing a file it already flagged is the
// signal this scanner exists for -- it is how the thatcher incident was first
// noticed, via npm's own extraction failing with errno -4094. A path that is
// simply too long to open, or a symlink loop, is a filesystem artifact and
// says nothing about the file's content: pnpm's workspace linking produces
// self-referential @freddie/cordis -> cordis-plugin-loader -> @freddie/cordis
// chains 1400+ characters deep, and those surfaced here as BLOCKED while the
// same files opened and read cleanly at their canonical shallow path.
//
// The distinction became load-bearing when postinstall started honouring this
// script's exit code (see scripts/postinstall.mjs): with the two conflated, a
// path-length artifact on someone's machine would fail their npm install and
// tell them to treat it as possible malware. A scanner that cries wolf is a
// scanner whose next real hit gets waved through, so the artifact class is
// reported and NOT failed, while every genuinely blocked read still fails.
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
  // escapeHits (dense \uXXXX runs decoding to ASCII) is the high-confidence
  // durable signal -- a legitimate minified/bundled file almost never
  // contains this, so it is a hard FAIL on its own. oversized alone is
  // common and expected on real minified/bundled dependencies (a UMD
  // build, an emoji-regex data table) -- live-witnessed against casey's
  // own node_modules: 18 real hits, all legitimate minified files, zero
  // with any escapeHits/known-signature corroboration. Downgrading
  // oversized-alone to a WARN (not a scan failure) is what keeps this
  // scanner usable in `postinstall`/`doctor` instead of blocking every
  // install on unavoidable, harmless dependency noise; oversized still
  // prints so a human can spot-check it, it just does not fail the run.
  const severity = escapeHits.length ? 'fail' : 'warn'
  return {
    path, blocked: false, severity,
    signals: { oversized, ratio, escapeHits: escapeHits.slice(0, 5), hasHiddenSpawn, hasXorDecode },
  }
}

// deps/freddie is now load-bearing (casey's own agent-loop/tool/LLM-seam
// plumbing runs through it, not just an optional composed project) --
// unlike the other three deps/* submodules, its own node_modules is
// deliberately EXCLUDED from the node_modules walk above (see that walk's
// own header comment: ~220-package pnpm workspace, orders of magnitude
// larger than a normal install, prohibitively slow to walk through Windows
// junction indirection). Its GIT-TRACKED SOURCE is not exempt from scanning
// just because its node_modules is -- walk it explicitly and boundedly here,
// the same git-tracked-only shape walkSource(ROOT) already uses for casey's
// own source, so freddie's source is never silently excluded entirely.
function walkFreddieSource(freddieRoot) {
  if (!existsSync(freddieRoot)) return []
  // freddie's own .gitignore lives in its own repo, so the ignore filter runs
  // against THAT root, not casey's.
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
