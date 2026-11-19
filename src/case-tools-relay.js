import { visibleToolName } from './config-loader.js'
import { defTool, str } from './case-tools-shared.js'
import { staffLabel } from './hooks/staff-outbound.js'
import { mergeTag, dropTag } from './hooks/heuristics.js'
import { isOpenCase } from './format.js'
import { writeGate, recordedOn, clearFocusForCase } from './team-focus.js'
import { REPORT_ENTITY_LABEL } from './store/report-shape.js'
import { atLeast, TIER } from './contact-tiers.js'
import { assigneeKeyFor, isOwnConversation } from './case-assignment.js'
import { AGENT_USER } from './case-store.js'
import { NOT_ASSIGNED, findCase, authorityOn, deskAuthorityOn, actorData } from './case-tools-team-shared.js'
import { resolveTeamContact } from './case-tools-team-operator.js'
import { RANGER_NOTE, TECHNICIAN_NOTE, HANDOVER_TAG, HANDOVER_TTL_MS, cleanNote, pendingOffer } from './relay.js'
import { caseyText } from './deployment-text.js';

const NO_SUCH = { error: caseyText("src/case-tools-relay.js#0") }
const EMPTY_NOTE = { error: caseyText("src/case-tools-relay.js#1") }

async function writeNote(store, c, ctx, { tag, label, text }) {
  const by = staffLabel(ctx.contact)
  await store.appendEvent(c.id, {
    kind: 'observation', actor: 'operator', text: `${label} from ${by}: ${text}`,
    data: actorData(ctx, { tag, note: text, relayed: true, provenance: 'relayed' }),
  })
}

