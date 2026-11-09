import { Mesh, VertexData, Matrix, Vector3, ParticleSystem, Color4, DynamicTexture } from '@babylonjs/core'
import { Geo, mixColor, rng } from './geo'
import { WELL, FALLS, inSiteFootprint } from './sites'
import { WATER_LEVEL, inRiverChannel } from './world'
import { buildGroundPatch } from './terrain'
import { drawnHeight } from './ground'
import { crystalClusterGeo, CRYSTAL_PALETTES, boulderGeo, mushroomGeo, needleGeo, cloudGeo } from './flora'
import { fallsMaterials } from './waterfall'
import { buildGrotto, grottoStashSpots } from './grotto'

// ── Building the special places (sites.js says where they are) ──────────────
//
// Each builder takes the site and the chunk's context (features.js) and
// leaves its meshes in ctx.meshes and its colliders in ctx.colliders, so the
// chunk can throw them all away together. Geometry is built in each site's
// own frame - origin on its ground, +Z the way it faces - and the mesh placed
// there, so the procedural grain (materials.js) stays put on it and the
// numbers stay small.
//
// Every collider is a box (colliders.js says why). The rule throughout: what
// you walk on is a ramp no steeper than ~0.5 rise per run (the vessel player
// climbs up to ~0.65, and cannot step up a ledge more than a few centimetres),
// and what you are meant to fall into has walls all the way down.

const TAU = Math.PI * 2

/** Build one site's meshes and colliders; returns { kind, key, x, y, z, spots }. */
export function buildSiteFeature(ctx, site) {
  switch (site.kind) {
    case 'well': return buildWell(ctx, site)
    case 'grotto': return buildGrotto(ctx, site)
    case 'falls': return buildFalls(ctx, site)
    case 'cloudstep': return buildCloudstep(ctx, site)
    case 'needle': return buildNeedle(ctx, site)
    case 'rising': return buildRising(ctx, site)
  }
  return null
}

// a site's frame: origin (ox, oy, oz), turned by yaw about Y
function frame(ox, oy, oz, yaw = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw)
  return {
    ox, oy, oz, yaw,
    w: (x, y, z) => [ox + x * c + z * s, oy + y, oz - x * s + z * c],
  }
}
function boxF(ctx, f, x, y, z, w, h, d, yaw = 0, pitch = 0, pass = false, friction) {
  const [X, Y, Z] = f.w(x, y, z)
  return ctx.colliders.box(X, Y, Z, w, h, d, f.yaw + yaw, pitch, pass, friction)
}
// Clouds are frictionless. A player who jumps while already pressed against
// a cloud's side (friction 1 on both, as the vessel player's body has) is
// dragged by it and never rises clear of the edge - flat tops, so standing
// still on one does not slide either way
const CLOUD_FRICTION = 0
function rampF(ctx, f, x0, y0, z0, x1, y1, z1, width, pass = true) {
  const a = f.w(x0, y0, z0), b = f.w(x1, y1, z1)
  return ctx.colliders.ramp(a[0], a[1], a[2], b[0], b[1], b[2], width, 0.4, pass)
}
function place(ctx, geo, f, name, matName) {
  if (!geo.idx.length) return null
  const mesh = geo.toMesh(name, ctx.scene, ctx.material(matName))
  mesh.position.set(f.ox, f.oy, f.oz)
  mesh.rotation.y = f.yaw
  mesh.freezeWorldMatrix()
  ctx.meshes.push(mesh)
  return mesh
}
const angDist = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))
const scaleRGB = (c, k) => [c[0] * k, c[1] * k, c[2] * k, c[3] ?? 0]

// the cave behind the falls: how far its centre sits back from the massif's
// front edge, and its radius
const FALLS_CAVE = { back: 15, r: 7 }

// ── Stash spots ─────────────────────────────────────────────────────────────
// Open floor in the hidden places - down the well, in the cave behind the
// falls - for a host to leave things at: a chest, a sword struck into the
// floor, a patch of something worth picking. Each builder keeps its fallen
// stones, crystals and stalagmites off them, so whatever is put there
// stands on bare floor. (x, z) in each place's own frame - the falls' from
// the middle of its cave; stashSpots() below gives them in the world. The
// grotto's are worked out with its maze (grotto.js), and it has more: ores.
const STASH = {
  // the shaft's open middle (the stairs keep to a band round the walls),
  // either side of the puddle
  well: { chest: [-1.9, 1.7], weapon: [2.4, 1.9], patch: [-3.6, -1.6] },
  // the weapon just behind the plinth, lit by what stands on it
  falls: { chest: [3, -4.2], weapon: [0, -3.2], patch: [-3.4, -3.6] },
}
const STASH_CLEAR = 1.4
// is (x, z) within reach of any of these spots - `pad` for a prop's own size
const nearStash = (spots, x, z, pad = 0) => Object.values(spots).some(([sx, sz]) => Math.hypot(x - sx, z - sz) < STASH_CLEAR + pad)
// a prop at angle `a`, `d` out from (cx, cz): the first quarter turn round
// that keeps it off the spots, or null when every one lands on one
function clearOfStash(spots, a, d, pad, cx = 0, cz = 0) {
  for (let q = 0; q < 4; q++) {
    const aa = a + q * Math.PI / 2
    if (!nearStash(spots, cx + Math.cos(aa) * d, cz + Math.sin(aa) * d, pad)) return aa
  }
  return null
}

/**
 * A hidden place's stash spots, in the world - [{ name, x, y, z }] on its
 * floor, names as in STASH (a grotto's also 'ore0', 'ore1'...) - or [] for a
 * kind without any. Pure, so a server with no scene can ask too (index.js's
 * siteStashSpots).
 */
export function stashSpots(s) {
  let f, y, cz = 0
  if (s.kind === 'well') { f = frame(s.x, s.H, s.z, s.turn * Math.PI / 2); y = -s.depth }
  else if (s.kind === 'grotto') return grottoStashSpots(s)
  else if (s.kind === 'falls') { f = frame(s.massif.x, s.H, s.massif.z, s.yaw); y = 0; cz = FALLS.halfD - FALLS_CAVE.back }
  else return []
  return Object.entries(STASH[s.kind]).map(([name, [x, z]]) => ({ name, ...xyz(f.w(x, y, cz + z)) }))
}

// The inside walls of a box shaft, seen from inside: half-size (hx, hz),
// from y0 up to y1, `rows` bands high so the colour can darken down it.
// Each wall has its own vertices, so the corners stay sharp, and they go
// round from +x toward +z, wound to face the middle - see geo.js's facet()
// for Babylon's winding. `color(y, u)` gives each vertex's RGBA, u being
// how far round the walls it is
function innerBox(g, hx, hz, y0, y1, rows, color) {
  const walls = [
    [hx, -hz, hx, hz, -1, 0],
    [hx, hz, -hx, hz, 0, -1],
    [-hx, hz, -hx, -hz, 1, 0],
    [-hx, -hz, hx, -hz, 0, 1],
  ]
  let u0 = 0
  for (const [ax, az, bx, bz, nx, nz] of walls) {
    const len = Math.hypot(bx - ax, bz - az)
    const cols = Math.max(1, Math.round(len / 1.6))
    const base = g.vertexCount
    for (let k = 0; k <= rows; k++) {
      const y = y0 + (y1 - y0) * (k / rows)
      for (let c = 0; c <= cols; c++) {
        const t = c / cols
        g.vert(ax + (bx - ax) * t, y, az + (bz - az) * t, nx, 0, nz, color(y, u0 + len * t))
      }
    }
    for (let k = 0; k < rows; k++)
      for (let c = 0; c < cols; c++) {
        const A = base + k * (cols + 1) + c, B = A + 1, C = A + cols + 1, D = C + 1
        g.idx.push(A, C, B, B, C, D)
      }
    u0 += len
  }
}

// a cave chamber seen from inside: a short straight wall, then a rough dome
function innerDome(g, cx, cz, r, floorY, wallH, topY, sides, color, skip, seed) {
  const rows = []
  const ys = [floorY, floorY + wallH * 0.5, floorY + wallH]
  const domeRows = 7
  for (let k = 1; k <= domeRows; k++) ys.push(floorY + wallH + (topY - floorY - wallH) * Math.sin((k / domeRows) * Math.PI / 2))
  const rad = y => y <= floorY + wallH ? r : r * Math.cos(Math.asin(Math.min(1, (y - floorY - wallH) / (topY - floorY - wallH)))) + 0.4
  const bump = (a, y) => 1 + 0.07 * Math.sin(a * 5 + seed) * Math.cos(y * 0.9) + 0.05 * Math.sin(a * 13 + y * 2.1 + seed * 2)
  for (const y of ys) {
    const row = []
    for (let sd = 0; sd <= sides; sd++) {
      const a = (sd / sides) * TAU
      const rr = rad(y) * bump(a, y)
      const top = (y - floorY) / (topY - floorY)
      const nx = -Math.cos(a) * (1 - top * 0.7), ny = -top, nz = -Math.sin(a) * (1 - top * 0.7)
      const l = Math.hypot(nx, ny, nz)
      row.push(g.vert(cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr, nx / l, ny / l, nz / l, color(y, a)))
    }
    rows.push(row)
  }
  for (let k = 0; k < rows.length - 1; k++)
    for (let sd = 0; sd < sides; sd++) {
      const a = ((sd + 0.5) / sides) * TAU
      const y = (ys[k] + ys[k + 1]) / 2
      if (skip && skip(a, y)) continue
      const A = rows[k][sd], B = rows[k][sd + 1], C = rows[k + 1][sd], D = rows[k + 1][sd + 1]
      g.idx.push(A, C, B, B, C, D)
    }
  // close the very top
  const last = rows[rows.length - 1]
  const apex = g.vert(cx, topY + 0.2, cz, 0, -1, 0, color(topY, 0))
  for (let sd = 0; sd < sides; sd++) g.idx.push(apex, last[sd + 1], last[sd])
}

