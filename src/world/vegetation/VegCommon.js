import * as THREE from 'three';

/**
 * Shared GLSL + material plumbing for every piece of vegetation.
 *
 * DESIGN
 *  - All vegetation is drawn from `THREE.Mesh` + `THREE.InstancedBufferGeometry`
 *    with hand-rolled per-instance attributes rather than `InstancedMesh`, so the
 *    vertex shader owns the whole placement transform. That buys three things:
 *    (a) grass and undergrowth can be placed entirely on the GPU (a toroidally
 *    wrapped tile that follows the camera — zero CPU work per frame),
 *    (b) wind can be applied in world space before the instance transform, and
 *    (c) the LOD cross-fade is a per-pixel dither instead of a visible pop.
 *  - Every material is a real `MeshStandardMaterial`, so it inherits three's PBR,
 *    the CSM cascade injection from Lighting, and Sky's aerial perspective. We
 *    only ever patch it through `onBeforeCompile`, chaining onto whatever the
 *    other systems installed.
 *  - Because three's depth vertex shader has no `beginnormal_vertex` outside
 *    `USE_DISPLACEMENTMAP`, the placement maths lives in a function that writes
 *    to file-scope globals; the colour pass reads them from both the normal and
 *    the position hook, the depth pass only from the position hook.
 */

/* -------------------------------------------------------------- constants */

export const VEG_HASH = /* glsl */`
float vegHash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
vec3 vegHash31(float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
vec2 vegHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vegHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
/** Value noise, 0..1. */
float vegNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = vegHash12(i);
  float b = vegHash12(i + vec2(1.0, 0.0));
  float c = vegHash12(i + vec2(0.0, 1.0));
  float d = vegHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
/** Interleaved gradient noise — stable per pixel, good for dithered fades. */
float vegDither(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
mat2 vegRot(float a) {
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c);
}
`;

/**
 * Terrain queries. The height fetch is byte-for-byte the same bilinear
 * `texelFetch` the terrain vertex shader uses, so vegetation sits exactly on the
 * surface that is actually drawn instead of hovering or sinking.
 */
export const VEG_TERRAIN = /* glsl */`
uniform highp sampler2D uVegHeight;
uniform sampler2D uVegNrmAO;
uniform sampler2D uVegCtrl;
uniform vec4 uVegWorld;   // x half extent, y height res, z waterLevel, w unused
uniform vec4 uVegClear;   // xy centre XZ, z radius, w feather — see createVegUniforms

/**
 * 0 inside the clearing, 1 outside, feathered so the edge is not a stencil.
 * Multiplies the blade's scale, which both removes it and stops it popping.
 */
float vegClearing(vec2 wp) {
  if (uVegClear.z <= 0.0) return 1.0;
  return smoothstep(uVegClear.z, uVegClear.z + max(uVegClear.w, 0.05),
                    length(wp - uVegClear.xy));
}

/**
 * Ground height at a world position, bilinear — the same interpolation
 * 'world.getHeight' performs on the CPU, so a blade never floats or sinks.
 *
 * Two code paths for one reason: this runs once per VERTEX on every blade of
 * grass in the ring (order 1.5 M invocations at ultra). Where the driver can
 * filter a 32-bit float texture (OES_texture_float_linear, present on every
 * Metal/ANGLE target this ships to) one hardware-filtered fetch replaces four
 * manual texelFetches. The fallback is exact, not approximate, so the two paths
 * are interchangeable.
 */
float vegHeight(vec2 wp) {
  float hf = uVegWorld.x, R = uVegWorld.y;
#ifdef VEG_LINEAR_HEIGHT
  return texture(uVegHeight, clamp((wp + hf) / (2.0 * hf), 0.5 / R, 1.0 - 0.5 / R)).r;
#else
  vec2 t = (wp + hf) / (2.0 * hf) * R - 0.5;
  vec2 fl = floor(t);
  vec2 fr = t - fl;
  vec2 c0 = clamp(fl, vec2(0.0), vec2(R - 1.0));
  vec2 c1 = clamp(fl + 1.0, vec2(0.0), vec2(R - 1.0));
  ivec2 b0 = ivec2(c0);
  ivec2 b1 = ivec2(c1);
  float h00 = texelFetch(uVegHeight, ivec2(b0.x, b0.y), 0).r;
  float h10 = texelFetch(uVegHeight, ivec2(b1.x, b0.y), 0).r;
  float h01 = texelFetch(uVegHeight, ivec2(b0.x, b1.y), 0).r;
  float h11 = texelFetch(uVegHeight, ivec2(b1.x, b1.y), 0).r;
  return mix(mix(h00, h10, fr.x), mix(h01, h11, fr.x), fr.y);
#endif
}
vec2 vegUv(vec2 wp) { return (wp + uVegWorld.x) / (2.0 * uVegWorld.x); }
/**
 * xyz = surface normal, w = ambient occlusion.
 * Read from vegetation's OWN normal map rather than the terrain's: the terrain
 * is free to change its packing (it has already moved from RGBA8 to half-float
 * with a reconstructed ny), and a silent format change here would tilt every
 * blade of grass in the world.
 */
vec4 vegNrmAO(vec2 wp) {
  vec4 n = textureLod(uVegNrmAO, vegUv(wp), 0.0);
  return vec4(normalize(n.xyz * 2.0 - 1.0), n.w);
}
/** r = grass, g = forest, b = shrub, a = moisture. */
vec4 vegCtrl(vec2 wp) { return textureLod(uVegCtrl, vegUv(wp), 0.0); }
`;

