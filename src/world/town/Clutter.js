import * as THREE from 'three';
import { Frame } from './Builder.js';

/**
 * Clutter — the stuff a working town accumulates, and the water it stands in.
 *
 * ============================================================================
 * WHY
 * ----------------------------------------------------------------------------
 * The blind A/B put it as "dense props stacked against every wall … crates,
 * barrels, sacks, tools, buckets, feed bags, a butter churn, brooms, lanterns,
 * water troughs, laundry on a line", against our "buildings and a clean empty
 * street". The failure is not that we had no props — we had barrels and crates
 * — it is that they were *sprinkled evenly at one per building* instead of
 * being PILED WHERE PEOPLE PUT THINGS: hard against a wall, beside a door,
 * under an awning, at the tail of a wagon. Density and clustering read as
 * habitation; an even sprinkle reads as set dressing, which is exactly the
 * pass-3 "confetti props, no massing" lesson applied to a street.
 *
 * So everything here comes in CLUSTERS anchored to a wall line, and every
 * cluster is drawn from a small vocabulary with per-item jitter, never a grid.
 *
 * ----------------------------------------------------------------------------
 * COST
 * ----------------------------------------------------------------------------
 * All of it goes into the town's existing merged material buckets, so a hundred
 * new objects is ZERO new draw calls. The only exception is the puddle sheet,
 * which needs its own transparent material and costs exactly one.
 */

const TAU = Math.PI * 2;
const W = (base, eave, grime, chalk) => [base, eave, grime, chalk];

/* -------------------------------------------------------------------------- */
/*  small goods                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Grain/flour sack. A sack is a soft body: the base spreads where it takes the
 * weight, the middle bulges, and the throat gathers to a tie. Four rings of a
 * wobbled tube gets all three for 60 triangles.
 */
export function sack(B, M, F, o = {}) {
  const h = o.h || 0.46;
  const r = o.r || 0.21;
  const col = o.col || [0.56, 0.50, 0.40];
  const wear = o.wear || W(F.oy, F.oy + 0.9, 0.85, 0.3);
  const lean = o.lean || 0;
  const p = (t, rr) => F.p(Math.sin(lean) * h * t, 0, Math.cos(lean) * h * t + rr * 0);
  void p;
  const top = F.p(Math.sin(lean) * h, 0, Math.cos(lean) * h);
  const bot = F.p(0, 0, 0.005);
  const mid = [
    bot[0] + (top[0] - bot[0]) * 0.42,
    bot[1] + (top[1] - bot[1]) * 0.42,
    bot[2] + (top[2] - bot[2]) * 0.42,
  ];
  /* Proportions matter more than detail here. A sack that tapers evenly from
     base to a point reads as a chess pawn — which is exactly what the first
     attempt looked like on the boardwalk. A real filled sack is SQUAT: it
     carries its widest point two thirds of the way up and only gathers in the
     last tenth. */
  const at = (t) => [
    bot[0] + (top[0] - bot[0]) * t,
    bot[1] + (top[1] - bot[1]) * t,
    bot[2] + (top[2] - bot[2]) * t,
  ];
  B.tube(M.canvas, bot, at(0.62), r * 1.12, r * 1.20, 8,
    { us: 0.5, vs: 0.5, col, wear, rings: 1, wobble: 0.11, phase: o.seed || 0, caps: true });
  B.tube(M.canvas, at(0.62), at(0.92), r * 1.20, r * 0.66, 8,
    { us: 0.5, vs: 0.5, col, wear, rings: 1, wobble: 0.10, phase: (o.seed || 0) + 1.7 });
  B.tube(M.canvas, at(0.92), top, r * 0.66, r * 0.34, 7,
    { us: 0.4, vs: 0.4, col: [col[0] * 0.9, col[1] * 0.9, col[2] * 0.88], wear, caps: true });
  B.tube(M.thin, at(0.93), at(0.97),
    r * 0.62, r * 0.58, 7, { us: 0.3, vs: 0.3, col: [0.42, 0.35, 0.27], wear });
}

