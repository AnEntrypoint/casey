

import { visibleToolName } from './config-loader.js'
import { defTool, str } from './case-tools-shared.js'
import { staffLabel } from './hooks/staff-outbound.js'
import { writeGate, recordedOn } from './team-focus.js'
import { REPORT_ENTITY_LABEL } from './store/report-shape.js'
import { TIER_LABELS } from './store/report-shape.js'
import { resolveTierValue } from './contact-tiers.js'
import { handoffToSpecialist, withdrawHandoff } from './signoff-desk.js'
import { myDay, keysForContact } from './my-day.js'
import { relocateCase } from './areas.js'
import { findCase, authorityOn, ownFiledAuthority, storeUser, actorData, NOT_ASSIGNED } from './case-tools-team-shared.js'
import { resolveTeamContact } from './case-tools-team-operator.js'
import { assigneeKeyFor } from './case-assignment.js'
import { caseyText } from './deployment-text.js';

const NO_SUCH = { error: caseyText("src/case-tools-team-desk.js#0") }

export function buildTeamDeskTools(store) {
  return [
    defTool(visibleToolName('case_handoff_to_specialist'), 'cases',
      caseyText("src/case-tools-team-desk.js#1", [REPORT_ENTITY_LABEL, REPORT_ENTITY_LABEL]),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-team-desk.js#s0")), note: str(caseyText("src/case-tools-team-desk.js#s1")) }, required: ['case'] },
      async ({ case: ref, note = '' }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        const authority = authorityOn(ctx, c) || ownFiledAuthority(ctx, c)
        if (!authority) return NOT_ASSIGNED
        if (authority === 'assigned') { const refused = await writeGate(store(), ctx, c); if (refused) return refused }
        const r = await handoffToSpecialist(store(), c.id, { by: staffLabel(ctx.contact), user: storeUser(ctx, authority), data: actorData(ctx), note })
        if (!r.ok) return { error: r.error, ...(r.missing ? { still_missing: r.missing } : {}) }
        return { ok: true, ref: c.ref, recorded_on: await recordedOn(store(), c, ctx), handed_to_sign_off_desk: true, ...(r.already ? { note: caseyText("src/case-tools-team-desk.js#s2") } : {}) }
      }),
    defTool('case_withdraw_handoff', 'cases',
      caseyText("src/case-tools-team-desk.js#2", [REPORT_ENTITY_LABEL, REPORT_ENTITY_LABEL]),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-team-desk.js#s3")), reason: str(caseyText("src/case-tools-team-desk.js#3")) }, required: ['case'] },
      async ({ case: ref, reason = '' }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        const authority = authorityOn(ctx, c) || ownFiledAuthority(ctx, c)
        if (!authority) return NOT_ASSIGNED
        if (authority === 'assigned') { const refused = await writeGate(store(), ctx, c); if (refused) return refused }
        const r = await withdrawHandoff(store(), c.id, { by: staffLabel(ctx.contact), user: storeUser(ctx, authority), data: actorData(ctx), reason, byRanger: true })
        if (!r.ok) return { error: r.error }
        return { ok: true, ref: c.ref, recorded_on: await recordedOn(store(), c, ctx), withdrawn: r.was, ...(r.was ? {} : { note: caseyText("src/case-tools-team-desk.js#4") }) }
      }),
    defTool('case_my_day', 'cases',
      caseyText("src/case-tools-team-desk.js#5", [REPORT_ENTITY_LABEL]),
      { type: 'object', properties: {} },
      async (_args, ctx) => {
        const contact = ctx?.contact
        if (!contact?.id) return { error: caseyText("src/case-tools-team-desk.js#6") }
        return myDay(store(), { keys: await keysForContact(store(), contact), contact, tier: ctx.tier, name: staffLabel(contact) })
      }),
    defTool(visibleToolName('team_specialist_day'), 'cases',
      caseyText("src/case-tools-team-desk.js#7"),
      { type: 'object', properties: { name: str(caseyText("src/case-tools-team-desk.js#8")) }, required: ['name'] },
      async ({ name }, ctx) => {
        const r = await resolveTeamContact(store(), name); if (r.error) return r
        return { ranger: staffLabel(r.contact), role: TIER_LABELS[resolveTierValue(r.contact.tier)], ...(await myDay(store(), { keys: await keysForContact(store(), r.contact), contact: r.contact, tier: r.contact.tier, name: staffLabel(r.contact) })) }
      }),
    defTool('team_relocate_case', 'cases',
      caseyText("src/case-tools-team-desk.js#9", [REPORT_ENTITY_LABEL, REPORT_ENTITY_LABEL]),
      {
        type: 'object',
        properties: {
          case: str(caseyText("src/case-tools-team-desk.js#s4")),
          area: str(caseyText("src/case-tools-team-desk.js#10")),
          association: str(caseyText("src/case-tools-team-desk.js#11")),
          assign_to: str(caseyText("src/case-tools-team-desk.js#12")),
          keep_holder: { type: 'boolean', description: caseyText("src/case-tools-team-desk.js#13") },
          reason: str(caseyText("src/case-tools-team-desk.js#s5")),
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
        const out = await relocateCase(store(), c.id, { area, stated: association, assignee, reassign: !keep_holder, reason, by, user: { id: by, role: 'operator' } })
        return out.ok ? { ok: true, ref: c.ref, from_area: out.from_area, to_area: out.to_area, area_is_mapped: out.mapped, reassigned: out.reassigned, now_with: out.assigned_to?.name || null } : { ok: false, error: out.error }
      }),
  ]
}
