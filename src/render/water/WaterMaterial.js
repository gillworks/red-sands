import * as THREE from 'three';

/**
 * RED SANDS — water surface shader.
 *
 * One forward pass, no G-buffer, no second scene render. What it does, in the
 * order the fragment does it, and why each piece is there:
 *
 *   depth field      `d = surface - bed`, bilinear off the SAME grid the terrain
 *                    heightfield uses, so the waterline is analytic and
 *                    sub-texel. Drives the shoreline feather, the Beer-Lambert
 *                    ramp, the foam and the caustic falloff.
 *   surface          four Gerstner trains for the metre-scale swell plus five
 *                    scrolling detail-normal bands ADVECTED ALONG the flow
 *                    field. Every band is gated by its own texel FOOTPRINT
 *                    (§ normal LOD) so a wavelength shorter than about three
 *                    screen pixels is retired into roughness instead of being
 *                    drawn — that is what stops the far half of a river from
 *                    turning into constant-frequency painted streaks, and it is
 *                    what lets the Fresnel gradient survive to the horizon.
 *   aerial split     the grabbed colour buffer ALREADY carries haze. Everything
 *                    is therefore de-hazed into surface radiance, composited,
 *                    and re-hazed exactly once. Applying the aerial chunk on top
 *                    of a refraction sampled out of an already-hazed buffer is
 *                    what turned this surface into a sheet of milk.
 *   refraction       screen-space, offset by the surface normal, scaled by depth
 *                    so the shallows cannot drag foreground pixels over the bank.
 *   absorption       Beer-Lambert over the slant path with an in-scattered body
 *                    colour: shallows pale green over a visible bed, deeps slate.
 *   caustics         projected onto the bed in shallow water, animated, faded by
 *                    depth and sun elevation.
 *   reflection       Fresnel-weighted screen-space ENVIRONMENT reflection: the
 *                    reflected DIRECTION is projected into the grabbed colour
 *                    buffer and read back, vertically smeared by the sub-pixel
 *                    slope. That returns the real shaded far bank, its trees,
 *                    the ranges behind it and the clouds — lit, shadowed and
 *                    hazed exactly as the scene already is — for three texture
 *                    fetches. The sky-view LUT is the fallback wherever the
 *                    direction projects off-screen.
 *   glitter          height-correlated Smith-GGX sun highlight. The roughness
 *                    carries the variance of every normal band the footprint
 *                    test retired, so the specular energy that the geometry lost
 *                    reappears as a broken glitter path instead of vanishing.
 *   foam             shoreline lace (from distance-to-shore), whitewater on fast
 *                    steep reaches, wind spume on crests — all animated.
 */

/* ------------------------------------------------------------------ vertex */

const VERT = /* glsl */`
uniform highp sampler2D uDepthTex;
uniform sampler2D uFlowTex;
uniform vec4  uWorld;        // x = half extent, y = res, z = 1/res
uniform float uTime;
uniform vec4  uWave;         // x = amplitude, y = choppiness, z = windDirX, w = windDirZ
uniform float uWindSpeed;
uniform vec3  uCamPosW;

varying vec3  vWorld;        // displaced world position
varying vec2  vBase;         // UNdisplaced world xz — every field lookup uses this
varying float vSurfY;        // undisplaced surface height
varying float vAmp;          // Gerstner amplitude — the normal is rebuilt per PIXEL
varying vec4  vFlow;         // xy = unit flow dir, z = speed 0..1, w = riverness
varying float vDist;
varying vec2  vProj;         // (P[0][0], P[1][1]) — lets the fragment project

void main() {
  vec2 base = position.xz;
  vBase = base;
  vSurfY = position.y;

  vec2 uvW = (base + uWorld.x) / (2.0 * uWorld.x);
  float d0 = texture2D(uDepthTex, uvW).r;
  vec4 fl = texture2D(uFlowTex, uvW);
  vec2 fdir = fl.xy * 2.0 - 1.0;
  vFlow = vec4(fdir, fl.z, fl.w);

  // Waves die in the shallows (they break) and on a river (a channel that
  // narrow has no fetch); open, deep water gets the full amplitude.
  float shallow = clamp(d0 * 0.8, 0.0, 1.0);
  float open = 1.0 - clamp(fl.w * 1.4, 0.0, 1.0);
  float amp = uWave.x * shallow * mix(0.50, 1.0, open);
  vAmp = amp;

  vec2 wind = normalize(vec2(uWave.z, uWave.w) + vec2(1e-4, 0.0));
  vec3 disp = vec3(0.0);

  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float ang = (fi - 1.5) * 0.44;
    float ca = cos(ang), sa = sin(ang);
    vec2 dir = vec2(wind.x * ca - wind.y * sa, wind.x * sa + wind.y * ca);
    // On moving water the trains travel downstream instead of downwind.
    dir = normalize(mix(dir, vFlow.xy, clamp(vFlow.w * 1.2, 0.0, 0.85)) + vec2(1e-5, 0.0));

    float len = 34.0 / (1.0 + fi * 0.72);
    float k = 6.2831853 / len;
    float a = amp / (1.0 + fi * 1.25);
    float speed = sqrt(9.81 / k);
    float ph = dot(dir, base) * k - uTime * speed * k;
    float s = sin(ph), c = cos(ph);
    disp.y += a * s;
    disp.xz -= dir * (a * uWave.y * c);
  }

  vec3 wp = vec3(base.x + disp.x, position.y + disp.y, base.y + disp.z);
  vWorld = wp;
  vDist = length(wp - uCamPosW);
  vProj = vec2(projectionMatrix[0][0], projectionMatrix[1][1]);

  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

/* ---------------------------------------------------------------- fragment */

const FRAG_BODY = /* glsl */`
uniform highp sampler2D uDepthTex;
uniform sampler2D uFlowTex;
uniform sampler2D uRipple;
uniform sampler2D uFoamTex;
uniform sampler2D uCausticTex;
uniform sampler2D uGrab;
uniform vec4  uWorld;
uniform vec2  uGrabTexel;
uniform float uUseGrab;
uniform float uTime;
uniform vec3  uCamPosW;
uniform vec3  uSunDirW;
uniform vec3  uSunRad;
uniform vec3  uAmbient;
uniform vec3  uAbsorb;       // per-metre extinction, linear
uniform vec3  uScatter;      // water body scattering albedo
uniform vec3  uFoamTint;
uniform vec4  uTune;         // x = refractScale, y = foamAmt, z = causticAmt, w = specAmt
uniform vec4  uWave;
uniform float uWindSpeed;
uniform vec4  uSurfTune;     // x = ripple gain, y = SSR amount, z = px/metre-at-1m, w = spare
uniform float uRippleNorm;   // 1 / rms slope of the ripple map
uniform float uDebug;

