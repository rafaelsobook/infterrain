import { runPreloads } from './preload'
import { createInfiniteTerrain } from './terrain'
import { createWater } from './water'
import { createRiver } from './rivermesh'
import { createForest, DEFAULT_TREE_PATHS, DEFAULT_FAKE_TREE_PATH } from './forest'
import { createStatsUI } from './statsUI'
import { createWorldFeatures } from './features'
import { setKeepClear } from './keepclear'
import { biomeWeightsAt, dominantBiome, BIOME_INFO } from './biomes'
import { listSites, siteByKey } from './sites'
import { stashSpots } from './builders'

// Progress tracing, OFF by default. These were bring-up diagnostics - useful
// while proving the module works in a new host, pure noise in that host's
// console once it does. Flip to true to get the whole start/done trace back,
// rather than having to hunt for deleted lines.
//
// Deliberately only gates console.log. console.warn and console.error stay
// unconditional throughout this module: those fire only when something is
// actually wrong (a missing texture, no active camera, a failed preload), and
// silencing them would turn a real failure into a blank screen with no
// explanation of why.
const DEBUG = false
const log = (...args) => { if (DEBUG) console.log(...args) }

// ── Convenience wrapper ───────────────────────────────────────────────────
// Call this once after your scene is created.
// Make sure your scene has fogMode, fogColor, fogStart, fogEnd set before calling,
// otherwise the terrain shader will default to no fog.
// treePaths: array of 3 glb paths — [healthyTree, deadTreeVariantA, deadTreeVariantB].
// fakeTreePath: cutout image used for the billboard impostor trees.
// Both default to infterrain's bundled assets if omitted.
export async function createOpenWorld(scene, treePaths = DEFAULT_TREE_PATHS, fakeTreePath = DEFAULT_FAKE_TREE_PATH, options = {}) {
  const { showStatsUI = false, verts = 17, features = true } = options
  log('[infterrain] createOpenWorld: start', { treePaths, fakeTreePath, options })

  // the host's own fixed sites, kept clear of biomes and special places -
  // has to be in place before the first terrain height is ever computed
  if (options.keepClear !== undefined) setKeepClear(options.keepClear)

  log('[infterrain] runPreloads: start')
  try {
    await runPreloads(scene)
    log('[infterrain] runPreloads: done')
  } catch (err) {
    console.error('[infterrain] runPreloads: FAILED', err)
    throw err
  }

  log('[infterrain] createInfiniteTerrain: start')
  let chunks, mat
  try {
    ;({ chunks, mat } = createInfiniteTerrain(scene, options))
    log('[infterrain] createInfiniteTerrain: done', { chunkCount: chunks?.size })
  } catch (err) {
    console.error('[infterrain] createInfiniteTerrain: FAILED', err)
    throw err
  }

  log('[infterrain] createWater: start')
  try {
    createWater(scene, { verts, viewRadius: options.viewRadius ?? 2 })
    log('[infterrain] createWater: done')
  } catch (err) {
    console.error('[infterrain] createWater: FAILED', err)
    throw err
  }

  // the river's own surface, separate from the sea plane above - see
  // rivermesh.js for why the two cannot be the same mesh
  log('[infterrain] createRiver: start')
  let river = null
  try {
    river = createRiver(scene)
    log('[infterrain] createRiver: done')
  } catch (err) {
    console.error('[infterrain] createRiver: FAILED', err)
    throw err
  }

  log('[infterrain] createForest: start')
  try {
    await createForest(scene, treePaths, fakeTreePath, verts)
    log('[infterrain] createForest: done')
  } catch (err) {
    console.error('[infterrain] createForest: FAILED', err)
    throw err
  }

  // the biomes' growth, the lava, and the special places - wells, grottos,
  // waterfalls, cloud stairs, skyneedles (features.js)
  let world = null
  if (features) {
    log('[infterrain] createWorldFeatures: start')
    try {
      world = createWorldFeatures(scene, mat, {
        verts,
        viewRadius: options.viewRadius ?? 2,
        physics: options.physics ?? true,
        cameraPassMask: options.cameraPassMask ?? (1 << 30),
        propTextures: options.propTextures ?? {},
        onFeatureBuilt: options.onFeatureBuilt,
        ambience: options.ambience ?? true,
        scatterDensity: options.scatterDensity ?? {},
      })
      log('[infterrain] createWorldFeatures: done')
    } catch (err) {
      console.error('[infterrain] createWorldFeatures: FAILED', err)
    }
  }

  if (showStatsUI) {
    log('[infterrain] createStatsUI: start')
    try {
      createStatsUI(scene.getEngine(), scene, chunks, verts)
      log('[infterrain] createStatsUI: done')
    } catch (err) {
      console.error('[infterrain] createStatsUI: FAILED', err)
      throw err
    }
  }

  log('[infterrain] createOpenWorld: done')
  return { chunks, mat, river, features: world }
}

