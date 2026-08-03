import * as THREE from 'three';
import { rng } from '../core/Context.js';
import { Builder, Frame } from './town/Builder.js';
import { Street, KINDS, SPECIALS, PLAN, sunAzimuthAt, streetBearing } from './town/Layout.js';
import { buildPad, boardwalk, steps } from './town/Ground.js';
import { TOWN_PLAN } from './town/Pad.js';
import { buildBuilding, buildChurch, buildBarn } from './town/Buildings.js';
import {
  hitchRail, trough, barrel, crate, wagonWheel, buckboard, telegraphPole,
  wire, fenceRun, waterTower, windmill, hayStack, lumberStack, lantern,
  signBoard, hangingSign, pebbleField,
} from './town/Props.js';
import { injectWear, makeTownMaterials } from './town/Wear.js';
import { buildSignAtlas } from './town/Signs.js';
import { buildCampfire, makeFlames } from './town/Campfire.js';
import {
  goodsPile, laundryLine, ladder, boardLean, waterPump, tool, bucket, sack,
  buildPuddles, postedBill, awning,
} from './town/Clutter.js';
import { Folk, wardrobe } from './town/Folk.js';

/* Thin members (rails, braces, balusters, wire) go into their own buckets so
 * they can be dropped past the distance at which they are sub-pixel. Pass 2
 * left every 40 mm rail in the world out to the horizon, where a fence turns
 * into a field of single-pixel speckle — the same signature the forensic report
 * called "literal alternating black/white checker". A 42 mm rail subtends half
 * a pixel at 240 m, so that is where they stop being drawn. */
const THIN_CULL = 240;

const _dbSize = new THREE.Vector2();

/**
 * Town — the settlement of RED SANDS, and the camp.
 *
 * PASS-1 FINDING (critical, town_street): "There is no town. […] Not one
 * building, fence, water trough, boardwalk or wagon." This file is the answer.
 *
 * How it is put together
 * ----------------------
 *  1. `Street` lofts a bending spine across the flattest shelf Terrain could
 *     find and derives a GRADE — a morphological closing of the cross-section
 *     maxima. Terrain owns that grade now (town/Pad.js) and publishes it
 *     through `ctx.world.getHeight`, so the pad is always fill — a graded shelf
 *     with a shallow embankment at the rim — and the query agrees with it.
 *  2. `Ground` lays the crowned, wheel-rutted street on that grade and the two
 *     boardwalks, plank by plank, with gaps, sag, value jitter and missing
 *     boards.
 *  3. `Layout` allocates sixteen lots and picks a type for each. Buildings are
 *     parameterised masses (`Buildings.js`) built around FALSE FRONTS: a thick
 *     screen wall with a stepped cap and a projecting cornice, hiding a smaller
 *     shed or gable behind it. Two specials carry the skyline — a church with a
 *     nine-metre tower and an eight-sided spire, and gambrel-roofed barns.
 *  4. `Props` supplies everything vertical that the pass-1 critique asked for:
 *     telegraph poles with catenary wire, a lattice water tower, a windmill
 *     whose rotor actually turns, hitching rails, troughs, fences, a buckboard.
 *  5. `Wear` runs a per-pixel weathering pass over every surface — per-board
 *     value jitter, sun bleaching on up- and south-facing planes, rain and rust
 *     streaks under the eaves, dirt splash to knee height, dust on horizontals.
 *     Nothing is pristine and nothing tiles visibly.
 *
 * Everything static is merged into ONE indexed geometry per material, so the
 * whole settlement is ~17 draw calls; the camp is a second, tightly-bounded
 * set of ~6 so its bounding sphere does not drag the town into every shadow
 * cascade.
 *
 * Deterministic: every random number comes from rng(ctx.seed).
 */

const TAU = Math.PI * 2;

/* Bucket name per surface role. Roles that share a bucket share a draw call. */
const M = {
  plank: 'plank',
  weathered: 'weathered',
  painted: 'painted',
  stone: 'stone',
  adobe: 'adobe',
  shingle: 'shingle',
  iron: 'iron',
  rust: 'rust',
  glass: 'glass',
  glassLit: 'glassLit',
  canvas: 'canvas',
  canvasCamp: 'canvas',
  hay: 'hay',
  sign: 'sign',
  rock: 'rock',
  ash: 'ash',
  charred: 'weathered',
  water: 'water',
  road: 'road',
  rotor: 'rotor',
  /* thin members — same materials, separate merge, distance-culled */
  thin: 'weathered#thin',
  thinIron: 'rust#thin',
  thinTrim: 'plank#thin',
  /* Overhead wire gets its OWN bucket so it can be excluded from the shadow
   * cascades. Two telegraph wires were casting a pair of hard, one-pixel-wide,
   * perfectly straight black lines the full length of the street — the single
   * most conspicuous artifact in the near ground, and a pure aliasing
   * signature. A real 5 mm wire casts nothing you can see; ours is 16 mm and
   * now casts nothing at all. */
  wire: 'rust#wire',
};

/**
 * bucket → [key, texture, overrides].
 * `hex` is the stochastic-tiling cell size in UV tiles; anything an eye can
 * land on at hero scale gets one, because the pass-2 critique measured the
 * facade autocorrelation peaking at 0.49 and called visible tiling an automatic
 * rejection. `timber` turns on nail lines and replaced boards.
 */
const MAT_DEFS = [
  ['plank', 'wood_plank', { nrm: 1.25, hex: 2.6, timber: 1 }],
  ['weathered', 'wood_weathered', { nrm: 1.45, hex: 2.6, timber: 1 }],
  ['painted', 'wood_painted', { nrm: 1.1, hex: 2.8, timber: 1 }],
  ['stone', 'stone_block', { nrm: 1.35, hex: 2.4 }],
  ['adobe', 'adobe', { nrm: 1.15, hex: 2.4 }],
  ['shingle', 'shingle', { nrm: 1.5, hex: 2.2 }],
  ['iron', 'corrugated_iron', { nrm: 1.3, metalness: 0.30, roughness: 0.66 }],
  ['rust', 'metal_rusted', { nrm: 1.1, metalness: 0.16, roughness: 0.92 }],
  ['canvas', 'canvas_tent', { nrm: 0.9 }],
  ['hay', 'hay', { nrm: 1.2 }],
  ['rock', 'rock_boulder', { nrm: 1.3, hex: 2.0 }],
  ['ash', 'dirt_dry', { nrm: 0.9 }],
  ['road', 'dirt_packed', { nrm: 1.25, hex: 3.0 }],
  ['rotor', 'wood_painted', { nrm: 0.9 }],
];

/* -------------------------------------------------------------------------- */

export class Town {
  static id = 'town';

  constructor(ctx) {
    this.ctx = ctx;
    this.group = null;
    this.campGroup = null;
    this.mats = new Map();
    this.meshes = [];
    this.flames = null;
    this.fire = null;
    this.rotor = null;
    this.rotorAxis = new THREE.Vector3(1, 0, 0);
    this.rotorAngle = 0;
    this._t = 0;
    this._lamps = [];
    this._glow = null;
    this._glowMat = null;
    this._emitters = [];
    this._litMats = [];
    this.stats = { draws: 0, tris: 0 };
    /** Public: town footprint, so vegetation/scatter can keep out of it. */
    this.site = null;
  }

  /* --------------------------------------------------------------- init */

