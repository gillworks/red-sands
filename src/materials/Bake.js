import * as THREE from 'three';
import { clamp01, smoothstep, setBandLimit } from './Noise.js';

/**
 * Bake.js — turns a band-pyramid recipe into a PBR texture set.
 *
 * Three things happen here that did not happen in pass 2, each one aimed at a
 * specific forensic tell:
 *
 *  1. BAND PYRAMID SYNTHESIS. Each band is evaluated on its own grid (S/16,
 *     S/4, S) and upsampled with a C1 filter. Expensive Worley/crack work runs
 *     on 4k-65k samples instead of a megapixel, so the library carries far more
 *     information *and bakes faster* than pass 2 did.
 *
 *  2. UNIVERSAL WEAR. §5 and the material-and-detail lens both flagged that
 *     "there is no edge wear, no dirt accumulation in crevices and no
 *     sun-bleaching on up-facing planes on any material in any of the ten
 *     shots". A two-radius cavity/convexity solve over the finished height
 *     field drives grime into every crevice, chips and bleaches every convex
 *     arris, and pushes roughness the right way on both — once, for all 35
 *     surfaces, from data the recipe already produced.
 *
 *  3. COVERAGE-PRESERVING ALPHA MIPS. forest_interior showed "dense black
 *     speckle holes and dark fringing scattered through the canopy — classic
 *     alpha-clip with mipmapped alpha plus a non-premultiplied leaf texture".
 *     `buildAlphaMips` filters RGB *premultiplied* (so background black cannot
 *     bleed into the fringe) and then rescales each level's alpha so the
 *     fraction of texels passing `alphaTest` matches level 0 — foliage keeps
 *     its coverage with distance instead of dissolving into pepper.
 */

/* --------------------------------------------------------------- scratch */
/* Reused across surfaces so 35 recipes do not each allocate 20 MB. */
const SCRATCH = new Map();
function scratch(key, n) {
  let a = SCRATCH.get(key);
  if (!a || a.length < n) { a = new Float32Array(n); SCRATCH.set(key, a); }
  return a;
}
export function releaseScratch() { SCRATCH.clear(); }

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

/* --------------------------------------------------------- band pyramid */

/**
 * Evaluate one band on an `res × res` grid, band-limited to that grid.
 */
function evalBand(fn, res) {
  const g = new Float32Array(res * res);
  setBandLimit(res, 3);
  const inv = 1 / res;
  for (let y = 0; y < res; y++) {
    const v = (y + 0.5) * inv;
    const row = y * res;
    for (let x = 0; x < res; x++) {
      g[row + x] = clamp01(fn((x + 0.5) * inv, v));
    }
  }
  return g;
}

/**
 * Tileable C1 upsample from `res` to `S`. Bilinear with a smootherstep weight,
 * which is exact enough for a field that is already band-limited to res/3 and
 * has none of the diamond creasing plain bilinear leaves behind.
 */
function upsample(src, res, dst, S) {
  if (res === S) { dst.set(src); return dst; }
  const scale = res / S;
  const ix0 = new Int32Array(S), ix1 = new Int32Array(S);
  const wx = new Float32Array(S);
  for (let x = 0; x < S; x++) {
    const f = (x + 0.5) * scale - 0.5;
    const i0 = Math.floor(f);
    ix0[x] = ((i0 % res) + res) % res;
    ix1[x] = ((i0 + 1) % res + res) % res;
    wx[x] = fade(f - i0);
  }
  for (let y = 0; y < S; y++) {
    const f = (y + 0.5) * scale - 0.5;
    const j0 = Math.floor(f);
    const r0 = (((j0 % res) + res) % res) * res;
    const r1 = ((((j0 + 1) % res) + res) % res) * res;
    const wy = fade(f - j0);
    const o = y * S;
    for (let x = 0; x < S; x++) {
      const a = src[r0 + ix0[x]], b = src[r0 + ix1[x]];
      const c = src[r1 + ix0[x]], d = src[r1 + ix1[x]];
      const t = wx[x];
      const top = a + (b - a) * t, bot = c + (d - c) * t;
      dst[o + x] = top + (bot - top) * wy;
    }
  }
  return dst;
}

