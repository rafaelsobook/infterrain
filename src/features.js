import { Matrix, Quaternion, Vector3 } from '@babylonjs/core'
import { hash, smoothstep } from './noise'
import { biomeWeightsAt, emberPlateAt } from './biomes'
import { WATER_LEVEL, roadDistance, inRiverChannel, lavaLevelAt, SPAWN_X, SPAWN_Z } from './world'
import { inSiteFootprint, sitesInChunk, siteGridStep } from './sites'
import { drawnHeight } from './ground'
import { Colliders } from './colliders'
import { propMaterial } from './materials'
import { lavaMaterial, buildLavaPatch } from './lava'
import {
  iceTreeGeo, obsidianGeo, cactusGeo, vineGeo, crystalClusterGeo, CRYSTAL_PALETTES,
  boulderGeo, mushroomGeo, needleGeo, cloudGeo, puffballGeo,
} from './flora'
import { buildSiteFeature } from './builders'
import { createAmbience } from './ambience'

// ── The world's features ────────────────────────────────────────────────────
//
// Streams, per terrain chunk around the camera:
//   - each biome's own growth (biomes.js) - ice trees and obsidian on the
//     emberfrost plates, saguaros and giant thornvines in the dunes, crystal
//     clusters, skyneedles and glowing mushrooms, low clouds over the meadows
//   - the lava in emberfrost's fissures (lava.js)
//   - the special places (sites.js), built by builders.js
// with static colliders for anything solid, if the host runs physics.
//
// Placement is a hash of world position on a fixed grid per prop kind, never
// of the chunk or the order chunks load in, so every client - and the same
// client walking away and back - sees the same world. The props are a few
// procedural variants per kind, instanced: one draw call per variant.

const CHUNK = 256
const LOG_PREFIX = '[infterrain]'

