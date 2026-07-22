# AGENTS.md

Operating notes for agents (and humans) working in the casey repo. This file is
included by `CLAUDE.md` via `@AGENTS.md`; keep it accurate against `README.md`
and the source.

## What casey is

casey is a thin orchestrator for **animal-disease surveillance in rural South
Africa**. Anyone messaging over WhatsApp/Discord is a **reporter**; a reporter
reports sick or dead livestock in their own language and casey gathers a
structured report warmly and without interrogation, giving the organising team
one observable, editable view per report. A reporter defaults to the
**reporter tier** (casual, public, report-only). An operator may promote a
trusted reporter to the **field_worker tier**, which additionally unlocks
agentic case-query access (their own open cases, "near me" lookups, place
enquiries) and casual location check-ins so they show up on the operator map
for direction/dispatch -- see `contact.tier` under Design principles. Times are
shown in SAST and phone numbers in +27 format (both configurable via
`CASEY_TZ`/`CASEY_COUNTRY_CODE` for a non-SA deployment). casey amplifies the
team's workflow -- it does not impose disease rules or escalation; priority
stays with people.

## Architecture

casey composes three existing projects and owns only the glue:

| Layer | Project | Role |
|-------|---------|------|
| Agent + channels | `freddie` (npm `latest`) | Agent harness + Gateway with WhatsApp/Discord adapters, tools, sessions. |
| System of record | `thatcher` (npm `latest`, which deps `busybase` from the registry) | Config-driven CRUD + workflow + RBAC + audit. Holds `case` / `event` / `contact` and the lifecycle state machine. |
| UI | `anentrypoint-design` (`file:../anentrypoint-design`) | webjsx + ripple-ui design system theming the dashboard. |
| Conversation state | `adaptogen` (`file:../dstate`) | An AGENT-OWNED soft FSM (greeting/gathering/enquiring/answering/complete/handoff/closed). The LLM DECLARES its phase via `case_stage`; casey applies the dstate `transition()` and feeds `orient()` (current phase + legal next moves) into the prompt so the model keeps its place across turns. Durable per-case (the `conv_state` blob on the case row). Degrades to no-op when absent -- the raw report in the prompt still drives. |

Inbound flow: channel message -> freddie Gateway -> casey case handler (replaces
`handleInbound`) -> find/create thatcher case (locked, deduped by message id) ->
one runTurn tool loop where the agent classifies + extracts + routes + answers via
the `case_*` tools -> reply, with a warm fallback when the model errors/empties.
Every inbound/outbound/observation/action/transition is an append-only `event` row.
The dashboard reads/edits thatcher over its API.

**Layering mandate: agentic harness -> freddie, CRM code -> thatcher, casey is
setup + configuration.** freddie owns the agent harness (runTurn tool loop, plugin
host, and the acptoapi bridge) and threads `tool_choice` (e.g. `'required'`) through
runTurn -> machine -> the bridge -- a plain value applies on ITERATION 0 ONLY
(then model choice) so a forced first tool call can never make loop termination
unreachable; casey's handler passes `tool_choice: 'required'` to nudge a weak
model into its first classify/record call, and casey's llm.js wrappers pass the
request through whole (never destructure-and-drop params). The bridge's
coder-agent cwd note ("use Bash/Read/Write") is OPT-IN via an explicit `cwd`
param -- it must never leak into a contact-facing agent's prompt.

