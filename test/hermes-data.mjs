/**
 * Live checks for the read-only Hermes data views.
 *
 * Unlike `memory-store.mjs`, these read the *real* Hermes home — the point is to
 * prove the bridge can reach cron jobs and session history at all, which a
 * fixture cannot show. Every check is read-only, but it still reads somebody's
 * machine, so it only runs when asked:
 *
 *   LIVE_TESTS=1 node test/hermes-data.mjs
 */

import assert from 'node:assert/strict'

import { readCronJobs, searchSessions, readSession } from '../lib/hermes-data.js'
import { resolveHermesHome } from '../lib/util.js'

if (process.env.LIVE_TESTS !== '1') {
  console.log('skip  live Hermes data checks read the real Hermes home — set LIVE_TESTS=1 to run them')
  process.exit(0)
}

const home = resolveHermesHome(process.env.HERMES_HOME)

const results = []
async function check(label, fn) {
  try {
    const note = await fn()
    results.push({ label, ok: true, note })
  } catch (error) {
    results.push({ label, ok: false, error: error?.message ?? String(error) })
  }
}

await check('cron jobs are readable', async () => {
  const jobs = await readCronJobs(home)
  assert.ok(jobs.length > 0, 'expected at least one cron job')
  for (const job of jobs) {
    assert.equal(typeof job.id, 'string')
    assert.equal(typeof job.schedule, 'string')
    assert.ok(job.schedule !== 'unknown', `job ${job.id} has an unparsed schedule`)
  }
  return `${jobs.length} jobs`
})

await check('session search returns ranked hits', async () => {
  // Any term that should appear in Hermes' history; adjust with SEARCH_TERM.
  const term = process.env.SEARCH_TERM ?? 'hermes'
  const hits = await searchSessions(home, term, { limit: 5 })
  assert.ok(hits.length > 0, `expected at least one hit for ${JSON.stringify(term)} — set SEARCH_TERM`)
  for (const hit of hits) {
    assert.equal(typeof hit.sessionId, 'string')
    assert.equal(typeof hit.snippet, 'string')
  }
  return `${hits.length} hits for ${JSON.stringify(term)}`
})

await check('a session can be read by id', async () => {
  const term = process.env.SEARCH_TERM ?? 'hermes'
  const hits = await searchSessions(home, term, { limit: 1 })
  assert.ok(hits.length > 0, 'no session to read — set SEARCH_TERM')
  const page = await readSession(home, hits[0].sessionId, { limit: 3 })
  assert.equal(page.session.id, hits[0].sessionId)
  assert.ok(page.messages.length > 0, 'expected messages in the session')
  return `${page.messages.length} messages from "${page.session.title ?? page.session.id}"`
})

await check('an unknown session id fails loudly', async () => {
  await assert.rejects(
    () => readSession(home, 'no-such-session-id'),
    /no Hermes session/u,
  )
  return 'rejected as expected'
})

await check('a wrong hermesHome fails with a message, not a native sqlite error', async () => {
  await assert.rejects(
    () => searchSessions(`${home}-does-not-exist`, 'hermes', { limit: 1 }),
    /cannot open Hermes' session database .*hermesHome/u,
  )
  return 'friendly error'
})

for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok ? ` — ${item.note}` : `\n        ${item.error}`}`)
}
const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
