# AGENTS.md

Operating notes for agents (and humans) in the casey repo; included by `CLAUDE.md` via `@AGENTS.md`. Every claim is true of the tree NOW -- change the line describing a change in the same commit. Past incidents belong in git history.

## What casey is

A thin, domain-configurable orchestrator for structured intake over WhatsApp/Discord: anyone messaging is a reporter, and casey gathers a structured record warmly. The domain (field vocabulary, persona, thatcher schema, dashboard labels) is config-driven; this repo ships a generic IT-helpdesk demo, and the animal-disease deployment is the separate private package `AnEntrypoint/uhh`.

### Contact access ladder (`src/contact-tiers.js`)

The one authority. `TIER_ORDER` (low->high) IS the ladder; every question asks "does this reach at least rung N" (`atLeast`/`canQueryCases`), never "exactly N". `resolveTierValue` fail-closed maps missing/empty/pre-migration/corrupt to the LOWEST rung in ONE place.

| value | reaches |
|---|---|
| `reporter` | Default. File/amend own report + the two irreversible controls (`REPORT_ONLY_TOOLS`). |
| `field_worker` | + case query (`case_list/mine/today/get`), `case_switch/update/split`, location check-ins on the operator map. (uhh labels it "Eco Ranger".) |
| `animal_health_technician` | + EXCLUSIVE authority to move a report to a done stage. |
| `operator` | + team management (queue, reply, assign, invites); `canSignOff` is equality so it does NOT inherit sign-off. |

- **Only an admin may grant operator OR technician** (`grantableBy(isAdmin)` is the one filter every grant route uses). **`=== 'field_worker'` is a silent bug once a rung sits above it**: use `atLeast`/`canQueryCases`; `selfCheckLoadBearingPromptContent` composes the TOP rung's prompt and throws if an elevated instruction is missing.

- **Adding a rung is additive; renaming one is a migration.** `contact.tier`/`case.reporter_tier` (historical snapshot) hold the stored strings; different WORDS = a label via `report-fields.yml` `dashboard_ui.tier_labels` -> `TIER_LABELS` -> `/api/config` -> `tierLabel()`.

- **`canSignOff` is EQUALITY on purpose** (a named clinical responsibility). Sign-off needs three refusals in order: mandatory facts, technician authority, then `signoff_diagnosis` fields; field-completeness is checked FIRST. **Mandatory minimum** (`report-fields.yml` `mandatory_minimum`) is enforced at three code points (a `case_transition` REFUSAL, its tool description, and the prompt); it gates the AGENT tool surface only, so a dashboard operator can still close a real report.

- **A record is held only by someone who can act on it**: demotion or deleting a field login releases every open record (`releaseCasesHeldBy`); no path assigns a record to the person whose own chat it is (`isOwnConversation`); claim/dispatch read-check-write under one lock per record. **Erasure reaches the role** (`_scrubRoleReferences`); retention never expires a `channel:'system'` singleton.

- **Roles arrive by exactly two mechanisms, neither reachable from free text:** operator assignment (`POST /api/contacts/:id/tier` or `/register`; `normalizeMsisdn` refuses an SA number that is not 27+9 digits), or a one-time code consumed by `hooks/role-registration.js` AFTER admission and BEFORE any case/agent turn, only for a message that is nothing but a code (`extractCode` strict), so the model never sees it (append-only audited `role-invites` singleton, SHA-256 only, single use, 72h, never DEMOTES, 5 wrong guesses/hour/contact); a longer message's code is stripped. Both end in `setContactTier`; WRITE refuses an unrecognised value, READ coerces a corrupt one to the lowest rung. Bulk: `casey roles invite ... --count N`, `casey roles import`.

## Several people on one phone

A phone number names a CHAT, not a person: one contact row with the PEOPLE tracked beside it (`src/phone-persons.js`, append-only audited singleton, opaque letters-only ids; no reader returns a phone number). **Who is writing is the MODEL's call, via `case_speaker`** (every tier); it never guesses; the current speaker clears after `CASEY_SPEAKER_GAP_HOURS` (8). With TWO+ people the prompt asks ONCE who is speaking when nobody is recorded, then never again; a different person starts a NEW report unless it is the same animals; PRIVACY BETWEEN PEOPLE. **`reported_by`** (`system_set: true`) is shown everywhere, never offered to model/team/public, dropped by `mergeReport` unless `system: true`. **STOP/HELP stay per PHONE.** **Erasure** scrubs every person, or one via `POST /api/contacts/:id/persons/erase`, then overwrites name/relation LAST.

