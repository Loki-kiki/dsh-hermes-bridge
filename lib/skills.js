/**
 * `hermes-bridge/skills` — make Hermes' skill library usable in DSH.
 *
 * Hermes keeps ~200 skills under `<hermes-home>/skills`, nested by category
 * (`devops/dsh-harness/SKILL.md`). DSH's own filesystem provider discovers only
 * one level deep (`<root>/<name>/SKILL.md`), so pointing it at that tree would
 * find nothing. This row registers a real `ctx.skills` provider instead: DSH's
 * shipped `skill` tool then lists, searches and loads these skills exactly as it
 * does its own, including the resource-base hint that tells the model where the
 * skill's `references/` and `scripts/` live.
 *
 * Failure policy is deliberate: a skill with broken frontmatter is skipped with
 * a warning instead of vanishing silently, and a root read failure marks the
 * observation incomplete so the registry keeps its last good catalog rather
 * than believing every skill was deleted.
 *
 * @module dsh-hermes-bridge/skills
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ConfigError,
  expandHome,
  hermesHomeOf,
  optionalNumber,
  optionalString,
  optionalStringList,
  parseBooleanLoose,
  parseFrontmatter,
  readCached,
  rejectUnknownKeys,
  report,
  stripBom,
} from './util.js'

export const name = 'hermes-bridge/skills'

const KNOWN_KEYS = [
  'hermesHome',
  'dir',
  'providerName',
  'profile',
  'rank',
  'maxDepth',
  'includePrefix',
  'excludePrefix',
  'maxSkills',
  'descriptionMaxChars',
  'stateFile',
]

/** DSH's public skill-name grammar. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * One discovery pass over the Hermes skill tree.
 *
 * Shared by the provider and the CLI so `doctor` shows exactly what the harness
 * will see. Rejections are collected rather than logged, because the provider
 * stays quiet on the hot path while the CLI wants the detail.
 *
 * @param {object} options - discovery options.
 * @param {string} options.root - absolute skill root.
 * @param {number} [options.maxDepth] - directory depth to walk.
 * @param {string[]} [options.includePrefix] - only paths starting with one of these.
 * @param {string[]} [options.excludePrefix] - skip entries whose name starts with one of these.
 * @param {number} [options.maxSkills] - hard cap.
 * @param {number} [options.descriptionMaxChars] - clip long descriptions.
 * @param {Set<string>|string[]} [options.skipNames] - skill names the user switched off.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @returns {Promise<{root: string, candidates: object[], rejected: object[], categories: string[], complete: boolean}>} discovery result.
 */
