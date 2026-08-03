import * as THREE from 'three';

/**
 * Folk — the townspeople.
 *
 * ============================================================================
 * WHY
 * ----------------------------------------------------------------------------
 * The blind A/B against real gameplay said it plainly: "a street with people is
 * alive; an identical street without them is a film set." Every reference frame
 * of a settlement has bodies in it — walking the boardwalk, standing in a
 * doorway, leaning on a rail, loading a wagon — and ours had none. That is the
 * single largest difference between the two town frames, larger than any
 * material or lighting gap, because it is a *category* difference: one image is
 * of a place, the other is of a set.
 *
 * ----------------------------------------------------------------------------
 * HOW IT IS BUILT — two draw calls for the whole population
 * ----------------------------------------------------------------------------
 * There is no skinning system in this project and adding one to move twenty
 * background figures would be absurd, so the rig is baked into the vertex
 * format instead:
 *
 *   aPart   which body part this vertex belongs to (torso / L,R leg /
 *           L,R arm / coat skirt)
 *   aPivot  the joint that part rotates about, in figure-local metres
 *   aZone   which garment this vertex is (coat, trousers, hat, skin)
 *
 * The vertex shader rotates each part about its own pivot by a sine of
 * `uTime * rate + phase`, both taken from per-instance attributes, so a walk
 * cycle costs a handful of ALU and NOTHING on the CPU. The instance matrix
 * carries position and facing, which IS updated per frame — but that is
 * twenty-odd `Matrix4.compose` calls against a pre-baked path, i.e. free.
 *
 * VALUES. These are FINAL LINEAR ALBEDOS and they are low on purpose: dyed
 * wool and cotton sit at 0.03-0.18 linear, skin at ~0.12. Authored at 0.3-0.8
 * the first time and the street filled with cream shop mannequins that metered
 * the same value as the sunlit road behind them — a figure only reads as a
 * person when it is a good deal DARKER than the ground it stands on.
 *
 * `aZone` plus three per-instance tint attributes give every figure its own
 * coat, trousers and hat colour out of ONE geometry, which is what buys the
 * variety of silhouette and value the reference street has without a variety of
 * meshes. Two prototypes (a coated/shirtsleeved figure, and a long-skirted one)
 * cover the shapes; everything else is instance data.
 *
 * Shadows go through a `customDepthMaterial` carrying the same vertex rig, so
 * the shadow walks with the figure instead of standing in a T-pose beside it.
 *
 * LOD is hard and cheap: past `FAR` metres an instance is simply not written,
 * and `mesh.count` is set to however many survived. Everything is authored so a
 * figure is ~700 triangles, which at 24 bodies is 17k — a rounding error next
 * to the 1.1 M the shot already draws.
 *
 * Deterministic: all randomness comes from the caller's `rand` (rng(seed)).
 */

const TAU = Math.PI * 2;
const fract = (x) => x - Math.floor(x);

/** Past this the figures are a couple of pixels and are not drawn at all. */
const FAR = 190;

/* -------------------------------------------------------------------------- */
/*  bodies, dying, and the reaction to a gunshot                                */
/* -------------------------------------------------------------------------- */

/**
 * ============================================================================
 * SOLID BODIES
 * ============================================================================
 * A townsman you can walk through is not a person, he is a poster. Each figure
 * registers ONE upright capsule with Physics as a `dynamic` collider whose
 * `position` is the agent's own `a.p` Vector3 — the same object this file
 * writes the instance matrix from — so tracking is free: no copy, no dirty
 * flag, no re-hash. The player, the horse and the camera arm all see it
 * through the ordinary `raycast`/`sphereCast` path.
 *
 * The BULLET tests against `NPC_HITBOX` instead, for the same reason the deer
 * do: a capsule cannot tell a head shot from a leg shot, and the wanted system
 * that another agent is building needs to know which it was.
 */
const NPC_RADIUS = 0.27;
const NPC_HEIGHT = 1.76;

/** [up, radius, part] in metres at scale 1, relative to the figure's feet. */
const NPC_HITBOX = [
  [1.645, 0.125, 'head'],
  [1.30, 0.215, 'chest'],
  [1.02, 0.225, 'body'],
  [0.55, 0.185, 'leg'],
];
const NPC_PART_DMG = { head: 5.0, chest: 1.5, body: 0.85, leg: 0.35 };

/** How long a body lies in the street before it is taken away, seconds. */
const CORPSE_TTL = 200;
const CORPSE_FADE = 4;

/** Anyone this close with something like a line of sight saw it happen. */
const WITNESS_RADIUS = 46;

/** Reaction states. */
const CALM = 0, FLINCH = 1, FLEE = 2;

/** Metres per second at a dead run, and the stride rate that matches it. */
const RUN_SPEED = 3.6;
const RUN_STRIDE = 1.9;
/** How far they get before they stop and look back. */
const RUN_DIST = 15;

/* -------------------------------------------------------------------------- */
/*  geometry accumulator                                                       */
/* -------------------------------------------------------------------------- */

/** Zones: 0 coat/body garment · 1 trousers/skirt · 2 hat/hair · 3 skin. */
const Z = { coat: 0, trou: 1, hat: 2, skin: 3 };

/** Parts: 0 static · 1 L leg · 2 R leg · 3 L arm · 4 R arm · 5 skirt. */
const P = { body: 0, legL: 1, legR: 2, armL: 3, armR: 4, skirt: 5 };

class Fig {
  constructor() {
    this.pos = []; this.nor = []; this.uv = []; this.col = [];
    this.zone = []; this.part = []; this.piv = []; this.idx = [];
    this.n = 0;
  }

