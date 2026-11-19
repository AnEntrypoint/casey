

import { mergeTag, dropTag, OPTED_OUT_TAG, STOP_PENDING_PREFIX } from './hooks/heuristics.js'
import { stopPendingState, stopPendingTag, stopConfirmEvent } from './hooks/stop-pending.js'
import { defTool, str, boundCase } from './case-tools-shared.js'
import { controlActor } from './phone-persons.js'
import { canQueryCases } from './contact-tiers.js'
import { caseyText } from './deployment-text.js';

const PENDING_NOTE = caseyText("src/case-tools-control.js#0")

export function buildControlTools(store) {
  const stopActor = async (ctx) => (ctx?.contact?.id && !canQueryCases(ctx?.tier) ? await controlActor(store(), ctx.contact.id) : {})
  return [
    defTool('case_stop', 'cases',
      caseyText("src/case-tools-control.js#1"),
      { type: 'object', properties: { id: str(caseyText("src/case-tools-control.js#2")) } },
      async ({ id: askedId }, ctx) => {

        const id = askedId || boundCase(ctx).id

        const stopBound = boundCase(ctx)
        if (!stopBound.id || (id !== stopBound.id && id !== stopBound.ref)) {
          try {
            const logTarget = stopBound.id || id
            await store().appendEvent(logTarget, {
              kind: 'observation', actor: 'system',
              text: caseyText("src/case-tools-control.js#3", [id, stopBound.id || '(none)']),
              data: { attemptedId: id, activeCaseId: stopBound.id, tool: 'case_stop' },
            })
          } catch {  }
          return { error: stopBound.id
            ? caseyText("src/case-tools-control.js#4", [stopBound.ref || stopBound.id, id])
            : caseyText("src/case-tools-control.js#5") }
        }
        const c0 = await store().getCase(id)
        if (!c0) return { error: caseyText("src/case-tools-control.js#s0", [id]) }

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
        if (!outcome) return { error: caseyText("src/case-tools-control.js#s1", [id]) }

        const who = await stopActor(ctx)
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text: caseyText("src/case-tools-control.js#6"), ...(Object.keys(who).length ? { data: { opt_out: true, ...who } } : {}) })

        return canQueryCases(ctx?.tier) ? { ok: true, note: caseyText("src/case-tools-control.js#7") } : { ok: true }
      }),

    defTool('case_handoff', 'cases',
      caseyText("src/case-tools-control.js#8"),
      { type: 'object', properties: { id: str(caseyText("src/case-tools-control.js#9")) } },
      async ({ id: askedId }, ctx) => {

        const id = askedId || boundCase(ctx).id

        const handoffBound = boundCase(ctx)
        if (!handoffBound.id || (id !== handoffBound.id && id !== handoffBound.ref)) {
          try {
            const logTarget = handoffBound.id || id
            await store().appendEvent(logTarget, {
              kind: 'observation', actor: 'system',
              text: caseyText("src/case-tools-control.js#10", [id, handoffBound.id || '(none)']),
              data: { attemptedId: id, activeCaseId: handoffBound.id, tool: 'case_handoff' },
            })
          } catch {  }
          return { error: handoffBound.id
            ? caseyText("src/case-tools-control.js#11", [handoffBound.ref || handoffBound.id, id])
            : caseyText("src/case-tools-control.js#12") }
        }
        const c0 = await store().getCase(id)
        if (!c0) return { error: caseyText("src/case-tools-control.js#s2", [id]) }

        await store()._withLock(`${c0.channel}|${c0.external_id}`, async () => {
          const c = await store().getCase(id)
          if (!c) return
          await store().updateCase(id, { tags: mergeTag(c.tags, 'needs-human') })
        })
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text: caseyText("src/case-tools-control.js#13") })
        return { ok: true }
      }),
  ]
}
