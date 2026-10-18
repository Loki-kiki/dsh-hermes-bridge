/**
 * `hermes-bridge/settings` — the data half behind the settings page.
 *
 * Serves one JSON document describing what the bridge currently sees: the
 * Hermes home, every file it reads with real sizes and mtimes, the skill
 * inventory (with per-skill enable state), the MCP roster, the OpenViking
 * endpoint health. The browser half renders it; nothing here is cached, because
 * a settings page whose numbers are stale is worse than no settings page.
 *
 * Three write paths, all narrow:
 *
 * - `POST /toggles` — flip one of the seven row switches. It edits the profile's
 *   `cordis.patch.yml` the same way DSH's own plugin manager does (yaml
 *   Document in, comment-preserving, atomic rename), and `dsh-hmr` recomposes
 *   the profile on its own file watch. No restart.
 * - `POST /skills` — enable/disable individual skills. This is *not* a row
 *   switch: the skill provider re-reads its skip list on every `list()` and the
 *   registration control's `invalidate()` drops the catalog cache, so the change
 *   lands on the next turn.
 * - `POST /config` — write the bridge-level knobs a first-time user needs
 *   (chiefly `hermesHome`, plus the OpenViking endpoint/identity). Written to
 *   every bridge row that reads the key, so the rows cannot drift apart; the
 *   same hot-recompose picks it up. `POST /mcp/sync` re-runs the CLI's sync
 *   against the resolved home, and `GET /probe-hermes` checks a candidate path
 *   before anything is written.
 *
 * @module dsh-hermes-bridge/settings
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { ConfigError, optionalString, rejectUnknownKeys, report } from './util.js'
import { readTarget } from './memory-store.js'

export const name = 'hermes-bridge/settings'

const KNOWN_KEYS = ['hermesHome', 'stateFile', 'skillStateFile', 'profile', 'vikingEndpoint', 'skillPreviewLimit']

/** Row ids this bundle owns, in the order the page shows them. */
export const ROWS = [
  'hermes-bridge-persona',
  'hermes-bridge-memory',
  'hermes-bridge-memory-write',
  'hermes-bridge-skills',
  'hermes-bridge-viking',
  'hermes-bridge-mcp',
  'hermes-bridge-hermes-data',
]

/**
 * Resolve this row's configuration.
 * @param {Record<string, unknown>} raw - row config from cordis.
 * @returns {object} resolved config.
 */
function resolveConfig(raw) {
  const config = raw ?? {}
  rejectUnknownKeys('settings', config, KNOWN_KEYS)
  return {
    hermesHome: optionalString('settings', config, 'hermesHome', ''),
    profile: optionalString('settings', config, 'profile', ''),
    vikingEndpoint: optionalString('settings', config, 'vikingEndpoint', 'http://127.0.0.1:1933').replace(/\/+$/, ''),
    skillPreviewLimit: Number(config.skillPreviewLimit ?? 8),
  }
}

/**
 * The DSH data root (`~/.dsh`), honoring an override so a test profile can be
 * driven without touching the real one.
 * @returns {string} absolute path.
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/**
 * Path of a profile's patch layer.
 * @param {string} profile - profile name.
 * @returns {string} absolute path.
 */
function patchPathOf(profile) {
  return path.join(dshHome(), 'profiles', profile, 'cordis.patch.yml')
}

/**
 * Hermes home, resolved the way Hermes itself does.
 * @param {string} override - row config value, if any.
 * @returns {string} absolute path.
 */
function hermesHomeOf(override) {
  if (override !== '') return expandHome(override)
  const fromEnv = process.env.HERMES_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return expandHome(fromEnv.trim())
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'hermes')
  }
  return path.join(os.homedir(), '.hermes')
}

/**
 * Expand a leading `~` so a user-typed path works the same way on every row.
 * Plain string replacement elsewhere in this bundle left `~/hermes` relative.
 * @param {string} value - raw path.
 * @returns {string} absolute path, or the input when it is not `~`-relative.
 */
export function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

/**
 * Stat a path without throwing, and describe a file the page can show.
 * @param {string} file - absolute path.
 * @param {string} label - display label.
 * @param {string} role - why this file matters.
 * @returns {Promise<object>} descriptor with `exists`, `bytes`, `mtime`.
 */