  /**
   * Tapered prism from p0 to p1. `sides` 5–8. This is what keeps a limb from
   * reading as a box: a six-sided leg has a round enough silhouette at the
   * 20–80 px these figures occupy, and costs 36 quads.
   */
  limb(p0, p1, r0, r1, sides, part, pivot, zone, col, o = {}) {
    let ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const len = Math.hypot(ax, ay, az) || 1e-4;
    ax /= len; ay /= len; az /= len;
    let ux, uy, uz;
    if (Math.abs(ay) < 0.9) { ux = -az; uy = 0; uz = ax; } else { ux = 1; uy = 0; uz = 0; }
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ay * uz - az * uy, vy = az * ux - ax * uz, vz = ax * uy - ay * ux;
    const rings = o.rings || 2;
    const flat = o.flat || 0;             // squash across the u axis (a torso)
    const base = this.n;
    for (let k = 0; k <= rings; k++) {
      const t = k / rings;
      const r = r0 + (r1 - r0) * t;
      const cx = p0[0] + (p1[0] - p0[0]) * t;
      const cy = p0[1] + (p1[1] - p0[1]) * t;
      const cz = p0[2] + (p1[2] - p0[2]) * t;
      for (let i = 0; i <= sides; i++) {
        const a = (i / sides) * TAU;
        const ca = Math.cos(a), sa = Math.sin(a);
        const ru = r * (1 - flat * 0.42), rv = r;
        const px = cx + ux * ca * ru + vx * sa * rv;
        const py = cy + uy * ca * ru + vy * sa * rv;
        const pz = cz + uz * ca * ru + vz * sa * rv;
        const nx = ux * ca + vx * sa, ny = uy * ca + vy * sa, nz = uz * ca + vz * sa;
        const nl = Math.hypot(nx, ny, nz) || 1;
        this.pos.push(px, py, pz);
        this.nor.push(nx / nl, ny / nl, nz / nl);
        /* Cloth weave, not bunting. At 0.34 m per texture repeat the wool
           albedo read as horizontal STRIPES on a near figure — a barber
           pole in a hat. 9 cm per repeat puts the weave below the pixel
           grid at every distance these are seen at. */
        this.uv.push((a * 0.16) / 0.09, (t * len) / 0.09);
        /* Cloth is never one value. Without an albedo map (see build()) a
           garment renders as flat plastic, which is most of what made the first
           build read as shop mannequins; a couple of octaves of deterministic
           per-vertex blotch puts the folds and the dirt back. */
        const k2 = (o.shade ? (1 - o.shade * (1 - t)) : 1)
          * (0.86 + 0.28 * fract(Math.sin(i * 12.9898 + k * 4.1414 + (o.seed || 0)) * 43758.5453))
          * (0.94 + 0.12 * Math.sin(t * 9.7 + i * 2.3));
        this.col.push(col[0] * k2, col[1] * k2, col[2] * k2);
        this.zone.push(zone);
        this.part.push(part);
        this.piv.push(pivot[0], pivot[1], pivot[2]);
      }
    }
    this.n += (rings + 1) * (sides + 1);
    const row = sides + 1;
    for (let k = 0; k < rings; k++) {
      for (let i = 0; i < sides; i++) {
        const q = base + k * row + i;
        this.idx.push(q, q + 1, q + row + 1, q, q + row + 1, q + row);
      }
    }
    if (o.cap) {
      this._disc(p1, ax, ay, az, ux, uy, uz, vx, vy, vz, r1, sides, part, pivot, zone, col, 1);
    }
    if (o.capStart) {
      this._disc(p0, ax, ay, az, ux, uy, uz, vx, vy, vz, r0, sides, part, pivot, zone, col, -1);
    }
  }

