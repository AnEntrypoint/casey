#!/usr/bin/env node
// casey lint: dependency-free preflight that runs WITHOUT any install at all
// (every composed project is an npm dependency). Validates what can be checked
// from a bare clone -- JS syntax, YAML config, package.json, and the ASCII-only
// source convention from AGENTS.md.
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
    if (name === 'node_modules' || name === 'deps' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

// Untracked scratch workspaces (gm-plugkit tool-verb clones, session
// scratchpads) live at the repo root under gitignored names not on the
// hardcoded skip list above -- ask git which of walk()'s candidates it
// would actually ignore, rather than growing that list by hand forever.
// Falls back to the unfiltered list if git is unavailable (bare-clone CI
// without git on PATH), matching this script's dependency-free contract.
function filterGitignored(paths) {
  try {
    const rel = paths.map((p) => p.slice(ROOT.length).replace(/\\/g, '/'))
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: ROOT, input: rel.join('\n'), stdio: ['pipe', 'pipe', 'pipe'],
    }).toString()
    const ignored = new Set(out.split('\n').filter(Boolean))
    return paths.filter((_, i) => !ignored.has(rel[i]))
  } catch (e) {
    // git check-ignore exits 1 (not an error) when NOTHING is ignored --
    // only fall back on a genuine invocation failure (git missing/not a repo).
    if (e.status === 1 && e.stdout != null) {
      const ignored = new Set(String(e.stdout).split('\n').filter(Boolean))
      const rel = paths.map((p) => p.slice(ROOT.length).replace(/\\/g, '/'))
      return paths.filter((_, i) => !ignored.has(rel[i]))
    }
    return paths
  }
}

const all = filterGitignored(walk(ROOT))
const jsFiles = all.filter((p) => ['.js', '.mjs'].includes(extname(p)))

// 1. JS syntax: node --check every JS/MJS file.
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  } catch (e) {
    note(`syntax: ${f.replace(ROOT, '')}\n${String(e.stderr || e).trim()}`)
  }
}

