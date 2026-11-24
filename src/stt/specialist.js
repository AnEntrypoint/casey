import { caseyText } from '../deployment-text.js';
const PARSE_SEP = /\s*,\s*/

export function specialistEndpoints(env = process.env) {
  const out = new Map()
  for (const pair of String(env.CASEY_STT_SPECIALISTS || '').split(PARSE_SEP).filter(Boolean)) {
    const eq = pair.indexOf('=')
    if (eq < 1) continue
    const key = pair.slice(0, eq).trim().toLowerCase()
    const url = pair.slice(eq + 1).trim()
    if (/^https:\/\//.test(url)) out.set(key, url)
  }
  return out
}

const METADATA_IDENTITY_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity'
const IDENTITY_REFRESH_MARGIN_MS = 5 * 60 * 1000
const identityCache = new Map()

export function isCloudRunUrl(url) {
  try {
    return new URL(url).hostname.endsWith('.run.app')
  } catch {
    return false
  }
}

function jwtExpiryMs(jwt) {
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
  return Number(payload.exp) * 1000
}

export async function cloudRunIdentityToken(url, { now = Date.now, fetchImpl = fetch } = {}) {
  const audience = new URL(url).origin
  const cached = identityCache.get(audience)
  if (cached && now() < cached.expiresAtMs - IDENTITY_REFRESH_MARGIN_MS) return cached.token
  const res = await fetchImpl(`${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}`, {
    headers: { 'Metadata-Flavor': 'Google' },
  })
  if (!res.ok) throw new Error(`metadata identity HTTP ${res.status}`)
  const token = (await res.text()).trim()
  identityCache.set(audience, { token, expiresAtMs: jwtExpiryMs(token) })
  return token
}

export const SPECIALIST_KEYS = Object.freeze(['xh', 'zu', 'af'])

export async function transcribeSpecialist(id, url, buffer, mimeType, { env = process.env } = {}) {
  const t0 = Date.now()
  const provider = `specialist-${id}`
  const done = (fields) => ({ id, engine: 'specialist', provider, text: '', error: '', status: null, ms: Date.now() - t0, failureKind: '', ...fields })
  const headers = { 'content-type': mimeType || 'audio/ogg' }
  try {
    if (isCloudRunUrl(url)) {
      headers.authorization = `Bearer ${await cloudRunIdentityToken(url)}`
    } else {
      const token = String(env.CASEY_STT_SPECIALIST_TOKEN || '').trim()
      if (token) headers.authorization = `Bearer ${token}`
    }
  } catch (e) {
    return done({ error: caseyText("src/stt/specialist.js#s0", [String(e?.message || e)]) })
  }
  try {
    const res = await fetch(url, { method: 'POST', headers, body: buffer })
    if (!res.ok) return done({ error: caseyText("src/stt/specialist.js#s1", [res.status]), status: res.status })
    const body = await res.json()
    const text = String(body?.text ?? '').trim()
    return text ? done({ text, status: res.status }) : done({ error: caseyText("src/stt/specialist.js#s2"), status: res.status })
  } catch (e) {
    return done({ error: `specialist: ${String(e?.message || e)}` })
  }
}

export async function runSpecialists(buffer, mimeType, { env = process.env } = {}) {
  const endpoints = specialistEndpoints(env)
  return Promise.all(SPECIALIST_KEYS.map(async (id) => {
    const url = endpoints.get(id)
    if (!url) return { id, engine: 'specialist', provider: `specialist-${id}`, text: '', error: caseyText("src/stt/specialist.js#0"), status: null, ms: 0, failureKind: '' }
    if (!buffer?.length) return { id, engine: 'specialist', provider: `specialist-${id}`, text: '', error: caseyText("src/stt/specialist.js#s3"), status: null, ms: 0, failureKind: '' }
    return transcribeSpecialist(id, url, buffer, mimeType, { env })
  }))
}
