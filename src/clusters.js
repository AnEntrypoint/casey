// clusters.js -- fleet-wide outbreak grouping. correlate.js scores a PAIR; this
// lifts that pairwise judgement to CONNECTED COMPONENTS over the whole open pool
// so the operator sees "these six cases look like one outbreak" instead of having
// to open each case and read its per-case suggestions one at a time.
//
// Pure and deterministic (no I/O): the store hands in the case rows, this returns
// the components with the shared tokens that bound them, each member ref and the
// span of report dates. The merge action stays per-pair and human-confirmed
// (correlate.js's whole point) -- this is a VIEW, never an auto-merge.
//
// Cost: O(n^2) correlationScore calls over a bounded pool (the caller caps it).
// That is fine on the few-hundred open cases casey holds; it is computed
// on-demand, not on every dashboard poll.

import { correlationScore, SUGGEST_THRESHOLD, tokens } from './correlate.js'

// Disjoint-set union-find with path compression. Indices are positions in the
// `cases` array.
function makeUF(n) {
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }
  return { find, union }
}

function parseReport(c) {
  if (c && typeof c.report === 'object' && c.report) return c.report
  try { return c && c.report ? JSON.parse(c.report) : {} } catch { return {} }
}

// Most-frequent tokens of a report field across a component's members, so the
// panel can name the shared place/species rather than echo a raw case.
function dominantTokens(members, field, max = 3) {
  const freq = new Map()
  for (const c of members) {
    for (const t of tokens(parseReport(c)[field])) freq.set(t, (freq.get(t) || 0) + 1)
  }
  return [...freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, max).map(([t]) => t)
}

// Build the outbreak clusters. `cases` is the open/non-merged pool. Returns the
// connected components of size >= 2, each with member refs, dominant shared
// location/species/disease tokens, the count, and the report-date span (SAST
// rendering is the caller's job; here it is raw unix-seconds min/max).
export function buildClusters(cases, threshold = SUGGEST_THRESHOLD) {
  const pool = (cases || []).filter(Boolean)
  const n = pool.length
  const uf = makeUF(n)
  const edges = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const { score, reasons } = correlationScore(pool[i], pool[j])
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
    clusters.push({
      count: members.length,
      members: members.map(c => ({ id: c.id, ref: c.ref, status: c.status, subject: c.subject || '' })),
      location: dominantTokens(members, 'location'),
      species: dominantTokens(members, 'species'),
      disease: dominantTokens(members, 'suspected_disease'),
      span: { from: created.length ? Math.min(...created) : null, to: created.length ? Math.max(...created) : null },
    })
  }
  // Biggest suspected outbreak first.
  return clusters.sort((a, b) => b.count - a.count)
}
