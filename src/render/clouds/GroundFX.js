import * as THREE from 'three';

/**
 * ============================================================================
 *  GROUND FX — what the sky does to the ground.
 * ============================================================================
 *
 * Two effects that both belong to the weather/cloud layer but have to be
 * evaluated inside every *lit* material in the world, so they ship as one
 * shader patch:
 *
 *  1. CLOUD SHADOWS. Clouds renders a top-down transmittance map (see
 *     SHADOW_FRAG) by marching the sun ray through the same density field the
 *     camera raymarch uses. Here we project it back onto world XZ and modulate
 *     the direct light with it. Moving cloud shadow across a landscape is the
 *     cheapest, strongest realism cue available, and high noon is dead flat
 *     without it.
 *
 *  2. WET SURFACES. There is no environment probe in this renderer, so simply
 *     lowering roughness makes wet ground *darker*, never shinier. Real wet
 *     ground is a near-mirror at grazing angles: it is the reflected SKY, plus
 *     a tight specular lobe from the sun, that reads as "wet". We add both
 *     analytically — a Fresnel-weighted two-band sky gradient plus a GGX-ish
 *     sun glint — scaled by env.wetness / env.puddleLevel and by how up-facing
 *     the surface is.
 *
 * Usage (Clouds does this on 'ready'):
 *     terrain.registerMaterialUser((m) => injectGroundFX(m, uniforms));
 *     lighting.registerMaterialUser((m) => injectGroundFX(m, uniforms));
 *
 * Uniform objects are shared by reference; Clouds mutates `.value` per frame.
 */

export function createGroundFXUniforms() {
  return {
    /** Top-down cloud transmittance, R channel. */
    rsCloudShadowMap: { value: null },
    /** xy = centre XZ, z = half extent (m), w = unused. */
    rsCloudShadowArea: { value: new THREE.Vector4(0, 0, 3600, 0) },
    /** x = shadow strength 0..1, y = softness blur in texels. */
    rsCloudShadowParams: { value: new THREE.Vector2(0, 1) },

    /** x = wetness, y = puddleLevel, z = snowCover, w = specular gain. */
    rsWetParams: { value: new THREE.Vector4(0, 0, 0, 0.55) },
    /** Linear HDR sky radiance near the zenith / near the horizon. */
    rsWetSkyHi: { value: new THREE.Color(0.2, 0.3, 0.5) },
    rsWetSkyLo: { value: new THREE.Color(0.4, 0.44, 0.5) },
    /** Direction to the key light + its linear radiance. */
    rsWetSunDir: { value: new THREE.Vector3(0, 1, 0) },
    rsWetSunCol: { value: new THREE.Color(0, 0, 0) },
  };
}

const VERT_HEAD = /* glsl */`
varying vec3 vRsGfxWP;
`;

const VERT_BODY = /* glsl */`
{
  vec4 rsGfxP = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    rsGfxP = instanceMatrix * rsGfxP;
  #endif
  #ifdef USE_BATCHING
    rsGfxP = batchingMatrix * rsGfxP;
  #endif
  vRsGfxWP = (modelMatrix * rsGfxP).xyz;
}
`;

const FRAG_HEAD = /* glsl */`
varying vec3 vRsGfxWP;
uniform sampler2D rsCloudShadowMap;
uniform vec4  rsCloudShadowArea;
uniform vec2  rsCloudShadowParams;
uniform vec4  rsWetParams;
uniform vec3  rsWetSkyHi;
uniform vec3  rsWetSkyLo;
uniform vec3  rsWetSunDir;
uniform vec3  rsWetSunCol;

/** Direct-light transmittance through the cloud deck at a world position. */
float rsCloudShadow(vec3 wp) {
  if (rsCloudShadowParams.x < 0.001) return 1.0;
  vec2 uv = (wp.xz - rsCloudShadowArea.xy) / (2.0 * rsCloudShadowArea.z) + 0.5;
  // outside the map the sky is whatever the map edge said; clamping is fine
  // because the map always covers well past the shadow-casting distance
  vec2 c = clamp(uv, 0.002, 0.998);
  float t = rsCloudShadowParams.y;
  // 4-tap rotated cross: the map is deliberately low-res and this is what
  // turns its texels into a soft penumbra instead of a staircase
  float s = texture2D(rsCloudShadowMap, c).r * 0.36;
  s += texture2D(rsCloudShadowMap, c + vec2( t,  t)).r * 0.16;
  s += texture2D(rsCloudShadowMap, c + vec2(-t,  t)).r * 0.16;
  s += texture2D(rsCloudShadowMap, c + vec2( t, -t)).r * 0.16;
  s += texture2D(rsCloudShadowMap, c + vec2(-t, -t)).r * 0.16;
  return mix(1.0, s, rsCloudShadowParams.x);
}
`;

