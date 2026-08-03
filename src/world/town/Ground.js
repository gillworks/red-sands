/**
 * Ground — the graded town pad, the wheel-rutted street surface, and the
 * boardwalks that tie the two rows of facades together.
 *
 * The pad is a single (s, t) grid lofted onto the street spine.
 *
 * CONFORMED PATH (`o.conform`, the one that runs now)
 * ---------------------------------------------------
 * Terrain has already published the graded shelf through `ctx.world.getHeight`
 * — see town/Pad.js for how and why — so this surface is a SKIN a few
 * centimetres thick over the ground the query reports:
 *
 *   h = terrain(x,z) + skin + feather * (skinCrown + padMicro(s,t))
 *
 * Every vertex samples `getHeight` at its own position, so the roadway can
 * never drift away from the query the player stands on: the whole street is
 * within 1–11 cm of `ctx.world.getHeight` instead of the 0.4–1.4 m it used to
 * float. The macro shape (crown, verge, churn) now lives in the height query;
 * only the sub-metre wheel ruts stay on the mesh, because the override grid
 * cannot hold them.
 *
 * LEGACY PATH (no pad registered)
 * -------------------------------
 *   h = terrain + (grade - terrain) * feather
 *
 * kept so the town still builds if the pad was never registered.
 *
 * Either way the last ring is dropped a metre so the edge is buried inside the
 * hillside instead of z-fighting against it, and the surface is never flat: a
 * crown falling to the verges, two pairs of wheel ruts that wander either side
 * of true, hoof-churn, and noise on top. That relief is what stops the street
 * reading as a painted plane in raking light.
 */

import {
  RUTS, fbm2, smooth, padMicro, padRelief, TOWN_PLAN,
} from './Pad.js';

const TAU = Math.PI * 2;

/**
 * Build the graded pad.
 * @returns {{height:(s:number,t:number)=>number}} sampler for everything else
 */
