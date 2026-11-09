import { ShaderMaterial, Color3, Vector3 } from '@babylonjs/core'
import { FOG_UNIFORM_NAMES, FOG_UNIFORMS_GLSL, FOG_FACTOR_GLSL, syncFogUniforms } from './fog'
import { syncTerrainLighting } from './terrain'
import { propTexture, TEXTURE_MEAN } from './proctex'

// ── The props' shader ───────────────────────────────────────────────────────
//
// One shader for everything features.js builds - cacti, ice trees, crystals,
// well stones, planks, cliffs - so they all sit in the same light as the
// ground under them: the same sun and ambient terrain.js reads off the host's
// real lights (syncTerrainLighting), the same fog (fog.js), the same
// hemispheric falloff the terrain uses. A StandardMaterial would be lit by a
// different model entirely and look pasted on.
//
// Colour comes from the geometry (geo.js bakes a per-vertex RGBA: rgb tint,
// alpha a glow mask); the grain from a procedural texture (proctex.js) laid
// on in object space on all three axes, so an instance carries its texture
// with it however it is turned. Per material: a fresnel rim (ice, crystal),
// a glow colour scaled by the vertex glow mask (magma, crystal hearts), a
// slow pulse, and wind sway for tall thin things.
//
// Instancing and vertex colour are switched on by Babylon itself - a
// ShaderMaterial defines INSTANCES and VERTEXCOLOR (and binds world0..3 and
// color) whenever the mesh being drawn needs them.
//
// NOTE ON GLSL COMMENTS: none may contain a semicolon - see fog.js.

const VERT = /* glsl */`
  precision highp float;
  attribute vec3 position;
  attribute vec3 normal;
#ifdef VERTEXCOLOR
  attribute vec4 color;
#endif
#ifdef INSTANCES
  attribute vec4 world0;
  attribute vec4 world1;
  attribute vec4 world2;
  attribute vec4 world3;
#endif
  uniform mat4 world;
  uniform mat4 viewProjection;
  uniform float uTime;
  uniform float uSway;
  uniform float uSwayHeight;
  varying vec3 vWorld;
  varying vec3 vNorm;
  varying vec3 vObj;
  varying vec3 vObjN;
  varying vec4 vColor;
  void main() {
#ifdef INSTANCES
    mat4 w = mat4(world0, world1, world2, world3);
#else
    mat4 w = world;
#endif
    vec4 wp = w * vec4(position, 1.0);
    // wind - grows with height up the object, out of phase from one
    // instance to the next
    if (uSway > 0.0) {
      float h = clamp(position.y / uSwayHeight, 0.0, 1.0);
      float ph = w[3].x * 0.071 + w[3].z * 0.053;
      float s = sin(uTime * 0.9 + ph) + 0.35 * sin(uTime * 2.3 + ph * 1.7);
      wp.x += s * uSway * h * h;
      wp.z += cos(uTime * 0.7 + ph) * uSway * 0.6 * h * h;
    }
    vWorld = wp.xyz;
    vNorm = normalize(mat3(w) * normal);
    vObj = position;
    vObjN = normal;
#ifdef VERTEXCOLOR
    vColor = color;
#else
    vColor = vec4(1.0, 1.0, 1.0, 0.0);
#endif
    gl_Position = viewProjection * wp;
  }
`

const FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uTex;
  uniform float uTexScale;
  uniform float uTexMix;
  uniform vec3  sunDir;
  uniform vec3  sunColor;
  uniform vec3  ambientColor;
  uniform float uLift;
  uniform vec3  uRimColor;
  uniform float uRimPower;
  uniform vec3  uGlowColor;
  uniform float uPulse;
  uniform float uTime;
  uniform float uFogScale;
