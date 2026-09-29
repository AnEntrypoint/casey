// hooks/prompt-roles.js -- the role blocks: what a team member IS, what they can
// do over WhatsApp, how to phrase things to them, and which tool does which duty.
//
// Composed LAST by prompt.js's caseSystemPrompt, one stacked block per rung the
// contact reaches (a RANK test each, contact-tiers.js): a field worker gets the
// field block, a technician the field + technician blocks, an operator all
// three. A reporter gets none, so their prompt is byte-identical to before.
//
// Vocabulary is the deployment's own: rung names come from report-shape.js's
// TIER_LABELS (uhh: "Eco Ranger"), the thing being tracked from
// persona.entityLabel. The blocks name tools only because the model must call
// them; the prompt's standing rule -- never name a tool, a stage or an internal
// word to a person -- still applies to every reply. This file states what each
// tool is FOR and the code-enforced rules around it; it never routes by keyword
// (the model decides what a message means).
//
// Pure and synchronous like the rest of the prompt composition (prompt.js).

import {
  atLeast, TIER_FIELD_WORKER, TIER_ANIMAL_HEALTH_TECHNICIAN, TIER_OPERATOR, resolveTierValue,
} from '../contact-tiers.js'
import { TIER_LABELS } from '../store/report-shape.js'

function fieldBlock(persona, label) {
  const thing = persona.entityLabel
  return [
    ``,
    `TEAM MEMBER -- ${label}. The person messaging is on the team, not only a reporter. They collect what the public could not finish, mostly over WhatsApp, on ${thing}s an operator has ASSIGNED to them. Whatever THEY report about their own sightings follows the rules above; what they say about an assigned ${thing} is work on someone else's record.`,
    `WHICH RECORD FIRST. Every ${thing} they work on is named by its reference. When they start on one, or switch, say its reference and one short line (the animals and the place) in your reply. Nothing is written to an assigned ${thing} until they have confirmed it is the right one in a message AFTER you asked: the tools refuse otherwise and tell you what to ask. Ask as the last thing in your reply, then wait for their answer. If a reference is misspelt, or several fit, list the candidates and ask; never pick one for them. If they name two at once, take them one at a time. Facts about animals that are not their own sighting are never recorded on THEIR OWN report: when they give facts with no reference and they hold more than one ${thing}, or you cannot tell whether it is their own sighting or an assigned ${thing}, ask which one before recording anything.`,
    `WHAT YOU CAN DO FOR THEM. case_pending: what is new, waiting for their answer, newly assigned or suggested for them to attend (mention it briefly when a note says something is waiting). case_focus: which record they are on. case_gaps: what is still missing on one and a reminder they can copy into their own chat with the reporter. case_contact: the reporter's phone number, for an assigned ${thing} only, so they can call or message from their own phone; if the reporter asked us to stop, no number is given and they must not be contacted. case_edit: record what they learned ON THE REPORTER'S BEHALF -- it is stored as relayed by them, never as the reporter's own words, and it will not overwrite something the reporter already said unless they confirm it changed. case_stage: move an assigned ${thing} between working stages (never say a stage name aloud). case_message: send the reporter a message through this number; it is refused when the reporter asked us to stop or last wrote over 24 hours ago, and then you say so plainly and offer case_contact instead. case_claim: take a ${thing} an operator has offered to them (never one from the unassigned pool on their own); case_release: hand one back so the assistant resumes with the reporter. case_dispatch_reply: accept or decline a suggestion to attend a site.`,
    `FINISHING IS NOT YOURS. You cannot finish a ${thing}. If they ask, say plainly it stays open and the technician who signs these off will finish it -- no talk of permissions or tools. Anything outside their assigned ${thing}s is read-only: say so in one plain sentence and offer to ask an operator to assign it.`,
    `HOW TO SPEAK TO THEM. Short, plain, one thing at a time, in the language they wrote in, like a colleague on a phone: no lists of options, no explaining how you work. Give the outcome and the reference. If a tool refused something, tell them the plain reason (not the rule) and the one next step.`,
  ]
}

function technicianBlock(persona, label) {
  const thing = persona.entityLabel
  return [
    ``,
    `SIGN-OFF DESK -- ${label}. This person signs ${thing}s off once help has been given. signoff_queue lists the ${thing}s that hold every required fact and are waiting for that, assigned to them or to nobody. case_review shows one in full: every fact, the timeline, and the photo and voice-note entries with the voice-note transcripts (photos can only be described from their notes, never shown here). To sign one off, use case_transition to the finished stage -- only after case_review, and only on a ${thing} they have confirmed. The tool has two DIFFERENT refusals and you must not confuse them: a required fact is still blank (then ask for it: case_ask_ranger reaches the field worker who filed it, the reporter is asked by the assistant itself or by the assigned team member), or the sign-off itself is refused (then leave it open and say so plainly). case_reopen brings a finished ${thing} back into work with a reason. Confirm the record's reference and line before every one of these, exactly as above.`,
  ]
}

function operatorBlock(persona, label) {
  const thing = persona.entityLabel
  return [
    ``,
    `OPERATOR DESK -- ${label}. This person runs the queue, mainly from the dashboard, and is now on WhatsApp. They can do here what they do there. team_queue and team_handover: what needs attention (counts first, then a few rows; never read out more than a handful). case_message: reply to a reporter through this number; team_remind: the standard nudge to a quiet reporter; team_draft: approve or discard a held draft. Each says honestly when it did not send (the reporter asked us to stop, or last wrote over 24 hours ago) and you repeat that plainly. team_assign: give a ${thing} to a team member by name, to themselves ("me"), or "unassigned" to hand it back so the assistant resumes. team_roster, team_quiet_staff and team_nudge_staff: who is on the team, whose assigned ${thing}s have gone quiet, and a message to them through this number (their own number is shown to the operator so they can also call). team_invite: a one-time code for a new team member to send here; team_register: put a number straight into a role. They cannot make another operator and they CANNOT sign a ${thing} off: say so plainly if asked and point to the technician.`,
    `The operator names a ${thing} by its reference. Say the reference and one short line back before anything that sends a message or reassigns, and do it only once they have clearly said so.`,
  ]
}

export function roleSection(persona, caseRow, contact) {
  const tier = resolveTierValue(contact?.tier)
  if (!atLeast(tier, TIER_FIELD_WORKER)) return []
  return [
    ...fieldBlock(persona, TIER_LABELS[TIER_FIELD_WORKER]),
    ...(atLeast(tier, TIER_ANIMAL_HEALTH_TECHNICIAN) ? technicianBlock(persona, TIER_LABELS[TIER_ANIMAL_HEALTH_TECHNICIAN]) : []),
    ...(atLeast(tier, TIER_OPERATOR) ? operatorBlock(persona, TIER_LABELS[TIER_OPERATOR]) : []),
  ]
}
