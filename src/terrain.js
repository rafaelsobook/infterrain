import { Mesh, VertexData, ShaderMaterial, Vector3, Color3 } from '@babylonjs/core'
import { terrainHeight, zoneBiomeAt, roadDistance, clearingAt, getMountainFactor, mesaTopBlend, campDirtAt, SPAWN_X, SPAWN_Z, spawnAreaSize, riverSplatAt, riverRockAt, lavaLevelAt, riverSurfaceY, riverStrength, WATER_LEVEL } from './world'
import { biomeWeightsAt } from './biomes'
import { lidHeightAt, setSiteGridStep } from './sites'
import { drawnHeight } from './ground'
import { riverCenterX, riverProfileAt } from './river'
import { groundSplatMaps } from './textures'
import { setTerrainStep } from './river'
import { FOG_UNIFORM_NAMES, FOG_UNIFORMS_GLSL, FOG_FACTOR_GLSL, syncFogUniforms } from './fog'

const LOG_PREFIX = '[infterrain]'

// Same gate as index.js - progress tracing off by default, warn/error left
// unconditional so real failures still surface. Set both flags to true when
// diagnosing this module inside a host game.
const DEBUG = false
const log = (...args) => { if (DEBUG) console.log(...args) }

const VERT = /* glsl */`
  precision highp float;
  attribute vec3 position;
  attribute vec3 normal;
  attribute vec4 aSplat;
  attribute vec4 aBiome;
  attribute vec4 aBiome2;
  uniform mat4 worldViewProjection;
  uniform mat4 world;
  varying vec3 vPos;
  varying vec3 vNorm;
  varying vec4 vSplat;
  varying vec4 vBiome;
  varying vec4 vBiome2;
  void main() {
    vPos        = (world * vec4(position, 1.0)).xyz;
    vNorm       = normalize(mat3(world) * normal);
    vSplat      = aSplat;
    vBiome      = aBiome;
    vBiome2     = aBiome2;
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
  uniform float uTime;
${FOG_UNIFORMS_GLSL}
${FOG_FACTOR_GLSL}

  varying vec3 vPos;
  varying vec3 vNorm;
  varying vec4 vSplat;
  varying vec4 vBiome;
  varying vec4 vBiome2;

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  vec2 cells(vec2 p) {
    vec2 g = floor(p), f = fract(p);
    float f1 = 8.0, f2 = 8.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 o = vec2(float(i), float(j));
        vec2 r = o + vec2(hash21(g + o), hash21(g + o + 17.3)) - f;
        float d = dot(r, r);
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
      }
    }
    return vec2(sqrt(f1), sqrt(f2));
  }

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

    // ── biomes (biomes.js) - recoloured from the textures already sampled
    // above rather than new ones, so a strange land costs arithmetic, not
    // twelve more texture taps per layer
    float wE = vBiome.x;
    float wT = vBiome.y;
    float wM = vBiome.z;
    float wC = vBiome.w;
    float wN = vBiome2.x;
    float wsum = wE + wT + wM + wC + wN;
    vec3 glow = vec3(0.0);
    if (wsum > 0.003) {
      // Each biome's look is worked out only where that biome is - they used
      // to be computed everywhere in the wilds and weighted to nothing, about
      // a hundred noise lookups a pixel. And the fine detail (grain, ripples,
      // pebbles, cracks, blossoms, glints) only near the camera: past ~110
      // it is smaller than a pixel and deep in the fog, so far ground pays
      // for little more than its plain colour
      float near = 1.0 - smoothstep(70.0, 110.0, length(vPos - uCamPos));
      bool fine = near > 0.0;
      float detail = 0.5;
      if (fine && wE + wC > 0.003) detail = mix(0.5, vnoise(vPos.xz * 0.35) * 0.5 + vnoise(vPos.xz * 1.7) * 0.5, near);
      vec3 b = vec3(0.0);
      if (wE > 0.003) {
        vec3 basalt = vec3(0.13, 0.12, 0.14) * (0.6 + luma(cRockBase) * 1.3) * (0.8 + detail * 0.4);
        b += basalt * wE;
      }
      if (wT > 0.003) {
        // sand - ripples that wander and fade in and out rather than ruling
        // the whole dune field in parallel lines, darker drifts, a few pebbles
        float drift = vnoise(vPos.xz * 0.018);
        float ripple = 0.0;
        if (fine) {
          float rp = dot(vPos.xz, vec2(0.8, 0.6)) * 1.5 + vnoise(vPos.xz * 0.09) * 7.0;
          ripple = (sin(rp) * 0.5 + 0.5) * smoothstep(0.3, 0.8, vnoise(vPos.xz * 0.04 + 3.0)) * near;
        }
        vec3 sand = vec3(1.0, 0.8, 0.5) * (0.82 + luma(cRoad) * 0.5) * (0.84 + drift * 0.28) * (0.95 + ripple * 0.08);
        if (fine) {
          float pebble = step(0.985, hash21(floor(vPos.xz * 2.2)));
          sand = mix(sand, vec3(0.32, 0.27, 0.22), pebble * 0.7 * near);
        }
        b += sand * wT;
      }
      if (wM > 0.003) {
        // meadow - small round blossoms scattered through bright grass
        vec3 meadow = vec3(0.36, 0.66, 0.36) * (0.62 + luma(cGrass) * 1.1);
        if (fine) {
          vec2 bp = vPos.xz * 1.6;
          vec2 bc = floor(bp);
          vec2 bo = fract(bp) - 0.5 - (vec2(hash21(bc + 1.7), hash21(bc + 5.3)) - 0.5) * 0.5;
          float bloom = step(0.9, hash21(bc)) * (1.0 - smoothstep(0.1, 0.2, length(bo)));
          float pick = hash21(bc + 3.1);
          vec3 petal = pick < 0.33 ? vec3(1.0, 0.55, 0.78) : (pick < 0.66 ? vec3(1.0, 0.98, 0.9) : vec3(1.0, 0.82, 0.3));
          meadow = mix(meadow, petal * 1.25, bloom * near);
        }
        b += meadow * wM;
      }
      if (wC > 0.003) {
        // crystal - pale stone split by fine cracks
        float crack = 0.0;
        if (fine) {
          vec2 cw = vPos.xz * 0.13 + vec2(vnoise(vPos.xz * 0.04), vnoise(vPos.xz * 0.04 + 9.0)) * 1.6;
          vec2 cc = cells(cw);
          crack = (1.0 - smoothstep(0.0, 0.03, cc.y - cc.x)) * near;
        }
        vec3 pale = vec3(0.74, 0.72, 0.84) * (0.6 + luma(cRockBase) * 0.8) * (0.85 + detail * 0.3) * (1.0 - crack * 0.3);
        b += pale * wC;
      }
      if (wN > 0.003) b += (cGrass * vec3(0.38, 0.58, 0.42) + vec3(0.012, 0.03, 0.022)) * wN;
      alb = mix(alb, b / max(wsum, 0.0001), clamp(wsum, 0.0, 1.0) * (1.0 - vSplat.y * 0.75));

      if (wE > 0.003) {
        float lava = vBiome2.y;
        // magma showing through cracks in the basalt - broad plates with a
        // few live veins between them (seen from afar), the rest gone cold
        // and dark, and a finer craze of hairline cracks that only glow
        // faintly (near only)
        vec2 vw = vPos.xz * 0.075 + vec2(vnoise(vPos.xz * 0.025), vnoise(vPos.xz * 0.025 + 4.0)) * 1.8;
        vec2 c = cells(vw);
        float width = 0.03 + 0.06 * vnoise(vPos.xz * 0.05);
        float vein = 1.0 - smoothstep(0.0, width, c.y - c.x);
        float live = smoothstep(0.38, 0.62, vnoise(vPos.xz * 0.028 + 7.0));
        float craze = 0.0;
        if (fine) {
          vec2 c2 = cells(vPos.xz * 0.26 + vec2(vnoise(vPos.xz * 0.09 + 2.0)) * 1.2);
          craze = (1.0 - smoothstep(0.0, 0.035, c2.y - c2.x)) * near;
        }
        float pulse = 0.6 + 0.4 * sin(uTime * 1.1 + c.x * 7.0 + vPos.z * 0.04);
        float heat = 1.0 - smoothstep(lava - 0.2, lava + 1.4, vPos.y);
        vec3 magma = mix(vec3(1.0, 0.22, 0.04), vec3(1.0, 0.55, 0.12), pulse);
        glow += magma * ((vein * live + craze * live * 0.25) * pulse * 0.9 + heat * 0.55) * wE;
        alb *= 1.0 - (vein * 0.7 + craze * 0.3) * wE;
      }
      if (wC > 0.003 && fine) {
        // shards of crystal in the stone catching the light
        vec2 sc = floor(vPos.xz * 2.5);
        vec2 so = fract(vPos.xz * 2.5) - 0.5;
        float shard = step(0.965, hash21(sc)) * (1.0 - smoothstep(0.05, 0.16, length(so))) * near;
        float tw = 0.45 + 0.55 * sin(uTime * 2.4 + hash21(sc + 9.0) * 40.0);
        vec3 tintC = mix(vec3(0.45, 0.85, 1.0), vec3(0.85, 0.45, 1.0), hash21(sc + 4.0));
        glow += tintC * shard * tw * wC * 0.8;
        alb = mix(alb, tintC * 0.6, shard * wC * 0.6);
      }
    }

    // wet shore - the ground darkens over the last stretch above any water
    // line, lake or river, so a shore reads as one instead of grass running
    // straight into the water
    float wetLine = vBiome2.z;
    float wet = 1.0 - smoothstep(wetLine - 0.2, wetLine + 1.6, vPos.y);
    alb = mix(alb, alb * vec3(0.52, 0.56, 0.5), wet * 0.85);

    float hemi = dot(vNorm, normalize(sunDir)) * 0.32 + 0.68;
    vec3 lit   = alb * (sunColor * hemi + ambientColor) + glow;

    // fog.js owns the distance and curve maths, shared with grass.js so the
    // two cannot drift into fogging at different rates in the same scene
    gl_FragColor  = vec4(mix(lit, uFogColor, fogFactor(vPos)), 1.0);
  }
`

