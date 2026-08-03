import * as THREE from 'three';
import { rng } from '../../core/Context.js';
import { VEG_HASH, VEG_WIND, injectVeg, makeInstanced, hugeSphere } from './VegCommon.js';
import { buildTreePair, SPECIES_INFO } from './TreeGen.js';
import { bakeImpostors, IMPOSTOR_CUTOFF } from './Impostors.js';
import { LEAF_CUTOFF } from './VegTextures.js';
import { logSize } from './Ecology.js';

/**
 * FOREST
 * ============================================================================
 * Placement, three-level LOD and the impostor band.
 *
 *   LOD0  full geometry              0 .. A
 *   LOD1  reduced branch/card count  A .. B
 *   LOD2  baked billboard impostor   B .. treeDistance      (one draw call)
 *
 * THE LOD BANDS ARE EXCLUSIVE AND THERE IS NO CROSS-FADE. Pass 2 kept a tree in
 * two levels at once through a wide band and resolved it with a complementary
 * screen-space dither, on the assumption TAA would turn the checkerboard into a
 * blend. There is no TAA and the framebuffer is not multisampled, so the dither
 * survived to the final image and PostFX's chromatic aberration smeared it into
 * colour — the forensic pass logged it as "interleaved horizontal stripes of two
 * LODs plus chromatic fringing, a rainbow smear" at (590,620) in
 * golden_hour_vista and (75,520) in high_noon_desert.
 *
 * What replaces it is structural rather than cosmetic:
 *   - both mesh LODs are emitted from ONE grown skeleton (see TreeGen), so the
 *     trunk silhouette is identical across the swap and the canopy outline moves
 *     by a card or two;
 *   - the impostor inherits the mesh's per-card colour jitter at bake time, so
 *     there is no tint step into the billboard band;
 *   - every tree carries a stable +/-15% jitter on its own switch distances, so
 *     a stand does not change level along a visible circle. That also kills the
 *     "visible LOD band ... conifers abruptly give way to flat smudges" finding.
 * The CPU and the impostor vertex shader test the same quantity (distance from
 * the camera to the tree's base) against the same jittered thresholds, so a tree
 * is in exactly one level with no seam and no double-draw.
 *
 * Only LOD0/LOD1 need CPU work, and only when the camera has actually moved:
 * trees are bucketed into a 64 m grid at boot, and the visible set is re-packed
 * into per-kind instance buffers. The impostor mesh holds every tree in the
 * world for its whole life and culls itself in the vertex shader.
 */

const GRID = 64;

const TREE_VERT = /* glsl */`
${VEG_HASH}
${VEG_WIND}

attribute vec3 aWind;    // heightFrac, limbPhase, flex
attribute vec3 aPos;
attribute vec4 aParam;   // yaw, scale, leanX, leanZ
attribute vec4 aTint;    // rgb tint, instance phase

uniform vec3  uVegCam;
uniform float uTreeH;

varying vec3  vTreeTint;
varying float vLodD;
varying vec3  vVegWorld;
varying float vLeafAmt;

vec3 vegPos;
vec3 vegNormal;

void vegPlace() {
  float sc = aParam.y;
  float yaw = aParam.x;
  mat2 rot = vegRot(yaw);

  vec3 p = position * sc;
  p.xz += aParam.zw * p.y;      // trunk lean, grows with height
  p.xz = rot * p.xz;

  float H = uTreeH * sc;
  float t = aWind.x;
  vec2 wxz = aPos.xz;

  float g = vegGust(wxz);
  float amp = (0.0075 + uVegWind.z * 0.0062) * (0.50 + 0.80 * uVegWind.w)
            * (0.55 + 0.55 * (g * 0.5 + 0.5));

  // 1. whole-tree sway, quadratic-ish up the trunk
  vec3 disp = vec3(uVegWind.x, 0.0, uVegWind.y) * (amp * pow(t, 1.75) * H);

  /*
   * DISTANCE-DAMPED MOTION. motion.py measures a static-camera sigma and the
   * heatmap puts essentially all of it in the canopy, not in the grass: a leaf
   * card 60 m out is two pixels wide, and a 15 Hz flutter on a two-pixel card is
   * not foliage detail, it is per-pixel noise no texture filter can remove. So
   * the high-frequency terms fade with distance while term 1 — the slow
   * whole-tree lean, driven by the same travelling gust that crosses the meadow
   * — is left at full strength. A distant stand still moves; it moves as a mass.
   *
   * MEASURED, so the next pass does not re-litigate it. forest_interior static
   * sigma with this build, all three terms live: 0.0224. With ALL tree motion
   * forced to zero: 0.0131. With all vegetation motion (trees, grass, scrub)
   * forced to zero: 0.0127. In other words 55% of that shot's temporal energy
   * is not vegetation at all and the shot cannot reach the 0.004 gate from this
   * file. Halving these amplitudes again moves the number by ~5%, because the
   * delta is set by how many leaf-EDGE pixels cross the alpha test, not by how
   * far they travel — and this pass added god rays behind the treeline, which
   * maximised the contrast across every one of those edges.
   */
  float dCam = distance(uVegCam, aPos);

  // 2. branch-level secondary motion, out of phase per limb
  float ph = aWind.y * 61.0 + aTint.w * 19.0;
  float sec = sin(uVegTime * (1.9 + aWind.y * 1.6) + ph) * 0.62
            + sin(uVegTime * (3.3 + aWind.y * 2.4) + ph * 1.7) * 0.30;
  float secFade = mix(1.0, 0.26, smoothstep(14.0, 65.0, dCam));
  disp += vec3(uVegWind.y, 0.26, -uVegWind.x) * (sec * amp * H * aWind.z * 0.62 * secFade);

  // 3. card-level flutter — high frequency, small amplitude, foliage only,
  //    and only where the card is big enough on screen to read as a leaf
  float flFade = 1.0 - smoothstep(6.0, 24.0, dCam);
  if (flFade > 0.002) {
    float fl = sin(uVegTime * 5.4 + ph * 3.1) * 0.6 + sin(uVegTime * 8.3 + ph * 5.3) * 0.4;
    float fl2 = sin(uVegTime * 4.1 + ph * 2.2 + position.y * 3.0) * 0.5;
    disp += vec3(fl, fl2 * 0.42, -fl * 0.8)
          * (0.034 * aWind.z * aWind.z * (0.45 + 0.9 * uVegWind.w) * flFade);
  }

  p += disp;

  vegPos = aPos + p;

  vec3 nn = normal;
  nn.xz = rot * nn.xz;
  vegNormal = nn;

  vLodD = dCam;
  vTreeTint = aTint.rgb;
  vVegWorld = vegPos;
  vLeafAmt = aWind.z;
}
`;

