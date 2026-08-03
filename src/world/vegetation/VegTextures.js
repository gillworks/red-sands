import * as THREE from 'three';
import { rng } from '../../core/Context.js';

/**
 * Procedural foliage atlases, drawn with Canvas2D at boot.
 *
 * Everything here is authored in sRGB and flagged `SRGBColorSpace`; the alpha
 * channel is the cut-out.
 *
 * THREE THINGS MATTER MORE THAN THEY LOOK LIKE THEY SHOULD, and pass 2 got two
 * of them wrong:
 *
 *  1. RGB is *dilated* outward into the transparent region before upload. A
 *     canvas leaves RGB = 0 wherever alpha = 0, so bilinear magnification bleeds
 *     black into the leaf edges.
 *
 *  2. THE MIP CHAIN IS BUILT HERE, NOT BY THE GPU. `glGenerateMipmap` does a
 *     straight box filter on *unassociated* RGBA, which is wrong twice over:
 *       - RGB averages in the black of the transparent texels, so a needle spray
 *         that is 8% covered turns coal-black three mips down. That is exactly
 *         the "hundreds of isolated black speckle pixels across the canopy"
 *         forensic finding — a texel whose alpha survived the cutoff carrying
 *         RGB that had been averaged 90% toward black.
 *       - Alpha averages toward the tile's mean coverage, so a fixed alphaTest
 *         erases distant foliage. Pass 2 compensated by relaxing the cutoff to
 *         0.10 with distance, which made the *whole card* pass instead — the
 *         "flat, untextured grey-brown quads stuck on as leaves" finding.
 *     Both vanish if the chain is built with alpha-WEIGHTED colour (Porter-Duff
 *     associated downsample) and per-tile coverage renormalisation (Castano:
 *     rescale each level's alpha so the fraction of texels above the cutoff is
 *     the same as level 0). Then one constant alphaTest is correct at every
 *     distance, and RGB never darkens.
 *
 *  3. The chain STOPS while a tile is still ~8 texels wide. Past that a tile
 *     bleeds into its neighbours in the atlas, and there is nothing to see
 *     anyway — the impostor has taken over. GL clamps LOD to the last level we
 *     upload, so this is free.
 *
 * Palette discipline (CONTRACTS §5): every green is pulled toward olive / sage /
 * straw — hue 60-95°, saturation under ~35%. There is no emerald anywhere.
 */

/* ------------------------------------------------------------------ utils */

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { canvas: c, g: c.getContext('2d', { willReadFrequently: true }) };
}

function hsl(h, s, l, a = 1) {
  return `hsla(${h.toFixed(1)},${(s * 100).toFixed(1)}%,${(l * 100).toFixed(1)}%,${a})`;
}

/** Push RGB outward into transparent texels so magnification cannot bleed black. */
function dilate(g, w, h, passes = 5) {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const src = new Uint8ClampedArray(d);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (src[i + 3] > 8) continue;
        let r = 0, gg = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const j = (yy * w + xx) * 4;
            if (src[j + 3] <= 8 && !(src[j] | src[j + 1] | src[j + 2])) continue;
            r += src[j]; gg += src[j + 1]; b += src[j + 2]; n++;
          }
        }
        if (n) { d[i] = r / n; d[i + 1] = gg / n; d[i + 2] = b / n; }
      }
    }
    src.set(d);
  }
  g.putImageData(img, 0, 0);
  return img;
}

/* ------------------------------------------- coverage-preserving mip chain */

/** Fraction of texels in one atlas tile whose alpha clears `cut`. */
function tileCoverage(buf, w, h, x0, y0, tw, th, cut, scale) {
  let n = 0, hit = 0;
  const stride = Math.max(1, Math.floor(Math.sqrt((tw * th) / 24000)));
  for (let y = y0; y < y0 + th; y += stride) {
    for (let x = x0; x < x0 + tw; x += stride) {
      n++;
      if (buf[(y * w + x) * 4 + 3] * scale >= cut) hit++;
    }
  }
  return n ? hit / n : 0;
}

/** Castano alpha renormalisation, applied per atlas tile. */
function rescaleCoverage(buf, w, h, cols, rows, cut, target) {
  const tw = (w / cols) | 0, th = (h / rows) | 0;
  if (tw < 2 || th < 2) return;
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const want = target[ty * cols + tx];
      if (want <= 0.0005) continue;
      const x0 = tx * tw, y0 = ty * th;
      let lo = 0.25, hi = 24.0, s = 1.0;
      for (let it = 0; it < 12; it++) {
        s = (lo + hi) * 0.5;
        const c = tileCoverage(buf, w, h, x0, y0, tw, th, cut, s);
        if (c < want) lo = s; else hi = s;
      }
      s = (lo + hi) * 0.5;
      if (Math.abs(s - 1) < 0.02) continue;
      for (let y = y0; y < y0 + th; y++) {
        for (let x = x0; x < x0 + tw; x++) {
          const i = (y * w + x) * 4 + 3;
          buf[i] = Math.min(1, buf[i] * s);
        }
      }
    }
  }
}

/** Float RGBA -> Uint8 RGBA, optionally flipped (DataTexture has flipY = false). */
function pack(buf, w, h, flip) {
  const out = new Uint8Array(w * h * 4);
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    const sy = (flip ? (h - 1 - y) : y) * row;
    const dy = y * row;
    for (let x = 0; x < row; x++) {
      const v = buf[sy + x] * 255 + 0.5;
      out[dy + x] = v < 0 ? 0 : (v > 255 ? 255 : v | 0);
    }
  }
  return { data: out, width: w, height: h };
}

/** Byte-exact level 0: just a row flip, no float round-trip. */
function pack0(src, w, h, flip) {
  const row = w * 4;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = (flip ? (h - 1 - y) : y) * row;
    out.set(src.subarray(sy, sy + row), y * row);
  }
  return { data: out, width: w, height: h };
}

/**
 * Alpha-weighted, coverage-preserving mip chain.
 *
 * @param {Uint8Array|Uint8ClampedArray} src  level 0, straight (unassociated) RGBA
 * @param {number} cols,rows       atlas tiling, for per-tile coverage matching
 * @param {number} cut             the alphaTest the shaders will actually use
 * @param {number} minTile         stop once a tile is this many texels wide
 * @param {boolean} flip           flip rows (canvas sources are top-down)
 */
export function buildMipChainRGBA(src, w, h, cols, rows, cut, minTile = 8, flip = true) {
  let cur = new Float32Array(w * h * 4);
  for (let i = 0, n = w * h * 4; i < n; i++) cur[i] = src[i] / 255;

  const tw0 = (w / cols) | 0, th0 = (h / rows) | 0;
  const target = new Float32Array(cols * rows);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      target[ty * cols + tx] =
        tileCoverage(cur, w, h, tx * tw0, ty * th0, tw0, th0, cut, 1);
    }
  }

  const levels = [pack0(src, w, h, flip)];
  let cw = w, ch = h;
  while (cw > 2 && ch > 2) {
    const nw = cw >> 1, nh = ch >> 1;
    if (nw / cols < minTile || nh / rows < minTile) break;
    const nxt = new Float32Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let sr = 0, sg = 0, sb = 0, sa = 0, fr = 0, fg = 0, fb = 0;
        for (let dy = 0; dy < 2; dy++) {
          const sy = y * 2 + dy;
          for (let dx = 0; dx < 2; dx++) {
            const j = (sy * cw + x * 2 + dx) * 4;
            const a = cur[j + 3];
            sr += cur[j] * a; sg += cur[j + 1] * a; sb += cur[j + 2] * a; sa += a;
            fr += cur[j]; fg += cur[j + 1]; fb += cur[j + 2];
          }
        }
        const k = (y * nw + x) * 4;
        if (sa > 1e-4) { nxt[k] = sr / sa; nxt[k + 1] = sg / sa; nxt[k + 2] = sb / sa; }
        else { nxt[k] = fr * 0.25; nxt[k + 1] = fg * 0.25; nxt[k + 2] = fb * 0.25; }
        nxt[k + 3] = sa * 0.25;
      }
    }
    rescaleCoverage(nxt, nw, nh, cols, rows, cut, target);
    levels.push(pack(nxt, nw, nh, flip));
    cur = nxt; cw = nw; ch = nh;
  }
  return levels;
}

/** Wrap a finished mip chain in a DataTexture that uploads it verbatim. */
export function textureFromChain(chain, srgb, aniso) {
  const t = new THREE.DataTexture(chain[0].data, chain[0].width, chain[0].height,
    THREE.RGBAFormat, THREE.UnsignedByteType);
  t.mipmaps = chain;
  t.generateMipmaps = false;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso;
  t.flipY = false;
  t.premultiplyAlpha = false;
  t.unpackAlignment = 4;
  t.needsUpdate = true;
  return t;
}

