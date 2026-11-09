import { Mesh, VertexData, ShaderMaterial, Texture, Vector3 } from '@babylonjs/core'
import { terrainHeight, roadDistance, SPAWN_X, SPAWN_Z, WATER_LEVEL, inRiverChannel } from './world'
import { sampleTerrainSurfaceHeight, syncTerrainLighting } from './terrain'
import { inSiteFootprint } from './sites'
import { FOG_UNIFORM_NAMES, FOG_UNIFORMS_GLSL, FOG_FACTOR_GLSL, syncFogUniforms } from './fog'

// ── Landmarks scattered over the open world ───────────────────────────────
//
// Mountains, volcanoes and hills as PLACED MESHES, streamed per chunk exactly
// the way createOpenWorldGrass streams its cards. This deliberately does not
// touch terrainHeight: it is decoration standing on the ground, not a change
// to the ground, so it composes with an existing world instead of replacing
// its shape. That also means it can be added to, or removed from, a running
// project without every height query in the host changing underneath it.
//
// Each landmark is a radial mesh built from a per-kind silhouette profile plus
// circular ridge noise. Several distinct masters are built per entry and
// instanced, which is what keeps this affordable - a unique mesh per landmark
// would be the obvious approach and would also mean a new draw call and a new
// vertex buffer for every hill in view.
//
// NOTE ON GLSL COMMENTS: no comment in the shader strings may contain a
// semicolon. Babylon's preprocessor splits source on ";" and would cut such a
// comment in half, emitting the remainder as bare code. A failed shader
// compile logs but does not throw, so the only symptom is geometry silently
// not drawing. See fog.js's own note.

const LOG_PREFIX = '[infterrain]'
const CHUNK_SIZE = 256

// Named size tiers, same idea as grass.js's SIZE_SCALE but a much gentler
// spread - these shapes are already large in world units, so grass's 0.6/1.4/3.0
// would put a "large" mountain 200 units into the sky.
const SIZE_SCALE = { small: 0.65, medium: 1.0, large: 1.6 }

// Per-kind silhouette and footprint, in world units before SIZE_SCALE.
//   radius       footprint radius at the base
//   height       apex height above the ground it stands on
//   fall         how the height falls away from the apex - higher is a
//                sharper peak, lower is a broader shoulder
//   rough        how strongly the circular ridge noise bites, as a fraction
//                of the radius. A hill is smooth, a mountain is ridged
//   craterT      volcano only - where the crater rim sits, as a fraction of
//                the footprint radius
//   craterDepth  volcano only - how far the crater floor drops below the rim,
//                as a fraction of the height
const KIND_SHAPE = {
  mountain: { radius: 52, height: 68, fall: 1.6, rough: 0.20 },
  volcano:  { radius: 60, height: 46, fall: 1.3, rough: 0.11, craterT: 0.22, craterDepth: 0.30 },
  hill:     { radius: 30, height: 13, fall: 2.0, rough: 0.13 },
}

// distinct meshes built per entry. Instances then pick one by hash, so a
// hillside of ten hills is ten silhouettes rather than one repeated
const VARIANTS_PER_TYPE = 3
const RINGS    = 16
const SEGMENTS = 28
// how far the base is sunk into the ground, as a fraction of its radius. The
// terrain underneath is not flat, so a mesh set exactly on the surface shows
// daylight under its uphill side
const SINK = 0.06

function hash(a, b, seed) {
  let v = (seed * 1234567 + a * 374761393 + b * 668265263) | 0
  v = Math.imul(v ^ (v >>> 13), 1274126177)
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296
}

// Placement runs per chunk, forever, so anything worth saying about a bad
// configuration would otherwise be said thousands of times. Said once instead.
const warned = new Set()
function warnOnce(key, message) {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`${LOG_PREFIX} ${message}`)
}

