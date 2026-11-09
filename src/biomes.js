// ── Biomes ───────────────────────────────────────────────────────────────
//
// The wilds between the roads, cut into regions roughly BIOME_CELL across,
// each drawn by hash from a table of strange lands:
//
//   emberfrost   black basalt plates split by fissures of slow lava, and
//                trees grown out of ice standing in the heat
//   thornvine    pale dunes under giant ribbed cacti, with vines thicker
//                than a house arching out of the sand and back in
//   cloudmeadow  bright soft meadow where clouds drift low enough to climb
//   crystal      shattered pale stone, huge glowing crystals leaning out of it
//   skyneedle    a dark mossy grove of trees thinner than your arm that rise
//                out of sight into the sky
//   native       none of it - the land as it always was
//
// Pure math, like river.js: this file answers "what land is this and how is
// it shaped", world.js folds the shape into terrainHeight, terrain.js paints
// the ground from the weights, and features.js grows the props.
//
// WHERE THEY CAN BE. A biome is only ever allowed in the wilds - away from
// every road, the spawn hub, the river, the forest clearings and the host's
// kept-clear spots (keepclear.js). Those are where a host's own content sits,
// so a host that built along the roads keeps exactly the ground it built on.
// The `wild` mask below is that rule, and every weight here is multiplied by
// it. Regions blend into each other, and into native land, over BORDER units
// either side of their edge, so nothing ever changes at a line.

import { hash, smooth, smoothstep, lerp, fbm, ridged, cellular } from './noise'
import { SPAWN_X, SPAWN_Z, roadDistance, clearingAt } from './layout'
import { riverCenterX } from './river'
import { keepClearFactor, keepClearVersion } from './keepclear'

const SEED = 4242

export const BIOME_CELL = 760
const BORDER = 150

export const BIOME_KINDS = ['emberfrost', 'thornvine', 'cloudmeadow', 'crystal', 'skyneedle']

export const BIOME_INFO = {
  native:      { name: 'The Wilds' },
  emberfrost:  { name: 'Emberfrost Rift' },
  thornvine:   { name: 'Thornvine Barrens' },
  cloudmeadow: { name: 'Cloudstep Meadow' },
  crystal:     { name: 'Crystal Hollows' },
  skyneedle:   { name: 'Skyneedle Grove' },
}

// how often each region type is drawn. Native land is a real share of it on
// purpose - strange land reads as strange because there is ordinary land
// between it
const PICK = [
  ['native', 24],
  ['emberfrost', 16],
  ['thornvine', 15],
  ['cloudmeadow', 15],
  ['crystal', 15],
  ['skyneedle', 15],
]
const PICK_TOTAL = PICK.reduce((s, p) => s + p[1], 0)

// ── the wild mask ─────────────────────────────────────────────────────────
// how far from a road, the hub and the river before anything may change.
// Every one of the host's roadside sites (castles, graveyards) sits within
// ~200 of a road, so the fade starts beyond that
const ROAD_CLEAR = 200
const ROAD_FULL  = 380
const HUB_CLEAR  = 650
const HUB_FULL   = 950
const RIVER_CLEAR = 110
const RIVER_FULL  = 240

function wildRaw(x, z) {
  const hub = smoothstep(HUB_CLEAR, HUB_FULL, Math.hypot(x - SPAWN_X, z - SPAWN_Z))
  if (hub <= 0) return 0
  const river = smoothstep(RIVER_CLEAR, RIVER_FULL, Math.abs(x - riverCenterX(z)))
  if (river <= 0) return 0
  const road = smoothstep(ROAD_CLEAR, ROAD_FULL, roadDistance(x, z))
  if (road <= 0) return 0
  const keep = keepClearFactor(x, z)
  if (keep <= 0) return 0
  return hub * river * road * keep * (1 - clearingAt(x, z))
}

// the mask is smooth by construction (every term above eases over 100+
// units), so it is sampled on a lattice and interpolated - each sample costs
// a pass over every road segment, which would otherwise be paid per terrain
// vertex and per scattered prop
const LAT = 32
const latCache = new Map()
const LAT_CACHE_MAX = 120000
let latVersion = -1

