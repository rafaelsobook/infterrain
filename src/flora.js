import { Geo, mixColor, rng } from './geo'

// The procedural props, as geometry (geo.js). Each builder takes a seed and
// returns a Geo standing on y = 0 at the origin, so features.js can build a
// few variants of each, instance them, and drop them on the ground. Colours
// are baked per vertex (rgb tint, alpha = glow mask, see materials.js).

const TAU = Math.PI * 2

// ── Emberfrost: trees grown out of ice ──────────────────────────────────────
export function iceTreeGeo(seed) {
  const r = rng(seed)
  const g = new Geo()
  const height = 7 + r() * 4
  const trunkC = [0.42, 0.66, 0.9, 0.12]
  const limbC = [0.62, 0.84, 1.0, 0.28]
  const shardC = [0.82, 0.96, 1.0, 0.95]
  const lean = [(r() - 0.5) * 0.25, 1, (r() - 0.5) * 0.25]
  const trunkLen = height * (0.38 + r() * 0.1)
  g.crystal([0, -0.4, 0], lean, 0.38 + r() * 0.12, trunkLen + 0.4, 6, trunkC, { taper: 0.35, tip: 0.2, twist: 0.3 })
  const top = [lean[0] * trunkLen, trunkLen - 0.2, lean[2] * trunkLen]

  // limbs that split, each tipped with a burst of shards
  const shards = (at, dir, n, len) => {
    for (let i = 0; i < n; i++) {
      const d = [dir[0] + (r() - 0.5) * 1.2, dir[1] + (r() - 0.2) * 0.9, dir[2] + (r() - 0.5) * 1.2]
      g.crystal(at, d, 0.07 + r() * 0.07, len * (0.4 + r() * 0.7), 4, shardC, { taper: 0.1, tip: 0.18 + r() * 0.2 })
    }
  }
  const limb = (from, dir, len, rad, depth) => {
    const l = Math.hypot(...dir)
    const d = dir.map(c => c / l)
    g.crystal(from, d, rad, len, 5, depth === 0 ? limbC : mixColor(limbC, shardC, 0.3), { taper: 0.45, tip: rad * 0.8, twist: r() })
    const end = [from[0] + d[0] * len, from[1] + d[1] * len, from[2] + d[2] * len]
    if (depth < 2) {
      // two each (it was two or three - and three, twice over, is nine times
      // the shards at the tips): ~1800 vertices a tree instead of ~4300
      const kids = 2
      for (let k = 0; k < kids; k++) {
        const a = r() * TAU, spread = 0.5 + r() * 0.6
        limb(end, [d[0] + Math.cos(a) * spread, d[1] + 0.35, d[2] + Math.sin(a) * spread], len * (0.55 + r() * 0.2), rad * 0.6, depth + 1)
      }
    } else {
      shards(end, d, 2 + Math.floor(r() * 2), 0.9)
    }
  }
  const limbs = 3 + Math.floor(r() * 2)
  for (let i = 0; i < limbs; i++) {
    const a = (i / limbs) * TAU + r() * 0.8
    const out = 0.55 + r() * 0.5
    limb(top, [Math.cos(a) * out, 0.85, Math.sin(a) * out], height * (0.22 + r() * 0.08), 0.2 + r() * 0.06, 0)
  }
  // frost spikes round the foot
  for (let i = 0; i < 5; i++) {
    const a = r() * TAU, d = 0.5 + r() * 0.8
    g.crystal([Math.cos(a) * d, -0.2, Math.sin(a) * d], [Math.cos(a) * 0.6, 1, Math.sin(a) * 0.6], 0.08 + r() * 0.1, 0.4 + r() * 0.8, 4, limbC, { taper: 0.2, tip: 0.3 })
  }
  return { geo: g, height, radius: 0.5 }
}

// ── Emberfrost: obsidian ─────────────────────────────────────────────────────
export function obsidianGeo(seed) {
  const r = rng(seed)
  const g = new Geo()
  const n = 3 + Math.floor(r() * 4)
  const c = [0.07, 0.065, 0.085, 0]
  for (let i = 0; i < n; i++) {
    const a = r() * TAU, off = r() * 0.8
    const dir = [Math.cos(a) * (0.2 + r() * 0.6), 1, Math.sin(a) * (0.2 + r() * 0.6)]
    g.crystal([Math.cos(a) * off, -0.3, Math.sin(a) * off], dir, 0.25 + r() * 0.4, 1 + r() * 2.6, 5, c, { taper: 0.3, tip: 0.5 + r() * 0.6 })
  }
  return { geo: g, height: 3, radius: 1 }
}