## Configuration architecture (`src/config-loader.js`)

- **`CASEY_CONFIG_DIR`** holds `thatcher.config.yml`, `report-fields.yml`, `persona.cjs`; absent, casey falls back to bundled `config/default/` plus the repo-root `thatcher.config.yml`. **The three files do not share one resolver, and `config/default/` is not a complete config dir:** `report-fields.yml`/`persona.cjs` come from `CASEY_CONFIG_DIR` or `config/default/`, but `thatcher.config.yml` is resolved separately by `CaseStore`/`readThatcherFieldEnum` from `CASEY_CONFIG_DIR`-or-`process.cwd()` (NOT `config/default/`). Copy the root `thatcher.config.yml` alongside a new package or the entity/workflow schema silently comes from wherever the process runs.

- **`report-fields.yml`**: `entity_label`, `enquiry_headline_fields`, `tool_name`/`tool_description`, `fields[]` (`key`, `description`; optional `critical_for_visit`, `append`, `never_inferred`+`never_inferred_guard_pattern`, `display_label`+`section`, `system_set`, `severity_signal`); top-level `mandatory_minimum`, `geo_fields`, `area_field`, `signoff_diagnosis`, `dashboard_ui` (`tier_labels`, `hidden_fields` -- DISPLAY only), per-field `options`. **`severity_signal`:** PRESENCE raises attention rank (`attn.js` flat +7), no magnitude except numeric ZERO. **`persona.cjs`** declares system-prompt TEXT; `caseSystemPrompt` owns STRUCTURAL prompt logic. **`vocabulary.yml`** is the ONE file of words people read (`applyVocabulary()`, pure); an absent/blank key falls back per key.

- **`src/store/report-shape.js` is the single choke point**: `TIER_LABELS`/`REPORT_KEYS`/`CRITICAL_FIELDS`/`APPEND_FIELDS`/`NEVER_INFERRED_FIELDS`/`MANDATORY_MINIMUM_FIELDS`/`missingMandatoryMinimum`/`ENQUIRY_HEADLINE_FIELDS`/`REPORT_SECTIONS`/`fieldLabel` derive from config; every consumer imports these. `deriveReportShape(reportFields)` is the same derivation as a pure function for MULTIPLE schemas per process.

## Architecture

casey composes existing projects and owns only the glue; each is a git submodule under `deps/`.

| Layer | Project | Path | Role |
|---|---|---|---|
| Agent runtime | `freddie` | `deps/freddie` | Real agent loop, tool registry, LLM seam, web server -- a Cordis plugin tree (not npm-importable). freddie IS the agent. |
| LLM chain | `acptoapi` | `deps/acptoapi` | Model resolution, chain fallback, backoff; reached through `freddie-bundle/src/llm-acptoapi`. |
| System of record | `thatcher` (deps `busybase`) | `deps/thatcher` | Config-driven CRUD + workflow + RBAC + audit; holds `case`/`event`/`contact`. |
| UI | `anentrypoint-design` | `deps/design` | webjsx + ripple-ui design system. |

`thatcher`/`design`/`acptoapi` are `file:deps/<name>`; `freddie` is NOT in `package.json` (a `pnpm` workspace). `scripts/link-deps.mjs` symlinks `node_modules/<name>`; run `git submodule update --init --recursive` after a fresh clone. Editing a composed project: work in `deps/<project>`, commit/push inside it, then bump the pointer here.

- **freddie integration.** `bootCasey()` flattens freddie-base's `cordis.patch.yml` with casey's own and calls freddie's real `boot()`; casey mounts its tools as real `defineTool()` on `ctx.tools`, an `LlmAdapter` on `ctx.llm`, and the WhatsApp webhook onto `ctx.webServer` on its OWN port `CASEY_WEBHOOK_PORT` (`127.0.0.1:4001` -- keep it clear of the dashboard's 4000 or the dashboard dies with EADDRINUSE/exit 44).

- **THE SAME WEBHOOK IS ALSO ON THE DASHBOARD'S PORT** for a proxy that forwards only one. `routes/whatsapp-webhook.js` mounts the same path (no env var, ADDITIVE) and is registered FIRST, ahead of `express.json()`, session middleware, CSRF and `authGate()`, so this path is exempt and carries its OWN `X-Hub-Signature-256` over the RAW bytes.

