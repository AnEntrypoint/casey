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
host, the acptoapi bridge, and a reference case toolset at
`freddie/src/plugins/case/`) and threads `tool_choice` (e.g. `'required'`) through
runTurn -> machine -> the bridge -- a plain value applies on ITERATION 0 ONLY
(then model choice) so a forced first tool call can never make loop termination
unreachable; casey's handler passes `tool_choice: 'required'` to nudge a weak
model into its first classify/record call, and casey's llm.js wrappers pass the
request through whole (never destructure-and-drop params). The bridge's
coder-agent cwd note ("use Bash/Read/Write") is OPT-IN via an explicit `cwd`
param -- it must never leak into a contact-facing agent's prompt. casey registers its OWN case toolset
(`plugins/case-tools/plugin.js` -> `src/case-tools.js`, discovered by
`bootHost([CASEY_PLUGINS])`) into that host -- keeping one non-colliding set rather
than double-registering freddie's overlapping tools. The agent acts entirely through
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
number. casey's `case-store.js` carries an operator-where FEATURE-DETECT shim (probe
the published thatcher; fall back to equality-only + JS operator predicates + recency
sort) so a bare clone and a pre-publish install stay green -- the same npm-publish-lag
caveat the thatcher shim section documents.

## Source map

```
thatcher.config.yml        entities + case workflow (system of record)
bin/casey.js               CLI: init / doctor / up / dashboard / cases / show / report (per-case-type SLA + per-type/per-channel metrics, --json)
plugins/case-tools/        freddie plugin registering case_* tools (auto-discovered)
src/
  casey.js                 top-level assembly: store + host + gateway + adapters + logger; drainQueuedTurns re-drives LLM-down-queued inbounds through the agent on provider recovery (status-gated, oldest-first serialized, mark-attempted only after a successful drive, bounded retry -> dead-letter)
  case-store.js            thatcher wrapper: find-or-create (locked), events, transitions, paging, config validation; a SQLITE_BUSY retry proxy on the `t` getter (list/get/create/update/remove retry with bounded linear backoff so a concurrent agent read against a live write never surfaces a "database is locked" turn error); mergeReport backfills case.lat/lon from the gazetteer when a location is written and no explicit GPS exists; learnOperatorActivity/listOperatorIdentities maintain the operator_identity entity (durable per-operator working-area history, dashboard-attributed actions only, best-effort/never throws into the caller)
  gazetteer.js             MAP-ONLY static SA town/province -> approximate [lat,lon] lookup (geocodeApprox), used solely to place a map pin from a case's free-text report location when no explicit GPS exists; distinct from the forbidden chat-routing gazetteer -- never feeds the agent's prompt or a tool response the contact sees, a miss buckets into the map's "unresolved" group rather than guessing
  case-runtime.js          process singleton so the plugin reaches the live CaseStore
  case-tools.js            case_* tool defs registered into the host: get/list(PII-free enquiryRow + location filter)/update/report/observe/transition + the worker-enquiry surface case_mine/case_today (own open cases, scoped by ctx.author via the row_access owner field, PII-free) / case_new (open+bind a fresh active case) / case_stop / case_handoff; autonomy-enforced. Handlers read the per-turn toolCtx as the 2nd arg (freddie invokes handler(args, ctx)). case_update carries case_type (agent-settable classification, validated against CASE_TYPE_VALUES -- thatcher's own config-declared enum is NOT enforced server-side on write, so the tool validates before every write, matching the dashboard's own check) and priority (same PRIORITY_VALUES guard). case_report carries lat/lon (only from real worker-read-out GPS, validated finite/in-range, written straight to the case columns, always overriding any prior gazetteer approximation)
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
  gateway-hooks.js         makeCaseHandler PURE-LLM flow: an inbound hits the STOP/HUMAN deterministic short-circuit (detectContactIntent, above the queue gate), OR the LLM-down queue gate (record a QUEUED-FOR-AGENT marker, send nothing, log loud), OR one runTurn tool loop where the agent classifies + routes + answers + RECORDS THE REPORT (case_report) + declares its phase (case_stage) via the case_* tools. casey does NO deterministic text processing -- no field extraction, no computed next-question. The prompt surfaces the raw report-so-far + the dstate phase (orient) and TRUSTS the model to acknowledge + not repeat + ask the next thing. A degraded turn (empty/error/echo/stock-ack/repeat) sends NOTHING and logs loud (no fallback text -- see the no-mocks-fallbacks-stubs invariant). dedup, media, observe
  discord-receive.js       fallback Discord WS receive for older freddie builds
  llm.js                   model call wiring; resolveCallLLM (boot precedence: acptoapi/null) + makeResilientCallLLM (self-healing backend that re-resolves a recovered provider, single live status() for the health row, and fires an onRecover edge that drives drainQueuedTurns)
  dashboard/server.js      express API + anentrypoint-design SPA (observe/edit/override/reply); GET/POST /report public contact form (no token); GET /api/map/cases (PII-free pins with resolved lat/lon, cluster membership, unresolved bucket, capped+truncation-reported) and GET /api/operators/identities (learned per-operator working-area coverage) back the dashboard's Leaflet+OSM map view (status-colored markers, marker clustering via leaflet.markercluster, outbreak-cluster link overlay, operator-coverage overlay, species/type/status/date filters, click-through to case detail) -- both routes token-gated like every other /api route; /vendor/leaflet and /vendor/leaflet.markercluster serve the map's static JS/CSS, exempted from the auth gate the same way /design already is (static UI assets, no case data)
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
| `CASEY_DASHBOARD_TOKEN` | When set, dashboard API + page require this token (`Authorization: Bearer <token>` or `X-Casey-Token` header). For the initial page load only, `?token=` in the URL is also accepted; the client strips it from the address bar and switches to header for all API calls. |
| `CASEY_PUBLIC_URL` | When set, the agent includes a `{CASEY_PUBLIC_URL}/report?ref={ref}` link in the first contact message. The `/report` page is a public (no-token) contact-facing form where contacts can fill in case details directly. |
| `CASEY_ALERT_WEBHOOK` | When set, a high-severity health breach (unanswered handoff, and the escalated tier) POSTs a plain JSON alert to this URL so a team is paged off-dashboard. Each newly-entered breach pages once; an already-flagged case is not re-paged. |
| `CASEY_OPERATORS` | Cooperative operator roster (comma-separated `id:Name` pairs), fixed at boot. `GET /api/operators` lists it and `X-Casey-Operator` selects a known id to attribute an action; this is attribution, not authentication -- an unknown/absent value falls back to the default actor and can never inject a new identity. |
| `CASEY_LOG=silent` | Silence structured JSON logs (used by tests). |
| `CASEY_LLM_MODEL` | Override the model requested from the acptoapi bridge (default `claude/sonnet` -- chosen over a cheaper tier because casey's turn is multi-step extraction + tool orchestration + tone-sensitive reply composition, where a weaker model has repeatedly dropped tool calls or repeated questions). Set to a cheaper tier for cost-sensitive deployments. |
| `CASEY_RELOAD=0` | Disable hot-reload (the supervisor still restarts on crash; it just stops watching source). |
| `CASEY_RELOAD_PATHS` | Comma-separated extra dirs to watch for reload (e.g. `../freddie/src`). `src/` and a sibling `../freddie/src` are watched by default; absent dirs are skipped with a warning. Allowlist only -- never contact input. |
| `CASEY_RELOAD_DEBOUNCE_MS` | Coalesce a burst of saves into one reload (default 300). |
| `CASEY_AUTO_UPDATE=0` | Auto-deploy (fetch + `merge --ff-only @{u}` on an interval) is ON by default in `casey up` so a push to origin reloads the live worker with no manual restart; set `0` (or `casey up --no-auto-update`) to disable the origin poll (an offline box, or to pin code). Safe on a dev checkout -- a dirty/divergent tree skips the fast-forward, never clobbered. |
| `CASEY_AUTO_UPDATE_INTERVAL_MS` | How often the auto-deploy loop fetches origin (default 60000). |
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
- Auto-reload on pull hooks (`hooks/`, armed automatically by `postinstall` running
  `scripts/install-hooks.mjs`, which points `core.hooksPath` at the tracked `hooks/`
  dir): `hooks/post-merge` and `hooks/post-checkout` `touch src/casey.js` after a
  pull/merge/checkout, a belt-and-braces mtime bump so a manual `git pull` also
  hot-reloads (`touch` changes only the timestamp, never the bytes). Even without the
  hooks the auto-deploy fast-forward already rewrites watched source, so the reload
  does not depend on them. (`scripts/auto-update.mjs` / `npm run auto-update` remains
  as a standalone poller for a host not running under `casey up`.)
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
  sends NOTHING to the contact -- there is no scripted holding reply
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
- **A greeting is the OPENING of a report, and every turn drives collection.** The
  agent's job is to gather the case while someone is on-site, so `caseSystemPrompt`
  directs it to answer even a bare "hi"/"hello"/"help" with a warm opener PLUS the
  single most-important still-missing fact (on a brand-new case that is "where the
  animals are"), rather than treating a greeting as a completed report or replying
  with a pleasantry that asks for nothing. The agent asks one still-missing fact per
  turn until the report is as complete as can be achieved.
- **A returning contact with a NEW case is the AGENT's call, via `case_new`.** Because
  find-or-create reuses the open case per conversation and `markReportFieldsIfEmpty` is
  fill-if-empty, a contact who returns and states a clearly different situation must not
  be trapped urging the old report's missing fields. There is no deterministic conflict
  detector -- the agent interprets the message and opens a fresh case with `case_new`
  (rebinding it active) when the worker is clearly starting a new report; a genuine
  continuation of the same incident stays on the bound case. `markReportFieldsIfEmpty`
  is fill-if-empty, so a re-report never overwrites the old case's recorded fields.
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
  dashboard (self-attested via `X-Casey-Operator`, cooperative attribution, never
  authentication) -- there is no path where a channel message is treated as an
  operator speaking as themselves. `learnOperatorActivity` builds a durable
  per-operator working-area profile (frequency-ranked location tokens from the
  cases they claim/transition/reply to/edit) from these dashboard-attributed
  actions, best-effort and fire-and-forget so learning can never slow or fail the
  real action it rides on. This is a coverage signal for the team (the map's
  operator-coverage overlay), never an auto-assignment: casey suggests visually,
  a human still claims.
- **The map is a visual rollup of data casey already stores, not a new source of
  truth.** `/api/map/cases` pins every case by explicit GPS (`case.lat`/`lon`) or a
  map-only gazetteer approximation from the free-text report location
  (`gazetteer.js` -- distinct from, and never feeding, the chat-routing path); a
  case with no resolvable location is never dropped, it lands in an `unresolved`
  bucket the UI surfaces. Outbreak-cluster links reuse `clusters.js`'s existing
  correlation engine rather than a second grouping heuristic. Aggregate/PII-free
  like every other dashboard rollup -- no `external_id`, no owner/contact fields on
  a pin, only what an area-level map needs.
- **The agent prepares observability data itself; a human classifies nothing the
  system could already infer.** Every field a read-only view (the map, SLA-by-type,
  workload-by-type) needs is agent-settable through the normal case_* tool flow --
  `case_type` (`case_update`) and `lat`/`lon` (`case_report`, only from real
  worker-read-out GPS) are set autonomously as the agent gathers the report, never
  left for an operator to classify by hand afterward. This is judgment via a tool
  call (AGENT decides case_type from the report's own content, per
  `caseSystemPrompt`), never a casey-side deterministic classifier -- the
  no-deterministic-text-processing invariant applies to observability prep exactly
  as it applies to the conversation. Fields that ARE genuinely operator-only stay
  that way (`autonomy` -- flipping it back to `auto` would let the agent escape
  the very mode a human used to stop it).

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

## thatcher / busybase chain

casey consumes thatcher via npm `latest` (never a `file:../` sibling, per the
user directive to always run freddie/thatcher off the registry) -- a local
thatcher fix requires a push to thatcher's `master` (CI publishes automatically)
before a fresh `npm install` in casey picks it up. npm publishing is RESTORED
(NPM_TOKEN set 2026-07-02): thatcher publishes from CI on push and deps
`busybase ^1.0.2` from the registry (1.0.2 is the floor -- the 1.0.1 tarball was
CI-built with a stale --external flag that inlined libsql behind a bun-only
require shim and crashed under node; busybase publishes on v* tags, and its
publish workflow now builds via `bun run build`, the single source of build
flags).
Because casey is now ALWAYS effectively "a bare npm install" relative to
thatcher's published version (never ahead of it via a local checkout), the
operator-where FEATURE-DETECT shim (`_thatcherSupportsOperators()` in
case-store.js, which probes the live thatcher instance at runtime rather than
assuming a version) is the permanent code path, not a fallback edge case --
it must stay correct against whatever thatcher `latest` currently ships, and
the equality-only JS fallback remains live safety for the (now impossible in
casey's own install, but still real for any consumer) case where a published
thatcher predates operator-where support. busybase's `src/*.js` are gitignored
bun-build outputs -- fixes go in the `.ts` sources and are rebuilt
(`npm run build` in the busybase repo, not a casey sibling). Timestamps
read back from busybase may be numeric-seconds STRINGS ("1782977388"): parse row
timestamps with the digit-string-aware helpers (attn.js tsMs / case-health.js ms
/ format.js toDate), never bare Date.parse.

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
