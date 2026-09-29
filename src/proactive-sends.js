// proactive-sends.js -- the one switch for messages casey (or an operator button,
// or a team tool) START, as opposed to messages that answer one that just arrived.
//
// CASEY_PROACTIVE_SENDS:
//   off     (default) casey never writes first. Every send that is not a direct
//           reply to an inbound message refuses with a plain reason.
//   window  the sends below are allowed while the contact's own last inbound is
//           inside the 24h service window (the pre-switch behaviour).
// Any other value is treated as 'off' (fail closed).
//
// GATED (initiated by casey, an operator button or a tool):
//   Casey.sendReply / bin/send-reply.js makeSendReply -- the seam behind the
//   dashboard's /reply, /remind, /bulk and draft approve, the transition
//   notifier and every team tool; hooks/staff-outbound.js (case_message,
//   team_remind, team_draft, case_ask_ranger, team_nudge_staff);
//   hooks/operator-reminder.js prepareReminder; makeTransitionNotifier.
// NOT GATED (a direct answer to an inbound message, or not a person):
//   the agent reply and the guaranteed-fallback reply (hooks/delivery.js), the
//   STOP / HUMAN acknowledgements (they are agent replies), staff notices
//   (delivered inside the assignee's own next in-window turn, so they are part
//   of a reply), and the operator alert webhooks (breach / handoff / coverage
//   gap: an internal channel, not a contact).

export const PROACTIVE_MODES = ['off', 'window']

let warned = false
export function proactiveMode(env = process.env) {
  const raw = String(env.CASEY_PROACTIVE_SENDS == null ? 'off' : env.CASEY_PROACTIVE_SENDS).trim().toLowerCase()
  if (raw === '') return 'off'
  if (PROACTIVE_MODES.includes(raw)) return raw
  if (!warned) { warned = true; console.warn(`[casey] CASEY_PROACTIVE_SENDS="${raw}" is not one of ${PROACTIVE_MODES.join('/')}; using 'off'`) }
  return 'off'
}

// null when a proactive send may proceed to the window/opt-out checks, else the
// sentence an operator reads (dashboard) or the model relays (tool). `kind`
// 'staff_nudge' adds where the nudge is offered instead.
export function proactiveRefusal({ kind = 'message', env = process.env } = {}) {
  if (proactiveMode(env) === 'window') return null
  const base = 'nothing was sent: this deployment does not start conversations (CASEY_PROACTIVE_SENDS=off) -- people write to the assistant and it answers, it never writes first.'
  if (kind === 'staff_nudge') return `${base} To nudge a team member, use the WhatsApp click-to-chat link in the nudges panel ("Who needs a nudge") and send it from your own phone.`
  return `${base} To reach this person, use the click-to-chat link on the record and send it from your own phone, or wait for them to write.`
}
