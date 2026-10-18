/**
 * `hermes-bridge/persona` — inject Hermes' SOUL.md as this agent's identity.
 *
 * Hermes keeps the persona in `<hermes-home>/SOUL.md`. DSH's deployment persona
 * slot (`deployment:persona-prefix`) belongs to `dsh-system-prompt` and to
 * agent presets, so this row does not fight for it: it registers an ordinary
 * ordered prompt section that renders the SOUL text verbatim right after the
 * prefix. That keeps preset switching working while still replacing the model's
 * sense of who it is.
 *
 * The section is registered as a static string on purpose: identity text that
 * mutates mid-session would invalidate every prompt-cache prefix for a gain
 * nobody asked for. Editing SOUL.md takes effect on the next profile reload.
 *
 * @module dsh-hermes-bridge/persona
 */

import path from 'node:path'
import {
  ConfigError,
  expandHome,
  hermesHomeOf,
  optionalNumber,
  optionalString,
  optionalStringList,
  readCached,
  rejectUnknownKeys,
  report,
} from './util.js'

export const name = 'hermes-bridge/persona'

const KNOWN_KEYS = ['hermesHome', 'file', 'extraFiles', 'order', 'maxBytes', 'header']

/**
 * Read this row's configuration and resolve every default.
 * @param {Record<string, unknown>} raw - row config from cordis.
 * @returns {{hermesHome: string, file: string, extraFiles: string[], order: number, maxBytes: number, header: string}} resolved config.
 */
function resolveConfig(raw) {
  const config = raw ?? {}
  rejectUnknownKeys('persona', config, KNOWN_KEYS)
  const hermesHome = hermesHomeOf('persona', config)
  const file = expandHome(optionalString('persona', config, 'file', 'SOUL.md'), hermesHome)
  const extraFiles = optionalStringList('persona', config, 'extraFiles', []).map((entry) => expandHome(entry, hermesHome))
  const order = optionalNumber('persona', config, 'order', 5)
  const maxBytes = optionalNumber('persona', config, 'maxBytes', 32768)
  if (maxBytes < 512) throw new ConfigError('persona', `maxBytes must be at least 512, got ${maxBytes}`)
  const header = optionalString(
    'persona',
    config,
    'header',
    'The following is your identity, written by the person you are talking to. It overrides any conflicting default persona above.',
  )
  return { hermesHome, file, extraFiles, order, maxBytes, header }
}

/**
 * Render the persona prompt text from the configured files.
 * @param {ReturnType<typeof resolveConfig>} config - resolved config.
 * @returns {{text: string, files: string[], missing: string[]}} rendered text and diagnostics.
 */
export function renderPersona(config) {
  const parts = []
  const files = []
  const missing = []
  for (const file of [config.file, ...config.extraFiles]) {
    const state = readCached(file)
    if (!state.exists) {
      missing.push(file)
      continue
    }
    const body = state.text.trim()
    if (body === '') {
      missing.push(file)
      continue
    }
    files.push(file)
    parts.push(body)
  }
  if (parts.length === 0) return { text: '', files, missing }
  let text = `${config.header.trim()}\n\n${parts.join('\n\n---\n\n')}`
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > config.maxBytes) {
    const cut = Buffer.from(text, 'utf8').subarray(0, config.maxBytes).toString('utf8')
    text = `${cut}\n\n[persona truncated at ${config.maxBytes} bytes]`
  }
  return { text, files, missing }
}

/**
 * Mount the persona row.
 * @param {import('@deepseek-ai/cordis').Context} ctx - row context.
 * @param {Record<string, unknown>} rawConfig - row config.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const rendered = renderPersona(config)
  if (rendered.text === '') {
    report(ctx, `persona: nothing to inject — ${config.file} is missing or empty`, 'warn')
    return
  }
  for (const file of rendered.missing) report(ctx, `persona: skipped unreadable file ${file}`, 'warn')
  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.section({
      name: 'hermes-bridge:persona',
      order: config.order,
      interpolate: false,
      text: rendered.text,
    }), 'hermes-bridge: persona section')
    report(ctx, `persona: injected ${Buffer.byteLength(rendered.text, 'utf8')} bytes from ${path.basename(config.file)}`)
  })
}
