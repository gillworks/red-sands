import * as THREE from 'three';
import { rng } from '../core/Context.js';

/**
 * ============================================================================
 *  WEATHER — an evolving climate simulation.
 * ============================================================================
 *
 *  Owns (per docs/CONTRACTS.md §3):
 *     env.ambientColor / ambientIntensity / turbidity
 *     env.fogColor / fogDensity / groundMist
 *     env.cloudCover / cloudDensity
 *     env.wetness / rainIntensity / snowIntensity / snowCover
 *     env.lightningFlash / weatherName
 *     env.windVector / windStrength / windGust
 *
 *  Additive public surface (documented in the report, safe to read):
 *     env.cloudType        0 = flat stratus … 0.5 = cumulus … 1 = cumulonimbus
 *     env.cirrus           0..1 high wispy cirrus deck amount
 *     env.sunAttenuation   0..1 how much the cloud deck should kill the sun
 *     env.puddleLevel      0..1 standing water (fills slower, dries slower)
 *     env.temperature      degrees C, drives snow / melt
 *     env.thunder          0..1 storm severity, for audio beds
 *     env.windPhase        metres the gust front has travelled downwind.
 *                          ONE coherent wind for the whole world: any system
 *                          can reconstruct the *same* travelling gust with
 *                             g = gustWave(dot(pos.xz, windDirXZ) - windPhase)
 *                          or just call weather.gustAt(x, z) → 0..1. Grass,
 *                          trees, dust, cloth, water chop and the particle
 *                          system all read this so a gust is visibly one event
 *                          crossing the landscape rather than every object
 *                          wobbling on its own clock.
 *     env.windWaveLength   metres between gust crests
 *     env.windTurb         0..1 small-scale turbulence amount
 *
 *  Design notes
 *  ------------
 *  * The state machine is Markov-ish with *plausible* edges only: `clear` can
 *    never jump to `storm`; it has to walk clear → fair → overcast → rain →
 *    storm. Dwell times are minutes, not seconds.
 *  * NOTHING steps. Every scalar is pushed through a first-order low pass with
 *    a per-field time constant, so a state switch is a slow front rolling in.
 *  * Rain leaves the world wet for a long time afterwards, puddles fill and
 *    evaporate on a slower clock again, and snow accumulates then melts. Those
 *    persistent after-effects are the thing that sells weather as a simulation.
 */

/* -------------------------------------------------------------------------- */
/*  State profiles. All colours are LINEAR radiance tints, never sRGB.         */
/* -------------------------------------------------------------------------- */

const defaults = {
  turbidity: 2.6,
  cloudCover: 0.35,
  cloudDensity: 0.4,
  /** 0 stratus, 0.5 cumulus, 1 cumulonimbus */
  cloudType: 0.5,
  cirrus: 0.25,
  fogDensity: 0.00016,
  groundMist: 0.0,
  rain: 0.0,
  snow: 0.0,
  /** multiplier on sky-derived ambient intensity */
  ambient: 1.0,
  /** 0 = ambient colour comes from the sky, 1 = fully overridden by `tint` */
  grey: 0.0,
  /** mean wind speed m/s */
  wind: 3.0,
  /** gust envelope amplitude */
  gust: 0.3,
  /** how much of the sun the deck eats */
  sunAtten: 0.05,
  /** thunder / severity bed for audio */
  thunder: 0.0,
  tint: [0.50, 0.52, 0.56],
  haze: [0.62, 0.68, 0.78],
  /** dwell time range, seconds */
  dur: [240, 600],
};

const mk = (o) => Object.assign({}, defaults, o);

