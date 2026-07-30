import { MeshBuilder, ShaderMaterial, Vector3, Color3 } from '@babylonjs/core'
import { WATER_LEVEL } from './world'

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

    vec3 deep    = vec3(0.08, 0.32, 0.52);
    vec3 shallow = vec3(0.30, 0.62, 0.75);
    vec3 col = mix(deep, shallow, clamp(ripple * 0.5 + 0.5, 0.0, 1.0));

    vec3 viewDir = normalize(camPos - vWorld);
    vec3 halfV   = normalize(sunDir + viewDir);
    float spec   = pow(max(dot(vec3(0.0, 1.0, 0.0), halfV), 0.0), 80.0);
    col += vec3(0.9, 0.95, 1.0) * spec * 0.6;

    float dist = length(camPos - vWorld);
    float fog  = clamp((dist - fogStart) / (fogEnd - fogStart), 0.0, 1.0);
    col = mix(col, fogColor, fog);

    gl_FragColor = vec4(col, 0.88);
  }
`

const WATER_SIZE = 12000

export function createWater(scene) {
  const mesh = MeshBuilder.CreateGround('water', {
    width: WATER_SIZE, height: WATER_SIZE, subdivisions: 1,
  }, scene)
  mesh.position.y  = WATER_LEVEL
  mesh.isPickable  = false

  const mat = new ShaderMaterial('waterMat', scene,
    { vertexSource: VERT, fragmentSource: FRAG },
    { attributes: ['position'],
      uniforms:   ['worldViewProjection', 'world', 'uTime', 'sunDir', 'fogColor', 'fogStart', 'fogEnd', 'camPos'] }
  )

  const dir = new Vector3(0.4, 1, 0.3).normalize()
  mat.setVector3('sunDir',   dir)
  mat.setColor3('fogColor',  scene.fogColor)
  mat.setFloat('fogStart',   scene.fogStart)
  mat.setFloat('fogEnd',     scene.fogEnd)
  mat.setVector3('camPos',   Vector3.Zero())
  mat.setFloat('uTime', 0)
  mat.alpha = 0.88
  mat.needDepthPrePass = true
  mesh.material = mat

  let t = 0
  scene.onBeforeRenderObservable.add(() => {
    t += scene.getEngine().getDeltaTime() * 0.001
    mat.setFloat('uTime', t)
    mat.setColor3('fogColor', scene.fogColor)
    mat.setFloat('fogStart', scene.fogStart)
    mat.setFloat('fogEnd',   scene.fogEnd)
    if (scene.activeCamera) {
      const cam = scene.activeCamera
      mesh.position.x = cam.position.x
      mesh.position.z = cam.position.z
      mat.setVector3('camPos', cam.position)
    }
  })

  return mesh
}
