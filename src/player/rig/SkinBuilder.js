import * as THREE from 'three';

/**
 * RED SANDS — PROCEDURAL SKINNED MESH BUILDER
 * ============================================================================
 * Everything the player and the horse are made of is emitted through this.
 * It accumulates interleaved vertex data for a THREE.SkinnedMesh and hands
 * back a BufferGeometry with:
 *
 *   position normal uv color skinIndex skinWeight  +  aMat (vec4)
 *
 *   aMat.x  linear roughness for this vertex   (per-vertex material id, so the
 *   aMat.y  cloth-sheen amount 0..1             whole body is ONE draw call)
 *   aMat.z  baked ambient occlusion 0..1       (see bakeVertexAO below)
 *   aMat.w  surface class: 0 leather/skin, 1 woven cloth, 2 short animal hair,
 *           3 alpha-card strand hair
 *
 * Primitives are emitted with their own vertices (never shared between
 * primitives) so `computeVertexNormals()` yields smooth shading *within* a
 * limb and a hard crease *between* limbs — which is exactly what you want for
 * a boot sitting on a trouser cuff.
 *
 * Skinning is authored per path-point: each control point carries up to two
 * (boneIndex, weight) pairs and the ring inherits them, so a limb blends
 * smoothly across a joint without any automatic weight solve.
 * ============================================================================
 */

const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

export class SkinBuilder {
  constructor() {
    this.pos = [];
    this.uv = [];
    this.col = [];
    this.mat = [];
    this.si = [];
    this.sw = [];
    this.idx = [];
    this.groups = [];
    this._gStart = 0;
    this._gMat = 0;
    this._type = 0;
  }

  /**
   * Default surface class for everything emitted from here on.
   * 0 leather/skin/metal · 1 woven cloth · 2 short animal hair · 3 strand card.
   * The shader picks a completely different micro-detail and sheen model per
   * class — this is what stops felt, hide and oiled leather all reading as the
   * same beige plastic.
   */
  surface(t) { this._type = t; return this; }

  /** Switch material group (0 = solid FrontSide, 1 = cloth DoubleSide). */
  group(materialIndex) {
    if (materialIndex === this._gMat) return;
    if (this.idx.length > this._gStart) {
      this.groups.push({ start: this._gStart, count: this.idx.length - this._gStart, mat: this._gMat });
    }
    this._gStart = this.idx.length;
    this._gMat = materialIndex;
  }

  get vertexCount() { return this.pos.length / 3; }

  _vert(x, y, z, u, v, c, rough, sheen, bones, type) {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    this.col.push(c[0], c[1], c[2]);
    this.mat.push(rough, sheen, 1, type != null ? type : this._type);
    const b0 = bones[0] || [0, 1];
    const b1 = bones[1] || [0, 0];
    this.si.push(b0[0], b1[0], 0, 0);
    const wsum = Math.max(1e-5, b0[1] + b1[1]);
    this.sw.push(b0[1] / wsum, b1[1] / wsum, 0, 0);
  }

  _quad(a, b, c, d) {
    this.idx.push(a, b, d, b, c, d);
  }

