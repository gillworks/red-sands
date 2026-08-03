import { Frame } from './Builder.js';

/**
 * Buildings — parameterised frontier masses.
 *
 * Everything is authored in a per-building frame: +x runs along the street
 * (building width), +z runs AWAY from the street (depth), y is up and LOCAL
 * y = 0 is the floor line. The street facade sits at z = 0.
 *
 * Silhouette is the whole game in a western town, so the generator leans on:
 *   • FALSE FRONTS — a tall flat screen wall of real 0.28 m thickness hiding a
 *     smaller gabled or shed-roofed building behind it, with side returns, a
 *     stepped / pedimented cap and a projecting cornice that throws a hard
 *     shadow line down the facade.
 *   • height / pitch / footprint variance, and ridge lines that sag.
 *   • real construction — stone plinths, skirt boards, corner boards, window
 *     reveals with interior darkness behind the glass, porch posts with knee
 *     braces, balconies, chimneys.
 */

/* Texture tiling, in metres per texture tile, per surface. */
/*
 * Texture tiling, in METRES PER TEXTURE TILE, per surface. These were twice
 * this size in the first build of pass 2 and the result was unmistakable: the
 * livery read as a barn built out of 1.2 m planks and the sheriff's adobe as
 * masonry with 2 m stones. A procTexture tile carries roughly four boards, so
 * a 1.6 m tile is a 400 mm board — already generous.
 */
export const UV = {
  wall: { us: 1.30, vs: 0.62 },      // ~150 mm clapboard reveal
  wallV: { us: 1.05, vs: 1.30, rot: 1 }, // board-and-batten: UVs rotated 90 deg
  roof: { us: 1.45, vs: 1.45 },      // shingle courses
  iron: { us: 0.85, vs: 1.70 },      // ~100 mm corrugation pitch
  stone: { us: 1.30, vs: 1.30 },
  adobe: { us: 1.55, vs: 1.55 },
  trim: { us: 0.80, vs: 0.34 },
  ground: { us: 2.0, vs: 2.0 },
  metal: { us: 0.55, vs: 0.55 },
};

const DARK = [0.055, 0.046, 0.038];

/* ---------------------------------------------------------------- edge kit
 * PASS-2 FORENSICS (town_street): "Zero-thickness geometry. Roof planes on the
 * barn, the red saloon and the sheriff building terminate in paper-thin
 * silhouettes with no fascia, no gutter, no rafter tails. The saloon's slanted
 * roof edge is a single flat quad seen edge-on."
 *
 * Everything below exists to put real material on those edges. A roof is not a
 * plane: it is a deck on rafters, and what you see from the street is the
 * 200-250 mm of fascia and barge board hanging off the end of it, with the
 * rafter tails ticking past behind. The silhouette of a western roofline is
 * almost entirely made of that band.
 */

/** Quad with an explicitly chosen outward normal, so slopes cannot wind wrong. */
function faceQuad(B, mat, a, b, c, d, want, o) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (nx * want[0] + ny * want[1] + nz * want[2] < 0) B.quad(mat, a, d, c, b, o);
  else B.quad(mat, a, b, c, d, o);
}

/**
 * Barge / rake board down a sloping roof edge — the fix for the "single flat
 * quad seen edge-on" tell. The outer face lies in the plane of the roof edge so
 * the deck appears to sit ON something, and the soffit under it catches the
 * bounce and reads as a dark line at low sun.
 *
 * @param {'x'|'z'} axis  which local plane the board's face lies in
 * @param {number} e      the constant local coordinate of that plane
 * @param {number} sgn    +1 if the face looks toward +axis
 * @param {Array<[number,number]>} path  [otherLocalAxis, y] polyline
 */
function rakeBoard(B, M, F, axis, e, sgn, path, o) {
  const th = o.th != null ? o.th : 0.085;
  const dp = o.dp != null ? o.dp : 0.24;
  const wear = o.wear;
  const col = o.col || [0.78, 0.73, 0.64];
  const eo = e, ei = e - sgn * th;
  const want = axis === 'x' ? [F.ax * sgn, 0, F.az * sgn] : [F.bx * sgn, 0, F.bz * sgn];
  const P = axis === 'x' ? (ee, a, y) => F.p(ee, a, y) : (ee, a, y) => F.p(a, ee, y);
  const face = { us: 1.4, vs: 0.34, col, wear, nu: 3, nv: 1 };
  const soff = { us: 1.4, vs: 0.34, col: [col[0] * 0.70, col[1] * 0.70, col[2] * 0.70], wear, nu: 3, nv: 1 };
  for (let i = 0; i < path.length - 1; i++) {
    const a0 = path[i][0], y0 = path[i][1];
    const a1 = path[i + 1][0], y1 = path[i + 1][1];
    faceQuad(B, M.plank,
      P(eo, a0, y0 - dp), P(eo, a1, y1 - dp), P(eo, a1, y1), P(eo, a0, y0),
      want, face);
    faceQuad(B, M.plank,
      P(ei, a0, y0 - dp), P(ei, a1, y1 - dp), P(eo, a1, y1 - dp), P(eo, a0, y0 - dp),
      [0, -1, 0], soff);
  }
}

/**
 * Rafter tails ticking out under an eave, plus the soffit shadow they sit in.
 * `axis` = 'x' (the eave runs along local x, tails project in z) or 'z'.
 */
function rafterTails(B, M, F, s) {
  const wear = s.wear;
  const col = s.col || [0.56, 0.51, 0.44];
  const t = 0.045, hgt = 0.115;
  const pitch = s.pitch || 0.62;
  const n = Math.max(2, Math.round(Math.abs(s.a1 - s.a0) / pitch));
  const o = { us: 0.5, vs: 0.3, col, wear, nu: 1, nv: 1 };
  for (let i = 0; i <= n; i++) {
    const a = s.a0 + ((s.a1 - s.a0) * i) / n;
    // a millimetre of jitter so the rhythm is carpentry and not a comb
    const j = (Math.sin(i * 12.9898 + s.seed) * 0.5 + 0.5) * 0.04 - 0.02;
    const y1 = s.y + j * 0.4;
    if (s.axis === 'x') {
      B.box(M.plank, F, a - t + j, a + t + j, s.b0, s.b1, y1 - hgt, y1, o);
    } else {
      B.box(M.plank, F, s.b0, s.b1, a - t + j, a + t + j, y1 - hgt, y1, o);
    }
  }
}

/**
 * Board-and-batten strapping: the 30 mm proud vertical strips that cover the
 * joints between wide boards. On a shaded facade these are the ONLY thing that
 * produces readable relief — pass 2's barn "collapsed to a near-flat dark maroon
 * with almost no readable detail" precisely because the wall was a flat plane
 * with a painted texture on it. A batten at 600 mm centres gives the bounce
 * light something to fall off and the sun something to graze.
 *
 * @param {'z'|'x'} face  which wall plane; `e` is its local coordinate
 */
function battens(B, M, F, face, e, sgn, a0, a1, y0, y1, o) {
  const wear = o.wear;
  const col = o.col || [0.90, 0.88, 0.84];
  const t = 0.038, pr = 0.032;
  const pitch = o.pitch || 0.61;
  const n = Math.max(1, Math.round((a1 - a0) / pitch));
  const skip = o.skip || [];
  const bo = { us: 0.4, vs: 0.55, col, wear, nu: 1, nv: 3 };
  for (let i = 1; i < n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    let blocked = false;
    for (const h of skip) if (a > h[0] - t && a < h[1] + t) { blocked = true; break; }
    if (blocked) continue;
    const e0 = sgn < 0 ? e - pr : e;
    const e1 = sgn < 0 ? e : e + pr;
    if (face === 'z') B.box(M.plank, F, a - t, a + t, e0, e1, y0, y1, bo);
    else B.box(M.plank, F, e0, e1, a - t, a + t, y0, y1, bo);
  }
}

/* ------------------------------------------------------------------ pieces */

