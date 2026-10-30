import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeMsisdn } from '../role-invites.js'
import { ACCOUNT_ROLES } from './roles.js'
import { UNCLAIMED_ASSIGNEE } from '../case-store.js'
import { smtpConfig } from '../mail/smtp.js'
import { appsScriptConfig } from '../mail/apps-script.js'
import { sendSetupEmail } from '../mail/setup-email.js'

export const SETUP_TTL_HOURS = 72
const SETUP_TABLE = 'account_setup_token'
const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/

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

export function normalizeEmail(raw) {
  const e = String(raw || '').trim().toLowerCase()
  if (!e) return ''
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new Error('email address is not valid')
  return e
}

export async function createAccount(store, { username, password, displayName, role = 'operator', mustChangePassword = false, contactPhone = '', email = '', setupBaseUrl = '' }) {
  if (role === 'secretary') role = 'operator'
  const sid = slugUsername(username)
  if (!sid) throw new Error('invalid username')
  if (sid === UNCLAIMED_ASSIGNEE) throw new Error(`"${sid}" is reserved (it marks an unclaimed report) -- pick another username`)
  if (role != null && role !== '' && !ACCOUNT_ROLES.includes(role)) throw new Error(`role must be one of ${ACCOUNT_ROLES.join(', ')}`)
  const hasPassword = password != null && String(password) !== ''
  if (hasPassword && String(password).length < 8) throw new Error('password must be at least 8 characters')
  const mail = normalizeEmail(email)
  if (!hasPassword && !mail) throw new Error('enter an email address so the person can set their own password')
  if (await findAccountByUsername(store, sid)) throw new Error(`account "${sid}" already exists`)
  const phone = String(contactPhone || '').trim() ? normalizeMsisdn(contactPhone) : ''
  if (String(contactPhone || '').trim() && !phone) throw new Error('phone number is not valid -- use a full number such as 082 123 4567')
  const { hash, salt } = hasPassword ? hashPassword(password) : { hash: '', salt: '' }
  const acct = await store.t.create('operator_account', {
    username: sid, password_hash: hash, password_salt: salt,
    display_name: String(displayName || sid).slice(0, 80), role: ACCOUNT_ROLES.includes(role) ? role : 'operator',
    ...(phone ? { contact_phone: phone } : {}),
    ...(mail ? { email: mail } : {}),
    disabled: '0', must_change_password: hasPassword ? (mustChangePassword ? '1' : '0') : '1',
  }, SYSTEM)
  if (hasPassword) return acct
  const { status, code } = await issueSetupLink(store, acct, setupBaseUrl)
  return { ...acct, setup_email_status: status, setup_email_error: code }
}

export async function issueSetupToken(store, accountId, { now = Date.now(), ttlHours = SETUP_TTL_HOURS } = {}) {
  const token = crypto.randomBytes(32).toString('base64url')
  const expiresAt = now + ttlHours * 3600e3
  const row = await store.t.create(SETUP_TABLE, { token_hash: setupHash(token), account_id: accountId, expires_at: expiresAt, used_at: '' }, SYSTEM)
  return { token, expiresAt, id: row.id }
}

const setupHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex')

async function revokeSetupTokens(store, accountId, keepId = null) {
  const rows = await store.t.list(SETUP_TABLE, { account_id: accountId }, { limit: 100 })
  for (const r of rows) if (!r.used_at && r.id !== keepId) await store.t.update(SETUP_TABLE, r.id, { used_at: new Date().toISOString() }, SYSTEM)
}

export async function issueSetupLink(store, acct, setupBaseUrl = '') {
  let status = 'sent'
  let code = ''
  try {
    if (!appsScriptConfig()) smtpConfig()
    const base = String(process.env.CASEY_PUBLIC_URL || setupBaseUrl || '').replace(/\/+$/, '')
    if (!base) throw Object.assign(new Error('no public address for the link'), { code: 'no_public_url' })
    const { token, expiresAt, id } = await issueSetupToken(store, acct.id)
    await sendSetupEmail({ to: acct.email, name: acct.display_name, link: `${base}/set-password?token=${token}`, expiresAt })
    await revokeSetupTokens(store, acct.id, id)
  } catch (e) {
    status = 'not_sent'
    code = String(e.code || 'send_failed').slice(0, 40)
    console.warn(`[casey] setup email not sent for account ${acct.id}: ${code}`)
  }
  await store.t.update('operator_account', acct.id, { setup_email_status: status, setup_email_error: code }, SYSTEM)
  return { status, code }
}

export async function resetAccountPassword(store, id, setupBaseUrl = '') {
  const acct = await getAccount(store, id)
  if (!acct) throw new Error('account not found')
  if (!acct.email) throw new Error('this login has no email address on file')
  const nextEpoch = (Number(acct.session_epoch) || 0) + 1
  await store.t.update('operator_account', id, { must_change_password: '1', session_epoch: String(nextEpoch) }, SYSTEM)
  const fresh = await getAccount(store, id)
  const { status, code } = await issueSetupLink(store, fresh, setupBaseUrl)
  return { ...fresh, setup_email_status: status, setup_email_error: code }
}

export async function resendSetupLink(store, id, setupBaseUrl = '') {
  const acct = await getAccount(store, id)
  if (!acct) throw new Error('account not found')
  if (acct.must_change_password !== '1') throw new Error('this login already has its password')
  if (!acct.email) throw new Error('this login has no email address on file')
  const { status, code } = await issueSetupLink(store, acct, setupBaseUrl)
  return { ...acct, setup_email_status: status, setup_email_error: code }
}

export async function redeemSetupToken(store, token, newPassword, { now = Date.now() } = {}) {
  if (!newPassword || String(newPassword).length < 8) return { ok: false, reason: 'short' }
  const h = setupHash(token)
  return store._withLock(`account-setup|${h}`, async () => {
    const [row] = await store.t.list(SETUP_TABLE, { token_hash: h }, { limit: 1 })
    if (!row || row.used_at) return { ok: false, reason: 'invalid' }
    if (Number(row.expires_at) <= now) return { ok: false, reason: 'expired' }
    const acct = await getAccount(store, row.account_id)
    if (!acct || acct.disabled === '1' || acct.status === 'deleted') return { ok: false, reason: 'invalid' }
    await changePassword(store, acct.id, newPassword)
    await store.t.update(SETUP_TABLE, row.id, { used_at: new Date(now).toISOString() }, SYSTEM)
    return { ok: true, account: acct }
  })
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
