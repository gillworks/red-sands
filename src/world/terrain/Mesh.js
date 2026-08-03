import * as THREE from 'three';

/**
 * CDLOD terrain mesh.
 *
 * A balanced quadtree is re-selected against the camera every frame; every
 * selected node becomes one instance of a single shared N×N grid, so the whole
 * 24 km of visible landscape is ONE draw call. Vertices morph continuously
 * toward their parent level's grid as they approach a LOD boundary (Strugar's
 * CDLOD), which means levels dissolve into each other instead of popping, and
 * shared edges land on identical positions so there is nothing to crack. A
 * short skirt on every node edge is belt-and-braces against the pathological
 * 2-level-neighbour case.
 */
export class ClipmapMesh {
  /**
   * @param {object} o
   * @param {number} o.gridN     quads per node edge (even)
   * @param {number} o.leafSize  metres covered by the finest node
   * @param {number} o.levels    quadtree depth (root = leafSize * 2^(levels-1))
   * @param {number} o.leafRange distance at which the finest level gives way
   */
  constructor({ gridN = 24, leafSize = 96, levels = 9, leafRange = 820, maxInstances = 4096 }) {
    this.gridN = gridN;
    this.leafSize = leafSize;
    this.levels = levels;
    this.extent = leafSize * Math.pow(2, levels - 1);
    this.half = this.extent * 0.5;
    this.maxInstances = maxInstances;

    this.ranges = new Float32Array(levels);
    for (let d = 0; d < levels; d++) this.ranges[d] = leafRange * Math.pow(2, d);

    this.geometry = this._buildGrid();
    this.aOrigin = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 2), 2);
    this.aParams = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 4), 4);
    this.aOrigin.setUsage(THREE.DynamicDrawUsage);
    this.aParams.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aOrigin', this.aOrigin);
    this.geometry.setAttribute('aParams', this.aParams);
    this.geometry.instanceCount = 0;

    /* min/max height pyramid, level 0 = leaf resolution */
    this.pyramid = [];
    this.gridW = [];
    this.count = 0;
    this._box = new THREE.Box3();
    this._lastCam = new THREE.Vector3(1e9, 1e9, 1e9);
    this._lastQuat = new THREE.Quaternion(2, 2, 2, 2);
  }

  _buildGrid() {
    const N = this.gridN;
    const vpr = N + 1;
    const nMain = vpr * vpr;
    const nSkirt = vpr * 4;
    const pos = new Float32Array((nMain + nSkirt) * 3);

    let p = 0;
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        pos[p++] = i / N;   // u
        pos[p++] = 0;       // skirt flag
        pos[p++] = j / N;   // v
      }
    }
    /* four skirt edges: south, north, west, east */
    const skirtBase = nMain;
    const edgeIdx = [];
    for (let i = 0; i <= N; i++) edgeIdx.push(i);                       // j = 0
    for (let i = 0; i <= N; i++) edgeIdx.push(N * vpr + i);             // j = N
    for (let j = 0; j <= N; j++) edgeIdx.push(j * vpr);                 // i = 0
    for (let j = 0; j <= N; j++) edgeIdx.push(j * vpr + N);             // i = N
    for (let k = 0; k < edgeIdx.length; k++) {
      const src = edgeIdx[k] * 3;
      pos[p++] = pos[src];
      pos[p++] = 1;       // skirt flag
      pos[p++] = pos[src + 2];
    }

    const idx = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * vpr + i, b = a + 1, c = a + vpr, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    /* skirt quads — wind each so the outward face is visible */
    for (let e = 0; e < 4; e++) {
      for (let i = 0; i < N; i++) {
        const t0 = edgeIdx[e * vpr + i];
        const t1 = edgeIdx[e * vpr + i + 1];
        const s0 = skirtBase + e * vpr + i;
        const s1 = skirtBase + e * vpr + i + 1;
        if (e === 0 || e === 3) idx.push(t0, s0, t1, t1, s0, s1);
        else idx.push(t0, t1, s0, t1, s1, s0);
      }
    }

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    g.boundingBox = new THREE.Box3(
      new THREE.Vector3(-1e6, -1e6, -1e6), new THREE.Vector3(1e6, 1e6, 1e6));
    return g;
  }

  /**
   * Build the min/max height pyramid used for culling and LOD ranges.
   * @param {(x:number,z:number)=>number} heightAt
   */
  buildPyramid(heightAt) {
    const leaves = Math.pow(2, this.levels - 1);
    const mm = new Float32Array(leaves * leaves * 2);
    const s = this.leafSize;
    const SUB = 5;
    for (let j = 0; j < leaves; j++) {
      const z0 = -this.half + j * s;
      for (let i = 0; i < leaves; i++) {
        const x0 = -this.half + i * s;
        let lo = Infinity, hi = -Infinity;
        for (let b = 0; b <= SUB; b++) {
          for (let a = 0; a <= SUB; a++) {
            const v = heightAt(x0 + (a / SUB) * s, z0 + (b / SUB) * s);
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        const k = (j * leaves + i) * 2;
        mm[k] = lo - 14;
        mm[k + 1] = hi + 14;
      }
    }
    this.pyramid = [mm];
    this.gridW = [leaves];
    for (let d = 1; d < this.levels; d++) {
      const pw = this.gridW[d - 1];
      const w = pw >> 1;
      const cur = new Float32Array(w * w * 2);
      const prev = this.pyramid[d - 1];
      for (let j = 0; j < w; j++) {
        for (let i = 0; i < w; i++) {
          let lo = Infinity, hi = -Infinity;
          for (let b = 0; b < 2; b++) {
            for (let a = 0; a < 2; a++) {
              const k = ((j * 2 + b) * pw + (i * 2 + a)) * 2;
              if (prev[k] < lo) lo = prev[k];
              if (prev[k + 1] > hi) hi = prev[k + 1];
            }
          }
          const k2 = (j * w + i) * 2;
          cur[k2] = lo; cur[k2 + 1] = hi;
        }
      }
      this.pyramid.push(cur);
      this.gridW.push(w);
    }
  }

  /** Re-select the quadtree. Returns the instance count. */
  select(camera, force = false) {
    const cp = camera.position;
    if (!force
      && cp.distanceToSquared(this._lastCam) < 4
      && Math.abs(camera.quaternion.dot(this._lastQuat)) > 0.99997) {
      return this.count;
    }
    this._lastCam.copy(cp);
    this._lastQuat.copy(camera.quaternion);

    /* The renderer only refreshes matrixWorldInverse at draw time, so on the
       frame a teleport lands it still holds the PREVIOUS pose. Selecting
       against that culls the new view and — because the camera then stops
       moving — the wrong selection sticks forever. Refresh it ourselves. */
    camera.updateMatrixWorld();

    this._frustum = this._frustum || new THREE.Frustum();
    this._m = this._m || new THREE.Matrix4();
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._m);
    /* Push every plane out so shadow casters and TAA jitter just off screen
       still have geometry. */
    for (const pl of this._frustum.planes) pl.constant += 260;

    this.count = 0;
    this._cx = cp.x; this._cz = cp.z;
    this._descend(0, 0, this.levels - 1);

    this.aOrigin.needsUpdate = true;
    this.aParams.needsUpdate = true;
    this.geometry.instanceCount = this.count;
    return this.count;
  }

  _descend(nx, ny, d) {
    const size = this.leafSize * (1 << d);
    const x0 = -this.half + nx * size;
    const z0 = -this.half + ny * size;
    const gw = this.gridW[d];
    const k = (ny * gw + nx) * 2;
    const mm = this.pyramid[d];

    this._box.min.set(x0, mm[k], z0);
    this._box.max.set(x0 + size, mm[k + 1], z0 + size);
    if (!this._frustum.intersectsBox(this._box)) return;

    if (d === 0) { this._emit(x0, z0, size, d); return; }

    const dx = Math.max(x0 - this._cx, 0, this._cx - (x0 + size));
    const dz = Math.max(z0 - this._cz, 0, this._cz - (z0 + size));
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > this.ranges[d - 1]) { this._emit(x0, z0, size, d); return; }

    const cx = nx * 2, cy = ny * 2;
    this._descend(cx, cy, d - 1);
    this._descend(cx + 1, cy, d - 1);
    this._descend(cx, cy + 1, d - 1);
    this._descend(cx + 1, cy + 1, d - 1);
  }

  _emit(x0, z0, size, d) {
    if (this.count >= this.maxInstances) return;
    const i = this.count++;
    const o = this.aOrigin.array, p = this.aParams.array;
    o[i * 2] = x0; o[i * 2 + 1] = z0;
    const rEnd = this.ranges[d] * 0.94;
    const rStart = this.ranges[d] * 0.62;
    p[i * 4] = size;
    p[i * 4 + 1] = rStart;
    p[i * 4 + 2] = 1 / (rEnd - rStart);
    p[i * 4 + 3] = size * 0.02;
  }

  dispose() { this.geometry.dispose(); }
}
