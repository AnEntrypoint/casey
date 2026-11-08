# External cross-app sync (speculative prep)

Prep for cross-correlating casey/uhh's cases and contacts with a separate,
in-development app: MEAT NATURALLY - AHT Field Tracker (a livestock-production
field-visit tracker for Animal Health Technicians in EC/KZN/FS South Africa).
There is no live integration today -- no confirmed API, no credentials, no
running endpoint. Everything here is an adapter-shaped seam plus a
correlation/linking store, so a real integration can be wired in later
without a redesign.

## The other app's schema is unconfirmed

`src/sync/external-schema-map.js`'s `EXTERNAL_SCHEMA` is reconstructed from a
live demo walkthrough of the other app plus screenshots, terminal sessions,
and meeting discussion the user supplied -- not a real API contract. The field
NAMES there are this side's normalization of what the demo showed, not the
remote system's wire names, so treat every name and type as a hypothesis. It
covers nine record kinds: `aht_user`, `association`, `farmer`, `field_visit`,
`vehicle_trip_log`, `daily_accountability`, `document_vault`, `follow_up`,
`targets_analytics`.

Every field of every kind is classified exactly once, and the two lists are
exhaustive over `EXTERNAL_SCHEMA` by construction:

- `FIELD_CROSSWALK` maps only the fields that plausibly correlate with casey's
  own vocabulary, and only onto an existing `report-fields.yml` REPORT_KEY or
  `contact.external_id`. The mapped set is: the technician (`aht_name`/
  `aht_id` -> `present_person`), place names (`association.name`,
  `field_visit.association_name`, `follow_up.assigned_association`, and
  `association.province` as a coarse last-resort fallback -> `location`), the
  farmer's identity (`first_name`/`last_name` -> `owner_name`,
  `phone_number` -> `owner_contact` and `contact.external_id`), the visit's
  prose (`purpose_of_visit`, `activities_conducted`, `outcome_notes`,
  `challenges_encountered`, `proposed_solutions`, `follow_up.issue_summary`,
  `follow_up.resolution_notes` -> `notes`), the attachment
  (`field_visit.photo_url` -> `photos`), and `visit_date` -> `onset` as a weak
  temporal signal only, never a direct overwrite.
- `NO_CASEY_COUNTERPART` lists what is deliberately never imported, each row
  carrying its own one-line reason: the vehicle/trip logbook and per-technician
  monthly kilometres (logistics and expense, no animal-health meaning); the
  whole daily-accountability surface (visits/admin days logged, Submitted /
  Missing / On Leave / Sick, compliance percent -- management performance about
  their staff, not a fact about a case); the whole document vault (operational
  templates, training material, meeting registers, herd-health and production
  plans, plus uploader/timestamp/size metadata -- an office artefact is not a
  field photo of an affected animal, so it is explicitly NOT routed to
  `report.photos`); targets, totals, coverage counts and leaderboard metrics
  (derived analytics, and casey computes its own from its own event log, so
  importing theirs would double-count); the organizational hierarchy above a
  place name (`district_municipality`, `project_phase`, `target_scope`,
  technician allocation mapping); their user role/active flags (the casey-side
  contact tier is operator-assigned and fails closed); their workflow and SLA
  fields (`follow_up_required`, `follow_up.status`, the target-resolution date
  range -- the casey-side lifecycle machine and `attn.js` SLA clock are never
  driven from outside); their own record ids and FKs (`batch_visit_id`,
  `follow_up_id`, `linked_visit_id`, `field_visit_id` -- correlation metadata
  belonging in `external_link`, never in a report field); meeting attendance
  head counts (`male_attendees`/`female_attendees` -- people at a meeting, and
  putting them in `affected_count`/`herd_total` would feed human attendance
  into an animal-count field that drives the attention ranking); and the
  farmer's production census (`cattle_count`/`sheep_count`/`goat_count` -- a
  census of a whole holding is not `herd_total` at the visited location, and
  deriving `species` from a nonzero count is exactly the guess
  `report-fields.yml` forbids).

`external_link.external_entity` stays free text rather than becoming an enum
over these nine kinds: the remote schema is still unconfirmed, so an enum here
would only harden a guess.

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

## Querying and provisioning: the /api/sync/* surface

`src/dashboard/routes/sync-api.js` exposes a machine-authenticated API so an
external system (or a script standing in for one, until a real adapter
exists) can reach this seam directly over HTTP, not only through
`CASEY_EXTERNAL_SYNC_ADAPTER`/`casey sync-import`.

**This is a bounded exception to the dashboard's "no bearer token" invariant,
scoped to this one path prefix.** `routes/auth.js`'s `authGate()` (the
session-cookie gate every other dashboard route sits behind) explicitly
exempts `/api/sync/*` -- not because it is unauthenticated, but because it
runs a *different* gate: a bearer `Authorization` header checked against
`sync_api_key` rows the same way an operator's password is checked (scrypt
hash, `timingSafeEqual`, never a plain compare). Every other dashboard route
remains exactly as bearer-token-refusing as before; see `AGENTS.md`'s
Security invariants section for the full statement.

### Provisioning a key

```
casey sync-apikey create --label meat-naturally-prod --scope read:cases,read:links,write:links,import:records
casey sync-apikey list
casey sync-apikey revoke <id>
```

`create` prints the raw key to stdout exactly once -- it is scrypt-hashed
before being stored and is never retrievable again. `list` shows only the
label, a display-safe prefix, scopes, status and last-used time, never the
key or its hash.

### Scopes and endpoints

| Method | Path                       | Scope            | Does                                                                 |
|--------|----------------------------|------------------|-----------------------------------------------------------------------|
| GET    | `/api/sync/cases`          | `read:cases`     | Paginated, PII-safe case list (same projection as the dashboard).     |
| GET    | `/api/sync/external-links` | `read:links`     | Proposed/confirmed/rejected links, PII-safe (`?status=` filter).      |
| POST   | `/api/sync/external-links` | `write:links`    | Propose a link from the caller's own correlation guess -- always lands `status=proposed`; a machine caller can never confirm one. |
| POST   | `/api/sync/import`         | `import:records` | Push a batch of normalized external records for the next correlation pass to consume (same shape/storage as the manual-import CLI). |

An unrecognized or revoked key gets 401; a valid key missing the route's
scope gets 403. Requests are rate-limited per key
(`CASEY_SYNC_API_RATE_LIMIT`, default 120/`CASEY_SYNC_API_RATE_WINDOW_MS`,
default 60000ms).

## Wiring a real adapter later

1. Confirm the other app's actual schema against a real API response --
   correct `EXTERNAL_SCHEMA`/`FIELD_CROSSWALK`/`NO_CASEY_COUNTERPART` in
   `src/sync/external-schema-map.js` to match reality, not the current
   guess. Their side's own dashboard/database integration item is not built
   yet either, so the real next step is an API contract exchange, not a
   further round of refining this hypothesis from demo screenshots.
2. Implement `src/sync/adapters/meat-naturally.js` against
   `src/sync/adapters/base.js`'s contract (`fetchRemoteRecords`,
   `pushLocalUpdate`), reading its own auth/endpoint env vars.
3. Set `CASEY_EXTERNAL_SYNC_ADAPTER=/absolute/path/to/meat-naturally.js`
   (or a relative path resolved the same way `resolve.js` does).
4. Run the correlation engine and manual-import path against real fetched
   records; review proposed links in the dashboard cross-link panel before
   confirming any.