/** Window with reveal, sill, trim, glazing bars and interior darkness. */
export function windowUnit(B, F, M, x, y, w, h, o = {}) {
  const wear = o.wear;
  const wall = o.wallZ != null ? o.wallZ : 0;
  const inner = wall + (o.thick || 0.26);
  const glassMat = o.lit ? M.glassLit : M.glass;

  const rv = { us: 0.9, vs: 0.9, wear, col: [0.44, 0.40, 0.35], nu: 1, nv: 1 };
  B.faceX(M.plank, F, x, wall, inner, y, y + h, +1, rv);
  B.faceX(M.plank, F, x + w, wall, inner, y, y + h, -1, rv);
  B.faceY(M.plank, F, y + h, x, x + w, wall, inner, -1, rv);
  B.faceY(M.plank, F, y, x, x + w, wall, inner, +1, rv);

  // interior darkness: a plate set well back behind the opening
  B.faceZ(M.plank, F, inner + 0.45, x - 0.06, x + w + 0.06, y - 0.06, y + h + 0.06, -1,
    { us: 1, vs: 1, wear, col: DARK, nu: 1, nv: 1 });

  // glazing, two sashes with a meeting rail
  const gz = inner - 0.035;
  const gcol = o.lit ? [1, 1, 1] : [0.34, 0.36, 0.38];
  const midY = y + h * 0.52;
  const go = { us: 0.8, vs: 0.8, wear, col: gcol, nu: 1, nv: 1 };
  B.faceZ(glassMat, F, gz, x + 0.04, x + w - 0.04, y + 0.035, midY - 0.02, -1, go);
  B.faceZ(glassMat, F, gz, x + 0.04, x + w - 0.04, midY + 0.02, y + h - 0.035, -1, go);

  const bar = { us: 0.5, vs: 0.28, wear, col: [0.52, 0.47, 0.41], nu: 1, nv: 1 };
  B.box(M.plank, F, x + 0.03, x + w - 0.03, gz - 0.04, gz + 0.01, midY - 0.03, midY + 0.03, bar);
  if (w > 0.8) {
    const mx = x + w * 0.5;
    B.box(M.plank, F, mx - 0.024, mx + 0.024, gz - 0.04, gz + 0.01, y + 0.03, y + h - 0.03, bar);
  }

  /* --- outer casing, drip cap and sill -------------------------------------
   * PASS-2: "Doors and windows are flat quads with painted rectangles, not
   * geometry… no frame, no thickness, no interior." Everything here is real
   * board standing proud of the wall, because at a low sun the only thing that
   * tells you a window is a window is the shadow its head casing throws.
   * The trim is deliberately knocked back from the spec colour: at this
   * exposure a 1.0 white casing metered as a blown smear.                    */
  const tc0 = o.trimCol || [0.90, 0.86, 0.78];
  const tc = [tc0[0] * 0.80, tc0[1] * 0.79, tc0[2] * 0.76];
  const t = o.trimW || 0.10;
  const tw = { us: UV.trim.us, vs: UV.trim.vs, wear, col: tc, nv: 1 };
  const pz = wall - 0.075;
  B.box(M.plank, F, x - t, x + w + t, pz, wall + 0.01, y + h, y + h + t, tw);
  B.box(M.plank, F, x - t, x, pz, wall + 0.01, y - 0.04, y + h, tw);
  B.box(M.plank, F, x + w, x + w + t, pz, wall + 0.01, y - 0.04, y + h, tw);
  // drip cap / label mould over the head — throws a hard line down the glass
  B.box(M.plank, F, x - t * 1.9, x + w + t * 1.9, wall - 0.175, wall + 0.01, y + h + t, y + h + t + 0.075,
    { us: UV.trim.us, vs: 0.28, wear, col: [tc[0] * 1.06, tc[1] * 1.05, tc[2] * 1.02], nv: 1 });
  // sill: proud, with an apron under it so it is not a painted line
  B.box(M.plank, F, x - t * 1.7, x + w + t * 1.7, wall - 0.165, wall + 0.01, y - 0.105, y - 0.02, tw);
  B.box(M.plank, F, x - t * 1.2, x + w + t * 1.2, wall - 0.085, wall + 0.01, y - 0.21, y - 0.105,
    { us: UV.trim.us, vs: 0.3, wear, col: [tc[0] * 0.72, tc[1] * 0.71, tc[2] * 0.70], nv: 1 });

  if (o.shutter) {
    const sw = w * 0.5;
    const so = { us: 0.7, vs: 0.34, wear, col: o.shutterCol || [0.44, 0.34, 0.25], nv: 3 };
    B.box(M.plank, F, x - t - sw, x - t - 0.01, wall - 0.15, wall - 0.07, y, y + h, so);
    if (!o.oneShutter) {
      B.box(M.plank, F, x + w + t + 0.01, x + w + t + sw, wall - 0.15, wall - 0.07, y, y + h * 0.99, so);
    }
  }
  if (o.bars) {
    for (let i = 1; i <= 3; i++) {
      const bx = x + (w * i) / 4;
      B.tube(M.rust, F.p(bx, wall - 0.07, y + 0.02), F.p(bx, wall - 0.07, y + h - 0.02),
        0.017, 0.017, 5, { us: 0.3, vs: 0.6, col: [0.55, 0.48, 0.4], wear });
    }
  }
  return { x: x + w * 0.5, y: y + h * 0.5, z: wall - 0.1 };
}

/** Panelled door in a cased opening. */
export function doorUnit(B, F, M, x, y, w, h, o = {}) {
  const wear = o.wear;
  const wall = o.wallZ != null ? o.wallZ : 0;
  const inner = wall + (o.thick || 0.26);
  const rv = { us: 0.9, vs: 0.9, wear, col: [0.42, 0.38, 0.33], nu: 1, nv: 1 };
  B.faceX(M.plank, F, x, wall, inner, y, y + h, +1, rv);
  B.faceX(M.plank, F, x + w, wall, inner, y, y + h, -1, rv);
  B.faceY(M.plank, F, y + h, x, x + w, wall, inner, -1, rv);
  B.faceZ(M.plank, F, inner + 0.6, x - 0.06, x + w + 0.06, y, y + h + 0.06, -1,
    { us: 1, vs: 1, wear, col: DARK, nu: 1, nv: 1 });

  if (!o.open) {
    const dcol = o.col || [0.60, 0.48, 0.36];
    const dz = inner - 0.055;
    B.box(M.plank, F, x + 0.025, x + w - 0.025, dz - 0.05, dz, y + 0.01, y + h - 0.025,
      { us: 0.9, vs: 0.42, wear, col: dcol, nv: 5 });
    const pc = [dcol[0] * 0.86, dcol[1] * 0.86, dcol[2] * 0.86];
    const pn = { us: 0.6, vs: 0.3, wear, col: pc, nu: 1, nv: 2 };
    B.box(M.plank, F, x + 0.14, x + w - 0.14, dz - 0.085, dz - 0.05, y + 0.17, y + h * 0.43, pn);
    B.box(M.plank, F, x + 0.14, x + w - 0.14, dz - 0.085, dz - 0.05, y + h * 0.51, y + h - 0.19, pn);
    B.tube(M.rust, F.p(x + w - 0.17, dz - 0.09, y + h * 0.45), F.p(x + w - 0.17, dz - 0.17, y + h * 0.45),
      0.026, 0.021, 6, { us: 0.2, vs: 0.2, col: [0.72, 0.64, 0.52], wear, caps: true });
  }
  const t = 0.11;
  const dc0 = o.trimCol || [0.88, 0.84, 0.76];
  const dc = [dc0[0] * 0.80, dc0[1] * 0.79, dc0[2] * 0.76];
  const tw = { us: UV.trim.us, vs: UV.trim.vs, wear, col: dc, nv: 1 };
  B.box(M.plank, F, x - t, x + w + t, wall - 0.085, wall + 0.01, y + h, y + h + t, tw);
  B.box(M.plank, F, x - t, x, wall - 0.085, wall + 0.01, y, y + h, tw);
  B.box(M.plank, F, x + w, x + w + t, wall - 0.085, wall + 0.01, y, y + h, tw);
  // lintel hood over the door head
  B.box(M.plank, F, x - t * 1.8, x + w + t * 1.8, wall - 0.20, wall + 0.01, y + h + t, y + h + t + 0.08,
    { us: UV.trim.us, vs: 0.28, wear, col: [dc[0] * 1.06, dc[1] * 1.05, dc[2] * 1.02], nv: 1 });
  // stone threshold + a worn tread in front of it
  B.box(M.stone, F, x - 0.09, x + w + 0.09, wall - 0.19, wall + 0.14, y - 0.075, y + 0.008,
    { us: UV.stone.us, vs: 0.5, wear, col: [0.70, 0.66, 0.60], nv: 1 });
  B.box(M.plank, F, x - 0.16, x + w + 0.16, wall - 0.44, wall - 0.18, y - 0.155, y - 0.055,
    { us: 1.0, vs: 0.4, wear, col: [0.50, 0.45, 0.39], nv: 1 });
  return { x: x + w * 0.5, y, z: wall };
}

