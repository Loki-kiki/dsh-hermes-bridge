/**
 * Offline tests for the settings backend. No DSH, no HTTP server: every function
 * is called directly against a throwaway profile directory, so a failure points
 * at the logic rather than at the harness.
 *
 * Run: node test/settings.mjs
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'hb-settings-'))
process.env.DSH_HOME = path.join(scratch, 'dsh')
process.env.HERMES_HOME = path.join(scratch, 'hermes')

const settings = await import('../lib/settings.js')

let passed = 0
let failed = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`ok   ${label}`)
    passed += 1
  } catch (error) {
    console.log(`FAIL ${label} — ${error.message}`)
    failed += 1
  }
}
const checkAsync = async (label, fn) => {
  try {
    await fn()
    console.log(`ok   ${label}`)
    passed += 1
  } catch (error) {
    console.log(`FAIL ${label} — ${error.message}`)
    failed += 1
  }
}

/** A profile whose patch file has comments, other rows, and one override. */
const PROFILE = 'unit'
const profileDir = path.join(process.env.DSH_HOME, 'profiles', PROFILE)
await fsp.mkdir(profileDir, { recursive: true })

const ORIGINAL_PATCH = `# my own header comment
- id: someone-elses-row
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: whatever

# a comment attached to this override
- id: hermes-bridge-skills
  disabled: true

- id: another-row
  disabled: false
`
const patchFile = path.join(profileDir, 'cordis.patch.yml')
await fsp.writeFile(patchFile, ORIGINAL_PATCH, 'utf8')

// ── row state reading ───────────────────────────────────────────────────────
await checkAsync('readRowStates reads the override that exists', async () => {
  const states = await settings.readRowStates(PROFILE)
  assert.equal(states['hermes-bridge-skills'].enabled, false)
  assert.equal(states['hermes-bridge-skills'].overridden, true)
  assert.equal(states['hermes-bridge-persona'].enabled, true)
  assert.equal(states['hermes-bridge-persona'].overridden, false)
})

// ── flipping a row that already has an override ─────────────────────────────
await checkAsync('enabling an existing override flips it in place', async () => {
  const result = await settings.writeRowEnabled(PROFILE, 'hermes-bridge-skills', true)
  assert.equal(result.changed, true)
  const text = await fsp.readFile(patchFile, 'utf8')
  assert.match(text, /hermes-bridge-skills[\s\S]*?disabled: false/, 'the override must now say false')
  const states = await settings.readRowStates(PROFILE)
  assert.equal(states['hermes-bridge-skills'].enabled, true)
})

await checkAsync('comments and unrelated rows survive the edit', async () => {
  const text = await fsp.readFile(patchFile, 'utf8')
  assert.match(text, /# my own header comment/)
  assert.match(text, /# a comment attached to this override/)
  assert.match(text, /someone-elses-row/)
  assert.match(text, /another-row/)
  // The file must still be exactly one YAML document with three entries.
  const parsed = YAML.parse(text)
  assert.ok(Array.isArray(parsed), 'patch must stay a YAML sequence')
  assert.equal(parsed.length, 3)
})

// ── flipping a row that has no override yet ─────────────────────────────────
await checkAsync('disabling a row with no override appends one', async () => {
  const result = await settings.writeRowEnabled(PROFILE, 'hermes-bridge-viking', false)
  assert.equal(result.changed, true)
  const parsed = YAML.parse(await fsp.readFile(patchFile, 'utf8'))
  const added = parsed.find((row) => row.id === 'hermes-bridge-viking')
  assert.ok(added, 'a row must have been appended')
  assert.equal(added.disabled, true)
  assert.equal(parsed.length, 4)
})

await checkAsync('enabling a row with no override writes nothing', async () => {
  const before = await fsp.readFile(patchFile, 'utf8')
  const result = await settings.writeRowEnabled(PROFILE, 'hermes-bridge-memory', true)
  assert.equal(result.changed, false)
  assert.equal(await fsp.readFile(patchFile, 'utf8'), before)
})

await checkAsync('flipping to the value it already has writes nothing', async () => {
  const before = await fsp.readFile(patchFile, 'utf8')
  const result = await settings.writeRowEnabled(PROFILE, 'hermes-bridge-viking', false)
  assert.equal(result.changed, false)
  assert.equal(await fsp.readFile(patchFile, 'utf8'), before)
})

await checkAsync('an unknown row id is refused by name', async () => {
  await assert.rejects(
    () => settings.writeRowEnabled(PROFILE, 'not-a-row', true),
    /unknown row/,
  )
})

// ── a profile whose patch file is the empty flow array ──────────────────────
await checkAsync('an empty [] patch can take a new row', async () => {
  const emptyDir = path.join(process.env.DSH_HOME, 'profiles', 'empty')
  await fsp.mkdir(emptyDir, { recursive: true })
  await fsp.writeFile(path.join(emptyDir, 'cordis.patch.yml'), '[]\n', 'utf8')
  const result = await settings.writeRowEnabled('empty', 'hermes-bridge-persona', false)
  assert.equal(result.changed, true)
  const parsed = YAML.parse(await fsp.readFile(path.join(emptyDir, 'cordis.patch.yml'), 'utf8'))
  assert.ok(Array.isArray(parsed), 'must be a sequence, not two documents')
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].id, 'hermes-bridge-persona')
})

