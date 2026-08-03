import * as THREE from 'three';
import { fbmTile, fbm, fbm01, smoothstep, clamp } from './Noise.js';

/**
 * Derived maps: surface normals, sky occlusion, long-range sun shadowing, and
 * the baked splat control set the terrain shader and `world.getSurface()` both
 * read — so what you see is exactly what vegetation and footstep audio query.
 */

/* ------------------------------------------------------------- normals + AO */

const toHalf = THREE.DataUtils.toHalfFloat;

/**
 * Surface normal + occlusion, computed by central difference from the Float32
 * heightfield and stored at **16-bit float precision**: (nx, nz, skyAO, curv).
 *
 * Pass 1 packed the normal into RGBA8. A 1/255 step in nx is a ~0.45deg step in
 * surface orientation, which under a directional key light produces visible
 * Mach banding — the "blocky quantization terracing" the critics measured on
 * every ridge. Half-float removes the quantisation entirely for 2 bytes per
 * channel. ny is reconstructed in the shader (the surface is a heightfield, so
 * ny > 0 always).
 */
export function bakeNormalAO(h, res, cellSize, ao, aoRes) {
  const out = new Uint16Array(res * res * 4);
  const inv = 1 / (2 * cellSize);
  const c2 = 1 / (cellSize * cellSize);
  for (let y = 0; y < res; y++) {
    const ym = y > 0 ? y - 1 : 0, yp = y < res - 1 ? y + 1 : res - 1;
    for (let x = 0; x < res; x++) {
      const xm = x > 0 ? x - 1 : 0, xp = x < res - 1 ? x + 1 : res - 1;
      const hxp = h[y * res + xp], hxm = h[y * res + xm];
      const hzp = h[yp * res + x], hzm = h[ym * res + x];
      const dx = (hxp - hxm) * inv;
      const dz = (hzp - hzm) * inv;
      let nx = -dx, ny = 1, nz = -dz;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= l; ny /= l; nz /= l;
      /* Laplacian → concavity: gullies and hollows collect silt and lose sky */
      const lap = (hxp + hxm + hzp + hzm - 4 * h[y * res + x]) * c2;
      const i = (y * res + x) * 4;
      out[i] = toHalf(nx);
      out[i + 1] = toHalf(nz);
      /* sky occlusion sampled from the lower-res AO field */
      const au = Math.min(aoRes - 1, (x * aoRes / res) | 0);
      const av = Math.min(aoRes - 1, (y * aoRes / res) | 0);
      out[i + 2] = toHalf(clamp(ao[av * aoRes + au], 0, 1));
      out[i + 3] = toHalf(clamp(0.5 + lap * 220, 0, 1));
    }
  }
  return out;
}

/**
 * Sky occlusion by horizon search: 8 azimuths, exponentially spaced taps out to
 * ~600 m. Valleys and gully floors lose sky, ridges keep all of it — this is
 * what makes eroded terrain read as carved rather than bumpy.
 */
export function computeSkyAO(h, res, cellSize) {
  const ao = new Float32Array(res * res);
  const DIRS = 8;
  const dxs = new Float32Array(DIRS), dys = new Float32Array(DIRS);
  for (let d = 0; d < DIRS; d++) {
    const a = (d / DIRS) * Math.PI * 2;
    dxs[d] = Math.cos(a); dys[d] = Math.sin(a);
  }
  const STEPS = [1, 2, 4, 8, 16, 32, 48];
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const h0 = h[i];
      let occ = 0;
      for (let d = 0; d < DIRS; d++) {
        let maxSlope = 0;
        for (let s = 0; s < STEPS.length; s++) {
          const t = STEPS[s];
          const sx = Math.round(x + dxs[d] * t);
          const sy = Math.round(y + dys[d] * t);
          if (sx < 0 || sy < 0 || sx >= res || sy >= res) break;
          const dh = h[sy * res + sx] - h0;
          if (dh <= 0) continue;
          const sl = dh / (t * cellSize);
          if (sl > maxSlope) maxSlope = sl;
        }
        /* sin of the horizon elevation angle */
        occ += maxSlope / Math.sqrt(1 + maxSlope * maxSlope);
      }
      ao[i] = clamp(1 - (occ / DIRS) * 1.15, 0.14, 1);
    }
  }
  return ao;
}

