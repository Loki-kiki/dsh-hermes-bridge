/**
 * MCP provisioning: turn Hermes' `mcp_servers` map into native DSH rows.
 *
 * DSH mounts one `@deepseek-ai/dsh-mcp-client` row per server, and those rows
 * live in the profile patch — that is why each server shows up in the Plugins
 * page as its own switchable entry. Rewriting that patch from YAML would eat
 * the user's comments, so the managed block is spliced in as text between two
 * markers and every other byte of the file is left alone.
 *
 * @module dsh-hermes-bridge/mcp-sync
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

export const BLOCK_BEGIN = '# >>> dsh-hermes-bridge:mcp (managed block — edit Hermes config.yaml instead) >>>'
export const BLOCK_END = '# <<< dsh-hermes-bridge:mcp (managed block) <<<'

/** Keys a Hermes `mcp_servers` entry may carry that DSH's client understands. */
const FORWARDED_KEYS = new Set(['command', 'args', 'env', 'cwd', 'url', 'headers'])

/** Hermes bookkeeping keys this module consumes itself. */
const CONSUMED_KEYS = new Set(['enabled', 'timeout', 'connect_timeout', 'auth', 'oauth', 'type'])

/**
 * Resolve the DSH data root (`$DSH_HOME` or `~/.dsh`).
 * @returns {string} absolute path.
 */
export function resolveDshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(env.trim())
  return path.join(os.homedir(), '.dsh')
}

/**
 * Resolve the Hermes data root (`$HERMES_HOME` or the platform default).
 * @returns {string} absolute path.
 */
export function resolveHermesHome() {
  const env = process.env.HERMES_HOME
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(env.trim())
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'hermes')
  return path.join(os.homedir(), '.hermes')
}

/**
 * Read the Hermes `mcp_servers` map.
 * @param {string} configFile - absolute path to Hermes' config.yaml.
 * @returns {{servers: Array<{name: string, entry: object}>, warnings: string[], error?: string}} parsed servers.
 */
export function readHermesServers(configFile) {
  let text
  try {
    text = fs.readFileSync(configFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { servers: [], warnings: [], error: `no Hermes config at ${configFile}` }
    return { servers: [], warnings: [], error: `cannot read ${configFile}: ${error.message}` }
  }
  let document
  try {
    document = YAML.parse(text)
  } catch (error) {
    return { servers: [], warnings: [], error: `${configFile} is not valid YAML: ${error.message}` }
  }
  const map = document?.mcp_servers
  if (map === undefined || map === null) return { servers: [], warnings: [], error: 'Hermes config has no mcp_servers section' }
  if (typeof map !== 'object' || Array.isArray(map)) return { servers: [], warnings: [], error: 'Hermes mcp_servers is not a mapping' }
  const warnings = []
  const servers = []
  for (const [name, entry] of Object.entries(map)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push(`"${name}" is not a mapping — skipped`)
      continue
    }
    if (entry.enabled === false) {
      warnings.push(`"${name}" is disabled in Hermes — skipped`)
      continue
    }
    servers.push({ name, entry })
  }
  return { servers, warnings }
}

/**
 * Convert one Hermes server entry into a DSH MCP client row config.
 * @param {string} serverName - Hermes key, reused as the DSH namespace.
 * @param {object} entry - Hermes server entry.
 * @param {number} timeoutMs - per-call timeout for DSH.
 * @param {string[]} warnings - collector for dropped/unmappable keys.
 * @returns {{id: string, row: object}|undefined} row, or undefined when unusable.
 */
