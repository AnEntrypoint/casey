// hooks/turn-deadlines.js -- the guaranteed-response FSM's two budgets and its
// two truthful status strings, in one place because the attempt loop
// (hooks/turn-attempts.js) owns the hard deadline while the terminal fallback
// (hooks/delivery.js) owns the soft one, and the two must be read from the same
// declaration or they drift.
//
// GUARANTEED-RESPONSE FSM (typing indicator + bounded turnaround + explicit
// fallback message). USER DIRECTIVE: every LIVE first-attempt turn must end in
// either a real chat reply or an explicit, truthful "still working" / "having
// trouble" status message -- never total silence. This is a scoped exception to
// the no-fallback-text principle, not a reversal of it: what that principle
// bans is FABRICATED case content or a scripted apology standing in for real
// understanding (a mock). A truthful status update invents nothing and claims
// nothing about the contact's case -- it is the same class of honesty as the
// loud log lines, just also shown to the contact. Applies only to a live,
// first-attempt turn that clears rate-limiting: it excludes msg.resume /
// msg.queuedRedrive (background catch-up re-drives of an OLD message the
// contact has likely moved on from -- the isBackgroundRedrive guard), and it
// excludes the rateLimited/globallyRateLimited early returns in
// hooks/case-intake.js (a deliberate pre-store admission-control gate -- no
// findOrCreateCase/recordInbound has run at that point, so there is no case
// timeline to attach a status message to).

// CASEY_TURN_SOFT_DEADLINE_MS is NOT a second timeout gate -- it only picks
// which of the two fallback strings to send, based on how long the whole turn
// actually took: a turn that degraded FAST (under the soft deadline -- a
// structural refusal, an immediate provider auth error) reads as "still
// working, one moment" since a quick follow-up message has a real chance of
// landing on a healthier attempt; a turn that ran long (spent real time
// genuinely retrying/waiting on providers, past the soft deadline) gets the
// more honest "having trouble" text instead of understating an already-long
// wait.
export const TURN_SOFT_DEADLINE_MS = Number(process.env.CASEY_TURN_SOFT_DEADLINE_MS) || 25000

// CASEY_TURN_HARD_DEADLINE_MS is the real, unconditional guarantee: the attempt
// loop spends AT MOST this much total wall-clock time retrying (each individual
// attempt still gets to run its own bounded provider-chain walk --
// ACPTOAPI_CHAIN_LINK_TIMEOUT_MS-per-hop, set to 60s in casey's own .env -- to
// real completion rather than being cut off mid-hop; this is the "completing
// through multiple samples" behavior the design calls for: a retry that starts
// with real remaining budget gets a genuine chance, not an arbitrarily
// truncated one). acptoapi's OWN shipped default for that per-hop timeout
// (chain-machine.js DEFAULT_LINK_TIMEOUT_MS) is 120s, not 20s; casey's .env
// explicitly overrides it to 60s specifically because the upstream default
// alone would let one bad chain hop consume the whole hard-deadline budget on
// attempt 1 alone. A deployment missing that override silently inherits the
// 120s default (see AGENTS.md's Timeout Coordination section). Once the hard
// deadline is reached the loop stops retrying and the guaranteed-fallback text
// is composed and sent.
//
// 120s whole-turn budget: a genuine first attempt WITH tool calls (case_new +
// case_report + judge) has been witnessed eating 45s, so a 60s whole-turn cap
// left zero room for the retry budget it is supposed to protect -- the retried
// turn timed out mid-attempt and the contact got the terminal timeout text
// despite a healthy provider. The per-MODEL-CALL bound stays 60s
// (ACPTOAPI_CHAIN_LINK_TIMEOUT_MS); this is the budget across attempts.
export const TURN_HARD_DEADLINE_MS = Number(process.env.CASEY_TURN_HARD_DEADLINE_MS) || 120000

// Truthful, plain-language status copy (per AGENTS.md's existing tone
// principles: no jargon, mirror the contact's own language where the case
// system prompt already does that for a real reply -- these two fixed strings
// are deliberately language-neutral/short so they read reasonably in
// translation without needing a full localization pass).
export const STILL_WORKING_TEXT = "Still working on this -- one moment."
export const TURN_TIMEOUT_TEXT = "Sorry, I'm having trouble right now. Please try again in a little while, or send your message again."
