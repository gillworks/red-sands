import * as THREE from 'three';
import { rng } from '../../core/Context.js';
import { flameColor, flameEnvelope, makeFirePoolCookie } from './FireLight.js';

const _wp = new THREE.Vector3();

/** Fires are physically authored; these are the defaults for `addFire`. */
export const FIRE_DEFAULTS = {
  /** Blackbody temperature of the luminous soot, in kelvin. */
  kelvin: 1900,
  /**
   * How far the pure Planckian colour is lifted toward neutral (hot core).
   * 0.16 -> 0.10: the lift exists so the flame is not a stage gel, but at 0.16
   * it was handing (1.0, 0.56, 0.27) to a tonemap that then desaturated it
   * further. 0.10 lands (1.0, 0.48, 0.19), which survives the shoulder.
   */
  soot: 0.07,
  /**
   * Peak linear irradiance the fire puts on a surface one metre away. A wood
   * fire radiates roughly 400 W/m2 at a metre against sunlight's ~1000, and the
   * engine's sun peaks at 6.4, so ~2.4 is the physical figure rather than a
   * tuned one.
   */
  intensity: 1.7,
  /**
   * Hard ceiling on what a caller may ask for. Present so that a fire authored
   * elsewhere cannot go back to pass 1's 5.5-at-0.3 m — that is 61x irradiance
   * on the fire's own fuel bed, every channel through the filmic shoulder, and
   * the measured (0.838, 0.872, 0.860) white disc.
   *
   * Both numbers came down in pass 3. Night auto-exposure meters to its 19x
   * ceiling, so a 2.4 fire put roughly 5.8 of display-referred radiance on the
   * sand a metre away — five stops into AgX's shoulder, where the curve
   * deliberately walks every hue toward white. The critique measured the result
   * as saturation 0.075 with GREEN dominant. Nothing about the light's colour
   * was wrong; it was simply being asked to be five stops brighter than the
   * frame could carry.
   */
  intensityCap: 3.2,
  /** Cutoff distance of the inverse-square window. */
  radius: 26,
  /** 0..1 depth of the flicker modulation. */
  flicker: 0.55,
  /** Height of the luminous centre above the fire's base point. */
  height: 0.30,
  importance: 6,
  shadow: true,
};

/**
 * Budgeted manager for campfires, lanterns, windows and street lamps.
 *
 * - Only the N most important lights are lit; the rest fade out smoothly by
 *   distance/rank instead of popping.
 * - The *visible* point-light count is quantised and hysteresis-damped, so
 *   three does not thrash its shader permutations as you ride past a town.
 * - The nearest fire owns a single downward SpotLight ("the floor projector")
 *   which carries a procedural cookie and a real shadow map. One pass, not the
 *   six a point-light cube shadow would cost, and the heavyweights (terrain,
 *   grass) are held out of even that — see `suppressHeavyCasters`.
 * - Flicker is deterministic: seeded per light from `rng(ctx.seed)`.
 */
export class LocalLights {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    const q = ctx.quality;
    this.budget = opts.budget ?? (q.name === 'low' ? 4 : q.name === 'medium' ? 6 : 8);
    this.step = 4; // point-light slots are allocated in blocks of this size
    this.entries = [];
    this.dummies = [];
    this._rand = rng(ctx.seed ^ 0x51ed7);
    this._slotTarget = 0;
    this._slotHold = 0;
    this._shadowHold = 0;
    this._scratch = [];
    this._fires = [];
    this._suppressed = [];

    /**
     * A caster costs six passes in a point shadow. Anything above this estimated
     * triangle count is excluded from local shadow maps — the terrain clipmap is
     * a single 24 km draw that never frustum-culls, and pass 1 correctly refused
     * to pay for it. The fix is not "no shadow", it is "no terrain in the
     * shadow": logs and rocks around a fire are only a few hundred triangles.
     */
    this.heavyCasterTris = opts.heavyCasterTris ?? 24000;
    this.localShadowSize = q.name === 'low' ? 512 : q.name === 'ultra' ? 1024 : 768;

