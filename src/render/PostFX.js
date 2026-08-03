import * as THREE from 'three';
import { rng } from '../core/Context.js';
import { FullScreenQuad, makeRT, makeBlueNoise, haltonSequence } from './postfx/Common.js';
import {
  velocityMaterial, velocityObjectMaterial,
  gtaoMaterial, aoDenoiseMaterial, aoTemporalMaterial,
} from './postfx/Geometry.js';
import { volumetricMaterial, volumetricTemporalMaterial } from './postfx/Atmosphere.js';
import { ssrMaterial } from './postfx/Reflections.js';
import { compositeMaterial } from './postfx/Composite.js';
import { taaMaterial } from './postfx/Temporal.js';
import {
  dofPrepareMaterial, dofNearDilateMaterial, dofGatherMaterial, dofCompositeMaterial,
  tileMaxMaterial, neighborMaxMaterial, motionBlurMaterial,
} from './postfx/Camera.js';
import { bloomPrefilterMaterial, bloomDownMaterial, bloomUpMaterial } from './postfx/Bloom.js';
import { logLumaMaterial, boxDownMaterial, exposureAdaptMaterial, finalMaterial, copyMaterial } from './postfx/Grade.js';
import { PROFILE, prof } from './Profiler.js';
import { PixelRing } from './AsyncReadback.js';

/* -------------------------------------------------------------- grades */

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

/** Where 18% grey sits on the AgX sigmoid — the stock curve's own pivot. */
const LOG2_MIDGREY = Math.log2(0.18);
const AGX_PIVOT_T = 10 / 16.5;

/**
 * Systems whose meshes travel independently of the camera and therefore need
 * per-object motion vectors. See `PostFX._refreshMovers`.
 */
const MOVER_SYSTEMS = ['player', 'horse', 'wildlife'];

/**
 * Named looks. Values are authored in the display-referred space that sits
 * immediately after the AgX transform, which is where a colourist works.
 */
/*
 * `latitude` is the width, in stops, that AgX maps onto the display range, and
 * `toe` is the width of the display-space foot. Together they ARE the tone
 * curve; everything else in a preset is colour. They live in the preset table
 * rather than in `film` so they cross-fade with the look — a night grade wants
 * a gentler curve than a noon one, and blendPreset() lerps them for free.
 *
 * Stock AgX is 16.5 stops wide, which is why every daylight frame in this
 * project measured a median luma of 0.51-0.55 against a p1 of 0.15-0.19: a
 * landscape occupies about five stops, and five stops out of sixteen and a half
 * is a third of the display range. 13.5 puts the same five stops across roughly
 * 45% of it, which is where a film stock puts them.
 */
const GRADES = {
  neutral: {
    latitude: 16.5, toe: 0.0,
    lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1],
    saturation: 1.0, contrast: 1.0, curve: 0.05, temperature: 0.0,
    shadowTint: [0, 0, 0], highlightTint: [0, 0, 0], split: 0.0,
    lookSlope: [1, 1, 1], lookPower: [1, 1, 1], lookSat: 1.0,
  },
  /*
   * The house look: bleached ochre highlights, cold slate shadows.
   *
   * The warm bias here is deliberately MILD. AgX already walks saturated colour
   * toward white as it brightens, so a strong global warm push (pass 1 ran gain
   * 1.045R/0.945B plus temperature 0.055 plus a +0.030R/-0.026B highlight tint,
   * ~15% red over blue in total) does not read as "warm film", it reads as the
   * blue channel being deleted — and it is what turned a measurably blue sky
   * (linear B/R = 1.68) into a warm-neutral one (display B/R = 1.08) and put a
   * negative B-R on distant terrain in six of seven daylight shots. The warmth
   * now lives almost entirely in the highlight tint, where sunlight actually is.
   *
   * INTEGRATION PASS 10 — the shadow tints no longer DELETE RED.
   *
   * They were authored as a negative-red / positive-blue pair, which is a
   * correct instinct (a cool shadow really is B-over-R) applied through the
   * wrong operator. The split-tone weight is (1-l)^2, so the full tint lands on
   * the darkest pixels in the frame — and those pixels have almost nothing in
   * the red channel to take away. Measured on forest_interior at 1920x1080:
   * the shadowed forest floor sat at rgb (0.035, 0.065, 0.105), i.e. blue was
   * 3.0x red and the SATURATION of bare ground in shade was 0.80. That is not
   * a cool shadow, it is electric navy, and it is the "saturated cartoon"
   * failure mode in §5 arriving from the shadow end instead of the grass end.
   * Zeroing the red term alone took it to (0.054, 0.077, 0.096), saturation
   * 0.63, with the floor reading as damp earth again.
   *
   * The blue terms are raised to hold the same B-R separation each preset was
   * authored for, so the LOOK — cool shadow against a warm key — is unchanged.
   * What changes is that the coolness is now made of blue being added rather
   * than red being destroyed, which is what keeps a dark pixel neutral-dark
   * instead of chromatic.
   */
  /*
   * PASS 11 — the curve was over-steepened and it cost the whole set its colour.
   *
   * `latitude` and `toe` together ARE the transfer function, and pass 10 pushed
   * both: 16.5 -> 13.5 stops and a 0.030 display-space foot on top. Measured
   * against pass 9 on the same ten frames, that combination
   *   - crushed the shadows. town_street's p0.1 luma fell 0.150 -> 0.078 and its
   *     awning shadow rendered as a hard black slab; player_third_person fell
   *     0.046 -> 0.005, i.e. one per cent of the frame went to literal zero.
   *   - and desaturated everything. Mean CIELAB chroma fell on all ten shots
   *     (dawn 12.1 -> 9.0, golden_hour 11.5 -> 8.2, player 7.0 -> 5.4). A
   *     steeper per-channel sigmoid walks colour toward white FASTER as it
   *     climbs, so a narrower latitude bleaches the highlights harder — and in
   *     a landscape the sunlit half of the frame is where the colour lives.
   *
   * The latitude is now 14.6, roughly halfway back, and the toe is a third of
   * what it was: the frame keeps most of the density and contrast pass 10 won
   * without turning shadows into holes. The hdr_headroom win does NOT depend on
   * this number — it comes from the adaptive white point in `film`, which sets
   * the display value that maps to 255 from the frame's own metered peak — so
   * the curve can be relaxed without giving that back.
   *
   * The warmth is put back where §5 wants it: in the key. Temperature and the
   * highlight tint both go up, the shadow tint stays cool blue, so the frame
   * reads warm-key-against-cool-shadow rather than uniformly warm.
   */
  western: {
    latitude: 14.6, toe: 0.012,
    lift: [0.001, 0.002, 0.008], gamma: [1.0, 1.002, 1.010], gain: [1.013, 1.002, 0.994],
    saturation: 1.00, contrast: 1.06, curve: 0.06, temperature: 0.030,
    shadowTint: [0.000, 0.004, 0.026], highlightTint: [0.034, 0.014, -0.004], split: 1.0,
    lookSlope: [1.0, 0.997, 0.984], lookPower: [1.03, 1.03, 1.05], lookSat: 1.11,
  },
  goldenHour: {
    latitude: 14.2, toe: 0.014,
    lift: [0.001, 0.002, 0.009], gamma: [0.998, 1.000, 1.014], gain: [1.017, 1.003, 0.990],
    saturation: 1.00, contrast: 1.06, curve: 0.07, temperature: 0.044,
    shadowTint: [0.000, 0.005, 0.034], highlightTint: [0.043, 0.018, -0.006], split: 1.0,
    lookSlope: [1.0, 0.995, 0.978], lookPower: [1.03, 1.03, 1.05], lookSat: 1.10,
  },
  night: {
    latitude: 16.2, toe: 0.006,
    lift: [0.003, 0.006, 0.015], gamma: [1.02, 1.005, 0.990], gain: [0.88, 0.980, 1.055],
    saturation: 0.52, contrast: 1.02, curve: 0.05, temperature: -0.12,
    shadowTint: [0.000, 0.003, 0.022], highlightTint: [0.004, 0.010, 0.012], split: 1.0,
    lookSlope: [0.96, 0.99, 1.03], lookPower: [1.0, 1.0, 1.0], lookSat: 0.85,
  },
  storm: {
    latitude: 15.0, toe: 0.010,
    lift: [0.001, 0.003, 0.007], gamma: [1.005, 1.0, 0.998], gain: [0.978, 0.990, 1.012],
    saturation: 0.92, contrast: 1.03, curve: 0.05, temperature: -0.038,
    shadowTint: [0.000, 0.002, 0.019], highlightTint: [0.004, 0.008, 0.014], split: 1.0,
    lookSlope: [1, 1, 1], lookPower: [1.02, 1.02, 1.02], lookSat: 0.9,
  },
  dust: {
    latitude: 14.8, toe: 0.010,
    lift: [0.002, 0.002, 0.003], gamma: [0.995, 1.0, 1.014], gain: [1.045, 1.0, 0.930],
    saturation: 0.84, contrast: 1.0, curve: 0.05, temperature: 0.14,
    shadowTint: [0.006, 0.0, -0.004], highlightTint: [0.040, 0.016, -0.028], split: 1.0,
    lookSlope: [1.02, 1.0, 0.94], lookPower: [1.0, 1.0, 1.02], lookSat: 0.9,
  },
  sepia: {
    latitude: 14.0, toe: 0.030,
    lift: [0.003, 0.002, 0.001], gamma: [1, 1, 1], gain: [1.08, 1.0, 0.86],
    saturation: 0.35, contrast: 1.0, curve: 0.08, temperature: 0.18,
    shadowTint: [0.004, 0.0, -0.008], highlightTint: [0.045, 0.020, -0.040], split: 1.0,
    lookSlope: [1, 1, 1], lookPower: [1, 1, 1], lookSat: 0.6,
  },
  underwater: {
    latitude: 15.5, toe: 0.012,
    lift: [0.0, 0.004, 0.005], gamma: [1.04, 0.99, 0.98], gain: [0.80, 1.03, 1.06],
    saturation: 0.75, contrast: 1.0, curve: 0.05, temperature: -0.18,
    shadowTint: [0.000, 0.010, 0.036], highlightTint: [-0.01, 0.01, 0.02], split: 1.0,
    lookSlope: [0.9, 1.0, 1.02], lookPower: [1, 1, 1], lookSat: 0.85,
  },
};

function asVec3(v, out) {
  if (v == null) return out;
  if (typeof v === 'number') return out.set(v, v, v);
  if (Array.isArray(v)) return out.set(v[0], v[1], v[2]);
  if (v.isColor) return out.set(v.r, v.g, v.b);
  if (v.isVector3) return out.copy(v);
  return out;
}

/** Weather name → (preset, weight) for the automatic look selector. */
const WEATHER_LOOK = {
  storm: ['storm', 1.0], rain: ['storm', 0.85], overcast: ['storm', 0.5],
  fog: ['storm', 0.35], snow: ['storm', 0.55], dust: ['dust', 1.0],
};

function blendPreset(a, b, t, out = {}) {
  for (const k in a) {
    const av = a[k], bv = b[k];
    if (Array.isArray(av)) {
      const o = out[k] && Array.isArray(out[k]) ? out[k] : (out[k] = [0, 0, 0]);
      o[0] = av[0] + (bv[0] - av[0]) * t;
      o[1] = av[1] + (bv[1] - av[1]) * t;
      o[2] = av[2] + (bv[2] - av[2]) * t;
    } else {
      out[k] = av + (bv - av) * t;
    }
  }
  return out;
}

function cloneGrade(g) {
  return {
    lift: V3(...g.lift), gamma: V3(...g.gamma), gain: V3(...g.gain),
    latitude: g.latitude, toe: g.toe,
    saturation: g.saturation, contrast: g.contrast, curve: g.curve, temperature: g.temperature,
    shadowTint: V3(...g.shadowTint), highlightTint: V3(...g.highlightTint), split: g.split,
    lookSlope: V3(...g.lookSlope), lookPower: V3(...g.lookPower), lookSat: g.lookSat,
  };
}

/* ================================================================= PostFX */

/**
 * The whole frame passes through here.
 *
 *   scene → HDR RGBA16F (+ float depth, TAA-jittered projection)
 *     → motion vectors (RG16F, camera + registered movers)
 *     → GTAO  (half res, denoise + temporal)
 *     → volumetric scattering / height fog (half res, shadowed, temporal)
 *     → SSR   (half res, roughness aware, sky fallback)
 *     → lighting composite
 *     → TAA   (Catmull-Rom history, YCoCg variance clipping)
 *     → auto exposure metering
 *     → depth of field (physical CoC, hexagonal gather)
 *     → motion blur (tile-max / neighbour-max reconstruction)
 *     → bloom (13-tap down w/ Karis, tent up)
 *     → AgX tonemap, grade, halation, vignette, grain, CA → canvas
 */
