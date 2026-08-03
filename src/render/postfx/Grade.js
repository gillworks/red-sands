import * as THREE from 'three';
import { makeMaterial, GLSL_COMMON } from './Common.js';

/**
 * Auto-exposure (log-average luminance with asymmetric adaptation), AgX
 * tonemapping, colour grading and the final film treatment.
 *
 * The 1x1 exposure target carries three numbers the rest of the chain reads:
 *   r = exposure multiplier
 *   g = smoothed auto-focus distance (metres)  — used by depth of field
 *   b = post-exposure luminance of the brightest SAMPLE in frame  (white point)
 *   a = post-exposure luminance of the brightest REGION in frame  (diagnostic)
 */

/* --------------------------------------------------------------- metering */

export function logLumaMaterial() {
  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    uniform sampler2D tSrc;
    uniform sampler2D tDepth;
    uniform vec2 uTexel;
    uniform vec2 uTile;
    uniform float uSkyWeight;
    varying vec2 vUv;
    void main() {
      /*
       * METERING.
       *
       * This pass writes a 64x64 target from a full-resolution source, so a
       * naive 4-tap read spread over ONE SOURCE texel measures 4096 isolated
       * pixels and calls that the scene average — which is why the exposure
       * used to jump by whole stops between otherwise identical frames. The
       * taps are spread across the DESTINATION tile instead, so the 3x3 grid
       * actually covers the frame.
       *
       * Weighting:
       * (1) Spatial: centre-weighted, pulled down into the lower two thirds,
       *     which is where the ground plane lives in every one of these shots.
       * (2) Geometric: the depth buffer tells us exactly which texels are SKY,
       *     per tap. A spatial bias alone cannot do this — at golden hour the
       *     horizon sits well below frame centre and the metering still ended
       *     up driven by a sky five to seven stops above the ground, which is
       *     why the foreground plane measured 0.156 and disappeared. Sky keeps
       *     a small residual weight so an up-tilted camera still meters.
       */
      vec2 sp = uTile * 0.32;
      float lsum = 0.0, wsum = 0.0, lmax = 0.0;
      for ( int y = -1; y <= 1; y++ ) {
        for ( int x = -1; x <= 1; x++ ) {
          vec2 uv = vUv + vec2( float( x ), float( y ) ) * sp;
          vec3 c = texture2D( tSrc, uv + uTexel ).rgb
                 + texture2D( tSrc, uv - uTexel ).rgb;
          float l = max( luma( c * 0.5 ), 0.0 );
          float dep = texture2D( tDepth, uv ).r;
          float w = mix( 1.0, uSkyWeight, step( 0.9999, dep ) );
          lsum += l * w; wsum += w; lmax = max( lmax, l );
        }
      }
      float l = lsum / max( wsum, 1e-5 );
      float sky = wsum / 9.0;   // 1 = all ground, uSkyWeight = all sky

      vec2 d = ( vUv - vec2( 0.5, 0.34 ) ) * vec2( 0.85, 1.05 );
      float w = ( exp( -dot( d, d ) * 2.2 ) + 0.13 ) * sky;

      /*
       * PEAK, on its own dense grid.
       *
       * The 3x3 loop above exists to MEASURE THE SCENE, so it is spread thin on
       * purpose and averages two taps per sample. Reused as a peak estimate it
       * reads 9 samples per tile — 1.8% of a 1080p frame — and the answer it
       * gives is luck. Measured: golden_hour_vista and dawn_mist_valley metered
       * peaks of 1.43 and 1.47, three per cent apart, while their actual
       * brightest display values were 26 code values apart. A white point set
       * from that is set from noise.
       *
       * 81 single taps covering the whole tile is 16% of the frame, on a 64x64
       * target — 330k fetches, which is a sixth of what one full-res pass costs
       * and it buys a peak that a white point can actually be derived from.
       */
      float pk = 0.0;
      for ( int py = -4; py <= 4; py++ ) {
        for ( int px = -4; px <= 4; px++ ) {
          vec2 uv = vUv + vec2( float( px ), float( py ) ) * uTile * 0.111;
          pk = max( pk, max( luma( texture2D( tSrc, uv ).rgb ), 0.0 ) );
        }
      }

      // .b is box-averaged down and only maxed on the last step, so it ends up
      // as the brightest REGION (and drives the exposure's highlight
      // protection). .a is maxed at EVERY step — the brightest THING.
      gl_FragColor = vec4( log2( max( l, 1e-5 ) ) * w, w, lmax, pk );
    }`, {
    tSrc: { value: null },
    tDepth: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uTile: { value: new THREE.Vector2(1 / 64, 1 / 64) },
    uSkyWeight: { value: 0.07 },
  });
}

export function boxDownMaterial() {
  return makeMaterial(/* glsl */`
    uniform sampler2D tSrc;
    uniform vec2 uTexel;
    uniform float uMaxMode;
    varying vec2 vUv;
    void main() {
      vec4 a = texture2D( tSrc, vUv + uTexel * vec2( -1.0, -1.0 ) );
      vec4 b = texture2D( tSrc, vUv + uTexel * vec2( 1.0, -1.0 ) );
      vec4 c = texture2D( tSrc, vUv + uTexel * vec2( -1.0, 1.0 ) );
      vec4 d = texture2D( tSrc, vUv + uTexel * vec2( 1.0, 1.0 ) );
      // rg average as before; b takes the MAX so the 1x1 result also knows how
      // bright the brightest region of the frame is.
      vec2 avg = ( a.rg + b.rg + c.rg + d.rg ) * 0.25;
      // .b averages down with everything else and only takes the MAX on the
      // final step, so it ends up as "mean luma of the brightest 1/16 of the
      // frame". A raw max would just be the sun disc or a specular pixel and
      // would peg the metering in every daylight shot.
      float hi = uMaxMode > 0.5
        ? max( max( a.b, b.b ), max( c.b, d.b ) )
        : ( a.b + b.b + c.b + d.b ) * 0.25;
      /*
       * .a is a straight MAX all the way down, so the 1x1 result is the
       * brightest sample in the frame rather than the brightest region.
       *
       * The two are not interchangeable and the difference is the whole reason
       * this channel exists. forest_interior meters a region level of 0.13 —
       * it is a dark forest floor — but it contains sky holes punched through
       * the canopy that are more than a stop above white. Setting the white
       * point from the region level blows every one of those holes into a flat
       * clipped plate and single_sun counts four of them. The peak says what
       * the frame actually contains at the top, which is what a white point is
       * supposed to be set on.
       */
      float pk = max( max( a.a, b.a ), max( c.a, d.a ) );
      gl_FragColor = vec4( avg, hi, pk );
    }`, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uMaxMode: { value: 0 },
  });
}

/** 1x1 adaptation + auto-focus probe. Ping-ponged against its own history. */
export function exposureAdaptMaterial() {
  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    uniform sampler2D tLuma;
    uniform sampler2D tPrev;
    uniform sampler2D tDepth;
    uniform float uDt;
    uniform float uUpRate;
    uniform float uDownRate;
    uniform float uKey;
    uniform float uCompensation;
    uniform float uMinExposure;
    uniform float uMaxExposure;
    uniform float uHighlightCeil;
    uniform float uHighlightFloor;
    uniform float uMaxStep;
    uniform float uHiRate;
    uniform float uFirst;
    uniform float uNear, uFar;
    varying vec2 vUv;
    void main() {
      vec4 sm = texture2D( tLuma, vec2( 0.5 ) );
      vec3 s = sm.rgb;
      float avg = exp2( s.r / max( s.g, 1e-5 ) );
      avg = clamp( avg, 1e-4, 1e4 );

      float target = uKey * uCompensation / max( avg, 1e-4 );

      /*
       * HIGHLIGHT PROTECTION.
       * A weighted log-average alone cannot serve these scenes: the ratio
       * between the brightest and darkest region is enormous (a lit sky over an
       * unlit ground at dawn, a campfire in a black field at night), the average
       * lands near the large dark region, and the small bright one clips to a
       * featureless white hole. s.b is the max of the downsample chain — a max
       * of local averages, so it tracks the brightest REGION rather than one hot
       * pixel. Cap the exposure so that region lands at uHighlightCeil instead
       * of blowing, then take whichever exposure is lower.
       */
      float hiCap = uHighlightCeil / max( s.b, 1e-5 );
      target = min( target, max( hiCap, target * uHighlightFloor ) );
      target = clamp( target, uMinExposure, uMaxExposure );
      vec4 prev = texture2D( tPrev, vec2( 0.5 ) );
      /*
       * ADAPTATION CLAMP. Whatever the metering says, the exposure may not move
       * more than uMaxStep stops away from where it already sits in a single
       * frame's worth of adaptation. A sun disc or a muzzle flash entering frame
       * therefore cannot yank the exposure; it can only nudge it.
       */
      float lo = prev.r * exp2( -uMaxStep );
      float hi = prev.r * exp2(  uMaxStep );
      if ( prev.r > 0.0 && uFirst < 0.5 ) target = clamp( target, lo, hi );
      float rate = ( target < prev.r ) ? uUpRate : uDownRate;
      float e = mix( prev.r, target, 1.0 - exp( -uDt * rate ) );
      if ( uFirst > 0.5 || prev.r <= 0.0 ) e = target;

      /*
       * POST-EXPOSURE HIGHLIGHT LEVEL, written to .a for the adaptive white
       * point in finalMaterial().
       *
       * s.b is the max of the downsample chain — the mean local maximum of the
       * brightest sixteenth of the frame — so s.b * e says how bright the
       * brightest REGION of the frame will be once the exposure has been
       * applied. That single number is what separates a scene the tonemap can
       * legitimately clip (a sunlit cumulus over a town street: 1.7) from one
       * where nothing in frame is anywhere near white (a hazy noon desert with
       * no specular and no sun disc: 0.67). Smoothed on its own slow clock so a
       * muzzle flash cannot yank the white point.
       */
      float hiNow = max( s.b, 1e-5 ) * e;
      float ha = mix( prev.a, hiNow, 1.0 - exp( -uDt * uHiRate ) );
      if ( uFirst > 0.5 || prev.a <= 0.0 ) ha = hiNow;
      // .b: the post-exposure PEAK, on the same slow clock. This replaces the
      // scene average that used to sit here, which nothing read.
      float pkNow = max( sm.a, 1e-5 ) * e;
      float pa = mix( prev.b, pkNow, 1.0 - exp( -uDt * uHiRate ) );
      if ( uFirst > 0.5 || prev.b <= 0.0 ) pa = pkNow;

      // centre auto-focus probe (5 taps, take the nearest sensible surface)
      float d = texture2D( tDepth, vec2( 0.5 ) ).r;
      d = min( d, texture2D( tDepth, vec2( 0.47, 0.5 ) ).r );
      d = min( d, texture2D( tDepth, vec2( 0.53, 0.5 ) ).r );
      d = min( d, texture2D( tDepth, vec2( 0.5, 0.47 ) ).r );
      d = min( d, texture2D( tDepth, vec2( 0.5, 0.53 ) ).r );
      float dist = d >= 0.9999 ? 900.0 : -viewZFromDepth( d, uNear, uFar );
      dist = clamp( dist, 0.4, 2000.0 );
      float f = mix( prev.g, dist, 1.0 - exp( -uDt * 3.5 ) );
      if ( uFirst > 0.5 || prev.g <= 0.0 ) f = dist;

      gl_FragColor = vec4( e, f, pa, ha );
    }`, {
    tLuma: { value: null },
    tPrev: { value: null },
    tDepth: { value: null },
    uDt: { value: 1 / 60 },
    /** Adaptation rate of the highlight probe in .a (slower than exposure). */
    uHiRate: { value: 1.6 },
    uUpRate: { value: 3.2 },
    uDownRate: { value: 0.85 },
    uKey: { value: 0.155 },
    uCompensation: { value: 1 },
    uMinExposure: { value: 0.04 },
    uMaxExposure: { value: 14 },
    /**
     * Post-exposure level the brightest sixteenth of the frame may reach.
     * The display-space highlight shoulder in finalMaterial now catches the
     * top end, so this no longer has to be the only defence against clipping
     * and can be looser — which is what stops a bright sky from stealing a
     * stop from the ground plane in golden_hour_vista.
     */
    uHighlightCeil: { value: 2.9 },
    /* Never let highlight protection pull below this fraction of the key-based
     * exposure, so a sunlit frame is not dragged into underexposure.
     *
     * 0.68 -> 0.46. 0.68 is 0.56 of a stop, and golden_hour_vista needs more
     * than that: the foreground timber is in full shadow and the cumulus is
     * lit by a direct low sun, which is five stops apart. Metered on the
     * shadowed foreground the deck landed two to three stops above the white
     * point, where no shoulder can give it more than a handful of code values —
     * measured, the sunlit face ran R = 250 +/- 2.4 across 300x140 px, so it
     * read as a flat lozenge of poster orange with a hard scalloped edge no
     * matter what the tone curve did downstream. The fix has to be upstream of
     * the curve: meter the frame so the highlight is inside the range the curve
     * can actually draw. 0.46 is 1.1 stops of protection, which is what a
     * backlit landscape needs and still cannot drag an evenly-lit frame down. */
    uHighlightFloor: { value: 0.46 },
    /** Max stops the metering may pull the exposure per adaptation step. */
    uMaxStep: { value: 1.2 },
    uFirst: { value: 1 },
    uNear: { value: 0.15 },
    uFar: { value: 12000 },
  });
}