  _disc(c, ax, ay, az, ux, uy, uz, vx, vy, vz, r, sides, part, pivot, zone, col, s) {
    const k0 = this.n;
    this.pos.push(c[0], c[1], c[2]);
    this.nor.push(ax * s, ay * s, az * s);
    this.uv.push(0.5, 0.5);
    this.col.push(col[0], col[1], col[2]);
    this.zone.push(zone); this.part.push(part);
    this.piv.push(pivot[0], pivot[1], pivot[2]);
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      this.pos.push(c[0] + (ux * ca + vx * sa) * r,
        c[1] + (uy * ca + vy * sa) * r,
        c[2] + (uz * ca + vz * sa) * r);
      this.nor.push(ax * s, ay * s, az * s);
      this.uv.push(0.5 + ca * r * 6.0, 0.5 + sa * r * 6.0);
      this.col.push(col[0], col[1], col[2]);
      this.zone.push(zone); this.part.push(part);
      this.piv.push(pivot[0], pivot[1], pivot[2]);
    }
    this.n += sides + 2;
    for (let i = 0; i < sides; i++) {
      if (s > 0) this.idx.push(k0, k0 + 1 + i, k0 + 2 + i);
      else this.idx.push(k0, k0 + 2 + i, k0 + 1 + i);
    }
  }

  /** Ellipsoid — head, hat crown, shoulder mass. */
  blob(c, rx, ry, rz, nu, nv, part, pivot, zone, col) {
    const base = this.n;
    for (let j = 0; j <= nv; j++) {
      const phi = (j / nv) * Math.PI;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      for (let i = 0; i <= nu; i++) {
        const th = (i / nu) * TAU;
        const nx = sp * Math.cos(th), ny = cp, nz = sp * Math.sin(th);
        this.pos.push(c[0] + nx * rx, c[1] + ny * ry, c[2] + nz * rz);
        const gx = nx / rx, gy = ny / ry, gz = nz / rz;
        const gl = Math.hypot(gx, gy, gz) || 1;
        this.nor.push(gx / gl, gy / gl, gz / gl);
        this.uv.push((i / nu) * 5.0, (j / nv) * 3.4);
        const kb = 0.88 + 0.24 * fract(Math.sin(i * 7.331 + j * 3.117) * 24634.6345);
        this.col.push(col[0] * kb, col[1] * kb, col[2] * kb);
        this.zone.push(zone); this.part.push(part);
        this.piv.push(pivot[0], pivot[1], pivot[2]);
      }
    }
    this.n += (nu + 1) * (nv + 1);
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const k = base + j * (nu + 1) + i;
        this.idx.push(k, k + 1, k + nu + 2, k, k + nu + 2, k + nu + 1);
      }
    }
  }

  /** Flat annulus in the XZ plane — hat brim. */
  brim(y, r0, r1, sides, part, pivot, zone, col) {
    const base = this.n;
    for (let k = 0; k < 2; k++) {
      const r = k === 0 ? r0 : r1;
      for (let i = 0; i <= sides; i++) {
        const a = (i / sides) * TAU;
        const droop = k === 1 ? -0.026 : 0;
        this.pos.push(Math.cos(a) * r, y + droop, Math.sin(a) * r);
        this.nor.push(0, 1, 0);
        this.uv.push(Math.cos(a) * r * 8, Math.sin(a) * r * 8);
        this.col.push(col[0], col[1], col[2]);
        this.zone.push(zone); this.part.push(part);
        this.piv.push(pivot[0], pivot[1], pivot[2]);
      }
    }
    this.n += 2 * (sides + 1);
    for (let i = 0; i < sides; i++) {
      const k = base + i;
      this.idx.push(k, k + sides + 1, k + sides + 2, k, k + sides + 2, k + 1);
    }
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aZone', new THREE.Float32BufferAttribute(this.zone, 1));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.setAttribute('aPivot', new THREE.Float32BufferAttribute(this.piv, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/* -------------------------------------------------------------------------- */
/*  the two prototypes                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A man: boots, trousers, a torso that tapers to the shoulders, a long coat
 * skirt hung at the waist (scaled to nothing on the shirtsleeved instances by
 * the coat tint alone — the skirt hangs on every figure but is only wide on the
 * ones whose coat colour differs from their trousers), sleeves, a neck, a head
 * and a hat with a real brim. Height 1.78 m at unit scale.
 */
function makeMan() {
  const f = new Fig();
  const hip = [0, 0.92, 0];
  const shL = [0.20, 1.42, 0], shR = [-0.20, 1.42, 0];
  const bootC = [0.30, 0.26, 0.22];

  /* legs — thigh + calf as one taper, then a boot */
  for (const [sx, part] of [[0.098, P.legL], [-0.098, P.legR]]) {
    const piv = [sx, 0.92, 0];
    f.limb([sx, 0.92, 0], [sx * 0.86, 0.18, 0.005], 0.088, 0.056, 6, part, piv, Z.trou,
      [1, 1, 1], { rings: 2, shade: 0.10 });
    // boot: shaft + a toe that projects forward, which is what makes the
    // silhouette read as a boot rather than as a peg
    f.limb([sx * 0.86, 0.22, 0.0], [sx * 0.86, 0.035, 0.0], 0.058, 0.052, 6, part, piv, Z.trou,
      bootC, { rings: 1 });
    f.limb([sx * 0.86, 0.045, -0.03], [sx * 0.86, 0.035, 0.10], 0.050, 0.036, 6, part, piv, Z.trou,
      bootC, { rings: 1, cap: true, capStart: true });
  }

  /* pelvis + torso */
  f.limb(hip, [0, 1.44, 0], 0.135, 0.152, 8, P.body, hip, Z.coat, [1, 1, 1],
    { rings: 3, flat: 0.30, shade: 0.14 });
  /* chest/shoulder mass — a separate blob is what gives the figure a shoulder
     line instead of a cylinder end */
  f.blob([0, 1.42, 0], 0.215, 0.105, 0.128, 8, 4, P.body, hip, Z.coat, [1, 1, 1]);

  /* coat skirt: hangs from the waist, flares, and sways with the gait */
  const waist = [0, 1.08, 0];
  f.limb([0, 1.10, 0], [0, 0.60, 0.012], 0.148, 0.195, 8, P.skirt, waist, Z.coat,
    [0.96, 0.96, 0.96], { rings: 2, flat: 0.22, shade: 0.22 });

  /* arms — upper + forearm in one taper, hands left as the sleeve end */
  for (const [sh, part] of [[shL, P.armL], [shR, P.armR]]) {
    f.limb([sh[0], sh[1], 0], [sh[0] * 1.06, 0.92, 0.05], 0.070, 0.048, 6, part, sh, Z.coat,
      [0.97, 0.97, 0.97], { rings: 2, shade: 0.10 });
    f.limb([sh[0] * 1.06, 0.93, 0.05], [sh[0] * 1.06, 0.86, 0.07], 0.045, 0.040, 5, part, sh, Z.skin,
      [1, 1, 1], { rings: 1, cap: true });
  }

  /* neck + head */
  f.limb([0, 1.44, 0], [0, 1.56, 0], 0.052, 0.050, 6, P.body, hip, Z.skin, [0.94, 0.94, 0.94],
    { rings: 1 });
  f.blob([0, 1.645, 0.006], 0.083, 0.098, 0.086, 8, 4, P.body, hip, Z.skin, [1, 1, 1]);
  /* hat: crown + brim. The brim is the strongest silhouette signal a western
     figure has at 40 px, so it gets real width and a droop. */
  f.blob([0, 1.735, 0], 0.088, 0.070, 0.088, 8, 3, P.body, hip, Z.hat, [1, 1, 1]);
  const bf = new Fig();
  bf.brim(0, 0.088, 0.185, 10, P.body, hip, Z.hat, [0.92, 0.92, 0.92]);
  // splice the brim in at head height
  for (let i = 0; i < bf.pos.length; i += 3) bf.pos[i + 1] += 1.702;
  spliceFig(f, bf);
  return f;
}

/**
 * A woman: long skirt to the ankle, a fitted bodice, a shawl over the
 * shoulders, and a bonnet. The skirt replaces the legs entirely, which is both
 * cheaper and a better read — a full skirt hides the legs anyway.
 */
function makeWoman() {
  const f = new Fig();
  const hip = [0, 0.95, 0];
  const shL = [0.175, 1.38, 0], shR = [-0.175, 1.38, 0];

  /* skirt: a wide cone that sways as one piece */
  f.limb([0, 1.02, 0], [0, 0.055, 0.0], 0.145, 0.285, 9, P.skirt, [0, 1.02, 0], Z.trou,
    [1, 1, 1], { rings: 3, shade: 0.26 });
  f.limb([0, 0.07, 0], [0, 0.045, 0], 0.283, 0.276, 9, P.skirt, [0, 1.02, 0], Z.trou,
    [0.72, 0.72, 0.72], { rings: 1 });

  /* bodice */
  f.limb([0, 0.98, 0], [0, 1.40, 0], 0.132, 0.140, 8, P.body, hip, Z.coat, [1, 1, 1],
    { rings: 3, flat: 0.26, shade: 0.12 });
  /* shawl over the shoulders — a second, wider blob so the shoulder line is a
     soft triangle rather than a cylinder */
  f.blob([0, 1.36, 0], 0.212, 0.128, 0.140, 8, 4, P.body, hip, Z.hat, [0.96, 0.96, 0.96]);

  for (const [sh, part] of [[shL, P.armL], [shR, P.armR]]) {
    f.limb([sh[0], sh[1], 0], [sh[0] * 1.02, 0.94, 0.045], 0.058, 0.042, 6, part, sh, Z.coat,
      [0.98, 0.98, 0.98], { rings: 2, shade: 0.10 });
    f.limb([sh[0] * 1.02, 0.95, 0.045], [sh[0] * 1.02, 0.885, 0.06], 0.040, 0.035, 5, part, sh, Z.skin,
      [1, 1, 1], { rings: 1, cap: true });
  }

  f.limb([0, 1.40, 0], [0, 1.50, 0], 0.046, 0.044, 6, P.body, hip, Z.skin, [0.94, 0.94, 0.94],
    { rings: 1 });
  f.blob([0, 1.578, 0.004], 0.077, 0.092, 0.080, 8, 4, P.body, hip, Z.skin, [1, 1, 1]);
  /* bonnet: crown plus a forward-projecting poke, not a cowboy brim */
  f.blob([0, 1.635, -0.012], 0.092, 0.078, 0.094, 8, 3, P.body, hip, Z.hat, [1, 1, 1]);
  f.limb([0, 1.612, 0.02], [0, 1.586, 0.135], 0.088, 0.104, 8, P.body, hip, Z.hat,
    [0.94, 0.94, 0.94], { rings: 1 });
  return f;
}

function spliceFig(dst, src) {
  const off = dst.n;
  for (const v of src.pos) dst.pos.push(v);
  for (const v of src.nor) dst.nor.push(v);
  for (const v of src.uv) dst.uv.push(v);
  for (const v of src.col) dst.col.push(v);
  for (const v of src.zone) dst.zone.push(v);
  for (const v of src.part) dst.part.push(v);
  for (const v of src.piv) dst.piv.push(v);
  for (const v of src.idx) dst.idx.push(v + off);
  dst.n += src.n;
}

/* -------------------------------------------------------------------------- */
/*  the vertex rig                                                             */
/* -------------------------------------------------------------------------- */

const RIG_PARS = /* glsl */`
attribute float aPart;
attribute float aZone;
attribute vec3  aPivot;
attribute vec3  aGait;    // x phase, y strides/sec (0 = idle), z leg bias (sitting)
attribute vec3  aCoat;
attribute vec3  aTrou;
attribute vec3  aHat;
uniform float uFolkTime;

mat3 rsRotX( float a ) {
  float c = cos( a ), s = sin( a );
  return mat3( 1.0, 0.0, 0.0,  0.0, c, s,  0.0, -s, c );
}
mat3 rsRotZ( float a ) {
  float c = cos( a ), s = sin( a );
  return mat3( c, s, 0.0,  -s, c, 0.0,  0.0, 0.0, 1.0 );
}
`;

/* Runs once, before both the normal and the position use it. */
const RIG_SETUP = /* glsl */`
  // aGait.z is the leg bias (a sitting figure), EXCEPT for the sentinel below
  // -8, which means "this one is dead": the idle sway has to stop or a body in
  // the road keeps gently breathing, which is worse than no death animation.
  float rsDead = step( aGait.z, -8.0 );
  float rsLive = 1.0 - rsDead;
  float rsBias = aGait.z * rsLive;
  float rsWalk = step( 0.01, aGait.y );
  float rsRate = mix( 0.42, aGait.y, rsWalk );
  float rsW = uFolkTime * rsRate * 6.2831853 + aGait.x;
  float rsSw = sin( rsW ) * rsLive;
  float rsAmp = mix( 0.055, 0.60, rsWalk );
  mat3 rsRot = mat3( 1.0 );
  float rsA = 0.0;
  if ( aPart == 1.0 )      rsA =  rsSw * rsAmp + rsBias;
  else if ( aPart == 2.0 ) rsA = -rsSw * rsAmp + rsBias;
  else if ( aPart == 3.0 ) rsA = -rsSw * rsAmp * 0.66;
  else if ( aPart == 4.0 ) rsA =  rsSw * rsAmp * 0.66;
  else if ( aPart == 5.0 ) rsA =  rsSw * rsAmp * 0.22;
  if ( aPart > 0.5 ) rsRot = rsRotX( rsA );
  // torso counter-rotation and a little side-to-side weight shift
  if ( aPart < 0.5 ) rsRot = rsRotZ( ( -rsSw * 0.035 * rsWalk + sin( rsW * 0.5 ) * 0.012 ) * rsLive );
  vec3 rsBob = vec3( 0.0, ( abs( rsSw ) - 0.5 ) * 0.030 * rsWalk * rsLive, 0.0 );
`;

/**
 * The rig has to run before BOTH the normal and the position chunks, and the
 * depth shader wraps `<beginnormal_vertex>` in `#ifdef USE_DISPLACEMENTMAP` —
 * so the setup is anchored on `<uv_vertex>`, which is the first line of main()
 * in every three material including MeshDepthMaterial. Anchoring it on
 * `<beginnormal_vertex>` silently produced T-posed shadows.
 */
function injectRig(material) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (typeof prev === 'function') prev.call(this, shader, renderer);
    shader.uniforms.uFolkTime = material.userData.rsFolkTime;
    if (shader.vertexShader.indexOf('rsFolkRig') !== -1) return;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n#define rsFolkRig 1\n' + RIG_PARS)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n' + RIG_SETUP)
      .replace('#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n objectNormal = rsRot * objectNormal;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n'
        + ' transformed = aPivot + rsRot * ( transformed - aPivot ) + rsBob;');
    if (shader.vertexShader.indexOf('#include <color_vertex>') !== -1) {
      shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>',
        '#include <color_vertex>\n'
        + ' {\n'
        + '   vec3 rsZ = aCoat;\n'
        + '   if ( aZone > 2.5 ) rsZ = vec3( 0.185, 0.125, 0.096 ) * ( 0.78 + fract( aGait.x ) * 0.40 );\n'
        + '   else if ( aZone > 1.5 ) rsZ = aHat;\n'
        + '   else if ( aZone > 0.5 ) rsZ = aTrou;\n'
        + '   vColor.rgb *= rsZ;\n'
        + ' }\n');
    }
  };
  const key = material.customProgramCacheKey;
  material.customProgramCacheKey = function () {
    return 'rsFolk|' + (typeof key === 'function' ? key.call(this) : '');
  };
  material.needsUpdate = true;
  return material;
}