**pi tool surface (70 tools) -- what casey uses and the deliberate exclusions.**
freddie's `pi` host exposes ~70 tools (witnessed via `bootHost().pi.tools.list()`).
casey's CONTACT-FACING agent turn enables `enabledToolsets: ['cases']` ONLY -- so
the agent reaches nothing but casey's own `case_*` tools. Separately, casey's own
DETERMINISTIC code (never the agent) dispatches three `creative`-toolset pi tools
by name to enrich a case: `transcription` (inbound voice note -> text,
`CASEY_TRANSCRIBE_VOICE_NOTES`), `vision` (inbound photo -> animal-health
description, `CASEY_DESCRIBE_PHOTOS`), and `tts` (outbound reply -> spoken voice
note, `CASEY_VOICE_REPLIES`). These three are the mission-aligned media abilities;
each is opt-in, key-gated, and fail-open. The rest of the pi surface is
DELIBERATELY excluded, and the exclusion is a decision, not an oversight:
`bash`/`read`/`write`/`edit`/`grep`/`browser`/`terminal`/`delegate`/`skill*` and
the other coder-agent tools are forbidden to a contact-facing agent by the security
invariant (never in `enabledToolsets`, never dispatched by casey for a contact);
`web_search`/`web_fetch` are excluded because they violate the no-lookup /
agent-uses-its-own-world-knowledge mandate (casey never geocodes or looks anything
up on the model's behalf). If a future pi tool is genuinely mission-aligned it is
added the same way the three media tools were: casey deterministic code dispatching
it by name, opt-in and fail-open, never widened into the agent's toolset.

casey registers its OWN case toolset
(`plugins/case-tools/plugin.js` -> `src/case-tools.js`, discovered by
`bootHost([CASEY_PLUGINS])`) into that host. freddie's own former reference case
toolset at `src/plugins/case/` (which never had a `plugin.js` and sat outside
freddie's `plugins/` discovery root, so it was never actually loaded by any boot
path) has since been removed from freddie entirely -- casey's toolset is now the
only one that exists, not merely the only one that runs. The agent acts entirely through
these tools -- `case_report` (extract report fields), `case_list` (a `location` param
matching a place token against the report location; there is NO province->town
gazetteer, so a literal-location match, and the rows are the PII-free `enquiryRow`,
never the full report), `case_get` (status body, `slimCase`), `case_mine` /
`case_today` (the worker's OWN open cases, scoped by `ctx.author` via the `row_access`
owner field, PII-free), `case_new` (open + bind a fresh active case), and `case_stop`
/ `case_handoff` (the agent acting on opt-out/handoff). Handlers receive the per-turn
`toolCtx` as the second argument.
This is application-agnostic -- the store, the field/enum/projection vocabulary, and
the role model arrive via a per-turn `toolCtx` and `plugins.case` config. CRM
querying lives in thatcher (consumed via npm `latest`; thatcher deps
`busybase ^1.0.2` from the registry -- see the sibling-chain section): `list()`
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
number. casey's `case-store.js listCases` calls thatcher's operator-where
(`$gte`/`$lte`/`$in`/`$or`) directly, with no runtime feature-detect -- casey
consumes thatcher exclusively via npm `latest`, which has carried operator-where
since v1.0.30, so a pre-support thatcher can never be installed.

## Source map

```
thatcher.config.yml        entities + case workflow (system of record)
bin/casey.js               CLI: init / doctor / up / dashboard / cases / show / report (per-case-type SLA + per-type/per-channel metrics, --json)
plugins/case-tools/        freddie plugin registering case_* tools (auto-discovered)
src/
  casey.js                 top-level assembly: store + host + gateway + adapters + logger; drainQueuedTurns re-drives LLM-down-queued inbounds through the agent on provider recovery (status-gated, oldest-first serialized, mark-attempted only after a successful drive, bounded retry -> dead-letter)
  case-store.js            thatcher wrapper: find-or-create (locked), events, transitions, paging, config validation, SQLITE_BUSY retry proxy, operator_identity learning, optimistic-lock report merge, append-only media fields, no server-side geocoding (full caveat detail: recall "case-store.js caveats")
  case-runtime.js          process singleton so the plugin reaches the live CaseStore
  case-tools.js            case_* tool defs registered into the host: get/list(PII-free enquiryRow + location filter)/update/report/observe/transition + the worker-enquiry surface case_mine/case_today (own open cases, scoped by ctx.author via the row_access owner field, PII-free) / case_new (open+bind a fresh active case) / case_checkin (field-worker casual own-location self-report, distinct from a case's lat/lon) / case_stop / case_handoff; autonomy-enforced. Handlers read the per-turn toolCtx as the 2nd arg (freddie invokes handler(args, ctx)). Every tool except case_report/case_stage/case_stop/case_handoff is wrapped by gateByTier, refusing a ctx.tier !== 'field_worker' caller -- casey's own reporter-vs-field_worker access-tier enforcement point. case_update carries case_type (agent-settable classification, validated against the live config-declared enum via store().getFieldEnum('case.case_type', ...) -- thatcher's own config-declared enum is NOT enforced server-side on write, so the tool validates before every write, matching the dashboard's own check) and priority (same getFieldEnum('case.priority', ...) guard). case_report carries lat/lon: the AGENT's own estimate (its own world knowledge for a described place, or the worker's exact GPS when given), validated finite/in-range only -- no lookup table, no server-side geocoding of any kind
  dashboard/auth.js        per-operator login: scrypt password hashing, stateless HMAC-signed session cookies (no server-side session table), operator_account CRUD (createAccount/listAccounts/setAccountDisabled/deleteAccount), ensureBootstrapAdmin (auto-creates a single admin account with a random printed password on a fresh deployment with zero accounts)
  case-machine.js          xstate case lifecycle machine
  case-health.js           per-case health/guardrail signals
  case-sweep.js            periodic health-guardrail sweep; detectCoverageGap (rostered team, open breaching cases, zero in-window operator replies) pages a synthetic TEAM-COVERAGE breach
  correlate.js             cross-case correlation helpers
  attn.js                  worst-first attention ranking (rankAttention, with an SLA clock: waitingOnUs/waitAgeMs/atRiskCount/slaTargetMs) + shared caseHints why/to-do policy; backs the inbox and `casey attention`
  format.js                shared SAST timestamp + +27 phone formatters (CLI and SPA render the same way)
  thresholds.js            pure validate/clamp/merge of operator-tunable health thresholds (allowlist keys + bounds)
  overview.js              KPI aggregates over the event log (time-to-first-reply, dwell-per-stage, backlog) for /api/overview; exports shared evData() event.data parser
  workload.js              per-operator workload rollup (open/stale-claims/replies-24h/first-reply-median/oldest-waiting, worst-first) for /api/operators/workload; aggregate-only
  clusters.js              correlated-case components (shared location/species) for /api/clusters; clusterSeverity ranks suspected outbreaks by member count scaled by case_type mix (outbreak>import_alert>lab_sample>follow_up), severity-desc sorted
  geo.js                   hotspots-by-area rollup for /api/geo
  report.js                management report rendering (CSV/HTML) for /api/report.csv and /api/report.html; composes buildWorkload into a per-operator by_operator section (aggregate-only, no external_id)
  report-analytics.js      pure management analytics for /api/report.json: buildSLAReport (pass/fail vs the live handoff SLA, answered-late vs never-answered), buildSLAReportByType (the same compliance partitioned by case_type, with an `overall` that reconciles), buildReportComparison (this window vs the prior adjacent window, signed deltas), buildChannelMetrics + buildCaseTypeMetrics (shared rollupByKey: first-response median, opened/closed, closed_pct, reopen_count per channel / per case_type), buildAlertPayload (structured machine-parseable breach payload for an external pager: case_ref/case_type/breach_type/severity_tier/since_ms, NEVER external_id); all aggregate-only, no external_id
  conversation-spec.js     the agent-driven dstate conversation machine as a plan() spec (soft-FSM nodes greeting/gathering/enquiring/answering/complete/handoff/closed; soft intake edges, enforcement:off for the irreversible handoff/closed; an intake zone)
  conversation-state.js    per-case dstate wrapper: optional-imports adaptogen (degrades to no-op), rehydrates/creates a per-case DState from the conv_state blob (export/importState), advanceCase(to) applies a transition + persists, orientCase() returns {state, legalMoves} for the prompt; advance only on a completed turn, only to the phase the AGENT declared
  gateway-hooks.js/hooks/handler.js   makeCaseHandler PURE-LLM flow: an inbound hits the STOP/HUMAN deterministic short-circuit (detectContactIntent, above the queue gate), OR the LLM-down queue gate (record a QUEUED-FOR-AGENT marker, send nothing, log loud), OR one runTurn tool loop where the agent classifies + routes + answers + RECORDS THE REPORT (case_report) + declares its phase (case_stage) via the case_* tools. casey does NO deterministic text processing -- no field extraction, no computed next-question. The prompt surfaces the raw report-so-far + the dstate phase (orient) and TRUSTS the model to acknowledge + not repeat + ask the next thing. GUARANTEED-RESPONSE FSM: a LIVE first-attempt turn (never a background resume/queue re-drive, which stays silent on degrade) shows a typing indicator for its duration and, if still degraded once the bounded retry budget (CASEY_TURN_HARD_DEADLINE_MS) is exhausted, sends a truthful status fallback message instead of silence -- see the no-mocks-fallbacks-stubs design principle's own "deliberate, scoped evolution" note for why this is not a reversal of that principle. dedup, media, observe
  llm.js                   model call wiring; resolveCallLLM (boot precedence: acptoapi/null) + makeResilientCallLLM (self-healing backend that re-resolves a recovered provider, single live status() for the health row, and fires an onRecover edge that drives drainQueuedTurns)
  dashboard/server.js      express API + anentrypoint-design SPA (observe/edit/override/reply); GET/POST /report public contact form (no login); GET /api/map/cases (PII-free pins with resolved lat/lon, cluster membership, unresolved bucket, capped+truncation-reported), GET /api/operators/identities (learned per-operator working-area coverage), and GET /api/map/workers (field_worker-tier contacts' case_checkin self-reports, staleness-flagged) back the dashboard's Leaflet+OSM map view (status-colored markers, marker clustering via leaflet.markercluster, outbreak-cluster link overlay, operator-coverage overlay, field-worker location overlay, species/type/status/date filters, click-through to case detail) -- all session-gated like every other /api route; /vendor/leaflet and /vendor/leaflet.markercluster serve the map's static JS/CSS, exempted from the auth gate the same way /design already is (static UI assets, no case data). GET/POST /api/contacts(/:id/tier) and the Reporters panel are the operator-facing surface for the reporter/field_worker access-tier system (see AGENTS.md's contact.tier design principle); GET/POST/DELETE /api/accounts (admin-only) manage operator login accounts. Auth is per-operator username/password login (dashboard/auth.js), not a shared bearer token.
```

There is no automated test suite. Verification is manual/live: run `casey up`
against real freddie/thatcher/a real LLM provider and exercise the actual
conversation over Discord/WhatsApp or the dashboard.

## Dev workflow

```sh
npm install                 # freddie/thatcher resolve from npm (latest); requires sibling ../anentrypoint-design checkout
node bin/casey.js init      # scaffold a .env (channel tokens, dashboard secret)
node bin/casey.js doctor    # green/red preflight: deps, channels, port, token
node bin/casey.js up        # gateway + dashboard (default http://localhost:4000)
npm run lint                # dependency-free preflight (syntax+config+package+ascii); the CI gate
```

CI: `.github/workflows/ci.yml` runs `npm run lint` (`scripts/lint.mjs`) on every
push and PR. It is dependency-free on purpose -- it does NOT need the
`anentrypoint-design` sibling, so it stays green in a bare clone. It carries a
pure-llm grep-gate: `gateway-hooks.js` and `casey.js` must NOT import `intent.js`,
`places.js`, or `extract.js` (all deleted -- casey does no deterministic text
processing; the LLM records the report via `case_report`), and a no-stub-mock
grep-gate (`src/`, `bin/`, `plugins/` must never reference `MockAdapter`, `stubLLM`,
`CASEY_STUB_LLM`, or the deleted `sim/*` modules).

Note: `freddie` and `thatcher` are npm `latest` dependencies (ALWAYS the newest
published version, never pinned and never a local `file:../` sibling) -- a local
fix to either now requires a push to its own repo's `master` (both auto-publish
on push) before `npm install` in casey picks it up; there is no more instant
local-edit-to-live-box loop. `anentrypoint-design` remains a `file:../` sibling
(dashboard UI, unaffected). Without the `../anentrypoint-design` checkout
installed, `casey up` fails with `ERR_MODULE_NOT_FOUND`; only static review is
possible in a clone that lacks it. The dependency-free CI lint and a bare clone
stay green regardless.

