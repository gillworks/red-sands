import * as THREE from 'three';
import { rng } from '../../core/Context.js';
import {
  VEG_HASH, VEG_TERRAIN, VEG_WIND, injectVeg, makeInstanced, hugeSphere,
} from './VegCommon.js';
import { LEAF_TILES, LEAF_CUTOFF } from './VegTextures.js';

/**
 * UNDERGROWTH — sagebrush, rabbitbrush, juniper scrub, ferns near water, dead
 * brush and dry grass tufts.
 *
 * Same GPU-placed toroidal tiling as the grass, but each instance is a small
 * cluster of foliage cards and the *species* is chosen per instance in the
 * vertex shader from the biome map: ferns only where the moisture channel is
 * high, sage on the dry flats, dead brush and juniper through the forest floor,
 * rabbitbrush along the forest edge. One atlas tile per species, selected with a
 * per-instance UV offset, which is why the whole undergrowth layer is two draw
 * calls.
 */

const BUSH_VERT = /* glsl */`
${VEG_HASH}
${VEG_TERRAIN}
${VEG_WIND}

attribute vec2 aAnchor;
attribute vec4 aRnd;

uniform vec4  uRing;
uniform vec2  uTile;
uniform float uDensity;
uniform vec3  uVegCam;
uniform vec3  uVegCamFwd;
uniform vec2  uTileOffset[6];
uniform vec4  uSpeciesA[6];   // scale, stiffness, tintR, tintG
uniform vec2  uSpeciesB[6];   // tintB, widthMul

varying vec3  vBushTint;
varying vec2  vBushUvOff;
varying float vBushDist;
varying vec3  vVegWorld;
varying float vBushT;

vec3 vegPos;
vec3 vegNormal;

void vegPlace() {
  vec2 d = aAnchor - uVegCam.xz;
  d -= uTile * floor(d / uTile + 0.5);
  vec2 wxz = uVegCam.xz + d;
  float dist = length(d);

  vegNormal = vec3(0.0, 1.0, 0.0);
  vBushTint = vec3(0.0);
  vBushUvOff = vec2(0.0);
  vBushDist = dist;
  vBushT = 0.0;
  vVegWorld = vec3(wxz.x, 0.0, wxz.y);

  float band = smoothstep(uRing.x, uRing.y, dist) * (1.0 - smoothstep(uRing.z, uRing.w, dist));
  band *= vegClearing(wxz);   // keep the fire ring / camp floor bare
  if (band <= 0.004) { vegPos = vec3(0.0); return; }
  if (dist > 6.0 && dot(vec3(d.x, 0.0, d.y) / dist, uVegCamFwd) < -0.45) {
    vegPos = vec3(0.0); return;
  }

  vec4 ctrl = vegCtrl(wxz);
  float clump = vegNoise(wxz * 0.105 + 41.0);
  float support = ctrl.b * 1.05 + ctrl.g * 1.05 + ctrl.r * 0.22;
  /* Same argument as the grass: a closed stand's floor is the DENSEST ground
     cover in any reference frame, so the squared clump term (which is what gives
     open scrub its clearings) gets a canopy floor added under timber. */
  float canFloor = clamp(ctrl.g * 1.15, 0.0, 1.0) * 0.38;
  float accept = support * uDensity * (0.10 + 1.5 * clump * clump + canFloor);
  if (aRnd.x > accept) { vegPos = vec3(0.0); return; }

  float h = vegHeight(wxz);
  if (h < uVegWorld.z + 0.30) { vegPos = vec3(0.0); return; }
  vec4 nao = vegNrmAO(wxz);
  if (nao.y < 0.55) { vegPos = vec3(0.0); return; }

  /* -------------------------------- species ---------------------------- */
  int sp = 0;                                  // 0 sage
  float p = aRnd.w;
  if (ctrl.a > 0.46 && p < 0.72) sp = 1;       // fern, riparian
  else if (ctrl.g > 0.36) {
    sp = p < 0.34 ? 2 : (p < 0.62 ? 4 : 5);    // dead brush / juniper / dry grass
  } else if (p > 0.89) sp = 3;                 // rabbitbrush on the dry flats
  else if (p > 0.64) sp = 5;

  vec4 sa = uSpeciesA[sp];
  vec2 sb = uSpeciesB[sp];
  vBushUvOff = uTileOffset[sp];

  float sc = sa.x * mix(0.66, 1.48, aRnd.z) * band;
  vec3 p3 = position;
  p3.xz *= sc * sb.y;
  p3.y *= sc;

  float yaw = aRnd.y * 6.2831853;
  mat2 rot = vegRot(yaw);
  p3.xz = rot * p3.xz;
  p3.xz += nao.xz * 0.5 * p3.y;

  float t = position.y;
  /* Flutter damps out past ~30 m: beyond that a leaf card is a couple of pixels
     and its high-frequency jitter is measured as boiling, not as life. */
  p3 += vegBend(wxz, t, sa.y, aRnd.y, sc, 1.0 - smoothstep(11.0, 30.0, dist));

  vegPos = vec3(wxz.x, h, wxz.y) + p3;

  vec3 nn = normal;
  nn.xz = rot * nn.xz;
  vegNormal = normalize(mix(nn, nao.xyz, 0.35));

  vec3 tint = vec3(sa.z, sa.w, sb.x);
  tint *= 0.84 + 0.34 * aRnd.w;
  tint *= mix(0.74, 1.08, nao.w);
  /* Same canopy-occlusion term the grass uses: understorey under a closed stand
     sees a fraction of the sky, and it is cool skylight when it does.
     PASS 11: was 0.36/0.37/0.31 at 0.88 — a 0.44x multiplier stacked on top of
     the cascade shadow the canopy already casts, which crushed every species
     distinction on the forest floor into one blue-black value. Relaxed to match
     Grass.js; the cool shift stays, the second exposure stop goes. */
  tint *= mix(vec3(1.0), vec3(0.64, 0.66, 0.55), clamp(ctrl.g, 0.0, 1.0) * 0.85);
  float g = vegGust(wxz + vec2(aRnd.y * 53.0));
  tint *= 1.0 + 0.10 * g;
  vBushTint = tint;
  vBushT = t;
  vVegWorld = vegPos;
}
`;

