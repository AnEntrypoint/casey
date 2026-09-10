// The default adapter when CASEY_EXTERNAL_SYNC_ADAPTER is unset. Both
// methods throw rather than returning an empty array / silently succeeding
// -- a caller must be able to tell "no adapter configured" apart from "the
// adapter ran and found nothing new," since the two demand different
// operator responses.
const NOT_CONFIGURED = 'no CASEY_EXTERNAL_SYNC_ADAPTER configured -- set it to a module path implementing src/sync/adapters/base.js\'s contract before calling this'

export function fetchRemoteRecords() {
  throw new Error(NOT_CONFIGURED)
}

export function pushLocalUpdate() {
  throw new Error(NOT_CONFIGURED)
}