/* -------------------------------------------------------------------------- */
/*  the system                                                                 */
/* -------------------------------------------------------------------------- */

export class Folk {
  /**
   * @param {object} o
   *   proc      procTextures
   *   sky       sky system (aerial perspective)
   *   lighting  lighting system
   *   rand      rng(seed)
   *   agents    [{ proto, path:[{x,y,z}], loop, yaw, gait, legBias, tilt, tint… }]
   */
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'folk';
    this.meshes = [];
    this.mats = [];
    this.agents = [];
    this._t = 0;
    this._timeU = { value: 0 };
    this.physics = null;
    this.heightAt = null;
    this.emit = null;
    this.rand = Math.random;
    /** Running tallies another system may read. */
    this.dead = 0;
    this.alarmed = 0;
  }

  build(o) {
    const { proc, sky, lighting, rand, agents } = o;
    this.physics = o.physics || null;
    this.heightAt = o.heightAt || null;
    this.emit = o.emit || null;
    this.rand = rand;

    const tex = proc && proc.get ? proc.get('fabric_wool') : null;
    const protos = [makeMan().toGeometry(), makeWoman().toGeometry()];

    const byProto = [[], []];
    for (const a of agents) byProto[a.proto | 0].push(a);

    for (let pi = 0; pi < protos.length; pi++) {
      const list = byProto[pi];
      if (!list.length) { protos[pi].dispose(); continue; }
      /* NO ALBEDO MAP.
       * `fabric_wool` is a bold woven blanket stripe — correct for a bedroll,
       * catastrophic on a person: the first build put two figures in the near
       * field wearing horizontal bands, i.e. prison uniforms. At the 20-90 px a
       * background townsperson occupies, a cloth texture contributes nothing
       * except a pattern the eye locks onto, so the garment is pure per-instance
       * vertex colour and the only map kept is the normal, at low strength, for
       * a little micro-shading on the shoulders. */
      const mat = new THREE.MeshStandardMaterial({
        normalMap: tex ? tex.normalMap : null,
        roughness: 0.93, metalness: 0.0,
        vertexColors: true, dithering: true,
      });
      if (mat.normalScale) mat.normalScale.set(0.28, 0.28);
      mat.name = 'folk_' + pi;
      mat.userData.rsFolkTime = this._timeU;
      injectRig(mat);
      if (sky && sky.injectAerialPerspective) sky.injectAerialPerspective(mat);
      if (lighting && lighting.registerMaterial) lighting.registerMaterial(mat);
      this.mats.push(mat);

      const geo = protos[pi];
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      mesh.name = 'town_folk' + pi;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;    // one bounding sphere for the whole street
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

      const gait = new Float32Array(list.length * 3);
      const coat = new Float32Array(list.length * 3);
      const trou = new Float32Array(list.length * 3);
      const hat = new Float32Array(list.length * 3);
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        gait[i * 3] = a.phase; gait[i * 3 + 1] = a.gait; gait[i * 3 + 2] = a.legBias || 0;
        coat.set(a.coat, i * 3);
        trou.set(a.trou, i * 3);
        hat.set(a.hat, i * 3);
      }
      const gaitAttr = new THREE.InstancedBufferAttribute(gait, 3);
      geo.setAttribute('aGait', gaitAttr);
      for (const a of list) a.gaitArr = gaitAttr;
      geo.setAttribute('aCoat', new THREE.InstancedBufferAttribute(coat, 3));
      geo.setAttribute('aTrou', new THREE.InstancedBufferAttribute(trou, 3));
      geo.setAttribute('aHat', new THREE.InstancedBufferAttribute(hat, 3));

      /* Shadows need the same rig or every figure casts a T-pose. */
      const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      dm.userData.rsFolkTime = this._timeU;
      dm.userData.rsNoAerial = true;
      injectRig(dm);
      mesh.customDepthMaterial = dm;
      this.mats.push(dm);

      /* The LOD pack reorders instances, so each mesh keeps its own agent list
         and each agent remembers where its data lives. */
      mesh.userData.agents = list;
      for (let i = 0; i < list.length; i++) list[i].slot = i;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.agents.push(...list);
    }

    /* ---- liveness, bodies and the alarm ---------------------------------- */
    const PH = this.physics;
    this._corpseMask = PH && PH.LAYER ? PH.LAYER.CORPSE : 32;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      a.index = i;
      a.p = new THREE.Vector3(a.x || 0, a.y || 0, a.z || 0);
      a.hp = 1;
      a.dead = 0;            // 0 alive · 1 folding · 2 down · 3 gone
      a.deadT = 0;
      a.fall = 0;
      a.fallDir = rand() < 0.5 ? 1 : -1;
      a.react = CALM;
      a.reactT = 0;
      a.alarm = 0;
      a.fleeT = -1e9;
      a.saved = null;
      a.vanish = 1;
      a.sink = 0;
      a.srcX = null; a.srcZ = null;
      this._poseOf(a, a.p);
      if (PH && typeof PH.addCollider === 'function') {
        a.col = PH.addCollider({
          shape: 'capsule',
          kind: 'dynamic',
          position: a.p,                    // live reference
          radius: NPC_RADIUS * a.scale,
          height: NPC_HEIGHT * a.scale,
          mask: PH.LAYER.NPC,
          tag: 'npc',
          owner: a,
        });
      }
    }
    return this;
  }

  /* ------------------------------------------------------------------------ */
  /*  PUBLIC API — what the hit-feedback / wanted system consumes              */
  /* ------------------------------------------------------------------------ */

  /**
   * Hitscan the population. Mirrors `Wildlife.raycastAnimals` deliberately, so
   * a caller that already resolves a shot against animals can drop this in
   * beside it with the same shape of result.
   *
   * @returns {{agent, index, part:string, point:THREE.Vector3,
   *            distance:number}|null}
   */
  raycastNPC(origin, dir, maxDist = 400) {
    let best = null;
    for (const a of this.agents) {
      if (a.dead) continue;                      // a body on the ground is not a target
      const dx = a.p.x - origin.x, dy = a.p.y + 0.9 - origin.y, dz = a.p.z - origin.z;
      const along = dx * dir.x + dy * dir.y + dz * dir.z;
      if (along < 0 || along > maxDist + 2) continue;
      const perp2 = (dx * dx + dy * dy + dz * dz) - along * along;
      if (perp2 > 2.25) continue;                // 1.5 m cylinder reject
      for (let i = 0; i < NPC_HITBOX.length; i++) {
        const b = NPC_HITBOX[i];
        const r = b[1] * a.scale;
        const ox = a.p.x - origin.x;
        const oy = a.p.y + b[0] * a.scale - origin.y;
        const oz = a.p.z - origin.z;
        const t = ox * dir.x + oy * dir.y + oz * dir.z;
        if (t < 0 || t > maxDist) continue;
        const p2 = (ox * ox + oy * oy + oz * oz) - t * t;
        if (p2 > r * r) continue;
        const hit = t - Math.sqrt(Math.max(0, r * r - p2));
        if (best && hit >= best.distance) continue;
        best = {
          agent: a, index: a.index, part: b[2], distance: hit,
          point: new THREE.Vector3(origin.x + dir.x * hit,
            origin.y + dir.y * hit, origin.z + dir.z * hit),
        };
      }
    }
    return best;
  }

  /**
   * Land a shot on a townsperson. `hit` is whatever `raycastNPC` returned, or
   * `{ agent }` / `{ index }` if you resolved the target some other way.
   *
   * @returns {{killed:boolean, part:string, agent, position:THREE.Vector3,
   *            witnessed:boolean, witnesses:number}|null}
   */
  applyNPCHit(hit, damage = 1) {
    if (!hit) return null;
    const a = hit.agent || this.agents[hit.index];
    if (!a || a.dead) return null;
    const part = hit.part || 'body';
    const mult = NPC_PART_DMG[part] != null ? NPC_PART_DMG[part] : 0.85;
    a.hp -= damage * mult;
    // Being shot at and missed is still a reason to run.
    this.alarm(hit.point || a.p, 30, 1.4);
    if (part === 'head' || a.hp <= 0) {
      const info = this._kill(a, hit.point || a.p);
      return { killed: true, part, agent: a, ...info };
    }
    this._panic(a, hit.point || a.p);
    return {
      killed: false, part, agent: a,
      position: a.p.clone(), witnessed: false, witnesses: 0,
    };
  }

  /**
   * Kill outright — for a caller with its own damage model.
   * @returns {{position, witnessed, witnesses}|null}
   */
  killNPC(agentOrIndex, from) {
    const a = typeof agentOrIndex === 'number' ? this.agents[agentOrIndex] : agentOrIndex;
    if (!a || a.dead) return null;
    return this._kill(a, from || a.p);
  }

  /** Everyone still standing, for a wanted system that wants to count witnesses. */
  livingCount() {
    let n = 0;
    for (const a of this.agents) if (!a.dead) n++;
    return n;
  }

  /**
   * Is there a boardwalk deck under this figure?
   *
   * The walk edges Town registers with `physics.addBlocker` ARE the deck
   * outline, and their y window is the deck's own height band — so the blocker
   * list answers this question exactly, for nothing, and without Folk needing
   * to know anything about how the town was laid out. Called once, at the
   * moment of death.
   */
  _onDeck(a) {
    const PH = this.physics;
    if (!PH || !PH.blockers) return false;
    for (let i = 0; i < PH.blockers.length; i++) {
      const g = PH.blockers[i];
      if (a.p.y <= g.yMin || a.p.y >= g.yMax) continue;
      let u = ((a.p.x - g.ax) * g.dx + (a.p.z - g.az) * g.dz) * g.invLen2;
      if (u < 0) u = 0; else if (u > 1) u = 1;
      const qx = a.p.x - (g.ax + g.dx * u), qz = a.p.z - (g.az + g.dz * u);
      if (qx * qx + qz * qz < 6.25) return true;      // within 2.5 m of the edge
    }
    return false;
  }

  _kill(a, from) {
    a.dead = 1;
    a.deadT = 0;
    a.hp = 0;
    a.react = CALM;
    a.gait = 0;
    this.dead++;
    /* Settle the body onto whatever is actually holding it up.
     *
     * A walking figure's Y comes from its BAKED PATH, not from the height
     * query — the boardwalk decks are not in the heightfield (see
     * Physics.addBlocker) and the graded pad does not agree with the raw
     * terrain off its edge either. Alive that is invisible, because the feet
     * are where the path says. Dead it is not: the body goes horizontal and
     * hangs half a metre over open dirt with its shadow underneath it, which
     * is exactly what was measured here (0.544 m clear of the ground). So a
     * dying man falls the rest of the way — unless there really are planks
     * under him, in which case he lies on them. */
    a.restY = a.p.y;
    if (!this._onDeck(a) && this.heightAt) {
      let gy = a.p.y;
      try { gy = this.heightAt(a.p.x, a.p.z); } catch (e) { gy = a.p.y; }
      // never more than a step's worth: this is a settle, not a fall down a cliff
      a.restY = Math.min(a.p.y, Math.max(gy, a.p.y - 1.2));
    }
    a.fallY0 = a.p.y;
    /* Who saw it. Distance plus a coarse facing test — a man with his back
     * turned forty metres up the street did not see you do it, and the wanted
     * system is entitled to know the difference. */
    let witnesses = 0;
    for (const b of this.agents) {
      if (b === a || b.dead) continue;
      const dx = a.p.x - b.p.x, dz = a.p.z - b.p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > WITNESS_RADIUS * WITNESS_RADIUS) continue;
      const d = Math.sqrt(d2) || 1e-4;
      // the figure's forward is +z rotated by yaw
      const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
      if ((dx / d) * fx + (dz / d) * fz < -0.15 && d > 8) continue;   // behind them
      witnesses++;
    }
    // A killing empties a street far more thoroughly than the report alone.
    this.alarm(from || a.p, 70, 1.6);
    const info = {
      position: a.p.clone(),
      witnessed: witnesses > 0,
      witnesses,
    };
    if (this.emit) {
      this.emit('npcKilled', {
        agent: a, index: a.index,
        position: info.position,
        witnessed: info.witnessed,
        witnesses,
      });
    }
    return info;
  }

  /* ---------------------------------------------------------------- alarm */

  /**
   * Something loud happened at `pos`. Nearby folk flinch and look; anyone
   * close enough runs. Deliberately the same signature as `Wildlife.alarm`.
   */
  alarm(pos, radius = 55, intensity = 1) {
    const r2 = radius * radius;
    const rnd = this.rand;
    for (const a of this.agents) {
      if (a.dead) continue;
      const dx = a.p.x - pos.x, dz = a.p.z - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const k = 1 - Math.sqrt(d2) / radius;
      a.alarm = Math.min(1.6, a.alarm + intensity * (0.30 + k * 1.15));
      a.srcX = pos.x; a.srcZ = pos.z;
      if (a.react === CALM) {
        a.react = FLINCH;
        a.reactT = 0.30 + rnd() * 0.55;          // the beat before anyone moves
      }
      if (a.alarm > 0.95 && a.react !== FLEE) {
        // the ones nearest it do not wait out the flinch
        if (a.alarm > 1.25) { a.reactT = Math.min(a.reactT, 0.12); }
      }
    }
  }

  /** Send one agent immediately, whatever its alarm level. */
  _panic(a, from) {
    a.alarm = Math.max(a.alarm, 1.4);
    a.srcX = from.x; a.srcZ = from.z;
    a.react = FLINCH;
    a.reactT = Math.min(a.reactT || 1, 0.12);
  }

  /**
   * Swap an agent's baked patrol for a straight run away from `(sx, sz)`, and
   * remember enough to put it back. Standers and walkers take the same path
   * here — a man leaning on a rail and a man walking the boardwalk both do the
   * same thing when a rifle goes off, which is leave.
   */
  _flee(a, sx, sz) {
    const rnd = this.rand;
    let dx = a.p.x - sx, dz = a.p.z - sz;
    const l = Math.hypot(dx, dz);
    if (l < 0.2) { const t = rnd() * TAU; dx = Math.cos(t); dz = Math.sin(t); }
    else { dx /= l; dz /= l; }
    // a little scatter, so a group does not leave as one rigid body
    const j = (rnd() - 0.5) * 0.9;
    const cj = Math.cos(j), sj = Math.sin(j);
    const ux = dx * cj - dz * sj, uz = dx * sj + dz * cj;

    if (!a.saved) {
      a.saved = {
        path: a.path, duration: a.duration, dwell: a.dwell, tOffset: a.tOffset,
        speedScale: a.speedScale, walkRate: a.walkRate, legBias: a.legBias,
      };
    }
    const D = RUN_DIST * (0.75 + rnd() * 0.6);
    const H = this.heightAt;
    const pts = [];
    for (let i = 0; i <= 3; i++) {
      const t = i / 3;
      const x = a.p.x + ux * D * t, z = a.p.z + uz * D * t;
      let y = a.p.y;
      if (i > 0 && H) {
        let g = a.p.y;
        try { g = H(x, z); } catch (e) { g = a.p.y; }
        // ease off whatever they were standing on rather than dropping a
        // boardwalk's worth of height on the first segment
        y = i === 1 ? a.p.y + (g - a.p.y) * 0.55 : g;
      }
      pts.push([x, y, z]);
    }
    a.path = pts;
    a.duration = D / RUN_SPEED;
    a.dwell = 5 + rnd() * 5;
    a.speedScale = 1;
    a.walkRate = RUN_STRIDE * (0.92 + rnd() * 0.16);
    a.legBias = 0;
    a.tOffset = -this._t;              // start of the escape, this instant
    a.react = FLEE;
    a.fleeT = this._t;
    this._writeGait(a);
  }

  /** Re-phase the original patrol so the figure resumes where it is standing. */
  _restore(a) {
    const s = a.saved;
    if (!s) { a.react = CALM; return; }
    a.path = s.path; a.duration = s.duration; a.dwell = s.dwell;
    a.speedScale = s.speedScale; a.walkRate = s.walkRate; a.legBias = s.legBias;
    a.saved = null;
    a.react = CALM;
    if (!a.path) {
      /* A standing figure has no patrol to re-phase, and putting its anchor
         back where it started would TELEPORT it across the street. It stopped
         running here; this is where it stands now. */
      a.x = a.p.x; a.y = a.p.y; a.z = a.p.z;
      a.tOffset = s.tOffset;
      this._writeGait(a);
      return;
    }
    /* Sixteen samples of the cycle, keep the offset that puts the figure
       nearest where it actually is. Restoring the ORIGINAL offset teleports a
       walker back to wherever the global clock says it should be, which is a
       visible pop of up to half the street. */
    const cyc = a.duration * 2 + a.dwell * 2;
    let bo = s.tOffset, bd = 1e18;
    for (let i = 0; i < 16; i++) {
      a.tOffset = (i / 16) * cyc - this._t * a.speedScale;
      this._poseOf(a, _v);
      const dx = _v.x - a.p.x, dz = _v.z - a.p.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bo = a.tOffset; }
    }
    a.tOffset = bo;
    this._writeGait(a);
  }

  /**
   * Walk the paths and write the instance matrices.
   * @param {number} dt  seconds
   * @param {THREE.Vector3} camPos
   */
  update(dt, camPos) {
    this._t += dt;
    this._timeU.value = this._t;
    this._think(dt);
    const m = _m4, q = _q, sc = _sc;
    for (const mesh of this.meshes) {
      const list = mesh.userData.agents;
      /* Instance ATTRIBUTES are indexed by instance id, so the slots cannot be
         packed — compacting the matrices would hand agent 7's coat to agent 3.
         Far figures get a zero scale instead (a degenerate triangle costs the
         rasteriser nothing), and if the whole population is out of range the
         mesh drops to count 0, which is what keeps the other nine shots from
         paying anything at all for the town's people. */
      let any = false;
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        const v = a.p;
        // a dead or flinching figure is not on its patrol any more
        if (!a.dead && a.react !== FLINCH) this._poseOf(a, v);
        let s = a.scale * (a.vanish != null ? a.vanish : 1);
        if (camPos) {
          const dx = v.x - camPos.x, dz = v.z - camPos.z, dy = v.y - camPos.y;
          if (dx * dx + dy * dy + dz * dz > FAR * FAR) s = 0; else any = true;
        } else any = true;
        sc.setScalar(s);
        /* `fall` lays a body down. The rotation is about the instance origin,
           which is at the FEET, so tipping past 80 degrees already swings the
           torso onto the ground on its own — all it needs on top is a small
           lift for the thickness of the body it is now lying on. */
        q.setFromEuler(_e.set((a.tilt || 0) + a.fall * 1.52 * a.fallDir,
          a.yaw, a.roll || 0, 'YXZ'));
        _p.set(v.x, v.y + a.fall * 0.17 * a.scale - (a.sink || 0), v.z);
        m.compose(_p, q, sc);
        mesh.setMatrixAt(i, m);
      }
      mesh.count = any ? list.length : 0;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * The whole of NPC behaviour: dying, lying there, being taken away, and the
   * three-state reaction to a gunshot. Twenty-four agents of scalar arithmetic
   * — it does not show up in a profile and it is not allowed to.
   */
  _think(dt) {
    let alarmed = 0;
    for (const a of this.agents) {
      /* ---- dying ------------------------------------------------------- */
      if (a.dead) {
        if (a.dead === 3) continue;
        a.deadT += dt;
        if (a.dead === 1) {
          a.fall = Math.min(1, a.fall + dt * 2.4);
          // drop onto the ground on the same curve the body folds on
          if (a.restY != null && a.restY !== a.fallY0) {
            a.p.y = a.fallY0 + (a.restY - a.fallY0) * a.fall;
          }
          if (a.gait !== 0) { a.gait = 0; }
          this._writeGait(a);
          if (a.fall >= 1) { a.dead = 2; a.p.y = a.restY != null ? a.restY : a.p.y; }
        } else {
          // lie there, then be taken away — a fade, not a pop
          const over = a.deadT - CORPSE_TTL;
          if (over > 0) {
            /* Sink it, do not shrink it. A body scaling down in the middle of
               the street reads as a bug; a body settling into the dirt over
               four seconds reads as the undertaker having been. */
            const k = Math.min(1, over / CORPSE_FADE);
            a.sink = k * 0.55;
            a.vanish = k > 0.98 ? 0 : 1;
            if (a.vanish <= 0) {
              a.dead = 3;
              if (a.col) a.col.enabled = false;
            }
          }
        }
        if (a.col && a.dead < 3) {
          // the standing capsule becomes something you step over
          const want = 1 - a.fall * 0.78;
          a.col.height = NPC_HEIGHT * a.scale * want;
          a.col.radius = NPC_RADIUS * a.scale * (1 + a.fall * 1.5);
          if (a.col.mask !== this._corpseMask && a.fall >= 1) {
            a.col.mask = this._corpseMask;
          }
        }
        continue;
      }

      /* ---- calming down ------------------------------------------------ */
      if (a.alarm > 0) {
        a.alarm = Math.max(0, a.alarm - dt * 0.085);
        alarmed++;
      }

      /* ---- flinch: stop dead and look at it ---------------------------- */
      if (a.react === FLINCH) {
        a.reactT -= dt;
        if (a.gait !== 0) { a.gait = 0; this._writeGait(a); }
        if (a.srcX != null) {
          const dx = a.srcX - a.p.x, dz = a.srcZ - a.p.z;
          if (dx * dx + dz * dz > 1e-4) {
            const want = Math.atan2(dx, dz);
            a.yaw += angleDelta(a.yaw, want) * Math.min(1, dt * 7);
          }
        }
        if (a.reactT <= 0) {
          if (a.alarm > 0.55) this._flee(a, a.srcX, a.srcZ);
          else { a.react = CALM; this._writeGait(a); }
        }
        continue;
      }

      /* ---- fleeing: the escape path is walked by _poseOf --------------- */
      if (a.react === FLEE) {
        if (a.alarm <= 0.02 && this._t - a.fleeT > 16) this._restore(a);
        continue;
      }
    }
    this.alarmed = alarmed;
  }

  /** Push an agent's stride rate (and its dead flag) at the instance buffer. */
  _writeGait(a) {
    const list = a.gaitArr;
    if (!list) return;
    const s = a.slot * 3;
    const bias = a.dead ? -9 : (a.legBias || 0);
    if (list.array[s + 1] !== a.gait || list.array[s + 2] !== bias) {
      list.array[s + 1] = a.gait;
      list.array[s + 2] = bias;
      list.needsUpdate = true;
    }
  }

  /** Position + facing of an agent at the current time, written into `out`. */
  _poseOf(a, out) {
    const path = a.path;
    if (!path || path.length < 2) {
      out.set(a.x, a.y, a.z);
      return;
    }
    /* Ping-pong along the baked path with a dwell at each end, so a walker
       turns around and comes back instead of teleporting. */
    const span = a.duration;
    const cyc = span * 2 + a.dwell * 2;
    let u = (this._t * a.speedScale + a.tOffset) % cyc;
    if (u < 0) u += cyc;
    let f, dir;
    if (u < span) { f = u / span; dir = 1; }
    else if (u < span + a.dwell) { f = 1; dir = 1; }
    else if (u < span * 2 + a.dwell) { f = 1 - (u - span - a.dwell) / span; dir = -1; }
    else { f = 0; dir = -1; }
    const seg = (path.length - 1) * f;
    let i = Math.floor(seg);
    if (i > path.length - 2) i = path.length - 2;
    const k = seg - i;
    const p0 = path[i], p1 = path[i + 1];
    out.set(p0[0] + (p1[0] - p0[0]) * k,
      p0[1] + (p1[1] - p0[1]) * k,
      p0[2] + (p1[2] - p0[2]) * k);
    const dx = (p1[0] - p0[0]) * dir, dz = (p1[2] - p0[2]) * dir;
    a.yaw = Math.atan2(dx, dz);
    /* Stand still through the dwell rather than moon-walking on the spot. */
    a.gait = (u < span || (u > span + a.dwell && u < span * 2 + a.dwell)) ? a.walkRate : 0;
    const list = a.gaitArr;
    if (list) {
      const s = a.slot * 3 + 1;
      if (list.array[s] !== a.gait) { list.array[s] = a.gait; list.needsUpdate = true; }
    }
  }

  dispose(scene) {
    if (this.physics && this.physics.removeCollider) {
      for (const a of this.agents) if (a.col) { this.physics.removeCollider(a.col); a.col = null; }
    }
    for (const m of this.meshes) { m.geometry.dispose(); }
    for (const m of this.mats) m.dispose();
    if (scene) scene.remove(this.group);
  }
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _sc = new THREE.Vector3(1, 1, 1);

function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}

