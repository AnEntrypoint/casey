// store/ref.js  --  the two identity strings casey mints for a case row: the
// human-readable `ref` a field worker reads back over a bad phone line, and the
// derived `author_key` thatcher's equality operator-where can query directly.
// Both are pure: mintRef takes the already-fetched page of case rows, so the
// store owns the round-trip and this module owns only the string rules.

// Flattens external_id's 'container:author' shape (hooks/handler.js
// conversationKey) down to a plain author token thatcher's real equality
// operator-where can query directly -- the derived-only case.author_key field.
// conversationKey only ever produces zero or one colon (container:author, or a
// bare id with none), so the LAST colon-separated segment is always the author
// regardless of which shape produced this external_id.
export function deriveAuthorKey(externalId) {
  const s = String(externalId || '')
  if (!s) return ''
  const i = s.lastIndexOf(':')
  return i === -1 ? s : s.slice(i + 1)
}

// The ref is the sole "secret" gating the unauthenticated public /report form
// (see dashboard/server.js) -- a farmer's phone, symptoms, and location are all
// readable and writable by anyone who can guess it, AND it is the one code a
// field worker must read back over a bad phone line or retype by hand. Balance:
// 8 chars from a 32-symbol unambiguous alphabet (no 0/O/1/I/l confusion, no
// vowel-adjacent pairs that sound alike read aloud) is ~40 bits of entropy,
// while staying short and speakable, unlike a full-entropy base64url string
// (dense mixed-case + symbols, hard to read/say/type accurately). Do NOT drop
// back to Math.random() -- that suffix was ~26 bits over 5 chars, and it is not
// a CSPRNG. crypto.randomBytes is the
// entropy source; each byte is reduced mod 32 into the alphabet (a benign
// bias -- this is an unguessability-vs-readability tradeoff, not a keyed secret
// requiring perfectly uniform output).
import { randomBytes } from 'node:crypto'

const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'   // 32 symbols, no 0/O/1/I/l

export function randomSuffix() {
  const bytes = randomBytes(8)
  let s = ''
  for (const b of bytes) s += REF_ALPHABET[b % REF_ALPHABET.length]
  return s
}

// Friendly, collision-proof case ref, built from a capped page of existing case
// rows the caller already fetched. The numeric part is a best-effort
// human-friendly sequence taken as the max over that page; we scan every row and
// take Math.max, so ordering is irrelevant here (the caller passes no sort).
// UNIQUENESS does not depend on the sequence: the random suffix guarantees it
// even if two creators read the same max concurrently or the highest case falls
// outside the page.
export function mintRef(recentCaseRows) {
  let seq = 1000
  for (const r of recentCaseRows || []) {
    const m = /^CASE-(\d+)/.exec(r.ref || '')
    if (m) seq = Math.max(seq, parseInt(m[1], 10))
  }
  return `CASE-${seq + 1}-${randomSuffix()}`
}