export class PostFX {
  static id = 'postfx';

  constructor(ctx) {
    this.ctx = ctx;
    this.renderer = ctx.renderer;

    /** @type {THREE.DepthTexture|null} scene depth — contract surface. */
    this.depthTexture = null;
    /** @type {THREE.Texture|null} RG16F motion vectors — contract surface. */
    this.velocityBuffer = null;
    /** @type {THREE.Texture|null} 1x1 RGBA32F: r=exposure, g=focus, b=avg luma. */
    this.exposureTexture = null;

    this._ready = false;
    this._frame = 0;
    this._size = new THREE.Vector2(1, 1);

    // matrices
    this._proj = new THREE.Matrix4();
    this._projJit = new THREE.Matrix4();
    this._view = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    this._prevViewProj = new THREE.Matrix4();
    this._invViewProj = new THREE.Matrix4();
    this._invProj = new THREE.Matrix4();
    this._camRot = new THREE.Matrix3();
    this._jitterUV = new THREE.Vector2();
    this._prevJitterUV = new THREE.Vector2();
    this._hasHistory = false;

    // dynamic movers for per-object motion vectors
    this._dynamic = new Set();
    this._prevMatrices = new WeakMap();

    // camera shake
    const r = rng((ctx.seed ^ 0x51ac1e) >>> 0);
    this._shakes = [];
    this._shakePhase = [];
    for (let i = 0; i < 9; i++) this._shakePhase.push(r() * Math.PI * 2);
    this._shakeOffset = new THREE.Vector3();
    this._shakeQuat = new THREE.Quaternion();
    this._shakeApplied = false;
    this._shakeEuler = new THREE.Euler();

    // tunables
    this.atmosphere = {
      /** Multiplier on env.fogDensity for the shaft medium only. */
      densityScale: 2.2,
      heightFalloff: 340,
      /* ------------------------------------------------------- aerosol layer
       * The medium that actually carries the god rays and the near-field
       * aerial perspective. See the header of Atmosphere.js for why it had to
       * exist: the old pass could only subtract, against an optical depth of
       * 0.05, so no shaft in the build was above the grain floor.
       *
       * `hazeDensity` is extinction per metre AT THE VALLEY FLOOR in clear
       * midday air. 4.2e-4 /m gives a Koschmieder visual range of ~9 km along
       * the floor and ~24 km along a ray that climbs out of the layer, which
       * is right for high dry country and is what puts a measurable
       * lighter/bluer/flatter trend on distant terrain.
       *
       * `hazeHeight` is the scale height in metres. It is LOW on purpose:
       * this is the layer that has to pool in hollows and let ridges stand
       * clear of it, and that separation is the whole layered look. Sky's own
       * boundary haze runs H ~ 600 m and is smooth, so the two do not overlap.
       */
      /*
       * INTEGRATION PASS 10 — 7.0e-4 was double-counting against Sky.
       *
       * Measured on the pass-9+7-agent build at 1920x1080: the far terrain band
       * in player_third_person sat at luma 0.741 against a sky band of 0.744,
       * and golden_hour_vista's mid-valley at 0.555 against 0.567. Distant
       * terrain had been replaced by airlight to within 0.4%, i.e. the ridge
       * WAS the sky and there was no silhouette left to read. That is the
       * saturation limit of this tail (tau clamped at farTauMax = 2.6 gives
       * transmittance 0.074) stacking on top of Sky's aerial perspective, which
       * had already applied its own full in-scattering solution to the same
       * fragment. Two independent airlights, both driven toward the horizon sky
       * colour, sum to "everything distant is the sky".
       *
       * 4.0e-4 with farTauMax 0.85 (transmittance 0.43) leaves the far ridge
       * with 43% of its own radiance, which is enough for the lit faces, the
       * gullies and the treeline to survive. golden_hour_vista goes from one
       * milky wall to the three separated planes the reference is built on.
       * Sky keeps ownership of the long-range solution; this layer is back to
       * being the near-field correction its own header says it is.
       */
      hazeDensity: 0.00040,
      hazeHeight: 78,
      /** Aerosol thickens at dawn and dusk (humidity, smoke, settled dust). */
      hazeTwilight: 1.15,
      /** Weight of env.groundMist on the aerosol, on top of the mist banks. */
      hazeMist: 1.9,
      /** Single-scattering albedo. Dust is not quite white. */
      hazeAlbedo: 0.90,
      /** Fraction of the key that reaches shadowed air by multiple scattering. */
      hazeLeak: 0.06,
      /**
       * Gain on the DIRECTIONAL half of the in-scatter only.
       *
       * This is the control that separates "how bright are the shafts" from
       * "how much does the air veil the frame", and it exists because those two
       * are the same number in a single-scattering integral and they must not
       * be. Veiling in shadowed air is ambient-dominated (the ambient term is
       * 3-10x the key term at 90 degrees from the sun); shaft brightness is
       * key-dominated (the HG peak is 30x the 90-degree value). Raising only
       * the key term therefore brightens the rays and leaves the haze alone.
       * Physically it stands in for the forward multiple scattering a single-
       * scatter HG integral throws away, which in a turbid boundary layer is
       * about this size.
       */
      hazeKeyGain: 1.9,
      /**
       * Weight of the airlight source inside the march (the aerosol's ambient
       * in-scatter), and of the direct sun term in the analytic far tail.
       * `farSun` is deliberately low: past the last cascade the medium is
       * unshadowed, so there are no shafts left to carry and the single-scatter
       * sun peak would simply paint the far field the colour of the sun.
       */
      nearAirlight: 0.24,
      farSun: 0.08,
      /** Airlight at the far end as a fraction of the horizon sky radiance. */
      farBrightness: 0.92,
      /**
       * How far the airlight is walked from the horizon sky colour toward a
       * cool blue-grey, at constant luminance. This is the single control on
       * the measured aerial_perspective_hue gradient.
       */
      farBlue: 0.95,
      /** Ceiling on the analytic far-tail length, metres. */
      farMax: 9000,
      /**
       * Ceiling on the far tail's optical depth — the far ridge must survive.
       * 2.6 did not let it survive: see the note on hazeDensity. 0.85 is the
       * measured point at which the ridge keeps a readable silhouette against
       * the sky while still lifting, cooling and flattening with distance.
       */
      farTauMax: 0.85,
      /** Window depth at/above which a pixel counts as sky. See Atmosphere.js. */
      skyDepth: 0.999999,
      /**
       * Ambient in-scatter source, as a fraction of Sky's hemispherical
       * irradiance. The source function of an isotropic field is its RADIANCE,
       * ~E/pi, not its irradiance — the old code fed E straight in, which is
       * pi times too bright and is why any mist at all read as a flat sheet.
       */
      ambientScale: 0.34,
      /** Distance warp of the raymarch steps: 0 = all at the camera, 1 = uniform. */
      stepWarp: 0.32,
      /* ------------------------------------------------------- second bank */
      /** Height of the elevated mist stratum above the band-0 ceiling, metres. */
      band2Offset: 30,
      band2Thickness: 10,
      band2Amount: 0.60,
      /**
       * Ground mist: extinction per metre at the core of the layer, at
       * env.groundMist = 1. Weather's dawn value is 0.17, and the response is
       * sqrt() (see _atmosphereInto), so dawn_mist_valley runs at ~0.005/m —
       * a ~780 m visual range inside the layer, which reads as banks of mist
       * with the far side of the valley still visible through them. 0.012 at
       * full strength is a genuine pea-souper.
       */
      mistDensity: 0.012,
      /** Layer ceiling, metres above the local valley floor (see _updateMistLayer). */
      /*
       * Ceiling of the mist lake, metres above the valley floor.
       *
       * 11 m put the ceiling at 44.7 m in dawn_mist_valley while the camera
       * stands at 58 m and the visible ground runs 40-70 m — the entire layer
       * sat below the shot. That is the "dawn_mist_valley has no mist" defect
       * in its second form: the layer existed, it was just under the floor of
       * the frame. 24 m puts the top of the bank just under the camera, which
       * is where a radiation fog on a valley shoulder actually sits and is the
       * framing every reference dawn shot uses.
       */
      mistHeight: 24,
      mistThickness: 13,
      mistAmbientScale: 1.0,
      /** 0..1 fbm break-up of the layer, so it reads as banks not a bedsheet. */
      mistNoise: 0.75,
      /** Floor on mist transmittance — the scene may never vanish entirely. */
      mistMinTransmittance: 0.10,
      mistNoiseScale: 90,
      /** Half-extent, metres, of the terrain probe that finds the valley floor. */
      sampleRadius: 700,
      mieG: 0.62,
      /**
       * Magnitude of the shaft term relative to our estimate of the key light's
       * single scattering through the medium. Must stay <= 1: the term is a
       * SUBTRACTION of light Sky already added, so anything above 1 removes more
       * in-scatter than exists and punches black holes in shadowed air.
       */
      beamStrength: 0.85,
      /**
       * Visibility at which the shaft term is neutral.
       *
       * INTEGRATION NOTE — this must be 1.0. Sky's aerial perspective already
       * applies the FULL, UNSHADOWED in-scattering solution to every fragment,
       * so this pass may only contribute the delta between that and the real,
       * shadowed medium: `(vis - 1) <= 0`. With shadowBase at 0 the pass instead
       * re-added the whole unshadowed single-scattering term a second time —
       * measured at high noon it was laying ~0.30 linear of flat additive veil
       * over the entire frame (a sunlit 42%-albedo ground sits at ~0.72), which
       * is what greyed out every vista, lifted the night shots to a uniform
       * fog, and drove the auto-exposure into blowing out the sky.
       *
       * Shafts still read correctly: unshadowed air keeps Sky's in-scatter while
       * the air behind a ridge loses it, which is exactly what a light shaft is.
       */
      shadowBase: 1.0,
      maxDistance: 2200,
    };
    this.dof = { enabled: true, focusDistance: null, aperture: 5.6, bokehScale: 1.0 };
    /**
     * Shutter model for motion blur. See the header of `motionBlurMaterial`.
     *
     * `shutter` is the fraction of the frame interval the shutter is open
     * (0.5 = a 180-degree shutter). `referenceDt` is the frame time that
     * fraction is quoted at: the scale actually uploaded is
     * `shutter * min(1, referenceDt / dt)`, so the streak stays a fixed
     * EXPOSURE rather than a fixed fraction of however long the frame took —
     * a 30 fps hitch used to double the smear on top of everything else.
     * `maxScreenFraction` is the hard ceiling on the streak as a fraction of
     * frame height, so it means the same thing at 720p and at 4K.
     */
    /*
     * Measured on the over-the-shoulder ride (12 m/s + a 21 deg/s turn), as the
     * fraction of the STATIONARY frame's ground gradient energy that survives
     * one moving frame — 1.00 would be no blur at all:
     *
     *   pass 3 (shutter 0.50, 34 px flat)   0.544   <- the reported bug
     *   shutter 0.32, 1.25% of height       0.645
     *   shutter 0.30, 0.75% of height       0.678   <- shipped
     *   motion blur disabled entirely       0.833   <- the ceiling; whatever is
     *                                                 left is TAA plus the
     *                                                 content genuinely moving
     *
     * So the pass now costs 16 points of ground acuity where it cost 29, and
     * what is left reads as a directional streak along the flow rather than as
     * a frame-wide loss of detail. Do not chase the ceiling: some blur is the
     * point, and at 0.30/0.0075 a gallop still looks like a gallop.
     */
    this.motionBlur = {
      enabled: true,
      shutter: 0.30,
      maxScreenFraction: 0.0075,
      referenceDt: 1 / 60,
    };
    this.film = {
      bloom: 0.20, halation: 0.075, chromatic: 0.0010, vignette: 0.30,
      // Tuned against the measurement the forensic pass actually makes: the
      // high-frequency residual std in a flat sky patch. Pass 2 measured 1.0
      // (pure 8-bit quantisation, i.e. no grain); this lands ~1.8-2.0 levels,
      // which reads as film without becoming visible noise.
      grain: 0.040, exposureBias: 1.0,
      /**
       * Exposure-relative bloom threshold.
       *
       * Pass 2 pushed this to 2.6 to stop three sunlit cumulus reading as three
       * suns — but the cause of that was the clouds clipping to flat white, not
       * the bloom, and the cure sat the threshold above the auto-exposure's own
       * highlight ceiling (uHighlightCeil 2.9, i.e. the brightest sixteenth of
       * the frame is held at ~2.9), so essentially nothing in a daylight frame
       * could bloom at all. Every forensic report then measured "no bloom, no
       * specular glint anywhere". 1.9 with a wide knee puts the onset just
       * above a sunlit diffuse surface and below a specular glint or an
       * emitter, which is where it belongs.
       */
      bloomThreshold: 1.9,
      bloomKnee: 0.7,
      /** CAS strength applied in the final pass — the resolve half of TAA. */
      sharpen: 0.5,
      /** Ambient-occlusion strength in the composite. */
      aoStrength: 1.0,
      /** Metering weight applied to pixels the depth buffer says are sky. */
      skyMeterWeight: 0.07,
      /**
       * Ceiling on the auto-exposure, interpolated by `ctx.env.daylight`.
       * See the comment at the metering call site — this is what stops the
       * log-average from renormalising every scene to the same mid grey.
       * Measured open-daylight shots meter at 0.68-2.05. 2.4 gives a shaded
       * frame about a quarter stop of headroom over the brightest open one and
       * is what finally let storm_plains and forest_interior be dark; night_camp and
       * moonlit_ridge meter at 19 (pinned) and 6.96.
       */
      maxExposureDay: 2.4,
      maxExposureNight: 8.5,
      /**
       * Display-space highlight shoulder: linear below K, reaches pure white at
       * K + W, clips above.
       * The asymptote is deliberately just above 1.0 so that a genuine emitter
       * (the sun disc, a muzzle flash) can still reach white, while everything
       * AgX + the grade leave at 1.0-1.1 — sunlit cloud tops, snow, water
       * specular — lands around 0.93 and keeps its internal gradient instead of
       * flattening into a solid blob with a bloom halo on it.
       *
       * `shoulderHeadroom` is now the INPUT WIDTH above `shoulder` that maps to
       * pure white, not an asymptote — see highlightShoulder() in Grade.js. The
       * brightest display value AgX + the grade can produce is ~1.10, so 0.80 +
       * 0.30 puts true white exactly at the top of the transform's range: a
       * pixel that saturates AgX (the sun disc, a muzzle flash, a fire core)
       * clips to 255 while a sunlit cloud top at 0.95 still keeps its gradient.
       */
      /* Headroom 0.28 -> 0.36: the shoulder starts compressing earlier, so a
       * sunlit cloud top spends more of its range inside a rolling curve
       * instead of arriving at the knee already near white. */
      shoulder: 0.82, shoulderHeadroom: 0.36,
      /**
       * ADAPTIVE WHITE POINT — see the block comment at the call site in
       * Grade.js. `whiteAdapt` 0 restores the old fixed white point exactly.
       *
       * The white point (the pre-shoulder display value that maps to 255) is
       * placed where the frame's own metered PEAK lands on the tone curve,
       * clamped at both ends. So a
       * frame that contains something genuinely bright keeps the full shoulder,
       * and a frame whose brightest pixel is two and a half stops short of
       * white — a hazy noon desert with no sun disc and no specular — has its
       * white point brought down to meet it instead of rendering with a maximum
       * channel of 232.
       */
      whiteAdapt: 1.0,
      /**
       * wp = clamp(curve(peak) * whiteGain, whiteMin, shoulder + headroom),
       * where curve() is the tone curve itself evaluated on the neutral axis.
       * whiteGain is the only fitted number and it is small: the metered peak
       * is a luminance, the value that has to reach 255 is a channel.
       */
      /* 1.22 -> 1.12, and whiteMin 0.96 -> 0.90.
       * The white point now sits slightly BELOW where the metered peak lands on
       * the curve rather than above it, which is the opposite of the pass-10
       * setting and is only safe because the shoulder above the white point is
       * strictly monotone (see highlightShoulder in Grade.js). Under the old
       * curve everything past the white point collapsed onto one value, so the
       * white point had to be kept clear of the scene; with an asymptotic tail
       * the frame's brightest pixels sit ON the tail, keep their ordering, and
       * still reach 255 — while the shoulder itself, which now starts 0.36
       * below the white point instead of 0.28, has room to roll the broad
       * bright areas off well under the 0.965 the blob detector watches. */
      whiteGain: 1.12,
      whiteMin: 0.90,
    };

    this._grade = cloneGrade(GRADES.western);
    this._gradeTarget = cloneGrade(GRADES.western);
    this._gradeBlend = 3.5;
    /** Pick the look from time of day + weather until setGrade() is called. */
    this.autoGrade = true;
    this._lookA = {};
    this._lookB = {};

    this._mistY = 0;
    this._exposureCPU = 1.0;
    this._readBuf = new Float32Array(4);
    this._readOk = true;
  }

