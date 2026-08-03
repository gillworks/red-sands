import * as THREE from 'three';
import {
  ATMO, ATMO_GLSL_CONSTANTS, ATMO_GLSL_COMMON, RS_OUTPUT_GLSL,
  turbidityToMie, skyRadianceCPU,
} from './sky/Atmosphere.js';
import { SkyLuts, LUT_SIZES, PROBE_W, PROBE_H } from './sky/SkyLuts.js';
import { PixelRing } from './AsyncReadback.js';
import { NOISE_GLSL } from './sky/Noise.js';
import { Stars, galacticBasis } from './sky/Stars.js';
import { AERIAL_GLSL, createAerialUniforms, injectAerial } from './sky/AerialPerspective.js';

/**
 * RED SANDS — Sky
 * ============================================================================
 * Physical atmospheric scattering, not a gradient.
 *
 *   transmittance LUT  ->  multiple-scattering LUT  ->  per-frame sky-view LUT
 *
 * Rayleigh + Cornette-Shanks Mie + an ozone tent layer, real planetary radius
 * and a 100 km shell, integrated with Hillaire's analytic in-scatter step and a
 * soft planetary shadow test (which is what actually produces Earth's shadow
 * rising in the east and the Belt of Venus above it).
 *
 * On top of the LUT the dome draws:
 *   - the sun disc at its true 0.536 deg angular diameter with limb darkening,
 *     extinguished by the real slant-path transmittance
 *   - the moon disc with a phase-correct terminator, regolith BRDF, maria and
 *     crater detail, and earthshine on the dark limb
 *   - a procedural Milky Way in true galactic coordinates with a bulge and
 *     dust lanes, rotating about the celestial pole
 *   - airglow, and the moon's own Rayleigh glow (rendered as a second additive
 *     pass into the same sky-view LUT, so moonlit nights are genuinely blue)
 *
 * Several thousand catalogue stars are drawn as a single additive Points pass
 * (see sky/Stars.js).
 *
 * AERIAL PERSPECTIVE for every other system: see sky/AerialPerspective.js for
 * the full injection recipe. Short version:
 *     ctx.get('sky').injectAerialPerspective(material);
 * ============================================================================
 */

const DOME_VERT = /* glsl */`
uniform mat4 uInvProj;
uniform mat3 uCamRot;
varying vec3 vRay;
void main() {
  vec4 h = uInvProj * vec4(position.xy, 1.0, 1.0);
  vRay = uCamRot * (h.xyz / h.w);
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const DOME_FRAG = /* glsl */`
precision highp float;

#define RS_TLUT_W ${LUT_SIZES.TLUT_W}
#define RS_TLUT_H ${LUT_SIZES.TLUT_H}
#define RS_MLUT_W ${LUT_SIZES.MLUT_W}
#define RS_MLUT_H ${LUT_SIZES.MLUT_H}
${ATMO_GLSL_CONSTANTS}
${ATMO_GLSL_COMMON}
${NOISE_GLSL}
${RS_OUTPUT_GLSL}

varying vec3 vRay;

uniform sampler2D uSkyView;
uniform sampler2D uTransmittance;
uniform vec3  uSunDir;
uniform vec3  uMoonDir;
uniform vec3  uSunDiscColor;
uniform vec3  uMoonTint;
uniform float uCamAltKm;
uniform float uSunDisc;
uniform float uMoonDisc;
uniform float uMoonUp;
uniform float uPixelAngle;
uniform float uStarFade;
uniform float uMilkyWay;
uniform float uNightLevel;
uniform vec3  uNightTint;
uniform mat3  uGalactic;
uniform float uCloudCover;
uniform float uDeckDim;      // cloudCover x cloudDensity, 0..1
uniform float uLightning;
uniform float uHorizonHaze;
uniform vec3  uGroundHaze;   // per-km extinction applied below the horizon
uniform float uGroundHazeH;