- **`case-prompt.js` is the seam that carries casey's prompt to the model at all** (freddie owns the system prompt); `installCasePrompt` hooks `system-prompt/assemble` to put the composed prompt in `deployment:persona` and drop `harness:identity` -- install on BOTH create and resume, or the model runs on "You are an AI agent powered by Freddie" with casey's domain prompt discarded.

- **SECURITY: freddie's `ctx.tools` is ONE GLOBAL registry, including freddie-base's real bash/write/edit/credential tools -- no toolset filter at the freddie layer.** `installToolAllowlist(agentCtx, allowedNames)` is the real boundary, installed PER-AGENT via `ctx.agents.create()`'s `setup`. Keep BOTH gates: `system-prompt/assemble` hides non-allowlisted schemas; `tools/pre-execute` denies dispatch by name. **`src/case-tools.js` is the single source of truth for WHICH case tools exist and in what order.**

- **The outbound adapter lookup is load-bearing and fails silently when wrong.** `resolveAdapter` resolves off `casey.js`'s `this.adapters` (a plain OBJECT keyed by channel); `freddie-bundle/src/platform` discards `handleInbound`'s return value, so `adapter.send` is the ONLY route an agent reply has to a contact. When a seam changes shape, search for the OLD shape's ACCESSOR too; never initialise a "delivered" flag to its success value above the branch that earns it (start `false`).

**Resolving freddie's packages:** `pnpm install` inside `deps/freddie`, then `scripts/link-deps.mjs` junctions every `@freddie/*` into casey's `node_modules`. `scripts/install-freddie-deps.mjs` (in `postinstall`) runs that install, degrading to a loud warning when the submodule or pnpm is absent. **`scripts/scan-deps.mjs` deliberately EXCLUDES `deps/freddie`'s own `node_modules`**; its GIT-TRACKED SOURCE is NOT exempt.

## Supply-chain integrity

Composed deps come from each project's `main` tip with no registry pins, so a compromised commit reaches runtime on the next install, and malware can hide in trailing whitespace, evading plain-text review.

- **Every session, every dependency touch:** dispatch `scan_deps {"full":true}` before trusting freshly resolved `node_modules`/submodules. Signature: a file with >500x byte:line ratio plus 4+ consecutive `\uXXXX` escapes; `failCount>0`/`blockedCount>0` = live evidence (`scripts/scan-deps.mjs` runs on `postinstall` and `casey doctor`).

- **`postinstall` must keep its exit-code split:** SETUP steps stay tolerant; the scanner's exit code goes straight to npm (a trailing `|| true` would bind to the whole chain and swallow it). **Submodules: always track the main branch, never a detached commit** (`git reset --hard origin/main`, not `git pull`); `npm run check-submodules` checks branch/dirty/ahead-behind.

## Dev workflow

```sh
# A bare `npm install` at the repo root CRASHES once the node_modules/@freddie/*
# junctions exist (@npmcli/arborist "Cannot read properties of null"). Use:
node scripts/install-freddie-deps.mjs   # pnpm install inside deps/freddie
node scripts/link-deps.mjs              # junction thatcher/acptoapi/design + every @freddie/* package
node bin/casey.js init / doctor / up    # scaffold .env / green-red preflight / gateway+dashboard (localhost:4000)
npm run lint                # dependency-free preflight; the gate to run before pushing
npm run gui-check           # drives the real dashboard in real headless Chromium
npm run scan-deps           # supply-chain scan
npm run check-submodules    # branch/dirty/ahead-behind on every deps/*
```

**There is no CI workflow in this repo** (`.github/` does not exist), so nothing runs `npm run lint` on push. Treat a green local lint as the substitute for a pipeline and say so explicitly rather than claiming a pipeline witnessed the change.

`npm run lint` (`scripts/lint.mjs`) is dependency-free (walk skips `deps/`). Gates: `syntax`, `json`/config, `ascii`, plus structural gates `pure-llm` (`gateway-hooks.js`/`casey.js` must never import a deterministic intent/extraction module), `no-stub-mock`, `pii-safety`, `trust-boundary` (no `src/packs/*.js` imports `src/core/`), `cli-help`, `design-lint`. `npm run gui-check` is deliberately NOT part of lint and skips loudly (exit 0) when no chromium exists. **No automated test suite anywhere; verification is manual/live** against a real `casey up`. **Query the live store as part of any audit:** a data bug's tell is an impossible row SHAPE; no `sqlite3` binary, so open `data/db.sqlite` with `@libsql/client` or go through `CaseStore`.

