# AGENTS.md

Operating notes for agents (and humans) in this repo; included by `CLAUDE.md` via `@AGENTS.md`. Every claim is true of the tree NOW; change the line describing a change in the same commit. Past incidents belong in git history, narrative in `README.md`.

Deep rationale for the rules below lives in gm memory; each `-> recall` line retrieves its memo.

## What casey is

A thin, domain-configurable structured-intake orchestrator over WhatsApp/Discord (generic helpdesk demo here; the animal-disease deployment is the private package `AnEntrypoint/uhh`).

### Contact access ladder (`src/contact-tiers.js`)

- `TIER_ORDER` (low->high): `reporter`, `field_worker`, `animal_health_technician`, `operator`. Every permission question asks "at least rung N" (`atLeast`/`canQueryCases`), NEVER "exactly N". `resolveTierValue` is fail-closed: missing/empty/pre-migration/corrupt maps to the LOWEST rung. `animal_health_technician` holds EXCLUSIVE authority to move a report to done. Per-tool minimum rung is `TOOL_MIN_TIER` in `case-tools-gates.js`. Ownership gates on the INTAKE record tools (`case_switch`, `case_update`, `case_observe`, `case_transition`, `case_link_suggestions`, `case_split`, `case_health`) are scoped by `!ownsCase(...) && !canQueryCases(ctx?.tier)`: a team member may act on ANY public report, a reporter only on its own. Two things stay closed for a non-owner team tier -- a DONE-stage move (custody: assigned, unassigned or handed-off only) and `case_update`'s `assignee` field -- and `case_switch` refuses a `channel:system` target; `writeGate` still guards a multi-ref message for team tiers, minus its focus ritual. The ASSIGNED-worker desk tools keep the stricter `authorityOn`/`deskAuthorityOn` gate, because they disclose the reporter's number and message them.
- Only an admin may grant operator OR technician (`grantableBy(isAdmin)` is the one filter every grant route uses). `canSignOff` is EQUALITY on purpose. Stored strings are `contact.tier` / `case.reporter_tier`; a different human-facing WORD is only a label via `report-fields.yml` `dashboard_ui.tier_labels`.
- The dashboard sign-off gate refuses in order: technician authority, mandatory minimum, then `signoff_diagnosis`. `mandatory_minimum` is enforced at three code points and gates the AGENT tool surface only, so a console operator closing is not asked. `selfCheckLoadBearingPromptContent` throws if an elevated instruction is missing or leaks downward. A record is held only by someone who can act on it; demotion or deleting a field login releases every open record.
- `diagnosis_status` (confirmed|suspected|ruled_out) is an optional `signoff_diagnosis` field: only a schema that lists it requires it (`report-shape.js` demands options drawn from those three). Reports with it ruled_out leave every disease count and surface only as the k-floored `ruled_out` total; suspected rows carry `row.status` and feed `by_status`; a missing status counts as confirmed. `CaseStore.transition` clears the sign-off fields on any done -> not-done move into the transition event's `data.previous_diagnosis`, so the next sign-off restates them.
- Roles arrive only by operator assignment (`POST /api/contacts/:id/tier` or `/register`; `normalizeMsisdn` refuses an SA number that is not 27+9 digits) or a one-time code consumed AFTER admission and BEFORE any turn; the model never sees the code. WRITE refuses an unrecognised tier, READ coerces a corrupt one to the lowest rung.
-> recall {query:"contact access ladder internals rung powers resolveTierValue reporter field_worker technician operator"}
-> recall {query:"tier grant operator technician dashboard sign-off mandatory_minimum selfCheckLoadBearingPromptContent one-time code"}

## Configuration architecture (`src/config-loader.js`)