// what grows where. cell: grid spacing it is scattered on; chance: odds a
// cell holds one, at full biome strength; scale: [min, max] size; far: how
// far off it is still drawn (none: always - the landmarks)
const SCATTER = [
  { kind: 'icewood', biome: 'emberfrost', cell: 23, chance: 0.32, variants: 4, mat: 'ice', scale: [0.8, 1.3], plate: true, far: 230,
    build: s => iceTreeGeo(s), collide: (c, x, y, z, k, m) => c.box(x, y + m.height * k * 0.22, z, 0.8 * k, m.height * k * 0.45, 0.8 * k) },
  { kind: 'obsidian', biome: 'emberfrost', cell: 29, chance: 0.22, variants: 3, mat: 'obsidian', scale: [0.7, 1.7], plate: true, far: 170,
    build: s => obsidianGeo(s), collide: (c, x, y, z, k) => c.box(x, y + 0.9 * k, z, 1.7 * k, 1.8 * k, 1.7 * k) },
  { kind: 'cactus', biome: 'thornvine', cell: 21, chance: 0.25, variants: 5, mat: 'cactus', scale: [0.8, 1.2], maxSlope: 0.4, far: 180,
    build: s => cactusGeo(s), collide: (c, x, y, z, k, m) => c.box(x, y + m.height * k * 0.5, z, m.radius * 2 * k, m.height * k, m.radius * 2 * k) },
  { kind: 'thornvine', biome: 'thornvine', cell: 118, chance: 0.85, variants: 3, mat: 'vine', scale: [0.85, 1.15], big: true,
    build: s => vineGeo(s), collide: vineColliders },
  { kind: 'sandstone', biome: 'thornvine', cell: 44, chance: 0.22, variants: 3, mat: 'sandstone', scale: [0.8, 1.9], far: 200,
    build: s => boulderGeo(s, [0.66, 0.53, 0.4]), collide: (c, x, y, z, k, m) => c.box(x, y + m.height * k * 0.35, z, m.radius * 1.5 * k, m.height * k * 0.7, m.radius * 1.5 * k) },
  // sparse on purpose: a host that has real, mineable crystals (crystalnode.js)
  // wants these as the odd outcrop between them, and every one is an instance
  // and a physics body
  { kind: 'crystal', biome: 'crystal', cell: 22, chance: 0.1, variants: 6, mat: v => `crystal${v % 3}`, scale: [0.5, 1.0], far: 200,
    build: (s, v) => crystalClusterGeo(s, CRYSTAL_PALETTES[v % 3]), collide: (c, x, y, z, k) => c.box(x, y + 1.6 * k, z, 1.8 * k, 3.2 * k, 1.8 * k) },
  { kind: 'palestone', biome: 'crystal', cell: 36, chance: 0.2, variants: 3, mat: 'palestone', scale: [0.8, 1.8], far: 170,
    build: s => boulderGeo(s, [0.72, 0.7, 0.78]), collide: (c, x, y, z, k, m) => c.box(x, y + m.height * k * 0.35, z, m.radius * 1.5 * k, m.height * k * 0.7, m.radius * 1.5 * k) },
  { kind: 'skyneedle', biome: 'skyneedle', cell: 27, chance: 0.3, variants: 4, mat: 'needle', scale: [0.85, 1.15],
    build: (s, v) => needleGeo(s, 150 + v * 32), collide: (c, x, y, z, k) => c.box(x, y + 10, z, 1.0 * k, 20, 1.0 * k, 0, 0, true) },
  { kind: 'glowcap', biome: 'skyneedle', cell: 12, chance: 0.15, variants: 4, mat: 'mushroom', scale: [0.8, 1.6], far: 80,
    build: (s, v) => mushroomGeo(s, 0.8 + (v % 2) * 0.9) },
  { kind: 'puffball', biome: 'cloudmeadow', cell: 15, chance: 0.1, variants: 4, mat: 'cloud', scale: [0.8, 1.4], far: 110,
    build: s => puffballGeo(s) },
  { kind: 'cloudlet', biome: 'cloudmeadow', cell: 27, chance: 0.17, variants: 4, mat: 'cloud', scale: [0.9, 1.25], hover: 0.95, far: 190,
    build: (s, v) => cloudGeo(s, 3.4 + v * 0.9, 3.0 + v * 0.7, 1.3), size: v => [3.4 + v * 0.9, 3.0 + v * 0.7],
    collide: (c, x, y, z, k, m, v, yaw) => {
      const [w, d] = [3.4 + v * 0.9, 3.0 + v * 0.7]
      // frictionless, like the cloud stairs' (builders.js says why)
      c.box(x, y - 0.3, z, w * 0.72 * k, 0.6, d * 0.72 * k, yaw, 0, true, 0)
    } },
]

// colliders along a vine's low reaches - where it comes out of the ground
// and goes back in - so nobody walks through the trunk. The high arch needs
// none; nothing reaches it
function vineColliders(c, x, y, z, k, m, v, yaw) {
  const path = m.path
  const rot = Matrix.RotationY(yaw)
  const toWorld = p => {
    const q = Vector3.TransformCoordinates(new Vector3(p.x * k, p.y * k, p.z * k), rot)
    return [x + q.x, y + q.y, z + q.z]
  }
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1]
    if (Math.min(a.y, b.y) * k > 4) continue
    const A = toWorld(a), B = toWorld(b)
    const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2]
    const len = Math.hypot(dx, dy, dz)
    const run = Math.hypot(dx, dz)
    const r = a.r * k * 1.7
    c.box((A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2, r, r, len + 0.2, Math.atan2(dx, dz), -Math.atan2(dy, run))
  }
}

