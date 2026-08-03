import * as THREE from 'three';
import {
  rand2, streamRng, clamp, smoothstep, fbm2,
} from './scatter/Noise.js';
import {
  makeRock, makeDeadTree, makeLog, makeStump, makeFencePost, makeFenceRail,
  makeYucca, makePricklyPear, makeSaguaro, makeSkull, makeBones, makeRuinWall,
  makeBush, makeTumbleweed,
} from './scatter/Geometry.js';
import { makeBushAtlas, makePlantSkin } from './scatter/Textures.js';
import { makeScatterMaterial, updateScatterMaterial } from './scatter/Material.js';
import {
  Probe, clusterMask, rarePatch, buildTrailNetwork, TrailIndex, findAnchors,
} from './scatter/Placement.js';
import { Bedding } from './scatter/Bedding.js';
import { ScatterCollision } from './scatter/Collision.js';
import { planHeroes, emitHeroFormation } from './scatter/Heroes.js';
import { ZONE, logSize } from './vegetation/Ecology.js';

/**
 * ============================================================================
 * SCATTER — everything between the player's boots and the mountains.
 * ============================================================================
 *
 * Pass 1 shipped this file as a stub, and the art directors named the exact
 * consequence: "There is no midground. Every shot cuts straight from a large
 * flat foreground to a distant range with nothing in between ... with nothing
 * at 50-500 m the eye has no stepping stones to measure the distance against."
 *
 * So this system exists to occupy the 20-400 m band (and out to ~900 m for the
 * big silhouettes) with instanced, clustered, terrain-derived variety:
 *
 *   rock       boulders, fractured blocks, bedded slabs, bedrock outcrops,
 *              desert-pavement gravel
 *   wood       dead ridge trees, fallen logs, splintered stumps, bleached
 *              driftwood on the inside of meanders
 *   plants     sage / creosote / rabbitbrush thickets, yucca, agave,
 *              prickly pear, columnar cactus, tumbleweed
 *   bones      cow skulls and rib scatters on the dry flats
 *   human      wagon-rut trail network, fence lines and corrals, adobe ruins
 *
 * PLACEMENT is a function of the terrain's own derivatives, never uniform:
 * slope, curvature, 20 m neighbourhood relief (talus below a scarp), the
 * hydrology flow map (debris in the gullies, driftwood at the water line) and
 * the splat weights, all multiplied by a two-octave cluster mask so the world
 * has thickets and clearings rather than an even sprinkle.
 *
 * RENDERING is InstancedMesh + 2-3 discrete LODs per variant with a dithered
 * cross-fade, world-space triplanar materials (no unwrap, no visible repeat)
 * and a baked curvature/cavity term that packs dirt into the cracks and
 * bleaches the up-facing planes.
 * ============================================================================
 */

/* --------------------------------------------------------------- tunables */

const RING = {
  outcrop: 980,
  rock: 820,
  tree: 900,
  bush: 330,
  plant: 340,
  wood: 340,
  small: 150,
  fence: 420,
  /* was 700. An 8 m adobe wall at 500 m is ~30 px of high-frequency brick, and
     that is precisely the "rectangular blob of repeating diagonal hatch" the
     forensic pass found at x40-115/y500-560 in high_noon_desert. Nothing that
     small and that high-frequency survives that far out — pull it in, and let
     the mip bias handle what is left. */
  ruin: 380,
  trail: 780,
};

/* Art-directed geology tints (linear multipliers on the rock albedo). Chosen
   per ~180 m cluster so a rock field reads as one rock type, not confetti. */
const ROCK_TINTS = [
  [1.00, 0.96, 0.88], // dust grey
  [1.10, 0.90, 0.74], // oxidised red rock
  [0.90, 0.91, 0.92], // cold slate
  [1.08, 1.02, 0.84], // bleached ochre
  [0.95, 0.90, 0.81], // shale
];

const FOLIAGE_TINTS = [
  [0.94, 1.00, 0.86], // sage
  [1.10, 1.02, 0.72], // rabbitbrush, drying
  [0.82, 0.92, 0.74], // creosote, greener
  [1.22, 1.06, 0.66], // sun-killed straw
];

/* ------------------------------------------------------------------ batch */

class Batch {
  constructor(geom, material, max, group, name) {
    geom.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3));
    geom.setAttribute('aFade', new THREE.InstancedBufferAttribute(new Float32Array(max), 1));
    const mesh = new THREE.InstancedMesh(geom, material, max);
    mesh.name = 'scatter_' + name;
    mesh.count = 0;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.receiveShadow = true;
    group.add(mesh);

    this.mesh = mesh;
    this.max = max;
    this.n = 0;
    this.mArr = mesh.instanceMatrix.array;
    this.tArr = geom.attributes.aTint.array;
    this.fArr = geom.attributes.aFade.array;
    this.geom = geom;
  }

  reset() { this.n = 0; }

  add(m4, tint, fade) {
    const i = this.n;
    if (i >= this.max) return false;
    m4.toArray(this.mArr, i * 16);
    this.tArr[i * 3] = tint[0];
    this.tArr[i * 3 + 1] = tint[1];
    this.tArr[i * 3 + 2] = tint[2];
    this.fArr[i] = fade;
    this.n = i + 1;
    return true;
  }

  flush() {
    const m = this.mesh;
    m.count = this.n;
    m.visible = this.n > 0;
    if (this.n > 0) {
      m.instanceMatrix.needsUpdate = true;
      this.geom.attributes.aTint.needsUpdate = true;
      this.geom.attributes.aFade.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }
}

/** One prop kind: N base-geometry variants, each with a LOD chain. */
class PropKind {
  constructor(key) {
    this.key = key;
    this.variants = []; // [ [ {batch, far, band}, ... ] ]
  }

  add(m4, tint, dist, variant) {
    const chain = this.variants[variant % this.variants.length];
    for (let i = 0; i < chain.length; i++) {
      const l = chain[i];
      if (dist < l.far - l.band) { l.batch.add(m4, tint, 1); return; }
      if (dist < l.far) {
        const t = (dist - (l.far - l.band)) / l.band;
        l.batch.add(m4, tint, 1 - t);
        const nxt = chain[i + 1];
        // NEGATIVE fade flags the INCOMING LOD, which makes its dither the exact
        // complement of the outgoing one's instead of a nested subset. See
        // FADE_FRAG in scatter/Material.js — without the sign the two copies
        // discard the same pixels and the prop is up to 50% see-through, with
        // the holes crawling across it as the camera moves.
        if (nxt) nxt.batch.add(m4, tint, -t);
        return;
      }
    }
  }

  reset() { for (const c of this.variants) for (const l of c) l.batch.reset(); }

  flush() { for (const c of this.variants) for (const l of c) l.batch.flush(); }

  count() {
    let n = 0;
    for (const c of this.variants) for (const l of c) n += l.batch.n;
    return n;
  }
}

/* ---------------------------------------------------------------- system */

export class Scatter {
  static id = 'scatter';

  constructor(ctx) {
    this.ctx = ctx;
    this.group = null;
    this.kinds = new Map();
    this.materials = [];
    this._origin = new THREE.Vector3(1e9, 0, 1e9);
    this._queue = [];
    this._time = 0;
    this._probe = null;
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._scale = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._ident = new THREE.Quaternion();
    this._euler = new THREE.Euler(0, 0, 0, 'YZX');
    this.stats = { instances: 0, batches: 0, drawn: 0 };
  }

  /* ================================================================= init */

  async init() {
    const ctx = this.ctx;
    if (!ctx.world || !ctx.world.ready) {
      console.warn('[scatter] terrain not ready — scatter disabled');
      return;
    }
    this.seed = (ctx.seed ^ 0x5bf03635) | 0;
    this.group = new THREE.Group();
    this.group.name = 'scatter';
    this.group.matrixAutoUpdate = false;
    ctx.scene.add(this.group);

    this._probe = new Probe(ctx);
    this._probe.bindFlow(ctx.get('terrain'));

    /* ---------------------------------------------------------- the ecology
     * Vegetation (order 40) builds the world's regional plan; we run at 45 and
     * read it. Sharing it is the whole point: without it the trees think there
     * is a forest here and the boulders think there is a scree apron, and the
     * result is the uniform confetti every forensic pass has called out. If it
     * is missing we fall back to the old cluster masks rather than failing. */
    const veg = ctx.get('vegetation');
    this.eco = (veg && typeof veg.ecology === 'function') ? veg.ecology() : null;
    if (!this.eco) console.warn('[scatter] no ecology map — falling back to cluster noise');

    this._buildMaterials();
    this._buildKinds();
    this._buildTrails();
    const qn = ctx.quality.name;
    this.bedding = new Bedding(ctx, this.group, {
      max: qn === 'low' ? 500 : qn === 'medium' ? 900 : 1400,
      range: 94,
      seed: this.seed + 0x2f1d,
    });
    /* Solid props get a capsule the character controller can bump into — see
       scatter/Collision.js for the shape choice and the broad phase. */
    this.collision = new ScatterCollision(ctx);

    /* atmosphere + shadows on everything we own */
    const sky = ctx.get('sky');
    if (sky && typeof sky.injectAerialPerspective === 'function') {
      for (const m of this.materials) sky.injectAerialPerspective(m);
      /* The bedding decal is a multiply over ground that has ALREADY had aerial
         perspective applied; injecting it again would double-count the
         scattering. It carries `rsNoAerial`, so this call is a documented
         no-op rather than an omission. */
      sky.injectAerialPerspective(this.bedding.material);
    }
    const L = ctx.get('lighting');
    if (L && typeof L.requestShadowCaster === 'function') {
      for (const kind of this.kinds.values()) {
        for (const chain of kind.variants) {
          for (let i = 0; i < chain.length; i++) {
            if (!chain[i].shadow) continue;
            L.requestShadowCaster(chain[i].batch.mesh);
            chain[i].batch.mesh.userData.shadowRadius = chain[i].shadowRadius || 2;
          }
        }
      }
      if (L.registerMaterial) L.registerMaterial(this.materials);
    }

    ctx.on('teleport', () => { this._origin.set(1e9, 0, 1e9); this._flushAll = true; });
    /* The hero plan wants POIs that later systems publish — Player registers
       `player_ots` at order 70, we run at 45 — so it is planned lazily on first
       use and invalidated once when the world reports ready. */
    this._heroSites = null;
    ctx.on('ready', () => { this._heroSites = null; });

    /* first population, synchronously, so frame 1 already has a world */
    this._rebuild(ctx.camera.position.x, ctx.camera.position.z, true);
  }

  /* ------------------------------------------------------------ materials */

  /**
   * Pack a procTextures set's normal.xy + roughness into one RGB texture.
   * Saves a fragment sampler per material — with the sky-view LUT, two cascade
   * atlases and the local-light shadows all resident, 16 units goes fast.
   */
  /**
   * Scale a material's colour so the *mean linear albedo* of its procTextures
   * set lands on an art-directed target. ProcTextures is being reworked in
   * parallel and its mid-tones move; without this the props drift dark and
   * muddy relative to the ground whenever that happens.
   */
  /**
   * Mean LINEAR luminance of a set's albedo, as the shader will see it after
   * hardware sRGB decode. The shader normalises every one of its modulations by
   * this, so it must be measured the same way the GPU samples it — a mismatch
   * here is what turned the pass-3 boulders into black lumps.
   *
   * Uses the same channel weights the shader uses (flat 1/3), not luma weights.
   */
  _meanLum(set) {
    if (!set || !set.map || !set.map.image || !set.map.image.data) return null;
    const d = set.map.image.data;
    const s2l = (c) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    let sum = 0, n = 0;
    for (let i = 0; i + 2 < d.length; i += 4 * 37) {
      sum += (s2l(d[i]) + s2l(d[i + 1]) + s2l(d[i + 2])) / 3;
      n++;
    }
    return n ? sum / n : null;
  }

  _albedoGain(set, target) {
    if (!set || !set.map || !set.map.image || !set.map.image.data) return 1;
    const d = set.map.image.data;
    const s2l = (c) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    let sum = 0, n = 0;
    for (let i = 0; i + 2 < d.length; i += 4 * 37) {
      sum += 0.2126 * s2l(d[i]) + 0.7152 * s2l(d[i + 1]) + 0.0722 * s2l(d[i + 2]);
      n++;
    }
    const mean = n ? sum / n : 0.2;
    return clamp(target / Math.max(mean, 0.01), 0.3, 6);
  }

