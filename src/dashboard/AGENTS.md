# AGENTS.md (src/dashboard)

Imperatives for the operator console. Root `AGENTS.md` covers the access ladder, the PII allowlists and the field-login fence; this file does not repeat them. Reasons live in gm memory; each `-> recall` line retrieves its memo.

## Shell and caching (server.js)

- `SHELL_BUILD_ID` must hash every input to the served shell (public/ size+mtime, linked bundles, module graph, brand, tile URL, vocabulary); the service-worker cache name carries it.
- Rewrite brand, tile URL, vocabulary and the modulepreload block into the SERVED bytes only, never into `index.html` on disk.
- Modulepreloads: no `crossorigin`, static imports only, never `/design/dist/247420.js` (no `/design-sdk-shim.js` route, no importmap entry for it).
- Static files revalidate every time; `/api/`, `/report` and tiles are never in Cache Storage; keep `skipWaiting`.
-> recall {query:"casey dashboard shell build id service worker cache modulepreload"}

## Middleware order and edges (server.js)

- Error middleware LAST and never echo `err.message` or a stack; WhatsApp webhook FIRST (it carries its own HMAC).
- `compressResponses` stays hand-rolled: 200 only, skip tiny bodies, always `Vary`, drop `Content-Length`, stream.
- Set `CASEY_TRUST_PROXY_HOPS` to the real hop count behind a proxy.
- CSV export neutralises a leading `= + - @` and quotes a bare `\r`. `/tiles` stays behind the auth gate, never serves blank tiles, keeps the OSM policy rules (User-Agent, Referer, 7-day floor, zoom cap, no prefetch).
-> recall {query:"casey dashboard middleware order error webhook compression trust proxy csv tiles"}

## Printables and brand (server.js, brand.js)

- Unrecorded field prints BLANK (`.ds-print-blank`); ruled lines are a BORDER (`.ds-fill-lines`); screen default BEFORE the print block; `extraCss` BEFORE `@media print`; line-height stays unset.
- `brand.js` is the one palette; the text tone is the ground darkened only until it measures 4.5:1. Server-rendered type/spacing is a CLOSED set; `lint.mjs` `server-css-tokens` fails an undefined `var()`. Skip the icon's `font-size="120"` in font sweeps.
-> recall {query:"casey printed briefing form filled in with a pen blank field ruled writing lines"}

## Auth, roles and routes (auth.js, roles.js, routes/)

- `registerAuth` order: session -> CSRF Origin/Referer -> public -> `authGate` -> static. Never reorder. `/api/sync/*` is gate-exempt only via `requireScope`.
- `changePassword` re-verifies the current password, bumps `session_epoch`, and its caller MUST re-issue the cookie. `deleteAccount` revokes the epoch BEFORE removing the row and never deletes the last enabled admin. Write epochs as strings. Self-revoke uses `req.caseyAccount.id`.
- No bearer token or `?token=`. `secretary` is a legacy alias (never created new); `agent` is the unclaimed marker; `x-view-as` is admin-only and read-only.
- `roleGate`: decide on the lower-cased prefix; media is exactly `/media/<caseId>/<file>` decoded, with `nosniff` and `Content-Disposition`; viewer allowlist holds only PII-free routes; `expected_ref` mismatch is 409.
-> recall {query:"casey dashboard auth session epoch changePassword roleGate viewer allowlist media"}

## Public form and route rules (routes/)

- `/report` only when `CASEY_PUBLIC_URL` is set; the ref is the secret, add-only, never shown; redirects carry codes (`?err=`) not sentences; refusals re-render, success is PRG; rate limit is per-IP and loose; field list derives from `report-shape`; page is inline CSS, light-only, no HTML comments.
- `/api/ready`: ungated, PII-free, closed vocabulary; degraded 200, dead store 503, busy retries once.
- `cases.js`: `export.csv` before `/:id`; one shared detail projection; reply refuses an opted-out case, claims before the outbound event, clears flags only after delivery; PATCH `expected` compares as strings; undo 120 s, `created_at` is seconds; bulk validates once.
- `map.js` dispatch only queues; coordinates carry `location_source`; memo keys never use a clock. `reports-map.js`: sanitise labels, 0.01 degree, week-only. `translate.js` `recordHealth:false`. `sync-api.js` forces `proposed`.
-> recall {query:"casey public report form ready probe cases route undo map memo"}

