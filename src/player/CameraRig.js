import * as THREE from 'three';

/**
 * RED SANDS — CAMERA RIG
 * ============================================================================
 * RDR2-style third person.
 *
 *   SPRING ARM   pivot at the character's shoulder height, arm behind and to
 *                the right, critically-damped follow on both the pivot and the
 *                orbit so the camera lags the character without wobbling.
 *   LOOK-AHEAD   the aim point leads the direction of travel, scaled by speed,
 *                so at a gallop you are looking where you are going.
 *   SPEED FEEL   the arm lengthens and the FOV widens with speed01, and both
 *                ease back in when you slow down.
 *   COLLISION    the arm is sphere-cast against terrain and registered bodies
 *                through Physics; blocked distance is pulled in fast and let
 *                back out slowly so it never pops.
 *   LIFE         low-amplitude handheld noise plus a gait-coupled bob, and a
 *                shake() impulse channel wired to PostFX.
 *
 *   setFreeCamera(pos, look, fov) is the screenshot harness contract: it
 *   completely overrides follow so captures are deterministic.
 * ============================================================================
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rgt = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const wrapPi = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

export class CameraRig {
  static id = 'camera';

  constructor(ctx) {
    this.ctx = ctx;
    this.camera = ctx.camera;

    this.freeCam = false;
    this._freePos = new THREE.Vector3();
    this._freeLook = new THREE.Vector3();
    this._freeFov = 50;

    this.pivot = new THREE.Vector3();
    this.aim = new THREE.Vector3();
    this.armLength = 4.2;
    this._arm = 4.2;
    this._armBlocked = 4.2;
    this.shoulder = 0.62;
    this.height = 1.60;
    this.baseFov = 48;
    this._fov = 48;
    this._yaw = 0;
    this._pitch = -0.10;
    this._pos = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
    this._init = false;

    this._shake = { amp: 0, t: 0, dur: 0 };
    this._noiseT = 0;
    this._bob = new THREE.Vector3();

    /** Terrain height under the pivot, heavily smoothed. Without this the
     *  camera swims over every 20 cm bump and the whole shot reads as amateur. */
    this._groundY = null;
    /** Stateful lift that keeps the lens off the ground without kinking. */
    this._floorY = 0;
    /** 0..1 how long we have been standing still — drives the settle. */
    this._still = 1;
    this._speedK = 0;
    /** 0..1 shouldered-weapon blend, mirrored from Weapon. */
    this._aim = 0;

    /* ---- mouse-look authority -------------------------------------------
     * Seconds since the player last moved the look. The yaw the player chose
     * (`_lookHold`) is what the rig actually points at; the character's own
     * facing only reclaims it once the hold below has expired. */
    this._lookIdleT = 99;
    this._lookHold = null;
    /** 0..1 ramp of the auto-recentre. Always eased, never switched. */
    this._recentre = 0;
    /** Seconds of mouse silence before auto-recentre may begin, standing. */
    this.lookHold = 3.4;
  }

  async init() {
    this.physics = this.ctx.get('physics');
    this.player = this.ctx.get('player');
    this.camera.near = 0.12;
    this.camera.far = 12000;
    this.camera.updateProjectionMatrix();

    /*
     * The rig has to know when the PLAYER moved the view, which is not the
     * same question as "did the character's yaw change" — mounted, the yaw
     * is dragged back toward the horse's heading on its own. Mirror Player's
     * gate exactly (pointer-locked mousemove) so the two agree frame for
     * frame about what counts as look input.
     */
    this._onLook = (e) => {
      if (!e.movementX && !e.movementY) return;
      if (document.pointerLockElement !== this.ctx.canvas) return;
      this._lookIdleT = 0;
    };
    window.addEventListener('mousemove', this._onLook);
    // A teleport rewrites the character's facing outright; the held yaw is
    // meaningless across it and must not be eased away from.
    this._onWarp = () => { this._lookHold = null; this._lookIdleT = 99; this._recentre = 0; };
    if (this.ctx.on) {
      this.ctx.on('teleport', this._onWarp);
      this.ctx.on('playerTeleported', this._onWarp);
    }
  }

  /* ------------------------------------------------------- harness contract */

  /**
   * Hard override used by the capture harness. Fully replaces follow
   * behaviour: no smoothing, no sway, no collision — deterministic frames.
   */
  setFreeCamera(pos, look, fov) {
    this.freeCam = true;
    this._freePos.copy(pos);
    this._freeLook.copy(look);
    if (fov) this._freeFov = fov;
    this._apply(this._freePos, this._freeLook, this._freeFov);
    return this;
  }

  /** Hand control back to the follow rig. */
  clearFreeCamera() { this.freeCam = false; }

  /** Camera impulse; PostFX also exposes shake() for its own purposes. */
  shake(intensity = 0.5, duration = 0.35) {
    this._shake.amp = Math.max(this._shake.amp, intensity);
    this._shake.dur = Math.max(this._shake.dur, duration);
    this._shake.t = 0;
    const fx = this.ctx.get('postfx');
    if (fx && fx.shake) fx.shake(intensity, duration);
  }

  _apply(pos, look, fov) {
    const cam = this.camera;
    cam.position.copy(pos);
    _m.lookAt(pos, look, UP);
    cam.quaternion.setFromRotationMatrix(_m);
    if (fov && Math.abs(cam.fov - fov) > 1e-4) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);
  }

  /* ================================================================= update */

  update(dt) {
    if (this.freeCam) {
      // re-assert every frame: nothing else may nudge the shot
      this._apply(this._freePos, this._freeLook, this._freeFov);
      return;
    }
    const player = this.player || (this.player = this.ctx.get('player'));
    const ctx = this.ctx;
    const h = Math.min(dt || 1 / 60, 1 / 20);

    const p = ctx.player.position;
    const speed01 = ctx.player.speed01 || 0;
    /*
     * MOUNTED IS NOW A SCALAR, NOT A BOOLEAN.
     *
     * Everything the rig does differently in the saddle — a higher pivot, a
     * longer arm, a wider lens, a lazier yaw — used to switch on the frame the
     * mode flag flipped. With a real 1.2 s mount animation under it that reads
     * as a cut in the middle of the move, so all four are interpolated on
     * Player.mountBlend instead, and the shot opens up a little further still
     * while the transition is actually running.
     */
    const mk = player && player.mountBlend != null
      ? player.mountBlend
      : (ctx.player.mode === 'mounted' ? 1 : 0);
    const trans = player && player.trans ? 1 : 0;
    this._mountK = this._mountK == null ? mk : this._mountK + (mk - this._mountK) * (1 - Math.exp(-11 * h));
    this._transK = this._transK == null ? trans
      : this._transK + (trans - this._transK) * (1 - Math.exp(-6 * h));
    const mounted = this._mountK;
    const tK = this._transK;
    const lerp = (a, b) => a + (b - a) * mounted;

    /* ---- desired pivot: shoulder height, offset to the right ------------- */
    /*
     * AIMING. Right mouse pulls the lens in over the shoulder and narrows the
     * lens: the arm comes down from four metres to one and a half, the offset
     * opens right so the character clears the sight picture, and the FOV drops
     * ten degrees, which is what actually sells "looking down the barrel".
     * The breathing sway is added HERE as well as to the weapon, so the world
     * drifts under a static reticle instead of the gun waving about on its own.
     */
    const wpn = player ? player.weapon : null;
    this._aim = wpn ? wpn.aim01 : 0;
    const aim = this._aim;
    const yawBase = player ? player.yaw : ctx.player.yaw;
    const yawSway = wpn ? wpn.swayYaw * aim : 0;
    const pitchIn = (player ? player.pitch : -0.1)
      + (wpn ? (wpn.swayPitch + wpn.camKick) * aim : 0);

    /*
     * The pivot rides a SMOOTHED ground height, not the character's feet.
     * Terrain detail is decimetre-scale; a camera that tracks it exactly
     * bobs continuously and destroys the illusion of a real operator. The
     * character is free to bounce over the bumps in front of a steady lens.
     * The smoothing has to give way on a real fall, or stepping off a ledge
     * leaves the lens hanging in the air.
     */
    const footY = p.y;
    if (this._groundY == null) this._groundY = footY;
    const gErr = footY - this._groundY;
    /*
     * The filter has to be constant in DISTANCE, not in time. A fixed 0.2 s
     * time constant is 0.3 m of ground at a walk and 2.5 m at a gallop — which
     * is why the first cut left the pivot floating a metre above the saddle on
     * descending ground and shoved horse and rider into the bottom of frame.
     * Scale the rate with ground speed and the filter smooths the same half
     * metre of terrain at every gait.
     */
    const hspd = Math.hypot(ctx.player.velocity.x, ctx.player.velocity.z);
    const gRate = Math.abs(gErr) > 1.6 ? 16 : (3.6 + hspd * 1.15 + Math.abs(gErr) * 3.5);
    this._groundY += gErr * (1 - Math.exp(-gRate * h));

    // Speed term, eased so the pull-back has inertia of its own.
    const speedK = speed01 * speed01;
    this._speedK += (speedK - this._speedK) * (1 - Math.exp(-(speedK > this._speedK ? 2.6 : 1.5) * h));
    const sk = this._speedK;
    this._still += ((speed01 < 0.04 ? 1 : 0) - this._still) * (1 - Math.exp(-1.6 * h));

    // Mounted, `p` is the horse's FEET; 2.30 put the aim point above the
    // rider's hat. Sit it on his chest and the pair fill the lower third.
    const targetHeight = lerp(this.height, 2.10)
      - (player ? player.crouch * 0.35 * (1 - mounted) : 0)
      + sk * lerp(0.16, 0.34)                  // rise a little as you open up
      + tK * 0.10                              // and a touch more mid-transition
      // Above the hat, not level with it: at the shooter's own eyeline the hat
      // brim filled a third of the frame and hid the barrel completely.
      + aim * 0.20;

    /* ---- yaw authority: the look you chose is yours ----------------------
     * The rig used to chase the character's facing EVERY frame, so the instant
     * the mouse stopped the shot started sliding back on its own — which is
     * exactly what the playtester described. Mouse-look now latches: while you
     * are looking, and for a hold afterwards, `_lookHold` IS the shot and the
     * character's facing is ignored (mounted, that facing is itself being
     * dragged back to the horse's heading half a second after you let go).
     *
     * When the hold finally expires the recentre eases IN from zero — the ramp
     * is squared on top of a lowpass, so there is no step in the rate — and it
     * is scaled by how fast you are travelling. Galloping, coming back round
     * onto the line of travel is a navigation aid. Standing still it is just
     * the camera taking the shot off you, so standing still it never happens
     * at all: look left at a halt and you keep looking left. Down the sights
     * the player is deliberately pointing the lens, so recentre is suspended.
     */
    this._lookIdleT += h;
    const looking = this._lookIdleT < 0.12;
    if (this._lookHold == null) this._lookHold = yawBase;
    if (looking) {
      this._lookHold = yawBase;                 // the mouse has the authority
      this._recentre = 0;
    } else {
      // Speed shortens the patience: at a sprint or a gallop you want to see
      // where you are going sooner than you do at a walk.
      const hold = this.lookHold - 1.5 * sk;
      const moveGate = clamp01((speed01 - 0.10) / 0.50);
      const want = this._lookIdleT > hold
        ? moveGate * Math.max(0, 1 - aim * 5)
        : 0;
      this._recentre += (want - this._recentre) * (1 - Math.exp(-1.05 * h));
      const re = this._recentre * this._recentre;
      if (re > 1e-4) {
        const dl = wrapPi(yawBase - this._lookHold);
        this._lookHold += dl * (1 - Math.exp(-(0.8 + 2.4 * sk) * re * h));
      }
    }
    const yawIn = this._lookHold + yawSway;

    _fwd.set(Math.sin(yawIn), 0, Math.cos(yawIn));
    _rgt.set(-_fwd.z, 0, _fwd.x);

    // Shoulder offset opens outward with speed so the character drifts off
    // centre and you can see the ground you are about to cover.
    /*
     * Aiming pulls the lens IN, which means the same lateral offset now
     * subtends a much bigger angle: measured, 0.92 m of shoulder at a 1.54 m
     * arm put the rifle 31 degrees off axis with a 26 degree half-FOV — i.e.
     * entirely outside the frame. The gun leading into the lower corner is the
     * single strongest read that you are aiming one, so the offset has to come
     * DOWN as the arm shortens, not up.
     */
    const shoulder = this.shoulder * (1 + sk * 0.55) * (1 - aim * 0.18);
    _v.set(p.x, this._groundY + targetHeight, p.z).addScaledVector(_rgt, shoulder);
    if (!this._init) {
      this.pivot.copy(_v); this._yaw = yawIn; this._pitch = pitchIn;
      this._fov = this.baseFov; this._init = true;
    }
    /*
     * Horizontal follow is deliberately SOFT and gets softer as you speed up:
     * the pivot trails the character, so the frame opens up ahead of you when
     * you break into a run and closes again when you stop. That trailing is
     * the single strongest "heavy camera" cue there is.
     */
    const kx = 1 - Math.exp(-(lerp(8.2 - 2.4 * sk, 9.0 - 1.0 * sk) - tK * 2.2) * h);
    this.pivot.x += (_v.x - this.pivot.x) * kx;
    this.pivot.z += (_v.z - this.pivot.z) * kx;
    this.pivot.y += (_v.y - this.pivot.y) * (1 - Math.exp(-7.5 * h));

    /* ---- orbit ----------------------------------------------------------- */
    let dy = yawIn - this._yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    // Responsive when you are just looking around, laggy once you are moving,
    // and never faster than an operator could physically swing the body.
    // Down the sights the lag has to go: a laggy aim is an unusable aim.
    const yawRate = (lerp(9.6, 6.4) - lerp(3.4, 2.4) * sk) + aim * 14;
    const maxStep = (5.6 + 3.4 * (1 - sk) + aim * 9) * h;
    let step = dy * (1 - Math.exp(-yawRate * h));
    if (step > maxStep) step = maxStep;
    else if (step < -maxStep) step = -maxStep;
    this._yaw += step;
    // Tilt down a touch at speed: you want the ground, not the sky.
    const pitchT = pitchIn - sk * lerp(0.05, 0.075);
    this._pitch += (pitchT - this._pitch) * (1 - Math.exp(-9 * h));

    /* ---- arm length + FOV widen with speed ------------------------------- */
    /*
     * The pivot TRAILS the character by roughly v/followRate — at a flat
     * gallop that is well over a metre before the arm is even considered.
     * Measured end to end the first pass put the lens 11.6 m behind the horse
     * at 62 degrees, which is a satellite view, not a chase. Budget the total
     * (lag + arm) to about eight metres.
     */
    // ...and stand off a little further, a little wider, while the rider is
    // climbing on or off — you want to see the whole action, not his shoulder.
    this.armLength = (lerp(4.05, 5.25) + sk * lerp(1.35, 1.55) + tK * 0.70)
      * (1 - aim * 0.52);
    const fovT = (this.baseFov + sk * lerp(6.5, 9.5) + tK * 3.5) - aim * 10.5;
    // The speed-widen is deliberately lazy, but the aim narrow must not be —
    // measured, a 1.4/s lowpass was still 7 degrees wide 0.7 s into the raise.
    const fovRate = this._aim > 0.02 ? 9.0 : (fovT > this._fov ? 2.2 : 1.4);
    this._fov += (fovT - this._fov) * (1 - Math.exp(-fovRate * h));

    /* ---- look-ahead in the direction of travel --------------------------- */
    const vel = ctx.player.velocity;
    _v2.set(vel.x, 0, vel.z);
    const vlen = _v2.length();
    /*
     * The lead has to be modest. At 0.17 s of travel a galloping horse's look
     * target sits 2.2 m ahead of the saddle, which tips the whole animal into
     * the bottom of the frame — measured, the hooves were cut off by the edge.
     * A tenth of a second reads as "looking where you are going" without
     * shoving the subject out of shot.
     */
    // ...and there is no lead at all down the sights: any lateral offset on the
    // look target rotates the lens off the aim ray, and the reticle IS the aim.
    if (vlen > 0.2) {
      _v2.multiplyScalar(Math.min(vlen, 13) * lerp(0.13, 0.10) * (1 - aim) / vlen);
    } else _v2.set(0, 0, 0);
    // Leads out quickly, settles back slowly — the lead should feel earned.
    this.aim.lerp(_v2, 1 - Math.exp(-(_v2.lengthSq() > this.aim.lengthSq() ? 3.2 : 1.5) * h));

    /* ---- assemble -------------------------------------------------------- */
    const cy = Math.cos(this._pitch), sy = Math.sin(this._pitch);
    _fwd.set(Math.sin(this._yaw) * cy, sy, Math.cos(this._yaw) * cy).normalize();
    const want = _v.copy(this.pivot).addScaledVector(_fwd, -this.armLength);

    /* ---- collision: sphere-cast the arm --------------------------------- */
    /*
     * A camera that punches through a hillside destroys the illusion faster
     * than any texture flaw, so the arm is cast with a generous probe radius
     * (0.45 — larger than the near plane's corner reach at this FOV) and the
     * result is only ever allowed to SHORTEN instantly. Letting back out is
     * slow, and slower still while you are moving, so running along a bank
     * does not pump the arm in and out once a second.
     */
    let allowed = this.armLength;
    if (this.physics && this.physics.sphereCast) {
      _v2.copy(want).sub(this.pivot);
      const len = _v2.length();
      if (len > 1e-4) {
        _v2.multiplyScalar(1 / len);
        const hit = this.physics.sphereCast(this.pivot, _v2, 0.45, len + 0.25);
        if (hit) allowed = Math.max(0.75, hit.distance - 0.22);
      }
    }
    if (allowed < this._armBlocked) this._armBlocked = allowed;
    else this._armBlocked += (allowed - this._armBlocked) * (1 - Math.exp(-(1.6 + 1.6 * this._still) * h));
    const arm = Math.min(this.armLength, this._armBlocked);
    this._pos.copy(this.pivot).addScaledVector(_fwd, -arm);

    /*
     * Last line of defence: the lens itself never goes under the ground.
     * The floor is smoothed rather than clamped hard — a raw clamp kinks the
     * shot every time you crest a ridge, which reads as a stutter.
     */
    const gy = this.ctx.world.getHeight(this._pos.x, this._pos.z);
    const floor = Number.isFinite(gy) ? gy + 0.55 : -1e9;
    const deficit = Math.max(0, floor - this._pos.y);
    // Lift rises almost instantly and relaxes slowly, so the shot rides up the
    // bank without a kink and comes back down without a snap.
    this._floorY += (deficit - this._floorY) * (1 - Math.exp(-(deficit > this._floorY ? 30 : 3.2) * h));
    this._pos.y += this._floorY;
    if (this._pos.y < floor) this._pos.y = floor;               // hard backstop

    /* ---- handheld life + gait bob + shake -------------------------------- */
    this._noiseT += h;
    const n = this._noiseT;
    // A little more life at rest than in motion — a held shot breathes, a
    // moving one is already busy.
    const life = (0.7 + 0.5 * this._still) * (1 - this._aim * 0.8);
    const swayX = (Math.sin(n * 0.73) * 0.010 + Math.sin(n * 1.61) * 0.005) * life;
    const swayY = (Math.sin(n * 0.51 + 1.3) * 0.011 + Math.sin(n * 1.27) * 0.004) * life;
    // Mounted, the bob has to come off the HORSE's gait or it freezes solid:
    // the rider's own gait clock stops the moment he is in the saddle.
    const horse = mounted > 0.5 ? this.ctx.player.horse : null;
    const gp = horse ? horse.gaitPhase : (player ? player.gaitPhase : 0);
    const gaitPhase = gp * Math.PI * 2;
    const bobAmp = lerp(0.020, 0.042) * speed01;
    _v2.set(
      Math.sin(gaitPhase) * bobAmp * 0.5 + swayX,
      -Math.abs(Math.cos(gaitPhase)) * bobAmp + swayY,
      0,
    );
    this._bob.lerp(_v2, 1 - Math.exp(-16 * h));

    if (this._shake.dur > 0) {
      this._shake.t += h;
      const k = Math.max(0, 1 - this._shake.t / this._shake.dur);
      const a = this._shake.amp * k * k * 0.12;
      this._bob.x += Math.sin(this._shake.t * 61.3) * a;
      this._bob.y += Math.sin(this._shake.t * 47.7 + 2.1) * a;
      if (k <= 0) { this._shake.dur = 0; this._shake.amp = 0; }
    }

    _rgt.set(-Math.cos(this._yaw), 0, Math.sin(this._yaw));
    this._pos.addScaledVector(_rgt, this._bob.x).addScaledVector(UP, this._bob.y);

    /*
     * DOWN THE SIGHTS THE LENS AXIS MUST *BE* THE AIM RAY.
     *
     * The look target carried a 5 cm lift and the shake/bob moved the lens but
     * not the target — over a 1.9 m arm that is 1.5 degrees of pitch, i.e. the
     * reticle sat 1.3 m above the point the iron sights were on at 57 m. The
     * bullet followed the reticle (correct) and the gun visibly pointed
     * somewhere else (not correct). While aiming, fold the lift away and apply
     * the bob to BOTH ends, so the shake becomes a pure translation and the
     * camera axis stays exactly parallel to (yaw, pitch).
     */
    this._lookAt.copy(this.pivot).add(this.aim).addScaledVector(UP, 0.05 * (1 - aim));
    if (aim > 0.001) {
      this._lookAt.addScaledVector(_rgt, this._bob.x * aim)
        .addScaledVector(UP, this._bob.y * aim);
    }
    this._apply(this._pos, this._lookAt, this._fov);
  }

  resize() { /* aspect is owned by Engine */ }

  dispose() {
    if (this._onLook) window.removeEventListener('mousemove', this._onLook);
    this._onLook = null;
  }
}