- `CASEY_CONFIG_DIR` holds `thatcher.config.yml`, `report-fields.yml`, `persona.cjs`; absent, casey falls back to bundled `config/default/` plus the repo-root `thatcher.config.yml`. `CASEY_CONFIG_DIR` wholesale-REPLACES (no merge). The three do NOT share a resolver: a new package must copy the root `thatcher.config.yml` alongside itself.
- `report-fields.yml` declares `fields[]` (flags `critical_for_visit`, `append`, `never_inferred`, `system_set`, `severity_signal`) plus the gate/signoff/area blocks (`mandatory_minimum`, `signoff_diagnosis`, `area_field`, `geo_fields`) and `dashboard_ui` (DISPLAY only). `persona.cjs` declares prompt TEXT (`agentName`; `noticeVersion`/`noticeAnchor`); `caseSystemPrompt` owns STRUCTURAL logic. `vocabulary.yml` is the one file of words people read.
- `src/store/report-shape.js` is the single choke point: every derived shape constant is exported there and every consumer imports it. `deriveReportShape(reportFields)` is a pure function for MULTIPLE schemas per process.
-> recall {query:"CASEY_CONFIG_DIR config resolver thatcher.config.yml report-fields.yml persona.cjs divergence"}
-> recall {query:"report-fields.yml severity_signal report-shape choke point vocabulary persona prompt text"}

## Architecture

casey composes four git submodules under `deps/`: `freddie` (agent runtime, Cordis plugin tree, NOT npm-importable), `acptoapi` (LLM chain), `thatcher` (+ `busybase`; system of record: `case`/`event`/`contact`), `anentrypoint-design` (UI). Run `git submodule update --init --recursive` after a clone.

- `bootCasey()` calls freddie's `boot()`; casey mounts tools as `defineTool()` on `ctx.tools`, an `LlmAdapter` on `ctx.llm`, and the WhatsApp webhook on `ctx.webServer` at `CASEY_WEBHOOK_PORT` (`127.0.0.1:4001`); keep clear of the dashboard's 4000 or it dies with EADDRINUSE/exit 44.
- THE SAME WEBHOOK IS ALSO ON THE DASHBOARD'S PORT (`routes/whatsapp-webhook.js`, ADDITIVE), registered FIRST ahead of `compressResponses`, `express.json()`, session middleware, CSRF and `authGate()`, so it is exempt and carries its OWN `X-Hub-Signature-256` over the RAW bytes.
- SECURITY: `installToolAllowlist(agentCtx, allowedNames)` is the real boundary, installed PER-AGENT; keep BOTH gates (`system-prompt/assemble` hides non-allowlisted schemas, `tools/pre-execute` denies dispatch by name). `src/case-tools.js` is the single source of truth for WHICH case tools exist and in what order.
- `adapter.send` is the ONLY route an agent reply has to a contact; `bin/send-reply.js`'s `makeSendReply` REJECTS when the channel has no adapter.
- External sync (`src/sync/`, see `EXTERNAL-SYNC.md`): correlation writes only `external_link` 'proposed'; `apply-link.js` fills EMPTY `case.report` from a CONFIRMED link only.
- Operator console (`src/dashboard/`): its imperatives (shell caching, auth and route order, printables, console UI, stylesheets, backup) live in `src/dashboard/AGENTS.md`, each with a `-> recall` for the reasons; read it before touching the shell, `auth.js`, `roles.js` or the SPA.
- Agent runtime (`src/agent/`): one live agent per `case:<id>`; eviction is `CASEY_AGENT_IDLE_TTL_MS` (default 3h), never a count cap, always RESUME-before-CREATE. `CASEY_LLM_CONCURRENCY` (default 4, 0 off); `CASEY_LLM_REQUIRE_MODEL` pins the one allowed model.
-> recall {query:"freddie integration bootCasey webhook port whatsapp-webhook dashboard port adapter send"}
-> recall {query:"agent tool allowlist installToolAllowlist case-tools casey security global registry"}
-> recall {query:"agent runtime runTurn idle ttl concurrency case agent per case resume before create"}
-> recall {query:"casey external sync adapter external_link apply-link proposed confirmed"}
-> recall {query:"casey composed submodules deps freddie acptoapi thatcher busybase design link-deps"}

## Supply-chain integrity

