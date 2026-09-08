// casey-drain.js -- draining turns that were QUEUED while the LLM backend was
// down, once it comes back.
//
// The sibling of casey-resume.js: both re-drive turns the live path could not
// finish, from the same four collaborators. They stay separate modules because
// they answer different questions -- resume asks "what did a crash leave
// half-done", this asks "what did an outage refuse to start" -- and their retry
// and ageing rules differ accordingly. Do not merge them.
//
// The Casey class owns the `_draining` re-entrancy guard, shared with
// resumePendingTurns so an LLM-recovery edge during boot cannot double-drive
// the same msgId.
import { tagList, tsMs } from './timestamp.js'
import { splitExternalId } from './hooks/handler.js'

export async function drainQueuedTurnsBody({ store, log, gateway, adapters }, { maxCases, maxRedrives, retryCap }) {
  const handle = gateway?.handleInbound
  let scanned = 0, drained = 0
  {
    const openStatuses = new Set(store.getOpenStatuses?.() || [])
    const rows = await store.listCases({}, { limit: maxCases, offset: 0 })
    for (const c of rows) {
      if (drained >= maxRedrives) break
      if (openStatuses.size && !openStatuses.has(c.status)) continue
      if (!adapters[c.channel]?.send) continue
      let events
      try { events = await store.listEvents(c.id) } catch { continue }
      // Per msgId: the queued inbound, whether an outbound/draft completed it, the
      // attempt count, and whether it was dead-lettered.
      const queued = new Map()        // msgId -> inbound event
      const completedAfter = new Set()
      const attempts = new Map()      // msgId -> count
      const dead = new Set()
      for (const ev of events) {
        if (ev.kind === 'inbound' && ev.msg_id) { /* inbound seen; queued only if marked below */ }
        if (ev.kind === 'observation' && typeof ev.text === 'string') {
          let m = ev.text.match(/^QUEUED-FOR-AGENT:(.+)$/)
          if (m) { const inb = events.find(e => e.kind === 'inbound' && e.msg_id === m[1]); if (inb) queued.set(m[1], inb) }
          m = ev.text.match(/^queue-drive-(?:attempted|retry):(.+)$/)
          if (m) attempts.set(m[1], (attempts.get(m[1]) || 0) + 1)
          m = ev.text.match(/^queue-drive-failed:(.+)$/)
          if (m) dead.add(m[1])
        }
        if (ev.kind === 'outbound' || ev.kind === 'draft') {
          for (const id of queued.keys()) completedAfter.add(id)
        }
      }
      // All still-queued msgIds, oldest-first.
      const pending = [...queued.entries()]
        .filter(([id]) => !completedAfter.has(id) && !dead.has(id))
        .sort((a, b) => a[1].created_at - b[1].created_at)
      if (!pending.length) continue
      scanned++
      for (const [id, ev] of pending) {
        if (drained >= maxRedrives) break
        // queuedRedrive marks this as a QUEUE re-drive (vs a boot resume): a
        // degraded turn then records an observation instead of an outbound so
        // the queued msgId is never positionally burned.
        //
        // external_id is the CASE IDENTITY (conversationKey's own "container:author"
        // shape on a multi-author channel -- see hooks/handler.js's conversationKey/
        // replyTarget split) -- it is NOT a valid Discord channel snowflake on its
        // own. It must be split before use, never passed through combined:
        // replyTarget(msg) reads msg.raw.channel_id directly, so a combined
        // external_id reaches Discord as an invalid channel id (400 Invalid Form
        // Body, NUMBER_TYPE_COERCE) and the queued reply silently never reaches
        // the contact; and passing it through as `from` lets conversationKey()
        // recombine it into an ever-growing container:container:...:author on
        // every redrive. Recover the real container id (the FIRST segment) and
        // the real author id (the LAST segment). Taking the last segment also
        // self-heals an already-corrupted multi-segment key back to a clean
        // two-part one on this redrive's own write.
        const { container, author } = splitExternalId(c.external_id)
        const msg = { from: author, text: ev.text || '', platform: c.channel, resume: true, queuedRedrive: true, raw: { channel_id: container, id, author: {} } }
        try {
          const res = await handle.call(gateway, c.channel, msg)
          // A DEGRADED re-drive (the turn ended in the fallback path -- the agent
          // never actually understood the message) is a FAILED attempt, not a
          // completion: count it toward the retry cap and keep the msg queued.
          if (res && res.degraded) {
            const n = (attempts.get(id) || 0) + 1
            log?.warn?.('[casey] queue drive degraded', { caseId: c.id, msgId: id, attempt: n })
            if (n >= retryCap) {
              // queueStatus() parses the queue-drive-failed:<id> text prefix to
              // reconstruct WHICH msgId dead-lettered, so that prefix must stay.
              // data.dead_lettered rides alongside it so GET /api/turns/degraded
              // can also surface this as an explicit, queryable terminal state.
              try { await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `queue-drive-failed:${id}`, data: { dead_lettered: true, reason: 'queue-drive-degraded-exhausted', msg_id: id } }) } catch { /* best effort */ }
            } else {
              try { await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `queue-drive-retry:${id}` }) } catch { /* best effort */ }
            }
            // The backend is evidently still shaky -- stop this case's drain.
            break
          }
          // Mark attempted only AFTER a successful drive (handle sends/records
          // the reply). A throw skips the marker so the message stays queued.
          await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `queue-drive-attempted:${id}` })
          drained++
        } catch (e) {
          const n = (attempts.get(id) || 0) + 1
          log?.warn?.('[casey] queue drive failed', { caseId: c.id, msgId: id, attempt: n, error: e.message })
          // Dead-letter after retryCap so a permanently-failing message stops.
          if (n >= retryCap) {
            try { await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `queue-drive-failed:${id}`, data: { dead_lettered: true, reason: 'queue-drive-error-exhausted', msg_id: id, error: String(e.message || e).slice(0, 500) } }) } catch { /* best effort */ }
          } else {
            // Record the failed attempt so the count advances toward the cap, but do
            // NOT mark drive-attempted (that only lands on success).
            try { await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `queue-drive-retry:${id}` }) } catch { /* best effort */ }
          }
          // Stop this case's drain on a throw -- the backend likely went down again;
          // the next recovery edge re-enters and continues in order.
          break
        }
      }
    }
    // Always log the outcome, not just when something drained. A silent
    // "nothing queued" completion is exactly as important to see as a busy one
    // when diagnosing whether the periodic drain-poll timer (startDrainPoll,
    // CASEY_DRAIN_POLL_INTERVAL_MS) is running at all vs. genuinely idle vs.
    // quietly stuck/never-started: with no log on an empty scan, a real stuck
    // case sitting un-drained is indistinguishable from "the timer never fired"
    // and "the timer fired but found nothing".
    log?.info?.('[casey] queue drain complete', { scanned, drained })
    return { scanned, drained }
  }
}
