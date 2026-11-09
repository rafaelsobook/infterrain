import { Mesh, VertexData, Matrix, Vector3 } from '@babylonjs/core'

// A small procedural-geometry builder for the props (features.js and the
// builders/). Everything is baked into one vertex list with a per-vertex
// RGBA colour - rgb is the tint, alpha is how strongly that vertex glows (the
// prop shader multiplies its glow colour by it) - so a whole prop, trunk,
// leaves and lit-up bits together, is one mesh and one draw call.

export class Geo {
  constructor() {
    this.pos = []
    this.nrm = []
    this.col = []
    this.idx = []
  }

  get vertexCount() { return this.pos.length / 3 }

  vert(x, y, z, nx, ny, nz, c) {
    this.pos.push(x, y, z)
    this.nrm.push(nx, ny, nz)
    this.col.push(c[0], c[1], c[2], c[3] ?? 0)
    return this.pos.length / 3 - 1
  }

  tri(a, b, c) { this.idx.push(a, b, c) }

  /**
   * A flat-shaded triangle with its own vertices - crisp facets for ice and
   * crystal. `inside` is any point behind the face (the middle of the solid
   * it belongs to); the face is turned to look away from it.
   *
   * Babylon draws a triangle's front when cross(b - a, c - a) points AWAY
   * from the viewer - the opposite of the usual right-handed habit - so the
   * outward normal here is cross(c - a, b - a).
   */
  facet(a, b, c, col, inside = null) {
    let ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2]
    let vx = b[0] - a[0], vy = b[1] - a[1], vz = b[2] - a[2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l; ny /= l; nz /= l
    if (inside) {
      const ox = a[0] - inside[0], oy = a[1] - inside[1], oz = a[2] - inside[2]
      if (nx * ox + ny * oy + nz * oz < 0) { const s = b; b = c; c = s; nx = -nx; ny = -ny; nz = -nz }
    }
    const i = this.vert(a[0], a[1], a[2], nx, ny, nz, col)
    this.vert(b[0], b[1], b[2], nx, ny, nz, col)
    this.vert(c[0], c[1], c[2], nx, ny, nz, col)
    this.idx.push(i, i + 1, i + 2)
  }

