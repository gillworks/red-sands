import * as THREE from 'three';
import { streamRng, clamp } from './Noise.js';

/**
 * Procedural texture generation local to the scatter system.
 *
 * `procTextures.foliage_scrub` is a blobby fBm mask — fine for a distant
 * imposter, useless as a leaf card, because the thing that makes scrub read as
 * scrub is the *silhouette of individual leaves against the sky*. So the bush
 * atlas is drawn here: radiating twigs with hundreds of small leaves, four
 * different clumps in a 2x2 atlas, in a bleached sage palette.
 *
 * All colour canvases are authored in sRGB and flagged SRGBColorSpace; data
 * textures are NoColorSpace, per the project colour contract.
 */

function canvas2d(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return { c, g: c.getContext('2d', { willReadFrequently: true }) };
}

function srgb(r, g, b, a = 1) {
  return `rgba(${Math.round(clamp(r, 0, 255))},${Math.round(clamp(g, 0, 255))},${Math.round(clamp(b, 0, 255))},${a})`;
}

/* Palettes are sRGB bytes. Sage / creosote / rabbitbrush, all desaturated and
   yellow-shifted per the art direction — never emerald. */
const LEAF_PALETTES = {
  sage: [[126, 132, 104], [141, 145, 116], [108, 116, 92], [154, 154, 122], [96, 104, 82]],
  creosote: [[104, 118, 78], [122, 134, 90], [88, 100, 68], [136, 144, 100]],
  dry: [[158, 144, 100], [172, 156, 112], [140, 126, 88], [186, 170, 126]],
  rabbit: [[150, 148, 100], [168, 162, 112], [132, 132, 92], [180, 172, 118]],
};

/**
 * 2x2 atlas of bush clumps.
 * @param {number} size full atlas size in px
 * @param {string} palette key into LEAF_PALETTES
 */
