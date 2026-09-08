// case-tools-control.js  --  the two irreversible service controls: opt-out and
// escalate-to-a-human.
//
// These are the ONLY case tools with no autonomy=observe guard, and that is
// deliberate rather than an oversight: an opt-out or a request for a real
// person is an irreversible LEGAL control (matching gateway-hooks.js's
// deterministic STOP short-circuit), not a content edit, so it must register
// regardless of autonomy -- an observe-mode contact's opt-out is never silently
// dropped. Both are also REPORT_ONLY_TOOLS (case-tools-gates.js), reachable at
// every access tier. Split out of case-tools.js verbatim -- names,
// descriptions, parameter schemas and handler bodies are unchanged.

import { mergeTag, OPTED_OUT_TAG } from './hooks/heuristics.js'
import { defTool, str, boundCase } from './case-tools-shared.js'

export function buildControlTools(store) {
  return [
    defTool('case_stop', 'cases',
      'The person asked to STOP receiving messages (opt out). Records the opt-out. Use ONLY on a clear opt-out.',
      { type: 'object', properties: { id: str('Case id') }, required: ['id'] },
      async ({ id }, ctx) => {
        // Same server-side active-case binding as case_report: an irreversible
        // control is exactly the kind of write that must never land on the wrong
        // case from a model mistake or injected text naming another case's ref.
        // Fail CLOSED: a missing ctx.activeCaseId is itself a rejection condition,
        // never a bypass -- see case_report's handler for the full reasoning.
        const stopBound = boundCase(ctx)
        if (!stopBound.id || (id !== stopBound.id && id !== stopBound.ref)) {
          try {
            const logTarget = stopBound.id || id
            await store().appendEvent(logTarget, {
              kind: 'observation', actor: 'system',
              text: `SECURITY: case_stop called with id=${id} but this turn's active case is ${stopBound.id || '(none)'}; write rejected.`,
              data: { attemptedId: id, activeCaseId: stopBound.id, tool: 'case_stop' },
            })
          } catch { /* best effort */ }
          return { error: stopBound.id
            ? `case_stop must target this conversation's active case (${stopBound.ref || stopBound.id}), not ${id}`
            : 'case_stop has no bound active case on this turn -- cannot target an arbitrary case id' }
        }
        const c0 = await store().getCase(id)
        if (!c0) return { error: `no case ${id}` }
        // Locked read-modify-write: unlike every other case mutator in this
        // toolset, this used to read/modify/write tags with no lock at all -- two
        // concurrent calls (case_stop racing case_handoff, or a retried tool
        // call) could silently drop a tag the other write just added. Not
        // routed through updateCaseChecked -- opt-out is an irreversible legal
        // control that must register regardless of observe mode, so it must
        // NOT pick up that helper's autonomy gate.
        await store()._withLock(`${c0.channel}|${c0.external_id}`, async () => {
          const c = await store().getCase(id)
          if (!c) return
          await store().updateCase(id, { tags: mergeTag(c.tags, OPTED_OUT_TAG) })
        })
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text: 'OPT-OUT: the person asked to stop; no more automatic replies.' })
        return { ok: true }
      }),
    // Same reasoning as case_stop: a handoff request is an irreversible legal
    // control, not a content edit, so it deliberately bypasses the observe guard.
    defTool('case_handoff', 'cases',
      'The person wants a real person / operator to help. Flags the case for a human. Use on a clear ask for a person.',
      { type: 'object', properties: { id: str('Case id') }, required: ['id'] },
      async ({ id }, ctx) => {
        // Fail CLOSED: a missing ctx.activeCaseId is itself a rejection condition,
        // never a bypass -- see case_report's handler for the full reasoning.
        const handoffBound = boundCase(ctx)
        if (!handoffBound.id || (id !== handoffBound.id && id !== handoffBound.ref)) {
          try {
            const logTarget = handoffBound.id || id
            await store().appendEvent(logTarget, {
              kind: 'observation', actor: 'system',
              text: `SECURITY: case_handoff called with id=${id} but this turn's active case is ${handoffBound.id || '(none)'}; write rejected.`,
              data: { attemptedId: id, activeCaseId: handoffBound.id, tool: 'case_handoff' },
            })
          } catch { /* best effort */ }
          return { error: handoffBound.id
            ? `case_handoff must target this conversation's active case (${handoffBound.ref || handoffBound.id}), not ${id}`
            : 'case_handoff has no bound active case on this turn -- cannot target an arbitrary case id' }
        }
        const c0 = await store().getCase(id)
        if (!c0) return { error: `no case ${id}` }
        // Same locked read-modify-write as case_stop above, same reasoning
        // (concurrent tag writes can otherwise silently drop each other), same
        // deliberate bypass of the observe-mode gate (handoff is an
        // irreversible legal control, not a content edit).
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
