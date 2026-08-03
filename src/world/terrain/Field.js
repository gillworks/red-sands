import {
  noise2, fbm, fbm01, ridged, billow, smoothstep, clamp, mix, terrace,
  polylineDist, polylineMetrics,
} from './Noise.js';

/**
 * Landform synthesis.
 *
 * The world is deliberately *composed*, not left to noise:
 *
 *      N (-Z)
 *        ┌──────────────────────────────┐
 *        │  timber   ▲▲▲ MASSIF ▲▲▲     │   high mesa/butte country east,
 *        │  foothills   ▲▲▲▲▲▲          │   grassland and the river basin
 *        │      ~~~ river ~~~   ▄▄ mesa │   through the middle and west,
 *   W    │  ROLLING GRASSLAND   ▄▄▄▄▄   │   dry flats to the south.
 *        │      ~~~        dry flat ▄▄  │
 *        │  low basin      ░░░░░░░      │
 *        └──────────────────────────────┘
 *
 * Region boundaries are domain-warped so nothing reads as an authored blob, and
 * the river's long profile is derived from the terrain it actually crosses
 * (sampled, then forced monotonically downhill) so the valley always drains.
 */

export const RIVER_PTS = [
  [1980, -2760], [1560, -2150], [1120, -1620], [700, -1130],
  [250, -760], [-260, -470], [-800, -230], [-1420, 60],
  [-2100, 470], [-2900, 1030], [-3800, 1780], [-5200, 2900],
];
const RIVER_M = polylineMetrics(RIVER_PTS);

/* ------------------------------------------------------------------ regions */

function ellipse(x, z, cx, cz, rx, rz, rot) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const dx = x - cx, dz = z - cz;
  const u = (dx * c + dz * s) / rx;
  const v = (-dx * s + dz * c) / rz;
  return Math.sqrt(u * u + v * v);
}

/**
 * Continuous region weights at a world position.
 * @returns {{mount:number, foot:number, bad:number, plain:number, sand:number,
 *            far:number, valley:number, core:number, arid:number,
 *            valleyD:number, valleyT:number}}
 */
export function regionAt(x, z) {
  const wx = x + fbm(x * 0.00019 + 11.3, z * 0.00019 - 4.7, 3, 1) * 820;
  const wz = z + fbm(x * 0.00019 - 6.1, z * 0.00019 + 9.9, 3, 1) * 820;

  /* --- the massif: three overlapping uplifts in the north-east */
  const eA = ellipse(wx, wz, 2150, -2800, 2050, 1500, -0.50);
  const eB = ellipse(wx, wz, 3450, -1550, 1350, 1050, 0.28);
  const eC = ellipse(wx, wz, 250, -3350, 1550, 1000, 0.22);
  const uplift = Math.min(eA, Math.min(eB, eC));
  let mount = smoothstep(1.08, 0.40, uplift);
  let foot = smoothstep(1.82, 1.02, uplift) * (1 - mount);

  /* --- badlands: arid terraced basin east, with an outlying butte field that
         reads against the massif from the western grasslands */
  const eD = ellipse(wx, wz, 2700, 1450, 1700, 1350, 0.20);
  const eE = ellipse(wx, wz, 3600, 2900, 1250, 1000, -0.35);
  const eG = ellipse(wx, wz, 2350, -560, 1180, 900, -0.28);
  const eH = ellipse(wx, wz, 1880, 830, 800, 660, 0.55);
  const badRaw = Math.min(Math.min(eD, eH), Math.min(eE, eG));
  let bad = smoothstep(1.22, 0.46, badRaw) * (1 - mount) * (1 - foot * 0.7);

  /* --- dry flats: the wash west of the badlands and the southern pan */
  const eF = ellipse(wx, wz, 1300, 900, 1150, 950, 0.1);
  let sand = smoothstep(1.25, 0.55, eF) * (1 - bad * 0.55);
  sand = Math.max(sand, smoothstep(2100, 3400, wz) * (1 - mount) * (1 - bad * 0.5));
  sand *= (1 - mount) * (1 - foot);

  /* --- distant ranges beyond the play area, so the horizon is never empty */
  const edge = Math.max(Math.abs(x), Math.abs(z));
  const far = smoothstep(3900, 7600, edge);

  let plain = clamp(1 - mount - foot - bad - sand, 0, 1);
  const sum = mount + foot + bad + sand + plain || 1;
  mount /= sum; foot /= sum; bad /= sum; sand /= sum; plain /= sum;

  const rv = polylineDist(x, z, RIVER_PTS, RIVER_M.cum, RIVER_M.total);
  const vW = mix(150, 420, Math.pow(rv.t, 0.6));
  const valley = smoothstep(vW * 1.9, vW * 0.50, rv.d);
  const core = smoothstep(vW * 1.00, vW * 0.26, rv.d);

  const aridN = fbm01(x * 0.00032 + 71.2, z * 0.00032 - 33.8, 3, 1);
  const arid = clamp(
    bad * 0.96 + sand * 1.0 + plain * 0.30 + foot * 0.12 + mount * 0.30
    + (aridN - 0.5) * 0.40 - valley * 0.34,
    0, 1);

  return { mount, foot, bad, plain, sand, far, valley, core, arid, valleyD: rv.d, valleyT: rv.t };
}

