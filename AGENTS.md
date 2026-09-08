# AGENTS.md

Operating notes for agents (and humans) working in the casey repo. Included by
`CLAUDE.md` via `@AGENTS.md`; keep it accurate against the source.

## What casey is

casey is a thin, domain-configurable orchestrator for structured intake over
WhatsApp/Discord: anyone messaging is a reporter, and casey gathers a
structured record warmly, without interrogation. The actual domain --
report/ticket vocabulary, agent persona, thatcher entity schema, dashboard
labels -- is entirely config-driven (see "Configuration architecture"
below); this repo ships a generic IT/facilities-helpdesk demo config by
default. The original animal-disease-surveillance-for-rural-South-Africa
domain this project was first built for now lives as a separate, fully
self-contained config package: `AnEntrypoint/uhh` (private). Install it by
cloning with `--recurse-submodules` and running `node ./bin/uhh.js`, NOT via
`npx github:AnEntrypoint/uhh` -- this file advertised the npx path until
2026-09-08, and uhh's own README says in bold that it does not work: uhh
declares casey as `file:deps/casey`, and an in-repo `file:` dependency
cannot be resolved inside an npx-installed package. uhh had already removed
the same claim from its own `package.json` (its commit `d9af78b`, "stop
advertising an install path the README says does not work") and the
correction was never propagated here, which left the wrong version in the
more authoritative of the two places. The generic npx pattern below is still
real -- it just needs a `github:`-spec config package, which uhh is not.
A reporter defaults to the `reporter` tier
(casual, public, report-only); an operator may promote a trusted reporter to
`field_worker`, which unlocks agentic case-query access and location
check-ins so they show up on the operator map -- this tier mechanism is
domain-independent and unchanged by which config package is loaded. casey
amplifies the team's workflow -- it does not impose domain-specific rules or
escalation; priority stays with people.

## Configuration architecture

casey's domain (report/ticket field vocabulary, agent persona, thatcher
entity/workflow schema, dashboard field labels) is entirely config-driven,
resolved by `src/config-loader.js` at process start:

- `CASEY_CONFIG_DIR` (a deployer-set env var, e.g. set by `uhh`'s
  `bin/uhh.js` bootstrap script) points at a directory holding
  `thatcher.config.yml`, `report-fields.yml`, and `persona.cjs`. Absent,
  casey falls back to its own bundled `config/default/` (the generic
  IT-helpdesk demo) plus the repo-root `thatcher.config.yml`.
  **The three files do not share one resolver, and `config/default/` is not a
  complete config dir.** `config-loader.js`'s `loadDomainConfig()` reads
  `report-fields.yml` + `persona.cjs` from `CASEY_CONFIG_DIR` or
  `config/default/`, and throws if either is missing. `thatcher.config.yml` is
  resolved twice over, separately: by `case-store.js`'s `CaseStore`
  constructor and by `config-loader.js`'s `readThatcherFieldEnum`, each
  `CASEY_CONFIG_DIR`-or-`process.cwd()` (NOT `config/default/`). So
  `config/default/` ships exactly two files and the third comes from this
  repo's own root -- a deployer who copies `config/default/` as the template
  for a new config package gets a dir casey will boot against but whose
  entity/workflow schema silently comes from wherever the process happens to
  be running. Live-confirmed 2026-09-08: `casey doctor` from this repo reports
  `thatcher.config.yml present (<repo>/thatcher.config.yml)`, while the same
  binary run from `uhh` (which sets `CASEY_CONFIG_DIR`) reports
  `(<uhh>/config/thatcher.config.yml)`.
