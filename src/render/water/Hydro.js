/**
 * RED SANDS — water hydrology solve.
 *
 * The whole point of this file: the water surface is DERIVED from the terrain's
 * own erosion output, never stamped. Pass 1 laid horizontal planes at a global
 * `waterLevel`, which is what produced the white cut-outs lying on the sand in
 * high_noon_desert. Here instead:
 *
 *   1. priority-flood the eroded heightfield to find genuine closed basins —
 *      those become lakes, filled exactly to their spill elevation, so a lake
 *      surface is flat because the basin says so, not because we said so;
 *   2. threshold the flow-accumulation map Terrain already computed to find the
 *      channel network, and give each channel a stage (depth of water above the
 *      bed) that grows with the square-root-ish of upstream catchment area and
 *      deepens where the downstream gradient collapses — that is what makes
 *      pools at the bottom of a run;
 *   3. enforce that the water surface never rises going downstream;
 *   4. relax the surface along the network so a reach reads as one continuous
 *      sheet rather than a per-cell staircase;
 *   5. extrapolate the surface horizontally out of the water so the shoreline
 *      can be evaluated as a smooth signed depth field.
 *
 * The output that matters is `depth(x,z) = surface - terrain`, sampled by the
 * water shader (feathered shoreline, Beer-Lambert absorption, foam, caustics)
 * and by the terrain shader (wet-sand band). Because it is bilinear over the
 * SAME grid the terrain heightfield uses, the waterline is analytic and
 * sub-texel — there is no polygon edge to alias.
 */

const NB8X = [-1, 1, 0, 0, -1, 1, -1, 1];
const NB8Y = [0, 0, -1, 1, -1, -1, 1, 1];
const NBD = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

/* -------------------------------------------------------- binary min-heap */
class MinHeap {
  constructor(cap) {
    this.k = new Float32Array(cap);
    this.v = new Int32Array(cap);
    this.n = 0;
  }
  push(key, val) {
    let i = this.n++;
    const k = this.k, v = this.v;
    k[i] = key; v[i] = val;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      const tk = k[p]; k[p] = k[i]; k[i] = tk;
      const tv = v[p]; v[p] = v[i]; v[i] = tv;
      i = p;
    }
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    this.n--;
    if (this.n > 0) {
      k[0] = k[this.n]; v[0] = v[this.n];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.n && k[l] < k[m]) m = l;
        if (r < this.n && k[r] < k[m]) m = r;
        if (m === i) break;
        const tk = k[m]; k[m] = k[i]; k[i] = tk;
        const tv = v[m]; v[m] = v[i]; v[i] = tv;
        i = m;
      }
    }
    return top;
  }
}

/** Priority-flood fill (Barnes 2014). eps=0 gives perfectly level lakes. */
function priorityFlood(h, res, eps) {
  const N = res * res;
  const filled = new Float32Array(h);
  const closed = new Uint8Array(N);
  const heap = new MinHeap(N);
  for (let x = 0; x < res; x++) {
    for (let s = 0; s < 2; s++) {
      const y = s === 0 ? 0 : res - 1;
      const i = y * res + x;
      if (!closed[i]) { closed[i] = 1; heap.push(filled[i], i); }
    }
  }
  for (let y = 0; y < res; y++) {
    for (let s = 0; s < 2; s++) {
      const x = s === 0 ? 0 : res - 1;
      const i = y * res + x;
      if (!closed[i]) { closed[i] = 1; heap.push(filled[i], i); }
    }
  }
  while (heap.n > 0) {
    const c = heap.pop();
    const cy = (c / res) | 0, cx = c - cy * res;
    const hc = filled[c];
    for (let k = 0; k < 8; k++) {
      const nx = cx + NB8X[k], ny = cy + NB8Y[k];
      if (nx < 0 || ny < 0 || nx >= res || ny >= res) continue;
      const ni = ny * res + nx;
      if (closed[ni]) continue;
      closed[ni] = 1;
      const lift = hc + eps * NBD[k];
      if (filled[ni] < lift) filled[ni] = lift;
      heap.push(filled[ni], ni);
    }
  }
  return filled;
}

/* ------------------------------------------------------------- resampling */

