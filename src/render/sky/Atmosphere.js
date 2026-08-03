/**
 * RED SANDS — Atmosphere model constants and shared maths.
 *
 * One source of truth for the physical parameters used by:
 *   - the GPU LUT chain (transmittance / multiple-scattering / sky-view)
 *   - the aerial-perspective GLSL chunk injected into other systems' materials
 *   - the CPU solar/lunar colour derivation in src/sim/TimeOfDay.js
 *
 * Units: kilometres, per-kilometre scattering coefficients. Earth-like.
 * Reference: Bruneton & Neyret 2008; Hillaire 2020 ("A Scalable and Production
 * Ready Sky and Atmosphere Rendering Technique").
 */

export const ATMO = {
  /** Planetary radius, km. */
  groundRadiusKm: 6360.0,
  /** Top of atmosphere, km (100 km shell). */
  topRadiusKm: 6460.0,

  /** Rayleigh scattering at sea level, 1/km, for ~(680, 550, 440) nm. */
  rayleighScattering: [5.802e-3, 13.558e-3, 33.100e-3],
  rayleighScaleHeightKm: 8.0,

  /** Mie (aerosol) scattering + absorption at sea level, 1/km. */
  mieScattering: 3.996e-3,
  mieAbsorption: 4.40e-3,
  mieExtinction: 3.996e-3 + 4.4e-3,
  mieScaleHeightKm: 1.2,
  /** Forward-scattering anisotropy for the Cornette-Shanks phase. */
  mieAnisotropy: 0.78,

  /** Ozone absorption, 1/km — the tent layer that keeps the zenith deep blue. */
  ozoneAbsorption: [0.650e-3, 1.881e-3, 0.085e-3],
  ozoneCenterKm: 25.0,
  ozoneHalfWidthKm: 15.0,

  /**
   * Ground albedo fed into the multiple-scattering LUT. Bleached ochre desert:
   * this is what warms the low sky and the shadow fill in this world.
   */
  groundAlbedo: [0.31, 0.245, 0.155],

  /** Angular radii, radians. */
  sunAngularRadius: 0.004675, // 0.2678 deg -> 0.536 deg diameter
  moonAngularRadius: 0.004520,

  /** Global radiance scale mapping the unitless integral to render units.
   *  Calibrated so a clear noon zenith sits at ~0.37x the radiance of a 42%
   *  albedo ground facing the sun — the real-world ratio. */
  skyRadianceScale: 18.0,
};

/** Turbidity -> Mie density multiplier. 2.6 (the default clear air) maps to 1. */
export function turbidityToMie(turbidity) {
  return Math.max(0.45, (turbidity - 0.6) / 1.6);
}

/* ------------------------------------------------------------------ GLSL */

/** Shared constant block. Injected verbatim into every atmosphere shader. */
export const ATMO_GLSL_CONSTANTS = `
#ifndef RS_ATMO_CONSTANTS
#define RS_ATMO_CONSTANTS
#define RS_PI 3.141592653589793
#define RS_GROUND_R 6360.0
#define RS_TOP_R    6460.0
const vec3  RS_RAY_S = vec3(5.802e-3, 13.558e-3, 33.100e-3);
#define RS_RAY_H 8.0
#define RS_MIE_S 3.996e-3
#define RS_MIE_E 8.396e-3
#define RS_MIE_H 1.2
#define RS_MIE_G 0.78
const vec3  RS_OZO_A = vec3(0.650e-3, 1.881e-3, 0.085e-3);
#define RS_OZO_C 25.0
#define RS_OZO_W 15.0
const vec3  RS_GROUND_ALBEDO = vec3(0.31, 0.245, 0.155);
#endif
`;

/**
 * Geometry + medium sampling + LUT parameterisation.
 * Requires RS_TLUT_W / RS_TLUT_H / RS_MLUT_W / RS_MLUT_H to be #defined.
 */
