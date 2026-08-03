/**
 * Hydrology: depression filling, multiple-flow-direction accumulation, channel
 * extraction and river-bed carving.
 *
 * The flow-accumulation map produced here is the contract surface the Water
 * system consumes (`Terrain.getFlowMap()`): every cell holds the upstream
 * catchment area in square metres, so thresholding it gives real, connected,
 * dendritic river networks rather than noise.
 */

const NB8 = [-1, 1, 0, 0, -1, 1, -1, 1];
const NB8Y = [0, 0, -1, 1, -1, -1, 1, 1];
const NBD = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

/* ------------------------------------------------------- binary min-heap */
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

/** Priority-flood depression fill with an epsilon gradient (Barnes 2014). */
export function fillDepressions(h, res, eps = 0.0035) {
  const N = res * res;
  const filled = new Float32Array(h);
  const closed = new Uint8Array(N);
  const heap = new MinHeap(N);

  for (let x = 0; x < res; x++) {
    for (const y of [0, res - 1]) {
      const i = y * res + x;
      if (!closed[i]) { closed[i] = 1; heap.push(filled[i], i); }
    }
  }
  for (let y = 0; y < res; y++) {
    for (const x of [0, res - 1]) {
      const i = y * res + x;
      if (!closed[i]) { closed[i] = 1; heap.push(filled[i], i); }
    }
  }

  while (heap.n > 0) {
    const c = heap.pop();
    const cy = (c / res) | 0, cx = c - cy * res;
    const hc = filled[c];
    for (let k = 0; k < 8; k++) {
      const nx = cx + NB8[k], ny = cy + NB8Y[k];
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

/**
 * Multiple-flow-direction accumulation over the filled surface.
 * @returns {{acc:Float32Array, recv:Int32Array}} acc in m², recv = steepest
 *          downslope neighbour index (-1 at an outlet).
 */
export function flowAccumulate(filled, res, cellSize) {
  const N = res * res;
  const acc = new Float32Array(N);
  const recv = new Int32Array(N);
  const cellArea = cellSize * cellSize;
  acc.fill(cellArea);
  recv.fill(-1);

  /* Counting sort by height, descending. */
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < N; i++) { const v = filled[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const BUCKETS = 65536;
  const scale = (BUCKETS - 1) / Math.max(1e-4, hi - lo);
  const count = new Int32Array(BUCKETS + 1);
  const key = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    const b = ((filled[i] - lo) * scale) | 0;
    key[i] = b;
    count[b]++;
  }
  /* prefix sums for descending order */
  const start = new Int32Array(BUCKETS);
  let run = 0;
  for (let b = BUCKETS - 1; b >= 0; b--) { start[b] = run; run += count[b]; }
  const order = new Int32Array(N);
  const cursor = start.slice();
  for (let i = 0; i < N; i++) order[cursor[key[i]]++] = i;

  /* Hybrid MFD/D8 ("MFD-md"): hillslopes disperse like real sheet flow, but
     once a cell carries a channel's worth of water it commits to the steepest
     descent. Pure MFD never concentrates enough to give a usable river; pure
     D8 draws parallel lines across every flat. */
  const CHANNEL = 2.2e4;
  const w = new Float64Array(8);
  for (let o = 0; o < N; o++) {
    const i = order[o];
    const y = (i / res) | 0, x = i - y * res;
    const hi0 = filled[i];
    let total = 0, best = 0, bestI = -1;
    for (let k = 0; k < 8; k++) {
      const nx = x + NB8[k], ny = y + NB8Y[k];
      if (nx < 0 || ny < 0 || nx >= res || ny >= res) { w[k] = 0; continue; }
      const ni = ny * res + nx;
      const s = (hi0 - filled[ni]) / NBD[k];
      if (s > 0) {
        const ww = s * s * s * s;
        w[k] = ww; total += ww;
        if (s > best) { best = s; bestI = ni; }
      } else w[k] = 0;
    }
    recv[i] = bestI;
    if (total <= 0) continue;
    if (acc[i] > CHANNEL) { acc[bestI] += acc[i]; continue; }
    const a = acc[i] / total;
    for (let k = 0; k < 8; k++) {
      if (w[k] <= 0) continue;
      const nx = x + NB8[k], ny = y + NB8Y[k];
      acc[ny * res + nx] += a * w[k];
    }
  }
  return { acc, recv };
}

/**
 * Cut the channels the flow map says exist: width and depth scale with the
 * square root of catchment area, banks are smoothed, and the incision is
 * clamped so headwater gullies stay shallow.
 * @returns {{ wet:Float32Array, depth:Float32Array }} wet = 0..1 channel mask
 */
export function carveChannels(h, acc, res, cellSize, opts = {}) {
  const {
    startArea = 2.2e5,      // m² before a gully becomes a stream
    fullArea = 2.4e7,       // m² for a full-width river
    maxDepth = 9.5,
    maxWiden = 3.6,         // blur radius in cells for the bank shoulder
  } = opts;

  const N = res * res;
  const wet = new Float32Array(N);
  const l0 = Math.log(startArea), l1 = Math.log(fullArea);
  for (let i = 0; i < N; i++) {
    const a = acc[i];
    if (a <= startArea) continue;
    let t = (Math.log(a) - l0) / (l1 - l0);
    if (t > 1) t = 1;
    wet[i] = t;
  }

  /* Widen: a channel is wider than one cell, and its shoulders are graded.
     Splat outward from the sparse channel cells rather than gathering — the
     network covers a few percent of the grid, so this is ~30x cheaper. */
  const r = Math.max(1, Math.ceil(maxWiden) + 1);
  const wide = new Float32Array(N);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const v = wet[y * res + x];
      if (v <= 0) continue;
      const reach = 0.9 + v * maxWiden;
      const y0 = Math.max(0, y - r), y1 = Math.min(res - 1, y + r);
      const x0 = Math.max(0, x - r), x1 = Math.min(res - 1, x + r);
      for (let yy = y0; yy <= y1; yy++) {
        const dy = yy - y;
        for (let xx = x0; xx <= x1; xx++) {
          const dx = xx - x;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > reach) continue;
          const f = v * (1 - d / (reach + 0.6));
          const k = yy * res + xx;
          if (f > wide[k]) wide[k] = f;
        }
      }
    }
  }

  const depth = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const d = Math.pow(wide[i], 1.35) * maxDepth;
    depth[i] = d;
    h[i] -= d;
  }
  void cellSize;
  return { wet: wide, depth };
}

