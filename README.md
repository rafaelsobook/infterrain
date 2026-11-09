# infterrain

Procedural, infinitely-streaming terrain for [Babylon.js](https://www.babylonjs.com/) — chunked heightmap terrain with triplanar splat-mapped materials (grass/road/rock/snow), soft-shored lakes, a meandering river that changes character every 100 units, strange **biomes** out in the wilds (lava fields with trees of ice, giant cacti under arching thornvines, glowing crystal hollows, groves of trees thinner than your arm that rise out of sight, meadows of low clouds), **special places** (deep wells with plank stairs spiralling out, horned skull-faced crags with a maze inside and a treasure walled away in it, waterfalls with a cave behind the water and a creek running off downhill, a pond pouring its water up into the sky, cloud stairs to a sky island), scattered mountain/volcano/hill landmarks, and billboard/mesh forest scattering. Chunks build and dispose automatically as the camera moves.

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
| `options.features` | `boolean` | `true` | Biome props, lava and the special places (see [Biomes](#biomes) and [Special places](#special-places)). |
| `options.physics` | `boolean` | `true` | Static box colliders for the features, when the scene runs Babylon's v2 physics (Havok). Ignored without a physics engine. |
| `options.cameraPassMask` | `number` | `1 << 30` | Collision-filter membership bit put on colliders a follow camera should see through (clouds, stair rails, thin trunks). |
| `options.keepClear` | `{x, z, r}[]` | vessel sites | Circles nothing new may touch - see [Keeping a host's places clear](#keeping-a-hosts-places-clear). |
| `options.propTextures` | `object` | procedural | Image paths to use instead of the built-in grain: `{ stone, rock, wood, bark, ice, cactus, cloud }`. |
| `options.onFeatureBuilt` | `(info) => void` | — | Called as each special place streams in: `{ kind, key, x, y, z, spots }`. |
| `options.scatterDensity` | `object` | `{}` | Multiplier per growth kind, e.g. `{ crystal: 0.5, cactus: 0 }`; 0 leaves that kind out. Kinds: icewood, obsidian, cactus, thornvine, sandstone, crystal, palestone, skyneedle, glowcap, puffball, cloudlet. |
| `options.ambience` | `boolean` | `true` | Particles in the air of each biome (embers and snow, glints, fireflies, seed-fluff, blowing sand). |

Returns `{ chunks, mat, river, features }` — `chunks` is the live `Map` of currently-built chunk meshes, `mat` is the shared terrain `ShaderMaterial`, `river` and `features` the streaming handles (each with `dispose()`).

## Individual exports

For custom setups you don't have to use `createOpenWorld` — the pieces are exported separately:

```js
import {
  createInfiniteTerrain, sampleTerrainSurfaceHeight,
  createWater,
  createForest, DEFAULT_TREE_PATHS, DEFAULT_FAKE_TREE_PATH,
  createOpenWorldGrass, createMountainsInOpenWorld,
  createWorldFeatures,
  runPreloads,
  terrainHeight, surfaceHeight, backgroundTerrainHeight, roadDistance, getMountainFactor,
  biomeWeightsAt, biomeName, listFeatures, describeLocation, lavaLevelAt,
  SPAWN_X, SPAWN_Z, WATER_LEVEL,
} from 'infterrain'
```

- **`createInfiniteTerrain(scene, options)`** — just the streaming terrain mesh/material (same `options` as above minus tree/water/forest concerns).
- **`sampleTerrainSurfaceHeight(x, z, verts)`** — height of the rendered terrain surface at a world position: exactly the chunk's own triangles, which is also exactly what a Havok heightfield built from the chunk mesh (`PhysicsShapeGroundMesh`) collides with. Use this instead of raw `terrainHeight` when you need a position flush with what's drawn, e.g. spawning something on the surface. (Before 1.1 it blended the four grid corners bilinearly, which on rough ground was metres off the triangles - things placed with it sank into the ground or floated.)
- **`createWater(scene, { verts, viewRadius })`** — the lakes at `WATER_LEVEL`: soft-shored patches near the camera, a plane to the horizon (see [Lakes](#lakes)).
- **`createWorldFeatures(scene, terrainMat, options)`** — biome props, lava and special places, for a custom setup (`createOpenWorld` calls it for you). Same options as `createOpenWorld`'s feature options.
- **`surfaceHeight(x, z)`** — `terrainHeight`, except over a well's lid, where it is the lid.
- **`createForest(scene, treePaths, fakeTreePath, verts)`** / **`createOpenWorldGrass(...)`** — vegetation scattering.
- **`createMountainsInOpenWorld(scene, counts, types, options)`** — mountain/volcano/hill landmark meshes, see above.
- **`terrainHeight(x, z)`** / **`backgroundTerrainHeight(x, z, hillSize)`** — raw procedural height sampling.
- **`roadDistance(x, z)`**, **`getMountainFactor(x, z)`** — world-shape queries used for splat/vegetation placement, useful if you're placing your own objects.
- **`SPAWN_X`**, **`SPAWN_Z`**, **`WATER_LEVEL`** — world constants.

## Biomes

The wilds between the roads are cut into regions about 760 units across, each drawn by hash from:

| Biome | The ground | What grows there |
|---|---|---|
| **Emberfrost Rift** | black basalt plates split by fissures of slow, crusted lava; live magma veins pulse in the cracks | trees of ice, obsidian shards; embers rising and snow falling through them |
| **Thornvine Barrens** | wind-rippled dunes | giant ribbed saguaros with flowering crowns; vines thicker than a house arching out of the sand and back in; blowing sand |
| **Cloudstep Meadow** | bright meadow full of blossoms | clouds hovering a jump off the grass (you can stand on them), giant puffball dandelions, drifting seed-fluff |
| **Crystal Hollows** | pale cracked stone with crystal shards that glint | glowing crystal clusters in violet, teal and rose; glints in the air |
| **Skyneedle Grove** | dark moss | skyneedles - trees thinner than your arm that rise out of sight into the sky - and giant glowing mushrooms; fireflies |
| *The Wilds* | the land as it always was | — |

A biome is only ever allowed in the **wilds**: away from every road, the spawn hub, the river, the forest clearings and the host's [kept-clear spots](#keeping-a-hosts-places-clear). Those are where a host's own content sits, so a host that built along the roads keeps exactly the ground it built on. Regions blend into each other, and into native land, over ~150 units either side of their edge, and the first regions you reach are gentler versions of what lies further out.

Biomes reshape `terrainHeight` itself (plates and fissures, dunes, knolls), so physics, the host's own height queries and everything else see the same ground. The ground colours are recoloured from the textures the terrain already samples, so a strange land costs arithmetic, not more texture taps.

```js
import { biomeWeightsAt, dominantBiome, biomeName, BIOME_INFO } from 'infterrain'
biomeName(x, z)                      // 'Emberfrost Rift'
biomeWeightsAt(x, z).emberfrost      // 0..1
```

## Special places

One-off things you come across in the wilds, deterministic by position like everything else:

- **Well** — a wide, square-cut stone well (14 × 10 units inside) with a windlass across it, on a flattened green. Fall in and it is ~30 units deep; railed plank stairs climb its walls in straight flights, with a landing in each corner, back up to a gap in the rim.
- **Grotto** — a crack in the ground among boulders, a ramp down into it, and under the field a glowing cave: crystals, glowworms, a still lit pool.
- **Falls** — a crag of layered rock, stepping in tier by tier over mossy ledges to a broken skyline, with a waterfall pouring from a notch in its top into a plunge pool, spray and a rainbow standing in it, and fallen blocks round its foot. Behind the falling water a ledge leads into the rock, to a hidden crystal shrine. The pool spills into a creek that finds its own way downhill until it reaches a lake, the river or a hollow.
- **Rising falls** — a still pond whose water pours *up* out of it in a twisting column, breaking into rain far overhead, with stones floating loose around it.
- **Cloudstep** — clouds low enough to jump onto, climbing as stepping stones to a sky island with a glowing bloom on top.
- **Needle** — a lone skyneedle, hundreds of units tall.

```js
import { listFeatures, describeLocation } from 'infterrain'
listFeatures(x, z, 2000)   // [{ kind, x, y, z, distance, key }, ...] nearest first
describeLocation(x, z)     // ['Cloudstep Meadow', 'nearest: well 212m away']
```

**Going underground on a heightfield.** A heightfield has no holes, so a well cannot be one. Instead the grid vertex under it is pushed far down (a funnel), and a *lid* — a patch drawn with the terrain's own material, with colliders — covers the funnel at ground level, open only at the well mouth. The shaft has its own floor and walls clear of the funnel. For this to line up, those sites sit exactly on the terrain grid, so pass the same `verts` everywhere. `sampleTerrainSurfaceHeight` and `surfaceHeight` return the lid where one covers a pit, so things placed by height stand on it.

**Walking.** With physics on, everything walkable is built for a box-bodied character that can walk up a slope of about 0.65 but not step up a ledge more than a few centimetres (a typical capsule/box controller): stairs are smooth ramps under the planks, and every joint is kept under 0.04. Nothing is dug below y = -44, so a host that rescues players who fall out of the world (below -50, say) never mistakes the bottom of a well for the void.

**Hooks.** `onFeatureBuilt` reports each place as it streams in, with named `spots` inside it — the bottom of a well, a grotto's jaws, heart and treasure room, the shrine behind the falls, a cloud island's summit — for a host's loot, monsters or quests.

**Stash spots.** The hidden places — wells, grottos, the caves behind the falls — each keep three spots of open floor (`chest`, `weapon`, `patch`) clear of their fallen stones, crystals, stalagmites and cargo, so whatever a host leaves there stands on bare floor; a grotto keeps five more for ore veins (`ore0`–`ore4`), and its `chest` spot is in the treasure room no passage reaches — the way in is a window high in a wall, two cargo-box jumps up. `siteStashSpots(key)` gives them in the world, `y` being that floor (far below the lid over a well, so place things at it rather than on the ground height; a grotto's maze and the cave behind the falls stand on the ground itself). Pure, like `listFeatures` — a game server with no scene can lay out its loot with it:

```js
import { listFeatures, siteStashSpots } from 'infterrain'
for (const place of listFeatures(x, z, 3000).filter(p => p.kind === 'well'))
  siteStashSpots(place.key)   // [{ name: 'chest', x, y, z }, { name: 'weapon', ... }, { name: 'patch', ... }]
```

## Keeping a host's places clear

Biomes and special places are placed by hash, so a host with content at fixed coordinates names those spots and nothing new will touch them:

```js
await createOpenWorld(scene, trees, fakeTree, {
  keepClear: [{ x: 1200, z: 800, r: 60 }, /* ... */],
})
```

Inside `r` the ground is exactly what it always was; the new terrain eases in over 160 units beyond it. The default list is the fixed sites of the vessel open world (its castles, witch towers and graveyards) — `DEFAULT_KEEP_CLEAR`; pass `[]` for none.

## Lakes

Every hollow below `WATER_LEVEL` holds water. Near the camera it is laid in per-chunk patches whose vertices know how deep the water is over the ground *as drawn* — the terrain's own triangles, not the ideal curve — so it fades out exactly at the shoreline, soft, with a rim of scum; beyond ~250 units a plane fills the horizon as before. Both fog through the scene's own fog mode.

## The demo lab

```
npm run demo
```

then open http://localhost:5199. A test bed set up the way the vessel client sets its open world up (same fog, lights, verts and Havok heightfield physics), with a stand-in player: **WASD** to move, **Shift** to sprint, **Space** to jump, **F** to toggle a free camera, and a *go to* list of every special place nearby. It serves the module's `src/` directly. `?look=clear` thins the fog; `?x=..&z=..` starts somewhere else. Ground textures and tree models are borrowed from a host's `public/` folder — set `INFTERRAIN_ASSETS` to point at one.

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
- The water ribbon is laid out to where the **drawn** bank comes up through it, per row and per side, rather than to the ideal channel width — the 16-unit grid cannot draw a bank that steep, so cutting the water at the ideal width left it ending in an edge hanging over lower ground. It fades out by its depth over the drawn ground, so the shore is soft.
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
