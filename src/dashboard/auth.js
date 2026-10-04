import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeMsisdn } from '../role-invites.js'
import { ACCOUNT_ROLES } from './roles.js'
import { UNCLAIMED_ASSIGNEE } from '../case-store.js'

const SCRYPT_KEYLEN = 64
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 }
const SESSION_TTL_MS = 30 * 24 * 3600e3
const COOKIE_NAME = 'casey_session'

export function slugUsername(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

function randomHex(bytes) { return crypto.randomBytes(bytes).toString('hex') }

export function hashPassword(password, salt = randomHex(16)) {
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTS).toString('hex')
  return { hash, salt }
}

export function verifyPassword(password, salt, storedHashHex) {
  if (!password || !salt || !storedHashHex) return false
  const attempt = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTS)
  let stored
  try { stored = Buffer.from(storedHashHex, 'hex') } catch { return false }
  if (stored.length !== attempt.length) return false
  return crypto.timingSafeEqual(attempt, stored)
}

const SESSION_SECRET = process.env.CASEY_SESSION_SECRET || randomHex(32)

function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex')
}

export function issueSession(accountId, { now = Date.now(), epoch = 0 } = {}) {
  const payload = JSON.stringify({ id: accountId, exp: now + SESSION_TTL_MS, epoch })
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
  const epoch = Number.isFinite(payload.epoch) ? payload.epoch : 0
  return { id: payload.id, epoch }
}

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

export async function createAccount(store, { username, password, displayName, role = 'operator', mustChangePassword = false, contactPhone = '' }) {
  if (role === 'secretary') role = 'operator'
  const sid = slugUsername(username)
  if (!sid) throw new Error('invalid username')
  if (sid === UNCLAIMED_ASSIGNEE) throw new Error(`"${sid}" is reserved (it marks an unclaimed report) -- pick another username`)
  if (role != null && role !== '' && !ACCOUNT_ROLES.includes(role)) throw new Error(`role must be one of ${ACCOUNT_ROLES.join(', ')}`)
  if (!password || String(password).length < 8) throw new Error('password must be at least 8 characters')
  if (await findAccountByUsername(store, sid)) throw new Error(`account "${sid}" already exists`)
  const phone = String(contactPhone || '').trim() ? normalizeMsisdn(contactPhone) : ''
  if (String(contactPhone || '').trim() && !phone) throw new Error('phone number is not valid -- use a full number such as 082 123 4567')
  const { hash, salt } = hashPassword(password)
  return store.t.create('operator_account', {
    username: sid, password_hash: hash, password_salt: salt,
    display_name: String(displayName || sid).slice(0, 80), role: ACCOUNT_ROLES.includes(role) ? role : 'operator',
    ...(phone ? { contact_phone: phone } : {}),
    disabled: '0', must_change_password: mustChangePassword ? '1' : '0',
  }, SYSTEM)
}

export async function changePassword(store, id, newPassword) {
  if (!newPassword || String(newPassword).length < 8) throw new Error('password must be at least 8 characters')
  const { hash, salt } = hashPassword(newPassword)
  const acct = await getAccount(store, id)
  const nextEpoch = (Number(acct?.session_epoch) || 0) + 1
  await store.t.update('operator_account', id, { password_hash: hash, password_salt: salt, must_change_password: '0', session_epoch: String(nextEpoch) }, SYSTEM)
  return { epoch: nextEpoch }
}

export async function setAccountContactPhone(store, id, contactPhone) {
  const raw = String(contactPhone || '').trim()
  const phone = raw ? normalizeMsisdn(raw) : ''
  if (raw && !phone) throw new Error('phone number is not valid -- use a full number such as 082 123 4567')
  return store.t.update('operator_account', id, { contact_phone: phone }, SYSTEM)
}

export async function setAccountDisabled(store, id, disabled) {
  return store.t.update('operator_account', id, { disabled: disabled ? '1' : '0' }, SYSTEM)
}

export async function revokeAccountSessions(store, id) {
  const acct = await getAccount(store, id)
  if (!acct) throw new Error('account not found')
  const nextEpoch = (Number(acct.session_epoch) || 0) + 1
  return store.t.update('operator_account', id, { session_epoch: String(nextEpoch) }, SYSTEM)
}

export async function deleteAccount(store, id) {
  const target = await getAccount(store, id)
  if (target?.role === 'admin' && target.disabled !== '1') {
    const accounts = await listAccounts(store)
    const otherEnabledAdmins = accounts.some(a => a.id !== id && a.role === 'admin' && a.disabled !== '1')
    if (!otherEnabledAdmins) throw new Error('cannot delete the last enabled admin account')
  }
  try { await revokeAccountSessions(store, id) } catch {  }
  return store.t.delete('operator_account', id)
}

export async function markLogin(store, id, { now = Date.now() } = {}) {
  return store.t.update('operator_account', id, { last_login_at: new Date(now).toISOString() }, SYSTEM)
}

function writeBootstrapPasswordFile(store, password) {
  const dataDir = store.dataDir
  fs.mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, 'bootstrap-admin-password.txt')
  fs.writeFileSync(file, password + '\n', { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  return file
}

export async function ensureBootstrapAdmin(store, log = console) {
  const existing = await store.t.list('operator_account', {}, { limit: 1 })
  if (existing.length) return null
  const password = randomHex(6)
  const passwordPath = writeBootstrapPasswordFile(store, password)
  try {
    await createAccount(store, { username: 'admin', password, displayName: 'Admin', role: 'admin', mustChangePassword: true })
  } catch (e) {
    try { fs.rmSync(passwordPath, { force: true }) } catch {  }
    throw e
  }
  log?.warn?.('[casey] no operator accounts found -- created bootstrap admin account', {
    username: 'admin', password_file: passwordPath,
    note: 'read the password from that file once, log in, set your own password, then delete the file',
  })
  return { username: 'admin', passwordPath }
}
