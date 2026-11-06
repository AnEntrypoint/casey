

import { mergeTag } from './hooks/heuristics.js'
import { replayMessage } from './hooks/replay-message.js'

export async function deadLetterExhaustedCase(store, log, c) {
  try {
    await store.updateCase(c.id, { tags: mergeTag(mergeTag(c.tags, 'resume-exhausted'), 'needs-human') })

    await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: 'resume-exhausted: every pending message hit the resume-degraded retry cap; this case will no longer be auto-resumed and needs a human.', data: { dead_lettered: true, reason: 'resume-exhausted' } })
  } catch (e) { log?.warn?.('[casey] resume-exhausted tag failed', { caseId: c.id, error: e.message }) }
}

export async function markResumeAttempted(store, log, c, msgId) {
  try {
    await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `resume-attempted:${msgId}` })
    return true
  } catch (e) {
    log?.warn?.('[casey] resume marker failed', { caseId: c.id, error: e.message })
    return false
  }
}

export async function redrivePendingTurn({ store, log, gateway, handle }, c, pending) {
  try {
    const res = await handle.call(gateway, c.channel, replayMessage(c, pending.ev, { resume: true }))

    if (res && res.buffered) {
      log?.info?.('[casey] resume re-drive was buffered behind a live turn; not counted as resumed', { caseId: c.id, channel: c.channel })
      return false
    }
    if (res && res.degraded) {
      log?.warn?.('[casey] resumed turn came back degraded; still no reply', { caseId: c.id, channel: c.channel })
      try { await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `resume-degraded:${pending.id}` }) }
      catch (e2) { log?.warn?.('[casey] resume-degraded marker failed', { caseId: c.id, error: e2.message }) }
    } else {
      log?.info?.('[casey] resumed pending turn', { caseId: c.id, channel: c.channel })
    }
    return true
  } catch (e) {

    log?.warn?.('[casey] resume re-drive failed', { caseId: c.id, error: e.message })
    return false
  }
}

export async function spaceRedrives(resumed, spacingMs) {
  if (!(resumed > 0 && spacingMs > 0)) return
  const jitter = spacingMs * (0.8 + Math.random() * 0.4)
  await new Promise(r => setTimeout(r, jitter))
}