### Live reload: two mechanisms, one boundary

- **Cordis HMR owns the plugin trees** (`hmrScopePatch()` roots the reload to `freddie-bundle` plus every `src` dir under `deps/freddie/packages`); a save is traced through Node's module graph and only dependent plugin entries are re-registered in place.

- **The supervisor's full drain-and-respawn owns everything HMR cannot replace** (`deps/freddie/framework/` is the runtime the live tree is made of; casey's own `src/`/`boot.js` are in `bin/worker.js`'s static import graph). **A backstop for a dead file watcher:** `fs.watch` can stop delivering silently; `armReloadMtimeBackstop` compares newest reloadable mtime vs last real reload every `CASEY_RELOAD_SWEEP_MS` (20s). **Nothing falls between the two:** a failed or zero-plugin HMR reload escalates via `WORKER_MSG.RELOAD_REQUEST`.

- **A RESTART DOES NOT COST THE DISCORD GATEWAY BACKLOG.** `session-store.js` persists session id/resume url/sequence/bot user id to `<dataDir>/discord-gateway-session.json`, restored before the socket opens so a restarted worker sends `op: RESUME` (safe because `recordInbound` dedups on `msg_id`). **The bot user id is part of the session** (RESUME sends no READY): a stored session with no identity is NOT resumed, and a refused RESUME is counted (`gateway_gap_unresumable`).

**Supervisor (`src/supervisor.js`, pure xstate auth `src/supervisor-machine.js`)** forks the worker and never re-imports app code; reload keys on file MTIMES not git state (re-verify against a process started AFTER the fix commit); exit 44 (dashboard port EADDRINUSE) is config-fatal; the watch list is a fixed allowlist and the fork takes an argv array, never an interpolated shell string. **Its crash-restart timer is the one timer that is NOT unref'd** (`armKeepAlive` holds the parent loop); a crashed worker's cause is captured from its own stderr into `data/runtime-events.jsonl`.

**Editing/pushing a composed dependency** (`deps/thatcher`; same for acptoapi/design): fix, commit+push inside it, then in casey `git add deps/thatcher && git commit -m "chore(deps): bump thatcher submodule pointer" && npm install`. **`deps/freddie` differs:** after pushing, `pnpm install` inside `deps/freddie`, then `node scripts/link-deps.mjs`.

## Environment

Only variables whose default/behavior is not obvious from the name.

- `WHATSAPP_APP_SECRET` -- required when WhatsApp credentials exist, but HOW IT FAILS DEPENDS HOW WHATSAPP WAS ASKED FOR: named explicitly (`--channels whatsapp`) an unset secret is fatal; from the default channel list, WhatsApp is dropped with a warning. `WHATSAPP_VERIFY_TOKEN` is fatal on both paths whenever WhatsApp is enabled. `WHATSAPP_APP_ID`/`CASEY_PUBLIC_WEBHOOK_URL` -- optional, read only by `casey doctor`; `WHATSAPP_GRAPH_API`/`_VERSION` set the Graph base URL.

- `CASEY_WEBHOOK_HOST`/`CASEY_WEBHOOK_PORT` -- the Cordis WebServer row, default `127.0.0.1:4001`, a DIFFERENT socket from the dashboard's 4000. **Either port is a valid Meta callback URL.** `CASEY_SESSION_SECRET` -- random per process when unset (a restart invalidates every session).

- `CASEY_INBOUND_SILENCE_HOURS` (24, 0 off) -- `inbound_silent` when WhatsApp is configured, no inbound this long, and another signal is alive in the window (an idle deployment is deliberately not "deaf"). `CASEY_WHATSAPP_MAX_AGE_HOURS` (168, 0 off) -- a validly signed inbound older than this is dropped as a replay. `CASEY_DOCTOR_OFFLINE=1` = `doctor --no-network`. `CASEY_OPERATORS` REMOVED.

