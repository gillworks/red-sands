import * as THREE from 'three';
import { buildHorseRig, HLEG } from './rig/HorseRig.js';
import { makeCharDepthMaterial, ContactShadow } from './rig/CharMaterial.js';
import { bakeVertexAO } from './rig/SkinBuilder.js';
import { buildHorseBody } from './horse/HorseBody.js';
import { buildHorseHair } from './horse/HorseHair.js';
import { makeHorseMaterials, updateCoat } from './horse/HorseCoat.js';
import { HorseCollider } from './horse/HorseCollider.js';
import { weldNormals, relaxNormals, smoothAO } from './horse/CoatBuild.js';
import { rng } from '../core/Context.js';

/**
 * RED SANDS — HORSE
 * ============================================================================
 * A 1.6 m bay saddle horse with real gaits.
 *
 *   WALK    4-beat lateral   LH · LF · RH · RF     duty 0.66, no suspension
 *   TROT    2-beat diagonal  LF+RH · RF+LH         duty 0.44, two suspensions
 *   CANTER  3-beat right lead  RH · LH+RF · LF     duty 0.38, one suspension
 *   GALLOP  4-beat right lead  LH · RH · LF · RF   duty 0.30
 *
 * Each limb runs the same stance/swing generator the rider uses, so the stance
 * hoof is world-static at any speed. Front legs solve shoulder->elbow->knee
 * with the elbow poled backwards; hind legs solve hip->stifle->hock with the
 * stifle poled forwards, then cannon and pastern are aimed on down the chain.
 * That joint-direction detail is what makes a quadruped read as a horse rather
 * than as a very large dog.
 *
 * The body pitches and rolls through the stride, the head nods hard on the
 * walk, barely on the trot and pumps on the gallop; mane and tail are
 * spring-damped off the same signals plus env.windVector.
 * ============================================================================
 */

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rgt = new THREE.Vector3();

/** phase offsets are FOOTFALL times within the stride, 0..1 */
const GAITS = {
  stand: { off: { LF: 0, RF: 0, LH: 0, RH: 0 }, duty: 1.0, freq: 0, speed: 1, bob: 0, nod: 0, pitch: 0 },
  walk: { off: { LH: 0.00, LF: 0.25, RH: 0.50, RF: 0.75 }, duty: 0.66, freq: 0.92, speed: 1.7, bob: 0.020, nod: 0.085, pitch: 0.030 },
  trot: { off: { LF: 0.00, RH: 0.00, RF: 0.50, LH: 0.50 }, duty: 0.44, freq: 1.32, speed: 4.2, bob: 0.055, nod: 0.022, pitch: 0.020 },
  canter: { off: { RH: 0.00, LH: 0.33, RF: 0.36, LF: 0.66 }, duty: 0.38, freq: 1.62, speed: 7.2, bob: 0.085, nod: 0.070, pitch: 0.085 },
  gallop: { off: { LH: 0.00, RH: 0.12, LF: 0.46, RF: 0.58 }, duty: 0.30, freq: 2.05, speed: 12.0, bob: 0.105, nod: 0.105, pitch: 0.120 },
};

/**
 * How close you have to be to mount. The horse parks 2.5–3.6 m off the rider's
 * shoulder, which at the old 3.8 m meant the very first thing a new player did
 * was press E next to their horse and have nothing happen.
 */
export const MOUNT_RANGE = 4.8;

/**
 * Stirrup iron centre relative to the saddle bone, in the saddle bone's frame.
 * Kept next to the rig numbers it mirrors so the two cannot drift apart.
 */
const SEAT_TO_IRON = new THREE.Vector3(0.320, 1.088 - 1.62, 0.066);

/** rest hoof positions in horse-local space */
const HOOF_REST = {
  LF: [0.207, 0, 0.478], RF: [-0.207, 0, 0.478],
  LH: [0.208, 0, -0.481], RH: [-0.208, 0, -0.481],
};

/**
 * LOD LADDER.
 *
 * The horse is one object but it is on screen constantly, so the near level
 * is allowed to be expensive and the far levels have to be honest. Switch
 * distances are camera-to-horse in metres with `HYST` metres of hysteresis so
 * a player standing on the boundary cannot make it flicker, and so a dolly
 * cannot register the switch as an LOD pop.
 *
 *   q      subdivision multiplier passed to the builders
 *   body   0: full  1: half  2: quarter, tack simplified
 *   hair   the strand-card mesh; past HAIR_CUT it is two pixels of noise and
 *          an alpha-test discard for nothing
 */
