import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildHumanRig, buildHumanGeometry, PROP } from './rig/HumanRig.js';
import { makeCharMaterial, makeCharDepthMaterial, ContactShadow } from './rig/CharMaterial.js';
import { bakeVertexAO } from './rig/SkinBuilder.js';
import { smoothstep } from './rig/Rig.js';
import { Weapon } from './Weapon.js';
import { Wanted } from '../ui/Wanted.js';
import { rng } from '../core/Context.js';

/**
 * RED SANDS — PLAYER
 * ============================================================================
 * A 1.80 m procedural gunslinger with a full procedural locomotion system.
 *
 *   CONTROL      WASD + mouse look, shift sprint, space jump, ctrl crouch.
 *                Movement runs on the physics fixed step (1/60) and the
 *                render pose interpolates, so nothing judders.
 *   LOCOMOTION   idle / walk / jog / sprint blended on speed01, with real
 *                contralateral arm swing, pelvis counter-rotation against the
 *                shoulders, spine lean into acceleration, and head
 *                stabilisation so the eyeline stays level through the bob.
 *   FOOT PLANT   the stride is derived from the actual ground speed so the
 *                stance foot is world-static (no skating), and both ankles are
 *                two-bone-IK'd onto ctx.world.getHeight, so on a slope the
 *                downhill leg extends and the pelvis rolls to match.
 *   CLOTH        three coat-skirt bones and the hat carry spring-damper
 *                secondary motion driven by acceleration, stride and
 *                env.windVector.
 *   CONTACT      a multiply-blended terrain-conforming AO patch under the feet
 *                in addition to the CSM cast shadow. Without it the figure
 *                floats and destroys the very sense of scale it is there for.
 * ============================================================================
 */

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rgt = new THREE.Vector3();
const _safePos = new THREE.Vector3();
const _safeVel = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _sole = new THREE.Vector3();
const _fb = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _anchorPos = new THREE.Vector3();
const _anchorQ = new THREE.Quaternion();
const _qNat = new THREE.Quaternion();
const _qA = new THREE.Quaternion();
const _qEye = new THREE.Quaternion();
const _qAim = new THREE.Quaternion();
const _tgt = new THREE.Vector3();
const _tgt2 = new THREE.Vector3();
const _stand = new THREE.Vector3();
const _hf = new THREE.Vector3();
const _hl = new THREE.Vector3();
const _hx = new THREE.Vector3();
const _hy = new THREE.Vector3();
const _hz = new THREE.Vector3();
const _wr = new THREE.Vector3();
const _hp = new THREE.Vector3();
const _err = new THREE.Vector3();
const _goal = new THREE.Vector3();
const _hqw = new THREE.Quaternion();

/**
 * MOUNTED SEAT, in the horse's saddle-bone frame (metres).
 *   SEAT_RISE   hip joint above the saddle bone — the ischium is on the seat,
 *               the joint itself sits a hand's width above it.
 *   SEAT_BACK   back off the swell, toward the cantle.
 *   ANKLE_LIFT  ankle above the iron's centre: the ball of the foot is on the
 *               tread, so the joint rides just above and behind it.
 */
const SEAT_RISE = 0.115, SEAT_BACK = -0.030, ANKLE_LIFT = -0.012;
/** Saddle horn, in the saddle bone's frame — where the hands go to mount. */
const SEAT_TO_HORN = new THREE.Vector3(0, 0.100, 0.246);
/** How far off the horse's near side the rider stands to get on. */
const NEAR_SIDE = 1.32;
/**
 * Hand MESH centre relative to the hand BONE, from HumanRig's blob placement
 * (0.271, 0.812, 0.020) against the bone's bind position (0.236, 0.861, 0.015).
 * x is mirrored per side. Everything that puts a hand ON something has to back
 * this out, or the thing being held ends up inside the fist.
 */
const HAND_MESH = { x: 0.035, y: -0.049, z: 0.005 };

/** How many skinned pelts may lie on the ground at once. */
const DROP_MAX = 6;

/*
 * MOUNT / DISMOUNT TIMELINE.
 *
 * `c` is seconds on the CORE clock, i.e. after any walk-in lead. Audio can
 * read the same table off `player.mountAnim.beats` (converted to absolute
 * seconds) or just listen for the `mountBeat` events these fire.
 */
const MOUNT_BEATS = [
  { name: 'reach', c: 0.06, sfx: 'leather', vol: 0.35, pitch: 1.15 },
  { name: 'stirrup', c: 0.24, sfx: 'clink', vol: 0.45, pitch: 0.85 },
  { name: 'rise', c: 0.52, sfx: 'creak', vol: 0.55, pitch: 1.05 },
  { name: 'mount', c: 0.82 },
  { name: 'settle', c: 1.06, sfx: 'leather', vol: 0.55, pitch: 0.92 },
];
const DISMOUNT_BEATS = [
  { name: 'rise', c: 0.08, sfx: 'creak', vol: 0.50, pitch: 1.10 },
  { name: 'swing', c: 0.30, sfx: 'leather', vol: 0.45, pitch: 1.05 },
  { name: 'dismount', c: 0.62 },
  { name: 'stirrup', c: 0.82, sfx: 'clink', vol: 0.40, pitch: 0.90 },
  { name: 'ground', c: 1.02, sfx: 'footstep', vol: 0.75 },
];

/*
 * Gait ladder. W alone is a STROLL — this world is worth looking at and the
 * default speed should let you. Shift breaks into a jog and, if you keep
 * holding it, winds up into a sprint over about a second, so "run" has a
 * build to it instead of a switch.
 */
const WALK = 1.62, JOG = 3.95, SPRINT = 6.60, BACKPEDAL = 1.30;
/** m/s² — a man in a duster and boots, not a shopping trolley. */
const ACCEL = 8.2, DECEL = 11.0, STOP = 9.4, AIR_ACCEL = 1.6;
/** Windup from jog to full sprint, seconds of held Shift. */
const SPRINT_WINDUP = 1.15;

