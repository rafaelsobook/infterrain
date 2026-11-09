import {
  Engine, Scene, Vector3, Color3, Color4, Quaternion,
  HemisphericLight, DirectionalLight, ArcRotateCamera, UniversalCamera,
  MeshBuilder, Mesh, StandardMaterial,
  HavokPlugin, PhysicsAggregate, PhysicsShapeType, PhysicsShapeGroundMesh,
} from '@babylonjs/core'
import HavokPhysics from '@babylonjs/havok'
import * as inf from '../src/index.js'
import * as sites from '../src/sites.js'

// ── infterrain lab ─────────────────────────────────────────────────────────
//
// The open world set up the way the vessel client sets it up (its
// areascene.js "openworld" case and tools/lighting.js), so what you see here
// is what the game shows: the same fog, the same two lights, verts 17, the
// same Havok heightfield per chunk, and a stand-in player with the game's box
// body, speeds and jump.
//
//   WASD move   Shift sprint   Space jump   F fly camera on/off
//   ?look=clear thinner fog, to see further while working on something
//   ?look=night the game's night: moonlight, thick dark fog
//   ?x=..&z=..  start somewhere other than the spawn
//
// window.lab is the scripting surface the headless checks drive.

const params = new URLSearchParams(location.search)
const LOOK = params.get('look') ?? 'game'
const VERTS = 17

const canvas = document.getElementById('view')
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true })
const scene = new Scene(engine)
// every frame is 16ms of simulation however long it took to draw, so a walk
// test means the same thing in a slow headless browser as at 60fps
scene.useConstantAnimationDeltaTime = params.get('realtime') !== '1'

// tools/lighting.js, fed the openworld's sceneTemp (localroomdb.js, placeId 888)
const FOG = new Color3(0.38, 0.45, 0.3)
scene.fogMode = Scene.FOGMODE_EXP
scene.fogColor = FOG.clone()
scene.fogDensity = LOOK === 'clear' ? 0.0012 : 0.003
scene.clearColor = LOOK === 'clear' ? new Color4(0.42, 0.5, 0.38, 1) : new Color4(0.15, 0.19, 0.15, 1)
const sun = new DirectionalLight('dir_light', new Vector3(-0.6, -0.5, -0.4), scene)
sun.intensity = 0.55
sun.diffuse = new Color3(0.75, 0.8, 0.55)
const hemi = new HemisphericLight('hemi_ambient', new Vector3(0, 1, 0), scene)
hemi.intensity = 0.5
// ?look=night - the vessel client's darkest hour (its dayNightSystem.js):
// moonlight at half strength and blue, fog sunk toward NIGHT_FOG_COLOR and
// thickened to 0.016
if (LOOK === 'night') {
  sun.intensity = 0.55 * 0.5
  sun.diffuse = new Color3(0.75 * 0.55, 0.8 * 0.65, 0.55 * 1.0)
  hemi.intensity = 0.5 * 0.7
  hemi.diffuse = new Color3(0.55, 0.65, 1.0)
  scene.fogColor = Color3.Lerp(FOG, new Color3(0.07, 0.11, 0.16), 0.9)
  scene.fogDensity = 0.016
  scene.clearColor = new Color4(0.03, 0.04, 0.06, 1)
}

const havok = await HavokPhysics()
scene.enablePhysics(new Vector3(0, -9.81, 0), new HavokPlugin(true, havok))

// ── cameras ────────────────────────────────────────────────────────────────
const follow = new ArcRotateCamera('follow', -Math.PI / 2, 1.18, 7, new Vector3(inf.SPAWN_X, 4, inf.SPAWN_Z), scene)
follow.minZ = 0.5
follow.lowerRadiusLimit = 2
follow.upperRadiusLimit = 60
follow.attachControl(canvas, true)
const fly = new UniversalCamera('fly', new Vector3(inf.SPAWN_X, 30, inf.SPAWN_Z - 40), scene)
fly.minZ = 0.5
fly.speed = 3
fly.keysUp = [87]; fly.keysDown = [83]; fly.keysLeft = [65]; fly.keysRight = [68]
scene.activeCamera = follow

