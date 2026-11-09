import { Matrix, Vector3, ParticleSystem, Color4, DynamicTexture } from '@babylonjs/core'
import { Geo, mixColor, rng } from './geo'
import { hash, smoothstep } from './noise'
import { GROTTO } from './sites'

// ════════════════════════════════════════════════════════════════════════════
// THE GROTTO - a crag of sheer rock on the open field, one black opening in
// its front, and through it a maze in the dark
// ════════════════════════════════════════════════════════════════════════════
//
// It used to be a cave under the field, under a lid over a pit in the
// heightfield (sites.js says how the wells still do that). It stands on the
// ground now: a box of rock 68 x 52 and twenty-odd high with true edges, its
// faces part dressed stone laid in courses and part the falls' broken, tiered
// cliff with moss on its ledges. Its front has no face on it: just a dark
// opening with a broken portcullis, the stone round it black with
// soot, dark stains run down the face from the top and claw marks beside the
// way in - with stakes and skulls lining the way up to it, a cage hanging off
// a gibbet, and smoke crawling out of the dark.
//
// Inside, under an eleven-metre roof, is a maze of rock walls on a 12 x 9 grid
// of cells, cut by a seeded depth-first search into long winding passages,
// with a few more walls knocked through so there is more than one way round.
// Some cells are rooms: the antechamber behind the jaws (left only by its
// sides - its back wall has eyes in it), the heart in the middle, a mine, the
// pens, and in a back corner the treasure room, which no passage reaches. Its
// one way in is a window high in a wall, over a stack of cargo boxes - two
// jumps up, through, and a stack on the far side to climb back out by.
//
// The layout is pure (grottoLayout - the maze, its rooms and where the loot
// and ores go), so a server with no scene can ask too (index.js's
// siteStashSpots). Its floor is the ground itself, flattened under the crag,
// so a host can ground what it puts in there on the terrain as anywhere else.

const TAU = Math.PI * 2
const HX = GROTTO.halfX, HZ = GROTTO.halfZ
// the cave inside
const IX = HX - GROTTO.wall, IZ = HZ - GROTTO.wall
const ROOF = GROTTO.roofY
// the maze's cells - a passage is a cell less a wall's thickness, ~3.9 wide
const COLS = 12, ROWS = 9
const PX = (2 * IX) / COLS, PZ = (2 * IZ) / ROWS
const MW = 1.3
// extra walls knocked through after the search, for loops
const LOOPS = 6
// the way in, on the front face (still "the jaws" in names and spots)
const MOUTH = { w: 8, h: 7 }
// the dark runs down the front from its top, and how many
const STAINS = 7
// a cargo box. The vessel player jumps about 1.27 and cannot step up more
// than a few centimetres, so the climb is two boxes' worth of jumps
const CRATE = { w: 1, h: 0.95 }
const SILL = 2 * CRATE.h
const WINDOW = { w: 1.6, h: 2.2 }
// open floor kept round each stash spot (as builders.js's STASH_CLEAR)
const STASH_CLEAR = 1.4
// the cliff's strata, as the falls' tiers
const TIER = 3.5
// the outer colliders' faces sit this far inside the rock's face - its broken
// stretches bulge out past it here and there, and are cut back into it more
const SET_BACK = 0.15
// a cell's sides, +x -x +z -z (so a side's opposite is k ^ 1)
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
// the inside is not drawn from further off than this (from the crag's middle)
// - nothing of it shows from out there but a glimpse through the jaws
const FAR_INSIDE = 110

const BONE = [0.78, 0.73, 0.6, 0]
const IRON = [0.24, 0.2, 0.17, 0]
const scaleRGB = (c, k) => [c[0] * k, c[1] * k, c[2] * k, c[3] ?? 0]
const xyz = a => ({ x: a[0], y: a[1], z: a[2] })

// the crag's frame: origin on its ground in the middle, +Z out through its face
function frameOf(s) {
  const yaw = s.turn * Math.PI / 2
  const c = Math.cos(yaw), sn = Math.sin(yaw)
  return {
    ox: s.x, oy: s.H, oz: s.z, yaw,
    w: (x, y, z) => [s.x + x * c + z * sn, s.H + y, s.z - x * sn + z * c],
    dir: (x, z) => [x * c + z * sn, -x * sn + z * c],
  }
}

// ── The layout ──────────────────────────────────────────────────────────────
const layouts = new Map()

