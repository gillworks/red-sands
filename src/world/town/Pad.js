/**
 * Pad — THE SINGLE AUTHORITY FOR THE GROUND THE TOWN STANDS ON.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ----------------------------------------------------------------------------
 * The town used to lay its street ON TOP of the terrain: `Street` built a GRADE
 * (a morphological closing of the cross-section maxima, +0.30 m) and `Ground`
 * lofted the roadway onto it. Nothing told the terrain, so
 * `ctx.world.getHeight()` — which the character controller, the horse, the foot
 * IK, wildlife, vegetation, scatter, particles and footstep audio all read —
 * still returned the RAW terrain underneath. Measured over the town footprint
 * the visible street sat 0.4–1.4 m above the queried height, so the rider was
 * buried to the chest and the horse to the shoulders while standing in the
 * street.
 *
 * The rule this file enforces is:
 *
 *     WHAT THE PLAYER SEES UNDERFOOT AND WHAT ctx.world.getHeight RETURNS
 *     ARE THE SAME SURFACE.
 *
 * It does that by publishing the pad through Terrain's ground-height override
 * registry. Terrain calls `makeTownPad()` during generation and registers
 * `surfaceAt()` (blended by `weightAt()`) with `Terrain.addHeightOverride`, so
 * every consumer of `ctx.world.getHeight` sees the graded street. Town then
 * reuses the very same spine and grade table — so the settlement does not move
 * a millimetre — and skins the roadway a few centimetres over the height the
 * query reports instead of a metre above it.
 *
 * ----------------------------------------------------------------------------
 * WHY AN OVERRIDE AND NOT A CARVE OF THE HEIGHTFIELD
 * ----------------------------------------------------------------------------
 * Carving the pad into `Terrain.H` was tried first and is the wrong tool. `H`
 * is also what Vegetation's grass shader samples, so raising it lifts every
 * blade of grass on the site up to street level: measured, the main street came
 * back as a meadow, with grass density 0.42–0.61 straight down the crown, and
 * no combination of splat weights, moisture or surface class could suppress it
 * (Ecology's region weight has a hard floor and its regions are hundreds of
 * metres wide). The heightfield therefore keeps describing the natural ground
 * that the grass grows out of and the road buries; the QUERY describes the made
 * ground the player stands on. The two differ only where the road mesh covers
 * the difference.
 *
 * ----------------------------------------------------------------------------
 * WHAT LIVES WHERE, AND WHY
 * ----------------------------------------------------------------------------
 * The override grid is 2 m/cell. That is the constraint on this split:
 *
 *   padMacro()  crown, verge shoulder and general churn — wavelengths of many
 *               metres. This goes into the override, so the query sees it.
 *   padMicro()  wheel ruts and fine grain — sub-metre features the grid cannot
 *               represent. These stay on the road mesh only, and are
 *               deliberately shallow (≤ 5 cm) so the mesh can never dip through
 *               the ground it is skinning. The rut *shading* in Ground.js is
 *               untouched, which is what actually reads on screen.
 *
 * Residual disagreement between the road mesh and `getHeight` is therefore the
 * skin thickness plus the rut micro-relief: measured 1–11 cm across the whole
 * footprint, mean 4.7 cm.
 */

import { rng } from '../../core/Context.js';
import { Street, streetBearing, sunAzimuthAt } from './Layout.js';

/**
 * Shared plan constants. Terrain publishes these and Town builds to these; if
 * they ever disagree the ground splits in two again, so they live in one place.
 */
export const TOWN_PLAN = {
  length: 144,        // street length between the end lots
  corridor: 34,       // half-width the grade envelope samples
  plateau: 31.0,      // half-width that is fully graded
  rim: 44.0,          // half-width where the pad geometry stops
  sPad: 38,           // pad overrun past each end of the street
  sFade: 14,          // longitudinal feather at each end of the pad
  hour: 16.5,         // afternoon key the solar street bearing is aimed from
  /**
   * Road-mesh skin thickness over the queried ground, metres.
   *
   * PASS 11 raised this from 0.055/0.020. The reason is the rut clearance
   * budget: the road mesh conforms to the ANALYTIC `getHeight`, but the terrain
   * clipmap under it renders its own tessellation, which interpolates between
   * grid points and departs from the analytic surface by a couple of
   * centimetres on curved ground. With the pad's cross-section finally
   * tessellated finely enough to resolve the wheel ruts (see town/Ground.js),
   * the rut floors came out at ~3 mm over the query — inside that error — and
   * the terrain punched back through them as a dithered black stipple down both
   * tracks. The invariant is
   *     skin + skinCrown - (RUT_DEPTH + grain)  >=  ~4 cm
   * and it is now 0.103 - 0.055 = 4.8 cm.
   */
  skin: 0.075,
  /** Extra skin across the fully-graded plateau (buries the terrain grid). */
  skinCrown: 0.028,
};

/* --------------------------------------------------------------- noise ---- */
/* Value noise, identical to the one Ground.js used, kept here so the surface
   model has exactly one definition. */

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}
export function fbm2(x, y) {
  let a = 0, w = 0.5, fx = x, fy = y;
  for (let i = 0; i < 4; i++) { a += w * vnoise(fx, fy); fx *= 2.03; fy *= 2.03; w *= 0.5; }
  return a;
}
export const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Wheel-rut centrelines, in metres from the crown of the road. */
export const RUTS = [-5.5, -2.3, 2.3, 5.5];

