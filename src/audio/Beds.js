import { filter, loopSource, glide } from './Voices.js';
import { rng } from '../core/Context.js';

/**
 * Ambient beds.
 *
 * Each bed is a small permanent graph built once at init: a handful of looping
 * noise sources through filters, plus (optionally) a stochastic scheduler that
 * drops one-shots into the future. Beds are never rebuilt and never torn down —
 * only their output gain and filter parameters move — which is what keeps the
 * node count flat over a long session.
 *
 * `weight` is the crossfade level the Audio system drives (0..1). `tune()`
 * shapes the character from ctx.env; `schedule()` places one-shots in the
 * lookahead window.
 */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class Bed {
  /**
   * `trim` is the bed's calibrated level, measured through the whole output
   * chain by src/audio/_dev/mix.html and applied on top of `weight`. It exists
   * because `weight` is a dramatic control the Audio system drives from the
   * world (how close the river is, how hard it is raining) and must be free to
   * reach 1.0; the trim is the mix decision underneath it. They were the same
   * number before, which is how the wind ended up 14 dB louder than a gunshot.
   */
  constructor(A, name, {
    positional = false, send = 0.18, ref = 10, rolloff = 1.2, max = 400, trim = 1,
  } = {}) {
    this.A = A;
    this.name = name;
    this.weight = 0;        // current, smoothed
    this.target = 0;        // requested
    this.manual = null;     // override from ambience(name, w)
    this.send = send;
    this.trim = trim;
    this._nextEvent = 0;
    this.rand = rng((A.ctx.seed ^ hashName(name)) >>> 0);

    const actx = A.actx;
    this.out = actx.createGain();
    this.out.gain.value = 0;
    this.positional = positional;
    if (positional) {
      const p = actx.createPanner();
      p.panningModel = 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = ref;
      p.rolloffFactor = rolloff;
      p.maxDistance = max;
      this.panner = p;
      this.out.connect(p);
      this.output = p;
    } else {
      this.output = this.out;
    }
  }

  setPosition(x, y, z) {
    const p = this.panner;
    if (!p) return;
    const t = this.A.actx.currentTime;
    if (p.positionX) {
      p.positionX.setTargetAtTime(x, t, 0.08);
      p.positionY.setTargetAtTime(y, t, 0.08);
      p.positionZ.setTargetAtTime(z, t, 0.08);
    } else if (p.setPosition) p.setPosition(x, y, z);
  }

  /** Smooth the output gain toward the requested weight. */
  applyWeight(now, tau = 0.5) {
    const w = this.manual != null ? this.manual : this.target;
    this.weight += (w - this.weight) * 0.12;
    if (this.weight < 0.0004 && w < 0.0004) this.weight = 0;
    glide(this.out.gain, this.weight * this.trim, tau, now);
  }

  build() {}
  tune() {}
  schedule() {}
  dispose() {
    try { this.out.disconnect(); } catch (e) { /* noop */ }
    if (this.panner) try { this.panner.disconnect(); } catch (e) { /* noop */ }
    for (const s of this._sources || []) { try { s.stop(); } catch (e) { /* noop */ } }
  }
}