const PROFILES = {
  /* Coverage is deliberately generous for a "clear" day. A western sky with
   * literally nothing in it gives high noon no cloud shadow to sweep across the
   * plain, and moving cloud shadow is the single strongest cheap realism cue
   * available (pass-2 forensic: "distant mountains ... no cloud shadows").
   * 0.46 with cloudType 0.62 is a field of crisp fair-weather cumulus with
   * plenty of blue between them, not a lid. */
  clear: mk({
    turbidity: 2.05, cloudCover: 0.52, cloudDensity: 0.58, cloudType: 0.62, cirrus: 0.26,
    fogDensity: 0.000075, groundMist: 0.0, ambient: 1.0, grey: 0.0,
    wind: 2.4, gust: 0.20, sunAtten: 0.03,
    tint: [0.34, 0.46, 0.70], haze: [0.66, 0.72, 0.83], dur: [420, 1100],
  }),
  fair: mk({
    turbidity: 2.7, cloudCover: 0.56, cloudDensity: 0.60, cloudType: 0.66, cirrus: 0.22,
    fogDensity: 0.00013, groundMist: 0.03, ambient: 1.06, grey: 0.10,
    wind: 3.7, gust: 0.34, sunAtten: 0.09,
    tint: [0.40, 0.47, 0.62], haze: [0.64, 0.70, 0.80], dur: [320, 820],
  }),
  overcast: mk({
    turbidity: 4.1, cloudCover: 0.86, cloudDensity: 0.60, cloudType: 0.14, cirrus: 0.05,
    fogDensity: 0.00021, groundMist: 0.08, ambient: 1.14, grey: 0.80,
    wind: 5.2, gust: 0.40, sunAtten: 0.62,
    tint: [0.40, 0.43, 0.49], haze: [0.53, 0.56, 0.62], dur: [280, 660],
  }),
  rain: mk({
    turbidity: 3.6, cloudCover: 0.88, cloudDensity: 0.84, cloudType: 0.46, cirrus: 0.0,
    fogDensity: 0.00015, groundMist: 0.0, rain: 0.58, ambient: 0.72, grey: 0.72,
    wind: 7.2, gust: 0.55, sunAtten: 0.78, thunder: 0.15,
    tint: [0.31, 0.34, 0.40], haze: [0.42, 0.45, 0.51], dur: [230, 520],
  }),
  /* A thunderstorm is a CELL, not a lid, and above all it is DARK. Coverage
   * stays under 1 so the towers have sky to be silhouetted against and the
   * anvil can spread; the drama comes from cloudDensity/cloudType (which drive
   * the vertical profile in Clouds), from the rain shafts, and from how much
   * light the deck eats — not from painting the whole dome grey.
   *
   * PASS-3. groundMist is now flatly ZERO. It was 0.03, but _pushToEnv added a
   * wetness bump on top and PostFX's mist response is sqrt(), so a driving
   * rainstorm published ~0.08 and rendered as ~300 m of visibility in a
   * saturated fog LAKE over the whole plain. That single number is what turned
   * storm_plains — the one frame pass 1 got right — into a bowl of milk
   * (0.1st-percentile luma 0.317). Heavy rain SCAVENGES fog; you get fog after
   * a storm, not during one. `ambient` and `sunAtten` carry the drama instead:
   * under an active cell the ground loses ~85% of the direct beam and most of
   * the skylight, which is what makes a storm read as a storm. */
  storm: mk({
    turbidity: 2.9, cloudCover: 0.66, cloudDensity: 1.0, cloudType: 0.93, cirrus: 0.0,
    /* rain 0.96 -> 0.58. Severity multiplies this by up to 1.3, so 0.96 was
     * pinning env.rainIntensity at the 1.0 clamp and the particle system drew
     * a full-screen curtain of hard white streaks over everything including
     * the cloud layer (a named pass-2 regression). The storm's rain now reads
     * through the volumetric shafts and the wet ground, with the particles as
     * the near-field layer they are meant to be. */
    fogDensity: 0.000105, groundMist: 0.0, rain: 0.58, ambient: 0.52, grey: 0.12,
    /* sunAtten 0.30 -> 0.84. The comment above already said "under an active
     * cell the ground loses ~85% of the direct beam"; the number never moved,
     * so Lighting was still driving 4.04 of the sun's 5.77 units of key light
     * onto the plain and storm_plains rendered with hard directional highlights
     * and crisp cast shadows in the middle of a thunderstorm. That, not the
     * fog, is the remaining half of the whiteout: a fully sunlit plain under a
     * black sky cannot be dark, and the metering then normalised it to grey. */
    wind: 14.5, gust: 0.95, sunAtten: 0.84, thunder: 1.0,
    tint: [0.24, 0.27, 0.34], haze: [0.28, 0.30, 0.36], dur: [155, 380],
  }),
  fog: mk({
    turbidity: 3.3, cloudCover: 0.58, cloudDensity: 0.38, cloudType: 0.08, cirrus: 0.05,
    fogDensity: 0.00165, groundMist: 0.95, ambient: 1.26, grey: 0.72,
    wind: 1.1, gust: 0.10, sunAtten: 0.55,
    tint: [0.50, 0.53, 0.58], haze: [0.66, 0.68, 0.72], dur: [230, 520],
  }),
  snow: mk({
    turbidity: 4.3, cloudCover: 0.92, cloudDensity: 0.62, cloudType: 0.18, cirrus: 0.0,
    fogDensity: 0.00062, groundMist: 0.24, snow: 0.72, ambient: 1.30, grey: 0.86,
    wind: 5.6, gust: 0.52, sunAtten: 0.82,
    tint: [0.50, 0.55, 0.64], haze: [0.60, 0.64, 0.72], dur: [320, 760],
  }),
  dust: mk({
    turbidity: 9.6, cloudCover: 0.26, cloudDensity: 0.34, cloudType: 0.62, cirrus: 0.10,
    fogDensity: 0.00095, groundMist: 0.32, ambient: 0.86, grey: 0.92,
    wind: 11.5, gust: 0.90, sunAtten: 0.55,
    tint: [0.46, 0.33, 0.19], haze: [0.58, 0.42, 0.24], dur: [150, 380],
  }),
};

