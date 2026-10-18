/**
 * Self-test for the managed-block splicer. Run with:
 *   node test/splice.mjs
 *
 * Every case asserts the result is still a single top-level YAML array — the
 * property the DSH loader requires and the one a naive "append the block" bug
 * breaks.
 */

import assert from 'node:assert/strict'
import YAML from 'yaml'
import { spliceBlock, BLOCK_BEGIN, BLOCK_END, renderBlock, toMcpRow } from '../lib/mcp-sync.js'

const block = renderBlock([{ id: 'x', row: { serverName: 'x', transport: 'stdio', command: 'true' } }])
const parseArray = (text) => {
  const value = YAML.parse(text === '' ? '[]' : text)
  assert.ok(Array.isArray(value), 'result must parse as a top-level array')
  return value
}

const cases = {
  'empty string': '',
  'empty flow array': '[]',
  'empty flow array + comment': '# my patch\n[]',
  'comments only': '# just a comment\n',
  'flow array with an entry': '[{id: foo, disabled: true}]',
  'block array with an entry': '- id: tool-plugin-manager\n  disabled: false\n',
  'block array + trailing comment': '- id: a\n  disabled: false\n# tail comment\n',
}

for (const [label, input] of Object.entries(cases)) {
  const output = spliceBlock(input, block)
  const parsed = parseArray(output)
  assert.ok(output.includes(BLOCK_BEGIN), `${label}: managed block missing`)
  assert.ok(output.includes(BLOCK_END), `${label}: end marker missing`)
  const ids = JSON.stringify(parsed)
  assert.ok(ids.includes('"x"'), `${label}: inserted row missing`)
  if (label === 'block array with an entry') {
    assert.ok(ids.includes('tool-plugin-manager'), `${label}: pre-existing row was dropped`)
  }
  if (label === 'block array + trailing comment') {
    assert.ok(ids.includes('"a"'), `${label}: pre-existing row was dropped`)
  }
  if (label === 'flow array with an entry') {
    assert.ok(ids.includes('"foo"'), `${label}: pre-existing flow entry was dropped`)
  }
  console.log(`ok  ${label}`)
}

// Idempotency: splicing the same block twice must be a no-op the second time.
const first = spliceBlock('[]', block)
const second = spliceBlock(first, block)
assert.equal(first, second, 'splicing twice must be idempotent')
console.log('ok  idempotent replace')

// Removal must restore a loadable file and leave user content intact.
const withUser = spliceBlock('- id: keep-me\n  disabled: true\n', block)
const removed = spliceBlock(withUser, '')
const removedParsed = parseArray(removed === '' ? '[]' : removed)
assert.ok(JSON.stringify(removedParsed).includes('"keep-me"'), 'removal dropped user rows')
assert.ok(!removed.includes(BLOCK_BEGIN), 'removal left the managed block behind')
console.log('ok  removal keeps user rows')

// A half-written block (marker without its end marker) must be rebuilt, not
// left in a state the loader rejects.
const halfWritten = `- id: user\n  disabled: true\n\n${BLOCK_BEGIN}\n- insert:\n  - id: stale\n`
const repaired = spliceBlock(halfWritten, block)
const repairedParsed = JSON.stringify(parseArray(repaired))
assert.ok(repairedParsed.includes('user'), 'repair dropped user rows')
assert.ok(!repairedParsed.includes('stale'), 'repair kept the half-written row')
console.log('ok  half-written block repaired')

// Secrets round-trip: a long Authorization header must survive YAML rendering.
const longToken = `Bearer ${'A'.repeat(60)}`
const rows = [toMcpRow('srv', { url: 'https://example.test/mcp', headers: { Authorization: longToken } }, 180000, [])]
const rendered = renderBlock(rows)
const reparsed = parseArray(rendered)
const roundTripped = reparsed[0].insert[0].config.headers.Authorization
assert.equal(roundTripped, longToken, 'Authorization header was truncated')
console.log('ok  long header round-trips through renderBlock')

console.log('\nall splice tests passed')