/** Wooden pail: tapered staves, two iron hoops, a bail handle. */
export function bucket(B, M, F, o = {}) {
  const h = o.h || 0.30;
  const r = o.r || 0.15;
  const col = o.col || [0.60, 0.54, 0.44];
  const wear = o.wear || W(F.oy, F.oy + 0.6, 0.9, 0.2);
  B.tube(M.weathered, F.p(0, 0, 0.004), F.p(0, 0, h), r * 0.84, r, 9,
    { us: 0.4, vs: 0.4, col, wear, rings: 1, caps: true });
  for (const t of [0.14, 0.86]) {
    B.tube(M.rust, F.p(0, 0, h * t), F.p(0, 0, h * t + 0.024),
      r * (0.84 + 0.16 * t) * 1.03, r * (0.84 + 0.16 * t) * 1.03, 9,
      { us: 0.3, vs: 0.3, col: [0.66, 0.55, 0.44], wear });
  }
  if (o.water) {
    B.faceY(M.water, F, h - 0.045, -r * 0.86, r * 0.86, -r * 0.86, r * 0.86, +1,
      { us: 0.6, vs: 0.6, col: [1, 1, 1], wear, nu: 1, nv: 1 });
  }
  // bail: a three-segment arc, which is enough to read as a handle
  const a0 = F.p(-r, 0, h - 0.02), a1 = F.p(-r * 0.55, 0, h + 0.15);
  const a2 = F.p(r * 0.55, 0, h + 0.15), a3 = F.p(r, 0, h - 0.02);
  const ho = { us: 0.2, vs: 0.2, col: [0.60, 0.50, 0.40], wear };
  B.tube(M.thinIron, a0, a1, 0.011, 0.011, 4, ho);
  B.tube(M.thinIron, a1, a2, 0.011, 0.011, 4, ho);
  B.tube(M.thinIron, a2, a3, 0.011, 0.011, 4, ho);
}

/** Broom or pitchfork leaning on a wall. `kind` 0 broom, 1 fork, 2 shovel. */
export function tool(B, M, F, o = {}) {
  const kind = o.kind || 0;
  const len = o.len || 1.35;
  const lean = o.lean != null ? o.lean : 0.20;
  const wear = o.wear || W(F.oy, F.oy + 2.0, 0.8, 0.25);
  const col = [0.66, 0.58, 0.46];
  const p0 = F.p(0, 0, 0.01);
  const p1 = F.p(Math.sin(lean) * len * 0.0, -Math.sin(lean) * len, Math.cos(lean) * len);
  B.tube(M.thin, p0, p1, 0.019, 0.016, 5, { us: 0.3, vs: 0.6, col, wear });
  if (kind === 0) {
    // bristle head: a short flared cone at the FOOT
    const q = F.p(0, -Math.sin(lean) * 0.02, 0.20);
    B.tube(M.hay, F.p(0, 0, 0.005), q, 0.030, 0.075, 7,
      { us: 0.3, vs: 0.3, col: [0.92, 0.84, 0.62], wear, rings: 1, caps: true });
  } else if (kind === 1) {
    for (const dx of [-0.055, 0, 0.055]) {
      B.tube(M.thinIron, F.p(dx * 0.4, -Math.sin(lean) * 0.02, 0.14),
        F.p(dx, -Math.sin(lean) * 0.0, -0.03), 0.010, 0.007, 4,
        { us: 0.2, vs: 0.2, col: [0.58, 0.50, 0.42], wear });
    }
  } else {
    B.box(M.rust, F, -0.075, 0.075, -0.012, 0.012, 0.0, 0.20,
      { us: 0.3, vs: 0.3, col: [0.66, 0.58, 0.48], wear, nu: 1, nv: 1 });
  }
}

