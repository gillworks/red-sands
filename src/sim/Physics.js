import * as THREE from 'three';

/**
 * RED SANDS — PHYSICS
 * ============================================================================
 * Deliberately small. There is no collision mesh anywhere in this world: the
 * ground is an analytic heightfield (`ctx.world.getHeight`) and everything
 * else is a handful of convex proxies, so the whole solver is a few hundred
 * lines and costs microseconds.
 *
 *   FIXED TIMESTEP   1/60 with an accumulator; rendering interpolates with
 *                    `physics.alpha`. Systems that need to integrate at the
 *                    same cadence register with `addStepper(fn)`.
 *   CHARACTER        capsule controller: gravity, ground snap, slope limit,
 *                    step-up, wall slide.  `stepCharacter()`
 *   PROPS            impulse rigid bodies against the terrain and each other,
 *                    with sleeping.
 *   QUERIES          raycast() / sphereCast() — analytic against the height-
 *                    field plus registered bodies. Water, Scatter and the
 *                    camera arm all use these.
 * ============================================================================
 */

const GRAVITY = -9.81;
const FIXED = 1 / 60;
const MAX_SUB = 5;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _e = new THREE.Euler();

/* ==========================================================================
 *  COLLIDERS — the shared solid-world API (added this pass)
 * ==========================================================================
 *
 * `addBody()` above is a *dynamic prop* — it falls, it rolls, it sleeps, and
 * every one of them is a sphere. That is the wrong shape for "this rock is
 * solid", "this deer is solid", "this townsman is solid": those never
 * integrate, most of them are boxes or capsules, and there can be hundreds of
 * them. A linear scan over all of that, twice per fixed step (player + horse)
 * plus once per camera-arm sphere cast plus once per bullet, is exactly the
 * cost this project has no room for.
 *
 * So colliders are a separate, query-only population with a broad phase:
 *
 *   STATIC   rocks, buildings, fences. Inserted once into a uniform spatial
 *            hash over XZ (8 m cells). Never re-hashed unless you ask.
 *   DYNAMIC  the horse, animals, townsfolk. A small flat array — there are
 *            tens of them, not hundreds — whose `position` is a LIVE
 *            Vector3 reference shared with the owner, so "moving with the
 *            animal" costs literally zero: no copy, no re-hash, no dirty flag.
 *
 * Both are visible to `raycast()` and `sphereCast()` (masked), so the camera
 * arm and the bullet ray see them. `addBlocker()` is deliberately NOT part of
 * this and stays invisible to queries — see its doc comment.
 */

/** Query layers. A collider is seen by a query iff `collider.mask & queryMask`. */
export const LAYER = {
  WORLD: 1 << 0,     // terrain-fixed solids: rock, cliff, building
  PROP: 1 << 1,      // crates, barrels, fences, wagons
  NPC: 1 << 2,       // townsfolk
  ANIMAL: 1 << 3,    // deer, rabbits, anything with a pulse
  MOUNT: 1 << 4,     // the horse
  CORPSE: 1 << 5,    // things that used to be one of the above
  ALL: 0xffff,
};

/**
 * What `stepCharacter` pushes out of when the caller does not say otherwise.
 *
 * MOUNT is excluded ON PURPOSE. The horse wants a real collider so the bullet
 * ray hits it and the camera arm does not clip through it, but if the capsule
 * controller also honoured it then (a) the rider's own body would be pushed out
 * of the horse it is sitting on, and (b) a player walking up to mount would be
 * shoved away at arm's length and could never reach the stirrup. Both of those
 * are worse bugs than "you can lean into your horse". A caller that wants the
 * mount solid can ask for it: `state.colliderMask = physics.LAYER.ALL`.
 */
const CHAR_MASK = 0xffff & ~(1 << 4);

/** Spatial-hash cell, metres. Town buildings are ~10 m, rocks 1–6 m. */
const CELL = 8;
const CELL_ORIGIN = 8192;

/**
 * Uniform spatial hash over XZ. Numeric keys (no string concat, no allocation
 * per lookup); results are gathered with a monotonic stamp instead of a Set so
 * a query allocates nothing at all.
 */
class Broadphase {
  constructor(cell = CELL) {
    this.cell = cell;
    this.inv = 1 / cell;
    this.cells = new Map();
    this.oversize = [];      // things too big to hash sanely; always tested
    this.count = 0;
  }

  static key(ix, iz) { return (ix + CELL_ORIGIN) * 16384 + (iz + CELL_ORIGIN); }

