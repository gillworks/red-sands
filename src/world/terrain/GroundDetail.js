import * as THREE from 'three';

/**
 * GroundDetail — the eye-level surface layer for the terrain.
 *
 * WHY THIS EXISTS. The 1:1 foreground crops against RDR2 are brutal: their
 * ground carries pebbles, grain, cracks and soil structure at the scale a
 * player's eye actually resolves; ours was a magnified base tile, i.e. a smooth
 * blur. The terrain splat already samples a 512px layer at ~7 m per tile — that
 * is 14 texels per metre, roughly a 7 cm texel, so there is *no* information in
 * it below a decimetre no matter how many octaves are stacked on top.
 *
 * The fix every shipped title uses is a shared DETAIL surface tiled an order of
 * magnitude finer and faded in with proximity. This is that surface, authored
 * specifically for ground rather than reused from the generic grit map:
 *
 *   R,G  tangent normal xy      — relief: stone rims, crack walls, soil clumps
 *   B    micro height 0..1      — albedo grain AND the puddle basin field
 *   A    stone mask 0..1        — pale lag gravel / caliche chips
 *
 * Tiled at ~0.6 m in the first ~26 m and at ~2.9 m out to ~115 m, through two
 * different rotations so the two octaves never beat into a visible period.
 *
 * The B channel doing double duty is the point of the design: water pools where
 * the ground is genuinely low, so puddles land in the crack network and between
 * the stones instead of being a separate blob mask painted on top.
 *
 * Deterministic (integer hash, never Math.random) and cheap: ~256^2 with
 * stamped pebbles rather than per-texel gathers, measured at 12-18 ms once at
 * boot for the whole thing.
 */

/* ---------------------------------------------------------------- hashing */

function h2(x, y, s) {
  let n = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)
    + Math.imul(s | 0, 1274126177)) | 0;
  n = (n ^ (n >>> 13)) | 0;
  n = Math.imul(n, 1274126177) | 0;
  n = (n ^ (n >>> 16)) >>> 0;
  return n / 4294967296;
}

/** Value noise on an integer lattice of period `f` — tiles exactly. */
function vn(x, y, f, s) {
  const fx = x * f, fy = y * f;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const ux = tx * tx * (3 - 2 * tx), uy = ty * ty * (3 - 2 * ty);
  const i0 = ((x0 % f) + f) % f, j0 = ((y0 % f) + f) % f;
  const i1 = (i0 + 1) % f, j1 = (j0 + 1) % f;
  const a = h2(i0, j0, s), b = h2(i1, j0, s);
  const c = h2(i0, j1, s), d = h2(i1, j1, s);
  const t0 = a + (b - a) * ux;
  return t0 + ((c + (d - c) * ux) - t0) * uy;
}

function fbmT(x, y, f, oct, s) {
  let v = 0, a = 0.5, n = 0, ff = f;
  for (let i = 0; i < oct; i++) {
    v += vn(x, y, ff, s + i * 131) * a;
    n += a; a *= 0.5; ff *= 2;
  }
  return v / n;
}

/* ------------------------------------------------------------- generation */

/**
 * Stamp one size-class of pebbles into the height field and the stone mask.
 * Stamping (scatter) rather than gathering: total work is the covered area,
 * about 0.3 * S^2 per class, instead of S^2 * 9 distance tests.
 */
function stampPebbles(h, stone, S, cellPx, amp, density, seed) {
  const n = Math.max(1, Math.round(S / cellPx));
  const cs = S / n;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (h2(i, j, seed) > density) continue;
      const cx = (i + 0.15 + h2(i, j, seed + 11) * 0.7) * cs;
      const cy = (j + 0.15 + h2(i, j, seed + 23) * 0.7) * cs;
      const r = cs * (0.19 + h2(i, j, seed + 37) * 0.25);
      const ang = h2(i, j, seed + 53) * 6.28318;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const ar = 0.58 + h2(i, j, seed + 71) * 0.55;   // aspect: stones are not discs
      const a2 = amp * (0.5 + h2(i, j, seed + 97) * 0.85);
      const rr = Math.ceil(r / Math.min(1, ar)) + 1;
      const bx = Math.floor(cx), by = Math.floor(cy);
      for (let dy = -rr; dy <= rr; dy++) {
        const py = ((by + dy) % S + S) % S;
        const row = py * S;
        const oy = by + dy + 0.5 - cy;
        for (let dx = -rr; dx <= rr; dx++) {
          const ox = bx + dx + 0.5 - cx;
          const u = (ox * ca + oy * sa) / r;
          const v = (-ox * sa + oy * ca) / (r * ar);
          const d2 = u * u + v * v;
          if (d2 >= 1) continue;
          const px = ((bx + dx) % S + S) % S;
          const k = row + px;
          const dome = Math.pow(1 - d2, 0.5);
          h[k] += dome * a2;
          const sm = dome > 0.22 ? Math.min(1, (dome - 0.22) * 2.4) : 0;
          if (sm > stone[k]) stone[k] = sm;
        }
      }
    }
  }
}

