import crypto from 'node:crypto'
import { TABLE, ACTOR, e164FromWhatsapp, normaliseMac, waTimestampIso, recordRegistration } from './portal-store.js'
import { effectiveSettings } from './portal-settings.js'

export const PENDING_TTL_MS = 15 * 60e3
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_LENGTH = 6
const CODE_IN_TEXT = new RegExp(`\\bUHH[- ]?([${CODE_ALPHABET}]{${CODE_LENGTH}})\\b`, 'i')

export function newCode() {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
  return code
}

export function codeFromText(text) {
  const m = CODE_IN_TEXT.exec(String(text ?? ''))
  return m ? m[1].toUpperCase() : null
}

export function waLink(botNumber, code) {
  return `https://wa.me/${botNumber.replace(/\D/g, '')}?text=${encodeURIComponent(`UHH ${code}`)}`
}

export async function createPending(store, { routerId, mac }, now = Date.now()) {
  let code = null
  for (let attempt = 0; attempt < 5 && !code; attempt++) {
    const candidate = newCode()
    const [taken] = await store.t.list(TABLE.pending, { code: candidate }, { limit: 1 })
    if (!taken) code = candidate
  }
  if (!code) throw new Error('could not allocate a registration code')
  const row = {
    code,
    router_id: routerId,
    mac: normaliseMac(mac),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + PENDING_TTL_MS).toISOString(),
    used_at: null,
    phone_e164: null,
  }
  await store.t.create(TABLE.pending, row, ACTOR)
  return row
}

export async function pendingStatus(store, code, now = Date.now()) {
  const [row] = await store.t.list(TABLE.pending, { code }, { limit: 1 })
  if (!row) return { status: 'unknown' }
  if (row.used_at) return { status: 'registered', registered_at: row.used_at }
  if (Date.parse(row.expires_at) <= now) return { status: 'expired' }
  return { status: 'waiting' }
}

export async function acceptPendingInbound(store, event, now = new Date().toISOString()) {
  const code = codeFromText(event?.text)
  if (!code) return { accepted: false, reason: 'no code in the message' }
  const phone = e164FromWhatsapp(event?.from)
  if (!phone) return { accepted: false, reason: 'sender has no number' }
  const [row] = await store.t.list(TABLE.pending, { code }, { limit: 1 })
  if (!row || row.used_at) return { accepted: false, reason: 'no unused code' }
  if (Date.parse(row.expires_at) <= Date.parse(now)) return { accepted: false, reason: 'code expired' }
  const settings = await effectiveSettings(store, row.router_id)
  if (!settings.registration_enabled) return { accepted: false, reason: 'registration closed' }
  const at = waTimestampIso(event?.raw?.timestamp) || now
  await store.t.update(TABLE.pending, row.id, { used_at: at, phone_e164: phone }, ACTOR)
  await recordRegistration(store, { routerId: row.router_id, mac: row.mac, phone }, at)
  return { accepted: true, router_id: row.router_id, mac: row.mac }
}
