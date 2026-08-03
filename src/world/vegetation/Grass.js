import * as THREE from 'three';
import { rng } from '../../core/Context.js';
import {
  VEG_HASH, VEG_TERRAIN, VEG_WIND, injectVeg, makeInstanced, hugeSphere,
} from './VegCommon.js';
import { GRASS_CUTOFF } from './VegTextures.js';

/**
 * GRASS
 * ============================================================================
 * Four concentric bands of instanced cross-quad tufts. Each band is one draw
 * call and its instance buffer is packed exactly once at boot; the field follows
 * the camera by *toroidal wrapping* in the vertex shader — an instance's anchor
 * is fixed modulo the band's tile size, so as the camera walks, blades that fall
 * off the back edge reappear on the front edge at a world position congruent to
 * where they started. Nothing is rebuilt, nothing is uploaded, and every blade
 * stays locked to the ground it is standing on.
 *
 * Placement is rejected per instance against the vegetation density map times
 * two octaves of metre-scale clump noise, so the field has thickets and bald
 * patches instead of a carpet. Bands overlap and ramp their scale through the
 * overlap, so a tuft shrinks to nothing exactly where the next band's tufts grow
 * in — no popping, and the outermost band dissolves into the terrain's own
 * painted grass.
 *
 * Wind is a travelling wave sampled at the world position (see VEG_WIND), so
 * gusts visibly cross the meadow. Backlit translucency is added after the direct
 * lighting so the field glows when the sun is low and behind it.
 */