## Environment

| Variable | Purpose |
|----------|---------|
| `DISCORD_BOT_TOKEN` | Enable Discord (gateway WebSocket receive with RESUME). |
| `WHATSAPP_API_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Enable WhatsApp (Meta Graph send). |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification handshake token. |
| `WHATSAPP_APP_SECRET` | When set, inbound webhooks are HMAC-SHA256 verified; forged posts rejected. |
| `WHATSAPP_WEBHOOK_PORT`, `WHATSAPP_WEBHOOK_PATH` | Fixed webhook port/path for a stable public URL. |
| `CASEY_SESSION_SECRET` | HMAC key for signing dashboard session cookies (`dashboard/auth.js`). Random per process start when unset, so a restart invalidates every session (an operator simply logs in again) -- set explicitly for sessions to survive a restart. |
| `CASEY_COOKIE_SECURE=0` | Drop the `Secure` flag on the session cookie (`dashboard/auth.js`), for a plain-HTTP dev/LAN deployment with no TLS. `Secure` is ON by default. |
| `CASEY_PUBLIC_URL` | When set, the agent includes a `{CASEY_PUBLIC_URL}/report?ref={ref}` link in the first contact message. The `/report` page is a public (no-token) contact-facing form where contacts can fill in case details directly. |
| `CASEY_ALERT_WEBHOOK` | When set, a high-severity health breach (unanswered handoff, and the escalated tier) POSTs a plain JSON alert to this URL so a team is paged off-dashboard. Each newly-entered breach pages once; an already-flagged case is not re-paged. |
| `CASEY_ESCALATE_WEBHOOK` | Distinct endpoint for the `unanswered_handoff_escalated` breach tier only (casey.js `ESCALATION_BREACHES`) -- lets a deployment route "still no reply after the escalation window" to a different on-call channel (e.g. a supervisor) than routine breaches. Falls back to `CASEY_ALERT_WEBHOOK` when unset, so escalation is never silently dropped. Routing is by breach TIER only, not by `case_type`/severity_tier -- `buildAlertPayload`'s `case_type`/`severity_tier` fields are in every payload sent to whichever URL is picked, so a deployment wanting outbreak-vs-follow_up routing can branch on those fields downstream (or extend `ESCALATION_BREACHES`-style routing with a `case_type`-keyed webhook map, following the same pattern). |
| `CASEY_OPERATORS` | Roster used ONLY by `casey.js`'s team-coverage-gap check (`_checkCoverageGap`, re-read every health-sweep pass) to know how many people are EXPECTED to be covering, comma-separated `id:Name` pairs. Superseded everywhere else by the real `operator_account` table: `GET /api/operators` (dashboard) lists the actual accounts and the acting operator is derived from the authenticated session (`actingOperator(req)`), never this env var or a header -- this variable's only remaining live use is the coverage-gap headcount. |
| `CASEY_LOG=silent` | Silence structured JSON logs (used by tests). |
| `CASEY_LLM_MODEL` | Override the model requested from the acptoapi bridge (default `claude/sonnet` -- chosen over a cheaper tier because casey's turn is multi-step extraction + tool orchestration + tone-sensitive reply composition, where a weaker model has repeatedly dropped tool calls or repeated questions). Set to a cheaper tier for cost-sensitive deployments. |
| `CASEY_TZ` | IANA timezone name (e.g. `Africa/Lagos`) casey displays absolute times in (CLI and dashboard both, via `format.js`/`GET /api/config`). Default `Africa/Johannesburg` (SAST) -- casey's shipped design is a South African deployment, but this lets the same architecture serve a deployment elsewhere. |
| `CASEY_TZ_LABEL` | Suffix appended after a formatted time (default `SAST`; blank when `CASEY_TZ` is set without an explicit label, so a non-SA deployment doesn't show a misleading "SAST"). |
| `CASEY_COUNTRY_CODE` | Country calling code (digits only, e.g. `234`) casey's phone-number formatter matches/displays. Default `27` (South Africa). Digit-grouping stays SA-shaped (2-3-4) regardless of the code -- a fully correct international formatter needs a per-country grouping table, out of scope. |
| `CASEY_TRANSCRIBE_VOICE_NOTES=1` | Opt-in: automatically transcribe an inbound voice note (via freddie's `transcription` tool, an acptoapi Whisper passthrough) and fold the transcript into the recorded `audio` report field, alongside the saved media path. Requires `OPENAI_API_KEY`. Off by default -- sending audio bytes to an external transcription API is a real data-egress point a deployment should opt into deliberately. When unset, unavailable, or the request fails, degrades silently to the original operator-listens note (never blocks the reply path). |
| `CASEY_DESCRIBE_PHOTOS=1` | Opt-in: automatically describe an inbound animal photo (via freddie's `vision` tool, an acptoapi multimodal chat-completion passthrough) and fold the description (visible symptoms/species/count, framed for animal health, no diagnosis) into the recorded `photos` report field, alongside the saved media path. Requires `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Off by default -- sending image bytes to an external vision API is a real data-egress point a deployment should opt into deliberately. When unset, unavailable, or the request fails, degrades silently to the original operator-opens-the-photo note (never blocks the reply path). |
| `CASEY_VOICE_REPLIES=1` | Opt-in: automatically SPEAK the agent's text reply back as a voice note (via freddie's `tts` tool, an acptoapi `/v1/audio/speech` OpenAI/ElevenLabs passthrough) and deliver it alongside the text. The exact mirror of `CASEY_TRANSCRIBE_VOICE_NOTES` on the outbound side -- the single most under-served contact is the rural reporter who sends a voice note but struggles to READ a text reply, so speaking the reply in their own words closes that gap. Requires `OPENAI_API_KEY` or `ELEVENLABS_API_KEY`. Off by default -- sending the reply text to an external TTS API is a real data-egress point a deployment should opt into deliberately. Additive and fail-open: `synthesizeVoice` runs AFTER the degraded/blanked-reply gate (a turn that correctly sent nothing never speaks), the text ALWAYS sends, the spoken text is length-capped to bound cost, and any absence/failure degrades silently to text-only (never blocks the reply path). Delivery rides freddie's adapter `reply.audio` field (WhatsApp audio message / Discord file attachment); a channel or freddie build without audio-send degrades to text. |
| `CASEY_RELOAD=0` | Disable hot-reload (the supervisor still restarts on crash; it just stops watching source). |
| `CASEY_RELOAD_PATHS` | Comma-separated extra dirs to watch for reload (e.g. `../freddie/src`). `src/` and a sibling `../freddie/src` are watched by default; absent dirs are skipped with a warning. Allowlist only -- never contact input. |
| `CASEY_RELOAD_DEBOUNCE_MS` | Coalesce a burst of saves into one reload (default 300). |
| `CASEY_AUTO_UPDATE=0` | Auto-deploy (fetch + `merge --ff-only @{u}` on an interval) is ON by default in `casey up` so a push to origin reloads the live worker with no manual restart; set `0` (or `casey up --no-auto-update`) to disable the origin poll (an offline box, or to pin code). Safe on a dev checkout -- a dirty/divergent tree skips the fast-forward, never clobbered. |
| `CASEY_AUTO_UPDATE_INTERVAL_MS` | How often the auto-deploy loop fetches origin (default 60000). |
| `CASEY_DRAIN_DEADLINE_MS` | How long a reloading worker may finish in-flight turns before it is killed (default 15000). |
| `CASEY_CRASH_WINDOW_MS`, `CASEY_CRASH_LIMIT` | Crash budget: more than `LIMIT` crashes within `WINDOW` ms stops the restart loop instead of thrashing (defaults 60000 / 5). |
| `CASEY_RESTART_BACKOFF_MS`, `CASEY_RESTART_BACKOFF_CEIL_MS` | Restart backoff base and ceiling (defaults 500 / 10000). |
| `CASEY_RESUME_MAX_REDRIVES` | Cap on how many stuck cases the boot-time `resumePendingTurns` sweep re-drives in one pass (default 10). Each re-drive walks the same live provider chain a fresh inbound message would; live-witnessed a heavy-testing boot with many stuck cases starving a genuinely new contact's message by exhausting every configured provider's rate limit before the fresh turn ever got a fair shot. A high natural stuck-case count is itself a symptom (heavy restart/testing churn), not something worth burning through in one burst. |
| `CASEY_RESUME_SPACING_MS` | Delay between each resume re-drive within one sweep (default 2000), so the sweep never fires as one synchronized burst against the same rate-limited providers live traffic needs. The first re-drive of a sweep always fires immediately (nothing to wait behind). |
| `CASEY_RECEIVE_SILENCE_MS` | Zombie-receive self-heal: a channel that was receiving then went silent longer than this is treated as a wedged gateway and restarted. Default 0 = OFF (a quiet day is indistinguishable from a wedge by silence alone). |
| `CASEY_DRAIN_POLL_INTERVAL_MS` | Background poll driving `drainQueuedTurns` (default 60000; `0` disables it). `drainQueuedTurns` was previously only reachable via the resilient brain's `onRecover` edge (itself only fired by a real `callLLM`/`status()` call -- a NEW inbound on the SAME conversation, or a human loading the dashboard health row) or the boot-time `resumePendingTurns` sweep (which deliberately skips a case already tagged `resume-exhausted`). Live-witnessed: a real contact's message queued during a genuine LLM outage stayed queued with no reply long after the backend had fully recovered, because nothing in the running process was polling `status()` in the background and the contact -- naturally -- never sent a second message while waiting. This timer is that missing background poll, deliberately much shorter than `sweepIntervalMs`'s 15-minute default since it directly gates how long a real contact is left in silence; `drainQueuedTurns` is a cheap no-op scan when nothing is queued. |
| `CASEY_LLM_TURN_TIMEOUT_MS` | Per-attempt agent-turn timeout passed to freddie's `runTurn` (default 120000). For a LIVE first-attempt turn this is additionally capped by the remaining `CASEY_TURN_HARD_DEADLINE_MS` budget for that turn (see the guaranteed-response FSM below); a background resume/queue re-drive uses this value unbounded by that budget. |
| `CASEY_TURN_HARD_DEADLINE_MS` | Guaranteed-response FSM (`hooks/handler.js`): the total wall-clock budget (default 60000) a LIVE first-attempt turn's retry loop may spend before the turn is closed out with a guaranteed fallback message instead of continuing to retry. Each individual attempt still gets to run its own bounded provider-chain walk (acptoapi's `DEFAULT_LINK_TIMEOUT_MS`, 20s per hop) to real completion rather than being cut off mid-hop -- a retry that starts with real remaining budget gets a genuine chance. Never applies to a background resume/queue re-drive. |
| `CASEY_TURN_SOFT_DEADLINE_MS` | Guaranteed-response FSM: not a second timeout gate, only picks which of the two fallback strings to send once the hard deadline closes out a degraded turn -- under this elapsed time (default 25000) sends the "still working, one moment" text; at or past it sends the more honest "having trouble" text, since the contact has already been waiting a while by then. |

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
- Auto-deploy on push (DEFAULT ON): `casey up` runs an origin-poll loop in the
  supervisor parent -- `git fetch --quiet origin` + `git merge --ff-only @{u}` every
  interval (`CASEY_AUTO_UPDATE_INTERVAL_MS`, default 60000). A push to origin lands on
  the live instance with NO manual restart: the fast-forward rewrites `src/*.js` whose
  mtime the supervisor watches, so the worker reforks on the new code. (fetch+merge
  rather than `git pull --ff-only` because a bare pull fails with "Cannot fast-forward
  to multiple branches" when FETCH_HEAD carries several refs.) SAFE on a dev checkout:
  `merge --ff-only` REFUSES on a dirty or divergent tree and leaves the working tree
  untouched -- a dev with uncommitted edits or local commits just gets a quiet skip,
  never a clobber. Opt out with `casey up --no-auto-update` or `CASEY_AUTO_UPDATE=0`.
- Auto-reload on pull hooks (`hooks/`, armed via `postinstall`) also bumps
  `src/casey.js`'s mtime after a manual `git pull`/merge/checkout, belt-and-braces
  alongside the auto-deploy fast-forward -- see recall for the exact mechanics.
- Crash restart: a worker that exits non-zero is re-forked with exponential
  backoff, bounded by the crash budget so a boot-loop stops instead of thrashing.
  EXCEPTION: exit code 44 (dashboard port EADDRINUSE) is config-fatal -- retrying
  the same held port can never succeed, so the supervisor fails loud once
  ("port is already in use (another casey running?)") and degrades immediately,
  never a 5x re-fork storm.
- The watch list is a fixed allowlist (`src/`, `../freddie/src`, `CASEY_RELOAD_PATHS`),
  never derived from contact input; the fork takes an argv array, never an
  interpolated shell string. Run `casey up --no-reload` to watch nothing and
  `casey up --no-supervise` to run the worker in-process (no restart-on-crash).

## Design principles (preserve these)

- **Plain, warm language** to the contact: one idea per sentence, no internal
  jargon (case/triage/workflow/status/priority), mirror the contact's language,
  give a plain-words reference number on first contact.
- **No mocks, fallbacks, or stubs -- only singular working mechanisms and loud
  errors.** A degraded turn (empty/error/echo/stock-ack/repeat-of-last-outbound)
  never fabricates case CONTENT and never claims to have understood the report
  -- there is no scripted reply standing in for real comprehension
  (`fallbackReply` was removed by explicit user directive). The failure is
  logged loud (`log.error`) and recorded as an observation for operator
  visibility, never silently papered over. The reliability fix lives upstream:
  freddie's acptoapi bridge calls acptoapi in-process (no HTTP hop, no separate
  listening port, no crash-on-timeout failure mode) so the LLM call itself is
  the thing that must actually work, not a downstream apology for when it
  doesn't. The outbound scrubs still stay: a reply that parrots a system-prompt
  example verbatim (`isPromptEcho`), a stock acknowledgement (`isStockAck`),
  internal jargon (`jargonHits`), or a malformed reference
  (`sanitizeOutboundRef`) is caught before send -- caught means blanked/held,
  never replaced with fallback text.
  **Deliberate, scoped evolution (guaranteed-response FSM, `hooks/handler.js`):**
  a LIVE, first-attempt turn (never a background resume/queue re-drive, which
  stays silent on degrade exactly as before) that is STILL degraded after the
  bounded retry budget is exhausted now sends a TRUTHFUL STATUS message
  (`STILL_WORKING_TEXT` / `TURN_TIMEOUT_TEXT`) instead of pure silence -- this
  is not a reversal of the principle above, it is the same honesty discipline
  applied to the contact's WAIT, not their report: the message invents nothing
  about the case, claims no understanding of what was said, and states only
  the true fact that the system is still trying or has not managed to answer
  yet. A typing indicator (`adapter.startTyping`/`stopTyping`, Discord today;
  degrades silently on a channel with no typing concept) shows for the whole
  live-turn duration, and `CASEY_TURN_HARD_DEADLINE_MS` (default 60s) bounds
  the total retry budget so this fallback message is itself guaranteed to
  fire within a bounded time -- never an indefinite silent wait.
