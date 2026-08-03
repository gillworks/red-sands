import * as THREE from 'three';
import { SHADOW_LAYER, csmShaderChunk, patchLightsChunk, patchMaterial } from './ShadowShader.js';
import { PROFILE, prof } from '../Profiler.js';

const _center = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _lightPos = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _rotInv = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _upAlt = new THREE.Vector3(0, 0, 1);
const _zero = new THREE.Vector3();
const _camUp = new THREE.Vector3();

/** Snap to 2^(n/3) so a drifting probe cannot jitter the split planes. */
function quantise(v) {
  return Math.pow(2, Math.round(Math.log2(Math.max(v, 1e-3)) * 3) / 3);
}

/**
 * Stabilised cascaded shadow maps rendered into a single depth atlas.
 *
 * - Each cascade is fitted to the *bounding sphere* of its view-frustum slice,
 *   which makes the extent invariant to camera rotation, and the light-space
 *   origin is snapped to whole texels, which makes it invariant to camera
 *   translation. Together those two things are what stop shadows swimming.
 * - The atlas is a single RGBA-packed depth texture, compared manually in the
 *   shader (see ShadowShader for why one sampler and not two). Both the PCSS
 *   blocker search and the filter taps read it, so contact hardening costs no
 *   second render and no second texture unit.
 */
export class CascadedShadowMaps {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    const q = ctx.quality;

    this.count = Math.max(1, Math.min(4, opts.cascades ?? q.shadowCascades ?? 3));
    // Keep the atlas at or below 4096 on a side; that is plenty (2048 per
    // cascade at ultra => 24 mm per texel in cascade 0) and keeps VRAM sane.
    this.cols = this.count > 2 ? 2 : this.count;
    this.rows = Math.ceil(this.count / this.cols);
    const maxTile = Math.floor(4096 / Math.max(this.cols, this.rows));
    this.tile = Math.min(opts.tileSize ?? q.shadowMapSize ?? 2048, maxTile);

    /**
     * `q.shadowDistance` is the *ground-level* range. The cascade set is fitted
     * to the slab of the view frustum that actually contains ground (see
     * `_probeGround`), so a clifftop vista where the nearest terrain is 100 m
     * away and the subject is 2 km away gets a range to match instead of
     * spending three of four cascades on empty air — which is exactly what
     * pass 1 did, leaving one 780 m-radius blur as the only populated cascade.
     */
    this.distance = opts.distance ?? q.shadowDistance ?? 400;
    this.maxDistance = opts.maxDistance ?? this.distance * (this.count >= 4 ? 3.6 : 2.0);
    this.near = 0.4;
    /*
     * Almost fully logarithmic. A cascade's texel subtends a roughly constant
     * angle under a log split, which is the only distribution that spends the
     * atlas where the eye can resolve an edge. Pass 1 ran 0.62, which is the
     * usual "practical split" compromise and put 0.24 m texels on the nearest
     * ground in the vista — two texels of mush on every shadow edge in frame.
     */
    this.lambda = 0.88;
    this.soft = opts.soft ?? q.softShadows ?? true;

    const heavy = this.tile >= 2048;
    /*
     * Tap counts came down in pass 3 (12/24/8 -> 8/16/6). The anisotropic fit
     * below buys 3-5x finer texels at a low sun, and a finer map needs FEWER
     * taps to look smooth, not more — the pass-2 filter was spending its budget
     * blurring away detail it did not have. Worst case per pixel is now
     * 8 + 16 = 24 point fetches (or 8 + 6*4 + 4*4 = 48 in the tight branch,
     * which only fires where the penumbra is under two texels).
     */
    this.blockerTaps = this.soft ? (heavy ? 8 : 6) : 4;
    this.pcfTaps = this.soft ? (heavy ? 16 : 12) : 4;
    // Bilinear taps cost four fetches each, so there are fewer of them; they
    // are only used where the penumbra is under ~2 texels wide.
    this.nearTaps = this.soft ? (heavy ? 6 : 5) : 4;

    /**
     * tan of the source's angular RADIUS. The sun's disc is 0.53 degrees
     * across, so tan(0.265 deg) = 4.63e-3 of penumbra per metre of separation.
     * Overcast skies replace the disc with the whole dome and Lighting scales
     * this up accordingly.
     */
    this.lightAngularTan = 0.00463;
    this.strength = 1.0;

    /** Live split range, recomputed each frame from the ground probe. */
    this._near = this.near;
    this._far = this.distance;
    this._probe = null;

    this.lightDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();

    /**
     * Height a caster may stand above the terrain and still be fitted into the
     * cascade's light-space Y band. 55 m clears every tree, building and mesa
     * lip in the world; the band is padded further with `radius * 0.16` so a
     * ridge between two heightfield probes cannot be clipped out.
     */
    this.casterHeadroom = 26;
    /** Floor on halfY/radius, so a pathological fit cannot collapse the box. */
    this.minAniso = 0.05;

