import * as THREE from 'three';
import { ATMO_GLSL_CONSTANTS, ATMO_GLSL_COMMON } from './Atmosphere.js';
import { LUT_SIZES } from './SkyLuts.js';

/**
 * RED SANDS — AERIAL PERSPECTIVE
 * ============================================================================
 * The single most important shared piece of this project. Any geometry that
 * can be more than ~80 m from the camera MUST run this or the world reads as a
 * toy: distant ridges have to stack as progressively lighter, bluer,
 * lower-contrast layers, and at sunset they have to go orange on the sun side
 * and blue-violet on the anti-solar side.
 *
 * HOW IT WORKS
 *   transmittance  T(d) = exp(-(beta_rayleigh * m_R + beta_mie * m_M
 *                              + beta_haze * m_H))
 *   where m_R / m_M / m_H are exact analytic air masses through three
 *   exponential layers along the slanted camera->fragment segment:
 *     - Rayleigh, H = 8 km, beta = (5.8, 13.6, 33.1)e-3 /km  (5.7x stronger
 *       in blue than in red — this is the whole chromatic depth cue)
 *     - Mie aerosol, H = 1.2 km, near-grey
 *     - a boundary-layer haze, H ~ 0.6 km, near-grey. Clear desert air has a
 *       ~55 km visual range at the ground and Rayleigh+Mie alone only account
 *       for ~180 km, so without this layer the far field is far too clean and
 *       every valley reads the same as every ridge. Its low scale height is
 *       what makes haze POOL in the low ground and thin out over the peaks,
 *       which is what stacks depth into discrete layers.
 *
 *   IN-SCATTER is the real single-scattering source function of the segment,
 *   NOT a sample of the sky-view LUT.
 *
 *     J(h, dir) = [ beta_R(h) p_R(theta) + beta_M(h) p_M(theta)
 *                 + beta_H(h) p_H(theta) ] * T_sun(h) * sunRadiance
 *               + [ beta_R + beta_M + beta_H ] * ( MS(h) * sunRadiance + night )
 *     L_in      = J / beta_ext * ( 1 - T )          (Koschmieder airlight)
 *
 *   PASS 1 (and the first half of pass 2) used `skyViewLut(dir) * (1 - T)`
 *   instead. That is the *asymptotic* airlight of an infinitely long path, and
 *   it is measurably the wrong colour for a 2-10 km one: the LUT value has been
 *   reddened by a hundred kilometres of extra extinction that a nearby ridge
 *   never sees. Measured on golden_hour_vista at 120 deg from the sun, the LUT
 *   horizon reads R:G:B = 1 : 0.58 : 0.28 while the true local source function
 *   is 1 : 1.05 : 0.36 — i.e. the old path was pushing distant terrain a full
 *   half-octave warmer than physics allows. That is the measured "B minus R is
 *   negative on distant terrain in six of seven daylight shots".
 *
 *   Evaluated in two halves (near/far) so a segment that climbs 500 m up a
 *   mesa still samples the source at a sensible altitude. Four texture fetches.
 *
 *   The in-scatter term is a distance-proportional PEDESTAL. It is the thing
 *   that lifts far-field blacks and compresses distant contrast toward the sky
 *   value; without it, distant ridges keep their full local contrast and the
 *   frame has no depth ordering at all.
 *
 * ---------------------------------------------------------------------------
 * INJECTION RECIPE — pick ONE of these three.
 *
 * (A) Built-in three.js materials (MeshStandard/Physical/Lambert/Phong/Basic).
 *     One line, handles instancing and skinning:
 *
 *         const sky = ctx.get('sky');
 *         sky.injectAerialPerspective(myMaterial);
 *
 *     Safe to call more than once (idempotent), safe to call before Sky.init(),
 *     and it chains onto any onBeforeCompile you already installed.
 *     Terrain: just call `T.registerMaterialUser(m => sky.injectAerialPerspective(m))`
 *     — Sky already registers itself with `terrain.registerMaterialUser` when
 *     that hook exists, so terrain materials are covered automatically.
 *
 * (B) Your own ShaderMaterial / RawShaderMaterial:
 *
 *         const sky = ctx.get('sky');
 *         material.uniforms = THREE.UniformsUtils.merge? ... no — do NOT clone:
 *         Object.assign(material.uniforms, sky.aerialUniforms);   // share refs!
 *         fragmentShader = sky.aerialGLSL + myFragmentShader;
 *         // then, as the LAST thing before you write gl_FragColor:
 *         colour = rsApplyAerialPerspective(colour, vWorldPosition);
 *
 *     `sky.aerialUniforms` holds live THREE.Uniform-style objects; Sky mutates
 *     `.value` in place every frame, so share the references, never clone them.
 *     You must supply a world-space position varying yourself.
 *
 * (C) Sky itself is not up yet (init order): both `sky.aerialGLSL` and
 *     `sky.aerialUniforms` exist from the constructor, so you may reference
 *     them from your own init() regardless of ordering.
 *
 * NOTES
 *   - Apply it AFTER lighting and AFTER any of your own fog. Do not also use
 *     THREE.Fog / FogExp2 on the same material; this replaces it.
 *   - Output stays linear HDR. PostFX still owns the tonemap.
 *   - Cost is 1 texture fetch + ~40 ALU. Negligible.
 *   - Opt a material out with `material.userData.rsNoAerial = true`.
 * ============================================================================
 */