const BUSH_FRAG_PARS = /* glsl */`
varying vec3  vBushTint;
varying vec2  vBushUvOff;
varying float vBushDist;
varying vec3  vVegWorld;
varying float vBushT;
uniform vec3  uVegSun;
uniform vec3  uVegSunCol;
uniform vec3  uVegCam;
uniform vec2  uAlphaCut;
uniform float uFadeRef;
`;

/**
 * The atlas tile is picked per instance, so the sampling UV has to be offset
 * here rather than baked into the geometry — that is what keeps six species in
 * a single draw call.
 */
const BUSH_FRAG_BODY = /* glsl */`
  {
    vec2 uvT = vMapUv + vBushUvOff;
    vec4 s = texture2D(map, uvT);
    /* ONE cutoff at every distance. The atlas ships a coverage-matched mip
       chain, so a card thins into holes instead of either evaporating or going
       solid — pass 2 slid the cutoff 0.42 -> 0.16 with distance and got both
       failure modes at once.
       What DOES change with distance is which mip the test reads: because the
       chain is coverage-matched at this cutoff, thresholding a blurred tap keeps
       the same coverage while removing the one-pixel holes that flicker. */
    float far = clamp((vBushDist - 12.0) / uFadeRef, 0.0, 1.0);
    vec3 alb = s.rgb;
    if (far > 0.02) {
      vec4 soft = textureLod(map, uvT, 3.0);
      alb = mix(alb, soft.rgb, far * 0.60);
      s.a = mix(s.a, soft.a, far * 0.85);
    }
    if (s.a < uAlphaCut.x) discard;
    /* Ground contact: the bottom eighth of every card sinks toward the shaded
       soil colour, so a bush grows out of the dirt instead of being a decal
       standing on it. */
    alb *= mix(0.42, 1.0, smoothstep(0.0, 0.16, vBushT));
    diffuseColor = vec4(alb * vBushTint, 1.0);
  }
`;