- `CASEY_LLM_MODEL` -- default `claude/sonnet`; `auto` builds acptoapi's real fallback chain. `CASEY_LLM_DATA_POLICY` -- default `deny`: `provider.data_collection="deny"` on every chain link; `zdr` adds `provider.zdr`; `allow` disables (doctor warns). Links with no checkable no-training guarantee (`:free`, `claude/*` ACP wrappers, unknown brands, `queue/`/`chain/`) are dropped and audited; an empty chain throws. The `/audio/transcriptions` endpoint ignores the policy, so transcription uses chat completions.

Sweep interval is `opts.sweepIntervalMs` (default 15 min, a casey option not env); coverage-gap window is a `detectCoverageGap` parameter (default 1h).

## Timeout coordination (live turn guarantee)

Four independent layers; all four must agree on an outer bound or a slow-but-working provider is marked unhealthy early and live contacts hit fallback even when the backend is merely slow.

- **L1 live-turn hard deadline:** `CASEY_TURN_HARD_DEADLINE_MS` (120000) total retry budget for a live first-attempt inbound; `CASEY_TURN_SOFT_DEADLINE_MS` (25000) picks fallback tone; `CASEY_LLM_TURN_TIMEOUT_MS` (120000) per-attempt ceiling. Every live turn ends with a real reply OR a truthful status message.

- **L2 provider chain link:** `ACPTOAPI_CHAIN_LINK_TIMEOUT_MS`. acptoapi's SHIPPED DEFAULT IS 120000, equal to the per-attempt budget -- one unhealthy hop then consumes the whole budget leaving no room for `MAX_TOOL_CHOICE_ATTEMPTS`. **A deployment must set it explicitly.** doctor flags a per-link timeout not comfortably below the per-attempt budget; this repo ships no `.env` so a bare `doctor` here goes red on it (uhh sets 30000).

- **L3 readiness/discovery** (readiness pass, discovery probe, boot/dashboard reachability). **L4 background re-drives** are NOT subject to the hard deadline, silent on degrade, cap 5 per msgId before dead-letter. **A msgId is still pending when "started and not answered", and a guaranteed-fallback message is not an answer** (`completesTurn` excludes `data.guaranteedFallback`).

**Ordering:** hard >= soft; hard >= per-attempt; per-attempt > per-link; per-link >= readiness/discovery. Health: `/api/health`, `/api/turns/degraded`, `/api/health/provider`, `/api/health/cases`; **exactly ONE `data.degraded_turn` row per degraded turn**. The sweep (`case-sweep.js`, `opts.sweepIntervalMs` 15 min) tags breaches (`stale` 48h, `stage_stuck`, `handoff_needed` 4h, `unanswered_handoff_escalated` 12h, `incomplete_critical` 8h, `abandoned_intake` 24h, `never_closed` 7d, `unsentDraft` 1h, `premature_complete`); `ALL_HEALTH_TAGS` is the whole set. **Team coverage gaps** fire once per rising edge when the roster is non-empty AND a breaching case exists AND zero operator replies landed on one in the window (1h), held durably in `AlertGate`.

## Design principles (preserve these)

- **No mocks/fallbacks/stubs -- only singular working mechanisms and loud errors.** A degraded turn never fabricates case content; the one exception is a live first-attempt turn still degraded after its budget, which sends a truthful status message, while a background re-drive stays silent.

- **Personal data goes only to processors casey can hold to a no-training policy, and the decision is written down** (`CASEY_LLM_DATA_POLICY`). **The bot never contacts anybody; everybody contacts the bot** (`CASEY_PROACTIVE_SENDS=off`); ONE gate at the sending seams.

- **The reporter is usually a field worker relaying a farmer's animals. The LLM records the report; casey does no field extraction. A case is keyed per contact, not per channel; a complete report is not a dead-end. The mandatory minimum and sign-off authority are enforced in code at three points; sign-off gates the agent's formal transition, never the conversation.**

- **Areas/hand-over/day.** A report in a mapped area goes to the primary ranger (else first valid backup); auto-assign runs once per OPEN UNASSIGNED record after a write touching area/location. Resolution is EQUALITY (`resolveArea`, no gazetteer, no fuzzy match; unmatched lands in `unmappedAreas`). The ranger hands over (refused while the minimum is blank); the technician signs off with a diagnosis+resolution. **Sign-off desk rule:** an open record holding the minimum is on the desk when HANDED OFF or nobody holds it; `case_my_day` returns counts/references/status only.

## Security invariants (do not regress)

- WhatsApp inbound is HMAC-SHA256 verified when `WHATSAPP_APP_SECRET` is set; that secret is required when WhatsApp credentials exist.

