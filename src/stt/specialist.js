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

export function specialistFor(languageKey, env = process.env) {
  if (!languageKey) return null
  return specialistEndpoints(env).get(languageKey) || null
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
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) throw new Error(`metadata identity HTTP ${res.status}`)
  const token = (await res.text()).trim()
  identityCache.set(audience, { token, expiresAtMs: jwtExpiryMs(token) })
  return token
}

export async function transcribeSpecialist(url, buffer, mimeType, { timeoutMs = 25000, env = process.env } = {}) {
  const headers = { 'content-type': mimeType || 'audio/ogg' }
  try {
    if (isCloudRunUrl(url)) {
      headers.authorization = `Bearer ${await cloudRunIdentityToken(url)}`
    } else {
      const token = String(env.CASEY_STT_SPECIALIST_TOKEN || '').trim()
      if (token) headers.authorization = `Bearer ${token}`
    }
  } catch (e) {
    return { text: '', error: `specialist identity: ${String(e?.message || e)}` }
  }
  try {
    const res = await fetch(url, { method: 'POST', headers, body: buffer, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { text: '', error: `specialist answered HTTP ${res.status}` }
    const body = await res.json()
    const text = String(body?.text ?? '').trim()
    return text ? { text, error: '' } : { text: '', error: 'specialist returned no text' }
  } catch (e) {
    return { text: '', error: `specialist: ${String(e?.message || e)}` }
  }
}
