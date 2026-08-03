import * as THREE from 'three';
import { rng } from '../../core/Context.js';
import {
  VEG_HASH, VEG_TERRAIN, VEG_WIND, injectVeg, makeInstanced, hugeSphere,
} from './VegCommon.js';
import { FLOWER_COLS, FLOWER_CUTOFF, FLOWER_TILES } from './VegTextures.js';

/**
 * WILDFLOWERS — occasional pops of colour, and nothing more than that.
 * ============================================================================
 *
 * The brief for this layer is one word: OCCASIONAL. Every reference frame in
 * refs/rdr2 that contains ground cover contains either no flowers at all or ONE
 * small drift somewhere in the near band; the moonlit meadow (gp_18) is the
 * densest of them and its yellow patch is maybe five percent of the visible
 * sward. A field of blooms would read as a screensaver and would undo the dry,
 * sun-bleached palette §5 asks for, so every number below is tuned to be shy.
 *
 * HOW IT STAYS RARE — three independent gates, multiplied:
 *
 *  1. DRIFTS, not probability. A 22 m lattice; two cells in three host no seed
 *     at all, and a seed grows a 3.3-8.1 m disc with a plateau and a soft rim.
 *     One species per drift, so a patch is a stand of paintbrush or a stand of
 *     lupine, never a mixed bouquet. Between the drifts a very low base rate
 *     leaves the odd lone stalk, which is what stops the patches reading as
 *     stamped circles.
 *  2. CONDITION. Flowers need what the ecology already computed: the terrain's
 *     own flow accumulation (moisture), north-facing aspect, forest edge and
 *     open meadow. Almost nothing on a dry ridge, on scree, on sand, on a steep
 *     face, or under closed canopy. Crucially it is gated on the GRASS channel —
 *     a flower standing where no grass will grow is the instant tell that the
 *     placement is fake.
 *  3. DISTANCE. One 34 m ring. A flower head is a few centimetres across and
 *     stops reading long before that; drawing them further is pure fill cost
 *     and pure aliasing.
 *
 * COST. One draw call, one small band, no shadow pass, no custom depth
 * material. Rejected instances collapse to the origin in the vertex shader
 * before any texture fetch, and past ~24 m the fragment shader dissolves the
 * card by raising its alpha threshold against a coverage-matched mip chain —
 * so the card thins out and goes rather than becoming the one-pixel speck that
 * motion.py measures as boiling.
 */