export function toMcpRow(serverName, entry, timeoutMs, warnings) {
  const namespace = serverName.replaceAll(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
  const row = { serverName: namespace }
  const url = typeof entry.url === 'string' ? entry.url.trim() : ''
  if (url !== '') {
    row.transport = 'streamable-http'
    row.url = url
    if (entry.headers !== undefined && entry.headers !== null && typeof entry.headers === 'object') {
      row.headers = Object.fromEntries(Object.entries(entry.headers).map(([key, value]) => [key, String(value)]))
    }
  } else if (typeof entry.command === 'string' && entry.command.trim() !== '') {
    row.transport = 'stdio'
    row.command = entry.command.trim()
    if (Array.isArray(entry.args)) row.args = entry.args.map((arg) => String(arg))
    if (entry.env !== undefined && entry.env !== null && typeof entry.env === 'object') {
      row.env = Object.fromEntries(Object.entries(entry.env).map(([key, value]) => [key, String(value)]))
    }
    if (typeof entry.cwd === 'string' && entry.cwd.trim() !== '') row.cwd = entry.cwd.trim()
  } else {
    warnings.push(`"${serverName}" has neither url nor command — skipped`)
    return undefined
  }
  if (entry.oauth !== undefined && entry.oauth !== null) {
    warnings.push(`"${serverName}" uses OAuth in Hermes; DSH has no matching login flow — the tools will report an auth error until a token is supplied in the row's headers/env`)
  }
  const unknown = Object.keys(entry).filter((key) => !FORWARDED_KEYS.has(key) && !CONSUMED_KEYS.has(key))
  if (unknown.length > 0) warnings.push(`"${serverName}" — Hermes-only key(s) not forwarded: ${unknown.join(', ')}`)
  row.toolCallTimeoutMs = timeoutMs
  return { id: `hermes-mcp-${namespace}`, row }
}

/**
 * Render the managed YAML block for a set of rows.
 * @param {Array<{id: string, row: object}>} rows - rows to render.
 * @returns {string} block text including marker comments, or '' for no rows.
 */
export function renderBlock(rows) {
  if (rows.length === 0) return ''
  const lines = [
    BLOCK_BEGIN,
    '# One @deepseek-ai/dsh-mcp-client row per server from the Hermes config.',
    '# Switch individual servers off under Plugins → dsh-hermes-bridge.',
    '- insert:',
  ]
  for (const item of rows) {
    const body = YAML.stringify(item.row, { lineWidth: 0 }).trimEnd().split('\n')
    lines.push(`    - id: ${item.id}`)
    lines.push("      name: '@deepseek-ai/dsh-mcp-client'")
    lines.push('      config:')
    for (const line of body) lines.push(`        ${line}`)
  }
  lines.push(BLOCK_END)
  return `${lines.join('\n')}\n`
}

/**
 * Splice the managed block into a patch file's text, leaving every other line
 * untouched. A pre-existing block is replaced in place; otherwise the block is
 * appended.
 *
 * The patch file is one top-level YAML **array**, and a fresh profile ships the
 * flow-style empty array `[]`. Appending a `- insert:` entry after `[]` creates
 * a second document and the loader rejects the whole file, so an empty flow
 * array is dropped first. A flow-style array that actually holds entries cannot
 * be appended to textually; that case is refused instead of being mangled.
 *
 * @param {string} original - current patch text (may be '').
 * @param {string} block - rendered block, or '' to remove the managed block.
 * @returns {string} new patch text.
 */
export function spliceBlock(original, block) {
  const text = original ?? ''
  const begin = text.indexOf(BLOCK_BEGIN)
  if (begin !== -1) {
    const endMarker = text.indexOf(BLOCK_END, begin)
    if (endMarker === -1) {
      // Half-written block from an interrupted run: drop everything from the
      // marker on and rebuild, so the file stays loadable.
      const head = text.slice(0, begin).replace(/\s+$/, '')
      return block === '' ? (head === '' ? '' : `${head}\n`) : `${head === '' ? '' : `${head}\n\n`}${block}`
    }
    const after = text.slice(endMarker + BLOCK_END.length).replace(/^\s*\n?/, '')
    const head = text.slice(0, begin).replace(/\s+$/, '')
    const tail = after.replace(/\s+$/, '')
    const pieces = [head, block.trimEnd(), tail].filter((piece) => piece !== '')
    return pieces.length === 0 ? '' : `${pieces.join('\n\n')}\n`
  }
  if (block === '') return text
  const lines = text.replace(/\s+$/, '').split('\n')
  const contentLines = lines.filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
  const emptyFlowArray = contentLines.length === 1 && contentLines[0].trim() === '[]'
  if (contentLines.length === 0 || emptyFlowArray) {
    const head = lines.filter((line) => !(line.trim() === '[]')).join('\n').replace(/\s+$/, '')
    return `${head === '' ? '' : `${head}\n\n`}${block}`
  }
  if (contentLines.length === 1 && contentLines[0].trimStart().startsWith('[')) {
    // A single-line flow array that actually holds entries: splice textually
    // would produce a second YAML document, so normalize it to block style and
    // let the caller's block follow it.
    const parsed = YAML.parse(contentLines[0])
    if (!Array.isArray(parsed)) throw new Error('patch file is not a top-level YAML array')
    const head = lines.filter((line) => line !== contentLines[0]).join('\n').replace(/\s+$/, '')
    const rendered = YAML.stringify(parsed, { lineWidth: 0 }).trimEnd()
    return `${head === '' ? '' : `${head}\n\n`}${rendered}\n\n${block}`
  }
  return `${text.replace(/\s+$/, '')}\n\n${block}`
}

/**
 * Locate the profile patch file.
 * @param {string} profile - profile name, e.g. `desktop`.
 * @returns {{dir: string, patch: string}} absolute paths.
 */
export function profilePaths(profile) {
  const dir = path.join(resolveDshHome(), 'profiles', profile)
  return { dir, patch: path.join(dir, 'cordis.patch.yml') }
}

/**
 * One-stop sync: read Hermes MCP servers, render rows, splice the profile patch.
 * @param {object} options - call options.
 * @param {string} options.profile - DSH profile name.
 * @param {number} [options.timeoutMs] - per-call timeout.
 * @param {boolean} [options.dryRun] - compute but do not write.
 * @param {boolean} [options.clear] - remove the managed block instead.
 * @returns {object} a report of what happened.
 */
export function syncProfile(options) {
  const { dir, patch } = profilePaths(options.profile)
  if (!fs.existsSync(dir)) return { ok: false, error: `profile directory not found: ${dir}` }
  let current = ''
  try {
    current = fs.readFileSync(patch, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') return { ok: false, error: `cannot read ${patch}: ${error.message}` }
  }
  if (options.clear === true) {
    const next = spliceBlock(current, '')
    if (!options.dryRun && next !== current) fs.writeFileSync(patch, next, 'utf8')
    return { ok: true, removed: true, rows: [], warnings: [], patch, dryRun: options.dryRun === true }
  }
  // The settings page can pass the home it resolved (row config → env → platform
  // default); without it the CLI keeps the env/default resolution.
  const home = typeof options.hermesHome === 'string' && options.hermesHome.trim() !== ''
    ? options.hermesHome
    : resolveHermesHome()
  const hermesConfig = path.join(home, 'config.yaml')
  const parsed = readHermesServers(hermesConfig)
  if (parsed.error !== undefined) return { ok: false, error: parsed.error, warnings: parsed.warnings, hermesHome: home }
  const warnings = [...parsed.warnings]
  const rows = []
  for (const { name, entry } of parsed.servers) {
    const converted = toMcpRow(name, entry, options.timeoutMs ?? 180000, warnings)
    if (converted !== undefined) rows.push(converted)
  }
  const block = renderBlock(rows)
  const next = spliceBlock(current, block)
  const changed = next !== current
  if (!options.dryRun && changed) fs.writeFileSync(patch, next, 'utf8')
  return { ok: true, patch, rows, warnings, changed, dryRun: options.dryRun === true }
}
