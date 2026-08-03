import { Frame } from './Builder.js';
import { UV } from './Buildings.js';

/**
 * Props — everything that is not a building.
 *
 * Vertical elements matter enormously for silhouette (the pass-1 critique said
 * so explicitly), so the tall stuff lives here: telegraph poles with real
 * catenary wire, a windmill, a water tower, hitching rails and the boardwalk
 * that ties the street together. Every prop is authored in a world-placed
 * Frame and merged into the shared material buckets, so 200 props still cost
 * zero extra draw calls.
 */

const W = (base, eave, grime, chalk) => [base, eave, grime, chalk];

/* ----------------------------------------------------------------- timber */

/** Post-and-rail hitching rail. */
export function hitchRail(B, M, F, len, o = {}) {
  const wear = o.wear || W(F.oy, F.oy + 1.4, 0.85, 0.2);
  const col = o.col || [0.72, 0.66, 0.57];
  const h = o.h || 1.06;
  const n = Math.max(2, Math.round(len / 2.3));
  for (let i = 0; i <= n; i++) {
    const x = -len * 0.5 + (len * i) / n;
    const lean = Math.sin(i * 2.3 + (o.seed || 0)) * 0.045;
    B.tube(M.weathered, F.p(x, 0, -0.3), F.p(x + lean, 0, h), 0.075, 0.062, 6,
      { us: 0.5, vs: 0.7, col, wear, wobble: 0.08, phase: i });
  }
  const sag = o.sag != null ? o.sag : 0.035;
  for (let i = 0; i < n; i++) {
    const xa = -len * 0.5 + (len * i) / n;
    const xb = -len * 0.5 + (len * (i + 1)) / n;
    const xm = (xa + xb) * 0.5;
    B.tube(M.thin, F.p(xa, 0, h - 0.10), F.p(xm, 0, h - 0.10 - sag), 0.052, 0.052, 5,
      { us: 0.5, vs: 0.7, col, wear });
    B.tube(M.thin, F.p(xm, 0, h - 0.10 - sag), F.p(xb, 0, h - 0.10), 0.052, 0.052, 5,
      { us: 0.5, vs: 0.7, col, wear });
  }
}

/** Water trough: planked box with iron straps, dark water inside. */
export function trough(B, M, F, o = {}) {
  const wear = o.wear || W(F.oy, F.oy + 1.0, 0.95, 0.15);
  const col = o.col || [0.60, 0.55, 0.47];
  const L = o.len || 2.5, wd = o.wide || 0.78, h = o.h || 0.66;
  const t = 0.06;
  const so = { us: 1.0, vs: 0.4, col, wear, nv: 2 };
  B.box(M.weathered, F, -L * 0.5, L * 0.5, -wd * 0.5, -wd * 0.5 + t, 0, h, so);
  B.box(M.weathered, F, -L * 0.5, L * 0.5, wd * 0.5 - t, wd * 0.5, 0, h, so);
  B.box(M.weathered, F, -L * 0.5, -L * 0.5 + t, -wd * 0.5, wd * 0.5, 0, h, so);
  B.box(M.weathered, F, L * 0.5 - t, L * 0.5, -wd * 0.5, wd * 0.5, 0, h, so);
  // water: dark, low roughness so it catches the sky
  B.faceY(M.water, F, h - 0.13, -L * 0.5 + t, L * 0.5 - t, -wd * 0.5 + t, wd * 0.5 - t, +1,
    { us: 1.4, vs: 1.4, col: [1, 1, 1], wear, nu: 2, nv: 1 });
  // iron straps
  for (const sx of [-L * 0.3, L * 0.3]) {
    B.box(M.rust, F, sx - 0.035, sx + 0.035, -wd * 0.5 - 0.012, wd * 0.5 + 0.012, 0.08, h - 0.02,
      { us: 0.5, vs: 0.5, col: [0.75, 0.62, 0.5], wear, nu: 1, nv: 1 });
  }
  // legs
  for (const sx of [-L * 0.38, L * 0.38]) {
    B.box(M.weathered, F, sx - 0.07, sx + 0.07, -wd * 0.5 + 0.05, wd * 0.5 - 0.05, -0.28, 0.02,
      { us: 0.5, vs: 0.5, col, wear, nu: 1, nv: 1 });
  }
}

