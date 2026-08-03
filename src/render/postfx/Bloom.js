import * as THREE from 'three';
import { makeMaterial, GLSL_COMMON } from './Common.js';

/**
 * Energy-conserving progressive bloom (Call of Duty: Advanced Warfare style):
 * 13-tap downsample with a Karis average on the first mip to kill fireflies,
 * 3x3 tent upsample blended back up the chain. Thresholding happens in
 * exposure-relative space so the glow is stable from noon to midnight.
 */

const DOWNSAMPLE_13 = /* glsl */`
vec3 tap( sampler2D t, vec2 uv ) { return max( texture2D( t, uv ).rgb, vec3( 0.0 ) ); }

vec3 downsample13( sampler2D t, vec2 uv, vec2 tx, bool karis ) {
  vec3 a = tap( t, uv + tx * vec2( -2.0, -2.0 ) );
  vec3 b = tap( t, uv + tx * vec2(  0.0, -2.0 ) );
  vec3 c = tap( t, uv + tx * vec2(  2.0, -2.0 ) );
  vec3 d = tap( t, uv + tx * vec2( -2.0,  0.0 ) );
  vec3 e = tap( t, uv );
  vec3 f = tap( t, uv + tx * vec2(  2.0,  0.0 ) );
  vec3 g = tap( t, uv + tx * vec2( -2.0,  2.0 ) );
  vec3 h = tap( t, uv + tx * vec2(  0.0,  2.0 ) );
  vec3 i = tap( t, uv + tx * vec2(  2.0,  2.0 ) );
  vec3 j = tap( t, uv + tx * vec2( -1.0, -1.0 ) );
  vec3 k = tap( t, uv + tx * vec2(  1.0, -1.0 ) );
  vec3 l = tap( t, uv + tx * vec2( -1.0,  1.0 ) );
  vec3 m = tap( t, uv + tx * vec2(  1.0,  1.0 ) );

  vec3 g0 = ( a + b + d + e ) * 0.25;
  vec3 g1 = ( b + c + e + f ) * 0.25;
  vec3 g2 = ( d + e + g + h ) * 0.25;
  vec3 g3 = ( e + f + h + i ) * 0.25;
  vec3 g4 = ( j + k + l + m ) * 0.25;

  if ( karis ) {
    float w0 = 1.0 / ( 1.0 + luma( g0 ) );
    float w1 = 1.0 / ( 1.0 + luma( g1 ) );
    float w2 = 1.0 / ( 1.0 + luma( g2 ) );
    float w3 = 1.0 / ( 1.0 + luma( g3 ) );
    float w4 = 1.0 / ( 1.0 + luma( g4 ) );
    float sw = w0 * 0.125 + w1 * 0.125 + w2 * 0.125 + w3 * 0.125 + w4 * 0.5;
    return ( g0 * w0 * 0.125 + g1 * w1 * 0.125 + g2 * w2 * 0.125 +
             g3 * w3 * 0.125 + g4 * w4 * 0.5 ) / max( sw, 1e-5 );
  }
  return g4 * 0.5 + ( g0 + g1 + g2 + g3 ) * 0.125;
}
`;

