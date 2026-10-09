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

export async function transcribeSpecialist(url, buffer, mimeType, { timeoutMs = 25000, env = process.env } = {}) {
  const headers = { 'content-type': mimeType || 'audio/ogg' }
  const token = String(env.CASEY_STT_SPECIALIST_TOKEN || '').trim()
  if (token) headers.authorization = `Bearer ${token}`
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