/**
 * Trace the trunk channels as polylines so the Water system can lay geometry
 * along them without re-deriving the network.
 */
export function traceRivers(acc, recv, h, res, cellSize, half, opts = {}) {
  const { minArea = 3.0e6, maxRivers = 14, minLength = 24 } = opts;
  const N = res * res;
  const visited = new Uint8Array(N);
  const seeds = [];
  for (let i = 0; i < N; i++) if (acc[i] > minArea) seeds.push(i);
  seeds.sort((a, b) => acc[b] - acc[a]);

  const rivers = [];
  for (const s of seeds) {
    if (rivers.length >= maxRivers) break;
    if (visited[s]) continue;
    /* Walk upstream-most first: only start where no upstream neighbour is big. */
    const y = (s / res) | 0, x = s - y * res;
    let isHead = true;
    for (let k = 0; k < 8; k++) {
      const nx = x + NB8[k], ny = y + NB8Y[k];
      if (nx < 0 || ny < 0 || nx >= res || ny >= res) continue;
      if (recv[ny * res + nx] === s && acc[ny * res + nx] > minArea) { isHead = false; break; }
    }
    if (!isHead) continue;

    const pts = [];
    let c = s;
    let guard = 0;
    while (c >= 0 && guard++ < res * 4) {
      if (visited[c]) { pts.push(c); break; }
      visited[c] = 1;
      pts.push(c);
      c = recv[c];
    }
    if (pts.length < minLength) continue;
    const poly = [];
    for (let i = 0; i < pts.length; i += 2) {
      const p = pts[i];
      const py = (p / res) | 0, px = p - py * res;
      poly.push({
        x: -half + (px + 0.5) * cellSize,
        z: -half + (py + 0.5) * cellSize,
        y: h[p],
        width: Math.min(46, 5 + Math.sqrt(acc[p]) * 0.010),
        area: acc[p],
      });
    }
    rivers.push(poly);
  }
  return rivers;
}
