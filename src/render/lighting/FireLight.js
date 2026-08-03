import * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/*  Blackbody radiators, authored in LINEAR radiance.                          */
/* -------------------------------------------------------------------------- */

const _xyz = new THREE.Vector3();

/**
 * Planckian locus (Kim et al. cubic fit, valid 1667 K .. 25000 K) -> CIE xy ->
 * XYZ (Y = 1) -> linear sRGB, clamped positive and normalised so the strongest
 * channel is 1. INTENSITY is then a separate scalar, which is the whole point:
 * pass 1 scaled the *colour* of the campfire until every channel clipped and
 * the measured core came out at (0.838, 0.872, 0.860) — green-dominant white.
 *
 * @param {number} kelvin
 * @param {THREE.Color} [out]
 * @returns {THREE.Color} linear, max component == 1
 */
export function blackbodyLinear(kelvin, out = new THREE.Color()) {
  const T = THREE.MathUtils.clamp(kelvin, 1667, 25000);
  const t = 1 / T;
  let x;
  if (T <= 4000) {
    x = -0.2661239e9 * t * t * t - 0.2343589e6 * t * t + 0.8776956e3 * t + 0.179910;
  } else {
    x = -3.0258469e9 * t * t * t + 2.1070379e6 * t * t + 0.2226347e3 * t + 0.240390;
  }
  const x2 = x * x;
  const x3 = x2 * x;
  let y;
  if (T <= 2222) y = -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683;
  else if (T <= 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;

  const Y = 1;
  const X = (x / y) * Y;
  const Z = ((1 - x - y) / y) * Y;
  _xyz.set(X, Y, Z);

  let r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  let g = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  let b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  r = Math.max(r, 0);
  g = Math.max(g, 0);
  b = Math.max(b, 0);
  const m = Math.max(r, g, b, 1e-6);
  return out.setRGB(r / m, g / m, b / m);
}

/**
 * A real wood flame is a sooty blackbody plus a much hotter, thinner core and a
 * little scattered blue from the base, so the pure Planckian colour (which has
 * literally zero blue below ~2000 K) reads as a stage gel. `soot` lifts it a
 * few percent toward neutral, which is what lands the classic (1.0, 0.42, 0.10).
 */
export function flameColor(kelvin = 1950, soot = 0.15, out = new THREE.Color()) {
  blackbodyLinear(kelvin, out);
  out.setRGB(
    out.r + (1 - out.r) * soot,
    out.g + (1 - out.g) * soot,
    out.b + (1 - out.b) * soot * 0.85,
  );
  const m = Math.max(out.r, out.g, out.b, 1e-6);
  return out.setRGB(out.r / m, out.g / m, out.b / m);
}

/* -------------------------------------------------------------------------- */
/*  Flicker                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic flame envelope in [0,1].
 *
 * Three bands, because a fire does three things at once: a slow convective
 * breath (~1 Hz), the turbulent body (4-12 Hz) and the crackle (20-40 Hz), plus
 * an occasional flare when a pocket of gas lets go. Everything a fire drives —
 * light intensity, colour temperature, light position, the flame billboard's
 * own emissive — must be sampled from the SAME envelope or the picture comes
 * apart: a light that pulses out of phase with its flame reads as a bug.
 */
export function flameEnvelope(t, phase, speed) {
  const p = t * speed + phase;
  const breath = Math.sin(p * 1.9 + 0.6) * 0.5 + Math.sin(p * 1.13 + 2.4) * 0.5;
  const body = Math.sin(p * 6.4) * 0.45 + Math.sin(p * 9.7 + 1.7) * 0.33 + Math.sin(p * 14.9 + 3.1) * 0.22;
  const crackle = Math.sin(p * 27.1 + 0.9) * 0.6 + Math.sin(p * 41.3 + 2.2) * 0.4;
  // Rare asymmetric flare: sharp attack, slow decay.
  const s = Math.sin(p * 0.61 + 1.9);
  const flare = Math.pow(Math.max(s, 0), 14) * 0.9;
  const v = 0.52 + 0.20 * breath + 0.20 * body + 0.055 * crackle + flare * 0.35;
  return THREE.MathUtils.clamp(v, 0, 1.35);
}

/* -------------------------------------------------------------------------- */
/*  Shaped light pool                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A campfire's pool of light on the ground is never a clean radial: the fuel
 * bed occludes it unevenly, the flame leans, and the ground is not a disc.
 * This bakes an anisotropic, noisy cookie used as the SpotLight projection so
 * the pool has structure even before the logs cast their shadows into it.
 * Data texture, NoColorSpace (it is a mask, not a colour).
 */
export function makeFirePoolCookie(size, rand) {
  const N = size;
  const data = new Uint8Array(N * N * 4);

  // a handful of seeded lobes that break the circle
  const L = 7;
  const lobes = [];
  for (let i = 0; i < L; i++) {
    const a = (i / L) * Math.PI * 2 + rand() * 0.9;
    const r = 0.18 + rand() * 0.34;
    lobes.push([Math.cos(a) * r, Math.sin(a) * r, 0.32 + rand() * 0.4, 0.5 + rand() * 0.9]);
  }
  const h = (x, y) => {
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };
  const vnoise = (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    return (
      (h(ix, iy) * (1 - ux) + h(ix + 1, iy) * ux) * (1 - uy) +
      (h(ix, iy + 1) * (1 - ux) + h(ix + 1, iy + 1) * ux) * uy
    );
  };

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N * 2 - 1;
      const v = (j + 0.5) / N * 2 - 1;
      const d = Math.sqrt(u * u + v * v);
      // soft cone edge
      let a = 1 - THREE.MathUtils.smoothstep(d, 0.28, 1.0);
      // lobed asymmetry
      let lobe = 0;
      for (const [lx, ly, lr, lw] of lobes) {
        const dd = Math.hypot(u - lx, v - ly);
        lobe += lw * Math.max(0, 1 - dd / lr);
      }
      a *= 0.55 + 0.45 * THREE.MathUtils.clamp(lobe * 0.55, 0, 1);
      // fine breakup so the falloff is not a clean gradient
      const n = vnoise(u * 5.5 + 11.3, v * 5.5 + 4.1) * 0.6 + vnoise(u * 13.0, v * 13.0) * 0.4;
      a *= 0.78 + 0.32 * n;
      const c = Math.round(THREE.MathUtils.clamp(a, 0, 1) * 255);
      const k = (j * N + i) * 4;
      data[k] = c;
      data[k + 1] = c;
      data[k + 2] = c;
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  tex.name = 'rsFirePoolCookie';
  return tex;
}
