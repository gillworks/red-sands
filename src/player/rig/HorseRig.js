import * as THREE from 'three';
import { SkinBuilder, resample } from './SkinBuilder.js';
import { Rig } from './Rig.js';

/**
 * RED SANDS — THE HORSE
 * ============================================================================
 * A bay saddle horse, 1.60 m at the withers, ~2.5 m nose to tail. Built to the
 * same one-mesh/two-group recipe as the rider.
 *
 * Anatomy that had to be right or it reads as a dog: the barrel is deeper than
 * it is wide, the neck is a deep narrow wedge not a cylinder, the hind leg
 * zig-zags stifle-forward / hock-backward, the front leg is near-vertical, the
 * cannon bones are thin, and the head is a 0.58 m wedge with a defined jaw.
 * ============================================================================
 */

function lin(hex) {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const f = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return [f(r), f(g), f(b)];
}
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

export const HPAL = {
  coat: lin(0x54371f),
  coatLit: lin(0x6b4527),
  belly: lin(0x6a4b2f),
  points: lin(0x362a1d),
  muzzle: lin(0x2f2318),
  hoof: lin(0x3c352c),
  mane: lin(0x30251a),
  saddle: lin(0x5a3d24),
  saddleDark: lin(0x3b2716),
  blanket: lin(0x6d4736),
  blanketPale: lin(0x8f8068),
  steel: lin(0x6a6f74),
};

export const HORSE_PROP = {
  withers: 1.60,
  frontFootZ: 0.46,
  hindFootZ: -0.50,
  footX: 0.21,
  saddleY: 1.62,
  saddleZ: 0.05,
};

export function buildHorseRig() {
  const r = new Rig();
  r.bone('root', null, [0, 0, 0]);
  r.bone('body', 'root', [0, 1.28, -0.10]);
  r.bone('chest', 'body', [0, 0.14, 0.50]);
  r.bone('neck1', 'chest', [0, 0.06, 0.10]);
  r.bone('neck2', 'neck1', [0, 0.24, 0.20]);
  r.bone('neck3', 'neck2', [0, 0.24, 0.20]);
  r.bone('head', 'neck3', [0, 0.06, 0.10]);
  r.bone('jaw', 'head', [0, -0.10, 0.12]);
  r.bone('croup', 'body', [0, 0.06, -0.45]);
  r.bone('tail1', 'croup', [0, 0.10, -0.20]);
  r.bone('tail2', 'tail1', [0, -0.16, -0.14]);
  r.bone('tail3', 'tail2', [0, -0.20, -0.08]);
  r.bone('saddle', 'body', [0, 0.34, 0.10]);   // (0, 1.62, 0.00) — rider seat

  for (const s of [1, -1]) {
    const L = s > 0 ? 'L' : 'R';
    // front: shoulder -> elbow -> knee -> fetlock -> hoof
    r.bone('fUp' + L, 'chest', [0.20 * s, -0.20, 0.03]);       // (0.200s, 1.22, 0.43)
    r.bone('fFore' + L, 'fUp' + L, [0.004 * s, -0.22, -0.03]); // (0.204s, 1.00, 0.40)
    r.bone('fCan' + L, 'fFore' + L, [0.004 * s, -0.32, 0.02]); // (0.208s, 0.68, 0.42)
    r.bone('fPas' + L, 'fCan' + L, [0, -0.44, 0.025]);         // (0.208s, 0.24, 0.445)
    r.bone('fHf' + L, 'fPas' + L, [0, -0.11, 0.022]);          // (0.208s, 0.13, 0.467)
    // hind: hip -> stifle -> hock -> fetlock -> hoof
    r.bone('hUp' + L, 'croup', [0.215 * s, 0.08, 0.00]);       // (0.215s, 1.42, -0.55)
    r.bone('hSti' + L, 'hUp' + L, [0, -0.37, 0.19]);           // (0.215s, 1.05, -0.36)
    r.bone('hHoc' + L, 'hSti' + L, [-0.003 * s, -0.42, -0.25]);// (0.212s, 0.63, -0.61)
    r.bone('hCan' + L, 'hHoc' + L, [-0.004 * s, -0.42, 0.10]); // (0.208s, 0.21, -0.51)
    r.bone('hHf' + L, 'hCan' + L, [0, -0.08, 0.02]);           // (0.208s, 0.13, -0.49)
  }
  return r;
}

/** Segment lengths used by the leg IK, derived from the rest hierarchy. */
export const HLEG = {
  fUpper: 0.2242,   // shoulder -> elbow
  fFore: 0.3206,    // elbow -> knee
  fCannon: 0.4407,  // knee -> fetlock
  fPast: 0.1122,    // fetlock -> hoof
  hUpper: 0.4159,   // hip -> stifle
  hStifle: 0.4888,  // stifle -> hock
  hCannon: 0.4318,  // hock -> fetlock
  hPast: 0.0825,    // fetlock -> hoof
};

const TAU = Math.PI * 2;
function angDist(a) { return Math.abs(((a + Math.PI) % TAU + TAU) % TAU - Math.PI); }

/** Surface classes understood by CharMaterial (see SkinBuilder.surface). */
const HARD = 0, WOVEN = 1, HIDE = 2, STRAND = 3;

