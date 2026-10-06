import { tagList } from '../timestamp.js'
import { evData } from '../safe.js'
import { STOP_PENDING_PREFIX } from './heuristics.js'
import { observation } from './case-writes.js'

export const STOP_PENDING_TTL_MS = 24 * 3600e3

export const stopPendingTag = (nowMs = Date.now()) => `${STOP_PENDING_PREFIX}${Math.floor(nowMs / 1000)}`

export function stopPendingState(caseRow, events, nowMs = Date.now()) {
  const tag = tagList(caseRow).find(t => t.startsWith(STOP_PENDING_PREFIX))
  if (!tag) return null
  const setAtMs = Number(tag.slice(STOP_PENDING_PREFIX.length)) * 1000
  const lastInbound = events.filter(e => e.kind === 'inbound').at(-1)
  const lastConfirm = events.filter(e => e.kind === 'observation' && evData(e).stop_confirm === true).at(-1)
  return {
    tag,
    valid: Number.isFinite(setAtMs) && nowMs - setAtMs < STOP_PENDING_TTL_MS,
    sameTurn: !!lastInbound && !!lastConfirm && evData(lastConfirm).stop_inbound === lastInbound.id,
  }
}

export function stopConfirmEvent(events, actor) {
  const lastInbound = events.filter(e => e.kind === 'inbound').at(-1)
  if (!lastInbound) throw new Error('STOP-CONFIRM needs the inbound message that asked to stop, and none is recorded')
  const text = 'STOP-CONFIRM: contact asked to stop; waiting for them to confirm. Messages continue until they do.'
  return observation(text, { stop_confirm: true, stop_inbound: lastInbound.id, ...actor })
}
