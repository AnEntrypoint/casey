

export const PROACTIVE_MODES = ['off', 'window']

let warned = false
export function proactiveMode(env = process.env) {
  const raw = String(env.CASEY_PROACTIVE_SENDS == null ? 'off' : env.CASEY_PROACTIVE_SENDS).trim().toLowerCase()
  if (raw === '') return 'off'
  if (PROACTIVE_MODES.includes(raw)) return raw
  if (!warned) { warned = true; console.warn(`[casey] CASEY_PROACTIVE_SENDS="${raw}" is not one of ${PROACTIVE_MODES.join('/')}; using 'off'`) }
  return 'off'
}

export function proactiveRefusal({ kind = 'message', env = process.env } = {}) {
  if (proactiveMode(env) === 'window') return null
  const base = 'nothing was sent: this deployment does not start conversations (CASEY_PROACTIVE_SENDS=off) -- people write to the assistant and it answers, it never writes first.'
  if (kind === 'staff_nudge') return `${base} To nudge a team member, use the WhatsApp click-to-chat link in the nudges panel ("Who needs a nudge") and send it from your own phone.`
  return `${base} To reach this person, use the click-to-chat link on the record and send it from your own phone, or wait for them to write.`
}