/** Ladder leaning against a wall. */
export function ladder(B, M, F, o = {}) {
  const len = o.len || 3.1;
  const wide = o.wide || 0.42;
  const lean = o.lean != null ? o.lean : 0.20;
  const col = [0.70, 0.63, 0.50];
  const wear = o.wear || W(F.oy, F.oy + len, 0.82, 0.3);
  const top = (dx) => F.p(dx, -Math.sin(lean) * len, Math.cos(lean) * len);
  for (const dx of [-wide * 0.5, wide * 0.5]) {
    B.tube(M.thin, F.p(dx, 0, 0.01), top(dx), 0.030, 0.026, 5, { us: 0.4, vs: 0.7, col, wear });
  }
  const n = Math.max(4, Math.round(len / 0.32));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const a = [
      F.p(-wide * 0.5, -Math.sin(lean) * len * t, Math.cos(lean) * len * t),
      F.p(wide * 0.5, -Math.sin(lean) * len * t, Math.cos(lean) * len * t),
    ];
    B.tube(M.thin, a[0], a[1], 0.018, 0.018, 4, { us: 0.3, vs: 0.3, col, wear });
  }
}

/** Butter churn: tapered staved barrel, lid, and a dasher standing proud. */
export function churn(B, M, F, o = {}) {
  const h = o.h || 0.62;
  const wear = o.wear || W(F.oy, F.oy + 1.0, 0.7, 0.35);
  const col = o.col || [0.76, 0.69, 0.56];
  B.tube(M.weathered, F.p(0, 0, 0.005), F.p(0, 0, h), 0.135, 0.088, 9,
    { us: 0.4, vs: 0.4, col, wear, rings: 2, caps: true, wobble: 0.03 });
  for (const t of [0.16, 0.55, 0.90]) {
    const r = 0.135 + (0.088 - 0.135) * t;
    B.tube(M.rust, F.p(0, 0, h * t), F.p(0, 0, h * t + 0.02), r * 1.05, r * 1.05, 9,
      { us: 0.3, vs: 0.3, col: [0.68, 0.57, 0.45], wear });
  }
  B.tube(M.thin, F.p(0, 0, h - 0.02), F.p(0.01, 0, h + 0.30), 0.014, 0.014, 5,
    { us: 0.2, vs: 0.3, col: [0.70, 0.63, 0.52], wear });
}

/** Stacked boards leaning on a wall — offcuts nobody threw away. */
export function boardLean(B, M, F, o = {}) {
  const n = o.n || 4;
  const wear = o.wear || W(F.oy, F.oy + 2.4, 0.85, 0.28);
  for (let i = 0; i < n; i++) {
    const len = 1.5 + (i % 3) * 0.42;
    const lean = 0.16 + (i % 4) * 0.035;
    const dx = -0.22 + i * 0.115;
    const wd = 0.10 + ((i * 7) % 5) * 0.026;
    const k = 0.82 + ((i * 5) % 4) * 0.09;
    const G = F.sub(dx, 0, 0, (i % 2 ? 1 : -1) * 0.06);
    B.quad(M.weathered,
      G.p(-wd * 0.5, 0.0, 0.005), G.p(wd * 0.5, 0.0, 0.005),
      G.p(wd * 0.5, -Math.sin(lean) * len, Math.cos(lean) * len),
      G.p(-wd * 0.5, -Math.sin(lean) * len, Math.cos(lean) * len),
      { us: 0.5, vs: 0.9, col: [0.66 * k, 0.60 * k, 0.50 * k], wear, nu: 1, nv: 2 });
    B.quad(M.weathered,
      G.p(wd * 0.5, -0.02, 0.005), G.p(-wd * 0.5, -0.02, 0.005),
      G.p(-wd * 0.5, -Math.sin(lean) * len - 0.02, Math.cos(lean) * len),
      G.p(wd * 0.5, -Math.sin(lean) * len - 0.02, Math.cos(lean) * len),
      { us: 0.5, vs: 0.9, col: [0.48 * k, 0.43 * k, 0.36 * k], wear, nu: 1, nv: 2 });
  }
}

