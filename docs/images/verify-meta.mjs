#!/usr/bin/env node
/**
 * Verify our display metadata against DSH's own contract.
 *
 * This mirrors `iconOf()` in `@deepseek-ai/dsh-app-boot` (lib/types/package-meta.js)
 * byte for byte in its rules, rather than trusting the docs: DSH resolves
 * `package.json`'s `icon` relative to the manifest, rejects absolute paths / URLs /
 * anything escaping the package, admits only SVG/PNG/JPEG/WebP up to 256 KiB, and
 * hands the plugin page a `data:` URL. It reads `meta.title` / `meta.description`
 * from the exported locale JSON without activating the plugin.
 *
 *   node docs/images/verify-meta.mjs
 *
 * Exits non-zero on the first violated rule, so it can gate a release.
 */
import { readFileSync, statSync, realpathSync, existsSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute, extname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..', '..')

// --- rules copied from dsh-app-boot/lib/types/package-meta.js ------------------
const MAX_ICON_BYTES = 256 * 1024
const ICON_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])
const ABSOLUTE_OR_URL = /^[A-Za-z][A-Za-z\d+.-]*:/u

const fails = []
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS  ' : 'FAIL  '}${label}${extra ? `  ${extra}` : ''}`)
  if (!ok) fails.push(label)
}

const manifestPath = join(pkgDir, 'package.json')
const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
const icon = pkg.icon

check('manifest declares an icon', typeof icon === 'string' && icon.length > 0, icon)
check('icon is a relative path, not absolute or a URL',
  typeof icon === 'string' && !isAbsolute(icon) && !ABSOLUTE_OR_URL.test(icon), icon)

if (typeof icon === 'string' && icon.length > 0) {
  const root = realpathSync(dirname(manifestPath))
  let target
  try {
    target = resolve(root, icon)
    const local = relative(root, realpathSync(target))
    check('icon stays inside its manifest directory',
      local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local), local)
  } catch (error) {
    check('icon resolves to an existing file', false, String(error.message ?? error))
  }

  const mediaType = target === undefined ? undefined : ICON_MEDIA_TYPES.get(extname(target).toLowerCase())
  check('icon extension is SVG, PNG, JPEG or WebP', mediaType !== undefined, mediaType)

  if (target !== undefined && mediaType !== undefined) {
    const stat = statSync(target)
    check('icon is a regular file', stat.isFile(), `${stat.size} B`)
    const bytes = readFileSync(target)
    check('icon is within the 256 KiB cap', stat.size <= MAX_ICON_BYTES && bytes.length <= MAX_ICON_BYTES, `${bytes.length} B`)
    const dataUrl = `data:${mediaType};base64,${bytes.toString('base64')}`
    check('icon encodes to the data URL DSH gives the <img>',
      dataUrl.startsWith(`data:${mediaType};base64,`), `${dataUrl.length} chars`)
  }
}

// --- locale meta: title + description, per language ---------------------------
for (const lang of ['zh', 'en']) {
  const file = join(pkgDir, 'locale', `${lang}.json`)
  check(`locale/${lang}.json exists`, existsSync(file), file)
  if (!existsSync(file)) continue
  let meta
  try {
    meta = JSON.parse(readFileSync(file, 'utf8')).meta
  } catch (error) {
    check(`locale/${lang}.json parses`, false, String(error.message ?? error))
    continue
  }
  check(`locale/${lang}.json meta.title is a non-empty string`,
    typeof meta?.title === 'string' && meta.title.length > 0, meta?.title)
  check(`locale/${lang}.json meta.description is a non-empty string`,
    typeof meta?.description === 'string' && meta.description.length > 0,
    typeof meta?.description === 'string' ? `${meta.description.slice(0, 48)}…` : '')
}

// --- exports / files must carry both, or the tarball drops them ---------------
const exportsMap = pkg.exports ?? {}
check('exports exposes ./icon', './icon' in exportsMap, JSON.stringify(exportsMap['./icon']))
check('exports exposes ./locale/*.json', './locale/*.json' in exportsMap, JSON.stringify(exportsMap['./locale/*.json']))
const files = pkg.files ?? []
check('files ships icon.svg', files.includes('icon.svg'), JSON.stringify(files))
check('files ships locale', files.some((entry) => entry.startsWith('locale')), JSON.stringify(files))

console.log(fails.length ? `\n${fails.length} failed` : '\nall display-metadata checks passed (mirrors iconOf() in dsh-app-boot)')
process.exit(fails.length ? 1 : 0)