/**
 * Geometric rut depth kept on the mesh. Shallow on purpose — see the header:
 * the road is a ~5.5 cm skin over the height query, so a rut deeper than the
 * skin would put the visible street below the ground the player stands on.
 *
 * PASS 11: 0.050 -> 0.045, with the fine-grain term tightened from ±0.014 to
 * ±0.010 and the skin raised — see TOWN_PLAN.skin for the clearance budget. The
 * real reason the ruts were invisible was never their depth: Ground.js sampled
 * them on a 1.9 m lattice, where a sigma-0.39 m Gaussian is caught at about a
 * third of its amplitude and then smeared across a metre and a half.
 */
const RUT_DEPTH = 0.045;

/**
 * The part of the street surface the height override carries: a 15 cm crown
 * falling to the verges, the shoulder rolling away past 11 m, and the general
 * unevenness of made ground.
 */
export function padMacro(s, t) {
  const at = Math.abs(t);
  let y = 0.15 * (1 - Math.min(1, (at / 9.8) ** 2));   // crown
  y -= smooth(11.0, 17.0, at) * 0.22;                  // verge shoulder
  y += (fbm2(s * 0.22 + 11, t * 0.22) - 0.5) * 0.085;  // churn
  return y;
}

/**
 * The part that only the road mesh carries: wheel ruts that wander a few
 * centimetres either side of true, plus fine grain. Bounded to roughly
 * [-0.064, +0.014] m so the skinned road never sinks through the ground under it.
 */
export function padMicro(s, t) {
  let y = 0;
  const wander = (fbm2(s * 0.035 + 4.1, 0) - 0.5) * 1.6;
  for (const rt of RUTS) {
    const d = Math.abs(t - (rt + wander * (rt > 0 ? 1 : -1) * 0.5));
    const depth = RUT_DEPTH * (0.6 + 0.4 * fbm2(s * 0.09, rt));
    y -= depth * Math.exp(-(d * d) / 0.30);
  }
  y += (fbm2(s * 0.9 + 31, t * 0.9) - 0.5) * 0.020;
  return y;
}

/** Full street relief, for the legacy (no-override) path. */
export function padRelief(s, t) { return padMacro(s, t) + padMicro(s, t); }

/* ---------------------------------------------------------------- the pad - */

/**
 * Build the town pad: the street spine, its grade table, and the (s,t) →
 * world-height surface Terrain registers as a ground-height override.
 *
 * MUST be called with the RAW terrain height sampler (`Terrain._rawHeight`),
 * not the composited query — the grade is an upper envelope of natural ground,
 * so feeding it its own output would ratchet the town upward every rebuild.
 *
 * @param {object} o { seed, site:{x,z,dir,relief}, dayOfYear, latitude, getHeight }
 */
export function makeTownPad(o) {
  const site = o.site;
  /* Same stream Town draws from, and Street consumes exactly the same four
     values first, so the spine here and the spine Town rebuilds are identical. */
  const rand = rng((o.seed ^ 0x7b19a3) >>> 0);
  const sunAz = sunAzimuthAt(TOWN_PLAN.hour,
    o.dayOfYear != null ? o.dayOfYear : 172,
    o.latitude != null ? o.latitude : 38);
  const contour = site.dir ? [site.dir.x, site.dir.z] : null;
  const bearing = streetBearing(sunAz, contour, site.relief || 0);

  const street = new Street({
    cx: site.x, cz: site.z, dx: bearing[0], dz: bearing[1],
    length: TOWN_PLAN.length, halfWidth: TOWN_PLAN.corridor,
    getHeight: o.getHeight, rand,
  });

  const SPAN = TOWN_PLAN.length * 0.5 + TOWN_PLAN.sPad;      // 110
  const RIMW = TOWN_PLAN.rim - 3.0;                          // 41

  /**
   * World (x,z) → street (s,t). The spine bends by only a few metres over its
   * length, so four fixed-point iterations land well inside a millimetre.
   */
  const st = { s: 0, t: 0 };
  const toStreet = (x, z, out = st) => {
    let s = (x - street.ox) * street.dx + (z - street.oz) * street.dz;
    let t = 0;
    for (let k = 0; k < 4; k++) {
      const c = street.centerRaw(s);
      const n = street.normalRaw(s);
      const ex = x - c[0], ez = z - c[1];
      t = ex * n[0] + ez * n[1];
      s += ex * n[1] - ez * n[0];        // tangent = (n.z, -n.x)
    }
    out.s = s; out.t = t;
    return out;
  };

  /** Blend weight of the pad against natural ground, 0..1. */
  const weightAt = (s, t) => {
    const wt = 1 - smooth(TOWN_PLAN.plateau, RIMW, Math.abs(t));
    if (wt <= 0) return 0;
    const ws = 1 - smooth(SPAN - TOWN_PLAN.sFade, SPAN, Math.abs(s));
    return wt * ws;
  };

  /** Finished ground height of the pad at street coordinates (s,t). */
  const surfaceAt = (s, t) => street.gradeAt(s) + padMacro(s, t);

  /** Half-extent of the square that contains everything the pad touches. */
  const bound = SPAN + TOWN_PLAN.rim + Math.abs(street.a1) + Math.abs(street.a2) + 8;

  return {
    street, sunAz, bearing, grade: street.grade,
    cx: site.x, cz: site.z,
    toStreet, weightAt, surfaceAt, bound,
    /** World-space convenience: { y, w } of the pad at (x,z). */
    sample(x, z) {
      const p = toStreet(x, z);
      const w = weightAt(p.s, p.t);
      return { y: w > 0 ? surfaceAt(p.s, p.t) : 0, w };
    },
  };
}