/** Gable roof. `along` = 'x' (ridge parallel to the street) or 'z'. */
export function gableRoof(B, F, M, s) {
  const { x0, x1, z0, z1, yE, yR } = s;
  const oh = s.oh != null ? s.oh : 0.42;
  const mat = s.mat || M.shingle;
  const uv = s.uv || UV.roof;
  const wear = s.wear;
  const col = s.col || [1, 1, 1];
  const sag = s.sag || 0;
  const along = s.along || 'x';
  // missing / replacement shingles: a low-frequency value break-up
  const rcol = (p, u, v) => {
    const n = Math.sin(u * 27.7 + p[1] * 3.3) * Math.sin(v * 19.1 + p[0] * 0.7 + p[2] * 0.7);
    const k = 1 + 0.16 * n - (n > 0.72 ? 0.30 : 0);
    return [col[0] * k, col[1] * k, col[2] * k];
  };

  if (along === 'x') {
    const zm = (z0 + z1) * 0.5;
    const warp = (u, v, p) => { p[1] -= sag * Math.sin(Math.PI * u) * v; };
    B.quad(mat,
      F.p(x1 + oh, z0 - oh, yE), F.p(x0 - oh, z0 - oh, yE),
      F.p(x0 - oh, zm, yR), F.p(x1 + oh, zm, yR),
      { us: uv.us, vs: uv.vs, warp, col: rcol, wear, step: 1.3 });
    B.quad(mat,
      F.p(x0 - oh, z1 + oh, yE), F.p(x1 + oh, z1 + oh, yE),
      F.p(x1 + oh, zm, yR), F.p(x0 - oh, zm, yR),
      { us: uv.us, vs: uv.vs, warp, col: rcol, wear, step: 1.3 });

    // gable end walls (pentagon top halves)
    const gm = s.gableMat || M.plank;
    const gcol = s.gableCol || col;
    const guv = s.gableUV || UV.wall;
    const gh = yR - yE;
    const gw = z1 - z0;
    B.tri(gm, F.p(x0, z0, yE), F.p(x0, z1, yE), F.p(x0, zm, yR),
      { us: guv.us, vs: guv.vs, rot: guv.rot, col: gcol, wear, uv: [[0, 0], [gw, 0], [gw * 0.5, gh]] });
    B.tri(gm, F.p(x1, z1, yE), F.p(x1, z0, yE), F.p(x1, zm, yR),
      { us: guv.us, vs: guv.vs, rot: guv.rot, col: gcol, wear, uv: [[0, 0], [gw, 0], [gw * 0.5, gh]] });

    /* ridge cap: a saddle board over the joint, proud of both slopes */
    B.box(M.plank, F, x0 - oh, x1 + oh, zm - 0.11, zm + 0.11, yR - 0.05, yR + 0.085,
      { us: 1.2, vs: 0.4, col: [0.62, 0.56, 0.48], wear, nv: 1 });
    /* eave fascia, both sides — 250 mm of real board under the deck edge */
    const fc = { us: 1.4, vs: 0.36, col: [0.76, 0.71, 0.62], wear, nv: 1 };
    B.box(M.plank, F, x0 - oh, x1 + oh, z0 - oh - 0.075, z0 - oh, yE - 0.25, yE + 0.02, fc);
    B.box(M.plank, F, x0 - oh, x1 + oh, z1 + oh, z1 + oh + 0.075, yE - 0.25, yE + 0.02, fc);
    /* rafter tails under both eaves */
    rafterTails(B, M, F, {
      axis: 'x', a0: x0 - oh + 0.2, a1: x1 + oh - 0.2, b0: z0 - oh + 0.02, b1: z0 + 0.05,
      y: yE - 0.055, wear, seed: 1.7,
    });
    rafterTails(B, M, F, {
      axis: 'x', a0: x0 - oh + 0.2, a1: x1 + oh - 0.2, b0: z1 - 0.05, b1: z1 + oh - 0.02,
      y: yE - 0.055, wear, seed: 4.1,
    });
    /* barge boards down both rakes — this is the edge that was one pixel wide */
    for (const [xe, sg] of [[x0 - oh, -1], [x1 + oh, +1]]) {
      rakeBoard(B, M, F, 'x', xe, sg,
        [[z0 - oh, yE], [zm, yR], [z1 + oh, yE]],
        { wear, col: [0.80, 0.75, 0.66], dp: 0.26 });
    }
  } else {
    const xm = (x0 + x1) * 0.5;
    const warp = (u, v, p) => { p[1] -= sag * Math.sin(Math.PI * u) * v; };
    B.quad(mat,
      F.p(x0 - oh, z0 - oh, yE), F.p(x0 - oh, z1 + oh, yE),
      F.p(xm, z1 + oh, yR), F.p(xm, z0 - oh, yR),
      { us: uv.us, vs: uv.vs, warp, col: rcol, wear, step: 1.3 });
    B.quad(mat,
      F.p(x1 + oh, z1 + oh, yE), F.p(x1 + oh, z0 - oh, yE),
      F.p(xm, z0 - oh, yR), F.p(xm, z1 + oh, yR),
      { us: uv.us, vs: uv.vs, warp, col: rcol, wear, step: 1.3 });
    B.box(M.plank, F, xm - 0.11, xm + 0.11, z0 - oh, z1 + oh, yR - 0.05, yR + 0.085,
      { us: 1.2, vs: 0.4, col: [0.62, 0.56, 0.48], wear, nu: 1 });
    const fc = { us: 1.4, vs: 0.36, col: [0.76, 0.71, 0.62], wear, nu: 1 };
    B.box(M.plank, F, x0 - oh - 0.075, x0 - oh, z0 - oh, z1 + oh, yE - 0.25, yE + 0.02, fc);
    B.box(M.plank, F, x1 + oh, x1 + oh + 0.075, z0 - oh, z1 + oh, yE - 0.25, yE + 0.02, fc);
    rafterTails(B, M, F, {
      axis: 'z', a0: z0 - oh + 0.2, a1: z1 + oh - 0.2, b0: x0 - oh + 0.02, b1: x0 + 0.05,
      y: yE - 0.055, wear, seed: 2.3,
    });
    rafterTails(B, M, F, {
      axis: 'z', a0: z0 - oh + 0.2, a1: z1 + oh - 0.2, b0: x1 - 0.05, b1: x1 + oh - 0.02,
      y: yE - 0.055, wear, seed: 5.9,
    });
    /* barge boards down the two gable rakes (which run in x here) */
    for (const [ze, sg] of [[z0 - oh, -1], [z1 + oh, +1]]) {
      rakeBoard(B, M, F, 'z', ze, sg,
        [[x0 - oh, yE], [xm, yR], [x1 + oh, yE]],
        { wear, col: [0.80, 0.75, 0.66], dp: 0.26 });
    }
  }
}

/** Single-pitch shed roof falling from yHi at z0 to yLo at z1. */
export function shedRoof(B, F, M, s) {
  const { x0, x1, z0, z1, yHi, yLo } = s;
  const oh = s.oh != null ? s.oh : 0.35;
  const mat = s.mat || M.shingle;
  const uv = s.uv || UV.roof;
  const wear = s.wear;
  const col = s.col || [1, 1, 1];
  const sag = s.sag || 0;
  const span = Math.max(0.001, z1 - z0);
  const yAt = (t) => yHi + (yLo - yHi) * t;
  const t0 = -oh / span;
  const t1 = 1 + oh / span;
  B.quad(mat,
    F.p(x1 + oh, z0 - oh, yAt(t0)), F.p(x0 - oh, z0 - oh, yAt(t0)),
    F.p(x0 - oh, z1 + oh, yAt(t1)), F.p(x1 + oh, z1 + oh, yAt(t1)),
    {
      us: uv.us,
      vs: uv.vs,
      col,
      wear,
      step: 1.3,
      warp: (u, v, p) => { p[1] -= sag * Math.sin(Math.PI * u) * Math.sin(Math.PI * v); },
    });
  /* --- edges. Pass 2 shipped this as one quad and the critique named it:
   * "the saloon's slanted roof edge is a single flat plane". Every one of the
   * four sides now carries board. --------------------------------------- */
  const fc = { us: 1.4, vs: 0.36, col: [0.76, 0.71, 0.62], wear, nv: 1 };
  // low-side fascia (the gutter line)
  B.box(M.plank, F, x0 - oh, x1 + oh, z1 + oh - 0.085, z1 + oh, yAt(t1) - 0.24, yAt(t1) + 0.015, fc);
  // high-side edge, so the roof does not vanish where it meets the wall
  B.box(M.plank, F, x0 - oh, x1 + oh, z0 - oh, z0 - oh + 0.085, yAt(t0) - 0.20, yAt(t0) + 0.015, fc);
  // sloping rakes down both ends
  if (s.rakes !== false) {
    for (const [xe, sg] of [[x0 - oh, -1], [x1 + oh, +1]]) {
      rakeBoard(B, M, F, 'x', xe, sg,
        [[z0 - oh, yAt(t0)], [z1 + oh, yAt(t1)]],
        { wear, col: [0.80, 0.75, 0.66], dp: 0.23 });
    }
  }
  if (s.tails !== false) {
    rafterTails(B, M, F, {
      axis: 'x', a0: x0 - oh + 0.18, a1: x1 + oh - 0.18,
      b0: z1 - 0.02, b1: z1 + oh - 0.02,
      y: yAt(t1) - 0.03, wear, seed: s.seed || 3.3, pitch: 0.58,
    });
  }
}

/**
 * False front: a screen wall of real thickness with a stepped cap, a
 * projecting cornice and side returns. `panels` is a list of
 * {x0, x1, top} rectangles built from the bottom up.
 */
export function falseFront(B, F, M, s) {
  const { panels, y0 } = s;
  const zf = s.zf != null ? s.zf : -0.28;
  const zb = s.zb != null ? s.zb : 0.02;
  const mat = s.mat || M.plank;
  const uv = s.uv || UV.wall;
  const wear = s.wear;
  const col = s.col || [1, 1, 1];
  const holes = s.holes || [];
  const ov = s.cornice != null ? s.cornice : 0.17;

  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    const yb = i === 0 ? y0 : panels[i - 1].top + 0.2;
    const o = { us: uv.us, vs: uv.vs, rot: uv.rot, col, wear, step: 1.5, uo: s.uo || 0, vo: s.vo || 0 };
    if (i === 0 && holes.length) {
      B.wallHoles(mat, F, zf, p.x0, p.x1, yb, p.top, -1, holes, o);
    } else {
      B.faceZ(mat, F, zf, p.x0, p.x1, yb, p.top, -1, o);
    }
    B.faceZ(mat, F, zb, p.x0, p.x1, yb, p.top, +1,
      { us: uv.us, vs: uv.vs, rot: uv.rot, col: [col[0] * 0.74, col[1] * 0.74, col[2] * 0.74], wear, step: 1.8 });
    B.faceX(mat, F, p.x0, zf, zb, yb, p.top, -1, o);
    B.faceX(mat, F, p.x1, zf, zb, yb, p.top, +1, o);
    // cornice: proud, casts a hard shadow line across the facade
    B.box(mat, F, p.x0 - ov, p.x1 + ov, zf - ov, zb, p.top, p.top + 0.20,
      { us: 1.2, vs: 0.42, col: [col[0] * 1.07, col[1] * 1.07, col[2] * 1.07], wear, nv: 1 });
    // coping cap over the cornice, oversailing it again with a drip edge, so
    // the parapet top reads as three stacked boards instead of one flat line
    B.box(M.plank, F, p.x0 - ov * 1.45, p.x1 + ov * 1.45, zf - ov * 1.5, zb + 0.03,
      p.top + 0.20, p.top + 0.285,
      { us: 1.3, vs: 0.3, col: [0.80, 0.75, 0.66], wear, nv: 1 });
    // bed mould tucked under the cornice — the dark line that sells the shadow
    B.box(M.plank, F, p.x0 - ov * 0.55, p.x1 + ov * 0.55, zf - ov * 0.62, zf,
      p.top - 0.30, p.top - 0.17,
      { us: 1.0, vs: 0.28, col: [col[0] * 0.70, col[1] * 0.70, col[2] * 0.70], wear, nu: 3, nv: 1 });
    if (s.dentils !== false) {
      const n = Math.max(2, Math.floor((p.x1 - p.x0) / 0.55));
      for (let k = 0; k < n; k++) {
        const cx = p.x0 + ((k + 0.5) / n) * (p.x1 - p.x0);
        B.box(mat, F, cx - 0.07, cx + 0.07, zf - ov * 0.6, zf, p.top - 0.17, p.top,
          { us: 0.4, vs: 0.3, col: [col[0] * 0.88, col[1] * 0.88, col[2] * 0.88], wear, nu: 1, nv: 1 });
      }
    }
  }
  if (s.pediment) {
    const p = panels[panels.length - 1];
    const xm = (p.x0 + p.x1) * 0.5;
    const yb = p.top + 0.2;
    const top = yb + s.pediment;
    const px0 = p.x0 - ov, px1 = p.x1 + ov;
    const wgt = px1 - px0;
    B.tri(mat, F.p(px0, zf - ov, yb), F.p(px1, zf - ov, yb), F.p(xm, zf - ov, top),
      { us: uv.us, vs: uv.vs, col, wear, uv: [[0, 0], [wgt, 0], [wgt * 0.5, s.pediment]] });
    B.tri(mat, F.p(px1, zb, yb), F.p(px0, zb, yb), F.p(xm, zb, top),
      { us: uv.us, vs: uv.vs, col: [col[0] * 0.74, col[1] * 0.74, col[2] * 0.74], wear, uv: [[0, 0], [wgt, 0], [wgt * 0.5, s.pediment]] });
    B.quad(mat, F.p(px0, zf - ov, yb), F.p(xm, zf - ov, top), F.p(xm, zb, top), F.p(px0, zb, yb),
      { us: 1.1, vs: 0.4, col: [col[0] * 1.09, col[1] * 1.09, col[2] * 1.09], wear, nv: 1 });
    B.quad(mat, F.p(xm, zf - ov, top), F.p(px1, zf - ov, yb), F.p(px1, zb, yb), F.p(xm, zb, top),
      { us: 1.1, vs: 0.4, col: [col[0] * 1.09, col[1] * 1.09, col[2] * 1.09], wear, nv: 1 });
  }
}