/* --------------------------------------------------------------- drawing */

/** One tapered, slightly curved grass blade. */
function drawBlade(g, x0, y0, len, wid, lean, hue, sat, li, r, seedProb = 0.16) {
  const tipX = x0 + lean * len;
  const tipY = y0 - len;
  const cx = x0 + lean * len * 0.28;
  const cy = y0 - len * 0.62;
  const steps = 9;
  const L = [], R = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const px = mt * mt * x0 + 2 * mt * t * cx + t * t * tipX;
    const py = mt * mt * y0 + 2 * mt * t * cy + t * t * tipY;
    const tx = 2 * mt * (cx - x0) + 2 * t * (tipX - cx);
    const ty = 2 * mt * (cy - y0) + 2 * t * (tipY - cy);
    const l = Math.hypot(tx, ty) || 1;
    const nx = -ty / l, ny = tx / l;
    const w = wid * (1 - t * t * 0.94) * (0.55 + 0.45 * Math.sin(t * 2.4));
    L.push([px + nx * w, py + ny * w]);
    R.push([px - nx * w, py - ny * w]);
  }
  const grd = g.createLinearGradient(x0, y0, tipX, tipY);
  grd.addColorStop(0, hsl(hue - 6, sat * 1.15, li * 0.44));
  grd.addColorStop(0.35, hsl(hue - 2, sat, li * 0.84));
  grd.addColorStop(0.78, hsl(hue + 4, sat * 0.9, li * 1.1));
  grd.addColorStop(1, hsl(hue + 12, sat * 0.62, Math.min(0.82, li * 1.38)));
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(L[0][0], L[0][1]);
  for (let i = 1; i <= steps; i++) g.lineTo(L[i][0], L[i][1]);
  for (let i = steps; i >= 0; i--) g.lineTo(R[i][0], R[i][1]);
  g.closePath();
  g.fill();
  // centre rib: a darker hairline gives the blade a fold
  g.strokeStyle = hsl(hue - 8, sat * 1.2, li * 0.56, 0.55);
  g.lineWidth = Math.max(0.6, wid * 0.24);
  g.beginPath();
  g.moveTo(x0, y0);
  g.quadraticCurveTo(cx, cy, tipX, tipY);
  g.stroke();
  // a bleached edge highlight down one side — blades catch light on the fold
  g.strokeStyle = hsl(hue + 14, sat * 0.5, Math.min(0.86, li * 1.5), 0.34);
  g.lineWidth = Math.max(0.5, wid * 0.18);
  g.beginPath();
  g.moveTo(L[0][0], L[0][1]);
  for (let i = 1; i <= steps; i++) g.lineTo(L[i][0], L[i][1]);
  g.stroke();
  // occasional seed head
  if (r() < seedProb) {
    g.fillStyle = hsl(hue + 16, sat * 0.5, Math.min(0.72, li * 1.3), 0.92);
    for (let i = 0; i < 7; i++) {
      const t = 0.72 + i * 0.04;
      const mt = 1 - t;
      const px = mt * mt * x0 + 2 * mt * t * cx + t * t * tipX;
      const py = mt * mt * y0 + 2 * mt * t * cy + t * t * tipY;
      g.beginPath();
      g.ellipse(px + (r() - 0.5) * wid, py, wid * 0.55, wid * 1.15, lean, 0, 6.283);
      g.fill();
    }
  }
}

/**
 * A drooping seed head — the panicle of a bunchgrass gone to seed. Distinct
 * from the little ellipses drawBlade sprinkles on a stalk: this is the whole
 * nodding structure, which is a silhouette you read at ten metres and one of
 * the things that makes a reference sward look like a species and not a fill.
 */
function drawSeedHead(g, x0, y0, len, lean, hue, sat, li, r) {
  const tipX = x0 + lean * len * 1.25;
  const tipY = y0 - len;
  const cx = x0 + lean * len * 0.18;
  const cy = y0 - len * 0.66;
  const at = (t) => {
    const mt = 1 - t;
    return [mt * mt * x0 + 2 * mt * t * cx + t * t * tipX,
      mt * mt * y0 + 2 * mt * t * cy + t * t * tipY];
  };
  // culm
  g.strokeStyle = hsl(hue - 4, sat * 0.9, li * 0.72);
  g.lineWidth = Math.max(0.7, len * 0.008);
  g.beginPath();
  g.moveTo(x0, y0);
  g.quadraticCurveTo(cx, cy, tipX, tipY);
  g.stroke();
  // spikelets fanning off the top third
  const n = 9 + ((r() * 7) | 0);
  for (let i = 0; i < n; i++) {
    const t = 0.60 + 0.40 * (i / n);
    const [px, py] = at(t);
    const side = i % 2 === 0 ? 1 : -1;
    const sl = len * (0.10 + 0.13 * r()) * (1 - (t - 0.6) * 0.8);
    const ang = side * (0.55 + r() * 0.55) + lean * 0.6;
    g.strokeStyle = hsl(hue + 12, sat * 0.6, Math.min(0.80, li * (1.15 + r() * 0.3)),
      0.85);
    g.lineWidth = Math.max(0.6, len * 0.012);
    g.beginPath();
    g.moveTo(px, py);
    g.quadraticCurveTo(px + Math.sin(ang) * sl * 0.6, py - Math.cos(ang) * sl * 0.4,
      px + Math.sin(ang) * sl, py + Math.abs(Math.cos(ang)) * sl * 0.35);
    g.stroke();
  }
}

/** One rounded broadleaf leaf on a short petiole, splayed from the base. */
function drawForbLeaf(g, x0, y0, len, wid, ang, hue, sat, li) {
  const dx = Math.sin(ang), dy = -Math.cos(ang);
  const bx = x0 + dx * len * 0.26, by = y0 + dy * len * 0.26;
  const tipX = x0 + dx * len, tipY = y0 + dy * len;
  g.strokeStyle = hsl(hue - 12, sat * 0.75, li * 0.62);
  g.lineWidth = Math.max(0.7, wid * 0.26);
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(bx, by);
  g.stroke();
  const cx = (bx + tipX) * 0.5, cy = (by + tipY) * 0.5;
  const grd = g.createLinearGradient(bx, by, tipX, tipY);
  grd.addColorStop(0, hsl(hue - 5, sat * 1.15, li * 0.60));
  grd.addColorStop(0.55, hsl(hue, sat, li));
  grd.addColorStop(1, hsl(hue + 9, sat * 0.72, Math.min(0.80, li * 1.28)));
  g.fillStyle = grd;
  g.beginPath();
  g.ellipse(cx, cy, wid, len * 0.37, Math.PI - ang, 0, 6.2832);
  g.fill();
  // midrib
  g.strokeStyle = hsl(hue - 10, sat * 1.1, li * 0.70, 0.6);
  g.lineWidth = Math.max(0.5, wid * 0.16);
  g.beginPath();
  g.moveTo(bx, by);
  g.lineTo(tipX, tipY);
  g.stroke();
}

/** A woody sage sprig: stiff stem, small paired silver-grey leaves. */
function drawSprig(g, x0, y0, len, ang, hue, sat, li, r) {
  const dx = Math.sin(ang), dy = -Math.cos(ang);
  g.strokeStyle = hsl(36, 0.14, 0.34);
  g.lineWidth = Math.max(0.9, len * 0.024);
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x0 + dx * len, y0 + dy * len);
  g.stroke();
  const pairs = 4 + ((r() * 4) | 0);
  for (let i = 0; i < pairs; i++) {
    const t = 0.24 + 0.74 * (i / pairs);
    const px = x0 + dx * len * t, py = y0 + dy * len * t;
    const ll = len * (0.16 + 0.13 * r()) * (1.05 - t * 0.35);
    for (let s = -1; s <= 1; s += 2) {
      const a = ang + s * (0.75 + r() * 0.35);
      const ex = px + Math.sin(a) * ll, ey = py - Math.cos(a) * ll;
      g.fillStyle = hsl(hue + (r() - 0.5) * 10, sat * (0.8 + r() * 0.5),
        li * (0.86 + r() * 0.34));
      g.beginPath();
      g.ellipse((px + ex) * 0.5, (py + ey) * 0.5, ll * 0.24, ll * 0.52,
        Math.PI - a, 0, 6.2832);
      g.fill();
    }
  }
}

/**
 * A flowering stem. `kind` 0 = flat umbel (yarrow), 1 = daisy, 2 = spike.
 * These are the colour accents; the reference uses them sparingly and so does
 * the placement, so a tile only ever carries two or three heads.
 */
