import * as THREE from 'three';
import { rng } from '../../core/Context.js';
import { ATMO_GLSL_CONSTANTS, ATMO_GLSL_COMMON, RS_OUTPUT_GLSL } from './Atmosphere.js';
import { LUT_SIZES } from './SkyLuts.js';

/**
 * RED SANDS — deterministic star catalogue.
 *
 * ~5000 stars generated once from rng(seed): a power-law magnitude
 * distribution (many faint, very few bright), blackbody colours from a
 * temperature distribution biased hot for the bright end (the way the real
 * naked-eye sky is dominated by B/A giants), and a genuine concentration
 * toward the galactic plane.
 *
 * Stars are stored in EQUATORIAL coordinates and rotated into the horizon
 * frame by a matrix Sky rebuilds every frame from local sidereal time, so the
 * whole sky turns about the celestial pole as the night advances. Extinction
 * near the horizon is sampled from the real transmittance LUT in the vertex
 * shader, so stars redden and die out as they set.
 */

/** Galactic north pole and centre, J2000 equatorial. */
export const GALACTIC = {
  poleRaDeg: 192.8595,
  poleDecDeg: 27.1284,
  centreRaDeg: 266.4050,
  centreDecDeg: -28.9362,
};

const DEG = Math.PI / 180;

function eq(raDeg, decDeg, out = new THREE.Vector3()) {
  const ra = raDeg * DEG, dec = decDeg * DEG;
  return out.set(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec));
}

/** Basis mapping equatorial -> galactic (rows of the matrix). */
export function galacticBasis() {
  const gz = eq(GALACTIC.poleRaDeg, GALACTIC.poleDecDeg);
  let gx = eq(GALACTIC.centreRaDeg, GALACTIC.centreDecDeg);
  gx.addScaledVector(gz, -gx.dot(gz)).normalize();
  const gy = new THREE.Vector3().crossVectors(gz, gx).normalize();
  const m = new THREE.Matrix3();
  m.set(gx.x, gx.y, gx.z, gy.x, gy.y, gy.z, gz.x, gz.y, gz.z);
  return { m, gx, gy, gz };
}