// Pushes the host scene's REAL lights into the terrain material.
//
// These three uniforms used to be hardcoded literals set once at material
// creation, which meant the terrain was lit by a fixed imaginary sun and had
// no connection to the scene's actual lights at all - a host could change
// every light it owned and the ground would not shift by one shade. That also
// made a day/night cycle or weather-driven lighting impossible for terrain
// while working fine for everything else in the same scene.
//
// The shader only has one directional term plus a flat ambient, so this picks
// the single strongest DirectionalLight for the sun and folds every
// HemisphericLight into the ambient. Anything else (point, spot) is ignored -
// they are local lights and this shader has no position-dependent term to feed
// them into. Falls back to the previous literals when a scene has neither.
export function syncTerrainLighting(mat, scene) {
  let sun = null
  let ambient = null

  for (const light of scene.lights) {
    if (!light.isEnabled()) continue
    // duck-typed rather than instanceof, so this does not force the host to
    // share the exact same @babylonjs/core module instance as this package
    if (light.direction && light.getClassName?.() === 'DirectionalLight') {
      if (!sun || light.intensity > sun.intensity) sun = light
    } else if (light.getClassName?.() === 'HemisphericLight') {
      if (!ambient || light.intensity > ambient.intensity) ambient = light
    }
  }

  if (sun) {
    // negated: a Babylon DirectionalLight.direction points the way light
    // TRAVELS, while the shader's sunDir is the direction TOWARD the sun
    mat.setVector3('sunDir', sun.direction.negate().normalize())
    mat.setColor3('sunColor', sun.diffuse.scale(sun.intensity))
  }

  if (ambient) {
    // groundColor is what a HemisphericLight bounces up from below, which is
    // the closest thing it has to an ambient floor for ground geometry
    const base = ambient.groundColor ?? ambient.diffuse
    mat.setColor3('ambientColor', base.scale(ambient.intensity))
  }
}

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

  // the river bed and its shore. Applied LAST so it wins over the road and
  // clearing passes above - where a road fords the river you are looking at a
  // gravel crossing, not a dirt track that happens to be wet.
  //
  // Two layers, not one: dirt for the silt of a slow channel, rock on top of
  // it scaled by the stretch's own rockiness, so a rapid or a gorge reads as
  // a boulder bed while a pool reads as mud. That is river.js's per-100-unit
  // variety showing up in the GROUND as well as in the water.
  const riv = riverSplatAt(x, z)
  if (riv > 0) {
    lerpSplat(w, 1, riv * 0.9)
    const rock = riverRockAt(x, z)
    if (rock > 0) lerpSplat(w, 2, rock * 0.85)
  }

  return w
}

