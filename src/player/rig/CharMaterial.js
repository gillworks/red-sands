import * as THREE from 'three';

/**
 * RED SANDS — CHARACTER MATERIAL
 * ============================================================================
 * One MeshStandardMaterial pair (solid + cloth) covers a whole character.
 * Per-vertex `color` carries the albedo and `aMat` carries (roughness, sheen),
 * so hat felt, oiled leather, wool and skin all live in a single draw call.
 *
 * On top of that the shader adds the multi-scale surface honesty §5 asks for:
 *   - metre scale : sun-bleaching on up-facing cloth, grime in the down-facing
 *                   creases (world-normal driven)
 *   - decimetre   : object-space value noise breaking up albedo + roughness
 *   - millimetre  : a fine weave/grain modulation that survives at 400 px tall
 *   - cloth sheen : view-grazing skylight pickup on wool and felt
 * All in linear HDR. Aerial perspective is injected on top by Sky.
 * ============================================================================
 */

const NOISE = /* glsl */`
float rsHash13(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}
float rsVNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = rsHash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = rsHash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = rsHash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = rsHash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = rsHash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = rsHash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = rsHash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = rsHash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float rsFbm(vec3 p) {
  return rsVNoise(p) * 0.55 + rsVNoise(p * 2.13) * 0.28 + rsVNoise(p * 4.31) * 0.17;
}
`;

/**
 * @param {object} opts { doubleSide, dust }  dust 0..1 = how filthy
 * @returns {THREE.MeshStandardMaterial}
 */
export function makeCharMaterial(opts = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.0,
    side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    shadowSide: THREE.FrontSide,
    dithering: true,
  });
  m.name = opts.name || 'character';

  if (opts.alphaMap) {
    m.alphaMap = opts.alphaMap;
    m.alphaTest = opts.alphaTest != null ? opts.alphaTest : 0.45;
    m.transparent = false;
  }

  const uniforms = {
    uCharDust: { value: opts.dust != null ? opts.dust : 0.35 },
    uCharWet: { value: 0.0 },
    uCharDetail: { value: opts.detail != null ? opts.detail : 1.0 },
    uCharSweat: { value: 0.0 },
    uCharAO: { value: opts.ao != null ? opts.ao : 1.0 },
  };
  m.userData.rsCharUniforms = uniforms;

  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
#include <common>
attribute vec4 aMat;
varying vec4 vCharMat;
varying vec3 vCharObj;
varying vec3 vCharWNrm;
`)
      .replace('#include <begin_vertex>', /* glsl */`
#include <begin_vertex>
vCharMat = aMat;
vCharObj = position;
`)
      .replace('#include <worldpos_vertex>', /* glsl */`
