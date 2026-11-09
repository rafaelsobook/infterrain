// The world's fixed layout: where you spawn, the flattened hub around it, the
// road network, the forest clearings, and the sea level.
//
// Moved out of world.js unchanged (same numbers, same seed, same hash) so the
// newer pure-math files - biomes.js, sites.js - can ask "how far is the
// nearest road" without importing world.js, which in turn imports them to
// shape the terrain. world.js re-exports everything here that it always did.

import { hash, smooth } from './noise'

const SEED = 42

export const SPAWN_X       = 0
export const SPAWN_Z       = 500
export const spawnAreaSize = 100
export const HUB_HEIGHT    = 2
export const HUB_INNER_R   = spawnAreaSize * 2
export const HUB_OUTER_R   = spawnAreaSize * 3.5

export const WATER_LEVEL = -10

// ── Forest clearings ──────────────────────────────────────────────────────
export const CLEAR_CELL = 650
const CLEAR_PROB = 0.55

export function getClearing(cellX, cellZ) {
  if (hash(cellX * 7 + 3, cellZ * 13 + 5, SEED + 999) > CLEAR_PROB) return null
  const h1 = hash(cellX, cellZ, SEED + 1001)
  const h2 = hash(cellX, cellZ, SEED + 1002)
  const h3 = hash(cellX, cellZ, SEED + 1003)
  const h4 = hash(cellX, cellZ, SEED + 1004)
  const wx     = cellX * CLEAR_CELL + h1 * CLEAR_CELL
  const wz     = cellZ * CLEAR_CELL + h2 * CLEAR_CELL
  if (Math.hypot(wx - SPAWN_X, wz - SPAWN_Z) < 700) return null
  const innerR = 55 + h3 * 90
  return { wx, wz, innerR, outerR: innerR * 2.5, flatH: 2 + h4 * 7 }
}

export function clearingAt(x, z) {
  const cx0 = Math.floor(x / CLEAR_CELL)
  const cz0 = Math.floor(z / CLEAR_CELL)
  let best = 0
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const cl = getClearing(cx0 + dx, cz0 + dz)
      if (!cl) continue
      const d = Math.hypot(x - cl.wx, z - cl.wz)
      if (d < cl.innerR) best = Math.max(best, 1 - smooth(d / cl.innerR))
    }
  return best
}

/** 0..1, how far into a clearing's flattened apron (outerR) this point is. */
export function clearingApronAt(x, z) {
  const cx0 = Math.floor(x / CLEAR_CELL)
  const cz0 = Math.floor(z / CLEAR_CELL)
  let best = 0
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const cl = getClearing(cx0 + dx, cz0 + dz)
      if (!cl) continue
      const d = Math.hypot(x - cl.wx, z - cl.wz)
      if (d < cl.outerR) best = Math.max(best, 1 - smooth(Math.max(0, d - cl.innerR) / (cl.outerR - cl.innerR)))
    }
  return best
}

