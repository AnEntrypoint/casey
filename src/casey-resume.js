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

export async function resumePendingTurnsBody({ store, log, gateway, adapters, handle, isClaimed = null }, { maxCases, maxRedrives, spacingMs }) {
  let scanned = 0, resumed = 0, skippedLive = 0
  const openStatuses = new Set(store.getOpenStatuses?.() || [])
  const rows = await store.listCases({}, { limit: maxCases, offset: 0 })
  for (const c of rows) {
    if (resumed >= maxRedrives) break
    if (!isResumeCandidate(c, { openStatuses, adapters })) continue
    // A LIVE turn already holds this conversation: skip it entirely, before the
    // event fetch and before any marker is written.
    //
    // The sweep's premise is that an inbound with no outbound after it belongs to
    // a turn nobody is running any more. From the event log alone that is
    // indistinguishable from a turn still inside its own hard deadline (up to
    // CASEY_TURN_HARD_DEADLINE_MS of legitimate retrying), and the boot sweep
    // walks cases spaced seconds apart, so a message arriving moments after boot
    // is routinely still live when the sweep reaches its case. Witnessed live
    // over Discord: one inbound msg_id carrying two TURN-START markers 32s apart
    // with no restart between them.
    //
    // Re-driving into a live claim loses BOTH ways, which is why this is a skip
    // and not a retry: hooks/handler.js buffers the re-drive and replays it as a
    // whole extra turn once the live one finishes, so one inbound gets answered
    // twice -- and markResumeAttempted has already written a marker that, with no
    // resume-degraded marker beside it, makes every LATER boot read the msgId as
    // a silent completion and never look at it again. The claim is the only
    // signal that separates the two states, so it is checked FIRST.
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
  // Always log the sweep's outcome, not just when it actually redrove
  // something -- a silent "nothing happened" completion is exactly as
  // important to see as a busy one when diagnosing whether the sweep is
  // running at all vs. genuinely idle vs. quietly stuck.
  log?.info?.('[casey] resume sweep complete', { scanned, resumed, skippedLive })
  return { scanned, resumed, skippedLive }
}