/** Cast-iron pump on a plank plinth, with a wet stain under the spout. */
export function waterPump(B, M, F, o = {}) {
  const wear = o.wear || W(F.oy, F.oy + 1.6, 0.95, 0.15);
  const col = [0.52, 0.45, 0.39];
  B.box(M.weathered, F, -0.30, 0.30, -0.30, 0.30, 0, 0.10,
    { us: 0.5, vs: 0.3, col: [0.62, 0.56, 0.46], wear, nu: 1, nv: 1 });
  B.tube(M.rust, F.p(0, 0, 0.10), F.p(0, 0, 1.02), 0.062, 0.050, 8,
    { us: 0.4, vs: 0.6, col, wear, rings: 1, caps: true });
  // spout
  B.tube(M.rust, F.p(0, 0, 0.86), F.p(0, -0.30, 0.74), 0.036, 0.030, 6,
    { us: 0.3, vs: 0.3, col, wear, caps: true });
  // handle
  B.tube(M.thinIron, F.p(0, 0.05, 1.00), F.p(0, 0.44, 1.20), 0.020, 0.016, 5,
    { us: 0.2, vs: 0.3, col: [0.50, 0.44, 0.38], wear });
}

/**
 * Laundry on a line. A real catenary with sheets and shirts hung over it —
 * double sided, lightly billowed, and slightly different on each side so it
 * does not read as cardboard. This is the single most legible "people live
 * here" prop in the vocabulary and it costs ~200 triangles.
 */
export function laundryLine(B, M, p0, p1, o = {}) {
  const rand = o.rand || (() => 0.5);
  const sag = o.sag != null ? o.sag : 0.42;
  const wear = W(Math.min(p0[1], p1[1]) - 2.0, Math.max(p0[1], p1[1]) + 0.4, 0.35, 0.5);
  const at = (t) => [
    p0[0] + (p1[0] - p0[0]) * t,
    p0[1] + (p1[1] - p0[1]) * t - sag * Math.sin(Math.PI * t),
    p0[2] + (p1[2] - p0[2]) * t,
  ];
  const segs = 10;
  let prev = at(0);
  for (let i = 1; i <= segs; i++) {
    const q = at(i / segs);
    B.tube(M.thin, prev, q, 0.010, 0.010, 4,
      { us: 0.2, vs: 0.4, col: [0.60, 0.55, 0.46], wear });
    prev = q;
  }
  // direction along the line, and a horizontal perpendicular for the cloth
  let dx = p1[0] - p0[0], dz = p1[2] - p0[2];
  const L = Math.hypot(dx, dz) || 1;
  dx /= L; dz /= L;
  const px = -dz, pz = dx;
  const n = o.count || 5;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.6 + rand() * 0.5) / (n + 0.6);
    const c = at(t);
    const wd = 0.34 + rand() * 0.44;
    const hh = 0.42 + rand() * 0.62;
    const v = 0.78 + rand() * 0.42;
    const tint = rand() < 0.3
      ? [0.62 * v, 0.60 * v, 0.56 * v]
      : [0.96 * v, 0.93 * v, 0.86 * v];
    const bill = (rand() - 0.5) * 0.20;
    /* Hung cloth is a quad on each side of the line, both bellied outward by
       the same wind so the garment has a body instead of a crease. */
    for (const s of [-1, 1]) {
      const off = s * 0.02;
      const a = [c[0] - dx * wd * 0.5 + px * off, c[1], c[2] - dz * wd * 0.5 + pz * off];
      const b = [c[0] + dx * wd * 0.5 + px * off, c[1], c[2] + dz * wd * 0.5 + pz * off];
      const belly = px * (bill + s * 0.055) * 1.0;
      const bellz = pz * (bill + s * 0.055) * 1.0;
      const d = [a[0] + belly, a[1] - hh, a[2] + bellz];
      const e = [b[0] + belly, b[1] - hh * (0.88 + rand() * 0.2), b[2] + bellz];
      const oo = {
        us: 0.7, vs: 0.7, wear, nu: 2, nv: 3,
        col: (p, u, vv) => [
          tint[0] * (1 - vv * 0.14), tint[1] * (1 - vv * 0.145), tint[2] * (1 - vv * 0.15),
        ],
        warp: (u, vv, p) => {
          p[0] += px * Math.sin(u * 5.4 + i) * 0.028 * vv;
          p[2] += pz * Math.sin(u * 5.4 + i) * 0.028 * vv;
        },
      };
      if (s > 0) B.quad(M.canvas, a, b, e, d, oo);
      else B.quad(M.canvas, b, a, d, e, oo);
    }
  }
}