export const AERIAL_GLSL = /* glsl */`
#ifndef RS_AERIAL_INCLUDED
#define RS_AERIAL_INCLUDED
#define RS_TLUT_W ${LUT_SIZES.TLUT_W}
#define RS_TLUT_H ${LUT_SIZES.TLUT_H}
#define RS_MLUT_W ${LUT_SIZES.MLUT_W}
#define RS_MLUT_H ${LUT_SIZES.MLUT_H}
${ATMO_GLSL_CONSTANTS}
${ATMO_GLSL_COMMON}

uniform sampler2D rsSkyViewLut;
/*
 * Transmittance and multiple-scattering share ONE texture (see SkyLuts: the
 * "aerial atlas"), stacked vertically. This chunk is injected into every lit
 * material in the world, so each sampler it spends is one the content systems
 * cannot have — and the terrain program was already one sampler over the
 * 16-unit limit, which made the driver reject its draw call entirely.
 */
uniform sampler2D rsAerialLut;

#define RS_ALUT_W float(RS_TLUT_W)
#define RS_ALUT_H float(RS_TLUT_H + RS_MLUT_H)

/** Map a transmittance-LUT uv into the packed atlas. */
vec2 rsAtlasTrans(vec2 uv) {
  return vec2(uv.x, uv.y * (float(RS_TLUT_H) / RS_ALUT_H));
}
/** Map a multiple-scattering-LUT uv into the packed atlas. */
vec2 rsAtlasMs(vec2 uv) {
  return vec2(uv.x * (float(RS_MLUT_W) / RS_ALUT_W),
              (float(RS_TLUT_H) + uv.y * float(RS_MLUT_H)) / RS_ALUT_H);
}
uniform vec3  rsCameraPos;      // world metres
uniform vec3  rsSunDir;
uniform vec3  rsSunRadiance;    // out-of-atmosphere solar radiance, engine units
uniform vec3  rsMoonDir;
uniform vec3  rsMoonRadiance;   // pre-scaled lunar radiance (0 when moon is down)
uniform vec3  rsNightRadiance;  // airglow / starlight floor, keeps night air alive
uniform float rsCamAltKm;
uniform float rsMieMul;
uniform float rsAerialStrength; // art-direction multiplier, 1.0 = physical
uniform float rsAerialFade;     // extra haze density from weather/lightning
uniform vec3  rsAerialAdd;      // flat additive (lightning flash bloom)
/**
 * Scales the in-scattered term only (never the transmittance). The sky-view LUT
 * is a CLEAR-AIR integral — it knows nothing about the cloud deck — so under an
 * overcast or storm sky it would veil the world in bright blue haze that flatly
 * contradicts the dark grey sky the viewer can see above it. Sky drives this
 * from env.cloudCover * env.cloudDensity, mirroring what Clouds does internally.
 */
uniform float rsAerialInscatter;
/** Boundary-layer haze: extinction at sea level (1/km) and its scale height. */
uniform vec3  rsHazeExt;
uniform float rsHazeH;
/**
 * VALLEY MIST — the layer that makes dawn read as dawn.
 *
 * Radiation fog is not "more haze". It is a LAKE: a body of saturated air that
 * fills the low ground to a fairly sharp ceiling and thins out fast above it,
 * so a ridge two hundred metres up stands completely clear of it while the
 * valley floor a kilometre away has vanished. Modelling it as another
 * exponential-from-sea-level layer (which is what pass 2 did — it just
 * thickened rsHazeExt) produces a uniform veil over the whole frame, which the
 * pass-2 review correctly called "worse than no mist at all", because the ONLY
 * thing that reads as mist is the contrast between filled valley and clear ridge.
 *
 *   rsMistExt   per-km extinction inside the layer (spectrally near-grey:
 *               fog droplets are >> lambda, so fog is white, not blue)
 *   rsMistLayer x = ceiling altitude, km ASL (Sky drives it from a low
 *                   percentile of the terrain around the camera)
 *               y = 1 / scale height above the ceiling, 1/km  (~1/0.045)
 *
 * Integrated analytically along the view ray, so a distant valley accumulates
 * kilometres of it and a near ridge accumulates none. That is the whole effect.
 */
uniform vec3  rsMistExt;
uniform vec2  rsMistLayer;
/** Floor on total transmittance: a silhouette must always survive the haze. */
uniform float rsAerialTMin;

/** Exact air mass through an exponential layer along a slanted segment. */
float rsAirMass(float h0, float h1, float lenKm, float scaleH) {
  float dh = h1 - h0;
  if (abs(dh) < 1e-4) return lenKm * exp(-max(h0, 0.0) / scaleH);
  return lenKm * scaleH / dh * (exp(-max(h0, 0.0) / scaleH) - exp(-max(h1, 0.0) / scaleH));
}

/**
 * Exact air mass through the mist LAKE: density 1 below rsMistLayer.x, then
 * exp(-(h - top) * rsMistLayer.y) above it. Closed form in both regions.
 */
float rsMistMass(float h0, float h1, float lenKm) {
  float top = rsMistLayer.x;
  float iH = rsMistLayer.y;
  float a = min(h0, h1);
  float b = max(h0, h1);
  float dh = b - a;
  if (dh < 1e-5) return lenKm * exp(-max(a - top, 0.0) * iH);
  float k = lenKm / dh;                       // path length per km of altitude
  float m = k * (min(b, top) - min(a, top));  // saturated part, below the ceiling
  float a2 = max(a, top), b2 = max(b, top);   // exponential tail above it
  if (b2 > a2) m += k * (exp(-(a2 - top) * iH) - exp(-(b2 - top) * iH)) / iH;
  return m;
}

/** Sky radiance looking along dir (unit, world space). */
vec3 rsSampleSkyRadiance(vec3 dir) {
  float r = RS_GROUND_R + max(rsCamAltKm, 0.0005);
  return texture2D(rsSkyViewLut, rsSkyViewDirToUv(dir, r)).rgb;
}

/**
 * Spectral optical depth of a slanted segment between two altitudes.
 * CLEAR AIR ONLY (Rayleigh + Mie + boundary-layer haze). The mist lake is kept
 * separate so the far-field asymptote can be weighted by the clear-air
 * transmittance alone — otherwise a valley full of fog drags every distant
 * surface to the colour of the horizon sky, which at dawn is orange.
 */
vec3 rsAerialTauSeg(float h0, float h1, float lenKm) {
  vec3 tau = RS_RAY_S * rsAirMass(h0, h1, lenKm, RS_RAY_H)
           + vec3(RS_MIE_E * rsMieMul) * rsAirMass(h0, h1, lenKm, RS_MIE_H)
           + rsHazeExt * rsAirMass(h0, h1, lenKm, rsHazeH);
  return tau * rsAerialStrength * (1.0 + rsAerialFade);
}

/** Optical depth of the valley mist over the same segment. */
vec3 rsMistTauSeg(float h0, float h1, float lenKm) {
  return rsMistExt * rsMistMass(h0, h1, lenKm);
}

/** Optical depth of the whole camera -> worldPos segment. */
vec3 rsAerialTau(vec3 worldPos, float distM) {
  float h0 = rsCamAltKm;
  float h1 = rsCamAltKm + (worldPos.y - rsCameraPos.y) * 0.001;
  float lenKm = distM * 0.001;
  return rsAerialTauSeg(h0, h1, lenKm) + rsMistTauSeg(h0, h1, lenKm);
}

/**
 * Local airlight: the equilibrium radiance the medium at altitude hKm radiates
 * back along -dir. This is the whole depth cue, so it is derived rather than
 * tinted: Rayleigh's 5.7:1 blue bias times the sun's own slant transmittance,
 * plus a Mie forward lobe that only fires within ~30 deg of the sun, plus the
 * multiple-scattering LUT (which is what keeps shadowed haze blue-grey rather
 * than black).
 */
vec3 rsAerialAirlightAt(float hKm, vec3 dir) {
  float a = max(hKm, 0.0);
  float dRay = exp(-a / RS_RAY_H);
  float dMie = exp(-a / RS_MIE_H);
  float dHaz = exp(-a / rsHazeH);
  float dMst = exp(-max(a - rsMistLayer.x, 0.0) * rsMistLayer.y);

  vec3  rayS = RS_RAY_S * dRay;
  float mieS = RS_MIE_S * rsMieMul * dMie;
  // Boundary-layer aerosol: nearly conservative scatterer, broad forward lobe.
  vec3  hazS = rsHazeExt * dHaz * 0.90;
  // Fog droplets are far larger than the wavelength: white, and almost purely
  // scattering. This is why a mist bank is the brightest thing in a dawn frame.
  vec3  mstS = rsMistExt * dMst * 0.97;
  vec3  ext  = rayS + vec3(RS_MIE_E * rsMieMul * dMie) + rsHazeExt * dHaz
             + rsMistExt * dMst;
  vec3  scat = rayS + vec3(mieS) + hazS + mstS;

  float r = RS_GROUND_R + a;
  vec3 L = vec3(0.0);

  // --- sun
  {
    float c  = dot(dir, rsSunDir);
    float pR = rsRayleighPhase(c);
    float pM = rsMiePhase(c, RS_MIE_G);
    float pH = rsMiePhase(c, 0.62);
    // Fog: a very strong forward lobe (this is the bright halo you walk toward)
    // but the bulk of a bank is multiply-scattered and near-isotropic.
    float pF = mix(0.0795775, rsMiePhase(c, 0.72), 0.45);
    // The transmittance LUT is parameterised on distance-to-top and therefore
    // still returns a finite value for a ray that would exit through the
    // planet. Without this test the medium keeps being lit by a sun that has
    // already set, and the whole world glows warm through twilight.
    float lit = rsPlanetShadow(vec3(0.0, r, 0.0), rsSunDir);
    vec3 Tsun = texture2D(rsAerialLut, rsAtlasTrans(rsTransmittanceUv(r, rsSunDir.y))).rgb * lit;
    vec3 ms   = texture2D(rsAerialLut, rsAtlasMs(rsMultiScatterUv(r, rsSunDir.y))).rgb;
    L += ((rayS * pR + vec3(mieS) * pM + hazS * pH + mstS * pF) * Tsun
          + scat * ms) * rsSunRadiance;
  }

  // --- moon: same integral at ~1/400000 the intensity, so night air scatters too
  if (rsMoonRadiance.b > 1e-6) {
    float c  = dot(dir, rsMoonDir);
    float pR = rsRayleighPhase(c);
    float pM = rsMiePhase(c, RS_MIE_G);
    float lm = rsPlanetShadow(vec3(0.0, r, 0.0), rsMoonDir);
    vec3 Tm  = texture2D(rsAerialLut, rsAtlasTrans(rsTransmittanceUv(r, rsMoonDir.y))).rgb * lm;
    L += (rayS * pR + vec3(mieS) * pM + (hazS + mstS) * pM) * Tm * rsMoonRadiance;
  }

  // --- airglow / integrated starlight floor
  L += scat * rsNightRadiance;

  return L / max(ext, vec3(1e-7));
}

/**
 * Veil colour (linear HDR) as seen from the camera at world position
 * worldPos. This is the function every other system calls.
 */
vec3 rsApplyAerialPerspective(vec3 colour, vec3 worldPos) {
  vec3 v = worldPos - rsCameraPos;
  float distM = length(v);
  if (distM < 1.0) return colour;
  vec3 dir = v / distM;

  float lenKm = distM * 0.001;
  float h0 = rsCamAltKm;
  float h2 = rsCamAltKm + (worldPos.y - rsCameraPos.y) * 0.001;
  float h1 = 0.5 * (h0 + h2);

  // Two halves: near half dominates the pedestal, far half carries the
  // altitude change up a mesa face. Exact analytic extinction in each.
  // Clear air and mist are integrated separately (see rsAerialTauSeg) so the
  // far-field asymptote below can be driven by the clear-air term alone.
  vec3 tauCn = rsAerialTauSeg(h0, h1, lenKm * 0.5);
  vec3 tauCf = rsAerialTauSeg(h1, h2, lenKm * 0.5);
  vec3 Tn = exp(-(tauCn + rsMistTauSeg(h0, h1, lenKm * 0.5)));
  vec3 Tf = exp(-(tauCf + rsMistTauSeg(h1, h2, lenKm * 0.5)));

  vec3 Ln = rsAerialAirlightAt(0.5 * (h0 + h1), dir);
  vec3 Lf = rsAerialAirlightAt(0.5 * (h1 + h2), dir);

  vec3 inscat = Ln * (vec3(1.0) - Tn) + Tn * Lf * (vec3(1.0) - Tf);
  vec3 T = Tn * Tf;

  /*
   * FAR-FIELD ASYMPTOTE.
   *
   * The local source function above is the right answer for the first few
   * kilometres, but as the path grows the sun that lights it gets lower and
   * more extinguished, and the true limit of the airlight is exactly the sky
   * radiance the dome draws on that horizon. Interpolating toward the sky-view
   * LUT by how much of the path has already been absorbed gives both: a
   * Rayleigh-blue near field AND a far field that matches the sky it stands
   * against, so a ridge never reads as a different colour from the air a pixel
   * above it. Below the horizon the LUT contains sunlit ground rather than air,
   * so clamp the lookup to the horizon in the same azimuth.
   */
  {
    /*
     * Sampled a few degrees ABOVE the true horizon on purpose. The LUT's
     * horizon texel is the limit of an infinite column — three hundred
     * kilometres of air whose far end is lit by a sun several degrees lower
     * than the one lighting the ridge in front of us, which is why it is so
     * much redder and brighter than any real 5 km path. Lifting the sample by
     * ~3 deg lands on the radiance a few tens of kilometres of air actually
     * has, and it is the difference between a distant ridge at dawn going
     * pale blue (correct) and going orange (pass 2, B-R -0.178).
     */
    vec3 hd = vec3(dir.x, max(dir.y, 0.0) + 0.055, dir.z);
    float hl = length(hd);
    vec3 farSky = rsSampleSkyRadiance(hl > 1e-4 ? hd / hl : vec3(0.0, 1.0, 0.0));
    /*
     * Weighted by the CLEAR-AIR extinction only. Fog is a local medium lit by
     * the whole sky dome; it has nothing to do with the radiance of a hundred
     * kilometres of air on the horizon, and letting a valley full of mist pull
     * every surface behind it toward the horizon LUT is exactly how pass 2 got
     * distant terrain going ORANGE at dawn instead of pale blue.
     */
    vec3 Tc = exp(-(tauCn + tauCf));
    float w = 1.0 - dot(Tc, vec3(0.3333));
    inscat = mix(inscat, farSky * (vec3(1.0) - T), w * w);
  }

  /*
   * SILHOUETTE FLOOR. However long the path, keep a few percent of the
   * surface's own radiance: a frame whose darkest pixel is mid-grey has no
   * depth left to read (pass 2 storm_plains, 0.1st-percentile luma 0.317).
   * Energy is kept honest by scaling the in-scatter by the same factor.
   */
  T = rsAerialTMin + (1.0 - rsAerialTMin) * T;
  inscat *= (1.0 - rsAerialTMin);

  inscat = inscat * rsAerialInscatter + rsAerialAdd;
  return colour * T + inscat;
}

/** Convenience: transmittance only (for alpha-blended or emissive surfaces). */
vec3 rsAerialTransmittance(vec3 worldPos) {
  vec3 v = worldPos - rsCameraPos;
  float distM = max(length(v), 1.0);
  return exp(-rsAerialTau(worldPos, distM));
}
#endif
`;