- **The reporter is usually a field worker relaying a farmer's animals, not the
  owner.** The person messaging is typically a field worker out on a visit,
  reporting livestock they have just come to see -- standing with the farmer, a
  relative, or a herder, out in the bush with limited info -- so they may not own
  the animals or have seen the problem start. `caseSystemPrompt` instructs the agent
  to ask only what the worker can SEE ("what can be seen in the animals") or RELAY
  ("how long the animals have been like this, from what the person says") -- NEVER
  "when you first noticed it". Worker-observable
  facts lead; the people-on-site facts (who is there and their link to the owner --
  owner/relative/herder/neighbour -- and the owner's name + a number, recorded as
  `present_person`/`present_person_relation`/`owner_name`/`owner_contact`) and the
  farmer-dependent history come after, framed as the person's account. (REPORT_KEYS
  in case-store.js carries these fields; the report itself is free-form JSON.)
- **The LLM records the report; casey does no field extraction.** The agent drives
  collection entirely by calling `case_report` -- there is NO deterministic capture
  floor (the user directive: get rid of hard coding so the LLM does its job). casey
  gives the model the raw report-so-far + the dstate phase and trusts it to record,
  acknowledge, and ask. The accepted trade-off: a fact the model fails to record via
  `case_report` has no deterministic net.
