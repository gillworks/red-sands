import { rng } from '../../core/Context.js';

/**
 * ECOLOGY — the world's regional plan.
 * ============================================================================
 *
 * PASS 4. Three passes of per-instance probability produced a landscape that
 * every blind examiner read the same way: "props sprinkled at uniform density
 * like confetti, every rock the same size, evenly spaced, everywhere." The
 * problem was never the noise functions. It was that placement was decided
 * ONE INSTANCE AT A TIME. A field of independent Bernoulli trials has no
 * organisation at any scale larger than its correlation length, so however
 * cleverly the probability is derived it always converges to an even spray.
 *
 * What a designed landscape has instead is MASSES: a stand of timber gripping
 * one shoulder of a valley, a bare scree apron below the scarp, an open
 * meadow, and — critically — large stretches of NOTHING between them. Negative
 * space is a compositional asset; the previous passes had none anywhere.
 *
 * So this module decides the world's ecology at REGION scale first, once, and
 * everything else is a modulation inside a region:
 *
 *   1. A jittered lattice of region seeds at ~360 m. Each seed reads the
 *      terrain where it landed — altitude, slope, aspect, upstream moisture,
 *      soil — plus two very-low-frequency "macro" fields (aridity and timber
 *      belt) that give the map continent-scale character, and elects ONE zone.
 *      Winner-take-all, not a blend: a place is timber or it is scree.
 *   2. Every cell joins the nearest seed measured in a DOMAIN-WARPED space, so
 *      the boundaries are organic lobes and inlets rather than Voronoi facets.
 *   3. Terrain then overrides the vote where it has the authority to: a cliff
 *      is bare rock whatever the region says, a wash is riparian, and nothing
 *      is timber above the treeline. That is what puts HARD edges where the
 *      land justifies one — a treeline that stops at an altitude, a ridge, a
 *      river — and soft frayed edges everywhere else.
 *   4. Inside a region, a two-octave field opens clearings and closes thickets,
 *      and the distance to the region boundary fades density at the rim so a
 *      forest thins into its edge instead of ending at a fence line.
 *
 * The output is a handful of small density fields (Uint8, 512² over the whole
 * 8 km square = 16 m per cell) that Vegetation and Scatter both sample. Because
 * they share it, the trees, the undergrowth, the boulders and the loose stones
 * all agree about where a forest is — which is the other half of reading as a
 * designed place rather than four independent sprinklers.
 *
 * Cost: ~40 ms at boot, one pass, no terrain queries of its own (it is handed
 * the fields VegMaps has already derived).
 */

/* ------------------------------------------------------------------ noise */

/**
 * Perlin-ish gradient noise with a shuffled permutation table. Lives here
 * rather than in VegMaps so that VegMaps can import Ecology without a cycle.
 */
export function makeNoise(seed) {
  const r = rng(seed);
  const P = new Uint8Array(512);
  const src = new Uint8Array(256);
  for (let i = 0; i < 256; i++) src[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (r() * (i + 1)) | 0;
    const t = src[i]; src[i] = src[j]; src[j] = t;
  }
  for (let i = 0; i < 512; i++) P[i] = src[i & 255];

  const grad = (h, x, y) => {
    switch (h & 3) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      default: return -x - y;
    }
  };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

  const noise = (x, y) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    const fx = x - Math.floor(x), fy = y - Math.floor(y);
    const u = fade(fx), v = fade(fy);
    const aa = P[(P[X] + Y) & 255];
    const ba = P[(P[(X + 1) & 255] + Y) & 255];
    const ab = P[(P[X] + Y + 1) & 255];
    const bb = P[(P[(X + 1) & 255] + Y + 1) & 255];
    const x1 = grad(aa, fx, fy) + (grad(ba, fx - 1, fy) - grad(aa, fx, fy)) * u;
    const x2 = grad(ab, fx, fy - 1) + (grad(bb, fx - 1, fy - 1) - grad(ab, fx, fy - 1)) * u;
    return (x1 + (x2 - x1) * v) * 0.5 + 0.5;
  };

  return {
    n: noise,
    fbm(x, y, oct = 3, lac = 2.07, gain = 0.5) {
      let a = 0, amp = 1, f = 1, norm = 0;
      for (let i = 0; i < oct; i++) {
        a += amp * noise(x * f, y * f);
        norm += amp; amp *= gain; f *= lac;
      }
      return a / norm;
    },
  };
}

const sstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/* ------------------------------------------------------------------ zones */

export const ZONE = {
  BARREN: 0,     // desert pavement / bald flat — deliberately, aggressively empty
  GRASSLAND: 1,  // open range: grass mass, almost no props at all
  SCRUB: 2,      // sage and rabbitbrush flat
  SAVANNA: 3,    // open ground with copses — the transitional zone
  FOREST: 4,     // closed timber
  SCREE: 5,      // talus / boulder field below a scarp
  OUTCROP: 6,    // exposed bedrock ribs and tors
  RIPARIAN: 7,   // wash, riverbank, cottonwood gallery
};
export const ZONE_COUNT = 8;

/**
 * Family weights per zone: [tree, shrub, grass, rock, stone, hero].
 *
 * `hero` is the probability mass for the deliberately huge things — a tor you
 * could climb, a lone erratic, a dead giant on a ridge. It is near zero almost
 * everywhere on purpose: a landmark that occurs every 200 m is not a landmark.
 *
 * The zeros are the point of this table. BARREN really does grow nothing, and
 * GRASSLAND really is a bald sweep of grass with three rocks in it. Those two
 * rows are where the negative space in the composition comes from.
 */
const ZW = [
  /* BARREN    */ [0.00, 0.04, 0.22, 0.030, 0.14, 0.115],
  /* GRASSLAND */ [0.05, 0.16, 1.00, 0.030, 0.12, 0.105],
  /* SCRUB     */ [0.05, 1.00, 0.46, 0.110, 0.30, 0.120],
  /* SAVANNA   */ [0.32, 0.46, 0.78, 0.085, 0.22, 0.130],
  /* FOREST    */ [1.00, 1.00, 0.30, 0.150, 0.42, 0.110],
  /* SCREE     */ [0.02, 0.12, 0.05, 1.000, 1.00, 0.620],
  /* OUTCROP   */ [0.03, 0.16, 0.06, 0.700, 0.78, 1.000],
  /* RIPARIAN  */ [0.82, 0.95, 0.82, 0.170, 0.44, 0.090],
];

const SEED_CELL = 360;   // metres between region seeds
const ECO_RES = 512;     // 16 m per cell over an 8 km square

/**
 * @param {object} src fields already derived by VegMaps, all at `src.res`:
 *   alt, slope (=normal.y), moist (0..1), north (0..1), grassW, dirtW, sandW
 * @returns {object} sampler with Uint8 density fields
 */
