import * as THREE from 'three';
import { rng } from '../core/Context.js';
import { makeNoiseBuffer, makeImpulseResponse, makeGrainBuffer } from './Noise.js';
import { VoicePool, filter, glide } from './Voices.js';
import { SYNTH } from './Foley.js';
import {
  WindBed, RainBed, RiverBed, FireBed, InsectBed, BirdBed, TownBed, UnderwaterBed,
} from './Beds.js';

/**
 * ============================================================================
 *  AUDIO — everything synthesised with WebAudio. No sample files anywhere.
 * ============================================================================
 *
 * Signal path:
 *
 *   beds ──▶ ambient ─┐
 *   rain ───▶ weather ┴─▶ AMBIENCE ─▶ ambDuck ─┐          ┌─ conv(open)  ─┐
 *   foley ──▶ SFX ────────────────────────────┼▶ master ─▶│               ├▶ comp ▶ out
 *   hud ────▶ UI ─────────────────────────────┘           └─ conv(tight) ─┘
 *                    └────▶ sends ─▶ reverbIn ──────────────────┘
 *
 * The two convolvers hold procedurally generated impulse responses — a long,
 * dark, sparse one for open country and a short dense one for the inside of a
 * street — and are crossfaded by a `shelter` term, so the space audibly closes
 * up as you ride into the settlement.
 *
 * ---------------------------------------------------------------------------
 * THE MIX.  Ambience is a BED, not a voice. It has to sit far enough under the
 * action that a rifle going off is a shock rather than a slightly louder part of
 * the weather. Measured through the real output chain (src/audio/_dev/mix.html),
 * the first cut had wind at a 6 m/s breeze delivering −15 dBFS RMS *and clipping
 * the master*, against a rifle report at −28.8 dBFS RMS — the weather was 14 dB
 * louder than a gunshot, which is exactly what the playtest reported. The fix is
 * structural rather than one gain: three trimmed buses under the master, per-bed
 * trims calibrated against those measurements, and a rifle rebuilt to actually
 * hit the compressor. See MIX below for the levels and BED_TRIM for the beds.
 * ---------------------------------------------------------------------------
 *
 * Contract surface (§4.7):
 *   play(name, { position, volume, pitch, loop }) → handle
 *   ambience(name, weight)     crossfade a bed, 0..1; pass null to release
 *   stop(handle)
 *
 * Additive public surface used by other systems (documented in the report):
 *   setFootstepSurface(name|null)   force the surface footsteps synthesise
 *   setMasterVolume(v) / getMasterVolume() / toggleMute()
 *   resume()                        resume the context after a user gesture
 *   audioStats()                    voice counts for the HUD/debug overlay
 */
export class Audio {
  static id = 'audio';

  constructor(ctx) {
    this.ctx = ctx;
    this.actx = null;
    this.enabled = false;
    this.ready = false;
    this.muted = false;
    this.volume = 0.85;
    this.shelter = 0;
    this.beds = new Map();
    this.tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._prevPos = new THREE.Vector3();
    this._handles = new Map();
    this._handleId = 1;
    this._loops = [];
    this._scheduledTo = 0;
    this._strideAccum = 0;
    this._lastExternalStep = -1e9;
    this._externalSteps = false;
    this._surfaceOverride = null;
    this._water = { found: false, x: 0, y: 0, z: 0, d: 1e9, t: -1 };
    this._pendingThunder = [];
    this._unbind = [];
    this._capture = false;
    this._gestureBound = false;
    this._elapsed = 0;
    /** Mirror of the weapon's animation state; see _updateWeapon(). */
    this._wpn = { cycle: 0, opened: false, ammo: -1, reloading: false, round: 0, endAt: -1 };

    const seed = (ctx.seed ^ 0x5eed17) >>> 0;
    const r = rng(seed);
    /** Deterministic PRNG for all synthesis — never Math.random(). */
    this.rand = () => r();
  }

  /* ------------------------------------------------------------------ boot */

  async init() {
    const params = typeof location !== 'undefined'
      ? new URLSearchParams(location.search) : new URLSearchParams('');
    this._capture = params.get('capture') === '1';
    if (params.get('mute') === '1') this.muted = true;

    // The screenshot harness runs headless with no user gesture; a suspended
    // context there would only produce autoplay warnings and burn init time.
    if (this._capture) { this.enabled = false; return; }

    this._bindEvents();

    // Only build the context when the page has already been interacted with,
    // otherwise wait for the first gesture (autoplay policy).
    const active = typeof navigator !== 'undefined' && navigator.userActivation
      ? navigator.userActivation.hasBeenActive : false;
    if (active) this._ensureContext();
    else this._bindGesture();
  }

  _bindGesture() {
    if (this._gestureBound || typeof window === 'undefined') return;
    this._gestureBound = true;
    const go = () => { this._ensureContext(); this.resume(); };
    const opts = { passive: true };
    for (const evt of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
      window.addEventListener(evt, go, opts);
      this._unbind.push(() => window.removeEventListener(evt, go, opts));
    }
  }

