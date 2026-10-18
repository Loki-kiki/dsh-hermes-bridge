/**
 * `hermes-bridge/provider` — mount *whatever memory provider Hermes is using*.
 *
 * This row is the general form of `hermes-bridge/viking`. That row hand-wrote an
 * OpenViking client in JavaScript; it works, but it only ever covers OpenViking.
 * Hermes' memory backends are Python plugins behind one contract — openviking,
 * retaindb and byterover ship in-tree, and the plugin catalog carries dozens
 * more (honcho, mem0, hindsight, supermemory, lancedb, cognee, …). Every one of
 * them is already loadable by Hermes, so this row simply asks Hermes which one
 * is configured, takes its tool schemas, and forwards calls to it.
 *
 * Why the indirection is worth it:
 *
 * - **No drift.** A provider that changes an endpoint changes it in Hermes only.
 *   A JS re-implementation would silently keep calling the old route.
 * - **No per-provider work.** Installing honcho in Hermes makes it appear here
 *   with zero bridge changes, and a provider that ships next month does too.
 * - **Same tools, same names.** The model sees exactly the tool names Hermes
 *   uses, so a habit learned in one harness transfers.
 *
 * The cost is one Python process, started on first use and reused afterwards.
 *
 * ## Which row should a user enable?
 *
 * `viking` and `provider` overlap when the configured provider *is* OpenViking.
 * Registering the same tool name twice is an error in DSH, not a merge, so this
 * row skips any name the `viking` row already claimed and says so in its log.
 * The rule is: `provider` is the general one (keep it), `viking` is the
 * OpenViking-specialised one (keep it if you want its viking://-aware read
 * levels and scoped search; turn it off to see the provider's own schemas).
 *
 * Failure policy: an unreachable backend, an unconfigured provider, or a missing
 * Python never breaks boot. The row reports what is wrong, registers nothing,
 * and the rest of the bridge keeps working.
 *
 * @module dsh-hermes-bridge/provider
 */

import fs from 'node:fs'
import path from 'node:path'
import { claim, ownerOf, release } from './claims.js'
import { defineToolFromSchema } from './schema.js'
import {
  ProviderWorker,
  defaultAgentRoot,
  defaultPython,
  isRunnable,
  probeProviderSync,
} from './provider-bridge.js'
import {
  ConfigError,
  hermesHomeOf,
  optionalBoolean,
  optionalNumber,
  optionalString,
  rejectUnknownKeys,
  report,
} from './util.js'

export const name = 'hermes-bridge/provider'

const KNOWN_KEYS = [
  'hermesHome',
  'agentRoot',
  'python',
  'provider',
  'order',
  'header',
  'timeoutMs',
  'probeTimeoutMs',
  'maxTools',
  'enablePrompt',
  'skipTools',
]

const DEFAULT_HEADER = 'Memory backend bridged from Hermes. Its tools are the ones Hermes itself would expose; use them to search, read and write that store.'

/**
 * Read a string key where an empty value is meaningful.
 *
 * `optionalString` rejects `''` — right for paths and endpoints, wrong for
 * `provider`, where empty is the *default and most useful* value ("follow
 * whatever Hermes has configured"). Passing it through `optionalString` made the
 * shipped default fail validation, so the row could never mount with the config
 * it ships. This reader keeps the empty case as data instead of an error.
 *
 * @param {Record<string, unknown>} config - row config.
 * @param {string} key - key to read.
 * @returns {string} the value, `''` when absent or empty.
 */
function optionalText(config, key) {
  const value = config[key]
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new ConfigError('provider', `${key} must be a string, got ${JSON.stringify(value)}`)
  }
  return value.trim()
}

/**
 * Read this row's configuration and resolve every default.
 *
 * `provider: ''` means "whatever Hermes has configured" — the normal case, and
 * the one that makes this row work on someone else's machine without editing
 * anything. Naming a provider explicitly is for trying a backend the user has
 * not switched Hermes to.
 *
 * @param {Record<string, unknown>} raw - row config from cordis.
 * @returns {object} resolved config.
 */
export function resolveConfig(raw) {
  const config = raw ?? {}
  rejectUnknownKeys('provider', config, KNOWN_KEYS)
  const hermesHome = hermesHomeOf('provider', config)
  const agentRoot = optionalString('provider', config, 'agentRoot', defaultAgentRoot(hermesHome))
  const python = optionalString('provider', config, 'python', defaultPython(agentRoot))
  const timeoutMs = optionalNumber('provider', config, 'timeoutMs', 60000)
  const probeTimeoutMs = optionalNumber('provider', config, 'probeTimeoutMs', 60000)
  if (timeoutMs < 1000) throw new ConfigError('provider', `timeoutMs must be at least 1000, got ${timeoutMs}`)
  if (probeTimeoutMs < 1000) throw new ConfigError('provider', `probeTimeoutMs must be at least 1000, got ${probeTimeoutMs}`)
  return {
    hermesHome,
    agentRoot,
    python,
    provider: optionalText(config, 'provider'),
    order: optionalNumber('provider', config, 'order', 7),
    header: optionalString('provider', config, 'header', DEFAULT_HEADER),
    timeoutMs,
    probeTimeoutMs,
    maxTools: optionalNumber('provider', config, 'maxTools', 40),
    enablePrompt: optionalBoolean('provider', config, 'enablePrompt', true),
    skipTools: Array.isArray(config.skipTools)
      ? config.skipTools.filter((entry) => typeof entry === 'string')
      : [],
  }
}

