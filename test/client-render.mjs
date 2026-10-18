/**
 * Render the settings page off-DSH, in a real DOM-less React stand-in.
 *
 * Why this exists: `client.js` is a hand-written ModuleLoader bundle with no
 * build step, so a typo inside a component is invisible until DSH loads it —
 * and then it shows up as a blank settings pane with a console error nobody is
 * watching. This harness loads the bundle exactly the way the host does
 * (`window.__ModuleLoader__.load({ id, factory })`), gives it a fake React, and
 * renders every page with representative status data. It catches the failures
 * that actually happen here: a `t()` key that was never added, a field read off
 * an undefined object, a component that returns nothing.
 *
 * It also writes `render.html` next to this script when `--html` is passed, so a
 * real browser can be pointed at the output and the *computed* styles checked —
 * element trees alone cannot tell you a panel collapsed to zero height.
 *
 *   node test/client-render.mjs [--html]
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.resolve(here, '..', 'client.js')

// ── a React stand-in that keeps hook slots in call order ─────────────────────
// Real React keys hooks by call order too, so a component that renders
// conditionally is a bug either way — this just makes it visible here.
function makeReact() {
  const slots = []
  let index = 0
  const reset = (seed) => {
    index = 0
    // Seeding lets a test hand `useStatus` a resolved payload. Without it the
    // page legitimately renders its loading state (the effect never runs here)
    // and every tab body would be unreachable.
    if (seed !== undefined) {
      slots.length = 0
      slots.push(...seed)
    }
  }
  const next = (init) => {
    const at = index
    index += 1
    if (slots[at] === undefined) slots[at] = typeof init === 'function' ? init() : init
    return at
  }
  // React hands children to a component through `props.children`, and several
  // components in this bundle read them from there (`Section`, `Panel`). Dropping
  // that made every panel render empty in an earlier version of this harness —
  // which is exactly the class of bug it is meant to catch, so it is kept faithful.
  const createElement = (type, props, ...children) => {
    const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true)
    return { type, props: { ...(props ?? {}), children: flat }, children: flat }
  }
  const React = {
    createElement,
    useState: (init) => {
      const at = next(init)
      return [slots[at], (value) => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }]
    },
    useEffect: (fn) => { index += 1; void fn },
    useMemo: (fn) => { index += 1; return fn() },
    useCallback: (fn) => { index += 1; return fn },
    useRef: (value) => { const at = next({ current: value }); return slots[at] },
  }
  return { React, reset }
}

// ── load the bundle the way DSH does ────────────────────────────────────────
let captured
const storage = new Map()
globalThis.window = {
  __ModuleLoader__: { load: (definition) => { captured = definition } },
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  },
  navigator: { clipboard: { writeText: async () => {} } },
}
new Function(fs.readFileSync(bundlePath, 'utf8'))()
assert.ok(captured !== undefined, 'client.js must call window.__ModuleLoader__.load()')
assert.equal(captured.id, 'dsh-hermes-bridge', 'the bundle id must match the package name')

const { React, reset } = makeReact()
const moduleExports = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error(`the bundle must not require ${name}`)
})
assert.equal(typeof moduleExports.apply, 'function')
assert.ok(Array.isArray(moduleExports.inject), 'inject must be the service-name array the host reads')
assert.deepEqual(moduleExports.inject, ['slots', 'locale'], 'inject list is the host contract')

// ── host plumbing ──────────────────────────────────────────────────────────
/** Flatten a dictionary into the `t('key')` function the components call. */
function translator(dict) {
  const t = (key) => {
    if (dict[key] === undefined) throw new Error(`missing locale key: ${key}`)
    return dict[key]
  }
  return t
}

/** Every slot the bundle registers, so the page can be rendered directly. */
const registrations = []
const fakeCtx = {
  locale: {
    register: (ns, dict) => { fakeCtx._dict = dict },
    bind: () => (key) => key,
  },
  slots: {
    inject: (_slot, fn) => fn(),
    register: (meta, render) => { registrations.push({ meta, render }) },
  },
  effect: (fn) => { fn() },
}

// `apply` touches document.head for its stylesheet; give it a stub.
globalThis.document = {
  head: { appendChild: () => {}, },
  createElement: () => ({ setAttribute: () => {}, textContent: '', remove: () => {} }),
}
moduleExports.apply(fakeCtx)
assert.equal(registrations.length, 1, 'the bundle registers exactly one settings section')
assert.equal(registrations[0].meta.name, 'settings.section')

const dict = fakeCtx._dict
const zh = translator(dict.zh)
const en = translator(dict.en)

