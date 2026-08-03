import * as THREE from 'three';
import { makeCharMaterial, strandAlpha } from '../rig/CharMaterial.js';

/**
 * RED SANDS — HORSE COAT MATERIAL
 * ============================================================================
 * The shared character shader already does the multi-scale surface honesty
 * §5 asks for, plus dapple, sweat and a short-hair rim. The one thing it
 * cannot do is know which way the hair LIES: its coat grain is a fixed
 * object-space stretch along z, which is roughly right down the barrel and
 * plainly wrong on the neck, the haunch and every leg.
 *
 * This wraps that material and adds one thing: a per-vertex hair direction
 * (`aFlow`, baked by HorseBody) that the fragment shader uses to build a noise
 * field which is fine ACROSS the lay of the coat and slow ALONG it. That is
 * the whole visual definition of hair direction, and at 1:1 it is the
 * difference between a horse and a painted cylinder. It costs two extra value
 * noise samples on an object that covers a few per cent of the frame.
 *
 * The injection is chained onto the base material's own onBeforeCompile and
 * every replace is guarded, so if the shared shader is restructured by
 * whoever owns it the horse silently falls back to the stock coat instead of
 * failing to compile.
 * ============================================================================
 */

const VERT_COMMON = /* glsl */`
attribute vec3 aFlow;
varying vec3 vHFlow;
`;

const FRAG_COMMON = /* glsl */`
varying vec3 vHFlow;
uniform float uCoatGrain;
`;

/**
 * Runs immediately before <lights_physical_fragment>, so roughnessFactor and
 * diffuseColor are both final-but-unconsumed at this point.
 */
const FRAG_GRAIN = /* glsl */`
{
  // 1.0 on short animal hair (class 2) and strand cards (class 3), 0 elsewhere
  float rsCoat = clamp(vCharMat.w - 1.5, 0.0, 1.0);
  float fl = length(vHFlow);
  if (rsCoat > 0.0 && fl > 0.001) {
    vec3 F = vHFlow / fl;
    float along = dot(vCharObj, F);
    vec3 perp = vCharObj - F * along;
    // ~4 mm across the lay, ~4 cm along it: streaks, not blotches
    float g1 = rsVNoise(perp * 250.0 + F * along * 24.0) - 0.5;
    float g2 = rsVNoise(perp *  72.0 + F * along *  8.0) - 0.5;
    float grain = (g1 * 0.62 + g2 * 0.38) * RS_BAND(250.0) * uCharDetail * uCoatGrain;
    roughnessFactor = clamp(roughnessFactor + grain * 0.26, 0.05, 1.0);
    // Roughness carries most of this: it is what produces the directional
    // sheen down a coat. The ALBEDO share is deliberately small — at 0.095 it
    // read as blemishes on the flat planes of the face at 1:1.
    diffuseColor.rgb *= 1.0 + grain * 0.050;
  }
}
`;

function chain(mat, tag) {
  const base = mat.onBeforeCompile;
  const uniforms = { uCoatGrain: { value: 1.0 } };
  mat.userData.rsCoatUniforms = uniforms;
  mat.onBeforeCompile = (shader, renderer) => {
    if (base) base(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    const vOK = shader.vertexShader.includes('#include <common>')
      && shader.vertexShader.includes('#include <begin_vertex>');
    const fOK = shader.fragmentShader.includes('#include <common>')
      && shader.fragmentShader.includes('#include <lights_physical_fragment>')
      && shader.fragmentShader.includes('RS_BAND');
    if (!vOK || !fOK) return;             // shared shader moved on: stay stock
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>' + VERT_COMMON)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHFlow = aFlow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>' + FRAG_COMMON)
      .replace('#include <lights_physical_fragment>',
        FRAG_GRAIN + '\n#include <lights_physical_fragment>');
  };
  // MUST differ from the rider's key or three hands us their compiled program.
  mat.customProgramCacheKey = () => 'rsHorseCoat' + tag;
  return mat;
}

/**
 * @param {object} ctx
 * @param {function} rand deterministic rng
 * @returns {{solid:Material, cloth:Material, hair:Material, all:Material[]}}
 */
export function makeHorseMaterials(ctx, rand) {
  const solid = chain(makeCharMaterial({ name: 'horseSolid', dust: 0.30 }), 'S');
  const cloth = chain(makeCharMaterial({ name: 'horseCloth', dust: 0.22, doubleSide: true }), 'C');
  const hair = chain(makeCharMaterial({
    name: 'horseHair', dust: 0.14, doubleSide: true,
    alphaMap: strandAlpha(rand), alphaTest: 0.34, ao: 0.7,
  }), 'H');

  /*
   * The strand cards are the only alpha-tested geometry on the animal, and
   * rsCheapShadow is read off the MATERIAL by CascadedShadowMaps — see the
   * note this replaces in Horse.js. Keep it on both.
   */
  hair.userData.rsCheapShadow = true;

  const sky = ctx.get('sky');
  if (sky && sky.injectAerialPerspective) {
    for (const m of [solid, cloth, hair]) sky.injectAerialPerspective(m);
  }
  return { solid, cloth, hair, all: [solid, cloth, hair] };
}

/** Per-frame coat state: sweat, rain wetness, and the detail-band LOD. */
export function updateCoat(mats, { sweat, wet, detail }) {
  for (const m of mats) {
    if (!m) continue;
    const u = m.userData.rsCharUniforms;
    if (u) {
      u.uCharSweat.value = sweat;
      u.uCharWet.value = wet;
      u.uCharDetail.value = detail;
    }
    const c = m.userData.rsCoatUniforms;
    // The directional grain is a 4 mm feature; past ~20 m it is below a pixel
    // and all it can do is alias, so it fades out with the rest of the detail.
    if (c) c.uCoatGrain.value = THREE.MathUtils.clamp(detail * 1.15, 0, 1);
  }
}
