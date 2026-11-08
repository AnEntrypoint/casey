

import crypto from 'node:crypto'

export const DEFAULT_GRAPH_API = 'https://graph.facebook.com/v20.0'
const TIMEOUT_MS = 6000

const row = (id, level, text, fix) => ({ id, level, text, ...(fix ? { fix } : {}) })

async function get(fetchImpl, url, headers, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal: ac.signal, redirect: 'manual' })
    let body = null
    try { body = await res.json() } catch { body = null }
    return { status: res.status, ok: res.ok, body, headers: res.headers }
  } catch (e) {
    const err = new Error(ac.signal.aborted ? 'timed out' : reasonOf(e))
    err.network = true
    throw err
  } finally { clearTimeout(timer) }
}

function reasonOf(e) {
  const code = e?.cause?.code || e?.code
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS lookup failed'
  if (code === 'ECONNREFUSED') return 'connection refused'
  if (code === 'ECONNRESET') return 'connection reset'
  if (code === 'CERT_HAS_EXPIRED' || /CERT|SSL|TLS/i.test(String(code || ''))) return `TLS problem (${String(code).slice(0, 40)})`
  return 'network error'
}

const metaError = (body) => {
  const e = body?.error
  if (!e) return null
  return `${String(e.message || 'error').replace(/[\r\n]+/g, ' ').slice(0, 160)}${e.code ? ` (code ${e.code})` : ''}`
}

const bearer = (t) => ({ authorization: `Bearer ${t}`, accept: 'application/json' })

function normUrl(u) {
  try {
    const x = new URL(String(u).trim())
    return { origin: x.origin.toLowerCase(), path: x.pathname.replace(/\/+$/, '') || '/', href: `${x.origin.toLowerCase()}${x.pathname.replace(/\/+$/, '') || '/'}` }
  } catch { return null }
}
const showUrl = (u) => normUrl(u)?.href || '(unparseable URL)'

function expectedCallback(env) {
  if (env.CASEY_PUBLIC_WEBHOOK_URL) return { url: env.CASEY_PUBLIC_WEBHOOK_URL, explicit: true }
  if (env.CASEY_PUBLIC_URL) {
    const base = normUrl(env.CASEY_PUBLIC_URL)
    if (base) return { url: base.origin + (env.WHATSAPP_WEBHOOK_PATH || '/webhooks/whatsapp'), explicit: false }
  }
  return null
}

