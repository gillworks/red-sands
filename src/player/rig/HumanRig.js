import * as THREE from 'three';
import { SkinBuilder, resample } from './SkinBuilder.js';
import { Rig, top2 } from './Rig.js';

/**
 * RED SANDS — THE RIDER
 * ============================================================================
 * A 1.80 m procedural gunslinger. Seven-and-a-half heads tall, built as one
 * SkinnedMesh in two material groups (solid / double-sided cloth) so the whole
 * figure is two draw calls.
 *
 * Layered silhouette, outside in:
 *   wide-brim felt hat (curled sides, dipped front, leather band)
 *   open canvas duster, flared skirt on three secondary-motion bones
 *   chambray shirt + neckerchief, gunbelt with holster, shoulder satchel
 *   wool trousers, tall riding boots with stacked heels
 * ============================================================================
 */

/** sRGB hex -> linear HDR triple. Everything in this project is authored linear. */
function lin(hex) {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const f = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return [f(r), f(g), f(b)];
}
function mul(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }

export const PAL = {
  hat: lin(0x554a3a),
  hatBand: lin(0x2a211a),
  coat: lin(0x5b503a),
  coatDark: lin(0x413928),
  shirt: lin(0x60707d),
  scarf: lin(0x6b3226),
  trouser: lin(0x333941),
  boot: lin(0x2f2219),
  leather: lin(0x5b4630),
  leatherDark: lin(0x3d2f21),
  skin: lin(0xb08761),
  skinShade: lin(0x8d6a4c),
  hair: lin(0x3b2c1f),
  brass: lin(0x8a6a33),
  steel: lin(0x555a5e),
};

export const PROP = {
  height: 1.80,
  hipY: 0.92,
  eyeY: 1.62,
  legL1: 0.435,
  legL2: 0.415,
  armL1: 0.300,
  armL2: 0.266,
  ankleY: 0.050,
  footFwd: 0.075,
  shoulderY: 1.435,
};

/** Build the skeleton. Returns a Rig with every bone declared. */
export function buildHumanRig() {
  const r = new Rig();
  r.bone('root', null, [0, 0, 0]);
  r.bone('hips', 'root', [0, 0.92, 0]);
  r.bone('spine', 'hips', [0, 0.14, 0]);
  r.bone('chest', 'spine', [0, 0.22, 0]);
  r.bone('neck', 'chest', [0, 0.20, 0.006]);
  r.bone('head', 'neck', [0, 0.09, 0.012]);
  r.bone('hat', 'head', [0, 0.14, -0.008]);

  for (const s of [1, -1]) {
    const L = s > 0 ? 'L' : 'R';
    r.bone('clav' + L, 'chest', [0.055 * s, 0.155, 0]);
    r.bone('arm' + L, 'clav' + L, [0.135 * s, -0.010, 0]);
    r.bone('fore' + L, 'arm' + L, [0.028 * s, -0.2985, 0.005]);
    r.bone('hand' + L, 'fore' + L, [0.018 * s, -0.2655, 0.010]);
    r.bone('thigh' + L, 'hips', [0.098 * s, -0.020, 0]);
    r.bone('shin' + L, 'thigh' + L, [0.006 * s, -0.4350, 0.005]);
    r.bone('foot' + L, 'shin' + L, [0, -0.4148, -0.012]);
    r.bone('toe' + L, 'foot' + L, [0, -0.012, 0.135]);
  }
  // coat skirt secondary motion
  r.bone('coatR', 'hips', [-0.11, -0.02, 0.05]);
  r.bone('coatB', 'hips', [0, -0.02, -0.12]);
  r.bone('coatL', 'hips', [0.11, -0.02, 0.05]);
  r.bone('satchel', 'hips', [0.19, -0.05, -0.05]);
  return r;
}

/* ------------------------------------------------------------------ helpers */

/** Surface classes understood by CharMaterial (see SkinBuilder.surface). */
const HARD = 0, WOVEN = 1, HIDE = 2, STRAND = 3;

const TAU = Math.PI * 2;
function angDist(a) { const d = Math.abs(((a + Math.PI) % TAU + TAU) % TAU - Math.PI); return d; }