/**
 * Plain-words description of where a point is - the biome, and the nearest
 * special place - for a host's HUD, a map, or debugging.
 */
export function describeLocation(x, z) {
  const w = biomeWeightsAt(x, z)
  const lines = [BIOME_INFO[dominantBiome(w)].name]
  const near = listSites(x, z, 400)[0]
  if (near) lines.push(`nearest: ${near.kind} ${near.distance.toFixed(0)}m away`)
  return lines
}

/** Every special place within `radius` of a point, nearest first. */
export function listFeatures(x, z, radius = 1000) {
  return listSites(x, z, radius)
}

/**
 * Where to leave things in one of the hidden places - a well, a grotto, the
 * cave behind a falls - by its key (listSites gives the keys): open floor its
 * builder keeps props off, [{ name: 'chest' | 'weapon' | 'patch', x, y, z }],
 * y being that floor - and in a grotto's maze ore spots as well, 'ore0' to
 * 'ore4'. [] for any other kind of place. Pure, like listSites -
 * a game server with no scene can lay out loot with it.
 */
export function siteStashSpots(key) {
  const site = siteByKey(key)
  return site ? stashSpots(site) : []
}

// ── Individual exports (for custom setups) ────────────────────────────────
export { runPreloads }          from './preload'
export { createInfiniteTerrain, sampleTerrainSurfaceHeight } from './terrain'
export { createWater }           from './water'
export { createRiver }           from './rivermesh'
export { createForest, DEFAULT_TREE_PATHS, DEFAULT_FAKE_TREE_PATH } from './forest'
export { createOpenWorldGrass } from './grass'
export { createMountainsInOpenWorld } from './mountains'
export { createWorldFeatures } from './features'
export { createCrystalNode } from './crystalnode'
export {
  biomeWeightsAt, dominantBiome, biomeName, wildness, foliageSuppression,
  BIOME_KINDS, BIOME_INFO, BIOME_CELL,
} from './biomes'
export { listSites, lidHeightAt, inSiteFootprint, grottoInteriorAt, SITE_KINDS } from './sites'
export { DEFAULT_KEEP_CLEAR, setKeepClear } from './keepclear'
// the road network itself - each road a polyline of {x, z} centreline points
// out from the spawn - and walking it: the nearest road to a point (which one,
// how far along, how far off) and the point a distance along one. For a host
// that sends something down a road (a wagon) or sets things beside one.
export { ROADS, nearestRoad, roadPointAt } from './layout'
export {
  terrainHeight,
  surfaceHeight,
  lavaLevelAt,
  backgroundTerrainHeight,
  roadDistance,
  getMountainFactor,
  SPAWN_X,
  SPAWN_Z,
  WATER_LEVEL,
  // ── river ──
  // riverSurfaceY(z) is the one a host is most likely to want: the height of
  // the water at a given Z, e.g. to float something on it or to test whether
  // a character is submerged. riverDepthAt(x, z) answers "am I in the water
  // and how deep" in one call.
  riverSurfaceY,
  riverStrength,
  riverDepthAt,
  riverSplatAt,
  riverRockAt,
  inRiverChannel,
} from './world'
export {
  riverCenterX,
  riverProfileAt,
  riverOffset,
  riverAt,
  isInRiver,
  variantForSegment,
  RIVER_SEGMENT,
  RIVER_VARIANTS,
  RIVER_BASE_X,
} from './river'
