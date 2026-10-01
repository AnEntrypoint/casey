// quota-watch.js -- checks the model provider's remaining balance on a timer and tells a Discord channel each time it
// falls through a 10% step.
//
// Synthetic publishes its balance at GET <base>/v2/quotas (with the same API key as the chat calls): the weekly credit
// ceiling (`weeklyTokenLimit.percentRemaining`, dollars left) and the rolling five-hour request allowance
// (`rollingFiveHourLimit.remaining / max`). Each is turned into a "percent left" and then into a step (90, 80, ... 0).
// A message goes out when either one has fallen to a LOWER step than the last one told, naming both. A rise (the
// allowance regenerating) is recorded silently so the next fall through that step is told again. The first check
// posts one baseline message. The last told steps live in <cwd>/data/quota-watch.json, so a restart does not repeat
// itself, and a failed post leaves them unchanged so the next check tries again.
//
// Off unless CASEY_QUOTA_DISCORD_CHANNEL (the channel id) and SYNTHETIC_API_KEY and a Discord bot token are set.
//   CASEY_QUOTA_INTERVAL_MS   check interval, default 1800000 (30 minutes)
//   CASEY_QUOTA_STEP          step in percent, default 10
//   CASEY_QUOTA_URL           default https://api.synthetic.new/v2/quotas
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

// The two "percent left" figures out of the provider's answer; null for one it did not report.
export function readQuotas(j) {
  const w = j?.weeklyTokenLimit, f = j?.rollingFiveHourLimit
  const weekly = Number.isFinite(Number(w?.percentRemaining)) ? Number(w.percentRemaining) : null
  const five = Number(f?.max) > 0 && Number.isFinite(Number(f?.remaining)) ? 100 * Number(f.remaining) / Number(f.max) : null
  return { weekly, five, raw: j }
}

const fmt = (n) => `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10}%`
export function describe(q) {
  const w = q.raw?.weeklyTokenLimit, f = q.raw?.rollingFiveHourLimit
  const parts = []
  if (q.weekly != null) parts.push(`weekly credits ${fmt(q.weekly)} left${w?.remainingCredits ? ` (${w.remainingCredits} of ${w.maxCredits})` : ''}${w?.nextRegenAt ? `, next ${w.nextRegenCredits || 'top-up'} at ${String(w.nextRegenAt).slice(11, 16)} UTC` : ''}`)
  if (q.five != null) parts.push(`five-hour requests ${fmt(q.five)} left (${f.remaining} of ${f.max})${f.limited ? ', LIMITED now' : ''}`)
  return parts.join('; ')
}

const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {} } catch { return {} } }
const writeState = (s) => { try { fs.mkdirSync(path.dirname(stateFile()), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(s)) } catch { /* the next check just re-tells */ } }

async function post(cfg, content) {
  const r = await fetch(`${cfg.api}/channels/${cfg.channel}/messages`, {
    method: 'POST', headers: { authorization: `Bot ${cfg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(20000),
  })
  if (!r.ok) throw new Error(`discord ${r.status}`)
}

// One check. Returns what it did, for the log: 'off' | 'baseline' | 'told' | 'quiet'. Throws nothing.
export async function checkQuota({ log } = {}) {
  const cfg = quotaConfig()
  if (!cfg) return 'off'
  try {
    const r = await fetch(cfg.url, { headers: { authorization: `Bearer ${cfg.key}` }, signal: AbortSignal.timeout(20000) })
    if (!r.ok) throw new Error(`quotas ${r.status}`)
    const q = readQuotas(await r.json())
    const now = { weekly: q.weekly == null ? null : bucket(q.weekly), five: q.five == null ? null : bucket(q.five) }
    const prev = readState()
    if (prev.weekly === undefined && prev.five === undefined) {
      await post(cfg, `Synthetic balance, now watching every ${Math.round((Number(process.env.CASEY_QUOTA_INTERVAL_MS) || 1800000) / 60000)} minutes and telling you at each ${STEP()}% step: ${describe(q)}.`)
      writeState(now)
      return 'baseline'
    }
    const fell = (k) => now[k] != null && prev[k] != null && now[k] < prev[k]
    if (fell('weekly') || fell('five')) {
      const below = [fell('weekly') ? `weekly credits below ${prev.weekly}%` : null, fell('five') ? `five-hour requests below ${prev.five}%` : null].filter(Boolean).join(' and ')
      await post(cfg, `Synthetic balance: ${below}. Now: ${describe(q)}.`)
      writeState({ weekly: now.weekly ?? prev.weekly, five: now.five ?? prev.five })
      return 'told'
    }
    // Rose, or unchanged: remember the step so a later fall through it is told again.
    if (now.weekly !== prev.weekly || now.five !== prev.five) writeState({ weekly: now.weekly ?? prev.weekly, five: now.five ?? prev.five })
    return 'quiet'
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
