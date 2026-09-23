import { MeshBuilder, ShaderMaterial, Vector3, Color3 } from '@babylonjs/core'
import { WATER_LEVEL } from './world'

const LOG_PREFIX = '[infterrain]'
const DEFAULT_FOG_COLOR = new Color3(0.65, 0.78, 0.88)
const DEFAULT_FOG_START = 400
const DEFAULT_FOG_END   = 1400

const VERT = /* glsl */`
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

const FRAG = /* glsl */`
  precision highp float;
  uniform float uTime;
  uniform vec3  sunDir;
  uniform vec3  fogColor;
  uniform float fogStart;
  uniform float fogEnd;
  uniform vec3  camPos;
  varying vec3 vWorld;

  void main() {
    float r1 = sin(vWorld.x * 0.18 + uTime * 0.9) * sin(vWorld.z * 0.22 + uTime * 0.7);
    float r2 = sin(vWorld.x * 0.11 - uTime * 0.6) * sin(vWorld.z * 0.13 + uTime * 1.1);
    float ripple = (r1 + r2) * 0.5;

    // Swampy green, replacing the original blue. Both stops sit in the same
    // hue family as the terrain's own grass rather than fighting it, and the
    // gap between them is narrower than the blue pair was - stagnant water
    // reads flatter and murkier than open water, so a wide deep-to-shallow
    // spread would look like a clear tropical shallow instead of a swamp.
    vec3 deep    = vec3(0.05, 0.14, 0.09);
    vec3 shallow = vec3(0.16, 0.28, 0.14);
    vec3 col = mix(deep, shallow, clamp(ripple * 0.5 + 0.5, 0.0, 1.0));

    vec3 viewDir = normalize(camPos - vWorld);
    vec3 halfV   = normalize(sunDir + viewDir);
    float spec   = pow(max(dot(vec3(0.0, 1.0, 0.0), halfV), 0.0), 80.0);
    // dimmer and warmer than the old blue-white glint. A bright specular on a
    // dark swamp surface reads as polished glass, which is the look this is
    // meant to avoid - murky water scatters far more light than it mirrors.
    col += vec3(0.75, 0.80, 0.62) * spec * 0.3;

    float dist = length(camPos - vWorld);
    float fog  = clamp((dist - fogStart) / (fogEnd - fogStart), 0.0, 1.0);
    col = mix(col, fogColor, fog);

    gl_FragColor = vec4(col, 0.88);
  }
`

const WATER_SIZE = 12000

let warnedNoFog = false

function syncFog(mat, scene) {
  try {
    const hasFog = !!scene.fogColor && typeof scene.fogStart === 'number' && typeof scene.fogEnd === 'number'
    if (!hasFog && !warnedNoFog) {
      warnedNoFog = true
      console.warn(`${LOG_PREFIX} scene.fogColor/fogStart/fogEnd not set — water is using default fog values`)
    }
    mat.setColor3('fogColor', hasFog ? scene.fogColor : DEFAULT_FOG_COLOR)
    mat.setFloat('fogStart',  hasFog ? scene.fogStart : DEFAULT_FOG_START)
    mat.setFloat('fogEnd',    hasFog ? scene.fogEnd   : DEFAULT_FOG_END)
  } catch (err) {
    console.error(`${LOG_PREFIX} water.js failed to sync fog uniforms:`, err)
  }
}

export function createWater(scene) {
  const mesh = MeshBuilder.CreateGround('water', {
    width: WATER_SIZE, height: WATER_SIZE, subdivisions: 1,
  }, scene)
  mesh.position.y  = WATER_LEVEL
  mesh.isPickable  = false
  // Babylon's default transparent-mesh sort is by alphaIndex first (ascending),
  // falling back to camera distance only when alphaIndex is tied - every mesh
  // defaults to the same alphaIndex (1000), so without this the water (which
  // recenters onto the camera's X/Z every frame, skewing its computed bounding-
  // sphere distance) can occasionally sort as "closer" than other transparent/
  // alpha-blended meshes (e.g. a character's hat) and get drawn after them,
  // painting over them regardless of true depth. Forcing a lower alphaIndex
  // makes the water always sort first (farthest), so it can never draw after -
  // and therefore never paint over - anything else.
  mesh.alphaIndex = 0


  const mat = new ShaderMaterial('waterMat', scene,
    { vertexSource: VERT, fragmentSource: FRAG },
    { attributes: ['position'],
      uniforms:   ['worldViewProjection', 'world', 'uTime', 'sunDir', 'fogColor', 'fogStart', 'fogEnd', 'camPos'] }
  )

  const dir = new Vector3(0.4, 1, 0.3).normalize()
  mat.setVector3('sunDir',   dir)
  syncFog(mat, scene)
  mat.setVector3('camPos',   Vector3.Zero())
  mat.setFloat('uTime', 0)
  mat.alpha = 0.88
  mat.needDepthPrePass = true
  mesh.material = mat

  let t = 0
  scene.onBeforeRenderObservable.add(() => {
    t += scene.getEngine().getDeltaTime() * 0.001
    mat.setFloat('uTime', t)
    syncFog(mat, scene)
    if (scene.activeCamera) {
      const cam = scene.activeCamera
      mesh.position.x = cam.position.x
      mesh.position.z = cam.position.z
      mat.setVector3('camPos', cam.position)
    }
  })

  return mesh
}
