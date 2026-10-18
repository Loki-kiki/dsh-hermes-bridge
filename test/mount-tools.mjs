/**
 * Mount the tool rows against a fake cordis context and call them.
 *
 * The DSH UI needs a working model to exercise a tool, and the tool rows that
 * read Hermes' runtime data need a real Hermes home. Mounting the rows directly
 * tests the part that can be wrong here — registration and the tool bodies —
 * without dragging a model or a live install into it.
 *
 * The hermes-data section reads the real Hermes home (cron jobs, session
 * history), so the whole file is gated:
 *
 *   LIVE_TESTS=1 node test/mount-tools.mjs
 */

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

import { apply as applyMemoryWrite } from '../lib/memory-write.js'
import { apply as applyHermesData } from '../lib/hermes-data.js'
import { resolveHermesHome } from '../lib/util.js'

if (process.env.LIVE_TESTS !== '1') {
  console.log('skip  this file mounts rows against the real Hermes home — set LIVE_TESTS=1 to run it')
  process.exit(0)
}

const results = []
async function check(label, fn) {
  try {
    const note = await fn()
    results.push({ label, ok: true, note })
  } catch (error) {
    results.push({ label, ok: false, error: error?.message ?? String(error) })
  }
}

/**
 * A context that records what a row registers.
 * @param {string} hermesHome - Hermes home for the row config.
 * @returns {{ctx: object, tools: Map<string, object>, logs: string[]}} harness.
 */
function fakeContext(hermesHome) {
  const tools = new Map()
  const logs = []
  const ctx = {
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(`warn: ${line}`) },
    inject(services, fn) {
      // Rows inject ['tools']; hand them a scope exposing `register` and `effect`.
      fn({
        tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
        effect(fn2) { return fn2() },
      })
    },
  }
  return { ctx, tools, logs }
}

// ── memory-write row ────────────────────────────────────────────────────────
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mount-'))
await fsp.mkdir(path.join(home, 'memories'), { recursive: true })
await fsp.writeFile(
  path.join(home, 'config.yaml'),
  'memory:\n  memory_char_limit: 2200\n  user_char_limit: 1375\n',
  'utf8',
)
await fsp.writeFile(path.join(home, 'memories', 'MEMORY.md'), 'legacy hermes note', 'utf8')

const memoryHarness = fakeContext(home)
applyMemoryWrite(memoryHarness.ctx, { hermesHome: home, origin: 'dsh' })

await check('memory-write registers a tool named memory', () => {
  assert.ok(memoryHarness.tools.has('memory'), `registered: ${[...memoryHarness.tools.keys()].join(', ')}`)
  return 'memory'
})

await check('memory tool schema is a JSON object with required action/target', () => {
  const tool = memoryHarness.tools.get('memory')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required.sort(), ['action', 'target'])
  assert.ok(tool.parameters.properties.action.enum.includes('add'))
  return `${Object.keys(tool.parameters.properties).length} params`
})

await check('memory list reports origin per entry', async () => {
  const tool = memoryHarness.tools.get('memory')
  const listed = await tool.execute({ action: 'list', target: 'memory' })
  assert.equal(listed.entries.length, 1)
  assert.equal(listed.entries[0].origin, 'hermes')
  assert.equal(listed.entries[0].tagged, false)
  return `limit ${listed.limit}, remaining ${listed.remaining}`
})

await check('memory add writes a [dsh] tagged entry', async () => {
  const tool = memoryHarness.tools.get('memory')
  const added = await tool.execute({ action: 'add', target: 'memory', text: 'written from dsh' })
  assert.equal(added.added, '[dsh] written from dsh')
  const listed = await tool.execute({ action: 'list', target: 'memory' })
  assert.deepEqual(
    listed.entries.map((entry) => [entry.origin, entry.tagged]),
    [['hermes', false], ['dsh', true]],
  )
  return `${listed.entries.length} entries`
})

await check('memory add refuses to create a file that does not exist', async () => {
  const tool = memoryHarness.tools.get('memory')
  await assert.rejects(
    () => tool.execute({ action: 'add', target: 'user', text: 'x' }),
    /does not exist — refusing to create it/u,
  )
  return 'refused USER.md creation'
})

