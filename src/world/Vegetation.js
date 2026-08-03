import * as THREE from 'three';
import { createVegUniforms } from './vegetation/VegCommon.js';
import { buildLeafAtlas, buildGrassAtlas, buildFlowerAtlas } from './vegetation/VegTextures.js';
import { buildVegMaps } from './vegetation/VegMaps.js';
import { GrassField } from './vegetation/Grass.js';
import { Undergrowth } from './vegetation/Undergrowth.js';
import { Wildflowers } from './vegetation/Wildflowers.js';
import { Forest } from './vegetation/Forest.js';

/**
 * VEGETATION
 * ============================================================================
 * Grass, undergrowth and forest. Everything is instanced, everything is placed
 * from the terrain's own surface data, and everything moves.
 *
 *   Grass        four camera-following bands of cross-quad tufts, placed and
 *                wrapped entirely in the vertex shader (GrassField)
 *   Undergrowth  six species of scrub/fern/dead brush from one atlas, same
 *                GPU placement, species chosen per instance from the biome map
 *   Forest       four procedurally grown species x several variants, three LOD
 *                levels ending in baked billboard impostors (Forest)
 *
 * Everything shares one uniform block (`this.u`) holding time, camera, wind,
 * the sun, and the terrain height / normal-AO / biome textures — so a single
 * write per frame drives the whole layer, and the shadow pass sees exactly the
 * same placement as the colour pass.
 *
 * Public surface other systems may use:
 *   veg.densityAt(x, z)   -> { grass, forest, shrub, moisture }
 *   veg.isForest(x, z)    -> boolean, useful for audio beds and wildlife
 *   veg.stats()           -> { drawCalls, triangles, trees, instances }
 */
export class Vegetation {
  static id = 'vegetation';

  constructor(ctx) {
    this.ctx = ctx;
    this.group = null;
    this.u = createVegUniforms();
    this._wind = new THREE.Vector2(1, 0);
    this._fwd = new THREE.Vector3();
    this._sunCol = new THREE.Color();
    this.enabled = true;
  }

