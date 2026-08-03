import * as THREE from 'three';
import { SkinBuilder } from '../rig/SkinBuilder.js';

/**
 * RED SANDS — HORSE BUILD HELPERS
 * ============================================================================
 * Everything the horse's geometry needs that `SkinBuilder` deliberately does
 * not do, kept out of the shared builder so the rider is not affected:
 *
 *   TrackedBuilder   a thin wrapper that remembers the VERTEX RANGE every
 *                    primitive occupied, plus the hair-lay direction for that
 *                    range. Ranges are what make the two passes below able to
 *                    treat "the animal" and "the tack strapped to it"
 *                    differently inside a single merged mesh.
 *
 *   weldNormals()    SkinBuilder emits every primitive with its own vertices,
 *                    which is right for a boot on a trouser cuff and wrong for
 *                    the neck meeting the head. Coincident vertices inside the
 *                    ORGANIC set get their normals averaged, so a chain of
 *                    tubes shades as one continuous animal — and every tube
 *                    CAP stops reading as the flat disc that was sitting on
 *                    the end of the horse's muzzle.
 *
 *   relaxNormals()   one Laplacian pass over the shading normals only (never
 *                    the positions). This is the single cheapest cure for
 *                    "visible polygon facets across shoulder, barrel and
 *                    haunch": it removes the piecewise-constant banding a
 *                    swept superellipse leaves behind without touching the
 *                    silhouette, the AO or the anatomy.
 *
 *   aFlow            per-vertex object-space hair direction, consumed by
 *                    HorseCoat's shader so the coat's grain runs along the lay
 *                    of the hair — down the shoulder, back along the barrel,
 *                    down the legs — instead of along a fixed world axis.
 * ============================================================================
 */

export function lin(hex) {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const f = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return [f(r), f(g), f(b)];
}
export const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
export const mix3 = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
];
export const TAU = Math.PI * 2;
export function angDist(a) {
  return Math.abs(((a + Math.PI) % TAU + TAU) % TAU - Math.PI);
}

/** Surface classes understood by CharMaterial. */
export const HARD = 0, WOVEN = 1, HIDE = 2, STRAND = 3;

/**
 * A bay, pulled back from the orange it used to be.
 *
 * The old coat was 0x54371f, which under a 15:00 sun rendered as a saturated
 * traffic-cone orange against an art direction that asks for bleached ochre
 * and sage. Everything here is a shade cooler and a shade duller; the warmth
 * comes back through the sun-bleach term in the shader, where it belongs, and
 * the dapple carries the value break-up.
 */
export const HP = {
  coat: lin(0x4a3627),
  coatWarm: lin(0x5b432f),
  coatCool: lin(0x3c2c21),
  belly: lin(0x6a5340),
  flank: lin(0x55402e),
  points: lin(0x2a2018),
  muzzleSkin: lin(0x241b15),
  nostril: lin(0x140f0c),
  lip: lin(0x2d2119),
  eyeWhite: lin(0x3a3229),
  eye: lin(0x0d0a08),
  hoof: lin(0x40382e),
  hoofPale: lin(0x584d40),
  coronet: lin(0x2b2119),
  mane: lin(0x241b14),
  maneLit: lin(0x3d2f21),
  saddle: lin(0x5a3d24),
  saddleDark: lin(0x3b2716),
  blanket: lin(0x6d4736),
  blanketPale: lin(0x8f8068),
  steel: lin(0x6a6f74),
  canvas: lin(0x6a6151),
  rope: lin(0x9b8a63),
  gunmetal: lin(0x3a3d40),
};

/* ========================================================================== */

/**
 * Wraps SkinBuilder and records, for every primitive emitted through it:
 *   · the vertex range it occupied
 *   · whether it is part of the ANIMAL (weldable, relaxable, has hair flow)
 *     or of the TACK (left alone — leather should keep its hard edges)
 *   · a hair-lay function for that range
 */
export class TrackedBuilder {
  constructor() {
    this.B = new SkinBuilder();
    this.spans = [];
    this._organic = true;
    this._flow = null;
  }

  /** Everything emitted until the next call is animal (true) or tack (false). */
  organic(on) { this._organic = on; return this; }

  /**
   * Hair-lay for the next primitives. fn(x, y, z) -> [dx, dy, dz] in object
   * space; it does not have to be normalised.
   */
  flow(fn) { this._flow = fn; return this; }

  _span(fn) {
    const start = this.B.vertexCount;
    fn();
    const end = this.B.vertexCount;
    if (end > start) {
      this.spans.push({ start, end, organic: this._organic, flow: this._flow });
    }
  }

