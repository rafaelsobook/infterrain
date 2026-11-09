// ── Special places ──────────────────────────────────────────────────────────
//
// The one-off things you come across in the wilds, as opposed to the props a
// biome is covered in:
//
//   well       a wide, square-cut stone well on a flattened green - fall in,
//              and it is thirty-odd metres deep, with plank stairs climbing
//              its walls in flights, corner to corner, to get back out
//   grotto     a sheer, box-cut crag standing on the field, one dark opening
//              in its front, and through it a maze of dark passages - ores,
//              cages, cargo, and one treasure walled away
//   falls      a cliff with a waterfall pouring into a pool - and behind the
//              falling water, a way into the rock
//   cloudstep  clouds hanging low enough to jump onto, climbing as stepping
//              stones to one big enough to stand around on
//   needle     one lone skyneedle, out on its own where it can be seen
//   rising     a still pond whose water pours UP out of it into the sky, a
//              column breaking into rain far overhead, stones floating round
//              it as if gravity gave up there
//
// Pure math, like biomes.js - where each one is, and how it changes the
// ground. features.js builds them.
//
// GOING UNDERGROUND. The host's physics (and this package's own grid) know
// the ground only as a heightfield - one height per grid vertex, no holes, no
// overhangs. So a well cannot be a hole in the ground. Instead the vertex
// under it is pushed far down, which makes a funnel in the heightfield, and
// a LID - a flat patch drawn with the terrain's own material, with colliders
// - covers that funnel at ground level, leaving open only the well mouth.
// Underneath, the shaft has its own floor and walls, all clear of the funnel.
// From above it is unbroken ground with a hole in it, which is exactly what it
// is meant to look like. (The grotto used to go under too. It stands on the
// ground now, its cave inside the rock - see grotto.js.)
//
// For the lid to line up with the drawn ground, the funnel's vertex has to be
// a vertex of the host's actual grid, so these sites snap to it - see
// setSiteGridStep, called by createInfiniteTerrain.

import { hash, smooth, lerp } from './noise'
import { SPAWN_X, SPAWN_Z, WATER_LEVEL, roadDistance } from './layout'
import { riverCenterX } from './river'
import { overlapsKeepClear, keepClearVersion } from './keepclear'
import { biomeWeightsAt, dominantBiome, emberPlateAt } from './biomes'

const SEED = 9137

export const SITE_CELL = 420
const TRIES = 10

// The void line. A host that rescues players who fall out of the world (the
// vessel client teleports anyone below y -50 back to spawn) must never see a
// well bottom or cave floor down there, so nothing is dug below this.
export const DEEPEST_FLOOR = -44

let gridStep = 16
let stepVersion = 0
/** The real terrain grid spacing - pits have to sit on its vertices. */
export function setSiteGridStep(step) {
  if (Math.abs(step - gridStep) > 1e-9) {
    gridStep = step
    stepVersion++
    siteCache.clear()
  }
}
export function siteGridStep() { return gridStep }

// what each kind needs, in world units
//   flat    radius flattened to the site's ground height
//   blend   further run over which the land eases back to what it was
//   foot    radius kept clear of trees, grass, other props and other sites
//   relief  how uneven the ground may be across `foot` before flattening
export const SITE_KINDS = {
  well:      { flat: 2.85, blend: 34, foot: 46, relief: 9 },
  grotto:    { flat: 1.45, blend: 38, foot: 64, relief: 9 },
  falls:     { flat: 44,  blend: 34, foot: 72, relief: 12 },
  cloudstep: { flat: 30,  blend: 26, foot: 44, relief: 10 },
  needle:    { flat: 0,   blend: 0,  foot: 8,  relief: 99 },
  rising:    { flat: 20,  blend: 26, foot: 34, relief: 9 },
}
// well and grotto flatten in grid CELLS, the rest in units. The well's lid is
// whole cells - two each way, so the flat has to reach 2 x sqrt(2) cells out
// to level the lid's corners. The grotto's flat is not round: it is the
// rectangle its crag stands on (site.rect), and `flat` the margin beyond it -
// a cell and a half, so every grid triangle touching the cave floor inside is
// level (a triangle reaches sqrt(2) cells from any point in it)
const FLAT_IN_CELLS = { well: true, grotto: true }

