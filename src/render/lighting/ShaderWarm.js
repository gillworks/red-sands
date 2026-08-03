/**
 * Incremental shader pre-warm.
 *
 * WHY THIS EXISTS
 * ---------------
 * WebGL compiles and links a program the first time a material is actually
 * drawn, and the link is a blocking call on the main thread. Two things then
 * conspire to freeze the tab when you ride into town:
 *
 *   1. Dozens of never-before-rendered town materials enter the frustum in one
 *      or two frames.
 *   2. Every distinct NUM_POINT_LIGHTS value is a DIFFERENT program. The street
 *      lamps come into the local-light budget one at a time, so the whole lit
 *      scene relinks once per lamp. Measured on the approach: 27 programs
 *      relinked on each of seven separate frames, the worst of them 6.6 SECONDS
 *      on a cold driver cache.
 *
 * `LocalLights._applySlots` fixes (2) by quantising the count onto a short
 * ladder. This class removes what is left of (1) and pays for the ladder's
 * remaining rungs up front: it walks every material in the scene, in every
 * light configuration the game can ever ask for (see `Lighting._warmVariants`
 * — the point-light ladder, times whether the campfire floor projector is
 * resident), and links them a few at a time while the boot overlay is still on
 * screen.
 *
 * Measured on the town approach, worst single frame, same driver-cache state:
 *   before                     6634 ms  (cold cache) / ~490 ms (warm cache)
 *   ladder fix only             441 ms
 *   ladder fix + this class      27 ms, zero frames over 40 ms
 * and walking up to a campfire, worst frame 440 ms -> 20 ms.
 *
 * It never blocks. `renderer.compile()` only ISSUES the compile/link;
 * three defers the blocking `getProgramParameter` to first use, and
 * `KHR_parallel_shader_compile` lets the driver link on its own threads. We
 * poll `program.isReady()` and refuse to queue a new batch until the previous
 * one has landed, so the driver's compile queue is never oversubscribed.
 *
 * It is driven synchronously from `Lighting.update()` rather than from a
 * promise chain on purpose: the headless capture harness steps `engine.frame()`
 * in a tight loop that never yields to the microtask queue, so a promise-based
 * warm would be invisible to every gate we have.
 *
 * THE TRAP, since it cost a whole iteration to find: three's program cache key
 * contains `outputColorSpace` and `toneMapping`, and BOTH are derived from
 * whether a render target is bound —
 *     outputColorSpace = renderTarget === null ? renderer.outputColorSpace
 *                                              : workingColorSpace
 * The engine is `outputColorSpace = SRGBColorSpace` but PostFX renders the
 * scene into an HDR target, so every real program is keyed 'srgb-linear'.
 * Warming with no target bound produces 'srgb' keys: a complete second set of
 * programs, none of which is ever used, and the hitch survives untouched. So we
 * bind a 1x1 dummy target for the duration of the warm. Any non-null target
 * gives the identical key, which keeps this file independent of PostFX.
 */
import * as THREE from 'three';

const SCAN_INTERVAL = 90;   // frames between re-scans while still settling
const MAX_SCANS = 6;

export class ShaderWarm {
  /**
   * @param {object} ctx
   * @param {object} opts
   * @param {number} opts.budgetMs   max synchronous ms to spend per frame
   * @param {number} opts.maxPerFrame max programs to ISSUE per frame
   * @param {number} opts.delayFrames frames to wait after boot before starting
   * @param {Function} opts.variants  () => Array<{apply: () => restoreFn}>
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.budgetMs = opts.budgetMs ?? 3.0;
    this.maxPerFrame = opts.maxPerFrame ?? 2;
    /*
     * BOOT BURST. main.js keeps the loading overlay up for ~2.2 s after
     * `engine.start()`, and a frame spent linking behind a full-screen overlay
     * is a frame nobody can see. So for the first `burstFrames` we spend ~3x the
     * per-frame budget and get most of the queue linked before the player has
     * a camera at all; after that we drop back to a rate that cannot be felt.
     */
    this.burstFrames = opts.burstFrames ?? 120;
    this.burstBudgetMs = opts.burstBudgetMs ?? 4.0;
    this.burstPerFrame = opts.burstPerFrame ?? 4;
    this.delayFrames = opts.delayFrames ?? 2;
    /* `?nowarm=1` turns the pre-warm off. Keep it: it is the only way to A/B a
     * suspected hitch against the un-warmed build without editing source. */
    this.enabled = opts.enabled !== false
      && !(typeof location !== 'undefined' && /[?&]nowarm=1/.test(location.search));

    /**
     * `() => Array<{apply: () => restoreFn}>` — every LIGHT CONFIGURATION the
     * game can put a lit material into. Each one is a separate program for
     * every lit material in the world, which is exactly why the set has to be
     * small and known up front. Index 0 is treated as the base configuration
     * and is the only one non-lit materials are warmed in.
     */
    this.variants = opts.variants || (() => [{ apply: () => (() => {}) }]);

    this._queue = [];
    this._pending = [];
    this._seen = new Set();
    this._frame = 0;
    this._scans = 0;
    this._nextScan = 0;
    this._done = false;