/**
 * Explain why this row cannot run, in one sentence a user can act on.
 *
 * A missing Python or a missing agent tree is a *setup* problem, and the answer
 * differs per platform, so the message names the exact path that was checked.
 *
 * @param {object} config - resolved config.
 * @returns {string} empty when everything needed exists.
 */
export function diagnoseEnvironment(config) {
  if (!fs.existsSync(config.hermesHome)) {
    return `Hermes home not found at ${config.hermesHome} — set hermesHome on this row (or HERMES_HOME) to the directory holding config.yaml`
  }
  if (!fs.existsSync(config.agentRoot)) {
    return `Hermes agent tree not found at ${config.agentRoot} — it should contain plugins/memory/. Set agentRoot on this row if Hermes lives elsewhere`
  }
  if (!isRunnable(config.python)) {
    return `Python interpreter not found (${config.python}) — set python on this row, e.g. ${defaultPython(config.agentRoot)}`
  }
  if (!fs.existsSync(path.join(config.agentRoot, 'plugins', 'memory'))) {
    return `${config.agentRoot} has no plugins/memory directory — is this really the Hermes agent root?`
  }
  return ''
}

/**
 * Mount the row.
 * @param {import('@deepseek-ai/cordis').Context} ctx - row context.
 * @param {Record<string, unknown>} rawConfig - row config.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  const environmentError = diagnoseEnvironment(config)
  if (environmentError !== '') {
    // A setup problem is worth a loud line, but not a thrown error: the other
    // rows still work and the settings page is what fixes this one.
    report(ctx, `provider: not mounted — ${environmentError}`, 'warn')
    return
  }

  const probe = probeProviderSync(config)
  for (const line of String(probe.error ?? '').split('\n')) {
    if (line.trim() !== '') report(ctx, `provider worker: ${line.trim()}`, 'info')
  }

  if (probe.tools.length === 0) {
    const reason = probe.reason !== '' ? probe.reason : (probe.error !== '' ? probe.error : 'the provider exposes no tools')
    report(ctx, `provider: nothing to mount — ${reason}`, 'warn')
    return
  }

  const skip = new Set(config.skipTools)
  // The `viking` row registers viking_* itself; two rows claiming one tool name
  // is a hard error in the tool registry, so the specialised row wins and this
  // one reports what it left out rather than failing to mount.
  const selected = probe.tools
    .filter((tool) => !skip.has(tool.name) && ownerOf(tool.name) === undefined)
    .slice(0, config.maxTools)
  const leftToOthers = probe.tools.filter((tool) => ownerOf(tool.name) !== undefined && !skip.has(tool.name)).length

  if (selected.length === 0) {
    report(ctx, `provider: every tool from ${probe.provider} is skipped or claimed by another row`, 'warn')
    return
  }

  const worker = new ProviderWorker(config, (message, level) => report(ctx, `provider worker: ${message}`, level))

  // Claimed before `ctx.inject` for the same reason as the viking row: inject
  // callbacks are unordered across rows, so ownership has to be decided by
  // patch order rather than by whichever service happens to appear first.
  claim('hermes-bridge-provider', selected.map((tool) => tool.name))

  const tools = selected.map((tool) => defineToolFromSchema({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(args, exec) {
      const answer = await worker.request('call', { name: tool.name, args: args ?? {} }, config.timeoutMs)
      if (answer.ok !== true) {
        // An error is data, not a thrown exception: the model can relay a
        // sentence, and a provider outage must not look like a broken harness.
        return { error: String(answer.error ?? 'the provider call failed') }
      }
      void exec
      return answer.result
    },
  }))

  ctx.inject(['tools'], (scope) => {
    for (const tool of tools) {
      scope.effect(() => scope.tools.register(tool), `hermes-bridge: ${tool.name}`)
    }
    report(ctx, `provider: ${tools.length} tool(s) from ${probe.provider}${leftToOthers > 0 ? ` (${leftToOthers} left to another row)` : ''}`)
  })

  if (config.enablePrompt && typeof probe.prompt === 'string' && probe.prompt.trim() !== '') {
    ctx.inject(['systemPrompt'], (scope) => {
      scope.effect(() => scope.systemPrompt.section({
        name: 'hermes-bridge:provider',
        order: config.order,
        interpolate: false,
        text: `${config.header.trim()}\n\n${probe.prompt.trim()}`,
      }), 'hermes-bridge: provider section')
      report(ctx, `provider: prompt section from ${probe.provider} (${probe.prompt.length} chars)`)
    })
  }

  // Stop the worker when the row unloads; otherwise a recompose leaks a Python
  // process per reload, and the profile keeps a child it can no longer talk to.
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      release('hermes-bridge-provider')
      void worker.shutdown()
    })
  }
}

/** Exported for the CLI and the settings page. */
export { probeProviderSync }