/** Barrel, staves suggested by the wobble on the tube. */
export function barrel(B, M, F, o = {}) {
  const wear = o.wear || W(F.oy, F.oy + 1.0, 0.9, 0.2);
  const col = o.col || [0.68, 0.58, 0.45];
  const h = o.h || 0.86, r = o.r || 0.30;
  const tilt = o.tilt || 0;
  const p0 = F.p(0, 0, 0);
  const p1 = F.p(Math.sin(tilt) * h, 0, Math.cos(tilt) * h);
  B.tube(M.weathered, p0, p1, r * 0.86, r * 0.86, 10,
    { us: 0.55, vs: 0.55, col, wear, rings: 3, wobble: 0.055, caps: true, phase: o.seed || 0 });
  for (const t of [0.13, 0.42, 0.58, 0.87]) {
    const a = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t];
    const b = [p0[0] + (p1[0] - p0[0]) * (t + 0.035), p0[1] + (p1[1] - p0[1]) * (t + 0.035), p0[2] + (p1[2] - p0[2]) * (t + 0.035)];
    B.tube(M.rust, a, b, r * 0.90, r * 0.90, 10,
      { us: 0.3, vs: 0.3, col: [0.68, 0.56, 0.44], wear });
  }
}

/** Crate: boarded box with batten frame. */
export function crate(B, M, F, o = {}) {
  const wear = o.wear || W(F.oy, F.oy + 0.9, 0.8, 0.25);
  const col = o.col || [0.80, 0.70, 0.55];
  const s = o.size || 0.55;
  const d = o.d || s;
  const hh = o.h || s * 0.92;
  B.box(M.weathered, F, -s * 0.5, s * 0.5, -d * 0.5, d * 0.5, 0, hh,
    { us: 0.6, vs: 0.22, col, wear, nv: 3 });
  const bc = [col[0] * 0.86, col[1] * 0.86, col[2] * 0.86];
  const bo = { us: 0.4, vs: 0.4, col: bc, wear, nu: 1, nv: 1 };
  for (const sx of [-s * 0.5, s * 0.5 - 0.05]) {
    B.box(M.weathered, F, sx, sx + 0.05, -d * 0.5 - 0.012, d * 0.5 + 0.012, 0.02, hh - 0.02, bo);
  }
  B.box(M.weathered, F, -s * 0.5 - 0.012, s * 0.5 + 0.012, -d * 0.5, -d * 0.5 + 0.05, 0.02, hh - 0.02, bo);
}

/** Spoked wagon wheel in the frame's XY plane (z = axle). */
export function wagonWheel(B, M, F, o = {}) {
  const wear = o.wear || W(F.oy - 0.6, F.oy + 0.6, 0.9, 0.2);
  const col = o.col || [0.66, 0.58, 0.47];
  const r = o.r || 0.62;
  const spokes = o.spokes || 12;
  const seg = o.seg || 14;
  const th = o.th || 0.055;
  // felloe (wooden rim) as a chain of short tubes
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const p0 = F.p(Math.cos(a0) * r, 0, Math.sin(a0) * r);
    const p1 = F.p(Math.cos(a1) * r, 0, Math.sin(a1) * r);
    B.tube(M.thin, p0, p1, th, th, 5, { us: 0.4, vs: 0.4, col, wear });
    const q0 = F.p(Math.cos(a0) * (r + th * 0.9), 0, Math.sin(a0) * (r + th * 0.9));
    const q1 = F.p(Math.cos(a1) * (r + th * 0.9), 0, Math.sin(a1) * (r + th * 0.9));
    B.tube(M.thinIron, q0, q1, th * 0.42, th * 0.42, 4, { us: 0.3, vs: 0.3, col: [0.68, 0.56, 0.44], wear });
  }
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2 + 0.13;
    B.tube(M.thin, F.p(0, 0, 0), F.p(Math.cos(a) * (r - th * 0.5), 0, Math.sin(a) * (r - th * 0.5)),
      0.028, 0.020, 4, { us: 0.3, vs: 0.5, col, wear });
  }
  B.tube(M.weathered, F.p(0, -0.075, 0), F.p(0, 0.075, 0), 0.09, 0.09, 8,
    { us: 0.3, vs: 0.3, col: [col[0] * 0.9, col[1] * 0.9, col[2] * 0.9], wear, caps: true });
}