/**
 * A cluster of goods against a wall. `n` items drawn from the vocabulary,
 * packed along the wall line with real overlap and stacking, never on a grid.
 * `F` is a frame whose local +x runs ALONG the wall and +z runs AWAY from it,
 * origin on the deck at the wall face.
 */
export function goodsPile(B, M, F, rand, o = {}) {
  const n = o.n || 5;
  const span = o.span || 2.6;
  const deck = F.oy;
  const wear = W(deck, deck + 1.3, o.grime != null ? o.grime : 0.88, 0.28);
  let x = -span * 0.5;
  for (let i = 0; i < n && x < span * 0.5; i++) {
    const kind = rand();
    const z = 0.22 + rand() * 0.34;
    if (kind < 0.24) {
      const r = 0.25 + rand() * 0.06;
      const G = new Frame(...F.p(x + r, z + r * 0.2, 0), F.ax, F.az);
      barrelLike(B, M, G, r, 0.74 + rand() * 0.18, rand, wear);
      x += r * 2.1 + rand() * 0.12;
    } else if (kind < 0.50) {
      // crates, sometimes stacked two or three high with a lean
      const s = 0.42 + rand() * 0.24;
      const stack = rand() < 0.45 ? (rand() < 0.30 ? 3 : 2) : 1;
      for (let k = 0; k < stack; k++) {
        const a = (rand() - 0.5) * 0.35;
        const G = new Frame(...F.p(x + s * 0.5 + (rand() - 0.5) * 0.07 * k,
          z + (rand() - 0.5) * 0.06 * k, k * (s * 0.86 + 0.012)),
        F.ax * Math.cos(a) + F.bx * Math.sin(a), F.az * Math.cos(a) + F.bz * Math.sin(a));
        crateLike(B, M, G, s * (1 - k * 0.08), rand, wear);
      }
      x += s + rand() * 0.14;
    } else if (kind < 0.72) {
      // sacks — the pile is what sells it, so two or three leaning together
      const m = 1 + ((rand() * 3) | 0);
      for (let k = 0; k < m; k++) {
        const a = rand() * TAU;
        const G = new Frame(...F.p(x + 0.20 + k * 0.10, z + (rand() - 0.5) * 0.22, 0),
          Math.cos(a), Math.sin(a));
        sack(B, M, G, {
          h: 0.40 + rand() * 0.16, r: 0.19 + rand() * 0.05,
          lean: (rand() - 0.5) * 0.7, seed: rand() * 6, wear,
          col: [0.50 + rand() * 0.20, 0.45 + rand() * 0.16, 0.35 + rand() * 0.12],
        });
      }
      x += 0.40 + rand() * 0.2;
    } else if (kind < 0.83) {
      const G = new Frame(...F.p(x + 0.17, z, 0), F.ax, F.az);
      bucket(B, M, G, {
        r: 0.13 + rand() * 0.04, h: 0.26 + rand() * 0.08,
        water: rand() < 0.4, wear,
      });
      x += 0.36 + rand() * 0.14;
    } else if (kind < 0.92) {
      const G = new Frame(...F.p(x + 0.10, 0.10, 0), F.ax, F.az);
      tool(B, M, G, { kind: (rand() * 3) | 0, len: 1.2 + rand() * 0.5, lean: 0.14 + rand() * 0.1, wear });
      x += 0.26 + rand() * 0.2;
    } else {
      const G = new Frame(...F.p(x + 0.16, z, 0), F.ax, F.az);
      churn(B, M, G, { h: 0.54 + rand() * 0.14, wear });
      x += 0.40;
    }
  }
}

