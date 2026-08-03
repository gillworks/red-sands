import * as THREE from 'three';

/**
 * Builds the water surface as a set of frustum-cullable tiles, tessellated only
 * where the hydrology solve says there is water.
 *
 * The grid is the heightfield grid: a vertex sits exactly on a heightfield texel
 * centre. That is deliberate — the fragment shader reads its water depth from a
 * texture defined on the same texel centres, so the interpolated surface height
 * and the interpolated bed height come from the same bilinear footprint and the
 * waterline lands where the terrain actually is, to well under a texel.
 *
 * The mask is dilated by two cells before triangulation so the sheet always
 * extends *under* the bank; the fragment discards where depth <= 0, which is
 * what makes the shoreline a smooth analytic curve rather than a polygon edge.
 */

/** Dilate a sparse boolean mask in-place-ish. Sparse scatter, not a gather. */
function dilate(mask, res, radius) {
  const out = new Uint8Array(mask);
  const r = radius | 0;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      if (!mask[y * res + x]) continue;
      const y0 = Math.max(0, y - r), y1 = Math.min(res - 1, y + r);
      const x0 = Math.max(0, x - r), x1 = Math.min(res - 1, x + r);
      for (let b = y0; b <= y1; b++) {
        for (let a = x0; a <= x1; a++) out[b * res + a] = 1;
      }
    }
  }
  return out;
}

/**
 * @param {object} o
 * @param {Float32Array} o.depth   surface - bed, res²
 * @param {Float32Array} o.surf    water surface height, res²
 * @param {number} o.res
 * @param {number} o.size          world extent, metres
 * @param {number} [o.tile]        quads per tile edge
 * @param {number} [o.stride]      grid stride (LOD); 1 = full resolution
 * @returns {{tiles:Array, verts:number, tris:number}}
 */
export function buildWaterTiles(o) {
  const { depth, surf, res, size, tile = 128, stride = 1, threshold = 0.02 } = o;
  const cell = size / res;
  const half = size * 0.5;

  const wet = new Uint8Array(res * res);
  let wetCount = 0;
  for (let i = 0; i < res * res; i++) {
    if (depth[i] > threshold) { wet[i] = 1; wetCount++; }
  }
  if (!wetCount) return { tiles: [], verts: 0, tris: 0, wetCount: 0 };
  const grown = dilate(wet, res, 2 * stride);

  const tilesPerSide = Math.ceil((res - 1) / (tile * stride));
  const tiles = [];
  let totalV = 0, totalT = 0;

  const vpe = tile + 1;                       // vertices per tile edge
  const lut = new Int32Array(vpe * vpe);

  for (let ty = 0; ty < tilesPerSide; ty++) {
    for (let tx = 0; tx < tilesPerSide; tx++) {
      const gx0 = tx * tile * stride;
      const gy0 = ty * tile * stride;

      lut.fill(-1);
      const pos = [];
      const idx = [];
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

      const vertexAt = (lx, ly) => {
        const k = ly * vpe + lx;
        let v = lut[k];
        if (v >= 0) return v;
        const gx = Math.min(res - 1, gx0 + lx * stride);
        const gy = Math.min(res - 1, gy0 + ly * stride);
        const wx = -half + (gx + 0.5) * cell;
        const wz = -half + (gy + 0.5) * cell;
        const wy = surf[gy * res + gx];
        v = pos.length / 3;
        pos.push(wx, wy, wz);
        if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
        if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
        lut[k] = v;
        return v;
      };

      for (let ly = 0; ly < tile; ly++) {
        const gy = gy0 + ly * stride;
        if (gy + stride > res - 1) break;
        for (let lx = 0; lx < tile; lx++) {
          const gx = gx0 + lx * stride;
          if (gx + stride > res - 1) break;
          // include the quad if any of its four corners is inside the grown mask
          const a = grown[gy * res + gx];
          const b = grown[gy * res + gx + stride];
          const c = grown[(gy + stride) * res + gx];
          const dd = grown[(gy + stride) * res + gx + stride];
          if (!(a || b || c || dd)) continue;
          const v00 = vertexAt(lx, ly);
          const v10 = vertexAt(lx + 1, ly);
          const v01 = vertexAt(lx, ly + 1);
          const v11 = vertexAt(lx + 1, ly + 1);
          idx.push(v00, v01, v10, v10, v01, v11);
        }
      }

      if (idx.length < 24) continue;

      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
      g.setIndex(idx.length > 65535
        ? new THREE.BufferAttribute(new Uint32Array(idx), 1)
        : new THREE.BufferAttribute(new Uint16Array(idx), 1));
      // Waves displace the surface, so pad the bounds or tiles pop at the edge.
      g.boundingBox = new THREE.Box3(
        new THREE.Vector3(minX - 2, minY - 3, minZ - 2),
        new THREE.Vector3(maxX + 2, maxY + 3, maxZ + 2),
      );
      g.boundingSphere = new THREE.Sphere();
      g.boundingBox.getBoundingSphere(g.boundingSphere);

      totalV += pos.length / 3;
      totalT += idx.length / 3;
      tiles.push({
        geometry: g,
        cx: (minX + maxX) * 0.5,
        cz: (minZ + maxZ) * 0.5,
        cy: (minY + maxY) * 0.5,
        radius: g.boundingSphere.radius,
      });
    }
  }

  return { tiles, verts: totalV, tris: totalT, wetCount };
}
