// Shared noise and easing helpers for the newer files (biomes, sites,
// features). Same hash construction world.js and river.js carry their own
// copies of, so anything built on these lines up with the existing world -
// those two files keep their local copies rather than being rewired, since a
// changed import order there is a changed world everywhere.

export function hash(x, y, seed) {
  let h = (seed * 1234567 + x * 374761393 + y * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export function lerp(a, b, t) { return a + (b - a) * t }
export function smooth(t) { return t * t * (3 - 2 * t) }
export function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x }
export function smoothstep(e0, e1, x) { return smooth(clamp01((x - e0) / (e1 - e0))) }

export function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = x - ix, fz = z - iz
  const ux = smooth(fx), uz = smooth(fz)
  return lerp(
    lerp(hash(ix, iz, seed), hash(ix + 1, iz, seed), ux),
    lerp(hash(ix, iz + 1, seed), hash(ix + 1, iz + 1, seed), ux),
    uz
  )
}

export function fbm(x, z, seed, octaves) {
  let v = 0, a = 1, f = 1, n = 0
  for (let i = 0; i < octaves; i++) {
    v += valueNoise(x * f, z * f, seed + i * 97) * a
    n += a; a *= 0.5; f *= 2
  }
  return v / n
}

/** 0..1, sharp crests where plain noise crosses its middle - ridges and dikes. */
export function ridged(x, z, seed, octaves) {
  return 1 - Math.abs(fbm(x, z, seed, octaves) * 2 - 1)
}

/**
 * Cellular noise on a jittered grid. f1/f2 are the distances to the nearest
 * and second-nearest feature points, `edge` the distance to the border
 * between their two cells (exact for a straight bisector), and cx/cz the
 * integer id of the nearest cell - stable, so it can seed per-cell values.
 */
export function cellular(x, z, size, seed) {
  const gx = Math.floor(x / size), gz = Math.floor(z / size)
  let f1 = Infinity, f2 = Infinity, c1x = 0, c1z = 0, p1x = 0, p1z = 0, p2x = 0, p2z = 0
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = gx + dx, cz = gz + dz
      const px = (cx + 0.15 + hash(cx, cz, seed) * 0.7) * size
      const pz = (cz + 0.15 + hash(cx, cz, seed + 1) * 0.7) * size
      const d = Math.hypot(x - px, z - pz)
      if (d < f1) {
        f2 = f1; p2x = p1x; p2z = p1z
        f1 = d; c1x = cx; c1z = cz; p1x = px; p1z = pz
      } else if (d < f2) {
        f2 = d; p2x = px; p2z = pz
      }
    }
  }
  const sep = Math.hypot(p2x - p1x, p2z - p1z) || 1
  const edge = (f2 * f2 - f1 * f1) / (2 * sep)
  return { f1, f2, edge, cx: c1x, cz: c1z, px: p1x, pz: p1z }
}
