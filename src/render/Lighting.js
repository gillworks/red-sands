import * as THREE from 'three';
import { CascadedShadowMaps } from './lighting/CascadedShadowMaps.js';
import { LocalLights, FIRE_DEFAULTS } from './lighting/LocalLights.js';
import { SHADOW_LAYER, patchLightFalloff } from './lighting/ShadowShader.js';
import { ShaderWarm } from './lighting/ShaderWarm.js';
import { blackbodyLinear, flameColor } from './lighting/FireLight.js';

/* -------------------------------------------------------------------------- */
/*  Linear-HDR authoring helpers. Everything below is LINEAR radiance, never   */
/*  sRGB — the renderer is NoToneMapping and PostFX owns the curve.            */
/* -------------------------------------------------------------------------- */

const _v = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();

/** Linear diffuse albedo of each terrain surface, used to tint the ground bounce. */
const GROUND_ALBEDO = {
  grass: [0.155, 0.152, 0.072],
  rock: [0.185, 0.158, 0.126],
  dirt: [0.238, 0.170, 0.098],
  sand: [0.400, 0.320, 0.196],
  snow: [0.700, 0.735, 0.810],
};

/**
 * Lighting — key light, sky/bounce ambient, cascaded shadow maps and the
 * budgeted local-light manager.
 *
 * Public surface (see also docs/CONTRACTS.md §4.3):
 *   L.sun                                  DirectionalLight driving the cascades
 *   L.moon                                 night key light
 *   L.addLight(light, { flicker, radius, importance, shadow })
 *   L.addFireLight(position, opts)         complete campfire rig — see below
 *   L.flameColor(kelvin, soot)             linear HDR blackbody, max chan == 1
 *   L.removeLight(light)
 *   L.requestShadowCaster(object3d)
 *   L.registerMaterial(materialOrArray)    patch a material immediately
 *   L.registerMaterialUser(fn)             called for every material we patch
 *   L.shadowChunk() / shadowUniforms() / shadowDefines()
 *                                          for hand-written ShaderMaterials
 *   L.invalidate()                         you added a lot of geometry, rescan now
 *
 * Shadow-caster opt-in is just `object.castShadow = true`; vertex-animated
 * casters should set `object.customDepthMaterial`. Layer bit 7 is reserved.
 *
 * CAMPFIRES — for Town / any system that builds fire geometry
 * -----------------------------------------------------------
 *     const fire = ctx.get('lighting').addFireLight( worldPos, { radius: 26 } );
 *     // every frame:
 *     flameMaterial.uniforms.uFlicker.value = fire.flicker;   // 0..1, coherent
 *     flameMaterial.uniforms.uColor.value.copy( fire.emissive );
 *
 * `fire.emissive` is the linear-HDR blackbody colour of the flame (~1980 K,
 * roughly (1.0, 0.42, 0.12) normalised). Author the billboard as
 * `emissive * peakRadiance * flicker` and scale PEAK RADIANCE, never the
 * colour — pushing a colour past the filmic shoulder is what turned the pass-1
 * campfire into a green-dominant white disc. Keep peak radiance around 1.5-3.0
 * linear so AgX's shoulder desaturates only the innermost pixels.
 * `fire.flicker` is the same envelope that drives the light, so the flame, the
 * pool on the ground and the shadows all breathe together.
 */
export class Lighting {
  static id = 'lighting';
  static SHADOW_LAYER = SHADOW_LAYER;

