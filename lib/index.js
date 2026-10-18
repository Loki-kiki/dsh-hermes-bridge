/**
 * `dsh-hermes-bridge` — bring Hermes' persona, memory and skills into DSH.
 *
 * The bundle ships five independently switchable rows so the Plugins page can
 * turn each capability on or off instead of treating "Hermes integration" as
 * one all-or-nothing block:
 *
 * | Row | What it does |
 * |---|---|
 * | `hermes-bridge/persona`      | injects `SOUL.md` as a system-prompt section |
 * | `hermes-bridge/memory`       | injects `memories/MEMORY.md` + `USER.md`, tagged by origin |
 * | `hermes-bridge/memory-write` | the `memory` tool — appends/rewrites/removes entries, tagged `[dsh]` |
 * | `hermes-bridge/skills`       | registers a `ctx.skills` provider over the nested skill library |
 * | `hermes-bridge/viking`       | exposes the OpenViking knowledge base as tools |
 * | `hermes-bridge/mcp`          | keeps Hermes' MCP servers mounted and reports drift |
 * | `hermes-bridge/hermes-data`  | read-only cron list + Hermes session search |
 *
 * Plus a row that is not a capability but the control surface:
 * `hermes-bridge/settings` serves the settings page's API.
 *
 * ## Why this file has an `apply` at all
 *
 * DSH attaches a package's browser half (`dsh.client`) to the loader row whose
 * specifier is the **bare package name** — `exactPackageSpecifier()` returns
 * `undefined` for any subpath, so a bundle whose patch only inserts
 * `my-pkg/persona`, `my-pkg/memory`, … gets no client bundle loaded and its
 * settings section never appears. The rows above are all subpaths, so this bare
 * row exists to carry the browser half. It deliberately mounts nothing itself:
 * duplicating a row's behaviour here would make that capability impossible to
 * switch off.
 *
 * @module dsh-hermes-bridge
 */

export const name = 'hermes-bridge'

/**
 * The bare-package row. Intentionally inert — see the note above.
 *
 * An `apply` that registers nothing looks like a mistake, so it says so in the
 * log rather than leaving the next reader to rediscover the reason.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - row context.
 */
export function apply(ctx) {
  ctx.logger?.info?.('hermes-bridge: host row loaded (carries the settings UI; capabilities live in their own rows)')
}

export { apply as applyPersona, name as personaName } from './persona.js'
export { apply as applyMemory, name as memoryName } from './memory.js'
export { apply as applyMemoryWrite, name as memoryWriteName } from './memory-write.js'
export { apply as applySkills, name as skillsName } from './skills.js'
export { apply as applyMcp, name as mcpName } from './mcp.js'
export { apply as applyViking, name as vikingName } from './viking.js'
export { apply as applyHermesData, name as hermesDataName } from './hermes-data.js'
export { apply as applySettings, name as settingsName } from './settings.js'
export { syncProfile, readHermesServers, renderBlock, spliceBlock, profilePaths } from './mcp-sync.js'
export {
  ENTRY_DELIMITER,
  ORIGINS,
  TARGETS,
  addEntry,
  patchEntry,
  readOrigin,
  readTarget,
  removeEntry,
} from './memory-store.js'
