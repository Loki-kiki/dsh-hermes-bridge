/**
 * Read-only views of Hermes' own runtime data: cron jobs and session history.
 *
 * These exist because DSH's `schedule` and `session_search` only see DSH's own
 * state. Hermes keeps its own cron jobs and session history that the model in a
 * DSH session otherwise cannot reach, which makes the persona feel like a
 * different assistant that happens to share a prompt.
 *
 * Both are strictly read-only. Writing to Hermes' cron would have to go through
 * its gateway, and two schedulers owning one jobs file is how you get jobs that
 * fire twice or never — not a trade worth making for a "create a job" convenience.
 *
 * @module dsh-hermes-bridge/hermes-data
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from './schema.js'
import { hermesHomeOf, report } from './util.js'

export const name = 'hermes-bridge/hermes-data'

/**
 * Read Hermes' cron jobs.
 * @param {string} hermesHome - Hermes home.
 * @returns {Promise<object[]>} jobs, newest-scheduled first.
 */
export async function readCronJobs(hermesHome) {
  const file = path.join(hermesHome, 'cron', 'jobs.json')
  let raw
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw new Error(`cannot read ${file}: ${error?.message ?? error}`)
  }
  const parsed = JSON.parse(raw)
  const jobs = Array.isArray(parsed) ? parsed : (parsed?.jobs ?? [])
  return jobs.map((job) => {
    const schedule = job?.schedule ?? {}
    return {
      id: job?.id,
      name: job?.name,
      // `display` is what Hermes' own UI shows; `expr` is the raw cron string.
      schedule: schedule.display ?? schedule.expr ?? (schedule.minutes ? `every ${schedule.minutes}m` : 'unknown'),
      kind: schedule.kind ?? 'cron',
      enabled: job?.enabled !== false,
      model: job?.model ?? null,
      // Script jobs run without a model; naming that saves a confusing "no prompt".
      script: job?.script ?? null,
      noAgent: job?.no_agent === true,
      prompt: typeof job?.prompt === 'string' ? job.prompt.slice(0, 200) : null,
    }
  })
}

/**
 * Open Hermes' session database for reading.
 *
 * `new DatabaseSync()` throws a native `ERR_SQLITE_ERROR` for a missing or
 * unreadable file, and that message reaches the model as-is — no path, no
 * remedy, no hint that the row's `hermesHome` is the thing to check. Wrapping
 * the open keeps the native error for the log while handing the caller a
 * sentence it can act on.
 *
 * @param {string} hermesHome - Hermes home.
 * @returns {Promise<import('node:sqlite').DatabaseSync>} open handle.
 */
async function openStateDb(hermesHome) {
  const file = path.join(hermesHome, 'state.db')
  const { DatabaseSync } = await import('node:sqlite')
  try {
    return new DatabaseSync(file, { readOnly: true })
  } catch (error) {
    throw new Error(
      `cannot open Hermes' session database (${file}): check the hermesHome setting, or confirm `
        + `Hermes has been initialized (${error?.message ?? error})`,
    )
  }
}

/**
 * Search Hermes' session history through its FTS index.
 *
 * Hermes stores sessions and messages in `state.db` with FTS5 tables. Querying
 * the FTS table directly is far cheaper than scanning, and it is the same index
 * Hermes' own `session_search` uses, so results match what the other agent sees.
 *
 * @param {string} hermesHome - Hermes home.
 * @param {string} query - FTS query (bare words are ANDed by FTS5).
 * @param {{limit?: number}} [options] - result bound.
 * @returns {Promise<object[]>} matching messages with their session.
 */
export async function searchSessions(hermesHome, query, options = {}) {
  const limit = Math.min(Math.max(1, options.limit ?? 20), 100)
  const db = await openStateDb(hermesHome)
  try {
    // `messages_fts` is contentless-linked to `messages`; joining on rowid gives
    // the text plus the session it belongs to in one pass.
    const statement = db.prepare(`
      SELECT
        m.session_id AS sessionId,
        s.title AS title,
        m.role AS role,
        snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet,
        m.timestamp AS timestamp
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      LEFT JOIN sessions s ON s.id = m.session_id
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `)
    const rows = statement.all(toFtsQuery(query), limit)
    return rows.map((row) => ({
      sessionId: row.sessionId,
      title: row.title ?? null,
      role: row.role,
      snippet: row.snippet,
      at: typeof row.timestamp === 'number' ? new Date(row.timestamp * 1000).toISOString() : null,
    }))
  } finally {
    db.close()
  }
}

/**
 * Turn user text into a safe FTS5 MATCH expression.
 *
 * FTS5 reads bare punctuation as syntax: a hyphen looks like a column qualifier
 * (`dsh-hermes-bridge` becomes "column dsh, term hermes"), which fails with
 * `no such column`. Wrapping each whitespace-separated token in double quotes
 * makes every token a literal phrase, so identifiers with hyphens, dots and
 * slashes search as written. A user-supplied quoted phrase is preserved as one
 * token so `"exact phrase"` still means what it looks like.
 *
 * @param {string} query - raw user query.
 * @returns {string} FTS5 expression.
 */