/** Porch / awning over the boardwalk: posts, knee braces, header, shed roof. */
export function porch(B, F, M, s) {
  const { x0, x1, y, depth } = s;
  const wear = s.wear;
  const pr = s.postR || 0.078;
  const yHi = s.yHi;
  const yLo = s.yLo != null ? s.yLo : yHi + 0.32;
  const n = Math.max(2, Math.round((x1 - x0) / (s.spacing || 3.1)));
  const col = s.col || [0.80, 0.74, 0.64];
  const pz = -depth + 0.06;
  for (let i = 0; i <= n; i++) {
    const px = x0 + ((x1 - x0) * i) / n;
    B.box(M.plank, F, px - pr, px + pr, pz - pr, pz + pr, y, yLo,
      { us: 0.5, vs: 0.6, col, wear, nu: 1, nv: 4 });
    // knee braces in the plane of the facade
    for (const sg of [-1, 1]) {
      B.tube(M.plank,
        F.p(px + sg * pr * 0.7, pz, yLo - 0.46), F.p(px + sg * 0.5, pz, yLo - 0.02),
        0.042, 0.042, 4, { us: 0.5, vs: 0.5, col, wear });
    }
  }
  B.box(M.plank, F, x0 - 0.12, x1 + 0.12, pz - 0.1, pz + 0.1, yLo, yLo + 0.26,
    { us: 1.3, vs: 0.4, col, wear, nv: 1 });
  shedRoof(B, F, M, {
    x0: x0 - 0.14, x1: x1 + 0.14, z0: -depth - 0.22, z1: 0.02,
    yHi: yLo + 0.30, yLo: yHi + 0.05, oh: 0.12, mat: s.mat || M.shingle,
    uv: s.uv || UV.roof, wear, col: s.roofCol || [0.94, 0.92, 0.88], sag: 0.05,
  });
  return yLo;
}

/** First-floor balcony over the boardwalk — the saloon's signature. */
export function balcony(B, F, M, s) {
  const { x0, x1, y, depth } = s;
  const wear = s.wear;
  const col = s.col || [0.82, 0.76, 0.66];
  const np = Math.max(3, Math.round(depth / 0.26));
  for (let i = 0; i < np; i++) {
    const z0 = -depth + (depth * i) / np;
    const z1 = -depth + (depth * (i + 1)) / np - 0.014;
    const k = 0.86 + 0.26 * (((i * 7) % 5) / 5);
    B.box(M.plank, F, x0, x1, z0, z1, y - 0.06, y,
      { us: 1.1, vs: 0.5, col: [col[0] * k, col[1] * k, col[2] * k], wear, nv: 1 });
  }
  B.box(M.plank, F, x0 - 0.07, x1 + 0.07, -depth - 0.07, -depth + 0.03, y - 0.28, y - 0.02,
    { us: 1.2, vs: 0.45, col, wear, nv: 1 });
  const rt = y + 1.04;
  B.box(M.plank, F, x0, x1, -depth, -depth + 0.09, rt - 0.09, rt, { us: 1.2, vs: 0.35, col, wear, nv: 1 });
  B.box(M.plank, F, x0, x0 + 0.09, -depth, 0, rt - 0.09, rt, { us: 1.2, vs: 0.35, col, wear, nu: 1 });
  B.box(M.plank, F, x1 - 0.09, x1, -depth, 0, rt - 0.09, rt, { us: 1.2, vs: 0.35, col, wear, nu: 1 });
  const nb = Math.max(6, Math.round((x1 - x0) / 0.27));
  for (let i = 0; i <= nb; i++) {
    const bx = x0 + ((x1 - x0) * i) / nb;
    B.box(M.thinTrim || M.plank, F, bx - 0.027, bx + 0.027, -depth + 0.016, -depth + 0.076, y, rt - 0.09,
      { us: 0.3, vs: 0.4, col, wear, nu: 1, nv: 1 });
  }
  const ns = Math.max(2, Math.round(depth / 0.27));
  for (const sx of [x0 + 0.046, x1 - 0.046]) {
    for (let i = 1; i <= ns; i++) {
      const bz = -depth + (depth * i) / (ns + 1);
      B.box(M.thinTrim || M.plank, F, sx - 0.027, sx + 0.027, bz - 0.027, bz + 0.027, y, rt - 0.09,
        { us: 0.3, vs: 0.4, col, wear, nu: 1, nv: 1 });
    }
  }
  const n = Math.max(2, Math.round((x1 - x0) / 3.4));
  for (let i = 0; i <= n; i++) {
    const px = x0 + ((x1 - x0) * i) / n;
    B.box(M.plank, F, px - 0.082, px + 0.082, -depth + 0.03, -depth + 0.194, s.groundY, y - 0.06,
      { us: 0.5, vs: 0.6, col, wear, nu: 1, nv: 4 });
    B.box(M.plank, F, px - 0.076, px + 0.076, -depth + 0.03, -depth + 0.182, rt, s.roofY,
      { us: 0.5, vs: 0.6, col, wear, nu: 1, nv: 2 });
  }
}

/** Stone chimney with a corbelled cap. */
export function chimney(B, F, M, s) {
  const wear = s.wear;
  const { x, z, y0, y1, w } = s;
  const col = s.col || [0.92, 0.88, 0.82];
  B.box(M.stone, F, x - w * 0.5, x + w * 0.5, z - w * 0.42, z + w * 0.42, y0, y1 - 0.26,
    { us: UV.stone.us, vs: UV.stone.vs, col, wear, step: 1.2, skip: 'bt' });
  B.box(M.stone, F, x - w * 0.63, x + w * 0.63, z - w * 0.55, z + w * 0.55, y1 - 0.26, y1,
    { us: UV.stone.us, vs: UV.stone.vs, col, wear, nv: 1 });
  B.faceY(M.plank, F, y1 - 0.015, x - w * 0.26, x + w * 0.26, z - w * 0.2, z + w * 0.2, +1,
    { us: 1, vs: 1, col: DARK, wear, nu: 1, nv: 1 });
}

/* --------------------------------------------------------------- buildings */

/**
 * Turn a resolved spec into geometry.
 * `out` collects fixtures the Town system needs afterwards: lamps, chimney
 * smoke anchors, sign slots and door positions.
 */
