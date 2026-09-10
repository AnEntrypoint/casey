# External cross-app sync (speculative prep)

Prep for cross-correlating casey/uhh's cases and contacts with a separate,
in-development app: MEAT NATURALLY - AHT Field Tracker (a livestock-production
field-visit tracker for Animal Health Technicians in EC/KZN/FS South Africa).
There is no live integration today -- no confirmed API, no credentials, no
running endpoint. Everything here is an adapter-shaped seam plus a
correlation/linking store, so a real integration can be wired in later
without a redesign.

## The other app's schema is unconfirmed

`src/sync/external-schema-map.js`'s `EXTERNAL_SCHEMA` is synthesized from
screenshots, terminal sessions, and meeting discussion the user supplied --
not a real API contract. Treat every field name and type there as a
hypothesis. `FIELD_CROSSWALK` maps only the fields that plausibly correlate
with casey's own vocabulary; `NO_CASEY_COUNTERPART` lists what is
deliberately never imported (vehicle logbook, monthly targets, analytics,
user roles, resource library, document-vault metadata beyond a photo URL).

## Additive-only guarantee

Casey's own `case`/`contact`/`event` entities are never extended for this.
The whole cross-app surface lives in one new thatcher entity,
`external_link` (`config/thatcher.config.yml`):

- `system` (enum, currently `meat_naturally` only -- a second integration
  adds its own option value, never a second entity)
- `local_entity` (`case` | `contact`), `local_id` -- the casey-side row
- `external_entity` (free text: `field_visit`, `farmer`, `association`,
  `follow_up` -- free text because the remote schema is unconfirmed)
- `external_id`, `external_ref` (a display-safe label, never a raw phone
  number)
- `match_basis`, `confidence` (0.0-1.0)
- `status` (`proposed` | `confirmed` | `rejected`, default `proposed`)
- `notes`

`row_access: { scope: none }` -- an internal linking table, not a
worker-scoped resource, same shape as `operator_identity`.

A value from the other system only ever lands in casey's existing
`report-fields.yml` REPORT_KEYS or `contact.external_id`, via
`external-schema-map.js`'s `mapExternalFieldsToReport`/
`mapExternalFieldsToContact`, and only on a `confirmed` link -- never
`proposed`.

## Adapter contract

`src/sync/adapters/base.js` defines the contract: a module exporting

- `fetchRemoteRecords(kind, sinceIso)` -- `kind` is one of
  `field_visit | farmer | association | follow_up`; returns raw remote
  records in whatever shape the remote system uses. Mapping onto casey's
  vocabulary is `external-schema-map.js`'s job, not the adapter's.
- `pushLocalUpdate(link, patch)` -- `link` is a confirmed `external_link`
  row, `patch` is remote-shaped fields to write back.

`src/sync/adapters/resolve.js` resolves `CASEY_EXTERNAL_SYNC_ADAPTER` (a
deployer-set env var, same discipline as `CASEY_EXTRA_DASHBOARD_ROUTES`):
unset resolves to `src/sync/adapters/none.js`, whose both methods throw
rather than silently no-op-succeeding, so a caller can tell "no adapter
configured" apart from "the adapter ran and found nothing new." Validated
eagerly at module load (top-level await) -- a misconfigured path or a module
missing the contract throws at boot, not on first use. With no adapter
configured, casey's boot is byte-identical to before this existed. No
hardcoded reference to any live third-party URL appears anywhere in this
seam.

## Manual import stopgap

Pending a real adapter, `casey sync-import <file> --kind <kind>` (see
`bin/casey-cli.mjs`) reads a manually-exported file (CSV/JSON) into the
normalized external-record shape the correlation engine expects, so
correlation can run against real exported data today with zero live
integration.

## Wiring a real adapter later

1. Confirm the other app's actual schema against a real API response --
   correct `EXTERNAL_SCHEMA`/`FIELD_CROSSWALK` in
   `src/sync/external-schema-map.js` to match reality, not the current
   guess.
2. Implement `src/sync/adapters/meat-naturally.js` against
   `src/sync/adapters/base.js`'s contract (`fetchRemoteRecords`,
   `pushLocalUpdate`), reading its own auth/endpoint env vars.
3. Set `CASEY_EXTERNAL_SYNC_ADAPTER=/absolute/path/to/meat-naturally.js`
   (or a relative path resolved the same way `resolve.js` does).
4. Run the correlation engine and manual-import path against real fetched
   records; review proposed links in the dashboard cross-link panel before
   confirming any.