const VERT = /* glsl */`
  precision highp float;
  attribute vec3 position;
  attribute vec3 normal;
  attribute vec2 uv;
  attribute float aGlow;
  attribute vec4 world0;
  attribute vec4 world1;
  attribute vec4 world2;
  attribute vec4 world3;
  uniform mat4 viewProjection;
  varying vec2 vUV;
  varying vec3 vNorm;
  varying vec3 vWorldPos;
  varying float vGlow;
  void main() {
    mat4 instanceWorld = mat4(world0, world1, world2, world3);
    vec4 worldPos = instanceWorld * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    // mat3 of the instance matrix rather than a real inverse-transpose. Every
    // instance is scaled uniformly in X and Z and only mildly stretched in Y,
    // so the error is a slight shading shift on a matte rock face rather than
    // anything visible
    vNorm = normalize(mat3(instanceWorld) * normal);
    vUV = uv;
    vGlow = aGlow;
    gl_Position = viewProjection * worldPos;
  }
`

// sunDir/sunColor/ambientColor are named to match terrain.js's own uniforms on
// purpose - syncTerrainLighting pushes the host scene's real lights into any
// material declaring them, so landmarks are lit by the same sun as the ground
// they stand on instead of a second imaginary one
const FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D diffuseSampler;
  uniform vec3  sunDir;
  uniform vec3  sunColor;
  uniform vec3  ambientColor;
  uniform float uSnow;
  uniform float uGlowStrength;
  uniform float uTime;
${FOG_UNIFORMS_GLSL}
${FOG_FACTOR_GLSL}
  varying vec2 vUV;
  varying vec3 vNorm;
  varying vec3 vWorldPos;
  varying float vGlow;

  void main() {
    vec3 alb = texture2D(diffuseSampler, vUV).rgb;

    // darken the steep faces and lighten what faces the sky, so the ridge
    // noise actually reads as relief instead of a flat wrap of texture
    float up = clamp(vNorm.y, 0.0, 1.0);
    alb *= mix(0.72, 1.08, up);

    // snow gathers on the high, flat-ish parts. uSnow is 0 for kinds that
    // should never have any, so a hill stays green
    float snow = smoothstep(0.55, 0.9, up) * uSnow;
    alb = mix(alb, vec3(0.90, 0.92, 0.96), snow);

    float lambert = dot(vNorm, normalize(sunDir)) * 0.42 + 0.58;
    vec3 col = alb * (sunColor * lambert + ambientColor);

    // volcano crater. vGlow is zero everywhere on the other kinds, so this
    // costs nothing but a multiply for them
    float pulse = 0.78 + 0.22 * sin(uTime * 1.7);
    col += vec3(1.0, 0.34, 0.06) * vGlow * uGlowStrength * pulse;

    gl_FragColor = vec4(mix(col, uFogColor, fogFactor(vWorldPos)), 1.0);
  }
