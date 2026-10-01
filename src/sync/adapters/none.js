const NOT_CONFIGURED = 'no CASEY_EXTERNAL_SYNC_ADAPTER configured -- set it to a module path implementing src/sync/adapters/base.js\'s contract before calling this'

export function fetchRemoteRecords() {
  throw new Error(NOT_CONFIGURED)
}

export function pushLocalUpdate() {
  throw new Error(NOT_CONFIGURED)
}