// ── Thornvine: saguaro ─────────────────────────────────────────────────────
export function cactusGeo(seed) {
  const r = rng(seed)
  const g = new Geo()
  const H = 6 + r() * 7
  const R = 0.62 + r() * 0.3
  const skin = [0.36, 0.6, 0.3, 0]
  const ribs = (t, s) => 1 + 0.09 * Math.cos(s * TAU * 12)
  const column = (pts, rad) => {
    const n = pts.length
    const path = pts.map((p, i) => {
      const t = i / (n - 1)
      // a dome at the top rather than a flat cut
      const k = t > 0.86 ? Math.sqrt(Math.max(0, 1 - ((t - 0.86) / 0.14) ** 2)) : 1
      return { x: p[0], y: p[1], z: p[2], r: rad * Math.max(0.05, k) }
    })
    // ribs catch the light, grooves stay dark - baked, since the normals
    // here are only the column's own round ones
    g.tube(path, 16, (t, s) => mixColor(mixColor(skin, [0.48, 0.7, 0.36, 0], t * 0.4), [0.2, 0.36, 0.18, 0], 0.5 - 0.5 * Math.cos(s * Math.PI * 2 * 12)), { wobble: ribs, capEnd: false })
  }
  const bendX = (r() - 0.5) * 0.6, bendZ = (r() - 0.5) * 0.6
  const main = []
  for (let i = 0; i <= 8; i++) {
    const t = i / 8
    main.push([bendX * t * t, -0.5 + t * (H + 0.5), bendZ * t * t])
  }
  column(main, R)
  const tips = [[bendX, H, bendZ]]
  const arms = Math.floor(r() * 3.2)
  for (let a = 0; a < arms; a++) {
    const ang = r() * TAU
    const y0 = H * (0.32 + r() * 0.3)
    const out = 1.1 + r() * 0.8, up = 1.8 + r() * 2.8
    const ca = Math.cos(ang), sa = Math.sin(ang)
    const pts = []
    for (let i = 0; i <= 6; i++) {
      const t = i / 6
      // out from the trunk, then turning to grow straight up
      const horiz = out * Math.sin(Math.min(1, t * 1.6) * Math.PI / 2)
      const vert = t < 0.35 ? t * 0.6 : 0.21 + (t - 0.35) / 0.65 * up
      pts.push([ca * (R * 0.6 + horiz), y0 + vert, sa * (R * 0.6 + horiz)])
    }
    column(pts, R * (0.62 + r() * 0.12))
    tips.push(pts[pts.length - 1])
  }
  // flowers on the crowns - a faint glow so they show after dark
  const petals = [[1, 0.97, 0.88, 0.35], [0.98, 0.6, 0.75, 0.4], [1, 0.85, 0.35, 0.35]][Math.floor(r() * 3)]
  for (const tip of tips) {
    const k = 2 + Math.floor(r() * 3)
    for (let i = 0; i < k; i++) {
      const a = r() * TAU
      g.blob(tip[0] + Math.cos(a) * 0.3, tip[1] + 0.05, tip[2] + Math.sin(a) * 0.3, 0.22, 0.12, 0.22, 1, petals)
    }
  }
  return { geo: g, height: H, radius: R }
}

