// core/pack-schema.js -- the config-pack meta-schema: validates that a pack
// (declarative data only, no executable content) is well-formed before the
// engine ever loads it.
//
// A pack is a set of declarative documents:
//   subjectTypes, observationForms, codelists, rules, roles, views, strings
// Everything else -- capture, sync, provenance, audit, aggregation,
// escalation, verification -- is identical for every operation, engine-owned,
// and NOT configurable via a pack.
//
// This module owns validation only. It never executes anything a pack
// contains: a rule is data (condition/severity/route/SLA), evaluated later by
// engine/rule-engine.js's bounded interpreter -- never eval'd, never a
// function, never a string of code.

const KNOWN_FIELD_TYPES = new Set(['text', 'number', 'enum', 'boolean', 'date', 'geo', 'photo', 'audio', 'repeat'])
const KNOWN_RULE_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'and', 'or'])
const KNOWN_ROW_ACCESS = new Set(['assigned', 'owner', 'none'])

function fail(errors, msg) { errors.push(msg) }

// Validates subjectTypes: a flat or shallow-nested entity tree with labels.
// Rejects a cycle (item: circular subject-type reference).
function validateSubjectTypes(pack, errors) {
  const types = pack.subjectTypes
  if (!types || typeof types !== 'object' || !Object.keys(types).length) {
    fail(errors, 'subjectTypes: required, must be a non-empty object of {id: {label, parent?}}')
    return
  }
  for (const [id, def] of Object.entries(types)) {
    if (!def || typeof def !== 'object') { fail(errors, `subjectTypes.${id}: definition must be an object`); continue }
    if (!def.label || typeof def.label !== 'string') fail(errors, `subjectTypes.${id}: missing string "label"`)
    if (def.parent != null && !types[def.parent]) fail(errors, `subjectTypes.${id}: parent "${def.parent}" is not a declared subject type`)
  }
  // Cycle detection over the parent graph.
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = Object.fromEntries(Object.keys(types).map(k => [k, WHITE]))
  function visit(id, chain) {
    if (color[id] === BLACK) return
    if (color[id] === GRAY) { fail(errors, `subjectTypes: circular parent reference: ${[...chain, id].join(' -> ')}`); return }
    color[id] = GRAY
    const parent = types[id]?.parent
    if (parent && types[parent]) visit(parent, [...chain, id])
    color[id] = BLACK
  }
  for (const id of Object.keys(types)) visit(id, [])
}

// Validates observationForms: field defs incl. per-field unknown-allowed +
// provenance rules -- the honesty floor's config surface. A pack may make a
// field required, but "required" here can only ever mean "answer or mark
// unknown" -- there is no way for a pack to express "unknown not allowed",
// because that key literally does not exist in this schema (item 18).
function validateObservationForms(pack, errors) {
  const forms = pack.observationForms
  if (!forms || typeof forms !== 'object' || !Object.keys(forms).length) {
    fail(errors, 'observationForms: required, must be a non-empty object of {formId: {subjectType, fields}}')
    return
  }
  for (const [formId, form] of Object.entries(forms)) {
    if (!form || typeof form !== 'object') { fail(errors, `observationForms.${formId}: must be an object`); continue }
    if (!form.subjectType || !pack.subjectTypes?.[form.subjectType]) {
      fail(errors, `observationForms.${formId}: subjectType "${form.subjectType}" is not a declared subject type`)
    }
    const fields = form.fields
    if (!fields || typeof fields !== 'object' || !Object.keys(fields).length) {
      fail(errors, `observationForms.${formId}: fields must be a non-empty object`); continue
    }
    for (const [fieldKey, field] of Object.entries(fields)) {
      if (!field || typeof field !== 'object') { fail(errors, `observationForms.${formId}.${fieldKey}: must be an object`); continue }
      if (!KNOWN_FIELD_TYPES.has(field.type)) {
        fail(errors, `observationForms.${formId}.${fieldKey}: unrecognised type "${field.type}" (expected one of: ${[...KNOWN_FIELD_TYPES].join(', ')})`)
      }
      // An enum field draws its options either inline (a plain "options"
      // array) or by reference to a shared codelist ("codelist" naming a key
      // in pack.codelists) -- exactly one source is required, never neither.
      if (field.type === 'enum') {
        const hasInlineOptions = Array.isArray(field.options) && field.options.length > 0
        const codelistRef = field.codelist
        if (!hasInlineOptions && !codelistRef) {
          fail(errors, `observationForms.${formId}.${fieldKey}: type enum requires either a non-empty "options" array or a "codelist" reference`)
        }
        if (codelistRef && !pack.codelists?.[codelistRef]) {
          fail(errors, `observationForms.${formId}.${fieldKey}: codelist "${codelistRef}" is not declared`)
        }
      }
      if (field.evidenceRequired != null && typeof field.evidenceRequired !== 'boolean') {
        fail(errors, `observationForms.${formId}.${fieldKey}: evidenceRequired must be boolean`)
      }
      // The honesty floor: unknownAllowed defaults true and CANNOT be set
      // false by a pack -- there is no branch here that reads a false value
      // and honors it. A pack author who writes unknownAllowed:false gets a
      // loud validation error, not silent enforcement of the wrong thing.
      if (field.unknownAllowed === false) {
        fail(errors, `observationForms.${formId}.${fieldKey}: unknownAllowed cannot be set to false -- "unknown" is always reachable on every field, per the honesty floor (item 18); remove this key`)
      }
    }
  }
}

