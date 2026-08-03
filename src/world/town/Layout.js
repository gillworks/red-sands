/**
 * Layout — the street spine and the lot plan.
 *
 * A frontier settlement is a road with a row of facades bolted to each side, so
 * everything here is authored in street coordinates:
 *
 *   s  metres along the street from the town centre  (the "chainage")
 *   t  metres across it; +t is one side, -t the other
 *   y  the GRADE — a smoothed upper envelope of the real terrain
 *
 * The grade is deliberately an *upper* envelope (a morphological closing of the
 * cross-section maxima) so the town pad is always fill and never cut: the
 * terrain system owns the heightfield and the grade is published back through
 * it as a fill-only override, so a graded surface that dips below the ground
 * would simply have hillside poking through the road. Filling is free.
 *
 * The street also bends. A dead-straight spine reads as a corridor of boxes;
 * a 4-6 m lateral drift over 180 m means the far end of the row peels away and
 * you see the flanks of the buildings, which is what makes the false fronts
 * legible as *screens* rather than as facades.
 */

/* ------------------------------------------------------- solar siting ---- */

const DEG = Math.PI / 180;

/**
 * Horizontal direction TO the sun at a given hour, in the engine's world frame
 * (+X east, −Z north). Same NOAA fractional-year solar model TimeOfDay uses, in
 * fifteen lines, because the layout has to know where the afternoon sun will be
 * BEFORE the shot harness sets the clock.
 *
 * Why the town cares: `town_street` is specified as a warm afternoon, and a
 * street laid out at random has a 50 % chance of pointing the camera straight
 * into a 23°-elevation sun. Measured on the first build of this pass, that shot
 * came back with a full-frame luma standard deviation of 0.083 and a foreground
 * of 0.024 — the entire settlement dissolved into forward Mie glare. Aiming the
 * spine ~130° away from the sun instead puts the key behind the camera's
 * shoulder, lights one row of facades at 40° incidence, throws the other row
 * into shade, and rakes the building shadows across the road toward the lens.
 * That is the whole difference between a photograph and a white rectangle.
 *
 * @returns {[number, number]} unit (x, z)
 */
export function sunAzimuthAt(hours, dayOfYear = 172, latitudeDeg = 38) {
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
  const lat = latitudeDeg * DEG;
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const sinD = Math.sin(decl), cosD = Math.cos(decl);
  const sinAlt = Math.max(-1, Math.min(1, sinLat * sinD + cosLat * cosD * Math.cos(H)));
  const alt = Math.asin(sinAlt);
  const cosAlt = Math.cos(alt);
  let az = Math.PI;
  if (cosAlt > 1e-5 && cosLat > 1e-5) {
    az = Math.acos(Math.max(-1, Math.min(1, (sinD - sinAlt * sinLat) / (cosAlt * cosLat))));
    if (H > 0) az = 2 * Math.PI - az;
  }
  const x = Math.sin(az), z = -Math.cos(az);
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
}

/**
 * Choose the street bearing. Start from the ideal solar bearing, then rotate it
 * back toward the terrain contour if the site actually has relief worth
 * respecting — a town on a hillside runs along the contour, a town on a plain
 * runs wherever the surveyor felt like.
 *
 * @param {[number,number]} sun   unit XZ direction TO the afternoon sun
 * @param {[number,number]} contour  unit XZ direction of terrain's suggested axis
 * @param {number} relief  metres of relief over the site
 * @returns {[number,number]} unit XZ direction from the near end to the far end
 */