/* ------------------------------------------------------- long-range sun shadow */

/**
 * Exact single-pass terrain self-shadowing for the current sun direction.
 * Sweeps a 1-D shadow front across the field in the direction the light
 * travels, so an 8 km range can shadow a valley floor 3 km away — something a
 * 900 m shadow cascade can never do.
 *
 * @param out Float32Array(res*res) visibility 0..1
 */
export function computeSunShadow(h, res, cellSize, sunX, sunY, sunZ, out, soft = 3.0) {
  const hl = Math.hypot(sunX, sunZ);
  /*
   * Sun below the horizon.
   *
   * This used to fill 0 ("everything is in the sun's shadow"), which is true of
   * the sun but wrong in practice: the terrain shader applies this field as
   * `reflectedLight.directDiffuse *= gSunVis`, i.e. to ALL direct light. Filling
   * 0 therefore switched off the moon key AND every point light on the terrain
   * for the whole night — the campfire in night_camp lit nothing but its own
   * stones, and moonlit_ridge had a black ground under a lit sky.
   *
   * env.sunIntensity is already 0 down here, so the sun contributes nothing
   * whatever this field says. Neutral (1) is the only value that does not
   * corrupt the other light sources.
   */
  if (sunY <= 0.015) { out.fill(1); return; }
  if (hl < 1e-4) { out.fill(1); return; }
  const tanElev = sunY / hl;

  /* direction the light travels (away from the sun) */
  const dx = -sunX / hl, dz = -sunZ / hl;
  const front = new Float32Array(res + 2);
  const shifted = new Float32Array(res + 2);
  const NEG = -1e9;

  if (Math.abs(dx) >= Math.abs(dz)) {
    const xs = dx > 0 ? 1 : -1;
    const drift = dz / Math.abs(dx);            // cells of z per x step
    const drop = (cellSize / Math.abs(dx)) * tanElev;
    front.fill(NEG);
    for (let n = 0; n < res; n++) {
      const x = xs > 0 ? n : res - 1 - n;
      /* advect the shadow front by `drift` and let it descend by `drop` */
      for (let z = 0; z < res; z++) {
        const src = z - drift;
        const i0 = Math.floor(src);
        const f = src - i0;
        const a = (i0 >= 0 && i0 < res) ? front[i0] : NEG;
        const b = (i0 + 1 >= 0 && i0 + 1 < res) ? front[i0 + 1] : NEG;
        shifted[z] = (a + (b - a) * f) - drop;
      }
      for (let z = 0; z < res; z++) {
        const hz = h[z * res + x];
        const s = shifted[z];
        out[z * res + x] = smoothstep(-soft, soft, hz - s);
        front[z] = hz > s ? hz : s;
      }
    }
  } else {
    const zs = dz > 0 ? 1 : -1;
    const drift = dx / Math.abs(dz);
    const drop = (cellSize / Math.abs(dz)) * tanElev;
    front.fill(NEG);
    for (let n = 0; n < res; n++) {
      const z = zs > 0 ? n : res - 1 - n;
      for (let x = 0; x < res; x++) {
        const src = x - drift;
        const i0 = Math.floor(src);
        const f = src - i0;
        const a = (i0 >= 0 && i0 < res) ? front[i0] : NEG;
        const b = (i0 + 1 >= 0 && i0 + 1 < res) ? front[i0 + 1] : NEG;
        shifted[x] = (a + (b - a) * f) - drop;
      }
      const row = z * res;
      for (let x = 0; x < res; x++) {
        const hz = h[row + x];
        const s = shifted[x];
        out[row + x] = smoothstep(-soft, soft, hz - s);
        front[x] = hz > s ? hz : s;
      }
    }
  }
}

/** In-place 3x3 box blur repeated `passes` times — softens the shadow edge. */
export function blurU8FromFloat(src, dst, res, passes = 2) {
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < res; y++) {
      const ym = y > 0 ? y - 1 : 0, yp = y < res - 1 ? y + 1 : res - 1;
      for (let x = 0; x < res; x++) {
        const xm = x > 0 ? x - 1 : 0, xp = x < res - 1 ? x + 1 : res - 1;
        b[y * res + x] = (
          a[ym * res + xm] + a[ym * res + x] + a[ym * res + xp] +
          a[y * res + xm] + a[y * res + x] * 2 + a[y * res + xp] +
          a[yp * res + xm] + a[yp * res + x] + a[yp * res + xp]) / 10;
      }
    }
    const t = a; a = b; b = t;
  }
  for (let i = 0; i < src.length; i++) dst[i] = clamp(a[i], 0, 1) * 255;
}

