

import { truncate } from './heuristics.js'
import { tsMs } from '../timestamp.js'
import { CRITICAL_FIELDS, fieldLabel, missingMandatoryMinimum } from '../store/report-shape.js'

export const LOCATION_STALE_MS = Number(process.env.CASEY_LOCATION_STALE_MS) || 3 * 3600e3

const FENCE_MARKERS = /<<(?:DATA|END)>>/g
export const fenced = (value, max) => `<<DATA>>${truncate(String(value ?? ''), max).replace(FENCE_MARKERS, '[marker]')}<<END>>`

const CONTEXT_KINDS = new Set(['inbound', 'outbound', 'action', 'transition', 'autonomy_change'])

function detectReturnedAfterGap(inboundEvents) {
  if (inboundEvents.length < 2) return false
  const prevMs = tsMs(inboundEvents[inboundEvents.length - 2]?.created_at)
  const lastMs = tsMs(inboundEvents[inboundEvents.length - 1]?.created_at)
  const gapMs = lastMs - prevMs
  return Number.isFinite(gapMs) && gapMs > LOCATION_STALE_MS
}

export function buildPromptContext(caseRow, events) {
  const recent = events.filter(e => CONTEXT_KINDS.has(e.kind)).slice(-12).map(e =>
    `- [${e.created_at}] ${e.kind}/${e.actor}: ${fenced(e.text, 180)}`).join('\n')
  const inboundEvents = events.filter(e => e.kind === 'inbound')
  let reportObj = null
  try { reportObj = caseRow.report ? JSON.parse(caseRow.report) : null } catch { reportObj = null }

  const haveFields = reportObj ? Object.keys(reportObj).filter(k => reportObj[k] != null) : []

  const reportLine = haveFields.length ? haveFields.map(k => `${k}=${fenced(reportObj[k], 80)}`).join('; ') : '(nothing recorded yet)'

  const missingCritical = CRITICAL_FIELDS.filter(k => !haveFields.includes(k))

  const missingMandatory = missingMandatoryMinimum(reportObj).map(fieldLabel)
  return {
    recent,
    firstMessage: inboundEvents.length <= 1,
    returnedAfterGap: detectReturnedAfterGap(inboundEvents),
    reportObj,
    reportLine,
    missingCritical,
    missingMandatory,
  }
}