void main() {
  vec3 dir = normalize(vRay);
  float r = RS_GROUND_R + max(uCamAltKm, 0.0005);

  /* ---------------- scattered sky from the LUT ---------------- */
  vec3 col = texture2D(uSkyView, rsSkyViewDirToUv(dir, r)).rgb;

  /*
   * BELOW THE HORIZON the LUT holds the planet's own ground albedo seen through
   * clear air. Terrain normally hides all of it, but between the edge of the
   * loaded world (~8 km) and the true horizon (~35 km from a 100 m viewpoint)
   * it is what the viewer sees, and the LUT chain carries no boundary-layer
   * aerosol, so that band rendered as a flat saturated slab of ochre with no
   * distance gradient at all. Push it through the same haze the rest of the
   * world gets: the far ground then dissolves into the horizon airlight exactly
   * where a real one does.
   */
  if (dir.y < 0.0 && uGroundHazeH > 0.0) {
    float dKm = min(uCamAltKm / max(-dir.y, 1e-4), 400.0);
    vec3 T = exp(-uGroundHaze * dKm);
    vec3 hz = texture2D(uSkyView,
                rsSkyViewDirToUv(normalize(vec3(dir.x, 0.0006, dir.z)), r)).rgb;
    col = col * T + hz * (vec3(1.0) - T);
  }

  /* extinction toward space for everything celestial */
  vec3 celExt = texture2D(uTransmittance,
                  rsTransmittanceUv(r, max(dir.y, 0.0))).rgb;
  float aboveHorizon = smoothstep(-0.012, 0.012, dir.y);

  /* ---------------- night sky floor: airglow + zodiacal --------- */
  if (uStarFade > 0.002) {
    float am = 1.0 / max(dir.y * 0.94 + 0.06, 0.06);
    // van Rhijn: more emitting layer along a low slant path, but the emission
    // starts at ~90 km so only a fraction of the column extinguishes it.
    float airglow = 0.70 + 0.85 * min(am, 3.2);
    vec3 agExt = mix(vec3(1.0), sqrt(celExt), 0.78);
    col += uNightTint * uNightLevel * airglow * uStarFade * agExt * aboveHorizon;

    /* ---------------- Milky Way ---------------- */
    if (uMilkyWay > 0.001) {
      vec3 g = uGalactic * dir;
      float band = exp(-g.z * g.z / (2.0 * 0.108 * 0.108));
      if (band > 0.002) {
        float toCentre = clamp(g.x, -1.0, 1.0);
        float bulge = exp(-pow(max(1.0 - toCentre, 0.0) / 0.20, 1.3));
        float clump = rsFbm5(g * 5.2);
        float fine  = rsFbm5(g * 27.0);
        float dust  = rsFbm5(g * 8.5 + vec3(11.3, 4.7, 23.1));
        float lane  = rsFbm3(g * 3.1 + vec3(51.0, 7.0, 19.0));

        float mw = band * (0.42 + 1.30 * bulge) * (0.30 + 1.05 * clump);
        // the Great Rift and the smaller lanes: dark dust in front of the arm
        mw *= mix(1.0, 0.10, smoothstep(0.44, 0.72, dust) * band);
        mw *= mix(1.0, 0.42, smoothstep(0.52, 0.80, lane) * band);
        mw *= 0.42 + 0.95 * fine;

        vec3 mwCol = mix(vec3(0.70, 0.78, 1.05), vec3(1.06, 0.88, 0.66),
                         clamp(bulge * 1.1, 0.0, 1.0));
        col += mwCol * mw * uMilkyWay * uStarFade * celExt * aboveHorizon;
      }
    }
  }

  /* ---------------- moon ---------------- */
  if (uMoonUp > 0.0) {
    float cosM = dot(dir, uMoonDir);
    float angM = rsSafeAcos(cosM);
    float Rm = ${ATMO.moonAngularRadius.toFixed(6)};

    // aerosol aureole. Small: the moon is a 0.5 deg source, not a lamp.
    float cm = max(cosM, 0.0);
    float halo = pow(cm, 9000.0) * 0.055
               + pow(cm, 900.0) * 0.0090
               + pow(cm, 95.0) * 0.0016;
    col += uMoonTint * halo * uMoonDisc * celExt * aboveHorizon;

    if (angM < Rm * 1.4) {
      vec3 ax = abs(uMoonDir.y) < 0.985 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 tX = normalize(cross(ax, uMoonDir));
      vec3 tY = cross(uMoonDir, tX);
      vec2 p = vec2(dot(dir, tX), dot(dir, tY)) / Rm;
      float d2 = dot(p, p);
      float edge = smoothstep(1.0 + uPixelAngle / Rm, 1.0 - uPixelAngle / Rm, sqrt(d2));
      if (edge > 0.0) {
        float z = rsSafeSqrt(1.0 - min(d2, 1.0));
        vec3 n = normalize(tX * p.x + tY * p.y - uMoonDir * z);

        float mare = rsFbm5(n * 2.4 + vec3(3.7));
        float med  = rsFbm5(n * 12.0);
        float fine = rsFbm3(n * 34.0);

        // the real terminator is ragged: mountains and crater rims catch light
        float ndl = dot(n, uSunDir) + (med - 0.5) * 0.045;
        float lit = smoothstep(-0.05, 0.10, ndl) * max(ndl, 0.0);
        // Lommel-Seeliger: regolith backscatter, flat-looking full moon
        float bsdf = lit / max(max(ndl, 0.0) + z, 0.12);

        float alb = 0.125;
        alb *= mix(0.55, 1.30, smoothstep(0.40, 0.60, mare));
        alb *= 0.86 + 0.30 * med;
        alb *= 0.90 + 0.22 * fine;

        // faint earthshine keeps the dark limb readable
        float earth = 0.0032 * (1.0 - smoothstep(0.0, 0.5, lit));
        // radiance of sunlit regolith, in the same units as sunlit ground
        vec3 moonCol = uMoonTint * (bsdf * alb + earth * alb) * 16.0;
        col = mix(col, col + moonCol * uMoonDisc * celExt, edge * aboveHorizon);
      }
    }
  }

  /* ---------------- sun disc ---------------- */
  {
    float cosS = dot(dir, uSunDir);
    float angS = rsSafeAcos(cosS);
    float Rs = ${ATMO.sunAngularRadius.toFixed(6)};

    // Circumsolar aureole. The sky-view LUT resolves ~1 deg per texel, which
    // is too coarse for the Mie forward lobe, so the sharp part is analytic.
    /*
     * DECK OCCLUSION OF THE DISC ITSELF.
     *
     * The disc and its aureole used to be added at full radiance whatever the
     * weather, and the only thing removing them under an overcast was the
     * cloud composite's transmittance — which is resolved at 0.45x. A sun disc
     * is a couple of pixels across, so compositing a pixel-sharp emitter
     * against a half-resolution occluder leaks it through wherever a low-res
     * cloud texel happens to be thin. That leak is the beaded vertical white
     * column over the horizon in storm_plains: metrics.py counts it as three
     * separate suns, and it survives every post-process ablation because it is
     * genuinely in the sky buffer. Under a mature convective deck you cannot
     * see the sun at all, so fold the deck term into the disc at source.
     * uDeckDim is cloudCover x cloudDensity, so clear and fair weather (where
     * the disc and its aureole are the money shot) are untouched.
     */
    /*
     * IT WAS STILL LEAKING. storm ships cover 0.66 / density 1.0, so uDeckDim
     * is 0.66 and a linear 1 - 0.94*d left 38 % of a disc whose radiance scale
     * is 180 — several hundred times brighter than the storm sky around it. It
     * punched straight back through the 0.45-res cloud alpha as the beaded
     * vertical white column, and metrics.py still counts three suns in
     * storm_plains on the current build. The response has to be a THRESHOLD,
     * not a ramp: fair weather (deckDim ~0.27, where the disc and its aureole
     * are the money shot) is untouched, and anything from a working overcast
     * upward extinguishes the disc essentially completely, which is also what
     * happens outdoors.
     */
    float discOcc = 1.0 - 0.985 * smoothstep(0.30, 0.62, clamp(uDeckDim, 0.0, 1.0));
    if (uSunDisc > 0.0) {
      float cs = max(cosS, 0.0);
      float aur = pow(cs, 12000.0) * 0.16
                + pow(cs, 1400.0) * 0.030
                + pow(cs, 160.0) * 0.0050;
      col += uSunDiscColor * uSunDisc * aur * celExt * aboveHorizon * discOcc;
    }
    float edge = smoothstep(Rs + uPixelAngle * 1.7, Rs - uPixelAngle * 1.7, angS);
    if (edge > 0.0 && uSunDisc > 0.0) {
      float x = clamp(angS / Rs, 0.0, 1.0);
      float mu = rsSafeSqrt(1.0 - x * x);
      // limb darkening, visible-band coefficients
      float ld = 0.32 + 0.68 * pow(max(mu, 0.0), 0.42);
      col += uSunDiscColor * uSunDisc * ld * edge * celExt * aboveHorizon * discOcc;
    }
  }

  /* ---------------- weather ---------------- */
  if (uCloudCover > 0.001) {
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(lum) * vec3(0.94, 0.955, 1.0), uCloudCover * 0.17);
    /*
     * A thick deck does not merely desaturate the sky it fails to cover, it
     * DARKENS it. Without this the gap between two storm towers renders as
     * cheerful daylight blue and the cells read as bright puffs pasted onto a
     * nice day, which is precisely what pass 2's storm_plains did.
     *
     * Weighted toward the ZENITH, not the horizon. Straight up you are looking
     * into the underside of the deck; along the horizon you are looking OUT
     * from under it into distant sunlit air, and that bright slot under a storm
     * base is the shot. Darkening the horizon instead (which is what the first
     * pass-3 attempt did) is also self-defeating with an auto-exposure in the
     * chain: dimming the brightest thing in frame just raises the exposure and
     * hands the brightness straight back to the ground.
     */
    float band = exp(-max(dir.y, 0.0) * 3.2);
    col *= 1.0 - uDeckDim * (0.10 + 0.36 * (1.0 - band));
  }
  if (uHorizonHaze > 0.0) {
    // Thick air near the horizon: desaturate toward a NEUTRAL grey. This used
    // to tint warm (1.03, 0.99, 0.94), which is a dust-storm colour, and it was
    // painting a yellow band round the whole horizon on ordinary clear days.
    float band = exp(-max(dir.y, 0.0) * 9.0);
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(lum) * vec3(1.005, 1.0, 0.995), band * uHorizonHaze);
  }
  col += uLightning * vec3(0.60, 0.70, 1.0) * 3.5;

  gl_FragColor = vec4(rsOutput(max(col, vec3(0.0))), 1.0);
  #include <colorspace_fragment>
}
`;

const DEG = Math.PI / 180;
const _v3 = new THREE.Vector3();
const _dirTmp = new THREE.Vector3();

/** IEEE half -> float, for LUT readback in debugReadSkyView. */
function half2f(h) {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

export class Sky {
  static id = 'sky';

  constructor(ctx) {
    this.ctx = ctx;

    /**
     * PUBLIC — shared aerial-perspective uniform block. Other systems must
     * share these object references (never clone) so Sky's per-frame writes
     * reach their materials. See src/render/sky/AerialPerspective.js.
     */
    this.aerialUniforms = createAerialUniforms();
    /** PUBLIC — GLSL chunk providing rsApplyAerialPerspective(colour, worldPos). */
    this.aerialGLSL = AERIAL_GLSL;

    /** Sky irradiance handed to Lighting / Weather (linear, updated per frame). */
    this.ambient = {
      color: new THREE.Color(0.35, 0.45, 0.6),
      intensity: 0.6,
      groundColor: new THREE.Color(0.24, 0.2, 0.14),
    };

    /** Art-direction knobs. */
    /**
     * 1.0 is physical, and after the pass-2 rewrite physical is what we want.
     *
     * PASS 1 ran at 1.8 because the in-scatter PEDESTAL was missing in practice
     * (terrain was never injected at all, and where it was, the LUT was sampled
     * below the horizon and returned the sunlit-ground term) so the only way to
     * get any depth separation was to crank the extinction. With the pedestal
     * restored and a real boundary-layer haze term (see hazeExtinction below)
     * the physical answer separates 5-10 km ridges correctly. Re-derived by
     * measurement on golden_hour_vista / high_noon_desert / river_bend:
     * 1.8 -> milk, 1.0 -> correct, 0.7 -> ridges keep too much contrast.
     *
     * PASS-2 INTEGRATION RE-CALIBRATION (1.35 -> 2.5).
     * The figure above was derived while the terrain mesh was not drawing at
     * all: its draw call was being rejected every frame for exceeding
     * MAX_TEXTURE_IMAGE_UNITS, so nine of the ten shots had no landscape in
     * them and the only camera with intact geometry was the camp POI. Every
     * "1.8 -> milk" judgement was therefore made against a few hundred metres
     * of camp ground, never against a 5 km ridge line.
     *
     * Re-swept against the real world, depth-binned off the depth buffer
     * (near band -> far band, linear B-R / luma / saturation):
     *   high_noon_desert  far B-R  1.35: -0.051   1.9: -0.037   2.5: -0.024   3.2: -0.013
     *                     far sat  1.35:  0.274   1.9:  0.223   2.5:  0.187   3.2:  0.160
     *   river_bend        far B-R  1.35: +0.008   1.9: +0.020   2.5: +0.025   3.2: +0.028
     * The NEAR field barely moves across the whole sweep (high_noon 0-60 m
     * luma 0.160 -> 0.151), which is the signature of the term compounding
     * with distance rather than laying a flat veil over the frame. 2.5 puts
     * the far mesas behind visibly cooler, lower-contrast haze while keeping
     * them legible; 3.2 starts to bleach them.
     */
    this.aerialStrength = 2.5;
    /**
     * Boundary-layer aerosol, GREEN channel, per km at sea level, turbidity 2.6.
     * Rayleigh + the thin Mie layer alone give clear desert air a ~180 km
     * visual range, which is roughly three times too clean. This layer supplies
     * the difference. Its 600 m scale height is deliberately low so haze pools
     * in valleys and thins over ridges — that is the mechanism that stacks
     * depth into discrete layers.
     *
     * It used to sit at 0.046/km and be spectrally FLAT (1.000/1.035/1.085).
     * At ground level that made the aerosol seven times stronger than Rayleigh
     * red and 1.4x stronger than Rayleigh blue, so the grey aerosol — lit by a
     * reddened low sun — completely swamped Rayleigh's 5.7:1 blue bias and the
     * depth cue came out warm. 0.030/km with a real Angstrom exponent restores
     * the balance: measured total ground extinction is now
     * (0.047, 0.068, 0.108)/km, i.e. blue extinguishes 2.28x faster than red
     * (it was 1.48x), which is what makes a ridge stack bluer with distance.
     */
    this.hazeExtinction = 0.030;
    /** Angstrom exponent ~1.3: beta(lambda) proportional to lambda^-1.3. */
    this.hazeAngstrom = [0.76, 1.00, 1.34];
    this.hazeScaleKm = 0.6;
    /**
     * VALLEY MIST (see sky/AerialPerspective.js § rsMistExt).
     * Peak extinction per km inside the layer at env.groundMist = 1. 26/km is a
     * ~180 m visual range — a genuine dawn fog bank. It is a LAKE with a hard
     * ceiling, not another exponential-from-sea-level haze, which is what makes
     * it fill the valleys and leave the ridges standing clear of it.
     */
    this.mistExtinction = 50.0;
    /** Metres of mist above the local valley floor before it starts to thin. */
    this.mistDepth = 34;
    /** Metres of e-folding above that ceiling. Sharp: fog tops are sharp. */
    this.mistFalloff = 42;
    /**
     * Floor on aerial transmittance. Distant surfaces asymptote to
     * 1 - rsAerialTMin of the sky rather than to the sky itself, so however
     * thick the air gets there is always a readable silhouette. Pass 2 had no
     * such floor and storm_plains measured a 0.1st-percentile luma of 0.317.
     */
    this.aerialTMin = 0.085;
    /** Maps the unitless scattering integral into engine radiance units.
     *  Calibrated against TimeOfDay.sunPeak so sky and sunlit ground agree. */
    this.skyRadianceScale = ATMO.skyRadianceScale;
    /**
     * Radiance of the solar photosphere relative to the sky integral. The true
     * ratio is ~1e5; 34 (pass 1) was so low that after TAA jitter, the DOF
     * gather and the bloom prefilter had smeared a 9-pixel disc, the brightest
     * pixel in a shot with the sun dead centre measured 0.875 — a sun that
     * cannot reach white. 180 puts the core several stops into AgX's shoulder so
     * it survives the blur chain and clips, which is what a sun does.
     */
    this.sunDiscScale = 180.0;
    this.moonDiscScale = 1.05;
    this.milkyWayScale = 1.0;
    this.starScale = 1.0;
    /** Reference night-sky radiance (airglow + unresolved starlight), linear. */
    this.nightLevel = 0.0013;
    /** Set false to stop the safety-net scan that patches un-injected materials. */
    this.autoInject = true;
    /**
     * MUST STAY TRUE.
     *
     * Terrain deliberately ships no fog of its own (see
     * world/terrain/Material.js: "Distance haze is NOT done here") and relies
     * on this injection. Pass 1 shipped with this set to false on the belief
     * that Terrain still had a uFog* path, so the single largest surface in
     * every frame rendered with NO aerial perspective whatsoever. That is the
     * measured "distant ridge local-contrast 0.117 vs near plain 0.028" and
     * the negative B-R on distant terrain in six of seven daylight shots.
     */
    this.injectIntoTerrain = true;

    this._mieMul = 1;
    this._fallbackExposure = 0.4;
    this._sunRadiance = new THREE.Color();
    this._moonRadiance = new THREE.Color();
    this._galEq = galacticBasis().m;
    this._celestial = new THREE.Matrix3();
    this._galacticFromWorld = new THREE.Matrix3();
    this._acc = [0, 0, 0];
    this._uv = [0, 0];
    this._probe = new Float32Array(PROBE_W * PROBE_H * 3);
    this._probeRaw = null;
    this._probeReady = false;
    this._probePending = false;
    this._probeStall = 0;
    this._probeFrame = 0;
    // The capture harness advances frames inside one synchronous call, so
    // fenced read-backs can never resolve; go blocking from the start there.
    this._probeSync = false;
    /** Local valley-floor altitude in metres, low-passed. See _updateMistFloor. */
    this._mistFloor = 0;
    this._mistFloorTarget = 0;
    this._mistFloorInit = false;
    this._mistFrame = 0;
    this._mistSamples = new Float64Array(49);
    try {
      if (typeof location !== 'undefined'
        && new URLSearchParams(location.search).get('capture') === '1') {
        this._probeSync = true;
      }
    } catch (e) { /* non-browser */ }
    this._scanFrame = 0;
  }

  async init() {
    const ctx = this.ctx;
    const q = ctx.quality;
    const caps = ctx.caps || {};

    const big = q.cloudSteps >= 96;
    const mid = q.cloudSteps >= 48;
    const skyW = big ? 384 : mid ? 256 : 192;
    const skyH = big ? 216 : mid ? 144 : 108;
    const skySteps = big ? 32 : mid ? 22 : 14;

    this.luts = new SkyLuts(ctx.renderer, {
      skyW, skyH, skySteps, float: caps.float !== false,
    });
    this._mieMul = turbidityToMie(ctx.env.turbidity);
    this.luts.buildStatic(this._mieMul);
    this._probeRaw = this.luts.float
      ? new Uint16Array(PROBE_W * PROBE_H * 4)
      : new Uint8Array(PROBE_W * PROBE_H * 4);

    /* --------------------------------------------------------- dome */
    this.uniforms = {
      uInvProj: { value: new THREE.Matrix4() },
      uCamRot: { value: new THREE.Matrix3() },
      uSkyView: { value: this.luts.skyView.texture },
      uTransmittance: { value: this.luts.transmittance.texture },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunDiscColor: { value: new THREE.Vector3(1, 1, 1) },
      uMoonTint: { value: new THREE.Vector3(0.82, 0.88, 1.0) },
      uCamAltKm: { value: 0.05 },
      uSunDisc: { value: 0 },
      uMoonDisc: { value: 0 },
      uMoonUp: { value: 0 },
      uPixelAngle: { value: 0.0006 },
      uStarFade: { value: 0 },
      uMilkyWay: { value: 0 },
      uNightLevel: { value: this.nightLevel },
      uNightTint: { value: new THREE.Vector3(0.62, 0.80, 1.30) },
      uGalactic: { value: new THREE.Matrix3() },
      uCloudCover: { value: 0 },
      uDeckDim: { value: 0 },
      uLightning: { value: 0 },
      uHorizonHaze: { value: 0 },
      uGroundHaze: { value: new THREE.Vector3(0.05, 0.06, 0.08) },
      uGroundHazeH: { value: 1 },
      uFallbackTonemap: { value: 0 },
      uFallbackExposure: { value: 0.4 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      /*
       * SKY DRAWS LATE, NOT FIRST.  The dome is a fullscreen quad whose vertex
       * shader emits NDC z = 1.0, i.e. exactly the far plane.  At renderOrder
       * -1000 with depthTest off it used to shade all 2.07 M pixels of a 1080p
       * frame with the full LUT + sun disc + milky-way + ground-haze shader,
       * every one of which was then painted over by terrain, trees and town.
       * With depthTest on and a renderOrder that puts it after every piece of
       * opaque geometry, early-Z throws away every covered pixel before the
       * fragment shader runs; in a canopy shot that is 95% of the frame.
       * Measured: -1.4 to -3.3 ms depending on how much sky is visible.
       *
       * 21 is deliberate: it is after terrain (20) but BEFORE Water's
       * framebuffer grab (23), so water refraction still sees the sky behind
       * it.  depthWrite stays off — nothing may sort against the dome.
       */
      depthTest: true,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 21;
    this.mesh.userData.rsNoAerial = true;
    ctx.scene.add(this.mesh);

    /* -------------------------------------------------------- stars */
    this.stars = new Stars(ctx.seed, q.name === 'low' ? 3000 : 6600);
    this.stars.material.uniforms.uTransmittance.value = this.luts.transmittance.texture;
    this.stars.material.uniforms.uFallbackTonemap = this.uniforms.uFallbackTonemap;
    this.stars.material.uniforms.uFallbackExposure = this.uniforms.uFallbackExposure;
    this.stars.object.userData.rsNoAerial = true;
    ctx.scene.add(this.stars.object);

    /* ---------------------------------------------- aerial uniforms */
    this.aerialUniforms.rsSkyViewLut.value = this.luts.skyView.texture;
    this.aerialUniforms.rsAerialLut.value = this.luts.aerialLut.texture;

    // Bridge into other systems once everything exists.
    ctx.on('ready', () => this._bridge());

    this.update(0);
  }

  /* --------------------------------------------------------- PUBLIC API */

  /**
   * Patch a three.js material so its shading is veiled by real in-scattering.
   * Idempotent, instancing/skinning aware, chains onto existing
   * onBeforeCompile hooks. See src/render/sky/AerialPerspective.js.
   */
  injectAerialPerspective(material) {
    if (!material) return material;
    if (Array.isArray(material)) {
      for (const m of material) injectAerial(m, this.aerialUniforms);
      return material;
    }
    return injectAerial(material, this.aerialUniforms);
  }

  /**
   * Read the GPU sky-view LUT back for a world direction. Debug/tuning only —
   * this stalls the pipeline, never call it per frame.
   * @returns {number[]} linear HDR radiance [r,g,b]
   */
  debugReadSkyView(dir) {
    const r = ATMO.groundRadiusKm + Math.max(this.ctx.camera.position.y, 0) * 0.001;
    const d = _v3.copy(dir).normalize();
    let a = Math.atan2(d.z, d.x);
    if (a < 0) a += Math.PI * 2;
    const u = a / (Math.PI * 2);
    const Vh = Math.sqrt(Math.max(r * r - ATMO.groundRadiusKm ** 2, 0));
    const beta = Math.acos(THREE.MathUtils.clamp(Vh / r, -1, 1));
    const zha = Math.PI - beta;
    const vza = Math.acos(THREE.MathUtils.clamp(d.y, -1, 1));
    const v = vza < zha
      ? (1 - Math.sqrt(Math.max(1 - vza / zha, 0))) * 0.5
      : Math.sqrt(Math.max((vza - zha) / beta, 0)) * 0.5 + 0.5;

    const rt = this.luts.skyView;
    const x = Math.min(rt.width - 1, Math.max(0, Math.floor(u * rt.width)));
    const y = Math.min(rt.height - 1, Math.max(0, Math.floor(v * rt.height)));
    const buf = rt.texture.type === THREE.HalfFloatType ? new Uint16Array(4) : new Uint8Array(4);
    this.ctx.renderer.readRenderTargetPixels(rt, x, y, 1, 1, buf);
    if (buf instanceof Uint8Array) {
      const dec = (t) => { const s = (t / 255) ** 2; return s / Math.max(1 - s, 1e-3); };
      return [dec(buf[0]), dec(buf[1]), dec(buf[2])];
    }
    return [half2f(buf[0]), half2f(buf[1]), half2f(buf[2])];
  }

  /** Sky-view LUT uv for a world direction, matching rsSkyViewDirToUv. */
  _skyViewUv(d, out) {
    const r = ATMO.groundRadiusKm + Math.max(this.ctx.camera.position.y, 0) * 0.001;
    let a = Math.atan2(d.z, d.x);
    if (a < 0) a += Math.PI * 2;
    const Vh = Math.sqrt(Math.max(r * r - ATMO.groundRadiusKm ** 2, 0));
    const beta = Math.acos(THREE.MathUtils.clamp(Vh / r, -1, 1));
    const zha = Math.PI - beta;
    const vza = Math.acos(THREE.MathUtils.clamp(d.y, -1, 1));
    out[0] = a / (Math.PI * 2);
    out[1] = vza < zha
      ? (1 - Math.sqrt(Math.max(1 - vza / zha, 0))) * 0.5
      : Math.min(1, Math.sqrt(Math.max((vza - zha) / beta, 0)) * 0.5 + 0.5);
    return out;
  }

  /** Bilinear fetch from the CPU mirror of the sky-view LUT. */
  _probeSample(u, v, out) {
    const p = this._probe;
    const W = PROBE_W, H = PROBE_H;
    const x = u * W - 0.5;
    const y = THREE.MathUtils.clamp(v * H - 0.5, 0, H - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const yi0 = THREE.MathUtils.clamp(y0, 0, H - 1);
    const yi1 = THREE.MathUtils.clamp(y0 + 1, 0, H - 1);
    const xi0 = ((x0 % W) + W) % W;
    const xi1 = ((x0 + 1) % W + W) % W;
    for (let c = 0; c < 3; c++) {
      const a = p[(yi0 * W + xi0) * 3 + c], b = p[(yi0 * W + xi1) * 3 + c];
      const d = p[(yi1 * W + xi0) * 3 + c], e = p[(yi1 * W + xi1) * 3 + c];
      out[c] = (a + (b - a) * fx) + ((d + (e - d) * fx) - (a + (b - a) * fx)) * fy;
    }
    return out;
  }

  /**
   * Sky radiance in a world direction, linear HDR, engine units.
   * Backed by an async read-back of the real GPU scattering solution (updated
   * a few times a second, no pipeline stall); falls back to an analytic CPU
   * integral for the first frames. Safe to call every frame.
   */
  sampleSkyRadiance(dir, out = new THREE.Color()) {
    const d = _v3.copy(dir).normalize();
    if (this._probeReady) {
      this._skyViewUv(d, this._uv);
      this._probeSample(this._uv[0], this._uv[1], this._acc);
      return out.setRGB(this._acc[0], this._acc[1], this._acc[2]);
    }
    const s = this.ctx.env.sunDirection;
    skyRadianceCPU(d.x, d.y, d.z, s.x, s.y, s.z, this._mieMul,
      Math.max(this.ctx.camera.position.y, 0) * 0.001, this._acc, 12);
    const k = this.skyRadianceScale;
    return out.setRGB(this._acc[0] * k, this._acc[1] * k, this._acc[2] * k);
  }

  /**
   * Pull the downsampled sky-view LUT back to the CPU.
   * Async (fenced PBO, no stall) during normal play. The screenshot harness
   * steps frames inside one synchronous call, so promises never resolve there
   * and we fall back to a blocking read of the 48x32 probe instead — 6 KB, a
   * few times a second, and it keeps captures deterministic.
   */
  _pumpProbe() {
    const r = this.ctx.renderer;
    const canAsync = typeof r.readRenderTargetPixelsAsync === 'function';

    /*
     * Preferred path: a pixel-pack-buffer ring (AsyncReadback.js). Neither the
     * blocking read nor the promise-based one is acceptable here — the blocking
     * one drains the pipeline every fourth frame, and the promise never settles
     * inside the harness's synchronous `renderFrames()` loop, which is what
     * drove the fallback to the blocking read in the first place. The ring
     * needs no event loop: it collects a read issued three frames ago.
     */
    if (this._ring === undefined) {
      this._ring = null;
      // 8-bit probe targets carry a tonemapped encoding that _decodeProbe
      // undoes; only the float path can be read straight back as RGBA/FLOAT.
      try {
        if (!this.luts.float) throw new Error('probe is 8-bit');
        const gl = r.getContext();
        /*
         * RGBA/FLOAT, not RGBA/HALF_FLOAT.  The probe target is RGBA16F, and
         * the only readPixels format/type pair WebGL2 guarantees for a
         * floating-point colour attachment (EXT_color_buffer_float) is
         * RGBA/FLOAT — asking for HALF_FLOAT silently failed here, the ring
         * reported !ok, and Sky fell all the way back to the blocking
         * `readRenderTargetPixels` path (`_probeSync`), draining the pipeline
         * every sixth frame for the whole of pass 3 and 4.  Float32 costs
         * 24 KB of transfer instead of 12 KB, once every other frame.
         */
        const ring = new PixelRing(r, {
          width: PROBE_W, height: PROBE_H,
          array: (this._probeF32 = new Float32Array(PROBE_W * PROBE_H * 4)),
          glFormat: gl.RGBA, glType: gl.FLOAT, latency: 3,
        });
        if (ring.ok) this._ring = ring;
      } catch (e) { this._ring = null; }
    }
    if (this._ring && this._ring.ok) {
      if (this._ring.pump(this.luts.probe, 0, 0)) this._decodeProbeF32();
      return;
    }

    if (this._probePending) {
      if (++this._probeStall < 40) return;
      this._probeSync = true;     // event loop is starved: stop using promises
      this._probePending = false;
      return;                     // let the abandoned read unbind its PBO first
    }

    if (this._probeSync || !canAsync) {
      try {
        r.readRenderTargetPixels(this.luts.probe, 0, 0, PROBE_W, PROBE_H, this._probeRaw);
        this._decodeProbe();
      } catch (e) { /* keep the previous solution */ }
      return;
    }

    this._probePending = true;
    this._probeStall = 0;
    r.readRenderTargetPixelsAsync(this.luts.probe, 0, 0, PROBE_W, PROBE_H, this._probeRaw)
      .then(() => { this._decodeProbe(); this._probePending = false; })
      .catch(() => { this._probePending = false; });
  }

  /** Ring path: the probe already came back as linear float RGBA. */
  _decodeProbeF32() {
    const raw = this._probeF32;
    const out = this._probe;
    if (!raw) return;
    for (let i = 0, j = 0; i < PROBE_W * PROBE_H; i++, j += 4) {
      const k = i * 3;
      out[k] = raw[j]; out[k + 1] = raw[j + 1]; out[k + 2] = raw[j + 2];
    }
    this._probeReady = true;
  }

  _decodeProbe() {
    const raw = this._probeRaw;
    const out = this._probe;
    const half = raw instanceof Uint16Array;
    for (let i = 0, j = 0; i < PROBE_W * PROBE_H; i++, j += 4) {
      const k = i * 3;
      if (half) {
        out[k] = half2f(raw[j]); out[k + 1] = half2f(raw[j + 1]); out[k + 2] = half2f(raw[j + 2]);
      } else {
        for (let c = 0; c < 3; c++) {
          const s = (raw[j + c] / 255) ** 2;
          out[k + c] = s / Math.max(1 - s, 1e-3);
        }
      }
    }
    this._probeReady = true;
  }

  /**
   * Hemispherical sky irradiance + ground bounce, for Lighting / Weather to
   * drive ambient with instead of a constant. Updated every frame.
   * @returns {{color:THREE.Color, intensity:number, groundColor:THREE.Color}}
   */
  getSkyIrradiance() { return this.ambient; }

  /**
   * WEATHER / TERRAIN: the correct linear HDR colour for distance haze looking
   * along `dir` (defaults to the camera's forward). Reads the GPU sky-view LUT
   * indirectly through the same CPU model, so it tracks sunrise, sunset and
   * night automatically — including going nearly black after dark, which a
   * hand-authored `env.fogColor` will not do.
   *
   *   env.fogColor.copy(sky.getFogColor());
   *
   * @returns {THREE.Color} linear HDR (NOT sRGB, NOT normalised)
   */
  getFogColor(dir = null, out = new THREE.Color()) {
    const d = _v3.copy(dir || this.ctx.camera.getWorldDirection(_dirTmp));
    d.y = THREE.MathUtils.clamp(d.y * 0.35 + 0.05, -0.02, 0.5);
    d.normalize();
    return this.sampleSkyRadiance(d, out);
  }

  /* ------------------------------------------------------------- INTERNAL */

  _bridge() {
    for (const id of ['terrain', 'lighting']) {
      const S = this.ctx.get(id);
      if (!S || typeof S.registerMaterialUser !== 'function') continue;
      if (id === 'terrain' && !this.injectIntoTerrain) continue;
      try {
        S.registerMaterialUser((m) => this.injectAerialPerspective(m));
      } catch (e) { /* consumer threw; keep the safety net on */ }
    }
    this._scanScene();
  }

  /**
   * Safety net: patch built-in materials that nobody injected. Systems are
   * expected to call injectAerialPerspective themselves; this just guarantees
   * the world never renders without aerial perspective.
   */
  _scanScene() {
    if (!this.autoInject) return;
    const OK = [
      THREE.MeshStandardMaterial, THREE.MeshPhysicalMaterial,
      THREE.MeshLambertMaterial, THREE.MeshPhongMaterial,
    ];
    this.ctx.scene.traverse((o) => {
      if (!o.material || o.userData.rsNoAerial) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) {
        if (!m || m.userData.rsAerial || m.userData.rsNoAerial) continue;
        if (!OK.some((C) => m instanceof C)) continue;
        injectAerial(m, this.aerialUniforms);
      }
    });
  }

  /** Equatorial -> world rotation from local sidereal time and latitude. */
  _updateCelestial(lst, latRad) {
    const cL = Math.cos(lst), sL = Math.sin(lst);
    const cP = Math.cos(latRad), sP = Math.sin(latRad);

    // hour-angle frame:  s = M1 * u
    // horizon frame:     (xS, yW, zU) = M2 * s
    // world (+X east, -Z north, +Y up): world = (-yW, zU, xS)
    // Composed by hand, row-major then stored column-major for Matrix3.set().
    const m = this._celestial;
    m.set(
      // world.x = -s.y = -(sL*u.x - cL*u.y)
      -sL, cL, 0,
      // world.y = z_h = cP*s.x + sP*s.z
      cP * cL, cP * sL, sP,
      // world.z = x_h = sP*s.x - cP*s.z
      sP * cL, sP * sL, -cP,
    );
    // galactic-from-world = galacticFromEquatorial * worldFromEquatorial^-1
    this._galacticFromWorld.copy(m).transpose().premultiply(this._galEq);
  }

  update(dt) {
    const ctx = this.ctx;
    if (!this.luts) return;
    const env = ctx.env;
    const cam = ctx.camera;
    const u = this.uniforms;

    /* -------- turbidity -> Mie, rebuild static LUTs when it drifts -------- */
    const mie = turbidityToMie(env.turbidity);
    this._mieMul = mie;
    if (this.luts.needsStaticRebuild(mie)) this.luts.buildStatic(mie);

    const camAltKm = Math.max(cam.position.y, 0) * 0.001;

    /* --------------------------- solar / lunar --------------------------- */
    const sunDir = env.sunDirection;
    const moonDir = env.moonDirection;
    const sunAlt = Math.asin(THREE.MathUtils.clamp(sunDir.y, -1, 1)) / DEG;
    const moonAlt = Math.asin(THREE.MathUtils.clamp(moonDir.y, -1, 1)) / DEG;

    // Out-of-atmosphere solar spectrum: flat white. Every reddening, every
    // twilight band and the Earth-shadow edge come out of the integral itself,
    // never from a keyframe, so there is no altitude fade here on purpose.
    const S = this.skyRadianceScale;
    this._sunRadiance.setRGB(S, S, S);

    const moonLit = THREE.MathUtils.clamp((moonAlt + 5.0) / 6.0, 0, 1)
      * env.moonIntensity * S * 0.019;
    this._moonRadiance.setRGB(moonLit * 0.60, moonLit * 0.76, moonLit * 1.22);

    /* ------------------------- sky-view LUT ------------------------------ */
    /*
     * The sky-view LUT is a 384x216 x 32-step raymarch plus the 48x32 probe:
     * ~0.6 ms of GPU every frame to produce a table that is a pure function of
     * (camera altitude, sun direction, moon direction, radiance).  The sun
     * moves 0.004 deg per frame; rebuilding at 60 Hz is 250 redundant marches a
     * second.  Rebuild only when an input has actually moved enough to change a
     * texel — 0.0006 of direction is ~0.03 deg, three orders of magnitude below
     * anything visible — with a 30-frame backstop so nothing can wedge stale.
     */
    const lk = this._lutKey || (this._lutKey = {
      sx: 9, sy: 9, sz: 9, mx: 9, my: 9, mz: 9, alt: -9, moon: -9, n: 999,
    });
    const moonOn = moonAlt > -6;
    const moonSum = this._moonRadiance.r + this._moonRadiance.g + this._moonRadiance.b;
    const moved = Math.abs(sunDir.x - lk.sx) + Math.abs(sunDir.y - lk.sy) + Math.abs(sunDir.z - lk.sz)
      + (moonOn ? Math.abs(moonDir.x - lk.mx) + Math.abs(moonDir.y - lk.my) + Math.abs(moonDir.z - lk.mz) : 0);
    if (moved > 6e-4 || Math.abs(camAltKm - lk.alt) > 2e-3
        || Math.abs(moonSum - lk.moon) > 1e-4 || ++lk.n > 30) {
      lk.sx = sunDir.x; lk.sy = sunDir.y; lk.sz = sunDir.z;
      lk.mx = moonDir.x; lk.my = moonDir.y; lk.mz = moonDir.z;
      lk.alt = camAltKm; lk.moon = moonSum; lk.n = 0;
      this.luts.renderSkyView(
        camAltKm, sunDir, this._sunRadiance,
        moonOn ? moonDir : null, this._moonRadiance,
      );
    }

    /* ------------------------------ dome --------------------------------- */
    u.uInvProj.value.copy(cam.projectionMatrix).invert();
    u.uCamRot.value.setFromMatrix4(cam.matrixWorld);
    u.uSunDir.value.copy(sunDir);
    u.uMoonDir.value.copy(moonDir);
    u.uCamAltKm.value = camAltKm;

    // The disc is a radiance, so it fades with the same transmittance the LUT
    // applies to everything else — no separate keyframe.
    const discFade = THREE.MathUtils.clamp((sunAlt + 1.1) / 1.4, 0, 1);
    u.uSunDisc.value = this.sunDiscScale * discFade;
    u.uSunDiscColor.value.set(1.0, 0.985, 0.96);

    const moonVis = THREE.MathUtils.clamp((moonAlt + 0.9) / 1.6, 0, 1);
    u.uMoonUp.value = moonVis > 0 ? 1 : 0;
    u.uMoonDisc.value = this.moonDiscScale * moonVis;
    u.uMoonTint.value.set(0.86, 0.90, 1.0);

    const size = ctx.renderer.getDrawingBufferSize(new THREE.Vector2());
    u.uPixelAngle.value = (cam.fov * DEG) / Math.max(size.y, 1) * 0.75;

    /* ----------------------- night sky / stars --------------------------- */
    // Stars appear through nautical twilight and are gone by civil dawn.
    const nightFade = THREE.MathUtils.clamp((-sunAlt - 2.0) / 9.0, 0, 1);
    const moonWash = 1.0 - 0.42 * THREE.MathUtils.clamp(env.moonIntensity * 1.4, 0, 1)
      * THREE.MathUtils.clamp((moonAlt + 2) / 8, 0, 1);
    const cloudWash = 1.0 - 0.38 * env.cloudCover;
    const starFade = nightFade * nightFade * moonWash * cloudWash;

    u.uStarFade.value = starFade;
    u.uMilkyWay.value = this.milkyWayScale * this.nightLevel * 27.0;
    u.uNightLevel.value = this.nightLevel;
    u.uCloudCover.value = THREE.MathUtils.clamp(env.cloudCover, 0, 1);
    // Mirrors the deck term Clouds uses internally, so the sky the viewer sees
    // between the cells agrees with the cells themselves.
    u.uDeckDim.value = THREE.MathUtils.clamp(
      (env.cloudCover || 0) * (0.35 + 0.65 * (env.cloudDensity || 0)), 0, 1);
    u.uLightning.value = env.lightningFlash || 0;
    u.uHorizonHaze.value = THREE.MathUtils.clamp((env.turbidity - 3.0) / 9.0, 0, 0.55);

    const tod = ctx.get('timeOfDay');
    const lst = tod && Number.isFinite(tod.siderealTimeRad)
      ? tod.siderealTimeRad
      : (env.timeOfDay / 24) * Math.PI * 2;
    const latRad = (tod ? tod.latitude : 34.5) * DEG;
    this._updateCelestial(lst, latRad);
    u.uGalactic.value.copy(this._galacticFromWorld);

    const sm = this.stars.material.uniforms;
    sm.uCelestial.value.copy(this._celestial);
    sm.uPixelScale.value = ctx.renderer.getPixelRatio();
    sm.uBrightness.value = this.nightLevel * 400.0 * this.starScale;
    sm.uTime.value = ctx.time.elapsed;
    sm.uFade.value = starFade;
    this.stars.object.position.copy(cam.position);

    /* ------------------------ aerial perspective ------------------------- */
    const au = this.aerialUniforms;
    au.rsCameraPos.value.copy(cam.position);
    au.rsSunDir.value.copy(sunDir);
    au.rsCamAltKm.value = camAltKm;
    au.rsMieMul.value = mie;
    au.rsAerialStrength.value = this.aerialStrength;
    // The airlight integral in AerialPerspective.js is driven by the SAME
    // radiances the sky-view LUT is rendered with, so the haze and the sky it
    // fades into are guaranteed to agree in colour at every hour.
    au.rsSunRadiance.value.set(this._sunRadiance.r, this._sunRadiance.g, this._sunRadiance.b);
    au.rsMoonDir.value.copy(moonDir);
    if (moonAlt > -3) {
      au.rsMoonRadiance.value.set(
        this._moonRadiance.r, this._moonRadiance.g, this._moonRadiance.b,
      );
    } else {
      au.rsMoonRadiance.value.set(0, 0, 0);
    }
    // Airglow floor: without it the far field at night has no in-scatter at all
    // and a distant ridge sits at exactly the same value as a near one.
    const nl = this.nightLevel * starFade * 12.0;
    au.rsNightRadiance.value.set(nl * 0.62, nl * 0.80, nl * 1.30);
    /*
     * Weather thickens the boundary layer, not the whole column: rain is
     * low-lying, so it rides the 600 m layer or it veils mountain tops as hard
     * as valley floors and the layering collapses.
     *
     * PASS-3 RETUNE. The rain multiplier was `1 + wet*2.2 + mistHaze*3.0`, i.e.
     * up to 3.3x under a thunderstorm, and env.groundMist was ALSO folded in
     * here on top of PostFX running its own mist medium off the same field.
     * Two independent veils driven by one number is how storm_plains became a
     * bowl of milk. Ground mist now has its own explicit lake layer below and
     * is no longer double-counted here; rain thickens the air far less (a
     * rainstorm has excellent visibility between the shafts — that is why you
     * can see a curtain of rain at all).
     */
    const wet = (env.rainIntensity || 0) * 0.55 + (env.snowIntensity || 0) * 0.35;
    const turbK = THREE.MathUtils.clamp(mie, 0.45, 4.0);
    const hz = this.hazeExtinction * (0.55 + 0.45 * turbK) * (1 + wet * 0.85);
    // Angstrom lambda^-1.3 slope: real continental aerosol is NOT grey.
    const A = this.hazeAngstrom;
    au.rsHazeExt.value.set(hz * A[0], hz * A[1], hz * A[2]);
    // Same medium, seen by the dome below the horizon (Rayleigh included, since
    // there the path is tens of kilometres long).
    const st = this.aerialStrength;
    u.uGroundHaze.value.set(
      (hz * A[0] + ATMO.rayleighScattering[0] + ATMO.mieExtinction * mie) * st,
      (hz * A[1] + ATMO.rayleighScattering[1] + ATMO.mieExtinction * mie) * st,
      (hz * A[2] + ATMO.rayleighScattering[2] + ATMO.mieExtinction * mie) * st,
    );
    // Rain compresses the layer toward the ground so it pools harder.
    au.rsHazeH.value = this.hazeScaleKm / (1 + wet * 0.8);
    au.rsAerialFade.value = 0;

    /* ------------------------- valley mist lake -------------------------- */
    this._updateMistFloor(dt);
    const gm = THREE.MathUtils.clamp(env.groundMist || 0, 0, 1);
    // Response is deliberately super-linear: a light mist should be a thin
    // ribbon in the very bottom of the valley, not a half-strength veil.
    const mistK = Math.pow(gm, 1.3);
    const me = this.mistExtinction * mistK;
    // Fog droplets are >> lambda: essentially white, with a whisker of the
    // blue bias that very fine radiation-fog droplets actually have.
    au.rsMistExt.value.set(me * 0.985, me * 0.995, me * 1.0);
    au.rsMistLayer.value.set(
      (this._mistFloor + this.mistDepth * (0.45 + 0.55 * gm)) * 0.001,
      1000 / Math.max(8, this.mistFalloff),
    );
    au.rsAerialTMin.value = this.aerialTMin;
    // The sky-view LUT is clear-air, so the haze it feeds into every material
    // stays cheerfully blue under a thunderstorm unless we dim it by the deck.
    const deck = Math.min(1, (env.cloudCover || 0) * (0.35 + 0.65 * (env.cloudDensity || 0)));
    au.rsAerialInscatter.value = 1 - deck * 0.85;
    // Flat additive bloom from a flash. Kept small — it lands on EVERY
    // fragment, so a large value is a frame-wide black-lift.
    const lf = (env.lightningFlash || 0) * 0.55;
    au.rsAerialAdd.value.set(lf * 0.6, lf * 0.7, lf);

    this.mesh.position.copy(cam.position);

    /* --------------------- ambient irradiance handoff -------------------- */
    this._updateAmbient(sunDir, camAltKm);

    /* ------------------- preview transform (see Atmosphere.js) ----------- */
    const post = ctx.get('postfx');
    const needFallback = !(post && typeof post.render === 'function' && !post.__failed);
    u.uFallbackTonemap.value = needFallback ? 1 : 0;
    if (needFallback) {
      const ref = Math.max(this.ambient.intensity * 0.9, 2e-4);
      const target = 0.42 / Math.pow(ref, 0.55);
      const k = dt > 0 ? Math.min(1, dt * 2.2) : 1;
      this._fallbackExposure += (target - this._fallbackExposure) * k;
      u.uFallbackExposure.value = this._fallbackExposure;
    }

    if (++this._probeFrame % (this._ring ? 2 : (this._probeSync ? 6 : 3)) === 0) this._pumpProbe();
    if (this.autoInject && ++this._scanFrame % 45 === 0) this._scanScene();
  }

  /**
   * Where the mist lake's surface sits.
   *
   * Radiation fog forms in the low ground and its top is a real, fairly flat
   * surface — you look DOWN onto it from a ridge. So the layer ceiling has to
   * track the local valley floor, not the camera and not the global water
   * plane (which in dawn_mist_valley is 30 m below the ground the camera is
   * standing on, and buried the whole layer underground in pass 1).
   *
   * 7x7 terrain probes over a 1.4 km square, 15th percentile, amortised to
   * once every 20 frames and low-passed — 49 analytic height queries every
   * third of a second is nothing, and it means a rider descending into a
   * valley watches the fog rise around him.
   */
  _updateMistFloor(dt) {
    const ctx = this.ctx;
    if (!ctx.world.ready) return;
    if ((this._mistFrame++ % 20) === 0 || !this._mistFloorInit) {
      const cam = ctx.camera;
      const R = 700;
      const N = 7;
      const hs = this._mistSamples;
      let k = 0;
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          hs[k++] = ctx.world.getHeight(
            cam.position.x + (i / (N - 1) - 0.5) * 2 * R,
            cam.position.z + (j / (N - 1) - 0.5) * 2 * R,
          );
        }
      }
      const sorted = Array.prototype.slice.call(hs).sort((a, b) => a - b);
      let floor = sorted[Math.floor(0.15 * (sorted.length - 1))];
      // A river bottom is not where the fog lives; the water surface is.
      floor = Math.max(floor, (ctx.world.waterLevel || 0) - 1);
      this._mistFloorTarget = floor;
      if (!this._mistFloorInit) { this._mistFloor = floor; this._mistFloorInit = true; }
    }
    const k = dt > 0 ? Math.min(1, dt * 1.5) : 1;
    this._mistFloor += (this._mistFloorTarget - this._mistFloor) * k;
  }

  /** Cosine-weighted hemisphere integral over the real scattering solution. */
  _updateAmbient(sunDir, camAltKm) {
    const acc = this._acc;
    let r = 0, g = 0, b = 0;
    const dirs = Sky._AMBIENT_DIRS;
    const k = this.skyRadianceScale;
    for (let i = 0; i < dirs.length; i++) {
      const d = dirs[i];
      if (this._probeReady) {
        _v3.set(d[0], d[1], d[2]);
        this._skyViewUv(_v3, this._uv);
        this._probeSample(this._uv[0], this._uv[1], acc);
      } else {
        skyRadianceCPU(d[0], d[1], d[2], sunDir.x, sunDir.y, sunDir.z,
          this._mieMul, camAltKm, acc, 10);
        acc[0] *= k; acc[1] *= k; acc[2] *= k;
      }
      const w = d[3];
      r += acc[0] * w; g += acc[1] * w; b += acc[2] * w;
    }

    const env = this.ctx.env;
    // moonlight adds a cold floor once the sun is gone
    const mi = env.moonIntensity || 0;
    r += mi * 0.020; g += mi * 0.028; b += mi * 0.048;
    r += this.nightLevel * 0.9; g += this.nightLevel * 1.1; b += this.nightLevel * 1.8;

    /*
     * THE CLOUD DECK EATS SKYLIGHT.
     *
     * Everything above is the CLEAR-AIR scattering solution — the LUT chain
     * knows nothing about clouds. Lighting drives its ambient term from this
     * number, so before this correction a thunderstorm lit the ground with a
     * full clear-day sky and the plain came out at 0.80x the radiance of the
     * storm sky above it. The real figure for an overcast ground is around
     * 0.3x: an optically thick deck transmits only 10-25% of the skylight, and
     * that shortfall is most of what makes a storm READ as a storm. Measured on
     * storm_plains, this is the single largest contributor to the "near ground
     * is the same value as the sky" whiteout the pass-2 review filed.
     *
     * Scattered fair-weather cumulus are deliberately barely affected — they
     * cover a fifth of the sky and bounce as much light down as they block.
     */
    const cover = Math.min(1, Math.max(0, env.cloudCover || 0));
    const dens = Math.min(1, Math.max(0, env.cloudDensity || 0));
    const opacity = Math.min(1, cover * (0.22 + 0.78 * dens * dens));
    const deckDim = 1 - 0.70 * opacity;
    r *= deckDim; g *= deckDim; b *= deckDim;
    // Multiple scattering inside the deck also neutralises the hue: light that
    // reaches the ground under cloud has forgotten which way it came in.
    if (opacity > 0.02) {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const nk = 0.45 * opacity;
      r += (y * 0.96 - r) * nk; g += (y - g) * nk; b += (y * 1.06 - b) * nk;
    }

    const lum = Math.max(0.2126 * r + 0.7152 * g + 0.0722 * b, 1e-5);
    this.ambient.intensity = lum;
    this.ambient.color.setRGB(r / lum, g / lum, b / lum);
    const ga = ATMO.groundAlbedo;
    this.ambient.groundColor.setRGB(
      (r / lum) * ga[0] * 2.6, (g / lum) * ga[1] * 2.6, (b / lum) * ga[2] * 2.6,
    );
  }

  resize() {}

  dispose() {
    if (this._ring) { this._ring.dispose(); this._ring = null; }
    const ctx = this.ctx;
    if (this.mesh) { ctx.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    if (this.material) this.material.dispose();
    if (this.stars) { ctx.scene.remove(this.stars.object); this.stars.dispose(); }
    if (this.luts) this.luts.dispose();
  }
}

/** Cosine-weighted hemisphere sample directions [x,y,z,weight]. */
Sky._AMBIENT_DIRS = (() => {
  const out = [[0, 1, 0, 0.24]];
  const ring = (altDeg, w) => {
    const a = altDeg * Math.PI / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let i = 0; i < 3; i++) {
      const t = (i / 3) * Math.PI * 2;
      out.push([ca * Math.cos(t), sa, ca * Math.sin(t), w]);
    }
  };
  ring(48, 0.115);
  ring(14, 0.077);
  return out;
})();
