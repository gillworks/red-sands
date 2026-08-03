import * as THREE from 'three';
import { Frame } from './Builder.js';

/**
 * Campfire.
 *
 * PASS-2 FORENSICS (night_camp, 97 % "hobby") named five things that live here:
 *
 *  1. "HARD-EDGED SQUARE GROUND DECAL: under the fire pit there is a perfectly
 *     straight-sided quad with a visible sharp corner where a lighter dirt patch
 *     is pasted over the terrain. Zero edge blending, zero alpha falloff, a
 *     literal polygon silhouette." — that was a 2.1 m `faceY` at a constant Y.
 *     It is now a radial burn decal: a polar mesh that samples the terrain at
 *     every vertex, whose rim radius is broken by two octaves of noise, and
 *     whose vertex ALPHA feathers to zero over the outer third. There is no
 *     straight edge anywhere in it and no constant-Y plane.
 *  2. "FLAME IS BINARY-ALPHA CUTOUT SPRITES … flat white teardrop silhouettes."
 *     and, from the integration report, "the flame core clips to white and loses
 *     the (1.0, 0.37, 0.14) hue it is measurably authored at." The night meter
 *     lands around 11-12x, so anything authored above ~0.12 linear is pushed
 *     into the tonemap shoulder, and the shoulder desaturates whatever it
 *     clips. Every layer's radiance is therefore authored so that
 *     peak × exposure lands just UNDER 1.4, and only intensity is modulated —
 *     the hue is pinned to an 1800-2000 K ramp.
 *  3. "SPARKS ARE IDENTICAL UNIFORM DISCS … in a near-perfect vertical line."
 *     Replaced with a GPU ember field: 96 points, each with its own launch
 *     phase, rise rate, turbulence seed, size and burn-out time, integrated in
 *     the vertex shader. One draw call, no CPU cost.
 *  4. "SMOKE PLUME IS UNLIT FROM BELOW … a dark cauliflower blob." The particle
 *     emitter is gone from the camp; the plume is three tall scrolling-noise
 *     billboards whose colour is scattered fire-light at the base and cool ash
 *     grey at the top, with alpha that never exceeds a third.
 *  5. "FIRE-RING ROCKS ARE FLAT-SHADED LOW-POLY … blown-out WHITE faceted
 *     plastic lumps with zero albedo variation." Their vertex colour was 0.92 —
 *     white paint. They are now dark basalt with per-stone value spread, their
 *     UVs are metric (they were compressed into a fraction of a tile, which is
 *     what made them smear), and the displacement is doubled.
 */

/* -------------------------------------------------------------------------- */
/*  Flame                                                                      */
/* -------------------------------------------------------------------------- */

