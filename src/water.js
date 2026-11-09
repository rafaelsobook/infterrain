import { Mesh, MeshBuilder, ShaderMaterial, VertexData, Vector3, Color3 } from '@babylonjs/core'
import { WATER_LEVEL, terrainHeight, riverStrength } from './world'
import { riverCenterX, riverProfileAt } from './river'
import { drawnHeight } from './ground'
import { FOG_UNIFORM_NAMES, FOG_UNIFORMS_GLSL, FOG_FACTOR_GLSL, syncFogUniforms } from './fog'

// ── Lakes ─────────────────────────────────────────────────────────────────
//
// Every hollow in the land below WATER_LEVEL holds water. This used to be one
// 12km plane following the camera, which is right for the horizon and wrong
// at every shore: the terrain mesh is a 16-unit grid of flat triangles, so the
// plane met the ground in long straight polygon edges, and wherever the
// ground lay within a hair of the waterline the two fought for the depth
// buffer and the water flickered on top of the bank.
//
// So the water is now two things:
//
//   near   per-chunk patches over the hollows within NEAR_R of the camera,
//          each vertex knowing how deep the water is over the ground AS DRAWN
//          (the chunk's own triangles, not the ideal curve). The shader fades
//          out exactly where that depth reaches zero, so the shoreline is the
//          true line where water meets ground, soft, with a rim of scum on it.
//          The patch grid is half the terrain's, split along the same diagonal,
//          so that depth is exact everywhere, not just at its vertices
//   far    the old plane, beyond NEAR_R only, filling the horizon where the
//          shore is too far off and fogged to matter
//
// Both fog through fog.js like the terrain does. The plane used to apply its
// own LINEAR fog from fogStart/fogEnd, which a host using EXP fog (the vessel
// openworld does) never sets - so distant lakes fogged at a different rate
// from the land around them and stood out of it.
//
// NOTE ON GLSL COMMENTS: none may contain a semicolon - see fog.js.

const LOG_PREFIX = '[infterrain]'
const CHUNK_SIZE = 256
// the near patches cover this far from the camera, the plane everything past
// it. The camera is always inside the middle chunk of the 3x3 the patches are
// built for, so a 250 circle around it is always covered
const NEAR_R = 250
const LATTICE = 8
const FAR_SIZE = 12000

const SHARED_FRAG_TOP = /* glsl */`
  precision highp float;
  uniform float uTime;
  uniform vec3  sunDir;
  uniform vec3  sunColor;
  uniform float uNearR;
${FOG_UNIFORMS_GLSL}
${FOG_FACTOR_GLSL}

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  vec3 swampColor(vec3 wpos, out float ripple) {
    float r1 = sin(wpos.x * 0.18 + uTime * 0.9) * sin(wpos.z * 0.22 + uTime * 0.7);
    float r2 = sin(wpos.x * 0.11 - uTime * 0.6) * sin(wpos.z * 0.13 + uTime * 1.1);
    ripple = (r1 + r2) * 0.5;
    vec3 deep    = vec3(0.05, 0.14, 0.09);
    vec3 shallow = vec3(0.16, 0.28, 0.14);
    vec3 col = mix(deep, shallow, clamp(ripple * 0.5 + 0.5, 0.0, 1.0));
    vec3 viewDir = normalize(uCamPos - wpos);
    vec3 nrm = normalize(vec3(ripple * 0.08, 1.0, ripple * 0.06));
    vec3 halfV   = normalize(normalize(sunDir) + viewDir);
    float spec   = pow(max(dot(nrm, halfV), 0.0), 80.0);
    col += vec3(0.75, 0.80, 0.62) * spec * 0.3;
    float bright = clamp(length(sunColor) * 1.4, 0.25, 1.0);
    return col * bright;
  }
`

const NEAR_VERT = /* glsl */`
  precision highp float;
  attribute vec3 position;
  attribute float aDepth;
  uniform mat4 worldViewProjection;
  varying vec3 vWorld;
  varying float vDepth;
  void main() {
    vWorld = position;
    vDepth = aDepth;
    gl_Position = worldViewProjection * vec4(position, 1.0);
  }
`

const NEAR_FRAG = SHARED_FRAG_TOP + /* glsl */`
  varying vec3 vWorld;
  varying float vDepth;
  void main() {
    if (length(vWorld.xz - uCamPos.xz) > uNearR) discard;
    if (vDepth <= 0.0) discard;
    float ripple;
    vec3 col = swampColor(vWorld, ripple);
    // scum along the waterline - pond weed and froth collected at the edge,
    // broken up so it never reads as a drawn outline
    float n = vnoise(vWorld.xz * 0.45 + vec2(uTime * 0.05, 0.0)) * 0.6 + vnoise(vWorld.xz * 1.9) * 0.4;
    float rim = (1.0 - smoothstep(0.0, 0.9, vDepth)) * smoothstep(0.45, 0.9, n);
    col = mix(col, vec3(0.26, 0.33, 0.15), rim * 0.45);
    float a = smoothstep(0.0, 0.8, vDepth) * 0.9;
    a = max(a, rim * 0.5 * smoothstep(0.0, 0.12, vDepth));
    col = mix(col, uFogColor, fogFactor(vWorld));
    gl_FragColor = vec4(col, a);
  }
`

