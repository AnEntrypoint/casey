# AGENTS.md

Operating notes for agents (and humans) working in the casey repo. This file is
included by `CLAUDE.md` via `@AGENTS.md`; keep it accurate against `README.md`
and the source.

## What casey is

casey is a thin orchestrator for **animal-disease surveillance in rural South
Africa**. Field workers report sick or dead livestock over WhatsApp/Discord in
their own language; casey gathers a structured report warmly and without
interrogation, and gives the organising team one observable, editable view per
report. Times are shown in SAST and phone numbers in +27 format. casey amplifies
the team's workflow -- it does not impose disease rules or escalation; priority
stays with people.

## Architecture

casey composes three existing projects and owns only the glue:

| Layer | Project | Role |
|-------|---------|------|
| Agent + channels | `freddie` (`file:../freddie`) | Agent harness + Gateway with WhatsApp/Discord adapters, tools, sessions. |
| System of record | `thatcher` (npm) | Config-driven CRUD + workflow + RBAC + audit. Holds `case` / `event` / `contact` and the lifecycle state machine. |
| UI | `anentrypoint-design` (`file:../anentrypoint-design`) | webjsx + ripple-ui design system theming the dashboard. |

Inbound flow: channel message -> freddie Gateway -> casey case handler (replaces
`handleInbound`) -> find/create thatcher case (locked, deduped by message id) ->
agent turn with case context + `case_*` tools -> reply, with a safe fallback when
the model errors/empties. Every inbound/outbound/observation/action/transition is
an append-only `event` row. The dashboard reads/edits thatcher over its API.

## Source map

```
thatcher.config.yml        entities + case workflow (system of record)
bin/casey.js               CLI: init / doctor / up / dashboard / sim / cases / show
plugins/case-tools/        freddie plugin registering case_* tools (auto-discovered)
src/
  casey.js                 top-level assembly: store + host + gateway + adapters + logger
  case-store.js            thatcher wrapper: find-or-create (locked), events, transitions, paging, config validation
  case-runtime.js          process singleton so the plugin reaches the live CaseStore
  case-tools.js            case_* tool defs (get/list/update/observe/transition), autonomy-enforced
  case-machine.js          xstate case lifecycle machine
  case-health.js           per-case health/guardrail signals
  case-sweep.js            periodic health-guardrail sweep
  correlate.js             cross-case correlation helpers
  gateway-hooks.js         makeCaseHandler: plain-language prompt, intent keywords, dedup, media, observe, fallback
  discord-receive.js       fallback Discord WS receive for older freddie builds
  llm.js                   model call wiring
  sim/inject.js            MockAdapter + scripted-conversation runner (offline)
  sim/scenarios.js         named low-literacy personas
  sim/stub-llm.js          deterministic model for sim + tests (never used in production)
  dashboard/server.js      express API + anentrypoint-design SPA (observe/edit/override/reply)
test.js                    end-to-end suite (real thatcher + freddie, stub model)
```

## Dev workflow

```sh
npm install                 # requires sibling ../freddie and ../anentrypoint-design checkouts
node bin/casey.js init      # scaffold a .env (channel tokens, dashboard secret)
node bin/casey.js doctor    # green/red preflight: deps, channels, port, token
node bin/casey.js up        # gateway + dashboard (default http://localhost:4000)
node bin/casey.js sim "my cattle are sick"        # offline conversation, stub model
node bin/casey.js sim --scenario <name>           # replay a low-literacy persona
npm run lint                # dependency-free preflight (syntax+config+package+ascii); the CI gate
node test.js                # end-to-end suite (CASEY_STUB_LLM path, stub model)
```

CI: `.github/workflows/ci.yml` runs `npm run lint` (`scripts/lint.mjs`) on every
push and PR. It is dependency-free on purpose -- it does NOT need the `file:../`
siblings, so it stays green in a bare clone. Keep `test.js` as the real-services
witness; do not move its real-services assertions into the lint gate.

Note: `freddie` and `anentrypoint-design` are `file:../` dependencies. Without
those sibling checkouts (and `thatcher` from npm) installed, `node test.js` and
`casey up` fail with `ERR_MODULE_NOT_FOUND`; only static review is possible in a
clone that lacks them. Set `CASEY_STUB_LLM=1` to run `up` fully offline.

## Environment

| Variable | Purpose |
|----------|---------|
| `DISCORD_BOT_TOKEN` | Enable Discord (gateway WebSocket receive with RESUME). |
| `WHATSAPP_API_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Enable WhatsApp (Meta Graph send). |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification handshake token. |
| `WHATSAPP_APP_SECRET` | When set, inbound webhooks are HMAC-SHA256 verified; forged posts rejected. |
| `WHATSAPP_WEBHOOK_PORT`, `WHATSAPP_WEBHOOK_PATH` | Fixed webhook port/path for a stable public URL. |
| `CASEY_DASHBOARD_TOKEN` | When set, dashboard API + page require this token (`?token=` or Bearer). |
| `CASEY_LOG=silent` | Silence structured JSON logs (used by tests). |
| `CASEY_STUB_LLM=1` | Run `casey up` with the offline stub model. |

## Design principles (preserve these)

- **Plain, warm language** to the contact: one idea per sentence, no internal
  jargon (case/triage/workflow/status/priority), mirror the contact's language,
  give a plain-words reference number on first contact.
- **Never a dead-end reply**: empty, emoji-only, and media-only inbound still get
  a gentle helpful answer; the agent always sends a safe fallback on model
  error/timeout/empty and records the failure as an observation, never leaked.
- **Fixed keywords short-circuit the LLM**: `HELP` / `STATUS` / `HUMAN` / `STOP`
  answer instantly in any phrasing/language.
- **Full observability**: every action is an append-only audited `event` row.
- **Autonomy modes** per case (`auto | assisted | observe`) scope what the agent
  may do; the dashboard can override stage and reply as a human.
- **Operator surface is low-jargon**: "Needs you now" inbox, plain-language mode,
  ready-made replies, handoff banner, "what to do now" hints.

## Security invariants (do not regress)

- WhatsApp inbound is HMAC-SHA256 verified when `WHATSAPP_APP_SECRET` is set.
- Dashboard API + page gate on `CASEY_DASHBOARD_TOKEN` when set.
- All contact-supplied text is HTML-escaped before render.

## thatcher shim caveat

casey depends on the published thatcher npm package. Four upstream correctness
bugs were fixed in the thatcher fork; until that fixed release is on npm, casey
keeps small compatibility shims in `case-store.js` (`_createReload`, a parsed-graph
transition validator, and a `&system_fields` config anchor). Remove the shims once
casey depends on the fixed thatcher release. See README "thatcher" section.

## Conventions

- ASCII only in source and docs -- no arrow/box/bullet/check glyphs or emoji
  (use `->`, `-`, `[x]`/`[ ]`, words). Code operators are exempt.
- ES modules (`"type": "module"`), Node >= 22.
- The single end-to-end `test.js` against real services is the test surface;
  do not add a parallel mock-heavy unit suite.

@.gm/next-step.md
