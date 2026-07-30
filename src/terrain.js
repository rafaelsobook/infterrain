import { Mesh, VertexData, ShaderMaterial, Vector3, Color3 } from '@babylonjs/core'
import { terrainHeight, zoneBiomeAt, roadDistance, clearingAt, getMountainFactor, mesaTopBlend, campDirtAt, SPAWN_X, SPAWN_Z, spawnAreaSize } from './world'
import { groundSplatMaps } from './textures'

const LOG_PREFIX = '[infterrain]'

const VERT = /* glsl */`
  precision highp float;
  attribute vec3 position;
  attribute vec3 normal;
  attribute vec4 aSplat;
  uniform mat4 worldViewProjection;
  uniform mat4 world;
  varying vec3 vPos;
  varying vec3 vNorm;
  varying vec4 vSplat;
  void main() {
    vPos        = (world * vec4(position, 1.0)).xyz;
    vNorm       = normalize(mat3(world) * normal);
    vSplat      = aSplat;
    gl_Position = worldViewProjection * vec4(position, 1.0);
  }
`

const FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D grassTex;
  uniform sampler2D grassTex2;
  uniform sampler2D grassTex3;
  uniform sampler2D rockTex;
  uniform sampler2D rockTex2;
  uniform sampler2D roadTex;

  uniform vec3  sunDir;
  uniform vec3  sunColor;
  uniform vec3  ambientColor;
  uniform float uDist;
  uniform vec3  uCamPos;
  uniform vec3  uFogColor;
  uniform float uFogStart;
  uniform float uFogEnd;

  varying vec3 vPos;
  varying vec3 vNorm;
  varying vec4 vSplat;

  vec2 hashCell(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
  }

  vec3 stochastic(sampler2D tex, vec2 wpos, float cellSize, float freq) {
    vec2 c  = floor(wpos / cellSize);
    vec2 fr = fract(wpos / cellSize);
    vec2 bl = fr * fr * (3.0 - 2.0 * fr);
    vec3 c00 = texture2D(tex, wpos * freq + hashCell(c             )).rgb;
    vec3 c10 = texture2D(tex, wpos * freq + hashCell(c + vec2(1,0))).rgb;
    vec3 c01 = texture2D(tex, wpos * freq + hashCell(c + vec2(0,1))).rgb;
    vec3 c11 = texture2D(tex, wpos * freq + hashCell(c + vec2(1,1))).rgb;
    return mix(mix(c00, c10, bl.x), mix(c01, c11, bl.x), bl.y);
  }

  vec3 triplanar(sampler2D tex, vec3 pos, vec3 blend, float cellSize, float freq) {
    vec3 xCol = stochastic(tex, pos.yz, cellSize, freq);
    vec3 yCol = stochastic(tex, pos.xz, cellSize, freq);
    vec3 zCol = stochastic(tex, pos.xy, cellSize, freq);
    return xCol * blend.x + yCol * blend.y + zCol * blend.z;
  }

  void main() {
    vec3 tBlend = pow(abs(vNorm), vec3(4.0));
    tBlend /= dot(tBlend, vec3(1.0));

    vec3 g1 = triplanar(grassTex,  vPos, tBlend, 48.0, 0.034);
    vec3 g2 = triplanar(grassTex2, vPos, tBlend, 48.0, 0.034);
    vec3 g3 = triplanar(grassTex3, vPos, tBlend, 48.0, 0.034);

    float t1 = smoothstep(4000.0, 7000.0, uDist);
    float t2 = smoothstep(13000.0, 17000.0, uDist);
    vec3 cGrass = mix(mix(g1, g2, t1), g3, t2);

    vec3 cRoad     = triplanar(roadTex,  vPos, tBlend, 36.0, 0.042);
    vec3 cRockBase = triplanar(rockTex,  vPos, tBlend, 32.0, 0.095);
    vec3 cRockDirt = triplanar(rockTex2, vPos, tBlend, 44.0, 0.060);
    float steepness = tBlend.x + tBlend.z;
    float rockBlend = steepness * smoothstep(15.0, 60.0, vPos.y) * 0.70;
    vec3 cRock = mix(cRockBase, cRockDirt, rockBlend);

    cRoad = cRoad * vec3(1.12, 0.98, 0.80);
    float gv = 0.88 + vSplat.w * 0.24;
    cGrass *= gv;

    vec3 alb = cGrass * vSplat.x
             + cRoad  * vSplat.y
             + cRock  * vSplat.z;

    float highRock = smoothstep(90.0, 130.0, vPos.y) * 0.65;
    alb = mix(alb, cRock, highRock * (1.0 - vSplat.y));
    float snowW = smoothstep(155.0, 185.0, vPos.y) * 0.50;
    alb = mix(alb, vec3(0.88, 0.90, 0.94), snowW);

    float hemi = dot(vNorm, normalize(sunDir)) * 0.32 + 0.68;
    vec3 lit   = alb * (sunColor * hemi + ambientColor);

    float fogDist = length(vPos.xz - uCamPos.xz);
    float fogT    = clamp((fogDist - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
    gl_FragColor  = vec4(mix(lit, uFogColor, fogT), 1.0);
  }
`

function lerpSplat(w, layer, t) {
  if (t <= 0) return
  w[0] -= w[0] * t;  w[1] -= w[1] * t
  w[2] -= w[2] * t;  w[3] -= w[3] * t
  w[layer] += t
}

const CHUNK_SIZE = 256
const BAKE_RES   = 8
const BAKE_N     = (CHUNK_SIZE / BAKE_RES | 0) + 1

function bakeGrid(ox, oz, fn) {
  const g = new Float32Array(BAKE_N * BAKE_N)
  for (let iz = 0; iz < BAKE_N; iz++)
    for (let ix = 0; ix < BAKE_N; ix++)
      g[iz * BAKE_N + ix] = fn(ox + ix * BAKE_RES, oz + iz * BAKE_RES)
  return g
}

function sampleBaked(g, ox, oz, wx, wz) {
  const gx = (wx - ox) / BAKE_RES,  gz = (wz - oz) / BAKE_RES
  const c0 = gx | 0,  c1 = Math.min(c0 + 1, BAKE_N - 1)
  const r0 = gz | 0,  r1 = Math.min(r0 + 1, BAKE_N - 1)
  const fx = gx - c0, fz = gz - r0
  return g[r0 * BAKE_N + c0] * (1-fx) * (1-fz)
       + g[r0 * BAKE_N + c1] *  fx    * (1-fz)
       + g[r1 * BAKE_N + c0] * (1-fx) *  fz
       + g[r1 * BAKE_N + c1] *  fx    *  fz
}

const ROCK_THRESH = { vale: 0.32, marsh: 0.38, peaks: 0.25 }
const ROCK_SCALE  = 4

function splatAt(x, z, slope, rd, clr) {
  const w = [1, 0, 0, 0]
  const biome = zoneBiomeAt(z)
  let thresh  = ROCK_THRESH[biome] ?? 0.32
  const mf    = getMountainFactor(x, z)
  if (mf > 0) thresh = Math.max(0.15, thresh - mf * 0.15)
  if (slope > thresh) lerpSplat(w, 2, Math.min(1, (slope - thresh) * ROCK_SCALE))

  const dHub     = Math.hypot(x - SPAWN_X, z - SPAWN_Z)
  const dirtR    = spawnAreaSize * 2
  const dirtFade = spawnAreaSize * 0.5
  if (dHub < dirtR) lerpSplat(w, 1, 0.75 * Math.min(1, (dirtR - dHub) / dirtFade))

  if (mf < 0.15 && clr > 0) lerpSplat(w, 1, clr * 0.65)

  const mesa = mesaTopBlend(x, z, slope)
  if (mesa > 0) {
    lerpSplat(w, 0, mesa * 0.80)
    const camp = campDirtAt(x, z)
    if (camp > 0) lerpSplat(w, 1, camp * 0.55 * mesa)
  }

  if (rd < 3.0) {
    lerpSplat(w, 1, 0.85)
  } else if (rd < 5.0) {
    lerpSplat(w, 1, 0.85 * (1 - (rd - 3.0) / 2.0))
  }

  return w
}

function createMaterial(scene) {
  const mat = new ShaderMaterial('terrainMat', scene, {
    vertexSource:   VERT,
    fragmentSource: FRAG,
  }, {
    attributes: ['position', 'normal', 'aSplat'],
    uniforms:   ['worldViewProjection', 'world', 'sunDir', 'sunColor', 'ambientColor', 'uDist', 'uCamPos', 'uFogColor', 'uFogStart', 'uFogEnd'],
    samplers:   ['grassTex', 'grassTex2', 'grassTex3', 'rockTex', 'rockTex2', 'roadTex'],
  })

  const { grass, darkGrass1, darkGrass2, rockdirt, rockdirt2, road } = groundSplatMaps()
  const textures = { grass, darkGrass1, darkGrass2, rockdirt, rockdirt2, road }
  const missing = Object.entries(textures).filter(([, tex]) => !tex).map(([name]) => name)
  if (missing.length) {
    console.warn(`${LOG_PREFIX} missing texture(s) from groundSplatMaps():`, missing.join(', '))
  } else {
    console.log(`${LOG_PREFIX} textures loaded ok (grass, darkGrass1, darkGrass2, rockdirt, rockdirt2, road)`)
  }
  mat.setTexture('grassTex',  grass)
  mat.setTexture('grassTex2', darkGrass1)
  mat.setTexture('grassTex3', darkGrass2)
  mat.setTexture('rockTex',   rockdirt)
  mat.setTexture('rockTex2',  rockdirt2)
  mat.setTexture('roadTex',   road)

  const dir = new Vector3(0.4, 1, 0.3).normalize()
  mat.setVector3('sunDir',      dir)
  mat.setColor3('sunColor',     new Color3(1.00, 0.98, 0.88))
  mat.setColor3('ambientColor', new Color3(0.24, 0.35, 0.18))
  mat.setFloat('uDist', 0)
  mat.setVector3('uCamPos',  Vector3.Zero())
  mat.setColor3('uFogColor', new Color3(0.65, 0.78, 0.88))
  mat.setFloat('uFogStart',  400)
  mat.setFloat('uFogEnd',    1400)

  return mat
}

function buildChunk(scene, mat, ox, oz, verts) {
  const step  = CHUNK_SIZE / (verts - 1)
  const total = verts * verts
  const rdGrid  = bakeGrid(ox, oz, roadDistance)
  const clrGrid = bakeGrid(ox, oz, clearingAt)

  const hGrid = new Float32Array(total)
  for (let iz = 0; iz < verts; iz++)
    for (let ix = 0; ix < verts; ix++)
      hGrid[iz * verts + ix] = terrainHeight(ox + ix * step, oz + iz * step)

  const positions = new Float32Array(total * 3)
  const normals   = new Float32Array(total * 3)
  const splats    = new Float32Array(total * 4)
  let vi = 0, ni = 0, si = 0

  for (let iz = 0; iz < verts; iz++) {
    for (let ix = 0; ix < verts; ix++) {
      const wx = ox + ix * step
      const wz = oz + iz * step
      positions[vi++] = wx - ox
      positions[vi++] = hGrid[iz * verts + ix]
      positions[vi++] = wz - oz

      const ixL = Math.max(0, ix - 1), ixR = Math.min(verts - 1, ix + 1)
      const izD = Math.max(0, iz - 1), izU = Math.min(verts - 1, iz + 1)
      const dx  = (hGrid[iz * verts + ixR] - hGrid[iz * verts + ixL]) / ((ixR - ixL) * step)
      const dz  = (hGrid[izU * verts + ix] - hGrid[izD * verts + ix]) / ((izU - izD) * step)
      const len = Math.sqrt(dx * dx + 1 + dz * dz)
      normals[ni++] = -dx / len
      normals[ni++] =   1 / len
      normals[ni++] = -dz / len

      const slope = Math.sqrt(dx * dx + dz * dz)
      const rd  = sampleBaked(rdGrid,  ox, oz, wx, wz)
      const clr = sampleBaked(clrGrid, ox, oz, wx, wz)
      const w   = splatAt(wx, wz, slope, rd, clr)
      const tint = (Math.sin(wx * 0.21) * Math.cos(wz * 0.17) + 1) * 0.5
      splats[si++] = w[0]; splats[si++] = w[1]
      splats[si++] = w[2]; splats[si++] = tint
    }
  }

  const idxCount = (verts - 1) * (verts - 1) * 6
  const indices  = new Int32Array(idxCount)
  let ii = 0
  for (let iz = 0; iz < verts - 1; iz++)
    for (let ix = 0; ix < verts - 1; ix++) {
      const i = iz * verts + ix
      indices[ii++] = i;       indices[ii++] = i + 1;          indices[ii++] = i + verts
      indices[ii++] = i + 1;   indices[ii++] = i + verts + 1;  indices[ii++] = i + verts
    }

  const vd     = new VertexData()
  vd.positions = positions
  vd.indices   = indices
  vd.normals   = normals

  const mesh = new Mesh(`chunk_${ox}_${oz}`, scene)
  mesh.position.set(ox, 0, oz)
  vd.applyToMesh(mesh)
  mesh.setVerticesData('aSplat', splats, false, 4)
  mesh.material = mat
  return mesh
}

export function createInfiniteTerrain(scene, options = {}) {
  const {
    onChunkBuilt,
    onChunkDisposed,
    viewRadius   = 2,
    unloadRadius,
    verts        = 17,
  } = options
  const VIEW_R   = viewRadius
  const UNLOAD_R = unloadRadius ?? (viewRadius + 2)

  if (!scene) {
    console.error(`${LOG_PREFIX} createInfiniteTerrain() called without a scene — terrain will not render`)
  }
  console.log(`${LOG_PREFIX} init: viewRadius=${VIEW_R} unloadRadius=${UNLOAD_R} verts=${verts} chunkSize=${CHUNK_SIZE}`)

  const mat        = createMaterial(scene)
  const chunks     = new Map()
  const buildQueue = []
  const QUEUE_BATCH = 4
  let builtCount   = 0
  let loggedFirstChunk = false
  let warnedNoCamera   = false

  function enqueue(key, ox, oz, dist2) {
    let lo = 0, hi = buildQueue.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; buildQueue[mid].dist2 < dist2 ? lo = mid + 1 : hi = mid }
    buildQueue.splice(lo, 0, { key, ox, oz, dist2 })
  }

  function update(camX, camZ) {
    const cx0 = Math.floor(camX / CHUNK_SIZE)
    const cz0 = Math.floor(camZ / CHUNK_SIZE)
    for (const [key, mesh] of chunks) {
      const [cx, cz] = key.split(',').map(Number)
      if (Math.abs(cx - cx0) > UNLOAD_R || Math.abs(cz - cz0) > UNLOAD_R) {
        onChunkDisposed?.(mesh)
        mesh.dispose(); chunks.delete(key)
      }
    }
    for (let dz = -VIEW_R; dz <= VIEW_R; dz++) {
      for (let dx = -VIEW_R; dx <= VIEW_R; dx++) {
        const key = `${cx0 + dx},${cz0 + dz}`
        if (!chunks.has(key) && !buildQueue.some(q => q.key === key)) {
          enqueue(key, (cx0 + dx) * CHUNK_SIZE, (cz0 + dz) * CHUNK_SIZE, dx*dx + dz*dz)
        }
      }
    }
  }

  update(SPAWN_X, SPAWN_Z)

  let prevCX = null, prevCZ = null
  scene.onBeforeRenderObservable.add(() => {
    const cam = scene.activeCamera
    if (!cam) {
      if (!warnedNoCamera) {
        warnedNoCamera = true
        console.warn(`${LOG_PREFIX} no scene.activeCamera set — terrain streaming is paused until one exists`)
      }
      return
    }
    for (let i = 0; i < QUEUE_BATCH && buildQueue.length; i++) {
      const { key, ox, oz } = buildQueue.shift()
      if (!chunks.has(key)) {
        const mesh = buildChunk(scene, mat, ox, oz, verts)
        chunks.set(key, mesh)
        builtCount++
        if (!loggedFirstChunk) {
          loggedFirstChunk = true
          console.log(`${LOG_PREFIX} first chunk built ok (${key}) — terrain generation is working`)
        } else if (builtCount % 25 === 0) {
          console.log(`${LOG_PREFIX} ${builtCount} chunks built, ${chunks.size} currently loaded`)
        }
        onChunkBuilt?.(mesh)
      }
    }
    const dist = Math.hypot(cam.position.x - SPAWN_X, cam.position.z - SPAWN_Z)
    mat.setFloat('uDist', dist)
    mat.setVector3('uCamPos',  cam.position)
    mat.setColor3('uFogColor', scene.fogColor)
    mat.setFloat('uFogStart',  scene.fogStart)
    mat.setFloat('uFogEnd',    scene.fogEnd)
    const cx = Math.floor(cam.position.x / CHUNK_SIZE)
    const cz = Math.floor(cam.position.z / CHUNK_SIZE)
    if (cx !== prevCX || cz !== prevCZ) {
      prevCX = cx; prevCZ = cz
      update(cam.position.x, cam.position.z)
    }
  })

  return { chunks, mat }
}