/* ------------------------------------------------------------------- splat */

export const LAYER = {
  GRASS_PRAIRIE: 0,
  GRASS_DRY: 1,
  DIRT_DRY: 2,
  ROCK_CLIFF: 3,
  SCREE: 4,
  SAND_FINE: 5,
  SNOW: 6,
};

/**
 * Bake the surface composition. The shader reads exactly these weights, so
 * `world.getSurface()` and what you see are the same thing by construction.
 *
 * @returns {{splatA:Uint8Array, splatB:Uint8Array, ctrl:Uint8Array}}
 */
export function bakeSplat(field, h, acc, wet, res, cellSize, waterLevel, half = 4096,
  fine = null, fineRes = 0) {
  const N = res * res;
  const splatA = new Uint8Array(N * 4);
  const splatB = new Uint8Array(N * 4);
  const ctrl = new Uint8Array(N * 4);
  const inv = 1 / (2 * cellSize);
  const lA0 = Math.log(3.0e4), lA1 = Math.log(1.2e6);

  /*
   * Slope is measured on the FINAL heightfield, not the 8 m simulation grid,
   * and the steepest sub-cell wins. Pass 1 measured it on the sim grid, where
   * a 70-degree scarp averages down to a 20-degree ramp, so the rock threshold
   * never fired and the whole range painted as sand.
   */
  const fRatio = fine && fineRes ? fineRes / res : 0;
  const fInv = fRatio ? 1 / (2 * (cellSize / fRatio)) : 0;
  const maxFineSlope = (x, y) => {
    if (!fRatio) return -1;
    const bx = (x * fRatio) | 0, by = (y * fRatio) | 0;
    let best = 0;
    const n = Math.max(1, fRatio | 0);
    for (let b = 0; b < n; b++) {
      const yy = Math.min(fineRes - 2, Math.max(1, by + b));
      for (let a = 0; a < n; a++) {
        const xx = Math.min(fineRes - 2, Math.max(1, bx + a));
        const k = yy * fineRes + xx;
        const gx = (fine[k + 1] - fine[k - 1]) * fInv;
        const gz = (fine[k + fineRes] - fine[k - fineRes]) * fInv;
        const s = Math.sqrt(gx * gx + gz * gz);
        if (s > best) best = s;
      }
    }
    return best;
  };

  for (let y = 0; y < res; y++) {
    const ym = y > 0 ? y - 1 : 0, yp = y < res - 1 ? y + 1 : res - 1;
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const xm = x > 0 ? x - 1 : 0, xp = x < res - 1 ? x + 1 : res - 1;
      const dx = (h[y * res + xp] - h[y * res + xm]) * inv;
      const dz = (h[yp * res + x] - h[ym * res + x]) * inv;
      const slopeSim = Math.sqrt(dx * dx + dz * dz);       // rise per metre, 8 m
      const slopeFine = maxFineSlope(x, y);
      const slope = slopeFine > slopeSim ? slopeFine : slopeSim;
      const alt = h[i];

      /* Laplacian → concavity: gullies and hollows collect water and silt. */
      const lap = (h[y * res + xp] + h[y * res + xm] + h[yp * res + x] + h[ym * res + x]
                 - 4 * h[i]) / (cellSize * cellSize);
      const concave = clamp(0.5 + lap * 260, 0, 1);

      const a = acc[i];
      const flow01 = a > 0 ? clamp((Math.log(Math.max(a, 1)) - lA0) / (lA1 - lA0), 0, 1) : 0;

      const wx = -half + (x + 0.5) * cellSize;
      const wz = -half + (y + 0.5) * cellSize;
      /* Medium-scale ecology patchiness: without this every flat reads as one
         flat colour from a distance, which is the single biggest thing that
         makes procedural grassland look fake. */
      const patchA = fbm01(wx + 4300, wz - 1900, 3, 1 / 340);
      const patchB = fbm01(wx - 2100, wz + 5200, 3, 1 / 145);
      const arid = clamp(field.arid[i] + (patchA - 0.5) * 0.55 + (patchB - 0.5) * 0.28, 0, 1);
      const wm = field.rMount[i], wb = field.rBad[i], wv = field.rValley[i];
      const wp = field.rPlain[i], wf = field.rFoot[i], ws = field.rSand[i];
      const hard = field.hard[i];

      /*
       * Every altitude threshold below is perturbed by multi-octave noise
       * BEFORE it is thresholded. A bare `smoothstep(a, b, altitude)` paints a
       * contour line: it is level by construction, and it is what made pass 1
       * read as a topographic map rather than geology.
       */
      const altJ = alt
        + (fbm01(wx * 1.0 + 900, wz * 1.0 - 640, 4, 1 / 260) - 0.5) * 150
        + (fbm01(wx * 1.0 - 220, wz * 1.0 + 130, 3, 1 / 74) - 0.5) * 46;

      /* --- rock: steep ground, hard strata, high mountains */
      const steep = smoothstep(0.50, 0.95, slope);          // 27deg .. 44deg
      let rock = steep * (0.62 + hard * 0.6);
      /* Butte and massif faces are bedrock from about 15 degrees up — there is
         nowhere for soil to stay on a retreating scarp. Pass 1 required 27deg
         everywhere, which is above the average slope of the whole range, so
         the mountains painted as sand. */
      rock += smoothstep(0.26, 0.58, slope) * wb * 1.25;
      rock += smoothstep(0.30, 0.66, slope) * wm * 1.05;
      rock += smoothstep(0.34, 0.70, slope) * wf * 0.6;
      rock += smoothstep(330, 560, altJ) * 0.40 * wm;
      /* bedrock exposed at every ridge break — convex ground sheds its soil */
      rock += clamp(0.5 - concave, 0, 0.5) * smoothstep(0.34, 0.68, slope) * 1.15;
      /* the occasional bald outcrop out on the open flats */
      rock += smoothstep(0.89, 0.99, fbm01(wx * 1.7 - 900, wz * 1.7 + 300, 3, 1 / 220))
        * (1 - smoothstep(0.30, 0.55, slope)) * 0.42;
      rock = clamp(rock, 0, 1);

      /*
       * Scree: the talus apron. It belongs where a steep face runs out onto a
       * gentler one and the curvature turns concave — the foot of a cliff, the
       * inside of a gully — not smeared over every mid-slope.
       */
      const midSlope = smoothstep(0.26, 0.52, slope) * (1 - smoothstep(0.82, 1.20, slope));
      let scree = midSlope
        * (0.22 + smoothstep(0.48, 0.86, concave) * 1.05)
        * (0.35 + smoothstep(140, 430, altJ) * 0.9)
        * (wm * 1.45 + wf * 0.65 + wb * 0.85 + 0.10);
      /* debris shed into the gullies of a range — this is what breaks a massif
         out of one flat rock colour into rock, talus and washed-in soil */
      scree += smoothstep(0.30, 0.62, slope) * smoothstep(0.44, 0.88, concave)
        * (wm + wb * 0.7) * 0.95;
      scree += midSlope * smoothstep(0.55, 0.95, concave) * hard * 0.5;
      /* Desert pavement: on an old arid flat the wind deflates the fines away
         and leaves a dark gravel lag. It is the only naturally DARK surface an
         open desert has, and without it the whole plain sits at one value. */
      scree += smoothstep(0.60, 0.93, fbm01(wx * 1.3 + 5100, wz * 1.3 - 2200, 3, 1 / 190))
        * smoothstep(0.42, 0.80, arid) * (1 - smoothstep(0.16, 0.38, slope)) * 0.60;
      scree = clamp(scree, 0, 1);

      /* --- dirt: gullies, washes, banks, disturbed ground */
      let dirt = smoothstep(0.10, 0.34, slope) * 0.55
        + flow01 * 0.85
        + concave * 0.28 * (1 - steep)
        + wb * 0.35 + wv * 0.18
        + smoothstep(0.62, 0.86, patchB) * 0.45;
      dirt *= (0.55 + arid * 0.75);
      dirt = clamp(dirt, 0, 1);

      /* --- sand: flat, arid, low, and the dune region */
      let sand = (ws * 1.15 + smoothstep(0.55, 0.9, arid) * 0.45)
        * (1 - smoothstep(0.10, 0.30, slope))
        * (1 - smoothstep(140, 300, altJ));
      sand += smoothstep(0.7, 1.0, flow01) * 0.35 * (1 - smoothstep(0.12, 0.3, slope)); // sandbars
      sand = clamp(sand, 0, 1);

      /* --- grass: flats, moisture, low aridity */
      const flat = 1 - smoothstep(0.12, 0.46, slope);
      const moist = clamp(1 - arid + flow01 * 0.5 + wv * 0.35
        + (1 - smoothstep(waterLevel + 4, waterLevel + 70, alt)) * 0.3, 0, 1.4);
      const grassTotal = clamp(flat * (0.35 + moist * 0.85) * (1 - rock * 0.95), 0, 1);
      const dryness = clamp(arid * 1.25 + smoothstep(120, 380, altJ) * 0.35
        - flow01 * 0.55 - wv * 0.3 + (patchA - 0.5) * 0.75, 0, 1);
      let gp = grassTotal * (1 - dryness);
      let gd = grassTotal * dryness;

      /* channels are bare */
      const chan = wet ? wet[i] : 0;
      const bare = smoothstep(0.25, 0.75, chan);
      gp *= (1 - bare); gd *= (1 - bare);
      dirt = clamp(dirt + bare * 0.5, 0, 1);
      sand = clamp(sand + bare * 0.45, 0, 1);

      let tot = gp + gd + dirt + rock + scree + sand;
      if (tot < 1e-4) { gd = 1; tot = 1; }
      const s = 1 / tot;

      const j = i * 4;
      splatA[j] = gp * s * 255;
      splatA[j + 1] = gd * s * 255;
      splatA[j + 2] = dirt * s * 255;
      splatA[j + 3] = rock * s * 255;
      splatB[j] = scree * s * 255;
      splatB[j + 1] = sand * s * 255;
      splatB[j + 2] = 0;
      splatB[j + 3] = 255;

      ctrl[j] = flow01 * 255;
      ctrl[j + 1] = arid * 255;
      ctrl[j + 2] = concave * 255;
      /*
       * Mip-safe steepness. The shader cannot get this from the normal map at
       * range: mipping AVERAGES normal vectors, so a 70-degree cliff two
       * kilometres away resolves to a near-flat normal and every slope-gated
       * effect (strata, rock detail, triplanar) silently switches itself off
       * exactly where the mountains are. Averaging a slope MAGNITUDE degrades
       * gracefully, so steepness travels in its own channel.
       */
      ctrl[j + 3] = clamp(slope / 1.6, 0, 1) * 255;
      void wp; void alt;
    }
  }
  return { splatA, splatB, ctrl };
}

