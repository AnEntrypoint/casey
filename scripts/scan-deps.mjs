#!/usr/bin/env node
// scan-deps.mjs -- supply-chain scan for the obfuscated-dropper pattern found
// in thatcher's compromised commit 724e8bce (2026-08-09): a unicode-escaped
// require("http")/require("child_process") pair, an XOR-decode-and-eval
// payload fetch, and a detached self-respawning spawn -- Windows Defender
// names this class Trojan:NPM/HiddenSpawn.IAF!MTB. Static signature scan
// only, not a general malware scanner: it looks for the SPECIFIC obfuscation
// shape this incident used (heavy \uXXXX-escaped require() targets combined
// with spawn/eval), which a legitimate file has no reason to contain. Run via
// `npm run scan-deps` or as part of `casey doctor` -- unlike lint.mjs (which
// is deliberately dependency-free and skips node_modules/deps entirely), this
// walks node_modules on purpose: it exists specifically to inspect installed
// dependency content, the one thing lint.mjs's dependency-free design cannot
// see. See AGENTS.md's "thatcher / busybase chain" section for the incident.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NODE_MODULES = join(ROOT, 'node_modules')

// A legitimate file has no reason to spell out require() targets as unicode
// escapes -- this is specifically the evasion technique used to dodge a
// plain-text grep for "require(\"http\")"/"require(\"child_process\")" in an
// automated registry scanner. Five or more \uXXXX escapes clustered near a
// require(...) call, combined with a spawn+eval pairing, is the signature;
// a single stray \u in an otherwise normal file (e.g. a real unicode literal
// in a string constant) does not trip this.
const OBFUSCATED_REQUIRE = /require\(\s*"(?:\\u[0-9a-fA-F]{4}){3,}"\s*\)/
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
  const hasObfuscatedRequire = OBFUSCATED_REQUIRE.test(text)
  const hasHiddenSpawn = HIDDEN_SPAWN_PAIR.test(text)
  const hasXorDecode = XOR_DECODE_SHAPE.test(text)
  // Require at least two independent signals to flag -- a single hit alone
  // (e.g. one stray unicode-escaped require with no spawn/xor nearby) is not
  // enough to call it, matching the "no silent false-positive noise" spirit
  // of every other guardrail in this codebase.
  const signals = [hasObfuscatedRequire, hasHiddenSpawn, hasXorDecode].filter(Boolean).length
  if (signals >= 2) return { path, blocked: false, signals: { hasObfuscatedRequire, hasHiddenSpawn, hasXorDecode } }
  return null
}

function main() {
  if (!existsSync(NODE_MODULES)) {
    console.log('scan-deps: no node_modules present -- nothing to scan (run npm install first)')
    return 0
  }
  const files = walk(NODE_MODULES)
  const findings = []
  const blocked = []
  for (const f of files) {
    const r = scanFile(f)
    if (!r) continue
    if (r.blocked) blocked.push(r)
    else findings.push(r)
  }
  if (!findings.length && !blocked.length) {
    console.log(`scan-deps OK: ${files.length} files scanned across node_modules, no HiddenSpawn-pattern matches`)
    return 0
  }
  if (blocked.length) {
    console.log(`scan-deps: ${blocked.length} file(s) could not be read (a file your OS/AV already blocked reading is itself a strong signal -- treat as a finding, not a skip):`)
    for (const b of blocked) console.log(`  BLOCKED  ${b.path.replace(ROOT, '')}  (${b.reason})`)
  }
  if (findings.length) {
    console.log(`scan-deps: ${findings.length} file(s) matched the HiddenSpawn obfuscation signature:`)
    for (const f of findings) console.log(`  MATCH  ${f.path.replace(ROOT, '')}  ${JSON.stringify(f.signals)}`)
  }
  console.log('\nDo not run `npm install`/`casey up` again until every match above is confirmed malicious or a real false positive -- see AGENTS.md\'s "thatcher / busybase chain" section for the 2026-08-09 incident this guards against.')
  return 1
}

process.exit(main())
