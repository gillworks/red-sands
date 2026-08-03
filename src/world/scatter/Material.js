import * as THREE from 'three';

/**
 * Scatter materials.
 *
 * ---------------------------------------------------------------------------
 * PASS-3 REWRITE. The forensic pass named this file's output four times:
 *
 *   "Foreground boulder fills ~20% of frame yet has no surface detail
 *    whatsoever — no normal map, no pores/cracks/lichen, just a smeary
 *    low-frequency diffuse blur."
 *   "night_camp fire-ring boulders ... blown-out WHITE faceted plastic lumps
 *    with ... zero albedo, normal or roughness variation."
 *   "BROKEN INSTANCED MESH ... a rectangular blob of repeating diagonal hatch."
 *   "UV TILE REPETITION ON THE LOGS ... an identical chevron rhythm."
 *
 * The root cause of the first two was NOT a missing texture — the map was
 * bound. It was that `rock_boulder`'s albedo is a 6-octave fBm whose energy all
 * sits in its lowest octave, projected at 0.62 world units, so a 4 m boulder
 * received about two and a half repeats of a soft blob field and nothing
 * finer. Turning the fire key light on simply lit that blur brightly.
 *
 * So the surface is now built from FOUR scales, three of which are new:
 *   metres      the macro tap, per-instance rotated  → two rocks 3 m apart are
 *               different rocks, not the same texture at a different offset
 *   decimetres  the base triplanar projection
 *   centimetres a detail octave with real amplitude (was ±15%, now ±40%)
 *   cracks      the detail octave thresholded into narrow dark fissures, driving
 *               albedo, roughness AND the normal, plus curvature cavity dirt
 * with lichen keyed to up-facing macro highs and bleaching keyed to the same
 * field so the sun-struck planes are broken rather than a smooth pow(N.y).
 *
 * The last two tells were sampling failures. Distant instances now take an
 * explicit mip bias (a 40 m ruin wall at 400 m was being minified far below
 * Nyquist, which is exactly what "repeating diagonal hatch" is), and every
 * instance rotates its own world-space projection frame about Y, so a stack of
 * five logs cannot share one chevron rhythm.
 *
 * And it does all of that for FEWER texture fetches than pass 2: the triplanar
 * setup and the packed normal/roughness taps are computed once in a prelude and
 * reused by the albedo, roughness and normal chunks, instead of each chunk
 * re-running the whole projection. 16 fetches → 9.
 * ---------------------------------------------------------------------------
 */

/* ------------------------------------------------------------------ varyings */

function declVert(triplanar, wind) {
  return /* glsl */`
attribute float aCav;
#ifdef RS_SC_INSTANCED
attribute vec3 aTint;
attribute float aFade;
#endif
varying vec3 vScWPos;
varying vec3 vScWNrm;
varying float vScCav;
varying vec3 vScTint;
varying float vScFade;
${triplanar ? `
varying vec3 vScTP;    // per-instance rotated world position (projection frame)
varying vec3 vScTN;    // per-instance rotated world normal
varying vec2 vScRot;   // cos/sin of that rotation, to undo it on the normal
varying float vScSize; // instance scale, metres-ish — drives texel density
` : ''}
${wind ? 'uniform vec4 uScWind;\n' : ''}
`;
}

function declFrag(triplanar, wind, hexGLSL) {
  return /* glsl */`
varying vec3 vScWPos;
varying vec3 vScWNrm;
varying float vScCav;
varying vec3 vScTint;
varying float vScFade;
${triplanar ? `
varying vec3 vScTP;
varying vec3 vScTN;
varying vec2 vScRot;
varying float vScSize;
uniform vec4 uScRock;   // sizeExp, strataAmount, strataFreq(1/m), chipAmount
uniform vec4 uScRock2;  // uvWarp, hexRange(m), 0, 0
${hexGLSL || ''}
uniform sampler2D uScMap;
/* normal.xy in RG, roughness in B — packed at build time so every prop
   material costs two texture units instead of three. Fragment samplers are a
   scarce resource: the frame also carries the sky-view LUT, both cascade
   atlases and every local light's shadow, and 16 is the guaranteed minimum. */
uniform sampler2D uScNR;
` : ''}
uniform vec4 uScTri;    // worldScale, blendSharpness, normalStrength, macroAmount
uniform vec4 uScWeather;// cavityDirt, cavityRough, bleach, wetness
uniform vec4 uScDetail; // detailScaleMul, fadeStart(m), fadeEnd(m), detailAmount
uniform vec4 uScSurf;   // crackAmount, lichenAmount, mipBiasK, detailNormal
/* 1/meanLinearLuminance of uScMap, plus the crack window expressed as a RATIO
   to that mean. Every modulation below is normalised by this, which is the
   difference between "break the surface up" and "multiply the whole prop by
   0.6". Pass 3's first attempt thresholded raw LINEAR luminance at 0.1-0.34;
   rock_boulder's mean linear luminance is about 0.16, so every one of those
   tests fired almost everywhere and the boulders came out at 43/255 against
   sand at 147. Normalised, the same code is mean-preserving by construction and
   survives procTextures re-baking its recipes underneath us. */
uniform vec4 uScLevels; // invMean, crackLo, crackHi, unused
uniform vec3 uScDirt;   // linear-ish dirt tint multiplier
uniform vec3 uScLichen; // lichen tint
${wind ? 'uniform vec4 uScWind;\n' : ''}
`;
}