const FLOWER_VERT = /* glsl */`
${VEG_HASH}
${VEG_TERRAIN}
${VEG_WIND}

attribute vec2 aAnchor;
attribute vec4 aRnd;

uniform vec4  uRing;
uniform vec2  uTile;
uniform float uDensity;
uniform float uLoneRate;
uniform vec3  uVegCam;
uniform vec3  uVegCamFwd;
uniform vec2  uTileOffset[8];
uniform vec4  uSpeciesA[8];   // scale(m), stiffness, widthMul, translucency

varying vec3  vFlTint;
varying vec3  vFlUv;          // xy = atlas tile offset, z = petal translucency
varying float vFlDist;
varying vec3  vVegWorld;
varying float vFlT;

vec3 vegPos;
vec3 vegNormal;

/* 22 m lattice, one candidate drift per cell, two cells in three empty. The
   seed is kept inside the middle 40% of its cell so a disc never has to be
   clipped at a cell boundary — one hash pair instead of a 3x3 search.
   The arithmetic: a drift averages 5.7 m across, so drifts cover about 6% of
   ELIGIBLE ground, and the condition gate below rules most ground ineligible.
   In practice one patch lands inside the 34 m ring at a time — you ride up on
   it, you notice it, and then there is nothing for a long while. */
const float FL_CELL = 22.0;

void vegPlace() {
  vec2 d = aAnchor - uVegCam.xz;
  d -= uTile * floor(d / uTile + 0.5);
  vec2 wxz = uVegCam.xz + d;
  float dist = length(d);

  vegNormal = vec3(0.0, 1.0, 0.0);
  vFlTint = vec3(0.0);
  vFlUv = vec3(0.0, 0.0, 1.0);
  vFlDist = dist;
  vFlT = 0.0;
  vVegWorld = vec3(wxz.x, 0.0, wxz.y);

  float band = smoothstep(uRing.x, uRing.y, dist) * (1.0 - smoothstep(uRing.z, uRing.w, dist));
  band *= vegClearing(wxz);
  if (band <= 0.004) { vegPos = vec3(0.0); return; }
  if (dist > 5.0 && dot(vec3(d.x, 0.0, d.y) / dist, uVegCamFwd) < -0.42) {
    vegPos = vec3(0.0); return;
  }

  float h = vegHeight(wxz);
  if (h < uVegWorld.z + 0.35) { vegPos = vec3(0.0); return; }
  vec4 nao = vegNrmAO(wxz);
  /* Steeper than this is scree, talus or a cut bank. Nothing herbaceous holds
     on there and a flower on it is the loudest possible placement error. */
  if (nao.y < 0.64) { vegPos = vec3(0.0); return; }

  vec4 ctrl = vegCtrl(wxz);

  /* ------------------------------------------------------ where they belong */
  float sward = clamp(ctrl.r * 1.35 - 0.20, 0.0, 1.0);   // must have company
  float wet   = clamp(ctrl.a * 1.55, 0.0, 1.0);          // flow accumulation
  float north = clamp(-nao.z * 1.7 + 0.30, 0.0, 1.0);    // shaded aspect
  float open  = 1.0 - smoothstep(0.30, 0.72, ctrl.g);    // meadow, not timber
  float edge  = clamp(ctrl.b * 1.15, 0.0, 1.0) * open;   // forest edge / scrub
  float cond  = sward * open * (0.22 + 1.10 * wet + 0.52 * north + 0.42 * edge);
  cond *= mix(0.80, 1.15, nao.w);                        // hollows over ridges
  /* A GATE, not a density. This decides WHETHER this ground can carry flowers
     at all; the drift below decides how many. Multiplying the two instead —
     which is what the first attempt did — thinned every drift into three lonely
     stalks and turned the whole layer into an even sprinkle, i.e. exactly the
     scattered look the brief rules out. */
  float condGate = smoothstep(0.05, 0.40, cond);
  if (condGate <= 0.01) { vegPos = vec3(0.0); return; }

  /* ------------------------------------------------------------- the drift */
  vec2  cid  = floor(wxz / FL_CELL);
  vec2  hc   = vegHash22(cid + 3.17);
  float roll = vegHash12(cid * 1.731 + 9.4);
  float hR   = vegHash12(cid * 0.917 - 22.1);

  float drift = 0.0;
  if (roll < 0.32) {
    vec2 seedP = (cid + 0.30 + 0.40 * hc) * FL_CELL;
    float rad = FL_CELL * (0.15 + 0.22 * hR);   // 3.3 - 8.1 m across
    /* A PLATEAU with a soft rim, not a bell. A bell-shaped drift has a dense
       centre and a long thin skirt, and the skirt is what reads as "flowers
       scattered everywhere". A patch of paintbrush in the field has an inside
       and an outside. */
    drift = 1.0 - smoothstep(rad * 0.45, rad, distance(wxz, seedP));
  }

  /* A drift is dense; between drifts a handful of strays keep the patches from
     reading as stamped circles. uLoneRate is deliberately tiny. */
  float accept = (drift * uDensity + uLoneRate) * condGate;
  if (aRnd.x > accept) { vegPos = vec3(0.0); return; }

  /* ------------------------------------------------------------- species ---
   * One species per drift (from the cell hash), biased by the ground: the
   * riparian four in a moist swale, the dryland four on open range. Strays
   * between drifts pick from the same table, so a lone marigold still belongs
   * to the country it is standing in. */
  float pick = fract(hR * 37.19 + roll * 5.7);
  int sp;
  if (wet > 0.45) {
    sp = pick < 0.28 ? 5 : (pick < 0.52 ? 4 : (pick < 0.78 ? 3 : 2));
  } else {
    sp = pick < 0.26 ? 0 : (pick < 0.52 ? 1 : (pick < 0.74 ? 6 : (pick < 0.90 ? 7 : 4)));
  }

  vec4 sa = uSpeciesA[sp];
  vFlUv = vec3(uTileOffset[sp], sa.w);

  /* Strays are smaller than the plants in a drift — a single stalk in open
     range is a straggler, not a specimen. */
  float sc = sa.x * mix(0.70, 1.32, aRnd.z) * (0.74 + 0.34 * drift) * band;

  vec3 p3 = position;
  p3.xz *= sc * sa.z;
  p3.y  *= sc;

  float yaw = aRnd.y * 6.2831853;
  mat2 rot = vegRot(yaw);
  p3.xz = rot * p3.xz;
  p3.xz += nao.xz * 0.42 * p3.y;      // lean downslope

  float t = position.y;
  /* Wind. A flower on a bare stem is the loosest thing in the layer — softer
     than grass and much softer than sage — so stiffness is near zero and the
     bend length is scaled up. The extra term is a CROSS-wind nod: a stalk with
     a head on it bobs on its own axis, it does not simply lean downwind, and
     that little out-of-phase motion is most of what sells it as a flower.
     Both are damped out past ~24 m, where the whole card is a few pixels and
     high-frequency motion is measured as boiling rather than life. */
  float flut = 1.0 - smoothstep(9.0, 24.0, dist);
  p3 += vegBend(wxz, t, sa.y, aRnd.y, sc * 2.6, flut);
  vec2 crossW = vec2(-uVegWind.y, uVegWind.x);
  float nod = sin(uVegTime * (2.4 + aRnd.y * 2.2) + aRnd.z * 6.2831853);
  p3.xz += crossW * (nod * 0.050 * (0.40 + 0.09 * uVegWind.z) * sc * t * t * flut);

  vegPos = vec3(wxz.x, h, wxz.y) + p3;

  vec3 nn = normal;
  nn.xz = rot * nn.xz;
  vegNormal = normalize(mix(nn, nao.xyz, 0.34));

  /* MULTIPLIERS around 1.0 — the atlas carries the (already desaturated) hue.
     Everything here is an amount of light, not a colour. */
  vec3 tint = vec3(0.88 + 0.26 * aRnd.w);
  tint *= mix(0.78, 1.08, nao.w);
  tint *= mix(vec3(1.0), vec3(0.72, 0.74, 0.66), clamp(ctrl.g, 0.0, 1.0) * 0.80);
  tint *= 1.0 + 0.09 * vegGust(wxz + vec2(aRnd.y * 61.0));

  vFlTint = tint;
  vFlT = t;
  vVegWorld = vegPos;
}
`;

