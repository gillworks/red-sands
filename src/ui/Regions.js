import { rng } from '../core/Context.js';

/**
 * Named places.
 *
 * The world is procedural, so the names have to be too: a deterministic set of
 * anchors is scattered over the map and each is given a period-plausible name
 * built from a small vocabulary. POI-derived anchors (the settlement, the river
 * bend, the timber) take precedence so the shot names and the title cards agree.
 *
 * Lookup is nearest-anchor with hysteresis, which stops the title card
 * flickering when you ride along a boundary.
 */

const HEAD = [
  'Bitter', 'Ochre', 'Coyote', 'Rattler', 'Cinnabar', 'Saltpan', 'Widow',
  'Hangman', 'Dry', 'Broken', 'Lonesome', 'Painted', 'Cottonwood', 'Buzzard',
  'Silver', 'Redemption', 'Sundown', 'Chalk', 'Gallows', 'Thirsty',
];
const TAIL = [
  'Flats', 'Draw', 'Gulch', 'Basin', 'Bluff', 'Ridge', 'Fork', 'Hollow',
  'Mesa', 'Creek', 'Wash', 'Bend', 'Rise', 'Sink', 'Pass', 'Butte',
];
const TOWNS = [
  'Armadillo', 'Tumbleweed', 'Blackwater', 'Manzanita', 'Cholla Springs',
  'Perdido', 'Val Verde', 'Cimarron',
];

function pick(arr, r) { return arr[(r() * arr.length) | 0]; }

export class Regions {
  constructor(ctx) {
    this.ctx = ctx;
    this.anchors = [];
    this.current = null;
    this._dist = 1e9;
  }

  build() {
    const ctx = this.ctx;
    const r = rng((ctx.seed ^ 0x9e3779b9) >>> 0);
    const used = new Set();
    const name = () => {
      for (let i = 0; i < 24; i++) {
        const n = `${pick(HEAD, r)} ${pick(TAIL, r)}`;
        if (!used.has(n)) { used.add(n); return n; }
      }
      return `${pick(HEAD, r)} ${pick(TAIL, r)}`;
    };

    const add = (x, z, label, kind, radius) => {
      this.anchors.push({ x, z, label, kind, radius: radius || 1e9 });
    };

    // --- named POIs first --------------------------------------------------
    const town = ctx.poi.get('town');
    const townEnd = ctx.poi.get('town_end');
    if (town) {
      const a = town.pos || town;
      const b = townEnd ? (townEnd.pos || townEnd) : a;
      add((a.x + b.x) * 0.5, (a.z + b.z) * 0.5, pick(TOWNS, r), 'town', 260);
    }
    const river = ctx.poi.get('river');
    if (river) {
      const p = river.pos || river;
      add(p.x, p.z, `${pick(HEAD, r)} Bend`, 'river', 300);
    }
    const forest = ctx.poi.get('forest');
    if (forest) {
      const p = forest.pos || forest;
      add(p.x, p.z, `${pick(['Pinewood', 'Timber', 'Blackpine', 'Cedar'], r)} ${pick(['Rise', 'Stand', 'Hollow'], r)}`, 'forest', 420);
    }

    // --- a jittered lattice over the playable square -----------------------
    const half = (ctx.world && ctx.world.size ? ctx.world.size : 8192) * 0.5;
    const step = half * 0.62;
    for (let gz = -2; gz <= 2; gz++) {
      for (let gx = -2; gx <= 2; gx++) {
        const x = gx * step + (r() - 0.5) * step * 0.55;
        const z = gz * step + (r() - 0.5) * step * 0.55;
        let tooClose = false;
        for (const a of this.anchors) {
          if (a.kind !== 'grid' && Math.hypot(a.x - x, a.z - z) < 420) tooClose = true;
        }
        if (tooClose) continue;
        add(x, z, name(), 'grid');
      }
    }
    return this;
  }

  /** @returns {{label:string, kind:string}|null} the region containing (x,z). */
  at(x, z) {
    let best = null, bd = 1e18;
    for (const a of this.anchors) {
      const d = Math.hypot(a.x - x, a.z - z);
      if (d > a.radius) continue;
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  /**
   * Update the current region with hysteresis.
   * @returns {object|null} the new region if it changed, else null
   */
  update(x, z) {
    const found = this.at(x, z);
    if (!found) return null;
    if (found === this.current) {
      this._dist = Math.hypot(found.x - x, found.z - z);
      return null;
    }
    const d = Math.hypot(found.x - x, found.z - z);
    if (this.current) {
      const cd = Math.hypot(this.current.x - x, this.current.z - z);
      // must be meaningfully closer before we re-title the frame
      if (!(d < cd * 0.86 || d < cd - 60)) return null;
    }
    this.current = found;
    this._dist = d;
    return found;
  }
}

/* ------------------------------------------------------------------- time */

const HOURS = ['twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven'];

/** "half past six in the morning" — the clock as a title card would say it. */
export function timePhrase(h24) {
  const h = ((h24 % 24) + 24) % 24;
  const m = Math.floor((h % 1) * 60);
  const hr = Math.floor(h);
  const part = hr < 5 ? 'in the small hours'
    : hr < 12 ? 'in the morning'
      : hr < 17 ? 'in the afternoon'
        : hr < 20 ? 'in the evening' : 'at night';
  let word;
  let base = hr;
  if (m < 8) word = 'about';
  else if (m < 23) word = 'a quarter past';
  else if (m < 38) word = 'half past';
  else if (m < 53) { word = 'a quarter to'; base = hr + 1; }
  else { word = 'nearly'; base = hr + 1; }
  const name = HOURS[base % 12];
  if (word === 'about' || word === 'nearly') return `${word} ${name} ${part}`;
  return `${word} ${name} ${part}`;
}

/** Terse clock for the corner readout. */
export function clockString(h24) {
  const h = ((h24 % 24) + 24) % 24;
  let hr = Math.floor(h);
  const m = Math.floor((h % 1) * 60);
  const ap = hr < 12 ? 'AM' : 'PM';
  hr = hr % 12; if (hr === 0) hr = 12;
  return `${hr}:${String(m).padStart(2, '0')} ${ap}`;
}
