import { filter, envelope } from './Voices.js';

/**
 * Foley — every one-shot in the game, synthesised.
 *
 * House rules for everything in this file:
 *   • one pooled voice per event; the voice's gain is a *static* level and all
 *     envelopes live on inner gains, so pooled automation can never collide;
 *   • every source node is given an explicit stop() at schedule time and is
 *     registered with `v.track()` as a second safety net;
 *   • no node is created that outlives its declared duration.
 *
 * Signature is uniformly `fn(A, o)` where `A` is the Audio system (buffers,
 * context, pool, buses) and `o` carries { at, position, volume, ... }.
 */

/* ------------------------------------------------------------------ helpers */

/**
 * A buffer source that reliably sounds for `dur` seconds of OUTPUT time.
 *
 * The subtlety that bites here: `start(when, offset, duration)` takes its
 * duration in the buffer's own time base, while `dur` is wall-clock. Play brown
 * noise at rate 0.28 for a nine-second thunder roll and you need only 2.6 s of
 * buffer — but start a random 4 s into a 5 s buffer and the source runs out
 * after one second, cutting a loud signal to zero mid-envelope. That is a
 * step discontinuity, i.e. an audible click, and it showed up on the bench as a
 * full-spectrum vertical stripe through the middle of the distant thunder.
 *
 * So: convert to buffer time, slide the offset back if the slice would overrun,
 * and loop the seam-free noise beds when the request is longer than the buffer.
 * Decaying grains are never looped — they are meant to run out.
 */
function bufSrc(A, v, buffer, rate, t0, dur, offset = 0, loopable = null) {
  const s = A.actx.createBufferSource();
  s.buffer = buffer;
  s.playbackRate.value = rate;
  const span = Math.max(0.001, buffer.duration);
  const need = Math.max(0.001, dur * rate);
  const canLoop = loopable == null ? span >= 2 : loopable;
  let off = offset % span;
  if (need >= span - 0.01) {
    if (canLoop) {
      s.loop = true; s.loopStart = 0; s.loopEnd = span;
      s.start(t0, off);
    } else {
      s.start(t0, 0, span);
    }
  } else {
    if (off + need > span) off = Math.max(0, span - need);
    s.start(t0, off, need + 0.02);
  }
  s.stop(t0 + dur + 0.01);
  v.track(s, t0 + dur + 0.05);
  return s;
}

function osc(A, v, type, freq, t0, dur) {
  const o = A.actx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.start(t0);
  o.stop(t0 + dur);
  v.track(o, t0 + dur + 0.05);
  return o;
}

function gainNode(A, value = 1) {
  const g = A.actx.createGain();
  g.gain.value = value;
  return g;
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/** Build a Float32Array envelope/automation curve. */
function curve(n, fn) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = fn(i / (n - 1), i);
  return a;
}

/**
 * Apply an automation curve and pin the parameter to zero afterwards.
 *
 * The trailing zero must clear the curve by more than ONE RENDER QUANTUM, not
 * by an arbitrary epsilon. Blink extends a setValueCurveAtTime to the next
 * 128-sample boundary and does its overlap check against that extended end, so
 * a trailing event 1 ms after a curve that ends just past a boundary is judged
 * to be *inside* it and throws NotSupportedError — killing that one-shot and
 * logging a console error. It is intermittent by construction, since it depends
 * on where the curve happens to land relative to the quantum grid, which is why
 * it never appeared in offline renders that all start at a fixed t=0.02.
 *
 * @returns {number} the time at which the parameter is guaranteed to be 0
 */
function curveEnv(A, param, t0, env, dur) {
  const quantum = 128 / (A.actx.sampleRate || 48000);
  const end = t0 + dur + quantum * 2 + 0.001;
  param.setValueAtTime(0, t0);
  param.setValueCurveAtTime(env, t0, dur);
  param.setValueAtTime(0, end);
  return end;
}

/**
 * Click-free exponential ring envelope. `dec` is the −80 dB time, so the tail
 * genuinely reaches zero instead of being cut while still audible.
 */
function ring(param, t0, peak, attack, dec) {
  const a = Math.max(0.0004, attack);
  param.cancelScheduledValues(t0);
  param.setValueAtTime(0.0001, t0);
  param.linearRampToValueAtTime(Math.max(1e-4, peak), t0 + a);
  param.exponentialRampToValueAtTime(1e-4, t0 + a + dec);
  param.setValueAtTime(0, t0 + a + dec + 0.001);
  return t0 + a + dec + 0.002;
}

/**
 * Modal (resonator) hit — the pitched part of every impact in the game. Wood,
 * stone, iron and hoof are all this function with different partials.
 *
 * Each partial is an explicitly enveloped sinusoid rather than a bandpass fed
 * from a noise grain. That matters: a Q=44 bandpass passes only f/Q ≈ 27 Hz of
 * a broadband drive and needs Q/f ≈ 37 ms to ring up, so an 8 ms grain excites
 * it about 40 dB below the nominal gain — which is exactly why the first
 * version of the anvil measured a peak of 0.005 and was inaudible. Driving the
 * modes directly makes the level deterministic. `q` now only selects how
 * metallic the mode behaves: above ~18 it gets a detuned twin so the partial
 * beats the way struck iron does.
 *
 * The noise grain is kept, but as what it actually is — the strike transient.
 */
function modal(A, v, t0, partials, driveBuf, driveDur, driveRate = 1, strike = 0.4) {
  const r = A.rand;
  let top = 400;
  for (const p of partials) if (p.f > top) top = p.f;

  const src = bufSrc(A, v, driveBuf, driveRate, t0, Math.max(0.02, driveDur * 3));
  const bp = filter(A.actx, 'bandpass', Math.min(9500, top * 0.85), 0.75);
  const ng = gainNode(A, 0);
  envelope(ng.gain, t0, {
    peak: strike, attack: 0.0012, decay: Math.max(0.012, driveDur * 2.4),
  });
  src.connect(bp); bp.connect(ng); ng.connect(v.input);

  for (const p of partials) {
    const dec = Math.max(0.01, p.decay);
    const att = p.attack || 0.0016;
    const o1 = osc(A, v, 'sine', p.f, t0, att + dec + 0.01);
    const g = gainNode(A, 0);
    ring(g.gain, t0, p.gain, att, dec);
    o1.connect(g); g.connect(v.input);
    if (p.q > 18) {
      const o2 = osc(A, v, 'sine', p.f * (1 + 0.0035 + r() * 0.007), t0, att + dec + 0.01);
      const g2 = gainNode(A, 0);
      ring(g2.gain, t0, p.gain * 0.42, att * 1.6, dec * 0.82);
      o2.connect(g2); g2.connect(v.input);
    }
  }
  return src;
}

/* --------------------------------------------------------------- footsteps */

const STEP = {
  grass: { body: 0.42, bodyF: 150, grit: 0.85, gritF: 1900, gritQ: 0.75, gritDecay: 0.085, tilt: -1, swish: 0.6 },
  dry_grass: { body: 0.34, bodyF: 165, grit: 1.0, gritF: 2600, gritQ: 0.7, gritDecay: 0.075, tilt: -1, swish: 0.75 },
  dirt: { body: 0.85, bodyF: 118, grit: 0.55, gritF: 900, gritQ: 0.9, gritDecay: 0.06, tilt: 0.3, swish: 0.1 },
  gravel: { body: 0.26, bodyF: 130, grit: 1.6, gritF: 3400, gritQ: 0.8, gritDecay: 0.05, tilt: -1, swish: 0, grains: 6 },
  scree: { body: 0.24, bodyF: 128, grit: 1.5, gritF: 2900, gritQ: 0.7, gritDecay: 0.07, tilt: -1, swish: 0, grains: 7 },
  sand: { body: 0.5, bodyF: 96, grit: 0.62, gritF: 780, gritQ: 0.55, gritDecay: 0.12, tilt: 0.55, swish: 0.2 },
  rock: { body: 0.2, bodyF: 190, grit: 1.3, gritF: 4200, gritQ: 1.1, gritDecay: 0.035, tilt: -1, swish: 0 },
  snow: { body: 0.4, bodyF: 120, grit: 0.8, gritF: 1500, gritQ: 1.6, gritDecay: 0.1, tilt: 0.2, swish: 0.3 },
  mud: { body: 0.95, bodyF: 92, grit: 0.3, gritF: 620, gritQ: 1.2, gritDecay: 0.09, tilt: 0.7, swish: 0 },
  wood: { body: 0.5, bodyF: 150, grit: 0.42, gritF: 3200, gritQ: 1.0, gritDecay: 0.03, tilt: -1, swish: 0 },
  water: { body: 0.3, bodyF: 110, grit: 0.4, gritF: 1400, gritQ: 0.6, gritDecay: 0.1, tilt: 0, swish: 0 },
};

/**
 * A single footfall. `surface` selects both the grain spectrum and the
 * structural layer — boardwalk gets a hollow resonance, mud gets a downward
 * formant sweep (the suck), water gets a broadband splash.
 */
