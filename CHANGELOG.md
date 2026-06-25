# Changelog

## Unreleased

### Fixed
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
