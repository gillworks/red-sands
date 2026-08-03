import {
  clamp01, smoothstep, lerp, mix3, hash1, hash2, vnoise, fbm, vfbm, ridged,
  worley, worleyA, cracks, warp, partition1, spots, grain,
} from './Noise.js';

/**
 * Recipes.js — every surface in the game, authored as a THREE-BAND PYRAMID.
 *
 * WHY THE SHAPE CHANGED. The forensic reports converged on one sentence:
 * "Foreground boulder fills ~20% of frame yet has no surface detail whatsoever:
 * no normal map, no pores/cracks/lichen, just a smeary low-frequency diffuse
 * blur." Pass 2 authored each surface as a single `height(u,v)` built from
 * gain-0.5 fBm. That distribution puts 97% of its energy in the first three
 * octaves, so magnifying it yields exactly what they measured: mush.
 *
 * Each recipe now declares three explicitly-weighted bands:
 *
 *   b0  MACRO  evaluated at S/16 (64px @ 1024)  — metres      ≤16 cycles
 *   b1  MESO   evaluated at S/4  (256px)        — decimetres  ≤64 cycles
 *   b2  MICRO  evaluated at S/1  (1024px)       — millimetres ≤256 cycles
 *
 * ...with amplitudes around 0.45 / 0.33 / 0.22 rather than 0.57 / 0.28 / 0.14 /
 * 0.07 / 0.03. The meso band — cracks, plates, plank seams, individual pebbles,
 * mortar — is the one the critics named as missing and it now carries a third
 * of the signal.
 *
 * Evaluating each band on its own grid is also why this is *faster* than pass
 * 2 despite carrying far more information: the expensive Worley/crack work runs
 * on 4k or 65k samples, and only a single cheap value-noise runs on the full
 * megapixel.
 *
 * `albedo(h, x, y, s)` receives the upsampled bands (`s.b0/b1/b2`), an optional
 * fourth `mask` field (`s.m`), and the derived cavity/convexity (`s.cav`,
 * `s.cvx`) so colour can key off form without re-evaluating noise.
 *
 * `wear` drives the universal edge-wear / cavity-dirt / bleaching pass in
 * Bake.js — §5's "edge wear, dirt accumulation in crevices, sun-bleaching on
 * up-facing planes", applied once for the whole library.
 */

const B = (div, amp, fn) => ({ div, amp, fn });

/* Palette anchors, sRGB. §5: bleached ochre, sage, dust grey, oxidised red. */
const DUST = [126, 112, 94];
const GRIME = [58, 50, 40];
const SOOT = [40, 36, 32];
const BLEACH = [214, 205, 186];
const OXIDE = [138, 84, 52];
const LICHEN_A = [150, 152, 122];   // pale sage crust
const LICHEN_B = [176, 168, 128];   // ochre crust
const MOSS = [96, 104, 72];

/* ------------------------------------------------------------------ helpers */

/** Two-tone mineral speckle: quartz flecks and dark ferro grains. */
function speckle(x, y, f, seed) {
  const g = grain(x, y, f, seed);
  return g > 0.86 ? (g - 0.86) * 5.0 : (g < 0.13 ? -(0.13 - g) * 4.0 : 0);
}

/** Bedded strata tone: quantised into beds with a per-bed hash. */
function bedTone(y, beds, seed) {
  const p = partition1(y, beds, seed, 0.55);
  return p.id;
}