/** The maze, its rooms, and its stash spots, in the crag's own frame. Pure, cached by site. */
export function grottoLayout(s) {
  const hit = layouts.get(s.key)
  if (hit && hit.seed === s.seed) return hit
  const r = rng(Math.floor(s.seed * 1e6) + 71)
  const N = COLS * ROWS
  const id = (i, j) => j * COLS + i
  const ci = c => c % COLS
  const cj = c => Math.floor(c / COLS)
  const centre = c => [-IX + (ci(c) + 0.5) * PX, -IZ + (cj(c) + 0.5) * PZ]
  // the cell on side k of c, or -1 past the grid's edge - where the crag's
  // own wall is
  const across = (c, k) => {
    const i = ci(c) + SIDES[k][0], j = cj(c) + SIDES[k][1]
    return i < 0 || j < 0 || i >= COLS || j >= ROWS ? -1 : id(i, j)
  }
  const neighbours = c => [0, 1, 2, 3].map(k => across(c, k)).filter(n => n >= 0)
  // a wall between every two cells side by side to begin with - east[c]
  // between c and the cell on its +x, north[c] between c and the one on its +z
  const east = new Uint8Array(N).fill(1)
  const north = new Uint8Array(N).fill(1)
  const flag = (a, b) => b === a + 1 ? [east, a] : b === a - 1 ? [east, b] : b === a + COLS ? [north, a] : [north, b]
  const wall = (a, b) => { const [arr, k] = flag(a, b); return arr[k] === 1 }
  const setWall = (a, b, v) => { const [arr, k] = flag(a, b); arr[k] = v }

  // ── rooms: blocks of cells with no walls between them
  const rooms = []
  const roomOf = new Int16Array(N).fill(-1)
  const addRoom = (name, i0, j0, w, h) => {
    const room = {
      name, index: rooms.length, i0, j0, w, h, cells: [],
      x: -IX + (i0 + w / 2) * PX, z: -IZ + (j0 + h / 2) * PZ, hx: (w * PX) / 2, hz: (h * PZ) / 2,
    }
    for (let j = j0; j < j0 + h; j++) for (let i = i0; i < i0 + w; i++) { room.cells.push(id(i, j)); roomOf[id(i, j)] = room.index }
    for (const c of room.cells) for (const n of neighbours(c)) if (roomOf[n] === room.index) setWall(c, n, 0)
    rooms.push(room)
    return room
  }
  // every 2 x 2 block still free, with a cell's gap round it to any room
  const freeBlocks = () => {
    const out = []
    for (let j0 = 0; j0 <= ROWS - 2; j0++) for (let i0 = 0; i0 <= COLS - 2; i0++) {
      let ok = true
      for (let j = j0 - 1; j <= j0 + 2 && ok; j++)
        for (let i = i0 - 1; i <= i0 + 2 && ok; i++)
          if (i >= 0 && j >= 0 && i < COLS && j < ROWS && roomOf[id(i, j)] >= 0) ok = false
      if (ok) out.push([i0, j0])
    }
    return out
  }
  const ante = addRoom('ante', COLS / 2 - 1, ROWS - 2, 2, 2)
  const heart = addRoom('heart', COLS / 2 - 1, 3, 2, 2)
  const secret = addRoom('secret', r() < 0.5 ? 0 : COLS - 2, 0, 2, 2)
  let free = freeBlocks()
  const mine = addRoom('mine', ...free[Math.floor(r() * free.length)], 2, 2)
  free = freeBlocks()
  const pens = free.length ? addRoom('pens', ...free[Math.floor(r() * free.length)], 2, 2) : null

  // ── the passages: a depth-first search from the antechamber. Entering a
  // room enters all of it. The treasure room is never entered
  const seen = new Uint8Array(N)
  for (const c of secret.cells) seen[c] = 1
  // the antechamber is left only by its sides: its back wall is the first
  // thing anyone sees through the jaws, and something looks back out of it
  const barred = (a, b) => (roomOf[a] === ante.index) !== (roomOf[b] === ante.index) && Math.min(cj(a), cj(b)) < ante.j0
  const stack = []
  const enter = c => { for (const k of roomOf[c] >= 0 ? rooms[roomOf[c]].cells : [c]) { seen[k] = 1; stack.push(k) } }
  enter(ante.cells[0])
  while (stack.length) {
    const c = stack[stack.length - 1]
    const next = neighbours(c).filter(n => !seen[n] && !barred(c, n))
    if (!next.length) { stack.pop(); continue }
    const n = next[Math.floor(r() * next.length)]
    setWall(c, n, 0)
    enter(n)
  }
  // and a few more ways through, so it is not one path with branches
  const spare = []
  for (let c = 0; c < N; c++) for (const n of neighbours(c)) {
    if (n < c || !wall(c, n) || barred(c, n) || roomOf[c] === secret.index || roomOf[n] === secret.index) continue
    spare.push([c, n])
  }
  for (let k = 0; k < LOOPS && spare.length; k++) {
    const [a, b] = spare.splice(Math.floor(r() * spare.length), 1)[0]
    setWall(a, b, 0)
  }

  const opens = c => neighbours(c).filter(n => !wall(c, n))
  const closedSides = c => [0, 1, 2, 3].filter(k => { const n = across(c, k); return n < 0 || wall(c, n) })
  // how far from c's middle the face of its wall on side k is - the crag's own
  // walls are flush with the grid's edge, the maze's half their thickness in
  const faceDist = (c, k) => (SIDES[k][0] ? PX : PZ) / 2 - (across(c, k) < 0 ? 0 : MW / 2)
  // a point in cell c, `inset` out from the face of its wall on side k and
  // `along` that wall from the middle
  const atWall = (c, k, inset, along = 0) => {
    const [x, z] = centre(c), [nx, nz] = SIDES[k]
    const d = faceDist(c, k) - inset
    return [x + nx * d + (nx ? 0 : along), z + nz * d + (nx ? along : 0)]
  }
  // a dead end's back wall: the side across from its one way out
  const backOf = c => { const n = opens(c)[0]; return [0, 1, 2, 3].find(k => across(c, k) === n) ^ 1 }

  // steps from the jaws, and the dead ends, furthest first
  const dist = new Int16Array(N).fill(-1)
  const queue = [...ante.cells]
  for (const c of ante.cells) dist[c] = 0
  for (let q = 0; q < queue.length; q++) for (const n of opens(queue[q])) if (dist[n] < 0) { dist[n] = dist[queue[q]] + 1; queue.push(n) }
  const deadEnds = []
  for (let c = 0; c < N; c++) if (roomOf[c] < 0 && opens(c).length === 1) deadEnds.push(c)
  deadEnds.sort((a, b) => dist[b] - dist[a])

  // ── the stash spots, and what else has to keep its floor clear
  const taken = []
  const isFree = (x, z, rad) => taken.every(t => Math.hypot(x - t.x, z - t.z) >= t.r + rad)
  const spots = {}
  const stash = (name, [x, z]) => { spots[name] = [x, z]; taken.push({ x, z, r: STASH_CLEAR }) }
  // the treasure in the walled-off room, a weapon in the heart
  stash('chest', [secret.x, secret.z])
  stash('weapon', [heart.x, heart.z])

  // the way into the treasure room: from the cell beside it furthest from the
  // jaws - a dead end, if any of them is one
  let climb = null
  for (const c of secret.cells) for (const n of neighbours(c)) {
    if (roomOf[n] === secret.index) continue
    const score = dist[n] + (opens(n).length === 1 ? 1000 : 0)
    if (!climb || score > climb.score) climb = { cell: n, into: c, score }
  }
  const [ax, az] = centre(climb.cell), [bx, bz] = centre(climb.into)
  const wn = [Math.sign(bx - ax), Math.sign(bz - az)]
  const win = { x: (ax + bx) / 2, z: (az + bz) / 2, nx: wn[0], nz: wn[1] }
  // the cargo stacks either side of it: two high against the wall under the
  // window, one high in front of that
  const stacks = []
  for (const side of [-1, 1])
    for (const [d, n] of [[MW / 2 + CRATE.w / 2, 2], [MW / 2 + CRATE.w * 1.5, 1]])
      stacks.push({ x: win.x + wn[0] * side * d, z: win.z + wn[1] * side * d, n, inside: side > 0 })
  for (const st of stacks) taken.push({ x: st.x, z: st.z, r: 0.85 })
  // and room to come at the first step
  taken.push({ x: win.x - wn[0] * (MW / 2 + 2.7), z: win.z - wn[1] * (MW / 2 + 2.7), r: 0.7 })

  const used = new Set([climb.cell])
  const takeEnd = () => {
    const c = deadEnds.find(e => !used.has(e))
    if (c !== undefined) used.add(c)
    return c
  }
  // the rarest mushrooms at the back of the furthest dead end
  const patchEnd = takeEnd()
  stash('patch', patchEnd !== undefined ? atWall(patchEnd, backOf(patchEnd), 1.3) : [heart.x + heart.hx - 1.6, heart.z + heart.hz - 1.6])
  // ores: two in the mine, one in the heart, two at the back of dead ends
  let ores = 0
  const oreIn = cells => {
    for (let t = 0; t < 16; t++) {
      const c = cells[Math.floor(r() * cells.length)]
      const sides = closedSides(c)
      if (!sides.length) continue
      const k = sides[Math.floor(r() * sides.length)]
      const span = (SIDES[k][0] ? PZ : PX) / 2 - 1.3
      const p = atWall(c, k, 1.15, (r() * 2 - 1) * span)
      if (isFree(p[0], p[1], STASH_CLEAR)) return p
    }
    return null
  }
  for (const [cells, n] of [[mine.cells, 2], [heart.cells, 1]])
    for (let i = 0; i < n; i++) { const p = oreIn(cells); if (p) stash(`ore${ores++}`, p) }
  for (let i = 0; i < 2; i++) {
    const c = takeEnd()
    if (c !== undefined) stash(`ore${ores++}`, atWall(c, backOf(c), 1.15))
  }

  const L = {
    seed: s.seed, east, north, roomOf, rooms, ante, heart, secret, mine, pens,
    climb, window: win, stacks, spots, deadEnds, used, taken, dist, patchCell: patchEnd,
    id, ci, cj, centre, across, wall, opens, closedSides, faceDist, atWall, backOf,
  }
  if (layouts.size > 200) layouts.delete(layouts.keys().next().value)
  layouts.set(s.key, L)
  return L
}

/** A grotto's stash spots in the world - chest, weapon, patch, ore0..ore4 - on its floor. */
export function grottoStashSpots(s) {
  const L = grottoLayout(s), f = frameOf(s)
  return Object.entries(L.spots).map(([name, [x, z]]) => ({ name, ...xyz(f.w(x, 0, z)) }))
}

// ── Geometry helpers ────────────────────────────────────────────────────────

// the up-ness of a facet's outward normal (inside: any point behind it)
function facetNy(p, q, w, inside) {
  const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2]
  const vx = w[0] - p[0], vy = w[1] - p[1], vz = w[2] - p[2]
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const l = Math.hypot(nx, ny, nz) || 1
  return (nx * (p[0] - inside[0]) + ny * (p[1] - inside[1]) + nz * (p[2] - inside[2]) < 0 ? -ny : ny) / l
}

// A vertical face of rock, from (ax, az) along (dx, dz), looking out along
// (nx, nz): its corners at `us` along it and `ys` up it. push(u, y) sets a
// corner back into the rock - called once per corner, in order - colour(A, B,
// C, D, u, y, ny) colours a quad (A B below, C D above; ny its up-ness) and
// skip(u, y) leaves one out. Flat facets, so it breaks the light like stone
function rockFace(g, ax, az, dx, dz, nx, nz, us, ys, push, colour, skip = null) {
  const grid = ys.map(y => us.map(u => {
    const k = push(u, y)
    return [ax + dx * u - nx * k, y, az + dz * u - nz * k]
  }))
  for (let j = 0; j < ys.length - 1; j++)
    for (let i = 0; i < us.length - 1; i++) {
      const um = (us[i] + us[i + 1]) / 2, ym = (ys[j] + ys[j + 1]) / 2
      if (skip && skip(um, ym)) continue
      const A = grid[j][i], B = grid[j][i + 1], C = grid[j + 1][i], D = grid[j + 1][i + 1]
      const behind = [ax + dx * um - nx * 6, ym, az + dz * um - nz * 6]
      const ny = (facetNy(A, C, B, behind) + facetNy(B, C, D, behind)) / 2
      const c = colour(A, B, C, D, um, ym, ny)
      g.facet(A, C, B, c, behind)
      g.facet(B, C, D, c, behind)
    }
}

// sorted, with near-duplicates merged - the ones in `keep` win
function breaks(list, keep, minGap) {
  const out = [...keep]
  for (const v of list) if (out.every(k => Math.abs(k - v) >= minGap)) out.push(v)
  return out.sort((a, b) => a - b)
}

// a flat, level quad
function floorQuad(g, x0, z0, x1, z1, y, c, up = true) {
  const inside = [(x0 + x1) / 2, y + (up ? -1 : 1), (z0 + z1) / 2]
  g.facet([x0, y, z0], [x1, y, z1], [x1, y, z0], c, inside)
  g.facet([x0, y, z0], [x0, y, z1], [x1, y, z1], c, inside)
}

// a cargo box, w across and h high, standing at (x, y, z): planks in a darker frame
function crate(g, x, y, z, w, h, yaw, tone) {
  const t = new Geo()
  const wood = scaleRGB([0.46, 0.33, 0.2, 0], tone), edge = scaleRGB([0.26, 0.18, 0.11, 0], tone)
  t.box(0, h / 2, 0, w * 0.96, h * 0.96, w * 0.96, 0, wood)
  const e = w * 0.11, hw = w / 2 - e / 2
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) t.box(sx * hw, h / 2, sz * hw, e, h, e, 0, edge)
  // bands round its top, its bottom and its middle
  for (const y of [e / 2, h - e / 2]) t.box(0, y, 0, w, e, w, 0, edge)
  t.box(0, h / 2, 0, w * 0.985, e * 0.7, w * 0.985, 0, edge)
  g.add(t, Matrix.RotationY(yaw).multiply(Matrix.Translation(x, y, z)))
}

