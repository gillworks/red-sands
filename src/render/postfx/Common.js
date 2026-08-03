import * as THREE from 'three';
import { rng } from '../../core/Context.js';

/**
 * Shared plumbing for the hand-rolled HDR post chain.
 *  - FullScreenQuad: single-triangle blit helper (no EffectComposer).
 *  - makeRT / makeMaterial: explicit float target + material factories.
 *  - GLSL: chunks shared by several passes (depth reconstruction, colour spaces,
 *    noise). Everything below assumes a NON-reversed [0,1] depth buffer, which is
 *    what the Engine configures.
 */

/* ------------------------------------------------------------------ quad */

export class FullScreenQuad {
  constructor(renderer) {
    this.renderer = renderer;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this._geo = g;
    this._mesh = new THREE.Mesh(g, null);
    this._mesh.frustumCulled = false;
    this._mesh.matrixAutoUpdate = false;
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /** Draw `material` over `target` (null = canvas). */
  render(material, target, clear = false) {
    this._mesh.material = material;
    this.renderer.setRenderTarget(target);
    if (clear) this.renderer.clear(true, false, false);
    this.renderer.render(this._mesh, this._cam);
  }

  dispose() {
    this._geo.dispose();
  }
}

/* ---------------------------------------------------------------- targets */

export function makeRT(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)), {
    minFilter: opts.min || THREE.LinearFilter,
    magFilter: opts.mag || THREE.LinearFilter,
    format: opts.format || THREE.RGBAFormat,
    type: opts.type || THREE.HalfFloatType,
    depthBuffer: opts.depth === true,
    stencilBuffer: false,
    generateMipmaps: false,
    count: opts.count || 1,
  });
  for (const t of rt.textures) {
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.colorSpace = THREE.NoColorSpace; // every intermediate is linear data
    t.generateMipmaps = false;
  }
  return rt;
}

export const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

export function makeMaterial(fragmentShader, uniforms = {}, defines = {}, glsl3 = false) {
  const m = new THREE.ShaderMaterial({
    uniforms,
    defines,
    vertexShader: VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
  });
  if (glsl3) m.glslVersion = THREE.GLSL3;
  return m;
}

/* ------------------------------------------------------------- glsl chunks */

/** Depth / position reconstruction + colour helpers used by most passes. */
export const GLSL_COMMON = /* glsl */`
#ifndef PI
#define PI 3.141592653589793
#endif
#define SAT(x) clamp((x), 0.0, 1.0)

float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
float maxc( vec3 c ) { return max( c.r, max( c.g, c.b ) ); }
float minc( vec3 c ) { return min( c.r, min( c.g, c.b ) ); }

// window-space depth [0,1] -> view-space z (negative, metres)
float viewZFromDepth( float d, float n, float f ) {
  return ( n * f ) / ( ( f - n ) * d - f );
}
// view-space z -> 0..1 linear
float linear01( float vz, float n, float f ) {
  return SAT( ( -vz - n ) / ( f - n ) );
}
vec3 viewPosFromDepth( vec2 uv, float d, mat4 invProj ) {
  vec4 h = invProj * vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  return h.xyz / h.w;
}
vec3 worldPosFromDepth( vec2 uv, float d, mat4 invViewProj ) {
  vec4 h = invViewProj * vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  return h.xyz / h.w;
}

vec3 rgb2ycocg( vec3 c ) {
  return vec3( 0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
               0.5 * c.r - 0.5 * c.b,
              -0.25 * c.r + 0.5 * c.g - 0.25 * c.b );
}
vec3 ycocg2rgb( vec3 c ) {
  return vec3( c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z );
}

// Jimenez interleaved gradient noise — the workhorse for per-pixel rotation.
float ign( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}
float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

// Henyey–Greenstein phase function.
float phaseHG( float cosT, float g ) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * cosT;
  return ( 1.0 - g2 ) / ( 4.0 * PI * max( d * sqrt( max( d, 1e-4 ) ), 1e-4 ) );
}
`;

/* ------------------------------------------------------------- blue noise */

/**
 * 64x64 tileable blue-noise mask, built by void-and-cluster style energy
 * minimisation (random-swap annealing on a toroidal gaussian energy field).
 * Deterministic — seeded from ctx.seed.
 */
export function makeBlueNoise(seed, N = 64, swaps = 60000) {
  const rand = rng(seed);
  const n2 = N * N;
  const v = new Float32Array(n2);
  for (let i = 0; i < n2; i++) v[i] = i / (n2 - 1);
  // Fisher–Yates
  for (let i = n2 - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const t = v[i]; v[i] = v[j]; v[j] = t;
  }

  // gaussian kernel, radius 3, sigma 1.5
  const R = 3, K = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx === 0 && dy === 0) continue;
      K.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * 1.5 * 1.5))]);
    }
  }

  // local energy of pixel i against its neighbourhood
  const M = N - 1;
  const energyAt = (x, y, val) => {
    let e = 0;
    for (let k = 0; k < K.length; k++) {
      const kx = (x + K[k][0]) & M;
      const ky = (y + K[k][1]) & M;
      const d = val - v[ky * N + kx];
      e += K[k][2] * Math.exp(-Math.abs(d) * 3.0);
    }
    return e;
  };

  for (let s = 0; s < swaps; s++) {
    const ia = (rand() * n2) | 0;
    const ib = (rand() * n2) | 0;
    if (ia === ib) continue;
    const ax = ia % N, ay = (ia / N) | 0;
    const bx = ib % N, by = (ib / N) | 0;
    const va = v[ia], vb = v[ib];
    const before = energyAt(ax, ay, va) + energyAt(bx, by, vb);
    const after = energyAt(ax, ay, vb) + energyAt(bx, by, va);
    if (after < before) { v[ia] = vb; v[ib] = va; }
  }

  const data = new Uint8Array(n2);
  for (let i = 0; i < n2; i++) data[i] = Math.min(255, Math.max(0, Math.round(v[i] * 255)));
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ halton */

export function halton(index, base) {
  let f = 1, r = 0, i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/** N-sample Halton(2,3) jitter pattern centred on 0, in pixels. */
export function haltonSequence(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);
  return out;
}