const GRASS_VERT = /* glsl */`
${VEG_HASH}
${VEG_TERRAIN}
${VEG_WIND}

attribute vec2 aAnchor;
attribute vec4 aRnd;

uniform vec4  uRing;      // fade-in start/end, fade-out start/end (metres)
uniform vec2  uTile;      // wrap period
uniform vec4  uBlade;     // height, width, heightJitter, widthJitter
uniform float uDensity;   // global density multiplier
uniform float uWiden;     // how much a blade fattens across the band (anti-alias)
uniform vec3  uColSage;
uniform vec3  uColStraw;
uniform vec3  uColDark;
uniform vec3  uVegCam;
uniform vec3  uVegCamFwd;
/* per species: x heightMul, y widthMul, z stiffness, w tintMix (1 = keep the
   atlas colour, for the forbs and flowers whose hue is the point) */
uniform vec4  uSpecA[4];
/* per species: x strawBias, y valueMul, z bendLen, w translucency */
uniform vec4  uSpecB[4];

varying vec3  vVegTint;
varying float vVegT;
varying float vVegDist;
varying vec3  vVegWorld;
varying float vVegLit;
/* x = atlas column rotation, y = species row, z = sun-bleach at the tip,
   w = translucency scale (a fleshy forb transmits less than a dry culm) */
varying vec4  vVegVar;

vec3 vegPos;
vec3 vegNormal;

void vegPlace() {
  vec2 d = aAnchor - uVegCam.xz;
  d -= uTile * floor(d / uTile + 0.5);
  vec2 wxz = uVegCam.xz + d;
  float dist = length(d);

  vegNormal = vec3(0.0, 1.0, 0.0);
  vVegTint = vec3(0.0);
  vVegT = 0.0;
  vVegDist = dist;
  vVegWorld = vec3(wxz.x, 0.0, wxz.y);
  vVegLit = 1.0;
  vVegVar = vec4(0.0, 0.0, 0.0, 1.0);

  float band = smoothstep(uRing.x, uRing.y, dist) * (1.0 - smoothstep(uRing.z, uRing.w, dist));
  band *= vegClearing(wxz);   // keep the fire ring / camp floor bare
  if (band <= 0.004) { vegPos = vec3(0.0); return; }

  // behind-the-camera reject: cheap, and it halves rasterisation on the big bands
  if (dist > 5.0 && dot(vec3(d.x, 0.0, d.y) / dist, uVegCamFwd) < -0.42) {
    vegPos = vec3(0.0); return;
  }

  vec4 ctrl = vegCtrl(wxz);

  /* ---- density: thickets and genuinely BARE ground -----------------------
   * The old acceptance was 0.62 + 1.15 * clump^2, whose floor of 0.62 meant
   * even the emptiest cell still got two thirds of a full carpet. Uniform
   * density is the single loudest "procedural" tell in a wide shot. Three
   * octaves, thresholded so the low end reaches ZERO, give real bald patches
   * with soil showing through and let the surviving instances concentrate. */
  float c1 = vegNoise(wxz * 0.0155 + 21.0);
  float c2 = vegNoise(wxz * 0.0740 - 5.0);
  float c3 = vegNoise(wxz * 0.2950 + 63.0);
  float cover = c1 * 0.46 + c2 * 0.36 + c3 * 0.18;
  float clump = smoothstep(0.31, 0.60, cover);
  clump *= clump;
  /* A closed stand carries a thick low understorey — the reference forest floor
     is the DENSEST ground cover in any of its frames, not the sparsest — but
     the grass channel is deliberately shaded out under canopy in VegMaps. Take
     whichever of the two is the better statement about how much cover stands
     here, so the timber floor gets its litter layer back. */
  float support = max(ctrl.r, ctrl.g * 0.66);
  /* ...and the CLUMPING has to be relaxed there too. On open range the point of
     'clump' reaching zero is real bald ground, and that is a genuine win. Under
     closed timber it is a lie: the floor of a stand is continuous litter, moss,
     fern and dead-grass, and thresholding it the same way turned forest_interior
     into a dark mat with a few isolated tufts floating on it (measured: p1 luma
     0.015 -> 0.005, median 0.103 -> 0.076 against pass 9). A canopy floor term
     lifts the acceptance where the canopy is closed, and only there. */
  float canK = clamp(ctrl.g * 1.15, 0.0, 1.0);
  float accept = support * uDensity * (0.03 + 3.35 * clump + 1.05 * canK);
  if (aRnd.x > accept) { vegPos = vec3(0.0); return; }

  float h = vegHeight(wxz);
  if (h < uVegWorld.z + 0.22) { vegPos = vec3(0.0); return; }

  vec4 nao = vegNrmAO(wxz);
  if (nao.y < 0.50) { vegPos = vec3(0.0); return; }

  /* ---- which species stands here ----------------------------------------
   * Four weights derived from the ground itself — moisture (upstream flow),
   * canopy, shrubland, steepness, aspect, altitude — plus two macro-noise
   * fields so the MIX drifts across the landscape at 70 m and 20 m. A creek
   * bank and a dry ridge get different sward, and every clump in between is a
   * different draw from a slowly changing distribution. */
  float wet   = clamp(ctrl.a * 1.35, 0.0, 1.0);
  float can   = clamp(ctrl.g, 0.0, 1.0);
  float shrb  = clamp(ctrl.b, 0.0, 1.0);
  float steep = clamp((1.0 - nao.y) * 2.4, 0.0, 1.0);
  float north = clamp(-nao.z * 1.6 + 0.5, 0.0, 1.0);
  float alt   = smoothstep(150.0, 340.0, h);
  float m1 = vegNoise(wxz * 0.0142 + 3.7);
  float m2 = vegNoise(wxz * 0.0480 - 12.3);

  float wTall  = (0.30 + 1.15 * m1) * (0.40 + 1.00 * wet) * (1.0 - 0.50 * steep)
               * (0.45 + 0.90 * ctrl.r);
  float wTurf  = (0.16 + 0.60 * north) * (0.22 + 1.60 * wet) + can * 0.95;
  float wStraw = (0.26 + 1.30 * (1.0 - m1)) * (1.20 - 0.95 * wet)
               * (0.50 + 0.90 * shrb) * (0.55 + 0.85 * steep) + 0.45 * alt;
  float wForb  = (0.10 + 1.15 * smoothstep(0.50, 0.84, m2))
               * (0.45 + 0.90 * wet + 0.85 * can);
  float tot = wTall + wTurf + wStraw + wForb;
  float pick = aRnd.z * max(tot, 1e-4);
  float spec = 0.0;
  if (pick > wTall) spec = 1.0;
  if (pick > wTall + wTurf) spec = 2.0;
  if (pick > wTall + wTurf + wStraw) spec = 3.0;
  int si = int(spec);
  vec4 sa = uSpecA[si];
  vec4 sb = uSpecB[si];

  /* Two more decorrelated randoms from the anchor: the four attribute randoms
     are all spoken for once species selection takes one of them. */
  vec2 hx = vegHash22(aAnchor * 0.7317 + 5.17);
  float hz = vegHash12(aAnchor * 1.9130 + 41.7);

  /* Rotate which COLUMN of the atlas each instance reads. The tuft mesh bakes a
     different column per card, so without this every instance in a band is the
     same three silhouettes in the same arrangement — the "regular grid of
     identical cards" tell. Rotation stays inside the species' own row.
     ONE exception, and it is the whole flower story: column 3 of the forb row
     is the only tile in the sheet that carries blooms. Rotation alone cannot
     gate it — whatever the offset, a quarter of the cards land on column 3 —
     so what varies is the MODULUS: outside a bloom patch the rotation wraps at
     3 and column 3 is unreachable. Inside one (a tight noise field biased
     toward damp, open ground) it wraps at 4 and the flowers appear. The accents
     end up as drifts a few metres across, which is how the reference uses them,
     instead of one flower on every clump in the county.
     Packed as rot + 10 * modulus to stay inside one varying. */
  float mcols = 4.0;
  if (si == 3) {
    float bloom = smoothstep(0.58, 0.80, vegNoise(wxz * 0.052 + 71.0))
                * (0.40 + 0.80 * wet) * (1.0 - 0.60 * can);
    mcols = hz < bloom ? 4.0 : 3.0;
  }
  vVegVar = vec4(floor(hx.x * 3.999) + 10.0 * mcols, spec,
                 clamp(0.30 + sb.x * 0.85 + hx.x * 0.38, 0.0, 1.15), sb.w);

  float hgt = uBlade.x * sa.x * mix(1.0 - uBlade.z, 1.0 + uBlade.z, hx.y)
            * (0.60 + 0.70 * clump) * band;
  float wid = uBlade.y * sa.y * mix(1.0 - uBlade.w, 1.0 + uBlade.w, aRnd.w) * band;
  /* ANTI-ALIASING, not styling. A 4 cm card at the back of a band is a
     sub-pixel sliver that flickers as it sways; fattening it across the band
     keeps it above a pixel so the far field resolves as a soft mass. */
  wid *= 1.0 + uWiden * clamp((dist - uRing.x - 4.0) / max(uRing.w - uRing.x, 8.0), 0.0, 1.0);

  vec3 p = position;
  p.xz *= wid;
  p.y *= hgt;

  float yaw = aRnd.y * 6.2831853;
  mat2 rot = vegRot(yaw);
  p.xz = rot * p.xz;

  // lean: partly downslope, partly a per-instance whim, so the field is never
  // vertically uniform
  float la = aRnd.x * 6.2831853;
  vec2 shear = nao.xz * 0.62 + vec2(cos(la), sin(la)) * (0.10 + 0.26 * aRnd.w);
  float t = position.y;
  p.xz += shear * p.y;

  /* Species-specific wind. Sage barely moves (stiffness 0.70), tall bunchgrass
     whips (0.02) and travels further per metre of stalk, fine turf shivers.
     Flutter is damped out past ~26 m — see vegBend. */
  float flut = 1.0 - smoothstep(9.0, 26.0, dist);
  p += vegBend(wxz, t, sa.z, aRnd.y, hgt * sb.z, flut);

  vegPos = vec3(wxz.x, h, wxz.y) + p;

  vec3 nn = normal;
  nn.xz = rot * nn.xz;
  vegNormal = normalize(mix(nn, nao.xyz, 0.62));

  /* ---- colour ------------------------------------------------------------
   * These are MULTIPLIERS around 1.0, not absolute colours. The atlas already
   * carries the sage/straw palette; tinting it with an absolute mid-tone
   * multiplies two ~0.15 linear values together and turns the whole field
   * near-black, which is exactly what the first pass did. */
  float dry = vegNoise(wxz * 0.0135 + 4.0) * 1.05 + 0.30
            - ctrl.a * 0.85 - ctrl.r * 0.34 + hx.y * 0.42 + sb.x;
  dry = clamp(dry, 0.0, 1.0);
  vec3 col = mix(uColSage, uColStraw, dry);
  col = mix(col, uColDark, clamp(0.34 - clump * 0.34, 0.0, 1.0));
  col *= 0.78 + 0.48 * aRnd.w;
  col *= sb.y;
  /* Forbs and flowering herbs keep their own hue: the accent colours are the
     entire reason those tiles exist and a sage/straw multiplier would erase
     them. Applied before the occlusion terms, which still have to apply. */
  col = mix(col, vec3(1.0), sa.w);
  col *= mix(0.72, 1.10, nao.w);                       // terrain sky occlusion
  /* Canopy occlusion. The forest-density channel is the only cheap statement
     this shader can make about how much sky a blade can actually see, and a
     forest floor lit like an open meadow is what made forest_interior read as
     "uniformly lit flat lavender-grey". Cool-shifted, because what does reach
     the floor is skylight and leaf-filtered green.

     PASS 11: this was mix(..., vec3(0.46,0.47,0.40), canopy*0.88) — a 0.52x
     multiplier on top of a floor that is ALREADY in cascade shadow. Two
     occlusion terms stacked is how the tufts stopped being readable as
     individual plants and became a blue-dark mush. The shading is real; it just
     has to be an amount, not a second exposure stop. Keep the cool shift (what
     reaches the floor genuinely is skylight and leaf-filtered green), halve the
     darkening. */
  float canopy = clamp(ctrl.g, 0.0, 1.0);
  col *= mix(vec3(1.0), vec3(0.70, 0.72, 0.62), canopy * 0.85);
  // gust sheen — the underside of a wave of grass flashes paler
  float g = vegGust(wxz + vec2(aRnd.y * 37.0, aRnd.y * 91.0));
  col *= 1.0 + 0.16 * g;

  vVegTint = col;
  vVegT = t;
  vVegWorld = vegPos;
  vVegLit = mix(0.40, 1.06, t * t * 0.6 + t * 0.4);    // self-shadow inside the tuft
}
`;