// The biome attributes for one ground vertex:
//   aBiome   emberfrost, thornvine, cloudmeadow, crystal weights
//   aBiome2  skyneedle weight, lava level (emberfrost only, far below
//            elsewhere so it never lights anything), the water line the
//            shore darkens toward, and a spare
function biomeAttributes(wx, wz, out4a, out4b, ia) {
  const w = biomeWeightsAt(wx, wz)
  out4a[ia]     = w.emberfrost
  out4a[ia + 1] = w.thornvine
  out4a[ia + 2] = w.cloudmeadow
  out4a[ia + 3] = w.crystal
  out4b[ia]     = w.skyneedle
  out4b[ia + 1] = w.emberfrost > 0.005 ? lavaLevelAt(wx, wz) : -1000
  out4b[ia + 2] = waterLineAt(wx, wz)
  out4b[ia + 3] = 0
}

// the water surface the shore darkens toward: the river's own surface along
// its valley, the sea level everywhere else. Chosen over a wide band around
// the river, so where the two meet the switch happens on high ground that
// neither line reaches
function waterLineAt(wx, wz) {
  const off = Math.abs(wx - riverCenterX(wz))
  if (off < 160) {
    const p = riverProfileAt(wz)
    if (off < p.halfWidth + p.bank + 70 && riverStrength(wx, wz) > 0.05) {
      return Math.max(WATER_LEVEL, riverSurfaceY(wz))
    }
  }
  return WATER_LEVEL
}

