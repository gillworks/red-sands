/**
 * SCATTER COLLISION — "the rocks have no collider you can walk straight through
 * them".
 * ============================================================================
 *
 * WHAT THE PLAYER HITS, AND WHY IT IS NOT A MESH
 * ----------------------------------------------------------------------------
 * Scatter submits 8-15k instances a frame across a 980 m ring. Nothing about
 * that is a candidate for per-triangle collision, and nothing needs to be: what
 * the player actually feels is "I cannot walk into that". So every solid prop
 * gets ONE 2-D CAPSULE — a segment in XZ with a radius, plus a [yMin, yMax]
 * band — which is exact for a fallen log, close enough for a boulder, and a
 * reasonable convex hull for a butte.
 *
 * WHY BLOCKERS AND NOT BODIES
 * ----------------------------------------------------------------------------
 * `Physics.addBody` would have worked — `stepCharacter` push-out treats a static
 * body as a vertical cylinder — but bodies are also visible to `raycast()` and
 * `sphereCast()` as SPHERES of `b.radius`. The camera arm rides on `sphereCast`.
 * A 30 m butte registered as a body is a 10 m invisible sphere the camera would
 * be shoved out of from 11 m away, and `Physics` has no mask that can hide a
 * body from a caller that passes the default 0xffff.
 *
 * `Physics.addBlocker` is documented as "consulted by stepCharacter and nothing
 * else", is already a segment-with-radius in XZ with a y band, and is therefore
 * exactly the shape and exactly the visibility this needs. Both the player and
 * the horse go through `stepCharacter`, so both are blocked.
 *
 * BROAD PHASE
 * ----------------------------------------------------------------------------
 * `stepCharacter` scans its blocker list linearly, twice per character per fixed
 * step. So the list is never allowed to be long. Every solid prop within 78 m of
 * the streaming origin goes into a uniform grid owned by this module (built once
 * per Scatter rebuild, i.e. per ~26 m of travel), and only the handful within
 * 13 m of the player is ever registered with Physics. The per-frame work is a
 * 2 m movement gate followed by a query over ~9 grid cells; the physics-side
 * work is a scan over the ~0-12 capsules the player could actually touch.
 *
 * WHAT IS DELIBERATELY NOT REGISTERED
 * ----------------------------------------------------------------------------
 * Anything under `MIN_H` (0.40 m — the character controller's own step height is
 * 0.42, so it walks over these anyway), all foliage, bones, tumbleweed and
 * bedding decals, and every prop outside the registry radius. A pebble deserves
 * nothing at all.
 */

/** Registry radius around the streaming origin, metres. */
const REG_R = 78;
/** Uniform grid cell, metres. */
const CELL = 12;
/** Register with Physics inside this radius of the player... */
const ACTIVE_R = 13;
/** ...and drop it again out here (hysteresis, so a pacing player has no churn). */
const DROP_R = 17.5;
/** Below this height the controller steps over it; not worth a collider. */
const MIN_H = 0.40;
/** Hard cap on the registry. */
const MAX_PROXY = 2200;

/**
 * Per-kind proxy tuning.
 *   inset  fraction of the render bounds the capsule occupies
 *   thin   if set, the capsule radius is this fraction of the SHORT half-extent
 *          rather than derived from the bounds (trunks and stems, whose bounds
 *          are dominated by a canopy the player walks straight through)
 *   minR   floor on the capsule radius
 */
const KINDS = {
  rock: { inset: 0.82 },
  outcrop: { inset: 0.80 },
  stone: { inset: 0.85 },
  log: { inset: 0.88 },
  driftwood: { inset: 0.88 },
  stump: { inset: 0.80 },
  deadtree: { inset: 1.0, thin: 0.20, minR: 0.16 },
  saguaro: { inset: 1.0, thin: 0.34, minR: 0.16 },
  post: { inset: 1.0, thin: 0.5, minR: 0.09 },
  ruin: { inset: 0.92 },
};

export class ScatterCollision {
  constructor(ctx) {
    this.ctx = ctx;
    /** Live registry: capsules within REG_R of the streaming origin. */
    this.list = [];
    /** Registry being accumulated by the in-flight rebuild. */
    this._pending = [];
    this._head = null;
    this._next = null;
    this._gx0 = 0; this._gz0 = 0; this._gn = 1;
    this._maxR = 0;
    /** proxy index → Physics blocker handle */
    this._active = new Map();
    this._lastX = 1e9; this._lastZ = 1e9;
    this._tmp = [];
    this.stats = { registry: 0, active: 0, ms: 0 };
  }

  /* ------------------------------------------------------------- authoring */

  /** Start accumulating a new registry. Called at the top of Scatter._rebuild. */
  begin(ox, oz) {
    this._pending.length = 0;
    this._ox = ox; this._oz = oz;
  }

  /**
   * Offer one placed instance. Cheap-rejects first: the distance gate is a
   * single compare and it throws away ~95% of what Scatter emits.
   *
   * @param {string} kind
   * @param {number} dist  distance from the streaming origin (already known)
   * @param {number} x,y,z ground anchor (y is the seated base, sink applied)
   * @param {number} halfX,halfZ world half-extents of the render bounds
   * @param {number} h     world height
   * @param {number} yaw   instance yaw
   */
  offer(kind, dist, x, y, z, halfX, halfZ, h, yaw) {
    if (dist > REG_R || h < MIN_H) return;
    const K = KINDS[kind];
    if (!K) return;
    if (this._pending.length >= MAX_PROXY) return;
    let long = Math.max(halfX, halfZ);
    let short = Math.min(halfX, halfZ);
    let r, half;
    if (K.thin) {
      r = Math.max(K.minR || 0.05, short * K.thin);
      half = 0;
    } else {
      r = Math.max(K.minR || 0.05, short * K.inset);
      /* the capsule's segment carries whatever the shape has beyond a circle */
      half = Math.max(0, long * K.inset - r);
    }
    if (r < 0.07) return;
    /* the long axis is x or z in instance space; rotate it into the world */
    const alongX = halfX >= halfZ;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const dx = (alongX ? c : s) * half;
    const dz = (alongX ? -s : c) * half;
    this._pending.push({
      ax: x - dx, az: z - dz, bx: x + dx, bz: z + dz,
      r, yMin: y - 0.35, yMax: y + h,
      /* bounding radius about the midpoint, for the grid and the range tests */
      br: r + half,
      x, z,
    });
  }

