import * as THREE from 'three';
import { makeNoise, buildEcology, ZONE } from './Ecology.js';

/**
 * Biome density fields.
 *
 * One RGBA map over the playable square drives everything:
 *   R grass    — where blades grow, and how thickly
 *   G forest   — tree probability; also read by Undergrowth for the forest floor
 *   B shrub    — sage / scrub / rabbitbrush
 *   A moisture — normalised upstream catchment, selects riparian species and
 *                pushes colour from straw toward green near water
 *
 * The fields are built from the terrain's own splat weights, heightfield and
 * flow accumulation, so what grows agrees with what the ground is painted with.
 * Clustering is deliberate: two octaves of low-frequency noise cut the map into
 * thickets and clearings, and a high-frequency octave frays the treeline so it
 * never reads as a contour line.
 */

const RES = 1024;

const sstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/* ------------------------------------------------------------------ build */

export function buildVegMaps(ctx, opts = {}) {
  const terrain = ctx.get('terrain');
  const size = ctx.world.size || 8192;
  const half = size * 0.5;
  const cell = size / RES;
  const waterLevel = ctx.world.waterLevel;
  const N = makeNoise((ctx.seed ^ 0x5bd1e995) >>> 0);

  const hf = terrain && terrain.getHeightfield ? terrain.getHeightfield() : null;
  const H = hf ? hf.data : null;
  const HR = hf ? hf.res : 0;
  const flowMap = terrain && terrain.getFlowMap ? terrain.getFlowMap() : null;

  const grass = new Float32Array(RES * RES);
  const forest = new Float32Array(RES * RES);
  const shrub = new Float32Array(RES * RES);
  const moist = new Float32Array(RES * RES);
  const alt = new Float32Array(RES * RES);
  const slope = new Float32Array(RES * RES);
  const northness = new Float32Array(RES * RES);
  const nx = new Float32Array(RES * RES);
  const nz = new Float32Array(RES * RES);

  const hAt = (ix, iz) => {
    if (!H) return 0;
    const x = Math.max(0, Math.min(HR - 1, ix));
    const z = Math.max(0, Math.min(HR - 1, iz));
    return H[z * HR + x];
  };

  const hStep = HR / RES;  // 2 when RES=1024, HR=2048
  const dxy = cell;

  /* -------- pass 1: read the terrain, derive slope / aspect / moisture ----
   * Flow accumulation is extremely long-tailed, so a linear (or even log)
   * remap against the maximum leaves almost every cell reading as "wet" — the
   * first attempt had a mean moisture of 0.78, which made the entire map a
   * riverbank and put cottonwoods in the desert. Anchor the remap on
   * percentiles of the actual distribution instead. */
  let logLo = 0, logHi = 1;
  if (flowMap) {
    const f = flowMap.data;
    const sample = [];
    for (let i = 0; i < f.length; i += 37) sample.push(Math.log(1 + f[i]));
    sample.sort((a, b) => a - b);
    logLo = sample[Math.floor(sample.length * 0.82)];
    logHi = sample[Math.floor(sample.length * 0.9975)];
    if (!(logHi > logLo)) { logLo = 0; logHi = 1; }
  }

  for (let j = 0; j < RES; j++) {
    const iz = Math.round(j * hStep);
    const z = -half + (j + 0.5) * cell;
    for (let i = 0; i < RES; i++) {
      const ix = Math.round(i * hStep);
      const x = -half + (i + 0.5) * cell;
      const k = j * RES + i;

      const y = hAt(ix, iz);
      alt[k] = y;
      const hl = hAt(ix - 1, iz), hr = hAt(ix + 1, iz);
      const hd = hAt(ix, iz - 1), hu = hAt(ix, iz + 1);
      const sx = (hl - hr) / (2 * (size / HR));
      const sz = (hd - hu) / (2 * (size / HR));
      const len = Math.sqrt(sx * sx + 1 + sz * sz);
      slope[k] = 1 / len;                    // = normal.y
      nx[k] = sx / len;
      nz[k] = sz / len;
      northness[k] = clamp01((-sz / len) * 1.35 + 0.15);

      if (flowMap) {
        const fi = Math.min(flowMap.res - 1, Math.round(i * (flowMap.res / RES)));
        const fj = Math.min(flowMap.res - 1, Math.round(j * (flowMap.res / RES)));
        const lv = Math.log(1 + flowMap.data[fj * flowMap.res + fi]);
        moist[k] = clamp01((lv - logLo) / (logHi - logLo));
      }
      void x; void z; void dxy;
    }
  }

  /* --------------------------- pass 2: composition + density -------------- */
  const surf = ctx.world.getSurface;
  const splatA = terrain && terrain.splatA;
  const splatRes = terrain && terrain.splatRes ? terrain.splatRes : 0;
  const useSplat = !!(splatA && splatRes === RES);

  const tmpGrassW = new Float32Array(RES * RES);
  const tmpDirtW = new Float32Array(RES * RES);
  const tmpDryW = new Float32Array(RES * RES);

  for (let j = 0; j < RES; j++) {
    const z = -half + (j + 0.5) * cell;
    for (let i = 0; i < RES; i++) {
      const k = j * RES + i;
      const x = -half + (i + 0.5) * cell;
      if (useSplat) {
        const s = k * 4;
        tmpGrassW[k] = (splatA[s] + splatA[s + 1]) / 255;
        tmpDryW[k] = splatA[s + 1] / 255;
        tmpDirtW[k] = splatA[s + 2] / 255;
      } else {
        const g = surf(x, z);
        tmpGrassW[k] = g.grass;
        tmpDryW[k] = g.grass * 0.5;
        tmpDirtW[k] = g.dirt;
      }
    }
  }

  /* ------------------------------- pass 2b: the regional plan -------------
   * Everything below is now a MODULATION INSIDE A REGION rather than an
   * independent probability field. See Ecology.js for why. The sand weight is
   * derived rather than read: the splat's fourth channel has changed meaning
   * once already, and "what is left after grass and dirt" is stable. */
  const sandW = new Float32Array(RES * RES);
  for (let k = 0; k < RES * RES; k++) {
    sandW[k] = clamp01(1 - tmpGrassW[k] - tmpDirtW[k]);
  }
  const eco = buildEcology({
    res: RES, size, seed: ctx.seed, waterLevel,
    alt, slope, moist, north: northness,
    grassW: tmpGrassW, dirtW: tmpDirtW, sandW,
  });

  /* forest cluster field — large stands with frayed edges */
  const S1 = 1 / 640, S2 = 1 / 185, S3 = 1 / 41;
  const ecoStep = eco.res / RES;
  const ecoAt = (field, i, j) => field[
    (Math.min(eco.res - 1, (j * ecoStep) | 0)) * eco.res
    + (Math.min(eco.res - 1, (i * ecoStep) | 0))] * (1 / 255);

  for (let j = 0; j < RES; j++) {
    const z = -half + (j + 0.5) * cell;
    for (let i = 0; i < RES; i++) {
      const k = j * RES + i;
      const x = -half + (i + 0.5) * cell;
      const y = alt[k];
      const ny = slope[k];
      const gw = tmpGrassW[k];
      const mo = moist[k];

      const wet = y < waterLevel + 0.9 ? 1 : 0;

      /* ------------------------------------------------------------ grass
       * This world is arid: the splat rarely reads as pure grass, and gating on
       * `grassWeight^n` produced a completely bare planet. Real western range is
       * bunchgrass over dirt, so dirt and dry-grass weights both carry tussock,
       * just thinner and strawier. */
      const gClump = N.fbm(x * (1 / 155) + 11.3, z * (1 / 155) - 4.7, 3);
      const gClump2 = N.fbm(x * (1 / 38) - 60.1, z * (1 / 38) + 22.9, 2);
      const gPatch = clamp01(sstep(0.30, 0.70, gClump * 0.70 + gClump2 * 0.30) * 1.3);
      const soilCover = clamp01(
        sstep(0.06, 0.46, gw) * 1.00
        + tmpDirtW[k] * 0.34);
      let gd = soilCover
        * sstep(0.42, 0.74, ny)
        * (0.20 + 0.80 * gPatch)
        * (1 - wet);
      /* riverbanks are lush even when the splat says dirt */
      gd = Math.max(gd, clamp01(mo * 1.7 - 0.35) * sstep(0.58, 0.84, ny) * 0.95 * (1 - wet));
      /* The region decides IF there is a sward here; the terrain terms above
         decide how thick it is once there is. A grassland reads as a bald
         sweep of range and a scree field reads as bare rock — neither is
         possible while every cell gets an independent lottery ticket. */
      const eG = ecoAt(eco.grass, i, j);
      grass[k] = clamp01((0.28 + 0.90 * gd) * eG * 1.42);

      /* ----------------------------------------------------------- forest */
      const cl1 = N.fbm(x * S1 + 3.1, z * S1 + 9.4, 3);
      const cl2 = N.fbm(x * S2 - 71.7, z * S2 + 15.2, 3);
      const rag = N.fbm(x * S3 + 130.5, z * S3 - 88.1, 2);
      const cluster = sstep(0.40, 0.63, cl1 * 0.62 + cl2 * 0.38);
      const altBand = sstep(26, 88, y) * (1 - sstep(330, 500, y));
      const slopeOk = sstep(0.26, 0.50, ny);
      const soil = clamp01(gw * 1.15 + tmpDirtW[k] * 0.72 + 0.10);
      const north = 0.42 + 0.85 * northness[k];
      const nearWater = 0.58 + 1.20 * clamp01(mo * 1.6 - 0.25);
      let fd = cluster * altBand * slopeOk * soil * north * nearWater;
      fd *= 0.45 + 0.85 * rag;             // frayed treeline

      /* Riparian corridor: cottonwoods and willows line every desert wash, and
         they are what gives a dry basin its midground. Independent of altitude
         — a drainage at 30 m carries trees a hillside at 30 m never would. */
      const riparian = sstep(0.18, 0.58, mo) * sstep(0.30, 0.60, ny)
        * (0.45 + 0.85 * rag) * 1.05;
      /* Savanna: isolated junipers and scrub oak scattered over the dry flats. */
      const sav = N.fbm(x * (1 / 255) + 511.3, z * (1 / 255) - 77.9, 2);
      /* Groves: without a second, tighter clustering octave the savanna term
         spreads trees at a near-constant spacing and the basin reads as an
         orchard. This is what breaks it into copses and open ground. */
      const grove = sstep(0.42, 0.70, N.fbm(x * (1 / 74) + 907.1, z * (1 / 74) - 413.7, 2));
      const savanna = sstep(0.40, 0.80, sav) * sstep(0.42, 0.68, ny)
        * (1 - sstep(340, 500, y)) * clamp01(gw * 0.9 + tmpDirtW[k] * 0.85) * 0.62
        * (0.35 + 1.05 * grove) * (0.55 + 0.70 * rag);

      const fdRaw = clamp01(Math.max(fd * 1.45, riparian, savanna)) * (1 - wet);
      /* Trees exist where the ecology says there is timber, full stop. This
         one line is what turns "trees dotted across the plain at constant
         spacing all the way to the horizon" into stands with edges. */
      const eT = ecoAt(eco.tree, i, j);
      forest[k] = clamp01((0.34 + 0.86 * fdRaw) * eT * 1.55) * (1 - wet);

      /* ------------------------------------------------------------ shrub */
      const sc = N.fbm(x * (1 / 96) - 200.4, z * (1 / 96) + 51.8, 3);
      const dryland = clamp01(tmpDirtW[k] * 1.15 + tmpDryW[k] * 0.95 + gw * 0.35)
        * sstep(0.42, 0.70, ny) * (1 - sstep(320, 490, y));
      const eS = ecoAt(eco.shrub, i, j);
      shrub[k] = clamp01((0.26 + 0.90 * clamp01(dryland * sstep(0.34, 0.70, sc) * 1.5))
        * eS * 1.45) * (1 - wet);
    }
  }

  /* ------------- pass 3: forest edge → undergrowth, then soften ---------- */
  const blurred = blur(forest, RES, 2);
  for (let k = 0; k < RES * RES; k++) {
    const edge = clamp01((forest[k] - blurred[k] * 0.82) * 3.2);
    shrub[k] = clamp01(shrub[k] * 0.9 + edge * 0.85 + blurred[k] * 0.30);
    /* the canopy shades out the meadow grass but not entirely */
    grass[k] = clamp01(grass[k] * (1 - blurred[k] * 0.32));
  }

  /* ------------------------ pass 4: art-directed overrides ---------------- */
  const stamp = (px, pz, radius, fn) => {
    const i0 = Math.max(0, Math.floor((px - radius + half) / cell));
    const i1 = Math.min(RES - 1, Math.ceil((px + radius + half) / cell));
    const j0 = Math.max(0, Math.floor((pz - radius + half) / cell));
    const j1 = Math.min(RES - 1, Math.ceil((pz + radius + half) / cell));
    for (let j = j0; j <= j1; j++) {
      const z = -half + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const x = -half + (i + 0.5) * cell;
        const d = Math.hypot(x - px, z - pz);
        if (d > radius) continue;
        fn(j * RES + i, d / radius, x, z);
      }
    }
  };

  /* Guarantee the timber belt the forest_interior shot is named after: a real
     stand around the POI, with a small clearing at the camera so the lens is
     not inside a trunk, and thicker undergrowth through it. */
  const fp = ctx.poi.get('forest');
  const forestCentre = fp ? (fp.pos || fp) : null;
  if (forestCentre) {
    const fwd = ctx.poi.get('forest_fwd');
    const fx = forestCentre.x, fz = forestCentre.z;
    const tx = fwd ? (fwd.pos || fwd).x : fx;
    const tz = fwd ? (fwd.pos || fwd).z : fz;
    const dirx = tx - fx, dirz = tz - fz;
    const dl = Math.hypot(dirx, dirz) || 1;
    /* centre the stand just ahead of the camera so the shot looks INTO it and
       is surrounded by it — a treeline seen from outside is not a forest
       interior */
    const cx = fx + (dirx / dl) * 55, cz = fz + (dirz / dl) * 55;
    stamp(cx, cz, 380, (k, t) => {
      const bump = Math.pow(1 - t, 1.05);
      if (slope[k] > 0.30 && alt[k] > waterLevel + 1.5) {
        forest[k] = clamp01(Math.max(forest[k], bump * 1.0));
        shrub[k] = clamp01(Math.max(shrub[k], bump * 0.86));
        grass[k] = clamp01(Math.max(grass[k], bump * 0.42));
      }
    });
    /* Scatter reads the ecology, not this map, so the timber belt has to be
       declared there too or the forest floor gets desert dressing on it. */
    eco.stamp(cx, cz, 380, (k, t) => {
      const bump = Math.pow(1 - t, 1.05) * 255;
      eco.zone[k] = ZONE.FOREST;
      eco.tree[k] = Math.max(eco.tree[k], bump);
      eco.shrub[k] = Math.max(eco.shrub[k], bump * 0.86);
      eco.stone[k] = Math.max(eco.stone[k], bump * 0.52);
      eco.rock[k] = Math.max(eco.rock[k], bump * 0.30);
    });
    /* A real clearing, not a token one. Pass 3 carved 8 m and the shot still
       opened with a 2 m pine frond filling sixty percent of the frame — the
       lens was standing inside a canopy. 14 m puts the nearest trunk out at
       readable distance, and a forest seen from a hole in itself is a much
       stronger "interior" than a forest seen from inside a bush. */
    stamp(fx, fz, 15, (k, t) => {
      forest[k] *= sstep(0.10, 0.92, t);
    });
    eco.stamp(fx, fz, 15, (k, t) => {
      eco.tree[k] *= sstep(0.10, 0.92, t);
      /* the floor of the clearing keeps its litter and low brush */
      eco.stone[k] = Math.max(eco.stone[k], 190);
      eco.shrub[k] = Math.max(eco.shrub[k], 150 * sstep(0.0, 0.7, t));
    });
    ctx.poi.set('forest_stand', { pos: new THREE.Vector3(cx, 0, cz) });
  }

  /* Keep the settlement clear so Town has room, but ring it with scrub. */
  const town = ctx.poi.get('town');
  if (town) {
    const tp = town.pos || town;
    stamp(tp.x, tp.z, 210, (k, t) => {
      forest[k] *= sstep(0.36, 0.92, t);
      shrub[k] *= 0.30 + 0.70 * sstep(0.30, 0.85, t);
    });
    eco.stamp(tp.x, tp.z, 210, (k, t) => {
      const f = sstep(0.36, 0.92, t);
      eco.tree[k] *= f;
      eco.rock[k] *= f;
      eco.hero[k] *= f;
      eco.shrub[k] *= 0.30 + 0.70 * sstep(0.30, 0.85, t);
    });
  }

  /* ------------------------------ pass 5: soften and encode -------------- */
  const gS = blur(grass, RES, 1);
  const fS = blur(forest, RES, 1);
  const sS = blur(shrub, RES, 1);

  const data = new Uint8Array(RES * RES * 4);
  for (let k = 0; k < RES * RES; k++) {
    data[k * 4] = gS[k] * 255;
    data[k * 4 + 1] = fS[k] * 255;
    data[k * 4 + 2] = sS[k] * 255;
    data[k * 4 + 3] = moist[k] * 255;
  }

  const tex = new THREE.DataTexture(data, RES, RES, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  /* ---------------------- vegetation's own normal + occlusion map --------- */
  /* Concavity occlusion: compare each cell against a 12-cell (≈100 m) box mean.
     Gully floors and hollows lose sky, ridges keep it — the same cue that makes
     the terrain read as carved, applied to what grows on it. */
  const coarse = blur(alt, RES, 12);
  const nData = new Uint8Array(RES * RES * 4);
  for (let k = 0; k < RES * RES; k++) {
    nData[k * 4] = (nx[k] * 0.5 + 0.5) * 255;
    nData[k * 4 + 1] = (slope[k] * 0.5 + 0.5) * 255;
    nData[k * 4 + 2] = (nz[k] * 0.5 + 0.5) * 255;
    nData[k * 4 + 3] = clamp01(0.60 + (alt[k] - coarse[k]) * 0.030) * 255;
  }
  const nTex = new THREE.DataTexture(nData, RES, RES, THREE.RGBAFormat);
  nTex.colorSpace = THREE.NoColorSpace;
  nTex.wrapS = nTex.wrapT = THREE.ClampToEdgeWrapping;
  nTex.minFilter = THREE.LinearFilter;
  nTex.magFilter = THREE.LinearFilter;
  nTex.generateMipmaps = false;
  nTex.needsUpdate = true;

  void opts;
  return {
    res: RES, size, half, cell,
    grass: gS, forest: fS, shrub: sS, moist, alt, slope, northness,
    eco,
    texture: tex, normalTexture: nTex,
    sample(field, x, z) {
      const fx = Math.max(0, Math.min(RES - 1.001, (x + half) / cell - 0.5));
      const fz = Math.max(0, Math.min(RES - 1.001, (z + half) / cell - 0.5));
      const x0 = fx | 0, z0 = fz | 0;
      const tx = fx - x0, tz = fz - z0;
      const a = field[z0 * RES + x0], b = field[z0 * RES + x0 + 1];
      const c = field[(z0 + 1) * RES + x0], d = field[(z0 + 1) * RES + x0 + 1];
      const t0 = a + (b - a) * tx;
      return t0 + ((c + (d - c) * tx) - t0) * tz;
    },
  };
}

function blur(src, res, radius) {
  const tmp = new Float32Array(res * res);
  const out = new Float32Array(res * res);
  const w = radius * 2 + 1;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) {
        const x = Math.max(0, Math.min(res - 1, i + k));
        s += src[j * res + x];
      }
      tmp[j * res + i] = s / w;
    }
  }
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) {
        const y = Math.max(0, Math.min(res - 1, j + k));
        s += tmp[y * res + i];
      }
      out[j * res + i] = s / w;
    }
  }
  return out;
}
