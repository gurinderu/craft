// A task's answer schema as `codex exec --output-schema` takes it (realm @nick/craft, node #491). Codex sends the
// schema in the API's strict mode, which refuses an object whose `required` leaves out one of its properties or that
// does not forbid others (observed: codex-cli 0.167.0, a 400 `invalid_json_schema` naming the missing key). Some of
// the binary's schemas keep fields optional (the scout's surfaces, the memory recall), so the driver hands Codex a
// strict copy — every property required, each optional one nullable — and drops the nulls the model wrote for the
// optional ones from its answer, so the binary reads the answer its own schema describes.

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** A schema that also takes null. @param {Record<string, any>} s @returns {Record<string, any>} */
function nullable(s) {
  if (typeof s['type'] === 'string') return { ...s, type: [s['type'], 'null'], ...(Array.isArray(s['enum']) ? { enum: [...s['enum'], null] } : {}) }
  if (Array.isArray(s['type'])) return s['type'].includes('null') ? s : { ...s, type: [...s['type'], 'null'] }
  return { anyOf: [s, { type: 'null' }] }
}

/** The strict copy of an object schema's own level, its properties made strict first. @param {Record<string, any>} s */
function strictObject(s) {
  const props = isObject(s['properties']) ? s['properties'] : {}
  const required = Array.isArray(s['required']) ? s['required'] : []
  /** @type {Record<string, unknown>} */
  const properties = {}
  for (const [k, v] of Object.entries(props)) properties[k] = required.includes(k) ? strictSchema(v) : nullable(/** @type {Record<string, any>} */ (strictSchema(v)))
  return { ...s, properties, required: Object.keys(props), additionalProperties: false }
}

/**
 * The strict copy of `schema`: every object's properties all required, each one its schema left optional nullable,
 * and no other property allowed; arrays' items and the alternatives of anyOf, oneOf and allOf the same.
 * @param {unknown} schema @returns {unknown}
 */
export function strictSchema(schema) {
  if (!isObject(schema)) return schema
  /** @type {Record<string, any>} */
  const s = schema['type'] === 'object' || isObject(schema['properties']) ? strictObject(schema) : { ...schema }
  if (s['items'] !== undefined) s['items'] = strictSchema(s['items'])
  for (const k of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(s[k])) s[k] = s[k].map(strictSchema)
  return s
}

/**
 * `value` with each null dropped where `schema` (the binary's own) leaves the property optional: what the strict copy
 * made the model write for a field it had nothing for.
 * @param {unknown} value @param {unknown} schema @returns {unknown}
 */
export function dropOptionalNulls(value, schema) {
  if (!isObject(schema)) return value
  if (Array.isArray(value)) return value.map(v => dropOptionalNulls(v, schema['items']))
  if (!isObject(value) || !isObject(schema['properties'])) return value
  const required = Array.isArray(schema['required']) ? schema['required'] : []
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (v === null && !required.includes(k)) continue
    out[k] = dropOptionalNulls(v, schema['properties'][k])
  }
  return out
}
