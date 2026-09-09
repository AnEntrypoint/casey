# casey

Agentic case tracking, observation, and manual editing over messaging channels.

casey is a **domain-configurable** structured-intake agent -- anyone
messaging over WhatsApp/Discord, in their own language, is a reporter; casey
greets them warmly and quietly gathers a structured record (report/ticket
fields declared entirely by config -- see "Configuring casey" below)
**without interrogating them**, and gives the organising team one organised,
observable view per report. It amplifies the team's own way of working -- it
does not impose domain-specific rules or escalation; priority stays with the
people. Times are shown in SAST and phone numbers in +27 format by default
(overridable via `CASEY_TZ`/`CASEY_COUNTRY_CODE`).

This repo ships a generic **IT/facilities-helpdesk** demo config by default.
The animal-disease-surveillance-for-rural-South-Africa domain casey was
originally built for is a separate, fully self-contained config package:
[`AnEntrypoint/uhh`](https://github.com/AnEntrypoint/uhh) (private). Install
it with `git clone --recurse-submodules` and run `node ./bin/uhh.js up`; it
declares casey as `file:deps/casey`, and an in-repo `file:` dependency cannot
be resolved inside an npx-installed package, so `npx github:AnEntrypoint/uhh`
does not work.

## Configuring casey

Point `CASEY_CONFIG_DIR` at a directory holding `thatcher.config.yml`,
`report-fields.yml`, and `persona.cjs` to swap casey's entire domain (report
vocabulary, agent persona, entity schema, dashboard labels) with no code
change. See `AGENTS.md`'s "Configuration architecture" section for the full
schema, and `AnEntrypoint/uhh`'s `config/` directory for a real worked
example.

The three files are not resolved by one mechanism. `src/config-loader.js`
reads `report-fields.yml` and `persona.cjs` from `CASEY_CONFIG_DIR`, falling
back to this repo's bundled `config/default/`. `thatcher.config.yml` is
resolved separately -- by `src/case-store.js`'s `CaseStore` constructor and
`config-loader.js`'s `readThatcherFieldEnum`, each using `CASEY_CONFIG_DIR`
if set and otherwise `<cwd>/thatcher.config.yml`. `config/default/` therefore
ships only two of the three files; the third is this repo's own root
`thatcher.config.yml`. Copying `config/default/` as a template for a new
deployment gives an incomplete config dir -- copy the root
`thatcher.config.yml` alongside it.

casey is a thin orchestrator that composes four existing projects, each
checked out as a git submodule under `deps/` for local editing -- see
"Composed AnEntrypoint dependencies" below and `AGENTS.md`'s Architecture
section for the full mechanism:

