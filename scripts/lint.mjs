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
import { filterGitignored } from './lib/git-ignored.mjs'

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

const all = filterGitignored(walk(ROOT), ROOT)
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

// Trust-boundary dependency arrow (core -> packs, one way only): a
// src/packs/*.js file is declarative data and may never statically import
// src/core/. A pack that imports engine code is code wearing a config
// costume, and a config change could then silently reach into core
// internals -- exactly the "can this change fabricate a number" question
// this boundary exists to keep answerable by directory alone. src/engine/
// was removed as unreachable code (see AGENTS.md's Provenance subsystem
// section); this gate previously walked it and a src/core/ entry that
// declared no forbidden list, both of which were no-ops.
const PACKS_FORBIDDEN_IMPORTS = ['src/core', './core', '../core']
let packFiles = []
try { packFiles = walk(join(ROOT, 'src/packs')).filter((p) => ['.js', '.mjs'].includes(extname(p))) } catch { packFiles = [] }
for (const f of packFiles) {
  let src = ''
  try { src = readFileSync(f, 'utf8') } catch { continue }
  const importRe = /(?:from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"])/g
  let m
  while ((m = importRe.exec(src))) {
    const spec = m[1] || m[2]
    if (PACKS_FORBIDDEN_IMPORTS.some((bad) => spec.includes(bad))) {
      note(`trust-boundary: ${f.replace(ROOT, '')} imports "${spec}" -- src/packs/ is declarative data and may never import src/core/`)
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
    // This dashboard's own `!important` budget, counted separately from the
    // kit's frozen baseline (deps/design's ratchetOrThrow splits the two
    // corpora, so a consumer's sheet can never buy the kit slack it did not
    // earn -- and vice versa: tightening the kit no longer breaks us).
    //
    // The one declaration is app.css's
    //   @media print { .app-topbar, ... { display: none !important } }
    // which keeps the app chrome off the operator's printed handover sheet.
    // It cannot be done with specificity instead: the kit sets display:flex
    // on those same elements at specificity up to 4
    // (.ds-247420.ds-247420 .ca-app .app-topbar, and .ca-app is emitted by
    // the kit's own JS), so a consumer sheet cannot beat it without the flag.
    // Verified by enumerating every competing `display` declaration in
    // dist/247420.css before keeping it. This is a budget to drive to 0, not
    // an allowance to spend.
    DS_LINT_EXTRA_IMPORTANT_BASELINE: '1',
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

// PII safety gate: no external_id, author_key or contact_id returned in any
// dashboard API response. A row reaches JSON only through an explicit field
// allowlist. Each route file's own allowlist functions are declared here, so
// renaming or deleting one is itself a lint failure rather than a silent loss
// of enforcement -- these are module-level named exports in their own files
// precisely so this gate has a single definition to point at.
const PII_PATTERNS = [
  { file: 'cases.js', projections: ['caseListProjection', 'caseDetailProjection'] },
  { file: 'contacts.js', projections: ['publicContact'] },
  { file: 'accounts.js', projections: ['publicAccount'] },
  { file: 'map.js', projections: ['mapCaseProjection', 'workerPinProjection'] },
]
const ROUTE_DIR = join(ROOT, 'src', 'dashboard', 'routes')

// Two checks used to live here that only ever matched a literal `{ ...c }` /
// `{ ...found }` inside a res.json argument -- a shape neither route file has
// ever contained -- so they were structurally incapable of failing, and
// `res.json(updated)` (PATCH /api/cases/:id) plus
// `res.json(after)` (POST /api/cases/:id/transition) shipped the entire raw
// thatcher row past a green lint: external_id AND author_key (the reporter's
// phone number, twice), contact_id, lat/lon, _version, created_by. Witnessed
// live before the fix, body verbatim: "external_id":"27821110001",
// "contact_id":"mta3r2es-mjgea3m7","author_key":"27821110001".
//
// The shape that actually leaks is a row bound straight off a store call and
// handed to a response with no projection between the two, so that is what
// this checks -- by dataflow, not by the punctuation of one sample. It runs
// over EVERY file in the route dir, not just the two with a projection of
// their own: a file with no projection function has no business returning a
// row at all, so any bare row reference in a response there is a failure by
// construction.
const ROW_METHODS = [
  'getCase', 'getCaseByRef', 'updateCase', 'findOrCreateCase', 'listCases',
  'getContact', 'listContacts', 'setContactTier',
]
const PROJECTIONS_BY_FILE = new Map(PII_PATTERNS.map((p) => [p.file, p.projections]))
// A projection must never emit these as keys of its own returned object. The
// display form (external_id_formatted) is a deliberate, separate key: an authed
// operator may see a contact NUMBER (contacts.js's publicContact has always
// served exactly that, and /api/cases/:id/report.html renders a tel: link from
// it) -- what may never leave is the raw routing key, the same number under its
// author_key alias, and the internal contact_id join key.
const PII_KEYS = ['external_id', 'contact_id', 'author_key']
// String and comment bodies are not code: `{ error: 'not found' }` mentions a
// binding called `found` and returns nothing at all. Blanked (length-preserving
// where it matters) before any identifier match.
const stripText = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/`(?:\\.|[^`\\])*`/g, '``')
let routeFiles = []
try { routeFiles = readdirSync(ROUTE_DIR).filter((f) => f.endsWith('.js')) } catch { routeFiles = [] }
for (const file of routeFiles) {
  let src = ''
  try { src = readFileSync(join(ROUTE_DIR, file), 'utf8') } catch { continue }
  const lineAt = (idx) => src.slice(0, idx).split('\n').length
  const projections = PROJECTIONS_BY_FILE.get(file) || []

  // (a) Every declared projection must actually be an allowlist: no PII key
  // among the keys it returns, and no spread of the row it was handed.
  for (const name of projections) {
    let at = src.indexOf(`function ${name}(`)
    if (at < 0) at = src.search(new RegExp(String.raw`(?:const|let)\s+${name}\s*=\s*\(`))
    if (at < 0) { note(`pii-safety: ${file} declares projection ${name}() in lint.mjs but the function is gone -- the gate below has nothing to enforce`); continue }
    // Walk the PARAMETER LIST to its closing paren before looking for the body
    // brace. Taking the first `{` after the name instead is wrong the moment a
    // projection destructures a parameter -- `f(c, { now, staleMs })` made the
    // options object itself the "body", so the checks below ran against the
    // parameter list and the real function was unenforced while lint stayed
    // green. Live-witnessed with a deliberate `return { ...c }` that the gate
    // did not see.
    const parenOpen = src.indexOf('(', at)
    let pdepth = 0
    let parenClose = parenOpen
    for (let i = parenOpen; i < src.length; i++) {
      if (src[i] === '(') pdepth++
      else if (src[i] === ')') { pdepth--; if (pdepth === 0) { parenClose = i; break } }
    }
    const open = src.indexOf('{', parenClose)
    let depth = 0
    let end = src.length
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    const body = src.slice(open, end + 1)
    // The row is the FIRST parameter; a projection may take more (a map pin
    // takes the parsed report and its cluster index alongside the case row), so
    // match the first identifier in the list rather than requiring a
    // single-parameter signature -- which silently skipped the spread check.
    const param = (/\(\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(src.slice(parenOpen, parenClose + 1)) || [])[1]
    for (const key of PII_KEYS) {
      // `key:` (explicit) or `key,`/`key}` (shorthand) as an emitted key.
      // `external_id_formatted:` and `c.external_id` both correctly miss.
      if (new RegExp(`(^|[{,\\s])${key}\\s*[:,}]`).test(body)) {
        note(`pii-safety: ${file} projection ${name}() emits ${key} -- that field must never reach a JSON response`)
      }
    }
    if (param && new RegExp(`\\.\\.\\.\\s*${param}\\b`).test(body)) {
      note(`pii-safety: ${file} projection ${name}() spreads its whole row (...${param}) instead of listing fields -- every column, present and future, leaks`)
    }
  }

  // (b) One route handler at a time. A binding is only a row for the handler
  // that made it -- these files reuse short names freely (a `claimed` case row
  // in the bulk handler, a `claimed` boolean in the reply handler), and a
  // file-wide name set would confuse the two and cry wolf.
  //
  // Chunk on the HANDLER, not on the registration. This used to split only at
  // `app.get(`/`app.post(`/... , which silently assumed every handler is an
  // inline arrow inside its own registration call. It is not any more: a route
  // module is now a set of module-level named handler factories plus a
  // declarative table mounted through routes/register.js, so a file can contain
  // twenty real handlers and zero `app.<method>(` call sites -- under the old
  // boundary set that file produced no chunks at all and the whole dataflow
  // check below silently did nothing. A route handler is identifiable by its
  // own signature instead, `(req, res` , which holds for an inline arrow, a
  // named `function h(req, res)`, and a factory's returned arrow alike. Both
  // boundary sets are taken so a registration that is not immediately followed
  // by its handler still opens a chunk; the extra empty chunk that produces
  // costs nothing (no bindings, no responses).
  const bounds = [...new Set([
    ...[...src.matchAll(/\bapp\.(?:get|post|patch|put|delete)\s*\(/g)].map((m) => m.index),
    ...[...src.matchAll(/\(\s*req\s*,\s*res\s*[,)]/g)].map((m) => m.index),
  ])].sort((a, b) => a - b)
  const chunks = bounds.map((start, n) => ({ start, text: src.slice(start, bounds[n + 1] ?? src.length) }))
  const bindRe = new RegExp(String.raw`(?:^|[;{}\n])\s*(?:const|let|var)?\s*([^=;\n]*?)=\s*(?:await\s+)?store\.(?:${ROW_METHODS.join('|')})\s*\(`, 'g')
  const callRe = /res(?:\.status\([^)]*\))?\.(json|send)\(/g
  for (const chunk of chunks) {
    const code = stripText(chunk.text)
    const rowNames = new Set()
    // Over-approximates a destructuring LHS (`const { case: c, created } = ...`
    // binds both names); harmless, since only a name that later reaches a
    // response can fail anything.
    for (const m of code.matchAll(bindRe)) {
      for (const id of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) {
        if (!['const', 'let', 'var', 'case', 'await'].includes(id[0])) rowNames.add(id[0])
      }
    }
    if (!rowNames.size) continue
    // (c) A response argument that references such a name as a VALUE -- a bare
    // identifier, a shorthand key, or a spread, but never `row.field` (a single
    // picked field) and never `row:` (a key that happens to share the name) --
    // and that carries no projection call, hands the caller the whole row.
    for (const m of code.matchAll(callRe)) {
      let i = m.index + m[0].length
      let depth = 1
      let arg = ''
      for (; i < code.length && depth > 0; i++) {
        const ch = code[i]
        if (ch === '(') depth++
        else if (ch === ')') { depth--; if (depth === 0) break }
        arg += ch
      }
      if (projections.some((p) => arg.includes(`${p}(`))) continue
      // A row handed to a helper CALL is an input to that helper, not the
      // response body (`buildSLAReport(cases, ...)` returns aggregates); only
      // what survives outside every call is actually returned.
      const outer = arg.replace(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\((?:[^()]|\([^()]*\))*\)/g, ' ')
      for (const name of rowNames) {
        if (new RegExp(String.raw`(?<![\w$.])${name}(?![\w$])\s*(?![.:(])`).test(outer)) {
          note(`pii-safety: ${file}:${lineAt(chunk.start + m.index)} res.${m[1]}() returns the raw store row '${name}' with no projection -- external_id/contact_id/author_key leak (use ${projections[0] || 'an explicit field allowlist'})`)
          break
        }
      }
    }
  }
}

// --- cli-help: every dispatchable command is discoverable ------------------
//
// `casey report` shipped fully working -- a management briefing with SLA
// compliance and per-type/per-channel response rates -- and was missing from
// the help text, so the only way to find it was to read bin/casey-cli.mjs. A
// command an operator cannot discover may as well not exist, and nothing
// connected the dispatch table to the text that advertises it.
//
// Matches the COMMANDS table's keys against the HELP string. Deliberately not
// the reverse: HELP legitimately documents things that are not COMMANDS keys
// (flags, env vars, the `handover start` subcommand form).
{
  let cli = null
  let ui = null
  try {
    cli = readFileSync(join(ROOT, 'bin', 'casey-cli.mjs'), 'utf8')
    ui = readFileSync(join(ROOT, 'bin', 'casey-cli-ui.js'), 'utf8')
  } catch (e) {
    note(`cli-help: cannot read the CLI dispatch table or help text -- ${String(e.message || e)}`)
  }
  if (cli && ui) {
    // Anchored, not indexOf: a bare substring search matches COMMANDS_OTHER
    // and HELPTEXT too, so a genuine rename would slip past the two
    // "nothing to enforce" notes below and the gate would report clean while
    // checking nothing.
    const tableAt = cli.search(/const COMMANDS(?![\w$])/)
    const helpAt = ui.search(/export const HELP(?![\w$])/)
    if (tableAt < 0) note('cli-help: bin/casey-cli.mjs has no COMMANDS table -- this gate has nothing to enforce')
    else if (helpAt < 0) note('cli-help: bin/casey-cli-ui.js exports no HELP -- this gate has nothing to enforce')
    else {
      const table = cli.slice(tableAt, cli.indexOf('\n}', tableAt))
      const help = ui.slice(helpAt)
      for (const m of table.matchAll(/^\s*'?([a-z][a-z-]*)'?:\s*cmd/gim)) {
        const name = m[1]
        if (!new RegExp(String.raw`casey ${name}(?![\w-])`).test(help)) {
          note(`cli-help: "casey ${name}" is dispatchable but absent from HELP in bin/casey-cli-ui.js -- an operator cannot discover it`)
        }
      }
    }
  }
}

if (fails.length) {
  console.error('lint FAIL:\n' + fails.map((m) => '  - ' + m).join('\n'))
  process.exit(1)
}
console.log(`lint OK: ${jsFiles.length} JS files syntax-checked, config + package + ascii + pure-agent + no-stub-mock + pii-safety + cli-help clean`)
