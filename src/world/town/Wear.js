import * as THREE from 'three';

/**
 * Wear — the per-pixel surface pass shared by every surface in the town.
 *
 * PASS-2 FORENSICS (town_street, "critical"): "The sheriff facade is blatantly,
 * measurably tiled. Autocorrelation peaks at lag 65 px with correlation 0.49 …
 * the identical cluster of dark brick blotches is stamped roughly nine times
 * across one wall." Plus: "the wall textures read as a repeating blob pattern at
 * hero scale", "no normal map, no mortar depth, no dirt streak under the window
 * sill, no sun bleaching on the up-facing parapet".
 *
 * So this file now does two jobs.
 *
 * 1. STOCHASTIC (HEX) TILING — `RS_HEXTILE`.
 *    The albedo AND the normal map are sampled three times per pixel at
 *    hash-jittered UVs, one per corner of the triangular lattice the pixel falls
 *    in, and blended by sharpened barycentric weights. The periodic repeat is
 *    destroyed outright: there is no lag at which the wall correlates with
 *    itself any more. Albedo and normal use the SAME offsets and weights, so the
 *    mortar shadow still lands on the mortar. Derivatives are taken from the
 *    un-jittered UV and passed through textureGrad, so the mip chain is correct
 *    and the jitter cannot cause a sampling break at a cell boundary.
 *
 * 2. WEATHERING, in world space, above what procTextures can carry:
 *    per-board value jitter quantised to the plank pitch · replaced/patched
 *    boards · nail lines with oxide staining bleeding down from every fixing ·
 *    sun bleaching on up- and sun-facing planes · rain and rust streaks under the
 *    eave · dirt splash from the ground with a noisy top edge · dust on
 *    horizontals · a low-frequency macro breakup at 9 m and 34 m so no two bays
 *    of the same wall share a value.
 *
 * Driven by the `aWear` attribute written by Builder:
 *   x metres above the object's ground line, y metres below its eave,
 *   z grime 0..1, w paint chalking 0..1.
 */

const VERT_HEAD = /* glsl */`
attribute vec4 aWear;
varying vec4 vTwWear;
varying vec3 vTwWorld;
varying vec3 vTwNrm;
`;

const VERT_BODY = /* glsl */`
{
  vec4 twWp = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    twWp = instanceMatrix * twWp;
  #endif
  vTwWorld = ( modelMatrix * twWp ).xyz;
  vTwNrm = normalize( mat3( modelMatrix ) * objectNormal );
  vTwWear = aWear;
}
`;

const FRAG_HEAD = /* glsl */`
varying vec4 vTwWear;
varying vec3 vTwWorld;
varying vec3 vTwNrm;
uniform vec2 uTwSunAz;      // horizontal bearing of the prevailing afternoon sun

float twHash( vec2 p ) {
  p = fract( p * vec2( 0.1031, 0.1030 ) );
  p += dot( p, p.yx + 33.33 );
  return fract( ( p.x + p.y ) * p.x );
}
float twNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( twHash( i ), twHash( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( twHash( i + vec2( 0.0, 1.0 ) ), twHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
float twFbm( vec2 p ) {
  float a = 0.0, w = 0.5;
  for ( int i = 0; i < 4; i++ ) { a += w * twNoise( p ); p *= 2.07; w *= 0.5; }
  return a;
}

#ifdef RS_HEXTILE
/* ---- stochastic hex tiling ------------------------------------------------
 * Heitz & Neyret's triangle-lattice variant, cut down to what a wall needs.
 * rsHexSetup() is called once per pixel from the map chunk; every later
 * sampler (normal map) reuses the same lattice so the maps stay registered.  */
vec3 rsHexW;
vec2 rsHexO1, rsHexO2, rsHexO3, rsHexDx, rsHexDy;

vec2 rsHexHash( vec2 p ) {
  p = vec2( dot( p, vec2( 127.1, 311.7 ) ), dot( p, vec2( 269.5, 183.3 ) ) );
  return fract( sin( p ) * 43758.5453123 );
}

void rsHexSetup( vec2 uv ) {
  rsHexDx = dFdx( uv );
  rsHexDy = dFdy( uv );
  const mat2 SKEW = mat2( 1.0, 0.0, -0.57735027, 1.15470054 );
  vec2 sk = SKEW * ( uv * RS_HEX_SCALE );
  vec2 baseId = floor( sk );
  vec3 t = vec3( fract( sk ), 0.0 );
  t.z = 1.0 - t.x - t.y;
  vec2 v1, v2, v3;
  if ( t.z > 0.0 ) {
    rsHexW = vec3( t.z, t.y, t.x );
    v1 = baseId; v2 = baseId + vec2( 0.0, 1.0 ); v3 = baseId + vec2( 1.0, 0.0 );
  } else {
    rsHexW = vec3( -t.z, 1.0 - t.y, 1.0 - t.x );
    v1 = baseId + vec2( 1.0, 1.0 ); v2 = baseId + vec2( 1.0, 0.0 ); v3 = baseId + vec2( 0.0, 1.0 );
  }
  // Sharpen the barycentric weights. A linear blend of three taps averages the
  // contrast out and the wall goes to mush; ^4 keeps each cell nearly pure and
  // confines the cross-fade to a narrow band that reads as more variation.
  rsHexW = rsHexW * rsHexW;
  rsHexW = rsHexW * rsHexW;
  rsHexW /= max( 1e-5, rsHexW.x + rsHexW.y + rsHexW.z );
  rsHexO1 = rsHexHash( v1 ) * 4.7;
  rsHexO2 = rsHexHash( v2 ) * 4.7;
  rsHexO3 = rsHexHash( v3 ) * 4.7;
}

vec4 rsHexSample( sampler2D tex, vec2 uv ) {
  return texture2DGradEXT( tex, uv + rsHexO1, rsHexDx, rsHexDy ) * rsHexW.x
       + texture2DGradEXT( tex, uv + rsHexO2, rsHexDx, rsHexDy ) * rsHexW.y
       + texture2DGradEXT( tex, uv + rsHexO3, rsHexDx, rsHexDy ) * rsHexW.z;
}
#endif
`;

