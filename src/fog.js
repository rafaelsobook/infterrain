// Shared fog for this package's custom ShaderMaterials.
//
// Babylon applies scene fog automatically inside its OWN material shaders, so
// anything using StandardMaterial/PBRMaterial fogs for free - that is why
// forest.js's billboard trees already fade correctly. A ShaderMaterial gets
// none of that: whatever it does not implement itself simply does not happen.
//
// terrain.js implemented its own fog and grass.js implemented none at all,
// which showed up in game as fogged trees and terrain surrounding grass that
// stayed at full brightness, looking like it was lit by a different scene.
// Both now share the GLSL and the uniform push below so they cannot drift
// apart again.
//
// NOTE ON GLSL COMMENTS: no comment in these strings may contain a semicolon.
// Babylon's shader preprocessor splits source on ";", so a comment holding one
// gets cut in half and its remainder is emitted as a bare line, which fails to
// compile. A failed shader compile logs but does not throw, so the only symptom
// is geometry silently not drawing.

// Pass these to ShaderMaterial's `uniforms` option, concatenated with whatever
// else the material needs.
export const FOG_UNIFORM_NAMES = ['uCamPos', 'uFogColor', 'uFogStart', 'uFogEnd', 'uFogMode', 'uFogDensity']

// Uniform declarations - paste into a fragment shader's declaration block.
export const FOG_UNIFORMS_GLSL = /* glsl */`
  uniform vec3  uCamPos;
  uniform vec3  uFogColor;
  uniform float uFogStart;
  uniform float uFogEnd;
  uniform float uFogMode;
  uniform float uFogDensity;
`

// fogFactor(worldPos) -> 0 clear, 1 fully fogged.
// uFogMode mirrors Babylon's Scene.FOGMODE_* constants, so the host scene's own
// scene.fogMode drives this and a material here fades on the same curve as
// every ordinary Babylon material beside it.
//   1 EXP, 2 EXP2, 3 LINEAR, anything else disables fog
// Distance is true 3D, not horizontal-only - terrain far below the camera (a
// valley seen from a ridge) must not fog as though it were underfoot.
export const FOG_FACTOR_GLSL = /* glsl */`
  float fogFactor(vec3 worldPos) {
    float fogDist = length(worldPos - uCamPos);
    if (uFogMode == 1.0) {
      return 1.0 - clamp(exp(-fogDist * uFogDensity), 0.0, 1.0);
    } else if (uFogMode == 2.0) {
      float d = fogDist * uFogDensity;
      return 1.0 - clamp(exp(-d * d), 0.0, 1.0);
    } else if (uFogMode == 3.0) {
      return clamp((fogDist - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
    }
    return 0.0;
  }
`

/**
 * Push the scene's current fog state into a material. Call every frame - fog
 * is not static once a host drives it from weather or a day/night cycle.
 */
export function syncFogUniforms(mat, scene, camPos) {
  if (camPos) mat.setVector3('uCamPos', camPos)
  mat.setColor3('uFogColor', scene.fogColor)
  // ?? rather than bare reads: a host using EXP fog never touches
  // fogStart/fogEnd, and vice versa, so whichever pair it ignores must still
  // arrive as a real number or the uniform is left undefined
  mat.setFloat('uFogStart',   scene.fogStart ?? 0)
  mat.setFloat('uFogEnd',     scene.fogEnd ?? 1000)
  mat.setFloat('uFogMode',    scene.fogMode ?? 0)
  mat.setFloat('uFogDensity', scene.fogDensity ?? 0)
}
