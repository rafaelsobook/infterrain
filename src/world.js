import { ZONES } from './data'
import { riverAt, riverCenterX, riverProfileAt, riverGroundInfluence, isInRiver } from './river'

function hash(x, y, seed) {
  let h = (seed * 1234567 + x * 374761393 + y * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function lerp(a, b, t) { return a + (b - a) * t }
function smooth(t)      { return t * t * (3 - 2 * t) }
function clamp01(x)     { return x < 0 ? 0 : x > 1 ? 1 : x }

function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = x - ix,        fz = z - iz
  const ux = smooth(fx),    uz = smooth(fz)
  return lerp(
    lerp(hash(ix,     iz,     seed), hash(ix + 1, iz,     seed), ux),
    lerp(hash(ix,     iz + 1, seed), hash(ix + 1, iz + 1, seed), ux),
    uz
  )
}

function fbm(x, z, seed, octaves) {
  let v = 0, a = 1, f = 1, n = 0
  for (let i = 0; i < octaves; i++) {
    v += valueNoise(x * f, z * f, seed + i * 97) * a
    n += a; a *= 0.5; f *= 2
  }
  return v / n
}

const VALE_END  = 1360
const MARSH_END = 2720

function biomeWeights(x, z) {
  const lat = (fbm(x * 0.0015, z * 0.001, SEED + 400, 2) - 0.5) * 1000
  const zb  = z + lat
  const t1  = clamp01((zb - (VALE_END  - 30)) / 65)
  const t2  = clamp01((zb - (MARSH_END - 30)) / 65)
  const wVale  = 1 - smooth(t1)
  const wMarsh = smooth(t1) * (1 - smooth(t2))
  const wPeaks = smooth(t2)
  return { wVale, wMarsh, wPeaks }
}

export const SPAWN_X      = 0
export const SPAWN_Z      = 500
export const spawnAreaSize = 100
const HUB_HEIGHT           = 2
const HUB_INNER_R          = spawnAreaSize * 2
const HUB_OUTER_R          = spawnAreaSize * 3.5

export const WATER_LEVEL = -10
const SEED = 42

const RIDGE_H     = 26
const RIDGE_SZ    = 55
const PASS_HW     = 20
const PASS_EDGE   = 70

function ridgeContribution(x, z) {
  let h = 0
  for (const rz of [VALE_END, MARSH_END]) {
    const dz = z - rz
    if (Math.abs(dz) > RIDGE_SZ * 3.5) continue
    const gaussZ = Math.exp(-(dz * dz) / (2 * RIDGE_SZ * RIDGE_SZ))
    const dRoad = roadDistance(x, rz)
    const passT = clamp01((dRoad - PASS_HW) / (PASS_EDGE - PASS_HW))
    h += RIDGE_H * smooth(passT) * gaussZ
  }
  return h
}

const MTN_START = 13000
const MTN_FULL  = 18000

function mountainFactor(x, z) {
  const d = Math.hypot(x - SPAWN_X, z - SPAWN_Z)
  return clamp01((d - MTN_START) / (MTN_FULL - MTN_START))
}

export function getMountainFactor(x, z) { return mountainFactor(x, z) }

export function mesaTopBlend(x, z, slope) {
  const mf = mountainFactor(x, z)
  if (mf < 0.35) return 0
  const flatness = clamp01(1 - slope / 0.14)
  return clamp01((mf - 0.35) / 0.35) * flatness
}

export function campDirtAt(x, z) {
  const cx = Math.floor(x / 18), cz = Math.floor(z / 18)
  const v = hash(cx * 13 + 7, cz * 11 + 3, SEED + 888)
  return v > 0.60 ? smooth((v - 0.60) / 0.40) : 0
}

function mountainHeight(x, z) {
  const mf = mountainFactor(x, z)
  if (mf === 0) return 0
  const MWS = 0.0014
  const mqx = (fbm(x * MWS + 4.3, z * MWS + 8.1, SEED + 71, 3) - 0.5) * 110
  const mqz = (fbm(x * MWS + 2.7, z * MWS + 6.5, SEED + 73, 3) - 0.5) * 110
  const wx2 = x + mqx, wz2 = z + mqz
  const n = fbm(wx2 * 0.0045, wz2 * 0.0045, SEED + 500, 5)
  const t = clamp01((n - 0.40) / 0.30)
  const mesa = smooth(smooth(t))
  const topDetail = (fbm(wx2 * 0.05, wz2 * 0.05, SEED + 510, 3) - 0.5) * 10
  return smooth(smooth(mf)) * (mesa * 150 + topDetail)
}

const CLEAR_CELL = 650
const CLEAR_PROB = 0.55

function getClearing(cellX, cellZ) {
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

// The untouched landscape, BEFORE the river is cut into it. Split out of
// terrainHeight so the river carve below can read the land it is carving
// without calling back into the function it is part of.
function baseHeight(x, z) {
  const WS = 0.003, WA = 120
  const qx = (fbm(x * WS + 1.7, z * WS + 9.2, SEED + 13, 3) - 0.5) * WA
  const qz = (fbm(x * WS + 8.3, z * WS + 2.8, SEED + 17, 3) - 0.5) * WA
  const wx = x + qx,  wz = z + qz

  const large = fbm(wx * 0.011, wz * 0.011, SEED,     4) - 0.5
  const fine  = fbm(wx * 0.040, wz * 0.040, SEED + 7, 2) - 0.5

  const { wVale, wMarsh, wPeaks } = biomeWeights(x, z)
  const amp  = wVale * 52 + wMarsh * 22 + wPeaks * 60
  const base = wVale *  4 + wMarsh *  2 + wPeaks * 12

  let h = large * amp + fine * 2.2 + base
  h += ridgeContribution(x, z)
  h += mountainHeight(x, z)

  if (mountainFactor(x, z) < 0.15) {
    const cx0 = Math.floor(x / CLEAR_CELL)
    const cz0 = Math.floor(z / CLEAR_CELL)
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const cl = getClearing(cx0 + dx, cz0 + dz)
        if (!cl) continue
        const d = Math.hypot(x - cl.wx, z - cl.wz)
        if (d < cl.outerR) {
          const t     = clamp01((d - cl.innerR) / (cl.outerR - cl.innerR))
          const blend = smooth(smooth(t))
          h = h * blend + cl.flatH * (1 - blend)
        }
      }
  }

  const dHub = Math.hypot(x - SPAWN_X, z - SPAWN_Z)
  if (dHub < HUB_OUTER_R) {
    const t     = clamp01((dHub - HUB_INNER_R) / (HUB_OUTER_R - HUB_INNER_R))
    const blend = smooth(smooth(t))
    h = h * blend + HUB_HEIGHT * (1 - blend)
  }

  return h
}


// ── The river ─────────────────────────────────────────────────────────────
//
// river.js owns the river's PATH and CHARACTER (where it runs, how wide and
// deep it is, what each 100-unit stretch looks like). What it deliberately
// does not own is how high the water sits, because that is the one part that
// genuinely depends on the land - and this file is where the land lives.
//
// The water surface tracks the LOWEST untouched terrain along the river's own
// centreline within a window either side, so it descends with the landscape
// instead of running level forever - and, because it follows the low ground
// rather than the average ground, it stays below the banks beside it. See
// centerlineBaseAt for why an average failed at exactly that. RIVER_WINDOW is
// how far either way it looks.

// how far below the surrounding low ground the waterline sits, before the
// channel is cut any deeper. Keeps the surface visibly inset into its valley
// rather than laid on top of it
const RIVER_INSET  = 1.0
// half-width of the window scanned along the centreline, and how many samples
// span it
const RIVER_WINDOW  = 130
const RIVER_TAPS    = 11
// how far the ground rises above the waterline by the outer edge of the bank.
// Small on purpose: this is a shoreline, not a levee - its only job is to
// guarantee the water is contained rather than to build a visible wall
const LIP_RISE      = 1.2
// extra run beyond the bank over which the shoreline eases back into whatever
// the land was already doing, so the carve leaves no crease ring around itself
const VALLEY_EXTRA  = 42
// the profile is evaluated on this lattice and interpolated between - each
// node costs RIVER_TAPS baseHeight() calls, so without it every terrain vertex
// near the river would pay for nine extra full terrain evaluations
const RIVER_NODE    = 8
// a road crossing shallows the river into a ford instead of cutting the road
// in half. Exactly the mechanism ridgeContribution above already uses to punch
// a pass through a ridge, reused so the two behave consistently
const FORD_HW       = 14
const FORD_EDGE     = 46

const riverNodeCache = new Map()
const RIVER_CACHE_MAX = 4096

// LOWEST untouched-terrain height along the centreline within the window.
//
// A minimum, not an average. An average was the first attempt and it is wrong
// for the same reason it sounds right: wherever the land dips inside the
// window, the mean sits above that dip, so the water surface ends up ABOVE the
// bank beside it - measured at up to 23m of water floating on a hillside
// across a 6km test walk. A river runs along the low ground, so the surface
// has to track the low ground.
//
// A sliding-window minimum is continuous in z (as the window moves, the
// minimum can only change as fast as the samples entering and leaving it), so
// interpolating it across RIVER_NODE stays smooth enough for a water surface -
// it produces long level reaches separated by gentle descents, which is what a
// real river with pools in it does anyway.
function centerlineBaseAt(node) {
  const hit = riverNodeCache.get(node)
  if (hit !== undefined) return hit
  const z = node * RIVER_NODE
  let lo = Infinity
  for (let i = 0; i < RIVER_TAPS; i++) {
    const t  = RIVER_TAPS === 1 ? 0 : (i / (RIVER_TAPS - 1)) * 2 - 1
    const sz = z + t * RIVER_WINDOW
    const h = baseHeight(riverCenterX(sz), sz)
    if (h < lo) lo = h
  }
  const v = lo
  // plain FIFO eviction - this is walked in streaming order, so the oldest
  // entries are the ones furthest behind the camera
  if (riverNodeCache.size >= RIVER_CACHE_MAX) {
    riverNodeCache.delete(riverNodeCache.keys().next().value)
  }
  riverNodeCache.set(node, v)
  return v
}

/**
 * Height of the water surface at this Z. Constant across the channel's width
 * by construction (it is a function of z alone), which is what makes the river
 * read as a level sheet of water rather than a tilted one.
 */
export function riverSurfaceY(z) {
  const f  = z / RIVER_NODE
  const n0 = Math.floor(f)
  const t  = f - n0
  // A windowed minimum is continuous but only piecewise-LINEAR - it turns a
  // corner every time the lowest sample in the window changes, which showed up
  // as the water surface ramping at a visible 0.76 gradient where the window
  // slid past a drop. This tent-weighted pass over the neighbouring lattice
  // nodes rounds those corners off. Deliberately narrow (+-3 nodes, 24 units)
  // next to the +-130 window the minimum itself uses, so it softens the kinks
  // without pulling the surface back up above the banks the way a wide average
  // did when it was computing the surface outright.
  let sum = 0, wsum = 0
  for (let k = -3; k <= 3; k++) {
    const w = 4 - Math.abs(k)
    sum  += lerp(centerlineBaseAt(n0 + k), centerlineBaseAt(n0 + k + 1), t) * w
    wsum += w
  }
  return sum / wsum - RIVER_INSET
}

/**
 * 0..1 - how present the river is here at all. Fades it out of the mountains
 * (a river climbing a 150m mesa would be absurd) and out of the spawn hub, and
 * pinches it shallow where a road crosses so the crossing is a ford you can
 * walk rather than a cut you cannot.
 */
export function riverStrength(x, z) {
  let s = 1 - clamp01((mountainFactor(x, z) - 0.15) / 0.35)
  if (s <= 0) return 0
  const dHub = Math.hypot(x - SPAWN_X, z - SPAWN_Z)
  if (dHub < HUB_OUTER_R) s *= smooth(clamp01((dHub - HUB_INNER_R) / (HUB_OUTER_R - HUB_INNER_R)))
  const dRoad = roadDistance(x, z)
  if (dRoad < FORD_EDGE) s *= 0.25 + 0.75 * smooth(clamp01((dRoad - FORD_HW) / (FORD_EDGE - FORD_HW)))
  return s
}

/**
 * How deep the water is at this point, 0 outside the channel. The host uses
 * this for anything that needs to know it is standing in the river - and
 * grass/forest scattering uses it to stay out of the water.
 */
export function riverDepthAt(x, z) {
  if (!riverAt(x, z).channel) return 0
  if (riverStrength(x, z) <= 0) return 0
  // measured against the REAL carved ground, not the ideal bed - a ford or a
  // mountain fade leaves the bed higher than the ideal, and this has to report
  // the water that is actually there
  return Math.max(0, riverSurfaceY(z) - terrainHeight(x, z))
}

/**
 * Cut the river into an already-computed terrain height.
 *
 * Three zones across the section, each meeting the next at exactly the same
 * height so there is no step anywhere:
 *
 *   0 .. halfWidth                   bed rises from its deepest at the centre
 *                                    to exactly the waterline at the edge, so
 *                                    the river is naturally shallow at its
 *                                    margins instead of a rectangular trench
 *   halfWidth .. +bankRun            waterline up to the lip, just clear of
 *                                    the water - this is what guarantees the
 *                                    river is contained
 *   +bankRun .. +valleyRun           lip eases back into untouched land
 *
 * bankRun scales with how deep the cut actually is, so a gorge gets a
 * proportionally wider shoulder instead of a vertical wall - without it the
 * deep variants cut near-cliffs wherever they crossed high ground.
 */
function carveRiver(x, z, h) {
  const s = riverStrength(x, z)
  if (s <= 0) return h
  const r = riverAt(x, z)
  const p = r.profile

  const surface = riverSurfaceY(z)
  const bankRun   = Math.max(p.bank, p.depth * s * 1.1)
  const valleyRun = VALLEY_EXTRA + p.depth * s * 1.5
  const outer = p.halfWidth + bankRun + valleyRun
  if (r.dist >= outer) return h

  const d = r.dist
  let target
  if (d <= p.halfWidth) {
    const bed = surface - p.depth * s
    target = lerp(bed, surface, smooth(d / p.halfWidth))
  } else if (d <= p.halfWidth + bankRun) {
    const lip = surface + LIP_RISE * s
    target = lerp(surface, lip, smooth((d - p.halfWidth) / bankRun))
  } else {
    const lip = surface + LIP_RISE * s
    target = lerp(lip, h, smooth((d - p.halfWidth - bankRun) / valleyRun))
  }
  // `s` also fades the whole carve, so a ford or the edge of the mountains
  // blends the river out rather than ending it at a hard line
  return lerp(h, target, s)
}

export function terrainHeight(x, z) {
  return carveRiver(x, z, baseHeight(x, z))
}

/** 0..1 for the terrain splat - see river.js's riverGroundInfluence. */
export function riverSplatAt(x, z) {
  const s = riverStrength(x, z)
  return s <= 0 ? 0 : riverGroundInfluence(x, z) * s
}

/** Rockiness of the bed here, 0..1, for the splat's rock layer. */
export function riverRockAt(x, z) {
  const s = riverStrength(x, z)
  if (s <= 0) return 0
  const infl = riverGroundInfluence(x, z)
  return infl <= 0 ? 0 : riverProfileAt(z).rock * infl * s
}

/** Keeps scatter passes (grass, trees) out of the water. */
export function inRiverChannel(x, z, margin = 0) {
  return riverStrength(x, z) > 0.15 && isInRiver(x, z, margin)
}

export function backgroundTerrainHeight(x, z, hillSize) {
  const f     = 0.011 * hillSize
  const large = fbm(x * f, z * f, SEED + 200, 3) - 0.5
  const fine  = fbm(x * f * 4, z * f * 4, SEED + 207, 2) - 0.5
  let h = large * 80 + fine * 5 + 18
  const dHub = Math.hypot(x - SPAWN_X, z - SPAWN_Z)
  if (dHub < HUB_OUTER_R) {
    const t     = clamp01((dHub - HUB_INNER_R) / (HUB_OUTER_R - HUB_INNER_R))
    const blend = smooth(smooth(t))
    h = h * blend + HUB_HEIGHT * (1 - blend)
  }
  return h
}

export function zoneBiomeAt(z) {
  for (const zone of ZONES)
    if (z >= zone.zMin && z < zone.zMax) return zone.id
  return 'vale'
}

const ROADS = [
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