function barrelLike(B, M, F, r, h, rand, wear) {
  const col = [0.60 + rand() * 0.20, 0.52 + rand() * 0.16, 0.41 + rand() * 0.12];
  const p0 = F.p(0, 0, 0.004), p1 = F.p(0, 0, h);
  B.tube(M.weathered, p0, p1, r * 0.86, r * 0.86, 10,
    { us: 0.55, vs: 0.55, col, wear, rings: 3, wobble: 0.055, caps: true, phase: rand() * 6 });
  for (const t of [0.13, 0.44, 0.60, 0.88]) {
    const a = [p0[0], p0[1] + (p1[1] - p0[1]) * t, p0[2]];
    const b = [p0[0], p0[1] + (p1[1] - p0[1]) * (t + 0.035), p0[2]];
    B.tube(M.rust, a, b, r * 0.90, r * 0.90, 10,
      { us: 0.3, vs: 0.3, col: [0.66, 0.55, 0.43], wear });
  }
}

function crateLike(B, M, F, s, rand, wear) {
  const col = [0.76 + rand() * 0.16, 0.66 + rand() * 0.13, 0.51 + rand() * 0.11];
  const d = s * (0.80 + rand() * 0.32), hh = s * (0.80 + rand() * 0.18);
  B.box(M.weathered, F, -s * 0.5, s * 0.5, -d * 0.5, d * 0.5, 0, hh,
    { us: 0.6, vs: 0.22, col, wear, nv: 3 });
  const bc = [col[0] * 0.84, col[1] * 0.84, col[2] * 0.84];
  const bo = { us: 0.4, vs: 0.4, col: bc, wear, nu: 1, nv: 1 };
  for (const sx of [-s * 0.5, s * 0.5 - 0.045]) {
    B.box(M.weathered, F, sx, sx + 0.045, -d * 0.5 - 0.010, d * 0.5 + 0.010, 0.02, hh - 0.02, bo);
  }
  B.box(M.weathered, F, -s * 0.5 - 0.010, s * 0.5 + 0.010, -d * 0.5, -d * 0.5 + 0.045, 0.02, hh - 0.02, bo);
}

/* -------------------------------------------------------------------------- */
/*  signage layering                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A paper bill pasted on a wall. `F` is a building frame: local +x runs along
 * the facade, local +z points AWAY from the street, so the wall face the street
 * sees is at a small negative z.
 *
 * The handedness trap here is the same one that once rendered every sign in
 * town as mirror writing — see Props.signBoard. A viewer on the street looks
 * along +ez, for whom screen-right is -ex, so the atlas u axis is reversed.
 */
export function postedBill(B, M, F, o) {
  const { x, y, w, h, z, uv, wear } = o;
  const tilt = o.tilt || 0;
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const p = (dx, dy) => F.p(x + dx * c - dy * s, z, y + dx * s + dy * c);
  const b0 = p(-w * 0.5, -h * 0.5), b1 = p(w * 0.5, -h * 0.5);
  const t1 = p(w * 0.5, h * 0.5), t0 = p(-w * 0.5, h * 0.5);
  const bkt = B.bucket(M.sign);
  const k = bkt.n;
  const pts = [b1, b0, t0, t1];
  const uvs = [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]];
  const nx = -F.bx, nz = -F.bz;
  for (let i = 0; i < 4; i++) {
    const q = pts[i];
    bkt.pos.push(q[0], q[1], q[2]);
    bkt.nor.push(nx, 0, nz);
    bkt.uv.push(uvs[i][0], uvs[i][1]);
    bkt.col.push(1, 1, 1);
    bkt.wear.push(q[1] - wear[0], wear[1] - q[1], wear[2] * 0.8, 0.85);
  }
  bkt.n += 4;
  bkt.idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
}