export const RECIPES = {

  /* ================================================================ ROCK == */

  /**
   * Bedded sandstone cliff. Horizontal beds, vertical relief joints, a fractal
   * crack network, spall scars where slabs have popped off, and case-hardened
   * desert varnish streaking down from the bed lines.
   */
  rock_cliff: {
    rough: [0.66, 0.94], disp: 1.28,
    bands: [
      B(16, 0.44, (x, y) => {
        const p = [0, 0]; warp(x, y, 2, 0.10, 21, p);
        const bed = fbm(p[0] * 0.30, p[1] * 3.6, { octaves: 4, freq: 2, period: 2, gain: 0.62, seed: 11 });
        const face = fbm(x, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 31 });
        return clamp01(bed * 0.66 + face * 0.34);
      }),
      B(4, 0.34, (x, y) => {
        const p = [0, 0]; warp(x, y, 4, 0.045, 47, p);
        const w = worleyA(p[0], p[1], 6, 11, 53);           // blocky spall
        const block = smoothstep(0.05, 0.55, w.f2 - w.f1) * 0.5 + w.id * 0.18;
        const joint = cracks(x, y, { cells: 5, seed: 67, width: 0.16, octaves: 3, warpAmt: 0.05 });
        /* bed lines on a WARPED y, so the courses undulate and vary in
           thickness instead of reading as evenly-spaced masonry */
        const bw = y + vfbm(x, y, { octaves: 2, freq: 3, gain: 0.55, seed: 79 }) * 0.055;
        const bedline = 1 - smoothstep(0.0, 0.10, partition1(bw, 14, 77, 0.6).edge);
        return clamp01(0.32 + block * 0.62 - joint * 0.52 - bedline * 0.24);
      }),
      B(1, 0.25, (x, y) => vfbm(x, y, { octaves: 3, freq: 46, gain: 0.62, seed: 5 }) * 0.55
        + vfbm(x, y, { octaves: 2, freq: 120, gain: 0.55, seed: 7 }) * 0.18
        + spots(x, y, 110, 91, 0.45, 0.30) * 0.27),
    ],
    mask: { div: 4, fn: (x, y) => vfbm(x, y, { octaves: 3, freq: 5, gain: 0.6, seed: 303 }) },
    albedo: (h, x, y, s) => {
      const bt = bedTone(y, 14, 77);
      let c = mix3([158, 143, 122], [172, 116, 84], clamp01(bt * 1.25 - 0.12));
      c = mix3(c, [122, 110, 100], clamp01((s.b0 - 0.55) * 1.6));
      /* desert varnish: dark manganese streaks bleeding down the face */
      const varnish = clamp01((s.m - 0.52) * 3.2) * clamp01(1.0 - s.b1 * 0.5);
      c = mix3(c, [74, 60, 48], varnish * 0.42);
      const t = 0.68 + h * 0.44 + speckle(x, y, 150, 9) * 0.16;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.72, cavityCol: GRIME, edge: 0.44, edgeCol: BLEACH, cavRough: 0.10 },
  },

  rock_slab: {
    rough: [0.58, 0.90], disp: 1.08,
    bands: [
      B(16, 0.46, (x, y) => {
        const w = worley(x, y, 4, 11);
        return clamp01(smoothstep(0.0, 0.7, w.f2 - w.f1) * 0.7 + fbm(x, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 2 }) * 0.3);
      }),
      B(4, 0.32, (x, y) => {
        const step = cracks(x, y, { cells: 7, seed: 13, width: 0.14, octaves: 3 });
        const flake = worley(x, y, 16, 29);
        return clamp01(0.45 + flake.id * 0.30 - step * 0.55 + (1 - flake.f1) * 0.18);
      }),
      B(1, 0.25, (x, y) => vfbm(x, y, { octaves: 3, freq: 52, gain: 0.6, seed: 71 }) * 0.76
        + vfbm(x, y, { octaves: 2, freq: 132, gain: 0.55, seed: 73 }) * 0.24),
    ],
    mask: { div: 4, fn: (x, y) => vfbm(x, y, { octaves: 3, freq: 4, gain: 0.62, seed: 411 }) },
    albedo: (h, x, y, s) => {
      let c = mix3([128, 122, 112], [104, 98, 94], s.b0);
      c = mix3(c, LICHEN_A, clamp01((s.m - 0.60) * 3.0) * 0.55);
      const t = 0.60 + h * 0.55 + speckle(x, y, 140, 33) * 0.19;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.66, cavityCol: GRIME, edge: 0.50, edgeCol: BLEACH, cavRough: 0.09 },
  },

  /**
   * HERO SURFACE — this is the boulder that fills 20% of river_bend and it is
   * the single most-cited failure in the forensic set. Everything the reviewer
   * said was missing is authored explicitly: a fractal crack network, pores,
   * conchoidal chip scars, lichen crusts with a darker rim, mineral speckle and
   * bleached wear on every convex edge.
   */
  rock_boulder: {
    /* disp raised 1.05 -> 1.24: this is the ONLY surface the scatter rock
       material samples, so its normal map is what a 1:1 rock face is made of.
       The playtester's word for the old one was "crumpled cardboard". */
    rough: [0.62, 0.93], disp: 1.24,
    bands: [
      B(16, 0.42, (x, y) => {
        const p = [0, 0]; warp(x, y, 2, 0.13, 3, p);
        const lobe = fbm(p[0], p[1], { octaves: 4, freq: 3, period: 3, gain: 0.62, seed: 7 });
        const w = worley(x, y, 3, 21);
        return clamp01(lobe * 0.62 + smoothstep(0.0, 0.8, w.f2 - w.f1) * 0.38);
      }),
      B(4, 0.32, (x, y) => {
        /* conchoidal chip scars — soft plateaus, each with its own tilt — plus
           a SPARSE set of deep fractures. Weighting the crack network as hard
           as the facets turns a boulder into crazed mud, which is exactly what
           the first iteration of this recipe did. */
        const p = [0, 0]; warp(x, y, 3, 0.06, 55, p);
        const w = worley(p[0], p[1], 6, 41);
        const facet = w.id * 0.30 + (1 - w.f1) * 0.22 + smoothstep(0.0, 0.7, w.f2 - w.f1) * 0.24;
        const crk = cracks(x, y, { cells: 4, seed: 83, width: 0.055, octaves: 3, gain: 0.42, warpAmt: 0.12 });
        /* a SECOND, finer crack network at a different cell size. One network is
           a set of isolated lines; two intersecting ones is a fracture pattern,
           and the intersections are where the dirt actually collects. */
        const crk2 = cracks(x, y, { cells: 9, seed: 331, width: 0.032, octaves: 2, gain: 0.5, warpAmt: 0.09 });
        const vesicle = spots(x, y, 16, 137, 0.42, 0.24);
        return clamp01(0.34 + facet * 0.64 - crk * 0.34 - crk2 * 0.17 - vesicle * 0.16);
      }),
      B(1, 0.30, (x, y) => {
        /* grain dominates; pores are clumped, not a lattice of dimples. The
           sand GRAIN itself is the thing you read at 1:1 on a sandstone face,
           so it now carries a second, finer octave of its own. */
        const gr = vfbm(x, y, { octaves: 3, freq: 50, gain: 0.64, seed: 17 });
        const gr2 = vfbm(x, y, { octaves: 2, freq: 128, gain: 0.55, seed: 19 });
        const cl = vnoise(x * 9, y * 9, 9, 157);
        const pores = spots(x, y, 74, 151, 0.34, 0.20 + cl * 0.34);
        return clamp01(gr * 0.70 + gr2 * 0.22 - pores * 0.22 + 0.10);
      }),
    ],
    mask: { div: 4, fn: (x, y) => {
      /* lichen colonies — irregular, eroded boundaries, not fBm blobs */
      const p = [0, 0]; warp(x, y, 5, 0.07, 601, p);
      const a = vfbm(p[0], p[1], { octaves: 3, freq: 4, gain: 0.62, seed: 607 });
      const b = vfbm(x, y, { octaves: 2, freq: 13, gain: 0.55, seed: 613 });
      return clamp01((a - 0.46) * 3.4 - (b - 0.5) * 0.9);
    } },
    albedo: (h, x, y, s) => {
      /* two mineral tones + per-facet jitter so no two chip scars match */
      let c = mix3([118, 110, 100], [148, 128, 108], clamp01(s.b0 * 1.5 - 0.25));
      c = mix3(c, [96, 86, 80], clamp01((0.42 - s.b1) * 2.2));
      /* lichen: pale crust with a darker moist rim where it meets bare stone */
      const lich = clamp01(s.m);
      c = mix3(c, LICHEN_B, smoothstep(0.35, 0.95, lich) * 0.62);
      c = mix3(c, MOSS, smoothstep(0.10, 0.34, lich) * (1 - smoothstep(0.34, 0.55, lich)) * 0.34);
      const t = 0.62 + h * 0.52 + speckle(x, y, 165, 23) * 0.23;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    /* deeper dirt in the cracks, brighter chipping on the convex edges — the
       two things §5 calls out and the two the reviewer said were missing */
    wear: { cavity: 0.84, cavityCol: GRIME, edge: 0.62, edgeCol: BLEACH, cavRough: 0.12, edgeRough: -0.12 },
  },

  /* ============================================================== GROUND == */

  dirt_dry: {
    rough: [0.84, 0.99], disp: 0.62,
    bands: [
      B(16, 0.42, (x, y) => fbm(x, y, { octaves: 4, freq: 3, period: 3, gain: 0.6, seed: 9 })),
      B(4, 0.36, (x, y) => {
        /* this tiles at ~8 m on the terrain, so a strong crack network reads as
           a metre-wide playa. Pebble lag and clod structure, cracks as a hint. */
        const mud = cracks(x, y, { cells: 10, seed: 67, width: 0.055, octaves: 2, warpAmt: 0.06 });
        const peb = worley(x, y, 30, 63);
        const stones = (1 - smoothstep(0.16, 0.58, peb.f1)) * (peb.id > 0.42 ? 1 : 0) * (0.5 + peb.id * 0.5);
        const clod = vfbm(x, y, { octaves: 3, freq: 14, gain: 0.6, seed: 5 });
        return clamp01(0.34 + stones * 0.46 + clod * 0.36 - mud * 0.16);
      }),
      B(1, 0.24, (x, y) => vfbm(x, y, { octaves: 3, freq: 62, gain: 0.6, seed: 29 })),
    ],
    mask: { div: 4, fn: (x, y) => vfbm(x, y, { octaves: 3, freq: 6, gain: 0.6, seed: 705 }) },
    albedo: (h, x, y, s) => {
      let c = mix3([146, 122, 98], [178, 156, 124], clamp01(s.m * 1.3 - 0.15));
      /* the pebble lag reads a shade cooler and darker than the fines */
      c = mix3(c, [126, 118, 108], clamp01((s.b1 - 0.62) * 2.6) * 0.7);
      const t = 0.70 + h * 0.44 + speckle(x, y, 170, 47) * 0.13;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.58, cavityCol: [70, 58, 44], edge: 0.42, edgeCol: BLEACH, cavRough: 0.06 },
  },

  dirt_packed: {
    rough: [0.74, 0.95], disp: 0.5,
    bands: [
      B(16, 0.40, (x, y) => fbm(x * 1.0, y * 0.45, { octaves: 4, freq: 3, period: 3, gain: 0.6, seed: 15 })),
      B(4, 0.40, (x, y) => {
        /* Cart ruts along u, gravel pressed into the surface, hoof scuffs and
           the little pebble lag that collects between them. town_street and
           night_camp both put the camera a metre off this surface and pass 2
           had literally nothing here but low-frequency noise. */
        const rut = Math.pow(Math.abs(Math.sin((y + vnoise(x * 3, y * 3, 3, 88) * 0.22) * Math.PI * 3)), 0.5);
        const peb = worley(x, y, 26, 5);
        const big = (1 - smoothstep(0.10, 0.52, peb.f1)) * (peb.id > 0.55 ? 1 : 0) * (0.5 + peb.id * 0.5);
        const grit = worley(x + 0.23, y - 0.41, 52, 7);
        const small = (1 - smoothstep(0.12, 0.62, grit.f1)) * (grit.id > 0.40 ? 1 : 0);
        const hoof = spots(x, y, 11, 93, 0.55, 0.20);
        const scuff = vfbm(x, y, { octaves: 3, freq: 15, gain: 0.6, seed: 91 });
        return clamp01(0.26 + rut * 0.20 + big * 0.44 + small * 0.22 + scuff * 0.26 - hoof * 0.22);
      }),
      B(1, 0.24, (x, y) => vfbm(x, y, { octaves: 3, freq: 66, gain: 0.62, seed: 37 })),
    ],
    mask: { div: 4, fn: (x, y) => {
      const peb = worley(x, y, 26, 5);
      return (1 - smoothstep(0.10, 0.52, peb.f1)) * (peb.id > 0.55 ? 1 : 0) * (0.4 + peb.id * 0.6);
    } },
    albedo: (h, x, y, s) => {
      /* dust between the stones, each stone its own cooler mineral tone */
      let c = mix3([132, 112, 88], [166, 146, 116], clamp01(s.b0 * 1.5 - 0.25));
      c = mix3(c, mix3([112, 106, 98], [146, 136, 122], s.m), clamp01(s.m * 2.2));
      const t = 0.68 + h * 0.48 + speckle(x, y, 175, 61) * 0.14;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.62, cavityCol: [64, 52, 40], edge: 0.38, edgeCol: [190, 176, 152], cavRough: 0.05 },
  },

  mud: {
    rough: [0.26, 0.62], disp: 0.7,
    bands: [
      B(16, 0.44, (x, y) => fbm(x, y, { octaves: 4, freq: 3, period: 3, gain: 0.6, seed: 44 })),
      B(4, 0.34, (x, y) => {
        const c = cracks(x, y, { cells: 7, seed: 31, width: 0.18, octaves: 2, warpAmt: 0.06 });
        const hoof = spots(x, y, 9, 313, 0.6, 0.30);
        return clamp01(0.62 - c * 0.5 - hoof * 0.42 + vfbm(x, y, { octaves: 2, freq: 14, seed: 3 }) * 0.24);
      }),
      B(1, 0.22, (x, y) => vfbm(x, y, { octaves: 2, freq: 44, gain: 0.58, seed: 55 })),
    ],
    albedo: (h) => [74 * h + 30, 60 * h + 24, 44 * h + 18],
    wear: { cavity: 0.8, cavityCol: [26, 22, 17], edge: 0.24, edgeCol: [120, 106, 86], cavRough: -0.16 },
  },

  /*
   * Dry western grassland, NOT a lawn. §5 rejects "saturated cartoon green".
   * Sage (hue ~62deg, sat ~0.19) mixed with sun-bleached straw (hue ~46deg),
   * broken by tussock clumps and bare soil between them.
   */
  grass_prairie: {
    rough: [0.70, 0.96], disp: 0.72,
    bands: [
      B(16, 0.40, (x, y) => fbm(x, y, { octaves: 4, freq: 3, period: 3, gain: 0.62, seed: 101 })),
      B(4, 0.34, (x, y) => {
        const tuss = worley(x, y, 13, 103);
        const clump = (1 - smoothstep(0.1, 0.85, tuss.f1)) * (0.5 + tuss.id * 0.5);
        return clamp01(0.28 + clump * 0.62 + vfbm(x, y, { octaves: 3, freq: 17, gain: 0.6, seed: 107 }) * 0.34);
      }),
      /* blade-scale striation — anisotropic, so it reads as fibre not as fuzz */
      B(1, 0.26, (x, y) => vfbm(x * 0.28, y * 1.0, { octaves: 3, freq: 68, gain: 0.6, seed: 109 })),
    ],
    mask: { div: 4, fn: (x, y) => clamp01(fbm(x + 5.5, y - 2.5, { octaves: 3, freq: 3, period: 3, gain: 0.62, seed: 113 }) * 1.2 - 0.1) },
    albedo: (h, x, y, s) => {
      const dry = clamp01(s.m * 0.85 + s.b1 * 0.35 - 0.12);
      const soil = clamp01((0.34 - h) * 3.0) * 0.55;
      const v = 0.72 + h * 0.52 + (s.b1 - 0.5) * 0.20;
      const c = mix3([98, 114, 82], [168, 154, 116], dry);
      const t = mix3(c, [126, 106, 82], soil);
      return [t[0] * v, t[1] * v, t[2] * v];
    },
    wear: { cavity: 0.44, cavityCol: [54, 50, 36], edge: 0.40, edgeCol: [206, 196, 162], cavRough: 0.04 },
  },

  grass_dry: {
    rough: [0.76, 0.98], disp: 0.72,
    bands: [
      B(16, 0.40, (x, y) => fbm(x, y, { octaves: 4, freq: 3, period: 3, gain: 0.62, seed: 121 })),
      B(4, 0.34, (x, y) => {
        const tuss = worley(x, y, 16, 127);
        const clump = (1 - smoothstep(0.1, 0.8, tuss.f1)) * (0.45 + tuss.id * 0.55);
        return clamp01(0.26 + clump * 0.60 + vfbm(x, y, { octaves: 3, freq: 20, gain: 0.6, seed: 131 }) * 0.36);
      }),
      B(1, 0.26, (x, y) => vfbm(x * 0.26, y * 1.0, { octaves: 3, freq: 74, gain: 0.6, seed: 137 })),
    ],
    mask: { div: 4, fn: (x, y) => clamp01(fbm(x + 8.3, y - 6.1, { octaves: 3, freq: 4, period: 4, gain: 0.62, seed: 139 })) },
    albedo: (h, x, y, s) => {
      const soil = clamp01((0.34 - h) * 2.8) * 0.6;
      const v = 0.74 + h * 0.48 + (s.b1 - 0.5) * 0.22;
      const c = mix3([150, 142, 112], [180, 166, 124], s.m);
      const t = mix3(c, [130, 110, 84], soil);
      return [t[0] * v, t[1] * v, t[2] * v];
    },
    wear: { cavity: 0.46, cavityCol: [58, 52, 38], edge: 0.44, edgeCol: [214, 204, 170], cavRough: 0.04 },
  },

  sand_fine: {
    rough: [0.80, 0.96], disp: 0.36,
    bands: [
      B(16, 0.40, (x, y) => fbm(x * 1.0, y * 0.55, { octaves: 4, freq: 3, period: 3, gain: 0.6, seed: 151 })),
      B(4, 0.34, (x, y) => {
        /* two crossed ripple trains at different scales and drift angles */
        const w1 = vnoise(x * 5, y * 5, 5, 157) * 0.22;
        const r1 = 0.5 + 0.5 * Math.sin((y + w1) * Math.PI * 2 * 9);
        const w2 = vnoise(x * 7, y * 7, 7, 163) * 0.18;
        const r2 = 0.5 + 0.5 * Math.sin((x * 0.82 + y * 0.57 + w2) * Math.PI * 2 * 14);
        return clamp01(r1 * 0.5 + r2 * 0.28 + vfbm(x, y, { octaves: 2, freq: 22, seed: 167 }) * 0.30);
      }),
      B(1, 0.26, (x, y) => vfbm(x, y, { octaves: 2, freq: 90, gain: 0.55, seed: 173 })),
    ],
    albedo: (h, x, y) => {
      const t = 0.72 + h * 0.44 + speckle(x, y, 190, 179) * 0.12;
      return [166 * t, 148 * t, 118 * t];
    },
    wear: { cavity: 0.34, cavityCol: [92, 78, 60], edge: 0.36, edgeCol: BLEACH, cavRough: 0.03 },
  },

  gravel: {
    rough: [0.72, 0.96], disp: 0.85,
    bands: [
      B(16, 0.30, (x, y) => fbm(x, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 181 })),
      B(4, 0.42, (x, y) => {
        const a = worley(x, y, 24, 191);
        const b = worley(x + 0.31, y - 0.17, 40, 193);
        return clamp01((1 - a.f1) * 0.62 * (0.6 + a.id * 0.6) + (1 - b.f1) * 0.34);
      }),
      B(1, 0.30, (x, y) => vfbm(x, y, { octaves: 3, freq: 70, gain: 0.6, seed: 197 }) * 0.78
        + vfbm(x, y, { octaves: 2, freq: 150, gain: 0.55, seed: 198 }) * 0.22),
    ],
    albedo: (h, x, y, s) => {
      const c = mix3([118, 110, 100], [152, 138, 116], clamp01(s.b1 * 1.4 - 0.2));
      const t = 0.58 + h * 0.58 + speckle(x, y, 160, 199) * 0.16;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.68, cavityCol: [56, 48, 38], edge: 0.46, edgeCol: BLEACH, cavRough: 0.07 },
  },

  /* angular talus — every fragment its own tone, deep shadow between them */
  scree: {
    rough: [0.74, 0.96], disp: 1.05,
    bands: [
      B(16, 0.30, (x, y) => fbm(x, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 211 })),
      B(4, 0.44, (x, y) => {
        const a = worley(x, y, 12, 223);
        const b = worley(x * 1.0 + 0.37, y * 1.0 - 0.21, 25, 227);
        const flat = (a.id * 0.5 + 0.5) * smoothstep(0.0, 0.5, a.f2 - a.f1);
        return clamp01(flat * 0.70 + (1 - b.f1) * 0.34);
      }),
      B(1, 0.29, (x, y) => vfbm(x, y, { octaves: 3, freq: 64, gain: 0.6, seed: 229 }) * 0.78
        + vfbm(x, y, { octaves: 2, freq: 142, gain: 0.55, seed: 231 }) * 0.22),
    ],
    albedo: (h, x, y, s) => {
      const c = mix3([118, 112, 104], [158, 138, 112], clamp01(s.b1 * 1.5 - 0.25));
      const t = 0.56 + h * 0.6 + speckle(x, y, 150, 233) * 0.18;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.74, cavityCol: [48, 42, 34], edge: 0.52, edgeCol: BLEACH, cavRough: 0.08 },
  },

  snow: {
    rough: [0.26, 0.58], disp: 0.45,
    bands: [
      B(16, 0.46, (x, y) => fbm(x, y, { octaves: 4, freq: 3, period: 3, gain: 0.62, seed: 241 })),
      B(4, 0.32, (x, y) => {
        const drift = 0.5 + 0.5 * Math.sin((x * 0.7 + y * 0.7 + vnoise(x * 4, y * 4, 4, 251) * 0.4) * Math.PI * 2 * 6);
        return clamp01(drift * 0.5 + vfbm(x, y, { octaves: 3, freq: 18, seed: 257 }) * 0.5);
      }),
      B(1, 0.22, (x, y) => vfbm(x, y, { octaves: 2, freq: 80, gain: 0.55, seed: 263 })),
    ],
    albedo: (h) => [200 + 48 * h, 208 + 44 * h, 224 + 30 * h],
    wear: { cavity: 0.30, cavityCol: [150, 162, 184], edge: 0.20, edgeCol: [255, 255, 255], cavRough: -0.05 },
  },

  /* ================================================================ BARK == */

  /**
   * REGRESSION FIX. night_camp: "the bark is one small texture tiled ~12x along
   * each log's length, producing an identical chevron/zigzag 'corrugated hose'
   * rhythm that repeats with machine regularity."
   *
   * The cause was `fbm(x*5.0, y*0.5)` — a 5x anisotropic squash of a single
   * noise band, which is literally a comb. Real pine bark is a mosaic of
   * irregular polygonal PLATES separated by deep fissures, each plate a
   * different thickness and tone, with flaky lamination across its face. That
   * is what this is: warped anisotropic Worley plates, meandering ridged
   * fissures that branch, and per-plate colour.
   */
  bark_pine: {
    rough: [0.76, 0.97], disp: 1.60,
    bands: [
      B(16, 0.22, (x, y) => {
        const p = [0, 0]; warp(x, y, 2, 0.12, 271, p);
        return fbm(p[0] * 0.8, p[1] * 0.5, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 277 });
      }),
      B(4, 0.46, (x, y) => {
        const p = [0, 0]; warp(x, y, 4, 0.05, 281, p);
        /* Bark is a VERTICAL fissure network first and a plate mosaic second.
           Leading with the plates gives reptile skin (dome per cell) or crazy
           paving (plateau per cell); leading with a ridged field stretched 7:1
           along v gives long wandering furrows, and the Worley layer then
           breaks the ridges into scales that step over one another. */
        const fiss = ridged(p[0] * 2.4, p[1] * 0.34, { octaves: 4, freq: 6, period: 6, gain: 0.55, sharp: 2.4, seed: 293 });
        const pl = worleyA(p[0], p[1], 15, 6, 283);
        const plate = smoothstep(0.0, 0.13, pl.f2 - pl.f1) * (0.34 + pl.id * 0.66);
        const lam = vfbm(x * 0.5 + pl.id * 3.1, y * 1.8, { octaves: 3, freq: 34, gain: 0.55, seed: 289 });
        return clamp01(0.08 + fiss * (0.46 + plate * 0.44) + plate * lam * 0.22);
      }),
      B(1, 0.20, (x, y) => vfbm(x * 0.45, y * 1.0, { octaves: 3, freq: 56, gain: 0.62, seed: 307 })),
    ],
    mask: { div: 4, fn: (x, y) => {
      const p = [0, 0]; warp(x, y, 4, 0.05, 281, p);
      return worleyA(p[0], p[1], 15, 6, 283).id;
    } },
    albedo: (h, x, y, s) => {
      /* per-plate tone: grey-brown outer scale over an ochre-red inner bark */
      let c = mix3([124, 106, 86], [168, 146, 116], s.m);
      c = mix3(c, [96, 56, 36], clamp01((0.44 - h) * 2.4) * 0.88);   // fissures show inner bark
      const t = 0.62 + h * 0.48 + speckle(x, y, 150, 311) * 0.14;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.72, cavityCol: [40, 30, 22], edge: 0.46, edgeCol: [178, 166, 142], cavRough: 0.06 },
  },

  /** Deeply furrowed oak: long meandering ridges that fork, not a stripe map. */
  bark_oak: {
    rough: [0.78, 0.97], disp: 1.60,
    bands: [
      B(16, 0.20, (x, y) => {
        const p = [0, 0]; warp(x, y, 2, 0.14, 317, p);
        return fbm(p[0] * 1.2, p[1] * 0.4, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 331 });
      }),
      B(4, 0.46, (x, y) => {
        const p = [0, 0]; warp(x, y, 3, 0.09, 337, p);
        /* deep furrows running along v; the warp makes them wander, fork and
           merge, and a second sharper octave set gives the ridge tops their
           blocky broken crown */
        const fur = ridged(p[0] * 5.0, p[1] * 0.34, { octaves: 4, freq: 6, period: 6, gain: 0.5, sharp: 2.6, seed: 347 });
        const cross = worleyA(p[0], p[1], 9, 5, 349);
        const brk = smoothstep(0.0, 0.18, cross.f2 - cross.f1) * (0.4 + cross.id * 0.6);
        return clamp01(0.06 + fur * (0.52 + brk * 0.46) + brk * 0.10);
      }),
      B(1, 0.22, (x, y) => vfbm(x * 0.4, y * 1.0, { octaves: 3, freq: 60, gain: 0.62, seed: 353 })),
    ],
    mask: { div: 4, fn: (x, y) => {
      const p = [0, 0]; warp(x, y, 3, 0.09, 337, p);
      return worleyA(p[0], p[1], 9, 5, 349).id;
    } },
    albedo: (h, x, y, s) => {
      let c = mix3([116, 100, 80], [154, 136, 110], s.m);
      c = mix3(c, [52, 42, 34], clamp01((0.44 - h) * 2.2) * 0.82);
      const t = 0.62 + h * 0.50 + speckle(x, y, 145, 359) * 0.13;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.82, cavityCol: [28, 24, 18], edge: 0.42, edgeCol: [168, 156, 134], cavRough: 0.06 },
  },

  /** Paper birch: peeling horizontal curls, lenticel dashes, dark scars. */
  bark_birch: {
    rough: [0.58, 0.88], disp: 0.7,
    bands: [
      B(16, 0.38, (x, y) => fbm(x * 0.4, y * 2.4, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 367 })),
      B(4, 0.38, (x, y) => {
        const curl = partition1(y, 10, 373, 0.7);
        const peel = smoothstep(0.0, 0.09, curl.edge) * (0.6 + curl.id * 0.4);
        const lent = worleyA(x, y, 5, 30, 379);
        const dash = (1 - smoothstep(0.15, 0.75, lent.f1)) * (lent.id > 0.66 ? 1 : 0);
        return clamp01(0.35 + peel * 0.5 - dash * 0.4 + vfbm(x, y, { octaves: 2, freq: 12, seed: 383 }) * 0.24);
      }),
      B(1, 0.24, (x, y) => vfbm(x * 1.0, y * 0.3, { octaves: 3, freq: 64, gain: 0.6, seed: 389 })),
    ],
    mask: { div: 4, fn: (x, y) => {
      const lent = worleyA(x, y, 5, 30, 379);
      return (1 - smoothstep(0.10, 0.62, lent.f1)) * (lent.id > 0.62 ? 1 : 0);
    } },
    albedo: (h, x, y, s) => {
      let c = mix3([196, 190, 176], [226, 222, 210], clamp01(h * 1.4 - 0.2));
      c = mix3(c, [58, 52, 46], clamp01(s.m) * 0.86);                   // lenticels
      c = mix3(c, [162, 128, 96], clamp01((0.30 - s.b1) * 2.4) * 0.5);  // exposed underbark
      const t = 0.82 + h * 0.24 + speckle(x, y, 150, 397) * 0.08;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.52, cavityCol: [66, 60, 52], edge: 0.30, edgeCol: [255, 252, 244], cavRough: 0.05 },
  },

  /* ============================================================= FOLIAGE == */

  /* leaves_atlas is generated by LeafAtlas.js — this entry is the fallback
     descriptor so `has()` and the layer tables still resolve. */
  leaves_atlas: {
    rough: [0.52, 0.80], disp: 0.35, alpha: true, atlas: 'leaf',
    bands: [
      B(16, 0.4, (x, y) => vfbm(x, y, { octaves: 3, freq: 4, seed: 401 })),
      B(4, 0.35, (x, y) => vfbm(x, y, { octaves: 3, freq: 14, seed: 409 })),
      B(1, 0.25, (x, y) => vfbm(x, y, { octaves: 2, freq: 60, seed: 419 })),
    ],
    albedo: (h) => [86 + 46 * h, 92 + 42 * h, 66 + 30 * h],
  },

  /* sagebrush / chaparral — grey-green, never emerald */
  foliage_scrub: {
    rough: [0.58, 0.86], disp: 0.35, alpha: true, atlas: 'scrub',
    bands: [
      B(16, 0.4, (x, y) => vfbm(x, y, { octaves: 3, freq: 5, seed: 421 })),
      B(4, 0.35, (x, y) => vfbm(x, y, { octaves: 3, freq: 16, seed: 431 })),
      B(1, 0.25, (x, y) => vfbm(x, y, { octaves: 2, freq: 64, seed: 433 })),
    ],
    albedo: (h) => [104 + 42 * h, 106 + 40 * h, 84 + 30 * h],
  },

  /* ================================================================ WOOD == */

  /**
   * Sawn pine boarding. Planks of UNEQUAL width (partition1), each with its own
   * grain phase, tone, cup and end-check pattern; knots with concentric rings
   * that deflect the grain; saw kerf marks across the face; nail holes with a
   * rust bloom.
   */
  wood_plank: {
    rough: [0.58, 0.92], disp: 0.85,
    bands: [
      B(16, 0.34, (x, y) => {
        const p = partition1(y, 7, 443, 0.42);
        return clamp01(0.35 + p.id * 0.45 + fbm(x * 0.3, y * 1.0, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 449 }) * 0.30);
      }),
      B(4, 0.44, (x, y) => {
        const p = partition1(y, 7, 443, 0.42);
        /* grain rings run along u; phase and pitch differ per board */
        const ph = p.id * 7.3;
        /* cathedral figure: rings crowded along the board, opened out by the
           per-board phase so no two boards scan alike */
        const gr = ridged((x + ph) * 1.0, p.t * 0.34 + p.id, { octaves: 4, freq: 11, period: 11, gain: 0.48, sharp: 2.0, seed: 457 });
        const knot = spots(x, p.t * 0.32 + p.index * 0.137, 5, 461, 0.5, 0.16);
        const seam = 1 - smoothstep(0.0, 0.0105, p.dist);
        const saw = 0.5 + 0.5 * Math.sin((x + vnoise(x * 6, y * 6, 6, 463) * 0.2) * Math.PI * 2 * 26);
        return clamp01(0.34 + gr * 0.52 + knot * 0.22 - seam * 0.52 + saw * 0.09);
      }),
      B(1, 0.22, (x, y) => vfbm(x * 1.0, y * 0.22, { octaves: 3, freq: 72, gain: 0.6, seed: 467 })),
    ],
    mask: { div: 4, fn: (x, y) => partition1(y, 7, 443, 0.42).id },
    albedo: (h, x, y, s) => {
      let c = mix3([132, 100, 68], [186, 156, 112], s.m);                // per-board tone
      c = mix3(c, [92, 68, 44], clamp01((0.40 - s.b1) * 2.4) * 0.82);    // dark late-wood
      const t = 0.58 + h * 0.56 + speckle(x, y, 160, 479) * 0.10;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.74, cavityCol: [46, 36, 26], edge: 0.52, edgeCol: [204, 190, 164], cavRough: 0.07, edgeRough: -0.08 },
  },

  /**
   * Silvered, split, weathered barn board. The soft spring-wood has eroded
   * away leaving the hard late-wood proud (raised grain), the boards have
   * checked and split along the grain, and the whole surface has gone
   * grey-silver with the lignin washed out.
   */
  wood_weathered: {
    rough: [0.74, 0.98], disp: 1.15,
    bands: [
      B(16, 0.32, (x, y) => {
        const p = partition1(y, 6, 487, 0.5);
        return clamp01(0.30 + p.id * 0.5 + fbm(x * 0.35, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 491 }) * 0.30);
      }),
      B(4, 0.46, (x, y) => {
        const p = partition1(y, 6, 487, 0.5);
        const ph = p.id * 5.7;
        /* raised late-wood: sharp ridges, not a smooth sine */
        const gr = ridged((x + ph) * 1.0, p.t * 0.42 + p.id, { octaves: 4, freq: 7, period: 7, gain: 0.48, sharp: 2.4, seed: 499 });
        const split = 1 - smoothstep(0.0, 0.035,
          Math.abs(p.t - (0.2 + p.id * 0.6)) + vnoise(x * 8, y * 8, 8, 503) * 0.06);
        const seam = 1 - smoothstep(0.0, 0.06, p.edge);
        return clamp01(0.40 + gr * 0.52 - split * 0.45 - seam * 0.60);
      }),
      B(1, 0.22, (x, y) => vfbm(x * 1.0, y * 0.18, { octaves: 3, freq: 80, gain: 0.62, seed: 509 })),
    ],
    mask: { div: 4, fn: (x, y) => partition1(y, 6, 487, 0.5).id },
    albedo: (h, x, y, s) => {
      /* silvered grey with warm brown surviving only deep in the checks */
      let c = mix3([132, 126, 116], [166, 160, 148], s.m);
      c = mix3(c, [86, 68, 50], clamp01((0.34 - s.b1) * 2.6) * 0.72);
      const t = 0.62 + h * 0.50 + speckle(x, y, 170, 521) * 0.11;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.80, cavityCol: [38, 32, 26], edge: 0.62, edgeCol: [206, 200, 186], cavRough: 0.06, edgeRough: -0.06 },
  },

  /**
   * Painted board — the paint has chalked and is flaking off convex edges and
   * high grain, exposing bare grey timber underneath. Classic western storefront.
   */
  wood_painted: {
    rough: [0.34, 0.86], disp: 0.7,
    bands: [
      B(16, 0.34, (x, y) => {
        const p = partition1(y, 6, 523, 0.4);
        return clamp01(0.36 + p.id * 0.4 + fbm(x * 0.3, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 541 }) * 0.3);
      }),
      B(4, 0.44, (x, y) => {
        const p = partition1(y, 6, 523, 0.4);
        const gr = ridged((x + p.id * 4.1) * 1.0, p.t * 0.4, { octaves: 3, freq: 6, period: 6, gain: 0.5, sharp: 1.6, seed: 547 });
        const seam = 1 - smoothstep(0.0, 0.06, p.edge);
        return clamp01(0.46 + gr * 0.40 - seam * 0.58);
      }),
      B(1, 0.22, (x, y) => vfbm(x, y * 0.25, { octaves: 3, freq: 72, gain: 0.6, seed: 557 })),
    ],
    mask: { div: 4, fn: (x, y) => {
      /* paint film: torn, eroded islands — not an fBm threshold blob */
      const p = [0, 0]; warp(x, y, 6, 0.06, 563, p);
      const a = vfbm(p[0], p[1], { octaves: 3, freq: 5, gain: 0.62, seed: 569 });
      const b = vfbm(x, y, { octaves: 2, freq: 19, gain: 0.55, seed: 571 });
      return clamp01((a - 0.40) * 3.6 - (b - 0.5) * 1.1);
    } },
    albedo: (h, x, y, s) => {
      const paint = smoothstep(0.18, 0.62, s.m);
      const bare = mix3([120, 108, 92], [152, 140, 120], s.b1);
      /* oxide red, chalked toward pink where the sun has been on it longest */
      const col = mix3([146, 52, 40], [178, 104, 88], clamp01((s.b0 - 0.4) * 1.6));
      const c = mix3(bare, col, paint);
      const t = 0.66 + h * 0.42;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.56, cavityCol: [40, 32, 26], edge: 0.68, edgeCol: [188, 178, 160], cavRough: 0.08, edgeRough: 0.18 },
  },

  /* ============================================================== MASONRY = */

  plaster: {
    rough: [0.70, 0.94], disp: 0.5,
    bands: [
      B(16, 0.42, (x, y) => fbm(x, y, { octaves: 4, freq: 3, period: 3, gain: 0.6, seed: 577 })),
      B(4, 0.34, (x, y) => {
        /* trowel sweeps + blown render revealing the scratch coat */
        const sweep = ridged(x * 0.6, y * 1.0, { octaves: 3, freq: 5, period: 5, gain: 0.5, sharp: 1.2, seed: 587 });
        const blow = spots(x, y, 7, 593, 0.62, 0.24);
        return clamp01(0.42 + sweep * 0.34 - blow * 0.44 + vfbm(x, y, { octaves: 2, freq: 16, seed: 599 }) * 0.24);
      }),
      B(1, 0.24, (x, y) => vfbm(x, y, { octaves: 3, freq: 76, gain: 0.6, seed: 601 })),
    ],
    mask: { div: 4, fn: (x, y) => spots(x, y, 7, 593, 0.62, 0.24) },
    albedo: (h, x, y, s) => {
      let c = [206, 194, 170];
      c = mix3(c, [154, 124, 96], clamp01(s.m) * 0.8);     // exposed brown coat
      const t = 0.72 + h * 0.36 + speckle(x, y, 175, 607) * 0.08;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.68, cavityCol: [66, 56, 44], edge: 0.50, edgeCol: [236, 228, 210], cavRough: 0.06 },
  },

  /**
   * REGRESSION FIX. town_street: "the 'brick' pattern is uniformly lit and
   * visibly repeats" / "town walls read as a repeating blob pattern".
   *
   * The old adobe was `fbm + worley(9 cells)` — a 9x9 lattice of soft blobs,
   * which is precisely the repeating blob pattern in the Sheriff shot. Real
   * adobe is coursed mud brick under a lime render: the render survives in
   * torn patches, the exposed brick shows straw inclusions and jittered
   * courses, and the base is eroded by rain splash.
   */
  adobe: {
    rough: [0.78, 0.97], disp: 1.05,
    bands: [
      B(16, 0.36, (x, y) => {
        const p = [0, 0]; warp(x, y, 2, 0.1, 613, p);
        return fbm(p[0], p[1], { octaves: 4, freq: 3, period: 3, gain: 0.62, seed: 617 });
      }),
      B(4, 0.42, (x, y) => {
        /* coursed brick, jittered rows and per-row running bond offsets */
        const row = partition1(y, 11, 619, 0.34);
        const off = hash1(row.index, 631) * 0.9;
        const col = partition1(x * 1.0 + off, 5, 641 + row.index * 13, 0.42);
        /* fixed-WIDTH joints: using the normalised cell coordinate makes bed
           joints thinner than head joints and the wall reads as dashes */
        const joint = Math.max(1 - smoothstep(0.0, 0.010, row.dist),
          1 - smoothstep(0.0, 0.009, col.dist));
        const face = 0.5 + col.id * 0.3 + row.id * 0.2;
        const slump = vfbm(x, y, { octaves: 3, freq: 13, gain: 0.6, seed: 643 });
        return clamp01(face * 0.66 + slump * 0.34 - joint * 0.42);
      }),
      /* straw inclusions: short anisotropic strokes at random angles */
      B(1, 0.20, (x, y) => {
        const s1 = vfbm(x * 1.0 + y * 0.35, y * 0.10, { octaves: 2, freq: 72, gain: 0.52, seed: 647 });
        const s2 = vfbm(x * 0.10, y * 1.0 - x * 0.4, { octaves: 2, freq: 68, gain: 0.52, seed: 653 });
        const grit = vfbm(x, y, { octaves: 2, freq: 88, gain: 0.5, seed: 657 });
        return clamp01(Math.max(s1, s2) * 0.62 + grit * 0.38);
      }),
    ],
    mask: { div: 4, fn: (x, y) => {
      /* surviving lime render — torn islands with eroded, ragged edges */
      const p = [0, 0]; warp(x, y, 7, 0.09, 659, p);
      const a = vfbm(p[0], p[1], { octaves: 3, freq: 7, gain: 0.64, seed: 661 });
      const b = vfbm(x, y, { octaves: 3, freq: 26, gain: 0.55, seed: 673 });
      const base = smoothstep(0.0, 0.34, y);      // rain-splash erosion at the foot
      return clamp01(((a - 0.46) * 4.4 - (b - 0.5) * 2.0) * base);
    } },
    albedo: (h, x, y, s) => {
      const mud = mix3([168, 128, 92], [190, 154, 112], s.b1);
      const render = mix3([206, 188, 158], [220, 206, 178], s.b0);
      const c = mix3(mud, render, smoothstep(0.15, 0.7, s.m));
      /* straw shows as pale gold flecks in the exposed mud */
      const straw = clamp01((s.b2 - 0.66) * 3.0) * (1 - smoothstep(0.3, 0.7, s.m));
      const d = mix3(c, [204, 176, 116], straw * 0.5);
      const t = 0.66 + h * 0.44;
      return [d[0] * t, d[1] * t, d[2] * t];
    },
    wear: { cavity: 0.58, cavityCol: [86, 72, 54], edge: 0.50, edgeCol: [226, 212, 186], cavRough: 0.05 },
  },

  brick: {
    rough: [0.66, 0.94], disp: 1.15,
    bands: [
      B(16, 0.30, (x, y) => fbm(x, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 677 })),
      B(4, 0.48, (x, y) => {
        const row = partition1(y, 14, 683, 0.22);
        const off = (row.index % 2) * 0.5 + hash1(row.index, 691) * 0.16;
        const col = partition1(x + off, 7, 701, 0.24);
        const joint = Math.max(1 - smoothstep(0.0, 0.0085, row.dist), 1 - smoothstep(0.0, 0.008, col.dist));
        /* each brick is slightly cupped and pitted, none identical */
        const cup = 1 - Math.pow(Math.abs(col.t * 2 - 1), 2.2) * 0.35 - Math.pow(Math.abs(row.t * 2 - 1), 2.2) * 0.25;
        const pit = spots(x, y, 46, 709, 0.5, 0.30);
        return clamp01((0.58 + col.id * 0.22 + row.id * 0.10) * cup - joint * 0.50 - pit * 0.16);
      }),
      B(1, 0.22, (x, y) => vfbm(x, y, { octaves: 3, freq: 78, gain: 0.6, seed: 719 })),
    ],
    mask: { div: 4, fn: (x, y) => {
      const row = partition1(y, 14, 683, 0.22);
      const off = (row.index % 2) * 0.5 + hash1(row.index, 691) * 0.16;
      const col = partition1(x + off, 7, 701, 0.24);
      /* per-brick id, plus the mortar flag in the top bit of the range */
      const joint = Math.max(1 - smoothstep(0.0, 0.0085, row.dist), 1 - smoothstep(0.0, 0.008, col.dist));
      return joint > 0.5 ? -1 : hash1(col.index * 31 + row.index, 727);
    } },
    albedo: (h, x, y, s) => {
      if (s.m < 0) {
        /* lime mortar: pale, rough, slightly greenish where damp */
        const t = 0.62 + h * 0.34;
        return [150 * t, 144 * t, 130 * t];
      }
      /* fired brick from pale salmon through oxide to burnt purple, held to
         the §5 palette: desaturated and dusty, never fire-engine red */
      const k = s.m;
      let c = k < 0.5
        ? mix3([176, 128, 102], [150, 98, 78], k * 2)
        : mix3([150, 98, 78], [116, 82, 76], (k - 0.5) * 2);
      c = mix3(c, [196, 176, 150], clamp01((s.b0 - 0.6) * 2.0) * 0.24);   // efflorescence
      const t = 0.66 + h * 0.46 + speckle(x, y, 165, 733) * 0.10;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.60, cavityCol: [78, 68, 56], edge: 0.50, edgeCol: [214, 198, 176], cavRough: 0.07 },
  },

  /**
   * Rubble-coursed ashlar. Blocks of genuinely different sizes (the row pitch
   * is jittered and each row is split independently), chamfered arrises, chisel
   * tooling on the faces, lichen and dirt in the joints.
   */
  stone_block: {
    rough: [0.64, 0.93], disp: 1.35,
    bands: [
      B(16, 0.30, (x, y) => fbm(x, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 739 })),
      B(4, 0.48, (x0, y0) => {
        /* warp the coursing so the joints wander: dead-straight lines are the
           first thing that says "this is a lattice function, not masonry" */
        const q = [0, 0]; warp(x0, y0, 6, 0.020, 741, q);
        const x = q[0], y = q[1];
        const row = partition1(y, 7, 743, 0.52);
        const off = hash1(row.index, 751);
        /* course height AND block count both vary, so no two rows scan alike */
        const col = partition1(x + off, 3 + (row.index % 4), 757 + row.index * 7, 0.62);
        const joint = Math.max(1 - smoothstep(0.0, 0.013, row.dist), 1 - smoothstep(0.0, 0.012, col.dist));
        const cham = smoothstep(0.0, 0.022, row.dist) * smoothstep(0.0, 0.020, col.dist);
        const tool = ridged(x * 3.0 + col.id * 5.0, y * 9.0, { octaves: 2, freq: 10, period: 10, gain: 0.5, sharp: 1.4, seed: 761 });
        const face = vfbm(x * 1.0 + col.id * 4.0, y, { octaves: 3, freq: 16, gain: 0.6, seed: 763 });
        /* each block set proud or recessed by up to 25% — a course of stones
           dressed to a dead-flat plane is a concrete panel, not rubble */
        const proud = 0.30 + hash1(col.index * 53 + row.index, 767) * 0.55;
        return clamp01(proud * cham + (0.20 + col.id * 0.16) * cham + tool * 0.18 + face * 0.18 - joint * 0.72);
      }),
      B(1, 0.22, (x, y) => vfbm(x, y, { octaves: 3, freq: 74, gain: 0.64, seed: 769 })),
    ],
    mask: { div: 4, fn: (x0, y0) => {
      const q = [0, 0]; warp(x0, y0, 6, 0.020, 741, q);
      const x = q[0], y = q[1];
      const row = partition1(y, 7, 743, 0.52);
      const off = hash1(row.index, 751);
      const col = partition1(x + off, 3 + (row.index % 4), 757 + row.index * 7, 0.62);
      const joint = Math.max(1 - smoothstep(0.0, 0.013, row.dist), 1 - smoothstep(0.0, 0.012, col.dist));
      return joint > 0.5 ? -1 : hash1(col.index * 53 + row.index, 787);
    } },
    albedo: (h, x, y, s) => {
      if (s.m < 0) {
        /* lime mortar, struck flush and dirty */
        const t = 0.56 + h * 0.34;
        return [134 * t, 126 * t, 110 * t];
      }
      /* rubble sandstone: warm buff through ochre to a cool grey block or two */
      const k = s.m;
      const c = k < 0.62
        ? mix3([186, 166, 132], [162, 134, 100], k / 0.62)
        : mix3([162, 134, 100], [134, 130, 122], (k - 0.62) / 0.38);
      const t = 0.62 + h * 0.50 + speckle(x, y, 160, 797) * 0.13;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.70, cavityCol: [64, 58, 46], edge: 0.56, edgeCol: [216, 206, 186], cavRough: 0.07 },
  },

  /** Split cedar shingles — every course a different length, tone and curl. */
  shingle: {
    rough: [0.68, 0.95], disp: 0.9,
    bands: [
      B(16, 0.30, (x, y) => fbm(x, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 809 })),
      B(4, 0.48, (x, y) => {
        const row = partition1(y, 13, 811, 0.30);
        const off = hash1(row.index, 821);
        const col = partition1(x + off, 9, 823 + row.index * 3, 0.46);
        /* the butt end sits proud, the head is buried under the course above */
        const lay = smoothstep(0.0, 0.55, row.t);
        const gap = 1 - smoothstep(0.0, 0.035, col.edge);
        const curl = Math.pow(row.t, 1.6) * (0.4 + col.id * 0.6);
        const grain = ridged(x * 4.0 + col.id * 5.0, y * 0.6, { octaves: 2, freq: 9, period: 9, gain: 0.5, sharp: 1.6, seed: 827 });
        return clamp01(0.22 + lay * 0.34 + curl * 0.28 + grain * 0.20 - gap * 0.55);
      }),
      B(1, 0.22, (x, y) => vfbm(x * 1.0, y * 0.35, { octaves: 3, freq: 76, gain: 0.6, seed: 829 })),
    ],
    mask: { div: 4, fn: (x, y) => {
      const row = partition1(y, 13, 811, 0.30);
      const off = hash1(row.index, 821);
      return partition1(x + off, 9, 823 + row.index * 3, 0.46).id;
    } },
    albedo: (h, x, y, s) => {
      /* weathered cedar: silver-grey, mossy green in the laps */
      let c = mix3([96, 88, 78], [138, 128, 114], s.m);
      c = mix3(c, MOSS, clamp01((0.34 - s.b1) * 2.4) * 0.4);
      const t = 0.58 + h * 0.56 + speckle(x, y, 170, 839) * 0.10;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.80, cavityCol: [34, 32, 26], edge: 0.58, edgeCol: [190, 186, 174], cavRough: 0.06 },
  },

  cobble: {
    rough: [0.62, 0.92], disp: 1.05,
    bands: [
      B(16, 0.28, (x, y) => fbm(x, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 853 })),
      B(4, 0.50, (x, y) => {
        const p = [0, 0]; warp(x, y, 4, 0.035, 857, p);
        const w = worley(p[0], p[1], 11, 859);
        const dome = Math.pow(smoothstep(0.0, 0.75, w.f2 - w.f1), 0.55);
        return clamp01(dome * (0.62 + w.id * 0.38) + vfbm(x, y, { octaves: 2, freq: 26, seed: 863 }) * 0.16);
      }),
      B(1, 0.22, (x, y) => vfbm(x, y, { octaves: 3, freq: 72, gain: 0.6, seed: 877 })),
    ],
    mask: { div: 4, fn: (x, y) => {
      const p = [0, 0]; warp(x, y, 4, 0.035, 857, p);
      return worley(p[0], p[1], 11, 859).id;
    } },
    albedo: (h, x, y, s) => {
      const c = mix3([112, 106, 96], [148, 138, 122], s.m);
      const t = 0.56 + h * 0.58 + speckle(x, y, 155, 881) * 0.14;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.84, cavityCol: [40, 34, 27], edge: 0.56, edgeCol: [186, 178, 162], cavRough: 0.04, edgeRough: -0.14 },
  },

  /* =============================================================== METAL == */

  /**
   * Corrugated iron. Pass 2 used sin(x*32pi) — a perfect 16-cycle comb that
   * aliases hard. The profile now has a jittered pitch, dents, and rust that
   * blooms from the fixing line and runs down.
   */
  corrugated_iron: {
    rough: [0.36, 0.90], metal: 0.85, disp: 0.75,
    bands: [
      B(16, 0.34, (x, y) => 0.4 + fbm(x, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 883 }) * 0.5),
      B(4, 0.46, (x, y) => {
        /* 12 flutes, pitch jittered per sheet, plus panel-end dents */
        const p = partition1(x, 12, 887, 0.16);
        const flute = 0.5 - 0.5 * Math.cos(p.t * Math.PI * 2);
        const dent = spots(x, y, 6, 991, 0.6, 0.22);
        return clamp01(flute * 0.86 - dent * 0.24 + vfbm(x, y, { octaves: 2, freq: 20, seed: 907 }) * 0.14);
      }),
      B(1, 0.20, (x, y) => vfbm(x, y, { octaves: 2, freq: 70, gain: 0.55, seed: 911 })),
    ],
    mask: { div: 4, fn: (x, y) => {
      /* rust: seeded on the fixing rows, bleeding downward */
      const seedRow = 1 - smoothstep(0.0, 0.055, partition1(y, 4, 919, 0.3).edge);
      const bleed = vfbm(x * 3.0, y * 0.35, { octaves: 3, freq: 9, gain: 0.6, seed: 929 });
      const patch = vfbm(x, y, { octaves: 3, freq: 5, gain: 0.62, seed: 937 });
      return clamp01(seedRow * 0.7 + (patch - 0.44) * 2.4 * bleed);
    } },
    albedo: (h, x, y, s) => {
      const rust = clamp01(s.m);
      const zinc = mix3([132, 136, 138], [166, 168, 168], h);
      const ox = mix3([128, 74, 44], [92, 52, 34], vnoise(x * 40, y * 40, 40, 941));
      const c = mix3(zinc, ox, smoothstep(0.15, 0.75, rust));
      const t = 0.66 + h * 0.4;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    /* the metalness must fall where the rust is — handled via `metalMask` */
    metalMask: (s) => 1 - smoothstep(0.15, 0.7, clamp01(s.m)) * 0.92,
    wear: { cavity: 0.62, cavityCol: [44, 34, 26], edge: 0.50, edgeCol: [186, 188, 188], cavRough: 0.10, edgeRough: -0.22 },
  },

  metal_rusted: {
    rough: [0.52, 0.97], metal: 0.7, disp: 0.7,
    bands: [
      B(16, 0.36, (x, y) => fbm(x, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 947 })),
      B(4, 0.42, (x, y) => {
        const scale = worley(x, y, 18, 953);
        const flake = smoothstep(0.05, 0.6, scale.f2 - scale.f1) * (0.4 + scale.id * 0.6);
        const pit = spots(x, y, 34, 967, 0.55, 0.4);
        return clamp01(0.36 + flake * 0.5 - pit * 0.34 + vfbm(x, y, { octaves: 2, freq: 22, seed: 971 }) * 0.2);
      }),
      B(1, 0.22, (x, y) => vfbm(x, y, { octaves: 3, freq: 78, gain: 0.6, seed: 977 })),
    ],
    mask: { div: 4, fn: (x, y) => vfbm(x, y, { octaves: 3, freq: 6, gain: 0.62, seed: 983 }) },
    albedo: (h, x, y, s) => {
      const c = mix3([146, 86, 46], [96, 56, 40], s.m);
      const t = 0.54 + h * 0.6 + speckle(x, y, 150, 991) * 0.14;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    metalMask: (s) => 0.28 + 0.5 * clamp01(1 - s.cav * 2),
    wear: { cavity: 0.72, cavityCol: [40, 26, 18], edge: 0.44, edgeCol: [178, 138, 104], cavRough: 0.08, edgeRough: -0.20 },
  },

  metal_worn: {
    rough: [0.18, 0.62], metal: 1.0, disp: 0.35,
    bands: [
      B(16, 0.38, (x, y) => fbm(x, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 997 })),
      B(4, 0.34, (x, y) => {
        /* directional buffing scratches + a few deep gouges */
        const buff = vfbm(x * 1.0, y * 0.05, { octaves: 3, freq: 30, gain: 0.6, seed: 1009 });
        /* sparse directional scratches, not iso-contours of a noise field */
        const sc = ridged(x * 1.0, y * 0.07, { octaves: 2, freq: 15, period: 15, gain: 0.5, sharp: 7.0, seed: 1013 });
        return clamp01(0.52 + buff * 0.40 - smoothstep(0.70, 0.96, sc) * 0.34);
      }),
      B(1, 0.28, (x, y) => vfbm(x * 1.0, y * 0.08, { octaves: 2, freq: 96, gain: 0.55, seed: 1019 })),
    ],
    albedo: (h) => [122 * h + 84, 122 * h + 84, 126 * h + 86],
    wear: { cavity: 0.40, cavityCol: [52, 50, 48], edge: 0.44, edgeCol: [214, 214, 218], cavRough: 0.12, edgeRough: -0.14 },
  },

  /* ============================================================== FABRIC == */

  canvas_tent: {
    rough: [0.76, 0.96], disp: 0.55,
    bands: [
      B(16, 0.34, (x, y) => fbm(x, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 1021 })),
      B(4, 0.40, (x, y) => {
        /* seams and the slack between them */
        const seam = 1 - smoothstep(0.0, 0.02, partition1(x, 4, 1031, 0.2).edge);
        const sag = vfbm(x, y, { octaves: 3, freq: 10, gain: 0.6, seed: 1033 });
        return clamp01(0.42 + sag * 0.5 - seam * 0.35);
      }),
      /* the actual weave — 44 picks, safely above the 3-texel Nyquist floor */
      B(1, 0.26, (x, y) => {
        const wu = 0.5 + 0.5 * Math.cos(x * Math.PI * 2 * 44);
        const wv = 0.5 + 0.5 * Math.cos(y * Math.PI * 2 * 44);
        const slub = vfbm(x, y, { octaves: 2, freq: 60, gain: 0.55, seed: 1039 });
        return clamp01(Math.max(wu, wv) * 0.62 + slub * 0.38);
      }),
    ],
    mask: { div: 4, fn: (x, y) => vfbm(x, y, { octaves: 3, freq: 5, gain: 0.62, seed: 1049 }) },
    albedo: (h, x, y, s) => {
      /* undyed duck canvas, water-stained and mildewed at the folds */
      let c = mix3([196, 184, 156], [172, 162, 138], s.m);
      c = mix3(c, [128, 122, 96], clamp01((s.m - 0.62) * 3.0) * 0.6);
      const t = 0.74 + h * 0.34;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.60, cavityCol: [86, 78, 60], edge: 0.42, edgeCol: [232, 224, 204], cavRough: 0.04 },
  },

  fabric_wool: {
    rough: [0.80, 0.99], disp: 0.5,
    bands: [
      B(16, 0.32, (x, y) => fbm(x, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 1051 })),
      B(4, 0.38, (x, y) => {
        const stripe = 1 - smoothstep(0.0, 0.06, partition1(y, 6, 1061, 0.1).edge);
        return clamp01(0.5 + vfbm(x, y, { octaves: 3, freq: 14, gain: 0.6, seed: 1063 }) * 0.4 - stripe * 0.12);
      }),
      B(1, 0.30, (x, y) => {
        const wu = 0.5 + 0.5 * Math.cos((x + vnoise(x * 20, y * 20, 20, 1069) * 0.03) * Math.PI * 2 * 36);
        const wv = 0.5 + 0.5 * Math.cos((y + vnoise(x * 20, y * 20, 20, 1087) * 0.03) * Math.PI * 2 * 36);
        return clamp01(Math.max(wu, wv) * 0.55 + vfbm(x, y, { octaves: 2, freq: 64, seed: 1091 }) * 0.45);
      }),
    ],
    mask: { div: 4, fn: (x, y) => partition1(y, 6, 1061, 0.1).id },
    albedo: (h, x, y, s) => {
      /* trade blanket: undyed grey ground with madder and indigo bands */
      const band = s.m;
      let c = [116, 104, 92];
      if (band > 0.78) c = [128, 58, 44];
      else if (band > 0.60) c = [58, 66, 88];
      const t = 0.62 + h * 0.5;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.56, cavityCol: [42, 36, 30], edge: 0.48, edgeCol: [178, 170, 158], cavRough: 0.03 },
  },

  leather: {
    rough: [0.40, 0.82], disp: 0.6,
    bands: [
      B(16, 0.32, (x, y) => fbm(x, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 1093 })),
      B(4, 0.40, (x, y) => {
        /* creases folding across the hide + a stitched seam line */
        const crease = ridged(x * 1.4, y * 1.0, { octaves: 3, freq: 6, period: 6, gain: 0.5, sharp: 2.0, seed: 1097 });
        const stitch = (1 - smoothstep(0.0, 0.012, partition1(y, 3, 1103, 0.1).edge))
          * (Math.cos(x * Math.PI * 2 * 30) > 0.2 ? 1 : 0);
        return clamp01(0.52 - crease * 0.42 + stitch * 0.28);
      }),
      /* pebble grain — the defining micro feature of tanned hide */
      B(1, 0.28, (x, y) => {
        const w = worley(x, y, 96, 1109);
        return clamp01(1 - w.f1 * 0.85);
      }),
    ],
    mask: { div: 4, fn: (x, y) => vfbm(x, y, { octaves: 3, freq: 5, gain: 0.62, seed: 1117 }) },
    albedo: (h, x, y, s) => {
      const c = mix3([104, 68, 42], [72, 46, 30], s.m);
      const t = 0.56 + h * 0.56;
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.66, cavityCol: [30, 20, 13], edge: 0.62, edgeCol: [162, 126, 88], cavRough: 0.06, edgeRough: -0.18 },
  },

  hay: {
    rough: [0.78, 0.98], disp: 0.85,
    bands: [
      B(16, 0.30, (x, y) => fbm(x * 2.0, y * 0.4, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 1123 })),
      B(4, 0.42, (x, y) => {
        /* individual straws: long thin strokes at two dominant angles */
        const a = vfbm(x * 1.0 + y * 0.22, y * 0.10, { octaves: 3, freq: 22, gain: 0.6, seed: 1129 });
        const b = vfbm(x * 0.10, y * 1.0 - x * 0.30, { octaves: 3, freq: 19, gain: 0.6, seed: 1151 });
        return clamp01(Math.max(a, b) * 0.9 + 0.05);
      }),
      B(1, 0.28, (x, y) => {
        const a = vfbm(x * 1.0 + y * 0.3, y * 0.07, { octaves: 2, freq: 70, gain: 0.55, seed: 1153 });
        const b = vfbm(x * 0.07, y * 1.0 - x * 0.35, { octaves: 2, freq: 66, gain: 0.55, seed: 1163 });
        return clamp01(Math.max(a, b));
      }),
    ],
    albedo: (h, x, y) => {
      const t = 0.52 + h * 0.68;
      const g = grain(x, y, 120, 1171);
      const c = mix3([186, 154, 88], [206, 182, 122], g);
      return [c[0] * t, c[1] * t, c[2] * t];
    },
    wear: { cavity: 0.72, cavityCol: [56, 44, 26], edge: 0.50, edgeCol: [230, 214, 168], cavRough: 0.05 },
  },

  glass_dirty: {
    rough: [0.05, 0.46], disp: 0.2,
    bands: [
      B(16, 0.42, (x, y) => fbm(x, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 1181 })),
      B(4, 0.34, (x, y) => {
        /* rain runnels and a dusty tide line at the bottom of the pane */
        const run = vfbm(x * 4.0, y * 0.2, { octaves: 3, freq: 12, gain: 0.6, seed: 1187 });
        return clamp01(0.5 + run * 0.4 + smoothstep(0.25, 0.0, y) * 0.2);
      }),
      B(1, 0.24, (x, y) => vfbm(x, y, { octaves: 2, freq: 66, gain: 0.55, seed: 1193 })),
    ],
    albedo: (h) => [124 + 44 * h, 134 + 42 * h, 140 + 38 * h],
    wear: { cavity: 0.34, cavityCol: [96, 94, 86], edge: 0.20, edgeCol: [190, 198, 204], cavRough: 0.34 },
  },

  paper_poster: {
    rough: [0.72, 0.94], disp: 0.3,
    bands: [
      B(16, 0.40, (x, y) => fbm(x, y, { octaves: 3, freq: 3, period: 3, gain: 0.6, seed: 1201 })),
      B(4, 0.36, (x, y) => {
        /* torn edges and a crease down the middle where it was folded */
        const fold = 1 - smoothstep(0.0, 0.02, Math.abs(y - 0.5));
        return clamp01(0.55 + vfbm(x, y, { octaves: 3, freq: 12, gain: 0.6, seed: 1213 }) * 0.4 - fold * 0.3);
      }),
      B(1, 0.24, (x, y) => vfbm(x, y, { octaves: 3, freq: 70, gain: 0.6, seed: 1217 })),
    ],
    albedo: (h) => [200 * h + 50, 188 * h + 46, 158 * h + 38],
    wear: { cavity: 0.52, cavityCol: [104, 92, 70], edge: 0.44, edgeCol: [238, 232, 214], cavRough: 0.04 },
  },
};

export const RECIPE_NAMES = Object.keys(RECIPES);
