import * as THREE from 'three';
import { vnoise, vfbm, worley, clamp01 } from './Noise.js';

/**
 * Detail.js — the near-field detail layer and the anti-tiling sampler.
 *
 * Two problems the forensics named that a 1k base texture cannot solve on its
 * own:
 *
 *  • "Texel density for a 3-5 m object is on the order of a distant LOD."
 *    A single tiling set can only carry so many texels per metre. The fix every
 *    shipped title uses is a shared DETAIL map tiled an order of magnitude
 *    finer and faded in with distance, so a close-up gains genuine
 *    high-frequency information instead of a magnified base texture.
 *
 *  • "town_street now ships a measurable 65px-period repeat on its principal
 *    wall plus a repeating street tile." Inside a tiling texture, periodicity is
 *    unavoidable by construction. `HEX_TILE_GLSL` is the standard
 *    triangle-lattice stochastic sampler: three rotated/offset taps blended by
 *    barycentric weight, which removes the repeat outright at the cost of three
 *    fetches. Consumers that can afford it should use it on hero surfaces.
 *
 * Both are exposed through ProcTextures so any system can opt in:
 *   ctx.get('procTextures').injectDetail(material, { scale: 14, strength: 0.8 })
 */

/* ------------------------------------------------------------ detail map */

/**
 * One shared detail texture for the whole game: RG = tangent normal xy,
 * B = achromatic grain, A = a cavity/pore mask. 512px, ~1 MB, generated once.
 */
export function makeDetailTexture(size = 512, aniso = 8) {
  const S = size;
  const h = new Float32Array(S * S);
  const inv = 1 / S;
  for (let y = 0; y < S; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) * inv;
      /* grit + pores + a faint fibre direction, all band-limited to 3 texels */
      const g = vfbm(u, v, { octaves: 3, freq: Math.round(S / 12), gain: 0.62, seed: 4201 });
      const w = worley(u, v, Math.round(S / 14), 4211);
      const pore = 1 - Math.min(1, w.f1 * 1.4);
      h[y * S + x] = clamp01(g * 0.72 - pore * 0.30 + 0.20);
    }
  }
  const data = new Uint8Array(S * S * 4);
  const k = 2.4;
  for (let y = 0; y < S; y++) {
    const ym = ((y - 1 + S) % S) * S, yp = ((y + 1) % S) * S, y0 = y * S;
    for (let x = 0; x < S; x++) {
      const xm = (x - 1 + S) % S, xp = (x + 1) % S;
      const dx = (h[y0 + xp] - h[y0 + xm]) * k;
      const dy = (h[yp + x] - h[ym + x]) * k;
      const l = Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y0 + x) * 4;
      data[i] = (-dx / l * 0.5 + 0.5) * 255;
      data[i + 1] = (-dy / l * 0.5 + 0.5) * 255;
      data[i + 2] = h[y0 + x] * 255;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/* -------------------------------------------------------------- injection */

const PARS = /* glsl */`
uniform sampler2D uRsDetail;
uniform vec4 uRsDetailP;   // x scale, y normal strength, z albedo contrast, w fade end
varying vec3 vRsDetailW;
varying vec2 vRsDetailUv;
`;

const VERT_PARS = /* glsl */`
varying vec3 vRsDetailW;
varying vec2 vRsDetailUv;
`;
const VERT_BODY = /* glsl */`
{
  vec4 rsdW = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    rsdW = instanceMatrix * rsdW;
  #endif
  vRsDetailW = ( modelMatrix * rsdW ).xyz;
  vRsDetailUv = uv;
}
`;

/** Blended into the shading normal in the base map's tangent frame. */
const NORMAL_BODY = /* glsl */`
#ifdef USE_NORMALMAP_TANGENTSPACE
{
  float rsdD = length( vRsDetailW - cameraPosition );
  float rsdF = 1.0 - smoothstep( uRsDetailP.w * 0.35, uRsDetailP.w, rsdD );
  if ( rsdF > 0.002 ) {
    vec2 dn = texture2D( uRsDetail, vRsDetailUv * uRsDetailP.x ).xy * 2.0 - 1.0;
    dn *= uRsDetailP.y * rsdF;
    normal = normalize( normal + tbn[ 0 ] * dn.x + tbn[ 1 ] * dn.y );
  }
}
#endif
`;

const COLOR_BODY = /* glsl */`
{
  float rsdD = length( vRsDetailW - cameraPosition );
  float rsdF = 1.0 - smoothstep( uRsDetailP.w * 0.35, uRsDetailP.w, rsdD );
  if ( rsdF > 0.002 ) {
    float g = texture2D( uRsDetail, vRsDetailUv * uRsDetailP.x ).z;
    diffuseColor.rgb *= 1.0 + ( g - 0.5 ) * uRsDetailP.z * rsdF;
    roughnessFactor = clamp( roughnessFactor + ( g - 0.5 ) * 0.16 * rsdF, 0.04, 1.0 );
  }
}
`;

/**
 * Add the shared detail layer to any MeshStandardMaterial. Idempotent, chains
 * onto an existing onBeforeCompile.
 *
 * @param {THREE.Material} material
 * @param {THREE.Texture}  tex      the shared detail texture
 * @param {object} o  { scale = tiles per base UV, strength, contrast, fade }
 */
export function injectDetail(material, tex, o = {}) {
  if (!material || !tex || material.userData.rsDetail) return material;
  material.userData.rsDetail = true;
  const p = new THREE.Vector4(
    o.scale === undefined ? 12 : o.scale,
    o.strength === undefined ? 0.75 : o.strength,
    o.contrast === undefined ? 0.30 : o.contrast,
    o.fade === undefined ? 42 : o.fade);

  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (typeof prev === 'function') prev.call(this, shader, renderer);
    if (shader.fragmentShader.indexOf('uRsDetail') !== -1) return;
    shader.uniforms.uRsDetail = { value: tex };
    shader.uniforms.uRsDetailP = { value: p };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PARS)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + COLOR_BODY)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + NORMAL_BODY);
  };
  const key = material.customProgramCacheKey;
  material.customProgramCacheKey = function () {
    return 'rsDetail|' + (typeof key === 'function' ? key.call(this) : '');
  };
  material.needsUpdate = true;
  return material;
}