- `report-fields.yml` declares the report field vocabulary: `entity_label`
  (e.g. "report"/"ticket"), `enquiry_headline_fields` (the two fields safe
  to show in a cross-worker PII-free enquiry list), `tool_name`/
  `tool_description` (the `case_report` tool's own name/description), and
  `fields[]` -- each with `key`, `description` (becomes that field's tool-
  schema description), and optional `critical_for_visit` (on-site-visit-
  critical, feeds `case-health.js`'s `VISIT_CRITICAL` default),
  `append` (photos/audio-style fields that accumulate rather than
  overwrite), `never_inferred` + `never_inferred_guard_pattern` (a
  structural regression guard -- see below), `display_label` + `section`
  (dashboard `ReportSections` grouping, served via `/api/config`), and
  `severity_signal` (a field whose mere PRESENCE raises a case's attention
  rank -- `report-shape.js` derives `SEVERITY_SIGNAL_FIELDS` from it,
  `attn.js` adds a flat +7 when any such field holds a non-empty value, and
  `operations.js` publishes the set. Note what it is NOT: it reads no
  magnitude, so "1 dead" and "400 dead" score identically, and it lives
  inside the URGENCY score. It is not a severity axis and cannot drive a
  graded severity ramp -- see `.gm/research/severity-route.md` in `uhh`).
  Alongside `fields[]`, `report-fields.yml` may also declare `geo_fields`
  (read as `REPORT_GEO_FIELD_DEFS`): the `lat`/`lon` args `case_report`
  accepts as siblings of the report blob rather than as report fields,
  since they are case-level columns.
- `persona.cjs` (CommonJS `module.exports`, not ES `export` -- see
  `src/config-loader.js` for why: it must load synchronously via
  `createRequire`) declares the agent's system-prompt text: `domainIntro`,
  `gatherPriorityOrder`, `gatherLeadText`, `photoNudge`, `replyStyleRules`,
  `workerCatchUpText`, `casualReporterEnquiryBlockedText`,
  `returnedAfterGapText`, `entitySubjectPlural`, `entityLabel`. Consumed by
  `hooks/prompt.js`'s `caseSystemPrompt`, which still owns all *structural*
  prompt logic (the `<<DATA>>` delimiter safety, the stale-location check,
  the `returnedAfterGap` timing, the `firstMessage` branch) -- only the
  domain-specific TEXT comes from config.
- `thatcher.config.yml` is unchanged in shape from before this
  configurability work (see "thatcher / busybase chain" below) -- a deployer
  writes/adapts it the same way any thatcher-consuming project would.

`src/store/report-shape.js` is the single choke point: `REPORT_KEYS`/
`REPORT_KEY_ORDER`/`CRITICAL_FIELDS`/`APPEND_FIELDS`/`NEVER_INFERRED_FIELDS`/
`ENQUIRY_HEADLINE_FIELDS`/`REPORT_SECTIONS`/`fieldLabel` all derive from the
loaded config; every consumer (`case-store.js`, `case-tools.js`,
`case-health.js`, `dashboard/routes/operations.js`) imports these derived
exports rather than reading config directly, so a new consumer never needs
its own config-parsing logic.

**Two config-resolution models coexist: one-schema-per-process (casey/uhh)
and one-schema-per-record (serpent).** The models above are casey's default:
`CASEY_CONFIG_DIR` resolved ONCE at process boot into module-level constants,
correct for a deployment where every case/ticket/report shares one field
vocabulary. `report-shape.js` also exports `deriveReportShape(reportFields)`
-- the same derivation as a pure, standalone function -- so a deployer whose
domain needs MULTIPLE schemas coexisting in one running process (a different
field vocabulary per record, not fixed per process) can call it directly
with a per-record `reportFields` object instead of the module-level default.
This is purely additive: the module-level exports and every existing
consumer are unchanged. See `AnEntrypoint/serpent`'s `src/run-schema.js` for
the reference implementation -- `resolveRunSchema(runRow)` parses a stored
per-row `schema` JSON blob (same shape as `report-fields.yml`) and calls
`deriveReportShape()` with it, falling back to a bundled default when unset.

**`CASEY_EXTRA_PLUGINS_DIR`** (deployer-set env var, same discipline as
`CASEY_CONFIG_DIR` -- never contact-influenced) points `bootHost` at an
additional plugin root alongside casey's own `plugins/`, so a deployer
package can register its own tools under the `'cases'` toolset (visible to
the contact-facing agent's hardcoded, deliberately narrow
`enabledToolsets:['cases']`) without casey itself knowing anything about
that domain's tools. Absent, behavior is byte-identical to before this
existed. **Tool-name collisions across plugin roots are real and silent**:
freddie's `tools.register()` has documented "second registration wins"
behavior with no cross-root uniqueness check, so a deployer's own plugin
must use tool names that don't collide with anything freddie itself or
casey's own `plugins/case-tools/` bundle -- confirmed the hard way when
serpent's `research_note`/`research_consolidate` collided with a
same-named tool freddie's own repo had bundled under a different toolset
(fixed by removing freddie's bundled tool-registering plugin, keeping only
the underlying primitive functions importable from freddie's own package
root for a consumer to wrap under whichever toolset it needs).

**`CASEY_EXTRA_DASHBOARD_ROUTES`** (deployer-set env var, same discipline as
`CASEY_EXTRA_PLUGINS_DIR`) names a module whose default export is
`(app, {store}) => void`, called by `bin/worker.js` once `createDashboard`
resolves and every existing route module (including `auth.js`'s
session-resolving middleware) is registered -- so a mounted route can rely
on `req.caseyAccount` exactly like casey's own route modules do. `dash.app`
is the real Express app `createDashboard` already resolves as part of
`{app, server, port, close}`; the extension point exists because nothing
before it ever exposed that reference to a deployer. Same origin/port as the
dashboard SPA and every `/api/*` route -- the point of mounting here rather
than a deployer running its own separate-port server is that the SPA's
existing same-origin relative fetches (`src/dashboard/public/src/api.js`)
can reach a deployer's own endpoint with zero proxy/second-port plumbing.
Validated eagerly like `CASEY_EXTRA_PLUGINS_DIR`: a mistyped path throws a
named error at boot. Absent, dashboard boot is byte-identical to before this
existed. See `AnEntrypoint/serpent`'s `src/dashboard-routes.js` (mounted via
`bin/serpent.js` setting this var before importing `casey/bin/casey.js`) for
the reference implementation -- it replaced an earlier separate-port
`createResearchServer` design that ran on its own Express app/port under a
now-falsified assumption that `createDashboard` never exposed `app`.

**Structural regression guards stay config-aware, not domain-hardcoded.**
Both `hooks/prompt.js`'s `selfCheckLoadBearingPromptContent` and
`case-tools.js`'s `selfCheckLoadBearingToolDescriptions` run at module load
and throw if a load-bearing behavioral instruction (the two-item-question
rule, a `never_inferred` field's report-not-assert guard phrase) is silently
dropped by a future prompt/description edit. The `never_inferred` check now
iterates the active config's own `NEVER_INFERRED_FIELDS` (each carrying its
own `never_inferred_guard_pattern`) instead of a single hardcoded
`suspected_disease` check, so this guard is real under any config, not just
the animal-health one.

**Publishing a new config package (the `uhh` pattern).** A standalone
config package (own `package.json`, `bin/` bootstrap script, `config/`
directory) declares casey as a real `github:AnEntrypoint/casey#main` npm
dependency, sets `CASEY_CONFIG_DIR` to its own bundled config directory in
its bootstrap script before dynamically importing `casey/bin/casey.js`, and
is published as its own GitHub repo -- `npx github:<owner>/<pkg-name>
<command>` then boots casey fully pre-configured for that domain with zero
local config authoring. `AnEntrypoint/uhh`'s `bin/uhh.js` is the reference
implementation of the BOOTSTRAP half (env var, then dynamic import) but not
of the npx half: uhh declares casey as `file:deps/casey` against a submodule
checkout, which npx cannot resolve, so uhh is cloned with
`--recurse-submodules` and run as `node ./bin/uhh.js`. A package that wants
the npx path needs the `github:` spec instead.

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
| Agent runtime | `freddie` | `deps/freddie` | Real agent loop, tool registry, LLM seam, and local web server -- a Cordis plugin tree (`@freddie/cordis`), not an npm-importable flat package. freddie IS the agent for casey (see "freddie integration" below); casey's own transport (WhatsApp/Discord) and case tools mount into freddie's tree as Cordis plugins rather than freddie exposing a messaging-bot API of its own. |
| LLM provider chain | `acptoapi` | `deps/acptoapi` | Model resolution, chain fallback, sampler backoff. Reached through casey's own `freddie-bundle/src/llm-acptoapi` adapter (a real freddie `LlmAdapter` implementation registered on `ctx.llm`), never called directly by casey's app code. |
| System of record | `thatcher` (deps `busybase`) | `deps/thatcher` | Config-driven CRUD + workflow + RBAC + audit. Holds `case` / `event` / `contact` and the lifecycle state machine. |
| UI | `anentrypoint-design` | `deps/design` | webjsx + ripple-ui design system theming the dashboard. |

Editing a composed project: work directly in its `deps/<project>` checkout,
commit and push from inside that submodule's own repo, then bump the
submodule pointer in casey (`git add deps/<project> && git commit`) so the
fix is recorded here too. `thatcher`, `anentrypoint-design`, and `acptoapi`
are declared in `package.json` via a `file:deps/<name>` dependency spec
(`npm install` resolves them straight from the local submodule checkout, no
GitHub fetch, no npm registry). `freddie` is NOT declared in `package.json`
at all -- see "freddie integration" below for why it needs a different
resolution path entirely.

`deps/` is submodules only, never a vendor tree -- nothing under `deps/` is
committed as casey's own source. `thatcher`/`design`/`acptoapi` are never
imported directly either; `scripts/link-deps.mjs` symlinks (Windows:
junctions) `node_modules/<name>` straight at `deps/<name>` so casey's code
resolves them by bare specifier. Run `git submodule update --init
--recursive` after a fresh clone to populate `deps/`.

**freddie integration: freddie IS the agent for casey, not an npm dependency
casey calls into.** Upstream freddie's `main` was rewritten from a flat
"agent harness + Gateway with WhatsApp/Discord adapters" package into a
Cordis-based plugin-tree app (`@freddie/cordis`, ~220 tiny
`@freddie/freddie-*` packages, a `pnpm` workspace) with NO messaging-bot
primitives of its own left -- no `Gateway`, `bootHost`, `runTurn`,
`WhatsappAdapter`/`DiscordAdapter`. casey does not replace freddie with its
own turn-runner; instead, freddie's real `boot()` (`@freddie/freddie-app-boot`)
assembles the WHOLE running app -- transport included, not just the LLM
turn loop -- with casey's own plugins mounted alongside freddie's
`@freddie/freddie-base` bundle:

- `freddie-bundle/boot.js::bootCasey()` composes `@freddie/freddie-base`'s
  own `cordis.patch.yml` rows with casey's own (`freddie-bundle/cordis.patch.yml`)
  into one flattened patch array, then calls freddie's real `boot()`.
- `freddie-bundle/src/case-tools/index.js` -- casey's 18 `case_*` tools,
  reusing `src/case-tools.js`'s existing definitions/handlers unchanged,
  wrapped as real freddie `defineTool()` calls registered on `ctx.tools`
  (`schema-adapt.js` mechanically translates casey's plain-JSON-Schema
  parameter shape into freddie's own implicit property-map DSL).
- `freddie-bundle/src/llm-acptoapi/index.js` -- a real freddie `LlmAdapter`
  subclass wrapping acptoapi's own `chat`/`chatChain`/`buildAutoChain`
  in-process, registered on `ctx.llm` under the `acptoapi` provider route
  (mirrors freddie's own `llm-deepseek` package's registration pattern).
- `freddie-bundle/src/platform/index.js` -- wires casey's own WhatsApp
  webhook (`src/adapters/whatsapp.js`) onto freddie's real
  `ctx.webServer.register()` -- the one standing listening-socket seam in
  freddie's tree, on its OWN port (`CASEY_WEBHOOK_PORT`, default
  `127.0.0.1:4001`), deliberately clear of the dashboard's 4000: both
  defaulted to 4000 until 2026-09-08 and `bin/worker.js` boots the Cordis tree
  first, so freddie took the port and the dashboard died behind it with
  EADDRINUSE/exit 44 on a stock `casey up` -- and casey's own Discord adapter
  (`src/adapters/discord.js`,
  an outbound gateway-websocket client needing no listening socket at all).
  `WhatsappAdapter` therefore owns NO listening socket and has no `start()`:
  it kept a full express app plus a `WHATSAPP_WEBHOOK_PORT` for a server
  nothing ever launched, while this plugin carried a second, drifted copy of
  the entry-parsing/media-hydration logic that had lost the shared
  `emitWithDetachedMedia` helper. Both were collapsed (2026-09-07) into
  `whatsapp.js`'s exported `dispatchWhatsappWebhookBody(adapter, body)`, which
  this plugin calls; the plugin is now transport plumbing only (read body,
  verify, dispatch, ack). The webhook path is `adapter.path`
  (`WHATSAPP_WEBHOOK_PATH`, default `/webhooks/whatsapp`) on
  `CASEY_WEBHOOK_PORT` -- one answer to "where does Meta POST", not an env
  read in each file with different defaults. There is no
  `WHATSAPP_WEBHOOK_PORT`. Dispatch is synchronous and media hydration is detached, so the
  caller MUST ack as soon as it returns or Meta redelivers.
- `src/agent/run-turn.js` -- the thin adapter `hooks/handler.js` still calls
  as `runTurn(...)` (unchanged call signature, so casey's ~850-line
  guaranteed-delivery/rate-limit/dedup orchestration needed no rewrite): it
  creates/reuses a real freddie `Agent` per case (`ctx.agents.create()`),
  submits the inbound via `agent.followup(createUserMessage(...))`, awaits
  `agent.whenIdle()`, and reads the reply back from `agent.session.events`
  -- the exact pattern freddie's own `packages/bundle/headless` example uses
  end to end.

**The port left one dangling reference, and it was the outbound path
(fixed 2026-09-08).** `hooks/handler.js` resolved its adapter with
`this?.platforms?.get?.(platform)`. The old freddie Gateway exposed a
`platforms` Map; the port replaced it with `casey.js`'s `this.adapters`, a
plain OBJECT keyed by channel, and the two lookups were never updated. Since
`casey.js` binds the handler to the Casey instance (`handler.bind(this)`) and
Casey has no `platforms` at all, the optional chain short-circuited on every
turn and `adapter` was always `undefined`. `.bind` is permanent, so no caller
could have supplied a different receiver.

It reads like a dead typing indicator and is not. The same `adapter` backs the
guaranteed-fallback send and the agent's real reply, and
`freddie-bundle/src/platform` invokes `handleInbound(...).catch(...)`
discarding this handler's return value -- so `adapter.send` is the ONLY route
an agent reply has to a contact. Both delivery flags were also initialised
`true` above their own `if (adapter?.send)` guard, so a skipped send still
recorded the turn as delivered. That is what kept it silent.

Two lessons worth more than the fix. First, when a seam changes shape during a
port, grep for the OLD shape's accessor (`.get(`) as well as its name -- a
renamed property with a different access idiom fails silently under optional
chaining rather than throwing. Second, a "delivered" flag must not be
initialised to its success value above the branch that earns it; had it started
`false`, this would have surfaced as delivery failures on day one instead of
hiding for the life of the port.

Live-witnessed both ways: the real `makeCaseHandler`, bound to a receiver of
the shape `casey.js` builds and driven with a real inbound against a real
`CaseStore`, now calls `adapter.send` exactly once with the guaranteed-fallback
status message (and fires the typing indicator for the first time), where the
old expression against the same receiver returns `undefined` and reaches no
send at all. The remaining unwitnessed step is only the network hop inside the
adapter itself, which needs real channel credentials.

**SECURITY (the load-bearing replacement for the old `enabledToolsets`
contract): freddie's `ctx.tools` is ONE GLOBAL registry shared by every
mounted plugin, including `@freddie/freddie-base`'s own real
bash/write/edit/file/credential tools -- there is no toolset-category
filter at the freddie layer the way the old freddie's `enabledToolsets`
provided.** `freddie-bundle/src/case-tools/tool-allowlist.js::installToolAllowlist(agentCtx,
allowedNames)` is the real enforcement boundary, installed per-agent via
`ctx.agents.create()`'s `setup(agentCtx)` callback (never globally, so a
per-turn allowlist never leaks across concurrent conversations). Two
independent gates, defense in depth, both live-verified: (1) the
`system-prompt/assemble` waterfall hides every non-allowlisted tool's
schema from the prompt the model sees; (2) the `tools/pre-execute` waterfall
denies dispatch of any non-allowlisted tool by name even if the model
somehow names one outside its own visible schema (a hallucinated/leaked
name). `src/agent/run-turn.js`'s `runTurn()` derives the allowed-name set
from `enabledToolsets`/`disabledToolsets` (kept as `hooks/handler.js`'s
existing call-site params) against `buildCaseToolset(null)`'s real tool
names -- the same reporter-tier/field_worker-tier exclusion logic as before,
just enforced through freddie's real waterfalls instead of a
freddie-provided toolset filter.

