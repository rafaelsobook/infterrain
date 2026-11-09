import { Mesh, VertexData, ShaderMaterial, Vector3 } from '@babylonjs/core'
import { riverSurfaceY, riverStrength } from './world'
import { riverCenterX, riverProfileAt, getTerrainStep } from './river'
import { drawnHeight } from './ground'
import { FOG_UNIFORM_NAMES, FOG_UNIFORMS_GLSL, FOG_FACTOR_GLSL, syncFogUniforms } from './fog'

// ── The river's water surface ─────────────────────────────────────────────
//
// A ribbon that follows the centreline, streamed in chunks along Z the same
// way terrain.js streams its grid - the river is infinite, so there is no
// single mesh that could hold it.
//
// This is separate from water.js's flat sea plane on purpose. That plane sits
// at one global WATER_LEVEL and recentres on the camera every frame, which is
// right for an ocean and impossible for a river: river water has to follow its
// own bed downhill, so its height is a function of Z (world.js's
// riverSurfaceY) rather than a constant.
//
// NOTE ON GLSL COMMENTS: no comment inside the shader strings below may
// contain a semicolon - Babylon's preprocessor splits source on ";" and would
// cut such a comment in half, emitting the remainder as a bare line. A failed
// shader compile logs but does not throw, so the only symptom is water that
// silently does not draw. See fog.js's own note.

const LOG_PREFIX = '[infterrain]'

// matches terrain.js's own CHUNK_SIZE so river chunks stream in step with the
// ground they sit in
const RIVER_CHUNK = 256
// rows of vertices along Z per chunk. The channel meanders and changes width
// continuously, so this is what decides how faithfully the ribbon tracks it -
// 4 units is fine enough that a bend reads as a curve rather than a polyline
const Z_STEP      = 4
// columns across the channel. The cross-section is flat (the surface is level
// across its width by construction), so this only needs enough to let the
// shore alpha fade look smooth
const X_DIV       = 14
// how far off to the side the camera can be before a chunk is not worth
// building. The river sits around x=500 and the player can be kilometres away
// in X, where none of this would be visible
const VIEW_X      = 900
const VIEW_Z      = 2

const VERT = /* glsl */`
  precision highp float;
  attribute vec3 position;
  attribute vec4 aRiver;
  uniform mat4 worldViewProjection;
  varying vec3 vWorld;
  varying vec4 vRiver;
  void main() {
    vWorld = position;
    vRiver = aRiver;
    gl_Position = worldViewProjection * vec4(position, 1.0);
  }
`

// aRiver.x flow speed, .y turbulence, .z 0 at the centreline to 1 at the
// ribbon's outer edge, .w water depth over the DRAWN ground (negative where
// the ribbon runs on under the bank)
const FRAG = /* glsl */`
  precision highp float;
  uniform float uTime;
  uniform vec3  sunDir;
${FOG_UNIFORMS_GLSL}
${FOG_FACTOR_GLSL}
  varying vec3 vWorld;
  varying vec4 vRiver;

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  void main() {
    float flow = vRiver.x;
    float turb = vRiver.y;
    float edge = vRiver.z;
    float depth = vRiver.w;

    // everything scrolls along +Z, which is the direction the river runs.
    // Two layers at different rates so the surface does not read as one
    // sliding texture
    float t = uTime * flow;
    vec2 p1 = vec2(vWorld.x * 0.30, vWorld.z * 0.22 - t * 1.6);
    vec2 p2 = vec2(vWorld.x * 0.13, vWorld.z * 0.09 - t * 0.9);
    float n = vnoise(p1) * 0.6 + vnoise(p2) * 0.4;

    // a still pool should look like glass, a rapid like broken water. Same
    // noise either way, just driven much harder as turbulence rises
    float chop = (n - 0.5) * mix(0.25, 2.4, turb);

    // moving fresh water, deliberately clearer and bluer than water.js's
    // stagnant swamp green so the two never read as the same body of water
    vec3 deep    = vec3(0.04, 0.17, 0.20);
    vec3 shallow = vec3(0.22, 0.42, 0.38);
    // shallow margins and deep middles, so the channel has visible form
    // rather than one flat fill
    float shoal = clamp(depth * 0.45, 0.0, 1.0);
    vec3 col = mix(shallow, deep, shoal);
    col += chop * 0.06;

    // whitewater, concentrated where the flow is broken. Squared so it stays
    // absent on calm stretches instead of greying them out
    float foam = clamp((n - (1.0 - turb * 0.75)) * 3.0, 0.0, 1.0) * turb * turb;
    // and a constant lace of it along the banks, where any real river breaks
    // against its own shore
    foam = max(foam, smoothstep(0.82, 1.0, edge) * turb * 0.5);
    col = mix(col, vec3(0.92, 0.96, 0.95), foam * 0.85);

    // a rippled specular rather than a mirror - the normal is perturbed by
    // the same noise driving the surface, so highlights travel downstream
    vec3 nrm = normalize(vec3(chop * 0.6, 1.0, chop * 0.45));
    vec3 viewDir = normalize(uCamPos - vWorld);
    vec3 halfV   = normalize(sunDir + viewDir);
    float spec   = pow(max(dot(nrm, halfV), 0.0), 60.0);
    col += vec3(0.85, 0.92, 0.88) * spec * mix(0.55, 0.15, turb);

    // a lace of foam where it laps the shore
    foam = max(foam, (1.0 - smoothstep(0.05, 0.6, depth)) * (0.25 + turb * 0.5) * step(0.0, depth));
    col = mix(col, vec3(0.86, 0.92, 0.9), foam * 0.35);

    // fades out at the waterline, where the drawn ground rises through the
    // surface and the depth genuinely goes to zero - this is what gives the
    // river a soft shore instead of a cut edge against the ground. The edge
    // term only matters where the land beside a ford sits below the water
    // and no shore was found - there it fades instead of ending in a wall
    if (depth <= 0.0) discard;
    float a = clamp(depth * 1.6, 0.0, 1.0) * (1.0 - smoothstep(0.88, 1.0, edge));
    a = clamp(a * 0.92 + foam * 0.5 * step(0.0, depth), 0.0, 0.95);

    col = mix(col, uFogColor, fogFactor(vWorld));
    gl_FragColor = vec4(col, a);
  }
`