/** What a ground vertex looks like, as the chunk mesh builds it. */
function groundVertex(wx, wz, slope) {
  const rd = roadDistance(wx, wz)
  const clr = clearingAt(wx, wz)
  const w = splatAt(wx, wz, slope, rd, clr)
  const tint = (Math.sin(wx * 0.21) * Math.cos(wz * 0.17) + 1) * 0.5
  const a = new Float32Array(4), b = new Float32Array(4)
  biomeAttributes(wx, wz, a, b, 0)
  return { splat: [w[0], w[1], w[2], tint], biome: a, biome2: b }
}

function createMaterial(scene) {
  const mat = new ShaderMaterial('terrainMat', scene, {
    vertexSource:   VERT,
    fragmentSource: FRAG,
  }, {
    attributes: ['position', 'normal', 'aSplat', 'aBiome', 'aBiome2'],
    uniforms:   ['worldViewProjection', 'world', 'sunDir', 'sunColor', 'ambientColor', 'uDist', 'uTime', ...FOG_UNIFORM_NAMES],
    samplers:   ['grassTex', 'grassTex2', 'grassTex3', 'rockTex', 'rockTex2', 'roadTex'],
  })

  const { grass, darkGrass1, darkGrass2, rockdirt, rockdirt2, road } = groundSplatMaps()
  const textures = { grass, darkGrass1, darkGrass2, rockdirt, rockdirt2, road }
  const missing = Object.entries(textures).filter(([, tex]) => !tex).map(([name]) => name)
  if (missing.length) {
    console.warn(`${LOG_PREFIX} missing texture(s) from groundSplatMaps():`, missing.join(', '))
  } else {
    log(`${LOG_PREFIX} textures loaded ok (grass, darkGrass1, darkGrass2, rockdirt, rockdirt2, road)`)
  }
  mat.setTexture('grassTex',  grass)
  mat.setTexture('grassTex2', darkGrass1)
  mat.setTexture('grassTex3', darkGrass2)
  mat.setTexture('rockTex',   rockdirt)
  mat.setTexture('rockTex2',  rockdirt2)
  mat.setTexture('roadTex',   road)

  // Starting values only - syncTerrainLighting() and the per-frame block in
  // createOpenWorld both overwrite these from the host scene's real lights and
  // fog. They stay here so a scene with no lights at all still renders
  // something reasonable rather than pitch black.
  const dir = new Vector3(0.4, 1, 0.3).normalize()
  mat.setVector3('sunDir',      dir)
  mat.setColor3('sunColor',     new Color3(1.00, 0.98, 0.88))
  mat.setColor3('ambientColor', new Color3(0.24, 0.35, 0.18))
  mat.setFloat('uDist', 0)
  mat.setFloat('uTime', 0)
  mat.setVector3('uCamPos',  Vector3.Zero())
  mat.setColor3('uFogColor', new Color3(0.65, 0.78, 0.88))
  mat.setFloat('uFogStart',  400)
  mat.setFloat('uFogEnd',    1400)
  mat.setFloat('uFogMode',    3)
  mat.setFloat('uFogDensity', 0.01)

  return mat
}

