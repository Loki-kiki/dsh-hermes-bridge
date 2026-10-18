#!/usr/bin/env node
/**
 * `dsh-hermes-bridge` command line.
 *
 * Three things a user needs that the harness cannot do for them at boot:
 *
 * - `doctor`  — show what Hermes files exist, what the rows would inject, how
 *               many skills were discovered (and which ones were rejected), and
 *               which MCP servers would be mounted.
 * - `mcp sync` — write/refresh the managed MCP block inside a profile's
 *               `cordis.patch.yml`, preserving every other line.
 * - `skills list` — print the discovered catalog without starting DSH.
 *
 * Every command is read-only unless it says otherwise, and `mcp sync` supports
 * `--dry-run` plus a `--clear` undo.
 *
 * @module dsh-hermes-bridge/bin
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { personaPreview } from '../lib/preview.js'
import { readHermesServers, profilePaths, resolveHermesHome, syncProfile, toMcpRow, renderBlock } from '../lib/mcp-sync.js'
import { discoverSkills } from '../lib/skills.js'
import { resolveHermesHome as resolveHermesHomeUtil } from '../lib/util.js'

const HELP = `dsh-hermes-bridge — 把 Hermes 的 persona / 记忆 / skills / MCP 接进 DeepSeek Harness

用法:
  dsh-hermes-bridge doctor [--json] [--profile desktop]
      体检：Hermes 文件、人设/记忆字节数、skills 发现结果、MCP 服务器清单

  dsh-hermes-bridge mcp sync --profile <name> [--timeout <ms>] [--dry-run]
      从 Hermes 的 config.yaml 生成 MCP 行，写入该 profile 的 cordis.patch.yml
      （写入受管区块，其余内容逐字不动；改完需重启 DSH）

  dsh-hermes-bridge mcp clear --profile <name> [--dry-run]
      移除受管区块（可回退）

  dsh-hermes-bridge skills [list] [--json] [--limit 200]
      列出 Hermes skills 库的发现结果（名称 / 分类 / 描述首行）

  dsh-hermes-bridge memory
      打印将被注入的记忆文本长度与文件状态

选项:
  --hermes-home <path>  覆盖 Hermes home（默认 $HERMES_HOME 或平台默认）
  -h, --help            显示本帮助

环境:
  HERMES_HOME    Hermes 数据目录；Windows 默认 %LOCALAPPDATA%\\hermes
  DSH_HOME       DSH 数据目录；默认 ~/.dsh
`

/**
 * Parse `--key value` / `--flag` arguments.
 * @param {string[]} argv - arguments after the subcommand.
 * @param {Set<string>} valueFlags - flags that consume a value.
 * @returns {{values: Record<string,string>, flags: Set<string>, positionals: string[]}} parsed arguments.
 */
function parseArgs(argv, valueFlags) {
  const values = {}
  const flags = new Set()
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith('--')) {
      const [rawKey, inline] = arg.slice(2).split('=')
      if (inline !== undefined) values[rawKey] = inline
      else if (valueFlags.has(rawKey)) {
        values[rawKey] = argv[index + 1] ?? ''
        index += 1
      } else flags.add(rawKey)
      continue
    }
    positionals.push(arg)
  }
  return { values, flags, positionals }
}

/**
 * Print an object as JSON.
 * @param {unknown} value - payload.
 * @returns {void}
 */
function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Human-readable byte count.
 * @param {number} bytes - count.
 * @returns {string} formatted size.
 */
function bytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/**
 * `doctor` — one screen of truth about the bridge inputs.
 * @param {object} options - parsed options.
 * @returns {Promise<number>} exit code.
 */
