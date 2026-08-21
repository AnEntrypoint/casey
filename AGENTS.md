# AGENTS.md

Operating notes for agents (and humans) working in the casey repo. Included by
`CLAUDE.md` via `@AGENTS.md`; keep it accurate against the source.

## What casey is

casey is a thin orchestrator for animal-disease surveillance in rural South
Africa. Anyone messaging over WhatsApp/Discord is a reporter; casey gathers a
structured report warmly, without interrogation. A reporter defaults to the
`reporter` tier (casual, public, report-only); an operator may promote a
trusted reporter to `field_worker`, which unlocks agentic case-query access
and location check-ins so they show up on the operator map. casey amplifies
the team's workflow -- it does not impose disease rules or escalation;
priority stays with people.

## Architecture

casey composes existing projects and owns only the glue. Each composed
project is checked out as a real git submodule under `deps/` for local
editing, and consumed at runtime as an npm dependency (resolved from
`node_modules`, not from `deps/`) -- the submodule checkout and the npm
install are two independent mechanisms serving two different needs: the
submodule gives an editable, pushable local clone; the npm dependency is
what casey's own code actually imports at runtime.

| Layer | Project | Submodule path | Role |
|-------|---------|-----------------|------|
| Agent + channels | `freddie` | `deps/freddie` | Agent harness + Gateway with WhatsApp/Discord adapters, tools, sessions. |
| LLM provider chain | `acptoapi` | `deps/acptoapi` | Model resolution, chain fallback, sampler backoff. Reached through freddie's bridge, never called directly by casey. |
| System of record | `thatcher` (deps `busybase`) | `deps/thatcher` | Config-driven CRUD + workflow + RBAC + audit. Holds `case` / `event` / `contact` and the lifecycle state machine. |
| UI | `anentrypoint-design` | `deps/design` | webjsx + ripple-ui design system theming the dashboard. |

Editing a composed project: work directly in its `deps/<project>` checkout,
commit and push from inside that submodule's own repo, then bump the
submodule pointer in casey (`git add deps/<project> && git commit`) so the
fix is recorded here too. All four composed projects -- `freddie`,
`thatcher`, `anentrypoint-design`, and `acptoapi` -- are declared in
`package.json` via npm's `github:owner/repo#main` dependency spec (e.g.
`github:AnEntrypoint/freddie#main`), so `npm install` fetches each package
directly from its GitHub repo's `main` branch tip rather than resolving a
published version from the npm registry. There is no npm-registry version
pin left anywhere in this fleet, including `acptoapi`: it previously carried
a real caret range (`^1.0.x`) as a deliberate stability floor on the LLM
provider chain, but now floats with the other three -- a broken push to
`acptoapi`'s `main` reaches casey's next `npm install` exactly as fast as a
fix does, with no version ceiling to fall back to. A fix pushed upstream to
any of the four repos' `main` branch reaches casey's npm-resolved runtime
copy on the next `npm install`, no version-bump commit required for the
*runtime* dependency -- the submodule pointer bump is a separate, additional
step for keeping `deps/` in sync, not a replacement for `npm install`. A
local fix to any composed project still requires a push to its own repo
before `npm install` in casey picks up the runtime copy -- editing
`deps/<project>` in place does not change what casey imports; there is no
instant local-edit-to-live-box loop through `deps/`.

`deps/` is submodules only, never a vendor tree -- nothing under `deps/` is
committed as casey's own source, and casey's code never imports from
`deps/`. Run `git submodule update --init --recursive` after a fresh clone
to populate `deps/`; a bare clone of casey without that step has empty
`deps/*` directories but is otherwise fully functional (npm install still
resolves every composed project from the registry).

**Layering mandate: agentic harness -> freddie, CRM code -> thatcher, casey
is setup + configuration.** freddie's `tool_choice` forced value (e.g.
`'required'`) applies on iteration 0 only, then reverts to model choice --
this is what makes forcing the first tool call safe (loop termination stays
reachable). freddie's coder-agent cwd note ("use Bash/Read/Write") is opt-in
via an explicit `cwd` param and must never leak into a contact-facing
agent's prompt.

