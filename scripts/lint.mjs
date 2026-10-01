#!/usr/bin/env node

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

for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  } catch (e) {
    note(`syntax: ${f.replace(ROOT, '')}\n${String(e.stderr || e).trim()}`)
  }
}

try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  if (pkg.type !== 'module') note('package.json: expected "type":"module"')
  if (!pkg.bin || !pkg.bin.casey) note('package.json: missing bin.casey')
} catch (e) {
  note(`package.json: ${String(e.message || e)}`)
}

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

const NO_HARDCODE_IMPORT = ['src/gateway-hooks.js', 'src/casey.js']
for (const rel of NO_HARDCODE_IMPORT) {
  let src = ''
  try { src = readFileSync(join(ROOT, rel), 'utf8') } catch { continue }
  if (/from\s+['"][^'"]*\b(intent|places|extract)\.js['"]/.test(src) || /import\(\s*['"][^'"]*\b(intent|places|extract)\.js['"]/.test(src)) {
    note(`pure-llm: ${rel} imports intent.js/places.js/extract.js -- casey does no deterministic text processing; the LLM classifies, routes, answers, and records the report via the case tools`)
  }
}

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

const DESIGN_ROOT = join(ROOT, 'deps', 'design')
const DASHBOARD_PUBLIC = join(ROOT, 'src', 'dashboard', 'public')
try {
  statSync(join(DESIGN_ROOT, 'scripts', 'lint-tokens.mjs'))
  const cssFiles = walk(DASHBOARD_PUBLIC).filter((p) => extname(p) === '.css')
  const env = {
    ...process.env,
    DS_LINT_EXTRA_CSS_FILES: cssFiles.join(','),
    DS_LINT_EXTRA_JS_DIRS: join(DASHBOARD_PUBLIC, 'src'),

    DS_LINT_EXTRA_IMPORTANT_BASELINE: '0',

    DS_LINT_EXTRA_SPACING_BASELINE: '0',
    DS_LINT_EXTRA_FONTSIZE_BASELINE: '0',
    DS_LINT_EXTRA_INLINE_CSS_BASELINE: '0',
  }
  for (const script of ['lint-tokens.mjs', 'lint-inline-css.mjs']) {
    try {
      execFileSync(process.execPath, [join(DESIGN_ROOT, 'scripts', script)], { cwd: DESIGN_ROOT, env, stdio: 'pipe' })
    } catch (e) {
      note(`design-lint: ${script} against src/dashboard/public\n${String(e.stdout || e.stderr || e).trim()}`)
    }
  }
} catch {

}

const PII_PATTERNS = [
  { file: 'cases.js', projections: ['caseListProjection', 'caseDetailProjection'] },
  { file: 'contacts.js', projections: ['publicContact'] },
  { file: 'accounts.js', projections: ['publicAccount'] },
  { file: 'map.js', projections: ['mapCaseProjection', 'workerPinProjection'] },
]
const ROUTE_DIR = join(ROOT, 'src', 'dashboard', 'routes')

const ROW_METHODS = [
  'getCase', 'getCaseByRef', 'updateCase', 'findOrCreateCase', 'listCases',
  'getContact', 'listContacts', 'setContactTier',
]
const PROJECTIONS_BY_FILE = new Map(PII_PATTERNS.map((p) => [p.file, p.projections]))

const PII_KEYS = ['external_id', 'contact_id', 'author_key']

const stripText = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/`(?:\\.|[^`\\])*`/g, '``')

function projectionBody(src, name) {
  let at = src.indexOf(`function ${name}(`)
  if (at < 0) at = src.search(new RegExp(String.raw`(?:const|let)\s+${name}\s*=\s*\(`))
  if (at < 0) return null
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

  const param = (/\(\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(src.slice(parenOpen, parenClose + 1)) || [])[1]
  return { body: src.slice(open, end + 1), param }
}

function checkProjectionIsAllowlist(file, src, name) {
  const found = projectionBody(src, name)
  if (!found) { note(`pii-safety: ${file} declares projection ${name}() in lint.mjs but the function is gone -- the gate below has nothing to enforce`); return }
  const { body, param } = found
  for (const key of PII_KEYS) {

    if (new RegExp(`(^|[{,\\s])${key}\\s*[:,}]`).test(body)) {
      note(`pii-safety: ${file} projection ${name}() emits ${key} -- that field must never reach a JSON response`)
    }
  }
  if (param && new RegExp(`\\.\\.\\.\\s*${param}\\b`).test(body)) {
    note(`pii-safety: ${file} projection ${name}() spreads its whole row (...${param}) instead of listing fields -- every column, present and future, leaks`)
  }
}

function routeHandlerChunks(src) {
  const bounds = [...new Set([
    ...[...src.matchAll(/\bapp\.(?:get|post|patch|put|delete)\s*\(/g)].map((m) => m.index),
    ...[...src.matchAll(/\(\s*req\s*,\s*res\s*[,)]/g)].map((m) => m.index),
  ])].sort((a, b) => a - b)
  return bounds.map((start, n) => ({ start, text: src.slice(start, bounds[n + 1] ?? src.length) }))
}

function rowBindingsIn(code) {
  const bindRe = new RegExp(String.raw`(?:^|[;{}\n])\s*(?:const|let|var)?\s*([^=;\n]*?)=\s*(?:await\s+)?store\.(?:${ROW_METHODS.join('|')})\s*\(`, 'g')
  const rowNames = new Set()
  for (const m of code.matchAll(bindRe)) {
    for (const id of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (!['const', 'let', 'var', 'case', 'await'].includes(id[0])) rowNames.add(id[0])
    }
  }
  return rowNames
}

function checkRawRowResponses(file, src, projections) {
  const lineAt = (idx) => src.slice(0, idx).split('\n').length
  const callRe = /res(?:\.status\([^)]*\))?\.(json|send)\(/g
  for (const chunk of routeHandlerChunks(src)) {
    const code = stripText(chunk.text)
    const rowNames = rowBindingsIn(code)
    if (!rowNames.size) continue
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

let routeFiles = []
try { routeFiles = readdirSync(ROUTE_DIR).filter((f) => f.endsWith('.js')) } catch { routeFiles = [] }
for (const file of routeFiles) {
  let src = ''
  try { src = readFileSync(join(ROUTE_DIR, file), 'utf8') } catch { continue }
  const projections = PROJECTIONS_BY_FILE.get(file) || []
  for (const name of projections) checkProjectionIsAllowlist(file, src, name)
  checkRawRowResponses(file, src, projections)
}

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

{
  const brandSrc = readFileSync(join(ROOT, 'src', 'dashboard', 'brand.js'), 'utf8')
  const blockAt = brandSrc.indexOf('TYPE_SCALE_CSS')
  const defined = new Set(
    blockAt < 0 ? [] : [...brandSrc.slice(blockAt).matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]),
  )
  if (!defined.size) {
    note('server-css-tokens: dashboard/brand.js exports no TYPE_SCALE_CSS custom properties -- this gate has nothing to enforce')
  } else {
    const SERVER_RENDERED = [
      join(ROOT, 'src', 'dashboard', 'server.js'),
      join(ROOT, 'src', 'dashboard', 'routes', 'auth.js'),
      join(ROOT, 'src', 'dashboard', 'routes', 'cases.js'),
      join(ROOT, 'src', 'dashboard', 'routes', 'reports.js'),
    ]
    for (const f of SERVER_RENDERED) {
      let src
      try { src = readFileSync(f, 'utf8') } catch { continue }
      const rel = f.replace(ROOT, '')
      for (const m of src.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {

        const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 2)
        if (tail.trimStart().startsWith(',')) continue
        if (!defined.has(m[1])) {
          note(`server-css-tokens: ${rel} uses var(${m[1]}) but brand.js's TYPE_SCALE_CSS does not define it -- the whole declaration is discarded at render time. Add the rung to TYPE_SCALE_CSS or use one it defines.`)
        }
      }
    }
  }
}

if (fails.length) {
  console.error('lint FAIL:\n' + fails.map((m) => '  - ' + m).join('\n'))
  process.exit(1)
}
console.log(`lint OK: ${jsFiles.length} JS files syntax-checked, config + package + ascii + pure-agent + no-stub-mock + pii-safety + cli-help + server-css-tokens clean`)