  /**
   * A tube along a path of {x, y, z, r} points, smooth-shaded, with frames
   * carried along the path so it never twists on itself. `color(t, side)`
   * returns the RGBA for a ring at t (0..1 along) - or pass an array.
   */
  tube(path, sides, color, { capStart = false, capEnd = true, wobble = null } = {}) {
    const n = path.length
    if (n < 2) return
    const colorAt = typeof color === 'function' ? color : () => color
    // tangents
    const T = path.map((p, i) => {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)]
      const v = new Vector3(b.x - a.x, b.y - a.y, b.z - a.z)
      return v.normalize()
    })
    // a starting normal not parallel to the first tangent, then parallel transport
    let N = Math.abs(T[0].y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)
    N = Vector3.Cross(T[0], Vector3.Cross(N, T[0])).normalize()
    const rings = []
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const axis = Vector3.Cross(T[i - 1], T[i])
        const s = axis.length()
        if (s > 1e-6) {
          const ang = Math.asin(Math.min(1, s))
          const q = Matrix.RotationAxis(axis.normalize(), ang)
          N = Vector3.TransformNormal(N, q).normalize()
        }
      }
      const B = Vector3.Cross(T[i], N).normalize()
      const p = path[i]
      const t = i / (n - 1)
      const ring = []
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2
        const ca = Math.cos(a), sa = Math.sin(a)
        const r = p.r * (wobble ? wobble(t, s / sides) : 1)
        const nx = N.x * ca + B.x * sa, ny = N.y * ca + B.y * sa, nz = N.z * ca + B.z * sa
        ring.push(this.vert(p.x + nx * r, p.y + ny * r, p.z + nz * r, nx, ny, nz, colorAt(t, s / sides)))
      }
      rings.push(ring)
    }
    for (let i = 0; i < n - 1; i++)
      for (let s = 0; s < sides; s++) {
        const a = rings[i][s], b = rings[i][s + 1], c = rings[i + 1][s], d = rings[i + 1][s + 1]
        this.idx.push(a, c, b, b, c, d)
      }
    const cap = (i, dir) => {
      const p = path[i], t = T[i]
      const c = colorAt(i / (n - 1), 0)
      const center = this.vert(p.x, p.y, p.z, t.x * dir, t.y * dir, t.z * dir, c)
      const ring = rings[i]
      for (let s = 0; s < sides; s++) {
        if (dir > 0) this.idx.push(center, ring[s], ring[s + 1])
        else this.idx.push(center, ring[s + 1], ring[s])
      }
    }
    if (capStart) cap(0, -1)
    if (capEnd && path[n - 1].r > 1e-4) cap(n - 1, 1)
  }

  /**
   * A faceted prism standing on `base`, pointing along `dir`: `sides` faces,
   * radius r at the bottom, tapering by `taper` (0 none, 1 to a point at
   * the top) and optionally capped by a pyramid `tip` long - a crystal.
   */
  crystal(base, dir, r, length, sides, color, { taper = 0.15, tip = r * 1.6, twist = 0 } = {}) {
    const D = new Vector3(dir[0], dir[1], dir[2]).normalize()
    let U = Math.abs(D.y) < 0.95 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)
    const A = Vector3.Cross(D, U).normalize()
    const B = Vector3.Cross(A, D).normalize()
    const ringAt = (dist, rad, rot) => {
      const out = []
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2 + rot
        const ca = Math.cos(a) * rad, sa = Math.sin(a) * rad
        out.push([
          base[0] + D.x * dist + A.x * ca + B.x * sa,
          base[1] + D.y * dist + A.y * ca + B.y * sa,
          base[2] + D.z * dist + A.z * ca + B.z * sa,
        ])
      }
      return out
    }
    const bottom = ringAt(0, r, 0)
    const top = ringAt(length, r * (1 - taper), twist)
    const apex = [base[0] + D.x * (length + tip), base[1] + D.y * (length + tip), base[2] + D.z * (length + tip)]
    const lowerC = typeof color === 'function' ? color(0) : color
    const upperC = typeof color === 'function' ? color(1) : color
    const mid = [base[0] + D.x * length * 0.5, base[1] + D.y * length * 0.5, base[2] + D.z * length * 0.5]
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides
      this.facet(bottom[s], top[s], bottom[s2], lowerC, mid)
      this.facet(bottom[s2], top[s], top[s2], lowerC, mid)
      this.facet(top[s], apex, top[s2], upperC, mid)
    }
  }

  /**
   * A lumpy sphere - cloud puffs, boulders. An icosphere pushed in and out by
   * `bump(nx, ny, nz)` (a scale near 1), smooth normals recomputed after.
   */
  blob(cx, cy, cz, rx, ry, rz, detail, color, bump = null) {
    const { verts, local } = icosphere(detail)
    const start = this.vertexCount
    if (!bump) {
      // an ellipsoid: its normals are exact without recomputing anything
      for (const [x, y, z] of verts) {
        let nx = x / rx, ny = y / ry, nz = z / rz
        const l = Math.hypot(nx, ny, nz) || 1
        const c = typeof color === 'function' ? color(x, y, z) : color
        this.vert(cx + x * rx, cy + y * ry, cz + z * rz, nx / l, ny / l, nz / l, c)
      }
      for (const i of local) this.idx.push(start + i)
      return
    }
    const localPos = []
    for (const [x, y, z] of verts) {
      const k = bump(x, y, z)
      const px = cx + x * rx * k, py = cy + y * ry * k, pz = cz + z * rz * k
      localPos.push(px, py, pz)
      const c = typeof color === 'function' ? color(x, y, z) : color
      this.vert(px, py, pz, x, y, z, c)
    }
    // smooth normals off the bumped surface
    const normals = []
    VertexData.ComputeNormals(localPos, local, normals)
    for (let i = 0; i < verts.length; i++) {
      this.nrm[(start + i) * 3] = normals[i * 3]
      this.nrm[(start + i) * 3 + 1] = normals[i * 3 + 1]
      this.nrm[(start + i) * 3 + 2] = normals[i * 3 + 2]
    }
    for (const i of local) this.idx.push(start + i)
  }

  /**
   * A broken chunk of stone: an icosphere (detail 0 or 1) pushed in and out by
   * `bump()` (a scale near 1, once a corner), turned by yaw, every face flat.
   * `color(nx, ny, nz)` is given each face's outward normal.
   */
  rock(cx, cy, cz, rx, ry, rz, detail, color, bump, yaw = 0) {
    const { verts, local } = icosphere(detail)
    const c = Math.cos(yaw), s = Math.sin(yaw)
    const p = verts.map(([x, y, z]) => {
      const k = bump()
      const lx = x * rx * k, ly = y * ry * k, lz = z * rz * k
      return [cx + lx * c + lz * s, cy + ly, cz - lx * s + lz * c]
    })
    const inside = [cx, cy, cz]
    for (let i = 0; i < local.length; i += 3) {
      const a = p[local[i]], b = p[local[i + 1]], d = p[local[i + 2]]
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
      const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2]
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      const l = Math.hypot(nx, ny, nz) || 1
      const out = nx * (a[0] - cx) + ny * (a[1] - cy) + nz * (a[2] - cz) < 0 ? -1 / l : 1 / l
      this.facet(a, b, d, color(nx * out, ny * out, nz * out), inside)
    }
  }

  /** An axis-aligned box rotated by yaw about its centre, flat faces. */
  box(cx, cy, cz, w, h, d, yaw, color, pitch = 0) {
    const m = Matrix.RotationYawPitchRoll(yaw, pitch, 0)
    const hw = w / 2, hh = h / 2, hd = d / 2
    const corner = (sx, sy, sz) => {
      const v = Vector3.TransformCoordinates(new Vector3(sx * hw, sy * hh, sz * hd), m)
      return [cx + v.x, cy + v.y, cz + v.z]
    }
    const faces = [
      [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
      [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
      [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]],
      [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]],
      [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]],
      [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]],
    ]
    const inside = [cx, cy, cz]
    for (const f of faces) {
      const q = f.map(c => corner(...c))
      const col = typeof color === 'function' ? color(f) : color
      this.facet(q[0], q[2], q[1], col, inside)
      this.facet(q[0], q[3], q[2], col, inside)
    }
  }

  /** Append another Geo, transformed by a Babylon Matrix. */
  add(other, matrix = null) {
    const base = this.vertexCount
    for (let i = 0; i < other.pos.length; i += 3) {
      let x = other.pos[i], y = other.pos[i + 1], z = other.pos[i + 2]
      let nx = other.nrm[i], ny = other.nrm[i + 1], nz = other.nrm[i + 2]
      if (matrix) {
        const p = Vector3.TransformCoordinatesFromFloatsToRef(x, y, z, matrix, TMP)
        x = p.x; y = p.y; z = p.z
        const n = Vector3.TransformNormalFromFloatsToRef(nx, ny, nz, matrix, TMP2)
        const l = Math.hypot(n.x, n.y, n.z) || 1
        nx = n.x / l; ny = n.y / l; nz = n.z / l
      }
      this.pos.push(x, y, z)
      this.nrm.push(nx, ny, nz)
    }
    for (const c of other.col) this.col.push(c)
    for (const i of other.idx) this.idx.push(base + i)
  }

  toMesh(name, scene, material) {
    const vd = new VertexData()
    vd.positions = this.pos
    vd.normals = this.nrm
    vd.colors = this.col
    vd.indices = this.idx
    const mesh = new Mesh(name, scene)
    vd.applyToMesh(mesh)
    if (material) mesh.material = material
    mesh.isPickable = false
    return mesh
  }
}
const TMP = new Vector3()
const TMP2 = new Vector3()