- **A case is keyed per CONTACT, not per channel; delivery target is separate.**
  `conversationKey` returns `container:author` when a channel/chat carries multiple
  authors (a Discord server channel) and the single id for a 1:1 chat -- so two
  workers in one channel get DISTINCT cases (a second author's message must not land
  on the first's case). The reply DELIVERY target is `replyTarget()` (the channel --
  Discord posts to `/channels/{channel}/messages`; an author id 404s), kept separate
  from the per-contact key: the key drives find-or-create, the in-flight lock, and
  dedup, while every `to:` is `replyTo`.
- **A complete report is not a dead-end.** When the report is complete the agent
  confirms it is on record and the team will follow up, AND invites a fresh report
  for any other animal or place -- never the "Thank you. Your reference is X"
  dead-end. A new substantive message then branches a new case (via `case_new` /
  find-or-create). Because the agent interprets each message, a question or enquiry
  from a "complete" case moves freely -- there is no state that traps the
  conversation.
- **Strike while the iron is hot: the on-site window is the only chance.** Once
  the worker leaves the animals, nothing more can be captured until someone
  manages to revisit the site -- so `caseSystemPrompt`'s single LAST-CHANCE PUSH
  instruction fires on any farewell-shaped cue (a thanks, a goodbye, in whatever
  language they wrote in) and explicitly names the VISIT_CRITICAL fields
  (`case-health.js`) so the agent's in-the-moment push and the health guardrail's
  hours-later `abandoned_intake` alert are aimed at the same target. The
  instruction explicitly fires BEFORE the agent declares `case_stage: complete`,
  not after, so the report is never closed out with an unexploited last chance
  still sitting there. Still never a list, never pushy -- one gentle ask, then let
  them go kindly if they do not give it. The guardrail thresholds themselves
  (hours-scale) stay unchanged: they exist as a post-hoc operator alert, not
  in-conversation urgency, and shrinking them would misfire on a legitimately
  slow-but-still-active conversation.
