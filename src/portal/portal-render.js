import fs from 'node:fs'
import { publicBase } from './portal-config.js'

export const ASSET_NAMES = Object.freeze(['login.html', 'blocked.html', 'tc.html', 'redirect.html'])

const TEMPLATE_DIR = new URL('./templates/', import.meta.url)
const PLACEHOLDER = /\{\{(\w+)\}\}/g
const HTML_ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })
const templateCache = new Map()

export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch])

const readTemplate = (name) => {
  if (!templateCache.has(name)) templateCache.set(name, fs.readFileSync(new URL(name, TEMPLATE_DIR), 'utf8'))
  return templateCache.get(name)
}

export function expandText(text, placeholders) {
  return text.replace(PLACEHOLDER, (match, key) => (Object.hasOwn(placeholders, key) ? placeholders[key] : match))
}

export function paragraphsHtml(text) {
  return text
    .split(/\n\s*\n/)
    .map(block => block.split('\n').map(line => line.trim()).filter(Boolean))
    .filter(lines => lines.length)
    .map(lines => `<p>${lines.map(escapeHtml).join('<br>')}</p>`)
    .join('\n')
}

export function textPlaceholders(settings) {
  return {
    bot_number: settings.bot_number,
    contact_minutes: String(Math.round(settings.contact_window_s / 60)),
    block_hours: String(Number((settings.block_s / 3600).toFixed(2))),
  }
}

export function templateValues(settings, { routerId, apiBase }) {
  const placeholders = textPlaceholders(settings)
  const plainText = (key) => escapeHtml(expandText(settings[key], placeholders))
  const waDigits = settings.bot_number.replace(/\D/g, '')
  return {
    router_id: escapeHtml(routerId),
    api_base: escapeHtml(apiBase),
    bot_number: escapeHtml(settings.bot_number),
    bot_wa_url: escapeHtml(`https://wa.me/${waDigits}`),
    login_title: plainText('login_title'),
    login_intro: plainText('login_intro'),
    login_checkbox: plainText('login_checkbox'),
    done_title: plainText('done_title'),
    done_text: plainText('done_text'),
    blocked_title: plainText('blocked_title'),
    blocked_text: plainText('blocked_text'),
    tc_title: plainText('tc_title'),
    tc_version: plainText('tc_version'),
    tc_body: paragraphsHtml(expandText(settings.tc_body, placeholders)),
  }
}

export function fillTemplate(template, values) {
  return template.replace(PLACEHOLDER, (match, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`template placeholder {{${key}}} has no value`)
    return values[key]
  })
}

export function renderAsset(name, { settings, routerId, apiBase = publicBase() }) {
  return fillTemplate(readTemplate(name), templateValues(settings, { routerId, apiBase }))
}