/** CIE Planckian locus -> normalised linear sRGB. */
function blackbodyLinear(T, out) {
  const t = Math.min(Math.max(T, 1667), 25000);
  const t2 = t * t, t3 = t2 * t;
  let x;
  if (t < 4000) x = -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.179910;
  else x = -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.240390;
  const x2 = x * x, x3 = x2 * x;
  let y;
  if (t < 2222) y = -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683;
  else if (t < 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;

  const Y = 1.0;
  const X = (x / Math.max(y, 1e-4)) * Y;
  const Z = ((1 - x - y) / Math.max(y, 1e-4)) * Y;
  let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  let g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  let b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
  r = Math.max(r, 0); g = Math.max(g, 0); b = Math.max(b, 0);
  const lum = Math.max(0.2126 * r + 0.7152 * g + 0.0722 * b, 1e-4);
  // pull slightly toward neutral: real photographic stars are not saturated
  const k = 0.55;
  out[0] = 1 + (r / lum - 1) * k;
  out[1] = 1 + (g / lum - 1) * k;
  out[2] = 1 + (b / lum - 1) * k;
  return out;
}

const VERT = /* glsl */`
#define RS_TLUT_W ${LUT_SIZES.TLUT_W}
#define RS_TLUT_H ${LUT_SIZES.TLUT_H}
#define RS_MLUT_W ${LUT_SIZES.MLUT_W}
#define RS_MLUT_H ${LUT_SIZES.MLUT_H}
${ATMO_GLSL_CONSTANTS}
${ATMO_GLSL_COMMON}

attribute vec3 aColor;
attribute vec3 aParam;      // x = point size, y = intensity, z = twinkle seed

uniform mat3  uCelestial;
uniform float uPixelScale;
uniform float uBrightness;
uniform float uTime;
uniform float uFade;
uniform sampler2D uTransmittance;

varying vec3 vColor;
varying float vSpike;

void main() {
  vec3 dir = normalize(uCelestial * position);

  // below the horizon: cull hard
  if (dir.y < -0.035 || uFade < 0.002) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vSpike = 0.0;
    return;
  }

  // physical extinction along the real slant path
  vec3 ext = texture2D(uTransmittance, rsTransmittanceUv(RS_GROUND_R + 0.06, dir.y)).rgb;
  float horizonFade = smoothstep(-0.035, 0.045, dir.y);

  // scintillation: strong low, gentle high
  float sc = sin(uTime * (1.6 + aParam.z * 5.0) + aParam.z * 31.7)
           * sin(uTime * (2.7 + aParam.z * 3.1) + aParam.z * 11.3);
  float scAmt = mix(0.30, 0.05, clamp(dir.y * 2.2, 0.0, 1.0));
  float twk = 1.0 + sc * scAmt;

  float inten = aParam.y * uBrightness * uFade * twk * horizonFade;
  vColor = aColor * ext * inten;
  vSpike = smoothstep(3.05, 4.05, aParam.x);

  gl_PointSize = max(aParam.x * uPixelScale * (0.9 + 0.25 * twk), 1.9);

  vec4 mv = modelViewMatrix * vec4(dir * 5000.0, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
precision highp float;
${RS_OUTPUT_GLSL}
varying vec3 vColor;
varying float vSpike;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 6.5);
  float halo = exp(-r2 * 1.7) * 0.22;
  float a = core + halo;
  if (vSpike > 0.0) {
    float sp = exp(-abs(p.x) * 13.0) * exp(-abs(p.y) * 2.0)
             + exp(-abs(p.y) * 13.0) * exp(-abs(p.x) * 2.0);
    a += sp * 0.11 * vSpike;
  }
  gl_FragColor = vec4(rsOutput(vColor * a), 1.0);
  #include <colorspace_fragment>
}
`;

export class Stars {
  /**
   * @param {number} seed
   * @param {number} count
   */
  constructor(seed, count = 5000) {
    this.count = count;
    const rand = rng(seed ^ 0x5ee5);
    const { m: galM } = galacticBasis();
    const galInv = galM.clone().transpose(); // galactic -> equatorial

    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const par = new Float32Array(count * 3);
    const rgb = [0, 0, 0];
    const v = new THREE.Vector3();

    const M_FAINT = 6.7;
    const M_BRIGHT = -1.6;
    const FLUX_MAX = Math.pow(10, -0.4 * (M_BRIGHT - M_FAINT));

    for (let i = 0; i < count; i++) {
      // --- position ---------------------------------------------------
      if (rand() < 0.44) {
        // galactic-plane concentrated
        const lon = rand() * Math.PI * 2;
        // two-sided exponential latitude, tight
        const u = rand() * 2 - 1;
        const lat = Math.sign(u) * -Math.log(Math.max(1e-4, 1 - Math.abs(u))) * 0.085;
        const cl = Math.cos(lat);
        v.set(cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat));
        v.applyMatrix3(galInv);
      } else {
        const z = rand() * 2 - 1;
        const t = rand() * Math.PI * 2;
        const s = Math.sqrt(Math.max(0, 1 - z * z));
        v.set(s * Math.cos(t), s * Math.sin(t), z);
      }
      v.normalize();
      pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;

      // --- magnitude (power law: overwhelmingly faint) -----------------
      const um = rand();
      const mag = M_FAINT - (M_FAINT - M_BRIGHT) * Math.pow(um, 2.7);
      const flux = Math.pow(10, -0.4 * (mag - M_FAINT));
      const fnorm = flux / FLUX_MAX;

      // --- colour temperature, biased hot for bright stars -------------
      const ut = rand();
      const hotBias = Math.pow(fnorm, 0.30);
      const T = 2950 + (16500 - 2950) * Math.pow(ut, 1.40 - 0.65 * hotBias);
      blackbodyLinear(T, rgb);
      col[i * 3] = rgb[0]; col[i * 3 + 1] = rgb[1]; col[i * 3 + 2] = rgb[2];

      par[i * 3] = 1.55 + 2.70 * Math.pow(fnorm, 0.24);
      par[i * 3 + 1] = 0.055 + 1.10 * Math.pow(fnorm, 0.42);
      par[i * 3 + 2] = rand();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aParam', new THREE.BufferAttribute(par, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6000);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uCelestial: { value: new THREE.Matrix3() },
        uPixelScale: { value: 1 },
        uBrightness: { value: 1 },
        uTime: { value: 0 },
        uFade: { value: 0 },
        uTransmittance: { value: null },
        uFallbackTonemap: { value: 0 },
        uFallbackExposure: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: false,
      blending: THREE.AdditiveBlending,
      /* Stars follow the dome (renderOrder 21) and must be depth-tested now
       * that both draw after the world: at 5 km they are behind every piece of
       * geometry, so early-Z rejects the ones a mountain covers instead of
       * blending them in and letting the mountain overdraw them. */
      depthTest: true,
      depthWrite: false,
      fog: false,
    });

    this.object = new THREE.Points(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 22;
    this.object.matrixAutoUpdate = true;
  }

  dispose() {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
