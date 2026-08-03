import * as THREE from 'three';
import { rng } from '../../core/Context.js';
import { LEAF_TILES } from './VegTextures.js';

/**
 * Procedural tree meshes.
 *
 * ARCHITECTURE (changed in pass 3)
 * --------------------------------
 * A tree is grown ONCE into a species-agnostic *description* — a list of limbs
 * (swept polylines) and a list of foliage cards, each tagged with a stable
 * `rank` in [0,1). Both LODs are then emitted from that same description:
 *
 *   LOD0   every limb at full radial resolution, every card at its own size
 *   LOD1   limbs of rank <= 1 at reduced radial resolution, cards whose rank
 *          falls under LOD1_KEEP, scaled by 1/sqrt(LOD1_KEEP) so the canopy
 *          keeps its mass and its outline
 *
 * That is not a tidiness exercise. Pass 2 called `buildTree(sp, seed, lod)` and
 * let the LOD argument change how many times the RNG was drawn, so LOD0 and
 * LOD1 were *different trees*. The only way to hide the swap was a screen-space
 * dither cross-fade, which the forensic pass caught as "interleaved horizontal
 * stripes of two LODs plus chromatic fringing — a rainbow smear". With a shared
 * skeleton the trunk silhouette is identical across the swap and the canopy
 * outline barely moves, so the dither can be deleted outright.
 *
 * CANOPY CONSTRUCTION
 * -------------------
 * Foliage is never an individual leaf quad. Each card is a leafy twig tip from
 * the atlas carrying twenty to a hundred leaves, and cards are clustered into a
 * canopy *volume*: radial density falls as pow(u, 0.55) from the branch axis,
 * a handful of oversized low-albedo cards fill the interior so you cannot see
 * sky through the middle of a crown, and a scatter of undersized outliers past
 * the nominal radius keeps the silhouette ragged instead of a lollipop.
 *
 * Every card carries:
 *   `color`   baked AO x a per-card hue/value jitter (so no two cards in a
 *             canopy are the same colour — the fix for "one repeated mesh")
 *   `aWind`   (height fraction, per-limb phase, flex) driving trunk sway,
 *             branch secondary motion and card-level flutter
 * and ONE outward normal bent toward the canopy shell, so the crown shades as a
 * soft mass. Cards are emitted with a single winding and drawn `DoubleSide`;
 * pass 2 emitted both windings into the index buffer, which doubled the foliage
 * triangle count for pixel-identical output.
 */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Fraction of cards LOD1 keeps. Card scale compensation is 1/sqrt of this. */
const LOD1_KEEP = 0.56;
const LOD1_SCALE = 1 / Math.sqrt(LOD1_KEEP);

function tileUV(i) {
  const col = i % 4, row = (i / 4) | 0;
  const e = 0.0055;
  return {
    u0: col / 4 + e, u1: (col + 1) / 4 - e,
    v0: 1 - (row + 1) / 4 + e, v1: 1 - row / 4 - e,
  };
}

class Builder {
  constructor() {
    this.pos = []; this.nrm = []; this.uv = []; this.col = []; this.win = []; this.idx = [];
  }

  get count() { return this.pos.length / 3; }

