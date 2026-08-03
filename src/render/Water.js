import * as THREE from 'three';
import { WORLD } from '../core/Config.js';
import { solveHydrology } from './water/Hydro.js';
import { buildWaterTiles } from './water/WaterMesh.js';
import { makeWaterMaterial } from './water/WaterMaterial.js';
import { makeRippleNormals, makeFoamNoise, makeCaustics } from './water/Textures.js';
import { attachShore } from './water/Shore.js';

/**
 * RED SANDS — Water
 * ============================================================================
 * Rivers and lakes that come out of the terrain's own hydrology, not out of a
 * global sea level.
 *
 *   Terrain.getFlowMap()        upstream catchment area per cell
 *   Terrain.getHeightfield()    the eroded, channel-incised bed
 *        ↓  solveHydrology()
 *   a water-surface field: lakes filled to their basin spill elevation, rivers
 *   given a stage that grows downstream and deepens into pools where the
 *   gradient collapses, the whole thing monotone downhill and relaxed along the
 *   network so a reach reads as one sheet.
 *        ↓
 *   depth(x,z) = surface - bed, baked at the heightfield resolution and shared
 *   with (a) the water shader, for the feathered shoreline, Beer-Lambert
 *   absorption, foam and caustics, and (b) the terrain shader, for the wet-sand
 *   band at the margin.
 *
 * The surface itself is a tiled, frustum-culled mesh tessellated only where
 * there is water. Nothing is stamped at `world.waterLevel`; the only thing that
 * level does here is flood genuinely sub-level ground, which is what turns the
 * white SSR cut-outs pass 1 left on the sand in high_noon_desert into actual
 * shallow playa water with a soft edge.
 *
 * PUBLIC API
 *   water.surfaceHeightAt(x, z)   → water surface Y, or null if dry
 *   water.depthAt(x, z)           → metres of water (<= 0 when dry)
 *   water.isWater(x, z)
 *   water.splash(position, strength)
 *   water.stats()                 → { tiles, tris, drawCalls }
 * ============================================================================
 */

const WATER_ORDER = 24;      // opaque, but after terrain/vegetation/props
const GRAB_ORDER = 23;

/** IEEE-754 float32 → float16 bit pattern. */
const _f32 = new Float32Array(1);
const _i32 = new Int32Array(_f32.buffer);
function toHalf(v) {
  _f32[0] = v;
  const x = _i32[0];
  const sign = (x >> 16) & 0x8000;
  let exp = ((x >> 23) & 0xff) - 127 + 15;
  let man = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    man = (man | 0x800000) >> (1 - exp);
    return sign | (man >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (man >> 13);
}

function halfTexture(src, res, format) {
  const half = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) half[i] = toHalf(src[i]);
  const t = new THREE.DataTexture(half, res, res, format || THREE.RedFormat, THREE.HalfFloatType);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}


export class Water {
  static id = 'water';

  constructor(ctx) {
    this.ctx = ctx;
    this.group = null;
    this.tiles = [];
    this.enabled = true;

    /** Art-direction knobs, safe to poke at runtime. */
    this.tuning = {
      /** Per-metre extinction of the water body, linear RGB. Silty western river:
       *  green survives longest, red dies first, blue is eaten by the sediment.
       *  Tuned so the bed is clearly readable to ~1 m, tints hard by 2-3 m and is
       *  gone by 6 — i.e. the shallow-to-deep ramp actually happens inside the
       *  depth range a river bend puts on screen. */
      absorb: new THREE.Vector3(1.28, 0.86, 1.72),
      /** Scattering albedo of the body — what deep water glows with. Kept low so
       *  deeps go dark rather than turning into a swimming pool. */
      scatter: new THREE.Vector3(0.094, 0.116, 0.086),
      refraction: 0.115,
      foam: 1.0,
      caustics: 1.0,
      specular: 1.0,
      /* Swell amplitude in metres. A 40 m reach has no fetch: what it carries is
         centimetres of chop, and every centimetre of it shears the reflection.
         Keep it small — a calm surface that mirrors the far bank reads as water
         far more strongly than a choppy one that mirrors nothing. */
      waveAmplitude: 0.155,
      choppiness: 0.55,
      shoreBand: 3.4,
      /** Multiplier on the summed detail-normal slope (1 = the authored slopes). */
      ripple: 1.0,
      /** How much of the reflection may come from the marched + reprojected bank. */
      reflectGround: 0.95,
    };

    this._frustum = new THREE.Frustum();
    this._pv = new THREE.Matrix4();
    this._sphere = new THREE.Sphere();
    this._anyVisible = false;
    this._grabOk = true;
    this._grabProbe = true;
    this._grabSize = new THREE.Vector2(0, 0);
    this._tmpSize = new THREE.Vector2();
    this._prevPlayerAbove = true;
    this._splashCooldown = 0;
    this._drawCalls = 0;
    this._vecA = new THREE.Vector3();
  }