  /**
   * Swept tube along a polyline with per-point elliptical (or superelliptical)
   * cross sections. Frames are parallel-transported so limbs never twist.
   *
   * path: [{ p:[x,y,z], rx, rz, bones:[[i,w],...], roll?, squash? }]
   * opts: { radial, color, rough, sheen, capStart, capEnd, arcStart, arcEnd,
   *         power, uvScale, colorFn }
   */
  tube(path, opts = {}) {
    const N = path.length;
    if (N < 2) return;
    const radial = opts.radial || 12;
    const power = opts.power || 2.0;         // 2 = ellipse, >2 = boxy
    const arc0 = opts.arcStart != null ? opts.arcStart : 0;
    const arc1 = opts.arcEnd != null ? opts.arcEnd : Math.PI * 2;
    const closed = Math.abs((arc1 - arc0) - Math.PI * 2) < 1e-4;
    const cols = closed ? radial : radial + 1;
    const baseCol = opts.color || [0.5, 0.5, 0.5];
    const rough = opts.rough != null ? opts.rough : 0.85;
    const sheen = opts.sheen != null ? opts.sheen : 0.0;
    const mt = opts.mtype != null ? opts.mtype : this._type;
    const vStart = this.vertexCount;

    // --- parallel transport frames -----------------------------------------
    const tans = [];
    for (let i = 0; i < N; i++) {
      const a = path[Math.max(0, i - 1)].p;
      const b = path[Math.min(N - 1, i + 1)].p;
      _t.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (_t.lengthSq() < 1e-10) _t.set(0, 1, 0);
      tans.push(_t.clone().normalize());
    }
    const frames = [];
    // seed normal: least-aligned world axis
    const t0 = tans[0];
    _n.set(0, 0, 1);
    if (Math.abs(t0.z) > 0.9) _n.set(1, 0, 0);
    _n.crossVectors(t0, _n).normalize();
    if (_n.lengthSq() < 1e-8) _n.set(1, 0, 0);
    _n.crossVectors(_n, t0).normalize();
    let nrm = _n.clone();
    for (let i = 0; i < N; i++) {
      const t = tans[i];
      // project previous normal onto the plane perpendicular to t
      nrm = nrm.clone().addScaledVector(t, -nrm.dot(t));
      if (nrm.lengthSq() < 1e-8) {
        nrm.set(0, 0, 1);
        if (Math.abs(t.z) > 0.9) nrm.set(1, 0, 0);
        nrm.addScaledVector(t, -nrm.dot(t));
      }
      nrm.normalize();
      const bin = new THREE.Vector3().crossVectors(t, nrm).normalize();
      frames.push({ n: nrm.clone(), b: bin });
    }

    // --- rings --------------------------------------------------------------
    const uvS = opts.uvScale || 1;
    for (let i = 0; i < N; i++) {
      const pt = path[i];
      const f = frames[i];
      const roll = pt.roll || 0;
      const cr = Math.cos(roll), sr = Math.sin(roll);
      _n.copy(f.n).multiplyScalar(cr).addScaledVector(f.b, sr);
      _b.copy(f.b).multiplyScalar(cr).addScaledVector(f.n, -sr);
      const rx = pt.rx, rz = pt.rz != null ? pt.rz : pt.rx;
      const bones = pt.bones || [[0, 1]];
      const v = i / (N - 1);
      for (let j = 0; j < cols; j++) {
        const u = j / radial;
        const a = arc0 + (arc1 - arc0) * u;
        const ca = Math.cos(a), sa = Math.sin(a);
        // superellipse
        const ex = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / power);
        const ez = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / power);
        let ox = ex * rx, oz = ez * rz;
        if (opts.radiusFn) { const k = opts.radiusFn(v, u); ox *= k; oz *= k; }
        const x = pt.p[0] + _n.x * ox + _b.x * oz;
        const y = pt.p[1] + _n.y * ox + _b.y * oz;
        const z = pt.p[2] + _n.z * ox + _b.z * oz;
        const c = opts.colorFn ? opts.colorFn(v, u, [x, y, z]) : baseCol;
        const bb = opts.bonesFn ? opts.bonesFn(v, u, bones) : bones;
        const rr = opts.roughFn ? opts.roughFn(v, u) : rough;
        this._vert(x, y, z, u * uvS, v * uvS, c, rr, sheen, bb, mt);
      }
    }
    for (let i = 0; i < N - 1; i++) {
      for (let j = 0; j < radial; j++) {
        const j1 = closed ? (j + 1) % radial : j + 1;
        const a = vStart + i * cols + j;
        const b = vStart + i * cols + j1;
        const c = vStart + (i + 1) * cols + j1;
        const d = vStart + (i + 1) * cols + j;
        this._quad(a, b, c, d);
      }
    }

    // --- caps ---------------------------------------------------------------
    if (opts.capStart) this._cap(path[0], frames[0], radial, cols, arc0, arc1, power, baseCol, rough, sheen, true, mt);
    if (opts.capEnd) this._cap(path[N - 1], frames[N - 1], radial, cols, arc0, arc1, power, baseCol, rough, sheen, false, mt);
  }

  _cap(pt, f, radial, cols, arc0, arc1, power, col, rough, sheen, flip, mt) {
    const bones = pt.bones || [[0, 1]];
    const centre = this.vertexCount;
    const roll = pt.roll || 0;
    const cr = Math.cos(roll), sr = Math.sin(roll);
    _n.copy(f.n).multiplyScalar(cr).addScaledVector(f.b, sr);
    _b.copy(f.b).multiplyScalar(cr).addScaledVector(f.n, -sr);
    this._vert(pt.p[0], pt.p[1], pt.p[2], 0.5, 0.5, col, rough, sheen, bones, mt);
    for (let j = 0; j <= radial; j++) {
      const a = arc0 + (arc1 - arc0) * (j / radial);
      const ca = Math.cos(a), sa = Math.sin(a);
      const ex = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / power);
      const ez = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / power);
      const ox = ex * pt.rx, oz = ez * (pt.rz != null ? pt.rz : pt.rx);
      this._vert(
        pt.p[0] + _n.x * ox + _b.x * oz,
        pt.p[1] + _n.y * ox + _b.y * oz,
        pt.p[2] + _n.z * ox + _b.z * oz,
        0.5 + ex * 0.5, 0.5 + ez * 0.5, col, rough, sheen, bones, mt,
      );
    }
    for (let j = 0; j < radial; j++) {
      const a = centre, b = centre + 1 + j, c = centre + 2 + j;
      if (flip) this.idx.push(a, c, b); else this.idx.push(a, b, c);
    }
  }

  /**
   * Deformed sphere (head, muzzle, joint balls). scale is [x,y,z];
   * `shape(u,v)` may return a radial multiplier for local sculpting.
   */
  blob(centre, scale, bones, opts = {}) {
    const rings = opts.rings || 12;
    const seg = opts.segments || 16;
    const col = opts.color || [0.5, 0.5, 0.5];
    const rough = opts.rough != null ? opts.rough : 0.8;
    const sheen = opts.sheen || 0;
    const shape = opts.shape;
    const mt = opts.mtype != null ? opts.mtype : this._type;
    const vs = this.vertexCount;
    for (let i = 0; i <= rings; i++) {
      const v = i / rings;
      const phi = v * Math.PI;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      for (let j = 0; j <= seg; j++) {
        const u = j / seg;
        const th = u * Math.PI * 2;
        let x = sp * Math.cos(th), y = cp, z = sp * Math.sin(th);
        let m = 1;
        if (shape) {
          const r = shape(u, v, x, y, z);
          if (typeof r === 'number') m = r;
          else { x *= r[0]; y *= r[1]; z *= r[2]; }
        }
        const px = centre[0] + x * scale[0] * m;
        const py = centre[1] + y * scale[1] * m;
        const pz = centre[2] + z * scale[2] * m;
        const c = opts.colorFn ? opts.colorFn(u, v, [px, py, pz]) : col;
        this._vert(px, py, pz, u, v, c, rough, sheen, bones, mt);
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < seg; j++) {
        const a = vs + i * (seg + 1) + j;
        const b = vs + i * (seg + 1) + j + 1;
        const c = vs + (i + 1) * (seg + 1) + j + 1;
        const d = vs + (i + 1) * (seg + 1) + j;
        this._quad(a, b, c, d);
      }
    }
  }

  /**
   * A flat double-sided ribbon (mane locks, straps, hat band, coat lapels).
   * pts: [{p, w, bones}] — width w across the ribbon, oriented by `axis`.
   */
  ribbon(pts, axis, opts = {}) {
    const col = opts.color || [0.4, 0.3, 0.2];
    const rough = opts.rough != null ? opts.rough : 0.9;
    const sheen = opts.sheen || 0;
    const vs = this.vertexCount;
    const mt = opts.mtype != null ? opts.mtype : this._type;
    const ax = new THREE.Vector3().fromArray(axis).normalize();
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i];
      const w = q.w;
      const bones = q.bones || [[0, 1]];
      const v = i / (pts.length - 1);
      this._vert(q.p[0] - ax.x * w, q.p[1] - ax.y * w, q.p[2] - ax.z * w, 0, v, col, rough, sheen, bones, mt);
      this._vert(q.p[0] + ax.x * w, q.p[1] + ax.y * w, q.p[2] + ax.z * w, 1, v, col, rough, sheen, bones, mt);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = vs + i * 2, b = vs + i * 2 + 1, c = vs + i * 2 + 3, d = vs + i * 2 + 2;
      this._quad(a, b, c, d);
    }
  }

  /**
   * Parametric grid — the workhorse for hat brims, belts, saddles, manes and
   * anything else that is a swept surface rather than a limb.
   * fn(u, v) -> { p:[x,y,z], color?, rough?, sheen?, bones? }
   */
  sheet(cols, rows, fn, opts = {}) {
    const wrapU = !!opts.wrapU;
    const nu = wrapU ? cols : cols + 1;
    const col = opts.color || [0.5, 0.5, 0.5];
    const rough = opts.rough != null ? opts.rough : 0.85;
    const sheen = opts.sheen || 0;
    const mt = opts.mtype != null ? opts.mtype : this._type;
    const vs = this.vertexCount;
    for (let i = 0; i <= rows; i++) {
      const v = i / rows;
      for (let j = 0; j < nu; j++) {
        const u = j / cols;
        const s = fn(u, v);
        this._vert(s.p[0], s.p[1], s.p[2], s.uv ? s.uv[0] : u, s.uv ? s.uv[1] : v,
          s.color || col, s.rough != null ? s.rough : rough,
          s.sheen != null ? s.sheen : sheen, s.bones || opts.bones || [[0, 1]], mt);
      }
    }
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const j1 = wrapU ? (j + 1) % nu : j + 1;
        const a = vs + i * nu + j;
        const b = vs + i * nu + j1;
        const c = vs + (i + 1) * nu + j1;
        const d = vs + (i + 1) * nu + j;
        this._quad(a, b, c, d);
      }
    }
  }

  /** Rounded box (satchel, buckles, saddle bags). */
  box(centre, half, bones, opts = {}) {
    const col = opts.color || [0.3, 0.2, 0.15];
    const rough = opts.rough != null ? opts.rough : 0.7;
    const sheen = opts.sheen || 0;
    const bevel = opts.bevel != null ? opts.bevel : 0.25;
    const rot = opts.rotation || null;
    const mt = opts.mtype != null ? opts.mtype : this._type;
    const put = (x, y, z) => {
      _p.set(x, y, z);
      if (rot) _p.applyEuler(rot);
      return [centre[0] + _p.x, centre[1] + _p.y, centre[2] + _p.z];
    };
    // Build as a super-ellipsoid so edges are softly bevelled.
    const rings = 8, seg = 12;
    const vs = this.vertexCount;
    const pw = 1 / Math.max(0.02, bevel);
    for (let i = 0; i <= rings; i++) {
      const v = i / rings;
      const phi = v * Math.PI;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      const sy = Math.sign(cp) * Math.pow(Math.abs(cp), 2 / pw);
      const rr = Math.pow(Math.abs(sp), 2 / pw);
      for (let j = 0; j <= seg; j++) {
        const u = j / seg;
        const th = u * Math.PI * 2;
        const ct = Math.cos(th), st = Math.sin(th);
        const sx = Math.sign(ct) * Math.pow(Math.abs(ct), 2 / pw) * rr;
        const sz = Math.sign(st) * Math.pow(Math.abs(st), 2 / pw) * rr;
        const p = put(sx * half[0], sy * half[1], sz * half[2]);
        this._vert(p[0], p[1], p[2], u, v, col, rough, sheen, bones, mt);
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < seg; j++) {
        const a = vs + i * (seg + 1) + j;
        const b = vs + i * (seg + 1) + j + 1;
        const c = vs + (i + 1) * (seg + 1) + j + 1;
        const d = vs + (i + 1) * (seg + 1) + j;
        this._quad(a, b, c, d);
      }
    }
  }

  /** Finish: returns a BufferGeometry ready for a SkinnedMesh. */
  build() {
    if (this.idx.length > this._gStart) {
      this.groups.push({ start: this._gStart, count: this.idx.length - this._gStart, mat: this._gMat });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 4));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    for (const gr of this.groups) g.addGroup(gr.start, gr.count, gr.mat);
    g.computeBoundingSphere();
    return g;
  }
}