- Dashboard API + page gate on a logged-in session (scrypt-hashed password; stateless HMAC cookie). No route accepts a bearer token or `?token=` EXCEPT `/api/sync/*`. Ungated = `routes/auth.js`'s `authGate()` list plus what `registerAuth` mounts ahead: `/design`, `/vendor/*`, `/api/login|logout|whoami|ready|branding`, the public `/report` form, the SPA shell, the PWA assets, `/api/sync/*`, the WhatsApp webhook. **The sync routes and the webhook run a DIFFERENT gate, not none:** sync uses a bearer `Authorization` header (scrypt + `timingSafeEqual`) against `sync_api_key` rows, scope-checked; the webhook uses `X-Hub-Signature-256` over the RAW bytes (wrong `hub.verify_token` = 403, unsigned/wrongly-signed POST = 401). `/media` is NOT ungated. **`/api/ready` deliberately says more than a boolean** (degraded + reasons, state words, queue depths) but may never carry case content/ref/contact id/provider model or url; a degraded instance still answers 200, only an unreachable store is 503.

- All contact-supplied text is HTML-escaped before render.

- **A viewer login sees aggregates and nothing that names, locates or reaches a person.** `viewerGate` allowlist: `config`, `overview`, `logout-everywhere`, the auth self-routes and the four `/api/reports/*` routes; `/media` is 404 in every spelling. Every datum comes from `routes/reports-map.js` (dots rounded ~1km and to the week; groups under the `privacy.js` floor folded/dropped; labels stripped of digits/punctuation, rare ones `Other (rare)`). `resolveRole`/`isViewer` are exact-name tests (a forged/blank value is the least-privileged rung). Adding a route to `VIEWER_ROUTES` requires reading its payload for a reference/id/name/subject/number/login/assignee/free text first; `gui-check`'s viewer PII scan must stay green.

- **Field-login fence (`roles.js` `roleGate`), hardened by exploit.** Express matches case-insensitively and the file server resolves the DECODED path, so the gate decides on the lower-cased `/api`/`/media` prefix and refuses every spelling its exact-case table does not list. Media is scoped only for exactly `/media/<caseId>/<file>` after decoding, with no dot segment/separator/backslash. Channel `system` cases are never a case for a field login; `agent` is never a person.

- **A field login's write responses and timeline carry no key and no number** (PATCH/transition answer through `writeProjection`; events drop `assigned_contact_id`, `staff_contact_id`, `dispatch_worker_id`, `dispatch_response_by`, `announced_to`, and to a field login also `to`).

- **System tags are not a team member's to touch** (`RESERVED_TAG`: opted-out, needs-human, draft-pending, ai-offline, flagged-reply, dispatch-suggested, health:, intake_mode:), on both the WhatsApp tool and the dashboard field PATCH; `POST /api/cases/:id/reply` refuses an opted-out case server-side.

- **A role is granted only to a number the operator typed** (`team_register` compares with `ctx.inboundText`; `sendStaffMessage` refuses text carrying a live invite code). **Login is rate-limited and uniform** (10 failures per (username, source), 60 per source per 15 min; an unknown username still pays the scrypt cost).

- **Erasing a team member releases their work and unlinks their login.** The service worker never caches `/media/`; the WhatsApp media handshake encodes the media id and refuses a non-https url before sending the bearer token; cookie and password comparisons use `crypto.timingSafeEqual`.

- **Soft deletes mean "deleted" is a FIELD, and every authorising read path must honour it.** `t.list` filters them, `t.get` does NOT (session middleware resolves through `getAccount`), so the middleware must check `status` as well as `disabled` + session epoch, and `deleteAccount` must bump `session_epoch` before removing the row.

- **No dashboard route ever returns a raw case or contact row** -- only through an explicit field allowlist (`caseListProjection()`/`caseDetailProjection()`, `publicContact()`), never a spread. Three fields may never be emitted: `external_id`, `author_key`, `contact_id`. An operator MAY see `external_id_formatted` on a single case they opened; the case LIST stays PII-free. `lint.mjs`'s `pii-safety` gate enforces this by dataflow.

- Session epoch revocation forces re-login across all devices. A bootstrap admin's generated password is delivered only as a root-only file (mode 0600) -- the log carries the path, never the password.

