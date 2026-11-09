import { Mesh, MeshBuilder, ShaderMaterial, Texture } from '@babylonjs/core'
import { terrainHeight, roadDistance, SPAWN_X, SPAWN_Z, WATER_LEVEL, inRiverChannel } from './world'
import { sampleTerrainSurfaceHeight } from './terrain'
import { foliageSuppression } from './biomes'
import { inSiteFootprint } from './sites'
import { FOG_UNIFORM_NAMES, FOG_UNIFORMS_GLSL, FOG_FACTOR_GLSL, syncFogUniforms } from './fog'

const CHUNK_SIZE = 256

// World-unit plane size for each named tier — tune here rather than exposing
// raw scale numbers through the public API.
const SIZE_SCALE = { small: 0.6, medium: 1.4, large: 3.0 }
// How far each tier's top leans in the breeze, as a share of its own height -
// flowers on thin stems most, the big stiff bushes least. A type's own `sway`
// overrides this.
const SIZE_SWAY = { small: 0.08, medium: 0.06, large: 0.035 }

function hash(a, b, seed) {
  let v = (seed * 1234567 + a * 374761393 + b * 668265263) | 0
  v = Math.imul(v ^ (v >>> 13), 1274126177)
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296
}

// worldViewProjection (what a StandardMaterial-based mesh gets for free) is
// ONE matrix for the whole draw call — fine for the single invisible master
// mesh, but every instance needs its OWN world matrix or they all render on
// top of each other using the master's. Babylon streams that in per-instance
// through the world0..world3 attributes when the shader declares them —
// StandardMaterial does this internally; a hand-written ShaderMaterial has
// to ask for it explicitly, which is what was missing here.
const GRASS_VERT = /* glsl */`
  precision highp float;
  attribute vec3 position;
  attribute vec2 uv;
  attribute vec4 world0;
  attribute vec4 world1;
  attribute vec4 world2;
  attribute vec4 world3;
  uniform mat4 viewProjection;
  uniform vec3 uCamPos;
  uniform float uWindTime;
  uniform float uWindSway;
  uniform float uWindFar;
  varying vec2 vUV;
  varying vec3 vWorldPos;
  void main() {
    vUV = uv;
    mat4 instanceWorld = mat4(world0, world1, world2, world3);
    // world position kept as a varying so the fragment shader can measure its
    // distance to the camera for fog. This shader previously computed
    // gl_Position and discarded the world position, so grass had no way to fog
    // even in principle.
    vec4 worldPos = instanceWorld * vec4(position, 1.0);

    // A slow breeze. The card bends from its foot (the planes are centred on
    // the instance, so the foot is half the plant's height below it) by height
    // squared, so the base stays planted and the top does the moving. Each
    // plant takes its own tempo and phase from where it stands, and slow gusts
    // roll across the field on top of that. Past uWindFar it is skipped - it
    // fades out over the last fifth, and nothing that small could be seen
    // moving that far off anyway.
    vec3 root = instanceWorld[3].xyz;
    float plantH = length(instanceWorld[1].xyz);
    float windFade = 1.0 - smoothstep(uWindFar * 0.8, uWindFar, length(root.xz - uCamPos.xz));
    if (windFade > 0.0 && uWindSway > 0.0) {
      vec2 windDir = vec2(0.34, 0.94);
      float h = clamp((worldPos.y - root.y) / plantH + 0.5, 0.0, 1.0);
      vec3 p3 = fract(root.xzx * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      float r = fract((p3.x + p3.y) * p3.z);
      float gust = sin(uWindTime * 0.45 - mod(dot(root.xz, windDir) * 0.5, 6.2832)) * 0.5 + 0.5;
      float sway = sin(uWindTime * (0.9 + r * 0.4) + r * 6.2832) * 0.65
                 + sin(uWindTime * (1.6 + r * 0.5) + r * 17.0) * 0.35;
      float flutter = sin(uWindTime * (1.2 + r * 0.6) + r * 29.0);
      vec2 bend = windDir * (gust * 0.7 + sway * (0.45 + 0.55 * gust))
                + vec2(-windDir.y, windDir.x) * flutter * 0.25;
      vec2 tip = bend * h * h * uWindSway * plantH * windFade;
      worldPos.xz += tip;
      // dipping as it leans, so it bends rather than stretches
      worldPos.y -= dot(tip, tip) / max(2.0 * h * plantH, 0.05);
    }

    vWorldPos = worldPos.xyz;
    gl_Position = viewProjection * worldPos;
  }
`