  async init() {
    const ctx = this.ctx;
    const rand = rng((ctx.seed ^ 0x7b19a3) >>> 0);
    const proc = ctx.get('procTextures');
    const sky = ctx.get('sky');
    const L = ctx.get('lighting');
    const terrain = ctx.get('terrain');
    const H = ctx.world && ctx.world.ready
      ? ctx.world.getHeight
      : () => 0;

    /* --------------------------------------------------------- materials */
    const { mk } = makeTownMaterials(proc, 16);
    this._wearOpts = new Map();
    for (const [key, tex, over] of MAT_DEFS) {
      const opts = { hex: over.hex || 0, timber: !!over.timber };
      const clean = { ...over };
      delete clean.hex; delete clean.timber;
      this.mats.set(key, mk(key, tex, clean));
      this._wearOpts.set(key, opts);
    }

    // glass: dirty, dark, tight specular. No env map in this build, so the
    // windows read from the sun glint and the interior darkness behind them.
    const glass = new THREE.MeshStandardMaterial({
      vertexColors: true, color: 0xffffff, roughness: 0.14, metalness: 0.0,
      dithering: true,
    });
    glass.name = 'town_glass';
    this.mats.set('glass', glass);

    const glassLit = new THREE.MeshStandardMaterial({
      vertexColors: true, color: 0xffffff, roughness: 0.30, metalness: 0.0,
      emissive: new THREE.Color(1.0, 0.46, 0.16), emissiveIntensity: 0.0,
      dithering: true,
    });
    glassLit.name = 'town_glassLit';
    this.mats.set('glassLit', glassLit);
    this._litMats.push(glassLit);

    const water = new THREE.MeshStandardMaterial({
      vertexColors: true, color: 0x2b2a24, roughness: 0.075, metalness: 0.0,
      dithering: true,
    });
    water.name = 'town_troughWater';
    this.mats.set('water', water);

    const signs = buildSignAtlas(1024);
    this.signRects = signs.rects;
    const signMat = new THREE.MeshStandardMaterial({
      map: signs.texture, vertexColors: true, roughness: 0.86, metalness: 0,
      dithering: true,
    });
    signMat.name = 'town_sign';
    this.mats.set('sign', signMat);
    this._signTex = signs.texture;

    /* --- the ash decal needs a transparent sibling of the ash material so its
     * per-vertex alpha can feather it into the terrain instead of ending on a
     * polygon edge. It is one extra draw call, at the camp only. */
    const ashBase = this.mats.get('ash');
    const ashDecal = ashBase.clone();
    ashDecal.name = 'town_ashDecal';
    ashDecal.transparent = true;
    ashDecal.depthWrite = false;
    ashDecal.polygonOffset = true;
    ashDecal.polygonOffsetFactor = -3;
    ashDecal.polygonOffsetUnits = -3;
    ashDecal.roughness = 1.0;
    this.mats.set('ashDecal', ashDecal);
    this._wearOpts.set('ashDecal', { hex: 2.2, timber: false });

    for (const [key, m] of this.mats) {
      injectWear(m, this._wearOpts.get(key) || {});
      if (sky && typeof sky.injectAerialPerspective === 'function') {
        sky.injectAerialPerspective(m);
      }
      if (L && typeof L.registerMaterial === 'function') L.registerMaterial(m);
    }

    /* --- standing water -------------------------------------------------
     * Deliberately NOT run through injectWear: the weathering chunk reads the
     * `aWear` attribute, which the puddle sheet does not carry (and does not
     * want — water does not sun-bleach). It is added to `this.mats` after the
     * loop purely so dispose() still frees it.
     * Low roughness is the whole point. A wet street is not "a darker street";
     * it is a street with a specular response, and at a 16:30 sun that is a
     * long horizontal smear of sky and sun down every rut. */
    const puddle = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.085, metalness: 0.02,
      transparent: true, depthWrite: false, dithering: true,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    puddle.name = 'town_puddle';
    /* THE SKY REFLECTION IS AN EMISSIVE, NOT A SHADER INJECTION.
     *
     * There is no environment map in this build, so a 0.085-roughness dielectric
     * has nothing to reflect and renders as a black hole with a pinpoint sun
     * glint — which is exactly what the first build produced: navy-black tar
     * streaks down the wheel ruts. The physically right answer is a Fresnel-
     * weighted sample of the sky dome, and that was tried as an `onBeforeCompile`
     * term folded into `totalEmissiveRadiance`. It never fired.
     *
     * The reason is worth recording, because it will bite the next person:
     * three caches compiled programs GLOBALLY by (parameter set + custom cache
     * key) and hands out a match WITHOUT re-running onBeforeCompile. A material
     * that picks up only the sky's wrapper keys as plain `rsAerial|`, collides
     * with every other such material in the scene, and silently renders someone
     * else's shader. Claiming a unique key fixed the collision and STILL did not
     * produce a visible term, at which point the honest engineering call is to
     * stop paying for a mechanism with two failure modes and use the one that
     * has none: `material.emissive`, driven from `ctx.env` every frame. It loses
     * the grazing-angle Fresnel ramp — the pool is uniformly sky-bright rather
     * than brightening toward the far rim — and keeps the specular sun glint,
     * which is the half that actually reads as "wet".
     */
    puddle.emissive = new THREE.Color(0, 0, 0);
    puddle.emissiveIntensity = 1.0;
    this.mats.set('puddle', puddle);
    if (sky && typeof sky.injectAerialPerspective === 'function') sky.injectAerialPerspective(puddle);
    if (L && typeof L.registerMaterial === 'function') L.registerMaterial(puddle);

    /* ------------------------------------------------------------- site
     * Position comes from Terrain (the flattest buildable shelf near water).
     * The BEARING is ours: see Layout.streetBearing — the spine is aimed so the
     * warm-afternoon key sits behind the camera's shoulder rather than in the
     * lens, which is the difference between a street and a sheet of glare.
     */
    const site = (terrain && terrain.townSite) || null;
    /*
     * Terrain has normally already built this exact spine and CARVED ITS GRADE
     * INTO THE HEIGHTFIELD (see town/Pad.js), so we adopt its bearing and grade
     * table verbatim. Re-deriving the grade from the graded ground would close
     * the upper envelope over its own output and lift the town another 0.30 m —
     * which is precisely the class of bug this change exists to kill.
     */
    const tp = (terrain && terrain.townPad) || null;
    let cx, cz, contour = null, relief = 0;
    if (site) {
      cx = site.x; cz = site.z;
      contour = [site.dir.x, site.dir.z];
      relief = site.relief || 0;
    } else {
      const p = ctx.poi.get('town');
      const q = p ? (p.pos || p) : new THREE.Vector3(-520, 0, -180);
      cx = q.x; cz = q.z;
    }
    const tod = ctx.get('timeOfDay');
    const sunAz = tp ? tp.sunAz : sunAzimuthAt(TOWN_PLAN.hour, ctx.env.dayOfYear || 172,
      tod && tod.latitude != null ? tod.latitude : 38);
    const bearing = tp ? tp.bearing : streetBearing(sunAz, contour, relief);
    const dx = bearing[0], dz = bearing[1];
    this.sunAz = sunAz;
    /* Hand the prevailing afternoon bearing to the weathering pass so the
     * sun-bleached side of every building is the side that actually gets the
     * afternoon sun, and stays that side all day. */
    for (const m of this.mats.values()) {
      // sunAzimuthAt returns a unit XZ direction TO the sun, not an angle
      if (m.userData.rsSunAz) m.userData.rsSunAz.value.set(sunAz[0], sunAz[1]);
    }
    const len = TOWN_PLAN.length;
    const street = new Street({
      cx, cz, dx, dz, length: len, halfWidth: TOWN_PLAN.corridor,
      getHeight: H, rand, grade: tp ? tp.grade : null,
    });
    this.street = street;

    /* ------------------------------------------------------------ build */
    const B = new Builder();
    const CB = new Builder();          // camp: separate merge, tight bounds
    const out = { glow: [], lamps: [], smoke: [], doors: [] };

    const PLATEAU = TOWN_PLAN.plateau, RIM = TOWN_PLAN.rim;
    const pad = buildPad(B, M.road, street, {
      sMin: -len * 0.5 - TOWN_PLAN.sPad, sMax: len * 0.5 + TOWN_PLAN.sPad,
      plateau: PLATEAU, rim: RIM, getHeight: H, conform: !!tp,
    });
    this.pad = pad;

    const FACADE = 12.0;      // |t| of the building front wall
    const WALK_OUT = 9.2;     // |t| of the outer edge of the boardwalk
    const deckOff = 0.44;

    /* ---- allocate lots ---------------------------------------------------
     * The row is fitted to the street rather than laid out from one end, so
     * the frontage always fills the frame from the `town` POI. Gaps are
     * jittered but sum to the leftover span, and the two sides are staggered
     * so no two facades ever line up across the road.
     */
    const placed = [];
    const gapsBySide = {};
    for (const sideName of ['left', 'right']) {
      const side = sideName === 'left' ? -1 : +1;
      const kinds = PLAN[sideName];
      const specs = [];
      for (const key of kinds) {
        const gen = KINDS[key] || SPECIALS[key];
        if (!gen) continue;
        const spec = gen(rand);
        spec.kind = key;
        /* Per-lot height jitter on top of the type's own range. A row whose
         * eaves all land within half a metre reads as a texture, not as a
         * street; ±12 % on the wall and ±25 % on the parapet is what makes the
         * roofline saw up and down. */
        const hk = 0.90 + rand() * 0.24;
        spec.h *= hk;
        if (spec.frontTop) spec.frontTop *= 0.80 + rand() * 0.55;
        if (spec.floor2) spec.floor2 *= hk;
        if (spec.balconyY) spec.balconyY *= hk;
        if (spec.porchY) spec.porchY *= 0.96 + rand() * 0.09;
        specs.push(spec);
      }
      let total = 0;
      for (const sp of specs) total += sp.w;
      const span = len - 12;
      const nGap = Math.max(1, specs.length - 1);
      const gapTotal = Math.max(nGap * 1.4, span - total);
      const raw = [];
      let rsum = 0;
      for (let i = 0; i < nGap; i++) { const v = 0.45 + rand() * 1.3; raw.push(v); rsum += v; }
      let s = -span * 0.5 + (side < 0 ? 0 : 3.5 + rand() * 3);
      const gaps = [];
      for (let i = 0; i < specs.length; i++) {
        const sp = specs[i];
        placed.push({ spec: sp, side, s: s + sp.w * 0.5, setback: sp.setback || 0 });
        const g = i < nGap ? (raw[i] / rsum) * gapTotal : 0;
        if (i < nGap) gaps.push({ s0: s + sp.w, s1: s + sp.w + g, w: g });
        s += sp.w + g;
      }
      gapsBySide[side] = gaps;
    }
    this._gaps = gapsBySide;

    /* ---- resolve placement + emit --------------------------------------- */
    const buildings = [];
    for (const lot of placed) {
      const { spec, side, s, setback } = lot;
      const tFace = FACADE + setback;
      const n = street.normalRaw(s);
      // outward normal (away from the street) for this side
      const N = [n[0] * side, n[1] * side];
      spec.dirX = N[1];
      spec.dirZ = -N[0];
      const c = street.xz(s, side * tFace);
      spec.ox = c[0]; spec.oz = c[1];

      const gGround = pad.height(s, side * (tFace - 0.5));
      spec.groundY = gGround;
      spec.floorY = gGround + deckOff + 0.03;
      // lowest natural ground under the footprint, so plinths reach the dirt
      let lo = Infinity;
      for (let a = -1; a <= 1; a++) {
        for (let b = 0; b <= 2; b++) {
          const q = street.xz(s + a * spec.w * 0.45, side * (tFace + (b * spec.d) / 2));
          const hh = Math.min(H(q[0], q[1]), pad.height(s + a * spec.w * 0.45, side * (tFace + (b * spec.d) / 2)));
          if (hh < lo) lo = hh;
        }
      }
      spec.baseY = Math.min(lo, gGround);
      spec.litMask = (rand() * 4096) | 0;
      spec.uvo = rand() * 37.0;
      spec.uvo2 = rand() * 29.0;
      /* Per-LOT paint mix. Two lots of the same type used to share a colour
       * exactly, which is the "repeating identical props" failure applied to
       * architecture. ±11 % in value with a small independent hue drift is
       * enough that no two walls in the row read as the same batch of paint. */
      const tint = (c, k) => (c ? [
        c[0] * k * (0.97 + rand() * 0.06),
        c[1] * k * (0.97 + rand() * 0.06),
        c[2] * k * (0.96 + rand() * 0.08),
      ] : c);
      const kw = 0.90 + rand() * 0.21;
      spec.color = tint(spec.color, kw);
      if (spec.frontColor) spec.frontColor = tint(spec.frontColor, 0.91 + rand() * 0.19);
      if (spec.roofColor) spec.roofColor = tint(spec.roofColor, 0.88 + rand() * 0.25);
      if (spec.trimCol) spec.trimCol = tint(spec.trimCol, 0.93 + rand() * 0.15);

      if (spec.falseFront) {
        const ft = spec.frontTop || 2.2;
        const x0 = -spec.w * 0.5, x1 = spec.w * 0.5;
        const st = spec.stepped || 1;
        if (st === 1) {
          spec.panels = [{ x0, x1, top: spec.h + ft }];
        } else if (st === 2) {
          spec.panels = [
            { x0, x1, top: spec.h + ft * 0.55 },
            { x0: x0 + spec.w * 0.15, x1: x1 - spec.w * 0.15, top: spec.h + ft },
          ];
        } else {
          spec.panels = [
            { x0, x1, top: spec.h + ft * 0.42 },
            { x0: x0 + spec.w * 0.12, x1: x1 - spec.w * 0.12, top: spec.h + ft * 0.74 },
            { x0: x0 + spec.w * 0.28, x1: x1 - spec.w * 0.28, top: spec.h + ft },
          ];
        }
        spec.frontHeight = spec.h + ft;
      } else {
        spec.frontHeight = spec.h;
      }
      if (spec.storeys > 1 && spec.floor2 == null) spec.floor2 = spec.h * 0.60;

      let res;
      if (spec.special === 'church') res = buildChurch(B, M, spec, rand, out);
      else if (spec.special === 'barn') res = buildBarn(B, M, spec, rand, out);
      else res = buildBuilding(B, M, spec, rand, out);
      buildings.push({ ...lot, spec, F: res.F, res, tFace });
    }
    this.buildings = buildings;

    /* ---- boardwalks: continuous runs in front of the built frontage -----
     * The deck is a deliberate 44 cm step up, and a single-valued heightfield
     * cannot report both the street and a platform over it. So the walk edge is
     * made solid to the capsule controller (Physics.addBlocker) instead of
     * being faked into the height query — the player and the horse stay on the
     * street, at the height `ctx.world.getHeight` actually returns, and nothing
     * ends up shin-deep in a plank deck. */
    const walkEdges = [];
    for (const side of [-1, +1]) {
      const row = buildings.filter((b) => b.side === side && !b.setback)
        .sort((a, b) => a.s - b.s);
      let i = 0;
      while (i < row.length) {
        let j = i;
        let s0 = row[i].s - row[i].spec.w * 0.5 - 0.6;
        let s1 = row[i].s + row[i].spec.w * 0.5 + 0.6;
        while (j + 1 < row.length && row[j + 1].s - row[j + 1].spec.w * 0.5 - s1 < 4.2) {
          j++;
          s1 = row[j].s + row[j].spec.w * 0.5 + 0.6;
        }
        const deckY = (s) => pad.height(s, side * (WALK_OUT + 0.9)) + deckOff;
        boardwalk(B, M, street, {
          s0, s1, side, tIn: FACADE - 0.05, tOut: WALK_OUT, rand, deckY,
        });
        // a set of steps down to the street at each end and once in the middle
        steps(B, M, street, { s: s0 + 1.2, side, tOut: WALK_OUT, rand, deckY });
        steps(B, M, street, { s: s1 - 1.2, side, tOut: WALK_OUT, rand, deckY });
        if (s1 - s0 > 26) {
          steps(B, M, street, { s: (s0 + s1) * 0.5, side, tOut: WALK_OUT, rand, deckY });
        }
        /* The spine bends, so the edge is chorded rather than one long segment;
           8 m chords keep the wall within a couple of centimetres of the deck. */
        const nSeg = Math.max(1, Math.ceil((s1 - s0) / 8));
        for (let k = 0; k < nSeg; k++) {
          const sa = s0 + ((s1 - s0) * k) / nSeg;
          const sb = s0 + ((s1 - s0) * (k + 1)) / nSeg;
          const A = street.xz(sa, side * WALK_OUT);
          const Bp = street.xz(sb, side * WALK_OUT);
          walkEdges.push({
            ax: A[0], az: A[1], bx: Bp[0], bz: Bp[1],
            yMin: Math.min(deckY(sa), deckY(sb)) - 1.6,
            yMax: Math.max(deckY(sa), deckY(sb)) + 0.30,
          });
        }
        i = j + 1;
      }
    }
    const PH = ctx.get('physics');
    if (PH && typeof PH.addBlocker === 'function') {
      this._blockers = walkEdges.map((e) => PH.addBlocker({ ...e, radius: 0.06 }));
    }

    /* ---- the buildings are solid ---------------------------------------
     * The boardwalk blockers keep a man on the street, but nothing kept him
     * out of the SALOON — walk up the steps onto a deck and the front wall was
     * a hologram. One upright box per lot, oriented to the lot's own frame,
     * registered as a STATIC collider so it is hashed once at boot and never
     * touched again. Sixteen boxes; the broad phase reports two or three
     * candidates for a character standing anywhere in town. */
    if (PH && typeof PH.addCollider === 'function') {
      this._colliders = [];
      for (const b of buildings) {
        const sp = b.spec;
        if (!sp || !sp.w || !sp.d) continue;
        // spec.dirX/dirZ run ALONG the street; the outward normal is its perp
        const nx = -sp.dirZ, nz = sp.dirX;
        const h = (sp.frontHeight || sp.h || 4) + 0.4;
        const y0 = sp.baseY != null ? sp.baseY : sp.groundY;
        this._colliders.push(PH.addCollider({
          shape: 'box',
          position: new THREE.Vector3(
            sp.ox + nx * sp.d * 0.5, y0 + h * 0.5, sp.oz + nz * sp.d * 0.5),
          halfExtents: new THREE.Vector3(sp.w * 0.5, h * 0.5, sp.d * 0.5),
          axis: [sp.dirX, sp.dirZ],
          mask: PH.LAYER.WORLD,
          tag: 'building',
          owner: b,
        }));
      }
    }

    /* ---- signage --------------------------------------------------------- */
    for (const b of buildings) {
      const key = b.spec.sign;
      if (!key || !this.signRects[key]) continue;
      const rect = this.signRects[key];
      const ratio = rect.ratio || 4.5;
      const spec = b.spec;
      const wear = [spec.groundY - 0.05, spec.floorY + spec.h + 1.1, spec.grime, spec.chalk];
      const sw = Math.min(spec.w * 0.72, 5.6);
      const sh = sw / ratio;
      const screen = !!spec.falseFront;
      // The church's board goes on the FRONT OF THE TOWER, which projects a
      // full bay in front of the nave wall; at z = 0 it would be buried inside
      // the tower.
      const z = spec.special === 'church' ? -spec.towerW * 0.94 - 0.055
        : screen ? -0.335 : -0.075;
      let y1;
      if (spec.special === 'church') y1 = 3.15;
      else if (spec.special === 'barn') y1 = spec.h + 0.55;
      else if (spec.storeys > 1) y1 = spec.floor2 - 0.42;
      else y1 = spec.frontHeight - 0.55;
      const y0 = y1 - sh;
      if (y0 > 2.45) {
        signBoard(B, M, b.F, {
          x0: -sw * 0.5, x1: sw * 0.5, y0, y1, z, uv: rect, wear,
        });
      }
      if (spec.hanging) {
        hangingSign(B, M, b.F.sub(spec.w * 0.5 - 1.2, 0, 0), {
          y: 2.94, len: 1.6, h: 1.6 / ratio + 0.34,
          z: screen ? -0.32 : -0.09, uv: rect, wear,
        });
      }
    }

    /* ---- porch lanterns: real geometry, and the glow/point-light anchor
     * comes back from the globe itself so the halo sits inside the glass.  */
    const lampPts = [];
    for (const l of out.lamps) {
      const LF = l.F.sub(l.local.x, l.local.z, l.local.y);
      const flame = lantern(B, M, LF, { arm: 0.40 });
      lampPts.push(flame);
    }

    /* ---- street furniture ------------------------------------------------ */
    this._furniture(B, street, pad, buildings, rand, out);

    /* ---- vertical landmarks --------------------------------------------- */
    this._landmarks(B, street, pad, rand, len);

    /* ---- clutter: goods against every wall, laundry, tools, a pump ------- */
    this._clutter(B, street, pad, buildings, rand, FACADE, WALK_OUT, deckOff);

    /* ---- the camp -------------------------------------------------------- */
    const campInfo = this._camp(CB, rand, H);

    /* ---------------------------------------------------------- assemble */
    this.group = new THREE.Group();
    this.group.name = 'town';
    this.campGroup = new THREE.Group();
    this.campGroup.name = 'camp';

    this._thin = [];
    const emit = (builder, parent) => {
      const geos = builder.build();
      for (const [name, g] of geos) {
        const hash = name.indexOf('#');
        const matName = hash < 0 ? name : name.slice(0, hash);
        const mat = this.mats.get(matName);
        if (!mat) { g.dispose(); continue; }
        g.setAttribute('uv1', g.getAttribute('uv'));   // aoMap wants uv1
        const mesh = new THREE.Mesh(g, mat);
        mesh.name = 'town_' + name;
        /* Shadow enrolment is OPT-OUT (CascadedShadowMaps._autoCaster), so
         * `castShadow = false` alone is not enough — the cascade auto-enrols
         * any opaque mesh unless `userData.rsNoShadow` says otherwise. Setting
         * only the flag is why the wire's shadow survived the first fix. */
        mesh.castShadow = name.indexOf('#wire') < 0;
        if (!mesh.castShadow) mesh.userData.rsNoShadow = true;
        mesh.receiveShadow = true;
        if (hash >= 0) this._thin.push(mesh);
        if (name === 'rotor') {
          const c = this._rotorHub;
          if (c) {
            g.translate(-c[0], -c[1], -c[2]);
            g.computeBoundingSphere();
            mesh.position.set(c[0], c[1], c[2]);
          }
          this.rotor = mesh;
        }
        parent.add(mesh);
        this.meshes.push(mesh);
        this.stats.tris += g.index ? g.index.count / 3 : 0;
      }
    };
    emit(B, this.group);
    emit(CB, this.campGroup);

    /* --- the burn scar under the fire ------------------------------------
     * Pass-2 regression, night_camp: "a hard-edged square/diamond patch with a
     * dead-straight boundary … the most obviously synthetic edge in the entire
     * set." Replaced by a terrain-conforming, noise-rimmed, alpha-feathered
     * decal — see Campfire.buildAshDecal. */
    if (campInfo && campInfo.ashGeometry) {
      const dm = new THREE.Mesh(campInfo.ashGeometry, this.mats.get('ashDecal'));
      dm.name = 'town_ashDecal';
      dm.castShadow = false;
      dm.receiveShadow = true;
      dm.renderOrder = 1;
      this.campGroup.add(dm);
      this.meshes.push(dm);
      this._ashDecal = dm;
    }
    this.stats.draws = this.meshes.length;

    ctx.scene.add(this.group);
    ctx.scene.add(this.campGroup);

    if (L && typeof L.requestShadowCaster === 'function') {
      for (const m of this.meshes) {
        if (m.material === this.mats.get('road')
          || m.material === this.mats.get('ashDecal')) { m.castShadow = false; continue; }
        /* The camp's stone bucket does NOT cast into the fire's own shadow map.
         * A displaced sphere 0.7 m from an omni light self-shadows its own crown
         * before any reasonable bias can catch it, and the result is a hard black
         * bite out of the top of every fire-ring stone. The logs, the tripod and
         * the log stack still cast, which is what the shot needs. */
        if (m.parent === this.campGroup && m.material === this.mats.get('rock')) {
          m.castShadow = false; continue;
        }
        if (!m.castShadow) continue;
        L.requestShadowCaster(m);
      }
    }

    /* ---------------------------------------------------- standing water */
    this._puddles(street, pad, rand);

    /* ---------------------------------------------------------- the folk */
    this._folk(street, pad, buildings, rand, proc, sky, L, FACADE, WALK_OUT, deckOff);

    /* ---------------------------------------------------- window glow ---- */
    this._buildGlow(out.glow, lampPts, sky);

    /* ---------------------------------------------------------- campfire */
    this._campLights(campInfo, L, rand);

    /* ------------------------------------------------------- local lights */
    this._townLights(lampPts, L, rand);

    /* ------------------------------------------------------------ smoke */
    this._smoke = out.smoke.slice(0, 5);
    this._campSmokePos = campInfo ? campInfo.pos.clone() : null;
    /** Public: the camp footprint, so vegetation can keep grass out of the fire. */
    this.camp = campInfo ? { pos: campInfo.pos.clone(), radius: 5.5 } : null;

    /* -------------------------------------------------------------- POIs */
    this._registerPOIs(street, pad, len, campInfo);

    /* World -> street coordinates, for the keep-out below. Terrain already
       built this exact converter for the pad; reuse it rather than deriving a
       second, subtly different one. */
    const toStreet = tp && tp.toStreet ? tp.toStreet : null;
    const _stScratch = { s: 0, t: 0 };
    this.site = {
      x: cx, z: cz, radius: RIM + 12,
      /**
       * True on the MADE GROUND — the roadway, its verges and the boardwalks.
       * Scatter and vegetation must keep out of this: a creosote bush growing
       * between the wheel ruts of Main Street is a louder "nobody lives here"
       * signal than an empty street is, and pass-9 town_street had three.
       * Deliberately tight (a 16 m half-width corridor, not the 130 m site
       * radius) so the settlement still sits in real vegetation.
       */
      onStreet: toStreet
        ? (x, z) => {
          const q = toStreet(x, z, _stScratch);
          return Math.abs(q.t) < 16.0 && Math.abs(q.s) < len * 0.5 + 26;
        }
        : () => false,
      /** True inside the graded settlement footprint. */
      contains: (x, z) => {
        const dxx = x - cx, dzz = z - cz;
        return dxx * dxx + dzz * dzz < (len * 0.6 + RIM) ** 2;
      },
    };

    if (ctx.quality && ctx.quality.name && import.meta.env && import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log('[town]', this.stats.draws, 'draws', Math.round(this.stats.tris), 'tris');
    }
  }