export function footstep(A, o = {}) {
  const surf = STEP[o.surface] ? o.surface : 'dirt';
  const S = STEP[surf];
  const r = A.rand;
  const t0 = o.at || A.now();
  const vol = (o.volume != null ? o.volume : 1) * (0.55 + 0.45 * (o.speed || 0.4));
  const v = A.voice({
    dest: o.dest || A.bus.foley, position: o.position, volume: vol * 0.9,
    duration: 0.7, ref: 1.6, rolloff: 1.9, max: 90, panning: 'HRTF',
  });
  if (!v) return null;
  const jitter = 0.88 + r() * 0.26;

  /* --- body: the mass of the boot landing ---------------------------------
   * A pitch-dropping sine carries the impact, with the filtered grain only
   * adding texture on top. Lowpassed noise alone cannot do this job: at the
   * 92–120 Hz cutoffs that mud and sand want, a bright grain loses ~25 dB and
   * the heaviest surfaces came out as the quietest footsteps. */
  if (S.body > 0.02) {
    const f = S.bodyF * jitter;
    const o1 = osc(A, v, 'sine', f * 1.55, t0, 0.14);
    o1.frequency.exponentialRampToValueAtTime(f * 0.82, t0 + 0.055);
    const bg = gainNode(A, 0);
    ring(bg.gain, t0, S.body * 0.42, 0.003, 0.085);
    o1.connect(bg); bg.connect(v.input);

    const lp = filter(A.actx, 'lowpass', f * 2.2, 1.0);
    const g = gainNode(A, 0);
    envelope(g.gain, t0, { peak: S.body * 0.5, attack: 0.003, decay: 0.075 });
    const src = bufSrc(A, v, A.buf.grainDark, 0.7 + r() * 0.3, t0, 0.2);
    src.connect(lp); lp.connect(g); g.connect(v.input);
  }

  /* --- grit: the surface material itself ---------------------------------- */
  const grains = S.grains || 1;
  for (let i = 0; i < grains; i++) {
    const gt = t0 + (i === 0 ? 0 : (0.004 + r() * 0.055));
    const bp = filter(A.actx, 'bandpass', S.gritF * (0.7 + r() * 0.6), S.gritQ * (0.8 + r() * 0.6));
    const g = gainNode(A, 0);
    const amp = S.grit * (i === 0 ? 1 : 0.28 + r() * 0.4) / Math.sqrt(grains);
    envelope(g.gain, gt, { peak: amp, attack: 0.0016, decay: S.gritDecay * (0.7 + r() * 0.6) });
    const buf = S.tilt < 0 ? A.buf.grainBright : (S.tilt > 0.4 ? A.buf.grainDark : A.buf.grainMid);
    const src = bufSrc(A, v, buf, 0.85 + r() * 0.5, gt, 0.24);
    src.connect(bp); bp.connect(g); g.connect(v.input);
  }

  /* --- swish: fabric / vegetation dragging past the leg ------------------- */
  if (S.swish > 0.02) {
    const bp = filter(A.actx, 'bandpass', 1400, 0.6);
    bp.frequency.setValueAtTime(900 * jitter, t0);
    bp.frequency.exponentialRampToValueAtTime(2900 * jitter, t0 + 0.11);
    const g = gainNode(A, 0);
    envelope(g.gain, t0 + 0.012, { peak: S.swish * 0.5, attack: 0.02, decay: 0.1 });
    const src = bufSrc(A, v, A.buf.white, 1, t0, 0.22, r() * 3);
    src.connect(bp); bp.connect(g); g.connect(v.input);
  }

  /* --- boardwalk: hollow plank resonance ---------------------------------- */
  if (surf === 'wood') {
    modal(A, v, t0, [
      { f: 96 * jitter, q: 7, gain: 0.30, decay: 0.26 },
      { f: 182 * jitter, q: 9, gain: 0.17, decay: 0.17 },
      { f: 311 * jitter, q: 11, gain: 0.09, decay: 0.1 },
    ], A.buf.grainMid, 0.03, 1.4, 0.22);
  }

  /* --- mud: the suck. a formant collapsing downward ----------------------- */
  if (surf === 'mud') {
    const bp = filter(A.actx, 'bandpass', 900, 6);
    bp.frequency.setValueAtTime(1050 * jitter, t0 + 0.02);
    bp.frequency.exponentialRampToValueAtTime(190, t0 + 0.2);
    const g = gainNode(A, 0);
    envelope(g.gain, t0 + 0.02, { peak: 0.5, attack: 0.01, decay: 0.16 });
    const src = bufSrc(A, v, A.buf.pink, 1, t0 + 0.02, 0.3, r() * 3);
    src.connect(bp); bp.connect(g); g.connect(v.input);
  }

  /* --- water / wet ground: splash on top ---------------------------------- */
  const wet = surf === 'water' ? 1 : Math.max(0, (o.wetness || 0) - 0.32) * 1.3;
  if (wet > 0.03) splashLayer(A, v, t0, wet * (surf === 'water' ? 1 : 0.45), r);

  return v;
}

