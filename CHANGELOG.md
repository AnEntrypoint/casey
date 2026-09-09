# Changelog

## Unreleased

This file recorded nothing for the 88 commits between the repo's squashed
`Initial commit` and 2026-09-08; `git log --oneline -- CHANGELOG.md` returns
only that one commit. The block below is reconstructed from `git log` and
from the live code, and covers what actually landed in that span. The
sections beneath it are the pre-squash history and are left as written --
several describe modules (`src/extract.js`, `src/gazetteer.js`, `test.js`,
`CASEY_OPERATORS`) that no longer exist, which is what a historical entry is
supposed to look like once the code moves on.

### Fixed
- **`--help` no longer runs the command.** The help text advertised
  `--help`/`-h` on any command, but only `up` and `dashboard` checked the flag;
  everything else dispatched normally, so `casey sweep --help` ran the sweep and
  `casey transition <ref> <stage> --help` moved the case. `bin/casey-cli.mjs`
  now answers out of a `USAGE` table in `bin/casey-cli-ui.js` before the handler
  runs, one block per dispatchable command.
- **`casey report --days N` is applied.** It was parsed, printed in the header
  and emitted in the JSON while every builder received the unfiltered case list,
  so `--days 1` and `--days 3650` produced byte-identical bodies. It now
  restricts the population to cases opened inside the window.
- **`casey cases --channel` reads the store's real channels.** The allowed set
  was the literal `['discord','whatsapp']`, so `--channel web` was refused as
  invalid on a deployment whose public form had opened eleven web cases. The
  flag is also now in the help text, as is `--json` on `health`/`sweep` and
  `--port` on `doctor`.
- **`casey erase-contact` can be driven from what casey prints.** It accepted
  only the internal contact id, which no casey command puts on screen, and
  failed with `eraseContact: no such contact <x>` -- an internal function name.
  It now resolves a contact id, the channel identifier shown on a case, or any
  of that contact's case refs, and reports scrubbed cases by ref rather than by
  internal id. Being irreversible, it now requires `--yes`.
- **`casey operators --role secretary` is honoured.** The CLI collapsed every
  role that was not `admin` to `operator` and then reported success, while
  `dashboard/auth.js` has always accepted `secretary`. An unknown role is now
  refused instead of silently changed.
- **`casey up` refuses a WhatsApp channel with no `WHATSAPP_VERIFY_TOKEN`.**
  The `--no-supervise` path warned that verification would "use freddie's
  default token" -- there is no such fallback -- and then died inside the Cordis
  mount with an eleven-frame stack trace. It now refuses in one sentence, the
  same shape the supervised path already used.
- **Diagnostics go to stderr.** Every refusal, usage line and not-found message
  was written to stdout, so `casey attention --json | jq` could receive prose
  and an unknown command printed the entire help screen as data. An unknown
  command now names the typo instead of dumping help.
- **Smaller CLI truths.** `casey transition` to the stage a case is already in
  reports "nothing changed" instead of writing a `triaging -> triaging` event;
  its default recorded reason no longer stamps every legal move as an
  "override"; `casey health` prints a plain sentence beside each guardrail tag;
  `casey operators list` renders `last_login_at` in SAST like every other date
  the CLI prints; `casey cases` states the total when its 50-row page truncates;
  a flag given with no value says so instead of reporting `invalid status: true`.
