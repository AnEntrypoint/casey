

const DSL_VALUE_KEYS = ['description', 'title', 'default', 'examples', 'enum']

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

export function adaptParameters(jsonSchemaParams) {
  const properties = jsonSchemaParams?.properties || {}
  const required = new Set(jsonSchemaParams?.required || [])
  return toPropertyMap(properties, required)
}

export const JSON_OUTPUT_SCHEMA = { type: 'json' }
export function renderJsonOutput(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}