export const ATMO_GLSL_COMMON = `
#ifndef RS_ATMO_COMMON
#define RS_ATMO_COMMON

float rsSafeSqrt(float x) { return sqrt(max(x, 0.0)); }
float rsSafeAcos(float x) { return acos(clamp(x, -1.0, 1.0)); }

void rsSampleMedium(float altKm, float mieMul,
                    out vec3 rayS, out float mieS, out vec3 extinction) {
  float a = max(altKm, 0.0);
  float dRay = exp(-a / RS_RAY_H);
  float dMie = exp(-a / RS_MIE_H);
  float dOzo = max(0.0, 1.0 - abs(altKm - RS_OZO_C) / RS_OZO_W);
  rayS = RS_RAY_S * dRay;
  mieS = RS_MIE_S * dMie * mieMul;
  extinction = rayS + vec3(RS_MIE_E * dMie * mieMul) + RS_OZO_A * dOzo;
}

float rsRayleighPhase(float c) { return 0.05968310365 * (1.0 + c * c); }

float rsMiePhase(float c, float g) {
  float g2 = g * g;
  float num = 3.0 * (1.0 - g2) * (1.0 + c * c);
  float den = 8.0 * RS_PI * (2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
  return num / den;
}

float rsDistToTop(float r, float mu) {
  float d = r * r * (mu * mu - 1.0) + RS_TOP_R * RS_TOP_R;
  return max(0.0, -r * mu + rsSafeSqrt(d));
}
float rsDistToGround(float r, float mu) {
  float d = r * r * (mu * mu - 1.0) + RS_GROUND_R * RS_GROUND_R;
  return max(0.0, -r * mu - rsSafeSqrt(d));
}
bool rsHitsGround(float r, float mu) {
  return mu < 0.0 && (r * r * (mu * mu - 1.0) + RS_GROUND_R * RS_GROUND_R) >= 0.0;
}

/**
 * Soft planetary shadow. This is what carves Earth's shadow and the Belt of
 * Venus out of the twilight sky: a sample high in the atmosphere on the
 * anti-solar side has its line to the sun blocked by the planet.
 */
float rsPlanetShadow(vec3 p, vec3 sunDir) {
  float b = dot(p, sunDir);
  if (b > 0.0) return 1.0;
  float closest = rsSafeSqrt(dot(p, p) - b * b);
  return smoothstep(RS_GROUND_R - 5.0, RS_GROUND_R + 5.0, closest);
}

/* --- half-texel safe unit<->uv mapping (Bruneton) --- */
float rsUnitToUv(float x, float n) { return 0.5 / n + x * (1.0 - 1.0 / n); }
float rsUvToUnit(float u, float n) { return (u - 0.5 / n) / (1.0 - 1.0 / n); }

vec2 rsTransmittanceUv(float r, float mu) {
  float H   = rsSafeSqrt(RS_TOP_R * RS_TOP_R - RS_GROUND_R * RS_GROUND_R);
  float rho = rsSafeSqrt(r * r - RS_GROUND_R * RS_GROUND_R);
  float d   = rsDistToTop(r, mu);
  float dmin = RS_TOP_R - r;
  float dmax = rho + H;
  float xmu = (dmax - dmin > 1e-5) ? (d - dmin) / (dmax - dmin) : 0.0;
  float xr  = rho / H;
  return vec2(rsUnitToUv(clamp(xmu, 0.0, 1.0), float(RS_TLUT_W)),
              rsUnitToUv(clamp(xr,  0.0, 1.0), float(RS_TLUT_H)));
}

void rsTransmittanceRMu(vec2 uv, out float r, out float mu) {
  float xmu = rsUvToUnit(uv.x, float(RS_TLUT_W));
  float xr  = rsUvToUnit(uv.y, float(RS_TLUT_H));
  float H   = rsSafeSqrt(RS_TOP_R * RS_TOP_R - RS_GROUND_R * RS_GROUND_R);
  float rho = H * clamp(xr, 0.0, 1.0);
  r = rsSafeSqrt(rho * rho + RS_GROUND_R * RS_GROUND_R);
  float dmin = RS_TOP_R - r;
  float dmax = rho + H;
  float d = dmin + clamp(xmu, 0.0, 1.0) * (dmax - dmin);
  mu = (d < 1e-5) ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
  mu = clamp(mu, -1.0, 1.0);
}

vec2 rsMultiScatterUv(float r, float muS) {
  float u = clamp(0.5 + 0.5 * muS, 0.0, 1.0);
  float v = clamp((r - RS_GROUND_R) / (RS_TOP_R - RS_GROUND_R), 0.0, 1.0);
  return vec2(rsUnitToUv(u, float(RS_MLUT_W)), rsUnitToUv(v, float(RS_MLUT_H)));
}

/* --- sky-view LUT parameterisation, world-aligned azimuth --------------- */
/* u wraps over full azimuth (RepeatWrapping); v is horizon-compressed.     */

void rsSkyViewUvToDir(vec2 uv, float r, out vec3 dir) {
  float azi = uv.x * 2.0 * RS_PI;
  float Vh  = rsSafeSqrt(r * r - RS_GROUND_R * RS_GROUND_R);
  float beta = rsSafeAcos(Vh / r);
  float zha = RS_PI - beta;
  float vza;
  if (uv.y < 0.5) {
    float c = 1.0 - 2.0 * uv.y; c *= c;
    vza = zha * (1.0 - c);
  } else {
    float c = 2.0 * uv.y - 1.0; c *= c;
    vza = zha + beta * c;
  }
  float s = sin(vza);
  dir = vec3(s * cos(azi), cos(vza), s * sin(azi));
}

vec2 rsSkyViewDirToUv(vec3 dir, float r) {
  float a = atan(dir.z, dir.x);
  if (a < 0.0) a += 2.0 * RS_PI;
  float u = a / (2.0 * RS_PI);

  float Vh  = rsSafeSqrt(r * r - RS_GROUND_R * RS_GROUND_R);
  float beta = rsSafeAcos(Vh / r);
  float zha = RS_PI - beta;
  float vza = rsSafeAcos(dir.y);
  float v;
  if (vza < zha) {
    float c = 1.0 - vza / zha;
    v = (1.0 - sqrt(max(c, 0.0))) * 0.5;
  } else {
    float c = (vza - zha) / max(beta, 1e-5);
    v = sqrt(max(c, 0.0)) * 0.5 + 0.5;
  }
  return vec2(u, clamp(v, 0.0, 1.0));
}
#endif
`;