/** Catmull-Rom resample of a sparse joint list into a dense tube path. */
export function resample(keys, steps) {
  const out = [];
  const n = keys.length;
  const pt = (i) => keys[Math.max(0, Math.min(n - 1, i))];
  for (let s = 0; s <= steps; s++) {
    const f = (s / steps) * (n - 1);
    const i = Math.min(n - 2, Math.floor(f));
    const t = f - i;
    const p0 = pt(i - 1), p1 = pt(i), p2 = pt(i + 1), p3 = pt(i + 2);
    const cr = (a, b, c, d) => {
      const t2 = t * t, t3 = t2 * t;
      return 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
    };
    out.push({
      p: [cr(p0.p[0], p1.p[0], p2.p[0], p3.p[0]),
        cr(p0.p[1], p1.p[1], p2.p[1], p3.p[1]),
        cr(p0.p[2], p1.p[2], p2.p[2], p3.p[2])],
      rx: cr(p0.rx, p1.rx, p2.rx, p3.rx),
      rz: cr(p0.rz != null ? p0.rz : p0.rx, p1.rz != null ? p1.rz : p1.rx,
        p2.rz != null ? p2.rz : p2.rx, p3.rz != null ? p3.rz : p3.rx),
      roll: cr(p0.roll || 0, p1.roll || 0, p2.roll || 0, p3.roll || 0),
      bones: blendBones(p1.bones, p2.bones, t),
    });
  }
  return out;
}

