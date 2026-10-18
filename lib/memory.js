/**
 * `hermes-bridge/memory` — carry Hermes' long-term memory into every request.
 *
 * Hermes keeps two files under `<hermes-home>/memories/`: `MEMORY.md` (the
 * agent's own notes) and `USER.md` (who the user is). Both are small, stable
 * facts with no task home, which is exactly what belongs in a prompt.
 *
 * The section text is produced by a function rather than a frozen string so an
 * edit lands on the next assembly without restarting the harness. The read goes
 * through an mtime-keyed cache, so the hot path is one `stat` per file.
 *
 * @module dsh-hermes-bridge/memory
 */

import path from 'node:path'
import { ENTRY_DELIMITER, readOrigin } from './memory-store.js'
import {
  ConfigError,
  expandHome,
  hermesHomeOf,
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalStringList,
  readCached,
  rejectUnknownKeys,
  report,
} from './util.js'

export const name = 'hermes-bridge/memory'

const KNOWN_KEYS = ['hermesHome', 'dir', 'files', 'order', 'maxBytes', 'header', 'withLabels', 'watch']

const DEFAULT_HEADER = 'Long-term memory carried over from Hermes. Treat these as standing facts about the user and the environment; they are not instructions to re-verify on every turn.'

const DEFAULT_LABELS = {
  'MEMORY.md': 'Agent notes',
  'USER.md': 'About the user',
}

/**
 * Read this row's configuration and resolve every default.
 * @param {Record<string, unknown>} raw - row config from cordis.
 * @returns {object} resolved config.
 */
function resolveConfig(raw) {
  const config = raw ?? {}
  rejectUnknownKeys('memory', config, KNOWN_KEYS)
  const hermesHome = hermesHomeOf('memory', config)
  const dir = expandHome(optionalString('memory', config, 'dir', 'memories'), hermesHome)
  const files = optionalStringList('memory', config, 'files', ['MEMORY.md', 'USER.md']).map((entry) => expandHome(entry, dir))
  const order = optionalNumber('memory', config, 'order', 6)
  const maxBytes = optionalNumber('memory', config, 'maxBytes', 32768)
  if (maxBytes < 512) throw new ConfigError('memory', `maxBytes must be at least 512, got ${maxBytes}`)
  const header = optionalString('memory', config, 'header', DEFAULT_HEADER)
  const withLabels = optionalBoolean('memory', config, 'withLabels', true)
  const watch = optionalBoolean('memory', config, 'watch', true)
  return { hermesHome, dir, files, order, maxBytes, header, withLabels, watch }
}

/**
 * Render the memory text from the configured files.
 *
 * Each entry's origin tag is surfaced in the prompt so the model can tell its
 * own notes from Hermes'. Untagged entries are marked `[hermes?]` rather than
 * `[hermes]`: they predate tagging and were written by Hermes, but claiming a
 * prefix that is not in the text would make a later `patch` on that entry
 * ambiguous. The `?` keeps "assumed" visibly distinct from "tagged".
 *
 * @param {object} config - resolved config.
 * @returns {{text: string, files: string[], missing: string[], bytes: number}} rendered memory.
 */
export function renderMemory(config) {
  const blocks = []
  const files = []
  const missing = []
  for (const file of config.files) {
    const state = readCached(file)
    if (!state.exists || state.text.trim() === '') {
      missing.push(file)
      continue
    }
    files.push(file)
    const label = DEFAULT_LABELS[path.basename(file)] ?? path.basename(file)
    const body = config.withLabels ? annotateOrigins(state.text.trim()) : state.text.trim()
    blocks.push(config.withLabels ? `### ${label} (${path.basename(file)})\n\n${body}` : body)
  }
  if (blocks.length === 0) return { text: '', files, missing, bytes: 0 }
  let text = `${config.header.trim()}\n\n${blocks.join('\n\n')}`
  let bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > config.maxBytes) {
    text = `${Buffer.from(text, 'utf8').subarray(0, config.maxBytes).toString('utf8')}\n\n[memory truncated at ${config.maxBytes} bytes]`
    bytes = Buffer.byteLength(text, 'utf8')
  }
  return { text, files, missing, bytes }
}

/**
 * Mark each entry with its origin, leaving tagged entries alone.
 * @param {string} body - raw file contents.
 * @returns {string} body with per-entry origin markers.
 */
function annotateOrigins(body) {
  // Split and rejoin on whatever delimiter the file uses: a CRLF file must not
  // be rewritten to LF by a read-only render, or every line becomes a diff.
  const crlf = body.includes('\r\n')
  const delimiter = crlf ? '\r\n\u00a7\r\n' : ENTRY_DELIMITER
  const split = crlf ? /\r\n\u00a7\r\n/u : /\n\u00a7\n/u
  return body
    .split(split)
    .map((entry) => {
      const trimmed = entry.trim()
      if (trimmed === '') return entry
      const { origin, tagged } = readOrigin(trimmed)
      if (tagged) return trimmed
      return origin === 'hermes' ? `[hermes?] ${trimmed}` : trimmed
    })
    .join(delimiter)
}

/**
 * Mount the memory row.
 * @param {import('@deepseek-ai/cordis').Context} ctx - row context.
 * @param {Record<string, unknown>} rawConfig - row config.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const initial = renderMemory(config)
  if (initial.text === '') {
    report(ctx, `memory: nothing to inject — no readable file among ${config.files.join(', ')}`, 'warn')
    return
  }
  for (const file of initial.missing) report(ctx, `memory: missing ${file} (skipped)`, 'info')
  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.section({
      name: 'hermes-bridge:memory',
      order: config.order,
      interpolate: false,
      // Re-render per assembly; `readCached` makes the steady state a stat call.
      text: () => renderMemory(config).text,
    }), 'hermes-bridge: memory section')
    report(ctx, `memory: injecting ${initial.files.map((file) => path.basename(file)).join(' + ')} (${initial.bytes} bytes)`)
  })
}