/** Buckboard wagon: bed, sides, seat, shafts, four wheels. */
export function buckboard(B, M, F, o = {}) {
  const wear = o.wear || W(F.oy, F.oy + 1.6, 0.85, 0.3);
  const col = o.col || [0.62, 0.54, 0.43];
  const bedY = o.bedY || 0.80;
  const L = 2.9, wd = 1.36;
  // bed planks
  const np = 7;
  for (let i = 0; i < np; i++) {
    const z0 = -wd * 0.5 + (wd * i) / np;
    const z1 = -wd * 0.5 + (wd * (i + 1)) / np - 0.012;
    const k = 0.88 + 0.22 * (((i * 5) % 4) / 4);
    B.box(M.weathered, F, -L * 0.5, L * 0.5, z0, z1, bedY - 0.06, bedY,
      { us: 1.0, vs: 0.4, col: [col[0] * k, col[1] * k, col[2] * k], wear, nv: 1 });
  }
  // side boards
  const so = { us: 0.9, vs: 0.32, col, wear, nv: 2 };
  B.box(M.weathered, F, -L * 0.5, L * 0.5, -wd * 0.5 - 0.04, -wd * 0.5 + 0.02, bedY, bedY + 0.34, so);
  B.box(M.weathered, F, -L * 0.5, L * 0.5, wd * 0.5 - 0.02, wd * 0.5 + 0.04, bedY, bedY + 0.34, so);
  B.box(M.weathered, F, -L * 0.5 - 0.04, -L * 0.5 + 0.02, -wd * 0.5, wd * 0.5, bedY, bedY + 0.34, so);
  // seat
  B.box(M.weathered, F, L * 0.12, L * 0.42, -wd * 0.44, wd * 0.44, bedY + 0.30, bedY + 0.40,
    { us: 0.8, vs: 0.4, col, wear, nv: 1 });
  B.box(M.weathered, F, L * 0.36, L * 0.42, -wd * 0.44, wd * 0.44, bedY + 0.40, bedY + 0.74,
    { us: 0.8, vs: 0.4, col, wear, nv: 1 });
  // frame rails + axles
  B.box(M.weathered, F, -L * 0.52, L * 0.52, -wd * 0.4, -wd * 0.4 + 0.08, bedY - 0.14, bedY - 0.06,
    { us: 0.8, vs: 0.4, col, wear, nv: 1 });
  B.box(M.weathered, F, -L * 0.52, L * 0.52, wd * 0.4 - 0.08, wd * 0.4, bedY - 0.14, bedY - 0.06,
    { us: 0.8, vs: 0.4, col, wear, nv: 1 });
  const rR = 0.62, fR = 0.46;
  for (const [ax, rr] of [[-L * 0.36, rR], [L * 0.34, fR]]) {
    B.tube(M.rust, F.p(ax, -wd * 0.52, rr), F.p(ax, wd * 0.52, rr), 0.038, 0.038, 6,
      { us: 0.3, vs: 0.5, col: [0.68, 0.58, 0.46], wear });
    for (const sgn of [-1, 1]) {
      const WF = new Frame(...F.p(ax, sgn * (wd * 0.5 + 0.06), rr), F.ax, F.az);
      wagonWheel(B, M, WF, { r: rr, spokes: rr > 0.55 ? 14 : 12, col, wear });
    }
  }
  // shafts / tongue
  B.tube(M.weathered, F.p(L * 0.48, -0.24, bedY - 0.12), F.p(L * 0.48 + 1.9, -0.30, 0.42),
    0.045, 0.035, 5, { us: 0.4, vs: 0.8, col, wear });
  B.tube(M.weathered, F.p(L * 0.48, 0.24, bedY - 0.12), F.p(L * 0.48 + 1.9, 0.30, 0.42),
    0.045, 0.035, 5, { us: 0.4, vs: 0.8, col, wear });
}

/** Telegraph pole with crossarm and insulators. Returns the wire tie points. */
export function telegraphPole(B, M, F, o = {}) {
  const wear = o.wear || W(F.oy, F.oy + 8, 0.8, 0.35);
  const col = o.col || [0.52, 0.45, 0.36];
  const h = o.h || 7.6;
  const lean = o.lean || 0;
  const top = F.p(lean, 0, h);
  B.tube(M.weathered, F.p(0, 0, -0.4), top, 0.135, 0.095, 7,
    { us: 0.55, vs: 1.2, col, wear, rings: 2, wobble: 0.02 });
  const ay = h - 0.55;
  const arm = o.arm || 1.15;
  B.box(M.weathered, F, -arm, arm, -0.055, 0.055, ay, ay + 0.11,
    { us: 0.6, vs: 0.35, col, wear, nv: 1 });
  // diagonal braces
  B.tube(M.thinIron, F.p(-arm * 0.6, 0, ay), F.p(-0.06, 0, ay - 0.55), 0.02, 0.02, 4,
    { us: 0.3, vs: 0.4, col: [0.6, 0.5, 0.4], wear });
  B.tube(M.thinIron, F.p(arm * 0.6, 0, ay), F.p(0.06, 0, ay - 0.55), 0.02, 0.02, 4,
    { us: 0.3, vs: 0.4, col: [0.6, 0.5, 0.4], wear });
  const ties = [];
  for (const sx of [-arm * 0.72, arm * 0.72]) {
    B.tube(M.glass, F.p(sx, 0, ay + 0.11), F.p(sx, 0, ay + 0.24), 0.045, 0.036, 6,
      { us: 0.2, vs: 0.2, col: [0.42, 0.55, 0.48], wear, caps: true });
    ties.push(F.p(sx, 0, ay + 0.22));
  }
  return ties;
}

