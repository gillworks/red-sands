/**
 * Particle shaders.
 *
 *  FIELD_*   stateless GPU-simulated volume fields (rain, snow, motes). Every
 *            particle's position is an analytic function of its seed and the
 *            clock, wrapped into a box that follows the camera, so the CPU
 *            never touches a vertex and the field is instantly "full" the
 *            moment weather changes — no warm-up, which matters because the
 *            capture harness only gives the world 2.5 s to settle.
 *  POOL_*    CPU-simulated pool for events: splashes, embers, smoke, dust
 *            kicked up by hooves, muzzle flashes, fireflies, breath, leaves.
 *  LENS_*    screen-space rain on the lens.
 *
 * Shared traits: soft-particle depth fade against a copy of the scene depth
 * buffer, wrap-diffuse + Henyey-Greenstein forward scatter from ctx.env so
 * everything is genuinely lit by the sun/moon (and goes warm and rim-lit at
 * golden hour), and aerial perspective from Sky.
 */

/* -------------------------------------------------------------- common ---- */

export const PARTICLE_COMMON = /* glsl */`
uniform sampler2D uDepth;
uniform vec4  uDepthParams;   // x = near, y = far, z = 1/width, w = 1/height
uniform float uSoftness;      // metres over which a particle fades into geometry

uniform vec3  uSunDir;
uniform vec3  uSunCol;        // linear HDR radiance
uniform vec3  uSkyCol;
uniform vec3  uGroundCol;

float rsLinearDepth(float d) {
  float n = uDepthParams.x, f = uDepthParams.y;
  float z = d * 2.0 - 1.0;
  return (2.0 * n * f) / (f + n - z * (f - n));
}

/** 0 where the particle is buried in geometry, 1 where it is in free air. */
float rsSoftFade(vec2 screenUv, float viewZ) {
  float d = texture2D(uDepth, screenUv).x;
  if (d >= 0.999999) return 1.0;
  float scene = rsLinearDepth(d);
  return clamp((scene - viewZ) / max(uSoftness, 0.01), 0.0, 1.0);
}

float rsHG(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}

/**
 * Light a particle. n is a fake spherical normal from the billboard uv, so
 * a puff shades like a little ball; cosT is view-vs-sun for the forward
 * scattering lobe that makes dust and mist glow when you look into the light.
 */
uniform float uPhaseGain;

vec3 rsLightParticle(vec3 n, float cosT, float thickness, vec3 albedo) {
  float wrap = dot(n, uSunDir) * 0.5 + 0.5;
  // thick puffs shadow themselves: the lit rim survives, the core goes ambient
  float through = exp(-thickness * 1.6);
  float phase = mix(1.0, min(rsHG(cosT, 0.55), 3.0), 0.55 * uPhaseGain);
  vec3 direct = uSunCol * (0.18 + 0.82 * wrap) * phase * (0.35 + 0.65 * through);
  vec3 ambient = mix(uGroundCol, uSkyCol, n.y * 0.5 + 0.5);
  return albedo * (direct + ambient);
}
`;

/* ---------------------------------------------------------------- fields -- */

