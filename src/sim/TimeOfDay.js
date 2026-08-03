import * as THREE from 'three';
import { WORLD } from '../core/Config.js';
import {
  ATMO, transmittanceToSpace, refractionDeg, turbidityToMie,
} from '../render/sky/Atmosphere.js';

/**
 * RED SANDS — TimeOfDay
 * ============================================================================
 * Real solar and lunar ephemeris driving every light in the world.
 *
 * SUN
 *   NOAA solar-position algorithm: fractional-year -> equation of time +
 *   declination -> hour angle -> altitude/azimuth for WORLD.latitude. The sun
 *   rises in the east, transits due south (northern hemisphere) and sets in the
 *   west, with the arc height changing correctly across the year.
 *
 * SUN COLOUR
 *   Never keyframed. `env.sunColor` is the *normalised spectral transmittance*
 *   of the real slant path through the Rayleigh + Mie + ozone atmosphere at the
 *   sun's actual altitude, and `env.sunIntensity` is the magnitude of that same
 *   transmittance. So `sunIntensity * sunColor == peak * T(path)` exactly:
 *   deep red-orange on the horizon, amber at golden hour, neutral at zenith,
 *   and it responds to `env.turbidity` for free.
 *
 * MOON
 *   Synodic phase (29.53 d) sets the elongation from the sun, which sets both
 *   the moon's hour angle and the terminator Sky draws — they cannot disagree.
 *   Ecliptic latitude wobbles on the 27.21 d draconic period so the moon's arc
 *   is not a mirror of the sun's. Moonlight is cold and dim and extinguished by
 *   the same atmosphere.
 *
 * WORLD AXES: +X east, -Z north, +Y up.
 * ============================================================================
 */

const DEG = Math.PI / 180;
const SYNODIC_DAYS = 29.530588853;
const DRACONIC_DAYS = 27.212220817;
const EARTH_TILT = 23.4397 * DEG;
const MOON_INCLINATION = 5.145 * DEG;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const frac = (v) => v - Math.floor(v);

export class TimeOfDay {
  static id = 'timeOfDay';

  constructor(ctx) {
    this.ctx = ctx;

    /** Degrees. */
    this.latitude = WORLD.latitude;
    /**
     * Late summer in the high desert — the sun angles at the canonical shot
     * times (18.15 h, 6.1 h) land in real golden hour instead of the flat
     * midsummer arc a solstice date would give at this latitude.
     */
    this.dayOfYear = 243;

    /** Real seconds per in-game day. */
    this.dayLengthSeconds = 1800;
    this.paused = false;

    /** Peak solar irradiance multiplier at zenith, engine units. */
    this.sunPeak = 6.4;
    /** Full-moon irradiance multiplier. Not physical (that would be ~1e-5);
     *  this is film/eye-adapted so night reads as night, not as black. */
    this.moonPeak = 0.5;

    /** Phase of the synodic month at dayOfYear 0. Tuned so the canonical night
     *  shot (1.6 h) gets a waning gibbous low in the east — in frame, showing
     *  its terminator, and backlighting the ridges. */
    this.lunarEpochDay = 12.6;
    this.nodeEpochDay = 4.0;

    // read-only diagnostics
    this.sunAltitude = 0;
    this.sunAzimuth = 0;
    this.moonAltitude = 0;
    this.moonAzimuth = 0;
    this.moonIllumination = 0;
    this.siderealTimeRad = 0;

    this._lastHour = -1;
    this._t = [0, 0, 0];
    this._sunDir = new THREE.Vector3();
    this._moonDir = new THREE.Vector3();

    // The capture harness renders a fixed number of frames after setupShot();
    // freezing the clock makes every screenshot bit-reproducible.
    try {
      if (typeof location !== 'undefined'
        && new URLSearchParams(location.search).get('capture') === '1') {
        this.paused = true;
      }
    } catch (e) { /* non-browser */ }
  }

  async init() {
    const env = this.ctx.env;
    env.dayOfYear = this.dayOfYear;
    this._apply(env.timeOfDay, true);
    this._lastHour = Math.floor(env.timeOfDay);
  }

  /* ------------------------------------------------------------- public */

  /** Set the clock instantly (no interpolation). Used by the shot harness. */
  setTime(hours) {
    if (!Number.isFinite(hours)) return;
    const h = ((hours % 24) + 24) % 24;
    this._apply(h, true);
    this._lastHour = Math.floor(h);
  }