function buildChunk(scene, mat, ox, oz, verts) {
  const step  = CHUNK_SIZE / (verts - 1)
  const total = verts * verts
  const rdGrid  = bakeGrid(ox, oz, roadDistance)
  const clrGrid = bakeGrid(ox, oz, clearingAt)

  const hGrid = new Float32Array(total)
  // the WALKABLE surface, for normals and slope: the same as hGrid except at
  // a pit dug under a site's lid (sites.js), where it is the lid. Shading
  // the ground around a well off the pit itself would light the grass beside
  // it like a 60-unit cliff
  const sGrid = new Float32Array(total)
  for (let iz = 0; iz < verts; iz++)
    for (let ix = 0; ix < verts; ix++) {
      const wx = ox + ix * step, wz = oz + iz * step
      const h = terrainHeight(wx, wz)
      hGrid[iz * verts + ix] = h
      sGrid[iz * verts + ix] = lidHeightAt(wx, wz) ?? h
    }

  const positions = new Float32Array(total * 3)
  const normals   = new Float32Array(total * 3)
  const splats    = new Float32Array(total * 4)
  const biomes    = new Float32Array(total * 4)
  const biomes2   = new Float32Array(total * 4)
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
      const dx  = (sGrid[iz * verts + ixR] - sGrid[iz * verts + ixL]) / ((ixR - ixL) * step)
      const dz  = (sGrid[izU * verts + ix] - sGrid[izD * verts + ix]) / ((izU - izD) * step)
      const len = Math.sqrt(dx * dx + 1 + dz * dz)
      normals[ni++] = -dx / len
      normals[ni++] =   1 / len
      normals[ni++] = -dz / len

      const slope = Math.sqrt(dx * dx + dz * dz)
      const rd  = sampleBaked(rdGrid,  ox, oz, wx, wz)
      const clr = sampleBaked(clrGrid, ox, oz, wx, wz)
      const w   = splatAt(wx, wz, slope, rd, clr)
      const tint = (Math.sin(wx * 0.21) * Math.cos(wz * 0.17) + 1) * 0.5
      biomeAttributes(wx, wz, biomes, biomes2, si)
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
  mesh.setVerticesData('aBiome', biomes, false, 4)
  mesh.setVerticesData('aBiome2', biomes2, false, 4)
  mesh.material = mat
  return mesh
}