export function buildPad(B, mat, street, o) {
  const { sMin, sMax, plateau, rim, getHeight } = o;
  const conform = !!o.conform;

  /*
   * CROSS-SECTION SAMPLING — why this is non-uniform.
   *
   * The pad used to be a regular 2.6 x 1.9 m grid. The wheel ruts are Gaussians
   * of sigma ~0.39 m centred at t = ±2.3 and ±5.5; on a 1.9 m lattice the
   * nearest vertex to a rut centre-line is typically 0.7 m away, where the rut
   * profile has already fallen to 0.4 of its depth, and the vertex on the other
   * side is at 1.2 m where it is 0.07. So both the 5 cm of geometry and the 44%
   * tonal darkening were being sampled at roughly a third of their amplitude and
   * then linearly interpolated across a metre and a half. That is why pass 10's
   * main street was a flat sand plane with a wide soft smudge on it — the ruts
   * were in the code and never made it into a vertex.
   *
   * The travelled way is therefore tessellated at ~0.40 m, which resolves the
   * rut profile properly, and the verges stay coarse. Cost is ~7k extra
   * triangles on a shot that draws 2.06M.
   */
  const dS = 2.2;
  const ROAD_T = 10.0;          // half-width of the finely tessellated way
  const dTRoad = 0.40, dTVerge = 1.9;
  const tTable = [];
  {
    const nV = Math.ceil((rim - ROAD_T) / dTVerge);
    for (let i = nV; i >= 1; i--) tTable.push(-ROAD_T - (i / nV) * (rim - ROAD_T));
    const nR = Math.round((ROAD_T * 2) / dTRoad);
    for (let i = 0; i <= nR; i++) tTable.push(-ROAD_T + (i / nR) * ROAD_T * 2);
    for (let i = 1; i <= nV; i++) tTable.push(ROAD_T + (i / nV) * (rim - ROAD_T));
  }
  const nS = Math.ceil((sMax - sMin) / dS);
  const nT = tTable.length - 1;
  const bkt = B.bucket(mat);
  const base = bkt.n;
  const row = nS + 1;

  /* --- surface model ---------------------------------------------------- */
  const relief = padRelief;

  const heightOf = (s, t) => {
    const p = street.xz(s, t);
    const ter = getHeight(p[0], p[1]);
    const at = Math.abs(t);
    const f = 1 - smooth(plateau, rim - 3.0, at);
    if (conform) {
      /* The QUERY already is the grade here. Skin it: a constant few
       * centimetres so the road never z-fights whatever is beneath it, a touch
       * more across the plateau, and the sub-metre ruts the override grid
       * cannot carry. Bounded above by ~9 cm and never negative, so the road
       * can neither float above the query nor sink through the ground. */
      const h = ter + TOWN_PLAN.skin + f * (TOWN_PLAN.skinCrown + padMicro(s, t));
      return { h, f, p, ter };
    }
    const g = street.gradeAt(s) + relief(s, t);
    let h = ter + (g - ter) * f;
    /* Minimum lift over natural ground. Two jobs: it guarantees the pad never
     * z-fights the terrain clipmap, and 22 cm of made ground buries the small
     * scatter and undergrowth that other systems seed from the *terrain*
     * height — a main street sprouting scrub between the wheel ruts is the
     * fastest way to un-sell a settlement. */
    const lift = 0.05 + 0.17 * f;
    if (f > 0.02 && h < ter + lift) h = ter + lift;
    return { h, f, p, ter };
  };

  const P = new Array((nS + 1) * (nT + 1));
  const C = new Array((nS + 1) * (nT + 1));
  for (let j = 0; j <= nT; j++) {
    const t = tTable[j];
    for (let i = 0; i <= nS; i++) {
      const s = sMin + (i / nS) * (sMax - sMin);
      const { h, f, p } = heightOf(s, t);
      const edge = (i === 0 || i === nS || j === 0 || j === nT) ? 1 : 0;
      P[j * row + i] = [p[0], h - edge * 1.4, p[1]];

      /* --- surface colouring -------------------------------------------- */
      const at = Math.abs(t);
      const road = 1 - smooth(8.4, 14.0, at);
      const dust = fbm2(p[0] * 0.06, p[1] * 0.06);
      const fine = fbm2(p[0] * 0.5, p[1] * 0.5);
      // pale, bleached, wheel-polished dust in the travelled way…
      // The travelled way is DARKER and greyer than the verge: hoof and wheel
      // traffic packs it, and packed damp earth is the one thing that makes a
      // street read as a street rather than as more desert.
      let k = 1.05 - 0.24 * road + 0.26 * (dust - 0.5) + 0.10 * (fine - 0.5);
      /* …darker damp earth in the ruts, and a pale wheel-polished shoulder on
         either side of each one. The rut wanders with chainage exactly as the
         geometry does (same fbm, same phase) or the tone and the relief would
         come apart and read as a painted stripe. */
      const wander = (fbm2(s * 0.035 + 4.1, 0) - 0.5) * 1.6;
      let rut = 0, shoulder = 0;
      for (const rt of RUTS) {
        const d = t - (rt + wander * (rt > 0 ? 1 : -1) * 0.5);
        rut = Math.max(rut, Math.exp(-(d * d) / 0.50));
        const ad = Math.abs(d);
        shoulder = Math.max(shoulder, Math.exp(-((ad - 0.95) ** 2) / 0.28));
      }
      /* 0.46 was the pass-10 number and it was tuned against a lattice that
         only ever sampled a third of it. Sampled properly it drew two black
         hairlines down the street that read as cables, not as ruts — packed
         earth in a wheel track is maybe a fifth darker than the dust beside it,
         not half. */
      k *= 1 - rut * 0.27 * road;
      k *= 1 + shoulder * 0.085 * road * (1 - rut);
      /* --- damp ground -----------------------------------------------------
       * The A/B verdict on the ground was "a flat tiled sand/dirt texture"
       * against a reference of "mud, standing water, cart ruts, hoof prints
       * and a wet sheen". Standing water is geometry (see Clutter.buildPuddles)
       * but MUD is tone: irregular metre-scale patches where the traffic has
       * churned damp earth up, two thirds the value of the dry dust around
       * them and a good deal cooler. Without this the puddles sit on a pale
       * beach with no transition, which reads worse than no puddles at all.  */
      const wet = Math.max(0, Math.min(1,
        (fbm2(p[0] * 0.085 + 23.7, p[1] * 0.085 - 11.3) - 0.44) * 3.4))
        * (0.34 + 0.66 * road) * (0.55 + 0.45 * rut);
      k *= 1 - wet * 0.13;
      const warm = 1 - 0.05 * road + 0.04 * (1 - road);
      C[j * row + i] = [
        k * warm * (1 - f * 0.02) * (1 - wet * 0.05),
        k * (0.955 - 0.01 * road) * (1 - wet * 0.02),
        k * (0.855 - 0.03 * road) * (1 - rut * 0.08),
      ];
    }
  }

  const wear = [0, 0, 0.9, 0.25];
  for (let j = 0; j <= nT; j++) {
    for (let i = 0; i <= nS; i++) {
      const k = j * row + i;
      const p = P[k];
      const iL = P[j * row + Math.max(0, i - 1)];
      const iR = P[j * row + Math.min(nS, i + 1)];
      const jD = P[Math.max(0, j - 1) * row + i];
      const jU = P[Math.min(nT, j + 1) * row + i];
      const ax = iR[0] - iL[0], ay = iR[1] - iL[1], az = iR[2] - iL[2];
      const bx = jU[0] - jD[0], by = jU[1] - jD[1], bz = jU[2] - jD[2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const L = Math.hypot(nx, ny, nz) || 1;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      bkt.pos.push(p[0], p[1], p[2]);
      bkt.nor.push(nx / L, ny / L, nz / L);
      bkt.uv.push(p[0] / 1.9, p[2] / 1.9);
      const c = C[k];
      bkt.col.push(c[0], c[1], c[2]);
      bkt.wear.push(2.0, -9, wear[2], wear[3]);
    }
  }
  bkt.n += (nS + 1) * (nT + 1);
  for (let j = 0; j < nT; j++) {
    for (let i = 0; i < nS; i++) {
      const k = base + j * row + i;
      bkt.idx.push(k, k + row, k + row + 1, k, k + row + 1, k + 1);
    }
  }

  return {
    /** Height of the finished street surface at (s,t). */
    height: (s, t) => heightOf(s, t).h,
    relief,
  };
}

/**
 * Boardwalk run along one side, from chainage s0 to s1 at cross-position
 * [tIn, tOut] (tIn is nearer the buildings). Planks run ACROSS the walk, which
 * is how they were actually laid, and every one of them is a slightly different
 * width, value and height. Roughly one in forty is missing.
 */
export function boardwalk(B, M, street, o) {
  const { s0, s1, side, tIn, tOut, rand, deckY } = o;
  const wearOf = (y) => [y - 0.44, y + 3.2, 0.92, 0.28];
  const inner = side * tIn, outer = side * tOut;
  let s = s0;
  const pushPlank = (sa, sb, drop, col, hi) => {
    const y0 = deckY(sa) + drop;
    const y1 = deckY(sb) + drop;
    const A = street.xz(sa, inner), Bp = street.xz(sb, inner);
    const Cp = street.xz(sb, outer), D = street.xz(sa, outer);
    const wear = wearOf(y0);
    const a = [A[0], y0 + hi, A[1]];
    const b = [Bp[0], y1 + hi, Bp[1]];
    const c = [Cp[0], y1 + hi * 0.7, Cp[1]];
    const d = [D[0], y0 + hi * 0.7, D[1]];
    /* Deck. u runs along the street, v runs from the facade toward the road;
       for side +1 that pair already gives an up-facing normal, for side -1 the
       cross product flips, so the two corners are swapped. */
    if (side > 0) B.quad(M.weathered, a, b, c, d, { us: 1.2, vs: 0.30, col, wear, nu: 1, nv: 2 });
    else B.quad(M.weathered, a, d, c, b, { us: 1.2, vs: 0.30, col, wear, nu: 1, nv: 2 });
    // street-side edge of the plank, so the deck has thickness
    const dl = [d[0], d[1] - 0.085, d[2]];
    const cl = [c[0], c[1] - 0.085, c[2]];
    const eo = { us: 0.6, vs: 0.3, col: [col[0] * 0.66, col[1] * 0.66, col[2] * 0.66], wear, nu: 1, nv: 1 };
    if (side > 0) B.quad(M.weathered, d, c, cl, dl, eo);
    else B.quad(M.weathered, c, d, dl, cl, eo);
  };

  while (s < s1) {
    const w = 0.20 + rand() * 0.11;
    const gap = 0.012 + rand() * 0.028;
    const sa = s, sb = Math.min(s1, s + w);
    if (sb - sa > 0.05) {
      const miss = rand() < 0.022;
      if (!miss) {
        const v = 0.78 + rand() * 0.42;
        const grey = 0.94 + rand() * 0.10;
        const col = [0.72 * v * grey, 0.68 * v * grey, 0.62 * v];
        // long-term sag between the joists (2.4 m bearer spacing)
        const bend = Math.sin(((sa - s0) / 2.4) * TAU) * 0.012;
        pushPlank(sa, sb, bend - 0.004 + (rand() - 0.5) * 0.012, col,
          rand() < 0.06 ? 0.022 : 0);
      }
    }
    s = sb + gap;
  }

  /* --- outer skirt board + joists + support posts ------------------------ */
  const NS = Math.max(2, Math.round((s1 - s0) / 2.4));
  for (let i = 0; i <= NS; i++) {
    const ss = s0 + ((s1 - s0) * i) / NS;
    const y = deckY(ss);
    const a = street.xz(ss, outer);
    const bx = street.xz(ss, side * (tOut - 0.12));
    const wear = wearOf(y);
    // post down to the street
    B.tube(M.weathered, [a[0], y - 0.06, a[1]], [a[0], y - 0.95, a[1]],
      0.085, 0.075, 5, { us: 0.5, vs: 0.6, col: [0.60, 0.55, 0.47], wear, wobble: 0.06, phase: i });
    void bx;
  }
  // continuous skirt
  const segs = Math.max(2, Math.round((s1 - s0) / 3.0));
  for (let i = 0; i < segs; i++) {
    const sa = s0 + ((s1 - s0) * i) / segs;
    const sb = s0 + ((s1 - s0) * (i + 1)) / segs;
    const ya = deckY(sa), yb = deckY(sb);
    const A = street.xz(sa, outer), Bp = street.xz(sb, outer);
    const wear = wearOf(ya);
    const v = 0.82 + ((i * 7) % 5) * 0.06;
    const col = [0.58 * v, 0.54 * v, 0.47 * v];
    const dz = side * 0.05;
    const nx = street.normalRaw(sa);
    B.quad(M.weathered,
      [Bp[0] + nx[0] * dz, yb - 0.42, Bp[1] + nx[1] * dz],
      [A[0] + nx[0] * dz, ya - 0.42, A[1] + nx[1] * dz],
      [A[0] + nx[0] * dz, ya - 0.04, A[1] + nx[1] * dz],
      [Bp[0] + nx[0] * dz, yb - 0.04, Bp[1] + nx[1] * dz],
      { us: 1.2, vs: 0.42, col, wear, nv: 1 });
  }
}

/**
 * Two or three treads down from the boardwalk into the roadway. Each tread
 * steps OUTWARD (toward the street centreline) and downward, and gets a riser
 * face so the flight reads in raking light.
 */
export function steps(B, M, street, o) {
  const { s, side, tOut, rand, deckY } = o;
  const y = deckY(s);
  const wear = [y - 0.6, y + 2.0, 0.95, 0.2];
  const halfW = 0.78 + rand() * 0.4;
  const RUN = 0.34, RISE = 0.135;
  for (let k = 0; k < 3; k++) {
    const ty = y - RISE * (k + 1);
    const t0 = side * (tOut - 0.02 - k * RUN);
    const t1 = side * (tOut - 0.02 - (k + 1) * RUN);
    const A = street.xz(s - halfW, t0), Bp = street.xz(s + halfW, t0);
    const Cp = street.xz(s + halfW, t1), D = street.xz(s - halfW, t1);
    const v = 0.80 + rand() * 0.3;
    const col = [0.66 * v, 0.61 * v, 0.53 * v];
    const a = [A[0], ty, A[1]], b = [Bp[0], ty, Bp[1]];
    const c = [Cp[0], ty, Cp[1]], d = [D[0], ty, D[1]];
    const to = { us: 1.0, vs: 0.3, col, wear, nu: 2, nv: 1 };
    if (side > 0) B.quad(M.weathered, a, b, c, d, to);
    else B.quad(M.weathered, a, d, c, b, to);
    // riser under the nose of the tread
    const dl = [d[0], ty - RISE, d[2]], cl = [c[0], ty - RISE, c[2]];
    const ro = { us: 1.0, vs: 0.3, col: [col[0] * 0.66, col[1] * 0.66, col[2] * 0.66], wear, nu: 2, nv: 1 };
    if (side > 0) B.quad(M.weathered, d, c, cl, dl, ro);
    else B.quad(M.weathered, c, d, dl, cl, ro);
  }
}
