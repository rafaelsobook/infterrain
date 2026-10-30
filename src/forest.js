import { Mesh, MeshBuilder, SceneLoader, StandardMaterial, Texture, Color3, Vector3, Quaternion } from '@babylonjs/core'
import '@babylonjs/loaders/glTF'
import { terrainHeight, roadDistance, getMountainFactor, SPAWN_X, SPAWN_Z, WATER_LEVEL, inRiverChannel } from './world'
import { sampleTerrainSurfaceHeight } from './terrain'

const CHUNK_SIZE      = 256
const TREE_GRID       = 35
const VIEW_R          = 1
const UNLOAD_R        = 2
const TREE_BASE_SCALE = 1.0

const FAKE_TREE_IDX  = 3
const FAKE_TREE_SIZE = 35

// modelIdx 0 is the "healthy" tree, picked whenever a slot doesn't roll dead/fake
// (see spawnChunkTrees). modelIdx 1/2 are the dead-tree alternatives, chosen
// between each other via a coinflip. Pass a same-shaped 3-path array to
// createOpenWorld()/createForest() to swap the actual glb assets used for
// each role without touching this file.
// Relative (not root-absolute) - resolves against wherever index.html is
// actually served from, rather than assuming the app sits at the domain
// root. Callers that pass their own paths to createOpenWorld()/createForest()
// aren't affected either way, but these are the fallback if they don't.
export const DEFAULT_TREE_PATHS = [
  './models/trees/tree_1.glb',
  './models/trees/dead_tree_1.glb',
  './models/trees/deadtree1.glb',
]

// Billboard impostor used for far/cheap trees (modelIdx FAKE_TREE_IDX) — a
// flat plane textured with this cutout, always facing the camera.
export const DEFAULT_FAKE_TREE_PATH = './images/fakeprops/faketree.webp'

// Leaf textures here are photo cutouts on a white background — the white
// bleeds through the leaf gaps even at full res, and once GPU-generated
// mipmaps kick in for small/distant tree instances, that white gets
// averaged into the leaf color too, turning far canopies pale/white.
// Forcing bilinear-only (no mip) sampling keeps every instance reading the
// unblurred, correctly-colored top-level texture, trading a bit of
// distant shimmer for not having ghost-white trees.
function disableFoliageMips(material) {
  const mats = material?.subMaterials ?? (material ? [material] : [])
  mats.forEach(m => {
    const tex = m?.diffuseTexture ?? m?.albedoTexture
    if (tex) tex.updateSamplingMode(Texture.LINEAR_LINEAR)
  })
}

function rnd(a, b) {
  let v = (7 * 1234567 + a * 374761393 + b * 668265263) | 0
  v = Math.imul(v ^ (v >>> 13), 1274126177)
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296
}

function buildFakeTreeMaster(scene, fakeTreePath) {
  const master = MeshBuilder.CreatePlane('master_fakeTree', { size: FAKE_TREE_SIZE }, scene)
  const mat = new StandardMaterial('fakeTreeMat', scene)
  const tex = new Texture(fakeTreePath, scene)
  tex.hasAlpha = true
  tex.updateSamplingMode(Texture.LINEAR_LINEAR)
  mat.diffuseTexture  = tex
  mat.specularColor   = new Color3(0, 0, 0)
  mat.backFaceCulling = false
  master.material    = mat
  master.isVisible   = false
  master.isPickable  = false
  master.billboardMode = Mesh.BILLBOARDMODE_Y
  return { master, groundOffset: FAKE_TREE_SIZE / 2, billboard: true }
}

async function loadMasters(scene, treePaths, fakeTreePath) {
  const masters = []
  for (const path of treePaths) {
    const { meshes } = await SceneLoader.ImportMeshAsync('', '', path, scene)
    const geom = meshes.filter(m => m.getTotalVertices() > 0)
    const master = Mesh.MergeMeshes(geom, true, true, undefined, false, true) ?? geom[0]
    master.name = `master_${path}`
    master.refreshBoundingInfo()
    disableFoliageMips(master.material)
    const minY = master.getBoundingInfo().boundingBox.minimum.y
    const groundOffset = -minY
    master.isVisible  = false
    master.isPickable = false
    meshes.filter(m => m.getTotalVertices() === 0).forEach(m => m.dispose())
    masters.push({ master, groundOffset })
  }
  masters[FAKE_TREE_IDX] = buildFakeTreeMaster(scene, fakeTreePath)
  return masters
}

const UP = Vector3.Up()

function alignToNormal(normal, yaw) {
  const yawQuat = Quaternion.RotationAxis(UP, yaw)
  const axis = Vector3.Cross(UP, normal)
  const axisLen = axis.length()
  if (axisLen < 1e-6) return yawQuat
  axis.scaleInPlace(1 / axisLen)
  const angle = Math.acos(Math.min(1, Math.max(-1, Vector3.Dot(UP, normal))))
  const tiltQuat = Quaternion.RotationAxis(axis, angle)
  return tiltQuat.multiply(yawQuat)
}

