import * as THREE from 'three';
import { perlin2, fbm, worley, setBandLimit } from './Noise.js';
import { RECIPES, RECIPE_NAMES } from './Recipes.js';
import { bakeSurface, heightToNormal, normalTextureFrom, buildAlphaMips, releaseScratch } from './Bake.js';
import { makeDetailTexture, injectDetail, HEX_TILE_GLSL } from './Detail.js';
import { buildLeafAtlas, buildScrubAtlas } from './LeafAtlas.js';

/**
 * ProcTextures — the runtime procedural PBR material library.
 *
 * PASS 3. Every forensic report independently reached the same conclusion about
 * surfaces, so this module was rebuilt around the three things they measured:
 *
 *  1. TEXEL DENSITY / DETAIL BANDWIDTH. Recipes are now three explicitly
 *     weighted bands (metres / decimetres / millimetres) evaluated on a pyramid
 *     — see Recipes.js. The decimetre band the critics said was missing
 *     (cracks, plates, plank seams, mortar, individual pebbles) carries a third
 *     of the signal instead of 14%.
 *
 *  2. EDGE WEAR AND CAVITY DIRT. Bake.js solves cavity/convexity over the
 *     finished height field and drives grime into crevices and bleached
 *     chipping onto convex arrises for all 35 surfaces at once.
 *
 *  3. PERIODICITY. Every lattice in the library (brick courses, plank pitch,
 *     shingle rows, corrugation, Worley cell counts) is now jittered by
 *     `partition1` or a domain warp, and `HEX_TILE_GLSL` is exported so
 *     consumers can remove the tile repeat outright.
 *
 * Public API is unchanged and frozen (CONTRACTS §4.1); everything new is
 * additive.
 */

/* Re-exported so nothing that imported these from here breaks. */
export { perlin2, fbm, worley, setBandLimit };

/**
 * Surfaces whose only consumer is the terrain splat. `buildLayerArrays` box-
 * downs every one of them to 512 before they reach the GPU, so baking them at
 * 1024 was 1.2 s of boot spent generating detail that was averaged away in the
 * same frame.
 */
const TERRAIN_LAYERS = new Set([
  'grass_prairie', 'grass_dry', 'dirt_dry', 'rock_cliff', 'scree', 'sand_fine', 'snow',
]);

/**
 * Surfaces the world needs to boot, in the order the systems ask for them.
 * The pool works down this list on background threads while the main thread is
 * busy with terrain erosion and geometry, so by the time a system calls `get()`
 * the answer is usually already sitting in the cache.
 */
const PREBAKE = [
  'grass_prairie', 'grass_dry', 'dirt_dry', 'rock_cliff', 'scree', 'sand_fine', 'snow',
  'bark_pine', 'bark_oak', 'bark_birch', 'rock_boulder', 'adobe', 'dirt_packed',
  'wood_plank', 'wood_weathered', 'wood_painted', 'stone_block', 'shingle',
  'corrugated_iron', 'metal_rusted', 'canvas_tent', 'hay', 'rock_slab', 'gravel',
];

/* ---------------------------------------------------------------- system */

export class ProcTextures {
  static id = 'procTextures';

  constructor(ctx) {
    this.ctx = ctx;
    this._cache = new Map();
    this._materials = new Map();
    this._atlases = new Map();
    this._detail = null;
    /** Default authoring resolution; scaled down on weaker presets. */
    this.size = ctx.quality.name === 'low' ? 256 : ctx.quality.name === 'medium' ? 512 : 1024;
    this.aniso = Math.min(ctx.quality.anisotropy, ctx.caps ? ctx.caps.aniso : 8);
    /** Bytes of GPU texture created by this system, mips included. */
    this.bytes = 0;
    this._bakeMs = 0;
    /** GLSL helper exposed to consumers that want stochastic tiling. */
    this.hexTileGLSL = HEX_TILE_GLSL;

    /* --- background bake pool (see BakeWorker.js) --- */
    this._pool = [];
    this._jobs = new Map();     // name -> true while a worker owns it
    this._poolOk = false;
  }