`src/case-tools.js` remains the single source of truth for tool
names/descriptions/parameter-schemas/handler logic -- application-agnostic;
the store, field/enum/projection vocabulary, and role model arrive via a
per-turn `toolCtx`, now published through
`src/agent/run-turn.js::getCurrentToolCtx(sessionKey)` (a mutable cell keyed
by the case's session id, read by each tool's `execute(args, exec)` at
dispatch time via `exec.agent.id`) rather than a `plugins.case` config
object. CRM querying lives in thatcher: `list()` supports operator
where-objects (`{field:{$gte,$lte,$in}}`, `$or`), array tie-broken sort, and
opt-in row-access scoping.

**Resolving freddie's own packages: `pnpm install` inside `deps/freddie`,
then `scripts/link-deps.mjs` junctions each `@freddie/*` package into
casey's `node_modules`.** freddie's own package manifests use `workspace:^`
cross-deps that plain `npm install` cannot resolve at all (`EUNSUPPORTEDPROTOCOL`)
-- freddie is a real `pnpm` workspace (`deps/freddie/pnpm-workspace.yaml`,
`pnpm-lock.yaml`), and each of its ~220 packages already carries its OWN
correctly-pnpm-linked `node_modules` once `pnpm install` runs there once.
`scripts/install-freddie-deps.mjs` (wired into `postinstall`, before
`link-deps.mjs`) runs that `pnpm install`, degrading to a loud warning
(never a hard failure) when the submodule isn't checked out or `pnpm` isn't
installed. `scripts/link-deps.mjs` then scans `deps/freddie/{packages,vendor,native}`
to any depth for a real `@freddie/*` `package.json` and symlinks
`node_modules/@freddie/<pkg-name>` straight at it (Windows: NTFS junction,
not a plain directory symlink -- the latter needs elevated
privileges/Developer Mode, EPERM otherwise). Casey needs `pnpm` on the
machine for a fresh clone to resolve freddie at all; there is currently no
fallback path that avoids this.

