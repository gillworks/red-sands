import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PAL } from './rig/HumanRig.js';
import { rng } from '../core/Context.js';

/**
 * RED SANDS — LEVER-ACTION RIFLE
 * ============================================================================
 * A ~1.00 m carbine built out of merged primitives at boot (three draw calls:
 * wood, steel, and the lever, which has to rotate on its own). It is NOT
 * parented to a hand bone — the hands are posed onto IT.
 *
 *   WHY THAT WAY ROUND.  A rifle hung off the right hand can never be
 *   shouldered correctly: the butt, the cheek weld and the sight line are all
 *   defined relative to the shooter's EYE, not to his wrist. So the weapon
 *   solves its own world transform first and publishes two GRIP SOCKETS —
 *   `handR` at the wrist of the stock, `handL` on the fore-end — each carrying
 *   a palm point, a hand direction and an elbow pole, all defined in the
 *   carbine's own frame. Player two-bone-IKs an arm onto each. Both hands then
 *   land where they physically have to, on foot and in the saddle, at any
 *   pitch, at any blend weight, because the sockets are properties of the
 *   WEAPON and cannot go stale when the pose changes.
 *
 *   ANCHORS.  The aimed pose hangs off the aiming EYE (the head bone, live, so
 *   the cheek stays on the comb through the gait bob). Slung and low ready
 *   hang off the CHEST bone, so the carbine rides the spine lean, the shoulder
 *   counter-rotation and the saddle without a single special case. Player
 *   writes all three every frame through setAnchors().
 *
 *   CARRY        slung muzzle-up behind the right shoulder when it is not in
 *                use, brought down to a low ready when it is, shouldered on
 *                right mouse. Three poses, blended by two scalars.
 *   SWAY         the aim ray carries a two-frequency breathing sway. Holding
 *                the steady-breath key collapses it to a fifth for as long as
 *                the breath lasts, and when it runs out the sway comes back
 *                worse than it started for a couple of seconds.
 *   FIRE         hitscan from the muzzle along the (swayed) aim ray with a
 *                spread cone, a spring recoil impulse on the weapon and a
 *                separate one on the camera, muzzle flash + smoke through
 *                Particles, and a `gunshot` event that Audio, Particles AND
 *                every animal in earshot are already listening for.
 *   CYCLE        the lever throws open and closed over ~0.45 s; you cannot
 *                fire during it, and the sights dip while it happens.
 *
 * Owned and driven by Player — it is not a registered system.
 * ============================================================================
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _qa = new THREE.Quaternion();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();

/* ---------------------------------------------------------------- geometry */

/**
 * Local frame: +Z out of the muzzle, +Y up, +X to the shooter's LEFT — the
 * same handedness the character rig uses, so nothing needs mirroring.
 * The origin sits at the wrist of the stock, just behind the receiver.
 */
const MUZZLE = new THREE.Vector3(0, 0.002, 0.662);
/**
 * A point ON the sight line, where the aiming eye goes.
 *
 * Its Z is the EYE RELIEF, and it is load-bearing: the butt plate is at
 * z = −0.316, so eye relief decides how far behind the shooter's eye the butt
 * lands, and therefore whether it sits in his shoulder or hangs in the air
 * behind his neck. 0.19 m of relief (butt 0.28 m behind the eye) is what open
 * sights actually want and is short enough that the rig can reach it with a
 * bladed stance plus the head craned forward over the comb.
 */
const EYE_LOCAL = new THREE.Vector3(-0.002, 0.0415, -0.036);
const GRIP_LOCAL = new THREE.Vector3(0.004, -0.056, -0.056);
const FOREND_LOCAL = new THREE.Vector3(0.002, -0.028, 0.318);
/** Lever pivot, at the bottom rear of the receiver. */
const LEVER_PIVOT = new THREE.Vector3(0, -0.040, -0.014);

/*
 * ---------------------------------------------------------------- GRIP SOCKETS
 *
 * THE HANDS ARE A PROPERTY OF THE WEAPON, NOT OF THE POSE.
 *
 * Each socket is three vectors in the carbine's own local frame:
 *
 *   palm  where the CENTRE OF THE HAND MESH has to end up. Note that the arm
 *         IK solves the WRIST, and the hand blob hangs PALM_DROP below the
 *         wrist joint — solving the wrist onto the wood is what put the stock
 *         through the middle of the character's fist in the last pass.
 *   dir   wrist -> fingertips, i.e. which way the hand lies along the weapon.
 *   pole  where the elbow is thrown. Because it is expressed in the WEAPON's
 *         frame it rotates with the gun, so the firing elbow rides high behind
 *         a shouldered rifle and drops as the carbine comes down to a low
 *         ready, without a single pose-specific special case.
 *
 * The trigger socket is at the wrist of the stock (hand behind the lever, on
 * the drop); the support socket is on the WOOD of the fore-end, 7 cm behind the
 * barrel band. That last number is load-bearing: at the band the support hand
 * was 0.54 m from the shoulder joint against a 0.566 m arm, so the left arm was
 * locked bolt straight and, once PALM_DROP was accounted for, could not reach
 * at all — which is exactly the "support hand is not on the fore-end" the
 * playtester saw. Pulled back to 0.246 the arm sits at 79 % extension with a
 * proper bend in it.
 */
