

import fs from 'node:fs'
import path from 'node:path'

const STEP = () => Math.max(1, Number(process.env.CASEY_QUOTA_STEP) || 10)
const stateFile = () => path.resolve(process.cwd(), 'data', 'quota-watch.json')
const bucket = (pct) => Math.max(0, Math.floor(pct / STEP()) * STEP())

export const quotaConfig = () => {
  const channel = String(process.env.CASEY_QUOTA_DISCORD_CHANNEL || '').trim()
  const key = String(process.env.SYNTHETIC_API_KEY || '').trim()
  const token = String(process.env.DISCORD_BOT_TOKEN || '').trim()
  if (!channel || !key || !token) return null
  return { channel, key, token, url: process.env.CASEY_QUOTA_URL || 'https://api.synthetic.new/v2/quotas', api: process.env.CASEY_DISCORD_API || 'https://discord.com/api/v10' }
}

export function readQuotas(j) {
  const w = j?.weeklyTokenLimit, f = j?.rollingFiveHourLimit
  const weekly = Number.isFinite(Number(w?.percentRemaining)) ? Number(w.percentRemaining) : null
  const five = Number(f?.max) > 0 && Number.isFinite(Number(f?.remaining)) ? 100 * Number(f.remaining) / Number(f.max) : null
  return { weekly, five, raw: j }
}

const fmt = (n) => `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10}%`

const LABEL = { weekly: 'weekly credits', five: 'five-hour requests' }
export function describe(q, k) {
  const w = q.raw?.weeklyTokenLimit, f = q.raw?.rollingFiveHourLimit
  if (k === 'weekly' && q.weekly != null) return `${fmt(q.weekly)} left${w?.remainingCredits ? ` (${w.remainingCredits} of ${w.maxCredits})` : ''}${w?.nextRegenAt ? `, next ${w.nextRegenCredits || 'top-up'} at ${String(w.nextRegenAt).slice(11, 16)} UTC` : ''}`
  if (k === 'five' && q.five != null) return `${fmt(q.five)} left (${Math.round(Number(f.remaining))} of ${f.max})${f.limited ? ', LIMITED now' : ''}`
  return ''
}

const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {} } catch { return {} } }
const writeState = (s) => { try { fs.mkdirSync(path.dirname(stateFile()), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(s)) } catch {  } }

async function post(cfg, content) {
  const r = await fetch(`${cfg.api}/channels/${cfg.channel}/messages`, {
    method: 'POST', headers: { authorization: `Bot ${cfg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(20000),
  })
  if (!r.ok) throw new Error(`discord ${r.status}`)
}

export async function checkQuota({ log } = {}) {
  const cfg = quotaConfig()
  if (!cfg) return 'off'
  try {
    const r = await fetch(cfg.url, { headers: { authorization: `Bearer ${cfg.key}` }, signal: AbortSignal.timeout(20000) })
    if (!r.ok) throw new Error(`quotas ${r.status}`)
    const q = readQuotas(await r.json())

    const prev = readState()
    const every = Math.round((Number(process.env.CASEY_QUOTA_INTERVAL_MS) || 1800000) / 60000)
    const state = { ...prev }
    let did = 'quiet'
    for (const k of ['weekly', 'five']) {
      if (q[k] == null) continue
      const step = bucket(q[k])
      try {
        if (prev[k] === undefined) {
          await post(cfg, `Synthetic ${LABEL[k]}: now watching every ${every} minutes, telling you at each ${STEP()}% step. ${describe(q, k)}.`)
          state[k] = step; did = 'baseline'
        } else if (step < prev[k]) {
          await post(cfg, `Synthetic ${LABEL[k]} fell below ${prev[k]}%. ${describe(q, k)}.`)
          state[k] = step; did = 'told'
        } else if (step !== prev[k]) state[k] = step
      } catch (e) { log?.warn?.('[casey] quota post failed', { which: k, error: e.message }); did = 'failed' }
    }
    writeState(state)
    return did
  } catch (e) {
    log?.warn?.('[casey] quota check failed', { error: e.message })
    return 'failed'
  }
}

export function startQuotaWatch({ log, intervalMs = Number(process.env.CASEY_QUOTA_INTERVAL_MS) || 30 * 60e3 } = {}) {
  if (!quotaConfig()) return null
  const run = () => checkQuota({ log }).then(r => { if (r !== 'quiet') log?.info?.('[casey] quota check', { result: r }) }).catch(() => {})
  const first = setTimeout(run, 15e3)
  const timer = setInterval(run, intervalMs)
  first.unref?.(); timer.unref?.()
  return () => { clearTimeout(first); clearInterval(timer) }
}