**`scripts/scan-deps.mjs` deliberately EXCLUDES `deps/freddie`'s own
`node_modules` from its supply-chain walk** (confirmed live: an unbounded
walk through freddie's ~220-package pnpm-linked tree did not finish in 90+
seconds on Windows, versus ~2s for casey's own flat `node_modules` -- pnpm's
per-package isolated linking plus Windows junction/symlink overhead is
orders of magnitude slower to traverse than a normal hoisted npm install).
The walk skips every symlink/junction entry point under `node_modules`
entirely rather than descending into a foreign repo's own dependency tree
(the same discipline already applied to `thatcher`/`acptoapi`/`design`'s
`node_modules/<name>` junctions). `deps/freddie`'s own GIT-TRACKED SOURCE is
NOT exempt from scanning just because its `node_modules` is -- `scan-deps.mjs`
walks it explicitly via `walkFreddieSource()`, git-tracked-only (same shape
as `walkSource(ROOT)` for casey's own source), so freddie's source is never
silently excluded entirely. The one-time `pnpm install` cost (~4 min on a
cold cache) is separately bounded and does not run on every `casey doctor`
call, only `postinstall`.

**Worker identity = the channel author; a worker selects a case before
data-dumping into it.** A worker negotiates/selects a case which binds
active; a new case opens only on an explicit `case_new`. Every enquiry row
is projected to a whitelist that excludes `external_id`/`contact_id`, so a
list can never surface a phone number.

## Supply-chain integrity

casey's four composed dependencies -- `freddie`, `thatcher`,
`anentrypoint-design`, and `acptoapi` -- are consumed directly from each
project's own `main` branch tip with no npm-registry version pins, creating
a two-pronged supply-chain risk: a compromised commit on any repo's `main`
reaches casey's runtime on the next `npm install`/`pnpm install` (freddie's
own resolution mechanism now differs from the other three, see "freddie
integration" above, but the same risk shape applies), and obfuscated
malware (the "HiddenSpawn" class dropper, confirmed across 17+ repos in the
2026-08 incident) can hide in a file's trailing whitespace, evading
plain-text grep and human review.

**Discovery and verification (every session, every dependency touch):**
Before trusting any freshly resolved `node_modules` or updated submodules,
dispatch `scan_deps` with `{"full": true}` to screen for HiddenSpawn
signatures: a file with disproportionate byte-size vs line-count (>500x ratio)
plus four or more consecutive `\uXXXX` unicode escapes (never produced by real
code, characteristic of this attack class). `scan_deps` returns structured JSON
with `failCount`, `warnCount`, `blockedCount`, and detail arrays; treat
`failCount > 0` or `blockedCount > 0` as live evidence, not noise.

**Submodule management (always track main branch, never detached commits):**
This is the repo-local instance of a global rule (this developer's own
`CLAUDE.md`: zero stray branches -- consolidate to `main`, rename `master`
to `main`), applied to every `deps/*` submodule checkout, not just casey's
own branch. Every composed dependency in `deps/` is a live git submodule
whose checked-out HEAD must be a branch named `main` (not a detached commit
SHA). After any
`git submodule update`, verify no entry shows a commit hash without a branch
name in `git submodule status` output. Before committing submodule pointer
updates to casey, fetch each submodule's latest from origin and reset to
`origin/main` to ensure both the local checkout AND casey's recorded pointer
point to the same live main-branch tip. Use `git reset --hard origin/main`
(not `git pull`, which can fail with multi-ref FETCH_HEAD errors) to sync a
submodule before re-staging the pointer bump. `npm run check-submodules`
(also wired into `casey doctor`) mechanically checks this: branch name,
dirty state, and ahead/behind vs `origin/main` for every `deps/*` entry.

**Incident response (2026-08, thatcher's main branch):**
thatcher's `main` was compromised at commit `724e8bce` (injected obfuscated
dropper, flagged by Windows Defender as `Trojan:NPM/HiddenSpawn.IAF!MTB`),
discovered and reverted on `main` at commit `9977155`. casey was never run
against the compromised commit (incident detected within the same day).
Detection used the same signature-based scan (size/escape-density check, not
literal C2 IPs or cipher specifics). Mitigation: the release-automation
credentials that let `github-actions[bot]` push the malware were never
audited or rotated, and remain a standing gap -- a future automated release
could recur until the root cause (compromised workflow secret or bot token)
is found and closed. Standing monitoring: `scripts/scan-deps.mjs` runs on
every `npm install` (via `postinstall` hook) and on `casey doctor`, catching
new samples of this and similar attack shapes.

**That monitoring could not fail an install until 2026-09-08, and now can.**
`postinstall` was a single shell line ending `... && node
scripts/scan-deps.mjs || true`. In both `sh` and `cmd`, `||` binds to the
whole preceding `&&` chain, so the trailing `|| true` swallowed the
scanner's exit code along with everything else: a real hit printed
"Do not run `npm install`/`casey up` again..." into the middle of the
install log and npm still reported success. Live-witnessed both ways with a
planted signature file -- old line exit 0, new path exit 1, clean tree
still exit 0. The chain now lives in `scripts/postinstall.mjs`, which keeps
the tolerance on the three SETUP steps (they may legitimately fail with no
`pnpm`, no submodules, or an unwritable git dir, and now say which ones
degraded instead of going silent) and gives the security gate's exit code
straight to npm. When touching this, keep that split: the setup steps are
allowed to fail the machine, the scanner is allowed to fail the install.
A `file:` dependency's `postinstall` does run (verified on npm 11.19.0), so
a `uhh` deployer's own `npm install` is covered by this too.

**Runtime integrity (no instance-time hotpatching):**
Casey never imports from `deps/` at runtime; the submodule checkouts are
local-edit surfaces only. An update to a composed project's source requires:
commit + push to that project's own GitHub repo, then `npm install` in casey
(which fetches the updated main branch). No local-only change to `deps/` is
visible to casey's runtime. This means there is no way for casey to consume a
local, unvetted patch of a composed project without both that patch being
pushed to GitHub AND the submodule pointer being updated in casey's own
commit history.

## Source map

```
thatcher.config.yml        entities + case workflow (system of record; generic demo by default, see Configuration architecture)
config/default/            bundled default config package (report-fields.yml, persona.cjs) -- the generic IT-helpdesk demo
bin/casey.js               CLI: init / doctor / up / dashboard / cases / show / report
freddie-bundle/            casey's own Cordis plugins mounted into freddie's real boot() -- case-tools (defineTool wraps src/case-tools.js), llm-acptoapi (a real LlmAdapter), platform (WhatsApp/Discord wiring onto ctx.webServer), tool-allowlist (the security enforcement boundary)
src/
  config-loader.js         resolves CASEY_CONFIG_DIR (or config/default/) -- report-fields.yml + persona.cjs, synchronous
  store/report-shape.js    single choke point deriving REPORT_KEYS/CRITICAL_FIELDS/APPEND_FIELDS/REPORT_SECTIONS/etc from the loaded config
  casey.js                 top-level assembly: store + adapters + freddie boot (freddie-bundle/boot.js) + gateway shim + logger
  agent/run-turn.js        runTurn() adapter driving freddie's real Agent (ctx.agents.create/followup/whenIdle) instead of a casey-owned loop
  agent/acptoapi-bridge.js casey-side acptoapi bridge (media-tools.js/llm.js's own resolveCallLLM path -- NOT the freddie-bundle/src/llm-acptoapi one freddie's agent loop uses)
  adapters/                casey-owned WhatsApp/Discord transport (freddie's new architecture has none), wired into freddie's ctx.webServer by freddie-bundle/src/platform
  case-store.js            thatcher wrapper: find-or-create (locked), events, transitions, paging, optimistic-lock report merge
  case-runtime.js          process singleton so the plugin reaches the live CaseStore
  provenance-wire.js       additive bridge from case_report into the provenance subsystem (src/core/, src/packs/)
  case-tools.js            case_* tool defs (config-driven schema/descriptions); gateByTier wraps every query/mutation tool behind field_worker tier
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
  dashboard/public/src/map-model.js   the ONE model the map and the rail both read: the urgency ladder (attn.js score -> band) and the shared filter predicate
```

### Dashboard structure: the map is a home view, not a panel

The dashboard has two HOME VIEWS (`state.homeView`, `'map'|'cases'`) and a set
of content-swap PANELS (`state.activePanel`). The distinction is load-bearing
and was got wrong once in a way worth naming, because the failure is invisible
from the code alone: `dashboard_ui.default_view: 'map'` used to call
`openPanel('map')`, which set `activePanel` and therefore rendered the
PanelSwap path -- a legacy stacked map page -- so the deployment that actually
configures a map-first landing (`uhh`) never landed on the map-first command
centre at all. The layout was shipped and bypassed. `default_view` sets the
home view; there is no `'map'` panel any more, and only one map surface exists.

- `views/map-command-center.js` -- the map home view: the map pane plus ONE
  rail. The rail shows the worst-first queue (or a spatial rollup) when nothing
  is open, and the case detail when something is.
- `panels/map-panel.js` -- the map shell and the rail. The canvas is the whole
  pane; only the legend and an error/empty note may sit on it. Counts, filters,
  overlays and the queue are docked in the rail, never floated over the map
  (mapuipatterns' rule for situational-awareness domains: do not cover
  potentially important data with floating panels).
- `panels/map-leaflet.js` -- the imperative Leaflet driver. A pin encodes three
  independent channels in three different visual dimensions, deliberately:
  fill colour = status, border style = where the coordinate came from,
  size + ring = urgency from `attn.js`'s score. Urgency is size-and-geometry
  rather than a fourth fill colour so it survives a colourblind viewer and both
  themes.
- Hotspots (`geo`) and Related reports (`clusters`) are spatial answers, so on
  the map side they render in the RAIL with the map still mounted beside them
  (`state.railMode`), rather than unmounting the map to show a table. Both are
  still registered panels for the case-list side.
- `state.setActiveId` is the single publisher of "a case became active"
  (`onActiveIdChange`); the map subscribes. Assigning `state.activeId` directly
  skips that notification and is why opening a case used to leave the map
  wherever it happened to be -- do not reintroduce a direct assignment.

There is no automated test suite. Verification is manual/live: run `casey up`
against real freddie/thatcher/a real LLM provider and exercise the actual
conversation over Discord/WhatsApp or the dashboard.

**Query the live store as part of any audit, not just the source.** Reading
`data/db.sqlite` directly found a shipped, operator-visible bug that a whole
session of source review had walked past: `operator_identity.case_count` holding
`"111111111"`, which the map's coverage tooltip rendered verbatim (see the
busybase digit-string section above). Because busybase returns loosely-typed
values, the tell is a row value with an impossible SHAPE -- a run of identical
digits, a count that could never be plausible, a timestamp that is uniformly
zero across every row. Those are invisible in the code and obvious in the data.
There is no `sqlite3` binary in this environment; open the file with the
`@libsql/client` already in `node_modules`, or go through `CaseStore` when you
want the audited path (it is cwd-bound -- see the Conventions note).