function blendBones(a, b, t) {
  if (!a) return b;
  if (!b) return a;
  const acc = new Map();
  for (const [i, w] of a) acc.set(i, (acc.get(i) || 0) + w * (1 - t));
  for (const [i, w] of b) acc.set(i, (acc.get(i) || 0) + w * t);
  const list = [...acc.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2);
  return list;
}

export { _p as _tmpP, _q as _tmpQ };

/* ==========================================================================
 * BAKED VERTEX AMBIENT OCCLUSION
 * --------------------------------------------------------------------------
 * The single biggest reason a procedurally-swept character reads as a smooth
 * plastic maquette is that nothing tells you where one form ends and the next
 * begins. Real photography of a horse is 80 % occlusion: the dark seam where
 * the foreleg meets the barrel, under the belly, behind the elbow, in the
 * gutter beside the spine, under the saddle skirt, inside every coat fold.
 *
 * This bakes that in once at build time. Triangles are splatted into a coarse
 * occupancy grid, then every vertex cone-traces a small hemisphere against it.
 * Result lands in aMat.z and the shader spends it on the indirect term plus a
 * touch of cavity darkening in the albedo.
 *
 * ~25 ms for both characters, once, at build; zero per-frame cost.
 * ========================================================================== */

/** 16 roughly cosine-distributed hemisphere directions (z-up local frame). */
const AO_DIRS = (() => {
  const d = [];
  const N = 16;
  for (let i = 0; i < N; i++) {
    // Fibonacci hemisphere, biased toward the normal
    const t = (i + 0.5) / N;
    const cz = Math.sqrt(1 - t * 0.92);
    const r = Math.sqrt(1 - cz * cz);
    const a = i * 2.39996323;
    d.push(Math.cos(a) * r, Math.sin(a) * r, cz);
  }
  return d;
})();
/** Ray march radii, and how much a hit at each radius occludes. */
const AO_STEPS = [0.035, 0.070, 0.120, 0.190, 0.290, 0.430];
const AO_W = [1.00, 0.86, 0.68, 0.48, 0.30, 0.15];