**pi tool surface -- what casey uses and why the rest is excluded.** casey's
contact-facing agent turn enables `enabledToolsets: ['cases']` only, so the
agent reaches nothing but casey's own `case_*` tools. Because freddie's
`enabledToolsets` gates at the toolset-category level (not per-tool), the
tier-gated tools' full JSON-schema descriptions were still being serialized
into every reporter-tier request -- dead weight on the far more common tier.
`hooks/handler.js` additionally passes `disabledToolsets:
reporterTierExcludedToolNames()` for a reporter-tier turn, which filters by
tool name (despite the toolset-sounding parameter name) so those schemas
never enter the request payload; the excluded-name list is derived from the
live toolset at call time, so a newly added tool is automatically covered.
`bash`/`read`/`write`/`edit`/`grep`/`browser`/`terminal`/`delegate`/`skill*`
are forbidden to a contact-facing agent by the security invariant.
`web_search`/`web_fetch` are excluded because casey never geocodes or looks
anything up on the model's behalf -- the agent uses its own world knowledge.
Three `creative`-toolset tools (`transcription`, `vision`, `tts`) are
dispatched by casey's own deterministic code, never the agent, each opt-in
and fail-open (see the Environment table). Any future mission-aligned pi
tool is added the same way -- deterministic dispatch by name, never widened
into the agent's toolset.

casey registers its own case toolset (`plugins/case-tools/plugin.js`) into
that host -- application-agnostic; the store, field/enum/projection
vocabulary, and role model arrive via a per-turn `toolCtx` and
`plugins.case` config. CRM querying lives in thatcher: `list()` supports
operator where-objects (`{field:{$gte,$lte,$in}}`, `$or`), array tie-broken
sort, and opt-in row-access scoping.

**Worker identity = the channel author; a worker selects a case before
data-dumping into it.** A worker negotiates/selects a case which binds
active; a new case opens only on an explicit `case_new`. Every enquiry row
is projected to a whitelist that excludes `external_id`/`contact_id`, so a
list can never surface a phone number.

## Source map

```
thatcher.config.yml        entities + case workflow (system of record)
bin/casey.js               CLI: init / doctor / up / dashboard / cases / show / report
plugins/case-tools/        freddie plugin registering case_* tools (auto-discovered)
src/
  casey.js                 top-level assembly: store + host + gateway + adapters + logger
  case-store.js            thatcher wrapper: find-or-create (locked), events, transitions, paging, optimistic-lock report merge
  case-runtime.js          process singleton so the plugin reaches the live CaseStore
  provenance-wire.js       additive bridge from case_report into the provenance subsystem (src/core/, src/packs/)
  case-tools.js            case_* tool defs; gateByTier wraps every query/mutation tool behind field_worker tier
  dashboard/auth.js        per-operator login: scrypt hashing, stateless HMAC-signed session cookies, operator_account CRUD
  case-machine.js          xstate case lifecycle machine
  case-health.js           per-case health/guardrail signals
  case-sweep.js            periodic health-guardrail sweep, including team-coverage-gap detection
  correlate.js             cross-case correlation helpers
  attn.js                  worst-first attention ranking with an SLA clock; backs the inbox and `casey attention`
  format.js                shared SAST timestamp + phone formatters (CLI and SPA render the same way)
  thresholds.js            pure validate/clamp/merge of operator-tunable health thresholds
  overview.js              KPI aggregates over the event log; exports shared evData() event.data parser
  workload.js              per-operator workload rollup, aggregate-only
  clusters.js              correlated-case components (shared location/species) for outbreak clustering
  geo.js                   hotspots-by-area rollup
  report.js                management report rendering (CSV/HTML)
  report-analytics.js      pure management analytics: SLA compliance, period comparison, channel/case-type metrics
  gateway-hooks.js/hooks/handler.js   makeCaseHandler: STOP/HUMAN short-circuit, LLM-down queue gate, or one runTurn tool loop
  llm.js                   model call wiring; self-healing backend that re-resolves a recovered provider
  dashboard/server.js      express API + anentrypoint-design SPA; map/reporters/accounts routes
```

There is no automated test suite. Verification is manual/live: run `casey up`
against real freddie/thatcher/a real LLM provider and exercise the actual
conversation over Discord/WhatsApp or the dashboard.

## Dev workflow

```sh
npm install                 # every composed project resolves from npm, no siblings needed
node bin/casey.js init      # scaffold a .env (channel tokens, dashboard secret)
node bin/casey.js doctor    # green/red preflight: deps, channels, port, token
node bin/casey.js up        # gateway + dashboard (default http://localhost:4000)
npm run lint                # dependency-free preflight (syntax+config+package+ascii); the CI gate
```