    /* Diagnostics — read them from the console when a hitch is suspected:
     *   __GAME.ctx.get('lighting').warm.stats  */
    this.stats = { issued: 0, scans: 0, ms: 0, worstMs: 0, queued: 0 };
  }

  get done() { return this._done && this._queue.length === 0; }

  /** Force a re-scan; call after adding a lot of new materials to the scene. */
  invalidate() {
    this._scans = 0;
    this._nextScan = this._frame;
    this._done = false;
  }

  /* ------------------------------------------------------------------ scan */

  /**
   * One representative object per distinct material. `renderer.compile` keys
   * its program on (material, object, scene), so a single mesh per material is
   * enough — but it has to be a REAL mesh from the scene, because instancing,
   * morph targets and vertex colours all move the cache key.
   */
  _scan() {
    const scene = this.ctx.scene;
    if (!scene) return;
    const variants = this.variants();
    let added = 0;
    const fresh = [];
    scene.traverse((o) => {
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      if (o.userData && o.userData.rsNoWarm === true) return;
      const m = o.material;
      if (!m) return;
      const list = Array.isArray(m) ? m : [m];
      for (const mat of list) {
        if (!mat || this._seen.has(mat.uuid)) continue;
        this._seen.add(mat.uuid);
        /* A material that does not read lights has exactly one permutation, so
         * warming it once is enough; only lit materials multiply by the rung. */
        const lit = mat.lights !== false
          && (mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial
            || mat.isMeshLambertMaterial || mat.isMeshPhongMaterial
            || (mat.isShaderMaterial && mat.lights === true));
        fresh.push({ obj: o, mat, lit });
      }
    });
    /* VARIANT-MAJOR. Applying a variant is cheap but flipping it per item would
     * do it hundreds of times; more importantly variant 0 is the configuration
     * the player is standing in right now, so it links first and the rest warm
     * behind it. */
    for (let v = 0; v < variants.length; v++) {
      for (const f of fresh) {
        if (v > 0 && !f.lit) continue;
        this._queue.push({ obj: f.obj, mat: f.mat, v });
        added++;
      }
    }
    this._scans++;
    this.stats.scans = this._scans;
    this.stats.queued = this._queue.length;
    if (added === 0 && this._scans >= 2) this._done = true;
    if (this._scans >= MAX_SCANS) this._done = true;
  }

  /* ---------------------------------------------------------------- update */

  update() {
    if (!this.enabled) return;
    this._frame++;
    if (this._frame < this.delayFrames) return;

    const renderer = this.ctx.renderer;
    const camera = this.ctx.camera;
    if (!renderer || !camera || !renderer.compile) return;

    /* Back-pressure: never issue a new batch while the driver is still linking
     * the last one. This is what keeps the warm off the main thread. */
    if (this._pending.length) {
      const props = renderer.properties;
      for (let i = this._pending.length - 1; i >= 0; i--) {
        const p = props && props.get(this._pending[i]);
        const prog = p && p.currentProgram;
        if (!prog || typeof prog.isReady !== 'function' || prog.isReady()) {
          this._pending.splice(i, 1);
        }
      }
      if (this._pending.length) return;
    }

    if (this._queue.length === 0) {
      if (this._done || this._frame < this._nextScan) return;
      this._nextScan = this._frame + SCAN_INTERVAL;
      this._scan();
      return;
    }

    if (!this._rt) {
      this._rt = new THREE.WebGLRenderTarget(1, 1);
      this._rt.texture.name = 'rsShaderWarmKey';
    }

    const burst = this._frame < this.burstFrames;
    const budgetMs = burst ? this.burstBudgetMs : this.budgetMs;
    const maxPerFrame = burst ? this.burstPerFrame : this.maxPerFrame;

    const t0 = performance.now();
    let issued = 0;
    let restore = null;
    let variant = -1;
    const variants = this.variants();
    const prevRT = renderer.getRenderTarget();
    const prevCube = renderer.getActiveCubeFace ? renderer.getActiveCubeFace() : 0;
    const prevMip = renderer.getActiveMipmapLevel ? renderer.getActiveMipmapLevel() : 0;
    renderer.setRenderTarget(this._rt);
    try {
      while (this._queue.length && issued < maxPerFrame) {
        const item = this._queue[0];
        if (item.v !== variant) {
          if (restore) { restore(); restore = null; }
          variant = item.v;
          const V = variants[variant];
          if (V && V.apply) restore = V.apply();
        }
        this._queue.shift();
        try {
          renderer.compile(item.obj, camera, this.ctx.scene);
          this._pending.push(item.mat);
        } catch (e) { /* a material we cannot warm is not worth failing over */ }
        issued++;
        if (performance.now() - t0 > budgetMs) break;
      }
    } finally {
      if (restore) restore();
      renderer.setRenderTarget(prevRT, prevCube, prevMip);
    }

    const ms = performance.now() - t0;
    this.stats.issued += issued;
    this.stats.ms += ms;
    if (ms > this.stats.worstMs) this.stats.worstMs = ms;
    this.stats.queued = this._queue.length;
  }

  dispose() {
    this._queue.length = 0;
    this._pending.length = 0;
    this._seen.clear();
    if (this._rt) { this._rt.dispose(); this._rt = null; }
  }
}
