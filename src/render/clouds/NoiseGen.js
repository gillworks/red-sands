import * as THREE from 'three';

/**
 * GPU-generated, tiling Perlin–Worley volume noise for the cloud raymarcher.
 *
 *  shape   128³ RGBA8   R = Perlin-Worley,  G/B/A = Worley fBm @ 4 / 8 / 16
 *  detail   48³ RGBA8   R/G/B = Worley fBm @ 6 / 12 / 24, A = curl-ish warp
 *  weather 512²  RGBA8   R = coverage fBm, G = cloud-type fBm,
 *                        B = coverage detail, A = anvil / precipitation mask
 *
 * Everything is rendered on the GPU (one draw per 3D layer) — generating this
 * on the CPU in JS costs seconds; on the GPU it is a few milliseconds.
 * All textures are DATA, therefore NoColorSpace.
 */

const NOISE_LIB = /* glsl */ `
precision highp float;

/* ---- tiling hashes -----------------------------------------------------
   Inputs are small integer cell coordinates, so the usual fract(p*0.1031…)
   hash stays correlated along the axes and the resulting Worley cells line
   up into a visible grid (clouds come out as extruded boxes). A sin-dot
   hash decorrelates small integers properly.                             */
vec3 hash33(vec3 p, float period) {
  p = mod(p, vec3(period));
  vec3 q = vec3(
    dot(p, vec3(127.1, 311.7,  74.7)),
    dot(p, vec3(269.5, 183.3, 246.1)),
    dot(p, vec3(113.5, 271.9, 124.6))
  );
  return fract(sin(q) * 43758.5453123);
}

/* ---- tiling gradient (Perlin) noise ----------------------------------- */
float pgrad(vec3 ip, vec3 fp, float period) {
  vec3 g = normalize(hash33(ip, period) * 2.0 - 1.0);
  return dot(g, fp);
}
float perlin(vec3 p, float cells) {
  p *= cells;
  vec3 i = floor(p);
  vec3 f = p - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = pgrad(i + vec3(0.0, 0.0, 0.0), f - vec3(0.0, 0.0, 0.0), cells);
  float n100 = pgrad(i + vec3(1.0, 0.0, 0.0), f - vec3(1.0, 0.0, 0.0), cells);
  float n010 = pgrad(i + vec3(0.0, 1.0, 0.0), f - vec3(0.0, 1.0, 0.0), cells);
  float n110 = pgrad(i + vec3(1.0, 1.0, 0.0), f - vec3(1.0, 1.0, 0.0), cells);
  float n001 = pgrad(i + vec3(0.0, 0.0, 1.0), f - vec3(0.0, 0.0, 1.0), cells);
  float n101 = pgrad(i + vec3(1.0, 0.0, 1.0), f - vec3(1.0, 0.0, 1.0), cells);
  float n011 = pgrad(i + vec3(0.0, 1.0, 1.0), f - vec3(0.0, 1.0, 1.0), cells);
  float n111 = pgrad(i + vec3(1.0, 1.0, 1.0), f - vec3(1.0, 1.0, 1.0), cells);
  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  return mix(mix(nx00, nx10, u.y), mix(nx01, nx11, u.y), u.z);
}
float perlinFbm(vec3 p, float cells, int oct) {
  float a = 0.0, w = 0.5, tot = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    a += perlin(p, cells) * w;
    tot += w;
    w *= 0.5;
    cells *= 2.0;
  }
  return a / max(tot, 1e-4);
}

/* ---- tiling Worley (cellular) ----------------------------------------- */
float worley(vec3 p, float cells) {
  p *= cells;
  vec3 i = floor(p);
  vec3 f = p - i;
  float d = 1e9;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      for (int z = -1; z <= 1; z++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 o = hash33(i + g, cells);
        vec3 r = g + o - f;
        d = min(d, dot(r, r));
      }
    }
  }
  return sqrt(d);
}
/** inverted Worley fBm, 0..1, billowy */
float worleyFbm(vec3 p, float cells) {
  float a = 1.0 - worley(p, cells);
  float b = 1.0 - worley(p, cells * 2.0);
  float c = 1.0 - worley(p, cells * 4.0);
  return clamp(a * 0.625 + b * 0.25 + c * 0.125, 0.0, 1.0);
}

float remap01(float v, float a, float b) { return clamp((v - a) / max(b - a, 1e-5), 0.0, 1.0); }
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const SHAPE_FRAG = NOISE_LIB + /* glsl */ `
varying vec2 vUv;
uniform float uW;
void main() {
  vec3 p = vec3(vUv, uW);
  float wl = worleyFbm(p, 4.0);
  float pn = clamp(perlinFbm(p, 4.0, 5) * 0.72 + 0.5, 0.0, 1.0);
  // Guerrilla "Perlin-Worley": dilate the Perlin upward by the Worley fBm so
  // the field keeps billowy cauliflower lobes instead of smooth blobs.
  // ...then stretch the histogram back over 0..1 so the field actually has
  // contrast to carve silhouettes with.
  float pw = remap01(mix(wl, 1.0, pn), 0.24, 0.96);
  gl_FragColor = vec4(
    pw,
    worleyFbm(p, 4.0),
    worleyFbm(p, 8.0),
    worleyFbm(p, 16.0)
  );
}
`;

const DETAIL_FRAG = NOISE_LIB + /* glsl */ `
varying vec2 vUv;
uniform float uW;
void main() {
  vec3 p = vec3(vUv, uW);
  gl_FragColor = vec4(
    worleyFbm(p, 6.0),
    worleyFbm(p, 12.0),
    worleyFbm(p, 24.0),
    perlinFbm(p * 1.31 + 4.7, 8.0, 3) * 0.5 + 0.5
  );
}
`;

const WEATHER_FRAG = NOISE_LIB + /* glsl */ `
varying vec2 vUv;
void main() {
  vec3 p = vec3(vUv, 0.317);
  // large slabs of coverage, warped so cloud fields are not blobby grids
  vec3 warp = vec3(
    perlinFbm(p + 11.3, 2.0, 3),
    perlinFbm(p + 27.9, 2.0, 3),
    0.0) * 0.35;
  float cov = perlinFbm(p + warp, 3.0, 5) * 0.5 + 0.5;
  cov = remap01(cov, 0.18, 0.86);
  cov = cov * cov * (3.0 - 2.0 * cov);

  float typ = perlinFbm(p * 0.71 + 5.1, 2.0, 3) * 0.5 + 0.5;
  float det = clamp(perlinFbm(p * 1.9 + 13.7, 7.0, 4) * 0.5 + 0.5, 0.0, 1.0);
  det = remap01(det, 0.2, 0.85);
  float anvil = clamp(worleyFbm(p * 0.9 + 2.3, 3.0), 0.0, 1.0);

  gl_FragColor = vec4(cov, typ, det, anvil);
}
`;

function fsQuad(material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(g, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), geometry: g };
}

function make3D(size, type) {
  const rt = new THREE.WebGL3DRenderTarget(size, size, size, {
    format: THREE.RGBAFormat,
    type,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  const t = rt.texture;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = false;
  return rt;
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {{shape:number, detail:number, weather:number}} sizes
 */
export function generateCloudNoise(renderer, sizes = {}) {
  const SHAPE = sizes.shape || 128;
  const DETAIL = sizes.detail || 48;
  const WEATHER = sizes.weather || 512;

  const prevTarget = renderer.getRenderTarget();

  /* HALF FLOAT, not RGBA8.
   * The march remaps the shape field twice (histogram restore, then the
   * coverage window), which multiplies the sampled value's quantisation by
   * roughly five. At 8 bits that turns a smooth Worley distance field into
   * visible concentric contour bands — cloud cells render as stacks of
   * onion rings, and no amount of jitter or temporal filtering hides a
   * quantisation artefact because it is identical every frame. 16F costs
   * ~16 MB for the 128 cube and removes the banding outright. */
  const gl = renderer.getContext();
  const canF16 = !!(gl.getExtension('EXT_color_buffer_float')
                 || gl.getExtension('EXT_color_buffer_half_float'));
  const F16 = canF16 ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const shapeRT = make3D(SHAPE, F16);
  const detailRT = make3D(DETAIL, F16);
  const weatherRT = new THREE.WebGLRenderTarget(WEATHER, WEATHER, {
    format: THREE.RGBAFormat,
    type: F16,
    depthBuffer: false,
    stencilBuffer: false,
  });
  weatherRT.texture.wrapS = weatherRT.texture.wrapT = THREE.RepeatWrapping;
  weatherRT.texture.minFilter = weatherRT.texture.magFilter = THREE.LinearFilter;
  weatherRT.texture.colorSpace = THREE.NoColorSpace;
  weatherRT.texture.generateMipmaps = false;

  const mkMat = (frag) => new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: frag,
    uniforms: { uW: { value: 0 } },
    depthTest: false,
    depthWrite: false,
  });

  const shapeMat = mkMat(SHAPE_FRAG);
  const detailMat = mkMat(DETAIL_FRAG);
  const weatherMat = mkMat(WEATHER_FRAG);

  const q = fsQuad(shapeMat);

  for (let z = 0; z < SHAPE; z++) {
    shapeMat.uniforms.uW.value = (z + 0.5) / SHAPE;
    q.scene.children[0].material = shapeMat;
    renderer.setRenderTarget(shapeRT, z);
    renderer.render(q.scene, q.camera);
  }
  for (let z = 0; z < DETAIL; z++) {
    detailMat.uniforms.uW.value = (z + 0.5) / DETAIL;
    q.scene.children[0].material = detailMat;
    renderer.setRenderTarget(detailRT, z);
    renderer.render(q.scene, q.camera);
  }
  q.scene.children[0].material = weatherMat;
  renderer.setRenderTarget(weatherRT);
  renderer.render(q.scene, q.camera);

  renderer.setRenderTarget(prevTarget);

  q.geometry.dispose();
  shapeMat.dispose();
  detailMat.dispose();
  weatherMat.dispose();

  return { shapeRT, detailRT, weatherRT };
}