/* ------------------------------------------------------------------- heights */

function landformAt(x, z, R) {
  /* second, independent warp for the landform itself */
  const wax = x + fbm(x * 0.00040 + 3.1, z * 0.00040 + 8.4, 4, 1) * 620;
  const waz = z + fbm(x * 0.00040 - 5.6, z * 0.00040 - 2.2, 4, 1) * 620;

  let H = 0;

  if (R.mount > 0.003) {
    const r1 = ridged(wax, waz, 6, 1 / 4100, 0.5, 2.11, 0.95);
    const r2 = ridged(wax * 1.9 + 1200, waz * 1.9 - 800, 4, 1 / 4100);
    const m = Math.pow(clamp(r1 * 0.79 + r2 * 0.21, 0, 1), 1.30);
    H += R.mount * (55 + m * 660);
  }
  if (R.foot > 0.003) {
    const b = billow(wax, waz, 5, 1 / 2400);
    const r = ridged(wax, waz, 4, 1 / 2900);
    H += R.foot * (34 + b * 128 + r * 92);
  }
  if (R.plain > 0.003) {
    const b = billow(wax * 0.85, waz * 0.85, 4, 1 / 3100);
    const s = fbm(x, z, 3, 1 / 4800);
    const lr = ridged(wax * 1.4 - 900, waz * 1.4 + 400, 4, 1 / 1900, 0.5, 2.05);
    H += R.plain * (44 + b * 46 + s * 24 + lr * 34);
  }
  if (R.bad > 0.003) {
    /* Broad plateau mass only. The terracing that turns this into mesas is
       done in refineCore, where it can be applied to the FINAL height and the
       caprock hardness can be aligned with the riser it actually created. */
    const base = fbm01(wax * 1.05, waz * 1.05, 5, 1 / 2300);
    H += R.bad * (26 + Math.pow(base, 1.15) * 430);
  }
  if (R.sand > 0.003) {
    H += R.sand * (20 + billow(wax * 0.85, waz * 1.45, 3, 1 / 2000) * 22);
  }
  if (R.far > 0.002) {
    /* big soft ranges ringing the world — pure silhouette material */
    const f = ridged(wax * 0.62 - 4000, waz * 0.62 + 2500, 5, 1 / 5200, 0.52, 2.05);
    H = mix(H, 30 + Math.pow(f, 1.25) * 520, R.far * 0.92);
  }

  /* Broad structural basin around the drainage axis. Only ~0.5% cross-slope,
     invisible to the eye, but it is what makes the whole region drain into one
     trunk river instead of a hundred disconnected pans. */
  H -= smoothstep(3400, 260, R.valleyD) * 16;

  /* regional tilt: the whole basin drains west-south-west */
  H += x * 0.0032 - z * 0.0026;
  return H;
}

/* ---------------------------------------------------------------- pass one */

/**
 * Coarse landform over `ext` metres at `res`, in two sweeps: the land first,
 * then the river valley cut into it along a profile derived from that land.
 */
