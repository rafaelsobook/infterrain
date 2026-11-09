import { RawTexture, Texture } from '@babylonjs/core'

// Procedural detail textures for the props - built in memory at startup, so
// the new features need no image files from the host. Each is a tileable
// LUMINANCE pattern (stored in r, g and b alike) averaging about 0.62: the
// prop shader divides by that and multiplies the vertex colour by the result,
// so the colour comes from the geometry and only the grain comes from here.
//
// A host wanting real art can hand its own image paths to createOpenWorld's
// `propTextures` option ({ stone, rock, wood, bark, ice, cactus, cloud });
// a photo works as long as it is roughly mid-grey on average.

const SIZE = 256
const MEAN = 0.62

function hash(x, y, seed) {
  let h = (seed * 1234567 + x * 374761393 + y * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
const smooth = t => t * t * (3 - 2 * t)
const mod = (a, n) => ((a % n) + n) % n

// value noise that wraps every `period` lattice cells, so the texture tiles
function tnoise(x, y, period, seed) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = smooth(x - ix), fy = smooth(y - iy)
  const h = (a, b) => hash(mod(a, period), mod(b, period), seed)
  const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1)
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}
function tfbm(x, y, period, seed, octaves) {
  let v = 0, amp = 1, norm = 0, f = 1
  for (let i = 0; i < octaves; i++) {
    v += tnoise(x * f, y * f, period * f, seed + i * 31) * amp
    norm += amp; amp *= 0.5; f *= 2
  }
  return v / norm
}
// cellular distance (f1, f2) on a wrapping grid of `n` cells
function tcells(u, v, n, seed) {
  const x = u * n, y = v * n
  const gx = Math.floor(x), gy = Math.floor(y)
  let f1 = 9, f2 = 9, id = 0
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const cx = gx + i, cy = gy + j
      const wx = mod(cx, n), wy = mod(cy, n)
      const px = cx + 0.15 + hash(wx, wy, seed) * 0.7
      const py = cy + 0.15 + hash(wx, wy, seed + 9) * 0.7
      const d = Math.hypot(x - px, y - py)
      if (d < f1) { f2 = f1; f1 = d; id = hash(wx, wy, seed + 5) } else if (d < f2) f2 = d
    }
  return { f1, f2, id }
}

const PATTERNS = {
  plain: () => MEAN,
  // dressed stone blocks in mortar - the well, the rim, worked masonry
  stone(u, v) {
    const c = tcells(u, v, 7, 11)
    const mortar = Math.min(1, (c.f2 - c.f1) / 0.09)
    const face = 0.5 + c.id * 0.2 + (tfbm(u * 16, v * 16, 16, 12, 3) - 0.5) * 0.3
    return face * (0.35 + 0.65 * mortar)
  },
  // weathered natural rock - cliffs, boulders, cave walls
  rock(u, v) {
    const n = tfbm(u * 6, v * 6, 6, 21, 5)
    const c = tcells(u, v, 5, 22)
    const crack = Math.min(1, (c.f2 - c.f1) / 0.05)
    return (0.35 + n * 0.55) * (0.78 + 0.22 * crack)
  },
  // planks with grain running along u
  wood(u, v) {
    const plank = Math.floor(v * 4)
    const seam = Math.min(1, Math.abs(v * 4 - Math.round(v * 4)) / 0.04)
    const grain = tfbm(u * 2 + plank * 0.37, v * 28, 2, 31 + plank, 3)
    const rings = 0.5 + 0.5 * Math.sin((v * 4 - plank) * 30 + grain * 9)
    const knot = hash(plank, 7, 33) > 0.6 ? Math.max(0, 1 - Math.hypot((u * 1 + hash(plank, 3, 34)) % 1 - 0.5, (v * 4 - plank - 0.5) * 0.6) * 9) : 0
    return (0.5 + grain * 0.25 + rings * 0.12 - knot * 0.25) * (0.45 + 0.55 * seam)
  },
  // bark: long vertical fissures
  bark(u, v) {
    const n = tfbm(u * 12, v * 2, 12, 41, 4)
    const fis = Math.abs(Math.sin((u * 18 + n * 2.2) * Math.PI))
    return 0.35 + n * 0.45 + Math.pow(fis, 6) * 0.25
  },
  // ice: glassy, faint streaks and bubbles
  ice(u, v) {
    const s = tfbm(u * 3, v * 9, 3, 51, 4)
    const b = tcells(u, v, 9, 52)
    const bubble = Math.max(0, 1 - b.f1 / 0.08) * 0.25
    return 0.55 + (s - 0.5) * 0.25 + bubble
  },
  // cactus skin: fine vertical lines and areoles (spine clusters)
  cactus(u, v) {
    const lines = 0.5 + 0.5 * Math.cos(u * Math.PI * 2 * 24)
    const cu = (u * 12) % 1 - 0.5, cv = (v * 10) % 1 - 0.5
    const areole = Math.max(0, 1 - Math.hypot(cu * 1.4, cv) / 0.12)
    return 0.56 + lines * 0.08 + tfbm(u * 8, v * 8, 8, 61, 2) * 0.12 - areole * 0.3
  },
  // cloud: soft billows
  cloud(u, v) {
    return 0.5 + tfbm(u * 4, v * 4, 4, 71, 4) * 0.24
  },
}

const cache = new WeakMap()

/** A procedural detail texture by name (see PATTERNS), or the host's image if given. */
export function propTexture(scene, name, overrides = {}) {
  let perScene = cache.get(scene)
  if (!perScene) { perScene = new Map(); cache.set(scene, perScene) }
  if (perScene.has(name)) return perScene.get(name)

  let tex
  if (overrides[name]) {
    tex = new Texture(overrides[name], scene)
  } else {
    const fn = PATTERNS[name] ?? PATTERNS.plain
    const data = new Uint8Array(SIZE * SIZE * 4)
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const v = Math.max(0, Math.min(1, fn(x / SIZE, y / SIZE)))
        const b = Math.round(v * 255)
        const i = (y * SIZE + x) * 4
        data[i] = data[i + 1] = data[i + 2] = b
        data[i + 3] = 255
      }
    tex = RawTexture.CreateRGBATexture(data, SIZE, SIZE, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
    tex.name = `infterrain_${name}`
  }
  tex.wrapU = Texture.WRAP_ADDRESSMODE
  tex.wrapV = Texture.WRAP_ADDRESSMODE
  perScene.set(name, tex)
  return tex
}

export const TEXTURE_MEAN = MEAN