export async function discoverSkills(options) {
  const root = options.root
  const maxDepth = options.maxDepth ?? 4
  const excludePrefix = options.excludePrefix ?? ['.', '_']
  const includePrefix = options.includePrefix ?? []
  const maxSkills = options.maxSkills ?? 1000
  const descriptionMaxChars = options.descriptionMaxChars ?? 900
  const skipNames = new Set(options.skipNames ?? [])
  const signal = options.signal
  const candidates = []
  const rejected = []
  const categories = new Set()
  let complete = true

  const accept = (file, folderName, parentDir, relPath, options = {}) => {
    signal?.throwIfAborted()
    const state = readCached(file)
    if (!state.exists) return
    const hasFrontmatter = stripBom(state.text).startsWith('---')
    const { data } = parseFrontmatter(state.text)
    const declared = typeof data.name === 'string' ? data.name.trim() : ''
    const description = typeof data.description === 'string' ? data.description.trim() : ''
    if (declared === '' && description === '' && options.optional === true) {
      // A loose Markdown file in the tree (a category README, a notes page)
      // is not a skill. Skipping it silently keeps `doctor` honest about the
      // difference between "not a skill" and "a broken skill".
      return
    }
    if (hasFrontmatter !== true && declared === '') {
      if (options.optional === true) return
      rejected.push({ path: file, reason: 'missing YAML frontmatter' })
      return
    }
    if (options.optional === true && declared === '' && options.categoryMeta === true) {
      // Hermes keeps a `<category>/DESCRIPTION.md` per skill category: a
      // frontmatter `description` with no `name`. That file describes the
      // category, it is not a callable skill, so it is not a rejection.
      return
    }
    const declaredName = declared !== '' ? declared : folderName
    if (!SKILL_NAME.test(declaredName)) {
      rejected.push({ path: file, reason: `invalid skill name "${declaredName}" (kebab-case required)` })
      return
    }
    if (skipNames.has(declaredName)) {
      // Switched off from the settings page. Not a rejection: the user asked for
      // this, so it must not show up in the "broken skill" count either.
      return
    }
    if (description === '') {
      rejected.push({ path: file, reason: 'frontmatter needs a description' })
      return
    }
    const whenToUse = typeof data.whenToUse === 'string' && data.whenToUse.trim() !== '' ? data.whenToUse.trim() : ''
    const category = relPath.includes(path.sep) ? relPath.slice(0, relPath.lastIndexOf(path.sep)) : ''
    if (category !== '') categories.add(category)
    candidates.push({
      name: declaredName,
      description: description.length > descriptionMaxChars ? `${description.slice(0, descriptionMaxChars)}…` : description,
      ...(whenToUse === '' ? {} : { whenToUse }),
      invocation: {
        modelInvocable: parseBooleanLoose(data['disable-model-invocation']) !== true,
        userInvocable: parseBooleanLoose(data['user-invocable']) !== false,
      },
      source: 'hermes',
      category,
      relPath,
      locator: { file, directory: parentDir },
      path: file,
    })
  }

  const visit = async (dir, depth, prefix) => {
    signal?.throwIfAborted()
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return
      throw error
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (candidates.length >= maxSkills) return
      const full = path.join(dir, entry.name)
      const relPath = prefix === '' ? entry.name : path.join(prefix, entry.name)
      if (entry.isDirectory()) {
        if (depth >= maxDepth) continue
        if (excludePrefix.some((mark) => entry.name.startsWith(mark))) continue
        if (includePrefix.length > 0 && !includePrefix.some((mark) => relPath.startsWith(mark))) continue
        if (fs.existsSync(path.join(full, 'SKILL.md'))) {
          accept(path.join(full, 'SKILL.md'), entry.name, full, relPath)
          // A bundle owns its tree; do not mine nested skills inside it.
          continue
        }
        await visit(full, depth + 1, relPath)
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      if (entry.name.toLowerCase() === 'skill.md') continue
      if (includePrefix.length > 0 && !includePrefix.some((mark) => relPath.startsWith(mark))) continue
      const baseName = entry.name.slice(0, -3).toLowerCase()
      accept(full, entry.name.slice(0, -3), dir, relPath, {
        optional: true,
        categoryMeta: baseName === 'description' || baseName === 'readme',
      })
    }
  }

  try {
    const stat = await fsp.stat(root)
    if (!stat.isDirectory()) {
      return { root, candidates: [], rejected: [{ path: root, reason: 'not a directory' }], categories: [], complete: false }
    }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { root, candidates: [], rejected: [], categories: [], complete: true }
    }
    throw error
  }
  try {
    await visit(root, 0, '')
  } catch (error) {
    if (signal?.aborted) throw error
    complete = false
    rejected.push({ path: root, reason: `discovery aborted: ${error?.message ?? error}` })
  }
  return { root, candidates, rejected, categories: [...categories].sort(), complete }
}

/**
 * Read this row's configuration and resolve every default.
 * @param {Record<string, unknown>} raw - row config from cordis.
 * @returns {object} resolved config.
 */
function resolveConfig(raw, ctx) {
  const config = raw ?? {}
  rejectUnknownKeys('skills', config, KNOWN_KEYS)
  const hermesHome = hermesHomeOf('skills', config)
  const dir = expandHome(optionalString('skills', config, 'dir', 'skills'), hermesHome)
  const providerName = optionalString('skills', config, 'providerName', 'hermes')
  if (providerName === 'runtime') throw new ConfigError('skills', 'providerName "runtime" is reserved by the skill registry')
  const stateFile = optionalString('skills', config, 'stateFile', '')
  // The settings page writes its per-skill switches to a file named after the
  // profile. Deriving it here (rather than hardcoding a path in the patch) keeps
  // the two rows pointed at the same file in every profile, including clones.
  // `profileContext` is only available on the row context, so a caller without
  // one falls back to config, then to the default profile name.
  const profileName = (() => {
    const fromContext = ctx?.get?.('profileContext')?.name
    if (typeof fromContext === 'string' && fromContext !== '') return fromContext
    return optionalString('skills', config, 'profile', 'desktop')
  })()
  return {
    hermesHome,
    dir,
    providerName,
    rank: optionalNumber('skills', config, 'rank', 350),
    maxDepth: optionalNumber('skills', config, 'maxDepth', 4),
    includePrefix: optionalStringList('skills', config, 'includePrefix', []),
    excludePrefix: optionalStringList('skills', config, 'excludePrefix', ['.', '_']),
    maxSkills: optionalNumber('skills', config, 'maxSkills', 1000),
    descriptionMaxChars: optionalNumber('skills', config, 'descriptionMaxChars', 900),
    // Empty means "read no skip list", which keeps the CLI and tests working
    // without a profile. The row always derives a real path.
    stateFile: stateFile === '' ? defaultStateFile(profileName) : expandHome(stateFile, hermesHome),
  }
}