function hashName(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* -------------------------------------------------------------------- wind */

/**
 * Wind. Three layers, all driven from windStrength/windGust:
 *   body   — brown noise under a lowpass, the pressure you feel
 *   hiss   — high band, grass and dust moving past the ear
 *   whistle— a narrow resonant band that only appears in the gusts
 * The internal gust LFO is a smoothed random walk on top of env.windGust so the
 * bed keeps breathing even when the weather system holds a constant value.
 *
 * LEVEL. This bed is on screen every second of the game and its `target` is
 * always 1, so its resting level IS the noise floor of the whole mix — which is
 * why it was the loudest thing in it. Every layer now has a small constant term
 * and a large windStrength term, so calm air is nearly silent and a gale is
 * ~18 dB above it, instead of the old near-flat curve that started loud.
 */
export class WindBed extends Bed {
  constructor(A) { super(A, 'wind', { send: 0.08, trim: 0.36 }); this._g = 0; this._gv = 0; }

  build() {
    const A = this.A, actx = A.actx;
    this._sources = [];
    const mk = (buf, chain, rate) => {
      const s = loopSource(actx, buf, rate, this.rand() * buf.duration);
      this._sources.push(s);
      let n = s;
      for (const f of chain) { n.connect(f); n = f; }
      return n;
    };
    this.bodyLp = filter(actx, 'lowpass', 200, 0.8);
    this.bodyG = actx.createGain(); this.bodyG.gain.value = 0.0;
    mk(A.buf.brown, [this.bodyLp, this.bodyG], 1.0).connect(this.out);

    this.hissHp = filter(actx, 'highpass', 700, 0.6);
    this.hissBp = filter(actx, 'bandpass', 2100, 0.55);
    this.hissG = actx.createGain(); this.hissG.gain.value = 0.0;
    mk(A.buf.white, [this.hissHp, this.hissBp, this.hissG], 1.0).connect(this.out);

    this.whBp = filter(actx, 'bandpass', 620, 6.5);
    this.whG = actx.createGain(); this.whG.gain.value = 0.0;
    mk(A.buf.pink, [this.whBp, this.whG], 1.0).connect(this.out);

    this.moanBp = filter(actx, 'bandpass', 96, 3.0);
    this.moanG = actx.createGain(); this.moanG.gain.value = 0.0;
    mk(A.buf.brown, [this.moanBp, this.moanG], 0.85).connect(this.out);
  }

  tune(dt, env, A) {
    // smoothed random walk: −1..1, ~0.2 Hz
    this._gv += (this.rand() - 0.5) * dt * 4.0;
    this._gv *= Math.exp(-dt * 1.1);
    this._g += this._gv * dt * 2.2;
    this._g = Math.max(-1, Math.min(1, this._g * Math.exp(-dt * 0.25)));

    const s01 = clamp01((env.windStrength - 0.6) / 12.5);
    const gust = clamp01(env.windGust * 0.75 + (this._g * 0.5 + 0.5) * 0.45);
    const now = A.now();
    const shelter = A.shelter;   // 0 open .. 1 enclosed

    glide(this.bodyLp.frequency, 150 + s01 * 260 + gust * 90, 0.4, now);
    glide(this.bodyG.gain, (0.030 + s01 * 0.44) * (0.55 + gust * 0.80) * (1 - shelter * 0.45), 0.5, now);

    glide(this.hissBp.frequency, 1500 + s01 * 2200 + gust * 900, 0.5, now);
    glide(this.hissG.gain, (0.006 + Math.pow(s01, 1.5) * 0.30) * (0.30 + gust * 1.05) * (1 - shelter * 0.7), 0.45, now);

    glide(this.whBp.frequency, 480 + gust * 900 + s01 * 420, 0.7, now);
    glide(this.whG.gain, Math.pow(s01, 2.0) * gust * 0.26 * (1 - shelter * 0.3), 0.6, now);

    glide(this.moanG.gain, Math.pow(s01, 2.2) * (0.20 + gust * 0.6) * 0.48, 0.8, now);
  }
}

/* -------------------------------------------------------------------- rain */

/**
 * Rain.
 *
 * Four layers, because rain is not one noise. From the top: `hiss` is the fine
 * spray, band-limited at BOTH ends — a plain highpass on white noise rises to
 * Nyquist and reads as tape hiss or a cymbal, never as weather, and that was
 * measurably what the first version did (LTAS still climbing at 20 kHz).
 * Real rain peaks in the low kHz and falls above it. `patter` is the population
 * of individual drops hitting the ground, `body` is the mass of it, `rumble`
 * is what you hear from under a porch roof. Intensity opens the top-end
 * bandwidth, so heavy rain is brighter and denser than drizzle rather than the
 * other way round.
 */
export class RainBed extends Bed {
  constructor(A) { super(A, 'rain', { send: 0.22, trim: 0.60 }); this._sq = 0; this._sqv = 0; }

  build() {
    const A = this.A, actx = A.actx;
    this._sources = [];
    const mk = (buf, chain, rate) => {
      const s = loopSource(actx, buf, rate, this.rand() * buf.duration);
      this._sources.push(s);
      let n = s;
      for (const f of chain) { n.connect(f); n = f; }
      return n;
    };
    this.hissHp = filter(actx, 'highpass', 2600, 0.6);
    this.hissLp = filter(actx, 'lowpass', 7000, 0.7);
    this.hissG = actx.createGain(); this.hissG.gain.value = 0;
    mk(A.buf.white, [this.hissHp, this.hissLp, this.hissG], 1.0).connect(this.out);

    this.patterBp = filter(actx, 'bandpass', 1500, 0.55);
    this.patterG = actx.createGain(); this.patterG.gain.value = 0;
    mk(A.buf.white, [this.patterBp, this.patterG], 0.92).connect(this.out);

    this.bodyBp = filter(actx, 'bandpass', 420, 0.6);
    this.bodyG = actx.createGain(); this.bodyG.gain.value = 0;
    mk(A.buf.pink, [this.bodyBp, this.bodyG], 1.0).connect(this.out);

    this.roofLp = filter(actx, 'lowpass', 260, 0.9);
    this.roofG = actx.createGain(); this.roofG.gain.value = 0;
    mk(A.buf.brown, [this.roofLp, this.roofG], 1.0).connect(this.out);
  }

  tune(dt, env, A) {
    const r01 = clamp01(env.rainIntensity);
    const now = A.now();
    const shelter = A.shelter;

    // Squalls: a slow random walk so the rain surges and eases instead of
    // sitting at one level. ~0.05 Hz, ±35 % on the two loudest layers.
    this._sqv += (this.rand() - 0.5) * dt * 2.2;
    this._sqv *= Math.exp(-dt * 0.8);
    this._sq += this._sqv * dt * 1.6;
    this._sq = Math.max(-1, Math.min(1, this._sq * Math.exp(-dt * 0.18)));
    const sq = 1 + this._sq * 0.35;

    // Heavier rain carries further up the spectrum; shelter takes the top off.
    glide(this.hissLp.frequency, (4200 + r01 * 5200) * (1 - shelter * 0.55) * (0.85 + sq * 0.15), 0.8, now);
    glide(this.hissHp.frequency, 2400 + shelter * 900, 0.6, now);
    glide(this.hissG.gain, Math.pow(r01, 0.85) * 0.30 * (1 - shelter * 0.4) * sq, 0.7, now);

    glide(this.patterBp.frequency, 1150 + r01 * 900, 0.8, now);
    glide(this.patterG.gain, Math.pow(r01, 0.7) * 0.42 * (1 - shelter * 0.25) * sq, 0.7, now);

    glide(this.bodyG.gain, Math.pow(r01, 0.9) * 0.34 * (0.75 + sq * 0.25), 0.7, now);
    glide(this.roofG.gain, Math.pow(r01, 1.1) * 0.24 * (0.4 + shelter), 0.7, now);
  }

  schedule(A, from, to, env) {
    const r01 = clamp01(env.rainIntensity);
    if (r01 < 0.04) return;
    const rate = 3 + r01 * 26;                      // discrete drips per second
    if (this._nextEvent < from) this._nextEvent = from;
    while (this._nextEvent < to) {
      const p = A.pointNear(3 + this.rand() * 11, this.rand(), -0.4 + this.rand() * 1.6);
      A.play('drip', {
        at: this._nextEvent, position: p,
        volume: (0.2 + this.rand() * 0.55) * this.weight,
      });
      this._nextEvent += (0.35 + this.rand() * 1.4) / rate;
    }
  }
}

/* ------------------------------------------------------------------- river */

/** Running water: two broad bands plus a slowly wandering burble band. */
export class RiverBed extends Bed {
  constructor(A) { super(A, 'river', { positional: true, send: 0.14, ref: 9, rolloff: 1.35, max: 260, trim: 0.50 }); }

  build() {
    const A = this.A, actx = A.actx;
    this._sources = [];
    const mk = (buf, chain, rate) => {
      const s = loopSource(actx, buf, rate, this.rand() * buf.duration);
      this._sources.push(s);
      let n = s;
      for (const f of chain) { n.connect(f); n = f; }
      return n;
    };
    this.lowBp = filter(actx, 'bandpass', 240, 0.55);
    const lg = actx.createGain(); lg.gain.value = 0.5;
    mk(A.buf.brown, [this.lowBp, lg], 1.0).connect(this.out);

    this.midBp = filter(actx, 'bandpass', 950, 0.7);
    const mg = actx.createGain(); mg.gain.value = 0.55;
    mk(A.buf.pink, [this.midBp, mg], 1.0).connect(this.out);

    this.burbleBp = filter(actx, 'bandpass', 2400, 2.2);
    this.burbleG = actx.createGain(); this.burbleG.gain.value = 0.18;
    mk(A.buf.white, [this.burbleBp, this.burbleG], 1.0).connect(this.out);
    this._ph = 0;
  }

  tune(dt, env, A) {
    this._ph += dt * (0.4 + this.rand() * 0.05);
    const now = A.now();
    const wob = Math.sin(this._ph) * 0.5 + Math.sin(this._ph * 2.37) * 0.3;
    glide(this.burbleBp.frequency, 2300 + wob * 900, 0.35, now);
    glide(this.burbleG.gain, 0.13 + (wob * 0.5 + 0.5) * 0.12, 0.35, now);
  }
}

/* ---------------------------------------------------------------- campfire */

/** Campfire: a low roar with a Poisson rain of pops on top. */
export class FireBed extends Bed {
  constructor(A) { super(A, 'fire', { positional: true, send: 0.1, ref: 2.6, rolloff: 1.9, max: 55, trim: 0.42 }); }

  build() {
    const A = this.A, actx = A.actx;
    this._sources = [];
    const s = loopSource(actx, A.buf.brown, 1.0, this.rand() * A.buf.brown.duration);
    this._sources.push(s);
    this.roarLp = filter(actx, 'lowpass', 380, 1.1);
    this.roarG = actx.createGain(); this.roarG.gain.value = 0.5;
    s.connect(this.roarLp); this.roarLp.connect(this.roarG); this.roarG.connect(this.out);

    const s2 = loopSource(actx, A.buf.white, 1.0, this.rand() * A.buf.white.duration);
    this._sources.push(s2);
    this.airBp = filter(actx, 'bandpass', 1600, 0.7);
    this.airG = actx.createGain(); this.airG.gain.value = 0.05;
    s2.connect(this.airBp); this.airBp.connect(this.airG); this.airG.connect(this.out);
    this._ph = 0;
  }

  tune(dt, env, A) {
    this._ph += dt * 0.9;
    const now = A.now();
    const breathe = Math.sin(this._ph) * 0.5 + Math.sin(this._ph * 1.7 + 1.1) * 0.3;
    const wind = clamp01(env.windStrength / 12);
    glide(this.roarLp.frequency, 320 + breathe * 90 + wind * 160, 0.3, now);
    glide(this.roarG.gain, 0.42 + breathe * 0.12 + wind * 0.12, 0.3, now);
    glide(this.airG.gain, 0.04 + (breathe * 0.5 + 0.5) * 0.05, 0.4, now);
  }

  schedule(A, from, to, env) {
    if (this.weight < 0.02) return;
    if (this._nextEvent < from) this._nextEvent = from;
    const rate = 5 + this.weight * 7;
    while (this._nextEvent < to) {
      const p = this.A.tmp;
      const src = this.panner;
      const px = src && src.positionX ? src.positionX.value : 0;
      const py = src && src.positionY ? src.positionY.value : 0;
      const pz = src && src.positionZ ? src.positionZ.value : 0;
      p.set(px + (this.rand() - 0.5) * 0.7, py + this.rand() * 0.5, pz + (this.rand() - 0.5) * 0.7);
      A.play('crackle', { at: this._nextEvent, position: p, volume: this.weight * 0.9 });
      this._nextEvent += (0.25 + this.rand() * 1.6) / rate;
    }
  }
}

/* ----------------------------------------------------------------- insects */

/**
 * The night field: a soft broadband layer plus scheduled crickets, swapped for
 * cicadas in the heat of the day. Wind and rain suppress it — insects go quiet
 * in bad weather, and the absence is as noticeable as the presence.
 */
export class InsectBed extends Bed {
  constructor(A) { super(A, 'insects', { send: 0.12, trim: 1.5 }); this.mode = 'night'; }

  build() {
    const A = this.A, actx = A.actx;
    this._sources = [];
    const s = loopSource(actx, A.buf.white, 1.0, this.rand() * A.buf.white.duration);
    this._sources.push(s);
    this.fieldBp = filter(actx, 'bandpass', 5200, 1.4);
    this.fieldG = actx.createGain(); this.fieldG.gain.value = 0.05;
    s.connect(this.fieldBp); this.fieldBp.connect(this.fieldG); this.fieldG.connect(this.out);
  }

  tune(dt, env, A) {
    const now = A.now();
    glide(this.fieldG.gain, this.mode === 'night' ? 0.075 : 0.03, 1.2, now);
    glide(this.fieldBp.frequency, this.mode === 'night' ? 5200 : 6400, 1.2, now);
  }

  schedule(A, from, to, env) {
    if (this.weight < 0.03) return;
    if (this._nextEvent < from) this._nextEvent = from;
    const night = this.mode === 'night';
    const rate = night ? (2.2 + this.weight * 5) : (0.35 + this.weight * 0.5);
    while (this._nextEvent < to) {
      const p = A.pointNear(4 + this.rand() * 20, this.rand(), -0.6 + this.rand() * 0.6);
      if (night) A.play('cricket', { at: this._nextEvent, position: p, volume: this.weight * 0.5 });
      else A.play('cicada', { at: this._nextEvent, position: p, volume: this.weight * 0.55 });
      this._nextEvent += (0.4 + this.rand() * 1.6) / rate;
    }
  }
}

/* ------------------------------------------------------------------- birds */

/** Dawn chorus, sparse daytime calls, an owl or a coyote after dark. */
export class BirdBed extends Bed {
  constructor(A) { super(A, 'birds', { send: 0.3 }); this.mode = 'day'; }

  build() { this._sources = []; }

  schedule(A, from, to, env) {
    if (this.weight < 0.03) return;
    if (this._nextEvent < from) this._nextEvent = from;
    const m = this.mode;
    const rate = m === 'dawn' ? 1.5 + this.weight * 2.2
      : m === 'day' ? 0.28
        : m === 'dusk' ? 0.5 : 0.07;
    while (this._nextEvent < to) {
      const far = m === 'night' || this.rand() < 0.4;
      const p = A.pointNear(far ? 40 + this.rand() * 160 : 8 + this.rand() * 40,
        this.rand(), 0.15 + this.rand() * 0.9);
      const w = this.weight;
      if (m === 'night') {
        if (this.rand() < 0.45) A.play('owl', { at: this._nextEvent, position: p, volume: w });
        else A.play('coyote', { at: this._nextEvent, position: p, volume: w * 0.9 });
      } else if (m === 'day' && this.rand() < 0.45) {
        A.play('birdcall', { at: this._nextEvent, position: p, volume: w });
      } else {
        A.play('bird', { at: this._nextEvent, position: p, volume: w });
      }
      this._nextEvent += (0.35 + this.rand() * 1.8) / rate;
    }
  }
}

/* -------------------------------------------------------------------- town */

/**
 * Settlement murmur: three slowly-modulated formant bands read as a crowd at a
 * distance, and the scheduled one-shots (anvil, piano, dog, cart, door) are
 * what actually tell you there are people there.
 */
export class TownBed extends Bed {
  constructor(A) { super(A, 'town', { positional: true, send: 0.26, ref: 26, rolloff: 1.15, max: 500, trim: 0.85 }); }

  build() {
    const A = this.A, actx = A.actx;
    this._sources = [];
    this.layers = [];
    const specs = [[300, 0.9, 0.30], [700, 1.0, 0.22], [1450, 1.2, 0.12]];
    for (let i = 0; i < specs.length; i++) {
      const [f, q, g] = specs[i];
      const s = loopSource(actx, A.buf.pink, 0.85 + i * 0.13, this.rand() * A.buf.pink.duration);
      this._sources.push(s);
      const bp = filter(actx, 'bandpass', f, q);
      const gn = actx.createGain(); gn.gain.value = g;
      s.connect(bp); bp.connect(gn); gn.connect(this.out);
      this.layers.push({ gn, base: g, ph: this.rand() * 6.28, rate: 0.07 + this.rand() * 0.1 });
    }
  }

  tune(dt, env, A) {
    const now = A.now();
    for (const l of this.layers) {
      l.ph += dt * l.rate * 6.283;
      glide(l.gn.gain, l.base * (0.55 + 0.45 * (Math.sin(l.ph) * 0.5 + 0.5)), 0.9, now);
    }
  }

  schedule(A, from, to, env) {
    if (this.weight < 0.05) return;
    if (this._nextEvent < from) this._nextEvent = from;
    const day = clamp01(env.daylight);
    const rate = 0.10 + this.weight * (0.10 + day * 0.22);
    while (this._nextEvent < to) {
      const pn = this.panner;
      const cx = pn && pn.positionX ? pn.positionX.value : 0;
      const cy = pn && pn.positionY ? pn.positionY.value : 0;
      const cz = pn && pn.positionZ ? pn.positionZ.value : 0;
      const p = this.A.tmp.set(
        cx + (this.rand() - 0.5) * 90, cy + 1 + this.rand() * 3, cz + (this.rand() - 0.5) * 90,
      );
      const k = this.rand();
      const w = this.weight;
      if (day > 0.35) {
        if (k < 0.24) A.play('anvil', { at: this._nextEvent, position: p, volume: w });
        else if (k < 0.42) A.play('dog', { at: this._nextEvent, position: p, volume: w });
        else if (k < 0.58) A.play('creak', { at: this._nextEvent, position: p, volume: w });
        else if (k < 0.72) A.play('wagon', { at: this._nextEvent, position: p, volume: w });
        else if (k < 0.88) A.play('piano', { at: this._nextEvent, position: p, volume: w * 0.8 });
        else A.play('clink', { at: this._nextEvent, position: p, volume: w });
      } else {
        if (k < 0.42) A.play('piano', { at: this._nextEvent, position: p, volume: w });
        else if (k < 0.62) A.play('clink', { at: this._nextEvent, position: p, volume: w });
        else if (k < 0.8) A.play('dog', { at: this._nextEvent, position: p, volume: w * 0.7 });
        else A.play('creak', { at: this._nextEvent, position: p, volume: w * 0.8 });
      }
      this._nextEvent += (0.4 + this.rand() * 1.8) / rate;
    }
  }
}

/* -------------------------------------------------------------- underwater */

/** Submerged: pressure rumble plus occasional bubbles. */
export class UnderwaterBed extends Bed {
  constructor(A) { super(A, 'underwater', { send: 0.05, trim: 0.45 }); }

  build() {
    const A = this.A, actx = A.actx;
    this._sources = [];
    const s = loopSource(actx, A.buf.brown, 0.7, this.rand() * A.buf.brown.duration);
    this._sources.push(s);
    const lp = filter(actx, 'lowpass', 300, 1.0);
    const g = actx.createGain(); g.gain.value = 0.55;
    s.connect(lp); lp.connect(g); g.connect(this.out);
  }

  schedule(A, from, to) {
    if (this.weight < 0.1) return;
    if (this._nextEvent < from) this._nextEvent = from;
    while (this._nextEvent < to) {
      A.play('bubble', { at: this._nextEvent, volume: this.weight });
      this._nextEvent += 0.4 + this.rand() * 1.8;
    }
  }
}