  /* ------------------------------------------------------------ furniture */

  _furniture(B, street, pad, buildings, rand, out) {
    const frame = (s, t, rot = 0) => {
      const tg = street.tangent(s);
      const p = street.xz(s, t);
      const y = pad.height(s, t);
      const c = Math.cos(rot), si = Math.sin(rot);
      return new Frame(p[0], y, p[1], tg[0] * c - tg[1] * si, tg[0] * si + tg[1] * c);
    };

    for (const b of buildings) {
      const { spec, side, s, tFace } = b;
      const yF = pad.height(s, side * (tFace - 0.5));
      const wear = [yF, yF + 2.6, 0.9, 0.25];

      /* hitching rail out in the street, parallel to the kerb */
      if (spec.hitch) {
        const ts = side * 6.15;
        const F = frame(s + (rand() - 0.5) * 1.6, ts);
        hitchRail(B, M, F, Math.min(spec.w * 0.72, 7.0), {
          seed: rand() * 6, wear: [F.oy, F.oy + 1.3, 0.92, 0.2],
        });
      }
      if (spec.trough) {
        const F = frame(s + spec.w * 0.32, side * 6.05, (rand() - 0.5) * 0.14);
        trough(B, M, F, { len: 2.4 + rand() * 0.6, wear: [F.oy, F.oy + 1.0, 0.95, 0.15] });
      }

      /* things stacked on the boardwalk against the facade */
      const deck = pad.height(s, side * 8.6) + 0.44;
      const nB = spec.barrels || 0;
      for (let i = 0; i < nB; i++) {
        const ss = s - spec.w * 0.36 + (spec.w * 0.72 * (i + 0.5)) / Math.max(1, nB) + (rand() - 0.5) * 0.5;
        const tt = side * (tFace - 0.62 - rand() * 0.35);
        const p = street.xz(ss, tt);
        const F = new Frame(p[0], deck, p[1], 1, 0);
        barrel(B, M, F, {
          h: 0.78 + rand() * 0.16, r: 0.27 + rand() * 0.05,
          tilt: rand() < 0.16 ? 1.42 : 0, seed: rand() * 6,
          col: [0.62 + rand() * 0.2, 0.53 + rand() * 0.16, 0.42 + rand() * 0.12],
          wear: [deck, deck + 1.1, 0.9, 0.25],
        });
      }
      const nC = spec.crates || 0;
      for (let i = 0; i < nC; i++) {
        const ss = s + spec.w * (0.12 + 0.22 * i) + (rand() - 0.5) * 0.4;
        const tt = side * (tFace - 0.55 - rand() * 0.4);
        const p = street.xz(ss, tt);
        const stack = rand() < 0.4 ? 2 : 1;
        for (let k = 0; k < stack; k++) {
          const sz = 0.46 + rand() * 0.22;
          const F = new Frame(p[0] + (rand() - 0.5) * 0.1, deck + k * 0.52, p[1] + (rand() - 0.5) * 0.1,
            Math.cos(rand() * TAU), Math.sin(rand() * TAU));
          crate(B, M, F, {
            size: sz, d: sz * (0.82 + rand() * 0.3), h: sz * 0.9,
            col: [0.78 + rand() * 0.14, 0.68 + rand() * 0.12, 0.53 + rand() * 0.1],
            wear: [deck, deck + 1.0, 0.82, 0.3],
          });
        }
      }
      if (spec.wheels) {
        for (let i = 0; i < spec.wheels; i++) {
          const ss = s - spec.w * 0.4 + rand() * spec.w * 0.8;
          const tt = side * (tFace - 0.4);
          const p = street.xz(ss, tt);
          const yy = pad.height(ss, tt);
          const r = 0.48 + rand() * 0.22;
          const a = rand() * TAU;
          const F = new Frame(p[0], yy + r * 0.97, p[1], Math.cos(a), Math.sin(a));
          wagonWheel(B, M, F, { r, spokes: 10 + ((rand() * 4) | 0), wear: [yy, yy + 1.4, 0.92, 0.2] });
        }
      }
      if (spec.hay) {
        for (let i = 0; i < 3; i++) {
          const ss = s + (rand() - 0.5) * spec.w * 0.8;
          const tt = side * (tFace + spec.d * 0.1 + rand() * 3);
          const p = street.xz(ss, tt);
          const yy = pad.height(ss, tt);
          const a = rand() * TAU;
          hayStack(B, M, new Frame(p[0], yy, p[1], Math.cos(a), Math.sin(a)),
            { size: 0.8 + rand() * 0.5, h: 0.5 + rand() * 0.35 });
        }
      }
      if (spec.lumber) {
        const ss = s + spec.w * 0.55;
        const tt = side * (tFace + 1.6);
        const p = street.xz(ss, tt);
        const yy = pad.height(ss, tt);
        const F = frame(ss, tt);
        void F;
        lumberStack(B, M, new Frame(p[0], yy, p[1], street.tangent(ss)[0], street.tangent(ss)[1]),
          { rows: 4 + ((rand() * 3) | 0), len: 3.0 + rand() * 0.8 });
      }
      /* picket fence around a yard */
      if (spec.fence) {
        const half = spec.w * 0.5 + 0.9;
        const tOut = side * (tFace - 1.5);
        const tIn2 = side * (tFace + Math.min(spec.d, 9) + 1.2);
        const pts = [];
        for (const [ss, tt] of [[s - half, tOut], [s - half, tIn2], [s + half, tIn2], [s + half, tOut]]) {
          const p = street.xz(ss, tt);
          pts.push([p[0], pad.height(ss, tt), p[1]]);
        }
        fenceRun(B, M, pts, { h: 1.06, rails: 2, spacing: 2.1, col: [0.74, 0.70, 0.62] });
      }
      void wear;
      void out;
    }

    /* --- wagons parked at an angle in the roadway.
     * One of them sits deliberately close to the `town` viewpoint: without a
     * near object the shot opens on twenty metres of empty road and the whole
     * frame loses its depth cue.                                             */
    const wagons = [
      [-street.len * 0.5 + 26 + rand() * 6, -6.4, 0.55, [0.62, 0.54, 0.43]],
      [-14 + rand() * 8, -3.4, -0.42, [0.58, 0.50, 0.40]],
      [42 + rand() * 12, 5.0, -0.5, [0.54, 0.44, 0.34]],
      /* Foreground anchor. Without a near object the shot opens on twenty
         metres of empty road and the whole frame loses its depth cue — the
         right-hand approach was exactly that. */
      [-street.len * 0.5 + 9 + rand() * 3, 7.1, -0.62, [0.58, 0.50, 0.40]],
    ];
    for (const [ws, wt, wrot, wcol] of wagons) {
      const wp = street.xz(ws, wt);
      const wy = pad.height(ws, wt);
      const tg = street.tangent(ws);
      const wa = Math.atan2(tg[1], tg[0]) + wrot;
      buckboard(B, M, new Frame(wp[0], wy, wp[1], Math.cos(wa), Math.sin(wa)), { col: wcol });
    }

    /* --- gravel worked out of the street ---------------------------------
     * The pass-2 report: "Foreground ground texture is a single low-res tiled
     * diffuse, visibly blurred by the time it reaches the bottom of the frame …
     * no parallax, no tessellation, no scattered pebble meshes, no decals."
     * A tiling albedo cannot survive at 1 m from the lens; only geometry can.
     * These are clustered along the ruts and the verges where traffic actually
     * turns stones up, not sprayed evenly, and they thin out fast with
     * chainage so the cost lands where the camera is.                        */
    {
      const spots = [];
      const push = (ss, tt, r, v) => {
        const p = street.xz(ss, tt);
        spots.push({ x: p[0], y: pad.height(ss, tt) + r * 0.28, z: p[1], r, v });
      };
      const s0 = -street.len * 0.5 + 2;
      for (let i = 0; i < 55; i++) {
        // bias toward the near approach: u^2 keeps two thirds inside 25 m
        const u = rand() * rand();
        const ss = s0 + u * 118;
        // cluster on the rut shoulders and the verges
        const band = rand();
        let tt;
        if (band < 0.42) tt = (rand() < 0.5 ? -1 : 1) * (1.2 + rand() * 7.2);
        else if (band < 0.78) tt = (rand() < 0.5 ? -1 : 1) * (5.8 + rand() * 4.2);
        else tt = (rand() - 0.5) * 26;
        const big = rand() < 0.09;
        /* BIGGER, FEWER, PALER than pass 9, and bisected to prove it.
         * Pass 9 laid 230 stones of 2-5 cm along the two rut shoulders. At
         * 25-40 m each is a sub-pixel dot that resolves to its own shadow, and
         * a line of them reads as a black chain drawn down the street — the
         * loudest artifact in the near ground, confirmed by hiding this one
         * bucket and watching the band disappear. Nothing below ~5 cm survives
         * this camera, so nothing below 5 cm is drawn. */
        push(ss, tt, big ? 0.105 + rand() * 0.075 : 0.055 + rand() * 0.045,
          1.16 + rand() * 0.55);
      }
      // a few cobbles kicked up against the boardwalk skirts
      for (let i = 0; i < 18; i++) {
        const ss = s0 + rand() * 120;
        const tt = (rand() < 0.5 ? -1 : 1) * (8.6 + rand() * 1.1);
        push(ss, tt, 0.065 + rand() * 0.075, 1.05 + rand() * 0.4);
      }
      pebbleField(B, M, spots);
    }

    /* --- foreground furniture at the near approach ------------------------
     * "Near" means near the `town` viewpoint, which pass 10 moved seventeen
     * metres INTO the row so the two facades flank the frame. This cluster
     * moved with it; left where it was it would have sat behind the lens. */
    {
      const s0 = -street.len * 0.5 + 20;
      const F = frame(s0 + 3, 7.2);
      hitchRail(B, M, F, 6.2, { seed: 2.1, wear: [F.oy, F.oy + 1.3, 0.94, 0.2] });
      const TF = frame(s0 - 2.5, 7.0, 0.06);
      trough(B, M, TF, { len: 2.6, wear: [TF.oy, TF.oy + 1.0, 0.96, 0.15] });
      for (let i = 0; i < 4; i++) {
        const ss = s0 - 4 + rand() * 12;
        const tt = -7.4 - rand() * 1.6;
        const p = street.xz(ss, tt);
        const y = pad.height(ss, tt);
        barrel(B, M, new Frame(p[0], y, p[1], 1, 0), {
          h: 0.76 + rand() * 0.18, r: 0.28,
          tilt: rand() < 0.35 ? 1.45 : 0, seed: rand() * 6,
          col: [0.60 + rand() * 0.2, 0.52 + rand() * 0.16, 0.41 + rand() * 0.12],
          wear: [y, y + 1.1, 0.92, 0.25],
        });
      }
      for (let i = 0; i < 3; i++) {
        const ss = s0 + 1 + rand() * 10;
        const tt = 8.0 + rand() * 1.2;
        const p = street.xz(ss, tt);
        const y = pad.height(ss, tt);
        const sz = 0.48 + rand() * 0.2;
        const a = rand() * TAU;
        crate(B, M, new Frame(p[0], y, p[1], Math.cos(a), Math.sin(a)), {
          size: sz, d: sz * 0.9, h: sz * 0.86,
          col: [0.76 + rand() * 0.14, 0.66 + rand() * 0.12, 0.51 + rand() * 0.1],
          wear: [y, y + 1.0, 0.88, 0.3],
        });
      }
    }
  }

