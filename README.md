# infterrain

Procedural, infinitely-streaming terrain for [Babylon.js](https://www.babylonjs.com/) — chunked heightmap terrain with triplanar splat-mapped materials (grass/road/rock/snow), a fogged water plane, and billboard/mesh forest scattering. Chunks build and dispose automatically as the camera moves.

## Install

```
npm install infterrain
```

### Peer dependencies

This package does not bundle Babylon.js — it expects your project to already have it installed:

```
npm install @babylonjs/core @babylonjs/loaders
```

Requires `@babylonjs/core` and `@babylonjs/loaders` version `>=9.0.0`.

## Quick start

```js
import { Scene, Color3 } from '@babylonjs/core'
import { createOpenWorld } from 'infterrain'

const scene = new Scene(engine)

// infterrain's terrain and water shaders read the scene's fog settings.
// Set these before calling createOpenWorld, or they'll fall back to defaults.
scene.fogMode  = Scene.FOGMODE_LINEAR
scene.fogColor = new Color3(0.65, 0.78, 0.88)
scene.fogStart = 400
scene.fogEnd   = 1400

const { chunks, mat } = await createOpenWorld(scene)
```

`createOpenWorld` sets up terrain, water, and forest scattering together, and starts streaming chunks in around the world's spawn point (`SPAWN_X`, `SPAWN_Z`). Call it once, after your scene exists.

### `createOpenWorld(scene, treePaths?, fakeTreePath?, options?)`

| Param | Type | Default | Description |
|---|---|---|---|
| `scene` | `Scene` | — | Your Babylon.js scene. |
| `treePaths` | `string[3]` | `DEFAULT_TREE_PATHS` | `[healthyTree, deadTreeVariantA, deadTreeVariantB]` glb paths. |
| `fakeTreePath` | `string` | `DEFAULT_FAKE_TREE_PATH` | Cutout image used for billboard impostor trees. |
| `options.showStatsUI` | `boolean` | `false` | Overlay showing chunk/build stats. |
| `options.verts` | `number` | `17` | Vertices per chunk edge (mesh resolution). |
| `options.viewRadius` | `number` | `2` | Chunk radius kept built around the camera. |
| `options.unloadRadius` | `number` | `viewRadius + 2` | Chunk radius before a chunk is disposed. |
| `options.onChunkBuilt` | `(mesh) => void` | — | Called after each terrain chunk mesh is built (e.g. to attach physics). |
| `options.onChunkDisposed` | `(mesh) => void` | — | Called just before a chunk mesh is disposed. |

Returns `{ chunks, mat }` — `chunks` is the live `Map` of currently-built chunk meshes, `mat` is the shared terrain `ShaderMaterial`.

## Individual exports

For custom setups you don't have to use `createOpenWorld` — the pieces are exported separately:

```js
import {
  createInfiniteTerrain, sampleTerrainSurfaceHeight,
  createWater,
  createForest, DEFAULT_TREE_PATHS, DEFAULT_FAKE_TREE_PATH,
  createOpenWorldGrass,
  runPreloads,
  terrainHeight, backgroundTerrainHeight, roadDistance, getMountainFactor,
  SPAWN_X, SPAWN_Z, WATER_LEVEL,
} from 'infterrain'
```

- **`createInfiniteTerrain(scene, options)`** — just the streaming terrain mesh/material (same `options` as above minus tree/water/forest concerns).
- **`sampleTerrainSurfaceHeight(x, z, verts)`** — height of the rendered terrain surface at a world position, matching the mesh's own bilinear interpolation (use this instead of raw `terrainHeight` when you need a position flush with what's drawn, e.g. spawning something on the surface).
- **`createWater(scene)`** — the fogged water plane at `WATER_LEVEL`.
- **`createForest(scene, treePaths, fakeTreePath, verts)`** / **`createOpenWorldGrass(...)`** — vegetation scattering.
- **`terrainHeight(x, z)`** / **`backgroundTerrainHeight(x, z, hillSize)`** — raw procedural height sampling.
- **`roadDistance(x, z)`**, **`getMountainFactor(x, z)`** — world-shape queries used for splat/vegetation placement, useful if you're placing your own objects.
- **`SPAWN_X`**, **`SPAWN_Z`**, **`WATER_LEVEL`** — world constants.

## Logging

infterrain logs sanity-check messages prefixed with `[infterrain]` (texture load status, first chunk built, missing scene fog config, etc.) via `console.log`/`console.warn`/`console.error`, so integration issues are visible without a debugger attached.

## License

ISC