#include <worldpos_vertex>
vCharWNrm = normalize(mat3(modelMatrix) * objectNormal);
`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
#include <common>
${NOISE}
uniform float uCharDust;
uniform float uCharWet;
uniform float uCharDetail;
uniform float uCharSweat;
uniform float uCharAO;
varying vec4 vCharMat;
varying vec3 vCharObj;
varying vec3 vCharWNrm;
`)
      .replace('#include <color_fragment>', /* glsl */`
#include <color_fragment>
// Sampled once and reused by the roughness and bump blocks further down —
// three separate fBm evaluations per pixel is a luxury a forward renderer
// cannot afford even on two meshes.
// BAND LIMITING. Every octave is faded out before its period reaches two
// pixels. Without this the figure crawls with moire and, worse, the bump
// gradient goes unbounded and shot-noises the whole silhouette into camo.
float rsFoot = max(1e-5, max(max(fwidth(vCharObj.x), fwidth(vCharObj.y)), fwidth(vCharObj.z)));
#define RS_BAND(F) (1.0 - smoothstep(0.30, 0.62, (F) * rsFoot))

// --- surface class masks -------------------------------------------------
// The old shader ran ONE detail model over hide, wool, felt and oiled leather
// alike, at an 18 cm blob scale — which is why the duster read as a smeared
// stain and the horse read as painted plastic. Each class now gets the
// frequency band its real material actually lives in.
float rsCls    = vCharMat.w;
float mCloth   = step(0.5, rsCls) * step(rsCls, 1.5);   // wool / canvas / felt
float mHair    = step(1.5, rsCls) * step(rsCls, 2.5);   // short animal coat
float mStrand  = step(2.5, rsCls);                      // mane / tail cards
float mHard    = 1.0 - mCloth - mHair - mStrand;        // leather / skin / steel
float rsAO     = mix(1.0, clamp(vCharMat.z, 0.0, 1.0), uCharAO);

float rsMid   = rsFbm(vCharObj * 13.0);                         // ~8 cm drift
float rsFine  = mix(0.5, rsVNoise(vCharObj * vec3(210.0, 190.0, 210.0)), RS_BAND(210.0));
// hide grain runs fore-and-aft along the body, so the noise is stretched in z
vec3  rsHairP = vCharObj * vec3(300.0, 280.0, 58.0);
float rsHairN = mix(0.5, rsVNoise(rsHairP), RS_BAND(300.0));
// dappling / roaning — the 15 cm value blotching that makes a coat read as
// an animal rather than a painted cylinder
float rsDap   = rsFbm(vCharObj * vec3(7.8, 7.8, 5.4));
// woven twill: two crossed high-frequency bands, not isotropic hash
float rsWv    = mix(0.5, 0.5 + 0.25 * (sin(dot(vCharObj, vec3(430.0, 470.0, 90.0)))
                                     + sin(dot(vCharObj, vec3(-455.0, 440.0, 110.0)))), RS_BAND(470.0));
float rsUp    = clamp(vCharWNrm.y, -1.0, 1.0);

// sweat: darkens and slicks the neck and the flank behind the girth
float rsSweat = mHair * uCharSweat * (0.55 + 0.90 * rsMid) * clamp(
    smoothstep(0.42, 1.05, vCharObj.z)
  + smoothstep(0.25, -0.15, vCharObj.z) * smoothstep(1.50, 1.16, vCharObj.y) * 0.8, 0.0, 1.0);
{
  // Sun-bleaching on up-facing planes, grime pooled in the down-facing folds.
  // Bleaching lightens the cloth's OWN colour — mixing toward an absolute pale
  // tint blows the albedo out of range and the whole figure turns to chalk.
  float bleach = smoothstep(0.15, 0.95, rsUp) * (0.18 + 0.30 * uCharDust) * (1.0 - mHair * 0.55);
  float grime  = smoothstep(0.1, -0.85, rsUp) * (0.20 * uCharDust + 0.06);

  vec3 dustTint = vec3(0.055, 0.046, 0.032);
  float d = uCharDetail;
  float k = 1.0;
  k *= 1.0 + (rsMid  - 0.5) * (0.20 * mHard + 0.15 * mCloth + 0.09 * mHair) * d;
  k *= 1.0 + (rsWv   - 0.5) * 0.18 * mCloth * d;
  k *= 1.0 + (rsFine - 0.5) * (0.13 * mCloth + 0.10 * mHard) * d;
  k *= 1.0 + (rsDap  - 0.5) * 0.26 * mHair * d;
  k *= 1.0 + (rsHairN - 0.5) * 0.13 * (mHair + mStrand) * d;
  diffuseColor.rgb *= k;
  // Cavity darkening. AO belongs on the indirect term, but a little of it in
  // the albedo is what stops a seam vanishing the moment full sun hits it.
  diffuseColor.rgb *= mix(1.0, rsAO, 0.18);
  diffuseColor.rgb *= (1.0 - grime);
  vec3 sunned = diffuseColor.rgb * (1.16 + 0.22 * rsMid) + dustTint * (0.55 + 0.45 * rsMid);
  diffuseColor.rgb = mix(diffuseColor.rgb, sunned, bleach);
  diffuseColor.rgb *= (1.0 - 0.40 * rsSweat);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.62, uCharWet * 0.7);
}
`)
      .replace('#include <normal_fragment_maps>', /* glsl */`
#include <normal_fragment_maps>
{
  // Procedural micro-relief. Felt, wool and canvas live or die on this: without
  // a perturbed normal the figure is a plastic maquette however good the albedo
  // is. Screen-space derivative bump (Mikkelsen) so one height sample is enough
  // instead of a four-tap gradient.
  // h is a REAL height in metres in the same space as the surface position,
  // which is what makes the Mikkelsen construction below scale-correct: 1.0 mm
  // of relief on leather, 2.6 mm on wool nap.
  float amp = (0.0008 + 0.0020 * mCloth + 0.0006 * mHard - 0.0004 * mHair) * uCharDetail;
  // hide relief is fine and directional; cloth relief is a coarse nap
  vec3 hp = mix(vCharObj, vCharObj * vec3(1.0, 1.0, 0.30), mHair);
  float h = (rsVNoise(hp * 34.0) * 0.62 * RS_BAND(34.0)
           + rsVNoise(hp * 155.0) * 0.38 * RS_BAND(155.0)) * amp;
  vec3 sp = -vViewPosition;
  vec3 dpx = dFdx(sp), dpy = dFdy(sp);
  float dhx = dFdx(h), dhy = dFdy(h);
  vec3 r1 = cross(dpy, normal);
  vec3 r2 = cross(normal, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  normal = normalize(abs(det) * normal - grad);
}
`)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
#include <roughnessmap_fragment>
{
  roughnessFactor = vCharMat.x;
  roughnessFactor *= (1.0 + (rsMid - 0.5) * 0.22 * uCharDetail);
  roughnessFactor += (rsFine - 0.5) * 0.11 * uCharDetail * (mCloth + mHard);
  // Short hair lies in streaks. Streaking the ROUGHNESS along the lay of the
  // coat is what produces the soft directional sheen down a horse's barrel —
  // a cheap stand-in for a real anisotropic BRDF, and it costs one sample.
  roughnessFactor += (rsHairN - 0.5) * 0.30 * (mHair + mStrand) * uCharDetail;
  // worn edges: up-facing leather polishes, folds stay matte
  roughnessFactor -= smoothstep(0.4, 1.0, rsUp) * 0.06 * mHard;
  roughnessFactor -= rsSweat * 0.32;
  roughnessFactor = clamp(mix(roughnessFactor, 0.16, uCharWet), 0.05, 1.0);
}
`)
      .replace('#include <lights_fragment_end>', /* glsl */`