/**
 * Triangle-lattice ("hex") stochastic tiling. Drop this into a fragment shader
 * and call `rsHexSample( tex, uv )` instead of `texture2D( tex, uv )` to remove
 * periodic repetition outright. Three taps; use it on hero surfaces only.
 *
 * Terrain already implements its own variant; this is the shared version for
 * Town / Scatter / anything else that shows a large flat tiled plane.
 */
export const HEX_TILE_GLSL = /* glsl */`
vec2 rsHexHash( vec2 p ) {
  p = vec2( dot( p, vec2( 127.1, 311.7 ) ), dot( p, vec2( 269.5, 183.3 ) ) );
  return fract( sin( p ) * 43758.5453 );
}
void rsHexWeights( vec2 uv, out vec2 v0, out vec2 v1, out vec2 v2, out vec3 w ) {
  const mat2 S = mat2( 1.0, 0.0, 0.5773502692, 1.1547005384 );
  vec2 p = S * uv * 3.4641016151;
  vec2 i = floor( p ), f = fract( p );
  vec3 bw; vec2 ia, ib, ic;
  if ( f.x + f.y < 1.0 ) { bw = vec3( 1.0 - f.x - f.y, f.x, f.y ); ia = i; ib = i + vec2( 1.0, 0.0 ); ic = i + vec2( 0.0, 1.0 ); }
  else { bw = vec3( f.x + f.y - 1.0, 1.0 - f.y, 1.0 - f.x ); ia = i + vec2( 1.0, 1.0 ); ib = i + vec2( 0.0, 1.0 ); ic = i + vec2( 1.0, 0.0 ); }
  v0 = uv + rsHexHash( ia ); v1 = uv + rsHexHash( ib ); v2 = uv + rsHexHash( ic );
  w = bw;
}
vec4 rsHexSample( sampler2D tex, vec2 uv ) {
  vec2 a, b, c; vec3 w;
  rsHexWeights( uv, a, b, c, w );
  vec2 dx = dFdx( uv ), dy = dFdy( uv );
  vec4 ca = textureGrad( tex, a, dx, dy );
  vec4 cb = textureGrad( tex, b, dx, dy );
  vec4 cc = textureGrad( tex, c, dx, dy );
  /* variance-preserving blend: plain lerp would wash the contrast out */
  vec4 m = ca * w.x + cb * w.y + cc * w.z;
  vec4 mean = ( ca + cb + cc ) / 3.0;
  float g = inversesqrt( dot( w, w ) );
  return mean + ( m - mean ) * g;
}
`;
