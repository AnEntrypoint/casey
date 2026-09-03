# Herd Health WhatsApp roadmap -- STEP 1-4, post-kickoff

Source: the CiiT / Meat Naturally / UCT kickoff call (Lomkhosi, Sphelele,
Phumzile, Sibo, Skey, Alistair, James) plus the team's written follow-up
framing the case lifecycle as four steps. This file turns that into a
casey-grounded plan: what already exists (do not rebuild it), what is
net-new, and in what order. It does not replace AGENTS.md -- read that
first for the architecture this plan builds on.

## The four steps, mapped onto what casey already is

| Step | Meeting language | casey today |
|------|-------------------|-------------|
| 1 | farmer/worker reports to the bot | **Shipped.** `case_report` (`src/case-tools.js`), free-form fields, no deterministic extractor -- the LLM records what it hears. |
| 2 | technician retrieves/files updates | **Shipped.** `case_get`/`case_list`/`case_mine`/`case_today`/`case_update`/`case_transition`, gated to `field_worker` tier. |
| 3 | execution -- physical response, direct messaging, follow-up | **Weakest link, per the client's own framing.** casey has the *signals* (`attn.js`, `case-health.js`, `case-sweep.js`) but no *role* built to act on them and no *hourly, place-aware* view of them. This is the roadmap's main body. |
| 4 | consolidation / house-cleaning | **Partially shipped.** `never_closed` is already a tracked breach; a technician's own "what happened" note and an active cleanup nudge are not. |

Two things follow from this table. First, Phase 1 (intake fields) and Phase
3 (consolidation) are refinements of paths that already work end to end --
low risk, mechanical. Second, Phase 2 (the secretarial follow-up role) is
the only genuinely new subsystem this roadmap adds, and it is the one the
client called out as the highest-trust-impact piece (James: "whether people
are actually following up on these reports in a timely fashion" is what
determines long-term trust in the system, more than the bot itself).

