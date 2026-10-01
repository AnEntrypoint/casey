
export function deriveAuthorKey(externalId) {
  const s = String(externalId || '')
  if (!s) return ''
  const i = s.lastIndexOf(':')
  return i === -1 ? s : s.slice(i + 1)
}

import { randomBytes } from 'node:crypto'

const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

export function randomSuffix() {
  const bytes = randomBytes(8)
  let s = ''
  for (const b of bytes) s += REF_ALPHABET[b % REF_ALPHABET.length]
  return s
}

export function mintRef(recentCaseRows) {
  let seq = 1000
  for (const r of recentCaseRows || []) {
    const m = /^CASE-(\d+)/.exec(r.ref || '')
    if (m) seq = Math.max(seq, parseInt(m[1], 10))
  }
  return `CASE-${seq + 1}-${randomSuffix()}`
}
