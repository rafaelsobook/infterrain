// Places the newer world features stay out of.
//
// Everything biomes.js and sites.js add is decided by hash, so without help a
// lava field or a waterfall cliff could land on top of something a host built
// at a fixed coordinate. Most of that is already safe by construction - none
// of it goes near a road, the river, the spawn hub or a forest clearing, which
// is where a host's own content tends to sit - but anything built out in the
// wilds needs naming here.
//
// The defaults are the fixed sites of the vessel open world (its castles,
// witch towers and graveyards), the game this package grew up in. A host with
// its own layout replaces them through createOpenWorld's `keepClear` option:
// an array of { x, z, r } circles. Inside r nothing changes at all; the new
// terrain eases in over KEEP_FADE beyond it.

export const KEEP_FADE = 160

export const DEFAULT_KEEP_CLEAR = [
  // castles
  { x: 0, z: 600, r: 140 },
  { x: 100.6, z: 1500, r: 140 },
  { x: 80.6, z: -600, r: 140 },
  { x: 1000.6, z: 380, r: 140 },
  { x: -974.4, z: 480, r: 140 },
  // witch towers
  { x: -1893, z: 563, r: 60 },
  { x: 1200, z: 800, r: 60 },
  { x: -600, z: -1400, r: 60 },
  // graveyards (their areaSize plus a margin)
  { x: 412, z: 255, r: 130 },
  { x: 875, z: 400, r: 110 },
  { x: 775, z: 1125, r: 100 },
  { x: -325, z: 2025, r: 90 },
  { x: -50, z: 1575, r: 90 },
  { x: -50, z: 2850, r: 90 },
  { x: 50, z: 2400, r: 80 },
  { x: 325, z: 1875, r: 80 },
  { x: -1750, z: 500, r: 80 },
  { x: -1300, z: 625, r: 70 },
  { x: 1650, z: 525, r: 70 },
  { x: -825, z: 600, r: 70 },
  { x: 325, z: 825, r: 70 },
]

let spots = DEFAULT_KEEP_CLEAR
let version = 0

/** Replace the keep-clear list. Must run before any terrain is built. */
export function setKeepClear(list) {
  spots = Array.isArray(list) ? list.filter(s => s && Number.isFinite(s.x) && Number.isFinite(s.z) && Number.isFinite(s.r)) : DEFAULT_KEEP_CLEAR
  version++
}

/** Bumped whenever the list changes, so callers caching against it can drop their cache. */
export function keepClearVersion() { return version }

/** 0 inside a kept-clear circle, easing to 1 over KEEP_FADE beyond it. */
export function keepClearFactor(x, z) {
  let f = 1
  for (const s of spots) {
    const d = Math.hypot(x - s.x, z - s.z) - s.r
    if (d >= KEEP_FADE) continue
    if (d <= 0) return 0
    const t = d / KEEP_FADE
    f *= t * t * (3 - 2 * t)
  }
  return f
}

/** True when a circle of radius r around (x, z) would touch a kept-clear spot. */
export function overlapsKeepClear(x, z, r) {
  for (const s of spots) if (Math.hypot(x - s.x, z - s.z) < s.r + r + 40) return true
  return false
}