/**
 * Fallback display transform.
 *
 * The contract is: renderer is NoToneMapping and PostFX owns the tonemap. But
 * while PostFX is a stub (no `render`), everything the sky writes goes straight
 * to an 8-bit framebuffer and blows out. Sky flips `uFallbackTonemap` to 1 only
 * when `ctx.get('postfx').render` is absent, so the moment a real PostFX lands
 * this turns itself off and the sky goes back to pure linear HDR output.
 */
export const RS_OUTPUT_GLSL = `
#ifndef RS_OUTPUT_INCLUDED
#define RS_OUTPUT_INCLUDED
uniform float uFallbackTonemap;
uniform float uFallbackExposure;
vec3 rsFilmic(vec3 x) {
  // ACES fitted (Narkowicz), close enough for a preview transform
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 rsOutput(vec3 col) {
  if (uFallbackTonemap > 0.5) {
    col = rsFilmic(col * uFallbackExposure);
  }
  return col;
}
#endif
`;

/* --------------------------------------------------------------- CPU side */

const Rg = ATMO.groundRadiusKm;
const Rt = ATMO.topRadiusKm;

function extinctionAt(altKm, mieMul, out) {
  const a = Math.max(altKm, 0);
  const dR = Math.exp(-a / ATMO.rayleighScaleHeightKm);
  const dM = Math.exp(-a / ATMO.mieScaleHeightKm);
  const dO = Math.max(0, 1 - Math.abs(altKm - ATMO.ozoneCenterKm) / ATMO.ozoneHalfWidthKm);
  const mieE = ATMO.mieExtinction * dM * mieMul;
  out[0] = ATMO.rayleighScattering[0] * dR + mieE + ATMO.ozoneAbsorption[0] * dO;
  out[1] = ATMO.rayleighScattering[1] * dR + mieE + ATMO.ozoneAbsorption[1] * dO;
  out[2] = ATMO.rayleighScattering[2] * dR + mieE + ATMO.ozoneAbsorption[2] * dO;
  return out;
}

const _ext = [0, 0, 0];

/**
 * Spectral transmittance from an observer at `altKm` looking along a direction
 * whose cosine to the local zenith is `mu`, all the way out to space.
 * This is what turns the sun red at the horizon — the extinction is derived
 * from the true slant path, never from a hand-authored gradient.
 *
 * @returns {number[]} out — linear RGB transmittance, 0..1
 */
