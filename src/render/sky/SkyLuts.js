import * as THREE from 'three';
import { ATMO_GLSL_CONSTANTS, ATMO_GLSL_COMMON } from './Atmosphere.js';

/**
 * RED SANDS — Hillaire-style atmosphere LUT chain.
 *
 *   1. transmittance LUT   (256 x 64)   — built once at init
 *   2. multiple-scattering (32 x 32)    — built once at init
 *   3. sky-view LUT        (384 x 216)  — re-rendered every frame:
 *        pass A = sun scattering (opaque write)
 *        pass B = moon scattering (additive) so night skies get a real
 *                 Rayleigh-blue moon glow instead of a flat tint.
 *
 * All three live in RGBA16F when EXT_color_buffer_float is available, and fall
 * back to a range-compressed RGBA8 encoding otherwise.
 */

const TLUT_W = 256, TLUT_H = 64;
const MLUT_W = 32, MLUT_H = 32;

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

function defines(skyW, skyH, steps) {
  return `
#define RS_TLUT_W ${TLUT_W}
#define RS_TLUT_H ${TLUT_H}
#define RS_MLUT_W ${MLUT_W}
#define RS_MLUT_H ${MLUT_H}
#define RS_SKY_W ${skyW}
#define RS_SKY_H ${skyH}
#define RS_SKY_STEPS ${steps}
`;
}

/* --------------------------------------------------------- transmittance */

const TRANSMITTANCE_FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform float uMieMul;
RS_HEADER

void main() {
  float r, mu;
  rsTransmittanceRMu(vUv, r, mu);
  float d = rsDistToTop(r, mu);
  const int N = 40;
  float dt = d / float(N);
  vec3 od = vec3(0.0);
  for (int i = 0; i < N; i++) {
    float t = (float(i) + 0.5) * dt;
    float ri = sqrt(max(r * r + t * t + 2.0 * r * t * mu, 0.0));
    vec3 rayS; float mieS; vec3 ext;
    rsSampleMedium(ri - RS_GROUND_R, uMieMul, rayS, mieS, ext);
    od += ext * dt;
  }
  gl_FragColor = vec4(RS_ENCODE(exp(-od)), 1.0);
}
`;

/* ---------------------------------------------------- multiple scattering */

const MULTISCATTER_FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D uTransmittance;
uniform float uMieMul;
RS_HEADER

vec3 rsTransmittance(float r, float mu) {
  return RS_DECODE(texture2D(uTransmittance, rsTransmittanceUv(r, mu)));
}

void main() {
  float u = rsUvToUnit(vUv.x, float(RS_MLUT_W));
  float v = rsUvToUnit(vUv.y, float(RS_MLUT_H));
  float muS = clamp(u * 2.0 - 1.0, -1.0, 1.0);
  float r = mix(RS_GROUND_R, RS_TOP_R, clamp(v, 0.0, 1.0));
  r = clamp(r, RS_GROUND_R + 0.002, RS_TOP_R - 0.002);

  vec3 sunDir = vec3(0.0, muS, rsSafeSqrt(1.0 - muS * muS));
  vec3 origin = vec3(0.0, r, 0.0);

  const int SQ = 8;
  const int STEPS = 20;
  const float uniformPhase = 1.0 / (4.0 * RS_PI);

  vec3 lumTotal = vec3(0.0);
  vec3 fmsTotal = vec3(0.0);

  for (int i = 0; i < SQ; i++) {
    for (int j = 0; j < SQ; j++) {
      float ra = (float(i) + 0.5) / float(SQ);
      float rb = (float(j) + 0.5) / float(SQ);
      float theta = 2.0 * RS_PI * ra;
      float phi = rsSafeAcos(1.0 - 2.0 * rb);
      float sp = sin(phi);
      vec3 dir = vec3(cos(theta) * sp, cos(phi), sin(theta) * sp);

      float mu0 = dot(normalize(origin), dir);
      float tGround = rsHitsGround(r, mu0) ? rsDistToGround(r, mu0) : -1.0;
      float tMax = tGround > 0.0 ? tGround : rsDistToTop(r, mu0);

      vec3 L = vec3(0.0);
      vec3 fms = vec3(0.0);
      vec3 tp = vec3(1.0);

      for (int s = 0; s < STEPS; s++) {
        float f0 = float(s) / float(STEPS);
        float f1 = float(s + 1) / float(STEPS);
        float t0 = f0 * f0 * tMax;
        float t1 = f1 * f1 * tMax;
        float dt = t1 - t0;
        if (dt <= 0.0) continue;
        vec3 p = origin + dir * (t0 + dt * 0.4);
        float ri = length(p);
        vec3 rayS; float mieS; vec3 ext;
        rsSampleMedium(ri - RS_GROUND_R, uMieMul, rayS, mieS, ext);
        vec3 st = exp(-ext * dt);
        vec3 safeExt = max(ext, vec3(1e-9));

        float muSi = dot(p, sunDir) / ri;
        vec3 sunT = rsTransmittance(ri, muSi) * rsPlanetShadow(p, sunDir);

        vec3 scat = rayS + vec3(mieS);
        vec3 S = scat * uniformPhase * sunT;
        L += tp * ((S - S * st) / safeExt);
        fms += tp * ((scat - scat * st) / safeExt);
        tp *= st;
      }

      if (tGround > 0.0) {
        vec3 p = origin + dir * tGround;
        float ri = length(p);
        float muSi = dot(p, sunDir) / ri;
        if (muSi > 0.0) {
          L += tp * rsTransmittance(ri, muSi) * muSi * RS_GROUND_ALBEDO / RS_PI;
        }
      }

      float w = (4.0 * RS_PI) / float(SQ * SQ);
      lumTotal += L * w;
      fmsTotal += fms * w;
    }
  }

  vec3 inScatter = lumTotal * uniformPhase;
  vec3 fms = fmsTotal * uniformPhase;
  vec3 psi = inScatter / max(1.0 - fms, vec3(1e-4));
  gl_FragColor = vec4(RS_ENCODE(psi), 1.0);
}
`;

