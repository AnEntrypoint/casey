// contact-tiers.js  --  the contact access-tier LADDER: the one authority for
// what a stored `contact.tier` value means, which rung outranks which, and what
// each rung is called in front of a person.
//
// Three rungs, lowest to highest, and the ORDER is the whole point: every tier
// question in casey is "does this contact reach at least rung N", never "is this
// contact exactly rung N". Twenty separate `=== 'field_worker'` string
// comparisons across eighteen files each answered the second question, which is
// why adding a rung ABOVE field_worker silently demoted the new top rung to
// casual-reporter behaviour at every one of them: the highest-privilege contact
// in the system failed an equality test written when field_worker was the
// ceiling. Ask the rank, not the string.
//
// WHAT EACH RUNG IS FOR:
//
// - `reporter` -- the default, and the far more common tier. Anyone messaging
//   in. Report-only: they can file and amend their own report and use the two
//   irreversible service controls, and nothing else (case-tools-gates.js's
//   REPORT_ONLY_TOOLS).
// - `field_worker` -- an operator-trusted reporter. Everything a reporter has,
//   plus agentic case-query access (their own open records, "near me", "today")
//   and casual location check-ins so they appear on the operator map for
//   dispatch.
// - `animal_health_technician` -- everything a field_worker has, plus the
//   EXCLUSIVE authority to move a record to a done stage. See canSignOff below
//   for why that one capability is an equality test rather than a rank test.
//
// WHY ONE RUNG CARRIES A DOMAIN NAME. casey's tier mechanism is otherwise
// domain-independent, and AGENTS.md's Configuration architecture is explicit
// that domain vocabulary belongs in config rather than in this source tree.
// `animal_health_technician` is the stated exception: the deploying team's own
// word for the person who signs a record off, adopted as the enum value because
// there is no shorter established internal term for that authority the way
// `field_worker` already serves as the internal name for the rung a deployment
// may call an Eco Ranger. The LABEL is config-overridable per deployment (see
// DEFAULT_TIER_LABELS and report-shape.js's TIER_LABELS); the enum value is not.
//
// Nothing here reads config, does I/O, or touches a clock -- it is pure, so
// every caller (agent tool gate, dashboard route, store write guard, prompt
// composer, attention scorer, SPA-facing projection) can share one answer.

export const TIER_REPORTER = 'reporter'
export const TIER_FIELD_WORKER = 'field_worker'
export const TIER_ANIMAL_HEALTH_TECHNICIAN = 'animal_health_technician'

// Lowest to highest. This array IS the ladder: index is rank, and it is the
// order every enum declaration (thatcher.config.yml's contact.tier and
// case.reporter_tier) and every UI ladder step follows.
export const TIER_ORDER = [TIER_REPORTER, TIER_FIELD_WORKER, TIER_ANIMAL_HEALTH_TECHNICIAN]

const RANK = new Map(TIER_ORDER.map((tier, i) => [tier, i]))

// FAIL CLOSED, in one place, for every caller.
//
// A missing tier, an empty string, a tier from before the column existed, a
// typo an operator hand-edited into the database, a value from a NEWER casey
// this deployment has not upgraded to yet -- all of them resolve to the
// LOWEST-privilege rung. Never to the highest, and never to "whatever was
// asked for". This is the same discipline the individual comparisons already
// held; centralising it means a future rung cannot be added with one call site
// accidentally defaulting the other way.
export function resolveTierValue(value) {
  return RANK.has(value) ? value : TIER_REPORTER
}

// The tier of a contact ROW (thatcher's `contact`), which is where the value
// actually lives. Tolerant of a null/absent contact for the same fail-closed
// reason: a turn that could not load a contact is not a turn that may sign off.
export function resolveContactTier(contact) {
  return resolveTierValue(contact?.tier)
}

export function tierRank(value) {
  return RANK.get(resolveTierValue(value))
}

// "Does `value` reach at least rung `min`". The one comparison every access
// question in casey should be written as.
export function atLeast(value, min) {
  return tierRank(value) >= tierRank(min)
}

// Elevated, agentic case access: the query/mutation tools, location check-ins,
// the operator map, the elevated prompt branches. A RANK test, because every
// rung above field_worker is also a field worker -- an animal health technician
// reading their own open records is the same act with more authority behind it.
export function canQueryCases(value) {
  return atLeast(value, TIER_FIELD_WORKER)
}

// Sign-off authority: may move a record to a done stage.
//
// An EQUALITY test, deliberately, where every other capability here is a rank
// test. Sign-off is not "enough privilege to do the thing" -- it is a named
// clinical responsibility held by exactly one role, and the deploying team's own
// words for it were "non-negotiable, only they do that". Written as
// `atLeast(value, TIER_ANIMAL_HEALTH_TECHNICIAN)` it would read identically
// today and would silently hand sign-off to any rung added above AHT later,
// which is the one outcome this function exists to prevent. If a deployment ever
// genuinely needs a second signing role, it names it here, on purpose.
export function canSignOff(value) {
  return resolveTierValue(value) === TIER_ANIMAL_HEALTH_TECHNICIAN
}

// casey's OWN labels -- generic, domain-neutral, and the fallback when a
// deployment declares none. A deployment renames a rung for its own people
// through `report-fields.yml`'s `dashboard_ui.tier_labels` (uhh calls
// field_worker an "Eco Ranger"); see report-shape.js's TIER_LABELS. The stored
// enum value never changes with the label, which is the entire reason a rename
// is a label and not a migration: two live enum columns
// (`contact.tier`, `case.reporter_tier`) already hold these strings in every
// deployed database, and `case.reporter_tier` rows are historical snapshots that
// must keep meaning what they meant when they were written.
export const DEFAULT_TIER_LABELS = {
  [TIER_REPORTER]: 'Reporter',
  [TIER_FIELD_WORKER]: 'Field worker',
  [TIER_ANIMAL_HEALTH_TECHNICIAN]: 'Animal health technician',
}

// The label for one rung under an optional deployment override map. Unknown
// rungs resolve through resolveTierValue first, so a corrupt stored value is
// labelled as the reporter it is treated as, never rendered raw to an operator.
export function tierLabel(value, labels = null) {
  const tier = resolveTierValue(value)
  const declared = labels && typeof labels[tier] === 'string' ? labels[tier].trim() : ''
  return declared || DEFAULT_TIER_LABELS[tier]
}