/* Separable wrapping box blur with a sliding sum — O(1) per texel in radius. */
function boxBlur(src, dst, tmp, S, r) {
  const n = 2 * r + 1, inv = 1 / n;
  for (let y = 0; y < S; y++) {
    const o = y * S;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[o + ((k % S) + S) % S];
    for (let x = 0; x < S; x++) {
      tmp[o + x] = sum * inv;
      sum -= src[o + ((x - r) % S + S) % S];
      sum += src[o + ((x + r + 1) % S + S) % S];
    }
  }
  for (let x = 0; x < S; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[(((k % S) + S) % S) * S + x];
    for (let y = 0; y < S; y++) {
      dst[y * S + x] = sum * inv;
      sum -= tmp[((((y - r) % S) + S) % S) * S + x];
      sum += tmp[((((y + r + 1) % S) + S) % S) * S + x];
    }
  }
  return dst;
}

/* ---------------------------------------------------------------- normal */

/**
 * Sobel a height field into a tangent-space normal map.
 * `strength` is scaled by S so a surface has the same relief at every quality
 * preset — pass 2's constant made `low` four times flatter than `ultra`.
 */
/**
 * Sobel a height field into tangent-space normal BYTES. Split out of
 * `heightToNormal` so the bake worker (which has no THREE.Texture to create)
 * can do this on a background thread with the rest of the surface.
 */
export function heightToNormalData(height, S, strength) {
  const data = new Uint8Array(S * S * 4);
  const k = strength * (S / 1024);
  for (let y = 0; y < S; y++) {
    const ym = ((y - 1 + S) % S) * S, yp = ((y + 1) % S) * S, y0 = y * S;
    for (let x = 0; x < S; x++) {
      const xm = (x - 1 + S) % S, xp = (x + 1) % S;
      /* Sobel rather than a 2-tap central difference: the diagonal taps stop
         micro detail from resolving into an axis-aligned cross-hatch. */
      const dx = ((height[ym + xp] + 2 * height[y0 + xp] + height[yp + xp])
        - (height[ym + xm] + 2 * height[y0 + xm] + height[yp + xm])) * 0.25 * k;
      const dy = ((height[yp + xm] + 2 * height[yp + x] + height[yp + xp])
        - (height[ym + xm] + 2 * height[ym + x] + height[ym + xp])) * 0.25 * k;
      let nx = -dx, ny = -dy;
      const l = Math.sqrt(nx * nx + ny * ny + 1);
      const i = (y0 + x) * 4;
      data[i] = (nx / l * 0.5 + 0.5) * 255;
      data[i + 1] = (ny / l * 0.5 + 0.5) * 255;
      data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  return data;
}

/** Wrap normal bytes (from `heightToNormalData`) in a linear DataTexture. */
export function normalTextureFrom(data, S, aniso) {
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export function heightToNormal(height, S, strength, aniso) {
  return normalTextureFrom(heightToNormalData(height, S, strength), S, aniso);
}

/* ------------------------------------------------------------- alpha mips */

/**
 * Premultiply-aware, coverage-preserving mip chain for alpha-tested textures.
 *
 * Returns `[{ data, width, height }, ...]` starting at level 1 (level 0 stays
 * the source). Assign as `texture.mipmaps = [level0, ...levels]` with
 * `generateMipmaps = false`.
 *
 * Consumers MUST set `alphaTest` to the same value passed here and should set
 * `material.alphaToCoverage = true` when MSAA is available.
 */
export function buildAlphaMips(rgba, S, alphaTest = 0.4) {
  const levels = [{ data: rgba, width: S, height: S }];
  /* reference coverage at level 0 */
  let covered = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] / 255 >= alphaTest) covered++;
  const refCov = covered / (S * S);

  let src = rgba, w = S;
  while (w > 1) {
    const h = w >> 1;
    const dst = new Uint8Array(h * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let j = 0; j < 2; j++) {
          for (let i = 0; i < 2; i++) {
            const s = (((y * 2 + j) * w) + (x * 2 + i)) * 4;
            const av = src[s + 3];
            /* premultiplied accumulate: transparent black cannot darken the
               fringe, which is exactly the canopy speckle defect */
            r += src[s] * av; g += src[s + 1] * av; b += src[s + 2] * av;
            a += av;
          }
        }
        const d = (y * h + x) * 4;
        if (a > 0) {
          dst[d] = Math.min(255, r / a);
          dst[d + 1] = Math.min(255, g / a);
          dst[d + 2] = Math.min(255, b / a);
        }
        dst[d + 3] = a * 0.25;
      }
    }
    /* rescale alpha so the same fraction of texels still passes alphaTest */
    if (refCov > 0.001 && refCov < 0.999) {
      let lo = 0.15, hi = 6.0;
      for (let it = 0; it < 12; it++) {
        const s = (lo + hi) * 0.5;
        let c = 0;
        for (let i = 3; i < dst.length; i += 4) if (Math.min(1, dst[i] / 255 * s) >= alphaTest) c++;
        if (c / (h * h) < refCov) lo = s; else hi = s;
      }
      const s = (lo + hi) * 0.5;
      if (Math.abs(s - 1) > 0.02) {
        for (let i = 3; i < dst.length; i += 4) dst[i] = Math.min(255, dst[i] * s);
      }
    }
    levels.push({ data: dst, width: h, height: h });
    src = dst; w = h;
  }
  return levels;
}