export function buildEcology(src) {
  const size = src.size;
  const half = size * 0.5;
  const R = ECO_RES;
  const cellM = size / R;
  const sRes = src.res;
  const step = sRes / R;
  const N = makeNoise((src.seed ^ 0x2f9a1c7b) >>> 0);
  const waterLevel = src.waterLevel;

  /* nearest-neighbour read of a source field at eco cell (i,j) */
  const si = (i) => Math.min(sRes - 1, Math.max(0, Math.round(i * step)));
  const rd = (arr, i, j) => arr[si(j) * sRes + si(i)];
  /* and at a world position */
  const wi = (x) => Math.min(R - 1, Math.max(0, ((x + half) / cellM) | 0));

  /* ------------------------------------------------------- region seeds */
  const gN = Math.ceil(size / SEED_CELL) + 2;
  const sx = new Float32Array(gN * gN);
  const sz = new Float32Array(gN * gN);
  const sZone = new Uint8Array(gN * gN);
  const rs = rng((src.seed ^ 0x51ed2701) >>> 0);

  const score = new Float32Array(ZONE_COUNT);
  for (let j = 0; j < gN; j++) {
    for (let i = 0; i < gN; i++) {
      const k = j * gN + i;
      const px = -half + (i - 0.5 + 0.16 + rs() * 0.68) * SEED_CELL;
      const pz = -half + (j - 0.5 + 0.16 + rs() * 0.68) * SEED_CELL;
      sx[k] = px; sz[k] = pz;

      const ci = wi(px), cj = wi(pz);
      const y = rd(src.alt, ci, cj);
      const sl = rd(src.slope, ci, cj);
      const mo = rd(src.moist, ci, cj);
      const no = rd(src.north, ci, cj);
      const gw = rd(src.grassW, ci, cj);
      const dw = rd(src.dirtW, ci, cj);
      const sw = rd(src.sandW, ci, cj);
      const rockish = clamp01(1.0 - gw - dw * 0.8 - sw * 0.5) * 0.6
        + sstep(0.86, 0.52, sl) * 0.8;

      /* Macro fields: kilometre-scale character. Without these the zone map is
         a fair coin at every seed and the world reads as a patchwork quilt.
         With them, one side of the valley is timber country and the other is
         desert, which is what makes a place feel like somewhere. */
      const aridity = N.fbm(px / 1500 + 51.3, pz / 1500 - 17.7, 2);
      const timber = N.fbm(px / 1180 - 88.1, pz / 1180 + 40.9, 2);
      const stony = N.fbm(px / 860 + 311.7, pz / 860 + 202.3, 2);

      score[ZONE.FOREST] = 0.05 + mo * 0.95 + no * 0.70 + gw * 0.55
        + sstep(26, 95, y) * 0.55 + sstep(0.40, 0.72, timber) * 1.45
        - sstep(300, 430, y) * 2.0 - sstep(0.55, 0.80, aridity) * 1.30
        - sstep(0.62, 0.34, sl) * 0.9;
      score[ZONE.RIPARIAN] = -0.35 + mo * 2.6 + sstep(0.50, 0.78, mo) * 1.1
        - sstep(0.60, 0.30, sl) * 1.2;
      score[ZONE.SCREE] = -0.15 + sstep(0.82, 0.50, sl) * 1.85 + rockish * 1.25
        + sstep(0.46, 0.78, stony) * 1.45 + sstep(210, 400, y) * 0.75 - gw * 0.85;
      score[ZONE.OUTCROP] = -0.50 + sstep(0.78, 0.42, sl) * 2.35 + rockish * 1.6
        + sstep(0.54, 0.84, stony) * 1.30 - mo * 0.8;
      score[ZONE.GRASSLAND] = -0.10 + gw * 1.75 + sstep(0.86, 0.99, sl) * 0.55
        + mo * 0.45 - sw * 1.35 - sstep(0.50, 0.82, aridity) * 0.85;
      score[ZONE.SCRUB] = 0.30 + dw * 1.15 + sw * 0.75 + aridity * 0.55 - mo * 0.85;
      score[ZONE.SAVANNA] = 0.20 + gw * 0.45 + mo * 0.35 + timber * 0.55
        - sstep(300, 430, y) * 1.3 - sstep(0.62, 0.88, aridity) * 0.7;
      score[ZONE.BARREN] = -0.15 + sw * 1.55 + dw * 0.45 + aridity * 1.55
        - gw * 1.45 - mo * 1.35;

      /* per-seed taste, so the map is not a pure function of the terrain — a
         real landscape has accidents of history in it */
      let best = -1e9, bz = ZONE.SCRUB;
      for (let s = 0; s < ZONE_COUNT; s++) {
        const v = score[s] + (rs() - 0.5) * 0.95;
        if (v > best) { best = v; bz = s; }
      }
      sZone[k] = bz;
    }
  }

  /* --------------------------------------------------------- per-cell vote */
  const zone = new Uint8Array(R * R);
  const edge = new Uint8Array(R * R);
  const tree = new Uint8Array(R * R);
  const shrub = new Uint8Array(R * R);
  const grass = new Uint8Array(R * R);
  const rock = new Uint8Array(R * R);
  const stone = new Uint8Array(R * R);
  const hero = new Uint8Array(R * R);

  const INV = 1 / SEED_CELL;
  for (let j = 0; j < R; j++) {
    const z = -half + (j + 0.5) * cellM;
    for (let i = 0; i < R; i++) {
      const x = -half + (i + 0.5) * cellM;
      const k = j * R + i;

      /* Domain warp. Two octaves at 300 m with 150 m of throw turns the
         seed lattice's straight bisectors into lobes, peninsulas and
         inlets — the difference between a region map and a Voronoi diagram. */
      const wxa = (N.fbm(x / 300 + 7.1, z / 300 - 3.3, 2) - 0.5) * 300;
      const wza = (N.fbm(x / 300 - 21.7, z / 300 + 55.9, 2) - 0.5) * 300;
      const wx = x + wxa, wz = z + wza;

      const li = Math.max(0, Math.min(gN - 1, Math.floor((wx + half) * INV) + 1));
      const lj = Math.max(0, Math.min(gN - 1, Math.floor((wz + half) * INV) + 1));
      let d1 = 1e18, d2 = 1e18, best = 0;
      for (let b = -1; b <= 1; b++) {
        const jj = lj + b;
        if (jj < 0 || jj >= gN) continue;
        for (let a = -1; a <= 1; a++) {
          const ii = li + a;
          if (ii < 0 || ii >= gN) continue;
          const m = jj * gN + ii;
          const dx = sx[m] - wx, dz = sz[m] - wz;
          const d = dx * dx + dz * dz;
          if (d < d1) { d2 = d1; d1 = d; best = m; } else if (d < d2) { d2 = d; }
        }
      }
      let zn = sZone[best];
      /* how deep inside the region we are: 0 on the boundary, 1 well inside */
      let inner = clamp01((Math.sqrt(d2) - Math.sqrt(d1)) / (SEED_CELL * 0.42));

      /* --------------------------------------------- terrain has the veto */
      const ci = si(i), cj = si(j);
      const y = src.alt[cj * sRes + ci];
      const sl = src.slope[cj * sRes + ci];
      const mo = src.moist[cj * sRes + ci];
      const gw = src.grassW[cj * sRes + ci];

      /* a cliff is bare rock whatever the region plan says */
      if (sl < 0.46) { zn = ZONE.OUTCROP; inner = Math.max(inner, sstep(0.46, 0.30, sl)); }
      /* a wash carries a gallery even in the middle of a desert */
      else if (mo > 0.62 || (y < waterLevel + 3.2 && y > waterLevel - 1.0)) {
        zn = ZONE.RIPARIAN;
        inner = Math.max(inner, sstep(0.62, 0.86, mo));
      }
      /* nothing is timber above the treeline — this is the hard edge that
         makes a stand stop at an altitude instead of fading out */
      const treeline = 352 + (N.n(x / 260, z / 260) - 0.5) * 120;
      if (zn === ZONE.FOREST && y > treeline) zn = ZONE.SCREE;
      /* and nothing is timber underwater */
      if (y < waterLevel + 0.5) { zn = ZONE.BARREN; inner = 1; }

      zone[k] = zn;
      edge[k] = (inner * 255) | 0;

      /* ---------------------------------- clearings, thickets, rim falloff */
      const th = N.fbm(x / 88 + 601.3, z / 88 - 411.7, 2);
      const th2 = N.fbm(x / 27 - 133.1, z / 27 + 92.5, 2);
      /* Inside a mass the density is not flat: this opens genuine holes
         (clearings, blowdowns, bald patches) and closes real thickets. */
      const patch = clamp01(sstep(0.34, 0.66, th * 0.72 + th2 * 0.28) * 1.20);
      const rim = sstep(0.0, 0.34, inner);
      const mask = rim * (0.16 + 1.05 * patch);

      /* TREES GET THEIR OWN, COARSER PATCH FIELD.
       * Sharing the 88 m one put a tree every 20-30 m across the whole of a
       * savanna region, which from a vista reads as an orchard again — the
       * grain of the clustering has to be larger than the object it clusters
       * or the eye integrates it back into an even field. A 210 m grove field
       * with a hard threshold gives copses you can see the shape of, and, more
       * importantly, the open ground between them. */
      const gr = N.fbm(x / 210 - 77.3, z / 210 + 158.9, 2);
      const gr2 = N.fbm(x / 62 + 401.1, z / 62 - 233.7, 2);
      const grove = clamp01(sstep(0.42, 0.66, gr * 0.76 + gr2 * 0.24) * 1.18);
      const treeMask = rim * (0.04 + 1.30 * grove);

      const w = ZW[zn];
      /* Rock likes the ground it actually falls on, so keep a little terrain
         causation inside the region too: talus needs a slope to rest on. */
      const rockSlope = 0.45 + 0.85 * sstep(0.94, 0.60, sl);
      const grassSlope = sstep(0.40, 0.72, sl);

      tree[k] = clamp01(w[0] * treeMask * 1.34) * 255;
      shrub[k] = clamp01(w[1] * mask * 1.25) * 255;
      grass[k] = clamp01(w[2] * (0.30 + 0.85 * rim) * (0.34 + 0.90 * patch)
        * grassSlope * 1.20 * (0.72 + 0.55 * gw)) * 255;
      rock[k] = clamp01(w[3] * mask * rockSlope * 1.45) * 255;
      stone[k] = clamp01(w[4] * (0.22 + 1.0 * mask) * 1.20) * 255;
      /* heroes want to be deep inside their region and in a thin part of the
         patch field, so they stand alone rather than in the middle of a crowd */
      hero[k] = clamp01(w[5] * inner * (1.25 - grove * 0.55) * 1.30) * 255;
    }
  }

  const INV255 = 1 / 255;
  return {
    res: R, size, half, cell: cellM,
    zone, edge, tree, shrub, grass, rock, stone, hero,

    /** Bilinear sample of one of the Uint8 fields → 0..1. */
    sample(field, x, z) {
      const fx = Math.max(0, Math.min(R - 1.001, (x + half) / cellM - 0.5));
      const fz = Math.max(0, Math.min(R - 1.001, (z + half) / cellM - 0.5));
      const x0 = fx | 0, z0 = fz | 0;
      const tx = fx - x0, tz = fz - z0;
      const r0 = z0 * R + x0;
      const a = field[r0], b = field[r0 + 1];
      const c = field[r0 + R], d = field[r0 + R + 1];
      const t0 = a + (b - a) * tx;
      return (t0 + ((c + (d - c) * tx) - t0) * tz) * INV255;
    },

    /** Nearest-cell zone id at a world position. */
    zoneAt(x, z) {
      const ix = Math.max(0, Math.min(R - 1, ((x + half) / cellM) | 0));
      const iz = Math.max(0, Math.min(R - 1, ((z + half) / cellM) | 0));
      return zone[iz * R + ix];
    },

    /**
     * Stamp a zone + density override into a disc. Used to guarantee the
     * shots that are named after a biome actually stand in one.
     */
    stamp(px, pz, radius, fn) {
      const i0 = Math.max(0, Math.floor((px - radius + half) / cellM));
      const i1 = Math.min(R - 1, Math.ceil((px + radius + half) / cellM));
      const j0 = Math.max(0, Math.floor((pz - radius + half) / cellM));
      const j1 = Math.min(R - 1, Math.ceil((pz + radius + half) / cellM));
      for (let j = j0; j <= j1; j++) {
        const z = -half + (j + 0.5) * cellM;
        for (let i = i0; i <= i1; i++) {
          const x = -half + (i + 0.5) * cellM;
          const d = Math.hypot(x - px, z - pz);
          if (d > radius) continue;
          fn(j * R + i, d / radius, x, z);
        }
      }
    },

    fields: { tree, shrub, grass, rock, stone, hero },
  };
}

/**
 * Log-normal-ish size draw. `u` uniform 0..1 → a distribution with a lot of
 * small, a few medium and a rare giant, which is what a real boulder field or
 * a real stand of trees looks like. `tail` above 1 fattens the big end.
 *
 * The pass-3 world used a power remap with a tail exponent of 1.55-1.9, which
 * is nearly uniform in log space — hence "every rock is roughly the same size".
 */
export function logSize(u, lo, hi, tail = 3.0) {
  const t = Math.pow(Math.max(1e-5, u), tail);
  return lo * Math.pow(hi / lo, t);
}
