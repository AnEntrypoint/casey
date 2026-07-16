// hooks/notifiers.js -- casey's webhook/operator-notification surface.
//
// Split out of gateway-hooks.js (see AGENTS.md's Source map for the file's
// role). Handoff/breach/transition notifiers and the shared webhook POST +
// delivery-status tracking. Moved verbatim; only the physical location
// changed.

import { buildAlertPayload } from '../report-analytics.js'
import { stageNote } from './heuristics.js'

// Build a CaseStore onTransition hook that sends the contact a proactive,
// plain-language note when an OPERATOR moves their request to a stage worth
// announcing. Reuses the dashboard's sendReply(caseRow, text) adapter.
//
// Guards (all must pass to send):
// - agent transitions -- skipped; the agent already replies to the contact
//                           in its own warm, contextual message (no double-send).
// - opted-out tag -- the contact said STOP; stay silent.
// - stageNote empty -- nothing worth announcing for this stage.
// - dedup -- skip if the most recent outbound is this exact note.
// "Only on real stage change" is guaranteed by transition() skipping no-ops.
export function makeTransitionNotifier(store, sendReply, { log = console } = {}) {
  if (!sendReply) return null
  return async function onTransition({ caseRow, to, user }) {
    // Only operator-driven moves notify. Agent self-transitions during a turn
    // would otherwise send a canned note ON TOP of the agent's own reply.
    if (user?.role === 'agent') return
    const tags = (caseRow.tags || '').split(',').map(s => s.trim())
    if (tags.includes('opted-out')) return
    const text = stageNote(to)
    if (!text) return
    try {
      const recent = await store.listEventsPage(caseRow.id, { limit: 8, offset: 0 })
      const lastOut = recent.find(e => e.kind === 'outbound')
      if (lastOut && (lastOut.text || '').trim() === text) return
    } catch (e) { log.warn?.('[casey] transition-note dedup check failed', { caseId: caseRow.id, error: e.message }) }
    try {
      await sendReply(caseRow, text)
      await store.appendEvent(caseRow.id, {
        kind: 'outbound', actor: 'system', channel: caseRow.channel,
        text, data: { to: caseRow.external_id, proactive: 'stage-note', stage: to },
      })
    } catch (e) {
      log.error?.('[casey] transition note send failed', { caseId: caseRow.id, error: e.message })
      await store.appendEvent(caseRow.id, { kind: 'observation', actor: 'system', text: `proactive note send failed: ${e.message}` })
    }
  }
}

// Posts a one-line operator alert to a Discord webhook. Returns null if no URL is
// configured, so handoff flagging works with or without Discord wired up.
// allowed_mentions.parse:[] blocks a contact injecting @everyone via the subject.
export function discordHandoffNotifier(webhookUrl = process.env.CASEY_HANDOFF_WEBHOOK, log = null) {
  if (!webhookUrl) return null
  return async ({ case: c, channel, from }) => {
    // Never put a contact's raw phone/handle into a plaintext Discord message --
    // the same PII discipline the rest of this file holds for external_id. The
    // case ref is enough for an operator to open the case in the dashboard.
    const content = `A person is needed - case ${c.ref} on ${channel}`
      + (c.subject ? ` - ${c.subject}` : '')
    // A flaky webhook must never break the handoff itself: the case is already
    // flagged needs-human in the store, so the dashboard surfaces it regardless.
    // Degrade to a warning rather than rejecting the inbound turn (P9).
    await postWebhook(webhookUrl, content, log, 'discord handoff webhook')
  }
}

// Last-attempt delivery status per alert-webhook URL, in-memory only (not
// persisted -- a process restart resets it, matching the existing supervisor
// convention that health/runtime status is live-only, never a stale disk
// record). Read by the dashboard's /api/health so an operator can tell "the
// webhook itself has been failing" apart from "no breach has fired yet" --
// the two were previously indistinguishable since a webhook POST failure only
// ever surfaced as a console warning nobody sees on a headless deployment.
const _webhookDeliveryStatus = new Map()   // url -> {ok, lastAttemptAt, lastError, lastLabel}

export function getWebhookDeliveryStatus(webhookUrl) {
  return _webhookDeliveryStatus.get(webhookUrl) || null
}

// Posts a one-line guardrail-breach alert to a Discord webhook. Same transport and
// safety as the handoff notifier (no @-mentions, 5s timeout, degrade-not-throw),
// but driven by the periodic sweep rather than an inbound turn. Returns null with
// no URL so a sweep runs alert-free when nothing is configured.
export function breachNotifier(webhookUrl = process.env.CASEY_ALERT_WEBHOOK || process.env.CASEY_HANDOFF_WEBHOOK, log = null, opts = {}) {
  if (!webhookUrl) return null
  return async (c, breach, detail) => {
    const content = `Case ${c.ref}: ${detail || breach}`
    // Attach a structured, aggregate-only payload (no external_id) so a generic
    // pager can route on case_type/severity while Discord still renders `content`.
    const alert = buildAlertPayload(c, breach, detail, { escalated: !!opts.escalated })
    await postWebhook(webhookUrl, content, log, 'discord breach webhook', alert)
  }
}

// Shared Discord-webhook POST: blocks @-mention injection, aborts after 5s, and
// degrades a failure to a warning so a flaky webhook never breaks the caller. When
// an `alert` object is given it is merged into the body so a non-Discord pager gets
// machine-parseable breach metadata; Discord ignores the extra keys and renders
// `content`. The alert is aggregate-only (no external_id) by construction.
// Records the outcome into _webhookDeliveryStatus (keyed by URL) on both the
// success and failure paths so a stale "never tried again" webhook is
// distinguishable from one that IS being tried and failing every time.
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
    () => { clearTimeout(timer); _webhookDeliveryStatus.set(webhookUrl, { ok: true, lastAttemptAt: now, lastError: null, lastLabel: label }) },
    (e) => { clearTimeout(timer); log?.warn?.(`[casey] ${label} failed`, e.message); _webhookDeliveryStatus.set(webhookUrl, { ok: false, lastAttemptAt: now, lastError: String(e.message || e).slice(0, 200), lastLabel: label }) },
  )
}