`

// Circular ridge noise - one value per radial segment, wrapping exactly so the
// seam where the mesh closes on itself cannot show. Built as a smoothed random
// walk around the ring rather than sampled from 2D noise, because only a
// genuinely periodic source closes seamlessly.
function ridgeRing(seed, lobes) {
  const raw = new Float32Array(SEGMENTS)
  for (let s = 0; s < SEGMENTS; s++) {
    // two frequencies: a few big lobes for the overall shape, plus per-segment
    // detail for the smaller ridges between them
    const ang = (s / SEGMENTS) * Math.PI * 2
    const big = Math.sin(ang * lobes + hash(seed, lobes, 11) * 6.283) * 0.5 + 0.5
    raw[s] = big * 0.65 + hash(s, seed, 12) * 0.35
  }
  // circular 1-2-1 blur so neighbouring segments agree and the surface is
  // ridged rather than spiky
  const out = new Float32Array(SEGMENTS)
  for (let s = 0; s < SEGMENTS; s++) {
    const p = raw[(s - 1 + SEGMENTS) % SEGMENTS]
    const n = raw[(s + 1) % SEGMENTS]
    out[s] = (p + raw[s] * 2 + n) / 4
  }
  return out
}

/** Height and radius of a kind's silhouette at t (0 apex, 1 base). */
function profileAt(kind, shape, t) {
  if (kind === 'volcano') {
    const ct = shape.craterT
    if (t <= ct) {
      // inside the crater - drops from the rim down to the floor
      const k = t / ct
      const y = shape.height - shape.height * shape.craterDepth * (1 - k * k)
      return { r: shape.radius * t, y, glow: 1 - k * k }
    }
    const s = (t - ct) / (1 - ct)
    return { r: shape.radius * t, y: shape.height * Math.pow(1 - s, shape.fall), glow: 0 }
  }
  return { r: shape.radius * t, y: shape.height * Math.pow(1 - t, shape.fall), glow: 0 }
}

function buildLandmarkMaster(scene, kind, type, idx, variant, mat) {
  const shape = KIND_SHAPE[kind]
  const ring = ridgeRing(idx * 977 + variant * 131 + 7, 3 + Math.floor(hash(idx, variant, 21) * 4))
  const rows = RINGS + 1

  const positions = new Float32Array(rows * SEGMENTS * 3)
  const uvs       = new Float32Array(rows * SEGMENTS * 2)
  const glows     = new Float32Array(rows * SEGMENTS)
  let pi = 0, ui = 0, gi = 0

  for (let r = 0; r < rows; r++) {
    const t = r / RINGS
    const { r: rad, y, glow } = profileAt(kind, shape, t)
    for (let s = 0; s < SEGMENTS; s++) {
      const ang = (s / SEGMENTS) * Math.PI * 2
      // noise scaled by t so the apex stays a single point and the base is
      // where the silhouette is most broken up
      const n = (ring[s] - 0.5) * shape.rough * shape.radius * t
      const rr = rad + n
      positions[pi++] = Math.cos(ang) * rr
      positions[pi++] = y + (ring[s] - 0.5) * shape.height * shape.rough * 0.35 * t * (1 - t)
      positions[pi++] = Math.sin(ang) * rr
      // tiled so the texture reads at rock scale rather than being stretched
      // once over the whole flank
      uvs[ui++] = (s / SEGMENTS) * 6
      uvs[ui++] = t * 4
      glows[gi++] = glow
    }
  }

  const indices = []
  for (let r = 0; r < RINGS; r++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const s2 = (s + 1) % SEGMENTS
      const a = r * SEGMENTS + s,  b = r * SEGMENTS + s2
      const c = (r + 1) * SEGMENTS + s, d = (r + 1) * SEGMENTS + s2
      indices.push(a, c, b, b, c, d)
    }
  }

  const vd = new VertexData()
  vd.positions = positions
  vd.indices   = indices
  vd.uvs       = uvs
  const normals = []
  VertexData.ComputeNormals(positions, indices, normals)
  vd.normals = normals

  const master = new Mesh(`master_${kind}_${idx}_${variant}`, scene)
  vd.applyToMesh(master)
  master.setVerticesData('aGlow', glows, false, 1)
  master.material   = mat
  master.isVisible  = false
  master.isPickable = false
  return master
}

function buildMaterial(scene, kind, type, idx) {
  const mat = new ShaderMaterial(`landmarkMat_${kind}_${idx}`, scene, {
    vertexSource: VERT, fragmentSource: FRAG,
  }, {
    attributes: ['position', 'normal', 'uv', 'aGlow', 'world0', 'world1', 'world2', 'world3'],
    uniforms:   ['viewProjection', 'sunDir', 'sunColor', 'ambientColor', 'uSnow', 'uGlowStrength', 'uTime', ...FOG_UNIFORM_NAMES],
    samplers:   ['diffuseSampler'],
  })

  const path = type.texturePath
  if (path) {
    const tex = new Texture(path, scene)
    tex.wrapU = Texture.WRAP_ADDRESSMODE
    tex.wrapV = Texture.WRAP_ADDRESSMODE
    mat.setTexture('diffuseSampler', tex)
  } else {
    console.warn(`${LOG_PREFIX} createMountainsInOpenWorld: entry ${idx} (${kind}) has no texture path - it will render untextured`)
  }

  // defaults terrain.js's own syncTerrainLighting will overwrite every frame
  // from the host's real lights, so a scene with none still renders lit
  mat.setVector3('sunDir', new Vector3(0.4, 1, 0.3).normalize())
  mat.setFloat('uSnow', type.snow ?? (kind === 'mountain' ? 1 : 0))
  mat.setFloat('uGlowStrength', type.glow ?? (kind === 'volcano' ? 1 : 0))
  mat.setFloat('uTime', 0)
  mat.backFaceCulling = true
  return mat
}

// Which kind an entry describes, read from whichever texture key it carries.
// "moutain" is accepted alongside "mountain" because that is the spelling the
// call site was written with - a typo that silently placed nothing would be a
// miserable thing to debug.
const KIND_KEYS = [
  ['mountain', ['mountaintexturePath', 'moutaintexturePath', 'mountainTexturePath', 'moutainTexturePath']],
  ['volcano',  ['volcanotexturePath', 'volcanoTexturePath']],
  ['hill',     ['hillstexturePath', 'hilltexturePath', 'hillsTexturePath', 'hillTexturePath']],
]

function readEntry(entry, idx) {
  if (!entry || typeof entry !== 'object') {
    console.warn(`${LOG_PREFIX} createMountainsInOpenWorld: entry ${idx} is not an object - skipped`)
    return null
  }
  if (entry.kind && KIND_SHAPE[entry.kind]) {
    return { kind: entry.kind, texturePath: entry.texturePath ?? null, ...entry }
  }
  for (const [kind, keys] of KIND_KEYS) {
    for (const k of keys) {
      if (entry[k]) return { ...entry, kind, texturePath: entry[k] }
    }
  }
  console.warn(`${LOG_PREFIX} createMountainsInOpenWorld: entry ${idx} has no recognised texture key ` +
    `(expected one of mountaintexturePath / volcanotexturePath / hillstexturePath) - skipped`)
  return null
}

/**
 * Pick one entry of this kind, weighted by each entry's own qnty.
 *
 * qnty is a WEIGHT here, not a count: how many land per chunk is decided by
 * counts.mountainPerChunk and friends, so the two numbers cannot contradict
 * each other. With one entry per kind, which is the common case, the weight
 * never matters.
 */
function pickEntry(pool, roll) {
  if (pool.length === 1) return pool[0]
  const total = pool.reduce((sum, p) => sum + p.weight, 0)
  let r = roll * total
  for (const p of pool) { r -= p.weight; if (r < 0) return p }
  return pool[pool.length - 1]
}

/** Lowest ground under the whole footprint, so nothing is left floating. */
function groundUnder(wx, wz, radius, verts) {
  let lo = sampleTerrainSurfaceHeight(wx, wz, verts)
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    lo = Math.min(lo, sampleTerrainSurfaceHeight(wx + Math.cos(a) * radius, wz + Math.sin(a) * radius, verts))
  }
  return lo
}

function spawnChunkLandmarks(pools, counts, ox, oz, verts) {
  const insts = []
  // every landmark already placed in THIS chunk, so two do not grow out of
  // each other. Cross-chunk overlap is prevented instead by insetting
  // placement from the chunk edge by the footprint radius, which needs no
  // knowledge of neighbours that may not be built yet
  const placed = []

  const KINDS = [
    ['mountain', counts.mountainPerChunk],
    ['volcano',  counts.volcanoPerChunk],
    ['hill',     counts.hillsPerChunk],
  ]

  for (const [kind, wantRaw] of KINDS) {
    const pool = pools[kind]
    if (!pool || !pool.length) continue
    const want = Math.max(0, wantRaw | 0)
    // tries, not placements - most rejections are legitimate (a road, the
    // river, a cliff), and without a cap a chunk with nowhere valid would
    // spin here every time it streamed in
    const maxTries = want * 20
    let got = 0

    for (let attempt = 0; attempt < maxTries && got < want; attempt++) {
      const a = ox + attempt * 7919 + kind.length * 104729
      const b = oz + attempt * 6271 + kind.length * 15485863

      const entry = pickEntry(pool, hash(a, b, 31))
      const variant = Math.floor(hash(a, b, 32) * VARIANTS_PER_TYPE) % VARIANTS_PER_TYPE
      const jitter = 0.78 + hash(a, b, 33) * 0.44
      const scale = entry.scale * jitter
      const radius = KIND_SHAPE[kind].radius * scale

      // inset so a footprint cannot cross into the neighbouring chunk
      const inset = Math.min(radius, CHUNK_SIZE * 0.45)
      const span = CHUNK_SIZE - inset * 2
      if (span <= 0) {
        warnOnce(`${kind}-too-big`,
          `createMountainsInOpenWorld: a ${entry.size ?? 'medium'} ${kind} has a ${radius.toFixed(0)}-unit ` +
          `footprint, which does not fit inside a ${CHUNK_SIZE}-unit chunk - none will be placed. Use a smaller size.`)
        break
      }
      const wx = ox + inset + hash(a, b, 34) * span
      const wz = oz + inset + hash(a, b, 35) * span

      // nothing should land on a road, in the river, in the sea, or on top of
      // the spawn hub
      if (roadDistance(wx, wz) < radius * 0.8) continue
      if (inRiverChannel(wx, wz, radius * 0.8)) continue
      if (Math.hypot(wx - SPAWN_X, wz - SPAWN_Z) < 420 + radius) continue
      // a landmark standing on a well or a waterfall's pool would bury it
      if (inSiteFootprint(wx, wz, radius)) continue
      const hRaw = terrainHeight(wx, wz)
      if (hRaw < WATER_LEVEL + 2) continue

      // a steep site would leave the base hanging on the downhill side no
      // matter how far it is sunk
      const step = Math.max(4, radius * 0.5)
      const hX = terrainHeight(wx + step, wz)
      const hZ = terrainHeight(wx, wz + step)
      const slope = Math.hypot((hX - hRaw) / step, (hZ - hRaw) / step)
      if (slope > 0.42) continue

      // How far apart two of these have to be.
      //
      // Ideally they do not touch at all. But a chunk is only 256 units, and
      // asking for ten large hills means ten 96-unit footprints that simply
      // cannot all fit without touching - honouring the ideal there quietly
      // delivered 1.5 hills instead of 10, which is a worse answer than
      // letting them overlap. So the requirement relaxes to whatever an even
      // share of the chunk allows, floored so they can never stack almost on
      // top of each other. Overlapping hills read as a ridge and overlapping
      // mountains as a range, which is what real ones do anyway.
      const fairSep = Math.sqrt((span * span) / Math.max(1, want)) * 0.9
      const minSep = Math.max(radius * 0.55, Math.min((radius * 2) * 0.92, fairSep))
      let clash = false
      for (const p of placed) {
        if (Math.hypot(p.x - wx, p.z - wz) < Math.max(minSep, (p.r + radius) * 0.55)) { clash = true; break }
      }
      if (clash) continue

      const hGround = groundUnder(wx, wz, radius, verts)
      // instanced off whichever ENTRY won the weighted pick, not just the
      // variant index - two entries of the same kind have their own textures
      // and therefore their own masters
      const inst = entry.masters[variant].createInstance(`${kind}_${ox}_${oz}_${got}`)
      // Y is stretched independently so two instances of one master do not
      // read as the same object twice. X and Z stay equal, which keeps the
      // footprint circular and the vertex shader's normal approximation good
      inst.scaling.set(scale, scale * (0.82 + hash(a, b, 36) * 0.5), scale)
      inst.position.set(wx, hGround - KIND_SHAPE[kind].radius * scale * SINK, wz)
      inst.rotation.y = hash(a, b, 37) * Math.PI * 2
      inst.isPickable = false
      insts.push(inst)
      placed.push({ x: wx, z: wz, r: radius })
      got++
    }

    noteFit(kind, want, got, pool[0]?.scale ?? 1)
  }
  return insts
}

// A silent shortfall looks like the feature is broken rather than the request
// being impossible, so it is worth reporting - but only once, and only when it
// is real. A single chunk falling short means nothing (it may just have had a
// road or the river through it), so this judges the AVERAGE over a decent
// sample of chunks before saying anything.
const FIT_SAMPLE = 16
const FIT_THRESHOLD = 0.7
const fitStats = new Map()
function noteFit(kind, want, got, scale) {
  if (want <= 0) return
  let s = fitStats.get(kind)
  if (!s) { s = { chunks: 0, want: 0, got: 0, scale }; fitStats.set(kind, s) }
  if (s.chunks > FIT_SAMPLE) return
  s.chunks++; s.want += want; s.got += got
  if (s.chunks !== FIT_SAMPLE) return
  const ratio = s.got / s.want
  if (ratio >= FIT_THRESHOLD) return
  const across = (KIND_SHAPE[kind].radius * scale * 2).toFixed(0)
  warnOnce(`${kind}-shortfall`,
    `createMountainsInOpenWorld: asked for ${(s.want / s.chunks).toFixed(1)} ${kind}(s) per chunk, ` +
    `fitting ${(s.got / s.chunks).toFixed(1)} on average. Each is about ${across} units across and a chunk is ` +
    `${CHUNK_SIZE} - lower the count, or use a smaller size.`)
}

/**
 * Scatter mountains, volcanoes and hills across the open world as meshes.
 *
 * Streams per chunk exactly the way createOpenWorldGrass does, and like it,
 * does NOT build or alter terrain - these stand on whatever ground is already
 * there.
 *
 *   counts   { mountainPerChunk, volcanoPerChunk, hillsPerChunk } - how many
 *            of each kind land in every loaded 256x256 chunk. Not a world
 *            total: the world streams infinitely, so there is no total.
 *   types    [{ mountaintexturePath | volcanotexturePath | hillstexturePath,
 *              qnty, size }]
 *            The texture key is what says which kind the entry describes.
 *            `size` is "small" | "medium" | "large". `qnty` is a relative
 *            WEIGHT used only when several entries share one kind - see
 *            pickEntry. Optional per-entry `snow` and `glow` (0..1) override
 *            the defaults, which are snow on mountains and lava in volcano
 *            craters.
 *   options  { viewRadius, unloadRadius, verts } - `verts` must match what was
 *            passed to createOpenWorld()/createInfiniteTerrain(), or landmarks
 *            ground against a surface that is not the one being drawn.
 */
export async function createMountainsInOpenWorld(scene, counts = {}, types = [], options = {}) {
  if (!scene) {
    console.error(`${LOG_PREFIX} createMountainsInOpenWorld() called without a scene - nothing will render`)
    return null
  }
  const { viewRadius = 1, unloadRadius, verts = 17 } = options
  const VIEW_R   = viewRadius
  const UNLOAD_R = unloadRadius ?? (viewRadius + 1)

  const pools = { mountain: [], volcano: [], hill: [] }
  ;(types ?? []).forEach((raw, idx) => {
    const entry = readEntry(raw, idx)
    if (!entry) return
    const scale = SIZE_SCALE[entry.size] ?? SIZE_SCALE.medium
    const mat = buildMaterial(scene, entry.kind, entry, idx)
    const masters = []
    for (let v = 0; v < VARIANTS_PER_TYPE; v++) {
      masters.push(buildLandmarkMaster(scene, entry.kind, entry, idx, v, mat))
    }
    pools[entry.kind].push({ ...entry, scale, mat, masters, weight: Math.max(1, entry.qnty | 0) })
  })

  const anyKind = Object.values(pools).some(p => p.length)
  if (!anyKind) {
    console.warn(`${LOG_PREFIX} createMountainsInOpenWorld: no usable entries - nothing to place`)
    return null
  }

  const chunks     = new Map()
  const buildQueue = []
  const QUEUE_BATCH = 2

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

  const allMats = []
  for (const pool of Object.values(pools)) for (const p of pool) allMats.push(p.mat)

  let prevCX = null, prevCZ = null, t = 0
  const obs = scene.onBeforeRenderObservable.add(() => {
    if (!scene.activeCamera) return
    for (let i = 0; i < QUEUE_BATCH && buildQueue.length; i++) {
      const { key, ox, oz } = buildQueue.shift()
      if (!chunks.has(key)) chunks.set(key, spawnChunkLandmarks(pools, counts, ox, oz, verts))
    }

    t += scene.getEngine().getDeltaTime() * 0.001
    // one push per material - each entry gets its own, and a uniform set on
    // one does not reach the others, so a single call would leave all but the
    // first entry unfogged and unlit. Same reasoning grass.js gives.
    for (const mat of allMats) {
      syncFogUniforms(mat, scene, scene.activeCamera.position)
      syncTerrainLighting(mat, scene)
      mat.setFloat('uTime', t)
    }

    const { x, z } = scene.activeCamera.position
    const cx = Math.floor(x / CHUNK_SIZE)
    const cz = Math.floor(z / CHUNK_SIZE)
    if (cx !== prevCX || cz !== prevCZ) {
      prevCX = cx; prevCZ = cz
      update(x, z)
    }
  })

  return {
    chunks,
    pools,
    dispose() {
      scene.onBeforeRenderObservable.remove(obs)
      for (const insts of chunks.values()) insts.forEach(i => i.dispose())
      chunks.clear()
      for (const pool of Object.values(pools)) {
        for (const p of pool) {
          p.masters.forEach(m => m.dispose())
          p.mat.dispose()
        }
      }
    },
  }
}
