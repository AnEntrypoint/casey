# AGENTS.md (src/dashboard)

Imperatives for the operator console. Root `AGENTS.md` covers the access ladder, the PII allowlists and the field-login fence; this file does not repeat them. Reasons live in gm memory; each `-> recall` line retrieves its memo.

## Shell and caching (server.js)

- `SHELL_BUILD_ID` must hash every input to the served shell (public/ size+mtime, linked bundles, module graph, brand, tile URL, vocabulary); the service-worker cache name carries it.
- Rewrite brand, tile URL, vocabulary and the modulepreload block into the SERVED bytes only, never into `index.html` on disk.
- Modulepreloads: no `crossorigin`, static imports only, never `/design/dist/247420.js` (no `/design-sdk-shim.js` route, no importmap entry for it).
- Public site (`routes/public-site.js`): `/site/` is mounted BEFORE `authGate` and is GET/HEAD only; it never creates a session; the SW must bypass `/site/` and never serve the cached console for a `/` navigation when the site is on (the shell precaches `/app` instead).
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
- Self-service reset: `GET /forgot-password` and `POST /api/password-reset/request` (routes/password-reset.js) are public and mounted before `authGate`. Every identifier gets the same 200 answer whether or not it matched, and no response carries a link. A link is sent only by email, only to an enabled account with an email on file, through `issueSetupLink` with `CASEY_PUBLIC_URL` as the only base (never the request host). The request never changes `session_epoch` or `must_change_password`. Limits: 10 requests per IP per 15 min (429 for everyone); 3 requests per account per hour (silently not sent, same answer). Tests: `npm test` (`CASEY_CONFIG_DIR` required).
- `changePassword` re-verifies the current password, bumps `session_epoch`, and its caller MUST re-issue the cookie. `deleteAccount` revokes the epoch BEFORE removing the row and never deletes the last enabled admin. Write epochs as strings. Self-revoke uses `req.caseyAccount.id`.
- `POST /api/client-log` (routes/client-log.js) is session-gated; it keeps 30 lines per session per minute in memory and logs only level/event/detail/route/operator, each cut to 200 characters with control characters stripped. Every request (any method) gets a `gui_request` line from `guiRequestLogger`, mounted after the webhook; writes also keep `gui_action`. The browser hooks (public/src/client-log.js) forward message text and view names only, never case ids.
- No bearer token or `?token=`. `secretary` is a legacy alias (never created new); `agent` is the unclaimed marker; `x-view-as` is admin-only and read-only.
- `roleGate`: decide on the lower-cased prefix; media is exactly `/media/<caseId>/<file>` decoded, with `nosniff` and `Content-Disposition`; viewer allowlist holds only PII-free routes; `expected_ref` mismatch is 409.
-> recall {query:"casey dashboard auth session epoch changePassword roleGate viewer allowlist media"}

## Public form and route rules (routes/)

- `/report` only when `CASEY_PUBLIC_URL` is set; the ref is the secret, add-only, never shown; redirects carry codes (`?err=`) not sentences; refusals re-render, success is PRG; rate limit is per-IP and loose; field list derives from `report-shape`; page is inline CSS, light-only, no HTML comments.
- `/api/ready`: ungated, PII-free, closed vocabulary; degraded 200, dead store 503, busy retries once.
- `cases.js`: `export.csv` before `/:id`; one shared detail projection; reply refuses an opted-out case, claims before the outbound event, clears flags only after delivery; PATCH `expected` compares as strings; undo 120 s, `created_at` is seconds; bulk validates once.
- `reports-map.js` advice is a CLOSED set of kinds from `conclusionKinds`, never the typed words; `/api/reports/areas` bubbles are 0.1 degree, named areas only, floor of `MIN_AGGREGATE_CELL`. `map.js` dispatch only queues; coordinates carry `location_source`; memo keys never use a clock. `reports-map.js`: sanitise labels, 0.01 degree, week-only. Resolved-map points also carry `status` (confirmed|suspected, ruled_out never reaches the map): a closed 2-value enum on a cell already floored by `MIN_AGGREGATE_CELL` over all statuses, so it adds no identifying detail; viewers may see it. `/api/reports/diseases/print` is the printable disease report (aggregates only, same filters and viewer allowlist as `/diseases`). `translate.js` `recordHealth:false`. `sync-api.js` forces `proposed`.
-> recall {query:"casey public report form ready probe cases route undo map memo"}

## Console UI (public/src)

