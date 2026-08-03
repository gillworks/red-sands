import * as THREE from 'three';
import { resample } from '../rig/SkinBuilder.js';
import { TrackedBuilder, HP, mul, mix3, TAU, angDist, HARD, WOVEN, HIDE } from './CoatBuild.js';

/**
 * RED SANDS — HORSE BODY
 * ============================================================================
 * The animal itself, at three levels of detail, built against the SAME
 * skeleton `HorseRig.buildHorseRig()` returns — so every rig invariant (seat
 * gap, stirrup irons, hoof rest positions, IK segment lengths) is untouched by
 * definition. Only the skin changes.
 *
 * What this build does that the previous one did not:
 *
 *  SUBDIVISION WHERE IT SHOWS.  The barrel went 34x38 -> 56x64 and the neck,
 *  head and legs roughly doubled. A 0.35 m radius barrel at 34 segments has
 *  6.5 cm facets, and 6.5 cm is enormous when the player is standing at the
 *  horse's shoulder. Everything else (tack, kit) is unchanged — it was never
 *  the thing breaking into flats.
 *
 *  NO RIMS.  Every limb now starts as a near-point buried deep inside the
 *  barrel and opens up as it emerges. The old build started the thigh as a
 *  0.12 x 0.215 open ring sitting 2 cm proud of the ribs, and that ring's
 *  edge IS the hard straight polygon boundary that ran across the haunch in
 *  every close-up. An intersection curve between two smooth swept surfaces
 *  reads as an anatomical crease; an open tube mouth reads as a modelling bug.
 *
 *  A FACE.  Sculpted nostrils with raised wings, a mouth line, lips, a chin
 *  groove, cheekbone and masseter, an eye with a wet cornea set into a real
 *  orbit, and ears on their own bones so they can turn.
 *
 *  LEGS THAT HAVE TENDONS.  The flexor tendon stands off the back of each
 *  cannon, the knee and hock are blocked in rather than swept through, the
 *  fetlock is a joint, the pastern slopes, and the hoof is a wedge with a
 *  coronet band instead of the drinks can it used to be.
 *
 *  COAT VARIATION IN THE VERTEX BUFFER.  Dapple, roaning, countershading,
 *  sun-bleaching along the topline and the sweat-prone zones are baked per
 *  vertex, which costs nothing per pixel and survives at any LOD.
 * ============================================================================
 */

/* ------------------------------------------------------- deterministic noise */
function hash3(x, y, z) {
  let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (i, j, k) => hash3(xi + i, yi + j, zi + k);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w);
}
function fbm(x, y, z) {
  return vnoise(x, y, z) * 0.56 + vnoise(x * 2.07, y * 2.07, z * 2.07) * 0.28
    + vnoise(x * 4.13, y * 4.13, z * 4.13) * 0.16;
}

/**
 * The coat, evaluated anywhere on the animal.
 *
 * Four things are layered, in the order a real coat builds them up:
 *   countershading  dark along the spine, paler down the flank and belly
 *   dapple          15 cm rings of lighter hair over the ribs and haunch,
 *                   strongest where a fat bay actually dapples
 *   roan            fine white-hair flecking through the flank and quarters
 *   bleach          the sun has been on the topline for years
 * `up` is the surface normal's y at that point, 0 = vertical flank.
 */
function coatColour(x, y, z, up, opts = {}) {
  const belly = THREE.MathUtils.clamp(-up, 0, 1);
  const top = THREE.MathUtils.clamp(up, 0, 1);
  let c = mix3(HP.coat, HP.belly, belly * belly * 0.55);
  c = mix3(c, HP.coatCool, top * 0.22);

  // dapple: soft rings, only over the rib cage and quarters
  const zone = Math.exp(-Math.pow((z + 0.15) / 0.62, 2)) * (1 - belly * 0.7);
  const d = fbm(x * 7.4 + 11.0, y * 7.4, z * 5.6);
  /*
   * A SMOOTH ring, not |sin|. The absolute value put a cusp at every zero
   * crossing, and a cusp evaluated per vertex on a 1 cm mesh is exactly the
   * pebbled "orange peel" the first look at this had all over the shoulder
   * and the haunch. Dapple is a soft value change, not a speckle.
   */
  const ring = 0.5 + 0.5 * Math.sin((d - 0.5) * 9.0);
  const dapple = (ring * 0.66 + d * 0.34 - 0.46) * zone * (opts.dapple != null ? opts.dapple : 1);
  c = mix3(c, HP.coatWarm, THREE.MathUtils.clamp(dapple * 0.80, 0, 0.40));

  /*
   * Roaning. Deliberately at a 7 cm wavelength and half the amplitude it had:
   * the previous 2.5 cm was BELOW the vertex spacing over most of the animal,
   * so instead of fine white hairs it aliased into per-vertex noise. The real
   * millimetre hair grain is the shader's job — this is only the large blotchy
   * component underneath it.
   */
  const fl = fbm(x * 14.0, y * 13.0, z * 11.0);
  c = mul(c, 0.955 + fl * 0.085 * (0.35 + 0.65 * zone));

  // sun-bleach along the topline and the points of the hips
  const bl = Math.pow(top, 2.2) * 0.16;
  c = mix3(c, HP.coatWarm, bl);

  // large-scale value drift so no two square metres match
  c = mul(c, 0.93 + fbm(x * 2.3, y * 2.1, z * 1.7) * 0.16);
  return c;
}

/** Roughness of hide at a point: sweat-prone hollows are slicker. */
function coatRough(x, y, z) {
  return 0.70 + (fbm(x * 9.0 + 3.0, y * 9.0, z * 7.0) - 0.5) * 0.16;
}

/* ========================================================================== */

/**
 * @param {Rig} rig            skeleton from buildHorseRig(), ears already added
 * @param {function} rand      deterministic rng
 * @param {object} opts        { q } 1.0 = LOD0, 0.55 = LOD1, 0.30 = LOD2
 * @returns {{geo:THREE.BufferGeometry, organic:Uint8Array}}
 */