async function describeFile(file, label, role) {
  try {
    const stat = await fsp.stat(file)
    return { label, role, path: file, exists: true, bytes: stat.size, mtime: stat.mtimeMs, directory: stat.isDirectory() }
  } catch {
    return { label, role, path: file, exists: false, bytes: 0, mtime: 0, directory: false }
  }
}

/**
 * Read the current enablement of every row this bundle owns.
 *
 * A row's state is not simply "is it in the patch file": the patch may override
 * a row that a bundle already declared. So the effective value is the last
 * `disabled` written for that id, defaulting to enabled when absent.
 *
 * @param {string} profile - profile name.
 * @returns {Promise<Record<string, {enabled: boolean, overridden: boolean}>>} per-row state.
 */
async function readRowStates(profile) {
  const file = patchPathOf(profile)
  const states = Object.fromEntries(ROWS.map((id) => [id, { enabled: true, overridden: false }]))
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch {
    return states
  }
  const document = YAML.parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }] })
  if (document.errors.length > 0) throw new ConfigError('settings', `cannot parse ${file}: ${document.errors[0].message}`)
  const rows = Array.isArray(document.toJS()) ? document.toJS() : []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = row.id
    if (typeof id !== 'string' || !(id in states)) continue
    states[id] = { enabled: row.disabled !== true, overridden: true }
  }
  return states
}

/**
 * Flip one row in the profile patch, preserving every comment and unrelated row.
 *
 * This mirrors what DSH's own plugin manager does when you use its switch, so a
 * value written here reads back identically there — the page is not a private
 * side channel.
 *
 * @param {string} profile - profile name.
 * @param {string} id - row id to flip.
 * @param {boolean} enabled - desired state.
 * @returns {Promise<{changed: boolean, path: string}>} what happened.
 */
async function writeRowEnabled(profile, id, enabled) {
  if (!ROWS.includes(id)) throw new ConfigError('settings', `unknown row ${JSON.stringify(id)}; expected one of ${ROWS.join(', ')}`)
  const file = patchPathOf(profile)
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    text = '[]\n'
  }
  const document = YAML.parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }] })
  if (document.errors.length > 0) throw new ConfigError('settings', `cannot parse ${file}: ${document.errors[0].message}`)
  if (document.contents === null) document.contents = document.createNode([])
  if (!YAML.isSeq(document.contents)) throw new ConfigError('settings', `${file} must be a YAML sequence`)

  const items = document.contents.items
  let target
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!YAML.isMap(item)) continue
    if (document.getIn([index, 'id']) !== id) continue
    if (item.has('insert')) continue
    const named = document.getIn([index, 'name'])
    if (named !== undefined && typeof named === 'string' && !named.startsWith('dsh-hermes-bridge')) continue
    target = index
    break
  }

  let changed = false
  if (target !== undefined) {
    const current = document.getIn([target, 'disabled'])
    const nextDisabled = !enabled
    if (current === nextDisabled) return { changed: false, path: file }
    document.setIn([target, 'disabled'], nextDisabled)
    changed = true
  } else {
    // No override yet. A row that defaults to enabled needs no entry when we are
    // enabling it, so only a disable writes one.
    if (enabled) return { changed: false, path: file }
    document.add({ id, disabled: true })
    changed = true
  }
  if (!changed) return { changed: false, path: file }

  // A profile directory can be missing on a first run; the temp file has to land
  // somewhere. Creating the parent is safe: the profile is ours to describe, and
  // a patch file without its directory would fail the rename instead.
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(temporary, String(document), { mode: 0o600 })
  await fsp.rename(temporary, file)
  return { changed: true, path: file }
}

/**
 * Which config keys each row accepts, and which of those the settings page can
 * write. Kept in one place because the write path fans out to every row that
 * reads a key — writing only one row would let them drift apart, and a bridge
 * where persona reads home A while memory reads home B is worse than no bridge.
 */
