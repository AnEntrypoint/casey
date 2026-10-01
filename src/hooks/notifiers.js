

import { buildAlertPayload } from '../report-analytics.js'
import { stageNote, OPTED_OUT_TAG } from './heuristics.js'
import { tagList } from '../timestamp.js'
import { caseDeliveryTarget } from './handler.js'
import { tsMs } from '../timestamp.js'
import { proactiveRefusal } from '../proactive-sends.js'

const SESSION_WINDOW_MS = 24 * 3600e3

const UNWINDOWED_CHANNELS = new Set(['discord', 'sim', 'web'])

export function sessionWindowHours() { return Math.round(SESSION_WINDOW_MS / 3600e3) }

export function withinSessionWindow(caseRow, recentEvents, now = Date.now()) {
  if (UNWINDOWED_CHANNELS.has(String(caseRow?.channel || ''))) return true

  const lastIn = (recentEvents || []).find(e => e.kind === 'inbound')
  if (!lastIn) return false
  const at = tsMs(lastIn.created_at)
  if (!at) return false
  return now - at < SESSION_WINDOW_MS
}

export function makeTransitionNotifier(store, sendReply, { log = console } = {}) {
  if (!sendReply) return null
  return async function onTransition({ caseRow, to, user }) {

    if (user?.role === 'agent') return
    if (tagList(caseRow).includes(OPTED_OUT_TAG)) return
    const text = stageNote(to)
    if (!text) return

    if (proactiveRefusal({ kind: 'stage-note' })) {
      await store.appendEvent(caseRow.id, {
        kind: 'observation', actor: 'system',
        text: 'Stage note not sent -- this deployment does not start conversations (CASEY_PROACTIVE_SENDS=off).',
        data: { proactive: 'stage-note', stage: to, suppressed: 'proactive_off' },
      }).catch(() => {})
      return
    }
    let recent = []
    try {
      recent = await store.listEventsPage(caseRow.id, { limit: 25, offset: 0 })
      const lastOut = recent.find(e => e.kind === 'outbound')
      if (lastOut && (lastOut.text || '').trim() === text) return
    } catch (e) { log.warn?.('[casey] transition-note dedup check failed', { caseId: caseRow.id, error: e.message }) }
    if (!withinSessionWindow(caseRow, recent)) {

      await store.appendEvent(caseRow.id, {
        kind: 'observation', actor: 'system',
        text: `Stage note not sent -- this contact last wrote more than ${Math.round(SESSION_WINDOW_MS / 3600e3)}h ago, outside WhatsApp's free reply window. Reach them another way if it cannot wait.`,
        data: { proactive: 'stage-note', stage: to, suppressed: 'session_window' },
      }).catch(() => {})
      return
    }
    try {
      await sendReply(caseRow, text)
      await store.appendEvent(caseRow.id, {
        kind: 'outbound', actor: 'system', channel: caseRow.channel,
        text, data: { to: caseDeliveryTarget(caseRow), proactive: 'stage-note', stage: to },
      })
    } catch (e) {
      log.error?.('[casey] transition note send failed', { caseId: caseRow.id, error: e.message })
      await store.appendEvent(caseRow.id, { kind: 'observation', actor: 'system', text: `proactive note send failed: ${e.message}` })
    }
  }
}

export function discordHandoffNotifier(webhookUrl = process.env.CASEY_HANDOFF_WEBHOOK, log = null) {
  if (!webhookUrl) return null
  return async ({ case: c, channel, from }) => {

    const content = `A person is needed - case ${c.ref} on ${channel}`
      + (c.subject ? ` - ${c.subject}` : '')

    await postWebhook(webhookUrl, content, log, 'discord handoff webhook')
  }
}

const _webhookDeliveryStatus = new Map()

export function getWebhookDeliveryStatus(webhookUrl) {
  return _webhookDeliveryStatus.get(webhookUrl) || null
}

export function breachNotifier(webhookUrl = process.env.CASEY_ALERT_WEBHOOK || process.env.CASEY_HANDOFF_WEBHOOK, log = null, opts = {}) {
  if (!webhookUrl) return null
  return async (c, breach, detail) => {
    const content = `Case ${c.ref}: ${detail || breach}`

    const alert = buildAlertPayload(c, breach, detail, { escalated: !!opts.escalated })
    await postWebhook(webhookUrl, content, log, 'discord breach webhook', alert)
  }
}

async function postWebhook(webhookUrl, content, log, label, alert = null) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 5000)
  const body = { content, allowed_mentions: { parse: [] } }
  if (alert) body.alert = alert
  const now = Date.now()
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: ac.signal,
  }).then(
    (res) => {
      clearTimeout(timer)

      if (res.ok) {
        _webhookDeliveryStatus.set(webhookUrl, { ok: true, lastAttemptAt: now, lastError: null, lastLabel: label })
      } else {
        log?.warn?.(`[casey] ${label} failed`, `HTTP ${res.status}`)
        _webhookDeliveryStatus.set(webhookUrl, { ok: false, lastAttemptAt: now, lastError: `HTTP ${res.status}`, lastLabel: label })
      }
    },
    (e) => { clearTimeout(timer); log?.warn?.(`[casey] ${label} failed`, e.message); _webhookDeliveryStatus.set(webhookUrl, { ok: false, lastAttemptAt: now, lastError: String(e.message || e).slice(0, 200), lastLabel: label }) },
  )
}
