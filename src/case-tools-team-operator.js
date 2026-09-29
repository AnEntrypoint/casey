// case-tools-team-operator.js  --  the operator's queue-running surface over
// WhatsApp. An operator works mainly in the dashboard; these are the same duties
// with the same guards, for when they are on their phone. Composed, in a pinned
// order, by case-tools-team.js. Every tool is operator-rung only (case-tools-gates.js
// TOOL_MIN_TIER); sign-off stays the technician's alone.
//
//   team_queue          the work queue: counts and top rows per section
//   team_handover       shift summary (attention, hand-offs, drafts, touched)
//   team_assign         assign / reassign / unassign (unassign resumes the bot)
//   team_draft          approve or discard a held assistant draft
//   team_remind         the operator-initiated nudge to a silent reporter
//   team_invite         issue a one-time WhatsApp role code
//   team_register       put a phone number in a role now
//   team_roster         who is on the team, by name and role
//   team_quiet_staff    team members whose assigned records have gone quiet
//   team_nudge_staff    message such a team member through the bot (in-window)
//
// Outbound to a reporter or team member goes through hooks/staff-outbound.js,
// i.e. the one sendReply seam, with opt-out and the 24h window honoured.

import { defTool, str } from './case-tools-shared.js'
import { tagList, tsMs } from './timestamp.js'
import { isOpenCase, fmtPhone27 } from './format.js'
import { rankAttention } from './attn.js'
import { TIER_ORDER, TIER_REPORTER, TIER_OPERATOR, TIER_FIELD_WORKER, grantableBy, atLeast, resolveTierValue } from './contact-tiers.js'
import { assigneeKeyFor, isAssignedTo, isOwnConversation, contactIdOfAssignee, isContactAssignee } from './case-assignment.js'
import { createInvite, normalizeMsisdn } from './role-invites.js'
import { sendStaffMessage, pendingDraft, releaseCase, staffLabel } from './hooks/staff-outbound.js'
import { dropTag } from './hooks/heuristics.js'
import { UNCLAIMED_ASSIGNEE } from './case-store.js'
import { TIER_LABELS, ENQUIRY_HEADLINE_FIELDS } from './store/report-shape.js'
import { evData } from './safe.js'
import { clearFocusForCase } from './team-focus.js'
import { signOffCandidates } from './case-tools-team-review.js'
import { loadAreas, possiblyWrongArea } from './areas.js'
import { findCase, teamRow, actorData, doneStages } from './case-tools-team-shared.js'

const NO_SUCH = { error: 'No such record. Ask for the reference again.' }
const staffOf = (ctx) => ({ ...(ctx?.contact || {}), tier: ctx?.tier })
const opUser = (ctx) => ({ id: staffLabel(ctx?.contact), role: 'operator' })
const SECTIONS = ['unassigned', 'needs_human', 'unreplied', 'drafts', 'flagged', 'signoff', 'wrong_area', 'attention']
const QUIET_DEFAULT_HOURS = 12

// One short plain line per record for a phone: reference, the headline facts, who
// holds it, and why it is listed. No markdown, no pipes, no asterisks.
const phoneLine = (row) => [row.ref, ...ENQUIRY_HEADLINE_FIELDS.map(k => row[k]).filter(Boolean).map(v => String(v).replace(/\s+/g, ' ').slice(0, 40)), row.assignee && row.assignee !== UNCLAIMED_ASSIGNEE ? `with ${row.assignee}` : 'nobody has it', row.why ? String(row.why).replace(/\s+/g, ' ').slice(0, 60) : ''].filter(Boolean).join(', ')
const PLAIN_NOTE = 'Pass these lines on as plain text, one per line, in this order. No tables, no asterisks, no bullets, no markdown.'

const openCases = async (store) => (await store.listCases({}, { limit: 10000, offset: 0 })).filter(c => c.channel !== 'system' && isOpenCase(c))
const isUnassigned = (c) => { const a = String(c.assignee || '').trim(); return !a || a === UNCLAIMED_ASSIGNEE }

// The team contacts (field_worker and up), by display name. Names, never numbers.
export async function teamContacts(store) {
  const all = await store.listContacts({ limit: 500 })
  return all.filter(k => atLeast(k.tier, TIER_FIELD_WORKER))
}
// Exactly one contact whose name matches, else { error } listing how many fit.
export async function resolveTeamContact(store, name) {
  const want = String(name || '').trim().toLowerCase()
  if (!want) return { error: 'Which team member? Give a name.' }
  const team = await teamContacts(store)
  const exact = team.filter(k => String(k.display_name || '').trim().toLowerCase() === want)
  const hits = exact.length ? exact : team.filter(k => String(k.display_name || '').toLowerCase().includes(want))
  if (hits.length === 1) return { contact: hits[0] }
  return { error: hits.length ? `${hits.length} team members fit that name. Ask for the full name.` : 'No team member by that name. Use team_roster to see who is on the team.', candidates: (hits.length ? hits : team).slice(0, 12).map(k => staffLabel(k)) }
}