CI (`.github/workflows/ci.yml`) runs `npm run lint` on every push and PR. It
is dependency-free on purpose -- it does not need the `anentrypoint-design`
npm dependency installed, so it stays green in a bare clone. It carries a
pure-llm grep-gate (`gateway-hooks.js`/`casey.js` must never import a
deterministic intent/extraction module) and a no-stub-mock grep-gate
(`src/`, `bin/`, `plugins/` must never reference a mock adapter or stub
LLM). `scripts/lint.mjs`'s file walk skips `deps/` entirely -- the
submodule checkouts are separate repos with their own lint policy, and a
CI runner that has not run `git submodule update --init` (the default for
a plain `actions/checkout`) sees empty `deps/*` dirs anyway.

Composed projects are checked out as git submodules under `deps/` (see
Architecture above) -- never a `vendor/` tree. `src/supervisor.js`'s default
hot-reload watch is the separate sibling path `../freddie/src` (outside the
repo, existence-guarded, skipped with a warning when absent), not
`deps/freddie` -- editing `deps/freddie` does not trigger a hot reload by
default. To hot-reload edits made inside the `deps/freddie` submodule, add
its path explicitly via `CASEY_RELOAD_PATHS=./deps/freddie/src`.

### Kit consumption strategy (fleet-wide)

Node-resolved consumers (casey, freddie) declare `anentrypoint-design` as a
`github:AnEntrypoint/Design#main` npm dependency, so `npm install` fetches
the package directly from GitHub's `main` branch tip rather than the npm
registry -- casey resolves it out of `node_modules` and serves its `dist/`
directly, same as before, only the fetch source moved. `freddie`, `thatcher`,
and `acptoapi` use the same `github:owner/repo#main` spec for the same
reason: `npm install` remains the only mechanism that can populate
`node_modules` for a package a Node process directly `import`s, but the
resolution source is now each project's own GitHub repository instead of the
npm registry -- there is no way to CDN-serve a package into Node's module
resolver, so `github:` is the closest real equivalent of "always latest from
GitHub" for a server-side dependency. Two consumers are deliberately excluded
from this strategy and must stay excluded: `gmsniff` (must run air-gapped,
zero external-origin runtime fetches -- never give it a CDN load or runtime
dependency) and `agentgui` (vendors the built kit locally for offline
operation and UI stability). Accepted tradeoff: a push to any of these four
repos' `main` branch can change casey's runtime behavior or dashboard UI with
no commit in casey, and with no version pin to roll back to (a `github:` spec
has no npm-published version history) -- if a broken build lands on `main` in
any of the four repos, casey's next `npm install` picks it up immediately.

## Environment

Most variables are self-describing from their name and the code that reads
them. This table covers only the ones whose default/behavior is not obvious
from the name alone.