function boxDown(src, srcRes, dstRes) {
  if (srcRes === dstRes) return Float32Array.from(src);
  const f = srcRes / dstRes;
  const out = new Float32Array(dstRes * dstRes);
  for (let y = 0; y < dstRes; y++) {
    const y0 = (y * f) | 0, y1 = Math.min(srcRes, ((y + 1) * f) | 0) || y0 + 1;
    for (let x = 0; x < dstRes; x++) {
      const x0 = (x * f) | 0, x1 = Math.min(srcRes, ((x + 1) * f) | 0) || x0 + 1;
      let s = 0, n = 0;
      for (let b = y0; b < y1; b++) for (let a = x0; a < x1; a++) { s += src[b * srcRes + a]; n++; }
      out[y * dstRes + x] = n ? s / n : src[y0 * srcRes + x0];
    }
  }
  return out;
}

function maxDown(src, srcRes, dstRes) {
  if (srcRes === dstRes) return Float32Array.from(src);
  const f = srcRes / dstRes;
  const out = new Float32Array(dstRes * dstRes);
  for (let y = 0; y < dstRes; y++) {
    const y0 = (y * f) | 0, y1 = Math.min(srcRes, ((y + 1) * f) | 0) || y0 + 1;
    for (let x = 0; x < dstRes; x++) {
      const x0 = (x * f) | 0, x1 = Math.min(srcRes, ((x + 1) * f) | 0) || x0 + 1;
      let m = -Infinity;
      for (let b = y0; b < y1; b++) for (let a = x0; a < x1; a++) { const v = src[b * srcRes + a]; if (v > m) m = v; }
      out[y * dstRes + x] = m;
    }
  }
  return out;
}

/** Bilinear upsample using the same texel-centre convention as the heightfield. */
function upsampleLinear(src, srcRes, dstRes) {
  const out = new Float32Array(dstRes * dstRes);
  const s = srcRes / dstRes;
  for (let y = 0; y < dstRes; y++) {
    let fy = y * s + (s - 1) * 0.5;
    if (fy < 0) fy = 0; else if (fy > srcRes - 1.001) fy = srcRes - 1.001;
    const y0 = fy | 0, ty = fy - y0, y1 = Math.min(srcRes - 1, y0 + 1);
    for (let x = 0; x < dstRes; x++) {
      let fx = x * s + (s - 1) * 0.5;
      if (fx < 0) fx = 0; else if (fx > srcRes - 1.001) fx = srcRes - 1.001;
      const x0 = fx | 0, tx = fx - x0, x1 = Math.min(srcRes - 1, x0 + 1);
      const a = src[y0 * srcRes + x0], b = src[y0 * srcRes + x1];
      const c = src[y1 * srcRes + x0], d = src[y1 * srcRes + x1];
      const t0 = a + (b - a) * tx;
      out[y * dstRes + x] = t0 + ((c + (d - c) * tx) - t0) * ty;
    }
  }
  return out;
}

/* =========================================================== the main solve */

/**
 * @param {object} o
 * @param {Float32Array} o.H     final heightfield, o.res² (the one getHeight uses)
 * @param {number} o.res
 * @param {number} o.size        world extent in metres
 * @param {Float32Array} o.flow  upstream catchment area per cell, m²
 * @param {number} o.flowRes
 * @param {number} o.waterLevel  base level for endorheic flats / playas
 * @param {number} o.sim         solve resolution (power of two, <= res)
 */