  insert(c) {
    const i0 = Math.floor(c.minX * this.inv), i1 = Math.floor(c.maxX * this.inv);
    const j0 = Math.floor(c.minZ * this.inv), j1 = Math.floor(c.maxZ * this.inv);
    this.count++;
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 64) { c._cells = null; this.oversize.push(c); return; }
    const list = c._cells = [];
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = Broadphase.key(i, j);
        let b = this.cells.get(k);
        if (!b) { b = []; this.cells.set(k, b); }
        b.push(c);
        list.push(k);
      }
    }
  }

  remove(c) {
    this.count--;
    if (!c._cells) {
      const i = this.oversize.indexOf(c);
      if (i >= 0) this.oversize.splice(i, 1);
      return;
    }
    for (const k of c._cells) {
      const b = this.cells.get(k);
      if (!b) continue;
      const i = b.indexOf(c);
      if (i >= 0) b.splice(i, 1);
      if (!b.length) this.cells.delete(k);
    }
    c._cells = null;
  }

  /** Gather every collider whose cell overlaps the XZ box, into `out`. */
  queryBox(minX, minZ, maxX, maxZ, out, stamp) {
    const i0 = Math.floor(minX * this.inv), i1 = Math.floor(maxX * this.inv);
    const j0 = Math.floor(minZ * this.inv), j1 = Math.floor(maxZ * this.inv);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const b = this.cells.get(Broadphase.key(i, j));
        if (!b) continue;
        for (let k = 0; k < b.length; k++) {
          const c = b[k];
          if (c._stamp === stamp) continue;
          c._stamp = stamp;
          out.push(c);
        }
      }
    }
    for (let k = 0; k < this.oversize.length; k++) {
      const c = this.oversize[k];
      if (c._stamp === stamp) continue;
      c._stamp = stamp;
      out.push(c);
    }
  }

  _cell(i, j, out, stamp) {
    const b = this.cells.get(Broadphase.key(i, j));
    if (!b) return;
    for (let k = 0; k < b.length; k++) {
      const c = b[k];
      if (c._stamp === stamp) continue;
      c._stamp = stamp;
      out.push(c);
    }
  }

  /**
   * Amanatides–Woo DDA along the XZ projection of a segment. `fat` widens the
   * walk to the 3×3 neighbourhood, which is conservative for any sweep radius
   * up to one cell (8 m) — plenty for the 0.45 m camera arm.
   */
  querySegment(ox, oz, dx, dz, len, fat, out, stamp) {
    for (let k = 0; k < this.oversize.length; k++) {
      const c = this.oversize[k];
      if (c._stamp === stamp) continue;
      c._stamp = stamp;
      out.push(c);
    }
    const inv = this.inv;
    let i = Math.floor(ox * inv), j = Math.floor(oz * inv);
    const gather = fat
      ? () => { for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) this._cell(i + a, j + b, out, stamp); }
      : () => this._cell(i, j, out, stamp);
    gather();
    if (len <= 0) return;
    const si = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const sj = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    if (si === 0 && sj === 0) return;
    const tdx = si !== 0 ? Math.abs(this.cell / dx) : Infinity;
    const tdz = sj !== 0 ? Math.abs(this.cell / dz) : Infinity;
    let tmx = si !== 0
      ? ((si > 0 ? (i + 1) * this.cell - ox : ox - i * this.cell) / Math.abs(dx))
      : Infinity;
    let tmz = sj !== 0
      ? ((sj > 0 ? (j + 1) * this.cell - oz : oz - j * this.cell) / Math.abs(dz))
      : Infinity;
    let guard = 4096;
    while (guard-- > 0) {
      if (tmx < tmz) { if (tmx > len) return; i += si; tmx += tdx; }
      else { if (tmz > len) return; j += sj; tmz += tdz; }
      gather();
    }
  }
}

export class Physics {
  static id = 'physics';

  constructor(ctx) {
    this.ctx = ctx;
    this.bodies = [];
    this.blockers = [];
    this.steppers = [];
    this._acc = 0;
    /** 0..1 blend between the previous and the current fixed state. */
    this.alpha = 0;
    this.gravity = GRAVITY;
    this.fixedStep = FIXED;
    this.substeps = 0;
    this._nextId = 1;

    /* ---- colliders (see the block comment above LAYER) ------------------ */
    this.LAYER = LAYER;
    /** Default solid set for the capsule controller — see CHAR_MASK. */
    this.characterMask = CHAR_MASK;
    this._grid = new Broadphase(CELL);
    /** Moving colliders: horse, animals, townsfolk. Tens, not hundreds. */
    this.dynamics = [];
    this._cand = [];
    this._stamp = 0;
    /** Rolling cost of the collider broad+narrow phase, ms per frame. */
    this.msColliders = 0;
    this._msAcc = 0;
    this._probes = 0;
    this._queries = 0;
  }

  async init() { /* nothing to load */ }

  /* ------------------------------------------------------------ colliders */

  /**
   * Register a solid shape. Nothing here integrates: a collider is a *fact
   * about the world*, not a simulated body.
   *
   * @param {object} d
   *   shape        'capsule' (default) | 'sphere' | 'box'
   *   position     THREE.Vector3. For `capsule` this is the BASE (feet), which
   *                is the same convention `stepCharacter` uses; for `sphere`
   *                and `box` it is the centre. **Kept by reference when
   *                `kind:'dynamic'`** — hand in the Vector3 you already mutate
   *                and the collider tracks the entity for free.
   *   radius       capsule / sphere
   *   height       capsule, total base→top
   *   halfExtents  box, THREE.Vector3 (x along the local axis, y up, z across)
   *   quaternion   box only; only the Y component is used (upright boxes)
   *   yaw          box only; alternative to `quaternion`, radians
   *   kind         'static' (default, hashed once) | 'dynamic' (flat list)
   *   mask         LAYER bits this collider answers to. Default LAYER.WORLD.
   *   solid        blocks the character controller. Default true.
   *   queryable    visible to raycast/sphereCast. Default true.
   *   owner        anything; handed back on every hit
   *   tag          short string, e.g. 'rock' | 'npc' | 'deer'
   * @returns {object} handle — pass to removeCollider / refreshCollider
   */
  addCollider(d = {}) {
    const c = {
      id: this._nextId++,
      shape: d.shape || 'capsule',
      kind: d.kind === 'dynamic' ? 'dynamic' : 'static',
      position: d.position && d.position.isVector3
        ? (d.kind === 'dynamic' ? d.position : d.position.clone())
        : new THREE.Vector3().copy(d.position || _a.set(0, 0, 0)),
      radius: d.radius != null ? d.radius : 0.35,
      height: d.height != null ? d.height : 1.8,
      hx: 0.5, hy: 0.5, hz: 0.5,
      ux: 1, uz: 0,
      mask: d.mask != null ? d.mask : LAYER.WORLD,
      solid: d.solid !== false,
      queryable: d.queryable !== false,
      enabled: d.enabled !== false,
      owner: d.owner != null ? d.owner : null,
      tag: d.tag || '',
      minX: 0, maxX: 0, minZ: 0, maxZ: 0, minY: 0, maxY: 0,
      _cells: null, _stamp: -1,
    };
    if (d.halfExtents) { c.hx = d.halfExtents.x; c.hy = d.halfExtents.y; c.hz = d.halfExtents.z; }
    let yaw = d.yaw;
    if (yaw == null && d.quaternion) yaw = _e.setFromQuaternion(d.quaternion, 'YXZ').y;
    if (yaw) { c.ux = Math.cos(yaw); c.uz = -Math.sin(yaw); }
    if (d.axis) {
      const l = Math.hypot(d.axis[0], d.axis[1]) || 1;
      c.ux = d.axis[0] / l; c.uz = d.axis[1] / l;
    }
    this._aabb(c);
    if (c.kind === 'dynamic') this.dynamics.push(c);
    else this._grid.insert(c);
    return c;
  }

