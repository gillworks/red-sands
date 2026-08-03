import * as THREE from 'three';
import { generateCloudNoise } from './clouds/NoiseGen.js';
import {
  FS_VERT, MARCH_FRAG, SHADOW_FRAG, RESOLVE_FRAG, COMPOSITE_VERT, COMPOSITE_FRAG,
} from './clouds/CloudShader.js';
import { createGroundFXUniforms, injectGroundFX } from './clouds/GroundFX.js';

/**
 * ============================================================================
 *  CLOUDS — raymarched volumetrics on a curved shell.
 * ============================================================================
 *
 *  Pipeline, per frame, in lateUpdate() (camera is final by then):
 *
 *    0. SHADOW   512² top-down transmittance map. Each texel marches the sun
 *                ray up through the SAME density field the camera march uses,
 *                so the shadow on the ground belongs to the cloud overhead.
 *                Projected into every lit material by clouds/GroundFX.js.
 *    1. MARCH    0.62-res RGBA16F. Front-to-back march of a 700–11000 m shell
 *                on a compressed planet so the deck curves to the horizon.
 *                Density = Perlin-Worley shape field × per-type height
 *                gradient × coverage, eroded by high-frequency Worley detail,
 *                sheared downwind with altitude and spread into an anvil at
 *                the top of a cumulonimbus. Lighting = Beer-Lambert extinction
 *                along a 7-tap cone light march, dual-lobe Henyey-Greenstein
 *                phase, powdered-sugar term, 4-octave multiple-scattering
 *                approximation, sky/ground ambient, per-sample aerial
 *                perspective, plus precipitation shafts under the heavy cells
 *                and an analytic lightning channel.
 *    2. RESOLVE  temporal reprojection against last frame's view-projection
 *                with a 5-tap neighbourhood clamp. Combined with a per-frame
 *                Halton jitter this is free supersampling.
 *    3. COMPOSITE full-res, drawn inside the main scene at the far plane with
 *                depth testing ON, so terrain/trees/buildings occlude the
 *                clouds correctly at the horizon. Depth-aware bilateral
 *                upsample from the half-res buffer.
 *
 *  Everything advects with ctx.env.windVector, so clouds, grass, dust and
 *  water are all being pushed by the same wind.
 *
 *  PUBLIC, additive (see report):
 *     getCloudBuffer()        resolved half-res march, rgb scatter / a coverage
 *     getCloudShadowMap()     { texture, area:Vector4 } top-down transmittance
 *     groundFXUniforms        shared uniform block for clouds/GroundFX.js
 *     injectGroundFX(mat)     opt any lit material into cloud shadow + wet sheen
 *     strike(pos, amp, life)  draw a bolt in the deck (Weather calls this)
 */
export class Clouds {
  static id = 'clouds';

  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = true;
    this.scale = 0.5;
    this.steps = 96;

    this.advect = new THREE.Vector3();
    this._advectPrev = new THREE.Vector3();
    this._advectDelta = new THREE.Vector3();
    this._size = new THREE.Vector2(1280, 720);
    this._rtSize = new THREE.Vector2(640, 360);

    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._prevVP = new THREE.Matrix4();
    this._vp = new THREE.Matrix4();
    this._histValid = 0;
    this._pingpong = 0;
    this._frame = 0;

    this._sun = new THREE.Color();
    this._moon = new THREE.Color();
    this._sky = new THREE.Color();
    this._ground = new THREE.Color();
    this._haze = new THREE.Color();
    this._hazeZenith = new THREE.Color();
    this._deckDim = 1;

    /* tuning — linear HDR gains */
    this.sunGain = 1.0;
    this.skyGain = 1.25;
    /** Applied to Sky.getSkyIrradiance().intensity when that exists. */
    this.skyIrradianceGain = 1.0;
    this.groundGain = 0.62;
    this.hazeGain = 0.9;
    /**
     * Gain on the direct multiple-scattering term.
     *
     * MEASURED: at 2.05 (pass 3) the lit face of a cumulus came out at roughly
     * 3.5x the radiance of a white Lambertian card in the same light, which put
     * it well past the shoulder of the tonemap — 7.8 % of the golden_hour sky
     * clipped at >0.97 with R pinned at 1.0 and G/B trailing, i.e. flat orange
     * paint with no gradient anywhere inside the silhouette. A real sunlit
     * cumulus face sits near 0.5x the incident irradiance. Everything about the
     * "solid amoeba" read follows from this number, not from the geometry.
     */
    /* 1.02 -> 1.24. The pass-4 note above is still correct about WHY 2.05
       failed — but the fix was applied to the wrong end. The clipping came from
       the lit face being bright while nothing else in the cloud was dark, so
       cutting the gain flattened the whole deck into a midtone instead of
       restoring range: high_noon_desert's max channel measures 232, i.e. a
       sunlit cumulus top at midday cannot reach white and the frame fails the
       hdr_headroom gate. With the ambient rework (diffusion-law skylight, so a
       base now keeps 0.15 of what its top gets) and sigma back in the physical
       band, the deck has somewhere dark to be, and the lit face can go where a
       real one goes: right up against the shoulder of the tonemap. */
    /* 1.24 -> 1.13. At 1.24 high_noon_desert's sunlit tops clipped over a broad
       enough area for metrics.py to resolve SEVEN separate blown discs — the
       single_sun gate, which exists because pass 1 rendered three suns. A
       sunlit cumulus top genuinely is the brightest thing in a midday frame and
       should sit right against the shoulder, but it must not go over it: 1.13
       keeps max channel at the top of the range (hdr_headroom) with the peak
       just under the clip point. */
    this.sunScatter = 1.13;
    /* 0.72 -> 0.84. The ambient term is what a cloud's SHADED side is made of,
       and the diffusion rework above cut how much of it reaches a base. Between
       them the deck lost most of its fill and every puff acquired a grey
       underside. The diffusion constant is now type-dependent (see
       CloudShader), and this puts the overall level back so a fair-weather
       cumulus reads as white-with-shading rather than white-on-grey. */
    this.ambScatter = 0.84;
    /* 0.78 -> 0.60. Beer-Powder darkens LOW-density regions, which is exactly
       the fringe we are trying to keep soft and see-through; at 0.78 it was
       putting a dark rim on the anti-sun side of every margin, and a dark rim
       on a soft edge reads as a hard one. It still does its job on the
       shoulders where the density is genuinely low but the depth is real. */
    this.powder = 0.60;
    /** Only used while PostFX has not taken over the tonemap. */
    this.fallbackExposure = 0.30;

