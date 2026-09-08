// casey-resume.js -- the boot-time stuck-turn resume sweep.
//
// It reads the event log for turns that started and never completed, decides
// which are still worth re-driving, and re-drives them spaced apart so a boot
// cannot stampede the provider.
//
// Every input is an explicit parameter: the algorithm's real inputs are four
// collaborators, so reading it never means knowing what else lives on Casey.
//
// The loop below is the sweep's shape; the two halves it calls out to are the
// sweep's judgement and the sweep's effects, each in its own sibling:
//   casey-resume-scan.js    pure -- eligibility, the marker walk, and which
//                           msgId (if any) is genuinely still pending, including
//                           both retry caps and the tsMs timestamp discipline
//   casey-resume-redrive.js the writes -- dead-letter, the pre-drive marker, the
//                           real re-drive through the handler, and the spacing
import {
  isResumeCandidate, scanTurnMarkers, selectPendingTurn,
} from './casey-resume-scan.js'
import {
  deadLetterExhaustedCase, markResumeAttempted, redrivePendingTurn, spaceRedrives,
} from './casey-resume-redrive.js'

export async function resumePendingTurnsBody({ store, log, gateway, adapters, handle }, { maxCases, maxRedrives, spacingMs }) {
  let scanned = 0, resumed = 0
  const openStatuses = new Set(store.getOpenStatuses?.() || [])
  const rows = await store.listCases({}, { limit: maxCases, offset: 0 })
  for (const c of rows) {
    if (resumed >= maxRedrives) break
    if (!isResumeCandidate(c, { openStatuses, adapters })) continue
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
  // Always log the sweep's outcome, not just when it actually redrove
  // something -- a silent "nothing happened" completion is exactly as
  // important to see as a busy one when diagnosing whether the sweep is
  // running at all vs. genuinely idle vs. quietly stuck.
  log?.info?.('[casey] resume sweep complete', { scanned, resumed })
  return { scanned, resumed }
}
