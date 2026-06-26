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

Inbound flow: channel message -> freddie Gateway -> casey case handler (replaces
`handleInbound`) -> find/create thatcher case (locked, deduped by message id) ->
agent turn with case context + `case_*` tools -> reply, with a safe fallback when
the model errors/empties. Every inbound/outbound/observation/action/transition is
an append-only `event` row. The dashboard reads/edits thatcher over its API.

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
  gateway-hooks.js         makeCaseHandler: plain-language prompt, intent keywords, dedup, media, observe, fallback
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

Note: `freddie` and `anentrypoint-design` are `file:../` dependencies. Without
those sibling checkouts (and `thatcher` from npm) installed, `node test.js` and
`casey up` fail with `ERR_MODULE_NOT_FOUND`; only static review is possible in a
clone that lacks them. Set `CASEY_STUB_LLM=1` to run `up` fully offline.

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
  mtimes, so `git commit`/`checkout`/`pull` alone does NOT refresh a running
  worker -- a committed fix stays inert until the next `casey up` restart (or a
  save/`touch` of a watched source file). When re-verifying a fix against a live
  process, confirm the running process started AFTER the fix commit, not just that
  the fix is on disk.
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
- **A greeting is not a report: content-free turns get a warm reply, never the
  case-ack.** A bare "hi"/"hello"/"help" or other chit-chat carries no livestock
  content, so the intake-drive and holding-ack paths must not fire on it -- doing so
  parrots "Thank you for letting us know ... your reference is X" at someone who only
  said hello. `isContentFreeTurn(justCaptured, report)` (gateway-hooks.js) is the
  deterministic signal: nothing captured this turn AND an empty running report. On a
  content-free turn the handler replies with `warmConversationalReply` (a short
  language-mirrored "Hi! I am here to help -- if any of your animals are sick or have
  died, tell me what is happening", keeping the reference reframed as "if you message
  again") and records a `CONVERSATIONAL` observation, while both the empty-text
  fallback and the precedence/intake-drive gate are skipped. The moment the contact
  states a real fact (a captured field, or any recorded report field) the turn is no
  longer content-free and intake proceeds exactly as before -- a symptom-only "blue
  eyes" still captures and drives intake; the warm reply is strictly for the
  no-content case.
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
  trace when and by whom a case was reclassified. `casey report [--json]` renders the
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