// These grass/flower/bush cutouts are plain jpgs shot on a black backdrop —
// jpg has no alpha channel at all (unlike the tree billboard's webp), so
// there's no transparency to alpha-blend against. Key the near-black
// backdrop out by hand instead. Hard discard (not blended) also means no
// transparency-sort issues between overlapping grass cards.
//
// Tried un-premultiplying (dividing by max(r,g,b)) to fix the dark edge
// fringe, but that assumes EVERY dark pixel is background bleeding in —
// these are ordinary photos, so most of the plant's own natural shading is
// just as dark, and dividing it out blew the whole thing out into a
// saturated glow. Simple threshold it is; a slightly higher cutoff than the
// bare-minimum "reject pure black" eats more of the fringe at the cost of a
// touch of erosion right at the silhouette edge, which reads much better
// than either the halo or the glow.
const GRASS_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D diffuseSampler;
  varying vec2 vUV;
  varying vec3 vWorldPos;
${FOG_UNIFORMS_GLSL}
${FOG_FACTOR_GLSL}
  void main() {
    vec3 col = texture2D(diffuseSampler, vUV).rgb;
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    if (luma < 0.18) discard;
    // fog applied after the alpha-cutout discard above, so only pixels that
    // actually survive get tinted
    gl_FragColor = vec4(mix(col, uFogColor, fogFactor(vWorldPos)), 1.0);
  }
