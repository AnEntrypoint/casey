// case-tools-binding.js  --  the two tools that change WHICH case this
// conversation is bound to.
//
// Both end in rebindActiveCase: a case_new/case_switch that leaves the turn
// bound to the old case makes the very next case_report (naturally aimed at the
// new one) bounce off case-tools-record.js's active-case guard, silently losing
// the fresh report's facts. Split out of case-tools.js verbatim -- names,
// descriptions, parameter schemas and handler bodies are unchanged.

import {
  defTool, str, ownsCase, enquiryRow, boundCase, rebindActiveCase,
} from './case-tools-shared.js'

export function buildBindingTools(store) {
  return [
    defTool('case_new', 'cases',
      'Open a NEW case for the worker and bind it active. Use ONLY when the worker is clearly starting a fresh report (a different animal/place/incident), never to auto-open one.',
      { type: 'object', properties: { subject: str('Optional short subject') } },
      async ({ subject }, ctx) => {
        const author = ctx?.author || ctx?.principal?.id
        if (!store().createCase) return { error: 'store does not support explicit case creation' }
        // Reuse THIS turn's own (channel, external_id) -- the real conversation
        // key findOrCreateCase actually binds on -- rather than inventing a
        // synthetic id, so the very next plain inbound message from this
        // worker correctly lands on the freshly-opened case (findOpenCase's
        // newest-open-case-wins rule), not the old one it just moved on from.
        const currentBound = boundCase(ctx).id
        const current = currentBound ? await store().getCase(currentBound) : null
        const channel = current?.channel || ctx?.channel || 'other'
        const external_id = current?.external_id
        if (!external_id) return { error: 'no conversation identity on this turn -- cannot bind a new case' }
        const c = await store().createCase({ channel, external_id, subject: subject || '', contact_id: current?.contact_id || '' })
        await store().appendEvent(c.id, { kind: 'note', actor: 'system', text: `case explicitly opened for a fresh report by ${author || 'unknown'}` })
        // Rebind THIS turn to the new case: the description says "bind it
        // active", and the natural next call is case_report against the new
        // case's id -- which the active-case security guard rejected before
        // this rebind existed, silently losing the fresh report's facts
        // (live-witnessed). rebindActiveCase updates the shared binding
        // object (visible to every later call this turn AND the handler's
        // next retry attempt) plus this call's own flat ctx fields.
        rebindActiveCase(ctx, c)
        return { ok: true, activeCase: enquiryRow(c) }
      }),
    // Ownership-gated re-bind of the conversation's active case by ref -- lets a
    // worker with multiple open cases explicitly say "go back to CASE-1042" or
    // "switch to the goat case" and have the agent actually target it, instead
    // of every subsequent case_report call silently continuing to
    // hit whatever case findOrCreateCase happened to bind this turn. Ownership
    // gated the same way case_get/mineRows already are: a worker may only
    // switch onto a case they themselves reported.
    defTool('case_switch', 'cases',
      'Re-bind the conversation to a DIFFERENT one of the worker\'s own open cases by ref (e.g. "CASE-1042"). Use when the worker names a case they want to continue, other than the one currently active. Confirms the switch back to them.',
      { type: 'object', properties: { ref: str('The case ref to switch to, e.g. CASE-1042') }, required: ['ref'] },
      async ({ ref }, ctx) => {
        const author = ctx?.author || ctx?.principal?.id
        if (!author) return { error: 'no author on this turn -- cannot resolve ownership for a switch' }
        const target = typeof store().getCaseByRef === 'function'
          ? await store().getCaseByRef(ref)
          : (await store().listCases({}, { limit: 500 })).find(c => c.ref === ref)
        if (!target) return { error: `no case found with ref ${ref}` }
        if (!ownsCase(target.external_id, author)) {
          return { error: `case ${ref} does not belong to you -- cannot switch to it` }
        }
        // Same rebind-on-success discipline as case_new: a switch that leaves
        // the turn bound to the OLD case makes the next case_report (naturally
        // aimed at the switched-to case) bounce off the active-case guard.
        rebindActiveCase(ctx, target)
        return { ok: true, activeCase: enquiryRow(target), confirm: `Switched to ${target.ref}.` }
      }),
  ]
}