await checkAsync('a missing patch file is created as a sequence', async () => {
  const result = await settings.writeRowEnabled('nofile', 'hermes-bridge-mcp', false)
  assert.equal(result.changed, true)
  const parsed = YAML.parse(await fsp.readFile(path.join(process.env.DSH_HOME, 'profiles', 'nofile', 'cordis.patch.yml'), 'utf8'))
  assert.ok(Array.isArray(parsed))
  assert.equal(parsed[0].id, 'hermes-bridge-mcp')
})

// ── skill state round-trip ─────────────────────────────────────────────────
await checkAsync('skill state defaults to nothing disabled', async () => {
  const state = await settings.readSkillState(path.join(scratch, 'missing.json'))
  assert.deepEqual(state.disabled, [])
})

await checkAsync('skill state round-trips and dedupes', async () => {
  const file = path.join(scratch, 'skills.json')
  await settings.writeSkillState(file, ['b-skill', 'a-skill', 'b-skill'])
  const state = await settings.readSkillState(file)
  assert.deepEqual(state.disabled, ['a-skill', 'b-skill'])
})

await checkAsync('a corrupt skill state reads as empty, never throws', async () => {
  const file = path.join(scratch, 'corrupt.json')
  await fsp.writeFile(file, '{not json', 'utf8')
  const state = await settings.readSkillState(file)
  assert.deepEqual(state.disabled, [])
})

// ── skip list actually removes skills from discovery ───────────────────────
await checkAsync('skipNames removes a skill without counting it as broken', async () => {
  const root = path.join(scratch, 'hermes', 'skills', 'cat')
  await fsp.mkdir(path.join(root, 'alpha-skill'), { recursive: true })
  await fsp.mkdir(path.join(root, 'beta-skill'), { recursive: true })
  await fsp.writeFile(path.join(root, 'alpha-skill', 'SKILL.md'), '---\nname: alpha-skill\ndescription: first\n---\nbody\n', 'utf8')
  await fsp.writeFile(path.join(root, 'beta-skill', 'SKILL.md'), '---\nname: beta-skill\ndescription: second\n---\nbody\n', 'utf8')
  const { discoverSkills } = await import('../lib/skills.js')
  const all = await discoverSkills({ root: path.join(scratch, 'hermes', 'skills') })
  assert.equal(all.candidates.length, 2)
  const filtered = await discoverSkills({ root: path.join(scratch, 'hermes', 'skills'), skipNames: ['alpha-skill'] })
  assert.equal(filtered.candidates.length, 1)
  assert.equal(filtered.candidates[0].name, 'beta-skill')
  assert.equal(filtered.rejected.length, 0, 'a switched-off skill is not a broken skill')
})

// ── status document shape ──────────────────────────────────────────────────
await checkAsync('buildStatus assembles every section the page reads', async () => {
  const hermesHome = process.env.HERMES_HOME
  await fsp.mkdir(path.join(hermesHome, 'memories'), { recursive: true })
  await fsp.writeFile(path.join(hermesHome, 'SOUL.md'), 'a persona from hermes\n', 'utf8')
  await fsp.writeFile(path.join(hermesHome, 'memories', 'MEMORY.md'), '记忆正文\n', 'utf8')
  await fsp.writeFile(path.join(hermesHome, 'memories', 'USER.md'), '用户画像\n', 'utf8')
  await fsp.writeFile(path.join(hermesHome, 'config.yaml'), YAML.stringify({
    memory: { provider: 'openviking', openviking: { endpoint: 'http://127.0.0.1:1933' } },
    plugins: { disabled: ['openviking'] },
    mcp_servers: { rea: {} },
  }), 'utf8')

  const status = await settings.buildStatus({ hermesHome: '', vikingEndpoint: 'http://127.0.0.1:9' }, PROFILE)
  assert.equal(status.profile, PROFILE)
  assert.equal(status.rows.length, settings.ROWS.length)
  assert.ok(status.rows.length >= 7, `expected every row, got ${status.rows.length}`)
  // The two new rows must be reported, or the page cannot toggle them.
  const ids = status.rows.map(row => row.id)
  assert.ok(ids.includes('hermes-bridge-memory-write'), ids.join(', '))
  assert.ok(ids.includes('hermes-bridge-hermes-data'), ids.join(', '))
  assert.equal(status.files.length, 6)
  assert.equal(status.hermes.memoryProvider, 'openviking')
  assert.deepEqual(status.hermes.pluginsDisabled, ['openviking'])
  assert.deepEqual(status.hermes.mcpServers, ['rea'])
  assert.equal(status.viking.reachable, false, 'a dead port must read as unreachable, not throw')
  assert.match(status.preview.persona, /a persona from hermes/)
  assert.match(status.preview.memory, /记忆正文/)
  assert.match(status.preview.memory, /用户画像/)
  // Untagged entries read as assumed-Hermes, so the origins bar has something to
  // show even before anything is tagged.
  assert.equal(status.memoryOrigins.memory.total, 1)
  assert.equal(status.memoryOrigins.memory.assumed, 1)
  assert.equal(status.memoryOrigins.memory.dsh, 0)
  assert.ok(status.memoryOrigins.memory.limit > 0, 'limit must come from config, not zero')
  assert.ok(status.patchPath.endsWith('cordis.patch.yml'))
})

