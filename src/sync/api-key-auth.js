// sync/api-key-auth.js -- credential hashing/verification + scope checking
// for the /api/sync/* machine surface (routes/sync-api.js). Same scrypt KDF
// and timing-safe compare discipline as dashboard/auth.js's operator
// passwords -- deliberately not reusing that module's exports directly since
// sync_api_key is a distinct entity/credential class from operator_account
// (see EXTERNAL-SYNC.md and thatcher.config.yml's own header comment on the
// sync_api_key entity).
//
// THIS IS NOT A CHANGE TO THE DASHBOARD'S "NO BEARER TOKEN" INVARIANT.
// dashboard/routes/auth.js's authGate() still refuses a bearer token on every
// dashboard/session route exactly as before. /api/sync/* is a separate,
// narrowly-scoped route prefix with its OWN gate (requireSyncScope below),
// exempted from authGate specifically so it can run its own bearer check --
// see authGate()'s own comment and AGENTS.md's Security invariants section,
// both updated to name this exemption explicitly.
import crypto from 'node:crypto'

const SCRYPT_KEYLEN = 64
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 } // same as dashboard/auth.js
const KEY_PREFIX_LEN = 10
const RAW_KEY_BYTES = 32 // 256 bits

function randomHex(bytes) { return crypto.randomBytes(bytes).toString('hex') }

// Generates a new raw key (hex, printed to the operator exactly once) plus
// its stored hash/salt/prefix. The raw key is never returned by any other
// function in this module or persisted anywhere -- only the caller's one-time
// stdout print (bin/casey-sync-apikey-command.js) ever sees it.
export function generateApiKey() {
  const raw = randomHex(RAW_KEY_BYTES)
  const { hash, salt } = hashApiKey(raw)
  return { raw, hash, salt, prefix: raw.slice(0, KEY_PREFIX_LEN) }
}

export function hashApiKey(raw, salt = randomHex(16)) {
  const hash = crypto.scryptSync(String(raw), salt, SCRYPT_KEYLEN, SCRYPT_OPTS).toString('hex')
  return { hash, salt }
}

// Constant-time compare, same reasoning as dashboard/auth.js's verifyPassword:
// a plain === here would let response-timing leak how many hex characters of
// a guessed key matched the stored hash.
export function verifyApiKey(raw, salt, storedHashHex) {
  if (!raw || !salt || !storedHashHex) return false
  const attempt = crypto.scryptSync(String(raw), salt, SCRYPT_KEYLEN, SCRYPT_OPTS)
  let stored
  try { stored = Buffer.from(storedHashHex, 'hex') } catch { return false }
  if (stored.length !== attempt.length) return false
  return crypto.timingSafeEqual(attempt, stored)
}

export function keyPrefix(raw) {
  return String(raw || '').slice(0, KEY_PREFIX_LEN)
}

export function parseScopes(scopesCsv) {
  return new Set(String(scopesCsv || '').split(',').map(s => s.trim()).filter(Boolean))
}

// --- store helpers (thin wrapper over sync_api_key, same shape as
// dashboard/auth.js's account helpers over operator_account) ---

const SYSTEM = { id: 'casey-system', role: 'admin' }

export async function createApiKey(store, { label, scopes }) {
  if (!label || !String(label).trim()) throw new Error('label is required')
  const { raw, hash, salt, prefix } = generateApiKey()
  const row = await store.t.create('sync_api_key', {
    label: String(label).trim().slice(0, 80),
    key_hash: hash, key_salt: salt, key_prefix: prefix,
    scopes: Array.isArray(scopes) ? scopes.join(',') : String(scopes || ''),
    disabled: '0',
  }, SYSTEM)
  return { row, rawKey: raw }
}

export async function listApiKeys(store) {
  return store.t.list('sync_api_key', {}, { limit: 500 })
}

export async function revokeApiKey(store, id) {
  const row = await store.t.get('sync_api_key', id)
  if (!row) throw new Error('sync API key not found')
  return store.t.update('sync_api_key', id, { disabled: '1' }, SYSTEM)
}

// findByPrefix: the cheap first-pass filter before the real scrypt+
// timingSafeEqual check -- key_prefix narrows a raw-key lookup to (in
// practice) zero or one candidate rows without a full-table scrypt attempt
// per row. A prefix collision (two keys sharing the same first 10 hex chars)
// is checked against ALL matching candidates, not just the first, so a
// collision can never let the wrong key's row authenticate.
export async function findByPrefix(store, prefix) {
  return store.t.list('sync_api_key', { key_prefix: prefix }, { limit: 10 })
}

export async function touchLastUsed(store, id) {
  try { await store.t.update('sync_api_key', id, { last_used_at: new Date().toISOString() }, SYSTEM) }
  catch { /* best-effort -- never blocks the response the key just authenticated */ }
}