const BODY_VERT_NORMAL = /* glsl */`
{
  vec3 rsON = objectNormal;
  #ifdef USE_INSTANCING
    mat3 rsIm = mat3( instanceMatrix );
    rsON /= vec3( dot( rsIm[0], rsIm[0] ), dot( rsIm[1], rsIm[1] ), dot( rsIm[2], rsIm[2] ) );
    rsON = rsIm * rsON;
  #endif
  vScWNrm = normalize( mat3( modelMatrix ) * rsON );
}
`;

function bodyVertPos(triplanar) {
  return /* glsl */`
{
  vec4 rsWp = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    rsWp = instanceMatrix * rsWp;
  #endif
  vScWPos = ( modelMatrix * rsWp ).xyz;
  vScCav = aCav;
  #ifdef RS_SC_INSTANCED
    vScTint = aTint;
    vScFade = aFade;
  #else
    vScTint = vec3( 1.0 );
    vScFade = 1.0;
  #endif
${triplanar ? `
  /* Per-instance rotation AND re-origin of the world-space projection frame.
     Both are derived from the instance origin, so they are free (no extra
     attribute) and deterministic. The rotation is what stops five logs in a
     pile sharing one bark rhythm and a rock field reading as the same texture
     pasted at different offsets.

     Re-origining also fixes a precision trap: this world is 8 km across, and at
     a 3.3 unit/m projection the raw world coordinate reaches ~13500, where a
     highp float's ULP (~1.6e-3) is larger than one texel of a 1024 map. That
     quantises the UV and stair-steps the texture at the map edges. Working
     relative to the instance keeps the coordinate under ~100. The offset is a
     pure translation, so none of the normal maths below cares. */
  float rsAng = 0.0;
  vec3 rsOrg = vec3( 0.0 );
  vec3 rsRel = vScWPos;
  #ifdef USE_INSTANCING
    rsOrg = instanceMatrix[ 3 ].xyz;
    rsAng = fract( sin( dot( rsOrg.xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) * 6.2831853;
    rsRel = vScWPos - rsOrg + vec3(
      fract( sin( dot( rsOrg.xz, vec2( 4.898, 7.23 ) ) ) * 3758.545 ) * 53.0,
      fract( sin( dot( rsOrg.zx, vec2( 9.137, 2.717 ) ) ) * 1733.77 ) * 37.0,
      fract( sin( dot( rsOrg.xz, vec2( 1.771, 5.313 ) ) ) * 9271.31 ) * 61.0 );
  #endif
  /* INSTANCE SIZE, in metres-ish. A 40 m outcrop and a 1 m boulder cannot share
     a texel density: at a fixed world-space projection the outcrop receives 40
     repeats of the map and every feature in it is 40x too small to read, which
     is most of why the hero rock came back as "smeary low-frequency mush". The
     cube root of the instance matrix's scale product is the mean linear scale,
     and the fragment stage raises it to uScRock.x to set the projection. */
  float rsIS = 1.0;
  #ifdef USE_INSTANCING
    rsIS = pow( max( length( instanceMatrix[0].xyz ) * length( instanceMatrix[1].xyz )
                   * length( instanceMatrix[2].xyz ), 1e-6 ), 0.33333333 );
  #endif
  vScSize = clamp( rsIS, 0.06, 40.0 );
  float rsC = cos( rsAng ), rsS = sin( rsAng );
  vScRot = vec2( rsC, rsS );
  vScTP = vec3( rsRel.x * rsC - rsRel.z * rsS, rsRel.y, rsRel.x * rsS + rsRel.z * rsC );
  vScTN = vec3( vScWNrm.x * rsC - vScWNrm.z * rsS, vScWNrm.y, vScWNrm.x * rsS + vScWNrm.z * rsC );
` : ''}
}
`;
}

/** Wind sway for alpha-card foliage. Amplitude is deliberately small. */
const BODY_VERT_WIND = /* glsl */`
{
  /* Bend is quadratic in height so the tip moves and the root does not, but it
     MUST be clamped: without the clamp a 4 m saguaro gets 16x a 1 m bush's
     amplitude and bends into a banana. */
  float rsH = min( max( position.y, 0.0 ), 1.30 );
  float rsPh = vScWPos.x * 0.35 + vScWPos.z * 0.27;
  float rsSw = sin( uScWind.w * 1.7 + rsPh ) * 0.6 + sin( uScWind.w * 3.1 + rsPh * 1.9 ) * 0.4;
  vec3 rsOff = vec3( uScWind.x, 0.0, uScWind.z ) * rsSw * uScWind.y * rsH * rsH * 0.055;
  vScWPos += rsOff;
  vec4 rsMv = viewMatrix * vec4( rsOff, 0.0 );
  mvPosition += rsMv;
  gl_Position = projectionMatrix * mvPosition;
}
`;

/**
 * DITHERED LOD CROSS-FADE — and why the sign of `aFade` matters.
 *
 * A prop inside a LOD band is submitted TWICE: once into the outgoing LOD's
 * batch and once into the incoming LOD's, with fades `1-t` and `t`. Both used
 * to run this same test, `keep if rsDit <= fade`, and `rsDit` is a pure
 * function of gl_FragCoord — so the two kept sets were NESTED, not
 * complementary. Their union was `rsDit <= max(t, 1-t)`, which means a fraction
 * `min(t, 1-t)` of the prop's pixels — up to HALF of it at t = 0.5 — was
 * discarded by both LODs at once. Every rock, log and bush in a cross-fade band
 * was up to 50% see-through, and because `rsDit` is fixed in SCREEN space while
 * the prop moves across the screen, the holes crawled over it while the camera
 * moved. Measured live: 100-400 instances a frame carry an incoming-LOD fade,
 * so a few hundred props are inside a cross-fade at any moment.
 *
 * This is NOT the "ground and rocks flicker dark past a certain distance" bug —
 * that was the stale camera matrix in CascadedShadowMaps, and tools/flicker.mjs
 * shows the residual profile is flat across the LOD band radii once that is
 * fixed. It is a plain coverage defect found by reading the shader, and worth
 * repairing on its own terms.
 *
 * `Scatter.PropKind.add` now marks the INCOMING LOD by negating its fade, and
 * that copy keeps `1 - rsDit` instead of `rsDit`. The two kept sets are then
 * exact complements: coverage is 100% everywhere through the whole cross-fade,
 * at the same cost and with the same dither pattern.
 */
const FADE_FRAG = /* glsl */`
{
  float rsF = abs( vScFade );
  if ( rsF < 0.996 ) {
    float rsDit = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
    if ( ( vScFade < 0.0 ? 1.0 - rsDit : rsDit ) > rsF ) discard;
  }
}
`;

/**
 * One projection, sampled once, used by albedo + roughness + normal.
 *
 * Declared at main() scope (no braces) immediately after the clipping test so
 * everything downstream can read it. `rsBias` is the fix for the distant
 * "repeating diagonal hatch": beyond ~50 m a prop's texture is minified past
 * what its derivatives can resolve cleanly, and the hardware mip chain alone
 * still leaves shimmering moiré on a 40 m wall seen at 400 m.
 */
const PRELUDE = /* glsl */`
vec3  rsTN   = normalize( vScTN );
float rsDist = length( vScWPos - cameraPosition );
/* size-driven texel density — see vScSize in the vertex stage. The MACRO/DETAIL
   octaves deliberately do NOT take it: they are absolute bands (metres and
   centimetres) and stretching the centimetre band by a 36 m instance turns it
   into a 1.4 m quilt, which is exactly the diagonal lattice the first build of
   this change put on the river_bend outcrop. */
float rsTexK = uScTri.x * pow( vScSize, -uScRock.x );
vec3  rsTwW  = vScTP * uScTri.x;
vec3  rsTw   = vScTP * rsTexK;
/* ANTI-REPEAT DOMAIN WARP. Two incommensurate sine octaves per axis: pure ALU,
   no fetch, and it destroys the exact periodicity of the base tiling at every
   distance. This is what replaced a near-field hex sampler — three taps of
   rsHexSample on the albedo and packed maps measured __render 11.1 -> 26.7 ms
   on high_noon_desert, i.e. 3x the whole frame, which the budget cannot buy.
   Amplitude is a fraction of a tile, so nothing smears. */
rsTw += ( vec3( sin( rsTw.z * 0.21 + rsTw.y * 0.13 ),
                sin( rsTw.x * 0.19 + rsTw.z * 0.11 ),
                sin( rsTw.y * 0.17 + rsTw.x * 0.23 ) )
        + vec3( sin( rsTw.y * 0.53 - rsTw.x * 0.37 ),
                sin( rsTw.z * 0.47 - rsTw.y * 0.41 ),
                sin( rsTw.x * 0.43 - rsTw.z * 0.31 ) ) * 0.45 ) * uScRock2.x;
vec3  rsBw   = pow( abs( rsTN ), vec3( uScTri.y ) );
rsBw /= ( rsBw.x + rsBw.y + rsBw.z + 1e-5 );
vec2 rsUvX = rsTw.zy;
vec2 rsUvY = rsTw.xz;
vec2 rsUvZ = rsTw.xy;
float rsBias = clamp( log2( max( rsDist * uScSurf.z, 1.0 ) ), 0.0, 4.0 );
/* packed normal.xy + roughness, one tap per plane, shared by three chunks */
vec4 rsNRx = texture2D( uScNR, rsUvX, rsBias );
vec4 rsNRy = texture2D( uScNR, rsUvY, rsBias );
vec4 rsNRz = texture2D( uScNR, rsUvZ, rsBias );
/* dominant plane — the detail octave only needs one tap, and taking it on the
   plane that already owns >50% of the blend is visually indistinguishable */
vec2 rsUvD = ( rsBw.x > rsBw.y && rsBw.x > rsBw.z ) ? rsUvX
           : ( rsBw.y > rsBw.z ) ? rsUvY : rsUvZ;
float rsNear = 1.0 - smoothstep( uScDetail.y, uScDetail.z, rsDist );
/* the centimetre band rides the WORLD-space projection, not the sized one */
vec2  rsUvF  = ( ( rsBw.x > rsBw.y && rsBw.x > rsBw.z ) ? rsTwW.zy
              : ( rsBw.y > rsBw.z ) ? rsTwW.xz : rsTwW.xy ) * uScDetail.x;
vec3 rsFineC; vec4 rsFineN;
#ifdef RS_SC_HEX
if ( rsDist < uScRock2.y ) {
  rsFineC = rsHexSample( uScMap, rsUvF ).rgb;
  rsFineN = rsHexSample( uScNR,  rsUvF );
} else
#endif
{
  rsFineC = texture2D( uScMap, rsUvF ).rgb;
  rsFineN = texture2D( uScNR,  rsUvF );
}
/* metre-scale field: drives macro albedo, lichen colonies and bleach breakup.
   Everything is expressed as a RATIO to the map's own mean, so 1.0 == "average
   for this surface" and the modulations below cannot bias the overall value. */
float rsMacR  = dot( texture2D( uScMap, rsTwW.xz * 0.085, rsBias ).rgb, vec3( 0.3333 ) )
              * uScLevels.x;
float rsFineR = dot( rsFineC, vec3( 0.3333 ) ) * uScLevels.x;
float rsMac  = clamp( rsMacR  * 0.5, 0.0, 1.0 );   // 0.5 at the mean
float rsFine = clamp( rsFineR * 0.5, 0.0, 1.0 );
/* narrow fissures, not a broad wash. Only in the near field: at distance a
   crack is sub-pixel and can only alias. */
float rsCrack = ( 1.0 - smoothstep( uScLevels.y, uScLevels.z, rsFineR ) )
              * rsNear * uScSurf.x;
float rsCav = clamp( vScCav, 0.0, 1.0 );
/* CONVEX ARRIS. Geometry.makeCutRock writes a NEGATIVE aCav on the edges where
   two fracture planes meet — the one place on a rock that is freshly broken,
   dust-free and sun-bleached. Every other prop in the library writes aCav >= 0,
   so this is inert for them. */
float rsCvx = clamp( -vScCav, 0.0, 1.0 ) * uScRock.w;

/* ------------------------------------------------------------------ STRATA
 * Bedding, keyed to WORLD Y rather than to the mesh. That is the whole point:
 * two blocks shed from the same scarp have to carry the same bed lines at the
 * same heights or the field reads as a bag of independently-textured lumps
 * instead of as one formation. The amplitude ramps in with instance size, so a
 * cobble does not get 2 m strata painted across it.
 */
float rsBedAmp = uScRock.y * smoothstep( 0.45, 2.6, vScSize )
               * ( 1.0 - abs( rsTN.y ) * 0.55 );
float rsBedY   = vScWPos.y * uScRock.z + rsMacR * 0.55;
float rsBedI   = floor( rsBedY );
float rsBedF   = rsBedY - rsBedI;
float rsBedH   = fract( sin( rsBedI * 37.719 ) * 4137.71 );
float rsBedH2  = fract( sin( rsBedI * 91.371 + 3.1 ) * 2317.13 );
/* The parting: a narrow dirt-filled recess at the foot of each bed. Its WIDTH
   is per-bed and a third of the beds carry no marked parting at all — evenly
   spaced identical lines read as masonry courses, not as sedimentary rock. */
float rsBedSeam = ( 1.0 - smoothstep( 0.0, 0.035 + 0.17 * rsBedH2, rsBedF ) )
                * rsBedAmp * smoothstep( 0.14, 0.52, rsBedH2 );
`;

const MAP_TRIPLANAR = /* glsl */`
{
  vec3 rsAlb = texture2D( uScMap, rsUvX, rsBias ).rgb * rsBw.x
             + texture2D( uScMap, rsUvY, rsBias ).rgb * rsBw.y
             + texture2D( uScMap, rsUvZ, rsBias ).rgb * rsBw.z;

  /* METRE scale: the same map at ~1/12 the frequency, luminance only, so a
     3 m block is not one flat tone and two neighbouring rocks differ. */
  rsAlb *= mix( 1.0 - uScTri.w, 1.0 + uScTri.w, rsMac );

  /* CENTIMETRE scale: grain, pores and grit. Pass 2 ran this at ±15% which is
     below the visible threshold once the aerial haze has had its say. The
     modulation is per-CHANNEL, not luminance-only, so what comes out is mineral
     speckle rather than a grey stipple — 60% value, 40% chroma. */
  vec3 rsFineT = clamp( mix( vec3( rsFine ), rsFineC * uScLevels.x * 0.5, 0.4 ), 0.0, 1.0 );
  rsAlb *= mix( vec3( 1.0 ),
    mix( vec3( 1.0 - uScDetail.w ), vec3( 1.0 + uScDetail.w ), rsFineT ), rsNear );

  /* STRATA: a per-bed tone plus a dirt-packed parting at every bed contact.
     Mean-preserving by construction (mix around 1.0), so this changes the read
     of the surface without moving its albedo. */
  rsAlb *= mix( 1.0, 0.80 + 0.42 * rsBedH, rsBedAmp );
  rsAlb *= mix( vec3( 1.0 ), uScDirt, rsBedSeam * 0.85 );

  /* cracks and cavities take dirt; both darken and desaturate toward the dust */
  rsAlb *= mix( vec3( 1.0 ), uScDirt, rsCrack * 0.85 );
  rsAlb *= mix( vec3( 1.0 ), uScDirt, rsCav * uScWeather.x );

  /* CHIPPING on the convex arrises: fresh, pale, dust-free stone */
  rsAlb *= mix( 1.0, 1.26, rsCvx * ( 0.45 + 0.55 * rsFine ) );

  /* sun-bleached up-facing planes, broken by the macro field so the transition
     is a weathering pattern rather than a smooth vertical gradient */
  float rsUp = clamp( vScWNrm.y, 0.0, 1.0 );
  /* Bleaching is a NEAR-FIELD read. Applied at full strength out to a
     kilometre it turns a scattered boulder field into pale confetti against the
     plain, which is the opposite of what aerial perspective should be doing to
     it. */
  float rsBl = pow( rsUp, 2.0 ) * uScWeather.z * ( 1.0 - rsCav * 0.75 )
             * ( 0.35 + 1.05 * rsMac ) * ( 0.40 + 0.60 * rsNear );
  float rsLum = dot( rsAlb, vec3( 0.2126, 0.7152, 0.0722 ) );
  rsAlb = mix( rsAlb, mix( rsAlb, vec3( rsLum ) * vec3( 1.14, 1.04, 0.83 ), 0.62 ), rsBl );

  /* lichen: colonises up-facing, exposed, macro-high patches. Desaturated
     sage-grey, never a green sticker. */
  float rsLic = smoothstep( 0.62, 0.86, rsMac ) * pow( rsUp, 0.75 )
              * ( 1.0 - rsCav * 0.6 ) * uScSurf.y * rsNear;
  rsAlb = mix( rsAlb, uScLichen * ( 0.70 + 0.8 * rsFine ), rsLic );

  rsAlb *= vScTint;
  rsAlb *= mix( 1.0, 0.60, uScWeather.w );   // wet surfaces darken
  diffuseColor.rgb *= rsAlb;
}
`;

const MAP_STANDARD = /* glsl */`
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  diffuseColor *= sampledDiffuseColor;
#endif
{
  float rsCav = clamp( vScCav, 0.0, 1.0 );
  diffuseColor.rgb *= mix( vec3( 1.0 ), uScDirt, rsCav * uScWeather.x );
  float rsUp = clamp( vScWNrm.y, 0.0, 1.0 );
  float rsBl = pow( rsUp, 2.5 ) * uScWeather.z * ( 1.0 - rsCav * 0.8 );
  float rsLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  diffuseColor.rgb = mix( diffuseColor.rgb,
    mix( diffuseColor.rgb, vec3( rsLum ) * vec3( 1.12, 1.03, 0.84 ), 0.6 ), rsBl );
  diffuseColor.rgb *= vScTint;
  diffuseColor.rgb *= mix( 1.0, 0.62, uScWeather.w );
}
`;

const ROUGH_TRIPLANAR = /* glsl */`
float roughnessFactor = roughness;
{
  float rsR = rsNRx.b * rsBw.x + rsNRy.b * rsBw.y + rsNRz.b * rsBw.z;
  roughnessFactor *= rsR;
  /* fine grain modulates gloss — a rock face is not uniformly matte, and the
     specular breakup is most of what sells "stone" under a low sun */
  roughnessFactor *= mix( 1.0, 0.82 + 0.36 * rsFineN.b, rsNear );
  roughnessFactor += rsCav * uScWeather.y + rsCrack * 0.18 + rsBedSeam * 0.14;
  /* a fresh break is smoother than a weathered face — this is what makes an
     arris catch the key light and read as an EDGE rather than as a paint line */
  roughnessFactor *= mix( 1.0, 0.82, rsCvx );
  roughnessFactor = clamp( roughnessFactor, 0.06, 1.0 );
  roughnessFactor = mix( roughnessFactor, 0.22, uScWeather.w * 0.75 );
}
`;

const ROUGH_PLAIN = /* glsl */`
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  roughnessFactor *= texture2D( roughnessMap, vRoughnessMapUv ).g;
#endif
roughnessFactor = clamp( roughnessFactor + clamp( vScCav, 0.0, 1.0 ) * uScWeather.y, 0.04, 1.0 );
roughnessFactor = mix( roughnessFactor, 0.24, uScWeather.w * 0.7 );
`;

const NORMAL_TRIPLANAR = /* glsl */`
{
  vec2 nxx = rsNRx.xy * 2.0 - 1.0;
  vec2 nyy = rsNRy.xy * 2.0 - 1.0;
  vec2 nzz = rsNRz.xy * 2.0 - 1.0;
  /* the centimetre octave, one tap, added to every plane. Its amplitude is
     distance-faded so the far field cannot shimmer on it. */
  vec2 rsFn = ( rsFineN.xy * 2.0 - 1.0 ) * uScSurf.w * rsNear;
  nxx += rsFn; nyy += rsFn; nzz += rsFn;
  /* Bedding relief: the parting is a real step in the surface, tilted about the
     horizontal, so a raking sun rakes ACROSS the beds. Applied to the two
     vertical projections only — a bed line on an up-facing plane is a contour,
     not a step. */
  float rsBn = rsBedSeam * 1.35;
  nxx.y -= rsBn; nzz.y -= rsBn;
  /* cracks cut a real crease, not just a dark line */
  float rsCg = rsCrack * 0.9;
  vec3 tnx = vec3( nxx, sqrt( max( 1.0 - dot( nxx, nxx ), 0.0 ) ) );
  vec3 tny = vec3( nyy, sqrt( max( 1.0 - dot( nyy, nyy ), 0.0 ) ) );
  vec3 tnz = vec3( nzz, sqrt( max( 1.0 - dot( nzz, nzz ), 0.0 ) ) );
  float rsNs = uScTri.z * ( 1.0 + rsCg );
  tnx.xy *= rsNs; tny.xy *= rsNs; tnz.xy *= rsNs;
  // whiteout blend — no tangents required
  tnx = vec3( tnx.xy + rsTN.zy, abs( tnx.z ) * rsTN.x );
  tny = vec3( tny.xy + rsTN.xz, abs( tny.z ) * rsTN.y );
  tnz = vec3( tnz.xy + rsTN.xy, abs( tnz.z ) * rsTN.z );
  vec3 rsWN = normalize( tnx.zyx * rsBw.x + tny.xzy * rsBw.y + tnz.xyz * rsBw.z );
  /* undo the per-instance frame rotation so the shading normal is world-true */
  rsWN = vec3( rsWN.x * vScRot.x + rsWN.z * vScRot.y, rsWN.y,
              -rsWN.x * vScRot.y + rsWN.z * vScRot.x );
  normal = normalize( ( viewMatrix * vec4( rsWN, 0.0 ) ).xyz );
}
`;

/**
 * Card foliage carries *artificial* hemispherical normals (they describe the
 * volume of the clump, not the plane of the card), so three's DOUBLE_SIDED
 * `normal *= faceDirection` flip is wrong for roughly half the cards and turns
 * them black. Rebuild the shading normal from the world-space varying instead.
 */
const NORMAL_CARD = /* glsl */`
normal = normalize( ( viewMatrix * vec4( normalize( vScWNrm ), 0.0 ) ).xyz );
`;

/**
 * Cavity + hemisphere occlusion on the indirect term only.
 *
 * Pass 2 crushed this to 0.30 in cavities, which cost it "shadowed sides of the
 * boulders crush to near-pure black (43,212 pixels with max channel <20)". Real
 * cavity occlusion of the sky is nowhere near that deep on a convex boulder,
 * and the skylight is the only thing holding the shadow side off zero.
 */
function aoFrag(triplanar) {
  return /* glsl */`
{
  float rsAoCav = clamp( vScCav, 0.0, 1.0 );
  float rsSky = 0.68 + 0.32 * ( vScWNrm.y * 0.5 + 0.5 );
  float rsAo = mix( 1.0, 0.58, rsAoCav ) * rsSky${triplanar ? ' * ( 1.0 - rsCrack * 0.30 )' : ''};
  reflectedLight.indirectDiffuse *= rsAo;
  reflectedLight.indirectSpecular *= rsAo;
}
`;
}

/**
 * @param {object} o
 * @param {{map:THREE.Texture, normalMap:THREE.Texture, roughnessMap:THREE.Texture}} [o.set]
 *        procTextures set used for the triplanar projection
 */
export function makeScatterMaterial(o) {
  const {
    name = 'scatter',
    set = null,
    packed = null,
    triplanar = true,
    worldScale = 0.8,
    sharpness = 7.0,
    normalStrength = 1.0,
    cavityDirt = 0.72,
    cavityRough = 0.16,
    bleach = 0.35,
    macro = 0.20,
    detailScale = 5.0,
    detailFade = [22, 70],
    detail = 0.30,
    crack = 0.0,
    crackWindow = [0.34, 0.70],
    lichen = 0.0,
    lichenTint = [0.62, 0.64, 0.54],
    meanLum = 0.18,
    mipBias = 0.020,
    detailNormal = 0.55,
    dirt = [0.34, 0.28, 0.22],
    colour = 0xffffff,
    roughness = 1.0,
    metalness = 0.0,
    cardMap = null,
    alphaTest = 0,
    side = THREE.FrontSide,
    wind = false,
    instanced = true,
    cardNormals = false,
    windAmp = 1.0,
    /* ---- pass-12 rock terms. All default to inert so the wood, bone, adobe
       and trail materials that share this factory are unchanged. */
    sizeExp = 0.0,      // texel density ∝ instanceSize^sizeExp
    strata = 0.0,       // world-Y bedding amount
    strataFreq = 0.55,  // beds per metre
    chip = 0.0,         // convex-arris chipping (needs negative aCav)
    uvWarp = 0.0,       // domain-warp amplitude on the triplanar projection
    hexRange = 0.0,     // metres within which the detail tap is hex-tiled
    hexGLSL = null,     // procTextures.hexTileGLSL
  } = o;

  const uniforms = {
    uScMap: { value: set ? set.map : null },
    uScNR: { value: packed || null },
    uScTri: { value: new THREE.Vector4(worldScale, sharpness, normalStrength, macro) },
    uScWeather: { value: new THREE.Vector4(cavityDirt, cavityRough, bleach, 0) },
    uScDetail: { value: new THREE.Vector4(detailScale, detailFade[0], detailFade[1], detail) },
    uScSurf: { value: new THREE.Vector4(crack, lichen, mipBias, detailNormal) },
    uScLevels: {
      value: new THREE.Vector4(1 / Math.max(meanLum, 0.01), crackWindow[0], crackWindow[1], 0),
    },
    uScDirt: { value: new THREE.Vector3(dirt[0], dirt[1], dirt[2]) },
    /* `lichenTint` is authored RELATIVE to the surface (1.0 == as bright as the
       map's own mean), because it is mixed into the raw texture value, which for
       a rock is around 0.14 linear. Authoring it as an absolute linear colour
       painted 0.6-bright green patches onto a 0.14-bright rock. */
    uScLichen: {
      value: new THREE.Vector3(lichenTint[0], lichenTint[1], lichenTint[2])
        .multiplyScalar(Math.max(meanLum, 0.01) * 1.7),
    },
    uScWind: { value: new THREE.Vector4(1, 0, 0, 0) },
    uScRock: { value: new THREE.Vector4(sizeExp, strata, strataFreq, chip) },
    uScRock2: { value: new THREE.Vector4(uvWarp, hexRange, 0, 0) },
  };
  const useHex = triplanar && hexRange > 0 && !!hexGLSL;

  const mat = new THREE.MeshStandardMaterial({
    color: colour,
    roughness,
    metalness,
    map: cardMap,
    alphaTest,
    side,
    transparent: false,
  });
  mat.name = 'scatter_' + name;
  // Alpha-tested cards (scrub, ferns, leaf litter) are overdraw-dominated and
  // cannot early-Z reject; give them the cheap cascade filter — see
  // CascadedShadowMaps.chunkCheap.
  if (alphaTest > 0) mat.userData.rsCheapShadow = true;
  mat.defines = mat.defines || {};
  if (triplanar) mat.defines.RS_SC_TRIPLANAR = 1;
  if (instanced) mat.defines.RS_SC_INSTANCED = 1;
  if (wind) mat.defines.RS_SC_WIND = 1;
  if (useHex) mat.defines.RS_SC_HEX = 1;
  mat.userData.scatterUniforms = uniforms;
  mat.userData.windAmp = windAmp;

  mat.onBeforeCompile = (shader) => {
    for (const k in uniforms) shader.uniforms[k] = uniforms[k];

    let v = shader.vertexShader;
    v = v.replace('#include <common>', '#include <common>\n' + declVert(triplanar, wind));
    v = v.replace('#include <defaultnormal_vertex>',
      '#include <defaultnormal_vertex>\n' + BODY_VERT_NORMAL);
    v = v.replace('#include <project_vertex>',
      '#include <project_vertex>\n' + bodyVertPos(triplanar) + (wind ? BODY_VERT_WIND : ''));
    shader.vertexShader = v;

    let f = shader.fragmentShader;
    f = f.replace('#include <common>',
      '#include <common>\n' + declFrag(triplanar, wind, useHex ? hexGLSL : null));
    f = f.replace('#include <clipping_planes_fragment>',
      '#include <clipping_planes_fragment>\n' + FADE_FRAG + (triplanar ? PRELUDE : ''));
    f = f.replace('#include <map_fragment>', triplanar ? MAP_TRIPLANAR : MAP_STANDARD);
    f = f.replace('#include <roughnessmap_fragment>',
      triplanar ? ROUGH_TRIPLANAR : ROUGH_PLAIN);
    if (triplanar) {
      f = f.replace('#include <normal_fragment_maps>', NORMAL_TRIPLANAR);
    } else if (cardNormals) {
      f = f.replace('#include <normal_fragment_maps>', NORMAL_CARD);
    }
    f = f.replace('#include <aomap_fragment>', aoFrag(triplanar));
    shader.fragmentShader = f;
  };

  mat.customProgramCacheKey = () => 'rsScatter|' + name + '|' + (triplanar ? 1 : 0)
    + (wind ? 'w' : '') + (instanced ? 'i' : '') + (cardNormals ? 'c' : '')
    + (useHex ? 'h' : '');

  return mat;
}

/** Push per-frame weather into every scatter material. */
export function updateScatterMaterial(mat, { wetness = 0, wind = null, time = 0 }) {
  const u = mat.userData.scatterUniforms;
  if (!u) return;
  u.uScWeather.value.w = wetness;
  if (wind) {
    u.uScWind.value.set(wind.x, wind.strength * (mat.userData.windAmp || 1), wind.z, time);
  } else {
    u.uScWind.value.w = time;
  }
}
