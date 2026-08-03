import { TrackedBuilder, HP, mul, mix3, STRAND } from './CoatBuild.js';

/**
 * RED SANDS — MANE, FORELOCK, TAIL, FEATHER
 * ============================================================================
 * The previous build made every one of these a FLAT CARD hanging straight down
 * from the centreline of the crest, which is why the self-report called the
 * mane "a dark strip with strand break-up along the crest": the locks fell
 * INSIDE the neck geometry and all you ever saw was the sliver of card poking
 * out either side, and the tail read as three brown playing cards.
 *
 * Three things are different here:
 *
 *  1. LOCKS HAVE VOLUME. A lock is not a quad, it is a swept strip three
 *     columns wide whose middle column is pushed out along the card normal, so
 *     it has a rounded cross-section and reads as a rope of hair from any
 *     angle instead of vanishing edge-on.
 *
 *  2. LOCKS DRAPE. Every lock's centreline leaves the crest, wraps OVER the
 *     shoulder of the neck out to roughly the neck's own half-width, and only
 *     then falls. That is what puts hair on the silhouette.
 *
 *  3. THE SILHOUETTE IS BROKEN. Lengths vary 0.55x to 1.5x within a layer and
 *     the layers themselves are at different depths, so the bottom edge is
 *     ragged at the scale of a whole lock rather than at the scale of the
 *     alpha mask's fringe.
 * ============================================================================
 */

const V3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
  cross: (a, b) => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
  ],
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

/**
 * One lock of hair with a rounded cross-section.
 *
 * @param {TrackedBuilder} B
 * @param {function} centre  t in 0..1 -> [x,y,z] world-ish centreline
 * @param {number[]} broad   preferred "wide" axis, orthogonalised per station
 * @param {object} o { width, bulge, bones, uOff, tintK, cols, rows, tipFade }
 */
function lock(B, centre, broad, o) {
  const cols = o.cols || 2;          // 2 quads across => 3 columns of vertices
  const rows = o.rows || 6;
  B.sheet(cols, rows, (u, t) => {
    const eps = 1 / (rows * 2);
    const p = centre(t);
    const pa = centre(Math.max(0, t - eps));
    const pb = centre(Math.min(1, t + eps));
    const T = V3.norm(V3.sub(pb, pa));
    let W = V3.sub(broad, V3.mul(T, broad[0] * T[0] + broad[1] * T[1] + broad[2] * T[2]));
    if (Math.hypot(W[0], W[1], W[2]) < 1e-5) W = [1, 0, 0];
    W = V3.norm(W);
    const N = V3.norm(V3.cross(T, W));
    const s = u - 0.5;
    // splay a little toward the tip, and thin the volume out as it falls
    const wid = o.width * (0.86 + 0.34 * t);
    const bul = o.bulge * (1 - 0.55 * t) * Math.sin(Math.min(1, u) * Math.PI);
    return {
      p: [
        p[0] + W[0] * s * wid + N[0] * bul,
        p[1] + W[1] * s * wid + N[1] * bul,
        p[2] + W[2] * s * wid + N[2] * bul,
      ],
      /*
       * TEXTURE SLICE. The strand mask holds eleven locks across its width, so
       * a card that sampled 0.40 of it — as the first version did — spread
       * four and a half of them over one lock and the alpha test cut the gaps
       * between them into holes: at 1:1 every card read as a comb of thin
       * spikes rather than as one lock. 0.15 puts about one and a half mask
       * locks on a card, which is the solid core with feathered sides the mask
       * was drawn for.
       */
      uv: [u * 0.20 + o.uOff, t],
      bones: o.bones,
      /*
       * Mane and tail hair must sit clearly BELOW the coat in value or the
       * whole animal flattens out. The strand class already gets a strong
       * forward-scatter rim from the shared shader, which was lifting these
       * cards back up to the coat's own brown.
       */
      color: mix3(mul(HP.mane, o.tintK * (0.46 + 0.44 * (1 - t))),
        HP.maneLit, 0.10 * (1 - t)),
    };
  }, { color: HP.mane, rough: 0.70, sheen: 0.55 });
}

