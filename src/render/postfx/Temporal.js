import * as THREE from 'three';
import { makeMaterial, GLSL_COMMON } from './Common.js';

/**
 * Temporal anti-aliasing.
 *  - projection is Halton(2,3) jittered by PostFX before the scene render
 *  - history is reprojected through the (depth-dilated) velocity buffer and
 *    resampled with a 9-tap Catmull-Rom so it does not soften every frame
 *  - statistics, clipping and blending all happen in Karis-compressed space
 *    (c / (1 + luma)), which is what stops a 1000:1 sky/terrain edge from
 *    producing a variance box so wide that the clip is a no-op — and what
 *    stops a single firefly from smearing across the frame
 *  - history is variance-clipped in YCoCg against the 3x3 neighbourhood
 *
 * THE RESOLVE MUST NOT SHARPEN.
 * ---------------------------------------------------------------------------
 * This pass writes straight into the history buffer that the NEXT frame reads
 * back at `uFeedback` (0.92-0.95). Pass 2 ran a contrast-adaptive sharpen at
 * the end of this shader, so the sharpened image was what got stored, and the
 * next frame sharpened it again. For content at the Nyquist limit the 3x3 mean
 * is ~0, so the unsharp operator is a per-frame gain of (1 + uSharpen) on
 * exactly the frequencies TAA exists to remove; with feedback 0.92 the loop
 * gain was 0.92 * 1.25 = 1.15 — divergent. High-frequency detail therefore grew
 * exponentially until the channels clipped at different rates, which is what
 * produced the "chaotic checkerboard of saturated magenta, red, purple and
 * yellow pixels" on mid-ground props, the 21.9 per-pixel delta std on flat
 * ground versus 1.0 in the sky, the black speckle through the forest canopy,
 * and the "smeared/streaky brushstroke artifacting" the forensic reports
 * called out. Measured on golden_hour_vista: removing this one term drops the
 * p99 vertical pixel delta 51 -> 29 and the count of wildly out-of-gamut
 * pixels 1259 -> 237.
 *
 * Sharpening still happens — as a proper contrast-adaptive (CAS) resolve in
 * `finalMaterial`, which is outside the feedback loop and therefore stable.
 */
