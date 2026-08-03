import * as THREE from 'three';
import { rng } from '../core/Context.js';
import { buildSpecies } from './wildlife/Bodies.js';
import { ANIM_PARS, ANIM_BEGIN } from './wildlife/AnimShader.js';

/**
 * ============================================================================
 *  WILDLIFE — herds, flocks and the small movements that make a place live.
 * ============================================================================
 *
 *  One InstancedMesh per species (5 draw calls, plus the shadow cascades).
 *  Bodies are merged boxes built procedurally at boot; every vertex carries a
 *  part id and a pivot, and a vertex-shader patch swings the legs, bobs the
 *  head, flicks the tail and flaps the wings from three per-instance floats.
 *  That keeps skinning off the CPU entirely: 60 animals cost one matrix
 *  update each.
 *
 *  BEHAVIOUR
 *   • Deer / pronghorn move as HERDS with a shared state machine —
 *     graze → alert (head up, all facing the disturbance) → flee (they run as
 *     one, then settle). The player is the disturbance; distance and approach
 *     speed decide which.
 *   • Rabbits hop in short bursts and freeze between them.
 *   • Songbirds flock with classic boids (separation / alignment / cohesion +
 *     a home-tether) and startle upward when the player closes.
 *   • Raptors circle on a slow thermal, banking into the turn.
 *   • Crows sit still on the ground/perches and take off when approached.
 *   • Fish rise in the river: a ripple ring and a splash, via Particles.
 *
 *  Locomotion is ground-planted: every animal's Y comes from
 *  ctx.world.getHeight and its pitch/roll from ctx.world.getNormal, and the
 *  gait is CLOSED against the vertex shader's own kinematics (see LOCO below),
 *  so the stance hoof is world-static at any speed.
 *
 *  Population is driven by ctx.world.getSurface — grass carries deer and
 *  rabbits, rock carries raptors — and everything streams in and out around
 *  ctx.player.position.
 */

const SPECIES = {
  deer: {
    count: 22, groups: 4, groupSize: [3, 7], radius: 300, despawn: 460,
    speed: [0.85, 7.6], scale: [0.92, 1.14], surface: 'grass',
    colour: [0.30, 0.205, 0.125], shadow: true,
  },
  rabbit: {
    count: 16, groups: 6, groupSize: [1, 3], radius: 120, despawn: 190,
    speed: [0.3, 4.6], scale: [0.85, 1.1], surface: 'grass',
    colour: [0.32, 0.28, 0.225], shadow: true,
  },
  crow: {
    count: 10, groups: 3, groupSize: [2, 5], radius: 150, despawn: 230,
    speed: [0.0, 9.0], scale: [0.9, 1.1], surface: 'any',
    colour: [0.045, 0.045, 0.055], shadow: true,
  },
  bird: {
    count: 48, groups: 2, groupSize: [16, 28], radius: 260, despawn: 420,
    speed: [4, 13], scale: [0.7, 1.0], surface: 'any',
    colour: [0.20, 0.175, 0.14], shadow: false,
  },
  raptor: {
    count: 4, groups: 4, groupSize: [1, 1], radius: 520, despawn: 900,
    speed: [7.5, 10.5], scale: [1.0, 1.25], surface: 'any',
    colour: [0.16, 0.115, 0.075], shadow: false,
  },
};

/**
 * ---------------------------------------------------------------------------
 * SENSES — sight, hearing and SCENT
 * ---------------------------------------------------------------------------
 * An animal that orbits you at four metres and keeps grazing is not an animal,
 * it is scenery with a walk cycle. Every agent runs a three-channel detector
 * against the player and integrates the result into one `aware` meter:
 *
 *   SIGHT    a forward cone of `cone` radians out to `sight` metres, gated on a
 *            terrain line-of-sight test. Movement is what gives you away: a
 *            sprinting silhouette is spotted from three times as far as a
 *            crouched, still one.
 *   HEARING  a radius that scales with how loud the player is being. Crouching
 *            is quiet, walking is audible, a sprint or a gallop is very loud.
 *            `ctx.player.noise` is published by Player for exactly this.
 *   SCENT    the RDR2 mechanic. Scent is carried DOWNWIND, so an animal that
 *            happens to be on the far side of the player from the wind picks
 *            them up from three or four times the visual range — and one on the
 *            upwind side never smells them at all. This is what makes
 *            `ctx.env.windVector` a gameplay system instead of a shader input.
 *
 * `flight` is the flight-initiation distance: inside it, any detection at all
 * is enough to send them. `calm` is how many seconds of no contact it takes to
 * bleed a full alarm back to zero.
 *
 * Two optional knobs decide how much STEALTH is worth against this species:
 *   `still`   the sight rate of a player who is not moving at all. It is a
 *             floor, so it also sets how fast the meter fills for someone
 *             creeping. This matters more than it looks: awareness is a time
 *             integral, so halving your approach speed doubles how long you
 *             spend inside the sight cone. With a high floor, creeping in is
 *             WORSE than walking in — the exact opposite of what the player is
 *             being asked to believe — and every stealth approach fails at the
 *             same range as a stroll. Measured that way round before this
 *             existed: crouch-creeping a rabbit and walking at it both broke
 *             the animal at ~21 m.
 *   `stealth` how much of the sight rate a full crouch removes.
 * Both default to the deer's values so nothing else in the roster shifts.
 */
const STILL_DFLT = 0.30, STEALTH_DFLT = 0.55;

/**
 * The alarm level one unit of stimulus can SUSTAIN (see the integrate block in
 * `_sense`). `aware` climbs at the old rate until it reaches `rate * this`, and
 * bleeds back down above it, so the stimulus fixes an equilibrium instead of
 * only a slope.
 *
 * 4.5 is picked off the measured channel strengths, not by feel. A player
 * walking at a rabbit is HEARD at rate 0.32 and a sprinter at 0.36; both cap
 * out over 1.35, so both still saturate and the flight-initiation distances are
 * untouched (measured: walk 21.8 m, sprint 36.0 m, identical before and after).
 * A motionless silent player at 30 m is SEEN at rate ~0.011, which sustains
 * 0.05 — under the 0.14 that even registers as noticing something. The gap
 * between those two numbers is where the whole fix lives, and it is a factor of
 * thirty, so the constant is nowhere near a knife edge.
 */
const AWARE_SUSTAIN = 4.5;

/** Floor of the player-facing multiplier: back fully turned is worth this. */
const FACE_MIN = 0.34;
const SENSE = {
  deer: {
    sight: 92, cone: 2.55, hear: 62, scent: 180, flight: 40, calm: 24,
    style: 'bolt', hp: 1.0, bold: 0.0,
  },
  /*
   * A rabbit sees less far than a deer but is far twitchier about what it does
   * see: near-panoramic eyes, and a flight-initiation distance that is huge
   * relative to the size of the animal. Measured by driving a player in from
   * 60 m, upwind so scent is out of it: head up at ~24 m and the bolt at
   * ~19-21 m at a walk; ~47 m / ~38 m at a sprint; ~16 m / ~14 m crouched and
   * creeping. Downwind it makes no odds how quiet you are — they smell you at
   * ~53 m and are gone by ~48 m, exactly as the deer do.
   */
  rabbit: {
    sight: 32, cone: 3.90, hear: 28, scent: 66, flight: 15, calm: 14,
    still: 0.10, stealth: 0.78,
    style: 'freeze', hp: 0.4, bold: 0.0,
  },
  crow: {
    sight: 58, cone: 4.20, hear: 44, scent: 0, flight: 24, calm: 9,
    style: 'flush', hp: 0.3, bold: 0.0,
  },
  bird: {
    sight: 66, cone: 4.40, hear: 46, scent: 0, flight: 34, calm: 8,
    style: 'flush', hp: 0.25, bold: 0.0,
  },
  raptor: {
    sight: 300, cone: 2.00, hear: 0, scent: 0, flight: 0, calm: 5,
    style: 'none', hp: 0.4, bold: 0.0,
  },
};

/** Threat states. Anything above UNAWARE stops grazing. */
const UNAWARE = 0, ALERT = 1, WARY = 2, FLEE = 3, AGGRESSIVE = 4;

/**
 * ---------------------------------------------------------------------------
 * BODIES — the collider, as opposed to the hit box
 * ---------------------------------------------------------------------------
 * `HITBOX` above is what the BULLET tests against: four small spheres, because
 * a hunting model has to tell a head shot from a gut shot. That is the wrong
 * shape for "you cannot walk through a deer" — the player would slip between
 * the spheres — and the wrong population too, since a bird forty metres up
 * should not be a wall.
 *
 * So the solid body is one upright capsule per ground animal, registered with
 * Physics as a DYNAMIC collider whose `position` is the agent's own `a.pos`
 * Vector3. Sharing the reference is the whole trick: the capsule tracks the
 * animal at zero cost per frame, with no copy and no dirty flag.
 *
 *   [radius, height]  in metres at scale 1.
 * Flying species get nothing. A crow on the ground gets a small one and it is
 * switched off the moment it takes to the air.
 */
const BODY = {
  deer: [0.42, 1.45],
  rabbit: [0.16, 0.34],
  crow: [0.13, 0.40],
};
/** A carcass is still an obstacle, but a low, wide one you can step over. */
const CARCASS_H = 0.42;