/** Per-field low-pass time constants, seconds. Rain arrives fast, haze slowly. */
const TAU = {
  turbidity: 34, cloudCover: 26, cloudDensity: 24, cloudType: 30, cirrus: 46,
  fogDensity: 34, groundMist: 42, rain: 13, snow: 20, ambient: 22,
  grey: 26, wind: 24, gust: 18, sunAtten: 22, thunder: 26,
};
const NUMERIC_KEYS = Object.keys(TAU);

/**
 * Markov transition table. Weights, normalised at pick time. Only plausible
 * edges exist — you cannot get a thunderstorm out of a clear sky.
 */
const TRANSITIONS = {
  clear:    { fair: 0.72, dust: 0.13, fog: 0.09, overcast: 0.06 },
  fair:     { clear: 0.36, overcast: 0.44, dust: 0.09, fog: 0.11 },
  overcast: { fair: 0.32, rain: 0.42, fog: 0.14, snow: 0.06, storm: 0.06 },
  rain:     { overcast: 0.50, storm: 0.24, fog: 0.16, fair: 0.10 },
  storm:    { rain: 0.68, overcast: 0.27, fair: 0.05 },
  fog:      { overcast: 0.38, fair: 0.37, clear: 0.25 },
  snow:     { overcast: 0.54, fair: 0.24, clear: 0.22 },
  dust:     { clear: 0.44, fair: 0.41, overcast: 0.15 },
};

/* -------------------------------------------------------------------------- */
/*  deterministic smooth 1-D value noise (no Math.random anywhere)             */
/* -------------------------------------------------------------------------- */