  constructor(ctx) {
    this.ctx = ctx;

    // Patch three's lighting chunk in the constructor: this must happen before
    // any material in the scene compiles its first program.
    this.csm = new CascadedShadowMaps(ctx);
    this.local = new LocalLights(ctx);

    // Punctual lights get a physical source radius. Must happen before any
    // material compiles; see patchLightFalloff for why.
    // 0.85 m is the luminous VOLUME of a camp fire, not the diameter of its
    // brightest point. It matters because three otherwise models a mathematical
    // point and anything within a few centimetres of the flame — the fuel bed,
    // the stones, a blade of grass at the ring — sits at 100x the light's
    // intensity and clips all three channels to white. That is precisely the
    // "colourless white blob" the pass-1 critique measured.
    patchLightFalloff(0.85);

    /**
     * tan of the source's angular RADIUS, i.e. penumbra growth per metre of
     * caster/receiver separation. The sun's disc is 0.5334 degrees across, so
     * this is tan(0.2667 deg) = 4.655e-3 — not a tuned number, a measured one.
     * PCSS multiplies it by the blocker separation, which is what makes contact
     * points sharp and the tip of a 300 m golden-hour shadow 1.4 m soft.
     */
    this.sunPenumbra = Math.tan(THREE.MathUtils.degToRad(0.5334 * 0.5));
    /** The moon is the same angular size but is read against a glowing sky. */
    this.moonPenumbra = this.sunPenumbra * 1.8;
    /**
     * Never let the night go fully black — the player has to be able to ride.
     * `nightKeyFloor` lifts the moon when it is up; `nightSkyGlow` is an
     * absolute cold-blue irradiance floor (starlight + airglow + the last of
     * the twilight) that survives even a moonless night.
     */
    /*
     * 0.30 was tuned to make a moonless night navigable, but it doubles as a
     * broad blue wash over everything — and a blue wash laid over an orange
     * campfire pool is how you get the pass-1 result of a fire with no hue. A
     * campfire scene has to be able to be a campfire scene: deep blue-black
     * surround, warm pool, high chroma contrast between them. 0.17 still reads
     * as navigable moonlight and leaves the fire its colour.
     */
    this.nightKeyFloor = 0.26;
    // Weighted hard toward blue: scotopic night should read cold and desaturated
    // even over warm/green albedo.
    // Raised ~2.4x during integration: with the composited frame (aerial
    // perspective collapsing the distance to near-black at night, plus AgX and
    // the night grade) the old floor left moonlit_ridge and night_camp as flat
    // black frames even with auto-exposure pinned near its 19x ceiling.
    /*
     * Pass 3 pulls this back to 0.60x. A campfire scene has to be able to BE a
     * campfire scene, and this term is a flat blue wash applied to every pixel
     * in it: at night auto-exposure sits on its 19x ceiling, so an irradiance of
     * 0.041 arrives on screen as ~0.77 of display luminance BEFORE the fire
     * contributes anything. Measured against it, the fire's own (1.0, 0.36,
     * 0.14) pool at three metres was diluted to a near-neutral grey — which is
     * exactly the "FIRELIGHT HAS NO COLOR TEMPERATURE / everything the fire
     * touches is cream/white/monochrome" tell. Lowering the floor does not make
     * the fire brighter; it makes everything the fire does NOT touch properly
     * dark, which is the only way a warm pool can read as warm.
     */
    this.nightSkyGlow = new THREE.Color(0.0138, 0.0222, 0.0768);
    /** Set false if another system takes over scene.fog. */
    this.ownFog = true;
    this.fogDensityFloor = 0.00042;

    /* --------------------------------------------------- ambient balance */
    /** How hard the upper lobe is pushed toward blue (chroma only, 0..1). */
    this.skyCoolBias = 0.85;
    /**
     * Minimum effective cos(zenith) used for the ground bounce. The terrain is
     * not a plane; at a 3-degree sun the slopes facing it are still near normal
     * incidence and they are what fills the shadows with ochre.
     */
    this.lowSunBounceFloor = 0.17;
    /**
     * Fraction of the ground irradiance that comes back as the lower lobe.
     * 0.62 -> 0.95 in pass 3. `town_street`'s barn facade collapsing to "a flat
     * dark maroon with almost no readable detail while the sand two metres away
     * is blown out" is a missing-bounce tell, and the numbers agreed: a vertical
     * face in that shot was receiving 0.271 of ambient against 1.702 of direct
     * on the lit sand — 2.6 stops with nothing in between. Raising the LOWER
     * lobe lifts side- and down-facing normals without touching flat ground,
     * because a hemisphere light at N.y = +1 is 100% sky lobe.
     */
    this.bounceGain = 0.95;
    /** Strength of the directional under-fill (undersides, shadowed faces). */
    this.bounceDirGain = 0.42;
    /**
     * The counter-bounce carries this share of the main bounce. It exists
     * because ONE directional fill from below can only ever light faces turned
     * toward the sun's azimuth: a wall whose normal points away from the sun —
     * which is precisely the shaded facade the critique measured — got nothing
     * from it. The light bouncing off the sunlit ground in front of such a wall
     * arrives from below on the OPPOSITE azimuth, so that is where the second
     * lobe lives.
     */
    this.counterBounce = 0.62;

    /* ------------------------------------------------ shadowed-ambient model */
    /**
     * Target luminance of a shadowed surface as a fraction of the same surface
     * lit. A cast shadow removes the direct term; this decides how much of the
     * AMBIENT it is also allowed to remove, on the physical grounds that a point
     * the sun cannot see is normally a point that cannot see much sky either.
     *
     * Without it, golden hour cannot have shadows at all: measured on
     * `golden_hour_vista`, direct irradiance on flat ground is 0.0753 against
     * 0.1556 of skylight, so a *perfect* cascade darkens the ground by 33% and
     * the frame still reads "no cast shadows". With it the ratio lands near
     * 4:1 and the long raking shapes do the compositional work they are named
     * for. At noon the direct term is 16x the ambient, the solve saturates at
     * 1.0, and nothing is subtracted — which is what stops shadowed rock faces
     * crushing to the near-black the `river_bend` critique measured.
     */
    this.shadowFloor = 0.155;
    /** Hard floor on the ambient multiplier: shadows must stay READABLE. */
    this.shadowAmbientFloorDay = 0.42;
    this.shadowAmbientFloorNight = 0.82;
    /**
     * Ceiling. Even under a sun that already outguns the sky 16:1, a point the
     * sun cannot see has lost SOME of its sky as well, so the solve is never
     * allowed to return "no ambient occlusion at all". 0.90 is small enough that
     * it cannot crush a shadowed rock face and large enough to give a high-noon
     * shadow a defined edge instead of a pure direct-light cutout.
     */
    this.shadowAmbientMax = 0.90;
    /**
     * Unit-luminance cool tilt applied to the ambient inside shadow. Skylight is
     * the only thing filling a shadow, and skylight is blue; the warm ochre
     * bounce off the ground belongs to surfaces that can SEE the sunlit ground.
     * `town_street` measured its street shadow at B-R = -0.146, i.e. warmer than
     * the lit ground — the exact inverse of §5 — and this is the term that fixes
     * it without touching the lit side of the frame.
     *
     * PASS-3 INTEGRATION: 1.55 on blue was tuned on open-sky shadows, where the
     * fill genuinely IS skylight. It is applied wherever the key is occluded,
     * which under a closed canopy is every pixel — and forest_interior came out
     * with a lavender-grey floor (B-R +0.044, saturation 0.36) in the middle of
     * a sunlit morning, because the fill there is transmitted green and warm
     * litter bounce, not blue sky. Halving the tilt keeps the town/golden-hour
     * warm-cool split that §5 asks for and takes the forest floor back to
     * neutral; the shot-by-shot numbers are in the integration report.
     */
    this.shadowChroma = new THREE.Color(0.88, 1.00, 1.26);

    this._keyIsMoon = false;
    this._groundAlbedo = new THREE.Color(0.22, 0.18, 0.11);
    this._skyLobe = new THREE.Color();
    this._groundLobe = new THREE.Color();
    this._materialHooks = [];
  }

