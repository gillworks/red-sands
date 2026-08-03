import * as THREE from 'three';

/**
 * Terrain shading.
 *
 * Built on MeshStandardMaterial so it inherits three's PBR, shadow receiving
 * and whatever the Lighting system does with cascades, then injected with:
 *   • CDLOD vertex displacement + morphing straight out of the FLOAT heightfield
 *   • baked splat weights → top-two layer blend, height-map interlocked
 *   • STOCHASTIC (triangle-lattice) tiling in the near field so the detail
 *     texture has no periodic repeat at all
 *   • triplanar projection with a hard exponent-8 blend so the top-down plane
 *     stops smearing fan-streaks down cliff faces
 *   • five UV scales: macro colour breakup (1300/430/150/78 m), base (~7 m),
 *     detail (~1.8 m, ~1.1 m on rock) and micro (~0.33 m inside 14 m)
 *   • warped, per-bed-hashed sedimentary strata on exposed bedrock only
 *   • drifting cloud shadows, wetness darkening, puddles, snow
 *   • long-range terrain sun shadow (a sweep the CSM can never reach)
 *
 * Distance haze is deliberately NOT done here — Sky.injectAerialPerspective is
 * registered through Terrain.registerMaterialUser and owns the veil.
 */

const LAYER_NAMES = [
  'grass_prairie', 'grass_dry', 'dirt_dry', 'rock_cliff', 'scree', 'sand_fine', 'snow',
];

/* Metres per texture tile, per layer. */
const LAYER_SCALE = [6.5, 7.4, 8.0, 12.5, 5.6, 9.5, 11.0];
/* Second (decimetre) tiling. Rock is deliberately ~1 m so cliff faces catch a
   specular break under a low sun instead of reading as a soft brown blur. */
const DETAIL_SCALE = [1.7, 1.9, 2.0, 1.1, 1.35, 2.2, 2.6];
/* Third (millimetre-to-centimetre) tiling, faded in over the first ~14 m. */
const MICRO_SCALE = 0.33;

/**
 * Art direction lives here. Whatever ProcTextures hands over, each terrain
 * layer is re-tinted to a target mid-tone drawn from the late-19th-century
 * western palette: bleached ochre, sage green (desaturated and yellow-shifted,
 * never emerald), dust grey and oxidised red rock. Per-texel variation is
 * preserved — only the mean is moved.
 *
 * The two grass tints sit at ~0.21 saturation with hues of 80deg and 45deg —
 * sage and straw, not lawn. Pass 1 measured 0.43 on screen at a single flat
 * hue, which §5 rejects outright; the pair now measures ~0.30 on screen with
 * the field mixed between them by the macro mask.
 */
const LAYER_TINT = [
  [105, 113, 89],    // grass_prairie — sage, sat 0.212, hue 80deg
  [146, 138, 113],   // grass_dry     — bleached straw, sat 0.226, hue 45deg
  [128, 117, 104],   // dirt_dry      — dusty ochre, sat 0.188
  [114, 93, 80],     // rock_cliff    — oxidised red rock, sat 0.298, darker
  [110, 105, 99],    // scree         — dark gravel lag / talus, sat 0.100
  [151, 144, 129],   // sand_fine     — pale bleached, sat 0.146
  [222, 226, 234],   // snow
];

/* ------------------------------------------------------------ layer arrays */

function boxDown(src, sw, dw, ch = 4) {
  if (sw === dw) return src;
  const out = new Uint8Array(dw * dw * ch);
  const f = sw / dw;
  for (let y = 0; y < dw; y++) {
    for (let x = 0; x < dw; x++) {
      const sx0 = (x * f) | 0, sy0 = (y * f) | 0;
      const sx1 = Math.min(sw, ((x + 1) * f) | 0), sy1 = Math.min(sw, ((y + 1) * f) | 0);
      for (let c = 0; c < ch; c++) {
        let s = 0, n = 0;
        for (let sy = sy0; sy < Math.max(sy1, sy0 + 1); sy++) {
          for (let sx = sx0; sx < Math.max(sx1, sx0 + 1); sx++) {
            s += src[(sy * sw + sx) * ch + c]; n++;
          }
        }
        out[(y * dw + x) * ch + c] = s / n;
      }
    }
  }
  return out;
}

/**
 * Pack the seven terrain surfaces into two array textures so the whole splat
 * costs two samplers instead of twenty-eight.
 */
export function buildLayerArrays(proc, size = 512, aniso = 8) {
  const L = LAYER_NAMES.length;
  const alb = new Uint8Array(size * size * 4 * L);
  const nrm = new Uint8Array(size * size * 4 * L);
  const px = size * size * 4;

  for (let l = 0; l < L; l++) {
    let set = null;
    try { set = proc && proc.get ? proc.get(LAYER_NAMES[l]) : null; } catch (e) { set = null; }
    if (!set) continue;
    const S = set.size;
    const a = boxDown(set.map.image.data, S, size);
    const n = boxDown(set.normalMap.image.data, S, size);
    const r = boxDown(set.roughnessMap.image.data, S, size);
    const o = set.aoMap ? boxDown(set.aoMap.image.data, S, size) : null;

    /* re-tint to the art-directed mid-tone, keeping the texture's variation */
    const tint = LAYER_TINT[l] || [128, 128, 128];
    const mean = [0, 0, 0];
    const npx = size * size;
    for (let i = 0; i < npx; i++) {
      mean[0] += a[i * 4]; mean[1] += a[i * 4 + 1]; mean[2] += a[i * 4 + 2];
    }
    const gain = [
      tint[0] / Math.max(1, mean[0] / npx),
      tint[1] / Math.max(1, mean[1] / npx),
      tint[2] / Math.max(1, mean[2] / npx),
    ];

    for (let i = 0; i < size * size; i++) {
      const d = l * px + i * 4;
      alb[d] = Math.min(255, a[i * 4] * gain[0]);
      alb[d + 1] = Math.min(255, a[i * 4 + 1] * gain[1]);
      alb[d + 2] = Math.min(255, a[i * 4 + 2] * gain[2]);
      alb[d + 3] = o ? o[i * 4] : 255;
      nrm[d] = n[i * 4];
      nrm[d + 1] = n[i * 4 + 1];
      nrm[d + 2] = r[i * 4];
      nrm[d + 3] = o ? o[i * 4] : 255;
    }
  }

  const mk = (data, srgb) => {
    const t = new THREE.DataArrayTexture(data, size, size, L);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = aniso;
    t.needsUpdate = true;
    return t;
  };
  return { albArray: mk(alb, true), nrmArray: mk(nrm, false) };
}

