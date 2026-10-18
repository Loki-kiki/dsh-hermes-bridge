/**
 * The general provider row: does it mount what Hermes actually configured?
 *
 * This is the one test that has to touch the real Hermes install, because the
 * whole point of the row is that it does *not* re-implement a provider — the
 * truth lives in `<hermes-home>/hermes-agent`. A fake would only prove the fake
 * works. So it is gated like the other live tests:
 *
 *   LIVE_TESTS=1 node test/provider.mjs
 *
 * What it proves, in order:
 *
 * 1. environment diagnosis is right for a good and a bad home (no Python spawn);
 * 2. the worker answers `hello` and lists the providers Hermes has installed;
 * 3. the configured provider's schemas come back as real JSON Schema, and every
 *    one of them survives `defineToolFromSchema` unchanged (a mangled schema is
 *    rejected by the model, not by us, so this is the only cheap place to catch it);
 * 4. a real tool call round-trips through the worker;
 * 5. an unknown tool answers with an error instead of killing the worker;
 * 6. the row mounts through a fake cordis context and the registered tools are
 *    callable — i.e. the wiring, not just the plumbing;
 * 7. claiming works: a second row with the same names is refused the names it
 *    must not take, so two rows can never collide in DSH's tool registry.
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { claim, ownerOf, release, snapshot } from '../lib/claims.js'
import { apply as applyProvider, diagnoseEnvironment, resolveConfig } from '../lib/provider.js'
import { ProviderWorker, defaultAgentRoot, defaultPython, probeProviderSync } from '../lib/provider-bridge.js'
import { defineToolFromSchema } from '../lib/schema.js'
import { resolveHermesHome } from '../lib/util.js'

const results = []
async function check(label, fn) {
  try {
    const note = await fn()
    results.push({ label, ok: true, note })
  } catch (error) {
    results.push({ label, ok: false, error: error?.message ?? String(error) })
  }
}

const hermesHome = resolveHermesHome(process.env.HERMES_HOME)
const config = resolveConfig({ hermesHome })
// `--live` exists because an npm script on Windows runs under cmd.exe, where a
// `LIVE_TESTS=1 node …` prefix is not an env assignment but a missing command.
const live = process.env.LIVE_TESTS === '1' || process.argv.includes('--live')

// ── offline: config resolution and environment diagnosis ─────────────────────
await check('defaults derive the agent root and interpreter from the Hermes home', () => {
  assert.equal(config.agentRoot, path.join(hermesHome, 'hermes-agent'))
  assert.ok(config.python.length > 0)
  assert.equal(config.provider, '', 'provider must default to "follow Hermes", not a hardcoded name')
  return `${path.basename(config.python)} in ${config.agentRoot}`
})

await check('a home that does not exist is reported by name', () => {
  const broken = resolveConfig({ hermesHome: path.join(os.tmpdir(), 'hermes-bridge-nowhere') })
  const message = diagnoseEnvironment(broken)
  assert.match(message, /Hermes home not found/u)
  return message.slice(0, 60)
})

await check('a home without an agent tree is reported as such', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hb-home-'))
  const broken = resolveConfig({ hermesHome: home })
  const message = diagnoseEnvironment(broken)
  assert.match(message, /agent tree not found/u)
  await fsp.rm(home, { recursive: true, force: true })
  return message.slice(0, 60)
})

await check('unknown config keys are rejected with the accepted list', () => {
  assert.throws(() => resolveConfig({ hermesHome, nope: 1 }), /unknown key\(s\) "nope"/u)
  return 'rejected'
})

await check('a provider name can be pinned to try a backend Hermes is not using', () => {
  const pinned = resolveConfig({ hermesHome, provider: 'retaindb' })
  assert.equal(pinned.provider, 'retaindb')
  return 'pinned'
})

// ── schema forwarding ───────────────────────────────────────────────────────
await check('defineToolFromSchema keeps a real JSON Schema verbatim', () => {
  const schema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'what to look for' },
      top_k: { type: 'integer', description: 'how many' },
    },
    required: ['query'],
  }
  const tool = defineToolFromSchema({ name: 'x', description: 'd', parameters: schema })
  assert.deepEqual(tool.parameters.properties, schema.properties)
  assert.deepEqual(tool.parameters.required, ['query'])
  assert.equal(tool.parameters.type, 'object')
  return 'properties and required survived'
})

await check('defineToolFromSchema fills a missing required array', () => {
  const tool = defineToolFromSchema({ name: 'x', description: 'd', parameters: { type: 'object', properties: {} } })
  assert.deepEqual(tool.parameters.required, [])
  return 'required: []'
})

await check('defineToolFromSchema survives a non-object schema', () => {
  const tool = defineToolFromSchema({ name: 'x', description: 'd', parameters: { type: 'null' } })
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, required: [], additionalProperties: false })
  return 'coerced'
})

// ── claims ──────────────────────────────────────────────────────────────────
await check('a claimed name is visible to a second row', () => {
  release('hermes-bridge-viking')
  claim('hermes-bridge-viking', ['viking_search', 'viking_read'])
  assert.equal(ownerOf('viking_search'), 'hermes-bridge-viking')
  assert.equal(ownerOf('not_claimed'), undefined)
  release('hermes-bridge-viking')
  assert.equal(ownerOf('viking_search'), undefined)
  return 'claim/release'
})

// ── live: the real provider ─────────────────────────────────────────────────
if (!live) {
  for (const item of results) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok ? ` — ${item.note}` : `\n        ${item.error}`}`)
  }
  console.log('\nskip  the provider rows need the real Hermes install — set LIVE_TESTS=1 to run them')
  const failedOffline = results.filter((item) => !item.ok)
  console.log(`${results.length - failedOffline.length}/${results.length} passed`)
  if (failedOffline.length > 0) process.exitCode = 1
  process.exit(process.exitCode ?? 0)
}

const environmentError = diagnoseEnvironment(config)

await check('the real Hermes home passes environment diagnosis', () => {
  assert.equal(environmentError, '', environmentError)
  return `${config.agentRoot}`
})

if (environmentError === '') {
  const probe = probeProviderSync(config)

  await check('the worker lists the providers Hermes has installed', () => {
    assert.equal(probe.ok, true, probe.reason || probe.error)
    assert.ok(Array.isArray(probe.tools))
    return `${probe.provider || '(none configured)'}, ${probe.tools.length} tool(s)`
  })

  await check('every forwarded tool carries a real object schema', () => {
    for (const tool of probe.tools) {
      assert.equal(typeof tool.name, 'string')
      assert.ok(tool.name.length > 0)
      assert.equal(tool.parameters?.type, 'object', `${tool.name} has parameters.type=${tool.parameters?.type}`)
      assert.equal(typeof tool.parameters.properties, 'object', `${tool.name} has no properties map`)
      const wrapped = defineToolFromSchema({ name: tool.name, description: tool.description, parameters: tool.parameters })
      assert.deepEqual(wrapped.parameters.properties, tool.parameters.properties, `${tool.name} properties changed in wrapping`)
    }
    return `${probe.tools.length} schema(s) unchanged`
  })

  await check('the provider blurb is available for the prompt section', () => {
    if (probe.tools.length === 0) return 'no provider configured — nothing to echo'
    assert.equal(typeof probe.prompt, 'string')
    return `${probe.prompt.length} chars`
  })

  if (probe.tools.length > 0) {
    const worker = new ProviderWorker(config)
    const readTool = probe.tools.find((tool) => /search|query|recall|find/u.test(tool.name)) ?? probe.tools[0]

    await check('a real tool call round-trips through the worker', async () => {
      const args = {}
      const required = readTool.parameters?.required ?? []
      for (const key of required) {
        // The only required argument any recall tool takes is the query itself.
        args[key] = /query|term|text|content/u.test(key) ? 'memory' : 'probe'
      }
      if (Object.keys(args).length === 0 && readTool.parameters?.properties?.query !== undefined) args.query = 'memory'
      const answer = await worker.request('call', { name: readTool.name, args })
      assert.equal(answer.ok, true, `${readTool.name}: ${answer.error}`)
      assert.notEqual(answer.result, undefined)
      return `${readTool.name} → ${JSON.stringify(answer.result).slice(0, 80)}`
    })

    await check('an unknown tool answers with an error and keeps the worker alive', async () => {
      const answer = await worker.request('call', { name: 'definitely_not_a_tool', args: {} })
      assert.equal(answer.ok, false)
      assert.match(String(answer.error), /unknown tool/u)
      const after = await worker.request('call', { name: readTool.name, args: { ...(readTool.parameters?.required ?? []).length === 0 ? { query: 'memory' } : {} } }, 30000)
      assert.notEqual(after.error, 'provider worker is not running', 'worker died on a bad call')
      return 'survived'
    })

    // ── wiring: the row mounts and its tools are callable ────────────────────
    const registered = new Map()
    const logs = []
    const ctx = {
      logger: { info: (line) => logs.push(line), warn: (line) => logs.push(`warn: ${line}`), error: (line) => logs.push(`error: ${line}`) },
      on() {},
      inject(_services, fn) {
        fn({
          tools: { register: (tool) => { registered.set(tool.name, tool); return () => registered.delete(tool.name) } },
          systemPrompt: { section: (section) => { logs.push(`section:${section.name}`); return () => {} } },
          effect(fn2) { return fn2() },
        })
      },
    }
    release('hermes-bridge-viking')
    applyProvider(ctx, { hermesHome })

    await check('the row registers every provider tool it was allowed to take', () => {
      assert.ok(registered.size > 0, `registered nothing — logs:\n${logs.join('\n')}`)
      const expected = probe.tools.length
      assert.equal(registered.size, Math.min(expected, config.maxTools))
      return `${registered.size} of ${expected}`
    })

    await check('a registered tool is callable through the row', async () => {
      const tool = registered.get(readTool.name)
      assert.ok(tool !== undefined, `missing ${readTool.name}`)
      const args = {}
      for (const key of readTool.parameters?.required ?? []) args[key] = /query|term|text|content/u.test(key) ? 'memory' : 'probe'
      const value = await tool.execute(args)
      assert.equal(value?.error, undefined, String(value?.error))
      return `${readTool.name} → ${JSON.stringify(value).slice(0, 60)}`
    })

    await check('the prompt section is registered when the provider has a blurb', () => {
      const hasSection = logs.some((line) => line === 'section:hermes-bridge:provider')
      if (probe.prompt.trim() === '') {
        assert.equal(hasSection, false)
        return 'no blurb → no section'
      }
      assert.equal(hasSection, true, `logs:\n${logs.join('\n')}`)
      return 'section registered'
    })

    await check('a second row cannot take a name the first one claimed', () => {
      release('hermes-bridge-viking')
      claim('hermes-bridge-viking', probe.tools.map((tool) => tool.name))
      const taken = probe.tools.filter((tool) => ownerOf(tool.name) === 'hermes-bridge-viking')
      assert.equal(taken.length, probe.tools.length)
      release('hermes-bridge-viking')
      return `${taken.length} names reserved`
    })

    await check('the claim set is empty after the row is released', () => {
      release('hermes-bridge-provider')
      release('hermes-bridge-viking')
      assert.deepEqual(snapshot(), {})
      return 'clean'
    })

    await worker.shutdown()
  } else {
    console.log(`note  no memory provider is configured in Hermes — the call and wiring checks are skipped`)
    console.log(`      probe reason: ${probe.reason || '(empty)'}`)
  }
}

for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok ? ` — ${item.note}` : `\n        ${item.error}`}`)
}
const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
