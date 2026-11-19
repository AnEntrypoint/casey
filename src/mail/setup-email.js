import { sendMail } from './smtp.js'
import { appsScriptConfig, sendViaAppsScript } from './apps-script.js'
import { caseyText } from '../deployment-text.js';

export const SETUP_SUBJECT = caseyText("src/mail/setup-email.js#w0")

const oneLine = (v, n) => String(v || '').replace(/[\r\n]+/g, ' ').slice(0, n)

export function setupEmailText({ name, link, expiresAt }) {
  return [
    `Hello ${oneLine(name, 80)},`,
    '',
    caseyText("src/mail/setup-email.js#w1"),
    '',
    link,
    '',
    caseyText("src/mail/setup-email.js#w2", [new Date(expiresAt).toUTCString()]),
    '',
  ].join('\n')
}

export function sendSetupEmail({ to, name, link, expiresAt }, env = process.env) {
  const message = { to, subject: SETUP_SUBJECT, text: setupEmailText({ name, link, expiresAt }) }
  const relay = appsScriptConfig(env)
  if (relay) return sendViaAppsScript(message, relay)
  return sendMail(message, env)
}