// Both dictionaries must cover the same keys: a half-translated page renders
// `undefined` in one language and nobody notices until a user switches.
const zhKeys = Object.keys(dict.zh).sort()
const enKeys = Object.keys(dict.en).sort()
assert.deepEqual(zhKeys, enKeys, `locale dictionaries diverge: only-zh=${zhKeys.filter((k) => !enKeys.includes(k))} only-en=${enKeys.filter((k) => !zhKeys.includes(k))}`)

// ── representative status payload ──────────────────────────────────────────
const status = {
  profile: 'desktop',
  hermesHome: 'C:/Users/x/AppData/Local/hermes',
  dshHome: 'C:/Users/x/.dsh',
  patchPath: 'C:/Users/x/.dsh/profiles/desktop/cordis.patch.yml',
  rows: [
    { id: 'hermes-bridge-persona', enabled: true, overridden: false },
    { id: 'hermes-bridge-memory', enabled: true, overridden: false },
    { id: 'hermes-bridge-memory-write', enabled: true, overridden: false },
    { id: 'hermes-bridge-skills', enabled: true, overridden: false },
    { id: 'hermes-bridge-viking', enabled: true, overridden: false },
    { id: 'hermes-bridge-provider', enabled: false, overridden: false },
    { id: 'hermes-bridge-mcp', enabled: true, overridden: false },
    { id: 'hermes-bridge-hermes-data', enabled: true, overridden: false },
  ],
  files: [
    { label: 'SOUL.md', role: '人设', path: 'C:/h/SOUL.md', exists: true, bytes: 4096, mtime: Date.now(), directory: false },
    { label: 'MEMORY.md', role: '长期记忆', path: 'C:/h/memories/MEMORY.md', exists: true, bytes: 3492, mtime: Date.now(), directory: false },
    { label: 'skills/', role: '技能库', path: 'C:/h/skills', exists: true, bytes: 0, mtime: Date.now(), directory: true },
  ],
  hermes: {
    path: 'C:/h/config.yaml',
    memoryProvider: 'openviking',
    memoryEnabled: true,
    userProfileEnabled: true,
    provider: {
      name: 'openviking',
      builtin: false,
      blocked: false,
      agentRoot: 'C:/h/hermes-agent',
      agentRootExists: true,
      python: 'C:/h/hermes-agent/venv/Scripts/python.exe',
      pythonExists: true,
    },
    openviking: { endpoint: 'http://127.0.0.1:1933', account: 'default', user: 'demo-user' },
    pluginsDisabled: [],
    pluginsEnabled: [],
    mcpServers: ['rea'],
  },
  setup: { hermesFound: true, probe: { path: 'C:/h', exists: true, looksLikeHermes: true, checks: [] }, hint: '' },
  config: {
    'hermes-bridge-persona': { hermesHome: '' },
    'hermes-bridge-viking': { endpoint: 'http://127.0.0.1:1933', account: 'default', user: 'demo-user', agent: 'hermes' },
    'hermes-bridge-provider': { provider: '', timeoutMs: 60000 },
  },
  mcp: { hermesServers: [{ name: 'rea' }], mounted: 1, needsSync: false, error: '' },
  skills: { stateFile: 'C:/d/skills.json', disabled: [], updatedAt: 0 },
  viking: { endpoint: 'http://127.0.0.1:1933', reachable: true, status: 'ok', version: '0.4.17', authMode: 'none' },
  memoryOrigins: {
    memory: { total: 34, hermes: 30, dsh: 2, assumed: 2, chars: 3492, limit: 3500 },
    user: { total: 12, hermes: 12, dsh: 0, assumed: 0, chars: 1900, limit: 2000 },
  },
  preview: { persona: 'persona text', memory: '# MEMORY.md\n\nmem', personaPath: 'C:/h/SOUL.md', memoryPaths: [] },
  skillInventory: [
    { name: 'demo-skill', description: 'a demo skill', category: 'misc', path: 'C:/h/skills/misc/demo-skill/SKILL.md', enabled: true },
  ],
  generatedAt: Date.now(),
}