function angWrap(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
function toward(cur, target, maxStep) {
  const d = target - cur;
  return Math.abs(d) <= maxStep ? target : cur + Math.sign(d) * maxStep;
}
function finite3(v) {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

export class Player {
  static id = 'player';

  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'player';

    this.state = {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      radius: 0.30,
      height: 1.8,
      grounded: true,
      groundNormal: new THREE.Vector3(0, 1, 0),
      maxSlopeCos: 0.58,
      stepHeight: 0.45,
    };
    this.prevPos = new THREE.Vector3();
    this.renderPos = new THREE.Vector3();

    /** Aim/look yaw — driven by the mouse, read by the camera. */
    this.yaw = 0;
    /** Where the BODY is actually facing. Lags the aim; leads nothing. */
    this.bodyYaw = 0;
    /** Heading of the velocity vector we are steering. */
    this.moveYaw = 0;
    this.pitch = -0.06;
    /** 'onFoot' | 'mounted' | 'mounting' | 'dismounting'. */
    this.mode = 'onFoot';
    /** What the REST of the world is told — never a transition state. */
    this.publicMode = 'onFoot';
    /** Live mount/dismount transition, or null. */
    this.trans = null;
    /** Timeline other systems (audio) can hook while a transition runs. */
    this.mountAnim = null;
    /** 0 = boots on the ground, 1 = seated. Drives the camera through both. */
    this.mountBlend = 0;
    this.speed01 = 0;
    this.crouch = 0;
    this._crouchWant = 0;
    this._runHold = 0;
    this._turningIdle = false;
    this._grade = 0;
    this._stuckT = 0;
    this._stuckFrom = new THREE.Vector3();
    this._unstick = 0;
    /** Seconds since the mouse last moved — used to recentre the ride view. */
    this._lookIdle = 99;
    /** Metres travelled on foot/horse since boot — the HUD uses it to know
     *  when the player has understood the controls and the hint can go. */
    this.distanceTravelled = 0;

    this.input = { f: 0, r: 0, sprint: false, jump: false, crouch: false };
    this._keys = new Set();

    // gait
    this.gaitPhase = 0.12;
    this.gaitFreq = 0;
    this.strideAmp = 0;
    this._footY = [0, 0];
    this._lastFootDown = [false, false];
    this._breath = 0;
    this._idleT = 0;
    /** Smoothed share of the saddle's vertical travel the rider absorbs. */
    this._rideBob = 0;
    this._lean = new THREE.Vector2();
    this._accel = new THREE.Vector3();
    this._prevVel = new THREE.Vector3();

    // cloth springs: [x,z] angle + velocity per coat bone, plus the hat
    this._cloth = [];
    for (let i = 0; i < 4; i++) this._cloth.push({ x: 0, z: 0, vx: 0, vz: 0 });

    /* --- skinning -------------------------------------------------------- */
    /**
     * Live skinning interaction, or null. HUD reads `{t, dur, species}` off it
     * and draws the progress ring; `_fixed` reads it and kills movement.
     */
    this.skinning = null;
    /** 0..1 blend into the kneel, so nothing snaps at either end. */
    this._skinBlend = 0;
    this._skinAnchor = new THREE.Vector3();
    this._skinYaw = 0;
    this._cutT = 0;
    /** Dropped pelts lying in the world. Small, capped, recycled oldest-first. */
    this._drops = [];
    /** The one within reach, published for HUD's prompt. */
    this.pickup = null;
    /** Pelts the player is actually carrying, as opposed to kills tallied. */
    this.peltsCarried = 0;

    /** Crime / witnesses / wanted level / the law. Stepped from update(). */
    this.wanted = new Wanted(ctx);

    this._frame = null;      // cached OTS framing for the capture harness
    this.visible = true;
    this._freeCamHide = false;
    this.drawCalls = 0;
  }

  /* ==================================================================== init */

  async init() {
    const ctx = this.ctx;

    this.rig = buildHumanRig();
    /* Bake contact occlusion into the mesh. Coat folds, the gutter under the
     * brim, the seam where a sleeve meets the yoke and the shadow the skirt
     * throws on the boots are all occlusion, and without them the figure is
     * one flat mass however good the albedo is. ~10 ms, once. */
    const geo = bakeVertexAO(buildHumanGeometry(this.rig), { strength: 1.0 });
    const skeleton = this.rig.finish();

    this.matSolid = makeCharMaterial({ name: 'playerSolid', dust: 0.45 });
    this.matCloth = makeCharMaterial({ name: 'playerCloth', dust: 0.55, doubleSide: true });
    const sky = ctx.get('sky');
    if (sky && sky.injectAerialPerspective) {
      sky.injectAerialPerspective(this.matSolid);
      sky.injectAerialPerspective(this.matCloth);
    }

    this.mesh = new THREE.SkinnedMesh(geo, [this.matSolid, this.matCloth]);
    this.mesh.name = 'playerBody';
    this.mesh.customDepthMaterial = makeCharDepthMaterial(0.018);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.add(this.rig.root);
    this.mesh.bind(skeleton, new THREE.Matrix4());
    this.group.add(this.mesh);
    ctx.scene.add(this.group);

    this.contact = new ContactShadow(ctx, { radius: 0.85, strength: 0.88, res: 12 });
    ctx.scene.add(this.contact.mesh);

    const lighting = ctx.get('lighting');
    if (lighting && lighting.requestShadowCaster) lighting.requestShadowCaster(this.mesh);

    this._pickSpawn();
    this._registerPOIs();

    const physics = ctx.get('physics');
    if (physics && physics.addStepper) {
      this._stepFn = (h) => this._fixed(h);
      physics.addStepper(this._stepFn);
    }
    this.physics = physics;

    this.weapon = new Weapon(ctx, this);
    await this.weapon.init();

    this._buildSkinKit();

    this._bindInput();
    ctx.on('teleport', (p) => this._onTeleport(p));

    this._writeCtx();
    // Settle the pose once so frame 0 is already correct.
    this._pose(0, true);
  }

  /* --------------------------------------------------------------- spawn */

  _pickSpawn() {
    const ctx = this.ctx;
    const world = ctx.world;
    const rand = rng(ctx.seed ^ 0x51a7);

    // Anchor on the town if terrain published one — the lowlands there are the
    // most photogenic ground in the map — otherwise fall back to the origin.
    const town = ctx.poi.get('town');
    const anchor = town ? (town.pos ? town.pos.clone() : town.clone()) : new THREE.Vector3(0, 0, 0);

    // The over-the-shoulder shot has the camera 4.6 m behind the character at
    // 1.9 m: if we spawn under a canopy the whole frame is the inside of a
    // pine bough. Sample the vegetation forest field around every candidate
    // and reject anything with trees within the camera's own clearance.
    const veg = ctx.get('vegetation');
    const forestAt = veg && veg.densityAt
      ? (x, z) => { const d = veg.densityAt(x, z); return (d && d.forest) || 0; }
      : () => 0;
    // ...and the settlement footprint is not open pasture either: penalising
    // canopy alone moved the pick straight into town, four metres from a barn.
    const townSys = ctx.get('town');
    const inTown = townSys && townSys.site && townSys.site.contains
      ? (x, z) => townSys.site.contains(x, z)
      : () => false;

    let best = null;
    for (let i = 0; i < 220; i++) {
      const a = rand() * Math.PI * 2;
      const rad = 150 + rand() * 260;
      const x = anchor.x + Math.cos(a) * rad;
      const z = anchor.z + Math.sin(a) * rad;
      if (Math.abs(x) > world.size * 0.85 || Math.abs(z) > world.size * 0.85) continue;
      const y = world.getHeight(x, z);
      if (world.isWater && world.isWater(x, z)) continue;
      if (y < world.waterLevel + 2.5) continue;
      const n = world.getNormal(x, z, _v);
      if (n.y < 0.965) continue;                       // must be gentle ground
      const surf = world.getSurface(x, z);
      if ((surf.grass || 0) < 0.34) continue;          // stand in the pasture
      // keep clear of the waterline so the foreground is not a mud flat
      let nearWater = false;
      for (let k = 0; k < 6 && !nearWater; k++) {
        const aa = (k / 6) * Math.PI * 2;
        for (let d = 20; d <= 60; d += 20) {
          if (world.getHeight(x + Math.cos(aa) * d, z + Math.sin(aa) * d) < world.waterLevel + 1.2) {
            nearWater = true; break;
          }
        }
      }
      if (nearWater) continue;
      // canopy clearance: no trees within ~22 m of the character or the camera
      let canopy = forestAt(x, z);
      let built = inTown(x, z) ? 1 : 0;
      for (let k = 0; k < 8; k++) {
        const aa = (k / 8) * Math.PI * 2;
        const cx = Math.cos(aa), cz = Math.sin(aa);
        canopy = Math.max(canopy, forestAt(x + cx * 22, z + cz * 22));
        if (inTown(x + cx * 34, z + cz * 34)) built = 1;
      }
      if (built) continue;
      // local relief: we want a little shape nearby, not a billiard table
      let relief = 0;
      for (let k = 0; k < 8; k++) {
        const aa = (k / 8) * Math.PI * 2;
        relief += Math.abs(world.getHeight(x + Math.cos(aa) * 26, z + Math.sin(aa) * 26) - y);
      }
      relief /= 8;
      const score = (surf.grass || 0) * 4.0 + (surf.dirt || 0) * 0.5
        - (surf.sand || 0) * 1.5 - (surf.snow || 0) * 3
        + Math.min(relief, 5) * 0.45 - Math.max(0, relief - 7) * 0.6
        + n.y * 1.5
        - canopy * 40.0;                               // never spawn under a canopy
      if (!best || score > best.score) best = { x, z, y, score };
    }
    if (!best) {
      const x = anchor.x + 180, z = anchor.z + 60;
      best = { x, z, y: world.getHeight(x, z) };
    }
    this.state.position.set(best.x, best.y, best.z);
    this.prevPos.copy(this.state.position);
    this.renderPos.copy(this.state.position);
    this._stuckFrom.copy(this.state.position);
    this.spawn = this.state.position.clone();
    this.yaw = Math.atan2(anchor.x - best.x, anchor.z - best.z);
    this.bodyYaw = this.yaw;
    this.moveYaw = this.yaw;
  }

  /* ----------------------------------------------------------------- POIs */

  /**
   * `player_ots` / `player_fwd` are live getters: the capture harness sets the
   * time of day BEFORE it resolves them, so the framing can key off the actual
   * sun azimuth and put the light three-quarters behind the camera — long
   * shadows raking into frame, a lit shoulder and a cool skylight fill side.
   */
  _registerPOIs() {
    const self = this;
    this.ctx.poi.set('player_ots', {
      get pos() { return self._framing().cam.clone(); },
      get look() { return self._framing().look.clone(); },
    });
    this.ctx.poi.set('player_fwd', {
      get pos() { return self._framing().look.clone(); },
      get look() { return self._framing().look.clone(); },
    });
  }

  _framing() {
    const ctx = this.ctx;
    const world = ctx.world;
    /*
     * SHOT ORDER MUST NOT DECIDE WHERE THE CHARACTER STANDS.
     *
     * Every landscape shot teleports us to its own camera, so `player_ots`
     * used to frame the character wherever the PREVIOUS shot happened to
     * leave them. Captured on its own the shot showed an open pasture;
     * captured as part of the full set — where forest_interior runs
     * immediately before it — it showed the character standing in a black
     * spruce thicket at 1/8 of the exposure. Snap back to the vetted spawn
     * (chosen in _pickSpawn for level grass with no canopy within 22 m) so
     * the framing is the same in both cases.
     */
    if (this.spawn && this.state.position.distanceToSquared(this.spawn) > 4) {
      this.state.position.copy(this.spawn);
      this.prevPos.copy(this.state.position);
      this.renderPos.copy(this.state.position);
      this.state.velocity.set(0, 0, 0);
      ctx.player.position.copy(this.state.position);
    }
    const sun = ctx.env.sunDirection;
    // Face the character away from the camera; put the sun ~55 deg off the
    // view axis on the camera side.
    let viewA = Math.atan2(-sun.x, -sun.z) + 0.95;
    const p = this.state.position;

    // Nudge the heading toward whichever nearby direction has the most depth
    // in it, so the shot gets layered ground rather than a flat wall.
    let bestA = viewA, bestScore = -1e9;
    for (let k = -3; k <= 3; k++) {
      const a = viewA + k * 0.22;
      let s = 0;
      for (let d = 40; d <= 320; d += 40) {
        const hx = p.x + Math.sin(a) * d, hz = p.z + Math.cos(a) * d;
        s += (world.getHeight(hx, hz) - p.y) * (d / 320);
      }
      s -= Math.abs(k) * 0.6;
      if (s > bestScore) { bestScore = s; bestA = a; }
    }
    viewA = bestA;
    this.yaw = viewA;
    this.bodyYaw = viewA;
    this.moveYaw = viewA;
    this._yawTarget = viewA;

    const fwd = _fwd.set(Math.sin(viewA), 0, Math.cos(viewA));
    const rgt = _rgt.set(-fwd.z, 0, fwd.x);          // right = forward x up
    const gy = world.getHeight(p.x, p.z);

    // over the character's right shoulder, character left of centre
    const cam = new THREE.Vector3(p.x, gy, p.z)
      .addScaledVector(fwd, -4.55)
      .addScaledVector(rgt, 1.16)
      .addScaledVector(UP, 1.94);
    const camGy = world.getHeight(cam.x, cam.z);
    if (cam.y < camGy + 1.25) cam.y = camGy + 1.25;

    const look = new THREE.Vector3(p.x, gy, p.z)
      .addScaledVector(fwd, 5.6)
      .addScaledVector(rgt, 0.22)
      .addScaledVector(UP, 1.72);

    this._frame = { cam, look, yaw: viewA };
    // the horse parks relative to our heading, so tell it we turned
    this.ctx.emit('playerTeleported', this.state.position);
    return this._frame;
  }

  _onTeleport(pos) {
    // The harness moves the streaming origin for every shot. If the requested
    // point is nowhere near us this is a real teleport (a landscape shot) and
    // we follow so LOD resolves around the camera; if it is a few metres away
    // it is our own over-the-shoulder POI and we must NOT move.
    if (!pos) return;
    const d = _v.set(pos.x - this.state.position.x, 0, pos.z - this.state.position.z).length();
    if (d < 40) return;
    // A real teleport outranks a mount animation: drop it rather than let it
    // keep dragging the character back toward a horse that is now 500 m away.
    if (this.trans) this._abortTransition();
    // …and the same goes for a kneel, which would otherwise keep hauling the
    // character back to a carcass in another county.
    if (this.skinning) this._cancelSkin(null);
    /*
     * A landscape shot puts the camera exactly here, and the horse parks a few
     * metres off our heading — which is how dawn_mist_valley ended up with a
     * saddled horse standing in the middle of a wide valley vista. Step the
     * streaming origin BEHIND the lens (the camera is already posed by the time
     * this event fires) so the actors are out of frame. Six metres is nothing
     * to LOD and everything to the composition.
     */
    const cam = this.ctx.camera;
    let px = pos.x, pz = pos.z;
    if (cam) {
      cam.getWorldDirection(_fwd);
      const l = Math.hypot(_fwd.x, _fwd.z) || 1;
      px -= (_fwd.x / l) * 7.5;
      pz -= (_fwd.z / l) * 7.5;
      this.yaw = Math.atan2(_fwd.x, _fwd.z);
      this.bodyYaw = this.yaw;
      this.moveYaw = this.yaw;
      this._yawTarget = this.yaw;
    }
    const gy = this.ctx.world.getHeight(px, pz);
    this.state.position.set(px, gy, pz);
    this.prevPos.copy(this.state.position);
    this.renderPos.copy(this.state.position);
    this.state.velocity.set(0, 0, 0);
    this._frame = null;
    this.ctx.emit('playerTeleported', this.state.position);
  }

  /* ---------------------------------------------------------------- input */

  _bindInput() {
    const canvas = this.ctx.canvas;
    this._onKeyDown = (e) => {
      this._keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    };
    this._onKeyUp = (e) => this._keys.delete(e.code);
    this._onAction = (e) => {
      if (e.repeat) return;
      if (e.code !== 'KeyE') return;
      if (this.skinning) return;              // movement cancels it, not E
      if (this.pickup) this._takePickup();
      else if (this.carcass) this._beginSkin();
    };
    this._onMouseMove = (e) => {
      if (document.pointerLockElement !== canvas) return;
      if (e.movementX || e.movementY) this._lookIdle = 0;
      this.yaw = angWrap(this.yaw - e.movementX * 0.0022);
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0018, -1.15, 0.95);
      this._yawTarget = this.yaw;
    };
    this._onClick = () => {
      if (document.pointerLockElement !== canvas && canvas.requestPointerLock) {
        try { canvas.requestPointerLock(); } catch (e) { /* headless */ }
      }
    };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keydown', this._onAction);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    canvas.addEventListener('click', this._onClick);
  }

  _readInput() {
    const k = this._keys;
    const i = this.input;
    i.f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    i.r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    // Shift is the run key, but with the sights up it steadies the breath
    // instead — you cannot sprint and hold a bead at the same time.
    i.sprint = (k.has('ShiftLeft') || k.has('ShiftRight'))
      && !(this.weapon && this.weapon.aim01 > 0.2);
    i.jump = k.has('Space');
    i.crouch = k.has('ControlLeft') || k.has('KeyC');
  }

  /* --------------------------------------------------- fixed-step movement */

  _fixed(h) {
    /*
     * Read the keyboard FIRST, every step, in every mode. The mounted branch
     * used to return before this line, so `this.input` froze at whatever it
     * held the instant you swung into the saddle — and Horse steers entirely
     * off `player.input`. The result was that mounting the horse silently
     * disabled all movement. You could get on, and then nothing.
     */
    this._readInput();
    /*
     * MOVEMENT IS DEAD WHILE THE KNIFE IS OUT — and pressing a movement key is
     * how you say you would rather not be doing this after all. Reading it off
     * the resolved `input` rather than off raw key codes means a controller or
     * a rebind cancels it too, and it cannot fire on the frame E was pressed
     * because E is not a movement key.
     */
    if (this.skinning) {
      const i = this.input;
      if (i.f || i.r || i.jump) {
        this._cancelSkin('Skinning stopped');
      } else {
        i.f = 0; i.r = 0; i.sprint = false; i.jump = false; i.crouch = false;
        this.state.velocity.set(0, 0, 0);
        this.speed01 = 0;
        // slide into the kneeling spot and square up on the animal
        this.prevPos.copy(this.state.position);
        const k = Math.min(1, h * 6);
        this.state.position.lerp(this._skinAnchor, k);
        this.state.position.y = this.ctx.world.getHeight(
          this.state.position.x, this.state.position.z);
        this.bodyYaw = angWrap(this.bodyYaw
          + angWrap(this._skinYaw - this.bodyYaw) * Math.min(1, h * 7));
        this.moveYaw = this.bodyYaw;
        this.yaw = angWrap(this.yaw + angWrap(this.bodyYaw - this.yaw) * Math.min(1, h * 3.2));
        this._yawTarget = this.yaw;
        this._lookIdle += h;
        this._idleT += h;
        this._breath += h * 0.34;
        return;
      }
    }
    /*
     * MOVEMENT IS DEAD WHILE YOU ARE CLIMBING ON OR OFF. The animation owns
     * the character's transform for its whole duration; letting WASD through
     * would fight the blend and let you walk out of your own mount.
     */
    if (this.trans) {
      const i = this.input;
      i.f = 0; i.r = 0; i.sprint = false; i.jump = false; i.crouch = false;
      this.state.velocity.set(0, 0, 0);
      this.speed01 = 0;
      this._lookIdle += h;
      this._idleT += h;
      this._breath += h * 0.34;
      return;
    }
    if (this.mode === 'mounted') {
      // the horse drives the transform; keep our state in sync with it
      const horse = this.ctx.player.horse;
      if (horse && horse.state) {
        this.prevPos.copy(this.state.position);
        this.distanceTravelled += this.state.position.distanceTo(horse.state.position);
        this.state.position.copy(horse.state.position);
        this.state.velocity.copy(horse.state.velocity);
        this.bodyYaw = horse.yaw;
        this.moveYaw = horse.yaw;
        /*
         * Riding must not lock the look. The horse steers off A/D; the eyeline
         * is yours, and only drifts back over the horse's ears once you have
         * let the mouse alone for half a second.
         *
         * NOT WHILE THE SIGHTS ARE UP. Down the sights this drag is actively
         * destructive, and it got worse the moment CameraRig learned to hold
         * the look: the camera keeps the shot, Weapon lerps the bore onto the
         * LENS at full shoulder, but the rider's torso twist is driven by
         * `aimOff = this.yaw - bodyYaw` and mounted `bodyYaw` IS `horse.yaw`.
         * So dragging `this.yaw` home squares the man up underneath a rifle
         * that is still on the target. Measured, holding a bead 88 deg off the
         * horse's heading and simply not touching the mouse: `yaw` was back on
         * the horse in 1.25 s and the bore went from 59 deg to 117 deg in the
         * CHEST BONE's own frame — the carbine held out square across his own
         * body, which is the same class of break the mounted pose pass just
         * fixed, reached by standing still instead of by mounting.
         *
         * `1 - aim*5` is deliberately the SAME law CameraRig uses to suspend
         * its recentre, so the two systems agree frame for frame: dead above
         * aim01 = 0.2, easing back in as the carbine comes down. At aim01 = 0
         * the rate is 2.2 rad/s exactly as before, so the approved riding
         * behaviour — and everything under ?capture=1, where the carbine is
         * slung — is untouched.
         */
        this._lookIdle += h;
        const aimFree = this.weapon ? Math.max(0, 1 - this.weapon.aim01 * 5) : 1;
        if (this._lookIdle > 0.5 && aimFree > 0) {
          const rate = 2.2 * aimFree;
          const d = angWrap(horse.yaw - this.yaw);
          this.yaw = angWrap(this.yaw + THREE.MathUtils.clamp(d, -rate * h, rate * h));
        }
        this.speed01 = horse.speed01 || 0;
      }
      this._idleT += h;
      this._breath += h * 0.3;
      return;
    }
    this._lookIdle += h;
    const s = this.state;
    this.prevPos.copy(s.position);
    // Last known-good state: if anything below produces a non-finite number
    // (a degenerate normal on a knife-edge ridge is the classic source) we
    // roll back rather than propagate NaN into the rig and the camera.
    _safePos.copy(s.position);
    _safeVel.copy(s.velocity);

    // crouch blend
    this._crouchWant = this.input.crouch ? 1 : 0;
    this.crouch += (this._crouchWant - this.crouch) * Math.min(1, h * 9);

    /* ---- desired heading, in world space, from the AIM yaw --------------- */
    const fwd = _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const rgt = _rgt.set(-fwd.z, 0, fwd.x);          // forward x up
    _v.set(0, 0, 0).addScaledVector(fwd, this.input.f).addScaledVector(rgt, this.input.r);
    const mag = _v.length();
    const moving = mag > 0.01;
    if (moving) _v.multiplyScalar(1 / mag);

    /* ---- the gait ladder ------------------------------------------------- */
    const wantsRun = this.input.sprint && moving && this.input.f >= 0;
    this._runHold = wantsRun
      ? Math.min(SPRINT_WINDUP + 0.4, this._runHold + h)
      : Math.max(0, this._runHold - h * 3.2);
    const windup = smoothstep(0.06, SPRINT_WINDUP, this._runHold);
    let target = 0;
    if (moving) {
      if (this.input.f < 0) target = BACKPEDAL;                      // never sprint backwards
      else if (wantsRun) target = JOG + (SPRINT - JOG) * windup;
      else target = WALK * (this.input.f === 0 ? 1.06 : 1);          // pure sidestep
    }
    target *= (1 - this.crouch * 0.52);

    /* ---- hills cost you ------------------------------------------------- */
    // Rise per horizontal metre along the direction of travel. Positive uphill.
    const n = s.groundNormal;
    let grade = 0;
    if (moving && Number.isFinite(n.y) && n.y > 0.05) {
      grade = -(n.x * _v.x + n.z * _v.z) / n.y;
      if (!Number.isFinite(grade)) grade = 0;
    }
    this._grade += (grade - this._grade) * Math.min(1, h * 8);
    const g = this._grade;
    target *= THREE.MathUtils.clamp(1 - Math.max(0, g) * 0.78 + Math.max(0, -g) * 0.20, 0.40, 1.16);

    /* ---- steer the velocity, do not snap it ------------------------------ */
    let sp = Math.hypot(s.velocity.x, s.velocity.z);
    if (moving) {
      const wantHeading = Math.atan2(_v.x, _v.z);
      const curHeading = sp > 0.35 ? Math.atan2(s.velocity.x, s.velocity.z) : wantHeading;
      const dh = angWrap(wantHeading - curHeading);
      // Pivot on the spot at a stroll, carve a wide arc at a sprint. This is
      // most of what stops the character feeling like a mouse cursor.
      const sp01 = THREE.MathUtils.clamp(sp / SPRINT, 0, 1);
      const maxTurn = (s.grounded ? 7.4 : 1.4) - 5.0 * sp01 * sp01;
      const newHeading = curHeading + THREE.MathUtils.clamp(dh, -maxTurn * h, maxTurn * h);
      // You cannot hold a sprint through a hairpin: scrub speed with the turn.
      const scrub = 1 - THREE.MathUtils.clamp(Math.abs(dh) / Math.PI, 0, 1) * 0.62;
      const tgt = target * scrub;
      const a = s.grounded ? (tgt > sp ? ACCEL : DECEL) : AIR_ACCEL;
      sp = toward(sp, tgt, a * h);
      this.moveYaw = newHeading;
      s.velocity.x = Math.sin(newHeading) * sp;
      s.velocity.z = Math.cos(newHeading) * sp;
    } else if (sp > 1e-4) {
      // Coast to a stop along the current heading — weight, not a handbrake.
      const a = s.grounded ? STOP : AIR_ACCEL;
      const k = Math.max(0, sp - a * h) / sp;
      s.velocity.x *= k;
      s.velocity.z *= k;
      sp *= k;
    }

    if (this.input.jump && s.grounded && this.crouch < 0.5) {
      s.velocity.y = 3.55;                            // a hop, not a moon jump
      s.grounded = false;
    }

    // Ground snap has to grow with speed or every crest throws you into the
    // air for two frames and the whole run reads as bunny-hopping.
    s.snap = 0.30 + sp * 0.085;

    if (this.physics) this.physics.stepCharacter(s, h);
    else {
      s.position.addScaledVector(s.velocity, h);
      s.position.y = this.ctx.world.getHeight(s.position.x, s.position.z);
    }

    if (!finite3(s.position) || !finite3(s.velocity)) {
      s.position.copy(_safePos);
      s.velocity.copy(_safeVel);
      s.velocity.y = 0;
      s.grounded = true;
      s.groundNormal.set(0, 1, 0);
    }
    this._antiStuck(h, moving, target);

    // ---- gait clock, advanced by distance travelled so stride never skates
    sp = Math.hypot(s.velocity.x, s.velocity.z);
    this.distanceTravelled += this.prevPos.distanceTo(s.position);
    this.speed01 = THREE.MathUtils.clamp(sp / SPRINT, 0, 1);
    // cadence: ~1.6 steps/s at a stroll up to ~3.8 flat out
    const freq = sp < 0.05 ? 0 : THREE.MathUtils.clamp(0.58 + sp * 0.195, 0.58, 1.98);
    this.gaitFreq = freq;
    this.strideAmp = sp > 0.05 ? (sp / (2 * freq)) * 0.5 : 0;
    if (s.grounded) this.gaitPhase = (this.gaitPhase + freq * h) % 1;

    this._steerBody(h, sp);

    // acceleration for lean + cloth
    _v3.copy(s.velocity).sub(this._prevVel).multiplyScalar(1 / h);
    this._accel.lerp(_v3, 0.25);
    this._prevVel.copy(s.velocity);

    this._idleT += h;
    this._breath += h * (0.28 + this.speed01 * 0.5);
    this._footstepCheck();
  }

  /**
   * The body does not point where the mouse points.
   *
   * Moving, it turns to face the direction of travel. Standing, it holds its
   * ground while you look around, and only breaks and squares up once the
   * aim has swung more than about 65 degrees off the shoulders — which is what
   * makes a still character read as a person rather than as a gun turret.
   */
  _steerBody(h, sp) {
    let want, rate;
    // Down the sights the shoulders square up on the aim — you cannot shoot
    // across your own chest, and the rifle pose is wrong if you try.
    if (this.weapon && this.weapon.aim01 > 0.15) {
      const d0 = angWrap(this.yaw - this.bodyYaw);
      this.bodyYaw = angWrap(this.bodyYaw
        + THREE.MathUtils.clamp(d0, -9.0 * h, 9.0 * h));
      this._turningIdle = false;
      return;
    }
    if (sp > 0.35) {
      want = this.moveYaw;
      rate = 7.0 + 4.5 * this.speed01;
      this._turningIdle = false;
    } else {
      const off = angWrap(this.yaw - this.bodyYaw);
      if (Math.abs(off) > 1.14) this._turningIdle = true;
      if (Math.abs(off) < 0.11) this._turningIdle = false;
      want = this._turningIdle ? this.yaw : this.bodyYaw;
      rate = 3.4;
    }
    const d = angWrap(want - this.bodyYaw);
    this.bodyYaw = angWrap(this.bodyYaw + THREE.MathUtils.clamp(d, -rate * h, rate * h));
  }

  /**
   * Nothing may trap the player. If movement is being asked for and we have
   * gone essentially nowhere for a second and a half, slide sideways along the
   * obstruction until we are clear — corners between two convex proxies are the
   * only geometry in this world that can hold a capsule, and they let go the
   * moment you stop pushing straight into them.
   */
  _antiStuck(h, moving, target) {
    const s = this.state;
    if (!moving || target < 0.05) { this._stuckT = 0; this._stuckFrom.copy(s.position); this._unstick = 0; return; }
    this._stuckT += h;
    if (this._stuckT < 1.5) return;
    const gone = _v2.set(s.position.x - this._stuckFrom.x, 0, s.position.z - this._stuckFrom.z).length();
    this._stuckT = 0;
    this._stuckFrom.copy(s.position);
    if (gone > 0.35) { this._unstick = 0; return; }
    this._unstick = this._unstick ? -this._unstick : 1;   // try one side, then the other
    const a = this.moveYaw + this._unstick * Math.PI * 0.5;
    s.position.x += Math.sin(a) * 0.55;
    s.position.z += Math.cos(a) * 0.55;
    s.position.y = Math.max(s.position.y, this.ctx.world.getHeight(s.position.x, s.position.z));
  }

  _footstepCheck() {
    if (this.mode === 'mounted' || this.gaitFreq <= 0) return;
    for (let i = 0; i < 2; i++) {
      const ph = (this.gaitPhase + i * 0.5) % 1;
      const down = ph < 0.62;
      if (down && !this._lastFootDown[i]) {
        const surf = this.ctx.world.getSurface(this.state.position.x, this.state.position.z);
        let name = 'dirt', bestW = -1;
        for (const key in surf) if (surf[key] > bestW) { bestW = surf[key]; name = key; }
        this.ctx.emit('footstep', {
          position: this.state.position.clone(),
          surface: name,
          weights: surf,
          speed: this.speed01,
          foot: i ? 'right' : 'left',
        });
      }
      this._lastFootDown[i] = down;
    }
  }

  /* ================================================================ update */

  update(dt) {
    const ctx = this.ctx;
    // interpolate the fixed-step position for rendering
    const a = this.physics ? this.physics.alpha : 1;
    this.renderPos.lerpVectors(this.prevPos, this.state.position, a);

    // Advance the knife BEFORE the pose, so the blend and the stroke phase the
    // arms are solved against are this frame's, not last frame's.
    this._stepSkin(dt);

    if (this.trans) this._poseTransition(dt);
    else if (this.mode === 'mounted') { this.mountBlend = 1; this._poseMounted(dt); }
    else { this.mountBlend = 0; this._pose(dt, false); }

    this._writeCtx();
    this._interact(dt);
    this._updateCloth(dt);
    this.wanted.update(dt);
  }

  /**
   * Cloth state: rain wets the duster, and the shader's millimetre detail
   * bands are switched off once the figure is small enough that they cost
   * bandwidth for sub-pixel noise.
   */
  _updateCloth() {
    const wet = this.ctx.env.wetness || 0;
    const d = this.ctx.camera.position.distanceTo(this.renderPos);
    const detail = THREE.MathUtils.clamp(1.25 - d / 26, 0.25, 1.0);
    for (const m of [this.matSolid, this.matCloth]) {
      if (!m || !m.userData.rsCharUniforms) continue;
      const u = m.userData.rsCharUniforms;
      u.uCharWet.value = wet;
      u.uCharDetail.value = detail;
    }
  }

  /**
   * DOWN THE SIGHTS, RE-SOLVE AFTER THE CAMERA.
   *
   * Player runs before CameraRig, so the shouldered pose was built against the
   * PREVIOUS frame's lens. Standing still that is invisible; measured on a
   * 90 deg/s pan it left the barrel 2.1 degrees off the reticle the player was
   * looking down — one frame of pipeline, but a whole frame of it, and the one
   * thing the eye is guaranteed to be watching while aiming. Engine runs every
   * update() before any lateUpdate(), so by here the lens is final: re-solve
   * the weapon and re-run the arm IK against it.
   *
   * Only when the hands are fully committed (gripBlend ~1), where the solve is
   * idempotent — at a partial blend a second pass would double-count the lerp.
   */
  lateUpdate(dt) {
    const W = this.weapon;
    if (!W || this.trans || this.skinning || W.aim01 < 0.985 || W.gripBlend < 0.995) return;
    const camRig = this.ctx.get('camera');
    if (!camRig || camRig.freeCam) return;
    W._solve(dt || 1 / 60);
    _fwd.set(Math.sin(this.bodyYaw), 0, Math.cos(this.bodyYaw));
    _rgt.set(-_fwd.z, 0, _fwd.x);
    this._poseWeapon(dt, _fwd, _rgt);
    this.rig.sync();
  }

  /**
   * Skinning. E is also the mount key, so the carcass only wins when it is
   * genuinely the nearer of the two — otherwise walking past your horse with a
   * dead deer at your feet would do something you did not ask for.
   */
  _interact(dt) {
    void dt;
    const W = this.ctx.get('wildlife');
    this.carcass = null;
    this.pickup = null;
    if (this.skinning || this.mode !== 'onFoot') return;
    /* A pelt lying at your boots outranks the carcass beside it — otherwise
     * the moment you finish skinning something the prompt offers to skin the
     * next one and the thing you just made is unreachable. */
    let bd = 2.4 * 2.4;
    for (const d of this._drops) {
      const dx = d.mesh.position.x - this.state.position.x;
      const dz = d.mesh.position.z - this.state.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; this.pickup = d; }
    }
    if (this.pickup) return;
    if (!W || !W.nearestCarcass) return;
    const c = W.nearestCarcass(this.state.position, 2.6);
    if (!c) return;
    const horse = this.ctx.get('horse');
    if (horse && horse.state) {
      const dh = this.state.position.distanceTo(horse.state.position);
      if (dh < 4.8 && dh < this.state.position.distanceTo(c.agent.pos)) return;
    }
    this.carcass = c;
  }

  /* ------------------------------------------------------------- skinning */

  /**
   * SKINNING, AS AN ACTION RATHER THAN AS A DELETION.
   *
   * Before this pass, E on a carcass made it vanish on the same frame. Nothing
   * about that reads as taking a hide off an animal — the player performs no
   * work, sees no work, and the world silently loses an object.
   *
   * So it is a real interaction with all four of the things an interaction
   * needs: a COMMITMENT (movement is dead for its duration), a DURATION you can
   * see going by (the ring, the knife, the cuts), a way OUT of it (any
   * movement key cancels, and you keep nothing), and a RESULT that persists in
   * the world (a rolled hide on the ground you then have to pick up).
   *
   * The kneel is not a new animation clip — there are none in this project. It
   * is the existing locomotion pose driven off its own blend: the pelvis drops
   * 0.30 m below the crouch, the stance foot slides back under the hips so the
   * leg IK folds into a knee-down, the spine and neck pitch over the work, and
   * both arms leave the rifle for world sockets on the carcass, the right one
   * sawing. Everything downstream — foot IK onto the terrain, contact shadow,
   * coat and hat springs — keeps running, so the kneel inherits the ground
   * conformance and the secondary motion for free.
   */
  _buildSkinKit() {
    const ctx = this.ctx;
    const sky = ctx.get('sky');
    const lighting = ctx.get('lighting');

    const paint = (g, col) => {
      const n = g.attributes.position.count;
      const c = new Float32Array(n * 3);
      const pos = g.attributes.position;
      for (let i = 0; i < n; i++) {
        const k = 1 + Math.sin(pos.getX(i) * 53.1 + pos.getY(i) * 31.7) * 0.07;
        c[i * 3] = col[0] * k; c[i * 3 + 1] = col[1] * k; c[i * 3 + 2] = col[2] * k;
      }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      return g;
    };
    const box = (w, h, d, x, y, z, col, rx = 0) => {
      const g = new THREE.BoxGeometry(w, h, d);
      if (rx) g.rotateX(rx);
      g.translate(x, y, z);
      return paint(g, col);
    };

    /* ---- the knife -------------------------------------------------------
     * Parented to the right hand BONE, so it inherits the arm IK for nothing.
     * The rig aims a hand's local −Y at the fingertips (see _armToSocket), so
     * the blade runs down −Y out of the fist. Hidden unless it is in use: one
     * draw call, and only while the player is actually holding it. */
    const steel = [0.44, 0.46, 0.50];
    const horn = [0.052, 0.036, 0.026];
    const knifeGeo = mergeGeometries([
      box(0.0225, 0.155, 0.0042, 0, -0.128, 0.004, steel),   // blade
      box(0.011, 0.020, 0.0090, 0, -0.049, 0.004, [0.30, 0.31, 0.33]), // bolster
      box(0.0195, 0.082, 0.0175, 0, -0.004, 0.004, horn),    // scale handle
    ], false);
    /* Roughness 0.46 / metalness 0.45: at 0.36/0.62 the blade mirrored the sky
     * and read as a strip of blue plastic at the one distance the player ever
     * sees it from. A worn skinning knife is satin, not chrome. */
    this.matKnife = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.46, metalness: 0.45, dithering: true, name: 'knife',
    });
    if (sky && sky.injectAerialPerspective) sky.injectAerialPerspective(this.matKnife);
    this.knife = new THREE.Mesh(knifeGeo, this.matKnife);
    this.knife.name = 'skinningKnife';
    this.knife.castShadow = true;
    this.knife.receiveShadow = true;
    this.knife.frustumCulled = false;
    this.knife.visible = false;
    this.knife.position.set(HAND_MESH.x * -1, HAND_MESH.y, HAND_MESH.z);
    const handR = this.rig.get('handR');
    if (handR) handR.add(this.knife); else this.group.add(this.knife);
    if (lighting && lighting.requestShadowCaster) lighting.requestShadowCaster(this.knife);

    /* ---- the pelt that gets left behind ---------------------------------
     * A rolled hide tied at both ends with a bundle of meat beside it. One
     * shared material and one shared geometry; each drop is an instance of
     * position only, so N pelts on the ground is N cheap draw calls and there
     * are never more than DROP_MAX of them. */
    const hide = [0.062, 0.041, 0.026];
    const hideDark = [0.030, 0.020, 0.013];
    const meat = [0.075, 0.021, 0.018];
    const roll = new THREE.CylinderGeometry(0.115, 0.105, 0.42, 9, 1, false);
    roll.rotateZ(Math.PI * 0.5);
    roll.translate(0, 0.112, 0);
    this.geoPelt = mergeGeometries([
      paint(roll, hide),
      box(0.055, 0.028, 0.245, -0.135, 0.118, 0, hideDark),   // thong, near end
      box(0.055, 0.028, 0.245, 0.140, 0.118, 0, hideDark),    // thong, far end
      box(0.16, 0.085, 0.20, 0.055, 0.046, 0.245, meat, 0.2), // the meat
    ], false);
    this.matPelt = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.88, metalness: 0.0, dithering: true, name: 'pelt',
    });
    if (sky && sky.injectAerialPerspective) sky.injectAerialPerspective(this.matPelt);
  }

  /**
   * E on a carcass. Anchors the player beside it and hands the next two and a
   * half seconds to the animation.
   */
  _beginSkin() {
    if (this.skinning || this.trans || !this.carcass) return;
    const c = this.carcass;
    const cp = c.agent.pos;
    const gy = this.ctx.world.getHeight(cp.x, cp.z);
    // Kneel on the side you walked up from — never teleport round the animal.
    _v.set(this.state.position.x - cp.x, 0, this.state.position.z - cp.z);
    if (_v.lengthSq() < 1e-4) _v.set(0.8, 0, 0);
    _v.normalize();
    /*
     * 0.62 m, not 0.74 — and that number is set by the ARM, not by taste. The
     * shoulder joint of a kneeling figure sits ~0.29 m forward of his root and
     * ~0.85 m up; the arm is 0.566 m from shoulder to wrist. Anchoring further
     * out than this puts the cut line outside the reach envelope, _armToSocket
     * clamps at REACH_MAX, and both arms lock out dead straight — which is
     * exactly the "reaching for a suitcase" the first cut of this looked like.
     */
    this._skinAnchor.set(cp.x + _v.x * 0.62, gy, cp.z + _v.z * 0.62);
    this._skinYaw = Math.atan2(-_v.x, -_v.z);          // face the carcass
    this.skinning = {
      t: 0, dur: 2.6, species: c.species, carcass: c,
      point: new THREE.Vector3(cp.x, gy, cp.z),
    };
    this._cutT = 0;
    /* Put the rifle away for the duration — both hands are about to be busy,
     * and a carbine held at low ready through a kneel is exactly the sort of
     * thing that reads as a bug. */
    const W = this.weapon;
    if (W) { W._wantAim = false; W._triggerHeld = false; W._holdT = 99; }
    const A = this.ctx.get('audio');
    if (A && A.play) A.play('leather', { position: this.state.position, volume: 0.7, pitch: 1.1 });
  }

  /** Movement, a shot, or getting on the horse all abandon it. */
  _cancelSkin(reason) {
    if (!this.skinning) return;
    this.skinning = null;
    this._cutT = 0;
    const hud = this.ctx.get('hud');
    if (hud && hud.notify && reason) hud.notify(reason);
  }

  /**
   * Advance the interaction. Runs from update() so it is on the render clock
   * (the progress ring has to be smooth), not the 60 Hz physics step.
   */
  _stepSkin(dt) {
    const want = this.skinning ? 1 : 0;
    this._skinBlend += (want - this._skinBlend)
      * (1 - Math.exp(-(want ? 7.5 : 5.0) * (dt || 1 / 60)));
    if (this.knife) this.knife.visible = this._skinBlend > 0.06;
    const sk = this.skinning;
    if (!sk) return;

    sk.t += dt;
    /* One knife stroke roughly every 0.62 s, on the render clock so it stays
     * in step with the arm that is making it. Audio owns the sound; this owns
     * only the beat it happens on. */
    this._cutT += dt;
    if (this._cutT > 0.62 && sk.t < sk.dur - 0.25) {
      this._cutT = 0;
      const A = this.ctx.get('audio');
      if (A && A.play) A.play('knife', { position: sk.point, volume: 0.9 });
    }
    if (sk.t >= sk.dur) this._finishSkin();
  }

  /** The hide comes off, the carcass goes, and something is left in its place. */
  _finishSkin() {
    const sk = this.skinning;
    const W = this.ctx.get('wildlife');
    this.skinning = null;
    this._cutT = 0;
    if (!sk) return;
    if (W && W.collect) W.collect(sk.carcass);
    this._dropPelt(sk.point, sk.species);
    const hud = this.ctx.get('hud');
    if (hud && hud.notify) hud.notify(`${sk.species} skinned`);
    const A = this.ctx.get('audio');
    if (A && A.play) {
      A.play('knife', { position: sk.point, volume: 1.0 });
      A.play('leather', { position: sk.point, volume: 1.0, at: A.now() + 0.22 });
    }
  }

  _dropPelt(point, species) {
    if (!this.geoPelt) return;
    const mesh = new THREE.Mesh(this.geoPelt, this.matPelt);
    mesh.name = 'pelt';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const gy = this.ctx.world.getHeight(point.x, point.z);
    mesh.position.set(point.x, gy, point.z);
    mesh.rotation.y = this._skinYaw + 1.1;
    this.ctx.scene.add(mesh);
    const lighting = this.ctx.get('lighting');
    if (lighting && lighting.requestShadowCaster) lighting.requestShadowCaster(mesh);
    this._drops.push({ mesh, label: `${species} pelt` });
    // Hard cap: the ground is not a warehouse and every one of these is a
    // draw call that nobody is looking at any more.
    while (this._drops.length > DROP_MAX) {
      const old = this._drops.shift();
      this.ctx.scene.remove(old.mesh);
    }
  }

  _takePickup() {
    const d = this.pickup;
    if (!d) return;
    const i = this._drops.indexOf(d);
    if (i >= 0) this._drops.splice(i, 1);
    this.ctx.scene.remove(d.mesh);
    this.pickup = null;
    this.peltsCarried++;
    const hud = this.ctx.get('hud');
    if (hud && hud.notify) hud.notify(`${d.label} stowed`);
    const A = this.ctx.get('audio');
    if (A && A.play) A.play('leather', { position: this.state.position, volume: 0.85 });
  }

  /**
   * Both hands onto the carcass, and the right one working.
   *
   * Runs AFTER _poseWeapon so it wins outright: the rifle's grip blend is
   * already collapsing (the weapon was told to sling itself when the kneel
   * started) and this simply re-solves the same two arms onto sockets that are
   * on the animal instead of on the wood.
   */
  _poseSkin(fwd, rgt, w) {
    const sk = this.skinning;
    const pt = sk ? sk.point : this._skinAnchor;
    // saw along the body: a slow draw out, a quicker return, never symmetric
    const ph = this._cutT / 0.62;
    const saw = Math.sin(ph * Math.PI * 2) * 0.5 + Math.sin(ph * Math.PI * 4) * 0.12;
    const press = 0.02 * Math.cos(ph * Math.PI * 2);

    /* Height 0.40, not ground level: a deer on its side is knee-high, and the
     * cut runs along the belly — putting the hands on the dirt both looked
     * wrong and pulled the wrists out past the end of the arm. */
    _tgt.copy(pt)
      .addScaledVector(fwd, -0.24 + saw * 0.15)
      .addScaledVector(rgt, -0.11)
      .addScaledVector(UP, 0.40 + press);
    _v2.copy(fwd).multiplyScalar(0.24).addScaledVector(UP, -0.94).normalize();
    _v3.copy(rgt).multiplyScalar(-0.85).addScaledVector(UP, -0.30)
      .addScaledVector(fwd, -0.42).normalize();
    _fb.copy(fwd).multiplyScalar(-0.5).addScaledVector(rgt, -0.6).addScaledVector(UP, -0.6)
      .normalize();
    this._armToSocket('R', _tgt, _v2, _v3, w, _fb);

    _tgt2.copy(pt)
      .addScaledVector(fwd, -0.26)
      .addScaledVector(rgt, 0.16)
      .addScaledVector(UP, 0.42 - press * 0.4);
    _v2.copy(fwd).multiplyScalar(0.10).addScaledVector(UP, -0.99).normalize();
    _v3.copy(rgt).multiplyScalar(0.80).addScaledVector(UP, -0.42)
      .addScaledVector(fwd, -0.42).normalize();
    _fb.copy(fwd).multiplyScalar(-0.5).addScaledVector(rgt, 0.6).addScaledVector(UP, -0.6)
      .normalize();
    this._armToSocket('L', _tgt2, _v2, _v3, w, _fb);
  }

  _writeCtx() {
    const p = this.ctx.player;
    p.position.copy(this.renderPos);
    p.velocity.copy(this.state.velocity);
    p.yaw = this.yaw;
    // Never leak 'mounting'/'dismounting' — every reader tests === 'mounted'.
    p.mode = this.publicMode = this.trans ? this.publicMode : this.mode;
    p.speed01 = this.speed01;
    /*
     * Additions for Wildlife's perception model (see SENSE in Wildlife.js).
     * `noise` is how loud we are being — this is the single number that decides
     * whether a herd hears you coming, so it is worth getting the shape right:
     * crouching is genuinely quiet, a walk is audible up close, and a sprint or
     * a gallop can be heard across a valley.
     */
    p.crouch = this.crouch;
    p.aiming = !!(this.weapon && this.weapon.aiming);
    const sp = Math.hypot(this.state.velocity.x, this.state.velocity.z);
    if (this.publicMode === 'mounted') {
      p.noise = 0.55 + this.speed01 * 1.75;
    } else {
      p.noise = (0.10 + sp * 0.235) * (1 - this.crouch * 0.72);
    }
    const town = this.ctx.poi.get('town');
    if (town) {
      const tp = town.pos || town;
      p.inTown = _v.set(tp.x - p.position.x, 0, tp.z - p.position.z).length() < 110;
    }
  }

  /* ------------------------------------------------------------- animation */

  _pose(dt, instant) {
    const rig = this.rig;
    const world = this.ctx.world;
    const env = this.ctx.env;
    rig.reset();

    const sp01 = this.speed01;
    const walkBlend = smoothstep(0.02, 0.28, sp01);
    const runBlend = smoothstep(0.32, 0.85, sp01);
    const ph = this.gaitPhase * Math.PI * 2;
    const yaw = this.bodyYaw;
    // How far the eyes are off the shoulders — he looks where you look.
    const aimOff = THREE.MathUtils.clamp(angWrap(this.yaw - yaw), -1.25, 1.25);
    const fwd = _fwd.set(Math.sin(yaw), 0, Math.cos(yaw)).clone();
    const rgt = _rgt.set(-fwd.z, 0, fwd.x).clone();

    /* ---- stride geometry: local foot positions relative to the pelvis ---- */
    const amp = this.strideAmp;
    const stance = 0.62;
    const foot = [];
    for (let i = 0; i < 2; i++) {
      const p = (this.gaitPhase + i * 0.5) % 1;
      let z, lift;
      if (p < stance) {
        const t = p / stance;
        z = amp * (1 - 2 * t);
        lift = 0;
      } else {
        const t = (p - stance) / (1 - stance);
        const e = t * t * (3 - 2 * t);
        z = -amp + 2 * amp * e;
        lift = Math.sin(t * Math.PI) * (0.055 + 0.16 * runBlend + amp * 0.30);
      }
      // i === 0 is the LEFT foot, which sits on the -right side
      const xOff = (i === 0 ? -1 : 1) * (0.098 - runBlend * 0.028);
      foot.push({ x: xOff, z, lift, phase: p });
    }

    /*
     * ---- the kneel -------------------------------------------------------
     * A skinning kneel is a stance, not a clip: pull the RIGHT foot back under
     * the hips and splay the left one forward, and the existing two-bone leg
     * IK folds the right leg into a knee-down all by itself once the pelvis
     * drops. Everything else in this function — terrain conformance, the
     * contact shadow, the coat springs — then applies to it unchanged.
     */
    const kneel = this._skinBlend;
    if (kneel > 0.001) {
      /* Right foot back UNDER the hips and up on the ball of the foot, left
       * foot forward and flat. With the pelvis 0.50 m down (below) that is a
       * hip-to-ankle span of half a metre against an 0.85 m leg, so the rear
       * knee folds to about 110 degrees and the figure is genuinely down on
       * its haunches rather than stooping at the waist — which is what the
       * first cut looked like, and it read as a man bending over a suitcase. */
      foot[1].z -= kneel * 0.34;
      foot[1].x += kneel * 0.075;
      foot[1].lift = kneel * 0.055;
      foot[0].z += kneel * 0.22;
      foot[0].x -= kneel * 0.060;
      foot[0].lift *= 1 - kneel;
    }

    /* ---- pelvis --------------------------------------------------------- */
    const base = this.renderPos;
    const groundL = world.getHeight(
      base.x + rgt.x * foot[0].x + fwd.x * foot[0].z,
      base.z + rgt.z * foot[0].x + fwd.z * foot[0].z);
    const groundR = world.getHeight(
      base.x + rgt.x * foot[1].x + fwd.x * foot[1].z,
      base.z + rgt.z * foot[1].x + fwd.z * foot[1].z);
    const stanceY = Math.max(groundL - foot[0].lift, groundR - foot[1].lift);

    // vertical bob: two peaks per cycle, plus a landing dip after each plant
    const bob = -Math.abs(Math.cos(ph)) * (0.018 + 0.055 * runBlend) * walkBlend;
    const breathe = Math.sin(this._breath * Math.PI * 2) * 0.008 * (1 - walkBlend);
    const crouchDrop = this.crouch * 0.34;

    // idle weight shift: a slow 7 s contrapposto so a still frame never reads
    // as a mannequin standing to attention
    const idleShift = Math.sin(this._idleT * 0.90) * 0.5 + Math.sin(this._idleT * 0.37) * 0.5;
    const idle = 1 - walkBlend;
    const hipSide = idleShift * 0.022 * idle + Math.sin(ph) * 0.020 * walkBlend;

    // Sit the pelvis 24 mm below the fully-extended leg length: standing with
    // both knees locked at the IK singularity is both unnatural and the one
    // configuration where the knee pole can flip.
    const hipY = PROP.hipY - 0.024 - crouchDrop + bob + breathe - kneel * 0.50;
    this.group.position.set(base.x, stanceY, base.z);
    this.group.rotation.set(0, yaw, 0);
    // The IK below works in world space, so the group transform has to be live
    // this frame — the renderer only refreshes matrices after every update().
    this.group.updateMatrixWorld(true);

    rig.trs('hips', hipSide, hipY - PROP.hipY, 0);
    // pelvis: roll into the weighted leg, yaw opposite the shoulders
    const pelvisRoll = -idleShift * 0.075 * idle + Math.sin(ph) * 0.085 * walkBlend;
    const pelvisYaw = -Math.sin(ph) * (0.10 + 0.16 * runBlend) * walkBlend;
    const pelvisPitch = 0.035 + runBlend * 0.10 + this.crouch * 0.20 + kneel * 0.24;
    /*
     * BLADED STANCE. Nobody shoots square-on: you turn your firing side back so
     * the shoulder comes round behind the butt. Squared up, the butt plate ends
     * up a third of a metre behind the shoulder joint with nothing under it,
     * which is exactly what the first pass looked like from the side.
     */
    const blade = this.weapon ? this.weapon.aim01 : 0;
    rig.rot('hips', pelvisPitch, pelvisYaw - blade * 0.22, pelvisRoll);

    /* ---- spine: lean into acceleration, counter-rotate the shoulders ----- */
    const localAccel = _v.set(this._accel.x, 0, this._accel.z);
    const leanF = THREE.MathUtils.clamp(localAccel.dot(fwd) * 0.020, -0.16, 0.22)
      + runBlend * 0.13;
    const leanS = THREE.MathUtils.clamp(-localAccel.dot(rgt) * 0.016, -0.14, 0.14);
    this._lean.lerp(_v2.set(leanF, leanS, 0), instant ? 1 : Math.min(1, dt * 6));
    rig.rot('spine', this._lean.x * 0.55 - 0.02 + blade * 0.10 + kneel * 0.20,
      -pelvisYaw * 0.55 - blade * 0.16, this._lean.y * 0.6 - pelvisRoll * 0.35);
    rig.rot('chest',
      this._lean.x * 0.35 + Math.sin(this._breath * Math.PI * 2) * 0.012 - 0.015 + blade * 0.06
        + kneel * 0.17,
      -pelvisYaw * 1.05 - 0.14 * idle + aimOff * 0.16 - blade * 0.14,
      this._lean.y * 0.4 - pelvisRoll * 0.30);

    /* ---- head stabilisation --------------------------------------------- */
    // At rest he is half-turned toward the horse — a figure squared up to the
    // lens reads as a mannequin, a three-quarter turn reads as a person.
    const headYawIdle = -0.30 + Math.sin(this._idleT * 0.21) * 0.20
      + Math.sin(this._idleT * 0.077) * 0.13;
    // The aim offset is split neck/head so a big look-round turns the whole
    // upper body a little rather than snapping the skull round on the spine.
    // the neck brings the eye back onto the bore that the bladed torso just
    // turned away from, and cranes it forward over the comb
    rig.rot('neck', -this._lean.x * 0.35 - bob * 1.2 - 0.02 + blade * 0.16 + kneel * 0.20,
      pelvisYaw * 0.55 + headYawIdle * idle * 0.35 + aimOff * 0.30 + blade * 0.30,
      -this._lean.y * 0.25);
    // Cheek weld: with the sights up the head cants over onto the comb and the
    // eye drops to the sight line. Without it the face floats above the stock.
    const weld = this.weapon ? this.weapon.aim01 : 0;
    rig.rot('head',
      THREE.MathUtils.clamp(this.pitch * 0.45, -0.35, 0.30) * (1 - kneel)
        - this._lean.x * 0.30 + 0.02 + weld * 0.10 + kneel * 0.42,
      pelvisYaw * 0.35 + headYawIdle * idle * 0.65 + aimOff * 0.52,
      -this._lean.y * 0.20 + idleShift * 0.03 * idle - weld * 0.16);

    /*
     * ---- the weapon solves against the LIVE torso ------------------------
     * This call USED to run before the spine was touched, so the carry poses
     * were hung off the bind-pose chest and the carbine visibly lagged the
     * body — the "floats relative to the torso" in the report. It has to come
     * after the neck/head block (the cheek weld moves the aiming eye) and
     * before the arms, which are IK'd onto whatever it leaves behind.
     */
    if (this.weapon) {
      this._weaponAnchors(blade);
      this.weapon.update(dt || 1 / 60);
    }

    /* ---- arms ------------------------------------------------------------ */
    // contralateral swing; at idle the left thumb hooks the gunbelt
    const swing = Math.sin(ph) * (0.42 + 0.55 * runBlend) * walkBlend;
    const elbow = 0.26 + 0.80 * runBlend * walkBlend;
    for (const [L, sgn] of [['L', 1], ['R', -1]]) {
      const s = sgn > 0 ? 1 : -1;
      const armSwing = -swing * s;
      // at rest the left thumb hooks the gunbelt, the right hand hangs by the
      // holster — arms stay close to the body, never gesturing
      const hook = idle * (L === 'L' ? 1 : 0.42);
      rig.rot('clav' + L, -0.02 * walkBlend, 0, s * 0.014);
      rig.rot('arm' + L,
        armSwing - 0.045 - hook * 0.14 + this.crouch * 0.10,
        s * (0.02 + hook * 0.05),
        s * (0.038 + 0.032 * runBlend + hook * 0.055 + idleShift * 0.012));
      rig.rot('fore' + L,
        -(elbow + Math.max(0, armSwing) * 0.50 + hook * 0.66),
        0,
        s * (0.03 + hook * 0.11));
      rig.rot('hand' + L, hook * 0.22 - 0.05, 0, -s * (0.06 + hook * 0.20));
    }

    /* ---- rifle: both hands are posed ONTO the weapon --------------------- */
    if (this.weapon) this._poseWeapon(dt, fwd, rgt);
    /* ---- …unless there is a knife in one of them ------------------------ */
    if (kneel > 0.004) this._poseSkin(fwd, rgt, kneel);

    /* ---- coat + hat secondary motion ------------------------------------ */
    this._cloth3(dt || 1 / 60, fwd, rgt, walkBlend, runBlend, ph, env);

    /* ---- legs: two-bone IK onto the terrain ----------------------------- */
    rig.sync();
    const ankleTargets = [];
    for (let i = 0; i < 2; i++) {
      const L = i === 0 ? 'L' : 'R';
      const wx = base.x + rgt.x * foot[i].x + fwd.x * foot[i].z;
      const wz = base.z + rgt.z * foot[i].x + fwd.z * foot[i].z;
      const gy = world.getHeight(wx, wz);
      const ay = gy + PROP.ankleY + foot[i].lift;
      const ankle = new THREE.Vector3(wx, ay, wz);
      // pole: knee points forward, splayed slightly outward
      _v2.copy(fwd).addScaledVector(rgt, i === 0 ? -0.16 : 0.16).normalize();
      rig.ik2('thigh' + L, 'shin' + L, PROP.legL1, PROP.legL2, ankle, _v2);
      ankleTargets.push(ankle);
      this._footY[i] = gy;

      // foot roll: heel strike -> flat -> toe off
      const p = foot[i].phase;
      let footPitch;
      if (p < 0.10) footPitch = -0.34 * (1 - p / 0.10);
      else if (p < 0.44) footPitch = 0;
      else if (p < stance) footPitch = 0.62 * ((p - 0.44) / (stance - 0.44)) * (0.5 + runBlend);
      else footPitch = 0.34 - 0.62 * ((p - stance) / (1 - stance));
      footPitch *= walkBlend;
      // Kneeling: the rear foot rolls onto its ball, the front one stays flat.
      if (i === 1) footPitch += kneel * 0.62;

      // The sole lies on the ground plane when planted: the foot bone's local
      // -Y (world down in bind pose) is aimed at -groundNormal, then rolled
      // through the heel-strike / toe-off arc.
      const planted = p < stance ? 1 : 0;
      world.getNormal(wx, wz, _v3);
      const soleDir = new THREE.Vector3(0, -1, 0).lerp(_v3.multiplyScalar(-1), planted * 0.85).normalize();
      soleDir.applyAxisAngle(rgt, footPitch);
      const footBone = rig.get('foot' + L);
      footBone.updateWorldMatrix(true, false);
      rig.aimWorld(footBone, soleDir, fwd);
      footBone.updateWorldMatrix(false, false);
    }

    rig.sync();
    this._updateContact(ankleTargets, foot, walkBlend);
    this._updateVisibility();
  }

  /**
   * Publish the LIVE torso to the weapon: chest bone (both carry poses hang
   * off it), and the aiming eye, which is the head bone plus a fixed offset in
   * the body frame. Taking the eye off the head BONE rather than off the root
   * is what welds the cheek to the comb through the gait bob and the crouch.
   */
  _weaponAnchors(blade, frameQ) {
    const rig = this.rig;
    rig.sync();
    const chest = rig.get('chest');
    chest.updateWorldMatrix(true, false);
    _anchorPos.setFromMatrixPosition(chest.matrixWorld);
    _anchorQ.setFromRotationMatrix(chest.matrixWorld);
    const head = rig.get('head');
    head.updateWorldMatrix(true, false);
    _eye.setFromMatrixPosition(head.matrixWorld);
    /*
     * Right eye, forward of the head bone. Shouldering CRANES THE HEAD OVER
     * THE COMB: forward for eye relief, outboard toward the firing shoulder,
     * and down onto the stock. That last pair is what drops the butt out of
     * the middle of his chest and into the shoulder pocket where it belongs —
     * with the eye left at standing height the sight line ran across his face
     * and the whole carbine rode 5 cm too high.
     */
    const bl = blade || 0;
    /*
     * That offset is a statement about the SHOOTING frame — right eye, craned
     * outboard and forward over the comb — so it has to be expressed in the
     * frame the shooter is facing. On foot the group IS that frame (the body
     * squares onto the aim as soon as the sights come up), so callers pass
     * nothing and this is unchanged. In the saddle the group is the SADDLE, and
     * feeding the horse's heading in here swung the eye — and with it the whole
     * carbine — sideways the moment you looked off the animal's ears.
     */
    const q = frameQ || this.group.quaternion;
    _v.set(-0.044 - bl * 0.054, 0.050 - bl * 0.052, 0.014 + bl * 0.070)
      .applyQuaternion(q);
    _eye.add(_v);
    this.weapon.setAnchors(_anchorPos, _anchorQ, _eye, q);
  }

  /**
   * TWO-BONE ARM IK ONTO A WORLD SOCKET.
   *
   * `dir` is where the hand lies (wrist -> fingertips) and `pole` is where the
   * elbow is thrown; both come out of the weapon's own frame so they stay
   * correct at any weapon orientation. `w` fades the whole thing out of
   * whatever the natural swing pose had just produced, target AND pole AND
   * wrist roll together — blending only the target re-solves the elbow against
   * the shooting pole at any weight, which snaps.
   *
   * Two joint limits, both of which are instantly readable when they are
   * missing: the target is pulled in to REACH_MAX of full extension so the arm
   * can never lock straight or silently fall short of the wood, and the pole is
   * rejected if it has gone parallel to the limb axis, which is the one
   * configuration where the elbow can invert.
   */
  _armToSocket(L, palm, dir, pole, w, fallbackPole) {
    const rig = this.rig;
    const l1 = PROP.armL1, l2 = PROP.armL2;
    const sgn = L === 'L' ? 1 : -1;
    const hand = rig.get('hand' + L);
    const shoulder = rig.get('arm' + L);
    const elbow = rig.get('fore' + L);
    hand.updateWorldMatrix(true, false);
    shoulder.updateWorldMatrix(true, false);
    elbow.updateWorldMatrix(true, false);

    /*
     * PALM, NOT WRIST. The IK solves the hand BONE, but the hand mesh hangs
     * 3.5 cm outboard and 4.9 cm down from that joint (HAND_MESH, straight out
     * of HumanRig). Solving the joint onto the wood is why the last pass ran
     * the stock clean through the middle of the fist. Build the hand's world
     * basis first — it is fully determined by dir and pole, both of which come
     * out of the weapon — and back the mesh offset out of the target.
     */
    _hy.copy(dir).normalize().multiplyScalar(-1);
    _hz.copy(pole).addScaledVector(_hy, -pole.dot(_hy));
    if (_hz.lengthSq() < 1e-8) _hz.set(0, 0, 1).addScaledVector(_hy, -_hy.z);
    _hz.normalize();
    _hx.crossVectors(_hy, _hz).normalize();
    _wr.copy(palm)
      .addScaledVector(_hx, -HAND_MESH.x * sgn)
      .addScaledVector(_hy, -HAND_MESH.y)
      .addScaledVector(_hz, -HAND_MESH.z);

    /*
     * The GOAL is the blended one, not the socket. Correcting toward the raw
     * socket while the blend was only a quarter of the way in overshot the
     * target by 20 cm in a single frame — a visible snap at exactly the weight
     * where the correction switched on. Measure the natural hand centre first
     * and interpolate the goal with the same weight everything else uses.
     */
    _hp.setFromMatrixPosition(hand.matrixWorld);
    _hqw.setFromRotationMatrix(hand.matrixWorld);
    _goal.set(HAND_MESH.x * sgn, HAND_MESH.y, HAND_MESH.z).applyQuaternion(_hqw).add(_hp);
    _goal.lerp(palm, w);

    _v.copy(_hp).lerp(_wr, w);                     // blend out of the swing
    _v2.setFromMatrixPosition(shoulder.matrixWorld);
    _v3.setFromMatrixPosition(elbow.matrixWorld).sub(_v2);
    if (_v3.lengthSq() < 1e-8) _v3.copy(fallbackPole);
    _v3.normalize();

    _pole.copy(pole).multiplyScalar(w).addScaledVector(_v3, 1 - w);
    if (_pole.lengthSq() < 1e-8) _pole.copy(fallbackPole);
    _pole.normalize();

    // elbow-inversion guard: a pole parallel to the limb axis has no plane
    _sole.copy(_v).sub(_v2);
    const d0 = _sole.length();
    if (d0 > 1e-6) {
      _sole.multiplyScalar(1 / d0);
      if (Math.abs(_pole.dot(_sole)) > 0.985) {
        _pole.copy(fallbackPole).addScaledVector(_sole, -fallbackPole.dot(_sole));
        if (_pole.lengthSq() < 1e-8) _pole.set(0, -1, 0).addScaledVector(_sole, _sole.y);
        _pole.normalize();
      }
    }

    const REACH_MAX = (l1 + l2) * 0.985;
    const handB = rig.get('hand' + L);
    _qNat.copy(handB.quaternion);
    /*
     * SOLVE, ORIENT, MEASURE, REPEAT.
     *
     * Rig.ik2 aims each bone's local -Y, but neither arm joint hangs exactly
     * on -Y — the elbow is 5.4 deg off it and the wrist 3.9 deg — so a single
     * analytic pass lands the hand mesh 21 mm off where it was asked for.
     * Measured, that is the whole width of the fist, and it is why the wood
     * never looked gripped. The residual is very nearly a fixed rotation, so
     * one Newton step on the measured error takes it under a millimetre.
     */
    for (let pass = 0; pass < 3; pass++) {
      _sole.copy(_v).sub(_v2);
      const d = _sole.length();
      if (d > REACH_MAX && d > 1e-6) _v.copy(_v2).addScaledVector(_sole, REACH_MAX / d);
      rig.ik2('arm' + L, 'fore' + L, l1, l2, _v, _pole);

      /* ---- wrist: lay the hand along the weapon, not along the forearm --- */
      handB.updateWorldMatrix(true, false);
      rig.aimWorld(handB, dir, _pole);
      if (w < 0.999) handB.quaternion.slerp(_qNat, 1 - w);
      handB.updateWorldMatrix(false, false);

      if (pass === 2) break;
      handB.updateWorldMatrix(true, false);
      _hp.setFromMatrixPosition(handB.matrixWorld);
      _hqw.setFromRotationMatrix(handB.matrixWorld);
      _err.set(HAND_MESH.x * sgn, HAND_MESH.y, HAND_MESH.z).applyQuaternion(_hqw).add(_hp);
      _err.subVectors(_goal, _err);
      if (_err.lengthSq() < 4e-6) break;           // 2 mm is under the geometry
      _v.add(_err);
    }
  }


  /**
   * Hands onto the rifle.
   *
   * The weapon has already solved its own world transform this frame (Weapon
   * places its SIGHT LINE on the aim ray, which is the only way a shouldered
   * pose can be correct) and published a trigger socket at the wrist of the
   * stock and a support socket on the fore-end. All that is left here is to
   * solve each arm onto its own socket.
   */
  _poseWeapon(dt, fwd, rgt) {
    const W = this.weapon;
    const w = W.gripBlend;
    if (w < 0.004) return;
    this.rig.sync();
    _fb.copy(fwd).multiplyScalar(-0.7).addScaledVector(rgt, -0.5).addScaledVector(UP, -0.4).normalize();
    this._armToSocket('R', W.handR.palm, W.handR.dir, W.handR.pole, w, _fb);
    _fb.copy(fwd).multiplyScalar(-0.4).addScaledVector(rgt, 0.3).addScaledVector(UP, -0.9).normalize();
    this._armToSocket('L', W.handL.palm, W.handL.dir, W.handL.pole, w, _fb);
    void dt;
  }

  _cloth3(dt, fwd, rgt, walkBlend, runBlend, ph, env) {
    const rig = this.rig;
    const wind = env.windVector;
    const gust = 1 + (env.windGust || 0) * 0.8;
    const accF = THREE.MathUtils.clamp(this._accel.dot(fwd) * 0.05, -1.2, 1.2);
    const accS = THREE.MathUtils.clamp(this._accel.dot(rgt) * 0.05, -1.2, 1.2);
    const windF = (wind.x * fwd.x + wind.z * fwd.z) * 0.055 * gust;
    const windS = (wind.x * rgt.x + wind.z * rgt.z) * 0.055 * gust;
    const flap = Math.sin(ph) * (0.05 + 0.20 * runBlend) * walkBlend;
    const swingBack = -(0.10 + 0.62 * runBlend) * walkBlend;

    const names = ['coatL', 'coatB', 'coatR', 'hat'];
    const drive = [
      { x: swingBack * 0.9 - accF * 0.5 - windF, z: flap + 0.10 * walkBlend - windS * 0.7 - accS * 0.4 },
      { x: swingBack * 1.25 - accF * 0.7 - windF * 1.2, z: -flap * 0.4 - windS * 0.5 },
      { x: swingBack * 0.9 - accF * 0.5 - windF, z: -flap - 0.10 * walkBlend - windS * 0.7 - accS * 0.4 },
      { x: -0.030 * walkBlend - accF * 0.06 - windF * 0.10, z: -windS * 0.10 - accS * 0.05 + Math.sin(ph * 2) * 0.012 * runBlend },
    ];
    const stiff = [46, 40, 46, 90];
    const damp = [9.0, 8.4, 9.0, 13.0];
    const h = Math.min(dt, 1 / 30);
    for (let i = 0; i < 4; i++) {
      const c = this._cloth[i], d = drive[i];
      c.vx += (d.x - c.x) * stiff[i] * h - c.vx * damp[i] * h;
      c.vz += (d.z - c.z) * stiff[i] * h - c.vz * damp[i] * h;
      c.x += c.vx * h; c.z += c.vz * h;
      c.x = THREE.MathUtils.clamp(c.x, -0.9, 0.9);
      c.z = THREE.MathUtils.clamp(c.z, -0.7, 0.7);
      rig.rot(names[i], c.x, 0, c.z);
    }
  }

  _updateContact(ankles, foot, walkBlend) {
    if (!this.contact) return;
    const lift0 = 1 - THREE.MathUtils.clamp(foot[0].lift / 0.16, 0, 0.92);
    const lift1 = 1 - THREE.MathUtils.clamp(foot[1].lift / 0.16, 0, 0.92);
    // two tight lobes at the soles plus one broad lobe for the body mass
    _v.addVectors(ankles[0], ankles[1]).multiplyScalar(0.5);
    this.contact.update(
      [ankles[0], ankles[1], _v],
      [0.30 + 0.12 * (1 - lift0), 0.30 + 0.12 * (1 - lift1), 0.66],
      [lift0, lift1, 0.52 * Math.max(lift0, lift1)],
    );
  }

  _updateVisibility() {
    const cam = this.ctx.camera;
    const rig = this.ctx.get('camera');
    let vis = true;
    if (rig && rig.freeCam) {
      // In free-camera (screenshot) mode only show the figure when the camera
      // is actually framing it, never when it is standing inside the lens.
      const d = cam.position.distanceTo(this.renderPos);
      vis = d > 2.0 && d < 42;
    }
    this.visible = vis;
    this.group.visible = vis;
    if (this.weapon && this.weapon.group) this.weapon.group.visible = vis;
    if (!vis && this.contact) this.contact.mesh.visible = false;
  }

  /* ------------------------------------------------------------- mounted */

  /**
   * The rider in the saddle.
   *
   * The whole pose is hung off the horse's `saddle` BONE in world space, read
   * fresh every frame, so the man tracks the animal's body pitch, roll and bob
   * through the stride instead of floating at a fixed offset from its root.
   * The pelvis is seated SEAT_RISE above that bone (the dished seat of the
   * western tree sits at about the bone itself), the thighs straddle the
   * barrel, and both boots are two-bone-IK'd into the stirrup irons — which
   * are part of the same skinned mesh, so they swing with the horse too.
   */
  _poseMounted(dt) {
    const horse = this.ctx.player.horse;
    if (!horse || !horse.getSaddle) { this.mode = 'onFoot'; return; }
    // Our update runs before the horse's, so make sure the bone we are about
    // to read is this frame's pose and not the last one.
    if (horse.syncPose) horse.syncPose(dt);
    const rig = this.rig;
    rig.reset();
    const s = horse.getSaddle();
    const h = Math.min(dt || 1 / 60, 1 / 30);

    /* ---- seat ------------------------------------------------------------ */
    this.group.position.copy(s.position);
    this.group.quaternion.copy(s.quaternion);
    this.bodyYaw = horse.yaw;
    // ctx.player.position stays on the GROUND under the horse — the camera rig
    // frames the pair off it and audio/LOD want a ground point, not a seat.
    this.renderPos.copy(horse.renderPos || s.position);

    this.group.updateMatrixWorld(true);

    const aimOff = THREE.MathUtils.clamp(angWrap(this.yaw - horse.yaw), -1.1, 1.1);
    const sp01 = s.speed01 != null ? s.speed01 : this.speed01;
    const ph = (s.gaitPhase || 0) * Math.PI * 2;
    const gaitOn = (s.freq || 0) > 0 ? 1 : 0;
    const bob = s.bobMetres || 0;              // metres, negative = saddle dropping

    /*
     * A rider is not bolted to the tree. He absorbs part of the bob through
     * hip and knee — so subtract a share of the saddle's own vertical travel
     * — and rocks fore-and-aft once per stride, sitting back into the cantle
     * as the horse opens up.
     */
    const prevBob = this._rideBob;
    this._rideBob = prevBob + (bob * 0.42 - prevBob) * Math.min(1, h * 14);
    const rock = Math.sin(ph * (horse.gait === 'walk' ? 1 : 2) - 0.5) * (0.020 + 0.045 * sp01) * gaitOn;
    const leanBack = sp01 * 0.16;              // sit back at the gallop

    /*
     * ---- BLADED STANCE, IN THE SADDLE -----------------------------------
     *
     * This block used to have no `blade` term at all, and that was the whole
     * of "aiming looks great on foot, still messed up on the horse". On foot
     * the torso turns its firing side back as the sights come up (and
     * _steerBody squares the shoulders onto the aim); mounted, the rider stayed
     * dead square to the animal. Measured in the CHEST BONE's own frame, the
     * bore sat 37.5 deg off the chest on foot and 0.2 deg off it in the saddle,
     * which put the butt plate 18 cm BEHIND the chest bone — hanging by his
     * neck instead of in the shoulder pocket — and drove the support arm
     * through his own ribs (left forearm 46 mm from the spine axis at aim-down,
     * against 127 mm on foot).
     *
     * The coefficients are exactly the on-foot ones, so the shoulder pocket
     * lands in the same place in chest-local space and the arm IK reaches the
     * sockets the same way it already does standing. Nothing here moves at
     * blade = 0, so the approved riding pose is untouched.
     *
     * The one addition the saddle needs of its own: a rider cannot pivot his
     * feet, so when the aim swings off the horse's ears he twists at the waist
     * instead. `af` opens the existing aim-follow chain up while the sights are
     * up and leaves it alone when they are not.
     */
    const blade = this.weapon ? this.weapon.aim01 : 0;
    const af = 1 + blade * 1.9;

    rig.trs('hips', 0, SEAT_RISE - PROP.hipY - this._rideBob, SEAT_BACK - sp01 * 0.02);
    rig.rot('hips', 0.20 + rock * 0.5 - leanBack * 0.35,
      aimOff * 0.10 * blade - blade * 0.22, Math.sin(ph) * 0.030 * gaitOn);
    rig.rot('spine', -0.09 - rock * 0.6 - leanBack * 0.30 + blade * 0.10,
      aimOff * 0.06 * af - blade * 0.16, aimOff * 0.05);
    rig.rot('chest', -0.05 - rock * 0.35 - leanBack * 0.22 + blade * 0.06,
      aimOff * 0.22 * af - blade * 0.14, 0);
    rig.rot('neck', 0.04 + leanBack * 0.25 + blade * 0.16,
      aimOff * 0.28 + blade * 0.30, 0);
    // Cheek weld: the head cants over onto the comb and the eye drops to the
    // sight line, exactly as it does on foot.
    rig.rot('head', -0.05 + leanBack * 0.30 - rock * 0.25
      + THREE.MathUtils.clamp(this.pitch * 0.4, -0.3, 0.28) + blade * 0.10,
      aimOff * 0.50 + Math.sin(this._idleT * 0.3) * 0.06, -blade * 0.16);

    // Same ordering rule as on foot: the carbine solves against the posed
    // torso, which in the saddle is the saddle bone's frame.
    if (this.weapon) {
      // ...but the aiming EYE is a statement about where the shooter is
      // looking, not about where the horse is pointing. See _weaponAnchors.
      _qAim.setFromAxisAngle(UP, this.yaw);
      _qEye.copy(this.group.quaternion).slerp(_qAim, blade);
      this._weaponAnchors(blade, _qEye);
      this.weapon.update(dt || 1 / 60);
    }

    /* ---- arms: rein hands over the horn ---------------------------------- */
    for (const [L, sgn] of [['L', 1], ['R', -1]]) {
      rig.rot('clav' + L, -0.02, 0, sgn * 0.02);
      rig.rot('arm' + L, -0.30 + rock * 0.25 - leanBack * 0.20, sgn * 0.06, sgn * 0.15);
      rig.rot('fore' + L, -0.98 - rock * 0.30, 0, sgn * 0.20);
      rig.rot('hand' + L, 0.18, 0, -sgn * 0.16);
    }

    const env = this.ctx.env;
    this._cloth3(dt || 1 / 60, _fwd.set(Math.sin(this.bodyYaw), 0, Math.cos(this.bodyYaw)),
      _rgt.set(-Math.cos(this.bodyYaw), 0, Math.sin(this.bodyYaw)),
      0.25, sp01, ph, env);

    /* ---- rifle from the saddle ------------------------------------------- */
    this.group.updateMatrixWorld(true);
    rig.sync();
    if (this.weapon && this.weapon.gripBlend > 0.004) {
      _fwd.set(Math.sin(this.bodyYaw), 0, Math.cos(this.bodyYaw));
      _rgt.set(-_fwd.z, 0, _fwd.x);
      this._poseWeapon(dt, _fwd, _rgt);
    }

    /* ---- legs: boots into the irons -------------------------------------- */
    // The IK is solved in world space, so the group transform has to be live
    // before it runs — the renderer only refreshes matrices after update().
    rig.sync();
    _v3.set(0, 0, 1).applyQuaternion(s.quaternion);            // saddle forward
    _v2.set(1, 0, 0).applyQuaternion(s.quaternion);            // saddle left
    for (const [L, sgn] of [['L', 1], ['R', -1]]) {
      // widen the hip so the thighs sit outside the saddle skirt rather than
      // through it, then straddle: knee forward and out, ankle in the iron
      rig.trs('thigh' + L, sgn * 0.030, -0.015, 0.015);
      const iron = sgn > 0 ? s.stirrupL : s.stirrupR;
      _v.copy(iron).addScaledVector(UP, ANKLE_LIFT).addScaledVector(_v3, -0.055);
      // Knee mostly OUTWARD, only a little forward: the iron hangs almost
      // under the hip, so a strongly forward pole throws the knee onto the
      // horse's shoulder and the thigh through the saddle's front jockey.
      _pole.copy(_v3).multiplyScalar(0.55).addScaledVector(_v2, sgn * 0.92).normalize();
      rig.ik2('thigh' + L, 'shin' + L, PROP.legL1, PROP.legL2, _v, _pole);
      // boot flat in the iron with the heel down, toe turned out a little
      _sole.set(0, -1, 0).applyAxisAngle(_v2, 0.24).normalize();
      const footBone = rig.get('foot' + L);
      footBone.updateWorldMatrix(true, false);
      rig.aimWorld(footBone, _sole, _v3);
      footBone.updateWorldMatrix(false, false);
    }
    rig.sync();

    if (this.contact) this.contact.mesh.visible = false;
    this._updateVisibility();
  }

  /* ============================================== MOUNTING AND DISMOUNTING */

  /**
   * Getting on and off is an ANIMATION, not an assignment.
   *
   * The old pair of methods flipped `mode` and teleported the character into
   * the saddle in a single frame, which is the single most jarring thing left
   * in the traversal loop. Both now open a timed transition that owns the
   * character until it finishes:
   *
   *   MOUNT     step round to the horse's near (left) side · left hand to the
   *             horn · left boot into the iron · rise, standing in the
   *             stirrup · right leg swings over the croup · settle into the
   *             seat.  ~1.25 s plus a lead-in if you were stood off.
   *   DISMOUNT  the same in reverse, ending with BOTH boots planted on the
   *             ground at the real terrain height.  ~1.15 s.
   *
   * Through the whole thing movement input is dead, the horse is held still
   * (Horse.holdStill), and the rider's pelvis is driven from the saddle BONE,
   * so the seat is glued at SEAT_RISE the instant the weight transfers rather
   * than converging onto it afterwards.
   *
   * `mountAnim` is the timeline other systems can hook. Every beat also fires
   * `mountBeat` on the event bus, and `mount` / `dismount` still fire exactly
   * once each, at the frame the rider's weight actually changes support.
   */
  mount(horse) {
    if (!horse || this.trans || this.mode !== 'onFoot') return;
    /*
     * E IS THREE VERBS AND THEY HAVE TO BE ARBITRATED ONCE, NOT TWICE.
     *
     * Horse binds KeyE on `window` for itself and only tests range, so with a
     * carcass at your boots and the horse parked beside you BOTH handlers ran
     * on the same press: skinning began and was immediately destroyed by a
     * mount. Measured — the kneel lasted one frame.
     *
     * Player's listener is registered first (it inits before Horse), so by the
     * time this is called `skinning` is already set and the arbitration that
     * _interact() already does — carcass wins only when it is genuinely the
     * nearer of the two — is the only one that decides. Move a step to drop
     * the knife and the horse is yours again.
     */
    if (this.skinning) return;
    this._beginTransition('mount', horse);
  }

  dismount() {
    const horse = this.ctx.player.horse;
    if (!horse || this.trans || this.mode !== 'mounted') return;
    this._beginTransition('dismount', horse);
  }

  _beginTransition(kind, horse) {
    const world = this.ctx.world;
    const p = this.state.position;
    const stand = this._nearSide(horse, new THREE.Vector3());
    const mounting = kind === 'mount';
    // Standing off the animal, take a beat to walk in rather than skating.
    const dist = mounting ? Math.hypot(stand.x - p.x, stand.z - p.z) : 0;
    const lead = THREE.MathUtils.clamp((dist - 1.0) / 3.4, 0, 1) * 0.55;
    const core = mounting ? 1.24 : 1.12;

    this.trans = {
      kind, horse, t: 0, lead, core, dur: lead + core,
      from: p.clone(), stand,
      startYaw: this.bodyYaw,
      groundYaw: horse.yaw + (mounting ? 0.34 : 0.26),
      beats: mounting ? MOUNT_BEATS : DISMOUNT_BEATS,
      next: 0,
    };
    this.mode = mounting ? 'mounting' : 'dismounting';
    horse.holdStill = true;
    this.ctx.player.horse = horse;
    this.input.f = 0; this.input.r = 0; this.input.sprint = false;
    this.input.jump = false; this.input.crouch = false;
    this.state.velocity.set(0, 0, 0);
    this.speed01 = 0;
    this._runHold = 0;
    this.crouch = 0;
    // You cannot shoulder a rifle while you are climbing onto a horse.
    if (this.weapon) {
      this.weapon._wantAim = false;
      this.weapon._triggerHeld = false;
      this.weapon._holdT = 9;
    }
    this.mountAnim = {
      kind, t: 0, dur: this.trans.dur, lead, u: 0, seat: mounting ? 0 : 1,
      beats: this.trans.beats.map((b) => ({ name: b.name, t: lead + b.c })),
    };
    void world;
    this.ctx.emit('mountBeat', {
      kind, name: 'begin', duration: this.trans.dur,
      position: this.state.position.clone(), horse,
    });
  }

  /** Bail out of a transition and put the character back on his feet. */
  _abortTransition() {
    const T = this.trans;
    if (!T) return;
    this.trans = null;
    this.mountAnim = null;
    if (T.horse) { T.horse.holdStill = false; T.horse.mounted = false; }
    this.mode = 'onFoot';
    this.publicMode = 'onFoot';
    this.ctx.player.mode = 'onFoot';
    this.ctx.player.horse = null;
    this.mountBlend = 0;
    this.state.velocity.set(0, 0, 0);
    this.state.grounded = true;
    this.speed01 = 0;
  }

  /** Ground point off the horse's NEAR (left) side, where a rider mounts. */
  _nearSide(horse, out) {
    const yaw = horse.yaw;
    // rig/horse local +X is LEFT; rotated by yaw that is (cos, 0, -sin)
    const x = horse.state.position.x + Math.cos(yaw) * NEAR_SIDE;
    const z = horse.state.position.z - Math.sin(yaw) * NEAR_SIDE;
    return out.set(x, this.ctx.world.getHeight(x, z), z);
  }

  _mountBeat(b) {
    const T = this.trans;
    const A = this.ctx.get('audio');
    const pos = this.renderPos;
    if (b.name === 'mount' || b.name === 'dismount') {
      const up = b.name === 'mount';
      this.publicMode = up ? 'mounted' : 'onFoot';
      this.ctx.player.mode = this.publicMode;
      if (T.horse) T.horse.mounted = up;
      this.ctx.emit(b.name, { horse: T.horse, position: pos.clone() });
      return;
    }
    if (A && A.play && b.sfx) {
      A.play(b.sfx, { position: pos, volume: b.vol || 0.6, pitch: b.pitch || 1 });
    }
    this.ctx.emit('mountBeat', { kind: T.kind, name: b.name, position: pos.clone() });
  }

  /**
   * The transition pose.
   *
   * Everything is a blend between two frames that both exist every frame: the
   * STAND frame (a point on the terrain off the horse's near side) and the
   * SEAT frame (the saddle bone, live, so it carries the animal's own pitch
   * and roll). `seat` drives the root and the pelvis together — the group goes
   * from the ground to the saddle bone while the hips offset goes from the
   * standing hip height to SEAT_RISE — so the pelvis path is continuous and
   * lands exactly on the seat, not near it.
   */
  _poseTransition(dt) {
    const T = this.trans;
    const horse = T.horse;
    const rig = this.rig;
    const world = this.ctx.world;
    const step = Math.min(dt || 1 / 60, 1 / 20);
    const mounting = T.kind === 'mount';
    T.t += step;
    const c = T.t - T.lead;
    const done = T.t >= T.dur;

    if (horse.syncPose) horse.syncPose(dt);
    const s = horse.getSaddle();
    rig.reset();

    /* ---- phase weights --------------------------------------------------- */
    let approach, stirW, seat, swing;
    if (mounting) {
      approach = smoothstep(0, Math.max(0.14, T.lead + 0.12), T.t);
      stirW = smoothstep(0.02, 0.28, c);
      seat = smoothstep(0.22, 0.88, c);
      swing = smoothstep(0.34, 1.02, c);
    } else {
      approach = 1;
      stirW = 1 - smoothstep(0.74, 0.96, c);
      seat = 1 - smoothstep(0.32, 0.86, c);
      swing = 1 - smoothstep(0.08, 0.56, c);
    }
    this.mountBlend = seat;
    if (this.mountAnim) {
      this.mountAnim.t = T.t; this.mountAnim.u = T.t / T.dur; this.mountAnim.seat = seat;
    }

    /* ---- the two frames -------------------------------------------------- */
    this._nearSide(horse, _stand);                      // stand point, live
    if (mounting) {
      _stand.x = T.from.x + (_stand.x - T.from.x) * approach;
      _stand.z = T.from.z + (_stand.z - T.from.z) * approach;
      _stand.y = world.getHeight(_stand.x, _stand.z);
    }
    const gYaw = T.startYaw + angWrap(T.groundYaw - T.startYaw) * approach;
    _fwd.set(Math.sin(gYaw), 0, Math.cos(gYaw));
    _rgt.set(-_fwd.z, 0, _fwd.x);
    _hf.set(0, 0, 1).applyQuaternion(s.quaternion);     // saddle forward
    _hl.set(1, 0, 0).applyQuaternion(s.quaternion);     // saddle left

    /* ---- root ------------------------------------------------------------ */
    _tgt.copy(_stand).lerp(s.position, seat);
    // rise up over the stirrup rather than sliding through the saddle skirt
    _tgt.y += Math.sin(Math.PI * seat) * 0.10;
    this.group.position.copy(_tgt);
    _qA.setFromAxisAngle(UP, gYaw);
    this.group.quaternion.copy(_qA).slerp(s.quaternion, seat);
    this.group.updateMatrixWorld(true);
    this.bodyYaw = gYaw + angWrap(horse.yaw - gYaw) * seat;

    /* ---- spine: reach for the horn, then sit up -------------------------- */
    const reach = Math.sin(Math.PI * THREE.MathUtils.clamp(seat, 0, 1));
    rig.trs('hips', 0, -0.024 + (SEAT_RISE - PROP.hipY + 0.024) * seat, SEAT_BACK * seat);
    rig.rot('hips', 0.20 * seat + reach * 0.16, 0, 0);
    rig.rot('spine', -0.09 * seat + reach * 0.22, 0, reach * 0.10);
    rig.rot('chest', -0.05 * seat + reach * 0.14, -reach * 0.10, 0);
    rig.rot('neck', 0.04 * seat + reach * 0.06, -reach * 0.14, 0);
    rig.rot('head', -0.05 * seat - reach * 0.12
      + THREE.MathUtils.clamp(this.pitch * 0.3, -0.25, 0.25), -reach * 0.22, 0);

    if (this.weapon) {
      this._weaponAnchors(0);
      this.weapon.update(dt || 1 / 60);
    }

    /* ---- arms: base pose, then both hands onto the horn ------------------ */
    for (const [L, sgn] of [['L', 1], ['R', -1]]) {
      rig.rot('clav' + L, -0.02, 0, sgn * 0.02);
      rig.rot('arm' + L, -0.12 - 0.18 * seat, sgn * 0.06, sgn * 0.13);
      rig.rot('fore' + L, -0.46 - 0.52 * seat, 0, sgn * 0.19);
      rig.rot('hand' + L, 0.16, 0, -sgn * 0.15);
    }
    const handW = mounting
      ? smoothstep(-0.12, 0.12, c) * (1 - smoothstep(0.90, 1.16, c))
      : (1 - smoothstep(0.60, 0.94, c));
    if (handW > 0.004) {
      rig.sync();
      _tgt.copy(SEAT_TO_HORN).applyQuaternion(s.quaternion).add(s.position);
      // left hand on the horn itself, right hand on the swell behind it
      for (const [L, side, back] of [['L', 0.055, 0.010], ['R', -0.075, -0.075]]) {
        _tgt2.copy(_tgt).addScaledVector(_hl, side).addScaledVector(_hf, back)
          .addScaledVector(UP, 0.030);
        _v.copy(UP).multiplyScalar(-1).addScaledVector(_hf, 0.34).normalize();
        _fb.copy(_hl).multiplyScalar(L === 'L' ? 0.65 : -0.70)
          .addScaledVector(UP, -0.55).addScaledVector(_hf, -0.30).normalize();
        this._armToSocket(L, _tgt2, _v, _fb, handW, _fb);
      }
    }

    /* ---- legs ------------------------------------------------------------ */
    rig.sync();
    const ankles = [];
    for (const [L, sgn] of [['L', 1], ['R', -1]]) {
      const w = L === 'L' ? stirW : swing;
      rig.trs('thigh' + L, sgn * 0.030 * seat, -0.015 * seat, 0.015 * seat);
      // stance foot on the terrain beside the horse
      this._standFoot(sgn, gYaw, _stand, _v2);
      // ...and the iron it is going into
      _v3.copy(sgn > 0 ? s.stirrupL : s.stirrupR)
        .addScaledVector(UP, ANKLE_LIFT).addScaledVector(_hf, -0.055);
      _v.copy(_v2).lerp(_v3, w);
      // arcs: the left boot lifts into the iron, the right leg swings up and
      // BACK so it passes over the croup instead of through the animal
      const arc = Math.sin(Math.PI * THREE.MathUtils.clamp(w, 0, 1));
      if (sgn > 0) _v.addScaledVector(UP, arc * 0.12);
      else _v.addScaledVector(UP, arc * 0.95).addScaledVector(_hf, -arc * 0.45);
      _v3.copy(_hf).multiplyScalar(0.55).addScaledVector(_hl, sgn * 0.92).normalize();
      _pole.copy(_fwd).addScaledVector(_rgt, sgn > 0 ? -0.16 : 0.16).normalize()
        .multiplyScalar(1 - seat).addScaledVector(_v3, seat).normalize();
      this._legTo(L, _v, _pole);
      ankles.push(_v.clone());

      // sole: flat on the ground when standing, heel down in the iron
      _sole.set(0, -1, 0);
      _v3.set(0, -1, 0).applyAxisAngle(_hl, 0.24);
      _sole.lerp(_v3, seat).normalize();
      _v2.copy(_fwd).lerp(_hf, seat).normalize();
      const footBone = rig.get('foot' + L);
      footBone.updateWorldMatrix(true, false);
      rig.aimWorld(footBone, _sole, _v2);
      footBone.updateWorldMatrix(false, false);
    }
    rig.sync();

    /* ---- hands onto the carbine if it happens to be out ------------------ */
    if (this.weapon && this.weapon.gripBlend > 0.004) {
      this._poseWeapon(dt, _fwd, _rgt);
    }

    this._cloth3(dt || 1 / 60, _fwd, _rgt, 0.2, 0, this._idleT * 2, this.ctx.env);
    rig.sync();

    /* ---- world state ----------------------------------------------------- */
    this.renderPos.copy(_stand).lerp(horse.renderPos || horse.state.position, seat);
    this.state.position.copy(this.renderPos);
    this.prevPos.copy(this.state.position);

    /* ---- beats ----------------------------------------------------------- */
    while (T.next < T.beats.length && c >= T.beats[T.next].c) {
      this._mountBeat(T.beats[T.next]);
      T.next++;
    }

    if (this.contact) {
      const gw = 1 - THREE.MathUtils.clamp(seat * 1.4, 0, 1);
      if (gw < 0.01) this.contact.mesh.visible = false;
      else {
        _v.addVectors(ankles[0], ankles[1]).multiplyScalar(0.5);
        this.contact.update([ankles[0], ankles[1], _v],
          [0.30, 0.30, 0.60], [gw, gw * 0.7, gw * 0.5]);
      }
    }
    this._updateVisibility();

    /* ---- land it --------------------------------------------------------- */
    if (done) {
      while (T.next < T.beats.length) { this._mountBeat(T.beats[T.next]); T.next++; }
      this.trans = null;
      this.mountAnim = null;
      horse.holdStill = false;
      if (mounting) {
        this.mode = 'mounted';
        this.publicMode = 'mounted';
        this.ctx.player.mode = 'mounted';
        this.ctx.player.horse = horse;
        horse.mounted = true;
        this.mountBlend = 1;
      } else {
        // BOTH FEET ON THE GROUND, at the height the terrain actually is here.
        this._nearSide(horse, _tgt2);
        this.mode = 'onFoot';
        this.publicMode = 'onFoot';
        this.ctx.player.mode = 'onFoot';
        this.ctx.player.horse = null;
        horse.mounted = false;
        this.state.position.copy(_tgt2);
        this.prevPos.copy(this.state.position);
        this.renderPos.copy(this.state.position);
        this._stuckFrom.copy(this.state.position);
        this.state.velocity.set(0, 0, 0);
        this.state.grounded = true;
        this.state.groundNormal.set(0, 1, 0);
        this.speed01 = 0;
        this.gaitPhase = 0.12;
        this.bodyYaw = T.groundYaw;
        this.moveYaw = T.groundYaw;
        this.yaw = T.groundYaw;
        this._yawTarget = T.groundYaw;
        this._runHold = 0;
        this.mountBlend = 0;
      }
    }
  }

  /**
   * World-space standing foot for side `sgn` (+1 = left), taken off the STAND
   * point rather than off the group — the group is already partway into the
   * saddle and the boots on the ground must not follow it up.
   */
  _standFoot(sgn, gYaw, stand, out) {
    const off = sgn * 0.10;                    // rig +X is the character's left
    const x = stand.x + Math.cos(gYaw) * off;
    const z = stand.z - Math.sin(gYaw) * off;
    return out.set(x, this.ctx.world.getHeight(x, z) + PROP.ankleY, z);
  }

  /** Two-bone leg IK with the same reach clamp the arms use. */
  _legTo(L, target, pole) {
    const rig = this.rig;
    const l1 = PROP.legL1, l2 = PROP.legL2;
    const hip = rig.get('thigh' + L);
    hip.updateWorldMatrix(true, false);
    _v2.setFromMatrixPosition(hip.matrixWorld);
    _sole.copy(target).sub(_v2);
    const d = _sole.length();
    const max = (l1 + l2) * 0.985;
    if (d > max && d > 1e-6) target.copy(_v2).addScaledVector(_sole, max / d);
    rig.ik2('thigh' + L, 'shin' + L, l1, l2, target, pole);
  }

  /* -------------------------------------------------------------- teardown */

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keydown', this._onAction);
    window.removeEventListener('keyup', this._onKeyUp);
    if (this.weapon) this.weapon.dispose();
    window.removeEventListener('mousemove', this._onMouseMove);
    if (this.ctx.canvas) this.ctx.canvas.removeEventListener('click', this._onClick);
    if (this.physics && this._stepFn) this.physics.removeStepper(this._stepFn);
    if (this.mesh) { this.mesh.geometry.dispose(); }
    if (this.matSolid) this.matSolid.dispose();
    if (this.matCloth) this.matCloth.dispose();
    if (this.contact) this.contact.dispose();
    for (const d of this._drops) this.ctx.scene.remove(d.mesh);
    this._drops.length = 0;
    if (this.knife) {
      if (this.knife.parent) this.knife.parent.remove(this.knife);
      this.knife.geometry.dispose();
    }
    if (this.matKnife) this.matKnife.dispose();
    if (this.geoPelt) this.geoPelt.dispose();
    if (this.matPelt) this.matPelt.dispose();
    this.ctx.scene.remove(this.group);
  }
}