  /** Authoring resolution for one surface. */
  _sizeFor(name) {
    return TERRAIN_LAYERS.has(name) ? Math.min(this.size, 512) : this.size;
  }

  /**
   * Kick the background bake pool. Deliberately NOT awaited: every surface is
   * still available synchronously through `get()`, which falls back to baking on
   * the main thread if a worker has not finished that one yet. The point is
   * purely that the ~5 s of pure-CPU surface generation overlaps the ~4 s of
   * terrain erosion and the ~4 s of geometry work that follow, instead of
   * running before them.
   */
  async init() {
    if (typeof Worker === 'undefined') return;
    let n = 4;
    try {
      n = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 2));
    } catch (e) { n = 3; }
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./BakeWorker.js', import.meta.url), { type: 'module' });
        w.onmessage = (e) => this._onBaked(e.data);
        w.onerror = () => { this._poolOk = false; };
        w.__busy = false;
        this._pool.push(w);
      }
      this._poolOk = true;
      this._queue = PREBAKE.filter((nm) => RECIPES[nm] && !RECIPES[nm].atlas);
      this._pumpPool();
    } catch (e) {
      this._poolOk = false;
      for (const w of this._pool) { try { w.terminate(); } catch (err) { /* gone */ } }
      this._pool.length = 0;
    }
  }

  _pumpPool() {
    if (!this._poolOk) return;
    for (const w of this._pool) {
      if (w.__busy) continue;
      let name = null;
      while (this._queue.length) {
        const cand = this._queue.shift();
        if (!this._cache.has(cand) && !this._jobs.has(cand)) { name = cand; break; }
      }
      if (!name) return;
      w.__busy = true;
      this._jobs.set(name, true);
      w.postMessage({
        id: name, name, wi: this._pool.indexOf(w), size: this._sizeFor(name),
        disp: RECIPES[name] && RECIPES[name].disp,
      });
    }
  }

  _onBaked(d) {
    const w = this._pool[d.wi];
    if (w) w.__busy = false;
    this._jobs.delete(d.name);
    if (!d.error && !this._cache.has(d.name)) {
      const S = d.size;
      const set = {
        map: this._mk(d.albedo, S, true, false),
        normalMap: normalTextureFrom(d.normal, S, this.aniso),
        roughnessMap: this._mk(d.rough, S, false, false),
        aoMap: this._mk(d.ao, S, false, false),
        displacementMap: null,
        heightData: d.raw,
        metalness: (RECIPES[d.name] && RECIPES[d.name].metal) || 0,
        transparent: !!(RECIPES[d.name] && RECIPES[d.name].alpha),
        size: S,
      };
      this.bytes += d.normal.length * 4 / 3;
      this._cache.set(d.name, set);
    }
    this._pumpPool();
  }

  has(name) { return !!RECIPES[name]; }
  names() { return RECIPE_NAMES.slice(); }

  /** Deterministic fBm sampler exposed to other systems. */
  noise2D(x, y, opts) { return fbm(x, y, opts); }

  makeCanvas(size = this.size) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    return { canvas, ctx2d: canvas.getContext('2d', { willReadFrequently: true }) };
  }

  toTexture(canvas, { srgb = false, repeat = 1, aniso = this.aniso } = {}) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = aniso;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }

  /** Sobel a height field into a tangent-space normal map (linear DataTexture). */
  heightToNormal(height, w, h, strength = 2.0) {
    /* the contract signature takes (data, w, h); square fields only */
    return heightToNormal(height, w, strength, this.aniso);
  }

  /**
   * Coverage-preserving, premultiplied mip chain for an alpha-tested RGBA
   * buffer. Exposed so Vegetation/Scatter can fix their own atlases:
   *
   *   tex.generateMipmaps = false;
   *   tex.mipmaps = proc.alphaMips( rgba, size, 0.42 );
   *   material.alphaTest = 0.42;  material.alphaToCoverage = true;
   */
  alphaMips(rgba, size, alphaTest = 0.42) { return buildAlphaMips(rgba, size, alphaTest); }

  /** The shared near-field detail texture (RG = normal.xy, B = grain). */
  get detailTexture() {
    if (!this._detail) {
      this._detail = makeDetailTexture(this.size >= 1024 ? 512 : 256, this.aniso);
      this.bytes += this._detail.image.data.length * 4 / 3;
    }
    return this._detail;
  }

  /**
   * Blend the shared detail layer into any MeshStandardMaterial.
   * @param {THREE.Material} material
   * @param {{scale?:number,strength?:number,contrast?:number,fade?:number}} o
   */
  injectDetail(material, o = {}) { return injectDetail(material, this.detailTexture, o); }

  /**
   * The leaf atlas — 16 distinct leaves with veins, damage and clean alpha.
   * @returns {{texture:THREE.Texture, rects:Array, cols:number, size:number}}
   */
  leafAtlas() {
    if (!this._atlases.has('leaf')) {
      const a = buildLeafAtlas(this.size, (this.ctx.seed ^ 0x5f3a91) >>> 0, this.aniso);
      this.bytes += a.size * a.size * 4 * 4 / 3;
      this._atlases.set('leaf', a);
    }
    return this._atlases.get('leaf');
  }

  /** Sagebrush sprig atlas for `foliage_scrub`. */
  scrubAtlas() {
    if (!this._atlases.has('scrub')) {
      const s = Math.max(256, this.size >> 1);
      const a = buildScrubAtlas(s, (this.ctx.seed ^ 0x2b71c5) >>> 0, this.aniso);
      this.bytes += s * s * 4 * 4 / 3;
      this._atlases.set('scrub', a);
    }
    return this._atlases.get('scrub');
  }

  /* ------------------------------------------------------------- baking */

  _mk(buf, S, srgb, clamp) {
    const t = new THREE.DataTexture(buf, S, S, THREE.RGBAFormat);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.anisotropy = this.aniso;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    this.bytes += buf.length * 4 / 3;
    return t;
  }

  /** Alpha-tested foliage sets are atlases, not tiling surfaces. */
  _buildAtlasSet(name, recipe) {
    const a = recipe.atlas === 'leaf' ? this.leafAtlas() : this.scrubAtlas();
    const S = a.size;
    const N = S * S;
    /* derive relief from the atlas' own luminance so leaves catch a specular
       break; a flat normal is exactly what made them read as paper cut-outs */
    const src = a.height || null;
    const h = new Float32Array(N);
    const d = a.texture.image.data;
    for (let i = 0; i < N; i++) {
      h[i] = src ? src[i]
        : (d[i * 4] * 0.30 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) / 255 * (d[i * 4 + 3] / 255);
    }
    const nrm = heightToNormal(h, S, (recipe.disp || 0.4) * 2.2, this.aniso);
    nrm.wrapS = nrm.wrapT = THREE.ClampToEdgeWrapping;
    this.bytes += nrm.image.data.length * 4 / 3;

    const rough = new Uint8Array(N * 4);
    const ao = new Uint8Array(N * 4);
    const r0 = recipe.rough[0], r1 = recipe.rough[1];
    for (let i = 0; i < N; i++) {
      const j = i * 4;
      const v = r0 + (r1 - r0) * (1 - h[i]);
      rough[j] = rough[j + 1] = rough[j + 2] = v * 255;
      rough[j + 3] = 255;
      const o = 0.62 + h[i] * 0.38;
      ao[j] = ao[j + 1] = ao[j + 2] = o * 255;
      ao[j + 3] = 255;
    }
    const set = {
      map: a.texture,
      normalMap: nrm,
      roughnessMap: this._mk(rough, S, false, true),
      aoMap: this._mk(ao, S, false, true),
      displacementMap: null,
      heightData: h,
      metalness: 0,
      transparent: true,
      alphaTest: 0.42,
      atlasRects: a.rects || null,
      atlasCols: a.cols || 4,
      size: S,
    };
    this._cache.set(name, set);
    return set;
  }

  /** Build (and cache) the full PBR set for a named surface. */
  get(name) {
    if (this._cache.has(name)) return this._cache.get(name);
    const recipe = RECIPES[name] || RECIPES.dirt_dry;
    if (recipe.atlas) return this._buildAtlasSet(name, recipe);

    const S = this._sizeFor(name);
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    // A worker may already own this one; we cannot wait for it synchronously, so
    // bake it here and let the worker's result be discarded on arrival.
    const baked = bakeSurface(recipe, S);
    const set = {
      map: this._mk(baked.albedo, S, true, false),
      normalMap: heightToNormal(baked.height, S, (recipe.disp || 0.5) * 3.1, this.aniso),
      roughnessMap: this._mk(baked.rough, S, false, false),
      aoMap: this._mk(baked.ao, S, false, false),
      displacementMap: null,
      heightData: baked.raw,
      metalness: recipe.metal || 0,
      transparent: !!recipe.alpha,
      size: S,
    };
    this.bytes += set.normalMap.image.data.length * 4 / 3;
    this._bakeMs += ((typeof performance !== 'undefined') ? performance.now() : 0) - t0;
    this._cache.set(name, set);
    if (import.meta.env && import.meta.env.DEV) {
      const s = this.stats();
      console.log(`[procTextures] ${name} ${S}px ${Math.round(performance.now() - t0)}ms`
        + `  |  ${s.surfaces} surfaces, ${s.megabytes} MB, ${s.bakeMs} ms total`);
    }
    return set;
  }

  /**
   * Shared MeshStandardMaterial for a named surface, with the near-field detail
   * layer already blended in. Systems that build their own materials from
   * `get()` should call `injectDetail()` on them to get the same benefit.
   */
  material(name, overrides = {}) {
    const key = name + JSON.stringify(overrides);
    if (this._materials.has(key)) return this._materials.get(key);
    const s = this.get(name);
    const detail = overrides.detail;
    const over = Object.assign({}, overrides);
    delete over.detail;
    const m = new THREE.MeshStandardMaterial({
      map: s.map,
      normalMap: s.normalMap,
      roughnessMap: s.roughnessMap,
      aoMap: s.aoMap,
      roughness: 1,
      metalness: s.metalness,
      transparent: false,
      alphaTest: s.transparent ? (s.alphaTest || 0.42) : 0,
      side: s.transparent ? THREE.DoubleSide : THREE.FrontSide,
      dithering: true,
      ...over,
    });
    if (s.transparent) m.alphaToCoverage = true;
    if (detail !== false) this.injectDetail(m, detail || {});
    this._materials.set(key, m);
    return m;
  }

  /** Texture memory + bake cost, for the budget report. */
  stats() {
    return {
      surfaces: this._cache.size,
      megabytes: +(this.bytes / (1024 * 1024)).toFixed(1),
      bakeMs: Math.round(this._bakeMs),
      size: this.size,
    };
  }

  update() {}

  dispose() {
    for (const w of this._pool) { try { w.terminate(); } catch (e) { /* gone */ } }
    this._pool.length = 0;
    this._poolOk = false;
    releaseScratch();
    for (const s of this._cache.values()) {
      if (s.map) s.map.dispose();
      if (s.normalMap) s.normalMap.dispose();
      if (s.roughnessMap) s.roughnessMap.dispose();
      if (s.aoMap) s.aoMap.dispose();
    }
    for (const m of this._materials.values()) m.dispose();
    if (this._detail) this._detail.dispose();
    this._cache.clear(); this._materials.clear(); this._atlases.clear();
  }
}