export function generateCoarse(res, ext) {
  const N = res * res;
  const h = new Float32Array(N);
  const wMount = new Float32Array(N);
  const wFoot = new Float32Array(N);
  const wBad = new Float32Array(N);
  const wPlain = new Float32Array(N);
  const wSand = new Float32Array(N);
  const wValley = new Float32Array(N);
  const arid = new Float32Array(N);
  const vT = new Float32Array(N);
  const vCore = new Float32Array(N);

  const step = ext / res;
  const half = ext * 0.5;

  for (let j = 0; j < res; j++) {
    const z = -half + (j + 0.5) * step;
    for (let i = 0; i < res; i++) {
      const x = -half + (i + 0.5) * step;
      const k = j * res + i;
      const R = regionAt(x, z);
      h[k] = landformAt(x, z, R);
      wMount[k] = R.mount; wFoot[k] = R.foot; wBad[k] = R.bad;
      wPlain[k] = R.plain; wSand[k] = R.sand;
      wValley[k] = R.valley; vCore[k] = R.core;
      vT[k] = R.valleyT;
      arid[k] = R.arid;
    }
  }

  /* --- river long profile: sample the land, then force it downhill */
  const SAMPLES = 300;
  const prof = new Float32Array(SAMPLES);
  const sampleH = (x, z) => {
    let fx = clamp((x + half) / ext * res - 0.5, 0, res - 1.001);
    let fz = clamp((z + half) / ext * res - 0.5, 0, res - 1.001);
    const x0 = fx | 0, z0 = fz | 0, tx = fx - x0, tz = fz - z0;
    const a = h[z0 * res + x0], b = h[z0 * res + x0 + 1];
    const c = h[(z0 + 1) * res + x0], d = h[(z0 + 1) * res + x0 + 1];
    const t0 = a + (b - a) * tx;
    return t0 + ((c + (d - c) * tx) - t0) * tz;
  };
  const pointAt = (t) => {
    const target = t * RIVER_M.total;
    for (let s = 0; s < RIVER_PTS.length - 1; s++) {
      const c0 = RIVER_M.cum[s], c1 = RIVER_M.cum[s + 1];
      if (target <= c1 || s === RIVER_PTS.length - 2) {
        const u = c1 > c0 ? (target - c0) / (c1 - c0) : 0;
        return [
          RIVER_PTS[s][0] + (RIVER_PTS[s + 1][0] - RIVER_PTS[s][0]) * u,
          RIVER_PTS[s][1] + (RIVER_PTS[s + 1][1] - RIVER_PTS[s][1]) * u,
        ];
      }
    }
    return RIVER_PTS[0];
  };
  const segLen = RIVER_M.total / (SAMPLES - 1);
  for (let s = 0; s < SAMPLES; s++) {
    const [px, pz] = pointAt(s / (SAMPLES - 1));
    const land = sampleH(px, pz);
    const wantDrop = segLen * 0.004;          // 0.4% minimum gradient
    prof[s] = s === 0 ? land - 11
      : Math.min(land - 11, prof[s - 1] - wantDrop);
    /* never gouge an implausible gorge across a flat */
    prof[s] = Math.max(prof[s], land - 40);
  }
  /* second monotone pass in case the clamp broke it */
  for (let s = 1; s < SAMPLES; s++) {
    if (prof[s] > prof[s - 1] - segLen * 0.0012) prof[s] = prof[s - 1] - segLen * 0.0012;
  }

  const profAt = (t) => {
    const f = clamp(t, 0, 1) * (SAMPLES - 1);
    const i0 = f | 0, i1 = Math.min(SAMPLES - 1, i0 + 1);
    return prof[i0] + (prof[i1] - prof[i0]) * (f - i0);
  };

  /* --- pass two: cut the valley */
  for (let j = 0; j < res; j++) {
    const z = -half + (j + 0.5) * step;
    for (let i = 0; i < res; i++) {
      const k = j * res + i;
      const v = wValley[k];
      if (v < 0.002) continue;
      const x = -half + (i + 0.5) * step;
      const floor = profAt(vT[k]);
      /* flanks: only ever cut down toward the floor */
      const flank = floor + Math.pow(1 - v, 1.35) * 330;
      let H = mix(h[k], Math.min(h[k], flank), v);
      /* axis: force the bed, with a little meander noise */
      const core = vCore[k];
      if (core > 0.002) {
        H = mix(H, floor + fbm(x, z, 2, 1 / 420) * 3.5, core * 0.94);
      }
      h[k] = H;
    }
  }

  return { h, wMount, wFoot, wBad, wPlain, wSand, wValley, arid, res, ext, prof };
}

/* ---------------------------------------------------------------- pass two */

function bilerpGrid(src, res, u, v) {
  const fx = clamp(u * res - 0.5, 0, res - 1.001);
  const fy = clamp(v * res - 0.5, 0, res - 1.001);
  const x0 = fx | 0, y0 = fy | 0;
  const tx = fx - x0, ty = fy - y0;
  const x1 = x0 + 1 < res ? x0 + 1 : x0;
  const y1 = y0 + 1 < res ? y0 + 1 : y0;
  const a = src[y0 * res + x0], b = src[y0 * res + x1];
  const c = src[y1 * res + x0], d = src[y1 * res + x1];
  return mix(mix(a, b, tx), mix(c, d, tx), ty);
}

/**
 * Refine the core up to `res`, adding the mid and high frequency character each
 * region deserves plus the erosion hardness field (strata + mesa caprock) that
 * the droplet pass honours.
 */