/** Broadband splash: a rising highpass on noise plus a few bubble plinks. */
function splashLayer(A, v, t0, amount, r) {
  const hp = filter(A.actx, 'highpass', 300, 0.7);
  hp.frequency.setValueAtTime(280, t0);
  hp.frequency.exponentialRampToValueAtTime(2600, t0 + 0.22);
  const g = gainNode(A, 0);
  envelope(g.gain, t0, { peak: 0.75 * amount, attack: 0.004, decay: 0.26 });
  const src = bufSrc(A, v, A.buf.white, 1, t0, 0.4, r() * 3);
  src.connect(hp); hp.connect(g); g.connect(v.input);

  const n = 2 + ((r() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const bt = t0 + 0.02 + r() * 0.2;
    const f0 = 700 + r() * 1400;
    const o1 = osc(A, v, 'sine', f0, bt, 0.07);
    o1.frequency.exponentialRampToValueAtTime(f0 * (1.6 + r() * 1.2), bt + 0.045);
    const g2 = gainNode(A, 0);
    envelope(g2.gain, bt, { peak: 0.12 * amount, attack: 0.002, decay: 0.045 });
    o1.connect(g2); g2.connect(v.input);
  }
}

/* -------------------------------------------------------------- horse hoof */

const HOOF_GROUND = {
  dirt: { lp: 2200, thud: 1.0, ring: 0.25, bright: 0.5 },
  grass: { lp: 1200, thud: 0.85, ring: 0.1, bright: 0.3 },
  dry_grass: { lp: 1500, thud: 0.8, ring: 0.14, bright: 0.4 },
  sand: { lp: 900, thud: 0.9, ring: 0.05, bright: 0.25 },
  gravel: { lp: 5200, thud: 0.7, ring: 0.5, bright: 1.0 },
  scree: { lp: 5000, thud: 0.65, ring: 0.5, bright: 1.0 },
  rock: { lp: 7000, thud: 0.5, ring: 1.0, bright: 1.0 },
  wood: { lp: 3000, thud: 1.0, ring: 0.35, bright: 0.6 },
  mud: { lp: 700, thud: 1.1, ring: 0.0, bright: 0.15 },
  snow: { lp: 1100, thud: 0.8, ring: 0.05, bright: 0.35 },
  water: { lp: 900, thud: 0.6, ring: 0.0, bright: 0.2 },
};

/** One hoof strike. Shod hoof = a capsule resonance plus the ground's answer. */
export function hoof(A, o = {}) {
  const G = HOOF_GROUND[o.surface] || HOOF_GROUND.dirt;
  const r = A.rand;
  const t0 = o.at || A.now();
  const energy = o.energy != null ? o.energy : 0.7;
  const v = A.voice({
    /* −5 dB against the old level. Measured against the rebuilt mix a hoofbeat
       was landing 3.6 dB under a RIFLE SHOT, which is nonsense; the ladder now
       reads rifle −17.7, hoof −26, footstep −32.5, wind bed −35 dBFS RMS. */
    dest: o.dest || A.bus.sfx || A.bus.foley, position: o.position,
    volume: (o.volume || 1) * 0.48,
    duration: 0.8, ref: 2.4, rolloff: 1.5, max: 220, panning: 'HRTF',
  });
  if (!v) return null;
  const j = 0.9 + r() * 0.22;

  // Everything the hoof does passes through the ground's own bandwidth: soft
  // earth swallows the top end, stone lets all of it through.
  const lp = filter(A.actx, 'lowpass', G.lp * (0.85 + r() * 0.3), 0.8);
  lp.connect(v.input);
  const sink = { input: lp, track: v.track };

  // The strike: a low ground answer, the capsule, and the shoe's edge.
  modal(A, sink, t0, [
    { f: 74 * j, q: 3, gain: 0.34 * G.thud, decay: 0.17 },
    { f: 186 * j, q: 9, gain: 0.50 * G.thud * (0.55 + energy * 0.65), decay: 0.1 + r() * 0.03 },
    { f: 448 * j, q: 8, gain: 0.19 * G.bright, decay: 0.055 },
  ], A.buf.grainMid, 0.02, 1.6 + r() * 0.4, 0.34 + G.bright * 0.34);

  // Iron shoe ringing on stone.
  if (G.ring > 0.05) {
    modal(A, sink, t0, [
      { f: 1780 * j, q: 24, gain: 0.16 * G.ring * energy, decay: 0.16 },
      { f: 3120 * j, q: 30, gain: 0.08 * G.ring * energy, decay: 0.1 },
    ], A.buf.grainBright, 0.01, 2.2, 0.2);
  }

  // Scuff / displaced material — also behind the ground filter, or a hoof on
  // mud comes out brighter than a hoof on rock.
  const bp = filter(A.actx, 'bandpass', 1100 + G.bright * 2400, 0.7);
  const g = gainNode(A, 0);
  envelope(g.gain, t0 + 0.006, { peak: 0.36 * (0.4 + G.bright), attack: 0.004, decay: 0.075 });
  const src = bufSrc(A, v, A.buf.grainBright, 0.8 + r() * 0.5, t0 + 0.006, 0.2);
  src.connect(bp); bp.connect(g); g.connect(lp);

  if (o.surface === 'water' || (o.wetness || 0) > 0.4) {
    splashLayer(A, v, t0, o.surface === 'water' ? 0.8 : (o.wetness - 0.4) * 0.9, r);
  }
  return v;
}

/* ----------------------------------------------------------------- thunder */

/**
 * Thunder. The rumble is brown noise through a lowpass whose cutoff falls with
 * distance (air absorbs the top end over kilometres), amplitude-shaped by a
 * multi-bump curve so it rolls rather than fades. The initial crack only
 * survives to the listener when the strike is close.
 */
export function thunder(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const dist = Math.max(60, Math.min(14000, o.distance != null ? o.distance : 2500));
  const near = Math.exp(-dist / 1500);
  const inten = (o.intensity != null ? o.intensity : 0.7);
  const dur = Math.min(9.5, 2.4 + dist / 900 * 2.6);
  const level = inten * (0.28 + 0.72 * Math.exp(-dist / 5200));

  const v = A.voice({ dest: A.bus.sfx || A.bus.weather, volume: level * 0.8, duration: dur + 0.4 });
  if (!v) return null;

  // Direction hint without distance attenuation — thunder fills the whole sky.
  let sink = v.input;
  if (o.pan != null && A.actx.createStereoPanner) {
    const sp = A.actx.createStereoPanner();
    sp.pan.value = Math.max(-0.85, Math.min(0.85, o.pan));
    sp.connect(v.input);
    sink = sp;
  }

  /* --- rumble ------------------------------------------------------------- */
  const lpF = Math.max(52, 420 * Math.exp(-dist / 3400) + 45);
  const lp = filter(A.actx, 'lowpass', lpF, 0.9);
  const hp = filter(A.actx, 'highpass', 24, 0.7);
  const g = gainNode(A, 0);
  const bumps = [];
  const nb = 3 + ((r() * 4) | 0);
  for (let i = 0; i < nb; i++) bumps.push({ t: r() * 0.82, w: 0.08 + r() * 0.26, a: 0.35 + r() * 0.65 });
  // Distance smears the wavefront: a strike overhead arrives as a crack, one
  // ten kilometres out arrives as a swell with no discernible onset at all.
  const onset = Math.min(0.34, dist / 26000);
  const env = curve(240, (u) => {
    let s = 0;
    for (const b of bumps) { const d = (u - b.t) / b.w; s += b.a * Math.exp(-d * d); }
    const rise = onset > 0.004 ? Math.min(1, u / onset) : (u < 0.02 ? u / 0.02 : 1);
    // overall roll-off so the tail always resolves to silence
    return Math.min(1, s * 0.62) * Math.pow(1 - u, 0.5) * rise * rise;
  });
  curveEnv(A, g.gain, t0, env, dur);
  const src = bufSrc(A, v, A.buf.brown, 0.28 + r() * 0.16, t0, dur, r() * 4);
  src.connect(lp); lp.connect(hp); hp.connect(g); g.connect(sink);

  /* --- crack: only close strikes keep their high end ---------------------- */
  if (near > 0.02) {
    const chp = filter(A.actx, 'highpass', 420 + near * 900, 0.7);
    const cg = gainNode(A, 0);
    envelope(cg.gain, t0, { peak: 1.35 * near * inten, attack: 0.0016, decay: 0.16 });
    const cs = bufSrc(A, v, A.buf.white, 1, t0, 0.5, r() * 3);
    cs.connect(chp); chp.connect(cg); cg.connect(sink);

    // the tearing sweep behind the crack
    const bp = filter(A.actx, 'bandpass', 2600, 1.1);
    bp.frequency.setValueAtTime(2600, t0 + 0.01);
    bp.frequency.exponentialRampToValueAtTime(280, t0 + 0.55);
    const bg = gainNode(A, 0);
    envelope(bg.gain, t0 + 0.01, { peak: 0.7 * near * inten, attack: 0.01, decay: 0.5 });
    const bs = bufSrc(A, v, A.buf.pink, 1, t0 + 0.01, 0.8, r() * 3);
    bs.connect(bp); bp.connect(bg); bg.connect(sink);
  }
  return v;
}

/* ---------------------------------------------------------------- gunshot */

/**
 * Revolver. Same anatomy as `rifle()` — crack, blast, mechanical, slap, tail —
 * at a smaller scale: less pressure behind it, so the crack is flatter, the
 * blast does not fall as far, and the tail is shorter.
 */
export function gunshot(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const echo = !!o.echo;
  const open = o.openness != null ? clamp01(o.openness) : 0.8;
  const tailLen = Math.max(0.3, (o.tail != null ? o.tail : 0.45 + open * 1.2)) * (0.9 + r() * 0.2);
  const v = A.voice({
    dest: A.bus.sfx || A.bus.foley, position: o.position,
    volume: (o.volume || 1) * (echo ? 0.45 : 0.95),
    duration: tailLen + 0.6, ref: echo ? 34 : 10, rolloff: echo ? 0.5 : 0.85,
    max: 1600, when: t0,
  });
  if (!v) return null;
  /* A send is a true wet/dry ratio now that the IRs are energy-normalised, so
     this reads directly: ~−8 dB of landscape behind a pistol in open country.
     Scaled by the voice's own volume because the send is tapped BEFORE the
     voice gain and panner — without it a far, quiet echo threw exactly as much
     reverb as the shot itself. An echo is already a reflection; it gets a
     token send, not a second helping of room. */
  const wetVol = (o.volume != null ? o.volume : 1) * (echo ? 0.4 : 1);
  const wet = A.wetSend ? A.wetSend((echo ? 0.05 : 0.09 + open * 0.19) * wetVol) : null;
  const out = (n) => { n.connect(v.input); if (wet) n.connect(wet); };

  if (!echo) {
    const hp = filter(A.actx, 'highpass', 1700 + r() * 700, 0.7);
    const g = gainNode(A, 0);
    envelope(g.gain, t0, { peak: 0.98, attack: 0.0004, decay: 0.010 });
    const s = bufSrc(A, v, A.buf.white, 1.3, t0, 0.06, r() * 3);
    s.connect(hp); hp.connect(g); g.connect(v.input);

    out(blastLayer(A, v, t0 + 0.0015, {
      peak: 0.95, rate0: 2.0 + r() * 0.4, rate1: 0.6 + r() * 0.1,
      f0: 1750 + r() * 350, f1: 230 + r() * 50, q: 5.5, dur: 0.26, decay: 0.095,
    }));

    // cylinder, frame and the hammer falling
    modal(A, v, t0, [
      { f: 148, q: 5, gain: 0.34, decay: 0.075 },
      { f: 430, q: 4, gain: 0.20, decay: 0.05 },
      { f: 2600 + r() * 300, q: 20, gain: 0.06, decay: 0.020 },
    ], A.buf.grainDark, 0.02, 1, 0.22);

    const slapAt = t0 + 0.052 + r() * 0.050;
    const sbp = filter(A.actx, 'bandpass', 820 + r() * 240, 1.0);
    const sg = gainNode(A, 0);
    envelope(sg.gain, slapAt, { peak: 0.24 * (0.5 + open * 0.7), attack: 0.004, decay: 0.09 });
    const ss = bufSrc(A, v, A.buf.pink, 0.9, slapAt, 0.22, r() * 3);
    ss.connect(sbp); sbp.connect(sg); out(sg);
  }

  const bp = filter(A.actx, 'bandpass', echo ? 640 : 1150, echo ? 0.6 : 0.8);
  bp.frequency.setValueAtTime(echo ? 720 : 1400, t0 + 0.03);
  bp.frequency.exponentialRampToValueAtTime(echo ? 230 : 300, t0 + tailLen * 0.85);
  const tg = gainNode(A, 0);
  const onset = t0 + (echo ? 0 : 0.035);
  envelope(tg.gain, onset, {
    peak: echo ? 0.44 : 0.17 + open * 0.13,
    attack: echo ? 0.05 : 0.028, decay: tailLen,
  });
  const ts = bufSrc(A, v, A.buf.pink, echo ? 0.75 : 1, onset, tailLen + 0.2, r() * 3);
  ts.connect(bp); bp.connect(tg); out(tg);
  return v;
}

/**
 * Lever-action rifle.
 *
 * A RIFLE REPORT IS NOT ONE SOUND, and the first cut of this failed for exactly
 * the reason a click or a pop always fails: it was one short broadband burst
 * with a tail bolted on. Measured through the output chain it delivered −28.8
 * dBFS RMS, quieter than the wind. It is now built as the five things a shot
 * outdoors is actually made of, in the order the ear receives them:
 *
 *   1. CRACK      ~3 ms, the highest amplitude in the whole game. The shock
 *                 front. It exists to be clipped by the compressor — that is
 *                 what a gunshot does to a microphone and to your ears.
 *   2. BOOM       the muzzle blast: a noise burst pitched DOWN hard (rate 2.6 →
 *                 0.5 in 90 ms) through a resonant lowpass sweeping 2.2 kHz →
 *                 190 Hz. The falling rate is what makes it expand rather than
 *                 just decay, and is the single layer that reads as "big gun".
 *   3. MECHANICAL firing pin and receiver ring, quiet, right on the transient.
 *   4. SLAP-BACK  a delayed, band-limited copy 55–110 ms later. Sound has to
 *                 come back off SOMETHING — ground, rock, a building — and
 *                 without this the shot sounds like it was fired in a padded
 *                 room. Distant reflectors are separate voices scheduled by
 *                 Audio._onGunshot off the real heightfield; this is the near
 *                 one, which always exists.
 *   5. TAIL       a long diffuse decay whose LENGTH TRACKS `o.openness`, plus a
 *                 matching feed to the reverb. Prairie rings for two seconds;
 *                 a canyon slaps and stops.
 *
 * Every layer is jittered per shot — crack brightness, blast sweep, slap delay,
 * tail length — so a magazine emptied fast never sounds looped.
 *
 * `o.echo` renders the same event as a REFLECTION off distant ground: same
 * source material, but band-limited, softened and stripped of its transient,
 * because that is exactly what a few hundred metres of air and one bounce off a
 * hillside does to a gunshot.
 */
export function rifle(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const echo = !!o.echo;
  const open = o.openness != null ? clamp01(o.openness) : 0.8;
  const vary = 0.9 + r() * 0.2;
  const tailLen = Math.max(0.4, (o.tail != null ? o.tail : 0.55 + open * 1.85)) * vary;
  const v = A.voice({
    dest: A.bus.sfx || A.bus.foley, position: o.position,
    volume: (o.volume || 1) * (echo ? 0.5 : 1.0),
    duration: echo ? tailLen + 0.5 : tailLen + 0.7,
    ref: echo ? 40 : 12, rolloff: echo ? 0.5 : 0.8,
    max: 2400, when: t0,
  });
  if (!v) return null;

  /* Extra reverb, on top of the SFX bus send. Open country puts far more of a
     rifle into the landscape than a street does. Null in an offline render
     that did not ask for a room. Only the blast, the slap and the tail are fed
     to it — never the crack, which must stay a dry shock front — so the shot
     keeps its edge while the country behind it rings. ~−7 dB wet on the
     prairie; this is the one place in the mix reverb is meant to be heard.
     Scaled by the voice's own volume: the send is tapped BEFORE the voice gain
     and panner, so an echo at a tenth of the level was still feeding the
     reverb at full strength — three of those per shot is the wash. */
  const wetVol = (o.volume != null ? o.volume : 1) * (echo ? 0.4 : 1);
  const wet = A.wetSend ? A.wetSend((echo ? 0.06 : 0.12 + open * 0.26) * wetVol) : null;
  const out = (n) => { n.connect(v.input); if (wet) n.connect(wet); };

  if (!echo) {
    /* --- 1. the crack: the shock front ---------------------------------- */
    const hp = filter(A.actx, 'highpass', 2600 + r() * 900, 0.7);
    const g = gainNode(A, 0);
    envelope(g.gain, t0, { peak: 1.16, attack: 0.00025, decay: 0.0055 });
    const s = bufSrc(A, v, A.buf.white, 1.6, t0, 0.05, r() * 3);
    s.connect(hp); hp.connect(g); g.connect(v.input);

    // the whip of the bullet leaving, a hair later and narrower
    const bp0 = filter(A.actx, 'bandpass', 4200 + r() * 1800, 1.4);
    const g0 = gainNode(A, 0);
    envelope(g0.gain, t0 + 0.0012, { peak: 0.72, attack: 0.0003, decay: 0.010 });
    const s0 = bufSrc(A, v, A.buf.grainBright, 1.7, t0 + 0.0012, 0.05);
    s0.connect(bp0); bp0.connect(g0); g0.connect(v.input);

    /* --- 2. the boom: a noise burst dragged down in pitch ---------------- */
    const blast = blastLayer(A, v, t0 + 0.0018, {
      peak: 1.02, rate0: 2.4 + r() * 0.5, rate1: 0.46 + r() * 0.1,
      f0: 2100 + r() * 400, f1: 180 + r() * 40, q: 6.5, dur: 0.30, decay: 0.115,
    });
    out(blast);

    // chest punch — the part you feel rather than hear
    const th = osc(A, v, 'sine', 82 + r() * 14, t0 + 0.002, 0.16);
    th.frequency.exponentialRampToValueAtTime(42, t0 + 0.09);
    const thg = gainNode(A, 0);
    envelope(thg.gain, t0 + 0.002, { peak: 0.46, attack: 0.0015, decay: 0.085 });
    th.connect(thg); thg.connect(v.input);

    /* --- 3. mechanical: firing pin + receiver ring ----------------------- */
    modal(A, v, t0, [
      { f: 2280 + r() * 260, q: 20, gain: 0.085, decay: 0.030 },
      { f: 4550 + r() * 500, q: 22, gain: 0.045, decay: 0.018 },
      { f: 196, q: 6, gain: 0.16, decay: 0.055 },
    ], A.buf.grainDark, 0.008, 1.2, 0.14);

    /* --- 4. near slap-back ----------------------------------------------- */
    const slapAt = t0 + 0.055 + r() * 0.055;
    const sbp = filter(A.actx, 'bandpass', 780 + r() * 260, 1.0);
    const sg = gainNode(A, 0);
    envelope(sg.gain, slapAt, { peak: 0.30 * (0.5 + open * 0.7), attack: 0.004, decay: 0.10 });
    const ss = bufSrc(A, v, A.buf.pink, 0.85, slapAt, 0.24, r() * 3);
    ss.connect(sbp); sbp.connect(sg); out(sg);
  }

  /* --- 5. the diffuse tail; its length is the size of the country -------- */
  const bp = filter(A.actx, 'bandpass', echo ? 620 : 1350, echo ? 0.6 : 0.8);
  bp.frequency.setValueAtTime(echo ? 700 : 1500, t0 + 0.02);
  bp.frequency.exponentialRampToValueAtTime(echo ? 200 : 230, t0 + tailLen * 0.85);
  const tg = gainNode(A, 0);
  const onset = t0 + (echo ? 0 : 0.030);
  envelope(tg.gain, onset, {
    peak: echo ? 0.50 : 0.20 + open * 0.16,
    attack: echo ? 0.055 : 0.030,
    decay: tailLen,
  });
  const ts = bufSrc(A, v, A.buf.pink, echo ? 0.7 : 0.9, onset, tailLen + 0.25, r() * 3);
  ts.connect(bp); bp.connect(tg); out(tg);
  return v;
}

/**
 * A muzzle blast: broadband noise whose PLAYBACK RATE falls fast while a
 * resonant lowpass sweeps down with it.
 *
 * Both halves matter. Sweeping only the filter gives a decay; dropping only the
 * rate gives a wobble. Doing both is what makes a pressure wave read as
 * expanding away from you, and it is the difference between a rifle and a
 * firecracker. Shared by the rifle and the revolver so they are recognisably
 * the same physics at different scales.
 */
function blastLayer(A, v, t0, {
  peak = 1.4, rate0 = 2.5, rate1 = 0.5, f0 = 2000, f1 = 190,
  q = 6.5, dur = 0.3, decay = 0.11,
}) {
  const lp = filter(A.actx, 'lowpass', f0, q);
  lp.frequency.setValueAtTime(f0, t0);
  lp.frequency.exponentialRampToValueAtTime(f1, t0 + decay * 1.25);
  const g = gainNode(A, 0);
  envelope(g.gain, t0, { peak, attack: 0.0012, decay });
  // over-provision the slice at the STARTING rate; the source slows down, so it
  // can only ever have more buffer left than it needs
  const s = bufSrc(A, v, A.buf.brown, rate0, t0, dur, A.rand() * 4);
  s.playbackRate.setValueAtTime(rate0, t0);
  s.playbackRate.exponentialRampToValueAtTime(rate1, t0 + decay * 0.8);
  s.connect(lp); lp.connect(g);
  return g;
}

/* --------------------------------------------------- rifle mechanics / reload
 *
 * A lever-action reload is a SEQUENCE of distinct mechanical events, not one
 * noise: the hammer thumbed to half-cock, the loading gate springing in, eight
 * cartridges pressed one at a time into the tube against a stiffening follower
 * spring, the gate shut, the lever thrown and returned. Each is built the same
 * way — a very short filtered-noise transient for the impact, `modal()` for the
 * metallic ring on top, and a spring or scrape where the part actually travels.
 *
 * Audio._updateWeapon() fires these off the weapon's own animation scalars, so
 * they land on the frames the mesh reaches them rather than on a timer.
 */

/** Steel on steel: a short transient plus a ring, the shape every part shares. */
function clack(A, v, t0, { partials, drive = 0.006, rate = 1.1, strike = 0.22, hp = 0 }) {
  if (hp) {
    const f = filter(A.actx, 'highpass', hp, 0.7);
    const g = gainNode(A, 0);
    envelope(g.gain, t0, { peak: strike * 1.4, attack: 0.0004, decay: 0.008 });
    const s = bufSrc(A, v, A.buf.grainBright, rate * 1.3, t0, 0.04);
    s.connect(f); f.connect(g); g.connect(v.input);
  }
  modal(A, v, t0, partials, A.buf.grainBright, drive, rate, strike);
}

/** The lever swung open: travel, the shell flicked clear, the stop. */
export function leverThrow(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({
    dest: A.bus.sfx || A.bus.foley, position: o.position, volume: (o.volume || 1) * 0.80,
    duration: 0.40, ref: 1.4, rolloff: 2.2, max: 45, when: t0,
  });
  if (!v) return null;

  // the linkage sliding — a short band of noise that swells as it travels
  const bp = filter(A.actx, 'bandpass', 520 + r() * 220, 1.5);
  const g = gainNode(A, 0);
  envelope(g.gain, t0, { peak: 0.16, attack: 0.014, decay: 0.055 });
  const s = bufSrc(A, v, A.buf.white, 0.8, t0, 0.10, r() * 3);
  s.connect(bp); bp.connect(g); g.connect(v.input);

  // the spent case flicked out and clear of the port
  const ejAt = t0 + 0.030 + r() * 0.018;
  modal(A, v, ejAt, [
    { f: 3900 + r() * 900, q: 24, gain: 0.11, decay: 0.045 },
    { f: 6100 + r() * 900, q: 20, gain: 0.055, decay: 0.028 },
  ], A.buf.grainBright, 0.004, 1.6, 0.09);

  // the lever hitting its stop
  clack(A, v, t0 + 0.062 + r() * 0.020, {
    hp: 2600,
    partials: [
      { f: 720 + r() * 90, q: 9, gain: 0.30, decay: 0.045 },
      { f: 1620 + r() * 180, q: 16, gain: 0.22, decay: 0.035 },
      { f: 3350 + r() * 300, q: 19, gain: 0.10, decay: 0.020 },
    ],
    drive: 0.005, rate: 1.2, strike: 0.20,
  });
  return v;
}

/** The lever snapped shut and the bolt seated: the hardest sound on the gun. */
export function leverReturn(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({
    dest: A.bus.sfx || A.bus.foley, position: o.position, volume: (o.volume || 1) * 0.78,
    duration: 0.40, ref: 1.4, rolloff: 2.2, max: 45, when: t0,
  });
  if (!v) return null;

  // the round stripped off the carrier on the way up
  const bp = filter(A.actx, 'bandpass', 1150 + r() * 300, 1.2);
  const g = gainNode(A, 0);
  envelope(g.gain, t0, { peak: 0.14, attack: 0.006, decay: 0.030 });
  const s = bufSrc(A, v, A.buf.white, 1.1, t0, 0.06, r() * 3);
  s.connect(bp); bp.connect(g); g.connect(v.input);

  // bolt into battery — heavier and lower than the throw, with a wood thump
  clack(A, v, t0 + 0.042 + r() * 0.016, {
    hp: 3000,
    partials: [
      { f: 168, q: 5, gain: 0.30, decay: 0.055 },
      { f: 880 + r() * 110, q: 10, gain: 0.34, decay: 0.050 },
      { f: 1950 + r() * 220, q: 20, gain: 0.26, decay: 0.038 },
      { f: 4100 + r() * 420, q: 21, gain: 0.10, decay: 0.017 },
    ],
    drive: 0.006, rate: 1.3, strike: 0.30,
  });
  return v;
}

/** Back-compat: the whole cycle as one event, for callers with no animation. */
export function lever(A, o = {}) {
  const t0 = o.at || A.now();
  leverThrow(A, { ...o, at: t0 });
  return leverReturn(A, { ...o, at: t0 + 0.22 + A.rand() * 0.05 });
}

/** Thumb rolling the hammer back to half-cock: two tiny sear clicks. */
export function hammerBack(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({
    dest: A.bus.sfx || A.bus.foley, position: o.position, volume: (o.volume || 1) * 0.95,
    duration: 0.20, ref: 1.1, rolloff: 2.6, max: 26, when: t0,
  });
  if (!v) return null;
  for (let i = 0; i < 2; i++) {
    const at = t0 + i * (0.034 + r() * 0.016);
    modal(A, v, at, [
      { f: 2750 + r() * 420, q: 20, gain: 0.16 - i * 0.03, decay: 0.016 },
      { f: 5400 + r() * 700, q: 22, gain: 0.07, decay: 0.010 },
    ], A.buf.grainBright, 0.003, 1.5, 0.10);
  }
  return v;
}

/** The loading gate sprung inward under the thumb. */
export function gateOpen(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({
    dest: A.bus.sfx || A.bus.foley, position: o.position, volume: (o.volume || 1) * 1.05,
    duration: 0.26, ref: 1.1, rolloff: 2.6, max: 28, when: t0,
  });
  if (!v) return null;
  // leaf spring bending — a pitch that RISES as it loads up
  const f0 = 1250 + r() * 260;
  const tw = osc(A, v, 'triangle', f0, t0, 0.07);
  tw.frequency.exponentialRampToValueAtTime(f0 * 1.6, t0 + 0.045);
  const tg = gainNode(A, 0);
  envelope(tg.gain, t0, { peak: 0.10, attack: 0.004, decay: 0.030 });
  tw.connect(tg); tg.connect(v.input);
  modal(A, v, t0 + 0.006, [
    { f: 1080 + r() * 200, q: 14, gain: 0.17, decay: 0.026 },
    { f: 2900 + r() * 400, q: 19, gain: 0.09, decay: 0.015 },
  ], A.buf.grainBright, 0.004, 1.4, 0.14);
  return v;
}

/**
 * One cartridge thumbed into the magazine tube.
 *
 * `o.seat` is 0..1 — how full the tube already is. The follower spring gets
 * stiffer and shorter as it fills, so later rounds sit higher and stop harder;
 * that plus `o.vary` is what keeps eight of these in a row from sounding like
 * one sample retriggered.
 */
export function shellIn(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const seat = clamp01(o.seat != null ? o.seat : 0.4);
  const k = o.vary != null ? o.vary : r();
  const v = A.voice({
    dest: A.bus.sfx || A.bus.foley, position: o.position, volume: (o.volume || 1) * 0.90,
    duration: 0.30, ref: 1.1, rolloff: 2.6, max: 28, when: t0,
  });
  if (!v) return null;

  // brass sliding on brass, then on steel
  const bp = filter(A.actx, 'bandpass', 1900 + k * 900 + seat * 500, 1.1);
  const g = gainNode(A, 0);
  envelope(g.gain, t0, { peak: 0.13, attack: 0.005, decay: 0.038 });
  const s = bufSrc(A, v, A.buf.white, 1.0 + k * 0.4, t0, 0.09, r() * 3);
  s.connect(bp); bp.connect(g); g.connect(v.input);

  // the press itself: a soft, dull thump through the wood of the forend
  const lp = filter(A.actx, 'lowpass', 300 + seat * 120, 1.2);
  const g2 = gainNode(A, 0);
  envelope(g2.gain, t0 + 0.010, { peak: 0.26, attack: 0.003, decay: 0.045 });
  const s2 = bufSrc(A, v, A.buf.grainDark, 0.85 + k * 0.3, t0 + 0.010, 0.10);
  s2.connect(lp); lp.connect(g2); g2.connect(v.input);

  // the round stopping against the follower — brighter and later as it fills
  const stopAt = t0 + 0.046 + (1 - seat) * 0.020 + k * 0.012;
  modal(A, v, stopAt, [
    { f: (1560 + k * 260) * (1 + seat * 0.16), q: 19, gain: 0.16 + seat * 0.07, decay: 0.024 },
    { f: (3250 + k * 500) * (1 + seat * 0.10), q: 21, gain: 0.075, decay: 0.014 },
    { f: 430 + k * 60, q: 6, gain: 0.09, decay: 0.030 },
  ], A.buf.grainBright, 0.004, 1.3 + seat * 0.3, 0.16);
  return v;
}

/** The gate shut: heavier and flatter than it was to open. */
export function gateClose(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({
    dest: A.bus.sfx || A.bus.foley, position: o.position, volume: (o.volume || 1) * 0.85,
    duration: 0.28, ref: 1.1, rolloff: 2.6, max: 28, when: t0,
  });
  if (!v) return null;
  clack(A, v, t0, {
    hp: 3200,
    partials: [
      { f: 610 + r() * 90, q: 8, gain: 0.26, decay: 0.036 },
      { f: 1420 + r() * 180, q: 17, gain: 0.20, decay: 0.026 },
      { f: 2950 + r() * 350, q: 20, gain: 0.08, decay: 0.014 },
    ],
    drive: 0.005, rate: 1.2, strike: 0.20,
  });
  return v;
}

/* ------------------------------------------------- small ambient one-shots */

/** Fire pop: a very short bright grain with a little pitched resonance. */
export function crackle(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({
    dest: A.bus.ambient, position: o.position, volume: (o.volume || 1) * (0.25 + r() * 0.75),
    duration: 0.3, ref: 1.2, rolloff: 2.2, max: 40,
  });
  if (!v) return null;
  const f = 1400 + r() * 4200;
  const bp = filter(A.actx, 'bandpass', f, 1.1 + r() * 1.8);
  const g = gainNode(A, 0);
  envelope(g.gain, t0, { peak: 1.7, attack: 0.0009, decay: 0.012 + r() * 0.05 });
  const s = bufSrc(A, v, A.buf.grainBright, 0.8 + r() * 1.4, t0, 0.12);
  s.connect(bp); bp.connect(g); g.connect(v.input);
  if (r() < 0.3) {
    // The bigger pops: a resonant knock off the log, not just a bright tick.
    modal(A, v, t0, [
      { f: 170 + r() * 260, q: 6, gain: 0.32, decay: 0.05 + r() * 0.06 },
      { f: 520 + r() * 500, q: 8, gain: 0.16, decay: 0.035 },
    ], A.buf.grainDark, 0.008, 1.2, 0.18);
  }
  if (r() < 0.22) { // occasional hiss of sap
    const bp2 = filter(A.actx, 'bandpass', 3800 + r() * 2500, 0.9);
    const g2 = gainNode(A, 0);
    envelope(g2.gain, t0, { peak: 0.1, attack: 0.02, decay: 0.16 });
    const s2 = bufSrc(A, v, A.buf.white, 1, t0, 0.3, r() * 3);
    s2.connect(bp2); bp2.connect(g2); g2.connect(v.input);
  }
  return v;
}

/** Single rain drip — a plink whose resonance rises as the cavity closes. */
export function drip(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({
    dest: A.bus.weather, position: o.position, volume: (o.volume || 1) * (0.3 + r() * 0.7),
    duration: 0.25, ref: 1.5, rolloff: 2.4, max: 30,
  });
  if (!v) return null;
  const f0 = 1500 + r() * 2600;
  const o1 = osc(A, v, 'sine', f0, t0, 0.09);
  o1.frequency.exponentialRampToValueAtTime(f0 * (1.5 + r()), t0 + 0.05);
  const g = gainNode(A, 0);
  envelope(g.gain, t0, { peak: 0.34, attack: 0.001, decay: 0.04 });
  o1.connect(g); g.connect(v.input);
  const bp = filter(A.actx, 'bandpass', 4500 + r() * 3000, 1.2);
  const g2 = gainNode(A, 0);
  envelope(g2.gain, t0, { peak: 0.3, attack: 0.0008, decay: 0.015 });
  const s = bufSrc(A, v, A.buf.grainBright, 1 + r(), t0, 0.08);
  s.connect(bp); bp.connect(g2); g2.connect(v.input);
  return v;
}

/** Cricket: a trilled near-sine around 4.5 kHz. The sound of a prairie night. */
export function cricket(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({
    dest: A.bus.ambient, position: o.position, volume: (o.volume || 1) * (0.5 + r() * 0.5),
    duration: 0.45, ref: 3, rolloff: 1.8, max: 45,
  });
  if (!v) return null;
  const f = 3700 + r() * 1500;
  const pulses = 3 + ((r() * 3) | 0);
  const period = 0.032 + r() * 0.016;
  const dur = pulses * period;
  const o1 = osc(A, v, 'triangle', f, t0, dur + 0.03);
  const bp = filter(A.actx, 'bandpass', f, 5);
  const g = gainNode(A, 0);
  const env = curve(Math.max(24, (pulses * 12) | 0), (u) => {
    const p = (u * pulses) % 1;
    return p < 0.42 ? Math.sin(p / 0.42 * Math.PI) : 0;
  });
  curveEnv(A, g.gain, t0, env, dur);
  o1.connect(bp); bp.connect(g); g.connect(v.input);
  return v;
}

/** Cicada: dry, buzzing, amplitude-modulated noise. Heat made audible. */
export function cicada(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const dur = 1.8 + r() * 2.6;
  const v = A.voice({
    dest: A.bus.ambient, position: o.position, volume: (o.volume || 1) * (0.35 + r() * 0.4),
    duration: dur + 0.3, ref: 5, rolloff: 1.5, max: 70,
  });
  if (!v) return null;
  const f = 4200 + r() * 3200;
  const bp = filter(A.actx, 'bandpass', f, 2.4 + r() * 2);
  // A second band an octave down gives the buzz a body; one narrow band alone
  // measured 20 dB below everything else and vanished under the wind.
  const bp2 = filter(A.actx, 'bandpass', f * 0.5, 1.8);
  const g2 = gainNode(A, 0.45);
  const g = gainNode(A, 0);
  const rate = 38 + r() * 22;
  const env = curve(280, (u) => {
    const swell = Math.min(1, u / 0.22) * Math.min(1, (1 - u) / 0.3);
    const am = 0.55 + 0.45 * Math.sin(u * dur * rate * Math.PI * 2);
    return swell * swell * am * 2.6;
  });
  curveEnv(A, g.gain, t0, env, dur);
  const s = bufSrc(A, v, A.buf.white, 1, t0, dur + 0.05, r() * 3);
  s.connect(bp); bp.connect(g);
  s.connect(bp2); bp2.connect(g2); g2.connect(g);
  g.connect(v.input);
  return v;
}

/** A small bird phrase: 2–4 swept whistles. */
export function bird(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const notes = 2 + ((r() * 3) | 0);
  const v = A.voice({
    dest: A.bus.ambient, position: o.position, volume: (o.volume || 1) * (0.4 + r() * 0.5),
    duration: 1.2, ref: 8, rolloff: 1.2, max: 240,
  });
  if (!v) return null;
  let t = t0;
  for (let i = 0; i < notes; i++) {
    const len = 0.05 + r() * 0.09;
    const f0 = 1900 + r() * 2200;
    const f1 = f0 * (0.6 + r() * 1.0);
    const o1 = osc(A, v, 'sine', f0, t, len + 0.02);
    o1.frequency.exponentialRampToValueAtTime(Math.max(400, f1), t + len);
    const o2 = osc(A, v, 'triangle', f0 * 2, t, len + 0.02);
    o2.frequency.exponentialRampToValueAtTime(Math.max(800, f1 * 2), t + len);
    const g = gainNode(A, 0);
    envelope(g.gain, t, { peak: 0.34, attack: 0.008, decay: len * 0.9 });
    const g2 = gainNode(A, 0.16);
    o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(v.input);
    t += len + 0.02 + r() * 0.08;
  }
  return v;
}

/** A hawk/crow — harsher, for empty daylight skies. */
export function birdCall(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({
    dest: A.bus.ambient, position: o.position, volume: (o.volume || 1) * 0.5,
    duration: 1.6, ref: 18, rolloff: 0.9, max: 700,
  });
  if (!v) return null;
  const n = 1 + ((r() * 3) | 0);
  let t = t0;
  for (let i = 0; i < n; i++) {
    const len = 0.16 + r() * 0.2;
    const f0 = 780 + r() * 500;
    const o1 = osc(A, v, 'sawtooth', f0, t, len + 0.02);
    o1.frequency.setValueAtTime(f0, t);
    o1.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + len);
    const bp = filter(A.actx, 'bandpass', 1500 + r() * 700, 3.2);
    const g = gainNode(A, 0);
    envelope(g.gain, t, { peak: 0.24, attack: 0.02, decay: len });
    o1.connect(bp); bp.connect(g); g.connect(v.input);
    t += len + 0.18 + r() * 0.3;
  }
  return v;
}

