/**
 * `hermes-bridge/viking` — give DSH the OpenViking knowledge base as tools.
 *
 * Why this is a separate row from `memory`: they are different mechanisms, not
 * two views of one store.
 *
 * - `memory` reads `MEMORY.md` / `USER.md` — plain text, injected into every
 *   request, always in context, no query needed.
 * - OpenViking is a vector store behind `http://127.0.0.1:1933`. Nothing is
 *   injected for free; the model has to **search** to see anything, and what it
 *   gets back is tiered (L0 abstract / L1 overview / L2 full) so a broad question
 *   costs an abstract while a narrow one can pull a whole file.
 *
 * DSH's MCP bridge would work here if OpenViking shipped an MCP server, but it
 * ships a plain REST API. So this row registers real `ctx.tools` tools that speak
 * that API directly: one connection, one error surface, no extra process — and
 * the tool names mirror Hermes' own (`viking_search`, `viking_read`, …) so a
 * habit learned in one harness transfers to the other.
 *
 * The API shapes below are not guesses: they mirror what Hermes' own OpenViking
 * provider does (`plugins/openviking/__init__.py`), which is the reference client
 * for this server.
 *
 * Failure policy: a dead endpoint must not break boot. The tools exist, and
 * calling one returns a clear "endpoint unreachable" answer the model can relay,
 * instead of the whole plugin failing to activate.
 *
 * @module dsh-hermes-bridge/viking
 */

import { defineTool } from './schema.js'
import {
  ConfigError,
  hermesHomeOf,
  optionalBoolean,
  optionalNumber,
  optionalString,
  rejectUnknownKeys,
  report,
} from './util.js'

export const name = 'hermes-bridge/viking'

const KNOWN_KEYS = [
  'hermesHome',
  'endpoint',
  'account',
  'user',
  'agent',
  'apiKey',
  'timeoutMs',
  'recallLimit',
  'scoreThreshold',
  'enableRead',
  'enableBrowse',
  'enableRemember',
]

/** Defaults mirror Hermes' own `memory.openviking` section, minus the tenant name. */
const DEFAULTS = {
  endpoint: 'http://127.0.0.1:1933',
  account: 'default',
  // Empty on purpose: the package ships no tenant name, and guessing one would
  // scope reads and writes to someone else's tree. The tools report the missing
  // setting when they are called, which is visible; mis-scoping is not.
  user: '',
  agent: 'hermes',
  timeoutMs: 30000,
  recallLimit: 10,
  scoreThreshold: 0.3,
}

/** Result buckets the search endpoints return, in reading order. */
const CONTEXT_TYPES = ['memories', 'resources', 'skills']

/**
 * Read `user`, where an empty value is a valid "not configured yet" state.
 *
 * Every other string key must be non-empty, but `user` cannot be: it names an
 * OpenViking tenant, and there is no default tenant that is safe to write to.
 * The tool calls check it and answer with the reason instead of sending a
 * request scoped to the wrong owner.
 *
 * @param {Record<string, unknown>} config - row config.
 * @returns {string} the configured user, or '' when absent.
 */
function optionalUser(config) {
  const value = config.user
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new ConfigError('viking', `user must be a string, got ${JSON.stringify(value)}`)
  }
  return value.trim()
}

/**
 * Read this row's configuration and resolve every default.
 * @param {Record<string, unknown>} raw - row config from cordis.
 * @returns {object} resolved config.
 */