/**
 * Hit boxes, in body lengths, relative to the agent's own frame:
 * [forward, up, radius] scaled by the agent's scale. Three spheres is enough to
 * tell a head shot from a gut shot from a leg, which is all the hunting model
 * needs to know.
 */
const HITBOX = {
  deer: [
    [0.62, 1.28, 0.16, 'head'],      // instant
    [0.16, 1.00, 0.24, 'vital'],     // heart/lung, just behind the shoulder
    [-0.34, 0.94, 0.28, 'body'],     // gut — a wound, not a kill
    [0.0, 0.42, 0.20, 'leg'],
  ],
  rabbit: [[0.14, 0.24, 0.07, 'head'], [-0.02, 0.17, 0.10, 'vital']],
  crow: [[0.10, 0.24, 0.05, 'head'], [-0.02, 0.18, 0.09, 'vital']],
  bird: [[0.06, 0.02, 0.05, 'head'], [-0.02, 0.0, 0.08, 'vital']],
  raptor: [[0.10, 0.02, 0.07, 'head'], [-0.04, 0.0, 0.13, 'vital']],
};

/**
 * Damage multiplier by where it landed. This table IS the hunting skill curve:
 * a clean shot behind the shoulder drops the animal on the spot, and anything
 * further back sends it over the ridge bleeding, which you then have to track.
 */
const PART_DMG = { head: 4.0, vital: 1.6, body: 0.60, leg: 0.30 };

/**
 * ---------------------------------------------------------------------------
 * GAIT, CLOSED AGAINST THE SHADER
 * ---------------------------------------------------------------------------
 * AnimShader swings each leg by A = 0.12 + gait*0.62 radians about a pivot
 * `legLen` above the foot, so the foot sweeps 2*legLen*sin(A) fore-and-aft.
 * A planted foot is world-static only if the body covers exactly that sweep
 * while the foot is on the ground, i.e. over `duty` of the cycle:
 *
 *     distance per stride = 2 * legLen * sin(A) / duty
 *     stride frequency    = groundSpeed / distance per stride
 *
 * Everything else — how fast it can run, how hard it can turn — is behaviour;
 * THIS is the bit that decides whether it reads as an animal running or as a
 * model being dragged along the ground. Drive it from the MEASURED ground
 * speed and the ratio is 1.000 by construction at every speed and every gait.
 *
 * `stride` is the preferred stride length in metres at a given speed: animals
 * lengthen the stride as they speed up and then saturate, at which point
 * cadence takes over. Both ends are clamped by what the shader can physically
 * swing, so the invariant never breaks.
 */
const LOCO = {
  deer: {
    legLen: 0.90, duty: 0.50,
    stride: (sp) => 0.75 + 0.30 * sp,
    accel: 3.6, decel: 5.4,
    turnFast: 1.9, turnSlow: 4.6,          // rad/s at full speed / at a walk
    browse: 0.85, flee: 7.6, settle: 4.2,
    bands: [1.7, 4.2, 6.4],                // walk | trot | canter | gallop
  },
  rabbit: {
    legLen: 0.17, duty: 0.32,
    stride: (sp) => 0.28 + 0.10 * sp,
    accel: 7.5, decel: 9.0,
    turnFast: 3.4, turnSlow: 7.0,
    browse: 0.9, flee: 4.6, settle: 2.6,
    bands: [0.9, 2.2, 3.4],
  },
};

/**
 * Solve the gait for one agent and advance its phase. Returns the stride
 * frequency in Hz. `sp` must be the speed the animal ACTUALLY moved this
 * frame, not the speed it wanted.
 */
function stride(a, L, sp, dt) {
  if (sp < 0.06) {
    // Standing. Bleed the swing out rather than snapping the legs straight,
    // and keep a trickle of phase so the tail still flicks — at this rate the
    // hooves creep under a centimetre a second, which reads as "alive".
    a.gait += (0 - a.gait) * Math.min(1, dt * 3.0);
    a.phase += dt * 0.22;
    a.freq = 0;
    return 0;
  }
  const reach = L.legLen * a.scale;
  let want = L.stride(sp);
  // clamp the stride to what the shader's swing can actually cover
  const A = clampf(Math.asin(clamp01(want * L.duty / (2 * reach))), 0.12, 0.74);
  const real = 2 * reach * Math.sin(A) / L.duty;
  const f = sp / real;
  a.gait = clamp01((A - 0.12) / 0.62);
  a.phase += 6.2831853 * f * dt;
  a.freq = f;
  return f;
}

/** Which gait band a speed falls in: 0 walk, 1 trot, 2 canter, 3 gallop. */
function gaitBand(L, sp) {
  return sp < L.bands[0] ? 0 : sp < L.bands[1] ? 1 : sp < L.bands[2] ? 2 : 3;
}

export class Wildlife {
  static id = 'wildlife';

  constructor(ctx) {
    this.ctx = ctx;
    this.rand = rng((ctx.seed ^ 0x2f6d51a3) >>> 0);
    this.enabled = true;
    /** Global population multiplier. */
    this.density = 1;

    this._species = new Map();
    this._groups = [];
    this._t = 0;
    this._fishAcc = 0;
    this._ready = false;

    /* --- perception scratch, refreshed once per frame -------------------- */
    this._noise = 0.4;         // how loud the player is being, 0..~2
    this._windX = 1; this._windZ = 0; this._windLen = 0;
    /** Round-robin cursor: only a slice of the population senses each frame. */
    this._senseCursor = 0;
    /** Carcasses waiting to be skinned. */
    this.carcasses = [];
    /** Running tally, read by the HUD. */
    this.kills = 0;
    this.pelts = 0;
    this._senseMs = 0;
  }

  /* ------------------------------------------------------------------ init */