/** Owl: two soft hoots with a little vibrato. */
export function owl(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({
    dest: A.bus.ambient, position: o.position, volume: (o.volume || 1) * 0.55,
    duration: 2.4, ref: 20, rolloff: 0.9, max: 600,
  });
  if (!v) return null;
  const base = 300 + r() * 90;
  for (let i = 0; i < 2; i++) {
    const t = t0 + i * (0.55 + r() * 0.2);
    const len = 0.34 + r() * 0.14;
    const o1 = osc(A, v, 'sine', base, t, len + 0.06);
    const vib = curve(48, (u) => base * (1 + 0.012 * Math.sin(u * 34) + (u < 0.2 ? -0.05 * (1 - u / 0.2) : 0)));
    o1.frequency.setValueCurveAtTime(vib, t, len);
    const o2 = osc(A, v, 'sine', base * 2, t, len + 0.06);
    const g = gainNode(A, 0);
    envelope(g.gain, t, { peak: 0.4, attack: 0.07, decay: len * 0.8 });
    const g2 = gainNode(A, 0.1);
    o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(v.input);
  }
  return v;
}

/** Coyote howl — rise, hold, fall, then a couple of yips. */
export function coyote(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({
    dest: A.bus.ambient, position: o.position, volume: (o.volume || 1) * 0.5,
    duration: 3.6, ref: 40, rolloff: 0.7, max: 2000,
  });
  if (!v) return null;
  const len = 1.1 + r() * 0.7;
  const f0 = 360 + r() * 120;
  const o1 = osc(A, v, 'sawtooth', f0, t0, len + 0.1);
  const fc = curve(90, (u) => {
    const shape = u < 0.18 ? u / 0.18 : (u < 0.62 ? 1 : 1 - (u - 0.62) / 0.38 * 0.55);
    return f0 * (0.72 + shape * 0.85) * (1 + 0.02 * Math.sin(u * 46));
  });
  o1.frequency.setValueCurveAtTime(fc, t0, len);
  const f1 = filter(A.actx, 'bandpass', 780, 3.5);
  const f2 = filter(A.actx, 'bandpass', 1250, 5);
  const g = gainNode(A, 0);
  envelope(g.gain, t0, { peak: 0.42, attack: 0.12, hold: len * 0.45, decay: len * 0.5 });
  const mix = gainNode(A, 0.6);
  o1.connect(f1); o1.connect(f2); f1.connect(mix); f2.connect(mix); mix.connect(g); g.connect(v.input);

  const yips = 2 + ((r() * 3) | 0);
  let t = t0 + len + 0.15;
  for (let i = 0; i < yips; i++) {
    const yl = 0.07 + r() * 0.05;
    const yf = 620 + r() * 340;
    const yo = osc(A, v, 'sawtooth', yf, t, yl + 0.02);
    yo.frequency.exponentialRampToValueAtTime(yf * 0.6, t + yl);
    const yb = filter(A.actx, 'bandpass', 1400, 3);
    const yg = gainNode(A, 0);
    envelope(yg.gain, t, { peak: 0.2, attack: 0.006, decay: yl });
    yo.connect(yb); yb.connect(yg); yg.connect(v.input);
    t += yl + 0.09 + r() * 0.1;
  }
  return v;
}