const LOD_NEAR = 16.0;
const LOD_FAR = 38.0;
const HYST = 2.0;
const HAIR_LOD = 13.0;
const HAIR_CUT = 42.0;
const LEVELS = [
  { q: 1.00, aoCell: 0.017, tack: true },
  { q: 0.52, aoCell: 0.024, tack: true },
  { q: 0.28, aoCell: 0.036, tack: false },
];

export class Horse {
  static id = 'horse';

  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'horse';

    this.state = {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      radius: 0.55,
      height: 1.7,
      grounded: true,
      groundNormal: new THREE.Vector3(0, 1, 0),
      maxSlopeCos: 0.55,
      stepHeight: 0.55,
    };
    this.prevPos = new THREE.Vector3();
    this.renderPos = new THREE.Vector3();
    this.yaw = 0;
    this.speed = 0;
    this.speed01 = 0;
    this.gait = 'stand';
    this.gaitPhase = 0.17;
    this.mounted = false;
    /** Set by Player for the length of a mount/dismount: stand absolutely still. */
    this.holdStill = false;
    this._freq = 0;
    this._idleT = 0;
    this._bodyBob = 0;
    this._tail = [{ x: 0, z: 0, vx: 0, vz: 0 }, { x: 0, z: 0, vx: 0, vz: 0 }, { x: 0, z: 0, vx: 0, vz: 0 }];
    this._neck = { x: 0, vx: 0 };
    this._restFoot = 1;
    this._lastDown = { LF: false, RF: false, LH: false, RH: false };
    this._prevVel = new THREE.Vector3();
    this._accel = new THREE.Vector3();
    this.visible = true;
  }

  /* ==================================================================== init */

  async init() {
    const ctx = this.ctx;
    const rand = rng((ctx.seed ^ 0x40b5) >>> 0);
    this.rig = buildHorseRig();
    /*
     * EAR BONES. Added here rather than in HorseRig because the ears are the
     * only part of the animal that has to be driven, and adding two leaves
     * (never referenced by the IK, the saddle or the gait) at the end of the
     * hierarchy cannot move any existing bone. Every rig number the playtest
     * measures — seat gap, stirrup irons, HLEG segment lengths, hoof rest —
     * is derived from bones declared before these two and is unaffected.
     */
    this.rig.bone('earL', 'head', [0.058, 0.010, 0.000]);
    this.rig.bone('earR', 'head', [-0.058, 0.010, 0.000]);

    const bodies = LEVELS.map((L) => this._bake(buildHorseBody(this.rig, rng(0x5c31), {
      q: L.q, tack: L.tack,
    }), { strength: 0.95, cell: L.aoCell }));
    const hairs = [1.0, 0.5].map((q) => this._bake(buildHorseHair(this.rig, rng(0x91ae), { q }), {
      strength: 0.55, floor: 0.5, cell: 0.022, relax: 0,
    }));
    const skeleton = this.rig.finish();

    this.mats = makeHorseMaterials(ctx, rand);
    this.matSolid = this.mats.solid;
    this.matCloth = this.mats.cloth;
    this.matHair = this.mats.hair;

    const depth = makeCharDepthMaterial(0.022);
    const lighting = ctx.get('lighting');

    /** Body LODs. Only one is ever visible, so this stays a single draw call. */
    this.lods = bodies.map((geo, i) => {
      const m = new THREE.SkinnedMesh(geo, [this.matSolid, this.matCloth]);
      m.name = 'horseBody' + i;
      m.customDepthMaterial = depth;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.visible = i === 0;
      if (i === 0) m.add(this.rig.root);
      m.bind(skeleton, new THREE.Matrix4());
      this.group.add(m);
      if (lighting && lighting.requestShadowCaster) lighting.requestShadowCaster(m);
      return m;
    });
    this.mesh = this.lods[0];

    /* Mane, forelock, tail and fetlock feather: alpha-tested strand cards on
     * the same neck and tail bones as the body, so the spring-damped swing
     * already drives the secondary motion and the wind comes with it. Own
     * mesh so the alpha discard is not paid by the opaque body. */
    this.hairs = hairs.map((geo, i) => {
      const m = new THREE.SkinnedMesh(geo, this.matHair);
      m.name = 'horseHair' + i;
      m.castShadow = true;
      m.receiveShadow = false;
      m.frustumCulled = false;
      m.visible = i === 0;
      m.userData.rsCheapShadow = true;
      m.bind(skeleton, new THREE.Matrix4());
      this.group.add(m);
      if (lighting && lighting.requestShadowCaster) lighting.requestShadowCaster(m);
      return m;
    });
    this.hair = this.hairs[0];
    this.lodLevel = 0;
    this.hairLevel = 0;
    ctx.scene.add(this.group);

    this.contact = new ContactShadow(ctx, { radius: 1.6, strength: 0.80, res: 14 });
    ctx.scene.add(this.contact.mesh);

    this._sweat = 0;
    this._ear = [{ x: 0, y: 0, vx: 0, vy: 0 }, { x: 0, y: 0, vx: 0, vy: 0 }];
    this._earFlick = [0, 0];
    this._placeBesidePlayer();

    this.physics = ctx.get('physics');
    /**
     * The animal's collision volume. Published so anything else that wants to
     * know where the horse physically IS can ask, rather than guessing off a
     * radius. See src/player/horse/HorseCollider.js.
     */
    this.collider = new HorseCollider(this.physics);
    this.collider.update(this.state.position, this.yaw);
    if (this.physics && this.physics.addStepper) {
      this._stepFn = (h) => this._fixed(h);
      this.physics.addStepper(this._stepFn);
    }

    ctx.on('playerTeleported', () => { if (!this.holdStill) this._placeBesidePlayer(); });
    this._onKey = (e) => {
      if (e.code !== 'KeyE') return;
      const player = this.ctx.get('player');
      if (!player || player.trans) return;          // a transition is running
      /*
       * `mounted` is PLAYER's to set now, at the beat in the mount animation
       * where the rider's weight actually transfers. Flipping it here made the
       * horse steerable while its rider was still standing in the stirrup.
       */
      if (player.mode === 'mounted') player.dismount();
      else if (player.mode === 'onFoot'
        && player.state.position.distanceTo(this.state.position) < MOUNT_RANGE) {
        player.mount(this);
      }
    };
    window.addEventListener('keydown', this._onKey);

    this._pose(0);
  }

  /**
   * Finish one level of detail.
   *
   * Order matters and is the whole answer to "visible polygon facets across
   * shoulder, barrel and haunch":
   *
   *   1. WELD    coincident vertices between adjacent sections share a normal,
   *              so the neck flows into the head and no tube CAP reads as the
   *              flat disc that was sitting on the end of the muzzle.
   *   2. RELAX   one Laplacian pass over the shading normals removes the
   *              piecewise-constant banding a swept superellipse leaves, with
   *              zero effect on silhouette, skinning or AO.
   *   3. BAKE    ambient occlusion, now on a 17 mm voxel grid instead of the
   *              30 mm the default `span/88` gave — the coarse grid was
   *              quantising the occlusion into the same size panels.
   *   4. SMOOTH  two one-ring passes over the baked AO, because even a fine
   *              grid leaves steps once it is interpolated across a quad.
   */
  _bake({ geo, organic }, opts) {
    weldNormals(geo, organic);
    if (opts.relax !== 0) relaxNormals(geo, organic, { iterations: 1, strength: 0.55 });
    bakeVertexAO(geo, { strength: opts.strength, floor: opts.floor, cell: opts.cell });
    smoothAO(geo, organic, { iterations: 2, strength: 0.6 });
    return geo;
  }

  /** Park the horse a couple of metres off the rider, angled for the camera. */
  _placeBesidePlayer() {
    const player = this.ctx.get('player');
    const world = this.ctx.world;
    const p = player ? player.state.position : new THREE.Vector3();
    const yaw = player ? player.yaw : 0;
    const fwd = _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    const rgt = _rgt.set(-fwd.z, 0, fwd.x);
    // Search a small arc for level standing ground: a horse straddling a rock
    // shelf with two hooves in the air destroys the shot faster than any
    // material defect.
    let best = null;
    for (let i = 0; i < 9; i++) {
      const side = 2.55 + (i % 3) * 0.35;
      const ahead = 1.8 + Math.floor(i / 3) * 0.55;
      const x = p.x + rgt.x * side + fwd.x * ahead;
      const z = p.z + rgt.z * side + fwd.z * ahead;
      let rough = 0;
      const y0 = world.getHeight(x, z);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        rough += Math.abs(world.getHeight(x + Math.cos(a) * 1.0, z + Math.sin(a) * 1.0) - y0);
      }
      const n = world.getNormal(x, z, _v3);
      const score = -rough * 2.0 + n.y * 3.0;
      if (!best || score > best.score) best = { x, z, y: y0, score };
    }
    const x = best.x, z = best.z;
    this.state.position.set(x, world.getHeight(x, z), z);
    this.prevPos.copy(this.state.position);
    this.renderPos.copy(this.state.position);
    this.state.velocity.set(0, 0, 0);
    this.yaw = yaw + 2.30;      // three-quarter front view from the camera
    this.speed = 0;
  }

  /* --------------------------------------------------------- fixed update */

  _fixed(h) {
    const s = this.state;
    this.prevPos.copy(s.position);
    const player = this.ctx.get('player');

    /*
     * A horse that shifts its feet while somebody is halfway into the stirrup
     * makes the whole mount read as broken, so Player pins it for the duration
     * of the transition. It still poses and breathes — it just does not move.
     */
    if (this.mounted && player && !this.holdStill) {
      const i = player.input;
      /*
       * A horse is not a car. It turns hard at a walk and barely at all at a
       * flat gallop, it builds through its gaits over a couple of seconds when
       * you spur it, and it takes a long run-out to stop. All three of those
       * are what make riding feel like riding instead of driving.
       */
      const turn = -i.r * (1.75 - this.speed01 * 1.28);
      this.yaw += turn * h;
      const spur = i.f > 0 && i.sprint;
      this._spur = spur
        ? Math.min(2.6, (this._spur || 0) + h)
        : Math.max(0, (this._spur || 0) - h * 2.4);
      const wind = THREE.MathUtils.clamp(this._spur / 2.2, 0, 1);
      const want = i.f > 0
        ? (spur ? 5.2 + 7.0 * wind * wind : 4.4)      // trot, then wind up to a gallop
        : (i.f < 0 ? -1.7 : 0);
      // Slope: a horse will not gallop up a bluff.
      const n = s.groundNormal;
      let grade = 0;
      if (Number.isFinite(n.y) && n.y > 0.05) {
        const f0 = _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        grade = -(n.x * f0.x + n.z * f0.z) / n.y;
        if (!Number.isFinite(grade)) grade = 0;
      }
      const tgt = want * THREE.MathUtils.clamp(1 - Math.max(0, grade) * 0.85, 0.34, 1.12);
      const a = tgt > this.speed ? 3.1 : 4.2;         // m/s², building and checking
      const d = tgt - this.speed;
      this.speed += Math.abs(d) <= a * h ? d : Math.sign(d) * a * h;
      const f = _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      s.velocity.x = f.x * this.speed;
      s.velocity.z = f.z * this.speed;
      s.snap = 0.35 + Math.abs(this.speed) * 0.075;
    } else {
      const k = this.holdStill ? 0 : Math.max(0, 1 - 2.5 * h);
      this.speed *= k;
      this._spur = 0;
      s.velocity.x *= k;
      s.velocity.z *= k;
    }

    /*
     * COLLIDER. The horse's own capsule must not be visible to the horse's own
     * capsule controller — a 0.42 m wall at its own centre would launch it —
     * so it is suspended for exactly the duration of this call. It is also
     * held down while a rider is aboard (the man IS the horse then) and
     * through a mount/dismount, where the animation owns the rider's transform
     * and must not be fought by a push-out.
     */
    const c = this.collider;
    if (c) c.suspend();
    if (this.physics) this.physics.stepCharacter(s, h);
    else s.position.y = this.ctx.world.getHeight(s.position.x, s.position.z);
    if (c) {
      const rider = this.ctx.get('player');
      const busy = this.mounted || this.holdStill || (rider && rider.trans)
        || this.ctx.player.mode === 'mounted';
      if (!busy) c.resume(s.position);
      c.update(s.position, this.yaw);
    }

    const sp = Math.hypot(s.velocity.x, s.velocity.z);
    this.speed01 = THREE.MathUtils.clamp(sp / GAITS.gallop.speed, 0, 1);
    this.gait = this._pickGait(sp);
    const G = GAITS[this.gait];
    if (G.freq > 0) {
      const f = G.freq * (0.78 + 0.34 * THREE.MathUtils.clamp(sp / G.speed, 0, 1.4));
      this.gaitPhase = (this.gaitPhase + f * h) % 1;
      this._freq = f;
    } else this._freq = 0;

    _v3.copy(s.velocity).sub(this._prevVel).multiplyScalar(1 / h);
    this._accel.lerp(_v3, 0.25);
    this._prevVel.copy(s.velocity);
    this._idleT += h;
    this._hoofSounds();
  }

  _pickGait(sp) {
    if (sp < 0.25) return 'stand';
    if (sp < 2.7) return 'walk';
    if (sp < 5.6) return 'trot';
    if (sp < 9.2) return 'canter';
    return 'gallop';
  }

  _hoofSounds() {
    const G = GAITS[this.gait];
    if (!G.freq) return;
    for (const k of ['LF', 'RF', 'LH', 'RH']) {
      const p = (this.gaitPhase - G.off[k] + 1) % 1;
      const down = p < G.duty;
      if (down && !this._lastDown[k]) {
        const surf = this.ctx.world.getSurface(this.state.position.x, this.state.position.z);
        let name = 'dirt', best = -1;
        for (const key in surf) if (surf[key] > best) { best = surf[key]; name = key; }
        this.ctx.emit('footstep', {
          position: this.state.position.clone(), surface: name, weights: surf,
          speed: this.speed01, source: 'horse', hoof: k,
        });
      }
      this._lastDown[k] = down;
    }
  }

  /* ================================================================ update */

  update(dt) {
    this.syncPose(dt);
    this._updateCoat(dt);
  }

  /**
   * Coat state. A horse darkens with sweat through the neck and the flank as
   * it works and dries off slowly afterwards — one uniform, and it is the
   * difference between an animal and a prop.
   */
  _updateCoat(dt) {
    const h = Math.min(dt || 1 / 60, 0.1);
    const drive = this.speed01 * this.speed01;
    const k = drive > this._sweat ? 0.30 : 0.055;      // wets fast, dries slow
    this._sweat += (drive - this._sweat) * Math.min(1, k * h * 8);
    const wet = this.ctx.env.wetness || 0;
    // Distance LOD on the shader's detail bands: past ~26 m the millimetre
    // octaves are below a pixel and only cost bandwidth.
    const d = this.ctx.camera.position.distanceTo(this.renderPos);
    const detail = THREE.MathUtils.clamp(1.25 - d / 34, 0.25, 1.0);
    if (this.mats) updateCoat(this.mats.all, { sweat: this._sweat * 0.9, wet, detail });
  }

  /**
   * Interpolate this frame's render position and rebuild the skeleton.
   *
   * Idempotent per frame, because the mounted rider has to read the saddle
   * bone in WORLD space and Player.update runs before this system does. The
   * rider calls syncPose() itself, and whichever of the two gets there first
   * does the work — otherwise the man in the saddle is riding the horse's pose
   * from the previous frame, which at a gallop is two centimetres of body bob
   * out of step and reads as a loose seat.
   */
  syncPose(dt) {
    const f = this.ctx.time ? this.ctx.time.frame : -1;
    if (f >= 0 && this._posedFrame === f) return;
    this._posedFrame = f;
    const a = this.physics ? this.physics.alpha : 1;
    this.renderPos.lerpVectors(this.prevPos, this.state.position, a);
    this._pose(dt);
  }

  /* ------------------------------------------------------------- animation */

  _pose(dt) {
    const rig = this.rig;
    const world = this.ctx.world;
    const env = this.ctx.env;
    const G = GAITS[this.gait];
    const h = Math.min(dt || 1 / 60, 1 / 30);
    rig.reset();

    const yaw = this.yaw;
    const fwd = _fwd.set(Math.sin(yaw), 0, Math.cos(yaw)).clone();
    const rgt = _rgt.set(-fwd.z, 0, fwd.x).clone();
    const base = this.renderPos;
    const moving = G.freq > 0 ? 1 : 0;
    const sp = Math.hypot(this.state.velocity.x, this.state.velocity.z);
    const amp = this._freq > 0 ? (sp / (2 * this._freq)) * G.duty : 0;

    /* ---- per-limb stance / swing ---------------------------------------- */
    const limbs = {};
    let contactSum = 0, contactY = 0;
    for (const k of ['LF', 'RF', 'LH', 'RH']) {
      const rest = HOOF_REST[k];
      let z = 0, lift = 0, planted = 1;
      if (moving) {
        const p = (this.gaitPhase - G.off[k] + 1) % 1;
        if (p < G.duty) {
          const t = p / G.duty;
          z = amp * (1 - 2 * t);
        } else {
          const t = (p - G.duty) / (1 - G.duty);
          const e = t * t * (3 - 2 * t);
          z = -amp + 2 * amp * e;
          lift = Math.sin(t * Math.PI) * (0.10 + 0.24 * this.speed01 + amp * 0.22);
          planted = 0;
        }
      } else if (k === (this._restFoot ? 'LH' : 'RH')) {
        z = -0.02; lift = 0.0;                      // resting hind leg, barely cocked
      }
      // HOOF_REST is in horse-local space where +X is the horse's LEFT, which
      // is -right in world space.
      const lx = -rest[0], lz = rest[2] + z;
      const wx = base.x + rgt.x * lx + fwd.x * lz;
      const wz = base.z + rgt.z * lx + fwd.z * lz;
      const gy = world.getHeight(wx, wz);
      limbs[k] = { world: new THREE.Vector3(wx, gy + lift, wz), lift, planted, gy };
      if (planted) { contactSum++; contactY += gy; }
    }
    const groundY = contactSum ? contactY / contactSum : world.getHeight(base.x, base.z);

    /* ---- body ------------------------------------------------------------ */
    const ph = this.gaitPhase * Math.PI * 2;
    const bobHz = this.gait === 'walk' ? 2 : 1;
    const bob = -Math.abs(Math.sin(ph * bobHz)) * G.bob * moving;
    const breathe = Math.sin(this._idleT * 1.15) * 0.005;
    this._bodyBob += (bob - this._bodyBob) * Math.min(1, h * 22);

    const pitch = Math.sin(ph - 0.6) * G.pitch * moving
      + THREE.MathUtils.clamp(-this._accel.dot(fwd) * 0.010, -0.10, 0.10);
    const roll = Math.sin(ph * (this.gait === 'walk' ? 1 : 2)) * 0.045 * moving;

    const frontY = (limbs.LF.gy + limbs.RF.gy) * 0.5;
    const hindY = (limbs.LH.gy + limbs.RH.gy) * 0.5;
    const slopePitch = Math.atan2(hindY - frontY, 0.96);

    this.group.position.set(base.x, groundY + this._bodyBob + breathe, base.z);
    this.group.rotation.set(0, yaw, 0);
    this.group.updateMatrixWorld(true);

    rig.rot('body', pitch + slopePitch * 0.85, 0, roll);
    rig.rot('croup', -pitch * 0.5, 0, -roll * 0.4);
    rig.rot('chest', pitch * 0.25, 0, roll * 0.3);

    /* ---- neck + head ----------------------------------------------------- */
    const nod = Math.sin(ph * (this.gait === 'walk' ? 1 : 2) + 0.9) * G.nod * moving;
    const idleNod = Math.sin(this._idleT * 0.55) * 0.040 + Math.sin(this._idleT * 0.19) * 0.028;
    const drive = nod + (1 - moving) * idleNod - this.speed01 * 0.16;
    this._neck.vx += (drive - this._neck.x) * 120 * h - this._neck.vx * 15 * h;
    this._neck.x += this._neck.vx * h;
    const nk = this._neck.x;
    rig.rot('neck1', 0.10 + nk * 0.45 - pitch * 0.7, 0, -roll * 0.3);
    rig.rot('neck2', 0.04 + nk * 0.35, Math.sin(this._idleT * 0.23) * 0.05 * (1 - moving), 0);
    rig.rot('neck3', -0.09 + nk * 0.25, 0, 0);
    rig.rot('head', -0.14 - nk * 0.75 + Math.sin(this._idleT * 0.4) * 0.03 * (1 - moving),
      Math.sin(this._idleT * 0.17) * 0.09 * (1 - moving), 0);

    /* ---- ears -------------------------------------------------------------
     * A horse's ears are never still and they are never symmetrical. At rest
     * they are pricked forward and swivel independently toward whatever is
     * making a noise; under work they flatten back with effort; every few
     * seconds one flicks. Rotations are about the head's frame, where +x tips
     * the ear forward and +z tips it toward the horse's right.
     */
    {
      const pl = this.ctx.get('player');
      let toRider = 0;
      if (pl && pl.state && !this.mounted) {
        _v3.subVectors(pl.state.position, base);
        const d = _v3.length();
        if (d < 9.0 && d > 0.2) {
          // signed bearing of the rider off the horse's nose, -1..1
          const c = (_v3.x * rgt.x + _v3.z * rgt.z) / d;
          toRider = THREE.MathUtils.clamp(c, -1, 1) * (1 - THREE.MathUtils.clamp(d / 9, 0, 1));
        }
      }
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? 1 : -1;                  // +1 = the horse's left
        const e = this._ear[i];
        const t = this._idleT * (i ? 0.41 : 0.33) + i * 2.13;
        // brief, sparse flicks rather than a continuous wobble
        const flick = Math.max(0, Math.sin(t) - 0.93) * 13.0
          + Math.max(0, Math.sin(t * 2.7 + 1.1) - 0.965) * 9.0;
        const wander = Math.sin(this._idleT * (0.23 + i * 0.07) + i) * 0.10;
        const tgtX = 0.26 + wander - this.speed01 * this.speed01 * 0.80 - flick * 0.42
          + toRider * side * 0.22;
        const tgtZ = -0.20 * side - toRider * side * 0.26 - flick * 0.10 * side;
        e.vx += (tgtX - e.x) * 90 * h - e.vx * 13 * h;
        e.vy += (tgtZ - e.y) * 80 * h - e.vy * 12 * h;
        e.x += e.vx * h; e.y += e.vy * h;
        rig.rot(i === 0 ? 'earL' : 'earR', e.x, toRider * side * 0.30, e.y);
      }
    }

    /* ---- tail ------------------------------------------------------------ */
    /*
     * A tail is two kilos of dense hair on a short muscular dock, not a flag.
     * The wind terms used to be unclamped, so a stiff breeze rotated all three
     * segments the same way and the whole tail stood out HORIZONTALLY — at 1:1
     * that read as a trunk, and it is what made the strand cards fan into a
     * row of straps instead of hanging as a mass. Clamped to a quarter radian
     * per segment, which is about as far as a real tail lifts short of a gale.
     */
    const wind = env.windVector;
    const CLAMP = 0.26;
    const windF = THREE.MathUtils.clamp((wind.x * fwd.x + wind.z * fwd.z) * 0.035, -0.30, 0.30);
    const windS = THREE.MathUtils.clamp((wind.x * rgt.x + wind.z * rgt.z) * 0.035, -0.30, 0.30);
    const swish = Math.sin(this._idleT * 1.35) * 0.09 + Math.sin(this._idleT * 0.47) * 0.055;
    for (let i = 0; i < 3; i++) {
      const t = this._tail[i];
      const dx = -this.speed01 * (0.30 + i * 0.16) - windF * (0.5 + i * 0.3)
        + Math.sin(ph * 2 + i) * 0.05 * moving;
      const dz = swish * (0.5 + i * 0.5) * (1 - moving * 0.5) - windS * (0.6 + i * 0.4);
      t.vx += (dx - t.x) * 55 * h - t.vx * 9 * h;
      t.vz += (dz - t.z) * 48 * h - t.vz * 8 * h;
      t.x = THREE.MathUtils.clamp(t.x + t.vx * h, -CLAMP * 1.6, CLAMP * 1.6);
      t.z = THREE.MathUtils.clamp(t.z + t.vz * h, -CLAMP, CLAMP);
      rig.rot('tail' + (i + 1), t.x + (i === 0 ? -0.10 : 0.06), 0, t.z);
    }

    /* ---- legs ------------------------------------------------------------ */
    rig.sync();
    for (const k of ['LF', 'RF', 'LH', 'RH']) {
      const L = k[0];
      const hoof = limbs[k].world;
      if (k[1] === 'F') {
        const knee = _v.clone().copy(hoof).addScaledVector(UP, 0.680).addScaledVector(fwd, -0.058);
        _v2.copy(fwd).multiplyScalar(-1).addScaledVector(UP, 0.12).normalize();
        rig.ik2('fUp' + L, 'fFore' + L, HLEG.fUpper, HLEG.fFore, knee, _v2);
        this._aimChain('fCan' + L, new THREE.Vector3().copy(hoof).addScaledVector(UP, 0.240).addScaledVector(fwd, -0.033), fwd);
        this._aimChain('fPas' + L, new THREE.Vector3().copy(hoof).addScaledVector(UP, 0.020).addScaledVector(fwd, 0.010), fwd);
      } else {
        const hock = _v.clone().copy(hoof).addScaledVector(UP, 0.630).addScaledVector(fwd, -0.129);
        _v2.copy(fwd).addScaledVector(UP, 0.10).normalize();
        rig.ik2('hUp' + L, 'hSti' + L, HLEG.hUpper, HLEG.hStifle, hock, _v2);
        this._aimChain('hHoc' + L, new THREE.Vector3().copy(hoof).addScaledVector(UP, 0.210).addScaledVector(fwd, -0.029), fwd);
        this._aimChain('hCan' + L, new THREE.Vector3().copy(hoof).addScaledVector(UP, 0.020).addScaledVector(fwd, 0.006), fwd);
      }
    }
    rig.sync();

    this._updateContact(limbs);
    this._updateVisibility();
  }

  /** Aim a bone's local -Y at a world target from its own world origin. */
  _aimChain(name, target, pole) {
    const rig = this.rig;
    const b = rig.get(name);
    b.updateWorldMatrix(true, false);
    _v3.setFromMatrixPosition(b.matrixWorld);
    const dir = target.clone().sub(_v3);
    if (dir.lengthSq() < 1e-8) return;
    rig.aimWorld(b, dir.normalize(), pole);
    b.updateWorldMatrix(false, false);
  }

  _updateContact(limbs) {
    const pts = [], radii = [], wts = [];
    for (const k of ['LF', 'RF', 'LH', 'RH']) {
      const l = limbs[k];
      pts.push(l.world);
      radii.push(0.42);
      wts.push(1 - THREE.MathUtils.clamp(l.lift / 0.22, 0, 0.9));
    }
    this.contact.update(pts, radii, wts);
  }

  _updateVisibility() {
    const cam = this.ctx.camera;
    const rig = this.ctx.get('camera');
    let vis = true;
    if (rig && rig.freeCam) {
      const d = cam.position.distanceTo(this.renderPos);
      vis = d > 2.2 && d < 60;
      /*
       * The horse stands where the RIDER is, not where the lens is: its
       * placement search picks level ground on a short arc beside the player.
       * So whenever Player has hidden itself because the capture camera is
       * standing inside it, the horse is by construction two or three metres
       * off the lens and pointing at nothing in particular — which is what put
       * a riderless horse straddling the campfire, filling a quarter of the
       * frame, in night_camp. A horse without its rider at that range is never
       * the intended subject; shots that DO want the pair (player_third_person)
       * put the camera on an offset POI, so Player stays visible and so does
       * this.
       */
      const pl = this.ctx.get('player');
      if (pl && pl.visible === false) vis = false;
    }
    this.visible = vis;
    this.group.visible = vis;
    if (!vis && this.contact) this.contact.mesh.visible = false;
    this._updateLOD(cam.position.distanceTo(this.renderPos), vis);
  }

  /**
   * Pick the level of detail.
   *
   * Hysteresis is deliberately wide: the motion gate measures LOD POP over a
   * forward dolly, and a level that can toggle on a boundary registers as one
   * no matter how similar the two levels look. Each level is the same
   * radiusFn sculpt at a lower segment count, so the silhouette moves by well
   * under a pixel at the distance it switches at, and the relaxed normals
   * carry across.
   */
  _updateLOD(d, vis) {
    if (!this.lods) return;              // init bailed; nothing to switch
    const near = LOD_NEAR + (this.lodLevel > 0 ? -HYST : HYST);
    const far = LOD_FAR + (this.lodLevel > 1 ? -HYST : HYST);
    let want = 0;
    if (d > far) want = 2;
    else if (d > near) want = 1;
    if (want !== this.lodLevel) {
      this.lodLevel = want;
      for (let i = 0; i < this.lods.length; i++) this.lods[i].visible = (i === want);
    } else if (vis) {
      // a level may have been switched off by a previous frame's group hide
      this.lods[want].visible = true;
    }

    // Hair cards are the only alpha-tested geometry on the animal; past
    // HAIR_CUT they are two pixels of noise and a shadow-map discard for
    // nothing, and past HAIR_LOD the half-density set is indistinguishable.
    const hairWant = d > HAIR_CUT ? -1 : (d > HAIR_LOD + (this.hairLevel === 1 ? -HYST : HYST) ? 1 : 0);
    this.hairLevel = hairWant;
    for (let i = 0; i < this.hairs.length; i++) this.hairs[i].visible = vis && i === hairWant;
  }

  /* ------------------------------------------------------------ rider API */

  /**
   * World transform of the saddle seat, plus the two stirrup irons, for the
   * mounted rider.
   *
   * Everything is taken from the `saddle` BONE's world matrix, which hangs off
   * `body` and therefore already carries the horse's stride: the vertical bob,
   * the fore-aft pitch, the roll, and the slope of the ground under it. A
   * rider hung off a fixed offset from the root instead has to fake all four
   * and gets none of them right.
   *
   * The irons are built in HorseRig at (±0.320, 1.088, 0.066) skinned 100 % to
   * `body`, and the saddle bone sits at (0, 1.62, 0) with no rest rotation, so
   * SEAT_TO_IRON is their offset in the saddle bone's own frame. Local +X is
   * the horse's LEFT, which is the same convention the human rig uses.
   */
  getSaddle(out) {
    const b = this.rig.get('saddle');
    b.updateWorldMatrix(true, false);
    const r = out || this._saddleOut || (this._saddleOut = {
      position: new THREE.Vector3(), quaternion: new THREE.Quaternion(),
      stirrupL: new THREE.Vector3(), stirrupR: new THREE.Vector3(),
    });
    r.position.setFromMatrixPosition(b.matrixWorld);
    r.quaternion.setFromRotationMatrix(b.matrixWorld);
    r.stirrupL.copy(SEAT_TO_IRON).applyQuaternion(r.quaternion).add(r.position);
    r.stirrupR.set(-SEAT_TO_IRON.x, SEAT_TO_IRON.y, SEAT_TO_IRON.z)
      .applyQuaternion(r.quaternion).add(r.position);
    r.bobMetres = this._bodyBob;               // signed, metres, this frame
    r.gaitPhase = this.gaitPhase;
    r.gait = this.gait;
    r.speed01 = this.speed01;
    r.freq = this._freq;
    return r;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    if (this.physics && this._stepFn) this.physics.removeStepper(this._stepFn);
    if (this.collider) this.collider.dispose();
    for (const m of (this.lods || [])) m.geometry.dispose();
    for (const m of (this.hairs || [])) m.geometry.dispose();
    for (const m of (this.mats ? this.mats.all : [])) m.dispose();
    if (this.contact) this.contact.dispose();
    this.ctx.scene.remove(this.group);
  }
}