/**
 * Canvas awning over a shop front: a sloping sheet from the wall out to a pair
 * of rods, with a scalloped valance hanging off the front edge.
 *
 * This exists for the SHADOW as much as the shape. Every reference frame of an
 * inhabited street has a deep dark band along the shopfronts, and that band is
 * what gives the row its tonal range — without it every facade sits in the same
 * sunlit midtone, which is the "washed out, narrow hazy midtone band" verdict
 * applied to architecture.
 */
export function awning(B, M, F, o = {}) {
  const w = o.w || 4.0;
  const depth = o.depth || 2.15;
  const yWall = o.yWall || 3.05;
  const yOut = o.yOut || 2.55;
  const wear = o.wear || W(F.oy, F.oy + yWall + 0.5, 0.55, 0.45);
  const stripe = o.stripe || [[0.80, 0.74, 0.62], [0.52, 0.40, 0.34]];
  const n = Math.max(4, Math.round(w / 0.52));
  const z0 = -0.05, z1 = -depth;
  for (let i = 0; i < n; i++) {
    const x0 = -w * 0.5 + (w * i) / n;
    const x1 = -w * 0.5 + (w * (i + 1)) / n;
    const c = stripe[i % 2];
    const k = 0.94 + ((i * 5) % 3) * 0.04;
    const col = [c[0] * k, c[1] * k, c[2] * k];
    /* a sag between the rods so the sheet has weight */
    B.quad(M.canvas,
      F.p(x0, z0, yWall), F.p(x1, z0, yWall),
      F.p(x1, z1, yOut), F.p(x0, z1, yOut),
      {
        us: 0.8, vs: 0.8, col, wear, nu: 1, nv: 3,
        warp: (u, v, p) => { p[1] -= Math.sin(v * Math.PI) * 0.055; },
      });
    // valance
    B.quad(M.canvas,
      F.p(x1, z1, yOut), F.p(x0, z1, yOut),
      F.p(x0, z1, yOut - 0.26 - ((i % 2) * 0.05)), F.p(x1, z1, yOut - 0.26 - ((i % 2) * 0.05)),
      { us: 0.6, vs: 0.6, col: [col[0] * 0.88, col[1] * 0.88, col[2] * 0.88], wear, nu: 1, nv: 1 });
  }
  // rods + tie-back struts
  for (const sx of [-w * 0.5, w * 0.5]) {
    B.tube(M.thinIron, F.p(sx, z0, yWall), F.p(sx, z1, yOut), 0.020, 0.020, 4,
      { us: 0.3, vs: 0.5, col: [0.52, 0.46, 0.38], wear });
    B.tube(M.thinIron, F.p(sx, z1, yOut), F.p(sx, z0 - 0.02, yOut - 0.95), 0.014, 0.014, 4,
      { us: 0.3, vs: 0.5, col: [0.52, 0.46, 0.38], wear });
  }
  B.tube(M.thinIron, F.p(-w * 0.5, z1, yOut), F.p(w * 0.5, z1, yOut), 0.018, 0.018, 4,
    { us: 0.3, vs: 0.5, col: [0.52, 0.46, 0.38], wear });
}