/* Replacement for <map_fragment>. Sets the lattice up even when a material has
 * no colour map, so the normal-map replacement below is always safe. */
const MAP_HEX = /* glsl */`
#ifdef RS_HEXTILE
  #if defined( USE_MAP )
    rsHexSetup( vMapUv );
    vec4 sampledDiffuseColor = rsHexSample( map, vMapUv );
    diffuseColor *= sampledDiffuseColor;
  #elif defined( USE_NORMALMAP )
    rsHexSetup( vNormalMapUv );
  #endif
#else
  #include <map_fragment>
#endif
`;

/* Replacement for <normal_fragment_maps>: identical to three's tangent-space
 * branch except that the normal map rides the hex lattice the albedo set up. */
const NORMAL_HEX = /* glsl */`
#if defined( RS_HEXTILE ) && defined( USE_NORMALMAP_TANGENTSPACE )
  vec3 mapN = rsHexSample( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  #if defined( USE_PACKED_NORMALMAP )
    mapN = vec3( mapN.xy, sqrt( saturate( 1.0 - dot( mapN.xy, mapN.xy ) ) ) );
  #endif
  mapN.xy *= normalScale;
  normal = normalize( tbn * mapN );
#else
  #include <normal_fragment_maps>
#endif
`;

const FRAG_BODY = /* glsl */`
{
  vec3 twP = vTwWorld;
  vec3 twN = normalize( vTwNrm );
  float twUp = clamp( twN.y, 0.0, 1.0 );
  float twVert = 1.0 - twUp;
  /* Bleaching follows the PREVAILING afternoon sun bearing, not the current
   * one: paint chalks over years, so the pale side of a building must not
   * change as the day runs. uTwSunAz is set once, from the same 16:30 azimuth
   * Layout used to choose the street bearing. */
  float twSouth = clamp( twN.x * uTwSunAz.x + twN.z * uTwSunAz.y, 0.0, 1.0 );
  float grime = vTwWear.z;
  float chalk = vTwWear.w;
  float lat = twP.x * 0.62 + twP.z * 0.62;           // a lateral coordinate that
                                                     // does not swim on rotation

  /* 0 — macro breakup at 34 m and 9 m ------------------------------------- *
   * The single loudest "one material stretched over a town" tell is that every
   * bay of every wall sits at the same value. Two low-frequency octaves in
   * WORLD space (so they cross building boundaries and never line up with a
   * UV seam) push each bay ±9 % in value and a little in hue.                */
  float macro = twFbm( twP.xz * 0.029 + twP.y * 0.011 ) * 0.62
              + twFbm( twP.xz * 0.115 + 7.3 ) * 0.38;
  diffuseColor.rgb *= 0.90 + 0.21 * macro;
  diffuseColor.rgb *= vec3( 1.0 + ( macro - 0.5 ) * 0.10, 1.0, 1.0 - ( macro - 0.5 ) * 0.08 );

  /* 1 — per-board value jitter, quantised to a 190 mm plank pitch ---------- */
  float boardId = floor( twP.y * 5.26 ) + floor( lat * 1.9 ) * 17.0;
  float board = twHash( vec2( boardId * 0.137, boardId * 0.071 + 3.1 ) );
  diffuseColor.rgb *= mix( 1.0, 0.80 + 0.42 * board, twVert * 0.85 + 0.15 );

#ifdef RS_TIMBER
  /* 1b — replaced boards. Roughly one plank in twelve has been swapped for a
   * newer, paler, less weathered one, or is a patch of bare split timber. A
   * wall where every board has aged identically is a texture, not a building. */
  float twPatch = twHash( vec2( boardId * 0.311 + 11.7, boardId * 0.053 ) );
  float fresh = smoothstep( 0.90, 0.985, twPatch ) * twVert;
  diffuseColor.rgb = mix( diffuseColor.rgb,
    diffuseColor.rgb * vec3( 1.44, 1.34, 1.14 ), fresh * 0.75 );
  float old = smoothstep( 0.10, 0.015, twPatch ) * twVert;
  diffuseColor.rgb = mix( diffuseColor.rgb,
    diffuseColor.rgb * vec3( 0.62, 0.60, 0.58 ), old * 0.6 );
  roughnessFactor = mix( roughnessFactor, 0.99, old * 0.5 );

  /* 1c — NAIL LINES. Two square-cut nails per board end, on a 610 mm stud
   * pitch, each bleeding a short oxide stain down the board below it. This is
   * the detail that reads at two metres and tells you the wall is nailed
   * timber rather than a printed pattern.                                    */
  float studU = lat / 0.61;
  float nailU = abs( fract( studU ) - 0.5 );
  float boardV = twP.y * 5.26;
  float nailV = abs( fract( boardV - 0.28 ) - 0.5 );
  float nailD = length( vec2( nailU * 0.61, nailV * 0.19 ) );
  float nailJit = twHash( vec2( floor( studU ) * 3.7, floor( boardV ) * 1.9 ) );
  float nail = smoothstep( 0.022, 0.004, nailD ) * twVert * step( 0.12, nailJit );
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.34, 0.30, 0.28 ), nail * 0.85 );
  roughnessFactor = mix( roughnessFactor, 0.72, nail * 0.6 );
  // rust bleed: a narrow plume under each nail, only where the wall is grimy
  float bleedY = ( 0.5 - ( fract( boardV - 0.28 ) - 0.5 ) ) * 0.19;
  float bleed = smoothstep( 0.030, 0.0, nailU * 0.61 )
              * smoothstep( 0.115, 0.006, max( bleedY, 0.0 ) )
              * step( 0.5, fract( boardV - 0.28 ) )
              * twVert * grime * step( 0.12, nailJit );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.19, 0.088, 0.038 ), bleed * 0.38 );
#endif

  /* 2 — sun bleaching on up- and south-facing planes ----------------------- */
  float bleachMask = twUp * 0.85 + twSouth * 0.55;
  bleachMask *= 0.45 + 0.55 * twFbm( twP.xz * 0.22 + twP.y * 0.08 );
  float twLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  vec3 bleached = mix( diffuseColor.rgb, vec3( twLum ), 0.42 ) * vec3( 1.30, 1.24, 1.10 );
  diffuseColor.rgb = mix( diffuseColor.rgb, bleached, clamp( bleachMask, 0.0, 1.0 ) * ( 0.20 + 0.28 * chalk ) );

  /* 3 — rain and rust streaks, strongest just under the eave --------------- */
  float streakN = twFbm( vec2( lat * 3.1, twP.y * 0.11 ) );
  float underEave = 1.0 - smoothstep( 0.0, 3.4, max( vTwWear.y, 0.0 ) );
  float streak = smoothstep( 0.56, 0.88, streakN ) * twVert * ( 0.35 + 0.65 * underEave ) * grime;
  diffuseColor.rgb *= 1.0 - streak * 0.30;
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.45, 0.78, 0.44 ), streak * 0.40 );

  /* 4 — dirt splash from the ground up to knee height ---------------------- */
  float splashN = twFbm( vec2( lat * 2.6, twP.y * 1.7 ) );
  float splashH = 0.30 + 0.72 * splashN;
  float splash = smoothstep( splashH, 0.015, max( vTwWear.x, 0.0 ) ) * twVert * grime;
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.083, 0.062, 0.041 ), splash * 0.66 );
  roughnessFactor = mix( roughnessFactor, 0.98, splash * 0.75 );

  /* 5 — dust settles on everything that faces the sky ---------------------- */
  float dust = twUp * ( 0.30 + 0.40 * twFbm( twP.xz * 0.9 ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.18, 1.10, 0.94 ), dust * 0.35 );
  roughnessFactor = mix( roughnessFactor, 0.96, dust * 0.55 );
  metalnessFactor *= 1.0 - splash * 0.7 - dust * 0.35;
}
`;