    this.splitNear = new Array(this.count).fill(0);
    this.splitFar = new Array(this.count).fill(0);
    this.cameras = [];
    this.casters = [];
    this._slab = [];
    this._cache = [];
    /** World -> cascade clip, per cascade. Valid until the cascade is refitted. */
    this._lightVP = [];
    this._hasFit = [];
    for (let i = 0; i < this.count; i++) {
      this._slab.push({ v: -1, hold: 0, mid: 0 });
      this._cache.push({ m: new Float64Array(16), n: -1, stamp: 0 });
      this._lightVP.push(new THREE.Matrix4());
      this._hasFit.push(false);
    }
    this._depthCache = new Map();
    this._materialHooks = [];
    this._dirty = true;
    this._forceFrames = 4;
    this._prevClear = new THREE.Color();

    const mats = [];
    const tiles = [];
    const ranges = [];
    for (let i = 0; i < this.count; i++) {
      mats.push(new THREE.Matrix4());
      tiles.push(new THREE.Vector4(0, 0, 1, 1));
      ranges.push(new THREE.Vector4(1, 1, 0, 0));
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      cam.layers.set(SHADOW_LAYER);
      cam.matrixAutoUpdate = true;
      this.cameras.push(cam);
    }

    this.uniforms = {
      rsCsmPackedMap: { value: null },
      rsCsmMat: { value: mats },
      rsCsmTile: { value: tiles },
      rsCsmRange: { value: ranges },
      rsCsmSplits: { value: new THREE.Vector4(1, 1, 1, 1) },
      rsCsmParams: { value: new THREE.Vector4(this.distance, this.lightAngularTan, 1 / this.tile, 1) },
      // x normal-offset texels, y constant depth bias (m),
      // z blocker-search radius (texels), w max penumbra (texels)
      //
      // maxPenumbra came down from 26 to 12. At golden hour pass 2 could blur a
      // shadow across 26 * 0.176 m = 4.6 metres of ground, which is exactly the
      // "200px blur that reads as fog, not a penumbra" the critique measured on
      // the money shot. The physical tan() term still drives the width; this is
      // only the ceiling that stops a 2 km-separated blocker from producing a
      // whole-cascade smear.
      rsCsmBias: { value: new THREE.Vector4(0.9, 0.02, 14.0, 12.0) },
      rsCsmKeyDir: { value: new THREE.Vector3(0, 1, 0) },
      /** rgb = ambient tint inside shadow, a = contact-term strength. */
      rsCsmAmbient: { value: new THREE.Vector4(0.62, 0.66, 0.78, 0.85) },
      rsCsmDebug: { value: 0 },
    };

    this.chunk = csmShaderChunk({
      cascades: this.count,
      blockerTaps: this.blockerTaps,
      pcfTaps: this.pcfTaps,
      nearTaps: this.nearTaps,
      soft: this.soft,
    });
    this.cacheKey = `rsCSM:${this.count}:${this.blockerTaps}:${this.pcfTaps}:${this.nearTaps}:${this.soft ? 1 : 0}`;

    /*
     * CHEAP VARIANT, for geometry whose fill cost is dominated by overdraw.
     *
     * A leaf card, a grass blade or a scrub billboard is alpha-tested, so it
     * cannot be early-Z rejected by itself, and in forest_interior the canopy
     * stacks ten or more of them along a view ray. Every one of those fragments
     * was running the full contact-hardening filter: an 8-tap blocker search
     * plus a 16-tap Vogel disk, 24 packed-RGBA fetches and unpacks, to decide
     * how soft the penumbra on a 4 cm leaf should be. It is invisible — foliage
     * shadowing reads as high-frequency dapple, not as a resolved penumbra —
     * and it was the single most expensive thing in the worst shot in the set.
     *
     * Materials opt in with `material.userData.rsCheapShadow = true`. They get
     * the same cascades, the same atlas and the same ambient/contact terms, on a
     * 4 + 6 tap fixed-radius filter instead of 24 with a blocker search.
     */
    this.chunkCheap = csmShaderChunk({
      cascades: this.count, blockerTaps: 4, pcfTaps: 6, nearTaps: 4, soft: false,
    });
    this.cacheKeyCheap = `rsCSMcheap:${this.count}`;

