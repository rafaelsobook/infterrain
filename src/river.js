// ── River geometry + character ────────────────────────────────────────────
//
// Pure math. This file knows NOTHING about terrain height, meshes or Babylon -
// it only answers "where is the river at this world position, how wide/deep is
// it here, and what does it look like". world.js is what carves the terrain
// with it, and rivermesh.js is what draws the water. Keeping it dependency-free
// is what stops the import cycle that would otherwise exist (world.js needs the
// river to carve, the river would need world.js for the bed elevation) - the
// bed elevation is world.js's job precisely because it is the one part that
// genuinely depends on the land.
//
// The river runs along Z and meanders in X, matching how the rest of this world
// is laid out (zones band across Z, the main roads run along Z). It is infinite
// in both directions because every function here is a pure function of z - there
// is no start, no end, and no stored state to stream.

const SEED = 42

// ── noise (same construction world.js uses, kept local so this file has no imports)
function hash(x, y, seed) {
  let h = (seed * 1234567 + x * 374761393 + y * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
function lerp(a, b, t) { return a + (b - a) * t }
function smooth(t)      { return t * t * (3 - 2 * t) }
function clamp01(x)     { return x < 0 ? 0 : x > 1 ? 1 : x }

function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = x - ix,        fz = z - iz
  const ux = smooth(fx),    uz = smooth(fz)
  return lerp(
    lerp(hash(ix,     iz,     seed), hash(ix + 1, iz,     seed), ux),
    lerp(hash(ix,     iz + 1, seed), hash(ix + 1, iz + 1, seed), ux),
    uz
  )
}
function fbm(x, z, seed, octaves) {
  let v = 0, a = 1, f = 1, n = 0
  for (let i = 0; i < octaves; i++) {
    v += valueNoise(x * f, z * f, seed + i * 97) * a
    n += a; a *= 0.5; f *= 2
  }
  return v / n
}

// ── Where the river runs ──────────────────────────────────────────────────

// Far enough east of the spawn hub (SPAWN_X 0, HUB_OUTER_R 350) that the
// meander below can never swing into it, but close enough to actually be found
// on foot - roughly two terrain chunks out, so it streams in as you walk east.
export const RIVER_BASE_X = 500
// Two octaves: long lazy sweeps you follow for hundreds of units, plus a
// smaller wobble so no stretch is ever a straight line. Total swing stays
// inside +-150 so the closest approach to the hub is RIVER_BASE_X - 150 = 350,
// exactly HUB_OUTER_R, and the two never overlap.
const MEANDER_BROAD_AMP  = 110
const MEANDER_BROAD_FREQ = 0.0012
const MEANDER_FINE_AMP   = 40
const MEANDER_FINE_FREQ  = 0.0065

/** X position of the river's centre at this Z. The river's whole path. */
export function riverCenterX(z) {
  const broad = (fbm(z * MEANDER_BROAD_FREQ, 17.3, SEED + 2100, 2) - 0.5) * 2 * MEANDER_BROAD_AMP
  const fine  = (fbm(z * MEANDER_FINE_FREQ,  41.7, SEED + 2200, 2) - 0.5) * 2 * MEANDER_FINE_AMP
  return RIVER_BASE_X + broad + fine
}

// ── Variety, every 100 units ──────────────────────────────────────────────
//
// The river is cut into 100-unit segments along Z and each one draws a
// character from this table by hash, so the same stretch of world always looks
// the same but no two neighbours are alike. Segments cross-fade over
// TRANSITION units rather than switching hard, so a stretch reads as "widening
// into shallows" instead of changing width at an invisible line.
//
//   halfWidth  channel half-width at the waterline
//   depth      how far the bed sits below the water surface
//   bank       extra horizontal run over which the carve blends back into
//              untouched terrain - small means a steep cut, large a soft valley
//   flow       downstream scroll speed multiplier for the water shader
//   turb       0 glassy, 1 broken whitewater
//   rock       how much of the bed and bank paints as rock instead of dirt
export const RIVER_SEGMENT = 100
const TRANSITION = 34

// A NOTE ON THE WIDTHS, because they look larger than they should.
//
// The terrain mesh only evaluates terrainHeight at its grid vertices and
// interpolates flat between them - at the default verts:17 that is one sample
// every 16 units. A channel narrower than a couple of grid cells therefore is
// not in the rendered mesh at all, however deep it is carved analytically.
// Measured on the first draft, which used a 4-unit half-width for the gorge:
// only 19% of its 9m cut survived into the mesh, and the player would have
// walked over a 1.7m dip. Every width below is sized against that grid, and
// setTerrainStep() below enforces a floor if a host picks a coarser one.
export const RIVER_VARIANTS = [
  { id: 'calm',     halfWidth: 23, depth: 3.2, bank: 16, flow: 1.00, turb: 0.15, rock: 0.15 },
  { id: 'wide',     halfWidth: 34, depth: 2.4, bank: 22, flow: 0.60, turb: 0.08, rock: 0.10 },
  { id: 'narrow',   halfWidth: 16, depth: 4.5, bank: 12, flow: 1.80, turb: 0.35, rock: 0.35 },
  { id: 'rapids',   halfWidth: 19, depth: 2.2, bank: 13, flow: 2.60, turb: 0.95, rock: 0.75 },
  { id: 'gorge',    halfWidth: 13, depth: 7.0, bank:  8, flow: 2.00, turb: 0.55, rock: 0.90 },
  { id: 'shallows', halfWidth: 42, depth: 1.3, bank: 24, flow: 0.90, turb: 0.30, rock: 0.55 },
  { id: 'pool',     halfWidth: 30, depth: 6.5, bank: 20, flow: 0.15, turb: 0.02, rock: 0.05 },
]

// Smallest channel half-width that the terrain mesh can actually represent,
// expressed in grid cells. Set from the real grid step by setTerrainStep().
const MIN_CHANNEL_CELLS = 1.6
let minHalfWidth = 0

/**
 * Told to the river by terrain.js once it knows its own grid spacing, so the
 * narrow variants can never be carved finer than the mesh can draw. A host
 * that raises `verts` gets a proportionally finer river for free, and one that
 * lowers it gets a wider river instead of an invisible one.
 */
export function setTerrainStep(step) {
  minHalfWidth = (step * MIN_CHANNEL_CELLS) / 2
}

// Weighted pick rather than a flat one, so the river reads as a river with
// features in it rather than a random sampler - calm/wide stretches are the
// connective tissue, gorges and pools are events you come across.
const VARIANT_WEIGHTS = [26, 20, 14, 12, 8, 12, 8]
const WEIGHT_TOTAL = VARIANT_WEIGHTS.reduce((a, b) => a + b, 0)

/** Which variant owns segment index `seg`. Stable forever for a given seed. */
export function variantForSegment(seg) {
  let roll = hash(seg, 7717, SEED + 3300) * WEIGHT_TOTAL
  for (let i = 0; i < VARIANT_WEIGHTS.length; i++) {
    roll -= VARIANT_WEIGHTS[i]
    if (roll < 0) return RIVER_VARIANTS[i]
  }
  return RIVER_VARIANTS[0]
}

// per-segment jitter so two stretches that drew the same variant are still not
// identical twins - +-18% on the numbers, never on the identity
function segmentScale(seg, salt) {
  return 0.82 + hash(seg, salt, SEED + 3400) * 0.36
}

const BLEND_KEYS = ['halfWidth', 'depth', 'bank', 'flow', 'turb', 'rock']

/**
 * The river's character at this Z - variant values blended across the segment
 * boundary. `variantId`/`nextId`/`blend` come along so a caller can tell what
 * it is looking at (rivermesh.js uses them for nothing yet, but a host wanting
 * to place rocks/rapids props or name the stretch has it for free).
 */
export function riverProfileAt(z) {
  const segF = z / RIVER_SEGMENT
  const seg  = Math.floor(segF)
  const f    = segF - seg

  const a = variantForSegment(seg)
  // blend into the NEXT segment over the last TRANSITION units, and out of the
  // PREVIOUS one over the first - expressed as one lerp by picking whichever
  // neighbour is in range.
  //
  // otherSeg is derived from the BRANCH, never from comparing the two variant
  // objects. Deriving it from `other === a` looks equivalent and is not: when
  // two consecutive segments happen to draw the same variant that test says
  // "no neighbour", collapsing otherSeg back to seg - so the per-segment
  // jitter below switched from scale(seg) to scale(seg+1) instantly at the
  // boundary instead of being blended across it. That put a measured 4.3-unit
  // step in the channel width at every repeated-variant boundary.
  const edge = TRANSITION / RIVER_SEGMENT
  let otherSeg = seg, t = 0
  if (f > 1 - edge) {
    otherSeg = seg + 1
    t = smooth((f - (1 - edge)) / edge) * 0.5
  } else if (f < edge) {
    otherSeg = seg - 1
    t = smooth((edge - f) / edge) * 0.5
  }
  const other = variantForSegment(otherSeg)

  const out = { variantId: a.id, nextId: other.id, blend: t }
  for (const key of BLEND_KEYS) {
    const av = a[key]     * segmentScale(seg,      key.length * 31)
    const bv = other[key] * segmentScale(otherSeg, key.length * 31)
    out[key] = lerp(av, bv, t)
  }
  // applied after the blend, never to the table itself, so the clamp cannot
  // make two different variants collapse into the same shape at a boundary
  if (out.halfWidth < minHalfWidth) out.halfWidth = minHalfWidth
  return out
}

// ── Cross-section ─────────────────────────────────────────────────────────

/**
 * Signed distance from the river's centreline, in units, at this position.
 * Negative is west of centre, positive east - the sign is what lets a caller
 * tell the two banks apart (rivermesh.js uses it to lay the ribbon out).
 */
export function riverOffset(x, z) {
  return x - riverCenterX(z)
}

/**
 * How the river affects this point.
 *
 *   channel  1 inside the water channel, 0 outside - the wet part
 *   dist     absolute distance from the centreline
 *   profile  the blended variant values here
 *
 * The SHAPE of the carve is deliberately not decided here. It depends on how
 * deep the cut actually turns out to be against the real land, which only
 * world.js knows - see its own carveRiver for the three-zone cross-section.
 */
export function riverAt(x, z) {
  const p = riverProfileAt(z)
  const dist = Math.abs(riverOffset(x, z))
  return { channel: dist <= p.halfWidth ? 1 : 0, dist, profile: p }
}

/** Cheap "is this in the water" test for scatter passes (grass, trees). */
export function isInRiver(x, z, margin = 0) {
  const p = riverProfileAt(z)
  return Math.abs(riverOffset(x, z)) < p.halfWidth + margin
}

/**
 * 0..1 "how much does the river own the ground here", for the terrain splat.
 * Full across the wet channel, then easing out through the bank so a bed
 * paints as gravel and rock while the shore only picks up a hint of it.
 */
export function riverGroundInfluence(x, z) {
  const p = riverProfileAt(z)
  const dist = Math.abs(riverOffset(x, z))
  if (dist <= p.halfWidth) return 1
  const shore = p.bank * 0.8
  if (dist >= p.halfWidth + shore) return 0
  return (1 - smooth((dist - p.halfWidth) / shore)) * 0.7
}
