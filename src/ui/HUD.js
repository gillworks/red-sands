import * as THREE from 'three';
import { Regions, timePhrase } from './Regions.js';
import { PauseMenu } from './PauseMenu.js';
import { MOUNT_RANGE } from '../player/Horse.js';

/**
 * ============================================================================
 *  HUD — as little as possible, for as short a time as possible.
 * ============================================================================
 *
 * Everything lives on one 2D canvas overlay drawn at true device resolution:
 * a compass strip that surfaces while you are moving and sinks again when you
 * stop, two condition arcs that only exist while they are not full, a
 * contextual prompt, and a location title card. Warm ink on nothing, thin
 * strokes, low alpha — the image is the thing being looked at and the HUD is
 * not allowed to compete with it.
 *
 * IN CAPTURE MODE (`?capture=1`) NOTHING IS CREATED AT ALL — no canvas, no DOM,
 * no listeners — so the screenshot harness judges the world and only the world.
 *
 * Public surface for other systems:
 *   setPrompt(key, label, ttl)      show a contextual prompt
 *   clearPrompt()
 *   titleCard(name, subtitle)       force a location card
 *   notify(text)                    a single transient line
 *   setVisible(bool) / toggle()
 *   damage(amount) / setStamina(v)
 */

const FONT = '"Times New Roman", "Hoefler Text", Georgia, serif';

/* Warm parchment ink, cool-neutral shadow. */
const INK = [235, 224, 203];
const INK_DIM = [206, 191, 163];
const GOLD = [217, 178, 104];
const BLOOD = [178, 88, 66];
/**
 * The only two saturated colours allowed anywhere on this HUD, and they are
 * spent on the single message the player asked to be told: hit, or killed.
 * Pulled toward the film grade (a little dusty, a little warm) rather than
 * pure #F80/#F00, which would sit on top of the image like a sticker.
 */