// which kinds show up in which land, as weights
const KIND_BY_BIOME = {
  native:      { well: 28, grotto: 20, falls: 24, cloudstep: 13, needle: 5, rising: 10 },
  emberfrost:  { grotto: 42, well: 23, falls: 18, cloudstep: 9, rising: 8 },
  thornvine:   { falls: 30, well: 30, grotto: 20, cloudstep: 8, rising: 12 },
  cloudmeadow: { cloudstep: 62, falls: 12, well: 12, rising: 14 },
  crystal:     { grotto: 48, well: 20, falls: 16, rising: 16 },
  skyneedle:   { well: 30, grotto: 30, falls: 28, rising: 12 },
}
// share of cells that hold a place at all
const CELL_CHANCE = 0.62
// Near spawn - the first stretch of wilds anyone walks out into - every cell
// tries for a place, and the kinds go round in turn rather than by the
// land's own odds, so the first few minutes out show one of each instead of
// whatever the dice gave. Further out it is the land that decides.
const INNER_R = 1750
const INNER_ROTATION = ['falls', 'well', 'grotto', 'cloudstep', 'rising', 'grotto', 'well', 'needle']

// Depths, in units
export const WELL = {
  pitDepth: 60,      // how far the vertices under the well are pushed down
  // the inside of the shaft, half its length and half its width. Its walls
  // (a unit thick) have to stand in the pits' flat bottom, one grid cell
  // each way - which the default 16-unit grid leaves plenty of room for
  halfX: 7,
  halfZ: 5,
  rimW: 0.75,        // the stone coping round the mouth
  rimH: 0.62,        // rim height - a jump clears it (the vessel jump is ~1.27)
  stairW: 1.8,       // the plank flights up the walls
  maxDepth: 30,
}
export const GROTTO = {
  halfX: 34,         // the crag's half-length along its face
  halfZ: 26,         // and its half-depth
  wall: 3,           // how thick its outer walls are - the cave inside is 62 x 46
  roofY: 11,         // the cave's ceiling, over its floor
}
export const FALLS = {
  halfW: 26,         // cliff massif half-width along its face
  halfD: 19,         // and half-depth behind the face
  poolR: 15,
  poolDepth: 3.6,
  ledge: 2.6,        // dry walk between the cliff foot and the pool, behind the water
}

// ── pre-site ground ──────────────────────────────────────────────────────────
// world.js hands over the land as it is before any site touches it - sites
// never read terrainHeight itself, which would be asking a function for the
// answer it is in the middle of computing
let groundBeforeSites = null
export function setGroundSource(fn) { groundBeforeSites = fn }
// and the emberfrost lava level (world.js's lavaLevelAt), handed over the
// same way - a site flattened in a lava field has to end up above the lava
let lavaLevel = null
export function setLavaSource(fn) { lavaLevel = fn }

// ── generation ─────────────────────────────────────────────────────────────
const siteCache = new Map()
let cacheKeyVersion = -1

function pickKind(biome, roll) {
  const table = KIND_BY_BIOME[biome] ?? KIND_BY_BIOME.native
  const total = Object.values(table).reduce((a, b) => a + b, 0)
  let r = roll * total
  for (const [k, w] of Object.entries(table)) { r -= w; if (r < 0) return k }
  return Object.keys(table)[0]
}

function snap(v) { return Math.round(v / gridStep) * gridStep }

function flatRadius(kind) {
  const spec = SITE_KINDS[kind]
  return FLAT_IN_CELLS[kind] ? spec.flat * gridStep : spec.flat
}

function siteIsClear(kind, x, z) {
  const spec = SITE_KINDS[kind]
  const R = spec.foot
  if (Math.hypot(x - SPAWN_X, z - SPAWN_Z) < 560 + R) return false
  if (roadDistance(x, z) < 120 + R) return false
  if (Math.abs(x - riverCenterX(z)) < 130 + R) return false
  if (overlapsKeepClear(x, z, R + spec.blend)) return false
  return true
}