// a flat disc facing up
function disc(g, cx, y, cz, r, sides, color) {
  const c = g.vert(cx, y, cz, 0, 1, 0, color)
  const first = g.vertexCount
  for (let sd = 0; sd <= sides; sd++) {
    const a = (sd / sides) * TAU
    g.vert(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r, 0, 1, 0, color)
  }
  for (let sd = 0; sd < sides; sd++) g.idx.push(c, first + sd, first + sd + 1)
}

// ════════════════════════════════════════════════════════════════════════════
// THE WELL - a wide square-cut shaft, plank stairs in flights round its walls
// ════════════════════════════════════════════════════════════════════════════
function buildWell(ctx, s) {
  const { scene, terrainMat, verts } = ctx
  const r = rng(Math.floor(s.seed * 1e6) + 11)
  const F = s.depth, AX = WELL.halfX, AZ = WELL.halfZ, RW = WELL.rimW, RH = WELL.rimH, W = WELL.stairW
  // only ever a quarter turn, so the shaft stays square to the grid its pits
  // and lid are cut in
  const f = frame(s.x, s.H, s.z, s.turn * Math.PI / 2)
  // deeper is darker - the light from the mouth dies off down the shaft
  const shade = y => y >= 0 ? 1 : 1 - 0.7 * Math.pow(Math.min(1, -y / F), 0.55)

  // the ground over the pits, open at the mouth - cut along the mouth's own
  // edges, so the shaft walls meet it without a seam
  const m0 = f.w(-AX, 0, -AZ), m1 = f.w(AX, 0, AZ)
  const mx0 = Math.min(m0[0], m1[0]), mx1 = Math.max(m0[0], m1[0])
  const mz0 = Math.min(m0[2], m1[2]), mz1 = Math.max(m0[2], m1[2])
  ctx.meshes.push(buildGroundPatch(scene, terrainMat, s.lid, (x, z) => x > mx0 && x < mx1 && z > mz0 && z < mz1, verts, 1,
    { x: [mx0, mx1], z: [mz0, mz1] }))

  // ── the stairs' plan, laid out from the top down ──
  // The top landing is in the +x +z corner, level with the ground, and its
  // flight comes up the +x wall toward +z - so the way out is straight on,
  // through a gap in the rim. Going down, each flight runs along the next
  // wall round, until one reaches the floor part-way along its wall. Flights
  // are straight and meet only at flat landings, so the ramps under them
  // have no joints for the player's body to catch on (see the header)
  const SLOPE = 0.47
  const cx = AX - W / 2, cz = AZ - W / 2
  // the corners of the stairs' middle line, in the order the stairs climb
  const corners = [[cx, cz], [-cx, cz], [-cx, -cz], [cx, -cz]]
  const landings = [{ k: 0, y: 0 }], flights = []
  for (let k = 0, y = 0; ;) {
    const kb = (k + 3) % 4
    const [ax, az] = corners[kb], [bx, bz] = corners[k]
    const full = Math.hypot(bx - ax, bz - az)
    const ux = (bx - ax) / full, uz = (bz - az) / full
    // landing edge to landing edge, unless this is the one from the floor
    const run = full - W
    const last = y - SLOPE * run <= -F + 0.03
    const len = last ? (y + F) / SLOPE : run
    // a const of its own for the top - `at` below outlives this pass, and
    // y is lowered for the next flight down before anything calls it
    const x1 = bx - ux * W / 2, y1 = y, z1 = bz - uz * W / 2
    const x0 = x1 - ux * len, z0 = z1 - uz * len, y0 = y1 - SLOPE * len
    flights.push({
      x0, y0, z0, x1, y1, z1, len,
      yaw: Math.atan2(ux, uz), pitch: -Math.atan2(y1 - y0, len), slopeLen: Math.hypot(len, y1 - y0),
      // a point along it (t 0..1), `off` toward the open middle of the shaft
      at: (t, off = 0) => [x0 + (x1 - x0) * t - uz * off, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t + ux * off],
    })
    if (last) break
    y = y0; k = kb
    landings.push({ k, y })
  }
  // rails only from where a slip would hurt, so the foot of the stairs stays
  // open to walk onto from the floor
  const RAIL_FROM = 2.4, RAIL_H = 0.95
  const railFrom = fl => Math.max(0, Math.min(1, (-F + RAIL_FROM - fl.y0) / (fl.y1 - fl.y0)))

  // ── stone: the coping round the mouth, the shaft, the floor ──
  const stone = new Geo()
  // the coping in four runs, the +z one stopping short of the corner the
  // stairs come out at (each run reaches 0.05 in over the shaft's lip)
  const rims = [
    [AX - 0.05, AX + RW, -AZ - RW, AZ + RW],
    [-AX - RW, -AX + 0.05, -AZ - RW, AZ + RW],
    [-AX, AX, -AZ - RW, -AZ + 0.05],
    [-AX, AX - W, AZ - 0.05, AZ + RW],
  ]
  for (const [x0, x1, z0, z1] of rims) {
    const alongX = x1 - x0 >= z1 - z0
    const len = alongX ? x1 - x0 : z1 - z0
    const n = Math.max(1, Math.round(len / 1.25))
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n
      const h = RH * (0.88 + r() * 0.24)
      const tone = 0.5 + r() * 0.12
      const mossy = r() < 0.35
      const top = mossy ? [0.3, 0.42, 0.22, 0] : [tone, tone * 0.98, tone * 0.92, 0]
      const side = [tone * 0.9, tone * 0.88, tone * 0.83, 0]
      stone.box(alongX ? x0 + len * t : (x0 + x1) / 2, h / 2, alongX ? (z0 + z1) / 2 : z0 + len * t,
        alongX ? (len / n) * 0.97 : x1 - x0, h, alongX ? z1 - z0 : (len / n) * 0.97, 0,
        face => face.every(c => c[1] === 1) ? top : side)
    }
  }
  innerBox(stone, AX, AZ, -F - 0.05, 0.02, Math.max(8, Math.ceil(F / 1.1)), (y, u) => {
    const moss = y > -3 ? (1 + y / 3) * 0.5 : 0
    const damp = y < -F + 4 ? 0.7 : 1
    // darker streaks where rain has run down from the rim
    const streak = 1 - 0.14 * Math.max(0, Math.sin(u * 0.9 + s.seed * 30)) * Math.min(1, -y / 6)
    return scaleRGB(mixColor([0.5, 0.49, 0.45, 0], [0.32, 0.44, 0.24, 0], moss), shade(y) * damp * streak)
  })
  const floorC = scaleRGB([0.3, 0.28, 0.25, 0], shade(-F)), under = [0, -F - 5, 0]
  stone.facet([-AX, -F, -AZ], [AX, -F, -AZ], [AX, -F, AZ], floorC, under)
  stone.facet([-AX, -F, -AZ], [AX, -F, AZ], [-AX, -F, AZ], floorC, under)
  // a dark still puddle and a few fallen stones, out in the middle clear of
  // the stairs
  const IX = AX - W - 0.6, IZ = AZ - W - 0.6
  disc(stone, 0.8, -F + 0.02, -0.5, 2.1, 20, [0.04, 0.07, 0.09, 0.08])
  for (let i = 0; i < 9; i++) {
    const bx = (r() * 2 - 1) * IX, bz = (r() * 2 - 1) * IZ, bw = 0.5 + r() * 0.5, bd = 0.4 + r() * 0.4, by = r() * TAU
    // a stone that would land on a stash spot (STASH) is left out
    if (nearStash(STASH.well, bx, bz)) continue
    stone.box(bx, -F + 0.15, bz, bw, 0.3, bd, by, scaleRGB([0.45, 0.44, 0.4, 0], shade(-F)))
  }
  place(ctx, stone, f, `well_stone_${s.key}`, 'stone')

  // ── wood: the flights, the landings, the windlass ──
  const wood = new Geo()
  const plankC = [0.5, 0.36, 0.22, 0], beamC = [0.36, 0.26, 0.16, 0], railC = [0.55, 0.45, 0.3, 0]
  for (const fl of flights) {
    const rise = fl.y1 - fl.y0
    const n = Math.max(1, Math.round(rise / 0.32))
    for (let i = 0; i < n; i++) {
      const [x, y, z] = fl.at((i + 0.5) / n)
      const k = shade(y) * (0.85 + r() * 0.3)
      wood.box(x, y - 0.05, z, W, 0.1, (fl.len / n) * 1.06, fl.yaw, scaleRGB(plankC, k))
      if (i % 3 === 0) {
        // a bracket into the wall under it
        const [bx, by, bz] = fl.at((i + 0.5) / n, -(W / 2 - 0.25))
        wood.box(bx, by - 0.35, bz, 0.5, 0.5, 0.14, fl.yaw, scaleRGB(beamC, k))
      }
    }
    // a stringer under the open edge
    const [sx, sy, sz] = fl.at(0.5, W / 2 - 0.08)
    wood.box(sx, sy - 0.22, sz, 0.14, 0.3, fl.slopeLen, fl.yaw, scaleRGB(beamC, shade(sy)), fl.pitch)
    // posts and a handrail along the open edge - the posts at its ends are
    // the corner posts, below
    const t0 = railFrom(fl)
    if (t0 < 1) {
      const posts = Math.max(1, Math.round(fl.len * (1 - t0) / 2.2))
      for (let i = t0 > 0 ? 0 : 1; i < posts; i++) {
        const [px, py, pz] = fl.at(t0 + (1 - t0) * (i / posts), W / 2 - 0.06)
        wood.box(px, py + RAIL_H / 2, pz, 0.09, RAIL_H, 0.09, fl.yaw, scaleRGB(beamC, shade(py)))
      }
      const [hx, hy, hz] = fl.at((t0 + 1) / 2, W / 2 - 0.06)
      wood.box(hx, hy + RAIL_H, hz, 0.07, 0.07, fl.slopeLen * (1 - t0), fl.yaw, scaleRGB(railC, shade(hy)), fl.pitch)
    }
  }
  for (const { k, y } of landings) {
    const [qx, qz] = corners[k]
    for (let i = 0; i < 4; i++) {
      wood.box(qx, y - 0.05, qz - W / 2 + W * (i + 0.5) / 4, W, 0.1, (W / 4) * 0.96, 0, scaleRGB(plankC, shade(y) * (0.85 + r() * 0.3)))
    }
    for (const sg of [-1, 1]) wood.box(qx + sg * (W / 2 - 0.1), y - 0.2, qz, 0.12, 0.2, W, 0, scaleRGB(beamC, shade(y)))
  }
  // a post at each corner's inner edge, from the floor up past its highest
  // landing - every landing in that corner hangs off the same post. In
  // pieces, so it darkens down the shaft with everything else
  for (let k = 0; k < 4; k++) {
    const ys = landings.filter(l => l.k === k).map(l => l.y)
    if (!ys.length) continue
    const [qx, qz] = corners[k]
    const px = qx - Math.sign(qx) * W / 2, pz = qz - Math.sign(qz) * W / 2
    const top = Math.max(...ys) + RAIL_H + 0.1
    const n = Math.ceil((top + F) / 4)
    for (let i = 0; i < n; i++) {
      const y0 = -F + (top + F) * (i / n), y1 = -F + (top + F) * ((i + 1) / n)
      wood.box(px, (y0 + y1) / 2, pz, 0.16, y1 - y0 + 0.01, 0.16, 0, scaleRGB(beamC, shade((y0 + y1) / 2)))
    }
  }
  // at the top: a rail along the landing's open side, and a threshold board
  // out through the gap in the rim
  wood.box(AX - W + 0.06, RAIL_H, cz, 0.07, 0.07, W, 0, railC)
  wood.box(AX - W + 0.06, RAIL_H / 2, AZ - 0.08, 0.09, RAIL_H, 0.09, 0, beamC)
  wood.box(cx, -0.03, AZ + RW / 2, W, 0.1, RW + 0.3, 0, plankC)
  // the windlass across the middle: two posts outside the rim, a beam, the
  // drum the rope winds on with a little roof over it, the rope and bucket
  const PZ = AZ + RW + 0.35, PH = 3.4
  for (const sg of [-1, 1]) wood.box(0, PH / 2, sg * PZ, 0.26, PH, 0.26, 0, [0.4, 0.29, 0.18, 0])
  wood.box(0, PH - 0.12, 0, 0.18, 0.18, 2 * PZ + 0.3, 0, [0.42, 0.3, 0.19, 0])
  wood.tube([{ x: 0, y: PH - 0.12, z: -0.75, r: 0.24 }, { x: 0, y: PH - 0.12, z: 0.75, r: 0.24 }], 9, [0.45, 0.33, 0.2, 0], { capStart: true, capEnd: true })
  for (const sg of [-1, 1]) {
    // two boards pitched over the drum
    wood.box(0.52 * sg, PH + 0.2, 0, 2.6, 0.08, 1.25, Math.PI / 2, [0.38, 0.27, 0.17, 0], 0.45 * sg)
  }
  const rope = []
  for (let y = PH - 0.12; y >= -5; y -= 0.5) rope.push({ x: 0.25, y, z: 0, r: 0.035 })
  wood.tube(rope, 5, [0.6, 0.52, 0.36, 0], { capEnd: false })
  wood.tube([{ x: 0.25, y: -5.5, z: 0, r: 0.32 }, { x: 0.25, y: -4.95, z: 0, r: 0.36 }], 9, [0.36, 0.26, 0.16, 0], { capStart: true, capEnd: false })
  place(ctx, wood, f, `well_wood_${s.key}`, 'wood')

  // ── something faintly alive at the bottom ──
  const glow = new Geo()
  for (let i = 0; i < 7; i++) {
    const m = mushroomGeo(Math.floor(r() * 1e6), 0.35 + r() * 0.25).geo
    const mx = (i < 4 ? -1 : 1) * (IX - r() * 1.5), mz = (r() * 2 - 1) * IZ
    if (nearStash(STASH.well, mx, mz)) continue
    glow.add(m, Matrix.Translation(mx, -F, mz))
  }
  place(ctx, glow, f, `well_glow_${s.key}`, 'glow')

  // ── colliders ──
  const L = s.lid.x1 - s.x
  const solid = (x0, x1, y0, y1, z0, z1, pass = false) =>
    boxF(ctx, f, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, 0, 0, pass)
  // the lid: four boxes framing the mouth - built at once, not queued
  // (colliders.js), so nobody can stand on it before it is solid
  ctx.colliders.urgent = true
  solid(-L, L, -1, 0, AZ, L)
  solid(-L, L, -1, 0, -L, -AZ)
  solid(AX, L, -1, 0, -AZ, AZ)
  solid(-L, -AX, -1, 0, -AZ, AZ)
  ctx.colliders.urgent = false
  // the coping, with its gap
  for (const [x0, x1, z0, z1] of rims) solid(x0, x1, 0, RH, z0, z1)
  // the shaft walls, all the way down, and the floor
  solid(AX, AX + 1, -F - 1, 0, -AZ - 1, AZ + 1)
  solid(-AX - 1, -AX, -F - 1, 0, -AZ - 1, AZ + 1)
  solid(-AX, AX, -F - 1, 0, AZ, AZ + 1)
  solid(-AX, AX, -F - 1, 0, -AZ - 1, -AZ)
  solid(-AX - 1, AX + 1, -F - 1, -F, -AZ - 1, AZ + 1)
  // the stairs: a ramp under each flight and a flat box under each landing,
  // level where they meet; a rail wall on the open side where the rail is
  for (const fl of flights) {
    rampF(ctx, f, fl.x0, fl.y0, fl.z0, fl.x1, fl.y1, fl.z1, W + 0.1)
    const t0 = railFrom(fl)
    if (t0 < 1) {
      const [x, y, z] = fl.at((t0 + 1) / 2, W / 2 + 0.1)
      boxF(ctx, f, x, y + 0.4, z, 0.12, 1.4, fl.slopeLen * (1 - t0), fl.yaw, fl.pitch, true)
    }
  }
  for (const { k, y } of landings) {
    const [qx, qz] = corners[k]
    solid(qx - W / 2 - 0.05, qx + W / 2 + 0.05, y - 0.4, y, qz - W / 2 - 0.05, qz + W / 2 + 0.05, true)
  }
  // the top landing's open side
  solid(AX - W - 0.16, AX - W - 0.04, -0.3, 1.1, AZ - W, AZ, true)
  // the windlass posts
  for (const sg of [-1, 1]) solid(-0.15, 0.15, 0, PH, sg * PZ - 0.15, sg * PZ + 0.15, true)

  return { kind: 'well', key: s.key, x: s.x, y: s.H, z: s.z, spots: [{ name: 'bottom', x: s.x, y: s.H - F, z: s.z }] }
}

