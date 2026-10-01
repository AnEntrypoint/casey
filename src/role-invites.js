

import crypto from 'node:crypto'
import { TIER_ORDER, TIER_REPORTER, TIER_OPERATOR, grantableBy, resolveTierValue } from './contact-tiers.js'
import { taggedObservations } from './store/settings-log.js'

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_LEN = 8
const KEY = 'role-invites'
const TAG = 'role-invite'
export const DEFAULT_TTL_HOURS = 72
export const MAX_TTL_HOURS = 24 * 30
export const MAX_ACTIVE_INVITES = 100

export function generateCode() {
  const bytes = crypto.randomBytes(CODE_LEN)
  let out = ''
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return `${out.slice(0, 4)}-${out.slice(4)}`
}

const hashCode = (code) => crypto.createHash('sha256').update(String(code).replace(/[^A-Z0-9]/g, '')).digest('hex')

const tidyCodeText = (text) => String(text || '').replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '').replace(/[\u2010-\u2015\u2212]/g, '-')

export function extractCode(text) {
  const t = tidyCodeText(text).trim().toUpperCase()
  if (!t || t.length > 40) return null
  const sym = `[${ALPHABET}]`
  const bare = new RegExp(`^(${sym}{4})-(${sym}{4})$`).exec(t)
  if (bare) return `${bare[1]}-${bare[2]}`
  const worded = new RegExp(`^(?:CODE|JOIN|REGISTER|INVITE|REG)\\s*[:#-]?\\s*(${sym}{4})[-\\s]?(${sym}{4})$`).exec(t)
  return worded ? `${worded[1]}-${worded[2]}` : null
}

export async function issuedLooseCode(store, text) {
  const sym = `[${ALPHABET}]`
  const m = new RegExp(`^(${sym}{4})[-\\s]?(${sym}{4})$`).exec(tidyCodeText(text).trim().toUpperCase())
  if (!m) return null
  const code = `${m[1]}-${m[2]}`
  const { invites } = await load(store)
  const h = hashCode(code)
  return [...invites.values()].some(v => v.hash === h) ? code : null
}

export async function withoutIssuedCodes(store, text) {
  const tidy = tidyCodeText(text)
  const sym = `[${ALPHABET}]`
  const re = new RegExp(`(?<![A-Z0-9])${sym}{4}[-\\s]?${sym}{4}(?![A-Z0-9])`, 'gi')
  const tokens = tidy.match(re)
  if (!tokens) return null
  const { invites } = await load(store)
  const known = new Set([...invites.values()].map(v => v.hash))
  let hit = false
  const out = tidy.replace(re, (tok) => { if (known.has(hashCode(tok.toUpperCase()))) { hit = true; return '[code removed]' } return tok })
  return hit ? out : null
}

function replay(events) {
  const invites = new Map()
  for (const { payload } of taggedObservations(events, TAG)) {
    let r
    try { r = JSON.parse(payload) } catch { continue }
    if (!r?.id) continue
    if (r.op === 'create') invites.set(r.id, { id: r.id, hash: r.h, tier: r.tier, label: r.label || '', by: r.by || '', created_at: r.at, expires_at: r.exp, max_uses: r.max || 1, uses: 0, claimed_by: [], revoked: false })
    else if (r.op === 'claim' && invites.has(r.id)) { const v = invites.get(r.id); v.uses += 1; v.claimed_by.push({ contact_id: r.contact, at: r.at }) }
    else if (r.op === 'revoke' && invites.has(r.id)) invites.get(r.id).revoked = true
  }
  return invites
}

async function load(store) {
  const caseId = await store._systemSingletonCaseId(KEY, KEY)
  const events = await store.listEvents(caseId).catch(() => [])
  return { caseId, invites: replay(events) }
}

async function append(store, caseId, rec, note) {
  await store.appendEvent(caseId, { kind: 'observation', actor: 'operator', text: `${TAG}:${JSON.stringify(rec)}`, data: { op: rec.op, id: rec.id, note } })
}

function statusOf(v, now) {
  if (v.revoked) return 'revoked'
  if (v.uses >= v.max_uses) return 'used'
  if (v.expires_at <= now) return 'expired'
  return 'active'
}

const publicView = (v, now) => ({ id: v.id, tier: v.tier, label: v.label, created_by: v.by, created_at: v.created_at, expires_at: v.expires_at, uses: v.uses, max_uses: v.max_uses, status: statusOf(v, now) })