  async init() {
    const ctx = this.ctx;
    const terrain = ctx.get('terrain');
    if (!terrain || !ctx.world.ready || !terrain.getHeightfield) {
      console.warn('[vegetation] terrain is not ready — vegetation disabled');
      this.enabled = false;
      return;
    }

    const t0 = performance.now();
    const q = ctx.quality;
    const aniso = Math.min(q.anisotropy || 8, ctx.caps ? ctx.caps.aniso : 8);

    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    this.group.matrixAutoUpdate = false;
    ctx.scene.add(this.group);

    /* ------------------------------------------------------------ textures */
    /* 512 px per foliage tile at ultra. A 1.5 m canopy card two metres from the
       camera covers ~500 screen pixels; 256 was the reason a leaf resolved as a
       flat lozenge under a 2x zoom. The chain below it is built on the CPU (see
       VegTextures) so the extra resolution costs boot time, not frame time. */
    const atlasSize = q.name === 'low' ? 512 : q.name === 'medium' ? 1024 : 2048;
    this.leafAtlas = buildLeafAtlas((ctx.seed ^ 0x6d2b79f5) >>> 0, atlasSize, aniso);
    /* Grass is now a 4x4 atlas (4 species x 4 variants) instead of 4x1, so the
       tile edge is quoted directly rather than derived from a sheet width. 192
       keeps the whole sheet at 768² — 2.3x the pixels of the old 1024x256 sheet
       for FOUR times the plants — and the dilate pass count drops from three to
       two to pay for it, because boot is already over budget and every capture
       by every future agent pays this. */
    this.grassAtlas = buildGrassAtlas((ctx.seed ^ 0x1f123bb5) >>> 0,
      q.name === 'low' ? 96 : q.name === 'medium' ? 128 : 192, aniso);
    /* Eight flower species in an 8x1 sheet — 1024x128 at ultra, the cheapest
       atlas in the layer by an order of magnitude. Flowers are only ever drawn
       inside 34 m, so the tile only has to hold up at arm's length. */
    this.flowerAtlas = buildFlowerAtlas((ctx.seed ^ 0x27d4eb2f) >>> 0,
      q.name === 'low' ? 64 : q.name === 'medium' ? 96 : 128, aniso);
    const tTex = performance.now();

    /* ---------------------------------------------------------- biome maps */
    this.maps = buildVegMaps(ctx);
    const tMaps = performance.now();

    /* ------------------------------------------------------ shared uniforms
     * The height texture is built here from `terrain.getHeightfield()` — the
     * documented contract surface — rather than borrowed from the terrain's own
     * internal `heightTex`. Two reasons: the terrain is free to change that
     * field's format or filtering at any time (it has already moved its
     * normal/AO map from RGBA8 to half-float mid-project), and sampling the
     * same Float32Array `world.getHeight` reads guarantees a blade of grass and
     * a footstep query can never disagree about where the ground is. */
    const hf = terrain.getHeightfield();
    const linearHeight = !!(ctx.caps && ctx.caps.floatLinear);
    this.vegDefines = linearHeight ? { VEG_LINEAR_HEIGHT: 1 } : {};
    const heightTex = new THREE.DataTexture(
      hf.data, hf.res, hf.res, THREE.RedFormat, THREE.FloatType);
    heightTex.minFilter = heightTex.magFilter =
      linearHeight ? THREE.LinearFilter : THREE.NearestFilter;
    heightTex.wrapS = heightTex.wrapT = THREE.ClampToEdgeWrapping;
    heightTex.colorSpace = THREE.NoColorSpace;
    heightTex.generateMipmaps = false;
    heightTex.needsUpdate = true;
    this.heightTex = heightTex;

    this.u.uVegHeight.value = heightTex;
    this.u.uVegNrmAO.value = this.maps.normalTexture;
    this.u.uVegCtrl.value = this.maps.texture;
    this.u.uVegWorld.value.set(hf.size * 0.5, hf.res, ctx.world.waterLevel, 0);

    /* ------------------------------------------------------------- systems */
    this.grass = new GrassField(ctx, this.u, this.grassAtlas, this.vegDefines).build(this.group);
    this.under = new Undergrowth(ctx, this.u, this.leafAtlas, this.vegDefines).build(this.group);
    /* Wildflowers are OCCASIONAL — one draw call, one 34 m ring, no shadow
       pass. See Wildflowers.js for why every number in it is shy. */
    this.flowers = new Wildflowers(ctx, this.u, this.flowerAtlas, this.vegDefines).build(this.group);
    const tGrass = performance.now();

    this.forest = new Forest(ctx, this.u, this.maps, this.leafAtlas).build(this.group);
    const tForest = performance.now();

    /*
     * Foliage takes the cheap cascade filter (see CascadedShadowMaps.chunkCheap).
     * Grass, undergrowth and leaf cards are alpha-tested and heavily overdrawn,
     * and a contact-hardened penumbra on a blade of grass is not a thing anyone
     * has ever seen. Set before Lighting's scanScene patches them.
     */
    for (const set of [this.grass, this.under, this.flowers, this.forest]) {
      if (!set || !set.materials) continue;
      for (const m of set.materials) {
        if (m) { m.userData = m.userData || {}; m.userData.rsCheapShadow = true; }
      }
    }

    /* ---------------------------------------------- atmosphere on everything */
    const sky = ctx.get('sky');
    if (sky) {
      for (const m of this.grass.materials) sky.injectAerialPerspective(m);
      for (const m of this.under.materials) sky.injectAerialPerspective(m);
      for (const m of this.forest.materials) sky.injectAerialPerspective(m);
    }

    const lighting = ctx.get('lighting');
    if (lighting) lighting.invalidate();

    this._sync(0);
    this.forest.update();

    this._stats = {
      trees: this.forest.trees,
      grassInstances: this.grass.instances,
      bushInstances: this.under.instances,
      flowerInstances: this.flowers.instances,
      drawCalls: this.grass.meshes.length + this.under.meshes.length
        + this.flowers.meshes.length + this.forest.meshes.length + 1,
    };

    if (import.meta.env && import.meta.env.DEV) {
      console.log('[vegetation] %dms — atlases %d, maps %d, grass %d, forest %d | %d trees, %d grass instances, ~%d draws',
        (performance.now() - t0) | 0, (tTex - t0) | 0, (tMaps - tTex) | 0,
        (tGrass - tMaps) | 0, (tForest - tGrass) | 0,
        this.forest.trees, this.grass.instances, this._stats.drawCalls);
    }
  }

  /* ------------------------------------------------------------ public API */

  densityAt(x, z) {
    if (!this.maps) return { grass: 0, forest: 0, shrub: 0, moisture: 0 };
    return {
      grass: this.maps.sample(this.maps.grass, x, z),
      forest: this.maps.sample(this.maps.forest, x, z),
      shrub: this.maps.sample(this.maps.shrub, x, z),
      moisture: this.maps.sample(this.maps.moist, x, z),
    };
  }