| Layer | Project | Role in casey |
|-------|---------|---------------|
| Agent runtime | [`freddie`](https://github.com/AnEntrypoint/freddie) | A Cordis plugin tree (`@freddie/cordis`) whose real `boot()` assembles the running app: agent loop, tool registry, LLM seam, web server. It has no messaging-bot primitives of its own -- casey owns the WhatsApp/Discord transport (`src/adapters/`) and mounts it, plus its `case_*` tools, into freddie's tree as Cordis plugins under `freddie-bundle/`. |
| System of record | [`thatcher`](https://github.com/AnEntrypoint/thatcher) | Config-driven CRUD + workflow + RBAC + audit. Holds `case` / `event` / `contact` and the case lifecycle state machine. |
| UI | [`anentrypoint-design`](https://github.com/AnEntrypoint/design) | webjsx + ripple-ui design system. Themes the observe + manual-edit dashboard. |
| LLM provider chain | [`acptoapi`](https://github.com/AnEntrypoint/acptoapi) | Model resolution, chain fallback, sampler backoff. |

## The flow

```
  WhatsApp / Discord / Sim
        |  message {from, text, raw{id}}
        v
  casey adapter -> casey handler -> find/create thatcher case
        |                                |  append event(inbound)  [deduped by msg id]
        |                                v
        |                          agent turn (runTurn) with case context + case_* tools
        |                          agent: create / update / transition / observe
        |  reply {to, text}             |  each action = an audited event row
        +<------------------------------+  append event(outbound)
        v
  back to channel  (nothing is sent if the model errors, times out, or returns empty --
                    the failure is logged loud and recorded, never a scripted reply)

  thatcher data  <-  dashboard API (/api/cases ...)  <-  operator dashboard
                     observe timeline, edit fields, override transitions, reply on-channel
```

- Fully autonomous: the agent creates cases and drives workflow transitions itself, scoped by a per-case `autonomy` of `auto | assisted | observe`.
- Fully observable: every inbound/outbound/observation/action/transition is an append-only `event` row.
- Fully interactible: operators edit fields, force transitions, and reply to the contact from the dashboard; the agent picks up the new state on the next turn.

## Built for low tech literacy (both sides)

casey assumes the people on both ends may not be technical. That shapes two surfaces:

**The person messaging in (WhatsApp/Discord).** They may be elderly, may not read
well, and may not speak English as a first language. So casey:

- replies in **plain, short, warm** language -- one idea per sentence, one question at
  a time, and never any internal jargon (case, triage, workflow, status, priority).
- **mirrors their language**: if they write in Spanish, it answers in Spanish.
- on first contact, **greets them and gives their reference number in plain words**, and
  sets the expectation that a real person will follow up.
- understands a few **simple keywords in any phrasing or language** and answers instantly,
  without an LLM turn, where a fixed answer is better: `HELP` (a short menu), `STATUS`
  (where their request stands, in plain words), `HUMAN` (hands off to a person -- flags the
  case `needs-human`, raises priority, and reassures them), `STOP` (opts them out; casey
  will not message again unless they ask for `HELP`/`HUMAN`).
- never sends a blank or dead-end reply -- empty, emoji-only, and media-only messages still
  get a gentle, helpful answer.
- answers a greeting or chit-chat ("hi", "hello", "help") with a warm invitation to report,
  not the case-acknowledgement -- a turn that carries no domain-relevant content does not get
  "Thank you for letting us know ... your reference is X"; the moment the contact states a
  real fact, casey switches to gathering the report as usual.

**The operator watching the dashboard.** They may not understand workflow jargon either. So:

- a **"Needs you now" inbox** is pinned to the top of the list. It is a guided queue of only the
  cases that need a person right now (someone asked for a human, a case casey will not answer on
  its own, a request stuck waiting over a day), each shown with the plain reason it is there
  ("This person asked to talk to a real person.") and ranked by urgency, so the operator never
  has to hunt. When nothing needs a person it shows a calm "All caught up" message, not a blank box.
- a one-time **plain-words help overlay** (re-openable with the `?` button) explains, with no
  jargon, what each row is, what the amber dot means, and what every button does.
- a **plain-language mode** (remembered across visits) relabels stages to
  friendly names (`Looking into it`, `Working on it`, `Done`, ...) everywhere.
- each open case shows a **"what to do now"** line derived from its state (e.g. "This person asked
  for a real person. Reply to them below."), plus **ready-made replies** the operator can tap to
  fill the reply box (then edit before sending) -- no blank-page problem.
- if the person wrote in another language, the reply box **warns the operator to answer in their
  language**, and the ready-made replies are not offered for someone who asked to stop.
- when someone asks for a human, a **loud red banner** (with a soft chime and a flashing browser
  tab) appears once for that case so an idle operator notices; opening the case clears it.
- when the operator moves a case to a new stage, casey can send the person a **short plain-language
  note** ("Good news. Someone is working on your request now.") so they are kept informed without
  having to ask. Internal stages stay silent, and a person who opted out is never messaged.

## Reporter access tiers

Anyone messaging in defaults to the **reporter** tier: casual, public, report-only.
An operator can promote a trusted reporter (the Reporters panel, or the `casey
operators` CLI break-glass path) to **field_worker**, which additionally unlocks
agentic case-query tools (their own open cases, "near me" lookups, place
enquiries) and casual location check-ins so they show up on the operator map for
direction/dispatch. The tier is never agent-settable -- no `case_*` tool touches
it, so nothing a contact says in conversation can promote themselves.

## Quickstart (operator)

You do not need to be a developer to run casey day-to-day:

```sh
npm install
node bin/casey.js init       # writes a .env you fill in (channel tokens, session secret)
node bin/casey.js doctor     # green/red preflight: deps, channels, port, config -- fix the reds
node bin/casey.js up         # starts the gateway + dashboard, prints the dashboard URL
```

Then open the dashboard URL it printed (default `http://localhost:4000`). `casey init` and
`casey doctor` exist so the first run tells you exactly what is and isn't ready before you start;
`doctor` flags partial WhatsApp credentials, a missing `thatcher.config.yml`, an unusable
`ACPTOAPI_CHAIN_LINK_TIMEOUT_MS`, dirty or off-`main` submodules and a held port instead of
failing silently. The dashboard uses per-operator login, not a shared token; a fresh deployment
auto-creates one admin account on first boot and prints its password once.
casey needs at least one real channel (Discord or WhatsApp) configured in `.env` before `casey up`
will start -- there is no offline demo mode.

Note for developers: a bare `npm install` at this repo's root crashes once the
`node_modules/@freddie/*` junctions exist (an `@npmcli/arborist` tree-load
failure across the 220 junctions). Run `node scripts/install-freddie-deps.mjs`
and `node scripts/link-deps.mjs` directly instead -- see `AGENTS.md`'s Dev
workflow.

### The dashboard

The dashboard is the whole operator surface -- one page, no build step:

- **"Needs you now" inbox (top of the list):** a ranked, plain-worded queue of just the cases that
  need a person now -- someone asked for a human, a case casey will not auto-answer, or a request stuck
  waiting over a day. Each row leads with the reason; opting-out contacts are never listed. It reads
  "All caught up" when there is nothing to do. The **Focus** button (or a `#inbox`
  link) collapses the page to just this ranked list and lightens background
  polling -- a phone-friendly, single-column triage view; tap a row to open it.
- **Case list (left):** every case, with a priority badge, last-activity time, and an amber dot on
  cases that need a human (autonomy `observe`/`assisted`, or someone who asked for a person). A live
  **search** box (press `/`) filters by ref/subject/summary/contact, and a **stage** dropdown filters
  by workflow status. `j`/`k` move the selection, `Enter` opens, `Esc` clears.
- **Detail (right):** edit subject/summary/priority/tags/assignee/**autonomy** (with an inline
  explainer of what each autonomy mode does) and **Save**. **Override** the workflow stage with an
  optional reason. **Reply** to the contact on their channel as a human (`Ctrl`/`Cmd`+`Enter` to send),
  with **ready-made replies** you can tap to start from and a warning to answer in the contact's
  language when they did not write in English; the toast tells you whether it was delivered or only
  logged, and whether the stage change sent the person a note.
- **Handoff alert:** when a contact asks for a real person, a loud banner (chime + flashing tab) fires
  once for that case so an idle operator notices; opening the case clears it.
- **Team workload (`Team` button):** a worst-first, aggregate-only view of who is holding what -- per
  operator: open cases assigned, claims sitting too long, replies sent today, usual first-reply speed,
  and the oldest case still waiting. A card per rostered operator (the live `operator_account` table,
  managed from the dashboard) even at zero load, so management sees overload and dropped claims at a
  glance without opening a case; no per-contact rows.
- **Map view:** every case with an agent-estimated or GPS `lat`/`lon` plotted on a Leaflet+OSM map,
  status-colored and clustered, with a correlated-cases overlay, an operator-coverage overlay (each
  operator's learned working area), and a field-worker location overlay (from `case_checkin`
  self-reports). A case with no coordinate lands in an "unresolved" bucket instead of being dropped.
- **Secretary queue:** `/api/secretary/queue` groups the worst-first attention list by normalised
  place and by assignee, so a follow-up owner sees which reports have been dropped and where.
- **Reporters panel:** promotes a trusted reporter to the `field_worker` access tier (unlocking their
  own case-query tools and casual location check-ins) or demotes them back to `reporter`. Operator-only
  and never agent-settable -- see "Reporter access tiers" above.
- **Mine filter (`Mine` button):** once you have picked who you are (top-right), `Mine` scopes both the
  case list and the "Needs you now" inbox to just the cases you have claimed, so a busy shift can work
  its own queue.
- **Keyboard triage:** `j`/`k` move the selection, `o`/`Enter` opens the top case, `c` claims the open
  case as yours, `e` jumps to the reply box, `/` focuses search, `?` toggles help, `Esc` steps back.
- **Timeline:** every inbound/outbound/note/action/transition/observation as an append-only row,
  colour-coded by kind, with relative timestamps (hover for the absolute time).
- **Plain-language help + first-run onboarding:** a focused three-step **quick-start overlay** greets a
  first-time operator (pick who you are; the inbox is your queue; claim before you reply) and is
  remembered once dismissed (re-open from help). A separate **help overlay** (`?`) explains everything
  including the keyboard shortcuts; a **plain-mode** toggle relabels stages to friendly names
  everywhere (remembered), and each open case shows a **"what to do now"** hint derived from its state.
- Non-blocking **toasts** replace alert popups, a banner appears if the connection drops, the case list
  polls every 5s while it is the visible surface (paused while you're typing so it never clobbers an
  edit, and stood down on the map home view and in Focus mode), new cases raise a toast, the open case
  is **deep-linked** in the URL (shareable), and a **light/dark** toggle persists.
  All contact-supplied text is HTML-escaped before render.

## Commands

```sh
node bin/casey.js init          # scaffold a .env
node bin/casey.js doctor        # preflight: what's ready, what's missing
node bin/casey.js up            # gateway (any channel with creds) + dashboard on :4000
node bin/casey.js dashboard     # observe/edit dashboard only, on :4000
node bin/casey.js cases         # list cases (empty -> hint on how to make one)
node bin/casey.js show <ref|id> # show a case + full timeline
node bin/casey.js attention     # worst-first attention ranking
node bin/casey.js handover      # shift-handover summary
node bin/casey.js report        # management report (SLA, response + closure rates) over --days N, default 30
node bin/casey.js health        # read-only guardrail summary (writes nothing)
node bin/casey.js sweep         # run the health-guardrail sweep once now (writes tags/observations)
node bin/casey.js transition <ref|id> <stage> [--reason]   # legality-checked stage move
node bin/casey.js erase-contact <contact|ref> --yes [--reason]  # irreversibly scrub a contact's PII
node bin/casey.js operators <add|list|disable|enable> ...  # dashboard login accounts (break-glass)
node bin/casey.js --version     # print the version  (also --help / -h on any command)
npm run lint                    # dependency-free preflight; the gate to run before pushing
npm run gui-check               # drives the real dashboard in headless Chromium (needs a browser)
npm run scan-deps               # supply-chain scan of own source + node_modules
npm run check-submodules        # branch/dirty/ahead-behind report on every deps/* checkout
```

`npm run lint` (`node scripts/lint.mjs`) runs every check that works from a bare
clone: `node --check` on all JS, a YAML parse of `thatcher.config.yml`,
`package.json` sanity, the ASCII-only source convention, and the structural
grep gates -- `pure-llm`, `no-stub-mock`, `pii-safety`, `trust-boundary`,
`cli-help`, plus `design-lint` when `deps/design` happens to be checked out. It
needs no sibling checkouts. There is no CI workflow in this repo -- `.github/`
does not exist -- so `npm run lint` is a local gate a human or agent runs by
hand before pushing. There is no automated test suite either; verification is
manual/live against a real running `casey up` instance.

`casey up` runs the real model through acptoapi's provider chain. Put your provider
key in `~/.acptoapi/.env` (acptoapi loads that file itself, not casey's `.env`) and
set `CASEY_LLM_MODEL` if you want something other than the `claude/sonnet` default.
If the model errors, times out, or returns nothing, casey sends
NOTHING to the contact -- no scripted apology -- and records the failure loudly as an
observation for an operator to see.

`casey up` runs the gateway+dashboard under a supervisor that forks them in a child
worker and recycles it on crash or on a source edit, so a code change reloads
without a manual restart and a crash restarts on its own (the parent never imports
app code). Source under `src/` and a sibling `../freddie/src` is watched by default;
add more dirs with `CASEY_RELOAD_PATHS`. Use `casey up --no-reload` to stop watching
and `casey up --no-supervise` to run in-process without restart-on-crash. See
AGENTS.md "Supervised runtime" for the full env-var set.

### Environment

| Variable | Purpose |
|----------|---------|
| `DISCORD_BOT_TOKEN` | Enable Discord (real bot, gateway WebSocket receive with RESUME). |
| `WHATSAPP_API_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Enable WhatsApp (Meta Graph send). |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification handshake token. |
| `WHATSAPP_APP_SECRET` | When set, inbound webhooks are HMAC-SHA256 verified (`X-Hub-Signature-256`); forged posts are rejected. Required, not optional, once WhatsApp credentials exist. |
| `WHATSAPP_WEBHOOK_PATH` | Path Meta POSTs to (default `/webhooks/whatsapp`). There is no `WHATSAPP_WEBHOOK_PORT`. |
| `CASEY_WEBHOOK_HOST`, `CASEY_WEBHOOK_PORT` | Host/port of the freddie-tree web server carrying that webhook (default `127.0.0.1:4001`) -- a different socket from the dashboard's 4000. This is the port a WhatsApp deployment publishes to Meta as its callback URL, so Meta needs a stable public URL for it; use a tunnel in dev. |
| `CASEY_SESSION_SECRET` | HMAC key signing the dashboard session cookie. The dashboard uses per-operator username/password login (no bearer token, no `?token=`); a fresh deployment with zero accounts auto-creates one admin with a random printed password. Random per process when unset, so a restart logs everyone out -- set it explicitly for sessions to survive a restart. |
| `CASEY_COOKIE_SECURE=0` | Drop the `Secure` flag on the session cookie for a plain-HTTP dev/LAN deployment (Secure is on by default). |
| `CASEY_TRANSCRIBE_VOICE_NOTES=1` | Opt-in: transcribe an inbound voice note and fold the text into the case (needs `OPENAI_API_KEY`). Off by default (external data egress). |
| `CASEY_DESCRIBE_PHOTOS=1` | Opt-in: describe an inbound photo (visible detail relevant to the active domain's report fields) into the case (needs `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`). Off by default (external data egress). |
| `CASEY_VOICE_REPLIES=1` | Opt-in: speak the reply back as a voice note so a reporter who cannot read still hears it (needs `OPENAI_API_KEY` or `ELEVENLABS_API_KEY`). Additive to the text, fail-open, off by default (external data egress). |
| `CASEY_LOG=silent` | Silence casey's structured JSON logs. |
| `CASEY_RELOAD=0` | Disable hot-reload (crash-restart stays on). |
| `CASEY_RELOAD_PATHS` | Comma-separated extra dirs to watch for reload (default `src/` + `../freddie/src`). |
| `CASEY_RECEIVE_SILENCE_MS` | Restart a channel that went silent this long (zombie-receive self-heal; default 0 = off). |

`CASEY_OPERATORS` (a comma-separated `id:Name` roster env var) has been removed --
the team-coverage-gap check reads the live `operator_account` table directly,
the same roster the dashboard's Team panel and Reporters panel already show.
Setting it has no effect.

## Layout

```
casey/
  thatcher.config.yml        entities (case/event/contact) + case workflow (system of record)
  config/default/            bundled demo config: report-fields.yml + persona.cjs
  bin/casey.js               CLI entry; bin/casey-cli.mjs holds the COMMANDS table (colorized, --help/--version)
  freddie-bundle/            casey's Cordis plugins mounted into freddie's real boot(): case-tools, llm-acptoapi, platform (WhatsApp/Discord wiring), tool-allowlist
  src/
    casey.js                 top-level assembly: store + adapters + freddie boot + gateway shim + logger
    adapters/                casey-owned WhatsApp/Discord transport
    agent/run-turn.js        runTurn() adapter driving freddie's real Agent
    config-loader.js         resolves CASEY_CONFIG_DIR (or config/default/): report-fields.yml + persona.cjs
    store/report-shape.js    derives REPORT_KEYS/CRITICAL_FIELDS/etc from the loaded config
    case-store.js            thatcher wrapper: find-or-create (locked), events, transitions, paging, config validation
    case-runtime.js          process singleton so the plugin reaches the live CaseStore
    case-tools.js            composes the 18 case_* tools (report/get/list/update/observe/transition/mine/today/new/switch/split/checkin/idle/health/stop/handoff/link_suggestions/transitions_available) from the case-tools-*.js modules, autonomy- and tier-enforced
    hooks/handler.js         makeCaseHandler: case-aware inbound (agent-driven, no deterministic text processing), dedup, media, observe -- re-exported by gateway-hooks.js
    provenance-wire.js       additive provenance-tagged Observation write alongside the real thatcher case.report write
    dashboard/server.js      express API + anentrypoint-design-styled SPA (observe + edit + override + reply + map + reporters + accounts)
```

See `AGENTS.md` for the full source map, every composed project's exact role, and
the complete environment-variable reference (this README covers only the common
subset above).

## Composed AnEntrypoint dependencies (thatcher, freddie, acptoapi, design)

All four are checked out as real git submodules under `deps/` for local
editing. Three of them -- `thatcher`, `acptoapi`, `anentrypoint-design` --
are declared in `package.json` as `file:deps/<name>` npm dependencies, so
`npm install` resolves each straight from its own already-checked-out
submodule: no GitHub fetch, no registry. Editing `deps/<name>` in place and
re-running `npm install` is enough to pick the change up locally; a push to
that project's own `main` is still required before any other clone sees it.

`freddie` is not declared in `package.json` at all. It is a `pnpm` workspace
of ~220 `@freddie/*` packages whose `workspace:^` cross-deps plain `npm` cannot
resolve; `scripts/install-freddie-deps.mjs` runs `pnpm install` inside
`deps/freddie` and `scripts/link-deps.mjs` symlinks each package into
`node_modules/@freddie/`. Both are wired into `postinstall`, and a fresh clone
needs `pnpm` on the machine.

`npm run check-submodules` (also part of `casey doctor`) reports each
submodule's branch/dirty/ahead-behind state. See `AGENTS.md`'s Architecture
and Dev workflow sections for the full mechanism and a copy-pasteable
edit/push/bump sequence.