  surface(t) { this.B.surface(t); return this; }
  group(i) { this.B.group(i); return this; }
  get vertexCount() { return this.B.vertexCount; }

  tube(path, opts) { this._span(() => this.B.tube(path, opts)); return this; }
  blob(c, s, b, opts) { this._span(() => this.B.blob(c, s, b, opts)); return this; }
  sheet(c, r, fn, opts) { this._span(() => this.B.sheet(c, r, fn, opts)); return this; }
  box(c, h, b, opts) { this._span(() => this.B.box(c, h, b, opts)); return this; }
  ribbon(p, a, opts) { this._span(() => this.B.ribbon(p, a, opts)); return this; }

  /**
   * @returns {{geo:THREE.BufferGeometry, organic:Uint8Array}}
   *          `organic` is a per-vertex mask the smoothing passes below need.
   */
  build() {
    const geo = this.B.build();
    const nv = geo.attributes.position.count;
    const organic = new Uint8Array(nv);
    const flow = new Float32Array(nv * 3);
    const pos = geo.attributes.position.array;
    for (const s of this.spans) {
      for (let v = s.start; v < s.end && v < nv; v++) {
        organic[v] = s.organic ? 1 : 0;
        if (!s.flow) { flow[v * 3 + 2] = -1; continue; }
        const d = s.flow(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        const l = Math.hypot(d[0], d[1], d[2]) || 1;
        flow[v * 3] = d[0] / l; flow[v * 3 + 1] = d[1] / l; flow[v * 3 + 2] = d[2] / l;
      }
    }
    geo.setAttribute('aFlow', new THREE.BufferAttribute(flow, 3));
    return { geo, organic };
  }
}

/* ========================================================================== */

/**
 * Average the shading normals of coincident vertices inside the organic set.
 *
 * `eps` is a WELD radius, not a tolerance on authored positions: adjacent
 * sections are authored to land on the same ring on purpose, so 1.5 mm is
 * generous and will never pull two genuinely different surfaces together.
 * `cosLimit` refuses to weld across a genuine crease (the hoof wall against
 * the coronet, say) so hard edges that are supposed to be hard survive.
 */
export function weldNormals(geo, organic, { eps = 0.0015, cosLimit = -0.15 } = {}) {
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal.array;
  const nv = pos.length / 3;
  const inv = 1 / eps;
  const cells = new Map();
  const key = (i, j, k) => `${i},${j},${k}`;
  for (let v = 0; v < nv; v++) {
    if (!organic[v]) continue;
    const i = Math.round(pos[v * 3] * inv);
    const j = Math.round(pos[v * 3 + 1] * inv);
    const k = Math.round(pos[v * 3 + 2] * inv);
    const s = key(i, j, k);
    let a = cells.get(s);
    if (!a) cells.set(s, a = []);
    a.push(v);
  }
  const out = new Float32Array(nrm.length);
  out.set(nrm);
  for (const list of cells.values()) {
    if (list.length < 2) continue;
    // group by normal agreement so a fold does not get flattened
    const used = new Uint8Array(list.length);
    for (let a = 0; a < list.length; a++) {
      if (used[a]) continue;
      const va = list[a];
      let nx = nrm[va * 3], ny = nrm[va * 3 + 1], nz = nrm[va * 3 + 2];
      const grp = [va];
      used[a] = 1;
      for (let b = a + 1; b < list.length; b++) {
        if (used[b]) continue;
        const vb = list[b];
        const d = nrm[va * 3] * nrm[vb * 3] + nrm[va * 3 + 1] * nrm[vb * 3 + 1]
          + nrm[va * 3 + 2] * nrm[vb * 3 + 2];
        if (d < cosLimit) continue;
        used[b] = 1;
        grp.push(vb);
        nx += nrm[vb * 3]; ny += nrm[vb * 3 + 1]; nz += nrm[vb * 3 + 2];
      }
      if (grp.length < 2) continue;
      const l = Math.hypot(nx, ny, nz) || 1;
      for (const v of grp) {
        out[v * 3] = nx / l; out[v * 3 + 1] = ny / l; out[v * 3 + 2] = nz / l;
      }
    }
  }
  nrm.set(out);
  geo.attributes.normal.needsUpdate = true;
  return geo;
}

/**
 * One-ring Laplacian relaxation of the SHADING NORMALS only.
 *
 * A swept superellipse gives every quad a constant normal per corner; at 1:1
 * that reads as the flat panels the critic called out across the shoulder,
 * barrel and haunch. Blending each normal toward the mean of its topological
 * neighbours removes the banding while leaving the position buffer — and
 * therefore the silhouette, the AO bake and the skinning — untouched.
 *
 * Applied only to the organic set: a saddle skirt is supposed to have a hard
 * edge and this would round it off.
 */
export function relaxNormals(geo, organic, { iterations = 1, strength = 0.55 } = {}) {
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal.array;
  const idx = geo.index.array;
  const nv = pos.length / 3;

  // one-ring adjacency, CSR-style, built once
  const deg = new Uint16Array(nv);
  for (let t = 0; t < idx.length; t += 3) {
    deg[idx[t]] += 2; deg[idx[t + 1]] += 2; deg[idx[t + 2]] += 2;
  }
  const off = new Uint32Array(nv + 1);
  for (let v = 0; v < nv; v++) off[v + 1] = off[v] + deg[v];
  const adj = new Uint32Array(off[nv]);
  const cur = off.slice(0, nv);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    adj[cur[a]++] = b; adj[cur[a]++] = c;
    adj[cur[b]++] = c; adj[cur[b]++] = a;
    adj[cur[c]++] = a; adj[cur[c]++] = b;
  }

