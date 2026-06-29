# AGENTS.md

Operating notes for agents (and humans) working in the casey repo. This file is
included by `CLAUDE.md` via `@AGENTS.md`; keep it accurate against `README.md`
and the source.

## What casey is

casey is a thin orchestrator for **animal-disease surveillance in rural South
Africa**. Field workers report sick or dead livestock over WhatsApp/Discord in
their own language; casey gathers a structured report warmly and without
interrogation, and gives the organising team one observable, editable view per
report. Times are shown in SAST and phone numbers in +27 format. casey amplifies
the team's workflow -- it does not impose disease rules or escalation; priority
stays with people.

## Architecture

casey composes three existing projects and owns only the glue:

| Layer | Project | Role |
|-------|---------|------|
| Agent + channels | `freddie` (`file:../freddie`) | Agent harness + Gateway with WhatsApp/Discord adapters, tools, sessions. |
| System of record | `thatcher` (npm) | Config-driven CRUD + workflow + RBAC + audit. Holds `case` / `event` / `contact` and the lifecycle state machine. |
| UI | `anentrypoint-design` (`file:../anentrypoint-design`) | webjsx + ripple-ui design system theming the dashboard. |
| Conversation state | `adaptogen` (`file:../dstate`) | Agent-owned DAG+FSM with soft/hard enforcement -- casey's SOFT conversation machine (intent-driven, guardrails flag not block). Optional: a bare clone degrades to a pure intent->route map. |

Inbound flow: channel message -> freddie Gateway -> casey case handler (replaces
`handleInbound`) -> find/create thatcher case (locked, deduped by message id) ->
agent turn with case context + `case_*` tools -> reply, with a safe fallback when
the model errors/empties. Every inbound/outbound/observation/action/transition is
an append-only `event` row. The dashboard reads/edits thatcher over its API.

**Layering mandate: agentic code -> freddie, CRM code -> thatcher, casey is
setup + configuration.** The agentic case + worker-enquiry toolset lives in freddie
(`freddie/src/plugins/case/`): the `case_*` tools plus the enquiry surface
(`case_mine` / `case_today` / `case_today_open` / `case_near` / `case_select` /
`case_new`), application-agnostic -- the store, the field/enum/projection vocabulary,
and the role model arrive via a per-turn `toolCtx` and `plugins.case` config. CRM
querying lives in thatcher (consumed via npm, published by CI on push): `list()`
supports operator where-objects (`{field:{$gte,$lte,$in}}`, `$or`), array tie-broken
sort, and opt-in row-access scoping (`opts.user` + a configurable owner field). casey
is the configuration instance: `thatcher.config.yml` declares the entities,
`row_access`, `list.defaultSort`, and the lat/lon/active_case_id fields; the handler
passes `toolCtx{author,role,store,principal,activeCaseRef}` so the enquiry tools
answer FOR the asking worker.

**Worker identity = the channel author; a worker selects a case before data-dumping
into it.** A worker negotiates/selects a case (by ref or from an enquiry list) which
binds active (`contact.active_case_id`); their field updates append to THAT case, and
a new case is opened only on an explicit `case_new`. Role-scoped enquiries return only
what the worker may see and are PII-free: every per-case enquiry row is projected to a
whitelist that EXCLUDES `external_id`/`contact_id`, so a list can never surface a phone
number. casey's `case-store.js` carries an operator-where FEATURE-DETECT shim (probe
the published thatcher; fall back to equality-only + JS operator predicates + recency
sort) so a bare clone and a pre-publish install stay green -- the same npm-publish-lag
caveat the thatcher shim section documents.

## Source map

