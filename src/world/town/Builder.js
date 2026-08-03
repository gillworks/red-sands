import * as THREE from 'three';

/**
 * Builder — a tiny world-space mesh accumulator for the settlement.
 *
 * Everything the town emits is static, so nothing is instanced: geometry is
 * appended into one bucket per material and merged into a single indexed
 * BufferGeometry at the end. Sixteen buildings, two hundred props, a street and
 * a boardwalk come out as ~15 draw calls.
 *
 * Vertex format:
 *   position  vec3   world metres
 *   normal    vec3
 *   uv        vec2   AUTHORED IN METRES / tileSize, so the wood grain is the
 *                    same physical size on every surface and no texture repeat
 *                    has to be touched (procTextures hands out shared textures).
 *   color     vec3   base tint multiplier — per-building paint, per-plank value
 *   aWear     vec4   x = metres above this object's ground line (dirt splash)
 *                    y = metres below its eave     (rain / rust streaking)
 *                    z = 0..1 grime, per object
 *                    w = 0..1 paint chalking / edge wear
 *
 * `aWear` is consumed by the weathering chunk in Wear.js, which runs per pixel
 * so the splash line and the sun bleaching do not depend on tessellation.
 */

const _a = [0, 0, 0];
const _b = [0, 0, 0];

function dist(p, q) {
  const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * A local building frame: an origin plus an in-plane "width" axis (ex) and an
 * outward "depth" axis (ez) in world XZ. `p(x, z, y)` maps local → world.
 * ez is always ex rotated +90°, which keeps every face-winding helper valid.
 */
export class Frame {
  constructor(ox, oy, oz, dx, dz) {
    const l = Math.hypot(dx, dz) || 1;
    this.ox = ox; this.oy = oy; this.oz = oz;
    this.ax = dx / l; this.az = dz / l;
    this.bx = -this.az; this.bz = this.ax;
  }

  p(x, z, y) {
    return [
      this.ox + this.ax * x + this.bx * z,
      this.oy + y,
      this.oz + this.az * x + this.bz * z,
    ];
  }

  /** Sub-frame: translated in local coords and rotated about Y by `rot` rad. */
  sub(x, z, y, rot = 0) {
    const o = this.p(x, z, y);
    const c = Math.cos(rot), s = Math.sin(rot);
    return new Frame(o[0], o[1], o[2],
      this.ax * c + this.bx * s, this.az * c + this.bz * s);
  }

  /** World direction of the local +x axis. */
  dirX() { return [this.ax, 0, this.az]; }
  dirZ() { return [this.bx, 0, this.bz]; }
}

export class Builder {
  constructor() {
    /** @type {Map<string, object>} */
    this.buckets = new Map();
    /** Default wear payload, overridable per call. */
    this.wear = [1, 4, 0.6, 0.4];
    this.col = [1, 1, 1];
  }

  bucket(name) {
    let b = this.buckets.get(name);
    if (!b) {
      b = { pos: [], nor: [], uv: [], col: [], wear: [], idx: [], n: 0 };
      this.buckets.set(name, b);
    }
    return b;
  }

  /**
   * Add a (possibly subdivided, possibly warped) quad.
   * Corners a→b→c→d anticlockwise seen from the front face.
   *   u runs a→b, v runs a→d.
   */
  quad(mat, a, b, c, d, o = {}) {
    const B = this.bucket(mat);
    const us = o.us || 1;
    const vs = o.vs || us;
    const uo = o.uo || 0;
    const vo = o.vo || 0;
    const uLen = 0.5 * (dist(a, b) + dist(d, c));
    const vLen = 0.5 * (dist(a, d) + dist(b, c));
    const warp = o.warp || null;
    const step = o.step || 3.0;
    const nu = Math.max(1, Math.min(48, o.nu != null ? o.nu : Math.ceil(uLen / step)));
    const nv = Math.max(1, Math.min(48, o.nv != null ? o.nv : Math.ceil(vLen / step)));
    const col = o.col || this.col;
    const wear = o.wear || this.wear;
    const base = wear[0];
    const eave = wear[1];
    const colFn = typeof col === 'function' ? col : null;

    const P = new Array((nu + 1) * (nv + 1));
    for (let j = 0; j <= nv; j++) {
      const t = j / nv;
      for (let i = 0; i <= nu; i++) {
        const s = i / nu;
        const w00 = (1 - s) * (1 - t), w10 = s * (1 - t);
        const w11 = s * t, w01 = (1 - s) * t;
        const p = [
          a[0] * w00 + b[0] * w10 + c[0] * w11 + d[0] * w01,
          a[1] * w00 + b[1] * w10 + c[1] * w11 + d[1] * w01,
          a[2] * w00 + b[2] * w10 + c[2] * w11 + d[2] * w01,
        ];
        if (warp) warp(s, t, p);
        P[j * (nu + 1) + i] = p;
      }
    }

    const base0 = B.n;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const p = P[j * (nu + 1) + i];
        // central-difference tangents so warped surfaces get real normals
        const iL = P[j * (nu + 1) + Math.max(0, i - 1)];
        const iR = P[j * (nu + 1) + Math.min(nu, i + 1)];
        const jD = P[Math.max(0, j - 1) * (nu + 1) + i];
        const jU = P[Math.min(nv, j + 1) * (nu + 1) + i];
        _a[0] = iR[0] - iL[0]; _a[1] = iR[1] - iL[1]; _a[2] = iR[2] - iL[2];
        _b[0] = jU[0] - jD[0]; _b[1] = jU[1] - jD[1]; _b[2] = jU[2] - jD[2];
        let nx = _a[1] * _b[2] - _a[2] * _b[1];
        let ny = _a[2] * _b[0] - _a[0] * _b[2];
        let nz = _a[0] * _b[1] - _a[1] * _b[0];
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        B.pos.push(p[0], p[1], p[2]);
        B.nor.push(nx, ny, nz);
        /* `rot` maps the texture's u axis onto the surface's VERTICAL axis, so
         * board-and-batten walls actually read as vertical boards. Without it a
         * plank texture stays horizontal no matter what us/vs are set to and the
         * barn siding contradicts its own battens. */
        const tU = (uo + (i / nu) * uLen) / us;
        const tV = (vo + (j / nv) * vLen) / vs;
        if (o.rot) B.uv.push(tV, tU); else B.uv.push(tU, tV);
        if (colFn) {
          const c3 = colFn(p, i / nu, j / nv);
          B.col.push(c3[0], c3[1], c3[2]);
        } else {
          B.col.push(col[0], col[1], col[2]);
        }
        B.wear.push(p[1] - base, eave - p[1], wear[2], wear[3]);
      }
    }
    B.n += (nu + 1) * (nv + 1);

    const row = nu + 1;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const k = base0 + j * row + i;
        B.idx.push(k, k + 1, k + row + 1, k, k + row + 1, k + row);
      }
    }
    return this;
  }

  /** Flat triangle (gable tops, roof hips). */
  tri(mat, a, b, c, o = {}) {
    const B = this.bucket(mat);
    const us = o.us || 1;
    const vs = o.vs || us;
    const uo = o.uo || 0;
    const vo = o.vo || 0;
    const col = o.col || this.col;
    const wear = o.wear || this.wear;
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const k = B.n;
    const uvs = o.uv || [[0, 0], [1, 0], [0.5, 1]];
    const pts = [a, b, c];
    for (let i = 0; i < 3; i++) {
      const p = pts[i];
      B.pos.push(p[0], p[1], p[2]);
      B.nor.push(nx, ny, nz);
      const tU = (uo + uvs[i][0]) / us;
      const tV = (vo + uvs[i][1]) / vs;
      if (o.rot) B.uv.push(tV, tU); else B.uv.push(tU, tV);
      B.col.push(col[0], col[1], col[2]);
      B.wear.push(p[1] - wear[0], wear[1] - p[1], wear[2], wear[3]);
    }
    B.n += 3;
    B.idx.push(k, k + 1, k + 2);
    return this;
  }

  /* ------------------------------------------------------------ face helpers
   * All three take frame-local extents. `out` / `up` is +1 or -1 and selects
   * which way the face looks; UVs are derived from the frame coordinates so
   * adjacent pieces of the same wall keep a continuous grain.
   */

  faceZ(mat, F, z, x0, x1, y0, y1, out, o = {}) {
    const oo = Object.assign({}, o);
    if (out < 0) {
      oo.uo = (o.uo || 0) - x1;
      oo.vo = (o.vo || 0) + y0;
      return this.quad(mat, F.p(x1, z, y0), F.p(x0, z, y0), F.p(x0, z, y1), F.p(x1, z, y1), oo);
    }
    oo.uo = (o.uo || 0) + x0;
    oo.vo = (o.vo || 0) + y0;
    return this.quad(mat, F.p(x0, z, y0), F.p(x1, z, y0), F.p(x1, z, y1), F.p(x0, z, y1), oo);
  }

  faceX(mat, F, x, z0, z1, y0, y1, out, o = {}) {
    const oo = Object.assign({}, o);
    oo.vo = (o.vo || 0) + y0;
    if (out > 0) {
      oo.uo = (o.uo || 0) - z1;
      return this.quad(mat, F.p(x, z1, y0), F.p(x, z0, y0), F.p(x, z0, y1), F.p(x, z1, y1), oo);
    }
    oo.uo = (o.uo || 0) + z0;
    return this.quad(mat, F.p(x, z0, y0), F.p(x, z1, y0), F.p(x, z1, y1), F.p(x, z0, y1), oo);
  }

  faceY(mat, F, y, x0, x1, z0, z1, up, o = {}) {
    const oo = Object.assign({}, o);
    if (up > 0) {
      oo.uo = (o.uo || 0) + z0;
      oo.vo = (o.vo || 0) + x0;
      return this.quad(mat, F.p(x0, z0, y), F.p(x0, z1, y), F.p(x1, z1, y), F.p(x1, z0, y), oo);
    }
    oo.uo = (o.uo || 0) + x0;
    oo.vo = (o.vo || 0) + z0;
    return this.quad(mat, F.p(x0, z0, y), F.p(x1, z0, y), F.p(x1, z1, y), F.p(x0, z1, y), oo);
  }

  /** Axis-aligned box in frame space. `skip` may contain f,k,l,r,t,b. */
  box(mat, F, x0, x1, z0, z1, y0, y1, o = {}) {
    const skip = o.skip || 'b';
    if (skip.indexOf('f') === -1) this.faceZ(mat, F, z0, x0, x1, y0, y1, -1, o);
    if (skip.indexOf('k') === -1) this.faceZ(mat, F, z1, x0, x1, y0, y1, +1, o);
    if (skip.indexOf('l') === -1) this.faceX(mat, F, x0, z0, z1, y0, y1, -1, o);
    if (skip.indexOf('r') === -1) this.faceX(mat, F, x1, z0, z1, y0, y1, +1, o);
    if (skip.indexOf('t') === -1) this.faceY(mat, F, y1, x0, x1, z0, z1, +1, o);
    if (skip.indexOf('b') === -1) this.faceY(mat, F, y0, x0, x1, z0, z1, -1, o);
    return this;
  }

  /**
   * Generalised cylinder / prism between two world points.
   * `sides` >= 3; r0/r1 are the end radii. Used for posts, logs, barrels,
   * wheel hubs, wire and stove pipes.
   */
  tube(mat, p0, p1, r0, r1, sides, o = {}) {
    const B = this.bucket(mat);
    const us = o.us || 1;
    const vs = o.vs || us;
    const col = o.col || this.col;
    const wear = o.wear || this.wear;
    const colFn = typeof col === 'function' ? col : null;
    let ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const len = Math.hypot(ax, ay, az) || 1;
    ax /= len; ay /= len; az /= len;
    // stable perpendicular basis
    let ux = 0, uy = 0, uz = 0;
    if (Math.abs(ay) < 0.9) { ux = -az; uy = 0; uz = ax; } else { ux = 1; uy = 0; uz = 0; }
    let ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ay * uz - az * uy;
    const vy = az * ux - ax * uz;
    const vz = ax * uy - ay * ux;
    const rings = o.rings || 1;
    const base0 = B.n;
    const wob = o.wobble || 0;
    for (let k = 0; k <= rings; k++) {
      const t = k / rings;
      const r = r0 + (r1 - r0) * t;
      const cx = p0[0] + (p1[0] - p0[0]) * t;
      const cy = p0[1] + (p1[1] - p0[1]) * t;
      const cz = p0[2] + (p1[2] - p0[2]) * t;
      for (let i = 0; i <= sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const rr = r * (1 + wob * Math.sin(a * 3 + t * 5.1 + (o.phase || 0)));
        const px = cx + (ux * ca + vx * sa) * rr;
        const py = cy + (uy * ca + vy * sa) * rr;
        const pz = cz + (uz * ca + vz * sa) * rr;
        const nx = ux * ca + vx * sa, ny = uy * ca + vy * sa, nz = uz * ca + vz * sa;
        B.pos.push(px, py, pz);
        B.nor.push(nx, ny, nz);
        B.uv.push((a * (r0 + r1) * 0.5) / us, (t * len) / vs);
        if (colFn) { const c3 = colFn([px, py, pz], i / sides, t); B.col.push(c3[0], c3[1], c3[2]); }
        else B.col.push(col[0], col[1], col[2]);
        B.wear.push(py - wear[0], wear[1] - py, wear[2], wear[3]);
      }
    }
    B.n += (rings + 1) * (sides + 1);
    const row = sides + 1;
    for (let k = 0; k < rings; k++) {
      for (let i = 0; i < sides; i++) {
        const q = base0 + k * row + i;
        B.idx.push(q, q + 1, q + row + 1, q, q + row + 1, q + row);
      }
    }
    if (o.caps) {
      // BOTH ends take capCol when supplied: a sawn log end is pale heartwood,
      // and giving only one end the light colour made the other read as the
      // open bore of a pipe (a named pass-2 tell on the camp log pile).
      const cc = o.capCol || col;
      this._cap(B, p1, ax, ay, az, ux, uy, uz, vx, vy, vz, r1, sides, cc, wear, us, vs, 1);
      this._cap(B, p0, ax, ay, az, ux, uy, uz, vx, vy, vz, r0, sides, cc, wear, us, vs, -1);
    }
    return this;
  }

  _cap(B, c, ax, ay, az, ux, uy, uz, vx, vy, vz, r, sides, col, wear, us, vs, s) {
    const colFn = typeof col === 'function' ? col : null;
    const k0 = B.n;
    B.pos.push(c[0], c[1], c[2]);
    B.nor.push(ax * s, ay * s, az * s);
    B.uv.push(0, 0);
    if (colFn) { const c3 = colFn(c, 0.5, 0.5); B.col.push(c3[0], c3[1], c3[2]); } else B.col.push(col[0], col[1], col[2]);
    B.wear.push(c[1] - wear[0], wear[1] - c[1], wear[2], wear[3]);
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const px = c[0] + (ux * ca + vx * sa) * r;
      const py = c[1] + (uy * ca + vy * sa) * r;
      const pz = c[2] + (uz * ca + vz * sa) * r;
      B.pos.push(px, py, pz);
      B.nor.push(ax * s, ay * s, az * s);
      B.uv.push((ca * r) / us, (sa * r) / vs);
      if (colFn) { const c3 = colFn([px, py, pz], ca * 0.5 + 0.5, sa * 0.5 + 0.5); B.col.push(c3[0], c3[1], c3[2]); }
      else B.col.push(col[0], col[1], col[2]);
      B.wear.push(py - wear[0], wear[1] - py, wear[2], wear[3]);
    }
    B.n += sides + 2;
    for (let i = 0; i < sides; i++) {
      if (s > 0) B.idx.push(k0, k0 + 1 + i, k0 + 2 + i);
      else B.idx.push(k0, k0 + 2 + i, k0 + 1 + i);
    }
  }

  /**
   * A wall face with rectangular openings punched through it. Cells are formed
   * from the union of all opening edges, so the grain stays continuous and no
   * geometry overlaps.
   */
  wallHoles(mat, F, z, x0, x1, y0, y1, out, holes, o = {}) {
    const xs = [x0, x1];
    const ys = [y0, y1];
    for (const h of holes) {
      if (h.x0 > x0 && h.x0 < x1) xs.push(h.x0);
      if (h.x1 > x0 && h.x1 < x1) xs.push(h.x1);
      if (h.y0 > y0 && h.y0 < y1) ys.push(h.y0);
      if (h.y1 > y0 && h.y1 < y1) ys.push(h.y1);
    }
    const ux = [...new Set(xs.map((v) => Math.round(v * 1000) / 1000))].sort((p, q) => p - q);
    const uy = [...new Set(ys.map((v) => Math.round(v * 1000) / 1000))].sort((p, q) => p - q);
    for (let j = 0; j < uy.length - 1; j++) {
      for (let i = 0; i < ux.length - 1; i++) {
        const cx = (ux[i] + ux[i + 1]) * 0.5;
        const cy = (uy[j] + uy[j + 1]) * 0.5;
        let hole = false;
        for (const h of holes) {
          if (cx > h.x0 && cx < h.x1 && cy > h.y0 && cy < h.y1) { hole = true; break; }
        }
        if (hole) continue;
        this.faceZ(mat, F, z, ux[i], ux[i + 1], uy[j], uy[j + 1], out, o);
      }
    }
    return this;
  }

  /** @returns {Map<string, THREE.BufferGeometry>} */
  build() {
    const out = new Map();
    for (const [name, b] of this.buckets) {
      if (!b.idx.length) continue;
      /* A single NaN vertex poisons the bounding sphere of the whole merged
         bucket and three then logs a console ERROR every frame, which fails the
         harness. Degenerate helper geometry (zero-length tubes, collapsed
         quads) is the usual source, so clamp rather than crash. */
      for (let i = 0; i < b.pos.length; i++) {
        if (!Number.isFinite(b.pos[i])) {
          if (typeof console !== 'undefined' && !this._warned) {
            this._warned = true;
            // eslint-disable-next-line no-console
            console.warn('[town] non-finite vertex in bucket', name, 'at', i);
          }
          b.pos[i] = 0;
        }
      }
      for (let i = 0; i < b.nor.length; i++) if (!Number.isFinite(b.nor[i])) b.nor[i] = (i % 3 === 1) ? 1 : 0;
      for (let i = 0; i < b.uv.length; i++) if (!Number.isFinite(b.uv[i])) b.uv[i] = 0;
      for (let i = 0; i < b.col.length; i++) if (!Number.isFinite(b.col[i])) b.col[i] = 1;
      for (let i = 0; i < b.wear.length; i++) if (!Number.isFinite(b.wear[i])) b.wear[i] = 0;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      g.setAttribute('aWear', new THREE.Float32BufferAttribute(b.wear, 4));
      g.setIndex(b.n > 65000
        ? new THREE.Uint32BufferAttribute(b.idx, 1)
        : new THREE.Uint16BufferAttribute(b.idx, 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      out.set(name, g);
    }
    return out;
  }

  stats() {
    let v = 0, t = 0;
    for (const b of this.buckets.values()) { v += b.n; t += b.idx.length / 3; }
    return { buckets: this.buckets.size, verts: v, tris: t };
  }
}
