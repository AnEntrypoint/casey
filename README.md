# casey

Agentic case tracking, observation, and manual editing over messaging channels.

casey is used for **animal-disease surveillance in rural South Africa**. Farmers
and NGO field workers report sick or dead livestock over WhatsApp, in their own
language. casey greets them warmly, quietly gathers a structured report (which
animals, the signs, where, how many, how to find the place, how to reach the
farmer) **without interrogating them**, and gives the organising team one
organised, observable view per report. It amplifies the team's own way of
working -- it does not impose disease rules or escalation; priority stays with
the people. Times are shown in SAST and phone numbers in +27 format.

casey is a thin orchestrator that composes three existing projects:

| Layer | Project | Role in casey |
|-------|---------|---------------|
| Agent + channels | [`freddie`](../freddie) | Agent harness + Gateway with WhatsApp/Discord adapters, tools, sessions. Drives the agentic behaviour. |
| System of record | [`thatcher`](https://www.npmjs.com/package/thatcher) | Config-driven CRUD + workflow + RBAC + audit. Holds `case` / `event` / `contact` and the case lifecycle state machine. |
| UI | [`anentrypoint-design`](../anentrypoint-design) | webjsx + ripple-ui design system. Themes the observe + manual-edit dashboard. |

## The flow

```
  WhatsApp / Discord / Sim
        |  message {from, text, raw{id}}
        v
  freddie Gateway -> casey handler -> find/create thatcher case
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
  not the case-acknowledgement -- a turn that carries no animal-health content does not get
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
- a **plain-language mode** (the `Aa` button, remembered across visits) relabels stages to
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

## Quickstart (operator)

You do not need to be a developer to run casey day-to-day:

```sh
npm install
node bin/casey.js init       # writes a .env you fill in (channel tokens, dashboard secret)
node bin/casey.js doctor     # green/red preflight: deps, channels, port, token -- fix the reds
node bin/casey.js up         # starts the gateway + dashboard, prints the dashboard URL
```

Then open the dashboard URL it printed (default `http://localhost:4000`). `casey init` and
`casey doctor` exist so the first run tells you exactly what is and isn't ready before you start;
`doctor` flags partial WhatsApp credentials and an unset dashboard token instead of failing silently.
casey needs at least one real channel (Discord or WhatsApp) configured in `.env` before `casey up`
will start -- there is no offline demo mode.

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
  and the oldest case still waiting. A card per rostered operator (`CASEY_OPERATORS`) even at zero load,
  so management sees overload and dropped claims at a glance without opening a case; no per-contact rows.
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
  including the keyboard shortcuts; an **`Aa` plain-mode** toggle relabels stages to friendly names
  everywhere (remembered), and each open case shows a **"what to do now"** hint derived from its state.
- Non-blocking **toasts** replace alert popups, a banner appears if the connection drops, the list
  auto-refreshes every 5s (paused while you're typing so it never clobbers an edit), new cases raise a
  toast, the open case is **deep-linked** in the URL (shareable), and a **light/dark** toggle persists.
  All contact-supplied text is HTML-escaped before render.

## Commands

```sh
node bin/casey.js init          # scaffold a .env
node bin/casey.js doctor        # preflight: what's ready, what's missing
node bin/casey.js up            # gateway (any channel with creds) + dashboard on :4000
node bin/casey.js dashboard     # observe/edit dashboard only, on :4000
node bin/casey.js cases         # list cases (empty -> hint on how to make one)
node bin/casey.js show <ref|id> # show a case + full timeline
node bin/casey.js --version     # print the version  (also --help / -h on any command)
npm run lint                    # dependency-free preflight: JS syntax + config + package + ascii
```

`npm run lint` (`node scripts/lint.mjs`) runs every check that works from a bare
clone -- `node --check` on all JS, a YAML parse of `thatcher.config.yml`,
`package.json` sanity, and the ASCII-only source convention. It needs no sibling
checkouts, so it is the gate the GitHub Actions `ci` workflow
(`.github/workflows/ci.yml`) runs on every push and pull request. There is no
automated test suite; verification is manual/live against a real running
`casey up` instance.

`casey up` runs the real model via freddie's provider resolver (configure `~/.freddie`
+ a provider key). If the model errors, times out, or returns nothing, casey sends
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
| `WHATSAPP_APP_SECRET` | When set, inbound webhooks are HMAC-SHA256 verified (`X-Hub-Signature-256`); forged posts are rejected. |
| `WHATSAPP_WEBHOOK_PORT`, `WHATSAPP_WEBHOOK_PATH` | Fixed webhook port/path (Meta needs a stable public URL; use a tunnel in dev). |
| `CASEY_SESSION_SECRET` | HMAC key signing the dashboard session cookie. The dashboard uses per-operator username/password login (no bearer token, no `?token=`); a fresh deployment with zero accounts auto-creates one admin with a random printed password. Random per process when unset, so a restart logs everyone out -- set it explicitly for sessions to survive a restart. |
| `CASEY_COOKIE_SECURE=0` | Drop the `Secure` flag on the session cookie for a plain-HTTP dev/LAN deployment (Secure is on by default). |
| `CASEY_TRANSCRIBE_VOICE_NOTES=1` | Opt-in: transcribe an inbound voice note and fold the text into the case (needs `OPENAI_API_KEY`). Off by default (external data egress). |
| `CASEY_DESCRIBE_PHOTOS=1` | Opt-in: describe an inbound animal photo (visible signs/species/count) into the case (needs `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`). Off by default (external data egress). |
| `CASEY_VOICE_REPLIES=1` | Opt-in: speak the reply back as a voice note so a reporter who cannot read still hears it (needs `OPENAI_API_KEY` or `ELEVENLABS_API_KEY`). Additive to the text, fail-open, off by default (external data egress). |
| `CASEY_LOG=silent` | Silence casey's structured JSON logs (used by tests). |
| `CASEY_RELOAD=0` | Disable hot-reload (crash-restart stays on). |
| `CASEY_RELOAD_PATHS` | Comma-separated extra dirs to watch for reload (default `src/` + `../freddie/src`). |
| `CASEY_RECEIVE_SILENCE_MS` | Restart a channel that went silent this long (zombie-receive self-heal; default 0 = off). |

## Layout

```
casey/
  thatcher.config.yml        entities (case/event/contact) + case workflow (system of record)
  bin/casey.js               CLI: init / doctor / up / dashboard / cases / show (colorized, --help/--version)
  plugins/case-tools/        freddie plugin registering case_* tools (auto-discovered at boot)
  src/
    casey.js                 top-level assembly: store + host + gateway + adapters + logger
    case-store.js            thatcher wrapper: find-or-create (locked), events, transitions, paging, config validation
    case-runtime.js          process singleton so the plugin reaches the live CaseStore
    case-tools.js            case_* tool definitions (get/list/update/observe/transition), autonomy-enforced
    gateway-hooks.js         makeCaseHandler: case-aware inbound (agent-driven, no deterministic text processing), dedup, media, observe
    discord-receive.js       fallback Discord WS receive for older freddie builds
    dashboard/server.js      express API + anentrypoint-design-styled SPA (observe + edit + override + reply, plain-language mode + help overlay)
```

## thatcher

casey depends on thatcher as a published npm package. The four correctness bugs casey hit
were fixed at source in the thatcher fork (`C:/dev/thatcher`) and pushed; the publish CI
tags and (with an `NPM_TOKEN` repo secret) publishes a bumped version on every push:

- `workflow-engine.js` imported `executeHook` (transition() threw a ReferenceError after the write).
- `busybase-store.js` create() returns the built record (with its genId), not the store's insert() shape.
- `index.js` threads `databasePath` into the embedded store instead of ignoring it.
- `config-generator-engine.js` auto-injects system fields (`id`/`created_at`/`created_by`/`updated_at`/`status`).

Until the fixed thatcher is on npm, casey runs against the last published version and keeps
small compatibility shims in `case-store.js` (`_createReload`, a parsed-graph transition
validator, and a `&system_fields` anchor in the config). These shims are removed once casey
depends on the fixed release.

<!-- auto-deploy witness 1782927443 -->