function drawFlower(g, x0, y0, len, lean, kind, fh, fs, fl, r) {
  const tipX = x0 + lean * len, tipY = y0 - len;
  g.strokeStyle = hsl(74, 0.17, 0.36);
  g.lineWidth = Math.max(0.8, len * 0.020);
  g.beginPath();
  g.moveTo(x0, y0);
  g.quadraticCurveTo(x0 + lean * len * 0.2, y0 - len * 0.6, tipX, tipY);
  g.stroke();
  const R = len * 0.115;
  if (kind === 0) {
    for (let i = 0; i < 9; i++) {
      const a = r() * 6.2832, rr = Math.sqrt(r()) * R;
      g.fillStyle = hsl(fh + (r() - 0.5) * 8, fs * (0.7 + r() * 0.6),
        Math.min(0.96, fl * (0.88 + r() * 0.28)));
      g.beginPath();
      g.ellipse(tipX + Math.cos(a) * rr, tipY + Math.sin(a) * rr * 0.55,
        R * 0.30, R * 0.22, 0, 0, 6.2832);
      g.fill();
    }
  } else if (kind === 1) {
    const petals = 7 + ((r() * 3) | 0);
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * 6.2832 + r() * 0.3;
      g.fillStyle = hsl(fh + (r() - 0.5) * 6, fs, Math.min(0.96, fl * (0.9 + r() * 0.2)));
      g.beginPath();
      g.ellipse(tipX + Math.cos(a) * R * 0.55, tipY + Math.sin(a) * R * 0.55,
        R * 0.24, R * 0.50, a + Math.PI * 0.5, 0, 6.2832);
      g.fill();
    }
    g.fillStyle = hsl(46, 0.55, 0.56);
    g.beginPath();
    g.arc(tipX, tipY, R * 0.28, 0, 6.2832);
    g.fill();
  } else {
    for (let i = 0; i < 11; i++) {
      const t = i / 11;
      const px = tipX - lean * len * 0.22 * t, py = tipY + len * 0.30 * t;
      const rr = R * 0.34 * (1 - t * 0.5);
      g.fillStyle = hsl(fh + (r() - 0.5) * 10, fs * (0.75 + r() * 0.5),
        Math.min(0.94, fl * (0.85 + r() * 0.3)));
      g.beginPath();
      g.ellipse(px + (r() - 0.5) * R * 0.4, py, rr, rr * 0.8, 0, 0, 6.2832);
      g.fill();
    }
  }
}

/* ------------------------------------------------------------ wildflowers */

/**
 * WILDFLOWER TILES — seven species of the 19th-century American West, one per
 * atlas column, drawn as a whole flowering stalk (roots at the bottom of the
 * cell, head at the top) so a single card is a plant rather than a decal.
 *
 * THE COLOUR RULE. Every hue below is deliberately several steps down in
 * saturation and lightness from the botanical truth. Indian paintbrush is a
 * brick-scarlet, not a fire-engine red; the whites top out at 0.78 lightness
 * because at golden hour a 0.9-lightness disc is the brightest thing in the
 * frame and reads as a rendering bug, not a flower. The pop is supposed to come
 * from a warm hue sitting against sage and straw — from CONTRAST, not chroma.
 */

/** A slightly curved stalk. Returns the tip, which is where the head goes. */
function drawStem(g, x0, y0, len, lean, w, hue, sat, li) {
  const tipX = x0 + lean * len, tipY = y0 - len;
  g.strokeStyle = hsl(hue, sat, li);
  g.lineWidth = Math.max(0.8, w);
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(x0, y0);
  g.quadraticCurveTo(x0 + lean * len * 0.18, y0 - len * 0.58, tipX, tipY);
  g.stroke();
  return [tipX, tipY];
}

function petal(g, x, y, rx, ry, a, hue, sat, li, alpha = 1) {
  g.fillStyle = hsl(hue, sat, li, alpha);
  g.beginPath();
  g.ellipse(x, y, rx, ry, a, 0, 6.2832);
  g.fill();
}

/** The rosette of dull sage-olive leaves every one of these plants sits in. */
function basalLeaves(g, T, r, o) {
  for (let i = 0; i < o.n; i++) {
    const bx = T * (0.22 + 0.56 * r());
    const a = (r() - 0.5) * 2.3;
    const ln = T * o.len * (0.58 + r() * 0.84);
    drawForbLeaf(g, bx, T * (0.985 - r() * 0.02), ln, ln * (0.13 + r() * 0.10), a,
      o.hue + (r() - 0.5) * 12, o.sat * (0.8 + r() * 0.5), o.li * (0.82 + r() * 0.4));
  }
}

/** Rayed head seen from slightly above — the y radius is squashed on purpose. */
function daisy(g, cx, cy, R, petals, hue, sat, li, ch, cs, cl, r, droop = 0) {
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * 6.2832 + r() * 0.22;
    const dy = droop * Math.max(0, Math.sin(a)) * R;
    petal(g, cx + Math.cos(a) * R * 0.60, cy + Math.sin(a) * R * 0.42 + dy,
      R * 0.22, R * 0.52, a + Math.PI * 0.5,
      hue + (r() - 0.5) * 7, sat * (0.85 + r() * 0.3),
      Math.min(0.80, li * (0.90 + r() * 0.22)));
  }
  g.fillStyle = hsl(ch, cs, cl);
  g.beginPath();
  g.ellipse(cx, cy, R * 0.30, R * 0.22, 0, 0, 6.2832);
  g.fill();
}

/* 0 — Indian paintbrush. Dense scarlet bracts in a short flame-shaped spike. */
function flPaintbrush(g, T, r) {
  basalLeaves(g, T, r, { hue: 78, sat: 0.14, li: 0.32, n: 7, len: 0.19 });
  const stems = 4 + ((r() * 3) | 0);
  for (let i = 0; i < stems; i++) {
    const x = T * (0.22 + 0.56 * ((i + 0.5) / stems + (r() - 0.5) * 0.18));
    const len = T * (0.50 + r() * 0.26);
    const lean = (r() - 0.5) * 0.28;
    const [tx, ty] = drawStem(g, x, T * 0.99, len, lean, T * 0.014, 76, 0.16, 0.30);
    const n = 9 + ((r() * 5) | 0);
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const px = tx - lean * len * 0.36 * t + (r() - 0.5) * T * 0.028;
      const py = ty + len * 0.34 * t;
      const rr = T * 0.038 * (1 - t * 0.34);
      petal(g, px, py, rr * 0.60, rr, (r() - 0.5) * 1.1,
        4 + r() * 12, 0.40 + r() * 0.14, 0.34 + r() * 0.14);
    }
    petal(g, tx, ty + T * 0.008, T * 0.023, T * 0.035, 0, 16, 0.30, 0.48);
  }
}

/* 1 — Desert marigold. Long bare stems, one yellow head each. */
function flMarigold(g, T, r) {
  basalLeaves(g, T, r, { hue: 80, sat: 0.10, li: 0.36, n: 8, len: 0.18 });
  const stems = 4 + ((r() * 3) | 0);
  for (let i = 0; i < stems; i++) {
    const x = T * (0.20 + 0.60 * ((i + 0.5) / stems + (r() - 0.5) * 0.20));
    const len = T * (0.56 + r() * 0.30);
    const lean = (r() - 0.5) * 0.34;
    const [tx, ty] = drawStem(g, x, T * 0.99, len, lean, T * 0.011, 74, 0.14, 0.34);
    daisy(g, tx, ty, T * (0.064 + r() * 0.024), 11,
      45 + r() * 6, 0.38, 0.56 + r() * 0.08, 40, 0.32, 0.38, r);
  }
}

/* 2 — Prairie coneflower. Upright dark cone, rays hanging off its shoulders. */
function flConeflower(g, T, r) {
  basalLeaves(g, T, r, { hue: 76, sat: 0.13, li: 0.33, n: 6, len: 0.21 });
  const stems = 3 + ((r() * 2) | 0);
  for (let i = 0; i < stems; i++) {
    const x = T * (0.24 + 0.52 * ((i + 0.5) / stems + (r() - 0.5) * 0.20));
    const len = T * (0.66 + r() * 0.26);
    const lean = (r() - 0.5) * 0.22;
    const [tx, ty] = drawStem(g, x, T * 0.99, len, lean, T * 0.011, 72, 0.15, 0.32);
    const ch = T * (0.064 + r() * 0.024);
    g.fillStyle = hsl(24, 0.24, 0.19);
    g.beginPath();
    g.ellipse(tx, ty - ch * 0.30, T * 0.019, ch * 0.55, 0, 0, 6.2832);
    g.fill();
    const petals = 6 + ((r() * 3) | 0);
    for (let k = 0; k < petals; k++) {
      const a = (k / petals) * 6.2832;
      petal(g, tx + Math.cos(a) * T * 0.032, ty + T * 0.036,
        T * 0.017, T * 0.035, Math.cos(a) * 0.45,
        44 + r() * 8, 0.36, 0.50 + r() * 0.08);
    }
  }
}

