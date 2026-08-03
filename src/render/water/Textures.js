import * as THREE from 'three';
import { rng } from '../../core/Context.js';

/**
 * Procedural, tileable data textures for the water surface.
 *
 * Everything here is band-limited value noise on a WRAPPED lattice, so the maps
 * tile seamlessly at any repeat count and their mip chains stay clean (a white
 * noise source would turn into salt-and-pepper the moment it minified, which is
 * exactly the failure the pass-1 review flagged on the terrain detail albedo).
 *
 * All maps are DATA, never colour: NoColorSpace, linear, no sRGB decode.
 */

/* ------------------------------------------------------- wrapped value noise */

/** Deterministic hash over a wrapped integer lattice of period `p`. */
function makeLattice(p, seed) {
  const r = rng(seed >>> 0);
  const g = new Float32Array(p * p * 2);
  for (let i = 0; i < p * p; i++) {
    const a = r() * Math.PI * 2;
    g[i * 2] = Math.cos(a);
    g[i * 2 + 1] = Math.sin(a);
  }
  return g;
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

/** Periodic Perlin-style gradient noise, period `p` lattice cells. */
function perlin(g, p, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const x0 = ((xi % p) + p) % p, y0 = ((yi % p) + p) % p;
  const x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
  const d = (gx, gy, dx, dy) => {
    const k = (gy * p + gx) * 2;
    return g[k] * dx + g[k + 1] * dy;
  };
  const n00 = d(x0, y0, xf, yf);
  const n10 = d(x1, y0, xf - 1, yf);
  const n01 = d(x0, y1, xf, yf - 1);
  const n11 = d(x1, y1, xf - 1, yf - 1);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return a + (b - a) * v;
}

/* --------------------------------------------------------------- capillaries */

/**
 * Height field for the ripple normal map. Two ingredients:
 *   • a low-anisotropy fBm swell that gives the map its large shapes
 *   • a set of directional capillary trains — short, sharp, mildly crested
 *     sinusoids whose phase is warped by the swell. Real wind ripples are not
 *     isotropic noise, they are overlapping wave trains, and the streaky
 *     highlight that produces is most of what reads as "water" at a glance.
 */
function rippleHeight(size, seed, opts) {
  const { octaves = 5, base = 3, trains = 6, trainGain = 0.34, sharpen = 1.0 } = opts || {};
  const h = new Float32Array(size * size);
  const r = rng((seed ^ 0x9e3779b9) >>> 0);

  const lat = [];
  for (let o = 0; o < octaves; o++) lat.push(makeLattice(base << o, (seed + o * 7919) >>> 0));

  const dirs = [];
  for (let t = 0; t < trains; t++) {
    const a = (r() * 0.9 - 0.45) + (t & 1 ? Math.PI * 0.5 : 0) * 0.35;
    dirs.push({
      kx: Math.cos(a), ky: Math.sin(a),
      f: (2 + Math.floor(r() * 5)) * (1 + (t % 2)),
      ph: r() * Math.PI * 2,
      amp: (0.5 + r() * 0.5) / (1 + t * 0.55),
    });
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let swell = 0, amp = 1, norm = 0;
      for (let o = 0; o < octaves; o++) {
        const p = base << o;
        swell += perlin(lat[o], p, u * p, v * p) * amp;
        norm += amp;
        amp *= 0.5;
      }
      swell /= norm;

      let tr = 0, tn = 0;
      for (const d of dirs) {
        const ph = (u * d.kx + v * d.ky) * d.f * Math.PI * 2 + d.ph + swell * 2.4;
        // mildly crested: sharp troughs, rounded peaks
        const s = Math.sin(ph);
        tr += (s - sharpen * 0.22 * (s * s - 0.5)) * d.amp;
        tn += d.amp;
      }
      tr /= tn;
      h[y * size + x] = swell * (1 - trainGain) + tr * trainGain;
    }
  }
  return h;
}

/**
 * Central-difference a wrapped height field into a tangent-space normal map,
 * and report the RMS magnitude of the stored tangent so the shader can
 * normalise it. Without that number the per-band weights in WaterMaterial are
 * arbitrary texture units instead of world-space slopes, and every retune of the
 * texture silently changes the look of the surface.
 */