const xyz = a => ({ x: a[0], y: a[1], z: a[2] })
const smoothstepJS = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }

// ════════════════════════════════════════════════════════════════════════════
// THE FALLS - a cliff, a waterfall, a pool, and a way in behind the water
// ════════════════════════════════════════════════════════════════════════════
let mistTexture = null
function mistTex(scene) {
  if (mistTexture && mistTexture.getScene() === scene && !mistTexture.isDisposed?.()) return mistTexture
  const t = new DynamicTexture('infterrain_mist', { width: 64, height: 64 }, scene, false)
  const c = t.getContext()
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.4, 'rgba(255,255,255,0.45)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  c.fillStyle = g
  c.fillRect(0, 0, 64, 64)
  t.update()
  t.hasAlpha = true
  mistTexture = t
  return t
}

function buildFalls(ctx, s) {
  const { scene } = ctx
  const r = rng(Math.floor(s.seed * 1e6) + 37)
  const HW = FALLS.halfW, HD = FALLS.halfD, HM = s.height
  const f = frame(s.massif.x, s.H, s.massif.z, s.yaw)
  const MOUTH_W = 1.75, MOUTH_H = 3.8
  const poolZ = HD + FALLS.ledge + FALLS.poolR
  const level = s.pool.level - s.H
  const impactZ = HD + 3.9

  // ── the cliff: a crag of split, layered rock, a notch at the top of its face
  // for the water ──
  // Every face is flat (geo.js facet()), so it breaks the light like split
  // stone rather than reading as one smooth lump. It rises in tiers, each
  // stepping in from the one below over a ledge moss has taken; its skyline is
  // highest over the falls and drops and breaks into crags going round the
  // back. The face round the falls stays one sheer wall, so the water clears
  // it and the way in behind it stays a path; fallen blocks lie round the rest
  // of its foot. It draws on its own random stream (rc), so nothing after it -
  // the shrine's crystals, the stash spots - moves when it changes.
  const rc = rng(Math.floor(s.seed * 1e6) + 61)
  const cliff = new Geo()
  const angles = []
  const SEG = 96
  for (let i = 0; i < SEG; i++) angles.push((i / SEG) * TAU)
  const am = Math.asin(MOUTH_W / HW)
  angles.push(am, TAU - am)
  angles.sort((a, b) => a - b)
  const seedA = s.seed * 40
  // how much an angle is the face (the side the water comes down), and how
  // much the sheer wall round the falls
  const faceOf = a => smoothstepJS(0.45, 0.85, Math.cos(a))
  const sheerOf = a => smoothstepJS(0.88, 0.97, Math.cos(a))
  // the skyline, highest over the falls. Lower round the sides and back - the
  // tiers it falls short of end there as flat terraces
  const topAt = a => {
    const crag = 2.4 * Math.sin(a * 3 + seedA) + 1.6 * Math.sin(a * 7 + seedA * 1.7)
    return HM - (1 - faceOf(a)) * (HM * 0.14 + 1.5 + crag)
  }
  // the tiers above the cave mouth - level all the way round, each a sheer
  // wall stepping in over a ledge to the next - and the rows the shell is
  // built in: one under the ground, the mouth's, then in each tier one
  // half-way up, one just under its lip, the lip (jutting a little - the thin
  // band between is the shadow under it) and the back of the ledge over it
  const TIER0 = 5
  const T = Math.max(3, Math.round((HM - TIER0) / 3.8))
  const TIER_H = (HM - TIER0) / T
  const rows = [{ ground: true }, { abs: 0 }, { abs: 1.3 }, { abs: 2.6 }, { abs: MOUTH_H }, { y: TIER0, tier: 0 }]
  for (let j = 0; j < T; j++) {
    rows.push({ y: TIER0 + (j + 0.55) * TIER_H, tier: j })
    if (j < T - 1) rows.push(
      { y: TIER0 + (j + 1) * TIER_H - 0.35, tier: j },
      { y: TIER0 + (j + 1) * TIER_H, tier: j, lip: true },
      { y: TIER0 + (j + 1) * TIER_H + 0.06, tier: j + 1 })
  }
  rows.push({ top: true, tier: T - 1 })
  // the plan at height y, as a share of the massif's half-size: a skirt round
  // the foot, broad buttresses, ribs and gullies - easing off into the sheer
  // face. The colliders' ring follows it too
  const outline = (a, y) => {
    const side = 1 - faceOf(a)
    const tY = Math.max(0, y) / HM
    const skirt = 0.16 * Math.pow(Math.max(0, 1 - tY * 3), 2) * side
    const lobes = (0.08 * Math.sin(a * 3 + seedA) + 0.05 * Math.sin(a * 5 + seedA * 2)) * side
    // sharp-bottomed gullies between rounded ribs
    const ribs = 0.05 * (Math.abs(Math.sin(a * 7 + seedA * 3)) - 0.6) * (1 - sheerOf(a))
    return 1 + skirt + lobes + ribs
  }
  // each tier's wall bulges and dips its own way, the same all the way up it
  const bulge = (a, tier) => 0.8 * Math.sin(a * 6 + tier * 2.3 + seedA) * Math.cos(a * 3 - tier * 1.1) + 0.55 * Math.sin(a * 17 + tier * 4.1)
  // how far a tier has stepped in by, round the plan: each ledge wide in
  // places and gone in others, where the wall runs on up unbroken
  const insetOf = (a, tier) => {
    let m = 0
    for (let j = 1; j <= tier; j++) m += 0.05 * Math.max(0, 0.7 + 1.1 * Math.sin(a * (2 + j) + j * 1.9 + seedA) * Math.cos(a * 3 - j * 0.7))
    return m
  }
  // the strata dip, rather than lying dead level like a cake's
  const dipOf = a => 1.2 * Math.sin(a * 2 + seedA * 0.5) + 0.5 * Math.sin(a * 5 - seedA)
  // the drawn ground under a local (x, z), from the site's height
  const groundAt = (x, z) => { const [wx, , wz] = f.w(x, 0, z); return drawnHeight(wx, wz, ctx.step) - s.H }
  // the notch the water pours over, cut into the top of the face and running
  // back across the top as a stream bed
  const channel = (x, z) => Math.abs(x) < 3.2 && z > 0 ? 1.5 * Math.cos((x / 3.2) * Math.PI / 2) * smoothstepJS(HD * 0.2, HD * 0.7, z) : 0

  const grid = angles.map(a => {
    const sx = Math.sin(a), cz = Math.cos(a)
    const len = Math.hypot(sx * HW, cz * HD)
    const loose = 1 - sheerOf(a)
    const top = topAt(a)
    return rows.map(row => {
      // the shell reaches down under the ground wherever that falls away
      let y = row.ground ? Math.min(-1.5, groundAt(sx * HW * 1.2, cz * HD * 1.2) - 1.5)
        : row.abs !== undefined ? row.abs : row.top ? top
        : Math.min(row.y + dipOf(a) * Math.min(1, (row.y - TIER0) / TIER_H), top)
      const tier = row.tier ?? 0
      const m = outline(a, y) + ((row.lip ? 0.012 : 0) - insetOf(a, tier)) * loose
      let x = HW * sx * m, z = HD * cz * m
      // the face round the cave mouth is kept smooth so the opening is clean
      const nearMouth = Math.max(0, 1 - Math.hypot(x / 6, Math.max(0, y - MOUTH_H) / 3)) * (cz > 0 ? 1 : 0)
      // broken stone: each tier's own bulges, every point nudged a little more
      // (rougher at the foot, the part anyone sees close up)
      const n = (bulge(a, tier) + (rc() - 0.5) * (y < TIER0 ? 0.9 : 0.55)) * (1 - nearMouth) * (0.3 + 0.7 * loose)
      x += (sx * HW / len) * n
      z += (cz * HD / len) * n
      if (row.top) y -= channel(x, z)
      return [x, y, z]
    })
  })

  // A facet's colour: the stone of its tier, lighter toward the tier's top and
  // each facet a shade of its own; moss on the ledges and terraces, shadow
  // under the lips, dirt at the foot, dark and green where the falls keep it wet
  const TONES = [[0.63, 0.57, 0.49], [0.5, 0.47, 0.43], [0.62, 0.53, 0.44], [0.55, 0.53, 0.5]]
  const MOSS = [0.3, 0.41, 0.21, 0]
  const tone0 = Math.floor(s.seed * 97) % TONES.length
  const area = (p, q, w) => {
    const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2], vx = w[0] - p[0], vy = w[1] - p[1], vz = w[2] - p[2]
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
  }
  const upOf = (p, q, w, inside) => {
    const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2]
    const vx = w[0] - p[0], vy = w[1] - p[1], vz = w[2] - p[2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l; ny /= l; nz /= l
    return nx * (p[0] - inside[0]) + ny * (p[1] - inside[1]) + nz * (p[2] - inside[2]) < 0 ? -ny : ny
  }
  // one colour a quad of the shell (A B below, C D above), so its two
  // triangles never come out in a checker of light and dark
  const stoneC = (A, B, C, D, inside, tier, a, underLip) => {
    const a1 = area(A, C, B), a2 = area(B, C, D)
    const ny = (upOf(A, C, B, inside) * a1 + upOf(B, C, D, inside) * a2) / (a1 + a2)
    const cx = (A[0] + B[0] + C[0] + D[0]) / 4, cy = (A[1] + B[1] + C[1] + D[1]) / 4, cz = (A[2] + B[2] + C[2] + D[2]) / 4
    const within = cy < TIER0 ? Math.max(0, cy) / TIER0 : ((cy - TIER0) / TIER_H) % 1
    // the shade drifts round each tier rather than jumping quad to quad
    const drift = 0.95 + 0.05 * Math.sin(a * 13 + tier * 2.7 + seedA) + rc() * 0.025
    let c = scaleRGB([...TONES[(Math.max(0, tier) + tone0) % TONES.length], 0], (0.84 + 0.16 * within) * drift)
    c = mixColor(c, scaleRGB(MOSS, 0.92 + rc() * 0.12), smoothstepJS(0.55, 0.85, ny) * 0.9)
    if (underLip) c = scaleRGB(c, 0.62)
    if (cy < 1.2) c = scaleRGB(c, 0.85)
    if (cy < HM && Math.abs(cx) < 4.5 && cz > HD * 0.6) c = mixColor(c, [0.17, 0.24, 0.16, 0], 0.7 * (1 - Math.abs(cx) / 4.5))
    return c
  }

  for (let i = 0; i < angles.length; i++) {
    const i2 = (i + 1) % angles.length
    const a = (angles[i] + (i2 === 0 ? TAU : angles[i2])) / 2
    for (let k = 0; k < rows.length - 1; k++) {
      const A = grid[i][k], B = grid[i2][k], C = grid[i][k + 1], D = grid[i2][k + 1]
      const y = (A[1] + D[1]) / 2
      // the cave mouth
      if (Math.cos(a) > 0 && Math.abs(Math.sin(a)) < Math.sin(am) && y < MOUTH_H) continue
      const inside = [0, y, 0], tier = rows[k + 1].tier ?? 0
      // where a tier is cut off by the skyline its rows meet - no facet there
      if (area(A, C, B) + area(B, C, D) < 2e-4) continue
      const c = stoneC(A, B, C, D, inside, tier, a, rows[k + 1].lip)
      for (const [p, q, w] of [[A, C, B], [B, C, D]]) if (area(p, q, w) > 1e-4) cliff.facet(p, q, w, c, inside)
    }
  }

  // the top: in from the skyline over a rounded lip to a low mossy crown, the
  // stream bed running back from the notch
  const K = 5
  const rim = grid.map(col => col[col.length - 1])
  const crownY = rim.reduce((sum, p) => sum + p[1], 0) / rim.length + 1.2
  const cap = rim.map(([x, y, z]) => {
    const raw = y + channel(x, z)
    const ring = [[x, y, z]]
    for (let k = 1; k <= K; k++) {
      const t = k / K
      const px = x * (1 - t * 0.97), pz = z * (1 - t * 0.97)
      const lip = k === 1 ? 0.55 * (1 - channel(px, pz) / 1.5) : 0
      ring.push([px, raw + (crownY - raw) * smoothstepJS(0, 1, t) + lip + (rc() - 0.5) * 0.5 - channel(px, pz), pz])
    }
    return ring
  })
  const below = [0, 0, 0]
  const capC = (p, q, w) => {
    const cx = (p[0] + q[0] + w[0]) / 3, cz = (p[2] + q[2] + w[2]) / 3
    const ny = upOf(p, q, w, below)
    // the stream bed, wet stone
    if (channel(cx, cz) > 0.4) return scaleRGB([0.24, 0.28, 0.24, 0], 0.9 + rc() * 0.2)
    // level ground grows moss and grass, steep ground is bare rock
    const rock = scaleRGB([...TONES[(T - 1 + tone0) % TONES.length], 0], 0.86 + rc() * 0.24)
    return mixColor(rock, scaleRGB(MOSS, 0.85 + rc() * 0.3), smoothstepJS(0.55, 0.85, ny))
  }
  for (let i = 0; i < cap.length; i++) {
    const i2 = (i + 1) % cap.length
    for (let k = 0; k < K; k++) {
      const A = cap[i][k], B = cap[i2][k], C = cap[i][k + 1], D = cap[i2][k + 1]
      cliff.facet(A, C, B, capC(A, C, B), below)
      cliff.facet(B, C, D, capC(B, C, D), below)
    }
    const crown = [0, crownY + 0.3, 0]
    cliff.facet(cap[i][K], crown, cap[i2][K], capC(cap[i][K], crown, cap[i2][K]), below)
  }

  // fallen blocks round the foot, clear of the face - sat on the ground
  // wherever it is round there, each with a box to stop against
  for (let i = 0; i < 16; i++) {
    const a = rc() * TAU, big = rc()
    const rx = 1.1 + big * 2.2, ry = 0.7 + big * 1.4 + rc() * 0.4, rz = 1 + rc() * 1.8
    const turn = rc() * TAU, tier = Math.floor(rc() * TONES.length)
    if (faceOf(a) > 0.15) continue
    const sx = Math.sin(a), cz = Math.cos(a), len = Math.hypot(sx * HW, cz * HD)
    const m = outline(a, 0.5), out = Math.max(rx, rz) * 0.55
    const x = HW * sx * m + (sx * HW / len) * out, z = HD * cz * m + (cz * HD / len) * out
    const gy = groundAt(x, z)
    cliff.rock(x, gy + ry * 0.3, z, rx, ry, rz, big > 0.5 ? 1 : 0, (nx, ny, nz) => {
      let c = scaleRGB([...TONES[(tier + tone0) % TONES.length], 0], 0.82 + rc() * 0.24)
      if (ny > 0.45) c = mixColor(c, MOSS, Math.min(1, (ny - 0.45) / 0.35) * 0.8)
      return ny < -0.2 ? scaleRGB(c, 0.7) : c
    }, () => 0.82 + rc() * 0.32, turn)
    boxF(ctx, f, x, gy + ry * 0.55, z, rx * 1.5, ry * 1.3, rz * 1.5, turn)
  }

  // a lintel stone over the mouth and two jambs, hiding the seam where the
  // shell's opening meets the tunnel
  const faceZ = HD * Math.cos(am) - 0.1
  cliff.box(0, MOUTH_H + 0.35, faceZ + 0.2, MOUTH_W * 2 + 1.4, 0.8, 1.6, 0, [0.36, 0.34, 0.31, 0])
  for (const sx of [-1, 1]) cliff.box(sx * (MOUTH_W + 0.45), MOUTH_H / 2, faceZ + 0.2, 0.9, MOUTH_H + 0.2, 1.6, 0, [0.38, 0.36, 0.33, 0])

  // ── the cave behind the falls ──
  const CZ = HD - FALLS_CAVE.back, CR = FALLS_CAVE.r
  innerDome(cliff, 0, CZ, CR, 0, 2.4, 6.2, 36, (y, a) => [0.16, 0.15, 0.16, 0], (a, y) => angDist(a, Math.PI / 2) < (MOUTH_W + 0.3) / CR && y < MOUTH_H, s.seed * 7)
  disc(cliff, 0, 0.03, CZ, CR + 0.5, 36, [0.12, 0.11, 0.12, 0])
  const TZ0 = CZ + CR - 0.8, TZ1 = faceZ + 0.9
  const TS = 6
  for (let i = 0; i < TS; i++) {
    const z0 = TZ0 + (TZ1 - TZ0) * (i / TS), z1 = TZ0 + (TZ1 - TZ0) * ((i + 1) / TS)
    const c = [0.15, 0.14, 0.15, 0]
    for (const sx of [-1, 1]) {
      const x = sx * (MOUTH_W + 0.05)
      const out = [x + sx * 5, 2, (z0 + z1) / 2]
      cliff.facet([x, 0, z0], [x, MOUTH_H, z0], [x, 0, z1], c, out)
      cliff.facet([x, MOUTH_H, z0], [x, MOUTH_H, z1], [x, 0, z1], c, out)
    }
    const above = [0, MOUTH_H + 5, (z0 + z1) / 2]
    cliff.facet([-MOUTH_W - 0.1, MOUTH_H, z0], [MOUTH_W + 0.1, MOUTH_H, z0], [-MOUTH_W - 0.1, MOUTH_H, z1], c, above)
    cliff.facet([MOUTH_W + 0.1, MOUTH_H, z0], [MOUTH_W + 0.1, MOUTH_H, z1], [-MOUTH_W - 0.1, MOUTH_H, z1], c, above)
    const below = [0, -5, (z0 + z1) / 2]
    cliff.facet([-MOUTH_W - 0.1, 0.03, z0], [MOUTH_W + 0.1, 0.03, z0], [-MOUTH_W - 0.1, 0.03, z1], [0.13, 0.12, 0.12, 0], below)
    cliff.facet([MOUTH_W + 0.1, 0.03, z0], [MOUTH_W + 0.1, 0.03, z1], [-MOUTH_W - 0.1, 0.03, z1], [0.13, 0.12, 0.12, 0], below)
  }
  // a plinth at the heart of it, for whatever the host wants to leave there
  cliff.box(0, 0.45, CZ - 1.5, 1.3, 0.9, 1.3, 0.3, [0.42, 0.4, 0.38, 0])
  place(ctx, cliff, f, `falls_cliff_${s.key}`, 'cliff')

  const pal = CRYSTAL_PALETTES[1]
  const shrine = new Geo()
  for (let i = 0; i < 5; i++) {
    const a0 = r() * TAU, d = 3.2 + r() * 2.8
    const sc = 0.35 + r() * 0.35
    const cg = crystalClusterGeo(Math.floor(r() * 1e6), pal).geo
    const turn = r() * TAU
    // turned round the cave until it is off the stash spots (STASH, from the
    // cave's middle)
    const a = clearOfStash(STASH.falls, a0, d, sc * 1.5)
    if (a === null) continue
    shrine.add(cg, Matrix.Scaling(sc, sc, sc).multiply(Matrix.RotationY(turn)).multiply(Matrix.Translation(Math.cos(a) * d, 0, CZ + Math.sin(a) * d)))
  }
  shrine.blob(0, 1.25, CZ - 1.5, 0.32, 0.32, 0.32, 2, [0.75, 1.0, 1.0, 1.0])
  place(ctx, shrine, f, `falls_shrine_${s.key}`, 'crystal1')

  // ── the water ──
  const fm = fallsMaterials(scene)
  // the sheet: out over the lip, falling in an arc into the pool
  {
    const lip = HM - 1.35, bottom = level - 0.2
    const rows = 26, cols = 10
    const pos = [], attr = [], idx = []
    for (let k = 0; k <= rows; k++) {
      const t = k / rows
      const y = lip + (bottom - lip) * t
      const z = faceZ + 0.6 + 3.6 * Math.sqrt(t)
      const half = 2.2 + 1.0 * t
      for (let c = 0; c <= cols; c++) {
        const u = c / cols
        pos.push((u - 0.5) * 2 * half, y, z + Math.sin(u * Math.PI) * 0.35)
        attr.push(u, t)
      }
    }
    for (let k = 0; k < rows; k++)
      for (let c = 0; c < cols; c++) {
        const i = k * (cols + 1) + c
        idx.push(i, i + 1, i + cols + 1, i + 1, i + cols + 2, i + cols + 1)
      }
    const mesh = rawMesh(ctx, `falls_sheet_${s.key}`, pos, idx, { aSheet: [attr, 2] }, fm.sheet, f)
    mesh.alphaIndex = 2
  }
  // the pool: a polar grid over the bowl, depth over the drawn ground
  {
    const rings = 14, sides = 40, R = FALLS.poolR + 1.5
    const pos = [], attr = [], idx = []
    for (let k = 0; k <= rings; k++) {
      const rr = (k / rings) * R
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * TAU
        const x = Math.cos(a) * rr, z = poolZ + Math.sin(a) * rr
        const [wx, , wz] = f.w(x, 0, z)
        pos.push(x, level, z)
        attr.push(s.pool.level - drawnHeight(wx, wz, ctx.step), Math.hypot(x, z - impactZ))
        if (k === 0) break
      }
    }
    // centre fan, then rings
    for (let i = 0; i < sides; i++) idx.push(0, 1 + i, 1 + ((i + 1) % sides))
    for (let k = 1; k < rings; k++)
      for (let i = 0; i < sides; i++) {
        const a = 1 + (k - 1) * sides + i, b = 1 + (k - 1) * sides + ((i + 1) % sides)
        const c = 1 + k * sides + i, d = 1 + k * sides + ((i + 1) % sides)
        idx.push(a, c, b, b, c, d)
      }
    const mesh = rawMesh(ctx, `water`, pos, idx, { aPool: [attr, 2] }, fm.pool, f)
    mesh.alphaIndex = 1
  }
  // a rainbow standing in the spray
  {
    const pos = [], attr = [], idx = []
    const R0 = 6.2, R1 = 7.4, N = 40
    for (let i = 0; i <= N; i++) {
      const t = i / N
      const a = Math.PI * (0.06 + 0.88 * t)
      for (const [k, rr] of [[0, R0], [1, R1]]) {
        pos.push(Math.cos(a) * rr, level + Math.sin(a) * rr * 0.9, impactZ + 4.5)
        attr.push(k, t)
      }
    }
    for (let i = 0; i < N; i++) {
      const a = i * 2
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
    const mesh = rawMesh(ctx, `falls_bow_${s.key}`, pos, idx, { aBow: [attr, 2] }, fm.bow, f)
    mesh.alphaIndex = 3
  }
  // the creek the pool spills into, finding its own way downhill
  buildCreek(ctx, f, s, poolZ, level, fm)

  // spray rising off the plunge
  {
    const [ix, iy, iz] = f.w(0, level + 0.3, impactZ)
    const ps = new ParticleSystem(`falls_mist_${s.key}`, 130, scene)
    ps.particleTexture = mistTex(scene)
    ps.emitter = new Vector3(ix, iy, iz)
    ps.minEmitBox = new Vector3(-2.6, 0, -1.2)
    ps.maxEmitBox = new Vector3(2.6, 0.4, 1.2)
    ps.color1 = new Color4(0.85, 0.9, 0.92, 0.22)
    ps.color2 = new Color4(0.75, 0.82, 0.86, 0.14)
    ps.colorDead = new Color4(0.7, 0.75, 0.8, 0)
    ps.minSize = 1.6; ps.maxSize = 3.8
    ps.minLifeTime = 1.4; ps.maxLifeTime = 3.2
    ps.emitRate = 35
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD
    ps.direction1 = new Vector3(-1.2, 1.5, -0.6)
    ps.direction2 = new Vector3(1.2, 3.2, 1.6)
    ps.minEmitPower = 0.6; ps.maxEmitPower = 1.6
    ps.gravity = new Vector3(0, -0.4, 0)
    ps.updateSpeed = 0.016
    ps.start()
    // disposed with the chunk - but never its texture, which every falls shares
    ctx.meshes.push({ dispose: () => ps.dispose(false) })
  }

  // ── colliders ──
  // round the butte, a ring of tall boxes just inside its face - split at
  // the cave mouth
  // the plan of the rock at waist height, pulled in a little - the boxes'
  // outer faces sit on this line, so you stop where the rock you see starts
  const ring = []
  const N = 48
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * TAU
    const k = outline(a, 0.9)
    ring.push([Math.sin(a) * (HW * k - 0.6), Math.cos(a) * (HD * k - 0.6)])
  }
  for (let i = 0; i < N; i++) {
    let [x0, z0] = ring[i], [x1, z1] = ring[i + 1]
    const front = z0 > 0 && z1 > 0
    const cross = front && (Math.sign(x0 - MOUTH_W) !== Math.sign(x1 - MOUTH_W) || Math.sign(x0 + MOUTH_W) !== Math.sign(x1 + MOUTH_W) || (Math.abs(x0) < MOUTH_W && Math.abs(x1) < MOUTH_W))
    const segs = []
    if (!cross) segs.push([x0, z0, x1, z1])
    else {
      // keep only the parts outside |x| < MOUTH_W + 0.1
      const edge = MOUTH_W + 0.1
      const lerpAt = xe => { const t = (xe - x0) / (x1 - x0); return [xe, z0 + (z1 - z0) * t] }
      if (x0 < -edge) segs.push([x0, z0, ...lerpAt(-edge)])
      if (x1 > edge) segs.push([...lerpAt(edge), x1, z1])
      if (x0 > edge) segs.push([x0, z0, ...lerpAt(edge)])
      if (x1 < -edge) segs.push([...lerpAt(-edge), x1, z1])
    }
    for (const [a0, b0, a1, b1] of segs) {
      const len = Math.hypot(a1 - a0, b1 - b0)
      if (len < 0.05) continue
      const yawSeg = Math.atan2(a1 - a0, b1 - b0)
      // pushed half its thickness inward, so its outer face sits on the line
      const nx = Math.cos(yawSeg), nz = -Math.sin(yawSeg)
      const inward = (nx * (a0 + a1) + nz * (b0 + b1)) > 0 ? -1 : 1
      boxF(ctx, f, (a0 + a1) / 2 + nx * inward, HM / 2, (b0 + b1) / 2 + nz * inward, 2, HM, len + 0.25, yawSeg)
    }
  }
  // the tunnel's walls and the cave's
  for (const sx of [-1, 1]) boxF(ctx, f, sx * (MOUTH_W + 0.55), MOUTH_H / 2 + 0.5, (TZ0 + faceZ) / 2, 1, MOUTH_H + 1, faceZ - TZ0 + 1.5)
  for (let i = 0; i < 18; i++) {
    const a = ((i + 0.5) / 18) * TAU
    if (angDist(a, Math.PI / 2) < (MOUTH_W + 0.4) / CR) continue
    boxF(ctx, f, Math.cos(a) * (CR + 0.5), 3, CZ + Math.sin(a) * (CR + 0.5), 1, 6, (TAU * (CR + 0.5) / 18) * 1.12, -a)
  }
  boxF(ctx, f, 0, 0.45, CZ - 1.5, 1.3, 0.9, 1.3, 0.3)

  return {
    kind: 'falls', key: s.key, x: s.x, y: s.H, z: s.z,
    spots: [
      { name: 'pool', ...xyz(f.w(0, level, poolZ)) },
      { name: 'behind-the-falls', ...xyz(f.w(0, 0, CZ - 1.5)) },
    ],
  }
}

