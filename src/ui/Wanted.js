import * as THREE from 'three';

/**
 * RED SANDS — THE LAW
 * ============================================================================
 * Crime, witnesses, wanted level and pursuit. Owned and stepped by Player;
 * drawn (stars only) by HUD. Nothing in here touches the renderer.
 *
 *   WHY IT LIVES HERE.  Killing a townsperson is not a rendering event and it
 *   is not a physics event — it is a *social* one, and the only thing that
 *   makes it read as a crime rather than as a ragdoll is that somebody SAW it.
 *   So the model is built round the witness, not round the corpse:
 *
 *     1. the shot lands                     → the victim goes down
 *     2. anyone with eyes on it reacts      → they freeze, then bolt
 *     3. a beat passes (GRACE seconds)      → only NOW does it become a crime
 *     4. the wanted level ticks up, a bounty accrues, and at two stars the
 *        law is roused and comes for you
 *     5. break line of sight and clear the district and it bleeds away again
 *
 *   Step 3 is the whole feel of it. Without the beat the stars appear on the
 *   same frame as the muzzle flash and the player never connects the two; with
 *   it, there is a moment of "did anyone see that" before the consequence
 *   lands, which is exactly the moment the request was asking for.
 *
 *   ANIMALS ARE NOT PEOPLE.  There is no path in this file from Wildlife to a
 *   wanted level — the only entry point that can raise one is `applyHit()` on a
 *   FOLK agent. Shooting every deer in the territory can never light a star.
 *
 * ----------------------------------------------------------------------------
 * BROAD PHASE — this runs every frame in a 16.7 ms budget with no headroom.
 * ----------------------------------------------------------------------------
 * The town's population is a single instanced mesh a long way from most of the
 * map, so the whole system is behind ONE sphere test against a cached town
 * centre: outside `_farCull` metres, `update()` does a distance compare and
 * returns, and that is the entire cost for nine of the ten capture shots. In
 * range, the witness sweep is amortised at 8 Hz over ≤ 40 agents using squared
 * distances against positions that Folk has ALREADY written into its instance
 * matrix this frame — no transforms are recomputed, nothing is allocated, and
 * the per-agent inner loop is six multiplies.
 *
 * ----------------------------------------------------------------------------
 * INTERFACING WITH THE FOLK
 * ----------------------------------------------------------------------------
 * `Town`/`Folk` are not ours to edit. If the world side publishes a hit API we
 * use it (see `_folkApi()` — every plausible spelling is probed once and
 * cached); otherwise we drive the agents through their own public data, which
 * Folk.update() reads every frame anyway:
 *
 *   a.path = null + a.x/a.y/a.z   detach an agent from its baked path so we own
 *                                 its position, facing and gait outright
 *   a.tilt                        pitch about the feet — this is what lays a
 *                                 body out on the ground
 *   a.gait / a.gaitArr            walk-cycle rate, per instance
 *
 * Nothing here writes to a file it does not own.
 */

/** Seconds between "you were seen" and "you are wanted". */
const GRACE = 2.4;
/** A witness has to be inside this to see a killing at all. */
const SEE_RANGE = 44;
/** …and this much closer to see it while facing the other way. */
const SEE_CLOSE = 15;
/** Stars. */
const MAX_LEVEL = 5;
/** Seconds unseen before the level starts bleeding off. */
const COOL_DELAY = 12;
/** Seconds per star lost, once it is cooling. */
const COOL_PER_STAR = 15;
/** How far you have to get from the scene for cooling to start at all. */
const ESCAPE_DIST = 130;
/** Witness sweep rate. Nothing about this needs 60 Hz. */
const SWEEP_HZ = 8;
/** Metres past which a pursuing lawman gives up and goes home. */
const GIVE_UP = 95;

const PART_DMG = { head: 2.4, vital: 1.15, body: 0.55, limb: 0.28 };

const _p = new THREE.Vector3();
const _seg = new THREE.Vector3();