  /** Build the context + graph. Safe to call repeatedly. */
  _ensureContext() {
    if (this.actx || this._capture) return this.actx;
    const Ctor = typeof window !== 'undefined'
      ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!Ctor) return null;
    try {
      this.actx = new Ctor({ latencyHint: 'interactive' });
    } catch (e) {
      this.enabled = false;
      return null;
    }
    try {
      this._buildBuffers();
      this._buildGraph();
      this._buildBeds();
      this.enabled = true;
      this.ready = true;
      this._bindGesture();
    } catch (e) {
      // A broken audio graph must never take the frame down with it.
      this.enabled = false;
      this.ready = false;
      console.warn('[audio] graph build failed:', e && e.message ? e.message : e);
    }
    return this.actx;
  }

  resume() {
    const a = this.actx;
    if (!a) return;
    if (a.state === 'suspended' && a.resume) a.resume().catch(() => {});
  }

  /** True while the browser is still withholding audio pending a gesture. */
  needsGesture() {
    if (this._capture) return false;
    return !this.actx || this.actx.state === 'suspended';
  }

  _buildBuffers(actx = this.actx) {
    const s = this.ctx.seed;
    this.buf = {
      white: makeNoiseBuffer(actx, { seconds: 4.0, channels: 2, type: 'white', seed: s ^ 0x11, peak: 0.85 }),
      pink: makeNoiseBuffer(actx, { seconds: 4.0, channels: 2, type: 'pink', seed: s ^ 0x22, peak: 0.9 }),
      brown: makeNoiseBuffer(actx, { seconds: 5.0, channels: 2, type: 'brown', seed: s ^ 0x33, peak: 0.9 }),
      grainBright: makeGrainBuffer(actx, { seconds: 0.24, decay: 30, seed: s ^ 0x44, tilt: -1 }),
      grainMid: makeGrainBuffer(actx, { seconds: 0.24, decay: 24, seed: s ^ 0x55, tilt: 0 }),
      grainDark: makeGrainBuffer(actx, { seconds: 0.3, decay: 16, seed: s ^ 0x66, tilt: 0.6 }),
    };
    return this.buf;
  }

  /**
   * Impulse-response recipes, shared by the live graph and the offline bench.
   *
   * `gain` is the broadband voltage gain of the convolution (see
   * makeImpulseResponse) — the open tail is unity, so a send reads directly as
   * a wet/dry ratio. The tight room is deliberately 0.6: it packs the same
   * energy into a fifth of the time, so at equal energy it lands ~7 dB louder
   * to the ear, and matching them by energy alone makes walking into a building
   * sound like walking into a tin shed.
   */
  _irParams(which) {
    return which === 'tight'
      ? {
        seconds: 0.75, decay: 0.5, predelay: 0.006, damping: 0.8,
        earlyCount: 22, earlyGain: 0.8, earlySpread: 0.035,
        hfStart: 9000, hfEnd: 1400, seed: this.ctx.seed ^ 0x88, gain: 0.6,
      }
      : {
        seconds: 2.9, decay: 2.4, predelay: 0.028, damping: 1.25,
        earlyCount: 8, earlyGain: 0.25, earlySpread: 0.14,
        hfStart: 5200, hfEnd: 380, seed: this.ctx.seed ^ 0x77, gain: 1.0,
      };
  }

  _buildGraph() {
    const actx = this.actx;

    /*
     * The last thing in the chain is a soft clipper, and it is not optional.
     *
     * A rifle crack is 3 ms long. DynamicsCompressor's fastest useful attack is
     * ~4 ms, so the transient is already over before the compressor has moved —
     * measured, the new report drove the output to +5.8 dBFS and clipped 1121
     * samples straight through it. A tanh transfer function has no attack time
     * at all: it is instantaneous by construction, asymptotes to exactly ±1.0,
     * and it saturates rather than shears, which is what a loud transient
     * through a real signal chain has always sounded like anyway.
     */
    const lim = buildLimiter(actx, actx.destination);
    this.limiter = lim.shaper;
    this.limiterIn = lim.input;

    this.comp = actx.createDynamicsCompressor();
    this.comp.threshold.value = -13;
    this.comp.knee.value = 14;
    this.comp.ratio.value = 3.2;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.26;
    this.comp.connect(this.limiterIn);

    // One filter for the whole mix — the world goes muffled under water.
    this.submergeLP = filter(actx, 'lowpass', 20000, 0.85);
    this.submergeLP.connect(this.comp);

    this.master = actx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(this.submergeLP);

    this.reverbIn = actx.createGain();
    this.reverbIn.gain.value = 1;

    // Open country: long, dark, sparse. It is mostly what makes a landscape
    // sound big rather than dry.
    this.convOpen = actx.createConvolver();
    this.convOpen.normalize = false;
    this.convOpen.buffer = makeImpulseResponse(actx, this._irParams('open'));
    // Between buildings: short, dense, brighter early reflections.
    this.convTight = actx.createConvolver();
    this.convTight.normalize = false;
    this.convTight.buffer = makeImpulseResponse(actx, this._irParams('tight'));

    /*
     * The two returns are CROSSFADED, never summed. They were both permanently
     * open before, so anywhere between open country and a doorway you heard the
     * landscape tail and the room tail on top of each other — two spaces at
     * once, which the ear reads as a hard resonant box rather than as either
     * one. See _updateShelter() for the equal-power law.
     */
    this.wetOpen = actx.createGain(); this.wetOpen.gain.value = WET_RETURN;
    this.wetTight = actx.createGain(); this.wetTight.gain.value = 0.0;
    this.reverbIn.connect(this.convOpen); this.convOpen.connect(this.wetOpen); this.wetOpen.connect(this.master);
    this.reverbIn.connect(this.convTight); this.convTight.connect(this.wetTight); this.wetTight.connect(this.master);

    /*
     * ---- bus tree -------------------------------------------------------
     * Three trimmed group buses hang off the master. AMBIENCE carries every
     * bed and the weather one-shots and is trimmed hard (MIX.ambience); SFX
     * carries everything the world does at you and runs at unity; UI is a
     * little under. `ambDuck` sits below the ambience trim and is pulled down
     * for ~a second by a gunshot, so the report punches a hole in the weather
     * instead of fighting it.
     */
    this.ambienceBus = actx.createGain();
    this.ambienceBus.gain.value = MIX.ambience;
    this.ambDuck = actx.createGain();
    this.ambDuck.gain.value = 1;
    this.ambienceBus.connect(this.ambDuck);
    this.ambDuck.connect(this.master);

    this.sfxBus = actx.createGain();
    this.sfxBus.gain.value = MIX.sfx;
    this.sfxBus.connect(this.master);

    this.uiBus = actx.createGain();
    this.uiBus.gain.value = MIX.ui;
    this.uiBus.connect(this.master);

    /*
     * A child bus's reverb send is taken PRE its group trim, so the send
     * amount has to be scaled by the group level or the ambience would come
     * back through the convolver at its old, far-too-loud level.
     */
    const mkBus = (parent, send, groupLevel) => {
      const g = actx.createGain();
      g.gain.value = 1.0;
      g.connect(parent);
      if (send > 0) {
        const s = actx.createGain();
        s.gain.value = send * groupLevel;
        g.connect(s); s.connect(this.reverbIn);
        return { node: g, send: s };
      }
      return { node: g, send: null };
    };
    this._busObjs = {
      ambient: mkBus(this.ambienceBus, SEND.ambient, MIX.ambience),
      weather: mkBus(this.ambienceBus, SEND.weather, MIX.ambience),
      foley: mkBus(this.sfxBus, SEND.foley, MIX.sfx),
      ui: mkBus(this.uiBus, 0, MIX.ui),
    };
    this.bus = {
      ambient: this._busObjs.ambient.node,
      weather: this._busObjs.weather.node,
      foley: this._busObjs.foley.node,
      ui: this._busObjs.ui.node,
    };
    /** Contract alias — `foley` is the SFX bus; new code should say sfx. */
    this.bus.sfx = this.bus.foley;
    this.bus.ambience = this.ambienceBus;

    /** Where a voice may tap an extra reverb send. See `wetSend()`. */
    this._wetTarget = this.reverbIn;

    this.pool = new VoicePool(actx, 44);

    // Listener defaults; lateUpdate keeps it on the camera.
    const L = actx.listener;
    if (L.forwardX) {
      L.forwardX.value = 0; L.forwardY.value = 0; L.forwardZ.value = -1;
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else if (L.setOrientation) {
      L.setOrientation(0, 0, -1, 0, 1, 0);
    }
  }

  _buildBeds() {
    const defs = [
      new WindBed(this), new RainBed(this), new RiverBed(this), new FireBed(this),
      new InsectBed(this), new BirdBed(this), new TownBed(this), new UnderwaterBed(this),
    ];
    for (const b of defs) {
      b.build();
      b.output.connect(this.bus.ambient);
      if (b.send > 0) {
        const s = this.actx.createGain();
        /* The tap is on b.output, which is already past the bed's own trim (and
           its panner) — multiplying by the trim a second time here was applying
           it twice, so the send no longer meant what it said. Scale by the
           group level only (see mkBus), plus SEND.bed: a bed is a diffuse
           field already and wants far less room on it than a point source. */
        s.gain.value = b.send * SEND.bed * MIX.ambience;
        b.output.connect(s);
        s.connect(this.reverbIn);
        b._sendNode = s;
      }
      this.beds.set(b.name, b);
    }
    this._refreshAnchors();
  }

  /**
   * Re-read the world anchors the positional beds sit on. Called at build time
   * and then lazily until they resolve — the audio context is only created on
   * the first user gesture, which may land before or after the systems that
   * register these POIs, so reading them exactly once is not safe.
   */
  _refreshAnchors() {
    if (!this.beds.size) return;
    const fire = this.ctx.poi.get('camp_fire');
    if (fire) {
      const p = fire.pos || fire;
      if (!this._fireAt) this._fireAt = new THREE.Vector3();
      if (this._fireAt.distanceToSquared(p) > 0.01) {
        this._fireAt.copy(p);
        this.beds.get('fire').setPosition(p.x, p.y, p.z);
      }
    }
    const town = this.ctx.poi.get('town');
    const townEnd = this.ctx.poi.get('town_end');
    if (town) {
      const a = town.pos || town;
      const b = townEnd ? (townEnd.pos || townEnd) : a;
      const first = !this._townCentre;
      if (first) this._townCentre = new THREE.Vector3(1e9, 1e9, 1e9);
      this._tmp2.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
      if (first || this._townCentre.distanceToSquared(this._tmp2) > 0.25) {
        this._townCentre.copy(this._tmp2);
        this.beds.get('town').setPosition(this._townCentre.x, this._townCentre.y + 2, this._townCentre.z);
      }
    }
  }

  /* ----------------------------------------------------------------- events */

  _bindEvents() {
    const ctx = this.ctx;
    const on = (evt, fn) => { const off = ctx.on(evt, fn); if (off) this._unbind.push(off); };

    on('footstep', (e) => this._onFootstep(e || {}));
    on('lightning', (e) => this._onLightning(e || {}));
    on('gunshot', (e) => this._onGunshot(e || {}));
    on('mount', (e) => this._onMount(e, true));
    on('dismount', (e) => this._onMount(e, false));
    /*
     * Additive contract, for whoever owns the weapon animation: emitting
     * `reload` with { phase: 'start'|'round'|'end', position } drives the
     * mechanical sequence explicitly and switches off the state-watching
     * fallback in _updateWeapon(). Nothing emits it today; the watcher covers
     * the current Weapon.js without it needing to change.
     */
    on('reload', (e) => {
      if (!this.ready) return;
      this._wpn.eventDriven = true;
      this._reloadPhase((e && e.phase) || 'round', this._posOf(e));
    });
    on('teleport', () => {
      this._strideAccum = 0;
      this._prevPos.copy(ctx.player.position);
      this._water.t = -1;
      this._resetSchedulers();
    });
    on('weatherChange', () => { this._resetSchedulers(); });
  }

  _resetSchedulers() {
    if (!this.actx) return;
    const t = this.actx.currentTime;
    for (const b of this.beds.values()) b._nextEvent = t;
    this._scheduledTo = t;
  }

  _posOf(e) {
    if (!e) return null;
    const p = e.position || e.pos || e.point;
    if (!p) return null;
    if (p.isVector3) return p;
    if (Array.isArray(p)) return this._tmp2.fromArray(p);
    if (typeof p.x === 'number') return this._tmp2.set(p.x, p.y || 0, p.z || 0);
    return null;
  }

  _onFootstep(e) {
    this._lastExternalStep = this._elapsed;
    this._externalSteps = true;
    if (!this.ready) return;
    const ctx = this.ctx;
    const pos = this._posOf(e) || ctx.player.position;
    const mounted = (e.mode || ctx.player.mode) === 'mounted' || !!e.hoof;
    /*
     * Player and Horse report the dominant TERRAIN WEIGHT ('grass', 'rock'…),
     * which is not the same vocabulary the foley tables are keyed on: dry
     * western grass rustles rather than swishes, and a steep rock face is
     * scree underfoot. Re-derive those through the same mapper the fallback
     * cadence uses so an emitted footfall and a synthesised one never sound
     * like two different worlds.
     */
    const surface = (!e.surface || RAW_SURFACE.has(e.surface))
      ? this._surfaceAt(pos.x, pos.z)
      : e.surface;
    const opts = {
      position: pos, surface, volume: e.volume != null ? e.volume : 1,
      speed: e.speed != null ? e.speed : ctx.player.speed01, wetness: ctx.env.wetness,
    };
    if (mounted || e.hoof) this.play('hoof', { ...opts, energy: 0.5 + (opts.speed || 0) * 0.5 });
    else this.play('footstep', opts);
  }

  _onLightning(e) {
    if (!this.ready) return;
    const dist = e.distance != null ? e.distance : 2500;
    const delay = Math.max(0, Math.min(14, e.delay != null ? e.delay : dist / 340));
    const p = this._posOf(e);
    let pan = 0;
    if (p) {
      const cam = this.ctx.camera;
      this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
      // Horizontal right vector = cross(forward, up) = (−fz, 0, fx), normalised
      // in the XZ plane so a pitched camera does not shrink the stereo image.
      const fl = Math.hypot(this._fwd.x, this._fwd.z) || 1;
      const rx = -this._fwd.z / fl, rz = this._fwd.x / fl;
      const dx = p.x - cam.position.x, dz = p.z - cam.position.z;
      const len = Math.hypot(dx, dz) || 1;
      pan = rx * (dx / len) + rz * (dz / len);
    }
    this.play('thunder', {
      at: this.now() + delay, distance: dist,
      intensity: e.intensity != null ? e.intensity : 0.7, pan,
    });
  }

  /**
   * A rifle shot, and the thing that makes it feel like open country: the
   * SLAP-BACK.
   *
   * A gunshot on a plain is a crack and then nothing. A gunshot in a valley is
   * a crack and then, a second and a half later, the valley answering — and
   * that second and a half is the sound of the landscape's actual size. So
   * rather than bolting a fixed reverb onto the report, march the real
   * heightfield outward in eight directions, find the ground that is actually
   * high enough to throw the sound back, and schedule one delayed, band-limited
   * copy per reflector at 2·d/c. Fire into a hillside and it comes straight
   * back; fire off the edge of a mesa and it does not come back at all.
   */
  _onGunshot(e) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const p = this._posOf(e) || ctx.player.position;
    const isRifle = e.weapon === 'rifle';
    const vol = e.volume != null ? e.volume : 1;
    const t0 = this.now();

    // March the heightfield first — the report itself needs to know how open
    // the country is, because that is what sets the length of its own tail.
    const R = this._reflectors(p);

    this.play(isRifle ? 'rifle' : 'gunshot', {
      position: p, volume: vol, openness: R.openness, tail: R.tail,
    });
    // The weather gets out of the way of the report. If the shot is somebody
    // else's, a long way off, it does not get to duck the whole world.
    const near = ctx.camera ? 1 / (1 + ctx.camera.position.distanceTo(p) / 60) : 1;
    if (near > 0.25) this.duckAmbience(t0, 1 - 0.7 * near * vol, 0.10, 0.75 + R.tail * 0.3);

    /*
     * The lever cycle is NOT scheduled here. Weapon.js animates the throw over
     * 0.44 s and publishes `cycle` (0..1); _updateWeapon() watches that scalar
     * and fires the throw and the return on the frames the animation actually
     * reaches them, so the sound cannot drift out of sync with the mesh. This
     * fallback only runs when there is no weapon object to watch — the offline
     * bench, the soak test, or an NPC's rifle.
     */
    if (isRifle && !this._weaponRef()) {
      this.play('leverThrow', { position: p, at: t0 + 0.13, volume: 0.85 });
      this.play('leverReturn', { position: p, at: t0 + 0.42, volume: 0.9 });
    }
    // A revolver echoes off a canyon wall too; it just carries less far.
    if (!R.list.length) return;

    const C = 343;
    const n = Math.min(3, R.list.length);
    for (let i = 0; i < n; i++) {
      const r = R.list[i];
      const delay = (2 * r.d) / C;
      if (delay > 5.5) continue;
      // 1/r spreading plus air absorption, and a later echo is a weaker one
      const amp = vol * (1 / (1 + r.d / 150)) * (0.62 - i * 0.13)
        * Math.min(1.4, 0.6 + r.rise / 60);
      if (amp < 0.05) continue;
      this.play(isRifle ? 'rifle' : 'gunshot', {
        echo: true,
        at: t0 + delay,
        position: new THREE.Vector3(r.x, p.y + r.rise * 0.5, r.z),
        volume: amp,
        cull: 2000,
      });
    }
  }

  /**
   * March the real heightfield outward in eight directions and find the ground
   * that is actually high enough to throw a sound back.
   *
   * A gunshot on a plain is a crack and then nothing. A gunshot in a valley is
   * a crack and then, a second and a half later, the valley answering — and
   * that second and a half is the sound of the landscape's actual size. So
   * rather than bolting a fixed reverb onto the report, each reflector becomes
   * one delayed, band-limited copy at 2·d/c. Fire into a hillside and it comes
   * straight back; fire off the edge of a mesa and it does not come back at all.
   *
   * `openness` (0 boxed in .. 1 wide open) additionally sets the length of the
   * diffuse tail the report carries with it, which is the difference between a
   * canyon and a prairie even before the discrete echoes arrive.
   *
   * @returns {{list:Array, openness:number, tail:number}}
   */
  _reflectors(p) {
    const w = this.ctx.world;
    const out = { list: [], openness: 1, tail: 1.5 };
    if (!w || !w.ready || !w.getHeight) return out;
    const MAXD = 760;
    let closeness = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + 0.19;
      const dx = Math.cos(a), dz = Math.sin(a);
      let found = 0, rise = 0;
      for (let d = 90; d <= MAXD; d += 45) {
        let g;
        try { g = w.getHeight(p.x + dx * d, p.z + dz * d); } catch (err) { break; }
        const up = g - p.y;
        // Ground has to stand meaningfully proud of the shooter to reflect,
        // and the further away it is the more of it there has to be.
        if (up > 8 + d * 0.018) { found = d; rise = up; break; }
      }
      if (found) {
        out.list.push({ d: found, rise, x: p.x + dx * found, z: p.z + dz * found });
        closeness += 1 - found / MAXD;
      }
    }
    out.list.sort((a, b) => a.d - b.d);
    // Eight near walls = closed; nothing found in any direction = wide open.
    out.openness = clamp01(1 - closeness / 8);
    // Open country rings for a long time and darkly; a box slaps and stops.
    out.tail = 0.55 + out.openness * 1.85;
    return out;
  }

  /** The player's weapon, if there is one. Null in the bench and the soak. */
  _weaponRef() {
    const P = this.ctx.get ? this.ctx.get('player') : null;
    return (P && P.weapon) ? P.weapon : null;
  }

  _onMount(e, mounting) {
    if (!this.ready) return;
    const p = this._posOf(e) || this.ctx.player.position;
    this.play('leather', { position: p, volume: 1 });
    this.play('leather', { position: p, at: this.now() + 0.18 + this.rand() * 0.1, volume: 0.7 });
    const surf = this._surfaceAt(p.x, p.z);
    for (let i = 0; i < 2; i++) {
      this.play('hoof', {
        position: p, surface: surf, energy: 0.35,
        at: this.now() + 0.1 + this.rand() * 0.5, volume: 0.6,
      });
    }
  }

  /* -------------------------------------------------------- public contract */

  /**
   * Fire a synthesised sound.
   * @param {string} name  one of the SYNTH keys
   * @param {object} o     { position, volume, pitch, loop, at, interval, ... }
   * @returns {{id:number, name:string, stop:Function}|null} handle
   */
  play(name, o = {}) {
    if (!this.ready || this.muted) return null;
    const fn = SYNTH[name];
    if (!fn) return null;

    if (o.loop) {
      const h = {
        id: this._handleId++, name, kind: 'loop',
        opts: { ...o, loop: false },
        interval: Math.max(0.05, o.interval || 1.0),
        next: (o.at || this.now()),
        stop: () => this.stop(h),
      };
      this._loops.push(h);
      this._handles.set(h.id, h);
      return h;
    }

    // Distance cull — never build a graph for something inaudible.
    if (o.position) {
      const c = this.ctx.camera.position;
      const dx = o.position.x - c.x, dy = o.position.y - c.y, dz = o.position.z - c.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const cull = (o.cull || 320);
      if (d2 > cull * cull) return null;
    }
    const v = fn(this, o);
    if (!v) return null;
    // NOT registered in _handles: one-shots are fire-and-forget and there are
    // thousands of them in a session, so a registry would leak. stop() takes
    // the handle object itself.
    const h = { id: this._handleId++, name, kind: 'one', voice: v, stop: null };
    h.stop = () => this.stop(h);
    return h;
  }

  /**
   * Crossfade an ambient bed.
   * @param {string} name  wind | rain | river | fire | insects | birds | town | underwater
   * @param {number|null} weight 0..1, or null to hand control back to the
   *                             automatic env-driven mix.
   */
  ambience(name, weight) {
    const b = this.beds.get(name);
    if (!b) return false;
    b.manual = (weight == null) ? null : Math.max(0, Math.min(1, weight));
    return true;
  }

  /** Stop a handle from play(). */
  stop(handle) {
    if (!handle) return;
    const h = typeof handle === 'object' ? handle : this._handles.get(handle);
    if (!h) return;
    if (h.kind === 'loop') {
      const i = this._loops.indexOf(h);
      if (i >= 0) this._loops.splice(i, 1);
    } else if (h.voice && this.actx) {
      const t = this.actx.currentTime;
      try {
        h.voice.gain.gain.cancelScheduledValues(t);
        h.voice.gain.gain.setTargetAtTime(0, t, 0.02);
      } catch (e) { /* already recycled */ }
      h.voice.expires = Math.min(h.voice.expires, t + 0.12);
    }
    this._handles.delete(h.id);
  }

  setMasterVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) glide(this.master.gain, this.muted ? 0 : this.volume, 0.06, this.now());
  }

  getMasterVolume() { return this.volume; }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) glide(this.master.gain, this.muted ? 0 : this.volume, 0.06, this.now());
    return this.muted;
  }

  /** Force the surface used for footsteps (e.g. a boardwalk). null = auto. */
  setFootstepSurface(name) { this._surfaceOverride = name || null; }

  audioStats() {
    return {
      enabled: this.enabled,
      state: this.actx ? this.actx.state : 'none',
      voices: this.pool ? this.pool.active.length : 0,
      peakVoices: this.pool ? this.pool.peak : 0,
      dropped: this.pool ? this.pool.rejected : 0,
      beds: [...this.beds.values()].filter((b) => b.weight > 0.02).map((b) => b.name),
    };
  }

  now() { return this.actx ? this.actx.currentTime : 0; }

  /**
   * A gain node feeding the shared reverb, for a voice that wants more space
   * than its bus send gives it (a gunshot in open country wants a lot more).
   * Returns null when there is no reverb in the *current* context — which is
   * the case in an offline render that did not ask for one, and connecting
   * across contexts throws.
   * @returns {GainNode|null}
   */
  wetSend(amount = 0.3) {
    const t = this._wetTarget;
    if (!t || t.context !== this.actx) return null;
    const g = this.actx.createGain();
    g.gain.value = amount;
    g.connect(t);
    return g;
  }

  /**
   * Pull the ambience bus down for a moment.
   *
   * This is what makes a gunshot read as LOUD rather than merely present: the
   * ear judges level by contrast, and dropping the weather 10 dB under the
   * report for a second buys more perceived impact than any amount of gain on
   * the shot itself — and it costs no headroom, which gain does.
   */
  duckAmbience(t0 = this.now(), amount = 0.3, hold = 0.10, release = 0.85) {
    const g = this.ambDuck && this.ambDuck.gain;
    if (!g) return;
    try {
      if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t0);
      else { g.cancelScheduledValues(t0); g.setValueAtTime(g.value, t0); }
      g.linearRampToValueAtTime(amount, t0 + 0.010);
      g.setValueAtTime(amount, t0 + hold);
      g.linearRampToValueAtTime(1, t0 + hold + release);
    } catch (e) { /* param automation raced a teardown */ }
  }

  /** Reserve a pooled voice. Foley calls this; returns null when saturated. */
  voice(o) {
    if (!this.pool) return null;
    return this.pool.acquire({ dest: this.bus.foley, ...o });
  }

  /** A world point at `radius` around the listener; `a01` is azimuth 0..1. */
  pointNear(radius, a01, dy = 0) {
    const c = this.ctx.camera.position;
    const a = a01 * Math.PI * 2;
    return this.tmp.set(c.x + Math.cos(a) * radius, c.y + dy, c.z + Math.sin(a) * radius);
  }

  /* ------------------------------------------------------------ per-frame */

  update(dt) {
    this._elapsed += dt;
    if (!this.enabled || !this.actx || this._offline) return;
    if (this.actx.state === 'suspended') return;

    const ctx = this.ctx;
    const env = ctx.env;
    const now = this.actx.currentTime;

    this._updateShelter();
    this._updateBedTargets(dt, env);

    for (const b of this.beds.values()) {
      b.applyWeight(now, 0.6);
      b.tune(dt, env, this);
    }

    // Lookahead scheduling window — one pass, 0.5 s ahead.
    const to = now + 0.5;
    if (this._scheduledTo < now) this._scheduledTo = now;
    if (to > this._scheduledTo) {
      for (const b of this.beds.values()) {
        try { b.schedule(this, this._scheduledTo, to, env); } catch (e) { /* bed-local */ }
      }
      this._scheduledTo = to;
    }

    // Looping handles from play(name,{loop:true}).
    for (let i = this._loops.length - 1; i >= 0; i--) {
      const h = this._loops[i];
      if (h.next < now) h.next = now;
      while (h.next < to) {
        const fn = SYNTH[h.name];
        if (fn) fn(this, { ...h.opts, at: h.next });
        h.next += h.interval;
      }
    }

    this._updateLocomotion(dt);
    this._updateWeapon();
    this._updateSubmerged(env, now);
    this.pool.update();
  }

  /* --------------------------------------------------------- weapon mechanics */

  /**
   * The mechanical sounds of the rifle, SYNCHRONISED TO ITS ANIMATION.
   *
   * A lever-action reload is not one noise, and neither is a cycle. Both are
   * sequences of distinct events at specific instants — and those instants are
   * owned by Weapon.js, not by this file. Firing all of them off a timer from
   * the `gunshot` event was what made the first cut sound canned: the sound
   * said the lever was shut while the mesh still had it hanging open.
   *
   * So nothing here is scheduled ahead. Every event is emitted on the frame the
   * animation actually reaches it, watched off the two scalars the weapon
   * publishes for exactly this purpose:
   *
   *   weapon.cycle   0..1 lever throw — rises to 1 as it opens, back to 0 as it
   *                  snaps shut. The throw fires on the leading edge, the return
   *                  on the trailing one, so re-timing the animation re-times
   *                  the audio for free.
   *   weapon.ammo    increments the instant a round is thumbed into the tube.
   *                  One `shellIn` per increment, each one slightly different.
   *
   * Reload start/end come from `reloadT`/`_reloadT` when the weapon exposes it,
   * and otherwise are inferred from the ammo run. A weapon system that would
   * rather drive this explicitly can emit `reload` with `{ phase: 'start' |
   * 'round' | 'end', position }` — that path is wired below and takes priority.
   */
  _updateWeapon() {
    const W = this._weaponRef();
    if (!W) return;
    const s = this._wpn;
    const pos = W.muzzleWorld && W.muzzleWorld.lengthSq() > 0
      ? W.muzzleWorld : this.ctx.player.position;
    const r = this.rand;

    /* ---- lever cycle, driven by the animation's own scalar --------------- */
    const c = W.cycle || 0;
    if (c > 0.05 && s.cycle <= 0.05) {
      this.play('leverThrow', { position: pos, volume: 0.85 + r() * 0.2 });
      s.opened = false;
    }
    if (c > 0.80) s.opened = true;
    if (c <= 0.05 && s.cycle > 0.05 && s.opened) {
      this.play('leverReturn', { position: pos, volume: 0.9 + r() * 0.2 });
      s.opened = false;
    }
    s.cycle = c;

    /* ---- reload ---------------------------------------------------------- */
    if (s.eventDriven) { s.ammo = W.ammo; return; }
    const rt = W.reloadT != null ? W.reloadT : (W._reloadT != null ? W._reloadT : -1);
    const reloading = rt >= 0;
    if (reloading && !s.reloading) this._reloadPhase('start', pos);
    /*
     * A round seats the instant the counter moves — that is the animation's own
     * timing, not a guess at it. The `|| s.reloading` matters: the weapon seats
     * the LAST cartridge and clears its reload timer in the same frame, so
     * testing `reloading` alone silently dropped the final round of every
     * reload. Driving the real game and reading the log is the only way that
     * was ever going to show up.
     */
    if (s.ammo >= 0 && W.ammo > s.ammo && (reloading || s.reloading)) {
      this._reloadPhase('round', pos);
    }
    if (!reloading && s.reloading) this._reloadPhase('end', pos);
    s.reloading = reloading;
    s.ammo = W.ammo;
  }

  /**
   * One step of the reload sequence. Also the handler for an explicit `reload`
   * event, so the weapon owner can drive this instead of being watched.
   */
  _reloadPhase(phase, pos) {
    const s = this._wpn;
    const r = this.rand;
    const p = pos || this.ctx.player.position;
    if (phase === 'start') {
      s.round = 0;
      // thumb rolls the hammer to half-cock, then the loading gate springs in
      this.play('hammerBack', { position: p, volume: 0.7 + r() * 0.15 });
      this.play('gateOpen', { position: p, at: this.now() + 0.07 + r() * 0.03, volume: 0.85 });
    } else if (phase === 'round') {
      // Every cartridge is a slightly different press: the tube fills up, the
      // follower spring shortens, and the brass never lands the same way twice.
      const k = Math.min(1, s.round / 7);
      this.play('shellIn', {
        position: p, volume: 0.8 + r() * 0.25, seat: k, vary: r(),
      });
      s.round++;
    } else if (phase === 'end') {
      // clear of the last cartridge going in, which lands on the same frame
      this.play('gateClose', { position: p, at: this.now() + 0.11, volume: 0.9 + r() * 0.15 });
      this.play('leather', { position: p, at: this.now() + 0.17 + r() * 0.06, volume: 0.35 });
      s.round = 0;
    }
  }

  lateUpdate() {
    if (!this.ready || !this.actx || this.actx.state === 'suspended') return;
    const cam = this.ctx.camera;
    const L = this.actx.listener;
    const t = this.actx.currentTime;
    cam.getWorldDirection(this._fwd);
    this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const p = cam.position;
    if (L.positionX) {
      // setTargetAtTime keeps the panning from stepping on fast camera cuts.
      L.positionX.setTargetAtTime(p.x, t, 0.02);
      L.positionY.setTargetAtTime(p.y, t, 0.02);
      L.positionZ.setTargetAtTime(p.z, t, 0.02);
      L.forwardX.setTargetAtTime(this._fwd.x, t, 0.03);
      L.forwardY.setTargetAtTime(this._fwd.y, t, 0.03);
      L.forwardZ.setTargetAtTime(this._fwd.z, t, 0.03);
      L.upX.setTargetAtTime(this._up.x, t, 0.03);
      L.upY.setTargetAtTime(this._up.y, t, 0.03);
      L.upZ.setTargetAtTime(this._up.z, t, 0.03);
    } else {
      if (L.setPosition) L.setPosition(p.x, p.y, p.z);
      if (L.setOrientation) {
        L.setOrientation(this._fwd.x, this._fwd.y, this._fwd.z, this._up.x, this._up.y, this._up.z);
      }
    }
  }

  /* ------------------------------------------------------- mix derivation */

  _updateShelter() {
    const ctx = this.ctx;
    let s = 0;
    if (this._townCentre) {
      const d = this._townCentre.distanceTo(ctx.camera.position);
      s = Math.max(s, smoothstep(190, 45, d) * 0.85);
    }
    if (ctx.player.inTown) s = Math.max(s, 0.7);
    if (ctx.env.cameraSubmerged) s = 1;
    this.shelter += (s - this.shelter) * 0.06;
    const now = this.now();
    const w = wetMix(this.shelter);
    glide(this.wetTight.gain, w.tight, 0.5, now);
    glide(this.wetOpen.gain, w.open, 0.5, now);
  }

  _updateBedTargets(dt, env) {
    const ctx = this.ctx;
    this._anchorT = (this._anchorT || 0) + dt;
    if (this._anchorT > 1.0) { this._anchorT = 0; this._refreshAnchors(); }
    const sub = env.cameraSubmerged ? 1 : 0;
    const rain = clamp01(env.rainIntensity);
    const h = env.timeOfDay != null ? env.timeOfDay : 12;
    const ph = dayPhase(h);
    const windLoud = clamp01((env.windStrength - 5) / 8);

    const B = (n) => this.beds.get(n);
    B('wind').target = (1 - sub);
    B('rain').target = clamp01(rain * 1.15) * (1 - sub);
    B('underwater').target = sub;

    const quiet = (1 - rain * 0.85) * (1 - windLoud * 0.55) * (1 - sub);
    const ins = B('insects');
    ins.target = (ph.night * 0.85 + ph.dusk * 0.7 + ph.dawn * 0.3 + ph.day * 0.22) * quiet;
    ins.mode = (ph.day > 0.55 && (env.temperature == null || env.temperature > 18)) ? 'day' : 'night';

    const birds = B('birds');
    birds.target = (ph.dawn * 1.0 + ph.day * 0.5 + ph.dusk * 0.6 + ph.night * 0.45) * quiet;
    birds.mode = ph.dawn > 0.45 ? 'dawn' : ph.night > 0.45 ? 'night' : ph.dusk > 0.45 ? 'dusk' : 'day';

    // --- river: find the nearest water surface a couple of times a second ---
    const t = this._elapsed;
    if (t - this._water.t > 0.4) {
      this._water.t = t;
      this._findWater();
    }
    const riv = B('river');
    if (this._water.found) {
      riv.setPosition(this._water.x, this._water.y, this._water.z);
      riv.target = smoothstep(150, 6, this._water.d);
    } else riv.target = 0;

    // --- fire ---
    const fire = B('fire');
    const fp = ctx.poi.get('camp_fire');
    if (fp) {
      const p = fp.pos || fp;
      const d = ctx.camera.position.distanceTo(p);
      fire.target = smoothstep(52, 4, d);
    } else fire.target = 0;

    // --- town ---
    const town = B('town');
    if (this._townCentre) {
      const d = this._townCentre.distanceTo(ctx.camera.position);
      town.target = Math.max(smoothstep(430, 90, d), ctx.player.inTown ? 0.85 : 0) * (1 - sub) * (1 - rain * 0.4);
    } else town.target = 0;
  }

  /** Ring search for the nearest water cell. Cheap, and only twice a second. */
  _findWater() {
    const w = this.ctx.world;
    if (!w || !w.ready || typeof w.isWater !== 'function') { this._water.found = false; return; }
    const c = this.ctx.camera.position;
    const RAD = [2, 5, 9, 15, 24, 38, 56, 80, 110, 150];
    for (let i = 0; i < RAD.length; i++) {
      const r = RAD[i];
      const n = i < 3 ? 6 : 12;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + i * 0.37;
        const x = c.x + Math.cos(a) * r;
        const z = c.z + Math.sin(a) * r;
        if (w.isWater(x, z)) {
          this._water.found = true;
          this._water.x = x; this._water.z = z;
          this._water.y = (w.waterLevel != null ? w.waterLevel : 0);
          const gh = w.getHeight ? w.getHeight(x, z) : 0;
          this._water.y = Math.max(this._water.y, gh);
          this._water.d = Math.hypot(x - c.x, z - c.z, this._water.y - c.y);
          return;
        }
      }
    }
    this._water.found = false;
    this._water.d = 1e9;
  }

  _updateSubmerged(env, now) {
    const sub = env.cameraSubmerged ? 1 : 0;
    glide(this.submergeLP.frequency, sub ? 420 : 20000, sub ? 0.12 : 0.3, now);
    glide(this._busObjs.foley.node.gain, sub ? 0.5 : 1.0, 0.2, now);
    glide(this._busObjs.weather.node.gain, sub ? 0.35 : 1.0, 0.2, now);
  }

  /* ------------------------------------------------------------ locomotion */

  /**
   * Distance-driven footfalls.
   *
   * If the player system emits 'footstep' we defer to it entirely. When it does
   * not (or has not yet), we synthesise the cadence ourselves from the distance
   * the player actually covered — which stays in sync with the animation far
   * better than a timer would, and never fires while standing still.
   */
  _updateLocomotion(dt) {
    const ctx = this.ctx;
    const p = ctx.player.position;
    const moved = Math.hypot(p.x - this._prevPos.x, p.z - this._prevPos.z);
    this._prevPos.copy(p);
    if (moved > 8) { this._strideAccum = 0; return; }   // teleport
    if (this._externalSteps && this._elapsed - this._lastExternalStep < 4) return;
    if (moved < 1e-4) { this._strideAccum *= 0.985; return; }

    const speed = moved / Math.max(1e-4, dt);
    const mounted = ctx.player.mode === 'mounted' || !!ctx.player.horse;
    const surface = this._surfaceAt(p.x, p.z);
    const wet = ctx.env.wetness || 0;

    if (!mounted) {
      const run = clamp01((speed - 1.6) / 4.0);
      const stride = 0.68 + run * 0.62;
      this._strideAccum += moved;
      if (this._strideAccum < stride) return;
      this._strideAccum -= stride;
      this.play('footstep', {
        position: p, surface, wetness: wet,
        speed: clamp01(speed / 6), volume: 0.55 + run * 0.5,
      });
      return;
    }

    const gait = speed < 2.4 ? GAITS.walk
      : speed < 5.2 ? GAITS.trot
        : speed < 9.0 ? GAITS.canter : GAITS.gallop;
    this._strideAccum += moved;
    if (this._strideAccum < gait.stride) return;
    this._strideAccum -= gait.stride;
    const strideTime = gait.stride / Math.max(0.8, speed);
    const t0 = this.now() + 0.04;
    for (let i = 0; i < gait.beats.length; i++) {
      const b = gait.beats[i];
      this.play('hoof', {
        position: p, surface, wetness: wet,
        at: t0 + b.t * strideTime, energy: b.e,
        volume: (0.5 + clamp01(speed / 11) * 0.6) * b.v,
      });
    }
  }

  _surfaceAt(x, z) {
    if (this._surfaceOverride) return this._surfaceOverride;
    const ctx = this.ctx;
    const w = ctx.world;
    if (ctx.player.inTown) return 'wood';
    if (!w || !w.ready) return 'dirt';
    try {
      if (w.isWater && w.isWater(x, z)) {
        const gh = w.getHeight(x, z);
        if (gh < (w.waterLevel || 0) - 0.15) return 'water';
      }
      const s = w.getSurface(x, z);
      if (!s) return 'dirt';
      let best = 'dirt', bv = -1;
      for (const k of ['grass', 'rock', 'dirt', 'sand', 'snow']) {
        const v = s[k] || 0;
        if (v > bv) { bv = v; best = k; }
      }
      if (best === 'dirt' && (ctx.env.wetness || 0) > 0.6) return 'mud';
      if (best === 'grass') {
        // dry western grass rustles rather than swishes
        return (ctx.env.wetness || 0) > 0.35 ? 'grass' : 'dry_grass';
      }
      if (best === 'rock') {
        const slope = w.getSlope ? w.getSlope(x, z) : 1;
        return slope < 0.6 ? 'scree' : 'rock';
      }
      return best;
    } catch (e) {
      return 'dirt';
    }
  }

  /* ------------------------------------------------------------ diagnostics */

  /**
   * Render a synth or a bed into an OfflineAudioContext and return the buffer.
   * Used by the audio test harness to inspect waveforms without a soundcard.
   * @returns {Promise<AudioBuffer>}
   */
  async renderOffline({
    synth = null, bed = null, seconds = 2, env = {}, opts = {}, mode = null, shelter = 0,
    space = null, tap = 'full',
  } = {}) {
    const sr = this.actx ? this.actx.sampleRate : 48000;
    const OAC = typeof window !== 'undefined'
      ? (window.OfflineAudioContext || window.webkitOfflineAudioContext) : null;
    if (!OAC) throw new Error('no OfflineAudioContext');
    const off = new OAC(2, Math.ceil(seconds * sr), sr);

    const savedBuf = this.buf;
    const savedActx = this.actx;
    const savedPool = this.pool;
    const savedBus = this.bus;
    const savedShelter = this.shelter;
    const savedReady = this.ready;
    const savedWet = this._wetTarget;
    const savedDuck = this.ambDuck;

    const dest = off.createGain();
    dest.connect(off.destination);
    this._offline = true;   // freeze the live update loop while the graph is swapped
    this.actx = off;
    this.buf = this._buildBuffers(off);
    this.pool = new VoicePool(off, 200);

    /* `space` reproduces the live output chain offline — the whole bus tree,
       the reverb crossfade (0 = open country, 1 = between buildings), the
       master gain and the output compressor — so the sense of enclosure AND
       the true delivered level can both be measured rather than asserted.
       This is what src/audio/_dev/mix.html reads its numbers off, so it has to
       stay a faithful copy of _buildGraph(). */
    let sink = dest;
    this._wetTarget = null;
    this.ambDuck = null;
    if (space != null) {
      /* `tap` is for the wet/dry meter only: 'dry' mutes the reverb returns,
         'wet' mutes the direct group→master paths, and both bypass the
         compressor and the soft clipper so the two halves can be compared as
         linear energies instead of through a non-linearity that treats them
         differently. 'full' — the default, and what every other caller gets —
         is the real chain, unchanged. */
      const dryOn = tap !== 'wet';
      const wetOn = tap !== 'dry';
      const master = off.createGain();
      master.gain.value = this.volume;
      if (tap === 'full') {
        const comp = off.createDynamicsCompressor();
        comp.threshold.value = -13; comp.knee.value = 14; comp.ratio.value = 3.2;
        comp.attack.value = 0.004; comp.release.value = 0.26;
        comp.connect(buildLimiter(off, dest).input);
        master.connect(comp);
      } else {
        master.connect(dest);
      }

      const wetIn = off.createGain();
      const co = off.createConvolver(); co.normalize = false;
      co.buffer = makeImpulseResponse(off, this._irParams('open'));
      const ct = off.createConvolver(); ct.normalize = false;
      ct.buffer = makeImpulseResponse(off, this._irParams('tight'));
      const w = wetMix(space);
      const go = off.createGain(); go.gain.value = wetOn ? w.open : 0;
      const gt = off.createGain(); gt.gain.value = wetOn ? w.tight : 0;
      wetIn.connect(co); co.connect(go); go.connect(master);
      wetIn.connect(ct); ct.connect(gt); gt.connect(master);
      this._wetTarget = wetIn;

      const group = (level, send) => {
        const grp = off.createGain(); grp.gain.value = level;
        if (dryOn) grp.connect(master);
        const child = off.createGain(); child.gain.value = 1; child.connect(grp);
        if (send > 0) {
          const s = off.createGain(); s.gain.value = send * level;
          child.connect(s); s.connect(wetIn);
        }
        return child;
      };
      this.bus = {
        ambient: group(MIX.ambience, SEND.ambient),
        weather: group(MIX.ambience, SEND.weather),
        foley: group(MIX.sfx, SEND.foley),
        ui: group(MIX.ui, 0),
      };
      this.bus.sfx = this.bus.foley;
      sink = this.bus.foley;
    } else {
      this.bus = { ambient: sink, weather: sink, foley: sink, ui: sink };
      this.bus.sfx = sink;
    }
    this.shelter = shelter;
    this.ready = true;      // beds schedule through play(), which is ready-gated

    try {
      if (synth) {
        const fn = SYNTH[synth];
        if (!fn) throw new Error('no synth ' + synth);
        fn(this, { at: 0.02, ...opts });
        if (opts.repeat) {
          for (let k = 1; k < opts.repeat; k++) {
            fn(this, { ...opts, at: 0.02 + k * (opts.every || 0.5) });
          }
        }
      } else if (bed) {
        const Ctors = {
          wind: WindBed, rain: RainBed, river: RiverBed, fire: FireBed,
          insects: InsectBed, birds: BirdBed, town: TownBed, underwater: UnderwaterBed,
        };
        const C = Ctors[bed];
        if (!C) throw new Error('no bed ' + bed);
        const b = new C(this);
        b.build();
        b.output.connect(space != null ? this.bus.ambient : sink);
        // A bed has its own reverb tap on top of the group send (_buildBeds);
        // leave it out and the meter reads a bed drier than the game plays it.
        if (space != null && b.send > 0 && this._wetTarget) {
          const bs = off.createGain();
          bs.gain.value = b.send * SEND.bed * MIX.ambience;
          b.output.connect(bs); bs.connect(this._wetTarget);
        }
        if (mode) b.mode = mode;
        b.target = 1; b.weight = 1;
        // Full weight, but the bed's own trim still applies — that is the
        // level the game actually delivers.
        b.out.gain.value = b.trim != null ? b.trim : 1;
        const e = { ...this.ctx.env, ...env };
        const step = 1 / 30;
        for (let t = 0; t < seconds; t += step) {
          b.tune(step, e, { now: () => t, shelter, rand: this.rand });
          b.schedule(this, t, t + step, e);
        }
      }
      return await off.startRendering();
    } finally {
      this.actx = savedActx;
      this.buf = savedBuf;
      this.pool = savedPool;
      this.bus = savedBus;
      this.shelter = savedShelter;
      this.ready = savedReady;
      this._wetTarget = savedWet;
      this.ambDuck = savedDuck;
      this._offline = false;
    }
  }

  resize() {}

  dispose() {
    for (const off of this._unbind) { try { off(); } catch (e) { /* noop */ } }
    this._unbind.length = 0;
    for (const b of this.beds.values()) b.dispose();
    this.beds.clear();
    if (this.pool) this.pool.dispose();
    if (this.actx && this.actx.close) { try { this.actx.close(); } catch (e) { /* noop */ } }
    this.actx = null;
    this.ready = false;
    this.enabled = false;
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * Group-bus levels, under the master.
 *
 * These are not taste — they are the result of measuring every bed and every
 * one-shot through the real output chain and reading the delivered RMS off a
 * meter (src/audio/_dev/mix.html). Ambience is trimmed 10.5 dB below unity so
 * that the loudest weather sits ~15 dB *under* a rifle report instead of 14 dB
 * over it. Change one of these and re-run the meter; do not eyeball it.
 */
export const MIX = {
  ambience: 0.30,   // −10.5 dB — beds + weather one-shots
  sfx: 1.0,         //   0.0 dB — foley, weapons, animals, impacts
  ui: 0.55,         //  −5.2 dB — menu / HUD clicks
};

/**
 * Reverb send amounts, as honest wet/dry AMPLITUDE ratios.
 *
 * They can be read that way now because the impulse responses are energy-
 * normalised (Noise.js) and the returns are crossfaded rather than summed, so
 * wet/dry ≈ send × WET_RETURN — the group and bed trims cancel, since a send is
 * always tapped pre-trim and scaled by that same trim.
 *
 * OUTDOORS IS DRY. Open country has no boundaries near enough to return sound
 * inside the time the ear fuses it; a boot on dirt, a hoof, a saddle creak and a
 * lever throw all arrive dry and stay dry, and the only thing the landscape
 * gives back is a long tail on something loud enough to reach it and come home
 * — which is the gunshot, and only the gunshot. These sat at 0.16/0.20/0.13
 * into a convolver running +24 dB of unaccounted gain, i.e. reverb 6–9 dB
 * *louder* than the dry signal on every footstep. Hence: metal room.
 */
export const SEND = {
  ambient: 0.05,    // −26 dB — beds; the bed's own tap adds to this
  weather: 0.06,    // −24 dB
  foley: 0.045,     // −27 dB — footsteps, foley, mechanical: effectively dry
  bed: 0.45,        // scales each bed's own extra tap (Beds.js `send`)
};

/** Reverb return level at the master, at whichever end of the crossfade. */
export const WET_RETURN = 0.9;

/**
 * Equal-power crossfade between the open-country tail and the room tail.
 *
 * `shelter` is 0 in open country, ~0.7–0.85 in the settlement, 1 submerged.
 * cos/sin keeps wetOpen² + wetTight² constant, so the space changes character
 * without changing loudness. The previous law was `open = (1−0.72s)·0.9` and
 * `tight = 1.5s`, which is not a crossfade at all: at s = 0.7 it ran the open
 * tail at 0.45 AND the room tail at 1.05 simultaneously.
 */
export function wetMix(shelter) {
  const s = shelter < 0 ? 0 : shelter > 1 ? 1 : shelter;
  const th = s * Math.PI * 0.5;
  return { open: Math.cos(th) * WET_RETURN, tight: Math.sin(th) * WET_RETURN };
}

/**
 * Soft-clip transfer function, as a WaveShaper curve plus its input scaling.
 *
 * The pair is the whole trick. A WaveShaper CLAMPS its input to [−1, 1] before
 * it indexes the curve, so on its own it cannot soft-limit anything already
 * over full scale — every overshoot lands on the same endpoint and shears. So
 * the signal is scaled by 1/LIMIT_DRIVE going in and the curve is stretched by
 * LIMIT_DRIVE, which makes the whole stage exactly
 *
 *     y = tanh(x)          for |x| ≤ 4  (i.e. up to +12 dBFS of drive)
 *
 * Unity below −12 dBFS, 2.4 dB down at 0 dBFS, and an asymptote at ±0.9993 that
 * nothing can cross. It also means the pre-limiter peak of any measurement is
 * recoverable as atanh(y) — which is how the headroom column in mix.html gets
 * a true peak out of a limited signal.
 */
export const LIMIT_DRIVE = 4;

export function makeSoftClipCurve(n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(((i / (n - 1)) * 2 - 1) * LIMIT_DRIVE);
  return c;
}

/** master → [1/DRIVE] → shaper → dest. Returns the node to feed. */
export function buildLimiter(actx, dest) {
  const shaper = actx.createWaveShaper();
  shaper.curve = makeSoftClipCurve(2048);
  shaper.oversample = '2x';
  shaper.connect(dest);
  const pre = actx.createGain();
  pre.gain.value = 1 / LIMIT_DRIVE;
  pre.connect(shaper);
  return { input: pre, shaper };
}

const GAITS = {
  //                     four-beat walk, diagonal trot, three-beat canter, gallop
  walk: { stride: 1.75, beats: [{ t: 0, e: 0.5, v: 1 }, { t: 0.26, e: 0.45, v: 0.85 }, { t: 0.5, e: 0.5, v: 1 }, { t: 0.76, e: 0.45, v: 0.85 }] },
  trot: { stride: 2.7, beats: [{ t: 0, e: 0.75, v: 1 }, { t: 0.5, e: 0.75, v: 0.95 }] },
  canter: { stride: 4.3, beats: [{ t: 0, e: 0.7, v: 0.9 }, { t: 0.28, e: 0.85, v: 1 }, { t: 0.56, e: 1.0, v: 1 }] },
  gallop: { stride: 6.2, beats: [{ t: 0, e: 0.8, v: 0.85 }, { t: 0.14, e: 0.9, v: 1 }, { t: 0.34, e: 1.0, v: 1 }, { t: 0.47, e: 0.85, v: 0.9 }] },
};

/** The raw terrain-weight keys, which are NOT foley surface names. */
const RAW_SURFACE = new Set(['grass', 'rock', 'dirt', 'sand', 'snow']);

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Smooth weights for the four parts of the day, from the clock hour. */
function dayPhase(h) {
  const band = (a, b, fade) => {
    const up = clamp01((h - a) / fade);
    const dn = clamp01((b - h) / fade);
    return Math.min(up, dn);
  };
  const wrap = (a, b, fade) => (a > b ? Math.max(band(a, 24.5, fade), band(-0.5, b, fade)) : band(a, b, fade));
  const dawn = band(4.4, 8.4, 1.0);
  const day = band(7.6, 17.6, 1.2);
  const dusk = band(17.2, 20.8, 1.0);
  const night = wrap(20.2, 5.0, 1.0);
  const s = dawn + day + dusk + night || 1;
  return { dawn: dawn / s, day: day / s, dusk: dusk / s, night: night / s };
}