function rawMesh(ctx, name, positions, indices, attrs, material, f) {
  const scene = ctx.scene
  const vd = new VertexData()
  vd.positions = positions
  vd.indices = indices
  const normals = []
  for (let i = 0; i < positions.length; i += 3) normals.push(0, 1, 0)
  vd.normals = normals
  const mesh = new Mesh(name, scene)
  vd.applyToMesh(mesh)
  for (const [k, [data, size]] of Object.entries(attrs)) mesh.setVerticesData(k, new Float32Array(data), false, size)
  mesh.material = material
  mesh.isPickable = false
  if (f) {
    mesh.position.set(f.ox, f.oy, f.oz)
    mesh.rotation.y = f.yaw
  }
  mesh.freezeWorldMatrix()
  // disposed with the chunk - these were once left out, and every waterfall
  // ever walked past stayed in the scene for good
  ctx.meshes.push(mesh)
  return mesh
}

// ════════════════════════════════════════════════════════════════════════════
// CLOUDSTEP - clouds low enough to jump onto, climbing to one you can stand on
// ════════════════════════════════════════════════════════════════════════════
function buildCloudstep(ctx, s) {
  const r = rng(Math.floor(s.seed * 1e6) + 41)
  const f = frame(s.x, s.H, s.z, s.yaw)
  // each a comfortable hop up from the last (the vessel jump clears ~1.27),
  // close and broad enough that a hop from the edge of one at walking pace
  // lands well inside the next - and a sprinting one still lands on it
  const FIRST = 0.92, RISE = 0.78, RS = 9.1, SPACING = 2.3
  const n = Math.max(4, Math.ceil((s.height - FIRST) / RISE))
  const clouds = new Geo()
  const steps = []
  for (let i = 0; i < n; i++) {
    const a = (i * SPACING) / RS
    steps.push({ a, x: Math.cos(a) * RS, z: Math.sin(a) * RS, top: FIRST + i * RISE, w: 3.7, d: 3.4 })
  }
  const islandTop = steps[n - 1].top + RISE
  for (const [i, st] of steps.entries()) {
    clouds.add(cloudGeo(Math.floor(r() * 1e6), st.w, st.d, 1.25).geo, Matrix.RotationY(r() * TAU).multiply(Matrix.Translation(st.x, st.top, st.z)))
    // turned to face the middle, so every one reaches the same way in
    boxF(ctx, f, st.x, st.top - 0.3, st.z, st.w * 0.82, 0.6, st.d * 0.82, -st.a, 0, true, CLOUD_FRICTION)
  }
  // the island at the top - big enough to walk around on
  const IR = 7.9
  clouds.add(cloudGeo(Math.floor(r() * 1e6), IR * 2, IR * 2, 2.4).geo, Matrix.Translation(0, islandTop, 0))
  // trailing wisps under it
  for (let i = 0; i < 6; i++) {
    const a = r() * TAU, d = r() * 4
    clouds.add(cloudGeo(Math.floor(r() * 1e6), 2.4, 2.2, 1).geo, Matrix.Translation(Math.cos(a) * d, islandTop - 2.6 - r() * 2.5, Math.sin(a) * d))
  }
  // The island's walkable top: a 16-sided polygon meeting the stairs' inner
  // edge, so the last hop up onto it is as short as any of the others and
  // there is no gap to step off into. Eight bands, each 2R long and
  // 2R tan(11.25) wide, turned in 22.5 degree steps, ARE that polygon - two
  // squares, one turned 45 degrees, are not: their union is an eight-pointed
  // star whose points reached out over the top stairs.
  const IRc = RS - 1.62
  for (let k = 0; k < 8; k++) boxF(ctx, f, 0, islandTop - 0.4, 0, 2 * IRc, 0.8, 2 * IRc * Math.tan(Math.PI / 16), (k * Math.PI) / 8, 0, true, CLOUD_FRICTION)
  place(ctx, clouds, f, `cloudstep_${s.key}`, 'cloud')

  // a skybloom at the top: a stalk and a bud of light
  const bloom = new Geo()
  const stalk = []
  for (let k = 0; k <= 8; k++) stalk.push({ x: Math.sin(k * 0.5) * 0.15, y: islandTop + k * 0.22, z: 0, r: 0.07 })
  bloom.tube(stalk, 6, [0.4, 0.75, 0.45, 0.3])
  const top = stalk[stalk.length - 1]
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU
    bloom.blob(top.x + Math.cos(a) * 0.35, top.y + 0.1, top.z + Math.sin(a) * 0.35, 0.32, 0.1, 0.18, 1, [1.0, 0.8, 0.95, 1.0])
  }
  bloom.blob(top.x, top.y + 0.18, top.z, 0.18, 0.18, 0.18, 1, [1.0, 1.0, 0.85, 1.0])
  place(ctx, bloom, f, `skybloom_${s.key}`, 'skybloom')

  return { kind: 'cloudstep', key: s.key, x: s.x, y: s.H, z: s.z, spots: [{ name: 'summit', ...xyz(f.w(0, islandTop, 0)) }] }
}