Composed deps come from each project's `main` tip with no registry pins. Every session and dependency touch: dispatch `scan_deps {"full":true}` before trusting freshly resolved `node_modules`/submodules. `failCount>0`/`blockedCount>0` = live evidence. `postinstall` must keep its exit-code split (setup steps tolerant; the scanner's exit code straight to npm). Submodules always track main, never a detached commit (`git reset --hard origin/main`, not `git pull`); `npm run check-submodules` checks branch/dirty/ahead-behind.
-> recall {query:"supply-chain scan_deps signature byte line ratio scan-deps postinstall exit-code split submodules main"}

## Dev workflow

`npm install` runs `postinstall` -> `install-freddie-deps.mjs`, `link-deps.mjs`, `install-hooks.mjs` (tolerant; a failure continues the install degraded), then `scan-deps.mjs` (its exit code passes straight through); if a step failed, run `node bin/casey.js doctor`. `npm run lint` is the dependency-free gate to run before pushing (gate list in `scripts/lint.mjs`); `gui-check` is NOT part of it. No automated test suite; verification is manual/live.

`.github/workflows/secrets.yml` runs gitleaks only (full-history) on push/PR; the tracked `hooks/pre-push` runs `npm run lint` before a push (skips when node or the scripts are absent; `git push --no-verify` escapes).

`bin/casey.js` loads `.env` BEFORE it dynamically imports `bin/casey-cli.mjs`. `--help`/`-h` is answered from `USAGE` BEFORE the handler runs, and every one-shot command ends through `closeAndExit` (releases the sqlite handle first).
-> recall {query:"dev workflow npm install postinstall lint gitleaks pre-push bin casey env load closeAndExit"}

### Live reload: two mechanisms, one boundary

- Cordis HMR owns the plugin trees; a full drain-and-respawn owns everything HMR cannot replace. A restart does NOT cost the Discord gateway backlog; a stored session with no bot identity is NOT resumed.
- Supervisor (`src/supervisor.js`, xstate `src/supervisor-machine.js`) forks the worker, never re-imports app code; exit 44 (dashboard EADDRINUSE) is config-fatal and never restarts. `bin/worker.js`'s crash net sends `WORKER_MSG.FATAL` on any uncaughtException/unhandledRejection. `CASEY_EXTRA_DASHBOARD_ROUTES` names a module whose default export `(app,{store})=>void` mounts extra dashboard routes.
-> recall {query:"live reload cordis HMR drain respawn discord gateway session resume supervisor exit 44"}

Editing/pushing a composed dependency (`deps/thatcher`; same for acptoapi/design): fix, commit+push inside it, then `git add deps/thatcher && git commit -m "chore(deps): bump thatcher submodule pointer" && npm install`; `deps/freddie` instead needs `pnpm install` inside it then `node scripts/link-deps.mjs`. AUTO-UPDATE (default on; `--no-auto-update`, `CASEY_AUTO_UPDATE=0`) leaves a dirty/divergent tree alone.
-> recall {query:"editing composed dependency thatcher submodule bump auto-update ff-only freddie pnpm"}

## Timeout coordination (live turn guarantee)

Four independent layers; all four must agree on an outer bound. Every live turn ends with a real reply OR a truthful status message.

- L1: `CASEY_TURN_HARD_DEADLINE_MS` (120000) total retry budget for a live first-attempt inbound; `CASEY_TURN_SOFT_DEADLINE_MS` (25000) picks fallback tone; `CASEY_LLM_TURN_TIMEOUT_MS` (120000) per-attempt ceiling.
- L2: `ACPTOAPI_CHAIN_LINK_TIMEOUT_MS`; acptoapi's SHIPPED DEFAULT IS 120000, so set it explicitly. doctor flags a per-link timeout not comfortably below the per-attempt budget.
- L3 readiness/discovery. L4 background re-drives are NOT subject to the hard deadline, silent on degrade, cap 5 per msgId before dead-letter. A guaranteed-fallback message is not an answer (`completesTurn` excludes `data.guaranteedFallback`).
- Ordering: hard >= soft; hard >= per-attempt; per-attempt > per-link; per-link >= readiness/discovery. Exactly ONE `data.degraded_turn` row per degraded turn.
-> recall {query:"timeout coordination four layers hard soft deadline per-attempt per-link ordering live turn"}
-> recall {query:"casey health endpoints degraded_turn sweep AlertGate team coverage gaps"}