export const MATERIALS = {
  ice:       { texture: 'ice', texScale: 0.35, texMix: 0.45, rim: [0.32, 0.6, 0.85], rimPower: 2.2, glow: [0.25, 0.62, 1.0], pulse: 0.3, lift: 0.22 },
  obsidian:  { texture: 'rock', texScale: 0.4, texMix: 0.25, rim: [0.6, 0.24, 0.08], rimPower: 2.5, lift: 0.02 },
  cactus:    { texture: 'cactus', texScale: 0.42, texMix: 0.8, rim: [0.05, 0.08, 0.04], rimPower: 3, glow: [1.0, 0.9, 0.7], lift: 0.06 },
  vine:      { texture: 'bark', texScale: 0.2, texMix: 0.75, lift: 0.05 },
  sandstone: { texture: 'rock', texScale: 0.22, texMix: 0.8, lift: 0.06 },
  palestone: { texture: 'rock', texScale: 0.22, texMix: 0.75, lift: 0.07, rim: [0.1, 0.1, 0.14] },
  crystal0:  { texture: 'ice', texScale: 0.3, texMix: 0.3, rim: CRYSTAL_PALETTES[0].rim, rimPower: 2, glow: CRYSTAL_PALETTES[0].glow, pulse: 0.35, lift: 0.14 },
  crystal1:  { texture: 'ice', texScale: 0.3, texMix: 0.3, rim: CRYSTAL_PALETTES[1].rim, rimPower: 2, glow: CRYSTAL_PALETTES[1].glow, pulse: 0.35, lift: 0.14 },
  crystal2:  { texture: 'ice', texScale: 0.3, texMix: 0.3, rim: CRYSTAL_PALETTES[2].rim, rimPower: 2, glow: CRYSTAL_PALETTES[2].glow, pulse: 0.35, lift: 0.14 },
  needle:    { texture: 'bark', texScale: 0.6, texMix: 0.5, glow: [0.5, 1.0, 0.85], pulse: 0.4, sway: 1.8, swayHeight: 200, fogScale: 0.8, lift: 0.07 },
  mushroom:  { texture: 'plain', texMix: 0, glow: [0.35, 1.0, 0.75], pulse: 0.35, lift: 0.1 },
  cloud:     { texture: 'cloud', texScale: 0.18, texMix: 0.55, rim: [0.2, 0.22, 0.26], rimPower: 1.6, glow: [0.46, 0.48, 0.52], lift: 0.26 },
  // the special places (builders.js)
  stone:     { texture: 'stone', texScale: 0.45, texMix: 0.85, lift: 0.05 },
  wood:      { texture: 'wood', texScale: 0.5, texMix: 0.85, lift: 0.05 },
  cliff:     { texture: 'rock', texScale: 0.5, texMix: 0.6, lift: 0.09 },
  cave:      { texture: 'rock', texScale: 0.18, texMix: 0.8, lift: 0 },
  glow:      { texture: 'plain', texMix: 0, glow: [0.45, 0.95, 1.0], pulse: 0.3, lift: 0.1 },
  skybloom:  { texture: 'plain', texMix: 0, glow: [1.0, 0.78, 0.95], pulse: 0.5, lift: 0.2 },
  // the grotto's (grotto.js): cages and chains, bones and fangs, the eyes
  // burning in the dark, and spilled bronze
  iron:      { texture: 'stone', texScale: 0.9, texMix: 0.45, rim: [0.1, 0.08, 0.07], rimPower: 2.5, lift: 0.03 },
  bone:      { texture: 'rock', texScale: 0.7, texMix: 0.35, lift: 0.08 },
  ember:     { texture: 'plain', texMix: 0, glow: [1.0, 0.16, 0.05], pulse: 0.6, lift: 0 },
  gold:      { texture: 'plain', texMix: 0, glow: [1.0, 0.66, 0.3], pulse: 0.25, lift: 0.15 },
}