export function buildHorseGeometry(rig) {
  const B = new SkinBuilder();
  const w = (a, wa, b, wb) => rig.w(a, wa, b, wb);


  /* ================================================================ BARREL
   * Deeper than it is wide (0.54 across, 0.70 top to bottom) with a defined
   * withers ridge, a slab side and a sprung rib cage that tucks up into the
   * flank. Round it off and the whole animal reads as a rodent.
   */
  B.group(0);
  B.surface(HIDE);
  B.tube(resample([
    { p: [0, 1.30, 0.70], rx: 0.130, rz: 0.190, bones: w('chest', 1) },
    { p: [0, 1.28, 0.56], rx: 0.198, rz: 0.288, bones: w('chest', 1) },
    { p: [0, 1.265, 0.36], rx: 0.244, rz: 0.336, bones: w('chest', 0.55, 'body', 0.45) },
    { p: [0, 1.252, 0.10], rx: 0.263, rz: 0.352, bones: w('body', 1) },
    { p: [0, 1.262, -0.16], rx: 0.260, rz: 0.334, bones: w('body', 1) },
    { p: [0, 1.290, -0.42], rx: 0.256, rz: 0.300, bones: w('body', 0.5, 'croup', 0.5) },
    { p: [0, 1.330, -0.64], rx: 0.230, rz: 0.256, bones: w('croup', 1) },
    { p: [0, 1.340, -0.82], rx: 0.150, rz: 0.180, bones: w('croup', 1) },
    { p: [0, 1.310, -0.90], rx: 0.062, rz: 0.080, bones: w('croup', 1) },
  ], 38), {
    radial: 34, power: 2.45, color: HPAL.coat, rough: 0.66, sheen: 0.18,
    capStart: true, capEnd: true,
    radiusFn: (v, u) => {
      const a = u * TAU;                    // a=0 -> +X (left), a=3pi/2 -> +Y
      const up = Math.max(-Math.sin(a), 0);
      const down = Math.max(Math.sin(a), 0);
      const side = Math.abs(Math.cos(a));
      const withers = Math.exp(-Math.pow((v - 0.235) / 0.075, 2));
      const croup = Math.exp(-Math.pow((v - 0.615) / 0.10, 2));
      const flank = Math.exp(-Math.pow((v - 0.545) / 0.09, 2));
      /* ---- muscle masses. A horse is not a barrel: the scapula and triceps
       * stand proud of the ribs at the front, the gluteal/semitendinosus mass
       * balls out over the hip, the ribs are readable through the skin on the
       * lower flank, and there is a gutter either side of the spine. Without
       * these four the animal reads as an untextured cylinder no matter what
       * the shader does — and that was the single loudest note in the A/B. */
      const shoulder = Math.exp(-Math.pow((v - 0.180) / 0.082, 2)) * side * (0.45 + 0.55 * down);
      const tricep = Math.exp(-Math.pow((v - 0.288) / 0.062, 2)) * side * down;
      const haunch = Math.exp(-Math.pow((v - 0.672) / 0.102, 2)) * side * (0.32 + 0.68 * up);
      const gutter = Math.exp(-Math.pow((angDist(a - Math.PI * 1.5) - 0.44) / 0.22, 2))
        * Math.exp(-Math.pow((v - 0.470) / 0.240, 2));
      const ribs = Math.sin((v - 0.275) * 47.0) * Math.exp(-Math.pow((v - 0.395) / 0.115, 2))
        * side * (0.30 + 0.70 * down);
      return 1
        - up * 0.055 + up * (withers * 0.070 + croup * 0.030)   // topline
        + down * 0.018 - down * flank * 0.055                   // belly / tuck
        - side * flank * 0.030
        + shoulder * 0.048 + tricep * 0.030 + haunch * 0.062
        - gutter * 0.028 + ribs * 0.0125;
    },
    colorFn: (v, u) => {
      const a = u * TAU;
      const down = Math.max(Math.sin(a), 0);
      const up = Math.max(-Math.sin(a), 0);
      const c = [
        HPAL.coat[0] * (1 - down * 0.18) + HPAL.belly[0] * down * 0.30,
        HPAL.coat[1] * (1 - down * 0.18) + HPAL.belly[1] * down * 0.30,
        HPAL.coat[2] * (1 - down * 0.18) + HPAL.belly[2] * down * 0.30,
      ];
      return mul(c, 0.90 + up * 0.22 + (1 - v) * 0.06);
    },
  });

  // brisket / point of shoulder
  B.blob([0, 1.185, 0.618], [0.150, 0.170, 0.140], w('chest', 1),
    { rings: 8, segments: 12, color: mul(HPAL.coat, 0.94), rough: 0.72, sheen: 0.25 });

  /* ================================================================== NECK
   * A deep, narrow wedge: 0.46 m crest-to-throat at the base tapering to
   * 0.26 m, but only 0.34 m wide tapering to 0.17 m.
   */
  B.tube(resample([
    { p: [0, 1.42, 0.50], rx: 0.250, rz: 0.180, bones: w('chest', 1) },
    { p: [0, 1.545, 0.615], rx: 0.222, rz: 0.150, bones: w('chest', 0.4, 'neck1', 0.6) },
    { p: [0, 1.695, 0.735], rx: 0.192, rz: 0.124, bones: w('neck1', 0.5, 'neck2', 0.5) },
    { p: [0, 1.840, 0.855], rx: 0.165, rz: 0.104, bones: w('neck2', 1) },
    { p: [0, 1.955, 0.965], rx: 0.142, rz: 0.092, bones: w('neck2', 0.4, 'neck3', 0.6) },
    { p: [0, 2.020, 1.045], rx: 0.122, rz: 0.086, bones: w('neck3', 1) },
  ], 22), {
    radial: 20, power: 2.25, color: HPAL.coat, rough: 0.72, sheen: 0.25,
    // a=0 is up-forward along the crest for this sweep direction
    radiusFn: (v, u) => {
      const a = u * TAU;
      const crest = Math.exp(-Math.pow(angDist(a) / 0.55, 2));
      return 1 + crest * 0.055 * (0.4 + 0.6 * v);
    },
    colorFn: (v, u) => {
      const a = u * TAU;
      const crest = Math.exp(-Math.pow(angDist(a) / 0.7, 2));
      return mul(HPAL.coat, (0.92 + 0.20 * (1 - v)) * (1 - crest * 0.14));
    },
  });
  // throatlatch fill where the neck meets the jaw
  B.blob([0, 1.905, 1.025], [0.108, 0.115, 0.115], w('neck3', 0.6, 'head', 0.4),
    { rings: 8, segments: 12, color: mul(HPAL.coat, 0.93), rough: 0.72, sheen: 0.25 });

  /* ================================================================== HEAD */
  B.tube(resample([
    { p: [0, 2.030, 1.030], rx: 0.104, rz: 0.090, bones: w('neck3', 0.35, 'head', 0.65) },
    { p: [0, 1.958, 1.132], rx: 0.110, rz: 0.098, bones: w('head', 1) },
    { p: [0, 1.868, 1.234], rx: 0.094, rz: 0.083, bones: w('head', 1) },
    { p: [0, 1.768, 1.330], rx: 0.077, rz: 0.064, bones: w('head', 1) },
    { p: [0, 1.672, 1.414], rx: 0.067, rz: 0.055, bones: w('head', 1) },
    { p: [0, 1.606, 1.470], rx: 0.064, rz: 0.053, bones: w('head', 1) },
    { p: [0, 1.576, 1.492], rx: 0.046, rz: 0.041, bones: w('head', 1) },
  ], 22), {
    radial: 18, power: 2.35, capEnd: true, color: HPAL.coat, rough: 0.70, sheen: 0.25,
    colorFn: (v, u) => {
      const a = u * TAU;
      // a = 0 is the front plane of the face for this sweep
      const star = Math.exp(-Math.pow(angDist(a) / 0.26, 2))
        * Math.exp(-Math.pow((v - 0.20) / 0.14, 2));
      if (v > 0.855) return mul(HPAL.muzzle, 0.9 + 0.3 * (1 - v));
      const base = mul(HPAL.coat, 0.93 + 0.16 * (1 - v));
      return [
        base[0] * (1 - star * 0.7) + 0.135 * star,
        base[1] * (1 - star * 0.7) + 0.120 * star,
        base[2] * (1 - star * 0.7) + 0.100 * star,
      ];
    },
  });
  // cheek / jowl
  B.blob([0, 1.912, 1.148], [0.122, 0.108, 0.118], w('head', 1),
    { rings: 10, segments: 14, color: mul(HPAL.coat, 0.97), rough: 0.72, sheen: 0.25 });
  for (const s of [1, -1]) {
    B.blob([0.100 * s, 1.936, 1.140], [0.028, 0.026, 0.026], w('head', 1),
      { rings: 6, segments: 9, color: [0.010, 0.009, 0.008], rough: 0.20, mtype: HARD });
    // brow ridge over the eye
    B.blob([0.096 * s, 1.968, 1.128], [0.036, 0.022, 0.034], w('head', 1),
      { rings: 6, segments: 9, color: mul(HPAL.coat, 0.88), rough: 0.75, sheen: 0.3 });
    // ear: upright, slightly outward, pricked forward
    B.tube([
      { p: [0.058 * s, 2.030, 1.000], rx: 0.034, rz: 0.030, bones: w('head', 1) },
      { p: [0.070 * s, 2.082, 1.006], rx: 0.028, rz: 0.023, bones: w('head', 1) },
      { p: [0.082 * s, 2.132, 1.016], rx: 0.016, rz: 0.013, bones: w('head', 1) },
      { p: [0.090 * s, 2.162, 1.024], rx: 0.005, rz: 0.004, bones: w('head', 1) },
    ], { radial: 9, capEnd: true, color: mul(HPAL.coat, 0.80), rough: 0.85, sheen: 0.4 });
    B.blob([0.044 * s, 1.596, 1.478], [0.020, 0.018, 0.015], w('head', 1),
      { rings: 5, segments: 8, color: [0.009, 0.007, 0.006], rough: 0.35, mtype: HARD });
  }

  /* ================================================================== LEGS */
  for (const s of [1, -1]) {
    const L = s > 0 ? 'L' : 'R';
    /* Scapula + point-of-shoulder mass. It used to be the top ring of the leg
     * tube standing 3 cm proud of the barrel with a hard rim — which is the
     * pasted-on polygon patch that showed on the shoulder in every frame. The
     * leg now starts buried and this blob carries the shoulder instead, so the
     * junction is a smooth mass rather than an edge. */
    B.blob([0.150 * s, 1.352, 0.398], [0.118, 0.196, 0.182], w('chest', 0.72, 'fUp' + L, 0.28), {
      rings: 12, segments: 16, rough: 0.66, sheen: 0.18, color: mul(HPAL.coat, 0.99),
      shape: (u, v) => {
        const a = u * TAU;
        // flatten the inboard face so it sits against the ribs
        return 1 - Math.max(-Math.cos(a) * s, 0) * 0.30 - THREE.MathUtils.smoothstep(v, 0.72, 1.0) * 0.16;
      },
      colorFn: (u, v) => mul(HPAL.coat, 0.94 + 0.14 * (1 - v)),
    });
    // ---- front: forearm mass, sharply defined knee, thin cannon
    B.tube(resample([
      { p: [0.128 * s, 1.452, 0.412], rx: 0.062, rz: 0.116, bones: w('chest', 0.85, 'fUp' + L, 0.15) },
      { p: [0.170 * s, 1.300, 0.418], rx: 0.112, rz: 0.190, bones: w('chest', 0.35, 'fUp' + L, 0.65) },
      { p: [0.196 * s, 1.160, 0.420], rx: 0.104, rz: 0.156, bones: w('fUp' + L, 1) },
      { p: [0.203 * s, 1.010, 0.402], rx: 0.090, rz: 0.116, bones: w('fUp' + L, 0.5, 'fFore' + L, 0.5) },
      { p: [0.205 * s, 0.880, 0.408], rx: 0.074, rz: 0.086, bones: w('fFore' + L, 1) },
      { p: [0.206 * s, 0.755, 0.418], rx: 0.052, rz: 0.058, bones: w('fFore' + L, 1) },
      { p: [0.207 * s, 0.680, 0.424], rx: 0.046, rz: 0.052, bones: w('fFore' + L, 0.35, 'fCan' + L, 0.65) },
      { p: [0.207 * s, 0.560, 0.430], rx: 0.034, rz: 0.040, bones: w('fCan' + L, 1) },
      { p: [0.207 * s, 0.380, 0.440], rx: 0.031, rz: 0.037, bones: w('fCan' + L, 1) },
      { p: [0.207 * s, 0.252, 0.449], rx: 0.040, rz: 0.045, bones: w('fCan' + L, 0.4, 'fPas' + L, 0.6) },
      { p: [0.207 * s, 0.180, 0.458], rx: 0.036, rz: 0.041, bones: w('fPas' + L, 1) },
      { p: [0.207 * s, 0.132, 0.468], rx: 0.034, rz: 0.039, bones: w('fPas' + L, 0.4, 'fHf' + L, 0.6) },
    ], 26), {
      radial: 12, power: 2.2, rough: 0.74, sheen: 0.22, color: HPAL.coat,
      colorFn: (v) => {
        const k = THREE.MathUtils.smoothstep(v, 0.56, 0.70);
        const a = mul(HPAL.coat, 0.93 + 0.04 * (1 - v));
        const b = mul(HPAL.points, 0.9 + 0.6 * (1 - v));
        return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
      },
    });
    B.tube([
      { p: [0.207 * s, 0.134, 0.470], rx: 0.048, rz: 0.052, bones: w('fHf' + L, 1) },
      { p: [0.207 * s, 0.060, 0.478], rx: 0.058, rz: 0.062, bones: w('fHf' + L, 1) },
      { p: [0.207 * s, 0.004, 0.481], rx: 0.056, rz: 0.060, bones: w('fHf' + L, 1) },
    ], { radial: 12, power: 2.5, capEnd: true, color: HPAL.hoof, rough: 0.52, sheen: 0.10, mtype: HARD });

    // ---- hind: thigh, gaskin, hard-angled hock, thin cannon
    B.tube(resample([
      { p: [0.150 * s, 1.520, -0.548], rx: 0.120, rz: 0.215, bones: w('croup', 0.8, 'hUp' + L, 0.2) },
      { p: [0.186 * s, 1.360, -0.520], rx: 0.150, rz: 0.230, bones: w('croup', 0.3, 'hUp' + L, 0.7) },
      { p: [0.208 * s, 1.220, -0.462], rx: 0.146, rz: 0.196, bones: w('hUp' + L, 1) },
      { p: [0.212 * s, 1.120, -0.412], rx: 0.126, rz: 0.156, bones: w('hUp' + L, 0.65, 'hSti' + L, 0.35) },
      { p: [0.214 * s, 1.010, -0.368], rx: 0.108, rz: 0.128, bones: w('hSti' + L, 1) },
      { p: [0.214 * s, 0.870, -0.470], rx: 0.086, rz: 0.098, bones: w('hSti' + L, 1) },
      { p: [0.212 * s, 0.720, -0.578], rx: 0.058, rz: 0.066, bones: w('hSti' + L, 0.4, 'hHoc' + L, 0.6) },
      { p: [0.211 * s, 0.628, -0.606], rx: 0.048, rz: 0.058, bones: w('hHoc' + L, 1) },
      { p: [0.209 * s, 0.470, -0.570], rx: 0.032, rz: 0.038, bones: w('hHoc' + L, 1) },
      { p: [0.208 * s, 0.300, -0.531], rx: 0.030, rz: 0.036, bones: w('hHoc' + L, 0.45, 'hCan' + L, 0.55) },
      { p: [0.208 * s, 0.240, -0.518], rx: 0.039, rz: 0.043, bones: w('hCan' + L, 1) },
      { p: [0.208 * s, 0.170, -0.502], rx: 0.035, rz: 0.039, bones: w('hCan' + L, 1) },
      { p: [0.208 * s, 0.130, -0.492], rx: 0.033, rz: 0.038, bones: w('hCan' + L, 0.4, 'hHf' + L, 0.6) },
    ], 28), {
      radial: 12, power: 2.2, rough: 0.74, sheen: 0.22, color: HPAL.coat,
      colorFn: (v) => {
        const k = THREE.MathUtils.smoothstep(v, 0.62, 0.75);
        const a = mul(HPAL.coat, 0.93 + 0.04 * (1 - v));
        const b = mul(HPAL.points, 0.9 + 0.6 * (1 - v));
        return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
      },
    });
    B.tube([
      { p: [0.208 * s, 0.132, -0.490], rx: 0.046, rz: 0.050, bones: w('hHf' + L, 1) },
      { p: [0.208 * s, 0.058, -0.484], rx: 0.056, rz: 0.060, bones: w('hHf' + L, 1) },
      { p: [0.208 * s, 0.004, -0.481], rx: 0.054, rz: 0.058, bones: w('hHf' + L, 1) },
    ], { radial: 12, power: 2.5, capEnd: true, color: HPAL.hoof, rough: 0.52, sheen: 0.10, mtype: HARD });
  }

  /* ============================================================== TAIL DOCK
   * Only the muscular dock is solid geometry now — the fall is strand cards in
   * the separate hair mesh below, because a solid lump of tail with a wavy
   * radius was reading as a club, not hair.
   */
  B.tube(resample([
    { p: [0, 1.520, -0.836], rx: 0.052, rz: 0.052, bones: w('croup', 0.6, 'tail1', 0.4) },
    { p: [0, 1.432, -0.918], rx: 0.048, rz: 0.046, bones: w('tail1', 1) },
    { p: [0, 1.330, -0.978], rx: 0.040, rz: 0.038, bones: w('tail1', 0.5, 'tail2', 0.5) },
    { p: [0, 1.220, -1.008], rx: 0.030, rz: 0.029, bones: w('tail2', 1) },
    { p: [0, 1.130, -1.018], rx: 0.018, rz: 0.018, bones: w('tail2', 1) },
  ], 14), {
    radial: 12, capEnd: true, color: HPAL.mane, rough: 0.62, sheen: 0.30, mtype: HIDE,
    colorFn: (v) => mul(HPAL.mane, 1.35 - 0.45 * v),
  });

  /* ================================================================= TACK
   * Blanket, then a western saddle sitting on it: dished seat, swept skirts,
   * a cantle at the back and a horn at the front.
   */
  B.group(0);
  B.surface(HARD);
  const arcTop = Math.PI * 1.5;                    // +Y for a front->back sweep
  const barrelR = (z) => {
    // approximate the barrel section at a given z so the tack hugs it
    const t = THREE.MathUtils.clamp((0.36 - z) / 0.78, 0, 1);
    return { rx: 0.244 + 0.020 * Math.sin(t * Math.PI), rz: 0.336 + 0.016 * Math.sin(t * Math.PI) };
  };
  B.tube(resample([
    { p: [0, 1.264, 0.360], rx: 0.246, rz: 0.338, bones: w('body', 1) },
    { p: [0, 1.256, 0.140], rx: 0.264, rz: 0.354, bones: w('body', 1) },
    { p: [0, 1.258, -0.090], rx: 0.264, rz: 0.348, bones: w('body', 1) },
    { p: [0, 1.272, -0.310], rx: 0.258, rz: 0.318, bones: w('body', 1) },
  ], 12), {
    radial: 22, power: 2.45, arcStart: arcTop - 1.62, arcEnd: arcTop + 1.62,
    color: HPAL.blanket, rough: 0.95, sheen: 0.85, mtype: WOVEN,
    radiusFn: () => 1.028,
    colorFn: (v, u) => {
      const d = Math.min(u, 1 - u);              // distance to the lower edge
      const band = (d < 0.055 || (d > 0.085 && d < 0.115)) ? 1 : 0;
      const edge = d < 0.02 ? 0.8 : 1;
      return mul(band ? HPAL.blanket : HPAL.blanketPale, edge * (0.95 + 0.12 * v));
    },
  });
  // saddle body
  B.tube(resample([
    { p: [0, 1.268, 0.300], rx: 0.250, rz: 0.348, bones: w('body', 1) },
    { p: [0, 1.258, 0.150], rx: 0.276, rz: 0.372, bones: w('body', 1) },
    { p: [0, 1.258, -0.010], rx: 0.282, rz: 0.376, bones: w('body', 1) },
    { p: [0, 1.264, -0.170], rx: 0.278, rz: 0.362, bones: w('body', 1) },
    { p: [0, 1.278, -0.290], rx: 0.264, rz: 0.330, bones: w('body', 1) },
  ], 14), {
    radial: 22, power: 2.4, arcStart: arcTop - 1.30, arcEnd: arcTop + 1.30,
    color: HPAL.saddle, rough: 0.50, sheen: 0.06,
    // dish the seat and swell the skirts
    radiusFn: (v, u) => {
      const top = Math.exp(-Math.pow((u - 0.5) / 0.16, 2));
      const seat = Math.exp(-Math.pow((v - 0.52) / 0.28, 2));
      return 1.0 + 0.05 * (1 - top) - top * seat * 0.055;
    },
    colorFn: (v, u) => {
      const top = Math.exp(-Math.pow((u - 0.5) / 0.22, 2));
      return mul(HPAL.saddle, 0.86 + 0.30 * top - 0.12 * v);
    },
  });
  // cantle
  B.tube([
    { p: [0, 1.588, -0.268], rx: 0.135, rz: 0.030, bones: w('body', 1) },
    { p: [0, 1.646, -0.292], rx: 0.126, rz: 0.026, bones: w('body', 1) },
    { p: [0, 1.672, -0.306], rx: 0.100, rz: 0.020, bones: w('body', 1) },
  ], { radial: 14, capEnd: true, color: HPAL.saddleDark, rough: 0.46, power: 2.4 });
  // pommel + horn
  B.tube([
    { p: [0, 1.590, 0.235], rx: 0.115, rz: 0.090, bones: w('body', 1) },
    { p: [0, 1.648, 0.244], rx: 0.078, rz: 0.062, bones: w('body', 1) },
    { p: [0, 1.688, 0.248], rx: 0.032, rz: 0.028, bones: w('body', 1) },
    { p: [0, 1.716, 0.250], rx: 0.024, rz: 0.022, bones: w('body', 1) },
    { p: [0, 1.734, 0.252], rx: 0.044, rz: 0.038, bones: w('body', 1) },
  ], { radial: 14, capEnd: true, color: HPAL.saddleDark, rough: 0.42 });
  // stirrup leathers and irons
  for (const s of [1, -1]) {
    B.tube([
      { p: [0.290 * s, 1.480, 0.075], rx: 0.014, rz: 0.040, bones: w('body', 1) },
      { p: [0.312 * s, 1.310, 0.070], rx: 0.014, rz: 0.040, bones: w('body', 1) },
      { p: [0.320 * s, 1.150, 0.066], rx: 0.014, rz: 0.040, bones: w('body', 1) },
    ], { radial: 8, power: 2.6, color: HPAL.saddleDark, rough: 0.5 });
    B.sheet(14, 3, (u, v) => {
      const a = u * TAU;
      return {
        p: [0.320 * s + (v - 0.5) * 0.060, 1.088 + Math.sin(a) * 0.066, 0.066 + Math.cos(a) * 0.050],
        bones: w('body', 1),
      };
    }, { wrapU: true, color: HPAL.steel, rough: 0.34 });
  }
  // girth strap
  B.tube(resample([
    { p: [0, 1.258, 0.155], rx: 0.268, rz: 0.358, bones: w('body', 1) },
    { p: [0, 1.256, 0.105], rx: 0.268, rz: 0.358, bones: w('body', 1) },
  ], 3), {
    radial: 22, power: 2.45, arcStart: Math.PI * 0.5 - 1.15, arcEnd: Math.PI * 0.5 + 1.15,
    color: HPAL.saddleDark, rough: 0.62, radiusFn: () => 1.035,
  });

  /* ------ kit: bedroll, rifle scabbard, lariat. These read instantly as
   * "somebody lives out of this saddle" and cost 900 triangles. */
  const CANVAS = lin(0x6a6151), ROPE = lin(0x9b8a63), GUNMETAL = lin(0x3a3d40);
  B.tube([
    { p: [-0.235, 1.585, -0.320], rx: 0.086, rz: 0.086, bones: w('body', 1) },
    { p: [-0.120, 1.618, -0.336], rx: 0.096, rz: 0.096, bones: w('body', 1) },
    { p: [0.120, 1.618, -0.336], rx: 0.096, rz: 0.096, bones: w('body', 1) },
    { p: [0.235, 1.585, -0.320], rx: 0.086, rz: 0.086, bones: w('body', 1) },
  ], {
    radial: 14, capStart: true, capEnd: true, color: CANVAS, rough: 0.95, sheen: 0.8, mtype: WOVEN,
    colorFn: (v, u) => mul(CANVAS, 0.86 + 0.26 * Math.abs(Math.sin(u * TAU * 4.0)) * 0.5 + 0.1 * (1 - v)),
  });
  for (const s of [1, -1]) {
    B.tube([
      { p: [-0.240 * s, 1.600, -0.318], rx: 0.014, rz: 0.090, bones: w('body', 1) },
      { p: [-0.245 * s, 1.560, -0.316], rx: 0.014, rz: 0.090, bones: w('body', 1) },
    ], { radial: 8, power: 2.6, color: HPAL.saddleDark, rough: 0.5 });
  }
  // rifle butt in a scabbard under the right skirt
  B.tube(resample([
    { p: [-0.300, 1.470, 0.145], rx: 0.052, rz: 0.030, bones: w('body', 1) },
    { p: [-0.318, 1.395, 0.010], rx: 0.058, rz: 0.034, bones: w('body', 1) },
    { p: [-0.330, 1.310, -0.145], rx: 0.050, rz: 0.030, bones: w('body', 1) },
    { p: [-0.336, 1.262, -0.235], rx: 0.036, rz: 0.024, bones: w('body', 1) },
  ], 10), {
    radial: 10, power: 2.5, capEnd: true, color: HPAL.saddleDark, rough: 0.48,
  });
  B.tube([
    { p: [-0.292, 1.505, 0.208], rx: 0.038, rz: 0.024, bones: w('body', 1) },
    { p: [-0.286, 1.532, 0.258], rx: 0.030, rz: 0.020, bones: w('body', 1) },
    { p: [-0.282, 1.545, 0.290], rx: 0.020, rz: 0.014, bones: w('body', 1) },
  ], { radial: 8, capEnd: true, color: GUNMETAL, rough: 0.36 });
  // lariat coiled on the horn
  B.sheet(24, 6, (u, v) => {
    const a = u * TAU;
    const r = 0.088 + v * 0.010;
    const th = 0.011;
    const b = v * TAU;
    return {
      p: [Math.cos(a) * (r + Math.cos(b) * th) + 0.052,
        1.628 + Math.sin(b) * th - v * 0.006,
        Math.sin(a) * (r + Math.cos(b) * th) * 0.55 + 0.238],
      bones: w('body', 1),
      color: mul(ROPE, 0.82 + 0.30 * Math.abs(Math.sin(a * 9.0))),
    };
  }, { wrapU: true, color: ROPE, rough: 0.95, sheen: 0.5, mtype: WOVEN });

  /* ------ FENDERS. The stirrup used to hang off a 3 cm strap; a western
   * saddle carries a broad leather fender that covers the rider's calf, and it
   * is a big readable shape in exactly the part of the frame the A/B crop
   * called out as empty. */
  for (const s of [1, -1]) {
    B.sheet(5, 9, (u, v) => {
      const wdt = 0.075 + v * 0.020 - Math.pow(v, 4) * 0.055;
      const y = 1.500 - v * 0.400;
      const z = 0.086 - v * 0.020 + (u - 0.5) * wdt * 2.0;
      const bulge = Math.sin(u * Math.PI) * 0.014 * (1 - v * 0.4);
      return {
        p: [(0.286 + bulge) * s, y, z],
        bones: w('body', 1),
        color: mul(HPAL.saddleDark, 0.90 + 0.30 * Math.sin(u * Math.PI) - 0.10 * v),
      };
    }, { color: HPAL.saddleDark, rough: 0.46 });
  }

  /* ------ SADDLEBAGS behind the cantle: two flapped leather bags with a
   * buckled strap. Real weight over the loins. */
  for (const s of [1, -1]) {
    B.box([0.212 * s, 1.398, -0.386], [0.052, 0.108, 0.088], w('body', 1), {
      color: mul(HPAL.saddle, 0.82), rough: 0.52, bevel: 0.30,
      rotation: new THREE.Euler(0.10, 0, -0.16 * s),
    });
    B.box([0.216 * s, 1.500, -0.382], [0.058, 0.030, 0.094], w('body', 1), {
      color: HPAL.saddleDark, rough: 0.44, bevel: 0.36,
      rotation: new THREE.Euler(0.10, 0, -0.16 * s),
    });
    B.box([0.252 * s, 1.452, -0.372], [0.010, 0.014, 0.011], w('body', 1),
      { color: HPAL.steel, rough: 0.30, bevel: 0.4 });
  }
  B.tube(resample([
    { p: [0.185, 1.520, -0.372], rx: 0.010, rz: 0.026, bones: w('body', 1) },
    { p: [0, 1.556, -0.366], rx: 0.010, rz: 0.026, bones: w('body', 1) },
    { p: [-0.185, 1.520, -0.372], rx: 0.010, rz: 0.026, bones: w('body', 1) },
  ], 10), { radial: 6, color: HPAL.saddleDark, rough: 0.46 });

  /* =============================================================== BRIDLE */
  for (const s of [1, -1]) {
    B.tube([
      { p: [0.082 * s, 2.020, 1.022], rx: 0.009, rz: 0.016, bones: w('head', 1) },
      { p: [0.100 * s, 1.900, 1.150], rx: 0.009, rz: 0.016, bones: w('head', 1) },
      { p: [0.082 * s, 1.756, 1.320], rx: 0.009, rz: 0.016, bones: w('head', 1) },
    ], { radial: 6, color: HPAL.saddleDark, rough: 0.5 });
  }
  B.sheet(14, 2, (u, v) => {
    const a = u * TAU;
    return {
      p: [Math.sin(a) * 0.072, 1.752 + Math.cos(a) * 0.064 + v * 0.022, 1.324 + Math.cos(a) * 0.010],
      bones: w('head', 1),
    };
  }, { wrapU: true, color: HPAL.saddleDark, rough: 0.5 });
  // reins looping from the bit back to the horn
  B.tube(resample([
    { p: [0.088, 1.678, 1.404], rx: 0.008, rz: 0.014, bones: w('head', 1) },
    { p: [0.140, 1.700, 1.180], rx: 0.008, rz: 0.014, bones: w('head', 0.5, 'neck3', 0.5) },
    { p: [0.175, 1.660, 0.900], rx: 0.008, rz: 0.014, bones: w('neck2', 1) },
    { p: [0.180, 1.628, 0.620], rx: 0.008, rz: 0.014, bones: w('neck1', 0.6, 'chest', 0.4) },
    { p: [0.120, 1.690, 0.330], rx: 0.008, rz: 0.014, bones: w('body', 1) },
    { p: [0.030, 1.724, 0.256], rx: 0.008, rz: 0.014, bones: w('body', 1) },
  ], 20), { radial: 6, color: HPAL.saddleDark, rough: 0.5 });

  return B.build();
}