const WRITABLE_ROW_KEYS = {
  'hermes-bridge-persona': ['hermesHome'],
  'hermes-bridge-memory': ['hermesHome'],
  'hermes-bridge-memory-write': ['hermesHome'],
  'hermes-bridge-skills': ['hermesHome'],
  'hermes-bridge-viking': ['hermesHome', 'endpoint', 'account', 'user', 'agent'],
  'hermes-bridge-mcp': ['hermesHome', 'profile'],
  'hermes-bridge-hermes-data': ['hermesHome'],
  'hermes-bridge-settings': ['hermesHome', 'profile', 'vikingEndpoint'],
}

/** Keys `POST /config` accepts, and the rows each key fans out to. */
const WRITABLE_KEYS = {
  hermesHome: { rows: Object.keys(WRITABLE_ROW_KEYS), type: 'path' },
  vikingEndpoint: { rows: ['hermes-bridge-viking', 'hermes-bridge-settings'], type: 'string' },
  account: { rows: ['hermes-bridge-viking'], type: 'string' },
  user: { rows: ['hermes-bridge-viking'], type: 'string' },
  agent: { rows: ['hermes-bridge-viking'], type: 'string' },
}

/**
 * Locate the bundle's own patch file (the package defaults layer).
 * @returns {string} absolute path to this package's cordis.patch.yml.
 */
function bundlePatchPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cordis.patch.yml')
}

/**
 * Read the effective config of every bridge row: package defaults overlaid by
 * the profile patch, the same layering the loader applies. The page uses this
 * to prefill its inputs — reading only one layer would show the wrong value.
 *
 * @param {string} profile - profile name.
 * @returns {Promise<Record<string, object>>} per-row effective config.
 */
async function readRowConfigs(profile) {
  const effective = Object.fromEntries(Object.keys(WRITABLE_ROW_KEYS).map((id) => [id, {}]))
  const layers = [bundlePatchPath(), patchPathOf(profile)]
  for (const file of layers) {
    let text
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch {
      continue
    }
    let rows
    try {
      rows = YAML.parse(text)
    } catch {
      continue
    }
    if (!Array.isArray(rows)) continue
    // The bundle's own patch nests its rows under `- insert: [...]`; a profile
    // patch uses flat id-targeted rows. Both shapes feed the same overlay.
    const flat = rows.flatMap((row) => (Array.isArray(row?.insert) ? row.insert : [row]))
    for (const row of flat) {
      if (row === null || typeof row !== 'object') continue
      if (typeof row.id !== 'string' || !(row.id in effective)) continue
      if (row.config === null || typeof row.config !== 'object') continue
      Object.assign(effective[row.id], row.config)
    }
  }
  return effective
}

/**
 * Write one config key to every row that reads it, in the profile patch.
 *
 * An empty string removes the key (the row falls back to its default), so a
 * user can undo an override from the same input they typed it in. Rows already
 * present as id-targeted overrides are edited in place; rows without an entry
 * get one appended with just the config. Comments and unrelated rows survive,
 * same contract as `writeRowEnabled`.
 *
 * @param {string} profile - profile name.
 * @param {string} key - one of WRITABLE_KEYS.
 * @param {string} value - new value; '' clears the override.
 * @returns {Promise<{key: string, value: string, rows: string[], path: string}>} what happened.
 */
