import { loadDomainConfig } from '../config-loader.js'

const REQUIRED = ['EXTERNAL_SCHEMA', 'FIELD_CROSSWALK', 'NO_CASEY_COUNTERPART', 'SYNC_KINDS', 'SYNC_SYSTEM', 'SYNC_IMPORT_ALIASES', 'SYNC_CORRELATION_COLUMNS', 'SYNC_LINK_FIELD_MAP']

export function hasSyncConfig() {
  return Boolean(loadDomainConfig().externalSchema)
}

export function syncConfig() {
  const cfg = loadDomainConfig().externalSchema
  if (!cfg) throw new Error('external-schema.cjs not found in CASEY_CONFIG_DIR')
  for (const k of REQUIRED) if (cfg[k] == null) throw new Error(`external-schema.cjs must export ${k}`)
  return cfg
}