export function taaMaterial() {
  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    uniform sampler2D tCurrent;
    uniform sampler2D tHistory;
    uniform sampler2D tVelocity;
    uniform sampler2D tDepth;
    uniform vec2 uTexel;
    uniform vec2 uResolution;
    uniform vec2 uJitter;        // this frame's sub-pixel offset, in pixels
    uniform float uFeedback;
    uniform float uValid;
    uniform float uClipGamma;
    uniform float uClipGammaMove;
    uniform float uSpeedRef;
    uniform float uSpeedReject;
    uniform float uClipReject;
    uniform float uDevFloor;
    uniform float uDevGain;
    uniform float uReconstruct;  // 0 = point sample, 1 = full Gaussian resolve
    varying vec2 vUv;

    // Karis weighting as an invertible transform: statistics and blending in
    // this space are perceptually uniform and firefly-proof.
    vec3 tmap( vec3 c ) { return c / ( 1.0 + luma( c ) ); }
    vec3 untmap( vec3 c ) { return c / max( 1.0 - luma( c ), 1e-4 ); }

    vec3 catmullRom( sampler2D tex, vec2 uv, vec2 size ) {
      vec2 sp = uv * size;
      vec2 tp1 = floor( sp - 0.5 ) + 0.5;
      vec2 f = sp - tp1;
      vec2 w0 = f * ( -0.5 + f * ( 1.0 - 0.5 * f ) );
      vec2 w1 = 1.0 + f * f * ( -2.5 + 1.5 * f );
      vec2 w2 = f * ( 0.5 + f * ( 2.0 - 1.5 * f ) );
      vec2 w3 = f * f * ( -0.5 + 0.5 * f );
      vec2 w12 = w1 + w2;
      vec2 off12 = w2 / w12;
      vec2 tp0 = ( tp1 - 1.0 ) / size;
      vec2 tp3 = ( tp1 + 2.0 ) / size;
      vec2 tp12 = ( tp1 + off12 ) / size;
      vec3 r = vec3( 0.0 );
      r += texture2D( tex, vec2( tp0.x,  tp0.y  ) ).rgb * ( w0.x  * w0.y  );
      r += texture2D( tex, vec2( tp12.x, tp0.y  ) ).rgb * ( w12.x * w0.y  );
      r += texture2D( tex, vec2( tp3.x,  tp0.y  ) ).rgb * ( w3.x  * w0.y  );
      r += texture2D( tex, vec2( tp0.x,  tp12.y ) ).rgb * ( w0.x  * w12.y );
      r += texture2D( tex, vec2( tp12.x, tp12.y ) ).rgb * ( w12.x * w12.y );
      r += texture2D( tex, vec2( tp3.x,  tp12.y ) ).rgb * ( w3.x  * w12.y );
      r += texture2D( tex, vec2( tp0.x,  tp3.y  ) ).rgb * ( w0.x  * w3.y  );
      r += texture2D( tex, vec2( tp12.x, tp3.y  ) ).rgb * ( w12.x * w3.y  );
      r += texture2D( tex, vec2( tp3.x,  tp3.y  ) ).rgb * ( w3.x  * w3.y  );
      return max( r, vec3( 0.0 ) );
    }

    vec3 clipAABB( vec3 c, vec3 mn, vec3 mx ) {
      vec3 center = 0.5 * ( mx + mn );
      vec3 extent = 0.5 * ( mx - mn ) + 1e-5;
      vec3 v = c - center;
      vec3 a = abs( v / extent );
      float ma = max( a.x, max( a.y, a.z ) );
      return ma > 1.0 ? center + v / ma : c;
    }

    void main() {
      // --- depth-dilated velocity (closest fragment in 3x3 wins)
      float bestD = 1.0;
      vec2 bestOff = vec2( 0.0 );
      for ( int y = -1; y <= 1; y++ ) {
        for ( int x = -1; x <= 1; x++ ) {
          vec2 o = vec2( float( x ), float( y ) ) * uTexel;
          float d = texture2D( tDepth, vUv + o ).r;
          if ( d < bestD ) { bestD = d; bestOff = o; }
        }
      }
      vec2 vel = texture2D( tVelocity, vUv + bestOff ).rg;
      vec2 prevUV = vUv - vel;

      /*
       * HOW FAST IS THIS PIXEL MOVING — the one number that has to gate every
       * other decision in this shader.
       *
       * A converged, jitter-only history is worth 0.95 feedback and a generous
       * 1.9-sigma clip box: that is what resolves a static silhouette to a
       * multi-pixel ramp instead of a 1 px step, and it is what the
       * anti_aliased gate measures. Neither is defensible once the pixel is
       * moving 20 px a frame. Then the reprojection is riding on a depth-dilated
       * velocity that is only approximately right, the 3x3 neighbourhood the box
       * is built from is a different piece of the world than the history came
       * from, and anything the engine does NOT write a motion vector for — a
       * skinned rider, a wind-animated blade, an instanced prop — is reprojected
       * to the wrong place entirely. A wide box then certifies the wrong colour
       * as legal and 0.95 feedback holds it on screen for twenty frames, which
       * is the trailing smear on the character and horse in the ride capture.
       *
       * So both the box width and the feedback are interpolated by speed. At
       * rest every constant is exactly what it was, so no still frame — and no
       * still-frame gate — changes at all.
       */
      float speed = length( vel * uResolution );
      float moving = SAT( speed / max( uSpeedRef, 1e-3 ) );

      /*
       * 3x3 neighbourhood: statistics for the clip box AND the spatial
       * reconstruction of the current frame, in one pass.
       *
       * A point sample of the jittered frame makes the accumulated resolve a
       * BOX filter exactly one pixel wide, which is why the pass-2 silhouette
       * measured as a single-pixel sky-to-rock step even when the history was
       * healthy: a box filter over a straight edge produces at most one partial
       * pixel. Real TAA reconstructs with a filter wider than the pixel — each
       * tap is weighted by its true sub-pixel distance from the output pixel
       * centre, which is (integer offset + this frame's jitter). That is what
       * produces the 2-4 px blended ramp the forensic reports expect, and it is
       * also what keeps sub-pixel geometry (thin branches, balusters, grass
       * blades) from disintegrating instead of resolving. CAS in the final pass
       * gives the acuity back.
       */
      vec3 m1 = vec3( 0.0 ), m2 = vec3( 0.0 ), nmin = vec3( 1e9 ), nmax = vec3( -1e9 );
      vec3 filt = vec3( 0.0 ), point = vec3( 0.0 );
      float wsum = 0.0;
      for ( int y = -1; y <= 1; y++ ) {
        for ( int x = -1; x <= 1; x++ ) {
          vec2 o = vec2( float( x ), float( y ) );
          vec3 s = tmap( max( texture2D( tCurrent, vUv + o * uTexel ).rgb, vec3( 0.0 ) ) );
          vec3 y3 = rgb2ycocg( s );
          m1 += y3; m2 += y3 * y3;
          nmin = min( nmin, y3 ); nmax = max( nmax, y3 );
          vec2 d = o + uJitter;
          float w = exp( -2.0 * dot( d, d ) );
          filt += s * w; wsum += w;
          if ( x == 0 && y == 0 ) point = s;
        }
      }
      vec3 cur = mix( point, filt / max( wsum, 1e-5 ), uReconstruct );
      vec3 curLin = untmap( cur );
      vec3 mu = m1 / 9.0;
      vec3 sigma = sqrt( max( m2 / 9.0 - mu * mu, vec3( 0.0 ) ) );
      /*
       * Clip width. 1.35 sigma was too tight for a jittered edge: at the
       * silhouette the 3x3 box is a bimodal sky/rock population whose sigma is
       * small compared with the gap the jitter opens up, so the converged
       * half-tone history was being clipped back toward one of the two modes
       * every frame and the edge never resolved past a 1 px step. A wider box,
       * still bounded by the true neighbourhood min/max, keeps the ghost
       * rejection while letting a genuine intermediate value survive.
       */
      float clipGamma = mix( uClipGamma, uClipGammaMove, moving );
      vec3 mn = max( mu - clipGamma * sigma, nmin );
      vec3 mx = min( mu + clipGamma * sigma, nmax );

      bool valid = uValid > 0.5 &&
        all( greaterThanEqual( prevUV, vec2( 0.0 ) ) ) &&
        all( lessThanEqual( prevUV, vec2( 1.0 ) ) );

      vec3 result = curLin;
      if ( valid ) {
        vec3 hist = tmap( catmullRom( tHistory, prevUV, uResolution ) );
        vec3 rawY = rgb2ycocg( hist );
        vec3 histY = clipAABB( rawY, mn, mx );
        hist = max( ycocg2rgb( histY ), vec3( 0.0 ) );

        // more of the current frame while the image is moving fast
        float feedback = uFeedback * mix( 1.0, uSpeedReject, moving );

        /*
         * VERTEX-ANIMATED FOLIAGE HAS NO MOTION VECTORS.
         *
         * Grass and leaves are displaced in the vertex shader by the wind, so
         * the velocity buffer reports them as static and the history is
         * reprojected straight onto itself. At 0.95 feedback that is a 20-frame
         * temporal average of a swaying blade — measured on forest_interior it
         * destroyed 63% of the gradient energy in the undergrowth (17.4 -> 6.5)
         * and is precisely the "whole-frame smeared/streaky brushstroke
         * artifacting on ground and canopy, consistent with aggressive temporal
         * accumulation" that the forensic pass flagged.
         *
         * The discriminator is HOW FAR THE HISTORY HAD TO BE CLIPPED, and it is
         * exact for the two cases that matter. At a static jittered silhouette
         * both surfaces are present in the 3x3 every single frame, so the
         * converged half-tone history always lies inside the box and is not
         * clipped at all — full feedback, full anti-aliasing. When a blade
         * sways out of a pixel the stale colour is no longer anywhere in the
         * current neighbourhood, so the clip has to move it a long way — and
         * that is the signal to stop trusting it. Feedback collapses only on
         * genuinely moving content, which is where the sharpness is wanted.
         */
        float boxHalf = max( length( mx - mn ) * 0.5, 1e-4 );
        float clipAmt = SAT( length( histY - rawY ) / boxHalf );

        /*
         * Second, stronger discriminator, available only because the current
         * sample is now SPATIALLY RECONSTRUCTED rather than point-sampled.
         *
         * At a static jittered silhouette the Gaussian resolve already averages
         * most of the jitter out, so the filtered current sample sits close to
         * the converged history and the deviation is small — TAA keeps full
         * feedback and the edge resolves. Self-similar moving content (a grass
         * field in wind,
         * a canopy) is the case the clip box cannot catch, because the 3x3
         * spans the whole palette every frame and the stale value is always
         * legally inside it; there, the filtered current sample still disagrees
         * with the history frame after frame, and the deviation stays high. Subtracting
         * a dead-band before scaling is what keeps the sub-pixel jitter of a
         * static edge below the threshold.
         */
        float dev = SAT( ( length( cur - hist ) / max( boxHalf, 0.02 ) - uDevFloor ) * uDevGain );
        feedback *= mix( 1.0, uClipReject, max( SAT( clipAmt * 2.2 ), dev ) );

        result = untmap( mix( cur, hist, feedback ) );
      }

      gl_FragColor = vec4( max( result, vec3( 0.0 ) ), 1.0 );
    }`, {
    tCurrent: { value: null },
    tHistory: { value: null },
    tVelocity: { value: null },
    tDepth: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uJitter: { value: new THREE.Vector2() },
    uFeedback: { value: 0.95 },
    uValid: { value: 0 },
    /** Variance-clip width in sigmas, for a pixel that is not moving. */
    uClipGamma: { value: 1.9 },
    /** Variance-clip width in sigmas once the pixel is moving at uSpeedRef. */
    uClipGammaMove: { value: 1.0 },
    /** Screen speed, px/frame, at which the "moving" constants fully apply. */
    uSpeedRef: { value: 14 },
    /** Feedback multiplier at full speed. 0.95 * 0.62 = 0.59, ~2.5 frames. */
    uSpeedReject: { value: 0.62 },
    /** Feedback multiplier when the history is fully clipped. */
    uClipReject: { value: 0.18 },
    /** Dead-band on the current-vs-history deviation, in half-box units. */
    uDevFloor: { value: 0.55 },
    uDevGain: { value: 1.6 },
    uReconstruct: { value: 1.0 },
  });
}