  /* ================================================================== init */

  async init() {
    const ctx = this.ctx;
    const T = ctx.get('terrain');
    if (!T || typeof T.getHeightfield !== 'function' || typeof T.getFlowMap !== 'function') {
      console.warn('[water] terrain hydrology unavailable — water disabled');
      this.enabled = false;
      return;
    }

    const t0 = performance.now();
    const hf = T.getHeightfield();
    const fm = T.getFlowMap();
    this.res = hf.res;
    this.size = hf.size;
    this.half = hf.size * 0.5;
    this.cell = hf.size / hf.res;

    /* ------------------------------------------------------ 1. hydrology */
    const hyd = solveHydrology({
      H: hf.data, res: hf.res, size: hf.size,
      flow: fm.data, flowRes: fm.res,
      waterLevel: ctx.world.waterLevel != null ? ctx.world.waterLevel : WORLD.waterLevel,
      sim: 1024,
      keepDry: T.townSite ? { x: T.townSite.x, z: T.townSite.z, radius: 200 } : null,
    });
    this.hyd = hyd;
    this._depth = hyd.depth;
    this._surf = hyd.surfHi;
    const tHyd = performance.now();
    await this._yield();

    /* -------------------------------------------------------- 2. textures */
    this.depthTex = halfTexture(hyd.depth, hf.res, THREE.RedFormat);

    this.flowTex = new THREE.DataTexture(hyd.flowRGBA, hyd.flowRes, hyd.flowRes, THREE.RGBAFormat);
    this.flowTex.colorSpace = THREE.NoColorSpace;
    this.flowTex.wrapS = this.flowTex.wrapT = THREE.ClampToEdgeWrapping;
    this.flowTex.minFilter = THREE.LinearFilter;
    this.flowTex.magFilter = THREE.LinearFilter;
    this.flowTex.generateMipmaps = false;
    this.flowTex.needsUpdate = true;


    const seed = (ctx.seed ^ 0x7a7e2b13) >>> 0;
    const aniso = Math.min(ctx.quality.anisotropy || 8, ctx.caps ? ctx.caps.aniso : 8);
    this.rippleTex = makeRippleNormals(seed, 512, aniso, { strength: 2.2, trains: 6, trainGain: 0.22, octaves: 6, base: 3 });
    this.foamTex = makeFoamNoise(seed ^ 0x1234567, 256);
    this.causticTex = makeCaustics(seed ^ 0x9abcdef, 256);
    const tTex = performance.now();
    await this._yield();

    /* ------------------------------------------------------------ 3. mesh */
    const q = ctx.quality;
    const stride = q.waterQuality >= 2 ? 1 : (q.waterQuality >= 1 ? 2 : 3);
    /* 256-quad tiles rather than 128. The water is a thin, branching mask, so
       the tiles are mostly empty anyway and the coarser frustum granularity
       costs almost nothing — but it halves the draw calls the surface spends
       (77 -> 33 at river_bend), which the frame budget notices. */
    const built = buildWaterTiles({
      depth: hyd.depth, surf: hyd.surfHi, res: hf.res, size: hf.size,
      tile: 256, stride, threshold: 0.03,
    });
    this._built = built;

    /* -------------------------------------------------------- 4. material */
    const sky = ctx.get('sky');
    const lighting = ctx.get('lighting');
    let shadowChunk = null, shadowUniforms = null;
    try {
      if (lighting && typeof lighting.shadowChunk === 'function') {
        const u = lighting.shadowUniforms();
        if (u && u.rsCsmShadowMap) { shadowChunk = lighting.shadowChunk(); shadowUniforms = u; }
      }
    } catch (e) { shadowChunk = null; shadowUniforms = null; }

    if (!sky) {
      console.warn('[water] sky unavailable — water disabled (aerial perspective is mandatory)');
      this.enabled = false;
      return;
    }

    this.material = makeWaterMaterial({
      aerialUniforms: sky.aerialUniforms,
      aerialGLSL: sky.aerialGLSL,
      shadowChunk, shadowUniforms,
    });
    const u = this.material.uniforms;
    u.uDepthTex.value = this.depthTex;
    u.uFlowTex.value = this.flowTex;
    u.uRipple.value = this.rippleTex;
    u.uFoamTex.value = this.foamTex;
    u.uCausticTex.value = this.causticTex;
    u.uWorld.value.set(this.half, hf.res, 1 / hf.res, 0);
    u.uRippleNorm.value = 1 / Math.max(1e-3, this.rippleTex.userData.slopeRms || 0.12);

    /* ------------------------------------------------------------ 5. scene */
    this.group = new THREE.Group();
    this.group.name = 'water';
    this.group.matrixAutoUpdate = false;
    ctx.scene.add(this.group);

    for (const t of built.tiles) {
      const m = new THREE.Mesh(t.geometry, this.material);
      m.matrixAutoUpdate = false;
      m.frustumCulled = true;
      m.castShadow = false;
      m.receiveShadow = false;
      m.renderOrder = WATER_ORDER;
      m.name = 'waterTile';
      m.userData.rsNoAerial = true;
      this.group.add(m);
      this.tiles.push({ mesh: m, cx: t.cx, cy: t.cy, cz: t.cz, radius: t.radius });
    }

    this._buildGrabber();

    /* --------------------------- 6. hand the depth field back to the ground */
    this.shoreUniforms = {
      rsShoreDepth: { value: this.depthTex },
      rsShoreInfo: { value: new THREE.Vector4(this.half, this.tuning.shoreBand, 1, 1) },
    };
    this.shoreAttached = false;
    try { this.shoreAttached = !!attachShore(T, this.shoreUniforms); } catch (e) {
      console.warn('[water] shore injection skipped:', e && e.message);
    }
    if (!this.shoreAttached) {
      console.warn('[water] terrain wet-margin band NOT attached — the waterline '
        + 'will have no wet darkening on the bank');
    }

    /* --------------------------------------------------------- 7. viewpoint */
    this._registerPOIs(T);

    if (import.meta.env && import.meta.env.DEV) {
      console.log('[water] %dms  hydro %d  tex %d | tiles %d  tris %d  wet %s%% maxDepth %sm',
        (performance.now() - t0) | 0, (tHyd - t0) | 0, (tTex - tHyd) | 0,
        built.tiles.length, built.tris | 0,
        (hyd.wetFraction * 100).toFixed(2), hyd.maxDepth.toFixed(1));
    }
  }

