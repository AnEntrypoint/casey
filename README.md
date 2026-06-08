# casey

Agentic case tracking, observation, and manual editing over messaging channels.

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

## Quickstart (operator)

You do not need to be a developer to run casey day-to-day:

```sh
npm install
node bin/casey.js init       # writes a .env you fill in (channel tokens, dashboard secret)
node bin/casey.js doctor     # green/red preflight: deps, channels, port, token — fix the reds
node bin/casey.js up         # starts the gateway + dashboard, prints the dashboard URL
```

Then open the dashboard URL it printed (default `http://localhost:4000`). `casey init` and
`casey doctor` exist so the first run tells you exactly what is and isn't ready before you start;
`doctor` flags partial WhatsApp credentials and an unset dashboard token instead of failing silently.
No channel connected yet? `node bin/casey.js sim "my order is late"` runs a full conversation offline
so you can see the flow and a case appear.

### The dashboard

The dashboard is the whole operator surface — one page, no build step:

- **Case list (left):** every case, with a priority badge, last-activity time, and an amber dot on
  cases that need a human (autonomy `observe`/`assisted`). A live **search** box (press `/`) filters by
  ref/subject/summary/contact, and a **stage** dropdown filters by workflow status. `j`/`k` move the
  selection, `Enter` opens, `Esc` clears.
- **Detail (right):** edit subject/summary/priority/tags/assignee/**autonomy** (with an inline
  explainer of what each autonomy mode does) and **Save**. **Override** the workflow stage with an
  optional reason. **Reply** to the contact on their channel as a human (`Ctrl`/`Cmd`+`Enter` to send);
  the toast tells you whether it was delivered or only logged.
- **Timeline:** every inbound/outbound/note/action/transition/observation as an append-only row,
  colour-coded by kind, with relative timestamps (hover for the absolute time).
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
    gateway-hooks.js         makeCaseHandler: case-aware inbound (dedup, media, observe, graceful fallback)
    discord-receive.js       fallback Discord WS receive for older freddie builds
    sim/inject.js            MockAdapter + scripted-conversation runner (offline)
    sim/stub-llm.js          deterministic model for sim + tests (never used in production)
    dashboard/server.js      express API + anentrypoint-design-styled SPA (observe + edit + override + reply)
  test.js                    end-to-end suite (17 assertions, all green)
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