// a barrel with iron hoops
function barrel(g, x, z, h, r, tone) {
  const wood = scaleRGB([0.42, 0.29, 0.17, 0], tone), hoop = [0.15, 0.14, 0.14, 0]
  const path = []
  for (let k = 0; k <= 6; k++) { const t = k / 6; path.push({ x, y: t * h, z, r: r * (0.86 + 0.14 * Math.sin(Math.PI * t)) }) }
  g.tube(path, 10, t => (Math.abs(t - 0.15) < 0.05 || Math.abs(t - 0.85) < 0.05 || Math.abs(t - 0.5) < 0.04) ? hoop : wood)
}

// a skull, facing +z before yaw; tilt pitches it forward
function skull(g, x, y, z, sc, yaw, tilt = 0) {
  const t = new Geo()
  const dark = [0.07, 0.05, 0.04, 0]
  t.blob(0, 0, 0, 0.11 * sc, 0.12 * sc, 0.135 * sc, 2, (vx, vy, vz) => {
    if (vz > 0.45 && vy > -0.05 && vy < 0.5 && Math.abs(Math.abs(vx) - 0.4) < 0.22) return dark
    if (vz > 0.75 && vy < -0.1 && vy > -0.42 && Math.abs(vx) < 0.14) return dark
    return BONE
  })
  t.blob(0, -0.09 * sc, 0.05 * sc, 0.075 * sc, 0.045 * sc, 0.08 * sc, 1, BONE)
  g.add(t, Matrix.RotationYawPitchRoll(yaw, tilt, 0).multiply(Matrix.Translation(x, y, z)))
}

// a long bone lying along yaw
function bone(g, x, y, z, len, yaw, r = 0.03) {
  const dx = Math.sin(yaw) * len / 2, dz = Math.cos(yaw) * len / 2
  g.tube([{ x: x - dx, y, z: z - dz, r }, { x: x + dx, y, z: z + dz, r }], 5, BONE, { capEnd: false })
  for (const s of [-1, 1]) g.blob(x + s * dx, y, z + s * dz, r * 1.9, r * 1.6, r * 1.9, 0, BONE)
}

// someone who sat down against a wall and never got up - back to -z, facing +z
function skeleton(g, x, z, yaw) {
  const t = new Geo()
  t.tube([{ x: 0, y: 0.12, z: 0.02, r: 0.035 }, { x: 0, y: 0.45, z: -0.08, r: 0.033 }, { x: 0.02, y: 0.7, z: -0.15, r: 0.03 }], 5, BONE)
  for (let k = 0; k < 4; k++) {
    const y = 0.36 + k * 0.08, w = 0.15 - k * 0.012
    const arc = []
    for (let a = 0; a <= 6; a++) { const th = (a / 6) * Math.PI; arc.push({ x: Math.cos(th) * w, y, z: -0.1 + Math.sin(th) * 0.13, r: 0.013 }) }
    t.tube(arc, 4, BONE, { capEnd: false })
  }
  t.blob(0, 0.12, 0.02, 0.13, 0.06, 0.09, 1, BONE)
  for (const sx of [-1, 1]) {
    t.tube([{ x: sx * 0.09, y: 0.09, z: 0.05, r: 0.032 }, { x: sx * 0.13, y: 0.1, z: 0.46, r: 0.03 }, { x: sx * 0.17, y: 0.04, z: 0.86, r: 0.025 }], 5, BONE, { capEnd: false })
    t.tube([{ x: sx * 0.17, y: 0.62, z: -0.12, r: 0.022 }, { x: sx * 0.25, y: 0.32, z: -0.04, r: 0.02 }, { x: sx * 0.29, y: 0.04, z: 0.18, r: 0.018 }], 5, BONE, { capEnd: false })
  }
  skull(t, 0.07, 0.8, -0.1, 1, 0.5, 0.55)
  g.add(t, Matrix.RotationY(yaw).multiply(Matrix.Translation(x, 0, z)))
}

// a hanging chain of links from a to b
function chain(g, a, b, color, link = 0.2) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]
  const len = Math.hypot(dx, dy, dz)
  const d = new Vector3(dx / len, dy / len, dz / len)
  const e1 = Vector3.Cross(d, Math.abs(d.y) < 0.9 ? Vector3.Up() : Vector3.Right()).normalize()
  const e2 = Vector3.Cross(d, e1).normalize()
  const n = Math.max(1, Math.round(len / (link * 0.75)))
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n, e = i % 2 ? e1 : e2
    const cx = a[0] + dx * t, cy = a[1] + dy * t, cz = a[2] + dz * t
    const path = []
    for (let k = 0; k <= 8; k++) {
      const th = (k / 8) * TAU, u = Math.cos(th) * link / 2, v = Math.sin(th) * link * 0.28
      path.push({ x: cx + d.x * u + e.x * v, y: cy + d.y * u + e.y * v, z: cz + d.z * u + e.z * v, r: 0.018 })
    }
    g.tube(path, 3, color, { capEnd: false })
  }
}

// a round cage to hang by a chain: bars up from y0, domed over the top.
// Returns the height of the ring at its crown
function roundCage(g, x, y0, z, r, h, color) {
  const bars = 9
  for (let k = 0; k < bars; k++) {
    const a = (k / bars) * TAU, path = []
    for (let q = 0; q <= 4; q++) path.push({ x: x + Math.cos(a) * r, y: y0 + (q / 4) * h, z: z + Math.sin(a) * r, r: 0.025 })
    for (let q = 1; q <= 3; q++) {
      const t = (q / 3) * Math.PI / 2
      path.push({ x: x + Math.cos(a) * r * Math.cos(t), y: y0 + h + Math.sin(t) * r * 0.6, z: z + Math.sin(a) * r * Math.cos(t), r: 0.025 })
    }
    g.tube(path, 4, color, { capEnd: false })
  }
  for (const y of [y0, y0 + h * 0.5, y0 + h]) {
    const ring = []
    for (let k = 0; k <= 16; k++) ring.push({ x: x + Math.cos((k / 16) * TAU) * r, y, z: z + Math.sin((k / 16) * TAU) * r, r: 0.03 })
    g.tube(ring, 4, color, { capEnd: false })
  }
  g.blob(x, y0, z, r, 0.03, r, 1, color)
  return y0 + h + r * 0.6
}

// a square cage on the floor, w across and h high - `broken` has bars torn
// out of its front and one lying in front of it
function boxCage(g, x, z, yaw, w, h, color, broken) {
  const t = new Geo(), hw = w / 2
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) t.box(sx * hw, h / 2, sz * hw, 0.1, h, 0.1, 0, color)
  for (const y of [0.05, h - 0.05]) {
    for (const sz of [-1, 1]) t.box(0, y, sz * hw, w, 0.08, 0.08, 0, color)
    for (const sx of [-1, 1]) t.box(sx * hw, y, 0, 0.08, 0.08, w, 0, color)
  }
  t.box(0, h, 0, w, 0.04, w, 0, scaleRGB(color, 0.8))
  const n = 5
  for (let side = 0; side < 4; side++) for (let k = 1; k < n; k++) {
    if (broken && side === 2 && (k === 2 || k === 3)) continue
    const u = -hw + (k / n) * w
    const [bx, bz] = [[u, -hw], [hw, u], [u, hw], [-hw, u]][side]
    t.box(bx, h / 2, bz, 0.04, h, 0.04, 0, color)
  }
  if (broken) t.box(0.15, 0.04, hw + 0.55, 0.04, 0.04, h * 0.85, 0.6, color)
  g.add(t, Matrix.RotationY(yaw).multiply(Matrix.Translation(x, 0, z)))
}

// a clump of glowing mushrooms - flora.js's mushroomGeo, coarser: there are
// dozens of them in here
function caveMushrooms(g, x, z, scale, r) {
  const n = 1 + Math.floor(r() * 3)
  const caps = [[0.42, 0.2, 0.62], [0.2, 0.45, 0.62], [0.62, 0.35, 0.2]][Math.floor(r() * 3)]
  for (let i = 0; i < n; i++) {
    const a = r() * TAU, off = i ? 0.6 + r() * 0.9 : 0
    const h = (1.2 + r() * 1.8) * scale * (i ? 0.6 : 1)
    const cx = x + Math.cos(a) * off * scale, cz = z + Math.sin(a) * off * scale
    const lean = (r() - 0.5) * 0.4 * h * 0.3
    g.tube([0, 0.5, 1].map(t => ({ x: cx + lean * t, y: t * h - 0.2, z: cz, r: (0.16 + 0.06 * (1 - t)) * scale })), 5, [0.82, 0.8, 0.72, 0.1], { capEnd: false })
    const capR = (0.55 + r() * 0.5) * scale * (i ? 0.7 : 1)
    g.blob(cx + lean, h - 0.2 + capR * 0.1, cz, capR, capR * 0.45, capR, 1,
      (vx, vy) => vy < -0.2 ? [0.7, 0.95, 0.85, 1.0] : [...caps, 0.05],
      (vx, vy) => vy < -0.3 ? 0.6 : 1)
  }
}