- **`casey init`'s template stopped contradicting the rest of the repo.** It
  claimed "there is no separate webhook PORT: the webhook shares the dashboard
  port", which `freddie-bundle/cordis.patch.yml`, this README and `AGENTS.md`
  all contradict (`CASEY_WEBHOOK_PORT`, default 4001, deliberately clear of the
  dashboard's 4000). It also omitted `CASEY_SESSION_SECRET`, which the docs said
  it wrote, and `ACPTOAPI_CHAIN_LINK_TIMEOUT_MS`, which `doctor` checks for.
- **`casey doctor` says which `.env` it looked for.** It checked casey's own
  package root and reported ".env missing" on a deployer package (uhh, serpent)
  that loads its own `.env` before importing casey at all, then recommended a
  `casey init` that would scaffold a second one in the wrong directory.

### Changed
- **freddie is now the agent, not a library casey calls.** Upstream freddie's
  `main` was rewritten from a flat harness+Gateway package into a Cordis
  plugin tree with no messaging-bot primitives left. casey's own transport,
  `case_*` tools, LLM adapter and per-agent tool allowlist now mount into
  freddie's real `boot()` as Cordis plugins under `freddie-bundle/`, and
  `src/agent/run-turn.js` drives a real freddie `Agent`. casey owns the
  WhatsApp/Discord adapters (`src/adapters/`) that freddie used to provide.
- **The domain is config, not code.** `CASEY_CONFIG_DIR` +
  `src/config-loader.js` + `src/store/report-shape.js` replace the
  hardcoded animal-health vocabulary; this repo ships a generic IT-helpdesk
  demo under `config/default/`, and the animal-health deployment moved to
  the separate `AnEntrypoint/uhh` config package. `CASEY_EXTRA_PLUGINS_DIR`
  and `CASEY_EXTRA_DASHBOARD_ROUTES` let a deployer add tools and dashboard
  routes without casey knowing the domain.
- **Composed dependencies resolve locally.** `thatcher`, `acptoapi` and
  `anentrypoint-design` moved from `github:AnEntrypoint/<repo>#main` specs to
  `file:deps/<name>` against their submodule checkouts, because npm's git-dep
  preparation stalled a fresh clone's install. `freddie` left `package.json`
  entirely: it is a `pnpm` workspace linked in by
  `scripts/install-freddie-deps.mjs` + `scripts/link-deps.mjs`.
- **The map is the dashboard's home view**, not a panel behind the nav: a
  full-bleed map pane plus one rail carrying the worst-first queue or the
  open case, with the urgency ladder and filter predicate defined once in
  `dashboard/public/src/map-model.js` and read by both halves. Brand theming,
  role-scoped nav with a secretary landing view, an in-app Dialog replacing
  native `alert`/`confirm`/`prompt`, and text-response compression (2.50 MB
  -> 0.89 MB on the map landing) landed alongside it.

### Added
- Per-operator dashboard login (`src/dashboard/auth.js`): scrypt-hashed
  passwords, stateless HMAC-signed session cookies, an `operator_account`
  table, a bootstrap admin created on first boot with a forced password
  change, and the `casey operators` CLI as the break-glass path. This
  replaces the shared dashboard token entirely -- no route accepts a bearer
  token or `?token=` any more.
- Supply-chain scanning: `scripts/scan-deps.mjs` (`npm run scan-deps`), wired
  into `casey doctor` and into `scripts/postinstall.mjs`, where its exit code
  now reaches npm so a real hit fails the install. `npm run check-submodules`
  reports each `deps/*` checkout's branch/dirty/ahead-behind state.
- `npm run gui-check` (`scripts/gui-check.mjs`): drives the real dashboard in
  headless Chromium over CDP and asserts the map-first layout, the mobile icon
  grid, accessible names and WCAG AA contrast. Deliberately not part of
  `npm run lint`, which stays dependency-free; skips with exit 0 when no
  chromium binary exists.
- `lint.mjs` gained structural grep gates beyond syntax/config/ascii:
  pure-agent, no-stub-mock, pii-safety (a dataflow check that a store row
  never reaches `res.json()` without a projection) and trust-boundary
  (`src/packs/*` may not import `src/core/`).
- A `secretary` operator role plus `/api/secretary/queue`, the follow-up
  queue that surfaces dropped cases for a non-operator follow-up owner.

### Fixed
- The ported turn-runner never reached the model: `hooks/handler.js` resolved
  its adapter through `this?.platforms?.get?.(platform)`, a shape the old
  freddie Gateway had and `casey.js` does not, so the optional chain
  short-circuited and `adapter` was `undefined` on every turn. Both delivery
  flags were also initialised `true` above the `if (adapter?.send)` guard that
  earns them, which is what kept it silent.
- Deleting an operator revoked nothing. thatcher deletes are soft, and the
  session middleware resolved through `t.get` (which returns deleted rows)
  while `listAccounts` used `t.list` (which does not), so a removed
  operator's cookie kept working. Closed by a `status='deleted'` check in the
  middleware and a `session_epoch` bump in `deleteAccount`.
- `casey doctor` reported the wrong database file (`data/app.db`); busybase
  hardcodes `db.sqlite` regardless of thatcher's `databasePath` option.
- js-yaml v5 dropped YAML 1.1 merge-key resolution, so `<<: *system_fields`
  silently vanished from every entity in `thatcher.config.yml` until every
  config load opted back into `YAML11_SCHEMA`.
- A guessed coordinate now looks guessed: both map overlays carry
  `location_source` on the gps/estimated/confirmed ladder and render an
  unconfirmed estimate differently, and an auto-generated photo description
  or voice-note transcript names the AI helper as its author.
- `learnOperatorActivity` concatenated instead of adding, because busybase
  binds numeric columns as TEXT -- nine operator actions stored a
  `case_count` of `"111111111"`, which the map's coverage tooltip rendered
  verbatim.

### Removed
- The provenance subsystem's unreferenced tiers, in two audits: `src/engine/`
  entirely, plus `aggregate.js`, `interpretation.js`, `event-log.js`,
  `escrow-export.js`, `quality-flags.js`, `reputation.js`, `subject.js` and
  `pack-loader.js` under `src/core/`, and `packs/water-point.js`. The live
  modules are `provenance.js`, `observation.js`, `raw-log.js`,
  `write-path.js` and `pack-schema.js`, reached only via
  `src/provenance-wire.js`.
- `src/provider-health.js`, whose only would-be consumer had already been
  rewired away from it.

### Changed
- Untracked `.gm/browser-chrome-profile-default/` (Chrome's own runtime
  automation profile, never source) and restored eight tracked files that
  had been accidentally deleted from disk with no commit: five
  `.claude/workflows/*.js` quality-maximiser scripts, `.wfgy/lessons.md`, and
  `hooks/post-checkout`/`hooks/post-merge`.
- README.md brought back in sync with AGENTS.md's documented current
  architecture (reporter/field_worker tiers, map view, dstate, provenance
  subsystem, thatcher/anentrypoint-design as pure npm-`latest` deps) -- it had
  drifted to describe a stale `CASEY_OPERATORS`-roster/local-thatcher-shim
  shape that no longer matches the codebase.
- `/api/map/workers` now calls the shared `classifyWorkerCheckins` (previously
  exported from `case-health.js` but never called anywhere) instead of
  reimplementing the same overdue-checkin logic inline, removing a duplication-
  drift risk between the two.
- Removed `thresholds.js`'s `resolveScalarForType` -- exported but never
  called anywhere (`case-health.js`'s own per-case_type override lookup is a
  deliberately separate inline copy, to avoid a circular import back into
  thresholds.js, per its own comment).
- Stale comments referencing the retired `CASEY_OPERATORS` env var / the
  retired `X-Casey-Operator` header (`case-store.js`, `thatcher.config.yml`)
  updated to describe the current `operator_account`/session-auth shape.

### Fixed
- `case-sweep.js` `tsMs` was missing the digit-string clause its siblings
  (`attn.js`, `case-health.js`) carry, so an operator reply whose `created_at`
  is a numeric string (busybase binds timestamps as text) hit `Date.parse`=NaN
  and was dropped from the coverage window -- `detectCoverageGap` then paged the
  team with a false TEAM-COVERAGE breach while operators were in fact replying.
- The dashboard undo window used bare `Date.parse` on a numeric-string event
  `created_at` (=NaN, treated as "allow"), so the 120s undo window was never
  actually enforced; it now uses the digit-string-aware `toDate`.
- Refreshed `freddie`/`thatcher` to npm `latest` (0.0.139 / 1.0.41): the
  installed `freddie` had drifted 17 versions behind and predated the media-tool
  fixes, so all three opt-in pi media features (voice-note transcription, photo
  vision, TTS voice replies) were silently inert against what actually ran.
- HUMAN keyword detection had no short-message ambiguity gate (unlike STOP),
  so a report sentence like "the human gave it water" false-positived a
  handoff escalation; added the same gate STOP already used.
- Exclude-phrase matching for STOP/HUMAN was scoped to the whole message
  instead of the specific matched key's own occurrence, so a genuine handoff
  request could be suppressed by an unrelated excluded phrase elsewhere in a
  longer message.
- `guessLang` scored a shared "dumela" cue for both Sesotho and Setswana, so a
  bare greeting tied 1-1 and fell back to English despite the system prompt
  promising to match both languages.
- `rateWindows`/`globallyRateLimited` in-memory maps grew unboundedly over a
  long-running process's lifetime; added a periodic sweep evicting stale
  per-contact entries.
- `mergeReport`'s optimistic-lock retry fell back to an unconditional write on
  a second conflict, silently able to clobber a third concurrent writer;
  retries now carry the same version guard, bounded, surfacing (not
  overwriting) after repeated contention.
- `case_get`'s ownership check and `case_mine`'s filter independently
  reimplemented the same logic; extracted to one shared helper so a future fix
  can't diverge between the two and reopen the PII leak both guarded against.
- `case_new` returned `ok:true` even when binding the case active silently
  no-opped (no author on the turn); now reports `boundActive` and a warning.
- The health sweep could re-page a persistently-failing case every interval
  indefinitely instead of once, when its tag write kept failing; added a
  bounded retry gate.
- The supervisor's runtime state could get stuck at `restarting` forever if a
  race made the `BOOTED` transition illegal right after a confirmed worker
  READY; it now force-resyncs to `healthy` since the worker being up is
  ground truth.
- The resilient LLM wrapper never re-probed a backend that resolved once but
  then went consistently degraded (every recent real turn failing), reporting
  offline forever with no self-heal path.
- Dashboard clusters/geo/map/inbox/handover endpoints inconsistently treated
  `resolved` cases as still-open (only excluding `closed`), while the
  management report excluded both -- a resolved outbreak kept showing as an
  active map pin days later. Unified under one `isOpenCase` helper.
- `overview.js`'s `closed_by_day` undercounted `totals.closed` when a case's
  status was set without a transition event (e.g. a bulk import), so the
  report page showed two disagreeing closed-case numbers.
- `workload.js` created a phantom card for any operator id found in reply
  events, including ids no longer on the current roster, leaking a former
  operator's id into the aggregate-only workload endpoint indefinitely.
- `case_update` silently no-opped an explicit empty-string `case_type`/
  `priority` instead of rejecting it the way a bogus value already was.
- `case_report` silently dropped an out-of-range lat/lon (e.g. swapped
  coordinates) with no error, indistinguishable from never having supplied
  one; now returns an explicit rejection.
- STOP/HUMAN keyword detection false-positived on ordinary sentences ("the
  disease will stop spreading", "is there a person who can look at my goats")
  and discarded real report content before the agent ever ran. Extended the
  existing exclude-phrase pattern with the confirmed failure shapes.
- The outbound jargon gate matched "case" inside the idiom "in case", holding
  an otherwise clean reply as an operator draft in every autonomy mode
  including `auto`.
- `enquiring->complete` and `answering->complete` conversation-phase
  transitions were missing from the dstate spec, so a plausible agent-declared
  completion silently failed with no trace. `advanceCase` now logs a loud
  observation on a genuine no-edge transition failure.
- The deterministic acknowledgement layer had no Sesotho/Setswana cues despite
  the system prompt promising to match them -- added distinctive cue lists and
  translated stop/human/resume strings for both.
- The inbox "why" line could contradict its own sort weight: a case tagged
  both an escalated handoff and a pending draft displayed the draft reason
  instead of the higher-weighted escalated-wait reason. Reordered to match.
- The team at-risk count and the per-operator stale-claims count both ignored
  the snooze exemption the inbox scorer already applies, so the header/panel
  disagreed with what an operator actually sees in the list.
- `case_mine`/`case_today` hardcoded the open-status list instead of reading
  the live config-declared set, silently hiding a worker's own cases on a
  customized workflow.
- `classifyCaseHealth`'s timestamp-corrupt early-return skipped every other
  breach check, so a corrupt-timestamp case went dark on missing-critical-facts
  detection until an operator happened to fix the timestamp.

### Changed
- `findOpenCase` now issues a single `status: {$in: <open stages>}` query instead
  of one query per open workflow stage (an allowlist that keeps soft-deleted rows
  out, which a `$ne: 'closed'` denylist would not); `listContacts` pushes its sort
  down to thatcher. Corrected several stale `case-store.js` comments that claimed
  thatcher ignores `orderBy`/`order`, described a removed feature-detect shim,
  referenced a nonexistent `_thatcherSupportsVersionGuard`, and wrongly said
  thatcher's `transition()` throws (it does not; casey keeps transition authority
  for its own config/lockout/audit/notify reasons). Deduped a redundant `escq()`
  and routed remaining inline open-case filters through `isOpenCase`.

### Removed
- `_thatcherSupportsOperators` runtime feature-detect probe and its
  equality-only JS-side operator/sort/row-access fallback in `case-store.js`:
  confirmed permanently dead code now that thatcher's operator-where has
  shipped since v1.0.30 and casey consumes thatcher exclusively via npm
  `latest` (installed 1.0.37). ~110 lines removed including orphaned helpers.

### Added
- Bulk draft-release (`draft_approve`/`draft_discard`) added to the existing
  bulk-action toolbar, matching its established pattern -- a failed send still
  leaves `draft-pending` intact, same fail-safe as the single-case endpoint.

- `photos`/`audio` fields silently discarded every photo/voice note after the
  first one recorded on a case (fill-if-empty semantics), with zero trace --
  no field update, no operator observation event. Fixed via a new append-only
  path (`appendReportField`, and a matching special case in `mergeReport`) so
  every media arrival is recorded and surfaced.
- `mergeReport` (the agent's field-write path) could silently lose a write to
  a concurrent dashboard operator PATCH on the same case, or vice versa,
  whichever landed second winning outright. Now uses thatcher's optimistic
  concurrency guard (`_version`) to detect the race and retries the merge
  against the freshly re-read row -- both sides' edits survive.
- LAST-CHANCE PUSH (the final wrap-up nudge) had drifted from the steady-state
  PRIORITY ORDER list, risking a missed ask for the owner's contact number on
  the way out. Now references PRIORITY ORDER directly instead of re-deriving
  a separate, incomplete list.

### Added
- `case_report` gained an additive `sites` field for a second distinct
  location/herd described within the SAME visit (append-only, alongside the
  primary species/location fields) -- previously a second site silently
  overwrote the first with no field shape to hold both.
- thatcher (sibling repo): `update()` gained an optional optimistic-concurrency
  guard (`opts.expectedVersion` against a new `_version` column) -- a stale
  write now throws a distinguishable `{code:'conflict'}` error instead of
  silently clobbering a concurrent writer. Fully backward compatible.

### Changed
- Merged two overlapping wrap-up nudges in `caseSystemPrompt` into one clear
  LAST-CHANCE PUSH instruction: fires on any farewell-shaped cue in whatever
  language the worker is writing in, explicitly names the VISIT_CRITICAL fields
  so the agent's push targets the same facts the health guardrail alerts on
  hours later, and now explicitly fires before the agent declares
  `case_stage: complete` -- the on-site window is the only chance to capture
  those facts, so the report is never closed out with an unexploited last
  chance still sitting there.

### Added
- Operator identity learning: `learnOperatorActivity` builds a durable
  per-operator working-area profile from dashboard-attributed case actions
  (claim/transition/reply/edit), backed by a new `operator_identity` thatcher
  entity. Surfaced via `GET /api/operators/identities`, feeding the map's
  operator-coverage overlay -- a visual coverage signal for the team, never an
  auto-assignment.
- Case observability map: a Leaflet + OpenStreetMap view in the dashboard
  (`GET /api/map/cases`) pinning every case by the agent's own lat/lon (see
  below). Status-colored markers, clustering (leaflet.markercluster) for dense areas,
  outbreak-cluster link overlay (reusing `clusters.js`), operator-coverage
  overlay, species/case_type/status/date filters, click-through to the existing
  case detail panel. Aggregate/PII-free like every other dashboard rollup.
- Agent-driven observability prep: `case_update` gained an agent-settable
  `case_type` (the map/SLA-by-type/workload views no longer wait on a human to
  classify every case by hand), `case_report` gained `lat`/`lon`. `caseSystemPrompt`
  instructs the agent to set both quietly, on its own judgment, as the report
  makes the picture clear.
- Conversational robustness: a 57-agent audit (enumerate real phrasings per
  dimension -> classify against the real code -> adversarially verify) confirmed
  8 real gaps, all fixed within the pure-LLM architecture (prompt content or a
  narrowly-scoped deterministic guard matching the existing STOP/HUMAN pattern):
  a burst of quick messages is now buffered and replayed instead of silently
  dropped by the in-flight guard; a STOP that arrives packed with report content
  is flagged for manual review instead of the content resting unseen; the STOP/
  HUMAN detector now collapses duplicated ASR-artifact tokens before matching;
  `caseSystemPrompt` gained a data-not-instructions guard, an off-topic scope
  boundary, and garbled-transcript clarify-before-recording guidance; a report
  field correction now shows an old-to-new diff in its audit event.

### Removed
- `src/gazetteer.js`, the hand-curated ~95-town + ~25-alias SA location lookup
  used to approximate a map pin from free-text location. Removed entirely, no
  replacement lookup added -- the map's `lat`/`lon` now come ONLY from the
  agent's own `case_report` call. `case_report`'s lat/lon params and
  `caseSystemPrompt` were widened to explicitly trust and instruct the model to
  use its OWN world knowledge to estimate a described place's coordinates
  (exact GPS still preferred when the worker gives real numbers) -- no lookup
  table, no server-side geocoding of any kind. A case the agent could not place
  simply has no map pin, surfaced honestly in the map's "unresolved" bucket.
  This does not touch the two protected deterministic layers (STOP/HUMAN
  opt-out/handoff keyword safety net, and `case_type`/`priority` storage-enum
  validation) -- both stay, audited and confirmed as genuinely
  safety/integrity-necessary, not interpretation stand-ins.

### Fixed
- `case_update`'s `case_type`/`priority` are now validated against their enum
  before write -- thatcher's config-declared enum type was not enforced
  server-side, so an out-of-enum value from a tool call would have silently
  corrupted every case_type/priority-keyed observability view.
- Discord handoff webhook no longer interpolates the reporter's raw phone number
  into plaintext message content -- the case ref is enough for an operator to open
  the case; PII stayed out of Discord's own logs/exports.
- Public `/report` contact form (unauthenticated by design -- the ref is the shared
  secret) now rate-limits per IP, closing a brute-force path against the 8-char ref
  and the SA phone-number space.
- Dashboard's report-completeness fill-rate and field list had drifted from
  case-store.js's REPORT_KEYS in both directions: `language_detected` was being
  written by the agent but rejected by the write-path allowlist, while
  `present_person`/`present_person_relation`/`owner_name`/`owner_contact` were
  collected but never counted or shown. Both now read the single source of truth.
- `case-health.js`'s open-stage set was a hardcoded literal independent of the
  workflow config; it now takes a live override from `store.getOpenStatuses()`
  (wired through `case-sweep.js`), so a stage added in `thatcher.config.yml` is
  picked up with no code change.
- `createCase()`'s default `assignee` was the AGENT_USER object rather than its
  string id, which would have broken row-access scoping had the default ever
  been hit (currently latent -- the sole caller always passes assignee).

### Removed
- Six unused imports from `gateway-hooks.js`, including a fragile, undocumented
  relative-path import into freddie's internals that the file never called.
- Dead exports `waitingOnUs`/`snoozedUntil` from `attn.js` (no external callers).

### Added
- Worker enquiry + active-case re-architecture (layered across casey/freddie/
  thatcher). A field worker can negotiate/select a case before an excursion and
  data-dump into THAT case, run role-scoped enquiries, and gets a new case only on
  explicit request:
  - thatcher (CRM, published via npm): list() gains operator where-objects
    ($gt/$gte/$lt/$lte/$in/$or), array tie-broken sort, and opt-in row-access
    scoping with a configurable owner field. Backs "today" (date range), "near me"
    (lat/lon box), "my cases" (assignee+user scope), and "anything I can help with"
    (open status set).
  - freddie (agentic): an application-agnostic `case` plugin with the case_* tools
    plus the enquiry toolset (case_mine/case_today/case_today_open/case_near/
    case_select/case_new). Identity comes from a per-turn toolCtx (now threaded
    through the agent machine), and every enquiry row is projected PII-free
    (external_id/contact_id never reach the agent). A `field-worker` distribution.
  - casey (config + glue): the inbound handler passes toolCtx{author,role,store,
    principal,activeCaseRef} into runTurn; case-store gains active-case binding
    (findCaseByRef/setActiveCase/getActiveCase/createCase) and an operator-where
    feature-detect shim so a bare clone / pre-publish install stays green;
    thatcher.config.yml declares lat/lon, claimed_at, contact.active_case_id,
    row_access{scope:assigned,field:assignee}, and list.defaultSort -- so casey's
    recency order and ownership scope are configuration.
- `intake-urge-audit` workflow (`.claude/workflows/intake-urge-audit.js`): a
  reusable multi-agent audit of the chat agent's on-site completion drive -- one
  gm-driving subagent per dimension (one-chance prompt, precedence gate,
  once-per-field, greeting exemption, closing capture, field-capture
  completeness, assisted-draft hold), each finding adversarially verified by an
  independent gm-driving refuter. Aggregate-only, never external_id. Re-runnable
  via `Workflow({name:'intake-urge-audit'})`; the audit surfaced the intake-urge
  fixes below.
- Dashboard case-type management lens: an editable Case type select on the case
  editor whose change sends `case_type` on PATCH (recording the audit event), and
  a "By case type" report panel rendering per-type SLA compliance with an Overall
  row. Wires the existing server-side case_type analytics into the operator UI.
- Per-case-type management analytics: `/api/report.json` gains `sla_by_type`
  (per-type SLA compliance with a reconciling `overall`) and `by_case_type`
  (median first-response, opened/closed, closed_pct, reopen_count), so a director
  can compare outbreak vs routine intake. Aggregate-only, no external_id.
- `GET /api/sla-at-risk/by-type`: open cases sliced by case_type against the live
  handoff SLA, so an operator sees which category is closest to breaching.
- `PATCH /api/cases/:id` accepts `case_type` (enum-validated) and records a distinct
  `case_type a -> b` action event, so every per-type analytic can trace a
  reclassification to when and by whom.
- Channel + case-type metrics gain `closed_pct` and `reopen_count` (a reopen is a
  transition out of resolved/closed back to an active stage), surfacing premature
  closures per channel and per type.
- `clusterSeverity`: suspected-outbreak clusters now rank by member count scaled by
  their case_type mix (outbreak > import_alert > lab_sample > follow_up), so the
  panel orders by data instead of the operator opening each in turn.
- `buildAlertPayload`: a structured, machine-parseable breach payload
  (case_ref/case_type/breach_type/severity_tier/since_ms, never external_id) that the
  breach notifier POSTs to `CASEY_ALERT_WEBHOOK`, so an external pager can route an
  outbreak differently from a follow_up.
- `casey report [--json] [--days N]`: the per-case-type SLA + per-type/per-channel
  briefing on the command line, reusing the same pure builders as the dashboard.
- Coverage-gap team alert: the health sweep now pages once (rising edge) when a
  rostered team has open breaching cases yet nobody has replied in the window, so a
  whole-team outage surfaces even when no single case crosses a per-case threshold.
  Replies are counted only on the breaching cases, so a busy day on unrelated cases
  cannot mask the gap; the page uses a synthetic `TEAM-COVERAGE` ref and leaks no
  contact id.
- Attention SLA clock: the inbox ranking stamps each waiting case with its age
  against an SLA target and reports an at-risk count, so an operator sees how close
  each case is to breaching, not just worst-first order.
- Saved filter views: operators can name and persist filter combinations and share
  one via a `view=` URL hash; the encoding carries only filter knobs, never a
  contact id.
- Per-operator skills checklist: a first-run overlay walks a new operator through
  keyboard triage, the `Mine` filter, and draft release once, keyed to their
  operator id so each person sees it once.

### Fixed
- Two workers in one Discord channel no longer share a case: the case key is now
  per-contact (channel + author) instead of per-channel, so a second author's
  message starts their own case rather than landing on the first's. Replies still
  target the channel (delivery target is split from the case-identity key).
- A complete report no longer dead-ends on "Thank you. Your reference is X": once
  every field is captured, memobot confirms the report is on record and invites a
  fresh report for any other animal or place, so a finished case has a clean exit.
- Intake no longer loops when an asked field has no extractor: a worker's free-text
  answer ("boyi son of the owner") to a question like "who is there and how are they
  linked to the owner?" is now bound to that field (bindPendingAsk) instead of being
  dropped, and nextAsk skips already-asked fields, so the same question is never
  asked on two consecutive turns.

### Changed
- Intake is reframed for a field worker relaying a farmer's animals rather than the
  owner: the asks and the system prompt request only what the worker can see ("what
  can be seen in the animals") or relay ("how long the animals have been like this,
  from what the person says" -- never "when you first noticed it"), lead with
  worker-observable facts, and capture who is on site and their link to the owner
  (owner/relative/herder) plus the owner's contact, so an absent owner with a
  relative present is still recorded.
- A reply is never a bare "Thank you. Your reference is X": once every visit-critical
  fact is captured, memobot asks a value-add fact (a photo, how many, when it started,
  a suspected disease) so it keeps strengthening the report instead of acknowledging.
  Only a case with every visit-critical AND value-add fact already in degrades to a
  brief warm confirming line.
- A livestock count is capped at 6 digits so an id (e.g. a Discord snowflake that
  slipped past mention-stripping) is never stored as a count; a real large herd still
  is.
- memobot now DRIVES report collection on every turn instead of deflecting. Every
  intake reply (intakeAdvanceReply) leads with a brief greeting or a just-captured-
  fact acknowledgement plus the ask for the next needed fact, never the "Thank you
  for letting us know ... your reference is X" holding-ack preamble. A bare greeting
  opens warmly and asks the first needed fact (where/which animals); intake keeps
  asking every still-missing visit-critical fact, one per turn, once each, including
  the tool-only how_to_find/farmer_available/contact_fallback.
- Escape route for a returning contact with a new case: detectNewCaseConflict flags
  a clearly different species/location (a durable NEW-CASE-SIGNAL observation, since
  the agent can rewrite the needs-split tag) so an operator can split, without
  false-triggering on the same outbreak continuing.

### Fixed
- Channel mention markup no longer flips a greeting into the case-ack: a Discord
  "@memobot hello" arrives as "<@BOTID> hello" and the mention's numeric id was
  captured as a livestock count, so a bare greeting got the holding-ack with a
  fabricated number instead of the warm reply. stripChannelMarkup cleans the
  inbound copy (raw still recorded for audit) and extractFields drops the markup
  defensively.
- Precedence gate no longer parrots the holding-ack forever: three of six
  visit-critical fields are never deterministically extractable, so the gate fired
  on every turn of a content-only conversation; it now overrides the model only
  when there is a next field to ask or a fact captured this turn.
- Precedence gate no longer clobbers the one-shot closing ask: a genuine wrap-up
  keeps the model's warm thanks+single-ask, and the degraded closing path asks the
  single most-important missing fact.
- Once-per-field marker is recorded only after the question is delivered, so a
  transient send failure re-asks the field next turn instead of burning it.
- Field capture: "limp" no longer matches inside "Limpopo"; a weekday after "from"
  is an onset, not a location; a place no longer absorbs the "from the" article;
  isiZulu/isiXhosa sick/died verbs and singular species are captured; and common
  controlled-disease signs (abortion, mouth sores, salivation, recumbency) are
  recognised -- all without mis-reading ordinary English/Afrikaans words.
- Intake-urge once-per-field: the empty-model branch and the INTAKE-DRIVE
  precedence gate no longer both fire in one turn. They were independent `if`
  blocks, so the gate re-read the event log, saw the field the empty branch had
  just recorded as asked, and overwrote the reply with the next field's ask --
  recording a field as asked-once while its question was never delivered, burning
  it forever. A `droveIntake` flag now skips the gate when the empty branch
  already drove intake.
- Intake-urge field capture: `dead_count` no longer takes the first number in the
  message regardless of meaning. "I have 100 cattle and 3 died" recorded 100 dead
  (a wrong visit-critical fact that then stopped intake asking); counts are now
  bound by proximity to the death word, with the herd total going to
  `affected_count`.
- Intake-urge: the photos nudge fires on the deterministically-capturable core
  (species/symptoms/location) instead of all six visit-critical fields (three of
  which are never deterministically captured, so it effectively never fired), and
  composes the question structurally rather than quoting a copyable phrase.
- Intake-urge closing capture: an engaged "thanks, what next?" no longer spends
  the one-shot closing nudge meant for a genuine wrap-up; `isWrapUpThanks`
  excludes forward-looking tokens, and a token merely containing "thank"
  ("thankfully") no longer classifies as thanks.
- Field capture: horse/donkey/chicken/poultry and isiXhosa `iimvu` are captured
  as species (were silently dropped, so intake re-asked a stated animal); a
  location no longer absorbs the trailing place-type word ("Greenvalley farm" ->
  "Greenvalley"); and a captured-field acknowledgement no longer stacks on the
  generic holding ack (a double thank-you that overran the 240-char reply cap).
- The AI helper no longer latches "offline" for the whole process life when the
  LLM provider happens to be down at boot. `resolveCallLLM` probed once and the
  case handler closed over a static `callLLM`, so a provider that recovered minutes
  later was never picked up without a restart -- contacts kept getting only the
  holding message. `makeResilientCallLLM` re-resolves the backend lazily (single
  in-flight probe, debounced) and throws while degraded so the handler's existing
  fallback still sends a holding reply; its `status()` is the single live source
  for the dashboard health row, so recovery shows -- and auto-replies resume --
  with no restart.
- Event `data` was read as an object in several aggregators while thatcher
  persists it as a JSON string (and `store.listEvents` returns it unparsed), so
  the reads silently missed: operator reply credit in the workload rollup was
  always zero, dwell-per-stage and closed-by-day in the overview mis-bucketed on
  every transition that carried a `from`/`to`, and the dashboard's per-field notes
  never grouped. A shared `evData()` parse in `overview.js` (reused by
  `workload.js`) and a `parseEventData()` at the `/api/cases/:id` + `/events`
  boundary now hand object `data` to every consumer.
- Event ordering: a same-millisecond inbound+outbound pair could be returned
  outbound-first because the tie-break sorted ids lexicographically (`"10"` before
  `"9"`). It now compares numeric ids numerically, restoring insertion order, so the
  boot resume sweep no longer mistakes a completed turn for a pending one and writes
  a spurious resume marker.
- Auto-replies are sent to the channel id (`external_id`), not the message author
  id, so Discord delivery no longer 404s and silently drops -- contacts now get
  the reply.
- The first-message system prompt no longer hands the model a copy-ready
  acknowledgement, so the small model stops parroting a canned, comma-spliced
  greeting; a reply that echoes the prompt example is now caught and replaced by
  the safe fallback rather than leaked.
- `test.js` runs from an isolated temp cwd, so a test run can no longer wipe a
  live `casey up` database (thatcher's sqlite handle is cwd-bound).
- Store-outage and case-create-failure paths now actually send their warm holding
  reply to the contact instead of building it and returning silently.
- Discord send now verifies delivery: freddie's adapter `fetch().then(r=>r.json())`
  swallowed non-2xx responses, so a rejected send looked successful. The send is
  wrapped to throw on a Discord error body, so a failed outbound is recorded as a
  send-failure observation instead of being silently lost.

### Added
- The management report (`/api/report.csv`, `/api/report.html`) now carries a
  per-operator **Team workload** section -- open cases held, stale claims, replies
  in the last 24h, usual first-reply speed and oldest case still waiting, worst-first.
  A manager's exported or printed shift/period briefing now names who did what, not
  just the aggregate counts. Composed from the same aggregate-only `buildWorkload`
  rollup the dashboard panel uses (operator name + numbers only, never a contact
  id), so the briefing leaks no `external_id`.
- Staff/management surface for the team running casey: a worst-first **Team
  workload** panel (`/api/operators/workload`) showing, per rostered operator,
  open cases held, stale claims, replies today, usual first-reply speed and the
  oldest case still waiting (aggregate-only, no per-contact rows); a **Mine**
  filter that scopes the case list and "Needs you now" inbox to the cases you have
  claimed; **keyboard triage** shortcuts (`j`/`k` move, `o`/`Enter` open, `c`
  claim, `e` reply, `/` search, `?` help, `Esc` back); and a first-run **quick-start
  onboarding** overlay. The single real-services `test.js` gains a workload
  assertion block (worst-first card, open/replies/median, no `external_id` leak).
- Focus mode: a "Focus" header button (and the `#inbox` deep-link hash) collapses
  the dashboard to only the ranked "Needs you now" list, hides the filters, bulk
  bar and full case list, skips the heavy ~200-row case poll at load, and quiets
  the 5s list poll so a phone runs only the cheap attention poll plus health.
  Case detail still opens on tap; the mode survives reload and preserves any
  open-case hash alongside it.
- Deterministic field capture every turn (`src/extract.js`). The production model
  is a small local model that does not reliably call the `case_report` tool, so a
  real conversation would log an empty case. casey now runs `extractFields` on
  every inbound turn and records whatever the contact plainly stated (species,
  symptoms, counts, location, onset, name) -- so an actionable case gets all the
  details it needs, not just a logged reference. The degraded fallback advances
  field-by-field (asking the next missing detail) rather than re-greeting, and a
  later greeting on an in-progress case still captures its content. Location
  capture stops at a following clause word ("near Musina since Monday" -> place
  "Musina") and symptom capture matches inflected forms ("limping", "drooling").
- Receive-liveness watchdog. A gateway WebSocket can go zombie (TCP still
  ESTABLISHED but gateway-dead) and silently stop delivering inbound while the
  process, HTTP server, and outbound send all stay healthy -- "online but
  answering nobody". casey now stamps each real-time channel's last connect
  (gateway READY/RESUMED) and last inbound; `GET /api/health` reports a `gateway`
  field, and the dashboard pill shows "Messages: not connected" in red when a
  configured channel has never connected since start, overriding the green AI
  helper line so a deaf receive can never hide behind "online".
- Supervised runtime. `casey up` now forks the gateway+dashboard in a child worker
  under a supervisor (`src/supervisor.js`, driven by the pure xstate machine in
  `src/supervisor-machine.js`) that recycles the worker on a crash (bounded restart
  with backoff and a crash budget) and on a source edit (hot reload: drains
  in-flight turns, then re-forks on fresh code). The parent never imports app code,
  so it survives any worker fault; the case store is reopened per worker so nothing
  is lost across a recycle. `src/` and a sibling `../freddie/src` are watched by
  default; `CASEY_RELOAD_PATHS` adds dirs, `CASEY_RELOAD=0` / `--no-reload` disables
  watching, and `--no-supervise` runs the legacy single-process path. An optional
  zombie-receive self-heal (`CASEY_RECEIVE_SILENCE_MS`) restarts a channel that went
  silent too long.
- Management and staff oversight surface. A worst-first attention inbox
  (`src/attn.js` `rankAttention`/`caseHints`, `GET /api/attention`) ranks every
  open case by an enum-weighted urgency score so the most urgent reaches the top
  even past the list-page window, and the dashboard / `casey attention` CLI both
  read it. Aggregate read-only endpoints back the metrics, outbreak, hotspot, and
  audit views: `GET /api/overview` (time-to-first-reply, dwell-per-stage, backlog),
  `GET /api/clusters` (correlated cases by shared location/species), `GET /api/geo`
  (hotspots by area), `GET /api/activity` (merged audited event stream),
  `GET /api/fleet-health` (sweep trend), and `GET /api/runtime` (supervisor health).
  Operator-tunable health thresholds (`src/thresholds.js`, `GET`/`PUT
  /api/thresholds`) feed both the periodic sweep and the inbox classifier live, so
  a team can retune the handoff/stale/abandon windows without a restart.
  Cooperative operator identity (`CASEY_OPERATORS`, `GET /api/operators`,
  `X-Casey-Operator`) attributes actions to a known roster member. A high-severity
  health breach pages an optional alert webhook (`CASEY_ALERT_WEBHOOK`), with a
  distinct escalated tier (`escalateHandoffMs`) for a handoff left unanswered too
  long. Shift handover (`GET /api/handover`, `POST /api/handover/start-shift`),
  an AI-offline queue (`GET /api/unreplied`), bulk actions (`POST /api/cases/bulk`),
  per-case snooze and a compensating undo (`POST /api/cases/:id/snooze`,
  `/undo`), and a management report export (`GET /api/report.csv` / `.html`) round
  out the operator workflow. `GET /api/ready` is an intentionally ungated
  orchestrator readiness probe that leaks no case data.
- Assisted autonomy is now real, not a label. An `assisted` case holds the agent's
  reply as a `draft-pending` draft instead of sending it; an operator reviews and
  releases it via `POST /api/cases/:id/draft/approve` (or discards it), and an
  unsent draft past its window surfaces in the inbox as its own breach.

### Changed
- First contact greeting is neutral about ownership across en/af/zu/xh, since the
  reporter is often organising-team staff inspecting someone else's animals, not
  the owner.
- `casey doctor` and `casey up` print the data-dir location.

## 0.2.0 - 2026-06-22

### Security
- Dashboard token no longer accepted via query param on API routes; Bearer and
  X-Casey-Token headers only. Page-load GET / still accepts `?token=` for human
  convenience (client strips it from the address bar immediately).
- `WHATSAPP_APP_SECRET` is required when WhatsApp credentials are present;
  `casey up` and `casey doctor` both hard-fail without it.
- Constant-time token comparison (`crypto.timingSafeEqual`) to prevent timing oracles.

### Features
- `casey doctor`: checks for `thatcher.config.yml` presence (startup would fail without it).
- `casey doctor`: respects `--port <n>` and validates the port you will actually use.
- `casey cases`: `--channel <discord|whatsapp|sim>` filter; shows contact external_id and created date.
- `casey sim`: prints structured report fields (species, symptoms, location, ...) after the summary.
- Dashboard search input (`/` key, `Esc` to clear) with 120ms debounce filters by ref, subject,
  summary, contact, and channel. Stage dropdown filter. Both already wired and working.
- AGENTS.md at repo root: architecture contract for AI assistants (import rules, security invariants,
  test strategy, thatcher constraints, ASCII house-style, gm-skill memory discipline).

### Resilience
- `createDashboard` returns a Promise; `casey up` and `casey dashboard` await it with error handling on bind failure.
- SIGINT handlers wrapped in try/catch; double Ctrl-C is guarded.
- Agent reply fallback path: empty/error model output always results in a safe holding message, never a silent no-op.

### Dashboard UX
- LLM health pill in the topbar: shows online (green), test stub (amber), or offline (red).
- "Needs you now" triage inbox pinned to top of case list.
- Plain-language mode (`Aa` button) relabels workflow stages everywhere.
- First-run help overlay (re-open with `?`).
- Handoff alert banner (chime + flashing tab) when a contact asks for a real person.
- Per-case "what to do now" hint and canned ready-made replies.
- Deep-linked open case in the URL (shareable). Light/dark toggle persists.

### Operations
- `casey init` scaffolds a `.env` template; `casey doctor` is a full preflight checker.
- `casey sim --scenario <name>` replays named low-literacy personas (fmd-cattle, afrikaans-farmer, ...).

## 0.1.0 - initial release

Core: WhatsApp/Discord/sim -> freddie Gateway -> thatcher CaseStore -> operator dashboard.