/** Catenary wire between two points. */
export function wire(B, M, p0, p1, o = {}) {
  const sag = o.sag != null ? o.sag : 0.9;
  const segs = o.segs || 9;
  const r = o.r || 0.016;
  const col = o.col || [0.28, 0.26, 0.24];
  const wear = o.wear || W(0, 0, 0.2, 0);
  let prev = p0;
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const p = [
      p0[0] + (p1[0] - p0[0]) * t,
      p0[1] + (p1[1] - p0[1]) * t - sag * Math.sin(Math.PI * t) * (0.55 + 0.45 * Math.sin(Math.PI * t)),
      p0[2] + (p1[2] - p0[2]) * t,
    ];
    B.tube(M.wire || M.thinIron, prev, p, r, r, 4, { us: 0.3, vs: 0.6, col, wear });
    prev = p;
  }
}

/** Post-and-rail fence along a polyline of world points. */
export function fenceRun(B, M, pts, o = {}) {
  const col = o.col || [0.62, 0.55, 0.45];
  const h = o.h || 1.28;
  const rails = o.rails || 3;
  const spacing = o.spacing || 2.4;
  for (let s = 0; s < pts.length - 1; s++) {
    const a = pts[s], b = pts[s + 1];
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const n = Math.max(1, Math.round(len / spacing));
    for (let i = 0; i <= n; i++) {
      if (s > 0 && i === 0) continue;
      const t = i / n;
      const px = a[0] + (b[0] - a[0]) * t;
      const py = a[1] + (b[1] - a[1]) * t;
      const pz = a[2] + (b[2] - a[2]) * t;
      const wear = W(py, py + h, 0.9, 0.2);
      const lean = Math.sin(i * 3.1 + s * 1.7) * 0.06;
      B.tube(M.thin, [px, py - 0.35, pz], [px + lean, py + h, pz + lean * 0.6],
        0.072, 0.058, 5, { us: 0.5, vs: 0.7, col, wear, wobble: 0.09, phase: i * 1.3 });
    }
    for (let r = 0; r < rails; r++) {
      const ry = h * (0.34 + (0.62 * r) / Math.max(1, rails - 1));
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n, tm = (t0 + t1) * 0.5;
        const P = (t, dy) => [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t + ry + dy,
          a[2] + (b[2] - a[2]) * t,
        ];
        const wear = W(a[1], a[1] + h, 0.9, 0.2);
        B.tube(M.thin, P(t0, 0), P(tm, -0.05), 0.042, 0.042, 4, { us: 0.4, vs: 0.7, col, wear });
        B.tube(M.thin, P(tm, -0.05), P(t1, 0), 0.042, 0.042, 4, { us: 0.4, vs: 0.7, col, wear });
      }
    }
  }
}

