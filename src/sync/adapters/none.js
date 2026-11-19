import { caseyText } from '../../deployment-text.js';
const NOT_CONFIGURED = caseyText("src/sync/adapters/none.js#w0")

export function fetchRemoteRecords() {
  throw new Error(NOT_CONFIGURED)
}

export function pushLocalUpdate() {
  throw new Error(NOT_CONFIGURED)
}