/**
 * Patch a MeshStandardMaterial with the weathering chunk.
 * Chains onto any existing onBeforeCompile; idempotent.
 *
 * @param {THREE.Material} material
 * @param {{hex?:number, timber?:boolean}} [opts]
 *        hex    — hex-tile cell size in UV tiles (0 disables). ~2.5 is right
 *                 for a 1.3 m wall tile, i.e. a 3 m cell.
 *        timber — enable nail lines / replaced boards.
 */
export function injectWear(material, opts = {}) {
  if (!material || material.userData.rsTownWear) return material;
  material.userData.rsTownWear = true;

  if (opts.hex) {
    material.defines = material.defines || {};
    material.defines.RS_HEXTILE = 1;
    material.defines.RS_HEX_SCALE = (1 / opts.hex).toFixed(5);
  }
  if (opts.timber) {
    material.defines = material.defines || {};
    material.defines.RS_TIMBER = 1;
  }

  if (!material.userData.rsSunAz) {
    material.userData.rsSunAz = { value: new THREE.Vector2(0, 1) };
  }

  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (typeof prev === 'function') prev.call(this, shader, renderer);
    shader.uniforms.uTwSunAz = material.userData.rsSunAz;
    if (shader.vertexShader.indexOf('vTwWear') === -1) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
        .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_BODY);
    }
    if (shader.fragmentShader.indexOf('vTwWear') === -1) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
        .replace('#include <map_fragment>', MAP_HEX)
        .replace('#include <metalnessmap_fragment>',
          '#include <metalnessmap_fragment>\n' + FRAG_BODY);
      // the normal map has to ride the SAME lattice as the albedo or the
      // mortar shadow separates from the mortar
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <normal_fragment_maps>', NORMAL_HEX);
    }
  };

  const key = material.customProgramCacheKey;
  material.customProgramCacheKey = function () {
    return 'rsTownWear|' + (material.defines && material.defines.RS_HEXTILE ? 'h' + material.defines.RS_HEX_SCALE : '')
      + (material.defines && material.defines.RS_TIMBER ? 't' : '')
      + '|' + (typeof key === 'function' ? key.call(this) : '');
  };
  material.needsUpdate = true;
  return material;
}