${FOG_UNIFORMS_GLSL}
${FOG_FACTOR_GLSL}
  varying vec3 vWorld;
  varying vec3 vNorm;
  varying vec3 vObj;
  varying vec3 vObjN;
  varying vec4 vColor;
  void main() {
    vec3 n = normalize(vNorm);
    vec3 bw = pow(abs(normalize(vObjN)), vec3(4.0));
    bw /= dot(bw, vec3(1.0));
    vec3 p = vObj * uTexScale;
    float d = texture2D(uTex, p.yz).r * bw.x + texture2D(uTex, p.xz).r * bw.y + texture2D(uTex, p.xy).r * bw.z;
    d = mix(1.0, d / ${TEXTURE_MEAN.toFixed(3)}, uTexMix);
    vec3 alb = vColor.rgb * d;

    float hemi = dot(n, normalize(sunDir)) * 0.32 + 0.68;
    vec3 col = alb * (sunColor * hemi + ambientColor + uLift);

    vec3 v = normalize(uCamPos - vWorld);
    float rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), uRimPower);
    col += uRimColor * rim;

    float pulse = 1.0 + uPulse * sin(uTime * 1.6 + vWorld.x * 0.13 + vWorld.z * 0.11);
    col += uGlowColor * vColor.a * pulse;

    gl_FragColor = vec4(mix(col, uFogColor, fogFactor(vWorld) * uFogScale), 1.0);
  }
`

const UNIFORMS = ['world', 'viewProjection', 'sunDir', 'sunColor', 'ambientColor', 'uTime', 'uTexScale', 'uTexMix', 'uLift',
  'uRimColor', 'uRimPower', 'uGlowColor', 'uPulse', 'uSway', 'uSwayHeight', 'uFogScale', ...FOG_UNIFORM_NAMES]

/**
 * A prop material. Options (all optional):
 *   texture   proctex.js pattern name     texScale  repeats per unit
 *   texMix    0 flat colour .. 1 full grain
 *   rim       [r,g,b] fresnel rim         rimPower
 *   glow      [r,g,b] times vertex alpha  pulse     0..1 glow throb
 *   sway      metres of wind at the top   swayHeight  where "the top" is
 *   lift      extra ambient               fogScale  1 normal, <1 cuts through fog
 *   backFaces true to draw both sides
 */
export function propMaterial(scene, name, o = {}, textures = {}) {
  const mat = new ShaderMaterial(`infterrain_${name}`, scene, { vertexSource: VERT, fragmentSource: FRAG }, {
    attributes: ['position', 'normal'],
    uniforms: UNIFORMS,
    samplers: ['uTex'],
  })
  mat.setTexture('uTex', propTexture(scene, o.texture ?? 'plain', textures))
  mat.setFloat('uTexScale', o.texScale ?? 0.25)
  mat.setFloat('uTexMix', o.texMix ?? 0.8)
  mat.setColor3('uRimColor', Color3.FromArray(o.rim ?? [0, 0, 0]))
  mat.setFloat('uRimPower', o.rimPower ?? 3)
  mat.setColor3('uGlowColor', Color3.FromArray(o.glow ?? [0, 0, 0]))
  mat.setFloat('uPulse', o.pulse ?? 0)
  mat.setFloat('uSway', o.sway ?? 0)
  mat.setFloat('uSwayHeight', o.swayHeight ?? 10)
  mat.setFloat('uLift', o.lift ?? 0.05)
  mat.setFloat('uFogScale', o.fogScale ?? 1)
  mat.setFloat('uTime', 0)
  mat.setVector3('sunDir', new Vector3(0.4, 1, 0.3).normalize())
  mat.setColor3('sunColor', new Color3(1, 0.98, 0.88))
  mat.setColor3('ambientColor', new Color3(0.24, 0.35, 0.18))
  mat.backFaceCulling = !o.backFaces
  trackMaterial(scene, mat)
  return mat
}

// ── one per-frame sync for every material the features own ─────────────────
const tracked = new WeakMap()

/** Keep a material's fog, lighting and time uniforms in step with the scene every frame. */
export function trackMaterial(scene, mat, { lit = true } = {}) {
  let entry = tracked.get(scene)
  if (!entry) {
    entry = { mats: new Map(), time: 0 }
    tracked.set(scene, entry)
    scene.onBeforeRenderObservable.add(() => {
      entry.time += scene.getEngine().getDeltaTime() * 0.001
      const cam = scene.activeCamera
      for (const [m, opts] of entry.mats) {
        if (m.isDisposed?.()) { entry.mats.delete(m); continue }
        m.setFloat('uTime', entry.time)
        if (cam) syncFogUniforms(m, scene, cam.position)
        if (opts.lit) syncTerrainLighting(m, scene)
      }
    })
  }
  entry.mats.set(mat, { lit })
  mat.onDisposeObservable.add(() => entry.mats.delete(mat))
}