  const src = new Float32Array(nrm.length);
  for (let it = 0; it < iterations; it++) {
    src.set(nrm);
    for (let v = 0; v < nv; v++) {
      if (!organic[v]) continue;
      let x = 0, y = 0, z = 0, n = 0;
      const e = off[v + 1];
      for (let a = off[v]; a < e; a++) {
        const w = adj[a];
        if (!organic[w]) continue;
        // never average across a crease sharper than ~72 deg
        const d = src[v * 3] * src[w * 3] + src[v * 3 + 1] * src[w * 3 + 1]
          + src[v * 3 + 2] * src[w * 3 + 2];
        if (d < 0.31) continue;
        x += src[w * 3]; y += src[w * 3 + 1]; z += src[w * 3 + 2]; n++;
      }
      if (!n) continue;
      x /= n; y /= n; z /= n;
      let rx = src[v * 3] + (x - src[v * 3]) * strength;
      let ry = src[v * 3 + 1] + (y - src[v * 3 + 1]) * strength;
      let rz = src[v * 3 + 2] + (z - src[v * 3 + 2]) * strength;
      const l = Math.hypot(rx, ry, rz) || 1;
      nrm[v * 3] = rx / l; nrm[v * 3 + 1] = ry / l; nrm[v * 3 + 2] = rz / l;
    }
  }
  geo.attributes.normal.needsUpdate = true;
  return geo;
}

/**
 * Blur the baked vertex AO along the mesh's own one-ring.
 *
 * bakeVertexAO cone-traces against a voxel grid, so on a curved flank the
 * result is quantised to the grid and — interpolated across a 6 cm quad —
 * reads as blotchy panels rather than as occlusion. Two cheap smoothing
 * passes turn it back into the gradient it is supposed to be. This is the
 * "AO bake interpolated too coarsely" half of the faceting note.
 */
export function smoothAO(geo, organic, { iterations = 2, strength = 0.6 } = {}) {
  const aMat = geo.attributes.aMat.array;
  const idx = geo.index.array;
  const nv = geo.attributes.position.count;
  const deg = new Uint16Array(nv);
  for (let t = 0; t < idx.length; t += 3) {
    deg[idx[t]] += 2; deg[idx[t + 1]] += 2; deg[idx[t + 2]] += 2;
  }
  const off = new Uint32Array(nv + 1);
  for (let v = 0; v < nv; v++) off[v + 1] = off[v] + deg[v];
  const adj = new Uint32Array(off[nv]);
  const cur = off.slice(0, nv);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    adj[cur[a]++] = b; adj[cur[a]++] = c;
    adj[cur[b]++] = c; adj[cur[b]++] = a;
    adj[cur[c]++] = a; adj[cur[c]++] = b;
  }
  const src = new Float32Array(nv);
  for (let it = 0; it < iterations; it++) {
    for (let v = 0; v < nv; v++) src[v] = aMat[v * 4 + 2];
    for (let v = 0; v < nv; v++) {
      if (!organic[v]) continue;
      let s = 0, n = 0;
      for (let a = off[v], e = off[v + 1]; a < e; a++) { s += src[adj[a]]; n++; }
      if (!n) continue;
      aMat[v * 4 + 2] = src[v] + (s / n - src[v]) * strength;
    }
  }
  geo.attributes.aMat.needsUpdate = true;
  return geo;
}
