import * as THREE from 'three';
import { createContext } from './Context.js';

/**
 * Engine: owns the renderer, the frame loop, and system orchestration.
 * Systems are updated in registration order; render is delegated to the
 * system registered as `postfx` if present, otherwise a direct render.
 */
export class Engine {
  constructor({ container, quality }) {
    this.container = container;
    this.quality = quality;

    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    container.appendChild(canvas);

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // TAA/SMAA handled in PostFX
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // required for headless screenshot capture
    });
    renderer.setPixelRatio(Math.min(quality.pixelRatio, window.devicePixelRatio || 1));
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping; // PostFX applies AgX/ACES itself
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.autoClear = true;
    renderer.info.autoReset = false;

    const gl = renderer.getContext();
    this.caps = {
      float: !!gl.getExtension('EXT_color_buffer_float'),
      floatLinear: !!gl.getExtension('OES_texture_float_linear'),
      aniso: renderer.capabilities.getMaxAnisotropy(),
      maxTexture: renderer.capabilities.maxTextureSize,
    };

    const scene = new THREE.Scene();
    scene.matrixWorldAutoUpdate = true;

    const camera = new THREE.PerspectiveCamera(
      52,
      container.clientWidth / Math.max(1, container.clientHeight),
      0.15,
      12000,
    );
    camera.position.set(0, 30, 0);

    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;

    this.ctx = createContext({ renderer, scene, camera, canvas, quality });
    this.ctx.engine = this;
    this.ctx.caps = this.caps;

    this._systems = [];
    this._clock = new THREE.Clock();
    this._running = false;
    this._accum = 0;
    this.fixedStep = 1 / 60;
    /** Set true by main once all systems have initialised. */
    this.ready = false;
    /** Rolling frame time in ms for the adaptive quality governor. */
    this.frameMs = 16.7;
    /** Rolling per-system CPU cost in ms, keyed by system id. See frame(). */
    this._profile = Object.create(null);

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
    this._onResize();
  }

  /**
   * Register a system instance.
   * Registration order = per-frame update order.
   * `initOrder` (lower first) = dependency order for init(); defaults to
   * registration order when omitted.
   */
  add(system, { initOrder = null } = {}) {
    const id = system.constructor.id || system.id;
    if (!id) throw new Error('System is missing a static id: ' + system.constructor.name);
    system.__initOrder = initOrder != null ? initOrder : this._systems.length * 100;
    this._systems.push(system);
    this.ctx.systems.set(id, system);
    return system;
  }

  async initAll(onProgress = () => {}) {
    const ordered = this._systems.slice().sort((a, b) => a.__initOrder - b.__initOrder);
    const n = ordered.length;
    for (let i = 0; i < n; i++) {
      const s = ordered[i];
      const id = s.constructor.id || s.id;
      onProgress(i / n, id);
      if (s.init) {
        try {
          await s.init();
        } catch (err) {
          console.error(`[Engine] system "${id}" failed to init:`, err);
          s.__failed = true;
        }
      }
    }
    onProgress(1, 'ready');
    this.ready = true;
    this.ctx.emit('ready');
  }

  _onResize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    const dpr = this.renderer.getPixelRatio();
    for (const s of this._systems) {
      if (s.resize && !s.__failed) {
        try {
          s.resize(Math.floor(w * dpr), Math.floor(h * dpr));
        } catch (e) {
          console.error('[Engine] resize failed for', s.constructor.id, e);
        }
      }
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._clock.start();
    const loop = () => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(loop);
      this.frame();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  /** Advance and render exactly one frame. Also used by the capture harness. */
  frame(forcedDt = null) {
    const t0 = performance.now();
    const raw = forcedDt != null ? forcedDt : this._clock.getDelta();
    const dt = Math.min(raw, 0.1); // clamp to survive tab stalls
    const time = this.ctx.time;
    time.rawDt = raw;
    time.dt = dt;
    time.elapsed += dt;
    time.frame++;

    this.renderer.info.reset();

    // Per-system cost attribution. Pass 3 regressed every shot over the frame
    // budget and nobody could name the offender; an unattributed frame time is
    // an unfixable one. Rolling EMA so a single hitch does not dominate.
    const prof = this._profile;
    for (const s of this._systems) {
      if (s.update && !s.__failed) {
        const st = performance.now();
        try {
          s.update(dt);
        } catch (e) {
          console.error('[Engine] update failed for', s.constructor.id, e);
          s.__failed = true;
        }
        const id = s.constructor.id || s.id;
        prof[id] = (prof[id] || 0) * 0.92 + (performance.now() - st) * 0.08;
      }
    }
    for (const s of this._systems) {
      if (s.lateUpdate && !s.__failed) {
        const st = performance.now();
        try {
          s.lateUpdate(dt);
        } catch (e) {
          console.error('[Engine] lateUpdate failed for', s.constructor.id, e);
          s.__failed = true;
        }
        const id = s.constructor.id || s.id;
        prof[id] = (prof[id] || 0) * 0.92 + (performance.now() - st) * 0.08;
      }
    }

    const rt = performance.now();
    const postfx = this.ctx.systems.get('postfx');
    if (postfx && postfx.render && !postfx.__failed) {
      postfx.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    // Note: this is CPU submission time, not GPU execution. WebGL is
    // asynchronous, so a heavy shader shows up here only via backpressure.
    // Treat it as "who is submitting the most work", not as a GPU profile.
    prof['__render'] = (prof['__render'] || 0) * 0.92 + (performance.now() - rt) * 0.08;

    this.frameMs = this.frameMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    for (const s of this._systems) if (s.dispose) try { s.dispose(); } catch (e) { /* noop */ }
    this.renderer.dispose();
  }
}