await checkAsync('buildSkillInventory reports per-skill enable state', async () => {
  const stateFile = path.join(process.env.DSH_HOME, 'profiles', PROFILE, 'hermes-bridge-skills.json')
  await settings.writeSkillState(stateFile, ['alpha-skill'])
  const inventory = await settings.buildSkillInventory({ hermesHome: '', skillStateFile: stateFile }, PROFILE, 100)
  const alpha = inventory.skills.find((entry) => entry.name === 'alpha-skill')
  const beta = inventory.skills.find((entry) => entry.name === 'beta-skill')
  assert.equal(alpha.enabled, false)
  assert.equal(beta.enabled, true)
  assert.deepEqual(inventory.disabled, ['alpha-skill'])
})

// ── config read/write (the writable settings page) ─────────────────────────
await checkAsync('readRowConfigs layers package defaults under the profile patch', async () => {
  const configs = await settings.readRowConfigs(PROFILE)
  // The scratch HERMES_HOME fixture counts as a Hermes home for probing.
  assert.equal(configs['hermes-bridge-viking'].user !== undefined, true, 'viking defaults must come from the bundle patch layer')
})

await checkAsync('writeRowConfig fans hermesHome out to every bridge row', async () => {
  const home = process.env.HERMES_HOME
  const result = await settings.writeRowConfig(PROFILE, 'hermesHome', home)
  assert.equal(result.rows.length, 8, `expected all 8 rows, got ${result.rows.length}`)
  const text = await fsp.readFile(patchFile, 'utf8')
  assert.match(text, /hermes-bridge-persona[\s\S]*?hermesHome:/)
  const parsed = YAML.parse(text)
  for (const row of parsed) {
    if (typeof row?.id === 'string' && row.id.startsWith('hermes-bridge-') && !row.id.includes('host')) {
      assert.equal(row.config?.hermesHome, home, `${row.id} must carry the override`)
    }
  }
})

await checkAsync('writeRowConfig refuses a nonexistent hermesHome', async () => {
  await assert.rejects(
    () => settings.writeRowConfig(PROFILE, 'hermesHome', path.join(scratch, 'no-such-dir')),
    /does not exist/,
  )
})

await checkAsync('writeRowConfig with empty value clears the override', async () => {
  await settings.writeRowConfig(PROFILE, 'hermesHome', process.env.HERMES_HOME)
  const result = await settings.writeRowConfig(PROFILE, 'hermesHome', '')
  assert.equal(result.rows.length, 8)
  const parsed = YAML.parse(await fsp.readFile(patchFile, 'utf8'))
  for (const row of parsed) {
    if (typeof row?.id === 'string' && row.id.startsWith('hermes-bridge-') && !row.id.includes('host')) {
      assert.equal(row.config?.hermesHome, undefined, `${row.id} override must be gone`)
    }
  }
})

await checkAsync('writeRowConfig rejects an unknown key by name', async () => {
  await assert.rejects(
    () => settings.writeRowConfig(PROFILE, 'bogus', 'x'),
    /unknown config key/,
  )
})

await checkAsync('probeHermes recognizes a real home and rejects a missing one', async () => {
  const hit = await settings.probeHermes(process.env.HERMES_HOME)
  assert.equal(hit.exists, true)
  assert.equal(hit.looksLikeHermes, true)
  const miss = await settings.probeHermes(path.join(scratch, 'nope'))
  assert.equal(miss.exists, false)
  assert.equal(miss.looksLikeHermes, false)
})

await checkAsync('buildStatus carries setup guidance and the mcp roster', async () => {
  const status = await settings.buildStatus({ hermesHome: '', vikingEndpoint: 'http://127.0.0.1:9' }, PROFILE)
  assert.equal(status.setup.hermesFound, true, 'the fixture home must probe as found')
  assert.equal(typeof status.mcp.mounted, 'number')
  assert.equal(Array.isArray(status.mcp.hermesServers), true)
  assert.equal(typeof status.config['hermes-bridge-viking'], 'object', 'row configs must be prefilled')
})

await checkAsync('syncProfile honors an explicit hermesHome', async () => {
  const { syncProfile } = await import('../lib/mcp-sync.js')
  // The fixture config.yaml has one server (rea) but no url/command: the sync
  // must still resolve hermesHome correctly rather than reading the real home.
  const result = syncProfile({ profile: PROFILE, hermesHome: process.env.HERMES_HOME })
  assert.equal(result.ok, true)
  assert.ok(Array.isArray(result.warnings))
})

await fsp.rm(scratch, { recursive: true, force: true })

console.log('')
if (failed > 0) {
  console.log(`${failed} failed, ${passed} passed`)
  process.exitCode = 1
} else {
  console.log(`all ${passed} settings tests passed`)
}