/* 3 — Evening primrose. Low four-petal cream cups over broad leaves. */
function flPrimrose(g, T, r) {
  basalLeaves(g, T, r, { hue: 82, sat: 0.15, li: 0.34, n: 9, len: 0.27 });
  const heads = 3 + ((r() * 3) | 0);
  for (let i = 0; i < heads; i++) {
    const x = T * (0.20 + 0.60 * ((i + 0.5) / heads + (r() - 0.5) * 0.22));
    const len = T * (0.26 + r() * 0.26);
    const [tx, ty] = drawStem(g, x, T * 0.99, len, (r() - 0.5) * 0.40, T * 0.012, 78, 0.16, 0.32);
    const R = T * (0.072 + r() * 0.026);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * 6.2832 + r() * 0.25;
      petal(g, tx + Math.cos(a) * R * 0.42, ty + Math.sin(a) * R * 0.30,
        R * 0.40, R * 0.33, a, 50 + r() * 8, 0.20 + r() * 0.10, 0.68 + r() * 0.07);
    }
    g.fillStyle = hsl(48, 0.40, 0.58);
    g.beginPath();
    g.ellipse(tx, ty, R * 0.15, R * 0.11, 0, 0, 6.2832);
    g.fill();
  }
}

/* 4 — Yarrow. A flat dirty-white plate on a stiff stem over ferny foliage. */
function flYarrow(g, T, r) {
  for (let i = 0; i < 10; i++) {
    drawSprig(g, T * (0.22 + 0.56 * r()), T * 0.99, T * (0.15 + r() * 0.16),
      (r() - 0.5) * 0.7, 84, 0.13, 0.34, r);
  }
  const stems = 4 + ((r() * 3) | 0);
  for (let i = 0; i < stems; i++) {
    const x = T * (0.20 + 0.60 * ((i + 0.5) / stems + (r() - 0.5) * 0.18));
    const len = T * (0.54 + r() * 0.28);
    const [tx, ty] = drawStem(g, x, T * 0.99, len, (r() - 0.5) * 0.16, T * 0.011, 80, 0.14, 0.34);
    const R = T * (0.070 + r() * 0.026);
    for (let k = 0; k < 16; k++) {
      const a = r() * 6.2832, rr = Math.sqrt(r()) * R;
      petal(g, tx + Math.cos(a) * rr, ty + Math.sin(a) * rr * 0.34,
        R * 0.22, R * 0.15, 0, 46 + r() * 10, 0.06 + r() * 0.06, 0.70 + r() * 0.07);
    }
  }
}

/* 5 — Lupine. Vertical raceme of paired blooms, muted blue-violet. */
function flLupine(g, T, r) {
  for (let i = 0; i < 5; i++) {
    const bx = T * (0.24 + 0.52 * r());
    for (let k = 0; k < 6; k++) {
      const ln = T * (0.10 + r() * 0.07);
      drawForbLeaf(g, bx, T * 0.94, ln, ln * 0.20,
        (k / 6 - 0.5) * 2.4 + (r() - 0.5) * 0.3, 80, 0.14, 0.34);
    }
  }
  const stems = 3 + ((r() * 2) | 0);
  for (let i = 0; i < stems; i++) {
    const x = T * (0.24 + 0.52 * ((i + 0.5) / stems + (r() - 0.5) * 0.20));
    const len = T * (0.60 + r() * 0.28);
    const lean = (r() - 0.5) * 0.16;
    const [tx, ty] = drawStem(g, x, T * 0.99, len, lean, T * 0.013, 76, 0.15, 0.32);
    const n = 14 + ((r() * 6) | 0);
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const py = ty + len * 0.42 * t;
      const w = T * 0.038 * (0.45 + t * 0.75);
      for (let s = -1; s <= 1; s += 2) {
        petal(g, tx - lean * len * 0.42 * t + s * w * 0.42 + (r() - 0.5) * T * 0.008, py,
          w * 0.40, w * 0.26, (r() - 0.5) * 0.6,
          250 + r() * 18, 0.20 + r() * 0.12, 0.40 + r() * 0.14);
      }
    }
  }
}

/* 6 — Globe mallow. Soft orange cups spaced along an arching stem. */
function flMallow(g, T, r) {
  basalLeaves(g, T, r, { hue: 74, sat: 0.11, li: 0.36, n: 7, len: 0.19 });
  const stems = 3 + ((r() * 3) | 0);
  for (let i = 0; i < stems; i++) {
    const x = T * (0.22 + 0.56 * ((i + 0.5) / stems + (r() - 0.5) * 0.20));
    const len = T * (0.52 + r() * 0.28);
    const lean = (r() - 0.5) * 0.50;
    const [tx, ty] = drawStem(g, x, T * 0.99, len, lean, T * 0.013, 72, 0.14, 0.32);
    const n = 5 + ((r() * 3) | 0);
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const px = tx - lean * len * 0.55 * t + (r() - 0.5) * T * 0.020;
      const py = ty + len * 0.48 * t;
      const R = T * (0.036 + r() * 0.016) * (1 - t * 0.25);
      for (let p = 0; p < 5; p++) {
        const a = (p / 5) * 6.2832 + r() * 0.3;
        petal(g, px + Math.cos(a) * R * 0.42, py + Math.sin(a) * R * 0.32,
          R * 0.42, R * 0.34, a, 18 + r() * 10, 0.34 + r() * 0.10, 0.48 + r() * 0.09);
      }
    }
  }
}

/* 7 — Prairie aster. Tiny pale-lilac rays; the quiet one between the drifts. */
function flAster(g, T, r) {
  basalLeaves(g, T, r, { hue: 80, sat: 0.15, li: 0.33, n: 8, len: 0.21 });
  const stems = 6 + ((r() * 4) | 0);
  for (let i = 0; i < stems; i++) {
    const x = T * (0.16 + 0.68 * r());
    const len = T * (0.32 + r() * 0.34);
    const [tx, ty] = drawStem(g, x, T * 0.99, len, (r() - 0.5) * 0.40, T * 0.009, 78, 0.14, 0.34);
    daisy(g, tx, ty, T * (0.036 + r() * 0.016), 9,
      268 + r() * 20, 0.13 + r() * 0.07, 0.66 + r() * 0.06, 48, 0.34, 0.54, r);
  }
}

export const FLOWER_COLS = 8;
export const FLOWER_CUTOFF = 0.42;
export const FLOWER_TILES = {
  paintbrush: 0, marigold: 1, coneflower: 2, primrose: 3,
  yarrow: 4, lupine: 5, mallow: 6, aster: 7,
};

/**
 * 8 x 1 atlas of flowering stalks. One row, so the whole sheet is 8 T x T and
 * the mip chain is coverage-matched per column at FLOWER_CUTOFF — which is what
 * lets Wildflowers.js dissolve a card by raising its alpha threshold with
 * distance instead of letting a sub-pixel petal alias.
 */
export function buildFlowerAtlas(seed, tile = 128, aniso = 8) {
  const T = tile, W = T * FLOWER_COLS, H = T;
  const { g } = makeCanvas(W, H);
  g.clearRect(0, 0, W, H);

  const recipes = [flPaintbrush, flMarigold, flConeflower, flPrimrose,
    flYarrow, flLupine, flMallow, flAster];

  const pad = Math.max(2, T * 0.012);
  for (let i = 0; i < FLOWER_COLS; i++) {
    g.save();
    g.beginPath();
    g.rect(i * T + pad, pad, T - pad * 2, T - pad * 2);
    g.clip();
    g.translate(i * T, 0);
    recipes[i](g, T, rng(seed + 65537 + i * 7723));
    g.restore();
  }

  const img = dilate(g, W, H, T >= 128 ? 2 : 3);
  return textureFromChain(
    buildMipChainRGBA(img.data, W, H, FLOWER_COLS, 1, FLOWER_CUTOFF, 8, true), true, aniso);
}

function bez(x0, y0, cx, cy, x1, y1, t) {
  const m = 1 - t;
  return [m * m * x0 + 2 * m * t * cx + t * t * x1,
    m * m * y0 + 2 * m * t * cy + t * t * y1];
}

/**
 * A single leaf blade, with structure.
 *
 * Pass 2's version was a two-arc silhouette filled with a linear gradient, and
 * the forensic report described the result precisely: "solid single-color cream
 * ovals and lozenges — no texture, no veins, no per-leaf shading variation".
 * Everything below exists to make one leaf survive a 2x zoom at hero distance:
 * an asymmetric curled outline, a midrib, five lateral veins with the correct
 * herringbone angle, a darker cuticle margin, a specular sheen on the side the
 * light would hit, and blotchy variegation so no two leaves fill flat.
 */