  removeCollider(c) {
    if (!c) return;
    if (c.kind === 'dynamic') {
      const i = this.dynamics.indexOf(c);
      if (i >= 0) this.dynamics.splice(i, 1);
    } else if (c._cells !== undefined) {
      this._grid.remove(c);
    }
  }

  /** A static collider moved or changed size: re-hash it. */
  refreshCollider(c) {
    if (!c) return;
    if (c.kind === 'dynamic') { this._aabb(c); return; }
    this._grid.remove(c);
    this._aabb(c);
    this._grid.insert(c);
  }

  /** Recompute the XZ/Y bounds of one collider from its current transform. */
  _aabb(c) {
    const p = c.position;
    if (c.shape === 'box') {
      const ex = Math.abs(c.ux) * c.hx + Math.abs(c.uz) * c.hz;
      const ez = Math.abs(c.uz) * c.hx + Math.abs(c.ux) * c.hz;
      c.minX = p.x - ex; c.maxX = p.x + ex;
      c.minZ = p.z - ez; c.maxZ = p.z + ez;
      c.minY = p.y - c.hy; c.maxY = p.y + c.hy;
    } else if (c.shape === 'sphere') {
      c.minX = p.x - c.radius; c.maxX = p.x + c.radius;
      c.minZ = p.z - c.radius; c.maxZ = p.z + c.radius;
      c.minY = p.y - c.radius; c.maxY = p.y + c.radius;
    } else {                                   // capsule, base at position
      c.minX = p.x - c.radius; c.maxX = p.x + c.radius;
      c.minZ = p.z - c.radius; c.maxZ = p.z + c.radius;
      c.minY = p.y; c.maxY = p.y + c.height;
    }
    return c;
  }

  /** Broad phase: everything whose bounds overlap an XZ box, into this._cand. */
  _gatherBox(minX, minZ, maxX, maxZ, mask) {
    const out = this._cand;
    out.length = 0;
    const stamp = ++this._stamp;
    this._grid.queryBox(minX, minZ, maxX, maxZ, out, stamp);
    const n = out.length;
    const dyn = this.dynamics;
    for (let i = 0; i < dyn.length; i++) {
      const c = dyn[i];
      if (!c.enabled || !(c.mask & mask)) continue;
      this._aabb(c);
      if (c.maxX < minX || c.minX > maxX || c.maxZ < minZ || c.minZ > maxZ) continue;
      c._stamp = stamp;
      out.push(c);
    }
    // statics were gathered without the mask/enabled test (the hash does not
    // know about either) — compact them in place now.
    let w = 0;
    for (let i = 0; i < n; i++) {
      const c = out[i];
      if (!c.enabled || !(c.mask & mask)) continue;
      if (c.maxX < minX || c.minX > maxX || c.maxZ < minZ || c.minZ > maxZ) continue;
      out[w++] = c;
    }
    for (let i = n; i < out.length; i++) out[w++] = out[i];
    out.length = w;
    return out;
  }

  stats() {
    return {
      statics: this._grid.count,
      dynamics: this.dynamics.length,
      cells: this._grid.cells.size,
      bodies: this.bodies.length,
      blockers: this.blockers.length,
      ms: Math.round(this.msColliders * 1000) / 1000,
    };
  }

  /* --------------------------------------------------------------- bodies */

  /**
   * @param {object} d { shape:'sphere'|'box', radius, halfExtents, mass,
   *                     position, quaternion, friction, restitution, mesh,
   *                     linearDamping, angularDamping, kinematic, mask }
   */
  addBody(d = {}) {
    const half = d.halfExtents
      ? new THREE.Vector3().copy(d.halfExtents)
      : new THREE.Vector3(0.3, 0.3, 0.3);
    const radius = d.radius != null ? d.radius : Math.max(half.x, half.y, half.z);
    const mass = d.mass != null ? d.mass : 1;
    const body = {
      id: this._nextId++,
      shape: d.shape || 'sphere',
      radius,
      half,
      mass,
      invMass: (mass === 0 || d.kinematic) ? 0 : 1 / Math.max(0.001, mass),
      position: new THREE.Vector3().copy(d.position || _a.set(0, 0, 0)),
      prev: new THREE.Vector3().copy(d.position || _a.set(0, 0, 0)),
      velocity: new THREE.Vector3().copy(d.velocity || _a.set(0, 0, 0)),
      quaternion: (d.quaternion || _quat.identity()).clone(),
      prevQuat: (d.quaternion || _quat.identity()).clone(),
      spin: new THREE.Vector3(),
      friction: d.friction != null ? d.friction : 0.6,
      restitution: d.restitution != null ? d.restitution : 0.18,
      linDamp: d.linearDamping != null ? d.linearDamping : 0.02,
      angDamp: d.angularDamping != null ? d.angularDamping : 0.35,
      mesh: d.mesh || null,
      kinematic: !!d.kinematic,
      sleeping: false,
      sleepTimer: 0,
      mask: d.mask != null ? d.mask : 0xffff,
      userData: d.userData || null,
    };
    this.bodies.push(body);
    return body;
  }

