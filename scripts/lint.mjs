#!/usr/bin/env node
// casey lint: dependency-free preflight that runs WITHOUT any install at all
// (freddie/thatcher are npm `latest`; anentrypoint-design is still a `file:../`
// sibling). Validates what can be checked from a bare clone -- JS syntax, YAML
// config, package.json, and the ASCII-only source convention from AGENTS.md.
// Exits nonzero on any failure so CI and humans share one gate. Run:
// node scripts/lint.mjs (or npm run lint).

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const fails = []
const note = (m) => fails.push(m)

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const all = walk(ROOT)
const jsFiles = all.filter((p) => ['.js', '.mjs'].includes(extname(p)))

// 1. JS syntax: node --check every JS/MJS file.
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  } catch (e) {
    note(`syntax: ${f.replace(ROOT, '')}\n${String(e.stderr || e).trim()}`)
  }
}

// 2. package.json parses and declares the casey bin + test script.
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  if (pkg.type !== 'module') note('package.json: expected "type":"module"')
  if (!pkg.scripts || !pkg.scripts.test) note('package.json: missing scripts.test')
  if (!pkg.bin || !pkg.bin.casey) note('package.json: missing bin.casey')
} catch (e) {
  note(`package.json: ${String(e.message || e)}`)
}

// 3. thatcher.config.yml parses as YAML (js-yaml is a dependency; degrade
//    gracefully to a presence check when it is not installed yet).
try {
  const yaml = await import('js-yaml').then((m) => m.default || m).catch(() => null)
  const raw = readFileSync(join(ROOT, 'thatcher.config.yml'), 'utf8')
  if (yaml) {
    const doc = yaml.load(raw)
    if (!doc || typeof doc !== 'object') note('thatcher.config.yml: did not parse to an object')
  } else if (!raw.trim()) {
    note('thatcher.config.yml: empty')
  }
} catch (e) {
  note(`thatcher.config.yml: ${String(e.message || e)}`)
}

// 4. ASCII-only source convention (AGENTS.md). Code operators and Unicode
//    regex character classes are functional, not decorative, so we only flag
//    bytes outside printable ASCII that are NOT inside a regex range or a
//    string literal we deliberately allow. To stay simple and avoid false
//    positives we flag decorative-symbol code points (arrows, box drawing,
//    bullets, checkmarks, emoji) explicitly rather than all non-ASCII. Ranges
//    are numeric code points (no glyphs in this source) so the linter does not
//    trip on itself. Covered: arrows U+2190-21FF, box/blocks/geometric/symbols/
//    dingbats U+2500-27BF, supplemental arrows/symbols U+2B00-2BFF, emoji.
function decorative(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.codePointAt(i)
    if (
      (c >= 0x2190 && c <= 0x21ff) ||
      (c >= 0x2500 && c <= 0x27bf) ||
      (c >= 0x2b00 && c <= 0x2bff) ||
      (c >= 0x1f000 && c <= 0x1faff)
    ) return c
  }
  return 0
}
for (const f of all) {
  if (!['.js', '.mjs', '.md', '.yml', '.yaml', '.json'].includes(extname(f))) continue
  const lines = readFileSync(f, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const c = decorative(line)
    if (c) {
      const hex = 'U+' + c.toString(16).toUpperCase().padStart(4, '0')
      note(`ascii: ${f.replace(ROOT, '')}:${i + 1} decorative glyph ${hex} -- use ASCII (-> , - , [x]/[ ])`)
    }
  })
}

// Pure-agent invariant: the deterministic text-processing layer was removed. The
// inbound handler + top-level assembly must NOT re-import intent.js/places.js/
// extract.js (all deleted); the LLM classifies + routes + answers + RECORDS THE
// REPORT via the case tools -- casey does no deterministic text processing. This
// grep-gate keeps a future edit from quietly reintroducing keyword routing or a
// keyword capture floor.
const NO_HARDCODE_IMPORT = ['src/gateway-hooks.js', 'src/casey.js']
for (const rel of NO_HARDCODE_IMPORT) {
  let src = ''
  try { src = readFileSync(join(ROOT, rel), 'utf8') } catch { continue }
  if (/from\s+['"][^'"]*\b(intent|places|extract)\.js['"]/.test(src) || /import\(\s*['"][^'"]*\b(intent|places|extract)\.js['"]/.test(src)) {
    note(`pure-llm: ${rel} imports intent.js/places.js/extract.js -- casey does no deterministic text processing; the LLM classifies, routes, answers, and records the report via the case tools`)
  }
}

// No-stub/mock invariant: MockAdapter, stubLLM, CASEY_STUB_LLM, and the sim/*
// test-double modules were removed entirely (real freddie + real thatcher +
// a real LLM provider is the only supported test/dev path now). This grep-gate
// is a permanent regression guard so a future edit can never quietly
// reintroduce a fake channel adapter or a hand-rolled deterministic model.
const NO_STUB_MOCK_PATTERNS = ['MockAdapter', 'stubLLM', 'CASEY_STUB_LLM', 'sim/inject', 'sim/stub-llm', 'sim/scenarios']
const STUB_MOCK_SCAN_DIRS = ['src', 'bin', 'plugins']
for (const dir of STUB_MOCK_SCAN_DIRS) {
  let files = []
  try { files = walk(join(ROOT, dir)).filter((p) => ['.js', '.mjs'].includes(extname(p))) } catch { continue }
  for (const f of files) {
    let src = ''
    try { src = readFileSync(f, 'utf8') } catch { continue }
    for (const pattern of NO_STUB_MOCK_PATTERNS) {
      if (src.includes(pattern)) {
        note(`no-stub-mock: ${f.replace(ROOT, '')} references "${pattern}" -- all stubs/mocks (MockAdapter, stubLLM, CASEY_STUB_LLM, sim/*) were removed; casey runs only against real freddie/thatcher/LLM`)
      }
    }
  }
}

if (fails.length) {
  console.error('lint FAIL:\n' + fails.map((m) => '  - ' + m).join('\n'))
  process.exit(1)
}
console.log(`lint OK: ${jsFiles.length} JS files syntax-checked, config + package + ascii + pure-agent + no-stub-mock clean`)