| Variable | Non-obvious behavior |
|----------|-----------------------|
| `WHATSAPP_APP_SECRET` | Required (not merely recommended) when WhatsApp credentials are configured -- `casey up`/`casey doctor` hard-fail without it. |
| `CASEY_SESSION_SECRET` | Random per process start when unset, so a restart invalidates every session. Set explicitly for sessions to survive a restart. |
| `CASEY_OPERATORS` | Removed. The roster now reads from the `operator_account` table directly; setting this has no effect. |
| `CASEY_LLM_MODEL` | Default `claude/sonnet`, chosen because a weaker model has repeatedly dropped tool calls or repeated questions during casey's multi-step extraction+tool-orchestration turn. `auto` builds acptoapi's real fallback chain rather than pinning one model. |
| `CASEY_TZ`, `CASEY_TZ_LABEL`, `CASEY_COUNTRY_CODE` | Default to a South African deployment (SAST, +27, SA-shaped digit grouping); digit-grouping stays SA-shaped regardless of country code (a fully correct international formatter needs a per-country grouping table, out of scope). |
| `CASEY_TRANSCRIBE_VOICE_NOTES`, `CASEY_DESCRIBE_PHOTOS`, `CASEY_VOICE_REPLIES` | All three off by default and fail-open: each sends real bytes (audio/image/text) to an external API, a deliberate opt-in data-egress point. Any failure degrades silently to the original text-only/manual path, never blocking the reply. |
| `CASEY_LOCATION_STALE_MS` | Read once from `process.env` at module load, not via the async thresholds store -- `caseSystemPrompt` is deliberately a pure, synchronous function. |
| `CASEY_MEDIA_TOOL_TIMEOUT_MS` | The three media tool calls run before `turnStartedAt` is set, so without this timeout they sit entirely outside the turn hard-deadline and could hang the per-contact concurrency gate indefinitely. |
| `CASEY_TRUST_PROXY_HOPS` | Unset means `req.ip` is the raw socket peer, so the public `/report` form's rate limiter sees every request behind a real proxy as the same address. Set too high/untrusted and a client can spoof `X-Forwarded-For` to bypass the limiter. |
| `CASEY_MINE_SCAN_LIMIT` | Only bounds the fallback scan for legacy cases predating `author_key` (current cases scope via a real equality where-clause, not a scan). |
| `CASEY_MIN_AGGREGATE_CELL` | k-anonymity floor: a named bucket (channel/case_type/place) smaller than this is folded into `other/sparse` rather than shown by name -- naming the one place a rare report came from is close to naming the report itself. `unknown` is exempt since it names nothing to fold away. |
| `CASEY_AUTO_UPDATE` | On by default: `casey up` fetches+ff-merges origin on an interval and hot-reloads the worker on the new code. Safe on a dirty/divergent dev tree -- `merge --ff-only` refuses and leaves the tree untouched. |
| `CASEY_DRAIN_DEADLINE_MS` vs `CASEY_DRAIN_TURN_TIMEOUT_MS` | Two distinct drain timeouts -- the former bounds the supervisor's reload-time drain of the whole worker; the latter bounds `casey.js`'s own in-process `drain()` await used for shutdown/test determinism. |
| `CASEY_RESUME_MAX_REDRIVES`, `CASEY_RESUME_SPACING_MS`, `CASEY_RESUME_MAX_AGE_MS` | Bound the boot-time stuck-turn resume sweep so it cannot starve a genuinely new contact's message by exhausting provider rate limits, and so a stuck message isn't retried forever across restarts once it's aged past usefulness. |
| `CASEY_DRAIN_POLL_INTERVAL_MS` | Background poll that drains LLM-down-queued turns once the provider recovers, independent of any new inbound arriving on the same conversation -- without it a queued contact can wait indefinitely even after the backend is healthy again. |
| `CASEY_SWEEP_INTERVAL_MS` | Health-guardrail sweep runs on this interval (default 15*60e3 / 15 minutes). Opt-in: a non-positive value disables the sweep entirely (sweepIntervalMs<=0). The sweep detects stale/stuck/abandoned cases, machine violations, and team coverage gaps. |
| `CASEY_HEALTH_BREACH_WINDOW_MS` | Coverage-gap detection window (default 60*60e3 / 1 hour). A team alert fires when at least one breaching case exists AND zero operator replies landed in this window. |
| `CASEY_RATE_LIMIT_MSGS`/`WINDOW_MS`, `CASEY_GLOBAL_RATE_LIMIT_MSGS`/`WINDOW_MS` | An over-cap message is dropped silently (no reply, no synthetic "slow down" text), matching the no-fallback-text discipline. Per-contact and aggregate-across-all-contacts limits are independent. |
| `CASEY_TURN_HARD_DEADLINE_MS`, `CASEY_TURN_SOFT_DEADLINE_MS` | The hard deadline bounds total retry budget for a live first-attempt turn only (never a background resume); the soft deadline only picks which of two fallback strings to send once the hard deadline closes out a degraded turn. Pace these together with `ACPTOAPI_AUTO_CHAIN_CAP`/`ACPTOAPI_CHAIN_LINK_TIMEOUT_MS` below -- a wide candidate pool with slow-but-working reasoning models needs both room to wait and room to finish the walk inside the outer deadline. |
| `ACPTOAPI_AUTO_CHAIN_CAP` | Caps candidate models per `auto` chain build. Too high risks not finishing the walk inside the turn deadline; too low risks exhausting the pool on backed-off providers before reaching a healthy one. |
| `ACPTOAPI_CHAIN_LINK_TIMEOUT_MS`, `ACPTOAPI_READINESS_PROBE_TIMEOUT_MS`, `ACPTOAPI_EXTRA_PROBE_TIMEOUT_MS`, `ACPTOAPI_REACHABILITY_PROBE_TIMEOUT_MS` | Four independent timeouts across acptoapi/freddie layers (chat-completion link, readiness pass, discovery-time probe, and freddie's own bridge reachability check). All four must agree on an outer bound, or a genuinely slow-but-working model gets marked unhealthy/unreachable at an earlier, tighter layer before its own longer budget ever gets a chance. |

## Timeout Coordination (live turn guarantee)

The timeout stack is four independent layers. Each layer has its own deadline; all four must agree on an outer bound or a genuinely slow-but-working provider gets marked unhealthy/unreachable at an earlier layer before its own longer budget ever gets a chance. Misalignment causes live contacts to hit fallback messages even when the backend is healthy but slow.

**Layer 1: Live-turn hard deadline (casey)**
- `CASEY_TURN_HARD_DEADLINE_MS` (default 120000 / 2 min): Total retry budget for a live first-attempt inbound
- `CASEY_TURN_SOFT_DEADLINE_MS` (default 25000 / 25 sec): Threshold for changing fallback message tone ("still working" vs "having trouble")
- `CASEY_LLM_TURN_TIMEOUT_MS` (default 120000): Per-attempt safety ceiling, never exceeds remaining hard deadline
- Applies to: Live inbound, first-attempt turn only (excludes background queue re-drives and resume sweep)
- Guarantees: Every live turn ends with either a real reply OR a truthful status message sent to the contact

**Layer 2: Provider chain link (acptoapi)**
- `ACPTOAPI_CHAIN_LINK_TIMEOUT_MS` (default 20000 / 20 sec): Per-provider timeout for each hop through the ranked candidate list
- Applies to: Each provider in the auto-chain walk, once per attempt
- Constraint: Each attempt calls the full chain to completion, not truncated mid-hop; only the hard deadline stops retries

**Layer 3: Provider readiness and discovery (acptoapi/freddie)**
- `ACPTOAPI_READINESS_PROBE_TIMEOUT_MS`: Per-provider readiness check (readiness.json)
- `ACPTOAPI_EXTRA_PROBE_TIMEOUT_MS`: Additional provider discovery timeout
- `ACPTOAPI_REACHABILITY_PROBE_TIMEOUT_MS`: Boot-time/dashboard reachability check
- Applies to: Probe/discovery phase, not the real turn itself
- Constraint: Boot probe uses a narrower sample (REACHABILITY_PROBE_CHAIN_LINK_CAP) than live turns

**Coordination rules:**
```
Hard deadline (120s) >= Soft deadline (25s) ✓           -- tone changes partway through wait
Hard deadline >= Per-attempt timeout (120s) ✓          -- retries fit within hard budget
Per-attempt >= Per-link timeout (20s) ✓                -- full chain walk completes per attempt
Per-link >= Readiness/discovery timeouts ✓             -- inner probes complete before outer
Chain-link (20s) * max retries (3) + buffer            -- allows multiple complete chain walks
```

**Typical healthy turn timeline:**
```
T+0s:   inbound arrives, hard deadline clock starts, typing indicator starts
T+2s:   agent turn dispatched, runTurn calls bridge.callLLM, chain walk starts
T+8s:   provider responds, tool_choice forced, case_report succeeds, reply composed
T+9s:   reply judge passes, outbound recorded and sent, typing indicator stops
T+9s:   degraded: false, replied: true, no fallback sent
```

**Timeout degrade timeline (healthy model, slow link):**
```
T+0s:   inbound arrives, hard deadline clock starts
T+2s:   attempt 1 starts, chain walks providers A, B, C (each ~18s)
T+20s:  attempt 1 times out at hard deadline, scheduled fallback sent
T+20s:  "Sorry, I'm having trouble right now" sent to contact (soft deadline exceeded)
```

**Background queue re-drives (separate budget):**
- Queue re-drives and resume sweep turns are NOT subject to hard deadline
- They use `CASEY_LLM_TURN_TIMEOUT_MS` unbounded (no hard deadline)
- No guaranteed-fallback text sent on background degrade (stays silent)
- Retry cap: 5 per msgId before dead-letter (queue) or 5 + 24h age (resume)

**Health monitoring:**
- `GET /api/health` returns degraded:true if recent turns were slow (rolling window, MIN_SAMPLES_FOR_DEGRADED=2)
- `GET /api/turns/degraded` lists all degraded turns across all cases (queryable by structured data)
- `GET /api/queue` shows pending queue depth and dead-lettered count
- `GET /api/health/cases` returns live case-level health signals (breaches per case + sweep status)

## Case health guardrails and sweep

The periodic guardrail sweep (`case-sweep.js`, `casey.startSweep()`) runs every `CASEY_SWEEP_INTERVAL_MS` (default 15 min) and detects health guardrail violations on every open case. Every newly-entered breach produces an observation event + a health:* tag on the case.

**Breach types:** stale (48h), stage_stuck (per-stage maxDwell), handoff_needed (30 min), unanswered_handoff_escalated (8h), incomplete_critical, abandoned_intake (12h), never_closed (7d), unsentDraft (1h). Team coverage gaps fire once per rising edge when at least one breaching case exists AND zero operator replies landed in `CASEY_HEALTH_BREACH_WINDOW_MS` (default 1h).

**Sweep mechanics:** Re-entrancy guard prevents overlapping passes; observations appended BEFORE tag writes (prevents silent loss on retry); write-failure throttle (15 min) prevents spam on persistent failures; optimistic locking with expectedVersion handles concurrent writes correctly; error abort after 100 errors/pass.

## Supervised runtime (hot reload + crash restart)

`casey up` runs under a supervisor (`src/supervisor.js`) that forks the
gateway+dashboard in a child worker and owns fork/kill/watch; the supervisor
never re-imports app code, so a crash or source edit only recycles the
child. `src/supervisor-machine.js` is the pure xstate v5 transition
authority (running -> draining -> restarting -> running, plus crash-budget
stop).

- Reload keys on file mtimes, not git state -- a raw `git commit` alone does
  not refresh a running worker. When re-verifying a fix against a live
  process, confirm the process started after the fix commit, not just that
  the fix is on disk.
- Auto-deploy uses `git fetch` + `merge --ff-only` rather than `git pull
  --ff-only`, because a bare pull fails with "Cannot fast-forward to
  multiple branches" when FETCH_HEAD carries several refs.
- Exit code 44 (dashboard port EADDRINUSE) is config-fatal, not
  retry-eligible -- the supervisor fails loud once instead of re-forking
  into the same held port repeatedly.
- The watch list is a fixed allowlist, never derived from contact input; the
  fork takes an argv array, never an interpolated shell string.

## Design principles (preserve these)

- **No mocks, fallbacks, or stubs -- only singular working mechanisms and
  loud errors.** A degraded turn never fabricates case content and never
  claims to have understood the report. The one deliberate, scoped
  exception: a live first-attempt turn that is still degraded after its
  retry budget sends a truthful status message ("still working" / "having
  trouble") rather than silence -- this is honesty about the wait, not
  about the report; it invents nothing about the case. A background
  resume/queue re-drive stays silent on degrade, as before.
- **The reporter is usually a field worker relaying a farmer's animals, not
  the owner.** The agent asks only what the worker can see or relay --
  never "when you first noticed it" -- and records who's on-site and their
  relation to the owner separately from the animal facts.
- **The LLM records the report; casey does no field extraction.** There is
  no deterministic capture floor. The accepted trade-off: a fact the model
  fails to record via `case_report` has no deterministic net.
- **A case is keyed per contact, not per channel.** `conversationKey`
  returns `container:author` when a channel/chat carries multiple authors,
  so two workers in one Discord channel get distinct cases. Reply delivery
  target is kept separate from this key (a Discord author id 404s if posted
  to directly; only the channel does).
- **A complete report is not a dead-end.** The agent invites a fresh report
  for any other animal or place rather than ending on "your reference is
  X" -- there is no state that traps the conversation.
- **The on-site window is the only chance to capture more.** A single
  last-chance push fires on any farewell-shaped cue, before the agent
  declares the case complete, naming the fields that matter most once the
  worker leaves. Still one gentle ask, never a list, never pushy.
- **No worker-volunteered fact is silently discarded.** Photo/audio/site
  fields append rather than overwrite. A dashboard operator's concurrent
  edit is detected via optimistic locking and the merge retries against the
  fresh row rather than either side's write silently losing.
- **A returning contact starting a genuinely new situation is the agent's
  call, via `case_new`.** There is no deterministic conflict detector --
  field-merge is fill-if-empty, so an old report's missing fields never
  trap a contact who has clearly moved on.
- **The LLM backend self-heals; casey never stays degraded because of a
  boot-time probe.** The backend re-resolves lazily on failure, debounced,
  so a provider that recovers after being down at boot resumes real
  auto-replies with no restart.
- **No copyable reply examples in the prompt.** A full quoted sample reply
  gets copied word-for-word by small models -- only literal tokens that
  must reproduce exactly (a reference, a link) appear, each with an
  explicit "write the surrounding sentence yourself" instruction.
- **The contact's message is untrusted data, never instructions.** The
  agent is told explicitly to ignore anything in contact text that tries to
  change its role or persona.
- **A field correction is distinguishable from a first-time fill in the
  audit trail** -- an overwrite of an already-filled field records an
  old-to-new diff, not just the new value.
- **STOP/HUMAN are deterministic irreversible controls; their
  acknowledgement text is not.** Only these two short-circuit
  deterministically (fire in any phrasing/language, even with the LLM
  down, above the LLM-down queue gate). The confirmation text itself now
  goes through the same real-LLM turn as any other reply -- no hardcoded
  per-language template. A STOP arriving with real report content is
  flagged for manual review rather than silently actioned and forgotten.
- **A fast message burst is buffered and replayed, never silently
  dropped.** A message that hits the per-contact in-flight guard is queued
  and replayed as a full turn once the in-flight turn clears.
- **No deterministic text processing.** No keyword intent classifier, no
  province->town gazetteer -- place understanding and report extraction are
  entirely the model reading and calling the right tool.
- **Enquiries and status are PII-free.** Every worker-facing projection
  excludes `external_id`/`contact_id`.
- **A reporter's access tier is operator-assigned, never self-service or
  LLM-settable, and fails closed.** No `case_*` tool touches `contact.tier`;
  any falsy/missing/corrupt value resolves to the lower-privilege
  `reporter` tier, matching the fail-closed discipline used for PII
  scoping elsewhere.
- **Full observability.** Every action is an append-only audited `event`
  row; event `data` is a JSON string on read and must be parsed at the read
  edge, never assumed to already be an object.
- **Receive-liveness is observable, never a false green.** A live TCP
  socket does not imply a live gateway -- casey stamps last-connect and
  last-inbound per channel so a silently-dead receive path is visible.
- **The AI-helper health pill is a deliberately conservative rolling
  window** (a lone failed turn never flips it red), which means a genuine
  one-off degraded turn can happen while every other health signal still
  reads green -- `GET /api/turns/degraded` exists specifically to answer
  "did a real turn actually fail recently, and why" without needing to
  already know which case to check.
- **A team is paged when nobody is covering, not just per case.** A
  rostered team with open breaching cases and zero operator replies in the
  window pages once on the rising edge, using a synthetic ref (no
  `external_id`).
- **Assisted mode actually holds the reply** -- it is a real delivery gate,
  not a label; only `auto` sends without a human release.
- **Operator identity is learned, never asserted.** Identity derives only
  from the authenticated dashboard session, never a client-supplied header.
  The learned per-operator working-area profile is a coverage signal for
  the team, never an auto-assignment.
- **The map is a visual rollup of data casey already stores, not a new
  source of truth.** No lookup table, no server-side geocoding -- a
  coordinate is either the worker's real GPS or the model's own place
  estimate from its own world knowledge. A case with no coordinate lands in
  an `unresolved` bucket rather than being dropped.
- **Management aggregates are aggregate-only and never emit `external_id`,**
  including from nested fields (e.g. a delivered-reply event's `data.to`).

## Security invariants (do not regress)

- WhatsApp inbound is HMAC-SHA256 verified when `WHATSAPP_APP_SECRET` is set;
  that secret is required, not optional, when WhatsApp credentials exist.
- Dashboard API + page gate on a logged-in session (username/password per
  operator_account, scrypt-hashed, stateless HMAC-signed session cookie). No
  route accepts a bearer token or a `?token=` query param. The only ungated
  routes are `/design`, `/vendor/*` (static assets, no case data),
  `/api/login`, `/api/logout`, `/api/whoami`, and the public `/report` form
  (gated by knowledge of a case ref, not auth). Admin-only routes
  additionally require `role: 'admin'`.
- All contact-supplied text is HTML-escaped before render.
- Session-cookie and password comparisons use `crypto.timingSafeEqual` to
  prevent timing oracles.

## thatcher / busybase chain

casey consumes thatcher via a `github:AnEntrypoint/thatcher#main` dependency
spec, never a `file:../` sibling, so `case-store.js` calls thatcher's
operator-where directly with no runtime feature-detect and no fallback.

**2026-08-09 supply-chain incident, resolved.** thatcher's `main` was
compromised: commit `724e8bce` ("chore(release): v1.0.92", authored by
`github-actions[bot]` -- an automated release commit, not a human) injected
an obfuscated dropper into `src/index.js` (unicode-escaped
`require("http")`/`require("child_process")`, XOR-decoded payload fetch +
`eval`, a detached self-respawning `spawn`, C2 at a hardcoded IP -- Windows
Defender flags it as `Trojan:NPM/HiddenSpawn.IAF!MTB`). The parent commit
`42740b99` (v1.0.91) was confirmed clean; `724e8bce` was reverted on
thatcher's real `main` (commit `9977155`, a `git revert`, not a force-push --
the compromised commit stays visible in history as evidence). `main` is
confirmed clean again as of the revert; casey tracks `#main` again, not a
pin. **Still open:** the release automation's credentials/workflow that let
`github-actions[bot]` push this were never audited or rotated -- the same
compromise could recur on a future automated release until that root cause
is found and closed. `scripts/scan-deps.mjs` (run via `npm run scan-deps`,
also wired into `casey doctor`) guards node_modules against a repeat of this
specific obfuscation signature on every future install/doctor run, but it is
a narrow signature match for this one incident shape, not a general malware
scanner -- it does not replace fixing the actual credential/workflow gap.
busybase's `src/*.js` are gitignored bun-build outputs -- fixes go
in the `.ts` sources in the busybase repo and are rebuilt there, never
patched in a casey-side copy. Timestamps read back from busybase may be
numeric-seconds strings (e.g. `"1782977388"`); parse row timestamps with the
digit-string-aware helpers (`attn.js` tsMs / `case-health.js` ms /
`format.js` toDate), never bare `Date.parse`.

## Provenance subsystem (src/core/, src/engine/, src/packs/)

An additive ground-truth/provenance layer sits alongside casey's existing
thatcher-backed case/event architecture (untouched by this layer). It exists
to answer a stricter question than the live agent conversation alone can:
for every value, who said it, how (observed/reported/measured/
inferred/unknown), and when -- so a future aggregate/audit/export can never
blend a model guess into a ground-truth count.

**Provenance is a type, not a field.** Construction is gated through
`mkValue`/`mkUnknown` only; a bare object literal shaped like a provenanced
value is rejected. Five kinds, ranked worst-to-best: `unknown < inferred <
reported < observed < measured`. `canReplace` enforces that a lower-rank
value can never overwrite a higher-rank one -- an agent's inferred lat/lon
estimate can never clobber a worker's real GPS reading.

**The raw log is the system of record.** `raw-log.js` is append-only JSONL
with no update/delete method, so mutation is structurally absent, not
merely forbidden. `aggregate.js`, `interpretation.js`, and
`engine/rule-engine.js` (an aggregation layer, a model-estimate layer, and a
rule evaluator, respectively) were designed as further tiers on top of the
raw log but were never wired to a real caller -- confirmed dead code via
`casey-maximize-quality`'s 2026-08-11 audit and removed. Only `raw-log.js`,
`write-path.js`, and their direct dependencies (`observation.js`,
`provenance.js`) are live, reached from the agent path via
`case-tools.js` -> `provenance-wire.js` -> `write-path.js`. Reintroduce an
aggregation/estimate/rule-evaluation tier only wired to a real caller from
day one, not as unreferenced scaffolding.

**The single write-path chokepoint** is `write-path.js`'s
`writeObservation()` -- the one function every writer calls. It rejects
(never silently drops) any incoming finding that would violate
`canReplace`, returning rejected fields explicitly.

**Config packs are declarative data only.** A pack's `unknownAllowed` field
cannot be set to `false` -- a pack that tries is rejected at validation, so
"unknown is always reachable" is structurally enforced, not conventional.
`src/packs/animal-health.js` and `src/packs/water-point.js` (a genuinely
unrelated domain) both validate through the identical engine functions with
zero domain-specific branching in `core/`/`engine/` -- proof the boundary
holds. `scripts/lint.mjs`'s `trust-boundary` gate forbids any
`src/packs/*.js` file from importing `src/core/` or `src/engine/`.

**Wired into the live agent conversation** (`src/provenance-wire.js`):
`case_report` still writes directly to thatcher's `case.report` JSON blob
as the real system of record; every call now also produces a
provenance-tagged Observation, additively, best-effort, never blocking the
real write. Only the fields the pack's form actually declares are wired
through; every value is tagged `provenance: 'reported'` regardless of
whether it was an exact GPS reading or the model's own estimate, since
there is no signal on this call distinguishing the two.

## Conventions

- ASCII only in source and docs -- no arrow/box/bullet/check glyphs, emoji,
  em-dashes, curly quotes, or combining marks (use `->`, `-`, `[x]`/`[ ]`,
  plain `'`/`"`, words). Code operators are exempt.
- ES modules (`"type": "module"`), Node >= 22.
- No automated test suite. Verification is manual/live against a real
  running `casey up` instance. Do not add a test file or mock-heavy unit
  suite back in.
- thatcher's sqlite handle is cwd-bound (primes `getDatabase()` from
  `<cwd>/data/app.db` at init; re-importing the accessor forks a second
  handle).

@.gm/next-step.md