export function buildHorseBody(rig, rand, opts = {}) {
  const q = opts.q != null ? opts.q : 1;
  const tack = opts.tack !== false;
  const B = new TrackedBuilder();
  const w = (a, wa, b, wb) => rig.w(a, wa, b, wb);
  /** radial segment count, floored so a far LOD is still a solid. */
  const R = (n) => Math.max(7, Math.round(n * q));
  /** longitudinal steps. */
  const S = (n) => Math.max(5, Math.round(n * q));

  /* ================================================================= BARREL
   * Deeper than wide, with a real withers ridge, a sprung rib cage tucking up
   * into the flank, the scapula and triceps standing proud at the front and
   * the gluteal mass balling out over the hip.
   */
  B.organic(true).group(0).surface(HIDE);
  B.flow((x, y, z) => {
    // Hair runs back and down off the topline, sweeping toward the flank.
    void x;
    return [0, -0.28 - Math.max(0, 1.30 - y) * 0.5, -1.0 + Math.max(0, z) * 0.25];
  });
  B.tube(resample([
    { p: [0, 1.302, 0.706], rx: 0.126, rz: 0.186, bones: w('chest', 1) },
    { p: [0, 1.284, 0.612], rx: 0.170, rz: 0.252, bones: w('chest', 1) },
    { p: [0, 1.276, 0.482], rx: 0.220, rz: 0.312, bones: w('chest', 1) },
    { p: [0, 1.266, 0.352], rx: 0.246, rz: 0.338, bones: w('chest', 0.52, 'body', 0.48) },
    { p: [0, 1.256, 0.212], rx: 0.258, rz: 0.348, bones: w('body', 1) },
    { p: [0, 1.252, 0.086], rx: 0.264, rz: 0.353, bones: w('body', 1) },
    { p: [0, 1.256, -0.044], rx: 0.263, rz: 0.348, bones: w('body', 1) },
    { p: [0, 1.264, -0.172], rx: 0.259, rz: 0.334, bones: w('body', 1) },
    { p: [0, 1.276, -0.300], rx: 0.257, rz: 0.318, bones: w('body', 0.62, 'croup', 0.38) },
    { p: [0, 1.294, -0.424], rx: 0.256, rz: 0.300, bones: w('body', 0.34, 'croup', 0.66) },
    { p: [0, 1.318, -0.542], rx: 0.244, rz: 0.276, bones: w('croup', 1) },
    { p: [0, 1.334, -0.652], rx: 0.222, rz: 0.250, bones: w('croup', 1) },
    { p: [0, 1.340, -0.760], rx: 0.176, rz: 0.208, bones: w('croup', 1) },
    { p: [0, 1.328, -0.848], rx: 0.106, rz: 0.132, bones: w('croup', 1) },
    { p: [0, 1.306, -0.898], rx: 0.048, rz: 0.062, bones: w('croup', 1) },
  ], S(64)), {
    radial: R(56), power: 2.45, capStart: true, capEnd: true,
    color: HP.coat, rough: 0.68, sheen: 0.18,
    radiusFn: (v, u) => {
      const a = u * TAU;                    // a=0 -> +X (left), a=3pi/2 -> +Y
      const up = Math.max(-Math.sin(a), 0);
      const down = Math.max(Math.sin(a), 0);
      const side = Math.abs(Math.cos(a));
      const withers = Math.exp(-Math.pow((v - 0.235) / 0.075, 2));
      const croup = Math.exp(-Math.pow((v - 0.615) / 0.10, 2));
      const flank = Math.exp(-Math.pow((v - 0.545) / 0.09, 2));
      const shoulder = Math.exp(-Math.pow((v - 0.180) / 0.082, 2)) * side * (0.45 + 0.55 * down);
      const tricep = Math.exp(-Math.pow((v - 0.288) / 0.062, 2)) * side * down;
      const haunch = Math.exp(-Math.pow((v - 0.672) / 0.102, 2)) * side * (0.32 + 0.68 * up);
      const gutter = Math.exp(-Math.pow((angDist(a - Math.PI * 1.5) - 0.44) / 0.22, 2))
        * Math.exp(-Math.pow((v - 0.470) / 0.240, 2));
      /*
       * RIBS, band-limited. The old term was sin((v-0.275)*47) sampled at 38
       * rings: under five samples per period, which does not resolve a
       * sinusoid — it aliases into the very facet banding this pass exists to
       * remove. Same visual idea at 31 rad and 64 rings is nine samples per
       * period and reads as ribs instead of as stair steps.
       */
      const ribs = Math.sin((v - 0.275) * 31.0)
        * Math.exp(-Math.pow((v - 0.395) / 0.120, 2)) * side * (0.30 + 0.70 * down);
      // the points of the hips (tuber coxae) — hard little landmarks, one
      // upper-left (a = 1.72pi) and one upper-right (a = 1.28pi)
      const hip = Math.exp(-Math.pow((v - 0.638) / 0.038, 2))
        * (Math.exp(-Math.pow(angDist(a - Math.PI * 1.72) / 0.40, 2))
          + Math.exp(-Math.pow(angDist(a - Math.PI * 1.28) / 0.40, 2)));
      return 1
        - up * 0.055 + up * (withers * 0.072 + croup * 0.030)
        + down * 0.018 - down * flank * 0.055
        - side * flank * 0.032
        + shoulder * 0.048 + tricep * 0.030 + haunch * 0.064
        + hip * 0.026
        - gutter * 0.030 + ribs * 0.0115;
    },
    colorFn: (v, u, p) => {
      const a = u * TAU;
      const up = -Math.sin(a);
      return coatColour(p[0], p[1], p[2], up);
    },
    roughFn: (v, u) => coatRough(v * 3.1, u * 2.7, 0.5),
  });

  // brisket / point of shoulder
  B.blob([0, 1.186, 0.616], [0.152, 0.172, 0.142], w('chest', 1), {
    rings: R(11), segments: R(16), rough: 0.72, sheen: 0.25, color: HP.coat,
    colorFn: (u, v, p) => coatColour(p[0], p[1], p[2], Math.cos(v * Math.PI)),
  });

  /* =================================================================== NECK
   * A deep narrow wedge with a REAL crest: the mane sits on top of a raised
   * ridge of muscle, and without that ridge the mane can only ever read as a
   * stripe painted along a cone.
   */
  B.flow((x, y, z) => [0, -0.55, -0.85 + (y - 1.7) * 0.4 + z * 0.1]);
  B.tube(resample([
    { p: [0, 1.418, 0.494], rx: 0.252, rz: 0.184, bones: w('chest', 1) },
    { p: [0, 1.492, 0.560], rx: 0.240, rz: 0.168, bones: w('chest', 0.72, 'neck1', 0.28) },
    { p: [0, 1.566, 0.628], rx: 0.224, rz: 0.152, bones: w('chest', 0.36, 'neck1', 0.64) },
    { p: [0, 1.652, 0.700], rx: 0.206, rz: 0.136, bones: w('neck1', 0.72, 'neck2', 0.28) },
    { p: [0, 1.744, 0.776], rx: 0.188, rz: 0.121, bones: w('neck1', 0.30, 'neck2', 0.70) },
    { p: [0, 1.838, 0.854], rx: 0.170, rz: 0.108, bones: w('neck2', 1) },
    { p: [0, 1.918, 0.926], rx: 0.152, rz: 0.098, bones: w('neck2', 0.52, 'neck3', 0.48) },
    { p: [0, 1.978, 0.996], rx: 0.134, rz: 0.090, bones: w('neck3', 1) },
    { p: [0, 2.020, 1.040], rx: 0.116, rz: 0.086, bones: w('neck3', 1) },
  ], S(34)), {
    radial: R(34), power: 2.25, color: HP.coat, rough: 0.72, sheen: 0.25,
    /*
     * Sweep frame, derived from the first tangent rather than assumed — the
     * previous build's comment here had it exactly backwards and was bulging
     * and darkening the THROAT while claiming to be building the crest, which
     * is a large part of why the mane had nothing to sit on:
     *   a = 0     the throat (down-forward)
     *   a = pi/2  the horse's LEFT
     *   a = pi    the CREST (up-back)
     */
    radiusFn: (v, u) => {
      const a = u * TAU;
      const crest = Math.exp(-Math.pow(angDist(a - Math.PI) / 0.52, 2));
      const throat = Math.exp(-Math.pow(angDist(a) / 0.60, 2));
      // jugular groove: the gutter that runs the length of the lower neck
      const groove = Math.exp(-Math.pow((angDist(a) - 0.62) / 0.20, 2))
        * Math.exp(-Math.pow((v - 0.48) / 0.34, 2));
      return 1
        // thickest low on the neck, thinning toward the poll, like a real crest
        + crest * 0.090 * (0.40 + 0.60 * Math.exp(-Math.pow((v - 0.34) / 0.45, 2)))
        - throat * 0.030 * (1 - v) - groove * 0.030;
    },
    colorFn: (v, u, p) => {
      const a = u * TAU;
      const crest = Math.exp(-Math.pow(angDist(a - Math.PI) / 0.62, 2));
      const c = coatColour(p[0], p[1], p[2], -Math.cos(a) * 0.9, { dapple: 0.5 });
      // the hair right under the mane is always darker and never bleaches
      return mix3(c, HP.points, crest * 0.42);
    },
    roughFn: (v, u) => coatRough(v * 4.0 + 2.0, u * 3.0, 1.7),
  });
  // throatlatch fill where the neck meets the jaw
  B.blob([0, 1.918, 1.020], [0.104, 0.112, 0.114], w('neck3', 0.6, 'head', 0.4), {
    rings: R(9), segments: R(13), rough: 0.72, sheen: 0.25, color: mul(HP.coat, 0.93),
  });

  /* =================================================================== HEAD */
  buildHead(B, rig, R, S, q);

  /* =================================================================== LEGS */
  for (const s of [1, -1]) buildLeg(B, rig, R, S, q, s, 'F');
  for (const s of [1, -1]) buildLeg(B, rig, R, S, q, s, 'H');

  /* ============================================================== TAIL DOCK */
  B.flow(() => [0, -1, -0.35]);
  B.tube(resample([
    { p: [0, 1.524, -0.832], rx: 0.056, rz: 0.056, bones: w('croup', 0.62, 'tail1', 0.38) },
    { p: [0, 1.432, -0.918], rx: 0.049, rz: 0.047, bones: w('tail1', 1) },
    { p: [0, 1.330, -0.978], rx: 0.040, rz: 0.038, bones: w('tail1', 0.5, 'tail2', 0.5) },
    { p: [0, 1.220, -1.008], rx: 0.030, rz: 0.029, bones: w('tail2', 1) },
    { p: [0, 1.130, -1.018], rx: 0.017, rz: 0.017, bones: w('tail2', 1) },
  ], S(16)), {
    radial: R(14), capEnd: true, color: HP.mane, rough: 0.62, sheen: 0.30,
    colorFn: (v) => mul(HP.mane, 1.35 - 0.45 * v),
  });
  /*
   * The dense root of the tail fall. Alpha cards alone leave a tail you can
   * see daylight through at the top, which is the giveaway that it is cards;
   * a solid dark mass behind them costs 500 triangles and removes it.
   */
  B.tube(resample([
    { p: [0, 1.500, -0.846], rx: 0.048, rz: 0.044, bones: w('tail1', 0.7, 'croup', 0.3) },
    { p: [0, 1.402, -0.906], rx: 0.054, rz: 0.048, bones: w('tail1', 1) },
    { p: [0, 1.284, -0.952], rx: 0.052, rz: 0.046, bones: w('tail1', 0.4, 'tail2', 0.6) },
    { p: [0, 1.166, -0.986], rx: 0.044, rz: 0.039, bones: w('tail2', 1) },
    { p: [0, 1.062, -1.006], rx: 0.030, rz: 0.027, bones: w('tail2', 0.4, 'tail3', 0.6) },
    { p: [0, 0.986, -1.016], rx: 0.013, rz: 0.012, bones: w('tail3', 1) },
  ], S(16)), {
    radial: R(14), capEnd: true, color: HP.mane, rough: 0.74, sheen: 0.45,
    colorFn: (v) => mul(HP.mane, 1.10 - 0.42 * v),
  });

  if (tack) buildTack(B, rig, R, S);

  return B.build();
}