  async init() {
    const ctx = this.ctx;
    const scene = ctx.scene;

    // Local point-light shadows use three's own path; PCFSoftShadowMap is
    // deprecated in r0.185 and would warn on first use.
    if (ctx.renderer.shadowMap.type === THREE.PCFSoftShadowMap) {
      ctx.renderer.shadowMap.type = THREE.PCFShadowMap;
    }

    /* ------------------------------------------------------------ key light */
    this.sun = new THREE.DirectionalLight(0xffffff, 3.0);
    this.sun.castShadow = false; // cascades are rendered by CascadedShadowMaps
    this.sun.name = 'sun';
    this.sunTarget = new THREE.Object3D();
    scene.add(this.sun, this.sunTarget);
    this.sun.target = this.sunTarget;

    this.moon = new THREE.DirectionalLight(0x8fb0e8, 0.0);
    this.moon.castShadow = false;
    this.moon.name = 'moon';
    this.moonTarget = new THREE.Object3D();
    scene.add(this.moon, this.moonTarget);
    this.moon.target = this.moonTarget;

    /* --------------------------------------------- ground-bounce fill light */
    // Fakes the single diffuse bounce off the sunlit ground: comes from below,
    // carries the terrain's own colour, and is never shadowed.
    this.bounce = new THREE.DirectionalLight(0xffffff, 0.0);
    this.bounce.castShadow = false;
    this.bounce.name = 'groundBounce';
    this.bounceTarget = new THREE.Object3D();
    scene.add(this.bounce, this.bounceTarget);
    this.bounce.target = this.bounceTarget;

    // Second lobe on the opposite azimuth — see `counterBounce`.
    this.bounce2 = new THREE.DirectionalLight(0xffffff, 0.0);
    this.bounce2.castShadow = false;
    this.bounce2.name = 'groundBounceBack';
    this.bounce2Target = new THREE.Object3D();
    scene.add(this.bounce2, this.bounce2Target);
    this.bounce2.target = this.bounce2Target;

    /* -------------------------------------------------- sky / bounce ambient */
    // Hemisphere irradiance: cool blue skylight from above, warm ochre ground
    // bounce from below. Magnitudes live in the colours (intensity stays 1) so
    // the two halves can be balanced independently.
    this.hemi = new THREE.HemisphereLight(0x000000, 0x000000, 1.0);
    this.hemi.name = 'skyAmbient';
    scene.add(this.hemi);

    for (const l of [this.sun, this.moon, this.bounce, this.bounce2, this.hemi]) {
      l.layers.enable(SHADOW_LAYER);
    }

    this.csm.init();
    this.local.init();

    /*
     * Pre-warm every lit program, at every point-light rung, while the boot
     * overlay is still up. Without this, walking into town links dozens of
     * programs inside one render() call and the tab hard-freezes; see
     * ShaderWarm's header for the measurements.
     */
    this.warm = new ShaderWarm(ctx, { variants: () => this._warmVariants() });
    for (const fn of this._materialHooks) this.csm.registerMaterialHook(fn);

    ctx.on('ready', () => this.csm.invalidate());
    ctx.on('teleport', () => {
      this.csm.invalidate();
      this.csm._forceFrames = 3;
    });
    ctx.on('weatherChange', () => this.csm.invalidate());

    this._updateLights(0);
  }

