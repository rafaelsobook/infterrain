import { Mesh, ShaderMaterial, VertexData } from '@babylonjs/core'
import { FOG_UNIFORM_NAMES, FOG_UNIFORMS_GLSL, FOG_FACTOR_GLSL } from './fog'
import { biomeWeightsAt, LAVA_DEPTH } from './biomes'
import { lavaLevelAt } from './world'
import { drawnHeight } from './ground'
import { trackMaterial } from './materials'

// ── Lava ─────────────────────────────────────────────────────────────────────
//
// The molten rock in emberfrost's fissures (biomes.js cuts the fissures, and
// sets the lava a fixed drop under the land's native lie - lavaLevelAt - so it
// runs downhill through them like a slow flow rather than lying dead level).
//
// Built per chunk like the lakes (water.js): a lattice half the terrain's
// grid, each vertex knowing how deep the lava is over the DRAWN ground, and
// the shader fading to nothing where that reaches zero - so the lava meets the
// basalt in a soft glowing seam, not a polygon edge. It is pure emission: lava
// is the light, nothing lights it.
//
// NOTE ON GLSL COMMENTS: none may contain a semicolon - see fog.js.

const CHUNK = 256
const LATTICE = 8

const VERT = /* glsl */`
  precision highp float;
  attribute vec3 position;
  attribute vec2 aLava;
  uniform mat4 worldViewProjection;
  varying vec3 vWorld;
  varying vec2 vLava;
  void main() {
    vWorld = position;
    vLava = aLava;
    gl_Position = worldViewProjection * vec4(position, 1.0);
  }
`

const FRAG = /* glsl */`
  precision highp float;
  uniform float uTime;
${FOG_UNIFORMS_GLSL}
${FOG_FACTOR_GLSL}
  varying vec3 vWorld;
  varying vec2 vLava;

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  vec2 cells(vec2 p) {
    vec2 g = floor(p), f = fract(p);
    float f1 = 8.0, f2 = 8.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 o = vec2(float(i), float(j));
        vec2 h = vec2(hash21(g + o), hash21(g + o + 17.3));
        vec2 r = o + 0.5 + 0.4 * sin(uTime * 0.25 + 6.2831 * h) - f;
        float d = dot(r, r);
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
      }
    }
    return vec2(sqrt(f1), sqrt(f2));
  }

  void main() {
    float depth = vLava.x;
    if (depth <= 0.0) discard;
    vec2 p = vWorld.xz * 0.07 + vec2(uTime * 0.015, uTime * 0.011)
           + vec2(vnoise(vWorld.xz * 0.03), vnoise(vWorld.xz * 0.03 + 6.0)) * 1.7;
    vec2 c = cells(p);
    float seam = c.y - c.x;
    // cooling crust plates drifting on the melt - most of the surface is
    // dark crust, the melt glaring through the seams between plates and
    // where the flow runs deepest
    float crust = smoothstep(0.02, 0.12, seam) * (0.8 + 0.2 * vnoise(vWorld.xz * 0.11));
    crust *= mix(1.0, 0.75, smoothstep(0.15, 0.6, depth));
    crust *= smoothstep(0.15, 0.45, vnoise(vWorld.xz * 0.045 + vec2(uTime * 0.01, 0.0)) + 0.25);
    float n = vnoise(vWorld.xz * 0.35 + vec2(uTime * 0.3, -uTime * 0.2));
    vec3 melt = mix(vec3(1.0, 0.3, 0.04), vec3(1.0, 0.72, 0.22), n);
    melt *= 1.5 + 0.5 * sin(uTime * 1.3 + c.x * 6.0);
    vec3 col = mix(melt, vec3(0.09, 0.04, 0.03) + melt * 0.06, crust * 0.88);
    float a = smoothstep(0.0, 0.35, depth) * smoothstep(0.25, 0.55, vLava.y);
    col = mix(col, uFogColor, fogFactor(vWorld) * 0.85);
    gl_FragColor = vec4(col, a);
  }
`

export function lavaMaterial(scene) {
  const mat = new ShaderMaterial('infterrain_lava', scene, { vertexSource: VERT, fragmentSource: FRAG }, {
    attributes: ['position', 'aLava'],
    uniforms: ['worldViewProjection', 'uTime', ...FOG_UNIFORM_NAMES],
    needAlphaBlending: true,
  })
  mat.setFloat('uTime', 0)
  mat.backFaceCulling = false
  trackMaterial(scene, mat, { lit: false })
  return mat
}

/** The lava over one terrain chunk, or null when the chunk has none. */
export function buildLavaPatch(scene, mat, ox, oz, step) {
  const n = CHUNK / LATTICE + 1
  // cheap reject: any emberfrost at all across the chunk
  let any = false
  for (let i = 0; i <= 4 && !any; i++)
    for (let j = 0; j <= 4 && !any; j++)
      if (biomeWeightsAt(ox + i * 64, oz + j * 64).emberfrost > 0.3) any = true
  if (!any) return null

  const weight = new Float32Array(n * n), level = new Float32Array(n * n), depth = new Float32Array(n * n)
  for (let iz = 0; iz < n; iz++)
    for (let ix = 0; ix < n; ix++) {
      const x = ox + ix * LATTICE, z = oz + iz * LATTICE, k = iz * n + ix
      const w = biomeWeightsAt(x, z).emberfrost
      weight[k] = w
      if (w < 0.2) { depth[k] = -1; continue }
      // capped over the DRAWN ground too - the grid you stand on can dip
      // a few metres under the exact land between its vertices
      const g = drawnHeight(x, z, step)
      level[k] = Math.min(lavaLevelAt(x, z), g + LAVA_DEPTH)
      depth[k] = level[k] - g
    }
  const positions = [], attrs = [], indices = []
  const index = new Map()
  const vert = (ix, iz) => {
    const k = iz * n + ix
    let i = index.get(k)
    if (i === undefined) {
      i = positions.length / 3
      positions.push(ox + ix * LATTICE, level[k], oz + iz * LATTICE)
      attrs.push(depth[k], weight[k])
      index.set(k, i)
    }
    return i
  }
  for (let iz = 0; iz < n - 1; iz++)
    for (let ix = 0; ix < n - 1; ix++) {
      const ks = [iz * n + ix, iz * n + ix + 1, (iz + 1) * n + ix, (iz + 1) * n + ix + 1]
      if (ks.some(k => weight[k] < 0.2)) continue
      if (Math.max(...ks.map(k => depth[k])) <= 0) continue
      const a = vert(ix, iz), b = vert(ix + 1, iz), c = vert(ix, iz + 1), d = vert(ix + 1, iz + 1)
      indices.push(a, b, c, b, d, c)
    }
  if (!indices.length) return null
  const vd = new VertexData()
  vd.positions = positions
  vd.indices = indices
  vd.normals = new Float32Array(positions.length).map((_, i) => i % 3 === 1 ? 1 : 0)
  const mesh = new Mesh('infterrain_lava', scene)
  vd.applyToMesh(mesh)
  mesh.setVerticesData('aLava', new Float32Array(attrs), false, 2)
  mesh.material = mat
  mesh.isPickable = false
  mesh.alphaIndex = 1
  return mesh
}