/**
 * The crest line of the neck, in object space, with the neck's own half-width
 * at each station so the mane knows how far out to drape.
 *
 * Derived from the same key list HorseBody sweeps the neck from. The crest of
 * a tube swept by parallel transport of a planar path sits at
 *   p + (0, T.z, -T.y) * rx * crestBulge
 * with T the unit tangent — up and back, which is where a crest is.
 */
const NECK_KEYS = [
  { p: [0, 1.418, 0.494], rx: 0.252, rz: 0.184, b: ['chest', 1] },
  { p: [0, 1.492, 0.560], rx: 0.240, rz: 0.168, b: ['chest', 0.72, 'neck1', 0.28] },
  { p: [0, 1.566, 0.628], rx: 0.224, rz: 0.152, b: ['chest', 0.36, 'neck1', 0.64] },
  { p: [0, 1.652, 0.700], rx: 0.206, rz: 0.136, b: ['neck1', 0.72, 'neck2', 0.28] },
  { p: [0, 1.744, 0.776], rx: 0.188, rz: 0.121, b: ['neck1', 0.30, 'neck2', 0.70] },
  { p: [0, 1.838, 0.854], rx: 0.170, rz: 0.108, b: ['neck2', 1] },
  { p: [0, 1.918, 0.926], rx: 0.152, rz: 0.098, b: ['neck2', 0.52, 'neck3', 0.48] },
  { p: [0, 1.978, 0.996], rx: 0.134, rz: 0.090, b: ['neck3', 1] },
  { p: [0, 2.020, 1.040], rx: 0.116, rz: 0.086, b: ['neck3', 1] },
];

function crestLine(rig) {
  const n = NECK_KEYS.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = NECK_KEYS[i];
    const a = NECK_KEYS[Math.max(0, i - 1)].p;
    const b = NECK_KEYS[Math.min(n - 1, i + 1)].p;
    const T = V3.norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const v = i / (n - 1);
    const bulge = 1 + 0.090 * (0.40 + 0.60 * Math.exp(-Math.pow((v - 0.34) / 0.45, 2)));
    const r = k.rx * bulge;
    out.push({
      p: [k.p[0], k.p[1] + T[2] * r, k.p[2] - T[1] * r],
      half: k.rz * 1.02,
      bones: rig.w(k.b[0], k.b[1], k.b[2], k.b[3]),
      v,
    });
  }
  return out;
}

/** Catmull-ish sample of the crest line at 0..1 (0 = withers, 1 = poll). */
function sampleCrest(line, t) {
  const f = Math.max(0, Math.min(1, t)) * (line.length - 1);
  const i = Math.min(line.length - 2, Math.floor(f));
  const k = f - i;
  const a = line[i], b = line[i + 1];
  return {
    p: [a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k, a.p[2] + (b.p[2] - a.p[2]) * k],
    half: a.half + (b.half - a.half) * k,
    bones: k < 0.5 ? a.bones : b.bones,
  };
}

/**
 * @param {Rig} rig
 * @param {function} rand deterministic rng
 * @param {object} opts { q } 1.0 = LOD0, 0.5 = LOD1
 * @returns {{geo:THREE.BufferGeometry, organic:Uint8Array}}
 */
