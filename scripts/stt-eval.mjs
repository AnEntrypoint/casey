import fs from 'node:fs'
import path from 'node:path'
import { transcribeAudioDetailed } from '../src/hooks/media.js'

const MIME = { '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.oga': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac', '.amr': 'audio/amr', '.webm': 'audio/webm' }

const USAGE = 'usage: node scripts/stt-eval.mjs <folder> [expected.tsv] [--json]\n  expected.tsv: one line per file, tab separated: <file name> <language code or name> <expected text>\n  engine and credentials come from the environment (CASEY_STT_ENGINE=google on the GCP VM)'

export function normalise(text) {
  return String(text || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
}

export function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

export function wordErrors(expected, heard) {
  const ref = normalise(expected)
  return { errors: editDistance(ref, normalise(heard)), words: ref.length }
}

function readExpected(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')).map((line, i) => {
    const [name, language, ...rest] = line.split('\t')
    if (!name || !language || !rest.length) throw new Error(`${file} line ${i + 1}: need <file><TAB><language><TAB><expected text>`)
    return { name: name.trim(), language: language.trim(), expected: rest.join('\t').trim() }
  })
}

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--json')
  const asJson = process.argv.includes('--json')
  const [folder, tsvArg] = args
  if (!folder) { console.error(USAGE); process.exit(2) }
  const tsv = tsvArg || path.join(folder, 'expected.tsv')
  const rows = readExpected(tsv)
  const perLanguage = new Map()
  const detail = []
  for (const row of rows) {
    const file = path.join(folder, row.name)
    const ext = path.extname(file).toLowerCase()
    if (!MIME[ext]) throw new Error(`${row.name}: unsupported extension ${ext}`)
    const tr = await transcribeAudioDetailed(fs.readFileSync(file), MIME[ext], { hintLanguage: null })
    const { errors, words } = wordErrors(row.expected, tr.text)
    const agg = perLanguage.get(row.language) || { files: 0, errors: 0, words: 0, failed: 0, confSum: 0, confN: 0, msSum: 0, detected: {} }
    agg.files += 1
    agg.errors += errors
    agg.words += words
    agg.msSum += tr.ms || 0
    if (!tr.text) agg.failed += 1
    if (typeof tr.confidence === 'number') { agg.confSum += tr.confidence; agg.confN += 1 }
    const seen = tr.languageKey || tr.language || 'none'
    agg.detected[seen] = (agg.detected[seen] || 0) + 1
    perLanguage.set(row.language, agg)
    detail.push({ file: row.name, language: row.language, detected: seen, wer: words ? Number((errors / words).toFixed(3)) : null, confidence: tr.confidence ?? null, ms: tr.ms, failureKind: tr.failureKind || undefined, heard: tr.text })
  }
  const summary = [...perLanguage].map(([language, a]) => ({
    language, files: a.files, wer: a.words ? Number((a.errors / a.words).toFixed(3)) : null, failed: a.failed,
    avg_confidence: a.confN ? Number((a.confSum / a.confN).toFixed(3)) : null, avg_ms: Math.round(a.msSum / a.files), detected_as: a.detected,
  }))
  const totals = [...perLanguage.values()].reduce((t, a) => ({ errors: t.errors + a.errors, words: t.words + a.words }), { errors: 0, words: 0 })
  const overall = totals.words ? Number((totals.errors / totals.words).toFixed(3)) : null
  if (asJson) { console.log(JSON.stringify({ overall_wer: overall, summary, detail }, null, 2)); return }
  console.log('language\tfiles\tWER\tfailed\tavg_conf\tavg_ms\tdetected_as')
  for (const s of summary) console.log([s.language, s.files, s.wer, s.failed, s.avg_confidence ?? '-', s.avg_ms, JSON.stringify(s.detected_as)].join('\t'))
  console.log(`overall WER ${overall} over ${totals.words} reference words`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main().catch(e => { console.error(e.message); process.exit(1) })