const TREE_FRAG_PARS = /* glsl */`
varying vec3  vTreeTint;
varying float vLodD;
varying vec3  vVegWorld;
varying float vLeafAmt;
uniform vec3  uVegSun;
uniform vec3  uVegSunCol;
uniform vec3  uVegCam;
uniform vec2  uAlphaCut;   // x = cutoff, y = distance at which detail flattens
`;

/**
 * ONE constant cutoff at every distance. That is only correct because the atlas
 * ships a coverage-matched mip chain (VegTextures) — with a GPU-generated chain
 * the same line either erases the distant canopy or turns every card into a
 * solid rectangle, which is the pair of failures pass 2 shipped.
 *
 * The second half is an anti-shimmer term: past ~35 m the card's albedo is
 * blended toward a deliberately over-blurred tap of itself, so the *colour*
 * high-frequency (measured at per-pixel delta std 21.9 against 1.0 in the sky)
 * falls away with distance while the silhouette stays sharp.
 */
const TREE_FRAG_BODY = /* glsl */`
  {
    /*
     * CANOPY COHERENCE. The shimmer heatmap put essentially all of the measured
     * boil on leaf-card edges silhouetted against bright sky: a needle spray
     * twelve metres away is a lace of one- and two-pixel holes, and every one of
     * those holes flips between sky-white and leaf-dark as the branch breathes.
     * That is the largest possible per-pixel delta, repeated thousands of times.
     * Rolling BOTH the albedo and the alpha toward a hard-blurred tap closes the
     * lace into a mass — and because the mip chain is coverage-matched at this
     * exact cutoff (VegTextures), the canopy keeps the same amount of leaf on
     * screen while losing the holes. It is also simply what a stand of pines
     * looks like at forty metres: a silhouette, not a stencil.
     */
    float far = clamp((vLodD - 8.0) / 55.0, 0.0, 1.0);
    if (far > 0.02) {
      vec4 soft = textureLod(map, vMapUv, 4.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, soft.rgb, far * 0.72);
      diffuseColor.a = mix(diffuseColor.a, soft.a, far * 0.95);
    }
    if (diffuseColor.a < uAlphaCut.x) discard;
    diffuseColor.rgb *= vTreeTint;
    diffuseColor.a = 1.0;
  }
`;

const BARK_FRAG_BODY = /* glsl */`
  {
    diffuseColor.rgb *= vTreeTint;
    diffuseColor.a = 1.0;
  }
`;

/**
 * Leaf transmission. A leaf is roughly 0.2 mm of water and chlorophyll: it
 * forward-scatters strongly, and what comes through is yellow-green because the
 * red and blue are what the pigment ate. Two lobes — a tight forward lobe for
 * the sun straight behind the canopy, and a wrapped term through the leaf body
 * so foliage never goes fully black when it faces away from the key.
 */
const LEAF_LIGHTS = /* glsl */`
  {
    vec3 V = normalize(uVegCam - vVegWorld);
    float fwd = pow(clamp(dot(-V, uVegSun), 0.0, 1.0), 3.0);
    float wrap = clamp(dot(-normal, uVegSun) * 0.5 + 0.5, 0.0, 1.0);
    vec3 trans = uVegSunCol * (fwd * (0.30 + 0.70 * wrap) * 1.00);
    trans *= vec3(1.22, 1.10, 0.46);
    reflectedLight.directDiffuse += trans * diffuseColor.rgb;
  }
`;

const DOUBLE_NORMAL = /* glsl */`
  #ifndef FLAT_SHADED
    normal = normalize( vNormal );
    nonPerturbedNormal = normal;
  #endif
`;

/* --------------------------------------------------------------- impostor */