// Unit icospheres by subdivision level, built once - every puff of every
// cloud, every tuft on a skyneedle used to subdivide its own from scratch
const icoCache = new Map()
function icosphere(detail) {
  let ico = icoCache.get(detail)
  if (ico) return ico
  const t = (1 + Math.sqrt(5)) / 2
  const verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map(v => { const l = Math.hypot(...v); return v.map(c => c / l) })
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]
  for (let d = 0; d < detail; d++) {
    const mid = new Map()
    const midpoint = (p, q) => {
      const key = p < q ? p * 100000 + q : q * 100000 + p
      let m = mid.get(key)
      if (m === undefined) {
        const v = verts[p].map((c, i) => (c + verts[q][i]) / 2)
        const l = Math.hypot(...v)
        verts.push(v.map(c => c / l))
        m = verts.length - 1
        mid.set(key, m)
      }
      return m
    }
    const next = []
    for (const [p, q, r] of faces) {
      const pq = midpoint(p, q), qr = midpoint(q, r), rp = midpoint(r, p)
      next.push([p, pq, rp], [q, qr, pq], [r, rp, qr], [pq, qr, rp])
    }
    faces = next
  }
  // wound for Babylon (see facet()): front faces outward
  const local = []
  for (const [p, q, r] of faces) local.push(p, r, q)
  ico = { verts, local }
  icoCache.set(detail, ico)
  return ico
}

/** Mix two RGBA colours. */
export function mixColor(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, (a[3] ?? 0) + ((b[3] ?? 0) - (a[3] ?? 0)) * t]
}

/** A small deterministic random stream, so a prop built twice is built the same. */
export function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}
