import { visibleToolName } from './config-loader.js'
import { vocabText } from './config-loader.js'


import { defTool, str } from './case-tools-shared.js'
import { tagList, tsMs } from './timestamp.js'
import { isOpenCase, fmtPhone27 } from './format.js'
import { rankAttention } from './attn.js'
import { TIER_ORDER, grantableBy, atLeast, resolveTierValue, TIER } from './contact-tiers.js'
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
import { findCase, teamRow, actorData, doneStages, reporterExtras } from './case-tools-team-shared.js'
import { caseyText } from './deployment-text.js';

const NO_SUCH = { error: caseyText("src/case-tools-team-operator.js#0") }
const staffOf = (ctx) => ({ ...(ctx?.contact || {}), tier: ctx?.tier })
const opUser = (ctx) => ({ id: staffLabel(ctx?.contact), role: 'operator' })
const SECTIONS = ['unassigned', 'needs_human', 'unreplied', 'drafts', 'flagged', 'signoff', 'wrong_area', 'attention']
const QUIET_DEFAULT_HOURS = 12

const phoneLine = (row) => [row.ref, ...ENQUIRY_HEADLINE_FIELDS.map(k => row[k]).filter(Boolean).map(v => String(v).replace(/\s+/g, ' ').slice(0, 40)), row.assignee && row.assignee !== UNCLAIMED_ASSIGNEE ? `with ${row.assignee}` : caseyText("src/case-tools-team-operator.js#s0"), row.why ? String(row.why).replace(/\s+/g, ' ').slice(0, 60) : '', row.by_person || ''].filter(Boolean).join(', ')
const PLAIN_NOTE = caseyText("src/case-tools-team-operator.js#1")

const openCases = async (store) => (await store.listCases({}, { limit: 10000, offset: 0 })).filter(c => c.channel !== 'system' && isOpenCase(c))
const isUnassigned = (c) => { const a = String(c.assignee || '').trim(); return !a || a === UNCLAIMED_ASSIGNEE }

export async function teamContacts(store) {
  const all = await store.listContacts({ limit: 500 })
  return all.filter(k => atLeast(k.tier, TIER.field))
}

export async function resolveTeamContact(store, name) {
  const want = String(name || '').trim().toLowerCase()
  if (!want) return { error: caseyText("src/case-tools-team-operator.js#s1") }
  const team = await teamContacts(store)
  const exact = team.filter(k => String(k.display_name || '').trim().toLowerCase() === want)
  const hits = exact.length ? exact : team.filter(k => String(k.display_name || '').toLowerCase().includes(want))
  if (hits.length === 1) return { contact: hits[0] }
  return { error: hits.length ? caseyText("src/case-tools-team-operator.js#2", [hits.length]) : caseyText("src/case-tools-team-operator.js#3"), candidates: (hits.length ? hits : team).slice(0, 12).map(k => staffLabel(k)) }
}

