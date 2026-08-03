/**
 * Deterministic integer-hash noise for the scatter system.
 *
 * Everything here is a pure function of (coordinate, seed) — no state, no
 * Math.random — so a given world seed always produces the same rocks in the
 * same holes no matter what order tiles are visited in, which is what makes
 * the screenshots reproducible frame for frame.
 */

const INV_U32 = 1 / 4294967296;

/** 1D → uint32 avalanche (Wang/Murmur style finaliser). */
export function hashU(n) {
  n = n | 0;
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return (n ^ (n >>> 16)) >>> 0;
}

export function hash2(x, y, seed = 0) {
  return hashU((Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + (seed | 0)) | 0);
}

export function hash3(x, y, z, seed = 0) {
  return hashU((Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)
    + Math.imul(z | 0, 2147483629) + (seed | 0)) | 0);
}

/** 0..1 */
export function rand2(x, y, seed = 0) { return hash2(x, y, seed) * INV_U32; }
export function rand3(x, y, z, seed = 0) { return hash3(x, y, z, seed) * INV_U32; }

/**
 * A tiny deterministic stream PRNG seeded from a hash. Used per placed
 * instance so the number of random draws per instance can change without
 * shifting every other instance in the world.
 */
export function streamRng(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a = (Math.imul(a ^ (a >>> 15), 0x2c1b3c6d) ^ 0x9e3779b9) >>> 0;
    a = Math.imul(a ^ (a >>> 12), 0x297a2d39) >>> 0;
    return ((a ^ (a >>> 15)) >>> 0) * INV_U32;
  };
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

/** Smooth value noise, ~[-1,1]. */
export function noise2(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fade(fx), uy = fade(fy);
  const a = rand2(ix, iy, seed);
  const b = rand2(ix + 1, iy, seed);
  const c = rand2(ix, iy + 1, seed);
  const d = rand2(ix + 1, iy + 1, seed);
  const top = a + (b - a) * ux;
  const bot = c + (d - c) * ux;
  return (top + (bot - top) * uy) * 2 - 1;
}

export function noise3(x, y, z, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fade(fx), uy = fade(fy), uz = fade(fz);
  const c000 = rand3(ix, iy, iz, seed), c100 = rand3(ix + 1, iy, iz, seed);
  const c010 = rand3(ix, iy + 1, iz, seed), c110 = rand3(ix + 1, iy + 1, iz, seed);
  const c001 = rand3(ix, iy, iz + 1, seed), c101 = rand3(ix + 1, iy, iz + 1, seed);
  const c011 = rand3(ix, iy + 1, iz + 1, seed), c111 = rand3(ix + 1, iy + 1, iz + 1, seed);
  const x00 = c000 + (c100 - c000) * ux;
  const x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux;
  const x11 = c011 + (c111 - c011) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return (y0 + (y1 - y0) * uz) * 2 - 1;
}

/** fBm in roughly [-1,1]. */
export function fbm2(x, y, octaves = 4, seed = 0, lacunarity = 2.03, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * f, y * f, seed + i * 7919) * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

export function fbm3(x, y, z, octaves = 4, seed = 0, lacunarity = 2.07, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise3(x * f, y * f, z * f, seed + i * 7919) * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/** Ridged fBm in [0,1] — sharp creases, good for rock fracture planes. */
export function ridged3(x, y, z, octaves = 3, seed = 0) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise3(x * f, y * f, z * f, seed + i * 4483));
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.11;
  }
  return sum / norm;
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Remap a uniform 0..1 to a heavy-tailed size distribution over [lo,hi]. */
export function sizeDist(u, lo, hi, power = 3.2) {
  return lo * Math.pow(hi / lo, Math.pow(u, power));
}