  /* --------------------------------------------------------------- init */

  async init() {
    const ctx = this.ctx;
    const q = ctx.quality;
    const r = this.renderer;

    /*
     * A TELEPORT IS A CAMERA CUT — drop every temporal history.
     *
     * TAA runs at 0.87-0.90 feedback, motion blur reprojects through
     * _prevViewProj, and the auto-exposure adapts exponentially towards its
     * target. None of that survives the camera being moved kilometres in one
     * frame, and none of it was being invalidated: the capture harness calls
     * setupShot() (which emits 'teleport') and then renders a fixed 150 frames,
     * so each shot inherited the previous shot's exposure and ghosting.
     *
     * That is not a cosmetic issue. In the pass-2 capture, storm_plains follows
     * night_camp, whose auto-exposure sits at ~11.8; 2.5 s of adaptation was
     * not enough to fall to storm's ~2.4, so the shot came out a flat white
     * wash — and shooting the SAME camera on its own produced a perfectly
     * readable frame. Screenshots are required to be reproducible frame-for-
     * frame (CONTRACTS §1.4), and order-dependent exposure breaks that.
     *
     * Clearing _hasHistory takes the paths that already exist for the first
     * frame after a resize: exposure snaps to its metered target (uFirst),
     * TAA feedback goes to 0, and velocity reprojects against the current
     * matrix instead of a stale one.
     */
    ctx.on('teleport', () => { this._hasHistory = false; });

    this.quad = new FullScreenQuad(r);
    this.blueNoise = makeBlueNoise((ctx.seed ^ 0xb10e) >>> 0, 64, 45000);

    this._black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this._black.needsUpdate = true;
    // Neutral stand-ins. The composite reads AO from .r (1 = unoccluded) and
    // blends SSR by .a, so an opaque-black fallback is NOT neutral for either:
    // it crushes the frame to 45% through the AO path and paints the scene flat
    // black through the SSR path. Only tVolume is genuinely neutral at black.
    this._white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this._white.needsUpdate = true;
    this._clear = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    this._clear.needsUpdate = true;

    this._jitterPattern = haltonSequence(q.taa ? 16 : 1);

    // ---- passes
    this.mVelocity = velocityMaterial();
    this.mVelocityObj = velocityObjectMaterial();

    this.useAO = !!q.ssao;
    this.useVol = !!q.volumetrics && q.volumetricSteps > 0;
    this.useSSR = !!q.ssr;
    this.useTAA = !!q.taa;
    this.useDOF = !!q.dof;
    this.useMB = !!q.motionBlur;
    this.useBloom = q.bloom !== false;

    if (this.useAO) {
      /*
       * 3x8 = 24 horizon samples at half res was 1.0-2.5 ms depending on shot.
       * The pass is followed by a separable bilateral denoise AND a temporal
       * accumulate at 0.9 feedback, so 3x5 converges to the same field within a
       * few frames; what more raw samples buy is faster convergence under
       * motion, which is the one thing the temporal filter is already for.
       */
      const slices = q.name === 'ultra' ? 3 : 2;
      const steps = q.name === 'ultra' ? 5 : (q.name === 'high' ? 4 : 3);
      this.mGTAO = gtaoMaterial(slices, steps);
      this.mAODenoise = aoDenoiseMaterial();
      this.mAOTemporal = aoTemporalMaterial();
    }

    this._shadowKey = 'none';
    /**
     * Raymarch step budget. The quality preset asks for 80 at ultra; with
     * blue-noise offsetting plus the temporal filter, 56 is visually identical
     * and the pass is 30% cheaper — which matters because it is the single most
     * expensive thing in the frame the moment there is any mist in the shot.
     */
    /*
     * 36 uniform steps became 26 WARPED steps. A uniform march spends the same
     * number of samples on the 400 m of far air nothing can resolve as on the
     * 40 m of mist bank in front of the camera; warping the distribution
     * (uWarp, see Atmosphere.js) puts dt ~ 8 m at the near plane and ~38 m at
     * the far end, which resolves the near field better than 36 uniform steps
     * did. The 28% cut in loop iterations is what pays for the extra per-step
     * work of the real scattering integral — the shadow lookup inside the loop
     * is the single most expensive instruction sequence in the pass.
     */
    /* INTEGRATION PASS 10 — preset-relative, for the same reason as the cloud
     * step count (see Clouds.init): volumetricSteps is 24 / 48 / 80 for medium
     * / high / ultra and a flat min(_, 26) mapped high and ultra to the same
     * 26, so the 'high' preset bought nothing from the second-most-expensive
     * pass in the build. Ultra keeps the 26 warped steps every image in this
     * pass was judged at. */
    const vq = q.volumetricSteps | 0;
    this._volSteps = Math.min(vq, vq >= 72 ? 26 : (vq >= 40 ? 21 : 18));
    if (this.useVol) {
      this.mVolume = volumetricMaterial(this._volSteps, null);
      this.mVolumeTemporal = volumetricTemporalMaterial();
    }
    if (this.useSSR) {
      this.mSSR = ssrMaterial(q.name === 'ultra' ? 18 : 14);
    }

    this.mComposite = compositeMaterial({ ao: this.useAO, ssr: this.useSSR, volume: this.useVol });
    if (this.useTAA) this.mTAA = taaMaterial();

    if (this.useDOF) {
      this.mDofPrepare = dofPrepareMaterial();
      this.mDofDilate = dofNearDilateMaterial();
      this.mDofGather = dofGatherMaterial(q.name === 'ultra' ? 16 : 12);
      this.mDofComposite = dofCompositeMaterial();
    }
    if (this.useMB) {
      this.TILE = 20;
      this.mTileMax = tileMaxMaterial(this.TILE);
      this.mNeighborMax = neighborMaxMaterial();
      this.mMotionBlur = motionBlurMaterial(q.name === 'ultra' ? 12 : 8);
    }
    if (this.useBloom) {
      /*
       * The chain now starts at quarter resolution rather than half. Bloom is
       * six successive blurs of a thresholded image; starting one octave down
       * removes the most expensive level entirely (it alone was as costly as
       * the other five combined) and cannot change the result above the
       * spatial frequency the second level already discards. Halation taps
       * shift down one index with it so the coloured rings keep their radius.
       */
      this.BLOOM_MIPS = 5;
      this.mBloomPre = bloomPrefilterMaterial();
      this.mBloomDown = bloomDownMaterial();
      this.mBloomUp = bloomUpMaterial();
    }
    this.mLogLuma = logLumaMaterial();
    this.mBoxDown = boxDownMaterial();
    this.mExposure = exposureAdaptMaterial();
    this.mFinal = finalMaterial();
    this.mCopy = copyMaterial();

    if (PROFILE) prof.attach(r.getContext());

    const size = r.getDrawingBufferSize(new THREE.Vector2());
    this._allocate(Math.max(2, size.x), Math.max(2, size.y));

    this._applyGradeUniforms(1);
    this._ready = true;
  }

  /* ---------------------------------------------------------- allocation */

  /**
   * Bloom mip dimensions, CHAINED and rounded UP.
   *
   * They used to be derived independently from the drawbuffer as
   * `w >> (i + 2)`, which floors each level against the ORIGINAL size instead
   * of against its own parent. At 1080p that gives heights 270, 135, 67, 33:
   * level 2 is 67 tall but level 3 is 33, and 2 x 33 = 66. The 3x3 tent
   * upsample assumes its source is exactly half its destination, so every
   * level it climbs it lands about half a texel higher than the last, and the
   * error accumulates down the chain. On a small, very bright source — the sun
   * disc under the storm deck, the campfire core — each mip therefore
   * contributes a copy at a slightly different vertical offset, which is
   * exactly the beaded vertical white column that appeared in storm_plains.
   * The widths (1920 = 2^7 x 15) divided exactly, which is why the artifact
   * was vertical and not horizontal, and 720p truncates one level later, which
   * is why it was invisible there.
   *
   * ceil-chaining makes every level exactly ceil(parent / 2) in both axes, so
   * a 2x upsample lands on the grid it came from at every resolution.
   *
   * @returns {Array<[number, number]>} one [w, h] per mip, mip 0 at quarter res
   */
  static _bloomSizes(w, h, mips) {
    const out = [];
    // mip 0 is quarter res: the prefilter reduces 4x in one pass.
    let bw = Math.max(1, Math.ceil(Math.ceil(w / 2) / 2));
    let bh = Math.max(1, Math.ceil(Math.ceil(h / 2) / 2));
    for (let i = 0; i < mips; i++) {
      out.push([bw, bh]);
      bw = Math.max(1, Math.ceil(bw / 2));
      bh = Math.max(1, Math.ceil(bh / 2));
    }
    return out;
  }