async function doctor(options) {
  const hermesHome = options.hermesHome
  const report = {
    hermesHome,
    dshHome: process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
    profile: options.profile,
    files: {},
    persona: {},
    memory: {},
    skills: {},
    mcp: {},
  }
  const soul = path.join(hermesHome, 'SOUL.md')
  const memoryFile = path.join(hermesHome, 'memories', 'MEMORY.md')
  const userFile = path.join(hermesHome, 'memories', 'USER.md')
  const hermesConfig = path.join(hermesHome, 'config.yaml')
  for (const [key, file] of Object.entries({ soul, memory: memoryFile, user: userFile, config: hermesConfig })) {
    try {
      const stat = fs.statSync(file)
      report.files[key] = { path: file, exists: true, bytes: stat.size, mtime: new Date(stat.mtimeMs).toISOString() }
    } catch {
      report.files[key] = { path: file, exists: false }
    }
  }
  const persona = personaPreview({ hermesHome })
  report.persona = { bytes: persona.bytes, files: persona.files, missing: persona.missing, head: persona.text.slice(0, 200) }
  const memory = personaPreview({ hermesHome, memory: true })
  report.memory = { bytes: memory.bytes, files: memory.files, missing: memory.missing }
  const skills = await discoverSkills({ root: path.join(hermesHome, 'skills') })
  report.skills = {
    root: skills.root,
    found: skills.candidates.length,
    rejected: skills.rejected,
    categories: skills.categories,
    names: skills.candidates.map((candidate) => candidate.name),
  }
  const servers = readHermesServers(hermesConfig)
  const warnings = [...servers.warnings]
  const rows = []
  for (const { name, entry } of servers.servers) {
    const converted = toMcpRow(name, entry, 180000, warnings)
    if (converted !== undefined) rows.push({ id: converted.id, serverName: converted.row.serverName, transport: converted.row.transport, target: converted.row.url ?? converted.row.command })
  }
  const { patch } = profilePaths(options.profile)
  let patchText = ''
  let patchExists = false
  try {
    patchText = fs.readFileSync(patch, 'utf8')
    patchExists = true
  } catch { /* absent is a valid state */ }
  const block = renderBlock(rows.map((row) => ({ id: row.id, row: { serverName: row.serverName, transport: row.transport } })))
  void block
  report.mcp = {
    hermesConfig,
    error: servers.error,
    servers: rows,
    warnings,
    patch,
    patchExists,
    managedBlockPresent: patchText.includes('# >>> dsh-hermes-bridge:mcp'),
  }
  if (options.json) {
    printJson(report)
    return 0
  }
  const line = (label, value) => process.stdout.write(`  ${label.padEnd(14)} ${value}\n`)
  process.stdout.write(`\nHermes home: ${report.hermesHome}\n`)
  process.stdout.write(`DSH  profile: ${report.profile}  (${patch})\n\n`)
  process.stdout.write('文件\n')
  for (const [key, info] of Object.entries(report.files)) {
    line(key, info.exists ? `${bytes(info.bytes)}  ${info.path}` : `缺失  ${info.path}`)
  }
  process.stdout.write('\n人设 / 记忆\n')
  line('persona', report.persona.bytes === 0 ? '无可注入内容' : `${bytes(report.persona.bytes)}  ← ${report.persona.files.map((file) => path.basename(file)).join(' + ')}`)
  line('memory', report.memory.bytes === 0 ? '无可注入内容' : `${bytes(report.memory.bytes)}  ← ${report.memory.files.map((file) => path.basename(file)).join(' + ')}`)
  process.stdout.write('\nskills\n')
  line('root', report.skills.root)
  line('found', `${report.skills.found} 个（拒绝 ${report.skills.rejected.length}）`)
  for (const entry of report.skills.rejected.slice(0, 10)) line('  skipped', `${entry.path.replace(report.skills.root, '')} — ${entry.reason}`)
  line('categories', report.skills.categories.join(', '))
  process.stdout.write('\nMCP\n')
  if (report.mcp.error !== undefined) line('hermes', report.mcp.error)
  line('servers', report.mcp.servers.length === 0 ? '（无可挂载项）' : '')
  for (const server of report.mcp.servers) line(`  ${server.serverName}`, `${server.transport}  ${server.target}`)
  for (const warning of report.mcp.warnings) line('warn', warning)
  line('managed block', report.mcp.managedBlockPresent ? '已存在' : '未写入（运行 `dsh-hermes-bridge mcp sync`）')
  process.stdout.write('\n')
  return 0
}

/**
 * `skills` — list the discovered catalog.
 * @param {object} options - parsed options.
 * @returns {Promise<number>} exit code.
 */
