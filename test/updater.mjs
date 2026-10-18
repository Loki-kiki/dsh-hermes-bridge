/**
 * Offline tests for the updater row.
 *
 * Everything here runs without network and without DSH: version comparison is
 * pure, config resolution is pure, and the network/install paths are exercised
 * through injected failures rather than by hitting GitHub. The one thing that
 * *must* be tested against a real value is `selfInfo()`, because it reads this
 * package's own manifest — a wrong path there means the updater compares against
 * the wrong version forever.
 *
 *   node test/updater.mjs
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const updater = await import('../lib/updater.js')

let passed = 0
let failed = 0
const check = async (label, fn) => {
  try {
    const note = await fn()
    console.log(`PASS  ${label}${note === undefined ? '' : ` — ${note}`}`)
    passed += 1
  } catch (error) {
    console.log(`FAIL  ${label}\n        ${error?.message ?? error}`)
    failed += 1
  }
}

// ── version comparison ─────────────────────────────────────────────────────
await check('a newer patch version is detected', () => {
  assert.ok(updater.compareVersions('0.2.1', '0.2.0') > 0)
  assert.ok(updater.compareVersions('0.2.0', '0.2.1') < 0)
  assert.equal(updater.compareVersions('0.2.0', '0.2.0'), 0)
})

await check('numeric parts compare as numbers, not strings', () => {
  // "0.10.0" < "0.9.0" is the classic string-comparison bug.
  assert.ok(updater.compareVersions('0.10.0', '0.9.0') > 0)
  assert.ok(updater.compareVersions('0.9.0', '0.10.0') < 0)
  assert.ok(updater.compareVersions('1.0.0', '0.99.99') > 0)
})

await check('a prerelease is older than its release', () => {
  assert.ok(updater.compareVersions('1.0.0-rc.1', '1.0.0') < 0)
  assert.ok(updater.compareVersions('1.0.0', '1.0.0-rc.1') > 0)
  assert.ok(updater.compareVersions('1.0.0-rc.2', '1.0.0-rc.1') > 0)
})

await check('a leading v and surrounding spaces are tolerated', () => {
  assert.equal(updater.compareVersions(' v1.2.3 ', '1.2.3'), 0)
})

await check('an unparseable version compares as equal rather than throwing', () => {
  // A malformed remote manifest must not crash the settings page.
  assert.equal(updater.compareVersions('not-a-version', '0.2.0'), 0)
  assert.equal(updater.compareVersions('0.2.0', ''), 0)
})

// ── config ─────────────────────────────────────────────────────────────────
await check('defaults are usable with no config at all', () => {
  const config = updater.resolveConfig({})
  assert.equal(config.repo, 'Loki-kiki/dsh-hermes-bridge')
  assert.equal(config.branch, 'main')
  assert.equal(config.intervalHours, 6)
  assert.equal(config.autoCheck, true)
  // Auto-install replaces running code, so it must be opt-in.
  assert.equal(config.autoInstall, false)
})

await check('the shipped config validates', async () => {
  // Same rule as the other rows: the YAML this package ships must be acceptable.
  const patch = YAML.parse(await fsp.readFile(path.join(root, 'cordis.patch.yml'), 'utf8'))
  const rows = patch.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : [entry]))
  const row = rows.find((entry) => entry.id === 'hermes-bridge-updater')
  assert.ok(row, 'the updater row must exist in cordis.patch.yml')
  const config = updater.resolveConfig(row.config ?? {})
  assert.equal(config.intervalHours, 6)
  assert.equal(config.autoCheck, true)
  return `${config.repo}@${config.branch}, ${config.intervalHours}h`
})

await check('a malformed repo is refused with the expected shape', () => {
  assert.throws(() => updater.resolveConfig({ repo: 'just-a-name' }), /owner\/name/u)
  assert.throws(() => updater.resolveConfig({ repo: 'a/b/c' }), /owner\/name/u)
})

await check('a non-positive interval is refused', () => {
  assert.throws(() => updater.resolveConfig({ intervalHours: 0 }), /must be positive/u)
  assert.throws(() => updater.resolveConfig({ intervalHours: -3 }), /must be positive/u)
})

await check('unknown keys are refused by name', () => {
  assert.throws(() => updater.resolveConfig({ bogus: true }), /bogus/u)
})

// ── selfInfo ───────────────────────────────────────────────────────────────
await check('selfInfo finds this package and its real version', async () => {
  const self = await updater.selfInfo()
  const manifest = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(self.version, manifest.version, 'must read the version the updater compares against')
  assert.equal(self.name, manifest.name)
  // The directory must be the package root, not lib/ — resolving one level short
  // would make every version check compare against a missing manifest.
  assert.equal(path.resolve(self.dir), path.resolve(root))
  return `${self.name}@${self.version}`
})

// ── fetchRemoteVersion against a stubbed fetch ─────────────────────────────
/** Replace global fetch for the duration of a test. */
async function withFetch(impl, fn) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

const baseConfig = updater.resolveConfig({})