const PALM_DROP = 0.050;
const GRIP_PALM = new THREE.Vector3(-0.016, -0.070, -0.072);
const GRIP_DIR = new THREE.Vector3(0.05, -0.36, 0.93).normalize();
const GRIP_POLE = new THREE.Vector3(-0.86, -0.46, -0.22).normalize();
const FORE_PALM = new THREE.Vector3(0.015, -0.049, 0.246);
const FORE_DIR = new THREE.Vector3(-0.05, 0.19, 0.98).normalize();
const FORE_POLE = new THREE.Vector3(0.36, -0.92, -0.14).normalize();

/*
 * -------------------------------------------------------------- CARRY ANCHORS
 * Both carry poses are expressed in the CHEST BONE's frame, not in the
 * character's root frame. The root is the point on the ground between the
 * boots: hung off that, the carbine ignored the spine lean, the shoulder
 * counter-rotation and the whole gait bob, and read as floating half a step
 * behind the man. Anchored on the chest it is welded to the torso for free.
 *
 * SLUNG is specified as a muzzle POINT plus a bore direction plus a roll,
 * because the two things that have to be true — the barrel clears the hat brim
 * (0.238 m radius, crown at chest+0.39) and the butt clears the coat back — are
 * both statements about where the ends of the weapon are, not about Euler
 * angles. Cant the receiver over so its top faces outboard: the 0.12 m drop at
 * the heel then throws the butt AWAY from the spine instead of into it.
 */
const SLUNG_MUZZLE = new THREE.Vector3(-0.292, 0.535, -0.352);
const SLUNG_BORE = new THREE.Vector3(-0.400, 0.905, -0.045).normalize();
const SLUNG_UP = new THREE.Vector3(-0.905, 0.060, -0.420).normalize();
/** Low ready: butt under the armpit, muzzle forward, down and across. */
const READY_PALM = new THREE.Vector3(-0.155, -0.055, 0.130);
const READY_BORE = new THREE.Vector3(0.460, -0.400, 0.790).normalize();
const READY_UP = new THREE.Vector3(0.150, 0.950, 0.100).normalize();

function box(w, h, d, x, y, z, col, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.rotateX(rx), g.rotateY(ry), g.rotateZ(rz);
  g.translate(x, y, z);
  return paint(g, col);
}

function tube(r0, r1, len, x, y, z, col, seg = 8) {
  const g = new THREE.CylinderGeometry(r0, r1, len, seg, 1, false);
  g.rotateX(Math.PI * 0.5);              // +Y axis -> +Z
  g.translate(x, y, z);
  return paint(g, col);
}

/** Bake a linear colour into vertex colours, with a little per-face variation
 *  so nothing on this thing is a flat plastic swatch. */