const FAR_VERT = /* glsl */`
  precision highp float;
  attribute vec3 position;
  uniform mat4 worldViewProjection;
  uniform mat4 world;
  varying vec3 vWorld;
  void main() {
    vWorld = (world * vec4(position, 1.0)).xyz;
    gl_Position = worldViewProjection * vec4(position, 1.0);
  }
`

const FAR_FRAG = SHARED_FRAG_TOP + /* glsl */`
  varying vec3 vWorld;
  void main() {
    if (length(vWorld.xz - uCamPos.xz) <= uNearR) discard;
    float ripple;
    vec3 col = swampColor(vWorld, ripple);
    col = mix(col, uFogColor, fogFactor(vWorld));
    gl_FragColor = vec4(col, 0.88);
  }
`

function waterMaterial(scene, name, vert, frag, attributes) {
  const mat = new ShaderMaterial(name, scene,
    { vertexSource: vert, fragmentSource: frag },
    {
      attributes,
      uniforms: ['worldViewProjection', 'world', 'uTime', 'sunDir', 'sunColor', 'uNearR', ...FOG_UNIFORM_NAMES],
      needAlphaBlending: true,
    })
  mat.setVector3('sunDir', new Vector3(0.4, 1, 0.3).normalize())
  mat.setColor3('sunColor', new Color3(1, 0.98, 0.88))
  mat.setFloat('uTime', 0)
  mat.setFloat('uNearR', NEAR_R)
  mat.backFaceCulling = false
  return mat
}

// lake water stays out of the river's own channel - the river carries its
// own surface (rivermesh.js), and a second sheet under it would show through
function inRiverBed(x, z) {
  const off = Math.abs(x - riverCenterX(z))
  if (off > 120) return false
  const p = riverProfileAt(z)
  return off < p.halfWidth + 6 && riverStrength(x, z) > 0.15
}

function buildLakeChunk(scene, mat, ox, oz, step) {
  const n = CHUNK_SIZE / LATTICE + 1
  const ground = (x, z) => drawnHeight(x, z, step)

  // cheap reject first: nothing in this chunk near the waterline
  let any = false
  for (let gz = Math.floor(oz / step); gz <= Math.ceil((oz + CHUNK_SIZE) / step) && !any; gz++)
    for (let gx = Math.floor(ox / step); gx <= Math.ceil((ox + CHUNK_SIZE) / step) && !any; gx++)
      if (terrainHeight(gx * step, gz * step) < WATER_LEVEL + 0.5) any = true
  if (!any) return null

  const depth = new Float32Array(n * n)
  for (let iz = 0; iz < n; iz++)
    for (let ix = 0; ix < n; ix++) {
      const x = ox + ix * LATTICE, z = oz + iz * LATTICE
      depth[iz * n + ix] = inRiverBed(x, z) ? -1 : WATER_LEVEL - ground(x, z)
    }

  const positions = [], depths = [], indices = []
  const index = new Map()
  const vert = (ix, iz) => {
    const k = iz * n + ix
    let i = index.get(k)
    if (i === undefined) {
      i = positions.length / 3
      positions.push(ox + ix * LATTICE, WATER_LEVEL, oz + iz * LATTICE)
      depths.push(depth[k])
      index.set(k, i)
    }
    return i
  }
  for (let iz = 0; iz < n - 1; iz++)
    for (let ix = 0; ix < n - 1; ix++) {
      const d00 = depth[iz * n + ix], d10 = depth[iz * n + ix + 1]
      const d01 = depth[(iz + 1) * n + ix], d11 = depth[(iz + 1) * n + ix + 1]
      if (Math.max(d00, d10, d01, d11) <= 0) continue
      const a = vert(ix, iz), b = vert(ix + 1, iz), c = vert(ix, iz + 1), d = vert(ix + 1, iz + 1)
      // the terrain's own diagonal, so depth interpolates exactly as the
      // ground under it does
      indices.push(a, b, c, b, d, c)
    }
  if (!indices.length) return null

  const vd = new VertexData()
  vd.positions = positions
  vd.indices = indices
  vd.normals = new Float32Array(positions.length).map((_, i) => i % 3 === 1 ? 1 : 0)
  const mesh = new Mesh('water', scene)
  vd.applyToMesh(mesh)
  mesh.setVerticesData('aDepth', new Float32Array(depths), false, 1)
  mesh.material = mat
  mesh.isPickable = false
  mesh.alphaIndex = 0
  return mesh
}