export function buildTeamOperatorTools(store) {
  return [
    defTool('team_queue', 'cases',
      'The operator work queue: how many records sit in each section (unassigned, wanting a person, unanswered because the assistant was down, held drafts, flagged replies, ready to sign off, possibly filed under the wrong area, needing attention) and the top rows of each. Pass `section` for one section with more rows. PII-free. Rows come back as short plain lines to relay as plain text.',
      { type: 'object', properties: { section: str('One section only', { enum: SECTIONS }), limit: { type: 'number', default: 5 } } },
      async ({ section, limit = 5 }, ctx) => {
        const open = await openCases(store())
        const now = Date.now()
        const ranked = rankAttention(open, now, { limit: 0 })
        const areaList = await loadAreas(store())
        const wrongArea = new Map(open.map(c => [c.id, possiblyWrongArea(c, areaList)]).filter(([, w]) => w))
        const by = {
          unassigned: open.filter(isUnassigned),
          needs_human: open.filter(c => tagList(c).includes('needs-human')),
          unreplied: open.filter(c => tagList(c).includes('ai-offline')),
          drafts: open.filter(c => tagList(c).includes('draft-pending')),
          flagged: open.filter(c => tagList(c).includes('flagged-reply')),
          signoff: await signOffCandidates(store(), ctx),
          wrong_area: open.filter(c => wrongArea.has(c.id)),
          attention: ranked.items.map(x => x.c),
        }
        const reasons = new Map(ranked.items.map(x => [x.c.id, x.reason]))
        // A record whose location text points at an area other than the one its holder
        // covers (areas.js possiblyWrongArea): say where it may belong, on every listing.
        for (const [id, w] of wrongArea) reasons.set(id, `${reasons.has(id) ? reasons.get(id) + '; ' : ''}may belong in ${w.location_area?.name || w.association_area?.name || 'another area'}`)
        const n = Math.min(Math.max(Number(limit) || 5, 1), 25)
        const pick = section && SECTIONS.includes(section) ? [section] : SECTIONS
        const counts = Object.fromEntries(SECTIONS.map(s => [s, by[s].length]))
        const rows = Object.fromEntries(pick.filter(s => by[s].length).map(s => [s, by[s].slice(0, n).map(c => phoneLine(teamRow(c, ctx, reasons.has(c.id) ? { why: reasons.get(c.id) } : {})))]))
        const parts = SECTIONS.filter(s => counts[s]).map(s => `${counts[s]} ${s.replace('_', ' ')}`)
        const say = `${open.length} open.${parts.length ? ' ' + parts.join(', ') + '.' : ' Nothing is waiting on anyone.'}`
        return { open_total: open.length, counts, say, lines: rows, note: PLAIN_NOTE }
      }),
    defTool('team_handover', 'cases',
      'Shift handover summary: what needs attention now, hand-offs nobody has taken, held drafts, and what was touched since the shift marker, as short plain lines to relay as plain text. PII-free. Use when the operator asks for a handover or what changed.',
      { type: 'object', properties: {} },
      async (_args, ctx) => {
        const open = await openCases(store())
        const marker = await store().getShiftMarker().catch(() => null)
        const since = marker?.ts || 0
        const touched = open.filter(c => since && (tsMs(c.last_event_at) || tsMs(c.updated_at) || 0) >= since)
        return {
          since: since || null, since_by: marker?.by || null,
          attention: rankAttention(open, Date.now(), { limit: 10 }).items.map(x => phoneLine(teamRow(x.c, ctx, { why: x.reason }))),
          handoffs_not_taken: open.filter(c => tagList(c).includes('needs-human') && isUnassigned(c)).slice(0, 10).map(c => phoneLine(teamRow(c, ctx))),
          held_drafts: open.filter(c => tagList(c).includes('draft-pending')).slice(0, 10).map(c => phoneLine(teamRow(c, ctx))),
          touched_since: touched.length, touched: touched.slice(0, 10).map(c => phoneLine(teamRow(c, ctx))),
          note: PLAIN_NOTE,
        }
      }),
    defTool('team_assign', 'cases',
      'Assign an open record to a team member by name ("me" for the operator themselves), or pass "unassigned" to take it off whoever has it. Unassigning hands the conversation back to the assistant. The assignee hears about it the next time they message; nobody is messaged now.',
      { type: 'object', properties: { case: str('Record reference or id'), to: str('A team member\'s name, "me", or "unassigned"') }, required: ['case', 'to'] },
      async ({ case: ref, to }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        const by = staffLabel(ctx.contact)
        const user = opUser(ctx)
        const target = String(to).trim().toLowerCase()
        if (target === 'unassigned' || target === 'nobody') {
          const out = await releaseCase({ store: store(), caseRow: c, by, user })
          clearFocusForCase(c.id)
          return { ok: true, ref: c.ref, assigned_to: 'nobody', assistant_resumed: out.resumed }
        }
        if (doneStages().includes(c.status)) return { error: 'That record is finished. Reopen it first if it should be worked on again.' }
        let assignee = target === 'me' ? ctx.contact : null
        if (!assignee) {
          const r = await resolveTeamContact(store(), to); if (r.error) return r
          assignee = r.contact
        }
        const key = assigneeKeyFor(assignee)
        if (String(c.assignee || '').trim() === key) return { ok: true, ref: c.ref, assigned_to: staffLabel(assignee), note: 'Already with them.' }
        if (isOwnConversation(c, assignee)) return { error: 'That record is their own chat with the assistant, so it cannot be assigned to them.' }
        await store().updateCase(c.id, { assignee: key }, user)
        clearFocusForCase(c.id)
        await store().appendEvent(c.id, {
          kind: 'action', actor: 'operator', text: `edited assignee`,
          data: actorData(ctx, { assignee: key, assigned_contact_id: assignee.id, assigned_name: staffLabel(assignee) }),
        })
        return { ok: true, ref: c.ref, assigned_to: staffLabel(assignee), tier: TIER_LABELS[resolveTierValue(assignee.tier)] }
      }),
    defTool('team_draft', 'cases',
      'Approve or discard the assistant\'s held draft reply on a record. Approving sends it (or your edited `text`) to the reporter, refused with an honest reason if they asked us to stop or last wrote over 24 hours ago; discarding sends nothing and leaves the record wanting a person.',
      {
        type: 'object',
        properties: {
          case: str('Record reference or id'),
          action: str('approve or discard', { enum: ['approve', 'discard'] }),
          text: str('Optional edited wording when approving'),
          reason: str('Optional reason when discarding'),
        },
        required: ['case', 'action'],
      },
      async ({ case: ref, action, text, reason = '' }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        const draft = await pendingDraft(store(), c)
        if (!draft) return { error: 'There is no held draft on that record.' }
        const by = staffLabel(ctx.contact)
        if (action === 'discard') {
          await store().updateCase(c.id, { tags: dropTag(c.tags, 'draft-pending') }, opUser(ctx))
          await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text: `DRAFT DISCARDED: ${String(reason).trim() || 'operator discarded'}.`, data: actorData(ctx) })
          return { ok: true, ref: c.ref, discarded: true }
        }
        const body = String(text || '').trim() || String(draft.text || '')
        const sent = await sendStaffMessage({
          store: store(), sendReply: ctx?.sendReply, canSend: ctx?.canSend, caseRow: c, text: body, staff: staffOf(ctx),
          claim: false, dropTags: ['draft-pending'], extra: { from_draft: true },
        })
        return sent.ok ? { ok: true, delivered: true, ref: c.ref, by } : { ok: false, delivered: false, ref: c.ref, error: sent.error }
      }),
    defTool('team_remind', 'cases',
      'Nudge a reporter who has gone quiet on a record: sends the standard reminder (or your own `text`) once through the assistant\'s number. Refused, and says why, if the record is finished, they asked us to stop, they were already reminded and have not answered, or they last wrote over 24 hours ago.',
      { type: 'object', properties: { case: str('Record reference or id'), text: str('Optional own wording') }, required: ['case'] },
      async ({ case: ref, text }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        // Lazy: operator-reminder.js -> notifiers.js -> handler.js -> ... -> this toolset (import cycle).
        const { prepareReminder, OPERATOR_REMINDER_FLAG } = await import('./hooks/operator-reminder.js')
        const plan = await prepareReminder({ store: store(), caseRow: c, overrideText: text && String(text).trim() ? String(text) : null })
        if (!plan.ok) return { ok: false, delivered: false, ref: c.ref, error: plan.error }
        const sent = await sendStaffMessage({
          store: store(), sendReply: ctx?.sendReply, canSend: ctx?.canSend, caseRow: c, text: plan.text, staff: staffOf(ctx),
          claim: false, answers: false,
          extra: { [OPERATOR_REMINDER_FLAG]: true, operator_authored: plan.operator_authored, quiet_for_ms: plan.quietForMs, breaches: plan.breaches },
        })
        return sent.ok ? { ok: true, delivered: true, ref: c.ref, text: plan.text } : { ok: false, delivered: false, ref: c.ref, error: sent.error }
      }),
    defTool('team_invite', 'cases',
      'Create a one-time WhatsApp code that puts whoever sends it (as their only message, to this number) into a role. The role you can grant: field worker. Only an admin, from the dashboard, can grant animal health technician (sign-off) or operator. The code is shown once: read it to the operator to pass on.',
      {
        type: 'object',
        properties: {
          role: str('Role to grant', { enum: grantableBy(false) }),
          label: str('Optional note about who it is for'),
          ttl_hours: { type: 'number', description: 'Hours the code stays valid (default 72)' },
        },
        required: ['role'],
      },
      async ({ role, label = '', ttl_hours }, ctx) => {
        try {
          const inv = await createInvite(store(), { tier: role, label, ttlHours: ttl_hours, by: staffLabel(ctx.contact), grantableTiers: grantableBy(false) })
          return { ok: true, code: inv.code, role: TIER_LABELS[inv.tier], expires_at: inv.expires_at, single_use: true }
        } catch (e) { return { error: e.message } }
      }),
    defTool('team_register', 'cases',
      'Put a phone number into a role right now (field worker), creating the contact if it has never written in. Never demotes someone; only an admin, from the dashboard, can make an animal health technician or an operator.',
      {
        type: 'object',
        properties: {
          phone: str('The phone number, e.g. 082 123 4567 or +27821234567'),
          role: str('Role to grant', { enum: grantableBy(false) }),
          name: str('Their name'),
        },
        required: ['phone', 'role'],
      },
      async ({ phone, role, name = '' }, ctx) => {
        if (!grantableBy(false).includes(role)) return { error: 'That role cannot be granted from here.' }
        const external_id = normalizeMsisdn(phone)
        if (!external_id) return { error: 'That does not look like a phone number. Ask for it again.' }
        // A role is granted only to a number the operator typed in THIS message. Text
        // read out of a report (a reporter's words reach the model through the queue and
        // case tools) cannot choose who becomes team: no digits from the operator, no grant.
        const said = String(ctx?.inboundText || '').replace(/\D/g, '')
        if (!said.includes(external_id) && !said.includes('0' + external_id.slice(2))) return { error: 'Nothing was changed. Ask the operator to type the phone number in their message, then try again.' }
        const existing = (await store().listContacts({ limit: 1000 })).find(k => k.external_id === external_id && k.channel === 'whatsapp')
        if (existing && TIER_ORDER.indexOf(resolveTierValue(existing.tier)) > TIER_ORDER.indexOf(role)) {
          return { error: `That number already holds a higher role (${TIER_LABELS[resolveTierValue(existing.tier)]}); it was not changed.` }
        }
        const k = await store().registerContact({ channel: 'whatsapp', external_id, display_name: String(name).trim().slice(0, 80), tier: role }, { id: staffLabel(ctx.contact), role: 'operator' })
        return { ok: true, name: staffLabel(k), role: TIER_LABELS[resolveTierValue(k.tier)], number_ending: external_id.slice(-3) }
      }),
    defTool('team_roster', 'cases',
      'Who is on the team: names, roles, and how many open records each holds. No phone numbers.',
      { type: 'object', properties: {} },
      async () => {
        const team = await teamContacts(store())
        const open = await openCases(store())
        return { team: team.map(k => ({ name: staffLabel(k), role: TIER_LABELS[resolveTierValue(k.tier)], open_assigned: open.filter(c => isAssignedTo(c, k)).length })) }
      }),
    defTool('team_quiet_staff', 'cases',
      `Team members whose assigned records have gone quiet: nothing from them since the assignment (or for ${QUIET_DEFAULT_HOURS}+ hours), ranked by how long, with whether the reporter is waiting, their number for a direct nudge, whether the assistant can still reach them (their own 24h window), and a drafted nudge. Deliberately shows THEIR number; never a reporter's. To see what is behind a quiet ranger (their area's cases today, what each still needs) use team_ranger_day with their name.`,
      { type: 'object', properties: { hours: { type: 'number', description: `Quiet for at least this many hours (default ${QUIET_DEFAULT_HOURS})` } } },
      async ({ hours = QUIET_DEFAULT_HOURS }, ctx) => {
        const threshold = Math.max(Number.isFinite(Number(hours)) ? Number(hours) : QUIET_DEFAULT_HOURS, 0) * 3600e3
        const now = Date.now()
        const mine = (await openCases(store())).filter(c => isContactAssignee(c.assignee))
        const perStaff = new Map()
        for (const c of mine) {
          const id = contactIdOfAssignee(c.assignee)
          const events = await store().listEvents(c.id)
          const acted = events.filter(e => { const d = evData(e); return d.staff_contact_id === id || d.assigned_contact_id === id || d.claimed_by === c.assignee })
          const lastAct = acted.length ? tsMs(acted[acted.length - 1].created_at) : null
          const assignedAt = tsMs(events.filter(e => evData(e).assigned_contact_id === id || evData(e).claimed_by === c.assignee).pop()?.created_at) || tsMs(c.updated_at) || now
          const quietMs = now - (lastAct || assignedAt)
          if (quietMs < threshold) continue
          const lastIn = events.filter(e => e.kind === 'inbound').pop()
          const lastOut = events.filter(e => e.kind === 'outbound' && e.actor === 'operator').pop()
          const waiting = !!lastIn && (!lastOut || tsMs(lastIn.created_at) > tsMs(lastOut.created_at))
          const entry = perStaff.get(id) || { id, cases: [] }
          entry.cases.push({ ref: c.ref, quiet_hours: Math.round(quietMs / 3600e3), reporter_waiting: waiting, ever_acted: !!lastAct })
          perStaff.set(id, entry)
        }
        const out = []
        for (const { id, cases } of perStaff.values()) {
          const k = await store().getContact(id).catch(() => null)
          if (!k) continue
          let reachable = false
          try {
            const { withinSessionWindow } = await import('./hooks/notifiers.js')
            const own = await store().findOpenCase({ channel: k.channel, external_id: k.external_id })
            reachable = !!own && withinSessionWindow(own, await store().listEventsPage(own.id, { limit: 25, offset: 0 }), now)
          } catch { reachable = false }
          cases.sort((a, b) => b.quiet_hours - a.quiet_hours)
          out.push({
            name: staffLabel(k), role: TIER_LABELS[resolveTierValue(k.tier)], phone: fmtPhone27(k.external_id),
            reachable_through_assistant: reachable, see_their_day_with: 'team_ranger_day', waiting_reporters: cases.filter(x => x.reporter_waiting).length, cases: cases.slice(0, 8),
            nudge_text: `Hello ${staffLabel(k).split(' ')[0]}, it is ${staffLabel(ctx.contact)} from the team. ${cases.length === 1 ? `${cases[0].ref} has` : `${cases.length} of your records have`} been quiet${cases.some(x => x.reporter_waiting) ? ' and the reporter is waiting to hear from you' : ''}. Can you update us or tell us if someone else should take ${cases.length === 1 ? 'it' : 'them'}?`,
          })
        }
        out.sort((a, b) => b.waiting_reporters - a.waiting_reporters || (b.cases[0]?.quiet_hours || 0) - (a.cases[0]?.quiet_hours || 0))
        return { count: out.length, staff: out }
      }),
    defTool('team_nudge_staff', 'cases',
      'Message a team member through the assistant\'s number (their own conversation), e.g. the nudge from team_quiet_staff. Refused, and says so, if they last wrote over 24 hours ago -- then the operator should message them from their own phone.',
      { type: 'object', properties: { name: str('The team member\'s name'), text: str('The message') }, required: ['name', 'text'] },
      async ({ name, text }, ctx) => {
        const r = await resolveTeamContact(store(), name); if (r.error) return r
        const own = await store().findOpenCase({ channel: r.contact.channel, external_id: r.contact.external_id }).catch(() => null)
        if (!own) return { ok: false, delivered: false, error: 'nothing was sent: they have no conversation with the assistant that is open, so message them from your own phone.' }
        const sent = await sendStaffMessage({ store: store(), sendReply: ctx?.sendReply, canSend: ctx?.canSend, caseRow: own, text, staff: staffOf(ctx), claim: false, answers: false, extra: { staff_nudge: true } })
        return sent.ok ? { ok: true, delivered: true, to: staffLabel(r.contact) } : { ok: false, delivered: false, error: sent.error }
      }),
  ]
}