  /**
   * Sweep a tube along a polyline.
   * @param {Array<{p:THREE.Vector3, r:number}>} pts
   */
  tube(pts, sides, uScale, vScale, phase, heightRef, flexBase) {
    const n = pts.length;
    if (n < 2) return;
    const base = this.count;
    // parallel-transported frame
    let up = new THREE.Vector3(0, 0, 1);
    const tangents = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)].p, b = pts[Math.min(n - 1, i + 1)].p;
      tangents.push(_a.copy(b).sub(a).normalize().clone());
    }
    if (Math.abs(tangents[0].dot(up)) > 0.94) up = new THREE.Vector3(1, 0, 0);
    let nrmRef = _b.copy(up).sub(_c.copy(tangents[0]).multiplyScalar(up.dot(tangents[0]))).normalize().clone();

    let vAcc = 0;
    for (let i = 0; i < n; i++) {
      const t = tangents[i];
      nrmRef = nrmRef.sub(_c.copy(t).multiplyScalar(nrmRef.dot(t))).normalize();
      const bi = _c.crossVectors(t, nrmRef).normalize().clone();
      if (i > 0) vAcc += pts[i].p.distanceTo(pts[i - 1].p);
      const hf = THREE.MathUtils.clamp(pts[i].p.y / heightRef, 0, 1);
      const flex = THREE.MathUtils.clamp(flexBase + (i / (n - 1)) * (1 - flexBase) * 0.55, 0, 1);
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const nx = nrmRef.x * ca + bi.x * sa;
        const ny = nrmRef.y * ca + bi.y * sa;
        const nz = nrmRef.z * ca + bi.z * sa;
        this.pos.push(pts[i].p.x + nx * pts[i].r,
          pts[i].p.y + ny * pts[i].r,
          pts[i].p.z + nz * pts[i].r);
        this.nrm.push(nx, ny, nz);
        this.uv.push((s / sides) * uScale, vAcc * vScale);
        /* Baked occlusion: dark in the crotch and at the base where the canopy
           and the ground shut the sky out, opening up toward the crown. Also
           darkens the underside of every limb so a trunk is not one flat tone
           from root to tip. */
        let ao = 0.30 + 0.70 * Math.min(1, hf * 1.55 + 0.14);
        ao *= 0.74 + 0.26 * (ny * 0.5 + 0.5);
        this.col.push(ao, ao, ao);
        this.win.push(hf, phase, flex);
      }
    }
    const ring = sides + 1;
    for (let i = 0; i < n - 1; i++) {
      for (let s = 0; s < sides; s++) {
        const a = base + i * ring + s;
        const b = a + 1;
        const c = a + ring;
        const d = c + 1;
        this.idx.push(a, c, b, b, c, d);
      }
    }
  }

  /**
   * A foliage card: one leafy twig tip from the atlas.
   *
   * ONE winding — the material is DoubleSide and the fragment shader pins the
   * normal so both faces shade identically, which is what makes a canopy read
   * as a soft volume rather than a pile of flat cut-outs.
   */
  card(c, heightRef) {
    const n = _a.copy(c.out).normalize();
    // The card's +v axis follows the growth direction, so the painted spray
    // radiates outward from the branch instead of pointing in a random
    // direction — the single biggest thing separating "foliage" from "confetti".
    const ey0 = _b.copy(c.along);
    ey0.addScaledVector(n, -ey0.dot(n));
    if (ey0.lengthSq() < 1e-6) ey0.set(0, 1, 0).addScaledVector(n, -n.y);
    if (ey0.lengthSq() < 1e-6) ey0.set(1, 0, 0);
    ey0.normalize();
    const ex0 = _c.crossVectors(n, ey0).normalize();
    const w = c.w * (c.mul || 1), h = c.h * (c.mul || 1);
    const ex = ex0.clone().multiplyScalar(w * 0.5);
    const ey = ey0.clone().multiplyScalar(h * 0.5);
    const uv = tileUV(c.tile);
    // Mirror half the cards in u. Free variety: the same six atlas tiles stop
    // reading as six repeated shapes once half of them are handed the other way.
    const uA = c.flip ? uv.u1 : uv.u0;
    const uB = c.flip ? uv.u0 : uv.u1;
    // grow the card away from its attachment point rather than straddling it
    const ox = c.x + ey0.x * h * 0.40;
    const oy = c.y + ey0.y * h * 0.40;
    const oz = c.z + ey0.z * h * 0.40;
    const base = this.count;
    const corners = [
      [-1, -1, uA, uv.v0], [1, -1, uB, uv.v0],
      [1, 1, uB, uv.v1], [-1, 1, uA, uv.v1],
    ];
    const ao = c.ao;
    const t0 = c.tint;
    for (const [sx, sy, u, v] of corners) {
      const px = ox + ex.x * sx + ey.x * sy;
      const py = oy + ex.y * sx + ey.y * sy;
      const pz = oz + ex.z * sx + ey.z * sy;
      this.pos.push(px, py, pz);
      this.nrm.push(n.x, n.y, n.z);
      this.uv.push(u, v);
      /* Per-card hue jitter folded into the baked AO. Free variation: a canopy
         where every card is the same colour is the tell that says "one mesh,
         instanced". The tip of a card is also paler than its root — new growth
         is yellower and catches more light. */
      const tipK = sy > 0 ? 1.14 : 0.88;
      this.col.push(ao * t0[0] * tipK, ao * t0[1] * tipK, ao * t0[2] * tipK);
      this.win.push(THREE.MathUtils.clamp(py / heightRef, 0, 1), c.phase, c.flex);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.win, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/* ------------------------------------------------------------------ limbs */

/** Sweep a limb from `origin` along `dir`, curving toward `bias` as it goes. */
function limbPoints(origin, dir, length, r0, r1, segs, bias, wobble, r) {
  const pts = [];
  const p = origin.clone();
  const d = dir.clone().normalize();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push({ p: p.clone(), r: r0 + (r1 - r0) * t });
    if (i === segs) break;
    const step = length / segs;
    d.addScaledVector(bias, step * 0.5);
    d.x += (r() - 0.5) * wobble * step;
    d.z += (r() - 0.5) * wobble * step;
    d.normalize();
    p.addScaledVector(d, step);
  }
  return pts;
}

/**
 * Buttress the base of a trunk and sink it below the surface, so a trunk widens
 * into the ground instead of terminating in a flat disc floating on it.
 */
function rootFlare(pts, r) {
  const p0 = pts[0].p;
  const r0 = pts[0].r;
  pts.unshift({ p: new THREE.Vector3(p0.x, p0.y - 0.45, p0.z), r: r0 * (2.05 + r() * 0.5) });
  pts.splice(1, 0, { p: new THREE.Vector3(p0.x, p0.y + 0.02, p0.z), r: r0 * (1.42 + r() * 0.3) });
  if (pts[2]) pts[2].r *= 1.12;
  return pts;
}

/* -------------------------------------------------------------- card tint */

/**
 * A small multiplicative hue/value jitter per card. Kept tight — the atlas
 * already carries the palette, this only has to break the uniformity.
 */
function cardTint(r) {
  const v = 0.84 + r() * 0.34;
  const warm = 0.94 + r() * 0.14;
  return [v * warm, v * (0.98 + r() * 0.06), v * (0.84 + r() * 0.20) / warm];
}

/* ---------------------------------------------------------------- species */

export const SPECIES = ['pine', 'cottonwood', 'scrubOak', 'snag'];

/**
 * `tint` is a MULTIPLIER on the bark albedo, centred near 1. The procedural
 * bark maps are already dark brown; multiplying them by an absolute mid-tone
 * turns a close-up trunk into a black slab.
 */
export const SPECIES_INFO = {
  pine: { bark: 'bark_pine', tint: [1.08, 0.86, 0.66], barkRough: 0.94 },
  cottonwood: { bark: 'bark_oak', tint: [1.02, 0.98, 0.90], barkRough: 0.92 },
  scrubOak: { bark: 'bark_oak', tint: [0.94, 0.86, 0.74], barkRough: 0.93 },
  snag: { bark: 'bark_birch', tint: [0.86, 0.86, 0.82], barkRough: 0.88 },
};

/* ------------------------------------------------------------ descriptions */

/**
 * Ponderosa. Self-pruned lower trunk, whorled branches on a golden-angle
 * phyllotaxis (never the same radial pattern twice), needle sprays clustered on
 * the outer half of each branch. Three growth forms so a stand does not read as
 * one asset: a narrow spire, a broad open crown, and a wind-flagged asymmetric.
 */
function growPine(seed) {
  const r = rng(seed);
  const limbs = [], cards = [];
  const form = (r() * 3) | 0;                       // 0 spire, 1 broad, 2 flagged
  const H = (form === 0 ? 20 + r() * 9 : form === 1 ? 15 + r() * 7 : 17 + r() * 8);
  const flagDir = r() * 6.2831;
  const flagAmt = form === 2 ? 0.55 + r() * 0.5 : 0.0;

  const lean = new THREE.Vector3((r() - 0.5) * 0.05, 0, (r() - 0.5) * 0.05);
  const trunk = limbPoints(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0),
    H, H * 0.023, H * 0.0035, 11, lean, 0.014, r);
  // the flare prepends points, so keep the un-flared spine for branch placement
  const spine = trunk.slice();
  rootFlare(trunk, r);
  limbs.push({ pts: trunk, sides0: 8, sides1: 5, uScale: 3.6, vScale: 0.95, phase: r(), flex: 0.0, rank: 0 });

  const trunkAt = (t) => {
    const f = t * (spine.length - 1);
    const i = Math.min(spine.length - 2, f | 0);
    const k = f - i;
    return spine[i].p.clone().lerp(spine[i + 1].p, k);
  };

  const whorls = 11 + ((r() * 5) | 0);
  const start = form === 0 ? 0.40 + r() * 0.12 : 0.26 + r() * 0.10;
  const spreadK = form === 0 ? 0.72 : form === 1 ? 1.22 : 1.0;
  const GOLDEN = 2.399963;
  let ang = r() * 6.2831;

  for (let w = 0; w < whorls; w++) {
    const t = start + (1 - start) * (w / whorls);
    const origin = trunkAt(t);
    const nb = 3 + ((r() * 3) | 0);
    const shrink = Math.pow(1 - (t - start) / (1 - start), 0.62);
    const len = H * (0.09 + 0.25 * shrink) * spreadK;
    for (let b = 0; b < nb; b++) {
      ang += GOLDEN + (r() - 0.5) * 0.45;
      const a = ang;
      // wind flagging: branches on the lee side reach further
      const flag = 1 + flagAmt * Math.cos(a - flagDir);
      const drop = -0.08 - 0.34 * (1 - t) + r() * 0.20;
      const dir = new THREE.Vector3(Math.cos(a), drop, Math.sin(a)).normalize();
      const ph = r();
      const bl = len * (0.72 + r() * 0.55) * flag;
      const pts = limbPoints(origin, dir, bl, H * 0.0062 * shrink + 0.013, H * 0.0018,
        3, new THREE.Vector3(0, -0.18, 0), 0.05, r);
      limbs.push({
        pts, sides0: 5, sides1: 3, uScale: 1.6, vScale: 1.35, phase: ph,
        flex: 0.30 + 0.45 * t, rank: bl > len * 0.85 ? 1 : 2,
      });

      /* Needle plates. Fewer and considerably larger than pass 2 — a whorl
         should build one continuous plate of foliage, not twelve resolvable
         confetti quads. Radial placement uses pow(u,0.55) so the plate is dense
         at the branch and ragged at the tip. */
      const nCards = 11 + ((r() * 6) | 0);
      const bDir = pts[pts.length - 1].p.clone().sub(pts[0].p).normalize();
      for (let k = 0; k < nCards; k++) {
        const u = (k + r()) / nCards;
        const f = 0.24 + 0.76 * Math.pow(u, 0.55);
        const pi = Math.min(pts.length - 1, Math.round(f * (pts.length - 1)));
        const p = pts[pi].p;
        const roll = r() * 6.2831;
        const jr = bl * 0.13 * (0.35 + r());
        const jx = Math.cos(roll) * jr;
        const jz = Math.sin(roll) * jr;
        const jy = (r() - 0.5) * bl * 0.16;
        const edge = r() < 0.14 ? 1.22 : 1.0;    // outliers keep the outline ragged
        /* Card size is set by what a ponderosa needle plate actually is —
           roughly half a metre of fascicles, not the metre-and-three-quarter
           frond the first attempt produced, which read as a tree fern. */
        const sz = Math.min(1.30, Math.max(0.40, bl * 0.235)) * (0.74 + r() * 0.56)
          * (edge > 1 ? 0.74 : 1);
        const px = p.x + jx * edge, py = p.y + jy, pz = p.z + jz * edge;
        const local = new THREE.Vector3(jx, 0.42 + r() * 0.5, jz).normalize();
        const shell = new THREE.Vector3(px, py - H * 0.55, pz).normalize();
        const out = local.lerp(shell, 0.45).normalize();
        const along = bDir.clone()
          .addScaledVector(new THREE.Vector3(Math.cos(roll), -0.22, Math.sin(roll)),
            0.55 + r() * 0.75)
          .addScaledVector(new THREE.Vector3(r() - 0.5, r() * 0.4 - 0.5, r() - 0.5), 0.6)
          .normalize();
        cards.push({
          x: px, y: py, z: pz,
          w: sz * 1.08, h: sz, out, along,
          tile: [LEAF_TILES.pineA, LEAF_TILES.pineB, LEAF_TILES.pineC][(r() * 3) | 0],
          ao: (0.22 + 0.78 * Math.pow(t, 0.7)) * (0.38 + 0.62 * f),
          phase: ph, flex: 0.75 + 0.25 * t, tint: cardTint(r), rank: r(),
          flip: r() < 0.5,
        });
      }
    }
  }
  return { limbs, cards, H, radius: H * 0.30 * spreadK, species: 'pine' };
}