// ════════════════════════════════════════════════════════════════════════════
// A LONE SKYNEEDLE
// ════════════════════════════════════════════════════════════════════════════
function buildNeedle(ctx, s) {
  const r = rng(Math.floor(s.seed * 1e6) + 53)
  const g0 = drawnHeight(s.x, s.z, ctx.step)
  const f = frame(s.x, g0, s.z, s.yaw)
  const tree = new Geo()
  tree.add(needleGeo(Math.floor(r() * 1e6), s.height).geo)
  // roots flaring into the ground
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + r() * 0.5
    const root = []
    for (let k = 0; k <= 6; k++) {
      const t = k / 6
      root.push({ x: Math.cos(a) * (0.3 + t * 2.4), y: 1.4 * (1 - t) - 0.5 * t, z: Math.sin(a) * (0.3 + t * 2.4), r: 0.3 * (1 - t * 0.7) })
    }
    tree.tube(root, 6, [0.72, 0.73, 0.68, 0], { capEnd: true })
  }
  place(ctx, tree, f, `skyneedle_${s.key}`, 'needle')
  const caps = new Geo()
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU + r() * 0.4, d = 3.2 + r() * 1.5
    caps.add(mushroomGeo(Math.floor(r() * 1e6), 0.5 + r() * 0.5).geo, Matrix.Translation(Math.cos(a) * d, 0, Math.sin(a) * d))
  }
  place(ctx, caps, f, `skyneedle_caps_${s.key}`, 'mushroom')
  boxF(ctx, f, 0, 15, 0, 1.3, 30, 1.3, 0, 0, true)
  return { kind: 'needle', key: s.key, x: s.x, y: g0, z: s.z, spots: [{ name: 'foot', x: s.x, y: g0, z: s.z }] }
}