// ── the world, as areascene.js builds it ───────────────────────────────────
const world = await inf.createOpenWorld(scene, [
  './models/trees/tree_1.glb',
  './models/trees/dead_tree_1.glb',
  './models/trees/deadtree1.glb',
], './images/fakeprops/faketree.webp', {
  viewRadius: 1,
  verts: VERTS,
  // the game's own onChunkBuilt: a Havok heightfield on an anchor at the
  // chunk's bounding-box centre (PhysicsShapeGroundMesh wants the shape
  // centred on its body)
  onChunkBuilt: mesh => {
    mesh.computeWorldMatrix(true)
    const bb = mesh.getBoundingInfo().boundingBox
    const anchor = new Mesh(`${mesh.name}_groundAnchor`, scene)
    anchor.position.set(bb.centerWorld.x, bb.minimumWorld.y, bb.centerWorld.z)
    const shape = new PhysicsShapeGroundMesh(mesh, scene)
    new PhysicsAggregate(anchor, shape, { mass: 0, friction: 1, restitution: 0 }, scene)
    mesh.onDisposeObservable.add(() => anchor.dispose())
  },
})
await inf.createOpenWorldGrass(scene, [
  { texturePath: './images/textures/grass/flower1.jpg', qnty: 10, size: 'small' },
  { texturePath: './images/textures/grass/grass2_black.jpg', qnty: 10, size: 'medium' },
  { texturePath: './images/textures/grass/bush1.jpg', qnty: 10, size: 'large' },
], { viewRadius: 1, verts: VERTS })

// ── the stand-in player: createcharacter.js's box body + inputMovement.js ──
const BODY_H = 1.5
const WALK = 1, SPRINT = 3.7, JUMP = 5
const player = MeshBuilder.CreateBox('player', { width: 0.5, depth: 0.5, height: BODY_H }, scene)
const skin = new StandardMaterial('playerMat', scene)
skin.diffuseColor = new Color3(0.85, 0.35, 0.2)
skin.emissiveColor = new Color3(0.25, 0.08, 0.04)
player.material = skin
player.position.set(Number(params.get('x') ?? inf.SPAWN_X), 0, Number(params.get('z') ?? inf.SPAWN_Z))
player.position.y = inf.sampleTerrainSurfaceHeight(player.position.x, player.position.z, VERTS) + BODY_H / 2 + 3
const agg = new PhysicsAggregate(player, PhysicsShapeType.BOX, { mass: 10, friction: 1, restitution: 0 }, scene)
agg.shape.material = { restitution: 0, friction: 1 }
agg.body.setMassProperties({ mass: 10, inertia: Vector3.ZeroReadOnly, inertiaOrientation: Quaternion.Identity() })
agg.body.disablePreStep = false

const input = { forward: 0, right: 0, sprint: false, yaw: null }
const keys = new Set()
window.addEventListener('keydown', e => {
  keys.add(e.code)
  if (e.code === 'Space') jump()
  if (e.code === 'KeyF') scene.activeCamera === fly ? walkMode() : flyMode()
})
window.addEventListener('keyup', e => keys.delete(e.code))

function grounded() {
  const vel = agg.body.getLinearVelocity()
  if (vel.y > 5.5) return false
  const from = agg.body.getObjectCenterWorld()
  const to = from.add(new Vector3(0, -(BODY_H / 2 + 0.4), 0))
  const hit = scene.getPhysicsEngine().raycast(from, to)
  return !!hit?.hasHit && hit.body !== agg.body
}
function jump() {
  if (!grounded()) return false
  const v = agg.body.getLinearVelocity()
  agg.body.setLinearVelocity(new Vector3(v.x, JUMP, v.z))
  return true
}

scene.onBeforePhysicsObservable.add(() => {
  if (scene.activeCamera === follow) {
    input.forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) || input.scriptForward || 0
    input.right = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) || input.scriptRight || 0
  }
  const v = agg.body.getLinearVelocity()
  if (!input.forward && !input.right) {
    agg.body.setLinearVelocity(new Vector3(0, v.y, 0))
    return
  }
  // camera-relative, like the game - or a fixed heading when a script set one
  const yaw = input.yaw ?? (Math.PI / 2 - follow.alpha + Math.PI)
  const fx = Math.sin(yaw), fz = Math.cos(yaw)
  let dx = fx * input.forward + fz * input.right
  let dz = fz * input.forward - fx * input.right
  const len = Math.hypot(dx, dz) || 1
  const speed = (keys.has('ShiftLeft') || input.sprint) ? SPRINT : WALK
  agg.body.setLinearVelocity(new Vector3(dx / len * speed, v.y, dz / len * speed))
})

