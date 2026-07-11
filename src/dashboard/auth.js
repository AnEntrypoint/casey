// dashboard/auth.js -- per-operator username/password login, replacing the
// shared CASEY_DASHBOARD_TOKEN bearer-token gate.
//
// Design: operators are field-organisation staff, often not tech-literate, on
// shared/personal devices -- a login screen is a familiar pattern (see
// server.js's header comment for the fuller reasoning). This module is
// intentionally small and dependency-free (Node's built-in crypto only, no
// bcrypt/express-session): scrypt for password hashing (a real, slow KDF, not
// a bare hash), and a stateless HMAC-signed session cookie so no server-side
// session store is needed -- the store (data/app.db) stays the one durable
// boundary, matching casey's existing hot-reload design (AGENTS.md).
//
// Bootstrap: a fresh deployment has no accounts, so nobody could ever log in.
// ensureBootstrapAdmin() creates a single 'admin' account with a random
// password on first boot ONLY (never overwrites an existing account), and
// prints it once to the server log -- the same "admin sets it up, team then
// self-serves" shape the CLI's `casey operators` commands extend for
// break-glass recovery.

import crypto from 'node:crypto'

const SCRYPT_KEYLEN = 64
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 } // Node's own recommended defaults
const SESSION_TTL_MS = 30 * 24 * 3600e3      // 30 days -- a field device stays logged in
const COOKIE_NAME = 'casey_session'

export function slugUsername(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

function randomHex(bytes) { return crypto.randomBytes(bytes).toString('hex') }

export function hashPassword(password, salt = randomHex(16)) {
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTS).toString('hex')
  return { hash, salt }
}

// Constant-time compare so a login attempt cannot time-oracle the stored hash.
export function verifyPassword(password, salt, storedHashHex) {
  if (!password || !salt || !storedHashHex) return false
  const attempt = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTS)
  let stored
  try { stored = Buffer.from(storedHashHex, 'hex') } catch { return false }
  if (stored.length !== attempt.length) return false
  return crypto.timingSafeEqual(attempt, stored)
}

// Session secret: derived at process start from a random value, so a signed
// session becomes invalid across a restart (an operator simply logs in again --
// no durable session-secret file to manage/rotate/leak). Overridable via
// CASEY_SESSION_SECRET for a deployment that wants sessions to survive a
// restart (e.g. behind a reload that should not force every operator to
// re-login).
const SESSION_SECRET = process.env.CASEY_SESSION_SECRET || randomHex(32)

function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex')
}

// Stateless session token: base64url(json) + '.' + hmac. No server-side
// session table -- verification is pure recomputation, so it works
// unchanged across the multi-worker hot-reload supervisor (AGENTS.md) with no
// shared session store to keep in sync.
export function issueSession(accountId, { now = Date.now() } = {}) {
  const payload = JSON.stringify({ id: accountId, exp: now + SESSION_TTL_MS })
  const b64 = Buffer.from(payload).toString('base64url')
  return `${b64}.${sign(b64)}`
}

export function verifySession(token, { now = Date.now() } = {}) {
  if (!token || typeof token !== 'string') return null
  const dot = token.lastIndexOf('.')
  if (dot < 0) return null
  const b64 = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = sign(b64)
  const sigBuf = Buffer.from(sig, 'hex')
  const expBuf = Buffer.from(expected, 'hex')
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null
  let payload
  try { payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) }
  catch { return null }
  if (!payload || typeof payload.id !== 'string' || !Number.isFinite(payload.exp)) return null
  if (payload.exp < now) return null
  return payload.id
}

// Manual Cookie header parse -- no cookie-parser dependency, matching this
// codebase's existing hand-rolled-parsing style (parseOperators, etc).
export function parseCookies(header) {
  const out = {}
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=')
    if (i < 0) return
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  })
  return out
}

export function sessionCookieHeader(token, { maxAgeMs = SESSION_TTL_MS } = {}) {
  const parts = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`]
  if (process.env.CASEY_COOKIE_SECURE !== '0') parts.push('Secure')
  return parts.join('; ')
}

export function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

export { COOKIE_NAME }

// --- account store helpers (thin wrapper over the store's operator_account entity) ---
// store.t is thatcher's own entity API (list(entity, where, opts) / create(entity,
// data, user) / update(entity, id, patch, user) / get(entity, id)) -- same shape
// case-store.js already uses throughout for contact/case/event/operator_identity.

const SYSTEM = { id: 'casey-system', role: 'admin' }

export async function findAccountByUsername(store, username) {
  const sid = slugUsername(username)
  if (!sid) return null
  const [row] = await store.t.list('operator_account', { username: sid }, { limit: 1 })
  return row || null
}

export async function getAccount(store, id) {
  return id ? store.t.get('operator_account', id) : null
}

export async function listAccounts(store) {
  return store.t.list('operator_account', {}, { limit: 500 })
}

export async function createAccount(store, { username, password, displayName, role = 'operator' }) {
  const sid = slugUsername(username)
  if (!sid) throw new Error('invalid username')
  if (!password || String(password).length < 8) throw new Error('password must be at least 8 characters')
  if (await findAccountByUsername(store, sid)) throw new Error(`account "${sid}" already exists`)
  const { hash, salt } = hashPassword(password)
  return store.t.create('operator_account', {
    username: sid, password_hash: hash, password_salt: salt,
    display_name: String(displayName || sid).slice(0, 80), role: role === 'admin' ? 'admin' : 'operator',
    disabled: '0',
  }, SYSTEM)
}

export async function setAccountDisabled(store, id, disabled) {
  return store.t.update('operator_account', id, { disabled: disabled ? '1' : '0' }, SYSTEM)
}

export async function deleteAccount(store, id) {
  return store.t.delete('operator_account', id)
}

export async function markLogin(store, id, { now = Date.now() } = {}) {
  return store.t.update('operator_account', id, { last_login_at: new Date(now).toISOString() }, SYSTEM)
}

// Only ever called at boot with no existing accounts -- never overwrites.
export async function ensureBootstrapAdmin(store, log = console) {
  const existing = await store.t.list('operator_account', {}, { limit: 1 })
  if (existing.length) return null
  const password = randomHex(6) // 12 hex chars, printed once -- easy to read off a terminal
  await createAccount(store, { username: 'admin', password, displayName: 'Admin', role: 'admin' })
  log?.warn?.('[casey] no operator accounts found -- created bootstrap admin account', {
    username: 'admin', password, note: 'log in once and consider creating named accounts for the team',
  })
  return { username: 'admin', password }
}
