import * as THREE from 'three';
import { WORLD } from '../core/Config.js';
import { rng } from '../core/Context.js';

import { setNoiseSeed, fbm, smoothstep, clamp } from './terrain/Noise.js';
import { generateCoarse, refineCore, RIVER_PTS } from './terrain/Field.js';
import { hydraulicErode, thermalErode, blurField } from './terrain/Erosion.js';
import {
  fillDepressions, flowAccumulate, carveChannels, traceRivers,
} from './terrain/Hydrology.js';
import {
  bakeNormalAO, computeSkyAO, computeSunShadow, blurU8FromFloat, bakeSplat,
  makeMacroTexture,
} from './terrain/Maps.js';
import { ClipmapMesh } from './terrain/Mesh.js';
import { makeGroundDetail } from './terrain/GroundDetail.js';
import { makeTownPad } from './town/Pad.js';
import {
  buildLayerArrays, makeTerrainMaterial, makeTerrainDepthMaterial,
  LAYER_SCALE, DETAIL_SCALE,
} from './terrain/Material.js';

/* ------------------------------------------------------------- resolutions */
const CORE = WORLD.size;              // 8192 m playable square
const RSIM = WORLD.heightRes;         // 1024 — erosion / hydrology grid (8 m)
const RFIN = 2048;                    // 4 m final heightfield for render+queries
const RCOARSE = 512;                  // landform pass over the core
const BACK_EXT = 24576;               // distant backdrop so the horizon is land
const RBACK = 384;

/** `?terrainReport=1` prints the composition/slope histogram at boot. */
const TERRAIN_REPORT = (() => {
  try { return new URLSearchParams(globalThis.location.search).get('terrainReport') === '1'; }
  catch (e) { return false; }
})();

const LEAF = 96;                      // metres per finest quadtree node
const LEVELS = 9;                     // 96 * 2^8 = 24576 m root
const GRIDN = 24;                     // quads per node edge → 4 m at the leaf

const HALF = CORE * 0.5;
const BLEND_START = HALF * 0.90;
const BLEND_END = HALF;

/**
 * Angle of repose scale. The talus limit per cell is
 * `TALUS_BASE * (0.30 + hardness^2 * 3.4)` rise-over-run, so soft ground
 * (hardness 0.34) stabilises at ~35deg and caprock (hardness 0.97) holds
 * ~74deg. Those two numbers are the entire silhouette of a western range.
 */
const TALUS_BASE = 1.0;

/**
 * Terrain — landform generation, erosion, hydrology and rendering.
 *
 * init() budget is spent as: landform synthesis → 250k-droplet hydraulic
 * erosion → thermal talus relaxation at a real 35deg angle of repose →
 * depression fill + multiple-flow accumulation → channel incision → bank-local
 * relaxation → a second talus pass to re-sharpen the scarps → detail upsample
 * with fall-line rills and a 4 m talus pass → derived maps.
 * Everything downstream (splat weights, `world.getSurface`, the flow map the
 * Water system routes rivers with) is read off those same arrays, so what the
 * shader paints and what other systems query cannot disagree.
 */
export class Terrain {
  static id = 'terrain';

  constructor(ctx) {
    this.ctx = ctx;
    this._materialUsers = [];
    this._materials = [];
    this._sunDir = new THREE.Vector3(0, 1, 0);
    this._sunTimer = 999;
    this._tmpV = new THREE.Vector3();
    /** Registered ground-height overrides — see addHeightOverride(). */
    this._overrides = [];
  }

  /* ================================================================= init */