/* ----------------------------------------------------------- town one-shots */

/** Blacksmith's hammer on the anvil — pure modal iron. */
export function anvil(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({
    dest: A.bus.ambient, position: o.position, volume: (o.volume || 1) * 0.55,
    duration: 1.6, ref: 12, rolloff: 1.1, max: 400,
  });
  if (!v) return null;
  const j = 0.96 + r() * 0.09;
  modal(A, v, t0, [
    { f: 1180 * j, q: 44, gain: 0.5, decay: 0.85 },
    { f: 2390 * j, q: 52, gain: 0.3, decay: 0.6 },
    { f: 3970 * j, q: 60, gain: 0.18, decay: 0.4 },
    { f: 620 * j, q: 22, gain: 0.22, decay: 0.3 },
  ], A.buf.grainBright, 0.008, 2.4, 0.75);
  return v;
}

/** Saloon piano — three partials per note over a short honky-tonk figure. */
export function piano(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({
    dest: A.bus.ambient, position: o.position, volume: (o.volume || 1) * 0.4,
    duration: 3.6, ref: 10, rolloff: 1.3, max: 260,
  });
  if (!v) return null;
  const scale = [0, 2, 4, 7, 9, 12, 14, 16];
  const root = 220 * Math.pow(2, ((r() * 3) | 0) / 12);
  const n = 3 + ((r() * 4) | 0);
  let t = t0;
  for (let i = 0; i < n; i++) {
    const f = root * Math.pow(2, scale[(r() * scale.length) | 0] / 12);
    const detune = 1 + (r() - 0.5) * 0.012;   // out of tune, as it must be
    for (let h = 0; h < 3; h++) {
      const hf = f * (h + 1) * (h === 2 ? 1.004 : 1) * detune;
      if (hf > 9000) continue;
      const oh = osc(A, v, h === 0 ? 'triangle' : 'sine', hf, t, 1.3);
      const g = gainNode(A, 0);
      envelope(g.gain, t, { peak: [0.3, 0.13, 0.06][h], attack: 0.004, decay: [0.9, 0.55, 0.35][h] });
      oh.connect(g); g.connect(v.input);
    }
    const cg = gainNode(A, 0);
    envelope(cg.gain, t, { peak: 0.08, attack: 0.001, decay: 0.02 });
    const cs = bufSrc(A, v, A.buf.grainBright, 1.4, t, 0.05);
    cs.connect(cg); cg.connect(v.input);
    t += 0.16 + r() * 0.22;
  }
  return v;
}

