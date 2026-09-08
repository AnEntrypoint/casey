// send-reply.js  --  the outbound delivery seam, in one place.
//
// Both process entry points that stand a dashboard up (bin/worker.js, the
// supervised path; bin/casey-cli.mjs's `up --no-supervise`, the legacy
// single-process path) have to hand createDashboard a way to send an
// operator's reply back out over the contact's own channel. They had a
// verbatim copy each.
//
// The duplication mattered more than its two lines suggest, which is why it is
// shared rather than left alone: the ONE thing this closure encodes is that the
// delivery TARGET is not the conversation key. AGENTS.md states it directly --
// "Reply delivery target is kept separate from this key (a Discord author id
// 404s if posted to directly; only the channel does)" -- and caseDeliveryTarget
// is the function that knows the difference. Two independent copies of a seam
// whose whole job is preserving one non-obvious distinction is two places for
// that distinction to be quietly lost, and only one of them would be noticed.
//
// It deliberately does NOT reach any further than that. It takes an
// already-built casey instance and returns a function; it owns no lifecycle,
// no restart budget, no port, and no process concerns -- so sharing it couples
// the two entry points on the delivery rule alone, which is exactly the thing
// they must agree about, and on nothing else. Everything genuinely different
// between a forked, supervisor-restarted worker and a one-shot debugging
// process stays where it is.

import { caseDeliveryTarget } from '../src/hooks/handler.js'

// THROWS when the channel has no adapter, and must keep throwing. Every caller
// decides delivery the same way -- `try { await sendReply(...); delivered = true }
// catch { record the failure }` -- so a resolved promise IS the success signal.
// Returning Promise.resolve() for a missing adapter therefore reported a reply as
// delivered when nothing had been sent: routes/cases.js then cleared needs-human
// and auto-claimed the case, so a contact who never received the reply was
// unpinned from triage and the case looked answered. That is the exact outcome
// the comment above postReply's own send says it prevents ("a contact who never
// got the reply stays pinned in triage rather than silently dropped").
//
// Third instance of this failure class here: the same shape hid a total delivery
// outage for the life of the freddie port, and AGENTS.md states the rule as
// "a delivered flag must not be initialised to its success value above the branch
// that earns it". A silent success is that mistake wearing a promise.
//
// A case on a channel with no adapter -- a 'web' case from the public form, or a
// channel this deployment has not configured -- genuinely cannot receive a reply,
// so throwing is the honest answer rather than an edge case to smooth over. The
// caller records the reason and, since the mode work, keeps the operator's words
// on the timeline as a note explicitly marked NOT SENT.
export function makeSendReply(casey) {
  return (caseRow, text) => {
    const a = casey.adapters[caseRow.channel]
    if (!a?.send) {
      return Promise.reject(new Error(`no adapter for channel "${caseRow.channel}" -- nothing was sent`))
    }
    return a.send({ to: caseDeliveryTarget(caseRow), text })
  }
}
