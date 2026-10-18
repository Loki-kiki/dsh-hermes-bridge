/**
 * Shared plumbing for the hermes-bridge rows: Hermes home resolution, tiny
 * frontmatter parsing, mtime-aware file reads, and config validation that fails
 * loud.
 *
 * This package deliberately imports no `@deepseek-ai/*` value: the profile
 * loader supplies those names, and every extra one is another way for the
 * plugin to fail to resolve. Validation is therefore explicit instead of
 * Schemastery.
 *
 * @module dsh-hermes-bridge/util
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Error raised for a config value this row cannot honour. */
export class ConfigError extends Error {
  constructor(row, message) {
    super(`dsh-hermes-bridge/${row} config: ${message}`)
    this.name = 'ConfigError'
  }
}

/**
 * Resolve the Hermes home the same way Hermes itself does: `HERMES_HOME`, then
 * the platform default (`%LOCALAPPDATA%\hermes` on Windows, `~/.hermes`).
 * @param {string|undefined} override - explicit config value, expanded for `~`.
 * @returns {string} absolute path.
 */
export function resolveHermesHome(override) {
  if (typeof override === 'string' && override.trim() !== '') return expandHome(override.trim())
  const env = process.env.HERMES_HOME
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(env.trim())
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'hermes')
  }
  return path.join(os.homedir(), '.hermes')
}

/**
 * Resolve the Hermes home from config, falling back to Hermes' own default.
 * @param {string} row - row name for error text.
 * @param {Record<string, unknown>} raw - whole row config.
 * @returns {string} absolute Hermes home.
 */
export function hermesHomeOf(row, raw) {
  const configured = optionalString(row, raw, 'hermesHome', undefined)
  return configured === undefined ? resolveHermesHome() : expandHome(configured)
}

/**
 * Expand a leading `~` and resolve relative to the Hermes home.
 * @param {string} value - raw config path.
 * @param {string} [base] - base for relative values (default: Hermes home).
 * @returns {string} absolute path.
 */
export function expandHome(value, base) {
  if (typeof value !== 'string') return value
  let text = value.trim()
  if (text === '~') text = os.homedir()
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = path.join(os.homedir(), text.slice(2))
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(base ?? resolveHermesHome(), text)
}

/** Per-file text cache keyed by absolute path, invalidated by mtime+size. */
const textCache = new Map()

/**
 * Read a UTF-8 text file, reusing the cached copy while mtime and size hold.
 * A missing file is a valid empty state, not an error.
 * @param {string} file - absolute path.
 * @returns {{text: string, exists: boolean, mtimeMs: number}} the content state.
 */
export function readCached(file) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    textCache.delete(file)
    return { text: '', exists: false, mtimeMs: 0 }
  }
  const cached = textCache.get(file)
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { text: '', exists: false, mtimeMs: 0 }
  }
  const value = { text, exists: true, mtimeMs: stat.mtimeMs }
  textCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value })
  return value
}

/** Strip a UTF-8 BOM, which Windows editors like to leave behind. */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Report one line through the harness logger when it exists, otherwise the
 * console. Never throws — logging must not break a prompt render.
 * @param {object} ctx - plugin context (may be undefined during early phases).
 * @param {string} message - text to report.
 * @param {'info'|'warn'|'error'} [level] - severity.
 */
export function report(ctx, message, level = 'info') {
  const line = `[hermes-bridge] ${message}`
  try {
    const logger = ctx?.logger
    if (typeof logger?.[level] === 'function') {
      logger[level](line)
      return
    }
    if (typeof logger?.info === 'function') {
      logger.info(line)
      return
    }
  } catch {
    /* fall through to console */
  }
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

/**
 * Read one optional string config value.
 * @param {string} row - row name for error text.
 * @param {Record<string, unknown>} raw - whole row config.
 * @param {string} key - key to read.
 * @param {string|undefined} fallback - value when absent.
 * @returns {string|undefined} resolved value.
 */
export function optionalString(row, raw, key, fallback) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(row, `${key} must be a non-empty string, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read one optional boolean config value.
 * @param {string} row - row name for error text.
 * @param {Record<string, unknown>} raw - whole row config.
 * @param {string} key - key to read.
 * @param {boolean} fallback - value when absent.
 * @returns {boolean} resolved value.
 */
export function optionalBoolean(row, raw, key, fallback) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new ConfigError(row, `${key} must be a boolean, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read one optional number config value.
 * @param {string} row - row name for error text.
 * @param {Record<string, unknown>} raw - whole row config.
 * @param {string} key - key to read.
 * @param {number} fallback - value when absent.
 * @returns {number} resolved value.
 */
export function optionalNumber(row, raw, key, fallback) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(row, `${key} must be a finite number, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read one optional list-of-strings config value.
 * @param {string} row - row name for error text.
 * @param {Record<string, unknown>} raw - whole row config.
 * @param {string} key - key to read.
 * @param {string[]} fallback - value when absent.
 * @returns {string[]} resolved value.
 */
export function optionalStringList(row, raw, key, fallback) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new ConfigError(row, `${key} must be an array of non-empty strings, got ${JSON.stringify(value)}`)
  }
  return [...value]
}

/**
 * Reject keys this row does not implement instead of silently ignoring them.
 * @param {string} row - row name for error text.
 * @param {Record<string, unknown>} raw - whole row config.
 * @param {string[]} known - accepted keys.
 * @returns {void}
 */
export function rejectUnknownKeys(row, raw, known) {
  const unknown = Object.keys(raw ?? {}).filter((key) => !known.includes(key))
  if (unknown.length > 0) {
    throw new ConfigError(
      row,
      `unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')}; `
        + `accepted keys are ${known.map((key) => JSON.stringify(key)).join(', ')}`,
    )
  }
}

