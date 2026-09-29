// case-tools-team.js  --  the team tools: what each ROLE can do over WhatsApp
// beyond reporting. Composed by case-tools.js, APPENDED after the eighteen
// original tools so their pinned order (prompt-visible text) never moves.
//
// The role ladder and the tool each rung gets (minimum rung declared in
// case-tools-gates.js TOOL_MIN_TIER, enforced at call time AND hidden from the
// schema of every lower tier by hooks/turn-attempts.js):
//
//   field_worker (Eco Ranger)  case-tools-team-field.js
//     case_pending case_claim case_release case_dispatch_reply case_focus
//     case_gaps case_contact case_edit case_stage case_message
//   animal_health_technician   case-tools-team-review.js
//     signoff_queue case_review case_reopen case_ask_ranger
//     (sign-off itself remains case_transition, canSignOff equality)
//   operator                   case-tools-team-operator.js
//     team_queue team_handover team_assign team_draft team_remind team_invite
//     team_register team_roster team_quiet_staff team_nudge_staff
//   area / hand-over / day model   case-tools-team-desk.js
//     case_handoff_to_technician case_my_day (field_worker), team_ranger_day
//     team_relocate_case (operator)
//
// Order within this list is pinned like the rest: append, never reorder.

import { buildTeamFieldTools } from './case-tools-team-field.js'
import { buildTeamReviewTools } from './case-tools-team-review.js'
import { buildTeamOperatorTools } from './case-tools-team-operator.js'
import { buildTeamDeskTools } from './case-tools-team-desk.js'

export function buildTeamTools(store, enums) {
  return [
    ...buildTeamFieldTools(store, enums),
    ...buildTeamReviewTools(store),
    ...buildTeamOperatorTools(store),
    ...buildTeamDeskTools(store),
  ]
}
