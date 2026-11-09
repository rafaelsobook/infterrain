import { TransformNode, PhysicsAggregate, PhysicsShapeType, Vector3, Quaternion } from '@babylonjs/core'

// Static box colliders for the walkable and solid parts of the features - a
// well's rim and shaft and stairs, a cave's walls, a cloud you can stand on.
//
// Only if the host scene runs physics (Babylon's v2 engine - Havok); with none,
// every call here is a no-op and the features are scenery. Boxes only: they are
// what every Havok host can rely on (the vessel client found Havok's mesh
// shape never collides in its build, and builds its castles from boxes for the
// same reason). Each box is posed BEFORE its body exists - a static body takes
// its transform once, at creation, and never re-reads it.
//
// The camera. A host whose third-person camera pulls in when something solid
// comes between it and the player (the vessel client raycasts for exactly
// that) would have its camera snap to the player's head every time a cloud
// or a stair rail passed behind - so things you walk under or past can be
// put in a collision-filter group the camera's ray skips. `passMask` is that
// membership bit; the default, 1 << 30, is the one the vessel client's camera
// ignores. The player still collides with them as normal.

//
// Queued. A body takes a fraction of a millisecond to make, and a chunk's
// growth and places can want hundreds of them - made all at once that was
// half a second of frozen frame the moment a chunk streamed in. So box() only records what to build, and
// flush() builds as many as fit in a time budget each frame. A feature
// streams in a chunk or two away from the player, long before anyone is
// close enough to touch it, so its colliders are always there in time.
export class Colliders {
  constructor(scene, { enabled = true, passMask = 1 << 30, friction = 1 } = {}) {
    this.scene = scene
    this.passMask = passMask
    this.friction = friction
    const engine = scene.getPhysicsEngine?.()
    this.enabled = enabled && !!engine && (engine.getPluginVersion?.() ?? 2) === 2
    this.nodes = []
    this.pending = []
    // while true, box() builds at once instead of queueing - for the few
    // that must exist the moment their feature does: a lid over a pit,
    // which someone teleported onto it would otherwise fall straight through
    this.urgent = false
  }

  /** Build queued colliders until `budgetMs` is spent. Returns how many are left. */
  flush(budgetMs = Infinity) {
    const t0 = performance.now()
    let i = 0
    while (i < this.pending.length && performance.now() - t0 < budgetMs) this.make(...this.pending[i++])
    this.pending.splice(0, i)
    return this.pending.length
  }

  /**
   * A box centred at (x, y, z), w x h x d, turned by yaw about Y and then
   * pitched by `pitch` about its own X (positive tips its +Z end down).
   * `passCamera` puts it in the group the host camera's ray ignores.
   * `friction` overrides the default - a cloud's is 0, see builders.js.
   */
  box(x, y, z, w, h, d, yaw = 0, pitch = 0, passCamera = false, friction = this.friction) {
    if (!this.enabled) return
    if (this.urgent) this.make(x, y, z, w, h, d, yaw, pitch, passCamera, friction)
    else this.pending.push([x, y, z, w, h, d, yaw, pitch, passCamera, friction])
  }

  make(x, y, z, w, h, d, yaw, pitch, passCamera, friction) {
    const node = new TransformNode('infterrain_collider', this.scene)
    node.position.set(x, y, z)
    node.rotationQuaternion = Quaternion.RotationYawPitchRoll(yaw, pitch, 0)
    node.computeWorldMatrix(true)
    const agg = new PhysicsAggregate(node, PhysicsShapeType.BOX, {
      mass: 0,
      friction,
      restitution: 0,
      center: Vector3.Zero(),
      extents: new Vector3(w, h, d),
    }, this.scene)
    if (passCamera && this.passMask) agg.shape.filterMembershipMask = this.passMask
    this.nodes.push(node)
    return node
  }

  /**
   * A ramp whose TOP FACE runs from (x0, y0, z0) up to (x1, y1, z1), `width`
   * wide and `thick` deep under that face - walkable at up to the slope the
   * host's body can climb (about 0.65 rise per run for the vessel player).
   */
  ramp(x0, y0, z0, x1, y1, z1, width, thick = 0.4, passCamera = true) {
    const dx = x1 - x0, dz = z1 - z0, dy = y1 - y0
    const run = Math.hypot(dx, dz)
    const len = Math.hypot(run, dy)
    const yaw = Math.atan2(dx, dz)
    const pitch = -Math.atan2(dy, run)
    // the box's centre sits half its thickness below the top face's middle,
    // along the face's own normal
    const nx = Math.sin(yaw) * Math.sin(-pitch) * -1, ny = Math.cos(pitch), nz = Math.cos(yaw) * Math.sin(-pitch) * -1
    const cx = (x0 + x1) / 2 - nx * thick / 2
    const cy = (y0 + y1) / 2 - ny * thick / 2
    const cz = (z0 + z1) / 2 - nz * thick / 2
    return this.box(cx, cy, cz, width, thick, len, yaw, pitch, passCamera)
  }

  dispose() {
    this.pending.length = 0
    for (const n of this.nodes) n.dispose()
    this.nodes.length = 0
  }
}