async function writeRowConfig(profile, key, value) {
  const spec = WRITABLE_KEYS[key]
  if (spec === undefined) throw new ConfigError('settings', `unknown config key ${JSON.stringify(key)}; expected one of ${Object.keys(WRITABLE_KEYS).join(', ')}`)
  if (typeof value !== 'string') throw new ConfigError('settings', `value for ${key} must be a string`)
  const trimmed = value.trim()
  if (key === 'hermesHome' && trimmed !== '') {
    // Refuse to write a home that does not exist: a typo here used to surface
    // as memory-write silently creating a fresh (empty) tree in the wrong place.
    const probe = await probeHermes(trimmed)
    if (!probe.exists) throw new ConfigError('settings', `${trimmed} does not exist — check the path first (use the probe button)`)
  }
  if (key === 'vikingEndpoint' && trimmed !== '' && !/^https?:\/\//.test(trimmed)) {
    throw new ConfigError('settings', `endpoint must start with http:// or https://, got ${JSON.stringify(trimmed)}`)
  }

  const file = patchPathOf(profile)
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    text = '[]\n'
  }
  const document = YAML.parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }] })
  if (document.errors.length > 0) throw new ConfigError('settings', `cannot parse ${file}: ${document.errors[0].message}`)
  if (document.contents === null) document.contents = document.createNode([])
  if (!YAML.isSeq(document.contents)) throw new ConfigError('settings', `${file} must be a YAML sequence`)

  const items = document.contents.items
  const present = new Set()
  for (const rowId of spec.rows) {
    let target
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (!YAML.isMap(item)) continue
      if (document.getIn([index, 'id']) !== rowId) continue
      if (item.has('insert')) continue
      target = index
      break
    }
    if (target === undefined) {
      // No override entry yet: only create one when there is something to set.
      if (trimmed === '') continue
      document.add({ id: rowId, config: { [key]: trimmed } })
      present.add(rowId)
      continue
    }
    const configNode = document.getIn([target, 'config'], true)
    if (trimmed === '') {
      if (configNode === undefined || configNode.items === undefined) continue
      const keep = configNode.items.filter((pair) => pair.key?.value !== key)
      if (keep.length === 0) document.setIn([target, 'config'], undefined)
      else configNode.items = keep
    } else {
      if (configNode === undefined || configNode.items === undefined) {
        document.setIn([target, 'config'], { [key]: trimmed })
      } else {
        document.setIn([target, 'config', key], trimmed)
      }
    }
    present.add(rowId)
  }

  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(temporary, String(document), { mode: 0o600 })
  await fsp.rename(temporary, file)
  return { key, value: trimmed, rows: [...present], path: file }
}

/**
 * Check whether a candidate path looks like a Hermes home. Used before any
 * write (see `writeRowConfig`) and by the page's "test this path" action, so a
 * first-time user learns the path is wrong before it silently misroutes data.
 *
 * @param {string} candidate - raw user input; `~` is expanded.
 * @returns {Promise<object>} { path, exists, looksLikeHermes, checks }.
 */
export async function probeHermes(candidate) {
  const home = expandHome(String(candidate ?? '').trim())
  const checks = [
    { name: 'config.yaml', file: 'config.yaml' },
    { name: 'SOUL.md', file: 'SOUL.md' },
    { name: 'memories/', file: 'memories' },
    { name: 'skills/', file: 'skills' },
  ]
  let hit = 0
  for (const check of checks) {
    try {
      await fsp.stat(path.join(home, check.file))
      check.exists = true
      hit += 1
    } catch {
      check.exists = false
    }
  }
  const rootExists = await fsp.stat(home).then(() => true, () => false)
  return { path: home, exists: rootExists, looksLikeHermes: hit >= 2, checks }
}

/**
 * Where the per-skill enable state lives.
 *
 * Delegates to the skills row so both rows always agree on the path — if they
 * diverged, a switch would be written to a file nobody reads and the page would
 * appear to work while changing nothing.
 *
 * @param {string} profile - profile name.
 * @param {string} override - row config value, if any.
 * @returns {string} absolute path.
 */
async function skillStatePath(profile, override) {
  if (override !== '') return override
  const { defaultStateFile } = await import('./skills.js')
  return defaultStateFile(profile)
}

/**
 * Read the per-skill enable map.
 * @param {string} file - absolute path.
 * @returns {Promise<{disabled: string[], updatedAt: number}>} state.
 */
async function readSkillState(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
    const disabled = Array.isArray(parsed?.disabled) ? parsed.disabled.filter((entry) => typeof entry === 'string') : []
    return { disabled, updatedAt: Number(parsed?.updatedAt ?? 0) }
  } catch {
    return { disabled: [], updatedAt: 0 }
  }
}

/**
 * Persist the per-skill enable map.
 * @param {string} file - absolute path.
 * @param {string[]} disabled - skill names that must not appear.
 * @returns {Promise<void>} resolves when written.
 */
async function writeSkillState(file, disabled) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const payload = JSON.stringify({ disabled: [...new Set(disabled)].sort(), updatedAt: Date.now() }, null, 2)
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(temporary, payload, { mode: 0o600 })
  await fsp.rename(temporary, file)
}

/**
 * Ask the OpenViking endpoint how it is doing, with a short budget.
 * @param {string} endpoint - base URL.
 * @param {number} [timeoutMs] - budget.
 * @returns {Promise<object>} health summary.
 */