/* ========================================================================== */

/**
 * THE HEAD.
 *
 * At the framing the player actually rides in, this is the part of the animal
 * nearest the lens, and it was a smooth cone with two black dots on it. What
 * a horse's head actually needs to read: the flat nasal bone, the dish under
 * the eye, the cheekbone, the big masseter, a jaw you can see the edge of,
 * lips, a mouth line, a chin groove, nostrils with raised wings, an eye set
 * INTO an orbit with a wet cornea, and ears that turn.
 */
function buildHead(B, rig, R, S, q) {
  const w = (a, wa, b, wb) => rig.w(a, wa, b, wb);
  /*
   * Sweep frame for this path (parallel transport from the first tangent):
   *   a = 0        the front / top plane of the face
   *   a = pi/2     the horse's RIGHT
   *   a = pi       under the jaw
   *   a = 3pi/2    the horse's LEFT
   * All the sculpting below is written in those terms.
   */
  const NOS_V = 0.878, NOS_A = 1.02, NOS_SV = 0.034, NOS_SA = 0.30;
  const nostril = (v, u) => {
    const a = u * TAU;
    const dv = (v - NOS_V) / NOS_SV;
    const daL = angDist(a - NOS_A) / NOS_SA;
    const daR = angDist(a + NOS_A) / NOS_SA;
    return Math.exp(-(dv * dv + daL * daL)) + Math.exp(-(dv * dv + daR * daR));
  };
  const mouth = (v, u) => {
    const a = u * TAU;
    const dv = (v - 0.965) / 0.030;
    const da = angDist(a - Math.PI * 0.5) / 1.25;   // wraps the whole front
    return Math.exp(-(dv * dv)) * Math.exp(-Math.pow(Math.max(0, da - 0.55) / 0.5, 2));
  };

  B.flow((x, y, z) => [0, -0.72, 0.60 + (1.45 - z) * 0.2]);
  B.tube(resample([
    { p: [0, 2.032, 1.026], rx: 0.108, rz: 0.092, bones: w('neck3', 0.34, 'head', 0.66) },
    { p: [0, 1.992, 1.078], rx: 0.114, rz: 0.099, bones: w('head', 1) },
    { p: [0, 1.946, 1.132], rx: 0.113, rz: 0.100, bones: w('head', 1) },
    { p: [0, 1.898, 1.184], rx: 0.104, rz: 0.092, bones: w('head', 1) },
    { p: [0, 1.844, 1.238], rx: 0.093, rz: 0.082, bones: w('head', 1) },
    { p: [0, 1.786, 1.292], rx: 0.084, rz: 0.072, bones: w('head', 1) },
    { p: [0, 1.724, 1.344], rx: 0.076, rz: 0.063, bones: w('head', 1) },
    { p: [0, 1.664, 1.396], rx: 0.070, rz: 0.057, bones: w('head', 1) },
    { p: [0, 1.616, 1.442], rx: 0.068, rz: 0.055, bones: w('head', 1) },
    { p: [0, 1.582, 1.478], rx: 0.066, rz: 0.054, bones: w('head', 1) },
    { p: [0, 1.556, 1.502], rx: 0.058, rz: 0.048, bones: w('head', 1) },
    { p: [0, 1.540, 1.516], rx: 0.036, rz: 0.031, bones: w('head', 1) },
  ], S(42)), {
    radial: R(34), power: 2.30, capEnd: true, color: HP.coat, rough: 0.70, sheen: 0.25,
    radiusFn: (v, u) => {
      const a = u * TAU;
      const front = Math.exp(-Math.pow(angDist(a) / 0.85, 2));
      const under = Math.exp(-Math.pow(angDist(a - Math.PI) / 0.9, 2));
      // flat nasal bone down the front of the face
      const nasal = Math.exp(-Math.pow(angDist(a) / 0.45, 2))
        * Math.exp(-Math.pow((v - 0.52) / 0.26, 2));
      // the dish under the eye, and the cheekbone ridge above the jaw
      const dish = Math.exp(-Math.pow((angDist(a - Math.PI * 0.5) - 0.30) / 0.28, 2)
        - Math.pow((v - 0.36) / 0.10, 2))
        + Math.exp(-Math.pow((angDist(a + Math.PI * 0.5) - 0.30) / 0.28, 2)
          - Math.pow((v - 0.36) / 0.10, 2));
      // the muzzle swells again below the nostrils — a horse is not a cone
      const swell = Math.exp(-Math.pow((v - 0.925) / 0.075, 2));
      return 1
        - nasal * 0.030 - dish * 0.026 + front * 0.010 + under * 0.008
        + swell * 0.075
        - nostril(v, u) * 0.165            // the nostril proper, ~10 mm deep
        - mouth(v, u) * 0.030;             // the mouth line
    },
    colorFn: (v, u, p) => {
      const a = u * TAU;
      // blaze: a narrow pale strip straight down the nasal bone
      const star = Math.exp(-Math.pow(angDist(a) / 0.24, 2))
        * (Math.exp(-Math.pow((v - 0.20) / 0.13, 2)) * 0.9
          + Math.exp(-Math.pow((v - 0.50) / 0.24, 2)) * 0.35);
      let c = coatColour(p[0], p[1], p[2], Math.cos(a) * 0.7, { dapple: 0.25 });
      // muzzle skin: near-black, matte, and it starts before the lips do
      const mz = THREE.MathUtils.smoothstep(v, 0.845, 0.945);
      c = mix3(c, HP.muzzleSkin, mz);
      c = mix3(c, HP.nostril, THREE.MathUtils.clamp(nostril(v, u) * 1.35, 0, 1));
      c = mix3(c, [0.02, 0.016, 0.013], THREE.MathUtils.clamp(mouth(v, u), 0, 1));
      return mix3(c, [0.145, 0.128, 0.106], THREE.MathUtils.clamp(star * 0.72, 0, 0.72));
    },
    roughFn: (v) => (v > 0.86 ? 0.86 : 0.70),      // muzzle skin is matte
  });

  /* ---- nostril wings ------------------------------------------------------
   * The flare of skin standing proud around each nostril. This is what
   * catches the light and tells you the hollow behind it is a hole.
   *
   * Placed in the head tube's OWN sweep frame so it lands exactly on the
   * hollow the radiusFn above carves. The frame is the parallel transport of
   * the first tangent, worked out once here rather than eyeballed:
   *   NF  front/top plane of the face      BR  the horse's right
   *   TG  down the face toward the muzzle
   */
  {
    const NF = [0, 0.792, 0.610], BR = [-1, 0, 0], TG = [0, -0.610, 0.792];
    // surface point at (v = NOS_V, a = -+NOS_A) on the muzzle
    const P0 = [0, 1.575, 1.485], RX = 0.062, RZ = 0.051;
    const ca = Math.cos(NOS_A), sa = Math.sin(NOS_A);
    for (const s of [1, -1]) {
      // s = +1 is the horse's LEFT, which is a = -NOS_A in this frame
      const sgn = -s;
      const N = [
        NF[0] * ca + BR[0] * sa * sgn, NF[1] * ca + BR[1] * sa * sgn, NF[2] * ca + BR[2] * sa * sgn,
      ];
      const nl = Math.hypot(N[0], N[1], N[2]);
      N[0] /= nl; N[1] /= nl; N[2] /= nl;
      const C = [
        P0[0] + NF[0] * ca * RX + BR[0] * sa * sgn * RZ + N[0] * 0.003,
        P0[1] + NF[1] * ca * RX + BR[1] * sa * sgn * RZ + N[1] * 0.003,
        P0[2] + NF[2] * ca * RX + BR[2] * sa * sgn * RZ + N[2] * 0.003,
      ];
      // tangential basis for the ring
      const T2 = [
        N[1] * TG[2] - N[2] * TG[1], N[2] * TG[0] - N[0] * TG[2], N[0] * TG[1] - N[1] * TG[0],
      ];
      /*
       * A shallow BOWL that sits down inside the sculpted hollow, not a raised
       * washer sitting on top of it. The first attempt lifted the whole ring
       * 6 mm proud and coloured it black, and at 1:1 it read as a bolt stuck
       * on the side of the muzzle. Now the inner edge sinks 5 mm and carries
       * the dark, and the outer edge is flush skin.
       */
      B.sheet(R(14), 2, (u, v) => {
        const a = u * TAU;
        const r1 = 0.014 + v * 0.020;           // along the face
        const r2 = 0.010 + v * 0.015;           // across it
        const sink = (1 - v) * -0.005;
        return {
          p: [
            C[0] + TG[0] * Math.sin(a) * r1 + T2[0] * Math.cos(a) * r2 + N[0] * sink,
            C[1] + TG[1] * Math.sin(a) * r1 + T2[1] * Math.cos(a) * r2 + N[1] * sink,
            C[2] + TG[2] * Math.sin(a) * r1 + T2[2] * Math.cos(a) * r2 + N[2] * sink,
          ],
          bones: w('head', 1),
          color: mix3(HP.nostril, HP.muzzleSkin, v * v),
        };
      }, { wrapU: true, color: HP.muzzleSkin, rough: 0.80 });
    }
  }

  /* ---- lips and chin ---------------------------------------------------- */
  B.blob([0, 1.548, 1.492], [0.060, 0.030, 0.036], w('head', 1), {
    rings: R(8), segments: R(12), rough: 0.82, color: mul(HP.lip, 1.05),
  });
  B.blob([0, 1.512, 1.470], [0.052, 0.030, 0.032], w('jaw', 0.7, 'head', 0.3), {
    rings: R(8), segments: R(12), rough: 0.82, color: HP.lip,
  });
  // chin groove
  B.blob([0, 1.492, 1.424], [0.040, 0.028, 0.030], w('jaw', 0.6, 'head', 0.4), {
    rings: R(7), segments: R(10), rough: 0.80, color: mul(HP.lip, 0.86),
  });

  /* ---- jowl / masseter, and the branch of the jaw ------------------------ */
  B.blob([0, 1.918, 1.140], [0.126, 0.110, 0.120], w('head', 1), {
    rings: R(11), segments: R(15), rough: 0.72, sheen: 0.25, color: HP.coat,
    colorFn: (u, v, p) => coatColour(p[0], p[1], p[2], Math.cos(v * Math.PI) * 0.6, { dapple: 0.2 }),
  });
  for (const s of [1, -1]) {
    // masseter: the big round cheek muscle
    B.blob([0.086 * s, 1.906, 1.156], [0.052, 0.070, 0.064], w('head', 1), {
      rings: R(8), segments: R(12), rough: 0.73, sheen: 0.22, color: mul(HP.coat, 1.02),
      shape: (u, v) => 1 - Math.max(-Math.cos(u * TAU) * s, 0) * 0.28,
    });
    // jaw bone edge running forward from it
    B.tube([
      { p: [0.070 * s, 1.858, 1.196], rx: 0.020, rz: 0.026, bones: w('head', 1) },
      { p: [0.058 * s, 1.812, 1.252], rx: 0.019, rz: 0.024, bones: w('head', 1) },
      { p: [0.046 * s, 1.760, 1.310], rx: 0.016, rz: 0.020, bones: w('head', 1) },
    ], { radial: R(9), color: mul(HP.coat, 0.92), rough: 0.74 });
  }

  /* ---- eyes ------------------------------------------------------------- */
  for (const s of [1, -1]) {
    const ex = 0.098 * s, ey = 1.948, ez = 1.128;
    // orbit: the bony ring the eye is set into, standing proud of the skull
    B.blob([ex * 0.95, ey + 0.005, ez - 0.008], [0.037, 0.034, 0.033], w('head', 1), {
      rings: R(9), segments: R(13), rough: 0.76, sheen: 0.30, color: mul(HP.coat, 0.90),
      colorFn: (u, v) => mul(HP.coat, 0.80 + 0.22 * (1 - v)),
    });
    /*
     * The cornea. Roughness 0.06 on the HARD class is what gives it the small
     * hard specular a live eye has; at 0.7 like the rest of the hide it was
     * indistinguishable from a painted dot, which is exactly how it read.
     */
    B.blob([ex, ey, ez + 0.012], [0.0245, 0.0225, 0.0225], w('head', 1), {
      rings: R(9), segments: R(13), rough: 0.06, sheen: 0.0, mtype: HARD, color: HP.eye,
      colorFn: (u, v) => mix3(HP.eye, HP.eyeWhite, Math.pow(Math.max(0, 1 - v * 1.6), 3) * 0.5),
    });
    // eyelid: a squashed ring lying over the cornea's equator
    B.sheet(R(14), 2, (u, v) => {
      const a = u * TAU;
      const rr = 0.0255 + v * 0.013;
      return {
        p: [ex + Math.cos(a) * rr * 1.10 * s * 0.28 + Math.cos(a) * 0.002 * s,
          ey + Math.sin(a) * rr * 0.94,
          ez + 0.010 + Math.cos(a) * rr * 1.02],
        bones: w('head', 1),
        color: mix3(HP.muzzleSkin, mul(HP.coat, 0.9), v),
      };
    }, { wrapU: true, color: HP.muzzleSkin, rough: 0.55 });
  }

  /* ---- ears -------------------------------------------------------------
   * On their own bones (added by Horse.js) so they can flick and track. Each
   * is an outer shell plus a darker inner conch set inside it, which is what
   * stops an ear reading as the flat triangle it was.
   */
  for (const s of [1, -1]) {
    const L = s > 0 ? 'L' : 'R';
    const eb = w('ear' + L, 1);
    const bx = 0.058 * s, by = 2.030, bz = 1.000;
    B.tube([
      { p: [bx, by - 0.006, bz], rx: 0.040, rz: 0.034, bones: eb },
      { p: [bx + 0.008 * s, by + 0.030, bz + 0.004], rx: 0.036, rz: 0.028, bones: eb },
      { p: [bx + 0.018 * s, by + 0.068, bz + 0.008], rx: 0.030, rz: 0.022, bones: eb },
      { p: [bx + 0.026 * s, by + 0.104, bz + 0.014], rx: 0.021, rz: 0.015, bones: eb },
      { p: [bx + 0.032 * s, by + 0.134, bz + 0.019], rx: 0.011, rz: 0.008, bones: eb },
      { p: [bx + 0.035 * s, by + 0.152, bz + 0.022], rx: 0.003, rz: 0.002, bones: eb },
    ], {
      radial: R(12), power: 2.1, capEnd: true, capStart: true,
      color: mul(HP.coat, 0.82), rough: 0.86, sheen: 0.42,
      colorFn: (v, u) => {
        // the outside of an ear is dark at the tip and along its edges
        const edge = Math.abs(Math.cos(u * TAU));
        return mix3(mul(HP.coat, 0.86), HP.points, v * 0.55 + edge * 0.16);
      },
    });
    // inner conch, facing forward and slightly out
    B.tube([
      { p: [bx + 0.006 * s, by + 0.006, bz + 0.014], rx: 0.026, rz: 0.014, bones: eb },
      { p: [bx + 0.014 * s, by + 0.048, bz + 0.017], rx: 0.021, rz: 0.011, bones: eb },
      { p: [bx + 0.023 * s, by + 0.092, bz + 0.021], rx: 0.014, rz: 0.007, bones: eb },
      { p: [bx + 0.030 * s, by + 0.126, bz + 0.025], rx: 0.005, rz: 0.003, bones: eb },
    ], {
      radial: R(10), power: 2.0, capEnd: true,
      color: mul(HP.points, 1.1), rough: 0.9, sheen: 0.5,
      colorFn: (v) => mix3(mul(HP.points, 1.25), HP.muzzleSkin, v * 0.6),
    });
  }
  void q;
}

