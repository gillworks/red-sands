import * as THREE from 'three';
import { clamp01, smoothstep, lerp, mix3, hash1, vnoise, vfbm } from './Noise.js';
import { buildAlphaMips } from './Bake.js';

/**
 * LeafAtlas.js — a real leaf atlas.
 *
 * forest_interior, verbatim: "Leaves are literally flat uniform-fill ellipses.
 * Zooming the bush shows individual leaves as solid single-color cream ovals
 * and lozenges — no texture, no veins, no per-leaf normal variation, no
 * specular, no translucency gradient."
 *
 * This builds a 4x4 atlas of sixteen DISTINCT leaves — cottonwood deltoids,
 * lobed scrub oak, narrow willow, aspen ovate, pine needle fascicles and one
 * dead brown curl — each with:
 *
 *   • a parametric outline with serration and per-leaf insect damage,
 *   • pinnate venation (midrib + chevron secondaries) lifted in value AND in
 *     the normal, so a leaf catches a specular break instead of reading flat,
 *   • chlorophyll variation along the blade, margin browning, fungal spotting,
 *     and a translucency term that brightens the thin interveinal tissue,
 *   • a soft, correctly-antialiased alpha edge rather than a binary cut,
 *   • a coverage-preserving, premultiplied mip chain (see Bake.buildAlphaMips)
 *     so the canopy stops speckling at distance.
 *
 * §5 and the procTextures lens finding both require the greens be
 * yellow-shifted and desaturated: the palette here sits at hue 62-84deg with
 * saturation 0.22-0.34, never emerald.
 *
 * CONSUMERS: alphaTest 0.42, alphaToCoverage true where MSAA exists,
 * `map.colorSpace = SRGBColorSpace`, and use `rects` for per-card UVs.
 */

/* kind: 0 deltoid, 1 ovate, 2 lanceolate, 3 lobed, 4 needle fascicle, 5 dead */
const CELLS = [
  { kind: 0, w: 0.40, ser: 22, dmg: 1, tint: 0 },
  { kind: 1, w: 0.34, ser: 26, dmg: 0, tint: 1 },
  { kind: 3, w: 0.40, ser: 5, dmg: 1, tint: 0 },
  { kind: 2, w: 0.20, ser: 30, dmg: 0, tint: 2 },
  { kind: 1, w: 0.36, ser: 18, dmg: 2, tint: 1 },
  { kind: 0, w: 0.44, ser: 16, dmg: 0, tint: 2 },
  { kind: 3, w: 0.36, ser: 4, dmg: 2, tint: 1 },
  { kind: 4, w: 0.30, ser: 0, dmg: 0, tint: 3 },
  { kind: 2, w: 0.23, ser: 24, dmg: 1, tint: 0 },
  { kind: 1, w: 0.30, ser: 20, dmg: 0, tint: 3 },
  { kind: 4, w: 0.34, ser: 0, dmg: 0, tint: 3 },
  { kind: 0, w: 0.38, ser: 24, dmg: 2, tint: 2 },
  { kind: 3, w: 0.42, ser: 6, dmg: 1, tint: 2 },
  { kind: 5, w: 0.32, ser: 14, dmg: 3, tint: 4 },
  { kind: 2, w: 0.21, ser: 28, dmg: 1, tint: 1 },
  { kind: 1, w: 0.38, ser: 22, dmg: 1, tint: 0 },
];

/* Desaturated, yellow-shifted greens. Never emerald (§5). */
const TINTS = [
  [[74, 88, 52], [138, 148, 92]],    // 0 fresh sage → sunlit olive
  [[86, 96, 58], [156, 158, 100]],   // 1 mid
  [[96, 100, 62], [172, 168, 110]],  // 2 pale / sun-bleached crown
  [[70, 84, 60], [116, 128, 84]],    // 3 conifer, bluer and darker
  [[112, 84, 46], [156, 122, 66]],   // 4 dead / autumn
];

