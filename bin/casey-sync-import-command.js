import path from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { KINDS } from '../src/sync/adapters/base.js'
import { syncConfig } from '../src/sync/sync-config.js'
import { bold, dim, green, red, cyan, bad, say } from './casey-cli-ui.js'

function fieldAliases() {
  return syncConfig().SYNC_IMPORT_ALIASES
}

function pickField(row, canonical) {
  for (const alias of fieldAliases()[canonical] || [canonical]) {
    if (row[alias] !== undefined && row[alias] !== '') return row[alias]
  }
  return null
}

function normalizeRow(raw, kind) {
  const out = { kind, raw }
  for (const canonical of Object.keys(fieldAliases())) out[canonical] = pickField(raw, canonical)
  return out
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')
  if (!lines.length) return []
  const headers = lines[0].split(',').map(h => h.trim())
  return lines.slice(1).map(line => {
    const cells = line.split(',').map(c => c.trim())
    const row = {}
    headers.forEach((h, i) => { row[h] = cells[i] ?? '' })
    return row
  })
}

function readRecords(file) {
  const text = readFileSync(file, 'utf8')
  if (file.endsWith('.json')) {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed.records) ? parsed.records : [parsed])
  }
  return parseCsv(text)
}

export function loadManualImport(file, kind) {
  if (!existsSync(file)) throw new Error(`sync-import: file not found: ${file}`)
  if (!KINDS.includes(kind)) throw new Error(`sync-import: --kind must be one of ${KINDS.join(', ')}, got "${kind}"`)
  return readRecords(file).map(r => normalizeRow(r, kind))
}

function cacheDir() {
  return path.join(process.cwd(), 'data', 'sync-import')
}

export async function cmdSyncImport({ flags, rest }) {
  const file = rest[0]
  const kind = flags.kind
  if (!file || !kind) {
    say(bad('usage: casey sync-import <file.csv|.json> --kind field_visit|farmer|association|follow_up'))
    process.exit(2)
  }
  if (!KINDS.includes(kind)) {
    say(bad(`--kind must be one of ${KINDS.join(', ')}, not "${kind}".`))
    process.exit(2)
  }
  let records
  try {
    records = loadManualImport(path.resolve(file), kind)
  } catch (e) {
    say(bad(e.message))
    process.exit(2)
  }

  const dir = cacheDir()
  mkdirSync(dir, { recursive: true })
  const outFile = path.join(dir, `${kind}.json`)
  writeFileSync(outFile, JSON.stringify({ kind, imported_at: new Date().toISOString(), source_file: path.resolve(file), records }, null, 2))

  console.log(bold('casey sync-import') + dim(`  ${kind}`))
  console.log(green(`  ${records.length} record(s) parsed from ${file}`))
  if (records[0]) {
    console.log(dim('  first record:'))
    console.log('    ' + cyan(JSON.stringify(records[0])))
  }
  console.log(dim(`  written to ${outFile} for the correlation engine to read.`))
  process.exit(0)
}