const GRASS_FRAG_PARS = /* glsl */`
varying vec3  vVegTint;
varying float vVegT;
varying float vVegDist;
varying vec3  vVegWorld;
varying float vVegLit;
varying vec4  vVegVar;
uniform vec3  uVegSun;
uniform vec3  uVegSunCol;
uniform vec3  uVegCam;
uniform float uAlphaNear;
uniform float uFadeRef;
uniform vec3  uSoilTint;
uniform vec3  uBleach;

/* Atlas addressing: COLUMN = variant (rotated per instance), ROW = species.
   var4.x packs rot + 10 * modulus — the modulus is what fences the flowering
   column off outside a bloom patch. */
vec2 grassUv(vec2 uv, vec4 var4) {
  float mc = floor(var4.x * 0.1 + 0.5);
  float rot = var4.x - mc * 10.0;
  float q = floor(uv.x * 4.0);
  uv.x = (mod(q + rot, mc) + fract(uv.x * 4.0)) * 0.25;
  uv.y = (var4.y + clamp(uv.y, 0.0025, 0.9975)) * 0.25;
  return uv;
}
`;

const GRASS_FRAG_MAP = /* glsl */`
  {
    vec2 gUv = grassUv(vMapUv, vVegVar);
    vec4 gTex = texture2D(map, gUv);
    /* Anti-shimmer. motion.py measured 16% of pixels boiling under a frozen
       camera. A sub-pixel blade is not a silhouette anyone can resolve, so past
       ~8 m BOTH the albedo and the ALPHA roll toward a deliberately over-blurred
       tap. Because the mip chain is coverage-matched at this exact cutoff
       (VegTextures), thresholding the blurred alpha keeps the same amount of
       grass on screen — it just stops being a lace of one-pixel holes that
       flicker in and out as the field sways, and reads as a soft mass instead. */
    float far = clamp((vVegDist - 8.0) / uFadeRef, 0.0, 1.0);
    if (far > 0.02) {
      vec4 soft = textureLod(map, gUv, 3.0);
      gTex.rgb = mix(gTex.rgb, soft.rgb, far * 0.72);
      gTex.a = mix(gTex.a, soft.a, far * 0.88);
    }
    diffuseColor = gTex * vec4(diffuse, opacity);
    /* One constant cutoff: the atlas mip chain is coverage-matched, so a tuft
       thins by losing blades instead of dissolving into dither. */
    if (diffuseColor.a < uAlphaNear) discard;
    /* Contact: the bottom of every blade sinks toward the shaded soil, so the
       field grows out of the ground instead of being spikes pushed into it. */
    vec3 base = diffuseColor.rgb * uSoilTint;
    diffuseColor.rgb = mix(base, diffuseColor.rgb, smoothstep(0.0, 0.22, vVegT));
    /* Sun-bleached tips over a greener base. Real range grass is a vertical
       gradient — the top third has been in the sun all summer and the crown has
       not — and a single flat tint per clump is what made ours read as a
       stamped card. */
    diffuseColor.rgb *= mix(vec3(1.0), uBleach, vVegT * vVegT * vVegVar.z);
    diffuseColor.rgb *= vVegTint * vVegLit;
    diffuseColor.a = 1.0;
  }
`;

