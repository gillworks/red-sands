import * as THREE from 'three';
import { makeMaterial, GLSL_COMMON } from './Common.js';

/**
 * Lens simulation: physically-derived circle of confusion depth of field with
 * a hexagonal-aperture gather, and velocity-buffer motion blur reconstructed
 * with tile-max / neighbour-max dilation.
 */

/* --------------------------------------------------------------- shared */

const COC = /* glsl */`
uniform sampler2D tExposure;   // .g carries the smoothed auto-focus distance
uniform float uAutoFocus;
uniform float uFocusManual;
uniform float uFocal;          // metres
uniform float uAperture;       // f-number
uniform float uSensorH;        // metres
uniform float uScreenH;        // pixels
uniform float uMaxCoC;         // pixels (full res)
uniform float uNearScale;

float focusDistance() {
  float autoF = texture2D( tExposure, vec2( 0.5 ) ).g;
  return max( mix( uFocusManual, autoF, uAutoFocus ), uFocal * 1.2 );
}

// Signed CoC in full-resolution pixels. Negative = in front of the focal plane.
float cocPixels( float dist, float focus ) {
  float f = uFocal;
  float A = f / max( uAperture, 0.5 );
  float c = A * f * ( dist - focus ) / max( dist * ( focus - f ), 1e-6 );
  float px = c / uSensorH * uScreenH;
  if ( px < 0.0 ) px *= uNearScale;
  return clamp( px, -uMaxCoC, uMaxCoC );
}
`;

const COC_UNIFORMS = () => ({
  tExposure: { value: null },
  uAutoFocus: { value: 1 },
  uFocusManual: { value: 30 },
  uFocal: { value: 0.035 },
  uAperture: { value: 5.6 },
  uSensorH: { value: 0.024 },
  uScreenH: { value: 900 },
  uMaxCoC: { value: 9 },
  uNearScale: { value: 0.55 },
});

/* ------------------------------------------------------------------ DOF */