## Design principles (preserve these)

- No mocks/fallbacks/stubs -- only singular mechanisms and loud errors. A degraded turn never fabricates case content (exception: a live first-attempt turn still degraded after its budget sends a truthful status; a background re-drive stays silent).
- Personal data goes only to processors casey can hold to a no-training policy (`CASEY_LLM_DATA_POLICY`, default `zdr`; `allow` disables the guarantee). The bot never contacts anybody; everybody contacts the bot (`CASEY_PROACTIVE_SENDS=off`); ONE gate at the sending seams. A case is keyed per contact, not per channel.
- Areas/hand-over/day: resolution is EQUALITY (`resolveArea`; no gazetteer/fuzzy match; unmatched -> `unmappedAreas`); `autoAssignByArea` runs once per OPEN UNASSIGNED record after a write touching area/location. An area may carry an optional `lat`/`lon`; when no spelling matches, the nearest placed area within `areaNearestMaxKm` (`thresholds.js`, default 150 km) is assigned, a name match always winning over distance. It also fires after `case_report` writes lat/lon, because the report-merge hook runs BEFORE the coordinates exist.
-> recall {query:"casey design principles rationale degraded turn data policy area routing proactive sends"}

### Inbound turn pipeline (`src/hooks/`)

- Admission (`admission.js`) claims each contact SYNCHRONOUSLY; a burst is BUFFERED raw and replayed; a rate-limited inbound sends no reply. Agent-turn gates (`turn-attempts.js`) never leave a reply blank; `reply-judge.js` adjudicates against named fault shapes.
-> recall {query:"inbound turn pipeline admission buffer turn-attempts reply-judge media normalization"}

### Top-level modules (`src/`)

- `case-store.js` is the single chokepoint over thatcher; open-case lookup uses a `status:{$in:openStages}` ALLOWLIST, never `$ne:'closed'`. `retention.js` is OFF unless `CASEY_RETENTION_DAYS` is set, defaults ARCHIVE, frees no sqlite bytes (soft-delete).
- Resume vs drain (`casey-resume*.js`, `casey-drain.js`): a crash's half-done turn vs an outage's unstarted one -- DO NOT merge.
- `case-machine.js`/`supervisor-machine.js` are PURE xstate TRANSITION-VALIDATION authorities (no actors). `CASEY_CRASH_LIMIT` has no "off" (non-positive -> 5).
- `report-digest.js` (`casey report-digest`) builds the monthly aggregate CSV and text from `reports-map.js` exports only (k-floored); `--post` goes solely to `CASEY_ALERT_WEBHOOK` (operator endpoint, never a contact). An area may carry an optional `district` label; `reports-map.js` maps the stated area to it by EQUALITY (unmapped -> `unknown`) into `by_district` (k-floored), carried in the CSV `district` view and the digest.
- `privacy.js` is the ONE k-anonymity floor; `format.js` MARKS (never strips) bidi/invisible chars; `log-scrub.js` redacts secrets from stdout/stderr; `llm-data-policy.js` (default `zdr`) drops providers without a no-training guarantee.
-> recall {query:"casey top-level modules case-store eraseContact retention resume drain xstate privacy busy-retry"}

## Security invariants (do not regress)

