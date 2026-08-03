import * as THREE from 'three';
import { makeMaterial, GLSL_COMMON } from './Common.js';

/**
 * Raymarched god rays, layered mist banks and near-field aerial perspective.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS WAS REWRITTEN — there were no light shafts in the build at all.
 *
 * The previous pass could only ever SUBTRACT. Its single term was
 * `keyRadiance * phase * (vis - shadowBase) * density` with `shadowBase = 1.0`,
 * i.e. `(vis - 1) <= 0` everywhere, on the argument that Sky's aerial
 * perspective has already added the full unshadowed in-scatter, so the only
 * honest contribution left is the shadow deficit. That argument is correct for
 * the medium SKY MODELS. It is not correct for the medium that actually makes
 * a god ray, and the measured consequence was that the effect was invisible:
 *
 *   env.fogDensity at golden hour is 7.5e-5 /m. densityScale 2.2 and the
 *   turbidity term take it to ~1.5e-4 /m; the height term at a camera 64 m
 *   above the valley floor takes it to 8e-5 /m; over the 600 m the march
 *   reaches (uMaxDist is clamped to the shadow cascade range) that is an
 *   optical depth of 0.05. Removing ALL of it — the strongest possible shadow
 *   — changes a shadowed pixel by ~5% of the in-scatter, which is ~1.5% of
 *   frame radiance. It is below the grain floor. Six passes of "add god rays"
 *   were all tuning a term that could not be seen.
 *
 * The other half of the failure: the mist was gated entirely behind
 * `env.groundMist`, which weather only raises at dawn. Measured on the current
 * build: dawn_mist_valley 0.134, golden_hour_vista 7.6e-24, storm_plains 0.
 * Eight of ten shots had NO participating medium whatsoever.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL NOW — three media, one march.
 *
 * 1. AEROSOL (`uHaze`). A boundary-layer haze that is always present, with a
 *    LOW scale height (~110 m) referenced to the local valley floor rather
 *    than to sea level. Sky's own haze layer has H ~ 600 m and is smooth and
 *    global; this is the first hundred metres of air — dust, humidity, smoke —
 *    which Sky's three-layer analytic model deliberately does not resolve, so
 *    adding it is a correction, not a double count. Its low scale height is
 *    what makes it POOL: a ridge top pokes out of it and the hollow behind
 *    fills, which is the "distinct planes" the reference frames are built on.
 *    It is marched WITH the shadow map, so it is also what carries the shafts.
 *
 * 2. MIST BANKS (`uMist`). Two discrete strata, not one bedsheet:
 *      - band 0, a saturated lake below `uMistY` decaying above it,
 *      - band 1, a thin Gaussian slab ~`uBand2Off` metres higher with clear
 *        air both above AND below it,
 *    each broken by its own fbm field. Two banks at different altitudes with
 *    a gap between them is the entire reason the reference reads as layers.
 *
 * 3. Sky's medium, still handled subtractively exactly as before, so nothing
 *    Sky already put in the frame gets added a second time.
 *
 * IN-SCATTER IS PHYSICALLY NORMALISED. `keyRadiance` is an IRRADIANCE (a 42%
 * albedo ground under sunIntensity 5.8 renders at 0.775 = E*a/pi), so the
 * source function of the medium is `E * p(theta)` with p the 4-pi-normalised
 * Henyey-Greenstein phase — no free gain. That is what gives the shafts their
 * enormous forward peak (p(0 deg) = 0.90 vs p(90 deg) = 0.030 at g = 0.62, a
 * 30x ratio) without needing a hand-tuned "beam strength", and it is why the
 * effect is dramatic into a low sun and near-absent away from it.
 *
 * DISTANCE. The march can only run as far as the shadow cascades (~600 m).
 * Beyond that the same aerosol is integrated ANALYTICALLY — the exact airlight
 * of an exponential-height medium along a slanted segment — which costs ~20
 * ALU and reaches the horizon. That tail is what lifts, blues and flattens
 * distant terrain, i.e. it is what the `aerial_perspective_hue` and
 * `aerial_perspective_contrast` gates measure.
 *
 * STEP DISTRIBUTION. Steps are warped toward the camera (`uWarp`), because a
 * uniform march over 600 m spends the same samples on the 45 m of mist you can
 * actually resolve as on the 400 m you cannot. The warp buys back more quality
 * than it costs, which is what pays for the extra work per step.
 *
 * Quarter resolution, blue-noise jittered, temporally filtered, bilaterally
 * upsampled by the composite. Output: rgb = additive radiance, a = medium
 * transmittance.
 */