/* ==========================================================================
 * MANE, FORELOCK AND TAIL — layered alpha-tested strand cards
 * --------------------------------------------------------------------------
 * These used to be solid geometry: a smooth ribbon for the mane and a wavy
 * tube for the tail, which in every frame read as a rubber flap and a club.
 * Real hair has a broken silhouette, so it is built as overlapping cards
 * carrying a strand alpha mask, each card skinned to the neck or tail bone it
 * hangs from — so the existing spring-damped tail swing and neck nod already
 * drive the secondary motion for free, and the wind comes with it.
 *
 * Separate mesh so it can be one alpha-tested, cheap-shadow draw call:
 * mixing alphaTest into the body material would pay the discard on 12 000
 * opaque triangles.
 *
 * ~120 cards, 1 800 triangles.
 * ========================================================================== */
export function buildHorseHairGeometry(rig, rand) {
  const B = new SkinBuilder();
  const w = (a, wa, b, wb) => rig.w(a, wa, b, wb);
  B.surface(STRAND);

  /**
   * One hanging lock.
   *  root  world-ish rest position of the card's top edge
   *  fall  unit direction the hair hangs
   *  ref   axis the card is BROAD along (orthogonalised against `fall`) — the
   *        neck line for a mane, the tangent of the fan for a tail
   *  curl  out-of-plane bow so a lock is not a flat playing card
   */
  const card = (root, fall, ref, wide, len, bones, tint, curl) => {
    const fl = Math.hypot(fall[0], fall[1], fall[2]) || 1;
    const f = [fall[0] / fl, fall[1] / fl, fall[2] / fl];
    const d = ref[0] * f[0] + ref[1] * f[1] + ref[2] * f[2];
    let wv = [ref[0] - f[0] * d, ref[1] - f[1] * d, ref[2] - f[2] * d];
    const wl = Math.hypot(wv[0], wv[1], wv[2]) || 1;
    wv = [wv[0] / wl, wv[1] / wl, wv[2] / wl];
    const nv = [
      f[1] * wv[2] - f[2] * wv[1],
      f[2] * wv[0] - f[0] * wv[2],
      f[0] * wv[1] - f[1] * wv[0],
    ];
    B.sheet(1, 5, (u, v) => {
      const t = v;
      const s = u - 0.5;
      const wd = wide * (0.88 + 0.30 * t);      // locks splay slightly at the tip
      const c = curl * t * t;
      return {
        p: [
          root[0] + f[0] * len * t + wv[0] * s * wd + nv[0] * c,
          root[1] + f[1] * len * t + wv[1] * s * wd + nv[1] * c,
          root[2] + f[2] * len * t + wv[2] * s * wd + nv[2] * c,
        ],
        uv: [u * 0.42 + tint.u, t],
        bones,
        color: mul(HPAL.mane, tint.k * (0.55 + 0.75 * (1 - t))),
      };
    }, { color: HPAL.mane, rough: 0.72, sheen: 0.55 });
  };

  /* ------------------------------------------------------------------ MANE */
  const maneKeys = [
    [2.045, 1.020], [1.995, 0.955], [1.905, 0.868],
    [1.812, 0.782], [1.712, 0.700], [1.612, 0.622],
    [1.530, 0.548], [1.492, 0.452], [1.500, 0.360],
  ];
  const maneBones = [
    w('neck3', 1), w('neck3', 1), w('neck3', 0.5, 'neck2', 0.5),
    w('neck2', 1), w('neck2', 1), w('neck2', 0.5, 'neck1', 0.5),
    w('neck1', 1), w('neck1', 0.6, 'chest', 0.4), w('chest', 1),
  ];
  const rag = [0.20, 0.31, 0.40, 0.38, 0.44, 0.40, 0.44, 0.38, 0.26];
  const NM = 22;
  for (let i = 0; i < NM; i++) {
    const f = (i / (NM - 1)) * (maneKeys.length - 1);
    const k = Math.min(maneKeys.length - 2, Math.floor(f));
    const t = f - k;
    const py = maneKeys[k][0] + (maneKeys[k + 1][0] - maneKeys[k][0]) * t;
    const pz = maneKeys[k][1] + (maneKeys[k + 1][1] - maneKeys[k][1]) * t;
    const baseLen = rag[k] + (rag[k + 1] - rag[k]) * t;
    const bones = maneBones[Math.round(f)];
    // Three layers per station: far side, crest, near side — the near side
    // carries the heavy fall so the mane reads in silhouette from the camera.
    for (let layer = 0; layer < 4; layer++) {
      const side = (layer === 0 || layer === 3) ? -1 : 1;
      const heavy = layer === 2 ? 1.0 : (layer === 1 ? 0.74 : (layer === 3 ? 0.86 : 0.60));
      const len = baseLen * heavy * (0.62 + rand() * 0.30);
      const lean = (layer === 1 ? 0.14 : 0.38) * side + (rand() - 0.5) * 0.16;
      const fall = [lean, -1.0, -0.10 - rand() * 0.18];
      /*
       * Twist each card's plane. Every mane card used to be broad along the
       * neck, which meant its normal pointed sideways and the whole mane went
       * edge-on — a row of black slivers — the moment the camera sat behind
       * the horse, which is the game's default framing. Spreading the plane
       * over ±55 deg guarantees a third of the locks face any given lens.
       */
      const th = (rand() - 0.5) * 1.9;
      card(
        [side * 0.014 * (layer === 1 ? 0.2 : 1), py + 0.052, pz - 0.006],
        fall, [Math.sin(th), 0.30, Math.cos(th)], 0.100 + rand() * 0.048, len, bones,
        { u: rand() * 0.55, k: 0.86 + rand() * 0.80 },
        (side * 0.05) + (rand() - 0.5) * 0.07,
      );
    }
  }

  /* -------------------------------------------------------------- FORELOCK */
  for (let i = 0; i < 7; i++) {
    const x = (i / 6 - 0.5) * 0.098;
    const len = 0.150 * (0.70 + rand() * 0.60);
    const th = (rand() - 0.5) * 1.6;
    card([x, 2.040, 1.026], [x * 1.2, -0.86, 0.51], [Math.cos(th), 0, Math.sin(th)],
      0.055 + rand() * 0.026, len, w('head', 1),
      { u: rand() * 0.58, k: 0.82 + rand() * 0.62 }, (rand() - 0.5) * 0.06);
  }

  /* ------------------------------------------------------------------ TAIL */
  const tailBones = [
    w('tail1', 0.7, 'croup', 0.3), w('tail1', 1),
    w('tail1', 0.4, 'tail2', 0.6), w('tail2', 1),
    w('tail2', 0.4, 'tail3', 0.6), w('tail3', 1),
  ];
  const NT = 46;
  for (let i = 0; i < NT; i++) {
    const g = i / (NT - 1);
    // cards launch from successive points down the dock, fanning outward
    const st = Math.min(0.86, Math.pow(rand(), 0.65) * 0.9);
    const bi = Math.min(tailBones.length - 1, Math.floor(st * tailBones.length));
    const ry = 1.520 - st * 0.400;
    const rz = -0.836 - st * 0.185;
    const a = g * TAU + rand() * 0.5;
    const spread = 0.026 + st * 0.030;
    const len = (0.62 - st * 0.22) * (0.78 + rand() * 0.44);
    const fall = [Math.cos(a) * 0.22, -1.0, -0.24 + Math.sin(a) * 0.13];
    card(
      [Math.cos(a) * spread, ry, rz + Math.sin(a) * spread * 0.7],
      fall, [-Math.sin(a), 0, Math.cos(a)], 0.052 + rand() * 0.038, len, tailBones[bi],
      { u: rand() * 0.55, k: 0.74 + rand() * 0.74 },
      (rand() - 0.5) * 0.07,
    );
  }

  return B.build();
}