/** A distant dog. */
export function dog(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({
    dest: A.bus.ambient, position: o.position, volume: (o.volume || 1) * 0.45,
    duration: 1.6, ref: 16, rolloff: 1.0, max: 600,
  });
  if (!v) return null;
  const n = 2 + ((r() * 3) | 0);
  let t = t0;
  for (let i = 0; i < n; i++) {
    const f0 = 300 + r() * 180;
    const len = 0.09 + r() * 0.05;
    const o1 = osc(A, v, 'sawtooth', f0, t, len + 0.03);
    o1.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + len);
    const f1 = filter(A.actx, 'bandpass', 620, 2.5);
    const f2 = filter(A.actx, 'bandpass', 1650, 3.5);
    const g = gainNode(A, 0);
    envelope(g.gain, t, { peak: 0.34, attack: 0.006, decay: len * 1.1 });
    o1.connect(f1); o1.connect(f2); f1.connect(g); f2.connect(g); g.connect(v.input);
    const ng = gainNode(A, 0);
    envelope(ng.gain, t, { peak: 0.1, attack: 0.003, decay: 0.05 });
    const ns = bufSrc(A, v, A.buf.grainMid, 1, t, 0.1);
    ns.connect(ng); ng.connect(v.input);
    t += len + 0.16 + r() * 0.18;
  }
  return v;
}

