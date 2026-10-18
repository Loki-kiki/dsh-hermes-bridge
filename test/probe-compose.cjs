/**
 * Ask DSH's own composition code whether a row override actually landed.
 *
 * `dsh --dump-config` is not evidence: it prints the *resolved* tree, and a
 * disabled row simply does not appear there — indistinguishable from "the row
 * was never inserted". This probe calls the same functions DSH's plugin manager
 * uses (`readBundlePatches` + `readProfilePatches` + `composeEntries`) and prints
 * the composed row for a given id, so `disabled: true` is visible or absent on
 * its own terms.
 *
 * Point DSH_ASAR_ROOT at the app's own `@deepseek-ai` directory, then run with
 * the app's Electron binary so the asar imports resolve:
 *
 *   export DSH_ASAR_ROOT="/path/to/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai"
 *   ELECTRON_RUN_AS_NODE=1 "<exe>" probe-compose.cjs <profileDir> [rowId]
 */

const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const profileDir = process.argv[2]
const rowId = process.argv[3] ?? 'hermes-bridge-viking'
const asarRoot = process.env.DSH_ASAR_ROOT

if (asarRoot === undefined || asarRoot.trim() === '') {
  console.error('DSH_ASAR_ROOT is not set. It must point at the app\'s @deepseek-ai directory, e.g.:')
  console.error('  DSH_ASAR_ROOT="<app>/resources/app.asar/dsh/node_modules/@deepseek-ai" \\')
  console.error('    ELECTRON_RUN_AS_NODE=1 "<app>/<exe>" test/probe-compose.cjs <profileDir> [rowId]')
  process.exit(2)
}

async function main() {
  const boot = await import(pathToFileURL(path.join(asarRoot, 'dsh-app-boot', 'lib', 'index.js')).href)
  // The shape `readProfilePatches` expects: `dir` for bundles, `patchPath` for
  // the profile layer, `home` for the user-wide layer above it.
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  const context = {
    dir: profileDir,
    patchPath: path.join(profileDir, 'cordis.patch.yml'),
    home,
    // `resolveBundleDir` resolves bundles against the app's own package.json
    // first; without this anchor every bundle layer is silently skipped and the
    // composition only shows the profile's own patch file.
    installAnchor: path.join(asarRoot, '..', 'package.json'),
    overlays: [],
  }

  const patches = boot.readProfilePatches('dsh', context)
  console.log('patches:', patches.length)
  const profile = boot.loadProfileDirectory('dsh', profileDir, context.installAnchor)
  console.log('bundles loaded:', profile.layers.length, '| skipped:', profile.skippedBundles.length)
  for (const skipped of profile.skippedBundles) console.log('  skipped:', skipped.packageName, '—', skipped.reason)

  const composed = boot.composeEntries([patches])
  const find = (rows, id) => {
    for (const row of rows) {
      if (row?.id === id) return row
      if (row?.group && Array.isArray(row.config)) {
        const nested = find(row.config, id)
        if (nested) return nested
      }
    }
    return undefined
  }
  const row = find(composed, rowId)
  if (row === undefined) {
    console.log(`ABSENT ${rowId} — the row never made it into the composition`)
    process.exitCode = 2
    return
  }
  console.log(`FOUND  ${rowId}`)
  console.log('  name    :', row.name)
  console.log('  disabled:', row.disabled === true ? 'true' : String(row.disabled ?? '(unset → enabled)'))
  console.log('  verdict :', row.disabled === true ? 'DISABLED' : 'ENABLED')
}

main().catch(error => {
  console.error('probe failed:', error?.stack ?? error?.message ?? error)
  process.exitCode = 1
})
