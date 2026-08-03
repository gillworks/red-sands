import * as THREE from 'three';
import { rng } from '../core/Context.js';
import {
  FIELD_VERT, FIELD_FRAG, POOL_VERT, POOL_FRAG,
  LENS_VERT, LENS_FRAG, COPY_VERT, COPY_FRAG,
} from './particles/ParticleShaders.js';

/**
 * ============================================================================
 *  PARTICLES — one shared pool, everything instanced, everything lit.
 * ============================================================================
 *
 *  TWO SIMULATION STRATEGIES
 *
 *  1. FIELDS (rain, snow, motes/pollen) are stateless: a particle's position
 *     is an analytic function of its seed and the clock, wrapped into a box
 *     that follows the camera. The CPU never touches a vertex, the whole field
 *     is "full" the instant weather changes (no warm-up — which matters, the
 *     capture harness only allows 2.5 s of settle), and 8000 raindrops cost one
 *     draw call and no bandwidth.
 *
 *  2. POOLS (splashes, embers, smoke, hoof dust, fireflies, breath, leaves,
 *     bursts) are CPU-simulated into instanced attributes. These are events:
 *     they need real spawn positions, collisions with the ground and per-kind
 *     behaviour, and there are only ever a couple of thousand of them.
 *
 *  SHARED TRAITS
 *   • Soft-particle depth fade against a half-res copy of PostFX's depth
 *     buffer. (A copy, not the buffer itself: that texture is attached to the
 *     framebuffer the scene renders into, and sampling it there is a feedback
 *     loop GL will kill the draw for.) Hard intersections with the ground are
 *     an instant tell, so nothing intersects.
 *   • Lit from ctx.env — wrap diffuse from the sun/moon plus a Henyey-
 *     Greenstein forward lobe, so dust and mist rim-light when you look into a
 *     low sun and go blue under a storm.
 *   • Aerial perspective from Sky, on every layer.
 *   • Wind comes from env.windVector / env.windGust, the same field the grass,
 *     the clouds and the water read.
 *
 *  PUBLIC API (docs/CONTRACTS.md §4.6)
 *     emitter(name, opts) → handle   continuous emitter; handle.stop()
 *     burst(name, position, count, opts)
 *  Names: rain snow dust embers smoke fireflies splash muzzle leaves pollen
 *         breath mist sparks blood
 */
export class Particles {
  static id = 'particles';

  constructor(ctx) {
    this.ctx = ctx;
    this.rand = rng((ctx.seed ^ 0x51ed2701) >>> 0);
    this.enabled = true;

    /** Set false to drop the rain-on-lens overlay. */
    this.lensRain = true;
    /** Global multiplier on every layer's opacity. */
    this.opacity = 1;

    this._layers = [];
    this._emitters = [];
    this._t = 0;
    this._acc = Object.create(null);
    this._size = new THREE.Vector2(1280, 720);

    this._sunCol = new THREE.Color();
    this._skyCol = new THREE.Color();
    this._grdCol = new THREE.Color();
    this._wind = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._camGround = 0;
  }

  /* ------------------------------------------------------------------ init */