  _yield() { return new Promise((r) => setTimeout(r, 0)); }

  /* ------------------------------------------------------- refraction grab */

  /**
   * The opaque colour buffer, grabbed with a framebuffer blit immediately
   * before the first water tile draws. PostFX renders the whole scene into one
   * HDR target, so this is the only way to get the un-refracted image without
   * paying for a second scene pass — and a second pass would double the frame's
   * draw-call count, which the budget will not take.
   */
  _buildGrabber() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    const m = new THREE.MeshBasicMaterial({
      colorWrite: false, depthWrite: false, depthTest: false,
    });
    m.userData.rsNoAerial = true;
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = GRAB_ORDER;
    mesh.matrixAutoUpdate = false;
    mesh.name = 'waterGrab';
    mesh.onBeforeRender = (renderer) => this._grab(renderer);
    this.group.add(mesh);
    this._grabber = mesh;
    this._grabMat = m;
    this._grabGeo = g;
  }

  _ensureGrabTexture() {
    const r = this.ctx.renderer;
    const s = r.getDrawingBufferSize(this._tmpSize);
    const w = Math.max(2, s.x | 0), h = Math.max(2, s.y | 0);
    if (this._grabTex && this._grabSize.x === w && this._grabSize.y === h) return;
    if (this._grabTex) this._grabTex.dispose();
    const t = new THREE.FramebufferTexture(w, h);
    t.format = THREE.RGBAFormat;
    t.type = THREE.HalfFloatType;
    t.colorSpace = THREE.NoColorSpace;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    this._grabTex = t;
    this._grabSize.set(w, h);
    if (this.material) {
      this.material.uniforms.uGrab.value = t;
      this.material.uniforms.uGrabTexel.value.set(1 / w, 1 / h);
    }
    this._grabProbe = true;
  }

  _grab(renderer) {
    if (!this._grabOk || !this._grabTex || !this.material) return;
    const gl = renderer.getContext();
    try {
      if (this._grabProbe) { let n = 0; while (gl.getError() !== gl.NO_ERROR && n++ < 8) { /* drain */ } }
      renderer.copyFramebufferToTexture(this._grabTex);
      if (this._grabProbe) {
        this._grabProbe = false;
        if (gl.getError() !== gl.NO_ERROR) {
          this._grabOk = false;
          this.material.uniforms.uUseGrab.value = 0;
        } else {
          this.material.uniforms.uUseGrab.value = 1;
        }
      }
    } catch (e) {
      this._grabOk = false;
      this.material.uniforms.uUseGrab.value = 0;
    }
  }

  /* ------------------------------------------------------------ sampling */

  _bilerp(data, x, z) {
    const R = this.res, inv = R / this.size, half = this.half;
    let fx = (x + half) * inv - 0.5;
    let fz = (z + half) * inv - 0.5;
    if (fx < 0) fx = 0; else if (fx > R - 1.001) fx = R - 1.001;
    if (fz < 0) fz = 0; else if (fz > R - 1.001) fz = R - 1.001;
    const x0 = fx | 0, z0 = fz | 0;
    const tx = fx - x0, tz = fz - z0;
    const r0 = z0 * R + x0, r1 = r0 + R;
    const a = data[r0], b = data[r0 + 1], c = data[r1], d = data[r1 + 1];
    const t0 = a + (b - a) * tx;
    return t0 + ((c + (d - c) * tx) - t0) * tz;
  }

  /** Metres of water at (x,z). <= 0 means dry ground. */
  depthAt(x, z) {
    if (!this._depth) return -1;
    return this._bilerp(this._depth, x, z);
  }

  /** Water surface height at (x,z), or null when there is no water there. */
  surfaceHeightAt(x, z) {
    if (!this._surf) return null;
    if (this._bilerp(this._depth, x, z) <= 0) return null;
    return this._bilerp(this._surf, x, z);
  }

  isWater(x, z) { return this.depthAt(x, z) > 0.02; }

  /**
   * Ask the particle system for a splash, if it exists. Degrades silently.
   * @param {THREE.Vector3} position
   * @param {number} strength 0..1
   */
  splash(position, strength = 1) {
    const PT = this.ctx.get('particles');
    if (!PT) return false;
    const y = this.surfaceHeightAt(position.x, position.z);
    const p = this._vecA.set(position.x, y != null ? y : position.y, position.z);
    try {
      if (typeof PT.burst === 'function') {
        PT.burst('splash', p, Math.round(8 + 26 * strength), { speed: 1.6 + 3 * strength });
        return true;
      }
    } catch (e) { /* particle system is a stub or unhappy — never fatal */ }
    return false;
  }

  stats() {
    return {
      tiles: this.tiles.length,
      tris: this._built ? this._built.tris : 0,
      drawCalls: this._drawCalls,
      wetFraction: this.hyd ? this.hyd.wetFraction : 0,
    };
  }

  /* ---------------------------------------------------------------- frame */

  update(dt) {
    if (!this.enabled || !this.material) return;
    const ctx = this.ctx;
    const env = ctx.env;
    const u = this.material.uniforms;
    const T = this.tuning;

    u.uTime.value = ctx.time.elapsed;
    u.uCamPosW.value.copy(ctx.camera.position);

    /* key light: whichever body is actually lighting the scene */
    const atten = 1 - Math.min(1, Math.max(0, env.sunAttenuation || 0));
    const sunI = Math.max(0, env.sunIntensity) * atten;
    const moonI = Math.max(0, env.moonIntensity);
    if (sunI >= moonI) {
      u.uSunDirW.value.copy(env.sunDirection);
      u.uSunRad.value.set(env.sunColor.r, env.sunColor.g, env.sunColor.b).multiplyScalar(sunI);
    } else {
      u.uSunDirW.value.copy(env.moonDirection);
      u.uSunRad.value.set(env.moonColor.r, env.moonColor.g, env.moonColor.b).multiplyScalar(moonI);
    }
    const amb = Math.max(0, env.ambientIntensity);
    u.uAmbient.value.set(env.ambientColor.r, env.ambientColor.g, env.ambientColor.b)
      .multiplyScalar(amb);

    /* wind → chop. Rain roughens the surface and kills the mirror. */
    const wind = env.windVector;
    const ws = Math.max(0.15, env.windStrength || 0);
    const gust = 1 + 0.35 * (env.windGust || 0);
    const rain = Math.min(1, env.rainIntensity || 0);
    const wx = wind ? wind.x : 1, wz = wind ? wind.z : 0;
    const wl = Math.hypot(wx, wz) || 1;
    u.uWave.value.set(
      Math.min(0.85, T.waveAmplitude * (0.35 + 0.14 * ws) * gust * (1 + rain * 0.8)),
      T.choppiness,
      wx / wl, wz / wl,
    );
    u.uWindSpeed.value = ws * gust * (1 + rain * 0.9);

    /* Angular size of one drawbuffer pixel, in radians. The shader multiplies it
       by distance to get the world footprint of a pixel and retires every wave
       band it cannot resolve — the whole reason distant water stops being a
       shimmering field of constant-frequency streaks. */
    const rt = ctx.renderer.getDrawingBufferSize(this._tmpSize);
    const pxAngle = 2 * Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov || 50) * 0.5)
                    / Math.max(1, rt.y);
    u.uSurfTune.value.set(T.ripple, T.reflectGround, pxAngle, 0.0);
    u.uAbsorb.value.copy(T.absorb);
    u.uScatter.value.copy(T.scatter);
    u.uTune.value.set(
      T.refraction,
      T.foam * (1 + rain * 0.35),
      T.caustics,
      T.specular * (1 - rain * 0.35),
    );

    if (this.shoreUniforms) {
      this.shoreUniforms.rsShoreInfo.value.set(
        this.half, T.shoreBand, 1,
        Math.min(1.25, 1 + (env.rainIntensity || 0) * 0.2),
      );
    }

    /* ------------------------------------------------------ submersion */
    const cam = ctx.camera.position;
    const camDepth = this.depthAt(cam.x, cam.z);
    let submerged = false;
    if (camDepth > 0) {
      const s = this._bilerp(this._surf, cam.x, cam.z);
      submerged = cam.y < s - 0.30;
    }
    env.cameraSubmerged = submerged;

    /* ---------------------------------------------- entry splash (opt-in) */
    this._splashCooldown = Math.max(0, this._splashCooldown - dt);
    const p = ctx.player.position;
    if (p) {
      const pd = this.depthAt(p.x, p.z);
      const above = pd <= 0 ? true : p.y > this._bilerp(this._surf, p.x, p.z);
      if (this._prevPlayerAbove && !above && pd > 0.25 && this._splashCooldown <= 0) {
        this._splashCooldown = 0.35;
        this.splash(p, Math.min(1, Math.abs(ctx.player.velocity ? ctx.player.velocity.y : 2) / 6));
      }
      this._prevPlayerAbove = above;
    }
  }

  lateUpdate() {
    if (!this.enabled || !this.group) return;
    this._ensureGrabTexture();

    const cam = this.ctx.camera;
    cam.updateMatrixWorld();
    this._pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._pv);

    let visible = 0;
    for (const t of this.tiles) {
      this._sphere.center.set(t.cx, t.cy, t.cz);
      this._sphere.radius = t.radius;
      if (this._frustum.intersectsSphere(this._sphere)) visible++;
    }
    this._anyVisible = visible > 0;
    this._drawCalls = visible + (this._anyVisible ? 1 : 0);
    // No water on screen → skip the framebuffer blit entirely.
    if (this._grabber) this._grabber.visible = this._anyVisible;
  }

  /* ----------------------------------------------------------------- POIs */

  /**
   * Re-register the river viewpoint against the water that actually exists.
   * Terrain registers a provisional one from its traced polylines before the
   * surface is solved; this replaces it with a framing that puts a wide reach
   * across the lower third, seen from the outside of a bend, high enough on the
   * bank that the far side is not hidden behind the near one.
   */
  _registerPOIs(T) {
    const ctx = this.ctx;
    const best = this._pickRiverView(T);
    if (!best) return;
    ctx.poi.set('river', { pos: best.cam, look: best.look });
    ctx.poi.set('river_down', { pos: best.look, look: best.look });
  }

  /**
   * One bank of the channel, measured along the cross-stream axis.
   *   w       half-width of the water on this side
   *   lip     the LOWEST ground within a few metres of the waterline — how close
   *           to the surface a camera standing here can get
   *   relief  how high the ground gets 20-240 m back, i.e. how much there is on
   *           this side for the opposite bank's water to reflect
   */
  _bankProfile(x, z, sx, sz, waterY, sgn) {
    const gh = this.ctx.world.getHeight;
    let w = 0;
    for (let r = 2; r <= 160; r += 2) {
      if (this.depthAt(x + sx * sgn * r, z + sz * sgn * r) <= 0.02) break;
      w = r;
    }
    let lip = 1e9;
    for (let r = w + 2; r <= w + 16; r += 2) {
      const h = gh(x + sx * sgn * r, z + sz * sgn * r) - waterY;
      if (h > 0.1 && h < lip) lip = h;
    }
    if (!Number.isFinite(lip)) lip = 0.4;
    let relief = -1e9;
    for (let r = w + 20; r <= w + 240; r += 12) {
      relief = Math.max(relief, gh(x + sx * sgn * r, z + sz * sgn * r) - waterY);
    }
    return { w, lip, relief: Math.max(relief, 0) };
  }

  /**
   * Choose and frame the river viewpoint.
   *
   * The pass-2 framing stood eleven metres up a bluff and looked down the
   * valley: the river came out as a narrow ribbon in the left third, every
   * pixel of it at a five-degree grazing angle, and the reflected ray cleared
   * the far bank entirely — so the surface could only ever return sky, with no
   * Fresnel gradient because every pixel was at the same angle and no bed
   * because the slant path through the water was twenty metres everywhere.
   *
   * This one stands ON the bank, eye height above the water, and looks across
   * and downstream. That single change delivers most of what the water shader
   * is for, for free:
   *   • the water plane's vanishing line lands just above frame centre, so the
   *     surface fills the lower half of the frame,
   *   • the incidence angle sweeps from ~25 deg at the bottom of frame to ~1 deg
   *     at the far bank, which IS the Fresnel gradient, visible in one image,
   *   • near water is steep enough to see the bed through it,
   *   • the reflected ray now hits the far bank and the range behind it.
   */
  _pickRiverView(T) {
    const ctx = this.ctx;
    const gh = ctx.world.getHeight;
    const rivers = (T && typeof T.getRivers === 'function') ? T.getRivers() : null;
    if (!rivers || !rivers.length) return null;

    let best = null;
    for (const river of rivers) {
      const N = river.length;
      if (N < 14) continue;
      const lo = Math.max(3, Math.floor(N * 0.18));
      const hi = Math.max(lo + 1, N - 5);
      for (let i = lo; i < hi; i++) {
        const p = river[i];
        /* stay well inside the authored core: the outer ring is the coarse
           backdrop heightfield and sits behind kilometres of haze */
        if (Math.max(Math.abs(p.x), Math.abs(p.z)) > 2900) continue;
        const d = this.depthAt(p.x, p.z);
        if (d < 0.7) continue;
        const waterY = this._bilerp(this._surf, p.x, p.z);

        const a0 = river[Math.max(0, i - 4)], a1 = river[Math.min(N - 1, i + 4)];
        const dx0 = p.x - a0.x, dz0 = p.z - a0.z;
        const dx1 = a1.x - p.x, dz1 = a1.z - p.z;
        const l0 = Math.hypot(dx0, dz0) || 1, l1 = Math.hypot(dx1, dz1) || 1;
        const fx = (dx0 / l0 + dx1 / l1), fz = (dz0 / l0 + dz1 / l1);
        const fl = Math.hypot(fx, fz) || 1;
        const sx = -fz / fl, sz = fx / fl;

        const A = this._bankProfile(p.x, p.z, sx, sz, waterY, 1);
        const B = this._bankProfile(p.x, p.z, sx, sz, waterY, -1);
        const width = A.w + B.w;
        if (width < 16 || width > 110) continue;    // puddle, or the edge of a lake

        /* Which side to stand on: we want a LOW near lip (so the camera can sit
           just above the surface) and a HIGH far bank (so there is something in
           the reflection). */
        const sA = Math.min(B.relief, 45) - A.lip * 3.0;
        const sB = Math.min(A.relief, 45) - B.lip * 3.0;
        const sgn = sA >= sB ? 1 : -1;
        const near = sgn > 0 ? A : B;
        const far = sgn > 0 ? B : A;
        if (near.lip > 3.2) continue;               // cannot get down to the water
        if (far.relief < 2.0) continue;             // nothing across it to reflect

        /* How far in from the near waterline before the water is knee deep.
           A sixty-metre shelf under twenty centimetres reads as a flooded field,
           not a river: the bed shows through the whole lower half of the frame
           and the Beer-Lambert ramp never gets to do anything. Want the channel
           to drop away within a few metres of where the camera stands. */
        let shelf = 999;
        for (let r = near.w; r > -far.w; r -= 1.5) {
          if (this.depthAt(p.x + sx * sgn * r, p.z + sz * sgn * r) >= 0.85) {
            shelf = near.w - r; break;
          }
        }
        if (shelf > 26) continue;

        /* the reach downstream has to stay a river too, or the shot ends in a lake */
        let ok = true;
        for (let k = 4; k <= 18; k += 7) {
          const q = river[Math.min(N - 1, i + k)];
          if (this.depthAt(q.x, q.z) <= 0.06) { ok = false; break; }
        }
        if (!ok) continue;

        const turn = 1 - (dx0 * dx1 + dz0 * dz1) / (l0 * l1);
        const ww = (width - 38) / 26;
        const wScore = Math.exp(-(ww * ww)) * 42;
        const reliefScore = Math.min(far.relief, 40) * 1.9;
        const lipScore = (3.2 - near.lip) * 7.0;
        const flowScore = Math.min(3.2, Math.max(0, Math.log(Math.max(p.area, 1) / 1.2e5))) * 10;
        const shelfScore = (26 - shelf) * 1.5;
        const score = wScore + reliefScore + lipScore + flowScore + shelfScore
                    + Math.min(d, 3.5) * 9 + turn * 30;
        if (!best || score > best.score) {
          best = { score, river, i, p, fx: fx / fl, fz: fz / fl, sx, sz, sgn, near, far, width, waterY, shelf };
        }
      }
    }
    if (!best) return null;

    const { p, fx, fz, sgn, near, width, waterY } = best;
    const sx = best.sx * sgn, sz = best.sz * sgn;      // outward, toward our bank
    const ax = -sx, az = -sz;                          // across, toward the far bank

    /* Walk out of the channel and stand on the lowest dry ground we can find
       within a few metres of the waterline. */
    let bx = p.x + sx * (near.w + 4), bz = p.z + sz * (near.w + 4);
    let bh = gh(bx, bz);
    for (let r = near.w + 2; r <= near.w + 17; r += 1.5) {
      const tx = p.x + sx * r, tz = p.z + sz * r;
      if (this.depthAt(tx, tz) > -0.05) continue;
      const h = gh(tx, tz);
      if (h < bh) { bh = h; bx = tx; bz = tz; }
    }
    /* drop back a little upstream so the bend opens away from the camera */
    bx -= fx * 7; bz -= fz * 7;
    bh = Math.max(gh(bx, bz), waterY + 0.1);

    /* Eye height on the bank, but never more than ~4.5 m over the surface: the
       whole point is a low, grazing, reflective read of the water. */
    const camY = Math.min(Math.max(bh + 1.72, waterY + 1.85), Math.max(bh + 1.72, waterY + 4.6));

    /* Look across and downstream — about 36 degrees off the channel axis — with
       the aim point ON the surface, so the camera pitches down barely a degree
       and the water's vanishing line sits just above frame centre. */
    let lx = fx * 1.35 + ax * 1.0;
    let lz = fz * 1.35 + az * 1.0;
    const ll = Math.hypot(lx, lz) || 1;
    lx /= ll; lz /= ll;
    const reach = Math.min(140, Math.max(58, width * 2.3));

    return {
      cam: new THREE.Vector3(bx, camY, bz),
      look: new THREE.Vector3(bx + lx * reach, waterY, bz + lz * reach),
      bank: new THREE.Vector3(bx, camY, bz),
    };
  }

  /* -------------------------------------------------------------- teardown */

  resize() { /* the grab target follows the drawing buffer in lateUpdate */ }

  dispose() {
    const ctx = this.ctx;
    if (this.group) ctx.scene.remove(this.group);
    for (const t of this.tiles) t.mesh.geometry.dispose();
    if (this._grabGeo) this._grabGeo.dispose();
    if (this._grabMat) this._grabMat.dispose();
    if (this.material) this.material.dispose();
    for (const t of [this.depthTex, this.flowTex, this.rippleTex,
      this.foamTex, this.causticTex, this._grabTex]) if (t) t.dispose();
    this.tiles.length = 0;
  }
}