// ── render ─────────────────────────────────────────────────────────────────
/** Turn an element tree into HTML, resolving function components recursively. */
function render(node, t) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(String(node))
  if (Array.isArray(node)) return node.map((child) => render(child, t)).join('')
  const { type, props, children } = node
  if (typeof type === 'function') {
    // Components receive `t` through props in this bundle, so nothing extra is
    // injected here; a component that ignores it would render raw keys and the
    // assertions below would catch that.
    const out = type({ ...props, t: props?.t ?? t }, ...children)
    return render(out, t)
  }
  const attrs = Object.entries(props ?? {})
    .filter(([key]) => !['children', 'onChange', 'onClick', 'onSave', 'onProbe', 'onToggle', 'onBulk', 'onSkillToggle', 'onSaved', 't', 'busy', 'pending', 'busyId'].includes(key))
    .map(([key, value]) => {
      if (value === undefined || value === null || typeof value === 'function' || typeof value === 'object') return ''
      // React spells it `className`; raw HTML needs `class`, or the emitted page
      // renders completely unstyled and a computed-style check would be checking
      // nothing.
      const attribute = key === 'className' ? 'class' : key
      return ` ${attribute}="${escapeHtml(String(value))}"`
    })
    .join('')
  return `<${type}${attrs}>${children.map((child) => render(child, t)).join('')}</${type}>`
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const results = []
function check(label, fn) {
  try {
    const note = fn()
    results.push({ label, ok: true, note })
  } catch (error) {
    results.push({ label, ok: false, error: error?.message ?? String(error) })
  }
}

const SettingsPage = registrations[0].render

/** Render the page with a fixed tab, bypassing the status fetch. */
function renderTab(tab, t) {
  storage.set('hb.tab', tab)
  reset()
  const element = SettingsPage({ t, locale: 'zh' })
  // The page starts in `loading` because its status fetch has not resolved;
  // feed it the payload by rendering the inner tree directly instead.
  return render(element, t)
}

/**
 * Render the page body with data already present.
 *
 * `SettingsPage` owns `useStatus()`, whose effect never runs in this harness, so
 * the outer call legitimately renders the loading state. What matters is that it
 * does so without throwing — and then that the tabs render with real data. The
 * tab bodies are re-rendered by handing the page a pre-seeded hook slot.
 */
function renderWithData(tab, t) {
  storage.set('hb.tab', tab)
  reset()
  // Seed slot 0 (useStatus's state) before the component reads it: `useState`
  // only takes the initial value when the slot is empty.
  const element = SettingsPage({ t, locale: 'zh' })
  void element
  return undefined
}

// ── real render: every tab, with the status payload above ──────────────────
//
// `SettingsPage` calls `useStatus()` first, so hook slot 0 is its state object.
// Seeding that slot with `{status:'ready', data}` makes the page render its real
// body instead of the loading state, which is what lets the tab assertions below
// mean anything.

/** Render the page with a fixed tab and the status payload already resolved. */
function renderPage(tab, t) {
  storage.set('hb.tab', tab)
  reset([{ status: 'ready', data: status, error: '' }])
  return render(SettingsPage({ t, locale: 'zh' }), t)
}

const TAB_CASES = [
  ['overview', ['记忆提供方（通用）', 'OpenViking', 'MCP 服务器']],
  ['connection', ['记忆提供方（通用）', 'Hermes 当前 provider', '探测这个 provider']],
  ['skills', ['技能库']],
  ['preview', ['提示词预览']],
  ['diagnostics', ['诊断']],
]

if (process.env.HB_DUMP === '1') {
  const html = renderPage(process.env.HB_TAB ?? 'overview', zh)
  console.log(html.slice(0, 4000))
  process.exit(0)
}

for (const [tab, expected] of TAB_CASES) {
  check(`tab "${tab}" renders with real data`, () => {
    const html = renderPage(tab, zh)
    assert.ok(html.length > 500, `tab ${tab} rendered only ${html.length} chars`)
    for (const needle of expected) {
      assert.ok(html.includes(needle), `tab ${tab} is missing ${JSON.stringify(needle)}`)
    }
    return `${html.length} chars`
  })
}

check('the provider panel shows the backend Hermes is configured to use', () => {
  const html = renderPage('connection', zh)
  assert.ok(html.includes('openviking'), 'the configured provider name must be visible')
  assert.ok(html.includes('C:/h/hermes-agent'), 'the agent tree path must be visible')
  assert.ok(html.includes('venv/Scripts/python.exe'), 'the interpreter path must be visible')
  return 'provider, agent root, interpreter'
})

check('the provider panel warns when the backend is blocked in plugins.disabled', () => {
  const blocked = JSON.parse(JSON.stringify(status))
  blocked.hermes.provider.blocked = true
  blocked.hermes.pluginsDisabled = ['openviking']
  storage.set('hb.tab', 'connection')
  reset([{ status: 'ready', data: blocked, error: '' }])
  const html = render(SettingsPage({ t: zh, locale: 'zh' }), zh)
  assert.ok(html.includes('plugins.disabled'), 'the blocked warning must appear')
  return 'warned'
})

