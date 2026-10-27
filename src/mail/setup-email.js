import { sendMail } from './smtp.js'
import { appsScriptConfig, sendViaAppsScript } from './apps-script.js'

export const SETUP_SUBJECT = 'Set your password'

const oneLine = (v, n) => String(v || '').replace(/[\r\n]+/g, ' ').slice(0, n)

export function setupEmailText({ name, link, expiresAt }) {
  return [
    `Hello ${oneLine(name, 80)},`,
    '',
    'Your login is ready. Set your password with this one-time link:',
    '',
    link,
    '',
    `The link works once and expires at ${new Date(expiresAt).toUTCString()}.`,
    '',
  ].join('\n')
}

export function sendSetupEmail({ to, name, link, expiresAt }, env = process.env) {
  const message = { to, subject: SETUP_SUBJECT, text: setupEmailText({ name, link, expiresAt }) }
  const relay = appsScriptConfig(env)
  if (relay) return sendViaAppsScript(message, relay)
  return sendMail(message, env)
}