function buildSite(kind, x, z, ix, iz, attempt) {
  const spec = SITE_KINDS[kind]
  const H0 = groundBeforeSites(x, z)
  if (H0 < WATER_LEVEL + 4) return null
  // the ground must be roughly level already - flattening a hillside into a
  // terrace would show
  let lo = H0, hi = H0
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    for (const k of [0.5, 1]) {
      const h = groundBeforeSites(x + Math.cos(a) * spec.foot * k, z + Math.sin(a) * spec.foot * k)
      lo = Math.min(lo, h); hi = Math.max(hi, h)
    }
  }
  if (hi - lo > spec.relief) return null
  if (lo < WATER_LEVEL + 2) return null

  const seed = hash(ix * 7 + attempt, iz * 13 + attempt, SEED + 5)
  const yaw = hash(ix, iz + attempt, SEED + 6) * Math.PI * 2
  // the flattened level: the middle of what is there, so as much cut as fill
  let H = (lo + hi) * 0.5 * 0.5 + H0 * 0.5
  // in a lava field, never below the lava - the flattened ground would
  // flood. Raised instead, it stands as a basalt mesa over the fissures
  if (lavaLevel) {
    let top = -Infinity
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      for (const k of [0, 0.6, 1.1]) {
        const px = x + Math.cos(a) * spec.foot * k, pz = z + Math.sin(a) * spec.foot * k
        // only where lava is actually drawn (lava.js fades it in from 0.25)
        if (biomeWeightsAt(px, pz).emberfrost > 0.25) top = Math.max(top, lavaLevel(px, pz))
      }
    }
    if (top > -Infinity) {
      // a few units of mesa reads as basalt standing proud of the fissures;
      // twenty reads as a pillar - a site that would need that is no site
      if (top + 1.4 - H > 3) return null
      H = Math.max(H, top + 1.4)
    }
  }
  const site = {
    kind, x, z, H, yaw, seed,
    key: `${kind}_${ix}_${iz}`,
    flatR: flatRadius(kind),
    blendR: spec.blend,
    // how far from its centre it can change the ground at all
    reach: flatRadius(kind) + spec.blend,
    foot: spec.foot,
    pits: [],
    lid: null,
  }

  if (kind === 'well') {
    const depth = Math.min(WELL.maxDepth, H - DEEPEST_FLOOR)
    if (depth < 18) return null
    site.depth = depth
    // the shaft is wider than one cell, so - as under the grotto - the nine
    // grid vertices round it go down, and the lid runs two cells each way
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        site.pits.push({ x: x + i * gridStep, z: z + j * gridStep, depth: WELL.pitDepth })
    const half = 2 * gridStep
    site.lid = { x0: x - half, z0: z - half, x1: x + half, z1: z + half, H }
    // which way round it stands, in quarter turns
    site.turn = Math.floor(yaw / (Math.PI / 2)) % 4
  } else if (kind === 'grotto') {
    // squared to the world's axes - its face looks one of four ways - so the
    // flattened ground under it is a plain rectangle
    site.turn = Math.floor(yaw / (Math.PI / 2)) % 4
    const across = site.turn % 2 === 1
    site.rect = { hx: across ? GROTTO.halfZ : GROTTO.halfX, hz: across ? GROTTO.halfX : GROTTO.halfZ }
    site.reach += Math.hypot(site.rect.hx, site.rect.hz)
    site.height = 19 + hash(ix, iz, SEED + 12) * 6
  } else if (kind === 'falls') {
    // the cliff stands behind the site centre, its face toward `yaw`, the
    // pool in front of it
    const dx = Math.sin(yaw), dz = Math.cos(yaw)
    const back = FALLS.halfD + 0.5 * (FALLS.ledge + FALLS.poolR)
    site.massif = { x: x - dx * back, z: z - dz * back }
    const poolDist = FALLS.halfD + FALLS.ledge + FALLS.poolR
    site.pool = {
      x: site.massif.x + dx * poolDist,
      z: site.massif.z + dz * poolDist,
      r: FALLS.poolR,
      level: H - 0.75,
      depth: FALLS.poolDepth,
    }
    site.height = 19 + hash(ix, iz, SEED + 8) * 9
  } else if (kind === 'cloudstep') {
    site.height = 7 + hash(ix, iz, SEED + 9) * 5
  } else if (kind === 'needle') {
    site.height = 300 + hash(ix, iz, SEED + 10) * 160
  } else if (kind === 'rising') {
    site.pool = { x, z, r: 9, level: H - 0.6, depth: 2.2 }
    site.height = 45 + hash(ix, iz, SEED + 11) * 30
  }
  return site
}

