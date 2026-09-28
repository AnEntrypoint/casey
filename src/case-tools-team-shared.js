// case-tools-team-shared.js  --  the vocabulary the team tools (case-tools-team-*.js)
// are written in: how a tool finds a case, decides whether THIS team member may
// act on it, and projects a row without a phone number.
//
// AUTHORITY, in one place. Two grants, both derived from the acting contact and
// nothing the model supplies:
//   - 'operator'  a contact at the operator rung: any case (isOperator, a RANK
//                 test -- team management, not a named clinical duty);
//   - 'assigned'  a contact at least field_worker on a case whose assignee is
//                 exactly their contact key (case-assignment.js isAssignedTo).
// Anything else is null, and a tool answers with NOT_ASSIGNED: a plain sentence,
// no mention of tiers, tools or permissions (the same reasoning as gateByTier's
// unavailable note -- a model that sees permission language parrots it).
//
// Sign-off is NOT here. Moving a record to a done stage stays case_transition's
// canSignOff equality, and every tool in this family refuses a done stage.

import { AGENT_USER, UNCLAIMED_ASSIGNEE } from './case-store.js'
import { isOperator, canQueryCases, atLeast, TIER_ANIMAL_HEALTH_TECHNICIAN } from './contact-tiers.js'
import { isAssignedTo, isOwnConversation, publicAssignee } from './case-assignment.js'
import { enquiryRow } from './case-tools-shared.js'
import { staffLabel } from './hooks/staff-outbound.js'
import { MANDATORY_MINIMUM_BLOCKED_STATUSES } from './store/report-shape.js'

export const NOT_ASSIGNED = {
  error: 'This one is not assigned to you, so you can look at it but not change it or message the person who reported it. Say that plainly, and offer to ask an operator to assign it to you.',
}

// Every stage that means "finished". The store's own workflow names resolved and
// closed; a deployment's mandatory-minimum list can only add to that set.
export function doneStages() {
  return [...new Set(['resolved', 'closed', ...MANDATORY_MINIMUM_BLOCKED_STATUSES])]
}

export async function findCase(store, idOrRef) {
  const key = String(idOrRef || '').trim()
  if (!key) return null
  let c = null
  try { c = await store.getCase(key) } catch { c = null }
  if (!c) { try { c = await store.getCaseByRef(key) } catch { c = null } }
  // The settings/erasure/invite singletons live as channel 'system' cases; they
  // are not reports and no team tool may read or edit one.
  return c && c.channel !== 'system' ? c : null
}

export function authorityOn(ctx, caseRow) {
  if (isOperator(ctx?.tier)) return 'operator'
  if (canQueryCases(ctx?.tier) && isAssignedTo(caseRow, ctx?.contact) && !isOwnConversation(caseRow, ctx?.contact)) return 'assigned'
  return null
}

// The technician's wider reach: the sign-off desk sees records assigned to them AND
// the unassigned ones (the signoff_queue set). Same grant names as authorityOn.
export function deskAuthorityOn(ctx, caseRow) {
  const direct = authorityOn(ctx, caseRow)
  if (direct) return direct
  const a = String(caseRow?.assignee || '').trim()
  if (atLeast(ctx?.tier, TIER_ANIMAL_HEALTH_TECHNICIAN) && (!a || a === UNCLAIMED_ASSIGNEE)) return 'assigned'
  return null
}

// The user object handed to the store for a write, per grant. An operator's
// stage change and edits carry the operator role (parity with the dashboard,
// including the proactive contact note on a stage change); an assignee's carry
// the agent role so no notifier fires on their behalf -- they message the
// reporter explicitly with case_message when they mean to.
export function storeUser(ctx, authority) {
  return authority === 'operator' ? { id: staffLabel(ctx?.contact), role: 'operator' } : AGENT_USER
}

// Fields every team-authored event carries, so the timeline says WHO acted and
// in what capacity without ever holding a phone number.
export function actorData(ctx, extra = {}) {
  return { by: staffLabel(ctx?.contact), by_tier: ctx?.tier || '', staff_contact_id: ctx?.contact?.id || '', ...extra }
}

// A case row for the model: the PII-free enquiry projection, with the assignee
// rendered relative to the asker ('you' / 'a team member' / a dashboard name).
export function teamRow(c, ctx, extra = {}) {
  const row = enquiryRow(c)
  row.assignee = publicAssignee(c.assignee, ctx?.contact) || null
  return { ...row, ...extra }
}

// Media notes carry the saved file's server path; the path is internal and the
// note's own words (and the transcript) are what a reviewer needs.
export const stripSavedPaths = (text) => String(text || '').replace(/\s*\(saved: [^)]*\)/g, '')

// Text a team member relays for the record is shown back to other people (timeline,
// dashboard, prompts). Invisible and direction-changing characters have no place in
// it: they let "sheep" read as something else on screen, hide a difference from the
// held-value comparison, or break a line. Removed rather than refused; newline and
// tab stay.
export const cleanRelayed = (v) => typeof v === 'string'
  ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
  : v
