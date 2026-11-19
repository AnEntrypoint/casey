

import crypto from 'node:crypto'
import { caseyText } from './deployment-text.js';

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
    const err = new Error(ac.signal.aborted ? caseyText("src/meta-probe.js#w0") : reasonOf(e))
    err.network = true
    throw err
  } finally { clearTimeout(timer) }
}

function reasonOf(e) {
  const code = e?.cause?.code || e?.code
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return caseyText("src/meta-probe.js#w1")
  if (code === 'ECONNREFUSED') return caseyText("src/meta-probe.js#w2")
  if (code === 'ECONNRESET') return caseyText("src/meta-probe.js#w3")
  if (code === 'CERT_HAS_EXPIRED' || /CERT|SSL|TLS/i.test(String(code || ''))) return caseyText("src/meta-probe.js#w4", [String(code).slice(0, 40)])
  return caseyText("src/meta-probe.js#w5")
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
const showUrl = (u) => normUrl(u)?.href || caseyText("src/meta-probe.js#w6")

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
  if (!token || !phoneId) return { skipped: caseyText("src/meta-probe.js#w7"), rows: [] }
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
      rows.push(row('token', 'fail', caseyText("src/meta-probe.js#w8", [why]),
        caseyText("src/meta-probe.js#w9")))
    } else {
      if (!appId && d.app_id) appId = String(d.app_id)
      const exp = Number(d.expires_at) || 0
      const dataExp = Number(d.data_access_expires_at) || 0
      const scopes = Array.isArray(d.scopes) ? d.scopes : []
      wabaIds = [...new Set((d.granular_scopes || []).filter(g => /^whatsapp_business_/.test(g.scope || '')).flatMap(g => g.target_ids || []).map(String))]
      if (d.is_valid === false) {
        rows.push(row('token', 'fail', caseyText("src/meta-probe.js#w10", [d.error?.message ? `: ${String(d.error.message).slice(0, 120)}` : '']),
          caseyText("src/meta-probe.js#w11")))
      } else if (exp > 0) {
        const days = Math.floor((exp * 1000 - now()) / 86400e3)
        if (days < 0) rows.push(row('token', 'fail', caseyText("src/meta-probe.js#w12"), caseyText("src/meta-probe.js#w13")))
        else if (days < 7) rows.push(row('token', 'fail', caseyText("src/meta-probe.js#w14", [days]), caseyText("src/meta-probe.js#w15")))
        else if (days < 21) rows.push(row('token', 'warn', caseyText("src/meta-probe.js#w16", [days]), caseyText("src/meta-probe.js#w17")))
        else rows.push(row('token', 'ok', caseyText("src/meta-probe.js#w18", [days])))
      } else {
        rows.push(row('token', 'ok', caseyText("src/meta-probe.js#w19")))
      }
      if (d.is_valid !== false) {
        if (!scopes.includes('whatsapp_business_messaging')) rows.push(row('token-scope-messaging', 'fail', caseyText("src/meta-probe.js#w20"), caseyText("src/meta-probe.js#w21")))
        if (!scopes.includes('whatsapp_business_management')) rows.push(row('token-scope-management', 'warn', caseyText("src/meta-probe.js#w22"), caseyText("src/meta-probe.js#w23")))
        if (dataExp > 0 && dataExp * 1000 < now()) rows.push(row('token-data-access', 'warn', caseyText("src/meta-probe.js#w24"), caseyText("src/meta-probe.js#w25")))
      }
    }
  } catch (e) {
    if (e.network) offline = true
    else rows.push(row('token', 'warn', caseyText("src/meta-probe.js#w26", [e.message])))
    if (e.network) rows.push(row('meta', 'skip', caseyText("src/meta-probe.js#w27", [e.message])))
  }
  if (offline) return { skipped: 'offline', rows }

  let registeredCallback = ''
  if (!env.WHATSAPP_APP_SECRET) {
    rows.push(row('subscription', 'skip', caseyText("src/meta-probe.js#w28"), caseyText("src/meta-probe.js#w29")))
  } else if (!appId) {
    rows.push(row('subscription', 'skip', caseyText("src/meta-probe.js#w30"), caseyText("src/meta-probe.js#w31")))
  } else {
    try {
      const appToken = `${appId}|${env.WHATSAPP_APP_SECRET}`
      const r = await get(fetchImpl, `${api}/${encodeURIComponent(appId)}/subscriptions`, bearer(appToken), timeoutMs)
      if (!r.ok) {
        rows.push(row('subscription', 'warn', caseyText("src/meta-probe.js#w32", [metaError(r.body) || `HTTP ${r.status}`]),
          caseyText("src/meta-probe.js#w33")))
      } else {
        const subs = Array.isArray(r.body?.data) ? r.body.data : []
        const wa = subs.find(s => s.object === 'whatsapp_business_account')
        const FIX = caseyText("src/meta-probe.js#w34")
        if (!wa) {
          rows.push(row('subscription', 'fail', caseyText("src/meta-probe.js#w35", [subs.map(s => s.object).join(', ') || 'none']), FIX))
        } else {
          registeredCallback = String(wa.callback_url || '')
          const fields = (wa.fields || []).map(f => (typeof f === 'string' ? f : f?.name)).filter(Boolean)
          if (!fields.includes('messages')) {
            rows.push(row('subscription', 'fail', caseyText("src/meta-probe.js#w36", [fields.join(', ') || 'none']), FIX))
          } else if (wa.active === false) {
            rows.push(row('subscription', 'fail', caseyText("src/meta-probe.js#w37"), FIX))
          } else {
            rows.push(row('subscription', 'ok', caseyText("src/meta-probe.js#w38", [fields.join(', ')])))
          }

          const reg = normUrl(registeredCallback)
          const listenPath = (env.WHATSAPP_WEBHOOK_PATH || '/webhooks/whatsapp').replace(/\/+$/, '') || '/'
          if (!reg) rows.push(row('callback', 'fail', caseyText("src/meta-probe.js#w39"), caseyText("src/meta-probe.js#w40")))
          else {
            if (reg.path !== listenPath) rows.push(row('callback-path', 'fail', caseyText("src/meta-probe.js#w41", [reg.path, listenPath]), caseyText("src/meta-probe.js#w42")))
            if (expected) {
              const want = normUrl(expected.url)
              if (want && want.href !== reg.href) {
                rows.push(row('callback', expected.explicit ? 'fail' : 'warn', caseyText("src/meta-probe.js#w43", [reg.href, want.href, expected.explicit ? '' : caseyText("src/meta-probe.js#w44")]),
                  caseyText("src/meta-probe.js#w45")))
              } else if (want) rows.push(row('callback', 'ok', caseyText("src/meta-probe.js#w46", [reg.href])))
            } else rows.push(row('callback', 'info', caseyText("src/meta-probe.js#w47", [reg.href])))
          }
        }
      }
    } catch (e) { rows.push(row('subscription', e.network ? 'skip' : 'warn', caseyText("src/meta-probe.js#w48", [e.message]))) }
  }

  if (appId && wabaIds.length) {
    for (const waba of wabaIds.slice(0, 3)) {
      try {
        const r = await get(fetchImpl, `${api}/${encodeURIComponent(waba)}/subscribed_apps`, bearer(token), timeoutMs)
        if (!r.ok) { rows.push(row('waba', 'warn', caseyText("src/meta-probe.js#w49", [waba, metaError(r.body) || `HTTP ${r.status}`]))); continue }
        const apps = (r.body?.data || []).map(a => String(a?.whatsapp_business_api_data?.id || a?.id || ''))
        if (apps.includes(String(appId))) rows.push(row('waba', 'ok', caseyText("src/meta-probe.js#w50", [appId, waba])))
        else rows.push(row('waba', 'fail', caseyText("src/meta-probe.js#w51", [appId, waba]),
          caseyText("src/meta-probe.js#w52")))
      } catch (e) { rows.push(row('waba', e.network ? 'skip' : 'warn', caseyText("src/meta-probe.js#w53", [e.message]))) }
    }
  }

  try {
    const fields = 'display_phone_number,verified_name,quality_rating,status,name_status,code_verification_status,messaging_limit_tier,throughput'
    const r = await get(fetchImpl, `${api}/${encodeURIComponent(phoneId)}?fields=${fields}`, bearer(token), timeoutMs)
    if (!r.ok) rows.push(row('phone', 'warn', caseyText("src/meta-probe.js#w54", [metaError(r.body) || `HTTP ${r.status}`]), caseyText("src/meta-probe.js#w55")))
    else {
      const p = r.body || {}
      const digits = String(p.display_phone_number || '')
      const total = (digits.match(/\d/g) || []).length
      let seen = 0
      const num = digits.replace(/\d/g, (d) => (++seen <= total - 4 ? '*' : d))
      const status = String(p.status || 'UNKNOWN').toUpperCase()
      const quality = String(p.quality_rating || 'UNKNOWN').toUpperCase()
      const tier = p.messaging_limit_tier ? `, limit ${p.messaging_limit_tier}` : ''
      if (status !== 'CONNECTED') rows.push(row('phone', 'fail', caseyText("src/meta-probe.js#w56", [num, status]), caseyText("src/meta-probe.js#w57")))
      else if (quality === 'RED') rows.push(row('phone', 'fail', caseyText("src/meta-probe.js#w58", [num, tier]), caseyText("src/meta-probe.js#w59")))
      else if (quality === 'YELLOW') rows.push(row('phone', 'warn', caseyText("src/meta-probe.js#w60", [num, tier])))
      else rows.push(row('phone', 'ok', caseyText("src/meta-probe.js#w61", [num, quality, tier])))
      if (p.name_status && !['APPROVED', 'AVAILABLE_WITHOUT_REVIEW'].includes(String(p.name_status).toUpperCase())) rows.push(row('phone-name', 'info', caseyText("src/meta-probe.js#w62", [p.name_status])))
    }
  } catch (e) { rows.push(row('phone', e.network ? 'skip' : 'warn', caseyText("src/meta-probe.js#w63", [e.message]))) }

  const target = expected?.explicit ? expected.url : (registeredCallback || expected?.url || '')
  if (!target) {
    rows.push(row('reachability', 'skip', caseyText("src/meta-probe.js#w64")))
  } else if (!env.WHATSAPP_VERIFY_TOKEN) {
    rows.push(row('reachability', 'skip', caseyText("src/meta-probe.js#w65")))
  } else if (!normUrl(target)) {
    rows.push(row('reachability', 'fail', caseyText("src/meta-probe.js#w66")))
  } else {
    const challenge = 'casey-doctor-' + crypto.randomBytes(6).toString('hex')
    try {
      const u = new URL(target)
      u.searchParams.set('hub.mode', 'subscribe')
      u.searchParams.set('hub.verify_token', env.WHATSAPP_VERIFY_TOKEN)
      u.searchParams.set('hub.challenge', challenge)
      const r = await fetchImplText(fetchImpl, u.toString(), timeoutMs)
      const shown = showUrl(target)
      if (r.status === 200 && r.text === challenge) rows.push(row('reachability', 'ok', caseyText("src/meta-probe.js#w67", [shown])))
      else if (r.status === 200) rows.push(row('reachability', 'fail', caseyText("src/meta-probe.js#w68", [shown]), caseyText("src/meta-probe.js#w69")))
      else if (r.status === 403) rows.push(row('reachability', 'fail', caseyText("src/meta-probe.js#w70", [shown]), caseyText("src/meta-probe.js#w71")))
      else if (r.status === 401) rows.push(row('reachability', 'fail', caseyText("src/meta-probe.js#w72", [shown]), caseyText("src/meta-probe.js#w73")))
      else if (r.status === 404) rows.push(row('reachability', 'fail', caseyText("src/meta-probe.js#w74", [shown, env.WHATSAPP_WEBHOOK_PATH || '/webhooks/whatsapp']), caseyText("src/meta-probe.js#w75")))
      else if (r.status >= 502 && r.status <= 504) rows.push(row('reachability', 'fail', caseyText("src/meta-probe.js#w76", [shown, r.status]), caseyText("src/meta-probe.js#w77")))
      else rows.push(row('reachability', 'fail', caseyText("src/meta-probe.js#w78", [shown, r.status]), caseyText("src/meta-probe.js#w79")))
    } catch (e) {
      rows.push(row('reachability', 'fail', caseyText("src/meta-probe.js#w80", [showUrl(target), e.message]), caseyText("src/meta-probe.js#w81")))
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
    const err = new Error(ac.signal.aborted ? caseyText("src/meta-probe.js#w82") : reasonOf(e))
    err.network = true
    throw err
  } finally { clearTimeout(timer) }
}
