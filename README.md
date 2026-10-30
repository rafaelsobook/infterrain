# infterrain

Procedural, infinitely-streaming terrain for [Babylon.js](https://www.babylonjs.com/) — chunked heightmap terrain with triplanar splat-mapped materials (grass/road/rock/snow), a fogged water plane, a meandering river that changes character every 100 units, scattered mountain/volcano/hill landmarks, and billboard/mesh forest scattering. Chunks build and dispose automatically as the camera moves.

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
  createOpenWorldGrass, createMountainsInOpenWorld,
  runPreloads,
  terrainHeight, backgroundTerrainHeight, roadDistance, getMountainFactor,
  SPAWN_X, SPAWN_Z, WATER_LEVEL,
} from 'infterrain'
```

- **`createInfiniteTerrain(scene, options)`** — just the streaming terrain mesh/material (same `options` as above minus tree/water/forest concerns).
- **`sampleTerrainSurfaceHeight(x, z, verts)`** — height of the rendered terrain surface at a world position, matching the mesh's own bilinear interpolation (use this instead of raw `terrainHeight` when you need a position flush with what's drawn, e.g. spawning something on the surface).
- **`createWater(scene)`** — the fogged water plane at `WATER_LEVEL`.
- **`createForest(scene, treePaths, fakeTreePath, verts)`** / **`createOpenWorldGrass(...)`** — vegetation scattering.
- **`createMountainsInOpenWorld(scene, counts, types, options)`** — mountain/volcano/hill landmark meshes, see above.
- **`terrainHeight(x, z)`** / **`backgroundTerrainHeight(x, z, hillSize)`** — raw procedural height sampling.
- **`roadDistance(x, z)`**, **`getMountainFactor(x, z)`** — world-shape queries used for splat/vegetation placement, useful if you're placing your own objects.
- **`SPAWN_X`**, **`SPAWN_Z`**, **`WATER_LEVEL`** — world constants.

## Mountains, volcanoes and hills

`createMountainsInOpenWorld` scatters landmark **meshes** over the world, streamed per chunk the same way `createOpenWorldGrass` streams its cards. It is separate from `createOpenWorld` and does **not** build or alter terrain — these stand on whatever ground is already there, so adding or removing them never changes a height query anywhere in your game.

```js
await createMountainsInOpenWorld(scene,
  { mountainPerChunk: 2, volcanoPerChunk: 2, hillsPerChunk: 10 },
  [
    { mountaintexturePath: './images/textures/rock/rock1.jpg', qnty: 10, size: 'small'  },
    { volcanotexturePath:  './images/textures/rock/black.jpg', qnty: 10, size: 'medium' },
    { hillstexturePath:    './images/textures/grass/bush1.jpg', qnty: 10, size: 'large' },
  ],
  { viewRadius: 1, verts: OPENWORLD_TERRAIN_VERTS })
```

- **counts** — how many of each kind land in every loaded 256×256 chunk. Not a world total; the world streams infinitely, so there is no total.
- **types** — the texture key is what declares the kind. `size` is `"small" | "medium" | "large"`. `qnty` is a relative **weight**, used only to choose between several entries of the same kind — how many are placed is the counts argument's job, so the two numbers can never contradict each other. Optional per-entry `snow` and `glow` (0–1) override the defaults, which are snow on mountain tops and lava in volcano craters.
- **options** — `viewRadius`, `unloadRadius`, and `verts`, which must match what you passed to `createOpenWorld()`/`createInfiniteTerrain()` or landmarks ground against a surface that isn't the one being drawn.

Returns `{ chunks, pools, dispose }`.

Each kind is a radial mesh built from its own silhouette profile plus circular ridge noise — a mountain is a ridged peak, a volcano is a broader cone with a real crater that glows, a hill is a smooth dome. Three distinct masters are built per entry and instanced, so a field of ten hills is ten silhouettes rather than one repeated, at one draw call per entry rather than one per hill. They're lit by the host scene's own lights through the same `syncTerrainLighting` the ground uses, so they never look lit by a different sun.

Placement avoids roads, the river, water, cliffs too steep to sit on, and the spawn hub, and each footprint stays inside its own chunk so neighbours can't collide. Sites are chosen by hash, so a chunk streaming out and back in rebuilds identically.

One thing to know: a 256-unit chunk has finite room. Ten `large` hills is ten 96-unit footprints, which simply will not fit — they'll pack tighter and overlap (which reads fine, like a ridge), and past a point you'll get fewer than you asked for. Rather than under-delivering silently, it measures the average over the first 16 chunks and logs one `[infterrain]` warning telling you what was asked, what fitted, and the sizes involved.

## The river

A single river runs along Z and meanders in X, infinite in both directions because every part of it is a pure function of position — there is nothing to stream or store. It is carved into `terrainHeight` itself, so anything already sampling the terrain (your own object placement, physics, the forest) sees the channel for free.

Its character is drawn fresh **every 100 units** from seven variants — `calm`, `wide`, `narrow`, `rapids`, `gorge`, `shallows`, `pool` — each with its own width, depth, bank profile, flow speed, turbulence and bed rockiness. Neighbouring stretches cross-fade rather than switching at a line, so a stretch reads as *widening into shallows* instead of changing width instantly. The water shader reads the same values, so a rapid runs fast and broken with whitewater while a pool sits nearly still, and the terrain splat reads them too, so a gorge gets a boulder bed and a pool gets mud.

Practical behaviour worth knowing:

- The water surface follows the **lowest** untouched ground along the centreline within a window either side, so it descends with the landscape and stays below its own banks.
- Where a road crosses, the river shallows into a wadeable **ford** rather than cutting the road in two — the same mechanism that already punches passes through the ridges.
- It fades out inside the spawn hub and as the mountains take over.
- Channel widths are sized against the terrain's own grid spacing. A carve finer than the mesh can draw is invisible however deep it is, so `createInfiniteTerrain` tells the river its real grid step and the narrow variants are clamped to stay renderable — raise `verts` and you get a proportionally finer river.

```js
import {
  createRiver,
  riverSurfaceY, riverDepthAt, riverCenterX, riverProfileAt,
  inRiverChannel, RIVER_VARIANTS, RIVER_SEGMENT,
} from 'infterrain'
```

- **`createRiver(scene)`** — streams the water surface. `createOpenWorld` already calls it and returns it as `river`; call it yourself only for a custom setup. Returns `{ chunks, mat, dispose }`.
- **`riverSurfaceY(z)`** — height of the water at this Z. Constant across the channel's width.
- **`riverDepthAt(x, z)`** — how deep the water is here, `0` on dry land. One call for "am I in the river, and how far in".
- **`inRiverChannel(x, z, margin?)`** — keep your own scattering out of the water, the way the bundled grass and forest already do.
- **`riverCenterX(z)`** / **`riverProfileAt(z)`** — the path itself, and the blended variant values (including `variantId`) at a point, for placing your own rocks, crossings or fishing spots.

## Logging

infterrain logs sanity-check messages prefixed with `[infterrain]` (texture load status, first chunk built, missing scene fog config, etc.) via `console.log`/`console.warn`/`console.error`, so integration issues are visible without a debugger attached.

## License

ISC