const GRASS_FRAG_LIGHTS = /* glsl */`
  {
    vec3 V = normalize(uVegCam - vVegWorld);
    float fwd = pow(clamp(dot(-V, uVegSun), 0.0, 1.0), 2.8);
    float wrap = clamp(dot(-normal, uVegSun) * 0.5 + 0.5, 0.0, 1.0);
    float thin = 0.24 + 0.76 * vVegT;
    /* Backlit translucency — the signature of the reference golden-hour frames.
       Scaled per species: a dry culm is a lit filament, a fleshy forb leaf much
       less so. */
    vec3 trans = uVegSunCol * (fwd * wrap * thin * 1.95 * vVegVar.w)
               * vec3(1.24, 1.08, 0.42);
    reflectedLight.directDiffuse += trans * diffuseColor.rgb;
  }
`;

/**
 * Grass cards are DoubleSide, and three flips the interpolated normal on back
 * faces — which would make half of every tuft shade as if it faced away from the
 * sky and go black. The authored normal already points up-and-outward for both
 * faces on purpose, so undo the flip.
 */
const GRASS_NORMAL = /* glsl */`
  #ifndef FLAT_SHADED
    normal = normalize( vNormal );
    nonPerturbedNormal = normal;
  #endif
`;

/* ------------------------------------------------------------- geometry */

