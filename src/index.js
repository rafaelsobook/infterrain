import { runPreloads } from './preload'
import { createInfiniteTerrain } from './terrain'
import { createWater } from './water'
import { createForest, DEFAULT_TREE_PATHS, DEFAULT_FAKE_TREE_PATH } from './forest'
import { createStatsUI } from './statsUI'

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
  const { showStatsUI = false, verts = 17 } = options
  log('[infterrain] createOpenWorld: start', { treePaths, fakeTreePath, options })

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
    createWater(scene)
    log('[infterrain] createWater: done')
  } catch (err) {
    console.error('[infterrain] createWater: FAILED', err)
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
  return { chunks, mat }
}

// ── Individual exports (for custom setups) ────────────────────────────────
export { runPreloads }          from './preload'
export { createInfiniteTerrain, sampleTerrainSurfaceHeight } from './terrain'
export { createWater }           from './water'
export { createForest, DEFAULT_TREE_PATHS, DEFAULT_FAKE_TREE_PATH } from './forest'
export { createOpenWorldGrass } from './grass'
export {
  terrainHeight,
  backgroundTerrainHeight,
  roadDistance,
  getMountainFactor,
  SPAWN_X,
  SPAWN_Z,
  WATER_LEVEL,
} from './world'
