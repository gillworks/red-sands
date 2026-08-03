/**
 * Physical erosion on the heightfield.
 *
 *  1. Hydraulic droplet simulation (Beyer / Mei style) with inertia, sediment
 *     capacity, erosion + deposition and evaporation. This is what produces
 *     dendritic drainage, V-notched headwaters, U-floored lowland valleys and
 *     alluvial fans where the gradient collapses at the foot of a range.
 *  2. Thermal (talus) erosion — anything steeper than the material's angle of
 *     repose slumps downhill into scree.
 *
 * Both honour a per-cell `hardness` field so caprock survives and soft risers
 * retreat, which is exactly how a butte forms.
 */

const DEFAULTS = {
  droplets: 320000,
  maxSteps: 58,
  inertia: 0.055,
  capacity: 3.4,
  minSlope: 0.014,
  erode: 0.36,
  deposit: 0.30,
  evaporate: 0.0165,
  gravity: 11.0,
  radius: 3,
  initialWater: 1.0,
  initialSpeed: 1.0,
};

/** Precompute a soft circular brush so erosion isn't a single-texel spike. */
function makeBrush(res, radius) {
  const offs = [];
  const wts = [];
  let sum = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > radius * radius) continue;
      const w = 1 - Math.sqrt(d2) / radius;
      offs.push(dy * res + dx);
      wts.push(w);
      sum += w;
    }
  }
  const W = new Float32Array(wts.length);
  for (let i = 0; i < wts.length; i++) W[i] = wts[i] / sum;
  return { offs: new Int32Array(offs), wts: W };
}

/**
 * @param h       Float32Array(res*res) heights, modified in place
 * @param hard    Float32Array(res*res) 0..1 resistance
 * @param flow    Float32Array(res*res) accumulator for droplet traffic
 * @param rand    () => 0..1 deterministic PRNG
 */
export function hydraulicErode(h, hard, flow, res, rand, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const brush = makeBrush(res, o.radius);
  const bo = brush.offs, bw = brush.wts, bn = bo.length;
  const edge = o.radius + 2;
  const span = res - edge * 2;

  for (let d = 0; d < o.droplets; d++) {
    let px = edge + rand() * span;
    let py = edge + rand() * span;
    let dx = 0, dy = 0;
    let speed = o.initialSpeed;
    let water = o.initialWater;
    let sediment = 0;

    for (let step = 0; step < o.maxSteps; step++) {
      const nx = px | 0, ny = py | 0;
      const i = ny * res + nx;
      const fx = px - nx, fy = py - ny;

      const h00 = h[i], h10 = h[i + 1], h01 = h[i + res], h11 = h[i + res + 1];

      /* bilinear height + analytic gradient */
      const gx = (h10 - h00) * (1 - fy) + (h11 - h01) * fy;
      const gy = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
      const hOld = (h00 * (1 - fx) + h10 * fx) * (1 - fy)
                 + (h01 * (1 - fx) + h11 * fx) * fy;

      dx = dx * o.inertia - gx * (1 - o.inertia);
      dy = dy * o.inertia - gy * (1 - o.inertia);
      const dl = Math.hypot(dx, dy);
      if (dl < 1e-6) break;
      dx /= dl; dy /= dl;

      px += dx;
      py += dy;
      if (px < edge || px >= res - edge || py < edge || py >= res - edge) break;

      const mx = px | 0, my = py | 0;
      const mi = my * res + mx;
      const mfx = px - mx, mfy = py - my;
      const m00 = h[mi], m10 = h[mi + 1], m01 = h[mi + res], m11 = h[mi + res + 1];
      const hNew = (m00 * (1 - mfx) + m10 * mfx) * (1 - mfy)
                 + (m01 * (1 - mfx) + m11 * mfx) * mfy;
      const dh = hNew - hOld;

      /* Droplet traffic → flow accumulation seed (also used for wetness). */
      flow[mi] += water;

      const cap = Math.max(-dh, o.minSlope) * speed * water * o.capacity;

      if (sediment > cap || dh > 0) {
        /* Deposit: fill the pit we just walked into, or drop the excess. */
        const amount = dh > 0 ? Math.min(dh, sediment) : (sediment - cap) * o.deposit;
        sediment -= amount;
        /* bilinear deposit at the previous cell */
        h[i] += amount * (1 - fx) * (1 - fy);
        h[i + 1] += amount * fx * (1 - fy);
        h[i + res] += amount * (1 - fx) * fy;
        h[i + res + 1] += amount * fx * fy;
      } else {
        const amount = Math.min((cap - sediment) * o.erode, -dh);
        let taken = 0;
        for (let b = 0; b < bn; b++) {
          const bi = i + bo[b];
          const dep = amount * bw[b] * (1.05 - hard[bi]);
          h[bi] -= dep;
          taken += dep;
        }
        sediment += taken;
      }

      const sq = speed * speed - dh * o.gravity;
      speed = sq > 0 ? Math.sqrt(sq) : 0.05;
      water *= (1 - o.evaporate);
      if (water < 0.012) break;
    }
  }
}