/**
 * Start streaming the features. Called by createOpenWorld; a custom setup
 * calls it after createInfiniteTerrain, passing that terrain's material
 * (the lids over well pits are drawn with it).
 *
 * options
 *   verts, viewRadius, unloadRadius   as the terrain's
 *   physics       false to never build colliders, even with a physics engine
 *   cameraPassMask collision-filter bit for colliders the host camera should
 *                 see through (clouds, stair rails) - see colliders.js
 *   propTextures  { stone, rock, wood, bark, ice, cactus, cloud } image paths
 *                 to use instead of the built-in procedural grain
 *   scatterDensity { crystal: 0.5, cactus: 0, ... } - a multiplier on how
 *                 many of each growth kind (SCATTER's kinds) there are; 0 leaves
 *                 that kind out altogether
 *   ambience      false to leave out the particles in the air (embers, snow,
 *                 fireflies, glints, seed-fluff, blowing sand)
 *   onFeatureBuilt(info)  called as each special place streams in, with
 *                 { kind, x, y, z, key, spots } - spots are places of
 *                 interest in it (the bottom of a well, a cave's heart) a
 *                 host might put loot or a monster at
 */
export function createWorldFeatures(scene, terrainMat, options = {}) {
  const {
    verts = 17,
    viewRadius = 1,
    unloadRadius,
    physics = true,
    cameraPassMask = 1 << 30,
    propTextures = {},
    onFeatureBuilt,
    ambience = true,
    scatterDensity = {},
  } = options
  const VIEW_R = viewRadius
  const UNLOAD_R = unloadRadius ?? viewRadius + 1
  const step = CHUNK / (verts - 1)

  const mats = new Map()
  const material = name => {
    let m = mats.get(name)
    if (!m) {
      m = propMaterial(scene, name, MATERIALS[name] ?? {}, propTextures)
      mats.set(name, m)
    }
    return m
  }
  const masters = new Map()
  const masterFor = (spec, v) => {
    const key = `${spec.kind}_${v}`
    let m = masters.get(key)
    if (!m) {
      const t0 = performance.now()
      const built = spec.build(4099 + v * 7919 + spec.kind.length * 131, v)
      const matName = typeof spec.mat === 'function' ? spec.mat(v) : spec.mat
      const mesh = built.geo.toMesh(`infterrain_master_${spec.kind}_${v}`, scene, material(matName))
      mesh.isVisible = false
      mesh.isPickable = false
      // past `far` its instances are not drawn at all (an LOD level of
      // nothing - each instance is judged on its own distance)
      if (spec.far) mesh.addLODLevel(spec.far, null)
      m = { mesh, height: built.height, radius: built.radius, path: built.path }
      masters.set(key, m)
      note(`master:${spec.kind}`, performance.now() - t0)
    }
    return m
  }
  let lavaMat = null
  const air = ambience ? createAmbience(scene) : null

  const shared = { scene, terrainMat, verts, step, material, propTextures, cameraPassMask }

  const newOut = () => ({ insts: [], meshes: [], colliders: new Colliders(scene, { enabled: physics, passMask: cameraPassMask }) })

  // The special places stream one ring of chunks further out than the
  // props. A site belongs to the chunk its centre is in, but a well's pit
  // vertex can sit on that chunk's edge and be drawn by its neighbour too -
  // and the terrain only builds what is in range, so with the same radius a
  // loaded neighbour could show the funnel while the lid, built with the
  // site's own chunk, was not there yet. One ring further covers any site
  // whose ground the terrain can be drawing.
  function buildSites(ox, oz) {
    const out = newOut()
    for (const site of sitesInChunk(ox, oz, CHUNK)) {
      try {
        const t0 = performance.now()
        const info = buildSiteFeature({ ...shared, colliders: out.colliders, meshes: out.meshes }, site)
        note(site.kind, performance.now() - t0)
        if (info && onFeatureBuilt) onFeatureBuilt(info)
      } catch (err) {
        console.error(`${LOG_PREFIX} building ${site.kind} at ${site.x.toFixed(0)}, ${site.z.toFixed(0)} failed:`, err)
      }
    }
    return out
  }

  function buildChunk(ox, oz) {
    const out = newOut()
    // lava
    try {
      if (!lavaMat) lavaMat = lavaMaterial(scene)
      const lava = buildLavaPatch(scene, lavaMat, ox, oz, step)
      if (lava) out.meshes.push(lava)
    } catch (err) {
      console.error(`${LOG_PREFIX} lava patch failed:`, err)
    }
    // the biomes' growth
    for (const spec of SCATTER) {
      const t0 = performance.now()
      scatter(spec, ox, oz, out)
      note(`scatter:${spec.kind}`, performance.now() - t0)
    }
    return out
  }

  function scatter(spec, ox, oz, out) {
    const density = scatterDensity[spec.kind] ?? 1
    if (density <= 0) return
    const c = spec.cell
    const i0 = Math.ceil(ox / c), i1 = Math.floor((ox + CHUNK - 1e-6) / c)
    const j0 = Math.ceil(oz / c), j1 = Math.floor((oz + CHUNK - 1e-6) / c)
    // a quick look at the chunk's corners and middle - most chunks have none
    // of a given biome at all
    let anyHere = false
    for (const [px, pz] of [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]])
      if (biomeWeightsAt(ox + px * CHUNK, oz + pz * CHUNK)[spec.biome] > 0.15) { anyHere = true; break }
    if (!anyHere) return
    const salt = spec.kind.length * 7 + spec.kind.charCodeAt(0)
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.1 + hash(i, j, 500 + salt) * 0.8) * c
        const z = (j + 0.1 + hash(i, j, 600 + salt) * 0.8) * c
        if (x < ox || x >= ox + CHUNK || z < oz || z >= oz + CHUNK) continue
        const w = biomeWeightsAt(x, z)[spec.biome]
        if (w <= 0.2) continue
        if (hash(i, j, 700 + salt) > spec.chance * density * smoothstep(0.25, 0.7, w)) continue
        if (Math.hypot(x - SPAWN_X, z - SPAWN_Z) < 500) continue
        if (roadDistance(x, z) < (spec.big ? 45 : 12)) continue
        if (inRiverChannel(x, z, spec.big ? 30 : 6)) continue
        if (inSiteFootprint(x, z, spec.big ? 40 : 5)) continue
        const g = drawnHeight(x, z, step)
        if (g < WATER_LEVEL + 0.4) continue
        if (spec.plate) {
          if (emberPlateAt(x, z) < 0.75) continue
          if (g < lavaLevelAt(x, z) + 0.6) continue
        }
        const gx = drawnHeight(x + 2, z, step), gz = drawnHeight(x, z + 2, step)
        const slope = Math.hypot(gx - g, gz - g) / 2
        if (slope > (spec.maxSlope ?? 0.55)) continue

        const v = Math.floor(hash(i, j, 800 + salt) * spec.variants) % spec.variants
        const master = masterFor(spec, v)
        const k = spec.scale[0] + hash(i, j, 900 + salt) * (spec.scale[1] - spec.scale[0])
        const yaw = hash(i, j, 1000 + salt) * Math.PI * 2
        let y = g - 0.05
        if (spec.hover) {
          // a cloud: its walkable top a jump off the ground - and only over
          // ground level enough that the jump is the same all round it
          const [w0, d0] = spec.size(v)
          const r = Math.max(w0, d0) * k * 0.5
          let lo = g, hi = g
          for (let a = 0; a < 8; a++) {
            const h = drawnHeight(x + Math.cos(a * 0.785) * r, z + Math.sin(a * 0.785) * r, step)
            lo = Math.min(lo, h); hi = Math.max(hi, h)
          }
          if (hi - lo > 0.4) continue
          y = hi + spec.hover
        }
        const inst = master.mesh.createInstance(`${spec.kind}_${Math.round(x)}_${Math.round(z)}`)
        inst.position.set(x, y, z)
        inst.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), yaw)
        inst.scaling.setAll(k)
        inst.isPickable = false
        inst.freezeWorldMatrix()
        out.insts.push(inst)
        spec.collide?.(out.colliders, x, y, z, k, master, v, yaw)
      }
  }

  // ── streaming, the same shape as every other system here ──
  const chunks = new Map()
  const siteChunks = new Map()
  // what streaming costs - each chunk is built in one frame, so maxMs is the
  // worst hitch a player could feel walking into new ground
  const stats = { builds: 0, lastMs: 0, maxMs: 0, totalMs: 0, byKind: {} }
  const note = (kind, ms) => {
    const k = stats.byKind[kind] ?? (stats.byKind[kind] = { n: 0, maxMs: 0, totalMs: 0 })
    k.n++; k.totalMs += ms
    if (ms > k.maxMs) k.maxMs = ms
  }
  const queue = []
  function update(camX, camZ) {
    const cx0 = Math.floor(camX / CHUNK), cz0 = Math.floor(camZ / CHUNK)
    for (const [map, keep] of [[chunks, UNLOAD_R], [siteChunks, UNLOAD_R + 1]])
      for (const [key, c] of map) {
        const [cx, cz] = key.split(',').map(Number)
        if (Math.abs(cx - cx0) > keep || Math.abs(cz - cz0) > keep) {
          disposeChunk(c)
          map.delete(key)
        }
      }
    queue.length = 0
    for (const [map, R, kind] of [[siteChunks, VIEW_R + 1, 'sites'], [chunks, VIEW_R, 'props']])
      for (let dz = -R; dz <= R; dz++)
        for (let dx = -R; dx <= R; dx++) {
          const key = `${cx0 + dx},${cz0 + dz}`
          // sites first at equal distance - a missing lid shows, a missing cactus does not
          if (!map.has(key)) queue.push({ key, kind, ox: (cx0 + dx) * CHUNK, oz: (cz0 + dz) * CHUNK, d: dx * dx + dz * dz + (kind === 'sites' ? 0 : 0.5) })
        }
    queue.sort((a, b) => a.d - b.d)
  }
  function disposeChunk(c) {
    for (const i of c.insts) i.dispose()
    for (const m of c.meshes) m.dispose()
    c.colliders.dispose()
  }

  let prevCX = null, prevCZ = null, warnedStep = false
  const obs = scene.onBeforeRenderObservable.add(() => {
    const cam = scene.activeCamera
    if (!cam) return
    // the sites snap to the terrain's grid - say so once if this was told a
    // different verts than the terrain was built with
    if (!warnedStep && Math.abs(siteGridStep() - step) > 1e-9) {
      warnedStep = true
      console.warn(`${LOG_PREFIX} features were given verts ${verts} but the terrain grid step is ${siteGridStep()} - pass both the same verts`)
    }
    const cx = Math.floor(cam.position.x / CHUNK), cz = Math.floor(cam.position.z / CHUNK)
    if (cx !== prevCX || cz !== prevCZ) { prevCX = cx; prevCZ = cz; update(cam.position.x, cam.position.z) }
    // colliders queued by everything built so far, nearest chunks first, a
    // few milliseconds' worth a frame (colliders.js says why)
    let budget = 4
    for (const map of [siteChunks, chunks]) for (const c of map.values()) {
      if (budget <= 0) break
      if (!c.colliders.pending.length) continue
      const t0 = performance.now()
      c.colliders.flush(budget)
      budget -= performance.now() - t0
    }
    // one chunk a frame - props cost more to lay out than terrain does
    if (queue.length) {
      const { key, kind, ox, oz } = queue.shift()
      const map = kind === 'sites' ? siteChunks : chunks
      if (!map.has(key)) {
        const t0 = performance.now()
        map.set(key, kind === 'sites' ? buildSites(ox, oz) : buildChunk(ox, oz))
        const ms = performance.now() - t0
        stats.builds++; stats.lastMs = ms; stats.totalMs += ms
        if (ms > stats.maxMs) stats.maxMs = ms
      }
    }
  })

  return {
    chunks,
    stats,
    dispose() {
      scene.onBeforeRenderObservable.remove(obs)
      for (const c of chunks.values()) disposeChunk(c)
      for (const c of siteChunks.values()) disposeChunk(c)
      chunks.clear()
      siteChunks.clear()
      for (const m of masters.values()) m.mesh.dispose()
      for (const m of mats.values()) m.dispose()
      lavaMat?.dispose()
      air?.dispose()
    },
  }
}