const FLOWER_FRAG_PARS = /* glsl */`
varying vec3  vFlTint;
varying vec3  vFlUv;
varying float vFlDist;
varying vec3  vVegWorld;
varying float vFlT;
uniform vec3  uVegSun;
uniform vec3  uVegSunCol;
uniform vec3  uVegCam;
uniform vec2  uAlphaCut;    // x = near cutoff, y = cutoff the dissolve ends on
uniform vec2  uFade;        // x = dissolve start (m), y = dissolve length (m)
uniform vec3  uBleach;      // the straw the whole palette is pulled toward
uniform float uDesat;
`;

const FLOWER_FRAG_BODY = /* glsl */`
  {
    vec2 uvT = vMapUv + vFlUv.xy;
    vec4 s = texture2D(map, uvT);
    float far = clamp((vFlDist - uFade.x) / uFade.y, 0.0, 1.0);
    vec3 alb = s.rgb;
    float a = s.a;
    if (far > 0.02) {
      vec4 soft = textureLod(map, uvT, 3.0);
      alb = mix(alb, soft.rgb, far * 0.70);
      a = mix(a, soft.a, far * 0.90);
    }
    /* DISSOLVE, do not alias. The mip chain is coverage-matched at uAlphaCut.x,
       so raising the threshold above it erodes coverage smoothly and
       monotonically: a distant flower thins to nothing instead of strobing as a
       sub-pixel speck against the sward. This is the whole temporal story of
       the layer, and it is why the ring can stop at 34 m for free. */
    if (a < mix(uAlphaCut.x, uAlphaCut.y, far * far)) discard;
    /* The pop comes from hue against sage and straw, not from chroma. Pull
       every petal a fixed fraction toward the scene's own bleached warm grey;
       one knob, and turning it up is what stops a scarlet reading as a bug. */
    float lum = dot(alb, vec3(0.2126, 0.7152, 0.0722));
    alb = mix(alb, vec3(lum) * uBleach, uDesat);
    /* Ground contact — the bottom of the card sinks into the shaded sward so a
       plant grows out of the grass instead of standing on it. */
    alb *= mix(0.46, 1.0, smoothstep(0.0, 0.15, vFlT));
    diffuseColor = vec4(alb * vFlTint, 1.0);
  }
`;

const FLOWER_LIGHTS = /* glsl */`
  {
    vec3 V = normalize(uVegCam - vVegWorld);
    float fwd = pow(clamp(dot(-V, uVegSun), 0.0, 1.0), 2.4);
    float wrap = clamp(dot(-normal, uVegSun) * 0.5 + 0.5, 0.0, 1.0);
    /* SUBSURFACE. A petal is one or two cells thick — it transmits far more
       than a leaf and far more than a stem, which is why the head (vFlT near 1)
       gets almost all of it. This is where the whole feature earns its keep:
       backlit at golden hour a drift lights up like a filament while the sward
       around it is in shadow. The transmitted colour is the PETAL's own, only
       slightly warmed, so a paintbrush glows scarlet rather than yellow. */
    float thin = 0.12 + 0.88 * vFlT * vFlT;
    vec3 trans = uVegSunCol * (fwd * (0.30 + 0.70 * wrap) * thin * 3.1 * vFlUv.z);
    trans *= vec3(1.08, 1.02, 0.80);
    reflectedLight.directDiffuse += trans * diffuseColor.rgb;
  }
`;