function resolveConfig(raw) {
  const config = raw ?? {}
  rejectUnknownKeys('viking', config, KNOWN_KEYS)
  const endpoint = optionalString('viking', config, 'endpoint', DEFAULTS.endpoint).replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(endpoint)) {
    throw new ConfigError('viking', `endpoint must be an http(s) URL, got ${JSON.stringify(endpoint)}`)
  }
  return {
    hermesHome: hermesHomeOf('viking', config),
    endpoint,
    account: optionalString('viking', config, 'account', DEFAULTS.account),
    user: optionalUser(config),
    agent: optionalString('viking', config, 'agent', DEFAULTS.agent),
    apiKey: optionalString('viking', config, 'apiKey', ''),
    timeoutMs: optionalNumber('viking', config, 'timeoutMs', DEFAULTS.timeoutMs),
    recallLimit: optionalNumber('viking', config, 'recallLimit', DEFAULTS.recallLimit),
    scoreThreshold: optionalNumber('viking', config, 'scoreThreshold', DEFAULTS.scoreThreshold),
    enableRead: optionalBoolean('viking', config, 'enableRead', true),
    enableBrowse: optionalBoolean('viking', config, 'enableBrowse', true),
    enableRemember: optionalBoolean('viking', config, 'enableRemember', true),
  }
}

/**
 * One HTTP call against the OpenViking REST API.
 *
 * The API answers `{status:"ok", result:…}` on success and
 * `{status:"error", error:{code,message}}` on failure — both with HTTP 200 in
 * plenty of cases, so the envelope, not the status code, decides success.
 *
 * @param {object} config - resolved row config.
 * @param {string} method - `GET` or `POST`.
 * @param {string} route - path after the endpoint, e.g. `/api/v1/search/find`.
 * @param {object} [options] - call options.
 * @param {Record<string, unknown>} [options.query] - query string parameters.
 * @param {object} [options.body] - JSON body.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @returns {Promise<{ok: boolean, result?: unknown, error?: string}>} unwrapped result.
 */
