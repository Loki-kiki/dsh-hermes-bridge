/**
 * Offline tests for the memory store.
 *
 * These run against a scratch directory, never the real memory files: the whole
 * point of the store is that it mutates a shared, hard-capped budget, so a test
 * that ran against the live file would be one bug away from destroying it.
 *
 *   node test/memory-store.mjs
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  ENTRY_DELIMITER,
  addEntry,
  charCount,
  joinEntries,
  parseEntries,
  patchEntry,
  readOrigin,
  readTarget,
  removeEntry,
  withOrigin,
} from '../lib/memory-store.js'

const results = []
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push({ label, ok: true }))
    .catch((error) => results.push({ label, ok: false, error: error?.message ?? String(error) }))
}

/** Scratch Hermes home with a config that sets explicit limits. */
async function scratchHome({ memoryLimit = 2200, userLimit = 1375 } = {}) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hbmem-'))
  await fsp.mkdir(path.join(home, 'memories'), { recursive: true })
  await fsp.writeFile(
    path.join(home, 'config.yaml'),
    `memory:\n  memory_char_limit: ${memoryLimit}\n  user_char_limit: ${userLimit}\n  provider: openviking\n`,
    'utf8',
  )
  return home
}

await check('parseEntries splits on the full delimiter only', () => {
  const raw = `first entry${ENTRY_DELIMITER}second § with a bare section mark${ENTRY_DELIMITER}third`
  const entries = parseEntries(raw)
  assert.equal(entries.length, 3)
  assert.equal(entries[1], 'second § with a bare section mark')
})

await check('parseEntries drops empty entries and pads', () => {
  assert.deepEqual(parseEntries(`${ENTRY_DELIMITER}a${ENTRY_DELIMITER}${ENTRY_DELIMITER}b${ENTRY_DELIMITER}`), ['a', 'b'])
  assert.deepEqual(parseEntries(''), [])
})

await check('parseEntries handles the CRLF delimiter Windows files carry', () => {
  // Windows-edited memory files carry CRLF: splitting on `\n§\n` alone would
  // read the whole file as one entry, and writing that back destroys it.
  const raw = 'first\r\n§\r\nsecond\r\n§\r\nthird'
  const entries = parseEntries(raw)
  assert.equal(entries.length, 3, `got ${entries.length}: ${JSON.stringify(entries)}`)
  assert.deepEqual(entries, ['first', 'second', 'third'])
})

await check('a CRLF file survives an append without collapsing', async () => {
  const home = await scratchHome()
  const file = path.join(home, 'memories', 'MEMORY.md')
  const original = 'one\r\n§\r\ntwo\r\n§\r\nthree'
  await fsp.writeFile(file, original, 'utf8')

  await addEntry(home, 'memory', 'four', 'dsh')
  const after = await fsp.readFile(file, 'utf8')
  assert.equal(parseEntries(after).length, 4, `entries collapsed: ${JSON.stringify(parseEntries(after))}`)
  // Line endings preserved: a rewrite to LF would make every line a diff.
  assert.ok(after.includes('\r\n§\r\n'), 'CRLF delimiter was not preserved')
  assert.ok(after.startsWith('one\r\n§\r\ntwo'), after.slice(0, 40))
  await fsp.rm(home, { recursive: true, force: true })
})

await check('readOrigin treats untagged as assumed hermes', () => {
  const untagged = readOrigin('plain note')
  assert.equal(untagged.origin, 'hermes')
  assert.equal(untagged.tagged, false)
  assert.equal(untagged.text, 'plain note')

  const tagged = readOrigin('[dsh] written in DSH')
  assert.equal(tagged.origin, 'dsh')
  assert.equal(tagged.tagged, true)
  assert.equal(tagged.text, 'written in DSH')
})

await check('withOrigin tags once and never double-tags', () => {
  assert.equal(withOrigin('note', 'dsh'), '[dsh] note')
  assert.equal(withOrigin('[hermes] note', 'dsh'), '[hermes] note')
  assert.equal(withOrigin('  spaced  ', 'dsh'), '[dsh] spaced')
  assert.equal(withOrigin('', 'dsh'), '')
})

await check('addEntry tags new entries and leaves legacy ones untouched', async () => {
  const home = await scratchHome()
  const file = path.join(home, 'memories', 'MEMORY.md')
  await fsp.writeFile(file, `legacy one${ENTRY_DELIMITER}legacy two`, 'utf8')

  const result = await addEntry(home, 'memory', 'written by dsh', 'dsh')
  assert.equal(result.entries, 3)
  assert.equal(result.added, '[dsh] written by dsh')

  const after = await fsp.readFile(file, 'utf8')
  // Legacy entries keep their exact bytes: no backfill, no reflow.
  assert.ok(after.startsWith(`legacy one${ENTRY_DELIMITER}legacy two`), after)
  assert.ok(after.endsWith('[dsh] written by dsh'), after)

  await fsp.rm(home, { recursive: true, force: true })
})