## Dev workflow

```sh
# NOTE: a bare `npm install` at this repo's root currently CRASHES once the
# node_modules/@freddie/* junctions exist -- @npmcli/arborist throws "Cannot
# read properties of null (reading 'package')" while loading the actual tree
# across the 220 junctions link-deps.mjs creates. Confirmed by bisect: move
# node_modules/@freddie aside and npm install succeeds; restore it and the
# crash returns. It is not a resolution failure, but it is a hard stop, so use
# the two scripts directly until it is fixed:
node scripts/install-freddie-deps.mjs   # pnpm install inside deps/freddie
node scripts/link-deps.mjs              # junction thatcher/acptoapi/design + every @freddie/* package
node bin/casey.js init      # scaffold a .env (channel tokens, dashboard secret)
node bin/casey.js doctor    # green/red preflight: deps, channels, port, token
node bin/casey.js up        # gateway + dashboard (default http://localhost:4000)
npm run lint                # dependency-free preflight (syntax+config+package+ascii); the CI gate
npm run gui-check           # drives the real dashboard in real headless Chromium (needs a browser)
```

`npm run gui-check` is deliberately NOT part of `npm run lint`: lint is
dependency-free and must stay green in a bare clone with no browser, while this
boots the real Express app against the real sqlite store, drives headless
Chromium over CDP, and reads the rendered DOM. It adds no mocks and is not a
test suite -- it is the manual/live verification this file already mandates,
made repeatable, and it skips loudly with exit 0 when no chromium binary exists.
Every assertion in it is a regression that actually shipped at least once: the
map-first layout built but unreachable (`default_view` calling `openPanel`), the
mobile icon grid collapsing to a single column, the desktop full-bleed map not
being full-bleed because a transformed ancestor became the containing block, and
icon-only controls with no accessible name. Its own failure mode was checked the
only way that means anything -- by reintroducing the one-column bug and watching
it fail (`1 cols (640px)`, exit 1), then reverting.

**There is currently no CI workflow in this repo** -- `.github/` does not
exist in the tree, so nothing runs `npm run lint` automatically on push or
PR. Until a workflow is added back, `npm run lint` is a LOCAL gate that a
human or agent must run by hand before pushing; treat a green local lint as
the substitute for the pipeline this section used to describe, and say so
explicitly rather than claiming a pipeline witnessed the change. The lint
itself is dependency-free on purpose -- it does not need the
`anentrypoint-design` npm dependency installed, so it stays green in a bare
clone. It carries a
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
its path explicitly via `CASEY_RELOAD_PATHS=./deps/freddie/src`. Freddie's
own `@freddie/cordis-plugin-hmr` row (mounted by `@freddie/freddie-base`)
also exists inside its Cordis tree, but casey does not enable it -- editing
`deps/freddie`'s own source still requires a full `casey up` restart, not a
live plugin-tree reload.

`npm run check-submodules` (also run inside `casey doctor` when `deps/` is
populated) is a read-only report on every `deps/*` checkout: fails loud if
any submodule is on a branch other than `main`, has uncommitted changes, or
is behind `origin/main`. It never mutates git state -- fixing a reported
problem is the fetch+reset sequence in "Supply-chain integrity" below.

**A dirty submodule reported right after an install used to be a mode-only
artifact, and no longer is.** pnpm's bin-linking chmodded `deps/freddie`'s
`packages/examples/acp-demo/src/bin.js` and `vendor/cordis/bin.js`, and an
npm reify chmodded `deps/acptoapi`'s `bin/acptoapi.js` and
`bin/acptoapi-tui.js`, from 0644 to 0755 on every install -- zero
insertions, zero deletions, mode only -- so `check-submodules` (and
therefore `casey doctor`) went red immediately after the repo's own
documented install step, for a reason that had nothing to do with
supply-chain drift. Fixed upstream by recording 0755 in each of those two
repos' own index (freddie `7b5b9537`, acptoapi `b972911`), which makes the
installer's chmod a no-op rather than a diff. It was deliberately NOT fixed
by excluding those paths from `check-submodules`, which would also have
masked a real mode change. If a `deps/*` checkout ever reports dirty after
an install again, treat it as a real change to look at, not as this
known-benign artifact.

**Editing and pushing a composed dependency -- worked example (`deps/thatcher`,
same shape for `deps/acptoapi`/`deps/design`):**

```sh
cd deps/thatcher
# ... make the fix ...
git add -A
git commit -m "fix: whatever the fix is"
git push origin main            # thatcher's own GitHub repo, not casey's

cd ../..                        # back to casey root
git add deps/thatcher
git commit -m "chore(deps): bump thatcher submodule pointer"
npm install                     # casey's runtime node_modules now has the fix
```

The submodule-pointer commit in casey and the `npm install` are both
required: the pointer bump keeps `deps/thatcher` in sync for the next
`git submodule update`, but casey's own runtime code never imports from
`deps/` (see Architecture above) -- only `npm install` refreshes what
`node_modules/thatcher` actually resolves to.

**`deps/freddie` follows a DIFFERENT shape** (see "freddie integration"
above): after pushing a fix to freddie's own repo and bumping casey's
`deps/freddie` pointer, run `pnpm install` inside `deps/freddie` (not
`npm install` at casey's root -- freddie's own packages use `workspace:^`
specs npm cannot resolve), then `node scripts/link-deps.mjs` from casey's
root to refresh the `node_modules/@freddie/*` junctions. `scripts/install-freddie-deps.mjs`
(wired into casey's own `postinstall`) already does the `pnpm install` step
automatically on a fresh `npm install` at casey's root.

### Kit consumption strategy (fleet-wide)

**casey itself is the exception, not the pattern below.** casey declares
three of its four composed deps (`thatcher`, `acptoapi`, `anentrypoint-design`)
as local `file:deps/<name>` npm refs, not `github:` specs -- a fresh clone's
`npm install` otherwise stalls npm's git-dep preparation for these repos even
when the trees are already mounted as submodules (see the `chore(deps):
resolve the 6 submodule deps via local file refs` commit). This means casey's
own `npm install` resolves each composed dep straight from its already-
checked-out `deps/<name>` submodule, so `deps/` is no longer purely an
editable-local-clone-with-a-separate-runtime-fetch as the rest of this
Architecture section describes for other Node-resolved consumers -- for
casey specifically, editing `deps/<name>` in place and running `npm install`
IS enough to pick up the change locally, no push required first. A push to
`deps/<name>`'s own repo is still required before any OTHER consumer (a
fresh clone, CI, a different machine) sees the fix, since only casey's own
`node_modules` resolves against the local submodule checkout.