check('the provider panel explains the built-in case instead of showing a blank name', () => {
  const builtin = JSON.parse(JSON.stringify(status))
  builtin.hermes.provider = { ...builtin.hermes.provider, name: '', builtin: true }
  builtin.hermes.memoryProvider = ''
  storage.set('hb.tab', 'connection')
  reset([{ status: 'ready', data: builtin, error: '' }])
  const html = render(SettingsPage({ t: zh, locale: 'zh' }), zh)
  assert.ok(html.includes('内置'), 'the built-in explanation must appear')
  return 'explained'
})

check('a missing agent tree is shown as missing, not as an empty cell', () => {
  const broken = JSON.parse(JSON.stringify(status))
  broken.hermes.provider.agentRootExists = false
  broken.hermes.provider.pythonExists = false
  storage.set('hb.tab', 'connection')
  reset([{ status: 'ready', data: broken, error: '' }])
  const html = render(SettingsPage({ t: zh, locale: 'zh' }), zh)
  assert.ok(html.includes('缺'), 'a missing path must be labelled')
  return 'labelled'
})

check('the provider row appears in the overview with its switch', () => {
  const html = renderPage('overview', zh)
  assert.ok(html.includes('hermes-bridge-provider'), 'the row id must be visible for debugging')
  assert.ok(html.includes('记忆提供方（通用）'))
  return 'row listed'
})

check('an English render works for every tab', () => {
  for (const [tab] of TAB_CASES) {
    const html = renderPage(tab, en)
    assert.ok(html.length > 500, `en tab ${tab} rendered ${html.length} chars`)
    assert.ok(!html.includes('undefined'), `en tab ${tab} rendered the literal "undefined"`)
  }
  return '5 tabs'
})

check('a failed status read renders the error state, not a blank page', () => {
  storage.set('hb.tab', 'overview')
  reset([{ status: 'error', data: undefined, error: 'boom' }])
  const html = render(SettingsPage({ t: zh, locale: 'zh' }), zh)
  assert.ok(html.includes('读不到桥接状态'))
  assert.ok(html.includes('boom'))
  return 'error state'
})

// ── optional: emit a standalone HTML page for a real browser check ─────────
if (process.argv.includes('--html')) {
  // The real stylesheet, extracted from the bundle itself: a render check against
  // a hand-written stand-in CSS would only prove the stand-in. The bundle's CSS
  // is a template literal assigned to `const CSS`, so it can be lifted verbatim.
  const source = fs.readFileSync(bundlePath, 'utf8')
  const marker = 'const CSS = `'
  const start = source.indexOf(marker)
  // Skip past the opening backtick itself: searching from `start` would find it
  // again immediately and hand back an empty stylesheet (which looks like a
  // passing check because the page still renders — just unstyled).
  const bodyStart = start + marker.length
  const stop = source.indexOf('`', bodyStart)
  assert.ok(start > 0 && stop > bodyStart, 'the bundle must carry a `const CSS = ` block')
  const css = source.slice(bodyStart, stop)
  assert.ok(css.length > 2000, `the extracted stylesheet is suspiciously short (${css.length} chars)`)
  const body = renderPage(process.env.HB_HTML_TAB ?? 'connection', zh)
  const page = `<!doctype html><meta charset="utf-8"><title>hermes-bridge render</title>
<style id="hb-real-css">${css}</style>
<style>
:root{--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f6f7f9;--dsw-alias-bg-layer-3:#eef1f5;
--dsw-alias-border-l1:#e3e6eb;--dsw-alias-border-l2:#cfd4dc;--dsw-alias-label-primary:#111827;
--dsw-alias-label-secondary:#4b5563;--dsw-alias-label-tertiary:#9ca3af;
--dsw-alias-state-business-primary:#3f77d8;--dsw-alias-state-success-primary:#17a673;
--dsw-alias-state-warning-primary:#f0a441;--dsw-alias-state-error-primary:#dc2626;--dsw-alias-label-on-accent:#fff}
body{margin:0;padding:24px;background:var(--dsw-alias-bg-layer-1);font:13px/1.55 system-ui,sans-serif;color:var(--dsw-alias-label-primary)}
</style>
${body}`
  const out = path.resolve(here, 'render.html')
  fs.writeFileSync(out, page, 'utf8')
  console.log(`\nwrote ${out}`)
}

for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok ? ` — ${item.note}` : `\n        ${item.error}`}`)
}
const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