export class Wanted {
  constructor(ctx) {
    this.ctx = ctx;

    /* --- published, read by HUD ---------------------------------------- */
    /** 0..5. Integer; this is the number of stars. */
    this.level = 0;
    /** Eased copy, so the stars can pop in instead of appearing. */
    this.levelSmooth = 0;
    /** 'clear' | 'warning' | 'wanted' */
    this.state = 'clear';
    /** 0..1 through the grace beat, for the warning pulse. */
    this.grace01 = 0;
    /** Dollars. */
    this.bounty = 0;
    /** True while anybody has eyes on you and you are wanted. */
    this.seen = false;
    /** How many townsfolk are currently after you. */
    this.lawmen = 0;
    /** Bumped on every star gained — HUD uses it to flash. */
    this.starPop = 0;

    /* --- internals ------------------------------------------------------ */
    this._graceT = -1;
    this._pendingLevel = 0;
    this._pendingBounty = 0;
    this._unseenT = 0;
    this._coolT = 0;
    this._sweepT = 0;
    this._crime = new THREE.Vector3();
    this._haveCrime = false;
    this._centre = new THREE.Vector3();
    this._farCull = 0;
    this._bound = false;
    this._api = undefined;
    this._retry = 0;
    this._folk = null;
    /** Agents we have taken over: dead, panicking or deputised. */
    this._active = [];
    this._notified = '';
    this._whistleT = 0;
  }

  /* ====================================================== folk plumbing */

  /**
   * Resolve the world side once. If another system has published an NPC hit
   * API we defer to it entirely; if not, we drive the agents ourselves.
   * @returns {{raycast:Function|null, apply:Function|null, folk:object|null}}
   */
  _folkApi() {
    if (this._api) return this._api;
    /*
     * A NULL RESULT IS NOT CACHED FOREVER. Town builds its population in
     * init(), and while every init() is awaited before the first update in the
     * live game, the benches and the offline harnesses do not guarantee that.
     * Caching a null on frame 0 there would disable the law for the whole
     * session, silently. Retry every 60 frames instead; the probe is two map
     * lookups.
     */
    if (this._api === null) {
      if (this._retry-- > 0) return null;
      this._retry = 60;
    }
    const town = this.ctx.get('town');
    if (!town) { this._api = null; return null; }
    const folk = town.folk || null;
    if (!folk || !folk.agents || !folk.agents.length) { this._api = null; return null; }
    const pick = (obj, names) => {
      if (!obj) return null;
      for (const n of names) if (typeof obj[n] === 'function') return obj[n].bind(obj);
      return null;
    };
    const raycast = pick(town, ['raycastFolk', 'raycastNpc', 'raycastNpcs', 'raycastPeople'])
      || pick(folk, ['raycast', 'raycastAgents']);
    const apply = pick(town, ['applyFolkHit', 'applyNpcHit', 'hitFolk', 'hitNpc'])
      || pick(folk, ['applyHit', 'hit']);
    this._folk = folk;
    // Cache the population's centre + radius: this is the broad phase.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const a of folk.agents) {
      const p = a.path;
      const x = p ? p[0][0] : a.x, z = p ? p[0][2] : a.z;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    this._centre.set((minX + maxX) * 0.5, 0, (minZ + maxZ) * 0.5);
    this._farCull = Math.hypot(maxX - minX, maxZ - minZ) * 0.5 + 150;
    this._api = { raycast, apply, folk };
    return this._api;
  }

  /** Live world position of an agent, straight out of the instance matrix. */
  _posOf(a, out) {
    if (a.path == null && a.x != null) return out.set(a.x, a.y, a.z);
    const folk = this._folk;
    if (folk) {
      for (const mesh of folk.meshes) {
        if (mesh.userData.agents !== undefined && a.slot != null
          && mesh.userData.agents[a.slot] === a) {
          const arr = mesh.instanceMatrix.array;
          const o = a.slot * 16;
          return out.set(arr[o + 12], arr[o + 13], arr[o + 14]);
        }
      }
    }
    return out.set(a.x || 0, a.y || 0, a.z || 0);
  }