/** Cottonwood: short bole forking into leaders, then a broad vase crown. */
function growCottonwood(seed) {
  const r = rng(seed);
  const limbs = [], cards = [];
  const H = 14 + r() * 9;
  const forkT = 0.24 + r() * 0.16;
  const bole = limbPoints(new THREE.Vector3(0, 0, 0),
    new THREE.Vector3((r() - 0.5) * 0.12, 1, (r() - 0.5) * 0.12),
    H * forkT, H * 0.038, H * 0.027, 5, new THREE.Vector3(0, 0, 0), 0.025, r);
  rootFlare(bole, r);
  limbs.push({ pts: bole, sides0: 9, sides1: 5, uScale: 4.0, vScale: 0.85, phase: r(), flex: 0.0, rank: 0 });
  const top = bole[bole.length - 1].p;

  const leaders = 3 + ((r() * 2) | 0);
  const a0 = r() * 6.2831;
  const canopyCentre = new THREE.Vector3(0, H * 0.72, 0);
  const canopyR = H * 0.44;

  const grow = (origin, dir, len, rad, depth, phase) => {
    const pts = limbPoints(origin, dir, len, rad, rad * 0.42, depth === 0 ? 5 : 3,
      new THREE.Vector3(0, depth === 0 ? 0.22 : -0.10, 0), 0.05, r);
    limbs.push({
      pts, sides0: Math.max(4, 6 - depth), sides1: 3, uScale: 2.0, vScale: 1.25,
      phase, flex: 0.15 + depth * 0.28, rank: depth === 0 ? 0 : depth,
    });
    const end = pts[pts.length - 1].p;
    if (depth < 2) {
      const kids = 2 + ((r() * 2) | 0);
      for (let k = 0; k < kids; k++) {
        const ang = (k / kids) * 6.2831 + r() * 1.2;
        const spread = 0.55 + r() * 0.45;
        const nd = dir.clone()
          .addScaledVector(new THREE.Vector3(Math.cos(ang), 0.18 + r() * 0.4, Math.sin(ang)), spread)
          .normalize();
        grow(end, nd, len * (0.56 + r() * 0.18), rad * 0.5, depth + 1, r());
      }
    } else {
      const nCards = 11 + ((r() * 6) | 0);
      const tipDir = pts[pts.length - 1].p.clone().sub(pts[0].p).normalize();
      for (let k = 0; k < nCards; k++) {
        const f = 0.15 + 0.85 * Math.pow(r(), 0.6);
        const pi = Math.min(pts.length - 1, Math.round(f * (pts.length - 1)));
        const p = pts[pi].p;
        const jx = (r() - 0.5) * len * 0.60;
        const jy = (r() - 0.5) * len * 0.46;
        const jz = (r() - 0.5) * len * 0.60;
        const sz = H * (0.056 + r() * 0.034);
        const px = p.x + jx, py = p.y + jy, pz = p.z + jz;
        const shell = new THREE.Vector3(px, py, pz).sub(canopyCentre);
        const d = shell.length();
        if (d < 1e-3) shell.set(0, 1, 0); else shell.multiplyScalar(1 / d);
        const along = tipDir.clone()
          .addScaledVector(shell, 0.75)
          .addScaledVector(new THREE.Vector3(0, -0.35, 0), 0.5)
          .normalize();
        cards.push({
          x: px, y: py, z: pz, w: sz * 1.12, h: sz, out: shell.clone(), along,
          tile: [LEAF_TILES.cottonwoodA, LEAF_TILES.cottonwoodB, LEAF_TILES.cottonwoodC][(r() * 3) | 0],
          ao: (0.22 + 0.78 * THREE.MathUtils.clamp(d / canopyR, 0, 1))
            * (0.52 + 0.48 * THREE.MathUtils.smoothstep(
              (py - canopyCentre.y) / canopyR, -0.75, 0.65)),
          phase, flex: 0.85, tint: cardTint(r), rank: r(), flip: r() < 0.5,
        });
      }
    }
  };

  for (let i = 0; i < leaders; i++) {
    const a = a0 + (i / leaders) * 6.2831 + (r() - 0.5) * 0.7;
    const dir = new THREE.Vector3(Math.cos(a) * 0.62, 1.05 + r() * 0.3, Math.sin(a) * 0.62).normalize();
    grow(top, dir, H * (0.30 + r() * 0.12), H * 0.023, 0, r());
  }
  fillInterior(cards, canopyCentre, canopyR, 6, H, r,
    [LEAF_TILES.cottonwoodA, LEAF_TILES.cottonwoodC]);
  return { limbs, cards, H, radius: canopyR, species: 'cottonwood' };
}