/* -------------------------------------------------------------- sky-view */

const SKYVIEW_FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D uTransmittance;
uniform sampler2D uMultiScatter;
uniform vec3  uLightDir;
uniform vec3  uLightColor;
uniform float uMieMul;
uniform float uCamAltKm;
uniform float uGroundLit;
RS_HEADER

vec3 rsTransmittance(float r, float mu) {
  return RS_DECODE(texture2D(uTransmittance, rsTransmittanceUv(r, mu)));
}

void main() {
  float r = RS_GROUND_R + max(uCamAltKm, 0.0005);
  vec3 dir;
  rsSkyViewUvToDir(vUv, r, dir);
  vec3 origin = vec3(0.0, r, 0.0);
  float mu0 = dir.y;

  float tGround = rsHitsGround(r, mu0) ? rsDistToGround(r, mu0) : -1.0;
  float tMax = tGround > 0.0 ? tGround : rsDistToTop(r, mu0);
  if (tMax <= 0.0) { gl_FragColor = vec4(RS_ENCODE(vec3(0.0)), 1.0); return; }

  float cosT = dot(dir, uLightDir);
  float pR = rsRayleighPhase(cosT);
  float pM = rsMiePhase(cosT, RS_MIE_G);

  vec3 L = vec3(0.0);
  vec3 tp = vec3(1.0);

  for (int s = 0; s < RS_SKY_STEPS; s++) {
    float f0 = float(s) / float(RS_SKY_STEPS);
    float f1 = float(s + 1) / float(RS_SKY_STEPS);
    float t0 = f0 * f0 * tMax;
    float t1 = f1 * f1 * tMax;
    float dt = t1 - t0;
    if (dt <= 0.0) continue;
    vec3 p = origin + dir * (t0 + dt * 0.4);
    float ri = length(p);
    vec3 rayS; float mieS; vec3 ext;
    rsSampleMedium(ri - RS_GROUND_R, uMieMul, rayS, mieS, ext);
    vec3 st = exp(-ext * dt);
    vec3 safeExt = max(ext, vec3(1e-9));

    float muSi = dot(p, uLightDir) / ri;
    vec3 sunT = rsTransmittance(ri, muSi) * rsPlanetShadow(p, uLightDir);
    vec3 ms = RS_DECODE(texture2D(uMultiScatter, rsMultiScatterUv(ri, muSi)));

    vec3 S = (rayS * pR + vec3(mieS) * pM) * sunT
           + (rayS + vec3(mieS)) * ms;
    L += tp * ((S - S * st) / safeExt);
    tp *= st;
    if (max(tp.r, max(tp.g, tp.b)) < 2e-4) break;
  }

  if (tGround > 0.0 && uGroundLit > 0.0) {
    vec3 p = origin + dir * tGround;
    float ri = length(p);
    float muSi = dot(p, uLightDir) / ri;
    if (muSi > 0.0) {
      L += tp * rsTransmittance(ri, muSi) * muSi * RS_GROUND_ALBEDO / RS_PI * uGroundLit;
    }
  }

  gl_FragColor = vec4(RS_ENCODE(L * uLightColor), 1.0);
}
`;

/**
 * Tiny box-downsample of the sky-view LUT. Read back asynchronously so the CPU
 * side (fog colour, ambient irradiance, Clouds' horizon tint) can sample the
 * *actual* scattering solution instead of a cheap analytic stand-in.
 */
const PROBE_FS = /* glsl */`
precision highp float;
RS_HEADER
varying vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  vec3 c = vec3(0.0);
  for (int y = -1; y <= 2; y++) {
    for (int x = -1; x <= 2; x++) {
      c += RS_DECODE(texture2D(uSrc, vUv + vec2(float(x), float(y)) * uTexel));
    }
  }
  gl_FragColor = vec4(RS_ENCODE(c / 16.0), 1.0);
}
`;

export const PROBE_W = 48;
export const PROBE_H = 32;

export class SkyLuts {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{skyW:number, skyH:number, skySteps:number, float:boolean}} opts
   */
  constructor(renderer, opts) {
    this.renderer = renderer;
    this.skyW = opts.skyW;
    this.skyH = opts.skyH;
    this.float = opts.float !== false;

    const type = this.float ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const common = {
      type,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    };

    this.transmittance = new THREE.WebGLRenderTarget(TLUT_W, TLUT_H, {
      ...common, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    });
    this.multiScatter = new THREE.WebGLRenderTarget(MLUT_W, MLUT_H, {
      ...common, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    });
    this.skyView = new THREE.WebGLRenderTarget(this.skyW, this.skyH, {
      ...common, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping,
    });

    /*
     * AERIAL ATLAS — transmittance and multiple-scattering packed into ONE
     * texture, stacked vertically:
     *
     *     rows [0, TLUT_H)                  transmittance   (full 256 wide)
     *     rows [TLUT_H, TLUT_H + MLUT_H)    multiple scatter (first 32 columns)
     *
     * Sky's own LUT chain keeps using the two separate targets; this atlas
     * exists purely so that the aerial-perspective chunk injected into EVERY
     * lit material in the world spends one texture unit instead of two.
     *
     * That matters: the terrain program was linking 17 samplers on a GPU that
     * reports MAX_TEXTURE_IMAGE_UNITS = 16, so the driver rejected its draw
     * call outright (GL_INVALID_OPERATION, "mismatch between texture format
     * and sampler type") and the entire landscape silently failed to render.
     * Every sampler the shared chunks spend is a sampler no content system can.
     *
     * Both LUT uv helpers (rsTransmittanceUv / rsMultiScatterUv) inset by half
     * a texel via rsUnitToUv, so bilinear taps never reach across a region
     * boundary and no gutter is required.
     */
    this.aerialLut = new THREE.WebGLRenderTarget(TLUT_W, TLUT_H + MLUT_H, {
      ...common, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    });

    // Half-float targets store radiance directly; the RGBA8 fallback stores a
    // reversible range-compressed value so the LUT chain still works without
    // EXT_color_buffer_float.
    const codec = this.float
      ? '#define RS_ENCODE(c) (c)\n#define RS_DECODE(t) ((t).rgb)\n'
      : '#define RS_ENCODE(c) (sqrt((c)/((c)+vec3(1.0))))\n'
        + '#define RS_DECODE(t) (((t).rgb*(t).rgb)/max(vec3(1.0)-(t).rgb*(t).rgb, vec3(1e-3)))\n';
    const header = defines(this.skyW, this.skyH, opts.skySteps) + codec
      + ATMO_GLSL_CONSTANTS + ATMO_GLSL_COMMON;

    const mk = (fs, uniforms) => new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: fs.replace('RS_HEADER', header),
      depthTest: false,
      depthWrite: false,
      fog: false,
    });

    this.uMieMul = { value: 1.0 };

    this.matT = mk(TRANSMITTANCE_FS, { uMieMul: this.uMieMul });
    this.matM = mk(MULTISCATTER_FS, {
      uTransmittance: { value: this.transmittance.texture },
      uMieMul: this.uMieMul,
    });
    this.matS = mk(SKYVIEW_FS, {
      uTransmittance: { value: this.transmittance.texture },
      uMultiScatter: { value: this.multiScatter.texture },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uLightColor: { value: new THREE.Vector3(1, 1, 1) },
      uMieMul: this.uMieMul,
      uCamAltKm: { value: 0.1 },
      uGroundLit: { value: 1.0 },
    });

    this.probe = new THREE.WebGLRenderTarget(PROBE_W, PROBE_H, {
      ...common, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping,
    });
    this.matP = new THREE.ShaderMaterial({
      uniforms: {
        uSrc: { value: this.skyView.texture },
        uTexel: { value: new THREE.Vector2(1 / this.skyW, 1 / this.skyH) },
      },
      vertexShader: VERT,
      fragmentShader: PROBE_FS.replace('RS_HEADER', codec),
      depthTest: false,
      depthWrite: false,
      fog: false,
    });

    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.matT);
    this._quad.frustumCulled = false;
    this._scene = new THREE.Scene();
    this._scene.add(this._quad);
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._builtMie = -1;
  }

  _blit(target, material, additive) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    this._quad.material = material;
    material.blending = additive ? THREE.AdditiveBlending : THREE.NoBlending;
    material.transparent = !!additive;
    r.autoClear = !additive;
    r.setRenderTarget(target);
    r.render(this._scene, this._cam);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
  }

  /**
   * Blit a material into a sub-rectangle of a target, leaving the rest of the
   * target intact. The quad still spans NDC [-1,1] so vUv runs 0..1 across the
   * region, which is exactly what the LUT fragment shaders expect.
   */
  _blitRegion(target, material, x, y, w, h) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    /* The renderer's viewport/scissor are GLOBAL state that setRenderTarget
       re-applies, so they must be saved and put back verbatim — restoring them
       to this LUT's dimensions instead leaves the main pass rendering into a
       256x96 corner of the canvas. */
    const vp = this._tmpV4 || (this._tmpV4 = new THREE.Vector4());
    const sc = this._tmpS4 || (this._tmpS4 = new THREE.Vector4());
    r.getViewport(vp);
    r.getScissor(sc);
    const prevScissorTest = r.getScissorTest();

    this._quad.material = material;
    material.blending = THREE.NoBlending;
    material.transparent = false;
    r.autoClear = false;
    // setRenderTarget resets the viewport to the full target, so scope after it
    r.setRenderTarget(target);
    r.setViewport(x, y, w, h);
    r.setScissor(x, y, w, h);
    r.setScissorTest(true);
    r.render(this._scene, this._cam);

    r.setRenderTarget(prevTarget);
    r.setViewport(vp);
    r.setScissor(sc);
    r.setScissorTest(prevScissorTest);
    r.autoClear = prevAutoClear;
  }

  /** Rebuild the two static LUTs. Cheap enough to redo when turbidity moves. */
  buildStatic(mieMul) {
    this.uMieMul.value = mieMul;
    this._blit(this.transmittance, this.matT, false);
    this._blit(this.multiScatter, this.matM, false);
    // ...and the packed copy the shared aerial chunk samples (see constructor).
    this._blitRegion(this.aerialLut, this.matT, 0, 0, TLUT_W, TLUT_H);
    this._blitRegion(this.aerialLut, this.matM, 0, TLUT_H, MLUT_W, MLUT_H);
    this._builtMie = mieMul;
  }

  /** True when turbidity has drifted far enough to justify a rebuild. */
  needsStaticRebuild(mieMul) {
    return Math.abs(mieMul - this._builtMie) > 0.06;
  }

  /**
   * Render the per-frame sky-view LUT.
   * @param {THREE.Vector3} sunDir
   * @param {THREE.Vector3|null} moonDir
   * @param {THREE.Color|null} moonRadiance pre-scaled linear radiance of moonlight
   */
  renderSkyView(camAltKm, sunDir, sunRadiance, moonDir, moonRadiance) {
    const u = this.matS.uniforms;
    u.uCamAltKm.value = camAltKm;
    u.uLightDir.value.copy(sunDir);
    u.uLightColor.value.set(sunRadiance.r, sunRadiance.g, sunRadiance.b);
    u.uGroundLit.value = 1.0;
    this._blit(this.skyView, this.matS, false);

    if (moonDir && moonRadiance &&
        (moonRadiance.r + moonRadiance.g + moonRadiance.b) > 1e-5) {
      u.uLightDir.value.copy(moonDir);
      u.uLightColor.value.set(moonRadiance.r, moonRadiance.g, moonRadiance.b);
      u.uGroundLit.value = 0.35;
      this._blit(this.skyView, this.matS, true);
    }
    this._blit(this.probe, this.matP, false);
  }

  dispose() {
    this.transmittance.dispose();
    this.multiScatter.dispose();
    this.aerialLut.dispose();
    this.skyView.dispose();
    this.probe.dispose();
    this.matT.dispose();
    this.matM.dispose();
    this.matS.dispose();
    this.matP.dispose();
    this._quad.geometry.dispose();
  }
}

export const LUT_SIZES = { TLUT_W, TLUT_H, MLUT_W, MLUT_H };