function spawnChunkTrees(masters, ox, oz, verts) {
  const insts = []
  const slots = Math.ceil(CHUNK_SIZE / TREE_GRID)
  for (let iz = 0; iz < slots; iz++) {
    for (let ix = 0; ix < slots; ix++) {
      const bx = ox + ix * TREE_GRID
      const bz = oz + iz * TREE_GRID
      const k1 = bx | 0, k2 = bz | 0
      if (rnd(k1, k2) > 0.40) continue
      const wx = bx + (rnd(k1, k2 + 1) - 0.5) * TREE_GRID * 0.75
      const wz = bz + (rnd(k1 + 1, k2) - 0.5) * TREE_GRID * 0.75
      const dHub = Math.hypot(wx - SPAWN_X, wz - SPAWN_Z)
      if (dHub < 350) continue
      if (roadDistance(wx, wz) < 9) continue
      // out of the water, and off the immediate shore too - a tree trunk
      // standing at the exact waterline reads as a mistake. Same reasoning
      // grass.js gives for why WATER_LEVEL alone does not cover the river
      if (inRiverChannel(wx, wz, 4)) continue
      const hRaw = terrainHeight(wx, wz)
      if (hRaw < WATER_LEVEL + 2) continue
      const hX  = terrainHeight(wx + 5, wz)
      const hZ  = terrainHeight(wx, wz + 5)
      const dhx = (hX - hRaw) / 5
      const dhz = (hZ - hRaw) / 5
      const slope = Math.hypot(dhx, dhz)
      if (slope > 0.38) continue
      const mf = getMountainFactor(wx, wz)
      if (mf > 0.35 && slope > 0.10) continue
      const deadBias = Math.max(0, (dHub - 4000) / 9000)
      const typeRoll = rnd(k1 + 7, k2 + 11)
      const fakeRoll = rnd(k1 + 15, k2 + 17)
      let modelIdx = 0
      if (fakeRoll < 0.20) {
        modelIdx = FAKE_TREE_IDX
      } else if (mf > 0.35 || typeRoll < deadBias * 0.65) {
        modelIdx = rnd(k1 + 3, k2 + 3) > 0.5 ? 1 : 2
      }
      const rotY  = rnd(k1 + 5, k2) * Math.PI * 2
      const scale = (0.85 + rnd(k1, k2 + 7) * 0.50) * TREE_BASE_SCALE
      const { master, groundOffset, billboard } = masters[modelIdx]
      const inst = master.createInstance(`t${k1}_${k2}`)
      const sink = groundOffset === 0 ? -(0.5 + rnd(k1 + 9, k2 + 13) * 0.5) : 0
      // Ground on the same flat-shaded surface the chunk mesh actually draws
      // (not the raw analytic terrainHeight), so trees don't float over/sink
      // into the coarse mesh wherever the real curve bulges away from it.
      const hGround = sampleTerrainSurfaceHeight(wx, wz, verts)
      inst.position.set(wx, hGround + groundOffset * scale + sink, wz)
      if (billboard) {
        inst.billboardMode = Mesh.BILLBOARDMODE_Y
      } else {
        const normal = new Vector3(-dhx, 1, -dhz).normalize()
        inst.rotationQuaternion = alignToNormal(normal, rotY)
      }
      inst.scaling.setAll(scale)
      inst.isPickable = false
      insts.push(inst)
    }
  }
  return insts
}

export async function createForest(scene, treePaths = DEFAULT_TREE_PATHS, fakeTreePath = DEFAULT_FAKE_TREE_PATH, verts = 17) {
  const masters    = await loadMasters(scene, treePaths, fakeTreePath)
  const treeChunks = new Map()
  const buildQueue = []
  const QUEUE_BATCH = 6

  function enqueue(key, ox, oz, dist2) {
    let lo = 0, hi = buildQueue.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; buildQueue[mid].dist2 < dist2 ? lo = mid + 1 : hi = mid }
    buildQueue.splice(lo, 0, { key, ox, oz, dist2 })
  }

  function update(camX, camZ) {
    const cx0 = Math.floor(camX / CHUNK_SIZE)
    const cz0 = Math.floor(camZ / CHUNK_SIZE)
    for (const [key, insts] of treeChunks) {
      const [cx, cz] = key.split(',').map(Number)
      if (Math.abs(cx - cx0) > UNLOAD_R || Math.abs(cz - cz0) > UNLOAD_R) {
        insts.forEach(i => i.dispose())
        treeChunks.delete(key)
      }
    }
    for (let dz = -VIEW_R; dz <= VIEW_R; dz++) {
      for (let dx = -VIEW_R; dx <= VIEW_R; dx++) {
        const key = `${cx0 + dx},${cz0 + dz}`
        if (!treeChunks.has(key) && !buildQueue.some(q => q.key === key)) {
          enqueue(key, (cx0 + dx) * CHUNK_SIZE, (cz0 + dz) * CHUNK_SIZE, dx*dx + dz*dz)
        }
      }
    }
  }

  update(SPAWN_X, SPAWN_Z)

  let prevCX = null, prevCZ = null
  scene.onBeforeRenderObservable.add(() => {
    if (!scene.activeCamera) return
    for (let i = 0; i < QUEUE_BATCH && buildQueue.length; i++) {
      const { key, ox, oz } = buildQueue.shift()
      if (!treeChunks.has(key)) treeChunks.set(key, spawnChunkTrees(masters, ox, oz, verts))
    }
    const { x, z } = scene.activeCamera.position
    const cx = Math.floor(x / CHUNK_SIZE)
    const cz = Math.floor(z / CHUNK_SIZE)
    if (cx !== prevCX || cz !== prevCZ) {
      prevCX = cx; prevCZ = cz
      update(x, z)
    }
  })
}
