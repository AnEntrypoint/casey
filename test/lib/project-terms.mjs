import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export const PROJECT_TERMS = /uhh|animal|\bvet\b|veterinar|herd|ranger|technician|livestock|ubuntu|farm|farmer|cattle|goat|sheep/gi

const SKIP_DIRS = new Set(['node_modules', 'deps', '.gm', '.git', '.agentplug-kv', '.agentplug', '.flatspace-clone', '.scratch_tmp', 'bbwork', 'test'])
const SKIP_FILES = new Set(['CHANGELOG.md', 'package-lock.json'])

export function* walk(root, dir = root) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(root, full)
    else if (!SKIP_FILES.has(name)) yield full
  }
}

export function countProjectTerms(root) {
  let total = 0
  const byFile = {}
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8')
    if (text.includes('\u0000')) continue
    const hits = text.match(PROJECT_TERMS)
    if (hits) {
      byFile[path.relative(root, file)] = hits.length
      total += hits.length
    }
  }
  return { total, byFile }
}
