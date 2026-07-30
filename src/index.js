import { runPreloads } from './preload'
import { createInfiniteTerrain } from './terrain'
import { createWater } from './water'
import { createForest } from './forest'
import { createStatsUI } from './statsUI'

// ── Convenience wrapper ───────────────────────────────────────────────────
// Call this once after your scene is created.
// Make sure your scene has fogMode, fogColor, fogStart, fogEnd set before calling,
// otherwise the terrain shader will default to no fog.
export async function createOpenWorld(scene, options = {}) {
  const { showStatsUI = false, verts = 17 } = options
  console.log('[infterrain] createOpenWorld: start', options)

  console.log('[infterrain] runPreloads: start')
  try {
    await runPreloads(scene)
    console.log('[infterrain] runPreloads: done')
  } catch (err) {
    console.error('[infterrain] runPreloads: FAILED', err)
    throw err
  }

  console.log('[infterrain] createInfiniteTerrain: start')
  let chunks, mat
  try {
    ;({ chunks, mat } = createInfiniteTerrain(scene, options))
    console.log('[infterrain] createInfiniteTerrain: done', { chunkCount: chunks?.length })
  } catch (err) {
    console.error('[infterrain] createInfiniteTerrain: FAILED', err)
    throw err
  }

  console.log('[infterrain] createWater: start')
  try {
    createWater(scene)
    console.log('[infterrain] createWater: done')
  } catch (err) {
    console.error('[infterrain] createWater: FAILED', err)
    throw err
  }

  console.log('[infterrain] createForest: start')
  try {
    await createForest(scene)
    console.log('[infterrain] createForest: done')
  } catch (err) {
    console.error('[infterrain] createForest: FAILED', err)
    throw err
  }

  if (showStatsUI) {
    console.log('[infterrain] createStatsUI: start')
    try {
      createStatsUI(scene.getEngine(), scene, chunks, verts)
      console.log('[infterrain] createStatsUI: done')
    } catch (err) {
      console.error('[infterrain] createStatsUI: FAILED', err)
      throw err
    }
  }

  console.log('[infterrain] createOpenWorld: done')
  return { chunks, mat }
}

// ── Individual exports (for custom setups) ────────────────────────────────
export { runPreloads }          from './preload'
export { createInfiniteTerrain } from './terrain'
export { createWater }           from './water'
export { createForest }          from './forest'
export {
  terrainHeight,
  backgroundTerrainHeight,
  roadDistance,
  getMountainFactor,
  SPAWN_X,
  SPAWN_Z,
  WATER_LEVEL,
} from './world'