  /* -------------------------------------------------------------- clutter */

  /**
   * Everything a working street accumulates, PILED WHERE PEOPLE PUT IT.
   *
   * The A/B against real gameplay did not say "add props" — we already had
   * barrels and crates. It said the reference has them *stacked against every
   * wall, beside every door, under every awning*, and ours were one-per-lot and
   * evenly spaced, which is the pass-3 "confetti, no massing" defect wearing a
   * different hat. So placement here is anchored: a cluster hugs the wall line
   * on one side of the door and a second smaller one on the other, a third gets
   * dumped in the street at the foot of the steps where a wagon unloaded it,
   * and a handful of walls get a ladder, a stack of offcuts or a broom.
   *
   * Every item lands in the existing merged buckets: zero new draw calls.
   */
  _clutter(B, street, pad, buildings, rand, FACADE, WALK_OUT, deckOff) {
    /** Frame on the deck at the wall face: +x along the street, +z toward the road. */
    const wallFrame = (s, side, tIn, y) => {
      const tg = street.tangent(s);
      const p = street.xz(s, side * tIn);
      return new Frame(p[0], y, p[1], -side * tg[0], -side * tg[1]);
    };

    for (const b of buildings) {
      const { spec, side, s, tFace } = b;
      const onWalk = !spec.setback;
      const deck = pad.height(s, side * (WALK_OUT + 0.9)) + deckOff;
      const wallT = tFace - 0.14;

      if (onWalk) {
        /* two piles flanking the door, the bigger one on the side the shot
           actually sees, plus a third against the far end of the frontage */
        const halves = [
          { off: -spec.w * (0.20 + rand() * 0.12), n: 4 + ((rand() * 4) | 0), span: 2.0 + rand() * 1.4 },
          { off: spec.w * (0.20 + rand() * 0.14), n: 2 + ((rand() * 4) | 0), span: 1.5 + rand() * 1.2 },
        ];
        if (rand() < 0.55) {
          halves.push({ off: spec.w * (rand() < 0.5 ? -0.42 : 0.42), n: 2 + ((rand() * 3) | 0), span: 1.3 });
        }
        for (const hcfg of halves) {
          const F = wallFrame(s + hcfg.off, side, wallT, deck);
          goodsPile(B, M, F, rand, { n: hcfg.n, span: hcfg.span, grime: 0.86 });
        }
        /* something tall against the wall so the pile has a vertical note */
        const r = rand();
        const TF = wallFrame(s + (rand() - 0.5) * spec.w * 0.6, side, wallT - 0.02, deck);
        if (r < 0.30) ladder(B, M, TF, { len: Math.min(spec.h - 0.4, 3.4), lean: 0.13 + rand() * 0.06 });
        else if (r < 0.62) boardLean(B, M, TF, { n: 3 + ((rand() * 3) | 0) });
        else if (r < 0.86) {
          tool(B, M, TF, { kind: (rand() * 3) | 0, len: 1.3 + rand() * 0.4, lean: 0.11 + rand() * 0.06 });
        }
        /* goods dumped in the ROAD at the foot of the walk — a delivery that
           has not been carried in yet. This is the band the camera actually
           lives in, and it was completely empty. */
        if (rand() < 0.7) {
          const ss = s + (rand() - 0.5) * spec.w * 0.7;
          const tt = side * (WALK_OUT - 0.5 - rand() * 1.4);
          const gy = pad.height(ss, tt);
          const GF = wallFrame(ss, side, Math.abs(tt), gy);
          goodsPile(B, M, GF, rand, { n: 2 + ((rand() * 3) | 0), span: 1.4, grime: 0.95 });
        }
      } else {
        /* setback lots (church, barn, livery) get a yard pile instead */
        const gy = pad.height(s, side * (tFace - 1.0));
        const F = wallFrame(s + (rand() - 0.5) * spec.w * 0.5, side, tFace - 1.0, gy);
        goodsPile(B, M, F, rand, { n: 3 + ((rand() * 3) | 0), span: 2.2, grime: 0.95 });
      }
    }

    /* --- awnings and posted bills ----------------------------------------
     * Both are LAYERING. The A/B verdict on our facades was that every one of
     * them sat in the same sunlit midtone with a single sign on it, against a
     * reference street of painted wall signs, hanging shingles, window
     * lettering and pasted bills three deep. An awning adds the dark band the
     * row has no other way of getting; a bill adds a second scale of legible
     * detail between the signboard and the grain. */
    for (const b of buildings) {
      const { spec } = b;
      const F = b.F;                       // origin at floor level, +z into the lot
      const wear = [spec.groundY - 0.05, spec.floorY + spec.h + 1.0, spec.grime, spec.chalk];
      const clear = !spec.porch && !spec.balcony && !spec.special && spec.falseFront;
      if (clear && spec.w > 6.5 && rand() < 0.85) {
        const pal = [
          [[0.80, 0.74, 0.62], [0.50, 0.38, 0.32]],
          [[0.76, 0.72, 0.64], [0.40, 0.44, 0.42]],
          [[0.84, 0.78, 0.62], [0.62, 0.52, 0.34]],
        ][(rand() * 3) | 0];
        awning(B, M, F, {
          w: Math.min(spec.w * 0.82, 6.4),
          depth: 1.85 + rand() * 0.55,
          yWall: 3.00 + rand() * 0.22,
          yOut: 2.48 + rand() * 0.16,
          stripe: pal, wear,
        });
      }
      const bills = this.signRects && this.signRects.__bills;
      if (bills && bills.length) {
        const n = 1 + ((rand() * 3) | 0);
        for (let i = 0; i < n; i++) {
          const key = bills[(rand() * bills.length) | 0];
          const rect = this.signRects[key];
          if (!rect) continue;
          const hh = 0.40 + rand() * 0.22;
          const ww = hh * (rect.ratio || 0.72);
          postedBill(B, M, F, {
            x: (rand() - 0.5) * Math.max(1.2, spec.w - 2.2),
            y: 1.35 + rand() * 0.95,
            w: ww, h: hh, z: (spec.falseFront ? -0.335 : -0.075) - 0.006,
            uv: rect, wear, tilt: (rand() - 0.5) * 0.14,
          });
        }
      }
    }

    /* --- laundry strung across the gaps between buildings ----------------
     * Cloth is the one prop in the vocabulary that is bright, soft-edged and
     * MOVES against a street of hard timber, which is why every reference frame
     * of an inhabited street has some. Two lines, in the two widest gaps that
     * are not already occupied by the water tower or the windmill. */
    for (const side of [-1, +1]) {
      const gaps = (this._gaps && this._gaps[side]) || [];
      const sorted = gaps.slice().sort((a, b) => b.w - a.w);
      // index 1 and 2: the widest is where the tower/mill went
      for (const g of sorted.slice(1, 3)) {
        if (g.w < 3.0) continue;
        const y0 = pad.height(g.s0 + 0.4, side * (FACADE - 0.6)) + 2.55 + rand() * 0.5;
        const y1 = pad.height(g.s1 - 0.4, side * (FACADE - 0.6)) + 2.45 + rand() * 0.5;
        const a = street.xz(g.s0 + 0.4, side * (FACADE - 0.6));
        const c = street.xz(g.s1 - 0.4, side * (FACADE - 0.6));
        laundryLine(B, M, [a[0], y0, a[1]], [c[0], y1, c[1]], {
          rand, sag: 0.24 + rand() * 0.16, count: 3 + ((rand() * 3) | 0),
        });
      }
    }

    /* --- a town pump and its permanent wet patch, on the near approach --- */
    {
      const s0 = -street.len * 0.5 + 20;
      const ss = s0 + 6 + rand() * 5, tt = 7.6;
      const p = street.xz(ss, tt);
      const y = pad.height(ss, tt);
      const tg = street.tangent(ss);
      waterPump(B, M, new Frame(p[0], y, p[1], -tg[0], -tg[1]));
      for (let i = 0; i < 3; i++) {
        const a = rand() * Math.PI * 2;
        const q = street.xz(ss + Math.cos(a) * 0.9, tt + Math.sin(a) * 0.7);
        bucket(B, M, new Frame(q[0], pad.height(ss + Math.cos(a) * 0.9, tt + Math.sin(a) * 0.7), q[1],
          Math.cos(a), Math.sin(a)), { r: 0.14, h: 0.28, water: rand() < 0.6 });
      }
      /* feed sacks stacked at the near kerb, right where the lens is */
      for (let i = 0; i < 5; i++) {
        const sq = s0 + 1 + rand() * 7;
        const tq = -7.9 - rand() * 1.3;
        const q = street.xz(sq, tq);
        const a = rand() * Math.PI * 2;
        sack(B, M, new Frame(q[0], pad.height(sq, tq), q[1], Math.cos(a), Math.sin(a)), {
          h: 0.40 + rand() * 0.17, r: 0.19 + rand() * 0.05,
          lean: (rand() - 0.5) * 0.8, seed: rand() * 6,
          col: [0.50 + rand() * 0.20, 0.45 + rand() * 0.16, 0.35 + rand() * 0.12],
        });
      }
    }
  }