async function probeViking(endpoint, timeoutMs = 2500) {
  try {
    const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    const payload = await response.json()
    return {
      endpoint,
      reachable: payload?.healthy === true,
      status: payload?.status ?? 'unknown',
      version: payload?.version ?? '',
      authMode: payload?.auth_mode ?? '',
    }
  } catch (error) {
    return { endpoint, reachable: false, status: 'unreachable', version: '', authMode: '', error: error?.message ?? String(error) }
  }
}

/**
 * Read Hermes' own memory/provider settings so the page can show whether the
 * bridge is echoing something Hermes actually uses.
 * @param {string} home - Hermes home.
 * @returns {Promise<object>} a small, display-oriented summary.
 */
async function readHermesConfig(home) {
  const file = path.join(home, 'config.yaml')
  try {
    const parsed = YAML.parse(await fsp.readFile(file, 'utf8')) ?? {}
    const memory = parsed.memory ?? {}
    const plugins = parsed.plugins ?? {}
    return {
      path: file,
      memoryProvider: typeof memory.provider === 'string' ? memory.provider : '',
      memoryEnabled: memory.memory_enabled !== false,
      userProfileEnabled: memory.user_profile_enabled !== false,
      openviking: {
        endpoint: memory.openviking?.endpoint ?? '',
        account: memory.openviking?.account ?? '',
        user: memory.openviking?.user ?? '',
        recallLimit: memory.openviking?.recall_limit ?? null,
        scoreThreshold: memory.openviking?.recall_score_threshold ?? null,
      },
      pluginsDisabled: Array.isArray(plugins.disabled) ? plugins.disabled : [],
      pluginsEnabled: Array.isArray(plugins.enabled) ? plugins.enabled : [],
      mcpServers: Object.keys(parsed.mcp_servers ?? {}),
    }
  } catch (error) {
    return { path: file, error: error?.message ?? String(error) }
  }
}

/**
 * Read one preview file as text, clipped so a runaway file cannot wedge the page.
 * @param {string} file - absolute path.
 * @param {number} [maxBytes] - ceiling.
 * @returns {Promise<{path: string, exists: boolean, text: string, bytes: number}>} preview block.
 */
async function readPreviewFile(file, maxBytes = 48 * 1024) {
  try {
    const buffer = await fsp.readFile(file)
    return {
      path: file,
      exists: true,
      bytes: buffer.length,
      text: buffer.length > maxBytes ? `${buffer.subarray(0, maxBytes).toString('utf8')}\n\n…（已截断，原文件 ${buffer.length} 字节）` : buffer.toString('utf8'),
    }
  } catch {
    return { path: file, exists: false, bytes: 0, text: '' }
  }
}

/**
 * Build the whole status document the page renders.
 * @param {object} config - resolved row config.
 * @param {string} profile - profile name in effect.
 * @returns {Promise<object>} status payload.
 */