  _pack(set) {
    if (!set || !set.normalMap || !set.normalMap.image) return null;
    const n = set.normalMap.image;
    const r = set.roughnessMap && set.roughnessMap.image ? set.roughnessMap.image : null;
    const S = n.width;
    const nd = n.data;
    const rd = r && r.width === S ? r.data : null;
    const out = new Uint8Array(S * S * 4);
    for (let i = 0, j = 0; i < S * S; i++, j += 4) {
      out[j] = nd[j];
      out[j + 1] = nd[j + 1];
      out[j + 2] = rd ? rd[j + 1] : 200;
      out[j + 3] = 255;
    }
    const t = new THREE.DataTexture(out, S, S, THREE.RGBAFormat);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = Math.min(8, this.ctx.quality.anisotropy || 8);
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    this._packed = this._packed || [];
    this._packed.push(t);
    return t;
  }

  _buildMaterials() {
    const ctx = this.ctx;
    const T = ctx.get('procTextures');
    const grab = (name) => {
      try { return T && T.get ? T.get(name) : null; } catch (e) { return null; }
    };
    const rockSet = grab('rock_boulder') || grab('rock_cliff');
    /*
     * BARK, not planks. This material dresses logs, dead trees, stumps and
     * driftwood; `wood_weathered` is a milled-plank recipe whose height field is
     * `partition1(y, 6, ...)` — six board widths per tile, each with a hard
     * split line. Triplanar-projected onto a cylinder at any near-field scale
     * that is a perfectly regular dot lattice wrapped round the barrel, which is
     * the same defect class as the "repeating diagonal hatch" the forensic pass
     * found on the ruins. bark_pine is a fissure-and-plate field with no global
     * period, which is what a log actually has.
     */
    const woodSet = grab('bark_oak') || grab('bark_pine') || grab('wood_weathered');
    const adobeSet = grab('adobe') || rockSet;
    const dirtSet = grab('dirt_packed') || grab('dirt_dry');
    const packRock = this._pack(rockSet);
    const packWood = this._pack(woodSet);
    const packAdobe = this._pack(adobeSet);
    this._packDirt = this._pack(dirtSet);
    /* measured, not assumed — procTextures re-bakes its recipes between passes */
    const mRock = this._meanLum(rockSet) || 0.16;
    const mWood = this._meanLum(woodSet) || 0.14;
    const mAdobe = this._meanLum(adobeSet) || 0.24;
    const mDirt = this._meanLum(dirtSet) || 0.20;

    /*
     * These four numbers are the pass-3 answer to "PLACEHOLDER SURFACE QUALITY
     * at hero scale". `worldScale` sets the decimetre band, `detailScale` the
     * centimetre band, `crack` cuts fissures out of it, `lichen` colonises the
     * exposed up-faces. Pass 2 ran the fine octave at ±15% amplitude, which is
     * invisible once aerial haze has taken its cut; it is now ±42% with a real
     * normal and roughness contribution behind it.
     */
    this.rockMat = makeScatterMaterial({
      name: 'rock',
      set: rockSet,
      packed: packRock,
      triplanar: true,
      worldScale: 0.92,
      sharpness: 7.5,
      normalStrength: 1.45,
      cavityDirt: 0.40,
      cavityRough: 0.16,
      bleach: 0.46,
      dirt: [0.60, 0.54, 0.45],
      macro: 0.16,
      detailScale: 5.2,
      detailFade: [26, 88],
      detail: 0.42,
      crack: 0.50,
      crackWindow: [0.26, 0.60],
      lichen: 0.22,
      lichenTint: [0.60, 0.63, 0.50],
      detailNormal: 0.70,
      meanLum: mRock,
      mipBias: 0.022,
      roughness: 1.0,
      /* ---- pass-12 rock terms, see scatter/Material.js
       * sizeExp   0.55: a 1 m boulder keeps its ~1.1 m projection; a 36 m butte
       *           gets a ~8 m one, so the recipe's beds and cracks are metres
       *           across on the outcrop and millimetres on the cobble instead
       *           of both being millimetres.
       * strata    world-Y bedding shared by every block in a formation.
       * chip      pale, low-roughness break on the convex arrises the
       *           half-space geometry now produces.
       * hexRange  0 — DELIBERATE. rsHexSample on the near-field detail taps
       *           measured __render 11.1 -> 26.7 ms on high_noon_desert (3x the
       *           whole frame; the branch keeps both texture paths resident and
       *           occupancy collapses). The repeat is broken by the two-octave
       *           domain warp + the per-instance projection rotation instead.
       *           The plumbing stays so a future budget can switch it on. */
      sizeExp: 0.55,
      strata: 0.34,
      strataFreq: 0.42,
      chip: 0.85,
      uvWarp: 0.30,
      hexRange: 0,   // see above — measured 3x on __render, not affordable
      hexGLSL: (T && T.hexTileGLSL) || null,
    });
    this.woodMat = makeScatterMaterial({
      name: 'wood',
      set: woodSet,
      packed: packWood,
      triplanar: true,
      /* Pass 2 ran the bark at 0.74 m, i.e. three to five identical repeats
         down a single log, and the forensic pass counted the repeats. Pushing it
         all the way to 0.30 m traded that for a regular dot lattice — the plate
         structure in bark_pine minified into a periodic grid. 0.60 m sits below
         the log's own length scale without reaching the plate frequency, and
         the per-instance projection rotation in Material.js is what actually
         breaks the cross-instance rhythm. */
      worldScale: 1.50,
      sharpness: 6.0,
      normalStrength: 1.15,
      cavityDirt: 0.66,
      cavityRough: 0.18,
      bleach: 0.55,
      dirt: [0.30, 0.25, 0.19],
      macro: 0.26,
      detailScale: 3.6,
      detailFade: [14, 46],
      detail: 0.24,
      crack: 0.55,
      crackWindow: [0.32, 0.72],
      lichen: 0.10,
      lichenTint: [0.56, 0.58, 0.46],
      detailNormal: 0.28,
      meanLum: mWood,
      mipBias: 0.030,
      roughness: 1.0,
    });
    this.boneMat = makeScatterMaterial({
      name: 'bone',
      set: rockSet,
      packed: packRock,
      triplanar: true,
      worldScale: 3.2,
      sharpness: 6.0,
      normalStrength: 0.7,
      cavityDirt: 0.85,
      cavityRough: 0.10,
      bleach: 0.30,
      dirt: [0.52, 0.46, 0.36],
      macro: 0.12,
      detailScale: 4.0,
      detailFade: [10, 40],
      detail: 0.18,
      crack: 0.0,
      detailNormal: 0.30,
      meanLum: mRock,
      mipBias: 0.040,
      roughness: 0.86,
    });

    this.ruinMat = makeScatterMaterial({
      name: 'ruin',
      set: adobeSet,
      packed: packAdobe,
      triplanar: true,
      worldScale: 0.72,
      sharpness: 6.0,
      normalStrength: 1.0,
      cavityDirt: 0.75,
      cavityRough: 0.14,
      bleach: 0.45,
      dirt: [0.42, 0.35, 0.27],
      macro: 0.18,
      detailScale: 4.5,
      detailFade: [18, 60],
      detail: 0.28,
      crack: 0.40,
      crackWindow: [0.30, 0.66],
      detailNormal: 0.45,
      meanLum: mAdobe,
      /* the strongest bias in the set: brick is the highest-frequency albedo in
         the library and it is the one that moirés */
      mipBias: 0.055,
      roughness: 1.0,
    });

    const atlasSize = ctx.quality.name === 'low' ? 512 : 1024;
    this.bushAtlas = makeBushAtlas(atlasSize, 'sage', this.seed);
    this.bushAtlas.anisotropy = Math.min(8, ctx.quality.anisotropy || 8);
    this.foliageMat = makeScatterMaterial({
      name: 'foliage',
      triplanar: false,
      cardMap: this.bushAtlas,
      alphaTest: 0.30,
      side: THREE.DoubleSide,
      cavityDirt: 0.14,
      cavityRough: 0.05,
      bleach: 0.18,
      dirt: [0.62, 0.60, 0.50],
      roughness: 0.92,
      colour: 0xdedcd2,
      cardNormals: true,
      wind: true,
    });

    this.plantSkin = makePlantSkin(256, this.seed + 3, [152, 162, 118]);
    this.plantSkin.anisotropy = Math.min(8, ctx.quality.anisotropy || 8);
    this.plantSkin.repeat.set(2, 2);
    this.plantMat = makeScatterMaterial({
      name: 'plant',
      triplanar: false,
      cardMap: this.plantSkin,
      side: THREE.DoubleSide,
      cavityDirt: 0.50,
      cavityRough: 0.10,
      bleach: 0.40,
      dirt: [0.52, 0.56, 0.40],
      roughness: 0.80,
      colour: 0xcfd2c0,
      wind: true,
      windAmp: 0.22,
    });

    /* Art-directed mean albedos, linear: bleached desert stone, sun-greyed
       deadwood, bone, adobe.
       Rock was 0.235 in pass 2 and the critics measured the result: the camp
       boulders came back "blown-out WHITE" at 168/255 against ground at 98. Dry
       desert stone is a 0.15-0.19 linear reflector — brighter than that and any
       key light close enough to matter drives it into the tonemap shoulder,
       which is exactly what happened when the fire light landed. */
    const gRock = this._albedoGain(rockSet, 0.255);
    const gWood = this._albedoGain(woodSet, 0.180);
    const gAdobe = this._albedoGain(adobeSet, 0.300);
    this.rockMat.color.setRGB(gRock * 1.02, gRock * 0.985, gRock * 0.925);
    this.woodMat.color.setRGB(gWood * 1.06, gWood * 1.00, gWood * 0.90);
    const gBone = this._albedoGain(rockSet, 0.46);
    this.boneMat.color.setRGB(gBone, gBone * 0.975, gBone * 0.90);
    this.ruinMat.color.setRGB(gAdobe * 1.0, gAdobe * 0.97, gAdobe * 0.90);
    this._gainDirt = this._albedoGain(dirtSet, 0.185);
    this._meanDirt = mDirt;

    this.materials = [this.rockMat, this.woodMat, this.boneMat, this.ruinMat,
      this.foliageMat, this.plantMat];
  }

  /* ------------------------------------------------------------ geometry */