  _resizeRT(rt, w, h) {
    if (!rt) return;
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    if (rt.width === w && rt.height === h) return;
    if (rt.depthTexture) {
      rt.depthTexture.image.width = w;
      rt.depthTexture.image.height = h;
      rt.depthTexture.needsUpdate = true;
    }
    rt.setSize(w, h);
  }

  _allocate(w, h) {
    const first = !this.sceneRT;
    this._size.set(w, h);
    const hw = Math.max(1, Math.ceil(w / 2));
    const hh = Math.max(1, Math.ceil(h / 2));
    /*
     * QUARTER-RES VOLUMETRICS. The in-scatter integral is a very low-frequency
     * field — that is why it can be temporally accumulated at 0.87 feedback in
     * the first place — and the composite resolves it through a depth-aware
     * bilateral upsample, so the only thing that survives a resolution drop is
     * a slightly softer edge on a light shaft. Quarter res is what shipping
     * engines use for this pass; it was the last 2.7 ms item in the frame.
     */
    const qw = Math.max(1, Math.ceil(w / 4));
    const qh = Math.max(1, Math.ceil(h / 4));
    const HF = THREE.HalfFloatType;

    if (first) {
      this.sceneRT = makeRT(w, h, { type: HF, depth: true });
      const dt = new THREE.DepthTexture(w, h, THREE.FloatType);
      dt.format = THREE.DepthFormat;
      dt.minFilter = THREE.NearestFilter;
      dt.magFilter = THREE.NearestFilter;
      dt.generateMipmaps = false;
      dt.compareFunction = null;
      this.sceneRT.depthTexture = dt;
      this.depthTexture = dt;

      this.velRT = makeRT(w, h, { type: HF, format: THREE.RGFormat, min: THREE.NearestFilter, mag: THREE.NearestFilter });
      this.velocityBuffer = this.velRT.texture;

      this.hdrA = makeRT(w, h, { type: HF });
      this.hdrB = makeRT(w, h, { type: HF });

      if (this.useTAA) {
        this.taaHist = [makeRT(w, h, { type: HF }), makeRT(w, h, { type: HF })];
        this._taaIdx = 0;
      }
      if (this.useAO) {
        this.aoRT = makeRT(hw, hh, { type: HF, format: THREE.RGFormat });
        this.aoRT2 = makeRT(hw, hh, { type: HF, format: THREE.RGFormat });
        this.aoHist = [makeRT(hw, hh, { type: HF, format: THREE.RGFormat }), makeRT(hw, hh, { type: HF, format: THREE.RGFormat })];
        this._aoIdx = 0;
      }
      if (this.useVol) {
        this.volRT = makeRT(qw, qh, { type: HF });
        this.volHist = [makeRT(qw, qh, { type: HF }), makeRT(qw, qh, { type: HF })];
        this._volIdx = 0;
      }
      if (this.useSSR) this.ssrRT = makeRT(hw, hh, { type: HF });
      if (this.useDOF) {
        this.dofPrepRT = makeRT(hw, hh, { type: HF });
        this.dofNearA = makeRT(hw, hh, { type: HF, format: THREE.RedFormat });
        this.dofNearB = makeRT(hw, hh, { type: HF, format: THREE.RedFormat });
        this.dofGatherRT = makeRT(hw, hh, { type: HF, count: 2 });
      }
      if (this.useMB) {
        const tw = Math.max(1, Math.ceil(w / this.TILE));
        const th = Math.max(1, Math.ceil(h / this.TILE));
        this.tileA = makeRT(tw, h, { type: HF, format: THREE.RGFormat, min: THREE.NearestFilter, mag: THREE.NearestFilter });
        this.tileB = makeRT(tw, th, { type: HF, format: THREE.RGFormat, min: THREE.NearestFilter, mag: THREE.NearestFilter });
        this.tileN = makeRT(tw, th, { type: HF, format: THREE.RGFormat, min: THREE.NearestFilter, mag: THREE.NearestFilter });
      }
      if (this.useBloom) {
        this.bloomRT = [];
        for (const [bw, bh] of PostFX._bloomSizes(w, h, this.BLOOM_MIPS)) {
          this.bloomRT.push(makeRT(bw, bh, { type: HF }));
        }
      }
      this.lumaRT = [
        makeRT(64, 64, { type: HF }),
        makeRT(16, 16, { type: HF }),
        makeRT(4, 4, { type: HF }),
        makeRT(1, 1, { type: HF }),
      ];
      this.expoRT = [
        makeRT(1, 1, { type: THREE.FloatType, min: THREE.NearestFilter, mag: THREE.NearestFilter }),
        makeRT(1, 1, { type: THREE.FloatType, min: THREE.NearestFilter, mag: THREE.NearestFilter }),
      ];
      this._expoIdx = 0;
      this.exposureTexture = this.expoRT[0].texture;
    } else {
      this._resizeRT(this.sceneRT, w, h);
      this._resizeRT(this.velRT, w, h);
      this._resizeRT(this.hdrA, w, h);
      this._resizeRT(this.hdrB, w, h);
      if (this.taaHist) { this._resizeRT(this.taaHist[0], w, h); this._resizeRT(this.taaHist[1], w, h); }
      if (this.aoRT) {
        this._resizeRT(this.aoRT, hw, hh); this._resizeRT(this.aoRT2, hw, hh);
        this._resizeRT(this.aoHist[0], hw, hh); this._resizeRT(this.aoHist[1], hw, hh);
      }
      if (this.volRT) {
        this._resizeRT(this.volRT, qw, qh);
        this._resizeRT(this.volHist[0], qw, qh); this._resizeRT(this.volHist[1], qw, qh);
      }
      if (this.ssrRT) this._resizeRT(this.ssrRT, hw, hh);
      if (this.dofPrepRT) {
        this._resizeRT(this.dofPrepRT, hw, hh);
        this._resizeRT(this.dofNearA, hw, hh); this._resizeRT(this.dofNearB, hw, hh);
        this._resizeRT(this.dofGatherRT, hw, hh);
      }
      if (this.tileA) {
        const tw = Math.max(1, Math.ceil(w / this.TILE));
        const th = Math.max(1, Math.ceil(h / this.TILE));
        this._resizeRT(this.tileA, tw, h);
        this._resizeRT(this.tileB, tw, th);
        this._resizeRT(this.tileN, tw, th);
      }
      if (this.bloomRT) {
        const sz = PostFX._bloomSizes(w, h, this.bloomRT.length);
        for (let i = 0; i < this.bloomRT.length; i++) {
          this._resizeRT(this.bloomRT[i], sz[i][0], sz[i][1]);
        }
      }
      this._hasHistory = false;
    }

    // ---- size-dependent uniforms
    const halfTexel = new THREE.Vector2(1 / hw, 1 / hh);
    const fullTexel = new THREE.Vector2(1 / w, 1 / h);
    const blueScale = new THREE.Vector2(w / 64, h / 64);
    const blueScaleHalf = new THREE.Vector2(hw / 64, hh / 64);
    const quarterTexel = new THREE.Vector2(1 / qw, 1 / qh);
    const blueScaleQuarter = new THREE.Vector2(qw / 64, qh / 64);

    if (this.mGTAO) {
      const u = this.mGTAO.uniforms;
      u.tBlue.value = this.blueNoise;
      u.uResolution.value.set(hw, hh);
      u.uFullTexel.value.copy(fullTexel);
      u.uBlueScale.value.copy(blueScaleHalf);
    }
    if (this.mAODenoise) this.mAODenoise.uniforms.uTexel.value.copy(halfTexel);
    if (this.mAOTemporal) this.mAOTemporal.uniforms.uTexel.value.copy(halfTexel);
    if (this.mVolume) {
      this.mVolume.uniforms.tBlue.value = this.blueNoise;
      this.mVolume.uniforms.uBlueScale.value.copy(blueScaleQuarter);
    }
    if (this.mVolumeTemporal) this.mVolumeTemporal.uniforms.uTexel.value.copy(quarterTexel);
    if (this.mSSR) {
      this.mSSR.uniforms.tBlue.value = this.blueNoise;
      this.mSSR.uniforms.uFullTexel.value.copy(fullTexel);
      this.mSSR.uniforms.uHalfTexel.value.copy(halfTexel);
      this.mSSR.uniforms.uBlueScale.value.copy(blueScaleHalf);
    }
    this.mComposite.uniforms.uHalfTexel.value.copy(halfTexel);
    this.mComposite.uniforms.uVolTexel.value.copy(quarterTexel);
    if (this.mTAA) {
      this.mTAA.uniforms.uTexel.value.copy(fullTexel);
      this.mTAA.uniforms.uResolution.value.set(w, h);
    }
    if (this.mDofPrepare) {
      this.mDofPrepare.uniforms.uFullTexel.value.copy(fullTexel);
      this.mDofDilate.uniforms.uTexel.value.copy(halfTexel);
      this.mDofGather.uniforms.uTexel.value.copy(halfTexel);
    }
    if (this.mMotionBlur) {
      this.mMotionBlur.uniforms.uResolution.value.set(w, h);
      this.mMotionBlur.uniforms.tBlue.value = this.blueNoise;
      this.mMotionBlur.uniforms.uBlueScale.value.copy(blueScale);
    }
    this.mFinal.uniforms.uResolution.value.set(w, h);
    this.mFinal.uniforms.uBlueScale.value.copy(blueScale);
    this.mFinal.uniforms.uAspect.value = w / Math.max(1, h);
    this.mFinal.uniforms.tBlue.value = this.blueNoise;
    this.mVelocityObj.uniforms.uResolution.value.set(w, h);
  }

  resize(w, h) {
    if (!this._ready) return;
    this._allocate(Math.max(2, w), Math.max(2, h));
  }

  /* ------------------------------------------------------- public API */

  /** @param {{focusDistance?:number|null, aperture?:number, bokehScale?:number, enabled?:boolean}} o */
  setDOF(o = {}) {
    if (o.focusDistance !== undefined) this.dof.focusDistance = o.focusDistance;
    if (o.aperture !== undefined) this.dof.aperture = Math.max(0.7, o.aperture);
    if (o.bokehScale !== undefined) this.dof.bokehScale = Math.max(0, o.bokehScale);
    if (o.enabled !== undefined) this.dof.enabled = !!o.enabled;
    return this;
  }

  /** @param {{enabled?:boolean, shutter?:number, maxScreenFraction?:number, referenceDt?:number}} o */
  setMotionBlur(o = {}) {
    if (o.enabled !== undefined) this.motionBlur.enabled = !!o.enabled;
    if (o.shutter !== undefined) this.motionBlur.shutter = Math.max(0, Math.min(1, o.shutter));
    if (o.maxScreenFraction !== undefined) {
      this.motionBlur.maxScreenFraction = Math.max(0, Math.min(0.1, o.maxScreenFraction));
    }
    if (o.referenceDt !== undefined) this.motionBlur.referenceDt = Math.max(1e-4, o.referenceDt);
    return this;
  }

  /** @param {string|object} g preset name, or partial { lift, gamma, gain, saturation, temperature, ... } */
  setGrade(g) {
    this.autoGrade = false;
    if (typeof g === 'string') {
      const p = GRADES[g] || GRADES.neutral;
      this._gradeTarget = cloneGrade(p);
      return this;
    }
    if (!g) return this;
    const t = this._gradeTarget;
    asVec3(g.lift, t.lift);
    asVec3(g.gamma, t.gamma);
    asVec3(g.gain, t.gain);
    asVec3(g.shadowTint, t.shadowTint);
    asVec3(g.highlightTint, t.highlightTint);
    asVec3(g.lookSlope, t.lookSlope);
    asVec3(g.lookPower, t.lookPower);
    if (g.saturation !== undefined) t.saturation = g.saturation;
    if (g.contrast !== undefined) t.contrast = g.contrast;
    if (g.curve !== undefined) t.curve = g.curve;
    if (g.temperature !== undefined) t.temperature = g.temperature;
    if (g.split !== undefined) t.split = g.split;
    if (g.lookSat !== undefined) t.lookSat = g.lookSat;
    // The transfer function is part of the look, so a caller may set it too —
    // but a partial grade object must never leave these undefined, or the
    // lerp in _syncGrade() poisons the AgX latitude with NaN.
    if (g.latitude !== undefined) t.latitude = g.latitude;
    if (g.toe !== undefined) t.toe = g.toe;
    return this;
  }

  /** Camera impulse. Additive — several impulses stack. */
  shake(intensity = 1, duration = 0.4) {
    this._shakes.push({ a: Math.max(0, intensity), t: 0, d: Math.max(0.05, duration) });
    if (this._shakes.length > 12) this._shakes.shift();
    return this;
  }