```
thatcher.config.yml        entities + case workflow (system of record)
bin/casey.js               CLI: init / doctor / up / dashboard / sim / cases / show / report (per-case-type SLA + per-type/per-channel metrics, --json)
plugins/case-tools/        freddie plugin registering case_* tools (auto-discovered)
src/
  casey.js                 top-level assembly: store + host + gateway + adapters + logger
  case-store.js            thatcher wrapper: find-or-create (locked), events, transitions, paging, config validation
  case-runtime.js          process singleton so the plugin reaches the live CaseStore
  case-tools.js            case_* tool defs (get/list/update/observe/transition), autonomy-enforced
  case-machine.js          xstate case lifecycle machine
  case-health.js           per-case health/guardrail signals
  case-sweep.js            periodic health-guardrail sweep; detectCoverageGap (rostered team, open breaching cases, zero in-window operator replies) pages a synthetic TEAM-COVERAGE breach
  correlate.js             cross-case correlation helpers
  intent.js                interpret a message into a structured intent (report|enquiry{today,mine,open,near+place}|question|chitchat|service) by shape; classifyIntentFallback (soft deterministic fallback) + normalizeIntent (model case_intent declaration) + extractPlace; report-content veto
  conversation-fsm.js      the conversation as an adaptogen (../dstate) DAG+FSM with SOFT enforcement (CONVERSATION_SPEC); advanceConversation maps intent->route+soft-transition trace; optional-imports adaptogen (degrades to a pure intent->route map when ../dstate absent)
  attn.js                  worst-first attention ranking (rankAttention, with an SLA clock: waitingOnUs/waitAgeMs/atRiskCount/slaTargetMs) + shared caseHints why/to-do policy; backs the inbox and `casey attention`
  format.js                shared SAST timestamp + +27 phone formatters (CLI and SPA render the same way)
  thresholds.js            pure validate/clamp/merge of operator-tunable health thresholds (allowlist keys + bounds)
  overview.js              KPI aggregates over the event log (time-to-first-reply, dwell-per-stage, backlog) for /api/overview; exports shared evData() event.data parser
  workload.js              per-operator workload rollup (open/stale-claims/replies-24h/first-reply-median/oldest-waiting, worst-first) for /api/operators/workload; aggregate-only
  clusters.js              correlated-case components (shared location/species) for /api/clusters; clusterSeverity ranks suspected outbreaks by member count scaled by case_type mix (outbreak>import_alert>lab_sample>follow_up), severity-desc sorted
  geo.js                   hotspots-by-area rollup for /api/geo
  report.js                management report rendering (CSV/HTML) for /api/report.csv and /api/report.html; composes buildWorkload into a per-operator by_operator section (aggregate-only, no external_id)
  report-analytics.js      pure management analytics for /api/report.json: buildSLAReport (pass/fail vs the live handoff SLA, answered-late vs never-answered), buildSLAReportByType (the same compliance partitioned by case_type, with an `overall` that reconciles), buildReportComparison (this window vs the prior adjacent window, signed deltas), buildChannelMetrics + buildCaseTypeMetrics (shared rollupByKey: first-response median, opened/closed, closed_pct, reopen_count per channel / per case_type), buildAlertPayload (structured machine-parseable breach payload for an external pager: case_ref/case_type/breach_type/severity_tier/since_ms, NEVER external_id); all aggregate-only, no external_id
  extract.js               deterministic field capture from plain contact text (species/symptoms/counts/location/onset/name); shared by the live handler and the stub model so a case is never an empty shell even when the model drives no tools
  gateway-hooks.js         makeCaseHandler: plain-language prompt, INTERPRETED intent routing (intent.js + conversation-fsm.js soft FSM; renderItinerary/answerQuestion answer enquiry/question without the complete-report dead-end), irreversible-intent keywords (stop/human), dedup, media, observe, fallback
  discord-receive.js       fallback Discord WS receive for older freddie builds
  llm.js                   model call wiring; resolveCallLLM (boot precedence: stub/acptoapi/null) + makeResilientCallLLM (self-healing backend that re-resolves a recovered provider, single live status() for the health row)
  sim/inject.js            MockAdapter + scripted-conversation runner (offline)
  sim/scenarios.js         named low-literacy personas
  sim/stub-llm.js          deterministic model for sim + tests (never used in production)
  dashboard/server.js      express API + anentrypoint-design SPA (observe/edit/override/reply); GET/POST /report public contact form (no token)
test.js                    end-to-end suite (real thatcher + freddie, stub model)
```

## Dev workflow

```sh
npm install                 # requires sibling ../freddie and ../anentrypoint-design checkouts
node bin/casey.js init      # scaffold a .env (channel tokens, dashboard secret)
node bin/casey.js doctor    # green/red preflight: deps, channels, port, token
node bin/casey.js up        # gateway + dashboard (default http://localhost:4000)
node bin/casey.js sim "my cattle are sick"        # offline conversation, stub model
node bin/casey.js sim --scenario <name>           # replay a low-literacy persona
npm run lint                # dependency-free preflight (syntax+config+package+ascii); the CI gate
node test.js                # end-to-end suite (CASEY_STUB_LLM path, stub model)
```