export const FIELD_VERT = /* glsl */`
precision highp float;

attribute vec4 aSeed;         // 4 uncorrelated randoms in 0..1

uniform vec3  uBox;           // half extents of the wrapping volume
uniform float uTime;
uniform vec3  uWind;
uniform float uDensity;       // 0..1 fraction of the pool that is alive
uniform float uSize;
uniform float uFall;
uniform float uStretch;
uniform float uYOffset;
uniform float uAspect;        // width/length of a streak

varying vec2  vUv;
varying float vAlpha;
varying vec3  vWorld;
varying vec3  vNormal;
varying float vSeed;

void main() {
  vUv = uv;
  vSeed = aSeed.w;

  if (aSeed.w > uDensity) {
    // parked off-screen; the rasteriser throws it away for free
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    vWorld = vec3(0.0);
    vNormal = vec3(0.0, 0.0, 1.0);
    return;
  }

  vec3 box2 = uBox * 2.0;
  vec3 p0 = aSeed.xyz * box2;

  vec3 vel;
#ifdef MODE_RAIN
  vel = vec3(uWind.x, -uFall, uWind.z);
  vec3 p = p0 + vel * uTime;
#endif
#ifdef MODE_SNOW
  // tumbling: a flake does not fall, it wanders down
  float t = uTime * (0.6 + aSeed.w * 0.8);
  vel = vec3(uWind.x * 0.9, -uFall, uWind.z * 0.9);
  vec3 p = p0 + vel * uTime;
  p.x += sin(t * 1.7 + aSeed.x * 31.0) * 0.55;
  p.z += cos(t * 1.35 + aSeed.z * 27.0) * 0.55;
  p.y += sin(t * 2.6 + aSeed.y * 19.0) * 0.10;
#endif
#ifdef MODE_MOTE
  // ambient motes: near-neutral buoyancy, pushed about by the same wind
  float t = uTime * (0.25 + aSeed.w * 0.5);
  vel = vec3(uWind.x * 0.30, -uFall, uWind.z * 0.30);
  vec3 p = p0 + vel * uTime;
  p.x += sin(t * 0.9 + aSeed.x * 41.0) * 1.6;
  p.y += sin(t * 0.7 + aSeed.y * 23.0) * 0.9;
  p.z += cos(t * 1.1 + aSeed.z * 37.0) * 1.6;
#endif

  vec3 centre = cameraPosition + vec3(0.0, uYOffset, 0.0);
  p = mod(p - centre + uBox, box2) + centre - uBox;

  vec3 toCam = cameraPosition - p;
  float dist = length(toCam);
  vec3 vdir = toCam / max(dist, 1e-3);

  float sz = uSize * (0.65 + aSeed.x * 0.75);

#ifdef MODE_RAIN
  // velocity-stretched streak, aligned with the drop's actual motion
  vec3 dirV = normalize(vel);
  vec3 side = normalize(cross(dirV, vdir));
  float len = sz * uStretch;
  vec3 world = p + side * (position.x * sz * uAspect) + dirV * (position.y * len);
  vNormal = vdir;
#else
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), vdir));
  vec3 up = cross(vdir, right);
  #ifdef MODE_SNOW
    float rot = uTime * (0.8 + aSeed.z * 2.4) + aSeed.y * 6.28;
    float cr = cos(rot), sr = sin(rot);
    vec2 q = vec2(position.x * cr - position.y * sr, position.x * sr + position.y * cr);
  #else
    vec2 q = position.xy;
  #endif
  vec3 world = p + right * (q.x * sz) + up * (q.y * sz);
  // fake spherical normal so a mote/flake shades like a ball
  vNormal = normalize(vdir + right * (q.x * 1.4) + up * (q.y * 1.4));
#endif

  vWorld = world;

  float a = 1.0;
  // never let a particle balloon across the lens
  a *= smoothstep(0.20, 1.10, dist);
  // dissolve at the edge of the wrapping volume instead of popping
  vec3 rel = abs(world - centre) / uBox;
  a *= 1.0 - smoothstep(0.70, 1.0, max(rel.x, max(rel.y * 0.85, rel.z)));
  vAlpha = a;

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

export const FIELD_FRAG = /* glsl */`
${PARTICLE_COMMON}

uniform sampler2D uAtlas;
uniform vec4  uTile;          // xy = scale, zw = offset into the atlas
uniform vec3  uTint;
uniform float uOpacity;
uniform float uEmissive;

varying vec2  vUv;
varying float vAlpha;
varying vec3  vWorld;
varying vec3  vNormal;
varying float vSeed;

void main() {
  if (vAlpha <= 0.001) discard;
  vec4 tex = texture2D(uAtlas, vUv * uTile.xy + uTile.zw);
  float a = tex.a * vAlpha * uOpacity;
  if (a < 0.002) discard;

  vec4 vp = viewMatrix * vec4(vWorld, 1.0);
  float viewZ = -vp.z;
  vec2 suv = gl_FragCoord.xy * uDepthParams.zw;
  a *= rsSoftFade(suv, viewZ);
  if (a < 0.002) discard;

  vec3 V = normalize(cameraPosition - vWorld);
  float cosT = dot(-V, uSunDir);
  vec3 col = rsLightParticle(vNormal, cosT, 0.35, uTint);
  col += uTint * uEmissive;

#ifdef RS_HAS_AERIAL
  col = rsApplyAerialPerspective(col, vWorld);
#endif

  gl_FragColor = vec4(col * a, a);
}
`;

/* ----------------------------------------------------------------- pool --- */

export const POOL_VERT = /* glsl */`
precision highp float;

attribute vec3 aPos;
attribute vec4 aParams;   // x = size, y = rotation, z = alpha, w = tile index
attribute vec4 aColor;    // rgb = tint, a = emissive

uniform float uStretchY;  // <1 squashes the billboard: flat sheets for mist

varying vec2  vUv;
varying float vAlpha;
varying vec3  vWorld;
varying vec3  vNormal;
varying vec4  vColor;
varying float vTile;

void main() {
  vUv = uv;
  vColor = aColor;
  vTile = aParams.w;

  if (aParams.z <= 0.001 || aParams.x <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0; vWorld = vec3(0.0); vNormal = vec3(0.0, 0.0, 1.0);
    return;
  }

  vec3 toCam = cameraPosition - aPos;
  float dist = length(toCam);
  vec3 vdir = toCam / max(dist, 1e-3);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), vdir));
  vec3 up = cross(vdir, right);

  float cr = cos(aParams.y), sr = sin(aParams.y);
  vec2 q = vec2(position.x * cr - position.y * sr, position.x * sr + position.y * cr);
  vec3 world = aPos + (right * q.x + up * q.y * uStretchY) * aParams.x;

  vWorld = world;
  vNormal = normalize(vdir + right * (q.x * 1.6) + up * (q.y * 1.6));
  vAlpha = aParams.z * smoothstep(0.10, 0.55, dist);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

