import { hasSyncConfig, syncConfig } from '../sync-config.js'

export const KINDS = Object.freeze(hasSyncConfig() ? [...syncConfig().SYNC_KINDS] : [])

export function assertIsAdapter(mod, label) {
  if (!mod || typeof mod.fetchRemoteRecords !== 'function' || typeof mod.pushLocalUpdate !== 'function') {
    throw new Error(`${label} does not implement the sync adapter contract (needs fetchRemoteRecords(kind, sinceIso) and pushLocalUpdate(link, patch))`)
  }
}