function paint(g, col) {
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  const pos = g.attributes.position;
  for (let i = 0; i < n; i++) {
    // Sun-bleach the up-facing surfaces and darken the crevices, keyed off the
    // vertex's own height so the wear pattern is consistent along the length.
    const k = 1 + Math.sin(pos.getZ(i) * 41.3 + pos.getY(i) * 17.7) * 0.055
      + pos.getY(i) * 0.35;
    c[i * 3] = col[0] * k;
    c[i * 3 + 1] = col[1] * k;
    c[i * 3 + 2] = col[2] * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** Steel, wood and lever geometry for one carbine. */
function buildRifle() {
  const steelC = PAL.steel, woodC = PAL.leather, brassC = PAL.brass;
  const darkSteel = [steelC[0] * 0.55, steelC[1] * 0.55, steelC[2] * 0.58];

  const steel = mergeGeometries([
    // octagonal barrel, tapering very slightly toward the muzzle
    tube(0.0128, 0.0112, 0.545, 0, 0.002, 0.392, steelC, 8),
    // magazine tube slung underneath
    tube(0.0088, 0.0088, 0.470, 0, -0.0245, 0.352, darkSteel, 8),
    // receiver
    box(0.042, 0.086, 0.196, 0, 0.000, 0.022, steelC),
    box(0.048, 0.030, 0.070, 0, -0.030, -0.010, darkSteel),   // lower tang
    // barrel band + front cap
    box(0.034, 0.040, 0.016, 0, -0.012, 0.318, brassC),
    box(0.030, 0.032, 0.014, 0, -0.010, 0.605, darkSteel),
    // sights: rear notch and front blade, both crests at y = 0.0415
    box(0.022, 0.011, 0.009, 0, 0.0365, 0.152, darkSteel),
    box(0.005, 0.016, 0.006, 0, 0.0335, 0.648, darkSteel),
    // hammer at the rear of the receiver, and the trigger
    box(0.011, 0.038, 0.015, 0, 0.048, -0.070, darkSteel, -0.30),
    box(0.006, 0.026, 0.009, 0, -0.056, -0.026, darkSteel, 0.25),
    // crescent butt plate
    box(0.036, 0.098, 0.013, 0, -0.120, -0.316, brassC, 0.10),
  ], false);

  /*
   * DROP AT HEEL. The first cut ran the stock straight back along the bore, so
   * the butt sat 9 cm below the sight line and, once the sight line was on the
   * shooter's eye, floated in the air behind his neck. A real stock drops away
   * from the bore — the comb under the cheek, the heel down at the shoulder
   * pocket — which is about 17 cm below the eye. With that drop in, the butt
   * lands in the shoulder without any pose cheat at all.
   */
  /*
   * SLING. A carbine that hangs on a man's back has something holding it there;
   * without one the slung pose reads as a stick stuck to the coat. Modelled the
   * way it actually attaches — a swivel at the barrel band, another at the toe
   * of the butt — so it is correct in the hands as well, where it simply hangs
   * slack underneath. Merged into the wood geometry: no extra draw call.
   */
  const strapC = [PAL.leatherDark[0] * 1.15, PAL.leatherDark[1] * 1.15, PAL.leatherDark[2] * 1.15];
  const path = [
    [-0.040, 0.312], [-0.074, 0.190], [-0.096, 0.030], [-0.118, -0.130], [-0.150, -0.268],
  ];
  const strap = [];
  for (let i = 0; i < path.length - 1; i++) {
    const [y0, z0] = path[i], [y1, z1] = path[i + 1];
    const dy = y1 - y0, dz = z1 - z0;
    const len = Math.hypot(dy, dz);
    strap.push(box(0.026, 0.0075, len + 0.006, 0, (y0 + y1) * 0.5, (z0 + z1) * 0.5,
      strapC, Math.atan2(-dy, dz)));
  }

  const wood = mergeGeometries([
    // forend, wrapping the barrel
    box(0.042, 0.050, 0.215, 0, -0.014, 0.212, woodC),
    // wrist of the stock, dropping away behind the receiver
    box(0.036, 0.060, 0.120, 0, -0.062, -0.126, woodC, 0.30),
    // butt stock, and the comb the cheek rests on
    box(0.040, 0.086, 0.180, 0, -0.110, -0.244, woodC, 0.10),
    box(0.036, 0.028, 0.130, 0, -0.068, -0.206, woodC, 0.20),
    ...strap,
  ], false);

  // The lever is modelled about its own pivot so it can swing.
  const lever = mergeGeometries([
    box(0.011, 0.052, 0.014, 0, -0.022, 0.006, [PAL.steel[0] * 0.6, PAL.steel[1] * 0.6, PAL.steel[2] * 0.62]),
    box(0.011, 0.014, 0.088, 0, -0.045, -0.040, [PAL.steel[0] * 0.6, PAL.steel[1] * 0.6, PAL.steel[2] * 0.62], 0.22),
    box(0.011, 0.040, 0.013, 0, -0.062, -0.082, [PAL.steel[0] * 0.6, PAL.steel[1] * 0.6, PAL.steel[2] * 0.62], 0.55),
  ], false);

  return { steel, wood, lever };
}

/* ------------------------------------------------------------------ weapon */

export class Weapon {
  constructor(ctx, player) {
    this.ctx = ctx;
    this.player = player;
    /** Deterministic — shot spread must reproduce frame for frame. */
    this.rand = rng((ctx.seed ^ 0x7ac31d55) >>> 0);

    this.group = new THREE.Group();
    this.group.name = 'rifle';

    /* --- state ---------------------------------------------------------- */
    /** 0 slung across the back, 1 in the hands. */
    this.drawn = 0;
    /** 0 low ready, 1 shouldered. */
    this.aim01 = 0;
    this._wantAim = false;
    /* Seconds since the weapon was last used. Starts long so the carbine is
     * SLUNG on frame zero — the capture harness settles in under a second and
     * would otherwise photograph the character holding a rifle at low ready for
     * no reason. */
    this._holdT = 99;
    this.ammo = 8;
    this.capacity = 8;
    this.reserve = 40;

    this.cycle = 0;                  // 0..1 lever throw
    this._cycleT = -1;
    this._reloadT = -1;
    this._fireCool = 0;
    this._triggerHeld = false;
    this._edgeFire = false;

    /* --- breathing ------------------------------------------------------ */
    this.breath = 1;                 // 1 full, 0 spent
    this._steady = 0;                // blended steady-breath weight
    this._wantSteady = false;
    this._swayT = 0;
    this.swayYaw = 0;
    this.swayPitch = 0;
    this._panic = 0;                 // extra sway after the breath runs out
    this.sway01 = 0;

    /* --- recoil springs -------------------------------------------------- */
    this._rec = { p: 0, v: 0, back: 0, backV: 0 };
    this.camKick = 0;
    this._camKickV = 0;

    /* --- anchors, written by Player every frame before update() ---------- */
    this.anchorChestPos = new THREE.Vector3(0, 1.28, 0);
    this.anchorChestQ = new THREE.Quaternion();
    this.anchorEye = new THREE.Vector3(0, 1.62, 0);
    this.anchorBodyQ = new THREE.Quaternion();

    /* --- published ------------------------------------------------------- */
    this.gripWorld = new THREE.Vector3();
    this.forendWorld = new THREE.Vector3();
    this.muzzleWorld = new THREE.Vector3();
    this.aimDir = new THREE.Vector3(0, 0, 1);
    this.eyeWorld = new THREE.Vector3();
    /**
     * Per-hand IK contract consumed by Player: world-space palm point, the
     * direction the hand lies (wrist -> fingertips) and the elbow pole. R is
     * the trigger hand, L the support hand.
     */
    this.handR = {
      palm: new THREE.Vector3(), wrist: new THREE.Vector3(),
      dir: new THREE.Vector3(0, -1, 0), pole: new THREE.Vector3(0, 0, -1),
    };
    this.handL = {
      palm: new THREE.Vector3(), wrist: new THREE.Vector3(),
      dir: new THREE.Vector3(0, -1, 0), pole: new THREE.Vector3(0, 0, -1),
    };
    /** 0..1 how much the hands are committed to the weapon. */
    this.gripBlend = 0;
    /** Set for a couple of seconds after anything happens; the HUD reads it. */
    this.hudT = 0;
    this.lastShot = null;
    this.drawCalls = 0;
  }

  /* ==================================================================== init */

  async init() {
    const parts = buildRifle();

    this.matWood = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.62, metalness: 0.0, dithering: true, name: 'rifleWood',
    });
    this.matSteel = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.34, metalness: 0.82, dithering: true, name: 'rifleSteel',
    });
    const sky = this.ctx.get('sky');
    if (sky && sky.injectAerialPerspective) {
      sky.injectAerialPerspective(this.matWood);
      sky.injectAerialPerspective(this.matSteel);
    }

    this.meshWood = new THREE.Mesh(parts.wood, this.matWood);
    this.meshSteel = new THREE.Mesh(parts.steel, this.matSteel);
    this.meshLever = new THREE.Mesh(parts.lever, this.matSteel);
    this.meshLever.position.copy(LEVER_PIVOT);
    for (const m of [this.meshWood, this.meshSteel, this.meshLever]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.group.add(m);
    }
    this.ctx.scene.add(this.group);

    const lighting = this.ctx.get('lighting');
    if (lighting && lighting.requestShadowCaster) lighting.requestShadowCaster(this.group);

    this._bindInput();
  }

  /* --------------------------------------------------------------- input */

  _bindInput() {
    const canvas = this.ctx.canvas;
    this._onDown = (e) => {
      if (e.button === 2) { this._wantAim = true; this.hudT = 3; }
      else if (e.button === 0) { this._triggerHeld = true; this._edgeFire = true; }
    };
    this._onUp = (e) => {
      if (e.button === 2) this._wantAim = false;
      else if (e.button === 0) this._triggerHeld = false;
    };
    this._onCtx = (e) => e.preventDefault();
    this._onKey = (e) => {
      if (e.repeat) return;
      if (e.code === 'KeyR') this.reload();
      // Shift is the sprint key on foot, but you cannot sprint while you are
      // looking down the sights — so while aiming it steadies the breath.
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this._wantSteady = true;
    };
    this._onKeyUp = (e) => {
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this._wantSteady = false;
    };
    window.addEventListener('mousedown', this._onDown);
    window.addEventListener('mouseup', this._onUp);
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKeyUp);
    if (canvas) canvas.addEventListener('contextmenu', this._onCtx);
  }

  /* ------------------------------------------------------------- public API */

  /** True while the sights are up — CameraRig and HUD both key off this. */
  get aiming() { return this.aim01 > 0.02; }
  get busy() { return this._cycleT >= 0 || this._reloadT >= 0; }

  reload() {
    if (this._reloadT >= 0 || this.ammo >= this.capacity || this.reserve <= 0) return;
    this._reloadT = 0;
    this._holdT = 0;
    this.hudT = 3.2;
    const A = this.ctx.get('audio');
    if (A && A.play) A.play('leather', { position: this.player.renderPos, volume: 0.5 });
  }

  /* ==================================================================== step */

  /**
   * Runs from Player.update BEFORE the rig is posed: everything downstream
   * (arm IK, camera, HUD) reads the values this leaves behind.
   */
  update(dt) {
    const h = Math.min(dt || 1 / 60, 1 / 20);
    const P = this.player;

    /* ---- carry / aim blends --------------------------------------------- */
    const canAim = P.mode !== 'swimming';
    const want = this._wantAim && canAim ? 1 : 0;
    if (want || this._triggerHeld || this.busy) this._holdT = 0;
    else this._holdT += h;
    // Sling it again once it has been idle for a few seconds.
    const wantDrawn = (want || this._triggerHeld || this.busy || this._holdT < 5.0) ? 1 : 0;
    this.drawn += (wantDrawn - this.drawn) * (1 - Math.exp(-(wantDrawn ? 7.0 : 3.0) * h));
    // The raise is fast, the lower is slower — a gun comes up in a quarter of
    // a second and comes down when you are good and ready.
    this.aim01 += (want * this.drawn - this.aim01)
      * (1 - Math.exp(-(want ? 11.0 : 6.0) * h));
    if (this.aim01 > 0.02) this.hudT = Math.max(this.hudT, 0.4);
    else this.hudT = Math.max(0, this.hudT - h);

    /* ---- breathing ------------------------------------------------------ */
    this._breathing(h);

    /* ---- action timers -------------------------------------------------- */
    this._fireCool = Math.max(0, this._fireCool - h);
    if (this._cycleT >= 0) {
      this._cycleT += h;
      const T = 0.44;
      // throw open, snap shut — asymmetric, the return is the faster half
      const t = this._cycleT / T;
      this.cycle = t < 0.55 ? ease(t / 0.55) : 1 - ease((t - 0.55) / 0.45);
      if (this._cycleT >= T) { this._cycleT = -1; this.cycle = 0; }
    }
    if (this._reloadT >= 0) {
      const prev = this._reloadT;
      this._reloadT += h;
      // one round every 0.28 s, thumbed into the loading gate
      const step = 0.28;
      const nBefore = Math.floor(prev / step), nAfter = Math.floor(this._reloadT / step);
      for (let i = nBefore; i < nAfter; i++) {
        if (this.ammo < this.capacity && this.reserve > 0) {
          this.ammo++; this.reserve--;
          /*
           * NO SOUND HERE. Audio._updateWeapon watches `ammo` and plays one
           * `shellIn` per increment — with per-round seat/vary shaping this
           * file has no business duplicating. Playing a `clink` here too gave
           * every cartridge TWO sounds, which is what the reload flam was.
           * The counter is the event; the audio system owns the sound.
           */
        }
      }
      if (this.ammo >= this.capacity || this.reserve <= 0 || this._reloadT > 3.0) this._reloadT = -1;
      this.hudT = 2.2;
    }

    /* ---- recoil springs -------------------------------------------------- */
    const R = this._rec;
    R.v += (-R.p * 220 - R.v * 19) * h; R.p += R.v * h;
    R.backV += (-R.back * 260 - R.backV * 21) * h; R.back += R.backV * h;
    this._camKickV += (-this.camKick * 110 - this._camKickV * 13) * h;
    this.camKick += this._camKickV * h;

    /* ---- fire ------------------------------------------------------------ */
    if (this._edgeFire) {
      this._edgeFire = false;
      this.fire();
    }

    /* ---- solve the transform --------------------------------------------- */
    this._solve(h);
  }

  /* ------------------------------------------------------------- breathing */

  _breathing(h) {
    const P = this.player;
    this._swayT += h;
    const aiming = this.aim01;

    // Holding steady only works while you are actually on the sights.
    const steadyWant = (this._wantSteady && aiming > 0.35 && this.breath > 0.02) ? 1 : 0;
    this._steady += (steadyWant - this._steady) * (1 - Math.exp(-9 * h));
    if (steadyWant) {
      this.breath = Math.max(0, this.breath - h / 4.2);
      if (this.breath <= 0.001) this._panic = 1;        // it runs out on you
    } else {
      this.breath = Math.min(1, this.breath + h / 6.5);
    }
    this._panic = Math.max(0, this._panic - h / 2.4);

    /*
     * Two incommensurate frequencies plus a slow drift: a single sine reads as
     * a machine, and a random walk reads as a bug. Amplitude climbs with how
     * hard the character has been working and collapses when he holds his
     * breath.
     */
    const exert = 0.55 + (P.speed01 || 0) * 1.9 + this._panic * 1.35;
    const amp = 0.0125 * aiming * exert * (1 - this._steady * 0.82);
    const t = this._swayT;
    this.swayYaw = (Math.sin(t * 0.83) * 0.62 + Math.sin(t * 1.97 + 1.1) * 0.30
      + Math.sin(t * 0.31 + 2.7) * 0.34) * amp;
    this.swayPitch = (Math.sin(t * 0.61 + 2.2) * 0.55 + Math.sin(t * 1.43) * 0.24
      + Math.sin(t * 0.23 + 0.7) * 0.30) * amp * 0.85;
    // the lever throw drags the sights down and to the right
    this.swayPitch -= this.cycle * 0.055 * aiming;
    this.swayYaw -= this.cycle * 0.030 * aiming;
    this.sway01 = Math.min(1, Math.hypot(this.swayYaw, this.swayPitch) / 0.02);
  }

  /* ------------------------------------------------------------------ solve */

  /**
   * Where the character's chest, head and aiming eye are THIS frame. Player
   * calls this from inside its own pose pass, once the spine and neck have
   * been rotated, so every number here is the live torso — not the bind pose
   * and not the root transform.
   */
  setAnchors(chestPos, chestQuat, eyePos, bodyQuat) {
    this.anchorChestPos.copy(chestPos);
    this.anchorChestQ.copy(chestQuat);
    this.anchorEye.copy(eyePos);
    if (bodyQuat) this.anchorBodyQ.copy(bodyQuat);
    return this;
  }

  /**
   * Build a weapon transform from a reference point that must be hit, a bore
   * direction and a roll hint — all in world space. `refLocal` is the point on
   * the carbine that lands on `refWorld`.
   */
  _frame(refLocal, refWorld, bore, up, outQ, outP) {
    _bz.copy(bore).normalize();
    _by.copy(up).addScaledVector(_bz, -up.dot(_bz));
    if (_by.lengthSq() < 1e-8) _by.set(0, 1, 0).addScaledVector(_bz, -_bz.y);
    _by.normalize();
    _bx.crossVectors(_by, _bz).normalize();
    _m.makeBasis(_bx, _by, _bz);
    outQ.setFromRotationMatrix(_m);
    outP.copy(refLocal).applyQuaternion(outQ).negate().add(refWorld);
  }

  _solve(h) {
    const P = this.player;
    const yaw = P.yaw + this.swayYaw;
    const pitch = THREE.MathUtils.clamp(P.pitch + this.swayPitch + this.camKick, -1.2, 1.0);
    const cp = Math.cos(pitch);
    this.aimDir.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp).normalize();

    const carry = smooth(this.drawn);
    const shoulder = smooth(this.aim01);

    /*
     * THE MUZZLE MUST POINT WHERE THE BULLET GOES.
     *
     * The trace runs from the LENS along the lens axis (see fire()), but the
     * carbine was aimed off the raw (yaw, pitch) the mouse writes — and the
     * camera reaches those through a lowpass, so while you were swinging onto
     * something the gun and the reticle disagreed by whole degrees. Measured
     * on a 90 deg/s pan it was 3.4 deg, which at 60 m is 3.5 m of miss between
     * what the barrel showed and where the round went. Fold the LENS AXIS in
     * with the shouldering weight: at full aim the bore is the shot line, to
     * the last decimal, because it is literally the same vector fire() reads.
     */
    if (shoulder > 0.001) {
      const camRig = this.ctx.get('camera');
      const cam = this.ctx.camera;
      if (cam && !(camRig && camRig.freeCam)) {
        _v.set(0, 0, -1).applyQuaternion(cam.quaternion);
        if (_v.lengthSq() > 1e-8) this.aimDir.lerp(_v.normalize(), shoulder).normalize();
      }
    }
    this.eyeWorld.copy(this.anchorEye);

    /* ---- pose 3: shouldered, sight line ON the aim ray ------------------- */
    // a few degrees of cant — a rifle held dead level looks like a prop
    _v2.set(0, 1, 0).applyAxisAngle(this.aimDir, -0.055);
    this._frame(EYE_LOCAL, this.eyeWorld, this.aimDir, _v2, _AIM_Q, _AIM_P);

    /* ---- pose 2: low ready ---------------------------------------------- */
    // Chest-anchored, so it rides the spine lean, the shoulder counter-rotation
    // and the saddle alike — no mounted special case anywhere.
    const cq = this.anchorChestQ, cp0 = this.anchorChestPos;
    _READY_P.copy(READY_PALM).applyQuaternion(cq).add(cp0);
    this._frame(GRIP_PALM, _READY_P,
      _v.copy(READY_BORE).applyQuaternion(cq),
      _v2.copy(READY_UP).applyQuaternion(cq), _READY_Q, _READY_POS);

    /* ---- pose 1: slung, flat on the back, muzzle clear of the brim ------- */
    _SLUNG_P.copy(SLUNG_MUZZLE).applyQuaternion(cq).add(cp0);
    this._frame(MUZZLE, _SLUNG_P,
      _v.copy(SLUNG_BORE).applyQuaternion(cq),
      _v2.copy(SLUNG_UP).applyQuaternion(cq), _SLUNG_Q, _SLUNG_POS);

    /* ---- blend ----------------------------------------------------------- */
    _POS.copy(_SLUNG_POS).lerp(_READY_POS, carry).lerp(_AIM_P, shoulder);
    _ROT.copy(_SLUNG_Q).slerp(_READY_Q, carry).slerp(_AIM_Q, shoulder);

    /* ---- recoil, applied to the weapon, so the hands follow it ----------- */
    _qa.setFromAxisAngle(_AXIS_X, this._rec.p);
    _ROT.multiply(_qa);
    _POS.addScaledVector(_v.set(0, 0, 1).applyQuaternion(_ROT), -this._rec.back);

    this.group.position.copy(_POS);
    this.group.quaternion.copy(_ROT);
    this.group.updateMatrixWorld(true);

    // Lever: 62 degrees of throw about its own pivot.
    this.meshLever.rotation.x = this.cycle * 1.08;
    // Hammer rides back with the lever and drops when the trigger breaks.
    this.meshSteel.rotation.set(0, 0, 0);

    this.gripWorld.copy(GRIP_LOCAL).applyQuaternion(_ROT).add(_POS);
    this.forendWorld.copy(FOREND_LOCAL).applyQuaternion(_ROT).add(_POS);
    this.muzzleWorld.copy(MUZZLE).applyQuaternion(_ROT).add(_POS);

    /* ---- publish the two hand sockets in world -------------------------- */
    this._socket(this.handR, GRIP_PALM, GRIP_DIR, GRIP_POLE, _ROT, _POS);
    this._socket(this.handL, FORE_PALM, FORE_DIR, FORE_POLE, _ROT, _POS);
    /*
     * Hands come off the weapon entirely once it is on the back. `drawn`
     * approaches zero asymptotically, so gate it with a dead zone or the arms
     * never quite return to their swing.
     */
    this.gripBlend = smooth(THREE.MathUtils.clamp((this.drawn - 0.06) / 0.94, 0, 1));
    void h;
  }

  _socket(out, palm, dir, pole, q, p) {
    out.palm.copy(palm).applyQuaternion(q).add(p);
    out.dir.copy(dir).applyQuaternion(q).normalize();
    out.pole.copy(pole).applyQuaternion(q).normalize();
    // The IK solves the WRIST; the hand mesh hangs PALM_DROP down its own axis.
    out.wrist.copy(out.palm).addScaledVector(out.dir, -PALM_DROP);
  }

  /* ------------------------------------------------------------------- fire */

  fire() {
    if (this.busy || this._fireCool > 0) return false;
    if (this.drawn < 0.35) { this._wantAim = false; this._holdT = 0; return false; }
    if (this.ammo <= 0) {
      const A = this.ctx.get('audio');
      if (A && A.play) A.play('clink', { position: this.muzzleWorld, volume: 0.4, pitch: 2.2 });
      this.hudT = 2.4;
      this.reload();
      return false;
    }
    this.ammo--;
    this._fireCool = 0.10;
    this._cycleT = 0;
    this._holdT = 0;
    this.hudT = 3.4;

    /* ---- the shot -------------------------------------------------------- */
    const rand = this.rand;
    // Spread grows with how far off the sights the sway has drifted, and a lot
    // more from the hip. A rifle fired from the waist should miss.
    const base = 0.0011 + (1 - this.aim01) * 0.028;
    const spread = base + (this.sway01 || 0) * 0.0032;
    const a1 = rand() * Math.PI * 2;
    const a2 = Math.sqrt(rand()) * spread;

    /*
     * THE RETICLE IS THE TRUTH, so the bullet is traced along it.
     *
     * Two earlier cuts both failed. Firing along the aim ray FROM THE MUZZLE
     * put every shot half a metre left of the reticle, because the lens sits
     * out over the right shoulder. Aiming the barrel at whatever the reticle
     * was on fixed the lateral error but not the vertical one: the muzzle is
     * a third of a metre below the lens, so a shot at a deer 57 m away over
     * gently rising ground buried itself in the dirt at 20 m while the reticle
     * had a clean line. Measured, that is exactly what happened.
     *
     * So the trace runs from the LENS along the lens axis — the line the player
     * is actually looking down — and the muzzle keeps only the flash, the smoke
     * and the report. Every third-person shooter makes this trade; the
     * alternative is a weapon that misses things you can plainly see.
     */
    const cam = this.ctx.camera;
    _dir.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    // cone the direction into a perpendicular basis
    _v.set(-_dir.z, 0, _dir.x).normalize();
    _v2.crossVectors(_dir, _v).normalize();
    _dir.addScaledVector(_v, Math.cos(a1) * a2).addScaledVector(_v2, Math.sin(a1) * a2).normalize();

    // start a metre down the barrel line so the character is never in the way
    const origin = _ORIGIN.copy(cam.position).addScaledVector(_dir, 1.0);
    this._resolveShot(origin, _dir);

    /* ---- flash, smoke, kick, report -------------------------------------- */
    const PT = this.ctx.get('particles');
    if (PT) {
      if (PT.burst) {
        PT.burst('muzzle', this.muzzleWorld, 16, { dir: _dir, scale: 1.25 });
        PT.burst('smoke', _v.copy(this.muzzleWorld).addScaledVector(_dir, 0.14), 5,
          { scale: 0.28 });
        PT.burst('sparks', this.muzzleWorld, 5, { scale: 0.5 });
      }
    }
    this._rec.v += 11.5;
    this._rec.backV += 2.4;
    this._camKickV += 0.62;
    // A rifle climbs. Some of it comes back, some of it you have to re-aim out.
    this.player.pitch = THREE.MathUtils.clamp(this.player.pitch + 0.011, -1.15, 0.95);

    const fx = this.ctx.get('postfx');
    if (fx && fx.shake) fx.shake(0.55, 0.30);
    const camRig = this.ctx.get('camera');
    if (camRig && camRig.shake) camRig.shake(0.35, 0.26);

    // Audio, Particles and Wildlife are all already listening for this.
    this.ctx.emit('gunshot', {
      position: this.muzzleWorld.clone(),
      direction: _dir.clone(),
      weapon: 'rifle',
      volume: 1,
      loudness: 1,
    });
    return true;
  }

  /**
   * Hitscan: people and animals first, terrain second, nearest wins. The
   * bullet is instantaneous — at 60 m the flight time of a .44-40 is a
   * twentieth of a second and no player has ever noticed its absence.
   *
   * PEOPLE AND ANIMALS GO DOWN THE SAME PIPE, and deliberately so: the reticle
   * feedback, the hit-marker tick and the notification all key off a single
   * `{killed, part}` result, so a wound reads the same whatever you shot. The
   * ONE thing that differs is that a person is somebody's neighbour, so the
   * NPC branch — and only the NPC branch — routes through the law. There is no
   * path from an animal to a wanted star anywhere in this file.
   */
  _resolveShot(origin, dir) {
    const ctx = this.ctx;
    const MAX = 420;
    const W = ctx.get('wildlife');
    let animal = null;
    if (W && W.raycastAnimals) animal = W.raycastAnimals(origin, dir, MAX);

    const law = this.player.wanted;
    let npc = null;
    if (law) {
      try { npc = law.raycast(origin, dir, MAX); } catch (e) { npc = null; }
    }

    const T = ctx.get('terrain');
    let ground = null;
    if (T && T.raycast) {
      try { ground = T.raycast(origin, dir, MAX); } catch (e) { ground = null; }
    }

    // nearest of the three wins
    if (npc && animal && animal.distance < npc.distance) npc = null;
    if (npc && ground && ground.distance < npc.distance) npc = null;
    if (npc) {
      const res = law.applyHit(npc, 1);
      this.lastShot = {
        hit: true, npc: true, species: npc.species, part: npc.part,
        killed: !!(res && res.killed), distance: npc.distance,
        point: npc.point.clone(),
      };
      this._impact(npc, res);
      return;
    }

    if (animal && (!ground || animal.distance < ground.distance)) {
      const res = W.applyHit(animal, 1);
      this.lastShot = {
        hit: true, species: animal.species, part: animal.part,
        killed: !!(res && res.killed), distance: animal.distance,
        point: animal.point.clone(),
      };
      this._impact(animal, res);
      return;
    }
    if (ground) {
      const PT = ctx.get('particles');
      if (PT && PT.burst) {
        PT.burst('dust', ground.point, 7, { scale: 0.5 });
        PT.burst('sparks', ground.point, 3, { scale: 0.35 });
      }
      this.lastShot = { hit: false, distance: ground.distance, point: ground.point.clone() };
    } else {
      this.lastShot = { hit: false, distance: MAX, point: null };
    }
  }

  /**
   * WHAT THE PLAYER LEARNS FROM A HIT.
   *
   * Three channels, and they are separated on purpose because they answer
   * three different questions at three different times:
   *
   *   the IMPACT   a soft thud out at the target, delayed by the flight of
   *                sound (d / 343). "Something over there was struck."
   *   the TICK     instant, at the listener, on the UI bus, dry. "*You* hit
   *                it." Delaying this by the sound flight — which is what the
   *                impact does — would put the confirmation a fifth of a
   *                second after the event at 60 m, which is long enough to
   *                stop reading as feedback at all.
   *   the RETICLE  orange for a wound, red for a kill, with a scale pulse
   *                decaying over 0.4 s. "…and it is dead / it is not."
   *
   * Orange-vs-red is carried by BOTH the reticle and the shape of the tick (a
   * kill is a falling two-note figure) so it survives with the sound off and
   * with the eyes on the animal rather than on the middle of the screen.
   */
  _impact(hit, res) {
    const ctx = this.ctx;
    const killed = !!(res && res.killed);
    const A = ctx.get('audio');
    if (A && A.play) {
      A.play('footstep', {
        // a round into a body is a wetter, duller thump than one into a deer
        position: hit.point, surface: hit.npc ? 'mud' : 'dirt',
        volume: 0.9, at: A.now() + hit.distance / 343,
      });
      if (res) A.play('hitmark', { kill: killed, volume: 1 });
    }
    const hud = ctx.get('hud');
    if (!hud || !res) return;
    if (hud.hitFeedback) hud.hitFeedback(killed ? 'kill' : 'hit');
    if (hud.notify) {
      hud.notify(killed
        ? `${hit.species} down — ${hit.part} shot`
        : `${hit.species} wounded`);
    }
  }

  /* -------------------------------------------------------------- teardown */

  dispose() {
    window.removeEventListener('mousedown', this._onDown);
    window.removeEventListener('mouseup', this._onUp);
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKeyUp);
    if (this.ctx.canvas) this.ctx.canvas.removeEventListener('contextmenu', this._onCtx);
    for (const m of [this.meshWood, this.meshSteel, this.meshLever]) {
      if (m) m.geometry.dispose();
    }
    if (this.matWood) this.matWood.dispose();
    if (this.matSteel) this.matSteel.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

/* -------------------------------------------------------------------- utils */

const _POS = new THREE.Vector3();
const _ROT = new THREE.Quaternion();
const _READY_Q = new THREE.Quaternion();
const _READY_P = new THREE.Vector3();
const _READY_POS = new THREE.Vector3();
const _SLUNG_Q = new THREE.Quaternion();
const _SLUNG_P = new THREE.Vector3();
const _SLUNG_POS = new THREE.Vector3();
const _AIM_Q = new THREE.Quaternion();
const _AIM_P = new THREE.Vector3();
const _ORIGIN = new THREE.Vector3();
const _AXIS_X = new THREE.Vector3(1, 0, 0);

function ease(t) { const x = t < 0 ? 0 : t > 1 ? 1 : t; return x * x * (3 - 2 * x); }
function smooth(t) { return ease(t); }
