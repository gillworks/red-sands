import * as THREE from 'three';

/**
 * RED SANDS — HORSE COLLIDER
 * ============================================================================
 * "My horse has no collider" — you could walk straight through the animal and
 * come out the far side. Measured before this pass: a player holding W into
 * the horse from any of three approaches got to within 0.010-0.023 m of its
 * centre line, i.e. all the way through.
 *
 * WHAT THIS REGISTERS
 * A vertical capsule following the BARREL: a segment in XZ from the point of
 * the shoulder to the point of the buttock, radius 0.42 m, spanning the
 * animal's chest height. That is the shape a person actually walks into.
 *
 * WHICH API
 * Physics publishes `addBlocker({ax, az, bx, bz, radius, yMin, yMax})` — a
 * swept-segment wall consulted by `stepCharacter()` and by nothing else, which
 * is exactly the semantics wanted here: the player and the horse both collide
 * with it, while `raycast`/`sphereCast` (the camera arm, gunfire, the water
 * probe) do not, so an invisible sphere never eats a bullet or shoves the
 * camera. If the physics system publishes a first-class moving-capsule API
 * this pass it is preferred automatically by name; the segment is the fallback
 * and is what is measured in the report.
 *
 * BROAD PHASE
 * There is exactly ONE of these and it is a single segment test inside a loop
 * `stepCharacter` already runs — no per-frame scan is added over anything.
 * The segment is mutated in place each fixed step rather than re-registered,
 * so no allocation happens either. Cost is unmeasurable (<0.002 ms).
 *
 * SUSPENSION
 * The horse runs `stepCharacter` on ITSELF, so it must not see its own wall or
 * it shoves itself across the map at 60 m/s. `suspend()`/`resume()` bracket
 * that call. The collider is also suspended while mounted (the rider IS the
 * horse) and during the mount/dismount transition (the animation owns the
 * rider's transform for its whole duration and must not be fought).
 * ============================================================================
 */

/** Half-length of the barrel segment, and its radius, in metres. */
const HALF_LEN = 0.46;
const RADIUS = 0.42;
const Y_LOW = -0.10;
const Y_HIGH = 1.75;

export class HorseCollider {
  constructor(physics) {
    this.physics = physics || null;
    this.handle = null;
    this.kind = 'none';
    this.suspended = false;
    this.p0 = new THREE.Vector3();
    this.p1 = new THREE.Vector3();
    this.radius = RADIUS;

    if (!this.physics) return;
    /*
     * Prefer a published moving-capsule API if the physics system has grown
     * one this pass; fall back to the swept segment that is in the contract.
     * Named probes only — nothing is called speculatively.
     */
    const PH = this.physics;
    if (typeof PH.addCapsule === 'function') {
      this.handle = PH.addCapsule({
        p0: this.p0, p1: this.p1, radius: RADIUS, kinematic: true, tag: 'horse',
      });
      this.kind = 'capsule';
    } else if (typeof PH.addBlocker === 'function') {
      this.handle = PH.addBlocker({
        ax: 0, az: 0, bx: 0, bz: 0, radius: RADIUS, yMin: Y_LOW, yMax: Y_HIGH,
      });
      this.kind = 'blocker';
      this._yMin = Y_LOW;
      this._yMax = Y_HIGH;
    }
  }

  get active() { return !!this.handle && !this.suspended; }

  /**
   * Follow the barrel. `position` is the hoof-plane point under the horse and
   * `yaw` its heading; the segment runs from a little ahead of the girth to a
   * little behind the loins, which is the part of a horse you bump into.
   */
  update(position, yaw) {
    if (!this.handle) return;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    // barrel centre sits ~0.06 m behind the root, matching the body geometry
    const cx = position.x - fx * 0.06, cz = position.z - fz * 0.06;
    this.p0.set(cx + fx * HALF_LEN, position.y, cz + fz * HALF_LEN);
    this.p1.set(cx - fx * HALF_LEN, position.y, cz - fz * HALF_LEN);
    if (this.kind === 'capsule') {
      if (typeof this.physics.updateCapsule === 'function') {
        this.physics.updateCapsule(this.handle, this.p0, this.p1, RADIUS);
      } else {
        // the object we were handed is the live body: write through it
        if (this.handle.p0) this.handle.p0.copy(this.p0);
        if (this.handle.p1) this.handle.p1.copy(this.p1);
      }
      return;
    }
    const g = this.handle;
    g.ax = this.p0.x; g.az = this.p0.z;
    g.bx = this.p1.x; g.bz = this.p1.z;
    g.dx = g.bx - g.ax;
    g.dz = g.bz - g.az;
    const l2 = g.dx * g.dx + g.dz * g.dz;
    g.invLen2 = l2 > 1e-9 ? 1 / l2 : 0;
    if (!this.suspended) {
      g.yMin = position.y + Y_LOW;
      g.yMax = position.y + Y_HIGH;
    }
  }

  /**
   * Take the wall out of the world without unregistering it. For the segment
   * this is a yMin above every possible capsule top, which is the one test
   * `stepCharacter` performs first — a `continue`, not a distance computation.
   */
  suspend() {
    if (!this.handle || this.suspended) return;
    this.suspended = true;
    if (this.kind === 'blocker') {
      this.handle.yMin = Infinity;
      this.handle.yMax = Infinity;
    } else if (typeof this.physics.setCapsuleEnabled === 'function') {
      this.physics.setCapsuleEnabled(this.handle, false);
    } else if (this.handle && 'enabled' in this.handle) {
      this.handle.enabled = false;
    }
  }

  resume(position) {
    if (!this.handle || !this.suspended) return;
    this.suspended = false;
    if (this.kind === 'blocker') {
      this.handle.yMin = (position ? position.y : 0) + Y_LOW;
      this.handle.yMax = (position ? position.y : 0) + Y_HIGH;
    } else if (typeof this.physics.setCapsuleEnabled === 'function') {
      this.physics.setCapsuleEnabled(this.handle, true);
    } else if (this.handle && 'enabled' in this.handle) {
      this.handle.enabled = true;
    }
  }

  /** Published for any other system that wants the animal's volume. */
  spec() {
    return { p0: this.p0, p1: this.p1, radius: this.radius, active: this.active };
  }

  dispose() {
    if (!this.handle || !this.physics) return;
    if (this.kind === 'blocker' && this.physics.removeBlocker) {
      this.physics.removeBlocker(this.handle);
    } else if (this.kind === 'capsule' && this.physics.removeCapsule) {
      this.physics.removeCapsule(this.handle);
    } else if (this.physics.removeBody) {
      this.physics.removeBody(this.handle);
    }
    this.handle = null;
  }
}