const FRAG_BODY = /* glsl */`
{
  float rsCs = rsCloudShadow(vRsGfxWP);
  reflectedLight.directDiffuse  *= rsCs;
  reflectedLight.directSpecular *= rsCs;

  float rsWet = rsWetParams.x;
  float rsPud = rsWetParams.y;
  if (rsWet > 0.003) {
    // view-space normal back to world space (viewMatrix is orthonormal)
    vec3 rsN = normalize((vec4(geometryNormal, 0.0) * viewMatrix).xyz);
    vec3 rsV = normalize(cameraPosition - vRsGfxWP);
    float rsNdV = clamp(dot(rsN, rsV), 0.0, 1.0);
    // water films sit on up-facing ground; vertical faces shed it
    float rsUp = smoothstep(0.30, 0.80, rsN.y);
    /* A water FILM is only a mirror where the surface under it is smooth. Wet
       gravel stays matte and just goes dark; a puddle goes glassy. Weighting
       by the material's own smoothness is what keeps the sheen in the puddles
       instead of turning every wet hillside into a sheet of chrome. */
    float rsGloss = 1.0 - material.roughness;
    rsGloss *= rsGloss * rsGloss;
    float rsFilm = clamp(rsWet * 0.35 + rsPud * 0.85, 0.0, 1.1) * rsUp * rsGloss;
    if (rsFilm > 0.0015) {
      // Schlick against water's F0
      float rsF = 0.022 + 0.978 * pow(1.0 - rsNdV, 5.0);
      vec3 rsR = reflect(-rsV, rsN);
      vec3 rsSky = mix(rsWetSkyLo, rsWetSkyHi, smoothstep(-0.02, 0.55, rsR.y));
      rsSky = min(rsSky, vec3(6.0));
      reflectedLight.indirectSpecular += rsSky * rsF * rsFilm * rsWetParams.w * rsCs;

      // tight sun/moon glint — this is the highlight that says "rain"
      float rsSpec = pow(max(dot(rsR, rsWetSunDir), 0.0), mix(140.0, 1800.0, clamp(rsPud, 0.0, 1.0)));
      reflectedLight.directSpecular +=
        rsWetSunCol * rsSpec * rsF * rsFilm * 3.0 * rsCs;
    }
  }
}
`;

/**
 * Patch a built-in three.js material. Idempotent, chains onto any existing
 * onBeforeCompile, and silently no-ops on materials that are not lit.
 */
export function injectGroundFX(material, uniforms) {
  if (!material || material.userData.rsGroundFX || material.userData.rsNoGroundFX) return material;
  if (material.isMeshDepthMaterial || material.isMeshDistanceMaterial) return material;
  material.userData.rsGroundFX = true;

  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (typeof prev === 'function') prev.call(this, shader, renderer);
    if (shader.fragmentShader.indexOf('#include <lights_fragment_end>') === -1) return;

    for (const k in uniforms) shader.uniforms[k] = uniforms[k];

    if (shader.vertexShader.indexOf('vRsGfxWP') === -1) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
        .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_BODY);
    }
    if (shader.fragmentShader.indexOf('rsCloudShadow') === -1) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
        .replace('#include <lights_fragment_end>',
          '#include <lights_fragment_end>\n' + FRAG_BODY);
    }
  };
  /* Materials that pin their own program cache key (terrain does) would
     otherwise be handed back a program compiled before this patch existed. */
  const prevKey = material.customProgramCacheKey;
  if (typeof prevKey === 'function') {
    material.customProgramCacheKey = function () { return prevKey.call(this) + '|rsgfx1'; };
  }
  material.needsUpdate = true;
  return material;
}