/** Lattice water tower: legs, braces, staved tank, conical roof. */
export function waterTower(B, M, F, o = {}) {
  const wear = o.wear || W(F.oy, F.oy + 11, 0.9, 0.35);
  const col = o.col || [0.58, 0.51, 0.41];
  const legH = o.legH || 6.4;
  const spread = o.spread || 2.5;
  const topSpread = spread * 0.72;
  const tankR = o.tankR || 2.15;
  const tankH = o.tankH || 3.1;
  const legs = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
    const bx = Math.cos(a) * spread, bz = Math.sin(a) * spread;
    const tx = Math.cos(a) * topSpread, tz = Math.sin(a) * topSpread;
    B.tube(M.weathered, F.p(bx, bz, -0.5), F.p(tx, tz, legH), 0.115, 0.095, 5,
      { us: 0.5, vs: 1.0, col, wear });
    legs.push({ a, bx, bz, tx, tz });
  }
  for (let i = 0; i < 4; i++) {
    const L0 = legs[i], L1 = legs[(i + 1) % 4];
    for (let lvl = 0; lvl < 3; lvl++) {
      const k0 = lvl / 3, k1 = (lvl + 1) / 3;
      const p = (L, k) => F.p(L.bx + (L.tx - L.bx) * k, L.bz + (L.tz - L.bz) * k, legH * k);
      B.tube(M.thin, p(L0, k0), p(L1, k1), 0.045, 0.045, 4, { us: 0.4, vs: 0.9, col, wear });
      B.tube(M.thin, p(L1, k0), p(L0, k1), 0.045, 0.045, 4, { us: 0.4, vs: 0.9, col, wear });
      B.tube(M.thin, p(L0, k1), p(L1, k1), 0.05, 0.05, 4, { us: 0.4, vs: 0.9, col, wear });
    }
  }
  // tank
  B.tube(M.weathered, F.p(0, 0, legH), F.p(0, 0, legH + tankH), tankR, tankR * 0.99, 18,
    { us: 0.62, vs: 0.62, col: [col[0] * 1.06, col[1] * 1.06, col[2] * 1.06], wear, rings: 4, wobble: 0.012 });
  for (const t of [0.12, 0.42, 0.72, 0.94]) {
    B.tube(M.rust, F.p(0, 0, legH + tankH * t), F.p(0, 0, legH + tankH * t + 0.09),
      tankR * 1.015, tankR * 1.015, 18, { us: 0.3, vs: 0.3, col: [0.72, 0.58, 0.45], wear });
  }
  B.tube(M.iron, F.p(0, 0, legH + tankH), F.p(0, 0, legH + tankH + 0.95), tankR * 1.06, 0.13, 18,
    { us: 1.0, vs: 1.0, col: [0.92, 0.88, 0.84], wear, caps: true });
  // downspout
  B.tube(M.rust, F.p(tankR * 0.9, 0, legH + 0.3), F.p(tankR * 1.5, 0, legH - 1.2), 0.085, 0.085, 6,
    { us: 0.4, vs: 0.6, col: [0.72, 0.58, 0.45], wear });
}

/**
 * Farm windmill. The static tower goes into the shared buckets; the rotor is
 * returned as its own bucket name so Town can spin it.
 */
export function windmill(B, M, F, rotorMat, o = {}) {
  const wear = o.wear || W(F.oy, F.oy + 10, 0.85, 0.4);
  const col = o.col || [0.55, 0.48, 0.39];
  const legH = o.legH || 7.2;
  const spread = o.spread || 1.55;
  const legs = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
    const bx = Math.cos(a) * spread, bz = Math.sin(a) * spread;
    const tx = Math.cos(a) * 0.34, tz = Math.sin(a) * 0.34;
    B.tube(M.weathered, F.p(bx, bz, -0.5), F.p(tx, tz, legH), 0.085, 0.055, 5,
      { us: 0.4, vs: 1.0, col, wear });
    legs.push({ bx, bz, tx, tz });
  }
  for (let i = 0; i < 4; i++) {
    const L0 = legs[i], L1 = legs[(i + 1) % 4];
    for (let lvl = 0; lvl < 4; lvl++) {
      const k0 = lvl / 4, k1 = (lvl + 1) / 4;
      const p = (L, k) => F.p(L.bx + (L.tx - L.bx) * k, L.bz + (L.tz - L.bz) * k, legH * k);
      B.tube(M.thinIron, p(L0, k0), p(L1, k1), 0.024, 0.024, 4, { us: 0.3, vs: 0.9, col: [0.6, 0.5, 0.42], wear });
      B.tube(M.thinIron, p(L1, k0), p(L0, k1), 0.024, 0.024, 4, { us: 0.3, vs: 0.9, col: [0.6, 0.5, 0.42], wear });
      B.tube(M.thin, p(L0, k1), p(L1, k1), 0.04, 0.04, 4, { us: 0.3, vs: 0.9, col, wear });
    }
  }
  // platform + head
  B.box(M.weathered, F, -0.55, 0.55, -0.55, 0.55, legH - 0.1, legH,
    { us: 0.7, vs: 0.35, col, wear, nu: 2, nv: 1 });
  const hubY = legH + 0.85;
  B.tube(M.rust, F.p(0, 0, legH), F.p(0, 0, hubY + 0.2), 0.14, 0.11, 7,
    { us: 0.4, vs: 0.5, col: [0.7, 0.58, 0.46], wear, caps: true });
  // tail vane
  B.box(M.iron, F, -0.02, 0.02, 1.05, 2.55, hubY - 0.42, hubY + 0.5,
    { us: 1.2, vs: 1.2, col: [0.86, 0.82, 0.76], wear, nu: 1, nv: 2 });
  B.tube(M.rust, F.p(0, 0.2, hubY), F.p(0, 1.2, hubY), 0.05, 0.04, 5,
    { us: 0.3, vs: 0.5, col: [0.7, 0.58, 0.46], wear });

  /* ---- rotor, in its own bucket so it can turn ---- */
  const hub = F.p(0, -0.42, hubY);
  const nb = 16;
  const R = 1.65, r0 = 0.30;
  const ax = F.ax, az = F.az;         // rotor plane spans (ax, up)
  const rp = (c, s, rad) => [
    hub[0] + ax * c * rad,
    hub[1] + s * rad,
    hub[2] + az * c * rad,
  ];
  for (let i = 0; i < nb; i++) {
    const a0 = (i / nb) * Math.PI * 2;
    const a1 = ((i + 0.62) / nb) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    B.quad(rotorMat,
      rp(c0, s0, r0), rp(c1, s1, r0), rp(c1, s1, R), rp(c0, s0, R),
      { us: 0.9, vs: 0.9, col: [0.88, 0.84, 0.78], wear, nu: 1, nv: 1 });
    B.quad(rotorMat,
      rp(c1, s1, r0), rp(c0, s0, r0), rp(c0, s0, R), rp(c1, s1, R),
      { us: 0.9, vs: 0.9, col: [0.72, 0.69, 0.64], wear, nu: 1, nv: 1 });
  }
  for (let i = 0; i < 12; i++) {
    const a0 = (i / 12) * Math.PI * 2;
    const a1 = ((i + 1) / 12) * Math.PI * 2;
    B.tube(rotorMat, rp(Math.cos(a0), Math.sin(a0), R * 1.01), rp(Math.cos(a1), Math.sin(a1), R * 1.01),
      0.028, 0.028, 4, { us: 0.3, vs: 0.3, col: [0.7, 0.62, 0.52], wear });
  }
  return { hub, axis: [ax, 0, az] };
}