await check('a good response yields the remote version and an etag', async () => {
  const result = await withFetch(
    async () => new Response(JSON.stringify({ version: '9.9.9' }), { status: 200, headers: { etag: 'W/"abc"' } }),
    () => updater.fetchRemoteVersion(baseConfig),
  )
  assert.equal(result.ok, true)
  assert.equal(result.version, '9.9.9')
  assert.equal(result.etag, 'W/"abc"')
})

await check('a 304 reports not-modified instead of a version', async () => {
  // `new Response('', {status:304})` throws in undici: 304 is a null-body
  // status. The stub has to use null or the test fails for a reason that has
  // nothing to do with the code under test.
  const result = await withFetch(
    async () => new Response(null, { status: 304 }),
    () => updater.fetchRemoteVersion(baseConfig, 'W/"abc"'),
  )
  assert.equal(result.ok, true)
  assert.equal(result.notModified, true)
})

await check('an HTTP error is reported, never thrown', async () => {
  const result = await withFetch(
    async () => new Response('nope', { status: 503 }),
    () => updater.fetchRemoteVersion(baseConfig),
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /503/u)
})

await check('a non-JSON body is reported, never thrown', async () => {
  const result = await withFetch(
    async () => new Response('<html>rate limited</html>', { status: 200 }),
    () => updater.fetchRemoteVersion(baseConfig),
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /did not return JSON/u)
})

await check('a manifest without a version is reported', async () => {
  const result = await withFetch(
    async () => new Response(JSON.stringify({ name: 'x' }), { status: 200 }),
    () => updater.fetchRemoteVersion(baseConfig),
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /no version/u)
})

await check('a network failure is reported as an error string', async () => {
  const result = await withFetch(
    async () => { throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com') },
    () => updater.fetchRemoteVersion(baseConfig),
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /ENOTFOUND/u)
})

await check('the etag is sent back as if-none-match', async () => {
  let seen
  await withFetch(
    async (_url, options) => {
      seen = options.headers
      return new Response('{}', { status: 200 })
    },
    () => updater.fetchRemoteVersion(baseConfig, 'W/"xyz"'),
  )
  assert.equal(seen['if-none-match'], 'W/"xyz"')
  assert.ok(seen['user-agent'].includes('updater'), 'GitHub wants a user agent')
})

// ── the row's state machine ────────────────────────────────────────────────
/**
 * Mount the row against a fake context, the way DSH would.
 * @param {object} [overrides] - row config overrides.
 * @returns {Promise<{updater: object, services: Map<string, unknown>, logs: string[]}>} mount result.
 */
async function mountRow(overrides = {}) {
  const services = new Map()
  const logs = []
  const scope = { effect: (fn) => { const stop = fn(); return () => stop?.() } }
  const ctx = {
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line), error: (line) => logs.push(line) },
    provide: (name, value) => { services.set(name, value) },
    get: (name) => services.get(name),
    inject: (_deps, fn) => fn(scope),
  }
  updater.apply(ctx, overrides)
  return { updater: services.get('hermesBridgeUpdater'), services, logs }
}

await check('the row publishes its controller and logs what it watches', async () => {
  const { updater: controller, logs } = await mountRow()
  assert.ok(controller, 'must provide hermesBridgeUpdater')
  assert.equal(typeof controller.check, 'function')
  assert.equal(typeof controller.install, 'function')
  assert.equal(typeof controller.snapshot, 'function')
  assert.ok(logs.some((line) => line.includes('updater:')), 'must announce itself')
  return logs.find((line) => line.includes('watching'))
})

await check('a snapshot reports the running version before any check', async () => {
  const { updater: controller } = await mountRow()
  const snapshot = await controller.snapshot()
  const manifest = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(snapshot.currentVersion, manifest.version)
  assert.equal(snapshot.updateAvailable, false, 'nothing known yet means no update')
  assert.equal(snapshot.checkedAt, 0)
})

await check('check() records an update when the remote is newer', async () => {
  const { updater: controller } = await mountRow()
  await withFetch(
    async () => new Response(JSON.stringify({ version: '99.0.0' }), { status: 200 }),
    () => controller.check(true),
  )
  const snapshot = await controller.snapshot()
  assert.equal(snapshot.remoteVersion, '99.0.0')
  assert.equal(snapshot.updateAvailable, true)
  assert.ok(snapshot.checkedAt > 0)
})

await check('check() does not claim an update when the remote is the same', async () => {
  const { updater: controller } = await mountRow()
  const manifest = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'))
  await withFetch(
    async () => new Response(JSON.stringify({ version: manifest.version }), { status: 200 }),
    () => controller.check(true),
  )
  const snapshot = await controller.snapshot()
  assert.equal(snapshot.updateAvailable, false)
})

await check('a failed check leaves the page usable, with the error recorded', async () => {
  const { updater: controller } = await mountRow()
  const snapshot = await withFetch(
    async () => { throw new Error('offline') },
    () => controller.check(true),
  )
  assert.match(snapshot.error, /offline/u)
  assert.equal(snapshot.phase, 'idle', 'a failed check must not leave the row stuck in "checking"')
  assert.equal(snapshot.updateAvailable, false)
})