export function buildHorseHair(rig, rand, opts = {}) {
  const q = opts.q != null ? opts.q : 1;
  const B = new TrackedBuilder();
  const w = (a, wa, b, wb) => rig.w(a, wa, b, wb);
  /*
   * Hair lay for the coat shader: straight down and slightly back. Without a
   * flow the cards fall back on the default -Z, which streaks the grain ACROSS
   * a hanging lock instead of along it — the one thing that would stop a lock
   * reading as hair at all.
   */
  B.organic(false).surface(STRAND).flow(() => [0, -1, -0.16]);
  const ROWS = q >= 0.9 ? 6 : 3;
  const line = crestLine(rig);

  /* ------------------------------------------------------------------ MANE
   * The first attempt at this hung every heavy lock on the horse's OFF side.
   * That is where a groomed mane lies, and it was completely wrong for a game:
   * from the near side — which is the side you mount from, the side the parked
   * horse is framed from, and half of every riding shot — the animal had no
   * mane at all, just the sawtooth of crest hair on the far edge of the neck.
   *
   * The mane now splits: three heavy layers to the off side, two to the near
   * side, and a short crest layer that LIES OVER rather than standing up. All
   * five layers drape out to the neck's own half-width before they fall, so
   * hair is on the silhouette from any angle, and lengths vary 0.6x to 1.5x
   * within a layer so the bottom edge breaks at the scale of a whole lock.
   */
  const NM = Math.max(8, Math.round(17 * q));
  for (let i = 0; i < NM; i++) {
    const t = i / (NM - 1);
    const st = sampleCrest(line, t);
    /*
     * Longest through the middle of the neck, short at the poll and short
     * again at the withers. The first pass at this reached 1.1 m at its
     * longest and draped over the shoulder like a cape; a working saddle
     * horse's mane stops at the base of the neck.
     */
    const base = 0.23 + 0.15 * Math.exp(-Math.pow((t - 0.55) / 0.40, 2));

    for (const [side, layers] of [[-1, 3], [1, 2]]) {
      for (let layer = 0; layer < layers; layer++) {
        const depth = layers > 1 ? layer / (layers - 1) : 0;   // 0 inner, 1 outer
        const len = base * (0.60 + depth * 0.62) * (0.60 + rand() * 0.82)
          * (side > 0 ? 0.86 : 1.0);          // the near side carries less
        const sway = (rand() - 0.5) * 0.06;
        const backLean = 0.12 + rand() * 0.18;
        const outMax = st.half * (0.85 + depth * 0.60) * 1.34;
        const root = [
          st.p[0] + side * (0.010 + depth * 0.009),
          st.p[1] + 0.004,
          st.p[2] - 0.004,
        ];
        /*
         * Drape: out over the shoulder of the neck first, then down. The
         * exponential is at ~95 % of the neck's half-width a third of the way
         * down, which is what a heavy mane actually does.
         */
        const centre = (tt) => {
          const outw = outMax * (1 - Math.exp(-tt * 3.4));
          const drop = len * tt * (0.94 + 0.10 * tt);
          return [
            root[0] + side * outw + sway * tt * tt,
            root[1] - drop,
            root[2] - len * backLean * tt * tt + outw * 0.10,
          ];
        };
        /*
         * Twist each lock's broad plane. Cards that all share one broad axis
         * are coplanar and shingle; spreading the plane over ~+-50 deg means a
         * third of the locks face any given lens and the mane keeps its
         * volume from behind, which is the framing a rider actually has.
         */
        const th = (rand() - 0.5) * 1.15;
        lock(B, centre, [side * 0.35 + th, (rand() - 0.5) * 0.35, 1.0], {
          width: 0.068 + rand() * 0.048 + depth * 0.012,
          bulge: 0.018 + rand() * 0.014,
          bones: st.bones,
          uOff: rand() * 0.55,
          tintK: 0.72 + rand() * 0.62,
          cols: 2, rows: ROWS,
        });
      }
    }

    /*
     * Crest layer. Short hair breaking over the top of the crest to one side
     * or the other. It must LIE OVER: the first version stood it straight up
     * and at 1:1 the neck grew a row of evenly-spaced black spikes.
     */
    {
      const side = (i % 2) ? 1 : -1;
      const len = base * (0.20 + rand() * 0.22);
      const centre = (tt) => [
        st.p[0] + side * st.half * 0.75 * (1 - Math.exp(-tt * 2.6)),
        st.p[1] + 0.006 - len * tt * 0.80,
        st.p[2] - 0.002 - len * 0.34 * tt,
      ];
      lock(B, centre, [side * 0.5, 0, 1], {
        width: 0.044 + rand() * 0.026, bulge: 0.010,
        bones: st.bones, uOff: rand() * 0.6, tintK: 0.95 + rand() * 0.55,
        cols: 2, rows: Math.max(2, ROWS - 2),
      });
    }
  }

  /* -------------------------------------------------------------- FORELOCK
   * Falls from the poll forward between the ears and over the brow. Roots on
   * the head bone so it swings with the head and not with the neck.
   */
  const NF = Math.max(4, Math.round(8 * q));
  for (let i = 0; i < NF; i++) {
    const x = (i / (NF - 1) - 0.5) * 0.086;
    const len = 0.170 * (0.62 + rand() * 0.72);
    const drift = (rand() - 0.5) * 0.05;
    const centre = (tt) => [
      x * (1 + tt * 0.5) + drift * tt * tt,
      2.040 - len * tt * 0.92,
      1.026 + len * (0.36 + 0.20 * tt) * tt,
    ];
    lock(B, centre, [1, 0, 0.25], {
      width: 0.036 + rand() * 0.020, bulge: 0.009 + rand() * 0.006,
      bones: w('head', 1), uOff: rand() * 0.58,
      tintK: 0.78 + rand() * 0.62, cols: 2, rows: ROWS,
    });
  }

  /* ------------------------------------------------------------------ TAIL
   * A real tail is a dense mass at the dock opening into a broken fall. Locks
   * launch from successive points down the dock and fan; the long ones reach
   * to just above the hocks.
   */
  const tailBones = [
    w('tail1', 0.7, 'croup', 0.3), w('tail1', 1),
    w('tail1', 0.4, 'tail2', 0.6), w('tail2', 1),
    w('tail2', 0.4, 'tail3', 0.6), w('tail3', 1),
  ];
  /*
   * The first attempt made 34 wide, long, dead-straight locks fanning outward.
   * At 1:1 that is a bundle of leather straps, because a 0.6 m x 0.06 m quad
   * strip with no curvature IS a strap however good its alpha is. What makes
   * a tail read is MANY NARROW locks, each with its own curl and its own
   * length, hanging as a mass rather than a fan.
   */
  const NT = Math.max(18, Math.round(48 * q));
  for (let i = 0; i < NT; i++) {
    const g = i / (NT - 1);
    const st = Math.min(0.88, Math.pow(rand(), 0.62) * 0.92);
    const bi = Math.min(tailBones.length - 1, Math.floor(st * tailBones.length));
    const ry = 1.520 - st * 0.400;
    const rz = -0.836 - st * 0.185;
    const a = g * Math.PI * 2 + rand() * 0.6;
    const spread = 0.026 + st * 0.030;
    const len = (0.60 - st * 0.20) * (0.60 + rand() * 0.80);
    // hangs first, only spreads near the tip, and curls as it goes
    const outX = Math.cos(a) * (0.055 + rand() * 0.075);
    const outZ = -0.07 - Math.abs(Math.sin(a)) * 0.06;
    const curl = (rand() - 0.5) * 0.16;
    const root = [Math.cos(a) * spread, ry, rz + Math.sin(a) * spread * 0.7];
    const centre = (tt) => {
      const sw = Math.sin(tt * 2.4) * curl * len;
      return [
        root[0] + outX * len * tt * tt + sw * Math.cos(a + 1.57),
        root[1] - len * tt * (0.96 + 0.06 * tt),
        root[2] + outZ * len * tt * tt + sw * Math.sin(a + 1.57),
      ];
    };
    lock(B, centre, [-Math.sin(a), 0, Math.cos(a)], {
      width: 0.020 + rand() * 0.028, bulge: 0.012 + rand() * 0.009,
      bones: tailBones[bi], uOff: rand() * 0.58,
      tintK: 0.70 + rand() * 0.78, cols: 2, rows: ROWS,
    });
  }

  /* --------------------------------------------------------------- FEATHER
   * A working saddle horse is not a shire, but there is always a small tuft
   * of longer hair at the back of the fetlock. It costs 150 triangles and it
   * is the difference between a leg that ends in a joint and one that ends in
   * a machined dowel.
   */
  if (q >= 0.9) {
    for (const [bone, y, z, s] of [
      ['fPasL', 0.245, 0.432, 1], ['fPasR', 0.245, 0.432, -1],
      ['hCanL', 0.245, -0.548, 1], ['hCanR', 0.245, -0.548, -1],
    ]) {
      for (let i = 0; i < 3; i++) {
        const off = (i - 1) * 0.022;
        const len = 0.062 * (0.7 + rand() * 0.7);
        const centre = (tt) => [
          0.207 * s + off * (1 + tt * 0.4),
          y - len * tt * 1.1,
          z - 0.006 - len * 0.5 * tt,
        ];
        lock(B, centre, [1, 0, 0.3], {
          width: 0.028 + rand() * 0.014, bulge: 0.006,
          bones: w(bone, 1), uOff: rand() * 0.6,
          tintK: 0.9 + rand() * 0.6, cols: 1, rows: 3,
        });
      }
    }
  }

  return B.build();
}