async function buildStatus(config, profile) {
  const home = hermesHomeOf(config.hermesHome)
  const [rowStates, hermesConfig, skillState, rowConfigs] = await Promise.all([
    readRowStates(profile),
    readHermesConfig(home),
    readSkillState(await skillStatePath(profile, config.skillStateFile ?? '')),
    readRowConfigs(profile),
  ])

  const files = await Promise.all([
    describeFile(path.join(home, 'SOUL.md'), 'SOUL.md', '人设'),
    describeFile(path.join(home, 'memories', 'MEMORY.md'), 'MEMORY.md', '长期记忆'),
    describeFile(path.join(home, 'memories', 'USER.md'), 'USER.md', '用户画像'),
    describeFile(path.join(home, 'skills'), 'skills/', '技能库'),
    describeFile(path.join(home, 'config.yaml'), 'config.yaml', 'Hermes 配置'),
    describeFile(patchPathOf(profile), 'cordis.patch.yml', 'DSH 覆盖层'),
  ])

  // Preview reads the same files the rows read, so what the page shows is what
  // the model gets — not a re-rendering from the config.
  const [personaFile, memoryFile, userFile] = await Promise.all([
    readPreviewFile(path.join(home, 'SOUL.md')),
    readPreviewFile(path.join(home, 'memories', 'MEMORY.md')),
    readPreviewFile(path.join(home, 'memories', 'USER.md')),
  ])
  const memoryText = [
    memoryFile.exists ? `# MEMORY.md\n\n${memoryFile.text}` : '',
    userFile.exists ? `# USER.md\n\n${userFile.text}` : '',
  ].filter(part => part !== '').join('\n\n---\n\n')

  // First-run guidance: a Hermes home that misses everything is the single
  // most common fresh-install state, and every other panel reads as noise
  // until it is fixed. `hermesFound` summarizes the probe so the page can open
  // with a setup callout instead of a wall of "missing" badges.
  const homeProbe = await probeHermes(home)
  const mcpRow = await readMcpRoster(profile, home)

  return {
    profile,
    hermesHome: home,
    dshHome: dshHome(),
    patchPath: patchPathOf(profile),
    rows: ROWS.map((id) => ({ id, ...rowStates[id] })),
    files,
    hermes: hermesConfig,
    setup: {
      hermesFound: homeProbe.looksLikeHermes,
      probe: homeProbe,
      hint: homeProbe.looksLikeHermes ? '' : 'hermes-missing',
    },
    config: rowConfigs,
    mcp: mcpRow,
    skills: { stateFile: await skillStatePath(profile, config.skillStateFile ?? ''), disabled: skillState.disabled, updatedAt: skillState.updatedAt },
    viking: await probeViking(config.vikingEndpoint),
    // Who wrote what: the page shows the split so a DSH-written entry is never
    // mistaken for Hermes' own. `assumed` is the count of untagged entries
    // (written before tagging existed, hence Hermes' by inference).
    memoryOrigins: await countOrigins(home),
    preview: {
      persona: personaFile.text,
      memory: memoryText,
      personaPath: personaFile.path,
      memoryPaths: [memoryFile.path, userFile.path],
    },
    generatedAt: Date.now(),
  }
}

/**
 * Summarize the MCP situation for the status page: what Hermes declares, what
 * rows exist in the profile patch, and whether a sync is needed. Read-only —
 * the actual sync runs via POST /mcp/sync, an explicit act with a report.
 *
 * @param {string} profile - profile name.
 * @param {string} home - resolved Hermes home.
 * @returns {Promise<object>} roster summary.
 */
async function readMcpRoster(profile, home) {
  const { readHermesServers, BLOCK_BEGIN } = await import('./mcp-sync.js')
  const hermesSide = readHermesServers(path.join(home, 'config.yaml'))
  let mounted = []
  let patchText = ''
  try {
    patchText = await fsp.readFile(patchPathOf(profile), 'utf8')
  } catch { /* no patch yet */ }
  if (patchText.includes(BLOCK_BEGIN)) {
    const parsed = YAML.parse(patchText)
    if (Array.isArray(parsed)) {
      mounted = parsed
        .filter((row) => typeof row?.id === 'string' && row.id.startsWith('hermes-mcp-'))
        .map((row) => ({ id: row.id, disabled: row.disabled === true }))
    }
  }
  return {
    hermesServers: hermesSide.error !== undefined ? [] : hermesSide.servers.map((server) => server.name),
    error: hermesSide.error ?? '',
    mounted: mounted.length,
    mountedRows: mounted,
    needsSync: hermesSide.error === undefined && (mounted.length === 0 && hermesSide.servers.length > 0),
  }
}

/**
 * Count memory entries by the agent that wrote them.
 *
 * Reads the real files rather than a stored tally, so the numbers cannot drift
 * from what the model actually sees on the next turn.
 *
 * @param {string} home - Hermes home.
 * @returns {Promise<{memory: object, user: object}>} per-file origin counts.
 */
async function countOrigins(home) {
  const tally = async (target) => {
    try {
      const snapshot = await readTarget(home, target)
      const counts = { hermes: 0, dsh: 0, assumed: 0 }
      for (const entry of snapshot.entries) {
        if (entry.tagged) counts[entry.origin] += 1
        else counts.assumed += 1
      }
      return { total: snapshot.entries.length, ...counts, chars: snapshot.chars, limit: snapshot.limit }
    } catch {
      return { total: 0, hermes: 0, dsh: 0, assumed: 0, chars: 0, limit: 0 }
    }
  }
  return { memory: await tally('memory'), user: await tally('user') }
}