export function solveHydrology(o) {
  const {
    H, res, size, flow, flowRes, waterLevel = 18, sim = 1024,
    startArea = 1.1e5, fullArea = 2.6e6,
    minStage = 0.40, maxStage = 2.55,
    /** A basin needs at least this much upstream catchment to hold any water. */
    lakeMinInflow = 2.6e5,
    /** Lake surface area as a fraction of the catchment that feeds it. */
    lakeAreaRatio = 0.075,
    /** Hard ceiling on how far a basin may fill above its floor. */
    lakeMaxDepth = 11.0,
    /** Settlements are built on dry ground next to a CONFINED river. Any basin
     *  that would drown one is a basin that would never have been settled, and
     *  the reach beside it keeps a low stage. Without this the town shot can end
     *  up standing in two metres of lake. */
    keepDry = null,          // {x, z, radius}
  } = o;

  const S = sim;
  const N = S * S;
  const cell = size / S;

  const h = boxDown(H, res, S);
  const acc = maxDown(flow, flowRes, S);

  /* ---------------------------------------------------- 1. basins → lakes */
  const filled = priorityFlood(h, S, 0.0);
  const lakeDepth = new Float32Array(N);
  for (let i = 0; i < N; i++) lakeDepth[i] = filled[i] - h[i];

  /* --------------------------------------- 2. steepest descent on `filled` */
  const recv = new Int32Array(N).fill(-1);
  const grad = new Float32Array(N);
  const dirX = new Float32Array(N);
  const dirZ = new Float32Array(N);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const hi = filled[i];
      let best = 0, bi = -1, bx = 0, bz = 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + NB8X[k], ny = y + NB8Y[k];
        if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
        const ni = ny * S + nx;
        const s = (hi - filled[ni]) / (NBD[k] * cell);
        if (s > best) { best = s; bi = ni; bx = NB8X[k] / NBD[k]; bz = NB8Y[k] / NBD[k]; }
      }
      recv[i] = bi;
      grad[i] = best;
      dirX[i] = bx; dirZ[i] = bz;
    }
  }

  /* ------------------------------------------------ 3. channel stage (depth) */
  const l0 = Math.log(startArea), l1 = Math.log(fullArea);
  const stage = new Float32Array(N);
  const river = new Float32Array(N);        // 0..1 "how much of a river is this"
  for (let i = 0; i < N; i++) {
    const a = acc[i];
    if (a <= startArea) continue;
    let t = (Math.log(a) - l0) / (l1 - l0);
    if (t > 1) t = 1;
    river[i] = t;
    /* Pools: where the bed gradient collapses the water backs up and deepens.
       This is what puts still, dark, reflective water at the foot of a run. */
    const g = grad[i];
    const pool = 1 - Math.min(1, Math.max(0, (g - 0.0016) / 0.0140));
    stage[i] = (minStage + (maxStage - minStage) * Math.pow(t, 1.15)) * (1 + pool * 0.40);
  }
  /* Confine the reach that runs past a settlement: a town gets built at a ford,
     where the creek is shallow and in its channel, not on a floodplain. */
  const dryMask = keepDry ? new Uint8Array(N) : null;
  if (keepDry) {
    const R0 = keepDry.radius;
    const R1 = R0 * 1.9;
    const half = size * 0.5;
    for (let y = 0; y < S; y++) {
      const wz = -half + (y + 0.5) * cell;
      const dz = wz - keepDry.z;
      if (dz * dz > R1 * R1) continue;
      for (let x = 0; x < S; x++) {
        const wx = -half + (x + 0.5) * cell;
        const dx = wx - keepDry.x;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > R1) continue;
        const i = y * S + x;
        if (dist < R0) dryMask[i] = 1;
        const k = Math.min(1, Math.max(0, (dist - R0) / (R1 - R0)));
        const cap = 0.5 + (maxStage * 1.4 - 0.5) * k * k;
        if (stage[i] > cap) stage[i] = cap;
      }
    }
  }

  /* ------------------------------------------- 3b. which basins hold water
   * A closed basin is NOT automatically a lake. Priority-flood fills every
   * depression to its spill point, which in an eroded western range means 12%
   * of the map under sixty metres of water — endorheic basins in that climate
   * are dry playas, not reservoirs. So each basin gets a water balance: the
   * lake may only cover an area proportional to the catchment that feeds it,
   * and never more than a bounded depth. Basins with negligible inflow stay
   * dry, which is what leaves the cracked flats for high_noon_desert.
   */
  const basinLevel = new Float32Array(N).fill(-1e9);
  {
    const label = new Int32Array(N).fill(-1);
    const stack = new Int32Array(N);
    const cells = [];
    for (let seed = 0; seed < N; seed++) {
      if (label[seed] >= 0 || lakeDepth[seed] <= 0.02) continue;
      const id = 1;
      let sp = 0;
      stack[sp++] = seed;
      label[seed] = id;
      cells.length = 0;
      let floor = Infinity, spill = -Infinity, inflow = 0;
      while (sp > 0) {
        const c = stack[--sp];
        cells.push(c);
        if (h[c] < floor) floor = h[c];
        if (filled[c] > spill) spill = filled[c];
        if (acc[c] > inflow) inflow = acc[c];
        const y = (c / S) | 0, x = c - y * S;
        for (let k = 0; k < 8; k++) {
          const nx = x + NB8X[k], ny = y + NB8Y[k];
          if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
          const ni = ny * S + nx;
          if (label[ni] >= 0 || lakeDepth[ni] <= 0.02) continue;
          label[ni] = id;
          stack[sp++] = ni;
        }
      }
      if (inflow < lakeMinInflow) continue;
      if (keepDry) {
        let hitsSettlement = false;
        for (let j = 0; j < cells.length; j++) {
          const c = cells[j];
          const cy = (c / S) | 0, cx = c - cy * S;
          const wx = -size * 0.5 + (cx + 0.5) * cell;
          const wz = -size * 0.5 + (cy + 0.5) * cell;
          const dx = wx - keepDry.x, dz = wz - keepDry.z;
          if (dx * dx + dz * dz < keepDry.radius * keepDry.radius) { hitsSettlement = true; break; }
        }
        if (hitsSettlement) continue;
      }
      const cellArea = cell * cell;
      /* area the catchment can actually keep wet, in cells */
      const budget = Math.max(3, Math.floor(lakeAreaRatio * inflow / cellArea));
      let level;
      if (budget >= cells.length) {
        level = Math.min(spill, floor + lakeMaxDepth);
      } else {
        const hs = new Float64Array(cells.length);
        for (let j = 0; j < cells.length; j++) hs[j] = h[cells[j]];
        hs.sort();
        level = Math.min(spill, floor + lakeMaxDepth, hs[budget]);
      }
      for (let j = 0; j < cells.length; j++) {
        if (basinLevel[cells[j]] < level) basinLevel[cells[j]] = level;
      }
    }
  }

  /* --------------------------------------------------- 4. assemble surface */
  const NONE = -1e9;
  const surf = new Float32Array(N).fill(NONE);
  const wet = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    let s = NONE;
    if (river[i] > 0) s = h[i] + stage[i];
    if (basinLevel[i] > h[i] + 0.12) s = Math.max(s, basinLevel[i]);
    if (h[i] < waterLevel - 0.02) s = Math.max(s, waterLevel);
    if (s > NONE) { surf[i] = s; wet[i] = 1; }
  }

  /* ------------------- 4b. let each body find its own banks (bounded flood)
   * The channel mask is the thalweg, one or two cells wide. Real water spreads
   * sideways until the bed climbs above the stage, so grow the wet set into any
   * neighbour whose ground is below the local surface — capped at a few cells
   * so a stage error can never drain into the next valley.
   */
  {
    const FLOODR = 3;
    const q = new Int32Array(N);
    let head = 0, tail = 0;
    for (let i = 0; i < N; i++) if (wet[i]) q[tail++] = i;
    let ring = 0, ringEnd = tail;
    while (head < tail && ring < FLOODR) {
      const i = q[head++];
      const sv = surf[i];
      const y = (i / S) | 0, x = i - y * S;
      for (let k = 0; k < 8; k++) {
        const nx = x + NB8X[k], ny = y + NB8Y[k];
        if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
        const ni = ny * S + nx;
        if (wet[ni]) continue;
        if (dryMask && dryMask[ni]) continue;
        if (sv <= h[ni] + 0.02) continue;
        wet[ni] = 1;
        surf[ni] = sv;
        q[tail++] = ni;
      }
      if (head >= ringEnd) { ring++; ringEnd = tail; }
    }
  }

  /* ------------------------------- 5. no uphill water: sweep high → low */
  const order = new Int32Array(N);
  for (let i = 0; i < N; i++) order[i] = i;
  {
    // counting sort on filled, descending — O(N), 64k buckets is plenty
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < N; i++) { const v = filled[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const B = 65536;
    const sc = (B - 1) / Math.max(1e-4, hi - lo);
    const cnt = new Int32Array(B);
    const key = new Uint16Array(N);
    for (let i = 0; i < N; i++) { const b = ((filled[i] - lo) * sc) | 0; key[i] = b; cnt[b]++; }
    const start = new Int32Array(B);
    let run = 0;
    for (let b = B - 1; b >= 0; b--) { start[b] = run; run += cnt[b]; }
    const cur = start.slice();
    for (let i = 0; i < N; i++) order[cur[key[i]]++] = i;
  }
  for (let k = 0; k < N; k++) {
    const i = order[k];
    if (!wet[i]) continue;
    const r = recv[i];
    if (r < 0 || !wet[r]) continue;
    if (surf[r] > surf[i]) surf[r] = surf[i];
  }

  /* ------------------------------------- 6. relax the sheet along the network */
  const tmp = new Float32Array(N);
  for (let pass = 0; pass < 6; pass++) {
    tmp.set(surf);
    for (let y = 1; y < S - 1; y++) {
      for (let x = 1; x < S - 1; x++) {
        const i = y * S + x;
        if (!wet[i]) continue;
        let s = 0, n = 0;
        const si = tmp[i];
        for (let k = 0; k < 8; k++) {
          const ni = (y + NB8Y[k]) * S + (x + NB8X[k]);
          if (!wet[ni]) continue;
          /* only average within the same body — never across a watershed */
          if (Math.abs(tmp[ni] - si) > 2.5) continue;
          s += tmp[ni]; n++;
        }
        if (n < 2) continue;
        let v = si * 0.34 + (s / n) * 0.66;
        const floor = h[i] + (river[i] > 0 ? 0.10 : 0.02);
        if (v < floor) v = floor;
        surf[i] = v;
      }
    }
  }

  /* -------------------------------- 7. extrapolate outward for the shoreline
   * The shader needs `surface - bed` to keep falling smoothly NEGATIVE as the
   * bank rises, so the surface has to be defined for a little way outside the
   * water. It must never be defined where it would put the surface ABOVE the
   * ground, or the extrapolation floods the next valley — which is exactly how
   * a 12%-of-the-map inland sea appears out of nothing.
   */
  const SPREAD = 8;                        // cells (≈ 64 m at 8 m)
  const cursor = new Int32Array(N);
  let head = 0, tail = 0;
  const seen = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (wet[i]) { seen[i] = 1; cursor[tail++] = i; }
  let level = 0;
  let levelEnd = tail;
  while (head < tail && level < SPREAD) {
    const i = cursor[head++];
    const y = (i / S) | 0, x = i - y * S;
    const sv = surf[i];
    for (let k = 0; k < 8; k++) {
      const nx = x + NB8X[k], ny = y + NB8Y[k];
      if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
      const ni = ny * S + nx;
      if (seen[ni]) continue;
      if (sv > h[ni]) continue;            // would create water — refuse
      seen[ni] = 1;
      surf[ni] = sv;
      cursor[tail++] = ni;
    }
    if (head >= levelEnd) { level++; levelEnd = tail; }
  }
  for (let i = 0; i < N; i++) if (!seen[i]) surf[i] = h[i] - 8;

  /* soften the nearest-neighbour seams in the extrapolated ring only */
  for (let pass = 0; pass < 3; pass++) {
    tmp.set(surf);
    for (let y = 1; y < S - 1; y++) {
      for (let x = 1; x < S - 1; x++) {
        const i = y * S + x;
        if (wet[i] || !seen[i]) continue;
        let s = tmp[i], n = 1;
        for (let k = 0; k < 8; k++) {
          const ni = (y + NB8Y[k]) * S + (x + NB8X[k]);
          if (!seen[ni]) continue;
          if (Math.abs(tmp[ni] - tmp[i]) > 3.0) continue;
          s += tmp[ni]; n++;
        }
        surf[i] = s / n;
      }
    }
  }

  /* -------------------------------------- 8. flow field (direction + speed) */
  const FR = 512;
  const flowRGBA = new Uint8Array(FR * FR * 4);
  for (let y = 0; y < FR; y++) {
    const sy = Math.min(S - 1, ((y + 0.5) * S / FR) | 0);
    for (let x = 0; x < FR; x++) {
      const sx = Math.min(S - 1, ((x + 0.5) * S / FR) | 0);
      /* average the descent direction over the 2×2 sim cells so the field is
         continuous instead of snapping to the eight D8 directions */
      let dx = 0, dz = 0, sp = 0, rv = 0, n = 0;
      for (let b = 0; b <= 1; b++) {
        for (let a = 0; a <= 1; a++) {
          const i = Math.min(S - 1, sy + b) * S + Math.min(S - 1, sx + a);
          const w = Math.max(river[i], 0.0001);
          dx += dirX[i] * w; dz += dirZ[i] * w;
          sp += Math.min(1, grad[i] * 26) * river[i];
          rv += river[i];
          n++;
        }
      }
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const j = (y * FR + x) * 4;
      flowRGBA[j] = ((dx * 0.5 + 0.5) * 255) | 0;
      flowRGBA[j + 1] = ((dz * 0.5 + 0.5) * 255) | 0;
      flowRGBA[j + 2] = Math.min(255, (sp / n) * 255) | 0;
      flowRGBA[j + 3] = Math.min(255, (rv / n) * 255) | 0;
    }
  }

  /* ------------------------------------ 9. depth field at heightfield res */
  const surfHi = upsampleLinear(surf, S, res);
  const depth = new Float32Array(res * res);
  let wetCells = 0;
  let maxDepth = 0;
  for (let i = 0; i < res * res; i++) {
    let d = surfHi[i] - H[i];
    if (d > 60) d = 60; else if (d < -24) d = -24;
    depth[i] = d;
    if (d > 0.03) { wetCells++; if (d > maxDepth) maxDepth = d; }
  }

  return {
    sim: S, simCell: cell,
    h, surf, wet, river, grad, filled, lakeDepth,
    depth, surfHi, res,
    flowRGBA, flowRes: FR,
    wetCells, maxDepth,
    wetFraction: wetCells / (res * res),
  };
}
