# PENDING_VALIDATION

Changes waiting on a live check, and design rows still open. Each row names the view it covers and what closes it.

## Changes in this pass

| Change | View or area | Row closed | Status |
|---|---|---|---|
| Dashboard listener opens before the bot boot. `casey.init()` split into `initStore()` (store only) and `init()` (adapters, freddie, handler). `bin/worker.js` starts the dashboard after `initStore` and before `finishServingCasey` (init, LLM warm-up, start). | Boot, all dashboard views | Boot window: Caddy 502 after a restart while port 4000 is closed | Local: listen 1049 ms vs 3063 ms before, `/api/ready` 200 both times (fake WhatsApp credentials, scratch store). VM: measure bind delay from the journal after deploy |

## Design rows (design-taste-frontend mapped to the staff console)

Status key: OPEN = applies, not started. N/A = the skill row is for marketing pages and does not map to an app console; the reason is given.

### Applies to the console (all OPEN unless noted)

- Typography and spacing system: one scale, one spacing step. OPEN. Views: case list, case detail, field app, map, reports, settings, team, help overlay, account menu.
- Equal left and right edges per view, no sideways scroll at 390 and 1024. OPEN. Same views.
- State design: empty, loading and error for every list and panel (the case list already offers "Clear search and filters" when a filter hides everything). OPEN for loading and error on each panel.
- Focus and keyboard: visible focus ring on every control, the dialog focus rules in src/dashboard/AGENTS.md. OPEN per view; key help overlay lists every key.
- Contrast: text 4.5:1 against the ground (AGENTS.md: `--fg-2`, `--fg-3`, `--danger-ink`). OPEN. Measure per view.
- Motion limits: pulses bounded to about 6 s with a reduced-motion rule; no motion on scroll. OPEN. Check the urgency pulse.
- Touch targets 44 px on phone (AGENTS.md). OPEN. Check the appbar, the phone bottom bar and the map key summary.
- Checker and gate per view: run through playwriter, timed. OPEN. gui-check.mjs needs a Chromium binary and skips without one, so it is not the checker for this pass; the playwriter run replaces it and must be recorded per view.

### Does not apply to a console (N/A)

- copy-lint, copy voice card, copy registers and moves: these lint marketing copy. Console copy is governed by src/dashboard/AGENTS.md (vocabulary.yml, no slop words is not a console requirement).
- Hero dealing, deal.mjs, start.mjs palettes, moments, scenes, shader effects, WebGL contexts: marketing heroes and dealt moments. The console has no hero and no brand deal; its palette is the deployment's brand (brand.js is the one palette).
- Photograph sets, photo credits, stand-ins, product and place plans: the console shows case data, not photographs.
- Section-per-screen height rules, one-section-per-screen and dealt headings: they describe marketing pages.
- Diagram cards, card loops (2.5 to 4 s): decorative; the console's pulse is an urgency signal and stays bounded by the rule above.
- Credits, share tags and the head marketing metas: the console is an authenticated app, not a public page.

## Open items

- Design rows above are OPEN and have not been checked through playwriter. Nothing in this pass changed a view.
- The VM bind delay has not been measured after the boot fix ships. Measure from the uhh journal: systemd start versus the first dashboard listen.
