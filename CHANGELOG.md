# Changelog

## Unreleased

### Fixed
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