  removeBody(body) {
    const i = this.bodies.indexOf(body);
    if (i >= 0) this.bodies.splice(i, 1);
  }

  /* ------------------------------------------------------------- blockers */

  /**
   * A thin, vertical, walk-off wall that ONLY the capsule controller sees.
   *
   * `ctx.world.getHeight` is a single-valued heightfield: it cannot describe a
   * raised deck sitting over the ground it also has to report. The town's
   * boardwalks are a deliberate 44 cm step up, so a character walking at street
   * level would otherwise pass straight into the deck and be sliced off at the
   * shin. Rather than lie to the height query — which the foot IK, the contact
   * shadows and the audio all read as well — the walk edge is simply solid.
   *
   * Deliberately NOT a body: bodies are visible to `raycast`/`sphereCast`, and
   * an invisible sphere the camera arm can hit is a worse bug than the one
   * being fixed. Blockers are consulted by `stepCharacter` and nothing else.
   *
   * @param {object} b { ax, az, bx, bz, radius, yMin, yMax }  segment in XZ
   * @returns {object} handle for removeBlocker
   */
  addBlocker(b) {
    const seg = {
      ax: b.ax, az: b.az, bx: b.bx, bz: b.bz,
      radius: b.radius != null ? b.radius : 0.06,
      yMin: b.yMin != null ? b.yMin : -Infinity,
      yMax: b.yMax != null ? b.yMax : Infinity,
    };
    seg.dx = seg.bx - seg.ax;
    seg.dz = seg.bz - seg.az;
    const l2 = seg.dx * seg.dx + seg.dz * seg.dz;
    seg.invLen2 = l2 > 1e-9 ? 1 / l2 : 0;
    this.blockers.push(seg);
    return seg;
  }

  removeBlocker(seg) {
    const i = this.blockers.indexOf(seg);
    if (i >= 0) this.blockers.splice(i, 1);
  }

  /** Register a fixed-rate callback: fn(h) at exactly 1/60 s. */
  addStepper(fn) { if (typeof fn === 'function') this.steppers.push(fn); }
  removeStepper(fn) {
    const i = this.steppers.indexOf(fn);
    if (i >= 0) this.steppers.splice(i, 1);
  }

  /* ------------------------------------------------------------ main loop */

  update(dt) {
    // exponential average so a single spike does not read as the steady cost
    this.msColliders += (this._msAcc - this.msColliders) * 0.2;
    this.probes = this._probes;
    this.queries = this._queries;
    this._msAcc = 0;
    this._probes = 0;
    this._queries = 0;
    this._acc += Math.min(dt, 0.25);
    let n = 0;
    while (this._acc >= FIXED && n < MAX_SUB) {
      this.step(FIXED);
      this._acc -= FIXED;
      n++;
    }
    if (n === MAX_SUB) this._acc = 0;   // bail rather than spiral
    this.substeps = n;
    this.alpha = THREE.MathUtils.clamp(this._acc / FIXED, 0, 1);
  }

  step(h) {
    for (let i = 0; i < this.steppers.length; i++) this.steppers[i](h);
    this._integrate(h);
  }