/** Hay bale / loose stack. */
export function hayStack(B, M, F, o = {}) {
  const wear = o.wear || W(F.oy, F.oy + 1.4, 0.6, 0.5);
  const s = o.size || 0.9;
  const h = o.h || 0.62;
  B.box(M.hay, F, -s * 0.5, s * 0.5, -s * 0.4, s * 0.4, 0, h, {
    us: 1.0,
    vs: 1.0,
    col: o.col || [1.02, 0.98, 0.88],
    wear,
    nu: 2,
    nv: 2,
    step: 0.5,
    warp: (u, v, p) => { p[1] += Math.sin(u * 9.1 + v * 5.3) * 0.03; },
  });
}

/** Stack of sawn lumber. */
export function lumberStack(B, M, F, o = {}) {
  const wear = o.wear || W(F.oy, F.oy + 1.2, 0.8, 0.3);
  const col = o.col || [0.86, 0.78, 0.62];
  const L = o.len || 3.2;
  const rows = o.rows || 5;
  for (let r = 0; r < rows; r++) {
    const n = 4 - (r % 2);
    for (let i = 0; i < n; i++) {
      const z = (-n * 0.5 + i + 0.5) * 0.24;
      const k = 0.85 + 0.3 * (((r * 3 + i) % 5) / 5);
      B.box(M.weathered, F, -L * 0.5 + (r % 2) * 0.1, L * 0.5 - (r % 2) * 0.05,
        z - 0.1, z + 0.1, r * 0.11, r * 0.11 + 0.10,
        { us: 1.0, vs: 0.5, col: [col[0] * k, col[1] * k, col[2] * k], wear, nv: 1 });
    }
  }
}

