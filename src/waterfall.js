import { ShaderMaterial } from '@babylonjs/core'
import { FOG_UNIFORM_NAMES, FOG_UNIFORMS_GLSL, FOG_FACTOR_GLSL } from './fog'
import { trackMaterial } from './materials'

// The waterfall's own surfaces (builders.js puts them together):
//   sheet    the falling water - streaks racing down it, foaming white where
//            it breaks, see-through at the edges
//   pool     the plunge pool - clearer and bluer than the swamp lakes, rings
//            of foam pulsing out from where the fall lands, soft shore
//            (aDepth over the drawn ground, the same idea as water.js)
//   creek    the stream a waterfall's pool spills into, running downhill
//            over the ground - streaks travelling along it, clear at the edges
//   column   the rising falls (builders.js) - water running UP a twisting
//            column out of its pond, thinning as it climbs
//   rainbow  a faint bow standing in the spray. Not physically placed
//            against the sun - just always there, the way you remember them
//
// NOTE ON GLSL COMMENTS: none may contain a semicolon - see fog.js.

const NOISE = /* glsl */`
  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
  }
`

// aSheet: x across the sheet 0..1, y down the sheet 0 (lip) .. 1 (pool)
const SHEET_VERT = /* glsl */`
  precision highp float;
  attribute vec3 position;
  attribute vec2 aSheet;
  uniform mat4 worldViewProjection;
  uniform mat4 world;
  uniform float uTime;
  varying vec3 vWorld;
  varying vec2 vSheet;
  void main() {
    vec3 p = position;
    p.x += sin(uTime * 3.0 + aSheet.y * 9.0 + aSheet.x * 5.0) * 0.08 * aSheet.y;
    vWorld = (world * vec4(p, 1.0)).xyz;
    vSheet = aSheet;
    gl_Position = worldViewProjection * vec4(p, 1.0);
  }
`
const SHEET_FRAG = /* glsl */`
  precision highp float;
  uniform float uTime;
  uniform vec3 sunColor;
${FOG_UNIFORMS_GLSL}
${FOG_FACTOR_GLSL}
${NOISE}
  varying vec3 vWorld;
  varying vec2 vSheet;
  void main() {
    float across = vSheet.x, down = vSheet.y;
    vec2 p = vec2(across * 14.0, down * 5.0 - uTime * 2.6);
    float streak = vnoise(vec2(p.x, p.y * 0.25)) * 0.6 + vnoise(p * vec2(2.0, 0.6)) * 0.4;
    float foam = smoothstep(0.45, 0.85, streak + down * 0.35);
    vec3 water = vec3(0.32, 0.52, 0.55);
    vec3 col = mix(water, vec3(0.92, 0.97, 1.0), foam);
    float light = clamp(length(sunColor) * 1.2, 0.35, 1.1);
    col *= light;
    col += vec3(0.08, 0.1, 0.12) * foam;
    float edge = smoothstep(0.0, 0.12, across) * smoothstep(1.0, 0.88, across);
    float a = (0.55 + foam * 0.4) * edge * smoothstep(0.0, 0.04, down);
    col = mix(col, uFogColor, fogFactor(vWorld));
    gl_FragColor = vec4(col, a);
  }
`

// aPool: x depth over the drawn ground, y distance from where the fall lands
const POOL_VERT = /* glsl */`
  precision highp float;
  attribute vec3 position;
  attribute vec2 aPool;
  uniform mat4 worldViewProjection;
  uniform mat4 world;
  varying vec3 vWorld;
  varying float vDepth;
  varying float vImpact;
  void main() {
    vWorld = (world * vec4(position, 1.0)).xyz;
    vDepth = aPool.x;
    vImpact = aPool.y;
    gl_Position = worldViewProjection * vec4(position, 1.0);
  }
`
const POOL_FRAG = /* glsl */`
  precision highp float;
  uniform float uTime;
  uniform vec3 sunColor;
${FOG_UNIFORMS_GLSL}
${FOG_FACTOR_GLSL}
${NOISE}
  varying vec3 vWorld;
  varying float vDepth;
  varying float vImpact;
  void main() {
    if (vDepth <= 0.0) discard;
    float d = vImpact;
    float rings = sin(d * 2.2 - uTime * 4.0) * 0.5 + 0.5;
    float near = 1.0 - smoothstep(1.0, 9.0, d);
    float churn = vnoise(vWorld.xz * 0.9 + vec2(uTime * 0.7, uTime * 0.4));
    float foam = clamp(near * (rings * 0.5 + churn * 0.7) - 0.15, 0.0, 1.0);
    float shore = 1.0 - smoothstep(0.0, 0.6, vDepth);
    foam = max(foam, shore * smoothstep(0.5, 0.8, churn) * 0.6);
    vec3 deep = vec3(0.04, 0.2, 0.24), shallow = vec3(0.18, 0.42, 0.42);
    vec3 col = mix(shallow, deep, clamp(vDepth * 0.35, 0.0, 1.0));
    col = mix(col, vec3(0.9, 0.96, 0.97), foam * 0.8);
    float light = clamp(length(sunColor) * 1.2, 0.35, 1.1);
    col *= light;
    float a = smoothstep(0.0, 0.5, vDepth) * 0.88;
    a = max(a, foam * 0.7 * step(0.0, vDepth));
    col = mix(col, uFogColor, fogFactor(vWorld));
    gl_FragColor = vec4(col, a);
  }
`