  /**
   * Opt an object into per-object motion vectors.
   *
   * Rigid transform only: the pass reprojects through the object's previous
   * `matrixWorld`, so a skinned mesh gets its ROOT motion, not its pose motion.
   * That is the half that matters — a rider travelling with the camera has an
   * enormous camera-reprojection velocity and a near-zero true one, and it is
   * the difference between the two that smears him.
   */
  registerDynamic(obj) { if (obj) this._dynamic.add(obj); return this; }
  unregisterDynamic(obj) { this._dynamic.delete(obj); return this; }

  /**
   * Find the things in the world that move independently of the camera and opt
   * them into per-object motion vectors.
   *
   * NOBODY WAS CALLING `registerDynamic`. `_dynamic` was empty in the shipped
   * build, so every mover in the game — the player, the horse, wildlife — had
   * its velocity taken from the depth-reprojection pass, which assumes the
   * world is static. For an object travelling WITH the camera that assumption
   * is maximally wrong: its true screen velocity is ~0 and the buffer reports
   * the full camera flow (tens of px/frame at a gallop). Motion blur then
   * smears the character along a vector he never moved on, and TAA reprojects
   * his history from a completely different part of him. That is the "the horse
   * and the character are smeared" half of the ride bug.
   *
   * Done here rather than asking the sim systems to call in, because PostFX
   * must not require another system to change for its own buffers to be right.
   * Duck-typed and defensive: a system that does not expose a group is skipped.
   */
  _refreshMovers() {
    const seen = this._moverSeen || (this._moverSeen = new Set());
    for (const id of MOVER_SYSTEMS) {
      const sys = this.ctx.get(id);
      const root = sys && (sys.group || sys.root || sys.object3D);
      if (!root || !root.isObject3D) continue;
      root.traverse((o) => {
        // Instanced geometry needs previous INSTANCE matrices, which nothing
        // keeps; reprojecting it rigidly would be worse than the depth pass.
        if (!o.isMesh || o.isInstancedMesh || seen.has(o)) return;
        seen.add(o);
        this._dynamic.add(o);
      });
    }
  }

  /** Artistic control over the fog/scattering model. */
  setAtmosphere(o = {}) { Object.assign(this.atmosphere, o); return this; }

  /* ------------------------------------------------------------ update */

  update() {}

  lateUpdate(dt) {
    if (!this._ready) return;
    // Movers stream in (wildlife spawns, the horse is built after boot), so
    // rescan occasionally rather than once. 32 frames is ~0.03 ms amortised.
    if ((this._frame & 31) === 0) this._refreshMovers();
    const cam = this.ctx.camera;

    // undo last frame's shake so it never accumulates
    if (this._shakeApplied) {
      cam.position.sub(this._shakeOffset);
      cam.quaternion.multiply(this._shakeQuat.invert());
      this._shakeApplied = false;
    }

    let amp = 0;
    for (let i = this._shakes.length - 1; i >= 0; i--) {
      const s = this._shakes[i];
      s.t += dt;
      if (s.t >= s.d) { this._shakes.splice(i, 1); continue; }
      const k = 1 - s.t / s.d;
      amp += s.a * k * k;
    }
    if (amp <= 1e-4) { this._shakeOffset.set(0, 0, 0); return; }
    amp = Math.min(amp, 4);

    const t = this.ctx.time.elapsed;
    const p = this._shakePhase;
    const n = (i, f) => Math.sin(t * f + p[i]) * 0.6 + Math.sin(t * f * 2.37 + p[i + 1]) * 0.4;
    this._shakeOffset.set(n(0, 27.3), n(2, 31.7), n(4, 24.1)).multiplyScalar(amp * 0.045);
    this._shakeEuler.set(n(1, 22.9) * amp * 0.0055, n(3, 19.7) * amp * 0.0055, n(5, 17.3) * amp * 0.009);
    this._shakeQuat.setFromEuler(this._shakeEuler);
    cam.position.add(this._shakeOffset);
    cam.quaternion.multiply(this._shakeQuat);
    this._shakeApplied = true;
  }

  /* -------------------------------------------------------- uniform sync */

  /** Choose the look from the environment. Disabled the moment setGrade() runs. */
  _autoGrade() {
    if (!this.autoGrade) return;
    const e = this.ctx.env;
    const day = Math.min(1, Math.max(0, e.daylight));
    const tw = Math.min(1, Math.abs(e.twilight || 0));
    let look = blendPreset(GRADES.night, GRADES.western, day, this._lookA);
    look = blendPreset(look, GRADES.goldenHour, tw * 0.8 * day, this._lookB);
    const w = WEATHER_LOOK[e.weatherName];
    if (w) look = blendPreset(look, GRADES[w[0]], w[1] * (0.35 + 0.65 * day), this._lookA);
    if (e.cameraSubmerged) look = blendPreset(look, GRADES.underwater, 0.85, this._lookB);
    const t = this._gradeTarget;
    t.lift.set(look.lift[0], look.lift[1], look.lift[2]);
    t.gamma.set(look.gamma[0], look.gamma[1], look.gamma[2]);
    t.gain.set(look.gain[0], look.gain[1], look.gain[2]);
    t.shadowTint.set(look.shadowTint[0], look.shadowTint[1], look.shadowTint[2]);
    t.highlightTint.set(look.highlightTint[0], look.highlightTint[1], look.highlightTint[2]);
    t.lookSlope.set(look.lookSlope[0], look.lookSlope[1], look.lookSlope[2]);
    t.lookPower.set(look.lookPower[0], look.lookPower[1], look.lookPower[2]);
    t.latitude = look.latitude;
    t.toe = look.toe;
    t.saturation = look.saturation;
    t.contrast = look.contrast;
    t.curve = look.curve;
    t.temperature = look.temperature;
    t.split = look.split;
    t.lookSat = look.lookSat;
  }

  _syncGrade(dt) {
    this._autoGrade();
    const g = this._grade, t = this._gradeTarget;
    const k = 1 - Math.exp(-dt * this._gradeBlend);
    g.lift.lerp(t.lift, k); g.gamma.lerp(t.gamma, k); g.gain.lerp(t.gain, k);
    g.shadowTint.lerp(t.shadowTint, k); g.highlightTint.lerp(t.highlightTint, k);
    g.lookSlope.lerp(t.lookSlope, k); g.lookPower.lerp(t.lookPower, k);
    g.latitude += (t.latitude - g.latitude) * k;
    g.toe += (t.toe - g.toe) * k;
    g.saturation += (t.saturation - g.saturation) * k;
    g.contrast += (t.contrast - g.contrast) * k;
    g.curve += (t.curve - g.curve) * k;
    g.temperature += (t.temperature - g.temperature) * k;
    g.split += (t.split - g.split) * k;
    g.lookSat += (t.lookSat - g.lookSat) * k;
    this._applyGradeUniforms();
  }

  _applyGradeUniforms() {
    const u = this.mFinal.uniforms, g = this._grade;
    u.uLift.value.copy(g.lift);
    u.uGammaC.value.copy(g.gamma);
    u.uGain.value.copy(g.gain);
    u.uShadowTint.value.copy(g.shadowTint);
    u.uHighlightTint.value.copy(g.highlightTint);
    u.uLookSlope.value.copy(g.lookSlope);
    u.uLookPower.value.copy(g.lookPower);
    u.uSaturation.value = g.saturation;
    u.uContrast.value = g.contrast;
    u.uCurve.value = g.curve;
    u.uTemperature.value = g.temperature;
    u.uSplit.value = g.split;
    u.uLookSat.value = g.lookSat;

    /*
     * AgX latitude -> (minEv, maxEv), pinned so that 18% grey always lands at
     * the same place on the sigmoid (t = 10/16.5, the stock curve's own pivot).
     * Without the pin, narrowing the range would also lift or drop the whole
     * frame and the auto-exposure would spend a second chasing it back.
     */
    const lat = Math.max(6, g.latitude || 16.5);
    const minEv = LOG2_MIDGREY - AGX_PIVOT_T * lat;
    u.uAgxMin.value = minEv;
    u.uAgxMax.value = minEv + lat;
    u.uToe.value = Math.max(0, g.toe || 0);
  }

