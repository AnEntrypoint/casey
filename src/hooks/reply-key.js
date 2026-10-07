import { evData } from '../safe.js'

const isReplyKind = (e) => e.kind === 'outbound' || e.kind === 'draft'

function keyedTo(e, ids) {
  const d = evData(e)
  return d.delivered !== false && Array.isArray(d.in_reply_to) && ids.some(id => d.in_reply_to.includes(id))
}

export const isRealReplyFor = (ids) => (e) => isReplyKind(e) && evData(e).guaranteedFallback !== true && keyedTo(e, ids)

export const isFallbackFor = (ids) => (e) => e.kind === 'outbound' && evData(e).guaranteedFallback === true && keyedTo(e, ids)

export async function recordedFor(store, caseIds, match) {
  for (const caseId of new Set(caseIds.filter(Boolean))) {
    if ((await store.listEvents(caseId)).some(match)) return true
  }
  return false
}
