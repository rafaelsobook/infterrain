// The ground exactly as the terrain chunks DRAW it - not terrainHeight's
// ideal curve, which the 16-unit grid only touches at its vertices.
//
// Anything that has to meet the drawn ground precisely (a water surface
// fading out at its shoreline, a prop's foot) reads it here: grid vertex
// heights from terrainHeight, each cell split along its (x+1, z) - (x, z+1)
// diagonal exactly as terrain.js triangulates it, and a site's lid
// (sites.js) wherever one covers a pit, since the lid is what is seen there.

import { terrainHeight } from './world'
import { lidHeightAt } from './sites'

const cache = new Map()
const CACHE_MAX = 250000
let cachedStep = 0

function gridHeight(gx, gz, step) {
  const key = gx * 1000003 + gz
  let h = cache.get(key)
  if (h === undefined) {
    h = terrainHeight(gx * step, gz * step)
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
    cache.set(key, h)
  }
  return h
}

/** Height of the drawn ground at (x, z) for a terrain grid of spacing `step`. */
export function drawnHeight(x, z, step) {
  if (step !== cachedStep) { cache.clear(); cachedStep = step }
  const lid = lidHeightAt(x, z)
  if (lid !== null) return lid
  const fxw = x / step, fzw = z / step
  const gx = Math.floor(fxw + 1e-9), gz = Math.floor(fzw + 1e-9)
  const fx = fxw - gx, fz = fzw - gz
  const h10 = gridHeight(gx + 1, gz, step), h01 = gridHeight(gx, gz + 1, step)
  if (fx + fz <= 1) {
    const h00 = gridHeight(gx, gz, step)
    return h00 + (h10 - h00) * fx + (h01 - h00) * fz
  }
  const h11 = gridHeight(gx + 1, gz + 1, step)
  return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz)
}
