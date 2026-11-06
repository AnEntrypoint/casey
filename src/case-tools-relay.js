import { defTool, str } from './case-tools-shared.js'
import { staffLabel } from './hooks/staff-outbound.js'
import { mergeTag, dropTag } from './hooks/heuristics.js'
import { isOpenCase } from './format.js'
import { writeGate, recordedOn, clearFocusForCase } from './team-focus.js'
import { REPORT_ENTITY_LABEL } from './store/report-shape.js'
import { atLeast, TIER_FIELD_WORKER } from './contact-tiers.js'
import { assigneeKeyFor, isOwnConversation } from './case-assignment.js'
import { AGENT_USER } from './case-store.js'
import { NOT_ASSIGNED, findCase, authorityOn, deskAuthorityOn, actorData } from './case-tools-team-shared.js'
import { resolveTeamContact } from './case-tools-team-operator.js'
import { RANGER_NOTE, TECHNICIAN_NOTE, HANDOVER_TAG, HANDOVER_TTL_MS, cleanNote, pendingOffer } from './relay.js'

const NO_SUCH = { error: 'No such record. Ask for the reference again.' }
const EMPTY_NOTE = { error: 'There is nothing to send: the note has no words.' }

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
      `Leave a short note for the animal health technician on ONE ${REPORT_ENTITY_LABEL} assigned to this team member, in their own words (what they saw, a worry, what they could not find out). It is written on the record, shown to the technician in the sign-off queue and the review, and is never sent to anyone as a message. Use it when they want the technician to know something that is not one of the report's facts. Only for a ${REPORT_ENTITY_LABEL} assigned to them. Say the note back and act only after they confirm the record. No phone numbers are kept in it.`,
      { type: 'object', properties: { case: str('Record reference or id'), text: str('The note, in the ranger\'s own words, translated to English if short and clear') }, required: ['case', 'text'] },
      async ({ case: ref, text }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        if (authorityOn(ctx, c) !== 'assigned') return NOT_ASSIGNED
        const refused = await writeGate(store(), ctx, c); if (refused) return refused
        const note = cleanNote(text)
        if (!note) return EMPTY_NOTE
        await writeNote(store(), c, ctx, { tag: RANGER_NOTE, label: 'RANGER NOTE', text: note })
        return { ok: true, recorded_on: await recordedOn(store(), c, ctx), noted_for_the_technician: true, sent_to_anyone: false }
      }),
    defTool('case_note_to_ranger', 'cases',
      `Leave a short note for the ranger who holds a ${REPORT_ENTITY_LABEL}, on the record, WITHOUT messaging them: nothing is sent, and it is not subject to the 24 hour window. The ranger sees it the next time they talk to the assistant (what is waiting for them) and it is on the console timeline. Use it for an answer or instruction for the ranger that need not be sent now; use case_ask_ranger to send a question to a ranger who filed a record. No phone numbers are kept in it.`,
      { type: 'object', properties: { case: str('Record reference or id'), text: str('The note for the ranger') }, required: ['case', 'text'] },
      async ({ case: ref, text }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        const authority = deskAuthorityOn(ctx, c)
        if (!authority) return NOT_ASSIGNED
        if (authority === 'assigned') { const refused = await writeGate(store(), ctx, c); if (refused) return refused }
        const note = cleanNote(text)
        if (!note) return EMPTY_NOTE
        await writeNote(store(), c, ctx, { tag: TECHNICIAN_NOTE, label: 'TECHNICIAN NOTE', text: note })
        return { ok: true, recorded_on: await recordedOn(store(), c, ctx), noted_for_the_ranger: true, sent_to_anyone: false, note: 'Nothing was sent: the ranger sees it the next time they talk to the assistant.' }
      }),
    defTool('case_offer_handover', 'cases',
      `Offer ONE ${REPORT_ENTITY_LABEL} assigned to this team member to another named ranger. Nothing moves yet: the other ranger is told at their next message to the assistant and must accept; the offer lapses after 48 hours, and nobody is messaged. Give the other ranger's name. Say the reference and the name back and act only after they confirm.`,
      { type: 'object', properties: { case: str('Record reference or id'), to: str('The other team member\'s name') }, required: ['case', 'to'] },
      async ({ case: ref, to }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        if (authorityOn(ctx, c) !== 'assigned') return NOT_ASSIGNED
        if (!isOpenCase(c)) return { error: 'That record is already finished, so there is nothing to hand over.' }
        const refused = await writeGate(store(), ctx, c); if (refused) return refused
        const target = await resolveTeamContact(store(), to); if (target.error) return target
        const them = target.contact
        if (them.id === ctx.contact.id) return { error: 'That is you: name a different team member.' }
        if (!atLeast(them.tier, TIER_FIELD_WORKER)) return { error: 'That person is not on the team.' }
        if (isOwnConversation(c, them)) return { error: 'That record is their own chat with the assistant, so it cannot be handed to them.' }
        const by = staffLabel(ctx.contact)
        await store().appendEvent(c.id, {
          kind: 'observation', actor: 'operator', text: `HANDOVER OFFERED by ${by} to ${staffLabel(them)}`,
          data: actorData(ctx, { handover_offer: true, from_key: assigneeKeyFor(ctx.contact), to_contact_id: them.id, to_name: staffLabel(them) }),
        })
        await store().updateCase(c.id, { tags: mergeTag(c.tags || '', HANDOVER_TAG) }, AGENT_USER)
        return { ok: true, recorded_on: await recordedOn(store(), c, ctx), offered_to: staffLabel(them), still_with_you_until_they_accept: true, lapses_in_hours: HANDOVER_TTL_MS / 3600e3, sent_to_anyone: false }
      }),
    defTool('case_handover_answer', 'cases',
      `Answer a hand-over another ranger offered to THIS team member (case_pending lists them): accept makes the ${REPORT_ENTITY_LABEL} theirs, decline leaves it with the ranger who offered it. Use only after they clearly say which.`,
      { type: 'object', properties: { case: str('Record reference or id'), accept: { type: 'boolean', description: 'true to accept, false to decline' } }, required: ['case', 'accept'] },
      async ({ case: ref, accept }, ctx) => {
        const c0 = await findCase(store(), ref)
        if (!c0) return NO_SUCH
        const me = ctx?.contact
        const key = assigneeKeyFor(me)
        if (!key) return { error: 'Could not tell who you are on this conversation, so nothing was changed.' }
        const result = await store()._withLock(`assign|${c0.id}`, async () => {
          const c = await store().getCase(c0.id)
          const offer = pendingOffer(await store().listEvents(c.id))
          if (!offer || offer.to_contact_id !== me.id) return { error: 'There is no hand-over offered to you on that record.' }
          const stale = offer.expired || String(c.assignee || '').trim() !== offer.from_key || !isOpenCase(c)
          if (stale) {
            await store().updateCase(c.id, { tags: dropTag(c.tags || '', HANDOVER_TAG) }, AGENT_USER)
            await store().appendEvent(c.id, { kind: 'observation', actor: 'system', text: `HANDOVER OFFER LAPSED (${offer.expired ? 'not answered in time' : 'the record has changed hands since'})`, data: { handover_answer_to: offer.id, accepted: false, lapsed: true }, touch: false })
            return { error: 'That offer has lapsed, so nothing was changed. Ask the ranger to offer it again if it is still wanted.' }
          }
          if (isOwnConversation(c, me)) return { error: 'That is this chat with the assistant, not a record to take on.' }
          const by = staffLabel(me)
          if (accept) {
            await store().updateCase(c.id, { assignee: key, tags: dropTag(c.tags || '', HANDOVER_TAG) }, AGENT_USER)
            await store().appendEvent(c.id, { kind: 'action', actor: 'operator', text: `HANDOVER from ${offer.by} accepted by ${by}`, data: actorData(ctx, { handover_answer_to: offer.id, accepted: true, assignee: key, assigned_contact_id: me.id, assigned_name: by, handover_from: offer.by }) })
            await clearFocusForCase(store(), c.id)
            return { ok: true, ref: c.ref, accepted: true, now_with_you: true }
          }
          await store().updateCase(c.id, { tags: dropTag(c.tags || '', HANDOVER_TAG) }, AGENT_USER)
          await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text: `HANDOVER from ${offer.by} declined by ${by}`, data: actorData(ctx, { handover_answer_to: offer.id, accepted: false }) })
          return { ok: true, ref: c.ref, accepted: false, still_with: offer.by }
        })
        return result
      }),
  ]
}
