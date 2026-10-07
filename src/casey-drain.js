

import { tagList, tsMs } from './timestamp.js'
import { replayMessage } from './hooks/replay-message.js'

import { mergeTag } from './hooks/heuristics.js'

import { completesTurn } from './casey-resume-scan.js'

async function surfaceDeadLetteredCase(store, log, caseRow) {
  try {
    const fresh = await store.getCase(caseRow.id)
    if (!fresh) return
    await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'needs-human') })
  } catch (e) { log?.warn?.('[casey] could not flag dead-lettered case for a human', { caseId: caseRow.id, error: e.message }) }
}

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

      const queued = new Map()
      const completedAfter = new Set()
      const attempts = new Map()
      const dead = new Set()
      for (const ev of events) {
        if (ev.kind === 'inbound' && ev.msg_id) {  }
        if (ev.kind === 'observation' && typeof ev.text === 'string') {
          let m = ev.text.match(/^QUEUED-FOR-AGENT:(.+)$/)
          if (m) { const inb = events.find(e => e.kind === 'inbound' && e.msg_id === m[1]); if (inb) queued.set(m[1], inb) }
          m = ev.text.match(/^queue-drive-(?:attempted|retry):(.+)$/)
          if (m) attempts.set(m[1], (attempts.get(m[1]) || 0) + 1)
          m = ev.text.match(/^queue-drive-failed:(.+)$/)
          if (m) dead.add(m[1])
        }
        if (completesTurn(ev)) {
          for (const id of queued.keys()) completedAfter.add(id)
        }
      }

      const pending = [...queued.entries()]
        .filter(([id]) => !completedAfter.has(id) && !dead.has(id))
        .sort((a, b) => a[1].created_at - b[1].created_at)
      if (!pending.length) continue
      scanned++
      for (const [id, ev] of pending) {
        if (drained >= maxRedrives) break

        const msg = replayMessage(c, ev, { resume: true, queuedRedrive: true })
        try {
          const res = await handle.call(gateway, c.channel, msg)

          if (res && res.degraded) {
            const n = (attempts.get(id) || 0) + 1
            log?.warn?.('[casey] queue drive degraded', { caseId: c.id, msgId: id, attempt: n })
            if (n >= retryCap) {

              try { await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `queue-drive-failed:${id}`, data: { dead_lettered: true, reason: 'queue-drive-degraded-exhausted', msg_id: id } }) } catch {  }
              await surfaceDeadLetteredCase(store, log, c)
            } else {
              try { await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `queue-drive-retry:${id}` }) } catch {  }
            }

            break
          }

          await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `queue-drive-attempted:${id}` })
          drained++
        } catch (e) {
          const n = (attempts.get(id) || 0) + 1
          log?.warn?.('[casey] queue drive failed', { caseId: c.id, msgId: id, attempt: n, error: e.message })

          if (n >= retryCap) {
            try { await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `queue-drive-failed:${id}`, data: { dead_lettered: true, reason: 'queue-drive-error-exhausted', msg_id: id, error: String(e.message || e).slice(0, 500) } }) } catch {  }
            await surfaceDeadLetteredCase(store, log, c)
          } else {

            try { await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `queue-drive-retry:${id}` }) } catch {  }
          }

          break
        }
      }
    }

    log?.info?.('[casey] queue drain complete', { scanned, drained })
    return { scanned, drained }
  }
}
