/**
 * Noise.js — the CPU noise kit behind every procedural surface.
 *
 * Pass 2's library had exactly one usable primitive (a gain-0.5 Perlin fBm) and
 * that is *why* every surface read as a smeary low-frequency blur under a hero
 * close-up: with gain 0.5 the sixth octave carries 3% of the amplitude, so the
 * millimetre band is mathematically present and visually absent. Everything
 * here exists to populate the two bands the forensics said were missing —
 * decimetre (cracks, plates, seams, pebbles, mortar) and millimetre (grain,
 * pores, fibre, chipping).
 *
 * Everything is tileable over the unit square and deterministic: no
 * Math.random(), integer-lattice hashing only.
 */

/* ------------------------------------------------------------------ hashes */

/** 32-bit integer lattice hash. ~4x faster than a PERM table chase. */
export function hashInt(x, y, seed) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
/** Integer lattice hash → 0..1. */
export function hash2(x, y, seed = 0) { return hashInt(x, y, seed) / 4294967296; }
/** 1-D hash → 0..1. */
export function hash1(i, seed = 0) { return hashInt(i, 0x9e37, seed) / 4294967296; }

export function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}
export function lerp(a, b, t) { return a + (b - a) * t; }
export function mix3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function wrapi(i, p) { return p > 0 ? ((i % p) + p) % p : i; }

/* --------------------------------------------------------------- gradients */

const GX = new Float32Array(16), GY = new Float32Array(16);
for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; GX[i] = Math.cos(a); GY[i] = Math.sin(a); }

/** Perlin gradient noise in -1..1, tileable over `period` lattice cells. */
export function perlin2(x, y, period = 0, seed = 0) {
  const X = Math.floor(x), Y = Math.floor(y);
  const fx = x - X, fy = y - Y;
  const x0 = wrapi(X, period), x1 = wrapi(X + 1, period);
  const y0 = wrapi(Y, period), y1 = wrapi(Y + 1, period);
  const u = fade(fx), v = fade(fy);
  const g00 = hashInt(x0, y0, seed) & 15, g10 = hashInt(x1, y0, seed) & 15;
  const g01 = hashInt(x0, y1, seed) & 15, g11 = hashInt(x1, y1, seed) & 15;
  const n00 = GX[g00] * fx + GY[g00] * fy;
  const n10 = GX[g10] * (fx - 1) + GY[g10] * fy;
  const n01 = GX[g01] * fx + GY[g01] * (fy - 1);
  const n11 = GX[g11] * (fx - 1) + GY[g11] * (fy - 1);
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 1.4;
}

/** Smooth value noise in 0..1, tileable over `period` lattice cells. Cheap. */
export function vnoise(x, y, period = 0, seed = 0) {
  const X = Math.floor(x), Y = Math.floor(y);
  const fx = x - X, fy = y - Y;
  const x0 = wrapi(X, period), x1 = wrapi(X + 1, period);
  const y0 = wrapi(Y, period), y1 = wrapi(Y + 1, period);
  const u = fade(fx), v = fade(fy);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/* -------------------------------------------------------------------- fBm */

/**
 * Nyquist guard. Any octave finer than ~3 texels is white noise once
 * rasterised: it dithers in the near field and mips to flat grey. Bake sets
 * this per band from that band's own resolution.
 */
let MAX_CYCLES = 1e9;
export function setBandLimit(sizePx, texelsPerCycle = 3) {
  MAX_CYCLES = Math.max(2, sizePx / texelsPerCycle);
}
export function getBandLimit() { return MAX_CYCLES; }

/**
 * Tileable fBm. `gain` defaults to 0.5 for backwards compatibility but every
 * recipe in this library runs 0.6-0.72 so the fine octaves survive.
 */
export function fbm(x, y, o = {}) {
  const octaves = o.octaves === undefined ? 5 : o.octaves;
  const gain = o.gain === undefined ? 0.5 : o.gain;
  const lac = o.lacunarity === undefined ? 2 : o.lacunarity;
  const seed = o.seed === undefined ? 0 : o.seed;
  let f = o.freq === undefined ? 4 : o.freq;
  let per = o.period === undefined ? f : o.period;
  let a = 0, amp = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    if (f > MAX_CYCLES && i > 0) break;
    a += amp * perlin2(x * f, y * f, per, seed + i * 131);
    norm += amp; amp *= gain; f *= lac; per = Math.round(per * lac);
  }
  return a / (norm || 1) * 0.5 + 0.5;
}

