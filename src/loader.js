import { Texture } from '@babylonjs/core'

export function loadTexture(scene, path) {
  const tex = new Texture(path, scene)
  tex.wrapU = Texture.WRAP_ADDRESSMODE
  tex.wrapV = Texture.WRAP_ADDRESSMODE
  return tex
}