// ── Thornvine: the vines ───────────────────────────────────────────────────
export function vineGeo(seed) {
  const r = rng(seed)
  const g = new Geo()
  const span = 42 + r() * 34
  const peak = 13 + r() * 11
  const R = 1.25 + r() * 0.7
  const wig = (r() - 0.5) * span * 0.35
  const bark = [0.27, 0.31, 0.17, 0]
  const N = 48
  const path = []
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const x = (t - 0.5) * span
    // ends dive into the ground, the middle arches over
    const y = Math.sin(t * Math.PI) * peak - 2.6 + Math.sin(t * TAU * 2.3) * 0.8
    const z = Math.sin(t * Math.PI) * wig + Math.sin(t * TAU * 1.3 + 1) * 2.2
    const taper = 0.75 + 0.25 * Math.sin(t * Math.PI)
    path.push({ x, y, z, r: R * taper })
  }
  g.tube(path, 12, t => mixColor(bark, [0.34, 0.37, 0.2, 0], Math.sin(t * Math.PI) * 0.5), {
    wobble: (t, s) => 1 + 0.06 * Math.sin(s * TAU * 3 + t * 30),
    capStart: false, capEnd: false,
  })
  // tendrils winding round it
  for (let k = 0; k < 2; k++) {
    const phase = k * Math.PI + r()
    const tend = []
    for (let i = 2; i <= N - 2; i++) {
      const p = path[i]
      const a = i * 0.55 + phase
      const off = p.r + 0.32
      tend.push({ x: p.x, y: p.y + Math.cos(a) * off, z: p.z + Math.sin(a) * off, r: 0.28 })
    }
    g.tube(tend, 6, [0.22, 0.34, 0.14, 0], { capEnd: true })
  }
  // thorns
  const thornC = [0.42, 0.22, 0.15, 0]
  for (let i = 3; i <= N - 3; i++) {
    const p = path[i]
    const n = 2 + Math.floor(r() * 2)
    for (let k = 0; k < n; k++) {
      const a = r() * TAU
      const dir = [0.25 * (r() - 0.5), Math.cos(a), Math.sin(a)]
      const base = [p.x, p.y + dir[1] * p.r * 0.9, p.z + dir[2] * p.r * 0.9]
      g.crystal(base, dir, 0.16 + r() * 0.1, 0.25, 4, thornC, { taper: 0.3, tip: 0.6 + r() * 0.9 })
    }
  }
  // a few broad leaves
  for (let k = 0; k < 9; k++) {
    const p = path[4 + Math.floor(r() * (N - 8))]
    const a = r() * TAU
    g.blob(p.x, p.y + Math.cos(a) * (p.r + 0.6), p.z + Math.sin(a) * (p.r + 0.6), 1.4, 0.18, 0.8, 1, [0.25, 0.42, 0.18, 0])
  }
  return { geo: g, height: peak, radius: span / 2, path }
}

// ── Crystal Hollows ─────────────────────────────────────────────────────────
export const CRYSTAL_PALETTES = [
  { body: [0.55, 0.36, 0.92], tip: [0.86, 0.72, 1.0], glow: [0.55, 0.3, 1.0], rim: [0.55, 0.45, 0.95] },
  { body: [0.22, 0.75, 0.78], tip: [0.7, 1.0, 0.98], glow: [0.2, 0.85, 0.9], rim: [0.35, 0.85, 0.9] },
  { body: [0.9, 0.38, 0.62], tip: [1.0, 0.78, 0.88], glow: [1.0, 0.35, 0.65], rim: [0.95, 0.5, 0.75] },
]
export function crystalClusterGeo(seed, palette) {
  const r = rng(seed)
  const g = new Geo()
  const n = 4 + Math.floor(r() * 5)
  const big = 4 + r() * 6
  let tallest = 0
  for (let i = 0; i < n; i++) {
    const first = i === 0
    const len = first ? big : big * (0.25 + r() * 0.55)
    const rad = first ? 0.8 + r() * 0.5 : 0.3 + r() * 0.55
    const a = r() * TAU
    const lean = first ? r() * 0.25 : 0.25 + r() * 0.7
    const off = first ? 0 : 0.5 + r() * 1.2
    const dir = [Math.cos(a) * lean, 1, Math.sin(a) * lean]
    const body = [...palette.body, 0.45]
    const tip = [...palette.tip, 1.0]
    g.crystal([Math.cos(a) * off, -0.6, Math.sin(a) * off], dir, rad, len, 6, t => t ? tip : body, { taper: 0.08, tip: rad * (1.2 + r() * 0.8), twist: r() * 0.5 })
    tallest = Math.max(tallest, len)
  }
  for (let i = 0; i < 6; i++) {
    const a = r() * TAU, d = 0.8 + r() * 1.8
    g.blob(Math.cos(a) * d, -0.1, Math.sin(a) * d, 0.5 + r() * 0.5, 0.3 + r() * 0.3, 0.5 + r() * 0.5, 1, [0.62, 0.6, 0.68, 0], (x, y, z) => 0.85 + 0.3 * Math.abs(Math.sin(x * 5 + z * 3)))
  }
  return { geo: g, height: tallest, radius: 1.2 }
}