  /**
   * Seat a prop on the ground plane: centre it in XZ, put its base at y = 0 and
   * (optionally) normalise it so a horizontal radius of 1 = 1 metre of instance
   * scale. LODs of the same prop are seated with LOD0's transform so they do
   * not change size as they swap.
   */
  _seat(geo, xform = null, normalise = true) {
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    let t = xform;
    if (!t) {
      const cx = (bb.min.x + bb.max.x) * 0.5;
      const cz = (bb.min.z + bb.max.z) * 0.5;
      const rx = Math.max(bb.max.x - cx, cx - bb.min.x);
      const rz = Math.max(bb.max.z - cz, cz - bb.min.z);
      t = { cx, cz, minY: bb.min.y, r: normalise ? Math.max(rx, rz, 1e-4) : 1 };
      t.height = (bb.max.y - bb.min.y) / t.r;
    }
    const p = geo.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) {
      p[i] = (p[i] - t.cx) / t.r;
      p[i + 1] = (p[i + 1] - t.minY) / t.r;
      p[i + 2] = (p[i + 2] - t.cz) / t.r;
    }
    geo.attributes.position.needsUpdate = true;
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    geo.userData.seat = t;
    return t;
  }

  /**
   * Register a prop kind.
   * @param {string} key
   * @param {Array<Array<{geom:THREE.BufferGeometry, far:number, band:number, max:number, shadow:boolean}>>} variants
   */
  _kind(key, material, variants) {
    const kind = new PropKind(key);
    for (let v = 0; v < variants.length; v++) {
      const chain = [];
      for (const l of variants[v]) {
        const b = new Batch(l.geom, material, l.max, this.group, key + v + '_' + chain.length);
        chain.push({
          batch: b,
          far: l.far,
          band: l.band !== undefined ? l.band : Math.min(l.far * 0.22, 55),
          shadow: l.shadow !== false,
          shadowRadius: l.shadowRadius || 2,
        });
      }
      kind.variants.push(chain);
    }
    this.kinds.set(key, kind);
    return kind;
  }

  _buildKinds() {
    const q = this.ctx.quality;
    const lowQ = q.name === 'low';
    const D = lowQ ? 0.55 : q.name === 'medium' ? 0.78 : 1.0;
    const S = this.seed;

    /* ---------------------------------------------------------- boulders
     * SIX base solids, not four, and drawn from six different families rather
     * than one family at three scales. The forensic pass called out "REPEATED
     * ROCK INSTANCES: the same 3-4 low-poly boulder meshes recur across the
     * whole plain at every depth, same texture, same orientation family". The
     * per-instance triplanar frame rotation in Material.js is the other half of
     * that fix — together, two instances of variant 3 standing side by side
     * share neither silhouette orientation nor a single texel.
     */
    const rockVariants = [];
    /* Pass 12: only ONE of the six is still a water-worn `round` solid. The
       other five are half-space intersections (Geometry.makeCutRock) — real
       fracture faces meeting at arrises. Indices 2 and 3 must stay the flat
       families: `_place` and `_emitErratics` both key their ground-align term
       off `variant === 2 || variant === 3`. */
    const rockFamilies = ['blocky', 'angular', 'slab', 'bedded', 'round', 'angular'];
    this.rockFamilies = rockFamilies;
    for (let v = 0; v < 6; v++) {
      const seed = S + v * 977;
      const g0 = makeRock(seed, { detail: lowQ ? 2 : 3, family: rockFamilies[v] });
      const t = this._seat(g0);
      const g1 = makeRock(seed, { detail: 2, family: rockFamilies[v] });
      this._seat(g1, t);
      const g2 = makeRock(seed, { detail: 1, family: rockFamilies[v] });
      this._seat(g2, t);
      rockVariants.push([
        { geom: g0, far: 78, band: 7, max: Math.round(150 * D), shadowRadius: 2.2 },
        { geom: g1, far: 240, band: 16, max: Math.round(300 * D), shadowRadius: 1.6 },
        { geom: g2, far: RING.rock, band: 60, max: Math.round(680 * D), shadow: false },
      ]);
    }
    this._kind('rock', this.rockMat, rockVariants);

    /* ---------------------------------------------------------- outcrops
     * SEVEN base solids, not four. "The hero outcrop asset is one silhouette
     * repeated across the whole shot set" was literally true: `Heroes.js` built
     * every formation's main mass from variant 2 and its plinth from variant 1,
     * so river_bend and high_noon_desert were showing the same mesh at two
     * scales. Seven variants across four families, with the hero picker drawing
     * the mass from {2,4,6} and the plinth from {1,3}, means no two formations
     * in the shot set share a mesh. Extra batches only cost a draw call when
     * they actually carry instances. */
    const outVariants = [];
    const outFamilies = ['outcrop', 'bedded', 'tall', 'bedded', 'tall', 'blocky', 'tall'];
    this.outFamilies = outFamilies;
    for (let v = 0; v < outFamilies.length; v++) {
      const seed = S + 4001 + v * 613;
      const fam = outFamilies[v];
      const g0 = makeRock(seed, { detail: lowQ ? 2 : 3, family: fam });
      const t = this._seat(g0);
      const g1 = makeRock(seed, { detail: 2, family: fam });
      this._seat(g1, t);
      outVariants.push([
        { geom: g0, far: 340, band: 22, max: Math.round(100 * D), shadowRadius: 14 },
        { geom: g1, far: RING.outcrop, band: 90, max: Math.round(240 * D), shadowRadius: 14 },
      ]);
    }
    this._kind('outcrop', this.rockMat, outVariants);

    /* ------------------------------------------------------- small stones
     * Two variants and a shadow-casting near LOD: a pebble that casts nothing
     * onto the dirt 3 cm away is the reason the ground reads as a printed
     * texture rather than a surface with things lying on it. */
    const stoneVariants = [];
    for (let v = 0; v < 2; v++) {
      const gs = makeRock(S + 7717 + v * 331, { detail: v === 0 ? 2 : 1, family: v === 0 ? 'angular' : 'slab' });
      const ts = this._seat(gs);
      const gs1 = makeRock(S + 7717 + v * 331, { detail: 1, family: v === 0 ? 'angular' : 'slab' });
      this._seat(gs1, ts);
      stoneVariants.push([
        { geom: gs, far: 34, band: 5, max: Math.round(200 * D), shadowRadius: 0.5 },
        { geom: gs1, far: RING.small, band: 22, max: Math.round(420 * D), shadow: false },
      ]);
    }
    this._kind('stone', this.rockMat, stoneVariants);

    /* -------------------------------------------------------- dead trees */
    const treeVariants = [];
    for (let v = 0; v < 3; v++) {
      const seed = S + 15013 + v * 271;
      const g0 = makeDeadTree(seed, { lod: 0 });
      const g1 = makeDeadTree(seed, { lod: 1 });
      treeVariants.push([
        { geom: g0, far: 320, band: 24, max: Math.round(70 * D), shadowRadius: 6 },
        { geom: g1, far: RING.tree, band: 70, max: Math.round(150 * D), shadowRadius: 6 },
      ]);
    }
    this._kind('deadtree', this.woodMat, treeVariants);

    /* -------------------------------------------------- logs and stumps */
    const logVariants = [];
    for (let v = 0; v < 2; v++) {
      const seed = S + 21001 + v * 149;
      logVariants.push([
        { geom: makeLog(seed, { lod: 0 }), far: 140, band: 12, max: Math.round(90 * D), shadowRadius: 3 },
        { geom: makeLog(seed, { lod: 1 }), far: RING.wood, band: 40, max: Math.round(140 * D), shadow: false },
      ]);
    }
    this._kind('log', this.woodMat, logVariants);

    this._kind('stump', this.woodMat, [
      [{ geom: makeStump(S + 4409), far: RING.wood, band: 60, max: Math.round(90 * D), shadowRadius: 1.4 }],
    ]);

    this._kind('driftwood', this.woodMat, [
      [{ geom: makeLog(S + 6607, { lod: 0, driftwood: true }), far: 170, band: 40, max: Math.round(90 * D), shadowRadius: 3 },
        { geom: makeLog(S + 6608, { lod: 1, driftwood: true }), far: RING.wood, band: 80, max: Math.round(140 * D), shadow: false }],
    ]);

    /* ------------------------------------------------------------- bushes */
    const bushVariants = [];
    for (let v = 0; v < 4; v++) {
      const seed = S + 31013 + v * 89;
      const shape = {
        cards: v === 3 ? 8 : 12,
        spread: v === 3 ? 0.46 : 0.62,
        rise: v === 1 ? 0.95 : 0.60,
        droop: v === 2 ? 0.24 : 0.10,
      };
      const g0 = makeBush(seed, shape);
      const g1 = makeBush(seed, { ...shape, cards: 4 });
      /* The 12-card LOD0 bush is the most overdrawn thing in the arid shots
         now that scrub is sized to read as a mass (median 0.95 m rather than
         0.54 m). Handing over to the 4-card LOD at 112 m instead of 145 m cuts
         its screen area by 40% for a swap nobody can see at that distance. */
      bushVariants.push([
        { geom: g0, far: 112, band: 14, max: Math.round(1500 * D), shadowRadius: 1.6 },
        { geom: g1, far: RING.bush, band: 44, max: Math.round(2400 * D), shadow: false },
      ]);
    }
    this._kind('bush', this.foliageMat, bushVariants);

    /* --------------------------------------------------------- succulents */
    this._kind('yucca', this.plantMat, [
      [{ geom: makeYucca(S + 5501, { lod: 0 }), far: 150, band: 34, max: Math.round(180 * D), shadowRadius: 2 },
        { geom: makeYucca(S + 5501, { lod: 1 }), far: RING.plant, band: 80, max: Math.round(300 * D), shadow: false }],
      [{ geom: makeYucca(S + 5502, { lod: 0 }), far: 150, band: 34, max: Math.round(180 * D), shadowRadius: 2 },
        { geom: makeYucca(S + 5502, { lod: 1 }), far: RING.plant, band: 80, max: Math.round(300 * D), shadow: false }],
    ]);
    this._kind('agave', this.plantMat, [
      [{ geom: makeYucca(S + 5601, { lod: 0, agave: true }), far: RING.plant, band: 70, max: Math.round(320 * D), shadowRadius: 1.2 }],
    ]);
    this._kind('pear', this.plantMat, [
      [{ geom: makePricklyPear(S + 5701), far: RING.plant, band: 70, max: Math.round(320 * D), shadowRadius: 1.4 }],
    ]);
    this._kind('saguaro', this.plantMat, [
      [{ geom: makeSaguaro(S + 5801, { lod: 0 }), far: 260, band: 55, max: Math.round(90 * D), shadowRadius: 6 },
        { geom: makeSaguaro(S + 5801, { lod: 1 }), far: 700, band: 140, max: Math.round(160 * D), shadowRadius: 6 }],
      [{ geom: makeSaguaro(S + 5802, { lod: 0 }), far: 260, band: 55, max: Math.round(90 * D), shadowRadius: 6 },
        { geom: makeSaguaro(S + 5802, { lod: 1 }), far: 700, band: 140, max: Math.round(160 * D), shadowRadius: 6 }],
    ]);
    this._kind('tumble', this.woodMat, [
      [{ geom: makeTumbleweed(S + 5901), far: RING.small, band: 24, max: Math.round(60 * D), shadowRadius: 0.5 }],
    ]);

    /* ------------------------------------------------------------- bones */
    this._kind('skull', this.boneMat, [
      [{ geom: makeSkull(S + 6101), far: RING.small, band: 30, max: Math.round(40 * D), shadowRadius: 0.6 }],
    ]);
    this._kind('bones', this.boneMat, [
      [{ geom: makeBones(S + 6201), far: RING.small, band: 24, max: Math.round(40 * D), shadowRadius: 0.5 }],
    ]);

    /* ------------------------------------------------------------- fences */
    this._kind('post', this.woodMat, [
      [{ geom: makeFencePost(S + 7001), far: RING.fence, band: 90, max: Math.round(900 * D), shadowRadius: 1.6 }],
    ]);
    this._kind('rail', this.woodMat, [
      [{ geom: makeFenceRail(S + 7101), far: RING.fence, band: 90, max: Math.round(1800 * D), shadowRadius: 3 }],
    ]);

    /* -------------------------------------------------------------- ruins */
    this._kind('ruin', this.ruinMat, [
      [{ geom: makeRuinWall(S + 8101, { height: 1.9 }), far: RING.ruin, band: 120, max: 40, shadowRadius: 8 }],
      [{ geom: makeRuinWall(S + 8102, { height: 2.6, thick: 0.5 }), far: RING.ruin, band: 120, max: 40, shadowRadius: 8 }],
    ]);
  }

  /* -------------------------------------------------------------- trails */

  _buildTrails() {
    const ctx = this.ctx;
    const coarse = buildTrailNetwork(ctx, this.seed);
    /* Resample to ~3.5 m so the ribbon hugs the ground instead of spanning
       14 m chords that float over hollows and cut through rises. */
    const gh0 = ctx.world.getHeight;
    this.routes = coarse.map((pts) => {
      const out = [];
      const STEP = 3.5;
      let carry = 0;
      out.push(pts[0].clone());
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const seg = Math.hypot(b.x - a.x, b.z - a.z);
        if (seg < 1e-4) continue;
        let t = (STEP - carry) / seg;
        while (t <= 1) {
          const x = a.x + (b.x - a.x) * t;
          const z = a.z + (b.z - a.z) * t;
          out.push(new THREE.Vector3(x, gh0(x, z), z));
          t += STEP / seg;
        }
        carry = (1 - (t - STEP / seg)) * seg;
      }
      return out;
    });
    this.trailIndex = new TrailIndex(this.routes, 72);

    const T = ctx.get('procTextures');
    let set = null;
    try { set = T && T.get ? T.get('dirt_packed') : null; } catch (e) { set = null; }
    this.trailMat = makeScatterMaterial({
      name: 'trail',
      set,
      packed: this._packDirt,
      triplanar: true,
      worldScale: 0.20,
      sharpness: 8.0,
      normalStrength: 0.8,
      cavityDirt: 0.55,
      cavityRough: 0.08,
      bleach: 0.30,
      dirt: [0.46, 0.40, 0.31],
      roughness: 1.0,
      meanLum: this._meanDirt || 0.20,
      instanced: false,
    });
    if (this._gainDirt) {
      this.trailMat.color.setRGB(this._gainDirt * 1.0, this._gainDirt * 0.95, this._gainDirt * 0.86);
    }
    this.trailMat.transparent = true;
    this.trailMat.depthWrite = false;
    this.trailMat.vertexColors = true;
    this.trailMat.polygonOffset = true;
    this.trailMat.polygonOffsetFactor = -4;
    this.trailMat.polygonOffsetUnits = -8;
    this.materials.push(this.trailMat);

    const MAXV = 30000;
    const g = new THREE.BufferGeometry();
    this._trailPos = new Float32Array(MAXV * 3);
    this._trailNrm = new Float32Array(MAXV * 3);
    this._trailUv = new Float32Array(MAXV * 2);
    this._trailCav = new Float32Array(MAXV);
    this._trailCol = new Float32Array(MAXV * 4);
    this._trailIdx = new Uint32Array(MAXV * 2);
    g.setAttribute('position', new THREE.BufferAttribute(this._trailPos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this._trailNrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this._trailUv, 2));
    g.setAttribute('aCav', new THREE.BufferAttribute(this._trailCav, 1));
    g.setAttribute('color', new THREE.BufferAttribute(this._trailCol, 4));
    g.setIndex(new THREE.BufferAttribute(this._trailIdx, 1));
    g.setDrawRange(0, 0);
    this.trailGeom = g;
    this.trailMesh = new THREE.Mesh(g, this.trailMat);
    this.trailMesh.name = 'scatter_trail';
    this.trailMesh.frustumCulled = false;
    this.trailMesh.receiveShadow = true;
    this.trailMesh.matrixAutoUpdate = false;
    this.trailMesh.renderOrder = 2;
    this.trailMesh.userData.rsNoShadow = true;
    this.trailMesh.updateMatrix();
    this.group.add(this.trailMesh);
  }

  /** Rebuild the visible portion of the cart-track ribbon around the origin. */
  _emitTrail(ox, oz) {
    const gh = this.ctx.world.getHeight;
    const camp = this.ctx.poi.get('camp_fire');
    const cpt = camp ? (camp.pos ? camp.pos : camp) : null;
    const P = this._trailPos, N = this._trailNrm, U = this._trailUv;
    const C = this._trailCav, CO = this._trailCol, I = this._trailIdx;
    const maxV = P.length / 3;
    let vi = 0, ii = 0;
    const R = RING.trail, R2 = R * R;
    /* 5 cross-section lanes: shoulder, rut, crown, rut, shoulder */
    const LANE = [-1.0, -0.58, 0.0, 0.58, 1.0];
    const LANE_A = [0.0, 0.88, 0.55, 0.88, 0.0];
    const LANE_C = [0.15, 0.9, 0.25, 0.9, 0.15];
    const LANE_D = [0.0, -0.055, 0.0, -0.055, 0.0];

    for (let r = 0; r < this.routes.length; r++) {
      const pts = this.routes[r];
      let prevRow = -1;
      let run = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const dx = p.x - ox, dz = p.z - oz;
        const d2 = dx * dx + dz * dz;
        if (d2 > R2) { prevRow = -1; continue; }
        if (cpt) {
          const cx = p.x - cpt.x, cz2 = p.z - cpt.z;
          if (cx * cx + cz2 * cz2 < 30 * 30) { prevRow = -1; continue; }
        }
        if (vi + 5 > maxV) break;
        const a = pts[Math.max(0, i - 1)];
        const b = pts[Math.min(pts.length - 1, i + 1)];
        let tx = b.x - a.x, tz = b.z - a.z;
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        const sx = -tz, sz = tx;
        run += tl * 0.5;
        /* width wanders so the track is not a ruled stripe */
        const w = 1.30 + fbm2(p.x / 90, p.z / 90, 2, this.seed + 77) * 0.45;
        const row = vi;
        for (let k = 0; k < 5; k++) {
          const off = LANE[k] * w;
          const px = p.x + sx * off;
          const pz = p.z + sz * off;
          const py = gh(px, pz) + 0.055 + LANE_D[k];
          P[vi * 3] = px; P[vi * 3 + 1] = py; P[vi * 3 + 2] = pz;
          const nl = 0.0;
          N[vi * 3] = nl; N[vi * 3 + 1] = 1; N[vi * 3 + 2] = nl;
          U[vi * 2] = (k / 4) * 2; U[vi * 2 + 1] = run * 0.12;
          C[vi] = LANE_C[k];
          const dHere = Math.sqrt(d2);
          const fade = clamp(1 - dHere / R, 0, 1);
          /* fade in over the first/last 9 samples of a contiguous run */
          const endT = Math.min(i, pts.length - 1 - i) / 9;
          const edge = LANE_A[k];
          CO[vi * 4] = 1; CO[vi * 4 + 1] = 1; CO[vi * 4 + 2] = 1;
          CO[vi * 4 + 3] = edge * smoothstep(0, 0.22, fade) * clamp(endT, 0, 1)
            * (0.62 + 0.38 * smoothstep(6, 26, dHere));
          vi++;
        }
        if (prevRow >= 0 && ii + 24 <= I.length) {
          for (let k = 0; k < 4; k++) {
            const p0 = prevRow + k, p1 = prevRow + k + 1;
            const c0 = row + k, c1 = row + k + 1;
            I[ii++] = p0; I[ii++] = c0; I[ii++] = c1;
            I[ii++] = p0; I[ii++] = c1; I[ii++] = p1;
          }
        }
        prevRow = row;
      }
    }

    const g = this.trailGeom;
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    g.attributes.uv.needsUpdate = true;
    g.attributes.aCav.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.index.needsUpdate = true;
    g.setDrawRange(0, ii);
    this.trailMesh.visible = ii > 0;
    this._trailVerts = vi;
  }

  /* ----------------------------------------------------------- placement */

  /**
   * Walk a jittered global lattice around the origin. `coarse` is a cheap
   * noise-only upper bound on the acceptance probability so the expensive
   * terrain probe only runs for candidates that could survive it.
   */
  _lattice(ox, oz, cell, radius, salt, coarse, accept, hint) {
    this._hint = hint;
    const seed = this.seed + salt;
    const r2 = radius * radius;
    const i0 = Math.floor((ox - radius) / cell), i1 = Math.ceil((ox + radius) / cell);
    const j0 = Math.floor((oz - radius) / cell), j1 = Math.ceil((oz + radius) / cell);
    const probe = this._probe;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const h = rand2(i, j, seed);
        const x = (i + rand2(i, j, seed + 1)) * cell;
        const z = (j + rand2(i, j, seed + 2)) * cell;
        const dx = x - ox, dz = z - oz;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        /*
         * CAMP KEEP-OUT. Every lattice-driven kind is excluded from the camp
         * Town builds. Vegetation already carves its own hole here (uVegClear),
         * but scatter did not, so night_camp — the shot framed from five metres
         * — had agave rosettes and prickly-pear pads standing between the fire
         * ring stones and behind the tripod, rendering as flat cream paper
         * cutouts lit edge-on by the flame. The camp's own dressing is placed
         * by _emitCamp, which does not come through here.
         */
        if (this._campR2 > 0) {
          const cx = x - this._campX, cz = z - this._campZ;
          if (cx * cx + cz * cz < this._campR2) continue;
        }
        /*
         * TOWN KEEP-OUT. Same argument as the camp, one scale up: pass-9
         * town_street had creosote bushes standing between the wheel ruts of
         * Main Street, which reads worse than an empty street because it says
         * nothing has driven down it in years. Town publishes a TIGHT
         * predicate (a 16 m half-width corridor over the made ground, not the
         * 130 m site radius) so the settlement still sits in real vegetation
         * right up to the boardwalk.
         */
        if (this._townOnStreet && this._townOnStreet(x, z)) continue;
        const c = coarse(x, z);
        if (h > c) continue;
        probe.sample(x, z, true);
        const p = accept(probe, x, z, h);
        if (p === false) continue;
        if (h > p) continue;
        this._place(probe, x, z, Math.sqrt(d2), streamRng((rand2(i, j, seed + 3) * 4294967296) | 0));
      }
    }
  }

  /**
   * Build the instance matrix for one prop and hand it to its batch.
   *
   * `bedR` is the footprint radius of the ground contact. Anything with a
   * non-zero bedR also gets a skirt from `Bedding` — the contact shadow plus a
   * ring of drifted dust — which is what stops it reading as a sticker.
   */
  _emit(kindKey, variant, x, y, z, scale, yaw, tilt, alignN, alignAmt, sink, tint, dist,
    scaleY = null, scaleZ = null, bedR = 0, bedK = 1) {
    const kind = this.kinds.get(kindKey);
    if (!kind) return;
    if (bedR > 0 && this.bedding) this.bedding.add(x, z, bedR, dist, bedK);
    const q = this._q;
    const q2 = this._q2;
    q.setFromAxisAngle(this._up, yaw);
    if (alignAmt > 0 && alignN) {
      this._n.set(alignN.x, alignN.y, alignN.z);
      q2.setFromUnitVectors(this._up, this._n);
      q2.slerp(this._ident, 1 - alignAmt);
      q.premultiply(q2);
    }
    if (tilt > 0) {
      const ax = this._v.set(Math.cos(dist * 12.9898 + x), 0, Math.sin(z * 78.233 + y)).normalize();
      q2.setFromAxisAngle(ax, tilt);
      q.premultiply(q2);
    }
    const sy = scaleY !== null ? scaleY : scale;
    const sz = scaleZ !== null ? scaleZ : scale;
    this._scale.set(scale, sy, sz);
    this._v.set(x, y - sink, z);
    this._m4.compose(this._v, q, this._scale);
    kind.add(this._m4, tint, dist, variant);
    /* COLLISION. One compare rejects everything outside the registry radius,
       which is ~95% of what this function is called with. */
    if (this.collision && dist < 78) {
      const bb = this._propBounds(kind, variant);
      if (bb) {
        this.collision.offer(kindKey, dist, x, y - sink, z,
          bb.hx * scale, bb.hz * sz, bb.h * sy, yaw);
      }
    }
  }

  /**
   * Seated LOD0 bounds of one prop variant, cached on the geometry. Used only
   * by the collision registry — the render path never needs it.
   * @returns {{hx:number, hz:number, h:number}|null}
   */
  _propBounds(kind, variant) {
    const chain = kind.variants[variant % kind.variants.length];
    const g = chain[0].batch.geom;
    let m = g.userData.rsCollBB;
    if (!m) {
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      m = {
        hx: Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x)),
        hz: Math.max(Math.abs(bb.min.z), Math.abs(bb.max.z)),
        h: Math.max(0, bb.max.y - bb.min.y),
      };
      g.userData.rsCollBB = m;
    }
    return m;
  }

  /* ------------------------------------------------------------- rebuild */

  _rebuild(ox, oz, immediate = false) {
    /* Resolve the camp keep-out lazily — Town re-registers `camp_fire` after
       it has graded the pad, and it inits after us. See _lattice. */
    if (this._campR2 === undefined || this._campR2 === 0) {
      const poi = this.ctx.poi.get('camp_fire');
      const c = poi ? (poi.pos || poi) : null;
      const town = this.ctx.get('town');
      const rad = (town && town.camp && town.camp.radius) || 5.5;
      this._campX = c ? c.x : 0;
      this._campZ = c ? c.z : 0;
      this._campR2 = c ? (rad * 1.30) * (rad * 1.30) : 0;
      this._townOnStreet = (town && town.site && town.site.onStreet) || null;
    }
    for (const kind of this.kinds.values()) kind.reset();
    if (this.bedding) this.bedding.begin(ox, oz);
    if (this.collision) this.collision.begin(ox, oz);
    const jobs = [
      () => this._emitOutcrops(ox, oz),
      /* Erratics before the loose-rock lattice: the big things have first call
         on the instance batches, so a foreground anchor can never be starved
         out by a thousand pebbles that arrived first. */
      () => this._emitErratics(ox, oz),
      () => this._emitRocks(ox, oz),
      () => this._emitStones(ox, oz),
      () => this._emitTrees(ox, oz),
      () => this._emitDeadwood(ox, oz),
      () => this._emitBushes(ox, oz),
      () => this._emitSucculents(ox, oz),
      () => this._emitBones(ox, oz),
      () => this._emitFences(ox, oz),
      () => this._emitRuins(ox, oz),
      () => this._emitCamp(ox, oz),
      () => this._emitTrail(ox, oz),
    ];
    if (immediate) {
      for (const j of jobs) j();
      this._finish();
      this._queue.length = 0;
    } else {
      this._queue = jobs.slice();
    }
    this._origin.set(ox, 0, oz);
  }

  _finish() {
    let inst = 0, drawn = 0, batches = 0;
    for (const kind of this.kinds.values()) {
      kind.flush();
      for (const chain of kind.variants) {
        for (const l of chain) {
          batches++;
          inst += l.batch.n;
          if (l.batch.n > 0) drawn++;
        }
      }
    }
    if (this.bedding) this.bedding.flush();
    if (this.collision) {
      this.collision.commit();
      this.collision.stream(true);
      this.stats.colliders = this.collision.stats.registry;
      this.stats.collidersActive = this.collision.stats.active;
    }
    this.stats.instances = inst;
    this.stats.batches = batches;
    this.stats.beds = this.bedding ? this.bedding.n : 0;
    this.stats.drawn = drawn + (this.trailMesh && this.trailMesh.visible ? 1 : 0)
      + (this.bedding && this.bedding.mesh.visible ? 1 : 0);
  }

  /* ------------------------------------------------------ collision (public)
   *
   * Published for the physics system. Scatter owns the placement, so Scatter
   * owns the proxies; everything here is read-only and allocation-free.
   */

  /** Number of capsules in the registry / currently handed to Physics. */
  colliderCount() {
    return this.collision
      ? { registry: this.collision.stats.registry, active: this.collision.stats.active }
      : { registry: 0, active: 0 };
  }

  /**
   * Broad-phase query against the scatter collision registry.
   * @returns {Array<{ax,az,bx,bz,r,yMin,yMax}>} capsules reaching within `r`
   */
  queryColliders(x, z, r, out = []) {
    out.length = 0;
    if (!this.collision) return out;
    const idx = this.collision.query(x, z, r);
    for (let i = 0; i < idx.length; i++) out.push(this.collision.list[idx[i]]);
    return out;
  }

  /* --------------------------------------------------- public prop factory */

  /**
   * Procedural boulder geometry, for any other system that needs a rock rather
   * than a primitive. Comes back seated (base at y=0, horizontal radius 1 =
   * 1 m of scale) and carrying the `aCav` curvature attribute the scatter rock
   * material shades with.
   * @param {number} seed
   * @param {{detail?:number, family?:'round'|'angular'|'slab'|'tall'|'outcrop'}} opts
   */
  makeBoulderGeometry(seed, opts = {}) {
    const g = makeRock(seed | 0, { detail: opts.detail !== undefined ? opts.detail : 2,
      family: opts.family || 'round' });
    this._seat(g);
    return g;
  }

  /** The shared triplanar rock material (already aerial- and CSM-injected). */
  rockMaterial() { return this.rockMat; }

  /**
   * Ready-to-fill InstancedMesh of procedural boulders using the scatter rock
   * material. The per-instance tint/fade attributes the material needs are
   * created and defaulted, so the caller only has to `setMatrixAt`.
   *
   *   const sc = ctx.get('scatter');
   *   const stones = sc.makeBoulderMesh(11, { seed: 7, detail: 2 });
   *   for (...) stones.setMatrixAt(i, m);
   *   stones.instanceMatrix.needsUpdate = true;
   *   group.add(stones);
   */
  makeBoulderMesh(count, { seed = 1, detail = 2, family = 'round' } = {}) {
    const g = this.makeBoulderGeometry(seed, { detail, family });
    const tint = new Float32Array(count * 3).fill(1);
    const fade = new Float32Array(count).fill(1);
    g.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
    g.setAttribute('aFade', new THREE.InstancedBufferAttribute(fade, 1));
    const mesh = new THREE.InstancedMesh(g, this.rockMat, count);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /* ------------------------------------------------------------- emitters */

  /**
   * Camp dressing. The `night_camp` shot frames the fire from 5 m away, so the
   * closest objects to camera in the whole shot set live here — they have to be
   * the best rock in the build, not the worst. Seat boulders, a wood pile, a
   * fallen log and a backdrop of larger blocks, all deterministic from the POI.
   */
  _emitCamp(ox, oz) {
    const poi = this.ctx.poi.get('camp_fire');
    if (!poi) return;
    const c = poi.pos ? poi.pos : poi;
    const dx = c.x - ox, dz = c.z - oz;
    const d2 = dx * dx + dz * dz;
    if (d2 > 260 * 260) return;
    const gh = this.ctx.world.getHeight;
    const probe = this._probe;
    const r = streamRng((this.seed ^ 0x1d7f3c) >>> 0);
    const tint = this._tintFor(c.x, c.z, ROCK_TINTS, 3);
    const wood = [1.06, 0.98, 0.88];

    const put = (kind, variant, px, pz, s, align, sink, tnt, sy, sz, bedR = 0, bedK = 1) => {
      probe.sample(px, pz, false);
      const py = gh(px, pz);
      this._emit(kind, variant, px, py, pz, s, r() * Math.PI * 2, r() * 0.18,
        { x: probe.nx, y: probe.ny, z: probe.nz }, align, sink, tnt,
        Math.hypot(px - ox, pz - oz), sy, sz, bedR, bedK);
    };

    /* Seating ring — boulders you would actually sit on.
     *
     * These are the closest objects to camera in the whole shot set and pass 2
     * regressed them: "blown-out WHITE faceted plastic lumps with visible flat
     * quads". Three things changed. The albedo target came down from 0.235 to
     * 0.168 linear so the fire cannot drive them into the shoulder; they are
     * now drawn from all six rock families instead of four, at a wider scale
     * spread, so the ring is not one shape repeated; and every one of them is
     * bedded 30-45% of its height into the ground with a dirt skirt, because a
     * fire ring is *dug*, not arranged on the surface.
     */
    const seats = 6 + ((r() * 3) | 0);
    for (let i = 0; i < seats; i++) {
      const a = (i / seats) * Math.PI * 2 + (r() - 0.5) * 0.7;
      const rad = 1.9 + r() * 1.7;
      const s = 0.42 + r() * 0.78;
      put('rock', (r() * 6) | 0, c.x + Math.cos(a) * rad, c.z + Math.sin(a) * rad,
        s, 0.42 + r() * 0.34, s * (0.18 + r() * 0.13), tint,
        s * (0.72 + r() * 0.52), s * (0.85 + r() * 0.4), s * 1.05, 0.95);
    }
    /* backdrop blocks — give the fire something to throw light onto */
    for (let i = 0; i < 4; i++) {
      const a = r() * Math.PI * 2;
      const rad = 5.0 + r() * 6.0;
      const s = 0.9 + r() * 1.9;
      put('rock', (r() * 6) | 0, c.x + Math.cos(a) * rad, c.z + Math.sin(a) * rad,
        s, 0.3, s * 0.22, tint, s * (0.6 + r() * 0.6), s * (0.85 + r() * 0.35),
        s * 0.95, 0.9);
    }
    /* gravel spill around the pit */
    for (let i = 0; i < 34; i++) {
      const a = r() * Math.PI * 2;
      const rad = 1.2 + r() * 4.6;
      const s = 0.07 + r() * 0.22;
      put('stone', (r() * 2) | 0, c.x + Math.cos(a) * rad, c.z + Math.sin(a) * rad,
        s, 0.85, s * 0.35, tint, s * (0.5 + r() * 0.6), s, s > 0.16 ? s * 1.1 : 0, 0.45);
    }
    /* wood pile + a bucked log to sit on. The bedR is generous because a log
       lies along its length — the skirt has to reach both ends. */
    const wa = r() * Math.PI * 2;
    for (let i = 0; i < 4; i++) {
      const a = wa + (r() - 0.5) * 0.5;
      const rad = 2.6 + r() * 1.2;
      const s = 0.42 + r() * 0.3;
      put('log', i & 1, c.x + Math.cos(a) * rad, c.z + Math.sin(a) * rad,
        s, 0.85, 0.03 + r() * 0.05, wood, s * (0.8 + r() * 0.3), s,
        i === 0 ? s * 3.0 : 0, 0.85);
    }
    const sa = wa + 2.4;
    put('log', 0, c.x + Math.cos(sa) * 2.9, c.z + Math.sin(sa) * 2.9,
      0.52 + r() * 0.22, 0.9, 0.07, wood, 0.62, 0.62, 1.8, 0.9);
    put('stump', 0, c.x + Math.cos(sa + 1.1) * 3.4, c.z + Math.sin(sa + 1.1) * 3.4,
      0.75 + r() * 0.4, 0.7, 0.10, wood, null, null, 0.9, 0.95);
  }

  _tintFor(x, z, palette, salt) {
    const cx = Math.floor(x / 190), cz = Math.floor(z / 190);
    const k = (rand2(cx, cz, this.seed + salt) * palette.length) | 0;
    const t = palette[Math.min(k, palette.length - 1)];
    /* small per-instance jitter so a cluster is a family, not a clone */
    const j = 0.90 + rand2(Math.floor(x * 3), Math.floor(z * 3), this.seed + salt + 5) * 0.20;
    return [t[0] * j, t[1] * j, t[2] * j];
  }

  /* ------------------------------------------------------ regional density
   *
   * PASS 4. The old placement multiplied a per-site terrain score by a
   * two-octave cluster mask. That is still a per-instance lottery, and however
   * it is tuned it converges on an even spray — which is exactly what six
   * blind examiners saw three passes running.
   *
   * These read the shared ecological plan (vegetation/Ecology.js) instead. It
   * is winner-take-all at region scale, so most of the map returns a hard ZERO
   * for most families, and what is left is a mass with an interior gradient.
   * The terrain terms in each `accept` below still decide how much of a family
   * lands *within* its region — talus still needs a scarp above it — but they
   * no longer decide whether the region exists.
   */
  _dRock(x, z) { const e = this.eco; return e ? e.sample(e.rock, x, z) : 0.45; }
  _dStone(x, z) { const e = this.eco; return e ? e.sample(e.stone, x, z) : 0.45; }
  _dShrub(x, z) { const e = this.eco; return e ? e.sample(e.shrub, x, z) : 0.45; }
  _dTree(x, z) { const e = this.eco; return e ? e.sample(e.tree, x, z) : 0.30; }
  _dHero(x, z) { const e = this.eco; return e ? e.sample(e.hero, x, z) : 0.18; }
  _zone(x, z) { const e = this.eco; return e ? e.zoneAt(x, z) : -1; }

  /**
   * Boulders. Talus below a scarp, debris in the gullies, blocks where the
   * splat already paints bedrock — but only inside a scree apron or a rock
   * region. On open range this now returns nothing at all, which is the
   * negative space the wide shots have never had.
   */
  _emitRocks(ox, oz) {
    this._lattice(ox, oz, 11, RING.rock, 101,
      (x, z) => this._dRock(x, z) * 1.10,
      (p) => {
        if (p.water) return false;
        /* a scarp above me + a slope I can rest on = a talus apron */
        const talus = smoothstep(0.90, 0.58, p.relief) * smoothstep(0.52, 0.86, p.slope);
        const gully = smoothstep(0.02, 0.20, p.curv) * smoothstep(0.08, 0.42, p.flow);
        const bed = clamp(p.rock * 1.3, 0, 1);
        let d = 0.34 + bed * 0.80 + talus * 1.35 + gully * 0.90;
        d *= smoothstep(0.28, 0.58, p.slope);
        return clamp(d, 0, 1);
      }, 'rock');
  }

  _emitOutcrops(ox, oz) {
    /* Heroes first: the planned formations must never be starved out of the
       outcrop batches by the ordinary bedrock knuckles behind them. */
    this._emitPlannedHeroes(ox, oz);
    this._lattice(ox, oz, 54, RING.outcrop, 211,
      (x, z) => Math.max(this._dHero(x, z) * 1.30, this._dRock(x, z) * 0.62),
      (p) => {
        if (p.water) return false;
        const steep = smoothstep(0.94, 0.66, p.slope);
        const crest = smoothstep(-0.02, -0.24, p.curv);
        const bed = clamp(p.rock * 1.4, 0, 1);
        let d = 0.28 + steep * 1.05 + crest * 0.62 + bed * 0.62;
        d *= smoothstep(0.26, 0.44, p.slope); // not on sheer cliff faces
        return clamp(d, 0, 1);
      }, 'outcrop');
    this._emitLandmarks(ox, oz);
  }

  /**
   * HERO LANDMARKS — the top of the size hierarchy.
   *
   * "Uniform density gives the eye no landmark to fix on, so it cannot
   * triangulate distance and the whole valley collapses into a tabletop
   * model." Pass 3 answered that with a 12-30 m tor per 560 m, gated only on
   * a coin flip and a slope test, so the tors landed in the middle of an
   * otherwise even sprinkle of medium rocks and never read as exceptional.
   *
   * Now they are placed where the ecology says a landmark belongs — deep
   * inside an outcrop or scree region, in a thin part of the patch field so
   * they stand alone — and they are built as a COMPOSITION rather than a
   * single mesh: a main mass, two or three shoulders leaning on it, a spill of
   * shed blocks running downhill, and often a dead giant at the foot. That is
   * a thing you could climb, and it gives the near field of a wide shot the
   * dark, detailed anchor every reference frame has and ours never did.
   */
  _emitLandmarks(ox, oz) {
    const S = this.seed;
    const CELL = 370;
    const R = RING.outcrop, R2 = R * R;
    const gh = this.ctx.world.getHeight;
    const probe = this._probe;
    const i0 = Math.floor((ox - R) / CELL), i1 = Math.ceil((ox + R) / CELL);
    const j0 = Math.floor((oz - R) / CELL), j1 = Math.ceil((oz + R) / CELL);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const h = rand2(i, j, S + 3301);
        const x = (i + 0.12 + rand2(i, j, S + 3302) * 0.76) * CELL;
        const z = (j + 0.12 + rand2(i, j, S + 3303) * 0.76) * CELL;
        const dx = x - ox, dz = z - oz;
        const d2 = dx * dx + dz * dz;
        if (d2 > R2) continue;
        if (h > this._dHero(x, z) * 3.1) continue;
        probe.sample(x, z, true);
        if (probe.water || probe.slope < 0.46) continue;
        const dist = Math.sqrt(d2);
        const rnd = streamRng(((h * 4294967296) | 0) ^ 0x77a1);
        const tint = this._tintFor(x, z, ROCK_TINTS, 3);
        const nrm = { x: probe.nx, y: probe.ny, z: probe.nz };
        /* 12 m to 36 m, tail 1.35. Pass 10 drew 10-38 with a tail of 1.5, which
           in practice put most "landmarks" at 11-13 m — lost in the scrub at
           300 m. The floor is raised and the tail fattened so the median tor is
           worth walking toward. NOTE these are instance SCALES, not metres: the
           `tall` outcrop variant stands 2.36 units per unit of scaleY, so a 36
           here is already a 60-90 m formation. See Heroes.js `metrics`. */
        const s = logSize(rnd(), 12, 36, 1.35);
        this._emit('outcrop', (rnd() * 7) | 0, x, probe.y, z, s,
          rnd() * Math.PI * 2, rnd() * 0.06, nrm, 0.35, s * 0.30, tint, dist,
          s * (0.50 + rnd() * 0.55), s * (0.75 + rnd() * 0.5), s * 0.7, 0.9);

        /* shoulders — a massif, not a monolith */
        const shoulders = 2 + ((rnd() * 3) | 0);
        for (let k = 0; k < shoulders; k++) {
          const a = rnd() * Math.PI * 2;
          const rad = s * (0.30 + rnd() * 0.42);
          const px = x + Math.cos(a) * rad, pz = z + Math.sin(a) * rad;
          const ss = s * (0.35 + rnd() * 0.42);
          this._emit('outcrop', (rnd() * 7) | 0, px, gh(px, pz), pz, ss,
            rnd() * Math.PI * 2, rnd() * 0.12, nrm, 0.42, ss * 0.34, tint, dist,
            ss * (0.55 + rnd() * 0.6), ss * (0.7 + rnd() * 0.6), ss * 0.7, 0.85);
        }

        /* the spill: shed blocks running downhill from the foot, sized down a
           log-normal so the collar has its own hierarchy too */
        const blocks = 11 + ((rnd() * 11) | 0);
        for (let k = 0; k < blocks; k++) {
          const a = rnd() * Math.PI * 2;
          const rad = s * (0.42 + rnd() * 1.15);
          const px = x + Math.cos(a) * rad - probe.nx * rad * 1.5;
          const pz = z + Math.sin(a) * rad - probe.nz * rad * 1.5;
          const ss = s * logSize(rnd(), 0.025, 0.26, 2.2);
          this._emit('rock', (rnd() * 6) | 0, px, gh(px, pz), pz, ss,
            rnd() * Math.PI * 2, rnd() * 0.3, nrm, 0.5, ss * 0.3, tint, dist,
            ss * (0.7 + rnd() * 0.6), ss, ss * 0.95, 0.6);
        }

        /* A dead giant leaning on the rock. One tall black silhouette does
           more for the read of a landscape than a hundred medium shrubs. */
        if (rnd() < 0.42) {
          const a = rnd() * Math.PI * 2;
          const rad = s * (0.75 + rnd() * 0.9);
          const px = x + Math.cos(a) * rad, pz = z + Math.sin(a) * rad;
          const ts = 2.4 + rnd() * 2.1;
          this._emit('deadtree', (rnd() * 3) | 0, px, gh(px, pz), pz, ts,
            rnd() * Math.PI * 2, 0.03 + rnd() * 0.08, nrm, 0.3, 0.08,
            [0.90, 0.86, 0.80], dist, ts * (0.9 + rnd() * 0.5), ts, ts * 0.8, 0.9);
        }
      }
    }
  }

  /**
   * PLANNED HERO LANDMARKS — see scatter/Heroes.js for the argument.
   *
   * The procedural field above is a lottery; this is the guarantee. Each
   * viewpoint anchor owns one formation in its cone, chosen once at first use
   * and emitted whenever it falls inside the outcrop ring. Seven formations of
   * ~22 instances each is at most 154 instances in the whole world, and only
   * the one or two in range are ever submitted.
   */
  _emitPlannedHeroes(ox, oz) {
    if (!this._heroSites) {
      try {
        this._heroSites = planHeroes(this.ctx, this._probe, this.eco, this.seed);
      } catch (e) {
        this._heroSites = [];
        console.warn('[scatter] hero plan failed', e && e.message);
      }
    }
    const R2 = RING.outcrop * RING.outcrop;
    for (const site of this._heroSites) {
      const dx = site.x - ox, dz = site.z - oz;
      const d2 = dx * dx + dz * dz;
      if (d2 > R2) continue;
      emitHeroFormation(this, site, Math.sqrt(d2), ROCK_TINTS);
    }
  }

  /**
   * ERRATICS — the mid-size tier of the hierarchy, and the near-field anchor.
   *
   * Between the 10-38 m landmark tors and the 0.2-4 m loose rock there was
   * nothing, and on open range (which after the massing rework is genuinely
   * open) a wide shot could run 300 m of bare ground with no object in it at
   * any readable scale. Every reference frame has a dark, detailed element in
   * the near field; a group of half-buried 3-7 m blocks sitting on a flat is
   * both that element and a real thing — a glacial erratic or a shed block
   * that outlived the outcrop it came from.
   *
   * One group per ~150 m of lattice, gated on the same `hero` field the tors
   * use, so they cluster in rock country and thin out under timber instead of
   * being a second uniform layer.
   */
  _emitErratics(ox, oz) {
    const S = this.seed;
    const CELL = 95;
    const R = RING.rock, R2 = R * R;
    const gh = this.ctx.world.getHeight;
    const probe = this._probe;
    const i0 = Math.floor((ox - R) / CELL), i1 = Math.ceil((ox + R) / CELL);
    const j0 = Math.floor((oz - R) / CELL), j1 = Math.ceil((oz + R) / CELL);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const h = rand2(i, j, S + 5501);
        const x = (i + 0.10 + rand2(i, j, S + 5502) * 0.80) * CELL;
        const z = (j + 0.10 + rand2(i, j, S + 5503) * 0.80) * CELL;
        const dx = x - ox, dz = z - oz;
        const d2 = dx * dx + dz * dz;
        if (d2 > R2) continue;
        /* A floor, deliberately. Under timber a boulder group is a detail; on
           open range it is the ONLY thing at a readable scale between the
           scrub and the horizon, and a shot with 300 m of bare sand in the
           near field has nothing for the eye to measure against. One group per
           ~400 m of open ground is composition, not confetti — the confetti
           was a thousand identical medium rocks at 10 m spacing. */
        const zn = this._zone(x, z);
        const floor = (zn === ZONE.FOREST || zn === ZONE.RIPARIAN) ? 0 : 0.21;
        if (h > Math.max(this._dHero(x, z) * 2.8, floor)) continue;
        probe.sample(x, z, true);
        if (probe.water || probe.slope < 0.55) continue;
        const dist = Math.sqrt(d2);
        const rnd = streamRng(((h * 4294967296) | 0) ^ 0x3f19);
        const tint = this._tintFor(x, z, ROCK_TINTS, 3);
        const nrm = { x: probe.nx, y: probe.ny, z: probe.nz };
        /* deliberately biased LARGE — this tier exists to be big */
        const base = 2.4 + logSize(rnd(), 0.6, 5.4, 1.35);
        const n = 3 + ((rnd() * 5) | 0);
        for (let k = 0; k < n; k++) {
          const a = rnd() * Math.PI * 2;
          const rad = k === 0 ? 0 : base * (0.55 + rnd() * 1.5);
          const px = x + Math.cos(a) * rad, pz = z + Math.sin(a) * rad;
          const s = k === 0 ? base : base * logSize(rnd(), 0.10, 0.62, 1.5);
          const v = (rnd() * 6) | 0;
          this._emit('rock', v, px, k === 0 ? probe.y : gh(px, pz), pz, s,
            rnd() * Math.PI * 2, rnd() * 0.16, nrm, v === 2 || v === 3 ? 0.85 : 0.34,
            s * (0.24 + rnd() * 0.20), tint, dist,
            s * (0.70 + rnd() * 0.60), s * (0.78 + rnd() * 0.46),
            s * 0.95, clamp(0.6 + s * 0.14, 0, 1));
        }
      }
    }
  }

  _emitStones(ox, oz) {
    this._lattice(ox, oz, 3.4, RING.small, 307,
      (x, z) => this._dStone(x, z) * 1.05,
      (p, x, z) => {
        if (p.water) return false;
        const road = this.trailIndex ? this.trailIndex.distance2(x, z) : 1e9;
        const verge = road < 90 ? 0.42 : 0;
        let d = 0.34 + p.rock * 0.78 + p.dirt * 0.34 + verge
          + smoothstep(0.90, 0.62, p.relief) * 0.60;
        d *= smoothstep(0.35, 0.66, p.slope);
        return clamp(d, 0, 1);
      }, 'stone');
  }

  /**
   * Dead standing timber. Two populations with different causes: snags left
   * behind on the shoulder of a stand, and lone weather-killed giants on the
   * crests the `hero` field marks. Both were previously spread by a cluster
   * mask across every hill in the world at constant spacing.
   */
  _emitTrees(ox, oz) {
    this._lattice(ox, oz, 68, RING.tree, 401,
      (x, z) => Math.max(this._dTree(x, z) * 0.62, this._dHero(x, z) * 0.95),
      (p) => {
        if (p.water) return false;
        if (p.snow > 0.4) return false;
        const crest = smoothstep(-0.01, -0.16, p.curv);
        let d = 0.30 + crest * 0.75 + p.grass * 0.35 + p.dirt * 0.25;
        d *= smoothstep(0.55, 0.86, p.slope);
        return clamp(d, 0, 1);
      }, 'tree');
  }

  _emitDeadwood(ox, oz) {
    const S = this.seed;
    /* Forest litter. Deadfall belongs on a forest floor, not on open range —
       and forest_interior needs it badly, because a floor with nothing lying
       on it is the fastest way to make an interior read as a bare lot. */
    this._lattice(ox, oz, 15, RING.wood, 503,
      (x, z) => this._dTree(x, z) * 1.15,
      (p) => {
        if (p.water) return false;
        let d = 0.30 + (p.grass * 0.9 + p.dirt * 0.5) * 0.7;
        d *= smoothstep(0.66, 0.90, p.slope);
        return clamp(d, 0, 1);
      }, 'deadwood');
    /* driftwood: at the water line, where the flow map says a bank exists */
    this._lattice(ox, oz, 15, RING.wood, 607,
      (x, z) => 0.60 * clusterMask(x, z, S + 151, 140, 38, 0.18),
      (p) => {
        if (p.water) return false;
        const wl = this.ctx.world.waterLevel || 18;
        const bank = smoothstep(0.34, 0.72, p.flow) * smoothstep(4.2, 0.4, Math.abs(p.y - wl) * 0.4 + 0.4);
        const near = smoothstep(0.40, 0.80, p.flow);
        let d = near * 0.55 + bank * 0.35;
        d *= smoothstep(0.70, 0.93, p.slope);
        return clamp(d, 0, 1) * 0.55;
      }, 'drift');
  }

  _emitBushes(ox, oz) {
    this._lattice(ox, oz, 4.4, RING.bush, 701,
      (x, z) => this._dShrub(x, z) * 1.10,
      (p, x, z) => {
        if (p.water) return false;
        if (p.snow > 0.55) return false;
        const road = this.trailIndex ? this.trailIndex.distance2(x, z) : 1e9;
        if (road < 6.5) return false;
        const arid = clamp(p.sand * 1.1 + p.dirt * 0.55, 0, 1);
        const green = clamp(p.grass * 1.15, 0, 1);
        const moist = smoothstep(0.20, 0.62, p.flow) * 0.35;
        let d = 0.42 + green * 0.75 + arid * 0.50 + moist;
        d *= smoothstep(0.42, 0.74, p.slope);
        d *= 1 - smoothstep(430, 560, p.y) * 0.8;
        return clamp(d, 0, 1);
      }, 'bush');
  }

  _emitSucculents(ox, oz) {
    this._lattice(ox, oz, 12, RING.plant, 809,
      (x, z) => this._dShrub(x, z) * 0.92,
      (p, x, z) => {
        if (p.water) return false;
        if (p.snow > 0.25) return false;
        /* Cactus is a statement about climate, so it is zoned, not sprayed:
           desert pavement, sage flat and scree only. A saguaro standing in a
           riparian gallery is the kind of detail that reads as procedural. */
        const zn = this._zone(x, z);
        if (zn === ZONE.FOREST || zn === ZONE.RIPARIAN || zn === ZONE.GRASSLAND) return false;
        const road = this.trailIndex ? this.trailIndex.distance2(x, z) : 1e9;
        if (road < 8) return false;
        const arid = clamp(p.sand * 1.3 + p.dirt * 0.75 - p.grass * 0.95, 0, 1);
        let d = arid * 1.0 + 0.22;
        d *= smoothstep(0.55, 0.84, p.slope);
        d *= 1 - smoothstep(340, 500, p.y) * 0.85;
        return clamp(d, 0, 1);
      }, 'succulent');
  }

  _emitBones(ox, oz) {
    const S = this.seed;
    this._lattice(ox, oz, 52, RING.small, 907,
      (x, z) => 0.55 * rarePatch(x, z, S + 211, 260),
      (p, x, z) => {
        if (p.water) return false;
        const zn = this._zone(x, z);
        if (zn === ZONE.FOREST || zn === ZONE.RIPARIAN) return false;
        const dry = clamp(p.sand * 1.2 + p.dirt * 0.8 - p.grass * 0.4, 0, 1);
        let d = dry * 0.7;
        d *= smoothstep(0.78, 0.95, p.slope);
        return clamp(d, 0, 1) * 0.55;
      }, 'bones');
  }

  /* ------------------------------------------------------ human structures */

  _emitFences(ox, oz) {
    if (!this._fences) {
      const probe = this._probe;
      const anchors = findAnchors(this.ctx, probe, {
        seed: this.seed + 991,
        spacing: 620,
        count: 40,
        test: (pr) => !pr.water && pr.slope > 0.955 && (pr.grass + pr.dirt) > 0.45,
      });
      this._fences = [];
      for (const a of anchors) {
        const r = streamRng(((a.h * 4294967296) | 0) ^ 0x51ed);
        const rot = r() * Math.PI * 2;
        const w = 26 + r() * 62;
        const d = 20 + r() * 46;
        const closed = r() > 0.35;
        const corners = [
          [-w * 0.5, -d * 0.5], [w * 0.5, -d * 0.5], [w * 0.5, d * 0.5], [-w * 0.5, d * 0.5],
        ].map((c) => [
          a.x + c[0] * Math.cos(rot) - c[1] * Math.sin(rot),
          a.z + c[0] * Math.sin(rot) + c[1] * Math.cos(rot),
        ]);
        const runs = closed ? 4 : 2 + ((r() * 2) | 0);
        for (let i = 0; i < runs; i++) {
          this._fences.push([corners[i % 4], corners[(i + 1) % 4]]);
        }
      }
    }
    const gh = this.ctx.world.getHeight;
    const probe = this._probe;
    const R = RING.fence, R2 = R * R;
    const tint = [1, 1, 1];
    for (const [A, B] of this._fences) {
      const mx = (A[0] + B[0]) * 0.5, mz = (A[1] + B[1]) * 0.5;
      const ddx = mx - ox, ddz = mz - oz;
      if (ddx * ddx + ddz * ddz > (R + 90) * (R + 90)) continue;
      let dx = B[0] - A[0], dz = B[1] - A[1];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      const span = 2.55;
      const n = Math.max(2, Math.round(len / span));
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = A[0] + dx * len * t;
        const z = A[1] + dz * len * t;
        const px = x - ox, pz = z - oz;
        const d2 = px * px + pz * pz;
        const y = gh(x, z);
        if (d2 > R2) { prev = null; continue; }
        probe.sample(x, z, false);
        if (probe.slope < 0.80) { prev = null; continue; }
        const dist = Math.sqrt(d2);
        const r = streamRng((Math.floor(x * 7.3) * 73856093) ^ (Math.floor(z * 7.3) * 19349663));
        const missing = r() < 0.07;
        if (!missing) {
          this._emit('post', (i & 1), x, y, z, 1, r() * 0.4, 0.02 + r() * 0.07,
            { x: probe.nx, y: probe.ny, z: probe.nz }, 0.45, 0.06, tint, dist,
            null, null, 0.30, 0.85);
        }
        if (prev && !missing && r() > 0.10) {
          const mxx = (prev.x + x) * 0.5, mzz = (prev.z + z) * 0.5;
          const myy = (prev.y + y) * 0.5;
          const seg = Math.hypot(x - prev.x, z - prev.z);
          const yaw = Math.atan2(-(z - prev.z), (x - prev.x));
          const pitch = Math.atan2(y - prev.y, seg);
          for (let k = 0; k < 2; k++) {
            const hh = 0.42 + k * 0.36;
            this._euler.set(0, yaw, pitch, 'YZX');
            this._q.setFromEuler(this._euler);
            this._scale.set(seg * 1.02, 1, 1);
            this._v.set(mxx, myy + hh, mzz);
            this._m4.compose(this._v, this._q, this._scale);
            const kind = this.kinds.get('rail');
            kind.add(this._m4, tint, dist, 0);
          }
        }
        prev = { x, y, z };
      }
    }
  }

  _emitRuins(ox, oz) {
    if (!this._ruins) {
      const probe = this._probe;
      const anchors = findAnchors(this.ctx, probe, {
        seed: this.seed + 1777,
        spacing: 1150,
        count: 16,
        test: (pr) => !pr.water && pr.slope > 0.94,
      });
      this._ruins = anchors;
    }
    const gh = this.ctx.world.getHeight;
    const R = RING.ruin, R2 = R * R;
    const tint = [1, 1, 1];
    for (const a of this._ruins) {
      const dx = a.x - ox, dz = a.z - oz;
      const d2 = dx * dx + dz * dz;
      if (d2 > R2) continue;
      const dist = Math.sqrt(d2);
      const r = streamRng(((a.h * 4294967296) | 0) ^ 0x9e37);
      const rot = r() * Math.PI * 2;
      const w = 5.5 + r() * 5.5;
      const d = 4.5 + r() * 4.5;
      const walls = [
        [-w * 0.5, -d * 0.5, w * 0.5, -d * 0.5],
        [w * 0.5, -d * 0.5, w * 0.5, d * 0.5],
        [w * 0.5, d * 0.5, -w * 0.5, d * 0.5],
        [-w * 0.5, d * 0.5, -w * 0.5, -d * 0.5],
      ];
      const keep = 2 + ((r() * 3) | 0);
      for (let i = 0; i < walls.length; i++) {
        if (i >= keep) continue;
        const s = walls[i];
        const ax = a.x + s[0] * Math.cos(rot) - s[1] * Math.sin(rot);
        const az = a.z + s[0] * Math.sin(rot) + s[1] * Math.cos(rot);
        const bx = a.x + s[2] * Math.cos(rot) - s[3] * Math.sin(rot);
        const bz = a.z + s[2] * Math.sin(rot) + s[3] * Math.cos(rot);
        const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
        const seg = Math.hypot(bx - ax, bz - az);
        const yaw = Math.atan2(-(bz - az), (bx - ax));
        const y = gh(mx, mz);
        this._q.setFromAxisAngle(this._up, yaw);
        this._scale.set(seg, 1.0 + r() * 0.5, 1);
        this._v.set(mx, y - 0.22, mz);
        this._m4.compose(this._v, this._q, this._scale);
        const kind = this.kinds.get('ruin');
        kind.add(this._m4, tint, dist, i & 1);
        /* Ruin walls bypass `_emit`, so they register their own capsule. A wall
           is the one prop whose proxy is exact: a segment with a thickness. */
        if (this.collision && dist < 78) {
          const rb = this._propBounds(kind, i & 1);
          if (rb) {
            this.collision.offer('ruin', dist, mx, y - 0.22, mz,
              rb.hx * seg, rb.hz, rb.h * this._scale.y, yaw);
          }
        }
        /* Collapsed walls leave their own rubble. Without it the wall is a
           rectangular slab pushed into the ground — which is exactly how the
           forensic pass read it: "Hard rectangular silhouette, no organic
           outline." */
        if (this.bedding) this.bedding.add(mx, mz, seg * 0.42, dist, 0.85);
        const rub = 4 + ((r() * 5) | 0);
        const rtint = this._tintFor(a.x, a.z, ROCK_TINTS, 3);
        for (let k = 0; k < rub; k++) {
          const t = r();
          const side = (r() - 0.5) * 2.2;
          const px = ax + (bx - ax) * t - Math.sin(yaw) * 0 + Math.cos(yaw + Math.PI * 0.5) * side;
          const pz = az + (bz - az) * t + Math.sin(yaw + Math.PI * 0.5) * side;
          const ss = 0.16 + r() * 0.34;
          this._emit('stone', (r() * 2) | 0, px, gh(px, pz), pz, ss,
            r() * Math.PI * 2, r() * 0.4, this._up, 0.5, ss * 0.35, rtint, dist,
            ss * (0.5 + r() * 0.6), ss, ss * 1.1, 0.5);
        }
      }
    }
  }

  /* ------------------------------------------------ per-candidate placement */

  /**
   * Decide *what* the accepted candidate is and hand it to `_emit`. Which kind
   * it becomes is derived from the terrain at the site, so the arid flats grow
   * cactus and the grassy benches grow sage, without a separate lattice pass.
   */
  _place(p, x, z, dist, rnd) {
    const n = { x: p.nx, y: p.ny, z: p.nz };
    const kindHint = this._hint;
    const u = rnd();

    switch (kindHint) {
      case 'rock': {
        const tint = this._tintFor(x, z, ROCK_TINTS, 3);
        const zn = this._zone(x, z);
        const bigCountry = zn === ZONE.SCREE || zn === ZONE.OUTCROP;
        /* SIZE HIERARCHY. `sizeDist(u, lo, hi, 1.55)` is very nearly uniform
           in log space, which is precisely why every examiner reported "every
           rock is roughly the same size". A real boulder field is mostly
           cobble with a few blocks you could shelter behind, so the tail
           exponent goes to 3.1 and the ceiling doubles inside rock country. */
        const base = logSize(rnd(), 0.24, bigCountry ? 10.5 : 4.4, 3.1);
        /* Rocks arrive in families: one parent plus a few smaller satellites
           shed from the same block. A field of independent singletons reads as
           a sprinkle; a field of groups reads as geology. On a talus site the
           satellites also run downhill, because that is where they went. */
        const sats = base > 1.1 ? 2 + ((rnd() * 5) | 0) : (rnd() < 0.5 ? 1 : 0);
        const downX = -p.nx, downZ = -p.nz;
        const talus = clamp((1 - p.slope) * 4, 0, 1);
        for (let k = 0; k <= sats; k++) {
          const s = k === 0 ? base : base * (0.20 + rnd() * 0.44);
          if (s < 0.10) continue;
          const a = rnd() * Math.PI * 2;
          const rad = k === 0 ? 0 : base * (0.9 + rnd() * 2.6);
          const px = x + Math.cos(a) * rad + downX * rad * talus * 1.6;
          const pz = z + Math.sin(a) * rad + downZ * rad * talus * 1.6;
          const py = k === 0 ? p.y : this.ctx.world.getHeight(px, pz);
          const variant = (rnd() * 6) | 0;
          const flat = variant === 2 || variant === 3;
          const align = flat ? 0.90 : 0.28 + rnd() * 0.32;
          /* Sink is up 3x on pass 2. A boulder that has sat on a hillside for
             ten thousand years is buried to a fifth of its height in its own
             weathering debris; one that touches the ground on a tangent point
             reads as a prop dropped by a level editor. */
          this._emit('rock', variant, px, py, pz, s,
            rnd() * Math.PI * 2, rnd() * 0.20, n, align,
            s * (0.22 + rnd() * 0.20), tint, dist,
            s * (0.72 + rnd() * 0.62), s * (0.78 + rnd() * 0.48),
            s * 0.92, clamp(0.55 + s * 0.22, 0, 1));
        }
        break;
      }
      case 'outcrop': {
        const variant = (rnd() * 7) | 0;
        const s = logSize(rnd(), 1.9, 23.0, 2.5);
        const tint = this._tintFor(x, z, ROCK_TINTS, 3);
        this._emit('outcrop', variant, x, p.y, z, s,
          rnd() * Math.PI * 2, rnd() * 0.10, n, 0.55,
          s * (0.26 + rnd() * 0.22), tint, dist,
          s * (0.55 + rnd() * 0.55), s * (0.8 + rnd() * 0.5),
          s * 0.85, 0.85);
        /* the debris apron every scarp foot has, and never had before */
        const skirt = 3 + ((rnd() * 5) | 0);
        for (let k = 0; k < skirt; k++) {
          const a = rnd() * Math.PI * 2;
          const rad = s * (0.55 + rnd() * 0.85);
          const px = x + Math.cos(a) * rad - p.nx * rad * 1.2;
          const pz = z + Math.sin(a) * rad - p.nz * rad * 1.2;
          const ss = s * (0.06 + rnd() * 0.16);
          this._emit('rock', (rnd() * 6) | 0, px, this.ctx.world.getHeight(px, pz), pz, ss,
            rnd() * Math.PI * 2, rnd() * 0.3, n, 0.6, ss * 0.3, tint, dist,
            ss * (0.7 + rnd() * 0.6), ss, ss * 0.9, 0.5);
        }
        break;
      }
      case 'stone': {
        const variant = (rnd() * 2) | 0;
        const s = logSize(rnd(), 0.05, 1.05, 2.7);
        const tint = this._tintFor(x, z, ROCK_TINTS, 3);
        this._emit('stone', variant, x, p.y, z, s,
          rnd() * Math.PI * 2, rnd() * 0.3, n, 0.8,
          s * (0.32 + rnd() * 0.3), tint, dist,
          s * (0.5 + rnd() * 0.6), s * (0.8 + rnd() * 0.4),
          s > 0.20 ? s * 1.0 : 0, 0.45);
        break;
      }
      case 'tree': {
        const variant = (rnd() * 3) | 0;
        /* one in fourteen is a weather-killed giant — the dark vertical the
           near field of a wide shot needs to give the valley a scale */
        const s = rnd() < 0.072 ? 2.6 + rnd() * 2.0 : logSize(rnd(), 0.62, 2.15, 1.9);
        const tint = [0.94 + rnd() * 0.2, 0.90 + rnd() * 0.18, 0.84 + rnd() * 0.16];
        this._emit('deadtree', variant, x, p.y, z, s,
          rnd() * Math.PI * 2, rnd() * 0.05, n, 0.35, 0.05, tint, dist,
          s * (0.85 + rnd() * 0.45), s, s * 0.7, 0.9);
        break;
      }
      case 'deadwood': {
        const tint = [0.92 + rnd() * 0.22, 0.88 + rnd() * 0.2, 0.82 + rnd() * 0.18];
        if (u < 0.55) {
          const s = 0.55 + rnd() * 1.1;
          this._emit('log', (rnd() * 2) | 0, x, p.y, z, s,
            rnd() * Math.PI * 2, rnd() * 0.12, n, 0.75, s * 0.16, tint, dist,
            s * (0.8 + rnd() * 0.4), s, s * 1.9, 0.8);
        } else {
          const s = 0.6 + rnd() * 0.9;
          this._emit('stump', 0, x, p.y, z, s,
            rnd() * Math.PI * 2, rnd() * 0.1, n, 0.55, s * 0.12, tint, dist,
            null, null, s * 0.7, 0.95);
        }
        break;
      }
      case 'drift': {
        const s = 0.5 + rnd() * 0.9;
        const tint = [1.28 + rnd() * 0.2, 1.22 + rnd() * 0.16, 1.12 + rnd() * 0.14];
        this._emit('driftwood', (rnd() * 2) | 0, x, p.y, z, s,
          rnd() * Math.PI * 2, rnd() * 0.2, n, 0.85, s * 0.14, tint, dist,
          s * (0.75 + rnd() * 0.4), s, s * 1.6, 0.7);
        break;
      }
      case 'bush': {
        const variant = (rnd() * 4) | 0;
        const dry = clamp(p.sand * 1.1 + p.dirt * 0.5 - p.grass * 0.6, 0, 1);
        const zn = this._zone(x, z);
        /* Understorey is not rangeland. Under a closed canopy a shrub is
           shade-adapted and sees a fraction of the sky, so it is green and
           dark; the sun-killed straw palette on a forest floor was reading as
           a bank of pale paddles glowing in the shade — the single most
           distracting thing left in forest_interior. */
        const shaded = zn === ZONE.FOREST || zn === ZONE.RIPARIAN;
        const pal = shaded ? [FOLIAGE_TINTS[0], FOLIAGE_TINTS[2]]
          : (dry > 0.45 ? [FOLIAGE_TINTS[1], FOLIAGE_TINTS[3]] : FOLIAGE_TINTS);
        const tint = this._tintFor(x, z, pal, 9);
        if (shaded) { tint[0] *= 0.52; tint[1] *= 0.58; tint[2] *= 0.50; }
        /* Measured, not guessed: at the high_noon camera the ecology reports a
           shrub density of 0.98 — the sage flat is genuinely there — and the
           frame still read as bare sand with dots on it, because the median
           bush was 0.54 m. A mass you cannot resolve is not a mass. Median is
           now ~0.95 m with a real tail to 2.5-4 m, so a thicket reads as one
           body of scrub rather than as scattered specks. */
        const s = logSize(rnd(), shaded ? 0.42 : 0.55, shaded ? 2.4 : 4.2, 1.9);
        this._emit('bush', variant, x, p.y, z, s,
          rnd() * Math.PI * 2, rnd() * 0.06, n, 0.5, s * 0.10, tint, dist,
          s * (0.7 + rnd() * 0.7), s * (0.85 + rnd() * 0.3),
          s > 1.1 ? s * 0.6 : 0, 0.55);
        break;
      }
      case 'succulent': {
        const tint = [0.92 + rnd() * 0.22, 0.94 + rnd() * 0.16, 0.84 + rnd() * 0.2];
        const hot = clamp(p.sand * 1.2 - p.grass, 0, 1);
        if (u < 0.30) {
          const s = 0.7 + rnd() * 1.9;
          this._emit('yucca', (rnd() * 2) | 0, x, p.y, z, s,
            rnd() * Math.PI * 2, rnd() * 0.07, n, 0.6, s * 0.08, tint, dist,
            null, null, s * 0.55, 0.75);
        } else if (u < 0.56) {
          const s = 0.75 + rnd() * 1.5;
          this._emit('agave', 0, x, p.y, z, s,
            rnd() * Math.PI * 2, rnd() * 0.06, n, 0.7, s * 0.09, tint, dist,
            null, null, s * 0.5, 0.75);
        } else if (u < 0.79) {
          const s = 0.55 + rnd() * 0.85;
          this._emit('pear', 0, x, p.y, z, s,
            rnd() * Math.PI * 2, rnd() * 0.08, n, 0.5, s * 0.08, tint, dist,
            s * (0.8 + rnd() * 0.5), s, s * 0.45, 0.7);
        } else if (hot > 0.18) {
          /* Columnar cactus is the only vertical on a desert flat, and a flat
             with no verticals in it has no scale. Worth over-representing. */
          const s = 0.85 + rnd() * 1.05;
          this._emit('saguaro', (rnd() * 2) | 0, x, p.y, z, s,
            rnd() * Math.PI * 2, rnd() * 0.03, n, 0.25, s * 0.10, tint, dist,
            s * (0.8 + rnd() * 0.6), s, s * 0.55, 0.95);
        }
        break;
      }
      case 'bones': {
        const tint = [1, 1, 1];
        if (u < 0.45) {
          const s = 0.8 + rnd() * 0.7;
          this._emit('skull', 0, x, p.y, z, s,
            rnd() * Math.PI * 2, 0.1 + rnd() * 0.5, n, 0.9, s * 0.04, tint, dist);
        } else {
          const s = 0.8 + rnd() * 0.8;
          this._emit('bones', 0, x, p.y, z, s,
            rnd() * Math.PI * 2, rnd() * 0.2, n, 0.9, s * 0.02, tint, dist);
        }
        if (rnd() > 0.72) {
          const s = 0.5 + rnd() * 0.5;
          this._emit('tumble', 0, x, p.y, z, s,
            rnd() * Math.PI * 2, rnd() * 0.4, n, 0.4, 0, tint, dist);
        }
        break;
      }
      default: break;
    }
  }

  /* ---------------------------------------------------------------- frame */

  update(dt) {
    const ctx = this.ctx;
    if (!this.group) return;
    this._time += dt;

    const env = ctx.env;
    const w = env.windVector;
    const wind = {
      x: w ? w.x : 1,
      z: w ? w.z : 0,
      strength: clamp((env.windStrength || 2) * 0.14 + (env.windGust || 0) * 0.5, 0.1, 2.2),
    };
    for (const m of this.materials) {
      updateScatterMaterial(m, { wetness: env.wetness || 0, wind, time: this._time });
    }

    const cam = ctx.camera.position;
    const dx = cam.x - this._origin.x, dz = cam.z - this._origin.z;
    if (this._queue.length === 0 && (dx * dx + dz * dz) > 26 * 26) {
      this._rebuild(cam.x, cam.z, !!this._flushAll);
      this._flushAll = false;
    } else if (this._queue.length) {
      /* amortised: a couple of emitters per frame keeps the hitch invisible */
      const t0 = performance.now();
      while (this._queue.length && performance.now() - t0 < 5) this._queue.shift()();
      if (this._queue.length === 0) this._finish();
    }

    /* Hand Physics the capsules the player could actually touch. Internally
       gated on 2 m of player movement, so on a typical frame this is a subtract
       and a compare. */
    if (this.collision) {
      this.collision.stream();
      this.stats.collidersActive = this.collision.stats.active;
    }
  }

  dispose() {
    const ctx = this.ctx;
    if (this.group) {
      this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      ctx.scene.remove(this.group);
    }
    for (const m of this.materials) m.dispose();
    if (this.bedding) this.bedding.dispose();
    if (this.collision) this.collision.dispose();
    if (this.bushAtlas) this.bushAtlas.dispose();
    if (this.plantSkin) this.plantSkin.dispose();
    if (this._packed) for (const t of this._packed) t.dispose();
  }
}