export function buildBuilding(B, M, spec, rand, out) {
  const F = new Frame(spec.ox, spec.floorY, spec.oz, spec.dirX, spec.dirZ);
  const w = spec.w, d = spec.d, h = spec.h;
  const x0 = -w * 0.5, x1 = w * 0.5;
  const gy = spec.groundY - spec.floorY;          // local y of the street grade
  const by = spec.baseY - spec.floorY;            // local y of the lowest grade
  const wear = [spec.groundY - 0.05, spec.floorY + h + 1.1, spec.grime, spec.chalk];

  const wallMat = spec.wallMat === 'adobe' ? M.adobe : spec.wallMat === 'stone' ? M.stone : M.plank;
  const wallUV = spec.wallMat === 'adobe' ? UV.adobe : spec.wallMat === 'stone' ? UV.stone
    : spec.vertical ? UV.wallV : UV.wall;
  const wcol = spec.color;
  /* Per-building UV phase. Even with hex tiling on, two identical facades that
   * start their texture at the same texel read as the same wall; a metre or two
   * of offset per lot costs nothing and removes the last correlation. */
  const uo = spec.uvo || 0, vo = spec.uvo2 || 0;
  const wo = { us: wallUV.us, vs: wallUV.vs, rot: wallUV.rot, col: wcol, wear, step: 1.6, uo, vo };

  /* ------------------------------------------------------- foundation */
  const fy = Math.min(by, gy) - 0.7;
  if (spec.wallMat === 'adobe' || spec.foundation === 'stone') {
    B.box(M.stone, F, x0 - 0.15, x1 + 0.15, -0.15, d + 0.15, fy, 0,
      { us: UV.stone.us, vs: UV.stone.vs, col: [0.94, 0.90, 0.84], wear, step: 1.3, skip: 'bt' });
  } else {
    B.box(M.stone, F, x0 - 0.11, x1 + 0.11, -0.11, d + 0.11, fy, -0.18,
      { us: UV.stone.us, vs: UV.stone.vs, col: [0.88, 0.84, 0.78], wear, step: 1.3, skip: 'bt' });
    B.box(M.plank, F, x0 - 0.07, x1 + 0.07, -0.07, d + 0.07, -0.20, 0.02,
      { us: 1.4, vs: 0.4, col: [0.66, 0.61, 0.53], wear, nv: 1, skip: 'bt' });
  }

  /* -------------------------------------------------------- openings */
  const holes = [];
  const lamps = [];
  const doorW = spec.doorW || 1.08;
  const doorH = 2.18;
  const doorX = spec.doorX != null ? spec.doorX : -doorW * 0.5 + w * (spec.doorBias || 0);
  const sill = spec.sillY || 0.98;
  const winH = spec.winH || 1.6;
  const winW = spec.winW || 1.02;

  const winXs = [];
  if (spec.shopFront) {
    const gw = Math.min(2.6, (w - doorW - 1.5) * 0.5);
    if (gw > 0.9) {
      winXs.push({ x: doorX - 0.6 - gw, w: gw, h: 1.98, y: 0.74, shop: true });
      winXs.push({ x: doorX + doorW + 0.6, w: gw, h: 1.98, y: 0.74, shop: true });
    }
  } else {
    const n = Math.max(1, Math.floor((w - 1.6) / 2.1));
    for (let i = 0; i < n; i++) {
      const cx = x0 + 0.8 + ((w - 1.6) * (i + 0.5)) / n;
      if (Math.abs(cx - (doorX + doorW * 0.5)) < doorW * 0.5 + 0.72) continue;
      winXs.push({ x: cx - winW * 0.5, w: winW, h: winH, y: sill });
    }
  }
  for (const win of winXs) holes.push({ x0: win.x, x1: win.x + win.w, y0: win.y, y1: win.y + win.h });
  holes.push({ x0: doorX, x1: doorX + doorW, y0: -0.02, y1: doorH });

  const upper = [];
  if (spec.storeys > 1) {
    const uy = spec.floor2 != null ? spec.floor2 : h * 0.54 + 1.05;
    const n = Math.max(2, Math.floor(w / 2.3));
    for (let i = 0; i < n; i++) {
      const cx = x0 + 0.8 + ((w - 1.6) * (i + 0.5)) / n;
      upper.push({ x: cx - winW * 0.5, w: winW, h: winH, y: uy });
    }
  }

  /* ------------------------------------------------------------ walls */
  const screen = !!spec.falseFront;
  const frontZ = screen ? -0.28 : 0;

  B.faceX(wallMat, F, x0, 0, d, -0.06, h, -1, wo);
  B.faceX(wallMat, F, x1, 0, d, -0.06, h, +1, wo);
  B.faceZ(wallMat, F, d, x0, x1, -0.06, h, +1, wo);

  if (spec.vertical) {
    const bcol = [wcol[0] * 1.07, wcol[1] * 1.06, wcol[2] * 1.04];
    if (!screen) {
      battens(B, M, F, 'z', 0, -1, x0 + 0.2, x1 - 0.2, -0.04, h - 0.02,
        { wear, col: bcol, skip: holes.map((q) => [q.x0 - 0.12, q.x1 + 0.12]) });
    }
    battens(B, M, F, 'x', x0, -1, 0.25, d - 0.25, -0.04, h - 0.02, { wear, col: bcol });
    battens(B, M, F, 'x', x1, +1, 0.25, d - 0.25, -0.04, h - 0.02, { wear, col: bcol });
  }

  const cb = { us: 0.7, vs: 0.5, col: spec.trimCol, wear, nv: 3 };
  B.box(M.plank, F, x0 - 0.055, x0 + 0.115, -0.055, 0.115, -0.04, h + 0.06, cb);
  B.box(M.plank, F, x1 - 0.115, x1 + 0.055, -0.055, 0.115, -0.04, h + 0.06, cb);
  B.box(M.plank, F, x0 - 0.055, x0 + 0.115, d - 0.115, d + 0.055, -0.04, h + 0.06, cb);
  B.box(M.plank, F, x1 - 0.115, x1 + 0.055, d - 0.115, d + 0.055, -0.04, h + 0.06, cb);

  if (screen) {
    if (upper.length) {
      for (const u of upper) holes.push({ x0: u.x, x1: u.x + u.w, y0: u.y, y1: u.y + u.h });
    }
    falseFront(B, F, M, {
      panels: spec.panels, y0: -0.06, zf: -0.28, zb: 0.02, uo, vo,
      mat: spec.frontMat === 'painted' ? M.painted : wallMat,
      uv: spec.frontMat === 'painted' ? UV.wall : wallUV,
      col: spec.frontColor || wcol, wear, holes,
      pediment: spec.pediment, cornice: spec.cornice, dentils: spec.dentils,
    });
    if (spec.roof === 'shed') {
      shedRoof(B, F, M, {
        x0: x0 - 0.02, x1: x1 + 0.02, z0: 0.1, z1: d, yHi: h, yLo: h - d * 0.15,
        mat: spec.roofMat === 'iron' ? M.iron : M.shingle,
        uv: spec.roofMat === 'iron' ? UV.iron : UV.roof, wear,
        col: spec.roofColor, sag: 0.10, oh: 0.30,
      });
    } else {
      gableRoof(B, F, M, {
        x0, x1, z0: 0.1, z1: d, yE: h, yR: h + d * 0.5 * (spec.pitch || 0.42),
        along: 'x', mat: spec.roofMat === 'iron' ? M.iron : M.shingle,
        uv: spec.roofMat === 'iron' ? UV.iron : UV.roof, wear,
        col: spec.roofColor, sag: 0.12, oh: 0.34,
        gableMat: wallMat, gableUV: wallUV, gableCol: wcol,
      });
    }
  } else if (spec.roof === 'gable_z') {
    const yR = h + w * 0.5 * (spec.pitch || 0.55);
    B.wallHoles(wallMat, F, 0, x0, x1, -0.06, h, -1, holes, wo);
    B.tri(wallMat, F.p(x1, 0, h), F.p(x0, 0, h), F.p(0, 0, yR),
      { us: wallUV.us, vs: wallUV.vs, rot: wallUV.rot, col: wcol, wear, uv: [[0, 0], [w, 0], [w * 0.5, yR - h]] });
    B.tri(wallMat, F.p(x0, d, h), F.p(x1, d, h), F.p(0, d, yR),
      { us: wallUV.us, vs: wallUV.vs, rot: wallUV.rot, col: wcol, wear, uv: [[0, 0], [w, 0], [w * 0.5, yR - h]] });
    gableRoof(B, F, M, {
      x0, x1, z0: 0, z1: d, yE: h, yR, along: 'z',
      mat: spec.roofMat === 'iron' ? M.iron : M.shingle,
      uv: spec.roofMat === 'iron' ? UV.iron : UV.roof, wear,
      col: spec.roofColor, sag: 0.10, oh: 0.46,
    });
  } else {
    const yR = h + d * 0.5 * (spec.pitch || 0.45);
    B.wallHoles(wallMat, F, 0, x0, x1, -0.06, h, -1, holes, wo);
    gableRoof(B, F, M, {
      x0, x1, z0: 0, z1: d, yE: h, yR, along: 'x',
      mat: spec.roofMat === 'iron' ? M.iron : M.shingle,
      uv: spec.roofMat === 'iron' ? UV.iron : UV.roof, wear,
      col: spec.roofColor, sag: 0.12, oh: 0.42,
      gableMat: wallMat, gableUV: wallUV, gableCol: wcol,
    });
  }

  /* --------------------------------------------------------- openings */
  for (let i = 0; i < winXs.length; i++) {
    const win = winXs[i];
    const lit = (spec.litMask >> i) & 1;
    const g = windowUnit(B, F, M, win.x, win.y, win.w, win.h, {
      wear, wallZ: frontZ, thick: screen ? 0.30 : 0.24,
      lit: !!lit, shutter: spec.shutters && !win.shop,
      bars: spec.bars, trimCol: spec.trimCol, shutterCol: spec.shutterCol,
    });
    if (lit) out.glow.push(F.p(g.x, g.z - 0.5, g.y));
  }
  for (let i = 0; i < upper.length; i++) {
    const win = upper[i];
    const lit = (spec.litMask >> (i + 5)) & 1;
    const g = windowUnit(B, F, M, win.x, win.y, win.w, win.h, {
      wear, wallZ: frontZ, thick: screen ? 0.30 : 0.24, lit: !!lit,
      shutter: spec.shutters, trimCol: spec.trimCol, shutterCol: spec.shutterCol,
    });
    if (lit) out.glow.push(F.p(g.x, g.z - 0.5, g.y));
  }
  if (spec.sideWindows) {
    for (const [sx, sgn] of [[x0, -1], [x1, +1]]) {
      const n = Math.max(1, Math.floor(d / 3.6));
      for (let i = 0; i < n; i++) {
        const cz = ((d - 1.8) * (i + 0.5)) / n + 0.9;
        const SF = F.sub(sx, cz, 0, sgn * Math.PI * 0.5);
        windowUnit(B, SF, M, -winW * 0.5, sill, winW, winH * 0.9, {
          wear, wallZ: 0, thick: 0.2, lit: false, trimCol: spec.trimCol,
        });
      }
    }
  }
  const door = doorUnit(B, F, M, doorX, 0, doorW, doorH, {
    wear, wallZ: frontZ, thick: screen ? 0.30 : 0.24,
    trimCol: spec.trimCol, col: spec.doorColor, open: spec.doorOpen,
  });

  /* ------------------------------------------------ porch or balcony */
  let porchTop = 0;
  if (spec.balcony) {
    const byy = spec.balconyY || h * 0.50;
    balcony(B, F, M, {
      x0: x0 + 0.12, x1: x1 - 0.12, y: byy, depth: spec.porchDepth, wear,
      groundY: gy, roofY: byy + 2.55, col: spec.trimCol,
    });
    shedRoof(B, F, M, {
      x0: x0 - 0.16, x1: x1 + 0.16, z0: -spec.porchDepth - 0.28, z1: 0.02,
      yHi: byy + 2.78, yLo: byy + 2.48, oh: 0.16, mat: M.shingle, uv: UV.roof,
      wear, col: spec.roofColor, sag: 0.05,
    });
    porchTop = byy;
    lamps.push({ x: doorX - 1.35, y: 2.42, z: -0.36 });
    lamps.push({ x: doorX + doorW + 1.35, y: 2.42, z: -0.36 });
  } else if (spec.porch) {
    porchTop = porch(B, F, M, {
      x0: x0 + 0.1, x1: x1 - 0.1, y: gy, depth: spec.porchDepth,
      yHi: spec.porchY || 2.66, wear, col: spec.trimCol,
      spacing: spec.postSpacing || 3.0, mat: spec.awning ? M.canvas : M.shingle,
      uv: spec.awning ? { us: 1.7, vs: 1.7 } : UV.roof,
      roofCol: spec.awning ? [1.06, 0.99, 0.86] : spec.roofColor,
    });
    lamps.push({ x: doorX + doorW + 0.85, y: 2.30, z: -0.32 });
  } else {
    lamps.push({ x: doorX + doorW + 0.75, y: 2.34, z: -0.30 });
  }

  /* ------------------------------------------------------- chimneys */
  if (spec.chimney) {
    const cx = spec.chimneyX != null ? spec.chimneyX : x1 - 0.95;
    const top = h + 1.35 + rand() * 0.85;
    chimney(B, F, M, { x: cx, z: d * 0.58, y0: by - 0.3, y1: top, w: 0.64, wear });
    out.smoke.push({ p: F.p(cx, d * 0.58, top + 0.1), strength: 0.5 + rand() * 0.5 });
  }

  for (const l of lamps) out.lamps.push({ p: F.p(l.x, l.z, l.y), local: l, F });
  out.doors.push({ p: F.p(door.x, door.z - 0.1, door.y), F });
  return { F, porchTop };
}

