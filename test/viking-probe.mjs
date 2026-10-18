/**
 * Live probe for the OpenViking row: calls the real API the same way the tools
 * do, and prints what came back. No DSH involved, so it can run while the app
 * is closed.
 *
 * Run: [VIKING_USER=<name>] [VIKING_ACCOUNT=<name>] node test/viking-probe.mjs \
 *        [--endpoint http://127.0.0.1:1933]
 *
 * Exit code is 0 only when a search returns hits — a reachable endpoint that
 * recalls nothing is a failure for the purpose this row exists.
 */

const args = process.argv.slice(2)
const endpoint = (() => {
  const index = args.indexOf('--endpoint')
  return index !== -1 && args[index + 1] ? args[index + 1].replace(/\/+$/, '') : 'http://127.0.0.1:1933'
})()

// The tenant to read. There is no universal default: OpenViking scopes every
// memory to a user, so this probe can only run against your own. Guessing a
// name would either report "0 hits" (looks like a broken server) or read
// somebody else's tree, so require it up front.
const user = (process.env.VIKING_USER ?? '').trim()
const account = process.env.VIKING_ACCOUNT ?? 'default'
if (user === '') {
  console.error('VIKING_USER is required — set it to your OpenViking tenant name, e.g.')
  console.error('  VIKING_USER=<your OpenViking user> node test/viking-probe.mjs')
  process.exit(2)
}

const headers = {
  'Content-Type': 'application/json',
  'X-OpenViking-Account': account,
  'X-OpenViking-User': user,
  'X-OpenViking-Agent': 'hermes',
}

const memoriesRoot = `viking://user/${user}/memories`
const sampleFile = `${memoriesRoot}/profile.md`
const query = process.env.VIKING_QUERY ?? 'preferences'

async function call(method, route, { query: params, body } = {}) {
  const url = new URL(`${endpoint}${route}`)
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  const response = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  })
  const payload = JSON.parse(await response.text())
  if (payload.status !== 'ok') throw new Error(`${route}: ${payload.error?.code} ${payload.error?.message}`)
  return payload.result
}

function flatten(result, threshold) {
  const rows = []
  for (const type of ['memories', 'resources', 'skills']) {
    for (const item of result?.[type] ?? []) {
      const score = typeof item?.score === 'number' ? item.score : 0
      if (score < threshold) continue
      rows.push({ uri: item?.uri, type: type.replace(/s$/, ''), score: Number(score.toFixed(3)) })
    }
  }
  return rows.sort((left, right) => right.score - left.score)
}

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

try {
  const health = await call('GET', '/health').catch(() => null)
  check('endpoint reachable', health !== null, endpoint)
} catch {
  check('endpoint reachable', false, endpoint)
}

try {
  const found = await call('POST', '/api/v1/search/find', { body: { query, limit: 5 } })
  const hits = flatten(found, 0.3)
  check('search/find returns hits', hits.length > 0, `${hits.length} hits, top ${hits[0]?.score ?? '-'}`)
  if (hits[0]) console.log(`       top: ${hits[0].uri}`)
} catch (error) {
  check('search/find returns hits', false, error.message)
}

try {
  const tree = await call('GET', '/api/v1/fs/tree', { query: { uri: memoriesRoot, depth: 1 } })
  check('fs/tree lists memories', Array.isArray(tree) && tree.length > 0, `${tree?.length ?? 0} entries`)
} catch (error) {
  check('fs/tree lists memories', false, error.message)
}

try {
  const stat = await call('GET', '/api/v1/fs/stat', { query: { uri: sampleFile } })
  check('fs/stat reports a file', stat?.isDir === false, `isDir=${stat?.isDir}`)
} catch (error) {
  check('fs/stat reports a file', false, error.message)
}

try {
  const full = await call('GET', '/api/v1/content/read', { query: { uri: sampleFile } })
  const text = typeof full === 'string' ? full : (full?.content ?? '')
  check('content/read returns text', text.length > 20, `${text.length} chars`)
} catch (error) {
  check('content/read returns text', false, error.message)
}

console.log('')
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  console.log('all viking checks passed')
}
