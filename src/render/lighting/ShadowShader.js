import * as THREE from 'three';

/**
 * RED SANDS — cascaded shadow map shader integration.
 *
 * HOW OTHER SYSTEMS OPT IN
 * ------------------------
 * You do not normally have to do anything. `Lighting` scans the scene graph and
 * patches every lit built-in material (Standard / Physical / Lambert / Phong /
 * Toon) it finds, including the materials of `InstancedMesh` / `BatchedMesh` /
 * `SkinnedMesh`, so vegetation and props are covered automatically.
 *
 * If you build a material before it is in the scene, or you want it patched on
 * the exact frame you create it:
 *
 *     ctx.get('lighting').registerMaterial( myMaterial );      // one or an array
 *     ctx.get('lighting').registerMaterialUser( (mat) => {} );  // notified for each
 *
 * If you write a fully custom `ShaderMaterial` that still uses three's lighting
 * chunks, add the declarations yourself:
 *
 *     const L = ctx.get('lighting');
 *     material.defines = { ...material.defines, ...L.shadowDefines() };
 *     material.fragmentShader = L.shadowChunk() + material.fragmentShader;
 *     Object.assign( material.uniforms, L.shadowUniforms() );
 *
 * ...and the sun shadow is then applied inside `<lights_fragment_begin>`.
 *
 * VERTEX-ANIMATED CASTERS (grass, foliage, cloth)
 * ----------------------------------------------
 * The shadow pass renders each caster with a `MeshDepthMaterial` derived from
 * its surface material (alphaTest / alphaMap / side are copied). If your vertex
 * shader displaces geometry, set the standard three hook so the silhouette in
 * the shadow map matches what is on screen:
 *
 *     mesh.customDepthMaterial = myDepthMaterialWithTheSameVertexShader;
 *
 * SHADOW CASTERS
 * --------------
 * Anything with `castShadow = true` is picked up automatically, or call
 * `ctx.get('lighting').requestShadowCaster( object3d )`.
 * `Lighting` reserves `Object3D.layers` bit 7 for the shadow pass — do not use
 * that layer for anything else.
 *
 * FILTERING
 * ---------
 * The lookup is PCSS: a Vogel-disk blocker search estimates the average
 * occluder depth, the caster/receiver separation is converted into a penumbra
 * width using the *real angular diameter of the source* (the sun subtends
 * 0.53 degrees, tan of the half angle is 4.6e-3 per metre of separation), and a
 * second Vogel disk of that radius does the filtering. Contact points therefore
 * stay razor sharp while the tip of a 300 m golden-hour shadow is metres wide.
 */

/** Object3D layer reserved for the shadow-caster render pass. */
export const SHADOW_LAYER = 7;

let _chunkPatched = false;

/**
 * Patch three's shared lighting chunk exactly once so every lit material can
 * opt into the cascade lookup with `#define RS_CSM`. Materials that do not
 * define RS_CSM are byte-for-byte unaffected.
 *
 * TWO injection points, not one:
 *
 *  1. `lights_fragment_begin` — the key light's radiance is multiplied by the
 *     cascade term. That is the classic cast shadow.
 *  2. `lights_fragment_end` — the AMBIENT irradiance is multiplied by a tinted
 *     function of the same term before RE_IndirectDiffuse consumes it.
 *
 * (2) is not a luxury, it is the reason pass-2 shadows did nothing. Measured on
 * `golden_hour_vista`: with the sun 3.28 degrees up, the direct term delivers
 * 0.075 of linear irradiance to flat ground against 0.156 from the sky lobe, so
 * a *perfect* cast shadow removes 33% of the light and the frame still reads as
 * "no shadows". Physically, a point the sun cannot see is usually a point that
 * also cannot see much of the sky (it is behind a trunk, a wall, a boulder), and
 * what it does see is the blue half of the dome, never the ochre bounce off the
 * ground it is standing on. Tinting the ambient by the shadow term therefore
 * darkens AND cools shadows at the same time, which is exactly what
 * §5 asks for and what the `town_street` critique measured as missing
 * (street shadow B-R was -0.146, i.e. WARMER than the lit ground).
 */