## Console UI (public/src)

- Dropdown triggers return an ARRAY; one element type plus keys per slot; never swap a button's text mid-action; `Btn` is `type=button` (login-gate uses a raw submit); array children need `aria-label`; bound free text (`MAX_LEN` 4000) in its own `min-width:0` element.
- dialog-shell: restore focus by node plus signature, pass `trapTab` the `currentTarget`, `stopPropagation` on Escape, focus once per open in a macrotask. Never state anything by hue or hover-only title. One h1 per screen; content-swap panels render BODY only; never register a `map` panel; keep `case-row` off the kit Row.
-> recall {query:"casey console webjsx dropdown trigger array accessibility dialog focus"}
- Mutate state only via `setActiveId`/`setAttention`/`setConnLost` and the bounds setters; send only changed fields with expected values; one in-flight flag for sends to a person; `'opted-out'` tracks `OPTED_OUT_TAG`; filter client-side on PII-free fields and state the true server total beside a cap; urgency only from `urgencyBand`.
- Fetch only through `api()` (`FETCH_TIMEOUT_MS`); offline is a RESOLVED 503, never infer link health from settling; cache only whoami/branding/config; polls gate on `state.authed`; list ladder max `ATTENTION_POLL_MS`; tab title via `setBaseTitle`.
- Map: tile URL from the shell meta, never hardcoded OSM; frame BEFORE `tileLayer`; skip `invalidateSize` while hidden; marker colour = status, border = provenance, size+ring = urgency, rebuild only on signature change; keep `RETRY_MIN_GAP_MS`, `INFLIGHT_STALE_MS` and clear `inFlight` in `finally`; never rename `reportedDiseaseNames`.
- Panels: `panel-load` sets `loaded` on failure too and keeps its generation counter; `known-values` is synchronous; `vocabulary.js` never spells "casey", "case" or tier names.
-> recall {query:"casey console data safety setActiveId poll offline conditional get map marker panel-load"}

## Shell document (public/index.html)

- `html` and `body` carry `.ds-247420` (`#app` too); theme is `data-casey-theme` stamped by the head script, never `data-theme` on `html`, never a hardcoded `data-theme`, never `data-accent`.
- Link only `/design/dist/247420.css`; kit JS only through the `ds/` import map; font preloads keep `crossorigin`.
- `#ds-boot` stays inline-styled and AFTER `#app`; Leaflet scripts stay below it and ahead of `/src/main.js`; the service-worker reload requires a pre-existing controller and waits until the person stops typing.
-> recall {query:"casey index.html data-casey-theme head inline script data-accent ds-boot hadController reload"}

## Stylesheets (public/app.css, public/src/views/*.css)

- Ground off `data-casey-theme` with `--paper`/`--ink`, never `--bg`; keep the `.ds-247420` prefix on btn-link, dropdown, h2/button and `.app-chrome`/`.app-status` rules; text contrast 4.5:1 (`--fg-2`/`--fg-3`, `--danger-ink`; pin Leaflet control text to `--ink`).
- Rail never `overflow:hidden` without an inner scroller; phone map/list `display:none`, never unmount; `.ds-map-shell` chrome keeps `pointer-events:none`; phone rules last; gutters collapse at 480px.
- Urgency is size, ring and a short flag, never hue alone; pulse bounded to about 6 s with a reduced-motion rule; 44px touch floor outranks `.btn-sm`; `td` uses `overflow-wrap:break-word`, never `anywhere`.
-> recall {query:"casey dashboard stylesheet rules theme contrast rail urgency touch"}

## Backup (src/backup.js)

- Raw-copy fallback includes `-wal`/`-shm`; restore removes stale sidecars, refuses a non-empty target, and moves the live data dir aside.
-> recall {query:"casey backup wal sidecar restore"}