// ════════════════════════════════════════════════════════════════════════════
// THE RISING FALLS - a pond pouring its water up into the sky
// ════════════════════════════════════════════════════════════════════════════
function buildRising(ctx, s) {
  const { scene } = ctx
  const r = rng(Math.floor(s.seed * 1e6) + 61)
  const f = frame(s.x, s.H, s.z, s.yaw)
  const fm = fallsMaterials(scene)
  const level = s.pool.level - s.H
  const HT = s.height

  // the pond, foam rings running out from the column's foot
  {
    const rings = 10, sides = 36, R = s.pool.r + 1.5
    const pos = [], attr = [], idx = []
    for (let k = 0; k <= rings; k++) {
      const rr = (k / rings) * R
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * TAU
        const x = Math.cos(a) * rr, z = Math.sin(a) * rr
        const [wx, , wz] = f.w(x, 0, z)
        pos.push(x, level, z)
        attr.push(s.pool.level - drawnHeight(wx, wz, ctx.step), rr)
        if (k === 0) break
      }
    }
    for (let i = 0; i < sides; i++) idx.push(0, 1 + i, 1 + ((i + 1) % sides))
    for (let k = 1; k < rings; k++)
      for (let i = 0; i < sides; i++) {
        const a = 1 + (k - 1) * sides + i, bb = 1 + (k - 1) * sides + ((i + 1) % sides)
        const c = 1 + k * sides + i, d = 1 + k * sides + ((i + 1) % sides)
        idx.push(a, c, bb, bb, c, d)
      }
    rawMesh(ctx, 'water', pos, idx, { aPool: [attr, 2] }, fm.pool, f).alphaIndex = 1
  }
  // the column itself
  {
    const rows = 44, sides = 22
    const pos = [], attr = [], idx = []
    for (let k = 0; k <= rows; k++) {
      const h = k / rows
      const y = level - 0.3 + h * HT
      const rad = (1.9 - 1.1 * h) * (1 + 0.14 * Math.sin(h * 23))
      for (let i = 0; i <= sides; i++) {
        const a = (i / sides) * TAU
        pos.push(Math.cos(a) * rad, y, Math.sin(a) * rad)
        attr.push(i / sides, h)
      }
    }
    for (let k = 0; k < rows; k++)
      for (let i = 0; i < sides; i++) {
        const a = k * (sides + 1) + i
        idx.push(a, a + 1, a + sides + 1, a + 1, a + sides + 2, a + sides + 1)
      }
    rawMesh(ctx, `rising_column_${s.key}`, pos, idx, { aCol: [attr, 2] }, fm.column, f).alphaIndex = 2
  }
  // rocks round the pond, and stones floating loose round the column
  const rim = new Geo()
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU + r() * 0.4, d = s.pool.r + 1.2 + r() * 1.5
    const sc = 0.6 + r() * 0.7
    rim.add(boulderGeo(Math.floor(r() * 1e6), [0.5, 0.5, 0.52]).geo, Matrix.Scaling(sc, sc, sc).multiply(Matrix.Translation(Math.cos(a) * d, -0.4, Math.sin(a) * d)))
    boxF(ctx, f, Math.cos(a) * d, 0.5 * sc, Math.sin(a) * d, 2.2 * sc, 1.2 * sc, 2.2 * sc)
  }
  place(ctx, rim, f, `rising_rim_${s.key}`, 'palestone')
  const floaters = new Geo()
  for (let i = 0; i < 14; i++) {
    const a = r() * TAU, d = 3.5 + r() * 6
    const sc = 0.25 + r() * 0.55
    floaters.add(boulderGeo(Math.floor(r() * 1e6), [0.55, 0.56, 0.6]).geo,
      Matrix.Scaling(sc, sc, sc).multiply(Matrix.RotationYawPitchRoll(r() * TAU, r() * 2, r() * 2)).multiply(Matrix.Translation(Math.cos(a) * d, 1.5 + r() * 9, Math.sin(a) * d)))
  }
  const orbit = floaters.toMesh(`rising_stones_${s.key}`, scene, ctx.material('palestone'))
  orbit.position.set(f.ox, f.oy, f.oz)
  const spin = 0.05 + r() * 0.05
  let t = r() * 10
  const turn = scene.onBeforeRenderObservable.add(() => {
    t += scene.getEngine().getDeltaTime() * 0.001
    orbit.rotation.y = t * spin
    orbit.position.y = f.oy + Math.sin(t * 0.6) * 0.35
  })
  ctx.meshes.push(orbit, { dispose: () => scene.onBeforeRenderObservable.remove(turn) })

  // rain falling back out of the top, and mist where it leaves the pond
  {
    const [tx, ty, tz] = f.w(0, level + HT - 2, 0)
    const rain = new ParticleSystem(`rising_rain_${s.key}`, 260, scene)
    rain.particleTexture = mistTex(scene)
    rain.emitter = new Vector3(tx, ty, tz)
    rain.minEmitBox = new Vector3(-1, 0, -1); rain.maxEmitBox = new Vector3(1, 2, 1)
    rain.color1 = new Color4(0.85, 0.92, 1.0, 0.5); rain.color2 = new Color4(0.75, 0.85, 0.95, 0.35)
    rain.colorDead = new Color4(0.7, 0.8, 0.9, 0)
    rain.minSize = 0.12; rain.maxSize = 0.3
    rain.minLifeTime = 3; rain.maxLifeTime = 4.2
    rain.emitRate = 65
    rain.direction1 = new Vector3(-4, 2, -4); rain.direction2 = new Vector3(4, 5, 4)
    rain.minEmitPower = 0.8; rain.maxEmitPower = 1.6
    rain.gravity = new Vector3(0, -9.8, 0)
    rain.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED
    rain.blendMode = ParticleSystem.BLENDMODE_STANDARD
    rain.updateSpeed = 0.016
    rain.start()
    const [bx, by, bz] = f.w(0, level + 0.2, 0)
    const mist = new ParticleSystem(`rising_mist_${s.key}`, 80, scene)
    mist.particleTexture = mistTex(scene)
    mist.emitter = new Vector3(bx, by, bz)
    mist.minEmitBox = new Vector3(-2, 0, -2); mist.maxEmitBox = new Vector3(2, 0.5, 2)
    mist.color1 = new Color4(0.88, 0.93, 0.95, 0.18); mist.color2 = new Color4(0.8, 0.86, 0.9, 0.1)
    mist.colorDead = new Color4(0.8, 0.85, 0.9, 0)
    mist.minSize = 1.5; mist.maxSize = 3.5
    mist.minLifeTime = 1.5; mist.maxLifeTime = 3
    mist.emitRate = 20
    mist.direction1 = new Vector3(-0.8, 1.2, -0.8); mist.direction2 = new Vector3(0.8, 2.6, 0.8)
    mist.minEmitPower = 0.5; mist.maxEmitPower = 1.2
    mist.gravity = new Vector3(0, 0.2, 0)
    mist.updateSpeed = 0.016
    mist.start()
    ctx.meshes.push({ dispose: () => { rain.dispose(false); mist.dispose(false) } })
  }
  return { kind: 'rising', key: s.key, x: s.x, y: s.H, z: s.z, spots: [{ name: 'pond', x: s.x, y: s.pool.level, z: s.z }] }
}

