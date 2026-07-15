// location-normalize.js -- one shared normalization rule for a free-text place
// name, so case_list's location match and the derived normalized_location
// field (see thatcher.config.yml, case-store.js DERIVED_ONLY_FIELDS) can never
// diverge into two different ideas of "the same place". Deliberately narrow:
// lowercase, trim, collapse internal whitespace, and strip common punctuation
// noise (commas, periods, multiple spaces/hyphens) -- NOT a gazetteer or
// alias table (AGENTS.md's no-lookup-table design principle stays intact;
// this only normalizes the surface form of what the agent already wrote).
export function normalizeLocation(raw) {
  if (raw == null) return ''
  return String(raw)
    .toLowerCase()
    .trim()
    .replace(/[.,;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .trim()
}