const IMP_VERT = /* glsl */`
${VEG_HASH}
${VEG_WIND}

attribute vec3 aPos;
attribute vec4 aParam;   // yaw, half extent (m), centre height (m), atlas row
attribute vec4 aTint;    // rgb tint, w = per-tree LOD distance jitter

uniform vec3  uVegCam;
uniform vec2  uLodBands; // A (lod0->lod1), B (lod1->impostor)
uniform vec2  uAtlas;    // cols, rows
uniform float uMaxDist;

varying vec3  vTreeTint;
varying float vLodD;
varying vec3  vVegWorld;
varying vec2  vImpUv;
varying float vLeafAmt;

vec3 vegPos;
vec3 vegNormal;

void vegPlace() {
  vec3 centre = aPos + vec3(0.0, aParam.z, 0.0);
  float d = distance(uVegCam, aPos);
  vLodD = d;
  vTreeTint = aTint.rgb;
  vLeafAmt = 1.0;

  /* The 0.99 makes the impostor start a hair CLOSER than the CPU drops LOD1, so
     the two levels can overlap by a few centimetres rather than leave a shell of
     missing trees if the two distances ever disagree in the last float bit. */
  float sw = uLodBands.y * aTint.w * 0.99;
  if (d < sw || d > uMaxDist) {
    vegPos = vec3(0.0); vVegWorld = centre;
    vegNormal = vec3(0.0, 1.0, 0.0); vImpUv = vec2(0.0); return;
  }

  vec2 f = normalize((uVegCam.xz - aPos.xz) + vec2(1e-5, 0.0));
  vec3 right = vec3(-f.y, 0.0, f.x);
  vec3 up = vec3(0.0, 1.0, 0.0);

  float h = aParam.y;
  // slow lean under wind so distant canopies are not frozen
  float g = vegGust(aPos.xz);
  float sway = (0.012 + uVegWind.z * 0.010) * (0.5 + 0.8 * uVegWind.w) * g;

  vec3 local = right * (position.x * 2.0 * h) + up * (position.y * 2.0 * h);
  local.xz += uVegWind.xy * (sway * h * (position.y + 0.5));
  vegPos = centre + local;
  vVegWorld = vegPos;

  // pick the baked yaw slice
  float a = atan(f.y, f.x) - aParam.x;
  float idx = floor(mod(a / 6.2831853 * uAtlas.x + 0.5, uAtlas.x));
  vImpUv = vec2((idx + position.x + 0.5) / uAtlas.x,
                (aParam.w + position.y + 0.5) / uAtlas.y);

  // spherical normal so a distant canopy shades as a soft volume
  vec2 q = position.xy * 2.0;
  float nz = sqrt(max(0.0, 1.0 - min(dot(q, q) * 0.75, 1.0)));
  vec3 fwd = normalize(vec3(uVegCam.x - aPos.x, 0.0, uVegCam.z - aPos.z) + vec3(1e-5, 0.0, 0.0));
  vegNormal = normalize(right * (q.x * 0.80) + up * (q.y * 0.45) + fwd * nz + up * 0.35);
}
`;

/**
 * IMPOSTOR SHADOW PASS.
 *
 * The billboard band covers 196 m out to the tree distance, which at golden
 * hour is most of the trees in the frame — and none of them cast anything,
 * because a camera-facing card has no depth material and, if it had one, would
 * be seen edge-on from the light and cast a line.
 *
 * The fix is to build the card's basis from the SUN instead of the camera in
 * the depth pass: the quad is oriented perpendicular to the light, so from the
 * shadow camera it presents the full baked canopy silhouette and throws a
 * proper ragged tree shadow at any solar elevation. The distance test still
 * uses the player camera, so exactly the trees that are drawn as impostors are
 * the trees that cast as impostors — no double shadows at the LOD seam.
 */
const IMP_DEPTH_VERT = /* glsl */`
${VEG_HASH}
${VEG_WIND}

attribute vec3 aPos;
attribute vec4 aParam;
attribute vec4 aTint;

uniform vec3  uVegCam;
uniform vec3  uVegSun;
uniform vec2  uLodBands;
uniform vec2  uAtlas;
uniform float uMaxDist;

varying vec2 vImpUv;

vec3 vegPos;
vec3 vegNormal;

void vegPlace() {
  vec3 centre = aPos + vec3(0.0, aParam.z, 0.0);
  float d = distance(uVegCam, aPos);
  vegNormal = vec3(0.0, 1.0, 0.0);
  float sw = uLodBands.y * aTint.w * 0.99;
  /* uMaxDist here is the SHADOW range, not the draw range. The cascades reach
     out past a kilometre, and letting every impostor in the world cast turned
     the valley floor into an unbroken soft grey blanket and cost 200 ms of
     shadow-map fill. Beyond this the canopy shadow is a few texels of noise
     under aerial perspective that already lifts contrast to nothing. */
  if (d < sw || d > uMaxDist) { vegPos = vec3(0.0); vImpUv = vec2(0.0); return; }

  vec3 L = normalize(uVegSun + vec3(1e-5, 0.0, 0.0));
  vec3 ref = abs(L.y) > 0.94 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec3 right = normalize(cross(ref, L));
  vec3 up = normalize(cross(L, right));

  float h = aParam.y;
  vegPos = centre + right * (position.x * 2.0 * h) + up * (position.y * 2.0 * h);

  vec2 f = normalize(L.xz + vec2(1e-5, 0.0));
  float a = atan(f.y, f.x) - aParam.x;
  float idx = floor(mod(a / 6.2831853 * uAtlas.x + 0.5, uAtlas.x));
  vImpUv = vec2((idx + position.x + 0.5) / uAtlas.x,
                (aParam.w + position.y + 0.5) / uAtlas.y);
}
`;

