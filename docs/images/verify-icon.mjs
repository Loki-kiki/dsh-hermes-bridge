#!/usr/bin/env node
/**
 * Verify the bundle icon as *pixels*, not as geometry.
 *
 * DSH renders a bundle icon through PackageArtwork as a plain <img> at 30px (plugin
 * row) and 36px (bundle card), `object-fit: contain`. Geometry checks in
 * build-diagrams.py cannot prove the file renders into something readable, so this
 * script rasterises icon.svg with sharp at those sizes and asserts the invariants a
 * real glyph has: mirror symmetry, one fused mark, three dark hubs, no ink touching
 * the frame, and the apex sitting on the centre line.
 *
 *   npm i -D sharp     # once, or use the copy Hermes already has
 *   node docs/images/verify-icon.mjs
 *
 * Exits non-zero on the first failed invariant, so it can gate a release.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const iconPath = join(here, '..', '..', 'icon.svg')

let sharp
try {
  sharp = (await import('sharp')).default
} catch {
  console.error('sharp is not installed. Run `npm i -D sharp` in the repository root.')
  process.exit(2)
}

const svg = readFileSync(iconPath)
const NODES = [
  { label: 'left pier', x: 6, y: 24.6 },
  { label: 'apex', x: 18, y: 10.8 },
  { label: 'right pier', x: 30, y: 24.6 },
]
const VIEWBOX = 36

const fails = []
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS  ' : 'FAIL  '}${label}${extra ? `  ${extra}` : ''}`)
  if (!ok) fails.push(label)
}

async function raster(size) {
  const buf = await sharp(svg, { density: 72 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  const { data } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, size, at: (x, y) => data[((y * size + x) << 2) + 3] }
}

for (const size of [30, 36]) {
  const { at, data } = await raster(size)
  const scale = size / VIEWBOX

  // 1. mirror symmetry about the vertical centre line
  let ink = 0
  let asym = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = at(x, y)
      const b = at(size - 1 - x, y)
      if (a > 40) ink++
      if (Math.abs(a - b) > 90) asym++
    }
  }
  check(`${size}px: left/right mirror symmetric`, ink > 0 && asym / ink < 0.02, `asym=${asym} ink=${ink}`)

  // 2. one fused mark — the span and its nodes must not read as four loose blobs
  const seen = new Uint8Array(size * size)
  let blobs = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (seen[y * size + x] || at(x, y) <= 40) continue
      blobs++
      const stack = [[x, y]]
      seen[y * size + x] = 1
      while (stack.length) {
        const [cx, cy] = stack.pop()
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
          const j = ny * size + nx
          if (seen[j] || at(nx, ny) <= 40) continue
          seen[j] = 1
          stack.push([nx, ny])
        }
      }
    }
  }
  check(`${size}px: glyph is one connected mark`, blobs === 1, `${blobs} blob(s)`)

  // 3. each node keeps its dark hub (the ring proves the node is painted, not hollow)
  for (const node of NODES) {
    const px = Math.round(node.x * scale)
    const py = Math.round(node.y * scale)
    const i = ((py * size + px) << 2)
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]]
    check(`${size}px: ${node.label} hub is dark and opaque`, a > 200 && r < 60 && g < 60 && b < 80,
      `rgba(${r},${g},${b},${a})`)
  }

  // 4. nothing may touch the frame — that is what a clipped stroke looks like
  let edge = 0
  for (let i = 0; i < size; i++) {
    for (const [x, y] of [[i, 0], [i, size - 1], [0, i], [size - 1, i]]) if (at(x, y) > 40) edge++
  }
  check(`${size}px: no ink touches the frame`, edge === 0, `edge=${edge}`)

  // 5. the apex is the topmost ink and sits on the centre line
  let topY = size
  let topXs = []
  for (let y = 0; y < size && topXs.length === 0; y++) {
    for (let x = 0; x < size; x++) if (at(x, y) > 40) topXs.push(x)
    if (topXs.length) topY = y
  }
  const meanX = topXs.reduce((a, b) => a + b, 0) / topXs.length
  check(`${size}px: apex is the topmost ink, on the centre line`,
    Math.abs(meanX - 18 * scale) <= Math.max(1.5, scale), `y=${topY} meanX=${meanX.toFixed(1)}`)
}

console.log(fails.length ? `\n${fails.length} failed` : '\nall rendered-pixel checks passed')
process.exit(fails.length ? 1 : 0)
