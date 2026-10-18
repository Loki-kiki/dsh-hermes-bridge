/**
 * Offline tests for the compact parameter DSL -> JSON Schema converter.
 *
 * The converter is the only thing standing between a row's shorthand and what
 * `ctx.tools.register()` validates, so the load-bearing bits are: `required`
 * lands in the parent array, and every parameter keeps its description.
 *
 *   node test/schema.mjs
 */

import assert from 'node:assert/strict'

import { defineTool, parameterSchema, toJsonSchema } from '../lib/schema.js'

const results = []
function check(label, fn) {
  try {
    fn()
    results.push({ label, ok: true })
  } catch (error) {
    results.push({ label, ok: false, error: error?.message ?? String(error) })
  }
}

check('scalar specs keep type and description', () => {
  assert.deepEqual(
    toJsonSchema({ type: 'string', description: 'what it means', required: true }),
    { type: 'string', description: 'what it means' },
  )
})

check('enums, bounds and defaults pass through', () => {
  assert.deepEqual(
    toJsonSchema({ type: 'integer', minimum: 1, maximum: 5, enum: [1, 2] }),
    { type: 'integer', minimum: 1, maximum: 5, enum: [1, 2] },
  )
})

check('arrays carry an items schema', () => {
  assert.deepEqual(
    toJsonSchema({ type: 'array', items: { type: 'string', description: 'one entry' } }),
    { type: 'array', items: { type: 'string', description: 'one entry' } },
  )
})

check('nested objects compute their own required list', () => {
  const schema = toJsonSchema({
    type: 'object',
    description: 'options',
    properties: { a: { type: 'string', required: true }, b: { type: 'number' } },
  })
  assert.deepEqual(schema.required, ['a'])
  assert.deepEqual(schema.properties.a, { type: 'string' })
  assert.equal(schema.additionalProperties, false)
})

check('an unknown type stays an untyped node', () => {
  assert.deepEqual(toJsonSchema({ type: 'weird' }), {})
})

check('parameterSchema collects required names and descriptions', () => {
  const schema = parameterSchema({
    query: { type: 'string', required: true, description: 'search text' },
    limit: { type: 'number', description: 'how many' },
  })
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['query'])
  assert.equal(schema.properties.query.description, 'search text')
  assert.equal(schema.properties.limit.description, 'how many')
})

check('defineTool fills in a complete definition', () => {
  const tool = defineTool({
    name: 'demo',
    description: 'a demo',
    parameters: { q: { type: 'string', required: true, description: 'a question' } },
    execute: () => ({}),
  })
  assert.equal(tool.name, 'demo')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['q'])
  assert.equal(tool.parameters.properties.q.description, 'a question')
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.execute, 'function')
})

const failed = results.filter((item) => !item.ok)
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok ? '' : `\n        ${item.error}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
