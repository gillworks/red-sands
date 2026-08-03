import * as THREE from 'three';

/**
 * RED SANDS — SKELETON + PROCEDURAL POSING
 * ============================================================================
 * A tiny bone rig with everything the animation code needs and nothing else:
 *
 *   rig.bone(name, parent, [x,y,z])   declare rest hierarchy
 *   rig.finish()                      bind pose -> THREE.Skeleton
 *   rig.reset()                       every bone back to rest (call each frame)
 *   rig.rot(name, x, y, z)            additive euler on top of rest
 *   rig.trs(name, dx, dy, dz)         additive translation on top of rest
 *   rig.aim(name, worldDir, poleDir)  orient a bone's -Y down a world vector
 *   rig.ik2(root, mid, tip, target, pole)  analytic two-bone IK (legs/arms)
 *
 * All bones keep identity rest rotations and world-aligned local axes, so
 * "rotate the thigh by x" always means "swing the leg forwards" no matter
 * where the character is standing.
 * ============================================================================
 */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

export class Rig {
  constructor() {
    this.bones = [];
    this.index = new Map();
    this.rest = [];
    this.root = null;
  }

  bone(name, parentName, pos) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(pos[0], pos[1], pos[2]);
    const i = this.bones.length;
    this.bones.push(b);
    this.index.set(name, i);
    this.rest.push(new THREE.Vector3(pos[0], pos[1], pos[2]));
    if (parentName == null) {
      this.root = b;
    } else {
      const p = this.bones[this.index.get(parentName)];
      p.add(b);
    }
    return i;
  }

  id(name) {
    const i = this.index.get(name);
    if (i === undefined) throw new Error('Rig: unknown bone ' + name);
    return i;
  }

  get(name) { return this.bones[this.id(name)]; }

  /** Two-bone weight list helper. */
  w(a, wa, b, wb) {
    const out = [[this.id(a), wa]];
    if (b) out.push([this.id(b), wb]);
    return out;
  }

  finish() {
    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(this.bones);
    return this.skeleton;
  }

  reset() {
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i];
      b.quaternion.set(0, 0, 0, 1);
      b.position.copy(this.rest[i]);
      b.scale.set(1, 1, 1);
    }
  }

  /** Additive euler (XYZ order) applied on top of whatever the bone has. */
  rot(name, x, y, z) {
    const b = this.bones[this.id(name)];
    _e.set(x || 0, y || 0, z || 0, 'XYZ');
    _q.setFromEuler(_e);
    b.quaternion.multiply(_q);
    return b;
  }

  /** Set (not add) an euler. */
  setRot(name, x, y, z) {
    const b = this.bones[this.id(name)];
    _e.set(x || 0, y || 0, z || 0, 'XYZ');
    b.quaternion.setFromEuler(_e);
    return b;
  }

  trs(name, dx, dy, dz) {
    const b = this.bones[this.id(name)];
    b.position.x += dx || 0; b.position.y += dy || 0; b.position.z += dz || 0;
    return b;
  }

  /** Refresh world matrices for the whole skeleton (needed before IK). */
  sync() { this.root.updateMatrixWorld(true); }

  worldPos(name, target = new THREE.Vector3()) {
    const b = this.bones[this.id(name)];
    return target.setFromMatrixPosition(b.matrixWorld);
  }

  /**
   * Point a bone's local -Y axis along `dir` (world space), rolled so that its
   * local +Z leans toward `pole`. Assumes the bone's own matrixWorld parent is
   * already up to date.
   */
  aimWorld(bone, dir, pole) {
    _y.copy(dir).normalize().multiplyScalar(-1);           // local +Y
    _z.copy(pole).addScaledVector(_y, -pole.dot(_y));
    if (_z.lengthSq() < 1e-8) {
      _z.set(0, 0, 1).addScaledVector(_y, -_y.z);
      if (_z.lengthSq() < 1e-8) _z.set(1, 0, 0).addScaledVector(_y, -_y.x);
    }
    _z.normalize();
    _x.crossVectors(_y, _z).normalize();
    _z.crossVectors(_x, _y).normalize();
    _m.makeBasis(_x, _y, _z);
    _q.setFromRotationMatrix(_m);
    // convert world orientation to the bone's local frame
    if (bone.parent) {
      bone.parent.matrixWorld.decompose(_v, _q2, _v2);
      _q2.invert();
      _q.premultiply(_q2);
    }
    bone.quaternion.copy(_q);
  }

  /**
   * Analytic two-bone IK. `rootName` and `midName` are rotated so that the tip
   * lands on `target` (world). `pole` is the world direction the joint should
   * bend toward (forward for a knee, backward for an elbow).
   * Returns the achieved tip position.
   */
  ik2(rootName, midName, l1, l2, target, pole) {
    const rootB = this.bones[this.id(rootName)];
    const midB = this.bones[this.id(midName)];
    rootB.updateWorldMatrix(true, false);
    _v.setFromMatrixPosition(rootB.matrixWorld);          // hip world
    _v2.copy(target).sub(_v);
    let d = _v2.length();
    const dmin = Math.abs(l1 - l2) + 1e-3;
    const dmax = l1 + l2 - 1e-3;
    if (d < dmin) d = dmin;
    if (d > dmax) d = dmax;
    if (_v2.lengthSq() < 1e-9) _v2.set(0, -1, 0);
    _v2.normalize();

    // angle between limb 1 and the root->target axis
    const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
    const a = Math.acos(cosA);

    // rotate the axis by `a` toward the pole
    _x.copy(pole).addScaledVector(_v2, -pole.dot(_v2));
    if (_x.lengthSq() < 1e-8) _x.set(0, 0, 1).addScaledVector(_v2, -_v2.z);
    _x.normalize();
    const dir1 = _z.copy(_v2).multiplyScalar(Math.cos(a)).addScaledVector(_x, Math.sin(a)).normalize().clone();

    this.aimWorld(rootB, dir1, pole);
    rootB.updateWorldMatrix(false, false);
    midB.updateWorldMatrix(true, false);
    const kneeW = new THREE.Vector3().setFromMatrixPosition(midB.matrixWorld);
    const dir2 = new THREE.Vector3().copy(target).sub(kneeW);
    if (dir2.lengthSq() < 1e-9) dir2.set(0, -1, 0);
    dir2.normalize();
    this.aimWorld(midB, dir2, pole);
    midB.updateWorldMatrix(false, false);
    return kneeW;
  }
}

/** Pick the two heaviest bones out of a weight map — geometry supports 2. */
export function top2(list) {
  const f = list.filter((e) => e[1] > 0.0005).sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (!f.length) return [[list[0][0], 1]];
  const s = f.reduce((acc, e) => acc + e[1], 0);
  return f.map((e) => [e[0], e[1] / s]);
}

export const smoothstep = (a, b, x) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export { DOWN };