    this.enabled = patchLightsChunk();
    this._computeSplits();
  }

  init() {
    if (!this.enabled) return;
    const w = this.tile * this.cols;
    const h = this.tile * this.rows;

    const rt = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
    });
    rt.texture.colorSpace = THREE.NoColorSpace;
    rt.texture.name = 'rsCsmPacked';
    rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;

    // Depth is a plain renderbuffer: the shader never samples it (see the note
    // in ShadowShader on why this is one sampler and not two), it only has to
    // exist so the cascade passes z-test.
    this.atlas = rt;
    this.uniforms.rsCsmPackedMap.value = rt.texture;

    this._tileRect = [];
    for (let i = 0; i < this.count; i++) {
      const cx = i % this.cols;
      const cy = Math.floor(i / this.cols);
      this.uniforms.rsCsmTile.value[i].set(
        (cx * this.tile) / w,
        (cy * this.tile) / h,
        this.tile / w,
        this.tile / h,
      );
      this._tileRect[i] = [cx * this.tile, cy * this.tile, this.tile, this.tile];
    }
  }

  /** Practical (mixed log / uniform) split distribution over [_near, _far]. */
  _computeSplits() {
    const n = Math.max(this._near, 0.05);
    const f = Math.max(this._far, n * 4);
    const N = this.count;
    const splits = this.uniforms.rsCsmSplits.value;
    for (let i = 0; i < N; i++) {
      const p = (i + 1) / N;
      const log = n * Math.pow(f / n, p);
      const uni = n + (f - n) * p;
      const d = this.lambda * log + (1 - this.lambda) * uni;
      this.splitNear[i] = i === 0 ? n : this.splitFar[i - 1];
      this.splitFar[i] = i === N - 1 ? f : d;
    }
    /*
     * The distribution starts at the probed ground distance, but cascade 0 is
     * FITTED from the camera's real near plane. The shader hands everything
     * closer than splitFar[0] to cascade 0, so if the fit started at 80 m the
     * first 40 m of the world sampled outside the cascade box and came back
     * "lit" — no contact shadows anywhere near the camera, in every shot where
     * the probe found distant ground. Widening the slice costs ~1% of the
     * cascade's radius because the bounding sphere is dominated by the far end.
     */
    this.splitNear[0] = this.near;
    for (let i = 0; i < 4; i++) {
      splits.setComponent(i, this.splitFar[Math.min(i, N - 1)]);
    }
  }

  /**
   * Where does the camera's frustum actually meet the ground?
   *
   * A cascade set fitted to the raw frustum wastes every near cascade whenever
   * the camera is on a ridge: pass 1 measured cascades 0-2 (25 m / 64 m / 192 m)
   * completely empty in `golden_hour_vista` because the nearest terrain was
   * 105 m away, leaving one 780 m-radius cascade at 0.76 m per texel to carry
   * the whole frame. Marching the bottom-centre and centre view rays against the
   * heightfield costs a few dozen `getHeight` calls and tells us the real slab.
   *
   * Both ends are exponentially quantised and hysteresis-damped: the split
   * planes must not wobble frame to frame or the shadows swim.
   */
  _probeGround(camera) {
    const world = this.ctx.world;
    if (!world || !world.ready) return null;

    camera.getWorldDirection(_fwd);
    _camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);

    const march = (dx, dy, dz, maxT) => {
      const ox = camera.position.x;
      const oy = camera.position.y;
      const oz = camera.position.z;
      let s = 1.0;
      for (let k = 0; k < 220; k++) {
        const px = ox + dx * s;
        const py = oy + dy * s;
        const pz = oz + dz * s;
        if (py < world.getHeight(px, pz)) return s;
        s = s * 1.055 + 0.6;
        if (s > maxT) break;
      }
      return -1;
    };

    // bottom edge of the frustum -> nearest ground the camera can see
    _tmp.copy(_fwd).addScaledVector(_camUp, -t).normalize();
    const dNear = march(_tmp.x, _tmp.y, _tmp.z, this.maxDistance * 1.4);
    // centre ray -> the distance the shot is actually "about"
    const dMid = march(_fwd.x, _fwd.y, _fwd.z, this.maxDistance * 3.0);

    const camH = Math.max(0.2, camera.position.y - world.getHeight(camera.position.x, camera.position.z));
    let near = dNear > 0 ? dNear * 0.8 : Math.max(this.near, camH * 0.5);
    /*
     * Reach well past the subject: a mesa at 1.5 km wants a cast shadow down
     * its own flank at a 3-degree sun, and a 2 m texel out there subtends about
     * one screen pixel, so the range is nearly free. What is NOT free is
     * letting that range set the near split — that is `lambda`'s job, and it
     * is why lambda is 0.88 rather than the usual 0.6.
     */
    /*
     * 1.9 in pass 2, 1.15 now. The vista's centre ray hits ground at ~855 m, so
     * the old multiplier asked the cascade set to cover 1625 m and cascade 0
     * came out with a 180 m radius. Nothing at 1.6 km casts a shadow the eye can
     * resolve at this framing; what it costs is the texel density on the ground
     * the shot is actually about.
     */
    let far = Math.max(this.distance * 0.32, (dMid > 0 ? dMid : near * 12) * 1.15, near * 6);

    // Cap the near end hard relative to the far end: a distant subject must not
    // be allowed to starve the first cascade of the ground under the camera.
    near = THREE.MathUtils.clamp(near, this.near, Math.min(this.maxDistance * 0.09, far * 0.10));
    far = THREE.MathUtils.clamp(far, 90, this.maxDistance);
    return { near: quantise(near), far: quantise(far) };
  }

  setLightDirection(dir) {
    if (dir.lengthSq() < 1e-8) return;
    this.lightDir.copy(dir).normalize();
  }

  /** Mark the caster / material scan dirty (new geometry added to the scene). */
  invalidate() {
    this._dirty = true;
    // Geometry may have moved without the cascade fit changing, so the cached
    // atlas tiles are no longer trustworthy.
    if (this._cache) for (const st of this._cache) st.stamp = 0;
  }

  registerMaterialHook(fn) {
    this._materialHooks.push(fn);
  }

  registerMaterial(mat) {
    if (!mat) return;
    if (Array.isArray(mat)) {
      for (const m of mat) this.registerMaterial(m);
      return;
    }
    if (mat.__rsCsmFn === mat.onBeforeCompile) return;
    const cheap = !!(mat.userData && mat.userData.rsCheapShadow);
    const chunk = cheap ? this.chunkCheap : this.chunk;
    const key = cheap ? this.cacheKeyCheap : this.cacheKey;
    if (patchMaterial(mat, chunk, this.uniforms, key)) {
      for (const fn of this._materialHooks) fn(mat);
    }
  }

  /* ------------------------------------------------------------ scene scan */

  /**
   * Should a mesh that nobody explicitly opted in be treated as a caster?
   *
   * Pass 2 required every system to remember to call `requestShadowCaster`, and
   * the audit shows what that produced: 87 casters in `golden_hour_vista`,
   * consisting of the LOD-0 ring only. Every `_l1` mid-distance tree, the whole
   * impostor sheet, several scatter kinds and the wagon-scale town props had
   * `castShadow === false`, so the mid-field of the hero shot — most of the
   * frame — threw nothing. Opt-IN was the wrong default for a world this size.
   *
   * Opting in by default is only safe where the shadow pass can actually
   * reproduce the mesh's on-screen silhouette, so two gates:
   *
   *   - the object supplies its own `customDepthMaterial` (its owning system has
   *     already written the matching vertex path — this is the case for all of
   *     Vegetation's LODs), OR
   *   - the material has no foreign `onBeforeCompile` and the geometry is not an
   *     InstancedBufferGeometry, i.e. a derived MeshDepthMaterial reproduces it
   *     exactly.
   *
   * Anything else (billboard impostors whose vertex shader faces the camera,
   * GPU-instanced grass with no depth variant) is left alone, because rendering
   * it with a plain depth material puts garbage in the atlas.
   *
   * Opt out explicitly with `object.userData.rsNoShadow = true`; force in with
   * `object.userData.rsShadow = true`.
   */
  _autoCaster(o) {
    const ud = o.userData;
    if (ud) {
      if (ud.rsNoShadow === true) return false;
      if (ud.rsShadow === true) return true;
    }
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m || m.visible === false) return false;
    // Sky domes, water, clouds, particles, lens effects.
    if (m.isShaderMaterial || m.isRawShaderMaterial || m.isMeshBasicMaterial) return false;
    if (m.transparent || m.depthWrite === false) return false;
    if (m.colorWrite === false) return false;

    const safeDepth = !!o.customDepthMaterial ||
      (m.__rsForeignHook !== true && !(o.geometry && o.geometry.isInstancedBufferGeometry));
    if (!safeDepth) return false;

    const g = o.geometry;
    if (!g) return false;
    if (g.boundingBox === null) g.computeBoundingBox();
    const bb = g.boundingBox;
    if (!bb) return false;
    const sx = bb.max.x - bb.min.x;
    const sy = bb.max.y - bb.min.y;
    const sz = bb.max.z - bb.min.z;
    // Ground decals: roads, trail overlays, the campfire ash quad. A coplanar
    // caster only ever produces self-shadow acne on the surface it lies on.
    if (sy <= Math.max(sx, sz) * 0.02) return false;
    if (Math.max(sx, sy, sz) < 0.05) return false;
    return true;
  }

  scanScene() {
    const scene = this.ctx.scene;
    const casters = this.casters;
    casters.length = 0;
    scene.traverse((o) => {
      // Lights must be visible to the cascade cameras too. They render nothing,
      // but if the light counts differ between the shadow pass and the main
      // pass three invalidates its light-state hash every single frame.
      if (o.isLight) {
        o.layers.enable(SHADOW_LAYER);
        return;
      }
      if (o.material) this.registerMaterial(o.material);
      if (!(o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh)) return;
      if (!o.castShadow && o.userData.rsAutoCast === undefined) {
        // Evaluated once per object and cached: bounding-box work is not free
        // and the answer cannot change for a given mesh.
        o.userData.rsAutoCast = this._autoCaster(o);
      }
      if (o.castShadow || o.userData.rsAutoCast === true) {
        o.castShadow = true;
        o.layers.enable(SHADOW_LAYER);
        casters.push(o);
      } else if (o.layers.isEnabled(SHADOW_LAYER)) {
        o.layers.disable(SHADOW_LAYER);
      }
    });
    this._dirty = false;
  }

  requestShadowCaster(obj) {
    if (!obj) return;
    obj.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh) {
        o.castShadow = true;
        o.layers.enable(SHADOW_LAYER);
      }
    });
    this._dirty = true;
  }

  /* -------------------------------------------------------- cascade fitting */

  /**
   * Half-height (world metres, about `centre.y`) of the slab that can contain a
   * receiver or a caster inside this cascade's footprint.
   *
   * Nine analytic heightfield samples on a ring; the result is padded upward by
   * `casterHeadroom` (trees, buildings, mesa tops that shadow the valley) and
   * downward by a small margin, then quantised in 26% steps and only allowed to
   * SHRINK after it has been over-large for a while. Both of those exist because
   * a change to this number resizes the texel grid, and a texel grid that
   * resizes every frame is a shadow that swims.
   */
  _slabHalf(i, centre, radius) {
    const world = this.ctx.world;
    const st = this._slab[i];
    if (!world || !world.ready) return radius;
    let lo = Infinity;
    let hi = -Infinity;
    const r = radius * 0.80;
    for (let k = 0; k < 9; k++) {
      const a = (k / 8) * Math.PI * 2;
      const rr = k === 8 ? 0 : r;
      const h = world.getHeight(centre.x + Math.cos(a) * rr, centre.z + Math.sin(a) * rr);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    if (!isFinite(lo) || !isFinite(hi)) return radius;
    /*
     * Headroom is the height of a caster that can still land its shadow INSIDE
     * this cascade. At elevation e a caster of height h throws h/tan(e) metres,
     * so for a footprint 2R across only the first 2R*tan(e) metres of any caster
     * matter — 17 m at a 3-degree sun over a 300 m cascade. 26 m plus a small
     * scale term is generous for every tree and building in the world, and it is
     * a THIRD of what pass 3's first attempt used, which is worth 2x on the
     * texel because the headroom completely dominates the band at a low sun.
     */
    const head = this.casterHeadroom + radius * 0.06;
    const top = hi + head;
    const bot = lo - head * 0.30;
    // Recentre the box on the receiver band rather than on the frustum slice:
    // on a clifftop the slice centre floats 60 m above anything that can receive
    // a shadow, and centring there doubles the band for nothing.
    st.mid = 0.5 * (top + bot);
    let want = quantise(Math.max(0.5 * (top - bot), 5));
    if (st.v < 0 || want > st.v) {
      st.v = want;                 // first fit, or grow: never clip a caster
      st.hold = 0;
    } else if (want < st.v) {
      st.hold++;
      if (st.hold > 12) { st.v = want; st.hold = 0; }
    } else {
      st.hold = 0;
    }
    return st.v;
  }

  _fit(i, camera) {
    const near = this.splitNear[i];
    const far = this.splitFar[i];

    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    const a2 = t * t * (1 + camera.aspect * camera.aspect);

    // Bounding sphere of the frustum slice: centre on the view axis, radius
    // independent of camera orientation -> no shimmer when the camera turns.
    let c = 0.5 * (far + near) * (1 + a2);
    if (c > far) c = far;
    if (c < near) c = near;
    const rN = Math.sqrt((c - near) * (c - near) + a2 * near * near);
    const rF = Math.sqrt((c - far) * (c - far) + a2 * far * far);
    let radius = Math.max(rN, rF);
    radius = Math.ceil(radius * 32) / 32; // quantise so float drift cannot resize it

    camera.getWorldDirection(_fwd);
    _center.copy(camera.position).addScaledVector(_fwd, c);

    const up = Math.abs(this.lightDir.y) > 0.985 ? _upAlt : _up;
    _rot.identity();
    _rot.lookAt(this.lightDir, _zero, up);
    _rotInv.copy(_rot).transpose();

    /*
     * ANISOTROPIC LIGHT-SPACE EXTENT — the single biggest resolution win in this
     * pass.
     *
     * `_rot` builds the light basis with lookAt(lightDir, 0, worldUp), so its X
     * axis is horizontal and its Y axis lies in the vertical plane through the
     * light with Y.up = cos(elevation) and a horizontal component of magnitude
     * sin(elevation). A point offset d from the centre therefore has
     *
     *     |lightY| <= |d_horizontal| * sin(e) + |d_vertical| * cos(e)
     *
     * At a 3.3-degree sun that is radius*0.057 + slabHalf*0.998. The pass-2 fit
     * used a square box of half-extent `radius` in BOTH axes, so with a 180 m
     * cascade over ~45 m of terrain relief the occupied band was 9.0% of the
     * tile — measured directly out of the atlas. 91% of a 2048x2048 tile was
     * empty sky, and the ground was quantised to 0.176 m texels for no reason.
     *
     * Fitting Y to the slab takes cascade 0 from 0.176 m to about 0.045 m per
     * texel on the vertical axis at golden hour and degrades gracefully: at high
     * noon sin(e) -> 1, halfY -> radius, and the box is square again.
     *
     * Everything downstream (blocker search, penumbra, receiver-plane bias) is
     * expressed per axis in the shader, so the disk stays circular in WORLD
     * space rather than in texel space.
     */
    const sinE = Math.min(1, Math.abs(this.lightDir.y));
    const cosE = Math.sqrt(Math.max(0, 1 - sinE * sinE));
    const slab = this._slabHalf(i, _center, radius);
    if (this._slab[i].v > 0) _center.y = this._slab[i].mid;
    let halfY = radius * sinE + slab * cosE;
    halfY = Math.min(radius, Math.max(radius * this.minAniso, halfY));
    halfY = Math.ceil(halfY * 32) / 32;

    // Snap the cascade centre to whole shadow texels *in light space*, per axis.
    const texelX = (2 * radius) / this.tile;
    const texelY = (2 * halfY) / this.tile;
    _tmp.copy(_center).applyMatrix4(_rotInv);
    _tmp.x = Math.floor(_tmp.x / texelX) * texelX;
    _tmp.y = Math.floor(_tmp.y / texelY) * texelY;
    _tmp.applyMatrix4(_rot);

    const zExtend = this._zExtend;
    const cam = this.cameras[i];
    _lightPos.copy(_tmp).addScaledVector(this.lightDir, radius + zExtend);
    cam.position.copy(_lightPos);
    cam.quaternion.setFromRotationMatrix(_rot);
    cam.left = -radius;
    cam.right = radius;
    cam.top = halfY;
    cam.bottom = -halfY;
    cam.near = 0;
    cam.far = 2 * radius + zExtend;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    const range = cam.far - cam.near;
    const u = this.uniforms;
    /*
     * WORLD -> cascade clip only. The camera half of the matrix is applied in
     * `_refreshMatrices`, EVERY frame, for EVERY cascade — see the note there
     * for why that separation is not cosmetic.
     */
    this._lightVP[i].multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._hasFit[i] = true;
    u.rsCsmRange.value[i].set(range, texelX, texelY, far);
  }

  /**
   * Compose the shader's view-space -> cascade-clip matrix from each cascade's
   * light view-projection and the CURRENT camera world matrix.
   *
   * WHY THIS IS ITS OWN PASS, RUN EVERY FRAME.
   *
   * `rsCsmMat[i]` takes a VIEW-space position, so it necessarily contains
   * `camera.matrixWorld`. Folding that into `_fit` meant the uniform was only
   * refreshed when the cascade was refitted — i.e. every 2 / 3 / 4 frames for
   * cascades 1-3 (see the stagger in `update`). On every other frame the shader
   * was handed the CURRENT frame's view-space position and last-fit's
   * camera-to-world, so it reconstructed a world position that was wrong by the
   * camera's motion since that cascade's last fit.
   *
   * Translation error is a constant offset and the receiver-plane bias absorbs
   * most of it. ROTATION does not absorb: an angular error `theta` displaces the
   * sampled point by `theta * distance`, so the misregistration GROWS WITH
   * DEPTH, and it resets the instant the cascade refits. Measured while panning
   * at 60 deg/s (`tools/_csmprobe.mjs`): a single-frame darkening residual 11x
   * the noise floor at 66-82 m, oscillating at exactly period 2 in cascade 1,
   * period 3 in cascade 2 and period 4 in cascade 3 — one period per cascade's
   * own refresh interval. Inside cascade 0, which refits every frame, it was
   * immeasurable. That is the "ground and rocks flicker dark past a certain
   * distance, only when the camera moves" report.
   *
   * The fix costs `count` matrix multiplies per frame and keeps the stagger and
   * the shadow cache — and therefore all of the 27% the shadow pass bought —
   * because the ATLAS is still only redrawn on the stagger. Only the mapping
   * into it is kept honest. (The cache's change test moved onto `_lightVP`,
   * which is what the atlas actually depends on; testing the composed matrix
   * would now redraw every cascade every frame the camera moves.)
   */
  _refreshMatrices(camera) {
    const mats = this.uniforms.rsCsmMat.value;
    for (let i = 0; i < this.count; i++) {
      if (!this._hasFit[i]) continue;
      mats[i].multiplyMatrices(this._lightVP[i], camera.matrixWorld);
    }
  }

  /* ----------------------------------------------------------------- render */

  update(dt, camera, keyDirWorld) {
    if (!this.enabled || !this.atlas) return;
    const ctx = this.ctx;
    const renderer = ctx.renderer;
    const scene = ctx.scene;

    if (keyDirWorld) this.setLightDirection(keyDirWorld);

    if (this._dirty || ctx.time.frame % 45 === 0) this.scanScene();

    // Re-fit the cascade slab to the ground the camera can see. Cheap enough to
    // run every few frames; quantised so it only ever changes in visible steps.
    if (this._forceFrames > 0 || ctx.time.frame % 6 === 0) {
      const pr = this._probeGround(camera);
      if (pr && (pr.near !== this._near || pr.far !== this._far)) {
        this._near = pr.near;
        this._far = pr.far;
        this._computeSplits();
      }
    }

    this._zExtend = THREE.MathUtils.clamp(this._far * 1.8, 320, 2600);

    // View-space direction toward the key light, matching what three uploads
    // for the DirectionalLight so the shader can identify it.
    this.uniforms.rsCsmKeyDir.value.copy(this.lightDir).transformDirection(camera.matrixWorldInverse);

    const p = this.uniforms.rsCsmParams.value;
    p.x = this._far;
    p.y = this.lightAngularTan;
    p.z = 1 / this.tile;
    p.w = this.strength;

    // The blocker search has to be at least as wide as the penumbra it is being
    // asked to estimate, or contact-hardening quietly turns back into PCF.
    const b = this.uniforms.rsCsmBias.value;
    b.z = Math.min(b.w * 0.85, 22);

    // Nothing to render, or the key light is under the horizon (moonless
    // night) so nothing it lights is visible: disable the lookup rather than
    // sample a stale/uninitialised atlas, and skip four whole scene renders.
    if (this.casters.length === 0 || this.lightDir.y < 0.015) {
      p.w = 0;
      return;
    }

    const force = this._forceFrames > 0;
    if (force) this._forceFrames--;
    const frame = ctx.time.frame;

    // Stagger the far cascades: they cover huge areas that barely change.
    // 1/2/3/4 rather than pass 2's 1/1/2/3 — that is 2.08 cascade renders per
    // frame instead of 2.83, a 27% cut in the shadow pass, and the only thing
    // that changes visually is that a shadow 200 m away updates a frame or two
    // late while the camera is moving.
    const todo = [];
    for (let i = 0; i < this.count; i++) {
      const interval = i === 0 ? 1 : i === 1 ? 2 : i === 2 ? 3 : 4;
      if (force || frame % interval === 0) todo.push(i);
    }

    // Resolve world matrices once, then freeze them for the cascade passes so
    // renderer.render() does not re-traverse the whole scene four times.
    if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
    if (camera.parent === null && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();

    // Re-compose EVERY cascade's view-space matrix against this frame's camera,
    // whether or not it is being refitted or redrawn. This must happen before
    // any of the early-outs below. See `_refreshMatrices`.
    this._refreshMatrices(camera);
    if (todo.length === 0) return;

    /*
     * Fit first, then decide what actually has to be REDRAWN — see the shadow
     * cache note below. Doing the fit up front means a frame where every cascade
     * is cached costs four ortho fits and nothing else: no material swap, no
     * render-target binding, no scene traversal.
     */
    const draw = [];
    for (const i of todo) {
      this._fit(i, camera);
      const st = this._cache[i];
      // Compare the LIGHT view-projection, not the composed view-space matrix:
      // the atlas depends only on where the cascade camera is looking, and the
      // composed matrix now changes on every frame the camera moves.
      const m = this._lightVP[i].elements;
      let same = !force && st.n === this.casters.length && st.stamp > 0;
      if (same) {
        for (let k = 0; k < 16; k++) {
          if (Math.abs(m[k] - st.m[k]) > 1e-9) { same = false; break; }
        }
      }
      /*
       * SHADOW CACHE. A cascade whose light-space matrix has not moved is
       * looking at exactly the same world through exactly the same texels, so
       * the only thing that can have changed inside it is vertex animation —
       * wind in the canopy. Redrawing all four every frame for that is the most
       * wasteful thing the shadow pass does while the camera is still, and the
       * cascades are 30-40% of the frame's draw calls. Refresh on a slow
       * heartbeat instead (6 frames for the near cascade out to 21 for the far
       * one), far below the rate at which a branch moves a shadow texel, and
       * redraw immediately whenever the fit, the caster set or the scene change.
       */
      if (same && (frame - st.stamp) < (6 + i * 5)) continue;
      for (let k = 0; k < 16; k++) st.m[k] = m[k];
      st.n = this.casters.length;
      st.stamp = frame;
      draw.push(i);
    }
    // The cascades just refitted have a new `_lightVP`; re-compose those too.
    this._refreshMatrices(camera);
    if (draw.length === 0) return;

    const prevRT = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.enabled;
    const prevBg = scene.background;
    const prevOverride = scene.overrideMaterial;
    const prevAuto = scene.matrixWorldAutoUpdate;
    renderer.getClearColor(this._prevClear);
    const prevClearAlpha = renderer.getClearAlpha();

    renderer.shadowMap.enabled = false; // we do our own; do not recurse
    scene.background = null;
    scene.overrideMaterial = null;
    scene.matrixWorldAutoUpdate = false;
    renderer.setClearColor(0xffffff, 1.0); // packed depth 1.0 == "nothing here"

    if (PROFILE) prof.begin('csm');
    this._swapMaterials(true);

    const atlas = this.atlas;
    atlas.scissorTest = true;
    for (const i of draw) {
      const rr = this.uniforms.rsCsmRange.value[i];
      const culled = this._cullTiny(Math.max(rr.y, rr.z));
      const r = this._tileRect[i];
      atlas.viewport.set(r[0], r[1], r[2], r[3]);
      atlas.scissor.set(r[0], r[1], r[2], r[3]);
      renderer.setRenderTarget(atlas);
      renderer.render(scene, this.cameras[i]);
      for (let k = 0; k < culled.length; k++) culled[k].visible = true;
      culled.length = 0;
    }
    atlas.scissorTest = false;

    this._swapMaterials(false);
    if (PROFILE) prof.end();

    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(this._prevClear, prevClearAlpha);
    renderer.shadowMap.enabled = prevShadow;
    scene.background = prevBg;
    scene.overrideMaterial = prevOverride;
    scene.matrixWorldAutoUpdate = prevAuto;
  }

  /* ----------------------------------------------------- depth materials */

  _depthFor(src) {
    if (Array.isArray(src)) return src.map((m) => this._depthFor(m));
    let d = this._depthCache.get(src);
    if (d) return d;
    const alphaClipped = src && src.alphaTest > 0 && (src.map || src.alphaMap);
    d = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      side: src && src.side === THREE.DoubleSide ? THREE.DoubleSide : THREE.FrontSide,
      alphaTest: alphaClipped ? src.alphaTest : 0,
      map: alphaClipped ? src.map : null,
      alphaMap: alphaClipped ? src.alphaMap : null,
    });
    d.blending = THREE.NoBlending;
    d.fog = false;
    this._depthCache.set(src, d);
    return d;
  }

  /**
   * Shadow LOD: a caster whose whole silhouette is smaller than a texel of this
   * cascade can only produce aliasing, so hide it for that pass. This is what
   * keeps distant cascades affordable once vegetation exists.
   * @returns {Array} the objects hidden, to be restored by the caller.
   */
  _cullTiny(texelWorld) {
    const out = this._culled || (this._culled = []);
    const minR = texelWorld * 1.4;
    if (minR <= 0.02) return out;
    const casters = this.casters;
    for (let i = 0, n = casters.length; i < n; i++) {
      const o = casters[i];
      if (!o.visible) continue;
      // World-spanning meshes (the terrain clipmap) opt out of frustum culling
      // because their geometry is rebuilt around the camera; their per-patch
      // bounding sphere says nothing about their real extent, so never LOD them
      // out of a cascade — that is how the far cascade loses the whole ground.
      if (o.frustumCulled === false) continue;
      let r = o.userData.shadowRadius;
      if (r === undefined) {
        const g = o.geometry;
        if (!g) continue;
        if (g.boundingSphere === null) g.computeBoundingSphere();
        const bs = g.boundingSphere;
        if (!bs) continue;
        const m = o.matrixWorld.elements;
        const sx = Math.hypot(m[0], m[1], m[2]);
        const sy = Math.hypot(m[4], m[5], m[6]);
        const sz = Math.hypot(m[8], m[9], m[10]);
        r = bs.radius * Math.max(sx, sy, sz);
        // Per-instance scales are unknown here, so keep a safety margin.
        if (o.isInstancedMesh || o.isBatchedMesh) r *= 3;
      }
      if (r < minR) {
        o.visible = false;
        out.push(o);
      }
    }
    return out;
  }

  /**
   * A caster's own `customDepthMaterial` may use BasicDepthPacking (terrain
   * does), which stores depth at 8 bits. That is fine for the hardware
   * depth-compare test but useless for the PCSS blocker search: one LSB is
   * ~10 m of the cascade's depth range, so every occluder closer than that to
   * its receiver is missed and contact shadows silently disappear. Mirror the
   * material with RGBA packing, keeping its vertex displacement hook.
   */
  _packedVariant(src) {
    if (!src || src.depthPacking === THREE.RGBADepthPacking) return src;
    let d = this._depthCache.get(src);
    if (d) return d;
    d = src.clone();
    d.depthPacking = THREE.RGBADepthPacking;
    d.onBeforeCompile = src.onBeforeCompile;
    const k = src.customProgramCacheKey;
    d.customProgramCacheKey = () => (k ? k.call(src) : '') + '|rsRGBA';
    d.blending = THREE.NoBlending;
    d.fog = false;
    d.userData = src.userData;
    this._depthCache.set(src, d);
    return d;
  }

  _swapMaterials(on) {
    const casters = this.casters;
    for (let i = 0, n = casters.length; i < n; i++) {
      const o = casters[i];
      if (on) {
        o.__rsMat = o.material;
        o.material = o.customDepthMaterial
          ? this._packedVariant(o.customDepthMaterial)
          : this._depthFor(o.material);
      } else if (o.__rsMat) {
        o.material = o.__rsMat;
        o.__rsMat = null;
      }
    }
  }

  dispose() {
    if (this.atlas) this.atlas.dispose();
    for (const m of this._depthCache.values()) {
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m.dispose();
    }
    this._depthCache.clear();
  }
}