  /**
   * Take an agent off its baked path so we own it. Everything after this —
   * fleeing, dying, pursuing — writes a.x/a.y/a.z, a.yaw and a.gait directly,
   * which is exactly what Folk.update() reads for a path-less agent.
   */
  _detach(a) {
    if (a.path == null) return a;
    this._posOf(a, _p);
    a.x = _p.x; a.y = _p.y; a.z = _p.z;
    a.path = null;
    a.walkRate = 0;
    return a;
  }

  _setGait(a, g) {
    a.gait = g;
    const arr = a.gaitArr;
    if (arr && a.slot != null) {
      const i = a.slot * 3 + 1;
      if (arr.array[i] !== g) { arr.array[i] = g; arr.needsUpdate = true; }
    }
  }

  _track(a) { if (this._active.indexOf(a) < 0) this._active.push(a); }

  /* ================================================== the shot itself */

  /**
   * Hitscan against the townspeople. Returns the same shape Wildlife's
   * `raycastAnimals` does, so Weapon can treat the two identically.
   * @returns {{agent,species:string,part:string,point:THREE.Vector3,
   *            distance:number,npc:true}|null}
   */
  raycast(origin, dir, maxDist = 420) {
    const api = this._folkApi();
    if (!api) return null;
    if (api.raycast) {
      const h = api.raycast(origin, dir, maxDist);
      if (h) h.npc = true;
      return h || null;
    }
    // Broad phase: the whole population is one sphere.
    const cdx = this._centre.x - origin.x, cdz = this._centre.z - origin.z;
    const along = cdx * dir.x + cdz * dir.z;
    const perp2 = cdx * cdx + cdz * cdz - along * along;
    if (along < -this._farCull || perp2 > this._farCull * this._farCull) return null;

    let best = null, bd = maxDist;
    for (const a of api.folk.agents) {
      if (a.rsDead) continue;
      this._posOf(a, _p);
      const sc = a.scale || 1;
      // capsule from the ankles to the crown, in the agent's own scale
      const y0 = _p.y + 0.16 * sc, y1 = _p.y + 1.70 * sc;
      const rad = 0.30 * sc;
      _seg.set(_p.x - origin.x, 0, _p.z - origin.z);
      const t = _seg.x * dir.x + _seg.z * dir.z;
      if (t <= 0 || t > bd) continue;
      // closest approach in the horizontal plane first — cheapest reject
      const px = _seg.x - dir.x * t, pz = _seg.z - dir.z * t;
      const lat2 = px * px + pz * pz;
      if (lat2 > rad * rad * 4) continue;
      // now the real 3D distance from the ray to the vertical segment
      const yAt = origin.y + dir.y * t;
      const yC = Math.min(y1, Math.max(y0, yAt));
      const dy = yAt - yC;
      const scale = Math.sqrt(Math.max(1e-6, 1 - dir.y * dir.y));
      if (lat2 * scale * scale + dy * dy > rad * rad) continue;
      const part = yAt > _p.y + 1.46 * sc ? 'head'
        : yAt > _p.y + 1.02 * sc ? 'vital'
          : yAt > _p.y + 0.55 * sc ? 'body' : 'limb';
      bd = t;
      best = {
        agent: a, species: a.woman ? 'townswoman' : 'townsperson', part,
        distance: t, npc: true,
        point: new THREE.Vector3(origin.x + dir.x * t, yAt, origin.z + dir.z * t),
      };
    }
    return best;
  }