export function buildRelayTools(store) {
  return [
    defTool('case_note_to_technician', 'cases',
      caseyText("src/case-tools-relay.js#2", [REPORT_ENTITY_LABEL, REPORT_ENTITY_LABEL]),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-relay.js#s0")), text: str(caseyText("src/case-tools-relay.js#3")) }, required: ['case', 'text'] },
      async ({ case: ref, text }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        if (authorityOn(ctx, c) !== 'assigned') return NOT_ASSIGNED
        const refused = await writeGate(store(), ctx, c); if (refused) return refused
        const note = cleanNote(text)
        if (!note) return EMPTY_NOTE
        await writeNote(store(), c, ctx, { tag: RANGER_NOTE, label: caseyText("src/case-tools-relay.js#s1"), text: note })
        return { ok: true, recorded_on: await recordedOn(store(), c, ctx), noted_for_the_technician: true, sent_to_anyone: false }
      }),
    defTool(visibleToolName('case_note_to_specialist'), 'cases',
      caseyText("src/case-tools-relay.js#4", [REPORT_ENTITY_LABEL]),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-relay.js#s2")), text: str(caseyText("src/case-tools-relay.js#s3")) }, required: ['case', 'text'] },
      async ({ case: ref, text }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        const authority = deskAuthorityOn(ctx, c)
        if (!authority) return NOT_ASSIGNED
        if (authority === 'assigned') { const refused = await writeGate(store(), ctx, c); if (refused) return refused }
        const note = cleanNote(text)
        if (!note) return EMPTY_NOTE
        await writeNote(store(), c, ctx, { tag: TECHNICIAN_NOTE, label: caseyText("src/case-tools-relay.js#s4"), text: note })
        return { ok: true, recorded_on: await recordedOn(store(), c, ctx), noted_for_the_ranger: true, sent_to_anyone: false, note: caseyText("src/case-tools-relay.js#5") }
      }),
    defTool('case_offer_handover', 'cases',
      caseyText("src/case-tools-relay.js#6", [REPORT_ENTITY_LABEL]),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-relay.js#s5")), to: str(caseyText("src/case-tools-relay.js#s6")) }, required: ['case', 'to'] },
      async ({ case: ref, to }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        if (authorityOn(ctx, c) !== 'assigned') return NOT_ASSIGNED
        if (!isOpenCase(c)) return { error: caseyText("src/case-tools-relay.js#7") }
        const refused = await writeGate(store(), ctx, c); if (refused) return refused
        const target = await resolveTeamContact(store(), to); if (target.error) return target
        const them = target.contact
        if (them.id === ctx.contact.id) return { error: caseyText("src/case-tools-relay.js#8") }
        if (!atLeast(them.tier, TIER.field)) return { error: caseyText("src/case-tools-relay.js#s7") }
        if (isOwnConversation(c, them)) return { error: caseyText("src/case-tools-relay.js#9") }
        const by = staffLabel(ctx.contact)
        await store().appendEvent(c.id, {
          kind: 'observation', actor: 'operator', text: caseyText("src/case-tools-relay.js#s8", [by, staffLabel(them)]),
          data: actorData(ctx, { handover_offer: true, from_key: assigneeKeyFor(ctx.contact), to_contact_id: them.id, to_name: staffLabel(them) }),
        })
        await store().updateCase(c.id, { tags: mergeTag(c.tags || '', HANDOVER_TAG) }, AGENT_USER)
        return { ok: true, recorded_on: await recordedOn(store(), c, ctx), offered_to: staffLabel(them), still_with_you_until_they_accept: true, lapses_in_hours: HANDOVER_TTL_MS / 3600e3, sent_to_anyone: false }
      }),
    defTool('case_handover_answer', 'cases',
      caseyText("src/case-tools-relay.js#10", [REPORT_ENTITY_LABEL]),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-relay.js#s9")), accept: { type: 'boolean', description: caseyText("src/case-tools-relay.js#s10") } }, required: ['case', 'accept'] },
      async ({ case: ref, accept }, ctx) => {
        const c0 = await findCase(store(), ref)
        if (!c0) return NO_SUCH
        const me = ctx?.contact
        const key = assigneeKeyFor(me)
        if (!key) return { error: caseyText("src/case-tools-relay.js#11") }
        const result = await store()._withLock(`assign|${c0.id}`, async () => {
          const c = await store().getCase(c0.id)
          const offer = pendingOffer(await store().listEvents(c.id))
          if (!offer || offer.to_contact_id !== me.id) return { error: caseyText("src/case-tools-relay.js#12") }
          const stale = offer.expired || String(c.assignee || '').trim() !== offer.from_key || !isOpenCase(c)
          if (stale) {
            await store().updateCase(c.id, { tags: dropTag(c.tags || '', HANDOVER_TAG) }, AGENT_USER)
            await store().appendEvent(c.id, { kind: 'observation', actor: 'system', text: caseyText("src/case-tools-relay.js#s11", [offer.expired ? caseyText("src/case-tools-relay.js#s12") : caseyText("src/case-tools-relay.js#s13")]), data: { handover_answer_to: offer.id, accepted: false, lapsed: true }, touch: false })
            return { error: caseyText("src/case-tools-relay.js#13") }
          }
          if (isOwnConversation(c, me)) return { error: caseyText("src/case-tools-relay.js#14") }
          const by = staffLabel(me)
          if (accept) {
            await store().updateCase(c.id, { assignee: key, tags: dropTag(c.tags || '', HANDOVER_TAG) }, AGENT_USER)
            await store().appendEvent(c.id, { kind: 'action', actor: 'operator', text: caseyText("src/case-tools-relay.js#s14", [offer.by, by]), data: actorData(ctx, { handover_answer_to: offer.id, accepted: true, assignee: key, assigned_contact_id: me.id, assigned_name: by, handover_from: offer.by }) })
            await clearFocusForCase(store(), c.id)
            return { ok: true, ref: c.ref, accepted: true, now_with_you: true }
          }
          await store().updateCase(c.id, { tags: dropTag(c.tags || '', HANDOVER_TAG) }, AGENT_USER)
          await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text: caseyText("src/case-tools-relay.js#s15", [offer.by, by]), data: actorData(ctx, { handover_answer_to: offer.id, accepted: false }) })
          return { ok: true, ref: c.ref, accepted: false, still_with: offer.by }
        })
        return result
      }),
  ]
}
