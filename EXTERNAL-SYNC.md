# External cross-app sync

Casey can cross-correlate its cases and contacts with records from a separate application. The seam is adapter-shaped and backed by a correlation/linking store, so a deployer can wire in a real integration without a redesign.

Casey ships no live integration. It has no external API client, no credentials and no endpoint for any particular external system. A deployment supplies those.

## The external schema is supplied by the deployer

The mapping from an external system's record fields onto casey's vocabulary comes from the deployer, as an `external-schema.cjs` file in `CASEY_CONFIG_DIR`, next to `thatcher.config.yml` and `report-fields.yml`. Casey itself has no vendor-specific schema. Treat any mapping as a hypothesis until it is checked against a real API response or export.

Casey applies the mapping through `mapExternalFieldsToReport` and `mapExternalFieldsToContact` in `src/sync/external-schema-map.js`. A mapping may target only an existing `report-fields.yml` REPORT_KEY or `contact.external_id`. Each external field should be classified once: either mapped, or listed as deliberately not imported with a reason, so that the two lists cover the whole schema.

## Additive-only guarantee

Casey's own `case`, `contact` and `event` entities are never extended for this. The whole cross-app surface lives in one entity, `external_link`, declared in the deployer's `thatcher.config.yml`:

- `system` (enum; each integration adds its own option value, never a second entity)
- `local_entity` (`case` | `contact`) and `local_id`: the casey-side row
- `external_entity` (free text, because the remote schema is not fixed)
- `external_id`, `external_ref` (a display-safe label, never a raw phone number)
- `match_basis`, `confidence` (0.0-1.0)
- `status` (`proposed` | `confirmed` | `rejected`, default `proposed`)
- `notes`

`row_access: { scope: none }`: an internal linking table, not a worker-scoped resource, same shape as `operator_identity`.

A value from the other system lands only in an existing `report-fields.yml` REPORT_KEY or `contact.external_id`, through `mapExternalFieldsToReport` or `mapExternalFieldsToContact`, and only on a `confirmed` link, never a `proposed` one. `applyConfirmedLink` in `src/sync/apply-link.js` rejects any other status.

## Adapter contract

`src/sync/adapters/base.js` defines the contract: a module exporting

- `fetchRemoteRecords(kind, sinceIso)`: `kind` is one of the record kinds the external schema declares. Returns raw remote records in whatever shape the remote system uses. Mapping onto casey's vocabulary belongs to the external schema map, not the adapter.
- `pushLocalUpdate(link, patch)`: `link` is a confirmed `external_link` row, `patch` is remote-shaped fields to write back.

`src/sync/adapters/resolve.js` resolves `CASEY_EXTERNAL_SYNC_ADAPTER`, a deployer-set environment variable holding the path to the adapter module. Unset, it resolves to `src/sync/adapters/none.js`, whose two methods throw rather than succeed silently, so a caller can tell "no adapter configured" from "the adapter ran and found nothing new." The module is validated at load time: a bad path or a module missing the contract throws at boot, not on first use.

## Manual import

Until an adapter exists, `casey sync-import <file> --kind <kind>` reads a manually exported CSV or JSON file into the normalized external-record shape the correlation engine expects. Kinds are the ones the external schema declares. Correlation can then run against real exported data with no live integration.

## Querying and provisioning: the /api/sync/* surface

`src/dashboard/routes/sync-api.js` exposes a machine-authenticated API, so an external system (or a script standing in for one) can reach this seam over HTTP as well as through `CASEY_EXTERNAL_SYNC_ADAPTER` and `casey sync-import`.

This is a bounded exception to the dashboard's "no bearer token" rule, scoped to this one path prefix. The session-cookie gate in `src/dashboard/routes/auth.js` exempts `/api/sync/*` because that prefix runs a different gate: a bearer `Authorization` header checked against `sync_api_key` rows, using the same scrypt hash and `timingSafeEqual` comparison as operator passwords. Every other dashboard route still refuses bearer tokens. See `AGENTS.md`'s Security invariants section.

### Provisioning a key

```
casey sync-apikey create --label <name> --scope read:cases,read:links,write:links,import:records
casey sync-apikey list
casey sync-apikey revoke <id>
```

`create` prints the raw key to stdout once. It is scrypt-hashed before storage and is never retrievable again. `list` shows only the label, a display-safe prefix, scopes, status and last-used time.

### Scopes and endpoints

| Method | Path                       | Scope            | Does                                                                 |
|--------|----------------------------|------------------|-----------------------------------------------------------------------|
| GET    | `/api/sync/cases`          | `read:cases`     | Paginated, PII-safe case list (same projection as the dashboard).     |
| GET    | `/api/sync/external-links` | `read:links`     | Proposed/confirmed/rejected links, PII-safe (`?status=` filter).      |
| POST   | `/api/sync/external-links` | `write:links`    | Propose a link from the caller's own correlation guess. Always lands `status=proposed`; a machine caller cannot confirm one. |
| POST   | `/api/sync/import`         | `import:records` | Push a batch of normalized external records for the next correlation pass (same shape and storage as the manual-import CLI). |

An unrecognized or revoked key gets 401. A valid key missing the route's scope gets 403. Requests are rate-limited per key (`CASEY_SYNC_API_RATE_LIMIT`, default 120, over a `CASEY_SYNC_API_RATE_WINDOW_MS` window, default 60000 ms).

## Wiring a real adapter

1. Confirm the external system's actual schema against a real API response, and correct the deployer's `external-schema.cjs` to match it.
2. Implement the adapter against `src/sync/adapters/base.js`'s contract (`fetchRemoteRecords`, `pushLocalUpdate`), reading its own auth and endpoint environment variables.
3. Set `CASEY_EXTERNAL_SYNC_ADAPTER` to the adapter's absolute path, or a relative path resolved as `resolve.js` does.
4. Run the correlation engine and the manual-import path against real fetched records. Review proposed links in the dashboard cross-link panel before confirming any.