/* --------------------------------------------------------- macro breakup */

/**
 * Low-frequency, band-limited breakup mask. The terrain shader samples this at
 * three different world scales (1300 m / 430 m / 150 m) through three different
 * rotations, so the three tile periods are mutually irrational on screen and
 * the plain has no repeat you can find. Alpha carries the cloud-shadow field.
 *
 * Deliberately soft: every channel's finest octave stays above ~10 texels so
 * the mask can never contribute aliasing of its own.
 */
export function makeMacroTexture(size = 512) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const i = (y * size + x) * 4;
      data[i] = fbmTile(u * 2, v * 2, 3, 2) * 255;
      data[i + 1] = fbmTile(u * 3 + 7.5, v * 3 - 2.5, 3, 3) * 255;
      data[i + 2] = fbmTile(u * 5 - 3.25, v * 5 + 1.75, 3, 5) * 255;
      data[i + 3] = fbmTile(u * 4 + 21.5, v * 4 + 11.5, 3, 4) * 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/* --------------------------------------------------------- shader noise tile */

/** Small tiling 4-channel noise used to break every blend edge in the shader. */
export function makeNoiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const i = (y * size + x) * 4;
      data[i] = fbmTile(u * 4, v * 4, 4, 4) * 255;
      data[i + 1] = fbmTile(u * 9 + 13.5, v * 9 - 4.5, 3, 9) * 255;
      data[i + 2] = fbmTile(u * 19 - 7.25, v * 19 + 2.75, 2, 19) * 255;
      data[i + 3] = fbmTile(u * 2 + 41.5, v * 2 + 17.5, 3, 2) * 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}
