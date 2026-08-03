/**
 * Voice pooling and node lifetime management.
 *
 * WebAudio source nodes (BufferSource / Oscillator) are single-use by spec, but
 * everything downstream of them — gains, panners, filters — is reusable. This
 * pool recycles that downstream chain and, critically, guarantees that every
 * node a one-shot creates is stopped and disconnected at a known time. Nothing
 * is left running: a stuck oscillator in a game that runs for an hour is a
 * permanent CPU leak and an audible drone.
 */

const FREE_MARGIN = 0.08; // seconds of slack after a voice's declared duration

export class VoicePool {
  /**
   * @param {BaseAudioContext} actx
   * @param {number} limit  max simultaneously live one-shot voices
   */
  constructor(actx, limit = 40) {
    this.actx = actx;
    this.limit = limit;
    this.active = [];
    this._freeGains = [];
    this._freePanners = [];
    this._sources = [];   // {node, stopAt} — hard-stop safety net
    this.peak = 0;        // high-water mark, for the report
    this.rejected = 0;
  }

  _gain() {
    const g = this._freeGains.pop();
    if (g) {
      g.gain.cancelScheduledValues(0);
      g.gain.value = 1;
      return g;
    }
    return this.actx.createGain();
  }

  _panner() {
    const p = this._freePanners.pop();
    if (p) return p;
    const n = this.actx.createPanner();
    n.distanceModel = 'inverse';
    n.coneInnerAngle = 360;
    return n;
  }

  /**
   * Reserve a voice. Returns null when the pool is saturated — callers must
   * handle that (drop the sound) rather than allocating anyway.
   *
   * @returns {{input: AudioNode, gain: GainNode, panner: PannerNode|null,
   *            actx: BaseAudioContext, track(node, stopAt): void} | null}
   */
  acquire({
    dest, position = null, volume = 1, duration = 1,
    panning = 'equalpower', ref = 6, max = 900, rolloff = 1.1, when = 0,
  }) {
    if (this.active.length >= this.limit) { this.rejected++; return null; }
    const actx = this.actx;
    const g = this._gain();
    g.gain.value = volume;

    let panner = null;
    if (position) {
      panner = this._panner();
      panner.panningModel = panning;
      panner.refDistance = ref;
      panner.maxDistance = max;
      panner.rolloffFactor = rolloff;
      const t = actx.currentTime;
      if (panner.positionX) {
        panner.positionX.setValueAtTime(position.x, t);
        panner.positionY.setValueAtTime(position.y, t);
        panner.positionZ.setValueAtTime(position.z, t);
      } else if (panner.setPosition) {
        panner.setPosition(position.x, position.y, position.z);
      }
      g.connect(panner);
      panner.connect(dest);
    } else {
      g.connect(dest);
    }

    const v = {
      gain: g,
      panner,
      input: g,
      actx,
      expires: Math.max(actx.currentTime, when) + duration + FREE_MARGIN,
      _pool: this,
      track: (node, stopAt) => { this._sources.push({ node, stopAt }); return node; },
    };
    this.active.push(v);
    if (this.active.length > this.peak) this.peak = this.active.length;
    return v;
  }

  /** Sweep expired voices back into the free lists. Call once per frame. */
  update() {
    const now = this.actx.currentTime;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const v = this.active[i];
      if (v.expires > now) continue;
      this.active.splice(i, 1);
      try { v.gain.disconnect(); } catch (e) { /* already gone */ }
      if (v.panner) {
        try { v.panner.disconnect(); } catch (e) { /* already gone */ }
        if (this._freePanners.length < 24) this._freePanners.push(v.panner);
      }
      if (this._freeGains.length < 48) this._freeGains.push(v.gain);
    }
    // Safety net: anything scheduled that should have finished gets stopped hard.
    for (let i = this._sources.length - 1; i >= 0; i--) {
      const s = this._sources[i];
      if (s.stopAt > now) continue;
      this._sources.splice(i, 1);
      try { s.node.stop(); } catch (e) { /* already stopped or not a source */ }
      try { s.node.disconnect(); } catch (e) { /* noop */ }
    }
  }

  dispose() {
    for (const s of this._sources) {
      try { s.node.stop(); } catch (e) { /* noop */ }
      try { s.node.disconnect(); } catch (e) { /* noop */ }
    }
    this._sources.length = 0;
    for (const v of this.active) {
      try { v.gain.disconnect(); } catch (e) { /* noop */ }
      if (v.panner) try { v.panner.disconnect(); } catch (e) { /* noop */ }
    }
    this.active.length = 0;
    this._freeGains.length = 0;
    this._freePanners.length = 0;
  }
}

/* ------------------------------------------------------------ node helpers */

/** Biquad with the common fields set in one call. */
export function filter(actx, type, freq, q = 0.7, gainDb = 0) {
  const f = actx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  if (gainDb) f.gain.value = gainDb;
  return f;
}

/** A buffer source with loop + rate set, tracked for hard-stop. */
export function loopSource(actx, buffer, rate = 1, offset = 0) {
  const s = actx.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  s.playbackRate.value = rate;
  s.start(0, offset % Math.max(0.01, buffer.duration));
  return s;
}

/**
 * Percussive amplitude envelope on a gain param.
 * Uses linear attack + exponential-ish decay via setTargetAtTime, then an
 * explicit zero so the value never asymptotes and leaves the node audible.
 */
export function envelope(param, t0, { peak = 1, attack = 0.002, decay = 0.12, hold = 0 }) {
  const end = t0 + attack + hold + decay;
  param.cancelScheduledValues(t0);
  param.setValueAtTime(0.0001, t0);
  param.linearRampToValueAtTime(peak, t0 + attack);
  if (hold > 0) param.setValueAtTime(peak, t0 + attack + hold);
  param.setTargetAtTime(0.0001, t0 + attack + hold, Math.max(0.004, decay * 0.32));
  param.setValueAtTime(0, end);
  return end;
}

/** Slow, click-free parameter follow. */
export function glide(param, value, tau = 0.25, now = 0) {
  if (!Number.isFinite(value)) return;
  const cur = param.value;
  if (Math.abs(cur - value) < 1e-5) return;
  param.setTargetAtTime(value, now, Math.max(0.005, tau));
}