/**
 * List every discovered skill with its effective enable state.
 *
 * Reads the same discovery path the provider uses, so the page cannot show a
 * skill the model would never see. `disabled` in the response is the user's
 * skip list; `skills[].enabled` is the resolved result.
 *
 * @param {object} config - resolved row config.
 * @param {string} profile - profile name in effect.
 * @param {number} limit - max entries.
 * @returns {Promise<object>} inventory payload.
 */
async function buildSkillInventory(config, profile, limit) {
  const home = hermesHomeOf(config.hermesHome)
  const state = await readSkillState(await skillStatePath(profile, config.skillStateFile ?? ''))
  const { discoverSkills } = await import('./skills.js')
  const result = await discoverSkills({
    root: path.join(home, 'skills'),
    maxDepth: 4,
    excludePrefix: ['.', '_'],
    maxSkills: limit,
  })
  const skip = new Set(state.disabled)
  return {
    skills: result.candidates
      // A switched-off skill is still listed, but as `enabled: false`: the page
      // has to be able to switch it back on, and a skill that vanished from the
      // list would be unrecoverable from the UI. The provider is what actually
      // omits it from the model's catalog.
      .map((candidate) => ({
        name: candidate.name,
        description: candidate.description,
        category: candidate.category,
        path: candidate.path,
        enabled: !skip.has(candidate.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    // The provider's view: what the model can actually see right now. Reported
    // separately so the page can prove the switch reached the catalog instead of
    // only reaching a JSON file.
    activeCount: result.candidates.filter((candidate) => !skip.has(candidate.name)).length,
    disabled: state.disabled,
    rejected: result.rejected,
    categories: result.categories,
    complete: result.complete,
    stateFile: await skillStatePath(profile, config.skillStateFile ?? ''),
  }
}

/**
 * Read one request body as JSON with a size ceiling.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {number} [limit] - max bytes.
 * @returns {Promise<any>} parsed body.
 */
async function readJson(request, limit = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new ConfigError('settings', 'request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Write a JSON response.
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {number} status - HTTP status.
 * @param {object} payload - JSON-serializable body.
 */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * Mount the settings API and keep a live handle on the skill provider so the
 * page's skill switches can invalidate the catalog without a restart.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - row context.
 * @param {Record<string, unknown>} rawConfig - row config.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  // The skills row publishes its control handle here; the page needs it to make
  // a switch visible on the next turn instead of the next restart.
  const registry = { invalidate: undefined, reload: undefined }
  ctx.provide?.('hermesBridgeControl', registry)

  const resolveProfile = () => {
    const fromContext = ctx.get?.('profileContext')?.name
    if (typeof fromContext === 'string' && fromContext !== '') return fromContext
    if (config.profile !== '') return config.profile
    return 'desktop'
  }

  ctx.inject(['webServer'], (scope) => {
    const server = scope.webServer

    /**
     * Dispatch one request. `webServer.register({kind:'prefix'})` hands every
     * path under the prefix here, so the routing lives in this function.
     * @param {import('node:http').IncomingMessage} request - request.
     * @param {import('node:http').ServerResponse} response - response.
     */
    async function handler(request, response) {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const route = url.pathname.replace(/^\/api\/hermes-bridge/, '').replace(/\/+$/, '') || '/'
      const profile = url.searchParams.get('profile') || resolveProfile()
      try {
        if (request.method === 'GET' && route === '/status') {
          sendJson(response, 200, await buildStatus(config, profile))
          return
        }

        if (request.method === 'GET' && route === '/probe-hermes') {
          const candidate = url.searchParams.get('path') ?? ''
          sendJson(response, 200, await probeHermes(candidate))
          return
        }

        if (request.method === 'POST' && route === '/config') {
          const body = await readJson(request)
          if (typeof body.key !== 'string' || typeof body.value !== 'string') {
            sendJson(response, 400, { error: 'expected { key: string, value: string }' })
            return
          }
          const result = await writeRowConfig(profile, body.key, body.value)
          report(ctx, `settings: config ${body.key} → ${body.value === '' ? '(cleared)' : body.value} (${result.rows.length} rows)`)
          sendJson(response, 200, { ...result, status: await buildStatus(config, profile) })
          return
        }

        if (request.method === 'POST' && route === '/mcp/sync') {
          // An explicit act with a report, same as the CLI — the button merely
          // saves the terminal trip. Dry-run first is not offered because the
          // CLI stays available for anyone who wants the preview.
          const body = await readJson(request).catch(() => ({}))
          const { syncProfile } = await import('./mcp-sync.js')
          const result = syncProfile({ profile, hermesHome: config.hermesHome })
          if (result.ok === false) {
            sendJson(response, 500, result)
            return
          }
          report(ctx, `settings: mcp sync — ${result.rows.length} servers → ${result.patch}`)
          sendJson(response, 200, { ...result, status: await buildStatus(config, profile) })
          return
        }

        if (request.method === 'POST' && route === '/mcp/clear') {
          const { syncProfile } = await import('./mcp-sync.js')
          const result = syncProfile({ profile, clear: true })
          if (result.ok === false) {
            sendJson(response, 500, result)
            return
          }
          report(ctx, `settings: mcp clear — managed block removed from ${result.patch}`)
          sendJson(response, 200, { ...result, status: await buildStatus(config, profile) })
          return
        }

        if (request.method === 'GET' && route === '/skills') {
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 400), 1), 2000)
          sendJson(response, 200, await buildSkillInventory(config, profile, limit))
          return
        }

        if (request.method === 'POST' && route === '/toggles') {
          const body = await readJson(request)
          if (typeof body.id !== 'string' || typeof body.enabled !== 'boolean') {
            sendJson(response, 400, { error: 'expected { id: string, enabled: boolean }' })
            return
          }
          const result = await writeRowEnabled(profile, body.id, body.enabled)
          report(ctx, `settings: row ${body.id} → ${body.enabled ? 'enabled' : 'disabled'}${result.changed ? '' : ' (already set)'}`)
          sendJson(response, 200, { ...result, id: body.id, enabled: body.enabled, status: await buildStatus(config, profile) })
          return
        }

        if (request.method === 'POST' && route === '/skills') {
          const body = await readJson(request)
          if (typeof body.name !== 'string' || typeof body.enabled !== 'boolean') {
            sendJson(response, 400, { error: 'expected { name: string, enabled: boolean }' })
            return
          }
          const file = await skillStatePath(profile, config.skillStateFile ?? '')
          const state = await readSkillState(file)
          const next = new Set(state.disabled)
          if (body.enabled) next.delete(body.name)
          else next.add(body.name)
          await writeSkillState(file, [...next])
          // Drop the catalog cache so the next turn sees the new list. Without
          // this the switch would look applied and change nothing until restart.
          registry.invalidate?.()
          sendJson(response, 200, {
            name: body.name,
            enabled: body.enabled,
            disabled: [...next].sort(),
            invalidated: typeof registry.invalidate === 'function',
          })
          return
        }

        if (request.method === 'POST' && route === '/skills/bulk') {
          const body = await readJson(request)
          if (!Array.isArray(body.names)) {
            sendJson(response, 400, { error: 'expected { names: string[], enabled: boolean }' })
            return
          }
          const file = await skillStatePath(profile, config.skillStateFile ?? '')
          const state = await readSkillState(file)
          const next = new Set(state.disabled)
          for (const entry of body.names) {
            if (typeof entry !== 'string') continue
            if (body.enabled === true) next.delete(entry)
            else next.add(entry)
          }
          await writeSkillState(file, [...next])
          registry.invalidate?.()
          sendJson(response, 200, { disabled: [...next].sort(), invalidated: typeof registry.invalidate === 'function' })
          return
        }

        sendJson(response, 404, { error: `no route ${request.method} ${route}` })
      } catch (error) {
        const message = error?.message ?? String(error)
        report(ctx, `settings: ${route} failed — ${message}`, 'error')
        sendJson(response, 500, { error: message })
      }
    }

    scope.effect(() => server.register({ kind: 'prefix', path: '/api/hermes-bridge', handler }), 'hermes-bridge: settings api')
    report(ctx, 'settings: API mounted at /api/hermes-bridge')
  })
}

export { buildStatus, buildSkillInventory, readRowStates, writeRowEnabled, readRowConfigs, writeRowConfig, readSkillState, writeSkillState, probeViking, hermesHomeOf, patchPathOf, skillStatePath, dshHome }