    /**
     * Fraction of a fire's radiance moved out of the omni point light and into
     * the shaped, shadow-casting floor projector. The point light keeps the
     * rest so vertical faces and anything above the cone still see the fire.
     */
    this.poolShare = 0.62;
    /**
     * The cookie averages ~0.5 and three's cone smoothing eats more toward the
     * rim, so the projector needs this much gain to actually deliver `poolShare`
     * of the fire's irradiance to the ground under it. Retuned for the lower
     * projector: irradiance under the light goes as 1/h^2, so dropping h from
     * 0.95 m to 0.52 m multiplies it by 3.34 and the gain has to come down by
     * the same factor or the pool triples in brightness.
     */
    this.poolBoost = 0.70;
    /**
     * Height of the projector above the GROUND, metres.
     *
     * THIS NUMBER IS THE CAMPFIRE SHADOW. A shadow cast by a source at height h
     * from an object of height o standing r from the axis reaches
     *     r' = r * h / (h - o)
     * so at pass 2's h = 0.95 m a 0.30 m fire-ring stone at r = 1.2 m threw
     * 0.55 m — under half a stone-width, and invisible in frame. That is the
     * whole of "the fire-ring rocks and the log stack cast nothing onto the
     * ground". At h = 0.52 m the same stone throws 2.6 m of shadow raking
     * outward across the sand, which is what a real campfire looks like: the
     * flame is LOW, so everything around it is lit from below and its shadow is
     * enormous. The cone widens to compensate for the lost pool radius.
     */
    this.poolHeight = 0.52;
    /**
     * Radius around the projector inside which a caster is allowed into the
     * local shadow map. Everything else is held out — see `suppressHeavyCasters`.
     */
    this.poolCasterRange = 9.0;
    this._pool = null;
    this._poolOwner = null;
  }

  init() {
    const scene = this.ctx.scene;
    // Padding lights keep NUM_POINT_LIGHTS constant while real lights come and
    // go, which avoids a full material recompile mid-gallop.
    for (let i = 0; i < this.budget; i++) {
      const d = new THREE.PointLight(0x000000, 0, 0.05, 2);
      d.visible = false;
      d.userData.__rsDummy = true;
      d.name = 'rsLightSlot' + i;
      scene.add(d);
      this.dummies.push(d);
    }

    /* --------------------------------------------------- fire floor projector */
    /*
     * Pass 1 shipped point-light shadows that were never once switched on,
     * because a point shadow is SIX full scene passes and the terrain is a
     * single 24 km instanced draw that never frustum-culls: the campfire in
     * night_camp cost six 4 M-triangle passes or it cast nothing, so it cast
     * nothing, and the critique measured "the three boulders in front of the
     * fire cast NO shadow whatsoever".
     *
     * A downward spot light solves both halves of that finding at once:
     *   - ONE shadow pass instead of six, with a 13 m far plane that frustum-
     *     culls everything except the ring of stones and logs;
     *   - it carries a projected cookie, so the pool of light on the sand is a
     *     lobed, noisy, occluded shape instead of the "perfect uncontrolled
     *     radial" the critique also measured.
     *
     * It is created ONCE and never removed, and `map` / `castShadow` never
     * toggle, so NUM_SPOT_LIGHTS / NUM_SPOT_LIGHT_MAPS / NUM_SPOT_LIGHT_SHADOWS
     * are constant for the life of the process and no material ever recompiles
     * because a fire came into range. When no fire owns it, it is parked far
     * below the world with autoUpdate off and costs nothing at all.
     */
    const cookie = makeFirePoolCookie(this.ctx.quality.name === 'low' ? 128 : 256, this._rand);
    /*
     * `distance` is 9, not 26, and that is load-bearing: THREE.SpotLightShadow
     * .updateMatrices does `camera.far = light.distance || camera.far`, so the
     * 13 m far plane configured below was being silently overwritten by the
     * light's 26 m range every frame. A 0.05..26 m perspective frustum at a
     * 160-degree fov spends almost all of its depth precision in the first
     * centimetre; pulling the far plane in to the 9 m the projector can actually
     * illuminate is what lets a 30 cm stone register against the sand.
     */
    const spot = new THREE.SpotLight(0xffffff, 0, 9, 1.40, 0.85, 2);
    spot.name = 'rsFirePool';
    spot.map = cookie;
    spot.castShadow = true;
    spot.shadow.mapSize.set(this.localShadowSize, this.localShadowSize);
    spot.shadow.bias = -0.0009;
    spot.shadow.normalBias = 0.012;
    spot.shadow.radius = 2;
    spot.shadow.camera.near = 0.06;
    spot.shadow.camera.far = 9;
    spot.shadow.camera.updateProjectionMatrix();
    spot.shadow.autoUpdate = false;   // only ever refreshed while a fire owns it
    spot.position.set(0, -9000, 0);
    spot.target.position.set(0, -9001, 0);
    /* Starts OUT of the scene — see _updatePool. A resident spot with a cookie
       and a shadow costs every lit material two texture units, and the terrain
       program has none to spare. It joins the scene when a fire claims it. */
    this._pool = spot;
    /** Refresh bookkeeping for the projector's depth map — see _updatePool. */
    this._poolShadowPos = new THREE.Vector3(0, -9000, 0);
    this._poolShadowOwner = null;
    this._poolShadowTick = 0;
    this._poolCookie = cookie;
    this._poolIdle = 999;
  }

  /* ------------------------------------------------------------------ API */

  add(light, opts = {}) {
    if (!light) return light;
    if (this.entries.some((e) => e.light === light)) return light;

    const isFire = opts.fire === true || (opts.raw !== true && (opts.flicker ?? 0) >= 0.45);
    let base = light.intensity;
    if (isFire) {
      /*
       * Re-author the COLOUR, respect the caller's brightness.
       *
       * The measured pass-1 defect was hue, not level: the core came out at
       * (0.838, 0.872, 0.860), saturation 0.071, green-dominant. So the colour
       * is replaced unconditionally with a ~1980 K Planckian radiator whose max
       * channel is exactly 1, which is what keeps INTENSITY a separate scalar
       * and stops a caller "brightening" a fire by pushing its colour past the
       * shoulder until all three channels converge on white. Brightness itself
       * is the caller's to art-direct, up to a ceiling.
       */
      flameColor(opts.kelvin ?? FIRE_DEFAULTS.kelvin, opts.soot ?? FIRE_DEFAULTS.soot, light.color);
      if (opts.intensity != null) base = opts.intensity;
      base = Math.min(base, opts.intensityCap ?? FIRE_DEFAULTS.intensityCap);
      if (light.decay !== 2) light.decay = 2;
    }

    const e = {
      light,
      fire: isFire,
      flicker: opts.flicker ?? (isFire ? FIRE_DEFAULTS.flicker : 0),
      radius: opts.radius ?? light.distance ?? 14,
      importance: opts.importance ?? 1,
      wantsShadow: opts.shadow !== undefined ? !!opts.shadow : isFire,
      pool: opts.pool !== false,
      baseIntensity: base,
      baseColor: light.color.clone(),
      kelvin: opts.kelvin ?? FIRE_DEFAULTS.kelvin,
      warm: opts.warmShift ?? 0.35,
      phase: this._rand() * 100,
      speed: 0.75 + this._rand() * 0.9,
      jitter: opts.jitter ?? 0,
      basePos: light.position.clone(),
      /** World-space copy of basePos; the light may be parented to a group. */
      worldBase: light.position.clone(),
      weight: 0,
      score: 0,
      env: 0.5,
      mul: 1,
    };
    if (light.distance === 0 || light.distance === undefined) light.distance = e.radius;
    light.castShadow = false;
    if (!light.parent) this.ctx.scene.add(light);
    light.visible = false;
    light.intensity = 0;
    this.entries.push(e);
    return light;
  }

  remove(light) {
    const i = this.entries.findIndex((e) => e.light === light);
    if (i === -1) return;
    const e = this.entries[i];
    e.light.intensity = e.baseIntensity;
    e.light.color.copy(e.baseColor);
    e.light.castShadow = false;
    this.entries.splice(i, 1);
    if (this._poolOwner === e) this._poolOwner = null;
    const f = this._fires.indexOf(e);
    if (f !== -1) this._fires.splice(f, 1);
  }

  /**
   * Build a complete campfire light rig at a world position.
   *
   * Two coupled emitters, because one point light is a lamp, not a fire: a
   * bright low core sitting inside the fuel bed (which is what throws the long
   * outward shadows of the logs and stones) and a dimmer, hotter, higher tip
   * that lights faces above the ring. Both ride the same flicker envelope, and
   * the core is jittered by a few centimetres so the shadows waver.
   *
   * @returns {{core:THREE.PointLight, tip:THREE.PointLight, flicker:number,
   *            emissive:THREE.Color, setPosition:Function, dispose:Function}}
   */
  addFire(position, opts = {}) {
    const o = { ...FIRE_DEFAULTS, ...opts };
    const scene = this.ctx.scene;

    const core = new THREE.PointLight(0xffffff, o.intensity, o.radius, 2);
    core.name = 'fireCore';
    core.position.set(position.x, position.y + o.height, position.z);
    scene.add(core);
    this.add(core, {
      fire: true,
      kelvin: o.kelvin,
      soot: o.soot,
      intensity: o.intensity,
      flicker: o.flicker,
      radius: o.radius,
      importance: o.importance,
      shadow: o.shadow,
      jitter: 0.045,
    });

    // The tip is hotter (less soot in the plume) and much dimmer.
    const tip = new THREE.PointLight(0xffffff, o.intensity * 0.30, o.radius * 0.55, 2);
    tip.name = 'fireTip';
    tip.position.set(position.x, position.y + o.height + 0.55, position.z);
    scene.add(tip);
    this.add(tip, {
      fire: true,
      kelvin: o.kelvin + 420,
      soot: o.soot + 0.06,
      intensity: o.intensity * 0.30,
      flicker: Math.min(0.85, o.flicker + 0.2),
      radius: o.radius * 0.55,
      importance: o.importance - 1,
      shadow: false,
      pool: false,        // the core owns the floor projector, never the plume
      jitter: 0.09,
    });

    const coreEntry = this.entries[this.entries.length - 2];
    const tipEntry = this.entries[this.entries.length - 1];
    tipEntry.phase = coreEntry.phase + 0.09; // same fire, slight lag up the plume
    tipEntry.speed = coreEntry.speed;

    const handle = {
      core,
      tip,
      flicker: 0.5,
      /** Linear HDR colour the flame billboard should be authored in. */
      emissive: flameColor(o.kelvin, o.soot).clone(),
      kelvin: o.kelvin,
      setPosition: (p) => {
        coreEntry.basePos.set(p.x, p.y + o.height, p.z);
        tipEntry.basePos.set(p.x, p.y + o.height + 0.55, p.z);
      },
      dispose: () => {
        this.remove(core);
        this.remove(tip);
        core.removeFromParent();
        tip.removeFromParent();
        const i = this._fires.indexOf(handle);
        if (i !== -1) this._fires.splice(i, 1);
      },
    };
    coreEntry.handle = handle;
    this._fires.push(handle);
    return handle;
  }

  /* --------------------------------------------------------------- update */

  update(dt) {
    const ctx = this.ctx;
    if (this.entries.length === 0) {
      this._applySlots(0);
      return;
    }
    const cam = ctx.camera;
    const t = ctx.time.elapsed;
    const list = this._scratch;
    list.length = 0;

    for (const e of this.entries) {
      // basePos is in the light's PARENT space — Town parents its campfire
      // light to a group placed at the camp — so the projector, which lives in
      // world space, has to be given the transformed copy.
      e.worldBase.copy(e.basePos);
      if (e.light.parent && e.light.parent !== ctx.scene) {
        e.light.parent.updateWorldMatrix(true, false);
        e.worldBase.applyMatrix4(e.light.parent.matrixWorld);
      }
      _wp.copy(e.worldBase);
      const d = Math.max(0.01, _wp.distanceTo(cam.position));
      const cull = e.radius * 6 + 24;
      const near = 1 - THREE.MathUtils.smoothstep(d, cull * 0.72, cull);
      e.score = (e.importance * e.radius * e.radius) / (d * d + 1) + near * 0.001;
      e.distFade = near;
      list.push(e);
    }
    list.sort((a, b) => b.score - a.score);

    let wanted = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const target = i < this.budget ? e.distFade : 0;
      // Smooth ramp so a light entering/leaving the budget dissolves.
      const k = 1 - Math.exp(-dt * 3.5);
      e.weight += (target - e.weight) * k;
      if (e.weight < 0.002) e.weight = target < 0.002 ? 0 : e.weight;
      if (e.weight > 0.002 && i < this.budget) wanted++;

      const f = e.flicker > 0 ? flameEnvelope(t, e.phase, e.speed) : 1;
      e.env = f;
      const amp = e.flicker;
      const mul = 1 - amp + amp * (0.42 + 1.05 * f);
      /*
       * HARD RANK CLAMP — this is load-bearing, see `_applySlots`.
       *
       * `target` is already 0 for everything past the budget, but the weight
       * ramp takes ~0.3 s to get there, so a ninth light stayed VISIBLE while it
       * faded. NUM_POINT_LIGHTS is the number of visible point lights, the
       * padding pool is only `budget` deep, and the count is therefore
       * unpaddable the moment it exceeds the budget. The probe caught exactly
       * that: riding into town the count went 1,2,3,4,5,8,9 and every one of
       * those values relinked all 27 lit programs in the scene.
       *
       * A light demoted out of the top `budget` is by definition the least
       * important one on screen and is already fading; cutting it here is the
       * cheapest possible place to lose one.
       */
      e.light.visible = e.weight > 0.002 && i < this.budget;
      // Whatever share of the fire the floor projector is carrying comes OUT of
      // the omni light, so moving to a shaped pool does not double the ground
      // irradiance — it redistributes it.
      const share = e === this._poolOwner ? 1 - this.poolShare : 1;
      e.light.intensity = e.baseIntensity * e.weight * mul * share;
      e.mul = mul;

      if (amp > 0) {
        // A flame that dips is cooler AND dimmer: the soot cools by a couple of
        // hundred kelvin as the plume collapses. Drive it through the blackbody
        // so the hue walks along the Planckian locus instead of desaturating.
        if (e.fire) {
          flameColor(e.kelvin + (f - 0.5) * 460, 0.16, e.light.color);
        } else {
          const warm = e.warm * (1 - f);
          e.light.color.setRGB(
            e.baseColor.r * (1 + warm * 0.12),
            e.baseColor.g * (1 - warm * 0.16),
            e.baseColor.b * (1 - warm * 0.42),
          );
        }
      }

      if (e.jitter > 0) {
        const p = t * e.speed + e.phase;
        e.light.position.set(
          e.basePos.x + Math.sin(p * 5.3) * e.jitter,
          e.basePos.y + (f - 0.5) * e.jitter * 1.6,
          e.basePos.z + Math.sin(p * 4.1 + 2.1) * e.jitter,
        );
      }
    }

    for (const h of this._fires) {
      const ce = this.entries.find((x) => x.light === h.core);
      if (ce) h.flicker = ce.env;
    }

    this._updatePool(list, dt, t);
    this._applySlots(wanted);
  }

  /**
   * Point the one floor projector at the most important fire in range and drive
   * it from that fire's own flicker envelope, so the pool on the ground, the
   * shadows the stones throw into it and the flame billboard all breathe
   * together. A light that pulses out of phase with its flame reads as a bug.
   */
  _updatePool(list, dt, t) {
    const spot = this._pool;
    if (!spot) return;

    // Deliberately NOT gated on `wantsShadow`: a caller that passed
    // `shadow:false` was refusing a six-pass cube map, which is a reasonable
    // thing to refuse and is not what this is. `pool:false` opts out properly.
    let best = null;
    for (const e of list) {
      if (e.fire && e.pool !== false && e.weight > 0.30 && e.baseIntensity > 0) {
        best = e;
        break;
      }
    }
    // Hysteresis on the hand-over only; the drive below runs every frame.
    if (best !== this._poolOwner) {
      this._shadowHold += dt;
      if (this._shadowHold > 0.4) {
        this._poolOwner = best;
        this._shadowHold = 0;
      }
    } else {
      this._shadowHold = 0;
    }

    const owner = this._poolOwner;
    if (!owner || owner.weight <= 0.02) {
      spot.intensity = 0;
      // Park it under the world: its 13 m frustum then contains nothing, and
      // with autoUpdate off the shadow pass is skipped entirely.
      if (spot.position.y > -1000) {
        spot.position.set(0, -9000, 0);
        spot.target.position.set(0, -9001, 0);
        spot.target.updateMatrixWorld();
      }
      /*
       * ...and take it OUT OF THE SCENE once it has been idle for a moment.
       *
       * Parking it was not enough. A resident SpotLight with `map` and
       * `castShadow` set costs every lit material in the world two texture
       * units (spotLightMap[0] + spotShadowMap[0]) whether or not it is
       * switched on. The terrain program was linking SEVENTEEN samplers
       * against a MAX_TEXTURE_IMAGE_UNITS of 16, so the driver rejected its
       * draw call every frame and the entire landscape vanished — in daylight
       * shots, where there is no campfire anywhere near the camera, two of
       * those seventeen belonged to this light.
       *
       * Adding/removing it does change NUM_SPOT_LIGHT_* and therefore
       * recompiles materials, which is exactly what the original design was
       * avoiding. Hence the debounce: a full second of continuous idleness
       * before it leaves, and immediate re-entry below. In practice that is
       * one recompile as you walk up to a camp and one as you leave it.
       */
      this._poolIdle = (this._poolIdle || 0) + dt;
      if (this._poolIdle > 1.0 && spot.parent) {
        spot.removeFromParent();
        spot.target.removeFromParent();
      }
      return;
    }
    this._poolIdle = 0;
    if (!spot.parent) this.ctx.scene.add(spot, spot.target);

    /*
     * Height is measured from the GROUND, not from the light, because callers
     * author the flame's luminous centre anywhere between 0.3 m and 0.6 m and
     * the pool's radius is set by how high the projector sits: cone radius =
     * height * tan(angle). Anchoring to the terrain keeps a ~4 m pool whatever
     * the fire's own authoring, and keeps the projector inside the flame rather
     * than floating above it like a street lamp.
     */
    const b = owner.worldBase;
    const world = this.ctx.world;
    const gy = world && world.ready ? world.getHeight(b.x, b.z) : b.y - 0.4;
    spot.position.set(b.x, Math.max(b.y + 0.12, gy + this.poolHeight), b.z);

    // Fires lean downwind, and the pool leans with them. This also keeps the
    // spot's axis off exact vertical, where lookAt's basis is degenerate.
    const wind = this.ctx.env.windVector;
    const lean = 0.10 + 0.035 * Math.sin(t * 0.7 + owner.phase);
    spot.target.position.set(
      b.x + wind.x * lean,
      b.y - 2.4,
      b.z + wind.z * lean,
    );
    spot.target.updateMatrixWorld();

    spot.color.copy(owner.light.color);
    // Deliberately NOT owner.radius — see the note where the spot is built:
    // light.distance overwrites the shadow camera's far plane.
    spot.distance = 9;
    spot.intensity = owner.baseIntensity * owner.weight * (owner.mul || 1) * this.poolShare
      * this.poolBoost;
    /*
     * TEMPORAL REFRESH.
     *
     * Redrawing the projector's depth map every frame was measured at ~6 ms and
     * ~50 draw calls of night_camp's 24.5 ms / 225 — by a wide margin the most
     * expensive single thing in that shot. Nothing it draws moves: the fire ring
     * stones, the logs, the tripod and the bedroll are static geometry, and the
     * only animation on the projector itself is a few-centimetre wind lean on
     * the TARGET, which moves the shadows by well under a texel. Refresh when
     * the rig genuinely changes (new owner, projector translated) and otherwise
     * on a 4-frame heartbeat so a moving prop still resolves within 66 ms.
     */
    const moved = this._poolShadowPos.distanceToSquared(spot.position) > 1e-4
      || this._poolShadowOwner !== owner;
    this._poolShadowTick = (this._poolShadowTick || 0) + 1;
    if (moved || this._poolShadowTick >= 4) {
      this._poolShadowTick = 0;
      this._poolShadowPos.copy(spot.position);
      this._poolShadowOwner = owner;
      spot.shadow.needsUpdate = true;
    }
  }

  /* ------------------------------------------------- heavy-caster gating */

  /** Estimated triangles this object contributes to one shadow pass. */
  static _cost(o) {
    const g = o.geometry;
    if (!g) return 0;
    const idx = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
    let inst = 1;
    if (o.isInstancedMesh) inst = o.count;
    else if (g.isInstancedBufferGeometry && g.instanceCount !== Infinity) inst = g.instanceCount || 1;
    return (idx / 3) * Math.max(1, inst);
  }

  /**
   * Called after the cascades are rendered and before three's own shadow pass.
   * Hides the heavyweights from local (point/spot) shadow maps only; the sun
   * cascades already rendered them, and they are restored next frame.
   */
  suppressHeavyCasters(casters) {
    const out = this._suppressed;
    out.length = 0;
    const owner = this._poolOwner;
    if (!owner) return;
    const spot = this._pool;
    const px = spot ? spot.position.x : owner.worldBase.x;
    const py = spot ? spot.position.y : owner.worldBase.y;
    const pz = spot ? spot.position.z : owner.worldBase.z;
    const range = this.poolCasterRange;

    for (let i = 0; i < casters.length; i++) {
      const o = casters[i];
      if (!o.castShadow) continue;
      if (o.userData.rsLocalShadow === true) continue;
      let drop = o.userData.rsNoLocalShadow === true ||
        LocalLights._cost(o) > this.heavyCasterTris ||
        (o.frustumCulled === false && LocalLights._cost(o) > 4000);

      /*
       * PROXIMITY WHITELIST.
       *
       * The cost gate above is not enough now that shadow casters are enrolled
       * automatically: the campfire's 9 m frustum would still be handed every
       * tree LOD and scatter batch in the world, and three only frustum-culls
       * objects that opted into culling. Anything whose world bounding sphere
       * cannot reach the projector is dropped outright, which is what keeps a
       * lit campfire to a handful of small draws — the logs, the ring stones,
       * the tripod, the bedroll — instead of the whole landscape.
       */
      if (!drop) {
        const g = o.geometry;
        if (g) {
          if (g.boundingSphere === null) g.computeBoundingSphere();
          const bs = g.boundingSphere;
          if (bs) {
            const m = o.matrixWorld.elements;
            const s = Math.max(
              Math.hypot(m[0], m[1], m[2]),
              Math.hypot(m[4], m[5], m[6]),
              Math.hypot(m[8], m[9], m[10]),
            );
            // Instanced batches place copies far from the base geometry's own
            // centre, so their sphere says nothing useful; keep them if they are
            // cheap and let the frustum sort it out.
            const instanced = o.isInstancedMesh || o.isBatchedMesh ||
              (g.isInstancedBufferGeometry === true);
            if (!instanced) {
              const cx = bs.center.x * m[0] + bs.center.y * m[4] + bs.center.z * m[8] + m[12];
              const cy = bs.center.x * m[1] + bs.center.y * m[5] + bs.center.z * m[9] + m[13];
              const cz = bs.center.x * m[2] + bs.center.y * m[6] + bs.center.z * m[10] + m[14];
              const reach = bs.radius * s + range;
              const dx = cx - px;
              const dy = cy - py;
              const dz = cz - pz;
              if (dx * dx + dy * dy + dz * dz > reach * reach) drop = true;
            }
          }
        }
      }

      if (drop) {
        o.castShadow = false;
        out.push(o);
      }
    }
  }

  restoreHeavyCasters() {
    const out = this._suppressed;
    for (let i = 0; i < out.length; i++) out[i].castShadow = true;
    out.length = 0;
  }

  /**
   * The complete set of NUM_POINT_LIGHTS values this manager can ever produce.
   * Every value in it is a separate shader permutation of every lit material in
   * the world, so it is deliberately SHORT — and it is what ShaderWarm links
   * ahead of time.
   */
  slotLadder() {
    const out = [0];
    for (let n = this.step; n < this.budget; n += this.step) out.push(n);
    /* `_applySlots` clamps to the budget, so the budget itself is always a
     * reachable rung even when it is not a multiple of `step` — at `medium`,
     * budget 6 / step 4 gives {0, 4, 6}. Miss it and the one rung that never
     * gets pre-warmed is the one you hit in the middle of town. */
    if (out[out.length - 1] !== this.budget) out.push(this.budget);
    return out;
  }

  /**
   * Force exactly `n` visible point lights for a pre-warm compile, and return
   * the function that puts everything back. Nothing renders in between, so this
   * is invisible; it exists purely to move a program link off the frame where
   * the lamp actually switches on.
   *
   * @param {number} n
   * @returns {Function} restore
   */
  forceSlots(n) {
    const saved = [];
    for (const e of this.entries) { saved.push([e.light, e.light.visible]); e.light.visible = false; }
    for (let i = 0; i < this.dummies.length; i++) {
      saved.push([this.dummies[i], this.dummies[i].visible]);
      this.dummies[i].visible = i < n;
    }
    return () => { for (const [l, v] of saved) l.visible = v; };
  }

  /**
   * Put the fire floor projector in or out of the scene for a pre-warm compile,
   * and return the function that puts it back.
   *
   * The projector joining the scene changes NUM_SPOT_LIGHTS / _MAPS / _SHADOWS,
   * which relinks every lit material — `_updatePool` already documents that as
   * the accepted price of not costing the terrain program two texture units it
   * does not have. Accepted, but measured at a 446 ms frame the first time you
   * walk up to a campfire, which is why it is warmed rather than merely
   * tolerated. Nothing renders between apply and restore.
   *
   * @param {boolean} on
   * @returns {Function} restore
   */
  forcePool(on) {
    const spot = this._pool;
    if (!spot) return () => {};
    const had = !!spot.parent;
    if (!!on === had) return () => {};
    if (on) this.ctx.scene.add(spot, spot.target);
    else { spot.removeFromParent(); spot.target.removeFromParent(); }
    return () => {
      if (had) { if (!spot.parent) this.ctx.scene.add(spot, spot.target); }
      else { spot.removeFromParent(); spot.target.removeFromParent(); }
    };
  }

  /**
   * Quantise the number of visible point lights to avoid shader thrash.
   *
   * THE BUG THIS USED TO HAVE, because it is subtle and cost a playtester a
   * multi-second freeze on the ride into town:
   *
   * The hold counter was applied in BOTH directions, so on the way up
   * `_slotTarget` lagged the real count by 40 frames. `pad` is
   * `_slotTarget - wanted`, which during that lag is <= 0 — i.e. the padding
   * pool, the entire mechanism, was switched off for precisely the 40 frames in
   * which the count was climbing. NUM_POINT_LIGHTS therefore visited every
   * integer on the way to the ladder rung and the scene relinked ~27 programs
   * on each one.
   *
   * Raising the rung has to be INSTANT (it is free — the dummies are already
   * there); only the way down needs hysteresis, so that riding past a lamp does
   * not drop a rung and immediately climb back.
   */
  _applySlots(wanted) {
    const need = Math.min(this.budget, Math.ceil(wanted / this.step) * this.step);
    if (need > this._slotTarget) {
      this._slotTarget = need;
      this._slotHold = 0;
    } else if (need < this._slotTarget) {
      this._slotHold++;
      if (this._slotHold > 45) {
        this._slotTarget = need;
        this._slotHold = 0;
      }
    } else {
      this._slotHold = 0;
    }
    const pad = Math.max(0, this._slotTarget - wanted);
    for (let i = 0; i < this.dummies.length; i++) this.dummies[i].visible = i < pad;
  }

  dispose() {
    this.restoreHeavyCasters();
    for (const d of this.dummies) d.removeFromParent();
    this.dummies.length = 0;
    this.entries.length = 0;
    this._fires.length = 0;
    if (this._pool) {
      this._pool.shadow.dispose();
      this._pool.target.removeFromParent();
      this._pool.removeFromParent();
      this._pool = null;
    }
    if (this._poolCookie) {
      this._poolCookie.dispose();
      this._poolCookie = null;
    }
    this._poolOwner = null;
  }
}