/* -------------------------------------------------------------------------- */
/*  wardrobe                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Period palette, authored as LINEAR multipliers on the wool albedo. Frontier
 * clothing is undyed wool, indigo, walnut/oak brown, oxide red and black; the
 * one bright thing anyone owns is a neckerchief. Nothing here is saturated,
 * because the whole point of the art direction is that the town is dusty.
 */
/* These ARE the final linear albedos — there is no texture multiplying them
 * down any more (see the material note in build()). Dyed wool and cotton in
 * 1899 sits at 0.05-0.30 linear; the two pale entries are an undyed duster and
 * a shirtsleeved man, which is as bright as the street should get. Authored
 * high once and the result was a row of cream mannequins. */
const COATS = [
  [0.055, 0.050, 0.046], [0.090, 0.074, 0.056], [0.048, 0.054, 0.070],
  [0.120, 0.098, 0.072], [0.036, 0.036, 0.042], [0.100, 0.072, 0.055],
  [0.155, 0.138, 0.110], [0.068, 0.078, 0.068], [0.180, 0.163, 0.134],
  [0.078, 0.062, 0.052], [0.130, 0.110, 0.083], [0.110, 0.094, 0.082],
];
const TROUS = [
  [0.058, 0.064, 0.080], [0.078, 0.066, 0.048], [0.040, 0.040, 0.045],
  [0.105, 0.088, 0.066], [0.052, 0.062, 0.074], [0.088, 0.072, 0.056],
  [0.135, 0.118, 0.092],
];
const HATS = [
  [0.045, 0.038, 0.029], [0.032, 0.028, 0.024], [0.086, 0.070, 0.050],
  [0.125, 0.104, 0.074], [0.026, 0.024, 0.021], [0.066, 0.054, 0.040],
  [0.145, 0.124, 0.090],
];
/** Dresses run lighter and carry the one or two pale notes in the street. */
const DRESS = [
  [0.100, 0.090, 0.080], [0.052, 0.056, 0.070], [0.150, 0.128, 0.102],
  [0.066, 0.048, 0.052], [0.086, 0.080, 0.066], [0.200, 0.178, 0.146],
  [0.075, 0.085, 0.075], [0.235, 0.212, 0.178],
];

export function wardrobe(rand, woman) {
  const pick = (arr) => arr[(rand() * arr.length) | 0];
  const jit = (c) => [
    c[0] * (0.86 + rand() * 0.28), c[1] * (0.86 + rand() * 0.28), c[2] * (0.86 + rand() * 0.28),
  ];
  if (woman) {
    return { coat: jit(pick(DRESS)), trou: jit(pick(DRESS)), hat: jit(pick(DRESS)) };
  }
  return { coat: jit(pick(COATS)), trou: jit(pick(TROUS)), hat: jit(pick(HATS)) };
}