varying vec3  vWorld;
varying vec2  vBase;
varying float vSurfY;
varying float vAmp;
varying vec4  vFlow;
varying float vDist;
varying vec2  vProj;

#define RSW_PI 3.14159265359

/** Sun/moon visibility from the cascades, or 1 when Lighting has no CSM. */
float rsWaterSunVis(vec3 wpos, vec3 nrm) {
#ifdef RS_WATER_CSM
  #ifdef RS_WATER_CSM_VEC3
    vec3 sv = rsCsmDirectionalShadow(
      rsCsmKeyDir,
      (viewMatrix * vec4(wpos, 1.0)).xyz,
      normalize((viewMatrix * vec4(nrm, 0.0)).xyz));
    return dot(sv, vec3(0.2126, 0.7152, 0.0722));
  #else
    return rsCsmDirectionalShadow(
      rsCsmKeyDir,
      (viewMatrix * vec4(wpos, 1.0)).xyz,
      normalize((viewMatrix * vec4(nrm, 0.0)).xyz));
  #endif
#else
  return 1.0;
#endif
}

/**
 * Gerstner swell slope, rebuilt PER PIXEL.
 *
 * The trains are 11-34 m long and the surface mesh samples the heightfield grid
 * at ~3.6 m, so an interpolated vertex normal carries barely three samples per
 * wavelength. On a diffuse surface nobody would notice; on a grazing reflection
 * a 0.08 slope error swings the reflected ray sixteen degrees, and the far half
 * of the river breaks into hard quad-shaped blocks of mismatched reflection.
 * Evaluating the same sum analytically in the fragment costs four cosines and
 * removes the faceting completely. Kept bit-identical to the vertex loop so the
 * displacement and the normal describe the same surface.
 */
vec2 rsGerstnerSlope(vec2 base, float amp, float foot) {
  vec2 wind = normalize(vec2(uWave.z, uWave.w) + vec2(1e-4, 0.0));
  vec2 dsum = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float ang = (fi - 1.5) * 0.44;
    float ca = cos(ang), sa = sin(ang);
    vec2 dir = vec2(wind.x * ca - wind.y * sa, wind.x * sa + wind.y * ca);
    dir = normalize(mix(dir, vFlow.xy, clamp(vFlow.w * 1.2, 0.0, 0.85)) + vec2(1e-5, 0.0));
    float len = 34.0 / (1.0 + fi * 0.72);
    float g = smoothstep(0.7, 2.2, len / max(foot, 1e-3));
    if (g < 0.002) continue;
    float k = 6.2831853 / len;
    float a = amp / (1.0 + fi * 1.25);
    float ph = dot(dir, base) * k - uTime * sqrt(9.81 / k) * k;
    dsum += dir * (a * k * cos(ph) * g);
  }
  return dsum;
}