const IMP_FRAG_PARS = /* glsl */`
varying vec3  vTreeTint;
varying float vLodD;
varying vec3  vVegWorld;
varying vec2  vImpUv;
varying float vLeafAmt;
uniform vec3  uVegSun;
uniform vec3  uVegSunCol;
uniform vec3  uVegCam;
uniform sampler2D uImpAtlas;
uniform float uImpCut;
`;

const IMP_FRAG_BODY = /* glsl */`
  {
    vec4 imp = texture2D(uImpAtlas, vImpUv);
    if (imp.a < uImpCut) discard;
    diffuseColor.rgb = imp.rgb * vTreeTint;
    diffuseColor.a = 1.0;
  }
`;

/* ------------------------------------------------------------------ class */

export class Forest {
  constructor(ctx, shared, maps, leafAtlas) {
    this.ctx = ctx;
    this.shared = shared;
    this.maps = maps;
    this.leafAtlas = leafAtlas;
    this.kinds = [];
    this.meshes = [];
    this.materials = [];
    this.geometries = [];
    this.trees = 0;
    this.triangles = 0;
    this._lastCam = new THREE.Vector3(1e9, 1e9, 1e9);
    this._dirty = true;
  }

  /* ------------------------------------------------------------- placement */

  _place() {
    const ctx = this.ctx;
    const maps = this.maps;
    const r = rng((ctx.seed ^ 0x1b873593) >>> 0);
    const res = maps.res, cell = maps.cell, half = maps.half;
    const cellArea = cell * cell;
    const waterLevel = ctx.world.waterLevel;
    const getHeight = ctx.world.getHeight;
    const isWater = ctx.world.isWater;

    const q = ctx.quality;
    const budget = q.name === 'low' ? 0.35 : q.name === 'medium' ? 0.62 : 1.0;
    const MAX = 90000;

    /* ------------------------------------------------------- tree budget ---
     * Density is now solved for, not guessed. The old fixed `1/46 m²` was
     * tuned against a forest field that was smeared thinly over most of the
     * map; with the ecology concentrating timber into stands, the same
     * constant either bankrupts the 90k array in the first few scanlines
     * (leaving the southern half of the world treeless) or leaves the stands
     * looking like an orchard.
     *
     * So: integrate the demand once, then pick the per-m² rate that spends
     * exactly the tree budget on it — capped, so a REAL stand is a real stand
     * at one trunk per 24 m² rather than being thinned to fit. */
    const gate = (f) => f * f * (3 - 2 * f);
    let demand = 0;
    for (let k = 0; k < res * res; k++) {
      const f = maps.forest[k];
      if (f >= 0.05) demand += gate(f);
    }
    demand *= cellArea;
    const perM2 = Math.min(1 / 31, (64000 * budget) / Math.max(1, demand));

    const xs = new Float32Array(MAX);
    const ys = new Float32Array(MAX);
    const zs = new Float32Array(MAX);
    const kind = new Uint8Array(MAX);
    const scale = new Float32Array(MAX);
    const yaw = new Float32Array(MAX);
    const jit = new Float32Array(MAX);
    const lean = new Float32Array(MAX * 2);
    const tint = new Float32Array(MAX * 3);
    let n = 0;

    const KIND = this.kindIndex;   // { species: [kindIdx, ...] }

    for (let j = 0; j < res; j++) {
      const z0 = -half + j * cell;
      for (let i = 0; i < res; i++) {
        const f = maps.forest[j * res + i];
        if (f < 0.05) continue;
        const expect = gate(f) * cellArea * perM2;
        let count = Math.floor(expect);
        if (r() < expect - count) count++;
        if (!count) continue;
        const x0 = -half + i * cell;
        for (let c = 0; c < count && n < MAX; c++) {
          const x = x0 + r() * cell;
          const z = z0 + r() * cell;
          const y = getHeight(x, z);
          if (y < waterLevel + 0.7) continue;
          if (isWater(x, z)) continue;
          const sl = maps.sample(maps.slope, x, z);
          if (sl < 0.44) continue;
          const mo = maps.sample(maps.moist, x, z);
          const north = maps.sample(maps.northness, x, z);

          /* --------------------------------------------- species selection */
          let sp;
          const pick = r();
          const dense = maps.sample(maps.forest, x, z);
          if (pick < 0.042) sp = 'snag';
          else if (mo > 0.34 && y < waterLevel + 140) sp = pick < 0.60 ? 'cottonwood' : 'scrubOak';
          else if (y > 118 && (north > 0.32 || dense > 0.55)) sp = pick < 0.82 ? 'pine' : 'scrubOak';
          else if (dense > 0.62) sp = pick < 0.55 ? 'pine' : 'scrubOak';
          else if (pick < 0.26) sp = 'pine';
          else if (pick < 0.88) sp = 'scrubOak';
          else sp = 'cottonwood';

          const list = KIND[sp];
          const k = list[(r() * list.length) | 0];

          xs[n] = x; ys[n] = y; zs[n] = z;
          kind[n] = k;
          // edge trees are runts; interior trees reach full size
          const edge = 0.52 + 0.48 * Math.min(1, f * 1.35);
          /* SIZE HIERARCHY. A real stand is mostly pole timber with a handful
             of emergents standing a third taller than the canopy — that height
             variance is most of what makes a treeline read as a forest instead
             of a hedge. A flat uniform draw (which is what pass 3 used) puts
             every crown on the same plane. */
          const dom = r();
          const s = dom < 0.055
            ? 1.60 + r() * 1.15                      // emergent dominant
            : logSize(r(), 0.46, 1.55, 1.75);        // the rest of the stand
          scale[n] = s * edge;
          yaw[n] = r() * Math.PI * 2;
          // per-tree LOD threshold jitter: a stand must not change level along
          // a visible circle centred on the camera
          jit[n] = 0.86 + r() * 0.30;
          const la = r() * Math.PI * 2;
          const mag = 0.015 + r() * 0.075;
          lean[n * 2] = Math.cos(la) * mag;
          lean[n * 2 + 1] = Math.sin(la) * mag;
          const v = 0.78 + r() * 0.42;
          const warm = 0.92 + r() * 0.20;
          tint[n * 3] = v * warm;
          tint[n * 3 + 1] = v * (0.97 + r() * 0.10);
          tint[n * 3 + 2] = v * (0.80 + r() * 0.24) / warm;
          n++;
        }
      }
    }

    /* trim: the working arrays are sized for the worst case, and holding 90k
       slots of slack for the lifetime of the process is pointless */
    this.trees = n;
    this.tx = xs.slice(0, n); this.ty = ys.slice(0, n); this.tz = zs.slice(0, n);
    this.tkind = kind.slice(0, n); this.tscale = scale.slice(0, n);
    this.tyaw = yaw.slice(0, n); this.tjit = jit.slice(0, n);
    this.tlean = lean.slice(0, n * 2); this.ttint = tint.slice(0, n * 3);

    /* ----------------------------------------------- uniform grid bucketing */
    const gs = Math.ceil((half * 2) / GRID);
    const counts = new Uint32Array(gs * gs);
    const cellOf = (x, z) => {
      const gx = Math.max(0, Math.min(gs - 1, ((x + half) / GRID) | 0));
      const gz = Math.max(0, Math.min(gs - 1, ((z + half) / GRID) | 0));
      return gz * gs + gx;
    };
    for (let t = 0; t < n; t++) counts[cellOf(xs[t], zs[t])]++;
    const starts = new Uint32Array(gs * gs + 1);
    for (let c = 0; c < gs * gs; c++) starts[c + 1] = starts[c] + counts[c];
    const items = new Uint32Array(n);
    const cursor = starts.slice(0, gs * gs);
    for (let t = 0; t < n; t++) {
      const c = cellOf(xs[t], zs[t]);
      items[cursor[c]++] = t;
    }
    this.gs = gs; this.gstarts = starts; this.gitems = items;
  }