/* ======================================================================= */
/*  SPECIAL MASSES — the two silhouettes a western town is recognised by.   */
/* ======================================================================= */

/** Lancet window: rectangular light with a pointed head. */
function lancet(B, F, M, x, y, w, h, o = {}) {
  const wear = o.wear;
  const head = o.head != null ? o.head : w * 0.85;
  const wall = o.wallZ != null ? o.wallZ : 0;
  const inner = wall + 0.24;
  const lit = o.lit;
  const glassMat = lit ? M.glassLit : M.glass;
  const gcol = lit ? [1, 1, 1] : [0.30, 0.33, 0.36];

  // reveal + interior darkness
  const rv = { us: 0.9, vs: 0.9, wear, col: [0.72, 0.68, 0.60], nu: 1, nv: 1 };
  B.faceX(M.plank, F, x, wall, inner, y, y + h, +1, rv);
  B.faceX(M.plank, F, x + w, wall, inner, y, y + h, -1, rv);
  B.faceY(M.plank, F, y, x, x + w, wall, inner, +1, rv);
  B.faceZ(M.plank, F, inner + 0.5, x - 0.08, x + w + 0.08, y - 0.08, y + h + head + 0.1, -1,
    { us: 1, vs: 1, wear, col: [0.05, 0.042, 0.035], nu: 1, nv: 1 });

  const gz = inner - 0.035;
  const go = { us: 0.8, vs: 0.8, wear, col: gcol, nu: 1, nv: 2 };
  B.faceZ(glassMat, F, gz, x + 0.03, x + w - 0.03, y + 0.03, y + h, -1, go);
  // pointed head, both the glass and the trim
  const bkt = B.bucket(glassMat);
  void bkt;
  B.tri(glassMat, F.p(x + w - 0.03, gz, y + h), F.p(x + 0.03, gz, y + h),
    F.p(x + w * 0.5, gz, y + h + head),
    { us: 0.8, vs: 0.8, col: gcol, wear, uv: [[0, 0], [w, 0], [w * 0.5, head]] });

  const t = 0.10;
  const tw = { us: 1.4, vs: 0.55, wear, col: o.trimCol || [1.02, 0.98, 0.88], nv: 1 };
  B.box(M.plank, F, x - t, x, wall - 0.06, wall + 0.01, y - 0.04, y + h + head * 0.4, tw);
  B.box(M.plank, F, x + w, x + w + t, wall - 0.06, wall + 0.01, y - 0.04, y + h + head * 0.4, tw);
  B.box(M.plank, F, x - t * 1.6, x + w + t * 1.6, wall - 0.14, wall + 0.01, y - 0.11, y - 0.03, tw);
  // mullion
  B.box(M.plank, F, x + w * 0.5 - 0.022, x + w * 0.5 + 0.022, gz - 0.04, gz + 0.01, y + 0.03, y + h + head * 0.55,
    { us: 0.5, vs: 0.28, wear, col: [0.56, 0.51, 0.44], nu: 1, nv: 1 });
  return { x: x + w * 0.5, y: y + h * 0.5, z: wall - 0.1 };
}

/**
 * Church — nave with a steep gable running back from the street, and a square
 * entrance tower carrying a belfry and a spire. The spire is the single tallest
 * thing in town and closes the far end of the street.
 */