export function patchLightsChunk() {
  if (_chunkPatched) return true;
  const src = THREE.ShaderChunk.lights_fragment_begin;
  const token = 'getDirectionalLightInfo( directionalLight, directLight );';
  if (!src || src.indexOf(token) === -1) return false;
  THREE.ShaderChunk.lights_fragment_begin = src.replace(
    token,
    token +
      '\n\t\t#ifdef RS_CSM\n' +
      '\t\tdirectLight.color *= rsCsmDirectionalShadow( directLight.direction, geometryPosition, nonPerturbedNormal );\n' +
      '\t\t#endif\n',
  );

  // Ambient half. `irradiance` only exists when the material has an indirect
  // diffuse term, hence the double guard.
  const endSrc = THREE.ShaderChunk.lights_fragment_end;
  if (endSrc) {
    THREE.ShaderChunk.lights_fragment_end =
      '#if defined( RS_CSM ) && defined( RE_IndirectDiffuse )\n' +
      '\tirradiance *= rsCsmAmbientTerm();\n' +
      '#endif\n' + endSrc;
  }

  _chunkPatched = true;
  return true;
}

let _falloffPatched = false;

/**
 * Give every punctual light a physical *source radius*.
 *
 * three clamps the inverse-square falloff at `max(pow(d,decay), 0.01)`, i.e. it
 * models a mathematical point, so a campfire's own logs sit at an irradiance of
 * 100x the light's intensity and blow all three channels to white — which is
 * exactly the "colourless white blob" the pass-1 critique measured. A real
 * flame is a ~0.6 m emitter, so the correct near-field limit is `1/R^2`, not
 * `1/0.01`. Clamping the *distance* (not the falloff) keeps the far field
 * exactly inverse-square and only touches the few centimetres inside the
 * source, where the maths was fictional anyway.
 */
export function patchLightFalloff(sourceRadius = 0.62) {
  if (_falloffPatched) return true;
  const src = THREE.ShaderChunk.lights_pars_begin;
  const token = 'float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );';
  if (!src || src.indexOf(token) === -1) return false;
  const r2 = (sourceRadius * sourceRadius).toFixed(5);
  THREE.ShaderChunk.lights_pars_begin = src.replace(
    token,
    'float rsD = max( lightDistance, ' + sourceRadius.toFixed(4) + ' );\n' +
      '\tfloat distanceFalloff = 1.0 / max( pow( rsD, decayExponent ), ' + r2 + ' );',
  );
  _falloffPatched = true;
  return true;
}

/**
 * Build the GLSL declarations + cascade sampler. Prepended to the fragment
 * shader of every participating material.
 */