/** Hanging lantern on a bracket. Returns the flame position. */
export function lantern(B, M, F, o = {}) {
  const wear = o.wear || W(F.oy - 2, F.oy + 1, 0.5, 0.2);
  const col = [0.62, 0.55, 0.46];
  const armL = o.arm || 0.42;
  B.tube(M.rust, F.p(0, 0, 0), F.p(0, -armL, 0), 0.022, 0.022, 4,
    { us: 0.3, vs: 0.3, col: [0.55, 0.46, 0.38], wear });
  B.tube(M.rust, F.p(0, -armL, 0), F.p(0, -armL, -0.10), 0.018, 0.018, 4,
    { us: 0.3, vs: 0.3, col: [0.55, 0.46, 0.38], wear });
  const cy = -0.42;
  const s = 0.10;
  const LF = F.sub(0, -armL, cy);
  B.box(M.rust, LF, -s, s, -s, s, 0.20, 0.30, { us: 0.3, vs: 0.3, col, wear, nu: 1, nv: 1 });
  B.box(M.rust, LF, -s * 0.9, s * 0.9, -s * 0.9, s * 0.9, -0.04, 0.02, { us: 0.3, vs: 0.3, col, wear, nu: 1, nv: 1 });
  // glazing: four panes
  B.box(M.glassLit, LF, -s * 0.82, s * 0.82, -s * 0.82, s * 0.82, 0.02, 0.20,
    { us: 0.2, vs: 0.2, col: [1, 1, 1], wear, nu: 1, nv: 1, skip: 'tb' });
  for (const [a, b] of [[-s, -s], [-s, s], [s, -s], [s, s]]) {
    B.tube(M.rust, LF.p(a, b, 0.0), LF.p(a, b, 0.22), 0.014, 0.014, 4,
      { us: 0.2, vs: 0.2, col, wear });
  }
  return LF.p(0, 0, 0.11);
}

/** Signboard on the facade, textured from the painted-lettering atlas. */
export function signBoard(B, M, F, o) {
  const wear = o.wear;
  const { x0, x1, y0, y1, z } = o;
  const uvRect = o.uv;   // [u0, v0, u1, v1] in the atlas
  const B0 = F.p(x0, z, y0), B1 = F.p(x1, z, y0);
  const T1 = F.p(x1, z, y1), T0 = F.p(x0, z, y1);
  const bkt = B.bucket(M.sign);
  const k = bkt.n;
  /*
   * The board is read from the STREET, i.e. by a viewer looking along +ez.
   * For that viewer screen-right is  d x up = ez x (0,1,0) = -ex, so the
   * frame's local +x runs to the viewer's LEFT and the atlas u axis has to be
   * reversed. Getting this backwards renders every sign in town as mirror
   * writing, which is the single loudest "not a real game" tell there is.
   */
  const pts = [B1, B0, T0, T1];
  const uvs = [[uvRect[0], uvRect[1]], [uvRect[2], uvRect[1]], [uvRect[2], uvRect[3]], [uvRect[0], uvRect[3]]];
  // normal = -ez
  const nx = -F.bx, nz = -F.bz;
  for (let i = 0; i < 4; i++) {
    const p = pts[i];
    bkt.pos.push(p[0], p[1], p[2]);
    bkt.nor.push(nx, 0, nz);
    bkt.uv.push(uvs[i][0], uvs[i][1]);
    bkt.col.push(1, 1, 1);
    bkt.wear.push(p[1] - wear[0], wear[1] - p[1], wear[2] * 0.6, 0.75);
  }
  bkt.n += 4;
  bkt.idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
  // board edge so it reads as a plank, not a decal
  B.box(M.plank, F, x0, x1, z, z + 0.055, y0 - 0.03, y0, { us: 1, vs: 0.3, col: [0.5, 0.45, 0.38], wear, nv: 1 });
  B.box(M.plank, F, x0, x1, z, z + 0.055, y1, y1 + 0.03, { us: 1, vs: 0.3, col: [0.5, 0.45, 0.38], wear, nv: 1 });
}