/**
 * A patch of ground drawn with the terrain's own material, for a site's lid
 * (sites.js): flat at `lid.H` over the rectangle, minus whatever `isOpen`
 * says is open (the well mouth).
 *
 * Its attributes are interpolated from the surrounding GRID vertices with the
 * chunk's own triangle split rather than evaluated at its own vertices, so
 * along its border it matches the chunk mesh it meets exactly - evaluating
 * them freshly would put a faint seam round every lid wherever the true
 * splat curves between two grid vertices.
 *
 *   extraLines  {x: [...], z: [...]} world coordinates to add as grid lines,
 *               so a rectangular opening gets exact straight edges
 */
export function buildGroundPatch(scene, mat, lid, isOpen, verts, res = 1, extraLines = {}) {
  const step = CHUNK_SIZE / (verts - 1)
  const lines = (a0, a1, extra = []) => {
    const out = []
    const n = Math.max(1, Math.round((a1 - a0) / res))
    for (let i = 0; i <= n; i++) out.push(a0 + (a1 - a0) * i / n)
    for (const e of extra) if (e > a0 && e < a1) out.push(e)
    return [...new Set(out.map(v => +v.toFixed(5)))].sort((a, b) => a - b)
  }
  const xs = lines(lid.x0, lid.x1, extraLines.x)
  const zs = lines(lid.z0, lid.z1, extraLines.z)

  // grid-vertex attributes, cached for the cells this patch spans
  const gridCache = new Map()
  const gridVertex = (gx, gz) => {
    const key = gx + ',' + gz
    let v = gridCache.get(key)
    if (!v) {
      const wx = gx * step, wz = gz * step
      const hC = lidHeightAt(wx, wz) ?? terrainHeight(wx, wz)
      const hX = lidHeightAt(wx + step, wz) ?? terrainHeight(wx + step, wz)
      const hZ = lidHeightAt(wx, wz + step) ?? terrainHeight(wx, wz + step)
      const slope = Math.hypot((hX - hC) / step, (hZ - hC) / step)
      v = groundVertex(wx, wz, slope)
      gridCache.set(key, v)
    }
    return v
  }
  // the chunk splits each cell along its (x+1, z) - (x, z+1) diagonal
  const attrInto = (x, z, i, splats, biomes, biomes2) => {
    const gx = Math.floor(x / step + 1e-9), gz = Math.floor(z / step + 1e-9)
    const fx = x / step - gx, fz = z / step - gz
    let A, B, C, wa, wb, wc
    if (fx + fz <= 1) {
      A = gridVertex(gx, gz); B = gridVertex(gx + 1, gz); C = gridVertex(gx, gz + 1)
      wa = 1 - fx - fz; wb = fx; wc = fz
    } else {
      A = gridVertex(gx + 1, gz + 1); B = gridVertex(gx, gz + 1); C = gridVertex(gx + 1, gz)
      wa = fx + fz - 1; wb = 1 - fx; wc = 1 - fz
    }
    for (let k = 0; k < 4; k++) {
      splats[i + k] = A.splat[k] * wa + B.splat[k] * wb + C.splat[k] * wc
      biomes[i + k] = A.biome[k] * wa + B.biome[k] * wb + C.biome[k] * wc
      biomes2[i + k] = A.biome2[k] * wa + B.biome2[k] * wb + C.biome2[k] * wc
    }
  }

  const nx = xs.length, nz = zs.length
  const positions = new Float32Array(nx * nz * 3)
  const normals = new Float32Array(nx * nz * 3)
  const splats = new Float32Array(nx * nz * 4)
  const biomes = new Float32Array(nx * nz * 4)
  const biomes2 = new Float32Array(nx * nz * 4)
  for (let iz = 0; iz < nz; iz++)
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix
      const x = xs[ix], z = zs[iz]
      positions[i * 3] = x; positions[i * 3 + 1] = lid.H; positions[i * 3 + 2] = z
      normals[i * 3 + 1] = 1
      attrInto(x, z, i * 4, splats, biomes, biomes2)
    }
  const indices = []
  for (let iz = 0; iz < nz - 1; iz++)
    for (let ix = 0; ix < nx - 1; ix++) {
      const cx = (xs[ix] + xs[ix + 1]) / 2, cz = (zs[iz] + zs[iz + 1]) / 2
      if (isOpen(cx, cz)) continue
      const i = iz * nx + ix
      indices.push(i, i + 1, i + nx, i + 1, i + nx + 1, i + nx)
    }
  const vd = new VertexData()
  vd.positions = positions
  vd.normals = normals
  vd.indices = indices
  const mesh = new Mesh('groundLid', scene)
  vd.applyToMesh(mesh)
  mesh.setVerticesData('aSplat', splats, false, 4)
  mesh.setVerticesData('aBiome', biomes, false, 4)
  mesh.setVerticesData('aBiome2', biomes2, false, 4)
  mesh.material = mat
  mesh.isPickable = false
  return mesh
}