- **The untrusted-data boundary is structural; the prompt instruction is defence in depth on top.** Every contact-reachable value reaching the composed prompt goes through `hooks/prompt-context.js`'s `fenced()`, which neutralises BOTH `<<DATA>>` and `<<END>>` inside the value (report fields, the timeline, and the free-text columns `subject`/`summary`/`assignee`/`tags`). `status`/`priority`/`case_type`/`autonomy` are rendered bare because each is validated on write. `hooks/prompt.js`'s `selfCheckFenceIntegrity` composes a case whose every free-text column carries a literal `<<END>>` and asserts the markers still strictly alternate; an edit that interpolates a new row value without `fenced()` crashes boot.

- **Two outbound leaks are code gates, not judgements.** `evaluateCandidate` decides both ABOVE the judge call: SYSTEM-PROMPT ECHO (a run of 8+ words reproduced verbatim from the real prompt, fenced regions removed first) and TOOL-NAME LEAK (a literal `case_*` name derived from the live toolset). Both retry with the offence fed back then hold for a human exactly as the jargon leak does, never blank.

## thatcher / busybase chain

casey consumes thatcher via `file:deps/thatcher`, calling operator-where directly with no fallback. busybase's `src/*.js` are gitignored bun-build outputs -- fixes go in the `.ts` sources in the busybase repo and are rebuilt there, never patched casey-side.

**busybase opens the file with `journal_mode=delete` and `busy_timeout=0`, so sqlite NEVER waits -- it fails instantly with `SQLITE_BUSY`, and a plain reader blocks a writer.** Any concurrent reader (another CLI, a backup, an audit script) can fail casey's writes, and a burst of concurrent inbounds can fail each other's. `src/store/busy-retry.js` is the only defence: a USERLAND full-jitter retry inside a seconds-long budget; it cannot save a write from a reader holding the lock continuously (the real fix is `busy_timeout`/WAL on busybase's own handle in the busybase repo), and a spent intake budget is COUNTED.

**busybase binds numeric columns as TEXT, so every number read off a row arrives as a digit string.** Three traps, each has shipped a real bug: *reading a timestamp* (numeric-seconds strings; bare `Date.parse` is `NaN` -- use `timestamp.js`'s `tsMs` or `format.js`'s `toDate`); *writing an integer* (`"1" + 1` is `"11"` -- coerce with `safe.js`'s `rowInt()` before arithmetic); *writing a number into a version-guarded patch* (a JS number with `expectedVersion` makes the optimistic check fail every time while the write still lands, once per retry -- `store/guards.js`'s `toStorable()` is the write-side guard: finite numbers -> decimal string; `null`/`undefined`/booleans/strings/NaN/Infinity pass through; `null` is a real "clear this column"). **The general rule: a value off a busybase row is a string until you coerce it, and a number going back in is a string until `toStorable` makes it one.**

## Provenance subsystem (src/core/, src/packs/)

An additive ground-truth layer alongside the thatcher architecture, to answer for every value who said it, how (observed/reported/measured/inferred/unknown), and when, so a future aggregate/audit can never blend a model guess into a ground-truth count. **Provenance is a type, not a field** (construction only through `mkValue`/`mkUnknown`; five kinds ranked `unknown < inferred < reported < observed < measured`, `canReplace` never lets a lower rank overwrite a higher). **The raw log is the system of record** (`raw-log.js`, append-only JSONL) and `write-path.js` `writeObservation()` is the single write chokepoint. The live module set is exactly `raw-log.js`, `write-path.js`, `pack-schema.js` and their direct deps; config packs are declarative data only and `trust-boundary` forbids any `src/packs/*.js` importing `src/core/`.

## Conventions

- ASCII only in source and docs -- no arrow/box/bullet/check glyphs, emoji, em-dashes, curly quotes, combining marks (use `->`, `-`, `[x]`/`[ ]`, plain quotes, words; code operators exempt). `npm run lint`'s `ascii` gate enforces this.

- ES modules (`"type": "module"`), Node >= 22. No automated test suite; verification is manual/live against a real `casey up`. Do not add a test file or mock-heavy unit suite.

- Comments and docs state present-tense constraints, not the history of how a line came to be. Git holds history.

- thatcher's sqlite handle is cwd-bound and primed at init. The real file is `<cwd>/data/db.sqlite`, not `app.db` (thatcher's `databasePath` only contributes its directory; busybase hardcodes `db.sqlite`). Re-importing the accessor forks a second handle.
