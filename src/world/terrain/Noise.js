/**
 * Fast deterministic gradient noise + fractal helpers for terrain synthesis.
 * No Math.random anywhere — everything is derived from an integer hash seeded
 * from ctx.seed, so the world is byte-identical on every boot.
 */

/* 16 unit gradients — enough directions to kill the axis-aligned look. */
const GX = new Float32Array(16);
const GY = new Float32Array(16);
for (let i = 0; i < 16; i++) {
  const a = ((i + 0.5) / 16) * Math.PI * 2;
  GX[i] = Math.cos(a);
  GY[i] = Math.sin(a);
}

let SEED = 0x9e3779b9;

export function setNoiseSeed(s) {
  SEED = s >>> 0;
}

/** 32-bit integer hash → 0..15 gradient index. */
function hidx(i, j) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ SEED;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  h = Math.imul(h, 0x85ebca6b);
  return (h >>> 28) & 15;
}

/** Perlin-style gradient noise, roughly -1..1. */
export function noise2(x, y) {
  const X = Math.floor(x), Y = Math.floor(y);
  const fx = x - X, fy = y - Y;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);

  const g00 = hidx(X, Y), g10 = hidx(X + 1, Y);
  const g01 = hidx(X, Y + 1), g11 = hidx(X + 1, Y + 1);

  const n00 = GX[g00] * fx + GY[g00] * fy;
  const n10 = GX[g10] * (fx - 1) + GY[g10] * fy;
  const n01 = GX[g01] * fx + GY[g01] * (fy - 1);
  const n11 = GX[g11] * (fx - 1) + GY[g11] * (fy - 1);

  const a = n00 + u * (n10 - n00);
  const b = n01 + u * (n11 - n01);
  return (a + v * (b - a)) * 1.41;
}

/** Tileable variant — lattice coordinates wrap on `period`. */
export function noise2p(x, y, period) {
  const X = Math.floor(x), Y = Math.floor(y);
  const fx = x - X, fy = y - Y;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const X0 = ((X % period) + period) % period, Y0 = ((Y % period) + period) % period;
  const X1 = (X0 + 1) % period, Y1 = (Y0 + 1) % period;

  const g00 = hidx(X0, Y0), g10 = hidx(X1, Y0);
  const g01 = hidx(X0, Y1), g11 = hidx(X1, Y1);

  const n00 = GX[g00] * fx + GY[g00] * fy;
  const n10 = GX[g10] * (fx - 1) + GY[g10] * fy;
  const n01 = GX[g01] * fx + GY[g01] * (fy - 1);
  const n11 = GX[g11] * (fx - 1) + GY[g11] * (fy - 1);

  const a = n00 + u * (n10 - n00);
  const b = n01 + u * (n11 - n01);
  return (a + v * (b - a)) * 1.41;
}

/** Tileable fBm in 0..1. */
export function fbmTile(x, y, oct, period) {
  let sum = 0, amp = 1, f = 1, p = period, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * noise2p(x * f, y * f, p);
    norm += amp; amp *= 0.5; f *= 2; p *= 2;
  }
  return sum / norm * 0.5 + 0.5;
}

/** Classic fBm, output ~ -1..1. */
export function fbm(x, y, oct, freq, gain = 0.5, lac = 2.02) {
  let sum = 0, amp = 1, f = freq, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * noise2(x * f, y * f);
    norm += amp;
    amp *= gain;
    f *= lac;
  }
  return sum / norm;
}

/** fBm mapped to 0..1. */
export function fbm01(x, y, oct, freq, gain = 0.5, lac = 2.02) {
  return fbm(x, y, oct, freq, gain, lac) * 0.5 + 0.5;
}

/**
 * Ridged multifractal — the workhorse for mountain ranges. Sharp crests,
 * self-similar spurs, weighted so higher octaves only bite near existing ridges
 * (which is what gives real ranges their branching spur structure). 0..1.
 */
export function ridged(x, y, oct, freq, gain = 0.5, lac = 2.07, sharp = 1.0) {
  let sum = 0, amp = 1, f = freq, w = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(noise2(x * f, y * f));
    n *= n;
    if (sharp !== 1.0) n = Math.pow(n, sharp);
    n *= w;
    w = n * 2.4;
    if (w > 1) w = 1;
    sum += n * amp;
    norm += amp;
    amp *= gain;
    f *= lac;
  }
  return sum / norm;
}

/** Billowy fBm — rounded hills and dunes. 0..1. */
export function billow(x, y, oct, freq, gain = 0.5, lac = 2.03) {
  let sum = 0, amp = 1, f = freq, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * Math.abs(noise2(x * f, y * f));
    norm += amp;
    amp *= gain;
    f *= lac;
  }
  return sum / norm;
}

/* ------------------------------------------------------------- small utils */

export function smoothstep(a, b, x) {
  if (a === b) return x < a ? 0 : 1;
  let t = (x - a) / (b - a);
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}

export function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
export function mix(a, b, t) { return a + (b - a) * t; }

/**
 * Terracing with a soft tread and a sharp riser — the shape that reads as
 * sedimentary strata / mesa caprock. Returns { h, riser } where riser is 0 on
 * the flat tread and 1 mid-cliff (used to drive erosion hardness).
 */
export function terrace(v, steps, tread) {
  const s = v * steps;
  const f = Math.floor(s);
  const r = s - f;
  const k = smoothstep(tread, 1.0, r);
  return { h: (f + k) / steps, riser: smoothstep(tread - 0.06, tread + 0.10, r) };
}

/** Distance from p to a polyline; also returns the normalised arc position. */
export function polylineDist(px, pz, pts, cum, total) {
  let best = Infinity, bestT = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], az = pts[i][1];
    const bx = pts[i + 1][0], bz = pts[i + 1][1];
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = ax + dx * t, cz = az + dz * t;
    const d = Math.hypot(px - cx, pz - cz);
    if (d < best) {
      best = d;
      bestT = (cum[i] + Math.sqrt(len2) * t) / total;
    }
  }
  return { d: best, t: bestT };
}

export function polylineMetrics(pts) {
  const cum = new Float64Array(pts.length);
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    cum[i] = total;
    total += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  }
  cum[pts.length - 1] = total;
  return { cum, total };
}