export function buildTeamOperatorTools(store) {
  return [
    defTool('team_queue', 'cases',
      caseyText("src/case-tools-team-operator.js#4"),
      { type: 'object', properties: { section: str(caseyText("src/case-tools-team-operator.js#s2"), { enum: SECTIONS }), limit: { type: 'number', default: 5 } } },
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

        for (const [id, w] of wrongArea) reasons.set(id, caseyText("src/case-tools-team-operator.js#s3", [reasons.has(id) ? reasons.get(id) + '; ' : '', w.location_area?.name || w.stated_area?.name || caseyText("src/case-tools-team-operator.js#s4")]))
        const n = Math.min(Math.max(Number(limit) || 5, 1), 25)
        const pick = section && SECTIONS.includes(section) ? [section] : SECTIONS
        const counts = Object.fromEntries(SECTIONS.map(s => [s, by[s].length]))

        const shown = pick.flatMap(s => by[s].slice(0, n))
        const { text: personTag } = await reporterExtras(store(), shown)
        const rows = Object.fromEntries(pick.filter(s => by[s].length).map(s => [s, by[s].slice(0, n).map(c => phoneLine(teamRow(c, ctx, { ...(reasons.has(c.id) ? { why: reasons.get(c.id) } : {}), ...personTag(c) })))]))
        const parts = SECTIONS.filter(s => counts[s]).map(s => `${counts[s]} ${s.replace('_', ' ')}`)
        const say = `${open.length} open.${parts.length ? ' ' + parts.join(', ') + '.' : caseyText("src/case-tools-team-operator.js#s5")}`
        return { open_total: open.length, counts, say, lines: rows, note: PLAIN_NOTE }
      }),
    defTool('team_handover', 'cases',
      caseyText("src/case-tools-team-operator.js#5"),
      { type: 'object', properties: {} },
      async (_args, ctx) => {
        const open = await openCases(store())
        const marker = await store().getShiftMarker().catch(() => null)
        const since = marker?.ts || 0
        const touched = open.filter(c => since && (tsMs(c.last_event_at) || tsMs(c.updated_at) || 0) >= since)
        const attention = rankAttention(open, Date.now(), { limit: 10 }).items
        const notTaken = open.filter(c => tagList(c).includes('needs-human') && isUnassigned(c)).slice(0, 10)
        const drafts = open.filter(c => tagList(c).includes('draft-pending')).slice(0, 10)

        const { text: personTag } = await reporterExtras(store(), [...attention.map(x => x.c), ...notTaken, ...drafts, ...touched.slice(0, 10)])
        return {
          since: since || null, since_by: marker?.by || null,
          attention: attention.map(x => phoneLine(teamRow(x.c, ctx, { why: x.reason, ...personTag(x.c) }))),
          handoffs_not_taken: notTaken.map(c => phoneLine(teamRow(c, ctx, personTag(c)))),
          held_drafts: drafts.map(c => phoneLine(teamRow(c, ctx, personTag(c)))),
          touched_since: touched.length, touched: touched.slice(0, 10).map(c => phoneLine(teamRow(c, ctx, personTag(c)))),
          note: PLAIN_NOTE,
        }
      }),
    defTool('team_assign', 'cases',
      caseyText("src/case-tools-team-operator.js#6"),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-team-operator.js#s6")), to: str(caseyText("src/case-tools-team-operator.js#7")) }, required: ['case', 'to'] },
      async ({ case: ref, to }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        const by = staffLabel(ctx.contact)
        const user = opUser(ctx)
        const target = String(to).trim().toLowerCase()
        if (target === 'unassigned' || target === 'nobody') {
          const out = await releaseCase({ store: store(), caseRow: c, by, user })
          await clearFocusForCase(store(), c.id)
          return { ok: true, ref: c.ref, assigned_to: 'nobody', assistant_resumed: out.resumed }
        }
        if (doneStages().includes(c.status)) return { error: caseyText("src/case-tools-team-operator.js#8") }
        let assignee = target === 'me' ? ctx.contact : null
        if (!assignee) {
          const r = await resolveTeamContact(store(), to); if (r.error) return r
          assignee = r.contact
        }
        const key = assigneeKeyFor(assignee)
        if (String(c.assignee || '').trim() === key) return { ok: true, ref: c.ref, assigned_to: staffLabel(assignee), note: caseyText("src/case-tools-team-operator.js#s7") }
        if (isOwnConversation(c, assignee)) return { error: caseyText("src/case-tools-team-operator.js#9") }
        await store().updateCase(c.id, { assignee: key }, user)
        await clearFocusForCase(store(), c.id)
        await store().appendEvent(c.id, {
          kind: 'action', actor: 'operator', text: caseyText("src/case-tools-team-operator.js#s8"),
          data: actorData(ctx, { assignee: key, assigned_contact_id: assignee.id, assigned_name: staffLabel(assignee) }),
        })
        return { ok: true, ref: c.ref, assigned_to: staffLabel(assignee), tier: TIER_LABELS[resolveTierValue(assignee.tier)] }
      }),
    defTool('team_draft', 'cases',
      caseyText("src/case-tools-team-operator.js#10"),
      {
        type: 'object',
        properties: {
          case: str(caseyText("src/case-tools-team-operator.js#s9")),
          action: str(caseyText("src/case-tools-team-operator.js#s10"), { enum: ['approve', 'discard'] }),
          text: str(caseyText("src/case-tools-team-operator.js#s11")),
          reason: str(caseyText("src/case-tools-team-operator.js#s12")),
        },
        required: ['case', 'action'],
      },
      async ({ case: ref, action, text, reason = '' }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        const draft = await pendingDraft(store(), c)
        if (!draft) return { error: caseyText("src/case-tools-team-operator.js#s13") }
        const by = staffLabel(ctx.contact)
        if (action === 'discard') {
          await store().updateCase(c.id, { tags: dropTag(c.tags, 'draft-pending') }, opUser(ctx))
          await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text: caseyText("src/case-tools-team-operator.js#s14", [String(reason).trim() || caseyText("src/case-tools-team-operator.js#s15")]), data: actorData(ctx) })
          return { ok: true, ref: c.ref, discarded: true }
        }
        const body = String(text || '').trim() || String(draft.text || '')
        const sent = await sendStaffMessage({
          store: store(), sendReply: ctx?.sendReply, canSend: ctx?.canSend, caseRow: c, text: body, staff: staffOf(ctx),
          claim: false, dropTags: ['draft-pending'], extra: { from_draft: true },
        })
        return sent.ok ? { ok: true, delivered: true, ref: c.ref, by } : { ok: false, delivered: false, ref: c.ref, error: sent.error }
      }),
    defTool('team_invite', 'cases',
      caseyText("src/case-tools-team-operator.js#11"),
      {
        type: 'object',
        properties: {
          role: str(caseyText("src/case-tools-team-operator.js#s16"), { enum: grantableBy(false) }),
          label: str(caseyText("src/case-tools-team-operator.js#s17")),
          ttl_hours: { type: 'number', description: caseyText("src/case-tools-team-operator.js#s18") },
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
      caseyText("src/case-tools-team-operator.js#12"),
      {
        type: 'object',
        properties: {
          phone: str(caseyText("src/case-tools-team-operator.js#13")),
          role: str(caseyText("src/case-tools-team-operator.js#s19"), { enum: grantableBy(false) }),
          name: str(caseyText("src/case-tools-team-operator.js#s20")),
        },
        required: ['phone', 'role'],
      },
      async ({ phone, role, name = '' }, ctx) => {
        if (!grantableBy(false).includes(role)) return { error: caseyText("src/case-tools-team-operator.js#s21") }
        const external_id = normalizeMsisdn(phone)
        if (!external_id) return { error: caseyText("src/case-tools-team-operator.js#14") }

        const said = String(ctx?.inboundText || '').replace(/\D/g, '')
        if (!said.includes(external_id) && !said.includes('0' + external_id.slice(2))) return { error: caseyText("src/case-tools-team-operator.js#15") }
        const existing = (await store().listContacts({ limit: 1000 })).find(k => k.external_id === external_id && k.channel === 'whatsapp')
        if (existing && TIER_ORDER.indexOf(resolveTierValue(existing.tier)) > TIER_ORDER.indexOf(role)) {
          return { error: caseyText("src/case-tools-team-operator.js#16", [TIER_LABELS[resolveTierValue(existing.tier)]]) }
        }
        const k = await store().registerContact({ channel: 'whatsapp', external_id, display_name: String(name).trim().slice(0, 80), tier: role }, { id: staffLabel(ctx.contact), role: 'operator' })
        return { ok: true, name: staffLabel(k), role: TIER_LABELS[resolveTierValue(k.tier)], number_ending: external_id.slice(-3) }
      }),
    defTool('team_roster', 'cases',
      caseyText("src/case-tools-team-operator.js#17"),
      { type: 'object', properties: {} },
      async () => {
        const team = await teamContacts(store())
        const open = await openCases(store())
        return { team: team.map(k => ({ name: staffLabel(k), role: TIER_LABELS[resolveTierValue(k.tier)], open_assigned: open.filter(c => isAssignedTo(c, k)).length })) }
      }),
    defTool('team_quiet_staff', 'cases',
      caseyText("src/case-tools-team-operator.js#18", [QUIET_DEFAULT_HOURS]),
      { type: 'object', properties: { hours: { type: 'number', description: caseyText("src/case-tools-team-operator.js#19", [QUIET_DEFAULT_HOURS]) } } },
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
            reachable_through_assistant: reachable, see_their_day_with: visibleToolName('team_specialist_day'), waiting_reporters: cases.filter(x => x.reporter_waiting).length, cases: cases.slice(0, 8),
            nudge_text: caseyText("src/case-tools-team-operator.js#20", [staffLabel(k).split(' ')[0], staffLabel(ctx.contact), cases.length === 1 ? `${cases[0].ref} has` : caseyText("src/case-tools-team-operator.js#s22", [cases.length]), cases.some(x => x.reporter_waiting) ? caseyText("src/case-tools-team-operator.js#21") : '', cases.length === 1 ? 'it' : 'them']),
          })
        }
        out.sort((a, b) => b.waiting_reporters - a.waiting_reporters || (b.cases[0]?.quiet_hours || 0) - (a.cases[0]?.quiet_hours || 0))
        return { count: out.length, staff: out }
      }),
    defTool('team_nudge_staff', 'cases',
      caseyText("src/case-tools-team-operator.js#22"),
      { type: 'object', properties: { name: str(caseyText("src/case-tools-team-operator.js#s23")), text: str(caseyText("src/case-tools-team-operator.js#s24")) }, required: ['name', 'text'] },
      async ({ name, text }, ctx) => {
        const r = await resolveTeamContact(store(), name); if (r.error) return r
        const own = await store().findOpenCase({ channel: r.contact.channel, external_id: r.contact.external_id }).catch(() => null)
        if (!own) return { ok: false, delivered: false, error: vocabText('ui.team_message_no_conversation', caseyText("src/case-tools-team-operator.js#23")) }
        const sent = await sendStaffMessage({ store: store(), sendReply: ctx?.sendReply, canSend: ctx?.canSend, caseRow: own, text, staff: staffOf(ctx), claim: false, answers: false, extra: { staff_nudge: true } })
        return sent.ok ? { ok: true, delivered: true, to: staffLabel(r.contact) } : { ok: false, delivered: false, error: sent.error }
      }),
  ]
}