function createRiverMaterial(scene) {
  const mat = new ShaderMaterial('riverMat', scene,
    { vertexSource: VERT, fragmentSource: FRAG },
    {
      attributes: ['position', 'aRiver'],
      uniforms: ['worldViewProjection', 'uTime', 'sunDir', ...FOG_UNIFORM_NAMES],
      needAlphaBlending: true,
    }
  )
  mat.setVector3('sunDir', new Vector3(0.4, 1, 0.3).normalize())
  mat.setFloat('uTime', 0)
  mat.backFaceCulling = false
  // seen from below (wading, or standing in a gorge) the surface should still
  // be there rather than vanishing
  mat.alpha = 0.95
  // same reasoning water.js gives for its own alphaIndex - keep the water
  // sorting behind other transparent meshes so it can never paint over them
  return mat
}

/**
 * Build the ribbon for one RIVER_CHUNK of Z. Returns null when the river has
 * no presence at all across that span (faded out by mountains or the hub), so
 * empty chunks cost nothing but the test.
 */
function buildRiverChunk(scene, mat, oz) {
  const rows = Math.round(RIVER_CHUNK / Z_STEP) + 1
  const cols = X_DIV + 1

  // cheap reject before building anything
  let anyWater = false
  for (let i = 0; i <= 4 && !anyWater; i++) {
    const z = oz + (i / 4) * RIVER_CHUNK
    if (riverStrength(riverCenterX(z), z) > 0.05) anyWater = true
  }
  if (!anyWater) return null

  const total = rows * cols
  const positions = new Float32Array(total * 3)
  const rivers    = new Float32Array(total * 4)
  let vi = 0, ri = 0

  const step = getTerrainStep()
  for (let iz = 0; iz < rows; iz++) {
    const z  = oz + iz * Z_STEP
    const cx = riverCenterX(z)
    const p  = riverProfileAt(z)
    const s  = riverStrength(cx, z)
    const surf = riverSurfaceY(z)
    // How far out each side the water goes: to where the DRAWN ground rises
    // through the surface, plus a little so the ribbon's own edge is buried
    // in the bank. The ribbon used to stop at the ideal channel width - but
    // the terrain is a 16-unit grid of flat triangles and cannot draw a bank
    // that steep, so the drawn waterline sat beyond that width in most rows
    // (median 1.06x, up to 1.85x), and the water ended in a cut edge
    // hanging over lower ground - measured on 22% of the river. Found per row
    // and per side, so it is exact wherever the grid puts the shore.
    const bankRun = Math.max(p.bank, p.depth * s * 1.1)
    const reach = p.halfWidth + bankRun + 12
    const extent = side => {
      for (let d = 0.5 * p.halfWidth; d <= reach; d += 1) {
        if (drawnHeight(cx + side * d, z, step) >= surf + 0.05) return Math.min(d + 2, reach)
      }
      return reach
    }
    const west = extent(-1), east = extent(1)
    for (let ix = 0; ix < cols; ix++) {
      // -1 at the west edge through 0 at the centre to +1 at the east
      const u = (ix / X_DIV) * 2 - 1
      const x = cx + (u < 0 ? u * west : u * east)
      positions[vi++] = x
      positions[vi++] = surf
      positions[vi++] = z

      rivers[ri++] = p.flow
      rivers[ri++] = p.turb
      rivers[ri++] = Math.abs(u)
      // depth over the drawn ground, so the water fades out exactly where
      // the visible bank comes up through it - and a ford, or a stretch the
      // mountains are fading out, thins it on its own
      const depth = surf - drawnHeight(x, z, step)
      rivers[ri++] = depth > 0 ? depth * Math.max(s, 0.35) : depth
    }
  }

  const idx = new Int32Array((rows - 1) * (cols - 1) * 6)
  let ii = 0
  for (let iz = 0; iz < rows - 1; iz++) {
    for (let ix = 0; ix < cols - 1; ix++) {
      const i = iz * cols + ix
      idx[ii++] = i;     idx[ii++] = i + 1;        idx[ii++] = i + cols
      idx[ii++] = i + 1; idx[ii++] = i + cols + 1; idx[ii++] = i + cols
    }
  }

  const vd = new VertexData()
  vd.positions = positions
  vd.indices   = idx
  // flat, upward-facing sheet - the shader perturbs its own normal from the
  // flow noise, so a real per-vertex normal would only be overwritten
  vd.normals = new Float32Array(total * 3)
  for (let i = 0; i < total; i++) vd.normals[i * 3 + 1] = 1

  const mesh = new Mesh(`river_${oz}`, scene)
  vd.applyToMesh(mesh)
  mesh.setVerticesData('aRiver', rivers, false, 4)
  mesh.material = mat
  mesh.isPickable = false
  mesh.alphaIndex = 1
  return mesh
}