Every other Node-resolved consumer of `anentrypoint-design` -- and any
future non-casey consumer -- declares it as a `github:AnEntrypoint/Design#main`
npm dependency, so `npm install` fetches the package directly from GitHub's
`main` branch tip rather than the npm registry: `npm install` remains the
only mechanism that can populate `node_modules` for a package a Node
process directly `import`s, but the resolution source is each project's own
GitHub repository instead of the npm registry -- there is no way to
CDN-serve a package into Node's module resolver, so `github:` is the
closest real equivalent of "always latest from GitHub" for a server-side
dependency. `freddie` no longer fits this pattern at all -- it is now a
`pnpm` workspace resolving its own deps via its own lockfile, not an
npm-importable package any consumer (including its own former self)
declares as a `github:`/`file:` spec (see "freddie integration" above). Two
consumers are deliberately excluded from the `github:`-spec strategy and
must stay excluded: `gmsniff` (must run air-gapped, zero external-origin
runtime fetches -- never give it a CDN load or runtime dependency) and
`agentgui` (vendors the built kit locally for offline operation and UI
stability). Accepted tradeoff for every `github:`-spec consumer: a push to
`main` can change that consumer's runtime behavior or dashboard UI with no
commit of its own, and with no version pin to roll back to (a `github:`
spec has no npm-published version history) -- if a broken build lands on
`main`, that consumer's next `npm install` picks it up immediately. casey
does not carry this specific tradeoff for its `file:`-spec deps (a `file:`
ref only moves when casey's own submodule pointer is bumped and committed),
but inherits the equivalent risk one level down: an untrusted `deps/<name>`
checkout (a bad `git submodule update`, an unreviewed pointer bump) is
trusted immediately on the next `npm install`, with no separate fetch step
to catch it -- this is exactly why `scan_deps`/`scan-deps.mjs` runs on every
`npm install` and `casey doctor` (see Supply-chain integrity above).

## Environment

Most variables are self-describing from their name and the code that reads
them. This table covers only the ones whose default/behavior is not obvious
from the name alone.

| Variable | Non-obvious behavior |
|----------|-----------------------|
| `WHATSAPP_APP_SECRET` | Required (not merely recommended) when WhatsApp credentials are configured -- `casey up`/`casey doctor` hard-fail without it. |
| `CASEY_WEBHOOK_HOST`, `CASEY_WEBHOOK_PORT` | The freddie Cordis tree's own WebServer row (`freddie-bundle/cordis.patch.yml`, `casey-webserver`), default `127.0.0.1:4001`. This is a DIFFERENT socket from the operator dashboard, which keeps 4000 via `--port`. Both defaulted to 4000 until 2026-09-08, and `bin/worker.js` boots the Cordis tree before the dashboard, so freddie bound 4000 first and the dashboard died behind it with EADDRINUSE and exit 44 on a stock `casey up`. The row carries exactly one route -- `WhatsappAdapter`'s webhook -- so a WhatsApp deployment publishes THIS port to Meta as the callback URL, not the dashboard's. Deployment-visible, not an internal detail. There is no `WHATSAPP_WEBHOOK_PORT`; `WHATSAPP_WEBHOOK_PATH` still names the path on this port. |
| `CASEY_SESSION_SECRET` | Random per process start when unset, so a restart invalidates every session. Set explicitly for sessions to survive a restart. |
| `CASEY_OPERATORS` | Removed. The roster now reads from the `operator_account` table directly; setting this has no effect. |
| `CASEY_LLM_MODEL` | Default `claude/sonnet`, chosen because a weaker model has repeatedly dropped tool calls or repeated questions during casey's multi-step extraction+tool-orchestration turn. `auto` builds acptoapi's real fallback chain rather than pinning one model. |
| `CASEY_TZ`, `CASEY_TZ_LABEL`, `CASEY_COUNTRY_CODE` | Default to a South African deployment (SAST, +27, SA-shaped digit grouping); digit-grouping stays SA-shaped regardless of country code (a fully correct international formatter needs a per-country grouping table, out of scope). |
| `CASEY_TRANSCRIBE_VOICE_NOTES`, `CASEY_DESCRIBE_PHOTOS`, `CASEY_VOICE_REPLIES` | All three off by default and fail-open: each sends real bytes (audio/image/text) to an external API, a deliberate opt-in data-egress point. Any failure degrades silently to the original text-only/manual path, never blocking the reply. |
| `CASEY_LOCATION_STALE_MS` | Read once from `process.env` at module load, not via the async thresholds store -- `caseSystemPrompt` is deliberately a pure, synchronous function. |
| `CASEY_MEDIA_TOOL_TIMEOUT_MS` | The three media tool calls run before `turnStartedAt` is set, so without this timeout they sit entirely outside the turn hard-deadline and could hang the per-contact concurrency gate indefinitely. |
| `CASEY_TRUST_PROXY_HOPS` | Unset means `req.ip` is the raw socket peer, so the public `/report` form's rate limiter sees every request behind a real proxy as the same address. Set too high/untrusted and a client can spoof `X-Forwarded-For` to bypass the limiter. |
| `CASEY_MINE_SCAN_LIMIT` | Only bounds the fallback scan for legacy cases predating `author_key` (current cases scope via a real equality where-clause, not a scan). |
| `CASEY_EXTRA_DASHBOARD_ROUTES` | Names a module (`(app, {store}) => void` default export) mounted onto the real dashboard Express app after `createDashboard` resolves and all of casey's own route modules register -- see the Configuration architecture section for the full contract. Unset means byte-identical dashboard boot to before this existed. |
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
- `ACPTOAPI_CHAIN_LINK_TIMEOUT_MS`: Per-provider timeout for each hop through the ranked candidate list.
  acptoapi's own shipped default (`node_modules/acptoapi/lib/chain-machine.js`'s
  `DEFAULT_LINK_TIMEOUT_MS`) is **120000 / 120 sec** -- NOT 20s; this drifted
  upstream from an earlier 20s default this doc used to document. acptoapi is
  consumed via `file:deps/acptoapi` against the local submodule checkout (see
  Architecture), so casey's `npm install` picks up whatever default the
  currently-checked-out `deps/acptoapi` ships -- a submodule pointer bump, not
  a floating remote fetch, is what changes it. Live-confirmed 2026-09-08:
  `casey doctor` run from this repo's root reports
  `ACPTOAPI_CHAIN_LINK_TIMEOUT_MS=120000ms (acptoapi's installed default
  (chain-machine.js)) >= per-attempt budget 120000ms` as a red check.
  At the shipped default, a SINGLE unhealthy provider hop can
  consume the entire per-attempt/hard-deadline budget, leaving zero room for
  `hooks/handler.js`'s `MAX_TOOL_CHOICE_ATTEMPTS` retry loop -- so a deployment
  must set `ACPTOAPI_CHAIN_LINK_TIMEOUT_MS` explicitly rather than trusting the
  upstream default. This repo ships no `.env` of its own, so a bare `casey
  doctor` here goes red on this check; `uhh`'s `.env` (and its `.env.example`)
  set `ACPTOAPI_CHAIN_LINK_TIMEOUT_MS=30000`, and `casey doctor` run from `uhh`
  goes green on the same check. A fresh deployment with no explicit override
  inherits the wider 120s default silently. `casey doctor` flags a per-link
  timeout that is not comfortably below the per-attempt budget (see its own
  check).
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
Hard deadline (120s) >= Soft deadline (25s) [x]        -- tone changes partway through wait
Hard deadline >= Per-attempt timeout (120s) [x]       -- retries fit within hard budget
Per-attempt >= Per-link timeout (uhh .env: 30s) [x]   -- full chain walk completes per attempt
                                                          (acptoapi's OWN shipped default is
                                                          120s, equal to the per-attempt budget --
                                                          uhh's .env overrides to 30s; with no
                                                          deployment .env this row FAILS, which is
                                                          what casey doctor reports in this repo)