function drawLeaf(g, x, y, len, wid, ang, hue, sat, li, lobed, r) {
  if (len < 1.2) return;
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  const curl = (r() - 0.5) * 0.55;          // asymmetry: one side fatter
  const droop = (r() - 0.5) * 0.42 * wid;

  const grd = g.createLinearGradient(0, -wid, len, wid);
  grd.addColorStop(0, hsl(hue - 6, sat * 1.15, li * 0.60));
  grd.addColorStop(0.42, hsl(hue, sat, li));
  grd.addColorStop(1, hsl(hue + 11, sat * 0.76, Math.min(0.82, li * 1.26)));
  g.fillStyle = grd;

  const upper = wid * (1 + curl);
  const lower = wid * (1 - curl);
  g.beginPath();
  g.moveTo(0, 0);
  if (lobed > 0) {
    const n = 4;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const bx = len * t;
      const by = -upper * (0.35 + 0.65 * Math.sin(t * Math.PI)) * (i % 2 ? 1 : 0.55);
      g.quadraticCurveTo(len * (t - 0.5 / n), by * 1.5, bx, by * (i === n ? 0.1 : 1));
    }
    for (let i = n; i >= 1; i--) {
      const t = i / n;
      const bx = len * (t - 1 / n);
      const by = lower * (0.35 + 0.65 * Math.sin(t * Math.PI)) * (i % 2 ? 1 : 0.55);
      g.quadraticCurveTo(len * t, by * 1.5, bx, by);
    }
  } else {
    g.quadraticCurveTo(len * 0.40, -upper, len, droop);
    g.quadraticCurveTo(len * 0.44, lower, 0, 0);
  }
  g.closePath();
  g.fill();

  // --- variegation: two soft blotches, so the fill is never uniform
  g.save();
  g.clip();
  for (let i = 0; i < 2; i++) {
    const bx = len * (0.18 + r() * 0.7);
    const by = (r() - 0.5) * wid * 1.3;
    const br = wid * (0.5 + r() * 0.8);
    const rg = g.createRadialGradient(bx, by, 0, bx, by, br);
    const dk = r() < 0.5;
    rg.addColorStop(0, hsl(hue + (dk ? -8 : 14), sat * (dk ? 1.25 : 0.6),
      li * (dk ? 0.66 : 1.3), 0.5));
    rg.addColorStop(1, hsl(hue, sat, li, 0));
    g.fillStyle = rg;
    g.fillRect(-len, -len, len * 3, len * 3);
  }
  g.restore();

  // --- veins
  const vc = `hsla(${(hue - 12).toFixed(1)},${(sat * 95).toFixed(1)}%,${(li * 52).toFixed(1)}%,`;
  g.strokeStyle = vc + '0.5)';
  g.lineWidth = Math.max(0.45, wid * 0.10);
  g.beginPath();
  g.moveTo(0, 0);
  g.quadraticCurveTo(len * 0.5, droop * 0.4, len * 0.96, droop * 0.9);
  g.stroke();
  g.lineWidth = Math.max(0.35, wid * 0.055);
  g.strokeStyle = vc + '0.34)';
  const nv = 5;
  for (let i = 1; i <= nv; i++) {
    const t = i / (nv + 1);
    const px = len * t;
    const py = droop * t * 0.5;
    for (let s = -1; s <= 1; s += 2) {
      const ew = (s < 0 ? upper : lower) * (0.62 + 0.34 * Math.sin(t * Math.PI));
      g.beginPath();
      g.moveTo(px, py);
      g.quadraticCurveTo(px + len * 0.14, py + s * ew * 0.55,
        px + len * 0.22, py + s * ew * 0.92);
      g.stroke();
    }
  }
  // --- cuticle margin: a leaf edge is always darker than its middle
  g.strokeStyle = `hsla(${(hue - 14).toFixed(1)},${(sat * 110).toFixed(1)}%,${(li * 44).toFixed(1)}%,0.42)`;
  g.lineWidth = Math.max(0.5, wid * 0.14);
  g.beginPath();
  g.moveTo(0, 0);
  if (lobed > 0) {
    g.quadraticCurveTo(len * 0.4, -upper * 0.9, len, droop);
  } else {
    g.quadraticCurveTo(len * 0.40, -upper, len, droop);
    g.quadraticCurveTo(len * 0.44, lower, 0, 0);
  }
  g.stroke();
  // --- sheen
  if (r() < 0.55) {
    g.strokeStyle = `hsla(${(hue + 18).toFixed(1)},${(sat * 40).toFixed(1)}%,${Math.min(88, li * 168).toFixed(1)}%,0.28)`;
    g.lineWidth = Math.max(0.5, wid * 0.30);
    g.beginPath();
    g.moveTo(len * 0.16, -upper * 0.34);
    g.quadraticCurveTo(len * 0.46, -upper * 0.62, len * 0.78, -upper * 0.22);
    g.stroke();
  }
  g.restore();
}

/** Conifer needle fascicle sprayed along a twig. */
function drawNeedleSpray(g, x0, y0, x1, y1, hue, sat, li, r, dense = 1) {
  const dx = x1 - x0, dy = y1 - y0;
  const L = Math.hypot(dx, dy);
  if (L < 2) return;
  const ux = dx / L, uy = dy / L;
  const n = Math.max(12, (L * 0.62 * dense) | 0);
  g.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const t = 0.06 + (i / n) * 0.94;
    // Gaps. A perfectly regular fascicle reads as a printed fern frond; real
    // needle sprays are missing a fifth of their pairs and the silhouette is
    // ragged, which is what lets the light through a canopy.
    if (r() < 0.17) continue;
    const px = x0 + dx * t, py = y0 + dy * t;
    const nl = L * (0.085 + 0.055 * (1 - t)) * (0.55 + r() * 0.9);
    for (let s = -1; s <= 1; s += 2) {
      if (r() < 0.10) continue;
      const a = (0.72 + r() * 0.5) * s;
      const ca = Math.cos(a), sa = Math.sin(a);
      const vx = ux * ca - uy * sa, vy = ux * sa + uy * ca;
      const shade = 0.70 + r() * 0.55;
      const hj = hue + (r() - 0.5) * 14;
      g.strokeStyle = hsl(hj, sat * (0.8 + r() * 0.4), li * shade);
      g.lineWidth = Math.max(0.9, L * 0.010) * (0.7 + r() * 0.8);
      g.beginPath();
      g.moveTo(px, py);
      g.quadraticCurveTo(px + vx * nl * 0.55 + uy * nl * 0.1,
        py + vy * nl * 0.55 - ux * nl * 0.1,
        px + vx * nl, py + vy * nl);
      g.stroke();
      // a paler hairline on the sunward half of the needle
      if (r() < 0.4) {
        g.strokeStyle = hsl(hj + 10, sat * 0.5, Math.min(0.8, li * shade * 1.55), 0.5);
        g.lineWidth = Math.max(0.4, L * 0.004);
        g.beginPath();
        g.moveTo(px + vx * nl * 0.25, py + vy * nl * 0.25);
        g.lineTo(px + vx * nl * 0.85, py + vy * nl * 0.85);
        g.stroke();
      }
    }
  }
  // the twig itself
  g.strokeStyle = hsl(28, 0.24, 0.22);
  g.lineWidth = Math.max(1.2, L * 0.016);
  g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
}

function drawTwig(g, x0, y0, x1, y1, w, col) {
  g.strokeStyle = col;
  g.lineWidth = w;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(x0, y0);
  g.quadraticCurveTo((x0 + x1) * 0.5 + (y1 - y0) * 0.1, (y0 + y1) * 0.5 - (x1 - x0) * 0.1, x1, y1);
  g.stroke();
}

/* ------------------------------------------------------------ tile recipes */

/**
 * Broadleaf spray (cottonwood / willow / oak).
 *
 * The card is a *leafy twig tip*, not a disc of leaves: shoots fan out from the
 * base of the tile and leaves alternate along each shoot, shrinking toward the
 * ends. That is what real foliage cards look like, and it is the difference
 * between a canopy that reads as layered foliage and one that reads as a bunch
 * of green lollipops.
 */