/**
 * Stream the river's water surface. Call once after the terrain exists.
 * Returns { chunks, mat, dispose }.
 */
export function createRiver(scene) {
  if (!scene) {
    console.error(`${LOG_PREFIX} createRiver() called without a scene - the river will not render`)
    return null
  }
  const mat = createRiverMaterial(scene)
  const chunks = new Map()
  let warnedNoCamera = false

  function update(camX, camZ) {
    const cz0 = Math.floor(camZ / RIVER_CHUNK)
    for (const [key, mesh] of chunks) {
      const cz = Number(key)
      const midZ = (cz + 0.5) * RIVER_CHUNK
      if (Math.abs(cz - cz0) > VIEW_Z + 1 || Math.abs(camX - riverCenterX(midZ)) > VIEW_X + 200) {
        mesh.dispose()
        chunks.delete(key)
      }
    }
    for (let dz = -VIEW_Z; dz <= VIEW_Z; dz++) {
      const cz = cz0 + dz
      const key = String(cz)
      if (chunks.has(key)) continue
      const midZ = (cz + 0.5) * RIVER_CHUNK
      if (Math.abs(camX - riverCenterX(midZ)) > VIEW_X) continue
      const mesh = buildRiverChunk(scene, mat, cz * RIVER_CHUNK)
      // null means this stretch has no water at all - remember that with a
      // placeholder so it is not rebuilt and re-rejected every single frame
      chunks.set(key, mesh ?? { dispose() {}, _empty: true })
    }
  }

  let t = 0
  const obs = scene.onBeforeRenderObservable.add(() => {
    const cam = scene.activeCamera
    if (!cam) {
      if (!warnedNoCamera) {
        warnedNoCamera = true
        console.warn(`${LOG_PREFIX} no scene.activeCamera set - river streaming is paused until one exists`)
      }
      return
    }
    t += scene.getEngine().getDeltaTime() * 0.001
    mat.setFloat('uTime', t)
    syncFogUniforms(mat, scene, cam.position)
    update(cam.position.x, cam.position.z)
  })

  return {
    chunks,
    mat,
    dispose() {
      scene.onBeforeRenderObservable.remove(obs)
      for (const m of chunks.values()) m.dispose()
      chunks.clear()
      mat.dispose()
    },
  }
}