/* ---- flow-advected detail slope ----------------------------------------- */
/* Two half-cycle-offset samples cross-faded: the texture never stretches, and
   the surface reads as continuously moving rather than sliding as one sheet.
   "rot" decorrelates the bands — sampling one 512px map at several incommensurate
   scales still shows its period, sampling it at several ORIENTATIONS does not.
   The returned tangent slope is rotated back into world alignment so the bands
   still add up to one coherent surface, and normalised by uRippleNorm so the
   weights below are honest world-space SLOPES (rise over run), not arbitrary
   texture units. */
vec2 rsFlowSlope(vec2 wp, vec2 vel, vec2 sc, float period, float phase, vec2 rot,
                 out float crest) {
  mat2 R = mat2(rot.x, -rot.y, rot.y, rot.x);
  vec2 p = R * wp;
  vec2 v = R * vel;
  float t = uTime / period + phase;
  float t0 = fract(t);
  float t1 = fract(t + 0.5);
  vec2 uv = p * sc;
  vec4 a = texture2D(uRipple, uv - v * (t0 * period) * sc);
  vec4 b = texture2D(uRipple, uv - v * (t1 * period) * sc + vec2(0.37, 0.19));
  vec4 m = mix(a, b, abs(0.5 - t0) * 2.0);
  crest = m.w;
  vec2 n = (m.xy * 2.0 - 1.0) * (sc / max(sc.x, sc.y)) * uRippleNorm;
  return vec2(rot.x * n.x + rot.y * n.y, -rot.y * n.x + rot.x * n.y);   // R^-1 * n
}