export function makeBushAtlas(size, palette = 'sage', seed = 1) {
  const { c, g } = canvas2d(size);
  const cell = size / 2;
  g.clearRect(0, 0, size, size);
  const pal = LEAF_PALETTES[palette] || LEAF_PALETTES.sage;
  const rnd = streamRng(seed * 92821 + 17);

  for (let cy = 0; cy < 2; cy++) {
    for (let cx = 0; cx < 2; cx++) {
      const ox = cx * cell, oy = cy * cell;
      g.save();
      g.beginPath();
      g.rect(ox + 1, oy + 1, cell - 2, cell - 2);
      g.clip();

      const rootX = ox + cell * 0.5;
      const rootY = oy + cell * 0.995;
      const twigs = 11 + ((rnd() * 6) | 0);
      const spread = cell * (0.40 + rnd() * 0.09);

      /* woody structure first, so leaves overlay it */
      const stems = [];
      for (let t = 0; t < twigs; t++) {
        /* fan biased toward vertical so the card fills its cell instead of
           reading as a low horizontal spray */
        const spreadA = (t / (twigs - 1) - 0.5) * 2.0;
        const a = -Math.PI * 0.5 + Math.sign(spreadA) * Math.pow(Math.abs(spreadA), 1.45) * 1.02
          + (rnd() - 0.5) * 0.20;
        const len = cell * (0.66 + rnd() * 0.34) * (1 - Math.abs(spreadA) * 0.22);
        const midx = rootX + Math.cos(a) * len * 0.45 + (rnd() - 0.5) * cell * 0.06;
        const midy = rootY + Math.sin(a) * len * 0.45;
        const ex = rootX + Math.cos(a) * len * (0.86 + rnd() * 0.2);
        const ey = rootY + Math.sin(a) * len;
        stems.push({ a, ex, ey, midx, midy, len });
        g.strokeStyle = srgb(74 + rnd() * 26, 62 + rnd() * 22, 48 + rnd() * 18, 0.95);
        g.lineWidth = Math.max(1, cell * (0.012 - t * 0.0004));
        g.beginPath();
        g.moveTo(rootX, rootY);
        g.quadraticCurveTo(midx, midy, ex, ey);
        g.stroke();
      }

      /* leaves along each twig */
      const leafR = cell * 0.0225;
      for (const s of stems) {
        const n = 22 + ((rnd() * 16) | 0);
        for (let i = 0; i < n; i++) {
          const t = 0.16 + (i / n) * 0.9 + (rnd() - 0.5) * 0.08;
          const bx = (1 - t) * (1 - t) * rootX + 2 * (1 - t) * t * s.midx + t * t * s.ex;
          const by = (1 - t) * (1 - t) * rootY + 2 * (1 - t) * t * s.midy + t * t * s.ey;
          const jitter = cell * 0.055 * (0.35 + t);
          const px = bx + (rnd() - 0.5) * jitter * 2;
          const py = by + (rnd() - 0.5) * jitter * 2;
          const p = pal[(rnd() * pal.length) | 0];
          /* sun-bleach the outer tips, keep the interior darker */
          const bleach = clamp((t - 0.45) * 1.35, 0, 1) * (0.25 + rnd() * 0.35);
          const shade = 0.74 + rnd() * 0.42;
          const r = p[0] * shade + bleach * 70;
          const gg = p[1] * shade + bleach * 62;
          const bb = p[2] * shade + bleach * 44;
          const rot = rnd() * Math.PI;
          const rx = leafR * (0.55 + rnd() * 1.0);
          const ry = rx * (0.26 + rnd() * 0.40);
          g.save();
          g.translate(px, py);
          g.rotate(rot);
          g.fillStyle = srgb(r, gg, bb, 0.94);
          g.beginPath();
          g.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
          g.fill();
          g.restore();
        }
      }
      /* a few sun-killed twigs: dead straw against the sage reads as real */
      for (let k = 0; k < 3; k++) {
        const s2 = stems[(rnd() * stems.length) | 0];
        const n = 10 + ((rnd() * 8) | 0);
        for (let i = 0; i < n; i++) {
          const t = 0.35 + (i / n) * 0.7;
          const bx = (1 - t) * (1 - t) * rootX + 2 * (1 - t) * t * s2.midx + t * t * s2.ex;
          const by = (1 - t) * (1 - t) * rootY + 2 * (1 - t) * t * s2.midy + t * t * s2.ey;
          const px = bx + (rnd() - 0.5) * cell * 0.09;
          const py = by + (rnd() - 0.5) * cell * 0.09;
          const sh = 0.8 + rnd() * 0.45;
          g.save();
          g.translate(px, py);
          g.rotate(rnd() * Math.PI);
          g.fillStyle = srgb(176 * sh, 158 * sh, 108 * sh, 0.92);
          g.beginPath();
          g.ellipse(0, 0, leafR * (0.5 + rnd() * 0.8), leafR * (0.16 + rnd() * 0.22), 0, 0, Math.PI * 2);
          g.fill();
          g.restore();
        }
      }
      g.restore();
      void spread;
    }
  }

  /* Erode the alpha at the very border of each cell so mip-mapping cannot
     bleed one cell into the next. */
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inCellX = x % cell, inCellY = y % cell;
      if (inCellX < 2 || inCellY < 2 || inCellX > cell - 3 || inCellY > cell - 3) {
        d[(y * size + x) * 4 + 3] = 0;
      }
    }
  }
  /* Premultiply-safe: push the leaf colour into fully transparent texels so
     bilinear filtering at the alpha-test edge does not fringe toward black. */
  const idx = (x, y) => (y * size + x) * 4;
  const src = new Uint8ClampedArray(d);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = idx(x, y);
        if (src[i + 3] > 8) continue;
        let r = 0, gq = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
            const j = idx(xx, yy);
            if (src[j + 3] > 8) { r += src[j]; gq += src[j + 1]; b += src[j + 2]; n++; }
          }
        }
        if (n) { d[i] = r / n; d[i + 1] = gq / n; d[i + 2] = b / n; }
      }
    }
    src.set(d);
  }
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Tileable succulent skin: waxy green-grey with vertical fibre striations and
 * a dusty bloom. Used by yucca / agave / prickly pear / saguaro geometry.
 */
export function makePlantSkin(size = 256, seed = 5, tint = [96, 112, 78]) {
  const { c, g } = canvas2d(size);
  const rnd = streamRng(seed * 15731 + 7);
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      /* vertical fibres + a slow blotch */
      const fib = Math.sin(u * Math.PI * 2 * 26 + Math.sin(v * 9) * 1.2) * 0.5 + 0.5;
      const blotch = Math.sin(u * Math.PI * 2 * 3 + 1.3) * Math.sin(v * Math.PI * 2 * 2.2) * 0.5 + 0.5;
      const grain = rnd();
      const k = 0.72 + fib * 0.16 + blotch * 0.16 + grain * 0.10;
      const i = (y * size + x) * 4;
      d[i] = tint[0] * k;
      d[i + 1] = tint[1] * k;
      d[i + 2] = tint[2] * k * (0.94 + blotch * 0.12);
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
