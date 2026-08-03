import * as THREE from 'three';
import { fbm2, rand2, clamp, smoothstep } from './Noise.js';

/**
 * Where things go.
 *
 * The pass-1 note was that scatter must look *caused*, not sprinkled: rocks
 * gather at slope breaks and in the gullies the flow map says debris collects,
 * driftwood piles on the inside of meanders, scrub grows in thickets with
 * clearings between them. Everything here is therefore a function of the
 * terrain's own derivatives — slope, curvature, upstream catchment area,
 * splat weights — multiplied by a two-octave cluster mask.
 */

/** Per-site terrain readout, reused to keep the rebuild allocation-free. */
export class Probe {
  constructor(ctx) {
    this.ctx = ctx;
    this.y = 0;
    this.nx = 0; this.ny = 1; this.nz = 0;
    this.slope = 1;     // normal.y, 1 = flat
    this.curv = 0;      // >0 concave (gully / bowl), <0 convex (ridge / crest)
    this.relief = 0;    // max steepness within 22 m — "is there a scarp above me"
    this.flow = 0;      // 0..1 remapped upstream catchment
    this.grass = 0; this.rock = 0; this.dirt = 0; this.sand = 0; this.snow = 0;
    this.water = false;
    this._flowMap = null;
    this._flowRes = 0;
    this._flowSize = 8192;
  }

  bindFlow(terrain) {
    if (!terrain || typeof terrain.getFlowMap !== 'function') return;
    try {
      const f = terrain.getFlowMap();
      if (f && f.data) {
        this._flowMap = f.data;
        this._flowRes = f.res;
        this._flowSize = f.size || 8192;
      }
    } catch (e) { /* terrain may not expose it */ }
  }

  flowAt(x, z) {
    const m = this._flowMap;
    if (!m) return 0;
    const R = this._flowRes, S = this._flowSize, H = S * 0.5;
    const ix = ((x + H) * (R / S)) | 0;
    const iz = ((z + H) * (R / S)) | 0;
    if (ix < 0 || iz < 0 || ix >= R || iz >= R) return 0;
    /* catchment area in m^2; log-remap so the whole drainage tree is usable */
    const a = m[iz * R + ix];
    return clamp(Math.log10(Math.max(a, 1)) / 6.2, 0, 1);
  }

  /** Fill from the world API. `full` adds the expensive neighbourhood terms. */
  sample(x, z, full = true) {
    const w = this.ctx.world;
    const gh = w.getHeight;
    const y = gh(x, z);
    this.y = y;
    const e = 3.0;
    const hl = gh(x - e, z), hr = gh(x + e, z);
    const hd = gh(x, z - e), hu = gh(x, z + e);
    let nx = hl - hr, ny = 2 * e, nz = hd - hu;
    const l = Math.hypot(nx, ny, nz) || 1;
    this.nx = nx / l; this.ny = ny / l; this.nz = nz / l;
    this.slope = this.ny;
    this.curv = (hl + hr + hd + hu - 4 * y) / (e * e) * 4;

    if (full) {
      const d = 20;
      let worst = 1;
      for (let i = 0; i < 4; i++) {
        const ax = i === 0 ? d : i === 1 ? -d : 0;
        const az = i === 2 ? d : i === 3 ? -d : 0;
        const hh = gh(x + ax, z + az);
        const s = Math.abs(hh - y) / d;
        const ny2 = 1 / Math.sqrt(1 + s * s);
        if (ny2 < worst) worst = ny2;
      }
      this.relief = worst;
      this.flow = this.flowAt(x, z);
      const s = w.getSurface(x, z);
      this.grass = s.grass; this.rock = s.rock; this.dirt = s.dirt;
      this.sand = s.sand; this.snow = s.snow;
      this.water = w.isWater(x, z);
    }
    return this;
  }
}

/**
 * Two-octave patchiness: thickets and clearings, never uniform density.
 *
 * PASS 3. The composition critic measured the pass-2 result and it was still
 * effectively flat: "Scatter is uniform-density noise sprayed edge to edge ...
 * roughly the same instance every 8-12 m for 2 km ... uniform density gives the
 * eye no landmark to fix on, so it cannot triangulate distance and the whole
 * valley collapses into a tabletop model."
 *
 * The old remap was `smoothstep(0.40, 0.80, ...)` over a field that only ever
 * visits ~0.30..0.70, so it never actually reached zero anywhere — there were
 * no clearings, only slightly thinner spray. The window is now narrow and sits
 * ABOVE the field's median, so roughly a third of the world is hard zero and
 * what is left has a real interior gradient.
 */
