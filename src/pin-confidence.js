// pin-confidence.js -- how sure a case's map pin is, as a whole percentage (0-100), kept beside location_source.
//
//   gps        100  a real reading (a WhatsApp location pin, coordinates read out, a ranger's phone): always 100.
//   confirmed  the person agreed to the pin: the figure given, never under 80, 90 when none was given.
//   estimated  the agent's own best guess from a place name: the figure it gave, 1-99, 30 when it gave none.
//
// A number, not a word: the dashboard shows it beside the pin and the team can sort out which pins to trust.
export function pinConfidence(source, given) {
  if (source === 'gps') return 100
  const n = Math.round(Number(given))
  const have = Number.isFinite(n)
  if (source === 'confirmed') return have ? Math.min(100, Math.max(80, n)) : 90
  return have ? Math.min(99, Math.max(1, n)) : 30
}

// ---- the pin's weak points, from the record alone -------------------------------------------------------------
import { parseReport } from './timestamp.js'

export const WEAK_BELOW = 50
export const MAX_PIN_ASKS = 2

// The place words already on the record, in the person's own words: where, and how to find it.
export function placeText(caseRow) {
  const r = parseReport(caseRow) || {}
  return [r.location, r.how_to_find].map(v => String(v ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join('; ').slice(0, 400)
}

// A place is named but the pin is a guess that is missing or under 50% sure. A real reading or a pin the person agreed to is never weak.
export function weakPin(caseRow) {
  if (!caseRow || !placeText(caseRow)) return false
  if (caseRow.location_source === 'gps' || caseRow.location_source === 'confirmed') return false
  const has = caseRow.lat != null && caseRow.lon != null
  const conf = Number(caseRow.location_confidence)
  return !has || !Number.isFinite(conf) || caseRow.location_confidence == null || conf < WEAK_BELOW
}

const askState = (c) => { try { return JSON.parse(c?.pin_ask || '{}') || {} } catch { return {} } }

// The person is owed a request for a better location: the pin is weak, they have been asked fewer than twice, and the place words
// have changed since the last ask (an unanswered ask is never repeated).
export function pinAskOwed(caseRow) {
  if (!weakPin(caseRow)) return false
  const st = askState(caseRow)
  return (Number(st.n) || 0) < MAX_PIN_ASKS && st.basis !== placeText(caseRow)
}
export const pinAskValue = (caseRow) => JSON.stringify({ basis: placeText(caseRow), n: (Number(askState(caseRow).n) || 0) + 1 })