let smokeTexture = null
function smokeTex(scene) {
  if (smokeTexture && smokeTexture.getScene() === scene && !smokeTexture.isDisposed?.()) return smokeTexture
  const t = new DynamicTexture('infterrain_smoke', { width: 64, height: 64 }, scene, false)
  const c = t.getContext()
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.45, 'rgba(255,255,255,0.4)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  c.fillStyle = g
  c.fillRect(0, 0, 64, 64)
  t.update()
  t.hasAlpha = true
  smokeTexture = t
  return t
}

// ── The build ───────────────────────────────────────────────────────────────

/** Build a grotto's meshes and colliders - see the top of this file. */
export function buildGrotto(ctx, s) {
  const { scene } = ctx
  const L = grottoLayout(s)
  const f = frameOf(s)
  const HM = s.height
  // the rock draws on its own random stream (rc), the props on theirs (r), so
  // changing one never moves the other
  const rc = rng(Math.floor(s.seed * 1e6) + 97)
  const r = rng(Math.floor(s.seed * 1e6) + 83)
  const seedA = s.seed * 40

  const place = (geo, name, matName, far = 0) => {
    if (!geo.idx.length) return null
    const mesh = geo.toMesh(name, scene, ctx.material(matName))
    mesh.position.set(f.ox, f.oy, f.oz)
    mesh.rotation.y = f.yaw
    mesh.freezeWorldMatrix()
    // an LOD level of nothing: past `far` it is not drawn at all
    if (far) mesh.addLODLevel(far, null)
    ctx.meshes.push(mesh)
    return mesh
  }
  const box = (x, y, z, w, h, d, pass = false, friction) =>
    ctx.colliders.box(...f.w(x, y, z), w, h, d, f.yaw, 0, pass, friction)

  // outside - the crag ('cliff') and what is on and round it
  const rock = new Geo()
  const outWood = new Geo()
  const outIron = new Geo()
  const outBone = new Geo()
  // inside - none of it can be seen from further off than FAR_INSIDE
  const cave = new Geo()
  const wood = new Geo()
  const iron = new Geo()
  const bones = new Geo()
  const mush = new Geo()
  const glow = new Geo()
  const ember = new Geo()
  const gold = new Geo()

  // ── the crag's faces ──
  // The falls' stones, a shade darker: this is not a friendly place
  const TONES = [[0.63, 0.57, 0.49], [0.5, 0.47, 0.43], [0.62, 0.53, 0.44], [0.55, 0.53, 0.5]]
  const MOSS = [0.3, 0.41, 0.21, 0]
  const DARK = 0.86
  const tone0 = Math.floor(s.seed * 97) % TONES.length
  const faces = [
    { ax: -HX, az: HZ, dx: 1, dz: 0, nx: 0, nz: 1, len: 2 * HX, p0: 0, front: true },
    { ax: HX, az: HZ, dx: 0, dz: -1, nx: 1, nz: 0, len: 2 * HZ, p0: 2 * HX },
    { ax: HX, az: -HZ, dx: -1, dz: 0, nx: 0, nz: -1, len: 2 * HX, p0: 2 * HX + 2 * HZ },
    { ax: -HX, az: -HZ, dx: 0, dz: 1, nx: -1, nz: 0, len: 2 * HZ, p0: 4 * HX + 2 * HZ },
  ]
  // how much of the face is broken cliff rather than dressed stone: none at
  // the corners or along the top, where the edges stay true, none round the
  // skull, and elsewhere great slanting stretches of it
  const cliffness = (face, u, y) => {
    let c = smoothstep(2.5, 6, Math.min(u, face.len - u)) * (1 - smoothstep(HM - 2.6, HM - 1.4, y))
    if (face.front) c *= smoothstep(15, 19, Math.abs(u - HX))
    const p = face.p0 + u
    const n = Math.sin((p + y * 0.45) * 0.085 + seedA) * Math.cos((p - y * 0.3) * 0.041 + seedA * 0.7) + 0.35 * Math.sin(p * 0.23 + y * 0.31 + seedA * 1.3)
    return c * smoothstep(-0.4, 0, n)
  }
  // the falls' tiers, cut into the face: each stratum set back, the lip over
  // it out at the face, the band under the lip in shadow and the ledge on top
  // of it mossed - and each tier bulging and dipping its own way along it
  const PROFILE_T = [0, 0.3 / TIER, 0.5, 1 - 0.3 / TIER, 1]
  const PROFILE_K = [0.05, 1, 0.6, 1, 0.05]
  const strata = (p, y) => {
    const yy = Math.max(0, y), k = Math.floor(yy / TIER), t = yy / TIER - k
    let prof = PROFILE_K[0]
    for (let i = 1; i < PROFILE_T.length; i++) {
      if (t > PROFILE_T[i]) continue
      prof = PROFILE_K[i - 1] + (PROFILE_K[i] - PROFILE_K[i - 1]) * (t - PROFILE_T[i - 1]) / (PROFILE_T[i] - PROFILE_T[i - 1])
      break
    }
    return prof * (0.45 + 0.2 * Math.sin(p * 0.37 + k * 2.1 + seedA) * Math.cos(p * 0.13 - k * 1.3))
  }
  const bulge = (p, y) => {
    const k = Math.floor(Math.max(0, y) / TIER)
    return 0.55 * Math.sin(p * 0.9 + k * 2.3 + seedA) * Math.cos(p * 0.37 - k * 1.1) + 0.35 * Math.sin(p * 2.3 + k * 4.1)
  }
  const rowsY = (() => {
    const ys = [-1.5, 0]
    for (let k = 0; (k + 1) * TIER <= HM - 1.6; k++) ys.push(k * TIER + 0.3, k * TIER + TIER / 2, (k + 1) * TIER - 0.3, (k + 1) * TIER)
    ys.push(HM - 2.6, HM - 1.4)
    return breaks(ys, [0, MOUTH.h, HM], 0.15)
  })()
  const inMouth = (x, y) => Math.abs(x) < MOUTH.w / 2 && y < MOUTH.h
  // dressed stone in courses, each block a shade of its own
  const dressed = (p, y) => {
    const course = Math.floor((y + 12) / 1.15)
    const block = Math.floor((p + (course % 2) * 1.2) / 2.4)
    return scaleRGB([0.43, 0.4, 0.36, 0], 0.84 + 0.16 * hash(course, block, 977))
  }
  // the falls' broken stone: its tier's tone, lighter up the tier, moss on the
  // ledges, shadow under the lips
  const broken = (p, y, ny) => {
    const yy = Math.max(0, y), tier = Math.floor(yy / TIER), within = (yy / TIER) % 1
    const drift = 0.95 + 0.05 * Math.sin(p * 0.4 + tier * 2.7 + seedA) + rc() * 0.03
    let c = scaleRGB([...TONES[(tier + tone0) % TONES.length], 0], (0.84 + 0.16 * within) * drift * DARK)
    c = mixColor(c, scaleRGB(MOSS, 0.75 + rc() * 0.12), smoothstep(0.45, 0.8, ny) * 0.9)
    return ny < -0.3 ? scaleRGB(c, 0.6) : c
  }
  // the front: no face, only what that hole has done to it - the stone all
  // round the way in blackened with soot, the front darker the nearer the
  // middle, and dark stains run down it from the top, each giving out at its
  // own height, as if something was poured over the edge
  const seedN = Math.floor(s.seed * 1e6)
  const stains = Array.from({ length: STAINS }, (_, k) => ({
    x: (hash(k, seedN, 211) - 0.5) * 26,
    w: 0.7 + hash(k, seedN, 212) * 0.8,
    end: 2 + hash(k, seedN, 213) * 9,
    k: 0.5 + hash(k, seedN, 214) * 0.3,
  }))
  const frontMarks = (x, y, c) => {
    c = scaleRGB(c, 0.72 + 0.28 * smoothstep(6, 16, Math.abs(x)))
    const dm = Math.hypot(Math.max(0, Math.abs(x) - MOUTH.w / 2), Math.max(0, y - MOUTH.h))
    if (dm < 5) c = scaleRGB(c, 0.3 + 0.7 * smoothstep(0, 5, dm))
    for (const st of stains) {
      const wob = 0.35 * Math.sin(y * 0.7 + st.x) + 0.15 * Math.sin(y * 2.1)
      const band = Math.max(0, 1 - Math.abs(x - st.x - wob) / st.w) * smoothstep(st.end, st.end + 2.5, y)
      c = mixColor(c, [0.13, 0.05, 0.04, 0], band * st.k)
    }
    return c
  }
  for (const face of faces) {
    const n = Math.max(2, Math.round(face.len / 1.8))
    const even = Array.from({ length: n + 1 }, (_, i) => (i / n) * face.len)
    const keep = face.front ? [0, face.len, HX - MOUTH.w / 2, HX + MOUTH.w / 2] : [0, face.len]
    // the front's middle finer, so the soot and the stains are not blocks
    const fineU = face.front ? Array.from({ length: 31 }, (_, i) => HX - 13.5 + i * 0.9) : []
    const fineY = face.front ? Array.from({ length: Math.floor((HM - 3) / 0.85) }, (_, i) => 0.85 * (i + 1)) : []
    const us = breaks([...even, ...fineU], keep, 0.3)
    const ys = face.front ? breaks([...rowsY, ...fineY], [0, MOUTH.h, HM], 0.15) : rowsY
    rockFace(rock, face.ax, face.az, face.dx, face.dz, face.nx, face.nz, us, ys,
      (u, y) => {
        const c = cliffness(face, u, y)
        if (c <= 0) return 0
        const p = face.p0 + u
        return Math.max(-0.5, Math.min(1.3, c * (0.3 + 1.15 * strata(p, y) - bulge(p, y) + (rc() - 0.5) * 0.5)))
      },
      (A, B, C, D, u, y, ny) => {
        const c = cliffness(face, u, y)
        let col = mixColor(dressed(face.p0 + u, y), broken(face.p0 + u, y, ny), smoothstep(0.1, 0.45, c))
        if (y < 1.2) col = scaleRGB(col, 0.85)
        return face.front ? frontMarks(u - HX, y, col) : col
      },
      face.front ? (u, y) => inMouth(u - HX, y) : null)
  }
  // the top: flat, moss over bare rock, the edges true
  {
    const nx = 8, nz = 6
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const x0 = -HX + (2 * HX * i) / nx, x1 = -HX + (2 * HX * (i + 1)) / nx
      const z0 = -HZ + (2 * HZ * j) / nz, z1 = -HZ + (2 * HZ * (j + 1)) / nz
      floorQuad(rock, x0, z0, x1, z1, HM, mixColor(scaleRGB([...TONES[tone0], 0], (0.66 + rc() * 0.2) * DARK), MOSS, 0.35 + rc() * 0.4))
    }
    // and a cornice round it, a line of shadow under the top's edge
    const cc = scaleRGB([0.3, 0.28, 0.26, 0], 1)
    rock.box(0, HM - 1.2, HZ + 0.15, 2 * HX + 0.7, 0.36, 0.3, 0, cc)
    rock.box(0, HM - 1.2, -HZ - 0.15, 2 * HX + 0.7, 0.36, 0.3, 0, cc)
    rock.box(HX + 0.15, HM - 1.2, 0, 0.3, 0.36, 2 * HZ + 0.7, 0, cc)
    rock.box(-HX - 0.15, HM - 1.2, 0, 0.3, 0.36, 2 * HZ + 0.7, 0, cc)
  }
  // fallen blocks round its foot, clear of the way up to the jaws
  for (let i = 0; i < 18; i++) {
    const face = faces[Math.floor(rc() * 4)]
    const u = 2 + rc() * (face.len - 4), big = rc()
    const rx = 0.9 + big * 1.8, ry = 0.6 + big * 1.2 + rc() * 0.4, rz = 0.9 + rc() * 1.5
    const turn = rc() * TAU
    if (face.front && Math.abs(u - HX) < 19) continue
    const out = Math.max(rx, rz) * 0.6 + 0.4
    const x = face.ax + face.dx * u + face.nx * out, z = face.az + face.dz * u + face.nz * out
    const tier = Math.floor(rc() * TONES.length)
    rock.rock(x, ry * 0.3, z, rx, ry, rz, big > 0.5 ? 1 : 0, (nx, ny) => {
      let c = scaleRGB([...TONES[(tier + tone0) % TONES.length], 0], (0.82 + rc() * 0.24) * DARK)
      if (ny > 0.45) c = mixColor(c, MOSS, Math.min(1, (ny - 0.45) / 0.35) * 0.8)
      return ny < -0.2 ? scaleRGB(c, 0.7) : c
    }, () => 0.82 + rc() * 0.32, turn)
    ctx.colliders.box(...f.w(x, ry * 0.55, z), rx * 1.5, ry * 1.3, rz * 1.5, f.yaw + turn, 0, true)
  }

  // ── the way in ──
  const FZ = HZ
  // claw marks gouged down the face beside the jaws - something tried to get out
  for (let k = 0; k < 4; k++) {
    const x0 = 11.4 + k * 0.75, y0 = 0.9 + k * 0.25, x1 = x0 + 2.1, y1 = y0 + 4.8, w = 0.14
    const gouge = [0.07, 0.055, 0.05, 0]
    rock.facet([x0 - w, y0, FZ + 0.025], [x1 + w, y1, FZ + 0.025], [x0 + w, y0, FZ + 0.025], gouge, [x0, y0, FZ - 1])
    rock.facet([x0 - w, y0, FZ + 0.025], [x1 - w, y1, FZ + 0.025], [x1 + w, y1, FZ + 0.025], gouge, [x0, y0, FZ - 1])
  }
  // rough lips of rock round the opening
  for (const sg of [-1, 1]) {
    for (let y = 0.4; y < MOUTH.h; y += 1.1)
      rock.rock(sg * (MOUTH.w / 2 + 0.35), y, FZ + 0.15, 0.6 + rc() * 0.3, 0.7, 0.7, 0, (nx, ny) => scaleRGB([0.24, 0.22, 0.2, 0], ny > 0.3 ? 0.9 : 0.7), () => 0.85 + rc() * 0.3, rc() * TAU)
    box(sg * (MOUTH.w / 2 + 0.35), MOUTH.h / 2, FZ, 1.4, MOUTH.h, 1.8, true)
  }
  for (let x = -MOUTH.w / 2 - 0.3; x <= MOUTH.w / 2 + 0.31; x += 1.05)
    rock.rock(x, MOUTH.h + 0.3, FZ + 0.15, 0.7, 0.55, 0.7, 0, (nx, ny) => scaleRGB([0.24, 0.22, 0.2, 0], ny > 0.3 ? 0.9 : 0.6), () => 0.85 + rc() * 0.3, rc() * TAU)
  // a portcullis, wrenched up and broken - bars gone, one bent out, the
  // bottom crossbar snapped
  {
    const gz = FZ - 0.7
    for (let k = 0; k <= 13; k++) {
      if (k === 5 || k === 9) continue
      const x = -3.9 + k * 0.6
      const bent = k === 3 ? 0.9 : 0
      outIron.tube([{ x, y: MOUTH.h + 0.4, z: gz, r: 0.06 }, { x, y: 5.4, z: gz, r: 0.06 }, { x: x + bent * 0.2, y: 4.5, z: gz + bent, r: 0.06 }], 5, IRON, { capEnd: false })
      outIron.crystal([x + bent * 0.2, 4.5, gz + bent], [0, -1, bent * 0.8], 0.07, 0.04, 4, IRON, { taper: 0.3, tip: 0.28 })
    }
    outIron.tube([{ x: -3.95, y: 6.4, z: gz, r: 0.07 }, { x: 3.95, y: 6.4, z: gz, r: 0.07 }], 5, IRON)
    outIron.tube([{ x: -3.95, y: 5.0, z: gz, r: 0.07 }, { x: 0.9, y: 5.0, z: gz, r: 0.07 }, { x: 1.6, y: 4.6, z: gz + 0.2, r: 0.06 }], 5, IRON)
    // two of its bars thrown down in front of it
    outIron.tube([{ x: -2.4, y: 0.07, z: FZ + 0.6, r: 0.06 }, { x: -1.3, y: 0.07, z: FZ + 2.8, r: 0.06 }], 5, IRON)
    outIron.tube([{ x: 2.0, y: 0.07, z: FZ - 1.6, r: 0.06 }, { x: 2.9, y: 0.07, z: FZ + 0.4, r: 0.06 }], 5, IRON)
    // and chains hanging loose either side, their ends torn free
    for (const sg of [-1, 1]) chain(outIron, [sg * 4.7, 9.6, FZ + 0.25], [sg * 4.5, 3.2, FZ + 0.55], IRON, 0.3)
  }
  // a gibbet out of the face, a cage hanging off it with someone still in it
  {
    const gx = -12.5, gy = 15
    outWood.box(gx, gy, FZ + 1.4, 0.36, 0.36, 3.8, 0, [0.24, 0.17, 0.11, 0])
    outWood.box(gx, gy - 1.2, FZ + 1.0, 0.24, 0.24, 3.0, 0, [0.22, 0.16, 0.1, 0], -Math.atan2(2.4, 2.0))
    const top = roundCage(outIron, gx, gy - 6.2, FZ + 3.0, 0.62, 1.9, IRON)
    chain(outIron, [gx, gy - 0.15, FZ + 3.0], [gx, top + 0.05, FZ + 3.0], IRON, 0.28)
    skull(outBone, gx + 0.15, gy - 6.0, FZ + 2.9, 1, 2.2, 0.4)
    bone(outBone, gx - 0.1, gy - 6.12, FZ + 3.1, 0.55, 0.7)
    bone(outBone, gx + 0.2, gy - 6.12, FZ + 3.15, 0.45, 2.1)
  }
  // stakes up the way to the jaws, a skull on each
  for (const [sx, dz] of [[-5.6, 4.5], [5.4, 4.8], [-6.4, 9.2], [6.2, 9.0], [-5.2, 13.8], [5.6, 13.6]]) {
    const lean = (r() - 0.5) * 0.35, x = sx, z = FZ + dz
    const tip = [x + lean, 2.75, z + (r() - 0.5) * 0.2]
    outWood.tube([{ x, y: -0.4, z, r: 0.13 }, { x: (x + tip[0]) / 2, y: 1.2, z: (z + tip[2]) / 2, r: 0.11 }, { x: tip[0], y: tip[1], z: tip[2], r: 0.02 }], 6, [0.27, 0.2, 0.13, 0])
    skull(outBone, tip[0] - lean * 0.1, 2.45, tip[2], 1.15, (r() - 0.5) * 1.2 + (sx < 0 ? 0.5 : -0.5), (r() - 0.5) * 0.5)
    box(x + lean / 2, 1.2, z, 0.32, 2.8, 0.32, true)
  }
  // bones strewn in the grass before the jaws, and in under them
  for (let i = 0; i < 16; i++) {
    const x = (r() - 0.5) * 9, z = FZ - 3 + r() * 9
    if (r() < 0.25) skull(outBone, x, 0.11, z, 1, r() * TAU, (r() - 0.5) * 0.6)
    else bone(outBone, x, 0.04, z, 0.35 + r() * 0.45, r() * TAU)
  }

  // ── the cave ──
  const caveC = (y, k = 1) => {
    const c = scaleRGB([0.28, 0.255, 0.235, 0], (0.75 + rc() * 0.3) * k)
    return y < 1.1 ? scaleRGB(c, 0.78) : c
  }
  const caveRows = [0, 1.3, 3.2, 5.6, MOUTH.h, 9, ROOF]
  // the crag's walls from inside - the front with the passage in from the jaws
  for (const [ax, az, dx, dz, nx, nz, len, front] of [
    [-IX, -IZ, 1, 0, 0, 1, 2 * IX, false],
    [IX, IZ, -1, 0, 0, -1, 2 * IX, true],
    [IX, -IZ, 0, 1, -1, 0, 2 * IZ, false],
    [-IX, IZ, 0, -1, 1, 0, 2 * IZ, false],
  ]) {
    const n = Math.round(len / 2.2)
    const us = breaks(Array.from({ length: n + 1 }, (_, i) => (i / n) * len), front ? [0, len, IX - MOUTH.w / 2, IX + MOUTH.w / 2] : [0, len], 0.3)
    rockFace(cave, ax, az, dx, dz, nx, nz, us, caveRows,
      (u, y) => (u < 0.01 || u > len - 0.01 || (front && Math.abs(Math.abs(IX - u) - MOUTH.w / 2) < 0.01 && y <= MOUTH.h)) ? 0 : rc() * 0.28,
      (A, B, C, D, u, y) => caveC(y),
      front ? (u, y) => inMouth(IX - u, y) : null)
  }
  // the passage through the jaws
  for (const sg of [-1, 1])
    rockFace(cave, sg * MOUTH.w / 2, IZ, 0, 1, -sg, 0, [0, (FZ - IZ) / 2, FZ - IZ], [0, 2.4, 4.8, MOUTH.h], () => 0, (A, B, C, D, u, y) => caveC(y, 0.8))
  floorQuad(cave, -MOUTH.w / 2, IZ, MOUTH.w / 2, FZ, MOUTH.h, caveC(MOUTH.h, 0.6), false)
  // the roof: low bulges, stalactites, glow-worms like stars
  {
    const nx = 16, nz = 12, ys = []
    for (let j = 0; j <= nz; j++) {
      const row = []
      for (let i = 0; i <= nx; i++) {
        const edge = i === 0 || j === 0 || i === nx || j === nz
        row.push([-IX + (2 * IX * i) / nx, ROOF - (edge ? 0 : 0.1 + rc() * 0.45), -IZ + (2 * IZ * j) / nz])
      }
      ys.push(row)
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const A = ys[j][i], B = ys[j][i + 1], C = ys[j + 1][i], D = ys[j + 1][i + 1]
      const c = scaleRGB([0.13, 0.12, 0.12, 0], 0.75 + rc() * 0.35), above = [A[0], ROOF + 3, A[2]]
      cave.facet(A, C, B, c, above)
      cave.facet(B, C, D, c, above)
    }
    for (let i = 0; i < 50; i++) {
      const x = (rc() * 2 - 1) * (IX - 0.5), z = (rc() * 2 - 1) * (IZ - 0.5), len = 0.5 + rc() * 2.4
      cave.crystal([x, ROOF - 0.05, z], [0, -1, 0], 0.12 + rc() * 0.24, len * 0.4, 6, caveC(ROOF, 1.2), { taper: 0.5, tip: len * 0.6 })
    }
    for (let i = 0; i < 150; i++) {
      const x = (rc() * 2 - 1) * IX, z = (rc() * 2 - 1) * IZ
      glow.blob(x, ROOF - 0.15 - rc() * 0.35, z, 0.05, 0.05, 0.05, 0, [0.6, 1.0, 0.9, 1])
    }
  }
  // the floor - packed dirt and stone, under the walls too so no seam shows
  {
    const nx = 16, nz = 12
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const x0 = -IX - 0.4 + ((2 * IX + 0.8) * i) / nx, x1 = -IX - 0.4 + ((2 * IX + 0.8) * (i + 1)) / nx
      const z0 = -IZ - 0.4 + ((2 * IZ + 0.8) * j) / nz, z1 = -IZ - 0.4 + ((2 * IZ + 0.8) * (j + 1)) / nz
      floorQuad(cave, x0, z0, x1, z1, 0.03, scaleRGB([0.17, 0.15, 0.13, 0], 0.72 + rc() * 0.4))
    }
    floorQuad(cave, -MOUTH.w / 2 - 0.3, IZ + 0.4, MOUTH.w / 2 + 0.3, FZ + 0.25, 0.03, [0.13, 0.115, 0.1, 0])
  }

  // ── the maze's walls ──
  const W = L.window
  const wallBox = (cx, cz, alongX, len, y0, y1) => alongX ? box(cx, (y0 + y1) / 2, cz, len, y1 - y0, MW) : box(cx, (y0 + y1) / 2, cz, MW, y1 - y0, len)
  const slabRows = [0, 1.4, 3.4, 6.2, ROOF]
  for (let c = 0; c < COLS * ROWS; c++) for (const k of [0, 2]) {
    const n = L.across(c, k)
    if (n < 0 || !L.wall(c, n)) continue
    const [cx, cz] = L.centre(c)
    const alongX = k === 2
    // its centre line, from node to node
    const lx = alongX ? cx : cx + PX / 2, lz = alongX ? cz + PZ / 2 : cz
    const len = alongX ? PX : PZ
    const [tx, tz] = alongX ? [1, 0] : [0, 1]
    const x0 = lx - tx * len / 2, z0 = lz - tz * len / 2
    const isWindow = Math.abs(lx - W.x) < 0.01 && Math.abs(lz - W.z) < 0.01
    const hole = isWindow ? { u0: len / 2 - WINDOW.w / 2, u1: len / 2 + WINDOW.w / 2, y0: SILL, y1: SILL + WINDOW.h } : null
    const us = breaks([0, len / 3, (2 * len) / 3, len], hole ? [hole.u0, hole.u1] : [], 0.25)
    const ys = breaks(slabRows, hole ? [hole.y0, hole.y1] : [], 0.25)
    const onHole = (u, y) => hole && ((Math.abs(u - hole.u0) < 0.01 || Math.abs(u - hole.u1) < 0.01) && y >= hole.y0 - 0.01 && y <= hole.y1 + 0.01
      || (Math.abs(y - hole.y0) < 0.01 || Math.abs(y - hole.y1) < 0.01) && u >= hole.u0 - 0.01 && u <= hole.u1 + 0.01)
    for (const sg of [-1, 1]) {
      const nx = -tz * sg, nz = tx * sg
      rockFace(cave, x0 + nx * MW / 2, z0 + nz * MW / 2, tx, tz, nx, nz, us, ys,
        (u, y) => onHole(u, y) ? 0 : (rc() - 0.35) * 0.24,
        (A, B, C, D, u, y) => caveC(y, 1.05),
        hole ? (u, y) => u > hole.u0 && u < hole.u1 && y > hole.y0 && y < hole.y1 : null)
    }
    if (hole) {
      // the window's sill, lintel and sides
      const p = u => [x0 + tx * u, z0 + tz * u]
      const [s0x, s0z] = p(hole.u0), [s1x, s1z] = p(hole.u1)
      const ox = -tz * MW / 2, oz = tx * MW / 2
      const xs = [s0x - ox, s1x - ox, s0x + ox, s1x + ox], zs = [s0z - oz, s1z - oz, s0z + oz, s1z + oz]
      floorQuad(cave, Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), hole.y0, caveC(2, 1.25))
      floorQuad(cave, Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), hole.y1, caveC(2, 0.7), false)
      for (const [jx, jz, sgn] of [[s0x, s0z, 1], [s1x, s1z, -1]]) {
        const A = [jx - ox, hole.y0, jz - oz], B = [jx + ox, hole.y0, jz + oz], C = [jx - ox, hole.y1, jz - oz], D = [jx + ox, hole.y1, jz + oz]
        const behind = [jx - tx * sgn, (hole.y0 + hole.y1) / 2, jz - tz * sgn]
        cave.facet(A, C, B, caveC(2, 0.9), behind)
        cave.facet(B, C, D, caveC(2, 0.9), behind)
        // glints of gold catching the light along each side - what is up there?
        for (let q = 0; q < 3; q++) {
          const a = (r() - 0.5) * 1.6
          gold.blob(jx + tx * sgn * 0.02 + ox * a, hole.y0 + 0.3 + r() * (WINDOW.h - 0.6), jz + tz * sgn * 0.02 + oz * a, 0.035, 0.035, 0.035, 0, [0.9, 0.65, 0.3, 1])
        }
      }
      for (let i = 0; i < 7; i++) {
        const u = hole.u0 + 0.15 + r() * (WINDOW.w - 0.3), across = (r() - 0.5) * MW * 0.8
        const [gx, gz] = p(u)
        gold.box(gx - tz * across, hole.y0 + 0.012, gz + tx * across, 0.07, 0.014, 0.07, r() * TAU, [0.8, 0.52, 0.26, 0.8])
      }
      // its colliders: either side of the window, under it and over it
      const mid = (a, b) => p((a + b) / 2)
      const [lx0, lz0] = mid(-MW / 2, hole.u0), [lx1, lz1] = mid(hole.u1, len + MW / 2), [mx, mz] = mid(hole.u0, hole.u1)
      wallBox(lx0, lz0, alongX, hole.u0 + MW / 2, 0, ROOF)
      wallBox(lx1, lz1, alongX, len + MW / 2 - hole.u1, 0, ROOF)
      wallBox(mx, mz, alongX, WINDOW.w, 0, SILL)
      wallBox(mx, mz, alongX, WINDOW.w, SILL + WINDOW.h, ROOF)
    } else {
      wallBox(lx, lz, alongX, len + MW, 0, ROOF)
    }
  }
  // a column of rock wherever walls meet, hiding the joins
  for (let J = 1; J < ROWS; J++) for (let I = 1; I < COLS; I++) {
    const a = L.id(I - 1, J - 1), b = L.id(I, J - 1), c = L.id(I - 1, J), d = L.id(I, J)
    if (!(L.wall(a, b) || L.wall(c, d) || L.wall(a, c) || L.wall(b, d))) continue
    const x = -IX + I * PX, z = -IZ + J * PZ
    cave.crystal([x, 0, z], [0, 1, 0], 0.72 + rc() * 0.08, ROOF, 6, caveC(4, 0.95), { taper: 0, tip: 0, twist: rc() * TAU })
  }

  // ── what is in it ──
  // every prop keeps off the stash spots and the climb (the layout's
  // `taken`), and off each other
  const taken = L.taken.slice()
  const isFree = (x, z, rad) => taken.every(t => Math.hypot(x - t.x, z - t.z) >= t.r + rad)
  const take = (x, z, rad) => taken.push({ x, z, r: rad })
  // somewhere against one of cell c's closed walls, `rad` clear of it, and
  // which way is out from that wall - or null
  const againstWall = (c, rad, tries = 8) => {
    const sides = L.closedSides(c)
    for (let t = 0; t < tries && sides.length; t++) {
      const k = sides[Math.floor(r() * sides.length)]
      const span = Math.max(0, (SIDES[k][0] ? PZ : PX) / 2 - 0.8 - rad)
      const [x, z] = L.atWall(c, k, rad + 0.05, (r() * 2 - 1) * span)
      if (!isFree(x, z, rad)) continue
      take(x, z, rad)
      return { x, z, out: Math.atan2(-SIDES[k][0], -SIDES[k][1]), k }
    }
    return null
  }
  const crateTone = () => 0.75 + r() * 0.4
  // a stack of cargo boxes, `n` high, with its collider - frictionless, like
  // the clouds (builders.js says why): you jump up these
  const stackAt = (x, z, n, yaw = 0, twist = 0.08) => {
    for (let i = 0; i < n; i++) crate(wood, x, i * CRATE.h, z, CRATE.w, CRATE.h, yaw + (i ? (r() - 0.5) * twist : 0), crateTone())
    ctx.colliders.box(...f.w(x, (n * CRATE.h) / 2, z), CRATE.w, n * CRATE.h, CRATE.w, f.yaw + yaw, 0, true, 0)
  }
  const mushroomsAt = (x, z, sc) => {
    caveMushrooms(mush, x, z, sc, r)
    if (sc > 0.6) box(x, 0.8 * sc, z, 0.5 * sc, 1.6 * sc, 0.5 * sc, true)
  }
  const eyesAt = (x, y, z, out, size = 0.045, gap = 0.22) => {
    const px = Math.cos(out) * gap / 2, pz = -Math.sin(out) * gap / 2
    for (const sg of [-1, 1]) ember.blob(x + sg * px, y, z + sg * pz, size, size * 0.75, size, 1, [1.0, 0.25, 0.1, 1])
  }
  const cellsOf = room => room ? room.cells : []

  // the climb: two stacks either side of the window
  const wyaw = Math.atan2(W.nx, W.nz)
  for (const st of L.stacks) stackAt(st.x, st.z, st.n, wyaw, 0)
  // the treasure room: bronze spilled round where the chest stands, the last
  // one who found it, and mushrooms grown fat in the dark
  {
    const sr = L.secret
    for (let i = 0; i < 5; i++) {
      const a = r() * TAU, d = 1.9 + r() * 1.4, x = sr.x + Math.cos(a) * d, z = sr.z + Math.sin(a) * d
      if (!isFree(x, z, 0.5)) continue
      take(x, z, 0.5)
      const rx = 0.42 + r() * 0.2, ry = 0.2 + r() * 0.14
      gold.blob(x, 0, z, rx, ry, rx, 1, [0.6, 0.39, 0.17, 0.26])
      // loose coins on the heap and round it
      for (let k = 0; k < 10; k++) {
        const a = r() * TAU, d = r() * 1.1, on = d < rx ? ry * Math.sqrt(1 - (d / rx) ** 2) : 0
        gold.box(x + Math.cos(a) * d, on + 0.02, z + Math.sin(a) * d, 0.09, 0.015, 0.09, r() * TAU, [0.72, 0.48, 0.22, 0.45], (r() - 0.5) * 0.6)
      }
    }
    const spot = againstWall(sr.cells[Math.floor(r() * 4)], 0.6)
    if (spot) skeleton(bones, spot.x, spot.z, spot.out)
    for (let i = 0; i < 3; i++) { const m = againstWall(sr.cells[i % 4], 0.9); if (m) mushroomsAt(m.x, m.z, 0.42 + r() * 0.2) }
  }
  // the antechamber: eyes in the dark straight ahead through the jaws, a cage
  // overhead, smashed cargo and the bones of those who went no further
  {
    const an = L.ante
    const backZ = -IZ + an.j0 * PZ + MW / 2 + 0.1
    eyesAt(an.x, 1.85, backZ, 0, 0.075, 0.34)
    const top = roundCage(iron, an.x + 2.6, 4.9, an.z - 1.2, 0.6, 1.8, IRON)
    chain(iron, [an.x + 2.6, ROOF, an.z - 1.2], [an.x + 2.6, top, an.z - 1.2], IRON, 0.3)
    skull(bones, an.x + 2.6, 5.05, an.z - 1.1, 1, 1.1, 0.3)
    for (let i = 0; i < 2; i++) { const p = againstWall(an.cells[Math.floor(r() * 4)], 0.75); if (p) { crate(wood, p.x, 0, p.z, 0.9, 0.5, p.out + 0.4, 0.6); box(p.x, 0.25, p.z, 1, 0.5, 1, true) } }
    const sk = againstWall(an.cells[0], 0.6)
    if (sk) skeleton(bones, sk.x, sk.z, sk.out)
    for (let i = 0; i < 10; i++) {
      const x = an.x + (r() - 0.5) * an.hx * 1.6, z = an.z + (r() - 0.5) * an.hz * 1.6
      if (r() < 0.3) skull(bones, x, 0.13, z, 1, r() * TAU, (r() - 0.5) * 0.6)
      else bone(bones, x, 0.06, z, 0.35 + r() * 0.4, r() * TAU)
    }
  }
  // the heart: a cage hung over whatever lies in the middle, a ring of great
  // glowing mushrooms, stalagmites
  {
    const h = L.heart
    const top = roundCage(iron, h.x - 2.3, 4.6, h.z + 1.6, 0.6, 1.8, IRON)
    chain(iron, [h.x - 2.3, ROOF, h.z + 1.6], [h.x - 2.3, top, h.z + 1.6], IRON, 0.3)
    bone(bones, h.x - 2.2, 4.68, h.z + 1.6, 0.5, 0.3)
    for (const c of h.cells) { const m = againstWall(c, 1.3); if (m) mushroomsAt(m.x, m.z, 0.55 + r() * 0.2) }
    for (let i = 0; i < 3; i++) {
      const p = againstWall(h.cells[i], 0.5)
      if (!p) continue
      const ht = 1 + r() * 1.3
      cave.crystal([p.x, -0.1, p.z], [0, 1, 0], 0.35, ht * 0.45, 6, caveC(1.5, 1.1), { taper: 0.55, tip: ht * 0.55 })
      box(p.x, ht / 2, p.z, 0.55, ht, 0.55, true)
    }
  }
  // the mine: cargo stacked up, barrels
  for (const c of cellsOf(L.mine)) {
    const p = againstWall(c, 0.75)
    if (p) stackAt(p.x, p.z, 1 + Math.floor(r() * 2), p.out)
    const b = againstWall(c, 0.5)
    if (b) { barrel(wood, b.x, b.z, 1.0, 0.38, crateTone()); box(b.x, 0.5, b.z, 0.7, 1, 0.7, true) }
  }
  // the pens: cages along the walls, someone in most of them - one burst open
  cellsOf(L.pens).forEach((c, i) => {
    const p = againstWall(c, 1.05)
    if (!p) return
    const broke = i === 1
    boxCage(iron, p.x, p.z, p.out, 1.5, 2.1, IRON, broke)
    box(p.x, 1.05, p.z, 1.5, 2.1, 1.5, true)
    if (!broke) skeleton(bones, p.x - Math.sin(p.out) * 0.35, p.z - Math.cos(p.out) * 0.35, p.out)
  })
  // the passages: mushrooms lighting the way here and there, cargo, bones
  for (let c = 0; c < COLS * ROWS; c++) {
    if (L.roomOf[c] >= 0 || c === L.climb.cell) continue
    if (r() < 0.26) { const m = againstWall(c, 0.8); if (m) mushroomsAt(m.x, m.z, 0.28 + r() * 0.25) }
    const roll = r()
    if (roll < 0.14) { const p = againstWall(c, 0.75); if (p) stackAt(p.x, p.z, r() < 0.3 ? 2 : 1, p.out) }
    else if (roll < 0.24) { const p = againstWall(c, 0.5); if (p) { barrel(wood, p.x, p.z, 1.0, 0.38, crateTone()); box(p.x, 0.5, p.z, 0.7, 1, 0.7, true) } }
    if (r() < 0.3) {
      const [x, z] = L.centre(c)
      const bx = x + (r() - 0.5) * 2.4, bz = z + (r() - 0.5) * 2.4
      if (isFree(bx, bz, 0.3)) r() < 0.3 ? skull(bones, bx, 0.13, bz, 1, r() * TAU, 0.3) : bone(bones, bx, 0.06, bz, 0.4 + r() * 0.3, r() * TAU)
    }
    if (r() < 0.06) { const p = againstWall(c, 0.6); if (p) skeleton(bones, p.x, p.z, p.out) }
  }
  // the dead ends no one has a use for: something watching from the back of
  // a few of them, a cage in some, glowing caps round the rarest mushrooms
  let watchers = 0
  for (const c of L.deadEnds) {
    if (L.used.has(c)) continue
    const k = L.backOf(c)
    if (watchers < 3) {
      const [x, z] = L.atWall(c, k, 0.1)
      eyesAt(x, 1.45 + r() * 0.4, z, Math.atan2(-SIDES[k][0], -SIDES[k][1]))
      watchers++
    } else if (r() < 0.45) {
      const [x, z] = L.atWall(c, k, 1.05)
      if (isFree(x, z, 1.05)) {
        take(x, z, 1.05)
        const out = Math.atan2(-SIDES[k][0], -SIDES[k][1])
        boxCage(iron, x, z, out, 1.5, 2.1, IRON, r() < 0.3)
        box(x, 1.05, z, 1.5, 2.1, 1.5, true)
        if (r() < 0.6) skeleton(bones, x - Math.sin(out) * 0.35, z - Math.cos(out) * 0.35, out)
      }
    }
  }
  if (L.patchCell !== undefined) for (let i = 0; i < 3; i++) { const m = againstWall(L.patchCell, 0.35); if (m) mushroomsAt(m.x, m.z, 0.2 + r() * 0.1) }

  place(rock, `grotto_rock_${s.key}`, 'cliff')
  place(outWood, `grotto_wood_${s.key}`, 'wood')
  place(outIron, `grotto_iron_${s.key}`, 'iron')
  place(outBone, `grotto_bone_${s.key}`, 'bone')
  place(ember, `grotto_ember_${s.key}`, 'ember')
  place(cave, `grotto_cave_${s.key}`, 'cave', FAR_INSIDE)
  place(wood, `grotto_wood_in_${s.key}`, 'wood', FAR_INSIDE)
  place(iron, `grotto_iron_in_${s.key}`, 'iron', FAR_INSIDE)
  place(bones, `grotto_bone_in_${s.key}`, 'bone', FAR_INSIDE)
  place(mush, `grotto_mushroom_${s.key}`, 'mushroom', FAR_INSIDE)
  place(glow, `grotto_glow_${s.key}`, 'glow', FAR_INSIDE)
  place(gold, `grotto_gold_${s.key}`, 'gold', FAR_INSIDE)

  // ── smoke crawling out of the way in, embers drifting up ──
  const worldBox = (x0, y0, z0, x1, y1, z1) => {
    const a = f.dir(x0, z0), b = f.dir(x1, z1)
    return [new Vector3(Math.min(a[0], b[0]), y0, Math.min(a[1], b[1])), new Vector3(Math.max(a[0], b[0]), y1, Math.max(a[1], b[1]))]
  }
  const worldDir = (x, y, z) => { const [dx, dz] = f.dir(x, z); return new Vector3(dx, y, dz) }
  {
    const ps = new ParticleSystem(`grotto_smoke_${s.key}`, 90, scene)
    ps.particleTexture = smokeTex(scene)
    ps.emitter = new Vector3(...f.w(0, 0.2, FZ - 2))
    ;[ps.minEmitBox, ps.maxEmitBox] = worldBox(-3.2, 0, -1.5, 3.2, 1.4, 1.5)
    ps.color1 = new Color4(0.05, 0.045, 0.05, 0.45)
    ps.color2 = new Color4(0.09, 0.07, 0.07, 0.32)
    ps.colorDead = new Color4(0.1, 0.09, 0.09, 0)
    ps.minSize = 2.2; ps.maxSize = 4.8
    ps.minLifeTime = 4; ps.maxLifeTime = 7.5
    ps.emitRate = 9
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD
    ps.direction1 = worldDir(-0.5, 0.05, 0.5)
    ps.direction2 = worldDir(0.5, 0.35, 1.4)
    ps.minEmitPower = 0.4; ps.maxEmitPower = 0.9
    ps.minAngularSpeed = -0.3; ps.maxAngularSpeed = 0.3
    ps.gravity = new Vector3(0, 0.02, 0)
    ps.updateSpeed = 0.016
    ps.start()
    // disposed with the chunk - but never its texture, which every grotto shares
    ctx.meshes.push({ dispose: () => ps.dispose(false) })
  }
  {
    const ps = new ParticleSystem(`grotto_embers_${s.key}`, 60, scene)
    ps.particleTexture = smokeTex(scene)
    ps.emitter = new Vector3(...f.w(0, 0.3, FZ + 0.5))
    ;[ps.minEmitBox, ps.maxEmitBox] = worldBox(-4, 0, -2.5, 4, 1.2, 1.5)
    ps.color1 = new Color4(1, 0.45, 0.12, 1)
    ps.color2 = new Color4(1, 0.22, 0.05, 0.9)
    ps.colorDead = new Color4(0.4, 0.05, 0, 0)
    ps.minSize = 0.05; ps.maxSize = 0.14
    ps.minLifeTime = 2.5; ps.maxLifeTime = 5
    ps.emitRate = 7
    ps.blendMode = ParticleSystem.BLENDMODE_ONEONE
    ps.direction1 = worldDir(-0.3, 0.6, -0.3)
    ps.direction2 = worldDir(0.3, 1.2, 0.6)
    ps.minEmitPower = 0.3; ps.maxEmitPower = 0.8
    ps.gravity = new Vector3(0, 0.15, 0)
    ps.updateSpeed = 0.016
    ps.start()
    ctx.meshes.push({ dispose: () => ps.dispose(false) })
  }

  // ── the crag's colliders: its walls, split at the jaws, and its solid top
  // over the cave ──
  const OX = HX - SET_BACK, OZ = HZ - SET_BACK
  box(0, HM / 2, -(IZ + OZ) / 2, 2 * OX, HM, OZ - IZ)
  box((IX + OX) / 2, HM / 2, 0, OX - IX, HM, 2 * OZ)
  box(-(IX + OX) / 2, HM / 2, 0, OX - IX, HM, 2 * OZ)
  for (const sg of [-1, 1]) box(sg * (MOUTH.w / 2 + OX) / 2, HM / 2, (IZ + OZ) / 2, OX - MOUTH.w / 2, HM, OZ - IZ)
  box(0, (MOUTH.h + HM) / 2, (IZ + OZ) / 2, MOUTH.w, HM - MOUTH.h, OZ - IZ)
  box(0, (ROOF + HM) / 2, 0, 2 * IX, HM - ROOF, 2 * IZ)

  return {
    kind: 'grotto', key: s.key, x: s.x, y: s.H, z: s.z,
    spots: [
      { name: 'jaws', ...xyz(f.w(0, 0, FZ)) },
      { name: 'heart', ...xyz(f.w(L.heart.x, 0, L.heart.z)) },
      { name: 'treasure', ...xyz(f.w(L.secret.x, 0, L.secret.z)) },
    ],
  }
}