function tileBroadleaf(g, S, r, opts) {
  const { hue, sat, li, count, leafLen, leafWid, lobed, spread, twigCol } = opts;
  const shoots = opts.shoots || 5;
  const perShoot = Math.max(4, Math.round(count / shoots));
  const bx = S * 0.5, by = S * 1.02;

  for (let s = 0; s < shoots; s++) {
    const spanT = shoots > 1 ? s / (shoots - 1) : 0.5;
    const a = -Math.PI * 0.5 + (spanT - 0.5) * (2.05 * spread / 0.42)
      + (r() - 0.5) * 0.30;
    const len = S * (0.62 + r() * 0.36) * (spread / 0.42);
    const curl = (r() - 0.5) * 0.85;
    const x1 = bx + Math.cos(a) * len;
    const y1 = by + Math.sin(a) * len;
    const cx = bx + Math.cos(a) * len * 0.5 - Math.sin(a) * len * curl * 0.5;
    const cy = by + Math.sin(a) * len * 0.5 + Math.cos(a) * len * curl * 0.5;

    g.strokeStyle = twigCol;
    g.lineCap = 'round';
    g.lineWidth = S * (0.010 - s * 0.0005);
    g.beginPath();
    g.moveTo(bx, by);
    g.quadraticCurveTo(cx, cy, x1, y1);
    g.stroke();

    for (let i = 1; i <= perShoot; i++) {
      const t = i / (perShoot + 0.4);
      const [px, py] = bez(bx, by, cx, cy, x1, y1, t);
      const [qx, qy] = bez(bx, by, cx, cy, x1, y1, Math.min(1, t + 0.06));
      const ta = Math.atan2(qy - py, qx - px);
      const side = (i % 2 === 0) ? 1 : -1;
      const spread2 = 0.62 + r() * 0.55;
      const taper = 1 - t * 0.42;
      const dry = r() < 0.14 ? 1 : 0;
      const shade = 0.62 + (1 - t) * 0.20 + r() * 0.46;
      // short petiole so the leaf is attached, not floating
      g.strokeStyle = twigCol;
      g.lineWidth = Math.max(0.6, S * 0.0035);
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + Math.cos(ta + side * spread2) * leafLen * S * 0.22,
        py + Math.sin(ta + side * spread2) * leafLen * S * 0.22);
      g.stroke();
      drawLeaf(g, px, py,
        leafLen * S * (0.72 + r() * 0.6) * taper,
        leafWid * S * (0.68 + r() * 0.62) * taper,
        ta + side * spread2,
        hue + (r() - 0.5) * 20 + dry * 18,
        sat * (0.68 + r() * 0.64) * (dry ? 0.68 : 1),
        Math.min(0.74, li * shade * (dry ? 1.32 : 1)),
        lobed, r);
      // a second leaf on the same node, mirrored, for density
      if (r() < 0.62) {
        drawLeaf(g, px, py,
          leafLen * S * (0.6 + r() * 0.55) * taper,
          leafWid * S * (0.6 + r() * 0.55) * taper,
          ta - side * (0.5 + r() * 0.6),
          hue + (r() - 0.5) * 20,
          sat * (0.68 + r() * 0.55),
          Math.min(0.7, li * (0.54 + r() * 0.44)),
          lobed, r);
      }
    }
  }
}

function tileConifer(g, S, r, opts) {
  const { hue, sat, li, sprays } = opts;
  const cx = S * 0.5;
  /* a main shoot up the middle of the card with side shoots off it — a pine
     branch tip, not a starburst */
  for (let i = 0; i < sprays; i++) {
    const t = sprays > 1 ? i / (sprays - 1) : 0.5;
    const a = -Math.PI * 0.5 + (t - 0.5) * 1.15 + (r() - 0.5) * 0.16;
    const len = S * (0.60 + r() * 0.30);
    const x0 = cx + (r() - 0.5) * S * 0.14;
    const y0 = S * (1.0 - r() * 0.06);
    const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len;
    drawNeedleSpray(g, x0, y0, x1, y1,
      hue + (r() - 0.5) * 10, sat * (0.8 + r() * 0.4),
      li * (0.72 + r() * 0.5), r, 1.0);
    /* side shoots */
    const branches = 2 + ((r() * 3) | 0);
    for (let b = 0; b < branches; b++) {
      const f = 0.20 + r() * 0.62;
      const px = x0 + (x1 - x0) * f, py = y0 + (y1 - y0) * f;
      const a2 = a + (r() < 0.5 ? -1 : 1) * (0.50 + r() * 0.45);
      const l2 = len * (0.30 + r() * 0.26);
      drawNeedleSpray(g, px, py, px + Math.cos(a2) * l2, py + Math.sin(a2) * l2,
        hue + (r() - 0.5) * 10, sat * (0.75 + r() * 0.4),
        li * (0.68 + r() * 0.5), r, 1.0);
    }
  }
}

/**
 * Twiggy desert shrub — sage, juniper, rabbitbrush.
 *
 * Pass 2 scattered free-floating ellipses in a disc, which the forensic report
 * caught immediately ("individual leaves are solid single-color cream ovals and
 * lozenges"). Real scrub is a skeleton of pale woody twigs with leaves clustered
 * at the nodes, densest toward the middle and ragged at the edge, so the card
 * has a silhouette the alpha cutout can do something with.
 */
function tileScrub(g, S, r, opts) {
  const { hue, sat, li, count, leafLen } = opts;
  const woody = opts.woody || hsl(36, 0.14, 0.34);
  const bx = S * 0.5, by = S * 1.0;
  const stems = opts.stems || 7;
  const nodes = [];

  for (let s = 0; s < stems; s++) {
    const spanT = stems > 1 ? s / (stems - 1) : 0.5;
    const a = -Math.PI * 0.5 + (spanT - 0.5) * 1.85 + (r() - 0.5) * 0.30;
    const len = S * (0.55 + r() * 0.40);
    const curl = (r() - 0.5) * 0.7;
    const x1 = bx + Math.cos(a) * len, y1 = by + Math.sin(a) * len;
    const cx = bx + Math.cos(a) * len * 0.5 - Math.sin(a) * len * curl * 0.5;
    const cy = by + Math.sin(a) * len * 0.5 + Math.cos(a) * len * curl * 0.5;
    g.strokeStyle = woody;
    g.lineCap = 'round';
    g.lineWidth = S * 0.011 * (0.6 + r() * 0.7);
    g.beginPath();
    g.moveTo(bx, by);
    g.quadraticCurveTo(cx, cy, x1, y1);
    g.stroke();
    const sub = 2 + ((r() * 3) | 0);
    for (let k = 0; k < sub; k++) {
      const t = 0.35 + r() * 0.6;
      const [px, py] = bez(bx, by, cx, cy, x1, y1, t);
      const a2 = a + (r() < 0.5 ? -1 : 1) * (0.35 + r() * 0.55);
      const l2 = len * (0.22 + r() * 0.32);
      const qx = px + Math.cos(a2) * l2, qy = py + Math.sin(a2) * l2;
      g.lineWidth = S * 0.006 * (0.6 + r() * 0.7);
      g.beginPath(); g.moveTo(px, py); g.lineTo(qx, qy); g.stroke();
      for (let m = 0; m < 5; m++) {
        const tt = 0.15 + r() * 0.85;
        nodes.push([px + (qx - px) * tt, py + (qy - py) * tt, a2]);
      }
    }
    for (let k = 0; k < 7; k++) {
      const t = 0.20 + r() * 0.80;
      const [px, py] = bez(bx, by, cx, cy, x1, y1, t);
      nodes.push([px, py, a]);
    }
  }

  for (let i = 0; i < count; i++) {
    const nd = nodes[(r() * nodes.length) | 0];
    if (!nd) break;
    const jr = S * 0.035 * (0.3 + r());
    const ja = r() * 6.2831;
    const x = nd[0] + Math.cos(ja) * jr;
    const y = nd[1] + Math.sin(ja) * jr;
    drawLeaf(g, x, y, leafLen * S * (0.55 + r() * 0.9),
      leafLen * S * 0.30 * (0.45 + r() * 0.9),
      nd[2] + (r() - 0.5) * 1.9,
      hue + (r() - 0.5) * 16, sat * (0.65 + r() * 0.7),
      li * (0.62 + r() * 0.62), 0, r);
  }
}

function tileFern(g, S, r, opts) {
  const { hue, sat, li } = opts;
  const cx = S * 0.5;
  for (let f = 0; f < 4; f++) {
    const baseA = -Math.PI * 0.5 + (f - 1.5) * 0.42;
    const len = S * (0.72 + r() * 0.2);
    const x0 = cx + (r() - 0.5) * S * 0.14, y0 = S * 0.99;
    const x1 = x0 + Math.cos(baseA) * len, y1 = y0 + Math.sin(baseA) * len;
    drawTwig(g, x0, y0, x1, y1, S * 0.009, hsl(78, 0.2, 0.26));
    const n = 15;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
      const pl = S * 0.16 * Math.sin(t * 3.0) * (0.7 + r() * 0.5);
      for (let s = -1; s <= 1; s += 2) {
        drawLeaf(g, px, py, pl, pl * 0.30, baseA + s * 1.05,
          hue + (r() - 0.5) * 12, sat * (0.8 + r() * 0.3),
          li * (0.66 + t * 0.40), 0, r);
      }
    }
  }
}