function heightToNormalRGBA(h, size, strength, extraA) {
  const out = new Uint8Array(size * size * 4);
  const w = (x, y) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  let sum2 = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (w(x + 1, y) - w(x - 1, y)) * strength;
      const dy = (w(x, y + 1) - w(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      sum2 += nx * nx + ny * ny;
      const i = (y * size + x) * 4;
      out[i] = Math.max(0, Math.min(255, (nx * 0.5 + 0.5) * 255)) | 0;
      out[i + 1] = Math.max(0, Math.min(255, (ny * 0.5 + 0.5) * 255)) | 0;
      out[i + 2] = Math.max(0, Math.min(255, (nz * 0.5 + 0.5) * 255)) | 0;
      out[i + 3] = extraA ? extraA(x, y, h[y * size + x]) : 255;
    }
  }
  return { data: out, rms: Math.sqrt(sum2 / (size * size)) };
}

function dataTex(data, size, format, aniso) {
  const t = new THREE.DataTexture(data, size, size, format || THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso || 8;
  t.needsUpdate = true;
  return t;
}

/* ------------------------------------------------------------------ exports */

/**
 * Ripple normal map. RGB = tangent normal, A = height (used to modulate the
 * sun glitter so crests spark and troughs do not).
 *
 * `tex.userData.slopeRms` is the RMS of the stored tangent xy. WaterMaterial
 * divides by it so that its per-band weights are literal surface slopes.
 */
export function makeRippleNormals(seed, size = 256, aniso = 16, opts) {
  const h = rippleHeight(size, seed, opts);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < h.length; i++) { if (h[i] < lo) lo = h[i]; if (h[i] > hi) hi = h[i]; }
  const inv = 1 / Math.max(1e-5, hi - lo);
  const { data, rms } = heightToNormalRGBA(h, size, (opts && opts.strength) || 3.2,
    (x, y, v) => ((v - lo) * inv * 255) | 0);
  const t = dataTex(data, size, THREE.RGBAFormat, aniso);
  t.userData.slopeRms = rms;
  return t;
}

/**
 * Foam mask. Four decorrelated fBm octave-sets in RGBA so the shader can build
 * an evolving, non-repeating lace from one fetch by combining channels at
 * different scroll rates.
 */
export function makeFoamNoise(seed, size = 256) {
  const data = new Uint8Array(size * size * 4);
  const sets = [];
  for (let c = 0; c < 4; c++) {
    const oct = [];
    const base = [3, 5, 7, 11][c];
    for (let o = 0; o < 4; o++) oct.push({ p: base << o, g: makeLattice(base << o, (seed + c * 3571 + o * 104729) >>> 0) });
    sets.push(oct);
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      for (let c = 0; c < 4; c++) {
        let s = 0, amp = 1, norm = 0;
        for (const o of sets[c]) {
          s += Math.abs(perlin(o.g, o.p, u * o.p, v * o.p)) * amp;
          norm += amp; amp *= 0.52;
        }
        s = 1 - s / norm;                 // ridged: bright filaments, dark gaps
        s = Math.pow(Math.max(0, s), 1.6);
        data[(y * size + x) * 4 + c] = Math.min(255, s * 255) | 0;
      }
    }
  }
  return dataTex(data, size, THREE.RGBAFormat, 4);
}

/**
 * Caustic map. Sum of three warped, ridged gradient-noise layers, squared —
 * the classic "light focused by a wavy lens" web. R/G/B carry the same pattern
 * at slightly different phases so the shader can chromatically split it, which
 * is what real caustics do at the edges of each filament.
 */
export function makeCaustics(seed, size = 256) {
  const data = new Uint8Array(size * size * 4);
  const L = [];
  for (let o = 0; o < 3; o++) L.push(makeLattice(4 << o, (seed + o * 26107) >>> 0));
  const W = makeLattice(4, (seed ^ 0x5bd1e995) >>> 0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const wx = perlin(W, 4, u * 4, v * 4) * 0.22;
      const wy = perlin(W, 4, u * 4 + 3.7, v * 4 + 1.3) * 0.22;
      for (let c = 0; c < 3; c++) {
        const ph = c * 0.012;
        let s = 0, amp = 1, norm = 0;
        for (let o = 0; o < 3; o++) {
          const p = 4 << o;
          const n = perlin(L[o], p, (u + wx + ph) * p, (v + wy + ph) * p);
          s += (1 - Math.abs(n) * 2.3) * amp;
          norm += amp; amp *= 0.55;
        }
        s = Math.max(0, s / norm);
        s = Math.pow(s, 4.0);
        data[(y * size + x) * 4 + c] = Math.min(255, s * 460) | 0;
      }
      data[(y * size + x) * 4 + 3] = 255;
    }
  }
  return dataTex(data, size, THREE.RGBAFormat, 4);
}