export const POOL_FRAG = /* glsl */`
${PARTICLE_COMMON}

uniform sampler2D uAtlas;
uniform float uOpacity;

varying vec2  vUv;
varying float vAlpha;
varying vec3  vWorld;
varying vec3  vNormal;
varying vec4  vColor;
varying float vTile;

void main() {
  if (vAlpha <= 0.001) discard;
  // 2x2 atlas
  float ti = floor(vTile + 0.5);
  vec2 off = vec2(mod(ti, 2.0), floor(ti * 0.5)) * 0.5;
  vec4 tex = texture2D(uAtlas, vUv * 0.5 + off);
  float a = tex.a * vAlpha * uOpacity;
  if (a < 0.002) discard;

  vec4 vp = viewMatrix * vec4(vWorld, 1.0);
  float viewZ = -vp.z;
  vec2 suv = gl_FragCoord.xy * uDepthParams.zw;
  a *= rsSoftFade(suv, viewZ);
  if (a < 0.002) discard;

  vec3 V = normalize(cameraPosition - vWorld);
  float cosT = dot(-V, uSunDir);
  vec3 col = rsLightParticle(vNormal, cosT, 0.9, vColor.rgb);
  col += vColor.rgb * vColor.a;

#ifdef RS_HAS_AERIAL
  col = rsApplyAerialPerspective(col, vWorld);
#endif

  gl_FragColor = vec4(col * a, a);
}
`;

/* ------------------------------------------------------- rain on the lens - */

export const LENS_VERT = /* glsl */`
precision highp float;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const LENS_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;

uniform float uTime;
uniform float uAmount;      // 0..1 how wet the lens is
uniform vec2  uAspect;
uniform vec3  uSkyCol;
uniform vec3  uSunCol;
uniform float uDrift;       // sideways smear from camera motion / wind

float h21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

/**
 * One layer of droplets on a jittered lattice. Kept DELIBERATELY small: a
 * drop on a lens is a couple of millimetres across on a 35 mm frame, which is
 * a handful of pixels — anything bigger reads as a smeared texture overlay
 * rather than water, and is the fastest way to make a frame look like a mod.
 */
vec2 dropLayer(vec2 uv, float cell, float t, float seed) {
  vec2 g = uv * cell;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float best = 0.0;
  float bestR = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 cid = id + o;
      float r = h21(cid + seed);
      if (r < 0.80) continue;                   // most cells stay empty
      float r2 = h21(cid.yx + seed * 3.7);
      // heavy drops slide down and leave a thin trail
      float slide = fract(r2 * 7.13 + t * (0.06 + r * 0.22));
      vec2 c = o + vec2((r - 0.5) * 0.6 + uDrift * 0.25, (r2 - 0.5) * 0.5 - slide + 0.5);
      vec2 d = f - c;
      d.y *= 0.68;
      float rad = 0.06 + r * 0.10;
      float m = smoothstep(rad, rad * 0.25, length(d));
      if (m > best) { best = m; bestR = length(d) / max(rad, 1e-3); }
    }
  }
  return vec2(best, bestR);
}

void main() {
  if (uAmount < 0.004) discard;
  vec2 uv = (vUv - 0.5) * uAspect + 0.5;

  vec2 a = dropLayer(uv, 26.0, uTime, 1.0);
  vec2 b = dropLayer(uv, 44.0, uTime * 1.35, 7.3);

  float m = max(a.x, b.x * 0.8);
  if (m < 0.01) discard;
  float rn = a.x > b.x ? a.y : b.y;

  // a droplet is a tiny lens: it gathers the sky and goes dark at the rim
  float lens = 1.0 - smoothstep(0.45, 1.0, rn);
  vec3 col = uSkyCol * (0.25 + lens * 0.9) + uSunCol * lens * 0.6;
  // wettest at the edges of the frame, where nothing wipes it
  float edge = smoothstep(0.18, 0.95, length((vUv - 0.5) * vec2(1.0, 0.62)) * 2.0);
  float alpha = m * uAmount * (0.035 + edge * 0.17);
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

/* ------------------------------------------------------------ depth copy -- */

export const COPY_VERT = /* glsl */`
precision highp float;
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const COPY_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDepth;
uniform vec2 uTexel;
void main() {
  /* Half-res copy of the scene depth for soft particles. We take the FARTHEST
   * of the four source texels: a particle that fades slightly late against a
   * thin silhouette is invisible, one that fades early leaves a halo. */
  float d = texture2D(tDepth, vUv).x;
  d = max(d, texture2D(tDepth, vUv + vec2( uTexel.x, 0.0)).x);
  d = max(d, texture2D(tDepth, vUv + vec2(0.0,  uTexel.y)).x);
  d = max(d, texture2D(tDepth, vUv + uTexel).x);
  gl_FragColor = vec4(d, d, d, 1.0);
}
`;