Phasing below is dependency-ordered: Phase 1 before Phase 2 (the health
breaches Phase 2 surfaces read the report fields Phase 1 adds), Phase 2
before Phase 3 (the same dashboard-role plumbing Phase 2 builds is reused
by Phase 3's closure nudges).

---

## Phase 1 -- Intake question refinement (hardens STEP 1)

Phumzile's diagnostic question set, reconciled field-by-field against
`REPORT_KEYS` (`src/store/report-shape.js`) and `case_report`'s schema
(`src/case-tools.js`):

| Phumzile's question | Status |
|---|---|
| Which animal (species) | Already a field (`species`). |
| Age bracket (1-4mo / 5-8mo / 9mo-2yr) | **Net new.** |
| How many affected / herd size | `affected_count`/`dead_count` exist; total herd size does not. **Net new** (`herd_total`). |
| Main signs/symptoms | Already free text (`symptoms`) -- **Skey's ask for a free-text box instead of a checklist is already casey's design**, nothing to change here. Worth saying explicitly so no one "fixes" a non-problem. |
| When did signs start | Already a field (`onset`). |
| Vaccinated / treated / dewormed, + dosage if treated | **Net new** (`treatment_history`, free text -- covers Skey's dosage follow-up in the same field rather than a second one, since the model can record "yes, Terramycin, one dose" as naturally as "no"). |
| Eating/drinking/behaving normally | **Net new** (`condition_status`). |
| Other animals showing signs, or deaths nearby | **Net new** (`nearby_cases` -- distinct from `dead_count`, which is this herd only). |
| Environment/diet/rangeland change | **Net new** (`environment_change`). |

### Contract (what changes, not how)

- `src/store/report-shape.js`: `REPORT_KEYS` gains `age_bracket`,
  `herd_total`, `treatment_history`, `condition_status`, `nearby_cases`,
  `environment_change`. `REPORT_KEY_ORDER` gets the same six, placed near
  their related existing fields (`age_bracket` beside `species`;
  `herd_total` beside `affected_count`; `treatment_history` beside
  `onset`; the rest after `identifying_traits`) so the dashboard's
  fill-rate rendering reads in the order a technician would ask them.
- `src/case-tools.js` `case_report` tool schema: one `str(...)` property
  per new field, each following the file's existing discipline --
  *record what was said, never infer*. `treatment_history` and
  `nearby_cases` in particular need the same "leave it out if you do not
  know it yet; do not guess" language the existing fields already carry,
  not a new pattern.
- `src/case-health.js` `VISIT_CRITICAL`: decide per field whether it
  blocks a visit. Recommendation -- leave it as `['species', 'symptoms',
  'location', 'how_to_find', 'farmer_available', 'contact_fallback']`
  unchanged. None of the six new fields are things a technician cannot
  dispatch without; they sharpen the diagnosis, they do not gate the
  visit. Treating them as visit-critical would make `incomplete_critical`
  fire on cases that are actually dispatch-ready, which is a worse
  failure than a slightly thinner diagnosis.
- `src/packs/animal-health.js`: add the same six fields to
  `observationForms.sick_or_dead_animal.fields` (all `evidenceRequired:
  false`, matching the existing entries) so `provenance-wire.js` carries
  them into the ground-truth ledger the same way it already carries
  `species`/`symptoms`/etc. -- additive only, no engine change.
- `src/hooks/prompt.js`: no change needed. `caseSystemPrompt` already
  renders "report so far" from whatever keys are present in the report
  object; new keys show up automatically.

### Explicitly out of scope for Phase 1

- Any fixed checklist/menu for symptoms -- confirmed already free text,
  not touched.
- Animal identification (tags/IDs) -- Alistair's open question from the
  call. This deployment has no tagging infrastructure and `identifying_traits`
  (markings/breed, already a field) is the only identification signal
  available. Real ID (ear tags, a numbering scheme) is a farm-management
  decision outside casey's reach, not a schema gap -- flagged for the next
  meeting, not for this roadmap.

---

## Phase 2 -- The secretarial follow-up role + hourly dropped-balls view (builds STEP 3)

This is the roadmap's core deliverable. The client's own words: secretaries
who follow up with reporters over WhatsApp to close out incomplete data,
and who can see -- hourly -- which balls have been dropped and where.

### What already computes "dropped"

casey already has the exact classification the client is asking for; it
was built for operators, not (yet) for a dedicated follow-up role:

- `src/case-health.js` `classifyCaseHealth` is a pure `(case, now,
  thresholds) -> breaches[]` function covering exactly the failure modes
  STEP 3 cares about: `abandoned_intake` (on-site facts stalled and likely
  unrecoverable), `incomplete_critical` (active work, visit-critical facts
  still missing), `unanswered_handoff`/`_escalated` (a person was asked
  for and nobody replied), `stale`, `stuck`, `never_closed`.
- `src/attn.js` `rankAttention` turns those breaches into a worst-first
  list with a plain-language reason and a plain-language "what to do now"
  line (`caseHints`) -- this is already the exact shape a non-technical
  secretary needs, not an engineer's tag dump.
- `src/case-sweep.js` `sweepCases` runs this reconciliation on an interval
  today (via `casey.js`'s scheduler) and already has a distinct
  team-level signal, `detectCoverageGap` -- "the whole roster is idle
  while breaches pile up" -- which is conceptually adjacent to what the
  client is asking for but currently pages the *whole team*, not a named
  follow-up owner, and has no location grouping.

So Phase 2 is deliberately **not** a new detection engine. It is: a role
to act on what already exists, a place-aware view of it, and a decision
about push cadence.

### 2a. A `secretary` role

Today `operator_account.role` (`thatcher.config.yml`) is `[admin,
operator]` only; `contact.tier` (`reporter`/`field_worker`) is a
*different* axis entirely -- external contacts messaging in, not internal
staff. A secretary is internal staff, so this is a third `operator_account`
role, not a third `contact.tier` value.

- `thatcher.config.yml`: extend `operator_account.role` to `[admin,
  operator, secretary]`.
- Dashboard auth (`src/dashboard/auth.js`, `routes/accounts.js`):
  `secretary` logs in exactly like `operator` (same scrypt/session
  mechanism -- nothing new to build there). What differs is *what they can
  do*, enforced the same way `role: 'admin'` is already gated on
  admin-only routes today: a secretary reaches the follow-up queue
  (2b) and the reply-to-contact surface the dashboard already exposes for
  operators (`sendReply`, used today by `routes/cases.js`), but not the
  admin-only account-management routes.
- `src/workload.js`/`rosterFromAccounts` (`src/casey.js`) already build a
  generic `{id, name}` roster off the `operator_account` table with no
  role filter -- a `secretary` account shows up in workload/roster views
  for free, no code change needed there.

### 2b. The hourly, place-aware "dropped balls" view

New read endpoint (dashboard route, follows the existing pattern of
`routes/cases.js`'s inbox-style endpoints): call it `/api/secretary/queue`.
Built entirely from data that already exists:

- Base list: `rankAttention` over the open-case pool, same as the
  operator inbox uses today -- no new ranking logic.
- **Grouped by place**, which `rankAttention` does not do today: bucket
  the ranked items by `report.location` (using the existing
  `normalizeLocation` helper `src/location-normalize.js` already used by
  `case_list`'s location filter, so "eMalahleni," and "emalahleni" bucket
  together) so a secretary sees "N dropped in Bizana, M in Lusikisiki",
  answering the client's literal "where" -- not a new geocoding system, a
  grouping of a field that is already recorded.
- **Assignment-aware**: filter to `assignee = me` for a secretary working
  their own list, or show the unassigned pool for a team lead deciding
  allocation -- reusing the `assignee` column and `case_update` tool that
  already exist, not inventing a new ownership field. This is the direct
  answer to Sibo's "willing and able people... allocation" ask: allocation
  is a triage decision a lead makes by assigning, not a scheduling engine
  casey needs to build.
- Secretary replies through the **same** `sendReply` path an operator
  already uses (dashboard "reply" sends on the contact's real channel,
  WhatsApp included) -- this is the mechanism that satisfies "follow up
  over WhatsApp"; no second messaging integration is needed.

### 2c. Cadence: "hourly" is a product decision, not (necessarily) a new push system

Two readings of "see, on an hourly basis, which balls have been dropped",
with different build costs:

1. **Pull, hourly-or-anytime.** A secretary opens the queue whenever they
   check in (the client said hourly as a *staffing cadence*, not a
   technical requirement) and sees live, correct data -- because
   `rankAttention`/`classifyCaseHealth` are pure functions of the case
   table's current state, "hourly" is already satisfied the moment 2a/2b
   ship. Zero new infrastructure.
2. **Push, an actual hourly digest.** casey proactively sends a rollup
   (dashboard notification, or a WhatsApp message to a secretary/team-lead
   number) every hour: "7 open, 3 new drops since last hour, worst: CASE-1042
   in Bizana, abandoned 14h." This needs a new scheduled job alongside
   `case-sweep.js`'s existing interval sweep -- structurally straightforward
   (reuse `sweepCases`'s summary + `rankAttention`'s grouped output, batch
   into one message per interval instead of `notifyBreach`'s existing
   per-breach page) but it is new code, and it is the kind of "send a
   message on a schedule to a real phone number" feature that deserves an
   explicit yes from the client before it's built, not an assumption.

**Recommendation:** ship (1) first -- it is strictly the 2a/2b work above,
already covers the requirement literally, and is the lower-risk sequencing
in a system whose whole design philosophy is "no fallback text, no
fabricated status" (AGENTS.md). Bring (2) back to the client as an
explicit option once (1) is in a secretary's hands and the team has a real
sense of whether people check the dashboard on their own or need the push.

---

## Phase 3 -- Consolidation / house-cleaning (finishes STEP 4)

James's framing: a technician reports on work post-completion, and the
system "houses-clean where information has never got entered on a very old
case." Both halves map onto existing casey machinery plus one net-new
field.

### 3a. Technician post-completion note

`case_transition` (`src/case-tools.js`) already carries a `reason` string
recorded on the timeline for every transition, including the move to
`resolved`. What's missing is making the resolved-with-no-outcome case
visible rather than silently allowed. Recommendation: no new required
field (a hard requirement would fight casey's "no deterministic capture
floor" principle -- AGENTS.md is explicit that a fact the model fails to
record has no deterministic net, by design) -- instead:

- Prompt guidance in `caseSystemPrompt` (`src/hooks/prompt.js`): when the
  agent is about to call `case_transition` to `resolved`, it should ask
  what happened / what was given, the same way the existing "last-chance
  push" fires on a farewell cue -- record it as `outcome_notes` via the
  existing `notes` report field (no new REPORT_KEYS entry needed; `notes`
  already exists for exactly this kind of catch-all).
- The `case_health` breach that already exists for "resolved but nothing
  happened after" is `never_closed` (`resolved`, idle >= 7 days by
  default) -- this already fires today. What's missing is it reaching a
  human who can act: route it into the Phase 2 secretary queue (2b) the
  same as any other breach, since "please close this out" is exactly a
  follow-up task, not a new breach type.

### 3b. Automatic house-cleaning / stale-report visibility

- `never_closed` and `abandoned_intake` are already the two breach types
  that answer "where has information never gotten entered on an old
  case" -- no new detector needed.
- Auto-*closing* a case (rather than flagging it) is a bigger decision:
  it would be the first place casey silently changes case state with no
  human action, which cuts against the existing "no silent state changes"
  discipline everywhere else in this codebase. Recommendation: do **not**
  auto-close. Instead extend `src/report.js`/`report-analytics.js`
  (already the source of casey's periodic management reports) with a
  closure-completeness metric -- % of resolved cases actually closed
  within N days -- which is exactly the "how do we know follow-through is
  happening" signal Sibo and James asked about, aggregate-only (matching
  every other management report in this codebase), no new PII surface.
- If a deployment genuinely wants auto-close after a long grace period,
  that is an operator-tunable threshold addition (`thresholds.js` already
  has the merge/clamp pattern for exactly this kind of value) -- worth
  raising as an explicit option at a later review once real usage data
  exists, not decided speculatively now.

---

## Sequencing summary

1. **Phase 1** (intake fields) -- mechanical, no architectural risk, unlocks
   sharper breach classification for Phase 2.
2. **Phase 2** (secretary role + hourly queue, pull-first) -- the
   highest-value, only-genuinely-new piece; ships the client's literal
   ask using signals that already exist.
3. **Phase 3** (consolidation) -- smallest surface area, mostly wiring
   an existing breach type (`never_closed`) into the queue Phase 2 built,
   plus one new management-report metric.
4. **Decide, don't build yet:** Phase 2's proactive hourly WhatsApp push
   (2c option 2) -- revisit once Phase 2's pull-based queue has real usage
   data.

## Open questions for the next meeting (not this roadmap's job to resolve)

- **Animal identification.** No tagging system exists in this deployment;
  `identifying_traits` free text is the only signal today. Alistair's
  question from the call, explicitly deferred there too.
- **Sibo's AHT Field Tracker PWA.** A parallel system already logging AHT
  daily field activity. Once Sibo demos it (as agreed on the call), decide
  whether casey exposes a read-only case feed for it to consume, or
  whether the two stay separate and a technician uses both. Do not build
  an integration surface speculatively before that demo.
- **AHT dashboard tooling choice.** The call floated Power BI/Excel/Google
  Drive alongside casey's own dashboard. This roadmap assumes AHTs and
  secretaries use casey's existing dashboard (Phase 2 builds directly on
  it) since building a second reporting surface duplicates work for no
  clear benefit -- but this is the client's call, not an engineering one,
  and should be confirmed explicitly rather than assumed permanently.
- **Pilot feedback loop.** The 50-farmer pilot with feedback forms (led by
  Sphelele) is outside casey's engineering scope, but casey could
  optionally support it with a lightweight end-of-conversation "was this
  helpful" signal if the pilot team wants one -- flagged as a nice-to-have,
  not committed here.