#include <lights_fragment_end>
{
  float ndv  = saturate(dot(normalize(vNormal), normalize(vViewPosition)));
  float fres = pow(1.0 - ndv, 4.0);
  // Baked occlusion. This is the term doing the anatomy: the seam where the
  // foreleg meets the barrel, under the belly, behind the elbow, the gutter
  // beside the spine, every coat fold. Without it the figure is one flat mass
  // however good the albedo is.
  reflectedLight.indirectDiffuse  *= rsAO;
  reflectedLight.indirectSpecular *= mix(1.0, rsAO, 0.75);
  reflectedLight.directDiffuse    *= mix(1.0, rsAO, 0.20);
  // Cloth sheen: wool and felt pick the sky up at grazing angles. Cheap
  // Fresnel lift of the irradiance term only — keeps energy sane.
  reflectedLight.indirectDiffuse *= (1.0 + fres * vCharMat.y * 0.50);
  reflectedLight.directDiffuse   *= (1.0 + fres * vCharMat.y * 0.22);
  // Short-hair forward scatter: light passing through the tips of a coat at a
  // grazing angle. This is the warm halo that runs down the edge of a horse
  // against a low sun and it is most of what sells the animal as alive.
  float rim = pow(1.0 - ndv, 2.4) * (mHair * 0.55 + mStrand * 1.00);
  reflectedLight.directDiffuse += reflectedLight.directDiffuse * rim * vec3(1.0, 0.78, 0.54);
}
`);
  };
  m.customProgramCacheKey = () => 'rsChar' + (opts.doubleSide ? 'D' : 'S') + (opts.alphaMap ? 'A' : '');
  return m;
}

/**
 * NORMAL-OFFSET DEPTH MATERIAL — the fix for the stain on the rider's back.
 * ============================================================================
 * The duster carried a large, soft, stippled dark patch across the upper back
 * and down one boot in every third-person frame, and it read as filth rather
 * than as light. It was neither: it was SHADOW ACNE. The character writes
 * itself into the CSM at exactly the depth it is then shaded at, and on a
 * curved cloth surface that is close to parallel with the sun the comparison
 * goes both ways across a few square centimetres — which is precisely the
 * speckled-boundary blob that showed up.
 *
 * A constant depth bias cannot fix that without detaching the contact shadow.
 * The standard cure is to push the CASTER along its own surface normal when
 * rendering the shadow map, which moves the sample off the surface by a fixed
 * world distance regardless of the light angle. 18 mm on a 1.8 m figure is
 * invisible in the cast shadow and removes the acne completely.
 * ============================================================================
 */
export function makeCharDepthMaterial(offset = 0.018) {
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  d.onBeforeCompile = (sh) => {
    sh.uniforms.uCharNrmOff = { value: offset };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uCharNrmOff;')
      .replace('#include <begin_vertex>', /* glsl */`