  /**
   * Where the mist layer sits.
   *
   * Radiation fog forms in the coldest air, which drains downhill overnight and
   * ponds on the valley floor. So the ceiling has to track the LOCAL LOW GROUND,
   * not the global water plane: in dawn_mist_valley `world.waterLevel` is 18 m
   * while the ground under the camera is 56 m and the surrounding terrain runs
   * 34-89 m, so a ceiling of waterLevel + 6 buried the entire layer under the
   * hillside and the shot rendered with no mist whatsoever (pass 1: "dawn_mist_
   * valley has no mist"). Sampling a low percentile of the terrain around the
   * camera puts the ceiling a few metres above the valley floor, which is what
   * makes the mist pool in the low ground and leave the ridges standing clear.
   */
  _updateMistLayer(dt) {
    const ctx = this.ctx;
    if (!ctx.world.ready) return;
    const cam = ctx.camera;
    if ((this._frame % 12) === 1 || !this._mistFloorInit) {
      const R = this.atmosphere.sampleRadius;
      const N = 9;
      const hs = this._mistSamples || (this._mistSamples = new Float64Array(N * N));
      let k = 0;
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          hs[k++] = ctx.world.getHeight(
            cam.position.x + (i / (N - 1) - 0.5) * 2 * R,
            cam.position.z + (j / (N - 1) - 0.5) * 2 * R,
          );
        }
      }
      const sorted = Array.prototype.slice.call(hs).sort((p, q) => p - q);
      // 12th percentile: the valley floor, robust against a single low pothole.
      let floor = sorted[Math.floor(0.12 * (sorted.length - 1))];
      // Never let the layer sit below the water plane — a river bottom is not
      // where the fog lives — and never above the camera's own ground.
      floor = Math.max(floor, (ctx.world.waterLevel || 0) - 2);
      this._mistFloorTarget = floor;
      if (!this._mistFloorInit) { this._mistFloor = floor; this._mistFloorInit = true; }
    }
    const k = dt > 0 ? Math.min(1, dt * 1.5) : 1;
    this._mistFloor += (this._mistFloorTarget - this._mistFloor) * k;
  }

  _atmosphereInto(u) {
    const e = this.ctx.env, a = this.atmosphere;
    // The medium is under the same cloud deck the ground is. Without this a
    // thunderstorm lights its own fog with a full-strength noon sun and the
    // plains render as a flat white sheet under a black sky.
    const atten = 1 - Math.min(1, Math.max(0, e.sunAttenuation || 0));
    const sun = Math.max(0, e.sunIntensity) * atten;
    const moon = Math.max(0, e.moonIntensity);
    // The cascades follow whichever body is the key light, so the shafts must too.
    if (sun >= moon) {
      u.uKeyDir.value.copy(e.sunDirection);
      u.uKeyRadiance.value.set(e.sunColor.r, e.sunColor.g, e.sunColor.b).multiplyScalar(sun);
    } else {
      u.uKeyDir.value.copy(e.moonDirection);
      u.uKeyRadiance.value.set(e.moonColor.r, e.moonColor.g, e.moonColor.b).multiplyScalar(moon);
    }
    /*
     * The ambient term of the mist is the light the whole SKY DOME puts into
     * it, which at dawn is dominated by the cold blue zenith — not by the warm
     * band round the sun. Driving it from a single horizon sample (or from
     * env.fogColor, which is that same sample) made dawn_mist_valley a sheet of
     * sepia. Sky's cosine-weighted hemisphere integral is exactly the right
     * quantity and it is already computed every frame; a little of the horizon
     * radiance is mixed back in so the bottom of the layer picks up the sunrise.
     */
    const sky = this.ctx.get('sky');
    const amb = Math.max(0.02, e.ambientIntensity) * a.mistAmbientScale;
    const irr = sky && typeof sky.getSkyIrradiance === 'function' ? sky.getSkyIrradiance() : null;
    /*
     * AMBIENT SOURCE FUNCTION, not ambient irradiance. `ambientScale` carries
     * the 1/pi — see the note on the tunable. Then a Rayleigh weighting: the
     * light this medium scatters out of the sky dome toward the camera is
     * biased to short wavelengths, and it is the single term that decides
     * whether distant terrain trends BLUER with distance (the measured
     * `aerial_perspective_hue` gate) or, as now, warmer. Normalised so it
     * moves hue without moving luminance.
     */
    const RY = 0.66, GY = 0.98, BY = 1.52;
    const ambS = a.mistAmbientScale * a.ambientScale;
    if (irr) {
      const k = Math.max(irr.intensity, 1e-5) * ambS;
      const hz = typeof sky.getFogColor === 'function'
        ? sky.getFogColor(null, this._mistCol || (this._mistCol = new THREE.Color()))
        : null;
      // A little of the horizon radiance so the bottom of the layer picks up
      // the sunrise instead of reading as a cold grey slab against a warm sky.
      const w = hz ? 0.22 * ambS : 0;
      u.uMistAmbient.value.set(
        (irr.color.r * k * 0.88 + (hz ? hz.r : 0) * w) * RY,
        (irr.color.g * k * 0.88 + (hz ? hz.g : 0) * w) * GY,
        (irr.color.b * k * 0.88 + (hz ? hz.b : 0) * w) * BY,
      );
    } else {
      u.uMistAmbient.value
        .set(e.fogColor.r * RY, e.fogColor.g * GY, e.fogColor.b * BY)
        .multiplyScalar(amb * a.ambientScale);
    }

    const turb = 0.75 + 0.25 * Math.min(4, Math.max(0.6, e.turbidity / 2.6));
    u.uDensity.value = Math.max(1e-7, e.fogDensity) * a.densityScale * turb;
    u.uInvHeight.value = 1 / Math.max(20, a.heightFalloff);
    const floor = this._mistFloorInit ? this._mistFloor : (this.ctx.world.waterLevel || 0);
    u.uBaseY.value = floor - 6;
    // Weather hands us a fairly timid groundMist (0.17 at dawn); the visible
    // response is the square root of it so a light mist still reads on camera.
    const gm = Math.max(0, Math.min(1, e.groundMist));
    u.uMist.value = Math.sqrt(gm) * a.mistDensity;
    // Only a structured mist layer needs the full step budget — see the note in
    // Atmosphere.js. The smooth aerosol integrates fine at ~65% of it, and the
    // step warp means those samples land where the gradient is.
    if (u.uSteps) {
      u.uSteps.value = gm > 0.02
        ? this._volSteps
        : Math.max(16, Math.round(this._volSteps * 0.80));
    }
    u.uWarp.value = Math.max(0.05, Math.min(1, a.stepWarp));
    // Radiation fog pools in the low ground: the layer ceiling sits just above
    // the valley floor, saturated below it and thinning fast above.
    u.uMistY.value = floor + a.mistHeight;
    u.uMistInvThick.value = 1 / Math.max(2, a.mistThickness);
    /*
     * The elevated bank. It sits above the lake with a genuine gap of clear
     * air between the two, because two strata separated by clear air is what
     * cuts a ridgeline into distinct planes — one bedsheet cannot do it however
     * dense it is.
     */
    u.uBand2Y.value = floor + a.mistHeight + a.band2Offset;
    u.uBand2InvT.value = 1 / Math.max(2, a.band2Thickness);
    u.uBand2Amp.value = a.band2Amount;

    /*
     * The aerosol. Present in every shot, thickened by weather humidity and by
     * twilight; referenced to the valley floor so it pools.
     *
     * `env.fogDensity` is used only as a RELATIVE weather signal (its base is
     * 1.6e-4) — its absolute value is far too small to be a visible medium,
     * which is the defect this rewrite exists to fix.
     */
    const fogRel = Math.min(2.2, Math.max(0.35, (e.fogDensity || 1.6e-4) / 1.6e-4));
    const tw = Math.min(1, Math.abs(e.twilight || 0));
    u.uHaze.value = a.hazeDensity
      * (0.55 + 0.45 * fogRel)
      * (1 + a.hazeTwilight * tw)
      * (1 + a.hazeMist * gm);
    u.uHazeInvH.value = 1 / Math.max(20, a.hazeHeight);
    u.uHazeFloor.value = floor;
    u.uAlbedo.value = a.hazeAlbedo;
    u.uKeyGain.value = a.hazeKeyGain;
    u.uNearAmb.value = a.nearAirlight;
    u.uFarSun.value = a.farSun;
    /*
     * THE AIRLIGHT SOURCE — what distant terrain fades TOWARD.
     *
     * Koschmieder: over a long path the in-scatter asymptotes to the radiance
     * of the sky in that direction, so `sky.getFogColor()` is the right
     * quantity and it is already computed every frame. But it is the
     * ASYMPTOTIC value of an infinite path, and Sky's own header records the
     * measurement that matters here: at golden hour the horizon LUT reads
     * R:G:B = 1 : 0.58 : 0.28 while the true single-scattering source function
     * of a 2-10 km segment is 1 : 1.05 : 0.36 — the LUT has been reddened by a
     * hundred kilometres of extra extinction that a nearby ridge never sees.
     * So the horizon radiance is de-reddened by roughly that ratio, at
     * constant luminance, before it is used as the source. That single
     * correction is the difference between distant ridges reading warmer than
     * the foreground (measured B-R gradient -0.20, gate INVERTED) and reading
     * as the cool receding planes the art direction asks for.
     */
    const fog = sky && typeof sky.getFogColor === 'function'
      ? sky.getFogColor(null, this._farCol || (this._farCol = new THREE.Color()))
      : null;
    if (fog) {
      /*
       * The correction has to be a BLEND toward a fixed cool chromaticity, not
       * a per-channel multiply. A multiply of (1.0, 0.58, 0.28) — a golden-hour
       * horizon — by anything that raises G and B enough to matter makes GREEN
       * the max channel, and the valley in golden_hour_vista rendered as a flat
       * sickly green plane. Blending at constant luminance toward a blue-grey
       * cannot do that: it can only walk the hue along the line between the two.
       */
      const l0 = 0.2126 * fog.r + 0.7152 * fog.g + 0.0722 * fog.b;
      const k = a.farBlue;
      const B = a.farBrightness;
      // (0.788, 1.022, 1.406) is a luma-normalised cool airlight chromaticity.
      u.uFarSrc.value.set(
        (fog.r * (1 - k) + 0.788 * l0 * k) * B,
        (fog.g * (1 - k) + 1.022 * l0 * k) * B,
        (fog.b * (1 - k) + 1.406 * l0 * k) * B,
      );
    } else {
      u.uFarSrc.value.copy(u.uMistAmbient.value).multiplyScalar(2.5 * a.farBrightness);
    }
    u.uLeak.value = a.hazeLeak;
    u.uFarMax.value = a.farMax;
    u.uFarTauMax.value = a.farTauMax;
    u.uSkyDepth.value = a.skyDepth;
    u.uMistNoise.value = a.mistNoise;
    u.uMinT.value = a.mistMinTransmittance;
    u.uMistScale.value = 1 / Math.max(4, a.mistNoiseScale);
    u.uTime.value = this.ctx.time.elapsed;
    u.uWind.value.set(e.windVector.x, 0, e.windVector.z).multiplyScalar(0.06);
    u.uMieG.value = a.mieG;
    u.uShadowBase.value = a.shadowBase;
    u.uBeamStrength.value = a.beamStrength;
  }

  /** Cascaded-shadow atlas exposed by `lighting`, if any. */
  _shadowSource() {
    const L = this.ctx.get('lighting');
    if (!L || !L.csm || !L.csm.enabled || !L.csm.atlas) return null;
    const u = typeof L.shadowUniforms === 'function' ? L.shadowUniforms() : L.csm.uniforms;
    if (!u || !u.rsCsmShadowMap || !u.rsCsmShadowMap.value) return null;
    return { count: L.csm.count | 0, uniforms: u, distance: L.csm.distance || 600 };
  }

  /* ------------------------------------------------------------ render */

  render(dt) {
    const ctx = this.ctx;
    const r = this.renderer;
    const cam = ctx.camera;

    if (!this._ready) { r.setRenderTarget(null); r.render(ctx.scene, cam); return; }

    // keep the targets in step with the drawing buffer
    const ds = r.getDrawingBufferSize(this._tmpSize || (this._tmpSize = new THREE.Vector2()));
    if (ds.x >= 2 && ds.y >= 2 && (ds.x !== this._size.x || ds.y !== this._size.y)) {
      this._allocate(ds.x, ds.y);
    }

    this._frame++;
    const W = this._size.x, H = this._size.y;
    const near = cam.near, far = cam.far;
    const q = ctx.quality;
    const step = Math.max(1e-4, Math.min(dt, 0.25));

    this._syncGrade(step);
    this._updateMistLayer(step);

    // ---- matrices (unjittered) ------------------------------------------
    cam.updateMatrixWorld();
    this._view.copy(cam.matrixWorld).invert();
    cam.matrixWorldInverse.copy(this._view);
    this._proj.copy(cam.projectionMatrix);
    this._prevViewProj.copy(this._viewProj);
    this._viewProj.multiplyMatrices(this._proj, this._view);
    this._invViewProj.copy(this._viewProj).invert();
    this._invProj.copy(this._proj).invert();
    this._camRot.setFromMatrix4(cam.matrixWorld);

    // ---- jittered scene render ------------------------------------------
    this._prevJitterUV.copy(this._jitterUV);
    if (this.useTAA) {
      const j = this._jitterPattern[this._frame % this._jitterPattern.length];
      const jx = j[0], jy = j[1];
      this._projJit.copy(this._proj);
      this._projJit.elements[8] += (2 * jx) / W;
      this._projJit.elements[9] += (2 * jy) / H;
      cam.projectionMatrix.copy(this._projJit);
      cam.projectionMatrixInverse.copy(this._projJit).invert();
      this._jitterUV.set(jx / W, jy / H);
    } else {
      this._jitterUV.set(0, 0);
    }

    const prevAutoClear = r.autoClear;
    r.autoClear = true;
    if (PROFILE) prof.begin('scene');
    r.setRenderTarget(this.sceneRT);
    r.render(ctx.scene, cam);
    if (PROFILE) prof.end();
    r.autoClear = false;

    if (this.useTAA) {
      cam.projectionMatrix.copy(this._proj);
      cam.projectionMatrixInverse.copy(this._invProj);
    }

    const depth = this.sceneRT.depthTexture;
    const quad = this.quad;
    const expoPrev = this.expoRT[this._expoIdx];
    const expoNext = this.expoRT[1 - this._expoIdx];

    // ---- motion vectors --------------------------------------------------
    {
      if (PROFILE) prof.begin('velocity');
      const u = this.mVelocity.uniforms;
      u.tDepth.value = depth;
      u.uInvViewProj.value.copy(this._invViewProj);
      u.uPrevViewProj.value.copy(this._hasHistory ? this._prevViewProj : this._viewProj);
      quad.render(this.mVelocity, this.velRT);
      if (this._dynamic.size) this._renderDynamicVelocity(cam);
      if (PROFILE) prof.end();
    }

    // ---- ambient occlusion ----------------------------------------------
    let aoTex = null;
    if (this.useAO) {
      if (PROFILE) prof.begin('gtao');
      const u = this.mGTAO.uniforms;
      u.tDepth.value = depth;
      u.uInvProj.value.copy(this._invProj);
      u.uNear.value = near; u.uFar.value = far;
      u.uProjScale.value = 0.5 * (H / 2) * this._proj.elements[5];
      u.uFrame.value = this._frame % 64;
      quad.render(this.mGTAO, this.aoRT);

      const d = this.mAODenoise.uniforms;
      d.tAO.value = this.aoRT.texture; d.uDir.value.set(1, 0);
      quad.render(this.mAODenoise, this.aoRT2);
      d.tAO.value = this.aoRT2.texture; d.uDir.value.set(0, 1);
      quad.render(this.mAODenoise, this.aoRT);

      const cur = this._aoIdx, prev = 1 - this._aoIdx;
      const t = this.mAOTemporal.uniforms;
      t.tAO.value = this.aoRT.texture;
      t.tHistory.value = this.aoHist[prev].texture;
      t.tVelocity.value = this.velRT.texture;
      t.uFeedback.value = this._hasHistory ? 0.9 : 0;
      quad.render(this.mAOTemporal, this.aoHist[cur]);
      aoTex = this.aoHist[cur].texture;
      this._aoIdx = prev;
      if (PROFILE) prof.end();
    }

    // ---- volumetric scattering ------------------------------------------
    let volTex = null;
    if (this.useVol) {
      if (PROFILE) prof.begin('volumetric');
      this._bindShadow();
      const u = this.mVolume.uniforms;
      u.tDepth.value = depth;
      u.uInvViewProj.value.copy(this._invViewProj);
      u.uViewMatrix.value.copy(this._view);
      u.uCamPos.value.copy(cam.position);
      u.uNear.value = Math.max(near, 0.3); u.uFar.value = far;
      u.uMaxDist.value = Math.min(this.atmosphere.maxDistance, this._shadowDistance * 1.05);
      u.uFrame.value = this._frame % 64;
      this._atmosphereInto(u);
      quad.render(this.mVolume, this.volRT);

      const cur = this._volIdx, prev = 1 - this._volIdx;
      const t = this.mVolumeTemporal.uniforms;
      t.tCurrent.value = this.volRT.texture;
      t.tHistory.value = this.volHist[prev].texture;
      t.tVelocity.value = this.velRT.texture;
      t.uFeedback.value = this._hasHistory ? 0.87 : 0;
      quad.render(this.mVolumeTemporal, this.volHist[cur]);
      volTex = this.volHist[cur].texture;
      this._volIdx = prev;
      if (PROFILE) prof.end();
    }

    // ---- screen space reflections ---------------------------------------
    let ssrTex = null;
    if (this.useSSR && this._reflectiveInView()) {
      if (PROFILE) prof.begin('ssr');
      const e = ctx.env;
      const u = this.mSSR.uniforms;
      u.tColor.value = this.sceneRT.texture;
      u.tDepth.value = depth;
      u.uProj.value.copy(this._proj);
      u.uInvProj.value.copy(this._invProj);
      u.uInvViewProj.value.copy(this._invViewProj);
      u.uCamRot.value.copy(this._camRot);
      u.uCamPos.value.copy(cam.position);
      u.uSunDir.value.copy(e.sunDirection);
      u.uSunRadiance.value.set(e.sunColor.r, e.sunColor.g, e.sunColor.b).multiplyScalar(Math.max(0, e.sunIntensity));
      u.uFogColor.value.set(e.fogColor.r, e.fogColor.g, e.fogColor.b);
      u.uZenith.value.set(e.ambientColor.r, e.ambientColor.g, e.ambientColor.b).multiplyScalar(1.2);
      u.uWaterLevel.value = ctx.world.waterLevel || 0;
      u.uWetness.value = e.wetness || 0;
      /*
       * The water system's baked depth field, so the SSR mask can ask "is there
       * water at this world xz" instead of inferring it from a height contour.
       * See the note at the mask in Reflections.js. Resolved lazily and cached:
       * the field is baked once during Water.init and never changes.
       */
      if (!this._ssrWater) {
        const w = this.ctx.get('water');
        // Water bakes asynchronously, so keep asking until it exists rather
        // than latching a null on frame 1 and never masking anything.
        this._ssrWater = (w && w.depthTex && w.half) ? w : null;
      }
      if (this._ssrWater) {
        u.tWaterDepth.value = this._ssrWater.depthTex;
        u.uWaterInfo.value.set(this._ssrWater.half, 1);
      } else {
        u.uWaterInfo.value.set(1, 0);
      }
      u.uNear.value = near; u.uFar.value = far;
      u.uFrame.value = this._frame % 64;
      quad.render(this.mSSR, this.ssrRT);
      ssrTex = this.ssrRT.texture;
      if (PROFILE) prof.end();
    }

    // ---- lighting composite ---------------------------------------------
    {
      if (PROFILE) prof.begin('composite');
      const u = this.mComposite.uniforms;
      u.tHDR.value = this.sceneRT.texture;
      u.tDepth.value = depth;
      u.tAO.value = aoTex || this._white;
      u.tVolume.value = volTex || this._black;
      u.tSSR.value = ssrTex || this._clear;
      u.tExposure.value = expoPrev.texture;
      u.uAOStrength.value = this.film.aoStrength;
      u.uInvViewProj.value.copy(this._invViewProj);
      u.uCamPos.value.copy(cam.position);
      u.uNear.value = near; u.uFar.value = far;
      u.uSubmerged.value = ctx.env.cameraSubmerged ? 1 : 0;
      quad.render(this.mComposite, this.hdrA);
      if (PROFILE) prof.end();
    }
    let current = this.hdrA;

    // ---- temporal AA -----------------------------------------------------
    if (this.useTAA) {
      if (PROFILE) prof.begin('taa');
      const cur = this._taaIdx, prev = 1 - this._taaIdx;
      const u = this.mTAA.uniforms;
      u.tCurrent.value = current.texture;
      u.tHistory.value = this.taaHist[prev].texture;
      u.tVelocity.value = this.velRT.texture;
      u.tDepth.value = depth;
      u.uValid.value = this._hasHistory ? 1 : 0;
      // Sub-pixel offset of THIS frame's samples, in pixels — the resolve
      // weights each 3x3 tap by its true distance from the output pixel centre.
      u.uJitter.value.set(this._jitterUV.x * W, this._jitterUV.y * H);
      quad.render(this.mTAA, this.taaHist[cur]);
      current = this.taaHist[cur];
      this._taaIdx = prev;
      if (PROFILE) prof.end();
    }

    // ---- metering + auto exposure ---------------------------------------
    {
      if (PROFILE) prof.begin('exposure');
      const l = this.mLogLuma.uniforms;
      l.tSrc.value = current.texture;
      l.tDepth.value = depth;
      l.uSkyWeight.value = this.film.skyMeterWeight;
      l.uTexel.value.set(1 / W, 1 / H);
      l.uTile.value.set(1 / this.lumaRT[0].width, 1 / this.lumaRT[0].height);
      quad.render(this.mLogLuma, this.lumaRT[0]);
      for (let i = 1; i < this.lumaRT.length; i++) {
        const b = this.mBoxDown.uniforms;
        b.tSrc.value = this.lumaRT[i - 1].texture;
        b.uTexel.value.set(1 / this.lumaRT[i - 1].width, 1 / this.lumaRT[i - 1].height);
        // Only the final 4x4 -> 1x1 step takes the max, so .b resolves to the
        // mean luma of the brightest sixteenth of the frame (see boxDownMaterial).
        b.uMaxMode.value = i === this.lumaRT.length - 1 ? 1 : 0;
        quad.render(this.mBoxDown, this.lumaRT[i]);
      }
      const e = this.mExposure.uniforms;
      e.tLuma.value = this.lumaRT[this.lumaRT.length - 1].texture;
      e.tPrev.value = expoPrev.texture;
      e.tDepth.value = depth;
      e.uDt.value = step;
      e.uFirst.value = this._hasHistory ? 0 : 1;
      e.uNear.value = near; e.uFar.value = far;
      /*
       * EXPOSURE CEILING — the single biggest cross-shot integration bug.
       *
       * The metering is a log-average, so it renormalises whatever is in frame
       * toward the key. With the ceiling at 18-19 the same sun produced 0.68x
       * in river_bend and 12.9x in forest_interior: a 4.2-stop swing between
       * two shots taken twenty minutes apart in the same light. A real camera
       * does not do that, and the consequences were exactly the tells the
       * forensics logged — a forest floor rendered as a lavender lightbox, a
       * storm that cannot be dark, and a campfire pushed so far into AgX's
       * shoulder that it lost its hue and clipped to white.
       *
       * The ceiling is now tied to the light that is actually falling on the
       * scene rather than to the histogram. Full sun gets barely a stop of
       * headroom over what an open frame meters at; a moonless night still
       * gets a lot, because a night scene genuinely needs gain to be readable.
       */
      const day = Math.min(1, Math.max(0, ctx.env.daylight));
      /*
       * THE GOLDEN-HOUR WASH-OUT.
       *
       * `daylight` falls to 0.68 at golden hour and 0.95 at dawn, so
       * interpolating the ceiling on it linearly handed golden_hour_vista a
       * ceiling of 4.35 against high_noon's 2.40 — and the shot was measured
       * PINNED at 4.343, i.e. 0.86 stops brighter than noon, in the one shot
       * that is supposed to be the moodiest in the set. That is the measured
       * cause of "the image is washed out, everything sits in a narrow hazy
       * midtone band": the money shot was being exposed like an overcast noon.
       *
       * The extra headroom exists for genuine NIGHT, where the frame needs
       * gain to be readable at all. Twilight is not night — there is still a
       * sun in the sky and a real camera would stop down for it — so the
       * curve is pushed so the ceiling only opens once the sun is properly
       * gone. Measured effect: golden_hour 4.35 -> 2.40, dawn_mist 2.71 ->
       * 2.40, night_camp and moonlit_ridge unchanged at 8.5.
       */
      const lit = Math.min(1, day * 1.5);
      e.uKey.value = 0.050 + (0.176 - 0.050) * day;
      e.uMaxExposure.value = this.film.maxExposureNight
        + (this.film.maxExposureDay - this.film.maxExposureNight) * lit;
      e.uMinExposure.value = 0.02;
      quad.render(this.mExposure, expoNext);
      this._expoIdx = 1 - this._expoIdx;
      this.exposureTexture = expoNext.texture;
      this._readExposure(expoNext);
      if (PROFILE) prof.end();
    }
    const expoTex = expoNext.texture;

    // ---- depth of field --------------------------------------------------
    if (this.useDOF && this.dof.enabled) {
      if (PROFILE) prof.begin('dof');
      const maxCoC = 9 * this.dof.bokehScale;
      const auto = this.dof.focusDistance == null ? 1 : 0;
      const setCoC = (u) => {
        u.tExposure.value = expoTex;
        u.uAutoFocus.value = auto;
        u.uFocusManual.value = this.dof.focusDistance == null ? 30 : this.dof.focusDistance;
        u.uAperture.value = this.dof.aperture;
        u.uScreenH.value = H;
        u.uMaxCoC.value = maxCoC;
        u.uFocal.value = 0.5 * 0.024 / Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
      };
      const p = this.mDofPrepare.uniforms;
      setCoC(p);
      p.tColor.value = current.texture;
      p.tDepth.value = depth;
      p.uNear.value = near; p.uFar.value = far;
      quad.render(this.mDofPrepare, this.dofPrepRT);

      const d = this.mDofDilate.uniforms;
      d.tSrc.value = this.dofPrepRT.texture; d.uDir.value.set(1, 0); d.uFromAlpha.value = 1;
      quad.render(this.mDofDilate, this.dofNearA);
      d.tSrc.value = this.dofNearA.texture; d.uDir.value.set(0, 1); d.uFromAlpha.value = 0;
      quad.render(this.mDofDilate, this.dofNearB);

      const g = this.mDofGather.uniforms;
      g.tPrepared.value = this.dofPrepRT.texture;
      g.tNearCoC.value = this.dofNearB.texture;
      g.uMaxCoCHalf.value = maxCoC * 0.5;
      quad.render(this.mDofGather, this.dofGatherRT);

      const c = this.mDofComposite.uniforms;
      setCoC(c);
      c.tColor.value = current.texture;
      c.tFar.value = this.dofGatherRT.textures[0];
      c.tNear.value = this.dofGatherRT.textures[1];
      c.tDepth.value = depth;
      c.uNear.value = near; c.uFar.value = far;
      const dst = current === this.hdrB ? this.hdrA : this.hdrB;
      quad.render(this.mDofComposite, dst);
      current = dst;
      if (PROFILE) prof.end();
    }

    // ---- motion blur -----------------------------------------------------
    /*
     * Four passes (three tile reductions plus a full-res reconstruction) that
     * can only ever produce the input image when nothing in frame has moved.
     * The capture harness holds the camera perfectly still for 150 frames, and
     * so does a player standing at a vista, so this is worth a CPU-side test:
     * compare the view-projection against last frame's and ask every registered
     * mover whether its world matrix changed.
     */
    if (this.useMB && this.motionBlur.enabled && this._sceneIsMoving()) {
      if (PROFILE) prof.begin('motionBlur');
      const t = this.mTileMax.uniforms;
      t.tSrc.value = this.velRT.texture;
      t.uTexel.value.set(1 / W, 1 / H); t.uDir.value.set(1, 0);
      quad.render(this.mTileMax, this.tileA);
      t.tSrc.value = this.tileA.texture;
      t.uTexel.value.set(1 / this.tileA.width, 1 / this.tileA.height); t.uDir.value.set(0, 1);
      quad.render(this.mTileMax, this.tileB);
      const n = this.mNeighborMax.uniforms;
      n.tSrc.value = this.tileB.texture;
      n.uTexel.value.set(1 / this.tileB.width, 1 / this.tileB.height);
      quad.render(this.mNeighborMax, this.tileN);

      const m = this.mMotionBlur.uniforms;
      m.tColor.value = current.texture;
      m.tVelocity.value = this.velRT.texture;
      m.tNeighborMax.value = this.tileN.texture;
      m.tDepth.value = depth;
      m.uNear.value = near; m.uFar.value = far;
      m.uFrame.value = this._frame % 64;
      // Fixed exposure, not a fixed fraction of a variable frame — see
      // `this.motionBlur`. The min() means a long frame shortens the shutter
      // fraction by exactly as much as it lengthened the per-frame velocity,
      // so the streak in PIXELS is the same at 30, 60 and 144 fps.
      const mb = this.motionBlur;
      m.uScale.value = mb.shutter * Math.min(1, mb.referenceDt / step);
      m.uMaxPixels.value = Math.max(3, H * mb.maxScreenFraction);
      const dst = current === this.hdrB ? this.hdrA : this.hdrB;
      quad.render(this.mMotionBlur, dst);
      current = dst;
      if (PROFILE) prof.end();
    }

    // ---- bloom -----------------------------------------------------------
    let bloomTex = this._black;
    let haloTex = this._black;
    let haloWideTex = this._black;
    if (this.useBloom) {
      if (PROFILE) prof.begin('bloom');
      const p = this.mBloomPre.uniforms;
      p.tSrc.value = current.texture;
      p.tExposure.value = expoTex;
      p.uThreshold.value = this.film.bloomThreshold;
      p.uKnee.value = this.film.bloomKnee;
      /*
       * KERNEL FOOTPRINT MUST MATCH THE REDUCTION RATIO.  The prefilter now
       * writes a QUARTER-res mip 0 (see BLOOM_MIPS), but the 13-tap kernel is
       * a 2x downsampler: its taps sit at +/-1 and +/-2 SOURCE texels, which
       * covers a 5x5 source window.  Reducing 4x with a 5x5 point-sampled
       * window leaves three quarters of the source unread, so a 1-2 px
       * highlight — the sun disc in storm_plains, the campfire core in
       * night_camp — is sampled or missed depending on the destination
       * texel's phase.  That is what produced the beaded vertical white bar
       * over the horizon at 1080p and not at 720p: it is phase aliasing, and
       * it is a defect, not a glow.  Doubling the tap spacing makes the
       * kernel span the +/-4 texels a 4x reduction actually covers.
       */
      p.uTexel.value.set(2 / W, 2 / H);
      quad.render(this.mBloomPre, this.bloomRT[0]);
      for (let i = 1; i < this.bloomRT.length; i++) {
        const d = this.mBloomDown.uniforms;
        d.tSrc.value = this.bloomRT[i - 1].texture;
        d.uTexel.value.set(1 / this.bloomRT[i - 1].width, 1 / this.bloomRT[i - 1].height);
        quad.render(this.mBloomDown, this.bloomRT[i]);
      }
      for (let i = this.bloomRT.length - 2; i >= 0; i--) {
        const u = this.mBloomUp.uniforms;
        u.tSrc.value = this.bloomRT[i + 1].texture;
        u.uTexel.value.set(1 / this.bloomRT[i + 1].width, 1 / this.bloomRT[i + 1].height);
        u.uRadius.value = 1.0;
        u.uIntensity.value = 1.0;
        quad.render(this.mBloomUp, this.bloomRT[i]);
      }
      bloomTex = this.bloomRT[0].texture;
      haloTex = this.bloomRT[Math.min(2, this.bloomRT.length - 1)].texture;
      // Red halation is sourced one octave wider than green/blue so the outer
      // ring reddens the way film does — see finalMaterial().
      haloWideTex = this.bloomRT[Math.min(3, this.bloomRT.length - 1)].texture;
      if (PROFILE) prof.end();
    }

    // ---- final -----------------------------------------------------------
    {
      if (PROFILE) prof.begin('final');
      const u = this.mFinal.uniforms;
      u.tHDR.value = current.texture;
      u.tBloom.value = bloomTex;
      u.tHalation.value = haloTex;
      u.tHalationWide.value = haloWideTex;
      u.tExposure.value = expoTex;
      u.uFrame.value = this._frame % 1024;
      u.uBloomStrength.value = this.useBloom ? this.film.bloom : 0;
      u.uHalation.value = this.useBloom ? this.film.halation : 0;
      u.uChromatic.value = this.film.chromatic;
      u.uVignette.value = this.film.vignette;
      u.uGrain.value = this.film.grain;
      u.uExposureBias.value = this.film.exposureBias;
      u.uShoulderK.value = this.film.shoulder;
      u.uShoulderW.value = this.film.shoulderHeadroom;
      u.uWhiteAdapt.value = this.film.whiteAdapt;
      u.uWhiteGain.value = this.film.whiteGain;
      u.uWhiteMin.value = this.film.whiteMin;
      // CAS only makes sense as the second half of a temporal resolve; without
      // TAA it would just crisp up the aliasing.
      u.uSharpen.value = this.useTAA ? this.film.sharpen : 0;
      quad.render(this.mFinal, null);
      if (PROFILE) prof.end();
    }

    r.setRenderTarget(null);
    r.autoClear = prevAutoClear;
    this._hasHistory = true;
    if (PROFILE) prof.tick();
  }

  /* ------------------------------------------------------------ helpers */

  /**
   * True when anything in frame can produce a motion vector this frame:
   * either the camera moved, or a registered mover's transform changed.
   * `_prevMatrices` is maintained by `_renderDynamicVelocity`, so a mover that
   * has never been drawn counts as moving (conservative, and it self-corrects
   * on the next frame).
   */
  _sceneIsMoving() {
    if (!this._hasHistory) return false;
    const a = this._viewProj.elements, b = this._prevViewProj.elements;
    for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return true;
    for (const obj of this._dynamic) {
      if (!obj.visible || !obj.isMesh) continue;
      const prev = this._prevMatrices.get(obj);
      if (!prev) return true;
      const m = obj.matrixWorld.elements, p = prev.elements;
      for (let i = 0; i < 16; i++) if (Math.abs(m[i] - p[i]) > 1e-7) return true;
    }
    return false;
  }

  /**
   * Is there anything in frame that SSR can contribute to?
   *
   * The pass is a half-res raymarch that only ever produces a visible result on
   * water or on ground wet enough to be specular. `forest_interior` and
   * `night_camp` contain neither, and they were paying 1.4-3.0 ms a frame for a
   * buffer the composite then blends in at alpha ~0. The test is a frustum
   * check against the water system's tiles, refreshed a few times a second
   * (water tiles are static geometry and the camera cannot cross a river in
   * eight frames).
   */
  _reflectiveInView() {
    const env = this.ctx.env;
    if ((env.wetness || 0) > 0.02 || env.cameraSubmerged) return true;
    if ((this._frame & 7) !== 0 && this._waterSeen !== undefined) return this._waterSeen;
    const w = this.ctx.get('water');
    const group = w && w.group;
    if (!group || !group.visible) { this._waterSeen = false; return false; }
    const cam = this.ctx.camera;
    const fr = this._frustum || (this._frustum = new THREE.Frustum());
    const m = this._frMat || (this._frMat = new THREE.Matrix4());
    m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    fr.setFromProjectionMatrix(m);
    let seen = false;
    for (const c of group.children) {
      if (!c.visible || !c.geometry) continue;
      if (c.geometry.boundingSphere === null) c.geometry.computeBoundingSphere();
      const bs = c.geometry.boundingSphere;
      if (!bs) { seen = true; break; }
      const sp = this._bsTmp || (this._bsTmp = new THREE.Sphere());
      sp.copy(bs).applyMatrix4(c.matrixWorld);
      if (fr.intersectsSphere(sp)) { seen = true; break; }
    }
    this._waterSeen = seen;
    return seen;
  }

  _bindShadow() {
    const src = this._shadowSource();
    const key = src ? `csm${src.count}` : 'none';
    if (key !== this._shadowKey) {
      const old = this.mVolume;
      this.mVolume = volumetricMaterial(this._volSteps, src);
      this.mVolume.uniforms.tBlue.value = this.blueNoise;
      this.mVolume.uniforms.uBlueScale.value.copy(old.uniforms.uBlueScale.value);
      // Share the live cascade uniform objects — lighting mutates them in place.
      if (src) Object.assign(this.mVolume.uniforms, src.uniforms);
      old.dispose();
      this._shadowKey = key;
    }
    this._shadowDistance = src ? src.distance : 600;
  }

  _renderDynamicVelocity(cam) {
    const r = this.renderer;
    const m = this.mVelocityObj;
    m.uniforms.tDepth.value = this.sceneRT.depthTexture;
    // Both matrices in play here are the unjittered ones (the scene render has
    // already restored the projection), so no jitter compensation is needed.
    m.uniforms.uCurrJitter.value.set(0, 0);
    m.uniforms.uPrevJitter.value.set(0, 0);
    const mvp = this._tmpMat || (this._tmpMat = new THREE.Matrix4());
    r.setRenderTarget(this.velRT);
    for (const obj of this._dynamic) {
      // A mesh that has been detached from the scene must not be drawn: the
      // sim systems pool and despawn, and `_dynamic` outlives the despawn.
      if (!obj.geometry || !obj.parent || !obj.visible || !obj.isMesh) continue;
      const prev = this._prevMatrices.get(obj);
      mvp.multiplyMatrices(this._prevViewProj, prev || obj.matrixWorld);
      m.uniforms.uPrevModelViewProj.value.copy(mvp);
      const saved = obj.material;
      obj.material = m;
      try { r.render(obj, cam); } catch (e) { /* keep the frame alive */ }
      obj.material = saved;
      // Reuse the stored matrix. A fresh Matrix4 per mesh per frame is ~30
      // allocations a frame for the player and horse alone, which is a GC
      // sawtooth for a buffer that only ever needs the last value.
      if (prev) prev.copy(obj.matrixWorld);
      else this._prevMatrices.set(obj, obj.matrixWorld.clone());
    }
  }

  /**
   * Pull the metered exposure back to the CPU for `ctx.env.exposure`.
   *
   * This used to be a synchronous `readRenderTargetPixels` every 5 frames. A
   * blocking readback drains the whole pipeline, so the CPU sat waiting for
   * every draw call already in flight — measured at several ms per frame, and
   * it is a cost the renderer pays for ONE FLOAT that only drives HUD text and
   * the star brightness. The PBO ring (see AsyncReadback.js) issues the read
   * without waiting and collects it three frames later, which no consumer of
   * `env.exposure` can tell apart from the live value.
   */
  _readExposure(rt) {
    if (!this._readOk) return;
    if (this._ring === undefined) {
      this._ring = null;
      try {
        const gl = this.renderer.getContext();
        const r = new PixelRing(this.renderer, {
          width: 1, height: 1, array: this._readBuf,
          glFormat: gl.RGBA, glType: gl.FLOAT, latency: 3,
        });
        if (r.ok) this._ring = r;
      } catch (err) { this._ring = null; }
    }
    if (this._ring && this._ring.ok) {
      if (this._ring.pump(rt, 0, 0)) {
        const e = this._readBuf[0];
        if (Number.isFinite(e) && e > 0) {
          this._exposureCPU = e;
          this.ctx.env.exposure = e;
        }
        // .b/.a are the metered post-exposure peak and highlight-region
        // levels. .b is what drives the adaptive white point; both are kept on
        // the CPU purely so the look can be diagnosed without a GPU capture.
        const pk = this._readBuf[2];
        if (Number.isFinite(pk) && pk > 0) this.peakLevel = pk;
        const hi = this._readBuf[3];
        if (Number.isFinite(hi) && hi > 0) this.hiLevel = hi;
      }
      return;
    }
    // Fallback: the blocking path, but only every 12th frame rather than every
    // 5th, because it costs a pipeline drain each time.
    if ((this._frame % 12) !== 0) return;
    try {
      this.renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, this._readBuf);
      const e = this._readBuf[0];
      if (Number.isFinite(e) && e > 0) {
        this._exposureCPU = e;
        this.ctx.env.exposure = e;
      }
      const pk = this._readBuf[2];
      if (Number.isFinite(pk) && pk > 0) this.peakLevel = pk;
      const hi = this._readBuf[3];
      if (Number.isFinite(hi) && hi > 0) this.hiLevel = hi;
    } catch (err) {
      this._readOk = false;
    }
  }

  /* ----------------------------------------------------------- teardown */

  dispose() {
    const rts = [
      this.sceneRT, this.velRT, this.hdrA, this.hdrB, this.aoRT, this.aoRT2,
      this.volRT, this.ssrRT, this.dofPrepRT, this.dofNearA, this.dofNearB,
      this.dofGatherRT, this.tileA, this.tileB, this.tileN,
      ...(this.taaHist || []), ...(this.aoHist || []), ...(this.volHist || []),
      ...(this.bloomRT || []), ...(this.lumaRT || []), ...(this.expoRT || []),
    ];
    if (this.sceneRT && this.sceneRT.depthTexture) this.sceneRT.depthTexture.dispose();
    for (const rt of rts) if (rt) rt.dispose();
    const mats = [
      this.mVelocity, this.mVelocityObj, this.mGTAO, this.mAODenoise, this.mAOTemporal,
      this.mVolume, this.mVolumeTemporal, this.mSSR, this.mComposite, this.mTAA,
      this.mDofPrepare, this.mDofDilate, this.mDofGather, this.mDofComposite,
      this.mTileMax, this.mNeighborMax, this.mMotionBlur,
      this.mBloomPre, this.mBloomDown, this.mBloomUp,
      this.mLogLuma, this.mBoxDown, this.mExposure, this.mFinal, this.mCopy,
    ];
    for (const m of mats) if (m) m.dispose();
    if (this._ring) this._ring.dispose();
    if (this.blueNoise) this.blueNoise.dispose();
    if (this._black) this._black.dispose();
    if (this._white) this._white.dispose();
    if (this._clear) this._clear.dispose();
    if (this.quad) this.quad.dispose();
    this._ready = false;
  }
}
