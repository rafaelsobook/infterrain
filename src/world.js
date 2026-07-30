import { ZONES } from './data'

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

const VALE_END  = 1360
const MARSH_END = 2720

function biomeWeights(x, z) {
  const lat = (fbm(x * 0.0015, z * 0.001, SEED + 400, 2) - 0.5) * 1000
  const zb  = z + lat
  const t1  = clamp01((zb - (VALE_END  - 30)) / 65)
  const t2  = clamp01((zb - (MARSH_END - 30)) / 65)
  const wVale  = 1 - smooth(t1)
  const wMarsh = smooth(t1) * (1 - smooth(t2))
  const wPeaks = smooth(t2)
  return { wVale, wMarsh, wPeaks }
}

export const SPAWN_X      = 0
export const SPAWN_Z      = 500
export const spawnAreaSize = 100
const HUB_HEIGHT           = 2
const HUB_INNER_R          = spawnAreaSize * 2
const HUB_OUTER_R          = spawnAreaSize * 3.5

export const WATER_LEVEL = -10
const SEED = 42

const RIDGE_H     = 26
const RIDGE_SZ    = 55
const PASS_HW     = 20
const PASS_EDGE   = 70

function ridgeContribution(x, z) {
  let h = 0
  for (const rz of [VALE_END, MARSH_END]) {
    const dz = z - rz
    if (Math.abs(dz) > RIDGE_SZ * 3.5) continue
    const gaussZ = Math.exp(-(dz * dz) / (2 * RIDGE_SZ * RIDGE_SZ))
    const dRoad = roadDistance(x, rz)
    const passT = clamp01((dRoad - PASS_HW) / (PASS_EDGE - PASS_HW))
    h += RIDGE_H * smooth(passT) * gaussZ
  }
  return h
}

const MTN_START = 13000
const MTN_FULL  = 18000

function mountainFactor(x, z) {
  const d = Math.hypot(x - SPAWN_X, z - SPAWN_Z)
  return clamp01((d - MTN_START) / (MTN_FULL - MTN_START))
}

export function getMountainFactor(x, z) { return mountainFactor(x, z) }

export function mesaTopBlend(x, z, slope) {
  const mf = mountainFactor(x, z)
  if (mf < 0.35) return 0
  const flatness = clamp01(1 - slope / 0.14)
  return clamp01((mf - 0.35) / 0.35) * flatness
}

export function campDirtAt(x, z) {
  const cx = Math.floor(x / 18), cz = Math.floor(z / 18)
  const v = hash(cx * 13 + 7, cz * 11 + 3, SEED + 888)
  return v > 0.60 ? smooth((v - 0.60) / 0.40) : 0
}

function mountainHeight(x, z) {
  const mf = mountainFactor(x, z)
  if (mf === 0) return 0
  const MWS = 0.0014
  const mqx = (fbm(x * MWS + 4.3, z * MWS + 8.1, SEED + 71, 3) - 0.5) * 110
  const mqz = (fbm(x * MWS + 2.7, z * MWS + 6.5, SEED + 73, 3) - 0.5) * 110
  const wx2 = x + mqx, wz2 = z + mqz
  const n = fbm(wx2 * 0.0045, wz2 * 0.0045, SEED + 500, 5)
  const t = clamp01((n - 0.40) / 0.30)
  const mesa = smooth(smooth(t))
  const topDetail = (fbm(wx2 * 0.05, wz2 * 0.05, SEED + 510, 3) - 0.5) * 10
  return smooth(smooth(mf)) * (mesa * 150 + topDetail)
}

const CLEAR_CELL = 650
const CLEAR_PROB = 0.55

function getClearing(cellX, cellZ) {
  if (hash(cellX * 7 + 3, cellZ * 13 + 5, SEED + 999) > CLEAR_PROB) return null
  const h1 = hash(cellX, cellZ, SEED + 1001)
  const h2 = hash(cellX, cellZ, SEED + 1002)
  const h3 = hash(cellX, cellZ, SEED + 1003)
  const h4 = hash(cellX, cellZ, SEED + 1004)
  const wx     = cellX * CLEAR_CELL + h1 * CLEAR_CELL
  const wz     = cellZ * CLEAR_CELL + h2 * CLEAR_CELL
  if (Math.hypot(wx - SPAWN_X, wz - SPAWN_Z) < 700) return null
  const innerR = 55 + h3 * 90
  return { wx, wz, innerR, outerR: innerR * 2.5, flatH: 2 + h4 * 7 }
}

export function clearingAt(x, z) {
  const cx0 = Math.floor(x / CLEAR_CELL)
  const cz0 = Math.floor(z / CLEAR_CELL)
  let best = 0
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const cl = getClearing(cx0 + dx, cz0 + dz)
      if (!cl) continue
      const d = Math.hypot(x - cl.wx, z - cl.wz)
      if (d < cl.innerR) best = Math.max(best, 1 - smooth(d / cl.innerR))
    }
  return best
}

