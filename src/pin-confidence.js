

export function pinConfidence(source, given) {
  if (source === 'gps') return 100
  const n = Math.round(Number(given))
  const have = Number.isFinite(n)
  if (source === 'confirmed') return have ? Math.min(100, Math.max(80, n)) : 90
  return have ? Math.min(99, Math.max(1, n)) : 30
}

import { parseReport } from './timestamp.js'

export const WEAK_BELOW = 50
export const MAX_PIN_ASKS = 2

export function placeText(caseRow) {
  const r = parseReport(caseRow) || {}
  return [r.location, r.how_to_find].map(v => String(v ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join('; ').slice(0, 400)
}

export function weakPin(caseRow) {
  if (!caseRow || !placeText(caseRow)) return false
  if (caseRow.location_source === 'gps' || caseRow.location_source === 'confirmed') return false
  const has = caseRow.lat != null && caseRow.lon != null
  const conf = Number(caseRow.location_confidence)
  return !has || !Number.isFinite(conf) || caseRow.location_confidence == null || conf < WEAK_BELOW
}

const askState = (c) => { try { return JSON.parse(c?.pin_ask || '{}') || {} } catch { return {} } }

export function pinAskOwed(caseRow) {
  if (!weakPin(caseRow)) return false
  const st = askState(caseRow)
  return (Number(st.n) || 0) < MAX_PIN_ASKS && st.basis !== placeText(caseRow)
}
export const pinAskValue = (caseRow) => JSON.stringify({ basis: placeText(caseRow), n: (Number(askState(caseRow).n) || 0) + 1 })