  /** Publish the accumulated registry and rebuild the broad phase. */
  commit() {
    const t0 = performance.now();
    const tmp = this.list;
    this.list = this._pending;
    this._pending = tmp;
    this._pending.length = 0;
    this._buildGrid();
    /* every index changed — drop the whole active set and re-stream */
    this._clearActive();
    this._lastX = 1e9;
    this.stats.registry = this.list.length;
    this.stats.ms = performance.now() - t0;
  }

  _buildGrid() {
    const n = this.list.length;
    const R = REG_R + CELL;
    this._gx0 = this._ox - R;
    this._gz0 = this._oz - R;
    const gn = Math.ceil((R * 2) / CELL) + 1;
    this._gn = gn;
    if (!this._head || this._head.length !== gn * gn) this._head = new Int32Array(gn * gn);
    this._head.fill(-1);
    if (!this._next || this._next.length < n) this._next = new Int32Array(Math.max(64, n * 2));
    let maxR = 0;
    for (let i = 0; i < n; i++) {
      const c = this.list[i];
      if (c.br > maxR) maxR = c.br;
      let gx = ((c.x - this._gx0) / CELL) | 0;
      let gz = ((c.z - this._gz0) / CELL) | 0;
      if (gx < 0) gx = 0; else if (gx >= gn) gx = gn - 1;
      if (gz < 0) gz = 0; else if (gz >= gn) gz = gn - 1;
      const k = gz * gn + gx;
      this._next[i] = this._head[k];
      this._head[k] = i;
    }
    this._maxR = maxR;
  }

  /* ---------------------------------------------------------------- query */

  /**
   * Broad phase. Every capsule whose swept extent reaches within `r` of (x,z).
   * @returns {number[]} indices into `this.list` (the array is reused)
   */
  query(x, z, r, out = []) {
    out.length = 0;
    const gn = this._gn;
    if (!this._head || !this.list.length) return out;
    const reach = r + this._maxR;
    let i0 = ((x - reach - this._gx0) / CELL) | 0;
    let i1 = ((x + reach - this._gx0) / CELL) | 0;
    let j0 = ((z - reach - this._gz0) / CELL) | 0;
    let j1 = ((z + reach - this._gz0) / CELL) | 0;
    if (i0 < 0) i0 = 0; if (j0 < 0) j0 = 0;
    if (i1 >= gn) i1 = gn - 1; if (j1 >= gn) j1 = gn - 1;
    for (let j = j0; j <= j1; j++) {
      const row = j * gn;
      for (let i = i0; i <= i1; i++) {
        for (let k = this._head[row + i]; k >= 0; k = this._next[k]) {
          const c = this.list[k];
          const dx = c.x - x, dz = c.z - z;
          const rr = r + c.br;
          if (dx * dx + dz * dz <= rr * rr) out.push(k);
        }
      }
    }
    return out;
  }

  /* -------------------------------------------------------------- physics */

  /**
   * Keep the Physics blocker list equal to "what the player could touch".
   * Gated on 2 m of player movement, so most frames this costs one compare.
   */
  stream(force = false) {
    const ctx = this.ctx;
    const PH = ctx.get('physics');
    if (!PH || !PH.addBlocker) return 0;
    const p = ctx.player && ctx.player.position;
    if (!p) return 0;
    const dx = p.x - this._lastX, dz = p.z - this._lastZ;
    if (!force && dx * dx + dz * dz < 4) return this._active.size;
    this._lastX = p.x; this._lastZ = p.z;

    const want = this.query(p.x, p.z, ACTIVE_R, this._tmp);
    const act = this._active;
    for (let i = 0; i < want.length; i++) {
      const k = want[i];
      if (act.has(k)) continue;
      const c = this.list[k];
      act.set(k, PH.addBlocker({
        ax: c.ax, az: c.az, bx: c.bx, bz: c.bz,
        radius: c.r, yMin: c.yMin, yMax: c.yMax,
      }));
    }
    for (const [k, seg] of act) {
      const c = this.list[k];
      if (!c) { PH.removeBlocker(seg); act.delete(k); continue; }
      const ddx = c.x - p.x, ddz = c.z - p.z;
      const rr = DROP_R + c.br;
      if (ddx * ddx + ddz * ddz > rr * rr) { PH.removeBlocker(seg); act.delete(k); }
    }
    this.stats.active = act.size;
    return act.size;
  }

  _clearActive() {
    const PH = this.ctx.get('physics');
    if (PH && PH.removeBlocker) for (const seg of this._active.values()) PH.removeBlocker(seg);
    this._active.clear();
    this.stats.active = 0;
  }

  dispose() {
    this._clearActive();
    this.list.length = 0;
    this._pending.length = 0;
  }
}

export const SCATTER_COLLISION_TUNABLES = { REG_R, CELL, ACTIVE_R, DROP_R, MIN_H };