vec3 rsObjNormal = normalize(normal);
#include <begin_vertex>
transformed += rsObjNormal * uCharNrmOff;
`);
  };
  d.customProgramCacheKey = () => 'rsCharDepth';
  return d;
}

/**
 * Alpha mask for mane / tail / forelock cards: a bundle of individual hairs
 * with a ragged tip, so the silhouette of the mane is made of STRANDS instead
 * of the smooth-edged ribbon it used to be. 64×128 costs 32 KB and one upload.
 *
 * Cached module-wide — both characters and any future NPC horse share it.
 */
let _strandTex = null;
export function strandAlpha(rand) {
  if (_strandTex) return _strandTex;
  const W = 128, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = '#000';
  c.fillRect(0, 0, W, H);

  /*
   * IMPORTANT: this mask must be mostly OPAQUE in its core. The first version
   * drew a sparse scatter of one-pixel hairs; under minification the mipchain
   * averaged them to ~0.4 alpha, the alpha test then flipped whole blocks on
   * and off, and the mane rendered as a fan of black shards. Real hair cards
   * are solid LOCKS with feathered sides and a fringed tip — the individual
   * hair reading comes from the shading grain, not from the cutout.
   */
  const lock = (x0, wid, len, lean) => {
    const tipN = 5 + ((rand() * 4) | 0);
    c.beginPath();
    c.moveTo(x0 - wid * 0.5, 0);
    c.lineTo(x0 + wid * 0.5, 0);
    // right edge down to the fringe
    c.quadraticCurveTo(x0 + wid * 0.52 + lean * 0.4, len * 0.55, x0 + wid * 0.34 + lean, len);
    // ragged tip
    for (let i = tipN; i >= 0; i--) {
      const t = i / tipN;
      const px = x0 + (t - 0.5) * wid * 0.72 + lean * t;
      const py = len * (0.80 + rand() * 0.20);
      c.lineTo(px, py);
    }
    c.quadraticCurveTo(x0 - wid * 0.52 + lean * 0.2, len * 0.55, x0 - wid * 0.5, 0);
    c.closePath();
    c.fill();
  };

  // Overlapping locks across the card. Alpha ~0.9 so two overlapping locks
  // still saturate but a single lock's feathered edge falls under the test.
  c.fillStyle = 'rgba(255,255,255,0.90)';
  for (let i = 0; i < 11; i++) {
    const x0 = (i + 0.5) / 11 * W + (rand() - 0.5) * 9;
    lock(x0, W * (0.13 + rand() * 0.10), H * (0.55 + rand() * 0.45), (rand() - 0.5) * 12);
  }
  // A second sparser pass of longer, narrower locks for the ragged outline.
  c.fillStyle = 'rgba(255,255,255,0.75)';
  for (let i = 0; i < 7; i++) {
    const x0 = rand() * W;
    lock(x0, W * (0.05 + rand() * 0.05), H * (0.72 + rand() * 0.28), (rand() - 0.5) * 16);
  }

  // Fine hair split lines — a VALUE modulation inside the opaque core, which
  // survives mipping as gentle shading instead of collapsing the cutout.
  c.globalCompositeOperation = 'destination-out';
  c.lineCap = 'round';
  for (let i = 0; i < 58; i++) {
    const x0 = rand() * W;
    const len = H * (0.35 + rand() * 0.6);
    const drift = (rand() - 0.5) * 14;
    c.strokeStyle = `rgba(0,0,0,${(0.10 + rand() * 0.22).toFixed(3)})`;
    c.lineWidth = 0.7 + rand() * 1.3;
    c.beginPath();
    c.moveTo(x0, H * 0.12);
    c.quadraticCurveTo(x0 + drift * 0.5, len * 0.6, x0 + drift, len);
    c.stroke();
  }
  c.globalCompositeOperation = 'source-over';

  // Fully solid at the root so a card never separates from the crest or dock.
  const g = c.createLinearGradient(0, 0, 0, H * 0.13);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H * 0.13);

  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  _strandTex = t;
  return t;
}

/**
 * Ground-contact ambient occlusion. A small terrain-conforming patch under the
 * feet/hooves that MULTIPLIES the framebuffer — which is what contact AO
 * physically is — so the character is welded to the ground instead of floating.
 * Sits underneath and independent of the CSM cast shadow.
 */
export class ContactShadow {
  constructor(ctx, { radius = 0.75, strength = 0.72, res = 10, lobes = 1 } = {}) {
    this.ctx = ctx;
    this.radius = radius;
    this.strength = strength;
    this.res = res;
    this.lobes = lobes;

    const g = new THREE.PlaneGeometry(1, 1, res, res);
    g.rotateX(-Math.PI / 2);
    this.geo = g;
    this._base = g.attributes.position.array.slice();

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uStrength: { value: strength },
        uLobes: {
          value: [new THREE.Vector4(0, 0, 1, 0), new THREE.Vector4(0, 0, 1, 0),
            new THREE.Vector4(0, 0, 1, 0), new THREE.Vector4(0, 0, 1, 0)],
        },
        uCentre: { value: new THREE.Vector3() },
        uRadius: { value: radius },
      },
      vertexShader: /* glsl */`
        varying vec3 vW;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vW;
        uniform float uStrength;
        uniform vec4 uLobes[4];
        uniform vec3 uCentre;
        uniform float uRadius;
        void main() {
          float occ = 0.0;
          for (int i = 0; i < 4; i++) {
            vec4 L = uLobes[i];
            if (L.w <= 0.0) continue;
            float d = length(vW.xz - L.xy) / max(L.z, 0.001);
            float f = 1.0 - smoothstep(0.0, 1.0, d);
            occ = max(occ, f * f * L.w);
          }
          float fade = 1.0 - smoothstep(0.55, 1.0, length(vW.xz - uCentre.xz) / uRadius);
          occ *= fade;
          float a = clamp(occ * uStrength, 0.0, 0.97);
          gl_FragColor = vec4(vec3(1.0 - a), 1.0);
        }
      `,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      side: THREE.FrontSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.userData.rsNoAerial = true;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  /**
   * @param {THREE.Vector3[]} lobes  up to 2 world-space contact points
   * @param {number[]} radii
   * @param {number[]} weights
   */
  update(lobes, radii, weights) {
    const world = this.ctx.world;
    const u = this.mat.uniforms;
    let cx = 0, cz = 0, n = 0, maxR = 0.3;
    for (let i = 0; i < 4; i++) {
      const L = u.uLobes.value[i];
      if (i < lobes.length) {
        L.set(lobes[i].x, lobes[i].z, radii[i], weights[i]);
        cx += lobes[i].x; cz += lobes[i].z; n++;
        maxR = Math.max(maxR, radii[i]);
      } else L.set(0, 0, 1, 0);
    }
    if (!n) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    cx /= n; cz /= n;
    // Patch must cover both lobes plus their falloff.
    let span = 0;
    for (const l of lobes) span = Math.max(span, Math.hypot(l.x - cx, l.z - cz));
    const R = (span + maxR) * 1.25;
    u.uCentre.value.set(cx, 0, cz);
    u.uRadius.value = R;

    // Conform the patch to the terrain so it never slices into a slope.
    const pos = this.geo.attributes.position;
    const arr = pos.array, base = this._base;
    for (let i = 0; i < arr.length; i += 3) {
      const x = base[i] * R * 2 + cx;
      const z = base[i + 2] * R * 2 + cz;
      arr[i] = base[i] * R * 2;
      arr[i + 2] = base[i + 2] * R * 2;
      arr[i + 1] = world.getHeight(x, z) + 0.012;
    }
    pos.needsUpdate = true;
    this.mesh.position.set(cx, 0, cz);
    this.mesh.updateMatrix();
    this.mesh.matrixWorldNeedsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}