/** Scrub oak: crooked multi-stem, wide and low, dense small foliage. */
function growScrubOak(seed) {
  const r = rng(seed);
  const limbs = [], cards = [];
  const H = 4.2 + r() * 3.6;
  const canopyCentre = new THREE.Vector3(0, H * 0.64, 0);
  const canopyR = H * 0.56;
  const stems = 3 + ((r() * 3) | 0);
  const a0 = r() * 6.2831;

  const grow = (origin, dir, len, rad, depth, phase) => {
    const pts = limbPoints(origin, dir, len, rad, rad * 0.45, depth === 0 ? 4 : 3,
      new THREE.Vector3((r() - 0.5) * 0.5, 0.15, (r() - 0.5) * 0.5), 0.22, r);
    if (depth === 0) rootFlare(pts, r);
    limbs.push({
      pts, sides0: Math.max(4, 7 - depth), sides1: 3, uScale: 1.9, vScale: 1.5,
      phase, flex: 0.10 + depth * 0.3, rank: depth,
    });
    const end = pts[pts.length - 1].p;
    if (depth < 2) {
      const kids = 2 + ((r() * 2) | 0);
      for (let k = 0; k < kids; k++) {
        const ang = r() * 6.2831;
        const nd = dir.clone()
          .addScaledVector(new THREE.Vector3(Math.cos(ang), 0.1 + r() * 0.5, Math.sin(ang)), 0.7 + r() * 0.6)
          .normalize();
        grow(end, nd, len * (0.6 + r() * 0.2), rad * 0.52, depth + 1, r());
      }
    } else {
      const nCards = 8 + ((r() * 5) | 0);
      const tipDir = pts[pts.length - 1].p.clone().sub(pts[0].p).normalize();
      for (let k = 0; k < nCards; k++) {
        const p = pts[Math.min(pts.length - 1, Math.round((0.2 + 0.8 * r()) * (pts.length - 1)))].p;
        const jx = (r() - 0.5) * len * 0.75, jy = (r() - 0.5) * len * 0.55, jz = (r() - 0.5) * len * 0.75;
        const sz = H * (0.112 + r() * 0.070);
        const px = p.x + jx, py = p.y + jy, pz = p.z + jz;
        const shell = new THREE.Vector3(px, py, pz).sub(canopyCentre);
        const d = shell.length();
        if (d < 1e-3) shell.set(0, 1, 0); else shell.multiplyScalar(1 / d);
        const along = tipDir.clone().addScaledVector(shell, 0.85).normalize();
        cards.push({
          x: px, y: py, z: pz, w: sz * 1.18, h: sz, out: shell.clone(), along,
          tile: [LEAF_TILES.oakA, LEAF_TILES.oakB, LEAF_TILES.oakC][(r() * 3) | 0],
          ao: (0.20 + 0.80 * THREE.MathUtils.clamp(d / canopyR, 0, 1))
            * (0.50 + 0.50 * THREE.MathUtils.smoothstep(
              (py - canopyCentre.y) / canopyR, -0.75, 0.65)),
          phase, flex: 0.9, tint: cardTint(r), rank: r(), flip: r() < 0.5,
        });
      }
    }
  };

  for (let i = 0; i < stems; i++) {
    const a = a0 + (i / stems) * 6.2831 + (r() - 0.5) * 0.8;
    const dir = new THREE.Vector3(Math.cos(a) * (0.35 + r() * 0.4), 1.0, Math.sin(a) * (0.35 + r() * 0.4)).normalize();
    grow(new THREE.Vector3((r() - 0.5) * 0.35, 0, (r() - 0.5) * 0.35), dir,
      H * (0.36 + r() * 0.14), H * 0.048, 0, r());
  }
  fillInterior(cards, canopyCentre, canopyR, 5, H, r, [LEAF_TILES.oakA, LEAF_TILES.oakC]);
  return { limbs, cards, H, radius: canopyR, species: 'scrubOak' };
}

