/**
 * `hermes-bridge/mcp` — report (and optionally refresh) the MCP servers that
 * Hermes and DSH share.
 *
 * Why this row does not mount MCP clients itself: DSH mounts one
 * `@deepseek-ai/dsh-mcp-client` row per server, and owning that connection
 * inside another plugin's context would hide each server from the Plugins page
 * and from the per-server switches the user asked for. So the rows live in the
 * profile patch (written by `dsh-hermes-bridge mcp sync`), and this row's job at
 * boot is the part a YAML generator cannot do: notice when Hermes' config moved
 * on and tell the user, in the log, exactly which command to run.
 *
 * Nothing here writes configuration at boot. A boot-time config write would
 * make the harness reload itself mid-startup, which is precisely the class of
 * trick that produces "it worked once" bugs.
 *
 * @module dsh-hermes-bridge/mcp
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  BLOCK_BEGIN,
  BLOCK_END,
  profilePaths,
  readHermesServers,
  renderBlock,
  resolveHermesHome,
  spliceBlock,
  toMcpRow,
} from './mcp-sync.js'
import {
  expandHome,
  hermesHomeOf,
  optionalBoolean,
  optionalNumber,
  optionalString,
  rejectUnknownKeys,
  report,
} from './util.js'

export const name = 'hermes-bridge/mcp'

const KNOWN_KEYS = ['profile', 'hermesHome', 'toolCallTimeoutMs', 'warnOnDrift']

/**
 * Read this row's configuration and resolve every default.
 * @param {Record<string, unknown>} raw - row config from cordis.
 * @returns {object} resolved config.
 */
function resolveConfig(raw) {
  const config = raw ?? {}
  rejectUnknownKeys('mcp', config, KNOWN_KEYS)
  return {
    profile: optionalString('mcp', config, 'profile', 'desktop'),
    hermesHome: hermesHomeOf('mcp', config),
    toolCallTimeoutMs: optionalNumber('mcp', config, 'toolCallTimeoutMs', 180000),
    warnOnDrift: optionalBoolean('mcp', config, 'warnOnDrift', true),
  }
}

/**
 * Count the managed rows currently present in a patch file.
 * @param {string} text - patch text.
 * @returns {number} count, or -1 when no managed block exists.
 */
function countManaged(text) {
  const begin = text.indexOf(BLOCK_BEGIN)
  if (begin === -1) return -1
  const end = text.indexOf(BLOCK_END, begin)
  if (end === -1) return -1
  return text.slice(begin, end).split('\n').filter((line) => line.trimStart().startsWith('- id:')).length
}

/**
 * The profile that owns the patch being inspected.
 *
 * A row cannot know its profile from config alone, and hard-coding one makes the
 * drift report lie in every other profile — so the running profile wins, with
 * the configured value only as a fallback for contexts that expose no
 * `profileContext`.
 *
 * @param {object} ctx - row context.
 * @param {string} configured - config value.
 * @returns {string} profile name.
 */
function effectiveProfile(ctx, configured) {
  try {
    const name = ctx?.get?.('profileContext')?.name
    if (typeof name === 'string' && name !== '') return name
  } catch {
    /* no profile context in this composition */
  }
  return configured
}

/**
 * Mount the MCP row: verify the managed block is current and report drift.
 * @param {import('@deepseek-ai/cordis').Context} ctx - row context.
 * @param {Record<string, unknown>} rawConfig - row config.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const profile = effectiveProfile(ctx, config.profile)
  const { patch } = profilePaths(profile)
  let current = ''
  try {
    current = fs.readFileSync(patch, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      report(ctx, `mcp: cannot read ${patch}: ${error.message}`, 'warn')
      return
    }
  }
  const mounted = countManaged(current)
  const hermesConfig = path.join(resolveHermesHome(), 'config.yaml')
  const parsed = readHermesServers(hermesConfig)
  if (parsed.error !== undefined) {
    report(ctx, `mcp: ${parsed.error}`, 'warn')
    return
  }
  const warnings = [...parsed.warnings]
  const rows = []
  for (const { name, entry } of parsed.servers) {
    const converted = toMcpRow(name, entry, config.toolCallTimeoutMs, warnings)
    if (converted !== undefined) rows.push(converted)
  }
  for (const warning of warnings) report(ctx, `mcp: ${warning}`, 'warn')
  if (!config.warnOnDrift) return
  const expected = renderBlock(rows)
  if (mounted === -1) {
    if (rows.length === 0) {
      report(ctx, 'mcp: Hermes has no enabled MCP server — nothing to mount')
      return
    }
    report(ctx, `mcp: ${rows.length} Hermes MCP server(s) are not mounted yet. Run \`dsh-hermes-bridge mcp sync --profile ${profile}\` and restart DSH.`)
    return
  }
  const next = spliceBlock(current, expected)
  if (next === current) {
    report(ctx, `mcp: ${mounted} Hermes MCP server(s) mounted from ${hermesConfig}`)
    return
  }
  report(ctx, `mcp: mounted rows are stale (mounted ${mounted}, Hermes now has ${rows.length}). Run \`dsh-hermes-bridge mcp sync --profile ${profile}\` and restart DSH.`, 'warn')
}
