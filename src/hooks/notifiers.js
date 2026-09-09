// hooks/notifiers.js -- casey's webhook/operator-notification surface.
//
// Handoff/breach/transition notifiers, plus the shared webhook POST and its
// delivery-status tracking. Re-exported through gateway-hooks.js (see
// AGENTS.md's Source map).

import { buildAlertPayload } from '../report-analytics.js'
import { stageNote, OPTED_OUT_TAG } from './heuristics.js'
import { tagList } from '../timestamp.js'
import { caseDeliveryTarget } from './handler.js'
import { tsMs } from '../timestamp.js'

// Meta's free-form reply window. A constant rather than an env var on purpose:
// it is a platform rule, not a tuning knob, and a deployment that "raised" it
// would only be choosing to have its messages rejected.
const SESSION_WINDOW_MS = 24 * 3600e3
// Channels with no such rule. Everything else is treated as windowed, which is
// the fail-closed direction: a new channel added without thinking about this
// gets the conservative behaviour rather than silently originating messages.
const UNWINDOWED_CHANNELS = new Set(['discord', 'sim', 'web'])

function withinSessionWindow(caseRow, recentEvents, now = Date.now()) {
  if (UNWINDOWED_CHANNELS.has(String(caseRow?.channel || ''))) return true
  // Keyed on the contact's own last inbound, which is what Meta's rule measures
  // -- not an outbound, and not the case's updated_at, which an operator's own
  // edit refreshes without the contact having said anything.
  const lastIn = (recentEvents || []).find(e => e.kind === 'inbound')
  if (!lastIn) return false
  const at = tsMs(lastIn.created_at)
  if (!at) return false
  return now - at < SESSION_WINDOW_MS
}

// Build a CaseStore onTransition hook that sends the contact a proactive,
// plain-language note when an OPERATOR moves their request to a stage worth
// announcing. Sends through the caller-supplied sendReply(caseRow, text) --
// the same channel-adapter path the dashboard uses for operator replies.
//
// Guards (all must pass to send):
// - agent transitions -- skipped; the agent already replies to the contact
//                           in its own warm, contextual message (no double-send).
// - opted-out tag -- the contact said STOP; stay silent.
// - stageNote empty -- nothing worth announcing for this stage.
// - dedup -- skip if the most recent outbound is this exact note.
// - 24h session window -- see below; the contact must have written recently.
// "Only on real stage change" is guaranteed by transition() skipping no-ops.
//
// THE 24-HOUR WINDOW. dashboard/routes/map.js states casey's own policy in its
// own words -- "casey must never autonomously originate a WhatsApp message
// outside the free 24h session window" -- and uses it to justify recording a
// map dispatch as a queued SUGGESTION rather than an outbound send. This
// notifier was the one path that broke that policy: every operator stage change
// sent proactively, on any channel, with no check.
//
// It is not only a policy question. Outside that window Meta rejects a
// free-form send rather than charging for it, so the note simply does not
// arrive; adapters/whatsapp.js's verifiedSend catches the rejection correctly
// (it checks messages[0].id, not res.ok), but the only trace an operator got
// was an observation line on the timeline after the fact. Checking first turns
// a silent non-delivery into a recorded, visible decision BEFORE the attempt.
//
// The window is measured from the contact's own last INBOUND, which is what
// Meta's rule actually keys on -- not from any outbound, and not from the case's
// updated_at, which an operator's own edit would refresh without the contact
// having said anything. Channels other than WhatsApp have no such rule and are
// unaffected.
export function makeTransitionNotifier(store, sendReply, { log = console } = {}) {
  if (!sendReply) return null
  return async function onTransition({ caseRow, to, user }) {
    // Only operator-driven moves notify. Agent self-transitions during a turn
    // would otherwise send a canned note ON TOP of the agent's own reply.
    if (user?.role === 'agent') return
    if (tagList(caseRow).includes(OPTED_OUT_TAG)) return
    const text = stageNote(to)
    if (!text) return
    let recent = []
    try {
      recent = await store.listEventsPage(caseRow.id, { limit: 25, offset: 0 })
      const lastOut = recent.find(e => e.kind === 'outbound')
      if (lastOut && (lastOut.text || '').trim() === text) return
    } catch (e) { log.warn?.('[casey] transition-note dedup check failed', { caseId: caseRow.id, error: e.message }) }
    if (!withinSessionWindow(caseRow, recent)) {
      // Recorded, never sent. The operator sees on the timeline that the stage
      // moved and that casey deliberately did not message the contact, which is
      // the whole difference between this and the silent non-delivery it
      // replaces. It is not queued for later: a stage note is only worth
      // sending while it is news, and a queue that fires the moment a contact
      // next writes would answer a question they did not ask.
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
// webhook itself has been failing" apart from "no breach has fired yet" -- a
// POST failure otherwise surfaces only as a console warning nobody sees on a
// headless deployment.
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
    (res) => {
      clearTimeout(timer)
      // fetch() resolving only means a response was RECEIVED, not that Discord
      // accepted it -- a revoked/expired webhook token, deleted webhook, or a
      // rate-limit (401/404/429) all resolve normally with a non-2xx status.
      // Keep the res.ok check: without it every one of those records ok:true,
      // and GET /api/health tells an operator the breach/handoff alert channel
      // is healthy while every real alert silently fails to reach Discord.
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