  _integrate(h) {
    const world = this.ctx.world;
    const bodies = this.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      b.prev.copy(b.position);
      b.prevQuat.copy(b.quaternion);
      if (b.kinematic || b.invMass === 0 || b.sleeping) continue;

      b.velocity.y += GRAVITY * h;
      b.velocity.multiplyScalar(Math.max(0, 1 - b.linDamp * h));
      b.position.addScaledVector(b.velocity, h);

      // ---- terrain contact
      const gy = world.getHeight(b.position.x, b.position.z);
      if (b.position.y - b.radius < gy) {
        world.getNormal(b.position.x, b.position.z, _n);
        b.position.y = gy + b.radius;
        const vn = b.velocity.dot(_n);
        if (vn < 0) {
          _a.copy(_n).multiplyScalar(vn);
          _b.copy(b.velocity).sub(_a);                       // tangential
          b.velocity.copy(_b).multiplyScalar(Math.max(0, 1 - b.friction * 0.4));
          b.velocity.addScaledVector(_n, -vn * b.restitution);
          _c.crossVectors(_n, _b).multiplyScalar(-1 / Math.max(0.05, b.radius));
          b.spin.lerp(_c, 0.5);
        }
      }

      // ---- body vs body (spheres; props are few and small)
      for (let j = i + 1; j < bodies.length; j++) {
        const o = bodies[j];
        if (o.sleeping && b.sleeping) continue;
        _a.subVectors(o.position, b.position);
        const rr = b.radius + o.radius;
        const d2 = _a.lengthSq();
        if (d2 > rr * rr || d2 < 1e-8) continue;
        const dist = Math.sqrt(d2);
        _a.multiplyScalar(1 / dist);
        const pen = rr - dist;
        const wsum = b.invMass + o.invMass;
        if (wsum <= 0) continue;
        b.position.addScaledVector(_a, -pen * (b.invMass / wsum));
        o.position.addScaledVector(_a, pen * (o.invMass / wsum));
        const rel = _b.subVectors(o.velocity, b.velocity).dot(_a);
        if (rel < 0) {
          const imp = -(1 + Math.min(b.restitution, o.restitution)) * rel / wsum;
          b.velocity.addScaledVector(_a, -imp * b.invMass);
          o.velocity.addScaledVector(_a, imp * o.invMass);
          o.sleeping = false; o.sleepTimer = 0;
        }
      }

      // ---- angular + sleep
      b.spin.multiplyScalar(Math.max(0, 1 - b.angDamp * h));
      const sp = b.spin.length();
      if (sp > 1e-4) {
        _a.copy(b.spin).multiplyScalar(1 / sp);
        b.quaternion.premultiply(_quat.setFromAxisAngle(_a, sp * h)).normalize();
      }
      if (b.velocity.lengthSq() < 0.004 && sp < 0.06
        && b.position.y - b.radius <= world.getHeight(b.position.x, b.position.z) + 0.02) {
        b.sleepTimer += h;
        if (b.sleepTimer > 0.6) { b.sleeping = true; b.velocity.set(0, 0, 0); b.spin.set(0, 0, 0); }
      } else b.sleepTimer = 0;
    }
  }

  /** Push interpolated transforms out to any attached meshes. */
  lateUpdate() {
    const a = this.alpha;
    for (const b of this.bodies) {
      if (!b.mesh) continue;
      b.mesh.position.lerpVectors(b.prev, b.position, a);
      b.mesh.quaternion.slerpQuaternions(b.prevQuat, b.quaternion, a);
    }
  }

  wake(b) { b.sleeping = false; b.sleepTimer = 0; }

  /* -------------------------------------------------------- capsule mover */

  /**
   * Kinematic capsule character controller. `s.position` is the FEET point.
   *
   * @param {object} s { position, velocity, radius, height, grounded,
   *                     groundNormal, maxSlopeCos, stepHeight, snap }
   * @param {number} h fixed timestep
   */
  stepCharacter(s, h) {
    const world = this.ctx.world;
    const R = s.radius != null ? s.radius : 0.32;
    const stepH = s.stepHeight != null ? s.stepHeight : 0.42;
    const slopeCos = s.maxSlopeCos != null ? s.maxSlopeCos : 0.60;   // ~53 deg
    const p = s.position, v = s.velocity;
    if (!s.groundNormal) s.groundNormal = new THREE.Vector3(0, 1, 0);

    if (!s.grounded) v.y += GRAVITY * h;

    // ---- horizontal move, substepped so we never tunnel into a cliff
    _a.set(v.x * h, 0, v.z * h);
    const stepLen = _a.length();
    if (stepLen > 1e-6) {
      const steps = Math.min(4, 1 + Math.floor(stepLen / Math.max(0.05, R * 0.7)));
      _b.copy(_a).multiplyScalar(1 / steps);
      for (let i = 0; i < steps; i++) {
        const nx = p.x + _b.x, nz = p.z + _b.z;
        const hereY = world.getHeight(p.x, p.z);
        const nextY = world.getHeight(nx, nz);
        const rise = nextY - Math.max(p.y, hereY);
        world.getNormal(nx, nz, _n);
        const blocked = rise > stepH || (rise > 0.06 && _n.y < slopeCos);
        if (!blocked) {
          p.x = nx; p.z = nz;
        } else {
          // slide along the contour instead of sticking
          _c.set(_n.x, 0, _n.z);
          if (_c.lengthSq() > 1e-8) {
            _c.normalize();
            const into = _b.x * _c.x + _b.z * _c.z;
            if (into < 0) {
              const sx = _b.x - _c.x * into, sz = _b.z - _c.z * into;
              if (world.getHeight(p.x + sx, p.z + sz) - Math.max(p.y, hereY) <= stepH) {
                p.x += sx; p.z += sz;
              }
            }
          }
          v.x *= 0.55; v.z *= 0.55;
        }
      }
    }

    // ---- static body push-out (buildings, crates, fences)
    for (const b of this.bodies) {
      if (b.invMass !== 0 && !b.kinematic) continue;
      if (!(b.mask & 1)) continue;
      _a.set(p.x - b.position.x, 0, p.z - b.position.z);
      const rr = R + b.radius;
      const d2 = _a.lengthSq();
      if (d2 >= rr * rr || d2 < 1e-9) continue;
      if (p.y > b.position.y + b.half.y - 0.05) continue;
      if (p.y + (s.height || 1.8) < b.position.y - b.half.y) continue;
      const dist = Math.sqrt(d2);
      _a.multiplyScalar((rr - dist) / dist);
      p.x += _a.x; p.z += _a.z;
    }

    // ---- registered colliders (rocks, buildings, the horse, animals, folk)
    if (this._grid.count || this.dynamics.length) {
      const t0 = performance.now();
      this._resolveColliders(p, v, R, s.height || 1.8, s.colliderMask, s.colliderIgnore);
      this._msAcc += performance.now() - t0;
    }

    // ---- walk-off blockers (boardwalk edges): thin segments, controller only
    if (this.blockers.length) {
      const top = p.y + (s.height || 1.8);
      for (let i = 0; i < this.blockers.length; i++) {
        const g = this.blockers[i];
        if (p.y > g.yMax - 0.05 || top < g.yMin) continue;
        let u = ((p.x - g.ax) * g.dx + (p.z - g.az) * g.dz) * g.invLen2;
        if (u < 0) u = 0; else if (u > 1) u = 1;
        const qx = p.x - (g.ax + g.dx * u);
        const qz = p.z - (g.az + g.dz * u);
        const rr = R + g.radius;
        const d2 = qx * qx + qz * qz;
        if (d2 >= rr * rr) continue;
        const dist = Math.sqrt(d2);
        if (dist < 1e-5) continue;                 // exactly on the line: leave it
        const k = (rr - dist) / dist;
        p.x += qx * k; p.z += qz * k;
        const into = v.x * qx + v.z * qz;
        if (into < 0) { v.x *= 0.55; v.z *= 0.55; }
      }
    }

    // ---- vertical: integrate then snap
    p.y += v.y * h;
    const gy = world.getHeight(p.x, p.z);
    world.getNormal(p.x, p.z, _n);
    const snap = s.grounded ? (s.snap != null ? s.snap : 0.35) : 0.02;
    if (p.y <= gy + snap && v.y <= 0.35) {
      p.y = gy;
      if (v.y < 0) v.y = 0;
      s.grounded = true;
      s.groundNormal.copy(_n);
      if (_n.y < slopeCos) {                        // too steep to stand on
        const slide = 9.0 * (1 - _n.y);
        v.x += _n.x * slide * h;
        v.z += _n.z * slide * h;
      }
    } else {
      s.grounded = false;
    }
    if (p.y < gy) { p.y = gy; if (v.y < 0) v.y = 0; s.grounded = true; s.groundNormal.copy(_n); }
    return s;
  }

  /**
   * Depenetrate a vertical capsule from every solid collider it overlaps.
   *
   * Purely 2D: the character has already been moved and snapped in Y by the
   * caller, so the only thing left to decide is where in the XZ plane it is
   * allowed to stand. The vertical test is a span overlap, which is what lets
   * you walk under a raised deck and over a kerb without either of them
   * needing a mesh.
   *
   * Two passes. One is enough for a single wall, but a character wedged into
   * the inside corner of two buildings is pushed out of the first and into the
   * second on the same frame; the second pass settles that. Beyond two it is a
   * jitter source, not a fix.
   */
  _resolveColliders(p, v, R, height, mask, ignore) {
    const m = mask != null ? mask : CHAR_MASK;
    for (let pass = 0; pass < 2; pass++) {
      const list = this._gatherBox(p.x - R, p.z - R, p.x + R, p.z + R, m);
      this._probes += list.length;
      this._queries++;
      let hits = 0;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c.solid || c === ignore || (ignore && c.owner === ignore)) continue;
        // vertical span overlap: feet..head against the collider's own span
        if (c.maxY <= p.y + 0.04 || c.minY >= p.y + height) continue;
        const q = c.position;
        let nx, nz, pen;
        if (c.shape === 'box') {
          // into the box's own frame, push out along the shallower XZ axis
          const dx = p.x - q.x, dz = p.z - q.z;
          const lx = dx * c.ux + dz * c.uz;
          const lz = -dx * c.uz + dz * c.ux;
          const ox = c.hx + R - Math.abs(lx);
          const oz = c.hz + R - Math.abs(lz);
          if (ox <= 0 || oz <= 0) continue;
          if (ox < oz) {
            const s2 = lx < 0 ? -1 : 1;
            nx = c.ux * s2; nz = c.uz * s2; pen = ox;
          } else {
            const s2 = lz < 0 ? -1 : 1;
            nx = -c.uz * s2; nz = c.ux * s2; pen = oz;
          }
        } else {
          const dx = p.x - q.x, dz = p.z - q.z;
          const rr = c.radius + R;
          const d2 = dx * dx + dz * dz;
          if (d2 >= rr * rr) continue;
          if (d2 < 1e-8) { nx = 1; nz = 0; pen = rr; }
          else {
            const d = Math.sqrt(d2);
            nx = dx / d; nz = dz / d; pen = rr - d;
          }
        }
        p.x += nx * pen;
        p.z += nz * pen;
        const into = v.x * nx + v.z * nz;
        if (into < 0) { v.x -= nx * into; v.z -= nz * into; }   // slide, don't stop
        hits++;
      }
      if (!hits) break;
    }
  }

  /* -------------------------------------------------------------- queries */

  /**
   * Analytic terrain + body raycast.
   * @returns {{point:THREE.Vector3, normal:THREE.Vector3, distance:number,
   *            body:object|null}|null}
   */
  raycast(origin, dir, maxDist = 500, mask = 0xffff) {
    const world = this.ctx.world;
    const d = _a.copy(dir).normalize();
    let best = null;

    const terrain = this.ctx.get('terrain');
    if (terrain && terrain.raycast) {
      const hit = terrain.raycast(origin, d);
      if (hit && hit.distance <= maxDist) best = { point: hit.point, normal: hit.normal, distance: hit.distance, body: null };
    } else if (world.ready) {
      let t = 0, step = 0.6;
      while (t < maxDist) {
        t = Math.min(t + step, maxDist);
        _b.copy(origin).addScaledVector(d, t);
        const diff = _b.y - world.getHeight(_b.x, _b.z);
        if (diff < 0) {
          let lo = t - step, hi = t;
          for (let i = 0; i < 16; i++) {
            const m = (lo + hi) * 0.5;
            _c.copy(origin).addScaledVector(d, m);
            if (_c.y - world.getHeight(_c.x, _c.z) < 0) hi = m; else lo = m;
          }
          _c.copy(origin).addScaledVector(d, hi);
          best = {
            point: _c.clone(),
            normal: world.getNormal(_c.x, _c.z, new THREE.Vector3()),
            distance: hi,
            body: null,
          };
          break;
        }
        step = Math.max(0.5, Math.min(24, diff * 0.6 + t * 0.01));
      }
    }

    for (const b of this.bodies) {
      if (!(b.mask & mask)) continue;
      _b.subVectors(b.position, origin);
      const tca = _b.dot(d);
      if (tca < -b.radius) continue;
      const dd = _b.lengthSq() - tca * tca;
      const r2 = b.radius * b.radius;
      if (dd > r2) continue;
      const thc = Math.sqrt(r2 - dd);
      const t0 = tca - thc;
      const t = t0 >= 0 ? t0 : tca + thc;
      if (t < 0 || t > maxDist) continue;
      if (!best || t < best.distance) {
        const pt = new THREE.Vector3().copy(origin).addScaledVector(d, t);
        best = { point: pt, normal: pt.clone().sub(b.position).normalize(), distance: t, body: b };
      }
    }

    const ch = this._castColliders(origin, d, 0, best ? Math.min(best.distance, maxDist) : maxDist, mask);
    if (ch && (!best || ch.distance < best.distance)) best = ch;
    return best;
  }

  /**
   * Shared narrow phase for raycast (`swell` 0) and sphereCast (`swell` = the
   * sweep radius). Sphere-vs-sphere and sphere-vs-capsule inflate EXACTLY, so
   * the sphere cast against a body or a person is analytic, not marched; the
   * box is inflated as an AABB, which rounds the corners off the wrong way and
   * therefore only ever reports the hit slightly early. For a camera arm that
   * is the safe direction.
   *
   * A collider that CONTAINS the origin is skipped. Without that, the moment
   * the camera pivot sits inside the horse's capsule the arm collapses to zero
   * and the third-person camera is inside the rider's head.
   */
  _castColliders(origin, d, swell, maxDist, mask) {
    if (!this._grid.count && !this.dynamics.length) return null;
    const m = mask != null ? mask : LAYER.ALL;
    const t0 = performance.now();
    const out = this._cand;
    out.length = 0;
    const stamp = ++this._stamp;
    const fat = swell > 0.001;
    this._grid.querySegment(origin.x, origin.z, d.x, d.z, maxDist, fat, out, stamp);
    const nStatic = out.length;
    /* The dynamic list has no hash, so reject it against the segment's own
     * bounding box first. Four compares each. Without this the camera arm —
     * a 4 m cast that runs every single frame — pays a full narrow-phase test
     * against every animal and townsperson in the world. */
    const ex = origin.x + d.x * maxDist, ey = origin.y + d.y * maxDist, ez = origin.z + d.z * maxDist;
    const bx0 = Math.min(origin.x, ex) - swell, bx1 = Math.max(origin.x, ex) + swell;
    const by0 = Math.min(origin.y, ey) - swell, by1 = Math.max(origin.y, ey) + swell;
    const bz0 = Math.min(origin.z, ez) - swell, bz1 = Math.max(origin.z, ez) + swell;
    for (let i = 0; i < this.dynamics.length; i++) {
      const c = this.dynamics[i];
      if (!c.enabled || !c.queryable || !(c.mask & m)) continue;
      this._aabb(c);
      if (c.maxX < bx0 || c.minX > bx1 || c.maxZ < bz0 || c.minZ > bz1
        || c.maxY < by0 || c.minY > by1) continue;
      out.push(c);
    }
    this._probes += out.length;
    this._queries++;

    let hit = null;
    let bestT = maxDist;
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      if (i < nStatic && (!c.enabled || !c.queryable || !(c.mask & m))) continue;
      const q = c.position;
      let t = -1, nx = 0, ny = 0, nz = 0;
      if (c.shape === 'box') {
        const hx = c.hx + swell, hy = c.hy + swell, hz = c.hz + swell;
        const dx = origin.x - q.x, dy = origin.y - q.y, dz = origin.z - q.z;
        const ox = dx * c.ux + dz * c.uz;
        const oz = -dx * c.uz + dz * c.ux;
        if (Math.abs(ox) < hx && Math.abs(dy) < hy && Math.abs(oz) < hz) continue;  // inside
        const rx = d.x * c.ux + d.z * c.uz;
        const rz = -d.x * c.uz + d.z * c.ux;
        let tmin = 0, tmax = bestT, axis = 0, sgn = 0;
        const slab = (o, r, h, ax) => {
          if (Math.abs(r) < 1e-8) return o >= -h && o <= h;
          const inv = 1 / r;
          let t1 = (-h - o) * inv, t2 = (h - o) * inv, s2 = -1;
          if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s2 = 1; }
          if (t1 > tmin) { tmin = t1; axis = ax; sgn = s2; }
          if (t2 < tmax) tmax = t2;
          return tmin <= tmax;
        };
        if (!slab(ox, rx, hx, 0)) continue;
        if (!slab(dy, d.y, hy, 1)) continue;
        if (!slab(oz, rz, hz, 2)) continue;
        if (tmin < 0 || tmin > bestT) continue;
        t = tmin;
        if (axis === 0) { nx = c.ux * sgn; nz = c.uz * sgn; }
        else if (axis === 1) { ny = sgn; }
        else { nx = -c.uz * sgn; nz = c.ux * sgn; }
      } else if (c.shape === 'sphere') {
        const r = c.radius + swell;
        const ex = q.x - origin.x, ey = q.y - origin.y, ez = q.z - origin.z;
        const l2 = ex * ex + ey * ey + ez * ez;
        if (l2 < r * r) continue;                                  // inside
        const tca = ex * d.x + ey * d.y + ez * d.z;
        if (tca < 0) continue;
        const dd = l2 - tca * tca;
        if (dd > r * r) continue;
        t = tca - Math.sqrt(r * r - dd);
        if (t < 0 || t > bestT) continue;
        nx = origin.x + d.x * t - q.x; ny = origin.y + d.y * t - q.y; nz = origin.z + d.z * t - q.z;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
      } else {
        // upright capsule: cylinder body between the two cap centres
        const r = c.radius + swell;
        const y0 = q.y + c.radius, y1 = q.y + Math.max(c.radius, c.height - c.radius);
        const ex = origin.x - q.x, ez = origin.z - q.z;
        const cy = origin.y < y0 ? y0 : origin.y > y1 ? y1 : origin.y;
        if (ex * ex + ez * ez + (origin.y - cy) * (origin.y - cy) < r * r) continue;  // inside
        const A = d.x * d.x + d.z * d.z;
        if (A > 1e-9) {
          const Bq = ex * d.x + ez * d.z;
          const C = ex * ex + ez * ez - r * r;
          const disc = Bq * Bq - A * C;
          if (disc >= 0) {
            const sq = Math.sqrt(disc);
            let tt = (-Bq - sq) / A;
            if (tt < 0) tt = (-Bq + sq) / A;
            if (tt >= 0 && tt < bestT) {
              const hy2 = origin.y + d.y * tt;
              if (hy2 >= y0 && hy2 <= y1) {
                t = tt;
                nx = origin.x + d.x * tt - q.x; nz = origin.z + d.z * tt - q.z;
                const nl = Math.hypot(nx, nz) || 1;
                nx /= nl; nz /= nl; ny = 0;
              }
            }
          }
        }
        // caps
        for (let k = 0; k < 2; k++) {
          const cyk = k === 0 ? y0 : y1;
          const gx = q.x - origin.x, gy = cyk - origin.y, gz = q.z - origin.z;
          const tca = gx * d.x + gy * d.y + gz * d.z;
          if (tca < 0) continue;
          const dd = (gx * gx + gy * gy + gz * gz) - tca * tca;
          if (dd > r * r) continue;
          const tt = tca - Math.sqrt(r * r - dd);
          if (tt < 0 || tt >= bestT || (t >= 0 && tt >= t)) continue;
          t = tt;
          nx = origin.x + d.x * tt - q.x; ny = origin.y + d.y * tt - cyk; nz = origin.z + d.z * tt - q.z;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl; ny /= nl; nz /= nl;
        }
        if (t < 0) continue;
      }
      if (t < 0 || t > bestT) continue;
      bestT = t;
      hit = {
        point: new THREE.Vector3(origin.x + d.x * t, origin.y + d.y * t, origin.z + d.z * t),
        normal: new THREE.Vector3(nx, ny, nz),
        distance: t,
        body: null,
        collider: c,
        owner: c.owner,
        tag: c.tag,
      };
    }
    this._msAcc += performance.now() - t0;
    return hit;
  }

  /**
   * Conservative sphere cast — the camera arm rides on this so it never clips
   * the ground. Marches the sphere centre and bisects the first blocked span.
   */
  sphereCast(origin, dir, radius, maxDist = 100, mask = 0xffff) {
    const world = this.ctx.world;
    const d = _a.copy(dir).normalize();
    const steps = Math.max(6, Math.min(48, Math.ceil(maxDist / Math.max(0.05, radius * 0.75))));
    let hit = null;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * maxDist;
      _b.copy(origin).addScaledVector(d, t);
      if (_b.y - radius < world.getHeight(_b.x, _b.z)) {
        let lo = ((i - 1) / steps) * maxDist, hi = t;
        for (let k = 0; k < 12; k++) {
          const m = (lo + hi) * 0.5;
          _c.copy(origin).addScaledVector(d, m);
          if (_c.y - radius < world.getHeight(_c.x, _c.z)) hi = m; else lo = m;
        }
        _c.copy(origin).addScaledVector(d, lo);
        hit = {
          point: _c.clone(),
          normal: world.getNormal(_c.x, _c.z, new THREE.Vector3()),
          distance: lo,
          body: null,
        };
        break;
      }
    }
    for (const b of this.bodies) {
      if (!(b.mask & mask)) continue;
      _b.subVectors(b.position, origin);
      const rr = b.radius + radius;
      const tca = _b.dot(d);
      if (tca < -rr) continue;
      const dd = _b.lengthSq() - tca * tca;
      if (dd > rr * rr) continue;
      const t = Math.max(0, tca - Math.sqrt(Math.max(0, rr * rr - dd)));
      if (t > maxDist) continue;
      if (!hit || t < hit.distance) {
        const pt = new THREE.Vector3().copy(origin).addScaledVector(d, t);
        hit = { point: pt, normal: pt.clone().sub(b.position).normalize(), distance: t, body: b };
      }
    }

    const ch = this._castColliders(origin, d, radius,
      hit ? Math.min(hit.distance, maxDist) : maxDist, mask);
    if (ch && (!hit || ch.distance < hit.distance)) hit = ch;
    return hit;
  }

  dispose() {
    this.bodies.length = 0;
    this.blockers.length = 0;
    this.steppers.length = 0;
    this.dynamics.length = 0;
    this._grid = new Broadphase(CELL);
  }
}