/**
 * Wind. A coherent travelling wave over the whole field: three sines with
 * different wavelengths and phase speeds, sampled at the *world* position, so a
 * gust genuinely crosses the meadow as a band instead of everything breathing in
 * unison. Bending is quadratic in the height fraction (the stalk pivots at the
 * base, the tip travels furthest) and the vertical drop keeps the arc roughly
 * length-preserving so blades do not stretch.
 */
export const VEG_WIND = /* glsl */`
uniform vec4 uVegWind;   // xy = unit direction, z = strength m/s, w = gust 0..1
uniform float uVegTime;

float vegGust(vec2 wp) {
  vec2 d = uVegWind.xy;
  float sp = 2.2 + uVegWind.z * 0.55;
  float p = dot(wp, d);
  float w1 = sin(p * 0.055 - uVegTime * sp * 0.55);
  float w2 = sin(p * 0.170 - uVegTime * sp * 1.05 + 1.7);
  float w3 = sin(p * 0.640 - uVegTime * sp * 1.90 + 3.1);
  return w1 * 0.50 + w2 * 0.33 + w3 * 0.17;
}

/**
 * @param wp     world xz of the plant base
 * @param t      0..1 along the stalk
 * @param stiff  0 = limp, 1 = rigid
 * @param phase  per-instance phase offset
 * @param len    stalk length in metres (for arc-length compensation)
 * @param flut   0..1 multiplier on the fast flutter term. Callers damp this to
 *               zero with distance: at 30 m a blade is a couple of pixels wide
 *               and a 7 Hz jitter is not "life", it is the per-pixel boiling
 *               motion.py measures. The low-frequency gust term is untouched,
 *               so a distant meadow still moves as a mass.
 */
vec3 vegBend(vec2 wp, float t, float stiff, float phase, float len, float flut) {
  float g = vegGust(wp + vec2(phase * 37.0, phase * 91.0));
  float env = 0.42 + 0.58 * (g * 0.5 + 0.5);
  float base = (0.10 + uVegWind.z * 0.052) * (0.55 + 0.85 * uVegWind.w);
  // fast flutter so nothing nearby is ever perfectly still
  float flutter = sin(uVegTime * (5.1 + phase * 3.4) + phase * 30.0) * 0.085 * flut;
  float amp = (base * env + flutter * base) * (1.0 - stiff) * t * t;
  amp = min(amp, 0.62);
  vec2 off = uVegWind.xy * amp * len;
  float drop = amp * amp * 0.5 * len;
  return vec3(off.x, -drop, off.y);
}
`;

/* ------------------------------------------------------------- uniforms */