export function streetBearing(sun, contour, relief) {
  const rot = (v, a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
  };
  const perp = (v) => [-v[1], v[0]];
  const A = 130 * DEG;
  const cand = [rot(sun, A), rot(sun, -A)];
  // Pick the handedness that lights the +t row (the saloon side) and shades the
  // other: dot(+t normal, sun) must be negative.
  let v = cand[0];
  const p0 = perp(cand[0]);
  if (p0[0] * sun[0] + p0[1] * sun[1] > 0) v = cand[1];

  // Blend back toward the contour on genuinely sloping ground.
  const w = Math.min(1, Math.max(0, (relief - 4) / 10));
  if (w > 0.001 && contour) {
    let c = contour;
    if (c[0] * v[0] + c[1] * v[1] < 0) c = [-c[0], -c[1]];
    const dot = Math.max(-1, Math.min(1, c[0] * v[0] + c[1] * v[1]));
    const ang = Math.acos(dot);
    const cross = v[0] * c[1] - v[1] * c[0];
    v = rot(v, Math.sign(cross) * ang * w);
  }
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

/* --------------------------------------------------------------- the spine */

export class Street {
  /**
   * @param {object} o  cx, cz, dx, dz (unit), length, halfWidth (grade
   *                    corridor half-width), getHeight(x,z), rand,
   *                    grade (optional precomputed table — see below)
   *
   * `o.grade` exists because Terrain now builds this grade at generation time
   * and publishes it through `ctx.world.getHeight` (see town/Pad.js). Rebuilding
   * the envelope from the ALREADY-GRADED ground would close over its own output
   * and ratchet the town up another 0.30 m every pass, so Town adopts the table
   * Terrain used instead of re-deriving it. The four `rand` draws below still
   * happen either way, so the caller's random stream — and therefore the whole
   * settlement — is unchanged.
   */
  constructor(o) {
    this.len = o.length;
    this.ox = o.cx; this.oz = o.cz;
    this.dx = o.dx; this.dz = o.dz;
    this.px = -o.dz; this.pz = o.dx;      // +t direction
    this.corridor = o.halfWidth || 26;

    const r = o.rand;
    this.a1 = (r() - 0.5) * 7.0;
    this.a2 = (r() - 0.5) * 2.6;
    this.k1 = Math.PI / (this.len * 0.62);
    this.k2 = Math.PI / (this.len * 0.23);
    this.ph1 = r() * 6.28;
    this.ph2 = r() * 6.28;

    /* --- grade table ---------------------------------------------------- */
    this.gs0 = -this.len * 0.5 - 58;
    this.gs1 = this.len * 0.5 + 58;
    this.gn = 161;
    this.gstep = (this.gs1 - this.gs0) / (this.gn - 1);

    if (o.grade && o.grade.length === this.gn) {
      this.grade = o.grade;
      this.slopeAt = (s) => (this.gradeAt(s + 4) - this.gradeAt(s - 4)) / 8;
      return;
    }

    const raw = new Float32Array(this.gn);
    const H = o.getHeight;
    for (let i = 0; i < this.gn; i++) {
      const s = this.gs0 + i * this.gstep;
      const c = this.centerRaw(s);
      const n = this.normalRaw(s);
      let m = -1e9;
      for (let t = -this.corridor; t <= this.corridor + 0.01; t += 3.2) {
        const h = H(c[0] + n[0] * t, c[1] + n[1] * t);
        if (h > m) m = h;
      }
      raw[i] = m;
    }
    /* dilate (running max), then erode-ish with a wide mean: a closing, so the
       profile clears every bump but still tracks the hillside. */
    const RAD = 7;
    const dil = new Float32Array(this.gn);
    for (let i = 0; i < this.gn; i++) {
      let m = -1e9;
      for (let k = -RAD; k <= RAD; k++) {
        const j = Math.min(this.gn - 1, Math.max(0, i + k));
        if (raw[j] > m) m = raw[j];
      }
      dil[i] = m;
    }
    const g = new Float32Array(this.gn);
    const SM = 9;
    for (let i = 0; i < this.gn; i++) {
      let a = 0, n = 0;
      for (let k = -SM; k <= SM; k++) {
        const j = Math.min(this.gn - 1, Math.max(0, i + k));
        const w = 1 - Math.abs(k) / (SM + 1);
        a += dil[j] * w; n += w;
      }
      g[i] = a / n + 0.30;
    }
    /* never below the raw envelope by more than a hair */
    for (let i = 0; i < this.gn; i++) if (g[i] < raw[i] + 0.06) g[i] = raw[i] + 0.06;
    this.grade = g;

    /* street slope for orienting things that must sit flat on it */
    this.slopeAt = (s) => {
      const a = this.gradeAt(s - 4), b = this.gradeAt(s + 4);
      return (b - a) / 8;
    };
  }

  lat(s) {
    return Math.sin(s * this.k1 + this.ph1) * this.a1
         + Math.sin(s * this.k2 + this.ph2) * this.a2;
  }

  centerRaw(s) {
    const l = this.lat(s);
    return [this.ox + this.dx * s + this.px * l, this.oz + this.dz * s + this.pz * l];
  }

  /** Unit normal (+t) at chainage s, following the bend. */
  normalRaw(s) {
    const e = 0.75;
    const a = this.centerRaw(s - e), b = this.centerRaw(s + e);
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const L = Math.hypot(tx, tz) || 1;
    tx /= L; tz /= L;
    return [-tz, tx];
  }

  tangent(s) {
    const n = this.normalRaw(s);
    return [n[1], -n[0]];
  }

  gradeAt(s) {
    const f = (s - this.gs0) / this.gstep;
    let i = Math.floor(f);
    if (i < 0) i = 0; else if (i > this.gn - 2) i = this.gn - 2;
    const k = Math.min(1, Math.max(0, f - i));
    return this.grade[i] * (1 - k) + this.grade[i + 1] * k;
  }

  /** World position of (s, t) on the graded surface. */
  point(s, t) {
    const c = this.centerRaw(s);
    const n = this.normalRaw(s);
    return [c[0] + n[0] * t, this.gradeAt(s), c[1] + n[1] * t];
  }

  /** World XZ only (no grade), for sampling terrain. */
  xz(s, t) {
    const c = this.centerRaw(s);
    const n = this.normalRaw(s);
    return [c[0] + n[0] * t, c[1] + n[1] * t];
  }
}

/* ------------------------------------------------------------ lot planning */

/**
 * Frontier palettes. Paint on a frontier building is either raw weathered
 * timber that has gone silver, a cheap earth-pigment (ochre / oxide red /
 * chrome-yellow) or the one expensive thing in town: white lead on the bank and
 * the church. Everything is authored as a LINEAR multiplier on the procTexture
 * albedo, so these are all near 1 and never saturated.
 */
const PAINT = {
  bare: [0.86, 0.82, 0.74],
  silver: [0.80, 0.79, 0.76],
  white: [1.16, 1.12, 1.02],
  cream: [1.10, 1.02, 0.84],
  ochre: [1.04, 0.82, 0.52],
  oxide: [0.74, 0.36, 0.26],
  barnRed: [0.66, 0.28, 0.21],
  green: [0.52, 0.58, 0.46],
  slate: [0.56, 0.58, 0.58],
  brown: [0.68, 0.53, 0.37],
  mustard: [0.94, 0.76, 0.38],
  blueGrey: [0.58, 0.64, 0.68],
};

const ROOFC = {
  shingleGrey: [0.72, 0.70, 0.67],
  shingleWarm: [0.82, 0.74, 0.63],
  shingleDark: [0.54, 0.51, 0.48],
  iron: [0.78, 0.72, 0.64],
  ironRust: [0.72, 0.52, 0.38],
};

/**
 * Catalogue of building types. Each entry returns a *shape* spec; placement
 * (ox/oz/floorY/dir) is filled in by Town once the lot is allocated.
 */
export const KINDS = {
  general: (r) => ({
    sign: 'general', w: 12.4 + r() * 2.6, d: 11.5 + r() * 3, h: 4.5 + r() * 0.4,
    storeys: 1, falseFront: true, stepped: 2, pediment: 0,
    shopFront: true, porch: true, porchDepth: 2.72, porchY: 3.10,
    wallMat: 'plank', color: PAINT.cream, frontColor: PAINT.ochre,
    frontMat: 'painted', trimCol: [0.92, 0.86, 0.74], doorColor: [0.52, 0.40, 0.28],
    roof: 'shed', roofMat: 'shingle', roofColor: ROOFC.shingleWarm,
    chimney: true, grime: 0.62, chalk: 0.55, hitch: true, crates: 3, barrels: 3,
    frontTop: 2.9,
  }),
  saloon: (r) => ({
    sign: 'saloon', w: 13.6 + r() * 2.2, d: 13 + r() * 3, h: 7.4 + r() * 0.5,
    storeys: 2, falseFront: true, stepped: 1, pediment: 1.35, cornice: 0.24,
    balcony: true, balconyY: 3.95, porchDepth: 2.72, floor2: 4.62,
    doorW: 1.46, doorOpen: false, shopFront: false,
    wallMat: 'plank', color: PAINT.bare, frontColor: PAINT.oxide,
    frontMat: 'painted', trimCol: [0.94, 0.88, 0.74], doorColor: [0.44, 0.30, 0.20],
    roof: 'gable', pitch: 0.34, roofMat: 'shingle', roofColor: ROOFC.shingleDark,
    chimney: true, grime: 0.72, chalk: 0.62, hitch: true, trough: true, barrels: 4,
    frontTop: 2.0, hanging: true,
  }),
  hotel: (r) => ({
    sign: 'hotel', w: 12.8 + r() * 2.4, d: 12 + r() * 3, h: 7.0 + r() * 0.5,
    storeys: 2, falseFront: true, stepped: 3, pediment: 0, cornice: 0.20,
    porch: true, porchDepth: 2.72, porchY: 3.10,
    wallMat: 'plank', color: PAINT.silver, frontColor: PAINT.green,
    frontMat: 'painted', trimCol: [1.02, 0.98, 0.88], doorColor: [0.40, 0.34, 0.26],
    roof: 'shed', roofMat: 'iron', roofColor: ROOFC.ironRust,
    chimney: true, shutters: true, shutterCol: [0.34, 0.38, 0.32],
    grime: 0.66, chalk: 0.5, crates: 2, frontTop: 1.9,
  }),
  bank: (r) => ({
    sign: 'bank', w: 10.4 + r() * 1.6, d: 11 + r() * 2, h: 6.2 + r() * 0.4,
    storeys: 1, falseFront: true, stepped: 2, pediment: 1.55, cornice: 0.26,
    wallMat: 'stone', foundation: 'stone', color: PAINT.white,
    frontColor: PAINT.white, frontMat: 'stone',
    trimCol: [1.05, 1.0, 0.9], doorColor: [0.30, 0.24, 0.18],
    bars: true, sillY: 1.25, winH: 1.9, winW: 0.92,
    roof: 'shed', roofMat: 'iron', roofColor: ROOFC.iron,
    grime: 0.45, chalk: 0.72, dentils: true, frontTop: 2.1,
  }),
  sheriff: (r) => ({
    sign: 'sheriff', w: 8.8 + r() * 1.4, d: 9 + r() * 2, h: 3.9 + r() * 0.3,
    storeys: 1, falseFront: true, stepped: 1, pediment: 0,
    wallMat: 'adobe', foundation: 'stone', color: [0.94, 0.84, 0.68],
    frontColor: [0.94, 0.84, 0.68], frontMat: 'adobe',
    trimCol: [0.74, 0.62, 0.46], doorColor: [0.36, 0.28, 0.20],
    bars: true, winW: 0.78, winH: 1.15, sillY: 1.5,
    roof: 'shed', roofMat: 'iron', roofColor: ROOFC.ironRust,
    chimney: true, grime: 0.7, chalk: 0.3, hitch: true, frontTop: 1.7,
  }),
  barber: (r) => ({
    sign: 'barber', w: 6.6 + r() * 1.2, d: 8 + r() * 2, h: 4.2 + r() * 0.3,
    storeys: 1, falseFront: true, stepped: 1, pediment: 0.9,
    shopFront: true, porch: true, porchDepth: 2.72, porchY: 3.0, awning: true,
    wallMat: 'plank', color: PAINT.bare, frontColor: PAINT.white,
    frontMat: 'painted', trimCol: [0.60, 0.30, 0.26], doorColor: [0.50, 0.38, 0.26],
    roof: 'shed', roofMat: 'shingle', roofColor: ROOFC.shingleGrey,
    grime: 0.6, chalk: 0.68, barrels: 1, frontTop: 2.4, hanging: true,
  }),
  gazette: (r) => ({
    sign: 'gazette', w: 8.2 + r() * 1.6, d: 9.5 + r() * 2, h: 4.6 + r() * 0.4,
    storeys: 1, falseFront: true, stepped: 2, pediment: 0,
    shopFront: true, wallMat: 'plank', vertical: true,
    color: PAINT.mustard, frontColor: PAINT.mustard, frontMat: 'painted',
    trimCol: [0.42, 0.36, 0.30], doorColor: [0.38, 0.30, 0.22],
    roof: 'gable', pitch: 0.5, roofMat: 'shingle', roofColor: ROOFC.shingleWarm,
    chimney: true, grime: 0.68, chalk: 0.6, crates: 2, frontTop: 2.5,
  }),
  smith: (r) => ({
    sign: 'smith', w: 9.6 + r() * 2, d: 10 + r() * 2.5, h: 4.4 + r() * 0.4,
    storeys: 1, falseFront: false, doorW: 2.6, doorOpen: true, doorBias: -0.08,
    wallMat: 'plank', vertical: true, color: PAINT.brown,
    trimCol: [0.52, 0.44, 0.34], doorColor: [0.40, 0.32, 0.24],
    roof: 'gable', pitch: 0.52, roofMat: 'iron', roofColor: ROOFC.ironRust,
    chimney: true, chimneyX: 2.4, sideWindows: true,
    grime: 0.9, chalk: 0.2, hitch: true, lumber: true, wheels: 3, frontTop: 0,
  }),
  undertaker: (r) => ({
    sign: 'undertaker', w: 7.4 + r() * 1.2, d: 9 + r() * 2, h: 4.3 + r() * 0.3,
    storeys: 1, falseFront: true, stepped: 1, pediment: 0.75,
    wallMat: 'plank', color: PAINT.slate, frontColor: PAINT.slate,
    frontMat: 'painted', trimCol: [0.30, 0.30, 0.30], doorColor: [0.26, 0.24, 0.22],
    roof: 'shed', roofMat: 'shingle', roofColor: ROOFC.shingleDark,
    grime: 0.74, chalk: 0.55, frontTop: 2.2,
  }),
  house: (r) => ({
    sign: null, w: 7.6 + r() * 2.4, d: 8.5 + r() * 3, h: 3.4 + r() * 0.5,
    storeys: 1, falseFront: false, roof: 'gable_z', pitch: 0.72,
    porch: true, porchDepth: 2.1, porchY: 2.62, postSpacing: 2.3,
    wallMat: 'plank', color: r() > 0.5 ? PAINT.bare : PAINT.blueGrey,
    trimCol: [0.94, 0.90, 0.80], doorColor: [0.46, 0.34, 0.24],
    roofMat: 'shingle', roofColor: ROOFC.shingleGrey,
    chimney: true, shutters: true, shutterCol: [0.38, 0.34, 0.28],
    sideWindows: true, grime: 0.7, chalk: 0.5, fence: true, frontTop: 0,
  }),
  cottage: (r) => ({
    sign: null, w: 6.6 + r() * 1.8, d: 7.5 + r() * 2, h: 3.2 + r() * 0.4,
    storeys: 1, falseFront: false, roof: 'gable', pitch: 0.60,
    wallMat: 'adobe', foundation: 'stone', color: [0.92, 0.80, 0.62],
    trimCol: [0.66, 0.54, 0.40], doorColor: [0.42, 0.32, 0.22],
    roofMat: 'shingle', roofColor: ROOFC.shingleWarm,
    chimney: true, sideWindows: true, grime: 0.78, chalk: 0.35,
    fence: true, frontTop: 0,
  }),
  stable: (r) => ({
    sign: 'stable', w: 11 + r() * 2, d: 12 + r() * 3, h: 4.0 + r() * 0.4,
    storeys: 1, falseFront: false, doorW: 2.4, doorOpen: true,
    wallMat: 'plank', vertical: true, color: PAINT.bare,
    trimCol: [0.56, 0.48, 0.38], doorColor: [0.44, 0.36, 0.26],
    roof: 'gable', pitch: 0.55, roofMat: 'iron', roofColor: ROOFC.ironRust,
    sideWindows: false, grime: 0.92, chalk: 0.25,
    hitch: true, hay: true, trough: true, frontTop: 0,
  }),
};

/** Special masses that get their own builder. */
export const SPECIALS = {
  church: (r) => ({
    special: 'church', sign: 'church',
    w: 9.0 + r() * 1.0, d: 15 + r() * 2.5, h: 5.0 + r() * 0.4,
    pitch: 1.05, towerW: 3.4, towerH: 9.2, spireH: 7.6,
    wallMat: 'plank', color: PAINT.white, trimCol: [1.05, 1.0, 0.9],
    doorColor: [0.40, 0.32, 0.24],
    roofMat: 'shingle', roofColor: ROOFC.shingleGrey,
    grime: 0.42, chalk: 0.78, setback: 5.0, fence: true, frontTop: 0,
  }),
  livery: (r) => ({
    special: 'barn', sign: 'livery',
    w: 14 + r() * 2.5, d: 17 + r() * 3, h: 5.0 + r() * 0.5,
    wallMat: 'plank', vertical: true, color: PAINT.barnRed,
    trimCol: [0.86, 0.80, 0.70], doorColor: [0.48, 0.24, 0.19],
    roofMat: 'iron', roofColor: ROOFC.ironRust,
    grime: 0.9, chalk: 0.35, setback: 2.0,
    hay: true, wheels: 2, hitch: true, trough: true, frontTop: 0,
  }),
  barn: (r) => ({
    special: 'barn', sign: null,
    w: 12.5 + r() * 2.5, d: 15 + r() * 3, h: 4.6 + r() * 0.5,
    wallMat: 'plank', vertical: true, color: PAINT.bare,
    trimCol: [0.60, 0.54, 0.44], doorColor: [0.44, 0.36, 0.26],
    roofMat: 'shingle', roofColor: ROOFC.shingleDark,
    grime: 0.95, chalk: 0.3, setback: 3.0, hay: true, lumber: true, frontTop: 0,
  }),
};

/**
 * The street plan. Order matters — this is the composition seen looking down
 * the street from the `town` POI, so the tall stuff is deliberately staggered
 * left/right and the church closes the far end.
 *
 * `s` runs from the near end (negative) to the far end (positive).
 */
export const PLAN = {
  left: ['livery', 'general', 'hotel', 'smith', 'house', 'gazette', 'undertaker', 'church'],
  right: ['sheriff', 'saloon', 'bank', 'barber', 'stable', 'cottage', 'house', 'barn'],
};

export { PAINT, ROOFC };