const FLOWER_NORMAL = /* glsl */`
  #ifndef FLAT_SHADED
    normal = normalize( vNormal );
    nonPerturbedNormal = normal;
  #endif
`;

/* ---------------------------------------------------------------- geometry */

/**
 * A clump of rooted cards, unit height, all inside ONE atlas column — the
 * per-instance offset picks which column, so eight species cost one draw call.
 * Half the cards are mirrored in u so a clump is not the same silhouette three
 * times over.
 */
function buildClump(cardCount, seed) {
  const r = rng(seed);
  const pos = [], nrm = [], uvs = [], idx = [];
  const TW = 1 / FLOWER_COLS;
  const u0 = TW * 0.02, u1 = TW * 0.98;
  const v0 = 0.003, v1 = 0.997;
  let v = 0;
  for (let c = 0; c < cardCount; c++) {
    const a = (c / cardCount) * Math.PI * 2 + r() * 1.1;
    const rad = c === 0 ? 0.03 : 0.06 + r() * 0.15;
    const cx = Math.cos(a) * rad, cz = Math.sin(a) * rad;
    const h = 0.70 + r() * 0.42;
    const w = h * 0.80;
    const tilt = 0.05 + r() * 0.16;
    const nx = cx * 1.6, ny = 0.9, nz = cz * 1.6;
    const nl = Math.hypot(nx, ny, nz) || 1;
    const ca = Math.cos(a + Math.PI * 0.5), sa = Math.sin(a + Math.PI * 0.5);
    const ex = [ca * w, 0, sa * w];
    const ey = [Math.cos(a) * h * tilt, h, Math.sin(a) * h * tilt];
    const base = v;
    const uA = r() < 0.5 ? u1 : u0;
    const uB = uA === u0 ? u1 : u0;
    const corners = [[-0.5, 0, uA, v0], [0.5, 0, uB, v0], [0.5, 1, uB, v1], [-0.5, 1, uA, v1]];
    for (const [sx, sy, uu, vv] of corners) {
      pos.push(cx + ex[0] * sx + ey[0] * sy,
        -0.015 + ey[1] * sy,
        cz + ex[2] * sx + ey[2] * sy);
      nrm.push(nx / nl, ny / nl, nz / nl);
      uvs.push(uu, vv);
      v++;
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/* ------------------------------------------------------------------- class */

export class Wildflowers {
  constructor(ctx, shared, atlas, defines = {}) {
    this.ctx = ctx;
    this.shared = shared;
    this.atlas = atlas;
    this.defines = defines;
    this.meshes = [];
    this.materials = [];
    this.instances = 0;
    this.triangles = 0;
  }

  build(group) {
    const ctx = this.ctx;
    const q = ctx.quality;
    const sky = ctx.get('sky');
    const budget = q.name === 'low' ? 0.34 : q.name === 'medium' ? 0.66 : 1.0;

    /* Heights against a 1.8 m figure: coneflower is the tall one at ~70 cm,
       primrose the low one at 45. These are the botanically honest numbers AND
       the ones the frame needs — the near grass band tops out around 48 cm, so
       anything shorter has its head inside the sward and is simply not there.
       A wildflower is visible in a meadow precisely because it stands above it.
       Stiffness is near zero across the board: these are the loosest plants in
       the world and they should be the first thing a gust shows up in. */
    const species = [
      { tile: FLOWER_TILES.paintbrush, scale: 0.58, stiff: 0.06, wide: 0.95, trans: 0.85 },
      { tile: FLOWER_TILES.marigold, scale: 0.55, stiff: 0.03, wide: 1.00, trans: 1.05 },
      { tile: FLOWER_TILES.coneflower, scale: 0.72, stiff: 0.02, wide: 0.90, trans: 1.00 },
      { tile: FLOWER_TILES.primrose, scale: 0.45, stiff: 0.10, wide: 1.10, trans: 1.15 },
      { tile: FLOWER_TILES.yarrow, scale: 0.62, stiff: 0.14, wide: 1.00, trans: 1.10 },
      { tile: FLOWER_TILES.lupine, scale: 0.67, stiff: 0.08, wide: 0.88, trans: 0.80 },
      { tile: FLOWER_TILES.mallow, scale: 0.58, stiff: 0.05, wide: 1.05, trans: 0.95 },
      { tile: FLOWER_TILES.aster, scale: 0.48, stiff: 0.04, wide: 1.05, trans: 1.00 },
    ];
    const tileOffsets = species.map(
      (s) => new THREE.Vector2(s.tile / FLOWER_COLS, 0));
    const spA = species.map(
      (s) => new THREE.Vector4(s.scale, s.stiff, s.wide, s.trans));

    /* ONE band. o1 = 34 m: a 4 cm flower head is under a pixel well before
       that, and the dissolve in the fragment shader has already finished by
       ~32 m, so nothing is drawn out there to alias in the first place. */
    const ring = new THREE.Vector4(-3, -1, 24, 34);
    const T = 68;
    const count = Math.max(64, Math.round(T * T * 0.62 * budget));

    const anchors = new Float32Array(count * 2);
    const rnds = new Float32Array(count * 4);
    const M = Math.max(1, Math.ceil(Math.sqrt(count)));
    const r = rng((ctx.seed ^ 0x35d1e7b3) >>> 0);
    for (let i = 0; i < count; i++) {
      const gx = i % M, gy = (i / M) | 0;
      const px = ((gx + 0.5 + (r() - 0.5) * 1.8) / M) * T;
      const pz = ((gy + 0.5 + (r() - 0.5) * 1.8) / M) * T;
      anchors[i * 2] = ((px % T) + T) % T;
      anchors[i * 2 + 1] = ((pz % T) + T) % T;
      rnds[i * 4] = r(); rnds[i * 4 + 1] = r();
      rnds[i * 4 + 2] = r(); rnds[i * 4 + 3] = r();
    }

    const src = buildClump(3, (ctx.seed ^ 0x1b56c4e9) >>> 0);
    const geo = makeInstanced(src, count);
    geo.setAttribute('aAnchor', new THREE.InstancedBufferAttribute(anchors, 2));
    geo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnds, 4));
    hugeSphere(geo);

    const mat = new THREE.MeshStandardMaterial({
      map: this.atlas,
      roughness: 0.86,
      metalness: 0,
      side: THREE.DoubleSide,
      alphaTest: 0,
    });
    mat.userData.rsVegKey = 'flowers';
    /* Alpha-tested foliage takes the cheap cascade filter — and these never
       reach a shadow map at all (see below), so this is belt and braces. */
    mat.userData.rsCheapShadow = true;

    injectVeg(mat, {
      vertexPars: FLOWER_VERT,
      fragPars: FLOWER_FRAG_PARS,
      fragBody: FLOWER_FRAG_BODY,
      normalBody: FLOWER_NORMAL,
      lightsBody: FLOWER_LIGHTS,
      uniforms: Object.assign({}, this.shared, {
        uRing: { value: ring },
        uTile: { value: new THREE.Vector2(T, T) },
        /* Inside a drift on good ground most candidates survive; between
           drifts fewer than one in a hundred and fifty does. Those two numbers
           ARE the brief: a patch you notice, then fifty metres of nothing but
           the odd straggler. */
        uDensity: { value: 1.00 },
        uLoneRate: { value: 0.0045 },
        uTileOffset: { value: tileOffsets },
        uSpeciesA: { value: spA },
        uAlphaCut: { value: new THREE.Vector2(FLOWER_CUTOFF, 0.97) },
        uFade: { value: new THREE.Vector2(15.0, 16.0) },
        uBleach: { value: new THREE.Vector3(1.06, 1.00, 0.86) },
        uDesat: { value: 0.14 },
      }),
      defines: this.defines,
    });
    if (sky) sky.injectAerialPerspective(mat);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    /* NO SHADOW, deliberately. A 30 cm flower's shadow is a smear an eighth of
       a cascade texel wide; all it can contribute is aliasing and a second
       alpha-tested pass over the whole near ring. rsNoShadow keeps Lighting's
       scanScene from opting the mesh back in. */
    mesh.castShadow = false;
    mesh.userData.rsNoShadow = true;
    mesh.renderOrder = 1;
    mesh.name = 'wildflowers';
    group.add(mesh);

    this.meshes.push(mesh);
    this.materials.push(mat);
    this.instances = count;
    this.triangles = count * 3 * 2;
    return this;
  }

  dispose() {
    for (const m of this.meshes) {
      m.geometry.dispose();
      if (m.parent) m.parent.remove(m);
    }
    for (const m of this.materials) m.dispose();
  }
}