export function buildChurch(B, M, spec, rand, out) {
  const F = new Frame(spec.ox, spec.floorY, spec.oz, spec.dirX, spec.dirZ);
  const w = spec.w, d = spec.d, h = spec.h;
  const x0 = -w * 0.5, x1 = w * 0.5;
  const gy = spec.groundY - spec.floorY;
  const by = spec.baseY - spec.floorY;
  const wear = [spec.groundY - 0.05, spec.floorY + h + 1.4, spec.grime, spec.chalk];
  const wcol = spec.color;
  const wo = { us: UV.wall.us, vs: UV.wall.vs, col: wcol, wear, step: 1.6, uo: spec.uvo || 0, vo: spec.uvo2 || 0 };
  const yR = h + w * 0.5 * spec.pitch;

  /* foundation */
  B.box(M.stone, F, x0 - 0.14, x1 + 0.14, -0.14, d + 0.14, Math.min(by, gy) - 0.75, -0.10,
    { us: UV.stone.us, vs: UV.stone.vs, col: [0.90, 0.86, 0.80], wear, step: 1.3, skip: 'bt' });

  /* nave walls */
  B.faceX(M.plank, F, x0, 0, d, -0.10, h, -1, wo);
  B.faceX(M.plank, F, x1, 0, d, -0.10, h, +1, wo);
  B.faceZ(M.plank, F, d, x0, x1, -0.10, h, +1, wo);
  B.faceZ(M.plank, F, 0, x0, x1, -0.10, h, -1, wo);
  // gable triangles
  B.tri(M.plank, F.p(x1, 0, h), F.p(x0, 0, h), F.p(0, 0, yR),
    { us: UV.wall.us, vs: UV.wall.vs, col: wcol, wear, uv: [[0, 0], [w, 0], [w * 0.5, yR - h]] });
  B.tri(M.plank, F.p(x0, d, h), F.p(x1, d, h), F.p(0, d, yR),
    { us: UV.wall.us, vs: UV.wall.vs, col: wcol, wear, uv: [[0, 0], [w, 0], [w * 0.5, yR - h]] });
  gableRoof(B, F, M, {
    x0, x1, z0: 0, z1: d, yE: h, yR, along: 'z', mat: M.shingle, uv: UV.roof,
    wear, col: spec.roofColor, sag: 0.07, oh: 0.50,
  });

  /* corner boards */
  const cb = { us: 0.7, vs: 0.5, col: spec.trimCol, wear, nv: 3 };
  for (const [a, b] of [[x0 - 0.06, x0 + 0.12], [x1 - 0.12, x1 + 0.06]]) {
    B.box(M.plank, F, a, b, -0.06, 0.12, -0.06, h + 0.06, cb);
    B.box(M.plank, F, a, b, d - 0.12, d + 0.06, -0.06, h + 0.06, cb);
  }

  /* lancets down both flanks */
  const n = Math.max(2, Math.floor((d - 3.2) / 3.1));
  for (const [sx, sgn] of [[x0, -1], [x1, +1]]) {
    for (let i = 0; i < n; i++) {
      const cz = 2.2 + ((d - 3.6) * (i + 0.5)) / n;
      const SF = F.sub(sx, cz, 0, sgn * Math.PI * 0.5);
      const lit = ((spec.litMask >> i) & 1) === 1;
      const g = lancet(B, SF, M, -0.44, 1.28, 0.88, 1.85, {
        wear, lit, trimCol: spec.trimCol,
      });
      if (lit) out.glow.push(SF.p(g.x, g.z - 0.4, g.y));
    }
  }

  /* ------------------------------------------------------------- tower */
  const tw = spec.towerW, th = spec.towerH;
  const tz0 = -tw * 0.94, tz1 = 0.06;
  const tx0 = -tw * 0.5, tx1 = tw * 0.5;
  const tco = { us: UV.wall.us, vs: UV.wall.vs, col: wcol, wear, step: 1.5 };
  B.box(M.stone, F, tx0 - 0.14, tx1 + 0.14, tz0 - 0.14, tz1, Math.min(by, gy) - 0.75, -0.10,
    { us: UV.stone.us, vs: UV.stone.vs, col: [0.90, 0.86, 0.80], wear, step: 1.2, skip: 'bt' });

  const door = doorUnit(B, F.sub(0, tz0, 0), M, -0.72, 0, 1.44, 2.55, {
    wear, wallZ: 0, thick: 0.26, trimCol: spec.trimCol, col: spec.doorColor,
  });
  B.wallHoles(M.plank, F, tz0, tx0, tx1, -0.10, th, -1,
    [{ x0: -0.72, x1: 0.72, y0: -0.02, y1: 2.55 }], tco);
  B.faceX(M.plank, F, tx0, tz0, tz1, -0.10, th, -1, tco);
  B.faceX(M.plank, F, tx1, tz0, tz1, -0.10, th, +1, tco);
  for (const [a, b] of [[tx0 - 0.07, tx0 + 0.13], [tx1 - 0.13, tx1 + 0.07]]) {
    B.box(M.plank, F, a, b, tz0 - 0.07, tz0 + 0.13, -0.06, th + 0.20, cb);
  }
  // a lancet high on the tower front
  lancet(B, F.sub(0, tz0, 0), M, -0.38, 3.55, 0.76, 1.35, { wear, trimCol: spec.trimCol });

  /* belfry: cornice, open arches with louvres, cap cornice */
  const by0 = th, by1 = th + 2.35;
  const ov = 0.22;
  B.box(M.plank, F, tx0 - ov, tx1 + ov, tz0 - ov, tz1 + ov * 0.4, by0, by0 + 0.24,
    { us: 1.2, vs: 0.4, col: spec.trimCol, wear, nv: 1 });
  const pillar = 0.30;
  for (const [px, pz] of [[tx0, tz0], [tx1, tz0], [tx0, tz1], [tx1, tz1]]) {
    B.box(M.plank, F, px - pillar * (px < 0 ? 0 : 1), px + pillar * (px < 0 ? 1 : 0),
      pz - pillar * (pz < 0 ? 0 : 1), pz + pillar * (pz < 0 ? 1 : 0),
      by0 + 0.24, by1, { us: 0.6, vs: 0.5, col: wcol, wear, nu: 1, nv: 2 });
  }
  // the dark of the bell chamber, plus louvre slats across the openings
  B.box(M.plank, F, tx0 + 0.28, tx1 - 0.28, tz0 + 0.28, tz1 - 0.28, by0 + 0.24, by1,
    { us: 1, vs: 1, col: [0.045, 0.040, 0.036], wear, nu: 1, nv: 1, skip: 'bt' });
  for (let i = 0; i < 6; i++) {
    const ly = by0 + 0.42 + (i * (by1 - by0 - 0.7)) / 6;
    B.box(M.plank, F, tx0 + 0.30, tx1 - 0.30, tz0 - 0.02, tz0 + 0.10, ly, ly + 0.10,
      { us: 0.7, vs: 0.3, col: spec.trimCol, wear, nu: 1, nv: 1 });
    B.box(M.plank, F, tx0 - 0.02, tx0 + 0.10, tz0 + 0.30, tz1 - 0.30, ly, ly + 0.10,
      { us: 0.7, vs: 0.3, col: spec.trimCol, wear, nu: 1, nv: 1 });
    B.box(M.plank, F, tx1 - 0.10, tx1 + 0.02, tz0 + 0.30, tz1 - 0.30, ly, ly + 0.10,
      { us: 0.7, vs: 0.3, col: spec.trimCol, wear, nu: 1, nv: 1 });
  }
  // the bell itself, just visible
  B.tube(M.rust, F.p(0, (tz0 + tz1) * 0.5, by1 - 0.34), F.p(0, (tz0 + tz1) * 0.5, by1 - 0.95),
    0.16, 0.34, 10, { us: 0.4, vs: 0.4, col: [0.62, 0.52, 0.34], wear, caps: true });

  B.box(M.plank, F, tx0 - ov * 1.3, tx1 + ov * 1.3, tz0 - ov * 1.3, tz1 + ov * 0.6, by1, by1 + 0.26,
    { us: 1.2, vs: 0.4, col: spec.trimCol, wear, nv: 1 });

  /* spire: an eight-sided pyramid so the silhouette is not a crude tetra */
  const sy0 = by1 + 0.26, sy1 = sy0 + spec.spireH;
  const cxm = 0, czm = (tz0 + tz1) * 0.5;
  const R = tw * 0.5 + ov * 1.3;
  const SIDES = 8;
  for (let i = 0; i < SIDES; i++) {
    const a0 = (i / SIDES) * Math.PI * 2 + Math.PI / SIDES;
    const a1 = ((i + 1) / SIDES) * Math.PI * 2 + Math.PI / SIDES;
    const r = R / Math.cos(Math.PI / SIDES);
    const p0 = F.p(cxm + Math.cos(a0) * r, czm + Math.sin(a0) * r, sy0);
    const p1 = F.p(cxm + Math.cos(a1) * r, czm + Math.sin(a1) * r, sy0);
    const ap = F.p(cxm, czm, sy1);
    const kk = 0.90 + 0.16 * ((i * 5) % 4) / 4;
    B.tri(M.shingle, p1, p0, ap, {
      us: UV.roof.us, vs: UV.roof.vs, wear,
      col: [spec.roofColor[0] * kk, spec.roofColor[1] * kk, spec.roofColor[2] * kk],
      uv: [[0, 0], [2 * r * Math.sin(Math.PI / SIDES), 0], [r * Math.sin(Math.PI / SIDES), spec.spireH]],
    });
  }
  /* finial + cross */
  B.tube(M.rust, F.p(cxm, czm, sy1 - 0.1), F.p(cxm, czm, sy1 + 1.05), 0.05, 0.035, 6,
    { us: 0.3, vs: 0.4, col: [0.44, 0.40, 0.34], wear });
  B.box(M.rust, F, cxm - 0.30, cxm + 0.30, czm - 0.025, czm + 0.025, sy1 + 0.62, sy1 + 0.72,
    { us: 0.3, vs: 0.2, col: [0.44, 0.40, 0.34], wear, nu: 1, nv: 1 });

  out.doors.push({ p: F.p(door.x, tz0 - 0.6, door.y), F });
  out.lamps.push({ p: F.p(1.05, tz0 - 0.28, 2.72), local: { x: 1.05, y: 2.72, z: tz0 - 0.28 }, F });
  return { F, spireTop: F.p(cxm, czm, sy1 + 1.1), towerFront: tz0 };
}

/**
 * Barn / livery. A gambrel roof is the whole point: it is the one profile in a
 * western town that is neither a triangle nor a rectangle, so it does more for
 * the skyline than another false front would.
 */