/** Half-res prepare: downsampled colour in rgb, signed half-res CoC in a. */
export function dofPrepareMaterial() {
  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    ${COC}
    uniform sampler2D tColor;
    uniform sampler2D tDepth;
    uniform mat4 uInvProj;
    uniform vec2 uFullTexel;
    uniform float uNear, uFar;
    varying vec2 vUv;
    void main() {
      vec2 o = uFullTexel * 0.5;
      vec3 c = texture2D( tColor, vUv + vec2( -o.x, -o.y ) ).rgb;
      c += texture2D( tColor, vUv + vec2(  o.x, -o.y ) ).rgb;
      c += texture2D( tColor, vUv + vec2( -o.x,  o.y ) ).rgb;
      c += texture2D( tColor, vUv + vec2(  o.x,  o.y ) ).rgb;
      c *= 0.25;

      float d = texture2D( tDepth, vUv ).r;
      float vz = viewZFromDepth( d, uNear, uFar );
      float dist = d >= 0.9999 ? uFar : -vz;
      float coc = cocPixels( dist, focusDistance() ) * 0.5;   // half-res pixels
      gl_FragColor = vec4( c, coc );
    }`, Object.assign(COC_UNIFORMS(), {
    tColor: { value: null },
    tDepth: { value: null },
    uInvProj: { value: new THREE.Matrix4() },
    uFullTexel: { value: new THREE.Vector2() },
    uNear: { value: 0.15 },
    uFar: { value: 12000 },
  }));
}

/** Separable max-filter that dilates the near-field CoC so foreground bleeds outward. */
export function dofNearDilateMaterial() {
  return makeMaterial(/* glsl */`
    uniform sampler2D tSrc;
    uniform vec2 uTexel;
    uniform vec2 uDir;
    uniform float uFromAlpha;
    varying vec2 vUv;
    void main() {
      float m = 0.0;
      for ( int i = -6; i <= 6; i++ ) {
        vec2 uv = vUv + uDir * uTexel * float( i );
        vec4 s = texture2D( tSrc, uv );
        float v = uFromAlpha > 0.5 ? max( -s.a, 0.0 ) : s.r;
        m = max( m, v );
      }
      gl_FragColor = vec4( m, 0.0, 0.0, 1.0 );
    }`, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uDir: { value: new THREE.Vector2(1, 0) },
    uFromAlpha: { value: 1 },
  });
}

/** Hexagonal-aperture gather. MRT: 0 = far field, 1 = near field. */
export function dofGatherMaterial(taps) {
  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    uniform sampler2D tPrepared;
    uniform sampler2D tNearCoC;
    uniform vec2 uTexel;
    uniform float uMaxCoCHalf;
    varying vec2 vUv;
    layout(location = 0) out vec4 outFar;
    layout(location = 1) out vec4 outNear;

    vec2 tapOffset( int i ) {
      float fi = float( i ) + 0.5;
      float ang = fi * 2.39996323;
      float r = sqrt( fi / float( TAPS ) );
      float a6 = mod( ang, PI / 3.0 ) - PI / 6.0;
      r *= 0.8660254 / cos( a6 );            // hexagonal aperture shaping
      return vec2( cos( ang ), sin( ang ) ) * r;
    }

    void main() {
      vec4 center = texture2D( tPrepared, vUv );
      float cFar = max( center.a, 0.0 );
      float nearR = texture2D( tNearCoC, vUv ).r;

      /*
       * IN-FOCUS EARLY-OUT. Below ~half a half-res texel of circle of confusion
       * the gather cannot move a pixel, and in these shots most of the frame is
       * beyond the hyperfocal distance (f/5.6 on a 28 mm equivalent puts it at
       * ~3.6 m), so the 32-tap loop was running over an image that is almost
       * entirely sharp. The branch is spatially coherent — whole in-focus
       * regions take it together — which is exactly the case where a GPU
       * actually collects the saving.
       */
      if ( cFar < 0.55 && nearR < 0.55 ) {
        outFar = vec4( center.rgb, 0.0 );
        outNear = vec4( center.rgb, 0.0 );
        return;
      }

      vec3 farSum = center.rgb * 1.0;
      float farW = 1.0;
      vec3 nearSum = vec3( 0.0 );
      float nearW = 0.0;

      float farR = max( cFar, 0.5 );
      for ( int i = 0; i < TAPS; i++ ) {
        vec2 t = tapOffset( i );
        float tl = length( t );

        vec4 sf = texture2D( tPrepared, vUv + t * farR * uTexel );
        float sc = max( sf.a, 0.0 );
        float w = SAT( ( sc - tl * farR ) * 0.6 + 1.0 ) * step( 0.35, sc );
        farSum += sf.rgb * w;
        farW += w;

        if ( nearR > 0.5 ) {
          vec4 sn = texture2D( tPrepared, vUv + t * nearR * uTexel );
          float snc = max( -sn.a, 0.0 );
          float wn = SAT( ( snc - tl * nearR ) * 0.6 + 1.0 );
          nearSum += sn.rgb * wn;
          nearW += wn;
        }
      }

      outFar = vec4( farSum / max( farW, 1e-4 ), SAT( cFar / max( uMaxCoCHalf, 1e-3 ) * 1.6 ) );
      float na = SAT( nearR / max( uMaxCoCHalf, 1e-3 ) * 1.5 );
      outNear = vec4( nearW > 0.0 ? nearSum / nearW : center.rgb, na );
    }`, {
    tPrepared: { value: null },
    tNearCoC: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uMaxCoCHalf: { value: 4.5 },
  }, { TAPS: Math.max(8, taps | 0) }, true);
}

