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
- Checker and gate per view: run through playwriter, timed. OPEN. the browser harness (now in uhh, scripts/casey-gui/gui-check.mjs) needs a Chromium binary and skips without one, so it is not the checker for this pass; the playwriter run replaces it and must be recorded per view.

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

## Design pass: staff console (2026-11-17)

Baseline measured through playwriter on production before these changes (test admin login; axe-core WCAG 2 A/AA from deps/design vendor; overflow; target sizes). Views: case list, map, case detail, 16 panels (metrics, resolved map, disease reports, distribution, activity, handover, offline, team, contacts, routers, areas, nudges, secretary, feedback, external links, view as), settings modal, account menu, help overlay. Field app: not covered (the test login is an admin; a field-role login is needed).

### Changes

| Change | View | Row closed | Status |
|---|---|---|---|
| Account trigger has an accessible name at every width: visible name aria-hidden, visually hidden copy (`.ds-sr-only`) carries the label | Every view (appbar), account menu, help overlay | Keyboard and names: axe button-name on phone (1 per view) | Changed; verify after deploy |
| Guardrail toggle ("Show what needs a check") 44px tall on phone | Case list (phone), case detail (phone) | Touch floor 44px on phone (AGENTS.md) | Changed; verify after deploy |
| Handover refs 24px minimum on desktop, inline-flex | Shift handover | Target size 24px (WCAG 2.2 AA minimum) | Changed; verify after deploy |

### Rows checked and held (no change needed)

- Horizontal overflow: 0 px at 1440 and 390 for all views above (overflow row).
- Contrast, WCAG 2 AA via axe color-contrast: 0 violations in all views above. axe skips elements over images and with no computed background, so this is an automated check, not a full contrast audit.
- Focus visible: row, ref and handoff controls have :focus-visible rules in app.css.
- Motion: urgency pulse has a prefers-reduced-motion rule (app.css); case rows drop their transition under reduced motion.
- One h1 per panel (heading row).

### Rows open (applies, not done)

- Typography and spacing system: one scale and one spacing step across panels. OPEN: not audited beyond overflow.
- Equal left and right edges: alignment of content to the panel gutters not measured. OPEN.
- State design, empty, loading, error: panel-load and panel-error exist; each panel's empty and loading state was not seen. OPEN per panel.
- Target size, desktop 24px: contacts (52 controls under 24px at 1440 in the account and help views, 69 in contacts), handover (69 under 24px, mostly refs). OPEN: checkbox and row controls need their own layout change.
- Target size, phone 44px: list checkboxes (case-row-cbwrap is 44px), contacts (76 under 44px), secretary (109 under 44px), guardrail toggles fixed. OPEN for the rest.
- Help overlay: pressing ? did not produce role=dialog in the audit. OPEN: confirm the overlay markup and its focus trap.
- Field app: not covered. OPEN: needs a field-role login.
- Checker and gate per view: run through playwriter (axe + overflow + targets). The baseline is recorded above; the post-deploy run is the witness.

### Rows not applicable to a console

- Marketing copy lint and voice (copy-lint, copy voice card): applies to the public site, not staff console copy.
- Hero dealing, moments, scenes, shader effects, WebGL, photograph sets and credits: marketing-page rows.
- Section-per-screen height and one-heading-per-section rules: they describe a landing page; the console's panels are scrollable tools.
- Palette and type deal (start.mjs, deal.mjs): the console takes its palette from the deployment brand (brand.js).