CI: `.github/workflows/ci.yml` runs `npm run lint` (`scripts/lint.mjs`) on every
push and PR. It is dependency-free on purpose -- it does NOT need the `file:../`
siblings, so it stays green in a bare clone. Keep `test.js` as the real-services
witness; do not move its real-services assertions into the lint gate.

Note: `freddie`, `anentrypoint-design`, and `adaptogen` are `file:../` dependencies
(`../freddie`, `../anentrypoint-design`, `../dstate`). Without those sibling checkouts
(and `thatcher` from npm) installed, `node test.js` and `casey up` fail with
`ERR_MODULE_NOT_FOUND`; only static review is possible in a clone that lacks them.
`adaptogen` is the exception that degrades gracefully: `conversation-fsm.js`
optional-imports it, so its absence drops the durable soft-FSM trace but the
intent->route map (and the no-dead-end guarantee) still hold -- the dependency-free
CI lint and a bare clone stay green. Set `CASEY_STUB_LLM=1` to run `up` fully offline.

## Environment

| Variable | Purpose |
|----------|---------|
| `DISCORD_BOT_TOKEN` | Enable Discord (gateway WebSocket receive with RESUME). |
| `WHATSAPP_API_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Enable WhatsApp (Meta Graph send). |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification handshake token. |
| `WHATSAPP_APP_SECRET` | When set, inbound webhooks are HMAC-SHA256 verified; forged posts rejected. |
| `WHATSAPP_WEBHOOK_PORT`, `WHATSAPP_WEBHOOK_PATH` | Fixed webhook port/path for a stable public URL. |
| `CASEY_DASHBOARD_TOKEN` | When set, dashboard API + page require this token (`Authorization: Bearer <token>` or `X-Casey-Token` header). For the initial page load only, `?token=` in the URL is also accepted; the client strips it from the address bar and switches to header for all API calls. |
| `CASEY_PUBLIC_URL` | When set, the agent includes a `{CASEY_PUBLIC_URL}/report?ref={ref}` link in the first contact message. The `/report` page is a public (no-token) contact-facing form where contacts can fill in case details directly. |
| `CASEY_ALERT_WEBHOOK` | When set, a high-severity health breach (unanswered handoff, and the escalated tier) POSTs a plain JSON alert to this URL so a team is paged off-dashboard. Each newly-entered breach pages once; an already-flagged case is not re-paged. |
| `CASEY_OPERATORS` | Cooperative operator roster (comma-separated `id:Name` pairs), fixed at boot. `GET /api/operators` lists it and `X-Casey-Operator` selects a known id to attribute an action; this is attribution, not authentication -- an unknown/absent value falls back to the default actor and can never inject a new identity. |
| `CASEY_LOG=silent` | Silence structured JSON logs (used by tests). |
| `CASEY_STUB_LLM=1` | Run `casey up` with the offline stub model. |
| `CASEY_RELOAD=0` | Disable hot-reload (the supervisor still restarts on crash; it just stops watching source). |
| `CASEY_RELOAD_PATHS` | Comma-separated extra dirs to watch for reload (e.g. `../freddie/src`). `src/` and a sibling `../freddie/src` are watched by default; absent dirs are skipped with a warning. Allowlist only -- never contact input. |
| `CASEY_RELOAD_DEBOUNCE_MS` | Coalesce a burst of saves into one reload (default 300). |
| `CASEY_DRAIN_DEADLINE_MS` | How long a reloading worker may finish in-flight turns before it is killed (default 15000). |
| `CASEY_CRASH_WINDOW_MS`, `CASEY_CRASH_LIMIT` | Crash budget: more than `LIMIT` crashes within `WINDOW` ms stops the restart loop instead of thrashing (defaults 60000 / 5). |
| `CASEY_RESTART_BACKOFF_MS`, `CASEY_RESTART_BACKOFF_CEIL_MS` | Restart backoff base and ceiling (defaults 500 / 10000). |
| `CASEY_RECEIVE_SILENCE_MS` | Zombie-receive self-heal: a channel that was receiving then went silent longer than this is treated as a wedged gateway and restarted. Default 0 = OFF (a quiet day is indistinguishable from a wedge by silence alone). |

## Supervised runtime (hot reload + crash restart)

`casey up` runs under a supervisor (`src/supervisor.js`) that forks the actual
gateway+dashboard in a child worker (`bin/worker.js`) and owns fork/kill/watch.
The supervisor never re-imports app code, so a worker crash or a source edit only
recycles the child -- the parent stays up. `src/supervisor-machine.js` is the pure
xstate v5 transition authority (running -> draining -> restarting -> running, plus
the crash-budget stop state); the supervisor is its only I/O.

- Hot reload: a `.js`/`.mjs` save under a watched dir (default `src/` +
  `../freddie/src`) drains in-flight turns (up to `CASEY_DRAIN_DEADLINE_MS`) then
  re-forks the worker on fresh code. The store (`app.db`) is the durable boundary,
  reopened per worker -- nothing is lost across a reload. Reload keys on file
  mtimes, so a raw `git commit` alone does NOT refresh a running worker -- a
  committed fix is inert until a watched source file's mtime changes. When
  re-verifying a fix against a live process, confirm the running process started
  AFTER the fix commit, not just that the fix is on disk.
- Auto-reload on pull (`hooks/` + `npm run install-hooks`): the gap above is closed
  for `git pull`/`checkout` by tracked git hooks. `scripts/install-hooks.mjs` points
  `core.hooksPath` at the tracked `hooks/` dir (one command per clone, since
  `.git/hooks` is not tracked); `hooks/post-merge` and `hooks/post-checkout` then
  `touch src/casey.js` after a pull/merge/checkout, bumping a watched file's mtime so
  the supervisor hot-reloads on the freshly-pulled code with no manual restart
  (`touch` changes only the timestamp, never the bytes). For an unattended host,
  `scripts/auto-update.mjs` (`npm run auto-update`, opt-in via `CASEY_AUTO_UPDATE=1`)
  periodically `git pull --ff-only` so a push to origin auto-deploys via the hook;
  off by default so a dev checkout never auto-pulls.
- Crash restart: a worker that exits non-zero is re-forked with exponential
  backoff, bounded by the crash budget so a boot-loop stops instead of thrashing.
- The watch list is a fixed allowlist (`src/`, `../freddie/src`, `CASEY_RELOAD_PATHS`),
  never derived from contact input; the fork takes an argv array, never an
  interpolated shell string. Run `casey up --no-reload` to watch nothing and
  `casey up --no-supervise` to run the worker in-process (no restart-on-crash).

## Design principles (preserve these)

- **Plain, warm language** to the contact: one idea per sentence, no internal
  jargon (case/triage/workflow/status/priority), mirror the contact's language,
  give a plain-words reference number on first contact.
- **Never a dead-end reply**: empty, emoji-only, and media-only inbound still get
  a gentle helpful answer; the agent always sends a safe fallback on model
  error/timeout/empty and records the failure as an observation, never leaked. A
  reply that parrots a system-prompt example verbatim is treated as a failed turn
  (`isPromptEcho`) and replaced by the fallback.
- **The reporter is usually a field worker relaying a farmer's animals, not the
  owner.** The person messaging is typically a field worker out on a visit,
  reporting livestock they have just come to see -- standing with the farmer, a
  relative, or a herder, out in the bush with limited info -- so they may not own
  the animals or have seen the problem start. The ask hints (`VISIT_CRITICAL_ASK`,
  `VALUE_ADD_ASK`) and `caseSystemPrompt` ask only what the worker can SEE ("what
  can be seen in the animals") or RELAY ("how long the animals have been like this,
  from what the person says") -- NEVER "when you first noticed it". Worker-observable
  facts lead; the people-on-site facts (who is there and their link to the owner --
  owner/relative/herder/neighbour -- and the owner's name + a number, recorded as
  `present_person`/`present_person_relation`/`owner_name`/`owner_contact`) and the
  farmer-dependent history come after, framed as the person's account. (REPORT_KEYS
  in case-store.js carries these fields; the report itself is free-form JSON.)
- **Every ask must be answerable: a free-text answer is bound to the field just
  asked.** Many fields (the people/owner facts, `how_to_find`) have NO deterministic
  extractor and the weak production model rarely calls `case_report`, so a worker's
  free-text answer ("boyi son of the owner") would be dropped and the same question
  re-asked forever. `nextAsk(report, askedKeys)` is the single source of truth for
  the next field (visit-critical first, then value-add, skipping any already asked),
  and every ask path records a durable `ASKED:`/`FALLBACK-ASK:` marker. On the next
  turn `bindPendingAsk` binds the free-text inbound to that pending field (when no
  real field was captured this turn and it is not a fixed-intent message). So a
  field is asked at most once and its answer is always recorded -- the same question
  is never asked on two consecutive turns.
- **A case is keyed per CONTACT, not per channel; delivery target is separate.**
  `conversationKey` returns `container:author` when a channel/chat carries multiple
  authors (a Discord server channel) and the single id for a 1:1 chat -- so two
  workers in one channel get DISTINCT cases (a second author's message must not land
  on the first's case). The reply DELIVERY target is `replyTarget()` (the channel --
  Discord posts to `/channels/{channel}/messages`; an author id 404s), kept separate
  from the per-contact key: the key drives find-or-create, the in-flight lock, and
  dedup, while every `to:` is `replyTo`.
- **A complete report confirms and EXITS, never a bare acknowledgement.** When every
  visit-critical and value-add field is captured (`nextAsk` returns null), the reply
  is `completeReply`: it confirms the full report is on record and the team will
  follow up, AND invites a fresh report for any other animal or place -- so a
  finished case is never the "Thank you. Your reference is X" dead-end. A new
  substantive message then branches a new case (via `detectNewCaseConflict` /
  find-or-create).
- **A greeting is the OPENING of a report: every turn DRIVES collection, never the
  case-ack and never a no-ask pleasantry.** memobot's job is to gather the case
  while someone is on-site, so even a bare "hi"/"hello"/"help" must reply with a warm
  opener PLUS the single most-important still-missing fact (on a brand-new case that
  is "where the animals are"). The two dead-ends to avoid: parroting "Thank you for
  letting us know ... your reference is X" (treats hello as a report), and a warm
  pleasantry that asks for nothing (collects nothing). Every intake-driving reply is
  built by `intakeAdvanceReply` (gateway-hooks.js): a just-captured-fact ack OR a
  brief warm opener, then the ask, then a short ref tail -- NEVER the holding-ack
  preamble. `isContentFreeTurn(justCaptured, report)` (nothing captured AND empty
  report) routes a greeting to `warmConversationalReply`, which now opens warmly and
  asks the first needed fact (records a `GREETING-DRIVE` observation). Intake keeps
  asking every still-missing visit-critical fact one per turn, once each, INCLUDING
  the tool-only how_to_find/farmer_available/contact_fallback, until the report is as
  complete as can be achieved.
- **Escape route for a returning contact with a NEW case.** Because find-or-create
  reuses the open case per conversation and `markReportFieldsIfEmpty` is fill-if-
  empty, a contact who returns and states a clearly different situation would be
  trapped urging the old report's missing fields. `detectNewCaseConflict` flags it:
  a freshly-extracted species/location present in the report AND different from it
  is a `NEW-CASE-SIGNAL` (a durable append-only observation -- the agent's own
  case_update can rewrite tags, so the signal cannot live only in the `needs-split`
  tag) so an operator can split. Same outbreak continuing (same or unstated
  species/location) never trips it.
- **Never stay degraded: the LLM backend self-heals.** `resolveCallLLM` probes the
  provider once, but the gateway must not latch "AI helper offline" for its whole
  life if the provider was merely down at boot. `makeResilientCallLLM` (in
  `llm.js`) re-resolves the backend lazily -- a single in-flight probe, debounced
  to at most once per interval -- and throws while degraded so the never-dead-end
  fallback still fires; once a real provider is reachable it delegates with no probe
  overhead. The dashboard health row reads the SAME backend via `status()`, so a
  recovered provider resumes real auto-replies (and shows green) with no restart.
- **No copyable reply examples in the prompt**: `caseSystemPrompt` must not give
  the model a full quoted sample reply -- small models copy it word-for-word. Only
  literal tokens that must be reproduced exactly (the reference, a link) may
  appear, each with an explicit "write the surrounding sentence yourself"
  instruction; everything else is a structural instruction the model composes.
- **Fixed keywords short-circuit the LLM**: `HELP` / `STATUS` / `HUMAN` / `STOP`
  answer instantly in any phrasing/language.
- **Soft states, soft transitions: the message is INTERPRETED, not keyword-matched,
  and guardrails inform rather than interfere**: a worker ASKING about their work
  ("what's on the itinerary today", "my cases", "the nearest case to <place>") or
  asking a general question is a different act from REPORTING an animal -- but a
  fixed-phrase detector could never cover the open-ended ways a worker phrases it
  (the witnessed whack-a-mole: each new phrasing slipped through to the
  complete-report exit "we have the full report ... your reference is X"). So casey
  INTERPRETS each message into a structured intent (`intent.js`: report | enquiry
  {today,mine,open,near+place} | question | chitchat | service) by SHAPE, and the
  conversation is an `adaptogen` (`../dstate`) DAG+FSM with SOFT enforcement
  (`conversation-fsm.js`): every transition is allowed and merely FLAGGED, so a
  question or enquiry from a "complete" case moves freely out of that state -- the
  complete-report dead-end is structurally impossible. The interpreter is the in-loop
  agent model when it declares a `case_intent` (recorded as an `INTENT-DECLARED`
  observation the gateway prefers on the next turn); a deterministic SOFT shape
  classifier is the fallback when a weak model declares nothing -- it SUGGESTS, the
  soft FSM never blocks. A report-content veto keeps a real report
  (sick/dead/drooling, "2 cows died today") from ever being read as an enquiry.
  Enquiries answer from the PII-free surface (`renderItinerary`, incl.
  near-by-location-text since lat/lon is optional and there's no geocoder); a general
  question gets a helpful answer, NEVER the complete exit; report/chitchat fall
  through to the agent turn. The soft decision (intent + FSM trace) is recorded as an
  observation -- the guardrail informing, never shown to the contact. adaptogen holds
  CONVERSATION state; thatcher stays the case system-of-record. Only the IRREVERSIBLE
  service intents (`stop`/`human`, and `status`/`help`) stay hard-deterministic
  (`detectContactIntent`) -- a safety layer that must fire in any language without a
  model.
- **Full observability**: every action is an append-only audited `event` row.
- **Receive-liveness is observable, never a false green**: a real-time channel
  (Discord/WhatsApp) can have a live TCP socket yet a dead gateway and deliver no
  inbound. casey stamps each channel's last connect (gateway READY/RESUMED) and
  last inbound; `GET /api/health` carries a `gateway` field and the dashboard pill
  shows "Messages: not connected" in red when a configured channel never connected
  since start. Outbound send verifies delivery (a non-2xx is a recorded
  send-failure observation), so neither a deaf receive nor a dropped send hides.
- **Autonomy modes** per case (`auto | assisted | observe`) scope what the agent
  may do; the dashboard can override stage and reply as a human.
- **Operator surface is low-jargon**: "Needs you now" inbox, plain-language mode,
  ready-made replies, handoff banner, "what to do now" hints, a first-run
  quick-start onboarding overlay, keyboard triage (`j`/`k`/`o`/`Enter`/`c`/`e`/`/`/`?`/`Esc`),
  a `Mine` filter scoping the list+inbox to the picked operator's claimed cases,
  a worst-first `Team` workload panel (open/stale-claims/replies-today/first-reply
  speed per rostered operator, aggregate-only, no per-contact rows), saved filter
  views (named, persisted in localStorage and shareable via a `view=` URL hash that
  encodes only filter knobs -- never `external_id`), and a per-operator skills
  checklist overlay that walks a new operator through keyboard triage / `Mine` /
  draft release once, keyed to the selected operator id.
- **A team is paged when nobody is covering, not just per case**: the health sweep
  runs `detectCoverageGap` each pass -- a rostered team with open breaching cases
  yet zero operator replies in the window is a coverage gap. It pages once on the
  rising edge via the same `CASEY_ALERT_WEBHOOK` path with a synthetic
  `{ ref: 'TEAM-COVERAGE' }` (no `external_id`), clears on the falling edge, and
  counts replies only on the breaching cases so a busy day on unrelated cases does
  not mask the gap.
- **The inbox carries an SLA clock, not just an order**: `rankAttention` stamps
  each waiting case with `waitAgeMs` against `slaTargetMs` and surfaces
  `atRiskCount` (and `/api/attention` exposes `wait_ms`/`at_risk`/`sla_target_ms`),
  so an operator sees not only worst-first order but how close each case is to
  breaching its reply target.
- **Management aggregates are exportable as structured JSON and an audit trail, not
  just CSV/HTML**: `/api/report.json` returns the same briefing as `/api/report.csv`
  plus three analytics the flat briefing never carried -- SLA compliance pass/fail
  (`buildSLAReport`: met vs answered-late vs never-answered against the live handoff
  SLA), period-over-period comparison (`buildReportComparison`: this window vs the
  prior adjacent window, signed deltas), and per-intake-channel response speed
  (`buildChannelMetrics`). `/api/audit.csv` is a compliance trail -- one row per
  event over a `?days` window joined to its case ref -- built off the same
  append-only event log via `evData()`. Both are aggregate-only and NEVER emit
  `external_id`: the audit export scrubs any cell equal to a case's external_id
  (so a delivered-reply event whose `data.to` is the contact id cannot leak a phone
  number into a compliance file).
- **`case_type` is a live management lens, not just a tag**: `case_type`
  (outbreak/follow_up/lab_sample/import_alert, default unset) segments every
  aggregate. `/api/report.json` carries `sla_by_type` (`buildSLAReportByType`:
  per-type SLA compliance with an `overall` that reconciles) and `by_case_type`
  (`buildCaseTypeMetrics`: median first-response, opened/closed, closed_pct,
  reopen_count). `GET /api/sla-at-risk/by-type` slices open cases by type against the
  live `resolveThresholds().handoffMs` so an operator sees which category is closest
  to breaching. `PATCH /api/cases/:id` accepts `case_type` (enum-validated) and
  records a distinct `case_type a -> b` action event so every per-type analytic can
  trace when and by whom a case was reclassified -- the dashboard case editor wires
  this as an editable Case type select (the change sends `case_type` on PATCH) and a
  "By case type" report panel renders the per-type SLA compliance. `casey report [--json]` renders the
  same per-type/per-channel briefing on the command line. A breach pages with a
  structured `buildAlertPayload` (case_ref/case_type/breach_type/severity_tier/
  since_ms) so an external pager can route an outbreak differently from a follow_up.
  All aggregate-only, NEVER `external_id`.
- **Event `data` is parsed at the read edge, never assumed an object**: thatcher
  returns `event.data` as a JSON string; parse before reading `data.*`. Shared parser
  is `overview.js evData()`; dashboard parses at `/api/cases/:id`+`/events`
  (`parseEventData`). (Details in recall.)
- **Assisted mode actually holds the reply**: an `assisted` case does NOT auto-send.
  The agent's reply is recorded as a `draft-pending` draft and waits for an operator
  to release it (`/draft/approve`, with edits) or discard it; an unsent draft past
  its window surfaces in the inbox as its own breach. `assisted` is a real gate on
  delivery, not a label -- only `auto` sends without a human.
- **The inbox classifier reads live thresholds**: the attention ranking and the
  periodic health sweep both classify against `store.resolveThresholds()`, so a
  team that retunes a window via `PUT /api/thresholds` changes detection
  immediately, with no restart and no drift from the shipped defaults.

## Security invariants (do not regress)

- WhatsApp inbound is HMAC-SHA256 verified when `WHATSAPP_APP_SECRET` is set.
  `WHATSAPP_APP_SECRET` is required when WhatsApp credentials are configured;
  `casey up` and `casey doctor` both hard-fail without it.
- Dashboard API + page gate on `CASEY_DASHBOARD_TOKEN` when set. Token accepted
  via `Authorization: Bearer` header or `X-Casey-Token` header. Query param
  `?token=` is allowed ONLY on the initial page-load GET / (the client strips it
  immediately and switches to header for all subsequent API calls).
- All contact-supplied text is HTML-escaped before render.
- Token comparison uses `crypto.timingSafeEqual` to prevent timing oracles.

## thatcher shim caveat

casey depends on the published thatcher npm package. Four upstream correctness
bugs were fixed in the thatcher fork; until that fixed release is on npm, casey
keeps small compatibility shims in `case-store.js` (`_createReload`, a parsed-graph
transition validator, and a `&system_fields` config anchor). Remove the shims once
casey depends on the fixed thatcher release. See README "thatcher" section.

## Conventions

- ASCII only in source and docs -- no arrow/box/bullet/check glyphs or emoji
  (use `->`, `-`, `[x]`/`[ ]`, words). Code operators are exempt.
- ES modules (`"type": "module"`), Node >= 22.
- The single end-to-end `test.js` against real services is the test surface;
  do not add a parallel mock-heavy unit suite.
- thatcher's sqlite handle is cwd-bound (primes `getDatabase()` from `<cwd>/data/app.db`
  at init; re-importing the accessor forks a second handle). Relocate only via process
  cwd: `test.js` copies the config to a temp dir and `chdir`s there so a run never wipes
  a live `casey up` store, with freddie `file:../` imports anchored to `REPO_ROOT`.

@.gm/next-step.md