/** Jittered-grid F2-F1 — the polygon network that dried mud cracks along. */
function crackField(S, freq, seed, out) {
  const cs = S / freq;
  for (let y = 0; y < S; y++) {
    const gy = Math.floor(y / cs);
    for (let x = 0; x < S; x++) {
      const gx = Math.floor(x / cs);
      let f1 = 1e9, f2 = 1e9;
      for (let b = -1; b <= 1; b++) {
        for (let a = -1; a <= 1; a++) {
          const ci = gx + a, cj = gy + b;
          const wi = ((ci % freq) + freq) % freq, wj = ((cj % freq) + freq) % freq;
          const px = (ci + h2(wi, wj, seed)) * cs;
          const py = (cj + h2(wi, wj, seed + 17)) * cs;
          const dx = px - x - 0.5, dy = py - y - 0.5;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
        }
      }
      out[y * S + x] = (f2 - f1) / cs;
    }
  }
}

/**
 * Build the ground detail texture.
 * @param {number} size  256 is enough: at a 0.6 m tile that is a 2.3 mm texel.
 * @param {number} seed
 * @param {number} aniso
 * @returns {THREE.DataTexture} RGBA8, linear, repeating
 */
export function makeGroundDetail(size = 256, seed = 1337, aniso = 8) {
  const S = size;
  const N = S * S;
  const h = new Float32Array(N);
  const stone = new Float32Array(N);
  const crack = new Float32Array(N);
  const s0 = seed | 0;

  /* --- soil body: broad dishes (which is where water will pool), clumps, grain */
  const inv = 1 / S;
  for (let y = 0; y < S; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) * inv;
      /* Weighted toward the LOW frequencies on purpose. A ground layer whose
         energy sits in its top octave reads as sandpaper at 1:1; real soil is
         clods, dishes and hollows first, grain last. */
      h[y * S + x] =
          fbmT(u, v, 3, 3, s0) * 0.56
        + fbmT(u, v, 11, 3, s0 + 907) * 0.31
        + fbmT(u, v, 43, 2, s0 + 1811) * 0.11;
    }
  }

  /* --- FOUR size classes of stone, from a half-buried cobble down to coarse
     grit. Pass 10 stopped at three and normalised the result over the whole
     tile, which put the histogram's mass in the mid-greys: measured at 1:1
     against the reference the ground still read as a soft mottle rather than as
     a surface with things lying on it. The extra top class is the one the eye
     actually resolves at boot height, and the amplitudes are up across the
     board because relief that survives a mip chain has to start deeper. */
  stampPebbles(h, stone, S, 76, 0.46, 0.30, s0 + 1009);
  stampPebbles(h, stone, S, 40, 0.42, 0.42, s0 + 2003);
  stampPebbles(h, stone, S, 19, 0.27, 0.50, s0 + 3011);
  stampPebbles(h, stone, S, 8, 0.15, 0.48, s0 + 4019);

  /* --- dried-mud crack network, patchy so it never covers the whole tile */
  crackField(S, 9, s0 + 5023, crack);
  for (let y = 0; y < S; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) * inv;
      const k = y * S + x;
      const m = Math.max(0, fbmT(u, v, 5, 2, s0 + 6029) * 1.9 - 0.72);
      const c = Math.max(0, 1 - crack[k] / 0.10);
      h[k] -= c * c * Math.min(1, m) * 0.26 * (1 - stone[k] * 0.8);
    }
  }

  /* --- normalise */
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < N; i++) { const q = h[i]; if (q < lo) lo = q; if (q > hi) hi = q; }
  const sc = 1 / Math.max(1e-4, hi - lo);
  for (let i = 0; i < N; i++) h[i] = (h[i] - lo) * sc;

  /* --- Sobel to a tangent normal, wrapped so the tile is seamless.
     k is the relief gain. 2.6 produced a normal whose xy rarely left ±0.35, so
     once the shader's own 1.25 strength and the 0.75-ish mip attenuation were
     applied there was nothing left to catch a raking sun. */
  const data = new Uint8Array(N * 4);
  const k = 3.9;
  for (let y = 0; y < S; y++) {
    const ym = ((y - 1 + S) % S) * S, yp = ((y + 1) % S) * S, y0 = y * S;
    for (let x = 0; x < S; x++) {
      const xm = (x - 1 + S) % S, xp = (x + 1) % S;
      const dx = (h[y0 + xp] - h[y0 + xm]) * k;
      const dy = (h[yp + x] - h[ym + x]) * k;
      const l = Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y0 + x) * 4;
      data[i] = (-dx / l * 0.5 + 0.5) * 255;
      data[i + 1] = (-dy / l * 0.5 + 0.5) * 255;
      data[i + 2] = h[y0 + x] * 255;
      data[i + 3] = stone[y0 + x] * 255;
    }
  }

  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