`

function buildGrassMaster(scene, type, idx) {
  const scale = SIZE_SCALE[type.size] ?? SIZE_SCALE.medium

  // A single flat card would go edge-on (invisible) from some angles, and
  // billboarding it to always face the camera reads as every plant rotating
  // toward you as you walk — fine for one distant tree impostor, distracting
  // across a whole field of grass. Two static planes crossed at 90° give a
  // reasonable silhouette from any direction without ever rotating.
  const planeA = MeshBuilder.CreatePlane(`master_grass_${idx}_a`, { size: 1 }, scene)
  const planeB = MeshBuilder.CreatePlane(`master_grass_${idx}_b`, { size: 1 }, scene)
  planeB.rotation.y = Math.PI / 2
  const master = Mesh.MergeMeshes([planeA, planeB], true, true, undefined, false, false)
  master.name = `master_grass_${idx}`

  const mat = new ShaderMaterial(`grassMat_${idx}`, scene, {
    vertexSource:   GRASS_VERT,
    fragmentSource: GRASS_FRAG,
  }, {
    attributes: ['position', 'uv', 'world0', 'world1', 'world2', 'world3'],
    uniforms:   ['viewProjection', 'uWindTime', 'uWindSway', 'uWindFar', ...FOG_UNIFORM_NAMES],
    samplers:   ['diffuseSampler'],
  })
  mat.setFloat('uWindSway', type.sway ?? SIZE_SWAY[type.size] ?? SIZE_SWAY.medium)

  const tex = new Texture(type.texturePath, scene)
  // Same mip-bleed risk as the tree billboards (see forest.js) — keep
  // distant grass reading the crisp top-level texture.
  tex.updateSamplingMode(Texture.LINEAR_LINEAR)
  mat.setTexture('diffuseSampler', tex)
  mat.backFaceCulling = false

  master.material   = mat
  master.isVisible  = false
  master.isPickable = false
  return { master, scale, qnty: Math.max(0, type.qnty | 0) }
}

function spawnChunkGrass(masters, ox, oz, verts) {
  const insts = []
  masters.forEach(({ master, scale, qnty }, typeIdx) => {
    for (let i = 0; i < qnty; i++) {
      const a = ox + typeIdx * 92821 + i * 131
      const b = oz + typeIdx * 55871 + i * 977
      const wx = ox + hash(a, b, 1) * CHUNK_SIZE
      const wz = oz + hash(a, b, 2) * CHUNK_SIZE

      if (roadDistance(wx, wz) < 3) continue
      // the river bed is underwater. The WATER_LEVEL test below only catches
      // the global sea plane, which the river is not on - it has its own
      // surface following its own bed (world.js's riverSurfaceY), so without
      // this, grass grows on the bottom of the river
      if (inRiverChannel(wx, wz, 1)) continue
      // see forest.js - the same two rules
      if (inSiteFootprint(wx, wz, 2)) continue
      const crowded = foliageSuppression(wx, wz, 'grass')
      if (crowded > 0 && hash(a, b, 5) < crowded) continue
      const hRaw = terrainHeight(wx, wz)
      if (hRaw < WATER_LEVEL + 1) continue
      const hX = terrainHeight(wx + 3, wz)
      const hZ = terrainHeight(wx, wz + 3)
      const slope = Math.hypot((hX - hRaw) / 3, (hZ - hRaw) / 3)
      if (slope > 0.5) continue // keep bare rock/cliff faces clear

      const jitter     = 0.8 + hash(a, b, 3) * 0.4
      const finalScale = scale * jitter
      // Grounded on the same flat-shaded surface the chunk mesh actually
      // draws (see sampleTerrainSurfaceHeight in terrain.js) — same fix
      // applied to trees so grass doesn't float on hills either.
      const hGround = sampleTerrainSurfaceHeight(wx, wz, verts)

      const inst = master.createInstance(`grass${typeIdx}_${ox}_${oz}_${i}`)
      inst.scaling.setAll(finalScale)
      inst.position.set(wx, hGround + finalScale / 2, wz)
      inst.rotation.y = hash(a, b, 4) * Math.PI * 2
      inst.isPickable = false
      insts.push(inst)
    }
  })
  return insts
}

// types: [{ texturePath, qnty, size }]
//   texturePath — image path (jpg cutouts on black are handled automatically)
//   qnty        — instances PER LOADED CHUNK_SIZE (256x256) chunk, not a
//                 world total — the world streams infinitely, so there is
//                 no "total" to speak of.
//   size        — "small" | "medium" | "large", mapped through SIZE_SCALE.
//   sway        — optional: how far its top leans in the breeze, as a share
//                 of its height (default by size, SIZE_SWAY). 0 stands still.
// options.verts should match whatever you passed to createOpenWorld()/
// createInfiniteTerrain() — that's what makes grass ground flush with the
// actual rendered terrain instead of the idealized (unrendered) curve.
// options.windFar — beyond this distance from the camera grass stops swaying
// (default 300).
export async function createOpenWorldGrass(scene, types, options = {}) {
  const { viewRadius = 1, unloadRadius, verts = 17, windFar = 300 } = options
  const VIEW_R   = viewRadius
  const UNLOAD_R = unloadRadius ?? (viewRadius + 1)

  const masters    = types.map((t, i) => buildGrassMaster(scene, t, i))
  masters.forEach(({ master }) => master.material.setFloat('uWindFar', windFar))
  const windStart  = performance.now()
  const chunks     = new Map()
  const buildQueue = []
  const QUEUE_BATCH = 4

  function enqueue(key, ox, oz, dist2) {
    let lo = 0, hi = buildQueue.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; buildQueue[mid].dist2 < dist2 ? lo = mid + 1 : hi = mid }
    buildQueue.splice(lo, 0, { key, ox, oz, dist2 })
  }

  function update(camX, camZ) {
    const cx0 = Math.floor(camX / CHUNK_SIZE)
    const cz0 = Math.floor(camZ / CHUNK_SIZE)
    for (const [key, insts] of chunks) {
      const [cx, cz] = key.split(',').map(Number)
      if (Math.abs(cx - cx0) > UNLOAD_R || Math.abs(cz - cz0) > UNLOAD_R) {
        insts.forEach(i => i.dispose())
        chunks.delete(key)
      }
    }
    for (let dz = -VIEW_R; dz <= VIEW_R; dz++) {
      for (let dx = -VIEW_R; dx <= VIEW_R; dx++) {
        const key = `${cx0 + dx},${cz0 + dz}`
        if (!chunks.has(key) && !buildQueue.some(q => q.key === key)) {
          enqueue(key, (cx0 + dx) * CHUNK_SIZE, (cz0 + dz) * CHUNK_SIZE, dx * dx + dz * dz)
        }
      }
    }
  }

  update(SPAWN_X, SPAWN_Z)

  let prevCX = null, prevCZ = null
  scene.onBeforeRenderObservable.add(() => {
    if (!scene.activeCamera) return
    for (let i = 0; i < QUEUE_BATCH && buildQueue.length; i++) {
      const { key, ox, oz } = buildQueue.shift()
      if (!chunks.has(key)) chunks.set(key, spawnChunkGrass(masters, ox, oz, verts))
    }
    // one push per grass type - each type gets its own ShaderMaterial
    // (grassMat_0, grassMat_1, ...), and a uniform set on one does not reach
    // the others, so a single call here would leave all but one type unfogged
    const windTime = (performance.now() - windStart) / 1000
    for (const { master } of masters) {
      syncFogUniforms(master.material, scene, scene.activeCamera.position)
      master.material.setFloat('uWindTime', windTime)
    }

    const { x, z } = scene.activeCamera.position
    const cx = Math.floor(x / CHUNK_SIZE)
    const cz = Math.floor(z / CHUNK_SIZE)
    if (cx !== prevCX || cz !== prevCZ) {
      prevCX = cx; prevCZ = cz
      update(x, z)
    }
  })
}