export function clusterMask(x, z, seed, big = 150, small = 40, bias = 0) {
  const a = fbm2(x / big, z / big, 3, seed) * 0.5 + 0.5;
  const b = fbm2(x / small, z / small, 2, seed + 7717) * 0.5 + 0.5;
  const f = a * 0.70 + b * 0.30 + bias;
  /* hard cut on the low side (genuine negative space) and a saturating top so
     the middle of a thicket is dense rather than merely average */
  return smoothstep(0.455, 0.615, f);
}

/** Sparse, strongly separated patches — for rarer things like ruins/thickets. */
export function rarePatch(x, z, seed, scale = 320) {
  const a = fbm2(x / scale, z / scale, 2, seed) * 0.5 + 0.5;
  return smoothstep(0.62, 0.86, a);
}

/* ------------------------------------------------------------------ trails */

/**
 * Route a wagon trail from A to B by greedy least-effort descent: at each step
 * the walker looks at a fan of candidate headings and picks the one that makes
 * progress while paying the least in gradient. That is exactly how a real
 * cart track forms, so the result contours around the hills instead of running
 * straight up them.
 */
export function routeTrail(world, a, b, seed, { step = 14, maxSteps = 420 } = {}) {
  const pts = [];
  const gh = world.getHeight;
  let px = a.x, pz = a.z;
  let dx = b.x - px, dz = b.z - pz;
  let len = Math.hypot(dx, dz) || 1;
  dx /= len; dz /= len;
  pts.push(new THREE.Vector3(px, gh(px, pz), pz));

  for (let i = 0; i < maxSteps; i++) {
    const tx = b.x - px, tz = b.z - pz;
    const td = Math.hypot(tx, tz);
    if (td < step * 1.6) break;
    const gx = tx / td, gz = tz / td;
    let best = null;
    const y0 = gh(px, pz);
    for (let k = -4; k <= 4; k++) {
      const ang = k * 0.20;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      /* fan around the blend of current heading and goal heading */
      const bx = dx * 0.45 + gx * 0.55, bz = dz * 0.45 + gz * 0.55;
      const bl = Math.hypot(bx, bz) || 1;
      const hx = (bx / bl) * ca - (bz / bl) * sa;
      const hz = (bx / bl) * sa + (bz / bl) * ca;
      const nxp = px + hx * step, nzp = pz + hz * step;
      const y1 = gh(nxp, nzp);
      const grade = Math.abs(y1 - y0) / step;
      const align = hx * gx + hz * gz;
      const wander = fbm2(nxp / 260, nzp / 260, 2, seed) * 0.28;
      const wet = world.isWater(nxp, nzp) ? 0.55 : 0;
      const score = align * 1.0 - grade * 5.2 - wet + wander - Math.abs(ang) * 0.12;
      if (!best || score > best.s) best = { s: score, x: nxp, z: nzp, dx: hx, dz: hz };
    }
    if (!best) break;
    px = best.x; pz = best.z; dx = best.dx; dz = best.dz;
    pts.push(new THREE.Vector3(px, gh(px, pz), pz));
  }

  /* Laplacian smoothing so the cart track is not a polyline of hard kinks */
  for (let it = 0; it < 4; it++) {
    for (let i = 1; i < pts.length - 1; i++) {
      pts[i].x = (pts[i - 1].x + pts[i].x * 2 + pts[i + 1].x) * 0.25;
      pts[i].z = (pts[i - 1].z + pts[i].z * 2 + pts[i + 1].z) * 0.25;
    }
  }
  for (const p of pts) p.y = gh(p.x, p.z);
  return pts;
}

/**
 * Build the road network for the whole map once at boot. Trails connect the
 * registered points of interest and then run on out to the map edge, so a
 * camera dropped anywhere in the core has a decent chance of a track in frame.
 */