/**
 * Split a Markdown file that may carry YAML frontmatter. The parser covers the
 * subset agent skills actually use (top-level scalars, quoted values, and
 * `>`/`|` block scalars); nested maps are skipped rather than guessed at.
 * @param {string} text - file content, BOM already stripped.
 * @returns {{data: Record<string, string>, body: string}} frontmatter and body.
 */
export function parseFrontmatter(text) {
  const source = stripBom(text).replaceAll('\r\n', '\n')
  if (!source.startsWith('---\n')) return { data: {}, body: source }
  const close = source.indexOf('\n---', 3)
  if (close === -1) return { data: {}, body: source }
  const rawHead = source.slice(4, close)
  const afterClose = source.slice(close + 4)
  const body = afterClose.startsWith('\n') ? afterClose.slice(1) : afterClose
  return { data: parseYamlSubset(rawHead), body }
}

/**
 * Parse the top-level scalar keys of a YAML block, including block scalars.
 * @param {string} block - YAML text without the `---` fences.
 * @returns {Record<string, string>} key/value pairs.
 */
export function parseYamlSubset(block) {
  const lines = block.split('\n')
  const data = {}
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/^\s/.test(line)) continue // nested content is consumed by its parent key below
    const match = /^([A-Za-z0-9_.-]+):(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]
    const rest = match[2].trim()
    if (rest === '' ) {
      // A nested map or list: skip its indented block, record nothing.
      index = skipIndented(lines, index + 1)
      continue
    }
    if (rest === '>' || rest === '|' || /^[>|][+-]?$/.test(rest)) {
      const style = rest[0]
      const collected = []
      let cursor = index + 1
      while (cursor < lines.length) {
        const candidate = lines[cursor]
        if (candidate.trim() === '') {
          collected.push('')
          cursor += 1
          continue
        }
        if (!/^\s/.test(candidate)) break
        collected.push(candidate.replace(/^\s+/, ''))
        cursor += 1
      }
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
      data[key] = style === '>' ? collected.join(' ').replace(/\s+/g, ' ').trim() : collected.join('\n')
      index = cursor - 1
      continue
    }
    data[key] = unquote(rest)
  }
  return data
}

/**
 * Advance past every indented (or blank) line starting at `start`.
 * @param {string[]} lines - whole block.
 * @param {number} start - first candidate line.
 * @returns {number} last consumed line index.
 */
function skipIndented(lines, start) {
  let cursor = start
  while (cursor < lines.length && (lines[cursor].trim() === '' || /^\s/.test(lines[cursor]))) cursor += 1
  return cursor - 1
}

/**
 * Drop matching quotes and unescape the escapes skills actually use.
 * @param {string} value - raw scalar text.
 * @returns {string} scalar value.
 */
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if (first === '"' && last === '"') {
      return value.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\').replaceAll('\\n', '\n')
    }
    if (first === "'" && last === "'") return value.slice(1, -1).replaceAll("''", "'")
  }
  // Strip a trailing comment on unquoted scalars ("value  # note").
  return value.replace(/\s+#.*$/, '').trim()
}

/**
 * Read a YAML-ish boolean (`true`/`false` plus common spellings).
 * @param {unknown} value - raw value.
 * @returns {boolean|undefined} parsed boolean, or undefined when unreadable.
 */
export function parseBooleanLoose(value) {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(text)) return true
  if (['false', 'no', 'off', '0'].includes(text)) return false
  return undefined
}