- **No worker-volunteered fact is ever silently discarded by casey's own storage
  layer.** `case_report`'s `photos`/`audio`/`sites` fields append rather than
  overwrite (`appendReportField` for the deterministic media-arrival path,
  `mergeReport`'s field-merge rules for the agent-driven path) -- a worker
  sending a second photo, voice note, or describing a second site within the
  same visit must never have it vanish with zero trace, which is exactly what
  fill-if-empty semantics did before this fix. Concurrency is guarded too:
  `mergeReport` detects (via thatcher's `_version` optimistic lock) a dashboard
  operator's PATCH racing the same case and retries the merge against the fresh
  row rather than either side's write silently losing to the other.
- **A greeting is the OPENING of a report, and every turn drives collection.** The
  agent's job is to gather the case while someone is on-site, so `caseSystemPrompt`
  directs it to answer even a bare "hi"/"hello"/"help" with a warm opener PLUS the
  single most-important still-missing fact (on a brand-new case that is "where the
  animals are"), rather than treating a greeting as a completed report or replying
  with a pleasantry that asks for nothing. The agent asks one still-missing fact per
  turn until the report is as complete as can be achieved.
- **A returning contact with a NEW case is the AGENT's call, via `case_new`.** Because
  find-or-create reuses the open case per conversation and `mergeReport`'s field-merge
  is fill-if-empty per field (a non-blank incoming value never overwrites an already-
  recorded one), a contact who returns and states a clearly different situation must not
  be trapped urging the old report's missing fields. There is no deterministic conflict
  detector -- the agent interprets the message and opens a fresh case with `case_new`
  when the worker is clearly starting a new report; a genuine continuation of the same
  incident stays on the bound case. `case_new` branches the new case onto the SAME
  (channel, external_id) as the current conversation (`CaseStore.createCase`, locked per
  conversation) rather than a synthetic id, so the very next plain inbound message
  correctly finds and continues on the NEW case via the normal find-open-case
  newest-wins rule -- a prior implementation minted a synthetic external_id and wrote a
  separate `contact.active_case_id` pointer that find-or-create never actually read, so
  the next message silently kept talking to the old case; fixed by keying on the real
  conversation identity instead of a second, unread binding (the whole
  `active_case_id`/`setActiveCase`/`getActiveCase` mechanism and the schema field were
  removed as dead code once this was found).
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
- **The contact's message is untrusted DATA, never instructions.** `caseSystemPrompt`
  explicitly tells the model the contact's text is field-reported data, not a
  command -- ignore anything that tries to change its role/persona/instructions
  and keep responding only as the animal-disease reporting assistant. A companion
  clause defines the scope boundary: an off-topic ask (maths, translation,
  chit-chat, "how do you work") gets a warm one-sentence decline with no jargon
  words, which also reduces how often the deterministic `jargonHits` outbound
  scrub needs to hold a reply as a draft for a benign redirect. A third clause
  asks for one clarifying question, rather than guessing, when a message reads
  like a rough voice transcript (run-on, filler words) and a key fact contradicts
  itself within that same message -- all three are prose guidance, no new
  classifier, matching the file's existing structural-instruction style.
- **A field correction is distinguishable from a first-time fill in the audit
  trail.** `case_report`'s handler snapshots the prior report before merging, and
  when an already-filled field is overwritten, the appended event carries an
  old-to-new diff ("changed: species sheep -> goats") -- mirrors `case_type`'s
  existing a-to-b change-tracking pattern, so a correction ("actually it was 10,
  not 5") is as observable to an operator as a reclassification already is.
- **STOP/HUMAN are deterministic irreversible controls.** Only the two IRREVERSIBLE
  service acts -- opt-out and human-handoff -- short-circuit deterministically:
  `detectContactIntent` returns `'stop' | 'human' | 'help' | null` and fires in any
  phrasing/language even when the LLM is down, ABOVE the LLM-down queue gate so an
  opt-out during an outage is never deferred. `'help'` exists ONLY as the opt-out
  ESCAPE HATCH: an opted-out contact who sends help/start/resume (multi-language)
  is opted back in deterministically (tag cleared, localized resume ack) -- the
  promised "reply HELP to resume" must work even with the model down. STOP_KEYS
  are narrow: bare ambiguous tokens (enough/cancel/genoeg...) were removed; only
  unambiguous opt-out words and explicit messaging-object phrases ("cancel
  messages", "yeka imilayezo") opt a contact out. Everything else (status,
  greeting, thanks, enquiry, report, extraction) is the agent's job.
  `normalizeIntentText` collapses immediate consecutive duplicate tokens before
  phrase/exclude matching -- a well-known ASR artifact ("stop stop messaging me")
  that would otherwise miss the exact-phrase match; the existing negator-guard
  logic is unaffected (a genuine double-negative like "dont dont stop stop" still
  correctly reads as NOT an opt-out after collapsing). A STOP that arrives packed
  with real report content is flagged (`STOP-WITH-CONTENT` observation +
  `needs-human`) for manual review -- the agent still never engages post-opt-out
  (correct), but the facts are made actionable for a human instead of resting
  silently in the append-only log.
- **A fast message burst is buffered and replayed, never silently dropped.** The
  per-contact in-flight concurrency guard (one LLM turn per contact at a time)
  used to skip a message that arrived mid-turn with no further consumer -- a
  quick multi-message burst lost every message but the one that won the race.
  `handleInbound` now wraps the core turn logic: a message that hits the guard is
  buffered (capped, oldest-dropped-logged) and, once the in-flight turn clears,
  replayed as one more full turn -- fire-and-forget, same shape as the existing
  LLM-down queue drain.
- **No deterministic text processing: the agent interprets and acts.** casey does no
  deterministic classification of a worker's meaning. The LLM agent interprets each
  message and drives the whole conversation by calling the `case_*` tools -- it
  distinguishes a worker ASKING about their work ("what's on today", "my cases",
  "any cases near <place>") from REPORTING an animal, and it answers each by calling
  the right tool. There is no keyword intent classifier, no intake ask-ladder, no
  deterministic field extraction, and no province->town gazetteer: place understanding
  is the model reading the place token and passing it to `case_list`'s `location` param
  ($ilike match), and the report is recorded by the model via `case_report`. The
  conversation soft-FSM (dstate) is AGENT-DRIVEN, not hard-coded -- the model declares
  its phase (`case_stage`) and casey just tracks it. The only deterministic layers are
  the STOP/HUMAN safety short-circuit and the outbound scrubs; on an LLM outage a
  message is queued and re-driven on recovery, never classified by a fallback.
- **Enquiries and status are PII-free.** A worker's enquiry ("my cases", "any cases
  in kzn") and a status ask ("status of CASE-1089") are answered by the agent via
  `case_mine` / `case_today` / `case_list` / `case_get` from the PII-free projection:
  a worker-role `case_get` returns the `enquiryRow` (no `external_id`/`contact_id`),
  so a phone number, operator identity, or another contact's free text can never
  surface to a field worker. A complete-report state can never trap an enquiry,
  because the agent -- not a state machine -- decides the reply each turn.
- **A reporter's access tier is operator-assigned, never self-service or
  LLM-settable, and fails closed.** `contact.tier` (`reporter` default,
  `field_worker` elevated) is set ONLY via the dashboard's Reporters panel
  (`POST /api/contacts/:id/tier`, any authed operator) or the CLI break-glass
  path (`casey operators` group, `dashboard/auth.js`) -- there is no
  `case_*` tool that touches it, so the agent can never promote a contact from
  inside a conversation no matter what the person says. `gateway-hooks.js`
  derives `toolCtx.tier` fresh from the contact's stored value every turn (no
  cross-turn caching), so a promotion/demotion takes effect on the NEXT
  message, never retroactively mid-turn. Any falsy/missing/unrecognised value
  (a pre-migration contact row, a corrupt value) resolves to the LOWER-
  privilege `reporter` tier -- the same fail-closed discipline `ownsCase`
  already uses for PII scoping. `case-tools.js`'s `gateByTier` wrapper gates
  every query/mutation tool (`case_list`, `case_get`, `case_mine`, `case_today`,
  `case_new`, `case_checkin`, `case_update`, `case_transition`, `case_merge`,
  `case_split`, `case_health`, `case_observe`, `case_link_suggestions`,
  `case_transitions_available`) behind `field_worker` tier; `case_report`,
  `case_stage`, `case_stop`, and `case_handoff` stay reachable at every tier
  (reporting and the two irreversible safety controls are not data access).
  `case_checkin` (lat/lon) records a field worker's own CURRENT location --
  distinct from `case.lat/lon`, a CASE's location -- surfaced on the
  dashboard's map as a live/stale-faded pin (`GET /api/map/workers`, staleness
  window `workerLocationStaleMs`, tunable like every other threshold) so a team
  can direct/dispatch them, and fed back into `caseSystemPrompt` as the default
  origin for a bare "anything near me" ask so a field worker is not asked to
  repeat where they are every time.
- **LLM-down queue + retry, never a fallback classification.** When the backend is
  down casey does NOT classify the message deterministically and does NOT send
  anything to the contact (no mocks/fallbacks/stubs invariant). The inbound is
  recorded, a `QUEUED-FOR-AGENT` marker is appended and the failure is logged loud,
  and the message is re-driven through the agent when the provider recovers.
  `makeResilientCallLLM` fires an `onRecover` edge and `casey.js drainQueuedTurns`
  drains the queue (status-gated, oldest-first serialized, mark-attempted only
  after a successful NON-DEGRADED drive -- a re-drive that is still degraded stays
  queued (queue-drive-retry, no duplicate outbound), bounded retry -> dead-letter).
  STOP/HUMAN still fire synchronously via the deterministic short-circuit ABOVE the
  queue gate, so an opt-out during an outage is never
  deferred.
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
- **Operator identity is learned, never asserted.** Operators act ONLY through the
  dashboard, identified by their AUTHENTICATED SESSION (`dashboard/auth.js`
  username/password login) -- `actingOperator(req)` derives identity from
  `req.caseyAccount`, the session the login flow set, never a client-supplied
  header. (An earlier design self-attested via an `X-Casey-Operator` header,
  cooperative attribution with no authentication; that header is retired --
  the per-operator login replaced it.) There is no path where a channel
  message is treated as an operator speaking as themselves. `learnOperatorActivity` builds a durable
  per-operator working-area profile (frequency-ranked location tokens from the
  cases they claim/transition/reply to/edit) from these dashboard-attributed
  actions, best-effort and fire-and-forget so learning can never slow or fail the
  real action it rides on. This is a coverage signal for the team (the map's
  operator-coverage overlay), never an auto-assignment: casey suggests visually,
  a human still claims.
- **The map is a visual rollup of data casey already stores, not a new source of
  truth.** `/api/map/cases` pins every case by `case.lat`/`lon` alone -- no lookup
  table, no server-side geocoding of any kind. The coordinate is entirely the
  AGENT's own: exact when the worker read out real GPS, otherwise the model's own
  best-effort estimate from its own world knowledge of the place described (see
  `caseSystemPrompt`) -- casey never hand-curates or looks anything up on the
  model's behalf. A case with no agent-provided coordinate is never dropped, it
  lands in an `unresolved` bucket the UI surfaces. Outbreak-cluster links reuse
  `clusters.js`'s existing correlation engine rather than a second grouping
  heuristic. Aggregate/PII-free like every other dashboard rollup -- no
  `external_id`, no owner/contact fields on a pin, only what an area-level map
  needs.
- **No hand-curated interpretation stand-ins; the agent prepares its own
  observability data.** `case_type` and `lat`/`lon` are agent-set via the normal
  case_* tool flow (no lookup table, no deterministic classifier), never left for
  an operator to fill in by hand. Only two deterministic layers are protected and
  are NOT stand-ins: the STOP/HUMAN safety keyword layer (must work with the LLM
  down) and case_type/priority storage-enum validation (post-judgment integrity
  guard). Full reasoning and the audited classification of every other list/table
  in `recall`.

## Security invariants (do not regress)

- WhatsApp inbound is HMAC-SHA256 verified when `WHATSAPP_APP_SECRET` is set.
  `WHATSAPP_APP_SECRET` is required when WhatsApp credentials are configured;
  `casey up` and `casey doctor` both hard-fail without it.
- Dashboard API + page gate on a logged-in session (`dashboard/auth.js` --
  username/password per operator_account, scrypt-hashed, stateless HMAC-signed
  session cookie). No route accepts a bearer token or a `?token=` query param
  any more; the only ungated routes are `/design`, `/vendor/*` (static UI
  assets, no case data), `/api/login`, `/api/logout`, `/api/whoami`, and the
  public `/report` contact form (gated by knowledge of a case ref, not auth).
  Admin-only routes (`/api/accounts*`) additionally require `role: 'admin'`.
- All contact-supplied text is HTML-escaped before render.
- Session-cookie and password comparisons use `crypto.timingSafeEqual` to
  prevent timing oracles (`dashboard/auth.js` `verifySession`/`verifyPassword`
  wrap `scrypt`, matching the discipline the old bearer-token gate used).

## thatcher / busybase chain

casey consumes thatcher via npm `latest` (never a `file:../` sibling, per the
user directive to always run freddie/thatcher off the registry) -- a local
thatcher fix requires a push to thatcher's `master` (CI publishes automatically)
before a fresh `npm install` in casey picks it up. npm publishing is RESTORED
(NPM_TOKEN set 2026-07-02): thatcher publishes from CI on push and deps
`busybase ^1.0.2` from the registry (1.0.2 is the floor; see recall for why).
Because casey is now ALWAYS effectively "a bare npm install" relative to
thatcher's published version (never ahead of it via a local checkout, never
behind v1.0.30 either since `latest` only moves forward), `case-store.js`
calls thatcher's operator-where directly with no runtime probe and no
equality-only JS fallback -- both were deleted once confirmed permanently
dead code against any install casey's own dependency policy can produce.
busybase's `src/*.js` are gitignored
bun-build outputs -- fixes go in the `.ts` sources and are rebuilt
(`npm run build` in the busybase repo, not a casey sibling). Timestamps
read back from busybase may be numeric-seconds STRINGS ("1782977388"): parse row
timestamps with the digit-string-aware helpers (attn.js tsMs / case-health.js ms
/ format.js toDate), never bare Date.parse.

## Provenance subsystem (src/core/, src/engine/, src/packs/)

An ADDITIVE ground-truth/provenance layer sits alongside casey's existing
thatcher-backed case/event architecture (untouched -- freddie, thatcher, and
anentrypoint-design are consumed exactly as documented above; nothing in this
section replaces or guts any of them). It exists to answer, for the new
subsystem's own data, a stricter question than the live agent conversation
alone can: for every value, WHO said it, HOW (observed/reported/measured/
inferred/unknown), and WHEN -- so a future aggregate/audit/export can never
blend a model guess into a ground-truth count.

**Provenance is a type, not a field.** `src/core/provenance.js`'s `mkValue`/
`mkUnknown` are the ONLY construction path for a provenanced value (frozen,
`__provenanced`-marked); `isProvenanced`/`requireProvenance` reject any bare
object literal shaped like one. Five kinds, ranked worst-to-best: `unknown <
inferred < reported < observed < measured`. `canReplace(current, incoming)`
enforces the no-silent-inference rule -- a lower-rank value can never
overwrite a higher-rank one (an agent's inferred lat/lon estimate can never
clobber a worker's real GPS reading).

**The Observation record (`src/core/observation.js`)** is the invariant
spine: subject / observer+role / location / onset+observed+reported+synced
(four DISTINCT timestamps, never conflated -- an unknowable onset date is a
first-class `mkUnknown()` value, never silently defaulted to observedAt) /
findings (provenanced per-field) / evidence (each entry requires an explicit
`present:boolean`, absence is a stated fact not a gap) / verificationTier
(unverified|field_confirmed|lab_confirmed, non-unverified requires
verifiedBy) / escalatedTo / packId+packVersion (schema-at-the-boundary: every
record is permanently stamped to the exact pack version that captured it) /
correctsId+correctionReason (a correction is a NEW Observation, never a
mutation -- `withSyncedAt` produces a new frozen object, the original is
untouched).

**Four physically separate tiers.** `src/core/raw-log.js` (RawLog) is TIER 1:
an append-only JSONL file per dataDir, write-once -- the class has no
update/delete method, so mutation is structurally absent, not merely
forbidden. `src/core/event-log.js` names this log the SYSTEM OF RECORD;
`rebuildProjection(log, fn)` is the literal "delete the aggregate store and
recompute" operation. `src/core/aggregate.js` is TIER 3: every function
(`countByFinding`, `drilldown`, `recency`, `withCoverage`, `sparseMark`) is a
PURE function of the raw log, proven via `assertPureRebuild`. TIER 4,
`src/core/interpretation.js`, is the ONLY place a model estimate may live --
`mkEstimate` requires an explicit `method`+`basedOnCount` and always carries
an "ESTIMATED ... not a ground-truth count" label; nothing in
core/aggregate.js can produce a shape `isEstimate()` would accept, so an
estimate can never be silently blended into a ground-truth query.

**The single write-path chokepoint** is `src/core/write-path.js`
`writeObservation(rawLog, params)` -- the ONE function every writer (a future
agent-turn integration, a dashboard correction, a sync reconciler) calls.
It re-derives the latest known value per field across the subject's prior
observations and rejects (returns in `rejectedFields`, never throws, never
silently drops the observation itself) any incoming finding that would
violate `canReplace`. A per-subject async lock (same pattern as
`case-store.js`'s own `_withLock`) serializes concurrent writers.

**Subject identity linking** (`src/core/subject.js`, `SubjectLinks`) is
separate from thatcher's own case entity: a case id doubles as the default
subjectId, and this module exists only for the harder problem of two
DIFFERENT cases turning out to describe the same real-world herd/site --
`link()` requires an explicit `linkedBy`+`reason` (never automatic/inferred),
persisted as a small JSON graph alongside the raw log.

**Config packs** (`src/core/pack-schema.js` validates, `src/core/pack-loader.js`
versions+migrates) are declarative data only -- subjectTypes, observationForms
(fields carry `unknownAllowed`, which CANNOT be set to `false`: a pack that
tries is rejected at validation, this is how "unknown is always reachable" is
structurally enforced rather than merely conventional), codelists, rules
(a bounded `eq|neq|gt|gte|lt|lte|in|notIn|and|or` vocabulary --
`validateRuleCondition` rejects a function or any op outside this list),
roles, views, strings. `src/packs/animal-health.js` ports casey's own domain
into this format as the first proof pack; `src/packs/water-point.js` (a
genuinely unrelated rural water-point inspection domain) is the second,
proving zero domain-specific code exists anywhere in `core/`/`engine/` --
both validate through the identical engine functions with no branching on
domain identity.

**The bounded rule evaluator** (`src/engine/rule-engine.js`) resolves a
pack's `rules` against a real Observation's findings (`evaluateRules`) and
reconciles multiple fired rules to a highest-severity/all-distinct-routes
result (`topEscalation`). An `unknown`-provenanced finding never satisfies a
threshold comparison. This is deliberately a pure evaluator with no side
effects -- the CALLER (casey's existing `case_handoff`/needs-human mechanism
in `case-tools.js`/`gateway-hooks.js`, untouched) decides what a fired rule's
`route` actually does.

**Trust-boundary enforcement**: `scripts/lint.mjs` carries a dependency-arrow
gate (`trust-boundary`) forbidding any `src/packs/*.js` file from importing
`src/core/` or `src/engine/` -- a pack must stay pure data, never code wearing
a config costume. Violating this fails `npm run lint` (and CI) with the
specific offending file+import spec named.

**What this subsystem does NOT yet do**: it is not wired into the live agent
conversation (`case-tools.js`'s `case_report` continues to write directly to
thatcher's `case.report` JSON blob exactly as before -- see
`expansion-write-path-existing-callsites` for the enumerated migration
targets a future session should wire through `writeObservation()` when the
live conversation is ready to also produce provenance-tagged Observations
alongside its existing report write). It has no offline-first field client
(casey's capture surface today is WhatsApp/Discord, inherently online); the
append-only-log-as-system-of-record design in this section is the contract a
future offline client would implement against, not yet a running client.

## Conventions

- ASCII only in source and docs -- no arrow/box/bullet/check glyphs or emoji
  (use `->`, `-`, `[x]`/`[ ]`, words). Code operators are exempt.
- ES modules (`"type": "module"`), Node >= 22.
- No automated test suite (removed by explicit user directive); verification
  is manual/live against a real running `casey up` instance. Do not add a
  test file or mock-heavy unit suite back in without explicit direction.
- thatcher's sqlite handle is cwd-bound (primes `getDatabase()` from `<cwd>/data/app.db`
  at init; re-importing the accessor forks a second handle).

@.gm/next-step.md