/** Full-res recombination of sharp / far / near. */
export function dofCompositeMaterial() {
  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    ${COC}
    uniform sampler2D tColor;
    uniform sampler2D tFar;
    uniform sampler2D tNear;
    uniform sampler2D tDepth;
    uniform float uNear, uFar;
    varying vec2 vUv;
    void main() {
      vec3 sharp = texture2D( tColor, vUv ).rgb;
      float d = texture2D( tDepth, vUv ).r;
      float dist = d >= 0.9999 ? uFar : -viewZFromDepth( d, uNear, uFar );
      float coc = cocPixels( dist, focusDistance() );

      vec4 far = texture2D( tFar, vUv );
      vec4 near = texture2D( tNear, vUv );

      float fa = SAT( max( coc, 0.0 ) / max( uMaxCoC, 1e-3 ) * 1.6 ) * SAT( far.a * 1.2 );
      vec3 c = mix( sharp, far.rgb, fa );
      c = mix( c, near.rgb, SAT( near.a ) );
      gl_FragColor = vec4( c, 1.0 );
    }`, Object.assign(COC_UNIFORMS(), {
    tColor: { value: null },
    tFar: { value: null },
    tNear: { value: null },
    tDepth: { value: null },
    uNear: { value: 0.15 },
    uFar: { value: 12000 },
  }));
}

/* ---------------------------------------------------------- motion blur */

/** Separable max-magnitude reduction of the velocity buffer into tiles. */
export function tileMaxMaterial(k) {
  return makeMaterial(/* glsl */`
    uniform sampler2D tSrc;
    uniform vec2 uTexel;
    uniform vec2 uDir;
    varying vec2 vUv;
    void main() {
      vec2 best = vec2( 0.0 );
      float bl = 0.0;
      for ( int i = 0; i < K; i++ ) {
        vec2 uv = vUv + uDir * uTexel * ( float( i ) - float( K ) * 0.5 + 0.5 );
        vec2 v = texture2D( tSrc, uv ).rg;
        float l = dot( v, v );
        if ( l > bl ) { bl = l; best = v; }
      }
      gl_FragColor = vec4( best, 0.0, 1.0 );
    }`, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uDir: { value: new THREE.Vector2(1, 0) },
  }, { K: Math.max(2, k | 0) });
}

/** 3x3 max over tiles so blur can extend past a tile boundary. */
export function neighborMaxMaterial() {
  return makeMaterial(/* glsl */`
    uniform sampler2D tSrc;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      vec2 best = vec2( 0.0 );
      float bl = 0.0;
      for ( int y = -1; y <= 1; y++ ) {
        for ( int x = -1; x <= 1; x++ ) {
          vec2 v = texture2D( tSrc, vUv + vec2( float( x ), float( y ) ) * uTexel ).rg;
          float l = dot( v, v );
          if ( l > bl ) { bl = l; best = v; }
        }
      }
      gl_FragColor = vec4( best, 0.0, 1.0 );
    }`, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
  });
}

/**
 * McGuire-style reconstruction filter.
 *
 * SHUTTER, NOT "FRAME DELTA".
 * ---------------------------------------------------------------------------
 * The velocity buffer is a per-FRAME uv delta, so `uScale` has to be the
 * fraction of the frame interval the shutter is open — and it must be
 * recomputed from the real dt, or the streak grows with frame time instead of
 * representing an exposure. PostFX drives both `uScale` and `uMaxPixels`
 * (see `PostFX.motionBlur`); the defaults here are the 60 Hz / 720p case.
 *
 * `uMaxPixels` is the hard ceiling on the streak in pixels and is the knob
 * that actually decides whether a gallop reads as motion or as mud: pass 3
 * shipped 34 px at any resolution with a 180-degree shutter, which on the
 * over-the-shoulder ride destroyed 46% of the ground's gradient energy in a
 * single frame (measured: 0.0225 -> 0.0122 mean |grad|). It is now a fraction
 * of frame height, so it means the same thing at every resolution.
 */
export function motionBlurMaterial(samples) {
  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    uniform sampler2D tColor;
    uniform sampler2D tVelocity;
    uniform sampler2D tNeighborMax;
    uniform sampler2D tDepth;
    uniform sampler2D tBlue;
    uniform vec2 uResolution;
    uniform vec2 uBlueScale;
    uniform float uScale;
    uniform float uMaxPixels;
    uniform float uNear, uFar;
    uniform float uFrame;
    varying vec2 vUv;

    float softDepth( float za, float zb ) { return SAT( 1.0 - ( za - zb ) / 0.6 ); }
    float cone( float d, float vl ) { return SAT( 1.0 - d / max( vl, 1e-4 ) ); }
    float cylinder( float d, float vl ) { return 1.0 - smoothstep( 0.95 * vl, 1.05 * vl, d ); }

    void main() {
      vec3 base = texture2D( tColor, vUv ).rgb;
      vec2 vmax = texture2D( tNeighborMax, vUv ).rg * uScale;
      float vmaxPx = length( vmax * uResolution );
      // Below ~1.5 px the gather can only resample the pixel's own neighbours,
      // which is a free softening of the whole frame for no visible streak.
      if ( vmaxPx < 1.5 ) { gl_FragColor = vec4( base, 1.0 ); return; }
      if ( vmaxPx > uMaxPixels ) { vmax *= uMaxPixels / vmaxPx; vmaxPx = uMaxPixels; }

      vec2 vc = texture2D( tVelocity, vUv ).rg * uScale;
      /*
       * The centre tap is weighted 1/vcPx, so an unclamped centre velocity
       * throws the pixel's own colour away (weight 1/60) while the gather it is
       * replaced by only spans uMaxPixels. Clamping both to the same ceiling is
       * what keeps a fast pixel a streak instead of a hole.
       */
      float vcPx = clamp( length( vc * uResolution ), 0.5, uMaxPixels );
      float zc = linear01( viewZFromDepth( texture2D( tDepth, vUv ).r, uNear, uFar ), uNear, uFar ) * uFar;

      float j = texture2D( tBlue, vUv * uBlueScale + vec2( uFrame * 0.7548776, uFrame * 0.5698402 ) ).r - 0.5;

      vec3 sum = base * ( 1.0 / max( vcPx, 1.0 ) );
      float wsum = 1.0 / max( vcPx, 1.0 );

      for ( int i = 0; i < SAMPLES; i++ ) {
        float t = ( ( float( i ) + 0.5 + j ) / float( SAMPLES ) - 0.5 ) * 2.0;
        vec2 uv = vUv + vmax * t * 0.5;
        float zs = linear01( viewZFromDepth( texture2D( tDepth, uv ).r, uNear, uFar ), uNear, uFar ) * uFar;
        vec2 vs = texture2D( tVelocity, uv ).rg * uScale;
        float vsPx = clamp( length( vs * uResolution ), 0.5, uMaxPixels );
        float dpx = abs( t ) * 0.5 * vmaxPx;

        float fg = softDepth( zc, zs ) * cone( dpx, vsPx );
        float bg = softDepth( zs, zc ) * cone( dpx, vcPx );
        float bt = cylinder( dpx, vsPx ) * cylinder( dpx, vcPx ) * 2.0;
        float w = fg + bg + bt;
        sum += texture2D( tColor, uv ).rgb * w;
        wsum += w;
      }

      gl_FragColor = vec4( sum / max( wsum, 1e-4 ), 1.0 );
    }`, {
    tColor: { value: null },
    tVelocity: { value: null },
    tNeighborMax: { value: null },
    tDepth: { value: null },
    tBlue: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uBlueScale: { value: new THREE.Vector2(1, 1) },
    /** Shutter fraction of the frame interval; PostFX recomputes it from dt. */
    uScale: { value: 0.32 },
    /** Hard streak ceiling in pixels; PostFX scales it with frame height. */
    uMaxPixels: { value: 9 },
    uNear: { value: 0.15 },
    uFar: { value: 12000 },
    uFrame: { value: 0 },
  }, { SAMPLES: Math.max(4, samples | 0) });
}