/** Half-width of the blade at position t (0 = petiole, 1 = tip). */
function bladeWidth(kind, t, W, ser, seed) {
  if (t <= 0 || t >= 1) return 0;
  let w;
  switch (kind) {
    case 0: /* deltoid — broad shoulders, drawn-out tip */
      w = W * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.52)), 1.15) * (1.05 - 0.28 * t);
      break;
    case 2: /* lanceolate */
      w = W * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.62)), 1.55);
      break;
    case 3: /* lobed — rounded sinuses, the scrub-oak silhouette */
      w = W * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.55)), 0.86);
      w *= 0.74 + 0.26 * Math.cos(t * Math.PI * 2 * 2.6 + 0.6);
      break;
    case 5: /* dead curl — asymmetric, shrivelled */
      w = W * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.6)), 1.2) * (0.7 + 0.3 * vnoise(t * 9, 0.5, 0, seed));
      break;
    default: /* ovate */
      w = W * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.58)), 1.05);
  }
  /* serration: shallow, and jittered so it is not a saw blade */
  if (ser > 0) {
    const j = vnoise(t * ser * 0.7, seed * 0.013, 0, seed) * 0.5;
    w *= 1 + 0.030 * Math.sin(t * Math.PI * 2 * ser + seed * 0.7 + j * 3.0);
  }
  return w;
}

/**
 * @returns {{ texture: THREE.DataTexture, rects: Array, cols: number }}
 */