export function createVegUniforms() {
  return {
    uVegTime: { value: 0 },
    uVegCam: { value: new THREE.Vector3() },
    uVegCamFwd: { value: new THREE.Vector3(0, 0, -1) },
    uVegWind: { value: new THREE.Vector4(1, 0, 3, 0) },
    uVegHeight: { value: null },
    uVegNrmAO: { value: null },
    uVegCtrl: { value: null },
    uVegWorld: { value: new THREE.Vector4(4096, 2048, 18, 0) },
    uVegSun: { value: new THREE.Vector3(0, 1, 0) },
    uVegSunCol: { value: new THREE.Vector3(1, 1, 1) },
    uVegSeason: { value: 0.35 },
    /*
     * One hard clearing: xy = world XZ centre, z = radius (m), w = feather (m).
     * The biome map is ~16-32 m per texel, so it cannot carve anything at the
     * scale of a fire ring; this is evaluated per instance in the vertex
     * shader instead. Radius 0 disables it.
     *
     * Exists because grass was growing straight through the campfire — at
     * 0.2 m from the flame those blades are the brightest thing in night_camp
     * and they were what remained of the pass-1 "white blob" finding.
     */
    uVegClear: { value: new THREE.Vector4(0, 0, 0, 2.5) },
  };
}

/* ------------------------------------------------------- material patching */

/**
 * Inject placement / wind / tint GLSL into a built-in three material.
 * Chains onto whatever `onBeforeCompile` is already installed (Sky's aerial
 * perspective, Lighting's cascades) instead of clobbering it.
 *
 * @param {THREE.Material} material
 * @param {object} p
 * @param {string} p.vertexPars    declarations + `void vegPlace()` definition
 * @param {string} p.fragPars      fragment declarations
 * @param {string} p.fragBody      fragment code injected after <map_fragment>
 * @param {object} p.uniforms      uniform objects (shared by reference)
 * @param {object} p.defines
 * @param {boolean} p.depth        true when patching a MeshDepthMaterial
 */
export function injectVeg(material, {
  vertexPars = '', fragPars = '', fragBody = '', normalBody = '', lightsBody = '',
  uniforms = {}, defines = {}, depth = false,
}) {
  material.defines = Object.assign(material.defines || {}, defines);
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (typeof prev === 'function') prev.call(this, shader, renderer);
    for (const k in uniforms) shader.uniforms[k] = uniforms[k];

    if (shader.vertexShader.indexOf('void vegPlace(') === -1) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + vertexPars);

      if (!depth) {
        // colour pass: normals are needed, and beginnormal runs first
        shader.vertexShader = shader.vertexShader
          .replace('#include <beginnormal_vertex>',
            'vegPlace();\nvec3 objectNormal = vegNormal;')
          .replace('#include <begin_vertex>',
            'vec3 transformed = vegPos;');
      } else {
        shader.vertexShader = shader.vertexShader
          .replace('#include <begin_vertex>',
            'vegPlace();\nvec3 transformed = vegPos;');
      }
    }

    if (fragPars && shader.fragmentShader.indexOf('RS_VEG_FRAG') === -1) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n#define RS_VEG_FRAG 1\n' + fragPars);
      if (fragBody) {
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <map_fragment>', '#include <map_fragment>\n' + fragBody);
      }
      if (normalBody && !depth) {
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <normal_fragment_begin>',
            '#include <normal_fragment_begin>\n' + normalBody);
      }
      if (lightsBody && !depth) {
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <lights_fragment_end>',
            '#include <lights_fragment_end>\n' + lightsBody);
      }
    }
  };

  const key = material.customProgramCacheKey;
  const tag = 'rsVeg|' + (material.userData.rsVegKey || '') + '|' + (depth ? 'd' : 'c');
  material.customProgramCacheKey = function () {
    return tag + (typeof key === 'function' ? key.call(this) : '');
  };
  material.needsUpdate = true;
  return material;
}

/* --------------------------------------------------------------- helpers */

/** InstancedBufferGeometry that renders through a plain Mesh (no instanceMatrix). */
export function makeInstanced(src, count) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = src.index;
  for (const name in src.attributes) g.setAttribute(name, src.attributes[name]);
  g.instanceCount = count;
  return g;
}

export function hugeSphere(geometry, r = 1e6) {
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), r);
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(-r, -r, -r), new THREE.Vector3(r, r, r));
}

/** Linear-space colour from sRGB 0..255 triplet. */
export function srgb255(r, g, b) {
  const c = new THREE.Color();
  c.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  return c;
}
