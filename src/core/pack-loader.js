// core/pack-loader.js -- versioned pack loading + declarative migration.
//
// Every Observation is stamped with the exact packId+packVersion that
// captured it (core/observation.js). A pack's form definition changes over
// time (a field renamed, removed, a new one added); this module resolves an
// OLD observation's fields against the CURRENT pack via a declarative
// migration map -- field renames/mappings expressed as data, unmapped
// fields preserved rather than dropped (never silently lost).

import { loadPack } from './pack-schema.js'

export class PackRegistry {
  constructor() {
    this._versions = new Map()   // packId -> Map(version -> pack)
    this._migrations = new Map() // packId -> [{ from, to, fieldMap }]
  }

  register(packData) {
    const pack = loadPack(packData)
    if (!this._versions.has(pack.id)) this._versions.set(pack.id, new Map())
    this._versions.get(pack.id).set(pack.version, pack)
    return pack
  }

  get(packId, version) {
    const versions = this._versions.get(packId)
    if (!versions) throw new Error(`pack-loader: no pack registered with id "${packId}"`)
    const pack = versions.get(version)
    if (!pack) throw new Error(`pack-loader: pack "${packId}" has no registered version "${version}"`)
    return pack
  }

  latest(packId) {
    const versions = this._versions.get(packId)
    if (!versions || !versions.size) throw new Error(`pack-loader: no pack registered with id "${packId}"`)
    // Simple lexicographic-on-parts semver compare -- packs are expected to
    // use plain semver; a pack registering a non-semver version string still
    // works for get(), just not for latest()'s ordering.
    const versionsSorted = [...versions.keys()].sort((a, b) => {
      const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0)
        if (diff) return diff
      }
      return 0
    })
    return versions.get(versionsSorted[versionsSorted.length - 1])
  }

  // Declarative migration: { from: '1.0.0', to: '1.1.0', fieldMap: { old_key: 'new_key' } }.
  // fieldMap only ever RENAMES -- there is no delete-a-field operation here,
  // because an unmapped field must be preserved, never dropped.
  registerMigration(packId, migration) {
    if (!migration.from || !migration.to || !migration.fieldMap) {
      throw new Error('pack-loader: migration requires from/to/fieldMap')
    }
    if (!this._migrations.has(packId)) this._migrations.set(packId, [])
    this._migrations.get(packId).push(migration)
  }

  // Resolve an old-version observation's findings keys against the CURRENT
  // (latest) pack's field names, applying every migration step in order.
  // Any field with no mapping entry passes through UNCHANGED (preserved,
  // never dropped) -- satisfying config-pack-migration/expansion-pack-
  // version-mismatch-read.
  migrateFindings(packId, fromVersion, findings) {
    const migrations = (this._migrations.get(packId) || [])
      .filter(m => m.from === fromVersion || this._chainReaches(packId, m.from, fromVersion))
    let current = { ...findings }
    // Apply in from-version order; a real multi-hop chain (1.0.0 -> 1.1.0 ->
    // 1.2.0) would need topological ordering, but the common case (a single
    // hop from the stamped version to latest) is what this resolves; a pack
    // author introducing a longer chain registers each hop and this applies
    // whichever step matches the observation's OWN fromVersion, once.
    for (const m of migrations) {
      if (m.from !== fromVersion) continue
      const next = {}
      for (const [key, val] of Object.entries(current)) {
        const mappedKey = m.fieldMap[key] || key   // unmapped -> preserved as-is
        next[mappedKey] = val
      }
      current = next
    }
    return current
  }

  _chainReaches() { return false }   // single-hop only for now; documented above
}