export function buildBarn(B, M, spec, rand, out) {
  const F = new Frame(spec.ox, spec.floorY, spec.oz, spec.dirX, spec.dirZ);
  const w = spec.w, d = spec.d, h = spec.h;
  const x0 = -w * 0.5, x1 = w * 0.5;
  const gy = spec.groundY - spec.floorY;
  const by = spec.baseY - spec.floorY;
  const wear = [spec.groundY - 0.05, spec.floorY + h + 2.2, spec.grime, spec.chalk];
  const wcol = spec.color;
  const wo = { us: UV.wallV.us, vs: UV.wallV.vs, rot: 1, col: wcol, wear, step: 1.7, uo: spec.uvo || 0, vo: spec.uvo2 || 0 };

  /* gambrel profile */
  const brk = w * 0.30;
  const y1g = h + w * 0.24;
  const y2g = y1g + w * 0.155;
  const prof = [[x0, h], [-brk, y1g], [0, y2g], [brk, y1g], [x1, h]];

  /* sill + walls */
  B.box(M.stone, F, x0 - 0.13, x1 + 0.13, -0.13, d + 0.13, Math.min(by, gy) - 0.8, -0.12,
    { us: UV.stone.us, vs: UV.stone.vs, col: [0.86, 0.82, 0.76], wear, step: 1.3, skip: 'bt' });

  const doorW = 4.5, doorH = 4.05;
  const loftY = h + 0.55;
  const holes = [
    { x0: -doorW * 0.5, x1: doorW * 0.5, y0: -0.04, y1: doorH },
  ];
  B.wallHoles(M.plank, F, 0, x0, x1, -0.12, h, -1, holes, wo);
  B.faceX(M.plank, F, x0, 0, d, -0.12, h, -1, wo);
  B.faceX(M.plank, F, x1, 0, d, -0.12, h, +1, wo);
  B.faceZ(M.plank, F, d, x0, x1, -0.12, h, +1, wo);

  /* board-and-batten strapping: the relief the shaded facade needs */
  {
    const bcol = [wcol[0] * 1.09, wcol[1] * 1.07, wcol[2] * 1.05];
    battens(B, M, F, 'z', 0, -1, x0 + 0.3, x1 - 0.3, -0.10, h - 0.03,
      { wear, col: bcol, pitch: 0.66, skip: [[-doorW * 0.5 - 0.2, doorW * 0.5 + 0.2]] });
    battens(B, M, F, 'x', x0, -1, 0.3, d - 0.3, -0.10, h - 0.03, { wear, col: bcol, pitch: 0.66 });
    battens(B, M, F, 'x', x1, +1, 0.3, d - 0.3, -0.10, h - 0.03, { wear, col: bcol, pitch: 0.66 });
    battens(B, M, F, 'z', d, +1, x0 + 0.3, x1 - 0.3, -0.10, h - 0.03, { wear, col: bcol, pitch: 0.66 });
  }

  /* gable fills, front and back, as a fan across the gambrel profile */
  const fillFront = (z, front) => {
    const P = prof.map((p) => F.p(p[0], z, p[1]));
    const uvp = prof.map((p) => [p[0] + w * 0.5, p[1] - h]);
    const holeTop = front ? loftY + 2.0 : -1;
    for (let i = 0; i < 3; i++) {
      const a = front ? 4 : 0;
      const b = front ? i : 4 - i;
      const c = front ? i + 1 : 3 - i;
      B.tri(M.plank, P[a], P[b], P[c], {
        us: UV.wallV.us, vs: UV.wallV.vs, rot: 1, col: wcol, wear,
        uv: [uvp[a], uvp[b], uvp[c]],
      });
    }
    void holeTop;
  };
  fillFront(0, true);
  fillFront(d, false);

  /* gambrel roof: four planes */
  const oh = 0.44;
  const rmat = spec.roofMat === 'iron' ? M.iron : M.shingle;
  const ruv = spec.roofMat === 'iron' ? UV.iron : UV.roof;
  const rc = spec.roofColor;
  const rcol = (p, u, v) => {
    const n = Math.sin(u * 23.3 + p[1] * 2.9) * Math.sin(v * 17.7 + p[0] * 0.6 + p[2] * 0.6);
    const k = 1 + 0.14 * n - (n > 0.78 ? 0.26 : 0);
    return [rc[0] * k, rc[1] * k, rc[2] * k];
  };
  const slope = (ax, ay, bx2, by2, mirror) => {
    const z0 = -oh, z1 = d + oh;
    if (!mirror) {
      B.quad(rmat, F.p(ax, z0, ay), F.p(ax, z1, ay), F.p(bx2, z1, by2), F.p(bx2, z0, by2),
        { us: ruv.us, vs: ruv.vs, col: rcol, wear, step: 1.4 });
    } else {
      B.quad(rmat, F.p(ax, z1, ay), F.p(ax, z0, ay), F.p(bx2, z0, by2), F.p(bx2, z1, by2),
        { us: ruv.us, vs: ruv.vs, col: rcol, wear, step: 1.4 });
    }
  };
  slope(x0 - oh * 0.5, h - oh * 0.35, -brk, y1g, false);
  slope(-brk, y1g, 0, y2g, false);
  slope(x1 + oh * 0.5, h - oh * 0.35, brk, y1g, true);
  slope(brk, y1g, 0, y2g, true);
  // ridge cap + eave fascias
  B.box(M.plank, F, -0.14, 0.14, -oh, d + oh, y2g - 0.05, y2g + 0.10,
    { us: 1.2, vs: 0.4, col: [0.60, 0.55, 0.48], wear, nu: 1 });
  for (const xx of [x0 - oh * 0.5, x1 + oh * 0.5]) {
    B.box(M.plank, F, xx - 0.075, xx + 0.075, -oh, d + oh, h - oh * 0.35 - 0.27, h - oh * 0.35 + 0.02,
      { us: 1.4, vs: 0.36, col: [0.72, 0.67, 0.59], wear, nu: 1 });
  }
  /* Rake boards following the gambrel profile at both gable ends. The pass-2
   * barn silhouette was the roof plane meeting the gable wall in a one-pixel
   * line; the whole read of a gambrel is that stepped band of barge board.  */
  {
    const rakePath = [
      [x0 - oh * 0.5, h - oh * 0.35], [-brk, y1g], [0, y2g], [brk, y1g],
      [x1 + oh * 0.5, h - oh * 0.35],
    ];
    for (const [ze, sg] of [[-oh, -1], [d + oh, +1]]) {
      rakeBoard(B, M, F, 'z', ze, sg, rakePath,
        { wear, col: [0.82, 0.77, 0.68], dp: 0.28, th: 0.10 });
    }
    // rafter tails ticking out below both eaves
    rafterTails(B, M, F, {
      axis: 'z', a0: -oh + 0.2, a1: d + oh - 0.2, b0: x0 - oh * 0.5, b1: x0 + 0.06,
      y: h - oh * 0.35 - 0.06, wear, seed: 6.2, pitch: 0.72,
    });
    rafterTails(B, M, F, {
      axis: 'z', a0: -oh + 0.2, a1: d + oh - 0.2, b0: x1 - 0.06, b1: x1 + oh * 0.5,
      y: h - oh * 0.35 - 0.06, wear, seed: 8.4, pitch: 0.72,
    });
  }

  /* the big doors: two leaves on an iron track, one rolled part-open */
  const open = 0.9 + rand() * 0.9;
  B.faceZ(M.plank, F, 0.85, -doorW * 0.5 - 0.1, doorW * 0.5 + 0.1, -0.05, doorH + 0.05, -1,
    { us: 1, vs: 1, col: [0.045, 0.038, 0.032], wear, nu: 1, nv: 1 });
  const leaf = (cx, dir) => {
    const lw = doorW * 0.5;
    const px = cx + dir * open;
    B.box(M.plank, F, px - lw * 0.5, px + lw * 0.5, -0.19, -0.11, 0.02, doorH,
      { us: UV.wallV.us, vs: UV.wallV.vs, rot: 1, col: spec.doorColor, wear, nu: 3, nv: 4 });
    // Z-brace
    B.box(M.plank, F, px - lw * 0.5, px + lw * 0.5, -0.24, -0.19, 0.30, 0.44,
      { us: 0.8, vs: 0.3, col: [spec.doorColor[0] * 1.2, spec.doorColor[1] * 1.2, spec.doorColor[2] * 1.2], wear, nu: 1, nv: 1 });
    B.box(M.plank, F, px - lw * 0.5, px + lw * 0.5, -0.24, -0.19, doorH - 0.5, doorH - 0.36,
      { us: 0.8, vs: 0.3, col: [spec.doorColor[0] * 1.2, spec.doorColor[1] * 1.2, spec.doorColor[2] * 1.2], wear, nu: 1, nv: 1 });
    B.tube(M.plank, F.p(px - lw * 0.44, -0.215, 0.44), F.p(px + lw * 0.44, -0.215, doorH - 0.5),
      0.065, 0.065, 4, { us: 0.6, vs: 0.6, col: [spec.doorColor[0] * 1.2, spec.doorColor[1] * 1.2, spec.doorColor[2] * 1.2], wear });
  };
  leaf(-doorW * 0.25, -1);
  leaf(doorW * 0.25, +1);
  B.box(M.rust, F, -doorW * 0.5 - open - 1.2, doorW * 0.5 + open + 1.2, -0.30, -0.24, doorH + 0.06, doorH + 0.16,
    { us: 0.8, vs: 0.3, col: [0.68, 0.58, 0.46], wear, nv: 1 });

  /* hayloft door + hoist beam */
  const lw2 = 1.35;
  B.faceZ(M.plank, F, 0.5, -lw2 * 0.5 - 0.08, lw2 * 0.5 + 0.08, loftY - 0.08, loftY + 1.85, -1,
    { us: 1, vs: 1, col: [0.05, 0.043, 0.036], wear, nu: 1, nv: 1 });
  B.box(M.plank, F, -lw2 * 0.5, lw2 * 0.5 - 0.34, -0.17, -0.09, loftY, loftY + 1.8,
    { us: 0.9, vs: 0.34, col: spec.doorColor, wear, nu: 2, nv: 3 });
  B.tube(M.plank, F.p(0, -0.05, y1g + 0.45), F.p(0, -1.35, y1g + 0.62), 0.10, 0.09, 6,
    { us: 0.5, vs: 0.6, col: [0.62, 0.56, 0.47], wear, caps: true });
  B.tube(M.rust, F.p(0, -1.15, y1g + 0.52), F.p(0, -1.15, y1g - 0.55), 0.016, 0.016, 4,
    { us: 0.2, vs: 0.5, col: [0.5, 0.44, 0.36], wear });

  /* side windows + a ventilator cupola on the ridge */
  const nW = Math.max(1, Math.floor(d / 4.6));
  for (const [sx, sgn] of [[x0, -1], [x1, +1]]) {
    for (let i = 0; i < nW; i++) {
      const cz = 2.4 + ((d - 4.2) * (i + 0.5)) / nW;
      const SF = F.sub(sx, cz, 0, sgn * Math.PI * 0.5);
      windowUnit(B, SF, M, -0.46, 2.05, 0.92, 1.05, { wear, wallZ: 0, thick: 0.20, trimCol: spec.trimCol });
    }
  }
  const cz = d * 0.42, cw = 1.05;
  B.box(M.plank, F, -cw * 0.5, cw * 0.5, cz - cw * 0.5, cz + cw * 0.5, y2g - 0.1, y2g + 1.0,
    { us: 0.8, vs: 0.4, col: wcol, wear, nu: 1, nv: 2 });
  for (let i = 0; i < 3; i++) {
    const ly = y2g + 0.12 + i * 0.26;
    B.box(M.plank, F, -cw * 0.55, cw * 0.55, cz - cw * 0.52, cz - cw * 0.42, ly, ly + 0.12,
      { us: 0.5, vs: 0.3, col: spec.trimCol, wear, nu: 1, nv: 1 });
  }
  B.quad(rmat, F.p(-cw * 0.72, cz - cw * 0.72, y2g + 1.0), F.p(cw * 0.72, cz - cw * 0.72, y2g + 1.0),
    F.p(0, cz, y2g + 1.62), F.p(0, cz, y2g + 1.62),
    { us: ruv.us, vs: ruv.vs, col: rc, wear, nu: 2, nv: 1 });
  B.quad(rmat, F.p(cw * 0.72, cz + cw * 0.72, y2g + 1.0), F.p(-cw * 0.72, cz + cw * 0.72, y2g + 1.0),
    F.p(0, cz, y2g + 1.62), F.p(0, cz, y2g + 1.62),
    { us: ruv.us, vs: ruv.vs, col: rc, wear, nu: 2, nv: 1 });
  B.quad(rmat, F.p(cw * 0.72, cz - cw * 0.72, y2g + 1.0), F.p(cw * 0.72, cz + cw * 0.72, y2g + 1.0),
    F.p(0, cz, y2g + 1.62), F.p(0, cz, y2g + 1.62),
    { us: ruv.us, vs: ruv.vs, col: rc, wear, nu: 2, nv: 1 });
  B.quad(rmat, F.p(-cw * 0.72, cz + cw * 0.72, y2g + 1.0), F.p(-cw * 0.72, cz - cw * 0.72, y2g + 1.0),
    F.p(0, cz, y2g + 1.62), F.p(0, cz, y2g + 1.62),
    { us: ruv.us, vs: ruv.vs, col: rc, wear, nu: 2, nv: 1 });

  out.doors.push({ p: F.p(0, -1.2, 0), F });
  out.lamps.push({ p: F.p(doorW * 0.5 + 1.0, -0.28, 3.15), local: { x: doorW * 0.5 + 1.0, y: 3.15, z: -0.28 }, F });
  return { F, ridge: y2g, front: 0 };
}