/**
 * Oversized, dark, inward-facing cards packed into the middle of a crown. Real
 * canopies are opaque in the middle; a crown built only from twig-tip cards has
 * daylight visible straight through its core, which is what makes procedural
 * trees read as wireframe armatures with leaves stuck on.
 */
function fillInterior(cards, centre, radius, n, H, r, tiles) {
  for (let i = 0; i < n; i++) {
    const a = r() * 6.2831;
    const el = (r() - 0.35) * 1.1;
    const rad = radius * (0.10 + r() * 0.42);
    const px = centre.x + Math.cos(a) * Math.cos(el) * rad;
    const py = centre.y + Math.sin(el) * rad * 0.72;
    const pz = centre.z + Math.sin(a) * Math.cos(el) * rad;
    const out = new THREE.Vector3(px - centre.x, py - centre.y + 0.2, pz - centre.z);
    if (out.lengthSq() < 1e-4) out.set(0, 1, 0);
    out.normalize();
    const sz = radius * (0.46 + r() * 0.26);
    cards.push({
      x: px, y: py, z: pz, w: sz * 1.15, h: sz, out,
      along: new THREE.Vector3(out.x, out.y - 0.6, out.z).normalize(),
      tile: tiles[(r() * tiles.length) | 0],
      ao: 0.14 + r() * 0.14,
      phase: r(), flex: 0.5, tint: cardTint(r), rank: r() * LOD1_KEEP * 0.9,
      flip: r() < 0.5,
    });
  }
}

