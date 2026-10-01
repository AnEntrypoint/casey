// quota-watch.js -- checks the model provider's remaining balance on a timer and tells a Discord channel each time it
// falls through a 10% step.
//
// Synthetic publishes its balance at GET <base>/v2/quotas (with the same API key as the chat calls): the weekly credit
// ceiling (`weeklyTokenLimit.percentRemaining`, dollars left) and the rolling five-hour request allowance
// (`rollingFiveHourLimit.remaining / max`). Each is turned into a "percent left" and then into a step (90, 80, ... 0).
// Each is tracked and told ON ITS OWN (its own told step, its own message). A message goes out when one has fallen below the last step told. A rise (the
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
// One allowance in words. Each of the two is described, tracked and told about on its own.
const LABEL = { weekly: 'weekly credits', five: 'five-hour requests' }
export function describe(q, k) {
  const w = q.raw?.weeklyTokenLimit, f = q.raw?.rollingFiveHourLimit
  if (k === 'weekly' && q.weekly != null) return `${fmt(q.weekly)} left${w?.remainingCredits ? ` (${w.remainingCredits} of ${w.maxCredits})` : ''}${w?.nextRegenAt ? `, next ${w.nextRegenCredits || 'top-up'} at ${String(w.nextRegenAt).slice(11, 16)} UTC` : ''}`
  if (k === 'five' && q.five != null) return `${fmt(q.five)} left (${Math.round(Number(f.remaining))} of ${f.max})${f.limited ? ', LIMITED now' : ''}`
  return ''
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
    // Each allowance has its own told step in the state file and its own message: a fall in one never waits on, bundles with,
    // or re-tells the other. The step is written only after its own post succeeded, so a failed post is retried next check.
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
        } else if (step !== prev[k]) state[k] = step   // regenerated: remembered silently, so the next fall through it is told again
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
