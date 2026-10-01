

import { caseSignature, correlationScoreFromSignatures, SUGGEST_THRESHOLD, tokens, nameTokens } from './correlate.js'

import { parseReportTolerant as parseReport } from './timestamp.js'

function makeUF(n) {
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }
  return { find, union }
}

function dominantTokens(members, field, max = 3, tokenize = tokens) {
  const freq = new Map()
  for (const c of members) {
    for (const t of tokenize(parseReport(c)[field])) freq.set(t, (freq.get(t) || 0) + 1)
  }
  return [...freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, max).map(([t]) => t)
}

export function buildClusters(cases, threshold = SUGGEST_THRESHOLD) {
  const pool = (cases || []).filter(Boolean)
  const n = pool.length
  const uf = makeUF(n)

  const sigs = pool.map(caseSignature)
  const edges = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const { score, reasons } = correlationScoreFromSignatures(sigs[i], sigs[j])
      if (score >= threshold) { uf.union(i, j); edges.push({ a: i, b: j, score, reasons }) }
    }
  }
  const groups = new Map()
  for (let i = 0; i < n; i++) {
    const r = uf.find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(i)
  }
  const clusters = []
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue
    const members = idxs.map(i => pool[i])
    const created = members.map(c => Number(c.created_at)).filter(Number.isFinite)
    const cluster = {
      count: members.length,
      members: members.map(c => ({ id: c.id, ref: c.ref, status: c.status, subject: c.subject || '', case_type: c.case_type || 'unset' })),
      location: dominantTokens(members, 'location'),
      species: dominantTokens(members, 'species', 3, nameTokens),
      symptoms: dominantTokens(members, 'symptoms', 3, nameTokens),
      reported_disease_names: dominantTokens(members, 'suspected_disease', 3, nameTokens),
      span: { from: created.length ? Math.min(...created) : null, to: created.length ? Math.max(...created) : null },
    }
    clusters.push(cluster)
  }

  return clusters.sort((a, b) => b.count - a.count)
}