export function transmittanceToSpace(altKm, mu, mieMul = 1, steps = 48, out = [0, 0, 0]) {
  const r = Rg + Math.max(altKm, 0.0);
  const m = Math.max(-1, Math.min(1, mu));
  if (m < 0 && r * r * (m * m - 1) + Rg * Rg >= 0) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const disc = r * r * (m * m - 1) + Rt * Rt;
  const dTop = Math.max(0, -r * m + Math.sqrt(Math.max(disc, 0)));
  const dt = dTop / steps;
  let o0 = 0, o1 = 0, o2 = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const ri = Math.sqrt(r * r + t * t + 2 * r * t * m);
    extinctionAt(ri - Rg, mieMul, _ext);
    o0 += _ext[0] * dt; o1 += _ext[1] * dt; o2 += _ext[2] * dt;
  }
  out[0] = Math.exp(-o0);
  out[1] = Math.exp(-o1);
  out[2] = Math.exp(-o2);
  return out;
}

/**
 * Atmospheric refraction lift, in degrees, for a true altitude in degrees
 * (Saemundsson). Roughly +0.57 deg on the horizon — it is why the sun is
 * already geometrically set when you can still see it.
 */
export function refractionDeg(altDeg) {
  const a = Math.max(altDeg, -1.2);
  return 1.02 / Math.tan(((a + 10.3 / (a + 5.11)) * Math.PI) / 180) / 60;
}

/**
 * Cheap CPU single-scattering estimate of sky radiance along `dir`.
 * Used for the ambient/irradiance handoff to Lighting & Weather.
 */
export function skyRadianceCPU(dx, dy, dz, sx, sy, sz, mieMul, camAltKm, out, steps = 12) {
  const r0 = Rg + Math.max(camAltKm, 0);
  const mu0 = dy;
  const hitsGround = mu0 < 0 && r0 * r0 * (mu0 * mu0 - 1) + Rg * Rg >= 0;
  const tMax = hitsGround
    ? Math.max(0, -r0 * mu0 - Math.sqrt(Math.max(r0 * r0 * (mu0 * mu0 - 1) + Rg * Rg, 0)))
    : Math.max(0, -r0 * mu0 + Math.sqrt(Math.max(r0 * r0 * (mu0 * mu0 - 1) + Rt * Rt, 0)));
  out[0] = out[1] = out[2] = 0;
  if (tMax <= 0) return out;

  const cosT = dx * sx + dy * sy + dz * sz;
  const pR = 0.05968310365 * (1 + cosT * cosT);
  const g = ATMO.mieAnisotropy, g2 = g * g;
  const pM = (3 * (1 - g2) * (1 + cosT * cosT)) /
    (8 * Math.PI * (2 + g2) * Math.pow(Math.max(1 + g2 - 2 * g * cosT, 1e-4), 1.5));

  let tp0 = 1, tp1 = 1, tp2 = 1;
  const sunT = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const f0 = i / steps, f1 = (i + 1) / steps;
    const t0 = f0 * f0 * tMax, t1 = f1 * f1 * tMax;
    const dt = t1 - t0;
    const tm = t0 + dt * 0.4;
    const px = dx * tm, py = r0 + dy * tm, pz = dz * tm;
    const ri = Math.sqrt(px * px + py * py + pz * pz);
    const alt = ri - Rg;
    extinctionAt(alt, mieMul, _ext);
    const dR = Math.exp(-Math.max(alt, 0) / ATMO.rayleighScaleHeightKm);
    const dM = Math.exp(-Math.max(alt, 0) / ATMO.mieScaleHeightKm);
    const muS = (px * sx + py * sy + pz * sz) / ri;
    transmittanceToSpace(alt, muS, mieMul, 16, sunT);
    for (let c = 0; c < 3; c++) {
      const rs = ATMO.rayleighScattering[c] * dR;
      const ms = ATMO.mieScattering * dM * mieMul;
      const S = (rs * pR + ms * pM) * sunT[c];
      const e = Math.max(_ext[c], 1e-9);
      const st = Math.exp(-e * dt);
      const Sint = (S - S * st) / e;
      const tp = c === 0 ? tp0 : c === 1 ? tp1 : tp2;
      out[c] += tp * Sint;
      if (c === 0) tp0 *= st; else if (c === 1) tp1 *= st; else tp2 *= st;
    }
  }
  // crude multiple-scattering compensation (the GPU path uses a real LUT)
  out[0] *= 1.45; out[1] *= 1.55; out[2] *= 1.7;
  return out;
}
