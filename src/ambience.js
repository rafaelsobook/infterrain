import { ParticleSystem, DynamicTexture, Vector3, Color4 } from '@babylonjs/core'
import { biomeWeightsAt } from './biomes'

// ── Air ───────────────────────────────────────────────────────────────────
//
// Something in the air of every strange land, around the camera only:
//   emberfrost   embers rising off the lava - and snow falling through them
//   crystal      glints of light hanging in the air
//   skyneedle    fireflies
//   cloudmeadow  seed-fluff drifting up off the puffballs
//   thornvine    sand blowing along the ground
//
// One particle system per kind, its emitter following the camera, its rate
// following the biome's weight where the camera is - so the air changes as
// you walk from one land into the next, over the same distance the ground
// does. A system with nothing to do is stopped outright.

const BOX = 34

function dotTexture(scene, name, soft) {
  const t = new DynamicTexture(name, { width: 32, height: 32 }, scene, false)
  const c = t.getContext()
  const g = c.createRadialGradient(16, 16, 0, 16, 16, 16)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(soft, 'rgba(255,255,255,0.5)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  c.fillStyle = g
  c.fillRect(0, 0, 32, 32)
  t.update()
  t.hasAlpha = true
  return t
}

// every system's particle cap and emit rate, scaled together - half what they
// were drawn at first, for frame rate's sake
const AIR = 0.5

const KINDS = [
  {
    biome: 'emberfrost', rate: 60, cap: 420, add: true,
    color1: [1.0, 0.55, 0.15, 1], color2: [1.0, 0.3, 0.05, 1], dead: [0.6, 0.1, 0, 0],
    size: [0.08, 0.22], life: [2.5, 5], dir1: [-0.4, 1.2, -0.4], dir2: [0.4, 2.6, 0.4], power: [0.4, 1.1], gravity: [0, 0.25, 0],
    low: true,
  },
  {
    biome: 'emberfrost', rate: 45, cap: 380,
    color1: [0.95, 0.97, 1.0, 0.9], color2: [0.85, 0.9, 1.0, 0.7], dead: [0.8, 0.85, 1, 0],
    size: [0.06, 0.16], life: [5, 8], dir1: [-0.3, -1, -0.3], dir2: [0.3, -0.6, 0.3], power: [0.4, 0.8], gravity: [0, -0.15, 0],
    high: true,
  },
  {
    biome: 'crystal', rate: 40, cap: 300, add: true,
    color1: [0.55, 0.9, 1.0, 1], color2: [0.9, 0.55, 1.0, 1], dead: [0.5, 0.5, 1, 0],
    size: [0.05, 0.14], life: [1.5, 3.5], dir1: [-0.1, -0.05, -0.1], dir2: [0.1, 0.15, 0.1], power: [0.05, 0.2], gravity: [0, 0, 0],
  },
  {
    biome: 'skyneedle', rate: 22, cap: 220, add: true,
    color1: [0.75, 1.0, 0.45, 1], color2: [0.45, 1.0, 0.7, 1], dead: [0.3, 0.6, 0.2, 0],
    size: [0.07, 0.15], life: [3, 6], dir1: [-0.5, -0.2, -0.5], dir2: [0.5, 0.35, 0.5], power: [0.1, 0.4], gravity: [0, 0, 0],
    low: true,
  },
  {
    biome: 'cloudmeadow', rate: 28, cap: 260,
    color1: [1, 1, 1, 0.85], color2: [0.95, 0.97, 1, 0.6], dead: [1, 1, 1, 0],
    size: [0.1, 0.24], life: [5, 9], dir1: [-0.3, 0.2, -0.3], dir2: [0.3, 0.6, 0.3], power: [0.2, 0.5], gravity: [0.05, 0.02, 0.03],
    low: true,
  },
  {
    biome: 'thornvine', rate: 70, cap: 420,
    color1: [0.85, 0.72, 0.5, 0.35], color2: [0.75, 0.6, 0.42, 0.25], dead: [0.7, 0.6, 0.45, 0],
    size: [0.15, 0.45], life: [2, 4], dir1: [2.2, 0, 1.4], dir2: [3.6, 0.3, 2.2], power: [0.8, 1.4], gravity: [0, -0.05, 0],
    low: true, ground: true,
  },
]

/** Start the biomes' air. Returns { dispose }. */
export function createAmbience(scene) {
  const textures = [dotTexture(scene, 'infterrain_dot', 0.35), dotTexture(scene, 'infterrain_glint', 0.15)]
  const emitter = new Vector3()
  const systems = KINDS.map((k, i) => {
    const ps = new ParticleSystem(`infterrain_air_${k.biome}_${i}`, Math.ceil(k.cap * AIR), scene)
    ps.particleTexture = k.add ? textures[1] : textures[0]
    ps.emitter = emitter
    ps.minEmitBox = new Vector3(-BOX, k.high ? 6 : k.ground ? -0.5 : -1, -BOX)
    ps.maxEmitBox = new Vector3(BOX, k.high ? 18 : k.ground ? 1.5 : 7, BOX)
    ps.color1 = new Color4(...k.color1)
    ps.color2 = new Color4(...k.color2)
    ps.colorDead = new Color4(...k.dead)
    ps.minSize = k.size[0]; ps.maxSize = k.size[1]
    ps.minLifeTime = k.life[0]; ps.maxLifeTime = k.life[1]
    ps.direction1 = new Vector3(...k.dir1)
    ps.direction2 = new Vector3(...k.dir2)
    ps.minEmitPower = k.power[0]; ps.maxEmitPower = k.power[1]
    ps.gravity = new Vector3(...k.gravity)
    ps.blendMode = k.add ? ParticleSystem.BLENDMODE_ADD : ParticleSystem.BLENDMODE_STANDARD
    ps.updateSpeed = 0.016
    ps.emitRate = 0
    return { ps, k, running: false }
  })

  let frame = 0
  const obs = scene.onBeforeRenderObservable.add(() => {
    const cam = scene.activeCamera
    if (!cam) return
    emitter.set(cam.position.x, cam.position.y - (cam.position.y > 0 ? 1.5 : 0), cam.position.z)
    // the land under the camera only changes over tens of units - no need
    // to ask every frame
    if (frame++ % 15) return
    const w = biomeWeightsAt(cam.position.x, cam.position.z)
    for (const s of systems) {
      const want = s.k.rate * AIR * (w[s.k.biome] ?? 0)
      s.ps.emitRate = want
      if (want > 0.5 && !s.running) { s.ps.start(); s.running = true }
      else if (want <= 0.5 && s.running && s.ps.getActiveCount() === 0) { s.ps.stop(); s.running = false }
    }
  })

  return {
    dispose() {
      scene.onBeforeRenderObservable.remove(obs)
      for (const s of systems) s.ps.dispose(false)
      textures.forEach(t => t.dispose())
    },
  }
}