export async function probeMeta({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, now = () => Date.now() } = {}) {
  const token = env.WHATSAPP_API_TOKEN
  const phoneId = env.WHATSAPP_PHONE_NUMBER_ID
  if (!token || !phoneId) return { skipped: 'WhatsApp is not configured', rows: [] }
  const api = (env.WHATSAPP_GRAPH_API || `https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION || 'v20.0'}`).replace(/\/+$/, '')
  const rows = []
  const expected = expectedCallback(env)

  let appId = env.WHATSAPP_APP_ID || ''
  let wabaIds = []
  let offline = false
  try {
    const r = await get(fetchImpl, `${api}/debug_token?input_token=${encodeURIComponent(token)}`, bearer(token), timeoutMs)
    const d = r.body?.data
    if (!r.ok || !d) {
      const why = metaError(r.body) || `HTTP ${r.status}`
      rows.push(row('token', 'fail', `WhatsApp API token was refused by Meta: ${why}`,
        'Generate a new System User token (Meta Business settings -> System users -> Generate token, with whatsapp_business_messaging and whatsapp_business_management) and set WHATSAPP_API_TOKEN.'))
    } else {
      if (!appId && d.app_id) appId = String(d.app_id)
      const exp = Number(d.expires_at) || 0
      const dataExp = Number(d.data_access_expires_at) || 0
      const scopes = Array.isArray(d.scopes) ? d.scopes : []
      wabaIds = [...new Set((d.granular_scopes || []).filter(g => /^whatsapp_business_/.test(g.scope || '')).flatMap(g => g.target_ids || []).map(String))]
      if (d.is_valid === false) {
        rows.push(row('token', 'fail', `WhatsApp API token is no longer valid${d.error?.message ? `: ${String(d.error.message).slice(0, 120)}` : ''}`,
          'Generate a new System User token and set WHATSAPP_API_TOKEN (see the README section "Rotate the WhatsApp token").'))
      } else if (exp > 0) {
        const days = Math.floor((exp * 1000 - now()) / 86400e3)
        if (days < 0) rows.push(row('token', 'fail', 'WhatsApp API token has expired', 'Generate a new System User token (they can be set to never expire) and set WHATSAPP_API_TOKEN.'))
        else if (days < 7) rows.push(row('token', 'fail', `WhatsApp API token expires in ${days} day(s)`, 'Rotate it now: see the README section "Rotate the WhatsApp token".'))
        else if (days < 21) rows.push(row('token', 'warn', `WhatsApp API token expires in ${days} days`, 'A System User token can be generated with no expiry.'))
        else rows.push(row('token', 'ok', `WhatsApp API token valid, expires in ${days} days`))
      } else {
        rows.push(row('token', 'ok', 'WhatsApp API token valid, never expires'))
      }
      if (d.is_valid !== false) {
        if (!scopes.includes('whatsapp_business_messaging')) rows.push(row('token-scope-messaging', 'fail', 'token lacks the whatsapp_business_messaging scope: sending will be refused', 'Regenerate the System User token with whatsapp_business_messaging ticked.'))
        if (!scopes.includes('whatsapp_business_management')) rows.push(row('token-scope-management', 'warn', 'token lacks whatsapp_business_management: casey cannot read the number status or webhook subscription with it', 'Regenerate the token with whatsapp_business_management ticked.'))
        if (dataExp > 0 && dataExp * 1000 < now()) rows.push(row('token-data-access', 'warn', 'the token\'s data access has expired: Meta may refuse reads until access is re-granted', 'Renew data access in the Meta developer console.'))
      }
    }
  } catch (e) {
    if (e.network) offline = true
    else rows.push(row('token', 'warn', `could not check the API token (${e.message})`))
    if (e.network) rows.push(row('meta', 'skip', `Meta checks skipped: ${e.message} reaching graph.facebook.com (offline?)`))
  }
  if (offline) return { skipped: 'offline', rows }

  let registeredCallback = ''
  if (!env.WHATSAPP_APP_SECRET) {
    rows.push(row('subscription', 'skip', 'webhook subscription not checked: WHATSAPP_APP_SECRET is unset', 'Set WHATSAPP_APP_SECRET (Meta app -> Settings -> Basic -> App secret).'))
  } else if (!appId) {
    rows.push(row('subscription', 'skip', 'webhook subscription not checked: the app id could not be determined', 'Set WHATSAPP_APP_ID to the numeric app id (Meta app -> Settings -> Basic).'))
  } else {
    try {
      const appToken = `${appId}|${env.WHATSAPP_APP_SECRET}`
      const r = await get(fetchImpl, `${api}/${encodeURIComponent(appId)}/subscriptions`, bearer(appToken), timeoutMs)
      if (!r.ok) {
        rows.push(row('subscription', 'warn', `could not read the app's webhook subscriptions: ${metaError(r.body) || `HTTP ${r.status}`}. If this says the secret is wrong, inbound signatures will fail too.`,
          'Check WHATSAPP_APP_SECRET (and WHATSAPP_APP_ID) against Meta app -> Settings -> Basic.'))
      } else {
        const subs = Array.isArray(r.body?.data) ? r.body.data : []
        const wa = subs.find(s => s.object === 'whatsapp_business_account')
        const FIX = 'Meta developer console -> your app -> WhatsApp -> Configuration -> Webhook fields -> subscribe "messages" (see the README section "Re-subscribe the webhook fields").'
        if (!wa) {
          rows.push(row('subscription', 'fail', `the app has NO webhook subscription for whatsapp_business_account (subscribed objects: ${subs.map(s => s.object).join(', ') || 'none'}), so Meta will never POST an inbound message`, FIX))
        } else {
          registeredCallback = String(wa.callback_url || '')
          const fields = (wa.fields || []).map(f => (typeof f === 'string' ? f : f?.name)).filter(Boolean)
          if (!fields.includes('messages')) {
            rows.push(row('subscription', 'fail', `the webhook is registered but the "messages" field is NOT subscribed (fields: ${fields.join(', ') || 'none'}), so no inbound message and no delivery status will ever arrive`, FIX))
          } else if (wa.active === false) {
            rows.push(row('subscription', 'fail', 'the whatsapp_business_account webhook subscription is INACTIVE', FIX))
          } else {
            rows.push(row('subscription', 'ok', `webhook subscription active, fields: ${fields.join(', ')}`))
          }

          const reg = normUrl(registeredCallback)
          const listenPath = (env.WHATSAPP_WEBHOOK_PATH || '/webhooks/whatsapp').replace(/\/+$/, '') || '/'
          if (!reg) rows.push(row('callback', 'fail', 'the registered callback URL is missing or unparseable', 'Meta console -> WhatsApp -> Configuration -> Callback URL.'))
          else {
            if (reg.path !== listenPath) rows.push(row('callback-path', 'fail', `Meta posts to path ${reg.path} but casey listens on ${listenPath} (WHATSAPP_WEBHOOK_PATH): every POST would 404`, 'Make WHATSAPP_WEBHOOK_PATH equal the path of the callback URL registered with Meta, or re-register the URL.'))
            if (expected) {
              const want = normUrl(expected.url)
              if (want && want.href !== reg.href) {
                rows.push(row('callback', expected.explicit ? 'fail' : 'warn', `Meta's registered callback URL is ${reg.href} but the public URL is ${want.href}${expected.explicit ? '' : ' (derived from CASEY_PUBLIC_URL)'}`,
                  'Update the callback URL in Meta developer console -> WhatsApp -> Configuration, or correct CASEY_PUBLIC_WEBHOOK_URL.'))
              } else if (want) rows.push(row('callback', 'ok', `registered callback URL matches the public URL (${reg.href})`))
            } else rows.push(row('callback', 'info', `Meta's registered callback URL is ${reg.href} (set CASEY_PUBLIC_WEBHOOK_URL to have doctor compare it with the public URL)`))
          }
        }
      }
    } catch (e) { rows.push(row('subscription', e.network ? 'skip' : 'warn', `webhook subscription not checked (${e.message})`)) }
  }

  if (appId && wabaIds.length) {
    for (const waba of wabaIds.slice(0, 3)) {
      try {
        const r = await get(fetchImpl, `${api}/${encodeURIComponent(waba)}/subscribed_apps`, bearer(token), timeoutMs)
        if (!r.ok) { rows.push(row('waba', 'warn', `could not read which apps are subscribed to WhatsApp Business Account ${waba}: ${metaError(r.body) || `HTTP ${r.status}`}`)); continue }
        const apps = (r.body?.data || []).map(a => String(a?.whatsapp_business_api_data?.id || a?.id || ''))
        if (apps.includes(String(appId))) rows.push(row('waba', 'ok', `app ${appId} is subscribed to WhatsApp Business Account ${waba}`))
        else rows.push(row('waba', 'fail', `app ${appId} is NOT subscribed to WhatsApp Business Account ${waba}: Meta sends nothing for that account to this app`,
          'Meta developer console -> WhatsApp -> Configuration, and re-select the account; or have an admin subscribe the app to the WABA.'))
      } catch (e) { rows.push(row('waba', e.network ? 'skip' : 'warn', `WABA subscription not checked (${e.message})`)) }
    }
  }

  try {
    const fields = 'display_phone_number,verified_name,quality_rating,status,name_status,code_verification_status,messaging_limit_tier,throughput'
    const r = await get(fetchImpl, `${api}/${encodeURIComponent(phoneId)}?fields=${fields}`, bearer(token), timeoutMs)
    if (!r.ok) rows.push(row('phone', 'warn', `could not read the phone number: ${metaError(r.body) || `HTTP ${r.status}`}`, 'Check WHATSAPP_PHONE_NUMBER_ID (Meta console -> WhatsApp -> API setup -> Phone number ID).'))
    else {
      const p = r.body || {}
      const digits = String(p.display_phone_number || '')
      const total = (digits.match(/\d/g) || []).length
      let seen = 0
      const num = digits.replace(/\d/g, (d) => (++seen <= total - 4 ? '*' : d))
      const status = String(p.status || 'UNKNOWN').toUpperCase()
      const quality = String(p.quality_rating || 'UNKNOWN').toUpperCase()
      const tier = p.messaging_limit_tier ? `, limit ${p.messaging_limit_tier}` : ''
      if (status !== 'CONNECTED') rows.push(row('phone', 'fail', `phone number ${num} status is ${status} (needs CONNECTED)`, 'Meta console -> WhatsApp -> API setup, and the WhatsApp Manager phone-number page, for why it is not connected.'))
      else if (quality === 'RED') rows.push(row('phone', 'fail', `phone number ${num} connected but quality rating is RED${tier}: Meta may throttle or block sending`, 'Reduce unsolicited messaging; see WhatsApp Manager -> Quality.'))
      else if (quality === 'YELLOW') rows.push(row('phone', 'warn', `phone number ${num} connected, quality rating YELLOW${tier}`))
      else rows.push(row('phone', 'ok', `phone number ${num} connected, quality ${quality}${tier}`))
      if (p.name_status && !['APPROVED', 'AVAILABLE_WITHOUT_REVIEW'].includes(String(p.name_status).toUpperCase())) rows.push(row('phone-name', 'info', `display name status: ${p.name_status}`))
    }
  } catch (e) { rows.push(row('phone', e.network ? 'skip' : 'warn', `phone number not checked (${e.message})`)) }

  const target = expected?.explicit ? expected.url : (registeredCallback || expected?.url || '')
  if (!target) {
    rows.push(row('reachability', 'skip', 'public callback URL not checked: neither CASEY_PUBLIC_WEBHOOK_URL nor a registered callback URL is known'))
  } else if (!env.WHATSAPP_VERIFY_TOKEN) {
    rows.push(row('reachability', 'skip', 'public callback URL not checked: WHATSAPP_VERIFY_TOKEN is unset'))
  } else if (!normUrl(target)) {
    rows.push(row('reachability', 'fail', 'the callback URL is not a valid URL'))
  } else {
    const challenge = 'casey-doctor-' + crypto.randomBytes(6).toString('hex')
    try {
      const u = new URL(target)
      u.searchParams.set('hub.mode', 'subscribe')
      u.searchParams.set('hub.verify_token', env.WHATSAPP_VERIFY_TOKEN)
      u.searchParams.set('hub.challenge', challenge)
      const r = await fetchImplText(fetchImpl, u.toString(), timeoutMs)
      const shown = showUrl(target)
      if (r.status === 200 && r.text === challenge) rows.push(row('reachability', 'ok', `${shown} answers Meta's verification challenge`))
      else if (r.status === 200) rows.push(row('reachability', 'fail', `${shown} answered 200 but did not echo the challenge: something other than casey's webhook is serving that URL`, 'Point the reverse proxy at casey (dashboard port or CASEY_WEBHOOK_PORT) for exactly this path.'))
      else if (r.status === 403) rows.push(row('reachability', 'fail', `${shown} reached casey but the verify token was refused (403): WHATSAPP_VERIFY_TOKEN here does not match the token in the Meta console`, 'Make WHATSAPP_VERIFY_TOKEN equal the "Verify token" in Meta console -> WhatsApp -> Configuration.'))
      else if (r.status === 401) rows.push(row('reachability', 'fail', `${shown} answered 401: the proxy is forwarding to a service that gates the path behind a login, not to casey's webhook`, 'Forward this path to the dashboard port (casey mounts the webhook there ahead of its login) or to CASEY_WEBHOOK_PORT.'))
      else if (r.status === 404) rows.push(row('reachability', 'fail', `${shown} answered 404: nothing serves that path (casey listens on ${env.WHATSAPP_WEBHOOK_PATH || '/webhooks/whatsapp'})`, 'Check the reverse proxy path mapping and WHATSAPP_WEBHOOK_PATH.'))
      else if (r.status >= 502 && r.status <= 504) rows.push(row('reachability', 'fail', `${shown} answered HTTP ${r.status}: the proxy is up but nothing behind it is answering, so Meta's POSTs fail too (casey stopped, restarting, or the proxy points at the wrong port)`, 'Check that casey is running (casey up / systemd) and the proxy target port matches the dashboard --port or CASEY_WEBHOOK_PORT.'))
      else rows.push(row('reachability', 'fail', `${shown} answered HTTP ${r.status}, not the challenge`, 'Check the reverse proxy and that casey is running.'))
    } catch (e) {
      rows.push(row('reachability', 'fail', `${showUrl(target)} is not reachable: ${e.message}`, 'Check DNS, TLS and that the tunnel/proxy is up and forwarding to casey.'))
    }
  }
  return { skipped: null, rows, appId: appId || null }
}

async function fetchImplText(fetchImpl, url, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: ac.signal, redirect: 'manual' })
    const text = await res.text().catch(() => '')
    return { status: res.status, text }
  } catch (e) {
    const err = new Error(ac.signal.aborted ? 'timed out' : reasonOf(e))
    err.network = true
    throw err
  } finally { clearTimeout(timer) }
}