/**
 * Thermal / talus erosion. Slopes above the angle of repose collapse; the
 * material lands at the foot as scree. `talus` is the max stable height
 * difference between neighbouring cells (metres per cell).
 */
export function thermalErode(h, hard, res, iterations, talusBase, cellSize) {
  const delta = new Float32Array(h.length);
  const nb = [-1, 1, -res, res, -res - 1, -res + 1, res - 1, res + 1];
  const nd = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

  for (let it = 0; it < iterations; it++) {
    delta.fill(0);
    for (let y = 1; y < res - 1; y++) {
      for (let x = 1; x < res - 1; x++) {
        const i = y * res + x;
        const hi = h[i];
        /* Angle of repose by material. The quadratic in hardness is what lets
           caprock hold a near-vertical face while the soft shale under it
           slumps to a 20-degree apron — i.e. what actually makes a butte. */
        const hd = hard[i];
        const talus = talusBase * (0.30 + hd * hd * 3.4) * cellSize;
        let total = 0;
        let lowest = 0;
        for (let k = 0; k < 8; k++) {
          const d = (hi - h[i + nb[k]]) / nd[k] - talus;
          if (d > 0) { total += d; if (d > lowest) lowest = d; }
        }
        if (total <= 0) continue;
        const move = Math.min(lowest * 0.5, total * 0.5) * 0.45;
        delta[i] -= move;
        const inv = move / total;
        for (let k = 0; k < 8; k++) {
          const d = (hi - h[i + nb[k]]) / nd[k] - talus;
          if (d > 0) delta[i + nb[k]] += d * inv;
        }
      }
    }
    for (let i = 0; i < h.length; i++) h[i] += delta[i];
  }
}

/** Small separable blur used to relax noise without losing the drainage net. */
export function blurField(src, res, radius, strength = 1) {
  const tmp = new Float32Array(src.length);
  const w = radius * 2 + 1;
  for (let y = 0; y < res; y++) {
    let acc = 0;
    for (let x = -radius; x <= radius; x++) acc += src[y * res + Math.min(res - 1, Math.max(0, x))];
    for (let x = 0; x < res; x++) {
      tmp[y * res + x] = acc / w;
      const add = Math.min(res - 1, x + radius + 1);
      const sub = Math.max(0, x - radius);
      acc += src[y * res + add] - src[y * res + sub];
    }
  }
  const out = new Float32Array(src.length);
  for (let x = 0; x < res; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += tmp[Math.min(res - 1, Math.max(0, y)) * res + x];
    for (let y = 0; y < res; y++) {
      out[y * res + x] = acc / w;
      const add = Math.min(res - 1, y + radius + 1);
      const sub = Math.max(0, y - radius);
      acc += tmp[add * res + x] - tmp[sub * res + x];
    }
  }
  if (strength >= 1) return out;
  for (let i = 0; i < src.length; i++) out[i] = src[i] + (out[i] - src[i]) * strength;
  return out;
}