/* -------------------------------------------------------------------------- */
/*  standing water                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Puddles in the wheel ruts and the hollows.
 *
 * The reference street is WET: standing water in the ruts with real reflections
 * and a sheen that changes with the light. Ours was bone-dry tiled sand, which
 * is most of why the ground read as a texture rather than a surface.
 *
 * Each puddle is an irregular disc lofted onto the graded street a couple of
 * centimetres above it, with a low-roughness dark surface (so it takes a long
 * specular smear off a low sun, which is what "wet" actually looks like) and a
 * per-vertex ALPHA that feathers the rim into the mud. Alpha rides an RGBA
 * `color` attribute, which is what three needs to define USE_COLOR_ALPHA — the
 * same trick the campfire ash decal uses, and for the same reason: a hard
 * polygon boundary on the ground is the loudest synthetic edge there is.
 *
 * @param {Array<{s:number,t:number,r:number,depth:number}>} spots
 * @param {(s:number,t:number)=>number} heightAt
 * @param {(s:number,t:number)=>number[]} xzAt
 * @returns {THREE.BufferGeometry}
 */
export function buildPuddles(spots, heightAt, xzAt, rand) {
  const pos = [], nor = [], uv = [], col = [], idx = [];
  const SECT = 14, RINGS = 3;
  let n = 0;
  for (let q = 0; q < spots.length; q++) {
    const sp = spots[q];
    const ph = [rand() * TAU, rand() * TAU, rand() * TAU];
    const ax = 1.0 + rand() * 0.7;                 // puddles elongate along the rut
    const rimAt = (a) => sp.r * (1
      + 0.20 * Math.sin(a * 2 + ph[0])
      + 0.11 * Math.sin(a * 3 + ph[1])
      + 0.06 * Math.sin(a * 5 + ph[2]));
    const base = n;
    for (let j = 0; j <= RINGS; j++) {
      const t = j / RINGS;
      for (let i = 0; i <= SECT; i++) {
        const a = (i / SECT) * TAU;
        const rr = rimAt(a) * t;
        const ss = sp.s + Math.cos(a) * rr * ax;
        const tt = sp.t + Math.sin(a) * rr;
        const p = xzAt(ss, tt);
        /* WATER IS FLAT — but a flat disc laid on a crowned, rutted street is
         * BELOW that street everywhere except its lowest point, and the road
         * then depth-tests in front of it. The first build was invisible for
         * exactly this reason: it rendered perfectly, three metres in the air.
         *
         * So the sheet is max(pool level, ground) + a film thickness: a true
         * flat pool wherever the ground is below the water line, thinning to a
         * wet FILM over the shoulders, which is what shallow standing water on
         * an uneven surface actually does. Alpha rides the depth, so the middle
         * is opaque water and the edge is a damp sheen that fades out. */
        const gy = heightAt ? heightAt(ss, tt) : sp.y;
        const depth = sp.y - gy;
        const y = Math.max(sp.y, gy) + 0.013;
        pos.push(p[0], y, p[1]);
        nor.push(0, 1, 0);
        uv.push(p[0] * 0.6, p[1] * 0.6);
        const fade = 1 - Math.min(1, Math.max(0, (t - 0.34) / 0.66));
        const wetK = Math.min(1, Math.max(0.22, 0.30 + depth / 0.045));
        const alpha = j === RINGS ? 0
          : Math.min(1, (0.30 + 0.85 * fade * fade) * wetK);
        // dark, slightly cool: silt-laden water over packed earth
        const k = 0.90 + 0.16 * Math.sin(a * 7.1 + t * 9.3);
        col.push(0.075 * k, 0.072 * k, 0.070 * k, alpha);
        n++;
      }
    }
    const row = SECT + 1;
    for (let j = 0; j < RINGS; j++) {
      for (let i = 0; i < SECT; i++) {
        const k = base + j * row + i;
        idx.push(k, k + row, k + row + 1, k, k + row + 1, k + 1);
      }
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx.length > 65000 ? new THREE.Uint32BufferAttribute(idx, 1)
    : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}