function latAt(ix, iz) {
  const v = keepClearVersion()
  if (v !== latVersion) { latCache.clear(); latVersion = v }
  const key = ix * 100003 + iz
  let w = latCache.get(key)
  if (w === undefined) {
    w = wildRaw(ix * LAT, iz * LAT)
    if (latCache.size >= LAT_CACHE_MAX) latCache.delete(latCache.keys().next().value)
    latCache.set(key, w)
  }
  return w
}

/** 0..1 - how much this point belongs to the wilds rather than to roads, hub and host. */
export function wildness(x, z) {
  const fx = x / LAT, fz = z / LAT
  const ix = Math.floor(fx), iz = Math.floor(fz)
  const tx = fx - ix, tz = fz - iz
  return lerp(lerp(latAt(ix, iz), latAt(ix + 1, iz), tx), lerp(latAt(ix, iz + 1), latAt(ix + 1, iz + 1), tx), tz)
}

// ── regions ───────────────────────────────────────────────────────────────
const cellCache = new Map()

function regionCell(ix, iz) {
  const key = ix * 100003 + iz
  let c = cellCache.get(key)
  if (c) return c
  const x = (ix + 0.2 + hash(ix, iz, SEED + 1) * 0.6) * BIOME_CELL
  const z = (iz + 0.2 + hash(ix, iz, SEED + 2) * 0.6) * BIOME_CELL
  let roll = hash(ix, iz, SEED + 3) * PICK_TOTAL
  let kind = PICK[0][0]
  for (const [k, w] of PICK) { roll -= w; if (roll < 0) { kind = k; break } }
  c = { x, z, kind }
  if (cellCache.size > 4096) cellCache.delete(cellCache.keys().next().value)
  cellCache.set(key, c)
  return c
}

/** The region a point falls in (ignoring the wild mask) - kind and centre. */
export function regionAt(x, z) {
  const gx = Math.floor(x / BIOME_CELL), gz = Math.floor(z / BIOME_CELL)
  let best = null, bd = Infinity
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const c = regionCell(gx + dx, gz + dz)
      const d = Math.hypot(x - c.x, z - c.z)
      if (d < bd) { bd = d; best = c }
    }
  return best
}

/**
 * Weight of every biome at this point, each 0..1, summing to at most 1 - the
 * rest is native land. `wild` is the mask they were all scaled by.
 */
export function biomeWeightsAt(x, z) {
  const out = { emberfrost: 0, thornvine: 0, cloudmeadow: 0, crystal: 0, skyneedle: 0, wild: 0 }
  const wild = wildness(x, z)
  out.wild = wild
  if (wild <= 0.001) return out

  const gx = Math.floor(x / BIOME_CELL), gz = Math.floor(z / BIOME_CELL)
  let a = null, b = null, da = Infinity, db = Infinity
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const c = regionCell(gx + dx, gz + dz)
      const d = Math.hypot(x - c.x, z - c.z)
      if (d < da) { db = da; b = a; da = d; a = c }
      else if (d < db) { db = d; b = c }
    }
  // distance to the bisector between the two nearest centres - the region edge
  const sep = Math.hypot(b.x - a.x, b.z - a.z) || 1
  const edge = (db * db - da * da) / (2 * sep)
  const t = smoothstep(0, BORDER, edge)
  const wa = 0.5 + 0.5 * t
  if (a.kind !== 'native') out[a.kind] += wa * wild
  if (b.kind !== 'native') out[b.kind] += (1 - wa) * wild
  return out
}

/** The kind with the most weight here, 'native' when nothing passes `min`. */
export function dominantBiome(w, min = 0.35) {
  let best = 'native', bw = min
  for (const k of BIOME_KINDS) if (w[k] > bw) { bw = w[k]; best = k }
  return best
}

// ── shapes ────────────────────────────────────────────────────────────────
// Each returns a height DELTA on top of the native land. Wavelengths are all
// several terrain cells long: the mesh samples terrainHeight every 16 units at
// the default verts, and anything finer than a couple of cells is simply not
// in the drawn ground however strongly it is carved (see river.js's own note
// on RIVER_VARIANTS).