function buildTuft(cards, segs, seed) {
  const r = rng(seed);
  const pos = [];
  const nrm = [];
  const uvs = [];
  const idx = [];
  let v = 0;
  for (let c = 0; c < cards; c++) {
    const a = (c / cards) * Math.PI + r() * 0.32;
    const ca = Math.cos(a), sa = Math.sin(a);
    const variant = (r() * 4) | 0;
    const u0 = variant / 4, u1 = (variant + 1) / 4;
    const curve = (r() - 0.5) * 0.30;
    const lean = 0.10 + r() * 0.22;
    const start = v;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const w = 0.5 * (1.0 - t * t * 0.32);
      const bendX = curve * t * t;
      const bendZ = lean * t * t;
      for (let side = 0; side < 2; side++) {
        const lx = (side === 0 ? -w : w) + bendX;
        const lz = bendZ;
        pos.push(lx * ca - lz * sa, t, lx * sa + lz * ca);
        // normal: mostly up with a flare so a tuft shades like a soft dome
        const nx = (side === 0 ? -0.42 : 0.42);
        const ny = 1.0;
        const nz = -0.35;
        const l = Math.hypot(nx, ny, nz);
        nrm.push((nx * ca - nz * sa) / l, ny / l, (nx * sa + nz * ca) / l);
        uvs.push(side === 0 ? u0 : u1, t);
      }
      v += 2;
    }
    for (let s = 0; s < segs; s++) {
      const a0 = start + s * 2;
      idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/* ------------------------------------------------------------------ class */

export class GrassField {
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
    /*
     * Ultra asks for 190 m at 1.5x density. Grass is alpha-tested DoubleSide
     * cards, i.e. pure overdraw on top of an already expensive ground shader,
     * and the outer third of that ring is sub-pixel blades that TAA dissolves
     * into the terrain anyway. Capping the ring at 155 m and the density at
     * 1.15 is a measurable fill saving that no still frame shows.
     */
    const D = Math.min(q.grassDistance || 120, 155);
    const dens = Math.min(q.grassDensity || 1, 1.15);
    const budget = q.name === 'low' ? 0.42 : q.name === 'medium' ? 0.72 : 1.0;

    /* Blade sizes are set against a 1.8 m figure: the near band tops out around
       35 cm, i.e. below the ankle, which is what pass 2 got wrong (the lens
       report measured the cards at 2-3x, "which makes the man read as a doll").
       Card WIDTH grows steeply with distance instead — a 4 cm blade two hundred
       metres out is a sub-pixel sliver and aliases violently, so the far bands
       trade blade count for blade width and the field reads as a soft mass. */
    /* Instance densities are DOWN ~18% from pass 9 and the acceptance function
       now reaches zero (see vegPlace), so the same visual thickness is packed
       into fewer, larger thickets with real bare ground between them. That is
       what pays for four species costing nothing. `widen` fattens a card across
       its band so the far end never draws sub-pixel slivers. */
    const bands = [
      { i0: -3, i1: -1, o0: D * 0.128, o1: D * 0.190, cards: 3, segs: 2, d: 4.90, h: 0.34, w: 0.36, hj: 0.56, wj: 0.32, widen: 0.30 },
      { i0: D * 0.128, i1: D * 0.190, o0: D * 0.340, o1: D * 0.430, cards: 2, segs: 2, d: 0.98, h: 0.44, w: 0.56, hj: 0.50, wj: 0.30, widen: 0.42 },
      { i0: D * 0.340, i1: D * 0.430, o0: D * 0.660, o1: D * 0.790, cards: 2, segs: 1, d: 0.41, h: 0.60, w: 0.94, hj: 0.38, wj: 0.28, widen: 0.55 },
      { i0: D * 0.660, i1: D * 0.790, o0: D * 0.940, o1: D * 1.000, cards: 1, segs: 1, d: 0.135, h: 0.82, w: 1.62, hj: 0.32, wj: 0.24, widen: 0.70 },
    ];

    /* multipliers, not colours — see the shader comment */
    const sage = new THREE.Vector3(0.90, 1.02, 0.74);
    const straw = new THREE.Vector3(1.34, 1.16, 0.72);
    const dark = new THREE.Vector3(0.62, 0.68, 0.50);

    /*
     * THE FOUR SPECIES. Row order matches buildGrassAtlas.
     *   A = height x, width x, wind stiffness, keep-atlas-hue
     *   B = straw bias, value, bend length scale, translucency
     *
     * Heights are quoted against a 1.8 m figure: tall bunchgrass tops out near
     * mid-shin in the near band, turf is ankle-deep, and the forbs sit lower
     * than either. Stiffness is what makes them read as different plants in
     * motion — sage barely registers a gust the bunchgrass whips in.
     */
    const specA = [
      new THREE.Vector4(1.42, 0.94, 0.02, 0.00),   // 0 tall bunch grass
      new THREE.Vector4(0.66, 0.88, 0.32, 0.00),   // 1 fine turf
      new THREE.Vector4(1.08, 0.86, 0.16, 0.16),   // 2 dry straw
      new THREE.Vector4(0.78, 0.96, 0.70, 0.66),   // 3 forb / sage / flowers
    ];
    const specB = [
      new THREE.Vector4(0.06, 1.00, 1.20, 1.10),
      new THREE.Vector4(-0.30, 0.90, 0.55, 0.80),
      new THREE.Vector4(0.46, 1.14, 0.95, 1.45),
      new THREE.Vector4(-0.16, 0.96, 0.40, 0.55),
    ];

    bands.forEach((b, bi) => {
      const T = b.o1 * 2;
      const count = Math.max(64, Math.round(T * T * b.d * dens * budget));

      const anchors = new Float32Array(count * 2);
      const rnds = new Float32Array(count * 4);
      const M = Math.max(1, Math.ceil(Math.sqrt(count)));
      const r = rng((ctx.seed ^ 0x9e3779b9) + bi * 104729);
      for (let i = 0; i < count; i++) {
        const gx = i % M, gy = (i / M) | 0;
        // 1.7x jitter: neighbouring cells overlap, so the lattice is invisible
        const px = ((gx + 0.5 + (r() - 0.5) * 1.7) / M) * T;
        const pz = ((gy + 0.5 + (r() - 0.5) * 1.7) / M) * T;
        anchors[i * 2] = ((px % T) + T) % T;
        anchors[i * 2 + 1] = ((pz % T) + T) % T;
        rnds[i * 4] = r();
        rnds[i * 4 + 1] = r();
        rnds[i * 4 + 2] = r();
        rnds[i * 4 + 3] = r();
      }

      const src = buildTuft(b.cards, b.segs, (ctx.seed ^ 0x2545f491) + bi * 7919);
      const geo = makeInstanced(src, count);
      geo.setAttribute('aAnchor', new THREE.InstancedBufferAttribute(anchors, 2));
      geo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnds, 4));
      hugeSphere(geo);

      const uniforms = Object.assign({}, this.shared, {
        uRing: { value: new THREE.Vector4(b.i0, b.i1, b.o0, b.o1) },
        uTile: { value: new THREE.Vector2(T, T) },
        uBlade: { value: new THREE.Vector4(b.h, b.w, b.hj, b.wj) },
        uDensity: { value: 1.70 },
        uWiden: { value: b.widen },
        uColSage: { value: sage.clone() },
        uColStraw: { value: straw.clone() },
        uColDark: { value: dark.clone() },
        uSpecA: { value: specA.map((v) => v.clone()) },
        uSpecB: { value: specB.map((v) => v.clone()) },
        uAlphaNear: { value: GRASS_CUTOFF },
        uSoilTint: { value: new THREE.Vector3(0.44, 0.42, 0.36) },
        uBleach: { value: new THREE.Vector3(1.20, 1.10, 0.82) },
        uFadeRef: { value: Math.max(20, b.o1) },
      });

      const mat = new THREE.MeshStandardMaterial({
        map: this.atlas,
        roughness: 0.94,
        metalness: 0.0,
        side: THREE.DoubleSide,
        alphaTest: 0,
        transparent: false,
        dithering: true,
      });
      mat.userData.rsVegKey = 'grass' + bi;

      injectVeg(mat, {
        vertexPars: GRASS_VERT,
        fragPars: GRASS_FRAG_PARS,
        fragBody: GRASS_FRAG_MAP,
        normalBody: GRASS_NORMAL,
        lightsBody: GRASS_FRAG_LIGHTS,
        uniforms,
        defines: this.defines,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 1;
      mesh.name = 'grass_band_' + bi;
      group.add(mesh);

      /* ------------------------------------------------------- self-shadow
       * Three separate forensic reports flagged that the grass does not shadow
       * itself or the ground, and the reason was mechanical: the placement is
       * done entirely in the vertex shader, so three's stock depth material
       * draws every blade at the origin and the cascade sees nothing. A depth
       * material carrying the SAME vegPlace() and the SAME per-instance atlas
       * rotation fixes it, and Lighting enrols it automatically.
       *
       * Only the near band casts. Band 1 starts at 15 m, where a blade is
       * already under a shadow texel wide in the cascades that reach it, and
       * all it contributes is aliasing and fill cost. */
      if (bi === 0) {
        const dmat = new THREE.MeshDepthMaterial({
          depthPacking: THREE.RGBADepthPacking,
          map: this.atlas,
          alphaTest: GRASS_CUTOFF,
          side: THREE.DoubleSide,
        });
        dmat.blending = THREE.NoBlending;
        dmat.fog = false;
        dmat.userData.rsVegKey = 'grassdepth' + bi;
        injectVeg(dmat, {
          vertexPars: GRASS_VERT,
          fragPars: 'varying vec4 vVegVar;',
          fragBody: `
  {
    float mc = floor(vVegVar.x * 0.1 + 0.5);
    float rot = vVegVar.x - mc * 10.0;
    vec2 gUv = vMapUv;
    float q = floor(gUv.x * 4.0);
    gUv.x = (mod(q + rot, mc) + fract(gUv.x * 4.0)) * 0.25;
    gUv.y = (vVegVar.y + clamp(gUv.y, 0.0025, 0.9975)) * 0.25;
    diffuseColor.a = texture2D(map, gUv).a;
  }`,
          uniforms,
          defines: this.defines,
          depth: true,
        });
        mesh.customDepthMaterial = dmat;
        mesh.castShadow = true;
        /* a tuft is ~0.4 m across: this lets the cascade LOD drop the whole
           band from the coarse cascades instead of paying for sub-texel work */
        mesh.userData.shadowRadius = 0.34;
        this.materials.push(dmat);
        const lighting = ctx.get('lighting');
        if (lighting && lighting.requestShadowCaster) lighting.requestShadowCaster(mesh);
      }

      this.meshes.push(mesh);
      this.materials.push(mat);
      this.instances += count;
      this.triangles += count * b.cards * b.segs * 2;
    });

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