- WhatsApp inbound is HMAC-SHA256 verified when `WHATSAPP_APP_SECRET` is set; that secret is REQUIRED to serve WhatsApp when WhatsApp credentials exist, or anyone reaching the webhook can forge farmer messages. A bad signature answers 401; a bad verify challenge answers 403.
- No dashboard route ever returns a raw case or contact row -- only through an explicit field allowlist (`caseListProjection()`/`caseDetailProjection()`, `publicContact()`), never a spread. `external_id`, `author_key`, `contact_id` may NEVER be emitted; an operator MAY see `external_id_formatted` on a single case they opened, but the case LIST stays PII-free. `lint.mjs`'s `pii-safety` gate enforces this by dataflow; all contact-supplied text is HTML-escaped before render.
- Every contact-reachable prompt value goes through `hooks/prompt-context.js`'s `fenced()`, which neutralises BOTH `<<DATA>>` and `<<END>>` inside the value; `status`/`priority`/`case_type`/`autonomy` render bare (each validated on write). `hooks/prompt.js`'s `selfCheckFenceIntegrity` crashes boot on an unfenced interpolation.
- Field-login fence (`roles.js` `roleGate`): the gate decides on the lower-cased `/api`/`/media` prefix and refuses every spelling its exact-case table does not list; media is scoped only for exactly `/media/<caseId>/<file>` after decoding. Channel `system` cases are never a case for a field login; `agent` is never a person.
- System tags are not a team member's to touch (`RESERVED_TAG`), on both the WhatsApp tool and the dashboard field PATCH; `POST /api/cases/:id/reply` refuses an opted-out case server-side.
- A role is granted only to a number the operator typed; `sendStaffMessage` refuses text carrying a live invite code. Login is rate-limited and uniform (10 failures per (username, source), 60 per source per 15 min; an unknown username still pays the scrypt cost). Session epoch revocation forces re-login across all devices. A bootstrap admin's generated password is delivered only as a root-only file (mode 0600).
- Erasing a team member releases their work and unlinks their login. Cookie and password comparisons use `crypto.timingSafeEqual`. Soft deletes mean "deleted" is a FIELD: `t.list` filters them, `t.get` does NOT, so session middleware must check `status` as well as `disabled` + session epoch, and `deleteAccount` must bump `session_epoch` before removing the row.
- busybase opens with `journal_mode=delete`/`busy_timeout=0`, so sqlite NEVER waits -- it fails instantly with `SQLITE_BUSY`, and a concurrent reader can fail casey's writes. `src/store/busy-retry.js` is the only defence (USERLAND full-jitter retry inside a 5s budget); a spent intake budget is COUNTED.
-> recall {query:"dashboard PII projection allowlist caseListProjection prompt fencing fenced selfCheckFenceIntegrity"}
-> recall {query:"field login roleGate fence role grant rate limit session epoch bootstrap admin password"}
-> recall {query:"soft delete t.list t.get erasure deleteAccount sqlite busy_timeout busy-retry"}

## thatcher / busybase chain

casey consumes thatcher via `file:deps/thatcher`, calling operator-where directly with no fallback. busybase's `src/*.js` are gitignored bun-build outputs -- fixes go in the `.ts` sources in the busybase repo and are rebuilt there, never patched casey-side.

- Store write guards (`store/guards.js`): `DERIVED_ONLY_FIELDS` (system-only) and `SYSTEM_FORBIDDEN_FIELDS` (the system actor never writes `report`/`summary`/`subject`); `installVersionGuard` REFUSES a raw JS number under `expectedVersion` BEFORE the write. `toStorable()` is the required coercion. Provenance never downgrades (`canReplace`); `raw-log.js` is append-only and rotates by ARCHIVING (never truncation). `src/packs/animal-health.js`: only `observationForms.sick_or_dead_animal.fields` is read at runtime.
-> recall {query:"thatcher busybase store guards installVersionGuard provenance ranking raw-log packs animal-health"}

## Conventions

- ASCII only in source and docs -- no arrow/box/bullet/check glyphs, emoji, em-dashes, curly quotes, combining marks (use `->`, `-`, `[x]`/`[ ]`, plain quotes, words; code operators exempt). `npm run lint`'s `ascii` gate enforces this.
- ES modules (`"type": "module"`), Node >= 22. Do not add a test file or mock-heavy unit suite.
- thatcher's sqlite handle is cwd-bound and primed at init. The real file is `<cwd>/data/db.sqlite`, not `app.db`. Re-importing the accessor forks a second handle.
- `bin/secrets-exec.mjs` loads a Google Secret Manager manifest (`src/secrets/loader.js`, pinned numeric versions, fail closed -- `"latest"` is refused), starts the child with the secrets in ITS env only (nothing written or printed), and exits 78 (EX_CONFIG) without starting it if any secret fails to load.
-> recall {query:"casey conventions sqlite handle db.sqlite cwd secrets-exec secret manager manifest"}