// The rendered chunk mesh only samples terrainHeight() at its (sparse, verts x
// verts) grid vertices and flat-shades the triangles between them — it does
// NOT follow the full analytic curve. Anything placed with the raw
// terrainHeight(x, z) value (e.g. trees) can end up floating above, or
// sunk below, that flat-interpolated surface whenever the true curve bulges
// away from the straight line connecting the grid points — most visible on
// rolling hills with a low `verts` count. This reproduces the same grid +
// bilinear interpolation the mesh uses, so anything sampling through here
// sits flush with what's actually drawn.
export function sampleTerrainSurfaceHeight(x, z, verts) {
  // exactly the ground that is drawn AND that the host's physics heightfield
  // is built from: the chunk's own triangles (ground.js - lid-aware, so over
  // a well's lid it is the lid, not the pit under it). It used to
  // blend the cell's four corners bilinearly instead, which on rough ground
  // is metres off the flat triangles everyone actually stands on - up to 4.6
  // in the biomes - and anything a host put at that height (enemies, bots,
  // buildings) sank into the ground or floated over it
  return drawnHeight(x, z, CHUNK_SIZE / (verts - 1))
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
  log(`${LOG_PREFIX} init: viewRadius=${VIEW_R} unloadRadius=${UNLOAD_R} verts=${verts} chunkSize=${CHUNK_SIZE}`)

  // the river sizes its narrow variants against the real grid spacing, so a
  // channel can never end up finer than the mesh is able to draw - see
  // river.js's own note on RIVER_VARIANTS for the measurement that prompted it
  setTerrainStep(CHUNK_SIZE / (verts - 1))
  // and the sites (sites.js) snap their pits to the same grid
  setSiteGridStep(CHUNK_SIZE / (verts - 1))

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

  let prevCX = null, prevCZ = null, time = 0
  scene.onBeforeRenderObservable.add(() => {
    time += scene.getEngine().getDeltaTime() * 0.001
    mat.setFloat('uTime', time)
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
          log(`${LOG_PREFIX} first chunk built ok (${key}) — terrain generation is working`)
        } else if (builtCount % 25 === 0) {
          log(`${LOG_PREFIX} ${builtCount} chunks built, ${chunks.size} currently loaded`)
        }
        onChunkBuilt?.(mesh)
      }
    }
    const dist = Math.hypot(cam.position.x - SPAWN_X, cam.position.z - SPAWN_Z)
    mat.setFloat('uDist', dist)
    // fog.js pushes uCamPos along with the fog state, shared with grass.js
    syncFogUniforms(mat, scene, cam.position)
    // lights re-read every frame rather than once at creation, so weather, a
    // day/night cycle, or any runtime light change reaches the ground instead
    // of stopping at everything else in the scene
    syncTerrainLighting(mat, scene)
    const cx = Math.floor(cam.position.x / CHUNK_SIZE)
    const cz = Math.floor(cam.position.z / CHUNK_SIZE)
    if (cx !== prevCX || cz !== prevCZ) {
      prevCX = cx; prevCZ = cz
      update(cam.position.x, cam.position.z)
    }
  })

  return { chunks, mat }
}