const BUSH_LIGHTS = /* glsl */`
  {
    vec3 V = normalize(uVegCam - vVegWorld);
    float fwd = pow(clamp(dot(-V, uVegSun), 0.0, 1.0), 3.2);
    float wrap = clamp(dot(-normal, uVegSun) * 0.5 + 0.5, 0.0, 1.0);
    vec3 trans = uVegSunCol * (fwd * (0.28 + 0.72 * wrap) * (0.30 + 0.70 * vBushT) * 1.20);
    trans *= vec3(1.20, 1.08, 0.48);
    reflectedLight.directDiffuse += trans * diffuseColor.rgb;
  }
`;

const BUSH_NORMAL = /* glsl */`
  #ifndef FLAT_SHADED
    normal = normalize( vNormal );
    nonPerturbedNormal = normal;
  #endif
`;

/* ---------------------------------------------------------------- geometry */

/**
 * A cluster of foliage cards, unit height.
 *
 * Every card is ROOTED: its lower edge sits at (or just below) y = 0 and it
 * grows upward and outward. The first attempt centred cards on a hemisphere,
 * which produced clumps of leaves visibly hovering a foot off the ground — the
 * single most artificial thing in the frame.
 */
function buildBush(cardCount, seed) {
  const r = rng(seed);
  const pos = [], nrm = [], uvs = [], idx = [];
  const u0 = 0.004, u1 = 0.25 - 0.004;
  const v0 = 0.75 + 0.004, v1 = 1.0 - 0.004;
  let v = 0;
  for (let c = 0; c < cardCount; c++) {
    const a = (c / cardCount) * Math.PI * 2 + r() * 0.9;
    const rad = (0.04 + r() * 0.22) * (c === 0 ? 0.2 : 1);
    const cx = Math.cos(a) * rad;
    const cz = Math.sin(a) * rad;
    const h = 0.62 + r() * 0.42;
    const w = h * (0.72 + r() * 0.5);
    // lean outward as it rises
    const tilt = 0.22 + r() * 0.40;
    const nx = cx * 2.2, ny = 0.75, nz = cz * 2.2;
    const nl = Math.hypot(nx, ny, nz) || 1;
    const ca = Math.cos(a + Math.PI * 0.5), sa = Math.sin(a + Math.PI * 0.5);
    const ex = [ca * w, 0, sa * w];
    const ey = [Math.cos(a) * h * tilt, h, Math.sin(a) * h * tilt];
    const base = v;
    // Mirror half the cards in u — six atlas tiles have to dress the whole
    // understorey, and a flip is the cheapest way to stop them reading as six
    // repeated silhouettes.
    const uA = r() < 0.5 ? u1 : u0;
    const uB = uA === u0 ? u1 : u0;
    // sy 0 = rooted at ground, sy 1 = tip
    const corners = [[-0.5, 0, uA, v0], [0.5, 0, uB, v0], [0.5, 1, uB, v1], [-0.5, 1, uA, v1]];
    for (const [sx, sy, uu, vv] of corners) {
      pos.push(cx + ex[0] * sx + ey[0] * sy,
        -0.02 + ey[1] * sy,
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

const OFF = (tile) => new THREE.Vector2((tile % 4) / 4, -Math.floor(tile / 4) / 4);

/* ------------------------------------------------------------- tumbleweed */

/**
 * Tumbleweed. Same toroidal tiling, except the anchor is advected by the wind
 * before it is wrapped — so the whole population drifts downwind forever, at no
 * CPU cost, and rolls at exactly the rate its travel implies. It is a small
 * thing that does a lot of work: in an empty arid frame it is often the only
 * moving object, and motion is what stops a still frame reading as a diorama.
 */
const TUMBLE_VERT = /* glsl */`
${VEG_HASH}
${VEG_TERRAIN}
${VEG_WIND}

attribute vec2 aAnchor;
attribute vec4 aRnd;

uniform vec4  uRing;
uniform vec2  uTile;
uniform vec3  uVegCam;
uniform float uRadius;

varying vec3  vBushTint;
varying vec2  vBushUvOff;
varying float vBushDist;
varying vec3  vVegWorld;
varying float vBushT;

vec3 vegPos;
vec3 vegNormal;

void vegPlace() {
  float speed = 1.6 + uVegWind.z * 0.65 * (0.6 + 0.8 * aRnd.z);
  float travel = uVegTime * speed;
  vec2 anchor = aAnchor + uVegWind.xy * travel;

  vec2 d = anchor - uVegCam.xz;
  d -= uTile * floor(d / uTile + 0.5);
  vec2 wxz = uVegCam.xz + d;
  float dist = length(d);

  vegNormal = vec3(0.0, 1.0, 0.0);
  vBushTint = vec3(0.0);
  vBushUvOff = uTileOffsetTumble;
  vBushDist = dist;
  vBushT = 0.6;
  vVegWorld = vec3(wxz.x, 0.0, wxz.y);

  float band = smoothstep(uRing.x, uRing.y, dist) * (1.0 - smoothstep(uRing.z, uRing.w, dist));
  band *= vegClearing(wxz);   // keep the fire ring / camp floor bare
  if (band <= 0.004) { vegPos = vec3(0.0); return; }

  vec4 ctrl = vegCtrl(wxz);
  if (aRnd.x > ctrl.b * 0.9 + 0.10) { vegPos = vec3(0.0); return; }

  float h = vegHeight(wxz);
  if (h < uVegWorld.z + 0.4) { vegPos = vec3(0.0); return; }

  float rad = uRadius * mix(0.62, 1.35, aRnd.w);
  // roll about the axis perpendicular to travel, at the rate the ground implies
  float ang = travel / max(rad, 0.05) + aRnd.y * 6.2831853;
  vec2 axis = vec2(-uVegWind.y, uVegWind.x);
  vec3 p = position * rad;
  // Rodrigues rotation of p about the horizontal roll axis
  vec3 A = vec3(axis.x, 0.0, axis.y);
  float c = cos(ang), s = sin(ang);
  p = p * c + cross(A, p) * s + A * dot(A, p) * (1.0 - c);

  float bounce = abs(sin(travel * 0.9 + aRnd.z * 6.28)) * rad * 0.22;
  vegPos = vec3(wxz.x, h + rad * 0.92 + bounce, wxz.y) + p;

  vegNormal = normalize(normal * c + cross(A, normal) * s + A * dot(A, normal) * (1.0 - c));

  vec3 tint = vec3(1.18, 1.06, 0.80) * (0.82 + 0.34 * aRnd.w);
  vBushTint = tint;
  vVegWorld = vegPos;
}
`;

function buildTumbleweed(seed) {
  const r = rng(seed);
  const pos = [], nrm = [], uvs = [], idx = [];
  const u0 = 0.004, u1 = 0.25 - 0.004;
  const v0 = 0.75 + 0.004, v1 = 1.0 - 0.004;
  let v = 0;
  for (let c = 0; c < 5; c++) {
    const a = (c / 5) * Math.PI * 2 + r() * 0.5;
    const tilt = (r() - 0.5) * 1.1;
    const ca = Math.cos(a), sa = Math.sin(a);
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    const ex = [ca, 0, sa];
    const ey = [-sa * st, ct, ca * st];
    const base = v;
    const corners = [[-1, -1, u0, v0], [1, -1, u1, v0], [1, 1, u1, v1], [-1, 1, u0, v1]];
    for (const [sx, sy, uu, vv] of corners) {
      pos.push(ex[0] * sx + ey[0] * sy, ex[1] * sx + ey[1] * sy, ex[2] * sx + ey[2] * sy);
      const nx = ey[1] * ex[2] - ey[2] * ex[1];
      const ny = ey[2] * ex[0] - ey[0] * ex[2];
      const nz = ey[0] * ex[1] - ey[1] * ex[0];
      const nl = Math.hypot(nx, ny, nz) || 1;
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

export class Undergrowth {
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
    const D = Math.max(60, (q.grassDistance || 120) * 0.95);
    const budget = q.name === 'low' ? 0.4 : q.name === 'medium' ? 0.7 : 1.0;

    const col = (rr, gg, bb) => new THREE.Color(rr, gg, bb);
    /* scale(m), stiffness, tint — desaturated, yellow-shifted throughout */
    /* tints are MULTIPLIERS around 1.0 — the atlas already carries the palette */
    const species = [
      { tile: LEAF_TILES.sage, scale: 0.62, stiff: 0.42, tint: col(1.02, 1.06, 0.90), wide: 1.15 },
      { tile: LEAF_TILES.fern, scale: 0.50, stiff: 0.22, tint: col(0.92, 1.06, 0.76), wide: 1.05 },
      { tile: LEAF_TILES.deadBrush, scale: 0.72, stiff: 0.62, tint: col(1.14, 1.02, 0.76), wide: 1.25 },
      { tile: LEAF_TILES.rabbitbrush, scale: 0.68, stiff: 0.38, tint: col(1.16, 1.08, 0.78), wide: 1.10 },
      { tile: LEAF_TILES.juniper, scale: 1.05, stiff: 0.58, tint: col(0.88, 0.98, 0.78), wide: 1.30 },
      { tile: LEAF_TILES.dryGrass, scale: 0.44, stiff: 0.14, tint: col(1.20, 1.10, 0.82), wide: 1.00 },
    ];

    const tileOffsets = species.map((s) => OFF(s.tile));
    const spA = species.map((s) => new THREE.Vector4(s.scale, s.stiff, s.tint.r, s.tint.g));
    const spB = species.map((s) => new THREE.Vector2(s.tint.b, s.wide));

    const bands = [
      { i0: -3, i1: -1, o0: D * 0.30, o1: D * 0.42, cards: 7, d: 0.150, dens: 1.5 },
      { i0: D * 0.30, i1: D * 0.42, o0: D * 0.82, o1: D * 1.00, cards: 4, d: 0.034, dens: 1.4 },
    ];

    bands.forEach((b, bi) => {
      const T = b.o1 * 2;
      const count = Math.max(48, Math.round(T * T * b.d * budget));
      const anchors = new Float32Array(count * 2);
      const rnds = new Float32Array(count * 4);
      const M = Math.max(1, Math.ceil(Math.sqrt(count)));
      const r = rng((ctx.seed ^ 0x7feb352d) + bi * 92821);
      for (let i = 0; i < count; i++) {
        const gx = i % M, gy = (i / M) | 0;
        const px = ((gx + 0.5 + (r() - 0.5) * 1.8) / M) * T;
        const pz = ((gy + 0.5 + (r() - 0.5) * 1.8) / M) * T;
        anchors[i * 2] = ((px % T) + T) % T;
        anchors[i * 2 + 1] = ((pz % T) + T) % T;
        rnds[i * 4] = r(); rnds[i * 4 + 1] = r();
        rnds[i * 4 + 2] = r(); rnds[i * 4 + 3] = r();
      }

      const src = buildBush(b.cards, (ctx.seed ^ 0x846ca68b) + bi * 6151);
      const geo = makeInstanced(src, count);
      geo.setAttribute('aAnchor', new THREE.InstancedBufferAttribute(anchors, 2));
      geo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnds, 4));
      hugeSphere(geo);

      const mat = new THREE.MeshStandardMaterial({
        map: this.atlas,
        roughness: 0.88,
        metalness: 0,
        side: THREE.DoubleSide,
        alphaTest: 0,
      });
      mat.userData.rsVegKey = 'bush' + bi;

      injectVeg(mat, {
        vertexPars: BUSH_VERT,
        fragPars: BUSH_FRAG_PARS,
        fragBody: BUSH_FRAG_BODY,
        normalBody: BUSH_NORMAL,
        lightsBody: BUSH_LIGHTS,
        uniforms: Object.assign({}, this.shared, {
          uRing: { value: new THREE.Vector4(b.i0, b.i1, b.o0, b.o1) },
          uTile: { value: new THREE.Vector2(T, T) },
          uDensity: { value: b.dens },
          uTileOffset: { value: tileOffsets },
          uSpeciesA: { value: spA },
          uSpeciesB: { value: spB },
          uAlphaCut: { value: new THREE.Vector2(LEAF_CUTOFF, LEAF_CUTOFF) },
          uFadeRef: { value: Math.max(24, b.o1) },
        }),
        defines: this.defines,
      });
      if (sky) sky.injectAerialPerspective(mat);

      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.receiveShadow = true;
      mesh.castShadow = bi === 0;
      // Real per-instance radius, so the cascade LOD can drop the undergrowth from
      // the coarse cascades where a bush is smaller than a shadow texel.
      mesh.userData.shadowRadius = 0.55;
      mesh.name = 'undergrowth_' + bi;
      group.add(mesh);

      if (bi === 0) {
        const d = new THREE.MeshDepthMaterial({
          depthPacking: THREE.RGBADepthPacking,
          map: this.atlas,
          alphaTest: LEAF_CUTOFF,
          side: THREE.DoubleSide,
        });
        d.blending = THREE.NoBlending;
        d.fog = false;
        d.userData.rsVegKey = 'bushdepth';
        injectVeg(d, {
          vertexPars: BUSH_VERT,
          fragPars: 'varying vec2 vBushUvOff;',
          fragBody: '{ diffuseColor.a = texture2D(map, vMapUv + vBushUvOff).a; }',
          uniforms: Object.assign({}, this.shared, {
            uRing: { value: new THREE.Vector4(b.i0, b.i1, b.o0, b.o1) },
            uTile: { value: new THREE.Vector2(T, T) },
            uDensity: { value: b.dens },
            uTileOffset: { value: tileOffsets },
            uSpeciesA: { value: spA },
            uSpeciesB: { value: spB },
          }),
          defines: this.defines,
          depth: true,
        });
        mesh.customDepthMaterial = d;
        this.materials.push(d);
        const lighting = ctx.get('lighting');
        if (lighting) lighting.requestShadowCaster(mesh);
      }

      this.meshes.push(mesh);
      this.materials.push(mat);
      this.instances += count;
      this.triangles += count * b.cards * 2;
    });

    this._buildTumbleweed(group, tileOffsets, sky, budget);
    return this;
  }

  _buildTumbleweed(group, tileOffsets, sky, budget) {
    const ctx = this.ctx;
    const T = 340;
    const count = Math.max(12, Math.round(46 * budget));
    const r = rng((ctx.seed ^ 0x2c1b3c6d) >>> 0);
    const anchors = new Float32Array(count * 2);
    const rnds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      anchors[i * 2] = r() * T;
      anchors[i * 2 + 1] = r() * T;
      rnds[i * 4] = r(); rnds[i * 4 + 1] = r();
      rnds[i * 4 + 2] = r(); rnds[i * 4 + 3] = r();
    }
    const src = buildTumbleweed((ctx.seed ^ 0x51ed2701) >>> 0);
    const geo = makeInstanced(src, count);
    geo.setAttribute('aAnchor', new THREE.InstancedBufferAttribute(anchors, 2));
    geo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnds, 4));
    hugeSphere(geo);

    const mat = new THREE.MeshStandardMaterial({
      map: this.atlas, roughness: 0.92, metalness: 0,
      side: THREE.DoubleSide, alphaTest: 0,
    });
    mat.userData.rsVegKey = 'tumbleweed';
    injectVeg(mat, {
      vertexPars: 'uniform vec2 uTileOffsetTumble;\n' + TUMBLE_VERT,
      fragPars: BUSH_FRAG_PARS,
      fragBody: BUSH_FRAG_BODY,
      normalBody: BUSH_NORMAL,
      lightsBody: BUSH_LIGHTS,
      uniforms: Object.assign({}, this.shared, {
        uRing: { value: new THREE.Vector4(-3, -1, T * 0.40, T * 0.50) },
        uTile: { value: new THREE.Vector2(T, T) },
        uRadius: { value: 0.52 },
        uTileOffsetTumble: { value: tileOffsets[2].clone() },  // dead brush
        uAlphaCut: { value: new THREE.Vector2(LEAF_CUTOFF, LEAF_CUTOFF) },
        uFadeRef: { value: T * 0.5 },
      }),
      defines: this.defines,
    });
    if (sky) sky.injectAerialPerspective(mat);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = 'tumbleweed';
    group.add(mesh);
    this.meshes.push(mesh);
    this.materials.push(mat);
    this.instances += count;
  }

  dispose() {
    for (const m of this.meshes) {
      m.geometry.dispose();
      if (m.parent) m.parent.remove(m);
    }
    for (const m of this.materials) m.dispose();
  }
}