function validateCodelists(pack, errors) {
  if (pack.codelists == null) return   // optional
  if (typeof pack.codelists !== 'object') { fail(errors, 'codelists: must be an object when present'); return }
  for (const [name, list] of Object.entries(pack.codelists)) {
    if (!Array.isArray(list) || !list.length) { fail(errors, `codelists.${name}: must be a non-empty array`); continue }
    const keys = new Set()
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || !entry.key) { fail(errors, `codelists.${name}: every entry needs a "key"`); continue }
      if (keys.has(entry.key)) fail(errors, `codelists.${name}: duplicate key "${entry.key}"`)
      keys.add(entry.key)
    }
  }
}

// Bounded rule vocabulary: comparisons/sets/counts/thresholds only. No
// loops, no arbitrary expressions -- a rule condition is a tree of
// {op, field, value} / {op:'and'|'or', clauses:[...]} nodes, each op drawn
// from KNOWN_RULE_OPS. Anything else (a function, a string of code, an
// unrecognised op) fails validation, never silently passes through to be
// eval'd later.
function validateRuleCondition(cond, path, errors, declaredFields) {
  if (typeof cond === 'function') { fail(errors, `${path}: a rule condition may never be a function -- declarative data only`); return }
  if (!cond || typeof cond !== 'object') { fail(errors, `${path}: condition must be an object`); return }
  if (!KNOWN_RULE_OPS.has(cond.op)) { fail(errors, `${path}: unrecognised op "${cond.op}" (expected one of: ${[...KNOWN_RULE_OPS].join(', ')})`); return }
  if (cond.op === 'and' || cond.op === 'or') {
    if (!Array.isArray(cond.clauses) || !cond.clauses.length) { fail(errors, `${path}: ${cond.op} requires a non-empty "clauses" array`); return }
    cond.clauses.forEach((c, i) => validateRuleCondition(c, `${path}.clauses[${i}]`, errors, declaredFields))
    return
  }
  if (!cond.field || (declaredFields && !declaredFields.has(cond.field))) {
    fail(errors, `${path}: field "${cond.field}" is not a declared observation form field`)
  }
}

function collectAllFormFields(pack) {
  const s = new Set()
  for (const form of Object.values(pack.observationForms || {})) {
    for (const key of Object.keys(form.fields || {})) s.add(key)
  }
  return s
}

function validateRules(pack, errors) {
  if (pack.rules == null) return   // optional
  if (!Array.isArray(pack.rules)) { fail(errors, 'rules: must be an array when present'); return }
  const declaredFields = collectAllFormFields(pack)
  pack.rules.forEach((rule, i) => {
    if (!rule || typeof rule !== 'object') { fail(errors, `rules[${i}]: must be an object`); return }
    if (!rule.id) fail(errors, `rules[${i}]: missing "id"`)
    if (!rule.condition) { fail(errors, `rules[${i}]: missing "condition"`); return }
    validateRuleCondition(rule.condition, `rules[${i}].condition`, errors, declaredFields)
    if (!rule.severity) fail(errors, `rules[${i}]: missing "severity"`)
    if (!rule.route) fail(errors, `rules[${i}]: missing "route"`)
  })
}

function validateRoles(pack, errors) {
  if (pack.roles == null) return   // optional -- engine has a fixed default set
  if (typeof pack.roles !== 'object') { fail(errors, 'roles: must be an object when present'); return }
  for (const [roleId, def] of Object.entries(pack.roles)) {
    if (!def || typeof def !== 'object') { fail(errors, `roles.${roleId}: must be an object`); continue }
    if (def.rowAccess && !KNOWN_ROW_ACCESS.has(def.rowAccess)) {
      fail(errors, `roles.${roleId}: rowAccess "${def.rowAccess}" not recognised (expected one of: ${[...KNOWN_ROW_ACCESS].join(', ')})`)
    }
  }
}

function validateViews(pack, errors) {
  if (pack.views == null) return   // optional
  if (typeof pack.views !== 'object') { fail(errors, 'views: must be an object when present'); return }
  const KNOWN_VIEW_TYPES = new Set(['map', 'timeseries', 'table', 'drilldown'])
  for (const [viewId, def] of Object.entries(pack.views)) {
    if (!def || typeof def !== 'object') { fail(errors, `views.${viewId}: must be an object`); continue }
    if (!KNOWN_VIEW_TYPES.has(def.type)) fail(errors, `views.${viewId}: unrecognised type "${def.type}" (expected one of: ${[...KNOWN_VIEW_TYPES].join(', ')})`)
  }
}

function validateStrings(pack, errors) {
  if (pack.strings == null) { fail(errors, 'strings: required -- every label must be pack-declared, no English hardcoded in the engine'); return }
  if (typeof pack.strings !== 'object') { fail(errors, 'strings: must be an object of {locale: {key: text}}') }
}

export function validatePack(pack) {
  const errors = []
  if (!pack || typeof pack !== 'object') return { valid: false, errors: ['pack must be an object'] }
  if (!pack.id) fail(errors, 'id: required (pack identifier)')
  if (!pack.version) fail(errors, 'version: required (semver-shaped string)')
  validateSubjectTypes(pack, errors)
  validateObservationForms(pack, errors)
  validateCodelists(pack, errors)
  validateRules(pack, errors)
  validateRoles(pack, errors)
  validateViews(pack, errors)
  validateStrings(pack, errors)
  return { valid: errors.length === 0, errors }
}

// Loud, not silent: throws with every collected error joined, so a malformed
// pack fails at load with a full diagnostic instead of a single confusing
// downstream crash.
export function loadPack(packData) {
  const { valid, errors } = validatePack(packData)
  if (!valid) {
    throw new Error(`pack "${packData?.id || '(unknown)'}" failed validation:\n  - ${errors.join('\n  - ')}`)
  }
  return Object.freeze(packData)
}