Per-link >= Readiness/discovery timeouts [x]          -- inner probes complete before outer
Chain-link (uhh .env: 30s) * max retries (3) + buffer   -- with the 30s override, up to 3
                                                          attempts still cannot each complete a
                                                          multi-hop chain walk inside the 120s
                                                          hard deadline if more than one hop is
                                                          unhealthy; a single bad hop can still
                                                          consume most of one attempt's budget
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
- `GET /api/health/provider` shows pending queue depth and dead-lettered count
  (`queued_turn_count`/`dead_lettered_count`, from `casey.queueStatus()`). There
  is no `/api/queue` route; this line named one until 2026-09-07, and a live
  authed request for it 404s.
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
- **A COORDINATE IS THE ONLY THING THE MODEL MAY GUESS.** Everything else is
  recorded as the person actually said it, or left out. lat/lon are the single
  sanctioned inference: the model places a described location from its own world
  knowledge, and is told to do so confidently when the description is
  identifiable and to leave both out when it genuinely is not. Every other field
  is report-not-assert -- a count is the number or the words they gave and never
  a conversion of "a lot" into a figure, a species is what they said the animals
  are and never a deduction from symptoms, a disease name is one somebody
  actually said. `never_inferred` + `never_inferred_guard_pattern` in
  `report-fields.yml` make that structural for the fields where a guess would do
  the most damage (`suspected_disease`, and `dead_count`, which feeds the
  attention ranking): the guard phrase must survive any future description
  rewrite or `case-tools.js` throws at module load.
  **The corollary is that a guessed coordinate must always LOOK guessed.** Both
  map overlays carry `location_source` on the gps/estimated/confirmed ladder and
  render an unconfirmed estimate differently -- a case pin through its border
  treatment, a worker pin through a dashed stroke. A check-in or report whose
  provenance nobody stated resolves to `estimated`, never silently to a fix.
  Anything else the model produces and an operator reads -- a photo
  auto-description, a voice-note auto-transcript -- names the AI helper as its
  author, so machine output is never mistaken for a person's words.