async function skillsCommand(options) {
  const result = await discoverSkills({ root: path.join(options.hermesHome, 'skills') })
  const limit = Number(options.limit ?? 200)
  const sliced = result.candidates.slice(0, limit)
  if (options.json) {
    printJson({ root: result.root, found: result.candidates.length, rejected: result.rejected, candidates: sliced })
    return 0
  }
  process.stdout.write(`${result.root}\n发现 ${result.candidates.length} 个 skill（拒绝 ${result.rejected.length}）\n\n`)
  for (const candidate of sliced) {
    process.stdout.write(`  ${candidate.name.padEnd(38)} ${candidate.category.padEnd(22)} ${candidate.description.slice(0, 70)}\n`)
  }
  if (result.candidates.length > sliced.length) process.stdout.write(`  … 另有 ${result.candidates.length - sliced.length} 个（--limit 调整）\n`)
  return 0
}

/**
 * `mcp` — sync or clear the managed block.
 * @param {string} action - `sync` or `clear`.
 * @param {object} options - parsed options.
 * @returns {number} exit code.
 */
function mcpCommand(action, options) {
  const result = syncProfile({
    profile: options.profile,
    timeoutMs: Number(options.timeout ?? 180000),
    dryRun: options.dryRun,
    clear: action === 'clear',
  })
  if (!result.ok) {
    process.stderr.write(`失败: ${result.error}\n`)
    return 1
  }
  if (result.removed === true) {
    process.stdout.write(`${options.dryRun ? '[dry-run] ' : ''}已移除受管区块: ${result.patch}\n`)
    return 0
  }
  for (const warning of result.warnings) process.stdout.write(`  ⚠ ${warning}\n`)
  process.stdout.write(`${options.dryRun ? '[dry-run] ' : ''}${result.rows.length} 个 MCP 服务器 → ${result.patch}（${result.changed ? '已更新' : '无变化'}）\n`)
  if (result.rows.length > 0 && !options.dryRun) {
    process.stdout.write('现在重启 DSH 使新行生效；不想重启就先 `--dry-run` 看看内容。\n')
  }
  return 0
}

/**
 * `memory` — print the memory injection summary.
 * @param {object} options - parsed options.
 * @returns {number} exit code.
 */
function memoryCommand(options) {
  const preview = personaPreview({ hermesHome: options.hermesHome, memory: true })
  process.stdout.write(`文件: ${preview.files.join(', ') || '（无）'}\n字节: ${preview.bytes}\n`)
  if (preview.missing.length > 0) process.stdout.write(`缺失: ${preview.missing.join(', ')}\n`)
  process.stdout.write(`\n----8<----\n${preview.text}\n`)
  return 0
}

/**
 * Entry point.
 * @param {string[]} argv - process arguments after node/script.
 * @returns {Promise<number>} exit code.
 */
async function main(argv) {
  const [command, ...rest] = argv
  const valueFlags = new Set(['profile', 'timeout', 'limit', 'hermes-home'])
  const parsed = parseArgs(rest, valueFlags)
  if (command === undefined || command === 'help' || parsed.flags.has('help') || command === '--help' || command === '-h') {
    process.stdout.write(HELP)
    return 0
  }
  const options = {
    profile: parsed.values.profile ?? 'desktop',
    timeout: parsed.values.timeout,
    limit: parsed.values.limit,
    json: parsed.flags.has('json'),
    dryRun: parsed.flags.has('dry-run'),
    hermesHome: parsed.values['hermes-home'] === undefined
      ? (resolveHermesHomeUtil(undefined) || resolveHermesHome())
      : path.resolve(parsed.values['hermes-home']),
  }
  switch (command) {
    case 'doctor':
      return await doctor(options)
    case 'skills':
      return await skillsCommand({ ...options, positionals: parsed.positionals })
    case 'mcp': {
      const action = parsed.positionals[0] ?? 'sync'
      if (action !== 'sync' && action !== 'clear') {
        process.stderr.write(`未知的 mcp 动作: ${action}（可用: sync / clear）\n`)
        return 2
      }
      return mcpCommand(action, options)
    }
    case 'memory':
      return memoryCommand(options)
    default:
      process.stderr.write(`未知命令: ${command}\n\n${HELP}`)
      return 2
  }
}

const selfPath = fileURLToPath(import.meta.url)
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(selfPath)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
}

export { main }