  /**
   * Land a shot on a person. Returns `{killed, part}` exactly like Wildlife's
   * `applyHit`, and — the part that matters — registers the CRIME.
   */
  applyHit(hit, damage = 1) {
    const api = this._folkApi();
    if (!hit || !hit.agent || !api) return null;
    const a = hit.agent;
    if (a.rsDead) return null;
    let killed;
    if (api.apply) {
      const r = api.apply(hit, damage);
      if (!r) return null;
      killed = !!(r.killed || r.dead);
    } else {
      if (a.rsHp == null) a.rsHp = 1;
      a.rsHp -= damage * (PART_DMG[hit.part] != null ? PART_DMG[hit.part] : 0.55);
      killed = a.rsHp <= 0;
      this._detach(a);
      if (killed) this._kill(a, hit);
      else this._wound(a, hit);
    }
    this._reportCrime(hit.point || this.ctx.player.position, killed, a);
    return { killed, part: hit.part, species: hit.species, npc: true };
  }

  _kill(a, hit) {
    a.rsDead = 1;
    a.rsFallT = 0;
    a.rsY0 = a.y;
    a.rsLawman = 0;
    a.rsPanicT = 0;
    this._setGait(a, 0);
    // Fall AWAY from the round: if it came at their face they go over
    // backwards, if it took them in the back they go down on their face.
    const fx = Math.sin(a.yaw || 0), fz = Math.cos(a.yaw || 0);
    const dx = (hit.point ? hit.point.x : 0) - this.ctx.camera.position.x;
    const dz = (hit.point ? hit.point.z : 0) - this.ctx.camera.position.z;
    const facing = dx * fx + dz * fz;
    a.rsFallDir = facing < 0 ? -1 : 1;     // <0 means they were facing us
    this._track(a);
    const A = this.ctx.get('audio');
    if (A && A.play) {
      this._posOf(a, _p);
      A.play('bodyfall', { position: _p.clone(), volume: 0.9, at: A.now() + 0.55 });
    }
  }

  /**
   * Wounded but on his feet. He gets the same bolt-for-cover behaviour as a
   * witness — and he needs his OWN flee vector here, because `_reportCrime`
   * deliberately skips the victim when it panics the bystanders. Without this
   * the flee direction was undefined and the first frame after the freeze
   * wrote NaN straight into the instance matrix.
   */
  _wound(a, hit) {
    a.rsHurt = 1.0;
    a.rsPanicT = 6.5;
    a.rsFrozen = 0.35;
    const src = (hit && hit.point) || this.ctx.camera.position;
    a.rsFleeX = a.x - src.x;
    a.rsFleeZ = a.z - src.z;
    const l = Math.hypot(a.rsFleeX, a.rsFleeZ);
    if (!(l > 1e-4)) { a.rsFleeX = 0; a.rsFleeZ = 1; } else { a.rsFleeX /= l; a.rsFleeZ /= l; }
    this._track(a);
  }

  /* ============================================ crime, witness, wanted */