  /**
   * Every light configuration a lit material can be asked to render in, so
   * ShaderWarm can link them all before the player walks into one.
   *
   * There are exactly two axes, and both of them are discrete BY DESIGN — see
   * `LocalLights.slotLadder` and `forcePool`:
   *   - NUM_POINT_LIGHTS, quantised onto a short ladder;
   *   - whether the campfire floor projector is resident (NUM_SPOT_LIGHTS).
   * The projector only ever joins the scene when a fire is in range, and a fire
   * in range means at least one point light, so the pool-on half of the matrix
   * skips rung 0.
   */
  _warmVariants() {
    const L = this.local;
    const rungs = L.slotLadder();
    const out = [];
    for (const n of rungs) {
      out.push({ apply: () => { const a = L.forceSlots(n); const b = L.forcePool(false); return () => { b(); a(); }; } });
    }
    for (const n of rungs) {
      if (n === 0) continue;
      out.push({ apply: () => { const a = L.forceSlots(n); const b = L.forcePool(true); return () => { b(); a(); }; } });
    }
    return out;
  }

  /* ------------------------------------------------------------ public API */

  /** @param {THREE.Light} light */
  addLight(light, opts = {}) {
    return this.local.add(light, opts);
  }

  /**
   * Build a physically-authored campfire light rig at a world position and
   * return a handle. See the class docs for how to drive flame geometry from
   * it so the billboard, the pool and the shadows all flicker coherently.
   *
   * @param {THREE.Vector3} position  base of the fire, on the ground
   * @param {object} [opts] kelvin, soot, intensity, radius, flicker, height,
   *                        importance, shadow
   */
  addFireLight(position, opts = {}) {
    return this.local.addFire(position, opts);
  }

  /** Linear HDR flame colour; max channel is 1 so INTENSITY stays separate. */
  flameColor(kelvin = FIRE_DEFAULTS.kelvin, soot = FIRE_DEFAULTS.soot, out) {
    return flameColor(kelvin, soot, out);
  }

  /** Pure Planckian radiator colour, linear, max channel 1. */
  blackbody(kelvin, out) {
    return blackbodyLinear(kelvin, out);
  }

  removeLight(light) {
    this.local.remove(light);
  }

  requestShadowCaster(object3d) {
    this.csm.requestShadowCaster(object3d);
  }

  registerMaterial(matOrArray) {
    this.csm.registerMaterial(matOrArray);
  }

  /** fn(material) is called once for every material we inject the cascades into. */
  registerMaterialUser(fn) {
    if (typeof fn !== 'function') return;
    this._materialHooks.push(fn);
    if (this.csm) this.csm.registerMaterialHook(fn);
  }

  /** GLSL to prepend to a custom lit ShaderMaterial's fragment shader. */
  shadowChunk() {
    return this.csm.chunk;
  }

  /** Uniform objects to merge into a custom lit ShaderMaterial. */
  shadowUniforms() {
    return this.csm.uniforms;
  }

  shadowDefines() {
    return { RS_CSM: 1 };
  }

  invalidate() {
    this.csm.invalidate();
  }

