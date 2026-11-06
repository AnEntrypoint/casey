
export function validateCaseConfig(cfg, workflowName) {
  if (!cfg || typeof cfg !== 'object') throw new Error('casey config is empty or not an object')
  for (const ent of ['case', 'event', 'contact']) {
    if (!cfg.entities?.[ent]) throw new Error(`casey config: missing required entity "${ent}"`)
  }
  const wfDef = cfg.workflows?.[workflowName]
  if (!wfDef) throw new Error(`casey config: missing workflow "${workflowName}"`)
  const stages = wfDef.stages || []
  if (!stages.length) throw new Error(`casey config: workflow "${workflowName}" has no stages`)
  const names = new Set(stages.map(s => s.name))
  const graph = {}
  for (const s of stages) {
    if (!s.name) throw new Error('casey config: a workflow stage has no name')
    for (const t of [...(s.forward || []), ...(s.backward || [])]) {
      if (!names.has(t)) throw new Error(`casey config: stage "${s.name}" references unknown target "${t}"`)
    }
    graph[s.name] = { forward: s.forward || [], backward: s.backward || [], requires_role: s.requires_role || [] }
  }
  const statusOpts = cfg.entities.case.fields?.status?.options
  if (Array.isArray(statusOpts)) {
    for (const n of names) if (!statusOpts.includes(n)) throw new Error(`casey config: case.status enum is missing stage "${n}"`)
  }
  validateFieldDefs(cfg)
  validateRowAccessAndSort(cfg)
  return graph
}

export function validateFieldDefs(cfg) {
  const KNOWN_TYPES = new Set(['id', 'text', 'textarea', 'number', 'enum', 'timestamp', 'boolean', 'json'])
  const REQUIRED_SYSTEM_FIELDS = ['id', 'created_at', 'created_by', 'updated_at']
  for (const [entName, ent] of Object.entries(cfg.entities || {})) {
    const fields = ent?.fields
    if (!fields || typeof fields !== 'object') {
      throw new Error(`casey config: entity "${entName}" has no fields object`)
    }
    for (const sys of REQUIRED_SYSTEM_FIELDS) {
      if (!fields[sys]) throw new Error(`casey config: entity "${entName}" is missing required system field "${sys}"`)
    }
    for (const [fieldName, def] of Object.entries(fields)) {
      if (!def || typeof def !== 'object') {
        throw new Error(`casey config: entity "${entName}" field "${fieldName}" has no definition object`)
      }
      if (!def.type) {
        throw new Error(`casey config: entity "${entName}" field "${fieldName}" has no "type"`)
      }
      if (!KNOWN_TYPES.has(def.type)) {
        throw new Error(`casey config: entity "${entName}" field "${fieldName}" has unrecognised type "${def.type}"`)
      }
      if (def.type === 'enum' && (!Array.isArray(def.options) || !def.options.length)) {
        throw new Error(`casey config: entity "${entName}" field "${fieldName}" is type enum but has no non-empty "options" array`)
      }
    }
  }
}

export function validateRowAccessAndSort(cfg) {
  const KNOWN_ROW_ACCESS_SCOPES = new Set(['assigned', 'owner', 'none'])
  for (const [entName, ent] of Object.entries(cfg.entities || {})) {
    const fieldNames = new Set(Object.keys(ent?.fields || {}))
    if (ent?.row_access) {
      const { scope, field } = ent.row_access
      if (!KNOWN_ROW_ACCESS_SCOPES.has(scope)) {
        throw new Error(`casey config: entity "${entName}" row_access.scope "${scope}" is not recognised (expected one of: ${[...KNOWN_ROW_ACCESS_SCOPES].join(', ')})`)
      }
      if (scope !== 'none' && (!field || !fieldNames.has(field))) {
        throw new Error(`casey config: entity "${entName}" row_access.field "${field}" is not a declared field on this entity`)
      }
    }
    const sort = ent?.list?.defaultSort
    if (sort != null) {
      if (!Array.isArray(sort) || !sort.length) {
        throw new Error(`casey config: entity "${entName}" list.defaultSort must be a non-empty array`)
      }
      for (const s of sort) {
        if (!s || !fieldNames.has(s.field)) {
          throw new Error(`casey config: entity "${entName}" list.defaultSort references unknown field "${s?.field}"`)
        }
        if (s.dir && !['ASC', 'DESC'].includes(s.dir)) {
          throw new Error(`casey config: entity "${entName}" list.defaultSort field "${s.field}" has invalid dir "${s.dir}" (expected ASC or DESC)`)
        }
      }
    }
  }
}

export function parseFieldEnums(cfg) {
  const out = {}
  for (const [entName, ent] of Object.entries(cfg?.entities || {})) {
    for (const [fieldName, def] of Object.entries(ent?.fields || {})) {
      if (def && def.type === 'enum' && Array.isArray(def.options)) {
        out[`${entName}.${fieldName}`] = [...def.options]
      }
    }
  }
  return out
}