/* ---------------------------------------------------------------- shaders */

const VERT_PARS = /* glsl */`
uniform highp sampler2D uHeightTex;
uniform highp sampler2D uBackTex;
uniform vec4 uCore;      // x = half core size, y = core res, z = blendStart, w = blendEnd
uniform vec2 uBack;      // x = half backdrop size, y = backdrop res
uniform float uGridN;
uniform vec3 uLodCam;    // main camera position — NOT the shadow camera
attribute vec2 aOrigin;
attribute vec4 aParams;  // size, morphStart, 1/morphRange, skirtDepth
varying vec3 vWorldPos;
varying float vViewDist;

float tFetchBilinear(highp sampler2D tex, vec2 wp, float half_, float R) {
  vec2 t = (wp + half_) / (2.0 * half_) * R - 0.5;
  vec2 fl = floor(t);
  vec2 fr = t - fl;
  vec2 c0 = clamp(fl, vec2(0.0), vec2(R - 1.0));
  vec2 c1 = clamp(fl + 1.0, vec2(0.0), vec2(R - 1.0));
  ivec2 b0 = ivec2(c0);
  ivec2 b1 = ivec2(c1);
  float h00 = texelFetch(tex, ivec2(b0.x, b0.y), 0).r;
  float h10 = texelFetch(tex, ivec2(b1.x, b0.y), 0).r;
  float h01 = texelFetch(tex, ivec2(b0.x, b1.y), 0).r;
  float h11 = texelFetch(tex, ivec2(b1.x, b1.y), 0).r;
  return mix(mix(h00, h10, fr.x), mix(h01, h11, fr.x), fr.y);
}

float tSampleHeight(vec2 wp) {
  float e = max(abs(wp.x), abs(wp.y));
  float k = smoothstep(uCore.z, uCore.w, e);
  if (k <= 0.0) return tFetchBilinear(uHeightTex, wp, uCore.x, uCore.y);
  float hb = tFetchBilinear(uBackTex, wp, uBack.x, uBack.y);
  if (k >= 1.0) return hb;
  return mix(tFetchBilinear(uHeightTex, wp, uCore.x, uCore.y), hb, k);
}
`;

const VERT_BEGIN = /* glsl */`
  vec2 g = position.xz;
  float skirt = position.y;
  vec2 wp = aOrigin + g * aParams.x;
  float camD = length(wp - uLodCam.xz);
  float morph = clamp((camD - aParams.y) * aParams.z, 0.0, 1.0);
  vec2 frc = fract(g * (uGridN * 0.5)) * (2.0 / uGridN);
  wp -= frc * aParams.x * morph;
  float terrH = tSampleHeight(wp);
  vec3 transformed = vec3(wp.x, terrH - skirt * aParams.w, wp.y);
  vWorldPos = vec3(wp.x, terrH, wp.y);
  vViewDist = length(uLodCam - transformed);
`;