/* ========================================================================== */

/**
 * ONE LEG.
 *
 * `side` is +1 for the horse's left, `kind` is 'F' or 'H'.
 *
 * The important structural change from the previous build: the top of every
 * limb is a near-point buried inside the barrel, so there is no open ring
 * standing proud of the ribs. That single rim is what produced the straight
 * polygon boundary running across the shoulder and haunch at 1:1.
 */
function buildLeg(B, rig, R, S, q, s, kind) {
  const w = (a, wa, b, wb) => rig.w(a, wa, b, wb);
  const L = s > 0 ? 'L' : 'R';
  const front = kind === 'F';
  B.organic(true).surface(HIDE);
  B.flow(() => [0, -1, -0.12]);

  const pointsCol = (v, k0, k1) => {
    const k = THREE.MathUtils.smoothstep(v, k0, k1);
    const a = mul(HP.coat, 0.95 + 0.04 * (1 - v));
    const b = mul(HP.points, 0.92 + 0.55 * (1 - v));
    return mix3(a, b, k);
  };

  if (front) {
    /* scapula + triceps mass. Buried in the barrel, carrying the shoulder so
     * the junction is a mass rather than an edge. */
    B.blob([0.146 * s, 1.356, 0.400], [0.122, 0.200, 0.190], w('chest', 0.72, 'fUp' + L, 0.28), {
      rings: R(13), segments: R(18), rough: 0.66, sheen: 0.18, color: HP.coat,
      shape: (u, v) => {
        const a = u * TAU;
        return 1 - Math.max(-Math.cos(a) * s, 0) * 0.32 - THREE.MathUtils.smoothstep(v, 0.70, 1.0) * 0.18;
      },
      colorFn: (u, v, p) => coatColour(p[0], p[1], p[2], Math.cos(v * Math.PI) * 0.8),
    });

    B.tube(resample([
      // buried point inside the chest — no rim
      { p: [0.108 * s, 1.508, 0.400], rx: 0.012, rz: 0.014, bones: w('chest', 1) },
      { p: [0.128 * s, 1.452, 0.410], rx: 0.064, rz: 0.118, bones: w('chest', 0.86, 'fUp' + L, 0.14) },
      { p: [0.170 * s, 1.300, 0.418], rx: 0.114, rz: 0.192, bones: w('chest', 0.35, 'fUp' + L, 0.65) },
      { p: [0.196 * s, 1.160, 0.420], rx: 0.106, rz: 0.158, bones: w('fUp' + L, 1) },
      { p: [0.203 * s, 1.048, 0.406], rx: 0.096, rz: 0.130, bones: w('fUp' + L, 0.72, 'fFore' + L, 0.28) },
      { p: [0.204 * s, 1.008, 0.400], rx: 0.090, rz: 0.118, bones: w('fUp' + L, 0.45, 'fFore' + L, 0.55) },
      { p: [0.205 * s, 0.930, 0.402], rx: 0.081, rz: 0.098, bones: w('fFore' + L, 1) },
      { p: [0.205 * s, 0.856, 0.408], rx: 0.070, rz: 0.083, bones: w('fFore' + L, 1) },
      { p: [0.206 * s, 0.772, 0.416], rx: 0.055, rz: 0.062, bones: w('fFore' + L, 1) },
      { p: [0.207 * s, 0.716, 0.421], rx: 0.047, rz: 0.053, bones: w('fFore' + L, 0.62, 'fCan' + L, 0.38) },
      // knee (carpus): squared off, wider than the cannon under it
      { p: [0.207 * s, 0.680, 0.424], rx: 0.046, rz: 0.055, bones: w('fFore' + L, 0.30, 'fCan' + L, 0.70) },
      { p: [0.207 * s, 0.640, 0.427], rx: 0.041, rz: 0.048, bones: w('fCan' + L, 1) },
      { p: [0.207 * s, 0.560, 0.430], rx: 0.033, rz: 0.039, bones: w('fCan' + L, 1) },
      { p: [0.207 * s, 0.460, 0.435], rx: 0.031, rz: 0.037, bones: w('fCan' + L, 1) },
      { p: [0.207 * s, 0.360, 0.441], rx: 0.031, rz: 0.037, bones: w('fCan' + L, 1) },
      // fetlock joint
      { p: [0.207 * s, 0.286, 0.446], rx: 0.037, rz: 0.043, bones: w('fCan' + L, 0.65, 'fPas' + L, 0.35) },
      { p: [0.207 * s, 0.248, 0.450], rx: 0.041, rz: 0.046, bones: w('fCan' + L, 0.35, 'fPas' + L, 0.65) },
      // pastern, sloping forward
      { p: [0.207 * s, 0.196, 0.457], rx: 0.035, rz: 0.040, bones: w('fPas' + L, 1) },
      { p: [0.207 * s, 0.152, 0.464], rx: 0.033, rz: 0.038, bones: w('fPas' + L, 0.55, 'fHf' + L, 0.45) },
      { p: [0.207 * s, 0.126, 0.469], rx: 0.034, rz: 0.039, bones: w('fPas' + L, 0.3, 'fHf' + L, 0.7) },
    ], S(38)), {
      radial: R(20), power: 2.2, rough: 0.74, sheen: 0.22, color: HP.coat,
      radiusFn: (v, u) => {
        const a = u * TAU;
        // knee: flat front, prominent accessory carpal behind
        const knee = Math.exp(-Math.pow((v - 0.545) / 0.030, 2));
        const back = Math.max(0, -Math.cos(a));
        const fwd = Math.max(0, Math.cos(a));
        return 1 + knee * (back * 0.22 - fwd * 0.05)
          + Math.exp(-Math.pow((v - 0.812) / 0.028, 2)) * back * 0.14;   // ergot
      },
      colorFn: (v, u, p) => {
        const c = pointsCol(v, 0.55, 0.70);
        return v < 0.4 ? coatColour(p[0], p[1], p[2], 0.1, { dapple: 0.35 }) : c;
      },
      roughFn: (v) => 0.72 + (v > 0.6 ? 0.06 : 0),
    });

    /* FLEXOR TENDON. A horse's cannon is a bone with a cable behind it and a
     * finger's width of air between them; without it the lower leg is a
     * dowel, which is exactly what it looked like. */
    B.tube(resample([
      { p: [0.207 * s, 0.660, 0.398], rx: 0.013, rz: 0.011, bones: w('fCan' + L, 1) },
      { p: [0.207 * s, 0.560, 0.396], rx: 0.014, rz: 0.012, bones: w('fCan' + L, 1) },
      { p: [0.207 * s, 0.430, 0.398], rx: 0.014, rz: 0.012, bones: w('fCan' + L, 1) },
      { p: [0.207 * s, 0.330, 0.406], rx: 0.013, rz: 0.011, bones: w('fCan' + L, 1) },
      { p: [0.207 * s, 0.280, 0.418], rx: 0.011, rz: 0.010, bones: w('fCan' + L, 0.6, 'fPas' + L, 0.4) },
    ], S(12)), {
      radial: R(9), color: mul(HP.points, 1.12), rough: 0.70,
      colorFn: (v) => mul(HP.points, 1.20 - v * 0.2),
    });
    // chestnut, on the inside of the forearm
    B.blob([0.176 * s, 0.860, 0.406], [0.012, 0.026, 0.017], w('fFore' + L, 1), {
      rings: R(6), segments: R(8), rough: 0.88, color: mul(HP.points, 0.85), mtype: HARD,
    });
  } else {
    /* haunch: gluteal + semitendinosus mass, buried at the top */
    B.blob([0.152 * s, 1.400, -0.520], [0.128, 0.212, 0.230], w('croup', 0.66, 'hUp' + L, 0.34), {
      rings: R(13), segments: R(18), rough: 0.66, sheen: 0.18, color: HP.coat,
      shape: (u, v) => {
        const a = u * TAU;
        return 1 - Math.max(-Math.cos(a) * s, 0) * 0.34 - THREE.MathUtils.smoothstep(v, 0.66, 1.0) * 0.20;
      },
      colorFn: (u, v, p) => coatColour(p[0], p[1], p[2], Math.cos(v * Math.PI) * 0.8),
    });

    B.tube(resample([
      { p: [0.120 * s, 1.630, -0.560], rx: 0.014, rz: 0.016, bones: w('croup', 1) },
      { p: [0.150 * s, 1.520, -0.548], rx: 0.122, rz: 0.218, bones: w('croup', 0.82, 'hUp' + L, 0.18) },
      { p: [0.186 * s, 1.360, -0.520], rx: 0.152, rz: 0.234, bones: w('croup', 0.30, 'hUp' + L, 0.70) },
      { p: [0.208 * s, 1.220, -0.462], rx: 0.148, rz: 0.198, bones: w('hUp' + L, 1) },
      { p: [0.212 * s, 1.120, -0.412], rx: 0.128, rz: 0.158, bones: w('hUp' + L, 0.65, 'hSti' + L, 0.35) },
      // stifle
      { p: [0.214 * s, 1.030, -0.376], rx: 0.114, rz: 0.136, bones: w('hSti' + L, 1) },
      // gaskin
      { p: [0.214 * s, 0.940, -0.412], rx: 0.099, rz: 0.115, bones: w('hSti' + L, 1) },
      { p: [0.214 * s, 0.858, -0.478], rx: 0.084, rz: 0.096, bones: w('hSti' + L, 1) },
      { p: [0.213 * s, 0.780, -0.536], rx: 0.066, rz: 0.076, bones: w('hSti' + L, 0.62, 'hHoc' + L, 0.38) },
      // hock: the hard angle, with the point of the hock standing behind it
      { p: [0.212 * s, 0.712, -0.582], rx: 0.054, rz: 0.062, bones: w('hSti' + L, 0.30, 'hHoc' + L, 0.70) },
      { p: [0.211 * s, 0.640, -0.604], rx: 0.048, rz: 0.058, bones: w('hHoc' + L, 1) },
      { p: [0.210 * s, 0.560, -0.588], rx: 0.036, rz: 0.043, bones: w('hHoc' + L, 1) },
      { p: [0.209 * s, 0.450, -0.564], rx: 0.031, rz: 0.038, bones: w('hHoc' + L, 1) },
      { p: [0.208 * s, 0.350, -0.541], rx: 0.030, rz: 0.036, bones: w('hHoc' + L, 0.62, 'hCan' + L, 0.38) },
      { p: [0.208 * s, 0.286, -0.527], rx: 0.036, rz: 0.042, bones: w('hCan' + L, 1) },
      { p: [0.208 * s, 0.248, -0.519], rx: 0.040, rz: 0.045, bones: w('hCan' + L, 1) },
      { p: [0.208 * s, 0.196, -0.508], rx: 0.034, rz: 0.039, bones: w('hCan' + L, 1) },
      { p: [0.208 * s, 0.152, -0.499], rx: 0.032, rz: 0.037, bones: w('hCan' + L, 0.55, 'hHf' + L, 0.45) },
      { p: [0.208 * s, 0.126, -0.492], rx: 0.033, rz: 0.038, bones: w('hCan' + L, 0.3, 'hHf' + L, 0.7) },
    ], S(40)), {
      radial: R(20), power: 2.2, rough: 0.74, sheen: 0.22, color: HP.coat,
      radiusFn: (v, u) => {
        const a = u * TAU;
        const back = Math.max(0, -Math.cos(a));
        // point of hock
        const hock = Math.exp(-Math.pow((v - 0.555) / 0.034, 2));
        return 1 + hock * back * 0.30
          + Math.exp(-Math.pow((v - 0.845) / 0.028, 2)) * back * 0.14;    // ergot
      },
      colorFn: (v, u, p) => {
        const c = pointsCol(v, 0.62, 0.76);
        return v < 0.45 ? coatColour(p[0], p[1], p[2], 0.1, { dapple: 0.4 }) : c;
      },
      roughFn: (v) => 0.72 + (v > 0.66 ? 0.06 : 0),
    });

    B.tube(resample([
      { p: [0.208 * s, 0.540, -0.626], rx: 0.013, rz: 0.011, bones: w('hHoc' + L, 1) },
      { p: [0.208 * s, 0.450, -0.602], rx: 0.014, rz: 0.012, bones: w('hHoc' + L, 1) },
      { p: [0.208 * s, 0.350, -0.578], rx: 0.014, rz: 0.012, bones: w('hHoc' + L, 1) },
      { p: [0.208 * s, 0.290, -0.560], rx: 0.011, rz: 0.010, bones: w('hHoc' + L, 0.6, 'hCan' + L, 0.4) },
    ], S(10)), {
      radial: R(9), color: mul(HP.points, 1.12), rough: 0.70,
      colorFn: (v) => mul(HP.points, 1.20 - v * 0.2),
    });
  }

  /* ---- HOOF ---------------------------------------------------------------
   * A wedge, not a can: the wall slopes forward about 50 deg at the toe, the
   * heel is short and upright, there is a coronet band where horn meets hair,
   * and the whole thing is horn — glossier and cooler than hide.
   */
  const hf = (front ? 'fHf' : 'hHf') + L;
  const zc = front ? 0.470 : -0.490;
  const dz = 1;                  // the toe leads on both ends
  B.organic(false);
  B.tube(resample([
    { p: [0.207 * s, 0.132, zc], rx: 0.040, rz: 0.045, bones: w(hf, 1) },
    { p: [0.207 * s, 0.112, zc + 0.004 * dz], rx: 0.047, rz: 0.052, bones: w(hf, 1) },
    { p: [0.207 * s, 0.072, zc + 0.010 * dz], rx: 0.055, rz: 0.062, bones: w(hf, 1) },
    { p: [0.207 * s, 0.034, zc + 0.015 * dz], rx: 0.060, rz: 0.069, bones: w(hf, 1) },
    { p: [0.207 * s, 0.006, zc + 0.017 * dz], rx: 0.061, rz: 0.070, bones: w(hf, 1) },
    { p: [0.207 * s, -0.002, zc + 0.017 * dz], rx: 0.052, rz: 0.060, bones: w(hf, 1) },
  ], S(14)), {
    radial: R(18), power: 2.6, capEnd: true, color: HP.hoof, rough: 0.44, sheen: 0.10, mtype: HARD,
    radiusFn: (v, u) => {
      const a = u * TAU;
      const back = Math.max(0, -Math.cos(a));
      // heel: short and pulled in, so the hoof is a wedge from the side
      return 1 - back * (0.10 + 0.16 * v);
    },
    colorFn: (v, u) => {
      const band = Math.exp(-Math.pow((v - 0.055) / 0.075, 2));
      const stripe = 0.90 + 0.16 * Math.abs(Math.sin(u * TAU * 7.0 + v * 2.0));
      return mix3(mul(HP.hoof, stripe), HP.coronet, band * 0.85);
    },
  });
  B.organic(true);
  void q;
}