/**
 * Build the mesh geometry for the rig above.
 * @returns {THREE.BufferGeometry}
 */
export function buildHumanGeometry(rig) {
  const B = new SkinBuilder();
  const w = (a, wa, b, wb) => rig.w(a, wa, b, wb);
  const iHips = rig.id('hips'), iSpine = rig.id('spine'), iChest = rig.id('chest');
  const iCoatL = rig.id('coatL'), iCoatR = rig.id('coatR'), iCoatB = rig.id('coatB');

  /* =============================================================== SHIRT */
  B.group(0);
  B.tube(resample([
    { p: [0, 0.855, 0.005], rx: 0.115, rz: 0.150, bones: w('hips', 1) },
    { p: [0, 0.965, 0.004], rx: 0.107, rz: 0.145, bones: w('hips', 0.55, 'spine', 0.45) },
    { p: [0, 1.090, 0.006], rx: 0.113, rz: 0.155, bones: w('spine', 1) },
    { p: [0, 1.235, 0.008], rx: 0.126, rz: 0.180, bones: w('spine', 0.35, 'chest', 0.65) },
    { p: [0, 1.370, 0.004], rx: 0.118, rz: 0.178, bones: w('chest', 1) },
    { p: [0, 1.455, -0.002], rx: 0.090, rz: 0.135, bones: w('chest', 0.8, 'neck', 0.2) },
    { p: [0, 1.495, 0.000], rx: 0.055, rz: 0.062, bones: w('neck', 1) },
  ], 20), {
    radial: 18, power: 2.2, color: PAL.shirt, rough: 0.94, sheen: 0.75, mtype: WOVEN,
    capStart: true,
    colorFn: (v, u) => (v > 0.82 ? mul(PAL.shirt, 0.82) : PAL.shirt),
  });

  /* ============================================================== NECK/HEAD */
  B.tube([
    { p: [0, 1.455, 0.006], rx: 0.052, rz: 0.058, bones: w('chest', 0.4, 'neck', 0.6) },
    { p: [0, 1.520, 0.010], rx: 0.048, rz: 0.052, bones: w('neck', 1) },
    { p: [0, 1.560, 0.012], rx: 0.050, rz: 0.055, bones: w('neck', 0.4, 'head', 0.6) },
  ], { radial: 14, color: PAL.skinShade, rough: 0.72, sheen: 0.1 });

  const headBones = w('head', 1);
  B.blob([0, 1.617, 0.008], [0.089, 0.108, 0.098], headBones, {
    rings: 18, segments: 22, rough: 0.66, sheen: 0.08,
    shape: (u, v, x, y, z) => {
      // u: 0 = +X (left), 0.25 = +Z (front). v: 0 top, 1 bottom.
      const a = u * TAU;
      const fwd = Math.sin(a);                       // +1 at the face
      let m = 1;
      // jaw / chin: pull the lower front forward and narrow the skull base
      const low = THREE.MathUtils.smoothstep(v, 0.52, 0.95);
      m += low * Math.max(fwd, 0) * 0.16;
      m -= low * 0.10 * (1 - Math.max(fwd, 0) * 0.4);
      // brow ridge
      const brow = Math.exp(-Math.pow((v - 0.46) / 0.07, 2)) * Math.max(fwd, 0);
      m += brow * 0.045;
      // cheekbones
      const cheek = Math.exp(-Math.pow((v - 0.60) / 0.10, 2)) * Math.pow(Math.max(Math.abs(Math.cos(a)), 0), 1.5);
      m += cheek * 0.035;
      // flatten the back of the skull very slightly
      m -= Math.max(-fwd, 0) * 0.03;
      return m;
    },
    colorFn: (u, v, p) => {
      const a = u * TAU;
      const fwd = Math.sin(a);
      // hair + stubble, and shadowed eye sockets under the brim
      if (v < 0.30 || (v < 0.44 && fwd < 0.25)) return PAL.hair;
      const beard = THREE.MathUtils.smoothstep(v, 0.60, 0.74) * Math.max(fwd, 0);
      const socket = Math.exp(-Math.pow((v - 0.505) / 0.045, 2))
        * Math.exp(-Math.pow((Math.abs(Math.cos(a)) - 0.42) / 0.22, 2)) * Math.max(fwd, 0.0);
      let c = PAL.skin;
      c = [
        c[0] * (1 - beard * 0.55) * (1 - socket * 0.62),
        c[1] * (1 - beard * 0.52) * (1 - socket * 0.62),
        c[2] * (1 - beard * 0.45) * (1 - socket * 0.58),
      ];
      return c;
    },
  });
  // ears
  for (const s of [1, -1]) {
    B.blob([0.083 * s, 1.618, -0.010], [0.020, 0.031, 0.017], headBones,
      { rings: 6, segments: 8, color: PAL.skinShade, rough: 0.7 });
  }
  // hat-flattened hair at the nape
  B.blob([0, 1.585, -0.036], [0.086, 0.058, 0.062], headBones,
    { rings: 8, segments: 12, color: PAL.hair, rough: 0.92, sheen: 0.4 });

  /* ================================================================== HAT
   * Wide-brim open-road: 0.47 m across the brim, sides curled, front dipped,
   * a low crown with a centre crease and two finger pinches. The brim width is
   * doing most of the silhouette work — a narrow brim reads as a bowler.
   */
  const hatB = w('hat', 1);
  const HATY = 1.668, HATZ = -0.006;
  B.tube(resample([
    { p: [0, HATY - 0.004, HATZ], rx: 0.103, rz: 0.110, bones: hatB },
    { p: [0, HATY + 0.060, HATZ], rx: 0.101, rz: 0.108, bones: hatB },
    { p: [0, HATY + 0.128, HATZ - 0.002], rx: 0.099, rz: 0.105, bones: hatB },
    { p: [0, HATY + 0.168, HATZ - 0.004], rx: 0.094, rz: 0.099, bones: hatB },
    { p: [0, HATY + 0.190, HATZ - 0.004], rx: 0.076, rz: 0.081, bones: hatB },
    { p: [0, HATY + 0.199, HATZ - 0.004], rx: 0.040, rz: 0.044, bones: hatB },
    { p: [0, HATY + 0.202, HATZ - 0.004], rx: 0.012, rz: 0.013, bones: hatB },
  ], 18), {
    radial: 28, color: PAL.hat, rough: 0.96, sheen: 0.95, capEnd: true, mtype: WOVEN,
    radiusFn: (v, u) => {
      const a = u * TAU;
      const crease = Math.exp(-Math.pow(angDist(a) / 0.38, 2));
      const pinchL = Math.exp(-Math.pow(angDist(a - Math.PI * 0.5) / 0.34, 2));
      const pinchR = Math.exp(-Math.pow(angDist(a + Math.PI * 0.5) / 0.34, 2));
      const up = THREE.MathUtils.smoothstep(v, 0.24, 0.95);
      return 1 - up * (crease * 0.24 + (pinchL + pinchR) * 0.15);
    },
    colorFn: (v) => mul(PAL.hat, 0.90 + v * 0.20),
  });
  // sweat-stained leather band
  B.sheet(28, 3, (u, vv) => {
    const a = u * TAU;
    return {
      p: [Math.sin(a) * 0.108, HATY + 0.006 + vv * 0.030, HATZ + Math.cos(a) * 0.115],
      bones: hatB,
      color: mul(PAL.hatBand, 0.85 + vv * 0.4),
    };
  }, { wrapU: true, color: PAL.hatBand, rough: 0.55, sheen: 0.1 });
  // brim: top surface outward, then the underside back in
  B.sheet(34, 14, (u, vv) => {
    const a = u * TAU;
    const t = vv <= 0.5 ? vv * 2 : (1 - vv) * 2;
    const side = vv <= 0.5 ? 1 : -1;
    const inner = 0.104;
    const outer = 0.238 + 0.010 * Math.cos(2 * a) - 0.014 * Math.cos(a);
    const rad = inner + (outer - inner) * t;
    const s = Math.sin(a), c = Math.cos(a);
    // gentle side curl — overdo this and the brim reads as a pair of horns
    const curl = 0.042 * (s * s) * Math.pow(t, 2.2);
    const dipF = 0.034 * Math.max(c, 0) * Math.pow(t, 1.5);
    const dipB = 0.014 * Math.max(-c, 0) * Math.pow(t, 1.6);
    const wobble = 0.005 * Math.sin(a * 3.0 + 0.7) * Math.pow(t, 2.0);
    const th = 0.0105 * (1 - t * 0.45);
    return {
      p: [s * rad, HATY + 0.004 + curl - dipF - dipB + wobble + side * th, HATZ + c * rad],
      bones: hatB,
      color: side > 0 ? mul(PAL.hat, 1.08) : mul(PAL.hat, 0.66),
      rough: side > 0 ? 0.96 : 0.99,
    };
  }, { wrapU: true, color: PAL.hat, rough: 0.96, sheen: 0.9, mtype: WOVEN });

  /* ============================================================ NECKERCHIEF */
  B.tube([
    { p: [0, 1.452, 0.004], rx: 0.062, rz: 0.070, bones: w('chest', 0.35, 'neck', 0.65) },
    { p: [0, 1.492, 0.008], rx: 0.056, rz: 0.062, bones: w('neck', 1) },
    { p: [0, 1.512, 0.010], rx: 0.049, rz: 0.054, bones: w('neck', 1) },
  ], { radial: 16, color: PAL.scarf, rough: 0.93, sheen: 0.85, mtype: WOVEN });
  B.blob([0, 1.450, 0.062], [0.028, 0.030, 0.026], w('neck', 1),
    { rings: 6, segments: 8, color: PAL.scarf, rough: 0.93, sheen: 0.85, mtype: WOVEN });

  /* ================================================================= ARMS */
  for (const s of [1, -1]) {
    const L = s > 0 ? 'L' : 'R';
    B.tube(resample([
      { p: [0.070 * s, 1.462, 0], rx: 0.092, rz: 0.090, bones: w('clav' + L, 0.6, 'chest', 0.4) },
      { p: [0.182 * s, 1.448, 0], rx: 0.087, rz: 0.084, bones: w('clav' + L, 0.45, 'arm' + L, 0.55) },
      { p: [0.222 * s, 1.330, 0.002], rx: 0.072, rz: 0.068, bones: w('arm' + L, 1) },
      { p: [0.240 * s, 1.190, 0.004], rx: 0.062, rz: 0.059, bones: w('arm' + L, 1) },
      { p: [0.248 * s, 1.128, 0.005], rx: 0.059, rz: 0.056, bones: w('arm' + L, 0.5, 'fore' + L, 0.5) },
      { p: [0.258 * s, 1.010, 0.008], rx: 0.052, rz: 0.050, bones: w('fore' + L, 1) },
      { p: [0.266 * s, 0.900, 0.012], rx: 0.046, rz: 0.044, bones: w('fore' + L, 1) },
      { p: [0.268 * s, 0.868, 0.014], rx: 0.043, rz: 0.041, bones: w('fore' + L, 0.55, 'hand' + L, 0.45) },
    ], 22), {
      radial: 14, color: PAL.coat, rough: 0.93, sheen: 0.6, mtype: WOVEN,
      colorFn: (v) => (v > 0.93 ? PAL.coatDark : mul(PAL.coat, 1.04 - v * 0.10)),
    });
    // hand
    B.blob([0.271 * s, 0.812, 0.020], [0.036, 0.062, 0.028], w('hand' + L, 1), {
      rings: 8, segments: 10, color: PAL.skin, rough: 0.68,
      shape: (u, v) => {
        const a = u * TAU;
        // thumb pad on the inboard side, taper toward the fingertips
        const thumb = Math.exp(-Math.pow((v - 0.42) / 0.15, 2)) * Math.max(-Math.cos(a) * s, 0);
        return 1 + thumb * 0.30 - THREE.MathUtils.smoothstep(v, 0.72, 1.0) * 0.18;
      },
      colorFn: (u, v) => (v > 0.55 ? PAL.skin : PAL.skinShade),
    });
  }

  /* ================================================================= LEGS */
  for (const s of [1, -1]) {
    const L = s > 0 ? 'L' : 'R';
    B.tube(resample([
      { p: [0.098 * s, 0.930, 0], rx: 0.092, rz: 0.098, bones: w('hips', 0.5, 'thigh' + L, 0.5) },
      { p: [0.100 * s, 0.800, 0.004], rx: 0.086, rz: 0.088, bones: w('thigh' + L, 1) },
      { p: [0.103 * s, 0.640, 0.008], rx: 0.076, rz: 0.076, bones: w('thigh' + L, 1) },
      { p: [0.104 * s, 0.480, 0.006], rx: 0.067, rz: 0.068, bones: w('thigh' + L, 0.45, 'shin' + L, 0.55) },
      { p: [0.104 * s, 0.360, 0.000], rx: 0.064, rz: 0.065, bones: w('shin' + L, 1) },
      { p: [0.104 * s, 0.250, -0.004], rx: 0.061, rz: 0.062, bones: w('shin' + L, 1) },
    ], 16), { radial: 14, color: PAL.trouser, rough: 0.95, sheen: 0.8, power: 2.1, mtype: WOVEN });

    // boot: shaft, ankle break, toe
    B.tube(resample([
      { p: [0.104 * s, 0.400, -0.004], rx: 0.077, rz: 0.078, bones: w('shin' + L, 1) },
      { p: [0.104 * s, 0.300, -0.002], rx: 0.072, rz: 0.073, bones: w('shin' + L, 1) },
      { p: [0.104 * s, 0.170, 0.004], rx: 0.068, rz: 0.068, bones: w('shin' + L, 0.72, 'foot' + L, 0.28) },
      { p: [0.104 * s, 0.086, 0.024], rx: 0.066, rz: 0.064, bones: w('foot' + L, 1) },
      { p: [0.104 * s, 0.048, 0.110], rx: 0.056, rz: 0.058, bones: w('foot' + L, 1) },
      { p: [0.104 * s, 0.042, 0.185], rx: 0.043, rz: 0.050, bones: w('foot' + L, 0.6, 'toe' + L, 0.4) },
      { p: [0.104 * s, 0.046, 0.212], rx: 0.020, rz: 0.030, bones: w('toe' + L, 1) },
    ], 18), {
      radial: 14, power: 2.5, color: PAL.boot, rough: 0.58, sheen: 0.08,
      capEnd: true,
      colorFn: (v) => (v < 0.16 ? mul(PAL.boot, 1.25) : PAL.boot),
    });
    // stacked heel
    B.box([0.104 * s, 0.020, -0.012], [0.050, 0.021, 0.052], w('foot' + L, 1),
      { color: PAL.leatherDark, rough: 0.62, bevel: 0.35 });
    // spur strap
    B.sheet(12, 2, (u, vv) => {
      const a = u * TAU;
      return {
        p: [0.104 * s + Math.sin(a) * 0.070, 0.108 + vv * 0.016 + Math.cos(a) * 0.010, 0.014 + Math.cos(a) * 0.072],
        bones: w('foot' + L, 1),
      };
    }, { wrapU: true, color: PAL.leatherDark, rough: 0.5 });
  }

  /* ================================================================= BELT */
  B.sheet(24, 3, (u, vv) => {
    const a = u * TAU;
    return {
      p: [Math.sin(a) * 0.163, 0.905 + vv * 0.062, 0.004 + Math.cos(a) * 0.126],
      bones: w('hips', 1),
    };
  }, { wrapU: true, color: PAL.leather, rough: 0.52, sheen: 0.05 });
  B.box([0, 0.936, 0.132], [0.030, 0.024, 0.012], w('hips', 1),
    { color: PAL.brass, rough: 0.34, bevel: 0.4 });

  /* ============================================================== HOLSTER */
  B.box([-0.172, 0.815, 0.018], [0.030, 0.078, 0.042], w('hips', 1),
    { color: PAL.leatherDark, rough: 0.48, bevel: 0.3, rotation: new THREE.Euler(0.14, 0, -0.10) });
  B.tube([
    { p: [-0.170, 0.905, -0.010], rx: 0.017, rz: 0.026, bones: w('hips', 1) },
    { p: [-0.176, 0.955, -0.032], rx: 0.015, rz: 0.024, bones: w('hips', 1) },
  ], { radial: 8, color: PAL.leatherDark, rough: 0.45, capEnd: true });

  /* ============================================================== SATCHEL */
  B.box([0.196, 0.808, -0.092], [0.044, 0.072, 0.094], w('satchel', 0.8, 'hips', 0.2),
    { color: PAL.leather, rough: 0.55, bevel: 0.22, rotation: new THREE.Euler(0, 0.10, -0.06) });
  B.box([0.196, 0.876, -0.092], [0.049, 0.024, 0.101], w('satchel', 0.8, 'hips', 0.2),
    { color: PAL.leatherDark, rough: 0.5, bevel: 0.3, rotation: new THREE.Euler(0, 0.10, -0.06) });
  // shoulder strap, right shoulder to left hip
  B.tube(resample([
    { p: [-0.090, 1.452, -0.030], rx: 0.010, rz: 0.028, bones: w('chest', 1) },
    { p: [-0.020, 1.330, 0.098], rx: 0.010, rz: 0.030, bones: w('chest', 0.8, 'spine', 0.2) },
    { p: [0.090, 1.150, 0.110], rx: 0.010, rz: 0.030, bones: w('spine', 0.8, 'hips', 0.2) },
    { p: [0.170, 0.960, 0.030], rx: 0.010, rz: 0.028, bones: w('hips', 1) },
    { p: [0.196, 0.880, -0.055], rx: 0.010, rz: 0.026, bones: w('hips', 0.6, 'satchel', 0.4) },
  ], 16), { radial: 8, color: PAL.leather, rough: 0.5, power: 2.6 });

  /* ================================================================= COAT
   * Built as a parametric shell rather than a swept tube so the hem can be
   * irregular, the cloth can carry vertical drape folds, and the back can be
   * split by a riding vent — three things a straight lathe cannot express and
   * all three of which are what stops it reading as a paper cone.
   */
  B.group(1);
  const CO = [
    { y: 1.474, rx: 0.128, rz: 0.186, b: w('chest', 1) },
    { y: 1.392, rx: 0.146, rz: 0.208, b: w('chest', 1) },
    { y: 1.250, rx: 0.146, rz: 0.202, b: w('chest', 0.6, 'spine', 0.4) },
    { y: 1.100, rx: 0.138, rz: 0.190, b: w('spine', 0.7, 'hips', 0.3) },
    { y: 0.975, rx: 0.134, rz: 0.184, b: w('hips', 1) },
    { y: 0.860, rx: 0.152, rz: 0.204, b: w('hips', 1) },
    { y: 0.735, rx: 0.176, rz: 0.228, b: w('hips', 1) },
    { y: 0.625, rx: 0.192, rz: 0.246, b: w('hips', 1) },
    { y: 0.588, rx: 0.194, rz: 0.248, b: w('hips', 1) },
  ];
  const GAP = 0.30;                    // half-angle of the open front
  B.sheet(34, 26, (u, v) => {
    const f = v * (CO.length - 1);
    const i = Math.min(CO.length - 2, Math.floor(f));
    const t = f - i;
    const s0 = CO[i], s1 = CO[i + 1];
    const drop = THREE.MathUtils.smoothstep(v, 0.34, 1.0);

    // fold field: broad drape folds that deepen toward the hem
    const a = GAP + (TAU - 2 * GAP) * u;
    const folds = (Math.sin(a * 6.0 + 0.6) * 0.55 + Math.sin(a * 11.0 + 2.4) * 0.34
      + Math.sin(a * 3.0 - 1.1) * 0.40 + Math.sin(a * 17.0 + 0.3) * 0.16)
      * (0.75 + 0.45 * Math.sin(v * 5.0 + a * 2.0));
    // horizontal creases where the cloth gathers over the hips and the belt
    const gather = Math.sin(v * 13.0 + Math.sin(a * 4.0) * 1.4) * 0.010
      * THREE.MathUtils.smoothstep(v, 0.18, 0.55) * (1.0 - drop * 0.5);
    // Deepened: with baked occlusion now shading the troughs, a fold at the
    // old 4 cm amplitude read as a ripple. Heavy canvas hangs in 6 cm folds.
    // Still gated entirely by `drop` so nothing displaces under the yoke.
    const fold = folds * 0.058 * drop + gather;
    // back riding vent: the cloth parts behind the legs
    const vent = Math.exp(-Math.pow(angDist(a - Math.PI) / 0.11, 2))
      * THREE.MathUtils.smoothstep(v, 0.62, 1.0) * 0.055;

    const rx = (s0.rx + (s1.rx - s0.rx) * t) * (1 + fold / 0.16) - vent;
    const rz = (s0.rz + (s1.rz - s0.rz) * t) * (1 + fold / 0.20);
    // irregular, weighted hem
    const hemWave = drop * drop * (0.030 * Math.sin(a * 3.4 + 1.1)
      + 0.016 * Math.sin(a * 7.9 - 0.4) + 0.010 * Math.sin(a * 13.0));
    const y = (s0.y + (s1.y - s0.y) * t) - hemWave;

    // bone blend: the skirt rides three secondary-motion bones
    const sk = THREE.MathUtils.smoothstep(v, 0.40, 0.90);
    let bones = s0.b;
    if (sk > 0.001) {
      const tri = (c) => Math.max(0, 1 - Math.abs(u - c) / 0.42);
      const wL = tri(0.06), wB = tri(0.5), wR = tri(0.94);
      const tot = Math.max(1e-4, wR + wB + wL);
      const list = s0.b.map(([bi, bw]) => [bi, bw * (1 - sk)]);
      list.push([iCoatR, (wR / tot) * sk], [iCoatB, (wB / tot) * sk], [iCoatL, (wL / tot) * sk]);
      bones = top2(list);
    }
    const k = 1.0 + (1 - v) * 0.12 - THREE.MathUtils.smoothstep(v, 0.70, 1.0) * 0.26
      + folds * 0.075;
    const edge = (u < 0.045 || u > 0.955) ? 0.84 : 1.0;
    return {
      p: [Math.sin(a) * rz, y, 0.008 + Math.cos(a) * rx],
      bones,
      color: mul(PAL.coat, k * edge),
    };
  }, { color: PAL.coat, rough: 0.93, sheen: 0.72, mtype: WOVEN });
  // collar standing at the neck
  B.sheet(18, 4, (u, vv) => {
    const a = 0.42 + (TAU - 0.84) * u;
    const rise = 0.055 * (0.35 + 0.65 * Math.pow(Math.abs(Math.cos(a * 0.5)), 0.6));
    const rad = 0.086 + vv * 0.030;
    return {
      p: [Math.sin(a) * (rad + 0.030), 1.452 + vv * rise, 0.002 + Math.cos(a) * rad],
      bones: w('chest', 0.5, 'neck', 0.5),
      color: mul(PAL.coat, 0.92 + vv * 0.16),
    };
  }, { color: PAL.coat, rough: 0.93, sheen: 0.7, mtype: WOVEN });
  // lapels folded back over the chest
  for (const s of [1, -1]) {
    B.sheet(4, 8, (u, vv) => {
      const spread = 0.052 + vv * 0.10;
      const x = s * (0.030 + spread * (0.35 + u * 0.9));
      const y = 1.462 - vv * 0.30;
      const z = 0.118 - vv * 0.030 - u * 0.052 * (1 - vv * 0.4);
      return { p: [x, y, z], bones: w('chest', 1 - vv * 0.4, 'spine', vv * 0.4) };
    }, { color: mul(PAL.coat, 0.82), rough: 0.93, sheen: 0.7, mtype: WOVEN });
  }

  /* ---- TAILORING. Buttons, a raised placket, cuffs and pocket flaps. Each
   * one is a few dozen triangles and together they are what stops the duster
   * reading as a paper cone: the eye needs man-made straight lines and hard
   * small highlights sitting on top of the soft cloth drape to believe it is a
   * garment. Costs ~600 triangles. */
  {
    // placket: a raised strip down the wearer's right front edge
    B.sheet(3, 12, (u, vv) => {
      const y = 1.430 - vv * 0.520;
      const t = vv;
      const rz = 0.196 + t * 0.030;
      const a = 0.30 + (u - 0.5) * 0.115;
      return {
        p: [Math.sin(a) * (0.140 + t * 0.026), y, 0.008 + Math.cos(a) * rz + 0.008],
        bones: w('chest', Math.max(0, 1 - t * 1.6), 'hips', Math.min(1, t * 1.6)),
        color: mul(PAL.coat, 1.06 - 0.10 * Math.abs(u - 0.5) * 2 - t * 0.06),
      };
    }, { color: PAL.coat, rough: 0.92, sheen: 0.7, mtype: WOVEN });
    // buttons down the placket
    for (let i = 0; i < 5; i++) {
      const t = 0.055 + i * 0.155;
      const y = 1.430 - t * 0.520;
      const a = 0.30;
      const rz = 0.196 + t * 0.030;
      B.blob([Math.sin(a) * (0.150 + t * 0.026), y, 0.020 + Math.cos(a) * rz],
        [0.0125, 0.0125, 0.006], w('chest', Math.max(0, 1 - t * 1.6), 'hips', Math.min(1, t * 1.6)),
        { rings: 4, segments: 8, color: mul(PAL.hatBand, 1.5), rough: 0.38, mtype: HARD });
    }
    // patch pockets with a flap, both hips
    for (const s of [1, -1]) {
      B.sheet(4, 3, (u, vv) => {
        const a = s * (0.72 + u * 0.46);
        const y = 0.905 - vv * 0.050;
        const rz = 0.196, rx = 0.146;
        return {
          p: [Math.sin(a) * (rz + 0.012), y, 0.008 + Math.cos(a) * (rx + 0.012)],
          bones: w('hips', 1),
          color: mul(PAL.coat, 0.86 + 0.16 * (1 - vv)),
        };
      }, { color: PAL.coat, rough: 0.93, sheen: 0.7, mtype: WOVEN });
    }
    // cuffs: a turned-back band at each wrist
    for (const s of [1, -1]) {
      const L = s > 0 ? 'L' : 'R';
      B.tube([
        { p: [0.264 * s, 0.918, 0.010], rx: 0.050, rz: 0.048, bones: w('fore' + L, 1) },
        { p: [0.267 * s, 0.878, 0.013], rx: 0.052, rz: 0.050, bones: w('fore' + L, 0.7, 'hand' + L, 0.3) },
        { p: [0.268 * s, 0.862, 0.014], rx: 0.047, rz: 0.045, bones: w('fore' + L, 0.55, 'hand' + L, 0.45) },
      ], {
        radial: 14, color: mul(PAL.coat, 0.88), rough: 0.92, sheen: 0.65, mtype: WOVEN,
        colorFn: (v) => mul(PAL.coat, 0.82 + 0.26 * (1 - v)),
      });
    }
  }

  /* ---- shoulder yoke: the cape a duster carries over the shoulders. It is
   * the one feature that breaks the coat's silhouette into two masses instead
   * of one bell, and it catches a hard rim from a low sun. */
  B.sheet(34, 10, (u, v) => {
    const a = GAP * 0.72 + (TAU - 2 * GAP * 0.72) * u;
    const f = v;
    const rx = 0.150 + f * 0.030 + Math.sin(a * 5.0) * 0.006 * f;
    const rz = 0.212 + f * 0.040 + Math.sin(a * 7.0 + 1.0) * 0.008 * f;
    const y = 1.482 - f * 0.242 - 0.022 * Math.sin(a * 3.0) * f * f;
    return {
      p: [Math.sin(a) * rz, y, 0.008 + Math.cos(a) * rx],
      bones: w('chest', 1 - v * 0.25, 'spine', v * 0.25),
      color: mul(PAL.coat, 0.98 + (1 - v) * 0.16 + Math.sin(a * 5.0) * 0.04),
    };
  }, { color: PAL.coat, rough: 0.93, sheen: 0.72, mtype: WOVEN });

  return B.build();
}
