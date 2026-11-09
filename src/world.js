import { ZONES } from './data'
import { riverAt, riverCenterX, riverProfileAt, riverGroundInfluence, isInRiver } from './river'
import {
  SPAWN_X, SPAWN_Z, spawnAreaSize, HUB_HEIGHT, HUB_INNER_R, HUB_OUTER_R, WATER_LEVEL,
  CLEAR_CELL, getClearing, clearingAt, roadDistance, nearestRoad, roadPointAt,
} from './layout'
import { biomeHeightDelta, biomeWeightsAt, LAVA_DROP, LAVA_DEPTH } from './biomes'
import { applySites, setGroundSource, setLavaSource, lidHeightAt } from './sites'

// the layout lives in layout.js now (so biomes.js and sites.js can read the
// roads without importing this file back) - re-exported so every existing
// import of these from here keeps working
export { SPAWN_X, SPAWN_Z, spawnAreaSize, WATER_LEVEL, clearingAt, roadDistance }

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

// The land's own lie - hills, ridges, the far mountains - before a biome,
// a clearing or the hub touches it.
function nativeShape(x, z) {
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
  return h
}

/**
 * The land's own height here before any biome reshapes it. The emberfrost
 * lava sits a fixed drop below this, so it follows the lie of the land the way
 * a slow flow would, while the biome's fissures cut below it and its plates
 * rise above.
 */
export function nativeHeightAt(x, z) {
  return nativeShape(x, z)
}

/**
 * Height of the lava surface in emberfrost land (meaningful only there).
 * Levelled with the land where a clearing or the hub flattens it, and never
 * more than LAVA_DEPTH over the ground beneath - before, it ignored both and
 * hung as much as 24 high over a clearing's lowered apron, a sheet you
 * stepped onto and dropped straight through.
 */
export function lavaLevelAt(x, z) {
  return Math.min(levelLayout(x, z, nativeShape(x, z) - LAVA_DROP), groundBeforeSites(x, z) + LAVA_DEPTH)
}

// The untouched landscape, BEFORE the river is cut into it. Split out of
// terrainHeight so the river carve below can read the land it is carving
// without calling back into the function it is part of.
function baseHeight(x, z) {
  return levelRoads(x, z, landHeight(x, z))
}

// the land before the roads are levelled into it - what a road's own surface
// is smoothed from
function landHeight(x, z) {
  const native = nativeShape(x, z)
  // biomes (biomes.js) - zero everywhere but the wilds, so roads, the hub,
  // the river and anything a host built near them keep their old ground
  const w = biomeWeightsAt(x, z)
  let h = native + biomeHeightDelta(x, z, w)
  // emberfrost's fissures fill with lava no deeper than LAVA_DEPTH. Cut to
  // their full depth (6 under the land) the lava was taller than a player,
  // who sank under the glowing surface into a dark trench too steep to climb
  // out of - it read as falling into the void
  if (w.emberfrost > 0.3) {
    const floor = native - LAVA_DROP - LAVA_DEPTH
    if (h < floor) h += (floor - h) * smooth(clamp01((w.emberfrost - 0.3) / 0.2))
  }
  return levelLayout(x, z, h)
}

// the clearings and the hub, levelled - for the land (baseHeight) and the
// lava over it (lavaLevelAt) alike
function levelLayout(x, z, h) {
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


// ── The roads ─────────────────────────────────────────────────────────────
//
// A road is levelled side to side and smoothed along its length, so a wagon
// rolls along it instead of pitching over every bump. Its surface follows the
// land along its own centreline, averaged over ROAD_SMOOTH_TAPS nodes either
// way: the small bumps go and the big hills stay - cut a little at a crest,
// built up a little in a dip, the way a real road is. Within ROAD_FLAT_HW of
// the centreline the ground is that surface, easing back into the land by
// ROAD_FLAT_EDGE.
//
// The drawn ground is a grid of 16-unit cells (256 chunks at verts 17), far
// coarser than the 6-wide dirt strip, so the levelled band has to reach about
// a cell each side for the triangles the road runs over to come out level.
//
// None of this reaches a biome or a special place - both keep well over a
// hundred units from every road. The river is cut after it, so a ford still
// dips where a road crosses the water.
const ROAD_FLAT_HW     = 10
const ROAD_FLAT_EDGE   = 30
// the surface is worked out on nodes this far apart along a road and
// interpolated between, each averaging the land over this many nodes either
// side of it (3 x 8 = 24 units each way)
const ROAD_NODE        = 8
const ROAD_SMOOTH_TAPS = 2

// each node is worked out once and kept - the whole network is only a few
// thousand of them
const roadLandCache    = new Map()
const roadSurfaceCache = new Map()

function roadLandAt(r, k) {
  const key = r * 1e5 + k
  let v = roadLandCache.get(key)
  if (v === undefined) {
    const p = roadPointAt(r, k * ROAD_NODE)
    v = landHeight(p.x, p.z)
    roadLandCache.set(key, v)
  }
  return v
}

function roadNodeSurface(r, k) {
  const key = r * 1e5 + k
  let v = roadSurfaceCache.get(key)
  if (v === undefined) {
    let sum = 0, wsum = 0
    for (let i = -ROAD_SMOOTH_TAPS; i <= ROAD_SMOOTH_TAPS; i++) {
      const w = ROAD_SMOOTH_TAPS + 1 - Math.abs(i)
      sum  += roadLandAt(r, k + i) * w
      wsum += w
    }
    v = sum / wsum
    roadSurfaceCache.set(key, v)
  }
  return v
}

function levelRoads(x, z, h) {
  const near = nearestRoad(x, z)
  if (near.dist >= ROAD_FLAT_EDGE) return h
  const f = near.s / ROAD_NODE
  const k = Math.floor(f)
  const surface = lerp(roadNodeSurface(near.road, k), roadNodeSurface(near.road, k + 1), f - k)
  const t = smooth(clamp01((near.dist - ROAD_FLAT_HW) / (ROAD_FLAT_EDGE - ROAD_FLAT_HW)))
  return lerp(surface, h, t)
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
    // the land before the roads are levelled in - a road crossing must not
    // move the water, or the whole reach either side of it shifts too
    const h = landHeight(riverCenterX(sz), sz)
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

/** The land with the river cut into it, before any special place (sites.js) touches it. */
export function groundBeforeSites(x, z) {
  return carveRiver(x, z, baseHeight(x, z))
}
setGroundSource(groundBeforeSites)
setLavaSource(lavaLevelAt)

export function terrainHeight(x, z) {
  return applySites(x, z, carveRiver(x, z, baseHeight(x, z)))
}

/**
 * The walkable surface here - terrainHeight, except where a site's lid covers
 * the pit dug under a well, where it is the lid.
 */
export function surfaceHeight(x, z) {
  return lidHeightAt(x, z) ?? terrainHeight(x, z)
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