const FRAG_PARS = /* glsl */`
uniform sampler2D uNrmAO;     // RG = normal xz (16F, unquantised), B = skyAO, A = curvature
/*
 * splat A / splat B / control packed as three layers of ONE array texture.
 * A MeshStandardMaterial in this scene already spends samplers on the shadow
 * cascades, the local-light shadow maps and Sky's sky-view LUT; at nine of my
 * own the program blew MAX_TEXTURE_IMAGE_UNITS(16) and refused to link. Six is
 * a safe budget and costs nothing — the layers are the same size and format.
 */
uniform highp sampler2DArray uSplat;
uniform sampler2D uSunShadow;
uniform sampler2D uMacro;
uniform highp sampler2DArray uAlb;
uniform highp sampler2DArray uNrmRgh;
uniform vec4 uCore;
uniform float uLayerScale[7];
uniform float uLayerDetail[7];
uniform vec4 uSurf;        // wetness, snowCover, snowLine, normalStrength
uniform vec2 uDetailFade;  // near, far
uniform vec4 uCloudSh;     // strength, 1/scale, offsetX, offsetZ
/* eye-level ground layer — see terrain/GroundDetail.js */
uniform sampler2D uGroundDet;
uniform vec4 uGrndP;       // 1/fineTile(m), 1/midTile(m), strength, fine fade far
uniform vec4 uWetP;        // pondLevel, mid fade far, puddle depth scale, unused
uniform vec3 uSkyRefl;     // linear sky radiance seen in standing water
varying vec3 vWorldPos;
varying float vViewDist;

vec3 gTerrainNormal;
vec3 gPuddleRefl;
float gTerrainRough;
float gTerrainAO;
float gSunVis;
float gHexAmt;

const vec3 RS_LUMA = vec3(0.2126, 0.7152, 0.0722);

/* ------------------------------------------------- stochastic (hex) tiling */
/*
 * A single texture tiled on a regular grid always shows its period; pass 1's
 * plain read as a comb repeating every ~70 px. Here the plane is covered by a
 * triangular lattice, each cell gets a hash offset into the texture, and the
 * three cells meeting at a point are blended by their barycentric weights
 * cubed (so the cross-fade band is narrow and contrast survives). There is no
 * period left to see. The offsets are scaled by gHexAmt, which falls to zero
 * beyond ~380 m — at that range one tile is sub-pixel, so the extra two taps
 * would buy nothing, and with a zero offset the three taps collapse to one.
 */
vec2 rsHash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}

void rsTriGrid(vec2 p, out vec2 v1, out vec2 v2, out vec2 v3, out vec3 w) {
  vec2 sk = vec2(p.x - p.y * 0.57735027, p.y * 1.15470054);
  vec2 b = floor(sk);
  vec3 t = vec3(fract(sk), 0.0);
  t.z = 1.0 - t.x - t.y;
  if (t.z > 0.0) {
    w = vec3(t.z, t.y, t.x);
    v1 = b; v2 = b + vec2(0.0, 1.0); v3 = b + vec2(1.0, 0.0);
  } else {
    w = vec3(-t.z, 1.0 - t.y, 1.0 - t.x);
    v1 = b + vec2(1.0, 1.0); v2 = b + vec2(1.0, 0.0); v3 = b + vec2(0.0, 1.0);
  }
}

vec4 rsTile(highp sampler2DArray tex, float L, vec2 uv, vec2 dx, vec2 dy) {
  if (gHexAmt < 0.006) return textureGrad(tex, vec3(uv, L), dx, dy);
  vec2 v1, v2, v3; vec3 w;
  /* ~6 tiles per lattice cell: big enough that the cell boundaries are a
     low-frequency event on screen rather than a chicken-wire grid */
  rsTriGrid(uv * 0.17, v1, v2, v3, w);
  vec4 c1 = textureGrad(tex, vec3(uv + rsHash2(v1) * gHexAmt, L), dx, dy);
  vec4 c2 = textureGrad(tex, vec3(uv + rsHash2(v2) * gHexAmt, L), dx, dy);
  vec4 c3 = textureGrad(tex, vec3(uv + rsHash2(v3) * gHexAmt, L), dx, dy);
  w = w * w;
  w /= (w.x + w.y + w.z);
  return c1 * w.x + c2 * w.y + c3 * w.z;
}

/* Triplanar with a dominant-axis fast path. The exponent-8 weights mean a face
   steeper than ~40 degrees is almost purely X or Z projected, which is what
   stops the Y plane smearing vertical fans down a mesa.
   Only the DOMINANT layer's base tap pays for stochastic tiling — that is the
   one whose period you can actually see; the second layer and the detail /
   micro octaves are already broken up by the blend mask and by each other. */
vec4 sampleArrHex(highp sampler2DArray tex, float L, vec3 wp, vec3 bw, float inv,
                  vec3 ddx, vec3 ddy) {
  if (bw.y > 0.982) return rsTile(tex, L, wp.xz * inv, ddx.xz * inv, ddy.xz * inv);
  if (bw.x > 0.982) return rsTile(tex, L, wp.zy * inv, ddx.zy * inv, ddy.zy * inv);
  if (bw.z > 0.982) return rsTile(tex, L, wp.xy * inv, ddx.xy * inv, ddy.xy * inv);
  vec4 cy = textureGrad(tex, vec3(wp.xz * inv, L), ddx.xz * inv, ddy.xz * inv);
  vec4 cx = textureGrad(tex, vec3(wp.zy * inv, L), ddx.zy * inv, ddy.zy * inv);
  vec4 cz = textureGrad(tex, vec3(wp.xy * inv, L), ddx.xy * inv, ddy.xy * inv);
  return cx * bw.x + cy * bw.y + cz * bw.z;
}

vec4 sampleArr(highp sampler2DArray tex, float L, vec3 wp, vec3 bw, float inv,
               vec3 ddx, vec3 ddy) {
  if (bw.y > 0.982) return textureGrad(tex, vec3(wp.xz * inv, L), ddx.xz * inv, ddy.xz * inv);
  if (bw.x > 0.982) return textureGrad(tex, vec3(wp.zy * inv, L), ddx.zy * inv, ddy.zy * inv);
  if (bw.z > 0.982) return textureGrad(tex, vec3(wp.xy * inv, L), ddx.xy * inv, ddy.xy * inv);
  vec4 cy = textureGrad(tex, vec3(wp.xz * inv, L), ddx.xz * inv, ddy.xz * inv);
  vec4 cx = textureGrad(tex, vec3(wp.zy * inv, L), ddx.zy * inv, ddy.zy * inv);
  vec4 cz = textureGrad(tex, vec3(wp.xy * inv, L), ddx.xy * inv, ddy.xy * inv);
  return cx * bw.x + cy * bw.y + cz * bw.z;
}

vec2 rsRot(vec2 p, float c, float s) { return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }

void terrainSurface() {
  vec3 wp = vWorldPos;
  vec2 cuv = (wp.xz + uCore.x) / (2.0 * uCore.x);
  vec2 cuvc = clamp(cuv, 0.0008, 0.9992);

  /* Normal comes out of a 16-bit-float map baked by central difference from the
     Float32 heightfield. Pass 1 stored it in RGBA8, whose 1/255 quantisation
     stepped visibly across smooth slopes and read as blocky terracing. */
  vec4 nA = texture2D(uNrmAO, cuvc);
  vec3 macroN = normalize(vec3(nA.x, sqrt(max(1e-4, 1.0 - nA.x * nA.x - nA.y * nA.y)), nA.y));
  float skyAO = nA.z;
  float curv = nA.w;

  vec4 ctrl = texture(uSplat, vec3(cuvc, 2.0));
  float flow = ctrl.r;
  float arid = ctrl.g;
  float concave = ctrl.b;
  /* mip-safe steepness (rise/run * 1/1.6) — survives distance where the
     averaged normal does not */
  float steepK = smoothstep(0.30, 0.62, ctrl.a);

  vec4 sA = texture(uSplat, vec3(cuvc, 0.0));
  vec2 sB = texture(uSplat, vec3(cuvc, 1.0)).rg;

  /* Outside the authored core the splat data is undefined — fall back to a
     dry rock/grass mix so the backdrop still reads as landscape. */
  float ex = max(abs(cuv.x - 0.5), abs(cuv.y - 0.5)) * 2.0;
  float outside = smoothstep(0.90, 1.0, ex);

  /* ---- macro colour breakup ------------------------------------------------
     Three octaves of world-space fBm at 1300 m / 430 m / 150 m, each sampled
     through a different rotation so their tile periods never line up and the
     plain has no repeat you can find. This is what turns a flat green field
     into a landscape: dry patches, soil showing through, grazing and drainage
     patterning at metre-to-hectare scale. */
  vec2 p1 = rsRot(wp.xz, 0.9553, 0.2955) * (1.0 / 1300.0);
  vec2 p2 = rsRot(wp.xz, -0.3624, 0.9320) * (1.0 / 430.0);
  vec2 p3 = rsRot(wp.xz, -0.7597, -0.6503) * (1.0 / 150.0);
  /* One fetch per octave, not per channel: pass 3 read p2 twice (.g and .a)
     and p3 twice (.b here, .rg again for the domain warp below), which is two
     dependent texture fetches per pixel of the whole frame for nothing. */
  float mBig = texture2D(uMacro, p1).r;
  vec4 M2 = texture2D(uMacro, p2);
  vec4 M3 = texture2D(uMacro, p3);
  float mMid = M2.g;
  float mSml = M3.b;
  /*
   * PASS 4: the fourth octave used to be a fourth FETCH, at 1/78 m. It existed
   * because without it the whole near field sat inside a single cell of the
   * 150 m octave and the foreground came out one flat colour — but the near
   * field is now carried by the eye-level ground layer below, which resolves
   * detail four orders of magnitude finer than an 78 m fBm ever could. The
   * octave keeps its job of decorrelating the mid-range masks, taken from a
   * channel of the 150 m fetch that is already in registers. Measured at
   * 1920x1080/ultra this pays for most of the ground layer's two taps.
   */
  float mTin = M3.a;
  float mHue = M2.a * 0.70 + M3.r * 0.30;

  /* blend-edge jitter, read out of the same breakup tile at two much higher
     world frequencies (rotated so it cannot line up with the macro octaves) */
  vec4 nMid  = texture2D(uMacro, rsRot(wp.xz, 0.6216, 0.7833) * (1.0 / 33.0));
  vec4 nFine = texture2D(uMacro, rsRot(wp.xz, -0.9111, 0.4122) * (1.0 / 7.4));

  float w[7];
  w[0] = sA.r; w[1] = sA.g; w[2] = sA.b; w[3] = sA.a; w[4] = sB.r; w[5] = sB.g; w[6] = 0.0;
  if (outside > 0.0) {
    float steepO = 1.0 - smoothstep(0.55, 0.95, macroN.y);
    w[1] = mix(w[1], 0.55 * (1.0 - steepO), outside);
    w[3] = mix(w[3], 0.30 + steepO * 0.6, outside);
    w[4] = mix(w[4], 0.25, outside);
    w[0] = mix(w[0], 0.05, outside);
    w[2] = mix(w[2], 0.15, outside);
    w[5] = mix(w[5], 0.05, outside);
  }

  /* Sage vs straw across the field, driven by the macro mask rather than one
     flat green. Total grass is preserved, so world.getSurface() still agrees. */
  float gTot = w[0] + w[1];
  if (gTot > 0.001) {
    /* Pulled toward the middle before the noise is added: if the baked ratio is
       0 or 1 the macro mask has nothing to swing and the whole province comes
       out one flat colour, which is exactly what "no macro variation" meant. */
    float dryF = clamp(mix(w[1] / gTot, 0.46, 0.45)
      + (mMid - 0.5) * 1.9 + (mBig - 0.5) * 1.4
      + (mSml - 0.5) * 1.0 + (mTin - 0.5) * 0.9, 0.0, 1.0);
    w[0] = gTot * (1.0 - dryF);
    w[1] = gTot * dryF;
  }

  /* --- snow accumulates on up-facing slopes above the snow line */
  float upness = smoothstep(0.40, 0.84, macroN.y);
  float snowW = uSurf.y * upness
    * smoothstep(uSurf.z - 190.0, uSurf.z + 120.0, wp.y)
    * (1.0 - flow * 0.65)
    * clamp(0.45 + mSml * 1.1, 0.0, 1.35);
  snowW = clamp(snowW, 0.0, 1.0);
  for (int i = 0; i < 6; i++) w[i] *= (1.0 - snowW);
  w[6] = snowW;

  /* --- break every boundary with noise so nothing reads as a lerp.
         The fine band has to die away with distance or it turns into moire
         stripes across the whole middle ground once a 6 m feature is smaller
         than a pixel. */
  float ns[7];
  ns[0] = nMid.r; ns[1] = nMid.g; ns[2] = nMid.b; ns[3] = nMid.a;
  ns[4] = nFine.r; ns[5] = nFine.g; ns[6] = nFine.b;
  float nb[7];
  nb[0] = mSml; nb[1] = mMid; nb[2] = mBig; nb[3] = mHue;
  nb[4] = mSml; nb[5] = mMid; nb[6] = mBig;
  float nearK = 1.0 - smoothstep(90.0, 1100.0, vViewDist);
  for (int i = 0; i < 7; i++) {
    w[i] *= 0.50 + 1.05 * mix(mix(nb[i], ns[i], nearK), nb[i], 0.45);
  }

  int i1 = 1; int i2 = 0;
  float w1 = -1.0; float w2 = -1.0;
  for (int i = 0; i < 7; i++) {
    float v = w[i];
    if (v > w1) { w2 = w1; i2 = i1; w1 = v; i1 = i; }
    else if (v > w2) { w2 = v; i2 = i; }
  }
  float t = w2 / max(w1 + w2, 1e-4);
  t += (nFine.a - 0.5) * 0.42 * nearK + (nMid.a - 0.5) * 0.30 * mix(0.30, 1.0, nearK);
  t = smoothstep(0.18, 0.62, t);

  vec3 ddx = dFdx(wp);
  vec3 ddy = dFdy(wp);

  /*
   * UV domain warp. Stochastic tiling can only be afforded in the near field,
   * but a 2 m detail tile is still 11 screen pixels at 180 m — pass 2's first
   * attempt showed a dead-regular cross-hatch right through the midground.
   * Displacing the sampling position by a smooth pseudo-random vector field
   * (two octaves, ~150 m and ~47 m, amplitude ~1-2 tiles) means the tiling
   * drifts continuously instead of repeating on a lattice. The field's own
   * gradient is ~0.1, i.e. a 10% local stretch — invisible on rock and soil,
   * and it costs one texture fetch for every octave of every layer at once.

     PASS 4: the second octave used to be its own fetch at 1/47 m. nMid is
     already in registers at 1/33 m — near enough in scale that the warp is
     indistinguishable, and it buys back a dependent fetch on every pixel of
     the frame to spend on the ground layer below. */
  vec2 wq = wp.xz
    + (M3.rg - 0.5) * 7.2
    + (nMid.rg - 0.5) * 2.6;
  vec3 wt = vec3(wq.x, wp.y, wq.y);

  gHexAmt = 1.0 - smoothstep(140.0, 380.0, vViewDist);

  /* triplanar weights — exponent 8 so a steep face is single-projection */
  vec3 an = abs(macroN);
  an = an * an; an = an * an; an = an * an;
  vec3 bw = an / max(an.x + an.y + an.z, 1e-4);

  float s1 = 1.0 / uLayerScale[i1];
  float s2 = 1.0 / uLayerScale[i2];
  vec4 a1 = sampleArrHex(uAlb, float(i1), wt, bw, s1, ddx, ddy);
  vec4 a2 = sampleArr(uAlb, float(i2), wt, bw, s2, ddx, ddy);
  vec4 r1 = sampleArrHex(uNrmRgh, float(i1), wt, bw, s1, ddx, ddy);
  vec4 r2 = sampleArr(uNrmRgh, float(i2), wt, bw, s2, ddx, ddy);

  /* height-aware blend: the layer with more relief wins the contested band.
     Interlocking edges are what make layered materials read as materials
     rather than a cross-fade. */
  float hb = clamp((t - 0.5) * 2.0 + 0.5 + (a2.a - a1.a) * 0.8, 0.0, 1.0);
  hb = mix(t, hb, 0.85);

  vec3 alb = mix(a1.rgb, a2.rgb, hb);
  vec4 nr = mix(r1, r2, hb);

  /* --- decimetre detail, faded out with distance.
         The detail octave is sampled through a slowly-rotating world frame:
         its tiling then never stays in step with the base octave, so the two
         cannot beat together into the fixed-period comb pass 1 showed across
         the whole plain. Free — it is a 2x2 rotate, not an extra tap. */
  float detail = 1.0 - smoothstep(uDetailFade.x, uDetailFade.y, vViewDist);
  vec2 dn = vec2(0.0);
  if (detail > 0.004) {
    float sd = 1.0 / uLayerDetail[i1];
    float ra = (mBig - 0.5) * 5.0;
    float rc = cos(ra), rs = sin(ra);
    vec3 wpd = vec3(rsRot(wq, rc, rs), wp.y).xzy;
    vec3 dxd = vec3(rsRot(ddx.xz, rc, rs), ddx.y).xzy;
    vec3 dyd = vec3(rsRot(ddy.xz, rc, rs), ddy.y).xzy;
    vec4 ad = sampleArr(uAlb, float(i1), wpd, bw, sd, dxd, dyd);
    vec4 rd = sampleArr(uNrmRgh, float(i1), wpd, bw, sd, dxd, dyd);
    /* brightness-neutral: modulate by the detail's luminance RATIO so the
       detail fade cannot show up as a ring of brightness around the camera */
    float dl = dot(ad.rgb, vec3(0.3333));
    float ml = dot(a1.rgb, vec3(0.3333));
    alb *= mix(1.0, clamp(dl / max(ml, 0.004), 0.48, 1.95), detail * 0.78);
    dn = (rd.rg * 2.0 - 1.0) * detail * 1.05;
    nr.b = mix(nr.b, rd.b, detail * 0.35);
  }

  /* --- EYE-LEVEL GROUND LAYER ----------------------------------------------
     Replaces pass 3's "micro" octave, which re-sampled the *same* 512px layer
     texture at a 0.33 m tile: magnifying a 7 cm texel 20x adds no information,
     it only adds blur, and it needed anisotropy the driver would not give it.
     This is a purpose-built ground surface (pebbles, soil clumps, crack
     network, grain — see GroundDetail.js) tiled at ~0.6 m and ~2.9 m through
     two different rotations, so the near field gains real high-frequency
     content and the two octaves never beat into a period.

     Explicit gradients: these are inside non-uniform control flow, where an
     implicit-LOD fetch has undefined derivatives and mips at random. */
  vec3 Vdir = normalize(cameraPosition - wp);
  float flatK = smoothstep(0.45, 0.80, macroN.y);
  float gdMid = (1.0 - smoothstep(uWetP.y * 0.55, uWetP.y, vViewDist)) * flatK;
  /* The fine octave is gated on how square-on the surface is. At a grazing
     angle a 0.85 m tile needs far more anisotropy than it is given, so the tap
     returns a blur — and it is exactly there that an anisotropic fetch costs
     the most texel reads. Spend it only where it resolves. */
  float gdFine = (1.0 - smoothstep(uGrndP.w * 0.42, uGrndP.w, vViewDist)) * flatK
               * smoothstep(0.12, 0.44, abs(dot(Vdir, macroN)));
  float micH = 0.5;
  float stoneM = 0.0;
  if (gdMid > 0.004) {
    vec2 qm = rsRot(wq, 0.9284, -0.3716) * uGrndP.y;
    vec2 qmx = rsRot(ddx.xz, 0.9284, -0.3716) * uGrndP.y;
    vec2 qmy = rsRot(ddy.xz, 0.9284, -0.3716) * uGrndP.y;
    vec4 dM = textureGrad(uGroundDet, qm, qmx, qmy);
    micH = dM.b;
    stoneM = dM.a * 0.6 * gdMid;
    dn += (dM.rg * 2.0 - 1.0) * gdMid * uGrndP.z * 0.85;
    if (gdFine > 0.004) {
      vec2 qf = rsRot(wq, 0.5253, 0.8509) * uGrndP.x;
      vec2 qfx = rsRot(ddx.xz, 0.5253, 0.8509) * uGrndP.x;
      vec2 qfy = rsRot(ddy.xz, 0.5253, 0.8509) * uGrndP.x;
      vec4 dF = textureGrad(uGroundDet, qf, qfx, qfy);
      micH = mix(micH, micH * 0.42 + dF.b * 0.58, gdFine);
      stoneM = max(stoneM, dF.a * gdFine);
      dn += (dF.rg * 2.0 - 1.0) * gdFine * uGrndP.z;
    }
  }
  /* How much bare mineral ground is showing. Grass hides it; bedrock has its
     own strata and does not want a gravel lag scattered over it. */
  float bareK = clamp(1.0 - (w[0] + w[1]) * 0.72 - w[3] * 0.55, 0.14, 1.0);

  /* --- macro colour breakup ------------------------------------------------ */
  float macro = mBig * 0.34 + mMid * 0.29 + mSml * 0.22 + mTin * 0.15;
  macro = clamp((macro - 0.5) * 2.8 + 0.5, 0.0, 1.0);
  alb *= mix(0.62, 1.30, macro);
  /* Hue drift toward ochre where the ground is dry, toward cold slate where it
     is not. Normalised by its own luminance so it rotates hue WITHOUT adding
     brightness or chroma of its own — otherwise every "variation" term quietly
     drives the frame more saturated, which is how pass 1 ended up at 0.43. */
  /* Grass keeps more of its own chroma: it grows where the ground holds water,
     so it is the last thing that should be bleached to dust. */
  float grassW = clamp((w[0] + w[1]) * 1.25, 0.0, 1.0);
  float hueDrift = (mHue - 0.5) * 2.0 * (1.0 - grassW * 0.35);
  vec3 tint = mix(vec3(1.0), vec3(1.085, 1.005, 0.895), clamp(hueDrift, 0.0, 1.0) * 0.9)
            * mix(vec3(1.0), vec3(0.945, 0.995, 1.070), clamp(-hueDrift, 0.0, 1.0) * 0.75);
  alb *= tint / max(dot(tint, RS_LUMA), 1e-3);
  /* Sun-bleaching. Bleached means LESS chroma and MORE value — pass 1 pushed
     both up, which is why the desert measured as a saturated orange. */
  float bleach = arid * 0.44 * (1.0 - snowW) * (1.0 - grassW * 0.5);
  float aL0 = dot(alb, RS_LUMA);
  alb = mix(alb, mix(alb, vec3(aL0), 0.50) * 1.055, bleach);

  /* --- sedimentary strata on exposed bedrock -------------------------------
     Pass 1 drove this from world Y alone with one low-frequency phase offset,
     which drew dead-level contour lines across every landform. It is now
     (a) gated to genuinely steep bare rock, (b) evaluated on a tilted bedding
     plane, (c) warped by three octaves at 430 m / 150 m / 7 m so each bed's
     outcrop wanders by several bed thicknesses, and (d) given a per-bed hash
     so thickness and colour vary instead of running a pure sine. */
  float bare = clamp(w[3] * 1.35 + w[4] * 0.35, 0.0, 1.0)
             * max(steepK, smoothstep(0.94, 0.58, macroN.y));
  if (bare > 0.008) {
    float dipC = dot(wp, vec3(0.082, 1.0, -0.061));
    float warp = (mMid - 0.5) * 30.0 + (mSml - 0.5) * 11.0 + (nMid.a - 0.5) * 3.2;
    float band = (dipC + warp) * (1.0 / 8.5);
    float bi = floor(band);
    float fr = band - bi;
    float hsh = fract(sin(bi * 91.3457) * 43758.5453);
    float thick = mix(0.26, 0.72, fract(hsh * 7.13 + 0.37));
    float riser = smoothstep(thick - 0.16, thick + 0.07, fr);
    vec3 bandTint = mix(vec3(1.20, 0.975, 0.815), vec3(0.885, 0.925, 0.975), hsh);
    alb *= mix(vec3(1.0), bandTint * (0.84 + 0.32 * riser), bare * 0.95);
  }

  /* --- normal */
  vec2 nxy = (nr.rg * 2.0 - 1.0) + dn;
  vec3 upv = abs(macroN.y) < 0.985 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(upv, macroN));
  vec3 Bt = cross(macroN, T);
  vec3 N = normalize(macroN + (T * nxy.x + Bt * nxy.y) * uSurf.w);

  float rough = clamp(nr.b, 0.05, 1.0);
  float ao = mix(1.0, nr.a, 0.75) * mix(1.0, skyAO, 0.92);

  /* --- ground layer, albedo and roughness half.
         Applied here rather than up with the fetch so the macro breakup, the
         hue drift and the bleach cannot scale the stone highlights back down
         again — those chips are the brightest thing on the ground and they
         have to survive to the light. */
  if (gdMid > 0.004) {
    /* CLAMPED. uGrndP.z is the relief gain for the NORMAL, where >1 is exactly
       what is wanted; here it feeds mix() factors, and a factor above 1
       extrapolates past the endpoint instead of reaching it — at 1.8 the crack
       floors went to negative albedo. The normal keeps the full gain above; the
       tonal half saturates at one. */
    float k = min(gdMid * bareK * uGrndP.z, 1.0);
    /* The height field comes out of the bake normalised, so its histogram
       piles up around the middle; stretching it about 0.5 is what turns a
       soft mottle into soil you can see the structure of. */
    float micC = clamp((micH - 0.5) * 1.55 + 0.5, 0.0, 1.0);
    /* soil structure: crack floors and crevices darken, clump tops catch light.
       Both limbs are placed so the mean at micC = 0.5 is exactly 1.0 — a
       "detail" layer that quietly changes the ground's average brightness
       shows up as a halo around the camera, and it moves every luma metric. */
    alb *= mix(1.0, 0.42 + micC * 1.16, k * 0.92);
    /* Pale lag gravel — caliche, quartz and limestone chips. This is the one
       thing on the ground that is genuinely BRIGHT: high_noon_desert measured
       a 232 max channel (no highlight headroom anywhere in the frame) because
       nothing outdoors in that shot was lighter than bleached sand. Each chip
       gets its contact shadow from the height term above, which is what stops
       them reading as paint. */
    float st = stoneM * bareK;
    float sLum = dot(alb, RS_LUMA);
    /* Not every chip is the same stone: the ones sitting proud are bleached
       limestone, the ones half-buried in the soil are dark and wet-looking.
       A single flat "gravel" tint is the tell that it is a mask, not gravel. */
    /* PASS 11: was (2.35 + arid * 0.85), i.e. up to 3.2x the local luminance.
       With the ground layer's strength raised and its range extended, that put
       a scatter of clipped white specks across the near field of every daylight
       shot — the single_sun gate counts blobs over 0.965 luma and it went
       0 -> 4 in player_third_person. A caliche chip is a bright reflector, not a
       light source. */
    vec3 chip = mix(vec3(sLum) * 0.66,
                    mix(alb, vec3(sLum), 0.42) * (1.78 + arid * 0.55), micC);
    alb = mix(alb, chip, st * 0.86);
    rough = mix(rough, 0.44, st * 0.6);
    rough = clamp(rough + (0.5 - micC) * 0.30 * gdMid, 0.10, 1.0);
    /* micro-occlusion: the crack network and the gaps between stones are the
       only shadow the ground has at this scale. Mean-neutral, as above. */
    ao *= mix(1.0, 0.72 + micC * 0.56, k * 0.85);
  }

  /* --- surface honesty: dirt in the crevices, sun-bleach on the up-faces.
         The cavity term darkens AND desaturates; the bleach term lifts value
         and pulls chroma toward ochre. Both are a handful of instructions and
         together they are the difference between "weathered" and "printed". */
  float cavity = 1.0 - nr.a;
  float cavK = cavity * mix(0.30, 0.70, detail);
  float albL = dot(alb, RS_LUMA);
  alb = mix(alb, vec3(albL) * 0.70, cavK * 0.55);
  float upFace = pow(clamp(N.y, 0.0, 1.0), 4.0);
  alb = mix(alb, mix(alb, vec3(albL), 0.30) * vec3(1.10, 1.045, 0.945),
            upFace * (0.16 + arid * 0.24) * (1.0 - snowW));
  /* macro-scale terrain concavity collects silt and darkens */
  alb *= mix(1.0, 0.84, smoothstep(0.55, 0.95, curv));

  /* --- wetness: darkening everywhere, standing water in the low ground.
     PASS 4. The puddle mask used to be the 8 m control map alone, so "a
     puddle" was an 8-metre smudge of low roughness — no edge, no shape, and
     nothing at all on the flat ground the player is standing on. Water now
     fills the ground layer's own height field: micH is a real surface at
     centimetre scale, so the water line cuts an actual shoreline round the
     stones and floods the crack network first, exactly like the reference.
     uWetP.x is the LAGGED pond level — it climbs while it rains and falls
     over minutes afterwards, so puddles fill and dry instead of snapping with
     the weather state. A floor of it stays in the drainage channels in fair
     weather, because those never dry out. */
  float wet = uSurf.x;
  float channel = smoothstep(0.55, 0.95, flow);
  float pond = smoothstep(0.52, 0.94, concave) * smoothstep(0.72, 0.95, macroN.y);
  float basinK = max(pond, channel * 0.85) * smoothstep(0.80, 0.95, macroN.y);
  float level = max(uWetP.x * (0.17 + 0.46 * basinK), channel * channel * 0.13);
  float puddle = clamp((level - micH) * uWetP.z, 0.0, 1.0) * gdMid;
  /* Wet ground is DARKER AND MORE SATURATED everywhere, not only where water
     collects. Pass 2 gated the whole term on pond/channel, so a flat plain in
     a thunderstorm only lost 15% of its albedo and storm_plains rendered as a
     dry pale sand plain with rain drawn over it — the single largest reason
     that shot read as a whiteout. */
  alb *= mix(1.0, 0.56, wet);
  alb = mix(alb, alb * mix(vec3(1.0), vec3(0.90, 0.95, 1.02), 0.6), wet * 0.5);
  alb *= mix(1.0, 0.62, wet * 0.55 * max(pond, channel));
  alb *= mix(1.0, 0.72, channel * 0.55);
  /* under water the substrate is soaked through: dark, and its own texture
     goes soft because the water surface takes over the shading */
  alb *= mix(1.0, 0.44, puddle);
  rough = mix(rough, 0.045, puddle);
  rough = mix(rough, rough * 0.68, wet * 0.55);
  N = normalize(mix(N, vec3(0.0, 1.0, 0.0), puddle * 0.94));

  /* snow is smoother and brighter than anything under it */
  rough = mix(rough, 0.42, snowW * 0.7);

  /*
   * REAL REFLECTION IN THE STANDING WATER.
   *
   * There is no environment map in this scene, so a MeshStandardMaterial at
   * roughness 0.045 has an indirect specular of exactly zero — which is why
   * pass 3's puddles read as dark smears rather than water. A mirror-flat
   * surface reflects the sky, so evaluate that directly: Fresnel against the
   * flat water normal, times the sky radiance the Sky system publishes. The
   * sun glint on top of it comes free from the direct specular lobe, which is
   * genuinely sharp now that the roughness is this low.
   */
  gPuddleRefl = vec3(0.0);
  float sheen = puddle + wet * (1.0 - puddle) * 0.30 * smoothstep(0.55, 0.9, macroN.y);
  if (sheen > 0.01) {
    /* Grazing angles are where a wet surface actually shines, so the Fresnel
       has to be evaluated against the WATER normal (flat), not the perturbed
       soil normal underneath it. */
    float ct = clamp(dot(Vdir, mix(N, vec3(0.0, 1.0, 0.0), puddle)), 0.0, 1.0);
    float f = pow(1.0 - ct, 5.0);
    float F = 0.02 + 0.98 * f;
    gPuddleRefl = uSkyRefl * F * sheen;
  }

  gTerrainNormal = normalize((viewMatrix * vec4(N, 0.0)).xyz);
  gTerrainRough = rough;
  gTerrainAO = ao;

  /* --- terrain self-shadow sweep + drifting cloud shadows.
         An empty plain with perfectly even key light is the single loudest
         "this is a render" tell; a slow cloud shadow crossing it is the
         cheapest fix there is. */
  float sunVis = mix(1.0, texture2D(uSunShadow, cuvc).r, 1.0 - outside * 0.85);
  /* One fetch, not two: the second tap at 2.7x was buying a little edge
     detail on the shadow boundary for a dependent texture read on every
     terrain pixel in the frame. mBig is already in registers and breaks up
     the coverage at landscape scale, which is what actually reads. */
  if (uCloudSh.x > 0.001) {
    vec2 cp = (wp.xz + uCloudSh.zw) * uCloudSh.y;
    vec4 CS = texture2D(uMacro, cp);
    float cl = CS.a * 0.72 + CS.b * 0.28 + (mBig - 0.5) * 0.16;
    sunVis *= 1.0 - uCloudSh.x * smoothstep(0.40, 0.68, cl);
  }
  gSunVis = sunVis;

#ifdef TERRAIN_DEBUG_SPLAT
  /* diagnostic: which layer is actually being painted, as flat colour.
     prairie=green dry=yellow dirt=orange rock=red scree=grey sand=white */
  vec3 dbg[7];
  dbg[0] = vec3(0.10, 0.55, 0.14);
  dbg[1] = vec3(0.85, 0.80, 0.20);
  dbg[2] = vec3(0.80, 0.42, 0.10);
  dbg[3] = vec3(0.85, 0.12, 0.10);
  dbg[4] = vec3(0.45, 0.45, 0.50);
  dbg[5] = vec3(0.95, 0.95, 0.88);
  dbg[6] = vec3(0.30, 0.55, 0.95);
  alb = mix(dbg[i1], dbg[i2], hb);
#endif

  gDiffuse = alb;
}
`;