  /* --------------------------------------------------------- standing water */

  /**
   * Puddles down the wheel ruts. See Clutter.buildPuddles for why these are a
   * separate transparent sheet rather than a shading trick on the road: a wet
   * surface is defined by its SPECULAR response, and the road material is a
   * 0.9-roughness dielectric that physically cannot produce one.
   *
   * One extra draw call for the whole street.
   */
  _puddles(street, pad, rand) {
    const spots = [];
    const RUTS = [-5.5, -2.3, 2.3, 5.5];
    const s0 = -street.len * 0.5 - 4;
    const span = street.len + 30;
    for (let i = 0; i < 22; i++) {
      /* u^1.6 keeps most of them in the near half, where a puddle is worth
         hundreds of pixels rather than four. */
      const u = Math.pow(rand(), 1.6);
      const s = s0 + u * span * 0.80;
      const rut = RUTS[(rand() * RUTS.length) | 0];
      const t = rut + (rand() - 0.5) * 3.2;
      const r = 0.40 + Math.pow(rand(), 1.3) * 1.15;
      spots.push({ s, t, r, y: pad.height(s, t) + 0.006 });
    }
    /* a broad sheet in the hollow by the trough and one by the pump */
    for (const [ss, tt, rr] of [[-street.len * 0.5 + 21, 6.2, 1.7], [-street.len * 0.5 + 27, 7.4, 1.4], [-street.len * 0.5 + 34, -6.0, 1.5]]) {
      spots.push({ s: ss, t: tt, r: rr, y: pad.height(ss, tt) + 0.008 });
    }
    const geo = buildPuddles(spots, (s, t) => pad.height(s, t), (s, t) => street.xz(s, t), rand);
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, this.mats.get('puddle'));
    mesh.name = 'town_puddle';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.rsNoShadow = true;
    mesh.renderOrder = 2;
    this.group.add(mesh);
    this.meshes.push(mesh);
    this._puddleMesh = mesh;
  }

  /* ------------------------------------------------------------------ folk */

  /**
   * Populate the street. See town/Folk.js for the rig; this is only the
   * casting and the blocking.
   *
   * Blocking rules, taken straight off the reference frames: people walk the
   * BOARDWALK far more than the road, they cross the road at a diagonal rather
   * than at right angles, they cluster in twos and threes rather than spacing
   * out, and at any instant a third of them are not moving at all — leaning on
   * a rail, standing in a doorway, sitting on a step, working a wagon. A street
   * where everybody walks at the same speed in a line reads worse than an
   * empty one.
   */
  _folk(street, pad, buildings, rand, proc, sky, L, FACADE, WALK_OUT, deckOff) {
    const agents = [];
    const deckAt = (s, side) => pad.height(s, side * (WALK_OUT + 0.9)) + deckOff;
    const SPEED = 1.12;

    const bake = (pts) => {
      let len = 0;
      for (let i = 1; i < pts.length; i++) {
        len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]);
      }
      return len;
    };

    const addWalker = (proto, sa, sb, tOf, yOf, o = {}) => {
      const n = Math.max(2, Math.round(Math.abs(sb - sa) / 3.0));
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const s = sa + ((sb - sa) * i) / n;
        const t = tOf(i / n);
        const p = street.xz(s, t);
        pts.push([p[0], yOf(s, t), p[1]]);
      }
      const len = bake(pts);
      const w = wardrobe(rand, !!o.woman);
      agents.push({
        proto, path: pts,
        duration: Math.max(2, len / SPEED),
        dwell: 2.0 + rand() * 4.0,
        tOffset: rand() * 60,
        speedScale: 0.88 + rand() * 0.26,
        walkRate: 0.78 + rand() * 0.18,
        gait: 0.85, phase: rand() * 6.283, legBias: 0,
        scale: (o.woman ? 0.955 : 1.0) * (0.955 + rand() * 0.09),
        yaw: 0, tilt: 0, roll: 0,
        coat: w.coat, trou: w.trou, hat: w.hat,
      });
    };

    const addStander = (proto, s, t, o = {}) => {
      const p = street.xz(s, t);
      const tg = street.tangent(s);
      const w = wardrobe(rand, !!o.woman);
      /* Face across the street by default (that is what someone standing on a
         boardwalk is doing), or along it if `along` is set. The figure's local
         +z is its forward, so yaw = atan2(dx, dz). */
      const nn = street.normalRaw(s);
      const sgn = t < 0 ? -1 : 1;
      const yaw = o.yaw != null ? o.yaw
        : (o.along ? Math.atan2(tg[0], tg[1]) : Math.atan2(-sgn * nn[0], -sgn * nn[1]));
      agents.push({
        proto, path: null,
        x: p[0], y: o.y != null ? o.y : pad.height(s, t), z: p[1],
        duration: 1, dwell: 1, tOffset: 0, speedScale: 1, walkRate: 0,
        gait: 0, phase: rand() * 6.283, legBias: o.legBias || 0,
        scale: (o.woman ? 0.955 : 1.0) * (0.955 + rand() * 0.09),
        yaw: yaw + (rand() - 0.5) * 0.5,
        tilt: o.tilt || 0, roll: o.roll || 0,
        coat: w.coat, trou: w.trou, hat: w.hat,
      });
    };

    const half = street.len * 0.5;

    /* --- boardwalk traffic, both sides ---------------------------------- */
    addWalker(0, -half - 4, half * 0.4, () => -10.5, (s) => deckAt(s, -1));
    addWalker(0, -half * 0.5, half * 0.9, () => -10.7, (s) => deckAt(s, -1));
    addWalker(1, -half * 0.2, half * 0.6, () => -10.4, (s) => deckAt(s, -1), { woman: true });
    addWalker(0, -half * 0.8, half * 0.3, () => 10.6, (s) => deckAt(s, 1));
    addWalker(1, -half * 0.1, half * 0.75, () => 10.5, (s) => deckAt(s, 1), { woman: true });
    addWalker(0, half * 0.1, half + 6, () => 10.6, (s) => deckAt(s, 1));

    /* --- crossing the road on the diagonal, which is what people do ------ */
    addWalker(0, -half * 0.62, -half * 0.18, (u) => -8.6 + u * 17.2, (s, t) => pad.height(s, t));
    addWalker(0, half * 0.34, half * 0.02, (u) => 8.6 - u * 17.4, (s, t) => pad.height(s, t));
    addWalker(1, -half * 0.05, half * 0.28, (u) => 8.4 - u * 16.8, (s, t) => pad.height(s, t),
      { woman: true });

    /* --- walking the road itself ---------------------------------------- */
    addWalker(0, -half - 12, half * 0.5, () => -4.4, (s, t) => pad.height(s, t));
    addWalker(0, half * 0.55, -half * 0.25, () => 3.6, (s, t) => pad.height(s, t));

    /* --- standing figures, anchored to something ------------------------- */
    /* pairs in conversation on the near boardwalk — a pair reads as a
       relationship, two lone figures read as decoration */
    addStander(0, -half + 14, -10.3, { y: deckAt(-half + 14, -1) });
    addStander(1, -half + 15.3, -10.9, { y: deckAt(-half + 15.3, -1), woman: true });
    addStander(0, -half * 0.15, 10.4, { y: deckAt(-half * 0.15, 1) });
    addStander(0, -half * 0.15 + 1.2, 10.9, { y: deckAt(-half * 0.15 + 1.2, 1) });

    /* leaning on the hitching rails out in the road */
    for (const b of buildings) {
      if (!b.spec.hitch || rand() < 0.55) continue;
      const t = b.side * 6.15;
      addStander(0, b.s + (rand() - 0.5) * 2.0, t + b.side * 0.55, { along: true, roll: b.side * 0.10 });
    }

    /* sitting on the edge of the boardwalk, legs out over the road */
    for (const side of [-1, 1]) {
      const s = (rand() - 0.5) * street.len * 0.55;
      addStander(0, s, side * (WALK_OUT - 0.10), {
        y: deckAt(s, side) - 0.36, legBias: -1.42,
      });
    }

    /* working the parked wagons */
    addStander(0, -14 + rand() * 6, -5.0, { along: true });
    addStander(0, -street.len * 0.5 + 9, -7.4, { along: true });

    /* --- the near field ---------------------------------------------------
     * The `town` viewpoint stands at s = -half + 17, so this band is the one
     * that carries the shot: figures here are 60-140 px tall and are what makes
     * the street read as inhabited rather than as an establishing plate. Two
     * groups, not six evenly-spaced singles. */
    addStander(0, -half + 24.5, -10.4, { y: deckAt(-half + 24.5, -1) });
    addStander(1, -half + 25.6, -11.0, { y: deckAt(-half + 25.6, -1), woman: true });
    addStander(0, -half + 23.6, -11.2, { y: deckAt(-half + 23.6, -1), along: true });
    addWalker(0, -half + 20, -half + 46, () => -10.6, (s) => deckAt(s, -1));
    addWalker(1, -half + 44, -half + 16, () => -10.2, (s) => deckAt(s, -1), { woman: true });
    addWalker(0, -half + 18, -half + 40, (u) => -8.0 + u * 15.0, (s, t) => pad.height(s, t));
    addStander(0, -half + 30, 9.9, { y: deckAt(-half + 30, 1), along: true });
    addStander(0, -half + 31.4, 10.8, { y: deckAt(-half + 31.4, 1) });

    /* far end of the street, for depth: two small figures against the church */
    addStander(0, half * 0.72, -6.2, { along: true });
    addStander(1, half * 0.80, 5.4, { along: true, woman: true });

    const ctx = this.ctx;
    const W = ctx.world;
    this.folk = new Folk().build({
      proc, sky, lighting: L, rand, agents,
      physics: ctx.get('physics'),
      /* The escape paths are sampled against the published height query, so a
         figure that runs off a boardwalk ends up on the street rather than
         floating where the deck used to be. */
      heightAt: (x, z) => (W && W.ready ? W.getHeight(x, z) : 0),
      emit: (name, payload) => ctx.emit(name, payload),
    });
    this.ctx.scene.add(this.folk.group);
    if (L && typeof L.requestShadowCaster === 'function') {
      for (const m of this.folk.meshes) L.requestShadowCaster(m);
    }

    /* A rifle going off in a street full of people has to mean something. The
     * same event Wildlife listens to empties the boardwalk. */
    if (!this._gunHook) {
      this._gunHook = (e) => {
        if (!this.folk) return;
        const p = (e && e.position) || ctx.player.position;
        const loud = (e && e.loudness) || 1;
        this.folk.alarm(p, 62 * loud, 1);
      };
      ctx.on('gunshot', this._gunHook);
    }
    void FACADE;
  }

  /* ------------------------------------------------------------ landmarks */

  _landmarks(B, street, pad, rand, len) {
    /* --- telegraph line down the left-hand kerb --------------------------
     * At |t| = 12.6 the poles stood 0.6 m BEHIND the facade line, i.e. inside
     * the buildings. They belong just off the boardwalk edge (|t| = 9.2), in
     * the roadway, where they also read against the sky.                    */
    const poles = [];
    const t = -8.75;
    for (let s = -len * 0.5 - 26; s <= len * 0.5 + 30; s += 27 + rand() * 3) {
      const p = street.xz(s, t + (rand() - 0.5) * 1.2);
      const y = pad.height(s, t);
      const tg = street.tangent(s);
      const F = new Frame(p[0], y, p[1], tg[0], tg[1]);
      const ties = telegraphPole(B, M, F, {
        h: 7.2 + rand() * 1.0, lean: (rand() - 0.5) * 0.35, arm: 1.1 + rand() * 0.2,
      });
      poles.push(ties);
    }
    for (let i = 0; i < poles.length - 1; i++) {
      const a = poles[i], b = poles[i + 1];
      const span = Math.hypot(b[0][0] - a[0][0], b[0][2] - a[0][2]);
      const sag = 0.35 + span * 0.022;
      wire(B, M, a[0], b[0], { sag, segs: 8, r: 0.016 });
      wire(B, M, a[1], b[1], { sag: sag * 1.06, segs: 8, r: 0.016 });
    }

    /* --- water tower & windmill, dropped into the two widest gaps in the
     * frontage so they stand ON the street line and actually break the
     * horizon instead of hiding behind a roof.                             */
    const widest = (side) => {
      const g = (this._gaps && this._gaps[side]) || [];
      let best = null;
      for (const q of g) if (!best || q.w > best.w) best = q;
      return best;
    };
    {
      const g = widest(1);
      const s = g ? (g.s0 + g.s1) * 0.5 : -len * 0.34;
      const t = 15.5;
      const p = street.xz(s, t);
      const y = pad.height(s, t);
      const F = new Frame(p[0], y, p[1], 1, 0);
      waterTower(B, M, F, { legH: 6.8 + rand() * 0.6, tankR: 2.2, tankH: 3.3, spread: 2.7 });
    }
    {
      const g = widest(-1);
      const s = g ? (g.s0 + g.s1) * 0.5 : len * 0.30;
      const t = -15.8;
      const p = street.xz(s, t);
      const y = pad.height(s, t);
      const a = rand() * TAU;
      const F = new Frame(p[0], y, p[1], Math.cos(a), Math.sin(a));
      const r = windmill(B, M, F, M.rotor, { legH: 7.8 + rand() * 0.8 });
      this._rotorHub = r.hub;
      // the rotor disc spans (F.ax, up); its spin axis is the frame's OTHER
      // horizontal axis, not the one Props returns.
      this.rotorAxis.set(F.bx, 0, F.bz).normalize();
    }

    /* --- stock corrals at both ends. They flank the road rather than cross
     * it: a rail across the near end lands 1.5 m from the `town` POI lens and
     * reads as a bug, not as a foreground element.                          */
    for (const [s0, s1, t0, t1] of [
      [len * 0.5 + 8, len * 0.5 + 34, 15, 34],
      [len * 0.5 + 12, len * 0.5 + 30, -34, -16],
      [-len * 0.5 - 34, -len * 0.5 - 10, 16, 33],
    ]) {
      const pts = [];
      for (const [ss, tt] of [[s0, t0], [s0, t1], [s1, t1], [s1, t0]]) {
        const p = street.xz(ss, tt);
        pts.push([p[0], pad.height(ss, tt), p[1]]);
      }
      fenceRun(B, M, pts, { h: 1.28 + rand() * 0.1, rails: 3, spacing: 2.4 + rand() * 0.5 });
    }
  }

  /* ----------------------------------------------------------------- camp */

  _camp(CB, rand, H) {
    const ctx = this.ctx;
    const poi = ctx.poi.get('camp_fire');
    if (!poi) return null;
    const p = poi.pos ? poi.pos : poi;
    const groundY = ctx.world.ready ? ctx.world.getHeight(p.x, p.z) : p.y;
    const res = buildCampfire(CB, M, {
      pos: { x: p.x, z: p.z },
      rand,
      groundY,
      sample: (x, z) => H(x, z),
    });
    return { pos: new THREE.Vector3(p.x, groundY, p.z), ashGeometry: res.ashGeometry };
  }

  _campLights(info, L, rand) {
    if (!info) return;
    const ctx = this.ctx;
    const flames = makeFlames(rand() * 40);
    flames.group.position.copy(info.pos);
    flames.group.position.y += 0.10;
    ctx.scene.add(flames.group);
    this.flames = flames;

    if (L && typeof L.addFireLight === 'function') {
      // A campfire IS the key light of night_camp, so it is authored to read
      // as one: 3 linear at a metre, 24 m of inverse-square reach. The pass-1
      // failure was a blown *emissive*, not a bright light — intensity is the
      // knob, colour stays pinned to the 1980 K blackbody.
      /* Pass 3: 4.5 put the ring stones at >1.0 after the night meter (~12x)
       * even on a 0.22 albedo, which is exactly the "blown-out WHITE faceted
       * plastic lumps" the forensic pass named. The pool still has to read as
       * the key light of the shot, so the drop is in radiance, not reach. */
      this.fire = L.addFireLight(info.pos, {
        radius: 22, intensity: 1.5, height: 0.36, flicker: 0.58,
        kelvin: 1980, soot: 0.16, importance: 9, shadow: true,
      });
    } else if (L && typeof L.addLight === 'function') {
      const pl = new THREE.PointLight(0xffffff, 1.4, 26, 2);
      pl.position.set(info.pos.x, info.pos.y + 0.34, info.pos.z);
      ctx.scene.add(pl);
      L.addLight(pl, { fire: true, flicker: 0.58, radius: 26, importance: 8, shadow: true });
      this.fireLight = pl;
    }

    /* NO particle emitters at the camp fire any more.
     *
     * Pass 2 used them and both came back as named tells: the ember emitter as
     * "four embers … the same size, same brightness, same soft radial falloff,
     * in a near-perfect vertical line at even spacing", and the smoke emitter
     * as "a solid opaque near-black cauliflower mass with a hard silhouette …
     * it reads as a boulder suspended in mid-air" (logged as a pass-2
     * REGRESSION). Both are now authored in Campfire.makeFlames: a 96-point GPU
     * spark field with 3:1 size spread and per-ember turbulence, and a three-
     * layer scrolling-noise plume whose base is lit by the fire and whose alpha
     * never exceeds 0.2. Chimney smoke still uses the particle system, where it
     * is small, distant and reads correctly. */
  }

  /* --------------------------------------------------------- window glow */

  /**
   * Warm halo quads over lit windows and lantern globes. Additive, authored in
   * linear HDR well under the filmic shoulder, and faded entirely out in
   * daylight from ctx.env.daylight. One instanced draw for the whole town.
   */
  _buildGlow(glowPts, lampPts, sky) {
    const pts = [];
    for (const p of glowPts) pts.push({ p, s: 1.7, k: 0.5 });
    for (const p of lampPts) {
      pts.push({ p, s: 1.0, k: 1.0 });
      this._lamps.push(p);
    }
    if (!pts.length) return;

    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 } },
      vertexShader: /* glsl */`
        attribute float aScale;
        attribute float aK;
        varying vec2 vUv;
        varying float vK;
        void main() {
          vUv = uv;
          vK = aK;
          vec3 c = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
          vec3 f = normalize( cameraPosition - c );
          vec3 rt = normalize( cross( vec3( 0.0, 1.0, 0.0 ), f ) );
          vec3 up = cross( f, rt );
          vec3 wp = c + ( rt * position.x + up * position.y ) * aScale;
          gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uOpacity;
        varying vec2 vUv;
        varying float vK;
        void main() {
          vec2 d = vUv * 2.0 - 1.0;
          float r = length( d );
          if ( r > 1.0 ) discard;
          float a = pow( 1.0 - r, 2.6 );
          // 2000 K-ish halo. Linear HDR, deliberately below the shoulder so the
          // bloom stays orange instead of clipping to white.
          vec3 col = vec3( 1.00, 0.455, 0.135 );
          gl_FragColor = vec4( col * a * uOpacity * vK, a * uOpacity * vK );
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    mat.userData.rsNoAerial = true;
    const inst = new THREE.InstancedMesh(geo, mat, pts.length);
    const scales = new Float32Array(pts.length);
    const ks = new Float32Array(pts.length);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i];
      m4.makeTranslation(q.p[0], q.p[1], q.p[2]);
      inst.setMatrixAt(i, m4);
      scales[i] = q.s;
      ks[i] = q.k;
    }
    geo.setAttribute('aScale', new THREE.InstancedBufferAttribute(scales, 1));
    geo.setAttribute('aK', new THREE.InstancedBufferAttribute(ks, 1));
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = false;
    inst.renderOrder = 6;
    inst.castShadow = false;
    inst.userData.rsNoAerial = true;
    this.group.add(inst);
    this._glow = inst;
    this._glowMat = mat;
    void sky;
  }

  /* -------------------------------------------------------- local lights */

  _townLights(lamps, L, rand) {
    if (!L || typeof L.addLight !== 'function') return;
    // A handful of the porch lanterns become real lights; the rest are only
    // geometry + halo. LocalLights budgets them by distance/importance.
    const picks = [];
    for (let i = 0; i < lamps.length; i++) if (i % 2 === 0) picks.push(lamps[i]);
    for (const l of picks.slice(0, 12)) {
      const pl = new THREE.PointLight(0xffffff, 0.0, 17, 2);
      pl.color.setRGB(1.0, 0.50, 0.19);
      pl.position.set(l[0], l[1], l[2]);
      this.ctx.scene.add(pl);
      L.addLight(pl, { raw: true, flicker: 0.16, radius: 17, importance: 2, shadow: false });
      this._lampLights = this._lampLights || [];
      this._lampLights.push({ light: pl, base: 0.55 + rand() * 0.25 });
    }
  }

  /* ------------------------------------------------------------------ POI */

  _registerPOIs(street, pad, len, campInfo) {
    const ctx = this.ctx;
    const V = (x, y, z) => new THREE.Vector3(x, y, z);

    /* The shot is framed DOWN the length of the street: stand on the near
     * approach a little off the crown so the two rows rake away at different
     * rates, and aim at a point above the far end so the road takes the lower
     * third rather than half the frame. */
    /* PASS 10. The old pose stood 11 m back from the end of the frontage at an
     * eye height of 2.35 m, and the result was that the bottom HALF of the shot
     * was bare graded dust: seventeen metres of empty approach before the first
     * building, seen from above head height. Standing where a person actually
     * would — 1.8 m, six metres off the end of the row and closer to the
     * left-hand kerb — puts the boardwalk, its goods piles and the near
     * furniture into the lower third instead of nothing at all, and drops the
     * road's share of the frame by about a fifth. */
    const sNear = -len * 0.5 - 2;
    const sFar = len * 0.5 + 6;
    const a = street.xz(sNear, -6.2);
    const b = street.xz(sFar, 2.2);
    const ya = pad.height(sNear, -6.2);
    const yb = pad.height(sFar, 2.2);
    ctx.poi.set('town', { pos: V(a[0], ya + 1.74, a[1]), look: V(b[0], yb + 6.0, b[1]) });
    /* The harness aims `town_street` at town_end's POSITION, so this height is
     * the shot's pitch control: at eye level the horizon lands dead centre and
     * the road takes the whole bottom half of the frame. */
    ctx.poi.set('town_end', { pos: V(b[0], yb + 4.5, b[1]), look: V(a[0], ya + 4.2, a[1]) });

    const cs = street.xz(0, 0);
    ctx.poi.set('town_center', { pos: V(cs[0], pad.height(0, 0) + 1.8, cs[1]) });

    if (campInfo) {
      const p = campInfo.pos;
      // Look slightly down-street at the fire from a couple of metres back so
      // the ring, the bedroll and the pot are all in frame.
      const d = new THREE.Vector3(0.82, 0, 0.57).normalize();
      const camX = p.x - d.x * 3.4, camZ = p.z - d.z * 3.4;
      const gy = ctx.world.ready ? ctx.world.getHeight(camX, camZ) : p.y;
      ctx.poi.set('camp', { pos: V(camX, gy + 1.35, camZ), look: V(p.x, p.y + 0.55, p.z) });
      ctx.poi.set('camp_fire', { pos: V(p.x, p.y + 0.45, p.z), look: V(p.x, p.y, p.z) });
    }
  }

  /* --------------------------------------------------------------- update */

  update(dt) {
    const ctx = this.ctx;
    this._t += dt;
    const env = ctx.env;
    const night = Math.min(1, Math.max(0, 1 - (env.daylight != null ? env.daylight : 1) * 1.55));

    /* flames ------------------------------------------------------------- */
    if (this.flames) {
      const w = env.windVector;
      const f = this.fire && this.fire.flicker != null ? this.fire.flicker : 0.5;
      for (const m of this.flames.mats) {
        m.uniforms.uTime.value = this._t * (m.userData.speed || 1);
        m.uniforms.uWind.value.set(w ? w.x * 0.06 : 0, 0, w ? w.z * 0.06 : 0);
        m.uniforms.uFlick.value = f;
      }
      this.flames.ember.uniforms.uTime.value = this._t;
      this.flames.ember.uniforms.uFlick.value = f;
      if (this.flames.spark) {
        const su = this.flames.spark.uniforms;
        su.uTime.value = this._t;
        su.uFlick.value = f;
        su.uWind.value.set(w ? w.x * 0.10 : 0, 0, w ? w.z * 0.10 : 0);
        /* Embers are sized in metres, so the point sprite needs the real
         * projection scale: drawbuffer height / (2 tan(fov/2)) pixels per metre
         * at one metre of depth. Resolution- and FOV-independent. */
        const cam = ctx.camera;
        const rend = ctx.renderer;
        if (cam && rend) {
          const hpx = (rend.getDrawingBufferSize
            ? rend.getDrawingBufferSize(_dbSize).y
            : rend.domElement.height) || 900;
          const fov = (cam.fov || 50) * Math.PI / 180;
          su.uPxPerM.value = hpx / (2 * Math.tan(fov * 0.5));
        }
      }
      if (this.flames.smoke) {
        /* The plume is tinted toward whatever the sky is actually doing, so it
         * never floats as a black cut-out the way the pass-2 particle smoke
         * did; it only ever sits a little darker than its background. */
        const amb = env.ambientColor;
        const ai = (env.ambientIntensity != null ? env.ambientIntensity : 0.6);
        for (let i = 0; i < this.flames.smoke.length; i++) {
          const u = this.flames.smoke[i].uniforms;
          u.uTime.value = this._t * (0.8 + i * 0.17);
          u.uFlick.value = f;
          u.uOpacity.value = 0.055 + 0.045 * (1 - night * 0.35);
          u.uWind.value.set(w ? w.x * 0.055 : 0, 0, w ? w.z * 0.055 : 0);
          if (amb) u.uSky.value.setRGB(amb.r * ai * 0.22, amb.g * ai * 0.22, amb.b * ai * 0.24);
        }
      }
    }

    /* thin-member LOD ------------------------------------------------------
     * Sub-pixel rails and wire are the single largest source of the
     * high-frequency speckle the forensic pass measured (per-pixel delta std
     * 21.9 in the detail layer vs 1.0 in the sky). Past the distance at which a
     * member is half a pixel wide it contributes nothing but aliasing.      */
    if (this._thin && this._thin.length) {
      const cam = ctx.camera;
      if (cam) {
        for (const m of this._thin) {
          const bs = m.geometry.boundingSphere;
          if (!bs) continue;
          const d = cam.position.distanceTo(bs.center) - bs.radius;
          m.visible = d < THIN_CULL;
        }
      }
    }

    /* standing water: the sky it reflects moves with the hour ------------- */
    {
      const pm = this.mats.get('puddle');
      if (pm && env.ambientColor) {
        const ai = env.ambientIntensity != null ? env.ambientIntensity : 0.6;
        pm.emissive.copy(env.ambientColor).multiplyScalar(ai * 4.0);
      }
    }

    /* the folk ------------------------------------------------------------
     * ~24 Matrix4.compose calls against pre-baked paths. The walk cycle itself
     * is in the vertex shader, so this costs nothing measurable, and when the
     * camera is not in the town every mesh drops to count 0. */
    if (this.folk) this.folk.update(dt, ctx.camera ? ctx.camera.position : null);

    /* windmill ------------------------------------------------------------ */
    if (this.rotor) {
      const ws = (env.windStrength != null ? env.windStrength : 3) * 0.34 + 0.55;
      this.rotorAngle += dt * ws;
      this.rotor.setRotationFromAxisAngle(this.rotorAxis, this.rotorAngle);
    }

    /* dusk lighting -------------------------------------------------------- */
    const target = night;
    if (this._glowMat) this._glowMat.uniforms.uOpacity.value = target * 0.55;
    for (const m of this._litMats) m.emissiveIntensity = target * 0.42;
    if (this._lampLights) {
      for (const l of this._lampLights) l.light.intensity = target * l.base;
    }

    /* chimney smoke ------------------------------------------------------- */
    if (!this._smokeStarted && this._smoke && this._smoke.length) {
      const PT = ctx.get('particles');
      if (PT && typeof PT.emitter === 'function') {
        for (const s of this._smoke) {
          this._emitters.push(PT.emitter('smoke', {
            position: new THREE.Vector3(s.p[0], s.p[1] + 0.3, s.p[2]),
            rate: 1.2 * (0.5 + s.strength), scale: 0.7, radius: 0.14,
          }));
        }
      }
      this._smokeStarted = true;
    }
  }

  resize() {}

  /* ------------------------------------------------------------ NPC contract
   * Published for the hit-feedback / wanted system. Deliberately the same
   * shapes as `Wildlife.raycastAnimals` / `Wildlife.applyHit`, so a caller
   * that already resolves a shot against animals adds two lines, not a branch.
   *
   *   const npc = town.raycastNPC(origin, dir, maxDist);   // → hit | null
   *   const res = town.applyNPCHit(npc, 1);                // → { killed, part,
   *                                                        //     position,
   *                                                        //     witnessed,
   *                                                        //     witnesses }
   *   town.killNPC(agentOrIndex, fromPoint);               // no damage model
   *   town.npcAlarm(position, radius, intensity);          // scatter them
   *   ctx.on('npcKilled', ({ position, witnessed, witnesses, agent }) => …)
   */
  raycastNPC(origin, dir, maxDist = 400) {
    return this.folk ? this.folk.raycastNPC(origin, dir, maxDist) : null;
  }

  applyNPCHit(hit, damage = 1) {
    return this.folk ? this.folk.applyNPCHit(hit, damage) : null;
  }

  killNPC(agentOrIndex, from) {
    return this.folk ? this.folk.killNPC(agentOrIndex, from) : null;
  }

  npcAlarm(position, radius = 55, intensity = 1) {
    if (this.folk) this.folk.alarm(position, radius, intensity);
  }

  /* ---------------------------------------------------------- the seam
   * THE LAW LOOKS FOR THESE NAMES, NOT THE ONES ABOVE.
   *
   * `Wanted._folkApi()` probes for an NPC hit API by name and defers to it if
   * it finds one, otherwise it drives the agents itself. It probes
   * `raycastNpc` / `applyNpcHit` — camel case — and the names published above
   * are `raycastNPC` / `applyNPCHit`. JavaScript is case sensitive, so the
   * probe missed by one letter and the whole Folk death path was unreachable:
   * measured, a killed townsman kept `a.dead === 0`, which meant
   *
   *   · `Folk.alarm()` and `Folk._think()` (both guarded on `a.dead`) went on
   *     treating the corpse as a bystander — the next shot handed it a flee
   *     path and it RAN 10.5 m down the street lying flat on its back;
   *   · its collider stayed a solid, upright 1.75 m capsule instead of the
   *     0.386 m CORPSE-masked one `_think` installs as the body folds;
   *   · the 200 s corpse TTL, the sink and the despawn never ran, so bodies
   *     were permanent;
   *   · and `ctx.emit('npcKilled')` never fired for anyone downstream.
   *
   * Aliasing here rather than renaming the contract keeps both spellings live
   * for anything already calling the published one. Two adjustments are made
   * on the way through:
   *   `species` — Weapon's kill notification and `lastShot` read it, and Folk
   *               does not deal in species.
   *   `rsDead`  — Wanted's own bookkeeping flag. It guards nine places
   *               (witness counting, deputising, its raycast), all of which
   *               must keep seeing a body as a body now that Folk, not
   *               Wanted, is the one killing people.
   */
  raycastNpc(origin, dir, maxDist = 400) {
    const h = this.raycastNPC(origin, dir, maxDist);
    if (h && !h.species) h.species = h.agent && h.agent.woman ? 'townswoman' : 'townsperson';
    return h;
  }

  applyNpcHit(hit, damage = 1) {
    const res = this.applyNPCHit(hit, damage);
    if (res && res.killed && hit && hit.agent) hit.agent.rsDead = 1;
    return res;
  }

  /** Live/dead tallies for a HUD or a wanted meter. */
  npcStats() {
    if (!this.folk) return { total: 0, alive: 0, dead: 0, alarmed: 0 };
    return {
      total: this.folk.agents.length,
      alive: this.folk.livingCount(),
      dead: this.folk.dead,
      alarmed: this.folk.alarmed,
    };
  }

  dispose() {
    const ctx = this.ctx;
    const L = ctx.get('lighting');
    if (this.fire && this.fire.dispose) this.fire.dispose();
    if (this.fireLight && L) L.removeLight(this.fireLight);
    if (this._lampLights && L) for (const l of this._lampLights) L.removeLight(l.light);
    for (const e of this._emitters) if (e && e.stop) e.stop();
    for (const m of this.meshes) { if (m.geometry) m.geometry.dispose(); }
    for (const m of this.mats.values()) m.dispose();
    if (this._signTex) this._signTex.dispose();
    if (this.flames) {
      for (const m of this.flames.mats) m.dispose();
      this.flames.ember.dispose();
      if (this.flames.spark) this.flames.spark.dispose();
      if (this.flames.smoke) for (const m of this.flames.smoke) m.dispose();
      this.flames.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      ctx.scene.remove(this.flames.group);
    }
    if (this._glow) { this._glow.geometry.dispose(); this._glowMat.dispose(); }
    if (this.folk) { this.folk.dispose(ctx.scene); this.folk = null; }
    const PH = ctx.get('physics');
    if (this._blockers) {
      if (PH && PH.removeBlocker) for (const b of this._blockers) PH.removeBlocker(b);
      this._blockers = null;
    }
    if (this._colliders) {
      if (PH && PH.removeCollider) for (const c of this._colliders) PH.removeCollider(c);
      this._colliders = null;
    }
    if (this.group) ctx.scene.remove(this.group);
    if (this.campGroup) ctx.scene.remove(this.campGroup);
  }
}