const HIT_ORANGE = [240, 146, 52];
const HIT_RED = [223, 61, 43];
/** Seconds the reticle carries a hit. */
const HIT_DECAY = 0.42;

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export class HUD {
  static id = 'hud';

  constructor(ctx) {
    this.ctx = ctx;
    this.active = false;
    this.visible = true;
    this.opacity = 1;
    this.canvas = null;
    this.c2d = null;
    this.dpr = 1;
    this.cssW = 1280;
    this.cssH = 720;

    this.regions = new Regions(ctx);

    // element visibility envelopes, 0..1
    this.a = {
      compass: 0, cores: 0, prompt: 0, title: 0, hint: 0, notice: 0, keys: 0, lock: 0,
      // the weapon block: ammo, pelts, breath. Only up while it matters.
      weapon: 0, reticle: 0,
      // the law, and the skinning progress ring. Both are absent until they
      // are not, and both fade out completely — no empty slots, no chrome.
      wanted: 0, skin: 0,
    };
    /** Hit feedback on the reticle. -1 = nothing has been hit. */
    this._hitT = -1;
    this._hitKill = false;
    /* First-run teaching. The control line is up until you have shown you
     * understand it — measured in metres actually travelled, not in seconds —
     * and then it goes for good. Nobody should have to read a wall of text to
     * find out that W walks. */
    this._taught = false;
    this._taughtT = 0;
    this._startDist = null;
    /* Per-control teaching credit. A hint retires when the player has actually
     * used that control — held keys earn credit by the second, discrete keys by
     * the press — so the line teaches and then gets out of the way one item at
     * a time instead of all at once on a timer. */
    this._credit = {
      move: 0, run: 0, crouch: 0, mount: 0, aim: 0, fire: 0, breath: 0, reload: 0,
      // riding is its own lesson: knowing W walks does not tell you W rides
      ride: 0, spur: 0, rein: 0,
    };
    this._down = new Set();
    this._mouse = new Set();
    this._locked = false;
    this._compassHold = 0;
    this._coresHold = 0;
    this._titleT = -1;
    this._title = null;
    this._notice = null;
    this._noticeT = 0;
    this._prompt = null;
    this._promptT = 0;

    this.health = 1;
    this.stamina = 1;
    this._staminaLock = 0;

    this._heading = 0;
    this._prevHeading = 0;
    this._prevPos = new THREE.Vector3();
    this._moveEnergy = 0;
    this._elapsed = 0;
    this._tmp = new THREE.Vector3();
    this._unbind = [];
    this.menu = null;
    /** Scratch glyph-width buffer so text layout allocates nothing per frame. */
    this._wbuf = new Float64Array(64);
    /** Cached scrim gradients, rebuilt on resize only. */
    this._gradBot = null;
    this._gradTop = null;
    this._scrimBotH = 0;
    this._scrimTopH = 0;
    /** Running ceiling for the stack of centred lines along the bottom. */
    this._stackY = 0;
  }

  /* ------------------------------------------------------------------ boot */

  async init() {
    const params = typeof location !== 'undefined'
      ? new URLSearchParams(location.search) : new URLSearchParams('');
    // THE capture rule: the HUD does not exist when the harness is shooting.
    if (params.get('capture') === '1' || params.get('hud') === '0') {
      this.active = false;
      return;
    }
    if (typeof document === 'undefined') return;

    const cv = document.createElement('canvas');
    cv.id = 'rs-hud';
    cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:20';
    (document.getElementById('app') || document.body).appendChild(cv);
    this.canvas = cv;
    this.c2d = cv.getContext('2d');
    this.active = true;

    this.regions.build();
    this.menu = new PauseMenu(this.ctx, this);
    this._bindKeys();
    this._layout();

    this._prevPos.copy(this.ctx.camera.position);
    this._prevHeading = this._headingOf();

    // Announce wherever we start, once the world is up.
    const off = this.ctx.on('ready', () => this._checkRegion(true));
    if (off) this._unbind.push(off);
    const off2 = this.ctx.on('teleport', () => {
      this._prevPos.copy(this.ctx.camera.position);
      this._checkRegion(true);
    });
    if (off2) this._unbind.push(off2);
  }

  _bindKeys() {
    const onKey = (e) => {
      this._down.add(e.code);
      if (e.repeat) return;
      /* A press is worth most of a lesson on its own for the one-shot verbs;
       * the held verbs earn theirs per second in update(). */
      const cr = this._credit;
      if (e.code === 'KeyE') cr.mount += 1.3;
      else if (e.code === 'KeyR') cr.reload += 1.3;
      if (e.code === 'Escape') { this.menu.toggle(); e.preventDefault(); }
      else if (e.code === 'KeyH' && !e.ctrlKey && !e.metaKey) this.toggle();
      else if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey) {
        const A = this.ctx.get('audio');
        if (A && A.toggleMute) this.notify(A.toggleMute() ? 'Sound off' : 'Sound on');
      }
    };
    const onKeyUp = (e) => { this._down.delete(e.code); };
    const onBlur = () => { this._down.clear(); this._mouse.clear(); };
    const onDown = (e) => {
      this._mouse.add(e.button);
      if (e.button === 0) this._credit.fire += 1.0;
      else if (e.button === 2) this._credit.aim += 0.6;
    };
    const onUp = (e) => { this._mouse.delete(e.button); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('mousedown', onDown, { passive: true });
    window.addEventListener('mouseup', onUp, { passive: true });
    this._unbind.push(() => window.removeEventListener('keydown', onKey));
    this._unbind.push(() => window.removeEventListener('keyup', onKeyUp));
    this._unbind.push(() => window.removeEventListener('blur', onBlur));
    this._unbind.push(() => window.removeEventListener('mousedown', onDown));
    this._unbind.push(() => window.removeEventListener('mouseup', onUp));
  }

  /** Credit for the controls you have to hold down, paid by the second. */
  _accrue(dt) {
    const d = this._down, cr = this._credit, k = dt * 0.9;
    const mounted = this.ctx.player.mode === 'mounted';
    const turn = d.has('KeyA') || d.has('KeyD') || d.has('ArrowLeft') || d.has('ArrowRight');
    if (d.has('KeyW') || d.has('KeyS') || d.has('ArrowUp') || d.has('ArrowDown') || turn) {
      if (mounted) { cr.ride += k; if (turn) cr.rein += k; } else cr.move += k;
    }
    if (d.has('ShiftLeft') || d.has('ShiftRight')) {
      if (this._wpn && this._wpn.aim01 > 0.5) cr.breath += k;
      else if (mounted) cr.spur += k;
      else cr.run += k;
    }
    if (d.has('ControlLeft') || d.has('ControlRight') || d.has('KeyC')) cr.crouch += k;
    if (this._mouse.has(2)) cr.aim += k;
  }

  /** 1 while the lesson is still owed, easing to 0 once it has been learned. */
  _hintAlpha(id) {
    const c = this._credit[id];
    if (c == null) return 1;
    if (c <= LEARN) return 1;
    const t = Math.min(1, (c - LEARN) / 0.9);
    return 1 - ease(t);
  }

  _layout() {
    if (!this.canvas) return;
    const el = document.getElementById('app') || document.body;
    const w = el.clientWidth || window.innerWidth;
    const h = el.clientHeight || window.innerHeight;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.cssW = w; this.cssH = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    /* The floor used to be 0.72, which put the control labels at nine pixels of
     * tracked serif on a 720p screen — thin UI always fails at the low
     * resolution first, and this one did. */
    this.s = Math.max(0.86, Math.min(1.7, h / 900));
    this._gradBot = null;
    this._gradTop = null;
  }

  resize() { this._layout(); }

  /* --------------------------------------------------------- public surface */

  setVisible(v) { this.visible = !!v; }
  toggle() { this.visible = !this.visible; return this.visible; }

  setPrompt(key, label, ttl = 0.35) {
    this._prompt = { key: String(key || 'E'), label: String(label || '') };
    this._promptT = ttl;
  }

  clearPrompt() { this._promptT = 0; }

  titleCard(name, subtitle) {
    this._title = { name: String(name || ''), sub: subtitle == null ? '' : String(subtitle) };
    this._titleT = 0;
  }

  notify(text) { this._notice = String(text); this._noticeT = 2.6; }

  /**
   * "Did I hit it, and is it dead?" — the one question a hunting rifle in a
   * third-person camera cannot answer on its own, because the animal is 60 m
   * away and half behind a bush.
   *
   * @param {'hit'|'kill'} kind  a wound flashes ORANGE, a kill flashes RED.
   *
   * A kill outranks a wound if both land inside the same decay window (a
   * follow-up shot that finishes something must never downgrade the marker),
   * but a fresh wound after a kill restarts the clock as a wound, because by
   * then it is a different animal.
   */
  hitFeedback(kind) {
    const kill = kind === 'kill';
    if (this._hitT >= 0 && this._hitT < HIT_DECAY && this._hitKill && !kill) {
      // still showing a kill; re-arm the pulse but keep the colour
      this._hitT = 0;
      return;
    }
    this._hitT = 0;
    this._hitKill = kill;
  }

  damage(amount) {
    this.health = Math.max(0, Math.min(1, this.health - amount));
    this._coresHold = 4;
  }

  setStamina(v) { this.stamina = Math.max(0, Math.min(1, v)); this._coresHold = 3; }

  /* ------------------------------------------------------------- per-frame */

  update(dt) {
    if (!this.active) return;
    this._elapsed += dt;
    const ctx = this.ctx;

    /* --- movement energy: what wakes the compass up --------------------- */
    const cam = ctx.camera;
    const moved = this._tmp.copy(cam.position).sub(this._prevPos).length();
    this._prevPos.copy(cam.position);
    this._heading = this._headingOf();
    let dh = this._heading - this._prevHeading;
    while (dh > 180) dh -= 360;
    while (dh < -180) dh += 360;
    this._prevHeading = this._heading;
    const turnRate = Math.abs(dh) / Math.max(1e-4, dt);
    const speed = moved / Math.max(1e-4, dt);
    const moving = speed > 0.35 || turnRate > 14;
    this._moveEnergy = moving ? 1 : Math.max(0, this._moveEnergy - dt * 0.7);
    if (moving) this._compassHold = 2.4;
    else this._compassHold = Math.max(0, this._compassHold - dt);

    /* --- condition arcs ------------------------------------------------- */
    const sprint = ctx.player.speed01 || 0;
    const sub = ctx.env.cameraSubmerged;
    if (sub) {
      this.stamina = Math.max(0, this.stamina - dt * 0.28);
      if (this.stamina <= 0.001) this.health = Math.max(0, this.health - dt * 0.08);
      this._coresHold = 3;
    } else if (sprint > 0.62) {
      this.stamina = Math.max(0, this.stamina - dt * (0.10 + (sprint - 0.62) * 0.5));
      this._coresHold = 3;
    } else {
      const before = this.stamina;
      this.stamina = Math.min(1, this.stamina + dt * 0.16);
      if (this.stamina > before) this._coresHold = Math.max(this._coresHold - dt, 0);
      this.health = Math.min(1, this.health + dt * 0.03);
    }
    const coresWanted = (this.health < 0.995 || this.stamina < 0.995 || this._coresHold > 0) ? 1 : 0;

    /* --- contextual prompt from nearby interactables -------------------- */
    this._promptT = Math.max(0, this._promptT - dt);
    if (this._promptT <= 0) this._scanInteractables();

    /* --- region title --------------------------------------------------- */
    this._checkRegion(false);
    if (this._titleT >= 0) {
      this._titleT += dt;
      if (this._titleT > 7.2) { this._titleT = -1; this._title = null; }
    }
    this._noticeT = Math.max(0, this._noticeT - dt);

    /* --- weapon ---------------------------------------------------------- */
    const player = ctx.get('player');
    this._wpn = player ? player.weapon : null;
    this._law = player ? player.wanted : null;
    this._skin = player ? player.skinning : null;
    if (this._hitT >= 0) {
      this._hitT += dt;
      if (this._hitT > HIT_DECAY) this._hitT = -1;
    }

    /* --- first-run teaching --------------------------------------------- */
    const pl = ctx.get('player');
    const dist = pl ? (pl.distanceTravelled || 0) : 0;
    if (this._startDist == null) this._startDist = dist;
    this._accrue(dt);
    if (!this._taught) {
      /* The line now retires item by item as each control is used, so the
       * blanket fallback can be later and gentler than the old 22 m — it is
       * only there for the verbs a player may simply never try. */
      const cr = this._credit;
      const tags = ctx.player.mode === 'mounted' ? MOUNTED_TAGS : FOOT_TAGS;
      let owed = 0;
      for (const t of tags) if (cr[t] <= LEARN) owed++;
      if (owed === 0 || dist - this._startDist > 40 || this._elapsed > 55) this._taught = true;
    } else this._taughtT += dt;
    this._locked = typeof document !== 'undefined'
      && !!this.canvas && document.pointerLockElement === ctx.canvas;

    /* --- envelopes ------------------------------------------------------ */
    const A = ctx.get('audio');
    const needGesture = !!(A && A.needsGesture && A.needsGesture());
    const paused = !!(this.menu && this.menu.open);
    const target = {
      compass: this._compassHold > 0 ? 1 : 0,
      cores: coresWanted,
      prompt: this._promptT > 0 ? 1 : 0,
      title: this._titleT >= 0 ? titleEnvelope(this._titleT) : 0,
      hint: needGesture && this._elapsed > 1.5 ? 1 : 0,
      notice: this._noticeT > 0 ? Math.min(1, this._noticeT / 0.4) : 0,
      keys: (!this._taught && this._elapsed > 1.1 && !paused) ? 1 : 0,
      lock: (!this._locked && this._elapsed > 1.1 && !paused && this._taughtT < 8) ? 1 : 0,
      weapon: (this._wpn && this._wpn.hudT > 0 && !paused) ? 1 : 0,
      /* A hit forces the reticle up even from the hip: the marker is worth
       * nothing if it only exists while you are already down the sights, and
       * the shot that most needs confirming is the snap shot. */
      reticle: (!paused && ((this._wpn && this._wpn.aim01 > 0.5) || this._hitT >= 0)) ? 1 : 0,
      wanted: (!paused && this._law
        && (this._law.level > 0 || this._law.state === 'warning')) ? 1 : 0,
      skin: (!paused && this._skin) ? 1 : 0,
    };
    const rate = {
      compass: [3.6, 1.1], cores: [4.5, 0.9], prompt: [7, 3], title: [1, 1],
      hint: [1.2, 3], notice: [6, 2], keys: [1.6, 0.8], lock: [1.8, 1.6],
      weapon: [8, 1.6], reticle: [12, 9], wanted: [5, 1.0], skin: [9, 5],
    };
    for (const k in this.a) {
      const t = target[k];
      const r = t > this.a[k] ? rate[k][0] : rate[k][1];
      this.a[k] += (t - this.a[k]) * Math.min(1, dt * r);
      if (Math.abs(this.a[k] - t) < 0.002) this.a[k] = t;
    }
    this.opacity += ((this.visible ? 1 : 0) - this.opacity) * Math.min(1, dt * 6);
  }

  lateUpdate() {
    if (!this.active) return;
    this._draw();
  }

  _headingOf() {
    const d = this.ctx.camera.getWorldDirection(this._tmp);
    // 0 = north (−Z), 90 = east (+X)
    return (Math.atan2(d.x, -d.z) * 180) / Math.PI;
  }

  _checkRegion(force) {
    const p = this.ctx.camera.position;
    const changed = this.regions.update(p.x, p.z);
    if (changed || (force && this.regions.current)) {
      const reg = this.regions.current;
      if (!reg) return;
      const h = this.ctx.env.timeOfDay;
      this.titleCard(reg.label, timePhrase(h));
    }
  }

  _scanInteractables() {
    const ctx = this.ctx;
    /*
     * Interaction range is measured from the PLAYER, not from the camera.
     * The camera lives four metres behind him, so a camera-relative test was
     * simply wrong — and the mount prompt keyed off `ctx.player.horse`, which
     * is only populated once you are ALREADY mounted, so it could never fire.
     * The result was a first-time player standing next to a saddled horse with
     * nothing on screen telling them E does anything.
     */
    const p = ctx.player.position;
    let best = null, bd = 1e9;
    const consider = (pos, key, label, radius) => {
      if (!pos) return;
      const d = Math.hypot(pos.x - p.x, pos.z - p.z);
      if (d < radius && d < bd) { bd = d; best = { key, label }; }
    };
    // A carcass at your feet outranks everything else — Player has already
    // resolved the E-key conflict with the horse, so if it published one, it won.
    const pl = ctx.get('player');
    if (pl && pl.skinning) { this._promptT = 0; return; }
    if (pl && pl.pickup) {
      this._prompt = { key: 'E', label: `Take ${pl.pickup.label}` };
      this._promptT = 0.3;
      return;
    }
    if (pl && pl.carcass) {
      this._prompt = { key: 'E', label: `Skin ${pl.carcass.species}` };
      this._promptT = 0.3;
      return;
    }
    if (ctx.player.mode === 'mounted') {
      // Only offered at a halt. A prompt that rides along at a gallop is
      // furniture, and furniture is exactly what this HUD is trying not to be.
      if ((ctx.player.speed01 || 0) < 0.06) best = { key: 'E', label: 'Dismount' };
    } else {
      const horse = ctx.get('horse');
      if (horse && horse.state) consider(horse.state.position, 'E', 'Mount', MOUNT_RANGE);
      const fire = ctx.poi.get('camp_fire');
      if (fire) consider(fire.pos || fire, 'E', 'Warm yourself', 4.2);
    }
    if (!best && ctx.world && ctx.world.ready && ctx.world.isWater) {
      for (let i = 0; i < 8 && !best; i++) {
        const a = (i / 8) * Math.PI * 2;
        const x = p.x + Math.cos(a) * 2.2, z = p.z + Math.sin(a) * 2.2;
        try {
          if (ctx.world.isWater(x, z)) best = { key: 'F', label: 'Drink' };
        } catch (e) { break; }
      }
    }
    if (best) { this._prompt = best; this._promptT = 0.3; }
  }

  /* ------------------------------------------------------------- rendering */

  _draw() {
    const c = this.c2d;
    if (!c) return;
    const W = this.cssW, H = this.cssH, s = this.s;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const G = this.opacity;
    if (G < 0.004) return;

    c.textBaseline = 'alphabetic';
    c.lineCap = 'round';
    c.lineJoin = 'round';

    /* Legibility floor.
     *
     * Pale ink at HUD opacities dies on bright, busy, high-frequency ground —
     * sunlit grass and gravel were eating the control line whole. The local
     * fix (a dark contour on every glyph, see `_text`/`_hairline`) is kept and
     * still does most of the work, but on its own it cannot beat terrain whose
     * luminance is changing every three pixels: the outline has nothing steady
     * to sit against.
     *
     * So the two bands that carry text get a scrim anchored to the frame edge:
     * a gradient that is strongest at the very edge and eases to nothing well
     * before the middle of the picture. Edge-anchored is the whole trick — it
     * reads as the same cinematic falloff a lens gives you, never as a panel,
     * and because it never closes it can never show a boundary. It is only
     * present while something is actually written there, and it scales with
     * that content's own opacity, so an empty screen stays completely empty. */
    const botA = Math.max(
      this.a.keys * 0.95, this.a.lock * 0.9, this.a.prompt * 0.85,
      this.a.title * 0.8, this.a.notice * 0.7,
      this.a.cores * 0.45, this.a.weapon * 0.5, this.a.hint * 0.7,
    );
    if (botA > 0.004) this._scrimBottom(c, W, H, s, 0.44 * botA * G);
    const topA = Math.max(this.a.compass * 0.36, this.a.wanted * 0.34);
    if (topA > 0.004) this._scrimTop(c, W, H, s, topA * G);
    /* The title card sits high enough to be above the scrim's knee, and it is
     * always over ground rather than sky, so it keeps its own pool of shade. */
    if (this.a.title > 0.004) {
      this._shade(c, W * 0.055 + 175 * s, H * 0.80 - 4 * s, 320 * s, 92 * s, 0.20 * this.a.title * G);
    }

    if (this.a.compass > 0.004) this._drawCompass(c, W, H, s, this.a.compass * G);
    if (this.a.wanted > 0.004) this._drawWanted(c, W, H, s, this.a.wanted * G);
    if (this.a.reticle > 0.004) this._drawReticle(c, W, H, s, this.a.reticle * G);
    if (this.a.weapon > 0.004) this._drawWeapon(c, W, H, s, this.a.weapon * G);
    if (this.a.cores > 0.004) this._drawCores(c, W, H, s, this.a.cores * G);
    if (this.a.title > 0.004) this._drawTitle(c, W, H, s, this.a.title * G);
    /* The three centred lines are a stack, not three fixed positions. Each one
     * that draws pushes the ceiling up for the next, so when the control hints
     * retire a row — or go entirely — the lock hint and the prompt slide down
     * into the space instead of sitting on top of it. */
    this._stackY = H - 64 * s;
    if (this.a.keys > 0.004) this._drawControls(c, W, H, s, this.a.keys * G);
    if (this.a.lock > 0.004) this._drawLockHint(c, W, H, s, this.a.lock * G);
    if (this.a.prompt > 0.004 && !this._skin) this._drawPrompt(c, W, H, s, this.a.prompt * G);
    if (this.a.skin > 0.004) this._drawSkin(c, W, H, s, this.a.skin * G);
    if (this.a.notice > 0.004) this._drawNotice(c, W, H, s, this.a.notice * G);
    if (this.a.hint > 0.004) this._drawHint(c, W, H, s, this.a.hint * G);
  }

  /* --- weapon ------------------------------------------------------------- */

  /**
   * The sights, not a crosshair.
   *
   * The rifle has real iron sights and the camera is looking down them, so the
   * screen furniture only has to say "the shot goes HERE" without drawing a
   * videogame reticle over the middle of a landscape. Four short marks with a
   * wide gap: the eye completes the centre on its own, and it disappears the
   * instant the sights come down.
   */
  _drawReticle(c, W, H, s, A) {
    const w = this._wpn;
    const cx = Math.round(W * 0.5) + 0.5;
    const cy = Math.round(H * 0.5) + 0.5;
    // The gap breathes with the actual spread — the marks open when the sway
    // is running away from you and close when you hold your breath.
    /*
     * Measured on a 1280x720 frame the first cut was four 4 px hairlines at
     * 50 % over sunlit grass — i.e. nothing at all. Restraint is not the same
     * thing as invisibility, and this is the one mark the player has to be able
     * to put on an animal.
     */
    /*
     * ---- HIT FEEDBACK -----------------------------------------------------
     * `e` is the decay, 1 at the instant of the hit, 0 at HIT_DECAY. Everything
     * the marker does is driven off it so the whole gesture is ONE event with
     * one falling envelope rather than four independent animations:
     *
     *   colour    snaps to orange/red immediately (min(1, e*2.6)) and bleeds
     *             back to ink over the tail — a hit has to be legible on the
     *             first frame or it is not feedback, it is decoration.
     *   scale     the marks kick outward and the strokes fatten, then settle;
     *             the eye reads the MOVEMENT before it reads the hue, which is
     *             what makes it feel like an impact rather than a light bulb.
     *   rotation  a kill twists the cross 45 degrees into an X. It costs
     *             nothing and it is the difference the player has to read at a
     *             glance, so it is carried redundantly in shape as well as in
     *             colour — worth it for anyone who cannot separate the two.
     */
    const raw = this._hitT >= 0 ? 1 - this._hitT / HIT_DECAY : 0;
    const e = raw > 0 ? raw * raw : 0;
    const kill = this._hitKill;
    const tint = Math.min(1, e * 2.6);
    const col = tint > 0.002
      ? mixCol(INK, kill ? HIT_RED : HIT_ORANGE, tint) : INK;

    const gap = (10 + (w ? (w.sway01 || 0) * 7 + (1 - w.aim01) * 16 : 0)) * s
      + e * 11 * s;
    const len = (9 + e * 5) * s;
    const wid = Math.max(1, (1.3 + e * 1.5) * s);
    const rot = kill ? e * (Math.PI * 0.25) : 0;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    for (let i = 0; i < 4; i++) {
      const bx = i === 0 ? -1 : i === 1 ? 1 : 0;
      const by = i === 2 ? -1 : i === 3 ? 1 : 0;
      const dx = bx * cr - by * sr;
      const dy = bx * sr + by * cr;
      this._hairline(c, cx + dx * gap, cy + dy * gap,
        cx + dx * (gap + len), cy + dy * (gap + len),
        col, (0.80 + e * 0.20) * A, wid);
    }
    /* A kill also gets a thin expanding ring — the "it is finished" beat,
     * outside the marks so it never fights them for the centre. */
    if (kill && raw > 0.002) {
      const rr = gap + len + (1 - raw) * 16 * s;
      c.lineWidth = Math.max(1, 1.2 * s);
      c.strokeStyle = rgba(HIT_RED, 0.55 * raw * raw * A);
      c.beginPath(); c.arc(cx, cy, rr, 0, Math.PI * 2); c.stroke();
    }
    c.fillStyle = `rgba(7,6,5,${0.5 * A})`;
    c.beginPath(); c.arc(cx, cy, Math.max(1.8, (2.0 + e * 1.4) * s), 0, Math.PI * 2); c.fill();
    c.fillStyle = rgba(tint > 0.002 ? mixCol(GOLD, kill ? HIT_RED : HIT_ORANGE, tint) : GOLD,
      0.9 * A);
    c.beginPath(); c.arc(cx, cy, Math.max(1.1, (1.3 + e * 1.1) * s), 0, Math.PI * 2); c.fill();
  }

  /* --- the law ------------------------------------------------------------ */

  /**
   * WANTED STARS.
   *
   * Under the compass, centred, in the same warm ink and the same thin stroke
   * as everything else — the restraint is not decoration, it is the reason the
   * stars land at all. A HUD that always has furniture on it cannot tell you
   * anything by putting furniture on it.
   *
   * Three states, all drawn by the same routine:
   *   WARNING  one hollow star, pulsing, while the witness is still shouting
   *            and before the crime has registered. This is the beat.
   *   WANTED   `level` filled stars. No empty slots — an empty slot is a
   *            promise that you will fill it, and this HUD does not do that.
   *   SEEN     while somebody currently has eyes on you the stars breathe;
   *            when they stop, the pulse stops, which is the player's cue that
   *            the level is now bleeding off.
   */
  _drawWanted(c, W, H, s, A) {
    const L = this._law;
    if (!L) return;
    const warn = L.state === 'warning';
    const n = warn ? 1 : Math.max(1, Math.round(L.levelSmooth));
    const r = 11 * s;
    const pitch = 28 * s;
    const cy = 86 * s;
    const x0 = W * 0.5 - (n - 1) * pitch * 0.5;
    const t = this._elapsed;
    // the warning pulse is fast and urgent; "seen" is a slow breath
    /* The warning pulse must never dip below 0.72: measured on the town street
     * at a 0.55 floor the empty star simply disappeared at the trough, so the
     * one element whose whole job is to say "something is about to happen"
     * spent half its life invisible. Pulse it, do not blink it. */
    const pulse = warn ? 0.86 + 0.14 * Math.sin(L.grace01 * Math.PI * 7)
      : (L.seen ? 0.86 + 0.14 * Math.sin(t * 4.2) : 1);

    for (let i = 0; i < n; i++) {
      const x = Math.round(x0 + i * pitch) + 0.5;
      const filled = !warn && i < L.levelSmooth - 0.08;
      // the newest star pops in
      const pop = (!warn && i === Math.round(L.levelSmooth) - 1)
        ? 1 + (L.starPop || 0) * 0.55 : 1;
      const rr = r * pop * (filled ? 1 : 0.94);
      star(c, x, cy, rr, rr * 0.42);
      c.strokeStyle = `rgba(7,6,5,${0.5 * A})`;
      c.lineWidth = Math.max(1, 1.2 * s) + 1.8;
      c.stroke();
      star(c, x, cy, rr, rr * 0.42);
      if (filled) {
        c.fillStyle = rgba(GOLD, 0.90 * pulse * A);
        c.fill();
        c.strokeStyle = rgba(INK, 0.5 * A);
      } else {
        c.strokeStyle = rgba(warn ? INK : INK_DIM, (warn ? 0.95 : 0.4) * pulse * A);
      }
      c.lineWidth = Math.max(1, (warn ? 1.9 : 1.25) * s);
      c.stroke();
    }
    if (warn) {
      this._text(c, 'you were seen', W * 0.5, cy + r + 17 * s, {
        size: 13 * s, track: 0.16, align: 'center',
        alpha: 0.95 * pulse * A, colour: INK, shadow: 1.0, outline: 0.9,
      });
    } else if (L.bounty > 0) {
      this._text(c, `$${L.bounty}`, W * 0.5, cy + r + 15 * s, {
        size: 11.5 * s, track: 0.16, align: 'center',
        alpha: 0.55 * A, colour: INK_DIM, shadow: 0.95,
      });
    }
  }

  /* --- skinning ------------------------------------------------------------ */

  /**
   * A ring that fills while the knife works, where the E prompt used to be —
   * same place, same size, same language, so the prompt appears to BECOME the
   * progress rather than being replaced by a different piece of UI.
   */
  _drawSkin(c, W, H, s, A) {
    const sk = this._skin;
    if (!sk) return;
    const p = Math.max(0, Math.min(1, sk.t / sk.dur));
    const y = this._stackY - 28 * s;
    const r = 15 * s;
    const cx = W * 0.5;
    const START = -Math.PI * 0.5;

    c.lineWidth = Math.max(1.4, 2.4 * s) + 1.8;
    c.strokeStyle = `rgba(7,6,5,${0.42 * A})`;
    c.beginPath(); c.arc(cx, y, r, 0, Math.PI * 2); c.stroke();
    c.lineWidth = Math.max(1.4, 2.2 * s);
    c.strokeStyle = rgba(INK, 0.20 * A);
    c.beginPath(); c.arc(cx, y, r, 0, Math.PI * 2); c.stroke();
    if (p > 0.001) {
      c.strokeStyle = rgba(GOLD, 0.85 * A);
      c.beginPath(); c.arc(cx, y, r, START, START + Math.PI * 2 * p); c.stroke();
      const a = START + Math.PI * 2 * p;
      c.fillStyle = rgba(GOLD, 0.9 * A);
      c.beginPath();
      c.arc(cx + Math.cos(a) * r, y + Math.sin(a) * r, Math.max(1.1, 1.7 * s), 0, Math.PI * 2);
      c.fill();
    }
    this._text(c, `SKINNING ${sk.species || ''}`.trim(), cx, y + r + 17 * s, {
      size: 12 * s, track: 0.16, align: 'center', alpha: 0.80 * A,
      colour: INK, shadow: 0.95,
    });
    this._text(c, 'move to stop', cx, y + r + 33 * s, {
      size: 10.5 * s, track: 0.12, align: 'center', alpha: 0.42 * A,
      colour: INK_DIM, shadow: 0.9,
    });
    this._stackY -= (r * 2 + 30 * s) * this.a.skin;
  }

  /**
   * Ammunition, breath and the day's take. Bottom right, above the condition
   * arcs, and only on screen while the rifle is actually in play — a permanent
   * ammo counter is exactly the kind of furniture this HUD refuses to be.
   */
  _drawWeapon(c, W, H, s, A) {
    const w = this._wpn;
    if (!w) return;
    const right = W - 42 * s;
    const y = H - 96 * s;

    /* rounds in the magazine, as tick marks: spent ones stay as empty slots */
    const n = w.capacity;
    const pitch = 6.5 * s;
    const h = 11 * s;
    const x0 = right - (n - 1) * pitch;
    for (let i = 0; i < n; i++) {
      const live = i < w.ammo;
      const x = Math.round(x0 + i * pitch) + 0.5;
      this._hairline(c, x, y, x, y - h * (live ? 1 : 0.45),
        live ? GOLD : INK_DIM, (live ? 0.82 : 0.28) * A, Math.max(1, 1.6 * s));
    }
    this._text(c, String(w.reserve), right + 8 * s, y, {
      size: 10.5 * s, track: 0.14, align: 'left', alpha: 0.42 * A, colour: INK_DIM, shadow: 0.9,
    });

    /* breath: one short bar under the rounds, and only while it is not full */
    if (w.breath < 0.995) {
      const bw = (n - 1) * pitch;
      const by = Math.round(y + 7 * s) + 0.5;
      this._hairline(c, x0, by, x0 + bw, by, INK_DIM, 0.16 * A, 1);
      this._hairline(c, x0, by, x0 + bw * w.breath, by, INK, 0.55 * A, Math.max(1, 1.4 * s));
    }

    /* the day's take, only once there is one */
    const W2 = this.ctx.get('wildlife');
    if (W2 && (W2.pelts > 0 || W2.kills > 0)) {
      this._text(c, `TAKE ${W2.pelts}/${W2.kills}`, right + 8 * s, y - h - 6 * s, {
        size: 11 * s, track: 0.12, align: 'right', alpha: 0.62 * A, colour: INK_DIM, shadow: 0.9,
      });
    }
  }

  /* --- first-run controls ------------------------------------------------- */

  /**
   * One line, centred, low. Boxed key caps in the same hand as the contextual
   * prompt so the two read as the same language, and it is gone the moment the
   * player has walked far enough to have learned it.
   *
   * The whole thing is laid out twice — once to measure, once to draw — so it
   * stays centred whatever the label widths turn out to be.
   */
  _drawControls(c, W, H, s, A) {
    const mounted = this.ctx.player.mode === 'mounted';
    /*
     * Two rows now, not one. The hunt added three verbs and seven key caps in
     * a single line ran off both edges of the frame at 1280 — so movement sits
     * on the upper line and the rifle on the lower one, which also happens to
     * group them the way a player thinks about them.
     */
    const rows = mounted
      ? [
        [['W', 'RIDE', 'ride'], ['SHIFT', 'SPUR ON', 'spur'],
          ['A D', 'REIN', 'rein'], ['E', 'DISMOUNT', 'mount']],
        [['RMB', 'AIM', 'aim'], ['LMB', 'FIRE', 'fire'], ['R', 'RELOAD', 'reload']],
      ]
      : [
        [['W A S D', 'MOVE', 'move'], ['SHIFT', 'RUN', 'run'],
          ['CTRL', 'CROUCH', 'crouch'], ['E', 'MOUNT', 'mount']],
        [['RMB', 'AIM', 'aim'], ['LMB', 'FIRE', 'fire'],
          ['SHIFT', 'HOLD BREATH', 'breath'], ['R', 'RELOAD', 'reload']],
      ];
    /* Each hint fades on its own once its control has been used, and the rows
     * are bottom-anchored so the survivors slide down into the vacancy rather
     * than leaving a hole where the rifle line used to be. */
    const lh = 27 * s;
    const base = H - 64 * s;
    const rowA = rows.map((r) => Math.max(...r.map((it) => this._hintAlpha(it[2]))));
    let off = 0;
    let top = base;
    for (let i = rows.length - 1; i >= 0; i--) {
      const y = base - off;
      if (rowA[i] > 0.01) {
        this._controlRow(c, W, s, A * (i ? 0.86 : 1), rows[i], y);
        top = Math.min(top, y - 21 * s);
      }
      off += lh * rowA[i];
    }
    // Hand the ceiling to whatever draws above, eased by the block's own fade.
    this._stackY = base + (top - base) * this.a.keys;
  }

  _controlRow(c, W, s, A, items, y) {
    /* Bigger, and much tighter. Half an em of air between letters is a display
     * mannerism: at eleven pixels it dissolves the word shape entirely, which
     * is precisely what made MOVE / CROUCH / HOLD BREATH unreadable. The key
     * glyph now outranks its label — solid cap, near-full ink — so the eye
     * lands on W or SHIFT first and only then reads what it does. */
    const kSize = 13 * s;
    const lSize = 12 * s;
    const box = 23 * s;
    const padX = 8.5 * s;
    const gap = 9 * s;
    const sepGap = 19 * s;
    const kTrack = 0.10;
    const lTrack = 0.09;

    const measure = (str, size, track) => {
      c.font = `${size.toFixed(1)}px ${FONT}`;
      let w = 0;
      for (let i = 0; i < str.length; i++) {
        w += c.measureText(str[i]).width + (i < str.length - 1 ? size * track : 0);
      }
      return w;
    };
    const cells = items.map((it) => {
      const a = this._hintAlpha(it[2]);
      const kw = Math.max(box, measure(it[0], kSize, kTrack) + padX * 2);
      const lw = measure(it[1], lSize, lTrack);
      return { a, kw, lw, adv: (kw + gap + lw) * a };
    });
    let total = 0;
    for (let i = 0; i < cells.length; i++) {
      total += cells[i].adv + (i < cells.length - 1 ? sepGap * Math.max(cells[i].a, cells[i + 1].a) : 0);
    }
    let x = W * 0.5 - total * 0.5;

    for (let i = 0; i < cells.length; i++) {
      const { a, kw } = cells[i];
      const ia = A * a;
      if (ia > 0.012) {
        const bx = Math.round(x) + 0.5;
        const by = Math.round(y - box * 0.74) + 0.5;
        // A solid cap, not an outline: the key needs something of its own to
        // sit on when the ground behind it is gravel.
        roundRect(c, bx, by, kw, box, 2.5 * s);
        c.fillStyle = `rgba(10,9,8,${0.46 * ia})`;
        c.fill();
        roundRect(c, bx, by, kw, box, 2.5 * s);
        c.strokeStyle = `rgba(7,6,5,${0.34 * ia})`;
        c.lineWidth = Math.max(1, 1 * s) + 1.6;
        c.stroke();
        roundRect(c, bx, by, kw, box, 2.5 * s);
        c.strokeStyle = rgba(INK, 0.5 * ia);
        c.lineWidth = Math.max(1, 1.1 * s);
        c.stroke();
        this._text(c, items[i][0], x + kw * 0.5, y - box * 0.74 + box * 0.7, {
          size: kSize, track: kTrack, align: 'center', alpha: 0.95 * ia, colour: INK, shadow: 0.8,
        });
        this._text(c, items[i][1], x + kw + gap, y, {
          size: lSize, track: lTrack, align: 'left', alpha: 0.82 * ia, colour: INK_DIM, shadow: 0.95,
        });
      }
      x += cells[i].adv + (i < cells.length - 1 ? sepGap * Math.max(a, cells[i + 1].a) : 0);
    }
  }

  /** Pointer lock is the one thing a player cannot guess. Say it once, plainly. */
  _drawLockHint(c, W, H, s, A) {
    const y = this._stackY - 19 * s;
    // Pointer lock is the ONE thing a player cannot discover by pressing keys,
    // so this line has to survive a blown-out sky. It measured illegible at
    // 12 px / 0.6 alpha over sunlit grass; it is the last thing on screen that
    // should be whispering.
    /* Gold on bleached sand is two ochres arguing: measured over the high-noon
     * desert this line was the least legible thing on screen even with the
     * scrim under it. The ink is far lighter than any ground in this world, so
     * the type goes ink and the rule keeps the gold. */
    const w = this._text(c, 'click to look around', W * 0.5, y, {
      size: 14.5 * s, track: 0.14, align: 'center', alpha: 0.95 * A, colour: INK,
      shadow: 1.0, outline: 0.9,
    });
    const half = w * 0.5 + 14 * s;
    this._hairline(c, W * 0.5 - half, y + 8 * s, W * 0.5 + half, y + 8 * s, GOLD, 0.3 * A, 1);
    this._stackY -= 36 * s * this.a.lock;
  }

  /**
   * An elliptical pool of shade, feathered to nothing at its edge. Cheap
   * (one radial gradient in a scaled space) and it never shows a boundary,
   * which a rectangle with a linear gradient always eventually does.
   */
  /**
   * The bottom scrim. Deep enough to cover the title card, the control block,
   * the prompt and the condition arcs; eased so hard at the top that there is
   * no findable edge. Built once per layout and scaled with `globalAlpha`, so
   * a frame costs one cached gradient fill.
   */
  _scrimBottom(c, W, H, s, alpha) {
    if (alpha <= 0.003) return;
    const h = Math.max(H * 0.36, 290 * s);
    if (!this._gradBot || this._scrimBotH !== h) {
      const g = c.createLinearGradient(0, H - h, 0, H);
      for (const [t, f] of SCRIM_STOPS) g.addColorStop(t, `rgba(9,8,7,${f})`);
      this._gradBot = g;
      this._scrimBotH = h;
    }
    c.save();
    c.globalAlpha = Math.min(1, alpha);
    c.fillStyle = this._gradBot;
    c.fillRect(0, H - h, W, h);
    c.restore();
  }

  /** Same idea along the top, sized to the compass strip and its labels. */
  _scrimTop(c, W, H, s, alpha) {
    if (alpha <= 0.003) return;
    const h = Math.max(H * 0.155, 112 * s);
    if (!this._gradTop || this._scrimTopH !== h) {
      const g = c.createLinearGradient(0, h, 0, 0);
      for (const [t, f] of SCRIM_STOPS) g.addColorStop(t, `rgba(9,8,7,${f})`);
      this._gradTop = g;
      this._scrimTopH = h;
    }
    c.save();
    c.globalAlpha = Math.min(1, alpha);
    c.fillStyle = this._gradTop;
    c.fillRect(0, 0, W, h);
    c.restore();
  }

  _shade(c, x, y, rx, ry, alpha) {
    if (alpha <= 0.002) return;
    c.save();
    c.translate(x, y);
    c.scale(1, ry / rx);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, `rgba(10,8,7,${alpha})`);
    g.addColorStop(0.45, `rgba(10,8,7,${alpha * 0.62})`);
    g.addColorStop(0.78, `rgba(10,8,7,${alpha * 0.2})`);
    g.addColorStop(1, 'rgba(10,8,7,0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(0, 0, rx, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  /**
   * Letter-spaced text. Canvas has no tracking, so lay the glyphs out by hand.
   *
   * Each glyph is stroked in near-black before it is filled. That thin dark
   * contour is what lets ink at 40 % opacity stay readable over a blown-out
   * sky without a panel behind it, and it costs nothing outside the letterform.
   */
  _text(c, str, x, y, {
    size = 12, track = 0.2, align = 'left', alpha = 1, colour = INK, shadow = 0.5,
    outline = 0.85,
  } = {}) {
    if (!str || alpha <= 0.004) return 0;
    c.font = `${size.toFixed(1)}px ${FONT}`;
    const sp = size * track;
    const n = str.length;
    // Measure once; the glyphs are laid out twice (outline, then fill).
    const w = this._wbuf.length >= n ? this._wbuf : (this._wbuf = new Float64Array(n * 2));
    let total = 0;
    for (let i = 0; i < n; i++) {
      w[i] = c.measureText(str[i]).width;
      total += w[i] + (i < n - 1 ? sp : 0);
    }
    const x0 = align === 'center' ? x - total * 0.5 : align === 'right' ? x - total : x;

    if (shadow > 0) {
      c.shadowColor = `rgba(8,6,4,${shadow * alpha})`;
      c.shadowBlur = size * 0.7;
      c.shadowOffsetY = size * 0.06;
    }
    if (outline > 0) {
      c.strokeStyle = `rgba(7,6,5,${Math.min(0.9, outline * alpha)})`;
      c.lineWidth = Math.max(1.2, size * 0.11);
      let px = x0;
      for (let i = 0; i < n; i++) { c.strokeText(str[i], px, y); px += w[i] + sp; }
    }
    c.shadowColor = 'transparent';
    c.shadowBlur = 0;
    c.shadowOffsetY = 0;

    c.fillStyle = rgba(colour, alpha);
    let px = x0;
    for (let i = 0; i < n; i++) { c.fillText(str[i], px, y); px += w[i] + sp; }
    return total;
  }

  /**
   * A 1 px line with a dark under-stroke, for the same reason the glyphs have
   * one: the dark goes down first, slightly wider and at low alpha.
   */
  _hairline(c, x0, y0, x1, y1, colour, alpha, width = 1) {
    c.lineWidth = width + 1.6;
    c.strokeStyle = `rgba(7,6,5,${Math.min(0.4, alpha * 0.55)})`;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    c.lineWidth = width;
    c.strokeStyle = rgba(colour, alpha);
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
  }

  /* --- compass ---------------------------------------------------------- */

  _drawCompass(c, W, H, s, A) {
    const width = Math.min(W * 0.36, 460 * s);
    const cx = W * 0.5;
    const cy = Math.round(42 * s);
    const span = 116;                       // degrees visible across the strip
    const pxPerDeg = width / span;
    const half = width * 0.5;
    const head = this._heading;

    // hairline, feathered at both ends by a gradient stroke
    const ly = Math.round(cy) + 0.5;
    const dark = c.createLinearGradient(cx - half, 0, cx + half, 0);
    dark.addColorStop(0, 'rgba(7,6,5,0)');
    dark.addColorStop(0.5, `rgba(7,6,5,${0.19 * A})`);
    dark.addColorStop(1, 'rgba(7,6,5,0)');
    c.strokeStyle = dark;
    c.lineWidth = 2.4;
    c.beginPath(); c.moveTo(cx - half, ly); c.lineTo(cx + half, ly); c.stroke();

    const grad = c.createLinearGradient(cx - half, 0, cx + half, 0);
    grad.addColorStop(0, rgba(INK, 0));
    grad.addColorStop(0.16, rgba(INK, 0.34 * A));
    grad.addColorStop(0.5, rgba(INK, 0.62 * A));
    grad.addColorStop(0.84, rgba(INK, 0.34 * A));
    grad.addColorStop(1, rgba(INK, 0));
    c.strokeStyle = grad;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(cx - half, ly);
    c.lineTo(cx + half, ly);
    c.stroke();

    const edge = (x) => {
      const u = Math.abs(x - cx) / half;
      return u >= 1 ? 0 : Math.pow(1 - u * u, 1.35);
    };

    /*
     * Ticks every FIFTEEN degrees, not every five. At five the strip is a
     * ruler: forty hairlines a couple of pixels apart that resolve, at HUD
     * opacities, into a grey smear along the top of the frame. Eight marks
     * across the same span read instantly as a heading.
     */
    const start = Math.ceil((head - span * 0.5) / 15) * 15;
    for (let d = start; d <= head + span * 0.5; d += 15) {
      const xr = cx + (angDiff(d, head)) * pxPerDeg;
      const f = edge(xr);
      if (f <= 0.01) continue;
      // Snap verticals to the pixel grid; a 1 px hairline landing on a half
      // pixel is drawn as two 50 % rows and disappears at these opacities.
      const x = Math.round(xr) + 0.5;
      const dd = ((d % 360) + 360) % 360;
      const cardinal = dd % 90 === 0;
      const inter = dd % 45 === 0;
      const len = cardinal ? 12 * s : inter ? 8 * s : 4.5 * s;
      const al = (cardinal ? 0.98 : inter ? 0.7 : 0.42) * f * A;
      this._hairline(c, x, Math.round(cy - len), x, Math.round(cy) - 1,
        cardinal ? GOLD : INK, al, cardinal ? Math.max(1.4, 1.6 * s) : Math.max(1, 1.1 * s));
      // Ghost labels at the feathered ends read as dirt on the lens; drop them
      // rather than let them fade through the illegible band.
      if ((cardinal || inter) && f > 0.28) {
        const label = CARD[dd / 45];
        /* NE / SW are two letters, and at a seventh of an em of tracking they
         * came apart into two unrelated capitals. Tight enough to be a word. */
        this._text(c, label, xr, cy - len - 6 * s, {
          size: (cardinal ? 14.5 : 11) * s,
          track: 0.05,
          align: 'center',
          alpha: (cardinal ? 0.98 : 0.66) * f * A,
          colour: cardinal ? INK : INK_DIM,
          shadow: 0.95,
        });
      }
    }

    // points of interest riding along the strip
    this._compassPOI(c, cx, cy, half, pxPerDeg, head, A, edge);

    // the index mark
    c.beginPath();
    c.moveTo(cx, cy + 5.5 * s);
    c.lineTo(cx - 3.4 * s, cy + 0.5);
    c.lineTo(cx + 3.4 * s, cy + 0.5);
    c.closePath();
    c.strokeStyle = `rgba(7,6,5,${0.55 * A})`;
    c.lineWidth = 2;
    c.stroke();
    c.fillStyle = rgba(GOLD, 0.95 * A);
    c.fill();
  }

  _compassPOI(c, cx, cy, half, pxPerDeg, head, A, edge) {
    const p = this.ctx.camera.position;
    const marks = [];
    const add = (poi, kind) => {
      if (!poi) return;
      const q = poi.pos || poi;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < 12 || d > 3000) return;
      const bearing = (Math.atan2(q.x - p.x, -(q.z - p.z)) * 180) / Math.PI;
      marks.push({ bearing, kind, d });
    };
    add(this.ctx.poi.get('town'), 'town');
    add(this.ctx.poi.get('camp_fire'), 'camp');
    for (const m of marks) {
      const x = cx + angDiff(m.bearing, head) * pxPerDeg;
      const f = edge(x);
      if (f <= 0.02) continue;
      const s = this.s;
      const a = 0.7 * f * A;
      const y = cy + 11 * s;
      const path = () => {
        c.beginPath();
        if (m.kind === 'town') {
          c.moveTo(x, y - 3.4 * s); c.lineTo(x + 3.4 * s, y);
          c.lineTo(x, y + 3.4 * s); c.lineTo(x - 3.4 * s, y);
          c.closePath();
        } else {
          c.arc(x, y, 2.4 * s, 0, Math.PI * 2);
        }
      };
      c.strokeStyle = `rgba(7,6,5,${0.4 * f * A})`;
      c.lineWidth = Math.max(1, 1.1 * s) + 1.6;
      path(); c.stroke();
      c.strokeStyle = rgba(m.kind === 'town' ? GOLD : INK_DIM, a);
      c.lineWidth = Math.max(1, 1.1 * s);
      path(); c.stroke();
    }
  }

  /* --- condition arcs ---------------------------------------------------- */

  /**
   * Condition arcs. Two of them, and they only exist while something is not
   * full — an always-present bar is the single most video-game thing a western
   * can put on screen.
   *
   * They are drawn as open arcs with a gap at the bottom rather than closed
   * rings: a ring reads as an icon and you have to work out where it starts,
   * an arc with a break reads immediately as a level.
   */
  _drawCores(c, W, H, s, A) {
    const r = 16 * s;
    const gap = 50 * s;
    const y = H - 46 * s;
    const x0 = W - 42 * s - gap;
    this._arc(c, x0, y, r, this.health, BLOOD, A, s);
    this._arc(c, x0 + gap, y, r, this.stamina, GOLD, A, s);
  }

  _arc(c, x, y, r, v, colour, A, s) {
    const START = Math.PI * 0.66;   // start bottom-left, sweep clockwise
    const SWEEP = Math.PI * 1.68;   // leaving a clear break at the bottom
    // dark contour under the whole gauge, same trick as the glyphs
    c.lineWidth = Math.max(1.4, 2.4 * s) + 1.6;
    c.strokeStyle = `rgba(7,6,5,${0.32 * A})`;
    c.beginPath(); c.arc(x, y, r, START, START + SWEEP); c.stroke();

    c.lineWidth = Math.max(1.4, 2.4 * s);
    c.shadowColor = `rgba(6,5,4,${0.6 * A})`;
    c.shadowBlur = 5 * s;
    c.strokeStyle = rgba(INK, 0.2 * A);
    c.beginPath(); c.arc(x, y, r, START, START + SWEEP); c.stroke();
    if (v > 0.001) {
      c.strokeStyle = rgba(colour, 0.78 * A);
      c.beginPath(); c.arc(x, y, r, START, START + SWEEP * v); c.stroke();
      // A soft cap on the leading end so the level has a readable head.
      const a = START + SWEEP * v;
      c.fillStyle = rgba(colour, 0.85 * A);
      c.beginPath();
      c.arc(x + Math.cos(a) * r, y + Math.sin(a) * r, Math.max(1.1, 1.7 * s), 0, Math.PI * 2);
      c.fill();
    }
    c.shadowColor = 'transparent'; c.shadowBlur = 0;
  }

  /* --- contextual prompt -------------------------------------------------- */

  _drawPrompt(c, W, H, s, A) {
    if (!this._prompt) return;
    const size = 13 * s;
    const key = this._prompt.key;
    const label = this._prompt.label.toUpperCase();
    // Rides on top of whatever the first-run block left standing.
    const y = this._stackY - 24 * s;
    const box = 24 * s;

    c.font = `${size.toFixed(1)}px ${FONT}`;
    let lw = 0;
    for (let i = 0; i < label.length; i++) lw += c.measureText(label[i]).width + size * 0.1;
    const total = box + 9 * s + lw;
    const x = W * 0.5 - total * 0.5;

    const bx = Math.round(x) + 0.5;
    const by = Math.round(y - box * 0.72) + 0.5;
    roundRect(c, bx, by, box, box, 3 * s);
    c.fillStyle = `rgba(10,9,8,${0.5 * A})`;
    c.fill();
    roundRect(c, bx, by, box, box, 3 * s);
    c.strokeStyle = `rgba(7,6,5,${0.4 * A})`;
    c.lineWidth = Math.max(1, 1 * s) + 1.6;
    c.stroke();
    roundRect(c, bx, by, box, box, 3 * s);
    c.strokeStyle = rgba(INK, 0.68 * A);
    c.lineWidth = Math.max(1, 1.1 * s);
    c.stroke();
    this._text(c, key, x + box * 0.5, y - box * 0.72 + box * 0.7, {
      size: 13.5 * s, track: 0, align: 'center', alpha: 0.96 * A, colour: INK, shadow: 0.85,
    });
    this._text(c, label, x + box + 9 * s, y, {
      size, track: 0.1, align: 'left', alpha: 0.86 * A, colour: INK, shadow: 0.95,
    });
    // Hand the ceiling on, so the notice never lands on top of the prompt.
    this._stackY -= 40 * s * this.a.prompt;
  }

  /* --- location title card ------------------------------------------------ */

  _drawTitle(c, W, H, s, A) {
    if (!this._title) return;
    const t = this._titleT < 0 ? 0 : this._titleT;
    const x = Math.round(W * 0.055);
    const y = Math.round(H * 0.80);
    const rise = (1 - Math.min(1, t / 0.9)) * 7 * s;

    // hairline rule that wipes out from the left
    const wipe = Math.min(1, t / 0.75);
    const rw = (86 + 74 * ease(wipe)) * s;
    const ry = Math.round(y - 25 * s + rise * 0.4) + 0.5;
    const dk = c.createLinearGradient(x, 0, x + rw, 0);
    dk.addColorStop(0, `rgba(7,6,5,${0.4 * A})`);
    dk.addColorStop(1, 'rgba(7,6,5,0)');
    c.strokeStyle = dk;
    c.lineWidth = 3;
    c.beginPath(); c.moveTo(x, ry); c.lineTo(x + rw, ry); c.stroke();

    const g = c.createLinearGradient(x, 0, x + rw, 0);
    g.addColorStop(0, rgba(GOLD, 0.78 * A));
    g.addColorStop(1, rgba(GOLD, 0));
    c.strokeStyle = g;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(x, ry);
    c.lineTo(x + rw, ry);
    c.stroke();

    this._text(c, this._title.name.toUpperCase(), x, y + rise, {
      size: 22 * s, track: 0.3, alpha: 0.92 * A, colour: INK, shadow: 1.0, outline: 0.4,
    });
    /*
     * The subtitle used to be 9–11 px with a third of an em of tracking, at
     * 45–60 % opacity, over sunlit ground — measured on the golden-hour frame
     * it was a smear, not a word. Bigger, tighter, brighter, further apart.
     */
    const subA = Math.min(1, Math.max(0, (t - 0.28) / 0.7));
    // ONE line under the name. The clock used to sit below the subtitle, which
    // already reads "about nine in the morning" — the same fact twice, in two
    // sizes, in eleven-pixel type. Say it once and say it legibly.
    if (this._title.sub) {
      this._text(c, this._title.sub, x + 2 * s, y + 25 * s + rise * 0.5, {
        size: 13.5 * s, track: 0.13, alpha: 0.88 * A * subA, colour: INK_DIM, shadow: 1.0,
      });
    }
  }

  /**
   * The transient line. It USED to sit at a fixed H − 132 s, which was fine
   * while the only thing that ever wrote to it was a region name — and became
   * a defect the moment kills, crimes and skinning all started using it: at
   * 960x600 with the first-run block up, the fixed row lands within four pixels
   * of the contextual prompt and the two words draw straight through each
   * other. It rides the same stack as everything else now.
   */
  _drawNotice(c, W, H, s, A) {
    if (!this._notice) return;
    const y = Math.min(this._stackY - 22 * s, H - 132 * s);
    this._text(c, this._notice.toUpperCase(), W * 0.5, y, {
      size: 12 * s, track: 0.14, align: 'center', alpha: 0.82 * A, colour: INK, shadow: 0.95,
    });
  }

  /** Browsers hold audio until a gesture; this is the only way to say so. */
  _drawHint(c, W, H, s, A) {
    this._text(c, 'press any key for sound', W * 0.5, H - 22 * s, {
      size: 11 * s, track: 0.12, align: 'center', alpha: 0.62 * A, colour: INK_DIM, shadow: 0.9,
    });
  }

  /* ---------------------------------------------------------------- teardown */

  dispose() {
    for (const off of this._unbind) { try { off(); } catch (e) { /* noop */ } }
    this._unbind.length = 0;
    if (this.menu) this.menu.dispose();
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.canvas = null;
    this.c2d = null;
    this.active = false;
  }
}

