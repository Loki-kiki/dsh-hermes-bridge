/**
 * `hermes-bridge/memory-write` — let a DSH session write Hermes' long-term memory.
 *
 * The `memory` row injects `MEMORY.md` and `USER.md` into the prompt, which is
 * one-way: the model can read the store but a "remember this" lands nowhere and
 * is gone at the next session. This row closes that loop with a `memory` tool
 * that appends, rewrites, and removes entries in the same files.
 *
 * Two agents now write one file, so every entry this row writes carries a
 * `[dsh]` prefix. Entries without a prefix were written by Hermes before tagging
 * existed and read as `[hermes]`; the prefix is never backfilled, because
 * `MEMORY.md` is a hard character budget and backfilling old entries would eat
 * budget it may not have left. See `memory-store.js` for the format rationale.
 *
 * @module dsh-hermes-bridge/memory-write
 */

import {
  addEntry,
  patchEntry,
  readTarget,
  removeEntry,
  ORIGINS,
  TARGETS,
} from './memory-store.js'
import { defineTool } from './schema.js'
import {
  ConfigError,
  expandHome,
  hermesHomeOf,
  optionalBoolean,
  optionalString,
  rejectUnknownKeys,
  report,
} from './util.js'

export const name = 'hermes-bridge/memory-write'

const KNOWN_KEYS = ['hermesHome', 'origin', 'allowOriginOverride', 'readOnly']

/**
 * Read this row's configuration.
 * @param {Record<string, unknown>} raw - row config.
 * @returns {object} resolved config.
 */
function resolveConfig(raw) {
  const config = raw ?? {}
  rejectUnknownKeys('memory-write', config, KNOWN_KEYS)
  const hermesHome = hermesHomeOf('memory-write', config)
  const origin = optionalString('memory-write', config, 'origin', 'dsh')
  if (!ORIGINS.includes(origin)) {
    throw new ConfigError('memory-write', `origin must be one of ${ORIGINS.join(', ')}, got "${origin}"`)
  }
  const allowOriginOverride = optionalBoolean('memory-write', config, 'allowOriginOverride', false)
  const readOnly = optionalBoolean('memory-write', config, 'readOnly', false)
  return { hermesHome, origin, allowOriginOverride, readOnly }
}

/**
 * Build the tool description, naming the budget so the model plans for it.
 * @param {object} config - resolved config.
 * @returns {string} description.
 */
function describe(config) {
  return [
    `Read and write Hermes' long-term memory files (${Object.values(TARGETS).join(', ')}).`,
    `Every entry written here is tagged "${config.origin}" so the origin is visible when read back;`,
    'untagged entries were written by Hermes before tagging and count as "hermes".',
    'These files are a hard character budget — adding an entry past the limit is refused, so',
    'remove or shorten entries before growing the file.',
  ].join(' ')
}

/**
 * Mount the row.
 * @param {import('@deepseek-ai/cordis').Context} ctx - row context.
 * @param {Record<string, unknown>} rawConfig - row config.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  const tool = defineTool({
    name: 'memory',
    description: describe(config),
    parameters: {
      action: {
        type: 'string',
        description: 'What to do: list, add, patch, remove.',
        required: true,
        enum: ['list', 'add', 'patch', 'remove'],
      },
      target: {
        type: 'string',
        description: 'Which file: "memory" (agent notes) or "user" (who the user is).',
        required: true,
        enum: ['memory', 'user'],
      },
      text: {
        type: 'string',
        description: 'add: the entry to append. patch: the replacement text.',
      },
      old_text: {
        type: 'string',
        description: 'patch/remove: a substring identifying exactly one existing entry.',
      },
      origin: {
        type: 'string',
        description: `Origin tag to write (default "${config.origin}"). Only honoured when the row allows overrides.`,
        enum: ORIGINS,
      },
    },
    async execute(args) {
      const action = String(args?.action ?? '').trim()
      const target = String(args?.target ?? '').trim()
      if (!(target in TARGETS)) {
        throw new Error(`unknown target "${target}" — use "memory" or "user"`)
      }

      if (action === 'list') {
        const snapshot = await readTarget(config.hermesHome, target)
        return {
          path: snapshot.path,
          chars: snapshot.chars,
          limit: snapshot.limit,
          remaining: Math.max(0, snapshot.limit - snapshot.chars),
          entries: snapshot.entries.map((entry) => ({
            index: entry.index,
            origin: entry.origin,
            tagged: entry.tagged,
            text: entry.text,
          })),
        }
      }

      if (config.readOnly) {
        throw new Error('this row is read-only; set readOnly: false to allow writes')
      }

      const origin = resolveOrigin(config, args?.origin)

      if (action === 'add') {
        return addEntry(config.hermesHome, target, args?.text, origin)
      }
      if (action === 'patch') {
        if (typeof args?.text !== 'string' || args.text.trim() === '') {
          throw new Error('patch needs `text` with the replacement content')
        }
        return patchEntry(config.hermesHome, target, args?.old_text, args.text, origin)
      }
      if (action === 'remove') {
        return removeEntry(config.hermesHome, target, args?.old_text)
      }
      throw new Error(`unknown action "${action}" — use list, add, patch, or remove`)
    },
  })

  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.tools.register(tool), 'hermes-bridge: memory tool')
    report(ctx, `memory-write: "${tool.name}" registered (origin ${config.origin}${config.readOnly ? ', read-only' : ''})`)
  })
}

/**
 * Decide which origin a write carries.
 *
 * A model asking to write as `hermes` would launder its own words into the
 * other agent's voice, so the override is off by default and only honoured when
 * the row explicitly permits it.
 *
 * @param {object} config - resolved config.
 * @param {unknown} requested - the `origin` argument, if any.
 * @returns {string} origin tag.
 */
function resolveOrigin(config, requested) {
  const wanted = typeof requested === 'string' ? requested.trim() : ''
  if (wanted === '' || wanted === config.origin) return config.origin
  if (!ORIGINS.includes(wanted)) {
    throw new Error(`unknown origin "${wanted}" — use one of ${ORIGINS.join(', ')}`)
  }
  if (!config.allowOriginOverride) {
    throw new Error(
      `this row writes as "${config.origin}" and does not allow other origins; ` +
        `set allowOriginOverride: true on the row if that is really wanted`,
    )
  }
  return wanted
}

/** Re-export for the CLI and settings page. */
export { addEntry, patchEntry, readTarget, removeEntry }
export { expandHome, optionalString }