  /**
   * Shadow debug view. 0 = off, 1 = cascade index as false colour, 2 = the
   * shadow term alone. Use it before believing shadows are fixed:
   *   __GAME.ctx.get('lighting').setShadowDebug(1)
   */
  setShadowDebug(mode = 0) {
    this.csm.uniforms.rsCsmDebug.value = mode;
  }

  /* ------------------------------------------------------------- per frame */

  update(dt) {
    // Undo last frame's local-shadow gating before anything can rescan.
    this.local.restoreHeavyCasters();
    this._updateLights(dt);
    this.local.update(dt);
    // Runs BEFORE the frame's render() and restores every light it touches, so
    // it can never affect the image — only the program cache.
    if (this.warm) this.warm.update();
  }

  lateUpdate(dt) {
    const ctx = this.ctx;
    const cam = ctx.camera;

    // Keep the directional lights anchored to the camera so their world matrix
    // (and therefore three's view-space light direction) is always well scaled.
    const anchor = cam.position;
    this._place(this.sun, this.sunTarget, this._sunDir, anchor);
    this._place(this.moon, this.moonTarget, this._moonDir, anchor);
    this._place(this.bounce, this.bounceTarget, this._bounceDir, anchor);
    this._place(this.bounce2, this.bounce2Target, this._bounceDir2, anchor);

    const keyDir = this._keyIsMoon ? this._moonDir : this._sunDir;
    this.csm.lightAngularTan = this._penumbra;
    this.csm.strength = this._shadowStrength;
    this.csm.update(dt, cam, keyDir);

    // three's own point/spot shadow pass runs inside the upcoming render(). A
    // cube shadow is six full scene passes, so hold the heavyweights out of it
    // — the sun cascades have already drawn them, and a campfire needs the
    // logs and rocks around it, not a 24 km terrain clipmap.
    this.local.suppressHeavyCasters(this.csm.casters);
  }

  _place(light, target, dir, anchor) {
    if (!dir) return;
    light.position.copy(anchor).addScaledVector(dir, 400);
    target.position.copy(anchor);
    light.updateMatrixWorld();
    target.updateMatrixWorld();
  }

  /* --------------------------------------------------------------- internals */