export function csmShaderChunk({ cascades, blockerTaps, pcfTaps, nearTaps, soft }) {
  return /* glsl */ `
#define RS_CSM_COUNT ${cascades}
#define RS_CSM_BLOCKER ${blockerTaps}
#define RS_CSM_PCF ${pcfTaps}
#define RS_CSM_NEAR ${nearTaps}
${soft ? '#define RS_CSM_SOFT 1' : ''}

/*
 * ONE sampler, not two.
 *
 * The obvious build of this uses a hardware sampler2DShadow for the filter taps
 * (free bilinear PCF) plus an RGBA-packed copy for the PCSS blocker search. On
 * this target that is a bad trade: the terrain material already asks for 17
 * texture units on a GPU that has 16, and the unit that gets dropped is
 * whichever one three binds last — which is a shadow term that silently
 * evaluates to garbage. A manually-compared packed atlas costs one unit, and
 * with a 24-tap Vogel disk the hardware's 2x2 bilinear is worth nothing anyway.
 */
uniform highp sampler2D rsCsmPackedMap;         // RGBA-packed cascade depth atlas
uniform mat4 rsCsmMat[ RS_CSM_COUNT ];          // view space -> cascade clip space
uniform vec4 rsCsmTile[ RS_CSM_COUNT ];         // atlas offset.xy, atlas scale.zw
uniform vec4 rsCsmRange[ RS_CSM_COUNT ];        // ortho depth range (m), texel X (m), texel Y (m), split far
uniform vec4 rsCsmSplits;                       // cascade far distances (view metres)
uniform vec4 rsCsmParams;                       // distance, tanSourceRadius, invTileRes, strength
uniform vec4 rsCsmBias;                         // normalOffsetTexels, constBias(m), searchTexels, maxPenumbraTexels
uniform vec3 rsCsmKeyDir;                       // view-space direction toward the key light
uniform vec4 rsCsmAmbient;                      // rgb = shadowed-ambient tint, a = contact strength
uniform float rsCsmDebug;                       // 0 off | 1 cascade false colour | 2 shadow only

/*
 * Set by rsCsmDirectionalShadow on the KEY light's iteration of the unrolled
 * directional-light loop, consumed afterwards by rsCsmAmbientTerm() in
 * <lights_fragment_end>. Initialised to "fully lit" so that any material or
 * light configuration that never reaches the key light is byte-identical to the
 * unpatched path.
 */
float rsCsmKeyVis = 1.0;

vec3 rsCsmAmbientTerm() {
	return mix( rsCsmAmbient.rgb, vec3( 1.0 ), rsCsmKeyVis );
}

float rsCsmUnpack( const in vec4 v ) {
	return dot( v, vec4( 0.99609375, 0.00389099, 0.0000151992, 0.0000000596046 ) );
}

// Interleaved gradient noise — cheap, well distributed, stable per pixel.
float rsCsmDither( const in vec2 p ) {
	return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}

// Vogel (golden angle) disk: uniform density, rotation by phi decorrelates pixels.
vec2 rsCsmVogel( const in int i, const in float n, const in float phi ) {
	float r = sqrt( ( float( i ) + 0.5 ) / n );
	float a = float( i ) * 2.39996323 + phi;
	return r * vec2( cos( a ), sin( a ) );
}

vec2 rsCsmAtlasUv( const in vec4 tile, const in vec2 local ) {
	float inset = rsCsmParams.z * 1.5;
	return tile.xy + clamp( local, inset, 1.0 - inset ) * tile.zw;
}

float rsCsmDepthAt( const in vec4 tile, const in vec2 local ) {
	return rsCsmUnpack( texture( rsCsmPackedMap, rsCsmAtlasUv( tile, local ) ) );
}

/** Single point sample. Binary, so only useful when many of them are spread. */
float rsCsmTap( const in vec4 tile, const in vec2 local, const in float ref ) {
	return step( ref, rsCsmDepthAt( tile, local ) );
}

/**
 * Compare-then-filter bilinear tap: four texels, compared individually and then
 * blended by the sub-texel position. This is what a hardware sampler2DShadow
 * does, and it is the reason a contact shadow one texel wide comes out as a
 * smooth edge instead of a staircase. Four fetches, so it is only used where it
 * pays — see the penumbra branch below.
 */
float rsCsmTapBilinear( const in vec4 tile, const in vec2 local, const in float ref ) {
	float ts = rsCsmParams.z;              // 1 / tile resolution
	vec2 p = local / ts - 0.5;
	vec2 f = fract( p );
	vec2 b = ( floor( p ) + 0.5 ) * ts;
	vec4 d = vec4(
		rsCsmDepthAt( tile, b ),
		rsCsmDepthAt( tile, b + vec2( ts, 0.0 ) ),
		rsCsmDepthAt( tile, b + vec2( 0.0, ts ) ),
		rsCsmDepthAt( tile, b + vec2( ts, ts ) )
	);
	vec4 s = step( vec4( ref ), d );
	return mix( mix( s.x, s.y, f.x ), mix( s.z, s.w, f.x ), f.y );
}

float rsCsmCascadeShadow( const in int c, const in vec3 viewPos, const in vec3 n,
                          const in float ndl, const in float phi,
                          const in vec3 dpx, const in vec3 dpy ) {

	vec4 tile = rsCsmTile[ c ];
	vec4 rng = rsCsmRange[ c ];
	/*
	 * The cascade is ANISOTROPIC in light space (see CascadedShadowMaps._fit):
	 * at a 3-degree sun the receiver slab is a thin horizontal band and fitting
	 * a square to the frustum sphere left 91% of every atlas tile empty — the
	 * measured pass-2 fill was 9.0%. Tightening the light-space Y half-extent
	 * makes the Y texel several times smaller than the X texel, so every world
	 * <-> texel conversion below has to be done per axis.
	 */
	float txW = rng.y;                                     // metres per texel, X
	float tyW = rng.z;                                     // metres per texel, Y
	float texelWorld = max( txW, tyW );
	// uv travelled per world metre, per axis.
	vec2 uvPerM = vec2( rsCsmParams.z / txW, rsCsmParams.z / tyW );

	/*
	 * Normal-offset bias.
	 *
	 * Pass 2 scaled this by (0.60 + 0.80*sin(theta)), i.e. it grew toward
	 * grazing incidence. That is the standard recipe and it is wrong here: at a
	 * 3-degree sun the ground sits at sin(theta) ~ 1, so with a 0.176 m texel the
	 * lookup was displaced 0.28 m along the surface NORMAL, which is
	 * 0.28 / tan(3.3 deg) = 4.9 METRES along the shadow direction. Every shadow
	 * in the frame detached from its caster by five metres and small props
	 * (wagon, poles, barrels) lost theirs entirely. The receiver-plane depth bias
	 * below already does all the grazing-angle work exactly, so the normal offset
	 * only has to cover the texel footprint, and it stays constant.
	 */
	vec3 p = viewPos + n * ( texelWorld * rsCsmBias.x );

	vec3 co = ( rsCsmMat[ c ] * vec4( p, 1.0 ) ).xyz * 0.5 + 0.5;
	if ( co.z <= 0.0 || co.z >= 1.0 ) return 1.0;
	if ( any( lessThan( co.xy, vec2( 0.0 ) ) ) || any( greaterThan( co.xy, vec2( 1.0 ) ) ) ) return 1.0;

	/*
	 * RECEIVER-PLANE DEPTH BIAS.
	 *
	 * This is the whole ball game at golden hour and it is what pass 1 was
	 * missing. When the sun sits 3.4 degrees up, the ground is very nearly
	 * PARALLEL to the light, so a single shadow texel spans
	 *     texelWorld / tan(elevation) = 0.17 / 0.059 = 2.9 metres
	 * of depth. No constant bias survives that: a 0.18 m bias against a 2.9 m
	 * quantisation step means every open plain self-shadows completely, which
	 * is exactly the uniform, featureless, luma-0.055 foreground measured on
	 * the beauty frame. Cranking the constant instead would peter-pan every
	 * contact shadow in the game.
	 *
	 * The fix is to follow the receiver's own plane. dpx/dpy are the screen
	 * derivatives of the view position (computed once, in uniform control flow,
	 * by the caller). Because the cascade cameras are ORTHOGRAPHIC, the map to
	 * cascade space is affine, so the derivatives of co are exact rather than
	 * estimated, and dz/du, dz/dv follow from a 2x2 solve. Each filter tap then
	 * compares against the depth the receiving surface would actually have at
	 * that offset, so the bias is zero where it should be zero and 3 metres
	 * where it needs to be 3 metres.
	 */
	float range = rng.x;                                   // ortho depth span, metres
	float texUv = rsCsmParams.z;

	vec3 cdx = ( rsCsmMat[ c ] * vec4( dpx, 0.0 ) ).xyz * 0.5;
	vec3 cdy = ( rsCsmMat[ c ] * vec4( dpy, 0.0 ) ).xyz * 0.5;
	float det = cdx.x * cdy.y - cdy.x * cdx.y;
	vec2 rpdb = vec2( 0.0 );
	if ( abs( det ) > 1e-14 ) {
		float inv = 1.0 / det;
		rpdb.x = (  cdy.y * cdx.z - cdx.y * cdy.z ) * inv;
		rpdb.y = ( -cdy.x * cdx.z + cdx.x * cdy.z ) * inv;
	}
	/*
	 * Clamp the plane slope. Across a silhouette edge the two derivatives come
	 * from different surfaces and the solve returns nonsense; unclamped, that
	 * nonsense becomes an enormous bias and punches a hole through the middle of
	 * a shadow. The ceiling is the slope of a receiver ~88.6 degrees off the
	 * light, which is past anything that still reads as a lit surface — golden
	 * hour's 86.6 degrees sits comfortably under it.
	 */
	float maxSlope = texelWorld * 40.0 / max( range * texUv, 1e-9 );
	float rl = length( rpdb );
	if ( rl > maxSlope ) rpdb *= maxSlope / rl;

	// One texel diagonal of the plane's own slope is the quantisation error that
	// remains after following the plane.
	float planeBias = ( abs( rpdb.x ) + abs( rpdb.y ) ) * texUv * 1.4;

	// Small constant floor on top, in metres, for depth quantisation.
	float biasM = rsCsmBias.y + texelWorld * 0.25;
	float ref = co.z - biasM / range - planeBias;

	#ifdef RS_CSM_SOFT

		// ---- blocker search (PCSS) -------------------------------------------
		// Search radius is the widest penumbra this cascade can produce, so a
		// distant occluder is still found. Authored in X-texels, converted to a
		// WORLD radius and then back to uv per axis so the disk stays circular in
		// world space on an anisotropic cascade.
		float searchW = rsCsmBias.z * txW;
		vec2 searchUv = searchW * uvPerM;
		float sum = 0.0;
		float cnt = 0.0;
		for ( int i = 0; i < RS_CSM_BLOCKER; i ++ ) {
			vec2 o = rsCsmVogel( i, float( RS_CSM_BLOCKER ), phi ) * searchUv;
			// The blocker test has to walk the receiver plane too, or at a low sun
			// the receiver finds ITSELF two metres "in front" and every open plain
			// reports a blocker.
			float r = ref + dot( rpdb, o );
			float d = rsCsmDepthAt( tile, co.xy + o );
			if ( d < r ) { sum += d - dot( rpdb, o ); cnt += 1.0; }
		}
		if ( cnt < 0.5 ) return 1.0;                        // fully lit — early out

		// ---- penumbra estimate ------------------------------------------------
		// w_penumbra = separation * tan( source angular radius ). For the sun that
		// is tan( 0.265 deg ) = 4.63e-3 per metre of caster/receiver separation,
		// so a contact point is one texel wide and the tip of a 300 m shadow is
		// 1.4 m wide. This is the whole point of PCSS over fixed-radius PCF.
		float sep = max( ( co.z - sum / cnt ) * range, 0.0 );
		float penW = clamp( sep * rsCsmParams.y, 0.55 * txW, rsCsmBias.w * txW );
		float penTexels = penW / txW;
		vec2 radius = penW * uvPerM;

		// ---- filter -----------------------------------------------------------
		// Two regimes, and the branch is screen-coherent because the penumbra
		// width varies smoothly:
		//   tight  — few taps, each bilinear, so a contact edge resolves below
		//            one texel instead of staircasing;
		//   wide   — many cheap point taps spread over the disk, where the taps
		//            are already further apart than a texel and the per-pixel
		//            Vogel rotation dithers what is left for TAA to resolve.
		float s = 0.0;
		if ( penTexels < 2.4 ) {
			for ( int i = 0; i < RS_CSM_NEAR; i ++ ) {
				vec2 o = rsCsmVogel( i, float( RS_CSM_NEAR ), phi + 2.399963 ) * radius;
				s += rsCsmTapBilinear( tile, co.xy + o, ref + dot( rpdb, o ) );
			}
			s = s / float( RS_CSM_NEAR );
		} else {
			for ( int i = 0; i < RS_CSM_PCF; i ++ ) {
				vec2 o = rsCsmVogel( i, float( RS_CSM_PCF ), phi + 2.399963 ) * radius;
				s += rsCsmTap( tile, co.xy + o, ref + dot( rpdb, o ) );
			}
			s = s / float( RS_CSM_PCF );
		}

		/*
		 * ---- CONTACT TERM -----------------------------------------------------
		 *
		 * PCSS averages its blockers, so where a thin occluder (a fence post, the
		 * lip of a stone, the last centimetre of a trunk before it meets the
		 * ground) covers only part of the search disk, the estimated penumbra is
		 * wide and the resulting filter smears the darkening away to nothing. That
		 * is the "objects sit on the ground with zero darkening at the
		 * intersection" tell, and it is why every reviewer read the props as
		 * pasted on.
		 *
		 * A true screen-space contact shadow needs a camera-depth prepass, which
		 * this forward renderer does not have and cannot afford. The cascade
		 * already stores the information though: sampling it at a HALF-TEXEL
		 * radius with no penumbra widening gives the un-blurred occlusion, and
		 * min()-ing that against the PCSS result restores the hard, tight core of
		 * the shadow while leaving the soft outer penumbra intact. Four extra
		 * fetches, and only in the two nearest cascades where a contact is
		 * actually resolvable on screen.
		 */
		if ( rsCsmAmbient.a > 0.001 && c < 2 && penTexels > 1.2 ) {
			vec2 tight = ( 0.62 * txW ) * uvPerM;
			float k = 0.0;
			for ( int i = 0; i < 4; i ++ ) {
				vec2 o = rsCsmVogel( i, 4.0, phi + 1.2 ) * tight;
				k += rsCsmTapBilinear( tile, co.xy + o, ref + dot( rpdb, o ) );
			}
			s = mix( s, min( s, k * 0.25 ), rsCsmAmbient.a );
		}
		return s;

	#else

		vec2 radius = ( 1.0 * txW ) * uvPerM;
		float s = 0.0;
		for ( int i = 0; i < 4; i ++ ) {
			vec2 o = rsCsmVogel( i, 4.0, phi ) * radius;
			s += rsCsmTapBilinear( tile, co.xy + o, ref + dot( rpdb, o ) );
		}
		return s * 0.25;

	#endif
}

vec3 rsCsmDirectionalShadow( const in vec3 lightDirView, const in vec3 viewPos, const in vec3 n ) {

	// Screen derivatives of the receiver position, taken HERE in uniform control
	// flow before any early-out, because dFdx inside a branch is undefined. They
	// feed the receiver-plane depth bias.
	vec3 dpx = dFdx( viewPos );
	vec3 dpy = dFdy( viewPos );

	// Only the CSM-driven key light is shadowed; sky bounce fill is not.
	if ( dot( lightDirView, rsCsmKeyDir ) < 0.995 ) return vec3( 1.0 );

	float d = - viewPos.z;
	float far = rsCsmParams.x;
	if ( d >= far ) return vec3( 1.0 );

	float ndl = dot( n, rsCsmKeyDir );
	// Terminator guard. Right at N.L = 0 the normal-offset bias degenerates and
	// leaves speckle on smooth curved casters. Dissolve the shadow over a very
	// narrow band only: it must NOT eat into golden hour, where a 3-degree sun
	// puts the whole ground at N.L ~ 0.05 and the long shadows are the shot.
	float term = smoothstep( 0.0, 0.030, ndl );
	if ( term <= 0.002 ) return vec3( 1.0 );

	float phi = rsCsmDither( gl_FragCoord.xy ) * 6.2831853;

	int c = 0;
	for ( int i = 0; i < RS_CSM_COUNT - 1; i ++ ) {
		if ( d > rsCsmSplits[ i ] ) c = i + 1;
	}

	float sh = rsCsmCascadeShadow( c, viewPos, n, ndl, phi, dpx, dpy );

	// Cross-fade into the next cascade so the seam is invisible.
	float end = rsCsmSplits[ c ];
	float start = ( c == 0 ) ? 0.0 : rsCsmSplits[ max( c - 1, 0 ) ];
	float w = smoothstep( end - ( end - start ) * 0.16, end, d );
	if ( c < RS_CSM_COUNT - 1 && w > 0.002 ) {
		sh = mix( sh, rsCsmCascadeShadow( c + 1, viewPos, n, ndl, phi, dpx, dpy ), w );
	}

	float fade = 1.0 - smoothstep( far * 0.80, far * 0.985, d );
	float v = mix( 1.0, sh, fade * term * rsCsmParams.w );

	/*
	 * Hand the SAME term to the ambient path. Note it is sh weighted by the
	 * distance fade but NOT by the N.L terminator: a surface turning away from
	 * the sun is not "unshadowed", it simply has no direct term, and letting the
	 * terminator lift the ambient back up would put a bright halo around the base
	 * of every curved object.
	 */
	rsCsmKeyVis = mix( 1.0, sh, fade * rsCsmParams.w );

	if ( rsCsmDebug > 0.5 ) {
		// The caller multiplies this into directLight.color, which the BRDF then
		// multiplies by N.L. At a 3-degree sun N.L is 0.05 everywhere, so a raw
		// debug tint renders as black and tells you nothing. Divide it back out:
		// what reaches the screen is then the shadow term itself.
		float unlambert = 1.0 / max( ndl, 0.015 );
		if ( rsCsmDebug < 1.5 ) {
			// cascade index as false colour, modulated by the shadow term
			vec3 tint = c == 0 ? vec3( 1.0, 0.25, 0.25 )
			          : c == 1 ? vec3( 0.25, 1.0, 0.3 )
			          : c == 2 ? vec3( 0.3, 0.45, 1.0 )
			                   : vec3( 1.0, 0.9, 0.25 );
			return tint * ( 0.18 + 0.82 * v ) * unlambert * 6.0;
		}
		return vec3( v ) * unlambert * 6.0;   // shadow term only, N.L cancelled
	}

	return vec3( v );
}
`;
}