await check('addEntry refuses to exceed the limit', async () => {
  const home = await scratchHome({ memoryLimit: 40 })
  await fsp.writeFile(path.join(home, 'memories', 'MEMORY.md'), 'x'.repeat(30), 'utf8')
  await assert.rejects(
    () => addEntry(home, 'memory', 'y'.repeat(20), 'dsh'),
    /would exceed Hermes' limit of 40/u,
  )
  // The refused write must not have touched the file.
  const after = await fsp.readFile(path.join(home, 'memories', 'MEMORY.md'), 'utf8')
  assert.equal(after, 'x'.repeat(30))
  await fsp.rm(home, { recursive: true, force: true })
})

await check('patchEntry needs a unique match', async () => {
  const home = await scratchHome()
  const file = path.join(home, 'memories', 'MEMORY.md')
  await fsp.writeFile(file, `alpha one${ENTRY_DELIMITER}alpha two`, 'utf8')

  await assert.rejects(() => patchEntry(home, 'memory', 'alpha', 'x', 'dsh'), /matches 2 entries/u)

  const result = await patchEntry(home, 'memory', 'alpha two', 'rewritten', 'dsh')
  assert.equal(result.replaced, 'alpha two')
  assert.equal(result.with, '[dsh] rewritten')
  const after = parseEntries(await fsp.readFile(file, 'utf8'))
  assert.deepEqual(after, ['alpha one', '[dsh] rewritten'])

  await fsp.rm(home, { recursive: true, force: true })
})

await check('removeEntry deletes exactly one entry', async () => {
  const home = await scratchHome()
  const file = path.join(home, 'memories', 'MEMORY.md')
  await fsp.writeFile(file, `keep${ENTRY_DELIMITER}drop this${ENTRY_DELIMITER}keep too`, 'utf8')

  const result = await removeEntry(home, 'memory', 'drop this')
  assert.equal(result.removed, 'drop this')
  assert.equal(result.entries, 2)
  assert.deepEqual(parseEntries(await fsp.readFile(file, 'utf8')), ['keep', 'keep too'])

  await fsp.rm(home, { recursive: true, force: true })
})

await check('readTarget reports origin per entry and the real limit', async () => {
  const home = await scratchHome({ memoryLimit: 1234, userLimit: 999 })
  await fsp.writeFile(
    path.join(home, 'memories', 'MEMORY.md'),
    `old note${ENTRY_DELIMITER}[dsh] new note`,
    'utf8',
  )
  const snapshot = await readTarget(home, 'memory')
  assert.equal(snapshot.limit, 1234)
  assert.deepEqual(
    snapshot.entries.map((entry) => [entry.origin, entry.tagged]),
    [['hermes', false], ['dsh', true]],
  )
  await fsp.rm(home, { recursive: true, force: true })
})

await check('readTarget falls back to documented limits without config', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hbmem-'))
  await fsp.mkdir(path.join(home, 'memories'), { recursive: true })
  const snapshot = await readTarget(home, 'user')
  // Hermes' documented default, not whatever a particular machine config says.
  assert.equal(snapshot.limit, 1375)
  assert.equal(snapshot.entries.length, 0)
  await fsp.rm(home, { recursive: true, force: true })
})

await check('an existing empty file takes the first entry', async () => {
  const home = await scratchHome()
  await fsp.writeFile(path.join(home, 'memories', 'USER.md'), '', 'utf8')
  const result = await addEntry(home, 'user', 'first ever', 'dsh')
  assert.equal(result.entries, 1)
  const after = parseEntries(await fsp.readFile(path.join(home, 'memories', 'USER.md'), 'utf8'))
  assert.deepEqual(after, ['[dsh] first ever'])
  await fsp.rm(home, { recursive: true, force: true })
})

await check('a missing memory file is refused, not created', async () => {
  // A wrong hermesHome must fail loudly. Creating memories/USER.md in a stray
  // directory hides the mistake and writes into a store Hermes never reads.
  const home = await scratchHome()
  await assert.rejects(
    () => addEntry(home, 'user', 'first ever', 'dsh'),
    /does not exist — refusing to create it/u,
  )
  await assert.rejects(
    async () => { await fsp.access(path.join(home, 'memories', 'USER.md')) },
    (error) => error?.code === 'ENOENT',
  )
  await fsp.rm(home, { recursive: true, force: true })
})

await check('charCount counts joined length like Hermes does', () => {
  assert.equal(charCount(['a', 'b']), joinEntries(['a', 'b']).length)
  assert.equal(charCount([]), 0)
})

await check('concurrent writers do not lose entries', async () => {
  const home = await scratchHome()
  await fsp.writeFile(path.join(home, 'memories', 'MEMORY.md'), '', 'utf8')
  // Ten interleaved appends: the version check must retry rather than clobber.
  await Promise.all(
    Array.from({ length: 10 }, (_, index) => addEntry(home, 'memory', `entry ${index}`, 'dsh')),
  )
  const after = parseEntries(await fsp.readFile(path.join(home, 'memories', 'MEMORY.md'), 'utf8'))
  assert.equal(after.length, 10, `expected 10 entries, got ${after.length}: ${after.join(' | ')}`)
  await fsp.rm(home, { recursive: true, force: true })
})

const failed = results.filter((item) => !item.ok)
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok ? '' : `\n        ${item.error}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