export function buildTrailNetwork(ctx, seed) {
  const world = ctx.world;
  const half = (world.size || 8192) * 0.5;
  const nodes = [];
  const push = (v) => {
    if (!v) return;
    const p = v.isVector3 ? v : v.pos;
    if (p) nodes.push(new THREE.Vector3(p.x, 0, p.z));
  };
  /* The camp POI is deliberately NOT a trail node: the night shot frames the
     fire from 5 m and a cart track running under it reads as a decal. */
  push(ctx.poi.get('town'));
  push(ctx.poi.get('river'));
  push(ctx.poi.get('forest'));

  /* fallback + reach: eight rim points on decent ground */
  const rim = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.3;
    let bx = Math.cos(a) * half * 0.86;
    let bz = Math.sin(a) * half * 0.86;
    /* nudge off water */
    for (let k = 0; k < 6 && world.isWater(bx, bz); k++) {
      bx *= 0.9; bz *= 0.9;
    }
    rim.push(new THREE.Vector3(bx, 0, bz));
  }

  const hub = nodes.length ? nodes[0] : new THREE.Vector3(0, 0, 0);
  const routes = [];
  const add = (a, b, s) => {
    if (!a || !b) return;
    const pts = routeTrail(world, a, b, s);
    if (pts.length > 6) routes.push(pts);
  };

  /* main stage road: rim → hub → opposite rim */
  add(rim[0], hub, seed + 1);
  add(hub, rim[4], seed + 2);
  /* cross road */
  add(rim[2], hub, seed + 3);
  add(hub, rim[6], seed + 4);
  /* spurs to the other POIs */
  for (let i = 1; i < nodes.length; i++) add(hub, nodes[i], seed + 10 + i);
  /* two long orbital tracks so the far corners are not empty */
  add(rim[1], rim[3], seed + 21);
  add(rim[5], rim[7], seed + 22);

  return routes;
}

/**
 * Distance from a point to the trail network, plus the tangent there.
 * Used to keep scrub off the road, line fences along it and drop wheel-worn
 * stones in the verge.
 */
export class TrailIndex {
  constructor(routes, cell = 64) {
    this.routes = routes;
    this.cell = cell;
    this.map = new Map();
    for (let r = 0; r < routes.length; r++) {
      const pts = routes[r];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const cx = Math.floor(p.x / cell), cz = Math.floor(p.z / cell);
        for (let a = -1; a <= 1; a++) {
          for (let b = -1; b <= 1; b++) {
            const k = (cx + a) * 100003 + (cz + b);
            let arr = this.map.get(k);
            if (!arr) { arr = []; this.map.set(k, arr); }
            arr.push(r * 100000 + i);
          }
        }
      }
    }
  }

  /** @returns {number} squared distance to the nearest trail centre-line */
  distance2(x, z) {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    const arr = this.map.get(cx * 100003 + cz);
    if (!arr) return 1e9;
    let best = 1e9;
    for (let i = 0; i < arr.length; i++) {
      const r = (arr[i] / 100000) | 0;
      const j = arr[i] % 100000;
      const p = this.routes[r][j];
      const dx = p.x - x, dz = p.z - z;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return best;
  }
}

/**
 * Deterministic anchor points for hand-placed set dressing (ruins, corrals,
 * bone yards). Scans a coarse lattice and keeps the sites that pass a terrain
 * test, so they land somewhere plausible rather than on a cliff.
 */
export function findAnchors(ctx, probe, {
  seed = 1, spacing = 900, count = 14, test = null,
} = {}) {
  const half = (ctx.world.size || 8192) * 0.5 - 260;
  const out = [];
  const n = Math.floor((half * 2) / spacing);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const h = rand2(i, j, seed);
      const x = -half + (i + 0.5 + (h - 0.5) * 0.7) * spacing;
      const z = -half + (j + 0.5 + (rand2(i, j, seed + 31) - 0.5) * 0.7) * spacing;
      if (Math.abs(x) > half || Math.abs(z) > half) continue;
      probe.sample(x, z, true);
      if (probe.water) continue;
      if (test && !test(probe, x, z, h)) continue;
      out.push({ x, z, y: probe.y, h });
      if (out.length >= count) return out;
    }
  }
  return out;
}