// basalt plates split by fissures. The fissures sit below lavaLevelAt, the
// plates above it, so lava fills the cracks between them
function emberDelta(x, z) {
  const c = cellular(x, z, 104, SEED + 11)
  const plate = smoothstep(3, 18, c.edge)
  const lift = 2.5 + hash(c.cx, c.cz, SEED + 12) * 4.5
  const crust = (ridged(x * 0.011, z * 0.011, SEED + 13, 3) - 0.5) * 3
  return plate * (lift + crust) - (1 - plate) * 6
}

// long dunes, gentle on the windward face and steeper behind the crest
function thornDelta(x, z) {
  const warp = (fbm(x * 0.0025, z * 0.0025, SEED + 21, 2) - 0.5) * 3.2
               + (fbm(x * 0.011, z * 0.011, SEED + 22, 2) - 0.5) * 0.6
  const phase = (x * 0.8 + z * 0.6) / 92 + warp
  const s = phase - Math.floor(phase)
  const profile = s < 0.7 ? smooth(s / 0.7) : 1 - smooth((s - 0.7) / 0.3)
  const amp = 3 + fbm(x * 0.005, z * 0.005, SEED + 23, 2) * 5
  return (profile - 0.4) * amp
}

// round soft knolls, the meadow lifted a little off the land around it
function meadowDelta(x, z) {
  return (fbm(x * 0.018, z * 0.018, SEED + 31, 2) - 0.5) * 5 + 1.5
}

// broken shallow ridges, like the ground cracked when the crystals came up
function crystalDelta(x, z) {
  return (ridged(x * 0.009, z * 0.009, SEED + 41, 3) - 0.55) * 8
}

// a damp forest floor, small hummocks
function needleDelta(x, z) {
  return (fbm(x * 0.028, z * 0.028, SEED + 51, 2) - 0.5) * 3 - 0.5
}

/**
 * How strongly a biome shapes the land grows with distance from spawn - the
 * first regions you reach are gentler versions of what lies further out.
 */
export function biomeStrength(x, z) {
  return lerp(0.6, 1, smoothstep(900, 2800, Math.hypot(x - SPAWN_X, z - SPAWN_Z)))
}

/** The height every biome adds here, weighted. 0 in native land. */
export function biomeHeightDelta(x, z, w = biomeWeightsAt(x, z)) {
  if (w.wild <= 0.001) return 0
  const s = biomeStrength(x, z)
  let d = 0
  if (w.emberfrost > 0.001)  d += w.emberfrost  * emberDelta(x, z)
  if (w.thornvine > 0.001)   d += w.thornvine   * thornDelta(x, z)
  if (w.cloudmeadow > 0.001) d += w.cloudmeadow * meadowDelta(x, z)
  if (w.crystal > 0.001)     d += w.crystal     * crystalDelta(x, z)
  if (w.skyneedle > 0.001)   d += w.skyneedle   * needleDelta(x, z)
  return d * s
}

/** How far below the native land the lava sits in emberfrost fissures. */
export const LAVA_DROP = 2.2
// the deepest it gets over the ground beneath - knee deep, wade-able
export const LAVA_DEPTH = 0.6

/** 0..1 on the plates (cool), toward 0 in a fissure - for glow and placement. */
export function emberPlateAt(x, z) {
  const c = cellular(x, z, 104, SEED + 11)
  return smoothstep(3, 18, c.edge)
}

export function biomeName(x, z) {
  const w = biomeWeightsAt(x, z)
  return BIOME_INFO[dominantBiome(w)].name
}

/**
 * How much of the ordinary vegetation a biome crowds out here, 0..1 - the
 * forest's oaks and the grass cards don't belong in a lava field or on a dune.
 * `kind` is 'tree' or 'grass'. Meadows keep their grass, needle groves keep a
 * little; the rest lose nearly all of both.
 */
export function foliageSuppression(x, z, kind = 'tree') {
  const w = biomeWeightsAt(x, z)
  if (w.wild <= 0.001) return 0
  const s = kind === 'grass'
    ? w.emberfrost * 1 + w.thornvine * 0.95 + w.crystal * 0.85 + w.cloudmeadow * 0 + w.skyneedle * 0.55
    : w.emberfrost * 1 + w.thornvine * 0.97 + w.crystal * 0.9 + w.cloudmeadow * 0.6 + w.skyneedle * 0.9
  return s < 0 ? 0 : s > 1 ? 1 : s
}