  _updateLights(dt) {
    const ctx = this.ctx;
    const e = ctx.env;

    const daylight = THREE.MathUtils.clamp(e.daylight, 0, 1);
    const night = 1 - daylight;
    const cloud = THREE.MathUtils.clamp(e.cloudCover, 0, 1);
    const flash = THREE.MathUtils.clamp(e.lightningFlash || 0, 0, 1);

    this._sunDir = this._sunDir || new THREE.Vector3();
    this._moonDir = this._moonDir || new THREE.Vector3();
    this._bounceDir = this._bounceDir || new THREE.Vector3();
    this._bounceDir2 = this._bounceDir2 || new THREE.Vector3();

    this._sunDir.copy(e.sunDirection);
    if (this._sunDir.lengthSq() < 1e-8) this._sunDir.set(0, 1, 0);
    this._sunDir.normalize();
    this._moonDir.copy(e.moonDirection);
    if (this._moonDir.lengthSq() < 1e-8) this._moonDir.set(0, -1, 0);
    this._moonDir.normalize();

    const sunUp = Math.max(this._sunDir.y, 0);
    const moonUp = Math.max(this._moonDir.y, 0);

    // Night floor: keep a navigable, cold key while the moon is actually up.
    // Below the horizon it lights nothing, so let it go and lean on sky glow.
    const phase = THREE.MathUtils.clamp(1 - Math.abs(e.moonPhase * 2 - 1), 0.3, 1);
    const moonRise = THREE.MathUtils.smoothstep(moonUp, 0.0, 0.08);
    const moonI = Math.max(e.moonIntensity, night * this.nightKeyFloor * phase) * moonRise;
    const sunI = Math.max(e.sunIntensity, 0);

    /* ------------------------------------------------------------ key light */
    /*
     * Weather publishes env.sunAttenuation (how much of the direct beam the deck
     * actually eats: ~0.01 clear, ~0.72 overcast, ~0.80 storm) and deliberately
     * does NOT touch env.sunIntensity, which TimeOfDay owns.
     *
     * Use sunAttenuation ALONE. The pass-1 code took
     * `max(sunAttenuation, cloudCover * 0.55)`, and the `clear` profile is
     * scattered fair-weather cumulus: cloudCover 0.36 with sunAttenuation 0.01.
     * That max() therefore killed 20% of the key light and — through the
     * penumbra term below — inflated the sun's apparent disc more than THREE
     * TIMES on a cloudless day. Every "mushy shadow terminator" the critique
     * measured on a clear-weather shot came out of that one expression.
     */
    const atten = THREE.MathUtils.clamp(
      e.sunAttenuation != null ? e.sunAttenuation : cloud * 0.55, 0, 1,
    );
    this.sun.color.copy(e.sunColor);
    this.sun.intensity = sunI * (1 - atten);
    this.moon.color.copy(e.moonColor);
    this.moon.intensity = moonI * (1 - cloud * 0.4);
    this._sunAtten = atten;

    // Hysteretic hand-over. Both lights are near zero at the crossover, so the
    // cascade re-fit onto the other body is invisible.
    const sunKeyScore = this.sun.intensity * (sunUp + 0.05);
    const moonKeyScore = this.moon.intensity * (moonUp + 0.05);
    if (this._keyIsMoon && moonKeyScore < sunKeyScore * 0.85) this._keyIsMoon = false;
    else if (!this._keyIsMoon && moonKeyScore > sunKeyScore * 1.15) this._keyIsMoon = true;

    /*
     * Effective angular size of the source, which is what PCSS turns into a
     * penumbra. Two things widen it, and NEITHER of them is cloud cover:
     *
     *  - A sun within a few degrees of the horizon is seen through ~38 air
     *    masses and the aerosol forward-scattering lobe smears it into a
     *    circumsolar aureole several degrees across. Real, but bounded — the
     *    pass-1 value of 2.5x at 3 degrees turned a golden-hour shadow into a
     *    6 m-wide gradient, so this is capped at 1.85x and only bites below
     *    about 11 degrees.
     *  - A cloud deck that actually covers the sun replaces the disc with the
     *    whole dome. That is `sunAttenuation`, squared so that scattered fair
     *    cumulus (atten 0.01-0.07) does essentially nothing and only a real
     *    overcast lid (0.72+) softens everything out.
     */
    const keyUp = this._keyIsMoon ? moonUp : sunUp;
    /*
     * 0.85 in pass 2 (a 1.85x disc at the horizon), 0.30 now. The aureole is
     * real, but it was combined with a 26-texel penumbra ceiling and a 0.176 m
     * texel to blur a golden-hour shadow across 4.6 metres of ground — the
     * "200px blur that reads as fog, not a penumbra" the critique measured. The
     * long raking shapes are the shot; the aureole is a garnish.
     */
    const horizonWiden = 1 + 0.30 * (1 - THREE.MathUtils.smoothstep(keyUp, 0.02, 0.19));
    const deckWiden = 1 + atten * atten * 9.0;
    this._penumbra = (this._keyIsMoon ? this.moonPenumbra : this.sunPenumbra)
      * horizonWiden * deckWiden;
    this._shadowStrength = THREE.MathUtils.clamp(1 - atten * 0.85 - flash * 0.6, 0.08, 1);

    /* ------------------------------------------------- ground albedo sample */
    this._sampleGround();

    /* ------------------------------------------------------ two-lobe ambient */
    /*
     * The single flat ambient term pass 1 shipped is the reason its outdoor
     * shadows did not read as outdoor shadows. Real daylight fill is two
     * clearly different colours arriving from two different hemispheres:
     *
     *   UPPER  cool blue skylight  — Rayleigh-scattered, B/R around 1.8-2.2
     *   LOWER  warm ochre bounce   — the sun's own colour multiplied by the
     *                                terrain albedo under the camera
     *
     * A THREE.HemisphereLight is exactly that integral (it lerps the two by
     * 0.5*N.y+0.5), so the split costs nothing; what matters is that the two
     * colours are genuinely separated in chroma, and that the lower lobe
     * carries the SUN's colour, not just the ground's — a golden-hour bounce
     * is orange because the light hitting the ground is orange.
     */
    const ambI = Math.max(e.ambientIntensity, 0);
    _c.copy(e.ambientColor);
    if (_c.r + _c.g + _c.b < 1e-4) _c.setRGB(0.16, 0.24, 0.40);
    const glow = this.nightSkyGlow;
    const g0 = night * night;
    let skyR = Math.max(_c.r * ambI, glow.r * g0);
    let skyG = Math.max(_c.g * ambI, glow.g * g0);
    let skyB = Math.max(_c.b * ambI, glow.b * g0);

    // Push the upper lobe toward the sky's own chroma at constant luminance, so
    // shadows cool off without the frame getting brighter or darker.
    const cool = this.skyCoolBias * daylight;
    const lum0 = Math.max(1e-6, 0.2126 * skyR + 0.7152 * skyG + 0.0722 * skyB);
    skyR *= 1 - 0.30 * cool;
    skyG *= 1 - 0.06 * cool;
    skyB *= 1 + 0.34 * cool;
    const lum1 = Math.max(1e-6, 0.2126 * skyR + 0.7152 * skyG + 0.0722 * skyB);
    const renorm = lum0 / lum1;
    skyR *= renorm;
    skyG *= renorm;
    skyB *= renorm;

    /*
     * Irradiance reaching the ground from the key. On a mathematically flat
     * plane this is I*cos(zenith), which at a 3-degree sun is ~0.05 and makes
     * the bounce vanish exactly when the art direction needs it most. The world
     * is not flat: a rolling landscape presents plenty of slopes near normal
     * incidence to a low sun, and it is those slopes that do the bouncing. The
     * floor stands in for that.
     */
    const sc = this._keyIsMoon ? this.moon.color : this.sun.color;
    const keyE = this.sun.intensity * Math.max(sunUp, this.lowSunBounceFloor)
      + this.moon.intensity * Math.max(moonUp, this.lowSunBounceFloor) * 0.5;
    const a = this._groundAlbedo;
    const kB = this.bounceGain;
    const bR = a.r * (sc.r * keyE * kB + skyR);
    const bG = a.g * (sc.g * keyE * kB + skyG);
    const bB = a.b * (sc.b * keyE * kB + skyB);

    const fl = flash * 4.0;
    this.hemi.color.setRGB(skyR + fl * 0.85, skyG + fl * 0.92, skyB + fl);
    this.hemi.groundColor.setRGB(bR + fl * 0.5, bG + fl * 0.5, bB + fl * 0.6);
    this._skyLobe.setRGB(skyR, skyG, skyB);
    this._groundLobe.setRGB(bR, bG, bB);

    /* ------------------------------------------------------- bounce fill dir */
    // Comes from below in the key light's azimuth: warms undersides and the
    // shadow side of vertical faces without ever being shadowed itself. Carries
    // albedo x key colour, which is what makes a cliff face in shadow at sunset
    // glow orange from below instead of just going grey.
    const kd = this._keyIsMoon ? this._moonDir : this._sunDir;
    this._bounceDir.set(kd.x, -Math.abs(kd.y) * 0.55 - 0.30, kd.z).normalize();
    // ...and the same thing mirrored in azimuth, for faces turned away from the
    // sun that are nonetheless staring at a sheet of sunlit ground.
    this._bounceDir2.set(-kd.x, -Math.abs(kd.y) * 0.40 - 0.42, -kd.z).normalize();
    _c2.setRGB(a.r * sc.r, a.g * sc.g, a.b * sc.b);
    const lum = Math.max(1e-4, _c2.r * 0.3 + _c2.g * 0.59 + _c2.b * 0.11);
    this.bounce.color.setRGB(_c2.r / lum, _c2.g / lum, _c2.b / lum);
    this.bounce2.color.copy(this.bounce.color);
    // A bounce needs a beam to bounce; it dies with the direct sun, not with the
    // amount of decorative cumulus in the sky.
    this.bounce.intensity = keyE * lum * this.bounceDirGain * (1 - atten * 0.8);
    this.bounce2.intensity = this.bounce.intensity * this.counterBounce;

    /* ------------------------------------------------- shadowed-ambient tint */
    this._updateShadowAmbient(daylight, sunUp, moonUp, skyR, skyG, skyB);

    /* ------------------------------------------------------------------ fog */
    this._updateFog(e, daylight);
  }

