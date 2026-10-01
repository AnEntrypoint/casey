

import { mergeTag, OPTED_OUT_TAG } from './hooks/heuristics.js'
import { defTool, str, boundCase } from './case-tools-shared.js'
import { controlActor } from './phone-persons.js'
import { canQueryCases } from './contact-tiers.js'

export function buildControlTools(store) {
  return [
    defTool('case_stop', 'cases',
      'The person asked to STOP receiving messages (opt out). Records the opt-out. Use ONLY on a clear opt-out.',
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

        await store()._withLock(`${c0.channel}|${c0.external_id}`, async () => {
          const c = await store().getCase(id)
          if (!c) return
          await store().updateCase(id, { tags: mergeTag(c.tags, OPTED_OUT_TAG) })
        })

        const who = ctx?.contact?.id && !canQueryCases(ctx?.tier) ? await controlActor(store(), ctx.contact.id) : {}
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