export function bakeVertexAO(geo, opts = {}) {
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal.array;
  const aMat = geo.attributes.aMat.array;
  const idx = geo.index.array;
  const nv = pos.length / 3;

  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i] < x0) x0 = pos[i]; if (pos[i] > x1) x1 = pos[i];
    if (pos[i + 1] < y0) y0 = pos[i + 1]; if (pos[i + 1] > y1) y1 = pos[i + 1];
    if (pos[i + 2] < z0) z0 = pos[i + 2]; if (pos[i + 2] > z1) z1 = pos[i + 2];
  }
  const span = Math.max(x1 - x0, y1 - y0, z1 - z0);
  const cell = opts.cell || span / 88;
  const pad = cell * 2;
  x0 -= pad; y0 -= pad; z0 -= pad;
  const nx = Math.max(2, Math.ceil((x1 + pad - x0) / cell));
  const ny = Math.max(2, Math.ceil((y1 + pad - y0) / cell));
  const nz = Math.max(2, Math.ceil((z1 + pad - z0) / cell));
  const grid = new Uint8Array(nx * ny * nz);
  const inv = 1 / cell;

  const mark = (px, py, pz) => {
    const i = ((px - x0) * inv) | 0;
    const j = ((py - y0) * inv) | 0;
    const k = ((pz - z0) * inv) | 0;
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return;
    grid[(k * ny + j) * nx + i] = 1;
  };

  // --- splat every triangle, sampled densely enough to leave no holes -------
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
    const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
    const e = Math.max(
      Math.abs(bx - ax) + Math.abs(by - ay) + Math.abs(bz - az),
      Math.abs(cx - ax) + Math.abs(cy - ay) + Math.abs(cz - az),
      Math.abs(cx - bx) + Math.abs(cy - by) + Math.abs(cz - bz),
    );
    const n = Math.min(6, Math.max(1, Math.ceil(e * inv * 0.8)));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n, w = 1 - u - v;
        mark(ax * w + bx * u + cx * v, ay * w + by * u + cy * v, az * w + bz * u + cz * v);
      }
    }
  }

  const at = (i, j, k) => ((i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz)
    ? 0 : grid[(k * ny + j) * nx + i]);

  // --- trace ---------------------------------------------------------------
  const strength = opts.strength != null ? opts.strength : 1.0;
  const floorAO = opts.floor != null ? opts.floor : 0.26;
  const bias = cell * 1.15;
  const tx = [0, 0, 0], ty = [0, 0, 0];
  for (let v = 0; v < nv; v++) {
    const p3 = v * 3;
    const nX = nrm[p3], nY = nrm[p3 + 1], nZ = nrm[p3 + 2];
    // orthonormal basis around the normal
    let ux = 0, uy = 0, uz = 0;
    if (Math.abs(nY) < 0.9) { ux = -nZ; uy = 0; uz = nX; } else { ux = nY; uy = -nX; uz = 0; }
    const ul = Math.hypot(ux, uy, uz) || 1;
    tx[0] = ux / ul; tx[1] = uy / ul; tx[2] = uz / ul;
    ty[0] = nY * tx[2] - nZ * tx[1];
    ty[1] = nZ * tx[0] - nX * tx[2];
    ty[2] = nX * tx[1] - nY * tx[0];
    const ox = pos[p3] + nX * bias, oy = pos[p3 + 1] + nY * bias, oz = pos[p3 + 2] + nZ * bias;

    let occ = 0;
    for (let d = 0; d < AO_DIRS.length; d += 3) {
      const dx = tx[0] * AO_DIRS[d] + ty[0] * AO_DIRS[d + 1] + nX * AO_DIRS[d + 2];
      const dy = tx[1] * AO_DIRS[d] + ty[1] * AO_DIRS[d + 1] + nY * AO_DIRS[d + 2];
      const dz = tx[2] * AO_DIRS[d] + ty[2] * AO_DIRS[d + 1] + nZ * AO_DIRS[d + 2];
      for (let s = 0; s < AO_STEPS.length; s++) {
        const r = AO_STEPS[s];
        const i = ((ox + dx * r - x0) * inv) | 0;
        const j = ((oy + dy * r - y0) * inv) | 0;
        const k = ((oz + dz * r - z0) * inv) | 0;
        if (at(i, j, k)) { occ += AO_W[s]; break; }
      }
    }
    occ /= (AO_DIRS.length / 3);
    const ao = Math.max(floorAO, 1 - occ * strength);
    aMat[v * 4 + 2] = ao;
  }
  geo.attributes.aMat.needsUpdate = true;
  return geo;
}