/** Dead standing timber: broken top, bare limbs, silver-grey bark. */
function growSnag(seed) {
  const r = rng(seed);
  const limbs = [];
  const H = 8 + r() * 8;
  const lean = new THREE.Vector3((r() - 0.5) * 0.16, 0, (r() - 0.5) * 0.16);
  const trunk = limbPoints(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0),
    H, H * 0.028, H * 0.006, 8, lean, 0.035, r);
  // snap the top off at a ragged angle
  const cut = Math.max(2, Math.round(trunk.length * (0.55 + r() * 0.3)));
  const broken = trunk.slice(0, cut);
  broken[broken.length - 1] = { p: broken[broken.length - 1].p, r: broken[broken.length - 1].r * 0.55 };
  // a splintered spike so the break is not a clean disc
  const tp = broken[broken.length - 1].p;
  broken.push({ p: new THREE.Vector3(tp.x + (r() - 0.5) * 0.4, tp.y + H * 0.06, tp.z + (r() - 0.5) * 0.4), r: H * 0.0022 });
  const spine = broken.slice();
  rootFlare(broken, r);
  limbs.push({ pts: broken, sides0: 8, sides1: 5, uScale: 3.2, vScale: 1.05, phase: r(), flex: 0.0, rank: 0 });

  const nb = 5 + ((r() * 5) | 0);
  for (let i = 0; i < nb; i++) {
    const t = 0.28 + r() * 0.66;
    const f = t * (spine.length - 1);
    const bi = Math.min(spine.length - 2, f | 0);
    const origin = spine[bi].p.clone().lerp(spine[bi + 1].p, f - bi);
    const a = r() * 6.2831;
    const dir = new THREE.Vector3(Math.cos(a), 0.15 + r() * 0.5, Math.sin(a)).normalize();
    const len = H * (0.10 + r() * 0.22);
    const pts = limbPoints(origin, dir, len, H * 0.009, H * 0.0018,
      3, new THREE.Vector3(0, -0.30, 0), 0.30, r);
    limbs.push({
      pts, sides0: 5, sides1: 3, uScale: 1.5, vScale: 1.5, phase: r(),
      flex: 0.45, rank: i < 3 ? 1 : 2,
    });
  }
  return { limbs, cards: [], H, radius: H * 0.26, species: 'snag' };
}

