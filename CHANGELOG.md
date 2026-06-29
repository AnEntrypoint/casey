# Changelog

## Unreleased

### Added
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