export async function createInvite(store, { tier, label = '', ttlHours = DEFAULT_TTL_HOURS, maxUses = 1, by = 'operator', grantableTiers = grantableBy(false), now = Date.now() } = {}) {
  if (!TIER_ORDER.includes(tier) || tier === TIER_REPORTER) throw new Error(`tier must be one of ${TIER_ORDER.filter(t => t !== TIER_REPORTER).join(', ')}`)
  if (!grantableTiers.includes(tier)) throw new Error(`you cannot invite someone as ${tier}${grantableBy(true).includes(tier) && !grantableBy(false).includes(tier) ? ' -- only an admin can' : ''}`)
  const ttl = Math.min(Math.max(Number(ttlHours) || DEFAULT_TTL_HOURS, 1), MAX_TTL_HOURS)
  const uses = Math.min(Math.max(Math.floor(Number(maxUses)) || 1, 1), 25)
  const code = generateCode()
  const { caseId, invites } = await load(store)

  if ([...invites.values()].filter(v => statusOf(v, now) === 'active').length >= MAX_ACTIVE_INVITES) throw new Error(`there are already ${MAX_ACTIVE_INVITES} unused codes; revoke some before making more`)
  const rec = { op: 'create', id: crypto.randomBytes(6).toString('hex'), h: hashCode(code), tier, label: String(label).slice(0, 80), by: String(by).slice(0, 80), at: now, exp: now + ttl * 3600e3, max: uses }
  await append(store, caseId, rec, `invite created for ${tier}`)
  return { code, ...publicView({ ...rec, hash: rec.h, created_at: rec.at, expires_at: rec.exp, max_uses: rec.max, uses: 0, revoked: false, by: rec.by }, now) }
}

export async function createInvites(store, { count = 1, label = '', now = Date.now(), ...opts } = {}) {
  const n = Math.floor(Number(count))
  if (!Number.isFinite(n) || n < 1) throw new Error('count must be a whole number of at least 1')
  const { invites } = await load(store)
  const active = [...invites.values()].filter(v => statusOf(v, now) === 'active').length
  if (n > MAX_ACTIVE_INVITES - active) throw new Error(`that would pass the limit of ${MAX_ACTIVE_INVITES} unused codes (${active} are unused now); ask for at most ${Math.max(0, MAX_ACTIVE_INVITES - active)} or revoke some first`)
  const out = []
  for (let i = 1; i <= n; i++) out.push(await createInvite(store, { ...opts, label: n > 1 ? `${String(label || 'code').slice(0, 70)} ${String(i).padStart(2, '0')}` : label, now }))
  return out
}

export async function listInvites(store, now = Date.now()) {
  const { invites } = await load(store)
  return [...invites.values()].map(v => publicView(v, now)).sort((a, b) => b.created_at - a.created_at)
}

export async function revokeInvite(store, id, by = 'operator') {
  const { caseId, invites } = await load(store)
  if (!invites.has(id)) throw new Error('no such invite')
  await append(store, caseId, { op: 'revoke', id, at: Date.now(), by }, 'invite revoked')
  return true
}

export async function claimInvite(store, code, contact, now = Date.now()) {
  const h = hashCode(code)
  return store._withLock(`${KEY}|${h}`, async () => {
    const { caseId, invites } = await load(store)
    const v = [...invites.values()].find(x => x.hash === h)
    if (!v) return { ok: false, reason: 'unknown' }
    const st = statusOf(v, now)
    if (st !== 'active') return { ok: false, reason: st }
    if (v.claimed_by.some(c => c.contact_id === contact.id)) return { ok: false, reason: 'already' }

    if (resolveTierValue(contact.tier) === v.tier || TIER_ORDER.indexOf(resolveTierValue(contact.tier)) > TIER_ORDER.indexOf(v.tier)) return { ok: false, reason: 'already' }
    await append(store, caseId, { op: 'claim', id: v.id, contact: contact.id, at: now }, `code claimed by contact ${contact.id}`)
    await store.setContactTier(contact.id, v.tier, { id: `invite:${v.id}`, role: 'system' })
    return { ok: true, tier: v.tier, invite: publicView({ ...v, uses: v.uses + 1 }, now) }
  })
}

const FAILS = new Map()
const WINDOW_MS = 3600e3
const MAX_FAILS = 5

const GLOBAL_KEY = '*'
const MAX_GLOBAL_FAILS = 200

const sweep = (now) => { if (FAILS.size > 2000) for (const [k, l] of FAILS) if (!l.some(t => now - t < WINDOW_MS)) FAILS.delete(k) }
const recent = (key, now) => { const l = (FAILS.get(key) || []).filter(t => now - t < WINDOW_MS); if (l.length) FAILS.set(key, l); else FAILS.delete(key); return l }
export function attemptsExhausted(key, now = Date.now()) {
  return recent(key, now).length >= MAX_FAILS || recent(GLOBAL_KEY, now).length >= MAX_GLOBAL_FAILS
}
export function noteFailedAttempt(key, now = Date.now()) {
  sweep(now)
  for (const k of [key, GLOBAL_KEY]) FAILS.set(k, [...recent(k, now), now])
}

export function normalizeMsisdn(input, defaultCountryCode = '27') {

  let d = String(input || '').replace(/[\s\u00a0\u200b-\u200f\u202a-\u202f\u2060\ufeff().-]/g, '')
  const plus = d.startsWith('+')
  if (plus) d = d.slice(1)
  else if (d.startsWith('00')) d = d.slice(2)
  else if (d.startsWith('0')) d = defaultCountryCode + d.slice(1)

  if (d.startsWith(defaultCountryCode + '0')) d = defaultCountryCode + d.slice(defaultCountryCode.length + 1)
  if (!/^\d{10,15}$/.test(d)) return ''

  if (d.startsWith('27') && d.length !== 11) return ''

  if (plus && d.startsWith('0')) return ''
  return d
}