- **Enquiries and status are PII-free.** Every worker-facing projection
  excludes `external_id`/`contact_id`. "Worker-facing" means what goes back
  out to the reporting field worker over their own channel (`case-tools.js`'s
  `enquiryRow`, the tier gating, the agent's replies) plus every aggregate
  rollup -- it has never meant the authenticated operator console, which
  necessarily shows a contact number so an operator can ring back the person
  reporting a dying herd (`contacts.js`'s `publicContact`,
  `/api/cases/:id/report.html`'s `tel:` link, the case-detail header's copy
  affordance). The operator-console rule is a SHAPE rule instead, stated in
  full under Security invariants below.
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
  an `unresolved` bucket rather than being dropped, and no spatial filter may
  be what makes it disappear: a case with no position is not "outside the
  viewport", it is nowhere, so the extent filter never applies to it.
- **The map and the queue must not be able to disagree about the same case.**
  They are two views of one dataset on one screen, so both the urgency ladder
  and the filter predicate live once in `dashboard/public/src/map-model.js` and
  are imported by both. Every time these were derived twice, the two halves
  drifted and said different things at the same moment -- the map showed status
  while the rail showed urgency; the rail head counted 14 while the list under
  it showed 5. Do not add a second local copy of either derivation.
- **A cap on a list is stated in the UI, with the true total beside it.** A
  silently truncated triage queue in a disease-surveillance deployment means
  report 6 is invisible and nothing says it exists -- that is a safety
  property, not a cosmetic one.
- **An empty map says WHY it is empty.** "Nothing has happened yet", "your
  filter hid everything", and "everything is missing a location" are three
  different facts, and rendering all three as a blank map tells the operator
  none of them.
- **Management aggregates are aggregate-only and never emit `external_id`,**
  including from nested fields (e.g. a delivered-reply event's `data.to`).

## Security invariants (do not regress)

- WhatsApp inbound is HMAC-SHA256 verified when `WHATSAPP_APP_SECRET` is set;
  that secret is required, not optional, when WhatsApp credentials exist.
- Dashboard API + page gate on a logged-in session (username/password per
  operator_account, scrypt-hashed, stateless HMAC-signed session cookie). No
  route accepts a bearer token or a `?token=` query param. The only ungated
  routes -- the literal exemption list in `routes/auth.js`'s `authGate()`,
  plus what `registerAuth` mounts ahead of it -- are `/design`, `/vendor/*`
  (static assets, no case data), `/api/login`, `/api/logout`, `/api/whoami`,
  `/api/ready` (orchestrator/LB liveness probe -- a boolean + a short error
  string, no case data), `/api/branding` (dashboard_ui.brand/leaf only -- the
  two display strings the post-login shell already renders, so login-gate.js
  can show real branding before a session exists; never the full `/api/config`
  shape), the public `/report` form (gated by knowledge of a case ref, not
  auth), the SPA shell itself (`/`, `/index.html`, `/app.js`, `/app.css` and
  the whole `/src/*` module tree -- shell code with no case data; gating it
  would 401 before the browser could render a login form) and the PWA assets
  (`/icon.svg`, `/manifest.json`, `/sw.js`, `/offline.html` -- a service
  worker cannot register if fetching its own script needs a session).
  `/media` is NOT on that list: it serves real field-worker photo/voice-note
  bytes and is mounted after the gate. `/api/change-password` is mounted
  ahead of the gate but does its own `req.caseyAccount` check, so it 401s
  unauthenticated like any gated route. Live-verified 2026-09-08 against the
  running dashboard: `/`, `/app.css`, `/icon.svg`, `/manifest.json`, `/sw.js`,
  `/offline.html`, `/report`, `/api/ready`, `/api/branding`, `/api/whoami`
  and `/vendor/leaflet/leaflet.js` all 200 with no session, while `/media/`,
  `/api/cases`, `/api/config`, `/api/change-password` and every other
  `/api/*` route 401. Admin-only routes additionally require `role: 'admin'`.
- All contact-supplied text is HTML-escaped before render.
- Session-cookie and password comparisons use `crypto.timingSafeEqual` to
  prevent timing oracles.
- **No dashboard route ever returns a raw case or contact row.** A row reaches
  JSON only through an explicit field allowlist -- `caseListProjection()` /
  `caseDetailProjection()` in `routes/cases.js`, `publicContact()` in
  `routes/contacts.js` -- never a spread and never the row itself, so a column
  added to the case table is never auto-exposed. Three fields may never be
  emitted by any of them: `external_id` (the raw channel routing key),
  `author_key` (the same value again) and `contact_id` (an internal join key
  with no operator use). What an authenticated operator MAY see is the DISPLAY
  form of the contact number -- `external_id_formatted`, via `format.js`'s
  `fmtPhone27` -- and only on a single case they have explicitly opened
  (`GET /api/cases/:id`, `PATCH /api/cases/:id`, `POST /api/cases/:id/transition`,
  which must all return the same projection). The case LIST stays PII-free:
  `/api/cases` carries no contact number, the case-list search therefore cannot
  offer one, and a 50-row poll is no place to move 50 phone numbers.
  `scripts/lint.mjs`'s pii-safety gate enforces all of this by dataflow -- a
  row bound off a `store.getCase`/`updateCase`/`listContacts`-class call and
  handed to `res.json()` with no projection between them fails the build, as
  does a projection that starts emitting one of the three fields or spreads its
  row. The gate previously matched only a literal `{ ...c }` spread, a shape the
  route files never contained, and so missed a real leak for as long as it
  existed.

**Dashboard authentication audit (2026-08-21):** Complete security audit of
`dashboard/auth.js` and `routes/auth.js` verified all seven threat categories:
(1) Password hashing via `crypto.scryptSync(password, salt, 64, {N:16384,...})`
-- scrypt KDF with Node's recommended parameters, no plaintext fallback.
(2) Session tokens are `base64url(json).hmac_sha256(secret)` -- unforgeable
without CASEY_SESSION_SECRET. (3) Both password and cookie comparisons use
`crypto.timingSafeEqual` -- timing oracle attacks eliminated via constant-time
compare. (4) Session resolution reads cookies only, rejects bearer tokens and
query-param auth entirely. (5) Logout sets cookie to empty value with Max-Age=0
-- browser deletes immediately. (6) All dashboard routes except /login, /logout,
/whoami, /report, static assets, and the SPA shell require valid session
(req.caseyAccount non-null). (7) Admin-only routes check role=admin from live
operator_account row (never from cookie). Session epoch revocation (changePassword
/ revokeAccountSessions) forces re-login across all devices with no session-table
storage. Bootstrap admin created once on first boot with forced password change.
Ten authorization bypass attempts tested; all rejected (tampered cookie, expired
token, query-param injection, bearer token, weak password brute-force, timing
oracle, epoch revocation, CSRF, disabled accounts). That is the full extent of
what this audit covered -- ten cases, all passing. It is not a clean bill of
health for the auth surface, as the correction immediately below shows.

**Correction to that audit (2026-09-08): its eleventh case was missing, and it
failed.** The audit tested DISABLED accounts but never DELETED ones. thatcher
deletes are SOFT -- the row stays with `status='deleted'` -- and while
`listAccounts` uses `t.list`, which filters those out, the session middleware
resolves through `getAccount`, which is `t.get` and does NOT. The middleware
checked `disabled` and the session epoch but never `status`, so deleting an
operator revoked nothing: live-witnessed, `/api/login` correctly returned 401
while that account's existing cookie still returned `whoami` 200 with
`role: admin`. A removed operator kept full access until their cookie happened
to expire. Now closed by two independent gates -- the middleware refuses a
`status='deleted'` account, and `deleteAccount` bumps `session_epoch` before
removing the row so every outstanding token for it fails the epoch comparison.
The general lesson is worth more than the fix: a soft-delete store means
"deleted" is a FIELD, and every read path that authorises has to honour it;
`t.get` and `t.list` do not agree about visibility, and only one of them was
being used for the authorisation decision.

## thatcher / busybase chain

casey consumes thatcher via a `file:deps/thatcher` dependency spec resolving
against the local submodule checkout (it used to be
`github:AnEntrypoint/thatcher#main`; see "Kit consumption strategy" below for
why that changed), so `case-store.js` calls thatcher's operator-where directly
with no runtime feature-detect and no fallback.

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
patched in a casey-side copy.

**busybase binds numeric columns as TEXT, so every number read off a row
arrives as a digit string.** This has now produced two separate shipped bugs,
in two different directions, and both readers and writers have to defend
against it:

- *Reading a timestamp.* Timestamps come back as numeric-seconds strings
  (e.g. `"1782977388"`), and a bare `Date.parse` on one is `NaN`. Parse row
  timestamps with `timestamp.js`'s shared `tsMs` (the single implementation
  that replaced the near-identical `attn.js` tsMs / `case-health.js` ms /
  `case-sweep.js` tsMs copies -- do not reintroduce a fourth) or
  `format.js`'s `toDate`, never bare `Date.parse`/`new Date(x).getTime()`.
  Shipped instance: `buildClosureCompleteness` pinned `closure_completeness`
  at zero for every deployment, because its `Number.isFinite` guard rejected
  every event.
- *Writing an integer.* Arithmetic on a row value CONCATENATES instead of
  adding: `"1" + 1` is `"11"`. Coerce with `safe.js`'s `rowInt()` before any
  arithmetic on a column read back from a row. Shipped instance:
  `case-store.js`'s `learnOperatorActivity` did `(existing?.case_count || 0) + 1`,
  so nine operator actions stored `case_count` `"111111111"` and the map's
  operator-coverage tooltip rendered it verbatim as "111111111 case action(s)".

- *Writing a number into a version-guarded patch.* The trap is not read-side
  only. Passing a JS number in a patch that also carries `expectedVersion`
  makes the optimistic-concurrency check fail every time, while the write
  still lands -- once per retry. Witnessed against a real store:
  `updateCaseChecked(id, { lat: -29.1, lon: 30.4 })` returned "update conflict
  after 3 retries -- not applied" with `lat` reading back `-29.1` and
  `_version` gone 0 -> 4; the same call with `'-29.1'`/`'30.4'` returned ok at
  `_version` 1. Text-typed columns are unaffected in both shapes, so it is the
  JS number, not the field. The damage was the false failure handed back, not
  lost coordinates: `case_report` bails out on that error, so a report carrying
  a location skipped its timeline event, its provenance observation, the
  contact's `last_report_*` propagation and the derived
  `normalized_location`, and told the agent the write had failed.
  `store/guards.js`'s `toStorable()` is the write-side guard -- finite numbers
  become their decimal string, while `null`, `undefined`, booleans, strings and
  NaN/Infinity pass through untouched (`null` is a real "clear this column" and
  must not become `"null"`).

The general rule: a value off a busybase row is a string until you coerce it,
and a number going back in is a string until `toStorable` makes it one.
`Number.isFinite`/`||`-guards do not save you on the read side --
`"111111111"` is truthy and `Number("111111111")` is finite; only coercing at
the read edge does.

## Provenance subsystem (src/core/, src/packs/)

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
`casey-maximize-quality`'s 2026-08-11 audit and removed. The same audit shape
repeated on 2026-09-07 (`uhh-sweep-server`) and removed a second unreferenced
tier left behind by the first: `core/event-log.js` (a pass-through wrapper
naming RawLog "the event log", plus a `rebuildProjection` one-liner),
`core/escrow-export.js` (a JSONL escrow dump reading that wrapper),
`core/quality-flags.js`, `core/reputation.js`, `core/subject.js`,
`core/pack-loader.js` (a versioned-migration `PackRegistry` whose multi-hop
resolver was a hardcoded `return false`), and `packs/water-point.js` (a
second-domain pack whose own header called it an "acceptance test" that
nothing ever loaded). Also removed: `src/provider-health.js`
(`ProviderHealthTracker`), whose only would-be consumer,
`GET /api/health/provider`, had already been rewired away from it and
carries a comment saying why. Only `raw-log.js`, `write-path.js`,
`pack-schema.js`, and their direct dependencies (`observation.js`,
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
That enforcement is real only because `provenance-wire.js` calls
`core/pack-schema.js`'s `loadPack(animalHealthPack)` at MODULE LOAD, the same
throw-at-import discipline as `hooks/prompt.js`'s
`selfCheckLoadBearingPromptContent` and `case-tools.js`'s
`selfCheckLoadBearingToolDescriptions`. Until 2026-09-07 nothing called
`validatePack`/`loadPack` from a live path at all, so the sentence above
described an intention rather than a mechanism; keep that call site, it is
the whole gate. Live-witnessed both directions: a pack with
`unknownAllowed: false` on one field throws at import with the field named;
the shipped pack imports clean and `recordProvenanceObservation` still writes.
`scripts/lint.mjs`'s `trust-boundary` gate forbids any `src/packs/*.js` file
from importing `src/core/`.

**Only part of a pack is evaluated.** `provenance-wire.js` reads exactly
`observationForms.<form>.fields` (as the allowlist of which `case_report`
fields become provenance-tagged findings), plus `id` and `version` for the
stamp. `rules`, `views`, `roles` and `strings` are declared in
`animal-health.js` and schema-checked by `pack-schema.js`, but nothing
evaluates them -- the rule evaluator that would have read `rules` is one of
the dead tiers removed above. They are a documented target shape for a future
deployment pack, never live behaviour; do not describe a pack rule as
something casey acts on.

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
- thatcher's sqlite handle is cwd-bound and primed at init. The real file is
  `<cwd>/data/db.sqlite`, not `app.db`: thatcher's own `databasePath` option
  only contributes its directory (`databasePathToDir()` strips any filename),
  and busybase (the libsql-backed store thatcher delegates to) hardcodes
  `db.sqlite` as the file it actually opens, regardless of what filename
  thatcher's option named. Re-importing the accessor forks a second handle.

@.gm/next-step.md