function cellSites(ix, iz) {
  const v = stepVersion * 1000 + keepClearVersion()
  if (v !== cacheKeyVersion) { siteCache.clear(); cacheKeyVersion = v }
  const key = ix * 100003 + iz
  const hit = siteCache.get(key)
  if (hit) return hit

  const sites = []
  const mx0 = (ix + 0.5) * SITE_CELL, mz0 = (iz + 0.5) * SITE_CELL
  const inner = Math.hypot(mx0 - SPAWN_X, mz0 - SPAWN_Z) < INNER_R
  if (groundBeforeSites && (inner || hash(ix, iz, SEED + 1) < CELL_CHANCE)) {
    // the kind is drawn once per cell, from the land at its middle, and then
    // several spots are tried for it. Drawing per attempt instead let a kind
    // that always fits (a needle wants almost nothing) win every cell where a
    // fussier one (a well wants level ground) failed its first spot
    // near spawn a kind that cannot fit here (a waterfall needs a lot of
    // level ground) hands the cell on to the next in the rotation
    const kinds = []
    if (inner) {
      const n = INNER_ROTATION.length
      const k0 = ((ix * 3 + iz * 5) % n + n) % n
      // a lone needle fits almost anywhere, so it is never the fallback -
      // it would end up standing in every cell nothing else suited
      for (let i = 0; i < n; i++) {
        const k = INNER_ROTATION[(k0 + i) % n]
        if (!kinds.includes(k) && (i === 0 || k !== 'needle')) kinds.push(k)
      }
    } else {
      kinds.push(pickKind(dominantBiome(biomeWeightsAt(mx0, mz0), 0.45), hash(ix, iz, SEED + 4)))
    }
    for (const kind of kinds) for (let attempt = 0; attempt < TRIES && !sites.length; attempt++) {
      const fx = 0.18 + hash(ix + attempt * 31, iz, SEED + 2) * 0.64
      const fz = 0.18 + hash(ix, iz + attempt * 37, SEED + 3) * 0.64
      let x = (ix + fx) * SITE_CELL
      let z = (iz + fz) * SITE_CELL
      const w = biomeWeightsAt(x, z)
      if (FLAT_IN_CELLS[kind]) { x = snap(x); z = snap(z) }
      if (!siteIsClear(kind, x, z)) continue
      if ((kind === 'well' || kind === 'grotto') && w.emberfrost > 0.3 && emberPlateAt(x, z) < 0.85) continue
      const site = buildSite(kind, x, z, ix, iz, attempt)
      if (site) sites.push(site)
    }
  }
  if (siteCache.size > 6000) siteCache.delete(siteCache.keys().next().value)
  siteCache.set(key, sites)
  return sites
}

// every site whose influence could reach this point. A site's reach (a
// grotto's, the largest, is about 100) is well under one cell, so the 3x3
// cells around are enough
function sitesAround(x, z) {
  const ix = Math.floor(x / SITE_CELL), iz = Math.floor(z / SITE_CELL)
  const out = []
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const list = cellSites(ix + dx, iz + dz)
      for (const s of list) out.push(s)
    }
  return out
}

// ── what sites do to the ground ─────────────────────────────────────────────
const PIT_EPS = 1e-3

/** Apply every site's flattening, pits and pools to a height at this point. */
export function applySites(x, z, h) {
  const ix = Math.floor(x / SITE_CELL), iz = Math.floor(z / SITE_CELL)
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const list = cellSites(ix + dx, iz + dz)
      for (let i = 0; i < list.length; i++) h = carveSite(list[i], x, z, h)
    }
  return h
}

function carveSite(s, x, z, h) {
  const d = Math.hypot(x - s.x, z - s.z)
  if (d >= s.reach) return h
  // a pit vertex - only ever hit exactly, by the terrain grid itself
  for (const p of s.pits) {
    if (Math.abs(x - p.x) < PIT_EPS && Math.abs(z - p.z) < PIT_EPS) return s.H - p.depth
  }
  if (s.flatR > 0) {
    // how far out from what is flattened whole: the centre, or the rectangle
    // a grotto's crag stands on
    const out = s.rect
      ? Math.hypot(Math.max(0, Math.abs(x - s.x) - s.rect.hx), Math.max(0, Math.abs(z - s.z) - s.rect.hz))
      : d
    const t = out <= s.flatR ? 0 : smooth((out - s.flatR) / s.blendR)
    h = lerp(s.H, h, t)
  }
  if (s.pool) {
    const pd = Math.hypot(x - s.pool.x, z - s.pool.z)
    const r = s.pool.r
    if (pd < r + 6) {
      // a bowl: floor at level - depth, rising to the waterline at r, a
      // short shore beyond it back up to the flattened ground
      const floor = s.pool.level - s.pool.depth
      const bowl = pd < r
        ? floor + (s.pool.level + 0.15 - floor) * smooth(pd / r) ** 0.7
        : lerp(s.pool.level + 0.15, s.H, smooth((pd - r) / 6))
      h = Math.min(h, bowl)
    }
  }
  return h
}