// ── A creek out of a waterfall's pool ──────────────────────────────────────
// From the pool's lip, away from the cliff, it follows the drawn ground
// downhill - stepping along its slope with some memory of where it was
// heading, so it meanders rather than zigzags - until it reaches a lake, the
// river, a hollow it cannot leave, or runs out of length. Draped over the
// ground rather than cut into it: the terrain's 16-unit grid could not draw a
// channel this narrow however deep it was carved.
function buildCreek(ctx, f, s, poolZ, level, fm) {
  const STEP = 3, MAX = 90, step = ctx.step
  const ground = (x, z) => drawnHeight(x, z, step)
  // the outflow: the pool's far side, a little round from straight ahead
  const out0 = f.w(Math.sin(s.seed * 20) * FALLS.poolR * 0.4, 0, poolZ + FALLS.poolR * 0.92)
  let x = out0[0], z = out0[2]
  let dx = Math.sin(s.yaw), dz = Math.cos(s.yaw)
  const path = [{ x, z }]
  let climbing = 0
  for (let i = 0; i < MAX; i++) {
    const g = ground(x, z)
    const gx = (ground(x + 2, z) - ground(x - 2, z)) / 4
    const gz = (ground(x, z + 2) - ground(x, z - 2)) / 4
    const sl = Math.hypot(gx, gz)
    if (sl > 1e-4) {
      // downhill, blended with the way it was already going
      const k = Math.min(0.6, sl * 4)
      dx = dx * (1 - k) - (gx / sl) * k
      dz = dz * (1 - k) - (gz / sl) * k
    }
    // a lazy wander, so a flat stretch still bends
    const wob = Math.sin(i * 0.37 + s.seed * 9) * 0.18
    const ndx = dx * Math.cos(wob) - dz * Math.sin(wob), ndz = dx * Math.sin(wob) + dz * Math.cos(wob)
    const l = Math.hypot(ndx, ndz) || 1
    dx = ndx / l; dz = ndz / l
    const nx = x + dx * STEP, nz = z + dz * STEP
    const ng = ground(nx, nz)
    climbing = ng > g + 0.15 ? climbing + 1 : 0
    if (climbing > 2) break
    x = nx; z = nz
    path.push({ x, z })
    if (ng < WATER_LEVEL + 0.2 || inRiverChannel(x, z, 2)) break
    if (i > 8 && inSiteFootprint(x, z, -10) && Math.hypot(x - s.x, z - s.z) > 80) break
  }
  if (path.length < 6) return
  // a ribbon over the ground, widening as it goes
  const cols = 5
  const pos = [], attr = [], idx = []
  let along = 0
  for (let i = 0; i < path.length; i++) {
    const p = path[i], q = path[Math.min(path.length - 1, i + 1)], o = path[Math.max(0, i - 1)]
    let tx = q.x - o.x, tz = q.z - o.z
    const tl = Math.hypot(tx, tz) || 1
    tx /= tl; tz /= tl
    if (i > 0) along += Math.hypot(p.x - path[i - 1].x, p.z - path[i - 1].z)
    const half = 1.3 + Math.min(1, i / 40) * 0.8
    const steep = Math.min(1, Math.abs(ground(q.x, q.z) - ground(o.x, o.z)) / (Math.hypot(q.x - o.x, q.z - o.z) || 1) * 3)
    // fade in out of the pool, fade out at the end
    const ends = Math.min(1, i / 2) * Math.min(1, (path.length - 1 - i) / 3)
    for (let c = 0; c <= cols; c++) {
      const v = (c / cols) * 2 - 1
      const wx = p.x - tz * v * half, wz = p.z + tx * v * half
      pos.push(wx, ground(wx, wz) + 0.06, wz)
      attr.push(along, v / Math.max(0.15, ends), steep)
    }
  }
  for (let i = 0; i < path.length - 1; i++)
    for (let c = 0; c < cols; c++) {
      const a = i * (cols + 1) + c
      idx.push(a, a + 1, a + cols + 1, a + 1, a + cols + 2, a + cols + 1)
    }
  rawMesh(ctx, 'water', pos, idx, { aFlow: [attr, 3] }, fm.creek, null).alphaIndex = 1
}
