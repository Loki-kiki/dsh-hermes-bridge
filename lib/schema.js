/**
 * Turn the compact parameter DSL into the JSON Schema that `ctx.tools.register()`
 * expects.
 *
 * Why this exists: `defineTool()` from `@deepseek-ai/dsh-tools` is what normally
 * expands this shorthand, but a bundle plugin must not import `@deepseek-ai/*`
 * values — the profile loader supplies those names, and every extra one is
 * another way for the plugin to fail to resolve. Registering a definition whose
 * `parameters` are still the shorthand is not a silent mistake either: the
 * provider rejects it with
 * `schema must be a JSON Schema of 'type: "object"', got 'type: null'`.
 *
 * The DSL mirrors the subset `dsh-tools` documents:
 * `string` / `number` / `integer` / `boolean` / `null` / `array` / `object`,
 * plus `required`, `description`, `enum`, `minimum`, `maximum`, `items`, and
 * `properties` for nested objects.
 *
 * @module dsh-hermes-bridge/schema
 */

/**
 * Keys that are DSL syntax only, not JSON Schema keywords.
 *
 * `required` is expressed as the parent's `required` array, so copying it onto
 * the child would emit a keyword that does not exist there. `description` is a
 * real JSON Schema keyword and must survive: it is the only place the model is
 * told what a parameter means.
 */
const META_KEYS = new Set(['required'])

/**
 * Convert one value spec into JSON Schema.
 * @param {object} spec - DSL spec such as `{ type: 'string', required: true }`.
 * @returns {object} JSON Schema node.
 */
export function toJsonSchema(spec) {
  if (spec === null || typeof spec !== 'object') return { type: 'string' }
  const node = {}
  const type = spec.type
  if (type === 'object') {
    node.type = 'object'
    const fromProperties = spec.properties ?? {}
    node.properties = Object.fromEntries(
      Object.entries(fromProperties).map(([key, child]) => [key, toJsonSchema(child)]),
    )
    const required = Object.entries(fromProperties)
      .filter(([, child]) => child?.required === true)
      .map(([key]) => key)
    node.required = required
    node.additionalProperties = false
  } else if (type === 'array') {
    node.type = 'array'
    node.items = spec.items === undefined ? {} : toJsonSchema(spec.items)
  } else if (['string', 'number', 'integer', 'boolean', 'null'].includes(type)) {
    node.type = type
  } else {
    // An unknown/absent type is a free-form value, which the providers accept
    // only as an untyped node. `{}` says "anything" without lying about it.
    return {}
  }
  for (const [key, value] of Object.entries(spec)) {
    if (META_KEYS.has(key) || key === 'type' || key === 'properties' || key === 'items') continue
    node[key] = value
  }
  return node
}

/**
 * Convert a whole parameter map into an object JSON Schema.
 *
 * `ctx.tools.register()` validates the model's arguments against exactly this,
 * so `required` here is load-bearing: a parameter declared required but omitted
 * from this array silently becomes optional.
 *
 * @param {Record<string, object>} parameters - the row's `parameters` map.
 * @returns {object} object JSON Schema.
 */
export function parameterSchema(parameters) {
  const map = parameters ?? {}
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(map).map(([key, spec]) => [key, toJsonSchema(spec)])),
    required: Object.entries(map).filter(([, spec]) => spec?.required === true).map(([key]) => key),
    additionalProperties: false,
  }
}

/**
 * Fill in the parts of a tool definition the registry requires but the row did
 * not spell out, so every registered tool has a complete shape.
 *
 * @param {object} tool - partial definition: name, description, parameters, execute.
 * @returns {object} definition ready for `ctx.tools.register()`.
 */
export function defineTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: parameterSchema(tool.parameters),
    output: tool.output ?? {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    execute: tool.execute,
  }
}

/**
 * Wrap a tool whose `parameters` are **already** a JSON Schema.
 *
 * Providers bridged from another runtime hand over a finished JSON Schema
 * (`{type:'object', properties, required}`) — running that through the DSL
 * converter would treat `properties` as a parameter map and mangle it. This
 * entry point keeps the schema verbatim, which is the whole point of forwarding
 * a foreign tool set: the model must see the same contract the provider wrote.
 *
 * @param {object} tool - definition with a real JSON Schema in `parameters`.
 * @returns {object} definition ready for `ctx.tools.register()`.
 */
export function defineToolFromSchema(tool) {
  const parameters = tool.parameters !== null && typeof tool.parameters === 'object' && tool.parameters.type === 'object'
    ? tool.parameters
    : { type: 'object', properties: {}, required: [], additionalProperties: false }
  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      additionalProperties: false,
      ...parameters,
      ...(Array.isArray(parameters.required) ? {} : { required: [] }),
    },
    output: tool.output ?? {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    execute: tool.execute,
  }
}
