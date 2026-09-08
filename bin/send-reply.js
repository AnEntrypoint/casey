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

export function makeSendReply(casey) {
  return (caseRow, text) => {
    const a = casey.adapters[caseRow.channel]
    return a?.send ? a.send({ to: caseDeliveryTarget(caseRow), text }) : Promise.resolve()
  }
}