/** Sign hanging from a bracket, perpendicular to the facade (double sided). */
export function hangingSign(B, M, F, o) {
  const wear = o.wear;
  const { y, len, h, z } = o;
  const uvRect = o.uv;
  B.tube(M.rust, F.p(0, z, y + 0.55), F.p(0, z - len - 0.15, y + 0.55), 0.022, 0.022, 4,
    { us: 0.3, vs: 0.3, col: [0.5, 0.43, 0.36], wear });
  B.tube(M.rust, F.p(0, z, y + 0.05), F.p(0, z - len - 0.15, y + 0.55), 0.016, 0.016, 4,
    { us: 0.3, vs: 0.3, col: [0.5, 0.43, 0.36], wear });
  for (const zz of [z - 0.18, z - len + 0.03]) {
    B.tube(M.rust, F.p(0, zz, y + 0.53), F.p(0, zz, y), 0.011, 0.011, 4,
      { us: 0.2, vs: 0.2, col: [0.5, 0.43, 0.36], wear });
  }
  const bkt = B.bucket(M.sign);
  const zA = z - 0.14, zB = z - len;
  const push = (pts, uvs, nx, nz) => {
    const k = bkt.n;
    for (let i = 0; i < 4; i++) {
      const p = pts[i];
      bkt.pos.push(p[0], p[1], p[2]);
      bkt.nor.push(nx, 0, nz);
      bkt.uv.push(uvs[i][0], uvs[i][1]);
      bkt.col.push(1, 1, 1);
      bkt.wear.push(p[1] - wear[0], wear[1] - p[1], wear[2] * 0.5, 0.8);
    }
    bkt.n += 4;
    bkt.idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
  };
  const u0 = uvRect[0], v0 = uvRect[1], u1 = uvRect[2], v1 = uvRect[3];
  // Same handedness trap as signBoard: the +x-facing side reads the atlas
  // right-to-left, the -x-facing side left-to-right.
  push([F.p(0.012, zB, y - h), F.p(0.012, zA, y - h), F.p(0.012, zA, y), F.p(0.012, zB, y)],
    [[u1, v0], [u0, v0], [u0, v1], [u1, v1]], F.ax, F.az);
  push([F.p(-0.012, zA, y - h), F.p(-0.012, zB, y - h), F.p(-0.012, zB, y), F.p(-0.012, zA, y)],
    [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], -F.ax, -F.az);
}

/* --------------------------------------------------------------- ground kit */

/**
 * A single small stone: a noise-displaced hemisphere-ish blob with outward
 * normals and metric UVs. Deliberately cheap (7x5) because these exist to be
 * three to twenty pixels across in the foreground, where pass 2's street had
 * nothing at all — the forensic report called the near ground "a single low-res
 * tiled diffuse, visibly blurred by the time it reaches the bottom of the frame
 * … no scattered pebble meshes, no decals".
 */
function stoneBlob(B, mat, cx, cy, cz, r, seed, col, wear, tile = 0.30) {
  const bkt = B.bucket(mat);
  const NU = 7, NV = 5;
  const base = bkt.n;
  const h = (a, b, c) => {
    const s = Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453;
    return s - Math.floor(s);
  };
  const P = [];
  for (let j = 0; j <= NV; j++) {
    const phi = (j / NV) * Math.PI;
    for (let i = 0; i <= NU; i++) {
      const th = (i / NU) * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(th);
      const ny = Math.cos(phi);
      const nz = Math.sin(phi) * Math.sin(th);
      const d = 1
        + (h(nx * 2.7 + seed, ny * 2.7, nz * 2.7) - 0.5) * 0.46
        + (h(nx * 6.1 + seed * 2, ny * 6.1, nz * 6.1) - 0.5) * 0.22;
      P.push([cx + nx * r * d * 1.2, cy + ny * r * d * 0.55, cz + nz * r * d]);
    }
  }
  const uSpan = (2 * Math.PI * r * 1.2) / tile;
  const vSpan = (Math.PI * r * 0.75) / tile;
  for (let j = 0; j <= NV; j++) {
    for (let i = 0; i <= NU; i++) {
      const p = P[j * (NU + 1) + i];
      const rx = p[0] - cx, ry = p[1] - cy, rz = p[2] - cz;
      const rl = Math.hypot(rx, ry, rz) || 1;
      bkt.pos.push(p[0], p[1], p[2]);
      bkt.nor.push(rx / rl, ry / rl, rz / rl);
      bkt.uv.push((seed * 0.31) % 1 + (i / NU) * uSpan, (seed * 0.77) % 1 + (j / NV) * vSpan);
      bkt.col.push(col[0], col[1], col[2]);
      bkt.wear.push(p[1] - wear[0], wear[1] - p[1], wear[2], wear[3]);
    }
  }
  bkt.n += (NU + 1) * (NV + 1);
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const k = base + j * (NU + 1) + i;
      bkt.idx.push(k, k + 1, k + NU + 2, k, k + NU + 2, k + NU + 1);
    }
  }
}

/**
 * Gravel and cobbles worked out of the street surface. `spots` is a list of
 * { x, y, z, r, v } already resolved against the graded pad.
 */
export function pebbleField(B, M, spots) {
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    const wear = [s.y - 0.05, s.y + 0.6, 0.95, 0.1];
    const v = s.v;
    stoneBlob(B, M.rock, s.x, s.y, s.z, s.r, i * 3.13 + 0.7,
      // These read against sunlit street dust, so they have to sit in the same
      // value range as it; at 0.46 they metered as black specks, i.e. litter.
      [1.02 * v, 0.95 * v, 0.86 * v], wear, s.r > 0.09 ? 0.36 : 0.20);
  }
}
