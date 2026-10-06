

import { defTool, str } from './case-tools-shared.js'
import { staffLabel } from './hooks/staff-outbound.js'
import { writeGate, recordedOn } from './team-focus.js'
import { REPORT_ENTITY_LABEL } from './store/report-shape.js'
import { TIER_LABELS } from './store/report-shape.js'
import { resolveTierValue } from './contact-tiers.js'
import { handoffToTechnician, withdrawHandoff } from './signoff-desk.js'
import { myDay, keysForContact } from './my-day.js'
import { relocateCase } from './areas.js'
import { findCase, authorityOn, ownFiledAuthority, storeUser, actorData, NOT_ASSIGNED } from './case-tools-team-shared.js'
import { resolveTeamContact } from './case-tools-team-operator.js'
import { assigneeKeyFor } from './case-assignment.js'

const NO_SUCH = { error: 'No such record. Ask for the reference again.' }

export function buildTeamDeskTools(store) {
  return [
    defTool('case_handoff_to_technician', 'cases',
      `Hand ONE assigned ${REPORT_ENTITY_LABEL} to the sign-off desk once the team member has confirmed it holds every required fact: it then shows in the animal health technician's queue and they are told. It stays with the team member (they keep supporting it) and the technician can send it back. Refused, naming what is missing, if a required fact is blank. Only for a ${REPORT_ENTITY_LABEL} assigned to this person; say the reference and the animals and place first and act only after they have confirmed it.`,
      { type: 'object', properties: { case: str('Record reference or id'), note: str('Optional short note for the technician') }, required: ['case'] },
      async ({ case: ref, note = '' }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        const authority = authorityOn(ctx, c) || ownFiledAuthority(ctx, c)
        if (!authority) return NOT_ASSIGNED
        if (authority === 'assigned') { const refused = await writeGate(store(), ctx, c); if (refused) return refused }
        const r = await handoffToTechnician(store(), c.id, { by: staffLabel(ctx.contact), user: storeUser(ctx, authority), data: actorData(ctx), note })
        if (!r.ok) return { error: r.error, ...(r.missing ? { still_missing: r.missing } : {}) }
        return { ok: true, ref: c.ref, recorded_on: await recordedOn(store(), c, ctx), handed_to_sign_off_desk: true, ...(r.already ? { note: 'It was already with the sign-off desk.' } : {}) }
      }),
    defTool('case_withdraw_handoff', 'cases',
      `Take ONE ${REPORT_ENTITY_LABEL} back from the sign-off desk when the team member realises it is not ready, so it leaves the technician's queue and stays with them. Only for a ${REPORT_ENTITY_LABEL} assigned to this person; say the reference and the animals and place first and act only after they have confirmed it. Safe to repeat: if it is not on the desk nothing changes.`,
      { type: 'object', properties: { case: str('Record reference or id'), reason: str('Optional short reason for the technician') }, required: ['case'] },
      async ({ case: ref, reason = '' }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        const authority = authorityOn(ctx, c) || ownFiledAuthority(ctx, c)
        if (!authority) return NOT_ASSIGNED
        if (authority === 'assigned') { const refused = await writeGate(store(), ctx, c); if (refused) return refused }
        const r = await withdrawHandoff(store(), c.id, { by: staffLabel(ctx.contact), user: storeUser(ctx, authority), data: actorData(ctx), reason, byRanger: true })
        if (!r.ok) return { error: r.error }
        return { ok: true, ref: c.ref, recorded_on: await recordedOn(store(), c, ctx), withdrawn: r.was, ...(r.was ? {} : { note: 'It was not with the sign-off desk, so nothing changed.' }) }
      }),
    defTool('case_my_day', 'cases',
      `THIS team member's day: how many ${REPORT_ENTITY_LABEL}s are in the area(s) they cover today and where they stand by stage, how many are with them, what changed since the day began (new, reporter replies, newly assigned, sent back, handed over), and for each of their own what it still needs. A technician also gets the sign-off desk. Call it when they ask how many there are today, what the status is, what is waiting, or what to do next. Counts and short lines only, no phone numbers.`,
      { type: 'object', properties: {} },
      async (_args, ctx) => {
        const contact = ctx?.contact
        if (!contact?.id) return { error: 'Could not tell who you are on this conversation.' }
        return myDay(store(), { keys: await keysForContact(store(), contact), contact, tier: ctx.tier, name: staffLabel(contact) })
      }),
    defTool('team_ranger_day', 'cases',
      `An operator's view of ONE team member's day: the same summary the ranger gets from their own assistant (their area's counts today, their own by stage, what changed since the day began, what each still needs, the sign-off desk for a technician). Use it after team_quiet_staff to see what is behind a quiet ranger. Give the ranger's name. No phone numbers.`,
      { type: 'object', properties: { name: str('The team member\'s name, as team_quiet_staff or team_roster shows it') }, required: ['name'] },
      async ({ name }, ctx) => {
        const r = await resolveTeamContact(store(), name); if (r.error) return r
        return { ranger: staffLabel(r.contact), role: TIER_LABELS[resolveTierValue(r.contact.tier)], ...(await myDay(store(), { keys: await keysForContact(store(), r.contact), contact: r.contact, tier: r.contact.tier, name: staffLabel(r.contact) })) }
      }),
    defTool('team_relocate_case', 'cases',
      `Correct the AREA a ${REPORT_ENTITY_LABEL} was filed under and, by default, hand it to that area's ranger (the one who covered the wrong area is released and the assistant/the new ranger takes over from there). Use when a ${REPORT_ENTITY_LABEL} shows as possibly in the wrong area (team_queue) or the operator says it is really somewhere else. Give the area as it is mapped (area), or as free words (association) if it is not mapped yet, and optionally a team member to give it to instead. The correction is written on the timeline. Say the reference and the new area back and act only after the operator confirms.`,
      {
        type: 'object',
        properties: {
          case: str('Record reference or id'),
          area: str('The mapped area (its name or a spelling listed for it)'),
          association: str('Free words for the place, only when it is not a mapped area'),
          assign_to: str('Optional: a team member\'s name to hold it instead of the area\'s ranger'),
          keep_holder: { type: 'boolean', description: 'True to change only the area and leave who holds it unchanged' },
          reason: str('Why, in a few words'),
        },
        required: ['case'],
      },
      async ({ case: ref, area = '', association = '', assign_to = '', keep_holder = false, reason = '' }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        let assignee = ''
        if (String(assign_to || '').trim()) {
          const r = await resolveTeamContact(store(), assign_to); if (r.error) return r
          assignee = assigneeKeyFor(r.contact)
        }
        const by = staffLabel(ctx.contact)
        const out = await relocateCase(store(), c.id, { area, association, assignee, reassign: !keep_holder, reason, by, user: { id: by, role: 'operator' } })
        return out.ok ? { ok: true, ref: c.ref, from_area: out.from_area, to_area: out.to_area, area_is_mapped: out.mapped, reassigned: out.reassigned, now_with: out.assigned_to?.name || null } : { ok: false, error: out.error }
      }),
  ]
}