/**
 * Where per-skill enable state lives for a profile.
 *
 * Next to the profile rather than inside the plugin: the plugin directory is a
 * linked working copy, and user state does not belong in a source tree.
 *
 * @param {string} profile - profile name.
 * @returns {string} absolute path.
 */
export function defaultStateFile(profile) {
  const root = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(root, 'profiles', profile, 'hermes-bridge-skills.json')
}

/**
 * Load one skill body. Always re-reads the file, so an edit on disk is visible
 * on the next load without invalidating anything.
 * @param {object} candidate - candidate produced by discovery.
 * @returns {Promise<object|undefined>} full skill definition, or undefined when the file went away.
 */
async function loadSkill(candidate) {
  let raw
  try {
    raw = await fsp.readFile(candidate.locator.file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  const { data, body } = parseFrontmatter(stripBom(raw))
  const description = typeof data.description === 'string' && data.description.trim() !== ''
    ? data.description.trim()
    : candidate.description
  const whenToUse = typeof data.whenToUse === 'string' && data.whenToUse.trim() !== '' ? data.whenToUse.trim() : undefined
  return {
    name: candidate.name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    invocation: candidate.invocation,
    source: candidate.source,
    provider: candidate.provider,
    resourceBase: { kind: 'directory', path: candidate.locator.directory },
    path: candidate.locator.file,
    content: body.trim(),
  }
}

/**
 * Mount the skills row.
 * @param {import('@deepseek-ai/cordis').Context} ctx - row context.
 * @param {Record<string, unknown>} rawConfig - row config.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig, ctx)
  const provider = {
    name: config.providerName,
    /**
     * @param {{cwd?: string, signal?: AbortSignal}} options - registry lookup options.
     * @returns {Promise<{candidates: object[], complete: boolean}>} provider observation.
     */
    async list(options = {}) {
      const result = await discoverSkills({
        root: config.dir,
        maxDepth: config.maxDepth,
        includePrefix: config.includePrefix,
        excludePrefix: config.excludePrefix,
        maxSkills: config.maxSkills,
        descriptionMaxChars: config.descriptionMaxChars,
        skipNames: await readSkipNames(),
        signal: options.signal,
      })
      for (const entry of result.rejected.slice(0, 20)) report(ctx, `skills: skipped ${entry.path} — ${entry.reason}`, 'warn')
      if (result.rejected.length > 20) report(ctx, `skills: ${result.rejected.length - 20} more skill(s) skipped`, 'warn')
      return {
        candidates: result.candidates.map((candidate) => ({
          name: candidate.name,
          description: candidate.description,
          ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
          invocation: candidate.invocation,
          source: candidate.source,
          provider: config.providerName,
          rank: config.rank,
          locator: candidate.locator,
          path: candidate.path,
        })),
        complete: result.complete,
      }
    },
    /**
     * @param {object} candidate - candidate returned by `list`.
     * @returns {Promise<object|undefined>} full skill definition.
     */
    async get(candidate) {
      return await loadSkill(candidate)
    },
  }

  /**
   * Names the user switched off on the settings page.
   *
   * Read on every `list()` rather than at apply time: the page writes the file
   * and then invalidates the catalog, so the next lookup must see the new list
   * without this row restarting. A missing or broken file means "nothing is off"
   * — never fail a skill lookup over a preference file.
   *
   * @returns {Promise<Set<string>>} names to omit.
   */
  async function readSkipNames() {
    if (config.stateFile === '') return new Set()
    try {
      const parsed = JSON.parse(await fsp.readFile(config.stateFile, 'utf8'))
      return new Set(Array.isArray(parsed?.disabled) ? parsed.disabled.filter((entry) => typeof entry === 'string') : [])
    } catch {
      return new Set()
    }
  }

  ctx.inject(['skills'], (scope) => {
    scope.effect(() => scope.skills.registerProvider((control) => {
      // Hand the invalidation hook to the settings row so a switch on the page
      // takes effect on the next turn. Without it the page would write the file
      // and the catalog would keep serving the old list until restart.
      const bridge = ctx.get?.('hermesBridgeControl')
      if (bridge !== undefined && bridge !== null) bridge.invalidate = () => control.invalidate()
      return provider
    }), 'hermes-bridge: skill provider')
    report(ctx, `skills: provider "${config.providerName}" serves ${config.dir}`)
  })
}