// ── boulders ─────────────────────────────────────────────────────────────────
export function boulderGeo(seed, tint = [0.5, 0.49, 0.47]) {
  const r = rng(seed)
  const g = new Geo()
  const s = 1 + r() * 1.6
  const f1 = 2 + r() * 3, f2 = 3 + r() * 4
  g.blob(0, s * 0.35, 0, s * (1 + r() * 0.5), s * (0.6 + r() * 0.3), s * (0.9 + r() * 0.4), 2, [...tint, 0],
    (x, y, z) => 0.85 + 0.12 * Math.sin(x * f1 + z * 2) + 0.08 * Math.cos(y * f2 + x * 3) - Math.max(0, -y) * 0.3)
  return { geo: g, height: s, radius: s }
}

// ── Skyneedle Grove: mushrooms ─────────────────────────────────────────────
export function mushroomGeo(seed, scale = 1) {
  const r = rng(seed)
  const g = new Geo()
  const n = 1 + Math.floor(r() * 3)
  const caps = [[0.42, 0.2, 0.62], [0.2, 0.45, 0.62], [0.62, 0.35, 0.2]][Math.floor(r() * 3)]
  for (let i = 0; i < n; i++) {
    const a = r() * TAU, off = i ? 0.6 + r() * 0.9 : 0
    const h = (1.2 + r() * 1.8) * scale * (i ? 0.6 : 1)
    const cx = Math.cos(a) * off * scale, cz = Math.sin(a) * off * scale
    const lean = (r() - 0.5) * 0.4
    const stem = []
    for (let k = 0; k <= 6; k++) {
      const t = k / 6
      stem.push({ x: cx + lean * t * h * 0.3, y: t * h - 0.2, z: cz, r: (0.16 + 0.06 * (1 - t)) * scale })
    }
    g.tube(stem, 7, [0.82, 0.8, 0.72, 0.1], { capEnd: false })
    const capR = (0.55 + r() * 0.5) * scale * (i ? 0.7 : 1)
    const top = stem[stem.length - 1]
    // cap: brighter glowing gills underneath, spotted on top
    g.blob(top.x, top.y + capR * 0.1, top.z, capR, capR * 0.45, capR, 2,
      (x, y, z) => y < -0.2 ? [0.7, 0.95, 0.85, 1.0] : [...caps, r() < 0.06 ? 0.8 : 0.05],
      (x, y, z) => y < -0.3 ? 0.6 : 1)
  }
  return { geo: g, height: 2.5 * scale, radius: 0.4 * scale }
}

// ── Skyneedle ─────────────────────────────────────────────────────────────────
export function needleGeo(seed, height) {
  const r = rng(seed)
  const g = new Geo()
  const H = height
  const bendA = (r() - 0.5) * H * 0.05, bendB = (r() - 0.5) * H * 0.05
  const steps = Math.max(24, Math.round(H / 6))
  const path = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    path.push({
      x: Math.sin(t * Math.PI * 1.3) * bendA,
      y: -0.8 + t * (H + 0.8),
      z: Math.sin(t * Math.PI * 0.9 + 0.7) * bendB,
      r: 0.55 * (1 - t) + 0.1 * t,
    })
  }
  const pale = [0.8, 0.82, 0.77, 0], band = [0.25, 0.25, 0.24, 0]
  // birch-like dark bands round a pale trunk
  g.tube(path, 6, t => (Math.sin(t * H * 0.9) > 0.86 ? band : pale), { capEnd: true })
  // tufts of needles all the way up, and lantern bulbs among them
  const leaf = [0.16, 0.3, 0.16, 0], lantern = [0.75, 0.98, 0.9, 1.0]
  // spaced so a tree is ~1200 vertices, not ~2700 - a grove stands a
  // hundred of them in view
  for (let y = 9 + r() * 6; y < H - 6; y += 14 + r() * 10) {
    const t = y / H
    const i = Math.min(steps, Math.round(t * steps))
    const p = path[i]
    const n = 1 + Math.floor(r() * 2)
    for (let k = 0; k < n; k++) {
      const a = r() * TAU
      const reach = 0.9 + r() * 1.4 * (1 - t * 0.5)
      g.blob(p.x + Math.cos(a) * reach, p.y + r() * 1.2, p.z + Math.sin(a) * reach, 1.0 + r() * 0.8, 0.35 + r() * 0.3, 1.0 + r() * 0.8, 1, leaf,
        (x, yy, z) => 0.8 + 0.3 * Math.abs(Math.sin(x * 9 + z * 7)))
    }
    if (r() < 0.45) {
      const a = r() * TAU
      g.blob(p.x + Math.cos(a) * 0.7, p.y - 0.6, p.z + Math.sin(a) * 0.7, 0.22, 0.32, 0.22, 1, lantern)
    }
  }
  // the crown, lost in the sky
  const top = path[path.length - 1]
  for (let k = 0; k < 4; k++) {
    const a = r() * TAU, d = r() * 2.5
    g.blob(top.x + Math.cos(a) * d, top.y - 2 + r() * 4, top.z + Math.sin(a) * d, 2.2 + r() * 1.6, 0.9 + r() * 0.7, 2.2 + r() * 1.6, 1, leaf)
  }
  return { geo: g, height: H, radius: 0.55 }
}

