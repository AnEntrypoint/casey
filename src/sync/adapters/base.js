// The cross-system sync adapter contract. An adapter is any module exporting
// both functions below with these exact names and arities -- there is no
// base class to extend, matching this codebase's plain-module convention
// (see CASEY_EXTRA_DASHBOARD_ROUTES's `(app, {store}) => void` shape). This
// file exists so a real adapter and resolve.js's validation both point at
// one written contract instead of each guessing the other's shape.
//
// fetchRemoteRecords(kind, sinceIso) -- kind is one of the strings in KINDS
// below; sinceIso is an ISO timestamp string (or null for "everything").
// Returns an array of RAW external records, in whatever shape the remote
// system itself uses -- mapping that raw shape onto casey's own field
// vocabulary is external-schema-map.js's job, not the adapter's.
//
// pushLocalUpdate(link, patch) -- link is a confirmed external_link row
// (see config/thatcher.config.yml's external_link entity); patch is a plain
// object of remote-shaped fields to write back. A read-only adapter throws
// rather than silently no-op-succeeding, so a caller can tell "pushed" from
// "there was nothing to push."
export const KINDS = Object.freeze(['field_visit', 'farmer', 'association', 'follow_up'])

export function assertIsAdapter(mod, label) {
  if (!mod || typeof mod.fetchRemoteRecords !== 'function' || typeof mod.pushLocalUpdate !== 'function') {
    throw new Error(`${label} does not implement the sync adapter contract (needs fetchRemoteRecords(kind, sinceIso) and pushLocalUpdate(link, patch))`)
  }
}