export function refineCore(coarse, res, core) {
  const N = res * res;
  const h = new Float32Array(N);
  const hard = new Float32Array(N);
  const arid = new Float32Array(N);
  const rMount = new Float32Array(N);
  const rBad = new Float32Array(N);
  const rValley = new Float32Array(N);
  const rPlain = new Float32Array(N);
  const rFoot = new Float32Array(N);
  const rSand = new Float32Array(N);

  const step = core / res;
  const half = core * 0.5;
  const u0 = 0.5 - (core * 0.5) / coarse.ext;
  const uspan = core / coarse.ext;

  for (let j = 0; j < res; j++) {
    const z = -half + (j + 0.5) * step;
    const v = u0 + ((j + 0.5) / res) * uspan;
    for (let i = 0; i < res; i++) {
      const x = -half + (i + 0.5) * step;
      const u = u0 + ((i + 0.5) / res) * uspan;
      const k = j * res + i;

      const wm = bilerpGrid(coarse.wMount, coarse.res, u, v);
      const wf = bilerpGrid(coarse.wFoot, coarse.res, u, v);
      const wb = bilerpGrid(coarse.wBad, coarse.res, u, v);
      const wp = bilerpGrid(coarse.wPlain, coarse.res, u, v);
      const ws = bilerpGrid(coarse.wSand, coarse.res, u, v);
      const wv = bilerpGrid(coarse.wValley, coarse.res, u, v);
      let H = bilerpGrid(coarse.h, coarse.res, u, v);

      const wax = x + noise2(x * 0.00090 + 17.7, z * 0.00090 - 3.3) * 200;
      const waz = z + noise2(x * 0.00090 - 8.2, z * 0.00090 + 6.5) * 200;

      let hardness = 0.40;
      const flank = 1 - wv;

      if (wm > 0.006) {
        const r = ridged(wax, waz, 5, 1 / 620, 0.52, 2.09);
        const spur = ridged(wax * 2.3, waz * 2.3, 3, 1 / 620);
        H += wm * flank * ((r - 0.42) * 190 + (spur - 0.45) * 58);
        hardness = mix(hardness, 0.34 + 0.46 * (0.5 + 0.5
          * Math.sin(H * 0.052 + fbm(x, z, 2, 1 / 700) * 3.0)), wm);
      }
      if (wf > 0.006) {
        const b = billow(wax, waz, 4, 1 / 470);
        H += wf * flank * (b - 0.46) * 82;
        hardness = mix(hardness, 0.35, wf);
      }
      if (wp > 0.006) {
        /* Three scales of swell. Without the 130 m band the grassland reads as
           a billiard table from a mile away — there is nothing for the light to
           catch once the texture detail has mipped away. */
        const b = billow(wax * 0.9, waz * 0.9, 4, 1 / 730);
        const g = fbm(x, z, 3, 1 / 230);
        const f = fbm(x + 813, z - 271, 3, 1 / 128);
        const d = fbm(x - 2011, z + 655, 3, 1 / 320);
        H += wp * flank * ((b - 0.47) * 44 + g * 13.0 + d * 9.5 + f * 6.0);
        hardness = mix(hardness, 0.22, wp);
      }
      if (ws > 0.006) {
        H += ws * flank * (fbm(x * 0.55, z * 1.5, 3, 1 / 250) * 7
          + fbm(x - 411, z + 122, 3, 1 / 115) * 3.2);
        hardness = mix(hardness, 0.20, ws);
      }
      if (wb > 0.006) {
        /* Butte country. Terrace the ACTUAL height so the risers land where
           the land already steepens, use a very long tread and a very short
           riser (that ratio is the whole difference between a mesa and a
           hill), and make the whole stack resistant so thermal erosion holds
           the face near 60 degrees instead of slumping it to an apron. */
        H += wb * flank * (fbm(wax * 1.2 + 400, waz * 1.2 - 250, 3, 1 / 620) * 26);
        /* Regional bedding offset. Without it every butte in the province puts
           its benches at exactly the same absolute elevation, and the range
           reads as a contour map rather than as separate mesas that happen to
           share a stratigraphy. +/-30 m of smooth regional dip is enough. */
        const bedOff = fbm(wax + 2600, waz - 1400, 3, 1 / 1150) * 60
          + fbm(x - 700, z + 1900, 2, 1 / 430) * 16;
        const norm = clamp((H + bedOff - 24) / 380, 0, 1);
        const t = terrace(norm, 4.5, 0.94);
        H = mix(H, 24 + t.h * 380 - bedOff, wb * 0.88);
        hardness = mix(hardness, 0.80 + (1 - t.riser) * 0.17, wb);
      }
      if (wv > 0.002) {
        H -= wv * fbm(x, z, 2, 1 / 360) * 4;
        hardness = mix(hardness, 0.18, wv * 0.85);
      }

      h[k] = H;
      hard[k] = clamp(hardness, 0.05, 1);
      arid[k] = bilerpGrid(coarse.arid, coarse.res, u, v);
      rMount[k] = wm; rBad[k] = wb; rValley[k] = wv;
      rPlain[k] = wp; rFoot[k] = wf; rSand[k] = ws;
    }
  }

  return { h, hard, arid, rMount, rBad, rValley, rPlain, rFoot, rSand, res, size: core };
}
