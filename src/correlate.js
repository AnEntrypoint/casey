// correlate.js  --  the intelligence for deciding which cases are the SAME
// real-world outbreak and which are SEPARATE.
//
// Pure functions, no I/O: every input is a plain case row, every output is a
// number + the human-readable reasons behind it. That makes the judgement fully
// unit-testable and explainable -- an operator sees WHY two cases were linked,
// never an opaque score. The store/tools layer feeds rows in and acts on the
// suggestions; this module never touches the database (P4 minimal core, P8 pure).
//
// The model is deliberately conservative: we SUGGEST links for a human or the
// agent to confirm, and we never auto-merge silently -- a wrong silent merge of
// two real outbreaks would hide a disease spreading in a second place, which is
// exactly the failure this whole system exists to prevent (P6, P9 worst-case).

const STOP = new Set(['the', 'a', 'an', 'of', 'at', 'in', 'on', 'near', 'by', 'and',
  'farm', 'plaas', 'area', 'district', 'town', 'next', 'to', 'road', 'r', 'n'])

// Normalize a free-text field into a set of meaningful lowercased tokens.
// Accent-stripped so "musina" and "Musína" match; stop-words dropped so a shared
// "farm"/"area" is not mistaken for a shared place.
function tokens(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && !STOP.has(w))
  )
}

// Jaccard overlap of two token sets: |A∩B| / |A∪B|, in [0,1]. Empty-vs-anything
// is 0 (no evidence is not evidence of sameness).
function tokenOverlap(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

// Digits only, last 9 kept, so +27 82 123 4567 and 082 123 4567 (the same SA
// number written two ways) compare equal. Returns '' when there is nothing
// phone-like, so two blanks never "match".
function normPhone(s) {
  const d = String(s || '').replace(/\D/g, '')
  return d.length >= 7 ? d.slice(-9) : ''
}

function parseReport(c) {
  if (c && typeof c.report === 'object' && c.report) return c.report   // already slimmed
  try { return c && c.report ? JSON.parse(c.report) : {} } catch { return {} }
}

// created_at is unix-seconds (thatcher). Returns the absolute gap in days, or
// null when either side is unknown.
function onsetGapDays(a, b) {
  const ta = Number(a?.created_at), tb = Number(b?.created_at)
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || !ta || !tb) return null
  return Math.abs(ta - tb) / 86400
}

// Score how likely two cases are the SAME outbreak. Returns { score, reasons }.
// score is in [0,1]; reasons explains every contributing signal in plain words.
// Signals (each capped, then summed and clamped):
// - same contact number (channel+external_id) ............ strong
// - a contact_fallback on one matches the other's number . strong
// - shared location tokens ............................... strong, scaled
// - same species ......................................... moderate
// - shared symptom / suspected-disease tokens ............ moderate
// - close in time (same week) ............................ weak supporting
// A case is never "the same" on time alone -- timing only AMPLIFIES a real
// content match, it cannot manufacture one (guarded below).
export function correlationScore(a, b) {
  const reasons = []
  if (!a || !b || a.id === b.id) return { score: 0, reasons }
  const ra = parseReport(a), rb = parseReport(b)
  let content = 0

  // Same originating contact -> very likely the same thread/outbreak.
  if (a.channel === b.channel && a.external_id && a.external_id === b.external_id) {
    content += 0.5; reasons.push('same contact')
  }
  // Cross-number link: a fallback number named on one IS the other's number.
  const aNums = [normPhone(a.external_id), normPhone(ra.contact_fallback)].filter(Boolean)
  const bNums = [normPhone(b.external_id), normPhone(rb.contact_fallback)].filter(Boolean)
  if (aNums.some(n => bNums.includes(n)) && !(a.external_id === b.external_id && a.channel === b.channel)) {
    content += 0.45; reasons.push('linked by a fallback contact number')
  }

  // Location: the single strongest disease-grouping signal.
  const locOv = tokenOverlap(tokens(ra.location), tokens(rb.location))
  if (locOv > 0) { content += 0.45 * locOv; reasons.push(`shared location (${Math.round(locOv * 100)}%)`) }
  const findOv = tokenOverlap(tokens(ra.how_to_find), tokens(rb.how_to_find))
  if (findOv > 0) { content += 0.2 * findOv; reasons.push('shared directions to the place') }

  // Species: same animals affected.
  const spOv = tokenOverlap(tokens(ra.species), tokens(rb.species))
  if (spOv > 0) { content += 0.2 * spOv; reasons.push('same species') }

  // Clinical picture: shared symptoms / named disease.
  const symOv = tokenOverlap(
    new Set([...tokens(ra.symptoms), ...tokens(ra.suspected_disease)]),
    new Set([...tokens(rb.symptoms), ...tokens(rb.suspected_disease)]))
  if (symOv > 0) { content += 0.15 * symOv; reasons.push('similar symptoms / suspected disease') }

  // Time only amplifies an existing content signal -- never creates one. Without
  // any content match, two cases in the same week are still NOT the same outbreak.
  let score = content
  const gap = onsetGapDays(a, b)
  if (content > 0 && gap != null && gap <= 7) {
    const boost = (1 - gap / 7) * 0.1
    score += boost; reasons.push('reported within the same week')
  }
  return { score: Math.min(1, score), reasons }
}

// Default threshold: below this, a pair is NOT suggested. Tuned so a single weak
// signal (species alone, or a faint location overlap) does not surface a noisy
// suggestion -- it takes either a strong signal or two moderate ones to clear it.
export const SUGGEST_THRESHOLD = 0.35

// Rank candidate links for `target` against `others`, strongest first, keeping
// only pairs at or above the threshold. Self and closed/merged cases are skipped
// by the caller (this stays pure -- it just scores what it is given).
export function suggestLinks(target, others, threshold = SUGGEST_THRESHOLD) {
  const out = []
  for (const o of others) {
    if (!o || o.id === target.id) continue
    const { score, reasons } = correlationScore(target, o)
    if (score >= threshold) out.push({ id: o.id, ref: o.ref, score: Math.round(score * 100) / 100, reasons })
  }
  return out.sort((x, y) => y.score - x.score)
}


function nonEmpty(v) { return v != null && String(v).trim() !== '' }
function safeParse(s) { try { return s ? JSON.parse(s) : {} } catch { return {} } }
