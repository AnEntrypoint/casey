const TIMEOUT_MS = 30000

export function appsScriptConfig(env = process.env) {
  const url = String(env.CASEY_MAIL_APPS_SCRIPT_URL || '').trim()
  const secret = String(env.CASEY_MAIL_APPS_SCRIPT_SECRET || '')
  if (!url) return null
  if (!/^https:\/\//.test(url)) throw new Error('CASEY_MAIL_APPS_SCRIPT_URL must be an https URL')
  if (!secret) throw new Error('CASEY_MAIL_APPS_SCRIPT_SECRET is required with CASEY_MAIL_APPS_SCRIPT_URL')
  return { url, secret }
}

export async function sendViaAppsScript({ to, subject, text }, cfg) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret: cfg.secret, to, subject, text }),
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const body = await res.text()
  let reply = null
  try { reply = JSON.parse(body) } catch { reply = null }
  if (!res.ok || !reply || reply.ok !== true) {
    const why = reply && reply.error ? reply.error : `HTTP ${res.status}`
    throw new Error(`mail relay refused the message: ${why}`)
  }
}