  async init() {
    const ctx = this.ctx;
    const t0 = performance.now();
    setNoiseSeed(ctx.seed ^ 0x51ed270b);
    const rand = rng(ctx.seed ^ 0x27d4eb2d);

    /* ---------------------------------------------------- 1. landform mass */
    const coarse = generateCoarse(RCOARSE, CORE);
    const backdrop = generateCoarse(RBACK, BACK_EXT);
    const field = refineCore(coarse, RSIM, CORE);
    const tGen = performance.now();
    await this._yield();

    /* ------------------------------------------------------- 2. erosion */
    const h = field.h;
    const flowSeed = new Float32Array(RSIM * RSIM);
    hydraulicErode(h, field.hard, flowSeed, RSIM, rand, {
      /*
       * 250k droplets x 54 steps was 1.1 s of the 15 s boot. The erosion signal
       * saturates well before that: at 8 m per simulation cell, 120k droplets
       * still deposits ~0.9 paths per cell, and the thermal pass plus the
       * channel carve below dominate the silhouette anyway. Measured landform
       * statistics (slope histogram, % steep ground) are within a percent.
       */
      droplets: 120000,
      maxSteps: 46,
      capacity: 3.2,
      erode: 0.34,
      deposit: 0.26,
      radius: 3,
    });
    const tHyd = performance.now();
    await this._yield();

    /*
     * Thermal (talus) relaxation. TALUS_BASE 1.0 puts loose material at ~35deg
     * — the real angle of repose — and hard caprock at ~68deg, which is what
     * produces flat-topped scarps and scree cones instead of a field of dunes.
     * Pass 1 ran it at 0.62, capping soft ground at 23deg: every landform came
     * out as a smooth C1 mound with no hard edge anywhere in ten shots.
     */
    thermalErode(h, field.hard, RSIM, 18, TALUS_BASE, CORE / RSIM);
    const tTherm = performance.now();
    await this._yield();

    /* --------------------------------------------- 3. hydrology + channels */
    const cellSim = CORE / RSIM;
    const filled = fillDepressions(h, RSIM, 0.004);
    const { acc, recv } = flowAccumulate(filled, RSIM, cellSim);
    const { wet } = carveChannels(h, acc, RSIM, cellSim, {
      startArea: 4.0e4, fullArea: 9.0e5, maxDepth: 7.0, maxWiden: 3.4,
    });
    /*
     * Relax the freshly cut banks ONLY. Pass 1 blurred the whole field here at
     * 55% strength, which quietly erased every scarp the thermal pass had just
     * built — the erosion was running, its output was being smoothed away.
     */
    const relaxed = blurField(h, RSIM, 1, 1.0);
    for (let i = 0; i < RSIM * RSIM; i++) {
      const k = smoothstep(0.12, 0.62, wet[i]) * 0.75;
      if (k > 0) h[i] += (relaxed[i] - h[i]) * k;
    }
    /* and re-sharpen: channel incision oversteepens the banks, so the talus
       angle has to be re-imposed after the water has finished cutting */
    thermalErode(h, field.hard, RSIM, 6, TALUS_BASE, CORE / RSIM);
    this.rivers = traceRivers(acc, recv, h, RSIM, cellSim, HALF,
      { minArea: 3.2e5, maxRivers: 12, minLength: 26 });
    const tFlow = performance.now();
    await this._yield();

    /* ------------------------------------------------ 4. detail upsample */
    const H = this._upsampleWithDetail(h, RSIM, RFIN, CORE, field.hard);
    this.H = H;
    this.res = RFIN;
    this.cell = CORE / RFIN;
    this.invCell = RFIN / CORE;
    const tUp = performance.now();
    await this._yield();

    /* ----------------------------------------------------- 5. backdrop */
    this._blendBackdrop(backdrop, H);
    this.back = backdrop.h;
    this.backRes = RBACK;
    this.backHalf = BACK_EXT * 0.5;

    /* ------------------------------------------- 6. surface classification */
    const splat = bakeSplat(field, h, acc, wet, RSIM, cellSim, WORLD.waterLevel, HALF,
      H, RFIN);
    this.splatA = splat.splatA;
    this.splatB = splat.splatB;
    this.ctrl = splat.ctrl;
    this.splatRes = RSIM;

    /* flow map exposed at the final heightfield resolution so consumers can
       index it exactly like the heightfield */
    this.flow = this._upsampleLinear(acc, RSIM, RFIN);
    this.flowRes = RFIN;
    this.simFlow = acc;

    /* water mask + surface */
    this.waterMask = new Uint8Array(RSIM * RSIM);
    this.waterSurf = new Float32Array(RSIM * RSIM);
    for (let i = 0; i < RSIM * RSIM; i++) {
      const surf = h[i] + 1.15;
      this.waterSurf[i] = surf;
      this.waterMask[i] = (wet[i] > 0.46 || h[i] < WORLD.waterLevel) ? 1 : 0;
    }
    this.wetMask = wet;
    this._simH = h;

    /* -------------------------------------------------------- 7. world API
     * Installed BEFORE the town pad, because the pad's grade is an upper
     * envelope of NATURAL ground and it samples `_rawHeight` to build it. The
     * override it then registers is read by the composited `getHeight` from the
     * next call onward. */
    this._installWorldAPI();

    /* --------------------------------------------------------- 8. town pad
     * The settlement's graded shelf is published through `ctx.world.getHeight`
     * here, so every consumer of the ground query agrees with the street the
     * town later draws on top of it. See town/Pad.js and addHeightOverride(). */
    const tPad0 = performance.now();
    this._buildTownPad();
    const tPad = performance.now() - tPad0;
    await this._yield();

    /* -------------------------------------------------------- 9. derived maps */
    const aoSrc = this._downsample(h, RSIM, 512);
    const ao = computeSkyAO(aoSrc, 512, CORE / 512);
    const nrmAO = bakeNormalAO(H, RFIN, this.cell, ao, 512);
    const tMaps = performance.now();
    await this._yield();

    /* -------------------------------------------------------- 10. textures */
    this._buildTextures(nrmAO);
    const proc = ctx.get('procTextures');
    const maxAniso = ctx.caps ? ctx.caps.aniso : 8;
    const aniso = Math.min(Math.max(ctx.quality.anisotropy, 16), maxAniso);
    const arrays = buildLayerArrays(proc, ctx.quality.name === 'low' ? 256 : 512, aniso);
    this.albArray = arrays.albArray;
    this.nrmArray = arrays.nrmArray;
    this.macroTex = makeMacroTexture(512);
    /* Eye-level ground surface: pebbles, soil clumps, crack network, grain.
       256px is a 2.3 mm texel at the 0.6 m tile it is sampled with — 30x the
       texel density of the splat layers, which is the entire point. Measured
       at 14 ms once, so it stays on the boot path rather than popping in. */
    /* Anisotropy 4, NOT the 16 the splat layers use. Measured by ablation at
       1280x720/medium: two explicit-gradient fetches of a 16x-aniso texture on
       ground seen at a grazing angle cost 3.0 ms in high_noon_desert on their
       own — up to 16 texel taps EACH. At 4x the same two fetches cost a
       fraction of that and the difference is invisible, because the detail
       that 16x buys at a grazing angle is below a pixel anyway. */
    /* 384, not 256: at the 0.85 m fine tile that is a 2.2 mm texel, which is the
       scale the 1:1 foreground crop actually resolves. The bake is O(S^2), so
       this is ~+18 ms once at boot and nothing per frame. */
    this.groundDetailTex = makeGroundDetail(384, (ctx.seed ^ 0x7a3d19) >>> 0, 4);
    const tTex = performance.now();
    await this._yield();

    /* ---------------------------------------------------------- 11. mesh */
    this._buildMesh();

    /* ------------------------------------------------------- 12. sun shadow */
    this.shadowRes = RSIM;
    this.shadowField = new Float32Array(RSIM * RSIM);
    this._updateSunShadow(true);

    /* ---------------------------------------------------------- 13. POIs */
    this._registerPOIs();

    const t1 = performance.now();
    // Two full-field scans (1024^2 + 2048^2/9) purely to print a histogram.
    // Boot pays for it on every capture every agent ever runs; keep it behind
    // an explicit opt-in.
    if (TERRAIN_REPORT) this._reportComposition();
    if (import.meta.env && import.meta.env.DEV) {
      console.log('[terrain] %dms  gen %d  hydraulic %d  thermal %d  flow %d  upsample %d  townpad %d  maps %d  tex %d',
        (t1 - t0) | 0, (tGen - t0) | 0, (tHyd - tGen) | 0, (tTherm - tHyd) | 0,
        (tFlow - tTherm) | 0, (tUp - tFlow) | 0, tPad | 0, (tMaps - tUp) | 0,
        (tTex - tMaps) | 0);
    }
  }

  _yield() { return new Promise((r) => setTimeout(r, 0)); }

