

import { parseReportTolerant as parseReport } from './timestamp.js'

const STOP = new Set(['the', 'a', 'an', 'of', 'at', 'in', 'on', 'near', 'by', 'and',
  'farm', 'plaas', 'area', 'district', 'town', 'next', 'to', 'road', 'r', 'n'])

export function tokens(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && !STOP.has(w))
  )
}

const NAME_TOKEN_NOISE = /^\d+$/;
const NAME_TOKEN_UNIT_WORDS = new Set(['head', 'heads']);
export function nameTokens(s) {
  return [...tokens(s)].filter(t => !NAME_TOKEN_NOISE.test(t) && !NAME_TOKEN_UNIT_WORDS.has(t))
}

function tokenOverlap(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

function normPhone(s) {
  const d = String(s || '').replace(/\D/g, '')
  return d.length >= 7 ? d.slice(-9) : ''
}

function onsetGapDays(a, b) {
  const ta = Number(a?.created_at), tb = Number(b?.created_at)
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null
  return Math.abs(ta - tb) / 86400
}

export function caseSignature(c) {
  const r = parseReport(c)
  return {
    id: c?.id, channel: c?.channel, external_id: c?.external_id,
    created_at: c?.created_at,
    nums: [normPhone(c?.external_id), normPhone(r.contact_fallback)].filter(Boolean),
    loc: tokens(r.location),
    find: tokens(r.how_to_find),
    species: tokens(r.species),

    sym: new Set([...tokens(r.symptoms), ...tokens(r.suspected_disease)]),
  }
}

export function correlationScoreFromSignatures(a, b) {
  const reasons = []
  if (!a || !b || a.id === b.id) return { score: 0, reasons }
  let content = 0

  if (a.channel === b.channel && a.external_id && a.external_id === b.external_id) {
    content += 0.5; reasons.push('same contact')
  }

  if (a.nums.some(n => b.nums.includes(n)) && !(a.external_id === b.external_id && a.channel === b.channel)) {
    content += 0.45; reasons.push('linked by a fallback contact number')
  }

  const locOv = tokenOverlap(a.loc, b.loc)
  if (locOv > 0) { content += 0.45 * locOv; reasons.push(`shared location (${Math.round(locOv * 100)}%)`) }
  const findOv = tokenOverlap(a.find, b.find)
  if (findOv > 0) { content += 0.2 * findOv; reasons.push('shared directions to the place') }

  const spOv = tokenOverlap(a.species, b.species)
  if (spOv > 0) { content += 0.2 * spOv; reasons.push('same species') }

  const symOv = tokenOverlap(a.sym, b.sym)
  if (symOv > 0) { content += 0.15 * symOv; reasons.push('similar symptoms / suspected disease') }

  let score = content
  const gap = onsetGapDays(a, b)
  if (content > 0 && gap != null && gap <= 7) {
    const boost = (1 - gap / 7) * 0.1
    score += boost; reasons.push('reported within the same week')
  }
  return { score: Math.min(1, score), reasons }
}

export function correlationScore(a, b) {
  if (!a || !b || a.id === b.id) return { score: 0, reasons: [] }
  return correlationScoreFromSignatures(caseSignature(a), caseSignature(b))
}

export const SUGGEST_THRESHOLD = 0.35

export function suggestLinks(target, others, threshold = SUGGEST_THRESHOLD) {
  const out = []
  const ts = caseSignature(target)
  for (const o of others) {
    if (!o || o.id === target.id) continue
    const { score, reasons } = correlationScoreFromSignatures(ts, caseSignature(o))
    if (score >= threshold) out.push({ id: o.id, ref: o.ref, score: Math.round(score * 100) / 100, reasons })
  }
  return out.sort((x, y) => y.score - x.score)
}