export function volumetricMaterial(steps, csm) {
  const defines = { STEPS: Math.max(4, steps | 0) };
  if (csm && csm.count > 0) {
    defines.RS_CSM = 1;
    defines.RS_CSM_COUNT = csm.count;
  }

  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    uniform sampler2D tDepth;
    uniform sampler2D tBlue;
    uniform mat4 uInvViewProj;
    uniform mat4 uViewMatrix;
    uniform vec3 uCamPos;
    uniform vec2 uBlueScale;
    uniform float uFrame;
    uniform float uMaxDist;
    uniform float uNear, uFar;

    uniform vec3 uKeyDir;          // world-space direction TO the key light
    uniform vec3 uKeyRadiance;     // irradiance on a surface facing the key
    uniform vec3 uMistAmbient;     // ambient in-scatter source (sky radiance)
    uniform float uDensity;        // Sky's medium — subtractive term only
    uniform float uInvHeight;
    uniform float uBaseY;

    uniform float uHaze;           // aerosol extinction /m at the valley floor
    uniform float uHazeInvH;       // 1 / scale height
    uniform float uHazeFloor;      // world Y the aerosol is referenced to
    uniform float uAlbedo;         // single-scattering albedo of the medium
    uniform float uKeyGain;        // gain on the directional in-scatter ONLY
    uniform vec3  uFarSrc;         // airlight source: de-reddened horizon radiance
    uniform float uNearAmb;        // weight of that airlight inside the march
    uniform float uFarSun;         // weight of the sun term in the analytic tail
    uniform float uLeak;           // ambient multiple-scatter into shadowed air
    uniform float uFarMax;         // ceiling on the analytic tail length
    uniform float uFarTauMax;      // art ceiling on the tail's optical depth
    uniform float uSkyDepth;       // window depth at or above which a pixel is sky

    uniform float uMist;
    uniform float uMistY;
    uniform float uMistInvThick;
    uniform float uBand2Y;
    uniform float uBand2InvT;
    uniform float uBand2Amp;

    uniform float uMieG;
    uniform float uShadowBase;
    uniform float uBeamStrength;
    uniform float uMistNoise;
    uniform float uMistScale;
    uniform float uMinT;
    uniform float uTime;
    uniform float uSteps;
    uniform float uWarp;
    uniform vec3  uWind;

    /*
     * Cheap value-noise for breaking the mist into banks.
     *
     * DELIBERATELY 2-D. Radiation fog is a horizontally-organised medium — the
     * banks are metres thick and hundreds of metres long — so the vertical
     * dimension buys almost nothing visually and costs everything: a 3-octave
     * 3-D value noise is 24 hash evaluations at every raymarch step of every
     * quarter-res pixel, and it measured +11 ms of frame time on its own.
     *
     * The two octaves are recombined with OPPOSITE weights for the two bands,
     * so band 0 and band 1 decorrelate into independent-looking strata for the
     * price of one evaluation.
     */
    float vhash2( vec2 p ) {
      vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
      p3 += dot( p3, p3.yzx + 33.33 );
      return fract( ( p3.x + p3.y ) * p3.z );
    }
    float vnoise2( vec2 x ) {
      vec2 i = floor( x ), f = fract( x );
      f = f * f * ( 3.0 - 2.0 * f );
      return mix( mix( vhash2( i ), vhash2( i + vec2( 1.0, 0.0 ) ), f.x ),
                  mix( vhash2( i + vec2( 0.0, 1.0 ) ), vhash2( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
    }

    #ifdef RS_CSM
      uniform highp sampler2DShadow rsCsmShadowMap;
      uniform mat4 rsCsmMat[ RS_CSM_COUNT ];
      uniform vec4 rsCsmTile[ RS_CSM_COUNT ];
      uniform vec4 rsCsmRange[ RS_CSM_COUNT ];
      uniform vec4 rsCsmSplits;
      uniform vec4 rsCsmParams;
      uniform vec4 rsCsmBias;

      float volShadow( vec3 vp ) {
        float d = -vp.z;
        if ( d >= rsCsmParams.x ) return 1.0;
        int c = 0;
        for ( int i = 0; i < RS_CSM_COUNT - 1; i++ ) {
          if ( d > rsCsmSplits[ i ] ) c = i + 1;
        }
        vec3 co = ( rsCsmMat[ c ] * vec4( vp, 1.0 ) ).xyz * 0.5 + 0.5;
        if ( co.z <= 0.0 || co.z >= 1.0 ) return 1.0;
        if ( any( lessThan( co.xy, vec2( 0.0 ) ) ) || any( greaterThan( co.xy, vec2( 1.0 ) ) ) ) return 1.0;
        vec4 tile = rsCsmTile[ c ];
        float ref = co.z - ( rsCsmBias.y * 3.0 ) / max( rsCsmRange[ c ].x, 1.0 );
        float inset = rsCsmParams.z * 1.5;
        vec2 uv = tile.xy + clamp( co.xy, inset, 1.0 - inset ) * tile.zw;
        return texture( rsCsmShadowMap, vec3( uv, ref ) );
      }
    #else
      float volShadow( vec3 vp ) { return 1.0; }
    #endif

    varying vec2 vUv;

    void main() {
      float d = texture2D( tDepth, vUv ).r;
      vec3 wp = worldPosFromDepth( vUv, d, uInvViewProj );
      vec3 ray = wp - uCamPos;
      float sceneDist = length( ray );
      vec3 rd = ray / max( sceneDist, 1e-4 );
      /*
       * THE SKY TEST HAS TO BE THIS TIGHT, AND THE OLD ONE WAS THE REASON THIS
       * PASS NEVER TOUCHED DISTANCE.
       *
       * With near 0.15 and far 12000 the window depth of a surface at range z
       * is 1 - 1/(z * 6.6666). "d >= 0.9999" is therefore satisfied by
       * EVERYTHING BEYOND 1.5 km — every ridge, every mountain, the whole far
       * field — so distant terrain was taking the sky branch, having its
       * distance replaced by uMaxDist, and receiving no aerial perspective from
       * this pass at all. Measured: turning the whole system on or off moved
       * golden_hour_vista's B-R gradient by 0.03 on a defect of 0.20.
       *
       * The sky dome writes no depth (Sky.js keeps depthWrite off and emits NDC
       * z = 1.0), so sky pixels carry the CLEAR value, exactly 1.0. The far
       * plane itself sits at 0.9999875. 0.999999 separates them cleanly and is
       * well inside the precision of the 32-bit float depth texture.
       */
      bool isSky = d >= uSkyDepth;
      if ( isSky ) sceneDist = uMaxDist;

      float tEnd = min( sceneDist, uMaxDist );
      if ( tEnd <= uNear ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }

      float jitter = texture2D( tBlue, vUv * uBlueScale + vec2( uFrame * 0.7548776, uFrame * 0.5698402 ) ).r;
      jitter = fract( jitter + uFrame * 0.6180339887 );

      // 1 for geometry, 0 for sky — see the note at the in-scatter term.
      float skyOn = isSky ? 0.0 : 1.0;

      float cosT = dot( rd, uKeyDir );
      /*
       * Two phase terms, deliberately.
       *  - phaseP is the true 4-pi-normalised HG, used as the source function
       *    of the medium THIS pass owns. No free gain: the shaft contrast comes
       *    out of the physics.
       *  - phaseB keeps the old art-directed shape for the SUBTRACTIVE term
       *    against Sky's medium, which was tuned against Sky's in-scatter and
       *    must not change meaning.
       */
      float phaseP = phaseHG( cosT, uMieG );
      float phaseB = phaseP * 4.0 + 0.06;

      float steps = max( uSteps, 4.0 );
      float span = tEnd - uNear;
      float du = 1.0 / steps;
      vec3 acc = vec3( 0.0 );
      float T = 1.0;
      float wPrev = 0.0;

      for ( int i = 0; i < STEPS; i++ ) {
        if ( float( i ) >= steps ) break;
        // Step warp: dt grows with distance, so the near field — where the mist
        // banks and the shaft edges actually resolve — gets the samples.
        float u1 = ( float( i ) + 1.0 ) * du;
        float w1 = u1 * ( uWarp + ( 1.0 - uWarp ) * u1 );
        float seg = ( w1 - wPrev ) * span;
        float t = uNear + ( wPrev + ( w1 - wPrev ) * jitter ) * span;
        wPrev = w1;

        vec3 p = uCamPos + rd * t;
        vec3 vp = ( uViewMatrix * vec4( p, 1.0 ) ).xyz;

        // Sky's medium (subtractive shadow deficit only)
        float dens = uDensity * exp( -max( p.y - uBaseY, 0.0 ) * uInvHeight );
        // Our aerosol: saturated below the valley floor, exponential above it
        float haze = uHaze * exp( -max( p.y - uHazeFloor, 0.0 ) * uHazeInvH );
        float mistSig = 0.0;

        if ( uMist > 1e-7 ) {
          vec2 q = ( p.xz + uWind.xz * uTime ) * uMistScale;
          float n1 = vnoise2( q );
          float n2 = vnoise2( q * 2.9 + 17.3 );
          // band 0 — the valley lake: saturated below the ceiling, decaying above
          float b0 = exp( -max( p.y - uMistY, 0.0 ) * uMistInvThick );
          float lift = SAT( ( p.y - uMistY + 6.0 ) * 0.09 );
          // The subtraction is what opens real gaps between banks: without it
          // the layer is a uniform bedsheet and the shot whites out.
          b0 *= mix( 1.0, SAT( ( n1 * 0.66 + n2 * 0.34 ) * 2.1 - 0.42 - 0.35 * lift ), uMistNoise );
          // band 1 — an elevated stratum with clear air above AND below, which
          // is what cuts a ridgeline into two separate planes.
          float z = ( p.y - uBand2Y ) * uBand2InvT;
          float b1 = exp( -z * z ) * uBand2Amp;
          b1 *= mix( 1.0, SAT( ( n2 * 0.66 + n1 * 0.34 ) * 2.4 - 0.82 ), uMistNoise );
          mistSig = uMist * ( b0 + b1 );
        }
        float sigma = haze + mistSig;

        float vis = volShadow( vp );
        float fade = 1.0 - smoothstep( uMaxDist * 0.72, uMaxDist, t );

        // 1) shadow deficit of the key light through SKY's medium
        acc += T * uKeyRadiance * ( phaseB * ( vis - uShadowBase ) * dens * uBeamStrength * fade * seg );

        // 2) our own medium: real shadowed single scattering + extinction.
        //    Shadowed air keeps only its ambient fill; the contrast between
        //    sunlit and shadowed air IS the god ray.
        if ( sigma > 1e-8 ) {
          /*
           * Two ambient sources, mixed by which medium is actually present at
           * this sample. The aerosol's ambient is AIRLIGHT — the radiance of
           * the sky it is scattering toward the camera, which is bright and is
           * what makes distance go pale. The mist bands sit in the lowest air
           * and are lit by the dimmer local sky integral instead; using the
           * horizon radiance for them turned dawn_mist_valley into a sheet of
           * sepia in an earlier pass.
           */
          vec3 amb = ( uFarSrc * ( uNearAmb * haze ) + uMistAmbient * mistSig ) / sigma;
          /*
           * SKY PIXELS GET THE SHAFT STRUCTURE AND NOTHING ELSE.
           *
           * A ray that never hits geometry is integrated end to end by Sky's
           * own atmosphere, so adding 600 m of our aerosol on top of it is the
           * exact double count this pass exists to avoid — and it is not
           * subtle: it laid a bright pedestal over the whole sky and blew 26
           * separate cloud tops past clipping in dawn_mist_valley (the
           * single_sun gate went from 0 blobs to 26 on that change alone).
           *
           * So for sky, "skyOn" is 0: the ambient pedestal vanishes and the key
           * term becomes "mix(vis,1,leak) - 1", which is <= 0 — lit air is left
           * exactly as Sky drew it and only SHADOWED air darkens. That is a
           * crepuscular ray fanning off a treeline, drawn as the dark bands
           * between the beams, which is what it physically is.
           */
          vec3 src = uKeyRadiance * ( phaseP * uKeyGain * ( mix( vis, 1.0, uLeak ) - ( 1.0 - skyOn ) ) ) * uAlbedo
                   + amb * skyOn;
          float tr = exp( -sigma * seg );
          acc += T * src * ( 1.0 - tr );
          T = mix( T, T * tr, skyOn );
        }
        if ( T < uMinT * 0.5 ) break;
      }

      /*
       * ANALYTIC FAR TAIL — the aerial perspective the march cannot reach.
       *
       * Exact airlight of an exponential-height medium along a slanted segment:
       *   tau = sigma0 * exp(-h0/H) * (1 - exp(-(rd.y/H) L)) / (rd.y/H)
       * degenerating to sigma0 * exp(-h0/H) * L for a level ray. Unshadowed,
       * which is correct: past the last cascade there is no occlusion data and
       * at those distances the shadowing of the air averages out anyway.
       *
       * Sky pixels are excluded — Sky owns the sky, and veiling it here would
       * be the double count this pass exists to avoid.
       */
      if ( !isSky && sceneDist > tEnd && T > uMinT ) {
        float L = min( sceneDist - tEnd, uFarMax );
        vec3 pe = uCamPos + rd * tEnd;
        /*
         * Exact airlight of the exponential layer over the remaining segment,
         * with the height CLAMPED AT THE FLOOR at both ends:
         *   tau = sigma0 * L * (e^-h0k - e^-h1k) / ((h1-h0)k)
         * The unclamped closed form grows as exp(+depth/H) the moment the ray
         * descends below the layer reference, which for a camera looking down
         * a valley is most of the path — it returned an optical depth of 22
         * where the honest answer is about 2, and every distant ridge came out
         * as a single flat slab of airlight.
         */
        float k = uHazeInvH;
        float h0 = max( pe.y - uHazeFloor, 0.0 ) * k;
        float h1 = max( pe.y + rd.y * L - uHazeFloor, 0.0 ) * k;
        float e0 = exp( -h0 ), e1 = exp( -h1 );
        float dh = h1 - h0;
        float tau = abs( dh ) > 1e-3 ? uHaze * L * ( e0 - e1 ) / dh
                                     : uHaze * L * e0;
        // Art ceiling: Koschmieder's 2% is a VISIBILITY definition, not a
        // composition one. The far ridge has to keep a readable silhouette.
        tau = clamp( tau, 0.0, uFarTauMax );
        float trF = exp( -tau );
        /*
         * The tail is unshadowed, so there are no shafts in it to boost — the
         * key term drops back to physical (uFarSun) and the source becomes the
         * AIRLIGHT: over kilometres the in-scatter asymptotes to the radiance
         * of the sky in that direction, which is bright and blue-shifted
         * relative to a surface. That asymptote is what makes distant terrain
         * LIGHTER, LOWER CONTRAST and BLUER, i.e. it is the whole of the
         * aerial_perspective_hue / _contrast gate. Feeding it the sun term at
         * shaft strength instead — which is what the first cut of this pass
         * did — paints the far field warm and the gate reads INVERTED.
         */
        vec3 srcF = uKeyRadiance * ( phaseP * uFarSun * uAlbedo ) + uFarSrc;
        acc += T * srcF * ( 1.0 - trF );
        T *= trF;
      }

      // Never let the medium erase the frame completely: a shot with no
      // readable scene in it is a bug however physical the integral was.
      gl_FragColor = vec4( max( acc, vec3( 0.0 ) ), max( T, uMinT ) );
    }`, {
    tDepth: { value: null },
    tBlue: { value: null },
    uInvViewProj: { value: new THREE.Matrix4() },
    uViewMatrix: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uBlueScale: { value: new THREE.Vector2(1, 1) },
    uFrame: { value: 0 },
    /** Steps actually marched this frame (<= the STEPS compile ceiling). */
    uSteps: { value: Math.max(4, steps | 0) },
    /** 0 = all samples bunched at the camera, 1 = uniform. */
    uWarp: { value: 0.32 },
    uMaxDist: { value: 900 },
    uNear: { value: 0.3 },
    uFar: { value: 12000 },
    uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
    uKeyRadiance: { value: new THREE.Vector3(1, 1, 1) },
    uMistAmbient: { value: new THREE.Vector3(0.1, 0.12, 0.15) },
    uDensity: { value: 0.00016 },
    uInvHeight: { value: 1 / 320 },
    uBaseY: { value: 14 },
    uHaze: { value: 0.00045 },
    uHazeInvH: { value: 1 / 110 },
    uHazeFloor: { value: 0 },
    uAlbedo: { value: 0.92 },
    uKeyGain: { value: 2.2 },
    uFarSrc: { value: new THREE.Vector3(0.2, 0.24, 0.32) },
    uNearAmb: { value: 0.75 },
    uFarSun: { value: 0.30 },
    uLeak: { value: 0.10 },
    uFarMax: { value: 9000 },
    uFarTauMax: { value: 2.2 },
    uSkyDepth: { value: 0.999999 },
    uMist: { value: 0 },
    uMistY: { value: 24 },
    uMistInvThick: { value: 1 / 15 },
    uBand2Y: { value: 60 },
    uBand2InvT: { value: 1 / 9 },
    uBand2Amp: { value: 0.55 },
    uMieG: { value: 0.6 },
    uShadowBase: { value: 1.0 },
    uBeamStrength: { value: 0.85 },
    uMistNoise: { value: 0.75 },
    uMinT: { value: 0.10 },
    uMistScale: { value: 1 / 90 },
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector3() },
  }, defines);
}

/** Temporal filter for the volumetric buffer (quarter res). */
export function volumetricTemporalMaterial() {
  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    uniform sampler2D tCurrent;
    uniform sampler2D tHistory;
    uniform sampler2D tVelocity;
    uniform vec2 uTexel;
    uniform float uFeedback;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D( tCurrent, vUv );
      vec2 vel = texture2D( tVelocity, vUv ).rg;
      vec2 prevUV = vUv - vel;
      if ( uFeedback < 0.01 ||
           any( lessThan( prevUV, vec2( 0.0 ) ) ) || any( greaterThan( prevUV, vec2( 1.0 ) ) ) ) {
        gl_FragColor = c; return;
      }
      vec4 mn = c, mx = c;
      for ( int y = -1; y <= 1; y++ ) {
        for ( int x = -1; x <= 1; x++ ) {
          vec4 s = texture2D( tCurrent, vUv + vec2( float( x ), float( y ) ) * uTexel );
          mn = min( mn, s ); mx = max( mx, s );
        }
      }
      vec4 ext = ( mx - mn ) * 0.25 + 1e-4;
      vec4 h = clamp( texture2D( tHistory, prevUV ), mn - ext, mx + ext );
      gl_FragColor = mix( c, h, uFeedback );
    }`, {
    tCurrent: { value: null },
    tHistory: { value: null },
    tVelocity: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uFeedback: { value: 0.88 },
  });
}