function hash1(n) {
  const s = Math.sin(n * 12.9898) * 43758.5453123;
  return s - Math.floor(s);
}
function vnoise(x, seed) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  const a = hash1(i * 1.7371 + seed * 91.7);
  const b = hash1((i + 1) * 1.7371 + seed * 91.7);
  return a + (b - a) * u;
}
/** Layered noise, 0..1, smooth in t. */
function fbm1(t, seed) {
  return (
    vnoise(t, seed) * 0.55 +
    vnoise(t * 2.37, seed + 7) * 0.29 +
    vnoise(t * 5.11, seed + 19) * 0.16
  );
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** first-order low pass; frame-rate independent, never steps */
const approach = (cur, tgt, tau, dt) => cur + (tgt - cur) * (1 - Math.exp(-dt / Math.max(tau, 1e-4)));

/* -------------------------------------------------------------------------- */

export class Weather {
  static id = 'weather';

  constructor(ctx) {
    this.ctx = ctx;
    this.rand = rng((ctx.seed ^ 0x9e3779b9) >>> 0);

    /** Current *target* state name. */
    this.state = 'fair';
    this.previousState = 'fair';
    /** Seconds spent in the current state. */
    this.stateTime = 0;
    this.stateDuration = 420;
    /** 0..1 how intense this particular episode is. */
    this.severity = 0.6;

    /** Live, continuously interpolated profile. */
    this.cur = Object.assign({}, PROFILES.fair);
    this.cur.tint = PROFILES.fair.tint.slice();
    this.cur.haze = PROFILES.fair.haze.slice();
    this.target = PROFILES.fair;

    /* persistent surface state */
    this.wetness = 0;
    this.puddles = 0;
    this.snowCover = 0;
    this.temperature = 18;

    /* wind */
    this.windAngle = 0.7;
    this.windSpeed = 3;
    this.gust = 0;
    this.gustNorm = 0;
    this._windT = 0;
    /** Metres the gust front has travelled downwind. */
    this.windPhase = 0;
    /** Metres between gust crests — a gust front is ~60-160 m of moving air. */
    this.windWaveLength = 120;

    /* lightning */
    this._flashes = [];
    this._nextStrike = 6;
    this._scripted = -1;
    this.lightningPosition = new THREE.Vector3(0, 1400, -900);
    this._boltDir = new THREE.Vector3(1, 0, 0);

    this._t = 0;
    this._c0 = new THREE.Color();
    this._c1 = new THREE.Color();
    this._c2 = new THREE.Color();
    this._c3 = new THREE.Color();
    this._ambTarget = new THREE.Color(0.35, 0.45, 0.6);
    this._fogTarget = new THREE.Color(0.62, 0.68, 0.78);
    this._started = false;
  }

  async init() {
    const env = this.ctx.env;
    // additive fields — other systems may read these, see report
    env.cloudType = this.cur.cloudType;
    env.cirrus = this.cur.cirrus;
    env.sunAttenuation = this.cur.sunAtten;
    env.puddleLevel = 0;
    env.temperature = this.temperature;
    env.thunder = 0;
    env.windPhase = 0;
    env.windWaveLength = this.windWaveLength;
    env.windTurb = 0;

    // start on a pleasant fair day and let it evolve from there
    this._setTarget('fair', true);
    this._applyInstant();
    this._started = true;
  }

  /* ---------------------------------------------------------------- public */

  /**
   * Force a weather state.
   * @param {string} name one of clear|fair|overcast|rain|storm|fog|snow|dust
   * @param {{instant?: boolean}} [opts] instant skips the transition entirely
   */
  setWeather(name, opts = {}) {
    if (!PROFILES[name]) return false;
    this._setTarget(name, false);
    if (opts.instant) {
      /*
       * DETERMINISM (CONTRACTS §1.4). `_setTarget` draws severity off the RNG
       * STREAM, so how hard it is raining depends on how many state changes
       * have happened since boot — i.e. on which shots ran before this one.
       * storm_plains measured severity 0.94 captured on its own and 0.61 as
       * the sixth shot of the set, and those are visibly different frames.
       * An instant set is the harness pinning a scene, so pin the severity to
       * the state as well.
       */
      let h = 0;
      for (let i = 0; i < name.length; i++) h = (h * 131 + name.charCodeAt(i)) >>> 0;
      this.severity = 0.42 + ((h % 1024) / 1024) * 0.50;
      this._applyInstant();
    }
    return true;
  }

  /** @returns {{name:string, severity:number, elapsed:number, duration:number}} */
  getState() {
    return {
      name: this.state,
      severity: this.severity,
      elapsed: this.stateTime,
      duration: this.stateDuration,
    };
  }

  /** Names Weather knows how to be. */
  get states() { return Object.keys(PROFILES); }

  /**
   * The 0..1 gust envelope at a world position, right now. Sampling this in
   * vegetation / cloth / dust makes a gust read as one physical front sweeping
   * across the landscape instead of every blade of grass having its own idea.
   * Shader-side equivalent (cheap, no CPU call):
   *
   *   float s = dot(worldPos.xz, uWindDir) - uWindPhase;
   *   float g = 0.5 + 0.5 * sin(s * 6.2831 / uWindWave);
   *   gust = uWindGust * (0.45 + 0.55 * g * g);
   */
  gustAt(x, z) {
    const env = this.ctx.env;
    const wv = env.windVector;
    const l = Math.hypot(wv.x, wv.z) || 1;
    const s = (x * wv.x + z * wv.z) / l - this.windPhase;
    const g = 0.5 + 0.5 * Math.sin((s * Math.PI * 2) / this.windWaveLength);
    return clamp01(this.gustNorm * (0.45 + 0.55 * g * g));
  }

  /* --------------------------------------------------------------- internal */

  _setTarget(name, silent) {
    const prev = this.state;
    this.previousState = prev;
    this.state = name;
    this.target = PROFILES[name];
    this.stateTime = 0;
    const d = this.target.dur;
    this.stateDuration = lerp(d[0], d[1], this.rand());
    // a light shower and a wall of water are the same state, different severity
    this.severity = 0.35 + this.rand() * 0.65;
    this._nextStrike = 2 + this.rand() * 6;
    if (!silent && this.ctx.emit) {
      this.ctx.emit('weatherChange', { from: prev, to: name, severity: this.severity });
    }
  }

  /** Snap every interpolated quantity to the target — used by the capture harness. */
  _applyInstant() {
    const p = this.target;
    const s = 0.55 + this.severity * 0.75;
    for (const k of NUMERIC_KEYS) this.cur[k] = p[k];
    this.cur.tint = p.tint.slice();
    this.cur.haze = p.haze.slice();
    // persistent after-effects should already look "lived in"
    this.wetness = clamp01(p.rain * 1.05 * s);
    this.puddles = clamp01(p.rain * 0.85 * s);
    this.snowCover = p.snow > 0 ? clamp01(0.35 + p.snow * 0.5) : 0;
    this.windSpeed = p.wind * s;
    this.gustNorm = 0.25;
    this.gust = 0.25 * p.gust;
    this._flashes.length = 0;
    if (this.ctx.env) this.ctx.env.lightningFlash = 0;
    this.windPhase = 0;
    /* A storm that only flashes when the dice say so is a storm that is
     * invisible in a 2.5 s screenshot. An instant apply (the capture harness,
     * fast travel, a cutscene) schedules the first strike deterministically so
     * the sky is doing something by the time anyone looks at it.
     *
     * Timed to fire ~80 ms before the harness settles (150 frames at 1/60 =
     * 2.5 s) so the drawn channel is still near full brightness while the
     * flash envelope — which floods the ambient and would undo the whole point
     * of a DARK storm — has already dropped most of the way down. */
    this._scripted = p.thunder > 0.5 ? 2.42 : -1;
    this._pushToEnv(1 / 60, true);
  }

  _pickNext() {
    const table = TRANSITIONS[this.state] || TRANSITIONS.fair;
    // temperature gates precipitation type
    const cold = this.temperature < 2.5;
    let total = 0;
    const keys = [];
    const w = [];
    for (const k in table) {
      let wt = table[k];
      if (k === 'snow' && !cold) wt = 0;
      if (k === 'rain' && cold) wt *= 0.25;
      if (k === 'dust' && (this.wetness > 0.25 || this.snowCover > 0.05)) wt *= 0.1;
      if (wt <= 0) continue;
      keys.push(k); w.push(wt); total += wt;
    }
    if (!total) { this._setTarget('fair', false); return; }
    let r = this.rand() * total;
    for (let i = 0; i < keys.length; i++) {
      r -= w[i];
      if (r <= 0) { this._setTarget(keys[i], false); return; }
    }
    this._setTarget(keys[keys.length - 1], false);
  }

  /* ------------------------------------------------------------------ frame */

  update(dt) {
    if (!this._started) return;
    const env = this.ctx.env;
    dt = Math.min(dt, 0.25);
    this._t += dt;

    /* --- 1. state machine ------------------------------------------------ */
    this.stateTime += dt;
    if (this.stateTime > this.stateDuration) this._pickNext();

    /* --- 2. interpolate the profile, never step -------------------------- */
    const tgt = this.target;
    const sev = 0.55 + this.severity * 0.75; // 0.55 .. 1.30
    for (const k of NUMERIC_KEYS) {
      let v = tgt[k];
      // severity only modulates the "how hard is it happening" fields
      if (k === 'rain' || k === 'snow' || k === 'wind' || k === 'gust' || k === 'thunder') {
        v *= sev;
      } else if (k === 'cloudDensity' || k === 'cloudCover') {
        v = clamp01(v * (0.86 + this.severity * 0.22));
      }
      this.cur[k] = approach(this.cur[k], v, TAU[k], dt);
    }
    for (let i = 0; i < 3; i++) {
      this.cur.tint[i] = approach(this.cur.tint[i], tgt.tint[i], 26, dt);
      this.cur.haze[i] = approach(this.cur.haze[i], tgt.haze[i], 26, dt);
    }

    /* --- 3. temperature -------------------------------------------------- */
    const doy = env.dayOfYear != null ? env.dayOfYear : 172;
    const seasonal = -Math.cos(((doy - 10) / 365) * Math.PI * 2); // -1 mid-winter .. 1 mid-summer
    const tod = env.timeOfDay != null ? env.timeOfDay : 12;
    const diurnal = Math.sin(((tod - 9.5) / 24) * Math.PI * 2);
    const tTarget =
      14.5 + seasonal * 13.0 + diurnal * 7.0
      - this.cur.grey * 4.0 - this.cur.rain * 3.5 - this.cur.wind * 0.12;
    this.temperature = approach(this.temperature, tTarget, 90, dt);

    /* --- 4. wind: drifting base direction + layered gust envelope -------- */
    this._windT += dt;
    // base direction drifts slowly; gusts veer it a few degrees
    const drift = (fbm1(this._windT * 0.0075, 3) - 0.5) * 2.0;
    this.windAngle += drift * 0.035 * dt + 0.004 * dt;
    const gRaw =
      fbm1(this._windT * 0.115, 11) * 0.52 +
      fbm1(this._windT * 0.37, 23) * 0.30 +
      fbm1(this._windT * 0.94, 41) * 0.18;
    // shape it so calm is common and gusts are punchy
    let g = clamp01((gRaw - 0.30) / 0.55);
    g = g * g * (3 - 2 * g);
    // gustNorm is the 0..1 envelope everyone reads; `gust` is the amount of it
    // this weather state actually delivers. Both are low-passed, so neither can
    // step even when the state profile is changing underneath them.
    this.gustNorm = approach(this.gustNorm, g, 0.55, dt);
    this.gust = this.gustNorm * this.cur.gust;
    const gustGain = 1 + this.gust * 1.15;
    this.windSpeed = approach(this.windSpeed, this.cur.wind * gustGain, 1.4, dt);
    const veer = (fbm1(this._windT * 0.21, 57) - 0.5) * 0.55 * this.cur.gust;
    const a = this.windAngle + veer;
    /* The gust front travels downwind a little faster than the mean flow —
     * this is the scalar that lets every system reconstruct the SAME moving
     * gust, so a squall visibly crosses the plain. */
    this.windPhase += this.windSpeed * 1.35 * dt;
    this.windWaveLength = 55 + this.windSpeed * 8.5;

    /* --- 5. wetness / puddles / snow ------------------------------------- */
    const rain = this.cur.rain;
    const snowFall = this.cur.snow;
    /* Water is a ratchet: rain only ever ADDS it, and the only way it leaves
     * again is evaporation. Letting wetness chase the falling rain target would
     * dry the ground the instant a shower eased off, which is the single most
     * common way a weather system gives itself away.
     * ~7 min to shed surface wetness in full sun and much longer in shade;
     * puddles then linger for the best part of an hour after that. */
    const dry = 0.00055 + (env.daylight || 0) * 0.00165 + this.windSpeed * 0.00012;
    const damp = rain > 0.015 ? 0.12 : 1.0;   // barely evaporates while raining
    const wTgt = clamp01(rain * 1.25);
    if (wTgt > this.wetness) this.wetness = approach(this.wetness, wTgt, 22, dt);
    else this.wetness *= Math.exp(-dry * damp * dt);
    const pTgt = clamp01((rain - 0.18) * 1.5);
    if (pTgt > this.puddles) this.puddles = approach(this.puddles, pTgt, 95, dt);
    else this.puddles *= Math.exp(-dry * 0.30 * damp * dt);
    if (this.wetness < 1e-4) this.wetness = 0;
    if (this.puddles < 1e-4) this.puddles = 0;
    if (snowFall > 0.01) {
      this.snowCover = clamp01(this.snowCover + snowFall * 0.011 * dt);
    } else {
      const melt = Math.max(0, this.temperature - 0.5) * 0.00042 + (env.daylight || 0) * 0.00028;
      this.snowCover = Math.max(0, this.snowCover - melt * dt);
    }
    // fresh snow on the ground counts as "wet" once it melts off
    if (this.snowCover > 0 && this.temperature > 1.5) {
      this.wetness = Math.max(this.wetness, Math.min(0.4, this.snowCover * 0.5));
    }

    /* --- 6. lightning ---------------------------------------------------- */
    this._updateLightning(dt);

    /* --- 7. publish ------------------------------------------------------ */
    this._pushToEnv(dt, false, a);
  }

  _updateLightning(dt) {
    const env = this.ctx.env;
    const storm = Math.max(0, (this.cur.thunder - 0.08) / 0.92);

    if (this._scripted > 0) {
      this._scripted -= dt;
      if (this._scripted <= 0) {
        this._scripted = -1;
        /* Far enough out that the flash cannot flood the frame (amp falls off
         * with distance) but close enough that the channel is several pixels
         * wide, and bearing-relative to the CAMERA so it is actually in shot —
         * anchoring on the player put pass 2's scripted bolt off-screen. */
        this._strike(1.0, 5200, -0.34, true);
        this._nextStrike = 3.0 + this.rand() * 5.0;
      }
    } else if (storm > 0.02) {
      this._nextStrike -= dt * (0.30 + storm * 0.95);
      if (this._nextStrike <= 0) {
        this._nextStrike = 2.6 + this.rand() * (18.0 - storm * 11.0);
        this._strike(storm);
      }
    }

    // envelope: fast rise, exponential fall, with a little sub-flicker
    let f = 0;
    for (let i = this._flashes.length - 1; i >= 0; i--) {
      const fl = this._flashes[i];
      fl.age += dt;
      if (fl.age < fl.delay) continue;
      const a = fl.age - fl.delay;
      if (a > fl.life) { this._flashes.splice(i, 1); continue; }
      let e;
      if (a < fl.rise) e = a / fl.rise;
      else e = Math.exp(-(a - fl.rise) / fl.decay);
      // sub-strokes flicker the tail
      e *= 0.72 + 0.28 * Math.abs(Math.sin(a * 74.0 + fl.phase));
      f += fl.amp * e;
    }
    /*
     * SHAPE THE ENVELOPE ONCE, HERE.
     *
     * Six systems read env.lightningFlash and every one of them treats it as a
     * linear "brighten everything by this much": Sky adds it to the aerial
     * inscatter of EVERY fragment, Clouds injects it into the cloud interior,
     * Particles adds it to the rain's key colour, Weather lifts the ambient and
     * tints the fog. _applyInstant deliberately schedules the opening strike at
     * t = 2.42 s so a bolt is on screen when the capture harness settles at
     * 2.5 s — which meant every storm_plains capture was taken while the tail
     * still read 0.104, and those six linear terms together lifted the frame's
     * 0.1st-percentile luma from 18 to 55. That is the white-out.
     *
     * Squaring leaves a full-brightness strike untouched (1^2 = 1) and collapses
     * the tail, which is also closer to how a real return stroke decays.
     */
    const fl = clamp01(f);
    env.lightningFlash = fl * fl;
  }

  /**
   * @param {number} storm severity 0..1
   * @param {number|null} forcedDist metres
   * @param {number|null} forcedAng bearing, radians
   * @param {boolean} fromCamera anchor on the camera and treat forcedAng as an
   *        offset from its forward bearing, so a scripted bolt lands in frame
   */
  _strike(storm, forcedDist = null, forcedAng = null, fromCamera = false) {
    const r = this.rand;
    const cam = this.ctx.camera;
    const p = fromCamera && cam
      ? cam.position
      : (this.ctx.player ? this.ctx.player.position : { x: 0, y: 0, z: 0 });
    let ang = forcedAng != null ? forcedAng : r() * Math.PI * 2;
    if (fromCamera && cam) {
      const e = cam.matrixWorld.elements;   // forward = -column 2
      ang += Math.atan2(-e[10], -e[8]);
    }
    const dist = forcedDist != null ? forcedDist : 260 + r() * 4200;
    this.lightningPosition.set(
      p.x + Math.cos(ang) * dist,
      1150 + r() * 1400,
      p.z + Math.sin(ang) * dist,
    );
    const base = 0.55 + storm * 0.45;
    const near = 1 - Math.min(1, dist / 4600);
    const amp = base * (0.45 + near * 0.75);

    // main stroke
    this._flashes.push({
      age: 0, delay: 0, rise: 0.010 + r() * 0.008, decay: 0.045 + r() * 0.05,
      life: 0.42, amp, phase: r() * 6.28,
    });
    // ~55% of strikes are multi-stroke
    const roll = r();
    if (roll < 0.55) {
      this._flashes.push({
        age: 0, delay: 0.055 + r() * 0.10, rise: 0.008, decay: 0.038 + r() * 0.04,
        life: 0.36, amp: amp * (0.4 + r() * 0.5), phase: r() * 6.28,
      });
    }
    if (roll < 0.16) {
      this._flashes.push({
        age: 0, delay: 0.17 + r() * 0.12, rise: 0.007, decay: 0.03,
        life: 0.3, amp: amp * (0.25 + r() * 0.35), phase: r() * 6.28,
      });
    }

    /* Draw the channel itself. A flash with no visible bolt reads as a bug. */
    const clouds = this.ctx.get('clouds');
    if (clouds && typeof clouds.strike === 'function') {
      try {
        clouds.strike(this.lightningPosition, Math.min(1.3, amp * 1.5),
          0.26 + r() * 0.16);
      } catch (e) { /* clouds not up yet */ }
    }

    if (this.ctx.emit) {
      this.ctx.emit('lightning', {
        position: this.lightningPosition.clone(),
        distance: dist,
        intensity: amp,
        // convenience for Audio: thunder arrives this many seconds later
        delay: dist / 340,
      });
    }
  }

  /** Write the interpolated state into ctx.env. */
  _pushToEnv(dt, instant, windAngle) {
    const env = this.ctx.env;
    const c = this.cur;
    const day = env.daylight != null ? env.daylight : 1;
    const tw = Math.abs(env.twilight != null ? env.twilight : 0);

    /* ---- ambient colour: sky-derived, then greyed out by the weather ----
     * Sky now runs a real Rayleigh/Mie scattering integral, so the honest
     * source for the ambient HUE is its own hemispherical irradiance. We take
     * the chromaticity from Sky and keep our own intensity curve (Sky's is in
     * physical units and would fight the exposure). Hand-authored keyframes
     * are only the fallback for a boot frame where Sky is not up yet. */
    const amb = this._c0;
    const sky = this.ctx.get('sky');
    let skyChroma = false;
    if (sky && typeof sky.getSkyIrradiance === 'function') {
      const irr = sky.getSkyIrradiance();
      if (irr && irr.color) {
        const m = Math.max(irr.color.r, irr.color.g, irr.color.b);
        if (m > 1e-6 && isFinite(m)) {
          amb.setRGB(irr.color.r / m, irr.color.g / m, irr.color.b / m);
          // keep the overall level in the same range the keyframes produced
          amb.multiplyScalar(0.72);
          skyChroma = true;
        }
      }
    }
    if (!skyChroma) {
      amb.setRGB(0.020, 0.030, 0.055);                            // night sky
      this._c1.setRGB(0.34, 0.46, 0.70);                          // clear day sky
      amb.lerp(this._c1, day);
      this._c1.setRGB(0.46, 0.29, 0.26);                          // twilight
      amb.lerp(this._c1, tw * 0.5 * (1 - day * 0.25));
    }
    // overcast/dust/fog decks override the hue and flatten it
    this._c1.setRGB(c.tint[0], c.tint[1], c.tint[2]).multiplyScalar(0.16 + 0.84 * day);
    amb.lerp(this._c1, c.grey);
    /* Lightning briefly floods everything with cold white. Deliberately much
     * weaker than pass 2 (0.9 -> 0.5 on the hue, 1.8 -> 0.75 on the level):
     * the flash was strong enough to lift the whole storm frame out of the
     * dark, which is the opposite of what a storm should look like. A bolt
     * should read as a hard rim on the cloud and a cold kick, not as daylight. */
    if (env.lightningFlash > 0.001) {
      this._c1.setRGB(0.62, 0.68, 0.86);
      amb.lerp(this._c1, Math.min(0.55, env.lightningFlash * 0.5));
    }
    this._ambTarget.copy(amb);

    let ambI = (0.036 + 0.60 * day) * c.ambient + (env.moonIntensity || 0) * 0.055;
    ambI += env.lightningFlash * 0.75;

    /* ---- fog colour: the actual horizon, then greyed by the weather -----
     * Same argument as the ambient: PostFX lights its mist medium with this,
     * and a hand-authored orange twilight ramp was turning a cold blue dawn
     * into a warm yellow wash that flatly contradicted the sky above it. Take
     * the chromaticity from Sky's scattering integral in the view direction. */
    const fog = this._c2;
    let fogChroma = false;
    if (sky && typeof sky.getFogColor === 'function') {
      try {
        sky.getFogColor(null, this._c3);
        const m = Math.max(this._c3.r, this._c3.g, this._c3.b);
        if (m > 1e-6 && isFinite(m)) {
          fog.setRGB(this._c3.r / m, this._c3.g / m, this._c3.b / m);
          // horizon haze is bright by day and nearly black at night
          fog.multiplyScalar(0.10 + 0.72 * day + tw * 0.10);
          fogChroma = true;
        }
      } catch (e) { fogChroma = false; }
    }
    if (!fogChroma) {
      fog.setRGB(0.030, 0.040, 0.065);
      this._c1.setRGB(0.62, 0.68, 0.79);
      fog.lerp(this._c1, day);
      this._c1.setRGB(0.78, 0.47, 0.30);
      fog.lerp(this._c1, tw * 0.62);
    }
    this._c1.setRGB(c.haze[0], c.haze[1], c.haze[2]).multiplyScalar(0.13 + 0.87 * day);
    fog.lerp(this._c1, c.grey);
    if (env.lightningFlash > 0.001) {
      this._c1.setRGB(0.70, 0.75, 0.90);
      fog.lerp(this._c1, Math.min(0.5, env.lightningFlash * 0.45));
    }
    this._fogTarget.copy(fog);

    /* ---- ground mist: radiation fog wants a calm, damp dawn ------------
     * The ground has been radiating heat all night, the air just above it
     * hits the dew point around first light, and it needs calm air to
     * survive. Peaks a little after sunrise and burns off fast.
     *
     * RAIN SCAVENGING (pass-3 regression fix). Falling drops sweep fog
     * droplets out of the air, and the mixing under a convective cell is
     * violent — you do not get a fog bank in a thunderstorm, you get one the
     * morning after. Everything below is therefore scavenged by the rain rate:
     * without it a driving rainstorm published a groundMist of 0.08, PostFX's
     * sqrt() response turned that into a saturated fog lake with 300 m of
     * visibility, and the whole plain whited out. */
    const tod = env.timeOfDay != null ? env.timeOfDay : 12;
    const dawnBump = Math.exp(-Math.pow((tod - 6.35) / 1.65, 2));
    const calm = clamp01(1 - this.windSpeed / 8.0);
    const scavenge = clamp01(1 - c.rain * 2.2);
    /* Deliberately modest. PostFX runs its own ground-mist medium off this
     * same field with a sqrt() response (0.17 -> 0.41), and Sky now runs a
     * proper distance-integrated mist LAKE off it as well. Two consumers with
     * a hot response curve means the published number has to be small or the
     * two veils stack into a wall — which is what dawn_mist_valley was. */
    const mist = clamp01(
      (c.groundMist + dawnBump * calm * (0.19 + this.wetness * 0.22)
        + this.wetness * 0.04) * scavenge,
    );

    /* ---- commit -------------------------------------------------------- */
    const k = instant ? 1 : 1 - Math.exp(-dt / 3.5); // final safety smoothing
    env.ambientColor.lerp(this._ambTarget, k);
    env.ambientIntensity = instant ? ambI : approach(env.ambientIntensity, ambI, 3.5, dt);
    env.fogColor.lerp(this._fogTarget, k);

    env.turbidity = c.turbidity;
    env.fogDensity = c.fogDensity * (1 + this.wetness * 0.18);
    env.groundMist = instant ? mist : approach(env.groundMist, mist, 6, dt);
    env.cloudCover = clamp01(c.cloudCover);
    env.cloudDensity = clamp01(c.cloudDensity);
    env.rainIntensity = clamp01(c.rain);
    env.snowIntensity = clamp01(c.snow);
    env.wetness = clamp01(this.wetness);
    env.snowCover = clamp01(this.snowCover);
    env.weatherName = this.state;

    // additive fields
    env.cloudType = clamp01(c.cloudType);
    env.cirrus = clamp01(c.cirrus);
    env.sunAttenuation = clamp01(c.sunAtten);
    env.puddleLevel = clamp01(this.puddles);
    env.temperature = this.temperature;
    env.thunder = clamp01(c.thunder);

    // wind — one coherent field everything else reads
    const a = windAngle != null ? windAngle : this.windAngle;
    env.windStrength = this.windSpeed;
    env.windVector.set(Math.cos(a) * this.windSpeed, 0, Math.sin(a) * this.windSpeed);
    env.windGust = clamp01(this.gustNorm);
    // additive: lets any system reconstruct the same travelling gust front
    env.windPhase = this.windPhase;
    env.windWaveLength = this.windWaveLength;
    env.windTurb = clamp01(this.cur.gust * 0.8 + this.gustNorm * 0.3);
  }

  dispose() {
    this._flashes.length = 0;
  }
}
