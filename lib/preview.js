/**
 * Render the persona and memory prompt texts for the CLI without mounting any
 * plugin. The row modules own the real rendering; this module only supplies the
 * config defaults the CLI needs, so `doctor` cannot drift from what the harness
 * actually injects.
 *
 * @module dsh-hermes-bridge/preview
 */

import path from 'node:path'
import { renderPersona } from './persona.js'
import { renderMemory } from './memory.js'
import { hermesHomeOf, expandHome, optionalNumber, optionalString, optionalStringList, optionalBoolean } from './util.js'

/**
 * Preview the persona or memory injection.
 * @param {object} options - preview options.
 * @param {string} options.hermesHome - resolved Hermes home.
 * @param {boolean} [options.memory] - preview memory instead of persona.
 * @returns {{text: string, bytes: number, files: string[], missing: string[]}} rendered preview.
 */
export function personaPreview(options) {
  const hermesHome = options.hermesHome
  if (options.memory === true) {
    const config = {
      hermesHome,
      dir: path.join(hermesHome, 'memories'),
      files: [path.join(hermesHome, 'memories', 'MEMORY.md'), path.join(hermesHome, 'memories', 'USER.md')],
      order: 6,
      maxBytes: 32768,
      header: 'Long-term memory carried over from Hermes.',
      withLabels: true,
      watch: true,
    }
    const rendered = renderMemory(config)
    return { text: rendered.text, bytes: rendered.bytes, files: rendered.files, missing: rendered.missing }
  }
  const config = {
    hermesHome,
    file: path.join(hermesHome, 'SOUL.md'),
    extraFiles: [],
    order: 5,
    maxBytes: 32768,
    header: '',
  }
  const rendered = renderPersona(config)
  return {
    text: rendered.text,
    bytes: Buffer.byteLength(rendered.text, 'utf8'),
    files: rendered.files,
    missing: rendered.missing,
  }
}

// Re-exported so a caller can build a config object without importing util.
export { hermesHomeOf, expandHome, optionalNumber, optionalString, optionalStringList, optionalBoolean }
