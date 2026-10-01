

import crypto from 'node:crypto'
import { taggedObservations } from './store/settings-log.js'
import { peekSingletonCaseId, scrubRosterFor } from './team-roster.js'

const KEY = 'feedback'
const TAG = 'feedback'
export const MAX_TEXT = 600
export const MAX_PER_DAY = 20
const DAY = 24 * 3600e3

const cleanText = (t) => String(t == null ? '' : t)
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, ' ')
  .replace(/\+?\d[\d\s().-]{7,}\d/g, '[number]')
  .replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)

function parse(events) {
  const out = []
  for (const { payload } of taggedObservations(events, TAG)) {
    try { const r = JSON.parse(payload); if (r?.id) out.push(r) } catch {  }
  }
  return out
}

export async function addFeedback(store, { from = '', tier = 'reporter', lang = '', text = '', caseId = '', source = 'whatsapp', now = Date.now() } = {}) {
  const t = cleanText(text)
  if (!t) return { ok: false, reason: 'empty' }
  const caseKey = await store._systemSingletonCaseId(KEY, KEY)
  return store._withLock(`${KEY}|${from || '-'}`, async () => {
    const mine = parse(await store.listEvents(caseKey).catch(() => [])).filter(r => r.c === String(from) && now - r.at < DAY)
    if (mine.length >= MAX_PER_DAY) return { ok: false, reason: 'limit' }
    const rec = {
      id: crypto.randomBytes(5).toString('hex'), at: now, c: String(from).slice(0, 80), t: String(tier === 'reporter' ? 'reporter' : tier).slice(0, 40),
      l: String(lang || '').replace(/[^A-Za-z -]/g, '').slice(0, 24), v: String(caseId || '').slice(0, 64), s: source === 'gui' ? 'gui' : 'whatsapp', x: t,
    }
    await store.appendEvent(caseKey, { kind: 'observation', actor: 'contact', text: `${TAG}:${JSON.stringify(rec)}`, data: { op: 'feedback', source: rec.s } })
    return { ok: true, id: rec.id }
  })
}

const weekStart = (ms) => {
  const d = new Date(ms)
  const back = (d.getUTCDay() + 6) % 7
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10)
}

export async function listFeedback(store, { limit = 50, nameOf = null } = {}) {
  const caseId = await peekSingletonCaseId(store, KEY)
  const all = caseId ? parse(await store.listEvents(caseId).catch(() => [])) : []
  all.sort((a, b) => b.at - a.at)
  const weeks = new Map(), tiers = new Map()
  for (const r of all) { const w = weekStart(r.at); weeks.set(w, (weeks.get(w) || 0) + 1); tiers.set(r.t, (tiers.get(r.t) || 0) + 1) }
  const n = Math.min(Math.max(Math.floor(Number(limit)) || 50, 1), 200)
  const items = []
  for (const r of all.slice(0, n)) {
    const erased = r.x === '[erased]'
    items.push({ id: r.id, at: r.at, from: erased ? '[erased]' : (nameOf ? await nameOf(r.c) : r.c), tier: r.t, language: r.l, source: r.s, conversation: r.v, text: r.x })
  }
  return {
    total: all.length,
    by_week: [...weeks.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([week, count]) => ({ week, count })),
    by_tier: Object.fromEntries(tiers),
    items,
  }
}

export async function feedbackCounts(store, now = Date.now()) {
  const caseId = await peekSingletonCaseId(store, KEY)
  const all = caseId ? parse(await store.listEvents(caseId).catch(() => [])) : []
  return { total: all.length, last_7_days: all.filter(r => now - r.at < 7 * DAY).length }
}

export async function scrubPersonalLogs(store, contactIds, user) {
  const ids = new Set((contactIds || []).map(String).filter(Boolean))
  let n = await scrubRosterFor(store, [...ids], user)
  const caseId = await peekSingletonCaseId(store, KEY)
  if (!caseId || !ids.size) return n
  const evs = await store.t.list('event', { case_id: caseId }, { limit: 100000 }).catch(() => [])
  for (const e of evs) {
    if (typeof e.text !== 'string' || !e.text.startsWith(`${TAG}:`)) continue
    let r; try { r = JSON.parse(e.text.slice(TAG.length + 1)) } catch { continue }
    if (!ids.has(String(r.c)) || r.x === '[erased]') continue
    r.c = '[erased]'; r.x = '[erased]'; r.v = ''
    try { await store.t.update('event', e.id, { text: `${TAG}:${JSON.stringify(r)}` }, user); n++ } catch {  }
  }
  return n
}
