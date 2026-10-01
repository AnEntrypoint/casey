

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
