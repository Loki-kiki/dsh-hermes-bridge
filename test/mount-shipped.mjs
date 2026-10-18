/**
 * Mount every row with the config this package actually ships.
 *
 * The gap this closes: unit tests call `resolveConfig({...})` with hand-written
 * values, so they never exercise the exact YAML in `cordis.patch.yml`. That is
 * how `provider: ''` shipped while `optionalString` rejected empty strings — the
 * row could not mount with its own default config, and every unit test passed.
 *
 * The rule: **the shipped config must mount**. If a row's default config fails
 * its own validator, a fresh install is broken for everyone and nothing local
 * notices.
 *
 * Rows that reach for a real backend (viking, provider) are mounted with a stub
 * so this stays offline; the assertion is that `apply()` accepts the config and
 * registers the shape it promises, not that a server answers.
 *
 *   node test/mount-shipped.mjs
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

// A throwaway Hermes home so nothing here reads the real one.
const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'hb-shipped-'))
process.env.HERMES_HOME = scratch
await fsp.mkdir(path.join(scratch, 'memories'), { recursive: true })
await fsp.writeFile(path.join(scratch, 'config.yaml'), 'memory:\n  memory_char_limit: 3500\n  user_char_limit: 2000\n', 'utf8')
await fsp.writeFile(path.join(scratch, 'SOUL.md'), 'persona\n', 'utf8')
await fsp.writeFile(path.join(scratch, 'memories', 'MEMORY.md'), 'a note\n', 'utf8')
await fsp.writeFile(path.join(scratch, 'memories', 'USER.md'), 'a user\n', 'utf8')
await fsp.mkdir(path.join(scratch, 'skills', 'demo'), { recursive: true })
await fsp.writeFile(path.join(scratch, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: demo skill\n---\nbody\n', 'utf8')

const patch = YAML.parse(await fsp.readFile(path.join(root, 'cordis.patch.yml'), 'utf8'))
assert.ok(Array.isArray(patch), 'cordis.patch.yml must be a YAML sequence')
const rows = patch.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : [entry]))

/**
 * A context that records what a row registers and never throws on missing
 * services — the same contract the host gives a plugin.
 */
function fakeContext() {
  const registered = { tools: [], sections: [], providers: 0, routes: [] }
  const logs = []
  const ctx = {
    logger: {
      info: (line) => logs.push(`info ${line}`),
      warn: (line) => logs.push(`warn ${line}`),
      error: (line) => logs.push(`error ${line}`),
    },
    on() {},
    get: () => undefined,
    provide() {},
    inject(_services, fn) {
      fn({
        effect: (fn2) => fn2(),
        tools: { register: (tool) => { registered.tools.push(tool.name); return () => {} } },
        systemPrompt: { section: (section) => { registered.sections.push(section.name); return () => {} } },
        skills: { registerProvider: () => { registered.providers += 1; return { invalidate() {} } } },
        webServer: { register: (route) => { registered.routes.push(route.path); return () => {} } },
      })
    },
  }
  return { ctx, registered, logs }
}

/** Map a row specifier to the module that implements it. */
function moduleFor(spec) {
  if (spec === 'dsh-hermes-bridge') return path.join(root, 'lib', 'index.js')
  const sub = spec.split('/')[1]
  return path.join(root, 'lib', `${sub}.js`)
}

// ── what each row must contribute, so "mounted but useless" fails too ───────
const expectations = {
  'hermes-bridge-persona': (r) => assert.equal(r.sections.length, 1, 'persona must add a prompt section'),
  'hermes-bridge-memory': (r) => assert.equal(r.sections.length, 1, 'memory must add a prompt section'),
  'hermes-bridge-memory-write': (r) => assert.ok(r.tools.includes('memory'), 'memory-write must register the memory tool'),
  'hermes-bridge-skills': (r) => assert.equal(r.providers, 1, 'skills must register a provider'),
  'hermes-bridge-viking': (r) => assert.ok(r.tools.length >= 3, 'viking must register its tools'),
  'hermes-bridge-hermes-data': (r) => assert.ok(r.tools.length >= 3, 'hermes-data must register its read-only tools'),
  'hermes-bridge-settings': (r) => assert.ok(r.routes.length >= 1, 'settings must mount its API prefix'),
  // The provider row needs a Python child process; with a stub home it can only
  // report why it cannot mount. Accepting its config without throwing is the
  // assertion — the live behaviour is covered by test/provider.mjs --live.
  'hermes-bridge-provider': () => {},
  'hermes-bridge-host': () => {},
  'hermes-bridge-mcp': () => {},
}


const results = []
for (const row of rows) {
  const label = row.id
  try {
    const mod = await import(`file:///${moduleFor(row.name).replaceAll('\\', '/')}`)
    assert.equal(typeof mod.apply, 'function', `${row.name} must export apply`)
    const { ctx, registered, logs } = fakeContext()
    // `apply` must never throw: a broken optional backend is a log line, not a
    // profile that refuses to boot.
    await mod.apply(ctx, row.config ?? {})
    const expect = expectations[row.id]
    if (typeof expect === 'function') expect(registered)
    const notes = [
      registered.tools.length > 0 ? `${registered.tools.length} tool(s)` : '',
      registered.sections.length > 0 ? `${registered.sections.length} section(s)` : '',
      registered.providers > 0 ? `${registered.providers} skill provider` : '',
      registered.routes.length > 0 ? `route ${registered.routes.join(',')}` : '',
      row.disabled === true ? 'ships disabled' : '',
    ].filter((part) => part !== '')
    results.push({ label, ok: true, note: notes.join(', ') || 'mounted (registers nothing by design)' })
  } catch (error) {
    const detail = error?.message ?? String(error)
    results.push({ label, ok: false, error: detail })
  }
}

await fsp.rm(scratch, { recursive: true, force: true })

for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok ? ` — ${item.note}` : `\n        ${item.error}`}`)
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} rows accept the config this package ships`)
if (failed.length > 0) {
  console.log('\nA row that cannot mount with its own default config breaks every fresh install.')
  process.exitCode = 1
}