/** A door / shutter creak: stick-slip modulation on a resonant sawtooth. */
export function creak(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const dur = 0.5 + r() * 0.6;
  const v = A.voice({
    dest: A.bus.ambient, position: o.position, volume: (o.volume || 1) * 0.34,
    duration: dur + 0.5, ref: 6, rolloff: 1.6, max: 120,
  });
  if (!v) return null;
  const f0 = 130 + r() * 160;
  const o1 = osc(A, v, 'sawtooth', f0, t0, dur + 0.05);
  const fc = curve(64, (u) => f0 * (1 + u * (0.4 + r() * 0.8)));
  o1.frequency.setValueCurveAtTime(fc, t0, dur);
  const bp = filter(A.actx, 'bandpass', 900 + r() * 900, 7);
  const g = gainNode(A, 0);
  const env = curve(96, (u) => {
    const stick = (Math.sin(u * 90 + Math.sin(u * 31) * 3) * 0.5 + 0.5);
    return Math.min(1, u / 0.1) * (1 - u) * (0.25 + 0.75 * stick * stick);
  });
  curveEnv(A, g.gain, t0, env, dur);
  o1.connect(bp); bp.connect(g); g.connect(v.input);
  // the latch at the end
  modal(A, v, t0 + dur, [
    { f: 220, q: 8, gain: 0.3, decay: 0.09 },
    { f: 1400, q: 14, gain: 0.12, decay: 0.06 },
  ], A.buf.grainMid, 0.02, 1.2);
  return v;
}

/** Saddle / holster leather. */
export function leather(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const dur = 0.22 + r() * 0.18;
  const v = A.voice({
    dest: A.bus.foley, position: o.position, volume: (o.volume || 1) * 0.5,
    duration: dur + 0.3, ref: 1.6, rolloff: 2, max: 40, panning: 'HRTF',
  });
  if (!v) return null;
  const bp = filter(A.actx, 'bandpass', 1300 + r() * 900, 2.2);
  const g = gainNode(A, 0);
  const env = curve(64, (u) => {
    const stick = Math.sin(u * (40 + r() * 30)) * 0.5 + 0.5;
    return 1.9 * Math.sin(Math.min(1, u * 3) * Math.PI * 0.5) * (1 - u) * (0.3 + 0.7 * stick);
  });
  curveEnv(A, g.gain, t0, env, dur);
  const s = bufSrc(A, v, A.buf.pink, 1, t0, dur + 0.05, r() * 3);
  s.connect(bp); bp.connect(g); g.connect(v.input);
  return v;
}

/** Bottle / glass clink. */
export function clink(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({
    dest: A.bus.ambient, position: o.position, volume: (o.volume || 1) * 0.3,
    duration: 0.9, ref: 5, rolloff: 1.6, max: 90,
  });
  if (!v) return null;
  const j = 0.9 + r() * 0.3;
  modal(A, v, t0, [
    { f: 1750 * j, q: 55, gain: 0.4, decay: 0.35 },
    { f: 3380 * j, q: 60, gain: 0.2, decay: 0.22 },
  ], A.buf.grainBright, 0.006, 2.6);
  return v;
}

/** Cart / wagon wheel roll — used sparingly in town. */
export function wagon(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const dur = 3.5 + r() * 2.5;
  const v = A.voice({
    dest: A.bus.ambient, position: o.position, volume: (o.volume || 1) * 0.3,
    duration: dur + 0.5, ref: 10, rolloff: 1.4, max: 200,
  });
  if (!v) return null;
  const lp = filter(A.actx, 'lowpass', 420, 1.2);
  const g = gainNode(A, 0);
  const env = curve(120, (u) => Math.sin(Math.min(1, u * 4) * Math.PI * 0.5) * Math.min(1, (1 - u) * 4)
    * (0.7 + 0.3 * Math.sin(u * dur * 9)));
  curveEnv(A, g.gain, t0, env, dur);
  const s = bufSrc(A, v, A.buf.brown, 0.9, t0, dur + 0.05, r() * 3);
  s.connect(lp); lp.connect(g); g.connect(v.input);
  // axle creaks along the way
  const n = 3 + ((r() * 4) | 0);
  for (let i = 0; i < n; i++) {
    const ct = t0 + 0.3 + (i / n) * (dur - 0.6) + r() * 0.2;
    const cf = 380 + r() * 500;
    const co = osc(A, v, 'sawtooth', cf, ct, 0.24);
    co.frequency.exponentialRampToValueAtTime(cf * (1.1 + r() * 0.4), ct + 0.22);
    const cb = filter(A.actx, 'bandpass', 1200, 8);
    const cg = gainNode(A, 0);
    envelope(cg.gain, ct, { peak: 0.09, attack: 0.03, decay: 0.18 });
    co.connect(cb); cb.connect(cg); cg.connect(v.input);
  }
  return v;
}

/** Generic splash (entering water, big impacts). */
export function splash(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({
    dest: A.bus.foley, position: o.position, volume: (o.volume || 1),
    duration: 1.2, ref: 3, rolloff: 1.6, max: 160,
  });
  if (!v) return null;
  splashLayer(A, v, t0, 1.2 * (o.size || 1), r);
  const lp = filter(A.actx, 'lowpass', 500, 1);
  const g = gainNode(A, 0);
  envelope(g.gain, t0, { peak: 0.5 * (o.size || 1), attack: 0.005, decay: 0.3 });
  const s = bufSrc(A, v, A.buf.brown, 1.2, t0, 0.6, r() * 3);
  s.connect(lp); lp.connect(g); g.connect(v.input);
  return v;
}