export function bloomPrefilterMaterial() {
  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    ${DOWNSAMPLE_13}
    uniform sampler2D tSrc;
    uniform sampler2D tExposure;
    uniform vec2 uTexel;
    uniform float uThreshold;
    uniform float uKnee;
    uniform float uClamp;
    varying vec2 vUv;
    void main() {
      vec3 c = downsample13( tSrc, vUv, uTexel, true );
      c *= texture2D( tExposure, vec2( 0.5 ) ).r;      // exposure-relative
      c = min( c, vec3( uClamp ) );
      float br = maxc( c );
      float soft = clamp( br - uThreshold + uKnee, 0.0, 2.0 * uKnee );
      soft = soft * soft / ( 4.0 * uKnee + 1e-5 );
      float contrib = max( soft, br - uThreshold ) / max( br, 1e-5 );
      gl_FragColor = vec4( c * contrib, 1.0 );
    }`, {
    tSrc: { value: null },
    tExposure: { value: null },
    uTexel: { value: new THREE.Vector2() },
    /**
     * Exposure-relative threshold; PostFX drives it from `film.bloomThreshold`.
     *
     * Pass 1 used 1.25 and put a glow round every sunlit cloud. Pass 2 answered
     * with 2.6 — but the auto-exposure's own highlight protection holds the
     * brightest SIXTEENTH of the frame at ~2.9 (uHighlightCeil in Grade.js), so
     * a threshold of 2.6 sits inside the metering's own ceiling and essentially
     * nothing in a daylight frame could bloom at all. Every forensic report on
     * pass 2 then measured "no bloom, no specular glint anywhere". The real
     * cause of the false suns was cloud shading clipping flat, not the bloom
     * onset. 1.9 puts the knee just above a sunlit diffuse surface and below a
     * specular glint or an emitter, which is where it belongs.
     */
    uThreshold: { value: 1.9 },
    uKnee: { value: 0.7 },
    /**
     * Firefly ceiling, exposure-relative, applied BEFORE the threshold.
     *
     * 24 is twelve times the 1.9 threshold, so any pinpoint that clips — the
     * sun disc glimpsed through a gap under the storm deck, a specular spike
     * on wet rock — enters the chain with enough energy to survive five
     * successive blurs and still read as a hard white shape rather than a
     * glow. That is where storm_plains' vertical white bar gets its amplitude:
     * the SOURCE is a small, very bright feature in the cloud/sky buffer
     * (it disappears with either the sun disc or the cloud deck switched off),
     * but what makes it a bar instead of a haze is that bloom is allowed to
     * carry 24x through the whole chain. 7 is still 3.7x the threshold, which
     * is more than a sunlit cloud (~3-5) or a specular glint needs, and it is
     * the standard "clamp before you blur" guard.
     */
    uClamp: { value: 7 },
  });
}

export function bloomDownMaterial() {
  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    ${DOWNSAMPLE_13}
    uniform sampler2D tSrc;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      gl_FragColor = vec4( downsample13( tSrc, vUv, uTexel, false ), 1.0 );
    }`, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
  });
}

/** 3x3 tent upsample, additively blended into the larger mip. */
export function bloomUpMaterial() {
  const m = makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    uniform sampler2D tSrc;
    uniform vec2 uTexel;
    uniform float uRadius;
    uniform float uIntensity;
    varying vec2 vUv;
    void main() {
      vec2 r = uTexel * uRadius;
      vec3 s = texture2D( tSrc, vUv + vec2( -r.x,  r.y ) ).rgb * 1.0;
      s += texture2D( tSrc, vUv + vec2(  0.0,  r.y ) ).rgb * 2.0;
      s += texture2D( tSrc, vUv + vec2(  r.x,  r.y ) ).rgb * 1.0;
      s += texture2D( tSrc, vUv + vec2( -r.x,  0.0 ) ).rgb * 2.0;
      s += texture2D( tSrc, vUv ).rgb * 4.0;
      s += texture2D( tSrc, vUv + vec2(  r.x,  0.0 ) ).rgb * 2.0;
      s += texture2D( tSrc, vUv + vec2( -r.x, -r.y ) ).rgb * 1.0;
      s += texture2D( tSrc, vUv + vec2(  0.0, -r.y ) ).rgb * 2.0;
      s += texture2D( tSrc, vUv + vec2(  r.x, -r.y ) ).rgb * 1.0;
      gl_FragColor = vec4( max( s * ( 1.0 / 16.0 ) * uIntensity, vec3( 0.0 ) ), 1.0 );
    }`, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uRadius: { value: 1.0 },
    uIntensity: { value: 1.0 },
  });
  m.blending = THREE.AdditiveBlending;
  return m;
}