  /**
   * Surface-composition and slope histogram, reported once at boot. Cheap, and
   * it is the only way to tell "the mountains have no rock painted on them"
   * apart from "the rock layer looks like dirt" without guessing at pixels.
   */
  _reportComposition() {
    const R = this.splatRes, N = R * R;
    const sum = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < N; i++) {
      const j = i * 4;
      sum[0] += this.splatA[j]; sum[1] += this.splatA[j + 1];
      sum[2] += this.splatA[j + 2]; sum[3] += this.splatA[j + 3];
      sum[4] += this.splatB[j]; sum[5] += this.splatB[j + 1];
    }
    const pct = sum.map((v) => (v / (N * 255) * 100).toFixed(1));
    /* slope histogram off the FINAL heightfield */
    const bins = new Array(7).fill(0);
    const F = this.H, FR = this.res, c = this.cell;
    let n = 0;
    for (let y = 2; y < FR - 2; y += 3) {
      for (let x = 2; x < FR - 2; x += 3) {
        const k = y * FR + x;
        const gx = (F[k + 1] - F[k - 1]) / (2 * c);
        const gz = (F[k + FR] - F[k - FR]) / (2 * c);
        const deg = Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
        bins[Math.min(6, (deg / 10) | 0)]++; n++;
      }
    }
    /* composition restricted to steep ground — "is there rock on the cliffs" */
    const st = [0, 0, 0, 0, 0, 0]; let sn = 0;
    const f2 = FR / R;
    for (let y = 1; y < R - 1; y++) {
      for (let x = 1; x < R - 1; x++) {
        const fx = Math.min(FR - 2, Math.max(1, (x * f2) | 0));
        const fy = Math.min(FR - 2, Math.max(1, (y * f2) | 0));
        const k = fy * FR + fx;
        const gx = (F[k + 1] - F[k - 1]) / (2 * c);
        const gz = (F[k + FR] - F[k - FR]) / (2 * c);
        if (Math.hypot(gx, gz) < 0.58) continue;      // < 30 degrees
        const j = (y * R + x) * 4;
        st[0] += this.splatA[j]; st[1] += this.splatA[j + 1];
        st[2] += this.splatA[j + 2]; st[3] += this.splatA[j + 3];
        st[4] += this.splatB[j]; st[5] += this.splatB[j + 1];
        sn++;
      }
    }
    let lo = Infinity, hi = -Infinity, mean = 0, below = 0;
    for (let i = 0; i < F.length; i++) {
      const v = F[i];
      if (v < lo) lo = v; if (v > hi) hi = v;
      mean += v; if (v < WORLD.waterLevel) below++;
    }
    this.composition = {
      hMin: +lo.toFixed(1), hMax: +hi.toFixed(1),
      hMean: +(mean / F.length).toFixed(1),
      pctBelowWater: +(below / F.length * 100).toFixed(2),
      grassP: +pct[0], grassD: +pct[1], dirt: +pct[2],
      rock: +pct[3], scree: +pct[4], sand: +pct[5],
      slopeDeg: bins.map((b) => +(b / n * 100).toFixed(1)),
      steep: st.map((v) => +(v / (Math.max(1, sn) * 255) * 100).toFixed(1)),
    };
    if (import.meta.env && import.meta.env.DEV) {
      console.warn('[terrain:composition]', JSON.stringify(this.composition));
    }
  }

  /* ------------------------------------------------------------- helpers */

  _downsample(src, res, out) {
    const dst = new Float32Array(out * out);
    const f = res / out;
    for (let y = 0; y < out; y++) {
      for (let x = 0; x < out; x++) {
        let s = 0, n = 0;
        const y0 = (y * f) | 0, x0 = (x * f) | 0;
        for (let b = 0; b < f; b++) {
          for (let a = 0; a < f; a++) { s += src[(y0 + b) * res + x0 + a]; n++; }
        }
        dst[y * out + x] = s / n;
      }
    }
    return dst;
  }

  _upsampleLinear(src, res, out) {
    const dst = new Float32Array(out * out);
    const s = res / out;
    for (let y = 0; y < out; y++) {
      const fy = clamp(y * s + (s - 1) * 0.5, 0, res - 1.001);
      const y0 = fy | 0, ty = fy - y0, y1 = Math.min(res - 1, y0 + 1);
      for (let x = 0; x < out; x++) {
        const fx = clamp(x * s + (s - 1) * 0.5, 0, res - 1.001);
        const x0 = fx | 0, tx = fx - x0, x1 = Math.min(res - 1, x0 + 1);
        const a = src[y0 * res + x0], b = src[y0 * res + x1];
        const c = src[y1 * res + x0], d = src[y1 * res + x1];
        dst[y * out + x] = (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
      }
    }
    return dst;
  }

  /**
   * Upsample the eroded field and put back the sub-cell detail it cannot hold.
   *
   * Pass 1 added smooth fBm here, which is exactly the wrong shape: it rounds
   * off the scarps the thermal pass produced. The detail is now RIDGED on
   * steep ground (sharp crests and V-notches, oriented by the local gradient
   * so it reads as gullying down the fall line) and only smooth on the flats,
   * and the whole field then gets a short talus pass at 4 m so the hard edges
   * exist at render resolution and not just in the 8 m sim.
   */
  _upsampleWithDetail(src, res, out, size, hard) {
    const dst = this._upsampleLinear(src, res, out);
    const step = size / out;
    const half = size * 0.5;
    const inv = 1 / (2 * step);
    for (let y = 1; y < out - 1; y++) {
      const z = -half + (y + 0.5) * step;
      for (let x = 1; x < out - 1; x++) {
        const i = y * out + x;
        const dx = (dst[i + 1] - dst[i - 1]) * inv;
        const dz = (dst[i + out] - dst[i - out]) * inv;
        const slope = Math.sqrt(dx * dx + dz * dz);
        const wx = -half + (x + 0.5) * step;
        const st = Math.min(slope, 1.6) / 1.6;
        /* gully / rill detail, elongated ALONG the fall line so it reads as
           water-cut rather than as a lumpy noise field */
        const fx = slope > 1e-4 ? dx / slope : 1, fz = slope > 1e-4 ? dz / slope : 0;
        const ax = wx * fz - z * fx, az = (wx * fx + z * fz) * 0.32;
        const rill = (1 - Math.abs(fbm(ax, az, 3, 1 / 26))) * 2 - 1;
        const smooth = fbm(wx, z, 2, 1 / 52);
        const fine = fbm(wx + 517, z - 233, 2, 1 / 17);
        const amp = 1.3 + st * 3.2;
        dst[i] += smooth * amp * (1 - st * 0.7)
          + rill * amp * st * 1.35
          + fine * amp * 0.16;
      }
    }
    /* re-impose the angle of repose at render resolution */
    if (hard) {
      const hf = this._upsampleLinear(hard, res, out);
      thermalErode(dst, hf, out, 4, TALUS_BASE, size / out);
    }
    return dst;
  }

  /** Make the 24 km backdrop agree with the eroded core so there is no seam. */
  _blendBackdrop(backdrop, H) {
    const R = backdrop.res;
    const step = BACK_EXT / R;
    const half = BACK_EXT * 0.5;
    for (let j = 0; j < R; j++) {
      const z = -half + (j + 0.5) * step;
      for (let i = 0; i < R; i++) {
        const x = -half + (i + 0.5) * step;
        const e = Math.max(Math.abs(x), Math.abs(z));
        if (e > BLEND_END) continue;
        const k = smoothstep(BLEND_START, BLEND_END, e);
        const hc = this._bilerp(H, RFIN, HALF, x, z);
        backdrop.h[j * R + i] = hc + (backdrop.h[j * R + i] - hc) * k;
      }
    }
  }

  _bilerp(data, res, half, x, z) {
    const inv = res / (half * 2);
    let fx = (x + half) * inv - 0.5;
    let fz = (z + half) * inv - 0.5;
    if (fx < 0) fx = 0; else if (fx > res - 1.001) fx = res - 1.001;
    if (fz < 0) fz = 0; else if (fz > res - 1.001) fz = res - 1.001;
    const x0 = fx | 0, z0 = fz | 0;
    const tx = fx - x0, tz = fz - z0;
    const r0 = z0 * res, r1 = r0 + res;
    const a = data[r0 + x0], b = data[r0 + x0 + 1];
    const c = data[r1 + x0], d = data[r1 + x0 + 1];
    const t0 = a + (b - a) * tx;
    return t0 + ((c + (d - c) * tx) - t0) * tz;
  }

  /* ------------------------------------------------------------- textures */

  _buildTextures(nrmAO) {
    const heightTex = new THREE.DataTexture(
      this.H, RFIN, RFIN, THREE.RedFormat, THREE.FloatType);
    heightTex.minFilter = heightTex.magFilter = THREE.NearestFilter;
    heightTex.wrapS = heightTex.wrapT = THREE.ClampToEdgeWrapping;
    heightTex.generateMipmaps = false;
    heightTex.needsUpdate = true;
    this.heightTex = heightTex;

    /* Half-float so surface orientation is not quantised — an 8-bit normal
       steps ~0.45deg per LSB, which reads as blocky terracing across any
       smooth slope under a directional key. */
    const nrmTex = new THREE.DataTexture(
      nrmAO, RFIN, RFIN, THREE.RGBAFormat, THREE.HalfFloatType);
    nrmTex.colorSpace = THREE.NoColorSpace;
    nrmTex.wrapS = nrmTex.wrapT = THREE.ClampToEdgeWrapping;
    nrmTex.minFilter = THREE.LinearMipmapLinearFilter;
    nrmTex.magFilter = THREE.LinearFilter;
    nrmTex.generateMipmaps = true;
    nrmTex.anisotropy = 8;
    nrmTex.needsUpdate = true;
    this.nrmAOTex = nrmTex;

    /*
     * splatA / splatB / ctrl live as three layers of ONE array texture. Same
     * data, same filtering, but the terrain fragment program spends one
     * sampler instead of three — and with the shadow cascades, the local-light
     * shadow maps and Sky's LUT also bound, sixteen units is a real ceiling.
     */
    const SR = this.splatRes;
    const packed = new Uint8Array(SR * SR * 4 * 3);
    packed.set(this.splatA, 0);
    packed.set(this.splatB, SR * SR * 4);
    packed.set(this.ctrl, SR * SR * 8);
    const splatArr = new THREE.DataArrayTexture(packed, SR, SR, 3);
    splatArr.format = THREE.RGBAFormat;
    splatArr.type = THREE.UnsignedByteType;
    splatArr.colorSpace = THREE.NoColorSpace;
    splatArr.wrapS = splatArr.wrapT = THREE.ClampToEdgeWrapping;
    splatArr.minFilter = THREE.LinearMipmapLinearFilter;
    splatArr.magFilter = THREE.LinearFilter;
    splatArr.generateMipmaps = true;
    splatArr.anisotropy = 4;
    splatArr.needsUpdate = true;
    this.splatArrTex = splatArr;

    this.shadowData = new Uint8Array(RSIM * RSIM);
    const st = new THREE.DataTexture(this.shadowData, RSIM, RSIM, THREE.RedFormat);
    st.colorSpace = THREE.NoColorSpace;
    st.wrapS = st.wrapT = THREE.ClampToEdgeWrapping;
    st.minFilter = st.magFilter = THREE.LinearFilter;
    st.generateMipmaps = false;
    st.needsUpdate = true;
    this.sunShadowTex = st;
  }

  _buildBackTexture() {
    const t = new THREE.DataTexture(this.back, RBACK, RBACK, THREE.RedFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    this.backTex = t;
  }

  /* ----------------------------------------------------------------- mesh */

  _buildMesh() {
    const ctx = this.ctx;
    this._buildBackTexture();

    const bias = ctx.quality.terrainLodBias || 1;
    const leafRange = clamp(LEAF * 9.4 / bias, LEAF * 8.0, LEAF * 13);

    this.uniforms = {
      uHeightTex: { value: this.heightTex },
      uBackTex: { value: this.backTex },
      uCore: { value: new THREE.Vector4(HALF, RFIN, BLEND_START, BLEND_END) },
      uBack: { value: new THREE.Vector2(this.backHalf, RBACK) },
      uLodCam: { value: new THREE.Vector3() },
      uNrmAO: { value: this.nrmAOTex },
      uSplat: { value: this.splatArrTex },
      uSunShadow: { value: this.sunShadowTex },
      uMacro: { value: this.macroTex },
      uCloudSh: { value: new THREE.Vector4(0, 1 / 900, 0, 0) },
      uAlb: { value: this.albArray },
      uNrmRgh: { value: this.nrmArray },
      uLayerScale: { value: LAYER_SCALE.slice() },
      uLayerDetail: { value: DETAIL_SCALE.slice() },
      uSurf: { value: new THREE.Vector4(0, 0, 430, 1.42) },
      uDetailFade: { value: new THREE.Vector2(24, 420) },
      uGroundDet: { value: this.groundDetailTex },
      /* x,y = 1/tile metres (fine, mid); z = relief strength; w = fine fade far.
         0.85 m and 3.1 m are not harmonically related, so the two octaves
         cannot beat into a period the eye can lock onto.
         PASS 11: strength 1.25 -> 1.80 and the fine octave reaches 46 m instead
         of 34. The critic's verdict on pass 10 was "zero micro-relief anywhere",
         and it was right: at 1.25 against a normal map whose xy barely left
         ±0.35 there was nothing for a raking sun to catch, and the fine tap
         switched off at 34 m — i.e. before the ground the player is walking
         toward. The extra taps are gated on `flatK` and on view-angle, so the
         cost lands only where the surface is square-on enough to resolve. */
      uGrndP: { value: new THREE.Vector4(1 / 0.85, 1 / 3.1, 1.80, 38) },
      /* x = lagged pond level, y = mid fade far, z = shoreline hardness.
         The RANGE knobs (uGrndP.w, uWetP.y) are the ones that cost fill — each
         is an extra explicit-gradient tap per fragment. Pass 10 ran 34/105;
         pass 11's first attempt ran 46/148 and put river_bend at 16.6 ms
         against a 16.7 budget. 38/112 keeps the extra reach where the eye
         actually resolves the grain and spends the strength (uGrndP.z, an ALU
         multiply, not a tap) on making it visible instead. */
      uWetP: { value: new THREE.Vector4(0, 112, 9.0, 0) },
      uSkyRefl: { value: new THREE.Color(0, 0, 0) },
    };

    this.clip = new ClipmapMesh({
      gridN: GRIDN, leafSize: LEAF, levels: LEVELS, leafRange, maxInstances: 4096,
    });
    /* The pyramid describes the MESH, and the mesh renders the raw heightfield —
       ground-height overrides are query-side only (see addHeightOverride). */
    const py = this._rawHeight || this.getHeight;
    this.clip.buildPyramid((x, z) => py(x, z));

    this.material = makeTerrainMaterial(this.uniforms, GRIDN);
    this.depthMaterial = makeTerrainDepthMaterial(this.uniforms, GRIDN);
    this._materials.push(this.material, this.depthMaterial);

    this.mesh = new THREE.Mesh(this.clip.geometry, this.material);
    this.mesh.customDepthMaterial = this.depthMaterial;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.mesh.matrixAutoUpdate = false;
    /*
     * DRAW THE GROUND LAST AMONG OPAQUE GEOMETRY.
     *
     * This was -1, i.e. first. The clipmap is one draw whose origin sits at the
     * camera, so three's front-to-back opaque sort put it at the head of the
     * queue and its ~25-fetch fragment shader ran on EVERY pixel of the frame —
     * then trees, buildings, rocks and grass painted over the result. Measured
     * by ablation at 1920x1080/ultra, hiding the terrain outright was worth
     * 10.3 ms in town_street and 11.7 ms in forest_interior, and most of what it
     * shades in those two shots is never seen.
     *
     * Drawing it after everything else opaque means the depth buffer is already
     * complete when it runs, so early-Z rejects the covered fragments before the
     * shader starts. Nothing about the image changes: it is opaque geometry with
     * depth test and depth write both on, and the two ground decals that DO have
     * to land on top of it (the ash scar, the cart-track ribbon) are
     * `transparent: true, depthWrite: false`, so they live in the transparent
     * queue and are drawn after all opaque geometry regardless of renderOrder.
     */
    this.mesh.renderOrder = 20;
    this.mesh.name = 'terrain';
    ctx.scene.add(this.mesh);

    for (const fn of this._materialUsers) {
      for (const m of this._materials) { try { fn(m); } catch (e) { /* consumer */ } }
    }
  }

  /* ------------------------------------------------------------ world API */

  _installWorldAPI() {
    const ctx = this.ctx;
    const H = this.H, RES = RFIN, INV = RFIN / CORE;
    const back = this.back, BR = RBACK, BINV = RBACK / BACK_EXT, BHALF = BACK_EXT * 0.5;

    const rawHeight = (x, z) => {
      const e = Math.abs(x) > Math.abs(z) ? Math.abs(x) : Math.abs(z);
      let hc = 0;
      if (e < BLEND_END) {
        let fx = (x + HALF) * INV - 0.5;
        let fz = (z + HALF) * INV - 0.5;
        if (fx < 0) fx = 0; else if (fx > RES - 1.001) fx = RES - 1.001;
        if (fz < 0) fz = 0; else if (fz > RES - 1.001) fz = RES - 1.001;
        const x0 = fx | 0, z0 = fz | 0;
        const tx = fx - x0, tz = fz - z0;
        const r0 = z0 * RES + x0, r1 = r0 + RES;
        const a = H[r0], b = H[r0 + 1], c = H[r1], d = H[r1 + 1];
        const t0 = a + (b - a) * tx;
        hc = t0 + ((c + (d - c) * tx) - t0) * tz;
        if (e <= BLEND_START) return hc;
      }
      /* backdrop blend outside the authored core */
      let bx = (x + BHALF) * BINV - 0.5;
      let bz = (z + BHALF) * BINV - 0.5;
      if (bx < 0) bx = 0; else if (bx > BR - 1.001) bx = BR - 1.001;
      if (bz < 0) bz = 0; else if (bz > BR - 1.001) bz = BR - 1.001;
      const bx0 = bx | 0, bz0 = bz | 0;
      const btx = bx - bx0, btz = bz - bz0;
      const q0 = bz0 * BR + bx0, q1 = q0 + BR;
      const A = back[q0], B = back[q0 + 1], C = back[q1], D = back[q1 + 1];
      const u0 = A + (B - A) * btx;
      const hb = u0 + ((C + (D - C) * btx) - u0) * btz;
      if (e >= BLEND_END) return hb;
      const k = smoothstep(BLEND_START, BLEND_END, e);
      return hc + (hb - hc) * k;
    };
    this._rawHeight = rawHeight;

    /*
     * Composite the registered ground-height overrides on top of the natural
     * terrain. See addHeightOverride() for why the town's graded street lives
     * here rather than in the heightfield itself.
     *
     * Hot path: physics runs this twice per character per fixed step, the foot
     * IK four more times, and Scatter/Wildlife/audio all lean on it. The common
     * case — nothing registered, or the sample is outside every footprint — is
     * a length check and four compares.
     */
    const ovs = this._overrides;
    const getHeight = (x, z) => {
      const base = rawHeight(x, z);
      const n = ovs.length;
      if (n === 0) return base;
      let add = 0;
      for (let i = 0; i < n; i++) {
        const o = ovs[i];
        if (x < o.x0 || x > o.x1 || z < o.z0 || z > o.z1) continue;
        const fx = (x - o.x0) / o.cell, fz = (z - o.z0) / o.cell;
        let ix = fx | 0, iz = fz | 0;
        if (ix > o.n - 2) ix = o.n - 2;
        if (iz > o.n - 2) iz = o.n - 2;
        const tx = fx - ix, tz = fz - iz;
        const d = o.data, r0 = iz * o.n + ix, r1 = r0 + o.n;
        const a = d[r0], b = d[r0 + 1], c = d[r1], e2 = d[r1 + 1];
        const t0 = a + (b - a) * tx;
        const v = t0 + ((c + (e2 - c) * tx) - t0) * tz;
        if (v > add) add = v;
      }
      return base + add;
    };

    const getNormal = (x, z, target = new THREE.Vector3()) => {
      const e = 2.6;
      const hl = getHeight(x - e, z), hr = getHeight(x + e, z);
      const hd = getHeight(x, z - e), hu = getHeight(x, z + e);
      return target.set(hl - hr, 2 * e, hd - hu).normalize();
    };

    const SR = this.splatRes;
    const splatA = this.splatA, splatB = this.splatB;
    const sampleSplat = (x, z, out) => {
      let fx = (x + HALF) * (SR / CORE) - 0.5;
      let fz = (z + HALF) * (SR / CORE) - 0.5;
      if (fx < 0) fx = 0; else if (fx > SR - 1.001) fx = SR - 1.001;
      if (fz < 0) fz = 0; else if (fz > SR - 1.001) fz = SR - 1.001;
      const x0 = fx | 0, z0 = fz | 0;
      const tx = fx - x0, tz = fz - z0;
      const i00 = (z0 * SR + x0) * 4, i10 = i00 + 4;
      const i01 = i00 + SR * 4, i11 = i01 + 4;
      const w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz);
      const w01 = (1 - tx) * tz, w11 = tx * tz;
      for (let c = 0; c < 4; c++) {
        out[c] = (splatA[i00 + c] * w00 + splatA[i10 + c] * w10
          + splatA[i01 + c] * w01 + splatA[i11 + c] * w11) / 255;
      }
      for (let c = 0; c < 2; c++) {
        out[4 + c] = (splatB[i00 + c] * w00 + splatB[i10 + c] * w10
          + splatB[i01 + c] * w01 + splatB[i11 + c] * w11) / 255;
      }
    };
    const _sp = new Float32Array(6);

    const getSurface = (x, z) => {
      sampleSplat(x, z, _sp);
      /* snow is a runtime layer — mirror exactly what the shader does */
      const env = ctx.env;
      let snow = 0;
      if (env.snowCover > 0.001) {
        const n = getNormal(x, z, this._tmpV);
        const y = getHeight(x, z);
        snow = clamp(env.snowCover
          * smoothstep(0.40, 0.84, n.y)
          * smoothstep(this.snowLine - 190, this.snowLine + 120, y), 0, 1);
      }
      const k = 1 - snow;
      return {
        grass: (_sp[0] + _sp[1]) * k,
        rock: (_sp[3] + _sp[4] * 0.55) * k,
        dirt: (_sp[2] + _sp[4] * 0.45) * k,
        sand: _sp[5] * k,
        snow,
      };
    };

    const WM = this.waterMask, WS = this.waterSurf, WR = RSIM;
    const isWater = (x, z) => {
      const ix = ((x + HALF) * (WR / CORE)) | 0;
      const iz = ((z + HALF) * (WR / CORE)) | 0;
      if (ix < 0 || iz < 0 || ix >= WR || iz >= WR) return false;
      const i = iz * WR + ix;
      if (WM[i] === 0) return false;
      return getHeight(x, z) <= WS[i] + 0.05;
    };

    ctx.world.getHeight = getHeight;
    ctx.world.getNormal = getNormal;
    ctx.world.getSurface = getSurface;
    ctx.world.getSlope = (x, z) => getNormal(x, z, this._tmpV).y;
    ctx.world.isWater = isWater;
    ctx.world.waterLevel = WORLD.waterLevel;
    ctx.world.size = CORE;
    ctx.world.ready = true;

    this.getHeight = getHeight;
    this.getNormal = getNormal;
    this.snowLine = 430;
  }

  /* --------------------------------------------- ground-height overrides */

  /**
   * Register a walkable surface that REPLACES the terrain height over a
   * bounded footprint, and is therefore visible through `ctx.world.getHeight`.
   *
   * This is the contract that was missing, and it is the fix for "the horse and
   * rider are under the ground when they go into town". The settlement lofts a
   * graded street 0.4–1.4 m above the raw hillside; nothing told the height
   * query, so the character controller, the horse, the foot IK, the contact
   * shadows and the footstep audio all snapped to the buried hillside while the
   * player looked at the street. `getHeight` is documented as *the* ground, so
   * any system that lays ground has to be able to say so.
   *
   * DELIBERATELY NOT A CARVE OF THE HEIGHTFIELD ITSELF. That was tried first
   * and is wrong here: `H` is also what the terrain mesh and — critically —
   * Vegetation's grass shader sample, so raising it lifts every blade of grass
   * on the site up to street level and the main street comes back as a meadow.
   * Vegetation seeds from the heightfield and cannot be told to keep out from
   * this side. So the heightfield keeps describing the natural ground that the
   * grass grows out of and the road buries, and the QUERY describes the made
   * ground the player actually stands on. Where they differ, the difference is
   * covered by the road mesh, so the visible surface and the query are the same
   * surface everywhere — which is the invariant that matters.
   *
   * The override is baked to a dense grid at registration time and read back
   * with a bounds test plus a bilinear fetch, because `getHeight` is on the hot
   * path for physics, foot IK, wildlife, scatter and audio.
   *
   * Overrides are FILL ONLY (clamped at or above natural ground) so a surface
   * laid on them can never sink through the terrain mesh underneath.
   *
   * @param {object} o { cx, cz, bound, cell, sample(x,z) -> {y,w} }
   * @returns {object} handle for removeHeightOverride
   */
  addHeightOverride(o) {
    const cell = o.cell || 2.0;
    const n = Math.max(2, Math.ceil((o.bound * 2) / cell) + 1);
    const x0 = o.cx - o.bound, z0 = o.cz - o.bound;
    const data = new Float32Array(n * n);
    const raw = this._rawHeight;
    for (let j = 0; j < n; j++) {
      const z = z0 + j * cell;
      for (let i = 0; i < n; i++) {
        const x = x0 + i * cell;
        const s = o.sample(x, z);
        if (!s || s.w <= 0) continue;
        const d = (s.y - raw(x, z)) * s.w;
        data[j * n + i] = d > 0 ? d : 0;      // fill only
      }
    }
    const ov = { x0, z0, x1: x0 + (n - 1) * cell, z1: z0 + (n - 1) * cell, n, cell, data };
    this._overrides.push(ov);
    return ov;
  }

  removeHeightOverride(ov) {
    const i = this._overrides.indexOf(ov);
    if (i >= 0) this._overrides.splice(i, 1);
  }

  /* ------------------------------------------------------------- town pad */

  /**
   * Build the town's graded shelf and publish it through the height query.
   *
   * Runs during terrain generation so the pad is already visible to everything
   * that queries the ground, and so Town can adopt the identical spine and
   * grade table instead of re-deriving them (which would close the upper
   * envelope over its own output). See town/Pad.js.
   */
  _buildTownPad() {
    const ctx = this.ctx;
    const site = this._findTownSite();
    this.townSite = site;

    const tod = ctx.get('timeOfDay');
    const pad = makeTownPad({
      seed: ctx.seed,
      site,
      dayOfYear: ctx.env ? ctx.env.dayOfYear : 172,
      latitude: tod && tod.latitude != null ? tod.latitude : 38,
      getHeight: this._rawHeight,
    });
    this.townPad = pad;

    pad.override = this.addHeightOverride({
      cx: site.x, cz: site.z, bound: pad.bound, cell: 2.0,
      sample: (x, z) => pad.sample(x, z),
    });
  }

  /* ------------------------------------------------------------- contract */

  getHeightfield() { return { data: this.H, res: RFIN, size: CORE }; }

  /** Upstream catchment area in m² per cell — threshold it to get rivers. */
  getFlowMap() {
    return {
      data: this.flow, res: this.flowRes, size: CORE,
      cellArea: (CORE / this.flowRes) * (CORE / this.flowRes),
    };
  }

  /** Extra, for Water: trunk channel polylines with width + surface height. */
  getRivers() { return this.rivers; }

  /** Extra, for Water: the local water-surface height inside a channel. */
  getWaterSurface(x, z) {
    const ix = clamp(((x + HALF) * (RSIM / CORE)) | 0, 0, RSIM - 1);
    const iz = clamp(((z + HALF) * (RSIM / CORE)) | 0, 0, RSIM - 1);
    return this.waterSurf[iz * RSIM + ix];
  }

  /**
   * The eye-level ground surface the terrain shades its near field with —
   * offered so anything else that lays ground (the town street and its ruts,
   * road ribbons, camp clearings) can match it instead of drifting off into a
   * different material. RGBA8 linear, repeating: RG = tangent normal xy,
   * B = micro height (also the puddle basin field), A = stone/lag mask.
   *
   * Sample it at BOTH tile sizes through different rotations, or the period
   * becomes visible: one tap alone repeats every fineTile metres.
   *
   * @returns {{texture:THREE.Texture, fineTile:number, midTile:number,
   *            fineFade:number, midFade:number}}
   */
  getGroundDetail() {
    const p = this.uniforms ? this.uniforms.uGrndP.value : null;
    const w = this.uniforms ? this.uniforms.uWetP.value : null;
    return {
      texture: this.groundDetailTex,
      fineTile: p ? 1 / p.x : 0.85,
      midTile: p ? 1 / p.y : 3.1,
      fineFade: p ? p.w : 34,
      midFade: w ? w.y : 105,
    };
  }

  registerMaterialUser(fn) {
    if (typeof fn !== 'function') return;
    this._materialUsers.push(fn);
    for (const m of this._materials) { try { fn(m); } catch (e) { /* consumer */ } }
  }

  /** Analytic ray march against the heightfield. */
  raycast(origin, dir, maxDist = 9000) {
    const d = dir.clone().normalize();
    let t = 0;
    let step = 1.2;
    let prevH = origin.y - this.getHeight(origin.x, origin.z);
    if (prevH < 0) return null;
    const p = new THREE.Vector3();
    while (t < maxDist) {
      t += step;
      p.copy(origin).addScaledVector(d, t);
      const g = this.getHeight(p.x, p.z);
      const diff = p.y - g;
      if (diff < 0) {
        /* bisect the last interval for a clean hit point */
        let lo = t - step, hi = t;
        for (let i = 0; i < 18; i++) {
          const m = (lo + hi) * 0.5;
          p.copy(origin).addScaledVector(d, m);
          if (p.y - this.getHeight(p.x, p.z) < 0) hi = m; else lo = m;
        }
        p.copy(origin).addScaledVector(d, hi);
        const n = this.getNormal(p.x, p.z, new THREE.Vector3());
        return { point: p.clone(), normal: n, distance: hi };
      }
      prevH = diff;
      step = Math.max(1.2, Math.min(48, diff * 0.55 + t * 0.006));
    }
    return null;
  }

  /* ------------------------------------------------------------ sun shadow */

  _updateSunShadow(force = false) {
    const s = this.ctx.env.sunDirection;
    if (!force && this._sunDir.dot(s) > 0.99997) return;
    this._sunDir.copy(s);
    computeSunShadow(this._simH, RSIM, CORE / RSIM, s.x, s.y, s.z, this.shadowField, 2.6);
    blurU8FromFloat(this.shadowField, this.shadowData, RSIM, 2);
    this.sunShadowTex.needsUpdate = true;
  }

  /* ----------------------------------------------------------------- POIs */

  _registerPOIs() {
    const ctx = this.ctx;
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const gh = this.getHeight;

    /* --- town: flattest buildable shelf near running water, in the lowlands.
     * Already chosen in `_buildTownPad`; reuse it rather than
     * re-running the search over the whole field. */
    const site = this.townSite || this._findTownSite();
    this.townSite = site;
    const dir = site.dir;
    const tx = site.x, tz = site.z;
    const ty = gh(tx, tz);
    ctx.poi.set('town', {
      pos: V(tx - dir.x * 95, ty + 2.6, tz - dir.z * 95),
      look: V(tx + dir.x * 90, ty + 1.4, tz + dir.z * 90),
    });
    ctx.poi.set('town_end', {
      pos: V(tx + dir.x * 105, ty + 1.6, tz + dir.z * 105),
      look: V(tx, ty, tz),
    });

    /* --- river: stand on the bank looking downstream */
    const rv = this._pickRiverView();
    ctx.poi.set('river', { pos: rv.cam, look: rv.look });
    ctx.poi.set('river_down', { pos: rv.look, look: rv.look });

    /* --- forest: inside the foothill timber belt */
    const fo = this._pickRegionPoint('foot', 0.55, 120, 300);
    const fdir = new THREE.Vector3(0.62, 0, -0.78).normalize();
    ctx.poi.set('forest', { pos: V(fo.x, gh(fo.x, fo.z) + 2.1, fo.z), look: V(fo.x + fdir.x * 70, gh(fo.x, fo.z) + 2.6, fo.z + fdir.z * 70) });
    const ffx = fo.x + fdir.x * 90, ffz = fo.z + fdir.z * 90;
    ctx.poi.set('forest_fwd', { pos: V(ffx, gh(ffx, ffz) + 2.6, ffz), look: V(ffx, gh(ffx, ffz), ffz) });

    /* --- camp: a sheltered bench above the river */
    const cp = rv.camp;
    const cfx = cp.x + rv.dir.x * 5.5, cfz = cp.z + rv.dir.z * 5.5;
    ctx.poi.set('camp', { pos: V(cp.x, gh(cp.x, cp.z) + 1.65, cp.z), look: V(cfx, gh(cfx, cfz) + 0.6, cfz) });
    ctx.poi.set('camp_fire', { pos: V(cfx, gh(cfx, cfz) + 0.45, cfz), look: V(cfx, gh(cfx, cfz), cfz) });

    /* --- defensive fallbacks so the capture harness always resolves */
    if (!ctx.poi.has('player_ots')) {
      ctx.poi.set('player_ots', { pos: V(tx - dir.x * 30, ty + 3.2, tz - dir.z * 30), look: V(tx, ty + 1.2, tz) });
      ctx.poi.set('player_fwd', { pos: V(tx + dir.x * 40, ty + 1.4, tz + dir.z * 40), look: V(tx, ty, tz) });
    }
  }

  _findTownSite() {
    const R = RSIM, cell = CORE / R;
    const gh = this.getHeight;
    let best = null;
    for (let j = 60; j < R - 60; j += 6) {
      const z = -HALF + j * cell;
      for (let i = 60; i < R - 60; i += 6) {
        const x = -HALF + i * cell;
        const y = this._simH[j * R + i];
        if (y < WORLD.waterLevel + 4 || y > WORLD.waterLevel + 110) continue;

        /* must be near a real channel but not in it */
        let nearFlow = 0, inChannel = 0;
        for (let b = -18; b <= 18; b += 6) {
          for (let a = -18; a <= 18; a += 6) {
            const k = (j + b) * R + (i + a);
            const w = this.wetMask[k];
            if (w > 0.45) {
              const d = Math.hypot(a, b) * cell;
              if (d < 40) inChannel = 1;
              nearFlow = Math.max(nearFlow, 1 - d / 340);
            }
          }
        }
        if (inChannel || nearFlow < 0.25) continue;

        /* flatness over a ~110 m building footprint */
        let lo = Infinity, hi = -Infinity;
        for (let b = -7; b <= 7; b += 2) {
          for (let a = -7; a <= 7; a += 2) {
            const v = this._simH[(j + b) * R + (i + a)];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        const relief = hi - lo;
        if (relief > 13) continue;

        const plain = this._plainAt(x, z);
        const score = (1 - relief / 13) * 2.4 + nearFlow * 1.6 + plain * 1.2
          - Math.hypot(x, z) / 6000;
        if (!best || score > best.score) best = { x, z, score, relief };
      }
    }
    if (!best) best = { x: -520, z: -180, score: 0, relief: 0 };
    /* street runs along the local contour so the town does not sit on a slope */
    const n = this.getNormal(best.x, best.z, new THREE.Vector3());
    let dx = -n.z, dz = n.x;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    best.dir = new THREE.Vector3(dx, 0, dz);
    void gh;
    return best;
  }

  _plainAt(x, z) {
    const R = RSIM;
    const ix = clamp(((x + HALF) * (R / CORE)) | 0, 0, R - 1);
    const iz = clamp(((z + HALF) * (R / CORE)) | 0, 0, R - 1);
    const j = (iz * R + ix) * 4;
    return this.splatA[j] / 255 + this.splatA[j + 1] / 255;
  }

  _pickRiverView() {
    const gh = this.getHeight;
    let river = null;
    for (const r of this.rivers) if (!river || r.length > river.length) river = r;
    if (!river || river.length < 8) {
      const p = new THREE.Vector3(-900, 0, 260);
      return {
        cam: new THREE.Vector3(p.x, gh(p.x, p.z) + 3, p.z),
        look: new THREE.Vector3(p.x + 120, gh(p.x + 120, p.z) + 1, p.z),
        camp: new THREE.Vector3(p.x - 14, 0, p.z - 10),
        dir: new THREE.Vector3(1, 0, 0),
      };
    }
    /* two thirds downstream: wide enough to read as a river, still has banks */
    const idx = Math.min(river.length - 6, Math.floor(river.length * 0.62));
    const a = river[idx], b = river[Math.min(river.length - 1, idx + 5)];
    const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const camX = a.x - dir.x * 55 + side.x * 26;
    const camZ = a.z - dir.z * 55 + side.z * 26;
    const lookX = a.x + dir.x * 95;
    const lookZ = a.z + dir.z * 95;
    return {
      cam: new THREE.Vector3(camX, gh(camX, camZ) + 3.6, camZ),
      look: new THREE.Vector3(lookX, gh(lookX, lookZ) + 1.2, lookZ),
      camp: new THREE.Vector3(a.x + side.x * 30, 0, a.z + side.z * 30),
      dir: new THREE.Vector3(-side.x, 0, -side.z),
    };
  }

  _pickRegionPoint(kind, minW, altLo, altHi) {
    const R = RSIM, cell = CORE / R;
    let best = null;
    for (let j = 40; j < R - 40; j += 9) {
      const z = -HALF + j * cell;
      for (let i = 40; i < R - 40; i += 9) {
        const x = -HALF + i * cell;
        const k = j * R + i;
        const y = this._simH[k];
        if (y < altLo || y > altHi) continue;
        const n = this.getNormal(x, z, this._tmpV);
        if (n.y < 0.86) continue;
        const g = (this.splatA[k * 4] + this.splatA[k * 4 + 1]) / 255;
        const score = g + n.y * 0.6 - Math.abs(y - (altLo + altHi) * 0.5) / 400;
        if (score < minW) continue;
        if (!best || score > best.score) best = { x, z, score };
      }
    }
    void kind;
    return best || { x: 200, z: -1500, score: 0 };
  }

  /* --------------------------------------------------------------- frame */

  update(dt) {
    const ctx = this.ctx;
    if (!this.mesh) return;
    const env = ctx.env;

    this.uniforms.uLodCam.value.copy(ctx.camera.position);
    this.clip.select(ctx.camera);

    /* surface response to weather */
    const u = this.uniforms.uSurf.value;
    u.x = env.wetness;
    u.y = env.snowCover;
    u.z = this.snowLine;

    /*
     * Puddles fill and dry on their own clock. Rain raises the water table in
     * seconds; evaporation takes minutes, which is why a western street stays
     * churned and shining long after the storm has moved off. Seeded from the
     * current wetness on the first frame so a capture that starts in the rain
     * does not have to wait out the fill.
     */
    const wet = env.wetness;
    if (this._pond === undefined) this._pond = wet;
    const rate = wet > this._pond ? 0.55 : 0.022;
    this._pond += (wet - this._pond) * (1 - Math.exp(-rate * dt));
    const wp = this.uniforms.uWetP.value;
    wp.x = this._pond;

    /*
     * The sky radiance standing water reflects. There is no environment map in
     * this scene, so this is the only way a puddle can show anything but the
     * sun. Ambient colour x intensity is the diffuse sky irradiance; a mirror
     * sees the radiance, which is brighter by roughly pi/2 for a hemisphere
     * this smooth, and warms toward the sun near the horizon.
     */
    const a = env.ambientColor, sc = env.sunColor;
    const k = env.ambientIntensity * 1.55;
    const warm = 0.16 * (env.daylight === undefined ? 1 : env.daylight);
    this.uniforms.uSkyRefl.value.setRGB(
      (a.r * (1 - warm) + sc.r * warm) * k,
      (a.g * (1 - warm) + sc.g * warm) * k,
      (a.b * (1 - warm) + sc.b * warm) * k);

    /*
     * Drifting cloud shadows. An empty plain under a perfectly even key light
     * is the loudest "this is a render" tell there is; a shadow crawling
     * across it is the cheapest possible fix. Driven by the same coverage and
     * wind the Clouds/Weather systems publish, so it stays in step with the
     * sky even though the mask itself is local.
     */
    const cs = this.uniforms.uCloudSh.value;
    const cover = clamp(env.cloudCover * 1.15 - 0.05, 0, 1);
    cs.x = clamp(cover * 1.5, 0, 0.62) * (0.35 + 0.65 * env.daylight);
    const wv = env.windVector;
    this._cloudOffX = (this._cloudOffX || 0) - wv.x * dt * 3.4;
    this._cloudOffZ = (this._cloudOffZ || 0) - wv.z * dt * 3.4;
    cs.z = this._cloudOffX;
    cs.w = this._cloudOffZ;

    /* Distance haze belongs to Sky: it registers injectAerialPerspective
       through registerMaterialUser, and running our own fog on top would
       double-count the extinction and turn every vista to milk. */

    /* long-range terrain self-shadowing follows the sun, amortised */
    this._sunTimer += dt;
    if (this._sunTimer > 0.25) { this._sunTimer = 0; this._updateSunShadow(false); }
  }

  dispose() {
    const ctx = this.ctx;
    if (this.mesh) ctx.scene.remove(this.mesh);
    if (this.clip) this.clip.dispose();
    for (const m of this._materials) m.dispose();
    for (const t of [this.heightTex, this.backTex, this.nrmAOTex, this.splatArrTex,
      this.sunShadowTex, this.albArray, this.nrmArray,
      this.macroTex, this.groundDetailTex]) if (t) t.dispose();
  }
}

export { RIVER_PTS };