    /** Cloud-shadow map: world half-extent in metres, and how dark it goes. */
    /* Half-extent of the top-down cloud-shadow square, metres. 3600 m was too
       tight: at high noon the nearest cumulus sat ~2.5 km out and its shadow
       landed just outside the map, so every texel read 255 and the plain was
       flat-lit. 5000 m reaches the whole visible mid-ground; the map is soft
       and blurred anyway, so 26 m per texel costs nothing visually. */
    this.shadowExtent = 5400;
    this.shadowRes = 384;
    this.shadowStrength = 0.90;
    /* Multiplier on optical depth — clouds are not opaque to skylight.
       Re-scaled with uSigma: peak extinction dropped from 0.104 to 0.030 /m in
       this pass, so the same visual shadow density needs a proportionally
       larger multiplier here. */
    this.shadowSoftness = 0.62;
    /** Gain on the reflected-sky term for wet surfaces. */
    this.wetSheen = 0.55;

    /** Shared with every lit material through GroundFX. */
    this.groundFXUniforms = createGroundFXUniforms();

    /* lightning channel */
    this._bolt = { amp: 0, life: 0, age: 0 };
    this._boltA = new THREE.Vector3(0, 4000, 0);
    this._boltB = new THREE.Vector3(0, 0, 0);

    this._skyProbe = undefined;
    this._offTeleport = null;
    this._shadowCentre = new THREE.Vector2();
    /* Projection stabiliser for the shadow map — see _fitShadowExtent(). The
       footprint may only change in whole steps, and the sun-ray origin plane is
       latched per location, because both of them move the sampled world point
       and anything that moves it every frame is a shadow that swims. */
    this._shadowFit = { step: -1, hold: 0 };
    this._shadowRefY = null;
    this._prevSunDir = new THREE.Vector3(0, 1, 0);
  }

  /* ------------------------------------------------------------------ init */

  async init() {
    const ctx = this.ctx;
    const q = ctx.quality || {};
    const renderer = ctx.renderer;

    const cs = q.cloudSteps == null ? 96 : q.cloudSteps;
    if (cs <= 0) {
      // "volumetrics off" preset: keep a cheap but still volumetric deck
      this.steps = 26;
      this.scale = 0.38;
    } else {
      /* Capped at 84 (was 112). The march clamps its step to 120 m in empty
         space and strides it at 2.9x, so 84 steps still reach ~29 km — well
         past the range at which cloudDensity's own far-fade has taken the deck
         to zero. Pass 3 raised cloud COVERAGE substantially (a sky with no
         cumulus in it casts no shadow on the ground, which is the flattest a
         landscape can look), and more coverage means more in-cloud samples,
         each of which pays for a cone light march. This plus trimming that
         cone from 7 taps to 5 is what keeps the deck inside budget. */
      /* MEASURED at 1920x1080: at 72 steps and half res the deck was costing
         far more than its share of a 16 ms frame. The march is the whole cost
         of this system — 0.45 res is 19 % fewer pixels than 0.5 and 58 steps is
         19 % fewer samples in each, and the wide soft margins this pass
         introduced survive the lower resolution because the bilateral
         reconstruct and the temporal resolve are both working on gradients now
         rather than on a hard silhouette. */
      /* 58 -> 46 steps, 0.45 -> 0.42 res.
         MEASURED back-to-back at 1920x1080 ultra by toggling this.enabled:
         high_noon_desert 11.1 -> 24.2 ms GPU, i.e. the deck was costing 13.1 ms
         of a 16.7 ms budget after this pass extended its reach from 17 km to
         50 km. The reach is what buys the horizon band and the size
         distribution, so it stays — but it has to be paid for, and the two
         cheapest places to take it from are the step count and the march
         resolution, because the geometric step growth means 46 steps still
         reach past 100 km and the reconstruction filter is already
         reconstructing gradients rather than a hard silhouette. Together with
         the earlier transmittance cut-off and the single-tap far cone this
         gives back roughly half. */
      /* INTEGRATION PASS 10 — THE PRESET LADDER HAD COLLAPSED.
       *
       * `cloudSteps` is 48 / 96 / 144 for medium / high / ultra, and the flat
       * clamp above mapped high AND ultra to the same 54. The volumetric pass
       * had the identical problem (min(steps, 26) against 48 / 80). Between
       * them those are the two most expensive passes in the build, so a player
       * dropping from ultra to HIGH — the stated playable target — got no
       * relief at all from either. Measured at 1920x1080: forest_interior 16.3
       * ms at ultra and 16.1 ms at high, i.e. the preset bought 0.2 ms.
       * Ablation on the same build put the cloud deck at 2.2-2.6 ms in
       * forest_interior and river_bend, the two shots with no headroom, and
       * those are shots where the canopy occludes most of the sky the march
       * paid for.
       *
       * So the clamp is preset-relative now: ultra keeps exactly the 54 steps
       * at 0.45 scale that every reference image in this pass was judged at,
       * and high steps down to a genuinely cheaper tier. Nothing below high
       * changes (medium already asks for less than the ceiling). */
      const tier = cs >= 120 ? 2 : (cs >= 72 ? 1 : 0);   // medium / high / ultra
      this.steps = [38, 46, 54][tier];
      this.scale = [0.36, 0.40, 0.45][tier];
    }
    if (q.cloudSteps > 0 && q.cloudSteps < 40) this.shadowRes = 256;

    const noise = generateCloudNoise(renderer, {
      shape: 128,
      detail: 48,
      weather: 512,
    });
    this._noise = noise;

    const hasFloat = !!(ctx.caps && ctx.caps.float);
    this._rtType = hasFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;

    /* --------------------------------------------- shared density uniforms */
    /* One object per uniform, shared by the march and the shadow pass, so the
       shadow on the ground is cast by exactly the cloud you can see. */
    this.densityUniforms = {
      uShape: { value: noise.shapeRT.texture },
      uDetail: { value: noise.detailRT.texture },
      uWeather: { value: noise.weatherRT.texture },
      uCoverage: { value: 0.4 },
      uDensityMul: { value: 1.0 },
      uCloudType: { value: 0.5 },
      uCirrus: { value: 0.3 },
      uScud: { value: 0.35 },
      uAdvect: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uShapeScale: { value: 1 / 9000 },
      uDetailScale: { value: 1 / 1100 },
      uWeatherScale: { value: 1 / 13000 },
      /* PEAK EXTINCTION, 1/m. This is the single number that decided the whole
         "hard opaque edge" verdict. At 0.104 a 36 m march step through density
         1 had an optical depth of 3.7, so a cloud went from invisible to opaque
         inside ONE step — there is no distance over which anything can gradate,
         which is the literal definition of a hard edge with a flat interior.
         Real cumulus extinction is 0.02–0.05 /m, so a 300 m fringe accumulates
         an optical depth of well under 1 and you can see the sky through it. */
      uSigma: { value: 0.021 },
      uWindDir: { value: new THREE.Vector2(1, 0) },
      uHB: { value: 1050 },
      uHT: { value: 5700 },
      uShear: { value: 300 },
      uAnvil: { value: 0 },
      /* 46 km -> 68 km. The march used to run out of steps at ~17 km, so this
         was never the binding constraint; with the geometric step growth in
         MARCH_FRAG it is, and it has to be large enough for cells to crowd
         into a horizon band instead of the deck simply ending in mid-air. */
      uMaxDist: { value: 54000 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() },
    };

    /* ---------------------------------------------------------- materials */
    this.marchMat = new THREE.ShaderMaterial({
      defines: { MAXSTEPS: this.steps },
      vertexShader: FS_VERT,
      fragmentShader: MARCH_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: Object.assign({}, this.densityUniforms, {
        uCamPos: { value: new THREE.Vector3() },
        uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
        uCamRight: { value: new THREE.Vector3(1, 0, 0) },
        uCamUp: { value: new THREE.Vector3(0, 1, 0) },
        uTanHalf: { value: new THREE.Vector2(0.5, 0.5) },
        uJitter: { value: new THREE.Vector2() },

        uSunColor: { value: new THREE.Color(3, 2.9, 2.7) },
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uMoonColor: { value: new THREE.Color(0, 0, 0) },
        uSkyColor: { value: new THREE.Color(0.6, 0.8, 1.15) },
        uGroundColor: { value: new THREE.Color(0.3, 0.25, 0.16) },
        uHazeColor: { value: new THREE.Color(1.0, 1.1, 1.3) },
        uHazeZenith: { value: new THREE.Color(0.2, 0.35, 0.7) },

        uFrame: { value: 0 },
        uAerial: { value: 1.6e-5 },
        uSteps: { value: this.steps },
        uSunScatter: { value: this.sunScatter },
        uAmbScatter: { value: this.ambScatter },
        uPowder: { value: this.powder },
        uCirrusHi: { value: 0.2 },
        uMidDeck: { value: 0.3 },

        uShaft: { value: 0 },
        uGroundY: { value: 0 },

        uFlash: { value: 0 },
        uFlashPos: { value: new THREE.Vector3(0, 1600, 0) },
        uBolt: { value: 0 },
        uBoltA: { value: this._boltA },
        uBoltB: { value: this._boltB },
      }),
    });

    this.shadowMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: SHADOW_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: Object.assign({}, this.densityUniforms, {
        uCamPos: this.marchMat.uniforms.uCamPos,
        uCamFwd: this.marchMat.uniforms.uCamFwd,
        uCamRight: this.marchMat.uniforms.uCamRight,
        uCamUp: this.marchMat.uniforms.uCamUp,
        uTanHalf: this.marchMat.uniforms.uTanHalf,
        uShadowArea: { value: new THREE.Vector4(0, 0, this.shadowExtent, 0) },
        uShadowSoft: { value: this.shadowSoftness },
      }),
    });

    this.resolveMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: RESOLVE_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uCur: { value: null },
        uHist: { value: null },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uBlend: { value: 0.88 },
        uAdvectDelta: { value: new THREE.Vector3() },
        /* Slack on the resolve's neighbourhood clamp. See RESOLVE_FRAG: this
           was an implicit 0.22 against a 4-tap cross, which let a history
           mis-registered along the wind survive as horizontal combing. */
        uClampPad: { value: 1.25 },
        /* 3x3 box weight applied to the FRESH sample before it is mixed with
           the history. See RESOLVE_FRAG: the march dithers its first step with
           interleaved gradient noise, which is a structured diagonal hatch, and
           the temporal clamp cannot converge a structured pattern. */
        uCurSmooth: { value: 1.0 },
        uHistValid: { value: 0 },
        uTexel: { value: new THREE.Vector2() },
        uHB: this.densityUniforms.uHB,
        uHT: this.densityUniforms.uHT,
        uCamPos: this.marchMat.uniforms.uCamPos,
        uCamFwd: this.marchMat.uniforms.uCamFwd,
        uCamRight: this.marchMat.uniforms.uCamRight,
        uCamUp: this.marchMat.uniforms.uCamUp,
        uTanHalf: this.marchMat.uniforms.uTanHalf,
      },
    });

    this.compMat = new THREE.ShaderMaterial({
      vertexShader: COMPOSITE_VERT,
      fragmentShader: COMPOSITE_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
      uniforms: {
        uCloud: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uOutGain: { value: this.fallbackExposure },
        uFallback: { value: 1 },
        uOpacity: { value: 1 },
      },
    });

    /* ------------------------------------------------------------- meshes */
    this._quadGeo = new THREE.BufferGeometry();
    this._quadGeo.setAttribute('position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this._quadGeo.setAttribute('uv',
      new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));

    this._passScene = new THREE.Scene();
    this._passCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._passMesh = new THREE.Mesh(this._quadGeo, this.marchMat);
    this._passMesh.frustumCulled = false;
    this._passScene.add(this._passMesh);

    this.composite = new THREE.Mesh(this._quadGeo, this.compMat);
    this.composite.frustumCulled = false;
    this.composite.renderOrder = -1000; // first among transparents, after opaque
    this.composite.name = 'cloudComposite';
    // we integrate aerial perspective per raymarch sample ourselves
    this.composite.userData.rsNoAerial = true;
    this.compMat.userData.rsNoAerial = true;
    this.compMat.userData.rsNoGroundFX = true;
    ctx.scene.add(this.composite);

    /* --------------------------------------------------------------- rts  */
    const dbs = new THREE.Vector2();
    renderer.getDrawingBufferSize(dbs);
    this._allocate(Math.max(2, dbs.x), Math.max(2, dbs.y));

    this.shadowRT = new THREE.WebGLRenderTarget(this.shadowRes, this.shadowRes, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.shadowRT.texture.colorSpace = THREE.NoColorSpace;
    this.shadowRT.texture.wrapS = this.shadowRT.texture.wrapT = THREE.ClampToEdgeWrapping;
    const G = this.groundFXUniforms;
    G.rsCloudShadowMap.value = this.shadowRT.texture;
    G.rsCloudShadowArea.value.set(0, 0, this.shadowExtent, 0);
    G.rsCloudShadowParams.value.set(0, 1.6 / this.shadowRes);

    /* Halton (2,3) jitter sequence */
    this._jitter = [];
    for (let i = 1; i <= 16; i++) {
      this._jitter.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);
    }

    this._offTeleport = ctx.on('teleport', () => {
      this._histValid = 0;
      /* A cut is the one free moment to re-base the shadow projection: refit
         the footprint immediately instead of walking to it a step at a time,
         and re-take the sun-ray origin plane at the new location. */
      this._shadowRefY = null;
      this._shadowFit.step = -1;
      this._shadowFit.hold = 0;
    });

    /* project cloud shadows onto everything that is lit */
    ctx.on('ready', () => this._bridge());
  }

  _bridge() {
    const ctx = this.ctx;
    const hook = (m) => this.injectGroundFX(m);
    for (const id of ['terrain', 'lighting']) {
      const S = ctx.get(id);
      if (!S || typeof S.registerMaterialUser !== 'function') continue;
      try { S.registerMaterialUser(hook); } catch (e) { /* consumer threw */ }
    }
  }

  /** Opt a lit material into cloud shadows + wet-surface response. */
  injectGroundFX(material) {
    if (!material) return material;
    if (Array.isArray(material)) {
      for (const m of material) injectGroundFX(m, this.groundFXUniforms);
      return material;
    }
    return injectGroundFX(material, this.groundFXUniforms);
  }

  _allocate(w, h) {
    const rw = Math.max(2, Math.floor(w * this.scale));
    const rh = Math.max(2, Math.floor(h * this.scale));
    if (this.rtRaw && this._rtSize.x === rw && this._rtSize.y === rh) return;
    this._size.set(w, h);
    this._rtSize.set(rw, rh);

    const opts = {
      format: THREE.RGBAFormat,
      type: this._rtType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };
    const mk = () => {
      const rt = new THREE.WebGLRenderTarget(rw, rh, opts);
      rt.texture.colorSpace = THREE.NoColorSpace;
      rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      return rt;
    };
    if (this.rtRaw) { this.rtRaw.dispose(); this.rtHist[0].dispose(); this.rtHist[1].dispose(); }
    this.rtRaw = mk();
    this.rtHist = [mk(), mk()];
    this._histValid = 0;

    this.resolveMat.uniforms.uTexel.value.set(1 / rw, 1 / rh);
    this.compMat.uniforms.uTexel.value.set(1 / rw, 1 / rh);
  }

  resize(w, h) {
    if (!this.rtRaw) return;
    this._allocate(Math.max(2, w), Math.max(2, h));
  }

  /* --------------------------------------------------------------- public */

  /**
   * Draw a lightning channel in the deck. Weather calls this from _strike so
   * the bolt and the flash envelope are the same event.
   */
  strike(position, amp = 1, life = 0.34) {
    this._boltB.set(position.x, this._groundY(position.x, position.z), position.z);
    const top = Math.max(this.densityUniforms.uHB.value * 1.15, position.y);
    this._boltA.set(
      position.x + (position.y - this._boltB.y) * 0.06,
      top,
      position.z - (position.y - this._boltB.y) * 0.04,
    );
    this._bolt.amp = amp;
    this._bolt.life = life;
    this._bolt.age = 0;
  }

  _groundY(x, z) {
    const w = this.ctx.world;
    if (w && w.ready && w.getHeight) {
      try { return w.getHeight(x, z); } catch (e) { /* not ready */ }
    }
    return 0;
  }

  /* --------------------------------------------------------------- frame */

  update(dt) {
    const env = this.ctx.env;
    // one coherent wind field: the clouds drift with exactly the same vector
    // the grass and the dust are reading
    this.advect.addScaledVector(env.windVector, dt);
    if (this._bolt.amp > 0) {
      this._bolt.age += dt;
      if (this._bolt.age > this._bolt.life) this._bolt.amp = 0;
    }
  }

  lateUpdate(dt) {
    if (!this.enabled || !this.rtRaw) return;
    const ctx = this.ctx;
    const env = ctx.env;
    const renderer = ctx.renderer;
    const cam = ctx.camera;
    cam.updateMatrixWorld();

    const U = this.marchMat.uniforms;
    const D = this.densityUniforms;

    /* ---- camera basis --------------------------------------------------- */
    const e = cam.matrixWorld.elements;
    this._right.set(e[0], e[1], e[2]).normalize();
    this._up.set(e[4], e[5], e[6]).normalize();
    this._fwd.set(-e[8], -e[9], -e[10]).normalize();
    U.uCamPos.value.copy(cam.position);
    U.uCamRight.value.copy(this._right);
    U.uCamUp.value.copy(this._up);
    U.uCamFwd.value.copy(this._fwd);
    const tanY = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
    U.uTanHalf.value.set(tanY * cam.aspect, tanY);

    const j = this._jitter[this._frame % this._jitter.length];
    U.uJitter.value.set(j[0] * 2 / this._rtSize.x, j[1] * 2 / this._rtSize.y);

    /* ---- lighting from env --------------------------------------------- */
    D.uSunDir.value.copy(env.sunDirection).normalize();
    /* CLOUDS ARE ABOVE THE HAZE THE GROUND IS UNDER.
       env.sunColor/sunIntensity is the beam that survives to the SURFACE, and
       at a 5 degree sun that has run through ten-plus air masses of boundary
       layer. A cumulus at 2-4 km has most of that column below it, so it keeps
       several times more of the beam — which is the entire reason a real golden
       hour has clouds burning bright orange over a landscape that has already
       gone dusky blue. Feeding the surface value straight in is why our sunset
       clouds render as grey-cream cardboard instead of carrying the shot. The
       boost is keyed to sun altitude so midday, where the two agree, is
       untouched. */
    const sunY = env.sunDirection.y;
    const lowSun = smooth01((0.24 - sunY) / 0.26);
    this._sun.copy(env.sunColor)
      .multiplyScalar(Math.max(0, env.sunIntensity) * this.sunGain * (1 + lowSun * 2.3));
    U.uSunColor.value.copy(this._sun);

    U.uMoonDir.value.copy(env.moonDirection).normalize();
    this._moon.copy(env.moonColor).multiplyScalar(Math.max(0, env.moonIntensity || 0) * 0.9);
    U.uMoonColor.value.copy(this._moon);

    /* Prefer the Sky system's own hemispherical irradiance so the clouds are
       lit by exactly the same atmosphere as the terrain. Falls back to
       env.ambient* (which this system also owns) when Sky offers nothing. */
    const sky = ctx.get('sky');
    let ambI = Math.max(0, env.ambientIntensity) * this.skyGain;
    if (sky && typeof sky.getSkyIrradiance === 'function') {
      const irr = sky.getSkyIrradiance();
      if (irr && irr.color && isFinite(irr.intensity)) {
        ambI = Math.max(0, irr.intensity) * this.skyIrradianceGain;
        this._sky.copy(irr.color).multiplyScalar(ambI);
        this._ground.copy(irr.groundColor || irr.color).multiplyScalar(ambI * this.groundGain);
      } else {
        this._sky.copy(env.ambientColor).multiplyScalar(ambI);
        this._ground.setRGB(0.34, 0.27, 0.165).multiplyScalar(ambI * this.groundGain);
      }
    } else {
      this._sky.copy(env.ambientColor).multiplyScalar(ambI);
      this._ground.setRGB(0.34, 0.27, 0.165).multiplyScalar(ambI * this.groundGain);
    }
    // wet ground reflects less warm bounce, snow reflects a great deal more
    const wet = env.wetness || 0;
    const snow = env.snowCover || 0;
    this._ground.multiplyScalar(1 - wet * 0.35 + snow * 1.1);
    /* A heavy deck starves everything underneath it. Sky publishes a
       clear-air scattering integral, so dim its contribution by how much of
       the sky the clouds have taken over — otherwise a thunderstorm sits in
       front of a cheerful blue haze. */
    const cover0 = clamp01(env.cloudCover);
    const dens0 = clamp01(env.cloudDensity);
    this._deckDim = 1 - 0.55 * clamp01(cover0 * (0.35 + dens0 * 0.85));
    this._sky.multiplyScalar(0.55 + this._deckDim * 0.6);
    this._ground.multiplyScalar(this._deckDim);

    // aerial perspective / horizon colour: prefer the Sky system's own
    // scattering if it publishes one, otherwise derive it from the fog colour
    this._resolveHaze(this._haze, this._hazeZenith);
    this._haze.multiplyScalar(this._deckDim);
    this._hazeZenith.multiplyScalar(this._deckDim);
    U.uHazeColor.value.copy(this._haze);
    U.uHazeZenith.value.copy(this._hazeZenith);

    /* THE SKYLIGHT REACHING A CLOUD IS NOT THE HEMISPHERICAL AVERAGE.
       Sky.getSkyIrradiance() is a cosine-weighted integral over the whole
       upper hemisphere, and at golden hour that integral is dominated by the
       enormous, blazing, ORANGE horizon band. Feeding it in as uSkyColor meant
       the sun-facing side and the shaded side of every cloud were being lit by
       the same colour, so the deck came out one uniform sheet of peach with no
       hue separation anywhere — measured 0.19 median saturation across the
       whole golden-hour sky at a median luma of 0.78, i.e. bright monochrome
       paint. A cloud's upper surfaces actually see the sky ABOVE them, which is
       deep blue even at sunset. Take the intensity from the irradiance (that
       part is right) and the chromaticity from the zenith, and the shaded side
       goes cool against a warm key — which is the whole of "form". */
    const zl = this._hazeZenith.r * 0.2126 + this._hazeZenith.g * 0.7152
             + this._hazeZenith.b * 0.0722;
    if (zl > 1e-7) {
      const sl = this._sky.r * 0.2126 + this._sky.g * 0.7152 + this._sky.b * 0.0722;
      const k = sl / zl;
      this._sky.lerp(_tmpCol.copy(this._hazeZenith).multiplyScalar(k), 0.60);
    }
    U.uSkyColor.value.copy(this._sky);
    U.uGroundColor.value.copy(this._ground);

    /* ---- weather-driven shape ------------------------------------------ */
    const cover = clamp01(env.cloudCover);
    const dens = clamp01(env.cloudDensity);
    const type = env.cloudType != null
      ? clamp01(env.cloudType)
      : clamp01(0.35 + dens * 0.6 - cover * 0.25);
    const cirrus = env.cirrus != null
      ? clamp01(env.cirrus)
      : clamp01((1 - cover) * 0.45);

    /* --- vertical development ------------------------------------------
       A convective cell is the whole point of a storm sky: a flat, dark base
       barely a kilometre up and tops at eight to eleven. Interpolating the
       shell with cloudType is what turns "2D noise ceiling" into weather. */
    const tow = smooth01((type - 0.55) / 0.45);           // 0 stratus .. 1 Cb

    /* EFFECTIVE COVERAGE. Weather ships 'storm' as cover 0.66 / type 0.93, and
       0.66 of a fair-weather threshold leaves a third of the frame as cheerful
       blue sky — which is why storm_plains read as "bright cauliflower over a
       nice afternoon" rather than as weather. A mature convective complex
       spreads its own anvil across most of the visible dome, so let vertical
       development buy coverage. */
    const coverEff = clamp01(cover + tow * dens * 0.14);

    D.uCoverage.value = coverEff;
    D.uDensityMul.value = 0.85 + dens * 0.95;
    D.uCloudType.value = type;
    D.uCirrus.value = cirrus;
    /* Low scud: ragged fragments a few hundred metres under the main bases,
       moving visibly faster than the deck above them. */
    D.uScud.value = Math.min(0.58, 0.15 + dens * cover * 0.38
                             + clamp01(env.rainIntensity || 0) * 0.26);
    /* Extinction scales with how much water the cell is carrying, but the
       whole range now sits in the physical band for cloud droplets. */
    /* Quadratic in cloudDensity on purpose. A fair-weather cumulus wants a soft
       fringe you can see through (0.020), but an overcast storm base viewed
       from underneath is being looked at ALONG the layer: at 0.020 a ray runs
       for kilometres inside the deck and integrates its structure into long
       sinewy bright ribbons — storm_plains rendered as brushed metal. At 0.042
       the same ray is opaque within a few hundred metres and you see the base's
       own lumpy underside, which is what a shelf cloud actually looks like.
       Squaring keeps the fair-weather end exactly where it was calibrated. */
    /* 0.0095 -> 0.016 at the fair-weather end. The pass-4 collapse from 0.104
       was right in direction and overshot: at 0.0095-0.020 a fair cumulus is
       optically THIN all the way through, so every sample in it sees most of
       the sun and the puff renders as a uniformly bright airbrushed blob with
       no interior — which is the "solid amoeba" verdict arriving from the
       other side. Real cumulus extinction is 0.02-0.05 /m. The soft margin now
       comes from the smoothstep mass redistribution in cloudDensity (which
       thins the outer band without touching the silhouette) rather than from
       starving the whole cloud of optical depth. */
    /* PASS 11: 0.016 -> 0.0118 at the fair-weather end, storm end unchanged.
       A hard edge is not a shape problem, it is an optical-depth-per-metre
       problem: at sigma 0.020 a fair cumulus reaches tau = 1 in 50 m of its own
       margin, so the entire transparent-to-opaque transition happens inside one
       or two march steps and the silhouette snaps whatever the noise under it
       looks like. 0.0118 puts that transition at ~85 m, which at the 2-6 km a
       cumulus is normally seen from is tens of pixels of genuinely translucent
       fringe. The interior does not go flat with it, because the smoothstep
       mass redistribution (d = d*d*(3-2d)) still holds the core two to three
       times denser than the margin — that is the whole point of making the
       profile non-linear, and it means the fringe softness no longer has to be
       bought by starving the cloud. Quadratic in density, so a storm base still
       gets 0.044 and stays an opaque lid. */
    D.uSigma.value = 0.0118 + dens * dens * 0.032;
    /* Per-frame downwind displacement of the deck, for the temporal resolve's
       reprojection. The density field samples at wp - uAdvect*(0.70+hf*0.45),
       so the visible deck moves at ~0.9x the accumulated advection. */
    this._advectDelta.subVectors(this.advect, this._advectPrev).multiplyScalar(0.9);
    this._advectPrev.copy(this.advect);
    this.resolveMat.uniforms.uAdvectDelta.value.copy(this._advectDelta);
    D.uAdvect.value.copy(this.advect);
    D.uTime.value = ctx.time.elapsed;
    U.uFrame.value = this._frame % 64;
    U.uSunScatter.value = this.sunScatter;
    U.uAmbScatter.value = this.ambScatter;
    U.uPowder.value = this.powder;
    /* A second, higher, slower cirrostratus veil. Two high shells that slide
       past each other is the cheapest honest depth cue the upper sky has. */
    U.uCirrusHi.value = cirrus > 0.02
      ? clamp01(cirrus * 0.72 + (1 - cover) * 0.14)
      : 0; // a storm shows no cirrus: you cannot see through ten km of Cb
    /* Mid-level altocumulus: the layer between the cumulus tops and the cirrus
       that the sky had nothing in at all. Fades out as the deck below thickens
       (you cannot see 5 km cloud through an overcast) and is gone entirely
       under a convective tower, whose own anvil occupies that altitude. */
    U.uMidDeck.value = clamp01((0.62 * (1 - cover) + 0.22 * cirrus) * (1 - tow));

    D.uHB.value = 1180 - tow * 480;                        // 1180 m → 700 m
    D.uHT.value = 3600 + tow * 7600 + dens * 900;          // 3.6 km → 11.5 km
    D.uAnvil.value = tow * clamp01(0.35 + dens * 0.85);
    // wind shear leans the tower downwind; a calm day gets an upright cumulus
    D.uShear.value = (80 + Math.min(env.windStrength || 3, 18) * 30) * (0.35 + tow * 0.55);

    const turb = env.turbidity != null ? env.turbidity : 2.6;
    U.uAerial.value = (0.5 + turb * 0.2) * 1.05e-5;

    /* FEATURE SIZE. The shape volume is what decides how big an individual
       puff is, and at a 4.2 km period every cloud in every shot came out the
       same ~1 km ball — the sky equivalent of scattering identical rocks at
       uniform density across a landscape. A 9 km period puts the fundamental
       lobe at 2.3 km with its octaves reaching down to 290 m, so one cloud is
       a mass with sub-lobes instead of a single ball. */
    /* 7400 -> 6100. With the march reaching 60 km instead of 17 the deck now
       has to supply a whole horizon band, and a 2.5 km fundamental lobe puts
       three or four puffs across the entire sky — the same "one feature size
       everywhere" failure the note above describes, just at the other extreme.
       6100 gives a 1.9 km fundamental with octaves down to 240 m, so the near
       field has mass and the far field has a size distribution. */
    D.uShapeScale.value = 1 / (6100 + (1 - type) * 3600 + tow * 5200);
    /* EROSION SCALE. At 1/2585 for a storm the finest erosion octave lands at
       ~108 m, which at the 3–10 km you view a cloud base from is 3–12 px — and
       a ray running for kilometres ALONG an overcast base then resolves that
       octave into long sinewy bright ribbons. storm_plains rendered as brushed
       metal. A convective mass wants coarse cauliflower, not lace. */
    D.uDetailScale.value = 1 / (1000 + type * 600 + tow * 3200);
    /* CELL SPACING, and more importantly MASS spacing: the density field reads
       this texture a second time at 0.28x to get a ~46 km field that drives the
       coverage threshold, which is what organises cells into clusters with open
       sky between them instead of dotting them evenly across the dome. */
    D.uWeatherScale.value = 1 / (7800 + tow * 15000 + (1 - type) * 5200);

    const wv = env.windVector;
    const wl = Math.hypot(wv.x, wv.z) || 1;
    D.uWindDir.value.set(wv.x / wl, wv.z / wl);

    /* ---- precipitation shafts ------------------------------------------ */
    const rain = clamp01(env.rainIntensity || 0);
    const snowFall = clamp01(env.snowIntensity || 0);
    U.uShaft.value = clamp01(Math.max(rain, snowFall * 0.75) * 1.1) * clamp01(cover * 1.4);
    U.uGroundY.value = this._groundY(cam.position.x, cam.position.z);

    /* ---- lightning ------------------------------------------------------ */
    const flash = env.lightningFlash || 0;
    U.uFlash.value = flash;
    const w = ctx.get('weather');
    if (w && w.lightningPosition) U.uFlashPos.value.copy(w.lightningPosition);
    let boltVis = 0;
    if (this._bolt.amp > 0) {
      const k = this._bolt.age / Math.max(this._bolt.life, 1e-3);
      // bright core for the first third, then a stuttering decay
      boltVis = this._bolt.amp * Math.exp(-k * 3.4)
        * (0.55 + 0.45 * Math.abs(Math.sin(this._bolt.age * 62.0)));
    }
    U.uBolt.value = boltVis;

    /* ---- 0. cloud shadow map -------------------------------------------- */
    const prevTarget = renderer.getRenderTarget();
    if (this._shadowDue()) {
      this._renderShadowMap(renderer, cam, coverEff, dens);
      this._shadowDone = true;
    } else {
      this._updateShadowStrength(coverEff, dens);
    }

    /* ---- 1. march ------------------------------------------------------- */
    this._passMesh.material = this.marchMat;
    renderer.setRenderTarget(this.rtRaw);
    renderer.render(this._passScene, this._passCam);

    /* ---- 2. temporal resolve -------------------------------------------- */
    const cur = this._pingpong;
    const prev = 1 - cur;
    const R = this.resolveMat.uniforms;
    R.uCur.value = this.rtRaw.texture;
    R.uHist.value = this.rtHist[prev].texture;
    R.uPrevViewProj.value.copy(this._prevVP);
    R.uHistValid.value = this._histValid;
    // a bolt is a one-frame event; do not let the history smear it into a haze
    R.uBlend.value = boltVis > 0.01 ? 0.45 : 0.92;
    this._passMesh.material = this.resolveMat;
    renderer.setRenderTarget(this.rtHist[cur]);
    renderer.render(this._passScene, this._passCam);

    renderer.setRenderTarget(prevTarget);

    /* ---- 3. hand the resolved buffer to the in-scene composite ---------- */
    const C = this.compMat.uniforms;
    C.uCloud.value = this.rtHist[cur].texture;

    const post = ctx.get('postfx');
    const postLive = !!(post && typeof post.render === 'function' && !post.__failed);
    C.uFallback.value = postLive ? 0 : 1;
    C.uOutGain.value = this.fallbackExposure;

    /* ---- 4. publish the ground response --------------------------------- */
    this._updateGroundFX(env, sky);

    /* ---- bookkeeping ---------------------------------------------------- */
    // derive the view matrix ourselves: cam.matrixWorldInverse is only
    // refreshed by whoever renders, which happens after this hook
    this._vp.copy(cam.matrixWorld).invert().premultiply(cam.projectionMatrix);
    this._prevVP.copy(this._vp);
    this._pingpong = prev;
    this._histValid = 1;
    this._frame++;
  }

  /**
   * Is the shadow map stale enough to be worth re-rendering this frame?
   *
   * The pass is normally amortised over two frames: the deck advects a few
   * centimetres per frame and the term is blurred over four taps anyway, so a
   * one-frame-old map is indistinguishable and the pass costs half as much.
   *
   * That stops being true at a low sun. The cloud that shades a given patch of
   * ground sits h/tan(elevation) metres downrange, and that distance moves by
   * h/sin²(elevation) per radian of sun travel — at a 3° sun it is ~18 m per
   * frame, so an every-other-frame map delivers a ~37 m jump and then nothing,
   * over and over. MEASURED at golden hour: mean transmittance over the whole
   * map moved 0.000 / 0.035 / 0.000 / 0.035 on alternate frames — a 30 Hz
   * staircase across the entire ground, which is what "a dark shadow flickering
   * on all the terrain" looks like. Freezing the clock collapsed it to 0.0001,
   * which is what identifies the sun rather than the camera as the driver.
   *
   * So the interval follows the measured sweep instead of a fixed count: every
   * frame while the sun is low enough to need it (a fraction of the day, and
   * the pass is ~1 % of the deck's cost), every second frame the rest of the
   * time. The staircase becomes a sweep, and a sweep is just motion.
   */
  _shadowDue() {
    if (!this._shadowDone) return true;
    const s = this.ctx.env.sunDirection;
    const p = this._prevSunDir;
    // chord ≈ angle for the tiny per-frame steps, and unlike acos(dot) it does
    // not lose all its precision as the dot product approaches 1
    const dAng = Math.hypot(s.x - p.x, s.y - p.y, s.z - p.z);
    p.copy(s);
    const sinE = Math.max(s.y, 0.03);
    // how far the sampled cloud column slides this frame, for a ~1 km base
    const sweep = 1000 * dAng / (sinE * sinE);
    const texel = (this.shadowExtent * 2) / this.shadowRes;
    return sweep > texel * 0.40 || (this._frame & 1) === 0;
  }

  /**
   * Top-down transmittance under the deck. Snapped to the texel grid so the
   * pattern does not crawl over the ground as the camera moves.
   */
  _renderShadowMap(renderer, cam, cover, dens) {
    const S = this.shadowMat.uniforms;
    /* SUN-ELEVATION-ADAPTIVE FOOTPRINT.
       A low sun throws a cloud's shadow kilometres downrange, so a 5.4 km map
       centred on the camera catches plenty — golden_hour_vista gets visible
       bands raking the plain. A sun overhead drops the shadow directly beneath
       the cloud that made it, so the map only ever sees cloud within its own
       half-extent, and at high noon there was frequently none: the plain came
       out uniformly lit, which is the flattest a landscape can look. Widening
       to 9.6 km when the sun is up costs nothing (same texel count, 50 m per
       texel instead of 28) and the term is blurred over four taps anyway. */
    const sunY = Math.max(0, this.ctx.env.sunDirection.y);
    this.shadowExtent = this._fitShadowExtent(sunY);
    const texel = (this.shadowExtent * 2) / this.shadowRes;
    const cx = Math.round(cam.position.x / texel) * texel;
    const cz = Math.round(cam.position.z / texel) * texel;
    this._shadowCentre.set(cx, cz);
    /* SUN-RAY ORIGIN PLANE. Every texel traces from this height, so it sets
       WHICH part of the deck lands on a given patch of ground: a 1 m change
       slides the whole pattern 1/tan(elevation) metres — 17 m at the 3.3° sun
       measured in golden_hour_vista, i.e. most of a texel per metre of terrain
       relief. Sampling it under the camera meant walking uphill dragged the
       shadows across the entire landscape — the "dark band that shifts". It is
       latched once per location instead (re-taken on teleport, where the frame
       is a cut anyway). The absolute value is arbitrary — it only offsets which
       cloud you are standing under — but it must be CONSTANT. */
    if (this._shadowRefY == null) {
      const w = this.ctx.world;
      if (w && w.ready) this._shadowRefY = this._groundY(cam.position.x, cam.position.z);
    }
    S.uShadowArea.value.set(cx, cz, this.shadowExtent, this._shadowRefY || 0);
    S.uShadowSoft.value = this.shadowSoftness;

    this._passMesh.material = this.shadowMat;
    renderer.setRenderTarget(this.shadowRT);
    renderer.render(this._passScene, this._passCam);

    const G = this.groundFXUniforms;
    G.rsCloudShadowArea.value.set(cx, cz, this.shadowExtent, 0);
    this._updateShadowStrength(cover, dens);
  }

  /**
   * Quantised, hysteresis-damped footprint — the same discipline the CSM
   * cascades use on their slab height, and for the same reason.
   *
   * The centre above is snapped to the map's own texel grid so the pattern does
   * not crawl. That snap is only worth anything if the grid SPACING holds
   * still: texel = 2*extent/res, so an extent recomputed continuously from the
   * sun's altitude gives a grid whose own spacing drifts, `Math.round` flips at
   * arbitrary moments, and the centre jumps a whole texel (28–50 m) while every
   * texel simultaneously resamples the deck at a new rate. That is a large dark
   * region shifting across the terrain frame to frame.
   *
   * So the wide-at-noon / tight-at-dusk behaviour is kept, but in five discrete
   * steps: grow immediately (never lose a shadow that just came into range),
   * shrink ONE step at a time and only after the smaller fit has been stable for
   * ~1.5 s of shadow renders. One step at a time matters — collapsing four steps
   * at once resamples the whole map in a single frame, which is the very pop
   * this is here to prevent. Between steps the extent is bit-identical frame to
   * frame, so the snap works and the map reads the same world points every time.
   */
  _fitShadowExtent(sunY) {
    const st = this._shadowFit;
    const want = Math.round(smooth01(sunY / 0.75) * SHADOW_EXTENT_STEPS);
    if (st.step < 0 || want > st.step) { st.step = want; st.hold = 0; }
    else if (want < st.step) { if (++st.hold > 48) { st.step--; st.hold = 0; } }
    else st.hold = 0;
    return 5400 + 4200 * (st.step / SHADOW_EXTENT_STEPS);
  }

  /** Fade the shadow term out when the sun is down or the deck is meaningless. */
  _updateShadowStrength(cover, dens) {
    const G = this.groundFXUniforms;
    const sunUp = clamp01((this.ctx.env.sunDirection.y - 0.02) / 0.16);
    const useful = clamp01(cover * 3.0) * (1 - clamp01((cover - 0.86) / 0.16) * 0.45);
    G.rsCloudShadowParams.value.x = this.shadowStrength * sunUp * useful
      * clamp01(0.35 + dens);
    G.rsCloudShadowParams.value.y = 1.6 / this.shadowRes;
  }

  /** Wet-surface response: sky radiance + key light for the specular terms. */
  _updateGroundFX(env, sky) {
    const G = this.groundFXUniforms;
    const wet = clamp01(env.wetness || 0);
    const pud = clamp01(env.puddleLevel != null ? env.puddleLevel : wet * 0.6);
    G.rsWetParams.value.set(wet, pud, clamp01(env.snowCover || 0), this.wetSheen);

    // sky radiance in two bands: what a puddle actually reflects
    if (sky && typeof sky.sampleSkyRadiance === 'function') {
      try {
        sky.sampleSkyRadiance(_up, G.rsWetSkyHi.value);
        sky.sampleSkyRadiance(_horiz, G.rsWetSkyLo.value);
      } catch (e) { /* sky not ready */ }
    } else {
      G.rsWetSkyHi.value.copy(env.ambientColor).multiplyScalar(env.ambientIntensity * 1.4);
      G.rsWetSkyLo.value.copy(env.fogColor).multiplyScalar(env.ambientIntensity * 1.1);
    }
    // the deck sits between a puddle and the blue sky the LUT knows about
    const deck = clamp01((env.cloudCover || 0) * (0.35 + 0.65 * (env.cloudDensity || 0)));
    const dim = 1 - deck * 0.55;
    G.rsWetSkyHi.value.multiplyScalar(dim);
    G.rsWetSkyLo.value.multiplyScalar(dim);
    const lf = env.lightningFlash || 0;
    if (lf > 0.001) {
      G.rsWetSkyHi.value.addScalar(lf * 2.2);
      G.rsWetSkyLo.value.addScalar(lf * 2.6);
    }

    // key light for the glint: sun by day, moon by night
    const sunUp = env.sunDirection.y > 0.02 && env.sunIntensity > 0.05;
    if (sunUp) {
      G.rsWetSunDir.value.copy(env.sunDirection).normalize();
      G.rsWetSunCol.value.copy(env.sunColor)
        .multiplyScalar(env.sunIntensity * (1 - clamp01(env.sunAttenuation || 0) * 0.85));
    } else {
      G.rsWetSunDir.value.copy(env.moonDirection).normalize();
      G.rsWetSunCol.value.copy(env.moonColor).multiplyScalar((env.moonIntensity || 0) * 1.4);
    }
  }

  /**
   * Horizon / aerial-perspective colour. Uses the Sky system's own scattering
   * integral when it exposes one, so distant clouds dissolve into exactly the
   * same haze the terrain does. Falls back to env.fogColor otherwise.
   */
  _resolveHaze(out, zenithOut) {
    const env = this.ctx.env;
    if (this._skyProbe === undefined) {
      const sky = this.ctx.get('sky');
      this._skyProbe = null;
      if (sky) {
        for (const name of ['sampleSkyRadiance', 'getAerialPerspective',
                            'getHorizonColor', 'sampleSky', 'getSkyColor']) {
          if (typeof sky[name] === 'function') { this._skyProbe = { sky, name }; break; }
        }
      }
    }
    if (this._skyProbe) {
      try {
        // just above the horizon, in the direction we are looking
        const dir = _tmpDir.copy(this._fwd);
        dir.y = 0.035;
        dir.normalize();
        const r = this._skyProbe.sky[this._skyProbe.name](dir, out);
        if (r && r.isColor) out.copy(r);
        const z = this._skyProbe.sky[this._skyProbe.name](_tmpUp.set(0, 1, 0), zenithOut);
        if (z && z.isColor) zenithOut.copy(z);
        if (out.r + out.g + out.b > 1e-6) {
          zenithOut.multiplyScalar(this.hazeGain);
          return out.multiplyScalar(this.hazeGain);
        }
      } catch (err) {
        this._skyProbe = null; // never let a foreign system take the frame down
      }
    }
    const day = env.daylight != null ? env.daylight : 1;
    out.copy(env.fogColor).multiplyScalar(this.hazeGain * (0.30 + day * 1.35) + 0.05);
    zenithOut.copy(out).multiplyScalar(0.32);
    return out;
  }

  /** The resolved half-res cloud buffer (rgb = scatter, a = coverage). */
  getCloudBuffer() { return this.rtHist ? this.rtHist[1 - this._pingpong].texture : null; }

  /** Top-down cloud transmittance map + the world square it covers. */
  getCloudShadowMap() {
    return this.shadowRT
      ? { texture: this.shadowRT.texture, area: this.groundFXUniforms.rsCloudShadowArea.value }
      : null;
  }

  dispose() {
    if (this._offTeleport) this._offTeleport();
    if (this.composite) this.ctx.scene.remove(this.composite);
    if (this._quadGeo) this._quadGeo.dispose();
    for (const m of [this.marchMat, this.shadowMat, this.resolveMat, this.compMat]) if (m) m.dispose();
    if (this.rtRaw) this.rtRaw.dispose();
    if (this.shadowRT) this.shadowRT.dispose();
    if (this.rtHist) { this.rtHist[0].dispose(); this.rtHist[1].dispose(); }
    if (this._noise) {
      this._noise.shapeRT.dispose();
      this._noise.detailRT.dispose();
      this._noise.weatherRT.dispose();
    }
  }
}

const _tmpCol = new THREE.Color();
const _tmpDir = new THREE.Vector3();
const _tmpUp = new THREE.Vector3(0, 1, 0);
const _up = new THREE.Vector3(0, 1, 0);
const _horiz = new THREE.Vector3(0.9, 0.16, 0).normalize();
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth01 = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
/** Shadow footprint interpolates 5400 m → 9600 m in this many discrete steps. */
const SHADOW_EXTENT_STEPS = 4;

function halton(index, base) {
  let f = 1, r = 0, i = index;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}