async function callApi(config, method, route, options = {}) {
  if (config.user === '') {
    return {
      ok: false,
      error: 'OpenViking user is not configured — set `user` in the hermes-bridge-viking row '
        + 'to the tenant that owns the memories (Hermes stores it as memory.openviking.user)',
    }
  }
  const url = new URL(`${config.endpoint}${route}`)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), config.timeoutMs)
  const onAbort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) onAbort()
  else options.signal?.addEventListener?.('abort', onAbort, { once: true })
  const headers = {
    'Content-Type': 'application/json',
    'X-OpenViking-Account': config.account,
    'X-OpenViking-User': config.user,
    'X-OpenViking-Agent': config.agent,
  }
  if (config.apiKey !== '') headers['X-API-Key'] = config.apiKey
  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    })
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      return { ok: false, error: `OpenViking returned non-JSON (HTTP ${response.status}): ${text.slice(0, 300)}` }
    }
    if (payload?.status === 'error') {
      const code = payload.error?.code ?? 'ERROR'
      const message = payload.error?.message ?? 'unknown error'
      return { ok: false, error: `${code}: ${message}` }
    }
    if (payload?.status !== 'ok') {
      return { ok: false, error: `unexpected envelope from ${route} (HTTP ${response.status})` }
    }
    return { ok: true, result: payload.result }
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { ok: false, error: options.signal?.aborted ? 'cancelled' : `OpenViking did not answer within ${config.timeoutMs} ms` }
    }
    const cause = error?.cause?.code ?? error?.code ?? ''
    return {
      ok: false,
      error: `cannot reach OpenViking at ${config.endpoint}${cause === '' ? '' : ` (${cause})`}`
        + ' — start the server, or fix `endpoint` in the hermes-bridge-viking row',
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * Flatten a search envelope into one ranked list.
 *
 * `find` / `search` answer `{memories:[…], resources:[…], skills:[…], total}`
 * rather than one array, so the buckets are merged here — the model should not
 * have to know which bucket a memory landed in to judge relevance.
 *
 * @param {any} result - the envelope's `result`.
 * @param {number} scoreThreshold - drop hits below this.
 * @returns {object[]} ranked, compacted hits.
 */
function flattenHits(result, scoreThreshold) {
  const rows = []
  for (const type of CONTEXT_TYPES) {
    const bucket = result?.[type]
    if (!Array.isArray(bucket)) continue
    for (const item of bucket) {
      const score = typeof item?.score === 'number' ? item.score : 0
      if (score < scoreThreshold) continue
      rows.push({
        uri: item?.uri ?? '',
        type: type.replace(/s$/, ''),
        score: Number(score.toFixed(3)),
        abstract: typeof item?.abstract === 'string' ? item.abstract.slice(0, 1200) : undefined,
        ...(Array.isArray(item?.relations) && item.relations.length > 0
          ? { related: item.relations.slice(0, 3).map((relation) => relation?.uri).filter((uri) => typeof uri === 'string') }
          : {}),
      })
    }
  }
  return rows.filter((row) => row.uri !== '').sort((left, right) => right.score - left.score)
}

/**
 * Whether a viking:// URI names a directory.
 *
 * The summary endpoints only work on directories (the server answers 500 for
 * files), so a read has to route by this. A `fs/stat` failure is treated as
 * "not a directory" and the caller falls back to a full read.
 *
 * @param {object} config - resolved row config.
 * @param {string} uri - viking:// URI.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<boolean>} true when the URI is a directory.
 */
async function isDirectory(config, uri, signal) {
  const response = await callApi(config, 'GET', '/api/v1/fs/stat', { query: { uri }, signal })
  if (!response.ok) return false
  return response.result?.isDir === true
}

/**
 * Build the tool definitions for this row.
 * @param {object} config - resolved row config.
 * @returns {object[]} `ctx.tools.register()` inputs.
 */
function buildTools(config) {
  const tools = []

  tools.push(defineTool({
    name: 'viking_search',
    description: 'Semantic search over the OpenViking knowledge base (durable memories, resources, skills). '
      + 'Returns ranked hits with viking:// URIs and a short abstract each; read one with viking_read for more. '
      + 'Search here before asking the user to repeat something they told you in an earlier session.',
    parameters: {
      query: { type: 'string', required: true, description: 'What to look for, in natural language.' },
      scope: { type: 'string', description: 'Optional viking:// URI prefix to search inside. Call viking_browse on viking:// first to see which roots exist.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: `How many hits (default ${config.recallLimit}).` },
      mode: {
        type: 'string',
        enum: ['auto', 'deep'],
        description: 'auto = fast semantic find (default). deep = session-aware search, slower, better for broad questions.',
      },
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const query = String(args.query ?? '').trim()
      if (query === '') return { error: 'query is required' }
      const deep = args.mode === 'deep'
      const response = await callApi(config, 'POST', deep ? '/api/v1/search/search' : '/api/v1/search/find', {
        body: {
          query,
          ...(args.scope === undefined ? {} : { target_uri: args.scope }),
          limit: args.limit ?? config.recallLimit,
        },
        signal: exec?.signal,
      })
      if (!response.ok) return { error: response.error }
      const hits = flattenHits(response.result, config.scoreThreshold)
      return {
        query,
        mode: deep ? 'deep' : 'auto',
        count: hits.length,
        total: response.result?.total ?? hits.length,
        results: hits,
      }
    },
  }))

  if (config.enableRead) {
    tools.push(defineTool({
      name: 'viking_read',
      description: 'Read exact viking:// URIs returned by viking_search or viking_browse. '
        + 'Levels: abstract (L0, a few lines — directories only), overview (L1, structure plus key points — directories only), '
        + 'full (L2, the whole file — always works). For a file URI the read falls back to full automatically.',
      parameters: {
        uri: { type: 'string', description: 'One viking:// URI to read.' },
        uris: { type: 'array', items: { type: 'string' }, description: 'Batch of up to three URIs instead of `uri`.' },
        level: { type: 'string', enum: ['abstract', 'overview', 'full'], description: 'Detail level (default overview).' },
      },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        const uris = args.uris ?? (args.uri === undefined ? [] : [args.uri])
        if (uris.length === 0) return { error: 'pass `uri` or `uris`' }
        if (uris.length > 3) return { error: 'at most three URIs per call' }
        const level = args.level ?? 'overview'
        const out = []
        for (const raw of uris) {
          const uri = String(raw)
          if (!uri.startsWith('viking://')) {
            out.push({ uri, error: 'not a viking:// URI' })
            continue
          }
          // Summary endpoints answer 500 for files; route those straight to a
          // full read instead of surfacing a server error the model cannot act on.
          const summaryLevel = level === 'abstract' || level === 'overview'
          const directory = summaryLevel ? await isDirectory(config, uri, exec?.signal) : false
          const route = level === 'full' || !directory
            ? '/api/v1/content/read'
            : level === 'abstract' ? '/api/v1/content/abstract' : '/api/v1/content/overview'
          const response = await callApi(config, 'GET', route, { query: { uri }, signal: exec?.signal })
          if (!response.ok) {
            out.push({ uri, error: response.error })
            continue
          }
          const value = response.result
          const text = typeof value === 'string'
            ? value
            : (value?.content ?? value?.text ?? value?.abstract ?? null)
          out.push({
            uri,
            level: route === '/api/v1/content/read' ? 'full' : level,
            ...(text === null ? { raw: value } : { content: String(text) }),
          })
        }
        return { results: out }
      },
    }))
  }

  if (config.enableBrowse) {
    tools.push(defineTool({
      name: 'viking_browse',
      description: 'List a viking:// directory (like ls, with one-line abstracts) to discover what the knowledge base holds. '
        + 'Use it when you do not know the right query yet, then switch to viking_search.',
      parameters: {
        path: { type: 'string', description: 'viking:// directory URI (default viking://).' },
        depth: { type: 'integer', minimum: 1, maximum: 6, description: 'How deep to walk (default 2).' },
      },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        const uri = String(args.path ?? 'viking://')
        if (!uri.startsWith('viking://')) return { error: 'path must be a viking:// URI' }
        const response = await callApi(config, 'GET', '/api/v1/fs/tree', {
          query: { uri, depth: args.depth ?? 2 },
          signal: exec?.signal,
        })
        if (!response.ok) return { error: response.error }
        const entries = Array.isArray(response.result) ? response.result : []
        return {
          path: uri,
          count: entries.length,
          entries: entries.slice(0, 200).map((entry) => ({
            uri: entry?.uri ?? '',
            dir: entry?.isDir === true,
            size: entry?.size,
            abstract: typeof entry?.abstract === 'string' && entry.abstract !== '' ? entry.abstract.slice(0, 200) : undefined,
          })),
        }
      },
    }))
  }

  if (config.enableRemember) {
    tools.push(defineTool({
      name: 'viking_remember',
      description: 'Store a durable fact, preference or conclusion in OpenViking so a later session can recall it. '
        + 'Write one self-contained statement per call — no pronouns pointing at the current conversation.',
      parameters: {
        content: { type: 'string', required: true, description: 'The fact to remember, self-contained.' },
        path: { type: 'string', description: 'Optional target viking:// file URI. Defaults to a timestamped file under memories/inbox/.' },
      },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        const content = String(args.content ?? '').trim()
        if (content === '') return { error: 'content is required' }
        const uri = args.path ?? `viking://user/${config.user}/memories/inbox/${Date.now()}.md`
        const response = await callApi(config, 'POST', '/api/v1/content/write', {
          body: { uri, content },
          signal: exec?.signal,
        })
        if (!response.ok) return { error: response.error, uri }
        return { written: true, uri, result: response.result }
      },
    }))
  }

  return tools
}

/**
 * Mount the OpenViking row.
 * @param {import('@deepseek-ai/cordis').Context} ctx - row context.
 * @param {Record<string, unknown>} rawConfig - row config.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const tools = buildTools(config)
  ctx.inject(['tools'], (scope) => {
    for (const tool of tools) scope.effect(() => scope.tools.register(tool), `hermes-bridge: ${tool.name}`)
    report(ctx, `viking: ${tools.length} tool(s) → ${config.endpoint} (account ${config.account}, user ${config.user === '' ? 'unset' : config.user})`)
  })
}
