/**
 * Dev-only frame / boot profiler.
 *
 * Costs literally nothing unless the page is loaded with `?profile=1`:
 * every entry point short-circuits on the `PROFILE` constant, which is a
 * module-level boolean the JIT folds away.
 *
 * Two things are measured.
 *
 *  1. PER-PASS GPU COST. `prof.begin(name)` / `prof.end()` bracket a pass with
 *     `gl.finish()`, so the wall time attributed to it is the time the GPU
 *     actually spent, not the time the driver spent queueing it. That inflates
 *     the total (every scope is a pipeline drain) but the RELATIVE breakdown is
 *     honest, which is the thing you optimise against. `EXT_disjoint_timer_query
 *     _webgl2` is not exposed by ANGLE/Metal in headless Chrome, so this is the
 *     only way to get the number here.
 *
 *  2. BOOT COST PER SYSTEM. `Engine.prototype.initAll` is wrapped so each
 *     system's `init()` is timed. Done by monkeypatch rather than by editing
 *     the engine, because `src/core/*` is frozen.
 *
 * Read it back from the harness:
 *     await page.evaluate(() => window.__RSPROF.report())
 */

import { Engine } from '../core/Engine.js';

let _on = false;
try {
  _on = new URLSearchParams(location.search).get('profile') === '1';
} catch (e) { _on = false; }

/** @type {boolean} compile-time-ish switch; every hot path tests this first. */
export const PROFILE = _on;

class Profiler {
  constructor() {
    this.gl = null;
    this.acc = new Map();
    this.frames = 0;
    this._t0 = 0;
    this._name = null;
    this.boot = [];
  }

  attach(gl) { this.gl = gl; }

  begin(name) {
    if (!PROFILE || !this.gl || this._name) return;
    this.gl.finish();
    this._name = name;
    this._t0 = performance.now();
  }

  end() {
    if (!PROFILE || !this.gl || !this._name) return;
    this.gl.finish();
    const dt = performance.now() - this._t0;
    this.acc.set(this._name, (this.acc.get(this._name) || 0) + dt);
    this._name = null;
  }

  /** Call once per rendered frame, at the very end. */
  tick() { if (PROFILE) this.frames++; }

  reset() { this.acc.clear(); this.frames = 0; }

  /** @returns {{frames:number, total:number, passes:Array<[string,number]>}} */
  report() {
    const n = Math.max(1, this.frames);
    const passes = [...this.acc.entries()]
      .map(([k, v]) => [k, v / n])
      .sort((a, b) => b[1] - a[1]);
    let total = 0;
    for (const [, v] of passes) total += v;
    return { frames: this.frames, total, passes, boot: this.boot };
  }
}

export const prof = new Profiler();

/* ------------------------------------------------------------ boot timing */

if (PROFILE) {
  const orig = Engine.prototype.initAll;
  Engine.prototype.initAll = async function (onProgress) {
    const t0 = performance.now();
    let last = t0;
    const wrapped = (p, id) => {
      const now = performance.now();
      if (prof.boot.length) prof.boot[prof.boot.length - 1][1] = now - last;
      last = now;
      prof.boot.push([id, 0]);
      if (onProgress) onProgress(p, id);
    };
    const r = await orig.call(this, wrapped);
    if (prof.boot.length) prof.boot[prof.boot.length - 1][1] = performance.now() - last;
    prof.boot.push(['TOTAL', performance.now() - t0]);
    return r;
  };

  /*
   * Per-system update cost. PostFX's own scopes only cover what happens inside
   * `render()`; anything a system draws in `update()` (the cloud raymarch is the
   * big one, and it renders into its own target) lands in the gap between the
   * sum of the pass scopes and `engine.frameMs`. In night_camp that gap was 45%
   * of the frame, so it has to be attributable.
   */
  const origFrame = Engine.prototype.frame;
  Engine.prototype.frame = function (forcedDt) {
    if (!prof.gl || this.__rsWrapped) return origFrame.call(this, forcedDt);
    this.__rsWrapped = true;
    for (const s of this._systems) {
      const id = s.constructor.id || s.id || '?';
      if (s.update && !s.__rsU) {
        s.__rsU = s.update.bind(s);
        s.update = (dt) => { prof.begin('u:' + id); s.__rsU(dt); prof.end(); };
      }
      if (s.lateUpdate && !s.__rsL) {
        s.__rsL = s.lateUpdate.bind(s);
        s.lateUpdate = (dt) => { prof.begin('l:' + id); s.__rsL(dt); prof.end(); };
      }
    }
    return origFrame.call(this, forcedDt);
  };

  if (typeof window !== 'undefined') {
    window.__RSPROF = {
      report: () => prof.report(),
      reset: () => prof.reset(),
    };
  }
}
