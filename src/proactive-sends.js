import { vocabText } from './config-loader.js'
import { caseyText } from './deployment-text.js';


export const PROACTIVE_MODES = ['off', 'window']

let warned = false
export function proactiveMode(env = process.env) {
  const raw = String(env.CASEY_PROACTIVE_SENDS == null ? 'off' : env.CASEY_PROACTIVE_SENDS).trim().toLowerCase()
  if (raw === '') return 'off'
  if (PROACTIVE_MODES.includes(raw)) return raw
  if (!warned) { warned = true; console.warn(caseyText("src/proactive-sends.js#w0", [raw, PROACTIVE_MODES.join('/')])) }
  return 'off'
}

export function proactiveRefusal({ kind = 'message', env = process.env } = {}) {
  if (proactiveMode(env) === 'window') return null
  const base = vocabText('ui.proactive_refused_base', caseyText("src/proactive-sends.js#w1"))
  if (kind === 'staff_nudge') return `${base} ${vocabText('ui.proactive_refused_nudge', caseyText("src/proactive-sends.js#w2"))}`
  return `${base} ${vocabText('ui.proactive_refused_person', caseyText("src/proactive-sends.js#w3"))}`
}