/* ------------------------------------------------------------------ bake */

const DEF_WEAR = {
  cavity: 0.55, cavityCol: [58, 50, 40],
  edge: 0.40, edgeCol: [206, 196, 176],
  cavRough: 0.06, edgeRough: -0.06,
};

/**
 * Bake a recipe into { height, albedo, rough, ao, meta }.
 * All typed arrays are freshly allocated and owned by the caller.
 */
export function bakeSurface(recipe, S) {
  const bands = recipe.bands;
  const nb = bands.length;

  /* 1 — evaluate each band on its own grid, then upsample -------------- */
  const full = [];
  for (let k = 0; k < nb; k++) {
    const res = Math.max(8, Math.round(S / bands[k].div));
    const g = evalBand(bands[k].fn, res);
    const dst = scratch('b' + k, S * S);
    upsample(g, res, dst, S);
    full.push(dst);
  }
  let maskFull = null;
  if (recipe.mask) {
    const res = Math.max(8, Math.round(S / recipe.mask.div));
    const g = new Float32Array(res * res);
    setBandLimit(res, 3);
    const inv = 1 / res;
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) g[y * res + x] = recipe.mask.fn((x + 0.5) * inv, (y + 0.5) * inv);
    }
    maskFull = upsample(g, res, scratch('m', S * S), S);
  }
  setBandLimit(1e9);

  /* 2 — composite and histogram-stretch -------------------------------- */
  const N = S * S;
  const height = new Float32Array(N);
  let ampSum = 0;
  for (let k = 0; k < nb; k++) ampSum += bands[k].amp;
  const norm = 1 / (ampSum || 1);
  for (let i = 0; i < N; i++) {
    let h = 0;
    for (let k = 0; k < nb; k++) h += bands[k].amp * full[k][i];
    height[i] = h * norm;
  }
  const HIST = 512;
  const hist = new Uint32Array(HIST);
  for (let i = 0; i < N; i++) hist[Math.min(HIST - 1, (height[i] * HIST) | 0)]++;
  const want = N * 0.005;
  let acc = 0, lo = 0, hi = HIST - 1;
  for (let b = 0; b < HIST; b++) { acc += hist[b]; if (acc >= want) { lo = b; break; } }
  acc = 0;
  for (let b = HIST - 1; b >= 0; b--) { acc += hist[b]; if (acc >= want) { hi = b; break; } }
  const l0 = lo / HIST, span = Math.max(0.08, (hi + 1) / HIST - l0);
  for (let i = 0; i < N; i++) height[i] = clamp01((height[i] - l0) / span);

  /* 3 — cavity / convexity, two radii ---------------------------------- */
  const tmp = scratch('t0', N);
  const bFine = scratch('bf', N);
  const bCoarse = scratch('bc', N);
  boxBlur(height, bFine, tmp, S, Math.max(1, Math.round(S / 340)));
  boxBlur(height, bCoarse, tmp, S, Math.max(2, Math.round(S / 78)));

  /* 4 — sharpened height for the normal: the micro band must survive the
         derivative or the surface reads as smeary blur under magnification */
  const sharp = scratch('sh', N);
  for (let i = 0; i < N; i++) sharp[i] = height[i] + (height[i] - bFine[i]) * 0.85;

  /* 5 — albedo / roughness / AO ---------------------------------------- */
  const albedo = new Uint8Array(N * 4);
  const rough = new Uint8Array(N * 4);
  const ao = new Uint8Array(N * 4);
  const W = Object.assign({}, DEF_WEAR, recipe.wear || {});
  const r0 = recipe.rough[0], r1 = recipe.rough[1];
  const baseMetal = recipe.metal || 0;
  const s = { b0: 0, b1: 0, b2: 0, m: 0, cav: 0, cvx: 0 };
  const invS = 1 / S;

  for (let y = 0; y < S; y++) {
    const v = (y + 0.5) * invS;
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const h = height[i];
      const cavF = clamp01((bFine[i] - h) * 4.2);
      const cavC = clamp01((bCoarse[i] - h) * 2.6);
      const cav = clamp01(cavF * 0.5 + cavC * 0.72);
      const cvx = clamp01((h - bCoarse[i]) * 2.6);

      s.b0 = full[0][i]; s.b1 = nb > 1 ? full[1][i] : 0; s.b2 = nb > 2 ? full[2][i] : 0;
      s.m = maskFull ? maskFull[i] : 0;
      s.cav = cav; s.cvx = cvx;

      const c = recipe.albedo(h, (x + 0.5) * invS, v, s);
      let cr = c[0], cg = c[1], cb = c[2];

      /* dirt accumulates in every crevice */
      const dk = cav * W.cavity;
      cr += (W.cavityCol[0] - cr) * dk;
      cg += (W.cavityCol[1] - cg) * dk;
      cb += (W.cavityCol[2] - cb) * dk;

      /* paint and patina chip off convex arrises; the exposure bleaches them */
      const ek = smoothstep(0.12, 0.85, cvx) * W.edge;
      cr += (W.edgeCol[0] - cr) * ek;
      cg += (W.edgeCol[1] - cg) * ek;
      cb += (W.edgeCol[2] - cb) * ek;

      const j = i * 4;
      albedo[j] = cr < 0 ? 0 : (cr > 255 ? 255 : cr);
      albedo[j + 1] = cg < 0 ? 0 : (cg > 255 ? 255 : cg);
      albedo[j + 2] = cb < 0 ? 0 : (cb > 255 ? 255 : cb);
      albedo[j + 3] = 255;

      let rv = r0 + (r1 - r0) * (1 - h) + cav * W.cavRough + cvx * W.edgeRough;
      rv = rv < 0.03 ? 0.03 : (rv > 1 ? 1 : rv);
      const mv = recipe.metalMask ? baseMetal * clamp01(recipe.metalMask(s)) : baseMetal;
      rough[j] = rough[j + 1] = rough[j + 2] = rv * 255;
      rough[j + 3] = 255;
      /* the roughness map's blue channel doubles as a metalness map for
         consumers that bind it as metalnessMap (three reads .b) */
      rough[j + 2] = mv * 255;

      /* AO: multi-radius cavity, floored so nothing goes black on its own */
      const occ = 1 - (cavF * 0.34 + cavC * 0.62) * 0.92;
      const ov = (occ < 0.22 ? 0.22 : occ) * 255;
      ao[j] = ao[j + 1] = ao[j + 2] = ov;
      ao[j + 3] = 255;
    }
  }

  return { height: sharp, raw: height, albedo, rough, ao };
}