function tileDeadBrush(g, S, r) {
  const cx = S * 0.5;
  for (let i = 0; i < 40; i++) {
    const a = -Math.PI * 0.5 + (r() - 0.5) * 2.7;
    const len = S * (0.3 + r() * 0.6);
    const x0 = cx + (r() - 0.5) * S * 0.26, y0 = S * (0.97 - r() * 0.12);
    const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len;
    drawTwig(g, x0, y0, x1, y1, S * 0.004 + r() * S * 0.005,
      hsl(34 + r() * 14, 0.14 + r() * 0.12, 0.24 + r() * 0.24));
    for (let k = 0; k < 3; k++) {
      const t = 0.4 + r() * 0.6;
      const px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
      const a2 = a + (r() - 0.5) * 1.5;
      drawTwig(g, px, py, px + Math.cos(a2) * len * 0.4, py + Math.sin(a2) * len * 0.4,
        S * 0.003 + r() * S * 0.004, hsl(36 + r() * 12, 0.15, 0.28 + r() * 0.22));
    }
  }
}

function tileFlowering(g, S, r) {
  tileScrub(g, S, r, {
    hue: 74, sat: 0.16, li: 0.42, count: 150, leafLen: 0.052, stems: 8,
    woody: hsl(38, 0.15, 0.36),
  });
  for (let i = 0; i < 52; i++) {
    const x = S * 0.5 + (r() - 0.5) * S * 0.78;
    const y = S * 0.40 + (r() - 0.5) * S * 0.58;
    const h = 44 + r() * 12;
    for (let k = 0; k < 7; k++) {
      /* Rabbitbrush in flower is a dusty sulphur, not a marigold. Pass 2's
         saturation read as cartoon yellow blobs across the midground. */
      g.fillStyle = hsl(h, 0.22 + r() * 0.14, 0.38 + r() * 0.18, 0.92);
      g.beginPath();
      g.ellipse(x + (r() - 0.5) * S * 0.05, y + (r() - 0.5) * S * 0.05,
        S * 0.011, S * 0.017, r() * 3.14, 0, 6.283);
      g.fill();
    }
  }
}

/* ------------------------------------------------------------------- API */

export const LEAF_TILES = {
  cottonwoodA: 0, cottonwoodB: 1, pineA: 2, pineB: 3,
  oakA: 4, oakB: 5, sage: 6, fern: 7,
  deadBrush: 8, rabbitbrush: 9, willow: 10, juniper: 11,
  dryGrass: 12, cottonwoodC: 13, oakC: 14, pineC: 15,
};

/** The alphaTest the foliage shaders use. Baked into the mip coverage. */
export const LEAF_CUTOFF = 0.46;
export const GRASS_CUTOFF = 0.42;

/** 4x4 atlas of foliage cut-outs shared by every tree and bush. */
export function buildLeafAtlas(seed, size = 1024, aniso = 8) {
  const S = size / 4;
  const { canvas, g } = makeCanvas(size, size);
  g.clearRect(0, 0, size, size);

  const recipes = [
    // 0 cottonwood A — broad, yellow-shifted olive
    (r) => tileBroadleaf(g, S, r, { hue: 72, sat: 0.24, li: 0.42, count: 84, shoots: 6, leafLen: 0.098, leafWid: 0.045, lobed: 0, spread: 0.46, twigCol: hsl(38, 0.18, 0.28) }),
    // 1 cottonwood B — sparser, drier
    (r) => tileBroadleaf(g, S, r, { hue: 62, sat: 0.22, li: 0.45, count: 66, shoots: 5, leafLen: 0.106, leafWid: 0.042, lobed: 0, spread: 0.48, twigCol: hsl(36, 0.16, 0.26) }),
    // 2 ponderosa needle spray
    (r) => tileConifer(g, S, r, { hue: 78, sat: 0.15, li: 0.32, sprays: 3 }),
    // 3 ponderosa needle spray, denser/darker
    (r) => tileConifer(g, S, r, { hue: 84, sat: 0.13, li: 0.27, sprays: 4 }),
    // 4 scrub oak A — small lobed, dusty olive
    (r) => tileBroadleaf(g, S, r, { hue: 60, sat: 0.19, li: 0.39, count: 104, shoots: 6, leafLen: 0.070, leafWid: 0.036, lobed: 1, spread: 0.46, twigCol: hsl(30, 0.16, 0.24) }),
    // 5 scrub oak B — browner, autumn-touched
    (r) => tileBroadleaf(g, S, r, { hue: 48, sat: 0.23, li: 0.41, count: 88, shoots: 5, leafLen: 0.076, leafWid: 0.038, lobed: 1, spread: 0.48, twigCol: hsl(28, 0.16, 0.22) }),
    // 6 sagebrush — silver-grey green
    (r) => tileScrub(g, S, r, { hue: 80, sat: 0.09, li: 0.46, count: 300, leafLen: 0.045, stems: 8, woody: hsl(40, 0.10, 0.40) }),
    // 7 fern
    (r) => tileFern(g, S, r, { hue: 84, sat: 0.20, li: 0.37 }),
    // 8 dead brush / twigs
    (r) => tileDeadBrush(g, S, r),
    // 9 rabbitbrush in flower
    (r) => tileFlowering(g, S, r),
    // 10 willow — narrow riparian leaves
    (r) => tileBroadleaf(g, S, r, { hue: 78, sat: 0.22, li: 0.42, count: 118, shoots: 6, leafLen: 0.115, leafWid: 0.022, lobed: 0, spread: 0.44, twigCol: hsl(40, 0.2, 0.3) }),
    // 11 juniper — dark scale foliage
    (r) => tileScrub(g, S, r, { hue: 94, sat: 0.15, li: 0.28, count: 330, leafLen: 0.040, stems: 9, woody: hsl(28, 0.16, 0.26) }),
    // 12 dry grass tuft
    (r) => {
      for (let i = 0; i < 26; i++) {
        drawBlade(g, S * (0.28 + r() * 0.44), S * 0.99, S * (0.42 + r() * 0.48),
          S * 0.012 * (0.7 + r() * 0.8), (r() - 0.5) * 0.5,
          46 + r() * 16, 0.20 + r() * 0.12, 0.42 + r() * 0.16, r);
      }
    },
    // 13 cottonwood C — big open cluster
    (r) => tileBroadleaf(g, S, r, { hue: 68, sat: 0.26, li: 0.47, count: 72, shoots: 5, leafLen: 0.112, leafWid: 0.050, lobed: 0, spread: 0.50, twigCol: hsl(38, 0.18, 0.28) }),
    // 14 scrub oak C — tight and dark
    (r) => tileBroadleaf(g, S, r, { hue: 66, sat: 0.17, li: 0.33, count: 128, shoots: 7, leafLen: 0.062, leafWid: 0.032, lobed: 1, spread: 0.44, twigCol: hsl(28, 0.14, 0.2) }),
    // 15 ponderosa spray, open
    (r) => tileConifer(g, S, r, { hue: 74, sat: 0.16, li: 0.35, sprays: 3 }),
  ];

  const pad = Math.max(2, S * 0.02);
  for (let i = 0; i < 16; i++) {
    const tx = (i % 4) * S, ty = Math.floor(i / 4) * S;
    g.save();
    g.beginPath();
    g.rect(tx + pad, ty + pad, S - pad * 2, S - pad * 2);
    g.clip();
    g.translate(tx, ty);
    recipes[i](rng(seed + i * 7919));
    g.restore();
  }

  const img = dilate(g, size, size, size >= 2048 ? 2 : size >= 1024 ? 3 : 5);
  return textureFromChain(
    buildMipChainRGBA(img.data, size, size, 4, 4, LEAF_CUTOFF, 8, true), true, aniso);
}

/**
 * Grass card atlas — 4 columns x 4 ROWS.
 *
 *   ROW = species. COLUMN = one of four variants of that species.
 *
 * That split is the whole point. Grass.js picks the ROW per instance from the
 * terrain (moisture, canopy, slope, aspect, altitude, region) and rotates the
 * COLUMN per instance to break repetition, so a tuft is always four different
 * arrangements of ONE plant instead of four different plants glued together.
 *
 *   0 TALL  bunch grass — coarse sage-olive culms, seed heads on two variants
 *   1 TURF  fine short turf — many thin blades, greener, low
 *   2 STRAW dry bleached straw — sparse, upright, pale, some broken stems
 *   3 FORB  low ground cover — broadleaf rosettes, a sage sprig, and the
 *           flowering variants that carry the white / pale-yellow / faint
 *           purple accents
 *
 * Each card carries several plants so one quad reads as a clump — that is what
 * buys apparent density an order of magnitude above the instance count.
 */