// aBow: x 0 inner edge .. 1 outer edge of the band, y along the arc 0..1
const BOW_VERT = /* glsl */`
  precision highp float;
  attribute vec3 position;
  attribute vec2 aBow;
  uniform mat4 worldViewProjection;
  uniform mat4 world;
  varying vec2 vBow;
  varying vec3 vWorld;
  void main() {
    vBow = aBow;
    vWorld = (world * vec4(position, 1.0)).xyz;
    gl_Position = worldViewProjection * vec4(position, 1.0);
  }
`
const BOW_FRAG = /* glsl */`
  precision highp float;
  uniform float uTime;
${FOG_UNIFORMS_GLSL}
${FOG_FACTOR_GLSL}
  varying vec2 vBow;
  varying vec3 vWorld;
  vec3 spectrum(float t) {
    return clamp(vec3(
      abs(t * 6.0 - 3.0) - 1.0,
      2.0 - abs(t * 6.0 - 2.0),
      2.0 - abs(t * 6.0 - 4.0)), 0.0, 1.0);
  }
  void main() {
    vec3 c = spectrum(1.0 - vBow.x * 0.85);
    float band = smoothstep(0.0, 0.2, vBow.x) * smoothstep(1.0, 0.8, vBow.x);
    float ends = smoothstep(0.0, 0.25, vBow.y) * smoothstep(1.0, 0.75, vBow.y);
    float shimmer = 0.75 + 0.25 * sin(uTime * 0.8 + vBow.y * 6.0);
    float a = band * ends * shimmer * 0.32 * (1.0 - fogFactor(vWorld));
    gl_FragColor = vec4(c * a, a);
  }
`

// aFlow: x distance along the creek in units, y across it -1..1, z how
// steeply it is running here 0..1
const CREEK_VERT = /* glsl */`
  precision highp float;
  attribute vec3 position;
  attribute vec3 aFlow;
  uniform mat4 worldViewProjection;
  uniform mat4 world;
  varying vec3 vWorld;
  varying vec3 vFlow;
  void main() {
    vWorld = (world * vec4(position, 1.0)).xyz;
    vFlow = aFlow;
    gl_Position = worldViewProjection * vec4(position, 1.0);
  }
`
const CREEK_FRAG = /* glsl */`
  precision highp float;
  uniform float uTime;
  uniform vec3 sunColor;
${FOG_UNIFORMS_GLSL}
${FOG_FACTOR_GLSL}
${NOISE}
  varying vec3 vWorld;
  varying vec3 vFlow;
  void main() {
    float along = vFlow.x, across = vFlow.y, steep = vFlow.z;
    float speed = 1.2 + steep * 3.0;
    vec2 p = vec2(across * 2.2, along * 0.35 - uTime * speed);
    float n = vnoise(p * vec2(1.0, 1.0)) * 0.6 + vnoise(p * vec2(2.3, 2.0) + 3.1) * 0.4;
    float foam = smoothstep(0.62 - steep * 0.25, 0.95, n) * (0.35 + steep * 0.65);
    float bank = smoothstep(0.55, 1.0, abs(across));
    foam = max(foam, bank * smoothstep(0.4, 0.8, n) * 0.5);
    vec3 col = mix(vec3(0.12, 0.3, 0.32), vec3(0.85, 0.93, 0.92), foam);
    float light = clamp(length(sunColor) * 1.2, 0.35, 1.1);
    col *= light;
    float a = (0.72 + foam * 0.25) * (1.0 - smoothstep(0.7, 1.0, abs(across)));
    col = mix(col, uFogColor, fogFactor(vWorld));
    gl_FragColor = vec4(col, a);
  }
`

