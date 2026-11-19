import { caseyText } from '../deployment-text.js';

const KNOWN_FIELD_TYPES = new Set(['text', 'number', 'enum', 'boolean', 'date', 'geo', 'photo', 'audio', 'repeat'])
const KNOWN_RULE_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'and', 'or'])
const KNOWN_ROW_ACCESS = new Set(['assigned', 'owner', 'none'])

function fail(errors, msg) { errors.push(msg) }

function validateSubjectTypes(pack, errors) {
  const types = pack.subjectTypes
  if (!types || typeof types !== 'object' || !Object.keys(types).length) {
    fail(errors, caseyText("src/core/pack-schema.js#w0"))
    return
  }
  for (const [id, def] of Object.entries(types)) {
    if (!def || typeof def !== 'object') { fail(errors, caseyText("src/core/pack-schema.js#w1", [id])); continue }
    if (!def.label || typeof def.label !== 'string') fail(errors, caseyText("src/core/pack-schema.js#w2", [id]))
    if (def.parent != null && !types[def.parent]) fail(errors, caseyText("src/core/pack-schema.js#w3", [id, def.parent]))
  }
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = Object.fromEntries(Object.keys(types).map(k => [k, WHITE]))
  function visit(id, chain) {
    if (color[id] === BLACK) return
    if (color[id] === GRAY) { fail(errors, caseyText("src/core/pack-schema.js#w4", [[...chain, id].join(' -> ')])); return }
    color[id] = GRAY
    const parent = types[id]?.parent
    if (parent && types[parent]) visit(parent, [...chain, id])
    color[id] = BLACK
  }
  for (const id of Object.keys(types)) visit(id, [])
}

function validateObservationForms(pack, errors) {
  const forms = pack.observationForms
  if (!forms || typeof forms !== 'object' || !Object.keys(forms).length) {
    fail(errors, caseyText("src/core/pack-schema.js#w5"))
    return
  }
  for (const [formId, form] of Object.entries(forms)) {
    if (!form || typeof form !== 'object') { fail(errors, caseyText("src/core/pack-schema.js#w6", [formId])); continue }
    if (!form.subjectType || !pack.subjectTypes?.[form.subjectType]) {
      fail(errors, caseyText("src/core/pack-schema.js#w7", [formId, form.subjectType]))
    }
    const fields = form.fields
    if (!fields || typeof fields !== 'object' || !Object.keys(fields).length) {
      fail(errors, caseyText("src/core/pack-schema.js#w8", [formId])); continue
    }
    for (const [fieldKey, field] of Object.entries(fields)) {
      if (!field || typeof field !== 'object') { fail(errors, caseyText("src/core/pack-schema.js#w9", [formId, fieldKey])); continue }
      if (!KNOWN_FIELD_TYPES.has(field.type)) {
        fail(errors, caseyText("src/core/pack-schema.js#w10", [formId, fieldKey, field.type, [...KNOWN_FIELD_TYPES].join(', ')]))
      }
      if (field.type === 'enum') {
        const hasInlineOptions = Array.isArray(field.options) && field.options.length > 0
        const codelistRef = field.codelist
        if (!hasInlineOptions && !codelistRef) {
          fail(errors, caseyText("src/core/pack-schema.js#w11", [formId, fieldKey]))
        }
        if (codelistRef && !pack.codelists?.[codelistRef]) {
          fail(errors, caseyText("src/core/pack-schema.js#w12", [formId, fieldKey, codelistRef]))
        }
      }
      if (field.evidenceRequired != null && typeof field.evidenceRequired !== 'boolean') {
        fail(errors, caseyText("src/core/pack-schema.js#w13", [formId, fieldKey]))
      }
      if (field.unknownAllowed === false) {
        fail(errors, caseyText("src/core/pack-schema.js#w14", [formId, fieldKey]))
      }
    }
  }
}

function validateCodelists(pack, errors) {
  if (pack.codelists == null) return
  if (typeof pack.codelists !== 'object') { fail(errors, caseyText("src/core/pack-schema.js#w15")); return }
  for (const [name, list] of Object.entries(pack.codelists)) {
    if (!Array.isArray(list) || !list.length) { fail(errors, caseyText("src/core/pack-schema.js#w16", [name])); continue }
    const keys = new Set()
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || !entry.key) { fail(errors, caseyText("src/core/pack-schema.js#w17", [name])); continue }
      if (keys.has(entry.key)) fail(errors, caseyText("src/core/pack-schema.js#w18", [name, entry.key]))
      keys.add(entry.key)
    }
  }
}