/**
 * Distance haze is NOT done here. `Sky.injectAerialPerspective` is registered
 * through `Terrain.registerMaterialUser`, and it applies the physically
 * correct LUT-driven veil (Rayleigh + Mie air mass, in-scatter taken from the
 * sky-view LUT in the exact view direction). Running our own fog on top of it
 * double-counts and turns every vista to milk.
 */

/* ----------------------------------------------------------------- factory */

/**
 * `?terrainDebug=splat` paints each fragment by the layer that won the splat,
 * which is the only honest way to answer "is there actually rock on that
 * mountain, or does the rock just look like dirt". Off by default and it costs
 * nothing when off — it is a compile-time define.
 */
function debugMode() {
  try {
    return new URLSearchParams(globalThis.location.search).get('terrainDebug') || '';
  } catch (e) { return ''; }
}

export function makeTerrainMaterial(uniforms, gridN) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    fog: false,
    dithering: true,
  });
  const dbg = debugMode() === 'splat';
  mat.defines = dbg
    ? { TERRAIN_CDLOD: '', TERRAIN_DEBUG_SPLAT: '' }
    : { TERRAIN_CDLOD: '' };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.uniforms.uGridN = { value: gridN };

    shader.vertexShader = VERT_PARS + shader.vertexShader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', VERT_BEGIN);

    shader.fragmentShader = 'vec3 gDiffuse;\n' + FRAG_PARS + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>',
        'terrainSurface();\n  diffuseColor.rgb = gDiffuse;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gTerrainRough;')
      .replace('#include <normal_fragment_begin>',
        'float faceDirection = 1.0;\n  vec3 normal = gTerrainNormal;\n  vec3 nonPerturbedNormal = normal;')
      .replace('#include <normal_fragment_maps>', '')
      .replace('#include <lights_fragment_end>',
        '#include <lights_fragment_end>\n'
        + '  reflectedLight.directDiffuse *= gSunVis;\n'
        + '  reflectedLight.directSpecular *= gSunVis;\n'
        + '  reflectedLight.indirectDiffuse *= gTerrainAO;\n'
        + '  reflectedLight.indirectSpecular *= gTerrainAO;')
      /* Standing water's sky reflection is added to the resolved lit colour.
         The `#include` marker is left in place because Sky's aerial-perspective
         injection chains after us and keys off the same line. */
      .replace('#include <opaque_fragment>',
        'outgoingLight += gPuddleRefl;\n#include <opaque_fragment>');

    mat.userData.shader = shader;
  };
  mat.customProgramCacheKey = () => 'terrain-cdlod-v3' + (dbg ? '-dbg' : '');
  return mat;
}

export function makeTerrainDepthMaterial(uniforms, gridN) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking });
  /* the shadow pass must never be veiled by aerial perspective */
  mat.userData.rsNoAerial = true;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.uniforms.uGridN = { value: gridN };
    shader.vertexShader = VERT_PARS + shader.vertexShader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <begin_vertex>', VERT_BEGIN);
  };
  mat.customProgramCacheKey = () => 'terrain-cdlod-depth-v2';
  return mat;
}

export { LAYER_NAMES, LAYER_SCALE, DETAIL_SCALE, MICRO_SCALE };