/**
 * Build the town's material set from the procTextures library.
 * Every material is vertex-coloured, weathered and (by the caller) fed to
 * Sky.injectAerialPerspective.
 */
export function makeTownMaterials(proc, aniso = 8) {
  const cache = new Map();

  const set = (name) => {
    if (!proc || typeof proc.get !== 'function') return null;
    try { return proc.get(name); } catch (e) { return null; }
  };

  const mk = (key, texName, over = {}) => {
    if (cache.has(key)) return cache.get(key);
    const s = set(texName);
    const params = {
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      dithering: true,
      ...over,
    };
    if (s) {
      params.map = s.map;
      params.normalMap = s.normalMap;
      params.roughnessMap = s.roughnessMap;
      params.aoMap = s.aoMap;
      if (over.metalness === undefined) params.metalness = s.metalness || 0;
      if (params.normalScale === undefined) {
        params.normalScale = new THREE.Vector2(over.nrm || 1, over.nrm || 1);
      }
    } else {
      params.color = over.color || 0x8a7a62;
    }
    delete params.nrm;
    const m = new THREE.MeshStandardMaterial(params);
    m.name = 'town_' + key;
    if (s && s.map) {
      for (const t of [s.map, s.normalMap, s.roughnessMap, s.aoMap]) {
        if (t && t.anisotropy < aniso) { t.anisotropy = aniso; t.needsUpdate = true; }
      }
    }
    cache.set(key, m);
    return m;
  };

  return { mk, cache };
}