// ── Clouds ───────────────────────────────────────────────────────────────────
// A cloud whose walkable top is at y = 0: billows heaped over a flat-ish
// underside, `w` by `d` across and `h` deep below the top.
export function cloudGeo(seed, w, d, h) {
  const r = rng(seed)
  const g = new Geo()
  const top = [0.98, 0.98, 1.0, 0.16], under = [0.66, 0.7, 0.8, 0.05]
  const color = (x, y, z) => mixColor(under, top, Math.max(0, Math.min(1, y * 0.5 + 0.55)))
  // few broad billows, each a 42-vertex sphere: a step cloud is ~250
  // vertices and the cloud stairs' island ~850 (they were ~900 and ~11000 -
  // 162-vertex billows packed one per 4 square metres)
  const n = Math.max(4, Math.min(16, Math.round((w * d) / 7)))
  for (let i = 0; i < n; i++) {
    const a = r() * TAU, rr = Math.sqrt(r())
    const px = Math.cos(a) * rr * w * 0.42, pz = Math.sin(a) * rr * d * 0.42
    const edge = 1 - rr * 0.45
    // each billow's crown sits just about at the walkable top, so feet sink
    // a hand's depth into the fluff rather than a metre
    const ry = h * (0.38 + r() * 0.2) * edge + 0.25
    const rxz = (0.8 + r() * 0.7) * Math.min(w, d) * 0.28 + 0.55
    g.blob(px, 0.14 - ry - r() * 0.12, pz, rxz, ry, rxz, 1, color,
      (x, y, z) => 0.9 + 0.12 * Math.sin(x * 6 + z * 4) * Math.cos(y * 5))
  }
  // a few billows proud of the top, so it reads as a cloud and not a cushion
  for (let i = 0; i < Math.max(2, n / 4); i++) {
    const a = r() * TAU, rr = Math.sqrt(r()) * 0.75
    const s = (0.45 + r() * 0.5) * Math.min(w, d) * 0.16 + 0.3
    g.blob(Math.cos(a) * rr * w * 0.42, -s * 0.45, Math.sin(a) * rr * d * 0.42, s, s * 0.7, s, 1, color)
  }
  return { geo: g, height: h, radius: Math.max(w, d) / 2 }
}

// ── Cloudstep Meadow: puffballs ─────────────────────────────────────────────
// giant dandelion clocks - a slender stem and a head like a small cloud,
// faintly lit from inside
export function puffballGeo(seed) {
  const r = rng(seed)
  const g = new Geo()
  const n = 1 + Math.floor(r() * 2)
  let tall = 0
  for (let i = 0; i < n; i++) {
    const a = r() * TAU, off = i ? 0.8 + r() * 1.2 : 0
    const h = (2.2 + r() * 2.6) * (i ? 0.7 : 1)
    const bx = Math.cos(a) * off, bz = Math.sin(a) * off
    const bend = (r() - 0.5) * 0.8
    const stem = []
    for (let k = 0; k <= 4; k++) {
      const t = k / 4
      stem.push({ x: bx + bend * t * t, y: t * h - 0.2, z: bz, r: 0.07 * (1 - t * 0.4) })
    }
    g.tube(stem, 4, [0.42, 0.6, 0.34, 0], { capEnd: false })
    const top = stem[stem.length - 1]
    const R = 0.55 + r() * 0.35
    g.blob(top.x, top.y + R * 0.6, top.z, R, R, R, 1, [0.95, 0.96, 0.98, 0.35],
      (x, y, z) => 0.92 + 0.1 * Math.sin(x * 11 + y * 7) * Math.cos(z * 9))
    tall = Math.max(tall, h + R * 1.6)
  }
  return { geo: g, height: tall, radius: 0.3 }
}