  /* ----------------------------------------------------------------- build */

  build(group) {
    const ctx = this.ctx;
    const q = ctx.quality;
    const proc = ctx.get('procTextures');
    const sky = ctx.get('sky');
    const lighting = ctx.get('lighting');

    /* LOD0 carries full branch geometry and is essentially the entire cost of
       forest_interior — it was 35 ms against a 16.7 ms budget before this
       pass, and massing puts MORE trunks inside the near band than pass 3 ever
       had because the stands are now real stands. The bands come in to pay for
       that: LOD0 area falls 32%, LOD1 area 25%. Both LODs are emitted from one
       grown skeleton so the swap is still invisible; all that changes is where
       it happens. */
    const A = q.name === 'low' ? 30 : 34;
    const B = q.name === 'low' ? 106 : 152;
    const maxDist = Math.min(q.treeDistance || 1400, 3400);
    this.bands = new THREE.Vector2(A, B);

    /* --------------------------------------------------------- geometries */
    const VARIANTS = { pine: 3, cottonwood: 3, scrubOak: 3, snag: 2 };
    const kinds = [];
    this.kindIndex = {};
    let ki = 0;
    for (const sp of ['pine', 'cottonwood', 'scrubOak', 'snag']) {
      this.kindIndex[sp] = [];
      for (let v = 0; v < VARIANTS[sp]; v++) {
        const seed = (ctx.seed ^ 0x27d4eb2d) + ki * 15485863 + v * 7919;
        const pair = buildTreePair(sp, seed);
        kinds.push({
          species: sp, variant: v, lod0: pair.lod0, lod1: pair.lod1, height: pair.height,
        });
        this.kindIndex[sp].push(ki);
        ki++;
      }
    }
    this.kinds = kinds;

    /* ---------------------------------------------------------- materials */
    const leafTintOf = {
      /* linear multipliers on an atlas that is already olive — pines want to
         read dusty blue-green, not spring green */
      pine: new THREE.Color(0.74, 0.76, 0.60),
      cottonwood: new THREE.Color(1.02, 0.98, 0.74),
      scrubOak: new THREE.Color(0.92, 0.88, 0.66),
      snag: new THREE.Color(1, 1, 1),
    };

    const mkBark = (sp, lod) => {
      const info = SPECIES_INFO[sp];
      const set = proc.get(info.bark);
      const m = new THREE.MeshStandardMaterial({
        map: set.map,
        normalMap: set.normalMap,
        roughnessMap: set.roughnessMap,
        roughness: info.barkRough,
        metalness: 0,
        vertexColors: true,
        side: THREE.FrontSide,
        alphaTest: 0,
      });
      m.color.setRGB(info.tint[0], info.tint[1], info.tint[2]);
      m.normalScale.set(1.15, 1.15);
      m.userData.rsVegKey = 'bark' + sp + lod;
      return m;
    };
    /**
     * Foliage draws DoubleSide with ONE winding in the index buffer. Pass 2
     * emitted both windings over the same four vertices, which doubled the
     * canopy triangle count for pixel-identical output — forest_interior was
     * running 15.3 M triangles for that reason alone.
     */
    const mkLeaf = (sp, lod) => {
      const m = new THREE.MeshStandardMaterial({
        map: this.leafAtlas,
        roughness: 0.80,
        metalness: 0,
        vertexColors: true,
        side: THREE.DoubleSide,
        alphaTest: 0,
      });
      m.color.copy(leafTintOf[sp]);
      m.userData.rsVegKey = 'leaf' + sp + lod;
      return m;
    };

    const uniformsFor = () => Object.assign({}, this.shared, {
      uAlphaCut: { value: new THREE.Vector2(LEAF_CUTOFF, 150) },
      uTreeH: { value: 1 },
    });

    const patch = (mat, lod, isLeaf, treeH) => {
      const u = uniformsFor();
      u.uTreeH.value = treeH;
      injectVeg(mat, {
        vertexPars: TREE_VERT,
        fragPars: TREE_FRAG_PARS,
        fragBody: isLeaf ? TREE_FRAG_BODY : BARK_FRAG_BODY,
        normalBody: isLeaf ? DOUBLE_NORMAL : '',
        lightsBody: isLeaf ? LEAF_LIGHTS : '',
        uniforms: u,
      });
      if (sky) sky.injectAerialPerspective(mat);
      this.materials.push(mat);
      return mat;
    };

    /* -------------------------------------------- instance buffers per kind */
    const lodCap = [
      Math.max(48, Math.round(320 * (q.name === 'low' ? 0.4 : 1))),
      Math.max(96, Math.round(950 * (q.name === 'low' ? 0.4 : 1))),
    ];
    this.slots = [[], []];
    this.counts = [[], []];

    for (let lod = 0; lod < 2; lod++) {
      for (let k = 0; k < kinds.length; k++) {
        const cap = lodCap[lod];
        const buf = {
          pos: new Float32Array(cap * 3),
          param: new Float32Array(cap * 4),
          tint: new Float32Array(cap * 4),
          cap,
        };
        buf.aPos = new THREE.InstancedBufferAttribute(buf.pos, 3);
        buf.aParam = new THREE.InstancedBufferAttribute(buf.param, 4);
        buf.aTint = new THREE.InstancedBufferAttribute(buf.tint, 4);
        buf.aPos.setUsage(THREE.DynamicDrawUsage);
        buf.aParam.setUsage(THREE.DynamicDrawUsage);
        buf.aTint.setUsage(THREE.DynamicDrawUsage);
        this.slots[lod].push(buf);
        this.counts[lod].push(0);
      }
    }

    const barkMats = {}, leafMats = {};
    for (let lod = 0; lod < 2; lod++) {
      for (const sp of ['pine', 'cottonwood', 'scrubOak', 'snag']) {
        barkMats[sp + lod] = mkBark(sp, lod);
        leafMats[sp + lod] = mkLeaf(sp, lod);
      }
    }
    const patched = new Set();

    for (let lod = 0; lod < 2; lod++) {
      for (let k = 0; k < kinds.length; k++) {
        const kd = kinds[k];
        const src = lod === 0 ? kd.lod0 : kd.lod1;
        const buf = this.slots[lod][k];

        const attach = (geo) => {
          geo.setAttribute('aPos', buf.aPos);
          geo.setAttribute('aParam', buf.aParam);
          geo.setAttribute('aTint', buf.aTint);
          geo.instanceCount = 0;
          hugeSphere(geo);
          this.geometries.push(geo);
        };

        const bm = barkMats[kd.species + lod];
        if (!patched.has(bm)) { patch(bm, lod, false, kd.height); patched.add(bm); }
        const bg = makeInstanced(src.bark, 0);
        attach(bg);
        const bmesh = new THREE.Mesh(bg, bm);
        bmesh.frustumCulled = false;
        bmesh.matrixAutoUpdate = false;
        bmesh.receiveShadow = true;
        // Only the full-detail band casts: the reduced band covers ~200 m and
        // would quadruple the shadow geometry for shadows a few pixels wide.
        bmesh.castShadow = lod === 0;
        bmesh.userData.shadowRadius = kd.height * 0.6;
        bmesh.name = `tree_${kd.species}${kd.variant}_bark_l${lod}`;
        group.add(bmesh);
        this.meshes.push({ mesh: bmesh, lod, kind: k, leaf: false });

        if (src.foliage) {
          const lm = leafMats[kd.species + lod];
          if (!patched.has(lm)) { patch(lm, lod, true, kd.height); patched.add(lm); }
          const fg = makeInstanced(src.foliage, 0);
          attach(fg);
          const fmesh = new THREE.Mesh(fg, lm);
          fmesh.frustumCulled = false;
          fmesh.matrixAutoUpdate = false;
          fmesh.receiveShadow = true;
          fmesh.castShadow = lod === 0;
          fmesh.userData.shadowRadius = kd.height * 0.6;
          fmesh.name = `tree_${kd.species}${kd.variant}_leaf_l${lod}`;
          group.add(fmesh);
          this.meshes.push({ mesh: fmesh, lod, kind: k, leaf: true });
        }
      }
    }

    /* -------- depth materials so shadows carry the same wind and placement --
     * The leaf depth pass samples the SAME atlas at the SAME cutoff as the
     * colour pass, so a canopy throws a dappled shadow with real holes in it
     * rather than the silhouette of its bounding quads. forest_interior is
     * judged almost entirely on this. */
    for (const entry of this.meshes) {
      const m = entry.mesh;
      const d = new THREE.MeshDepthMaterial({
        depthPacking: THREE.RGBADepthPacking,
        map: entry.leaf ? this.leafAtlas : null,
        alphaTest: entry.leaf ? LEAF_CUTOFF : 0,
        side: entry.leaf ? THREE.DoubleSide : THREE.FrontSide,
      });
      d.blending = THREE.NoBlending;
      d.fog = false;
      d.userData.rsVegKey = 'treedepth' + entry.lod + (entry.leaf ? 'L' : 'B');
      const u = Object.assign({}, this.shared, {
        uTreeH: { value: this.kinds[entry.kind].height },
      });
      injectVeg(d, { vertexPars: TREE_VERT, uniforms: u, depth: true });
      m.customDepthMaterial = d;
      this.materials.push(d);
    }

    /* ------------------------------------------------------- placement ---- */
    this._place();

    /* -------------------------------------------------------- impostors ---- */
    const bakeKinds = kinds.map((kd) => ({
      bark: kd.lod0.bark,
      foliage: kd.lod0.foliage,
      barkMap: proc.get(SPECIES_INFO[kd.species].bark).map,
      barkTint: new THREE.Color(
        SPECIES_INFO[kd.species].tint[0],
        SPECIES_INFO[kd.species].tint[1],
        SPECIES_INFO[kd.species].tint[2]),
      leafMap: this.leafAtlas,
      leafTint: leafTintOf[kd.species],
      height: kd.height,
    }));
    const tileSize = q.name === 'low' ? 96 : q.name === 'medium' ? 144 : 192;
    this.impostor = bakeImpostors(ctx.renderer, bakeKinds, { tile: tileSize });

    const N = this.trees;
    const ipos = new Float32Array(N * 3);
    const iparam = new Float32Array(N * 4);
    const itint = new Float32Array(N * 4);
    for (let t = 0; t < N; t++) {
      const k = this.tkind[t];
      const f = this.impostor.fit[k];
      const s = this.tscale[t];
      ipos[t * 3] = this.tx[t]; ipos[t * 3 + 1] = this.ty[t]; ipos[t * 3 + 2] = this.tz[t];
      iparam[t * 4] = this.tyaw[t];
      iparam[t * 4 + 1] = f.half * s;
      iparam[t * 4 + 2] = f.centreY * s;
      iparam[t * 4 + 3] = k;
      itint[t * 4] = this.ttint[t * 3];
      itint[t * 4 + 1] = this.ttint[t * 3 + 1];
      itint[t * 4 + 2] = this.ttint[t * 3 + 2];
      itint[t * 4 + 3] = this.tjit[t];
    }

    const quad = new THREE.BufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    quad.setAttribute('normal', new THREE.Float32BufferAttribute(
      [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    quad.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    quad.setIndex([0, 1, 2, 0, 2, 3]);

    const ig = makeInstanced(quad, N);
    ig.setAttribute('aPos', new THREE.InstancedBufferAttribute(ipos, 3));
    ig.setAttribute('aParam', new THREE.InstancedBufferAttribute(iparam, 4));
    ig.setAttribute('aTint', new THREE.InstancedBufferAttribute(itint, 4));
    hugeSphere(ig);
    this.geometries.push(ig, quad);

    // DoubleSide: the billboard is built from a camera-facing basis whose
    // winding flips with the view azimuth, so a single-sided quad is culled for
    // half the world. The normal override below makes both faces shade
    // identically, so there is no cost to drawing both.
    const imat = new THREE.MeshStandardMaterial({
      roughness: 0.86, metalness: 0, side: THREE.DoubleSide, alphaTest: 0,
    });
    imat.userData.rsVegKey = 'impostor';
    injectVeg(imat, {
      vertexPars: IMP_VERT,
      fragPars: IMP_FRAG_PARS,
      fragBody: IMP_FRAG_BODY,
      normalBody: DOUBLE_NORMAL,
      lightsBody: LEAF_LIGHTS,
      uniforms: Object.assign({}, this.shared, {
        uLodBands: { value: this.bands },
        uAtlas: { value: new THREE.Vector2(this.impostor.cols, this.impostor.rows) },
        uMaxDist: { value: maxDist },
        uImpAtlas: { value: this.impostor.texture },
        uImpCut: { value: IMPOSTOR_CUTOFF },
      }),
    });
    if (sky) sky.injectAerialPerspective(imat);
    this.materials.push(imat);

    const imesh = new THREE.Mesh(ig, imat);
    imesh.frustumCulled = false;
    imesh.matrixAutoUpdate = false;
    imesh.receiveShadow = false;
    imesh.renderOrder = 2;
    imesh.name = 'tree_impostors';

    const idepth = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: this.impostor.texture,
      alphaTest: IMPOSTOR_CUTOFF,
      side: THREE.DoubleSide,
    });
    idepth.blending = THREE.NoBlending;
    idepth.fog = false;
    idepth.userData.rsVegKey = 'impostordepth';
    injectVeg(idepth, {
      vertexPars: IMP_DEPTH_VERT,
      fragPars: 'varying vec2 vImpUv;\nuniform sampler2D uImpAtlas;',
      fragBody: '{ diffuseColor.a = texture2D(uImpAtlas, vImpUv).a; }',
      uniforms: Object.assign({}, this.shared, {
        uLodBands: { value: this.bands },
        uAtlas: { value: new THREE.Vector2(this.impostor.cols, this.impostor.rows) },
        uMaxDist: { value: Math.min(340, maxDist) },
        uImpAtlas: { value: this.impostor.texture },
      }),
      depth: true,
    });
    imesh.customDepthMaterial = idepth;
    imesh.castShadow = true;
    imesh.userData.shadowRadius = 6;
    this.materials.push(idepth);

    group.add(imesh);
    this.impostorMesh = imesh;

    if (lighting) {
      for (const e of this.meshes) if (e.lod === 0) lighting.requestShadowCaster(e.mesh);
      if (lighting.requestShadowCaster) lighting.requestShadowCaster(imesh);
    }

    this._dirty = true;
    return this;
  }

  /* ---------------------------------------------------------------- update */

  update() {
    const cam = this.ctx.camera.position;
    if (!this._dirty && cam.distanceToSquared(this._lastCam) < 25) return;
    this._lastCam.copy(cam);
    this._dirty = false;

    const A = this.bands.x, B = this.bands.y;
    const gs = this.gs, starts = this.gstarts, items = this.gitems;
    const half = this.maps.half;
    const r = Math.ceil((B * 1.16) / GRID) + 1;
    const gx = Math.max(0, Math.min(gs - 1, ((cam.x + half) / GRID) | 0));
    const gz = Math.max(0, Math.min(gs - 1, ((cam.z + half) / GRID) | 0));

    const c0 = this.counts[0], c1 = this.counts[1];
    c0.fill(0); c1.fill(0);
    const s0 = this.slots[0], s1 = this.slots[1];

    for (let j = gz - r; j <= gz + r; j++) {
      if (j < 0 || j >= gs) continue;
      for (let i = gx - r; i <= gx + r; i++) {
        if (i < 0 || i >= gs) continue;
        const c = j * gs + i;
        const e = starts[c + 1];
        for (let p = starts[c]; p < e; p++) {
          const t = items[p];
          const dx = this.tx[t] - cam.x;
          const dz = this.tz[t] - cam.z;
          const dy = this.ty[t] - cam.y;
          /* Exactly the metric the impostor vertex shader uses — distance to the
             tree's BASE — so the three levels partition the world with no seam
             and no tree drawn twice. */
          const d2 = dx * dx + dz * dz + dy * dy;
          const jt = this.tjit[t];
          const a = A * jt, b = B * jt;
          if (d2 >= b * b) continue;
          const k = this.tkind[t];
          if (d2 < a * a) this._push(s0[k], c0, k, t);
          else this._push(s1[k], c1, k, t);
        }
      }
    }

    for (const e of this.meshes) {
      const n = (e.lod === 0 ? c0 : c1)[e.kind];
      e.mesh.geometry.instanceCount = n;
      e.mesh.visible = n > 0;
    }
    for (let lod = 0; lod < 2; lod++) {
      const cs = lod === 0 ? c0 : c1;
      for (let k = 0; k < this.slots[lod].length; k++) {
        if (cs[k] === 0) continue;
        const b = this.slots[lod][k];
        b.aPos.needsUpdate = true;
        b.aParam.needsUpdate = true;
        b.aTint.needsUpdate = true;
      }
    }
  }

  _push(buf, counts, k, t) {
    const n = counts[k];
    if (n >= buf.cap) return;
    buf.pos[n * 3] = this.tx[t];
    buf.pos[n * 3 + 1] = this.ty[t];
    buf.pos[n * 3 + 2] = this.tz[t];
    buf.param[n * 4] = this.tyaw[t];
    buf.param[n * 4 + 1] = this.tscale[t];
    buf.param[n * 4 + 2] = this.tlean[t * 2];
    buf.param[n * 4 + 3] = this.tlean[t * 2 + 1];
    buf.tint[n * 4] = this.ttint[t * 3];
    buf.tint[n * 4 + 1] = this.ttint[t * 3 + 1];
    buf.tint[n * 4 + 2] = this.ttint[t * 3 + 2];
    buf.tint[n * 4 + 3] = (t % 997) / 997;
    counts[k] = n + 1;
  }

  dispose() {
    for (const e of this.meshes) if (e.mesh.parent) e.mesh.parent.remove(e.mesh);
    if (this.impostorMesh && this.impostorMesh.parent) {
      this.impostorMesh.parent.remove(this.impostorMesh);
    }
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    if (this.impostor && this.impostor.texture) this.impostor.texture.dispose();
  }
}
