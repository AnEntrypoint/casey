

import {
  isResumeCandidate, scanTurnMarkers, selectPendingTurn,
} from './casey-resume-scan.js'
import {
  deadLetterExhaustedCase, markResumeAttempted, redrivePendingTurn, spaceRedrives,
} from './casey-resume-redrive.js'

export async function resumePendingTurnsBody({ store, log, gateway, adapters, handle, isClaimed = null }, { maxCases, maxRedrives, spacingMs }) {
  let scanned = 0, resumed = 0, skippedLive = 0
  const openStatuses = new Set(store.getOpenStatuses?.() || [])
  const rows = await store.listCases({}, { limit: maxCases, offset: 0 })
  for (const c of rows) {
    if (resumed >= maxRedrives) break
    if (!isResumeCandidate(c, { openStatuses, adapters })) continue

    if (isClaimed && isClaimed(c.external_id)) {
      skippedLive++
      log?.info?.('[casey] resume sweep skipping a conversation with a live turn in flight', { caseId: c.id, channel: c.channel })
      continue
    }
    let events
    try { events = await store.listEvents(c.id) } catch { continue }
    scanned++
    const { pending, anyCapped } = selectPendingTurn(scanTurnMarkers(events), Date.now())
    if (!pending) {
      if (anyCapped) await deadLetterExhaustedCase(store, log, c)
      continue
    }
    await spaceRedrives(resumed, spacingMs)
    if (!await markResumeAttempted(store, log, c, pending.id)) continue
    if (await redrivePendingTurn({ store, log, gateway, handle }, c, pending)) resumed++
  }

  log?.info?.('[casey] resume sweep complete', { scanned, resumed, skippedLive })
  return { scanned, resumed, skippedLive }
}