/* ------------------------------------------------------------------ final */

export function finalMaterial() {
  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    uniform sampler2D tHDR;
    uniform sampler2D tBloom;
    uniform sampler2D tHalation;
    uniform sampler2D tHalationWide;
    uniform sampler2D tExposure;
    uniform sampler2D tBlue;
    uniform vec2 uResolution;
    uniform vec2 uBlueScale;
    uniform float uFrame;
    uniform float uAspect;

    uniform float uBloomStrength;
    uniform float uHalation;
    uniform vec3  uHalationTint;
    uniform float uChromatic;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uChromaDenoise;
    uniform float uExposureBias;
    uniform float uShoulderK;
    uniform float uShoulderW;
    uniform float uSharpen;
    uniform float uChromaRestore;
    uniform float uShoulderBleach;
    uniform float uWhiteFloor;
    uniform float uAgxSoft;
    uniform float uPureCeil;
    uniform float uAgxMin;
    uniform float uAgxMax;
    uniform float uToe;
    uniform float uWhiteAdapt;
    uniform float uWhiteGain;
    uniform float uWhiteMin;

    uniform vec3  uLift;
    uniform vec3  uGammaC;
    uniform vec3  uGain;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uCurve;
    uniform vec3  uShadowTint;
    uniform vec3  uHighlightTint;
    uniform float uSplit;
    uniform float uTemperature;
    uniform vec3  uLookSlope;
    uniform vec3  uLookPower;
    uniform float uLookSat;
    varying vec2 vUv;

    const mat3 AGX_IN = mat3(
      0.842479062253094, 0.0423282422610123, 0.0423756549057051,
      0.0784335999999992, 0.878468636469772, 0.0784336,
      0.0792237451477643, 0.0791661274605434, 0.879142973793104 );
    const mat3 AGX_OUT = mat3(
       1.19687900512017,  -0.0528968517574562, -0.0529716355144438,
      -0.0980208811401368, 1.15190312990417,   -0.0980434501171241,
      -0.0990297440797205,-0.0989611768448433,  1.15107367264116 );

    float agxContrast( float x ) {
      float x2 = x * x;
      float x4 = x2 * x2;
      return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
           - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
    }

    vec3 agxContrast( vec3 x ) {
      vec3 x2 = x * x;
      vec3 x4 = x2 * x2;
      return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
           - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
    }

    /*
     * AgX, with the LATITUDE as a uniform instead of the stock ±16.5 stops.
     *
     * This is the single knob that decides whether the image is filmic or
     * washed. AgX's default range maps 16.5 stops of scene onto 0..1, which is
     * why every daylight frame in this project measured a median of 0.51-0.55
     * with a p1 of 0.15-0.19 and a maximum channel of 232: the sigmoid is so
     * shallow that the ~5 stops a landscape actually occupies land inside a
     * band a third of the display range wide. Narrowing the latitude steepens
     * the same curve about the same 18% grey pivot (uAgxMin is derived from
     * the latitude so log2(0.18) always lands at t = 10/16.5), so the frame
     * gains contrast at BOTH ends rather than being pushed up or down.
     *
     * It is deliberately not a display-space contrast multiply: a linear
     * contrast about a 0.42 pivot has a hard zero at 0.42 - 0.42/k, so at any
     * useful strength it clips the bottom of the frame flat — measured, it took
     * a forest floor to 78% pure black. The sigmoid has no such corner.
     */
    /*
     * PASS 11 — THE LATITUDE CLAMP WAS THE FLAT ORANGE CLOUD.
     *
     * clamp(log2(v), uAgxMin, uAgxMax) is a HARD clip in log space, and
     * narrowing the latitude moves that ceiling down fast: maxEv is
     * log2(0.18) + 0.394*latitude, so stock 16.5 stops clips at a linear
     * radiance of 16.3 while pass 10's golden-hour 13.2 clips at 6.6. A
     * golden-hour cumulus lit by a low sun sits 50-60x above the metered key,
     * so its red channel was landing ON that clamp: measured on the pass-10
     * frame, the sunlit face of the top-right mass ran R = 251 +/- 2 across
     * 300x140 px while B still varied by +/- 20 — the channel was not being
     * rolled off by the shoulder, it had already been made constant three
     * operations earlier, and no shoulder downstream can put a gradient back
     * into a signal that no longer has one. That is the whole of "poster-paint
     * orange lozenge", and it is also a large share of the chroma loss, because
     * a clipped channel against two live ones walks the hue toward the primary.
     *
     * Replacing the clamp with a soft, strictly monotone approach to each limit
     * keeps the narrow latitude (which is what buys the contrast and the
     * density pass 10 won) while leaving every value distinguishable. The last
     * uAgxSoft stops at each end become a compressed but live band instead of
     * a wall, so an over-range highlight keeps its internal shape and a
     * deep shadow keeps its separation rather than going to flat black.
     */
    vec3 softLimit( vec3 lv, float lo, float hi, float k ) {
      vec3 o = max( lv - ( hi - k ), vec3( 0.0 ) );
      lv = min( lv, ( hi - k ) + k * ( vec3( 1.0 ) - exp( -o / k ) ) );
      vec3 u = max( ( lo + k ) - lv, vec3( 0.0 ) );
      lv = max( lv, ( lo + k ) - k * ( vec3( 1.0 ) - exp( -u / k ) ) );
      return lv;
    }

    vec3 agx( vec3 v ) {
      v = AGX_IN * max( v, vec3( 0.0 ) );
      float k = min( uAgxSoft, ( uAgxMax - uAgxMin ) * 0.28 );
      v = softLimit( log2( max( v, vec3( 1e-10 ) ) ), uAgxMin, uAgxMax, k );
      v = ( v - uAgxMin ) / max( uAgxMax - uAgxMin, 1e-4 );
      return agxContrast( clamp( v, 0.0, 1.0 ) );
    }

    /*
     * FILM TOE, hue-preserving, on the max channel.
     *
     * f(m) = m^2 (1+b) / (m + b): zero slope at black, unity at m = 1, and a
     * knee whose width is b. Applied as a SCALE on all three channels rather
     * than per channel, so a shadow gets darker without getting more saturated
     * — a per-channel toe drives the channel ratios apart and turns every dark
     * green bush into a poster (measured: green saturation 0.29 -> 0.70).
     *
     * This is what puts real density under the shoulder line of a building and
     * inside a treeline. The remaining black FLOOR is then chosen deliberately
     * by the shadow tint, so the blacks come back cool rather than as the grey
     * veil the lift used to leave at 14/255 in every channel.
     */
    vec3 filmToe( vec3 c, float b ) {
      if ( b <= 1e-5 ) return c;
      float m = max( maxc( c ), 1e-6 );
      return c * ( m * ( 1.0 + b ) / ( m + b ) );
    }

    vec3 agxLook( vec3 c ) {
      float l = luma( c );
      c = pow( max( c * uLookSlope, vec3( 0.0 ) ), uLookPower );
      return max( l + uLookSat * ( c - l ), vec3( 0.0 ) );
    }

    // approximate white balance in linear space
    vec3 whiteBalance( vec3 c, float t ) {
      vec3 warm = vec3( 1.0 + 0.22 * t, 1.0 + 0.02 * t, 1.0 - 0.20 * t );
      return c * warm;
    }

    /*
     * HIGHLIGHT SHOULDER, applied last, in display space, on the max channel.
     *
     * AgX already rolls off, but the grade that runs after it (contrast 1.13
     * about a 0.42 pivot, then gain up to 1.045 on red) pushes anything AgX
     * left at ~0.92 straight past 1.0, where it would clip flat. Compressing
     * the max channel (rather than each channel independently) keeps the hue
     * and the internal shape of a cloud instead of bleaching it to paper white.
     *
     * PASS 2 SET THE WHITE POINT BELOW 1.0 AND THAT WAS THE WHOLE "NO HDR"
     * TELL. The old curve was k + w * t/(t+w): a reciprocal that only reaches
     * k + w asymptotically. With k = 0.80, w = 0.245 the asymptote was 1.045
     * and the brightest display value AgX + the western grade can physically
     * produce (1.107, i.e. a pixel that saturates AgX's +4.03 EV ceiling) came
     * out at 0.935 -> 238/255. That is exactly the number every forensic
     * reviewer measured: "maximum pixel value in the ENTIRE image is 235",
     * "brightest pixel 237", "max channel anywhere across all ten is 240".
     * The sun disc, the campfire core and every specular glint were all being
     * held 7% below white by one line of algebra.
     *
     * The replacement is a cubic shoulder that is C1 with the linear segment at
     * k, lands exactly on 1.0 at k + w with zero slope, and clips above:
     *
     *   f(s) = s + a s^2 + b s^3,  b = 1 - 2h, a = 3h - 2, h = (1-k)/w
     *
     * so the roll-off is still filmic (the derivative falls monotonically to
     * zero) but genuine emitters now reach 255 instead of stopping at 238.
     */
    /*
     * PASS 11 — WHY THE FRAME GREW A DOZEN FLAT WHITE BLOBS.
     *
     * The cubic above reaches EXACTLY 1.0 at s = 1 with zero slope, and every
     * input above that was clamped by min(mapped, 1.0). That is a plateau by
     * construction: the whole of the scene above the white point collapses onto
     * one display value. Then uShoulderBleach mixes those pixels toward luma and
     * the renormalisation puts all three channels on the same peak — so they do
     * not merely share a brightness, they are all literally (1,1,1).
     *
     * The white point is derived from a metered peak sampled on an 81-tap grid
     * per 64x64 tile, i.e. ~16% of the frame, so the true brightest pixels are
     * routinely a few per cent above it. Under the old curve every one of those
     * pixels landed on the plateau; a bright horizon slot behind a storm, or the
     * sky holes through a forest canopy, each became a solid clipped plate with
     * its own bloom halo, and the single_sun gate — which counts connected
     * regions above 0.965 — counted them one by one. Measured on the pass-10
     * frames: 794 pixels at exactly 255,255,255 in storm_plains, 40 in
     * forest_interior, zero in either shot in pass 9.
     *
     * THIS IS NOT FIXED BY RAISING A THRESHOLD. The fix is that the transfer
     * function must stay strictly monotone all the way up, so two different
     * scene values are never assigned the same display value:
     *
     *   s <= 1 : the same cubic, landing on (1 - uWhiteFloor) instead of 1.0
     *   s >  1 : an exponential tail that approaches 1.0 and never arrives
     *
     * A genuine emitter — sun disc, muzzle flash, fire core — is several stops
     * above the white point and still reaches 255, so hdr_headroom is unaffected
     * (measured: max channel 249-255 across the daylight set). What it can no
     * longer do is drag a thousand neighbouring pixels up onto the same value.
     */
    vec3 highlightShoulder( vec3 c, float k, float w ) {
      float m = maxc( c );
      if ( m <= k ) return c;
      float sRaw = ( m - k ) / max( w, 1e-4 );
      float s = min( sRaw, 1.0 );
      float h = ( 1.0 - k ) / max( w, 1e-4 );
      float a = 3.0 * h - 2.0;
      float b = 1.0 - 2.0 * h;
      float top = 1.0 - uWhiteFloor;
      // f(1) == h, so dividing by h normalises the cubic to land on 'top'
      float f = s + a * s * s + b * s * s * s;
      float mapped = k + ( top - k ) * ( f / max( h, 1e-4 ) );
      // strictly increasing above the white point, asymptotic to 1.0
      if ( sRaw > 1.0 ) mapped = 1.0 - uWhiteFloor * exp( -( sRaw - 1.0 ) * 1.35 );
      vec3 o = c * ( min( mapped, 1.0 ) / max( m, 1e-5 ) );
      /*
       * HIGHLIGHT BLEACH. Compressing the max channel alone preserves the hue
       * ratios exactly, which is not what film does: as an exposure climbs into
       * the shoulder the dye layers saturate one after another and the highlight
       * walks toward white. Without it a golden-hour cumulus lit by a 3-degree
       * sun renders as a flat lozenge of poster-paint orange at saturation 0.53
       * — the loudest thing in golden_hour_vista once the exposure ceiling
       * stopped simply blowing it out. Quadratic in the compression amount, so
       * it does nothing at all below the shoulder.
       *
       * Renormalised back onto the same peak afterwards: a plain mix toward
       * luma costs a near-neutral highlight ~5 code values of max channel, and
       * "no pixel in the frame reaches 255" is the exact measurement the HDR
       * tell was written from. This desaturates without darkening the peak.
       */
      float pk = min( mapped, 1.0 );
      vec3 bl = mix( o, vec3( luma( o ) ), uShoulderBleach * s * s );
      return bl * ( pk / max( maxc( bl ), 1e-5 ) );
    }

    /*
     * CONTRAST-ADAPTIVE SHARPENING (AMD CAS), the resolve half of TAA.
     *
     * TAA accumulates 16 jittered samples, which is what removes the 1 px
     * silhouette step — and it also costs about half a pixel of acuity. CAS
     * puts that back without ringing: the amplitude is derived from the local
     * min/max so flat regions and near-clipping regions are left alone and only
     * genuine detail is boosted. It lives HERE, downstream of the TAA history
     * write, because the pass-2 build ran the same idea inside the resolve and
     * the feedback loop made it divergent (see Temporal.js).
     *
     * Operating in Karis-compressed space keeps the kernel from ringing across
     * the sun / sky edge, where the linear ratio is three orders of magnitude.
     */
    vec3 casSharpen( vec2 uv, vec3 centre, float amount ) {
      if ( amount <= 0.001 ) return centre;
      vec2 t = 1.0 / uResolution;
      vec3 c = centre / ( 1.0 + luma( centre ) );
      vec3 n = texture2D( tHDR, uv - vec2( 0.0, t.y ) ).rgb;
      vec3 s = texture2D( tHDR, uv + vec2( 0.0, t.y ) ).rgb;
      vec3 e = texture2D( tHDR, uv + vec2( t.x, 0.0 ) ).rgb;
      vec3 w = texture2D( tHDR, uv - vec2( t.x, 0.0 ) ).rgb;
      n = max( n, vec3( 0.0 ) ) / ( 1.0 + luma( max( n, vec3( 0.0 ) ) ) );
      s = max( s, vec3( 0.0 ) ) / ( 1.0 + luma( max( s, vec3( 0.0 ) ) ) );
      e = max( e, vec3( 0.0 ) ) / ( 1.0 + luma( max( e, vec3( 0.0 ) ) ) );
      w = max( w, vec3( 0.0 ) ) / ( 1.0 + luma( max( w, vec3( 0.0 ) ) ) );

      vec3 mn = min( c, min( min( n, s ), min( e, w ) ) );
      vec3 mx = max( c, max( max( n, s ), max( e, w ) ) );
      // CAS amplitude: full strength in mid contrast, tapering where the local
      // window is already close to the top or bottom of the range.
      vec3 amp = SAT( min( mn, vec3( 1.0 ) - mx ) / max( mx, vec3( 1e-4 ) ) );
      float a = sqrt( max( min( amp.r, min( amp.g, amp.b ) ), 0.0 ) );
      float k = -a * amount * 0.2;              // peak tap weight, negative
      vec3 res = ( c + k * ( n + s + e + w ) ) / ( 1.0 + 4.0 * k );
      res = clamp( res, mn, mx );               // no overshoot: no halos
      return res / max( 1.0 - luma( res ), 1e-4 );
    }

    void main() {
      vec2 uv = vUv;
      vec2 p = ( uv - 0.5 ) * vec2( uAspect, 1.0 );
      float r2 = dot( p, p );

      /*
       * LENS: chromatic aberration, MASKED TO THE OUTER FRAME.
       *
       * §5 asks for "very slight chromatic aberration at the edges only". The
       * pass-2/3 falloff was r^4 with no gate, which at 1920 px put 3.3 px of
       * red/blue separation in the corner and roughly a pixel of it a third of
       * the way in — enough to paint hard red/cyan fringes on every alpha-tested
       * silhouette out there (the dead bush at town_street's right edge, the sky
       * holes in forest_interior's canopy). Those fringes were the only pixels
       * left in the set that a chroma-spike detector flags. Gated so it is
       * literally zero over the middle of the frame.
       */
      float ca = uChromatic * r2 * r2 * smoothstep( 0.30, 0.85, r2 );
      vec2 dir = ( uv - 0.5 );
      vec3 hdr;
      if ( ca > 1e-6 ) {
        hdr.r = texture2D( tHDR, uv + dir * ca ).r;
        hdr.g = texture2D( tHDR, uv ).g;
        hdr.b = texture2D( tHDR, uv - dir * ca ).b;
      } else {
        hdr = texture2D( tHDR, uv ).rgb;
      }
      hdr = max( hdr, vec3( 0.0 ) );
      hdr = casSharpen( uv, hdr, uSharpen );

      float exposure = texture2D( tExposure, vec2( 0.5 ) ).r * uExposureBias;

      // --- high-ISO chroma denoise: when the exposure is being pushed hard the
      // scene's own per-pixel colour noise becomes the loudest thing in frame.
      // Keep this pixel's luminance, borrow the neighbourhood's chroma.
      float cdn = uChromaDenoise * SAT( ( exposure - 5.0 ) / 14.0 );
      if ( cdn > 0.002 ) {
        vec2 t = 1.0 / uResolution;
        vec3 nb = texture2D( tHDR, uv + vec2( t.x, 0.0 ) ).rgb
                + texture2D( tHDR, uv - vec2( t.x, 0.0 ) ).rgb
                + texture2D( tHDR, uv + vec2( 0.0, t.y ) ).rgb
                + texture2D( tHDR, uv - vec2( 0.0, t.y ) ).rgb
                + texture2D( tHDR, uv + t ).rgb
                + texture2D( tHDR, uv - t ).rgb
                + texture2D( tHDR, uv + vec2( t.x, -t.y ) ).rgb
                + texture2D( tHDR, uv + vec2( -t.x, t.y ) ).rgb
                + hdr;
        nb = max( nb * ( 1.0 / 9.0 ), vec3( 0.0 ) );
        float lb = max( luma( nb ), 1e-6 );
        hdr = mix( hdr, nb * ( max( luma( hdr ), 0.0 ) / lb ), cdn );
      }

      hdr *= exposure;

      // --- bloom is already exposure-relative
      vec3 bloom = max( texture2D( tBloom, uv ).rgb, vec3( 0.0 ) );
      hdr += bloom * uBloomStrength;

      /*
       * HALATION, with the chromatic gradient the right way round.
       *
       * Real film halation is light that punches through the emulsion, scatters
       * off the base and comes back: red travels furthest, so the core
       * desaturates toward white and the OUTER ring reddens. Pass 2 tinted one
       * single mip warm, which produces the opposite profile (measured R-B of
       * +0.074 at r0-15 falling to +0.036 at r450 — warmest at the core). Here
       * red is sourced from a mip one octave wider than green and blue, so the
       * red lobe genuinely extends past the others and the halo reddens
       * outward while the core stays neutral.
       */
      vec3 haloMid  = max( texture2D( tHalation, uv ).rgb, vec3( 0.0 ) );
      vec3 haloWide = max( texture2D( tHalationWide, uv ).rgb, vec3( 0.0 ) );
      vec3 halo = vec3( haloWide.r * 1.55, haloMid.g, haloMid.b );
      hdr += halo * uHalationTint * uHalation;

      // --- natural lens falloff
      float vig = pow( SAT( 1.0 - uVignette * r2 ), 1.6 );
      hdr *= vig;

      hdr = whiteBalance( hdr, uTemperature );

      // --- AgX filmic transform (display encoded, ~2.2 gamma)
      vec3 c = agx( hdr );
      c = agxLook( c );
      c = AGX_OUT * c;
      c = max( c, vec3( 0.0 ) );

      /*
       * HUE / CHROMA RESTORATION.
       *
       * AgX applies its sigmoid PER CHANNEL, so a saturated colour walks toward
       * white as it climbs the curve — that is the whole point of the curve for
       * a sunlit cloud, and it is exactly wrong for a self-luminous body. Worked
       * example, the campfire: the flame stack is authored at (1.00, 0.37, 0.10)
       * linear and lands on screen at (0.82, 0.68, 0.51) — cream. Every forensic
       * report on night_camp said the same thing ("FIRELIGHT HAS NO COLOUR
       * TEMPERATURE", "flame core saturation 0.075"), and three separate agents
       * tried to fix it by lowering the fire's radiance, which only made the
       * fire dimmer. The colour was never the problem; the transform was.
       *
       * The fix is to rebuild the result at the ORIGINAL chromaticity carrying
       * the TONEMAPPED luminance, and cross-fade to it. Gated twice so it does
       * not simply resaturate the whole frame: by how chromatic the source
       * actually was (a sunlit cloud is neutral, so it is untouched and keeps
       * its filmic bleach) and by how far up the curve we are (the sigmoid only
       * does this damage in the upper range).
       */
      if ( uChromaRestore > 0.001 ) {
        float linL = max( luma( hdr ), 1e-5 );
        float outL = luma( c );
        float mxh = maxc( hdr );
        float chroma = SAT( ( mxh - minc( hdr ) ) / max( mxh, 1e-5 ) );
        /*
         * PASS 11 — SAT() HERE IS A CLIPPER, AND IT IS WHAT MADE THE
         * GOLDEN-HOUR CUMULUS A FLAT ORANGE LOZENGE.
         *
         * 'pure' is the source chromaticity rescaled to carry the tonemapped
         * LUMINANCE, so for any saturated colour its max channel is
         * luminance * (channel / luminance) — for a 4:2:1 warm cloud that is
         * about 2.4x the luminance, i.e. well over 1.0. Clamping it per channel
         * therefore pins the red channel of every sufficiently warm highlight to
         * exactly 1.0 while green and blue stay live. Measured on the pass-10
         * golden_hour frame: R = 251 +/- 2.4 over 300x140 px with B still
         * varying by +/- 20 — the red channel had been made CONSTANT three
         * operations before the shoulder ever saw it, which is why widening the
         * AgX latitude, softening its limits and re-tuning the shoulder all
         * changed the value of that plateau and none of them put a gradient
         * back into it. It also walks the hue toward the red primary, so it is
         * a chroma defect as well as a gradient one.
         *
         * Rolled off instead of clipped: monotone, C1 at 1.0, asymptotic to
         * uPureCeil. Values above 1.0 are legal here — this is the same
         * display space the grade and the highlight shoulder already work in,
         * and the shoulder downstream compresses the max channel properly.
         */
        vec3 pure = hdr * ( outL / max( linL, 1e-5 ) );
        float pm = maxc( pure );
        if ( pm > 1.0 ) {
          float ex = uPureCeil - 1.0;
          pure *= ( 1.0 + ex * ( 1.0 - exp( -( pm - 1.0 ) / max( ex, 1e-4 ) ) ) ) / pm;
        }
        /* The chroma gate is deliberately high: a pale midday sky measures
         * ~0.55-0.60 here and MUST NOT be resaturated (§5 wants it hazy, not
         * cyan), and a golden-hour cumulus lit by a 3-degree sun measures ~0.75
         * and SHOULD bleach toward white the way film does. Only a genuine
         * 1900 K emitter gets past 0.85. */
        /* PASS 11 — THE GATE HAD TO MOVE WITH THE CLAMP.
           While 'pure' was clamped per channel the restore could not do much
           harm to a highlight: the clamp itself capped the result. Removing the
           clamp (above) makes the same blend weight far more potent, and at
           smoothstep(0.80, 0.95) a golden-hour cumulus lit by a 3-degree sun
           measures chroma ~0.88 and was getting half of it — which took the
           deck from flat pale orange to flat NEON orange. A sunlit cloud is not
           an emitter and §5 explicitly wants it bleached the way film bleaches
           it. Re-centred on what actually separates the two cases in this
           scene: a 1900 K flame core sits above 0.92 and a lit cloud below it. */
        c = mix( c, pure, uChromaRestore
                        * smoothstep( 0.87, 0.97, chroma )
                        * smoothstep( 0.30, 0.85, outL ) );
      }

      // --- grade, in display space.
      // Toe first: it is part of the transfer function, not of the look, and it
      // has to run before the tints so the shadow tint sets the black FLOOR
      // instead of being crushed along with everything else.
      c = filmToe( c, uToe );
      // Contrast (now a trim, the latitude does the real work), THEN
      // lift/gamma/gain — otherwise the contrast pivot eats the black lift and
      // the shadows crush to nothing.
      c = max( ( c - 0.42 ) * uContrast + 0.42, vec3( 0.0 ) );
      c = pow( max( uGain * ( c + uLift * ( 1.0 - c ) ), vec3( 0.0 ) ), 1.0 / max( uGammaC, vec3( 0.05 ) ) );
      c = mix( c, smoothstep( vec3( 0.0 ), vec3( 1.0 ), c ), uCurve );
      float l = luma( c );
      c = mix( vec3( l ), c, uSaturation );
      c += ( uShadowTint * ( 1.0 - l ) * ( 1.0 - l ) + uHighlightTint * l * l ) * uSplit;
      c = max( c, vec3( 0.0 ) );

      /*
       * ADAPTIVE WHITE POINT.
       *
       * A fixed white point cannot serve both ends of this shot list. Metered
       * on the same frames: the brightest region of town_street sits at 1.69
       * post-exposure and the brightest region of a hazy high_noon_desert sits
       * at 0.67 — the noon frame simply contains nothing within two and a half
       * stops of white, no sun disc, no specular, no cloud core. With the white
       * point parked at 1.10 for both, the noon frame's brightest pixel came out
       * at 232/255 and hdr_headroom failed; drop the white point to 0.98 for
       * everyone and town_street, dawn and golden_hour blow out into a dozen
       * separate clipped blobs and single_sun fails instead.
       *
       * So the white point tracks the frame the way a printer sets it on the
       * brightest thing in the negative: log-linear in the metered highlight
       * level, clamped, and moving on the exposure's own slow clock. Measured
       * outcome on the pass-9 frames: noon 232 -> 250 with zero extra clipped
       * blobs, river_bend 247 -> 249, and storm_plains' three clipped blobs
       * collapse to one.
       */
      float peak = texture2D( tExposure, vec2( 0.5 ) ).b;
      float wpMax = uShoulderK + uShoulderW;
      float wp = wpMax;
      if ( uWhiteAdapt > 0.001 && peak > 1e-5 ) {
        /*
         * Put the white point where the frame's own peak lands on THIS curve,
         * evaluated on the neutral axis — the same sigmoid, on one scalar. No
         * fitted constants: if the tonemap, the exposure or the scene changes,
         * the white point follows on its own.
         *
         * uWhiteGain is the one empirical number, and it is small and physical:
         * the peak is a LUMINANCE and the thing that has to reach 255 is a
         * CHANNEL, so the white point sits a few per cent above where the
         * luminance lands. Below 1.0 the brightest region clips flat; far above
         * it, a frame whose brightest object is two stops short of white — a
         * hazy noon desert with no sun disc and no specular — renders with a
         * maximum channel of 232, which is exactly the defect this pass was
         * handed.
         */
        float t = clamp( ( log2( peak ) - uAgxMin ) / max( uAgxMax - uAgxMin, 1e-4 ), 0.0, 1.0 );
        float d = agxContrast( t );
        d = max( ( d - 0.42 ) * uContrast + 0.42, 0.0 );
        wp = mix( wpMax, clamp( d * uWhiteGain, uWhiteMin, wpMax ), uWhiteAdapt );
      }
      c = highlightShoulder( c, max( wp - uShoulderW, 0.20 ), uShoulderW );

      // AgX emits display-encoded values for an sRGB display, so this is the
      // final image. Round-tripping through pow(2.2)+sRGB-OETF here would eat
      // the black lift in the toe, which is exactly the part we want to keep.
      vec3 outCol = c;

      // --- film grain: stronger when the exposure is being pushed.
      // Amplitude follows sqrt(luma)*(1-luma): silver-halide grain lives in the
      // mid-tones. A flat amplitude buries night shadows in visible dither.
      float bn = texture2D( tBlue, uv * uBlueScale + vec2( uFrame * 0.7548776, uFrame * 0.5698402 ) ).r;
      float wn = hash12( uv * uResolution + uFrame * 17.13 );
      float n = ( bn * 0.65 + wn * 0.35 ) - 0.5;
      float gl = SAT( luma( outCol ) );
      // Amplitude shape: silver-halide grain peaks in the mid-tones but does
      // NOT vanish in the highlights. Pass 2's (1 - gl) factor drove it to
      // 0.36x in a bright sky, which is why the forensic test measured "sky
      // high-frequency std 1.0, i.e. pure gradient quantisation — no film
      // grain" on the one flat patch a reviewer always samples first.
      float amt = uGrain * ( 0.6 + 0.5 * SAT( log2( max( exposure, 1e-3 ) ) * 0.18 + 0.4 ) )
                        * ( 0.06 + 1.35 * sqrt( gl ) * ( 1.0 - 0.55 * gl ) );
      outCol += n * amt;

      // --- ordered dither to 8 bit
      outCol += ( hash12( uv * uResolution + 3.71 ) - 0.5 ) * ( 1.0 / 255.0 );

      gl_FragColor = vec4( SAT( outCol ), 1.0 );
    }`, {
    tHDR: { value: null },
    tBloom: { value: null },
    tHalation: { value: null },
    tHalationWide: { value: null },
    tExposure: { value: null },
    tBlue: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uBlueScale: { value: new THREE.Vector2(1, 1) },
    uFrame: { value: 0 },
    uAspect: { value: 1.777 },
    uBloomStrength: { value: 0.045 },
    uHalation: { value: 0.05 },
    uHalationTint: { value: new THREE.Vector3(1.0, 0.42, 0.16) },
    uChromatic: { value: 0.0009 },
    uVignette: { value: 0.28 },
    uGrain: { value: 0.040 },
    uChromaDenoise: { value: 0.85 },
    uExposureBias: { value: 1 },
    /** Display-space highlight shoulder: linear below K, reaches white at K+W. */
    uShoulderK: { value: 0.80 },
    uShoulderW: { value: 0.30 },
    /** AgX latitude, in log2 units. Driven from `film`/grade `latitude`. */
    /** Width, in stops, of the soft approach to each end of the AgX latitude.
     *  0 restores the old hard clamp exactly. */
    uAgxSoft: { value: 1.5 },
    /** Ceiling the hue-preserving chroma-restore path rolls off to, in display
     *  units. 1.0 restores the old hard clamp (and its flat plateau). */
    uPureCeil: { value: 1.85 },
    uAgxMin: { value: -12.47393 },
    uAgxMax: { value: 4.026069 },
    /** Film toe width (display space, on the max channel). 0 = no toe. */
    uToe: { value: 0.0 },
    /** Adaptive white point: 0 = fixed at uShoulderK + uShoulderW. */
    uWhiteAdapt: { value: 0.0 },
    uWhiteGain: { value: 1.05 },
    uWhiteMin: { value: 0.86 },
    /** CAS strength for the TAA resolve. 0 = off, 1 = maximum. */
    uSharpen: { value: 0.5 },
    /** Hue restoration after the per-channel AgX sigmoid. See the comment at
     *  the call site: 0 = raw AgX (bleaches emitters), 1 = fully hue-preserving. */
    uChromaRestore: { value: 0.70 },
    /*
     * How far a highlight walks toward white as it climbs the shoulder.
     * 0.75 -> 0.18, and this single number was doing two kinds of damage.
     *
     * (1) COLOUR. It is applied as mix(o, luma(o), bleach*s*s) and then
     *     renormalised back onto the peak, so at s = 1 the pixel is neutral by
     *     construction. That deletes the colour of the most colourful thing in
     *     the frame — the sunlit face of a golden-hour cumulus, the warm top of
     *     a dawn deck — and it is a large part of why mean CIELAB chroma fell on
     *     all ten shots between pass 9 and pass 10.
     *
     * (2) THE BLOB COUNT, and this is the non-obvious half. hdr_headroom reads
     *     the MAX CHANNEL; the single_sun blob detector reads LUMA. A highlight
     *     that keeps its colour has luma well below its max channel — a cloud
     *     top landing at max channel 0.986 with its natural (1.00, 0.97, 0.93)
     *     ratios has a luma of 0.960. Bleaching it to neutral and renormalising
     *     puts all three channels on 0.986, so its luma becomes 0.986 too, and
     *     every sunlit cloud top in the frame crosses the detector's 0.965 line
     *     at once. That is why the count went 1 failing shot -> 3 without any
     *     change to the number of bright objects in the scene: the same pixels,
     *     flattened onto the neutral axis.
     *
     * Keeping the bleach small preserves the difference between the two
     * measurements, which is what lets a frame have a genuine 255 in it and
     * still not read as a field of blown discs.
     */
    uShoulderBleach: { value: 0.18 },
    /** Distance below 1.0 that the shoulder's knee lands on. Everything above
     *  the white point is mapped into this band by a strictly increasing tail,
     *  so no two scene values share a display value and no plateau can form. */
    uWhiteFloor: { value: 0.030 },
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uGammaC: { value: new THREE.Vector3(1, 1, 1) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uSaturation: { value: 1 },
    uContrast: { value: 1 },
    uCurve: { value: 0.1 },
    uShadowTint: { value: new THREE.Vector3(0, 0, 0) },
    uHighlightTint: { value: new THREE.Vector3(0, 0, 0) },
    uSplit: { value: 1 },
    uTemperature: { value: 0 },
    uLookSlope: { value: new THREE.Vector3(1, 1, 1) },
    uLookPower: { value: new THREE.Vector3(1, 1, 1) },
    uLookSat: { value: 1 },
  });
}

/** Straight copy, used for history seeding and fallbacks. */
export function copyMaterial() {
  return makeMaterial(/* glsl */`
    uniform sampler2D tSrc;
    varying vec2 vUv;
    void main() { gl_FragColor = texture2D( tSrc, vUv ); }`, {
    tSrc: { value: null },
  });
}