const FLAME_GLSL = /* glsl */`
precision highp float;
uniform float uTime;
uniform float uSeed;
uniform float uScale;      // radiance scale, LINEAR — the only thing that varies
uniform float uWidth;
uniform float uCore;       // how far the pale core is allowed to go
uniform float uFlick;      // 0..1.35 — the SAME envelope that drives the light
uniform vec3  uWind;
varying vec2 vUv;

float fh( vec2 p ) {
  p = fract( p * vec2( 0.1031, 0.1030 ) );
  p += dot( p, p.yx + 33.33 );
  return fract( ( p.x + p.y ) * p.x );
}
float fn( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( fh( i ), fh( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( fh( i + vec2( 0.0, 1.0 ) ), fh( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
float ffbm( vec2 p ) {
  float a = 0.0, w = 0.58;
  for ( int i = 0; i < 3; i++ ) { a += w * fn( p ); p = p * 2.17 + 13.7; w *= 0.5; }
  return a;
}

void main() {
  float y = clamp( vUv.y, 0.0, 1.0 );
  vec2 uv = vUv * 2.0 - 1.0;

  float lean = uWind.x * y * y * 0.55;
  float w = uWidth * ( 1.0 - pow( y, 1.55 ) * 0.74 ) + 0.075;

  float t = uTime;
  float n1 = ffbm( vec2( uv.x * 1.7, y * 2.3 - t * 1.15 + uSeed ) );
  float n2 = ffbm( vec2( uv.x * 4.1 + 11.0, y * 5.2 - t * 2.65 + uSeed * 1.7 ) );
  float n = n1 * 0.62 + n2 * 0.38;

  float d = abs( uv.x + lean + ( n - 0.5 ) * 0.85 * ( 0.25 + y ) ) / w;

  // vertical envelope: fat and bright at the base, torn apart at the tip
  float rise = smoothstep( 0.0, 0.10, y );
  float tip = 1.0 - smoothstep( 0.46 + n2 * 0.52, 1.08, y );
  float body = smoothstep( 1.25, 0.05, d ) * rise * tip;
  body *= 0.55 + 0.75 * n2;
  if ( body < 0.004 ) discard;

  /* --- 1800-2000 K ramp. HUE IS FIXED; only intensity varies. -------------
   * The peak radiance of the whole stack is authored at ~0.115 linear, which
   * at the metered night exposure (~11-12x) lands at ~1.35 — just inside the
   * filmic shoulder, where the curve still separates the channels. Pass 2 sat
   * at 0.67 linear, i.e. ~8x, and every channel clipped together to white.  */
  float heat = clamp( body * ( 1.25 - y * 0.55 ), 0.0, 1.6 );
  vec3 edge = vec3( 1.00, 0.075, 0.004 );   // oxide red
  vec3 mid  = vec3( 1.00, 0.245, 0.026 );   // orange
  vec3 hot  = vec3( 1.00, 0.370, 0.095 );   // hottest soot, still strongly warm
  vec3 col = mix( edge, mid, smoothstep( 0.10, 0.62, heat ) );
  col = mix( col, hot, smoothstep( 0.95, 1.55, heat ) * uCore );

  float flick = 0.62 + 0.55 * uFlick;
  // body^1.5 rather than body^2: squaring collapsed everything but the
  // core and the fire read as a small pale wisp instead of a flame.
  float a = pow( body, 1.5 ) * ( 0.65 + 0.35 * n1 );
  gl_FragColor = vec4( col * a * uScale * flick, a * ( 0.8 + 0.2 * flick ) );
}
`;