/**
 * Ground height a lid puts at this point, or null when no lid covers it. The
 * lid hides a site's pit, so this is the surface anything walking or standing
 * here should be on - see sampleTerrainSurfaceHeight.
 */
export function lidHeightAt(x, z) {
  const ix = Math.floor(x / SITE_CELL), iz = Math.floor(z / SITE_CELL)
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      for (const s of cellSites(ix + dx, iz + dz)) {
        const L = s.lid
        if (L && x >= L.x0 && x <= L.x1 && z >= L.z0 && z <= L.z1) return L.H
      }
    }
  return null
}

/** True when this point is inside a site's footprint (plus `margin`). */
export function inSiteFootprint(x, z, margin = 0) {
  const ix = Math.floor(x / SITE_CELL), iz = Math.floor(z / SITE_CELL)
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      for (const s of cellSites(ix + dx, iz + dz)) {
        if (Math.hypot(x - s.x, z - s.z) < s.foot + margin) return true
      }
    }
  return false
}

/**
 * The grotto whose cave this point is in - in its maze, under its roof, not
 * up on top of the crag - or null. y is the point's height (a character's
 * middle will do). `margin` reaches that far into the crag's walls, which
 * only the passage in through the front opening lets anyone do - so a host
 * can switch over partway along it, and use a larger margin to switch back
 * than to switch in, so standing in the passage never flickers.
 */
export function grottoInteriorAt(x, y, z, margin = 0) {
  const ix = Math.floor(x / SITE_CELL), iz = Math.floor(z / SITE_CELL)
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      for (const s of cellSites(ix + dx, iz + dz)) {
        if (s.kind !== 'grotto') continue
        const hx = s.rect.hx - GROTTO.wall + margin, hz = s.rect.hz - GROTTO.wall + margin
        if (Math.abs(x - s.x) < hx && Math.abs(z - s.z) < hz && y > s.H - 2 && y < s.H + GROTTO.roofY) return s
      }
    }
  return null
}

/** Every site whose centre falls inside this terrain chunk. */
export function sitesInChunk(ox, oz, size) {
  const out = []
  const ix0 = Math.floor(ox / SITE_CELL), ix1 = Math.floor((ox + size - 1e-6) / SITE_CELL)
  const iz0 = Math.floor(oz / SITE_CELL), iz1 = Math.floor((oz + size - 1e-6) / SITE_CELL)
  for (let iz = iz0; iz <= iz1; iz++)
    for (let ix = ix0; ix <= ix1; ix++)
      for (const s of cellSites(ix, iz))
        if (s.x >= ox && s.x < ox + size && s.z >= oz && s.z < oz + size) out.push(s)
  return out
}

/** Every site within `radius` of a point, nearest first - for a host's map or a debug list. */
export function listSites(x, z, radius) {
  const out = []
  const ix0 = Math.floor((x - radius) / SITE_CELL), ix1 = Math.floor((x + radius) / SITE_CELL)
  const iz0 = Math.floor((z - radius) / SITE_CELL), iz1 = Math.floor((z + radius) / SITE_CELL)
  for (let iz = iz0; iz <= iz1; iz++)
    for (let ix = ix0; ix <= ix1; ix++)
      for (const s of cellSites(ix, iz)) {
        const d = Math.hypot(s.x - x, s.z - z)
        if (d <= radius) out.push({ kind: s.kind, x: s.x, z: s.z, y: s.H, distance: d, key: s.key })
      }
  return out.sort((a, b) => a.distance - b.distance)
}

export function siteByKey(key) {
  const [kind, ix, iz] = key.split('_')
  return cellSites(Number(ix), Number(iz)).find(s => s.key === key) ?? null
}

export { sitesAround }
