import { Quaternion, Vector3 } from '@babylonjs/core'
import { crystalClusterGeo, CRYSTAL_PALETTES } from './flora'
import { propMaterial } from './materials'
import { MATERIALS } from './features'

// One crystal cluster for a host to stand wherever it likes - the Crystal
// Hollows' own look, as a single mesh of its own rather than an instance. A
// host that turns a crystal into something real (a deposit to mine, a quest
// item) builds it with this, so the real ones match the scenery around them.
//
// opts
//   palette  0 violet, 1 teal, 2 rose
//   scale    size, 1 is a cluster about 6 tall
//   seed     which shape (any number)
//   yaw      turn about Y
// The mesh's origin is the cluster's base; its `height` is how tall it stands.
// Textures: pass the same propTextures as createOpenWorld to match its look.
const materials = new WeakMap()
function crystalMaterial(scene, palette, propTextures) {
  let byPalette = materials.get(scene)
  if (!byPalette) materials.set(scene, byPalette = new Map())
  let m = byPalette.get(palette)
  if (!m || m.isDisposed?.()) {
    m = propMaterial(scene, `crystal${palette}`, MATERIALS[`crystal${palette}`], propTextures)
    byPalette.set(palette, m)
  }
  return m
}

export function createCrystalNode(scene, position, opts = {}, propTextures = {}) {
  const palette = ((opts.palette ?? 0) % 3 + 3) % 3
  const scale = opts.scale ?? 1
  const built = crystalClusterGeo(4099 + (opts.seed ?? 0) * 7919, CRYSTAL_PALETTES[palette])
  const mesh = built.geo.toMesh('infterrain_crystal_node', scene, crystalMaterial(scene, palette, propTextures))
  mesh.position = new Vector3(position.x, position.y, position.z)
  if (opts.yaw) mesh.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), opts.yaw)
  mesh.scaling.setAll(scale)
  mesh.isPickable = false
  mesh.height = built.height * scale
  return mesh
}