/* -------------------------------------------------------------------- utils */

const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Credit at which a control counts as learned and its hint retires. */
const LEARN = 2.6;
const FOOT_TAGS = ['move', 'run', 'crouch', 'mount', 'aim', 'fire', 'breath', 'reload'];
const MOUNTED_TAGS = ['ride', 'spur', 'rein', 'mount', 'aim', 'fire', 'reload'];

/**
 * Scrim falloff, edge (1.0) to nothing (0.0). Deliberately far from linear —
 * a linear ramp of this depth reads as a grey wash halfway up the frame, this
 * one has all its weight in the last fifth and vanishes above it.
 */
const SCRIM_STOPS = [
  [0.00, 0], [0.16, 0.08], [0.30, 0.22], [0.42, 0.42],
  [0.55, 0.64], [0.68, 0.80], [0.82, 0.93], [1.00, 1],
];

function angDiff(a, b) {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function ease(t) { return t * t * (3 - 2 * t); }

/** in 0.55s, hold, out over the last 1.4s of a 7.2s life */
function titleEnvelope(t) {
  if (t < 0) return 0;
  if (t < 0.55) return ease(t / 0.55);
  if (t < 5.8) return 1;
  if (t < 7.2) return 1 - ease((t - 5.8) / 1.4);
  return 0;
}

/** Lerp two ink triples. Allocates one array; only called while a hit shows. */
function mixCol(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** A five-pointed star path, point up. Leaves the path open for fill/stroke. */
function star(c, x, y, r, ri) {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI * 0.5 + (i * Math.PI) / 5;
    const rr = i & 1 ? ri : r;
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
  }
  c.closePath();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
