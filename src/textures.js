import { registerPreload } from './preload'
import { loadTexture } from './loader'

let _grass      = null
let _darkGrass1 = null
let _darkGrass2 = null
let _rockdirt   = null
let _rockdirt2  = null
let _road       = null

registerPreload(scene => {
  _grass      = loadTexture(scene, '/textures/grass.jpg')
  _darkGrass1 = loadTexture(scene, '/textures/first_dark_grass.jpg')
  _darkGrass2 = loadTexture(scene, '/textures/second_dark_grass.jpg')
  _rockdirt   = loadTexture(scene, '/textures/rockdirt.jpg')
  _rockdirt2  = loadTexture(scene, '/textures/rockdirt2.jpg')
  _road       = loadTexture(scene, '/textures/road.jpg')
})

export function groundSplatMaps() {
  return { grass: _grass, darkGrass1: _darkGrass1, darkGrass2: _darkGrass2, rockdirt: _rockdirt, rockdirt2: _rockdirt2, road: _road }
}