// aCol: x round the column 0..1, y up it 0 (pond) .. 1 (top)
const COLUMN_VERT = /* glsl */`
  precision highp float;
  attribute vec3 position;
  attribute vec2 aCol;
  uniform mat4 worldViewProjection;
  uniform mat4 world;
  uniform float uTime;
  varying vec3 vWorld;
  varying vec2 vCol;
  void main() {
    vec3 p = position;
    float h = aCol.y;
    p.x += sin(uTime * 0.7 + h * 4.0) * h * 1.3;
    p.z += cos(uTime * 0.55 + h * 3.1) * h * 1.0;
    vWorld = (world * vec4(p, 1.0)).xyz;
    vCol = aCol;
    gl_Position = worldViewProjection * vec4(p, 1.0);
  }
`
const COLUMN_FRAG = /* glsl */`
  precision highp float;
  uniform float uTime;
  uniform vec3 sunColor;
${FOG_UNIFORMS_GLSL}
${FOG_FACTOR_GLSL}
${NOISE}
  varying vec3 vWorld;
  varying vec2 vCol;
  void main() {
    float a = vCol.x * 6.2831;
    float h = vCol.y;
    vec2 q = vec2(cos(a), sin(a)) * 2.0;
    float n = vnoise(q * 1.5 + vec2(0.0, h * 9.0 - uTime * 3.0)) * 0.6 + vnoise(q * 3.0 + vec2(h * 18.0 - uTime * 5.0, 1.7)) * 0.4;
    float streak = 0.5 + 0.5 * sin(a * 9.0 + n * 4.0 + h * 3.0);
    float foam = smoothstep(0.5, 0.88, n * 0.7 + streak * 0.45 + (1.0 - h) * 0.12);
    vec3 col = mix(vec3(0.3, 0.55, 0.6), vec3(0.92, 0.97, 1.0), foam);
    float light = clamp(length(sunColor) * 1.2, 0.4, 1.1);
    col = col * light + vec3(0.05, 0.09, 0.1) * (1.0 - foam);
    float a2 = (0.5 + foam * 0.42) * smoothstep(1.0, 0.82, h) * smoothstep(0.0, 0.025, h);
    col = mix(col, uFogColor, fogFactor(vWorld));
    gl_FragColor = vec4(col, a2);
  }
`

function shader(scene, name, vert, frag, attributes, extraUniforms = []) {
  const mat = new ShaderMaterial(name, scene, { vertexSource: vert, fragmentSource: frag }, {
    attributes,
    uniforms: ['worldViewProjection', 'world', 'uTime', 'sunColor', ...extraUniforms, ...FOG_UNIFORM_NAMES],
    needAlphaBlending: true,
  })
  mat.setFloat('uTime', 0)
  mat.backFaceCulling = false
  // brightness only - lit:true would also push sunDir/ambient, which these
  // shaders do not declare, so the light colour is synced by hand below
  trackMaterial(scene, mat, { lit: false })
  scene.onBeforeRenderObservable.add(() => {
    let sun = null
    for (const l of scene.lights) if (l.isEnabled() && l.getClassName?.() === 'DirectionalLight' && (!sun || l.intensity > sun.intensity)) sun = l
    if (sun) mat.setColor3('sunColor', sun.diffuse.scale(sun.intensity * 1.6))
  })
  return mat
}

const cache = new WeakMap()
export function fallsMaterials(scene) {
  let m = cache.get(scene)
  if (m) return m
  m = {
    sheet: shader(scene, 'infterrain_fallsSheet', SHEET_VERT, SHEET_FRAG, ['position', 'aSheet']),
    pool: shader(scene, 'infterrain_fallsPool', POOL_VERT, POOL_FRAG, ['position', 'aPool']),
    bow: shader(scene, 'infterrain_rainbow', BOW_VERT, BOW_FRAG, ['position', 'aBow']),
    column: shader(scene, 'infterrain_risingColumn', COLUMN_VERT, COLUMN_FRAG, ['position', 'aCol']),
    creek: shader(scene, 'infterrain_creek', CREEK_VERT, CREEK_FRAG, ['position', 'aFlow']),
  }
  // drawn just over the ground it is draped on - pulled toward the camera in
  // depth so the two never fight over the same pixels
  m.creek.zOffset = -2
  m.bow.alphaMode = 1 // additive - a rainbow only ever adds light
  m.bow.disableDepthWrite = true
  cache.set(scene, m)
  return m
}