void main() {
  /* ------------------------------------------------- depth & shoreline gate */
  float dStatic = texture2D(uDepthTex, (vBase + uWorld.x) / (2.0 * uWorld.x)).r;
  float d = dStatic + (vWorld.y - vSurfY);
  if (d <= 0.0) discard;
  /* Screen-space width of one depth unit: lets the waterline be antialiased
     analytically, at a constant ~1.5 px, at any distance and on any bed slope. */
  float aaW = max(fwidth(d) * 1.5, 0.012);

  /* Horizontal distance to the waterline, from the gradient of the depth field.
     Everything at the margin keys off THIS, not off depth: a lake on a
     one-in-forty shelf is under half a metre of water for eighty metres, and a
     depth-thresholded foam band there paints a white ribbon the width of a road. */
  float texel = 2.0 * uWorld.x / uWorld.y;
  vec2 huv = vec2(texel, 0.0) / (2.0 * uWorld.x);
  vec2 buv = (vBase + uWorld.x) / (2.0 * uWorld.x);
  float dxp = texture2D(uDepthTex, buv + huv.xy).r;
  float dxm = texture2D(uDepthTex, buv - huv.xy).r;
  float dzp = texture2D(uDepthTex, buv + huv.yx).r;
  float dzm = texture2D(uDepthTex, buv - huv.yx).r;
  vec2 bedGrad = vec2(dxp - dxm, dzp - dzm) / (2.0 * texel);
  float bedSlope = max(length(bedGrad), 0.002);
  float shoreDist = d / bedSlope;

  bool under = !gl_FrontFacing;

  vec3 V = uCamPosW - vWorld;
  float viewLen = max(length(V), 1e-4);
  V /= viewLen;

  /* ============================ SURFACE NORMAL ============================ */
  vec2 fdir = vFlow.xy;
  float riverness = clamp(vFlow.w, 0.0, 1.0);
  float fspeed = clamp(vFlow.z, 0.0, 1.0);

  // Surface velocity in metres/second. Lakes drift with the wind; rivers run.
  vec2 windDir = normalize(vec2(uWave.z, uWave.w) + vec2(1e-4, 0.0));
  vec2 vel = mix(windDir * (0.10 + 0.05 * uWindSpeed),
                 fdir * (0.5 + 2.6 * fspeed), riverness);

  /* NORMAL LOD.
     "foot" is the world-space size of one screen pixel ON THIS SURFACE, which at
     a grazing angle is far larger than the distance alone suggests. A band whose
     wavelength is under ~2.5 footprints cannot be resolved: drawing it anyway is
     what produces the constant-frequency streaks that run unchanged from the near
     bank to the far one, and the shimmer that no amount of TAA can settle. Each
     band is faded out over its own threshold, and the variance it takes with it
     is handed to the specular lobe as roughness. */
  float px = vDist * uSurfTune.z;                        // metres per pixel, head-on
  float foot = px / clamp(abs(V.y), 0.05, 1.0);          // stretched by grazing
  float grazeFade = 1.0;

  /* Rivers sample in the flow frame (mildly stretched downstream); still water
     samples in three fixed, mutually rotated frames so the map never repeats. */
  vec2 fRot = riverness > 0.02 ? normalize(fdir + vec2(1e-5, 0.0)) : vec2(1.0, 0.0);
  vec2 rotA = mix(vec2(1.0, 0.0), fRot, riverness * 0.75);
  vec2 rotB = mix(vec2(0.7547, 0.6561), fRot, riverness * 0.75);
  vec2 rotC = mix(vec2(0.3907, -0.9205), fRot, riverness * 0.75);
  vec2 rotD = mix(vec2(-0.5878, 0.8090), fRot, riverness * 0.75);
  /* Mild along-flow stretch only. Pass 3's first cut stretched the 27 m band to
     41 m along the current, and the ripple map's own directional trains then
     read as forty-metre brush strokes combed down the river — the "hand-painted
     streak noise" the forensic examiner named, made worse rather than better. */
  float str = mix(1.0, 0.84, riverness);

  float chop = 0.45 + 0.55 * clamp(uWindSpeed / 7.0, 0.0, 1.0);
  chop = mix(chop, 1.0, riverness * 0.75);

  /* wavelength (m), slope weight, period (s), phase, frame.
     Deliberately non-harmonic so no two bands ever line up into a motif, and
     weighted so the ENERGY sits in the 1-3 m bands: that is the scale a viewer
     reads as water. Long bands carry only enough slope to bend the reflection. */
  const float L0 = 27.0, L1 = 6.1, L2 = 2.4, L3 = 0.95, L4 = 0.36;
  float w0 = 0.024;
  float w1 = 0.052 * (0.6 + 0.4 * chop);
  float w2 = 0.115 * chop;
  float w3 = 0.132 * chop;
  float w4 = 0.105 * chop;

  /* band gate: 1 when the wavelength is comfortably resolvable, 0 when it is not */
  float g0 = smoothstep(0.7, 2.2, L0 / max(foot, 1e-3));
  float g1 = smoothstep(0.7, 2.2, L1 / max(foot, 1e-3));
  float g2 = smoothstep(0.7, 2.2, L2 / max(foot, 1e-3));
  float g3 = smoothstep(0.7, 2.2, L3 / max(foot, 1e-3));
  float g4 = smoothstep(0.7, 2.2, L4 / max(foot, 1e-3));

  float cr0, cr1, cr2, cr3, cr4;
  vec2 nxy = vec2(0.0);
  float crest = 0.0;
  if (g0 > 0.002) { nxy += w0 * g0 * rsFlowSlope(vBase, vel, vec2(str / L0, 1.0 / L0), 13.0, 0.13, rotC, cr0); }
  if (g1 > 0.002) { nxy += w1 * g1 * rsFlowSlope(vBase, vel, vec2(str / L1, 1.0 / L1),  6.5, 0.00, rotA, cr1); }
  if (g2 > 0.002) { nxy += w2 * g2 * rsFlowSlope(vBase, vel, vec2(str / L2, 1.0 / L2),  3.1, 0.31, rotD, cr2); crest = cr2; }
  if (g3 > 0.002) { nxy += w3 * g3 * rsFlowSlope(vBase, vel, vec2(str / L3, 1.0 / L3),  1.7, 0.67, rotB, cr3); crest = max(crest, cr3); }
  if (g4 > 0.002) { nxy += w4 * g4 * rsFlowSlope(vBase, vel, vec2(str / L4, 1.0 / L4),  0.9, 0.41, rotC, cr4); }

  /* Patchiness: real water is never uniformly rippled. Cat's paws of wind and
     the shear lines of the current leave slicks between the textured bands, and
     that low-frequency modulation is most of what separates a water surface from
     a tiled normal map. */
  vec2 patchUv = vBase * 0.019 - vel * uTime * 0.02;
  float slick = 0.55 + 1.05 * texture2D(uFoamTex, patchUv).a
                     * (0.45 + 0.75 * texture2D(uFoamTex, patchUv * 3.1 + 0.37).b);
  nxy *= clamp(slick, 0.45, 1.65) * uSurfTune.x;
  // Ripples cannot be taller than the water is deep, and they flatten in the
  // last handspan of the shore where the water is a film over sand.
  nxy *= clamp(d * 2.2, 0.20, 1.0);

  /* The variance the LOD gate just threw away. Fed to the specular roughness so
     the retired geometry comes back as a widened, broken glitter path rather
     than disappearing into a polished mirror. */
  float lost = w0 * w0 * (1.0 - g0) + w1 * w1 * (1.0 - g1) + w2 * w2 * (1.0 - g2)
             + w3 * w3 * (1.0 - g3) + w4 * w4 * (1.0 - g4);
  lost *= clamp(slick, 0.45, 1.65) * uSurfTune.x;

  vec2 gsl = rsGerstnerSlope(vBase, vAmp, foot);
  vec3 vWaveN = normalize(vec3(-gsl.x, 1.0, -gsl.y));

  vec3 N = normalize(vec3(vWaveN.x + nxy.x, vWaveN.y, vWaveN.z + nxy.y));
  if (under) N = -N;

  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float sunUp = clamp(uSunDirW.y, 0.0, 1.0);
  float sunVis = rsWaterSunVis(vWorld, N);

  /* =========================== AERIAL BOOKKEEPING ========================= */
  /* The grabbed buffer is the scene AS SEEN FROM THE CAMERA — it already has
     haze baked into it. Composite in surface-radiance space and apply the haze
     exactly once at the end; otherwise the refraction and the screen-space
     reflection get veiled twice, which is the single largest reason this surface
     read as opaque pale blue. */
  vec3 Tair = clamp(rsAerialTransmittance(vWorld), vec3(0.02), vec3(1.0));
  vec3 inscat = rsApplyAerialPerspective(vec3(0.0), vWorld);
  vec3 invT = 1.0 / Tair;

  /* ============================== REFRACTION ============================== */
  vec2 screenUv = gl_FragCoord.xy * uGrabTexel;
  // Offset scaled by depth: at the waterline it collapses to zero, so the grab
  // returns exactly the bank pixel behind us and the edge simply disappears.
  float offScale = uTune.x * clamp(d * 1.6, 0.10, 1.0) / (1.0 + vDist * 0.03);
  vec2 rUv = clamp(screenUv + N.xz * offScale, uGrabTexel * 1.5, vec2(1.0) - uGrabTexel * 1.5);
  vec3 grabRefr = mix(vec3(0.19, 0.170, 0.130), texture2D(uGrab, rUv).rgb, uUseGrab);
  vec3 bedRad = max((grabRefr - inscat) * invT, vec3(0.0));

  /* caustics on the bed — only where the sun can reach it */
  if (uTune.z > 0.001 && d < 8.0 && sunUp > 0.02) {
    vec2 cp = vBase + N.xz * d * 1.5 - vel * uTime * 0.35;
    float ct = uTime * 0.12;
    vec3 c1 = texture2D(uCausticTex, cp * 0.075 + vec2(ct, ct * 0.63)).rgb;
    vec3 c2 = texture2D(uCausticTex, cp * 0.118 - vec2(ct * 0.81, ct * 0.44)).rgb;
    vec3 caust = c1 * c2 * 2.0;
    // Caustics are focused SUNLIGHT: only as strong as the sun, dying with depth.
    float k = uTune.z * 0.9 * exp(-d * 0.42) * sunUp * sunVis * smoothstep(0.0, 0.25, d);
    bedRad *= 1.0 + caust * k;
  }

  /* ------------------------------------------------- Beer-Lambert through d */
  // Slant path: a grazing view looks through far more water than the depth.
  float slant = 1.0 / max(abs(V.y), 0.10);
  float path = min(d * (1.0 + slant * 0.55), 26.0);
  vec3 Tw = exp(-uAbsorb * path);
  vec3 bodyLight = uScatter * (uSunRad * (0.10 + 0.30 * sunUp) * mix(0.40, 1.0, sunVis)
                             + uAmbient * 0.95);
  vec3 refracted = bedRad * Tw + bodyLight * (vec3(1.0) - Tw);

  /* ============================== REFLECTION ==============================
     SCREEN-SPACE ENVIRONMENT REFLECTION.

     There is no depth buffer available here — the water draws INSIDE the scene
     pass, so PostFX's depth attachment is the very buffer being written and
     cannot be sampled. A screen-marched SSR is therefore off the table, and the
     world-space heightfield march this shader used instead could only ever
     return bare ground: it knows nothing about the trees, buildings, boulders
     or the mesas standing on the bank, which is most of what a river actually
     reflects.

     So reflect the DIRECTION instead of the point. For a reflected ray R, the
     radiance arriving along it is, to the accuracy of the parallax between the
     camera and the water point, the radiance the camera itself sees along R —
     and that is one texture fetch into the grabbed colour buffer at the screen
     position of the direction R. It returns the real shaded far bank, its
     trees, the ranges behind it, the clouds and the sky, all correctly lit,
     shadowed and hazed, distorted by the wave normal exactly as they should be.
     The approximation is exact at infinity and degrades with 1/distance-to-
     reflector, which is precisely the regime where the Fresnel weight is
     smallest, so the error is self-masking.

     The sky-view LUT stays as the fallback wherever R projects off-screen. */
  /* Grazing reflection is violently sensitive to the normal: a six-degree facet
     swings the reflected ray twelve degrees, so at two degrees of incidence the
     sample leaps from the far bank to the zenith and back between neighbouring
     pixels. Real water does that too — but at a spatial frequency far below one
     pixel, so what a camera records is a reflection SMEARED vertically, not
     chopped into blocks. Damp the perturbation on the reflection ray by the
     incidence angle, and put the energy back as a vertical blur across the
     sample instead. */
  float rk = mix(0.30, 1.0, smoothstep(0.02, 0.34, NdV));
  vec3 Nr = normalize(vec3(vWaveN.x + nxy.x * rk, vWaveN.y, vWaveN.z + nxy.y * rk));
  if (under) Nr = -Nr;
  vec3 R = reflect(-V, Nr);
  R.y = max(R.y, 0.0025);                      // never sample below the horizon
  R = normalize(R);
  vec3 sky = rsSampleSkyRadiance(R);
  vec3 reflRad = sky;

  float f0 = 0.02;
  float fres = f0 + (1.0 - f0) * pow(1.0 - NdV, 5.0);
  vec3 ssrDbg = vec3(0.0);

  if (!under && uUseGrab > 0.5 && uSurfTune.y > 0.01 && fres > 0.030) {
    /* The fragment's own NDC is known from gl_FragCoord, so the projection is
       expressed as a DIFFERENCE from it — the TAA sub-pixel jitter and the
       principal-point offset both cancel, without needing the projection matrix
       in the fragment stage (three does not declare it there). */
    vec3 vsF = (viewMatrix * vec4(vWorld, 1.0)).xyz;
    float wF = max(-vsF.z, 1e-3);
    vec2 off = (screenUv * 2.0 - 1.0) - vProj * vec2(vsF.x, vsF.y) / wF;

    vec3 dv = (viewMatrix * vec4(R, 0.0)).xyz;
    float dw = -dv.z;
    if (dw > 0.05) {
      vec2 uvR = (vProj * vec2(dv.x, dv.y) / dw + off) * 0.5 + 0.5;
      vec2 e = min(uvR, vec2(1.0) - uvR);
      float ok = smoothstep(0.0, 0.055, min(e.x, e.y)) * uSurfTune.y;
      if (ok > 0.002) {
        /* Vertical smear: three taps spread along screen-Y by the sub-pixel
           slope the LOD gate retired plus the grazing anisotropy. This is the
           whole difference between a reflection that reads as water and one
           that reads as a photograph pasted upside down. */
        float sm = (0.30 * length(nxy) + 0.45 * sqrt(max(lost, 0.0)) + 0.0018)
                 * (0.5 + 1.4 * (1.0 - NdV)) * 0.40;
        sm = min(sm, 0.013);
        vec3 s;
        if (sm > uGrabTexel.y * 1.5) {
          s = texture2D(uGrab, clamp(uvR, vec2(0.004), vec2(0.996))).rgb * 0.5
            + texture2D(uGrab, clamp(uvR + vec2(0.0, sm), vec2(0.004), vec2(0.996))).rgb * 0.25
            + texture2D(uGrab, clamp(uvR - vec2(0.0, sm), vec2(0.004), vec2(0.996))).rgb * 0.25;
        } else {
          // sub-pixel smear: bilinear already did it, do not pay for two taps
          s = texture2D(uGrab, clamp(uvR, vec2(0.004), vec2(0.996))).rgb;
        }
        reflRad = mix(sky, max((s - inscat) * invT, vec3(0.0)), ok);
        ssrDbg = vec3(ok, sm * 12.0, 0.0);
      }
    }
  }

  if (under) {
    // From below: Snell's window. Past the critical angle the surface becomes a
    // mirror looking back into the water body.
    vec3 rf = refract(-V, N, 1.0 / 1.333);
    if (dot(rf, rf) < 1e-5) {
      reflRad = bodyLight * 2.4;
      fres = 1.0;
    } else {
      reflRad = rsSampleSkyRadiance(normalize(rf));
      fres = 1.0 - pow(1.0 - NdV, 4.0) * 0.55;
    }
  }

  vec3 col = mix(refracted, reflRad, clamp(fres, 0.0, 1.0));

  /* ============================= SUN GLITTER ============================== */
  if (!under && sunUp > 0.004 && sunVis > 0.01) {
    vec3 Hv = normalize(uSunDirW + V);
    float NdH = max(dot(N, Hv), 0.0);
    float NdL = max(dot(N, uSunDirW), 0.0);
    float VdH = max(dot(V, Hv), 0.0);
    /* Toksvig: everything the footprint gate retired is variance the lobe has to
       carry. This is what turns a distant sun track into a broken sparkle path
       instead of either a mirror or a solid clipped sheet. */
    float rough = clamp(sqrt(0.0022 + lost * 5.5), 0.035, 0.36);
    float a = rough * rough;
    float a2 = a * a;
    float dnm = NdH * NdH * (a2 - 1.0) + 1.0;
    float Dg = a2 / max(RSW_PI * dnm * dnm, 1e-7);
    // height-correlated Smith visibility (Heitz), already divided by 4 NdL NdV
    float gv = NdL * sqrt(NdV * NdV * (1.0 - a2) + a2);
    float gl = NdV * sqrt(NdL * NdL * (1.0 - a2) + a2);
    float Vis = 0.5 / max(gv + gl, 1e-5);
    float Fs = f0 + (1.0 - f0) * pow(1.0 - VdH, 5.0);
    // crest gating: troughs do not spark
    float sparkle = 0.45 + 1.15 * crest;
    float spec = Dg * Vis * NdL * Fs * sparkle * uTune.w;
    col += uSunRad * min(spec, 5.0);
  }

  float foamDbg = 0.0;
  /* ================================= FOAM ================================= */
  /* A calm river bank carries almost NO foam: what it carries is a couple of
     handspans of broken lace where the last of the run-up drains back, plus
     whatever the current tears up over a shallow steep bed. Pass 3's first
     attempt painted a two-metre solid white ribbon along every waterline in the
     world, which reads as snow. The reach is now measured in tens of
     centimetres, it is gated by how much energy is actually arriving, and the
     opacity is capped well short of paper white. */
  if (!under && uTune.y > 0.001) {
    vec2 drift = vel * uTime;
    vec4 fa = texture2D(uFoamTex, vBase * 0.30 - drift * 0.07);
    vec4 fb = texture2D(uFoamTex, vBase * 0.95 - drift * 0.19 + vec2(0.31, 0.77));
    float lace = clamp(fa.r * 0.62 + fb.g * 0.72, 0.0, 1.4);
    float breath = 0.5 + 0.5 * sin(uTime * 0.75 - shoreDist * 0.55
                                   + vBase.x * 0.05 + vBase.y * 0.037);

    // energy arriving at the margin: wind chop plus whatever the current carries
    float energy = clamp(uWindSpeed / 9.0, 0.0, 1.0) * 0.55
                 + riverness * fspeed * 0.9
                 + clamp(uWave.x * 2.2, 0.0, 0.5);

    /* 1. shoreline — a run-up lace whose reach breathes with the swell.
       Measured from the VISIBLE waterline: everything under the composite's
       depth floor is faded out to wet ground, so a band anchored at d = 0 lands
       entirely inside the invisible strip and never appears. */
    float shoreRef = max(shoreDist - 0.13 / bedSlope, 0.0);
    float reach = mix(0.60, 2.20, breath) * (0.40 + 1.1 * clamp(energy, 0.0, 1.0));
    float band = 1.0 - smoothstep(0.0, max(reach, 0.05), shoreRef);
    // erode the band from the outside with the lace so the edge is ragged and
    // never resolves into the painted white outline a depth threshold gives
    float shore = smoothstep(0.16, 0.82, band * 1.55 - (1.0 - lace) * 1.30)
                * smoothstep(0.05, 0.35, energy);

    // 2. whitewater — fast water over a steep, shallow bed (rapids, obstacles)
    float rapids = smoothstep(0.32, 0.88, fspeed) * riverness
                 * smoothstep(1.8, 0.15, d) * smoothstep(0.26, 0.80, lace)
                 * smoothstep(0.05, 0.26, bedSlope);

    // 3. spume on the wave crests, but only when it is genuinely blowing
    float steep = (1.0 - clamp(vWaveN.y, 0.0, 1.0)) * 26.0;
    float crestFoam = smoothstep(0.55, 1.0, steep)
                    * smoothstep(6.0, 13.0, uWindSpeed) * lace * 0.4;

    float foam = clamp(max(max(shore, rapids), crestFoam) * uTune.y, 0.0, 0.62);
    foamDbg = foam;
    if (foam > 0.002) {
      /* Lit as a 0.8-albedo Lambert half-space: bright, but inside the filmic
         shoulder rather than clipped to paper. Wet foam over a dark bed is also
         partly transparent, so it is mixed rather than replacing. */
      float ndl = max(uSunDirW.y, 0.0);
      vec3 foamCol = uFoamTint * (uSunRad * ndl * mix(0.30, 1.0, sunVis) * 0.31831
                                + uAmbient * 0.55);
      col = mix(col, foamCol, foam);
    }
  }

  /* ================================ OUTPUT ================================ */
  col = col * Tair + inscat;

  if (uDebug > 0.5) {
    vec3 dbg = vec3(0.0);
    if (uDebug < 1.5)      dbg = vec3(fres);
    else if (uDebug < 2.5) dbg = vec3(length(nxy) * 4.0);
    else if (uDebug < 3.5) dbg = vec3(NdV);
    else if (uDebug < 4.5) dbg = refracted;
    else if (uDebug < 5.5) dbg = reflRad;
    else if (uDebug < 6.5) dbg = vec3(min(d * 0.2, 1.0));
    else if (uDebug < 7.5) dbg = vec3(foot * 0.2);
    else if (uDebug < 8.5) dbg = bedRad;
    else if (uDebug < 9.5) dbg = ssrDbg;      // r = on-screen, g = ground weight
    else                   dbg = vec3(foamDbg);
    gl_FragColor = vec4(max(dbg, vec3(0.0)), 1.0);
    return;
  }

  /* Composite against the grabbed opaque frame ourselves rather than asking the
     blender to do it: the water still writes depth (so DOF, GTAO and the
     volumetrics all treat it as a real surface) and the waterline still gets a
     properly antialiased, sub-pixel edge. */
  if (uUseGrab > 0.5) {
    /* Two things at once. The fwidth term antialiases the waterline. The depth
       floor makes a sheet a few centimetres deep read as WET GROUND rather than
       as water: on a one-in-two-hundred bank the depth field legitimately puts a
       couple of centimetres across sixty metres of flat, and drawing that as
       opaque water paints a huge featureless mirror over the shore. */
    float edgeA = smoothstep(0.0, max(aaW, 0.13), d);
    col = mix(texture2D(uGrab, screenUv).rgb, col, edgeA);
  }
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

/**
 * Build the water surface material.
 * @param {object} o
 * @param {object} o.aerialUniforms shared Sky uniform block — refs, never clones
 * @param {string} o.aerialGLSL     Sky's rsApplyAerialPerspective chunk
 * @param {string} [o.shadowChunk]  Lighting's cascade sampler (optional)
 * @param {object} [o.shadowUniforms]
 */
export function makeWaterMaterial(o) {
  const uniforms = {
    uDepthTex: { value: null },
    uFlowTex: { value: null },
    uRipple: { value: null },
    uFoamTex: { value: null },
    uCausticTex: { value: null },
    uGrab: { value: null },
    uWorld: { value: new THREE.Vector4(4096, 2048, 1 / 2048, 0) },
    uGrabTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    uUseGrab: { value: 0 },
    uTime: { value: 0 },
    uCamPosW: { value: new THREE.Vector3() },
    uSunDirW: { value: new THREE.Vector3(0, 1, 0) },
    uSunRad: { value: new THREE.Vector3(1, 1, 1) },
    uAmbient: { value: new THREE.Vector3(0.2, 0.25, 0.35) },
    uAbsorb: { value: new THREE.Vector3(1.28, 0.86, 1.72) },
    uScatter: { value: new THREE.Vector3(0.094, 0.116, 0.086) },
    uFoamTint: { value: new THREE.Vector3(0.84, 0.845, 0.83) },
    uTune: { value: new THREE.Vector4(0.115, 1.0, 1.0, 1.0) },
    uWave: { value: new THREE.Vector4(0.16, 0.55, 1, 0) },
    uWindSpeed: { value: 3 },
    uSurfTune: { value: new THREE.Vector4(1.0, 0.95, 0.0022, 0) },
    uRippleNorm: { value: 8.0 },
    uDebug: { value: 0 },
  };
  Object.assign(uniforms, o.aerialUniforms);

  /* Lighting owns the cascade chunk and may legitimately change its shape (it
     has already gone from a scalar to a coloured shadow term once). Sniff the
     exact signature we know how to call, and simply do without shadows on the
     water rather than taking the whole surface down with a compile error. */
  const SIG = /\b(vec3|float)\s+rsCsmDirectionalShadow\s*\(\s*const\s+in\s+vec3\s+\w+\s*,\s*const\s+in\s+vec3\s+\w+\s*,\s*const\s+in\s+vec3\s+\w+\s*\)/;
  const sig = o.shadowChunk ? SIG.exec(o.shadowChunk) : null;
  const useCsm = !!(sig && o.shadowUniforms && o.shadowUniforms.rsCsmShadowMap
    && o.shadowUniforms.rsCsmKeyDir);
  if (useCsm) Object.assign(uniforms, o.shadowUniforms);

  const defines = {};
  if (useCsm) {
    defines.RS_WATER_CSM = 1;
    if (sig[1] === 'vec3') defines.RS_WATER_CSM_VEC3 = 1;
  }

  const frag = (useCsm ? o.shadowChunk : '') + o.aerialGLSL + FRAG_BODY;

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: frag,
    defines,
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    fog: false,
  });
  mat.userData.rsNoAerial = true;      // we call the chunk ourselves
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -1.0;
  mat.polygonOffsetUnits = -2.0;
  return mat;
}