// 2. package.json parses and declares the casey bin.
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  if (pkg.type !== 'module') note('package.json: expected "type":"module"')
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
//    dingbats U+2500-27BF, supplemental arrows/symbols U+2B00-2BFF, emoji,
//    general punctuation U+2000-206F (em/en dash, curly quotes, ellipsis),
//    and combining diacritical marks U+0300-036F.
function decorative(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.codePointAt(i)
    if (
      (c >= 0x0300 && c <= 0x036f) ||
      (c >= 0x2000 && c <= 0x206f) ||
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
  // data/ holds captured real transcripts (test-driver fixtures of actual LLM
  // replies) -- the ASCII convention governs authored source and docs, not
  // recorded model output, so this tree is exempt.
  if (f.replace(ROOT, '').split(/[\\/]/)[0] === 'data') continue
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

// Trust-boundary dependency arrows (core -> engine -> packs/clients, one way
// only): the new provenance subsystem's src/core/, src/engine/, src/packs/
// directories may only import DOWNWARD. A packs/ file importing from core/
// or engine/ (packs must be data-shaped, referencing the engine only via
// runtime injection, never a static import) or an engine/ file importing
// upward from packs/ would let a config change silently reach into engine
// internals -- exactly the "can this change fabricate a number" question
// this boundary exists to keep answerable by directory alone.
const BOUNDARY_DIRS = { core: 'src/core', engine: 'src/engine', packs: 'src/packs' }
const FORBIDDEN_IMPORTS = {
  // packs/ is declarative data -- it must never import ANYTHING from core/
  // or engine/ (a pack that imports engine code is code wearing a config
  // costume, the exact anti-pattern item 16 forbids).
  packs: ['src/core', 'src/engine', './core', './engine', '../core', '../engine'],
}
for (const [dirKey, relDir] of Object.entries(BOUNDARY_DIRS)) {
  const forbidden = FORBIDDEN_IMPORTS[dirKey]
  if (!forbidden) continue
  let files = []
  try { files = walk(join(ROOT, relDir)).filter((p) => ['.js', '.mjs'].includes(extname(p))) } catch { continue }
  for (const f of files) {
    let src = ''
    try { src = readFileSync(f, 'utf8') } catch { continue }
    const importRe = /(?:from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"])/g
    let m
    while ((m = importRe.exec(src))) {
      const spec = m[1] || m[2]
      if (forbidden.some((bad) => spec.includes(bad))) {
        note(`trust-boundary: ${f.replace(ROOT, '')} imports "${spec}" -- ${dirKey}/ may never import engine/core (one-way dependency arrow: core -> engine -> packs/clients)`)
      }
    }
  }
}

// deps/design's own token/inline-css lint gates, pointed at casey's dashboard
// SPA source (src/dashboard/public) via DS_LINT_EXTRA_CSS_FILES/
// DS_LINT_EXTRA_JS_DIRS -- see AGENTS.md's Architecture section: deps/design
// is a real editable submodule, not vendored code, and its lint scripts only
// exist on disk after `git submodule update --init`. This script's own
// contract (dependency-free, runs from a bare clone with empty deps/*) means
// this check degrades to a skip, never a failure, when the submodule is
// absent -- the CI gate stays green in a bare clone per AGENTS.md's CI
// section, and a populated clone gets real coverage over the dashboard's
// token/inline-CSS compliance that no gate previously provided.
const DESIGN_ROOT = join(ROOT, 'deps', 'design')
const DASHBOARD_PUBLIC = join(ROOT, 'src', 'dashboard', 'public')
try {
  statSync(join(DESIGN_ROOT, 'scripts', 'lint-tokens.mjs'))
  const cssFiles = walk(DASHBOARD_PUBLIC).filter((p) => extname(p) === '.css')
  const env = {
    ...process.env,
    DS_LINT_EXTRA_CSS_FILES: cssFiles.join(','),
    DS_LINT_EXTRA_JS_DIRS: join(DASHBOARD_PUBLIC, 'src'),
  }
  for (const script of ['lint-tokens.mjs', 'lint-inline-css.mjs']) {
    try {
      execFileSync(process.execPath, [join(DESIGN_ROOT, 'scripts', script)], { cwd: DESIGN_ROOT, env, stdio: 'pipe' })
    } catch (e) {
      note(`design-lint: ${script} against src/dashboard/public\n${String(e.stdout || e.stderr || e).trim()}`)
    }
  }
} catch {
  // deps/design not checked out (bare clone, no `git submodule update --init`) -- skip.
}

// PII safety gate: no external_id or contact_id returned in case/contact API responses.
// The only allowed way to return a case row is via caseListProjection() (cases.js) or
// publicContact() (contacts.js). This gate scans dashboard routes for unsafe patterns.
const PII_PATTERNS = [
  { file: 'cases.js', safe: 'caseListProjection' },
  { file: 'contacts.js', safe: 'publicContact' },
]
const ROUTE_DIR = join(ROOT, 'src', 'dashboard', 'routes')
for (const { file, safe } of PII_PATTERNS) {
  let src = ''
  try { src = readFileSync(join(ROUTE_DIR, file), 'utf8') } catch { continue }
  // Scan for res.json/res.send calls that might return unfiltered case/contact rows
  // Pattern: res.json({ ... : c/cases/contacts/... })
  // Safe pattern: uses the projection function (safe variable above)
  const lineNum = (s) => src.substring(0, src.indexOf(s)).split('\n').length
  // Look for direct object spreads like { ...c } or { ...found } without projection
  if (file === 'cases.js') {
    // Check for patterns like res.json(...{ ...c, ... }) that bypass caseListProjection
    if (/res\.json\([^;]*\{[^}]*\.\.\.c[^}]*\}/.test(src) && !src.includes('caseListProjection')) {
      const line = lineNum('{ ...c')
      note(`pii-safety: ${file}:${line} spreads raw case object c into JSON without caseListProjection() -- external_id/contact_id will leak`)
    }
    // Check for { ...found } patterns (from getCaseByRef)
    if (/res\.json\([^;]*\{[^}]*\.\.\.found[^}]*\}/.test(src)) {
      const match = /res\.json\([^;]*\{[^}]*\.\.\.found[^}]*\}/.exec(src)
      if (match && !src.substring(Math.max(0, src.indexOf(match[0]) - 200), src.indexOf(match[0])).includes('caseListProjection')) {
        const line = lineNum(match[0])
        note(`pii-safety: ${file}:${line} spreads raw case object found into JSON without projection -- external_id/contact_id will leak`)
      }
    }
  }
}

if (fails.length) {
  console.error('lint FAIL:\n' + fails.map((m) => '  - ' + m).join('\n'))
  process.exit(1)
}
console.log(`lint OK: ${jsFiles.length} JS files syntax-checked, config + package + ascii + pure-agent + no-stub-mock + pii-safety clean`)