function validateRuleCondition(cond, path, errors, declaredFields) {
  if (typeof cond === 'function') { fail(errors, caseyText("src/core/pack-schema.js#w19", [path])); return }
  if (!cond || typeof cond !== 'object') { fail(errors, caseyText("src/core/pack-schema.js#w20", [path])); return }
  if (!KNOWN_RULE_OPS.has(cond.op)) { fail(errors, caseyText("src/core/pack-schema.js#w21", [path, cond.op, [...KNOWN_RULE_OPS].join(', ')])); return }
  if (cond.op === 'and' || cond.op === 'or') {
    if (!Array.isArray(cond.clauses) || !cond.clauses.length) { fail(errors, caseyText("src/core/pack-schema.js#w22", [path, cond.op])); return }
    cond.clauses.forEach((c, i) => validateRuleCondition(c, `${path}.clauses[${i}]`, errors, declaredFields))
    return
  }
  if (!cond.field || (declaredFields && !declaredFields.has(cond.field))) {
    fail(errors, caseyText("src/core/pack-schema.js#w23", [path, cond.field]))
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
  if (pack.rules == null) return
  if (!Array.isArray(pack.rules)) { fail(errors, caseyText("src/core/pack-schema.js#w24")); return }
  const declaredFields = collectAllFormFields(pack)
  pack.rules.forEach((rule, i) => {
    if (!rule || typeof rule !== 'object') { fail(errors, caseyText("src/core/pack-schema.js#w25", [i])); return }
    if (!rule.id) fail(errors, `rules[${i}]: missing "id"`)
    if (!rule.condition) { fail(errors, `rules[${i}]: missing "condition"`); return }
    validateRuleCondition(rule.condition, `rules[${i}].condition`, errors, declaredFields)
    if (!rule.severity) fail(errors, `rules[${i}]: missing "severity"`)
    if (!rule.route) fail(errors, `rules[${i}]: missing "route"`)
  })
}

function validateRoles(pack, errors) {
  if (pack.roles == null) return
  if (typeof pack.roles !== 'object') { fail(errors, caseyText("src/core/pack-schema.js#w26")); return }
  for (const [roleId, def] of Object.entries(pack.roles)) {
    if (!def || typeof def !== 'object') { fail(errors, caseyText("src/core/pack-schema.js#w27", [roleId])); continue }
    if (def.rowAccess && !KNOWN_ROW_ACCESS.has(def.rowAccess)) {
      fail(errors, caseyText("src/core/pack-schema.js#w28", [roleId, def.rowAccess, [...KNOWN_ROW_ACCESS].join(', ')]))
    }
  }
}

function validateViews(pack, errors) {
  if (pack.views == null) return
  if (typeof pack.views !== 'object') { fail(errors, caseyText("src/core/pack-schema.js#w29")); return }
  const KNOWN_VIEW_TYPES = new Set(['map', 'timeseries', 'table', 'drilldown'])
  for (const [viewId, def] of Object.entries(pack.views)) {
    if (!def || typeof def !== 'object') { fail(errors, caseyText("src/core/pack-schema.js#w30", [viewId])); continue }
    if (!KNOWN_VIEW_TYPES.has(def.type)) fail(errors, caseyText("src/core/pack-schema.js#w31", [viewId, def.type, [...KNOWN_VIEW_TYPES].join(', ')]))
  }
}

function validateStrings(pack, errors) {
  if (pack.strings == null) { fail(errors, caseyText("src/core/pack-schema.js#w32")); return }
  if (typeof pack.strings !== 'object') { fail(errors, caseyText("src/core/pack-schema.js#w33")) }
}

export function validatePack(pack) {
  const errors = []
  if (!pack || typeof pack !== 'object') return { valid: false, errors: [caseyText("src/core/pack-schema.js#w34")] }
  if (!pack.id) fail(errors, caseyText("src/core/pack-schema.js#w35"))
  if (!pack.version) fail(errors, caseyText("src/core/pack-schema.js#w36"))
  validateSubjectTypes(pack, errors)
  validateObservationForms(pack, errors)
  validateCodelists(pack, errors)
  validateRules(pack, errors)
  validateRoles(pack, errors)
  validateViews(pack, errors)
  validateStrings(pack, errors)
  return { valid: errors.length === 0, errors }
}

export function loadPack(packData) {
  const { valid, errors } = validatePack(packData)
  if (!valid) {
    throw new Error(`pack "${packData?.id || '(unknown)'}" failed validation:\n  - ${errors.join('\n  - ')}`)
  }
  return Object.freeze(packData)
}