await check('memory patch keeps the origin tag', async () => {
  const tool = memoryHarness.tools.get('memory')
  const patched = await tool.execute({
    action: 'patch',
    target: 'memory',
    old_text: 'written from dsh',
    text: 'rewritten from dsh',
  })
  assert.equal(patched.with, '[dsh] rewritten from dsh')
  return 'rewritten'
})

await check('memory remove drops exactly the asked entry', async () => {
  const tool = memoryHarness.tools.get('memory')
  const removed = await tool.execute({ action: 'remove', target: 'memory', old_text: 'rewritten from dsh' })
  assert.match(removed.removed, /rewritten from dsh/u)
  const listed = await tool.execute({ action: 'list', target: 'memory' })
  assert.equal(listed.entries.length, 1)
  return `${listed.entries.length} left`
})

await check('origin override is refused by default', async () => {
  const tool = memoryHarness.tools.get('memory')
  await assert.rejects(
    () => tool.execute({ action: 'add', target: 'memory', text: 'x', origin: 'hermes' }),
    /does not allow other origins/u,
  )
  return 'refused'
})

await check('an unknown target is refused', async () => {
  const tool = memoryHarness.tools.get('memory')
  await assert.rejects(() => tool.execute({ action: 'list', target: 'nope' }), /unknown target/u)
  return 'refused'
})

await check('readOnly row refuses writes but still lists', async () => {
  const harness = fakeContext(home)
  applyMemoryWrite(harness.ctx, { hermesHome: home, readOnly: true })
  const tool = harness.tools.get('memory')
  await tool.execute({ action: 'list', target: 'memory' })
  await assert.rejects(
    () => tool.execute({ action: 'add', target: 'memory', text: 'x' }),
    /read-only/u,
  )
  return 'list ok, add refused'
})

// ── hermes-data row ────────────────────────────────────────────────────────
const realHome = resolveHermesHome(process.env.HERMES_HOME)

const dataHarness = fakeContext(realHome)
applyHermesData(dataHarness.ctx, { hermesHome: realHome })

await check('hermes-data registers three read-only tools', () => {
  const names = [...dataHarness.tools.keys()].sort()
  assert.deepEqual(names, ['hermes_cron', 'hermes_session_read', 'hermes_session_search'])
  return names.join(', ')
})

await check('hermes_cron lists the real jobs', async () => {
  const tool = dataHarness.tools.get('hermes_cron')
  const listed = await tool.execute({})
  assert.ok(listed.total > 0)
  return `${listed.total} jobs, ${listed.matched} matched`
})

await check('hermes_cron filter narrows the list', async () => {
  const tool = dataHarness.tools.get('hermes_cron')
  const listed = await tool.execute({})
  const filtered = await tool.execute({ filter: 'e' })
  assert.ok(filtered.matched > 0, `matched ${filtered.matched} of ${filtered.total}`)
  assert.ok(filtered.matched <= listed.total, 'filter matched more than the full list')
  return `${filtered.matched}/${filtered.total}`
})

await check('hermes_session_search finds history', async () => {
  const tool = dataHarness.tools.get('hermes_session_search')
  const term = process.env.SEARCH_TERM ?? 'hermes'
  const found = await tool.execute({ query: term, limit: 3 })
  assert.ok(found.hits > 0, `no hits for ${JSON.stringify(term)} — set SEARCH_TERM`)
  return `${found.hits} hits`
})

await check('hermes_session_read returns a page', async () => {
  const search = dataHarness.tools.get('hermes_session_search')
  const read = dataHarness.tools.get('hermes_session_read')
  const term = process.env.SEARCH_TERM ?? 'hermes'
  const found = await search.execute({ query: term, limit: 1 })
  const page = await read.execute({ session_id: found.results[0].sessionId, limit: 2 })
  assert.equal(page.session.id, found.results[0].sessionId)
  assert.ok(page.messages.length > 0)
  return `${page.messages.length} messages`
})

await fsp.rm(home, { recursive: true, force: true })

for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok ? ` — ${item.note}` : `\n        ${item.error}`}`)
}
const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