/**
 * The lakes: soft-shored water over every hollow near the camera, and a plane
 * to the horizon beyond. `verts` must match the terrain's, so the shoreline is
 * computed against the ground that is actually drawn.
 *
 * Returns { far, chunks, dispose } - `far` is the horizon plane mesh, named
 * 'water' as the single plane always was; the near patches are named 'water'
 * too, so a host skipping that name (picking, placement) skips all of it.
 */
export function createWater(scene, options = {}) {
  const { verts = 17, viewRadius = 1 } = options
  if (!scene) {
    console.error(`${LOG_PREFIX} createWater() called without a scene - water will not render`)
    return null
  }
  const step = CHUNK_SIZE / (verts - 1)

  const far = MeshBuilder.CreateGround('water', { width: FAR_SIZE, height: FAR_SIZE, subdivisions: 1 }, scene)
  far.position.y = WATER_LEVEL
  far.isPickable = false
  // always sorted first among transparent meshes, so it can never be drawn
  // after - and paint over - anything else transparent in the scene
  far.alphaIndex = 0
  const farMat = waterMaterial(scene, 'waterMat', FAR_VERT, FAR_FRAG, ['position'])
  farMat.needDepthPrePass = true
  far.material = farMat

  const nearMat = waterMaterial(scene, 'lakeMat', NEAR_VERT, NEAR_FRAG, ['position', 'aDepth'])
  const chunks = new Map()
  const queue = []

  function update(camX, camZ) {
    const cx0 = Math.floor(camX / CHUNK_SIZE), cz0 = Math.floor(camZ / CHUNK_SIZE)
    for (const [key, mesh] of chunks) {
      const [cx, cz] = key.split(',').map(Number)
      if (Math.abs(cx - cx0) > viewRadius + 1 || Math.abs(cz - cz0) > viewRadius + 1) {
        mesh?.dispose()
        chunks.delete(key)
      }
    }
    queue.length = 0
    for (let dz = -viewRadius; dz <= viewRadius; dz++)
      for (let dx = -viewRadius; dx <= viewRadius; dx++) {
        const key = `${cx0 + dx},${cz0 + dz}`
        if (!chunks.has(key)) queue.push({ key, ox: (cx0 + dx) * CHUNK_SIZE, oz: (cz0 + dz) * CHUNK_SIZE, d: dx * dx + dz * dz })
      }
    queue.sort((a, b) => a.d - b.d)
  }

  let t = 0, prevCX = null, prevCZ = null
  const obs = scene.onBeforeRenderObservable.add(() => {
    t += scene.getEngine().getDeltaTime() * 0.001
    const cam = scene.activeCamera
    if (!cam) return
    for (const mat of [farMat, nearMat]) {
      mat.setFloat('uTime', t)
      syncFogUniforms(mat, scene, cam.position)
    }
    syncWaterLight(scene, farMat, nearMat)
    far.position.x = cam.position.x
    far.position.z = cam.position.z
    const cx = Math.floor(cam.position.x / CHUNK_SIZE), cz = Math.floor(cam.position.z / CHUNK_SIZE)
    if (cx !== prevCX || cz !== prevCZ) { prevCX = cx; prevCZ = cz; update(cam.position.x, cam.position.z) }
    // two a frame - a patch costs a few hundred terrain samples
    for (let i = 0; i < 2 && queue.length; i++) {
      const { key, ox, oz } = queue.shift()
      if (!chunks.has(key)) chunks.set(key, buildLakeChunk(scene, nearMat, ox, oz, step))
    }
  })

  return {
    far,
    chunks,
    dispose() {
      scene.onBeforeRenderObservable.remove(obs)
      for (const m of chunks.values()) m?.dispose()
      chunks.clear()
      far.dispose()
      farMat.dispose()
      nearMat.dispose()
    },
  }
}

// the sun's direction and strength from the host's real lights - the water
// used to keep a fixed imaginary sun, and stayed as bright at midnight
function syncWaterLight(scene, ...mats) {
  let sun = null
  for (const light of scene.lights) {
    if (!light.isEnabled() || light.getClassName?.() !== 'DirectionalLight') continue
    if (!sun || light.intensity > sun.intensity) sun = light
  }
  if (!sun) return
  const dir = sun.direction.negate().normalize()
  const col = sun.diffuse.scale(sun.intensity * 1.6)
  for (const m of mats) { m.setVector3('sunDir', dir); m.setColor3('sunColor', col) }
}
