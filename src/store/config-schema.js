// store/config-schema.js  --  pure structural validation of thatcher.config.yml
// and the enum vocabulary derived from it.
//
// Nothing here reads a file, boots thatcher, or touches a DB: every function
// takes the already-parsed config object and returns a value or throws a
// descriptive Error. That is what lets `casey doctor` run the SAME graph
// validation `CaseStore.init()` runs without creating ./data or a live store
// (CaseStore.validateConfig()), and it keeps the whole config vocabulary in one
// place instead of spread across the store's own lifecycle methods.

// Validate the config and return the parsed workflow stage graph
// ({ <stage>: { forward, backward, requires_role } }). Throws a descriptive
// error on any structural problem. `workflowName` is the workflow key to read
// out of cfg.workflows (CaseStore's opts.workflow, default 'case_lifecycle').
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
  // case.status enum should cover every workflow stage, else transitions write
  // values the column rejects.
  const statusOpts = cfg.entities.case.fields?.status?.options
  if (Array.isArray(statusOpts)) {
    for (const n of names) if (!statusOpts.includes(n)) throw new Error(`casey config: case.status enum is missing stage "${n}"`)
  }
  validateFieldDefs(cfg)
  validateRowAccessAndSort(cfg)
  return graph
}

// Broader structural validation over every declared entity.field beyond the
// workflow-stage-coverage check above: a field definition must be an object
// with a recognised `type`, an `enum` field must declare a non-empty
// `options` array, and the required system columns (id/created_at/
// created_by/updated_at, matching _system_fields in the config) must be
// present on every entity -- thatcher's write engine always writes these,
// so a missing one fails obscurely at first insert rather than at boot.
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

// row_access (when declared) must name a scope this codebase actually
// understands and a field that is a real column on the entity -- a typo
// here (e.g. "asignee") would silently no-op the worker enquiry scoping
// this exists to enforce, handing every worker every case. list.defaultSort
// (when declared) must be a non-empty array of {field, dir} pairs with dir
// in ASC/DESC and field a real column, else a sort silently falls back to
// whatever thatcher/sqlite happens to return.
export function validateRowAccessAndSort(cfg) {
  // 'none' explicitly disables row-access scoping for an entity (e.g.
  // operator_identity/operator_account below -- internal bookkeeping no
  // worker ever queries) and carries no `field`; every other known scope
  // keys on a real column.
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

// Read every entity.field { type: enum, options: [...] } declaration off the
// same parsed config, so a deployment that adds/renames a case_type or
// priority value in thatcher.config.yml is picked up by every consumer
// (case-tools.js validation guards, case_list/case_update tool-schema enums)
// with no code change and no second hardcoded copy of the list. Shape:
// { "<entity>.<field>": string[] }. Non-enum fields and entities with no
// fields are simply absent -- callers fall back to their own default.
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