const GROWERS = {
  pine: growPine, cottonwood: growCottonwood, scrubOak: growScrubOak, snag: growSnag,
};

/* -------------------------------------------------------------- emission */

function emit(desc, lod) {
  const B = new Builder();
  const F = new Builder();
  const H = desc.H;
  for (const L of desc.limbs) {
    if (lod > 0 && L.rank > 1) continue;
    B.tube(L.pts, lod === 0 ? L.sides0 : L.sides1,
      L.uScale, L.vScale, L.phase, H, L.flex);
  }
  const mul = lod === 0 ? 1 : LOD1_SCALE;
  for (const c of desc.cards) {
    if (lod > 0 && c.rank >= LOD1_KEEP) continue;
    c.mul = mul;
    F.card(c, H);
  }
  return {
    bark: B.geometry(),
    foliage: F.count ? F.geometry() : null,
    height: H,
    radius: desc.radius,
    species: desc.species,
  };
}

/**
 * Grow one tree and emit both LODs from the SAME skeleton, so the LOD swap
 * moves no silhouette and needs no cross-fade.
 *
 * @returns {{lod0:object, lod1:object, height:number, radius:number, species:string}}
 */
export function buildTreePair(species, seed) {
  const desc = (GROWERS[species] || growPine)(seed);
  return {
    lod0: emit(desc, 0),
    lod1: emit(desc, 1),
    height: desc.H,
    radius: desc.radius,
    species: desc.species,
  };
}

/** Back-compatible single-LOD entry point. */
export function buildTree(species, seed, lod = 0) {
  const desc = (GROWERS[species] || growPine)(seed);
  return emit(desc, lod);
}