  async init() {
    const ctx = this.ctx;
    const q = ctx.quality || {};
    const budget = Math.max(600, q.particleBudget || 6000);
    const s = Math.min(1, budget / 24000);

    this.atlas = makeAtlas(512, this.rand);

    /* ------------------------------------------------------ shared uniforms */
    this.shared = {
      uDepth: { value: null },
      uDepthParams: { value: new THREE.Vector4(0.15, 12000, 1 / 1280, 1 / 720) },
      uSoftness: { value: 1.2 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color(1, 1, 1) },
      uSkyCol: { value: new THREE.Color(0.2, 0.3, 0.45) },
      uGroundCol: { value: new THREE.Color(0.1, 0.08, 0.06) },
      uAtlas: { value: this.atlas },
      uPhaseGain: { value: 1 },
      uStretchY: { value: 1 },
    };

    const sky = ctx.get('sky');
    this._aerial = (sky && sky.aerialGLSL && sky.aerialUniforms)
      ? { glsl: sky.aerialGLSL, uniforms: sky.aerialUniforms }
      : null;

    /* --------------------------------------------------------------- quad */
    this._quad = new THREE.BufferGeometry();
    this._quad.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    this._quad.setAttribute('uv', new THREE.Float32BufferAttribute(
      [0, 0, 1, 0, 1, 1, 0, 1], 2));
    this._quad.setIndex([0, 1, 2, 0, 2, 3]);

    this._fsQuad = new THREE.BufferGeometry();
    this._fsQuad.setAttribute('position', new THREE.Float32BufferAttribute(
      [-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this._fsQuad.setAttribute('uv', new THREE.Float32BufferAttribute(
      [0, 0, 2, 0, 0, 2], 2));

    /* -------------------------------------------------------------- fields */
    this.rain = this._makeField('rain', Math.round(9000 * s), 'MODE_RAIN', {
      box: new THREE.Vector3(34, 26, 34),
      yOffset: 5,
      size: 0.030, stretch: 26, aspect: 0.5, fall: 12.5,
      tile: [0.5, 0.5, 0.5, 0.5],            // streak
      tint: new THREE.Color(0.62, 0.70, 0.85),
      opacity: 0.0, emissive: 0.12,
      blending: THREE.NormalBlending,
    });
    this.snow = this._makeField('snow', Math.round(5200 * s), 'MODE_SNOW', {
      box: new THREE.Vector3(26, 20, 26),
      yOffset: 4,
      size: 0.055, stretch: 1, aspect: 1, fall: 1.15,
      tile: [0.5, 0.5, 0.5, 0.0],            // dot
      tint: new THREE.Color(0.95, 0.97, 1.0),
      opacity: 0.0, emissive: 0.0,
      blending: THREE.NormalBlending,
    });
    this.motes = this._makeField('motes', Math.round(2600 * s), 'MODE_MOTE', {
      box: new THREE.Vector3(16, 9, 16),
      yOffset: 1.6,
      size: 0.036, stretch: 1, aspect: 1, fall: 0.10,
      tile: [0.5, 0.5, 0.5, 0.0],
      tint: new THREE.Color(1.0, 0.86, 0.62),
      opacity: 0.0, emissive: 0.0,
      blending: THREE.AdditiveBlending,
    });

    /* --------------------------------------------------------------- pools */
    this.soft = this._makePool('soft', Math.round(1700 * s), {
      blending: THREE.NormalBlending, softness: 1.6,
    });
    this.glow = this._makePool('glow', Math.round(700 * s), {
      blending: THREE.AdditiveBlending, softness: 0.9,
    });
    /* Ground mist is a LAYER, not a cloud of balls: the billboards are
       squashed to a 1:4 sheet so they stack into a flat stratum that hugs the
       low ground, and the forward-scatter lobe is turned down so a low sun
       does not blow a hole through them. */
    this.mist = this._makePool('mist', Math.round(78 * s) + 22, {
      blending: THREE.NormalBlending, softness: 30, opacity: 1,
      stretchY: 0.30, phaseGain: 0.45,
    });

    /* ---------------------------------------------------------- lens rain */
    this.lensMat = new THREE.ShaderMaterial({
      vertexShader: LENS_VERT,
      fragmentShader: LENS_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      uniforms: {
        uTime: { value: 0 },
        uAmount: { value: 0 },
        uAspect: { value: new THREE.Vector2(1.78, 1) },
        uSkyCol: { value: new THREE.Color(0.4, 0.45, 0.55) },
        uSunCol: { value: new THREE.Color(0, 0, 0) },
        uDrift: { value: 0 },
      },
    });
    this.lensMesh = new THREE.Mesh(this._fsQuad, this.lensMat);
    this.lensMesh.frustumCulled = false;
    this.lensMesh.renderOrder = 4000;
    this.lensMesh.name = 'lensRain';
    this.lensMesh.userData.rsNoAerial = true;
    this.lensMesh.userData.rsNoGroundFX = true;
    this.lensMat.userData.rsNoAerial = true;
    this.lensMat.userData.rsNoGroundFX = true;
    ctx.scene.add(this.lensMesh);

    /* ------------------------------------------------------- depth copy rt */
    this.copyMat = new THREE.ShaderMaterial({
      vertexShader: COPY_VERT,
      fragmentShader: COPY_FRAG,
      depthTest: false, depthWrite: false,
      uniforms: { tDepth: { value: null }, uTexel: { value: new THREE.Vector2() } },
    });
    this._copyScene = new THREE.Scene();
    this._copyCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._copyMesh = new THREE.Mesh(this._fsQuad, this.copyMat);
    this._copyMesh.frustumCulled = false;
    this._copyScene.add(this._copyMesh);

    const dbs = new THREE.Vector2();
    ctx.renderer.getDrawingBufferSize(dbs);
    this._allocDepth(Math.max(2, dbs.x), Math.max(2, dbs.y));

    /* ---------------------------------------------------------- reactions */
    this._offs = [];
    this._offs.push(ctx.on('gunshot', (e) => {
      const p = (e && e.position) || ctx.player.position;
      this.burst('muzzle', p, 14, e || {});
    }));
    this._offs.push(ctx.on('footstep', (e) => {
      const p = (e && e.position) || ctx.player.position;
      if ((ctx.env.wetness || 0) > 0.45) this.burst('splash', p, 3, {});
      else this.burst('dust', p, 4, { scale: 0.7 });
    }));
    this._offs.push(ctx.on('teleport', () => this._reset()));
    this._offs.push(ctx.on('lightning', () => { /* keeps audio/vfx in sync */ }));
  }

  /* --------------------------------------------------------------- builders */

  _fragment(src) {
    const head = this._aerial ? this._aerial.glsl : '';
    return head + src;
  }

  _makeField(name, count, mode, o) {
    const ctx = this.ctx;
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = this._quad.index;
    geo.setAttribute('position', this._quad.getAttribute('position'));
    geo.setAttribute('uv', this._quad.getAttribute('uv'));
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i++) seeds[i] = this.rand();
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const uniforms = Object.assign({}, this.shared, {
      uBox: { value: o.box.clone() },
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector3() },
      uDensity: { value: 0 },
      uSize: { value: o.size },
      uFall: { value: o.fall },
      uStretch: { value: o.stretch },
      uAspect: { value: o.aspect },
      uYOffset: { value: o.yOffset },
      uTile: { value: new THREE.Vector4(...o.tile) },
      uTint: { value: o.tint.clone() },
      uOpacity: { value: o.opacity },
      uEmissive: { value: o.emissive },
    });
    if (this._aerial) Object.assign(uniforms, this._aerial.uniforms);

    const defines = { [mode]: '' };
    if (this._aerial) defines.RS_HAS_AERIAL = '';

    const mat = new THREE.ShaderMaterial({
      defines,
      uniforms,
      vertexShader: FIELD_VERT,
      fragmentShader: this._fragment(FIELD_FRAG),
      transparent: true,
      depthTest: true,
      depthWrite: false,
      /* Everything writes PREMULTIPLIED alpha, so "over" is (One,1-SrcAlpha)
         and additive is (One,One). Using three's AdditiveBlending here would
         multiply by alpha a second time. */
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: o.blending === THREE.AdditiveBlending
        ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    mat.userData.rsNoAerial = true;      // we apply it ourselves, in-shader
    mat.userData.rsNoGroundFX = true;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3000;
    mesh.name = 'particles:' + name;
    mesh.userData.rsNoAerial = true;
    mesh.userData.rsNoGroundFX = true;
    mesh.matrixAutoUpdate = false;
    ctx.scene.add(mesh);

    const layer = { name, mesh, mat, uniforms, count, kind: 'field' };
    this._layers.push(layer);
    return layer;
  }

  _makePool(name, count, o) {
    const ctx = this.ctx;
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = this._quad.index;
    geo.setAttribute('position', this._quad.getAttribute('position'));
    geo.setAttribute('uv', this._quad.getAttribute('uv'));

    const aPos = new Float32Array(count * 3);
    const aParams = new Float32Array(count * 4);
    const aColor = new Float32Array(count * 4);
    const bPos = new THREE.InstancedBufferAttribute(aPos, 3);
    const bParams = new THREE.InstancedBufferAttribute(aParams, 4);
    const bColor = new THREE.InstancedBufferAttribute(aColor, 4);
    bPos.setUsage(THREE.DynamicDrawUsage);
    bParams.setUsage(THREE.DynamicDrawUsage);
    bColor.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', bPos);
    geo.setAttribute('aParams', bParams);
    geo.setAttribute('aColor', bColor);
    geo.instanceCount = count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const uniforms = Object.assign({}, this.shared, {
      uOpacity: { value: o.opacity != null ? o.opacity : 1 },
      uSoftness: { value: o.softness },
      uStretchY: { value: o.stretchY != null ? o.stretchY : 1 },
      uPhaseGain: { value: o.phaseGain != null ? o.phaseGain : 1 },
    });
    if (this._aerial) Object.assign(uniforms, this._aerial.uniforms);
    const defines = this._aerial ? { RS_HAS_AERIAL: '' } : {};

    const mat = new THREE.ShaderMaterial({
      defines,
      uniforms,
      vertexShader: POOL_VERT,
      fragmentShader: this._fragment(POOL_FRAG),
      transparent: true,
      depthTest: true,
      depthWrite: false,
      /* Everything writes PREMULTIPLIED alpha, so "over" is (One,1-SrcAlpha)
         and additive is (One,One). Using three's AdditiveBlending here would
         multiply by alpha a second time. */
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: o.blending === THREE.AdditiveBlending
        ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    mat.userData.rsNoAerial = true;
    mat.userData.rsNoGroundFX = true;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = name === 'mist' ? 2900 : 3010;
    mesh.name = 'particles:' + name;
    mesh.userData.rsNoAerial = true;
    mesh.userData.rsNoGroundFX = true;
    mesh.matrixAutoUpdate = false;
    ctx.scene.add(mesh);

    const pool = {
      name, mesh, mat, uniforms, count, kind: 'pool',
      aPos, aParams, aColor, bPos, bParams, bColor,
      px: new Float32Array(count * 3),
      vx: new Float32Array(count * 3),
      life: new Float32Array(count),
      maxLife: new Float32Array(count),
      s0: new Float32Array(count),
      s1: new Float32Array(count),
      rot: new Float32Array(count),
      rotV: new Float32Array(count),
      drag: new Float32Array(count),
      grav: new Float32Array(count),
      a0: new Float32Array(count),
      cursor: 0,
      alive: 0,
    };
    for (let i = 0; i < count; i++) aParams[i * 4 + 2] = 0;
    this._layers.push(pool);
    return pool;
  }

  _allocDepth(w, h) {
    const rw = Math.max(2, Math.floor(w * 0.5));
    const rh = Math.max(2, Math.floor(h * 0.5));
    this._size.set(w, h);
    if (this.depthRT) {
      if (this.depthRT.width === rw && this.depthRT.height === rh) return;
      this.depthRT.dispose();
    }
    this.depthRT = new THREE.WebGLRenderTarget(rw, rh, {
      format: THREE.RGBAFormat,
      type: (this.ctx.caps && this.ctx.caps.float) ? THREE.HalfFloatType : THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.depthRT.texture.colorSpace = THREE.NoColorSpace;
    this.shared.uDepth.value = this.depthRT.texture;
    this.copyMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.shared.uDepthParams.value.z = 1 / w;
    this.shared.uDepthParams.value.w = 1 / h;
  }

  resize(w, h) {
    if (!this.depthRT) return;
    this._allocDepth(Math.max(2, w), Math.max(2, h));
  }

  /* ------------------------------------------------------------ public API */

  /**
   * Register a continuous emitter.
   * @param {string} name  rain|snow|dust|embers|smoke|fireflies|leaves|pollen|
   *                       breath|mist|splash
   * @param {object} opts  { position, rate, scale, color, enabled, follow }
   * @returns {{name:string, position:THREE.Vector3, rate:number,
   *            enabled:boolean, stop():void}}
   */
  emitter(name, opts = {}) {
    const e = {
      name,
      position: (opts.position ? opts.position.clone() : new THREE.Vector3()),
      rate: opts.rate != null ? opts.rate : 12,
      scale: opts.scale != null ? opts.scale : 1,
      color: opts.color ? new THREE.Color(opts.color) : null,
      enabled: opts.enabled !== false,
      follow: opts.follow || null,
      radius: opts.radius != null ? opts.radius : 0.2,
      _acc: 0,
      stop: () => {
        const i = this._emitters.indexOf(e);
        if (i >= 0) this._emitters.splice(i, 1);
      },
    };
    this._emitters.push(e);
    return e;
  }

  /**
   * One-shot burst. Used for impacts, splashes, muzzle flashes, hoof strikes.
   * @param {string} name
   * @param {THREE.Vector3} position
   * @param {number} count
   */
  burst(name, position, count = 8, opts = {}) {
    if (!this.enabled || !position) return;
    const n = Math.max(1, Math.min(count | 0, 240));
    for (let i = 0; i < n; i++) this._spawn(name, position, opts);
  }

  /* --------------------------------------------------------------- spawning */

  _pool(name) {
    if (name === 'mist') return this.mist;
    if (name === 'embers' || name === 'muzzle' || name === 'fireflies' || name === 'sparks') {
      return this.glow;
    }
    return this.soft;
  }

  _spawn(name, pos, opts = {}) {
    const P = this._pool(name);
    if (!P) return -1;
    // ring allocator: oldest slot wins, so a burst can always find room
    let i = -1;
    for (let k = 0; k < P.count; k++) {
      const c = (P.cursor + k) % P.count;
      if (P.life[c] <= 0) { i = c; P.cursor = (c + 1) % P.count; break; }
    }
    if (i < 0) { i = P.cursor; P.cursor = (P.cursor + 1) % P.count; }

    const r = this.rand;
    const sc = opts.scale != null ? opts.scale : 1;
    const i3 = i * 3, i4 = i * 4;
    P.px[i3] = pos.x; P.px[i3 + 1] = pos.y; P.px[i3 + 2] = pos.z;
    P.vx[i3] = 0; P.vx[i3 + 1] = 0; P.vx[i3 + 2] = 0;
    P.rot[i] = r() * 6.2831;
    P.rotV[i] = (r() - 0.5) * 1.2;
    P.drag[i] = 1.4;
    P.grav[i] = -9.8;
    P.a0[i] = 1;
    let tile = 0, cr = 0.6, cg = 0.6, cb = 0.6, em = 0;

    const wind = this._wind;
    switch (name) {
      case 'splash': {
        // expanding ring on the surface + a couple of thrown droplets
        P.px[i3 + 1] += 0.015;
        P.maxLife[i] = 0.34 + r() * 0.18;
        P.s0[i] = 0.05 * sc; P.s1[i] = (0.42 + r() * 0.3) * sc;
        P.drag[i] = 6; P.grav[i] = 0;
        tile = 2;
        cr = 0.55; cg = 0.62; cb = 0.72;
        P.a0[i] = 0.5;
        break;
      }
      case 'dust': {
        P.vx[i3] = (r() - 0.5) * 1.4 + wind.x * 0.25;
        P.vx[i3 + 1] = 0.5 + r() * 1.1;
        P.vx[i3 + 2] = (r() - 0.5) * 1.4 + wind.z * 0.25;
        P.maxLife[i] = 1.6 + r() * 2.2;
        P.s0[i] = (0.22 + r() * 0.2) * sc; P.s1[i] = (1.5 + r() * 1.6) * sc;
        P.drag[i] = 1.1; P.grav[i] = -0.9;
        tile = 0;
        cr = 0.60; cg = 0.50; cb = 0.36;
        P.a0[i] = 0.30;
        break;
      }
      case 'smoke': {
        P.vx[i3] = (r() - 0.5) * 0.35 + wind.x * 0.5;
        P.vx[i3 + 1] = 1.1 + r() * 0.9;
        P.vx[i3 + 2] = (r() - 0.5) * 0.35 + wind.z * 0.5;
        P.maxLife[i] = 4.5 + r() * 4.0;
        P.s0[i] = (0.35 + r() * 0.3) * sc; P.s1[i] = (3.2 + r() * 2.6) * sc;
        P.drag[i] = 0.5; P.grav[i] = 0.55;
        tile = 0;
        cr = 0.30; cg = 0.29; cb = 0.28;
        P.a0[i] = 0.42;
        break;
      }
      case 'embers': {
        P.vx[i3] = (r() - 0.5) * 0.9 + wind.x * 0.35;
        P.vx[i3 + 1] = 1.6 + r() * 2.4;
        P.vx[i3 + 2] = (r() - 0.5) * 0.9 + wind.z * 0.35;
        P.maxLife[i] = 1.4 + r() * 2.4;
        P.s0[i] = 0.035 * sc; P.s1[i] = 0.012 * sc;
        P.drag[i] = 0.7; P.grav[i] = 1.4;   // buoyant
        tile = 1;
        cr = 1.6; cg = 0.55; cb = 0.14; em = 8;
        P.a0[i] = 1;
        break;
      }
      case 'muzzle': {
        P.vx[i3] = (r() - 0.5) * 6 + (opts.dir ? opts.dir.x * 9 : 0);
        P.vx[i3 + 1] = (r() - 0.5) * 3 + 1;
        P.vx[i3 + 2] = (r() - 0.5) * 6 + (opts.dir ? opts.dir.z * 9 : 0);
        P.maxLife[i] = 0.09 + r() * 0.14;
        P.s0[i] = 0.10 * sc; P.s1[i] = 0.30 * sc;
        P.drag[i] = 6; P.grav[i] = 0.4;
        tile = 1;
        cr = 2.2; cg = 1.3; cb = 0.55; em = 22;
        break;
      }
      case 'sparks': {
        P.vx[i3] = (r() - 0.5) * 5;
        P.vx[i3 + 1] = r() * 4;
        P.vx[i3 + 2] = (r() - 0.5) * 5;
        P.maxLife[i] = 0.3 + r() * 0.5;
        P.s0[i] = 0.03 * sc; P.s1[i] = 0.008 * sc;
        P.drag[i] = 1.2; P.grav[i] = -9.8;
        tile = 1;
        cr = 2.0; cg = 1.0; cb = 0.35; em = 14;
        break;
      }
      case 'fireflies': {
        P.vx[i3] = (r() - 0.5) * 0.5;
        P.vx[i3 + 1] = (r() - 0.5) * 0.3;
        P.vx[i3 + 2] = (r() - 0.5) * 0.5;
        P.maxLife[i] = 6 + r() * 9;
        P.s0[i] = 0.045 * sc; P.s1[i] = 0.045 * sc;
        P.drag[i] = 0.9; P.grav[i] = 0.02;
        tile = 1;
        cr = 0.9; cg = 1.5; cb = 0.35; em = 5;
        break;
      }
      case 'leaves': {
        P.vx[i3] = wind.x * 0.8 + (r() - 0.5) * 1.5;
        P.vx[i3 + 1] = 0.4 + r() * 0.8;
        P.vx[i3 + 2] = wind.z * 0.8 + (r() - 0.5) * 1.5;
        P.maxLife[i] = 5 + r() * 6;
        P.s0[i] = (0.07 + r() * 0.05) * sc; P.s1[i] = (0.07 + r() * 0.05) * sc;
        P.drag[i] = 1.6; P.grav[i] = -1.1;
        P.rotV[i] = (r() - 0.5) * 7;
        tile = 1;
        cr = 0.42; cg = 0.34; cb = 0.14;
        P.a0[i] = 0.9;
        break;
      }
      case 'breath': {
        P.vx[i3] = (r() - 0.5) * 0.25 + (opts.dir ? opts.dir.x * 1.4 : 0);
        P.vx[i3 + 1] = 0.25 + r() * 0.3;
        P.vx[i3 + 2] = (r() - 0.5) * 0.25 + (opts.dir ? opts.dir.z * 1.4 : 0);
        P.maxLife[i] = 0.9 + r() * 0.8;
        P.s0[i] = 0.07 * sc; P.s1[i] = 0.55 * sc;
        P.drag[i] = 2.4; P.grav[i] = 0.35;
        tile = 0;
        cr = 0.85; cg = 0.88; cb = 0.95;
        P.a0[i] = 0.30;
        break;
      }
      case 'mist': {
        P.vx[i3] = wind.x * 0.16; P.vx[i3 + 2] = wind.z * 0.16;
        P.maxLife[i] = 34 + r() * 34;
        P.s0[i] = (26 + r() * 30) * sc; P.s1[i] = (40 + r() * 44) * sc;
        P.drag[i] = 0.02; P.grav[i] = 0;
        P.rotV[i] = 0;              // a flat sheet must not cartwheel
        P.rot[i] = 0;
        tile = 0;
        cr = 0.78; cg = 0.82; cb = 0.90;
        P.a0[i] = 0.105;
        break;
      }
      default: {  // generic puff
        P.vx[i3] = (r() - 0.5) * 2;
        P.vx[i3 + 1] = r() * 2;
        P.vx[i3 + 2] = (r() - 0.5) * 2;
        P.maxLife[i] = 1 + r();
        P.s0[i] = 0.15 * sc; P.s1[i] = 0.6 * sc;
        tile = 0;
        break;
      }
    }

    if (opts.color) { const c = opts.color; cr = c.r; cg = c.g; cb = c.b; }
    P.life[i] = P.maxLife[i];
    P.aParams[i4] = P.s0[i];
    P.aParams[i4 + 1] = P.rot[i];
    P.aParams[i4 + 2] = 0;
    P.aParams[i4 + 3] = tile;
    P.aColor[i4] = cr; P.aColor[i4 + 1] = cg; P.aColor[i4 + 2] = cb;
    P.aColor[i4 + 3] = em;
    return i;
  }

  /* ------------------------------------------------------------------ frame */

  _reset() {
    for (const L of this._layers) {
      if (L.kind !== 'pool') continue;
      L.life.fill(0);
      for (let i = 0; i < L.count; i++) L.aParams[i * 4 + 2] = 0;
    }
    this._mistSeeded = false;
  }

  update(dt) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const env = ctx.env;
    const cam = ctx.camera;
    dt = Math.min(dt, 0.1);
    this._t += dt;

    this._wind.copy(env.windVector);
    this._camGround = this._groundAt(cam.position.x, cam.position.z);

    this._weatherEmitters(dt, env, cam);
    this._runEmitters(dt);
    this._simulate(dt);
  }

  _groundAt(x, z) {
    const w = this.ctx.world;
    if (w && w.ready && w.getHeight) {
      try { return w.getHeight(x, z); } catch (e) { /* not ready */ }
    }
    return 0;
  }

  /* -- weather-driven spawning ------------------------------------------- */

  _weatherEmitters(dt, env, cam) {
    const rain = clamp01(env.rainIntensity || 0);
    const snow = clamp01(env.snowIntensity || 0);
    const r = this.rand;

    /* splashes: rain hitting the ground around the camera. This, far more
       than the streaks, is what tells the eye it is raining. */
    if (rain > 0.04) {
      this._acc.splash = (this._acc.splash || 0) + dt * (26 + rain * 210);
      let n = Math.min(24, this._acc.splash | 0);
      this._acc.splash -= n;
      while (n-- > 0) {
        const a = r() * 6.2831;
        const d = 0.7 + r() * r() * 15.0;
        const x = cam.position.x + Math.cos(a) * d;
        const z = cam.position.z + Math.sin(a) * d;
        const y = this._groundAt(x, z);
        _v.set(x, y, z);
        this._spawn('splash', _v, { scale: 0.6 + rain * 0.8 });
        if (r() < 0.35) {
          const j = this._spawn('sparks', _v, { scale: 0.35 });
          if (j >= 0) {
            const P = this.glow, j3 = j * 3, j4 = j * 4;
            P.vx[j3] = (r() - 0.5) * 1.2; P.vx[j3 + 1] = 0.9 + r() * 1.1;
            P.vx[j3 + 2] = (r() - 0.5) * 1.2;
            P.maxLife[j] = 0.24 + r() * 0.16; P.life[j] = P.maxLife[j];
            P.aColor[j4] = 0.55; P.aColor[j4 + 1] = 0.62; P.aColor[j4 + 2] = 0.75;
            P.aColor[j4 + 3] = 0.35;
          }
        }
      }
    }

    /* dust kicked up by movement over dry ground */
    const p = this.ctx.player;
    const spd = p ? (p.speed01 || 0) : 0;
    if (spd > 0.15 && (env.wetness || 0) < 0.45) {
      this._acc.hoof = (this._acc.hoof || 0) + dt * spd * (p.mode === 'mounted' ? 34 : 12);
      let n = Math.min(8, this._acc.hoof | 0);
      this._acc.hoof -= n;
      while (n-- > 0) {
        _v.copy(p.position);
        _v.x += (r() - 0.5) * 0.7;
        _v.z += (r() - 0.5) * 0.7;
        _v.y = this._groundAt(_v.x, _v.z) + 0.06;
        this._spawn('dust', _v, { scale: 0.8 + spd * 0.9 });
      }
    }

    /* wind-borne dust when it is dry and blowing hard */
    const dusty = clamp01((env.windStrength - 7) / 9) * (1 - clamp01(env.wetness * 2));
    if (dusty > 0.02) {
      this._acc.wdust = (this._acc.wdust || 0) + dt * dusty * 26;
      let n = Math.min(10, this._acc.wdust | 0);
      this._acc.wdust -= n;
      while (n-- > 0) {
        const a = r() * 6.2831, d = 4 + r() * 40;
        _v.set(cam.position.x + Math.cos(a) * d, 0, cam.position.z + Math.sin(a) * d);
        _v.y = this._groundAt(_v.x, _v.z) + r() * 1.6;
        this._spawn('dust', _v, { scale: 1.6 + dusty * 2.4 });
      }
    }

    /* leaves torn loose by a gust */
    const gust = clamp01(env.windGust || 0);
    if (gust > 0.45 && env.daylight > 0.15) {
      this._acc.leaf = (this._acc.leaf || 0) + dt * gust * 5;
      let n = Math.min(4, this._acc.leaf | 0);
      this._acc.leaf -= n;
      while (n-- > 0) {
        const a = r() * 6.2831, d = 3 + r() * 26;
        _v.set(cam.position.x + Math.cos(a) * d, 0, cam.position.z + Math.sin(a) * d);
        _v.y = this._groundAt(_v.x, _v.z) + 0.4 + r() * 3.2;
        this._spawn('leaves', _v, {});
      }
    }

    /* cold breath */
    if ((env.temperature != null ? env.temperature : 18) < 7 && p) {
      this._acc.breath = (this._acc.breath || 0) + dt;
      if (this._acc.breath > 2.4) {
        this._acc.breath = 0;
        _v.copy(p.position); _v.y += 1.55;
        _dir.set(Math.sin(p.yaw || 0), 0, Math.cos(p.yaw || 0));
        this.burst('breath', _v, 3, { dir: _dir });
      }
    }

    /* fireflies at dusk, denser near water */
    const dusk = clamp01(1 - Math.abs((env.timeOfDay - 20.4) / 2.2)) * (1 - clamp01(env.rainIntensity * 3));
    if (dusk > 0.05) {
      this._acc.ff = (this._acc.ff || 0) + dt * dusk * 9;
      let n = Math.min(4, this._acc.ff | 0);
      this._acc.ff -= n;
      const w = this.ctx.world;
      while (n-- > 0) {
        const a = r() * 6.2831, d = 3 + r() * 30;
        const x = cam.position.x + Math.cos(a) * d;
        const z = cam.position.z + Math.sin(a) * d;
        const nearWater = w && w.isWater ? (w.isWater(x, z) || w.isWater(x + 6, z) || w.isWater(x, z + 6)) : false;
        if (!nearWater && r() > 0.25) continue;
        _v.set(x, this._groundAt(x, z) + 0.3 + r() * 1.6, z);
        this._spawn('fireflies', _v, {});
      }
    }

    /* ground mist pooling in the low ground. PostFX runs a height-fog medium
       as well, but a medium alone has no silhouette — these sheets give the
       mist parallax and let it hug the terrain it is actually sitting on. */
    this._updateMist(dt, env, cam);

    /* the two stateless fields */
    const R = this.rain.uniforms;
    R.uDensity.value = smoothstep(0.02, 0.35, rain) * (0.35 + rain * 0.65);
    /* Rain is water, not chalk. Pass 2/3 drew it at 0.62 opacity tinted 1.55x
       the sky, which against a dark storm base reads as a screen of hard white
       scratches and discs — named as a regression in two forensic reports. */
    R.uOpacity.value = 0.30 * clamp01(rain * 2.2) * this.opacity;
    R.uFall.value = 9.0 + rain * 7.0;
    R.uStretch.value = 26 + rain * 30;
    R.uSize.value = 0.018 + rain * 0.008;
    const S = this.snow.uniforms;
    S.uDensity.value = smoothstep(0.02, 0.4, snow);
    S.uOpacity.value = 0.85 * clamp01(snow * 2.5) * this.opacity;
    const M = this.motes.uniforms;
    // motes only read against a low sun; at noon they are invisible anyway
    const lowSun = clamp01(1 - Math.abs(env.sunDirection.y - 0.20) * 2.6) * clamp01(env.daylight * 2);
    const dryAir = 1 - clamp01((env.rainIntensity || 0) * 3);
    /* Motes are ground-level dust. Kicked up off a trail they belong in the
       first few metres of air; floating past a camera that is 90 m up a ridge
       they read as fireflies in the sky, which is worse than having none. */
    const camUp = cam.position.y - this._camGround;
    const nearGround = 1 - smoothstep(7, 26, camUp);
    M.uDensity.value = (0.22 + dusty * 0.7) * dryAir * nearGround;
    M.uOpacity.value = (0.10 + lowSun * 0.55 + dusty * 0.5) * dryAir * nearGround * this.opacity;
  }

  _updateMist(dt, env, cam) {
    const P = this.mist;
    // a downpour scrubs the air; radiation fog and heavy rain do not coexist
    const amt = clamp01((env.groundMist || 0) * (1 - clamp01(env.rainIntensity || 0) * 0.8));
    /* PostFX runs a height-fog MEDIUM from the same env.groundMist. A medium
       has no silhouette, so these sheets are deliberately weighted heavier
       than the raw value: they are what gives the mist an edge, parallax and
       a readable top surface. */
    P.uniforms.uOpacity.value = clamp01(amt * 2.6) * this.opacity;
    if (amt < 0.02) { if (this._mistSeeded) { P.life.fill(0); this._mistSeeded = false; } return; }

    const r = this.rand;
    const camG = this._camGround;
    const need = Math.min(P.count, Math.round(P.count * clamp01(0.40 + amt * 2.2)));
    let live = 0;
    for (let i = 0; i < P.count; i++) if (P.life[i] > 0) live++;

    /* Radiation fog pools where the air is coldest, which is the LOW ground.
     * The reference height is the terrain under the camera, not the water
     * table: what makes a valley read is that the ridges stay clear while the
     * hollows fill, so anything more than a few tens of metres above the local
     * datum is rejected outright. */
    let toSpawn = Math.min(need - live, this._mistSeeded ? Math.ceil(dt * 26) : need);
    let tries = toSpawn * 6;
    while (toSpawn > 0 && tries-- > 0) {
      const a = r() * 6.2831;
      // sqrt gives a uniform areal distribution instead of a clump at the camera
      const d = 55 + Math.sqrt(r()) * 840;
      const x = cam.position.x + Math.cos(a) * d;
      const z = cam.position.z + Math.sin(a) * d;
      const h = this._groundAt(x, z);
      const above = h - camG;
      // ridges above the camera's own datum stay clear
      if (above > 26 + amt * 44) continue;
      const lowness = clamp01(1 - (above + 30) / (70 + amt * 60));
      if (r() > 0.25 + lowness * 0.85) continue;
      _v.set(x, h + 1.5 + r() * 5.0, z);
      const j = this._spawn('mist', _v, { scale: 0.85 + amt * 0.7 });
      if (j >= 0) P.a0[j] *= 0.45 + 0.75 * lowness;
      toSpawn--;
    }
    this._mistSeeded = true;
  }

  _runEmitters(dt) {
    for (const e of this._emitters) {
      if (!e.enabled) continue;
      if (e.follow && e.follow.position) e.position.copy(e.follow.position);
      e._acc += dt * e.rate;
      let n = Math.min(16, e._acc | 0);
      e._acc -= n;
      while (n-- > 0) {
        _v.copy(e.position);
        if (e.radius > 0) {
          _v.x += (this.rand() - 0.5) * e.radius * 2;
          _v.y += (this.rand() - 0.5) * e.radius;
          _v.z += (this.rand() - 0.5) * e.radius * 2;
        }
        this._spawn(e.name, _v, { scale: e.scale, color: e.color });
      }
    }
  }

  /* -- CPU integration ---------------------------------------------------- */

  _simulate(dt) {
    const wind = this._wind;
    for (const P of this._layers) {
      if (P.kind !== 'pool') continue;
      let any = 0;
      const { px, vx, life, maxLife, s0, s1, rot, rotV, drag, grav, a0 } = P;
      for (let i = 0; i < P.count; i++) {
        const i4 = i * 4;
        if (life[i] <= 0) { if (P.aParams[i4 + 2] !== 0) { P.aParams[i4 + 2] = 0; any = 1; } continue; }
        life[i] -= dt;
        const i3 = i * 3;
        if (life[i] <= 0) { P.aParams[i4 + 2] = 0; any = 1; continue; }

        const k = 1 - life[i] / Math.max(maxLife[i], 1e-3);   // 0 born .. 1 dead
        const d = drag[i];
        // semi-implicit drag toward the wind field
        const wf = P.name === 'mist' ? 0.16 : (d < 1 ? 0.55 : 0.30);
        vx[i3] += ((wind.x * wf) - vx[i3]) * Math.min(1, d * dt);
        vx[i3 + 2] += ((wind.z * wf) - vx[i3 + 2]) * Math.min(1, d * dt);
        vx[i3 + 1] += grav[i] * dt;
        vx[i3 + 1] -= vx[i3 + 1] * Math.min(1, d * dt * 0.5);

        px[i3] += vx[i3] * dt;
        px[i3 + 1] += vx[i3 + 1] * dt;
        px[i3 + 2] += vx[i3 + 2] * dt;

        rot[i] += rotV[i] * dt;

        const sz = s0[i] + (s1[i] - s0[i]) * (k < 0.35 ? smoothstep(0, 0.35, k) : 1) * (0.2 + k * 0.8);
        // born fast, die slow
        const fade = Math.min(1, k * 8) * (1 - smoothstep(0.55, 1.0, k));

        P.aPos[i3] = px[i3]; P.aPos[i3 + 1] = px[i3 + 1]; P.aPos[i3 + 2] = px[i3 + 2];
        P.aParams[i4] = sz;
        P.aParams[i4 + 1] = rot[i];
        P.aParams[i4 + 2] = fade * a0[i];
        any = 1;
      }
      if (any) {
        P.bPos.needsUpdate = true;
        P.bParams.needsUpdate = true;
        P.bColor.needsUpdate = true;
      }
    }
  }

  /* ------------------------------------------------------------ lateUpdate */

  lateUpdate(dt) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const env = ctx.env;
    const cam = ctx.camera;
    const renderer = ctx.renderer;

    /* ---- shared lighting ------------------------------------------------ */
    const sun = this.shared.uSunDir.value;
    const sunUp = env.sunDirection.y > 0.01 && env.sunIntensity > 0.02;
    const atten = 1 - clamp01(env.sunAttenuation || 0) * 0.9;
    if (sunUp) {
      sun.copy(env.sunDirection).normalize();
      this._sunCol.copy(env.sunColor).multiplyScalar(env.sunIntensity * atten * 0.85);
    } else {
      sun.copy(env.moonDirection).normalize();
      this._sunCol.copy(env.moonColor).multiplyScalar((env.moonIntensity || 0) * 0.9);
    }
    const lf = env.lightningFlash || 0;
    if (lf > 0.001) this._sunCol.addScalar(lf * 3.2);
    this.shared.uSunCol.value.copy(this._sunCol);

    const sky = ctx.get('sky');
    let ambI = Math.max(0, env.ambientIntensity);
    if (sky && typeof sky.getSkyIrradiance === 'function') {
      const irr = sky.getSkyIrradiance();
      if (irr && irr.color && isFinite(irr.intensity)) {
        ambI = Math.max(0, irr.intensity);
        this._skyCol.copy(irr.color).multiplyScalar(ambI);
        this._grdCol.copy(irr.groundColor || irr.color).multiplyScalar(ambI * 0.5);
      } else {
        this._skyCol.copy(env.ambientColor).multiplyScalar(ambI);
        this._grdCol.copy(env.ambientColor).multiplyScalar(ambI * 0.35);
      }
    } else {
      this._skyCol.copy(env.ambientColor).multiplyScalar(ambI);
      this._grdCol.copy(env.ambientColor).multiplyScalar(ambI * 0.35);
    }
    if (lf > 0.001) { this._skyCol.addScalar(lf * 2.0); this._grdCol.addScalar(lf * 0.9); }
    this.shared.uSkyCol.value.copy(this._skyCol);
    this.shared.uGroundCol.value.copy(this._grdCol);

    /* rain is a translucent surface, not an emitter — it should read as the
       sky seen through a lens, so tint it with the sky it is falling out of */
    this.rain.uniforms.uTint.value.copy(this._skyCol)
      .multiplyScalar(0.95).addScalar(0.01 + this._sunCol.r * 0.01);

    const dp = this.shared.uDepthParams.value;
    dp.x = cam.near; dp.y = cam.far;

    /* ---- field motion --------------------------------------------------- */
    const t = this._t;
    for (const L of [this.rain, this.snow, this.motes]) {
      L.uniforms.uTime.value = t;
      const w = L.uniforms.uWind.value;
      const shear = L.name === 'rain' ? 0.55 : (L.name === 'snow' ? 0.95 : 1.0);
      w.set(this._wind.x * shear, 0, this._wind.z * shear);
    }

    /* ---- rain on the lens ---------------------------------------------- */
    const LU = this.lensMat.uniforms;
    const rainAmt = clamp01(env.rainIntensity || 0);
    LU.uAmount.value = this.lensRain ? smoothstep(0.25, 0.85, rainAmt) * 0.45 : 0;
    LU.uTime.value = t;
    LU.uAspect.value.set(Math.max(1, cam.aspect), 1);
    LU.uSkyCol.value.copy(this._skyCol).multiplyScalar(1.6);
    LU.uSunCol.value.copy(this._sunCol).multiplyScalar(0.25);
    LU.uDrift.value = clamp01(this.ctx.player ? this.ctx.player.speed01 || 0 : 0) * 0.6;

    /* ---- half-res depth copy for the soft-particle fade ----------------- */
    const post = ctx.get('postfx');
    const src = post && post.depthTexture;
    if (src && this.depthRT) {
      this.copyMat.uniforms.tDepth.value = src;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(this.depthRT);
      renderer.render(this._copyScene, this._copyCam);
      renderer.setRenderTarget(prev);
    }
  }

  dispose() {
    const ctx = this.ctx;
    if (this._offs) for (const f of this._offs) { try { f(); } catch (e) { /* noop */ } }
    for (const L of this._layers) {
      ctx.scene.remove(L.mesh);
      L.mesh.geometry.dispose();
      L.mat.dispose();
    }
    if (this.lensMesh) ctx.scene.remove(this.lensMesh);
    if (this.lensMat) this.lensMat.dispose();
    if (this.copyMat) this.copyMat.dispose();
    if (this._quad) this._quad.dispose();
    if (this._fsQuad) this._fsQuad.dispose();
    if (this.depthRT) this.depthRT.dispose();
    if (this.atlas) this.atlas.dispose();
  }
}

/* -------------------------------------------------------------------------- */

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
function smoothstep(a, b, x) {
  const t = clamp01((x - a) / Math.max(b - a, 1e-6));
  return t * t * (3 - 2 * t);
}

/**
 * 2x2 sprite atlas, generated procedurally (no files anywhere in this project).
 *   0 (u<.5, v<.5)  soft puff, noise-broken — smoke, dust, mist, breath
 *   1 (u>.5, v<.5)  crisp dot — flakes, motes, embers, fireflies
 *   2 (u<.5, v>.5)  ring — splashes
 *   3 (u>.5, v>.5)  streak — raindrops
 * RGB is white; only alpha carries shape, so tinting is done in the shader.
 */
function makeAtlas(size, rand) {
  const h = size >> 1;
  const data = new Uint8Array(size * size * 4);

  // small value-noise field for the puff
  const NG = 16;
  const grid = new Float32Array(NG * NG);
  for (let i = 0; i < NG * NG; i++) grid[i] = rand();
  const noise = (x, y) => {
    const fx = x * NG, fy = y * NG;
    const x0 = Math.floor(fx) % NG, y0 = Math.floor(fy) % NG;
    const x1 = (x0 + 1) % NG, y1 = (y0 + 1) % NG;
    const tx = fx - Math.floor(fx), ty = fy - Math.floor(fy);
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = grid[y0 * NG + x0], b = grid[y0 * NG + x1];
    const c = grid[y1 * NG + x0], d = grid[y1 * NG + x1];
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tile = (x < h ? 0 : 1) + (y < h ? 0 : 2);
      const lx = (x % h) / h, ly = (y % h) / h;
      const dx = lx - 0.5, dy = ly - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;   // 0 centre .. 1 edge
      let a = 0;
      if (tile === 0) {
        const n = noise(lx * 2.4, ly * 2.4) * 0.55 + noise(lx * 6.1 + 3.1, ly * 6.1) * 0.30
                + noise(lx * 13.0, ly * 13.0 + 7.7) * 0.15;
        const fall = Math.max(0, 1 - r);
        a = Math.pow(fall, 1.55) * (0.55 + n * 0.9);
        a *= Math.max(0, 1 - Math.pow(r, 2.6));
      } else if (tile === 1) {
        a = Math.pow(Math.max(0, 1 - r), 2.2);
      } else if (tile === 2) {
        const ring = Math.exp(-Math.pow((r - 0.74) / 0.17, 2));
        a = ring * Math.max(0, 1 - Math.pow(r, 8));
      } else {
        // streak: soft vertical bar with tapered ends and a bright core
        const w = Math.exp(-Math.pow(dx / 0.155, 2));
        const l = Math.max(0, 1 - Math.pow(Math.abs(dy) * 2, 2.6));
        a = w * l;
      }
      const o = (y * size + x) * 4;
      const v = Math.max(0, Math.min(255, Math.round(a * 255)));
      data[o] = 255; data[o + 1] = 255; data[o + 2] = 255; data[o + 3] = v;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;   // shape data, not colour
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