const LIT_MATERIAL = (m) =>
  !!m &&
  (m.isMeshStandardMaterial ||
    m.isMeshPhysicalMaterial ||
    m.isMeshLambertMaterial ||
    m.isMeshPhongMaterial ||
    m.isMeshToonMaterial) &&
  !m.isShaderMaterial &&
  !m.isRawShaderMaterial;

/**
 * Attach the cascade lookup to a single material. Chains onto any existing
 * onBeforeCompile / customProgramCacheKey so other systems keep working.
 */
export function patchMaterial(material, chunk, uniforms, cacheKey) {
  if (!LIT_MATERIAL(material)) return false;

  // The marker lives directly on the material, not in userData: `Material.copy`
  // JSON-clones userData (dropping function references while keeping booleans),
  // which would make a cloned material look half-patched.
  if (material.__rsCsmFn === material.onBeforeCompile) return false;

  // Always chain whatever is installed right now, so a system that patches the
  // same material after us keeps working (and we keep working after them).
  const prevCompile = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  const first = material.__rsCsmFn === undefined;
  if (first) material.__rsCsmKey = (prevKey ? prevKey.call(material) : '') + cacheKey;
  /*
   * Record whether somebody else is already displacing/discarding in this
   * material's shader. CascadedShadowMaps._autoCaster reads it: a material with
   * a foreign vertex hook cannot be rendered into the shadow map with a derived
   * MeshDepthMaterial, because the depth pass would draw the UNDISPLACED mesh.
   */
  if (prevCompile) material.__rsForeignHook = true;

  const fn = function (shader, renderer) {
    if (prevCompile) prevCompile.call(material, shader, renderer);
    for (const k in uniforms) shader.uniforms[k] = uniforms[k];
    // Idempotent: if any wrapper in the chain already injected us, do not do it
    // again. Re-wrapping is legitimate (another system may replace the hook),
    // duplicating the GLSL is not — it is an instant compile error.
    if (shader.fragmentShader.indexOf('vec3 rsCsmDirectionalShadow(') === -1) {
      shader.fragmentShader = chunk + shader.fragmentShader;
    }
  };
  material.onBeforeCompile = fn;
  if (first) {
    material.customProgramCacheKey = function () {
      return material.__rsCsmKey;
    };
  }

  material.defines = material.defines || {};
  material.defines.RS_CSM = 1;
  material.needsUpdate = true;
  material.__rsCsmFn = fn;
  return first;
}