  /**
   * Solve the ambient multiplier applied inside cast shadows, and hand it to the
   * cascade shader as `rsCsmAmbient.rgb`.
   *
   * The luminance half is a ratio solve, not a taste knob: given the direct and
   * ambient irradiance actually reaching flat ground this frame, pick the
   * multiplier that lands a shadowed patch at `shadowFloor` of a lit one, and
   * clamp it so it can neither crush (floor) nor amplify (1.0). It therefore
   * does nothing at all at high noon, where the sun already outguns the sky
   * 16:1, and does the heavy lifting at golden hour and dawn where it is the
   * only thing that can make a shadow read.
   *
   * The chroma half is applied at constant luminance and always, because a
   * shadow that is not cooler than its surroundings does not look like a shadow
   * no matter how dark it is.
   */
  _updateShadowAmbient(daylight, sunUp, moonUp, skyR, skyG, skyB) {
    const key = this._keyIsMoon ? this.moon : this.sun;
    const keyUp = this._keyIsMoon ? moonUp : sunUp;
    const kc = key.color;
    const L = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

    const direct = L(kc.r, kc.g, kc.b) * key.intensity * Math.max(keyUp, 0);
    const amb = Math.max(1e-5, L(skyR, skyG, skyB));
    const lit = direct + amb;

    let k = (lit * this.shadowFloor) / amb;
    const floor = THREE.MathUtils.lerp(
      this.shadowAmbientFloorNight, this.shadowAmbientFloorDay, daylight,
    );
    k = THREE.MathUtils.clamp(k, floor, THREE.MathUtils.lerp(1, this.shadowAmbientMax, daylight));

    // Chroma tilts fully in daylight, fades out at night where the ambient is
    // already cold and any further blue push just reads as a colour cast.
    const ch = this.shadowChroma;
    const w = daylight;
    const cr = 1 + (ch.r - 1) * w;
    const cg = 1 + (ch.g - 1) * w;
    const cb = 1 + (ch.b - 1) * w;
    const norm = 1 / Math.max(1e-5, L(cr, cg, cb));

    const u = this.csm.uniforms.rsCsmAmbient.value;
    u.x = cr * norm * k;
    u.y = cg * norm * k;
    u.z = cb * norm * k;
    this._shadowAmbientK = k;
  }

