import * as THREE from 'three';

/**
 * Procedural animal bodies.
 *
 * Every species is a handful of tapered boxes merged into one geometry. Each
 * vertex carries:
 *   aPart   which limb it belongs to (see PART), so the vertex shader knows
 *           what to do with it
 *   aPivot  the joint that limb rotates about, in object space
 *
 * Object space convention: +X forward (nose), +Y up, +Z to the animal's left.
 * Origin sits on the ground between the hooves. Sizes are in metres and are
 * honest: a mule deer is ~1.6 m long and stands ~1.0 m at the shoulder, which
 * is what makes them read as scale references in a wide shot.
 */

export const PART = {
  BODY: 0, HEAD: 1, LEG_FL: 2, LEG_FR: 3, LEG_BL: 4, LEG_BR: 5,
  TAIL: 6, WING_L: 7, WING_R: 8, EAR: 9,
};

/* -------------------------------------------------------------------------- */

class Builder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.part = [];
    this.pivot = [];
    this.idx = [];
  }

  /**
   * A tapered box. `a`/`b` are the two end centres, `wa`/`ha` and `wb`/`hb`
   * the half-width (Z) and half-height (Y) at each end. Cheap, and a tapered
   * box silhouettes far better than a cube.
   */
  box(a, b, wa, ha, wb, hb, part, pivot, twist = 0) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length() || 1e-4;
    dir.multiplyScalar(1 / len);
    let up = Math.abs(dir.y) > 0.94 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, dir).normalize();
    up = new THREE.Vector3().crossVectors(dir, right).normalize();
    if (twist) {
      const c = Math.cos(twist), s = Math.sin(twist);
      const r2 = right.clone().multiplyScalar(c).addScaledVector(up, s);
      const u2 = right.clone().multiplyScalar(-s).addScaledVector(up, c);
      right.copy(r2); up.copy(u2);
    }

    const base = this.pos.length / 3;
    const ends = [[a, wa, ha], [b, wb, hb]];
    for (let e = 0; e < 2; e++) {
      const [c, w, h] = ends[e];
      for (let k = 0; k < 4; k++) {
        const sx = (k === 0 || k === 3) ? -1 : 1;
        const sy = (k < 2) ? -1 : 1;
        const p = c.clone().addScaledVector(right, w * sx).addScaledVector(up, h * sy);
        this.pos.push(p.x, p.y, p.z);
        const n = right.clone().multiplyScalar(sx).addScaledVector(up, sy).normalize();
        this.nrm.push(n.x, n.y, n.z);
        this.uv.push(e, k * 0.25);
        this.part.push(part);
        this.pivot.push(pivot.x, pivot.y, pivot.z);
      }
    }
    // sides
    const q = (i0, i1, i2, i3) => this.idx.push(base + i0, base + i1, base + i2, base + i0, base + i2, base + i3);
    q(0, 1, 5, 4);
    q(1, 2, 6, 5);
    q(2, 3, 7, 6);
    q(3, 0, 4, 7);
    // caps
    q(3, 2, 1, 0);
    q(4, 5, 6, 7);
    return this;
  }

  /** Flat quad (wings, ears, fins). */
  quad(c, dirA, dirB, part, pivot) {
    const base = this.pos.length / 3;
    const n = new THREE.Vector3().crossVectors(dirA, dirB).normalize();
    const corners = [
      c.clone().sub(dirA).sub(dirB), c.clone().add(dirA).sub(dirB),
      c.clone().add(dirA).add(dirB), c.clone().sub(dirA).add(dirB),
    ];
    for (let i = 0; i < 4; i++) {
      const p = corners[i];
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(n.x, n.y, n.z);
      this.uv.push(i & 1, (i >> 1) & 1);
      this.part.push(part);
      this.pivot.push(pivot.x, pivot.y, pivot.z);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    return this;
  }

  finish() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.setAttribute('aPivot', new THREE.Float32BufferAttribute(this.pivot, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    // generous bounds: the vertex shader moves limbs around
    g.boundingSphere.radius *= 2.2;
    return g;
  }
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/* -------------------------------------------------------------------------- */

function deer(rand) {
  const b = new Builder();
  const sh = 1.00;      // shoulder height
  const hip = V(0.42, sh - 0.06, 0);
  const wit = V(-0.36, sh, 0);

  // barrel — deeper at the chest, tucked at the flank
  b.box(V(0.50, sh - 0.02, 0), V(-0.42, sh + 0.02, 0), 0.19, 0.24, 0.155, 0.20, PART.BODY, hip);
  // neck, rising forward
  b.box(V(0.50, sh + 0.04, 0), V(0.80, sh + 0.36, 0), 0.10, 0.12, 0.065, 0.085, PART.HEAD, V(0.50, sh + 0.04, 0));
  // head
  b.box(V(0.80, sh + 0.37, 0), V(1.00, sh + 0.30, 0), 0.065, 0.085, 0.038, 0.05, PART.HEAD, V(0.50, sh + 0.04, 0));
  // ears
  b.quad(V(0.83, sh + 0.47, 0.075), V(0.045, 0.055, 0), V(0, 0, 0.02), PART.HEAD, V(0.50, sh + 0.04, 0));
  b.quad(V(0.83, sh + 0.47, -0.075), V(0.045, 0.055, 0), V(0, 0, 0.02), PART.HEAD, V(0.50, sh + 0.04, 0));
  // tail
  b.box(V(-0.44, sh + 0.06, 0), V(-0.56, sh - 0.06, 0), 0.045, 0.055, 0.02, 0.03, PART.TAIL, V(-0.44, sh + 0.06, 0));

  // legs: upper + lower so the knee reads
  const leg = (x, z, part) => {
    const hipP = V(x, sh - 0.10, z);
    b.box(hipP, V(x - 0.02, 0.46, z), 0.055, 0.075, 0.035, 0.045, part, hipP);
    b.box(V(x - 0.02, 0.47, z), V(x + 0.02, 0.0, z), 0.032, 0.038, 0.022, 0.026, part, hipP);
  };
  leg(0.40, 0.115, PART.LEG_FL);
  leg(0.40, -0.115, PART.LEG_FR);
  leg(-0.34, 0.125, PART.LEG_BL);
  leg(-0.34, -0.125, PART.LEG_BR);

  void rand; void wit;
  return b.finish();
}

function rabbit() {
  const b = new Builder();
  const sh = 0.20;
  const hip = V(-0.05, sh, 0);
  b.box(V(0.13, sh, 0), V(-0.14, sh + 0.02, 0), 0.062, 0.070, 0.075, 0.085, PART.BODY, hip);
  b.box(V(0.12, sh + 0.05, 0), V(0.23, sh + 0.09, 0), 0.048, 0.050, 0.035, 0.040, PART.HEAD, V(0.12, sh + 0.05, 0));
  // long ears
  b.quad(V(0.19, sh + 0.19, 0.028), V(-0.010, 0.075, 0), V(0, 0, 0.014), PART.HEAD, V(0.12, sh + 0.05, 0));
  b.quad(V(0.19, sh + 0.19, -0.028), V(-0.010, 0.075, 0), V(0, 0, 0.014), PART.HEAD, V(0.12, sh + 0.05, 0));
  b.box(V(-0.16, sh + 0.03, 0), V(-0.21, sh + 0.04, 0), 0.035, 0.035, 0.028, 0.028, PART.TAIL, V(-0.16, sh + 0.03, 0));
  const leg = (x, z, part, len) => {
    const hp = V(x, sh - 0.03, z);
    b.box(hp, V(x, sh - 0.03 - len, z), 0.026, 0.030, 0.020, 0.022, part, hp);
  };
  leg(0.09, 0.045, PART.LEG_FL, 0.14);
  leg(0.09, -0.045, PART.LEG_FR, 0.14);
  leg(-0.09, 0.055, PART.LEG_BL, 0.17);
  leg(-0.09, -0.055, PART.LEG_BR, 0.17);
  return b.finish();
}

function bird(scale, tailLen, wingSpan, wingChord) {
  const b = new Builder();
  const y = 0;
  const body = V(0, y, 0);
  b.box(V(0.10 * scale, y, 0), V(-0.10 * scale, y, 0), 0.035 * scale, 0.040 * scale,
    0.022 * scale, 0.026 * scale, PART.BODY, body);
  b.box(V(0.10 * scale, y + 0.02 * scale, 0), V(0.20 * scale, y + 0.02 * scale, 0),
    0.024 * scale, 0.026 * scale, 0.012 * scale, 0.014 * scale, PART.HEAD, V(0.10 * scale, y, 0));
  // tail fan
  b.quad(V(-0.10 * scale - tailLen * 0.5, y, 0),
    V(tailLen * 0.5, 0, 0), V(0, 0, 0.045 * scale), PART.TAIL, V(-0.10 * scale, y, 0));
  // wings: swept quads hinged at the shoulder
  const hingeL = V(0.02 * scale, y + 0.02 * scale, 0.03 * scale);
  const hingeR = V(0.02 * scale, y + 0.02 * scale, -0.03 * scale);
  b.quad(V(0.0, y + 0.02 * scale, 0.03 * scale + wingSpan * 0.5),
    V(wingChord * 0.5, 0, 0), V(0, 0, wingSpan * 0.5), PART.WING_L, hingeL);
  b.quad(V(0.0, y + 0.02 * scale, -0.03 * scale - wingSpan * 0.5),
    V(wingChord * 0.5, 0, 0), V(0, 0, wingSpan * 0.5), PART.WING_R, hingeR);
  return b.finish();
}

/* -------------------------------------------------------------------------- */

export function buildSpecies(name, rand) {
  switch (name) {
    case 'deer': return deer(rand);
    case 'rabbit': return rabbit();
    case 'crow': return bird(1.0, 0.16, 0.40, 0.15);
    case 'bird': return bird(0.55, 0.07, 0.20, 0.075);
    case 'raptor': return bird(1.5, 0.30, 1.05, 0.34);
    default: return rabbit();
  }
}