/** Fresh uniform block. Sky owns exactly one of these and shares the refs. */
export function createAerialUniforms() {
  return {
    rsSkyViewLut: { value: null },
    /** Packed transmittance + multiple-scattering atlas (see SkyLuts). */
    rsAerialLut: { value: null },
    rsCameraPos: { value: new THREE.Vector3() },
    rsSunDir: { value: new THREE.Vector3(0, 1, 0) },
    rsSunRadiance: { value: new THREE.Vector3(18, 18, 18) },
    rsMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    rsMoonRadiance: { value: new THREE.Vector3(0, 0, 0) },
    rsNightRadiance: { value: new THREE.Vector3(0, 0, 0) },
    rsCamAltKm: { value: 0.05 },
    rsMieMul: { value: 1.0 },
    rsAerialStrength: { value: 1.0 },
    rsAerialFade: { value: 0.0 },
    rsAerialAdd: { value: new THREE.Vector3(0, 0, 0) },
    rsAerialInscatter: { value: 1.0 },
    rsHazeExt: { value: new THREE.Vector3(0.045, 0.047, 0.050) },
    rsHazeH: { value: 0.6 },
    /** Valley-mist lake: per-km extinction inside the layer. */
    rsMistExt: { value: new THREE.Vector3(0, 0, 0) },
    /** x = ceiling altitude (km ASL), y = 1 / scale height above it (1/km). */
    rsMistLayer: { value: new THREE.Vector2(0.02, 1 / 0.045) },
    /** Floor on total transmittance so a silhouette always survives. */
    rsAerialTMin: { value: 0.10 },
  };
}