  _sampleGround() {
    const ctx = this.ctx;
    const w = ctx.world;
    if (!w.ready || !w.getSurface) return;
    const p = ctx.camera.position;
    let s;
    try {
      s = w.getSurface(p.x, p.z);
    } catch (err) {
      return;
    }
    if (!s) return;
    let r = 0;
    let g = 0;
    let b = 0;
    let tot = 0;
    for (const k in GROUND_ALBEDO) {
      const wgt = s[k] || 0;
      if (wgt <= 0) continue;
      const c = GROUND_ALBEDO[k];
      r += c[0] * wgt;
      g += c[1] * wgt;
      b += c[2] * wgt;
      tot += wgt;
    }
    if (tot <= 0) return;
    r /= tot;
    g /= tot;
    b /= tot;
    const k = 0.06; // ease so riding over a sand bar does not flicker the bounce
    this._groundAlbedo.setRGB(
      this._groundAlbedo.r + (r - this._groundAlbedo.r) * k,
      this._groundAlbedo.g + (g - this._groundAlbedo.g) * k,
      this._groundAlbedo.b + (b - this._groundAlbedo.b) * k,
    );
  }

  /**
   * Aerial-perspective fallback. Only applied while nothing else owns
   * `scene.fog`; the moment Weather (or anyone) assigns their own, we stand
   * down permanently and never touch it again.
   */
  _updateFog(e, daylight) {
    const scene = this.ctx.scene;
    if (!this.ownFog) return;
    // Sky owns distance haze once it is injecting aerial perspective, and its
    // injector sets material.fog = false on everything it patches. Standing our
    // fallback down keeps a second, wrongly-coloured veil from ever reaching a
    // material Sky has not patched yet.
    const sky = this.ctx.get('sky');
    if (sky && typeof sky.injectAerialPerspective === 'function') {
      this.ownFog = false;
      if (this._fog && scene.fog === this._fog) scene.fog = null;
      this._fog = null;
      return;
    }
    if (!this._fog) {
      if (scene.fog) {
        this.ownFog = false;
        return;
      }
      this._fog = new THREE.FogExp2(0x000000, this.fogDensityFloor);
      scene.fog = this._fog;
    } else if (scene.fog !== this._fog) {
      this.ownFog = false;
      return;
    }
    const d = Math.max(e.fogDensity, this.fogDensityFloor);
    this._fog.density = d * (1 + e.groundMist * 0.6);
    _c.copy(e.fogColor);
    // Haze is lit by the sky, so it darkens with the sun and cools at night.
    const k = 0.25 + 0.75 * daylight;
    this._fog.color.setRGB(_c.r * k, _c.g * k, _c.b * (k * 0.96 + 0.06));
  }

  resize() {}

  dispose() {
    this.csm.dispose();
    this.local.dispose();
    if (this.warm) this.warm.dispose();
    if (this._fog && this.ctx.scene.fog === this._fog) this.ctx.scene.fog = null;
    for (const o of [this.sun, this.moon, this.bounce, this.bounce2, this.hemi,
      this.sunTarget, this.moonTarget, this.bounceTarget, this.bounce2Target]) {
      if (o) o.removeFromParent();
    }
  }
}
