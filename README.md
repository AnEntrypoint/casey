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
  back to channel  (graceful fallback if the model errors or returns empty)

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

### Try the personas

`casey sim --scenario <name>` replays a built-in low-literacy persona offline so you can see
how casey handles each one:

```sh
node bin/casey.js sim --scenario fmd-cattle              # foot-and-mouth signs in cattle
node bin/casey.js sim --scenario sudden-deaths           # animals dying suddenly
node bin/casey.js sim --scenario afrikaans-farmer        # reports in Afrikaans
node bin/casey.js sim --scenario isizulu-farmer          # reports in isiZulu
node bin/casey.js sim --scenario confused-elderly        # vague, one-word, polite
node bin/casey.js sim --scenario asks-for-human          # wants a real person
node bin/casey.js sim --scenario photo-only              # sends a photo, few words
node bin/casey.js sim --scenario location-logistics      # far in the bush, hard to reach
node bin/casey.js sim --scenario full-lifecycle          # intake -> status -> asks for a human
node bin/casey.js sim --scenario false-positive-guard    # reports that look like keywords
node bin/casey.js sim --scenario afrikaans-farmer        # run live: add --real
node bin/casey.js sim --help                             # list every persona
```

The same personas run in the test suite, asserting every reply stays non-blank, short,
jargon-free, cites the reference, and offers a person exactly when one is asked for.

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
No channel connected yet? `node bin/casey.js sim "my cattle are sick and some died"` runs a full conversation offline
so you can see the flow and a case appear.

### The dashboard

The dashboard is the whole operator surface -- one page, no build step:

- **"Needs you now" inbox (top of the list):** a ranked, plain-worded queue of just the cases that
  need a person now -- someone asked for a human, a case casey will not auto-answer, or a request stuck
  waiting over a day. Each row leads with the reason; opting-out contacts are never listed. It reads
  "All caught up" when there is nothing to do.
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
- **Timeline:** every inbound/outbound/note/action/transition/observation as an append-only row,
  colour-coded by kind, with relative timestamps (hover for the absolute time).
- **Plain-language help:** a first-run **help overlay** (re-open with `?`) explains everything in plain
  words, an **`Aa` plain-mode** toggle relabels stages to friendly names everywhere (remembered), and
  each open case shows a **"what to do now"** hint derived from its state.
- Non-blocking **toasts** replace alert popups, a banner appears if the connection drops, the list
  auto-refreshes every 5s (paused while you're typing so it never clobbers an edit), new cases raise a
  toast, the open case is **deep-linked** in the URL (shareable), and a **light/dark** toggle persists.
  All contact-supplied text is HTML-escaped before render.

## Commands

```sh
node bin/casey.js init          # scaffold a .env
node bin/casey.js doctor        # preflight: what's ready, what's missing
node bin/casey.js up            # gateway (sim + any channel with creds) + dashboard on :4000
node bin/casey.js sim "msg" ... # offline simulated conversation (stub model, no creds)
node bin/casey.js sim --scenario <name>  # replay a built-in low-literacy persona
node bin/casey.js dashboard     # observe/edit dashboard only, on :4000
node bin/casey.js cases         # list cases (empty -> hint on how to make one)
node bin/casey.js show <ref|id> # show a case + full timeline
node bin/casey.js --version     # print the version  (also --help / -h on any command)
node test.js                    # end-to-end suite (real thatcher + freddie, stub model)
```

`casey up` runs the real model via freddie's provider resolver (configure `~/.freddie`
+ a provider key). Set `CASEY_STUB_LLM=1` to run `up` fully offline with the deterministic
stub. The agent always sends a safe fallback reply if the model errors, times out, or
returns nothing, and records the failure as an observation rather than leaking it to the contact.

### Environment

| Variable | Purpose |
|----------|---------|
| `DISCORD_BOT_TOKEN` | Enable Discord (real bot, gateway WebSocket receive with RESUME). |
| `WHATSAPP_API_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Enable WhatsApp (Meta Graph send). |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification handshake token. |
| `WHATSAPP_APP_SECRET` | When set, inbound webhooks are HMAC-SHA256 verified (`X-Hub-Signature-256`); forged posts are rejected. |
| `WHATSAPP_WEBHOOK_PORT`, `WHATSAPP_WEBHOOK_PATH` | Fixed webhook port/path (Meta needs a stable public URL; use a tunnel in dev). |
| `CASEY_DASHBOARD_TOKEN` | When set, the dashboard API and page require this token (`?token=` or `Authorization: Bearer`). |
| `CASEY_LOG=silent` | Silence casey's structured JSON logs (used by tests). |
| `CASEY_STUB_LLM=1` | Run `casey up` with the offline stub model. |

## Layout

```
casey/
  thatcher.config.yml        entities (case/event/contact) + case workflow (system of record)
  bin/casey.js               CLI: init / doctor / up / dashboard / sim / cases / show (colorized, --help/--version)
  plugins/case-tools/        freddie plugin registering case_* tools (auto-discovered at boot)
  src/
    casey.js                 top-level assembly: store + host + gateway + adapters + logger
    case-store.js            thatcher wrapper: find-or-create (locked), events, transitions, paging, config validation
    case-runtime.js          process singleton so the plugin reaches the live CaseStore
    case-tools.js            case_* tool definitions (get/list/update/observe/transition), autonomy-enforced
    gateway-hooks.js         makeCaseHandler: case-aware inbound (plain-language prompt, intent keywords, dedup, media, observe, fallback)
    discord-receive.js       fallback Discord WS receive for older freddie builds
    sim/inject.js            MockAdapter + scripted-conversation runner (offline)
    sim/scenarios.js         named low-literacy personas for `casey sim --scenario` and tests
    sim/stub-llm.js          deterministic model for sim + tests (plain/Spanish/human-aware; never used in production)
    dashboard/server.js      express API + anentrypoint-design-styled SPA (observe + edit + override + reply, plain-language mode + help overlay)
  test.js                    end-to-end suite (29 assertions, all green)
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