  /** Set the calendar day (0..365); changes declination and the moon phase. */
  setDayOfYear(day) {
    this.dayOfYear = ((day % 365.25) + 365.25) % 365.25;
    this.ctx.env.dayOfYear = this.dayOfYear;
    this._apply(this.ctx.env.timeOfDay, true);
  }

  /** Real seconds for a full 24 h cycle. Pass 0 or Infinity to freeze. */
  setDayLength(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) { this.paused = true; return; }
    this.dayLengthSeconds = seconds;
    this.paused = false;
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  /** Hours until the next sunrise/sunset boundary — handy for AI schedules. */
  getSolarEvents(day = this.dayOfYear) {
    const { decl } = this._solar(day, 12);
    const lat = this.latitude * DEG;
    const c = -Math.tan(lat) * Math.tan(decl);
    if (c >= 1) return { sunrise: null, sunset: null, polar: 'night' };
    if (c <= -1) return { sunrise: null, sunset: null, polar: 'day' };
    const h0 = Math.acos(c) / DEG / 15;
    return { sunrise: 12 - h0, sunset: 12 + h0, polar: null };
  }

  /* -------------------------------------------------------------- solar */

  _solar(dayOfYear, hours) {
    const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + (hours - 12) / 24);
    const g2 = gamma * 2, g3 = gamma * 3;
    const eqMin = 229.18 * (0.000075
      + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
      - 0.014615 * Math.cos(g2) - 0.040849 * Math.sin(g2));
    const decl = 0.006918
      - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
      - 0.006758 * Math.cos(g2) + 0.000907 * Math.sin(g2)
      - 0.002697 * Math.cos(g3) + 0.00148 * Math.sin(g3);
    const H = (hours + eqMin / 60 - 12) * 15 * DEG;
    return { decl, H, eqMin };
  }

  /** Equatorial (decl, hourAngle) -> world direction + altitude/azimuth. */
  _horizon(decl, H, target) {
    const lat = this.latitude * DEG;
    const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
    const sinD = Math.sin(decl), cosD = Math.cos(decl);
    const sinAlt = clamp(sinLat * sinD + cosLat * cosD * Math.cos(H), -1, 1);
    const alt = Math.asin(sinAlt);
    const cosAlt = Math.cos(alt);
    let az;
    if (cosAlt < 1e-5 || cosLat < 1e-5) {
      az = Math.PI;
    } else {
      az = Math.acos(clamp((sinD - sinAlt * sinLat) / (cosAlt * cosLat), -1, 1));
      if (H > 0) az = 2 * Math.PI - az;
    }
    // +X east, -Z north
    target.set(Math.sin(az) * cosAlt, sinAlt, -Math.cos(az) * cosAlt).normalize();
    return { alt, az };
  }

  /* --------------------------------------------------------------- lunar */

  _lunar(dayOfYear, hours, sun) {
    const t = dayOfYear + hours / 24;
    const phase = frac((t - this.lunarEpochDay) / SYNODIC_DAYS); // 0 = new
    const elong = phase * 2 * Math.PI;                            // east of sun

    // sun's ecliptic longitude (vernal equinox near day 79.5)
    const lamS = 2 * Math.PI * frac((dayOfYear - 79.5) / 365.2422);
    const lamM = lamS + elong;

    // ecliptic latitude from the 5.145 deg orbital inclination
    const argLat = 2 * Math.PI * frac((t - this.nodeEpochDay) / DRACONIC_DAYS);
    const beta = MOON_INCLINATION * Math.sin(argLat);

    // ecliptic -> equatorial
    const sinDec = clamp(
      Math.sin(beta) * Math.cos(EARTH_TILT)
      + Math.cos(beta) * Math.sin(EARTH_TILT) * Math.sin(lamM), -1, 1);
    const decl = Math.asin(sinDec);

    // hour angle: the moon trails the sun by its elongation
    let H = sun.H - elong;
    H = ((H + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

    return { decl, H, phase, illum: (1 - Math.cos(elong)) * 0.5 };
  }

  /* ------------------------------------------------------------- driving */

  _apply(hours, force) {
    const ctx = this.ctx;
    const env = ctx.env;
    env.timeOfDay = hours;
    env.dayOfYear = this.dayOfYear;

    const mieMul = turbidityToMie(env.turbidity);

    /* ---- sun ---- */
    const sun = this._solar(this.dayOfYear, hours);
    const s = this._horizon(sun.decl, sun.H, this._sunDir);
    this.sunAltitude = s.alt / DEG;
    this.sunAzimuth = s.az / DEG;
    env.sunDirection.copy(this._sunDir);

    // apparent altitude includes refraction: the sun is visible for ~2.5 more
    // minutes than geometry alone allows, and that is where the reddest light
    // of the day lives.
    const appAltDeg = this.sunAltitude + refractionDeg(this.sunAltitude);
    const muSun = Math.sin(Math.max(appAltDeg, 0.02) * DEG);
    const T = transmittanceToSpace(0.02, muSun, mieMul, 48, this._t);

    const peakT = Math.max(T[0], T[1], T[2], 1e-5);
    // normalised hue: preserves the physical ratio because intensity carries
    // the magnitude — sunIntensity * sunColor === sunPeak * T.
    env.sunColor.setRGB(T[0] / peakT, T[1] / peakT, T[2] / peakT);

    // fade the last degree so the key light dies smoothly at the horizon
    const setFade = clamp((appAltDeg + 0.85) / 1.6, 0, 1);
    env.sunIntensity = this.sunPeak * peakT * setFade * setFade;

    /* ---- moon ---- */
    const moon = this._lunar(this.dayOfYear, hours, sun);
    const m = this._horizon(moon.decl, moon.H, this._moonDir);
    this.moonAltitude = m.alt / DEG;
    this.moonAzimuth = m.az / DEG;
    this.moonIllumination = moon.illum;
    env.moonDirection.copy(this._moonDir);
    env.moonPhase = moon.phase;

    const mAppAlt = this.moonAltitude + refractionDeg(this.moonAltitude);
    const muMoon = Math.sin(Math.max(mAppAlt, 0.02) * DEG);
    const Tm = transmittanceToSpace(0.02, muMoon, mieMul, 24, this._t);
    const mFade = clamp((mAppAlt + 0.85) / 2.2, 0, 1);
    // Moonlight is sunlight off a dark grey rock: slightly warm at source, but
    // it reads cold because the eye is scotopic. Author it cold.
    const mLum = Math.max(Tm[0], Tm[1], Tm[2], 0);
    // brightness surges near full moon (opposition effect)
    const opp = Math.pow(moon.illum, 1.15) * (1 + 0.30 * Math.pow(moon.illum, 10));
    env.moonColor.setRGB(0.58, 0.72, 1.0);
    env.moonIntensity = this.moonPeak * opp * mLum * mFade;

    /* ---- daylight / twilight ---- */
    const a = this.sunAltitude;
    env.daylight = clamp((a + 4.2) / 12.0, 0, 1);
    env.daylight *= env.daylight * (3 - 2 * env.daylight);

    // magnitude peaks right at the horizon and dies by the end of nautical
    // twilight; sign is negative before solar noon (dawn), positive after.
    const tw = Math.exp(-Math.pow((a + 1.5) / 6.2, 2));
    env.twilight = (sun.H < 0 ? -1 : 1) * clamp(tw, 0, 1);

    /* ---- sidereal time for the star field ---- */
    // 366.2422 sidereal rotations per 365.2422 solar days
    this.siderealTimeRad = 2 * Math.PI * frac(
      (this.dayOfYear * 1.0027379 + hours / 24 * 1.0027379) + 0.278,
    );

    if (!force) {
      const h = Math.floor(hours);
      if (h !== this._lastHour) {
        this._lastHour = h;
        ctx.emit('hourChange', { hour: h, timeOfDay: hours, dayOfYear: this.dayOfYear });
      }
    }
  }

  update(dt) {
    const env = this.ctx.env;
    let h = env.timeOfDay;
    if (!this.paused && dt > 0) {
      h += (dt / this.dayLengthSeconds) * 24;
      if (h >= 24) {
        h -= 24;
        this.dayOfYear = (this.dayOfYear + 1) % 365.25;
        this._lastHour = -1;
      }
    }
    this._apply(h, false);
  }

  dispose() {}
}

/** Exposed for tools/tests: the atmosphere the sun colour is derived from. */
TimeOfDay.ATMO = ATMO;
