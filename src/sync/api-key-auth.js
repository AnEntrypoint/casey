import crypto from 'node:crypto'

const SCRYPT_KEYLEN = 64
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 }
const KEY_PREFIX_LEN = 10
const RAW_KEY_BYTES = 32

function randomHex(bytes) { return crypto.randomBytes(bytes).toString('hex') }

export function generateApiKey() {
  const raw = randomHex(RAW_KEY_BYTES)
  const { hash, salt } = hashApiKey(raw)
  return { raw, hash, salt, prefix: raw.slice(0, KEY_PREFIX_LEN) }
}

export function hashApiKey(raw, salt = randomHex(16)) {
  const hash = crypto.scryptSync(String(raw), salt, SCRYPT_KEYLEN, SCRYPT_OPTS).toString('hex')
  return { hash, salt }
}

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

export async function findByPrefix(store, prefix) {
  return store.t.list('sync_api_key', { key_prefix: prefix }, { limit: 10 })
}

export async function touchLastUsed(store, id) {
  try { await store.t.update('sync_api_key', id, { last_used_at: new Date().toISOString() }, SYSTEM) }
  catch {}
}