export function terrainHeight(x, z) {
  const WS = 0.003, WA = 120
  const qx = (fbm(x * WS + 1.7, z * WS + 9.2, SEED + 13, 3) - 0.5) * WA
  const qz = (fbm(x * WS + 8.3, z * WS + 2.8, SEED + 17, 3) - 0.5) * WA
  const wx = x + qx,  wz = z + qz

  const large = fbm(wx * 0.011, wz * 0.011, SEED,     4) - 0.5
  const fine  = fbm(wx * 0.040, wz * 0.040, SEED + 7, 2) - 0.5

  const { wVale, wMarsh, wPeaks } = biomeWeights(x, z)
  const amp  = wVale * 52 + wMarsh * 22 + wPeaks * 60
  const base = wVale *  4 + wMarsh *  2 + wPeaks * 12

  let h = large * amp + fine * 2.2 + base
  h += ridgeContribution(x, z)
  h += mountainHeight(x, z)

  if (mountainFactor(x, z) < 0.15) {
    const cx0 = Math.floor(x / CLEAR_CELL)
    const cz0 = Math.floor(z / CLEAR_CELL)
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const cl = getClearing(cx0 + dx, cz0 + dz)
        if (!cl) continue
        const d = Math.hypot(x - cl.wx, z - cl.wz)
        if (d < cl.outerR) {
          const t     = clamp01((d - cl.innerR) / (cl.outerR - cl.innerR))
          const blend = smooth(smooth(t))
          h = h * blend + cl.flatH * (1 - blend)
        }
      }
  }

  const dHub = Math.hypot(x - SPAWN_X, z - SPAWN_Z)
  if (dHub < HUB_OUTER_R) {
    const t     = clamp01((dHub - HUB_INNER_R) / (HUB_OUTER_R - HUB_INNER_R))
    const blend = smooth(smooth(t))
    h = h * blend + HUB_HEIGHT * (1 - blend)
  }

  return h
}

export function backgroundTerrainHeight(x, z, hillSize) {
  const f     = 0.011 * hillSize
  const large = fbm(x * f, z * f, SEED + 200, 3) - 0.5
  const fine  = fbm(x * f * 4, z * f * 4, SEED + 207, 2) - 0.5
  let h = large * 80 + fine * 5 + 18
  const dHub = Math.hypot(x - SPAWN_X, z - SPAWN_Z)
  if (dHub < HUB_OUTER_R) {
    const t     = clamp01((dHub - HUB_INNER_R) / (HUB_OUTER_R - HUB_INNER_R))
    const blend = smooth(smooth(t))
    h = h * blend + HUB_HEIGHT * (1 - blend)
  }
  return h
}

export function zoneBiomeAt(z) {
  for (const zone of ZONES)
    if (z >= zone.zMin && z < zone.zMax) return zone.id
  return 'vale'
}

const ROADS = [
  [
    { x:   0, z:   500 }, { x: -30, z:   650 }, { x: -55, z:   820 },
    { x: -20, z:  1000 }, { x:  10, z:  1180 }, { x:  -5, z:  1360 },
    { x:   5, z:  1550 }, { x:  -8, z:  1750 }, { x:   0, z:  1900 },
    { x:  15, z:  2100 }, { x:  -5, z:  2400 }, { x:  20, z:  3200 },
    { x: -15, z:  4000 }, { x:  35, z:  4900 }, { x: -25, z:  5800 },
    { x:  15, z:  6800 }, { x: -30, z:  7900 }, { x:  20, z:  9000 },
    { x: -10, z: 10500 },
  ],
  [
    { x:   0, z:   500 }, { x:   8, z:   385 }, { x:  -5, z:   265 },
    { x:   0, z:   155 }, { x:  15, z:     0 }, { x: -10, z:  -900 },
    { x:  20, z: -1900 }, { x: -15, z: -3000 }, { x:  10, z: -4200 },
    { x: -20, z: -5500 }, { x:  15, z: -7000 },
  ],
  [
    { x:     0, z: 500 }, { x:   120, z: 505 }, { x:   280, z: 490 },
    { x:   480, z: 480 }, { x:   700, z: 465 }, { x:  1000, z: 455 },
    { x:  1450, z: 445 }, { x:  2000, z: 440 }, { x:  2800, z: 430 },
    { x:  4000, z: 425 }, { x:  5600, z: 415 }, { x:  7500, z: 410 },
    { x:  9500, z: 405 },
  ],
  [
    { x:     0, z: 500 }, { x:  -120, z: 520 }, { x:  -280, z: 540 },
    { x:  -480, z: 550 }, { x:  -700, z: 555 }, { x: -1000, z: 560 },
    { x: -1450, z: 555 }, { x: -2000, z: 550 }, { x: -2800, z: 545 },
    { x: -4000, z: 540 }, { x: -5600, z: 530 }, { x: -7500, z: 525 },
    { x: -9500, z: 520 },
  ],
  [
    { x:   0, z:  500 }, { x:  85, z:  565 }, { x: 175, z:  625 },
    { x: 260, z:  680 }, { x: 380, z:  780 }, { x: 550, z:  930 },
    { x: 720, z: 1130 },
  ],
  [
    { x:   0, z:  500 }, { x:  90, z:  415 }, { x: 175, z:  340 },
    { x: 280, z:  240 }, { x: 420, z:  120 }, { x: 570, z:    0 },
  ],
  [
    { x:   0, z: 1800 }, { x: 100, z: 1860 },
    { x: 210, z: 1900 }, { x: 300, z: 1930 },
  ],
  [
    { x:    0, z: 1800 }, { x: -100, z: 1860 },
    { x: -210, z: 1900 }, { x: -300, z: 1930 },
  ],
]

export function roadDistance(x, z) {
  let best = Infinity
  for (const road of ROADS) {
    for (let i = 0; i < road.length - 1; i++) {
      const a = road[i], b = road[i + 1]
      const abx = b.x - a.x, abz = b.z - a.z
      const apx = x - a.x,   apz = z - a.z
      const len2 = abx * abx + abz * abz
      const t    = len2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apz * abz) / len2)) : 0
      const d    = Math.hypot(apx - abx * t, apz - abz * t)
      if (d < best) best = d
    }
  }
  return best
}