// ── Roads ─────────────────────────────────────────────────────────────────
export const ROADS = [
  [
    { x:   0, z:   500 }, { x: -30, z:   650 }, { x: -55, z:   820 },
    { x: -20, z:  1000 }, { x:  10, z:  1180 }, { x:  -5, z:  1360 },
    { x:   5, z:  1550 }, { x:  -8, z:  1750 }, { x:   0, z:  1900 },
    { x:  15, z:  2100 }, { x:  -5, z:  2400 }, { x:  20, z:  3200 },
    { x: -15, z:  4000 }, { x:  35, z:  4900 }, { x: -25, z:  5800 },
    { x:  15, z:  6800 }, { x: -30, z:  7900 }, { x:  20, z:  9000 },
    { x: -10, z: 10500 },
  ],
  [
    { x:   0, z:   500 }, { x:   8, z:   385 }, { x:  -5, z:   265 },
    { x:   0, z:   155 }, { x:  15, z:     0 }, { x: -10, z:  -900 },
    { x:  20, z: -1900 }, { x: -15, z: -3000 }, { x:  10, z: -4200 },
    { x: -20, z: -5500 }, { x:  15, z: -7000 },
  ],
  [
    { x:     0, z: 500 }, { x:   120, z: 505 }, { x:   280, z: 490 },
    { x:   480, z: 480 }, { x:   700, z: 465 }, { x:  1000, z: 455 },
    { x:  1450, z: 445 }, { x:  2000, z: 440 }, { x:  2800, z: 430 },
    { x:  4000, z: 425 }, { x:  5600, z: 415 }, { x:  7500, z: 410 },
    { x:  9500, z: 405 },
  ],
  [
    { x:     0, z: 500 }, { x:  -120, z: 520 }, { x:  -280, z: 540 },
    { x:  -480, z: 550 }, { x:  -700, z: 555 }, { x: -1000, z: 560 },
    { x: -1450, z: 555 }, { x: -2000, z: 550 }, { x: -2800, z: 545 },
    { x: -4000, z: 540 }, { x: -5600, z: 530 }, { x: -7500, z: 525 },
    { x: -9500, z: 520 },
  ],
  [
    { x:   0, z:  500 }, { x:  85, z:  565 }, { x: 175, z:  625 },
    { x: 260, z:  680 }, { x: 380, z:  780 }, { x: 550, z:  930 },
    { x: 720, z: 1130 },
  ],
  [
    { x:   0, z:  500 }, { x:  90, z:  415 }, { x: 175, z:  340 },
    { x: 280, z:  240 }, { x: 420, z:  120 }, { x: 570, z:    0 },
  ],
  [
    { x:   0, z: 1800 }, { x: 100, z: 1860 },
    { x: 210, z: 1900 }, { x: 300, z: 1930 },
  ],
  [
    { x:    0, z: 1800 }, { x: -100, z: 1860 },
    { x: -210, z: 1900 }, { x: -300, z: 1930 },
  ],
]

export function roadDistance(x, z) {
  let best = Infinity
  for (const road of ROADS) {
    for (let i = 0; i < road.length - 1; i++) {
      const a = road[i], b = road[i + 1]
      const abx = b.x - a.x, abz = b.z - a.z
      const apx = x - a.x,   apz = z - a.z
      const len2 = abx * abx + abz * abz
      const t    = len2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apz * abz) / len2)) : 0
      const d    = Math.hypot(apx - abx * t, apz - abz * t)
      if (d < best) best = d
    }
  }
  return best
}

// how far along each road its every point is - for walking a road by
// distance (world.js's road surface)
const ROAD_LENGTHS = ROADS.map(road => {
  const acc = [0]
  for (let i = 1; i < road.length; i++) {
    acc.push(acc[i - 1] + Math.hypot(road[i].x - road[i - 1].x, road[i].z - road[i - 1].z))
  }
  return acc
})

/**
 * The road nearest (x, z): which one, how far along it the closest point of
 * its centreline lies, and how far away that point is.
 */
export function nearestRoad(x, z) {
  let best = Infinity, bestRoad = 0, bestS = 0
  for (let r = 0; r < ROADS.length; r++) {
    const road = ROADS[r]
    for (let i = 0; i < road.length - 1; i++) {
      const a = road[i], b = road[i + 1]
      const abx = b.x - a.x, abz = b.z - a.z
      const apx = x - a.x,   apz = z - a.z
      const len2 = abx * abx + abz * abz
      const t    = len2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apz * abz) / len2)) : 0
      const d    = Math.hypot(apx - abx * t, apz - abz * t)
      if (d < best) { best = d; bestRoad = r; bestS = ROAD_LENGTHS[r][i] + t * Math.sqrt(len2) }
    }
  }
  return { road: bestRoad, s: bestS, dist: best }
}

/** The point `s` along road `r`'s centreline, held at its ends beyond them. */
export function roadPointAt(r, s) {
  const road = ROADS[r], acc = ROAD_LENGTHS[r]
  if (s <= 0) return road[0]
  for (let i = 1; i < road.length; i++) {
    if (s > acc[i]) continue
    const t = (s - acc[i - 1]) / (acc[i] - acc[i - 1])
    return { x: road[i - 1].x + (road[i].x - road[i - 1].x) * t, z: road[i - 1].z + (road[i].z - road[i - 1].z) * t }
  }
  return road[road.length - 1]
}