export function buildLeafAtlas(size = 1024, seed = 1, aniso = 8, palette = null) {
  const S = size, COLS = 4, CS = S / COLS;
  const rgba = new Uint8Array(S * S * 4);
  const nrm = new Float32Array(S * S);          // pseudo-height for veins
  const tints = palette || TINTS;
  const edgeSoft = 1.6 / CS;                    // ~1.6 texels of AA on the margin

  const rects = [];
  for (let c = 0; c < CELLS.length; c++) {
    const cell = CELLS[c];
    const gx = c % COLS, gy = (c / COLS) | 0;
    rects.push({ x: gx / COLS, y: gy / COLS, w: 1 / COLS, h: 1 / COLS });

    const sd = seed + c * 7919;
    const rot = (hash1(c, sd) - 0.5) * 0.55;             // slight per-leaf tilt
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    const pal = tints[cell.tint];
    const hueJit = (hash1(c + 41, sd) - 0.5) * 0.16;
    const x0 = gx * CS, y0 = gy * CS;

    /* insect damage: up to 3 bites taken out of the margin */
    const bites = [];
    for (let b = 0; b < cell.dmg; b++) {
      bites.push({
        t: 0.25 + hash1(c * 13 + b, sd + 3) * 0.6,
        side: hash1(c * 17 + b, sd + 5) > 0.5 ? 1 : -1,
        r: 0.05 + hash1(c * 19 + b, sd + 7) * 0.09,
      });
    }

    for (let py = 0; py < CS; py++) {
      for (let px = 0; px < CS; px++) {
        /* cell-local, centred, with a small margin so nothing touches the seam */
        /* v grows downward in texture space; flip it so the petiole is at the
           bottom of the card, which is what every consumer's quad expects */
        const lx = (px + 0.5) / CS * 2 - 1;
        const ly = 1 - (py + 0.5) / CS * 2;
        const rx = lx * cosR - ly * sinR;
        const ry = lx * sinR + ly * cosR;
        const t = clamp01((ry * 0.5 + 0.5) / 0.94 - 0.01);
        const u = rx * 0.5;

        let a = 0, hgt = 0;
        let col = [0, 0, 0];

        if (cell.kind === 4) {
          /* pine fascicle: 7 needles fanning from the base */
          let best = 9;
          for (let n = 0; n < 7; n++) {
            const ang = (n / 6 - 0.5) * 0.46 + (hash1(c * 23 + n, sd) - 0.5) * 0.10;
            const len = 0.82 + hash1(c * 29 + n, sd + 11) * 0.18;
            const ex = Math.sin(ang) * len, ey = Math.cos(ang) * len;
            /* distance to the segment (0,-0.9) → (ex, ey-0.9) */
            const bx = rx, by = ry + 0.9;
            const dxs = ex, dys = ey;
            const dd = dxs * dxs + dys * dys;
            const s = clamp01((bx * dxs + by * dys) / dd);
            const qx = bx - dxs * s, qy = by - dys * s;
            const d = Math.sqrt(qx * qx + qy * qy) / (0.030 * (1.15 - 0.5 * s));
            if (d < best) best = d;
          }
          a = 1 - smoothstep(0.75, 1.0, best);
          hgt = (1 - clamp01(best)) * 0.7;
          const shade = clamp01(0.55 + (1 - best) * 0.5);
          col = mix3(pal[0], pal[1], shade * 0.7 + vfbm(rx * 2, ry * 2, { octaves: 2, freq: 9, seed: sd }) * 0.3);
        } else {
          const w = bladeWidth(cell.kind, t, cell.w, cell.ser, sd);
          let d = w - Math.abs(u);
          /* bite the margin */
          for (let b = 0; b < bites.length; b++) {
            const bt = bites[b];
            const bxp = bt.side * bladeWidth(cell.kind, bt.t, cell.w, cell.ser, sd);
            const dx = u - bxp, dy = (t - bt.t) * 0.9;
            const dd = Math.sqrt(dx * dx + dy * dy);
            if (dd < bt.r) d = Math.min(d, dd - bt.r);
          }
          /* torn tip on the dead leaf */
          if (cell.kind === 5) d -= smoothstep(0.72, 1.0, t) * 0.06;
          a = smoothstep(0, edgeSoft * 2.2, d);

          /* petiole */
          const stalkT = (t < 0.06) ? 1 : 0;
          if (stalkT && Math.abs(u) < 0.012 && t > -0.02) a = Math.max(a, smoothstep(0, edgeSoft * 2, 0.012 - Math.abs(u)));

          if (a > 0.002) {
            /* --- venation: midrib + pinnate chevrons pointing at the tip --- */
            const rel = w > 1e-4 ? u / w : 0;
            const mid = 1 - smoothstep(0.0, 0.055, Math.abs(rel));
            const q = (t * 3.1 - Math.abs(rel) * 0.85) * 7.0;
            const sec = 1 - smoothstep(0.0, 0.30, Math.abs(q - Math.floor(q) - 0.5) * 2.0);
            const vein = clamp01(mid * 1.0 + sec * 0.52 * smoothstep(0.02, 0.22, Math.abs(rel)));

            /* --- blade colour: chlorophyll gradient + bleached tip --- */
            const nse = vfbm(rx * 3 + c, ry * 3, { octaves: 3, freq: 7, gain: 0.6, seed: sd + 3 });
            let g = clamp01(0.30 + t * 0.42 + nse * 0.42 + hueJit);
            col = mix3(pal[0], pal[1], g);
            /* thin interveinal tissue transmits — brighten between the veins */
            col = mix3(col, [lerp(col[0], 205, 0.5), lerp(col[1], 202, 0.5), lerp(col[2], 140, 0.5)],
              (1 - vein) * 0.24 * clamp01(1 - Math.abs(rel)));
            /* veins are paler and slightly yellow */
            col = mix3(col, [col[0] * 1.18 + 22, col[1] * 1.14 + 20, col[2] * 1.05 + 10], vein * 0.55);
            /* margin browning and necrotic spots */
            const marg = smoothstep(0.62, 1.0, Math.abs(rel));
            col = mix3(col, [138, 104, 58], marg * (0.28 + 0.4 * nse));
            const spot = vnoise(rx * 26, ry * 26, 0, sd + 9);
            if (spot > 0.86) col = mix3(col, [104, 76, 42], (spot - 0.86) * 5.0);
            if (cell.kind === 5) col = mix3(col, [122, 88, 48], 0.55);

            hgt = 0.35 + vein * 0.45 + (1 - marg) * 0.12 + nse * 0.12;
          }
        }

        const di = ((y0 + py) * S + (x0 + px)) * 4;
        rgba[di] = Math.min(255, Math.max(0, col[0]));
        rgba[di + 1] = Math.min(255, Math.max(0, col[1]));
        rgba[di + 2] = Math.min(255, Math.max(0, col[2]));
        rgba[di + 3] = Math.round(clamp01(a) * 255);
        nrm[(y0 + py) * S + (x0 + px)] = hgt;
      }
    }
  }

  const t = new THREE.DataTexture(rgba, S, S, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = false;
  t.mipmaps = buildAlphaMips(rgba, S, 0.42);
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return { texture: t, rects, cols: COLS, height: nrm, size: S };
}

/**
 * Sagebrush / chaparral sprig atlas — narrow grey-green leaflets in threes,
 * for `foliage_scrub`. Same construction, different silhouette and palette.
 */
export function buildScrubAtlas(size = 512, seed = 5, aniso = 8) {
  const S = size, COLS = 4, CS = S / COLS;
  const rgba = new Uint8Array(S * S * 4);
  const edgeSoft = 1.6 / CS;
  const PAL = [[92, 98, 74], [148, 148, 116]];

  for (let c = 0; c < 16; c++) {
    const gx = c % COLS, gy = (c / COLS) | 0;
    const x0 = gx * CS, y0 = gy * CS;
    const sd = seed + c * 6151;
    const leaflets = 3 + ((hash1(c, sd) * 3) | 0);
    const W = 0.10 + hash1(c + 3, sd) * 0.05;

    for (let py = 0; py < CS; py++) {
      for (let px = 0; px < CS; px++) {
        const rx = (px + 0.5) / CS * 2 - 1;
        const ry = (py + 0.5) / CS * 2 - 1;
        let a = 0, sh = 0;
        for (let n = 0; n < leaflets; n++) {
          const ang = (n / Math.max(1, leaflets - 1) - 0.5) * 0.9 + (hash1(c * 31 + n, sd) - 0.5) * 0.2;
          const len = 0.6 + hash1(c * 37 + n, sd + 2) * 0.34;
          const ca = Math.cos(ang), sa = Math.sin(ang);
          const bx = rx, by = ry + 0.88;
          const lu = bx * ca - by * sa;
          const lv = bx * sa + by * ca;
          const tt = clamp01(lv / len);
          if (lv < 0 || lv > len) continue;
          /* sage leaflet: narrow wedge, three shallow teeth at the tip */
          let w = W * Math.pow(Math.sin(Math.PI * Math.pow(tt, 0.45)), 0.8);
          if (tt > 0.78) w *= 0.62 + 0.38 * Math.cos((tt - 0.78) * Math.PI * 2 * 6);
          const d = w - Math.abs(lu);
          const av = smoothstep(0, edgeSoft * 2.2, d);
          if (av > a) { a = av; sh = 0.35 + tt * 0.4 + (1 - Math.abs(lu / Math.max(w, 1e-4))) * 0.25; }
        }
        let col = [0, 0, 0];
        if (a > 0.002) {
          const nse = vfbm(rx * 4 + c, ry * 4, { octaves: 2, freq: 8, seed: sd + 5 });
          col = mix3(PAL[0], PAL[1], clamp01(sh * 0.7 + nse * 0.45));
          /* sagebrush is felted — a fine pale pubescence over the whole leaf */
          const felt = vnoise(rx * 40, ry * 40, 0, sd + 7);
          col = mix3(col, [186, 184, 158], felt * 0.22);
        }
        const di = ((y0 + py) * S + (x0 + px)) * 4;
        rgba[di] = col[0]; rgba[di + 1] = col[1]; rgba[di + 2] = col[2];
        rgba[di + 3] = Math.round(clamp01(a) * 255);
      }
    }
  }
  const t = new THREE.DataTexture(rgba, S, S, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = false;
  t.mipmaps = buildAlphaMips(rgba, S, 0.42);
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return { texture: t, cols: COLS, size: S };
}