export function toFtsQuery(query) {
  const text = String(query ?? '').trim()
  if (text === '') return '""'
  const tokens = []
  const pattern = /"([^"]+)"|(\S+)/gu
  let match
  while ((match = pattern.exec(text)) !== null) {
    const token = (match[1] ?? match[2] ?? '').trim()
    if (token === '') continue
    // Double any embedded quote so the phrase stays well-formed.
    tokens.push(`"${token.replace(/"/gu, '""')}"`)
  }
  return tokens.length === 0 ? '""' : tokens.join(' ')
}

/**
 * Read one session's messages in order.
 * @param {string} hermesHome - Hermes home.
 * @param {string} sessionId - Hermes session id.
 * @param {{limit?: number, offset?: number}} [options] - page.
 * @returns {Promise<object>} session metadata and messages.
 */
export async function readSession(hermesHome, sessionId, options = {}) {
  const limit = Math.min(Math.max(1, options.limit ?? 40), 200)
  const offset = Math.max(0, options.offset ?? 0)
  const db = await openStateDb(hermesHome)
  try {
    const meta = db.prepare('SELECT id, title, source, model, started_at, message_count FROM sessions WHERE id = ?').get(sessionId)
    if (meta === undefined) throw new Error(`no Hermes session "${sessionId}"`)
    const rows = db.prepare(`
      SELECT role, content, tool_name, timestamp
      FROM messages
      WHERE session_id = ? AND active = 1
      ORDER BY id
      LIMIT ? OFFSET ?
    `).all(sessionId, limit, offset)
    return {
      session: {
        id: meta.id,
        title: meta.title ?? null,
        source: meta.source ?? null,
        model: meta.model ?? null,
        startedAt: typeof meta.started_at === 'number' ? new Date(meta.started_at * 1000).toISOString() : null,
        messageCount: meta.message_count ?? null,
      },
      offset,
      limit,
      messages: rows.map((row) => ({
        role: row.role,
        tool: row.tool_name ?? null,
        text: typeof row.content === 'string' ? row.content.slice(0, 4000) : '',
        at: typeof row.timestamp === 'number' ? new Date(row.timestamp * 1000).toISOString() : null,
      })),
    }
  } finally {
    db.close()
  }
}

/**
 * Mount the row.
 * @param {import('@deepseek-ai/cordis').Context} ctx - row context.
 * @param {Record<string, unknown>} rawConfig - row config.
 */
export function apply(ctx, rawConfig) {
  const home = hermesHomeOf('hermes-data', rawConfig ?? {})

  const cronTool = defineTool({
    name: 'hermes_cron',
    description:
      "List Hermes' scheduled jobs (read-only). Use when asked about timers, cron jobs, or periodic monitoring that lives in Hermes rather than DSH.",
    parameters: {
      filter: {
        type: 'string',
        description: 'Optional case-insensitive substring to match against job name or prompt.',
      },
    },
    async execute(args) {
      const jobs = await readCronJobs(home)
      const needle = String(args?.filter ?? '').trim().toLowerCase()
      const matched = needle === ''
        ? jobs
        : jobs.filter((job) =>
            `${job.name ?? ''} ${job.prompt ?? ''}`.toLowerCase().includes(needle),
          )
      return { total: jobs.length, matched: matched.length, jobs: matched }
    },
  })

  const searchTool = defineTool({
    name: 'hermes_session_search',
    description:
      "Search Hermes' past conversations (full-text, read-only). Use when the user refers to something discussed in Hermes rather than this DSH session.",
    parameters: {
      query: {
        type: 'string',
        description: 'Full-text query. Bare words are ANDed; quote a phrase to match it exactly.',
        required: true,
      },
      limit: {
        type: 'number',
        description: 'Maximum hits (default 20, max 100).',
      },
    },
    async execute(args) {
      const query = String(args?.query ?? '').trim()
      if (query === '') throw new Error('query is empty')
      const hits = await searchSessions(home, query, { limit: args?.limit })
      return { query, hits: hits.length, results: hits }
    },
  })

  const readTool = defineTool({
    name: 'hermes_session_read',
    description:
      "Read one Hermes session's messages by id (from hermes_session_search). Read-only; paginate with offset.",
    parameters: {
      session_id: {
        type: 'string',
        description: 'Hermes session id, as returned by hermes_session_search.',
        required: true,
      },
      limit: { type: 'number', description: 'Messages per page (default 40, max 200).' },
      offset: { type: 'number', description: 'Skip this many messages (default 0).' },
    },
    async execute(args) {
      const sessionId = String(args?.session_id ?? '').trim()
      if (sessionId === '') throw new Error('session_id is empty')
      return readSession(home, sessionId, { limit: args?.limit, offset: args?.offset })
    },
  })

  ctx.inject(['tools'], (scope) => {
    scope.effect(() => {
      const disposers = [cronTool, searchTool, readTool].map((tool) => scope.tools.register(tool))
      return () => {
        for (const dispose of disposers) dispose?.()
      }
    }, 'hermes-bridge: hermes data tools')
    report(ctx, 'hermes-data: hermes_cron, hermes_session_search, hermes_session_read registered (read-only)')
  })
}