- Dropdown triggers return an ARRAY; one element type plus keys per slot; never swap a button's text mid-action; `Btn` is `type=button` (login-gate uses a raw submit); array children need `aria-label`; bound free text (`MAX_LEN` 4000) in its own `min-width:0` element.
- dialog-shell: restore focus by node plus signature, pass `trapTab` the `currentTarget`, `stopPropagation` on Escape, focus once per open in a macrotask. Never state anything by hue or hover-only title. One h1 per screen; content-swap panels render BODY only; never register a `map` panel; keep `case-row` off the kit Row.
-> recall {query:"casey console webjsx dropdown trigger array accessibility dialog focus"}
- Mutate state only via `setActiveId`/`setAttention`/`setConnLost` and the bounds setters; send only changed fields with expected values; one in-flight flag for sends to a person; `'opted-out'` tracks `OPTED_OUT_TAG`; filter client-side on PII-free fields and state the true server total beside a cap; urgency only from `urgencyBand`.
- Fetch only through `api()` (`FETCH_TIMEOUT_MS`); offline is a RESOLVED 503, never infer link health from settling; cache only whoami/branding/config; polls gate on `state.authed`; list ladder max `ATTENTION_POLL_MS`; tab title via `setBaseTitle`.
- Map: tile URL from the shell meta, never hardcoded OSM; frame BEFORE `tileLayer`; skip `invalidateSize` while hidden; marker colour = status, border = provenance, size+ring = urgency, rebuild only on signature change; keep `RETRY_MIN_GAP_MS`, `INFLIGHT_STALE_MS` and clear `inFlight` in `finally`; never rename `reportedDiseaseNames`.
- Panels: `panel-load` sets `loaded` on failure too and keeps its generation counter; `known-values` is synchronous; `vocabulary.js` never spells "casey", "case" or tier names.
- Map key is `details.ds-map-legend` with a `Key` summary (`ui.map_panel_key_toggle`): open above 1280px, closed at or below, so the map shows through. Its summary stays a 44px target on phone.
- Keyboard: `j k o Enter c e / n ?` plus chords `g m` (map) and `g r` (reports list), with a 1.2 s window, all in `keyboard.js`. Each new key also goes in `components/help-overlay.js` and `help_overlay_key_*` in the deployment vocabulary.
- A filtered-empty case list offers "Clear search and filters" (`clearAllFilters` in `views/case-list-view.js`). An empty state offers an action, not only text.
- The account name is `.ds-account-name`, hidden on phone; the trigger keeps its aria label.
-> recall {query:"casey console data safety setActiveId poll offline conditional get map marker panel-load"}

## Shell document (public/index.html)

- `html` and `body` carry `.ds-247420` (`#app` too); theme is `data-casey-theme` stamped by the head script, never `data-theme` on `html`, never a hardcoded `data-theme`, never `data-accent`.
- Link only `/design/dist/247420.css`; kit JS only through the `ds/` import map; font preloads keep `crossorigin`.
- Theme ids, the font stack and font faces are `__CASEY_*__` tokens in public/index.html, app.css and src/components/account-menu.js. `brand-tokens.js` resolves them at serve time from `brand.yml` in CASEY_CONFIG_DIR (missing tokens take the neutral defaults there); an overlay under `CASEY_CONFIG_DIR/public/` is served after public/. Never write a deployment brand name into public/.
- `#ds-boot` stays inline-styled and AFTER `#app`; Leaflet scripts stay below it and ahead of `/src/main.js`; the service-worker reload requires a pre-existing controller and waits until the person stops typing.
-> recall {query:"casey index.html data-casey-theme head inline script data-accent ds-boot hadController reload"}

## Stylesheets (public/app.css, public/src/views/*.css)

- Ground off `data-casey-theme` with `--paper`/`--ink`, never `--bg`; keep the `.ds-247420` prefix on btn-link, dropdown, h2/button and `.app-chrome`/`.app-status` rules; text contrast 4.5:1 (`--fg-2`/`--fg-3`, `--danger-ink`; pin Leaflet control text to `--ink`).
- Rail never `overflow:hidden` without an inner scroller; phone map/list `display:none`, never unmount; `.ds-map-shell` chrome keeps `pointer-events:none`; phone rules last; gutters collapse at 480px.
- Urgency is size, ring and a short flag, never hue alone; pulse bounded to about 6 s with a reduced-motion rule; 44px touch floor outranks `.btn-sm`; `td` uses `overflow-wrap:break-word`, never `anywhere`.
- Appbar: up to 1280px the attention lead, the primary action and the account stay visible; the rest sit behind `.ds-appbar-more` (More / Fewer). An expanded bar (`.is-more-open`) wraps at full width and never scrolls sideways.
- Phone (max-width 700px): the appbar is a fixed bottom bar above the fixed status footer (`--phone-bar-h` 6.5rem, `--app-status-h` 4rem on `.ds-247420`), and `.app-body` pads by both. Both hide while a case sheet is open (`.app-two-pane.has-active`, via `:has()`) so the reply box is never covered. The phone overrides sit at the end of app.css.
- Kit specificity: `.btn-primary:not(.btn-sm):not(.btn-lg)` gets its padding from a 480px kit rule at (0,5,0); appbar overrides must use the same `:not` pair or they lose.
- The phone status footer wraps (height auto around the 44px status toggle) so `Replies are not sent from this screen` is never clipped.
-> recall {query:"casey dashboard stylesheet rules theme contrast rail urgency touch"}

- `GET /api/reports/files[/:name]` serves only `casey-digest-YYYY-MM.(csv|txt)` from `<store.dataDir>/digests` (checked after decoding; attachment, nosniff) and is on the viewer allowlist because the digests are k-floored aggregates; field logins stay refused by the `roleGate` fence.

## Backup (src/backup.js)

- Raw-copy fallback includes `-wal`/`-shm`; restore removes stale sidecars, refuses a non-empty target, and moves the live data dir aside.
-> recall {query:"casey backup wal sidecar restore"}

- Field screen (`field-app.js`): the search and pill bar is one stable keyed block that never unmounts on refresh; list refreshes are generation-guarded (last wins); Closed is a separate server-paged list; field logins get no undo toast (`/undo` reverts whichever operator move was latest, so it stays off `FIELD_ROUTES`); the photo strip reads only `(saved: media/<this case>/...)` image notes.
