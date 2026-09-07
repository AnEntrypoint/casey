// Converts casey's existing plain-JSON-Schema tool parameter definitions
// (src/case-tools.js's { type:'object', properties:{...}, required:[...] })
// into freddie's Cordis tool-schema DSL (an implicit property map where each
// property carries its own `required: true` flag inline, rather than a
// separate top-level required[] array -- see
// deps/freddie/packages/core/tools/src/schema.js's parameterSchemaSpecToJsonSchema).
//
// This is a mechanical, generic translation -- it never encodes any
// case_*-tool-specific knowledge -- so casey's 18 existing tool schemas
// (src/case-tools.js) convert with no hand-transcription and no risk of one
// tool's schema silently drifting from its own JSON-Schema source of truth.

const DSL_VALUE_KEYS = ['description', 'title', 'default', 'examples', 'enum']

// One JSON-Schema property node -> one DSL value-schema node. Recurses into
// object/array children; every other JSON-Schema keyword casey's own tool
// schemas use (type, description, enum, items, properties) maps directly.
function toValueSchema(node, requiredSet, key) {
  if (!node || typeof node !== 'object') return { type: 'json' }
  const out = {}
  for (const k of DSL_VALUE_KEYS) if (Object.hasOwn(node, k)) out[k] = node[k]
  if (requiredSet && key !== undefined && requiredSet.has(key)) out.required = true

  switch (node.type) {
    case 'object': {
      out.type = 'object'
      out.additionalProperties = node.additionalProperties === true
      if (node.properties) {
        out.properties = toPropertyMap(node.properties, new Set(node.required || []))
      }
      return out
    }
    case 'array': {
      out.type = 'array'
      if (node.items) out.items = toValueSchema(node.items, null, undefined)
      return out
    }
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      out.type = node.type
      return out
    default:
      // Unrecognized/absent type (e.g. a bare {} placeholder) -> the DSL's
      // any-JSON-value escape hatch rather than guessing a type.
      return { type: 'json', ...(out.description ? { description: out.description } : {}) }
  }
}

function toPropertyMap(properties, requiredSet) {
  const out = {}
  for (const [key, node] of Object.entries(properties)) {
    out[key] = toValueSchema(node, requiredSet, key)
  }
  return out
}

/**
 * Convert a plain-JSON-Schema tool `parameters` object (casey's
 * src/case-tools.js shape: {type:'object', properties, required}) into the
 * Cordis `defineTool({parameters})` implicit property-map DSL.
 */
export function adaptParameters(jsonSchemaParams) {
  const properties = jsonSchemaParams?.properties || {}
  const required = new Set(jsonSchemaParams?.required || [])
  return toPropertyMap(properties, required)
}

// Every casey tool handler returns a loosely-shaped plain object
// ({ok:true,...}, {error:'...'}, arbitrary case/report projections) with no
// single fixed schema across the 18 tools -- the DSL's `type:'json'` escape
// hatch (an annotation-only, any-JSON-value schema) is the correct fit
// rather than hand-authoring 18 precise output schemas that would need to
// track case-tools.js's own return shapes forever. render() renders the
// result as a text block (JSON-stringified) for the transcript/UI -- the
// model itself reads the tool-result message content directly, not this
// render output.
export const JSON_OUTPUT_SCHEMA = { type: 'json' }
export function renderJsonOutput(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}
