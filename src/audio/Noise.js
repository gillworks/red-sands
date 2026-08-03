import { rng } from '../core/Context.js';

/**
 * Deterministic noise + impulse-response generation for the audio system.
 *
 * Everything here is synthesised from `rng(seed)` — never Math.random — so two
 * runs of the game produce bit-identical audio buffers. All buffers are built
 * once during init(); nothing in here allocates per-frame.
 */

/* --------------------------------------------------------------- generators */

function fillWhite(out, rand) {
  for (let i = 0; i < out.length; i++) out[i] = rand() * 2 - 1;
}

/** Paul Kellet's economical pink filter — 1/f to within ~0.05 dB, 10 Hz–20 kHz. */
function fillPink(out, rand) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rand() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.106;
    b6 = w * 0.115926;
  }
}

/** Leaky integrator → ~1/f² (brown/red). Used for wind body + thunder. */
function fillBrown(out, rand) {
  let b = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rand() * 2 - 1;
    b = (b + 0.019 * w) / 1.019;
    out[i] = b * 3.4;
  }
}

/** Peak-normalise to `peak`, guarding silence. */
function normalise(out, peak = 0.92) {
  let m = 0;
  for (let i = 0; i < out.length; i++) { const a = out[i] < 0 ? -out[i] : out[i]; if (a > m) m = a; }
  if (m < 1e-6) return;
  const g = peak / m;
  for (let i = 0; i < out.length; i++) out[i] *= g;
}

/**
 * Fold the tail of the buffer back over the head with an equal-power crossfade
 * so a looping BufferSource has no seam click. The buffer must have been
 * generated `fade` samples longer than the final length.
 */
function foldLoop(src, len, fade) {
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const a = Math.cos(t * Math.PI * 0.5);   // head fades in from the wrap
    const b = Math.sin(t * Math.PI * 0.5);
    src[i] = src[i] * b + src[len + i] * a;
  }
}

/**
 * @param {BaseAudioContext} actx
 * @returns {AudioBuffer} seamlessly loopable, deterministic noise.
 */
export function makeNoiseBuffer(actx, {
  seconds = 4, channels = 2, type = 'white', seed = 1, loopFade = 0.3, peak = 0.9,
} = {}) {
  const sr = actx.sampleRate;
  const len = Math.max(64, Math.round(seconds * sr));
  const fade = Math.min(len - 1, Math.round(loopFade * sr));
  const buf = actx.createBuffer(channels, len, sr);
  for (let c = 0; c < channels; c++) {
    // Generate len+fade, fold, then copy the first len samples in.
    const tmp = new Float32Array(len + fade);
    const rand = rng((seed * 2654435761 + c * 40503) >>> 0);
    if (type === 'pink') fillPink(tmp, rand);
    else if (type === 'brown') fillBrown(tmp, rand);
    else fillWhite(tmp, rand);
    foldLoop(tmp, len, fade);
    normalise(tmp, peak);
    buf.getChannelData(c).set(tmp.subarray(0, len));
  }
  return buf;
}

/**
 * A synthetic room/landscape impulse response.
 *
 * Structure: pre-delay → sparse discrete early reflections → exponentially
 * decaying diffuse tail with progressive HF damping (air + surface absorption).
 * The two channels use independent noise and slightly different tap times, which
 * is what gives the reverb its stereo width without any explicit widening.
 *
 * NORMALISATION IS BY ENERGY, NOT BY PEAK, and that is not a detail.
 * A ConvolverNode with `normalize = false` multiplies broadband signal by
 * sqrt(Σ h²) — for a 2.9 s tail that is a factor of ~16, i.e. **+24 dB**. Peak-
 * normalising the buffer says nothing about that number: it pins the loudest
 * early reflection, which is one seed-dependent sample, and lets the delivered
 * reverb level float with the decay length. The measured result was every send
 * in the mix arriving 24 dB hotter than its dial said, which is what "sounds
 * like a metal room" is. `gain` is now the actual broadband voltage gain of the
 * convolution: 1.0 means a send of 0.05 returns reverb 26 dB under the dry
 * signal, exactly as written.
 */
export function makeImpulseResponse(actx, {
  seconds = 2.4, decay = 2.0, predelay = 0.014, damping = 1.0,
  earlyCount = 12, earlyGain = 0.55, earlySpread = 0.085,
  hfStart = 8500, hfEnd = 620, seed = 7, gain = 1.0,
} = {}) {
  const sr = actx.sampleRate;
  const len = Math.max(128, Math.round(seconds * sr));
  const buf = actx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const rand = rng((seed * 1103515245 + c * 12345 + 7) >>> 0);
    const pre = Math.round((predelay + (c === 1 ? 0.0027 : 0)) * sr);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const u = t / seconds;
      // Echo density ramps up: sparse at the start (discrete), dense later.
      const dens = Math.min(1, 0.18 + t * 9);
      let s = rand() * 2 - 1;
      if (rand() > dens) s *= 0.12;
      // -60 dB at t = decay
      const env = Math.exp(-t * (6.9078 / Math.max(0.05, decay)));
      // Progressive HF loss: cutoff glides hfStart → hfEnd across the tail.
      const fc = hfStart * Math.pow(hfEnd / hfStart, Math.min(1, u * damping));
      const a = Math.exp((-2 * Math.PI * fc) / sr);
      lp = s * (1 - a) + lp * a;
      d[i] = lp * env;
    }
    // Discrete early reflections on top of the diffuse bed.
    for (let e = 0; e < earlyCount; e++) {
      const tt = (0.006 + Math.pow(rand(), 1.4) * earlySpread) * sr;
      const idx = pre + Math.round(tt);
      if (idx >= len) continue;
      const amp = earlyGain * Math.exp(-(tt / sr) * 14) * (rand() * 2 - 1);
      d[idx] += amp;
      if (idx + 1 < len) d[idx + 1] += amp * 0.5;
    }
  }
  // One gain for both channels so the stereo image is preserved, derived from
  // the mean per-channel energy → the convolution's broadband voltage gain.
  let e = 0;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) e += d[i] * d[i];
  }
  e *= 0.5;
  if (e > 1e-12) {
    const g = gain / Math.sqrt(e);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] *= g;
    }
  }
  return buf;
}

/**
 * A short shaped "grain" buffer — a decaying noise burst. Used as the seed for
 * footstep grit, fire pops and rain drips so those one-shots need one source
 * node instead of an oscillator stack.
 */
export function makeGrainBuffer(actx, { seconds = 0.16, decay = 26, seed = 11, tilt = 0 } = {}) {
  const sr = actx.sampleRate;
  const len = Math.max(32, Math.round(seconds * sr));
  const buf = actx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const rand = rng(seed >>> 0);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    let s = rand() * 2 - 1;
    if (tilt > 0) { lp = s * (1 - tilt) + lp * tilt; s = lp; }        // darker
    else if (tilt < 0) { lp = s * 0.5 + lp * 0.5; s = s - lp; }       // brighter
    d[i] = s * Math.exp(-t * decay);
  }
  normalise(d, 0.95);
  return buf;
}