  async init() {
    const ctx = this.ctx;
    const q = ctx.quality || {};
    const scale = q.name === 'low' ? 0.4 : q.name === 'medium' ? 0.7 : 1;

    for (const name of Object.keys(SPECIES)) {
      const def = SPECIES[name];
      const count = Math.max(2, Math.round(def.count * scale * this.density));
      const geo = buildSpecies(name, this.rand);

      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(def.colour[0], def.colour[1], def.colour[2]),
        roughness: 0.86,
        metalness: 0,
        fog: false,
        dithering: true,
      });
      const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking });
      depth.userData.rsNoAerial = true;
      depth.userData.rsNoGroundFX = true;
      patchAnim(mat, name);
      patchAnim(depth, name);

      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.customDepthMaterial = depth;
      mesh.frustumCulled = false;
      mesh.name = 'wildlife:' + name;
      mesh.castShadow = !!def.shadow;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

      const anim = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
      anim.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aAnim', anim);

      ctx.scene.add(mesh);

      const S = {
        name, def, mesh, mat, geo, anim, count,
        sense: SENSE[name] || SENSE.deer,
        hitbox: HITBOX[name] || HITBOX.deer,
        body: BODY[name] || null,
        agents: [],
        active: 0,
      };
      for (let i = 0; i < count; i++) {
        S.agents.push({
          alive: false, group: -1,
          pos: new THREE.Vector3(), vel: new THREE.Vector3(),
          yaw: 0, pitch: 0, roll: 0, scale: 1,
          phase: this.rand() * 6.2831, gait: 0, speed: 0, freq: 0,
          state: 0, timer: 0, bob: 0, circle: 0, home: new THREE.Vector3(),
          // a fixed slot in the herd (polar, around the group centre) and the
          // graze clock — a grazing animal is STILL most of the time and takes
          // a few steps now and then, not a perpetual drifter.
          slotA: 0, slotR: 0, rest: 0, moving: 0, want: 0,
          /* --- senses & threat (see SENSE above) --- */
          aware: 0, threat: UNAWARE, cue: 0, calmT: 0, senseT: 0,
          contagion: 0, holdT: 0, aggroT: 0,
          /* --- being shot at --- */
          hp: 1, wounded: 0, bleedT: 0, dying: 0, dead: 0, lie: 0,
          deadT: 0, bloodT: 0, tip: 1.48, dist: 1e9,
          /* solid body — allocated once in _bodies(), never per spawn */
          col: null,
        });
      }
      this._species.set(name, S);

      // parked instances live at the origin until placed; hide them
      const m = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < count; i++) mesh.setMatrixAt(i, m);
      mesh.instanceMatrix.needsUpdate = true;
    }

    ctx.on('ready', () => {
      const L = ctx.get('lighting');
      if (L && L.requestShadowCaster) {
        for (const [, S] of this._species) {
          if (S.def.shadow) L.requestShadowCaster(S.mesh);
        }
      }
      const sky = ctx.get('sky');
      if (sky && sky.injectAerialPerspective) {
        for (const [, S] of this._species) sky.injectAerialPerspective(S.mat);
      }
      const clouds = ctx.get('clouds');
      if (clouds && clouds.injectGroundFX) {
        for (const [, S] of this._species) clouds.injectGroundFX(S.mat);
      }
      this._bodies();
      this._populate(true);
      this._ready = true;
    });

    ctx.on('teleport', () => { this._despawnAll(); this._populate(true); });
    /*
     * A rifle report carries. This is the single line that ties the hunt back
     * to the perception model: the shot that takes one animal is what empties
     * the whole valley, and that consequence is the reason to stalk at all.
     */
    ctx.on('gunshot', (e) => {
      const pos = (e && e.position) || ctx.player.position;
      const loud = (e && e.loudness) || 1;
      this.alarm(pos, 210 * loud, 1);
    });
  }

  /* ----------------------------------------------------------- solid bodies */

  /**
   * One capsule per ground animal, allocated ONCE for the whole pool (alive or
   * not) and simply switched off while the slot is empty. Allocating on spawn
   * would mean a `dynamics.splice` every time a deer walked out of range, which
   * is churn for no benefit — the pool is 38 capsules.
   */
  _bodies() {
    const PH = this.ctx.get('physics');
    if (!PH || typeof PH.addCollider !== 'function') return;
    const L = PH.LAYER;
    for (const [name, S] of this._species) {
      if (!S.body) continue;
      for (const a of S.agents) {
        if (a.col) continue;
        a.col = PH.addCollider({
          shape: 'capsule',
          kind: 'dynamic',
          position: a.pos,                 // LIVE reference — see BODY above
          radius: S.body[0],
          height: S.body[1],
          mask: L.ANIMAL,
          tag: name,
          owner: a,
          enabled: false,
        });
      }
    }
    this._PH = PH;
  }

  /**
   * Push the current size/liveness of every agent onto its capsule. This is the
   * only per-frame cost of the whole collision story for wildlife: three field
   * writes on the animals that changed state, and nothing at all on the rest.
   */
  _syncBodies(S) {
    if (!S.body) return;
    const br = S.body[0], bh = S.body[1];
    for (const a of S.agents) {
      const c = a.col;
      if (!c) continue;
      const live = a.alive && !(S.name === 'crow' && a.state >= 0.5);
      if (!live) { if (c.enabled) c.enabled = false; continue; }
      const want = (a.dead || a.dying) ? 2 : 1;
      if (c.enabled && c._st === want && c._sc === a.scale) continue;
      c.enabled = true; c._st = want; c._sc = a.scale;
      if (want === 2) {
        // a carcass is a low, wide obstacle, not a standing animal
        c.radius = br * a.scale * 1.25;
        c.height = CARCASS_H * a.scale;
        c.mask = this._PH.LAYER.CORPSE;
      } else {
        c.radius = br * a.scale;
        c.height = bh * a.scale;
        c.mask = this._PH.LAYER.ANIMAL;
      }
    }
  }

  /* ------------------------------------------------------------- placement */

  _ground(x, z) {
    const w = this.ctx.world;
    if (w && w.ready && w.getHeight) {
      try { return w.getHeight(x, z); } catch (e) { /* not ready */ }
    }
    return 0;
  }

  _surfaceOK(kind, x, z) {
    const w = this.ctx.world;
    if (kind === 'any' || !w || !w.getSurface) return true;
    try {
      const s = w.getSurface(x, z);
      if (kind === 'grass') return (s.grass || 0) + (s.dirt || 0) * 0.5 > 0.28;
      return true;
    } catch (e) { return true; }
  }

  _despawnAll() {
    for (const [, S] of this._species) {
      for (const a of S.agents) a.alive = false;
      S.active = 0;
    }
    this._groups.length = 0;
  }

  /** Spawn groups around the player until each species hits its population. */
  _populate(force) {
    const ctx = this.ctx;
    const p = ctx.player.position;
    const r = this.rand;

    for (const [name, S] of this._species) {
      const def = S.def;
      // retire anything that has drifted out of range
      for (const a of S.agents) {
        if (!a.alive) continue;
        const dx = a.pos.x - p.x, dz = a.pos.z - p.z;
        if (dx * dx + dz * dz > def.despawn * def.despawn) a.alive = false;
      }
      let live = 0;
      for (const a of S.agents) if (a.alive) live++;
      if (live >= S.count) continue;

      let guard = 24;
      while (live < S.count && guard-- > 0) {
        // group centre: a ring around the player, biased to the far half so
        // animals appear at distance and walk in rather than popping in close
        const ang = r() * 6.2831;
        const dist = def.radius * (force ? 0.30 + r() * 0.70 : 0.75 + r() * 0.25);
        const cx = p.x + Math.cos(ang) * dist;
        const cz = p.z + Math.sin(ang) * dist;
        if (!this._surfaceOK(def.surface, cx, cz)) continue;

        const gsz = Math.round(def.groupSize[0] + r() * (def.groupSize[1] - def.groupSize[0]));
        const gid = this._groups.length;
        const group = {
          species: name, centre: new THREE.Vector3(cx, this._ground(cx, cz), cz),
          state: 0, timer: 2 + r() * 8, heading: r() * 6.2831,
          alarm: 0, members: 0, speed: 0, fleeT: 0, drift: 0,
          // threat roll-up + panic contagion clock
          threat: UNAWARE, aware: 0, panicT: 99, fleeYaw: 0, routeT: 0,
        };
        this._groups.push(group);

        const aerial = name === 'bird' || name === 'raptor';
        for (let k = 0; k < gsz && live < S.count; k++) {
          const a = S.agents.find((x) => !x.alive);
          if (!a) break;
          const jx = cx + (r() - 0.5) * (aerial ? 30 : 16);
          const jz = cz + (r() - 0.5) * (aerial ? 30 : 16);
          a.alive = true;
          a.group = gid;
          a.home.set(cx, 0, cz);
          a.scale = def.scale[0] + r() * (def.scale[1] - def.scale[0]);
          a.phase = r() * 6.2831;
          a.yaw = group.heading + (r() - 0.5) * 0.9;
          a.state = 0;
          a.timer = r() * 4;
          a.speed = 0;
          a.freq = 0;
          a.slotA = r() * 6.2831;
          a.slotR = 2.5 + r() * 6.0;
          a.rest = 2 + r() * 9;
          a.moving = 0;
          a.vel.set(0, 0, 0);
          a.aware = 0; a.threat = UNAWARE; a.cue = 0; a.calmT = 99;
          a.senseT = r() * 0.2; a.holdT = 0; a.aggroT = 0;
          // Panic is contagious but not telepathic: each animal takes its own
          // fraction of a second to notice its neighbours bolting, which is
          // what stops a herd turning like one rigid body.
          a.contagion = 0.05 + r() * 0.45;
          a.hp = 1; a.wounded = 0; a.bleedT = 0;
          a.dying = 0; a.dead = 0; a.lie = 0; a.deadT = 0; a.bloodT = 0;
          a.tip = r() < 0.5 ? 1.48 : -1.48;         // which side it falls on
          a.dist = 1e9;
          if (name === 'raptor') {
            a.pos.set(jx, this._ground(jx, jz) + 90 + r() * 90, jz);
            a.speed = 7.5 + r() * 3;          // tangential speed on the thermal
          } else if (name === 'bird') {
            a.pos.set(jx, this._ground(jx, jz) + 12 + r() * 26, jz);
            a.vel.set(Math.cos(a.yaw) * 6, 0, Math.sin(a.yaw) * 6);
          } else {
            a.pos.set(jx, this._ground(jx, jz), jz);
          }
          group.members++;
          live++;
        }
      }
    }

    // drop groups that lost every member
    if (this._groups.length > 220) {
      const keep = new Map();
      const next = [];
      for (const [, S] of this._species) {
        for (const a of S.agents) if (a.alive && !keep.has(a.group)) keep.set(a.group, -1);
      }
      for (let i = 0; i < this._groups.length; i++) {
        if (!keep.has(i)) continue;
        keep.set(i, next.length);
        next.push(this._groups[i]);
      }
      for (const [, S] of this._species) {
        for (const a of S.agents) if (a.alive) a.group = keep.get(a.group);
      }
      this._groups = next;
    }
  }

  /**
   * Something loud happened at `pos`. Every animal inside `radius` gets its
   * alarm meter driven up by however close it was — a rifle report at 150 m is
   * a head coming up, the same report at 20 m is the whole herd gone.
   *
   * This is the join between the two halves of the hunt: the shot that kills
   * one deer is exactly what empties the meadow of the other six.
   */
  alarm(pos, radius = 90, intensity = 1) {
    const r2 = radius * radius;
    for (const [, S] of this._species) {
      for (const a of S.agents) {
        if (!a.alive || a.dead) continue;
        const dx = a.pos.x - pos.x, dz = a.pos.z - pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const k = 1 - Math.sqrt(d2) / radius;
        a.aware = Math.min(1.35, a.aware + intensity * (0.35 + k * 1.05));
        a.calmT = 0;
        a.cue = 2;
        if (a.aware > 0.9) {
          const g = this._groups[a.group];
          if (g && g.panicT > 0.5) { g.panicT = 0; g.fleeYaw = Math.atan2(a.pos.z - pos.z, a.pos.x - pos.x); g.routeT = 0; }
        }
      }
    }
  }

  /** Back-compat shim for the old private name. */
  _startle(pos, radius) { this.alarm(pos, radius, 1); }

  /* ------------------------------------------------------- senses & threat */

  /**
   * Terrain line of sight. Four samples along the chord is plenty: what this
   * has to catch is "the herd is over the ridge", not a twig.
   */
  _los(from, to) {
    const w = this.ctx.world;
    if (!w || !w.ready || !w.getHeight) return true;
    const ax = from.x, az = from.z, ay = from.y + 1.0;
    const bx = to.x, bz = to.z, by = to.y + 1.1;
    for (let i = 1; i <= 4; i++) {
      const t = i / 5;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const y = ay + (by - ay) * t;
      let g = 0;
      try { g = w.getHeight(x, z); } catch (e) { return true; }
      if (g > y + 0.6) return false;
    }
    return true;
  }

  /**
   * How much of a threat the player's ORIENTATION makes them, 0.34..1.
   *
   * A prey animal reads where a predator is pointed, not just where it is. A
   * biped square-on and looking at you is a stalk; the same biped with its back
   * turned is scenery that happens to be nearby. Nothing in the model knew
   * this before — `_sense` used the ANIMAL's facing (its own sight cone) and
   * never once looked at the player's, so "he's not even looking at me" was
   * worth exactly zero.
   *
   * Sight only. Being faced does not make you louder or change which way the
   * wind is blowing, so hearing and scent are deliberately left alone.
   *
   * Player forward is (sin yaw, cos yaw) — Player.js's convention, which is NOT
   * the (cos, sin) the agents use for their own yaw. Getting that wrong turns
   * this into a random number, so it is spelled out here.
   */
  _facing(a, dx, dz, d) {
    const y = this.ctx.player.yaw;
    if (y == null) return 1;
    // dx,dz point animal -> player, so negate for player -> animal
    const dot = (-dx / d) * Math.sin(y) + (-dz / d) * Math.cos(y);
    return FACE_MIN + (1 - FACE_MIN) * clamp01((dot + 0.35) / 1.35);
  }

  /** One agent's three sense channels against the player. */
  _sense(a, S, step) {
    const ctx = this.ctx;
    const p = ctx.player.position;
    const N = S.sense;
    const dx = p.x - a.pos.x, dz = p.z - a.pos.z;
    const d = Math.hypot(dx, dz) || 1e-4;
    let rate = 0, cue = 0;

    /* ---- hearing: radius scales with how loud the player is being -------- */
    if (N.hear > 0) {
      const hr = N.hear * (0.22 + this._noise * 1.1);
      if (d < hr) { rate = (1 - d / hr) * 0.80 + 0.14; cue = 2; }
    }

    /* ---- scent: only if the animal is DOWNWIND of the player ------------- */
    if (N.scent > 0 && this._windLen > 0.3) {
      // direction player -> animal, against the direction the air is moving
      const dot = (-dx / d) * this._windX + (-dz / d) * this._windZ;
      if (dot > 0.12) {
        const s = Math.pow(dot, 1.3) * clamp01(this._windLen / 5.5);
        const sr = N.scent * (0.16 + 0.84 * s);
        if (d < sr) {
          const r = (1 - d / sr) * (0.30 + s * 0.85);
          if (r > rate) { rate = r; cue = 4; }
        }
      }
    }

    /* ---- sight: forward cone, movement-weighted, terrain-occluded -------- */
    if (d < N.sight) {
      const fx = Math.cos(a.yaw), fz = Math.sin(a.yaw);
      const cosang = (dx * fx + dz * fz) / d;
      const half = Math.cos(N.cone * 0.5);
      if (cosang > half) {
        const still = N.still != null ? N.still : STILL_DFLT;
        const move = still + (ctx.player.speed01 || 0) * 1.35;
        const stealth = 1 - (ctx.player.crouch || 0) * (N.stealth != null ? N.stealth : STEALTH_DFLT);
        if (this._los(a.pos, p)) {
          const edge = 0.55 + 0.45 * clamp01((cosang - half) / Math.max(1e-3, 1 - half));
          const r = (1 - d / N.sight) * move * stealth * edge * this._facing(a, dx, dz, d);
          if (r > rate) { rate = r; cue = 1; }
        }
      }
    }

    /*
     * ---- integrate --------------------------------------------------------
     *
     * `aware` is a LEAKY integrator, and the leak is the whole point.
     *
     * It used to be a pure one: any rate above zero added to it forever and it
     * only ever came down once the rate hit exactly zero. That has no
     * equilibrium, so the arithmetic says every animal that can perceive the
     * player AT ALL bolts eventually — it is only a question of how long you
     * stand there. Measured on the old build: eight rabbits ringed at 30 m
     * round a player who was motionless, silent, facing away and UPWIND (so
     * scent was out of it entirely) all reached FLEE, because a sight rate of
     * ~0.011 is still a positive number and 0.011 x 60 s clears 0.95. Standing
     * still bought you a delay and nothing else, which is exactly backwards
     * from what the stealth knobs above promise the player.
     *
     * So the stimulus now sets a CEILING as well as a slope: `cap` is the
     * alarm level this much stimulus can sustain. Below it the animal
     * integrates at the old rate, so nothing about a real approach changes —
     * a walker is heard at 0.32 and a sprinter at 0.36, both of which cap out
     * past 1.35 and break the animal at the same range as before. Above it the
     * alarm bleeds back down at the ordinary calm rate. A stimulus too faint
     * to sustain 0.95 can now never produce a bolt no matter how patient the
     * player is, which is what "stillness reduces threat" has to mean if it is
     * to mean anything.
     */
    if (rate > 0) {
      const cap = Math.min(1.35, rate * AWARE_SUSTAIN);
      if (a.aware < cap) a.aware = Math.min(cap, a.aware + rate * step * 1.6);
      else a.aware = Math.max(cap, a.aware - (1.35 / N.calm) * step);
      a.calmT = 0;
      a.cue = cue;
    } else {
      a.calmT += step;
      // Calming down takes tens of seconds, and only really starts once the
      // thing that spooked them has stopped being anywhere near.
      const relax = a.calmT > 1.5 ? (1.35 / N.calm) : 0;
      a.aware = Math.max(0, a.aware - relax * step);
    }

    /* ---- state machine, with hysteresis so it cannot chatter ------------- */
    const near = N.flight > 0 && d < N.flight;
    let t = a.threat;
    if (a.wounded) t = FLEE;
    else if (a.aware >= 0.95 || (near && a.aware > 0.34)) t = FLEE;
    else if (a.aware >= 0.58) t = Math.max(t === FLEE ? WARY : WARY, WARY);
    else if (a.aware >= 0.26) t = t >= WARY ? WARY : ALERT;
    else if (a.aware < 0.14) t = UNAWARE;
    else if (t > ALERT) t = ALERT;

    // Cornered and hurt: a bold species turns and holds its ground. No body in
    // the current roster has boldness, so this branch is dormant until a boar
    // or a wolf is built — but the machine has the state and the transition.
    if (N.bold > 0 && (a.wounded || d < N.flight * 0.35) && a.aware > 0.8
      && this.rand() < N.bold) {
      t = AGGRESSIVE; a.aggroT = 4 + this.rand() * 4;
    }
    if (a.aggroT > 0) { a.aggroT -= step; t = AGGRESSIVE; }

    if (t !== a.threat) {
      a.threat = t;
      if (t === FLEE) {
        const g = this._groups[a.group];
        if (g && g.panicT > 0.6) {
          g.panicT = 0;
          g.routeT = 0;
          g.fleeYaw = Math.atan2(a.pos.z - p.z, a.pos.x - p.x);
        }
        // rabbits freeze first, then dart
        if (N.style === 'freeze') a.holdT = 0.35 + this.rand() * 0.65;
      }
    }
    a.dist = d;
  }

  /** Round-robin the population so perception costs a fixed slice per frame. */
  _perception(dt) {
    const ctx = this.ctx;
    const P = ctx.player;
    /*
     * How loud the player is. Player publishes this; the fallback keeps the
     * model working if it is ever driven headless without a player.
     */
    this._noise = P.noise != null ? P.noise
      : 0.28 + (P.speed01 || 0) * 1.25;
    const w = ctx.env.windVector;
    const wl = Math.hypot(w.x, w.z);
    this._windLen = wl;
    if (wl > 1e-4) { this._windX = w.x / wl; this._windZ = w.z / wl; }

    // Everything alive, in one flat list order; 22 agents a frame means the
    // whole map re-senses about five times a second.
    let budget = 22;
    const lists = [];
    for (const [, S] of this._species) lists.push(S);
    let total = 0;
    for (const S of lists) total += S.count;
    if (total === 0) return;
    const step = Math.max(1 / 60, dt * (total / Math.max(1, budget)));

    let idx = this._senseCursor;
    while (budget-- > 0) {
      idx = (idx + 1) % total;
      let k = idx;
      let S = null;
      for (const L of lists) {
        if (k < L.count) { S = L; break; }
        k -= L.count;
      }
      if (!S) continue;
      const a = S.agents[k];
      if (!a || !a.alive || a.dead) continue;
      if (S.sense.flight <= 0 && S.sense.hear <= 0) continue;   // raptors ignore us
      this._sense(a, S, step);
    }
    this._senseCursor = idx;
  }

  /**
   * Where to run. Straight away from the threat is the first term, but a real
   * animal takes the cheap ground: downhill and toward whatever cover is
   * within a few seconds' running.
   */
  _fleeHeading(cx, cz, px, pz) {
    const away = Math.atan2(cz - pz, cx - px);
    const w = this.ctx.world;
    const veg = this._veg || (this._veg = this.ctx.get('vegetation'));
    let h0 = 0;
    try { h0 = w.getHeight(cx, cz); } catch (e) { h0 = 0; }
    let best = away, bs = -1e9;
    for (let k = -3; k <= 3; k++) {
      /*
       * ±52 degrees of latitude, and the away term weighted so that cover has
       * to be genuinely good to pull the line that far. Measured at ±69 degrees
       * with a weaker away term, a fleeing herd only opened the range at half
       * the rate it should have — they were running for the treeline more than
       * they were running from the man.
       */
      const ang = away + k * 0.30;
      const dx = Math.cos(ang), dz = Math.sin(ang);
      const tx = cx + dx * 24, tz = cz + dz * 24;
      let h1 = h0;
      try { h1 = w.getHeight(tx, tz); } catch (e) { /* keep */ }
      let s = Math.cos(ang - away) * 3.2 + clampf((h0 - h1) / 24, -0.6, 0.6) * 1.9;
      if (veg && veg.densityAt) {
        try { s += clamp01(veg.densityAt(cx + dx * 40, cz + dz * 40).forest) * 1.35; } catch (e) { /* noop */ }
      }
      if (w.isWater) {
        try { if (w.isWater(tx, tz)) s -= 3.0; } catch (e) { /* noop */ }
      }
      if (s > bs) { bs = s; best = ang; }
    }
    return best;
  }

  /* ------------------------------------------------------------------ frame */

  update(dt) {
    if (!this.enabled || !this._ready) return;
    dt = Math.min(dt, 0.1);
    this._t += dt;

    this._repopTimer = (this._repopTimer || 0) + dt;
    if (this._repopTimer > 1.6) { this._repopTimer = 0; this._populate(false); }

    const p = this.ctx.player.position;
    this._perception(dt);
    this._rollup(dt, p);
    this._herds(dt, p);

    for (const [name, S] of this._species) {
      switch (name) {
        case 'deer': this._quadruped(S, dt, p, 1.0); break;
        case 'rabbit': this._rabbits(S, dt, p); break;
        case 'crow': this._crows(S, dt, p); break;
        case 'bird': this._flock(S, dt, p); break;
        case 'raptor': this._raptors(S, dt, p); break;
        default: break;
      }
      this._writeInstances(S);
      if (S.body) this._syncBodies(S);
    }

    this._fish(dt, p);
    this._wounds(dt);
  }

  /* -- roll the herd's mood up out of its members -------------------------- */

  _rollup(dt, p) {
    for (const g of this._groups) {
      g.threat = UNAWARE; g.aware = 0; g.members = 0;
      g.panicT += dt; g.routeT -= dt;
    }
    for (const [, S] of this._species) {
      for (const a of S.agents) {
        if (!a.alive || a.dead) continue;
        const g = this._groups[a.group];
        if (!g) continue;
        g.members++;
        if (a.threat > g.threat) g.threat = a.threat;
        if (a.aware > g.aware) g.aware = a.aware;
      }
    }
    for (const g of this._groups) {
      if (!g.members) continue;
      if (g.threat >= FLEE) {
        // refresh the escape route a couple of times a second while running
        if (g.routeT <= 0) {
          g.fleeYaw = this._fleeHeading(g.centre.x, g.centre.z, p.x, p.z);
          g.routeT = 0.75;
        }
      }
    }
    // Contagion: once one animal has bolted, the rest of its group follow after
    // their own small delay rather than all pivoting on the same frame.
    for (const [, S] of this._species) {
      for (const a of S.agents) {
        if (!a.alive || a.dead || a.threat >= FLEE) continue;
        const g = this._groups[a.group];
        if (!g || g.threat < FLEE) continue;
        /*
         * Contagion is an EVENT, not a field. `panicT` is seconds since this
         * group last had a fresh bolt, so the window below spreads the alarm
         * through the group over the first few seconds and then lets go.
         * Without the upper bound it re-pinned every member to aware=1.0 on
         * every frame for as long as any one of them was still above the flee
         * threshold — a self-feeding loop that no group could ever come down
         * from. It was invisible while the flee vector was inverted (they were
         * running at you, so they were always being re-detected anyway) and
         * showed up the moment they started actually leaving: a spooked warren
         * ran flat out until it streamed out of the world.
         */
        if (g.panicT > a.contagion && g.panicT < 4.0) {
          a.threat = FLEE;
          a.aware = Math.max(a.aware, 1.0);
          a.calmT = 0;
          if ((S.sense.style) === 'freeze') a.holdT = 0.2 + this.rand() * 0.4;
        }
      }
    }
  }

  /* -- bleeding out, dying, and lying still -------------------------------- */

  _wounds(dt) {
    const PT = this.ctx.get('particles');
    for (const [, S] of this._species) {
      for (const a of S.agents) {
        if (!a.alive) continue;

        if (a.wounded && !a.dead) {
          a.bleedT -= dt;
          a.bloodT -= dt;
          if (a.bloodT <= 0 && PT && PT.burst) {
            a.bloodT = 0.34 + this.rand() * 0.3;
            _v.set(a.pos.x, a.pos.y + 0.55 * a.scale, a.pos.z);
            PT.burst('dust', _v, 2, { scale: 0.16, color: BLOOD });
          }
          if (a.bleedT <= 0) this._kill(a, S);
        }

        if (a.dying) {
          // Fold up over a few tenths of a second: the legs stop, the body
          // rolls onto its side and the head goes down.
          a.lie = Math.min(1, a.lie + dt * 2.6);
          a.speed = toward(a.speed, 0, 9 * dt);
          a.gait = Math.max(0, a.gait - dt * 3);
          a.state += (-0.95 - a.state) * Math.min(1, dt * 4);
          if (a.lie >= 1) { a.dying = 0; a.dead = 2; }
        }
        if (a.dead) {
          a.deadT += dt;
          a.speed = 0; a.gait = 0; a.bob = 0;
          if (a.deadT > 240) { a.alive = false; this._dropCarcass(a); }
        }
      }
    }
    /*
     * Prune only on `!alive`. The first cut also dropped anything with
     * `dead === 0`, which is true for the whole half-second an animal spends
     * FALLING — so every carcass was deleted from the list on the same frame it
     * was added and nothing was ever skinnable.
     */
    for (let i = this.carcasses.length - 1; i >= 0; i--) {
      if (!this.carcasses[i].agent.alive) this.carcasses.splice(i, 1);
    }
  }

  _dropCarcass(a) {
    for (let i = this.carcasses.length - 1; i >= 0; i--) {
      if (this.carcasses[i].agent === a) this.carcasses.splice(i, 1);
    }
  }

  _kill(a, S) {
    if (a.dead || a.dying) return;
    a.wounded = 0;
    a.bleedT = 0;
    a.dying = 1;
    a.threat = UNAWARE;
    this.kills++;
    const PT = this.ctx.get('particles');
    if (PT && PT.burst) {
      _v.set(a.pos.x, a.pos.y + 0.5 * a.scale, a.pos.z);
      PT.burst('dust', _v, 7, { scale: 0.2, color: BLOOD });
      PT.burst('splash', _v.set(a.pos.x, a.pos.y + 0.03, a.pos.z), 3, { scale: 1.2, color: BLOOD });
    }
    this.carcasses.push({ agent: a, species: S.name, position: a.pos });
    this.ctx.emit('animalKilled', { species: S.name, position: a.pos.clone() });
  }

  /* ------------------------------------------------------- hunting contract */

  /**
   * Hitscan the population.
   * @returns {{agent,species,point:THREE.Vector3,distance:number,part:string}|null}
   */
  raycastAnimals(origin, dir, maxDist = 400) {
    let best = null;
    for (const [name, S] of this._species) {
      const box = S.hitbox;
      for (const a of S.agents) {
        if (!a.alive || a.dead) continue;
        const dx = a.pos.x - origin.x, dy = a.pos.y - origin.y, dz = a.pos.z - origin.z;
        const along = dx * dir.x + dy * dir.y + dz * dir.z;
        if (along < 0 || along > maxDist + 3) continue;
        // cheap reject on the whole animal before testing the spheres
        const perp2 = (dx * dx + dy * dy + dz * dz) - along * along;
        if (perp2 > 9) continue;
        const fx = Math.cos(a.yaw), fz = Math.sin(a.yaw);
        for (let i = 0; i < box.length; i++) {
          const b = box[i];
          const r = b[2] * a.scale;
          const cx = a.pos.x + fx * b[0] * a.scale;
          const cy = a.pos.y + b[1] * a.scale;
          const cz = a.pos.z + fz * b[0] * a.scale;
          const ox = cx - origin.x, oy = cy - origin.y, oz = cz - origin.z;
          const t = ox * dir.x + oy * dir.y + oz * dir.z;
          if (t < 0 || t > maxDist) continue;
          const p2 = (ox * ox + oy * oy + oz * oz) - t * t;
          if (p2 > r * r) continue;
          const hit = t - Math.sqrt(Math.max(0, r * r - p2));
          if (best && hit >= best.distance) continue;
          best = {
            agent: a, species: name, part: b[3], distance: hit,
            point: new THREE.Vector3(
              origin.x + dir.x * hit, origin.y + dir.y * hit, origin.z + dir.z * hit),
          };
        }
      }
    }
    return best;
  }

  /**
   * Land a shot. Where it hit decides what happens: a head or heart shot drops
   * the animal on the spot, a body shot sends it running with a blood trail
   * that runs out somewhere over the next ridge, a leg cripples it.
   */
  applyHit(hit, damage = 1) {
    if (!hit || !hit.agent) return null;
    const a = hit.agent;
    const S = this._species.get(hit.species);
    if (!S || a.dead || a.dying) return null;
    const PT = this.ctx.get('particles');
    if (PT && PT.burst) {
      PT.burst('dust', hit.point, 9, { scale: 0.17, color: BLOOD });
      PT.burst('sparks', hit.point, 4, { scale: 0.28, color: BLOOD });
    }
    const mult = PART_DMG[hit.part] != null ? PART_DMG[hit.part] : 0.6;
    a.hp -= (damage * mult) / (S.sense.hp || 1);
    a.aware = 1.35;
    a.calmT = 0;

    const lethal = hit.part === 'head' || a.hp <= 0;
    if (lethal) {
      this._kill(a, S);
      return { killed: true, part: hit.part, species: hit.species };
    }
    // wounded: bolts, bleeds, and goes down out of sight if you do not follow
    a.wounded = 1;
    a.bleedT = 7 + this.rand() * 11;
    a.threat = FLEE;
    const g = this._groups[a.group];
    if (g) { g.panicT = 0; g.routeT = 0; }
    return { killed: false, part: hit.part, species: hit.species };
  }

  /** Nearest skinnable carcass to a point. */
  nearestCarcass(pos, radius = 2.6) {
    let best = null, bd = radius * radius;
    for (const c of this.carcasses) {
      const a = c.agent;
      if (!a.alive || a.dead !== 2) continue;
      const dx = a.pos.x - pos.x, dz = a.pos.z - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = c; }
    }
    return best;
  }

  /** Skin and take it. The carcass goes; the tally does not. */
  collect(carcass) {
    if (!carcass || !carcass.agent) return false;
    const a = carcass.agent;
    a.alive = false;
    this._dropCarcass(a);
    this.pelts++;
    const PT = this.ctx.get('particles');
    if (PT && PT.burst) PT.burst('dust', a.pos, 5, { scale: 0.3, color: BLOOD });
    return true;
  }

  stats() {
    let live = 0, dead = 0;
    for (const [, S] of this._species) {
      for (const a of S.agents) { if (a.alive) { if (a.dead) dead++; else live++; } }
    }
    return { live, dead, kills: this.kills, pelts: this.pelts, groups: this._groups.length };
  }

  /* -- group state machine ------------------------------------------------ */

  /**
   * The herd's own motion. State is no longer guessed from distance — it comes
   * straight out of the members' senses (see `_rollup`) — so this function is
   * now only about how the group MOVES in each mood:
   *
   *   graze   parked most of the time, a few metres of drift now and then
   *   alert   stopped dead, everything facing the disturbance
   *   wary    walking backwards away from it, keeping its distance
   *   flee    running the escape route chosen by `_fleeHeading`
   */
  _herds(dt, p) {
    const r = this.rand;
    for (const g of this._groups) {
      const dx = g.centre.x - p.x, dz = g.centre.z - p.z;
      const d = Math.hypot(dx, dz);
      g.timer -= dt;
      g.alarm = Math.max(0, g.alarm - dt * 0.35);

      // legacy 0 graze / 1 alert / 2 flee, derived from the threat roll-up
      const prev = g.state;
      g.state = g.threat >= FLEE ? 2 : g.threat >= ALERT ? 1 : 0;
      if (g.state === 2) g.fleeT += dt;
      else { g.fleeT = 0; if (prev === 2) g.timer = 3 + r() * 5; }
      if (g.state === 0 && g.timer <= 0) {
        // A grazing herd spends most of its time parked and shuffles a few
        // metres every half minute or so. Perpetual drift is what made a
        // pasture look like a conveyor belt.
        g.drift = g.drift ? 0 : 1;
        g.timer = g.drift ? 4 + r() * 7 : 14 + r() * 26;
        if (g.drift) g.heading += (r() - 0.5) * 2.2;
      }
      if (g.state !== 0) g.drift = 0;

      /*
       * The herd centre is what every member steers at, so it may not jump to
       * a running speed the instant something spooks them — nothing in nature
       * goes 0 to 9 m/s in one frame. It winds up, holds the bolt for a few
       * seconds and then settles back to a canter.
       */
      const L = LOCO[g.species] || LOCO.deer;
      let burst;
      if (g.state === 2) {
        burst = g.fleeT < 3.5
          ? L.flee
          : L.settle + (L.flee - L.settle) * Math.exp(-(g.fleeT - 3.5) * 0.5);
        // once it is a long way off it stops running and just keeps walking away
        if (d > 150) burst = Math.min(burst, L.browse * 1.6);
      } else if (g.threat === WARY) {
        burst = L.browse * 1.5;                     // backing off, not running
      } else if (g.state === 0 && g.drift) {
        burst = 0.55;
      } else {
        burst = 0;                                  // alert = frozen
      }
      const rate = burst > g.speed ? L.accel * 0.85 : L.decel;
      g.speed = toward(g.speed, burst, rate * dt);
      if (g.state === 2) {
        // the chosen escape route, eased into so the turn has a radius
        g.heading = angleLerp(g.heading, g.fleeYaw, 1 - Math.exp(-dt * 2.2));
      } else if (g.threat === WARY) {
        // dx,dz = player -> centre, so atan2(dz, dx) backs the herd OFF. The
        // negated form walked a wary herd slowly INTO the thing it was wary of.
        g.heading = angleLerp(g.heading, Math.atan2(dz, dx), 1 - Math.exp(-dt * 1.1));
      }
      if (g.speed > 0.01) {
        g.centre.x += Math.cos(g.heading) * g.speed * dt;
        g.centre.z += Math.sin(g.heading) * g.speed * dt;
      }
      g.centre.y = this._ground(g.centre.x, g.centre.z);
    }
  }

  /* -- ground quadrupeds -------------------------------------------------- */

  _quadruped(S, dt, p, gaitScale) {
    const w = this.ctx.world;
    const L = LOCO[S.name] || LOCO.deer;
    const r = this.rand;
    for (const a of S.agents) {
      if (!a.alive) continue;
      if (a.dead || a.dying) { a.pos.y = this._ground(a.pos.x, a.pos.z); this._align(a, w); continue; }
      const g = this._groups[a.group];
      if (!g) { a.alive = false; continue; }

      /*
       * Steer at a FIXED slot in the herd. The first cut derived the slot from
       * the gait phase, so the target orbited the herd centre once per stride
       * and every animal spent its life micro-correcting — half the reason
       * they read as "zipping about".
       */
      a.slotA += dt * 0.05;
      const spread = a.threat >= FLEE ? 0.45 : 1.0;
      const tx = g.centre.x + Math.cos(a.slotA) * a.slotR * spread;
      const tz = g.centre.z + Math.sin(a.slotA) * a.slotR * spread;
      const dx = tx - a.pos.x, dz = tz - a.pos.z;
      const d = Math.hypot(dx, dz);

      /* ---- what it wants to do -------------------------------------------- */
      let want;
      if (a.threat >= FLEE) {
        // A wounded animal cannot hold the pace, and it is the individual that
        // runs, not the group average — a straggler is a straggler.
        const hurt = a.wounded ? 0.62 : 1;
        want = (Math.max(g.speed, L.flee * 0.8) + (a.scale - 1) * 2.0 + (d > 8 ? 0.8 : 0)) * hurt;
      } else if (a.threat === WARY) {
        want = g.speed;                                             // backing away
      } else if (a.threat === ALERT) {
        want = 0;                                                   // frozen, head up
      } else {
        // graze: stand for a long while, then take a few steps
        a.rest -= dt;
        if (a.rest <= 0) {
          a.moving = a.moving ? 0 : 1;
          a.rest = a.moving ? 1.5 + r() * 3.5 : 5 + r() * 12;
        }
        if (d > 11) a.moving = 1;                                   // do not get left behind
        want = a.moving ? L.browse * (0.75 + a.scale * 0.3) : 0;
        if (d < 1.6 && a.moving && !g.drift) { a.moving = 0; a.rest = 4 + r() * 9; }
      }

      /* ---- turning costs speed -------------------------------------------- */
      /*
       * An ALERT animal is not steering anywhere — it is standing still with
       * its head up, LOOKING at whatever it just noticed. That single line is
       * most of the difference between "the deer knows I am here" and "the deer
       * is a prop that happens to have stopped".
       */
      let desired;
      if (a.threat === ALERT || a.threat === AGGRESSIVE) {
        desired = Math.atan2(p.z - a.pos.z, p.x - a.pos.x);
      } else if (a.threat === WARY) {
        desired = Math.atan2(a.pos.z - p.z, a.pos.x - p.x);
      } else {
        desired = d > 0.3 ? Math.atan2(dz, dx) : a.yaw;
      }
      const off = Math.abs(angleDelta(a.yaw, desired));
      want *= 1 - clamp01(off / 1.4) * 0.55;

      const rate = want > a.speed ? L.accel : L.decel;
      const before = a.speed;
      a.speed = toward(a.speed, want, rate * dt);
      void before;

      // hard turns are only available at low speed — a running deer arcs
      const turn = L.turnSlow + (L.turnFast - L.turnSlow) * clamp01(a.speed / L.flee);
      // A standing animal still turns — that is how it orients on a threat.
      if (a.speed > 0.05 || a.threat >= ALERT) {
        a.yaw = angleLerp(a.yaw, desired, 1 - Math.exp(-dt * turn * (a.speed > 0.05 ? 1 : 0.55)));
      }

      /* ---- integrate, then drive the gait off what actually happened ------ */
      const px = a.pos.x, pz = a.pos.z;
      a.pos.x += Math.cos(a.yaw) * a.speed * dt;
      a.pos.z += Math.sin(a.yaw) * a.speed * dt;
      a.pos.y = this._ground(a.pos.x, a.pos.z);
      const moved = Math.hypot(a.pos.x - px, a.pos.z - pz) / Math.max(dt, 1e-5);
      stride(a, L, moved * gaitScale, dt);

      // head: down to graze, snapped up the instant anything is noticed
      const head = a.threat === UNAWARE && a.speed < 0.35
        ? -0.85 + Math.sin(this._t * 0.7 + a.slotA * 3) * 0.12
        : (a.threat === ALERT || a.threat === WARY ? 0.34 : 0.12);
      a.state = a.state + (head - a.state) * Math.min(1, dt * 3.5);
      // the body rises and falls once per stride at a gallop, twice at a trot
      const band = gaitBand(L, moved);
      a.bob = Math.sin(a.phase * (band >= 2 ? 1 : 2)) * (band >= 2 ? 0.060 : 0.035)
        * a.gait * a.scale;
      this._align(a, w);
    }
  }

  _rabbits(S, dt, p) {
    const w = this.ctx.world;
    const L = LOCO.rabbit;
    const r = this.rand;
    for (const a of S.agents) {
      if (!a.alive) continue;
      const g = this._groups[a.group];
      if (!g) { a.alive = false; continue; }
      if (a.dead || a.dying) { a.pos.y = this._ground(a.pos.x, a.pos.z); this._align(a, w); continue; }
      a.timer -= dt;
      /*
       * (dx, dz) is the vector player -> rabbit, so `away` is the heading that
       * OPENS the range. It has to be written this way round. It was
       * `atan2(-dz, -dx)` — the exact opposite — which meant every spooked
       * rabbit sprinted at 4.6 m/s straight AT the player, re-aimed twice a
       * second, and ended up circling his boots at half a metre. The senses
       * were working the whole time (measured: aware saturated at 1.35, threat
       * FLEE from ~20 m); the escape vector was inverted, so the more
       * frightened the rabbit was the harder it charged you.
       */
      const dx = a.pos.x - p.x, dz = a.pos.z - p.z;
      const dist = Math.hypot(dx, dz) || 1e-4;
      const away = Math.atan2(dz, dx);
      /*
       * A rabbit does not bolt on sight — it FREEZES, betting that you have not
       * seen it, and only breaks when you are close enough that the bet has
       * gone bad. `holdT` is that bet, set when the threat state flips to FLEE.
       */
      if (a.threat >= ALERT && a.holdT > 0) {
        a.holdT -= dt;
        a.moving = 0; a.want = 0; a.timer = 0.05;
      }
      const spooked = a.threat >= FLEE && a.holdT <= 0;
      if (a.timer <= 0) {
        if (spooked) {
          // dart: a short, fast, slightly random line directly away
          a.moving = 1; a.timer = 0.5 + r() * 0.7;
          a.yaw = away + (r() - 0.5) * 0.7;
          a.want = L.flee;
        } else if (a.threat >= ALERT) {
          a.moving = 0; a.timer = 0.4 + r() * 0.5;                  // sat bolt upright
        } else if (a.moving) {
          a.moving = 0; a.timer = 2.0 + r() * 5.0;                  // freeze
        } else {
          a.moving = 1; a.timer = 0.5 + r() * 1.2;
          a.yaw += (r() - 0.5) * 2.2;
          a.want = 1.3 + r() * 0.9;                                 // a short hop-run
          /*
           * Even an unbothered rabbit keeps a personal space. Without this a
           * random-walk heading is as likely to point at the man as away from
           * him, and over a minute a few of them wander into his lap — which
           * reads as "they are not afraid of me" just as loudly as a broken
           * flee vector does. Inside the buffer the hop is folded back into
           * the downrange half-plane instead of being re-rolled, so it still
           * looks like a rabbit choosing a line, not a wall.
           */
          if (dist < 22) {
            const off = angleDelta(a.yaw, away);
            const lim = 0.55 + 1.05 * clamp01((dist - 6) / 16);     // 0.55..1.6 rad
            if (Math.abs(off) > lim) a.yaw = away + (off > 0 ? lim : -lim);
          }
        }
      }
      const want = a.moving ? a.want : 0;
      a.speed = toward(a.speed, want, (want > a.speed ? L.accel : L.decel) * dt);
      const px = a.pos.x, pz = a.pos.z;
      a.pos.x += Math.cos(a.yaw) * a.speed * dt;
      a.pos.z += Math.sin(a.yaw) * a.speed * dt;
      a.pos.y = this._ground(a.pos.x, a.pos.z);
      const moved = Math.hypot(a.pos.x - px, a.pos.z - pz) / Math.max(dt, 1e-5);
      stride(a, L, moved, dt);
      // hop arc, in step with the bound
      a.bob = Math.max(0, Math.sin(a.phase)) * 0.16 * a.gait;
      a.state = a.speed > 0.1 ? 0.25 : -0.15;
      this._align(a, w);
    }
  }

  _crows(S, dt, p) {
    const w = this.ctx.world;
    const r = this.rand;
    for (const a of S.agents) {
      if (!a.alive) continue;
      if (a.dead || a.dying) { a.pos.y = this._ground(a.pos.x, a.pos.z); this._align(a, w); continue; }
      const dx = a.pos.x - p.x, dz = a.pos.z - p.z;
      // A crow flushes off the ground the moment it is genuinely aware of you —
      // sight, sound or a gunshot two hundred metres away, it makes no odds.
      if (a.state < 0.5 && a.threat >= FLEE) {
        // (dx, dz) is player -> crow: atan2(dz, dx) is the heading AWAY. The
        // sign was inverted here too, so a flushed crow took off straight into
        // the player's face.
        a.state = 1; a.timer = 5 + r() * 4; a.yaw = Math.atan2(dz, dx);
      }
      if (a.state >= 0.5) {
        // taking off / flying away — hard, but still an acceleration
        a.timer -= dt;
        a.speed = toward(a.speed, 8.0, 7.0 * dt);
        a.vel.set(Math.cos(a.yaw) * a.speed, 0, Math.sin(a.yaw) * a.speed);
        a.pos.addScaledVector(a.vel, dt);
        const target = this._ground(a.pos.x, a.pos.z) + 14 + Math.sin(this._t * 0.6 + a.phase) * 3;
        a.pos.y += (target - a.pos.y) * Math.min(1, dt * 1.4);
        a.phase += dt * 13;
        a.gait = 1;
        if (a.timer <= 0) { a.alive = false; }
      } else {
        a.pos.y = this._ground(a.pos.x, a.pos.z);
        a.phase += dt * 0.6;
        a.gait = 0;
        a.speed = 0;
        // the occasional hop and head-cock
        a.bob = Math.max(0, Math.sin(this._t * 0.9 + a.phase * 3)) * 0.02;
      }
      this._align(a, w);
    }
  }

  /* -- boids -------------------------------------------------------------- */

  _flock(S, dt, p) {
    const groups = new Map();
    for (const a of S.agents) {
      if (!a.alive || a.dead || a.dying) continue;
      let L = groups.get(a.group);
      if (!L) { L = []; groups.set(a.group, L); }
      L.push(a);
    }
    for (const [gid, L] of groups) {
      const g = this._groups[gid];
      if (!g) { for (const a of L) a.alive = false; continue; }
      // flock centroid + mean heading
      let cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0;
      for (const a of L) {
        cx += a.pos.x; cy += a.pos.y; cz += a.pos.z;
        vx += a.vel.x; vy += a.vel.y; vz += a.vel.z;
      }
      const n = L.length;
      cx /= n; cy /= n; cz /= n; vx /= n; vy /= n; vz /= n;

      const dxp = cx - p.x, dzp = cz - p.z;
      const dp = Math.hypot(dxp, dzp);
      // A flock flushes on ALARM, not on proximity: sneak up on it downwind and
      // quiet and it stays put; run at it, or fire a rifle, and it lifts.
      if (g.threat >= FLEE && g.state !== 2) { g.state = 2; g.timer = 6 + this.rand() * 5; }
      const flee = g.state === 2 ? 1 : 0;
      const cruise = 6.2 + flee * 4.6;
      const ceiling = this._ground(cx, cz) + (flee ? 45 : 16) + Math.sin(this._t * 0.21 + gid) * 8;

      for (const a of L) {
        let ax = 0, ay = 0, az = 0;
        // separation
        for (const b of L) {
          if (b === a) continue;
          const sx = a.pos.x - b.pos.x, sy = a.pos.y - b.pos.y, sz = a.pos.z - b.pos.z;
          const d2 = sx * sx + sy * sy + sz * sz;
          if (d2 < 16 && d2 > 1e-4) {
            const k = (16 - d2) / 16 / Math.sqrt(d2);
            ax += sx * k * 9; ay += sy * k * 9; az += sz * k * 9;
          }
        }
        // cohesion + alignment
        ax += (cx - a.pos.x) * 0.55 + (vx - a.vel.x) * 0.9;
        ay += (cy - a.pos.y) * 0.35 + (vy - a.vel.y) * 0.9;
        az += (cz - a.pos.z) * 0.55 + (vz - a.vel.z) * 0.9;
        // hold altitude
        ay += (ceiling - a.pos.y) * 0.85;
        // wander
        ax += Math.sin(this._t * 1.3 + a.phase) * 2.2;
        az += Math.cos(this._t * 1.1 + a.phase * 1.7) * 2.2;
        // avoid the player
        if (dp < 60) {
          const k = (60 - dp) / 60 * 6;
          ax += (a.pos.x - p.x) / Math.max(dp, 1) * k;
          az += (a.pos.z - p.z) / Math.max(dp, 1) * k;
          ay += k * 0.6;
        }

        a.vel.x += ax * dt; a.vel.y += ay * dt; a.vel.z += az * dt;
        const sp = a.vel.length();
        /*
         * Trim the airspeed toward cruise at a bounded RATE. The old clamp was
         * a per-frame multiplier of up to 1.35, i.e. a 20 g acceleration at
         * 60 Hz — birds that snapped to full speed the instant the flock
         * turned, which is exactly what "zipping" looks like.
         */
        if (sp > 1e-3) a.vel.multiplyScalar(toward(sp, cruise, 7.0 * dt) / sp);
        a.pos.addScaledVector(a.vel, dt);
        const floor = this._ground(a.pos.x, a.pos.z) + 4;
        if (a.pos.y < floor) { a.pos.y = floor; a.vel.y = Math.abs(a.vel.y); }

        const prev = a.yaw;
        a.yaw = Math.atan2(a.vel.z, a.vel.x);
        const turn = angleDelta(prev, a.yaw);
        a.roll = clampf(a.roll + (turn / Math.max(dt, 1e-3) * -0.10 - a.roll) * Math.min(1, dt * 6), -0.8, 0.8);
        a.pitch = clampf(Math.asin(THREE.MathUtils.clamp(a.vel.y / Math.max(a.vel.length(), 1e-3), -1, 1)) * 0.6, -0.5, 0.5);
        a.speed = a.vel.length();
        a.gait = 1;
        // flap hard when climbing, glide when descending; and beat faster the
        // faster it is going, or a bird crossing frame reads as a dart
        a.phase += dt * (8.0 + a.speed * 0.85 + Math.max(0, a.vel.y) * 1.6);
        a.state = clamp01(0.5 + a.vel.y * 0.12);
      }
      if (g.state === 2) { g.timer -= dt; if (g.timer <= 0) g.state = 0; }
    }
  }

  _raptors(S, dt, p) {
    for (const a of S.agents) {
      if (!a.alive) continue;
      // slow thermal: a wide circle that drifts with the wind
      const wind = this.ctx.env.windVector;
      a.timer += dt;
      const rad = 55 + (a.scale - 1) * 90;
      const om = a.speed / Math.max(rad, 1);
      a.circle += om * dt;
      a.home.x += wind.x * 0.05 * dt;
      a.home.z += wind.z * 0.05 * dt;
      a.pos.x = a.home.x + Math.cos(a.circle) * rad;
      a.pos.z = a.home.z + Math.sin(a.circle) * rad;
      // heading is tangent to the circle
      a.yaw = a.circle + Math.PI * 0.5;
      const base = this._ground(a.pos.x, a.pos.z);
      a.pos.y = base + 95 + Math.sin(a.timer * 0.13 + a.phase) * 34;
      a.roll = -0.55;
      a.pitch = 0.03;
      // wings held out; the occasional lazy beat
      const beat = Math.max(0, Math.sin(a.timer * 0.32 + a.phase) - 0.86) * 7;
      a.phase += dt * beat * 6;
      a.gait = 1;
      a.state = 0.06;   // wings held out; a soaring bird barely beats them
    }
  }

  /* -- fish --------------------------------------------------------------- */

  _fish(dt, p) {
    const w = this.ctx.world;
    if (!w || !w.isWater) return;
    const PT = this.ctx.get('particles');
    if (!PT || !PT.burst) return;
    this._fishAcc += dt;
    if (this._fishAcc < 0.6) return;
    this._fishAcc = 0;
    const r = this.rand;
    // a rise every few seconds, wherever there is water within earshot
    if (r() > 0.45) return;
    for (let k = 0; k < 6; k++) {
      const a = r() * 6.2831, d = 6 + r() * 40;
      const x = p.x + Math.cos(a) * d;
      const z = p.z + Math.sin(a) * d;
      let wet = false;
      try { wet = w.isWater(x, z); } catch (e) { wet = false; }
      if (!wet) continue;
      _v.set(x, w.waterLevel != null ? w.waterLevel : 18, z);
      PT.burst('splash', _v, 2, { scale: 1.5 });
      PT.burst('sparks', _v, 3, { scale: 0.5 });
      break;
    }
  }

  /* -- shared ------------------------------------------------------------- */

  _align(a, w) {
    if (!w || !w.getNormal || !w.ready) return;
    try {
      w.getNormal(a.pos.x, a.pos.z, _n);
    } catch (e) { return; }
    // pitch/roll the body onto the slope so the feet stay planted
    const fx = Math.cos(a.yaw), fz = Math.sin(a.yaw);
    const p = -(_n.x * fx + _n.z * fz) / Math.max(_n.y, 0.2);
    const rl = -(_n.x * -fz + _n.z * fx) / Math.max(_n.y, 0.2);
    a.pitch += (Math.atan(p) - a.pitch) * 0.25;
    a.roll += (Math.atan(rl) - a.roll) * 0.25;
  }

  _writeInstances(S) {
    const mesh = S.mesh;
    const arr = S.anim.array;
    let n = 0;
    for (let i = 0; i < S.count; i++) {
      const a = S.agents[i];
      if (!a.alive) {
        _m.makeScale(0, 0, 0);
      } else {
        /* object space is +X forward / +Y up / +Z left, so yaw is a rotation
           of -yaw about Y, pitch is about Z and roll is about X.
           `lie` rolls a carcass onto its side and settles it into the ground. */
        _q.setFromEuler(_e.set(a.roll + a.lie * a.tip, -a.yaw, a.pitch, 'YXZ'));
        /*
         * The roll happens about the instance ORIGIN, which is at the animal's
         * feet — so tipping it 85 degrees already swings the body down onto the
         * ground on its own. The first cut also subtracted 0.30 m for the fall,
         * which buried the carcass: you shot a deer, it dropped, and there was
         * nothing on the ground. It needs a small LIFT, for the thickness of
         * the body it is now lying on.
         */
        _v.set(a.pos.x, a.pos.y + a.bob + a.lie * 0.15 * a.scale, a.pos.z);
        _s.setScalar(a.scale);
        _m.compose(_v, _q, _s);
        n++;
      }
      mesh.setMatrixAt(i, _m);
      arr[i * 4] = a.phase;
      arr[i * 4 + 1] = a.gait;
      arr[i * 4 + 2] = a.state;
      arr[i * 4 + 3] = a.speed;
    }
    S.active = n;
    mesh.instanceMatrix.needsUpdate = true;
    S.anim.needsUpdate = true;
  }

  dispose() {
    const PH = this._PH;
    for (const [, S] of this._species) {
      if (PH) for (const a of S.agents) { if (a.col) { PH.removeCollider(a.col); a.col = null; } }
      this.ctx.scene.remove(S.mesh);
      S.geo.dispose();
      S.mat.dispose();
      if (S.mesh.customDepthMaterial) S.mesh.customDepthMaterial.dispose();
    }
    this._species.clear();
  }
}

/* -------------------------------------------------------------------------- */

function patchAnim(mat, species) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer) {
    if (typeof prev === 'function') prev.call(this, shader, renderer);
    if (shader.vertexShader.indexOf('aAnim') !== -1) return;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + ANIM_PARS)
      .replace('#include <begin_vertex>', ANIM_BEGIN);
  };
  const key = mat.customProgramCacheKey;
  mat.customProgramCacheKey = function () {
    return 'wl-' + species + '|' + (typeof key === 'function' ? key.call(this) : '');
  };
  mat.needsUpdate = true;
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
/** Dark venous red, LINEAR — blood is much darker than the sRGB you expect. */
const BLOOD = { r: 0.115, g: 0.012, b: 0.008 };
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clampf = (x, a, b) => (x < a ? a : x > b ? b : x);
/** Move `cur` toward `target` by at most `step` — an acceleration limit. */
function toward(cur, target, step) {
  const d = target - cur;
  return Math.abs(d) <= step ? target : cur + Math.sign(d) * step;
}
function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function angleLerp(a, b, t) { return a + angleDelta(a, b) * t; }