/** Value-noise fBm — half the cost of `fbm`, used for the micro bands. */
export function vfbm(x, y, o = {}) {
  const octaves = o.octaves === undefined ? 3 : o.octaves;
  const gain = o.gain === undefined ? 0.55 : o.gain;
  const seed = o.seed === undefined ? 0 : o.seed;
  let f = o.freq === undefined ? 8 : o.freq;
  let per = o.period === undefined ? f : o.period;
  let a = 0, amp = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    if (f > MAX_CYCLES && i > 0) break;
    a += amp * vnoise(x * f, y * f, per, seed + i * 977);
    norm += amp; amp *= gain; f *= 2; per *= 2;
  }
  return a / (norm || 1);
}

/** Ridged multifractal in 0..1 — sharp creases, for furrows and fissures. */
export function ridged(x, y, o = {}) {
  const octaves = o.octaves === undefined ? 4 : o.octaves;
  const gain = o.gain === undefined ? 0.55 : o.gain;
  const seed = o.seed === undefined ? 0 : o.seed;
  const sharp = o.sharp === undefined ? 1.0 : o.sharp;
  let f = o.freq === undefined ? 4 : o.freq;
  let per = o.period === undefined ? f : o.period;
  let a = 0, amp = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    if (f > MAX_CYCLES && i > 0) break;
    let n = 1 - Math.abs(perlin2(x * f, y * f, per, seed + i * 313));
    n = Math.pow(n < 0 ? 0 : n, sharp);
    a += amp * n; norm += amp; amp *= gain; f *= 2; per *= 2;
  }
  return a / (norm || 1);
}

/** Tileable domain warp. `freq` must be an integer for the tile to close. */
export function warp(x, y, freq, amount, seed = 0, out = [0, 0]) {
  const f = Math.max(1, Math.round(freq));
  out[0] = x + (vnoise(x * f, y * f, f, seed) - 0.5) * amount;
  out[1] = y + (vnoise(x * f + 5.13, y * f - 2.71, f, seed + 5501) - 0.5) * amount;
  return out;
}

/* ---------------------------------------------------------------- cellular */

/*
 * Result pools. These samplers return an object rather than allocating one per
 * call (a bake is 10^6 calls), but a SINGLE shared instance silently aliases
 * whenever a recipe holds two results live — `const a = worley(...), b =
 * worley(...)` would make a and b the same object. That bug ate every bed joint
 * in the masonry recipes. A small ring covers any realistic nesting depth.
 */
const _WPOOL = [];
for (let i = 0; i < 8; i++) _WPOOL.push({ f1: 0, f2: 0, id: 0 });
let _wi = 0;
const nextW = () => _WPOOL[_wi = (_wi + 1) & 7];
/**
 * Tileable Worley. Returns F1/F2 normalised to cell size, plus a per-cell id in
 * 0..1 so recipes can give every fragment, plate, brick or pebble its own tone.
 * Squared-distance compare + one sqrt; no Math.hypot (which is ~8x slower).
 */
export function worley(x, y, cells, seed = 7) {
  const C = cells | 0;
  let f1 = 9e9, f2 = 9e9, id = 0;
  const cx = Math.floor(x * C), cy = Math.floor(y * C);
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j;
      const h = hashInt(wrapi(gx, C), wrapi(gy, C), seed);
      const px = (gx + 0.06 + (h & 2047) / 2047 * 0.88) / C;
      const py = (gy + 0.06 + ((h >>> 11) & 2047) / 2047 * 0.88) / C;
      const dx = x - px, dy = y - py;
      const d = dx * dx + dy * dy;
      if (d < f1) { f2 = f1; f1 = d; id = h; } else if (d < f2) f2 = d;
    }
  }
  const o = nextW();
  o.f1 = Math.min(1, Math.sqrt(f1) * C);
  o.f2 = Math.min(1, Math.sqrt(f2) * C);
  o.id = ((id >>> 22) & 1023) / 1023;
  return o;
}

/**
 * Anisotropic Worley — cells stretched by `ay` in v. Bark plates, plank
 * knots and shingle courses are all elongated, and stretching the *cells*
 * rather than the sample point keeps the jitter isotropic so the result never
 * reads as a comb.
 */