/* ========================================================================== */

/**
 * TACK AND KIT — blanket, western saddle, fenders, bags, bedroll, scabbard,
 * lariat, bridle and reins.
 *
 * Carried across from the previous build essentially unchanged: it was not
 * what the critic objected to, and the STIRRUP IRONS at (+-0.320, 1.088,
 * 0.066) are load-bearing — Horse.getSaddle() derives the rider's boot targets
 * from exactly those numbers, so they are frozen.
 */
function buildTack(B, rig, R, S) {
  const w = (a, wa, b, wb) => rig.w(a, wa, b, wb);
  B.organic(false).group(0).surface(HARD).flow(null);
  const arcTop = Math.PI * 1.5;

  B.tube(resample([
    { p: [0, 1.264, 0.360], rx: 0.246, rz: 0.338, bones: w('body', 1) },
    { p: [0, 1.256, 0.140], rx: 0.264, rz: 0.354, bones: w('body', 1) },
    { p: [0, 1.258, -0.090], rx: 0.264, rz: 0.348, bones: w('body', 1) },
    { p: [0, 1.272, -0.310], rx: 0.258, rz: 0.318, bones: w('body', 1) },
  ], S(14)), {
    radial: R(24), power: 2.45, arcStart: arcTop - 1.62, arcEnd: arcTop + 1.62,
    color: HP.blanket, rough: 0.95, sheen: 0.85, mtype: WOVEN,
    radiusFn: () => 1.028,
    colorFn: (v, u) => {
      const d = Math.min(u, 1 - u);
      const band = (d < 0.055 || (d > 0.085 && d < 0.115)) ? 1 : 0;
      const edge = d < 0.02 ? 0.8 : 1;
      return mul(band ? HP.blanket : HP.blanketPale, edge * (0.95 + 0.12 * v));
    },
  });
  B.tube(resample([
    { p: [0, 1.268, 0.300], rx: 0.250, rz: 0.348, bones: w('body', 1) },
    { p: [0, 1.258, 0.150], rx: 0.276, rz: 0.372, bones: w('body', 1) },
    { p: [0, 1.258, -0.010], rx: 0.282, rz: 0.376, bones: w('body', 1) },
    { p: [0, 1.264, -0.170], rx: 0.278, rz: 0.362, bones: w('body', 1) },
    { p: [0, 1.278, -0.290], rx: 0.264, rz: 0.330, bones: w('body', 1) },
  ], S(16)), {
    radial: R(24), power: 2.4, arcStart: arcTop - 1.30, arcEnd: arcTop + 1.30,
    color: HP.saddle, rough: 0.50, sheen: 0.06,
    radiusFn: (v, u) => {
      const top = Math.exp(-Math.pow((u - 0.5) / 0.16, 2));
      const seat = Math.exp(-Math.pow((v - 0.52) / 0.28, 2));
      return 1.0 + 0.05 * (1 - top) - top * seat * 0.055;
    },
    colorFn: (v, u) => {
      const top = Math.exp(-Math.pow((u - 0.5) / 0.22, 2));
      return mul(HP.saddle, 0.86 + 0.30 * top - 0.12 * v);
    },
  });
  B.tube([
    { p: [0, 1.588, -0.268], rx: 0.135, rz: 0.030, bones: w('body', 1) },
    { p: [0, 1.646, -0.292], rx: 0.126, rz: 0.026, bones: w('body', 1) },
    { p: [0, 1.672, -0.306], rx: 0.100, rz: 0.020, bones: w('body', 1) },
  ], { radial: R(15), capEnd: true, color: HP.saddleDark, rough: 0.46, power: 2.4 });
  B.tube([
    { p: [0, 1.590, 0.235], rx: 0.115, rz: 0.090, bones: w('body', 1) },
    { p: [0, 1.648, 0.244], rx: 0.078, rz: 0.062, bones: w('body', 1) },
    { p: [0, 1.688, 0.248], rx: 0.032, rz: 0.028, bones: w('body', 1) },
    { p: [0, 1.716, 0.250], rx: 0.024, rz: 0.022, bones: w('body', 1) },
    { p: [0, 1.734, 0.252], rx: 0.044, rz: 0.038, bones: w('body', 1) },
  ], { radial: R(15), capEnd: true, color: HP.saddleDark, rough: 0.42 });

  for (const s of [1, -1]) {
    B.tube([
      { p: [0.290 * s, 1.480, 0.075], rx: 0.014, rz: 0.040, bones: w('body', 1) },
      { p: [0.312 * s, 1.310, 0.070], rx: 0.014, rz: 0.040, bones: w('body', 1) },
      { p: [0.320 * s, 1.150, 0.066], rx: 0.014, rz: 0.040, bones: w('body', 1) },
    ], { radial: R(9), power: 2.6, color: HP.saddleDark, rough: 0.5 });
    // STIRRUP IRON — frozen geometry, see the note above.
    B.sheet(R(15), 3, (u, v) => {
      const a = u * TAU;
      return {
        p: [0.320 * s + (v - 0.5) * 0.060, 1.088 + Math.sin(a) * 0.066, 0.066 + Math.cos(a) * 0.050],
        bones: w('body', 1),
      };
    }, { wrapU: true, color: HP.steel, rough: 0.34 });
  }
  B.tube(resample([
    { p: [0, 1.258, 0.155], rx: 0.268, rz: 0.358, bones: w('body', 1) },
    { p: [0, 1.256, 0.105], rx: 0.268, rz: 0.358, bones: w('body', 1) },
  ], 3), {
    radial: R(22), power: 2.45, arcStart: Math.PI * 0.5 - 1.15, arcEnd: Math.PI * 0.5 + 1.15,
    color: HP.saddleDark, rough: 0.62, radiusFn: () => 1.035,
  });

  B.tube([
    { p: [-0.235, 1.585, -0.320], rx: 0.086, rz: 0.086, bones: w('body', 1) },
    { p: [-0.120, 1.618, -0.336], rx: 0.096, rz: 0.096, bones: w('body', 1) },
    { p: [0.120, 1.618, -0.336], rx: 0.096, rz: 0.096, bones: w('body', 1) },
    { p: [0.235, 1.585, -0.320], rx: 0.086, rz: 0.086, bones: w('body', 1) },
  ], {
    radial: R(15), capStart: true, capEnd: true, color: HP.canvas, rough: 0.95, sheen: 0.8, mtype: WOVEN,
    colorFn: (v, u) => mul(HP.canvas, 0.86 + 0.26 * Math.abs(Math.sin(u * TAU * 4.0)) * 0.5 + 0.1 * (1 - v)),
  });
  for (const s of [1, -1]) {
    B.tube([
      { p: [-0.240 * s, 1.600, -0.318], rx: 0.014, rz: 0.090, bones: w('body', 1) },
      { p: [-0.245 * s, 1.560, -0.316], rx: 0.014, rz: 0.090, bones: w('body', 1) },
    ], { radial: R(8), power: 2.6, color: HP.saddleDark, rough: 0.5 });
  }
  B.tube(resample([
    { p: [-0.300, 1.470, 0.145], rx: 0.052, rz: 0.030, bones: w('body', 1) },
    { p: [-0.318, 1.395, 0.010], rx: 0.058, rz: 0.034, bones: w('body', 1) },
    { p: [-0.330, 1.310, -0.145], rx: 0.050, rz: 0.030, bones: w('body', 1) },
    { p: [-0.336, 1.262, -0.235], rx: 0.036, rz: 0.024, bones: w('body', 1) },
  ], S(11)), { radial: R(11), power: 2.5, capEnd: true, color: HP.saddleDark, rough: 0.48 });
  B.tube([
    { p: [-0.292, 1.505, 0.208], rx: 0.038, rz: 0.024, bones: w('body', 1) },
    { p: [-0.286, 1.532, 0.258], rx: 0.030, rz: 0.020, bones: w('body', 1) },
    { p: [-0.282, 1.545, 0.290], rx: 0.020, rz: 0.014, bones: w('body', 1) },
  ], { radial: R(9), capEnd: true, color: HP.gunmetal, rough: 0.36 });
  B.sheet(R(26), 6, (u, v) => {
    const a = u * TAU;
    const r = 0.088 + v * 0.010;
    const th = 0.011;
    const b = v * TAU;
    return {
      p: [Math.cos(a) * (r + Math.cos(b) * th) + 0.052,
        1.628 + Math.sin(b) * th - v * 0.006,
        Math.sin(a) * (r + Math.cos(b) * th) * 0.55 + 0.238],
      bones: w('body', 1),
      color: mul(HP.rope, 0.82 + 0.30 * Math.abs(Math.sin(a * 9.0))),
    };
  }, { wrapU: true, color: HP.rope, rough: 0.95, sheen: 0.5, mtype: WOVEN });

  for (const s of [1, -1]) {
    B.sheet(5, R(10), (u, v) => {
      const wd = 0.075 + v * 0.020 - Math.pow(v, 4) * 0.055;
      const y = 1.500 - v * 0.400;
      const z = 0.086 - v * 0.020 + (u - 0.5) * wd * 2.0;
      const bulge = Math.sin(u * Math.PI) * 0.014 * (1 - v * 0.4);
      return {
        p: [(0.286 + bulge) * s, y, z],
        bones: w('body', 1),
        color: mul(HP.saddleDark, 0.90 + 0.30 * Math.sin(u * Math.PI) - 0.10 * v),
      };
    }, { color: HP.saddleDark, rough: 0.46 });
  }

  for (const s of [1, -1]) {
    B.box([0.212 * s, 1.398, -0.386], [0.052, 0.108, 0.088], w('body', 1), {
      color: mul(HP.saddle, 0.82), rough: 0.52, bevel: 0.30,
      rotation: new THREE.Euler(0.10, 0, -0.16 * s),
    });
    B.box([0.216 * s, 1.500, -0.382], [0.058, 0.030, 0.094], w('body', 1), {
      color: HP.saddleDark, rough: 0.44, bevel: 0.36,
      rotation: new THREE.Euler(0.10, 0, -0.16 * s),
    });
    B.box([0.252 * s, 1.452, -0.372], [0.010, 0.014, 0.011], w('body', 1),
      { color: HP.steel, rough: 0.30, bevel: 0.4 });
  }
  B.tube(resample([
    { p: [0.185, 1.520, -0.372], rx: 0.010, rz: 0.026, bones: w('body', 1) },
    { p: [0, 1.556, -0.366], rx: 0.010, rz: 0.026, bones: w('body', 1) },
    { p: [-0.185, 1.520, -0.372], rx: 0.010, rz: 0.026, bones: w('body', 1) },
  ], S(10)), { radial: R(7), color: HP.saddleDark, rough: 0.46 });

  /* bridle: cheek pieces, noseband, browband, bit and reins */
  for (const s of [1, -1]) {
    B.tube([
      { p: [0.082 * s, 2.020, 1.022], rx: 0.009, rz: 0.016, bones: w('head', 1) },
      { p: [0.100 * s, 1.900, 1.150], rx: 0.009, rz: 0.016, bones: w('head', 1) },
      { p: [0.082 * s, 1.756, 1.320], rx: 0.009, rz: 0.016, bones: w('head', 1) },
    ], { radial: R(7), color: HP.saddleDark, rough: 0.5 });
  }
  B.sheet(R(15), 2, (u, v) => {
    const a = u * TAU;
    return {
      p: [Math.sin(a) * 0.072, 1.752 + Math.cos(a) * 0.064 + v * 0.022, 1.324 + Math.cos(a) * 0.010],
      bones: w('head', 1),
    };
  }, { wrapU: true, color: HP.saddleDark, rough: 0.5 });
  B.tube(resample([
    { p: [0.088, 1.678, 1.404], rx: 0.008, rz: 0.014, bones: w('head', 1) },
    { p: [0.140, 1.700, 1.180], rx: 0.008, rz: 0.014, bones: w('head', 0.5, 'neck3', 0.5) },
    { p: [0.175, 1.660, 0.900], rx: 0.008, rz: 0.014, bones: w('neck2', 1) },
    { p: [0.180, 1.628, 0.620], rx: 0.008, rz: 0.014, bones: w('neck1', 0.6, 'chest', 0.4) },
    { p: [0.120, 1.690, 0.330], rx: 0.008, rz: 0.014, bones: w('body', 1) },
    { p: [0.030, 1.724, 0.256], rx: 0.008, rz: 0.014, bones: w('body', 1) },
  ], S(22)), { radial: R(7), color: HP.saddleDark, rough: 0.5 });
  B.organic(true);
}