export const GRASS_SPECIES = 4;

export function buildGrassAtlas(seed, tile = 224, aniso = 16) {
  const COLS = 4, ROWS = GRASS_SPECIES;
  const T = tile;
  const W = T * COLS, H = T * ROWS;
  const { g } = makeCanvas(W, H);
  g.clearRect(0, 0, W, H);

  /* A field of blades sharing one species' character. */
  /*
   * EVERY tile fills the same fraction of its cell, whatever the species. The
   * card's world height is set by Grass.js's per-species multiplier; if the
   * atlas ALSO encoded height (turf drawn at 0.40 of the tile, tall grass at
   * 0.94) the two multiply and the short species come out at five centimetres —
   * flat green smears lying on the dirt, which is exactly what round 2 shipped.
   * One job per parameter: the tile says what the plant looks like, the shader
   * says how big it is.
   */
  const bunch = (o) => (gg, r) => {
    for (let i = 0; i < o.n; i++) {
      const t = (i + 0.5) / o.n;
      const x = T * (0.08 + 0.84 * t) + (r() - 0.5) * T * 0.07;
      const len = T * o.len * (0.56 + r() * 0.50);
      drawBlade(gg, x, T * 1.0, len, T * o.w * (0.68 + r() * 0.94),
        (r() - 0.5) * (o.lean || 0.7),
        o.hue + (r() - 0.5) * (o.hueJit || 18),
        o.sat * (0.66 + r() * 0.76),
        o.li * (0.70 + r() * 0.64), r, o.seed === undefined ? 0.10 : o.seed);
    }
    for (let i = 0; i < (o.heads || 0); i++) {
      const x = T * (0.16 + 0.68 * r());
      drawSeedHead(gg, x, T, T * o.len * (0.86 + r() * 0.30), (r() - 0.5) * 0.5,
        o.hue + 4, o.sat * 0.8, Math.min(0.74, o.li * 1.22), r);
    }
  };

  /* Low broadleaf rosette: a handful of splayed leaves close to the ground. */
  const rosette = (o) => (gg, r) => {
    const clumps = o.clumps || 4;
    for (let c = 0; c < clumps; c++) {
      const bx = T * (0.14 + 0.72 * ((c + 0.5) / clumps + (r() - 0.5) * 0.22));
      const by = T * (0.98 - r() * 0.05);
      const leaves = 5 + ((r() * 5) | 0);
      for (let i = 0; i < leaves; i++) {
        const a = (i / leaves - 0.5) * 2.3 + (r() - 0.5) * 0.4;
        const ln = T * o.len * (0.62 + r() * 0.62);
        drawForbLeaf(gg, bx, by, ln, ln * (0.17 + r() * 0.10), a,
          o.hue + (r() - 0.5) * 14, o.sat * (0.7 + r() * 0.6),
          o.li * (0.78 + r() * 0.5));
      }
    }
    // a few fine blades threaded through so it never reads as a leaf decal
    for (let i = 0; i < 10; i++) {
      drawBlade(gg, T * (0.08 + 0.84 * r()), T, T * (0.32 + r() * 0.42),
        T * 0.012 * (0.7 + r()), (r() - 0.5) * 0.9, 76 + r() * 12,
        0.16, 0.40 + r() * 0.14, r, 0.04);
    }
  };

  const recipes = [
    /* ---- ROW 0 : TALL BUNCH GRASS ------------------------------------- */
    bunch({ n: 15, hue: 68, sat: 0.17, li: 0.48, len: 0.94, w: 0.019, seed: 0.10 }),
    bunch({ n: 18, hue: 62, sat: 0.19, li: 0.51, len: 0.88, w: 0.017, seed: 0.14 }),
    bunch({ n: 12, hue: 66, sat: 0.16, li: 0.46, len: 0.96, w: 0.020, seed: 0.06, heads: 3 }),
    bunch({ n: 13, hue: 58, sat: 0.18, li: 0.53, len: 0.90, w: 0.018, seed: 0.06, heads: 4 }),
    /* ---- ROW 1 : FINE TURF -------------------------------------------- */
    bunch({ n: 30, hue: 80, sat: 0.21, li: 0.42, len: 0.86, w: 0.0125, lean: 1.0, seed: 0.02 }),
    bunch({ n: 26, hue: 84, sat: 0.23, li: 0.39, len: 0.90, w: 0.0135, lean: 1.1, seed: 0.02 }),
    bunch({ n: 34, hue: 76, sat: 0.19, li: 0.45, len: 0.80, w: 0.0120, lean: 1.2, seed: 0.0 }),
    bunch({ n: 24, hue: 88, sat: 0.24, li: 0.37, len: 0.92, w: 0.0145, lean: 0.9, seed: 0.03 }),
    /* ---- ROW 2 : DRY STRAW -------------------------------------------- */
    bunch({ n: 11, hue: 46, sat: 0.16, li: 0.64, len: 0.86, w: 0.022, lean: 0.42, seed: 0.12 }),
    bunch({ n: 13, hue: 42, sat: 0.18, li: 0.61, len: 0.78, w: 0.020, lean: 0.55, seed: 0.20 }),
    bunch({ n: 9, hue: 50, sat: 0.14, li: 0.67, len: 0.92, w: 0.024, lean: 0.34, seed: 0.08 }),
    bunch({ n: 14, hue: 44, sat: 0.17, li: 0.59, len: 0.70, w: 0.019, lean: 0.86, seed: 0.16 }),
    /* ---- ROW 3 : LOW FORB / SAGE / FLOWERS ----------------------------- */
    rosette({ hue: 86, sat: 0.22, li: 0.40, len: 0.66, clumps: 4 }),
    rosette({ hue: 80, sat: 0.19, li: 0.44, len: 0.58, clumps: 5 }),
    (gg, r) => {                                   // sage sprigs, stiff and grey
      for (let i = 0; i < 6; i++) {
        drawSprig(gg, T * (0.12 + 0.76 * ((i + 0.5) / 6 + (r() - 0.5) * 0.2)), T,
          T * (0.56 + r() * 0.36), (r() - 0.5) * 0.55, 80, 0.11, 0.50, r);
      }
      for (let i = 0; i < 10; i++) {
        drawBlade(gg, T * (0.08 + 0.84 * r()), T, T * (0.26 + r() * 0.34),
          T * 0.012, (r() - 0.5) * 0.8, 52 + r() * 10, 0.15, 0.52, r, 0.05);
      }
    },
    /* THE ONLY FLOWERING TILE IN THE SHEET. Grass.js will only ever rotate an
       instance onto this column inside a bloom patch, so the accents stay rare.
       Round 1 put flowers on two of four columns with no gate and the meadow
       came back looking like a garden centre. Heads are small and the whites
       are pulled down off paper-white — at golden hour a 0.9-lightness disc is
       the brightest thing in the frame and reads as a bug. */
    (gg, r) => {
      rosette({ hue: 82, sat: 0.19, li: 0.38, len: 0.52, clumps: 3 })(gg, r);
      drawFlower(gg, T * 0.28, T, T * (0.66 + r() * 0.22), (r() - 0.5) * 0.3, 1,
        50, 0.36, 0.74, r);
      drawFlower(gg, T * 0.54, T, T * (0.56 + r() * 0.22), (r() - 0.5) * 0.3, 2,
        278, 0.18, 0.58, r);
      drawFlower(gg, T * 0.76, T, T * (0.70 + r() * 0.22), (r() - 0.5) * 0.3, 0,
        54, 0.06, 0.78, r);
    },
  ];

  /*
   * DataTexture rows are flipped on upload (pack0 flip=true) so that a card's
   * v=0 is its base. That flip also reverses the ROW order, so species s is
   * drawn into canvas row ROWS-1-s and lands at v in [s/4, (s+1)/4) — which is
   * the range Grass.js indexes with its species id.
   */
  const pad = Math.max(2, T * 0.012);
  for (let s = 0; s < ROWS; s++) {
    const ry = ROWS - 1 - s;
    for (let c = 0; c < COLS; c++) {
      const tx = c * T, ty = ry * T;
      g.save();
      g.beginPath();
      g.rect(tx + pad, ty + pad, T - pad * 2, T - pad * 2);
      g.clip();
      g.translate(tx, ty);
      recipes[s * COLS + c](g, rng(seed + 104729 + (s * COLS + c) * 7817));
      g.restore();
    }
  }

  const img = dilate(g, W, H, T >= 192 ? 2 : 3);
  return textureFromChain(
    buildMipChainRGBA(img.data, W, H, COLS, ROWS, GRASS_CUTOFF, 8, true), true, aniso);
}