const VERT_HEAD = /* glsl */`
varying vec3 vRsWorldPos;
`;

const VERT_BODY = /* glsl */`
{
  vec4 rsWp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    rsWp = instanceMatrix * rsWp;
  #endif
  #ifdef USE_BATCHING
    rsWp = batchingMatrix * rsWp;
  #endif
  vRsWorldPos = (modelMatrix * rsWp).xyz;
}
`;

/**
 * Patch a built-in three.js material so its output is veiled by the
 * atmosphere. Idempotent; chains onto an existing onBeforeCompile.
 */
export function injectAerial(material, uniforms) {
  if (!material || material.userData.rsAerial || material.userData.rsNoAerial) return material;
  material.userData.rsAerial = true;
  // We replace distance fog entirely. Leaving three's fog on would stack a
  // second, wrongly-coloured veil on top of the scattering one.
  material.fog = false;

  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (typeof prev === 'function') prev.call(this, shader, renderer);

    for (const k in uniforms) shader.uniforms[k] = uniforms[k];

    if (shader.vertexShader.indexOf('vRsWorldPos') === -1) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
        .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_BODY);
    }

    if (shader.fragmentShader.indexOf('rsApplyAerialPerspective') === -1) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + VERT_HEAD + '\n' + AERIAL_GLSL);

      // Apply immediately after the lit colour is resolved, before tonemap /
      // colourspace chunks (which for a NoToneMapping renderer are no-ops).
      if (shader.fragmentShader.indexOf('#include <opaque_fragment>') !== -1) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          '#include <opaque_fragment>\n'
          + 'gl_FragColor.rgb = rsApplyAerialPerspective( gl_FragColor.rgb, vRsWorldPos );',
        );
      } else if (shader.fragmentShader.indexOf('#include <fog_fragment>') !== -1) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <fog_fragment>',
          'gl_FragColor.rgb = rsApplyAerialPerspective( gl_FragColor.rgb, vRsWorldPos );\n'
          + '#include <fog_fragment>',
        );
      }
    }
  };

  const key = material.customProgramCacheKey;
  material.customProgramCacheKey = function () {
    return 'rsAerial|' + (typeof key === 'function' ? key.call(this) : '');
  };
  material.needsUpdate = true;
  return material;
}