await check('install() without a known version refuses instead of guessing', async () => {
  const { updater: controller } = await mountRow()
  await assert.rejects(() => controller.install(), /no target version/u)
})

await check('install() refuses when the profile directory is unknown', async () => {
  // No profileContext service in this fake ctx: the row cannot know where pnpm
  // should run, so it must say so rather than run pnpm in the process cwd.
  const { updater: controller } = await mountRow()
  await withFetch(
    async () => new Response(JSON.stringify({ version: '99.0.0' }), { status: 200 }),
    () => controller.check(true),
  )
  await assert.rejects(() => controller.install(), /profile directory/u)
})

await check('install() reports a link: install instead of pretending to update', async () => {
  // A `link:` dependency points at a working copy; pnpm cannot update it, and
  // silently running `pnpm add name@version` would replace the link with a
  // registry copy — destroying the developer's setup.
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'hb-updater-'))
  await fsp.writeFile(path.join(profile, 'package.json'), JSON.stringify({
    name: 'probe',
    dependencies: { 'dsh-hermes-bridge': 'link:E:/somewhere/else' },
  }), 'utf8')
  const services = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    provide: (name, value) => services.set(name, value),
    get: (name) => (name === 'profileContext' ? { dir: profile, name: 'probe' } : services.get(name)),
    inject: (_deps, fn) => fn({ effect: (fn2) => { fn2() } }),
  }
  updater.apply(ctx, {})
  const controller = services.get('hermesBridgeUpdater')
  await withFetch(
    async () => new Response(JSON.stringify({ version: '99.0.0' }), { status: 200 }),
    () => controller.check(true),
  )
  const snapshot = await controller.install()
  assert.equal(snapshot.lastInstall.ok, false)
  assert.match(snapshot.lastInstall.error, /local link/u)
  assert.equal(snapshot.lastInstall.reload.applied, false)
  await fsp.rm(profile, { recursive: true, force: true })
  return 'link installs are reported, not overwritten'
})

await check('a successful install reports whether the reload was applied', async () => {
  // The reload result is the field that decides what the UI tells the user, so
  // both branches must be reachable. Here HMR is absent → "needs restart".
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'hb-updater2-'))
  await fsp.writeFile(path.join(profile, 'package.json'), JSON.stringify({
    name: 'probe',
    dependencies: { 'dsh-hermes-bridge': '^0.2.0' },
  }), 'utf8')
  const services = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    provide: (name, value) => services.set(name, value),
    // No `hmr` service: this is the "HMR unavailable" branch.
    get: (name) => (name === 'profileContext' ? { dir: profile, name: 'probe' } : services.get(name)),
    inject: (_deps, fn) => fn({ effect: (fn2) => { fn2() } }),
  }
  updater.apply(ctx, {})
  const controller = services.get('hermesBridgeUpdater')
  const snapshot = await controller.install('99.0.0')
  // pnpm is either missing or fails against a fake profile; either way the row
  // must report the failure instead of claiming success.
  assert.equal(snapshot.lastInstall.target, '99.0.0')
  if (snapshot.lastInstall.ok === false) {
    assert.equal(snapshot.lastInstall.reload.applied, false, 'a failed install must not reload')
  }
  await fsp.rm(profile, { recursive: true, force: true })
  return snapshot.lastInstall.ok ? 'install succeeded (pnpm present)' : `install failed as expected: ${String(snapshot.lastInstall.error).slice(0, 60)}`
})

await check('pnpm diagnostics are decoded, not shown as mojibake', async () => {
  // On a Chinese Windows the child writes GBK. Reading it as UTF-8 produced a
  // row of U+FFFD, which is exactly the text the user needs to read. The fix
  // detects encoding by round-trip, so this asserts the outcome rather than the
  // mechanism: the failure string must be readable.
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'hb-updater3-'))
  await fsp.writeFile(path.join(profile, 'package.json'), JSON.stringify({
    name: 'probe',
    dependencies: { 'dsh-hermes-bridge': '^0.2.0' },
  }), 'utf8')
  const services = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    provide: (name, value) => services.set(name, value),
    get: (name) => (name === 'profileContext' ? { dir: profile, name: 'probe' } : services.get(name)),
    inject: (_deps, fn) => fn({ effect: (fn2) => { fn2() } }),
  }
  updater.apply(ctx, {})
  const controller = services.get('hermesBridgeUpdater')
  const snapshot = await controller.install('99.0.0')
  await fsp.rm(profile, { recursive: true, force: true })
  if (snapshot.lastInstall.ok === true) return 'pnpm present; nothing to decode'
  const error = String(snapshot.lastInstall.error)
  assert.ok(error.length > 0, 'a failed install must explain itself')
  assert.ok(!error.includes('\uFFFD'), `diagnostics must not be mojibake: ${error}`)
  return error.slice(0, 70)
})

console.log(`\n${passed}/${passed + failed} passed`)
if (failed > 0) process.exitCode = 1