scene.onBeforeRenderObservable.add(() => {
  if (scene.activeCamera === follow) follow.target.copyFrom(player.position).addInPlaceFromFloats(0, 0.8, 0)
})

function walkMode() { scene.activeCamera = follow; fly.detachControl(); follow.attachControl(canvas, true) }
function flyMode() {
  fly.position.copyFrom(follow.position)
  fly.setTarget(follow.target)
  scene.activeCamera = fly
  follow.detachControl()
  fly.attachControl(canvas, true)
}

// ── HUD ────────────────────────────────────────────────────────────────────
const hud = document.getElementById('hud')
let hudFrame = 0
scene.onAfterRenderObservable.add(() => {
  if (++hudFrame % 15) return
  const p = player.position
  const lines = [
    `fps ${engine.getFps().toFixed(0)}   chunks ${world.chunks.size}   ${scene.activeCamera === fly ? 'FLY' : 'WALK'}`,
    `player ${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)}   grounded ${grounded()}`,
    `surface ${inf.sampleTerrainSurfaceHeight(p.x, p.z, VERTS).toFixed(2)}   from spawn ${Math.hypot(p.x - inf.SPAWN_X, p.z - inf.SPAWN_Z).toFixed(0)}`,
  ]
  if (inf.describeLocation) lines.push(...inf.describeLocation(p.x, p.z))
  const fs = world.features?.stats
  if (fs) lines.push(`features: ${fs.builds} chunks built, last ${fs.lastMs.toFixed(0)}ms, worst ${fs.maxMs.toFixed(0)}ms`)
  hud.textContent = lines.join('\n')
})

// ── go-to list: every special place the module knows about near spawn ────
const goto = document.getElementById('goto')
if (inf.listFeatures) {
  for (const f of inf.listFeatures(inf.SPAWN_X, inf.SPAWN_Z, 4000)) {
    const o = document.createElement('option')
    o.value = `${f.x},${f.z}`
    o.textContent = `${f.kind} @ ${f.x.toFixed(0)}, ${f.z.toFixed(0)} (${Math.hypot(f.x - inf.SPAWN_X, f.z - inf.SPAWN_Z).toFixed(0)})`
    goto.appendChild(o)
  }
}
goto.addEventListener('change', () => {
  const [x, z] = goto.value.split(',').map(Number)
  if (Number.isFinite(x)) teleport(x, z)
  goto.blur()
})

function teleport(x, z, lift = 2) {
  const y = inf.sampleTerrainSurfaceHeight(x, z, VERTS) + BODY_H / 2 + lift
  player.position.set(x, y, z)
  agg.body.setLinearVelocity(Vector3.Zero())
  walkMode()
}

const frames = n => new Promise(resolve => {
  let left = n
  const obs = scene.onAfterRenderObservable.add(() => {
    if (--left <= 0) { scene.onAfterRenderObservable.remove(obs); resolve() }
  })
})

window.lab = {
  inf, sites, scene, engine, world, player, agg, input, follow, fly, VERTS,
  walkMode, flyMode, teleport, jump, grounded, frames,
  // free camera at a pose, for screenshots
  look(px, py, pz, tx, ty, tz) {
    flyMode()
    fly.position.set(px, py, pz)
    fly.setTarget(new Vector3(tx, ty, tz))
  },
  // let streaming catch up around wherever the active camera is now
  async settle(maxFrames = 240) {
    let last = -1, still = 0
    for (let i = 0; i < maxFrames && still < 20; i++) {
      await frames(1)
      const n = scene.meshes.length
      still = n === last ? still + 1 : 0
      last = n
    }
  },
}

engine.runRenderLoop(() => scene.render())
window.addEventListener('resize', () => engine.resize())
window.labReady = true
