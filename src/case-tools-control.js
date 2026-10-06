

import { mergeTag, dropTag, OPTED_OUT_TAG, STOP_PENDING_PREFIX } from './hooks/heuristics.js'
import { stopPendingState, stopPendingTag, stopConfirmEvent } from './hooks/stop-pending.js'
import { defTool, str, boundCase } from './case-tools-shared.js'
import { controlActor } from './phone-persons.js'
import { canQueryCases } from './contact-tiers.js'

const PENDING_NOTE = 'Nothing is stopped yet. Ask them, in their language, to reply STOP again to confirm, or send anything else to carry on.'

export function buildControlTools(store) {
  const stopActor = async (ctx) => (ctx?.contact?.id && !canQueryCases(ctx?.tier) ? await controlActor(store(), ctx.contact.id) : {})
  return [
    defTool('case_stop', 'cases',
      'The person asked to STOP receiving messages (opt out). The first call only marks the request as waiting for their confirmation and stops nothing; they confirm by sending STOP again. Use ONLY on a clear opt-out.',
      { type: 'object', properties: { id: str("Report id; leave out to use this conversation's own report") } },
      async ({ id: askedId }, ctx) => {

        const id = askedId || boundCase(ctx).id

        const stopBound = boundCase(ctx)
        if (!stopBound.id || (id !== stopBound.id && id !== stopBound.ref)) {
          try {
            const logTarget = stopBound.id || id
            await store().appendEvent(logTarget, {
              kind: 'observation', actor: 'system',
              text: `SECURITY: case_stop called with id=${id} but this turn's active case is ${stopBound.id || '(none)'}; write rejected.`,
              data: { attemptedId: id, activeCaseId: stopBound.id, tool: 'case_stop' },
            })
          } catch {  }
          return { error: stopBound.id
            ? `case_stop must target this conversation's active case (${stopBound.ref || stopBound.id}), not ${id}`
            : 'case_stop has no bound active case on this turn -- cannot target an arbitrary case id' }
        }
        const c0 = await store().getCase(id)
        if (!c0) return { error: `no case ${id}` }

        let outcome = null
        await store()._withLock(`${c0.channel}|${c0.external_id}`, async () => {
          const c = await store().getCase(id)
          if (!c) return
          const events = await store().listEvents(id)
          const pending = stopPendingState(c, events)
          if (pending?.valid && pending.sameTurn) { outcome = 'same_turn'; return }
          if (pending?.valid) {
            await store().updateCase(id, { tags: mergeTag(dropTag(c.tags, STOP_PENDING_PREFIX), OPTED_OUT_TAG) })
            outcome = 'stopped'
            return
          }
          await store().updateCase(id, { tags: mergeTag(c.tags, stopPendingTag()) })
          await store().appendEvent(id, stopConfirmEvent(events, await stopActor(ctx)))
          outcome = 'pending'
        })

        if (outcome === 'same_turn') return { error: PENDING_NOTE }
        if (outcome === 'pending') return { ok: true, pending: true, note: PENDING_NOTE }
        if (!outcome) return { error: `no case ${id}` }

        const who = await stopActor(ctx)
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text: 'OPT-OUT: the person asked to stop; no more automatic replies.', ...(Object.keys(who).length ? { data: { opt_out: true, ...who } } : {}) })

        return canQueryCases(ctx?.tier) ? { ok: true, note: 'Tell them kindly, in their language, that sending HELP on its own starts the replies again.' } : { ok: true }
      }),

    defTool('case_handoff', 'cases',
      'The person wants a real person / operator to help. Flags the case for a human. Use on a clear ask for a person, or when someone says they may hurt themselves or others.',
      { type: 'object', properties: { id: str("Report id; leave out to use this conversation's own report") } },
      async ({ id: askedId }, ctx) => {

        const id = askedId || boundCase(ctx).id

        const handoffBound = boundCase(ctx)
        if (!handoffBound.id || (id !== handoffBound.id && id !== handoffBound.ref)) {
          try {
            const logTarget = handoffBound.id || id
            await store().appendEvent(logTarget, {
              kind: 'observation', actor: 'system',
              text: `SECURITY: case_handoff called with id=${id} but this turn's active case is ${handoffBound.id || '(none)'}; write rejected.`,
              data: { attemptedId: id, activeCaseId: handoffBound.id, tool: 'case_handoff' },
            })
          } catch {  }
          return { error: handoffBound.id
            ? `case_handoff must target this conversation's active case (${handoffBound.ref || handoffBound.id}), not ${id}`
            : 'case_handoff has no bound active case on this turn -- cannot target an arbitrary case id' }
        }
        const c0 = await store().getCase(id)
        if (!c0) return { error: `no case ${id}` }

        await store()._withLock(`${c0.channel}|${c0.external_id}`, async () => {
          const c = await store().getCase(id)
          if (!c) return
          await store().updateCase(id, { tags: mergeTag(c.tags, 'needs-human') })
        })
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text: 'HANDOFF REQUESTED: the person asked for a real person.' })
        return { ok: true }
      }),
  ]
}