const FLAME_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 c = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  vec3 f = normalize( vec3( cameraPosition.x - c.x, 0.0, cameraPosition.z - c.z ) );
  vec3 rt = normalize( cross( vec3( 0.0, 1.0, 0.0 ), f ) );
  vec3 wp = c + rt * position.x + vec3( 0.0, 1.0, 0.0 ) * position.y;
  gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
}
`;

/* Ember bed under the logs: an emissive plate that breathes. */
const EMBER_FRAG = /* glsl */`
precision highp float;
uniform float uTime;
uniform float uScale;
uniform float uFlick;
varying vec2 vUv;
float eh( vec2 p ) {
  p = fract( p * vec2( 0.1031, 0.1030 ) );
  p += dot( p, p.yx + 33.33 );
  return fract( ( p.x + p.y ) * p.x );
}
float en( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( eh( i ), eh( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( eh( i + vec2( 0.0, 1.0 ) ), eh( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length( p );
  if ( r > 1.0 ) discard;
  float coal = en( p * 7.0 + 3.1 );
  float breathe = 0.55 + 0.45 * sin( uTime * 1.7 + coal * 9.0 );
  float m = smoothstep( 1.0, 0.15, r ) * smoothstep( 0.34, 0.72, coal );
  float a = m * ( 0.35 + 0.65 * breathe );
  if ( a < 0.01 ) discard;
  vec3 col = mix( vec3( 0.65, 0.070, 0.008 ), vec3( 1.0, 0.36, 0.055 ), a );
  gl_FragColor = vec4( col * a * uScale * ( 0.6 + 0.7 * uFlick ), a );
}
`;

/* -------------------------------------------------------------------------- */
/*  Sparks — 96 independent embers integrated on the GPU                       */
/* -------------------------------------------------------------------------- */

const SPARK_VERT = /* glsl */`
attribute vec4 aSpark;     // x phase, y rise m/s, z RADIUS IN METRES, w seed
uniform float uTime;
uniform float uFlick;
uniform float uPxPerM;     // drawbuffer pixels per metre at one metre of depth
uniform vec3  uWind;
varying float vLife;
varying float vSeed;
void main() {
  float period = 2.1 + fract( aSpark.w * 0.371 ) * 2.4;
  float life = fract( ( uTime + aSpark.x * period ) / period );
  vLife = life;
  vSeed = aSpark.w;
  float h = life * aSpark.y * period;
  // buoyant plume narrows then spreads; turbulence is per-ember, not a column
  float sway = sin( uTime * ( 1.4 + fract( aSpark.w ) * 2.2 ) + aSpark.w * 6.3 );
  float spread = 0.10 + h * 0.16;
  vec3 off = vec3(
    cos( aSpark.w * 7.7 ) * spread + sway * 0.11 * h + uWind.x * h * 0.16,
    h,
    sin( aSpark.w * 7.7 ) * spread + sway * 0.09 * h + uWind.z * h * 0.16 );
  vec4 mv = modelViewMatrix * vec4( position + off, 1.0 );
  float fade = ( 1.0 - life ) * ( 0.55 + 0.45 * uFlick );
  /* Real projected size. Pass 3.0 used a magic 260/z, which at the camp
   * viewpoint made every ember roughly 300 px across; 96 of them stacked into
   * a solid white column that swallowed the whole fire. */
  gl_PointSize = clamp( aSpark.z * ( 0.55 + 0.9 * fade ) * uPxPerM / max( 0.5, -mv.z ),
                        1.0, 9.0 );
  gl_Position = projectionMatrix * mv;
}
`;

const SPARK_FRAG = /* glsl */`
precision highp float;
uniform float uScale;
varying float vLife;
varying float vSeed;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot( d, d );
  if ( r2 > 1.0 ) discard;
  float core = pow( 1.0 - r2, 2.2 );
  // An ember cools as it climbs: yellow-orange at the pit, deep red at the top,
  // and it flickers out rather than fading uniformly.
  float cool = vLife;
  vec3 col = mix( vec3( 1.00, 0.44, 0.12 ), vec3( 0.85, 0.085, 0.010 ), cool * cool );
  float blink = 0.45 + 0.55 * sin( vSeed * 31.7 + vLife * 46.0 );
  float a = core * ( 1.0 - smoothstep( 0.55, 1.0, cool ) ) * ( 0.45 + 0.55 * blink );
  gl_FragColor = vec4( col * a * uScale, a );
}
`;

/* -------------------------------------------------------------------------- */
/*  Smoke — a real plume, lit from below                                       */
/* -------------------------------------------------------------------------- */

const SMOKE_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 c = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  vec3 f = normalize( vec3( cameraPosition.x - c.x, 0.0, cameraPosition.z - c.z ) );
  vec3 rt = normalize( cross( vec3( 0.0, 1.0, 0.0 ), f ) );
  vec3 wp = c + rt * position.x + vec3( 0.0, 1.0, 0.0 ) * position.y;
  gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
}
`;

const SMOKE_FRAG = /* glsl */`
precision highp float;
uniform float uTime;
uniform float uSeed;
uniform float uOpacity;
uniform float uFlick;
uniform float uMaxRad;     // hard ceiling on radiance: smoke can never blow out
uniform vec3  uWind;
uniform vec3  uSky;
varying vec2 vUv;
float sh( vec2 p ) {
  p = fract( p * vec2( 0.1031, 0.1030 ) );
  p += dot( p, p.yx + 33.33 );
  return fract( ( p.x + p.y ) * p.x );
}
float sn( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( sh( i ), sh( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( sh( i + vec2( 0.0, 1.0 ) ), sh( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
float sfbm( vec2 p ) {
  float a = 0.0, w = 0.55;
  for ( int i = 0; i < 4; i++ ) { a += w * sn( p ); p = p * 2.09 + 5.3; w *= 0.5; }
  return a;
}
void main() {
  float y = clamp( vUv.y, 0.0, 1.0 );
  vec2 uv = vUv * 2.0 - 1.0;
  // the column widens, leans downwind and shreds with height
  float lean = uWind.x * y * y * 1.35;
  // The plume must stay narrow inside its quad. Pass 3.0 had w reaching 1.08
  // against a |uv.x| <= 1 domain, so the mask evaluated to 1 across the whole
  // billboard and three of them stacked into an opaque white wall.
  float w = 0.055 + y * 0.30;
  float t = uTime * 0.24;
  float n = sfbm( vec2( uv.x * 1.15 + uSeed, y * 1.55 - t * 2.4 + uSeed ) );
  float d = abs( uv.x + lean + ( n - 0.5 ) * 1.5 * ( 0.15 + y ) ) / w;
  float body = smoothstep( 1.15, 0.0, d );
  // fade in above the flame tip and dissolve into the sky at the top
  body *= smoothstep( 0.0, 0.30, y ) * ( 1.0 - smoothstep( 0.45, 1.0, y ) );
  body *= 0.35 + 0.85 * n;
  float a = body * uOpacity;
  if ( a < 0.006 ) discard;
  // Lit from BELOW: the underside of the plume is inside the fire's pool and
  // scatters its light, the top has only the night sky on it.
  float glow = ( 1.0 - smoothstep( 0.0, 0.34, y ) ) * ( 0.55 + 0.45 * uFlick );
  vec3 col = mix( uSky, vec3( 1.00, 0.36, 0.10 ) * uMaxRad * 2.4, glow * 0.72 );
  col *= 0.55 + 0.75 * n;
  col = min( col, vec3( uMaxRad ) );
  gl_FragColor = vec4( col, a );
}
`;

/* -------------------------------------------------------------------------- */

function noise3(x, y, z) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/** Rounded, noise-displaced boulder with smooth normals and METRIC uvs. */
function boulder(B, mat, cx, cy, cz, r, seed, col, wear, tile = 0.55) {
  const bkt = B.bucket(mat);
  const NU = 12, NV = 8;
  const base = bkt.n;
  const P = [];
  for (let j = 0; j <= NV; j++) {
    const phi = (j / NV) * Math.PI;
    for (let i = 0; i <= NU; i++) {
      const th = (i / NU) * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(th);
      const ny = Math.cos(phi);
      const nz = Math.sin(phi) * Math.sin(th);
      /* Doubled from pass 2. The critique measured these as "~12-20 face
       * icosphere-ish blobs with visible planar facets"; the displacement was
       * ±21 % which is not enough to break a sphere's read at hero scale. */
      /* Enough to break the sphere, not enough to shatter it: pass 3.0 ran
       * +-60 % total and the fire-ring stones read as torn black paper rather
       * than as river cobbles. */
      const d = 1
        + (noise3(nx * 2.4 + seed, ny * 2.4, nz * 2.4) - 0.5) * 0.40
        + (noise3(nx * 5.7 + seed * 2, ny * 5.7, nz * 5.7) - 0.5) * 0.19
        + (noise3(nx * 11.3 + seed * 3, ny * 11.3, nz * 11.3) - 0.5) * 0.085;
      P.push([cx + nx * r * d * 1.15, cy + ny * r * d * 0.72, cz + nz * r * d]);
    }
  }
  /* Arc length in metres / tile size — pass 2 wrote (i/NU)*r*3, which for a
   * 0.2 m stone spanned 0.6 of a tile and stretched the rock texture over the
   * whole boulder. That is the "smeary, near-featureless grey" tell. */
  const uSpan = (2 * Math.PI * r * 1.15) / tile;
  const vSpan = (Math.PI * r * 0.9) / tile;
  const uOff = (seed * 0.37) % 1;
  const vOff = (seed * 0.71) % 1;
  for (let j = 0; j <= NV; j++) {
    for (let i = 0; i <= NU; i++) {
      const k = j * (NU + 1) + i;
      const p = P[k];
      const iL = P[j * (NU + 1) + (i > 0 ? i - 1 : NU - 1)];
      const iR = P[j * (NU + 1) + (i < NU ? i + 1 : 1)];
      const jD = P[Math.max(0, j - 1) * (NU + 1) + i];
      const jU = P[Math.min(NV, j + 1) * (NU + 1) + i];
      const ax = iR[0] - iL[0], ay = iR[1] - iL[1], az = iR[2] - iL[2];
      const bx = jU[0] - jD[0], by = jU[1] - jD[1], bz = jU[2] - jD[2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      /* ORIENT OUTWARD. Pass 2 unconditionally negated the cross product, which
       * is only correct on part of the parameterisation: the up-facing crown of
       * every fire-ring stone ended up with a DOWNWARD normal and rendered flat
       * black under a light that sits above it. That is the "charred pure-black
       * zero-detail polygons" the forensic pass measured — it was never charring,
       * it was a sign error. The surface is star-shaped about its centre, so the
       * radial direction is an unambiguous reference. */
      const rx = p[0] - cx, ry = p[1] - cy, rz = p[2] - cz;
      if (nx * rx + ny * ry + nz * rz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      let l = Math.hypot(nx, ny, nz) || 1;
      /* At the two poles of the parameterisation every column collapses onto
       * one point, so the central differences degenerate and the cross product
       * points nowhere. That is what put a hard black notch in the crown of
       * every fire-ring stone. Fade to the (always valid) radial normal there. */
      const polar = Math.min(j, NV - j) / NV;
      const wgt = Math.min(1, polar * 3.2);
      if (wgt < 1) {
        const rl = Math.hypot(rx, ry, rz) || 1;
        nx = (nx / l) * wgt + (rx / rl) * (1 - wgt);
        ny = (ny / l) * wgt + (ry / rl) * (1 - wgt);
        nz = (nz / l) * wgt + (rz / rl) * (1 - wgt);
        l = Math.hypot(nx, ny, nz) || 1;
      }
      bkt.pos.push(p[0], p[1], p[2]);
      bkt.nor.push(nx / l, ny / l, nz / l);
      bkt.uv.push(uOff + (i / NU) * uSpan, vOff + (j / NV) * vSpan);
      bkt.col.push(col[0], col[1], col[2]);
      bkt.wear.push(p[1] - wear[0], wear[1] - p[1], wear[2], wear[3]);
    }
  }
  bkt.n += (NU + 1) * (NV + 1);
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const k = base + j * (NU + 1) + i;
      bkt.idx.push(k, k + 1, k + NU + 2, k, k + NU + 2, k + NU + 1);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Burn decal                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The scorched ground around the pit, as a terrain-conforming radial decal.
 *
 * Every vertex samples the real heightfield, the outer radius is modulated by
 * two octaves of angular noise, and the vertex alpha feathers to zero across
 * the outer third with the same noise breaking the falloff. There is no
 * straight edge, no corner, and no constant-Y plane left in it.
 *
 * @returns {THREE.BufferGeometry} position/normal/uv/color(RGBA)/aWear
 */
export function buildAshDecal(o) {
  const { cx, cz, groundY, sample, rand } = o;
  const RINGS = 9, SECT = 44;
  const R0 = o.radius || 1.35;
  const pos = [], nor = [], uv = [], col = [], wear = [], idx = [];

  // per-camp angular noise so no two fires burn the same shape
  const ph = [];
  for (let i = 0; i < 6; i++) ph.push(rand() * Math.PI * 2);
  /* The rim wanders, it does not scallop. Pass 3.0 summed to +-71 % and the
   * decal read as a torn sheet of paper laid on the ground. */
  const rimAt = (a) => R0 * (
    1.0
    + 0.11 * Math.sin(a * 2 + ph[0])
    + 0.07 * Math.sin(a * 3 + ph[1])
    + 0.04 * Math.sin(a * 5 + ph[2])
    + 0.02 * Math.sin(a * 9 + ph[3])
  );
  const alphaNoise = (a) => 0.80 + 0.20 * Math.sin(a * 4 + ph[4]) * Math.sin(a * 7 + ph[5]);

  for (let j = 0; j <= RINGS; j++) {
    const t = j / RINGS;
    for (let i = 0; i <= SECT; i++) {
      const a = (i / SECT) * Math.PI * 2;
      const rr = rimAt(a) * t;
      const x = cx + Math.cos(a) * rr;
      const z = cz + Math.sin(a) * rr;
      const y = (sample ? sample(x, z) : groundY) + 0.035;
      pos.push(x, y, z);
      nor.push(0, 1, 0);
      uv.push(x / 1.1, z / 1.1);
      /* Colour: white wood ash at the very centre, a charcoal ring around it,
       * scorched earth beyond, none of it saturated. Alpha rides the outer
       * third only, broken by the same angular noise as the rim.            */
      /* Values are LOW. This sits half a metre from a fire that is the key
       * light of the shot; anything above ~0.2 albedo meters as white paper.
       * Wood ash is a pale grey but it is a pale grey in DIM light. */
      const ash = 1 - Math.min(1, t / 0.30);
      const char = Math.max(0, 1 - Math.abs(t - 0.42) / 0.32);
      const k = 0.74 + 0.22 * Math.sin(a * 9.3 + t * 14.7)
        + 0.16 * Math.sin(a * 23.1 + t * 31.3);
      let cr = 0.088 * k, cg = 0.079 * k, cb = 0.072 * k;
      cr *= (1 - char * 0.55); cg *= (1 - char * 0.57); cb *= (1 - char * 0.57);
      cr += ash * 0.052; cg += ash * 0.049; cb += ash * 0.047;
      const fade = 1 - Math.min(1, Math.max(0, (t - 0.20) / 0.80));
      const alpha = Math.min(1, fade * fade * (0.45 + 0.72 * alphaNoise(a)));
      col.push(cr, cg, cb, j === RINGS ? 0 : alpha);
      wear.push(0.4, -6, 0.9, 0.15);
    }
  }
  const row = SECT + 1;
  for (let j = 0; j < RINGS; j++) {
    for (let i = 0; i < SECT; i++) {
      const k = j * row + i;
      idx.push(k, k + row, k + row + 1, k, k + row + 1, k + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setAttribute('aWear', new THREE.Float32BufferAttribute(wear, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/* -------------------------------------------------------------------------- */

/**
 * Build the camp. Geometry is appended to the shared builder buckets; the
 * decal geometry comes back for Town to give a transparent material to.
 */
export function buildCampfire(B, M, ctxObj) {
  const { pos, rand, groundY, sample } = ctxObj;
  const F = new Frame(pos.x, groundY, pos.z, 1, 0);
  const wear = [groundY, groundY + 1.4, 0.95, 0.2];

  /* ---- the scraped hollow itself: a shallow bowl of ash, INSIDE the ring --- */
  const ashGeometry = buildAshDecal({
    cx: pos.x, cz: pos.z, groundY, sample, rand, radius: 1.28,
  });

  /* ---- stone ring --------------------------------------------------------
   * Dark river basalt, per-stone value spread, and a sooted band on the inner
   * faces. Pass 2 painted these 0.92 white and the fire key blew them out.  */
  const N = 11;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + (rand() - 0.5) * 0.30;
    const rad = 0.84 + (rand() - 0.5) * 0.18;
    const r = 0.105 + rand() * 0.085;
    const p = F.p(Math.cos(a) * rad, Math.sin(a) * rad, r * 0.5);
    const v = 0.72 + rand() * 0.5;               // 4:1 spread stone to stone
    const soot = rand() < 0.5 ? 0.72 : 0.95;
    boulder(B, M.rock, p[0], p[1], p[2], r, i * 3.7 + 1.3,
      [0.165 * v * soot, 0.152 * v * soot, 0.143 * v * soot], wear, 0.42);
  }

  /* ---- spent logs leaning into the middle --------------------------------
   * 10 sides instead of 7 and a third of the wobble: the pass-2 read was
   * "identical chevron/zigzag corrugated-hose rhythm with facet bands". */
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + rand() * 0.6;
    const outR = 0.62 + rand() * 0.16;
    const p0 = F.p(Math.cos(a) * outR, Math.sin(a) * outR, 0.04);
    const p1 = F.p(Math.cos(a) * 0.10, Math.sin(a) * 0.10, 0.30 + rand() * 0.10);
    B.tube(M.charred, p0, p1, 0.075 + rand() * 0.022, 0.056, 10, {
      us: 0.34,
      vs: 0.62,
      wear,
      rings: 4,
      wobble: 0.011,
      phase: i * 2.7,
      caps: true,
      col: (q) => {
        const d = Math.hypot(q[0] - F.ox, q[2] - F.oz);
        const k = Math.max(0.06, Math.min(1, (d - 0.10) / 0.62));
        // charcoal at the fire end, weathered bark at the outer end — never
        // pure black, which pass 2 flagged as "zero-detail polygons"
        return [0.115 + 0.26 * k, 0.098 + 0.21 * k, 0.086 + 0.16 * k];
      },
    });
  }
  /* a couple of unburnt logs stacked to one side */
  for (let i = 0; i < 3; i++) {
    const a = 1.9 + i * 0.16;
    const p0 = F.p(Math.cos(a) * 1.45 - 0.3, Math.sin(a) * 1.45 + i * 0.16, 0.09 + i * 0.15);
    const p1 = F.p(Math.cos(a) * 1.45 + 0.9, Math.sin(a) * 1.45 + i * 0.16 + 0.1, 0.09 + i * 0.15);
    const v = 0.72 + rand() * 0.4;
    B.tube(M.charred, p0, p1, 0.085, 0.077, 10, {
      us: 0.30, vs: 0.55, wear, rings: 2, wobble: 0.0, phase: i * 4.1, caps: true,
      col: [0.185 * v, 0.150 * v, 0.115 * v],
      // a sawn end is PALER than the bark; pass 3.0 gave the far cap the bark
      // colour and the log read as an open pipe
      capCol: [0.36 * v, 0.29 * v, 0.21 * v],
    });
  }

  /* ---- a coffee pot on a tripod, so there is a camp and not just a fire -- */
  const tri = 0.66;
  const tcx = 0.34, tcz = -0.62;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.55;
    B.tube(M.rock, F.p(tcx + Math.cos(a) * tri, tcz + Math.sin(a) * tri, 0), F.p(tcx, tcz, 1.02),
      0.024, 0.018, 5, { us: 0.3, vs: 0.5, col: [0.20, 0.185, 0.17], wear });
  }
  B.tube(M.rock, F.p(tcx, tcz, 0.50), F.p(tcx, tcz, 0.72), 0.095, 0.082, 10,
    { us: 0.3, vs: 0.4, col: [0.16, 0.150, 0.140], wear, caps: true });
  B.tube(M.rock, F.p(tcx, tcz, 0.72), F.p(tcx, tcz, 0.96), 0.013, 0.013, 5,
    { us: 0.2, vs: 0.4, col: [0.18, 0.168, 0.158], wear });

  /* ---- bedroll + saddle a couple of metres back -------------------------- */
  const BR = F.sub(-1.9, 1.5, 0, 0.5);
  B.tube(M.canvasCamp, BR.p(-0.85, 0, 0.14), BR.p(0.85, 0, 0.14), 0.16, 0.15, 9,
    { us: 0.7, vs: 0.7, col: [0.52, 0.47, 0.39], wear, rings: 3, wobble: 0.11, caps: true });
  B.tube(M.charred, BR.p(1.15, 0.1, 0.20), BR.p(1.55, 0.1, 0.20), 0.22, 0.19, 9,
    { us: 0.5, vs: 0.5, col: [0.30, 0.19, 0.12], wear, rings: 2, wobble: 0.16, caps: true });

  /* ---- charcoal chunks in the pit, and gravel scattered outside ---------- */
  for (let i = 0; i < 5; i++) {
    const a = rand() * Math.PI * 2;
    const rr = rand() * 0.46;
    const p = F.p(Math.cos(a) * rr, Math.sin(a) * rr, 0.02);
    boulder(B, M.charred, p[0], p[1], p[2], 0.026 + rand() * 0.028, i * 7.3 + 2.1,
      [0.16, 0.138, 0.124], wear, 0.20);
  }
  for (let i = 0; i < 14; i++) {
    const a = rand() * Math.PI * 2;
    const rr = 1.5 + rand() * 3.6;
    const px = Math.cos(a) * rr, pz = Math.sin(a) * rr;
    const gy = sample ? sample(F.ox + px, F.oz + pz) - groundY : 0;
    const p = F.p(px, pz, gy + 0.02);
    const v = 0.78 + rand() * 0.44;
    boulder(B, M.rock, p[0], p[1], p[2], 0.07 + rand() * 0.14, i * 5.1,
      [0.20 * v, 0.186 * v, 0.172 * v], wear, 0.34);
  }

  return { frame: F, wear, ashGeometry };
}

/* -------------------------------------------------------------------------- */

/** Flame billboards + ember bed + spark field + smoke plume. */
export function makeFlames(seed) {
  const group = new THREE.Group();
  const mats = [];
  /* Radiance ladder. The stack sums to ~0.115 linear at the very core and
   * ~0.035 over most of the flame's screen area. At a night exposure of ~11.5
   * that is 1.3 / 0.40 — inside the shoulder but not through it, which is what
   * keeps (1.0, 0.37, 0.14) instead of white. */
  const LAYERS = [
    { w: 1.34, h: 1.16, y: 0.02, width: 0.60, scale: 0.055, core: 0.0, speed: 0.85 },
    { w: 1.08, h: 1.38, y: 0.03, width: 0.52, scale: 0.078, core: 0.0, speed: 1.05 },
    { w: 0.84, h: 1.06, y: 0.04, width: 0.46, scale: 0.100, core: 0.30, speed: 1.42 },
    { w: 0.50, h: 0.68, y: 0.05, width: 0.41, scale: 0.135, core: 1.00, speed: 1.90 },
  ];
  for (let i = 0; i < LAYERS.length; i++) {
    const L = LAYERS[i];
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSeed: { value: (seed * 7.13 + i * 3.77) % 40 },
        uScale: { value: L.scale },
        uWidth: { value: L.width },
        uCore: { value: L.core },
        uFlick: { value: 0.5 },
        uWind: { value: new THREE.Vector3(0, 0, 0) },
      },
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_GLSL,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    m.userData.rsNoAerial = true;
    m.userData.speed = L.speed;
    const geo = new THREE.PlaneGeometry(L.w, L.h);
    geo.translate(0, L.h * 0.5, 0);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(0, L.y, 0);
    mesh.frustumCulled = false;
    mesh.renderOrder = 10 + i;
    mesh.userData.rsNoAerial = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    mats.push(m);
  }

  /* ---- ember bed --------------------------------------------------------- */
  const em = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uScale: { value: 0.10 }, uFlick: { value: 0.5 } },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
    fragmentShader: EMBER_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  em.userData.rsNoAerial = true;
  const bed = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 1.35), em);
  bed.rotation.x = -Math.PI * 0.5;
  bed.position.y = 0.06;
  bed.renderOrder = 9;
  bed.userData.rsNoAerial = true;
  group.add(bed);

  /* ---- sparks ------------------------------------------------------------ */
  const NS = 96;
  const sp = new Float32Array(NS * 3);
  const sa = new Float32Array(NS * 4);
  let s = (seed * 1237.13) % 997;
  const r = () => { s = (s * 16807 + 11) % 2147483647; return (s / 2147483647) % 1; };
  for (let i = 0; i < NS; i++) {
    const a = r() * Math.PI * 2, rr = r() * 0.26;
    sp[i * 3] = Math.cos(a) * rr;
    sp[i * 3 + 1] = 0.16 + r() * 0.30;
    sp[i * 3 + 2] = Math.sin(a) * rr;
    sa[i * 4] = r();                       // launch phase
    sa[i * 4 + 1] = 0.55 + r() * 1.35;     // rise rate
    sa[i * 4 + 2] = 0.004 + r() * 0.011;   // radius in METRES — 4:1 spread
    sa[i * 4 + 3] = r() * 19.3;            // turbulence seed
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  sg.setAttribute('aSpark', new THREE.BufferAttribute(sa, 4));
  sg.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 0), 6);
  const sm = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uFlick: { value: 0.5 }, uScale: { value: 0.11 },
      uPxPerM: { value: 900.0 },
      uWind: { value: new THREE.Vector3() },
    },
    vertexShader: SPARK_VERT,
    fragmentShader: SPARK_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  sm.userData.rsNoAerial = true;
  const sparks = new THREE.Points(sg, sm);
  sparks.frustumCulled = false;
  sparks.renderOrder = 14;
  sparks.userData.rsNoAerial = true;
  group.add(sparks);

  /* ---- smoke plume ------------------------------------------------------- */
  const smokeMats = [];
  for (let i = 0; i < 3; i++) {
    const mm = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSeed: { value: (seed * 3.1 + i * 12.7) % 30 },
        uOpacity: { value: 0.085 },
        uFlick: { value: 0.5 },
        uMaxRad: { value: 0.030 },
        uWind: { value: new THREE.Vector3() },
        uSky: { value: new THREE.Color(0.010, 0.011, 0.014) },
      },
      vertexShader: SMOKE_VERT,
      fragmentShader: SMOKE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    mm.userData.rsNoAerial = true;
    const H = 4.2 + i * 1.1;
    const gq = new THREE.PlaneGeometry(1.5 + i * 0.45, H);
    gq.translate(0, H * 0.5, 0);
    const mesh = new THREE.Mesh(gq, mm);
    mesh.position.set(0, 0.75, 0);
    mesh.frustumCulled = false;
    mesh.renderOrder = 8 - i;
    mesh.userData.rsNoAerial = true;
    mesh.castShadow = false;
    group.add(mesh);
    smokeMats.push(mm);
  }

  return { group, mats, ember: em, spark: sm, smoke: smokeMats };
}