  isForest(x, z) {
    return this.maps ? this.maps.sample(this.maps.forest, x, z) > 0.30 : false;
  }

  /**
   * The world's regional plan — see vegetation/Ecology.js. Scatter reads this
   * so that boulders, loose stone and set dressing agree with the trees about
   * where a forest, a scree apron and an empty flat are. Null before init.
   *
   * @returns {{sample:Function, zoneAt:Function, tree:Uint8Array,
   *            shrub:Uint8Array, grass:Uint8Array, rock:Uint8Array,
   *            stone:Uint8Array, hero:Uint8Array}|null}
   */
  ecology() { return this.maps ? this.maps.eco : null; }

  stats() { return this._stats || {}; }

  /* ---------------------------------------------------------------- frame */

  _sync(dt) {
    const ctx = this.ctx;
    const env = ctx.env;
    const u = this.u;

    u.uVegTime.value += dt;

    /*
     * Keep the campfire clear. Town builds its ring at the `camp_fire` POI
     * (Terrain registers it first, Town re-registers the same spot once the
     * pad is graded), and Town init runs at order 50 — after this system —
     * so the POI is resolved lazily here rather than at build time. It is a
     * single vec4, so re-reading it every frame costs nothing and it tracks
     * Town's final placement.
     */
    if (!this._clearPoi) {
      const fire = ctx.poi.get('camp_fire');
      if (fire) {
        const p = fire.pos || fire;
        /*
         * 2.6 m was not enough. Town lays its whole camp out to `town.camp
         * .radius` (5.5 m) — fire ring, log seats, tripod, kindling stack —
         * and undergrowth cards were still standing between the stones and
         * behind the tripod, where they render as flat cream paper cutouts
         * lit edge-on by the fire. Clear the camp Town actually built.
         */
        const town = ctx.get('town');
        const r = (town && town.camp && town.camp.radius) || 5.5;
        u.uVegClear.value.set(p.x, p.z, r * 1.35, 3.0);
        this._clearPoi = true;
      }
    }

    const cam = ctx.camera;
    u.uVegCam.value.copy(cam.position);
    cam.getWorldDirection(this._fwd);
    u.uVegCamFwd.value.copy(this._fwd);

    const wv = env.windVector;
    let wx = wv.x, wz = wv.z;
    const wl = Math.hypot(wx, wz);
    if (wl > 1e-4) { wx /= wl; wz /= wl; } else { wx = 1; wz = 0; }
    u.uVegWind.value.set(wx, wz, Math.max(0, env.windStrength || 0),
      THREE.MathUtils.clamp(env.windGust || 0, 0, 1));

    u.uVegSun.value.copy(env.sunDirection).normalize();

    /* Translucency radiance: the key light's actual linear colour, knocked down
       because a leaf transmits a fraction of what hits it and the light has
       already been through one surface. */
    const lighting = ctx.get('lighting');
    if (lighting && lighting.sun) {
      this._sunCol.copy(lighting.sun.color).multiplyScalar(lighting.sun.intensity * 0.16);
    } else {
      this._sunCol.copy(env.sunColor).multiplyScalar(Math.max(0, env.sunIntensity) * 0.16);
    }
    u.uVegSunCol.value.set(this._sunCol.r, this._sunCol.g, this._sunCol.b);
  }

  /**
   * Everything happens in lateUpdate: the camera is not final until CameraRig
   * has run, and the placement uniforms have to be settled before Lighting's
   * lateUpdate renders the shadow cascades — otherwise the shadow pass would see
   * grass and trees one frame behind where they are drawn.
   */
  lateUpdate(dt) {
    if (!this.enabled) return;
    this._sync(dt);
    this.forest.update();
  }

  dispose() {
    if (this.grass) this.grass.dispose();
    if (this.under) this.under.dispose();
    if (this.flowers) this.flowers.dispose();
    if (this.forest) this.forest.dispose();
    if (this.leafAtlas) this.leafAtlas.dispose();
    if (this.grassAtlas) this.grassAtlas.dispose();
    if (this.flowerAtlas) this.flowerAtlas.dispose();
    if (this.heightTex) this.heightTex.dispose();
    if (this.maps && this.maps.texture) this.maps.texture.dispose();
    if (this.maps && this.maps.normalTexture) this.maps.normalTexture.dispose();
    if (this.group && this.group.parent) this.group.parent.remove(this.group);
  }
}
