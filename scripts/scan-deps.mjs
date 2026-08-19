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

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

// Matches lint.mjs's filterGitignored: ask git which candidates it would
// ignore rather than hardcoding a skip list, dependency-free fallback intact.
function filterGitignored(paths) {
  try {
    const rel = paths.map((p) => p.slice(ROOT.length).replace(/\\/g, '/'))
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: ROOT, input: rel.join('\n'), stdio: ['pipe', 'pipe', 'pipe'],
    }).toString()
    const ignored = new Set(out.split('\n').filter(Boolean))
    return paths.filter((_, i) => !ignored.has(rel[i]))
  } catch (e) {
    if (e.status === 1 && e.stdout != null) {
      const ignored = new Set(String(e.stdout).split('\n').filter(Boolean))
      const rel = paths.map((p) => p.slice(ROOT.length).replace(/\\/g, '/'))
      return paths.filter((_, i) => !ignored.has(rel[i]))
    }
    return paths
  }
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

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (name === '.bin') continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (['.js', '.mjs', '.cjs'].includes(extname(p))) out.push(p)
  }
  return out
}

function scanFile(path) {
  let text
  try { text = readFileSync(path, 'utf8') } catch (e) {
    // A read failure here (e.g. Windows Defender blocking access to a file
    // it already flagged) IS ITSELF the finding -- surface it rather than
    // silently skip, since this exact symptom is how the thatcher incident
    // was first noticed (npm's own extraction failing with errno -4094).
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

function main() {
  const sourceFiles = filterGitignored(walkSource(ROOT))
  const depFiles = existsSync(NODE_MODULES) ? walk(NODE_MODULES) : []
  if (!sourceFiles.length && !depFiles.length) {
    console.log('scan-deps: no node_modules present and no git-tracked source found -- nothing to scan (run npm install first)')
    return 0
  }
  const files = [...sourceFiles, ...depFiles]
  const findings = []
  const blocked = []
  for (const f of files) {
    const r = scanFile(f)
    if (!r) continue
    if (r.blocked) blocked.push(r)
    else findings.push(r)
  }
  const failing = findings.filter(f => f.severity === 'fail')
  const warnings = findings.filter(f => f.severity === 'warn')
  if (!findings.length && !blocked.length) {
    console.log(`scan-deps OK: ${files.length} files scanned (${sourceFiles.length} own source + ${depFiles.length} in node_modules), no HiddenSpawn-pattern matches`)
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
  return 1
}

process.exit(main())