/** Underwater bubble burst. */
export function bubble(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({ dest: A.bus.ambient, volume: (o.volume || 1) * 0.3, duration: 0.3 });
  if (!v) return null;
  const n = 2 + ((r() * 4) | 0);
  for (let i = 0; i < n; i++) {
    const bt = t0 + r() * 0.15;
    const f0 = 300 + r() * 900;
    const o1 = osc(A, v, 'sine', f0, bt, 0.08);
    o1.frequency.exponentialRampToValueAtTime(f0 * (2 + r() * 2), bt + 0.05);
    const g = gainNode(A, 0);
    envelope(g.gain, bt, { peak: 0.25, attack: 0.002, decay: 0.05 });
    o1.connect(g); g.connect(v.input);
  }
  return v;
}

/* ------------------------------------------------------------- hit feedback */

/**
 * HIT MARKER — the one deliberately non-diegetic sound in the game.
 *
 * It has to be legible under the report of the rifle that caused it, which is
 * the loudest thing in the mix, and it must not be mistakable for the impact
 * itself (the impact is a soft thud out at the animal, delayed by the flight of
 * sound; this is instant and at the listener). So it goes on the UI bus with no
 * panner and no reverb send, it is a NARROW pitched tick rather than broadband,
 * and it sits in the 1.6–3 kHz window the rifle's own body leaves comparatively
 * free.
 *
 * Wound and kill are the same instrument played two different ways, because two
 * unrelated sounds would have to be learned separately:
 *   wound  one short bright tick, up-pitched, 30 ms — a question.
 *   kill   the same tick, then a second one a fourth BELOW it 70 ms later —
 *          a falling two-note figure, which is the oldest "that's finished"
 *          gesture there is, plus a little low body under it so it lands.
 */
export function hitmark(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const kill = !!o.kill;
  /*
   * The wound tick is louder RELATIVE to its own design than the kill, and
   * deliberately: measured offline through the full chain the first cut peaked
   * at 0.028 against the rifle's 0.346 — 22 dB down, i.e. underneath the report
   * of the shot that caused it, which is the one moment it has to be heard.
   * The kill gets its weight from a second tick and a low body instead of from
   * gain, so the two stay a fifth apart in loudness as well as in shape.
   */
  const v = A.voice({
    dest: A.bus.ui, volume: (o.volume || 1) * (kill ? 0.62 : 0.80),
    duration: kill ? 0.45 : 0.16,
  });
  if (!v) return null;
  const j = 0.985 + r() * 0.03;
  const tick = (at, f, peak, dec) => {
    const g = gainNode(A, 0);
    ring(g.gain, at, peak, 0.0009, dec);
    osc(A, v, 'sine', f, at, dec + 0.02).connect(g);
    // a touch of second partial keeps it from reading as a test tone
    const g2 = gainNode(A, 0);
    ring(g2.gain, at, peak * 0.34, 0.0009, dec * 0.55);
    osc(A, v, 'triangle', f * 2.02, at, dec * 0.6 + 0.02).connect(g2);
    // the click that makes it cut: a 6 ms bright grain through a tight band
    const bp = filter(A.actx, 'bandpass', f * 1.6, 3.2);
    const ng = gainNode(A, 0);
    envelope(ng.gain, at, { peak: peak * 0.9, attack: 0.0008, decay: 0.012 });
    bufSrc(A, v, A.buf.grainBright, 2.4, at, 0.03, r() * 0.1).connect(bp);
    bp.connect(ng);
    g.connect(v.input); g2.connect(v.input); ng.connect(v.input);
  };
  if (kill) {
    tick(t0, 1980 * j, 0.30, 0.055);
    tick(t0 + 0.072, 1480 * j, 0.34, 0.13);
    // low body, so a kill has weight a wound does not
    const lg = gainNode(A, 0);
    ring(lg.gain, t0 + 0.072, 0.16, 0.004, 0.22);
    osc(A, v, 'sine', 176 * j, t0 + 0.072, 0.25).connect(lg);
    lg.connect(v.input);
  } else {
    tick(t0, 2560 * j, 0.42, 0.055);
  }
  return v;
}

/**
 * Knife through hide. A slow wet rasp: brown noise swept through a moving
 * bandpass (the cut opening up as the blade travels), with a handful of
 * resistance grains where it catches on sinew.
 */
export function knife(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const dur = 0.34 + r() * 0.16;
  const v = A.voice({
    dest: A.bus.foley, position: o.position, volume: (o.volume || 1) * 0.75,
    duration: dur + 0.25, ref: 1.4, rolloff: 2.2, max: 30, panning: 'HRTF',
  });
  if (!v) return null;
  const f0 = 520 + r() * 160;
  const bp = filter(A.actx, 'bandpass', f0, 1.5);
  bp.frequency.setValueAtTime(f0, t0);
  bp.frequency.linearRampToValueAtTime(f0 * (2.4 + r() * 0.8), t0 + dur);
  const g = gainNode(A, 0);
  // uneven pressure — a draw cut is not a constant-velocity machine
  const env = curve(72, (u) => Math.sin(Math.min(1, u * 5) * Math.PI * 0.5)
    * (1 - u * u) * (0.62 + 0.38 * Math.sin(u * 17 + r() * 0.4)));
  curveEnv(A, g.gain, t0, env, dur);
  const s = bufSrc(A, v, A.buf.brown, 1.35, t0, dur + 0.05, r() * 3);
  s.connect(bp); bp.connect(g); g.connect(v.input);
  // wet low layer: the part that makes it read as flesh rather than sandpaper
  const lp = filter(A.actx, 'lowpass', 300 + r() * 120, 0.9);
  const lg = gainNode(A, 0);
  const lenv = curve(48, (u) => Math.sin(Math.min(1, u * 3) * Math.PI * 0.5) * (1 - u) * 0.7);
  curveEnv(A, lg.gain, t0, lenv, dur);
  bufSrc(A, v, A.buf.brown, 0.55, t0, dur + 0.05, r() * 3).connect(lp);
  lp.connect(lg); lg.connect(v.input);
  // catches
  const n = 1 + ((r() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const at = t0 + 0.06 + r() * (dur - 0.1);
    const cb = filter(A.actx, 'bandpass', 1300 + r() * 1400, 5);
    const cg = gainNode(A, 0);
    envelope(cg.gain, at, { peak: 0.10 + r() * 0.06, attack: 0.002, decay: 0.05 });
    bufSrc(A, v, A.buf.grainMid, 1.6 + r(), at, 0.06, r() * 0.1).connect(cb);
    cb.connect(cg); cg.connect(v.input);
  }
  return v;
}

/** A body hitting the dirt. Dull, broad, no ring at all. */
export function bodyfall(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const v = A.voice({
    dest: A.bus.foley, position: o.position, volume: (o.volume || 1) * 0.9,
    duration: 0.8, ref: 3, rolloff: 1.9, max: 90,
  });
  if (!v) return null;
  const lp = filter(A.actx, 'lowpass', 190 + r() * 60, 1.1);
  const g = gainNode(A, 0);
  envelope(g.gain, t0, { peak: 0.85, attack: 0.004, decay: 0.24 });
  bufSrc(A, v, A.buf.brown, 0.7, t0, 0.35, r() * 3).connect(lp);
  lp.connect(g); g.connect(v.input);
  // cloth and dust on top
  const bp = filter(A.actx, 'bandpass', 1500 + r() * 700, 1.0);
  const g2 = gainNode(A, 0);
  envelope(g2.gain, t0 + 0.01, { peak: 0.16, attack: 0.006, decay: 0.20 });
  bufSrc(A, v, A.buf.pink, 1.0, t0 + 0.01, 0.3, r() * 3).connect(bp);
  bp.connect(g2); g2.connect(v.input);
  return v;
}

/**
 * A lawman's whistle. Two overblown tones a semitone apart so they beat, which
 * is exactly what a pea whistle does, plus the breath noise through it.
 */
export function whistle(A, o = {}) {
  const r = A.rand;
  const t0 = o.at || A.now();
  const dur = 0.42 + r() * 0.18;
  const v = A.voice({
    dest: A.bus.foley, position: o.position, volume: (o.volume || 1) * 0.5,
    duration: dur + 0.4, ref: 12, rolloff: 1.25, max: 260,
  });
  if (!v) return null;
  const f = 2320 + r() * 180;
  const g = gainNode(A, 0);
  const env = curve(48, (u) => Math.sin(Math.min(1, u * 9) * Math.PI * 0.5)
    * Math.min(1, (1 - u) * 6) * (0.8 + 0.2 * Math.sin(u * 40)));
  curveEnv(A, g.gain, t0, env, dur);
  for (const [mul, lvl] of [[1, 0.34], [1.059, 0.30], [2.01, 0.09]]) {
    const oo = osc(A, v, 'sine', f * mul, t0, dur + 0.02);
    const og = gainNode(A, lvl);
    oo.connect(og); og.connect(g);
  }
  const bp = filter(A.actx, 'bandpass', f * 1.1, 1.4);
  const ng = gainNode(A, 0.09);
  bufSrc(A, v, A.buf.white, 1, t0, dur + 0.02, r() * 3).connect(bp);
  bp.connect(ng); ng.connect(g);
  g.connect(v.input);
  return v;
}

export const SYNTH = {
  footstep, hoof, thunder, gunshot, rifle, crackle, drip, cricket, cicada, bird,
  birdcall: birdCall, owl, coyote, anvil, piano, dog, creak, leather, clink,
  wagon, splash, bubble,
  // rifle mechanics — fired by Audio._updateWeapon off the weapon's animation
  lever, leverThrow, leverReturn, hammerBack, gateOpen, shellIn, gateClose,
  // hit feedback, skinning and the law
  hitmark, knife, bodyfall, whistle,
};
