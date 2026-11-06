import { parseReport } from './timestamp.js'

export const MAX_AREA_ASKS = 2

export function generalAreaText(caseRow) {
  const r = parseReport(caseRow) || {}
  return String(r.location ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

const askState = (c) => { try { return JSON.parse(c?.pin_ask || '{}') || {} } catch { return {} } }

export function areaAskOwed(caseRow) {
  if (!caseRow || generalAreaText(caseRow)) return false
  return (Number(askState(caseRow).n) || 0) < MAX_AREA_ASKS
}

export const areaAskValue = (caseRow) => JSON.stringify({ n: (Number(askState(caseRow).n) || 0) + 1 })