export function worleyA(x, y, cx_, cy_, seed = 7) {
  const CX = cx_ | 0, CY = cy_ | 0;
  let f1 = 9e9, f2 = 9e9, id = 0;
  const gx0 = Math.floor(x * CX), gy0 = Math.floor(y * CY);
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = gx0 + i, gy = gy0 + j;
      const h = hashInt(wrapi(gx, CX), wrapi(gy, CY), seed);
      const px = (gx + 0.06 + (h & 2047) / 2047 * 0.88) / CX;
      const py = (gy + 0.06 + ((h >>> 11) & 2047) / 2047 * 0.88) / CY;
      const dx = (x - px) * CX, dy = (y - py) * CY;
      const d = dx * dx + dy * dy;
      if (d < f1) { f2 = f1; f1 = d; id = h; } else if (d < f2) f2 = d;
    }
  }
  const o = nextW();
  o.f1 = Math.min(1, Math.sqrt(f1));
  o.f2 = Math.min(1, Math.sqrt(f2));
  o.id = ((id >>> 22) & 1023) / 1023;
  return o;
}

/**
 * Fractal crack network in 0..1 (1 = inside a crack).
 *
 * Cracks are the single most missing feature in pass 2's rock: the boulder had
 * one band of 30 cm lumps and nothing else. This stacks three generations of
 * Worley cell walls at 1x/2x/4x with decreasing width and weight and warps each
 * generation independently, so the network branches, terminates and varies in
 * width the way real fracture does instead of drawing a Voronoi diagram.
 */
export function cracks(x, y, o = {}) {
  const cells = o.cells === undefined ? 6 : o.cells;
  const seed = o.seed === undefined ? 3 : o.seed;
  const width = o.width === undefined ? 0.13 : o.width;
  const octaves = o.octaves === undefined ? 3 : o.octaves;
  const gain = o.gain === undefined ? 0.62 : o.gain;
  const warpF = o.warpFreq === undefined ? 3 : o.warpFreq;
  const warpA = o.warpAmt === undefined ? 0.055 : o.warpAmt;
  const p = [0, 0];
  let out = 0, amp = 1, c = cells, w = width;
  for (let i = 0; i < octaves; i++) {
    warp(x, y, warpF * (i + 1), warpA / (i + 1), seed + i * 71, p);
    const wl = worley(p[0], p[1], c, seed + i * 17);
    const d = wl.f2 - wl.f1;
    const v = amp * (1 - smoothstep(0, w, d));
    if (v > out) out = v;
    amp *= gain; c *= 2; w *= 0.72;
  }
  return out;
}

/**
 * Jittered 1-D partition: splits 0..1 into `n` cells of *unequal* width and
 * returns { t, id, edge } — position inside the cell, a per-cell random, and
 * distance to the nearest boundary. This is what stops planks, bricks, courses
 * and shingles from reading as a machine lattice.
 */
const _PPOOL = [];
for (let i = 0; i < 8; i++) _PPOOL.push({ t: 0, id: 0, edge: 0, index: 0, dist: 0, span: 0 });
let _pi = 0;
export function partition1(v, n, seed = 0, jitter = 0.34) {
  const N = n | 0;
  const at = (i) => {
    const k = wrapi(i, N);
    return (i + (hash1(k, seed) - 0.5) * jitter) / N;
  };
  const i0 = Math.floor(v * N);
  let lo = at(i0), hi = at(i0 + 1);
  let idx = i0;
  if (v < lo) { idx = i0 - 1; hi = lo; lo = at(i0 - 1); }
  else if (v >= hi) { idx = i0 + 1; lo = hi; hi = at(i0 + 2); }
  const span = Math.max(1e-5, hi - lo);
  const _P = _PPOOL[_pi = (_pi + 1) & 7];
  _P.t = (v - lo) / span;
  _P.id = hash1(wrapi(idx, N), seed + 991);
  _P.edge = Math.min(_P.t, 1 - _P.t) * span * N;
  /* absolute distance to the nearest boundary, in the input's own units — use
     this when the joint must be a fixed WIDTH regardless of cell size, or the
     bed joints of a wall come out thinner than the head joints. */
  _P.dist = Math.min(_P.t, 1 - _P.t) * span;
  _P.span = span;
  _P.index = wrapi(idx, N);
  return _P;
}

/** Sparse point field: 1 near a scattered point, 0 elsewhere. Pores, knots. */
export function spots(x, y, cells, seed, radius = 0.35, density = 0.5) {
  const w = worley(x, y, cells, seed);
  if (w.id > density) return 0;
  return 1 - smoothstep(radius * 0.35, radius, w.f1);
}

/** Band-limited white-ish grain in 0..1 at ~3 texels/cycle. */
export function grain(x, y, freq, seed = 0) {
  const f = Math.max(2, Math.round(freq));
  return vnoise(x * f, y * f, f, seed);
}