  /**
   * A crime happened at `point`. Look for someone who saw it; if nobody did,
   * nothing happens at all — which is the whole point of having witnesses.
   */
  _reportCrime(point, killed, victim) {
    const api = this._folkApi();
    if (!api) return;
    this._crime.copy(point);
    this._haveCrime = true;
    this._unseenT = 0;
    this._coolT = 0;

    /*
     * ONCE THE HUE AND CRY IS UP, THE FACING TEST STOPS APPLYING.
     *
     * Measured: shoot a man, wait for the beat, then shoot a second — and
     * nothing happened, because every bystander was by then running away with
     * their back to you and the facing test rejected all of them. That quietly
     * killed the escalation the request specifically asked for. A town that is
     * already hunting you does not need to be looking the right way to know
     * you have killed again; proximity is enough from the first star onward.
     */
    const alreadyWanted = this.level > 0 || this._graceT >= 0;

    let witnesses = 0;
    for (const a of api.folk.agents) {
      if (a === victim || a.rsDead) continue;
      this._posOf(a, _p);
      const dx = point.x - _p.x, dz = point.z - _p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > SEE_RANGE * SEE_RANGE) continue;
      if (!alreadyWanted && d2 > SEE_CLOSE * SEE_CLOSE) {
        // facing test: you can hear a shot behind you, but you cannot see it
        const d = Math.sqrt(d2) || 1;
        const fx = Math.sin(a.yaw || 0), fz = Math.cos(a.yaw || 0);
        if ((dx / d) * fx + (dz / d) * fz < -0.30) continue;
      }
      witnesses++;
      this._panic(a, point);
    }
    if (!witnesses) {
      // Unwitnessed. A body in an empty alley is not a crime — yet.
      return;
    }
    const worth = killed ? 40 : 15;
    if (this.level === 0 && this._graceT < 0) {
      // First offence: the beat. Somebody shouts, and THEN you are wanted.
      this._graceT = 0;
      this._pendingLevel = killed ? 2 : 1;
      this._pendingBounty = worth;
      this.state = 'warning';
      this._notify(killed ? 'You have been seen' : 'Somebody saw that');
    } else if (this._graceT >= 0) {
      // more happened during the beat — it is going to cost more
      this._pendingLevel = Math.min(MAX_LEVEL, this._pendingLevel + (killed ? 1 : 0));
      this._pendingBounty += worth;
    } else {
      this._raise(killed ? 1 : 0, worth);
    }
  }

  _raise(stars, bounty) {
    const before = this.level;
    this.level = Math.min(MAX_LEVEL, this.level + stars);
    this.bounty += bounty;
    this.state = 'wanted';
    this._unseenT = 0;
    this._coolT = 0;
    if (this.level > before) {
      this.starPop = 1;
      this._notify(this.level >= 3 ? 'The law is after you' : 'You are wanted');
    }
  }

  /** A witness reacts: freezes, then runs. */
  _panic(a, point) {
    if (a.rsDead || a.rsLawman) return;
    this._detach(a);
    a.rsPanicT = Math.max(a.rsPanicT || 0, 7.0);
    a.rsFrozen = Math.max(a.rsFrozen || 0, 0.55);
    a.rsFleeX = a.x - point.x;
    a.rsFleeZ = a.z - point.z;
    const l = Math.hypot(a.rsFleeX, a.rsFleeZ) || 1;
    a.rsFleeX /= l; a.rsFleeZ /= l;
    this._track(a);
  }

  _notify(text) {
    if (text === this._notified) return;
    this._notified = text;
    const hud = this.ctx.get('hud');
    if (hud && hud.notify) hud.notify(text);
  }

  /* ===================================================== per-frame step */

  update(dt) {
    const h = Math.min(dt || 1 / 60, 1 / 15);
    // Star easing is cheap and must run even when the town is far away, so
    // the HUD's fade-out is not frozen the moment you ride out of the district.
    this.levelSmooth += (this.level - this.levelSmooth) * Math.min(1, h * 6);
    this.starPop = Math.max(0, this.starPop - h * 1.6);

    const api = this._folkApi();
    if (!api) return;

    /* ---- BROAD PHASE. One distance compare, then out. ------------------- */
    const p = this.ctx.player.position;
    const dx = p.x - this._centre.x, dz = p.z - this._centre.z;
    const near = dx * dx + dz * dz < this._farCull * this._farCull;
    if (!near && !this._active.length && this.level === 0 && this._graceT < 0) return;

    /* ---- the grace beat ------------------------------------------------- */
    if (this._graceT >= 0) {
      this._graceT += h;
      this.grace01 = Math.min(1, this._graceT / GRACE);
      if (this._graceT >= GRACE) {
        this._graceT = -1;
        this.grace01 = 0;
        this._raise(this._pendingLevel, this._pendingBounty);
        this._pendingLevel = 0; this._pendingBounty = 0;
      }
    }

    /* ---- agents we have taken over -------------------------------------- */
    if (this._active.length) this._stepActive(h, p);

    /* ---- who can see you ------------------------------------------------ */
    this._sweepT += h;
    if (near && this._sweepT >= 1 / SWEEP_HZ) {
      this._sweepT = 0;
      this.seen = this.level > 0 && this._anyoneSees(p);
    } else if (!near) {
      this.seen = false;
    }

    /* ---- cool off -------------------------------------------------------- */
    if (this.level > 0 && this._graceT < 0) {
      if (this.seen) { this._unseenT = 0; this._coolT = 0; } else this._unseenT += h;
      const away = !this._haveCrime
        || Math.hypot(p.x - this._crime.x, p.z - this._crime.z) > ESCAPE_DIST;
      if (this._unseenT > COOL_DELAY && away) {
        this._coolT += h;
        if (this._coolT >= COOL_PER_STAR) {
          this._coolT = 0;
          this.level--;
          if (this.level <= 0) {
            this.level = 0;
            this.bounty = 0;
            this.state = 'clear';
            this._notified = '';
            this._notify('You are no longer wanted');
            this._standDown();
          }
        }
      }
    } else if (this.level === 0 && this._graceT < 0) {
      this.state = 'clear';
    }

    /* ---- the law responds ------------------------------------------------ */
    // Only ever recruit from inside the district: outside it there is nobody
    // to recruit and the scan would be pure waste on every frame of a ride.
    if (near && this.level >= 2) this._deputise(p, h);
    this._whistleT = Math.max(0, this._whistleT - h);
  }

  _anyoneSees(p) {
    const api = this._api;
    for (const a of api.folk.agents) {
      if (a.rsDead) continue;
      this._posOf(a, _p);
      const dx = p.x - _p.x, dz = p.z - _p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > SEE_RANGE * SEE_RANGE) continue;
      if (a.rsLawman) return true;
      if (d2 <= SEE_CLOSE * SEE_CLOSE) return true;
      const d = Math.sqrt(d2) || 1;
      const fx = Math.sin(a.yaw || 0), fz = Math.cos(a.yaw || 0);
      if ((dx / d) * fx + (dz / d) * fz > -0.30) return true;
    }
    return false;
  }

  /**
   * Pick lawmen out of the surviving population and send them at the player.
   * This is deliberately not combat AI — it is a man running at you with a
   * whistle, which is all "consequence" has to look like at this scale.
   */
  _deputise(p, h) {
    const want = Math.min(3, this.level - 1);
    let have = 0;
    for (const a of this._active) if (a.rsLawman && !a.rsDead) have++;
    if (have >= want) { this.lawmen = have; return; }
    const api = this._api;
    let best = null, bd = 200 * 200;
    for (const a of api.folk.agents) {
      if (a.rsDead || a.rsLawman) continue;
      this._posOf(a, _p);
      const dx = p.x - _p.x, dz = p.z - _p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = a; }
    }
    if (!best) { this.lawmen = have; return; }
    this._detach(best);
    best.rsLawman = 1;
    best.rsPanicT = 0;
    this._track(best);
    this.lawmen = have + 1;
    if (this._whistleT <= 0) {
      this._whistleT = 2.5;
      const A = this.ctx.get('audio');
      if (A && A.play) A.play('whistle', { position: _p.clone(), volume: 0.9 });
      this._notify('Lawmen are closing in');
    }
    void h;
  }

  _standDown() {
    for (const a of this._active) {
      if (a.rsDead) continue;
      a.rsLawman = 0;
      a.rsPanicT = 0;
      this._setGait(a, 0);
    }
    this.lawmen = 0;
  }

  /**
   * Step everything we have taken over: bodies falling, witnesses bolting,
   * lawmen closing. Bounded by how many people you have actually involved,
   * which in practice is single digits.
   */
  _stepActive(h, p) {
    const world = this.ctx.world;
    for (let i = this._active.length - 1; i >= 0; i--) {
      const a = this._active[i];

      /* --- dead: pitch about the boots over ~0.8 s, then retire ---------- */
      if (a.rsDead) {
        if (a.rsFallT < 1) {
          a.rsFallT = Math.min(1, a.rsFallT + h / 0.8);
          const t = a.rsFallT;
          // gravity-ish: slow off the top, quick at the bottom, small settle
          const e = t * t * (2.2 - 1.2 * t);
          a.tilt = a.rsFallDir * (1.44 * e - Math.sin(t * Math.PI) * 0.10);
          /*
           * LIFT THE ROOT AS IT GOES OVER. The instance pivots about the FEET,
           * so at 90 degrees the figure's own half-thickness (~0.13 m) is on
           * the wrong side of the ground plane and half the body is buried in
           * the dirt — which is exactly how it looked the first time. Raising
           * the root by that half-thickness as the tilt comes on lays the body
           * ON the street instead of in it.
           */
          a.y = a.rsY0 + 0.13 * e;
          if (t >= 1) {
            a.tilt = a.rsFallDir * 1.44;
            a.y = a.rsY0 + 0.13;
            this._active.splice(i, 1);
          }
        } else this._active.splice(i, 1);
        continue;
      }

      /* --- lawman: run us down ------------------------------------------ */
      if (a.rsLawman) {
        const dx = p.x - a.x, dz = p.z - a.z;
        const d = Math.hypot(dx, dz) || 1;
        a.yaw = Math.atan2(dx, dz);
        /* A deputy on foot does not follow you across the territory. Past
         * GIVE_UP he stops — which is also what makes riding out of town the
         * correct answer to two stars instead of a losing footrace. */
        if (d > GIVE_UP) {
          a.rsLawman = 0;
          this._setGait(a, 0);
          this._active.splice(i, 1);
          this.lawmen = Math.max(0, this.lawmen - 1);
          continue;
        }
        if (d > 2.0) {
          const sp = Math.min(3.6, 1.2 + d * 0.35);
          a.x += (dx / d) * sp * h;
          a.z += (dz / d) * sp * h;
          a.y += (world.getHeight(a.x, a.z) - a.y) * Math.min(1, h * 6);
          this._setGait(a, 1.15);
        } else {
          this._setGait(a, 0);
          // Close enough to lay hands on you. Not combat — a shove and a
          // shout, which is enough for the player to understand they lost.
          if (!a.rsGrabT || a.rsGrabT <= 0) {
            a.rsGrabT = 2.2;
            const hud = this.ctx.get('hud');
            if (hud && hud.damage) hud.damage(0.12);
            const fx = this.ctx.get('postfx');
            if (fx && fx.shake) fx.shake(0.5, 0.25);
            const A = this.ctx.get('audio');
            if (A && A.play) A.play('leather', { position: _p.set(a.x, a.y + 1.2, a.z), volume: 1 });
          }
        }
        if (a.rsGrabT > 0) a.rsGrabT -= h;
        continue;
      }

      /* --- witness: freeze, then bolt ------------------------------------ */
      if (a.rsPanicT > 0) {
        a.rsPanicT -= h;
        if (a.rsFrozen > 0) {
          a.rsFrozen -= h;
          // turn and look at what just happened
          const dx = p.x - a.x, dz = p.z - a.z;
          a.yaw = Math.atan2(dx, dz);
          this._setGait(a, 0);
        } else {
          const sp = 3.2;
          // belt and braces: a non-finite flee vector must never reach the
          // instance matrix, because one NaN there kills the whole draw.
          if (!Number.isFinite(a.rsFleeX) || !Number.isFinite(a.rsFleeZ)) {
            a.rsFleeX = 0; a.rsFleeZ = 1;
          }
          a.x += a.rsFleeX * sp * h;
          a.z += a.rsFleeZ * sp * h;
          a.y += (world.getHeight(a.x, a.z) - a.y) * Math.min(1, h * 6);
          a.yaw = Math.atan2(a.rsFleeX, a.rsFleeZ);
          this._setGait(a, 1.25);
        }
        if (a.rsPanicT <= 0) { this._setGait(a, 0); this._active.splice(i, 1); }
        continue;
      }
      this._active.splice(i, 1);
    }
  }

  /* -------------------------------------------------------------- debug */

  stats() {
    return {
      level: this.level, state: this.state, bounty: this.bounty,
      seen: this.seen, lawmen: this.lawmen, active: this._active.length,
      grace: +this.grace01.toFixed(2),
    };
  }
}

export default Wanted;
